import * as THREE from "three";
import {
  buildPiece,
  initialConnector,
  roadParams,
  guardrailParams,
  pieceParams,
} from "./modularRoadKit.js";
import { isSharedGeometry } from "./modularRoadBatching.js";

/**
 * The kit's shipped numbers, snapshotted at import.
 *
 * Tiles are baked against THESE, not against the live `pieceParams`, because
 * the live object is mutable — a track load writes into it — so a tile's
 * PICTURE would be rendered from whatever it happened to hold at bake time
 * while the tile PLACES from its own frozen params. Two different moments, and
 * a tile that does not fully specify its shape could be pictured as one thing
 * and build as another. Same rule as PIECE_DEFAULTS in modularRoadBuilder.js.
 */
const THUMB_DEFAULTS = { ...pieceParams };

/**
 * Live thumbnail baker. Renders a small 3/4 view of each road piece / preset
 * with the REAL road materials, so palette tiles match what actually gets built
 * (replacing the hand-drawn SVG silhouettes). Produces ONE PNG sprite sheet plus
 * a key → cell index; no files to manage.
 *
 * ── WHERE THE TIME GOES (measured, 174 tiles at 192px, this laptop) ─────────
 * Drawing was never the problem. The original shape of this — one small render
 * target per tile, read back and encoded on the spot — cost 6.8 s, and every
 * bit of that was per-tile overhead:
 *
 *   readback   ~20 ms x 174   each call drains the pipeline and waits
 *   PNG encode ~57 ms x 174   per-CALL cost; a sheet with 182x the pixels: 84 ms
 *   drawing      1.1 s total  geometry + 174 render passes, all of it
 *
 * So both are batched. Tiles render into cells of one big target (one readback
 * per ~100 tiles) and land in one sprite sheet (one encode for the lot). The
 * result is the same picture per tile — verified against the per-tile bake at a
 * median block delta of 1/255 — for about a fifth of the time.
 *
 * The sheet is a Blob because it is persisted: modularRoadThumbnailCache keeps
 * it in IndexedDB as binary, and createThumbnailSprites() turns it into
 * something the palette can paint a tile with.
 *
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {{road:THREE.Material, rail?:THREE.Material, shell?:THREE.Material, decor?:THREE.Material, glass?:THREE.Material, tube?:THREE.Material}} o.materials
 * @param {{key:string, pieceId?:string, params?:object, make?:()=>THREE.Object3D}[]} o.items
 * @param {THREE.Texture} [o.environment] optional IBL (the main scene's PMREM) for correct lighting
 * @param {number} [o.size=128]
 * @param {number} [o.runLength=8] tiles drawn per borrow of the renderer
 * @returns {Promise<{size:number, sheets:{blob:Blob,cols:number,rows:number}[], cells:Map<string,{sheet:number,col:number,row:number}>}|null>}
 */
