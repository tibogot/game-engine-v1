// Constant-section straights only keep the two end frames.
//
// A prism is defined by its entry and exit. Extra stations every 1.6 m were
// copies of the same ring. Curves, morphing entries, and bank in/out still
// step — their heading or profile actually changes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIT = join(ROOT, "games/modular-road-v3/modularRoadKit.js");
const KIT_SRC = readFileSync(KIT, "utf8");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const { buildPiece, initialConnector, pieceParams } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);

const pp = (extra = {}) => ({ ...pieceParams, ...extra });
const framesOf = (id, extra = {}) =>
  buildPiece(id, initialConnector(), pp(extra)).frames.length;

console.log("— prisms are two frames —");
for (const [id, extra] of [
  ["straight", { straightLength: 32 }],
  ["straight", { straightLength: 14 }],
  ["platform", {}],
  ["narrow", {}],
  ["tube", { straightLength: 26 }],
  ["tube", { straightLength: 52 }],
  ["half_tube", { straightLength: 26 }],
  ["half_pipe", {}],
  ["tunnel", {}],
  ["channel", {}],
  ["banktilt", { straightLength: 26 }],
]) {
  const n = framesOf(id, extra);
  check(`${id} ${JSON.stringify(extra)} is 2 frames`, n === 2, `${n} frames`);
}

console.log("\n— connectors still span the authored length —");
{
  const L = 32;
  const built = buildPiece("straight", initialConnector(), pp({ straightLength: L }));
  const z = built.connectorOut.elements[14]; // m23 of a column-major Matrix4? 
  // socket at (0,0,-L): world is identity * exit. Position is elements 12,13,14.
  const x = built.connectorOut.elements[12];
  const y = built.connectorOut.elements[13];
  const ez = built.connectorOut.elements[14];
  check("a 32 m straight still exits 32 m down −Z",
    Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6 && Math.abs(ez + L) < 1e-6,
    `(${x.toFixed(3)}, ${y.toFixed(3)}, ${ez.toFixed(3)})`);
}

console.log("\n— UVs still run the real length (shader rings / asphalt streak) —");
{
  const L = 26;
  const geo = buildPiece("tube", initialConnector(), pp({ straightLength: L })).geometry;
  const uv = geo.getAttribute("uv");
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    const x = uv.getX(i);
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  check("tube uv.x spans 0…length", Math.abs(lo) < 1e-6 && Math.abs(hi - L) < 1e-4,
    `${lo.toFixed(3)}…${hi.toFixed(3)}`);
}

console.log("\n— pieces that actually change along their length stay dense —");
check("a curve is still densely sampled", framesOf("curve") > 8, `${framesOf("curve")} frames`);
check("a tube turn is still densely sampled", framesOf("tube_curve") > 8, `${framesOf("tube_curve")} frames`);
check("a tube entry still steps (the section morphs)", framesOf("tube_in") > 8, `${framesOf("tube_in")} frames`);
check("a bank-in still steps (roll and raise change)", framesOf("bankin") > 8, `${framesOf("bankin")} frames`);

console.log("\n— entries were not silently switched onto the 2-point helper —");
check("tubeEntryPoints still steps by segLen",
  /function tubeEntryPoints[\s\S]*?ceil\(L \/ roadParams\.segLen\)/.test(KIT_SRC));

console.log(fail === 0 ? "\nAll straight-sweep checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
