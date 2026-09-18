/**
 * The ambient card atlas — every card effect's artwork packed into ONE
 * texture, because the whole mode is one draw call and one draw call is one
 * sampler.
 *
 * ── PAINTED IMAGES, NOT PROCEDURAL SHAPES ───────────────────────────────────
 *
 * The first version drew wings and leaves with canvas paths so the engine
 * needed no assets. It was not close: `butterfly.png` is a painted Ulysses
 * with real wing markings and a photographic maple sits next to it, and no
 * amount of bezier work gets there. So the atlas PACKS IMAGES, and keeps the
 * procedural shapes only as the fallback for a file that will not load.
 *
 * ── A WHOLE SHAPE PER TILE, SPLIT ACROSS THE HINGE ──────────────────────────
 *
 * Each tile holds a COMPLETE butterfly or leaf, not a mirrored half. The card
 * is two quads hinged at a spine (ambientShapes.js), and the material maps the
 * left quad onto the left half of the painting and the right quad onto the
 * right half:
 *
 *     texU = 0.5 + side · u · 0.5
 *
 * So a butterfly folds at its body and each wing carries its own painted half,
 * asymmetry and all — which is better than the mirrored version would have
 * been, and costs nothing extra.
 *
 * ── IT FILLS IN ─────────────────────────────────────────────────────────────
 *
 * The texture object exists from the first frame and the images are drawn into
 * it as they arrive. Nothing waits on the network and the material is never
 * rebuilt, so there is no recompile and no first-frame stall — the cards are
 * simply blank for the frame or two before their artwork lands.
 *
 * ── ADDING ART ──────────────────────────────────────────────────────────────
 *
 * Drop a single leaf or butterfly on transparency into public/textures/ and
 * add it to AMBIENT_ART below. Nothing else changes: the tile index is what
 * an effect stores, the grid is 4×4, and the packer scales anything to fit.
 *
 * CHECK THE CONSOLE after adding one. Vite answers a missing path under
 * public/ with a 200 and an HTML page, so a typo does not look like a 404 —
 * it looks like a successful load of something that is not an image. The
 * warning below is the thing that actually tells you.
 */
import * as THREE from "three";

/** Tiles per side. 16 slots at 256 px each — the source art's native size. */
export const ATLAS_TILES = 4;
const TILE_PX = 256;

/**
 * Tile index → the image that fills it. The index is what an effect's uniform
 * row carries, so these must stay put; append, never reorder.
 *
 * `fallback` draws the tile when the file does not load. v2's ambient store
 * loaded a moth.png that was not in the repo and simply showed nothing — a
 * missing asset should be visible and logged, not silent.
 */
export const AMBIENT_ART = [
  { key: "butterflyBlue", name: "Butterfly (Ulysses)", url: "/textures/butterfly.png", fallback: "butterfly" },
  { key: "leafMaple", name: "Leaf (maple)", url: "/textures/leaf1-tiny.png", fallback: "leaf" },
];

/**
 * Tile ids, by name. Kept in step with AMBIENT_ART's order and mirrored by
 * TILE in ambientFxState.js.
 */
export const ART_TILE = Object.freeze(
  Object.fromEntries(AMBIENT_ART.map((a, i) => [a.key, i])),
);

/* ── fallbacks, for art that does not load ──────────────────────────────── */

function drawFallbackButterfly(g, s) {
  const X = (u) => u * s, Y = (v) => (1 - v) * s;
  g.fillStyle = "#c8c8c8";
  for (const side of [-1, 1]) {
    const M = (u) => X(0.5 + side * u * 0.5);
    g.beginPath();
    g.moveTo(M(0.04), Y(0.52));
    g.bezierCurveTo(M(0.30), Y(0.98), M(0.78), Y(0.99), M(0.96), Y(0.74));
    g.bezierCurveTo(M(0.99), Y(0.64), M(0.72), Y(0.52), M(0.40), Y(0.50));
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(M(0.04), Y(0.50));
    g.bezierCurveTo(M(0.42), Y(0.50), M(0.80), Y(0.44), M(0.82), Y(0.26));
    g.bezierCurveTo(M(0.83), Y(0.12), M(0.58), Y(0.03), M(0.34), Y(0.08));
    g.bezierCurveTo(M(0.18), Y(0.12), M(0.04), Y(0.24), M(0.02), Y(0.40));
    g.closePath();
    g.fill();
  }
}

