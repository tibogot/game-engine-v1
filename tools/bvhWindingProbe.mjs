// Does dropping the winding-flipped duplicate set change any BVH ANSWER?
//
// ── VERDICT: YES. DO NOT REMOVE THE DUPLICATE SET. ─────────────────────────
//
// It looks like pure waste — it doubles every BVH's triangle count, and the
// reasoning for removing it is superficially airtight: raycastFirst already
// passes THREE.DoubleSide, closest-point is a distance question that winding
// cannot enter, spherecast swaps ta/tb so either sign of d·n works, and every
// consumer re-orients the normal for its own frame anyway. All of that is true,
// and the conclusion drawn from it is still wrong.
//
// MEASURED here, same geometry built both ways:
//     raycast        1875 probes   0 hit/miss, 0 distance disagreements
//     closest-point  2888 probes   319 hit/miss, 35 distance (max 4.11!)
// A CONTROL — identical geometry built twice — gives 0/0, so the differences
// are caused by the duplicate set and not by BVH construction being unstable.
//
// Raycasts really are unaffected; it is CLOSEST-POINT that changes, which is the
// query deck contact and the whole solids resolver are built on. Removing the
// duplicates turned tools/chaseFramingTest.mjs from green to two failures (the
// camera swung ahead of the car and through the road) because the car's contact
// answers changed underneath it.
//
// The mechanism was not chased down — three-mesh-bvh's closest-point traversal
// prunes against a running best, and the two trees are not the same tree. What
// matters is that the halved triangle count is NOT free, and the thing it costs
// is collision correctness.
//
// An instrument, not a pass/fail test. Re-run it before believing otherwise.
import * as THREE from "three";
import { MeshBVH, getTriangleHitPointInfo } from "three-mesh-bvh";

const _hitInfo = {};

/** Minimal stand-in for RoadBvh, with the duplicate set switchable. */
function build(geoSrc, duplicate) {
  const pos = [...geoSrc.pos];
  const idx = [...geoSrc.idx];
  if (duplicate) {
    const n = idx.length;
    for (let i = 0; i < n; i += 3) idx.push(idx[i], idx[i + 2], idx[i + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return { bvh: new MeshBVH(g), geo: g, tris: idx.length / 3 };
}

function normalAt(rb, point, faceIndex, out) {
  if (faceIndex < 0) { out.set(0, 1, 0); return out; }
  getTriangleHitPointInfo(point, rb.geo, faceIndex, _hitInfo);
  out.copy(_hitInfo.face.normal);
  if (out.lengthSq() < 1e-12) out.set(0, 1, 0); else out.normalize();
  return out;
}

// A ramp + an overhang, so rays hit from both above and below — the case the
// duplicate set was supposedly for.
const src = (() => {
  const g = new THREE.PlaneGeometry(40, 40, 8, 8).rotateX(-Math.PI / 2);
  const g2 = new THREE.BoxGeometry(6, 1, 20).translate(0, 6, 0);
  const merged = [g, g2];
  const pos = [], idx = [];
  let off = 0;
  for (const gg of merged) {
    const p = gg.getAttribute("position");
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const ix = gg.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + off);
    else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  return { pos, idx };
})();

const A = build(src, true);   // with duplicates (old)
const B = build(src, false);  // without (new)
console.log(`triangles: with-duplicate ${A.tris}, without ${B.tris}`);

const ray = new THREE.Ray();
const nA = new THREE.Vector3(), nB = new THREE.Vector3();
let rays = 0, distDiff = 0, normSignDiff = 0, missMismatch = 0, maxDist = 0;

for (let x = -18; x <= 18; x += 1.5) {
  for (let z = -18; z <= 18; z += 1.5) {
    for (const [oy, dy] of [[20, -1], [-5, 1], [3, -1]]) { // above-down, below-up, between
      rays++;
      ray.origin.set(x, oy, z);
      ray.direction.set(0, dy, 0);
      const ha = A.bvh.raycastFirst(ray, THREE.DoubleSide);
      const hb = B.bvh.raycastFirst(ray, THREE.DoubleSide);
      if (!!ha !== !!hb) { missMismatch++; continue; }
      if (!ha) continue;
      const dd = Math.abs(ha.distance - hb.distance);
      if (dd > 1e-6) { distDiff++; if (dd > maxDist) maxDist = dd; }
      normalAt(A, ha.point, ha.faceIndex, nA);
      normalAt(B, hb.point, hb.faceIndex, nB);
      if (nA.dot(nB) < 0.999) normSignDiff++;
    }
  }
}
console.log(`\nRAYCAST over ${rays} probes`);
console.log(`  hit/miss disagreements : ${missMismatch}`);
console.log(`  distance disagreements : ${distDiff}  (max ${maxDist.toExponential(2)})`);
console.log(`  normal DIRECTION differs: ${normSignDiff}   <- flipped winding shows up here`);

// Closest point — winding-independent by construction, so this should be exact.
const tgtA = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
const tgtB = { point: new THREE.Vector3(), distance: Infinity, faceIndex: -1 };
let cp = 0, cpMiss = 0, cpDist = 0, cpMaxDist = 0, cpPoint = 0, cpMaxPoint = 0;
const pa = new THREE.Vector3(), pb = new THREE.Vector3();
for (let x = -18; x <= 18; x += 2) {
  for (let y = -2; y <= 9; y += 1.5) {
    for (let z = -18; z <= 18; z += 2) {
      cp++;
      tgtA.distance = Infinity; tgtB.distance = Infinity;
      const p = new THREE.Vector3(x, y, z);
      const ra = A.bvh.closestPointToPoint(p, tgtA, 0, 5);
      const rb = B.bvh.closestPointToPoint(p, tgtB, 0, 5);
      if (!!ra !== !!rb) { cpMiss++; continue; }
      if (!ra) continue;
      const dd = Math.abs(tgtA.distance - tgtB.distance);
      if (dd > 1e-6) { cpDist++; if (dd > cpMaxDist) cpMaxDist = dd; }
      pa.copy(tgtA.point); pb.copy(tgtB.point);
      const pd = pa.distanceTo(pb);
      if (pd > 1e-6) { cpPoint++; if (pd > cpMaxPoint) cpMaxPoint = pd; }
    }
  }
}
console.log(`\nCLOSEST-POINT over ${cp} probes`);
console.log(`  hit/miss disagreements : ${cpMiss}`);
console.log(`  DISTANCE differs       : ${cpDist}  (max ${cpMaxDist.toExponential(2)})`);
console.log(`  POINT differs          : ${cpPoint}  (max ${cpMaxPoint.toExponential(2)})`);
console.log(`  (a differing POINT at the same DISTANCE is a tie between two`);
console.log(`   equidistant triangles — geometrically the same answer.)`);
