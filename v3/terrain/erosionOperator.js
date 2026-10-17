/**
 * EROSION FILTER as a terrain OPERATOR (EDITOR_PLAN 1) — runevision's analytic
 * erosion (erosionFilterTsl.js) over the editor's own GROUND, as a layer of the
 * height stack (heightLayers.js): FINAL = STAMPS( RIVERS( EROSION( GROUND ) ) ).
 *
 * The filter is a GPU shader and the stack is CPU arrays, so: the GROUND goes
 * up as a float texture, one fullscreen pass evaluates the filter for every
 * texel (milliseconds), one readback brings the height OFFSET down, and the
 * operator just adds offset × strength when the stack composes. GROUND changes
 * (sculpt, Generate, a layer) re-bake once the edit settles — the caller
 * decides when (bakeIfStale); sliders re-bake at once.
 *
 * Units. The filter is scale-free when position and height share a unit, so
 * both are metres ÷ `size` (the scale of the biggest gullies): it then sees the
 * TRUE slope, and its onset thresholds mean the same on any map.
 * fadeTarget (−1 valley … +1 peak: what gullies fade toward where it is too flat
 * to erode, which keeps peaks sharp and floors flat) is the ground's height
 * against the mean of two rings around it, in the same bake.
 *
 * Applied in games too: the project saves the parameters, the engine re-bakes
 * on load (awaited, so physics and nav see the eroded ground).
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import { Fn, float, vec2, vec4, uv, uniform, texture, clamp, max } from "three/tsl";
import { createErosionUniforms, erosionFilter, EROSION_FILTER_DEFAULTS } from "./erosionFilterTsl.js";

/** The editor's defaults: the lab's filter, sized and toned for game maps. */
export const EROSION_OP_DEFAULTS = {
  enabled: false,
  size: 600,          // metres: the scale of the largest gullies
  strength: 0.5,      // 0..2 × the filter's own strength
  gullyWeight: EROSION_FILTER_DEFAULTS.gullyWeight,
  detail: EROSION_FILTER_DEFAULTS.detail,
  octaves: EROSION_FILTER_DEFAULTS.octaves,
  onset: 1,           // × the slope thresholds: higher erodes gentler slopes
  seed: 1337,
};
const PARAM_KEYS = Object.keys(EROSION_OP_DEFAULTS);

/**
 * Box blur of `src` (size², radius r texels, clamped edges) into `out`, twice
 * (≈ a tent): separable running sums, O(N) whatever the radius.
 */
export function blurInto(src, tmp, out, size, r) {
  const pass = (a, b, horiz) => {
    const w = 2 * r + 1;
    for (let line = 0; line < size; line++) {
      const at = (k) => {
        const c = k < 0 ? 0 : k >= size ? size - 1 : k;
        return horiz ? a[line * size + c] : a[c * size + line];
      };
      let s = 0;
      for (let k = -r; k <= r; k++) s += at(k);
      for (let k = 0; k < size; k++) {
        b[horiz ? line * size + k : k * size + line] = s / w;
        s += at(k + r + 1) - at(k - r);
      }
    }
  };
  pass(src, tmp, true); pass(tmp, out, false);
  pass(out, tmp, true); pass(tmp, out, false);
}

