// Thunderline sun shadows (prototype, DESIGN.md §7). The track is STATIC and the sun is FIXED per
// track, so:
//   A. a STATIC ATLAS, rendered ONCE: the sun's ortho view split into 16 m cells, only the cells the
//      track touches, each at ~15.5 texels/m, packed in one float texture. Sharp at any distance.
//   B. a LIVE MAP, every frame: 48 × 48 m around the CAR (not the camera), ~43 texels/m, texel-snapped,
//      fixed size (no shimmer, independent of the FOV). The car + the track right around it.
//   C. a RECEIVER node: inside the live box → live map; elsewhere → the atlas cell; blended at the edge.
// No depth textures, no comparison samplers: both maps store "distance from the sun" in R32F and are
// read with textureLoad (no sampler binding at all — the engine sits at WebGPU's 16-sampler ceiling).
// Why not CSM: its boxes follow the camera (the far cascade was 4–6 texels/m past 10 m, then PCF
// radius 4 smeared it); why not TileShadowNode: every fragment samples every tile. See the study.
import * as THREE from "three";
import {
  Fn, uniform, float, int, ivec2, vec2, vec3, vec4, dot, floor, clamp, min, max, abs, mix, select, smoothstep,
  positionWorld, normalWorld, textureLoad, texture,
} from "three/tsl";

import { LAYERS } from "../../../../v3/render/layers.js";

// Registered in v3/render/layers.js (4-7 are the cascades' — my first pick, 5 and 6, clashed).
export const STATIC_LAYER = LAYERS.SUN_STATIC_CASTER;
export const DYNAMIC_LAYER = LAYERS.SUN_DYNAMIC_CASTER;

const CELL = 16; // m
const CELL_TEX = 256; // texels per atlas cell, border included
const BORDER = 4; // texels each side, so filter taps never read a neighbour cell
const INNER = CELL_TEX - 2 * BORDER;
const LIVE_SIZE = 48; // m
const LIVE_TEX = 2048;

/**
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {THREE.Scene} o.scene the main scene (rendered with layers + an override material)
 * @param {THREE.Vector3} o.sunDir unit vector TOWARDS the sun
 * @param {THREE.Vector3[]} o.casterPoints world points sampling every static caster (deck + rail vertices)
 * @param {number} [o.atlasSize] 8192 (1024 cells) or 4096 (256 cells)
 */
