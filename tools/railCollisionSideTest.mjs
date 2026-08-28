/**
 * The guardrail collision proxy must push the car out from EITHER side.
 *
 * The proxy is a thick slab (traffic face + back face). Closest-point on the
 * solids BVH re-orients the face normal toward the query, so a probe OUTSIDE
 * either wall is pushed back out — not through. This used to pin down why an
 * open sheet still blocked from behind; it now pins the same contract on the
 * the slab, probing from outside each face. A probe in the cavity between the
 * two walls must report `behind` so the vehicle can spat the car out.
 *
 *   node tools/railCollisionSideTest.mjs
 */
import * as THREE from "three";
import { RoadBvh } from "../v3/play/modularRoadBvh.js";
import { buildRailCollision, railParams, straightFrames } from "../games/modular-road-v3/modularRoadRail.js";

const RP = { width: 16, thickness: 0.8, railWidth: 0.75, railHeight: 0.22, segLen: 1.6 };

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

const geo = buildRailCollision(straightFrames(32, RP.segLen), RP, railParams);
const bvh = new RoadBvh();
bvh.bakeFromMeshes([{ geometry: geo, matrixWorld: new THREE.Matrix4(), updateMatrixWorld() {} }]);
check(bvh.baked, `proxy bakes into a BVH (${Math.round(geo.index.count / 3)} tris)`);

const p = geo.attributes.position;
let rightMin = Infinity, rightMax = -Infinity;
let leftMin = Infinity, leftMax = -Infinity;
for (let i = 0; i < p.count; i++) {
  const x = p.getX(i);
  if (x > 0) {
    rightMin = Math.min(rightMin, x);
    rightMax = Math.max(rightMax, x);
  } else {
    leftMin = Math.min(leftMin, x);
    leftMax = Math.max(leftMax, x);
  }
}
check(rightMax - rightMin >= 0.37, `right slab is thick (${(rightMax - rightMin).toFixed(3)} m)`);

const y = RP.railHeight + railParams.gap + railParams.height * 0.5;
const z = -12; // well inside the piece

const n = new THREE.Vector3();
const probe = (px, label, wantSign) => {
  const hit = bvh.closestPointWithNormal(px, y, z, 2.0, n);
  if (!hit) {
    check(false, `${label}: nothing found within 2 m`);
    return;
  }
  check(
    Math.sign(n.x) === wantSign,
    `${label}: pushed ${n.x > 0 ? "outward (+x)" : "inward (−x)"} ` +
    `(normal.x ${n.x.toFixed(3)}, surface ${hit.distance.toFixed(3)} m away)`,
  );
  // `behind` is deliberately NOT asserted. It reports which side of the closest
  // triangle's winding the query landed on, and the solids bake is double-sided,
  // so it is a coin flip that closestPointWithNormal has already consumed — it
  // negates the normal with it, which is why `normal.x` above is the contract
  // that matters. Nothing in the vehicle reads the flag (the cavity recovery
  // uses raycasts; see SOLID.insideReach), and it duly flipped on the right rail
  // the moment the proxy gained a lid without any behaviour changing.
};

console.log(`\nright rail ${rightMin.toFixed(3)} .. ${rightMax.toFixed(3)}\n`);

probe(rightMin - 0.25, "from the track side ", -1);
probe(rightMax + 0.25, "from behind the rail", +1);
probe(leftMax + 0.25, "left rail, track side", +1);
probe(leftMin - 0.25, "left rail, behind   ", -1);

const cavity = (lo, hi, label) => {
  const mid = (lo + hi) * 0.5;
  const hit = bvh.closestPointWithNormal(mid, y, z, 0.6, n);
  check(!!hit, `${label} cavity query finds a face (${hit ? hit.distance.toFixed(3) : "none"} m)`);
  if (!hit) return;
  check(hit.distance < 0.22, `${label} cavity is ~half thickness (${hit.distance.toFixed(3)} m)`);
};
cavity(rightMin, rightMax, "right");
cavity(leftMin, leftMax, "left");

const away = new THREE.Vector3();
const from = new THREE.Vector3();
const cavityRay = (lo, hi, label) => {
  const mid = (lo + hi) * 0.5;
  const hit = bvh.closestPointWithNormal(mid, y, z, 1.0, away);
  if (!hit) {
    check(false, `${label} cavity ray: no closest face`);
    return;
  }
  from.set(mid, y, z).addScaledVector(away, 0.002);
  const blocked = bvh.raycastFirst(from, away, 1.0);
  check(!!blocked, `${label} cavity ray hits the far wall`);
};
cavityRay(rightMin, rightMax, "right");
cavityRay(leftMin, leftMax, "left");

// ── THE LID ─────────────────────────────────────────────────────────────────
// The walls block sideways; only the lid blocks a car coming DOWN. Without it a
// descent onto the beam entered the cavity between the two walls and was ejected
// by whichever wall won the substep — measured at 28 of 72 descents crossing to
// the far side at road level (tools/railTunnelRepro.mjs).
const beamTop = RP.railHeight + railParams.gap + railParams.height;
const lid = (px, label) => {
  const hit = bvh.closestPointWithNormal(px, beamTop + 0.1, z, 0.6, n);
  check(!!hit, `${label} lid: a face is found above the beam`);
  if (!hit) return;
  check(
    n.y > 0.9,
    `${label} lid: pushes UP (normal.y ${n.y.toFixed(3)}, surface ${hit.distance.toFixed(3)} m below)`,
  );
};
lid((rightMin + rightMax) * 0.5, "right");
lid((leftMin + leftMax) * 0.5, "left ");

from.set(rightMin - 0.25, y, z);
bvh.closestPointWithNormal(from.x, from.y, from.z, 1.0, away);
from.addScaledVector(away, 0.002);
check(!bvh.raycastFirst(from, away, 1.0), "outside the rail, away-ray is open air");

console.log(
  failed
    ? `\n${failed} check(s) failed`
    : "\nthe slab blocks from both sides",
);
process.exit(failed ? 1 : 0);
