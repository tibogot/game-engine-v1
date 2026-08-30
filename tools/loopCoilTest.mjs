// The compact looping's feet sit 16 m apart under a planar ring. The offset
// tile is the same generator with the sideways gap opened to several road
// widths — Trackmania's open looping. Stretch 0 must keep the compact shape
// exactly, including the lead-out, or every saved loop moves.
import * as THREE from "three";

const kit = await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { buildPiece, pieceParams, initialConnector } = kit;
const { CATEGORY_PRESETS } = await import(
  new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url).href);

const DEF = { ...pieceParams };
const I = initialConnector();
let fail = 0;
const ok = (c, label, detail = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!c) fail++;
};

const compact = CATEGORY_PRESETS.loop.find((t) => t.id === "looping_full");
const offset = CATEGORY_PRESETS.loop.find((t) => t.id === "looping_offset");

const exitOf = (params) => {
  const p = buildPiece("loop", I.clone(), { ...DEF, ...params }, undefined, undefined, false);
  return new THREE.Vector3().setFromMatrixPosition(p.connectorOut);
};
const geomOf = (params) => {
  const p = buildPiece("loop", I.clone(), { ...DEF, ...params }, undefined, undefined, false);
  return p.geometry.getAttribute("position");
};

console.log("\n1. THE COMPACT LOOPING IS UNCHANGED\n");

ok(!!compact, "Loop tab still has the compact Looping tile");
ok(!!offset, "Loop tab has an Offset looping tile");
ok(offset?.base === "loop" && compact?.base === "loop",
  "both tiles ride the same loop generator — no new piece type");
ok((compact?.params.loopStretch ?? 0) === 0, "compact tile asks for stretch 0");
ok((offset?.params.loopStretch ?? 0) === 0,
  "offset tile keeps stretch 0 — stretching along the track is what shrunk the hole");
ok((offset?.params.loopOffset ?? 0) > (compact?.params.loopOffset ?? 0) * 2,
  "offset tile's sideways gap is more than twice the compact looping's",
  `compact ${compact?.params.loopOffset}  offset ${offset?.params.loopOffset}`);
ok((offset?.params.loopSpread ?? 1) === 0, "offset tile is an even helix (spread 0), not feet slid apart");
ok(!CATEGORY_PRESETS.loop.some((t) => t.base === "loop_half" && (t.params.loopOffset ?? 16) > 20),
  "no offset half tile (not asked for yet)");

const a = geomOf({ loopHalf: "full", loopStretch: 0 });
const b = geomOf({ loopHalf: "full" }); // default stretch is 0
ok(a.count === b.count, "stretch 0 matches the default loop's vertex count",
  `${a.count} vs ${b.count}`);
let same = a.count === b.count;
if (same) {
  for (let i = 0; i < a.array.length; i++) {
    if (Math.abs(a.array[i] - b.array[i]) > 1e-9) { same = false; break; }
  }
}
ok(same, "stretch 0 is byte-identical to omitting the param");

console.log("\n2. THE OFFSET OPENS A SIDEWAYS GAP — THE CIRCLE STAYS FULL\n");

const compactExit = exitOf(compact.params);
const offsetExit = exitOf(offset.params);
ok(Math.abs(compactExit.y) < 0.05, "compact exit stays on the floor",
  `y=${compactExit.y.toFixed(3)}`);
ok(Math.abs(offsetExit.y) < 0.05, "offset exit stays on the floor",
  `y=${offsetExit.y.toFixed(3)}`);
ok(Math.abs(offsetExit.z - compactExit.z) < 1,
  "offset exit is at the same depth as the compact looping (the ring did not flatten)",
  `compact z=${compactExit.z.toFixed(1)}  offset z=${offsetExit.z.toFixed(1)}`);
ok(Math.abs(offsetExit.x) > Math.abs(compactExit.x) * 2,
  "offset exit is much further sideways than the compact looping",
  `compact x=${compactExit.x.toFixed(1)}  offset x=${offsetExit.x.toFixed(1)}`);

console.log("\n3. FEET STAY FLAT — the exit connector is level\n");

const built = buildPiece("loop", I.clone(), { ...DEF, ...offset.params }, undefined, undefined, false);
const up = new THREE.Vector3().setFromMatrixColumn(built.connectorOut, 1);
const fwd = new THREE.Vector3().setFromMatrixColumn(built.connectorOut, 2);
ok(up.y > 0.98, "exit up is world-up (the lead-out is a flat foot)",
  `up=(${up.x.toFixed(3)}, ${up.y.toFixed(3)}, ${up.z.toFixed(3)})`);
ok(Math.abs(fwd.y) < 0.05, "exit heading is level",
  `fwd.y=${fwd.y.toFixed(3)}`);

console.log("");
if (fail) {
  console.log(`${fail} FAIL`);
  process.exit(1);
}
console.log("all passed");
