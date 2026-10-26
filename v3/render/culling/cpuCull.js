/**
 * The CPU half of the engine's culling and LOD rules (v3/CULLING_LOD_SPEC.md, R1 + R3).
 *
 * The GPU fields cull with gpuCull.js; the CPU systems (props, trunks, chunked leaves, a
 * field's CPU pre-cull) each had their own copy of the same constants and the same
 * hysteresis written out by hand. This is the one copy. tools/cpuCullTest.mjs pins it
 * against the code it replaced and against the GPU formula.
 */

/** Metres a cull box grows by, so a canopy overhanging its chunk edge does not pop. */
export const CULL_MARGIN = 12;

/** LOD hysteresis (±10 %): demote past d·(1+h), promote back under d·(1−h), so a copy
 *  sitting on a boundary cannot flip tiers every frame while the camera damps. */
export const LOD_HYSTERESIS = 0.1;

/** A tier that has never been chosen (first sight: plain thresholds, no hysteresis). */
export const TIER_UNSET = 255;

/**
 * The LOD tier for a SQUARED distance.
 *
 * `edges2` are the squared tier boundaries, nearest first: [d0², d1², …, dLast²]. The tier
 * is 0 inside d0, 1 between d0 and d1, … and edges2.length beyond the last edge (by
 * convention: hidden). From a known tier it only moves past a boundary grown or shrunk by
 * the hysteresis, and may jump several tiers at once (a teleport, a fast zoom).
 *
 * @param {number} dist2      squared distance (whatever distance the caller measures)
 * @param {number} prev       the previous tier, or TIER_UNSET
 * @param {number[]} edges2   ascending squared boundaries
 * @param {number} [hyst]     LOD_HYSTERESIS
 * @returns {number} 0 … edges2.length
 */
export function lodTier(dist2, prev, edges2, hyst = LOD_HYSTERESIS) {
  const n = edges2.length;
  if (prev === TIER_UNSET || prev > n) {
    let t = 0;
    while (t < n && dist2 > edges2[t]) t++;
    return t;
  }
  const out2 = (1 + hyst) * (1 + hyst), in2 = (1 - hyst) * (1 - hyst);
  let t = prev;
  while (t < n && dist2 > edges2[t] * out2) t++;
  if (t === prev) while (t > 0 && dist2 < edges2[t - 1] * in2) t--;
  return t;
}

/**
 * The GPU frustum test (gpuCull.frustumVisibleAtClip) as six world-space planes, for a
 * sphere of `radius`: a·p + d ≥ 0 on all six = kept. The padded NDC bounds are linear in
 * the world position, so each is a plane (clip rows of the camera matrix).
 *   left, right, bottom (near), top (far), in front of the camera, before the far plane
 *
 * @param {number[]} e   projection · view matrix elements (column-major, THREE.Matrix4)
 * @param {number} fx, fy  projectionMatrix.elements[0] and [5]
 * @param {number} radius  world radius, metres
 * @param {number} padX, padYNear, padYFar  extra NDC slack (as the GPU test)
 * @returns {number[][]} six [a, b, c, d]
 */
export function paddedClipPlanes(e, fx, fy, radius, padX, padYNear, padYFar) {
  const row = (i) => [e[i], e[4 + i], e[8 + i], e[12 + i]];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const kX = 1 + padX, kYn = 1 + padYNear, kYf = 1 + padYFar;
  const fxr = fx * radius, fyr = fy * radius;
  const comb = (a, sa, b, sb, add) => [0, 1, 2, 3].map((k) => sa * a[k] + sb * b[k] + (k === 3 ? add : 0));
  return [
    comb(r0, 1, r3, kX, fxr), comb(r0, -1, r3, kX, fxr),     // left, right
    comb(r1, 1, r3, kYn, fyr), comb(r1, -1, r3, kYf, fyr),   // bottom (near), top (far)
    comb(r3, 1, r3, 0, 0), comb(r3, 1, r2, -1, 0),           // in front, before the far plane
  ];
}

/**
 * One sphere against paddedClipPlanes — the GPU test's answer, on the CPU. Like the GPU,
 * a sphere whose depth |w| is within its radius is always kept (its projection is
 * meaningless there and it is certainly in view).
 *
 * @param {number[][]} planes  paddedClipPlanes(…) built for THIS radius
 * @param {number} x, y, z     the sphere's centre, world
 * @param {number} radius      the same radius the planes were built for
 */
export function sphereVisibleCpu(planes, x, y, z, radius) {
  const w = planes[4];
  if (Math.abs(w[0] * x + w[1] * y + w[2] * z + w[3]) <= radius) return true;
  for (const p of planes) if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  return true;
}
