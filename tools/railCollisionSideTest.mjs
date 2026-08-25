/**
 * The guardrail collision proxy must push the car out from EITHER side.
 *
 * The proxy is a thick slab (traffic face + back face). Closest-point on the
 * solids BVH re-orients the face normal toward the query, so a probe OUTSIDE
 * either wall is pushed back out — not through. This used to pin down why an
 * open sheet still blocked from behind; it now pins the same contract on the
 * slab, probing from outside each face (inside the volume is a different
 * question, and the thickness is what keeps a fast car from getting there).
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
};

console.log(`\nright rail ${rightMin.toFixed(3)} .. ${rightMax.toFixed(3)}\n`);

probe(rightMin - 0.25, "from the track side ", -1);
probe(rightMax + 0.25, "from behind the rail", +1);
probe(leftMax + 0.25, "left rail, track side", +1);
probe(leftMin - 0.25, "left rail, behind   ", -1);

console.log(
  failed
    ? `\n${failed} check(s) failed`
    : "\nthe slab blocks from both sides",
);
process.exit(failed ? 1 : 0);
