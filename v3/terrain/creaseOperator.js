/**
 * SOFTEN CREASES — a terrain OPERATOR of the height stack (heightLayers.js),
 * beside the erosion filter: FINAL = STAMPS( RIVERS( CREASES + EROSION( GROUND ) ) ).
 *
 * WHY. The terrain is drawn as a grid of triangles one texel apart, each square
 * split along a fixed diagonal. A bend sharper than a texel — the lip and the
 * foot of a terrace wall, a cut, a knife-edge ridge — cannot be drawn by that
 * grid: where the bend runs diagonally to it, the triangles alternate across
 * it and the edge renders as a row of V-shaped teeth (nam-valley's terraces:
 * 12 m walls 3 texels wide, the lip bending inside ONE texel; the user,
 * 2026-10-17). No shading fixes a silhouette, so the fix is in the heights:
 * every bend is spread over a few texels, which the grid CAN draw.
 *
 * HOW. A selective blur. B = a Gaussian blur of the ground (≈ `radius` m).
 * On flat ground and on any straight slope, however steep, B = the ground (a
 * symmetric blur leaves a plane where it is), so walls stay walls and terrace
 * tops stay flat. Only where the ground BENDS does B differ — by about
 * curvature × radius² — and there the ground moves toward B: lips round over,
 * feet fill in. Small differences (fine relief, the erosion filter's gullies,
 * sculpted detail) are kept: the blur applies only where |B − ground| passes
 * `detail` metres, faded in from a third of that.
 *
 * Baked from GROUND on the CPU (tens of ms for a 1024² map) as an offset the
 * stack adds; re-baked when GROUND settles after an edit, and only the texels
 * whose offset changed are recomposed. Saved with the level, applied in games.
 */
/**
 * Separable Gaussian (sigma in texels) of `src` into `out`, extending the
 * ground LINEARLY past the map edge (h(−k) = 2·h(0) − h(k)): a clamped edge
 * bends a straight slope there, and this filter would read that as a crease
 * along every border.
 */
function gaussBlur(src, tmp, out, size, sigma) {
  const R = Math.max(1, Math.ceil(sigma * 2.5));
  const w = new Float64Array(2 * R + 1);
  let sw = 0;
  for (let k = -R; k <= R; k++) { w[k + R] = Math.exp(-(k * k) / (2 * sigma * sigma)); sw += w[k + R]; }
  for (let k = 0; k < w.length; k++) w[k] /= sw;
  const pass = (a, b, horiz) => {
    for (let line = 0; line < size; line++) {
      const get = (c) => (horiz ? a[line * size + c] : a[c * size + line]);
      const at = (k) => (k < 0 ? 2 * get(0) - get(Math.min(size - 1, -k))
        : k >= size ? 2 * get(size - 1) - get(Math.max(0, 2 * (size - 1) - k)) : get(k));
      for (let k = 0; k < size; k++) {
        let v = 0;
        if (k >= R && k < size - R) for (let j = -R; j <= R; j++) v += w[j + R] * get(k + j);
        else for (let j = -R; j <= R; j++) v += w[j + R] * at(k + j);
        b[horiz ? line * size + k : k * size + line] = v;
      }
    }
  };
  pass(src, tmp, true); pass(tmp, out, false);
}

export const CREASE_OP_DEFAULTS = {
  enabled: false,
  radius: 1.5,        // metres a bend is spread over (≈ 2σ of the Gaussian)
  strength: 1,        // 0..1: how far toward the rounded ground
  detail: 0.25,       // metres: bends that move the ground less than this stay
};
const PARAM_KEYS = Object.keys(CREASE_OP_DEFAULTS);

/**
 * The offset (normalized height) that softens `ground`'s creases — pure, for
 * the operator and the tests. `tmp`/`blur` are scratch of the same size.
 */
