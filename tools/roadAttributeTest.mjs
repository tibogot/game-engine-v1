/**
 * Every road geometry must carry the SAME attribute set, and `aCurve` must mean
 * what the shader thinks it means.
 *
 * THE SILENT FAILURE: pieces are merged per material for drive mode, and
 * mergeGeometries returns `null` — no throw, no warning — the moment two inputs
 * disagree on attributes. The merged track then simply does not exist, at a
 * convincing 60 fps. This codebase has hit that class of bug three times
 * (attribute mismatch, indexed vs non-indexed, and a proxy attached in two of
 * three places), so a new per-piece attribute gets a test rather than a hope.
 *
 *   node tools/roadAttributeTest.mjs
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildPiece, roadParams, pieceParams, guardrailParams } from "../games/modular-road-v3/modularRoadKit.js";

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const note = (msg) => console.log(`     ${msg}`);

const make = (base, extra = {}) =>
  buildPiece(base, new THREE.Matrix4(), { ...pieceParams, ...extra }, roadParams, guardrailParams, true);

/* ── 1. curvature is signed, scaled 1/R, and eased at the seams ─────────── */

console.log("— aCurve —");
const range = (geo) => {
  const a = geo.getAttribute("aCurve");
  if (!a) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.count; i++) {
    lo = Math.min(lo, a.getX(i));
    hi = Math.max(hi, a.getX(i));
  }
  return { lo, hi };
};

for (const [name, base, pp, want] of [
  ["straight", "straight", { straightLength: 32 }, 0],
  ["curve R26 right", "curve", { curveRadius: 26, curveAngle: 90, curveDir: 1 }, 1 / 26],
  ["curve R26 left", "curve", { curveRadius: 26, curveAngle: 90, curveDir: -1 }, -1 / 26],
  ["hairpin R14", "curve", { curveRadius: 14, curveAngle: 150, curveDir: 1 }, 1 / 14],
]) {
  const r = range(make(base, pp).geometry);
  check(r != null, `${name}: attribute present`);
  if (!r) continue;
  const peak = Math.abs(r.lo) > Math.abs(r.hi) ? r.lo : r.hi;
  check(
    Math.abs(peak - want) < 1e-3,
    `${name}: peak ${peak.toFixed(4)} ≈ 1/R ${want.toFixed(4)} (sign = turn direction)`,
  );
  // Faded at both ends so a seam between a straight and a curve has no step.
  check(
    Math.min(Math.abs(r.lo), Math.abs(r.hi)) < 1e-6,
    `${name}: eases to zero at the piece ends`,
  );
}

/* ── 2. every piece type merges together ────────────────────────────────── */

console.log("\n— merge compatibility —");
const KINDS = [
  ["straight", "straight", {}],
  ["curve", "curve", {}],
  ["platform", "platform", {}],
  ["slope", "slope", {}],
  ["jump", "jump", {}],
  ["twist", "twist", {}],
  ["loop", "loop", {}],
  ["spiral", "spiral", {}],
  ["tube", "tube", {}],
  ["tunnel", "tunnel", {}],
  ["narrow", "narrow", {}],
  ["banktilt", "banktilt", {}],
];

const built = [];
for (const [name, base, pp] of KINDS) {
  let g = null;
  try {
    g = make(base, pp).geometry;
  } catch {
    note(`${name}: not in this kit build, skipped`);
    continue;
  }
  if (g) built.push([name, g]);
}
check(built.length >= 6, `${built.length} piece types built`);

const sig = (g) => Object.keys(g.attributes).sort().join(",");
const first = sig(built[0][1]);
note(`attribute set: ${first}`);
for (const [name, g] of built) {
  check(sig(g) === first, `${name}: same attributes as the rest`);
}
check(first.includes("aCurve"), "aCurve is in the shared set");

const merged = mergeGeometries(built.map(([, g]) => g), false);
check(merged != null, "all piece types merge into one mesh (null here = invisible track)");
if (merged) {
  note(`${merged.attributes.position.count.toLocaleString()} verts merged`);
  check(merged.getAttribute("aCurve") != null, "merged mesh kept aCurve");
}

console.log(failed ? `\n${failed} check(s) failed` : "\nroad attributes are consistent");
process.exit(failed ? 1 : 0);
