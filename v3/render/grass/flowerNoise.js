/**
 * The flower meadow's clumping — shared by the 3D flowers (flowerSystem.js
 * compute) and the far-field terrain tint (flowerTintTsl.js), so the colour
 * patches on distant ground are the same clumps the flowers grow in up close.
 * Change it in one place or the two will disagree at the fade distance.
 */
import { Fn, dot, float, floor, fract, mix, sin, smoothstep, vec2 } from "three/tsl";

const _hash = (q) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453));

/** 2D value noise, smooth, 0..1. */
export const flowerValueNoise = /*#__PURE__*/ Fn(([p]) => {
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
export const flowerClump = /*#__PURE__*/ Fn(([worldXZ, freq, clumping]) => {
  const p = worldXZ.mul(freq);
  const n = flowerValueNoise(p).mul(0.65).add(flowerValueNoise(p.mul(2.3).add(17.1)).mul(0.35));
  return mix(float(1), smoothstep(0.3, 0.75, n).mul(1.8), clumping);
});
