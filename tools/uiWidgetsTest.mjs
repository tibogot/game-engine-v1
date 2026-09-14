// v3/ui/widgets.js is the one copy of the editor's panel widgets (v3/AUDIT.md
// #88). Checks its number helpers, and that no panel grows its own copy again.
import { readdirSync, readFileSync } from "node:fs";
import { fmt, clampSnap } from "../v3/ui/widgets.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

check("fmt shows as many decimals as the step", fmt(0.3, 0.01) === "0.30" && fmt(1.23456, 0.001) === "1.235" && fmt(7.6, 1) === "8");
check("clampSnap snaps to the step without float noise", clampSnap(0.30000000000000004, 0, 1, 0.1) === 0.3 && clampSnap(0.777, 0, 1, 0.01) === 0.78);
check("clampSnap clamps to the range", clampSnap(5, 0, 1, 0.01) === 1 && clampSnap(-2, 0, 1, 0.01) === 0);
check("clampSnap snaps relative to min", clampSnap(2.3, 1, 10, 0.5) === 2.5);
check("a non-number becomes min", clampSnap(NaN, 2, 9, 1) === 2);

const dir = new URL("../v3/ui/", import.meta.url);
const copies = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith(".js") && n !== "widgets.js")) {
  const src = readFileSync(new URL(f, dir), "utf8");
  // A copy is a function body or an icon string. A one-line alias that calls the
  // shared widget with options (`const _hint = (p, html) => hint(p, html, {...})`) is fine.
  for (const m of src.matchAll(/^function\s+(_(?:section|separator|slider|color|toggle|dropdown|select|text|button|info|hint|fmt|clampSnap))\s*\(|^const\s+(_(?:arrowSvg|checkSvg))\s*=/gm)) {
    copies.push(`${f}: ${m[1] ?? m[2]}`);
  }
}
check("no panel defines its own copy of a shared widget", copies.length === 0, copies.join(", "));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
