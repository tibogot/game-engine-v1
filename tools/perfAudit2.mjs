// Where does buildPiece's time and vertex budget actually go?
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const RAIL = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadRail.js")).href);

const track = JSON.parse(readFileSync(join(ROOT, "games/modular-road-v3/rushline.json"), "utf8"));
const rp = { ...KIT.roadParams, ...(track.roadParams ?? {}) };
const gp = { ...KIT.guardrailParams, ...(track.guardrailParams ?? {}) };

// ── 1. One ghost refresh = one buildPiece. How long, for the common pieces?
console.log("=== single buildPiece cost (what refreshGhost pays EVERY gizmo-drag frame)");
for (const id of ["straight", "curve", "banked", "loop", "quarterpipe"]) {
  const e = track.pieces.find((p) => p.id === id);
  if (!e) continue;
  const conn = new THREE.Matrix4().fromArray(e.connectorIn);
  KIT.buildPiece(id, conn, e.pp, rp, gp, true); // warm
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) KIT.buildPiece(id, conn, e.pp, rp, gp, true);
  const withRail = (performance.now() - t0) / 20;
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) KIT.buildPiece(id, conn, e.pp, rp, gp, false); // edges off = no rail
  const noRail = (performance.now() - t1) / 20;
  console.log(`  ${id.padEnd(14)} full ${withRail.toFixed(2)} ms   deck-only(edges:false) ${noRail.toFixed(2)} ms   rail share ${(100 * (1 - noRail / withRail)).toFixed(0)}%`);
}

// ── 2. Rail vertex budget: what is the beam vs the posts vs the bolts?
console.log("\n=== guardrail vertex budget on ONE 32 m straight");
const e = track.pieces.find((p) => p.id === "straight");
const conn = new THREE.Matrix4().fromArray(e.connectorIn);
const b = KIT.buildPiece("straight", conn, e.pp, rp, gp, true);
const deckV = b.geometry.getAttribute("position").count;
const railV = b.railGeometry.getAttribute("position").count;
console.log(`  deck ${deckV} verts   rail ${railV} verts   ratio ${(railV / deckV).toFixed(1)}×`);

const P = RAIL.railParams;
const save = { ...P };
const rebuild = () => KIT.buildPiece("straight", conn, e.pp, rp, gp, true)
  .railGeometry.getAttribute("position").count;
const variants = [
  ["baseline", {}],
  ["bolts:false", { bolts: false }],
  ["basePlate:false", { basePlate: false }],
  ["posts:false", { posts: false }],
  ["beadSeg 6->3", { beadSeg: 3 }],
  ["bendSeg 2->1", { bendSeg: 1 }],
  ["backAmp 0 (flat back)", { backAmp: 0 }],
  ["frameAngle 7->12", { frameAngle: 12 }],
  ["postSpacing 3.6->5", { postSpacing: 5 }],
  ["bolts+basePlate off, beadSeg 3", { bolts: false, basePlate: false, beadSeg: 3 }],
];
const base = rebuild();
for (const [label, over] of variants) {
  Object.assign(P, save, over);
  const v = rebuild();
  console.log(`  ${label.padEnd(30)} ${String(v).padStart(6)} verts   ${v === base ? "" : ((v - base) / base * 100).toFixed(0) + "%"}`);
}
Object.assign(P, save);

// ── 3. Cost of the mirror rail that is built whether or not it is used.
console.log("\n=== railMirrorGeometry — built on EVERY buildPiece, drawn only when wet+rails-in-mirror");
let mv = 0, rv = 0;
for (const p of track.pieces) {
  try {
    const bb = KIT.buildPiece(p.id, new THREE.Matrix4().fromArray(p.connectorIn), p.pp, rp, gp, p.edges ?? true);
    if (bb.railMirrorGeometry) mv += bb.railMirrorGeometry.getAttribute("position").count;
    if (bb.railGeometry) rv += bb.railGeometry.getAttribute("position").count;
  } catch {}
}
console.log(`  rail ${rv} verts, mirror copy ${mv} verts held in userData on every piece`);
const bytes = (v) => ((v * (3 + 3 + 2) * 4) / 1024 / 1024).toFixed(2);
console.log(`  ≈ ${bytes(mv)} MB of CPU-side attribute data for a feature that is off by default`);
