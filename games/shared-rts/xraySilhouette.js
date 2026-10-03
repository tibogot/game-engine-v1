// X-RAY SILHOUETTES — units seen through what hides them, as in Company of
// Heroes. GAME code, both RTS games. Your ask (2026-09-25): "a way to see the
// units through buildings and foliage".
//
// Each unit is drawn a second time with this material, which paints ONLY
// where the unit is hidden: depth test GREATER, no depth write — the pixel
// passes where something already in the depth buffer is IN FRONT of the unit.
//
// ONLY THE WORLD HIDES A UNIT (your note, 2026-09-30: "units should not x-ray
// each other" — as in CoH, a man behind a tank or behind his mate is simply
// behind him). The trick is the DRAW ORDER, no stencil (the post chain samples
// the scene depth, which a depth-stencil texture cannot give it):
//   world opaque (terrain 8, decals 9, rivers 10 …)
//   → the silhouettes, XRAY_ORDER: the depth buffer holds the world ONLY
//   → the units themselves, UNIT_ORDER: a unit seen paints over any
//     silhouette behind it, and the depth test hides the parts it covers.
// So a unit never glows through another unit, nor through ITSELF (its own
// front is not in the depth buffer yet when its silhouette is drawn — the old
// per-unit depth "lift" sized to a Huey's height is gone). Silhouettes are
// opaque-list draws with CustomBlending (a NormalBlending material that is
// not `transparent` gets its alpha forced to 1).
//
// `lift`: the fragment's depth is still pulled a little toward the camera
// (along its own view ray) before the test, so only an occluder at least that
// far in front counts — a wall, a hut, a crown; not the grass at a man's
// knees, nor the ground his boots sink into.
//
// Look: a flat team colour (blue ours, red theirs), see-through, with a
// brighter rim so it reads as "behind something" rather than "on top".
// Enemies only ever get one while they are SPOTTED: the unit renderer does not
// draw a unit the fog of war hides, so there is nothing to silhouette.
//
// NOT THROUGH THE GROUND (your note, 2026-09-26: with the free camera every
// unit showed through the hills). The depth buffer cannot tell a hill from a
// hut, so each silhouette pixel also walks its line of sight back toward the
// camera over the heightmap (12 samples, dense near the unit): if the ray
// passes UNDER the terrain, a hill hides the unit and there is no silhouette.
// Buildings, trees and smoke still get one.
//
// Cost: one extra draw per instanced unit part and one for the soldier crowd;
// fragment work only where a unit is actually hidden (+ 12 height taps there).
// Writing depth disables early-z for these draws — only on unit pixels.
import * as THREE from "three";
import {
  Fn, abs, cameraFar, cameraNear, cameraPosition, dot, float, max, min, mix, normalView, pow,
  positionView, positionWorld, saturate, step, uniform, vec3, viewZToPerspectiveDepth,
} from "three/tsl";
import { drapeY } from "./terrainDrape.js";
import { RENDER_ORDER } from "./renderOrder.js";

/** Opaque draw order: after the world, before the units (see the header). */
export const XRAY_ORDER = RENDER_ORDER.XRAY;
export const UNIT_ORDER = RENDER_ORDER.UNITS;

export const XRAY = {
  player: new THREE.Color(0.32, 0.62, 1.0),
  enemy: new THREE.Color(1.0, 0.32, 0.26),
  opacity: 0.42,
  rim: 0.45,
};

/** Shared by every silhouette: the panel (or a console) can tune them live. */
const uPlayer = uniform(XRAY.player.clone());
const uEnemy = uniform(XRAY.enemy.clone());
const uOpacity = uniform(XRAY.opacity);
const uRim = uniform(XRAY.rim);
/**
 * The depth lift, metres, every unit's (soldiers and vehicles). 2.5, not 1.1: grass hiding a man stands
 * right against him, within a metre or two, and at 1.1 a squad in the tall
 * grass lit up blue (your call, 2026-09-25: buildings and trees only). A wall
 * or a crown that hides him is further in front than that.
 */
const uLift = uniform(2.5);
/** `enabled` switches every silhouette (?xray=0 boots with them off: the A/B). */
export const xrayParams = {
  uPlayer, uEnemy, uOpacity, uRim, uLift,
  /** The live heightmap (app.heightTexNode), set by the game before any unit is built. */
  heightTexNode: null,
  enabled: typeof location === "undefined" || new URLSearchParams(location.search).get("xray") !== "0",
};
export const xrayOn = () => xrayParams.enabled;

/**
 * @param {object} o
 *   teamNode     float node: 0 = player, 1 = enemy (per instance)
 *   lift         metres the depth is pulled toward the camera (see the header):
 *                a number, or a node; default the shared live uniform
 *   positionNode optional: a material's own positionNode (the compute-skinned crowd)
 *   normalNode   optional: its view-space normal node (the crowd), else normalView
 */
export function createXrayMaterial({ teamNode, lift = uLift, positionNode = null, normalNode = null }) {
  // In the OPAQUE list (drawn before the units, see the header), blended.
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: false, depthWrite: false, depthTest: true, side: THREE.FrontSide,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.name = "UnitXray";
  mat.depthFunc = THREE.GreaterDepth;
  mat.fog = false;
  mat.toneMapped = false;
  if (positionNode) mat.positionNode = positionNode;
  // The fragment's depth, `lift` metres nearer along its view ray, never past
  // the near plane.
  mat.depthNode = Fn(() => {
    const z = positionView.z.add(lift).min(cameraNear.negate().mul(1.01));
    return viewZToPerspectiveDepth(z, cameraNear, cameraFar);
  })();
  const n = normalNode ?? normalView;
  const rim = pow(saturate(float(1).sub(abs(dot(n, vec3(0, 0, 1))))), float(2));
  const team = mix(vec3(uPlayer), vec3(uEnemy), teamNode);
  // Not over 1: unlit and not tone mapped, a brighter blue clips to white.
  mat.colorNode = team.mul(mix(float(0.7), float(1.0), rim.mul(uRim.mul(2)).min(1)));
  let alpha = max(uOpacity, float(0)).add(rim.mul(uRim)).min(0.9);
  const htex = xrayParams.heightTexNode;
  if (htex) {
    // A hill between the unit and the camera: walk the line of sight from 2 m
    // off the unit (its own feet on a slope are not a hill) out to 200 m,
    // samples bunched near the unit where a crest usually is.
    const P = positionWorld, D = cameraPosition.sub(positionWorld);
    const len = D.length().max(1e-3);
    const reach = min(len, float(200)).sub(2).max(0);
    let occ = float(0);
    const N = 12;
    for (let k = 1; k <= N; k++) {
      const f = float(2).add(reach.mul((k / N) ** 2)).div(len);
      const Q = P.add(D.mul(f));
      occ = max(occ, step(Q.y.add(0.4), drapeY(htex, Q.x, Q.z)));
    }
    alpha = alpha.mul(float(1).sub(occ));
  }
  mat.opacityNode = alpha;
  return mat;
}