export function createErosionOperator({ renderer, heightLayers, size, worldSize, maxHeight }) {
  const N = size * size;
  const params = { ...EROSION_OP_DEFAULTS };
  const offset = new Float32Array(N);       // normalized height offset per texel
  let haveOffset = false;

  // GROUND on the GPU (R32F, nearest: texel centres are sampled exactly).
  const groundData = new Float32Array(N);
  const groundTex = new THREE.DataTexture(groundData, size, size, THREE.RedFormat, THREE.FloatType);
  groundTex.minFilter = groundTex.magFilter = THREE.NearestFilter;
  groundTex.wrapS = groundTex.wrapT = THREE.ClampToEdgeWrapping;
  groundTex.generateMipmaps = false;
  groundTex.needsUpdate = true;

  const rt = new THREE.RenderTarget(size, size, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    generateMipmaps: false, depthBuffer: false,
  });

  // Ridges rounded like the creases (the lab's ridge default is 0, perfectly
  // sharp): on 2 m texels a sharp crest is a one-texel crease the mesh draws as
  // a comb of teeth along every ridge.
  const eu = createErosionUniforms({ ...EROSION_FILTER_DEFAULTS, roundingRidge: 0.1, heightOffset: 0, heightOffsetMix: 0 });
  const baseStrength = EROSION_FILTER_DEFAULTS.strength;
  const baseOnsetIn = EROSION_FILTER_DEFAULTS.onsetInput, baseOnsetOct = EROSION_FILTER_DEFAULTS.onsetOctave;
  const uSize = uniform(params.size);
  const texel = 1 / size;
  const metresPerUv = worldSize;

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.toneMapped = mat.fog = false;
  mat.depthTest = mat.depthWrite = false;
  mat.fragmentNode = Fn(() => {
    const c = uv();
    const gt = texture(groundTex);
    const hM = (q) => gt.sample(q).r.mul(maxHeight);              // metres
    const hC = hM(c);
    const dx = hM(c.add(vec2(texel, 0))).sub(hM(c.sub(vec2(texel, 0))));
    const dz = hM(c.add(vec2(0, texel))).sub(hM(c.sub(vec2(0, texel))));
    const run = 2 * texel * metresPerUv;                          // metres between the taps
    // In filter units (metres ÷ size) the gradient is the true slope.
    const hs = vec4(hC.div(uSize), dx.div(run), dz.div(run), 0).xyz;
    // fadeTarget: above (+) or below (−) the mean of two rings, ~a gully apart.
    const ring = (rUv) => {
      let s = float(0);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        s = s.add(hM(c.add(vec2(Math.cos(a), Math.sin(a)).mul(rUv))));
      }
      return s.div(8);
    };
    const rUv = uSize.mul(0.15).div(metresPerUv);
    const rel = hC.sub(ring(rUv).mul(0.5).add(ring(rUv.mul(0.5)).mul(0.5)));
    const fade = clamp(rel.div(max(uSize.mul(0.03), float(0.5))), -1, 1);
    const p = c.mul(metresPerUv).div(uSize);
    const ero = erosionFilter(p, hs, fade, eu);
    // r: the height offset in METRES; g: the ridge map (−1 creases … +1 ridges).
    return vec4(ero.delta.x.mul(uSize), ero.ridgeMap, 0, 1);
  })();
  const quad = new QuadMesh(mat);

  function syncUniforms() {
    uSize.value = Math.max(50, params.size);
    eu.strength.value = baseStrength * Math.max(0, params.strength);
    eu.gullyWeight.value = params.gullyWeight;
    eu.detail.value = params.detail;
    // BAND LIMIT: an octave whose gullies are closer than ~4 texels cannot be
    // drawn by the heightmap and folds into needles along the ridges (nam-valley
    // at Size 600: the 5th octave is ~4 m apart on 2 m texels). Octave k's
    // spacing is Size · scale · cellScale / lacunarity^k.
    const spacing0 = uSize.value * EROSION_FILTER_DEFAULTS.scale * EROSION_FILTER_DEFAULTS.cellScale;
    const texelM = worldSize / size;
    const maxOct = Math.max(1, Math.floor(Math.log(spacing0 / (4 * texelM)) / Math.log(EROSION_FILTER_DEFAULTS.lacunarity)) + 1);
    eu.octaves.value = Math.min(params.octaves, maxOct);
    eu.onsetInput.value = baseOnsetIn * params.onset;
    eu.onsetOctave.value = baseOnsetOct * params.onset;
    eu.seed.value = params.seed;
  }

  const FULL = { x0: 0, z0: 0, x1: size - 1, z1: size - 1 };
  const op = {
    rect: FULL,
    first: true,     // before the rivers: they carve the eroded ground
    apply(out, _ground, r) {
      if (!haveOffset) return;
      for (let z = r.z0; z <= r.z1; z++) {
        const o = z * size;
        for (let x = r.x0; x <= r.x1; x++) out[o + x] += offset[o + x];
      }
    },
  };

  let bakedGroundVersion = -1, bakedParams = "", bakeSeq = 0, lastMs = 0;
  let ridge = null, tmpA = null, tmpB = null;

  /** Bake from the current GROUND and recompose the map. Resolves when done. */
  async function bake() {
    const seq = ++bakeSeq;
    const t0 = performance.now();
    // The filter reads a SMOOTHED ground. It lays gullies along the slope
    // direction, which flips 180° at a crest; on noise the slope fades to 0
    // there first, but a sculpted knife-edge ridge stays steep right up to it,
    // and the two sides' waves met in a step — a "picket fence" of fins along
    // nam-valley's ridges. The offset still lands on the real ground.
    const rIn = Math.max(1, Math.round((params.size * 0.03) / (worldSize / size)));
    blurInto(heightLayers.ground, tmpA ??= new Float32Array(N), groundData, size, rIn);
    groundTex.needsUpdate = true;
    syncUniforms();
    const gv = heightLayers.groundVersion, pk = JSON.stringify(params);
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    quad.render(renderer);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
    const px = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
    if (seq !== bakeSeq) return false;                  // a newer bake superseded this one
    ridge ??= new Float32Array(N);
    const inv = 1 / maxHeight;
    for (let i = 0; i < N; i++) {
      const v = px[i * 4];
      offset[i] = Number.isFinite(v) ? v * inv : 0;
      ridge[i] = px[i * 4 + 1];
    }
    // HIGH-PASS: keep the gullies and ridges, not the shift. Where it is too
    // flat to erode the filter fades peaks UP and valleys DOWN by its whole
    // strength (nam-valley: +18 m on a hilltop) — the lab hid that with a global
    // height offset. Subtracting a wide blur of the offset leaves the map's big
    // shapes and heights where the author put them.
    const r = Math.max(2, Math.round((params.size * 0.25) / (worldSize / size)));
    blurInto(offset, tmpA ??= new Float32Array(N), tmpB ??= new Float32Array(N), size, r);
    for (let i = 0; i < N; i++) offset[i] -= tmpB[i];
    haveOffset = true;
    bakedGroundVersion = gv; bakedParams = pk;
    if (heightLayers.operator("erosion") !== op) heightLayers.setOperator("erosion", op, false);
    heightLayers.compose(FULL);
    lastMs = performance.now() - t0;
    return true;
  }

  function remove() {
    bakeSeq++;
    haveOffset = false;
    if (heightLayers.operator("erosion")) heightLayers.setOperator("erosion", null, FULL);
  }

  return {
    params,
    get lastMs() { return lastMs; },
    get ridge() { return ridge; },
    /** Change parameters; resolves after the re-bake (or the removal). */
    async set(next) {
      for (const k of PARAM_KEYS) if (next[k] !== undefined) params[k] = next[k];
      if (!params.enabled) { remove(); return; }
      await bake();
    },
    /** Re-bake if GROUND or the parameters moved since the last bake. */
    isStale() {
      return params.enabled && (heightLayers.groundVersion !== bakedGroundVersion || JSON.stringify(params) !== bakedParams);
    },
    bake,
    exportData() { return { ...params }; },
    /** Saved parameters (null = off). Resolves once the map is eroded. */
    async importData(d) {
      Object.assign(params, EROSION_OP_DEFAULTS);
      if (d) for (const k of PARAM_KEYS) if (d[k] !== undefined) params[k] = d[k];
      if (!params.enabled) { remove(); return; }
      await bake();
    },
    dispose() { rt.dispose(); groundTex.dispose(); mat.dispose(); },
  };
}