export async function bakeRoadThumbnails({
  renderer, materials, items, environment = null, size = 128, runLength = 8,
}) {
  if (!renderer || !materials?.road || !Array.isArray(items)) return null;

  // NO MSAA — SUPERSAMPLED INSTEAD, and that is not a quality compromise, it is
  // the difference between this being fast and being four times slower than the
  // per-tile bake it replaced. A WebGPU resolve covers the WHOLE attachment, so
  // multisampling the atlas means resolving 3840x3840 once per tile: measured
  // 17-24 s for 174 tiles, against 6.8 s for one small MSAA target each. Without
  // it a pass just loads and stores, which costs nothing on the way in.
  //
  // Cells are rendered at 2x and box-filtered down when sliced, which also
  // antialiases shading rather than only geometry edges — 4 samples either way.
  const SS = 2;
  const cell = size * SS;
  // Square pages under the 4096 that any WebGPU device allows (the spec floor
  // for maxTextureDimension2D is 8192). At 192px that is a 10x10 grid, so the
  // whole palette is two readbacks.
  const MAX_ATLAS = 4096;
  const cols = Math.max(1, Math.floor(MAX_ATLAS / cell));
  const perPage = cols * cols;
  const atlas = cols * cell;

  const rt = new THREE.RenderTarget(atlas, atlas, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

  const scene = new THREE.Scene();
  if (environment) scene.environment = environment;
  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x3a3a42, 2.4);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xfff2e0, 2.8);
  dir.position.set(5, 9, 6);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 5000);
  const group = new THREE.Group();
  scene.add(group);

  const box = new THREE.Box3();
  const sphere = new THREE.Sphere();
  const center = new THREE.Vector3();
  const camDir = new THREE.Vector3(0.78, 0.82, 0.95).normalize();
  const prevClear = new THREE.Color();

  const clearGroup = () => {
    while (group.children.length) {
      const c = group.children.pop();
      c.traverse?.((o) => {
        // NOT the shared templates. `item.make()` for scenery, the elevator and
        // the container hands back a `clone()` of a cached template, and in three
        // a clone SHARES its geometry by reference — so freeing it here destroys
        // the buffers every future placement of that type draws from. The
        // symptom is the nasty one: a mesh that still reports a healthy index
        // count, drawing a null GPUBuffer, every frame, long after the bake.
        // Only bites on a cold thumbnail cache, which is why it hid.
        if (o.isMesh && !isSharedGeometry(o.geometry)) o.geometry?.dispose?.();
      });
    }
  };

  /** Put one item's meshes in `group`. @returns {boolean} false if it made nothing */
  const buildItem = (item) => {
    if (item.make) {
      group.add(item.make());
    } else {
      const pp = { ...THUMB_DEFAULTS, ...(item.params || {}) };
      let built;
      try {
        built = buildPiece(
          item.pieceId,
          initialConnector(),
          pp,
          roadParams,
          guardrailParams,
          guardrailParams.enabled,
        );
      } catch {
        return false;
      }
      const addMesh = (geo, mat) => {
        if (!geo || !mat) return;
        group.add(new THREE.Mesh(geo, mat));
      };
      if (!built.def.noMesh) {
        const deck = built.def.tubeShader && materials.tube ? materials.tube : materials.road;
        addMesh(built.geometry, deck);
      }
      addMesh(built.railGeometry, materials.rail);
      addMesh(built.shellGeometry, materials.shell);
      addMesh(built.decorGeometry, materials.decor);
      addMesh(built.glassGeometry, materials.glass);
    }
    return group.children.length > 0;
  };

  /** Frame by bounding sphere so every piece (long straight, wide curve, tall
   *  loop) is centred and fully visible at a uniform 3/4 angle. */
  const frameItem = () => {
    box.setFromObject(group);
    box.getBoundingSphere(sphere);
    center.copy(sphere.center);
    const r = Math.max(sphere.radius, 0.5);
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.12;
    camera.position.copy(center).addScaledVector(camDir, dist);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
  };

  /**
   * Draw a run of items into their cells and hand the renderer straight back.
   *
   * NOTHING AWAITS IN HERE. The bake runs in the background with the editor's
   * own frame loop live, and the loop draws in the gaps between runs: leaving
   * the atlas bound — or autoClear off, or the scissor test on — across an await
   * means the editor's frames land in a 2048px offscreen buffer instead of on
   * screen. The renderer is borrowed for one synchronous run at a time.
   *
   * @param {number} first index of the first item, within the page
   * @param {object[]} placed appended to: {key, col, row} per tile that drew
   */
  const drawRun = (pageItems, first, last, placed) => {
    const prevTarget = renderer.getRenderTarget();
    renderer.getClearColor(prevClear);
    const prevAlpha = renderer.getClearAlpha();
    const prevAutoClear = renderer.autoClear;
    const prevScissorTest = renderer.getScissorTest();

    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0); // transparent thumbnails
    if (first === 0) {
      // One clear for the whole page. Every later render has to LOAD what is
      // already there (autoClear off) or it would wipe the tiles beside it —
      // a WebGPU clear is a load-op on the whole attachment and ignores the
      // scissor rect that keeps the DRAWING inside one cell.
      renderer.setScissorTest(false);
      renderer.clear();
    }
    renderer.autoClear = false;
    renderer.setScissorTest(true);

    for (let i = first; i < last; i++) {
      clearGroup();
      if (!buildItem(pageItems[i])) continue;
      frameItem();
      // A bound render target takes its viewport/scissor from the TARGET, not
      // from renderer.setViewport() (Renderer.js: `viewport = renderTarget.viewport`),
      // and at pixelRatio 1 — so these are plain texels.
      //
      // ROW 0 IS THE TOP ROW. WebGPU's viewport origin is the top-left of the
      // attachment and three passes the rect straight through to setViewport()
      // — no Y flip, unlike WebGL. Measuring y up from the bottom mirrors the
      // whole grid, and because the readback is top-first the slice then hands
      // every tile the image of the cell mirrored across the middle: 24 blanks
      // where the last page had no rows to mirror onto, and — far worse — the
      // WRONG PIECE, silently, on all the rest.
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cell;
      const y = row * cell;
      rt.viewport.set(x, y, cell, cell);
      rt.scissor.set(x, y, cell, cell);
      renderer.render(scene, camera); // renderer already init()-ed (renderAsync is deprecated)
      placed.push({ key: pageItems[i].key, col, row });
    }
    clearGroup();

    rt.viewport.set(0, 0, atlas, atlas);
    rt.scissor.set(0, 0, atlas, atlas);
    renderer.autoClear = prevAutoClear;
    renderer.setScissorTest(prevScissorTest);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
  };

  // ── THE OUTPUT IS ONE SPRITE SHEET, NOT 175 PNGs ───────────────────────────
  // Encoding a PNG is dominated by per-CALL overhead, not by pixels. Measured
  // here: 57 ms for a 192px tile, 84 ms for a 2688x2496 sheet with 182x the
  // pixels — so 175 tiles cost ten seconds and the one sheet holding all of
  // them costs a tenth of one. (Workers do not help: four encoding in parallel
  // took as long as four in series.) The palette draws its tiles by offsetting
  // this one image, which is also why a cache hit is a single Blob.
  const SLICE_RUN = 16; // tiles filtered per yield
  const MAX_SHEET = 4096;
  const sheetCols = Math.max(1, Math.min(
    Math.floor(MAX_SHEET / size),
    Math.ceil(Math.sqrt(items.length)),
  ));
  const sheetRows = Math.max(1, Math.floor(MAX_SHEET / size));
  const perSheet = sheetCols * sheetRows;

  /** @type {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, rows:number}|null} */
  let sheet = null;
  let sheetIndex = -1;
  const sheets = [];
  /** @type {Map<string,{sheet:number,col:number,row:number}>} */
  const cells = new Map();
  let written = 0;

  const finishSheet = async () => {
    if (!sheet) return;
    // Trim the unused rows off the last sheet before encoding — a mostly empty
    // 4096px canvas is pure encode time and pure bytes in IndexedDB.
    const used = Math.ceil((written - sheetIndex * perSheet) / sheetCols);
    if (used < sheetRows) {
      const trimmed = document.createElement("canvas");
      trimmed.width = sheet.canvas.width;
      trimmed.height = used * size;
      trimmed.getContext("2d", { willReadFrequently: true })
        .drawImage(sheet.canvas, 0, 0);
      sheet.canvas = trimmed;
      sheet.rows = used;
    }
    const blob = await new Promise((resolve) => sheet.canvas.toBlob(resolve, "image/png"));
    sheets.push({ blob, cols: sheetCols, rows: sheet.rows });
    sheet = null;
  };

  /**
   * Box-filter each 2x cell of the page down to its final size and stamp it
   * into the sheet.
   *
   * The average is taken on STRAIGHT alpha, straight out of the readback, which
   * is why it is done here and not by drawImage-ing a scaled canvas: a canvas
   * premultiplies, so scaling through one blends every edge pixel towards the
   * transparent black behind it and leaves the tiles with dark fringes.
   */
  const sliceAtlas = async (buf, placed) => {
    const scratch = document.createElement("canvas");
    scratch.width = size;
    scratch.height = size;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });
    const img = sctx.createImageData(size, size);
    const px = img.data;
    const n = SS * SS;
    for (const p of placed) {
      if (written % perSheet === 0) {
        await finishSheet();
        sheetIndex = Math.floor(written / perSheet);
        const canvas = document.createElement("canvas");
        canvas.width = sheetCols * size;
        canvas.height = sheetRows * size;
        sheet = { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), rows: sheetRows };
      }
      const originX = p.col * cell;
      const originY = p.row * cell;
      let o = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let r = 0, g = 0, b = 0, a = 0;
          for (let sy = 0; sy < SS; sy++) {
            let s = (((originY + y * SS + sy) * atlas) + originX + x * SS) * 4;
            for (let sx = 0; sx < SS; sx++) {
              r += buf[s]; g += buf[s + 1]; b += buf[s + 2]; a += buf[s + 3];
              s += 4;
            }
          }
          px[o++] = r / n;
          px[o++] = g / n;
          px[o++] = b / n;
          px[o++] = a / n;
        }
      }
      const at = written - sheetIndex * perSheet;
      const col = at % sheetCols;
      const row = Math.floor(at / sheetCols);
      // Same bargain as the draw runs: filtering 175 tiles back to back is one
      // long block on the main thread and the editor drops to a slideshow while
      // it runs. Yielding costs a few frames of wall time and buys 60 fps.
      if (written % SLICE_RUN === 0) await nextFrame();
      // putImageData, not drawImage: it writes the straight-alpha bytes through
      // unchanged, which is the whole reason the filter above runs in JS.
      sheet.ctx.putImageData(img, col * size, row * size);
      cells.set(p.key, { sheet: sheetIndex, col, row });
      written++;
    }
  };

  const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

  try {
    for (let start = 0; start < items.length; start += perPage) {
      const pageItems = items.slice(start, start + perPage);
      /** @type {{key:string,col:number,row:number}[]} */
      const placed = [];
      for (let i = 0; i < pageItems.length; i += runLength) {
        drawRun(pageItems, i, Math.min(i + runLength, pageItems.length), placed);
        await nextFrame(); // the editor gets the renderer back between runs
      }
      if (!placed.length) continue;
      // THE point of the atlas: one round trip for a whole page of tiles.
      const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, atlas, atlas);
      await sliceAtlas(new Uint8Array(buf.buffer ?? buf), placed);
    }
    await finishSheet();
  } catch (err) {
    console.warn("[modular-road] thumbnail bake failed; falling back to SVG.", err);
  } finally {
    clearGroup();
    rt.dispose();
  }

  if (!sheets.length || !cells.size) return null;
  return { size, sheets, cells };
}