export function creaseOffset(ground, out, tmp, blur, { size, worldSize, maxHeight, radius, strength, detail }) {
  const texelM = worldSize / size;
  // A Gaussian, σ = radius / 2: under a texel for the default 1.5 m — enough
  // for the grid to draw a bend, little enough that a 3-texel wall stays one.
  const sigma = Math.max(0.25, radius / (2 * texelM));
  gaussBlur(ground, tmp, blur, size, sigma);
  const s = Math.max(0, Math.min(1, strength));
  const t1 = Math.max(1e-4, detail) / maxHeight, t0 = t1 / 3;
  for (let i = 0; i < ground.length; i++) {
    const d = blur[i] - ground[i];
    const a = Math.abs(d);
    let w = 0;
    if (a >= t1) w = 1;
    else if (a > t0) { const q = (a - t0) / (t1 - t0); w = q * q * (3 - 2 * q); }
    out[i] = d * w * s;
  }
  return sigma;
}

export function createCreaseOperator({ heightLayers, size, worldSize, maxHeight }) {
  const N = size * size;
  const params = { ...CREASE_OP_DEFAULTS };
  let offset = new Float32Array(N), next = new Float32Array(N);
  const tmp = new Float32Array(N), blur = new Float32Array(N);
  let haveOffset = false;

  const FULL = { x0: 0, z0: 0, x1: size - 1, z1: size - 1 };
  const op = {
    rect: FULL,
    first: true,     // before the rivers: they carve the softened ground
    apply(out, _ground, r) {
      if (!haveOffset) return;
      for (let z = r.z0; z <= r.z1; z++) {
        const o = z * size;
        for (let x = r.x0; x <= r.x1; x++) out[o + x] += offset[o + x];
      }
    },
  };

  let bakedGroundVersion = -1, bakedParams = "", lastMs = 0;

  /** Bake from the current GROUND and recompose what changed. */
  function bake() {
    const t0 = performance.now();
    creaseOffset(heightLayers.ground, next, tmp, blur, { size, worldSize, maxHeight, ...params });
    // Only the texels whose offset moved need recomposing (a sculpt stroke
    // changes a patch, not the map — and every operator above runs again).
    let x0 = size, z0 = size, x1 = -1, z1 = -1;
    for (let z = 0; z < size; z++) {
      const o = z * size;
      for (let x = 0; x < size; x++) {
        if (Math.abs(next[o + x] - (haveOffset ? offset[o + x] : 0)) > 1e-9) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (z < z0) z0 = z; z1 = z;
        }
      }
    }
    [offset, next] = [next, offset];
    const wasOn = haveOffset;
    haveOffset = true;
    bakedGroundVersion = heightLayers.groundVersion; bakedParams = JSON.stringify(params);
    // Rivers above re-solve their AUTO levels when this changes (underKey).
    if (x1 >= 0) op.version = (op.version ?? 0) + 1;
    if (heightLayers.operator("creases") !== op) heightLayers.setOperator("creases", op, false);
    if (!wasOn) heightLayers.compose(FULL);
    else if (x1 >= 0) heightLayers.compose({ x0, z0, x1, z1 });
    lastMs = performance.now() - t0;
    return true;
  }

  function remove() {
    haveOffset = false;
    if (heightLayers.operator("creases")) heightLayers.setOperator("creases", null, FULL);
  }

  return {
    params,
    get lastMs() { return lastMs; },
    /** Change parameters (re-bakes, or removes when switched off). */
    set(nextParams) {
      for (const k of PARAM_KEYS) if (nextParams[k] !== undefined) params[k] = nextParams[k];
      if (!params.enabled) { remove(); return; }
      bake();
    },
    /** Re-bake if GROUND or the parameters moved since the last bake. */
    isStale() {
      return params.enabled && (heightLayers.groundVersion !== bakedGroundVersion || JSON.stringify(params) !== bakedParams);
    },
    bake,
    exportData() { return { ...params }; },
    /** Saved parameters (null = off). */
    importData(d) {
      Object.assign(params, CREASE_OP_DEFAULTS);
      if (d) for (const k of PARAM_KEYS) if (d[k] !== undefined) params[k] = d[k];
      if (!params.enabled) { remove(); return; }
      haveOffset = false;
      bake();
    },
  };
}
