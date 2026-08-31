// SOLID.sitNormalMaxY (0.45) discards any solid contact whose world normal is
// more than ~27 deg off vertical, as "a lid the hull can park on". Guardrails on
// a BANKED or ROLLED piece are rolled with the road, so their walls stop being
// vertical in world space. This measures how much of each piece's rail proxy
// falls the wrong side of that test.
import * as THREE from "three";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildPiece } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { SOLID } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadVehicle.js")).href)
  .catch(async () => ({ SOLID: { sitNormalMaxY: 0.45 } }));
const LIMIT = SOLID.sitNormalMaxY ?? 0.45;

const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();

console.log(`sitNormalMaxY = ${LIMIT}  (|n.y| above this is DISCARDED as a lid)\n`);
console.log("piece            tris  | max |n.y|   % discarded   verdict");
for (const id of ["straight","curve","slope","spiral","banked_climb","banktilt","loop_spiral","grade","scurve","half_pipe_slope"]) {
  let p;
  try { p = buildPiece(id, new THREE.Matrix4()); } catch { continue; }
  if (!p.railCollision) { console.log(`  ${id.padEnd(15)} — no proxy`); continue; }
  const g = p.railCollision.clone(); g.applyMatrix4(p.world);
  const pos = g.attributes.position, idx = g.index;
  const tris = idx ? idx.count / 3 : pos.count / 3;
  let maxNy = 0, bad = 0, total = 0;
  for (let t = 0; t < tris; t++) {
    const i0 = idx ? idx.getX(t*3) : t*3, i1 = idx ? idx.getX(t*3+1) : t*3+1, i2 = idx ? idx.getX(t*3+2) : t*3+2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac);
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    const ny = Math.abs(n.y);
    total++;
    if (ny > maxNy) maxNy = ny;
    if (ny > LIMIT) bad++;
  }
  const pct = total ? (100 * bad / total) : 0;
  console.log(`  ${id.padEnd(15)} ${String(Math.round(tris)).padStart(5)} | ${maxNy.toFixed(2).padStart(8)}   ${pct.toFixed(0).padStart(10)}%   ${pct > 20 ? "<<< RAIL GOES SOFT" : pct > 0 ? "partly" : "ok"}`);
}