export function createSunShadows({ renderer, scene: mainScene, sunDir, casterPoints, atlasSize = 8192 }) {
  // ---- light frame: x/y across the sun's view, z towards the sun ----
  const zL = sunDir.clone().normalize();
  const xL = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zL);
  if (xL.lengthSq() < 1e-6) xL.set(1, 0, 0);
  xL.normalize();
  const yL = new THREE.Vector3().crossVectors(zL, xL).normalize();
  const toL = (p) => [p.dot(xL), p.dot(yL), p.dot(zL)];

  // ---- which cells hold casters, and the depth range ----
  let zMin = Infinity, zMax = -Infinity, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const L = casterPoints.map(toL);
  for (const [x, y, z] of L) {
    zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  zMax += 40; zMin -= 400; // up-sun margin for the car; down-sun far enough to reach the floor
  const range = zMax - zMin;
  const gx0 = Math.floor(x0 / CELL) * CELL - CELL;
  const gy0 = Math.floor(y0 / CELL) * CELL - CELL;
  const nx = Math.ceil((x1 - gx0) / CELL) + 2;
  const ny = Math.ceil((y1 - gy0) / CELL) + 2;
  const used = new Set();
  for (const [x, y] of L) {
    const cx = Math.floor((x - gx0) / CELL), cy = Math.floor((y - gy0) / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) used.add((cy + dy) * nx + (cx + dx)); // dilate one cell
  }
  // THE ATLAS FITS THE TRACK (performance pass, 2026-10-20): the smallest square of cell slots that holds
  // its cells (White 1: 346 cells -> 19 x 19 slots, 4864², not 8192²); `atlasSize` is the most it may take
  const inGridCells = [...used].filter((k) => k >= 0 && k < nx * ny);
  const perRow = Math.min(atlasSize / CELL_TEX, Math.max(1, Math.ceil(Math.sqrt(inGridCells.length))));
  const capacity = perRow * perRow;
  const cells = inGridCells.slice(0, capacity);
  const atlasPx = perRow * CELL_TEX;
  const table = new Float32Array(nx * ny * 4); // (slotCol, slotRow, present, 0)
  cells.forEach((k, slot) => {
    table[k * 4] = slot % perRow;
    table[k * 4 + 1] = Math.floor(slot / perRow);
    table[k * 4 + 2] = 1;
  });
  const tableTex = new THREE.DataTexture(table, nx, ny, THREE.RGBAFormat, THREE.FloatType);
  tableTex.minFilter = tableTex.magFilter = THREE.NearestFilter;
  tableTex.needsUpdate = true;

  // ---- render targets: "distance from the sun" (0 = at zMax, 1 = at zMin) in R32F, plus a depth buffer ----
  const makeRT = (size, depthBuffer = true) => {
    const rt = new THREE.RenderTarget(size, size, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer });
    rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
    rt.texture.generateMipmaps = false;
    return rt;
  };
  // NO DEPTH BUFFER on the atlas: each cell is drawn into a small target that has one and copied in (bake) —
  // a depth buffer the atlas's size, used only while baking, doubled its memory
  const atlasRT = makeRT(atlasPx, globalThis.__BAKE_DIRECT === true);
  const liveRT = makeRT(LIVE_TEX);

  const uZ = [uniform(zL), uniform(zMax), uniform(range)];
  const depthMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  depthMat.colorNode = vec4(uZ[1].sub(dot(positionWorld, uZ[0])).div(uZ[2]), 0, 0, 1);

  // an ortho camera looking down the sun, at light-space centre (cx, cy), covering `half` m each side
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, range + 50);
  cam.up.copy(yL);
  const aimCam = (cx, cy, half) => {
    const c = xL.clone().multiplyScalar(cx).addScaledVector(yL, cy).addScaledVector(zL, zMax + 5);
    cam.position.copy(c);
    cam.lookAt(c.clone().sub(zL));
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 0.1; cam.far = range + 50;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  };

  function renderInto(rt, viewport, layers) {
    const scene = mainScene;
    const prev = { target: renderer.getRenderTarget(), override: scene.overrideMaterial, bg: scene.background, env: scene.environment, autoClear: renderer.autoClear };
    scene.overrideMaterial = depthMat;
    scene.background = null;
    renderer.autoClear = false;
    cam.layers.disableAll();
    for (const l of layers) cam.layers.enable(l);
    rt.viewport.copy(viewport);
    rt.scissor.copy(viewport);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev.target);
    scene.overrideMaterial = prev.override;
    scene.background = prev.bg;
    renderer.autoClear = prev.autoClear;
  }
  function clearRT(rt) {
    const prev = renderer.getRenderTarget();
    const cc = renderer.getClearColor(new THREE.Color());
    const ca = renderer.getClearAlpha();
    renderer.setClearColor(0xffffff, 1); // 1 = "nothing between here and the sun"
    rt.scissorTest = false;
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, false);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(cc, ca);
  }

  // ---- A. bake the atlas once ----
  const texel = CELL / INNER;
  // ~4.6–4.8 s for 632 cells, i.e. ~7.6 ms of FIXED overhead per render call. Rendering only the
  // track (a bare scene) measured the same, so the fix is fewer calls (several cells per pass /
  // bigger cells) or a progressive bake over the first frames — see DESIGN.md §7.
  function bake() {
    const t0 = performance.now();
    clearRT(atlasRT);
    const prevCC = renderer.getClearColor(new THREE.Color());
    const vp = new THREE.Vector4();
    const direct = globalThis.__BAKE_DIRECT === true;
    const cellRT = direct ? null : makeRT(CELL_TEX);
    const at = new THREE.Vector2();
    cells.forEach((k, slot) => {
      const cx = k % nx, cy = Math.floor(k / nx);
      const sc = slot % perRow, sr = Math.floor(slot / perRow);
      aimCam(gx0 + (cx + 0.5) * CELL, gy0 + (cy + 0.5) * CELL, CELL / 2 + BORDER * texel);
      if (direct) {
        vp.set(sc * CELL_TEX, sr * CELL_TEX, CELL_TEX, CELL_TEX);
        renderInto(atlasRT, vp, [STATIC_LAYER]);
        return;
      }
      clearRT(cellRT);
      vp.set(0, 0, CELL_TEX, CELL_TEX);
      renderInto(cellRT, vp, [STATIC_LAYER]);
      renderer.copyTextureToTexture(cellRT.texture, atlasRT.texture, null, at.set(sc * CELL_TEX, sr * CELL_TEX));
    });
    cellRT?.dispose();
    renderer.setClearColor(prevCC);
    return performance.now() - t0;
  }

  // ---- B. the live map around the car, texel-snapped ----
  const live = { cx: uniform(0), cy: uniform(0) };
  const liveTexel = LIVE_SIZE / LIVE_TEX;
  function follow(carPos) {
    const [x, y] = toL(carPos);
    const sx = Math.round(x / liveTexel) * liveTexel;
    const sy = Math.round(y / liveTexel) * liveTexel;
    live.cx.value = sx;
    live.cy.value = sy;
    clearRT(liveRT);
    aimCam(sx, sy, LIVE_SIZE / 2);
    renderInto(liveRT, new THREE.Vector4(0, 0, LIVE_TEX, LIVE_TEX), [STATIC_LAYER, DYNAMIC_LAYER]);
  }

  // ---- C. the receiver ----
  const uX = uniform(xL), uY = uniform(yL);
  const atlasTex = atlasRT.texture, liveTex = liveRT.texture;
  // 4 taps around the point, each a BILINEAR compare of its 2×2 texels (what hardware PCF does):
  // 16 loads, smooth edges instead of the stair steps single-texel compares gave.
  const TAPS = [[-0.6, -0.2], [0.2, -0.6], [0.6, 0.2], [-0.2, 0.6]];
  const lit = (tex, x, y, d, bias) => select(textureLoad(tex, ivec2(int(x), int(y))).x.add(bias).greaterThanEqual(d), float(1), float(0));
  const pcf = (tex, px, py, d, bias, lo, hi) => {
    let sum = float(0);
    for (const [ox, oy] of TAPS) {
      const sx = px.add(ox).sub(0.5), sy = py.add(oy).sub(0.5);
      const x0 = clamp(floor(sx), lo.x, hi.x), y0 = clamp(floor(sy), lo.y, hi.y);
      const x1 = min(x0.add(1), hi.x), y1 = min(y0.add(1), hi.y);
      const fx = clamp(sx.sub(floor(sx)), 0, 1), fy = clamp(sy.sub(floor(sy)), 0, 1);
      const top = mix(lit(tex, x0, y0, d, bias), lit(tex, x1, y0, d, bias), fx);
      const bot = mix(lit(tex, x0, y1, d, bias), lit(tex, x1, y1, d, bias), fx);
      sum = sum.add(mix(top, bot, fy));
    }
    return sum.div(TAPS.length);
  };

  // debug: 0 normal, 1 force lit (tests the engine hook), 2 live map only, 3 atlas only
  const dbg = uniform(0);
  const visibility = Fn(() => {
    const p = positionWorld.add(normalWorld.mul(0.06));
    const lx = dot(p, uX), ly = dot(p, uY);
    const d = uZ[1].sub(dot(p, uZ[0])).div(uZ[2]);

    // live box
    const lu = lx.sub(live.cx).div(LIVE_SIZE).add(0.5);
    const lv = ly.sub(live.cy).div(LIVE_SIZE).add(0.5);
    // texel rows run DOWN the image while the camera's up (+y) is at row 0: read v flipped
    const liveVis = pcf(liveTex, lu.mul(LIVE_TEX), float(1).sub(lv).mul(LIVE_TEX), d, float(0.02 / range), vec2(0, 0), vec2(LIVE_TEX - 1, LIVE_TEX - 1));
    const edge = min(min(lu, float(1).sub(lu)), min(lv, float(1).sub(lv))); // 0 at the box edge, 0.5 at the centre
    const liveW = smoothstep(0.0, 0.06, edge); // last ~3 m blend into the atlas

    // static atlas cell
    const fx = lx.sub(gx0).div(CELL), fy = ly.sub(gy0).div(CELL);
    const cx = clamp(floor(fx), 0, nx - 1), cy = clamp(floor(fy), 0, ny - 1);
    const entry = textureLoad(tableTex, ivec2(int(cx), int(cy)));
    const inGrid = fx.greaterThanEqual(0).and(fy.greaterThanEqual(0)).and(fx.lessThan(nx)).and(fy.lessThan(ny));
    const ox = entry.x.mul(CELL_TEX).add(BORDER), oy = entry.y.mul(CELL_TEX).add(BORDER);
    // same flip as the live map inside the cell (camera up = row 0); FLIP_SLOT_ROWS covers the
    // viewport origin convention for which slot row a cell landed in
    const px = ox.add(fx.sub(cx).mul(INNER));
    const py = oy.add(float(1).sub(fy.sub(cy)).mul(INNER));
    const staticVis = pcf(atlasTex, px, py, d, float(0.05 / range), vec2(ox.sub(BORDER), oy.sub(BORDER)), vec2(ox.add(INNER + BORDER - 1), oy.add(INNER + BORDER - 1)));
    const staticOrLit = select(inGrid.and(entry.z.greaterThan(0.5)), staticVis, float(1));

    const normal = mix(staticOrLit, liveVis, select(edge.greaterThan(0), liveW, float(0)));
    return select(dbg.equal(1), float(1), select(dbg.equal(2), liveVis, select(dbg.equal(3), staticOrLit, normal)));
  })();

  return {
    bake, follow, visibility, atlasRT, liveRT, setDebug(m) { dbg.value = m; },
    /** Debug: min/max/mean of a w×h block of a map (reads back from the GPU). */
    async probe(which = "live", x = 0, y = 0, w = 64, h = 64) {
      const rt = which === "live" ? liveRT : atlasRT;
      const px = await renderer.readRenderTargetPixelsAsync(rt, x, y, w, h);
      // rows are padded to 256 bytes on read-back: stride = len / h floats
      const stride = px.length / h;
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0, below1 = 0;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const v = px[yy * stride + xx];
        lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; n++;
        if (v < 0.999) below1++;
      }
      return { lo, hi, mean: sum / n, n, below1 };
    },
    lightSpace: (p) => toL(p), zMax, range,
    stats: { cells: cells.length, capacity, grid: `${nx}×${ny}`, texelsPerMetre: INNER / CELL, liveTexelsPerMetre: LIVE_TEX / LIVE_SIZE, atlasSize: atlasPx, atlasMB: Math.round((atlasPx * atlasPx * 4) / 1048576) },
    dispose() { atlasRT.dispose(); liveRT.dispose(); tableTex.dispose(); depthMat.dispose(); },
  };
}
