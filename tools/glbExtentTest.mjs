/**
 * THE BLENDER MODELS STAY THEIR SIZE (2026-10-27, you, in the lab: "there is a weird black line above the house" — the
 * mechta's hillside house had its 1 cm laundry line thrown 17 m out each side by Blender's taper, a 35 m house; neither
 * the coplanar nor the LOD-shading gate could see it). Every mesh of every model in public/models/alg: its width (the
 * larger of x, z) and its height within its FILE's caps — a stray vertex, a stretched part, a misplaced piece fails it.
 *
 *   node tools/glbExtentTest.mjs            (npm test runs it)
 *   node tools/glbExtentTest.mjs --survey   (each file's largest width and height now: to set a new file's caps)
 *
 * The caps: a little over the file's largest piece, in its file's units (most kits real metres; a few game metres).
 */
import fs from "node:fs";
import path from "node:path";
import { readGlb } from "./lib/glbRead.mjs";

const DIR = "public/models/alg";
const CAPS = JSON.parse(fs.readFileSync(new URL("./glbExtentCaps.json", import.meta.url), "utf8"));
const survey = process.argv.includes("--survey");

let failed = 0, meshes = 0;
const found = {};
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".glb")).sort()) {
  const { nodes } = await readGlb(path.join(DIR, f));
  let W = 0, H = 0;
  const bad = [];
  for (const n of nodes) {
    if (!n.positions?.length) continue;
    meshes++;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n.positions.length; i += 3) {
      const x = n.positions[i], y = n.positions[i + 1], z = n.positions[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const w = Math.max(x1 - x0, z1 - z0), h = y1 - y0;
    W = Math.max(W, w); H = Math.max(H, h);
    const cap = CAPS[f];
    if (cap && (w > cap[0] || h > cap[1])) bad.push(`${n.name} ${w.toFixed(1)} wide × ${h.toFixed(1)} high (caps ${cap[0]} × ${cap[1]})`);
  }
  found[f] = [Math.ceil(W * 10) / 10, Math.ceil(H * 10) / 10];
  if (survey) continue;
  if (!CAPS[f]) { failed++; console.log(`  FAIL ${f}: no caps — run --survey, add it to tools/glbExtentCaps.json`); }
  else if (bad.length) { failed++; console.log(`  FAIL ${f}:`); for (const b of bad.slice(0, 4)) console.log(`         ${b}`); }
  else console.log(`  ok   ${f}`);
}
if (survey) { console.log(JSON.stringify(found, null, 1)); process.exit(0); }
console.log(failed ? `\n${failed} models out of their size (${meshes} meshes checked)` : `\nall passed (${meshes} meshes)`);
process.exit(failed ? 1 : 0);