/**
 * Turn a bake (or a cached one) into something the palette can paint with, and
 * revoke whatever a previous call handed out.
 *
 * Sprites, not one image per tile, because the bake produces one sheet — see
 * the note on PNG encode cost in bakeRoadThumbnails. `apply()` keeps the CSS
 * arithmetic in here rather than in the palette: the percentage form of
 * background-position is the one that survives the tile being any size.
 *
 * @param {{size:number, sheets:{blob:Blob,cols:number,rows:number}[], cells:Map<string,{sheet:number,col:number,row:number}>}|null} baked
 * @param {{revoke:()=>void}|null} [previous] released once the new set is live
 */
export function createThumbnailSprites(baked, previous = null) {
  const urls = baked ? baked.sheets.map((s) => URL.createObjectURL(s.blob)) : [];
  previous?.revoke();

  return {
    has: (key) => !!baked?.cells.has(key),
    /**
     * Paint `el` with the tile for `key`.
     * @returns {boolean} false if nothing was baked under that key
     */
    apply(el, key) {
      const at = baked?.cells.get(key);
      if (!at) return false;
      const { cols, rows } = baked.sheets[at.sheet];
      el.style.backgroundImage = `url("${urls[at.sheet]}")`;
      el.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
      // Percentage positions are a RATIO, not an offset: 100% means "align the
      // image's right edge with the box's right edge", so the divisor is the
      // count of gaps, not of cells — and a 1xN sheet has no gaps at all.
      el.style.backgroundPosition =
        `${cols > 1 ? (at.col * 100) / (cols - 1) : 0}% ${rows > 1 ? (at.row * 100) / (rows - 1) : 0}%`;
      el.style.backgroundRepeat = "no-repeat";
      return true;
    },
    revoke() {
      for (const url of urls) URL.revokeObjectURL(url);
    },
  };
}