function drawFallbackLeaf(g, s) {
  const X = (u) => u * s, Y = (v) => (1 - v) * s;
  g.fillStyle = "#c8c8c8";
  for (const side of [-1, 1]) {
    const M = (u) => X(0.5 + side * u * 0.5);
    g.beginPath();
    g.moveTo(M(0), Y(0.04));
    g.bezierCurveTo(M(0.55), Y(0.14), M(0.95), Y(0.42), M(0.86), Y(0.58));
    g.bezierCurveTo(M(0.74), Y(0.82), M(0.28), Y(0.82), M(0), Y(0.98));
    g.closePath();
    g.fill();
  }
}

const FALLBACKS = { butterfly: drawFallbackButterfly, leaf: drawFallbackLeaf };

/* ── the packer ─────────────────────────────────────────────────────────── */

/** Tile index → its UV origin and size. */
export function tileUv(index) {
  const col = index % ATLAS_TILES;
  const row = Math.floor(index / ATLAS_TILES);
  return { u: col / ATLAS_TILES, v: row / ATLAS_TILES, size: 1 / ATLAS_TILES };
}

/**
 * The atlas texture, returned IMMEDIATELY and filled in as the art loads.
 *
 * @param {object} [o]
 * @param {Array}  [o.art]     the manifest (defaults to AMBIENT_ART)
 * @param {string} [o.baseUrl] prefixed to every relative url
 * @returns {{ texture: THREE.CanvasTexture, ready: Promise<{loaded:number, failed:string[]}> }}
 */
export function createAmbientAtlas({ art = AMBIENT_ART, baseUrl = "" } = {}) {
  const size = TILE_PX * ATLAS_TILES;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  // Painted artwork, so sRGB — unlike the old procedural masks, which were
  // NoColorSpace because they were multipliers rather than colours. Getting
  // this wrong is the "everything is washed out" bug, and this repo has
  // already paid for double-converting a colour once.
  texture.colorSpace = THREE.SRGBColorSpace;
  // flipY OFF so a tile's UV origin is its CANVAS origin, and the tile maths
  // in the card material is the same arithmetic that packed it.
  texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  /** Draw one image into its cell, letterboxed and centred, inside a gutter. */
  const place = (i, draw) => {
    const col = i % ATLAS_TILES;
    const row = Math.floor(i / ATLAS_TILES);
    g.save();
    // One texel of gutter: at small mip levels a bilinear tap at the tile edge
    // otherwise reaches into the neighbour, which reads as a torn wing.
    g.beginPath();
    g.rect(col * TILE_PX + 1, row * TILE_PX + 1, TILE_PX - 2, TILE_PX - 2);
    g.clip();
    g.translate(col * TILE_PX, row * TILE_PX);
    draw();
    g.restore();
    texture.needsUpdate = true;
  };

  const loadOne = (entry, i) => new Promise((resolve) => {
    if (!entry?.url) { resolve(null); return; }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      place(i, () => {
        // Fit inside the cell, keeping the art's own aspect — the maple is
        // 256×221 and stretching it to square would fatten every leaf.
        const pad = 6;
        const box = TILE_PX - pad * 2;
        const k = Math.min(box / img.width, box / img.height);
        const w = img.width * k, h = img.height * k;
        g.drawImage(img, (TILE_PX - w) / 2, (TILE_PX - h) / 2, w, h);
      });
      resolve(null);
    };
    img.onerror = () => {
      console.warn(`[Ambient FX] art missing: ${entry.url} — drawing a placeholder shape instead`);
      place(i, () => FALLBACKS[entry.fallback ?? "leaf"]?.(g, TILE_PX));
      resolve(entry.url);
    };
    img.src = baseUrl + entry.url;
  });

  const ready = Promise.all(art.map(loadOne)).then((r) => {
    const failed = r.filter(Boolean);
    return { loaded: art.length - failed.length, failed };
  });

  return { texture, ready };
}
