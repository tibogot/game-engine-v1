/**
 * The GPU culling tests every indirect-drawn field shares.
 *
 * Lifted out of scatterField.js unchanged (2026-09-18) so the ambient FX field
 * can use the SAME frustum test rather than grow a second, subtly different
 * copy of it — the kind of divergence that gets found months later as "plants
 * cull correctly and butterflies pop".
 *
 * Everything here works on a CLIP-SPACE position, because a caller that needs
 * both the frustum test and the on-screen size must not pay for two matrix
 * multiplies. `scatterFrustumVisible` is the convenience wrapper that does the
 * multiply for callers that only need the one test.
 */
import { Fn, float, max, step, vec4 } from "three/tsl";

/**
 * Is a sphere at this clip position on screen?
 *
 * The screen edges are pushed OUT by the object's radius on every side (the
 * grass's original test only padded the bottom and pulled the top IN, which
 * culled every fern within a few metres of a camera looking down). An object
 * closer to the camera than its own radius is always kept: its projection is
 * meaningless there and it is certainly in view.
 *
 * @param clip      vec4 — projection · view · vec4(worldPos, 1)
 * @param fx, fy    projectionMatrix.elements[0] and [5]
 * @param radius    world radius, metres
 * @param padX      extra NDC slack left and right
 * @param padYNear  extra NDC slack below
 * @param padYFar   extra NDC slack above
 */
export const frustumVisibleAtClip = /*#__PURE__*/ Fn(([clip, fx, fy, radius, padX, padYNear, padYFar]) => {
  const depth = clip.w.abs().max(1e-4);
  const ndc = clip.xyz.div(depth);
  const rX = fx.mul(radius).div(depth).add(padX);
  const rY = fy.mul(radius).div(depth);
  const inX = step(float(-1).sub(rX), ndc.x).mul(step(ndc.x, float(1).add(rX)));
  const inY = step(float(-1).sub(rY).sub(padYNear), ndc.y).mul(step(ndc.y, float(1).add(rY).add(padYFar)));
  const inFront = step(float(0), clip.w).mul(step(ndc.z, float(1)));
  const nearCamera = step(clip.w.abs(), radius);
  return max(nearCamera, inX.mul(inY).mul(inFront));
});

/** The same test from a world position — one matrix multiply, then the above. */
export const scatterFrustumVisible = /*#__PURE__*/ Fn(([worldPos, cameraMatrix, fx, fy, radius, padX, padYNear, padYFar]) => {
  return frustumVisibleAtClip(cameraMatrix.mul(vec4(worldPos, 1)), fx, fy, radius, padX, padYNear, padYFar);
});

/**
 * Roughly how many pixels across a sphere of `radius` is, at this clip depth.
 *
 * Why it matters: an object smaller than a pixel does not fade out politely,
 * it CRAWLS — it sparkles and drops in and out of existence between frames as
 * the rasteriser's coverage test flips. This game's starfield was invisible for
 * exactly that reason, and its birds carry a minimum screen size because of it.
 * A field that spawns thousands of small things has to be able to say "below
 * this many pixels, do not draw it at all".
 *
 * @param radius      world radius, metres
 * @param clipW       clip.w — the eye-space depth
 * @param fy          projectionMatrix.elements[5]
 * @param viewportH   render height, pixels
 * @returns diameter in pixels
 */
export const screenRadiusPixels = /*#__PURE__*/ Fn(([radius, clipW, fy, viewportH]) => {
  return fy.mul(radius).div(clipW.abs().max(1e-4)).mul(viewportH);
});

/**
 * The world size something must have to cover `pixels` on screen at `dist`.
 *
 * The inverse of the above, and the other half of the sub-pixel problem. The
 * screen-size CULL drops what is too small to draw honestly; this GROWS what
 * has to stay visible anyway. modularRoadBirds.js has carried the same floor
 * since the flock was written, and its note is the argument: growing a thing
 * in world space to hold a constant screen size is a lie about its distance
 * that nobody has been able to see, and the alternative — fading it out -
 * loses the flock exactly where the flock is most of what you can see.
 *
 * Painted ambient FX has the same shape of problem. A butterfly is 8 cm wide,
 * which at twenty metres is four pixels: the painted wing is thrown away and
 * what is left is a speck that crawls. Either it is drawn bigger than life or
 * it is not worth drawing.
 */
export const worldSizeForPixels = /*#__PURE__*/ Fn(([pixels, dist, fy, viewportH]) => {
  return pixels.mul(dist).div(fy.mul(viewportH).max(1e-4));
});
