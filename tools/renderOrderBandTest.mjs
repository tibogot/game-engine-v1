/**
 * RTS: NOTHING SEE-THROUGH WITHOUT A DRAW-ORDER BAND (games/shared-rts/renderOrder.js).
 *
 * Transparent things don't write depth, so the one drawn LAST is on top. The
 * alg-rts fields (a ground layer, renderOrder 40) covered the smoke, then a
 * sapper's site, then the path dots and selection rings — each time something
 * lying on the ground had been left at renderOrder 0 or a guess under 40
 * (2026-10-03, you: "it should never happen again"). This makes the next one
 * fail here instead of on screen:
 *
 *   1. the bands keep their order (ground layers < on-ground < air < HUD);
 *   2. no BARE NUMBER as a renderOrder in games/shared-rts or games/alg-rts —
 *      a band from RENDER_ORDER, or `render-order-ok: <why>` on the line;
 *   3. a file there that makes a TRANSPARENT material must use a band (or say
 *      `render-order-ok` where it is a factory whose meshes pick their own).
 *
 *   node tools/renderOrderBandTest.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RENDER_ORDER as R } from "../games/shared-rts/renderOrder.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["games/shared-rts", "games/alg-rts"];

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

// 1. The bands.
const chain = ["FIELDS", "TRACKS", "CRATERS", "COVER_VIEW", "ON_GROUND", "AIR", "SMOKE", "FLAMES", "TRACERS", "LIGHTS", "HUD"];
for (let i = 1; i < chain.length; i++) {
  const a = chain[i - 1], b = chain[i];
  ok(`${a} (${R[a]}) draws before ${b} (${R[b]})`, R[a] < R[b] || (a === "AIR" && R[a] <= R[b]));
}
ok("POOLS among the ground layers", R.POOLS >= R.FIELDS && R.POOLS < R.ON_GROUND);
ok("the units (opaque) before every see-through ground layer", R.UNITS < R.FIELDS);

// 2 + 3. The sources.
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".js")) files.push(p);
  }
};
for (const d of DIRS) walk(join(ROOT, d));

const BARE = /(renderOrder\s*[=:]\s*-?\d|_ORDER\s*=\s*-?\d)/;
const TRANSPARENT = /transparent\s*[:=]\s*(true|[a-zA-Z_.]+)/;
let bare = 0, unbanded = 0;
for (const p of files) {
  const rel = relative(ROOT, p).replace(/\\/g, "/");
  if (rel.endsWith("renderOrder.js")) continue;
  const src = readFileSync(p, "utf8");
  src.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (BARE.test(code) && !line.includes("render-order-ok")) {
      bare++;
      ok(`${rel}:${i + 1} uses a band, not a number`, false, line.trim());
    }
  });
  // (a file whose COMMENT named renderOrder.js once skipped its import: boot died)
  if (/RENDER_ORDER\./.test(src) && !/import\s*\{[^}]*RENDER_ORDER[^}]*\}/.test(src)) {
    unbanded++;
    ok(`${rel}: uses RENDER_ORDER and imports it`, false);
  }
  const lines = src.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l));
  if (lines.some((l) => TRANSPARENT.test(l.replace(/\/\/.*$/, "")) && !/transparent\s*[:=]\s*false/.test(l))
      && !src.includes("RENDER_ORDER") && !src.includes("render-order-ok")) {
    unbanded++;
    ok(`${rel}: a transparent material, and a RENDER_ORDER band for it`, false);
  }
}
ok(`no bare renderOrder numbers in ${files.length} files`, bare === 0);
ok("every file with a transparent material picks a band", unbanded === 0);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
