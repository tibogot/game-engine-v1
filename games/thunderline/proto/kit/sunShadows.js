// Thunderline sun shadows (prototype, DESIGN.md §7). The track is STATIC and the sun is FIXED per
// track, so:
//   A. a STATIC ATLAS, rendered ONCE: the sun's ortho view split into 16 m cells, only the cells the
//      track touches, each at ~15.5 texels/m, packed in one float texture. Sharp at any distance.
//   B. a LIVE MAP, every frame: 32 × 32 m around the CAR (not the camera), ~96 texels/m, texel-snapped,
//      fixed size (no shimmer, independent of the FOV). The car + the track right around it.
//   C. a RECEIVER node: inside the live box → live map; elsewhere → the atlas cell; blended at the edge.
// No depth textures, no comparison samplers: both maps store "distance from the sun" in R32F and are
// read with textureLoad (no sampler binding at all — the engine sits at WebGPU's 16-sampler ceiling).
// Why not CSM: its boxes follow the camera (the far cascade was 4–6 texels/m past 10 m, then PCF
// radius 4 smeared it); why not TileShadowNode: every fragment samples every tile. See the study.
import * as THREE from "three";
import {
  Fn, uniform, float, int, ivec2, vec2, vec3, vec4, dot, floor, clamp, min, max, abs, mix, select, smoothstep, cos, sin, fwidth, dFdx, dFdy, length, If, Loop,
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
const LIVE_SIZE = Number(new URLSearchParams(globalThis.location?.search ?? "").get("liveSize")) || 32; // m (was 48; ?liveSize= for the study)
const Q = new URLSearchParams(globalThis.location?.search ?? ""); // A/B switches for the shadow study
// THE LIVE MAP near the car (user, 2026-10-21: the rail's and the car's shadows "saw-tooth" right by the
// car, at the chase camera — 2.3 cm texels were several pixels there). Compared at the chase view: 2048
// + a tent filter still stepped; 4096 over 48 m + tent and 3072 over 32 m + tent were both clean — the
// second kept (~1 cm texels, 36 MB + its depth buffer; was 16 + 16). Beyond 16 m the turned atlas takes
// over. ?liveTex= / ?liveSize= / ?liveTent=0 for the study.
const LIVE_TEX = Number(Q.get("liveTex")) || 3072;
const LIVE_TENT = Q.get("liveTent") !== "0";

/**
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {THREE.Scene} o.scene the main scene (rendered with layers + an override material)
 * @param {THREE.Vector3} o.sunDir unit vector TOWARDS the sun
 * @param {THREE.Vector3[]} o.casterPoints world points sampling every static caster (deck + rail vertices)
 * @param {number} [o.atlasSize] 8192 (1024 cells) or 4096 (256 cells)
 * @param {object} [o.reuse] the previous bake's shadows: its maps, uniforms and RECEIVER NODE are kept (see
 *   "kept across bakes" below) — the shell bakes track after track, and a new node recompiled every material
 */
export function createSunShadows({ renderer, scene: mainScene, sunDir, casterPoints, trackLine = null, atlasSize = 8192, reuse = null }) {
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
  // EACH CELL TURNED TO THE TRACK (user, 2026-10-21: the shadows "do a saw-tooth shape"). A rail's shadow
  // runs diagonally across the texel grid and its edge came out as stair steps (6.5 cm texels); a wider
  // filter only made them a wave, 2× resolution does not fit one texture. So each cell's bake camera is
  // turned so the track there runs along a texel row: the main direction of the casters around the cell
  // (their light-space points over the 3 × 3 cells around it, principal axis). A turned square must still
  // cover the whole cell, so its capture grows by |cos| + |sin| (up to √2 at 45°: ~11 texels/m across,
  // still no steps along). ?shadowAlign=0 bakes them square as before (an A/B).
  const align = new URLSearchParams(globalThis.location?.search ?? "").get("shadowAlign") !== "0";
  // THE ROAD'S DIRECTION, from its centre line (trackLine): each segment's light-space direction as a
  // DOUBLED angle (a line has no front: θ and θ + 180° are the same), summed by length per cell. The
  // casters' own points were tried first (their principal axis): the posts, seen from the sun, smear
  // sideways, so cells along one straight picked −1.6° … −12.8° for a −6.5° road and the edge kinked at
  // every seam.
  const roadDir = new Map(); // cell -> [Σ len·cos2θ, Σ len·sin2θ]
  if (trackLine) for (let i = 1; i < trackLine.length; i++) {
    const [ax, ay] = toL(trackLine[i - 1]), [bx, by] = toL(trackLine[i]);
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 1e-3 || len > CELL) continue; // a jump's gap or a respawn seam
    const th = Math.atan2(dy, dx);
    const k = Math.floor(((ay + by) / 2 - gy0) / CELL) * nx + Math.floor(((ax + bx) / 2 - gx0) / CELL);
    let r = roadDir.get(k);
    if (!r) roadDir.set(k, (r = [0, 0]));
    r[0] += len * Math.cos(2 * th); r[1] += len * Math.sin(2 * th);
  }
  const roadAngle = (k) => {
    // the cell's own road, else the 3 × 3 around it (a cell the road only shades)
    let r = roadDir.get(k);
    if (!r) {
      r = [0, 0];
      const cx = k % nx, cy = Math.floor(k / nx);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = roadDir.get((cy + dy) * nx + cx + dx);
        if (q) { r[0] += q[0]; r[1] += q[1]; }
      }
    }
    return Math.hypot(r[0], r[1]) > 1e-6 ? 0.5 * Math.atan2(r[1], r[0]) : null;
  };
  const stats = new Map(); // cell -> [n, Σx, Σy, Σxx, Σyy, Σxy] (no trackLine: the casters' principal axis)
  for (const [x, y] of L) {
    const k = Math.floor((y - gy0) / CELL) * nx + Math.floor((x - gx0) / CELL);
    let s = stats.get(k);
    if (!s) stats.set(k, (s = [0, 0, 0, 0, 0, 0]));
    s[0]++; s[1] += x; s[2] += y; s[3] += x * x; s[4] += y * y; s[5] += x * y;
  }
  const fold = (a) => (a > Math.PI / 4 ? a - Math.PI / 2 : a < -Math.PI / 4 ? a + Math.PI / 2 : a);
  const cellAngle = (k) => {
    if (!align) return 0;
    const road = trackLine ? roadAngle(k) : null;
    if (road !== null) return fold(road);
    const t = [0, 0, 0, 0, 0, 0];
    const cx = k % nx, cy = Math.floor(k / nx);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const s = stats.get((cy + dy) * nx + cx + dx);
      if (s) for (let i = 0; i < 6; i++) t[i] += s[i];
    }
    if (t[0] < 3) return 0;
    const mx = t[1] / t[0], my = t[2] / t[0];
    const sxx = t[3] / t[0] - mx * mx, syy = t[4] / t[0] - my * my, sxy = t[5] / t[0] - mx * my;
    let a = 0.5 * Math.atan2(2 * sxy, sxx - syy); // the principal axis
    // a square turned by a or a ± 90° lines up the same: keep it within ±45° (the smallest turn)
    if (a > Math.PI / 4) a -= Math.PI / 2;
    if (a < -Math.PI / 4) a += Math.PI / 2;
    return a;
  };
  const table = new Float32Array(nx * ny * 4); // (slotCol, slotRow, present, angle)
  cells.forEach((k, slot) => {
    table[k * 4] = slot % perRow;
    table[k * 4 + 1] = Math.floor(slot / perRow);
    table[k * 4 + 2] = 1;
    table[k * 4 + 3] = cellAngle(k);
  });
  // KEPT ACROSS BAKES (2026-10-28, ONE ALWAYS-LOADED PAGE: the shell plays track after track). The receiver
  // node is part of every material that takes the sun; a NEW node each bake rebuilt them all — ~170 shader
  // modules, ~11 s of the GPU driver compiling, on every play, even the same track again. So a bake with
  // `reuse` keeps the previous one's: the same render targets (the atlas resized), the cell table at a fixed
  // size, the uniforms (the track's numbers live in them, not in the shader's code), the casters' material and
  // the receiver node itself — the generated shaders are the same, nothing compiles. Not kept when the atlas
  // format changes (a light range past 2.5 km keeps 32 bits) or the grid outgrows the fixed table.
  const atlas16 = range <= 2500 && renderer.backend?.device?.features?.has?.("texture-formats-tier1") === true;
  const atlasType = atlas16 ? THREE.UnsignedShortType : THREE.FloatType;
  const TABLE_N = 256; // cells each way (4 km): the table texture's size, fixed so it can be kept
  const fits = nx <= TABLE_N && ny <= TABLE_N;
  const sh = reuse?._shared && reuse._shared.atlasType === atlasType && fits && reuse._shared.tableN === TABLE_N ? reuse._shared : null;
  const tableW = fits ? TABLE_N : nx, tableH = fits ? TABLE_N : ny;
  const tableTex = sh ? sh.tableTex : new THREE.DataTexture(new Float32Array(tableW * tableH * 4), tableW, tableH, THREE.RGBAFormat, THREE.FloatType);
  tableTex.image.data.fill(0);
  for (let cy = 0; cy < ny; cy++) tableTex.image.data.set(table.subarray(cy * nx * 4, (cy + 1) * nx * 4), cy * tableW * 4);
  tableTex.minFilter = tableTex.magFilter = THREE.NearestFilter;
  tableTex.needsUpdate = true;

  // ---- render targets: "distance from the sun" (0 = at zMax, 1 = at zMin) in R32F, plus a depth buffer ----
  const makeRT = (size, depthBuffer = true, type = THREE.FloatType) => {
    const rt = new THREE.RenderTarget(size, size, { type, format: THREE.RedFormat, depthBuffer });
    rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
    rt.texture.generateMipmaps = false;
    rt.texture.normalized = type === THREE.UnsignedShortType; // R16Unorm, not R16Uint (three asks for the flag)
    return rt;
  };
  // NO DEPTH BUFFER on the atlas: each cell is drawn into a small target that has one and copied in (bake) —
  // a depth buffer the atlas's size, used only while baking, doubled its memory
  // THE ATLAS IN 16 BITS (2026-10-27, video memory: 110 MB on White 2 in R32F, and above ~1.75x pixel ratio the
  // frame fell off a cliff on a 6 GB laptop GPU). R16Unorm (texture-formats-tier1) reads back as a float, so
  // nothing else changes. A step is range / 65535 (White 2: 1.5 km of light depth -> 2.3 cm, rounding <= 1.4 cm)
  // against the atlas's 5 cm bias; a longer range, or a GPU without the feature (three would make R16Uint, an
  // integer target the depth material cannot write), keeps R32F. The live map stays R32F: its bias is 2 cm.
  const atlasRT = sh ? sh.atlasRT : makeRT(atlasPx, globalThis.__BAKE_DIRECT === true, atlasType);
  if (sh && atlasRT.width !== atlasPx) atlasRT.setSize(atlasPx, atlasPx);
  const liveRT = sh ? sh.liveRT : makeRT(LIVE_TEX);
  if (sh && liveRT.width !== LIVE_TEX) liveRT.setSize(LIVE_TEX, LIVE_TEX); // (parked: shrunk to 1 texel)

  const uZ = sh ? sh.uZ : [uniform(zL), uniform(zMax), uniform(range)];
  if (sh) { uZ[0].value.copy(zL); uZ[1].value = zMax; uZ[2].value = range; }
  // the track's numbers the receiver reads: the cell grid (x0, y0, nx, ny) and the two depth biases
  const uGrid = sh ? sh.uGrid : uniform(new THREE.Vector4());
  uGrid.value.set(gx0, gy0, nx, ny);
  const uBias = sh ? sh.uBias : uniform(new THREE.Vector2());
  uBias.value.set(0.05 / range, 0.02 / range); // atlas, live map
  // NO BLENDING, ever (three r186, 2026-10-27: every shadow vanished on the drive page). With an override
  // material three copies each object's `transparent` onto it (the car's windows, a glass pane: transmission
  // counts too); r186 shapes the fragment output to the target's format — ONE channel here — so a blended
  // pipeline had no alpha to read, WebGPU rejected it and the whole pass with it (atlas bake and live map).
  // A caster writes its distance whatever it is drawn with; single pass (no back-then-front for those).
  const depthMat = sh ? sh.depthMat : new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, blending: THREE.NoBlending });
  depthMat.forceSinglePass = true;
  if (!sh) depthMat.colorNode = vec4(uZ[1].sub(dot(positionWorld, uZ[0])).div(uZ[2]), 0, 0, 1);

  // an ortho camera looking down the sun, at light-space centre (cx, cy), covering `half` m each side,
  // turned by `angle` about the sun (its right = cos·xL + sin·yL, its up = −sin·xL + cos·yL)
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, range + 50);
  cam.up.copy(yL);
  const _c = new THREE.Vector3(), _at = new THREE.Vector3(); // (reused: aimCam runs every frame for the live map)
  const aimCam = (cx, cy, half, angle = 0) => {
    const c = _c.copy(xL).multiplyScalar(cx).addScaledVector(yL, cy).addScaledVector(zL, zMax + 5);
    cam.up.copy(xL).multiplyScalar(-Math.sin(angle)).addScaledVector(yL, Math.cos(angle));
    cam.position.copy(c);
    cam.lookAt(_at.copy(c).sub(zL));
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 0.1; cam.far = range + 50;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  };

  // clearWhite: the WHOLE target cleared to "nothing towards the sun" IN the render pass (WebGPU's load op) —
  // the live map, every frame, did a separate clear first: its own pass and queue submit (performance pass,
  // 2026-10-22)
  const _cc = new THREE.Color();
  function renderInto(rt, viewport, layers, clearWhite = false) {
    const scene = mainScene;
    const prevTarget = renderer.getRenderTarget(), prevOverride = scene.overrideMaterial, prevBg = scene.background, prevAuto = renderer.autoClear;
    let ca = 0;
    if (clearWhite) { renderer.getClearColor(_cc); ca = renderer.getClearAlpha(); renderer.setClearColor(0xffffff, 1); }
    scene.overrideMaterial = depthMat;
    scene.background = null;
    renderer.autoClear = clearWhite;
    cam.layers.disableAll();
    for (const l of layers) cam.layers.enable(l);
    rt.viewport.copy(viewport);
    rt.scissor.copy(viewport);
    rt.scissorTest = !clearWhite;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    renderer.autoClear = prevAuto;
    if (clearWhite) renderer.setClearColor(_cc, ca);
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
  // ~4.6–4.8 s for 632 cells, i.e. ~7.6 ms of FIXED overhead per render call. Rendering only the
  // track (a bare scene) measured the same, so the fix is fewer calls (several cells per pass /
  // bigger cells) or a progressive bake over the first frames — see DESIGN.md §7.
  function bake() {
    const t0 = performance.now();
    clearRT(atlasRT);
    // the LIVE map set up as a render target now, before any material samples it: made first by a material's
    // binding, its first draw (follow) re-created the texture, and whatever had bound the old one read a
    // destroyed texture every frame (2026-10-27, the FX lab once the parked car kept its lights in the scene)
    clearRT(liveRT);
    const prevCC = renderer.getClearColor(new THREE.Color());
    const vp = new THREE.Vector4();
    const direct = globalThis.__BAKE_DIRECT === true;
    // (copied into the atlas: same format). KEPT with the rest (shared): a new target is a new render context,
    // and three keys its built shaders by it — every caster's material was built again at each bake
    const cellRT = direct ? null : (shared.cellRT ??= makeRT(CELL_TEX, true, atlasType));
    const at = new THREE.Vector2();
    cells.forEach((k, slot) => {
      const cx = k % nx, cy = Math.floor(k / nx);
      const sc = slot % perRow, sr = Math.floor(slot / perRow);
      // the turned square covers the cell: half side (CELL/2)(|cos|+|sin|), plus the border texels
      const a = table[k * 4 + 3], c = Math.cos(a), s = Math.sin(a);
      const R = (CELL / 2) * (Math.abs(c) + Math.abs(s));
      // ONE TEXEL LATTICE per angle: the centre snapped to whole texels in the turned frame, so two
      // cells at the same angle (a straight) share their grid — else the edge jumps a fraction of a
      // texel at every cell seam (seen: a notch every 16 m). The receiver snaps the same way.
      const t = (2 * R) / INNER;
      const ccx = gx0 + (cx + 0.5) * CELL, ccy = gy0 + (cy + 0.5) * CELL;
      const us = Math.round((c * ccx + s * ccy) / t) * t, vs = Math.round((-s * ccx + c * ccy) / t) * t;
      aimCam(c * us - s * vs, s * us + c * vs, (R * CELL_TEX) / INNER, a);
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
    renderer.setClearColor(prevCC);
    return performance.now() - t0;
  }

  // ---- B. the live map around the car, texel-snapped ----
  // THE BOX FOLLOWS THE CAMERA'S DISTANCE (2026-10-21): its texel steps can only be hidden by making them
  // small ON SCREEN. A car edge almost parallel to the texel rows steps once every ~11 texels, and a filter
  // only smooths steps about as long as itself (measured on the CPU from the real map: radius 2.5 → 3.4 mm
  // of wobble, 6 → 1.6 mm). So close to the car (the free camera) the box shrinks — same texture, finer
  // texels: LIVE_SIZE at the chase camera (~8 m away), shrinking with the SQUARE of the distance (seen: at
  // 5 m a 24 m box still stepped, a 12 m one was clean), down to LIVE_MIN; in steps, so zooming doesn't
  // shimmer.
  const LIVE_MIN = 8; // m
  const CHASE_DIST = 8; // m, the chase camera's distance to the car (measured 7.9)
  const LIVE_VP = new THREE.Vector4(0, 0, LIVE_TEX, LIVE_TEX), LIVE_LAYERS = [STATIC_LAYER, DYNAMIC_LAYER];
  const LIVE_STEPS = [LIVE_MIN, 10, 12, 14, 16, 20, 24, 28, LIVE_SIZE].filter((v) => v <= LIVE_SIZE);
  const live = sh ? sh.live : { cx: uniform(0), cy: uniform(0), size: uniform(LIVE_SIZE) };
  function follow(carPos, camDist = Infinity) {
    const want = Math.min(LIVE_SIZE, LIVE_SIZE * (camDist / CHASE_DIST) ** 2);
    let size = LIVE_SIZE;
    for (const v of LIVE_STEPS) if (v >= want) { size = v; break; }
    const liveTexel = size / LIVE_TEX;
    const x = carPos.dot(xL), y = carPos.dot(yL);
    const sx = Math.round(x / liveTexel) * liveTexel;
    const sy = Math.round(y / liveTexel) * liveTexel;
    live.cx.value = sx;
    live.cy.value = sy;
    live.size.value = size;
    aimCam(sx, sy, size / 2);
    renderInto(liveRT, LIVE_VP, LIVE_LAYERS, true);
  }

  // ---- C. the receiver ----
  const uX = sh ? sh.uX : uniform(xL.clone()), uY = sh ? sh.uY : uniform(yL.clone());
  if (sh) { uX.value.copy(xL); uY.value.copy(yL); }
  const atlasTex = atlasRT.texture, liveTex = liveRT.texture;
  // 4 taps around the point, each a BILINEAR compare of its 2×2 texels (what hardware PCF does):
  // 16 loads, smooth edges instead of the stair steps single-texel compares gave.
  const TAPS = [[-0.6, -0.2], [0.2, -0.6], [0.6, 0.2], [-0.2, 0.6]];
  const lit = (tex, x, y, d, bias) => select(textureLoad(tex, ivec2(int(x), int(y))).x.add(bias).greaterThanEqual(d), float(1), float(0));
  // THE ATLAS'S TAPS, spread ALONG the road (its cells are turned so the road runs along x): on a curve
  // the road turns inside a cell and a rail's edge drifts across the rows — long flat runs, then a
  // one-texel jump. Spread along x, the jump becomes a ramp; across (y) the edge stays as sharp as before.
  const ALONG = Number(new URLSearchParams(globalThis.location?.search ?? "").get("shadowAlong")) || 2.4; // ±texels, ?shadowAlong= to compare
  const TAPS_ALONG = [[-ALONG, -0.2], [-ALONG / 3, 0.2], [ALONG / 3, -0.2], [ALONG, 0.2]];
  const pcf = (tex, px, py, d, bias, lo, hi, taps = TAPS) => {
    let sum = float(0);
    for (const [ox, oy] of taps) {
      const sx = px.add(ox).sub(0.5), sy = py.add(oy).sub(0.5);
      const x0 = clamp(floor(sx), lo.x, hi.x), y0 = clamp(floor(sy), lo.y, hi.y);
      const x1 = min(x0.add(1), hi.x), y1 = min(y0.add(1), hi.y);
      const fx = clamp(sx.sub(floor(sx)), 0, 1), fy = clamp(sy.sub(floor(sy)), 0, 1);
      const top = mix(lit(tex, x0, y0, d, bias), lit(tex, x1, y0, d, bias), fx);
      const bot = mix(lit(tex, x0, y1, d, bias), lit(tex, x1, y1, d, bias), fx);
      sum = sum.add(mix(top, bot, fy));
    }
    return sum.div(taps.length);
  };
  // a 3×3 grid of bilinear compares one texel apart, tent-weighted (1 2 1 × 1 2 1): ~3 texels of soft edge
  // THE WIDE TENT, same 36 loads: the 6 × 6 texels around the point, each compared once and weighted by a
  // smooth 2-D tent of radius TENT_R texels centred on the exact point. A 3 × 3 grid of BILINEAR compares
  // (below) read 36 texels too, but overlapping, for a ±2-texel footprint — too small to hide 1 cm steps
  // up close; this one's footprint is ±2.5 texels and has no visible tap copies (a 3 × 3 spread wider
  // showed three shifted edges).
  const TENT_R = Number(Q.get("tentR")) || 3; // the tent reaches just past the outer taps (2.5 · spread)
  const SPREAD_K = Number(Q.get("spreadK")) || 1.0; // ?spreadK= (study): screen pixels per tap spacing
  // never more than this many texels between taps (2026-10-21: uncapped, the far road's grazing pixels
  // spread the rail shadows into a dark wash across the road)
  const SPREAD_CAP = Number(Q.get("spCap")) || 2;
  // RECEIVER-PLANE DEPTH (gpx, gpy: the receiver's depth change per texel in x / y): a tap 2.5 texels away
  // compares against the surface's depth THERE, not at the centre — else a wide footprint on a sloped deck
  // (a banked turn, a ramp) shadows the deck itself (the streaks a wide filter drew before).
  // AT LEAST ~2.5 SCREEN PIXELS OF SOFT EDGE (user, 2026-10-21, his screenshots after every fix: the edge
  // still a saw-tooth). Seen in his window, 3× enlarged: the edge had become ~1 screen pixel sharp — the
  // teeth were the SCREEN's own pixel steps (a shadow edge is shading, MSAA never smooths it), not the
  // map's. So the samples SPREAD with the screen footprint: `s` texels apart, s = max(1, texels per screen
  // pixel), measured by the derivatives of the lookup itself — the edge is ≥ ~2.5 px wide at any zoom.
  // fp: texels per screen pixel, measured on the smooth light-space position by the caller (the atlas's
  // own texel coordinates jump at its cell seams)
  // THE TAP GRIDS ARE SHADER LOOPS (2026-10-27, load profile): unrolled in JS they put ~180 texture reads
  // into every material that receives the sun — each one a 400-570 KB shader, and the first drive froze
  // ~20 s while the GPU driver compiled them. Same taps, same maths; the inputs are vars so the loop body
  // does not recompute them.
  const pcfWideTent = (tex, px, py, d, bias, lo, hi, gpx = null, gpy = null, fp = float(1)) => {
    const sp = clamp(fp.mul(SPREAD_K), float(1), float(SPREAD_CAP)).toVar();
    const pxv = px.toVar(), pyv = py.toVar(), dv = d.toVar();
    const gx = gpx?.toVar(), gy = gpy?.toVar();
    const sum = float(0).toVar(), wsum = float(0).toVar();
    Loop(6, 6, ({ i, j }) => {
      // 6 × 6 taps `sp` texels apart around the point, each the texel under it
      const tx = floor(pxv.add(sp.mul(float(i).sub(2.5)))), ty = floor(pyv.add(sp.mul(float(j).sub(2.5))));
      // the texel's centre to the point, in texels
      const ox = tx.add(0.5).sub(pxv), oy = ty.add(0.5).sub(pyv);
      const wx = max(float(0), float(1).sub(abs(ox).div(sp.mul(TENT_R))));
      const wy = max(float(0), float(1).sub(abs(oy).div(sp.mul(TENT_R))));
      const w = wx.mul(wy).toVar();
      const dt = gx ? dv.add(gx.mul(ox)).add(gy.mul(oy)) : dv;
      sum.addAssign(lit(tex, clamp(tx, lo.x, hi.x), clamp(ty, lo.y, hi.y), dt, bias).mul(w));
      wsum.addAssign(w);
    });
    return sum.div(wsum);
  };
  const TS = Number(Q.get("tentScale")) || 1; // ?tentScale= (study)
  const TENT = [[-TS, 1], [0, 2], [TS, 1]];
  // EDGE-ONLY WIDE FILTER for the live map (2026-10-21, the user's close-ups still stepped): the car's side
  // edge steps once every ~11 texels, and a filter only erases steps about as wide as itself (CPU test on
  // the real map: radius 2.5 → 3.4 mm of wobble, 6 → 1.6 mm). 6 × 6 taps spread wider drew visible layers.
  // So: 9 coarse taps first — fully lit or fully dark (almost every pixel) stops there; only pixels ON an
  // edge pay the 10 × 10 tent (radius ADAPT_R texels, spread with the screen footprint like the 6 × 6).
  const ADAPT_N = 10, ADAPT_R = Number(Q.get("adaptR")) || 5;
  const pcfAdaptive = (tex, px, py, d, bias, lo, hi, gpx, gpy, fp) => {
    const sp = clamp(fp.mul(SPREAD_K), float(1), float(SPREAD_CAP)).toVar();
    const pxv = px.toVar(), pyv = py.toVar(), dv = d.toVar(), gx = gpx.toVar(), gy = gpy.toVar();
    const at = (ox, oy) => {
      const tx = floor(pxv.add(ox)), ty = floor(pyv.add(oy));
      const dt = dv.add(gx.mul(tx.add(0.5).sub(pxv))).add(gy.mul(ty.add(0.5).sub(pyv)));
      return { tx, ty, v: lit(tex, clamp(tx, lo.x, hi.x), clamp(ty, lo.y, hi.y), dt, bias) };
    };
    let coarse = float(0);
    const c = (ADAPT_R - 0.5);
    for (const oy of [-c, 0, c]) for (const ox of [-c, 0, c]) coarse = coarse.add(at(sp.mul(ox), sp.mul(oy)).v);
    coarse = coarse.toVar();
    const res = coarse.div(9).toVar();
    If(coarse.greaterThan(0.5).and(coarse.lessThan(8.5)), () => {
      const sum = float(0).toVar(), wsum = float(0).toVar();
      Loop(ADAPT_N, ADAPT_N, ({ i, j }) => {
        const o = at(sp.mul(float(i).sub((ADAPT_N - 1) / 2)), sp.mul(float(j).sub((ADAPT_N - 1) / 2)));
        const ox = o.tx.add(0.5).sub(pxv), oy = o.ty.add(0.5).sub(pyv);
        const w = max(float(0), float(1).sub(abs(ox).div(sp.mul(ADAPT_R)))).mul(max(float(0), float(1).sub(abs(oy).div(sp.mul(ADAPT_R))))).toVar();
        sum.addAssign(o.v.mul(w));
        wsum.addAssign(w);
      });
      res.assign(sum.div(wsum));
    });
    return res;
  };
  const pcfTent = (tex, px, py, d, bias, lo, hi) => {
    let sum = float(0);
    for (const [ox, wx] of TENT) for (const [oy, wy] of TENT) {
      const sx = px.add(ox).sub(0.5), sy = py.add(oy).sub(0.5);
      const x0 = clamp(floor(sx), lo.x, hi.x), y0 = clamp(floor(sy), lo.y, hi.y);
      const x1 = min(x0.add(1), hi.x), y1 = min(y0.add(1), hi.y);
      const fx = clamp(sx.sub(floor(sx)), 0, 1), fy = clamp(sy.sub(floor(sy)), 0, 1);
      const top = mix(lit(tex, x0, y0, d, bias), lit(tex, x1, y0, d, bias), fx);
      const bot = mix(lit(tex, x0, y1, d, bias), lit(tex, x1, y1, d, bias), fx);
      sum = sum.add(mix(top, bot, fy).mul(wx * wy));
    }
    return sum.div(16);
  };
  // THE ATLAS'S SAW-TOOTH (user, 2026-10-21): a rail's shadow along the road is a diagonal edge across the
  // atlas's 6.5 cm texels, and it shows their stair steps. A WIDER FILTER was tried and does not fix it
  // (3×3 tent-weighted bilinear taps, 36 loads, spread 1 / 1.6 / 2.2 texels): the teeth turn into a wave,
  // and at 2.2 the road and kerbs self-shadow in streaks — the steps are IN the map. Doubling the atlas
  // resolution does not fit one texture (White 1: 9728² > 8192). See TODO.md for the fix proposed.

  // debug: 0 normal, 1 force lit (tests the engine hook), 2 live map only, 3 atlas only
  const dbg = sh ? sh.dbg : uniform(0);
  const visibility = sh ? sh.visibility : Fn(() => {
    const p = positionWorld.add(normalWorld.mul(0.06));
    const lx = dot(p, uX), ly = dot(p, uY);
    const d = uZ[1].sub(dot(p, uZ[0])).div(uZ[2]);
    // the receiver's plane in light space: normalised depth per metre along xL / yL (dz/dx = −nx/nz;
    // d = (zMax − z) / range). nz floored: at grazing angles the plane term would explode (and N·L ~ 0
    // shades it dark anyway)
    const nz = max(dot(normalWorld, uZ[0]), float(0.25));
    const ddx = dot(normalWorld, uX).div(nz.mul(uZ[2])), ddy = dot(normalWorld, uY).div(nz.mul(uZ[2]));
    // metres of light space per screen pixel here (continuous: no seams)
    // the pixel's NARROW width (2026-10-21): looking along the road a screen pixel is a long thin strip
    // of road; its long side (fwidth's max) smeared distant shadows sideways. Narrow width = |a × b| /
    // longest of a, b (a, b: the pixel's two edges in light space)
    const ex = dFdx(lx), ey = dFdx(ly), fx2 = dFdy(lx), fy2 = dFdy(ly);
    const longest = max(length(vec2(ex, ey)), length(vec2(fx2, fy2)));
    const mpp = Q.get("fp") === "max" ? max(fwidth(lx), fwidth(ly)) : abs(ex.mul(fy2).sub(ey.mul(fx2))).div(max(longest, float(1e-6)));

    // live box
    const lu = lx.sub(live.cx).div(live.size).add(0.5);
    const lv = ly.sub(live.cy).div(live.size).add(0.5);
    // texel rows run DOWN the image while the camera's up (+y) is at row 0: read v flipped
    // live texels: +x along xL, +y DOWN the image = −yL
    // ONLY THE LOOKUPS THAT CAN CHANGE THE RESULT RUN (2026-10-27, GPU measurements: the full set — the
    // live map's taps, the atlas's 6 × 6 in this cell AND the neighbour's — ran on every sunlit pixel,
    // ~1.5 ms of a 5 ms frame at 1584 × 855, 4.3 ms at 1.5×). The live map only inside its box, the atlas
    // only where the live map does not fully cover it, the neighbour cell only within SEAM_BLEND of a seam.
    // Same maths where they run; the skipped ones were multiplied by 0 or thrown away by a select.
    const lt = live.size.div(LIVE_TEX);
    const edge = min(min(lu, float(1).sub(lu)), min(lv, float(1).sub(lv))).toVar(); // 0 at the box edge, 0.5 at the centre
    const liveW = smoothstep(0.0, 0.06, edge).toVar(); // last ~2 m blend into the atlas
    const liveVis = float(1).toVar();
    If(edge.greaterThan(0), () => {
      liveVis.assign((Q.get("liveFilter") === "tent3" ? pcfTent : Q.get("liveFilter") === "tent6" ? pcfWideTent : LIVE_TENT ? pcfAdaptive : pcfWideTent)(liveTex, lu.mul(LIVE_TEX), float(1).sub(lv).mul(LIVE_TEX), d, uBias.y, vec2(0, 0), vec2(LIVE_TEX - 1, LIVE_TEX - 1), ddx.mul(lt), ddy.mul(lt).negate(), mpp.div(lt)));
    });

    // static atlas: the point looked up in one cell's bake ({ vis, here: the cell exists and was baked })
    const fx = lx.sub(uGrid.x).div(CELL), fy = ly.sub(uGrid.y).div(CELL);
    const cellVis = (cxi, cyi) => {
      const cx = clamp(cxi, float(0), uGrid.z.sub(1)), cy = clamp(cyi, float(0), uGrid.w.sub(1));
      const entry = textureLoad(tableTex, ivec2(int(cx), int(cy)));
      const here = cxi.greaterThanEqual(0).and(cyi.greaterThanEqual(0)).and(cxi.lessThan(uGrid.z)).and(cyi.lessThan(uGrid.w)).and(entry.z.greaterThan(0.5));
      const ox = entry.x.mul(CELL_TEX).add(BORDER), oy = entry.y.mul(CELL_TEX).add(BORDER);
      // the cell's bake was turned by entry.w (cellAngle): turn the point back into the camera's frame;
      // the turned square spans ±R (R = CELL/2 · (|cos| + |sin|)) over INNER texels
      const ca = cos(entry.w), sa = sin(entry.w);
      const R = abs(ca).add(abs(sa)).mul(CELL / 2);
      // the bake's centre, snapped to whole texels in the turned frame (see bake: one lattice per angle)
      const t = R.mul(2 / INNER);
      const ccx = cx.add(0.5).mul(CELL).add(uGrid.x), ccy = cy.add(0.5).mul(CELL).add(uGrid.y);
      const us = floor(ca.mul(ccx).add(sa.mul(ccy)).div(t).add(0.5)).mul(t);
      const vs = floor(ca.mul(ccy).sub(sa.mul(ccx)).div(t).add(0.5)).mul(t);
      const u = ca.mul(lx).add(sa.mul(ly)).sub(us).div(R.mul(2)).add(0.5);
      const v = ca.mul(ly).sub(sa.mul(lx)).sub(vs).div(R.mul(2)).add(0.5);
      // same flip as the live map inside the cell (camera up = row 0); FLIP_SLOT_ROWS covers the
      // viewport origin convention for which slot row a cell landed in
      const px = ox.add(u.mul(INNER));
      const py = oy.add(float(1).sub(v).mul(INNER));
      // SOFT EDGES (user, 2026-10-21: "softer edges" chosen over bigger maps): the wide tent here too,
      // ~±16 cm of soft edge at 6.5 cm texels, in the turned frame (+x along its right, +y = −its up)
      const lo = vec2(ox.sub(BORDER), oy.sub(BORDER)), hi = vec2(ox.add(INNER + BORDER - 1), oy.add(INNER + BORDER - 1));
      const gpx = ca.mul(ddx).add(sa.mul(ddy)).mul(t), gpy = ca.mul(ddy).sub(sa.mul(ddx)).mul(t).negate();
      const vis = Q.get("atlasFilter") === "along" ? pcf(atlasTex, px, py, d, uBias.x, lo, hi, align ? TAPS_ALONG : TAPS) : pcfWideTent(atlasTex, px, py, d, uBias.x, lo, hi, gpx, gpy, mpp.div(t));
      return { vis, here };
    };
    const cx = floor(fx).toVar(), cy = floor(fy).toVar();
    // ACROSS A SEAM two cells turned by different angles (a curve) put the edge a fraction of a texel
    // apart: a jog every 16 m. Within SEAM_BLEND of the nearer seam the neighbour's bake (it covers its
    // border texels, ~0.26 m, into this cell) is faded in, half and half on the seam.
    const SEAM_BLEND = 0.15; // m
    const ax = fx.sub(cx), ay = fy.sub(cy);
    const dX = min(ax, float(1).sub(ax)).mul(CELL), dY = min(ay, float(1).sub(ay)).mul(CELL);
    const seamW = float(0.5).mul(float(1).sub(smoothstep(0.0, SEAM_BLEND, min(dX, dY)))).toVar();
    const staticOrLit = float(1).toVar();
    If(liveW.lessThan(1).or(dbg.equal(3)), () => {
      const own = cellVis(cx, cy);
      If(own.here, () => {
        staticOrLit.assign(own.vis);
        If(seamW.greaterThan(0), () => {
          const alongX = dX.lessThan(dY);
          const ncx = select(alongX, cx.add(select(ax.lessThan(0.5), float(-1), float(1))), cx);
          const ncy = select(alongX, cy, cy.add(select(ay.lessThan(0.5), float(-1), float(1))));
          const nb = cellVis(ncx, ncy);
          If(nb.here, () => { staticOrLit.assign(mix(staticOrLit, nb.vis, seamW)); });
        });
      });
    });

    const normal = mix(staticOrLit, liveVis, select(edge.greaterThan(0), liveW, float(0)));
    // dbg 4: the live map's texels as a checkerboard (are the teeth the map's texels?)
    const checker = floor(lu.mul(LIVE_TEX)).add(floor(float(1).sub(lv).mul(LIVE_TEX))).mod(2);
    return select(dbg.equal(4), checker.mul(0.7).add(0.3), select(dbg.equal(1), float(1), select(dbg.equal(2), liveVis, select(dbg.equal(3), staticOrLit, normal))));
  })();

  // what a later bake may keep (reuse): see "kept across bakes"
  const shared = sh ?? { atlasType, tableN: fits ? TABLE_N : 0, tableTex, atlasRT, liveRT, uZ, uGrid, uBias, uX, uY, live, dbg, depthMat, visibility };
  const self = {
    bake, follow, visibility, atlasRT, liveRT, setDebug(m) { dbg.value = m; },
    /** the live box's size this frame (m) — it follows the camera's distance */
    get liveSize() { return live.size.value; },
    /** Debug: each baked cell's grid position and turn (degrees) */
    cellAngles: () => cells.map((k) => [k % nx, Math.floor(k / nx), +((table[k * 4 + 3] * 180) / Math.PI).toFixed(2)]),
    /** Debug: min/max/mean of a w×h block of a map (reads back from the GPU). */
    async probe(which = "live", x = 0, y = 0, w = 64, h = 64) {
      const rt = which === "live" ? liveRT : atlasRT;
      const px = await renderer.readRenderTargetPixelsAsync(rt, x, y, w, h);
      // rows are padded to 256 bytes on read-back: stride = len / h values (16-bit atlas: 0-65535)
      const stride = px.length / h;
      const k = px instanceof Uint16Array ? 1 / 65535 : 1;
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0, below1 = 0;
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
        const v = px[yy * stride + xx] * k;
        lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; n++;
        if (v < 0.999) below1++;
      }
      return { lo, hi, mean: sum / n, n, below1 };
    },
    lightSpace: (p) => toL(p), zMax, range,
    stats: { cells: cells.length, capacity, grid: `${nx}×${ny}`, texelsPerMetre: INNER / CELL, liveTexelsPerMetre: LIVE_TEX / LIVE_SIZE, atlasSize: atlasPx, atlasMB: Math.round((atlasPx * atlasPx * (atlas16 ? 2 : 4)) / 1048576), atlasBits: atlas16 ? 16 : 32 },
    /** Frees the maps — unless a newer bake took them over (`reuse`): then they are its own. */
    dispose() {
      if (shared.owner !== self) return;
      atlasRT.dispose(); liveRT.dispose(); tableTex.dispose(); depthMat.dispose(); shared.cellRT?.dispose();
    },
    /**
     * Out of use for now (the shell's builder after a play): the two maps shrunk to one texel, ~130 MB of
     * video memory back; the next bake with `reuse` sizes them again, nothing compiles.
     */
    park() {
      if (shared.owner !== self) return;
      atlasRT.setSize(1, 1);
      liveRT.setSize(1, 1);
      // …and NO CELLS, the live box far away: the ground can still be holding this node (the terrain kept it after
      // the switch back to the cascades) — its cells, read from a 1-texel atlas, drew the last played track's road
      // as dark stair-stepped shapes on the builder's empty ground (user, 2026-10-29: White 1 from the shell's
      // warm-up play). With no cell and no live box, it reads "lit". The next bake writes the table again.
      tableTex.image.data.fill(0);
      tableTex.needsUpdate = true;
      live.cx.value = live.cy.value = 1e9;
    },
    _shared: shared,
  };
  shared.owner = self;
  return self;
}
