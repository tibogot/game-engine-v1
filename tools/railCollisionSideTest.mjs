/**
 * The guardrail collision proxy must push the car out from EITHER side.
 *
 * The proxy is an open sheet — one wall, no thickness — which looks like it
 * would let a car through from behind. It does not, and this pins down why:
 * the chassis only ever queries the solids BVH through `closestPointWithNormal`
 * (see modularRoadGround.js), and that re-orients the face normal toward the
 * query point, so the push-out direction is derived from which side you are on
 * rather than from the triangle's winding. Sidedness is a property of the QUERY
 * here, not of the mesh.
 *
 * Worth a test rather than a comment: "make it double-sided" is the obvious
 * reaction to an open sheet, and doing it would double the collision triangles
 * for nothing.
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

// The right-hand rail's traffic face, and a height mid-beam.
const hw = RP.width / 2;
const rw = Math.min(RP.railWidth, hw * 0.45);
const faceX = hw - rw * 0.5 - railParams.depth * 0.5; // = edgeAbs + zFace
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

console.log(`\ntraffic face of the right rail at x = ${faceX.toFixed(3)}\n`);

// From the TRACK (inboard, smaller x) → must be pushed back toward the track.
probe(faceX - 0.25, "from the track side ", -1);
// From BEHIND (outboard, larger x) → must be pushed back out, not through.
probe(faceX + 0.25, "from behind the rail", +1);

// And the same on the left-hand rail, where the signs mirror.
const leftFaceX = -faceX;
probe(leftFaceX + 0.25, "left rail, track side", +1);
probe(leftFaceX - 0.25, "left rail, behind   ", -1);

console.log(
  failed
    ? `\n${failed} check(s) failed`
    : "\nthe open sheet blocks from both sides — no need to double it",
);
process.exit(failed ? 1 : 0);
