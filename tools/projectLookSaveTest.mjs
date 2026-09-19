// The .v3proj carries the look a game needs to match the editor: grass
// appearance, cliff-top grass, cliff paint, snow look and interior lighting
// (v3/AUDIT.md #84). Checks the file round trip, the per-key merge, and that
// the grass/snow panel tables still match the panel and the state.
import { readFileSync } from "node:fs";
import { encodeProjectFile, decodeProjectFile } from "../v3/io/projectIO.js";
import { mergeKnownKeys } from "../v3/app/state/mergeKnownKeys.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

const terrain = { worldSize: 100, heightmapSize: 4, splatSize: 4, maxHeight: 10 };
const heightmap = new Float32Array(16).fill(1);
const pattern = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed) & 255);

// ── Round trip ────────────────────────────────────────────────────────────
const cliffGrassDensity = pattern(512 * 512 * 4, 5);
const cliffPaint = pattern(512 * 512 * 4, 9);
const grassHeight = pattern(512 * 512 * 4, 3);
const grass = { bladeHeight: 1.7, tipColor: "#aabbcc", crossed: false, specV2Power: 3.5 };
const snowParams = { baseDepth: 0.42, glitterFreq: 350 };
const d = decodeProjectFile(encodeProjectFile({ terrain, heightmap, cliffGrassDensity, cliffPaint, grassHeight, grass, snowParams }));

const same = (a, b) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
check("cliff-top grass density comes back byte-for-byte", same(d.cliffGrassDensity, cliffGrassDensity));
check("cliff paint mask comes back byte-for-byte", same(d.cliffPaint, cliffPaint));
check("painted grass height comes back byte-for-byte", same(d.grassHeight, grassHeight));
check("grass look comes back", JSON.stringify(d.grass) === JSON.stringify(grass));
check("snow look comes back", JSON.stringify(d.snowParams) === JSON.stringify(snowParams));

const old = decodeProjectFile(encodeProjectFile({ terrain, heightmap }));
check("an older file has none of them", old.cliffGrassDensity === null && old.cliffPaint === null && old.grassHeight === null && old.grass === null && old.snowParams === null);

// ── Per-key merge (what applyGrassState relies on) ───────────────────────
const state = { bladeHeight: 1, tipColor: "#00b30c", crossed: true, newParam: 0.5 };
mergeKnownKeys(state, { bladeHeight: 2, crossed: false, retired: 9, tipColor: 42 });
check("known keys take the saved value", state.bladeHeight === 2 && state.crossed === false);
check("a param added later keeps its default", state.newParam === 0.5);
check("a retired param is not resurrected", !("retired" in state));
check("a value of the wrong type is ignored", state.tipColor === "#00b30c");

// ── Panel tables vs panel and state ──────────────────────────────────────
const main = readFileSync(new URL("../v3/app/main.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../v3/editor.html", import.meta.url), "utf8");
const tableOf = (name) => {
  const start = main.indexOf(`const ${name} = [`);
  const body = main.slice(start, main.indexOf("];", start));
  return [...body.matchAll(/\["([^"]+)",\s*"([^"]+)"(?:,\s*([\d.]+))?\]/g)].map((m) => [m[1], m[2], Number(m[3] ?? 1)]);
};
const grassTable = tableOf("GRASS_PANEL_CONTROLS");
const snowTable = tableOf("SNOW_LOOK_SLIDERS");

const missingEls = [...grassTable, ...snowTable].filter(([id]) => !html.includes(`id="${id}"`)).map(([id]) => id);
check("every table control exists in the editor", missingEls.length === 0, missingEls.join(", "));

const stateStart = main.indexOf("const grassState = {");
const grassKeys = [...main.slice(stateStart, main.indexOf("};", stateStart)).matchAll(/(\w+):/g)].map((m) => m[1]);
// Not panel controls: a view toggle, two fixed tint-mode settings, and the
// grass SYSTEM, whose control is a dropdown driven by syncGrassSystemUi (the
// table is sliders, colours and checkboxes).
const NO_CONTROL = new Set(["lodDebug", "terrainTintAutoSource", "terrainTintManualMode", "system"]);
const tableKeys = new Set(grassTable.map(([, key]) => key));
const uncovered = grassKeys.filter((k) => !NO_CONTROL.has(k) && !tableKeys.has(k));
check("every grass setting with a control is in the table", uncovered.length === 0, uncovered.join(", "));
const unknown = [...tableKeys].filter((k) => !grassKeys.includes(k));
check("the table names no unknown grass setting", unknown.length === 0, unknown.join(", "));

// Every preset value names a real grass setting (a typo would apply nothing).
const { GRASS_PRESETS } = await import("../v3/app/state/grassPresets.js");
const presetKeys = [...new Set(Object.values(GRASS_PRESETS).flatMap((p) => Object.keys(p.values)))];
const strayPreset = presetKeys.filter((k) => !grassKeys.includes(k));
check("every preset key is a grass setting", strayPreset.length === 0, strayPreset.join(", "));
check("presets carry no view toggle or painted density", !presetKeys.some((k) => k === "lodDebug" || /density$/i.test(k)));

// A slider's listener divides by the same factor the table multiplies by.
const scaleMismatch = [];
let scalesChecked = 0;
for (const [id, key, scale] of grassTable.filter(([id]) => id.startsWith("gsl-"))) {
  const varMatch = main.match(new RegExp(`const (\\w+)\\s*=\\s*(?:document\\.getElementById|uiById)\\("${id}"\\)`));
  if (!varMatch) continue; // the loop-bound sliders (spec dirs, LOD geometry)
  const listener = main.match(new RegExp(`${varMatch[1]}\\.addEventListener\\("input",[^\\n]*\\n?[^\\n]*grassState\\.${key} = Number\\(${varMatch[1]}\\.value\\)( / ([\\d.]+))?`));
  const got = listener ? Number(listener[2] ?? 1) : null;
  scalesChecked++;
  if (got !== scale) scaleMismatch.push(`${id}: table ${scale}, listener ${got}`);
}
check("slider scales match their listeners", scalesChecked >= 40 && scaleMismatch.length === 0,
  `${scalesChecked} checked${scaleMismatch.length ? `; ${scaleMismatch.join("; ")}` : ""}`);

// ── Interior lighting rides in the world look ────────────────────────────
const env = readFileSync(new URL("../v3/app/worldEnvironment.js", import.meta.url), "utf8");
const slices = env.slice(env.indexOf("const LOOK_SLICES = ["), env.indexOf("];", env.indexOf("const LOOK_SLICES = [")));
check("interior lighting is part of the saved look", slices.includes('"interior"'));
check("shadow quality stays out of the saved look", !slices.includes('"csm"'));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
