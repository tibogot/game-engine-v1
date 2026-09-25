// X-RAY SILHOUETTES — units seen through what hides them, as in Company of
// Heroes. GAME code, nam-rts only. Your ask (2026-09-25): "a way to see the
// units through buildings and foliage".
//
// Each unit is drawn a second time with this material, which paints ONLY
// where the unit is hidden: depth test GREATER, no depth write — the pixel
// passes where something already in the depth buffer is IN FRONT of the unit.
// No screen copy, no stencil: the depth buffer already knows.
//
// THE SELF-OCCLUSION PROBLEM, and the trick. A plain GREATER pass also paints
// a unit's rear parts where its own front hides them — a jeep would glow on
// itself. So the fragment's depth is written `lift` metres CLOSER to the camera
// (along its own view ray: its place on screen does not move) before the test:
// it now passes only where the occluder is at least `lift` in front of the
// unit — a wall, a hut, a canopy crown, not the unit's own turret. `lift` is
// sized to the unit (a soldier ~1 m, a tank ~3 m).
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
  Fn, abs, cameraFar, cameraNear, cameraPosition, dot, float, max, min, mix, normalView, normalize, pow,
  positionView, positionWorld, saturate, step, uniform, vec3, viewZToPerspectiveDepth,
} from "three/tsl";
import { drapeY } from "./terrainDrape.js";

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
 * The soldiers' depth lift, metres. 2.5, not 1.1: grass hiding a man stands
 * right against him, within a metre or two, and at 1.1 a squad in the tall
 * grass lit up blue (your call, 2026-09-25: buildings and trees only). A wall
 * or a crown that hides him is further in front than that.
 */
const uSoldierLift = uniform(2.5);
/** `enabled` switches every silhouette (?xray=0 boots with them off: the A/B). */
export const xrayParams = {
  uPlayer, uEnemy, uOpacity, uRim, uSoldierLift,
  /** The live heightmap (app.heightTexNode), set by the game before any unit is built. */
  heightTexNode: null,
  enabled: typeof location === "undefined" || new URLSearchParams(location.search).get("xray") !== "0",
};
export const xrayOn = () => xrayParams.enabled;

/**
 * @param {object} o
 *   teamNode     float node: 0 = player, 1 = enemy (per instance)
 *   lift         metres the depth is pulled toward the camera (see the header):
 *                a number, or a node (the soldiers' live uniform)
 *   positionNode optional: a material's own positionNode (the compute-skinned crowd)
 *   normalNode   optional: its view-space normal node (the crowd), else normalView
 */
export function createXrayMaterial({ teamNode, lift = 1.5, liftUp = 0, positionNode = null, normalNode = null }) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, side: THREE.FrontSide,
  });
  mat.name = "UnitXray";
  mat.depthFunc = THREE.GreaterDepth;
  mat.fog = false;
  mat.toneMapped = false;
  if (positionNode) mat.positionNode = positionNode;
  // The fragment's depth, `lift` metres nearer along its view ray, never past
  // the near plane. `liftUp` is the unit's HEIGHT: a part that far below its
  // own rotor blade or roof sits height / |ray.y| behind it along a sloping
  // ray — twice the height at the 30° zoomed-in pitch — so that half of the
  // lift grows as the camera looks flatter.
  mat.depthNode = Fn(() => {
    let d = float(lift);
    if (liftUp > 0) {
      const rayY = abs(normalize(positionWorld.sub(cameraPosition)).y);
      d = max(d, float(liftUp).div(max(rayY, float(0.35))));
    }
    const z = positionView.z.add(d).min(cameraNear.negate().mul(1.01));
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
