/**
 * Clumping and placement rules for everything the GPU scatters — flowers,
 * foliage, and any plant added later.
 *
 * Shared on purpose: the 3D plants (the scatter compute) and the far-field
 * terrain tint must read the SAME noise and the SAME rules, or distant ground
 * would show plant colour where no plant grows. Change it in one place or the
 * two disagree at the fade distance.
 */
import { Fn, abs, dot, float, floor, fract, max, mix, select, sin, smoothstep, sqrt, step, vec2 } from "three/tsl";

const _hash = (q) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453));

/** 2D value noise, smooth, 0..1. */
export const scatterValueNoise = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const w = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(_hash(i), _hash(i.add(vec2(1, 0))), w.x),
    mix(_hash(i.add(vec2(0, 1))), _hash(i.add(vec2(1, 1))), w.x),
    w.y,
  );
});

/**
 * Density multiplier at a world XZ: 1 everywhere at clumping 0; clusters (up
 * to 1.8×) and bare gaps (0) at clumping 1.
 * @param worldXZ  vec2 node, metres
 * @param freq     clumps per metre (1 / clump size)
 * @param clumping 0..1
 */
export const scatterClump = /*#__PURE__*/ Fn(([worldXZ, freq, clumping]) => {
  const p = worldXZ.mul(freq);
  const n = scatterValueNoise(p).mul(0.65).add(scatterValueNoise(p.mul(2.3).add(17.1)).mul(0.35));
  return mix(float(1), smoothstep(0.3, 0.75, n).mul(1.8), clumping);
});

/**
 * Where one plant type may grow, 0..1 — the SAME rules for the 3D plants and
 * the far colour, or a slope would show plant colour where no plant grows.
 *
 * @param rule        vec4 (heightMin, heightMax, paint layer index or -1 = any, river distance m or 0 = anywhere)
 * @param y           terrain height (m)
 * @param s0, s1      the splat slices at this point (layers 1-4, layers 5-7)
 * @param riverDist2  River v2 distance field (distance² in UV units; huge = no river)
 * @param worldSize   metres
 * Edges are soft: ±2 m of height or distance; a layer counts from ~20% paint.
 */
export const scatterRuleKeep = /*#__PURE__*/ Fn(([rule, y, s0, s1, riverDist2, worldSize]) => {
  const band = smoothstep(rule.x.sub(2), rule.x.add(2), y)
    .mul(float(1).sub(smoothstep(rule.y.sub(2), rule.y.add(2), y)));

  const L = rule.z;
  const is = (k) => float(1).sub(step(0.5, abs(L.sub(k))));
  const layerW = s0.r.mul(is(0)).add(s0.g.mul(is(1))).add(s0.b.mul(is(2))).add(s0.a.mul(is(3)))
    .add(s1.r.mul(is(4))).add(s1.g.mul(is(5))).add(s1.b.mul(is(6)));
  const onLayer = select(L.lessThan(-0.5), float(1), smoothstep(0.2, 0.5, layerW));

  const riverM = sqrt(max(riverDist2, 0)).mul(worldSize);
  const nearRiver = select(rule.w.lessThanEqual(0), float(1),
    float(1).sub(smoothstep(rule.w.sub(2), rule.w.add(2), riverM)));

  return band.mul(onLayer).mul(nearRiver);
});
