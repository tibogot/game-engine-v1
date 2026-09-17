// One object-layer table (v3/render/layers.js) for the engine and every game.
//
// The per-cascade prop shadow lists once took layers 1-4 while modular-road-v3
// had its reflection, pre-mirror and rain passes on 1, 2 and 3 — two "free"
// numbers picked in two places. This fails on a duplicate in the table and on
// a layer number written as a literal anywhere under v3/ or games/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYERS, MAX_SHADOW_CASCADE_LAYERS, shadowCascadeLayer } from "../v3/render/layers.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) fail++;
};

// ── The table ────────────────────────────────────────────────────────────────
const owners = new Map();   // layer number -> name
const add = (n, name) => {
  if (owners.has(n)) check(`layer ${n} has one owner`, false, `${owners.get(n)} and ${name}`);
  owners.set(n, name);
};
for (const [name, n] of Object.entries(LAYERS)) {
  if (name === "SHADOW_CASCADE_BASE") continue;
  add(n, name);
}
for (let i = 0; i < MAX_SHADOW_CASCADE_LAYERS; i++) add(shadowCascadeLayer(i), `SHADOW_CASCADE_${i}`);
check("no two systems share a layer", fail === 0);
check("every layer is an integer in 0..31",
  [...owners.keys()].every((n) => Number.isInteger(n) && n >= 0 && n <= 31),
  [...owners.keys()].join(", "));
check("DEFAULT is layer 0", LAYERS.DEFAULT === 0);
let threw = false;
try { shadowCascadeLayer(MAX_SHADOW_CASCADE_LAYERS); } catch { threw = true; }
check("a cascade past the reserved range throws instead of spilling into the next layer", threw);

// ── No literals outside the table ────────────────────────────────────────────
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(m?js|html)$/.test(e.name)) yield p;
  }
}

// `layers.enable(0)` is allowed: it names the default layer, not an allocation.
const CALL = /\.layers\.(?:set|enable|disable|toggle)\(\s*([1-9]\d*)\s*\)/g;
const MASK = /\.layers\.mask\s*=\s*\d+\s*[;\n]/g;
// A module-level `*_LAYER = <number>` is a private allocation. HOLE_LAYER and
// HOLE_ERASE_LAYER in splatMap.js are splat PAINT channels, not object layers.
const CONST = /\b(?:const|let|var)\s+((?:[A-Z0-9]+_)*LAYER(?:_BASE|_ID)?)\s*=\s*-?\d+\b/g;
const PAINT_CHANNELS = new Set(["HOLE_LAYER", "HOLE_ERASE_LAYER"]);

// The scan must still see the lines that caused the original clash.
const planted = [
  "const SHADOW_LAYER_BASE     = 1;",
  "export const REFLECT_LAYER = 1;",
  "inst.layers.set(3)",
];
const unrelated = ["const PLAYER_RADIUS = 0", "const NUM_LAYERS = 7", "const DECAL_LAYER_SIZE = 512", "camera.layers.enable(0)"];
const hits = (s) => [CALL, MASK, CONST].some((re) => { re.lastIndex = 0; const m = re.exec(s); re.lastIndex = 0; return !!m; });
check("the literal scan catches the lines that clashed", planted.every(hits), planted.filter((s) => !hits(s)).join(" | "));
check("...and ignores names that only contain LAYER", !unrelated.some(hits), unrelated.filter(hits).join(" | "));

const offenders = [];
for (const top of ["v3", "games"]) {
  for (const file of walk(path.join(ROOT, top))) {
    const r = rel(file);
    if (r === "v3/render/layers.js") continue;
    const src = fs.readFileSync(file, "utf8");
    const lineOf = (i) => src.slice(0, i).split("\n").length;
    for (const m of src.matchAll(CALL)) offenders.push(`${r}:${lineOf(m.index)}  ${m[0]}`);
    for (const m of src.matchAll(MASK)) offenders.push(`${r}:${lineOf(m.index)}  ${m[0].trim()}`);
    for (const m of src.matchAll(CONST)) {
      if (!PAINT_CHANNELS.has(m[1])) offenders.push(`${r}:${lineOf(m.index)}  ${m[0]}`);
    }
  }
}
check("no layer number is written as a literal outside v3/render/layers.js",
  offenders.length === 0, offenders.join("\n      "));

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
