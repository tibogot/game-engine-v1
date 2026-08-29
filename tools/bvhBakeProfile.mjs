// Where does RoadBvh.bakeFromMeshes actually spend its 52 ms?
//
// Three candidates, and the fix is different for each:
//   buffer assembly   → mechanical (typed arrays, no push, no accessors)
//   MeshBVH build     → algorithmic (incremental / two-level, or nothing)
//   the duplicate set → NOT removable, see tools/bvhWindingProbe.mjs
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { loadTrackFile } from "./loadTrackFile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { MeshBVH } = await import("three-mesh-bvh");
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

// Through loadTrackFile, not readFileSync: a v2 track stores each piece's
// params SPARSELY, and buildPiece reads them with no fallback. See that module.
const { track, rp, gp, pieces } = await loadTrackFile(
  ROOT, process.argv[2] ?? "games/modular-road-v3/rushline.json");

// Build the deck meshes the way bakeCollision does.
const meshes = [];
for (const e of pieces) {
  let b;
  try {
    b = KIT.buildPiece(e.id, new THREE.Matrix4().fromArray(e.connectorIn), e.pp, rp, gp, e.edges ?? true);
  } catch { continue; }
  const geo = b.deckCollision ?? b.geometry;
  const m = new THREE.Mesh(geo, null);
  m.matrixAutoUpdate = false;
  m.matrix.copy(b.world);
  m.updateMatrixWorld(true);
  meshes.push(m);
}
console.log(`${meshes.length} deck meshes`);

const _v = new THREE.Vector3();

/** Verbatim copy of the CURRENT bakeFromMeshes body, instrumented. */
function bakeCurrent(meshes) {
  const tA = performance.now();
  const positions = [];
  const indices = [];
  let vertexOffset = 0;
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const posAttr = geo?.getAttribute("position");
    if (!posAttr) continue;
    mesh.updateMatrixWorld(true);
    const m = mesh.matrixWorld;
    const idx = geo.getIndex();
    for (let i = 0; i < posAttr.count; i++) {
      _v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
      positions.push(_v.x, _v.y, _v.z);
    }
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vertexOffset);
    } else {
      for (let i = 0; i < posAttr.count; i++) indices.push(i + vertexOffset);
    }
    vertexOffset += posAttr.count;
  }
  const tB = performance.now();
  const origLen = indices.length;
  for (let i = 0; i < origLen; i += 3) indices.push(indices[i], indices[i + 2], indices[i + 1]);
  const tC = performance.now();
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  const tD = performance.now();
  const bvh = new MeshBVH(merged);
  const tE = performance.now();
  return {
    gather: tB - tA, duplicate: tC - tB, upload: tD - tC, bvh: tE - tD, total: tE - tA,
    tris: indices.length / 3, verts: positions.length / 3, bvhObj: bvh, geo: merged,
  };
}

const warm = bakeCurrent(meshes);
const runs = [];
for (let i = 0; i < 5; i++) runs.push(bakeCurrent(meshes));
const avg = (k) => runs.reduce((s, r) => s + r[k], 0) / runs.length;

console.log(`${warm.verts} verts → ${warm.tris} tris (duplicate set included)\n`);
console.log("CURRENT bakeFromMeshes, averaged over 5 runs:");
for (const k of ["gather", "duplicate", "upload", "bvh"]) {
  const ms = avg(k);
  console.log(`  ${k.padEnd(10)} ${ms.toFixed(1).padStart(7)} ms   ${(100 * ms / avg("total")).toFixed(0)}%`);
}
console.log(`  ${"TOTAL".padEnd(10)} ${avg("total").toFixed(1).padStart(7)} ms`);

// ── Does the TREE have to cost this much? ──────────────────────────────────
// 72% of the bake is `new MeshBVH()`, so the buffer work is not the lever.
// three-mesh-bvh exposes build knobs that trade construction time for query
// time; a collision tree rebuilt on every edit AND queried ~50k times a second
// sits somewhere specific on that curve, and nobody has measured where.
const { SAH, CENTER, AVERAGE } = await import("three-mesh-bvh");
const geo = warm.geo;
const opts = [
  ["default (CENTER, maxLeafSize 10)", {}],
  ["CENTER, maxLeafSize 20", { maxLeafSize: 20 }],
  ["CENTER, maxLeafSize 40", { maxLeafSize: 40 }],
  ["CENTER, maxLeafSize 80", { maxLeafSize: 80 }],
  ["AVERAGE", { strategy: AVERAGE }],
  ["SAH", { strategy: SAH }],
  ["indirect", { indirect: true }],
  ["indirect, maxLeafSize 40", { indirect: true, maxLeafSize: 40 }],
];

const trees = [];
for (const [label, o] of opts) trees.push([label, new MeshBVH(geo, o), o]);

// Queries first, and every tree is exercised once before ANY of them is timed —
// timing the first loop measures the JIT, not the tree (measured: it inflated
// the default's number 3x and made the results non-monotonic).
geo.computeBoundingBox();
const bb = geo.boundingBox;
const pts = [];
for (let i = 0; i < 20000; i++) {
  pts.push(new THREE.Vector3(
    bb.min.x + Math.random() * (bb.max.x - bb.min.x),
    bb.min.y + Math.random() * (bb.max.y - bb.min.y),
    bb.min.z + Math.random() * (bb.max.z - bb.min.z)));
}
const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
const probe = (bvh) => {
  let hits = 0;
  for (const p of pts) { target.distance = Infinity; if (bvh.closestPointToPoint(p, target, 0, 2)) hits++; }
  return hits;
};
for (let w = 0; w < 3; w++) for (const [, bvh] of trees) probe(bvh);

const results = [];
for (const [label, bvh, o] of trees) {
  let q = Infinity;
  for (let r = 0; r < 3; r++) { const t = performance.now(); probe(bvh); q = Math.min(q, performance.now() - t); }
  new MeshBVH(geo, o);
  let bms = Infinity;
  for (let r = 0; r < 3; r++) { const t = performance.now(); new MeshBVH(geo, o); bms = Math.min(bms, performance.now() - t); }
  results.push([label, bms, q]);
}

console.log("");
console.log("(best of 3 each, after warm-up)");
console.log("  " + "option".padEnd(34) + "build".padStart(9) + "20k queries".padStart(14));
for (const [label, b, q] of results) {
  console.log(`  ${label.padEnd(34)}${b.toFixed(1).padStart(7)} ms${q.toFixed(1).padStart(11)} ms`);
}
