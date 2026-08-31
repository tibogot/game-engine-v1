// Does the guardrail COLLISION proxy actually cover the visible rail?
//
// Reported: still driving through guardrails, notably on a climbing turn, at the
// HIGH end of the piece. Every previous rail test used STRAIGHT pieces only, so
// curved + sloped geometry has never been checked.
//
// Method: take the visible rail's own vertices, and for each one ask the baked
// SOLIDS tree how far away the nearest collision surface is. The proxy is a
// 0.38 m slab around the beam, so a vertex should always be within ~0.4 m of it.
// Anything much larger is rail you can see and drive through.
//
//   node tools/railProxyGapProbe.mjs
import * as THREE from "three";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

const PIECES = [
  "straight", "curve", "slope", "spiral", "banked_climb",
  "grade_in", "grade", "grade_out", "scurve", "loop_spiral", "banktilt",
];

console.log("piece            vis-tris  col-tris |  max gap   p99    over 0.5 m   verdict");
for (const id of PIECES) {
  let p;
  try {
    p = buildPiece(id, new THREE.Matrix4());
  } catch (e) {
    console.log(`  ${id.padEnd(14)} — buildPiece failed: ${e.message}`);
    continue;
  }
  if (!p.railGeometry) { console.log(`  ${id.padEnd(14)} — no visible rail`); continue; }
  if (!p.railCollision) { console.log(`  ${id.padEnd(14)} — NO COLLISION PROXY  <<<<`); continue; }

  const bvh = new RoadBvh();
  const m = new THREE.Mesh(p.railCollision, new THREE.MeshBasicMaterial());
  m.updateMatrixWorld(true);
  bvh.bakeFromMeshes([m]);
  if (!bvh.baked) { console.log(`  ${id.padEnd(14)} — proxy failed to bake  <<<<`); continue; }

  const pos = p.railGeometry.attributes.position;
  const gaps = [];
  const step = Math.max(1, Math.floor(pos.count / 4000)); // sample big meshes
  for (let i = 0; i < pos.count; i += step) {
    const r = bvh.closestPointToPoint(pos.getX(i), pos.getY(i), pos.getZ(i), 5.0);
    gaps.push(r ? r.distance : 99);
  }
  gaps.sort((a, b) => a - b);
  const max = gaps[gaps.length - 1];
  const p99 = gaps[Math.floor(gaps.length * 0.99)];
  const over = gaps.filter((d) => d > 0.5).length;
  const verdict = max > 1.0 ? "HOLE" : max > 0.5 ? "loose" : "ok";
  console.log(
    `  ${id.padEnd(14)} ${String(Math.round(pos.count / 3)).padStart(8)}`
    + ` ${String(Math.round(p.railCollision.index ? p.railCollision.index.count / 3 : pos.count / 3)).padStart(9)} |`
    + ` ${max.toFixed(2).padStart(7)} ${p99.toFixed(2).padStart(6)}`
    + ` ${String(over).padStart(11)}    ${verdict}`,
  );
}
console.log("\n  gap = distance from a VISIBLE rail vertex to the nearest COLLISION surface.");
console.log("  The proxy is a slab around the beam, so ~0.4 m is normal; 1 m+ is rail with");
console.log("  nothing behind it.");

/* ── CHAINS: the seams between pieces ──────────────────────────────────────
 * A single piece being covered says nothing about where two of them meet, and
 * each piece decimates its rail frames independently (see decimateFrames), so
 * a seam on a curve is where two chord approximations have to agree. */
const CHAINS = [
  ["climbing turn", ["straight", "spiral", "spiral", "straight"]],
  ["graded climb", ["straight", "grade_in", "grade", "grade_out", "straight"]],
  ["s-bend", ["straight", "scurve", "curve", "straight"]],
  ["banked climb", ["straight", "banked_climb", "banked_climb", "straight"]],
  ["mixed", ["straight", "curve", "slope", "spiral", "curve", "straight"]],
];

console.log("\n=== CHAINS (seams included) ===");
console.log("chain             pieces |  max gap    p99   over 0.5 m   verdict");
for (const [label, ids] of CHAINS) {
  let conn = new THREE.Matrix4();
  const railVis = [], railCol = [];
  let ok = true;
  for (const id of ids) {
    let p;
    try { p = buildPiece(id, conn); } catch { ok = false; break; }
    if (p.railGeometry) { const g = p.railGeometry.clone(); g.applyMatrix4(p.world); railVis.push(g); }
    if (p.railCollision) { const c = p.railCollision.clone(); c.applyMatrix4(p.world); railCol.push(c); }
    conn = p.connectorOut;
  }
  if (!ok || !railCol.length) { console.log(`  ${label.padEnd(16)} — could not build`); continue; }
  const bvh = new RoadBvh();
  const meshes = railCol.map((g) => { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.updateMatrixWorld(true); return m; });
  bvh.bakeFromMeshes(meshes);
  const gaps = [];
  for (const g of railVis) {
    const pos = g.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 3000));
    for (let i = 0; i < pos.count; i += step) {
      const r = bvh.closestPointToPoint(pos.getX(i), pos.getY(i), pos.getZ(i), 6.0);
      gaps.push(r ? r.distance : 99);
    }
  }
  gaps.sort((a, b) => a - b);
  const max = gaps[gaps.length - 1];
  const p99 = gaps[Math.floor(gaps.length * 0.99)];
  const over = gaps.filter((d) => d > 0.5).length;
  console.log(
    `  ${label.padEnd(16)} ${String(ids.length).padStart(6)} | ${max.toFixed(2).padStart(7)}`
    + ` ${p99.toFixed(2).padStart(6)} ${String(over).padStart(11)}    ${max > 1 ? "HOLE" : max > 0.5 ? "loose" : "ok"}`,
  );
}
