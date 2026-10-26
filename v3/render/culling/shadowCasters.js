/**
 * Shadow casters are culled against what their SHADOW can reach, not against
 * the camera alone.
 *
 * A tree just behind the camera is off screen, but its shadow lies on the
 * ground in front of you. Cull it with the camera frustum and that shadow
 * vanishes the moment the tree leaves the screen — measured under a tree in
 * the editor (2026-10-26): 3.6 % of the frame lost its canopy shadow.
 *
 * The rule: keep a caster when the segment from it to where its shadow meets
 * the ground (swept along the light, away from the sun) touches the view.
 * A caster on screen is kept by the same test — the sweep starts at it.
 *
 * Per-instance GPU culls need it (the leaf field). The trunk and chunked-leaf
 * culls do not, today: they drop whole 100 m chunks with a 12 m margin, and
 * no view lost a shadow even with a 10° evening sun (same pixel test). A finer
 * CPU cull would need the same sweep on its boxes.
 */
import { Fn, max } from "three/tsl";
import { scatterFrustumVisible } from "../scatter/gpuCull.js";

/** Longest shadow followed, metres along the light ray. A sun lower than this
 *  allows throws the rest of the shadow past what the near cascades draw. */
export const SHADOW_SWEEP_MAX = 80;

/** Lowest light height used (a sun on the horizon would sweep forever). */
const MIN_LIGHT_Y = 0.05;

/**
 * Is a caster sphere, or its shadow on the ground below it, on screen?
 *
 * The sweep runs from the sphere's centre down the light until it has dropped
 * to `groundY` (plus a slope margin: on a down-slope the shadow lands lower).
 * It is covered by TWO spheres, each half the sweep, which keeps it tighter
 * than one sphere round the whole thing on a long evening shadow. With
 * maxLen 0 it is exactly the plain frustum test of the caster sphere.
 *
 * @param center    vec3 — caster sphere centre, world
 * @param groundY   float — ground height under the caster
 * @param radius    float — caster sphere radius
 * @param lightDir  vec3 — unit vector TOWARD the light
 * @param maxLen    float — longest sweep, metres (SHADOW_SWEEP_MAX)
 * @param cameraMatrix, fx, fy, padX, padYNear, padYFar — as scatterFrustumVisible
 */
export const shadowSweepVisible = /*#__PURE__*/ Fn(([center, groundY, radius, lightDir, maxLen, cameraMatrix, fx, fy, padX, padYNear, padYFar]) => {
  const drop = center.y.sub(groundY).add(radius).add(4).max(0);
  const t = drop.div(lightDir.y.max(MIN_LIGHT_Y)).min(maxLen);
  const quarter = t.mul(0.25);
  const r = radius.add(quarter);
  const a = center.sub(lightDir.mul(quarter));
  const b = center.sub(lightDir.mul(quarter.mul(3)));
  return max(
    scatterFrustumVisible(a, cameraMatrix, fx, fy, r, padX, padYNear, padYFar),
    scatterFrustumVisible(b, cameraMatrix, fx, fy, r, padX, padYNear, padYFar),
  );
});
