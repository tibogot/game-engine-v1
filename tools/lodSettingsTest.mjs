// v3/render/culling/lodSettings.js — the one LOD settings shape (CULLING_LOD_SPEC.md R3) and every
// old name a level, a preset or a system still uses. Each old spelling must read as the new shape,
// the new name must win over an old one, and a missing field must stay null (the caller's default).
import { readLod } from "../v3/render/culling/lodSettings.js";
import { LOD_HYSTERESIS } from "../v3/render/culling/cpuCull.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expect = (name, input, want) => {
  const got = readLod(input);
  const sub = Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]));
  check(name, same(sub, want), same(sub, want) ? "" : `got ${JSON.stringify(sub)}, want ${JSON.stringify(want)}`);
};

// The new shape
expect("new shape", { distances: [60, 180], hysteresis: 0.05, fade: 8, impostorFrom: 400, cullFrom: 900, floors: [60, 110] },
  { distances: [60, 180], hysteresis: 0.05, fade: 8, impostorFrom: 400, cullFrom: 900, floors: [60, 110] });
expect("empty → nulls + default hysteresis", {},
  { distances: [], hysteresis: LOD_HYSTERESIS, fade: null, impostorFrom: null, cullFrom: null, floors: null });
expect("null / undefined input", null, { distances: [], hysteresis: LOD_HYSTERESIS });
expect("undefined input", undefined, { distances: [] });

// Every old spelling
expect("lodDistances array (placedFoliage, gpuInstanceField)", { lodDistances: [45, 110] }, { distances: [45, 110] });
expect("lodDistances {lod1, lod2} (tree presets)", { lodDistances: { lod1: 80, lod2: 200 } }, { distances: [80, 200] });
expect("lodDistances {lod1} only", { lodDistances: { lod1: 80 } }, { distances: [80] });
expect("lod0Distance / lod1Distance / fadeOutDistance (props, trees)", { lod0Distance: 60, lod1Distance: 150, fadeOutDistance: 500 },
  { distances: [60, 150], cullFrom: 500 });
expect("lod0Distance alone (legacy tree state)", { lod0Distance: 120 }, { distances: [120] });
expect("lodDistance / lodDistance2 (plant fields)", { lodDistance: 18, lodDistance2: 45 }, { distances: [18, 45] });
expect("lodDistance alone (flowers, masonry)", { lodDistance: 18 }, { distances: [18] });
expect("lodDistance2 alone keeps its slot", { lodDistance2: 45 }, { distances: [null, 45] });
expect("lod0Dist / lod1Dist (labs)", { lod0Dist: 30, lod1Dist: 90 }, { distances: [30, 90] });
expect("fadeDistance → cullFrom (gpuCullLab)", { fadeDistance: 700 }, { cullFrom: 700 });
expect("cullDistance → cullFrom", { cullDistance: 300 }, { cullFrom: 300 });
expect("impostorDistance → impostorFrom", { impostorDistance: 250 }, { impostorFrom: 250 });
expect("lodFloors → floors (scatterField)", { lodFloors: [60, 110] }, { floors: [60, 110] });

// Precedence: the new name wins
expect("distances beats lodDistances", { distances: [10, 20], lodDistances: [45, 110] }, { distances: [10, 20] });
expect("lodDistances beats lod0Distance", { lodDistances: [45, 110], lod0Distance: 60 }, { distances: [45, 110] });
expect("cullFrom beats fadeOutDistance", { cullFrom: 900, fadeOutDistance: 500 }, { cullFrom: 900 });
expect("floors beats lodFloors", { floors: [1, 2], lodFloors: [60, 110] }, { floors: [1, 2] });

// Junk is ignored, not passed through
expect("non-numbers dropped from distances", { distances: [60, "x", NaN, 180] }, { distances: [60, 180] });
expect("NaN hysteresis → default", { hysteresis: NaN }, { hysteresis: LOD_HYSTERESIS });
expect("string cullFrom → null", { cullFrom: "900" }, { cullFrom: null });

// The input is never modified
const input = { lod0Distance: 60, lod1Distance: 150 };
const copy = JSON.stringify(input);
readLod(input);
check("input untouched", JSON.stringify(input) === copy);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
