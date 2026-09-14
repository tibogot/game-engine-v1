// Loading saved settings onto live state (v3/app/state/mergeKnownKeys.js):
// only keys the build still has, nested, kind-checked.
import { mergeKnownKeys } from "../v3/app/state/mergeKnownKeys.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

const live = {
  exposure: 0.7, color: "#ffffff", enabled: false, boxes: [], tex: null,
  bloom: { strength: 0.3, threshold: 0.9 },
  addedLater: 5,
};
mergeKnownKeys(live, {
  exposure: 1.2, color: "#ff8800", enabled: true, boxes: [1, 2], tex: "x",
  bloom: { strength: 0.8, retired: 1 },
  retiredParam: 42,
});
check("numbers, strings and booleans load", live.exposure === 1.2 && live.color === "#ff8800" && live.enabled === true);
check("nested objects merge per key", live.bloom.strength === 0.8 && live.bloom.threshold === 0.9);
check("a param added later keeps its default", live.addedLater === 5);
check("retired params are not resurrected", !("retiredParam" in live) && !("retired" in live.bloom));
check("arrays and null defaults take the saved value", live.boxes.length === 2 && live.tex === "x");

const typed = { speed: 1, mode: "a", sub: { n: 1 } };
mergeKnownKeys(typed, { speed: "fast", mode: 3, sub: 7 });
check("a value of the wrong kind is ignored", typed.speed === 1 && typed.mode === "a" && typed.sub.n === 1);
check("a missing source leaves state alone", mergeKnownKeys({ a: 1 }, null).a === 1);

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
