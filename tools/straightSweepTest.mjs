// Constant-section straights are stationed every `segLen`, like everything else.
//
// This used to assert the opposite: a prism is defined by its entry and exit,
// so straights were collapsed to two frames and the stations in between were
// dropped as copies of the same ring. 9e391b3 (newcursorroadoptimization) put
// them back — one 32 m quad interpolates its normal badly and picks up shadow
// acne, and the vertices are cheap next to that. So the contract this pins now
// is the SPACING, not a magic count: no gap wider than segLen, and the count
// that follows from it. What must still hold either way is further down —
// connectors span the authored length and UVs run the real length.
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

const { buildPiece, initialConnector, pieceParams, roadParams } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);

const pp = (extra = {}) => ({ ...pieceParams, ...extra });
const framesOf = (id, extra = {}) =>
  buildPiece(id, initialConnector(), pp(extra)).frames.length;

/** Longest gap between consecutive stations, and the run they span. */
const spacingOf = (id, extra = {}) => {
  const frames = buildPiece(id, initialConnector(), pp(extra)).frames;
  let worst = 0, total = 0;
  for (let i = 1; i < frames.length; i++) {
    const d = frames[i].pos.distanceTo(frames[i - 1].pos);
    if (d > worst) worst = d;
    total += d;
  }
  return { worst, total, n: frames.length };
};

console.log("— constant straights step at segLen —");
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
  const { worst, total, n } = spacingOf(id, extra);
  // ceil(run / segLen) spans + the closing frame. Tolerance on `worst` because
  // the last span is the remainder, never longer than a full step.
  const want = Math.ceil(total / roadParams.segLen - 1e-6) + 1;
  check(`${id} ${JSON.stringify(extra)} steps at segLen`,
    n === want && worst <= roadParams.segLen + 1e-6,
    `${n} frames over ${total.toFixed(1)} m, widest gap ${worst.toFixed(3)} m (want ${want})`);
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
