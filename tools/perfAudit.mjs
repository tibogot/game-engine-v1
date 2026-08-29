// Throwaway measurement harness for the modular-road-v3 perf audit.
// Builds every piece of a real saved track and reports vertex/geometry cost.
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { loadTrackFile } from "./loadTrackFile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const KIT = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

const trackFile = process.argv[2] ?? "games/modular-road-v3/rushline.json";
// Through loadTrackFile, not readFileSync: a v2 track stores each piece's
// params SPARSELY, and buildPiece reads them with no fallback. See that module.
const { rp, gp, pieces } = await loadTrackFile(ROOT, trackFile);

const roles = ["geometry", "railGeometry", "shellGeometry", "decorGeometry", "glassGeometry"];
const totals = Object.fromEntries(roles.map((r) => [r, { verts: 0, tris: 0, n: 0 }]));
let collisionVerts = 0, mirrorVerts = 0;
const perId = new Map();
const shapeKeys = new Map();

const t0 = performance.now();
for (const e of pieces) {
  const conn = new THREE.Matrix4().fromArray(e.connectorIn);
  let built;
  try {
    built = KIT.buildPiece(e.id, conn, e.pp, rp, gp, e.edges ?? true);
  } catch (err) { console.log("skip", e.id, err.message); continue; }
  const key = e.id + "|" + JSON.stringify(e.pp) + "|" + (e.edges ?? true);
  shapeKeys.set(key, (shapeKeys.get(key) ?? 0) + 1);
  let pieceVerts = 0;
  for (const r of roles) {
    const g = built[r];
    if (!g) continue;
    const v = g.getAttribute("position").count;
    const t = g.getIndex() ? g.getIndex().count / 3 : v / 3;
    totals[r].verts += v; totals[r].tris += t; totals[r].n++;
    pieceVerts += v;
  }
  for (const r of ["deckCollision", "railCollision"]) {
    if (built[r]) collisionVerts += built[r].getAttribute("position").count;
  }
  if (built.railMirrorGeometry) mirrorVerts += built.railMirrorGeometry.getAttribute("position").count;
  const cur = perId.get(e.id) ?? { n: 0, verts: 0 };
  cur.n++; cur.verts += pieceVerts; perId.set(e.id, cur);
}
const t1 = performance.now();

console.log(`\n=== ${trackFile} — ${pieces.length} pieces`);
console.log(`full rebuildAll (no reuse) buildPiece time: ${(t1 - t0).toFixed(0)} ms\n`);
let V = 0, T = 0, M = 0;
for (const r of roles) {
  const s = totals[r];
  if (!s.n) continue;
  V += s.verts; T += s.tris; M += s.n;
  console.log(`  ${r.padEnd(16)} meshes ${String(s.n).padStart(3)}  verts ${String(s.verts).padStart(8)}  tris ${String(Math.round(s.tris)).padStart(8)}`);
}
console.log(`  ${"COLLISION".padEnd(16)}                 verts ${String(collisionVerts).padStart(8)}`);
console.log(`  ${"MIRROR RAIL".padEnd(16)}                 verts ${String(mirrorVerts).padStart(8)}`);
console.log(`\n  RENDER TOTAL: ${V} verts, ${Math.round(T)} tris, ${M} sub-meshes`);

console.log(`\n  distinct (id+params+edges) shapes: ${shapeKeys.size} of ${pieces.length} pieces`);
const dupes = [...shapeKeys.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
for (const [k, n] of dupes.slice(0, 8)) console.log(`    ×${n}  ${k.slice(0, 90)}`);

console.log(`\n  per piece id (verts across all roles):`);
for (const [id, s] of [...perId.entries()].sort((a, b) => b[1].verts - a[1].verts)) {
  console.log(`    ${id.padEnd(22)} ×${String(s.n).padStart(2)}  ${String(s.verts).padStart(7)} verts  (${Math.round(s.verts / s.n)}/piece)`);
}
