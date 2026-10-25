/**
 * THE BLENDER MODELS DON'T Z-FIGHT — in npm test (2026-10-25: the z-fighting clean-up; you, earlier: "I thought we made
 * a tool to avoid those issues"). Runs tools/glbCoplanarCheck.mjs's test (tools/lib/coplanar.mjs: two triangles in one
 * plane, overlapping) on every mesh of public/models/alg, as SHIPPED — after the optimizer: its 14-bit positions had
 * rounded the kits' 3-4 mm separations back into one plane (the requisition point: 12 pairs raw, 614 shipped).
 *
 * A RATCHET: tools/glbCoplanarPassed.json keeps each model's hash and its pairs. A model that changed is checked again
 * and may never have MORE pairs than recorded (a new model: none) — the old kits' leftovers are listed, and each
 * clean-up lowers its bar. Unchanged models are not re-read (the hash).
 *
 *   node tools/glbCoplanarTest.mjs            (npm test runs it)
 *   node tools/glbCoplanarTest.mjs --all      re-check every model, whatever the cache says
 *   node tools/glbCoplanarTest.mjs --baseline every model's pairs today become its bar (once: 2026-10-25)
 *   node tools/glbCoplanarTest.mjs --accept <model.glb> "<why>"   ONE model's pairs today become its bar, the reason
 *                                  recorded beside it (glbCoplanarPassed.json `why`) — for pairs looked at and judged
 *                                  invisible (a sliver folded onto its neighbour, same face, same colour), never to hide one
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readGlb } from "./lib/glbRead.mjs";
import { coplanarOverlaps } from "./lib/coplanar.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "..", "public", "models", "alg");
const CACHE = path.join(HERE, "glbCoplanarPassed.json");
const BASE = process.argv.includes("--baseline");
const ai = process.argv.indexOf("--accept"), ACCEPT = ai >= 0 ? process.argv[ai + 1] : null, WHY = ai >= 0 ? process.argv[ai + 2] : null;
if (ACCEPT && !WHY) { console.log("--accept <model.glb> \"<why>\": the reason is required"); process.exit(1); }
const ALL = BASE || !!ACCEPT || process.argv.includes("--all");

const seen = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const geoOf = (n) => ({
  attributes: { position: { count: n.positions.length / 3, getX: (i) => n.positions[3 * i], getY: (i) => n.positions[3 * i + 1], getZ: (i) => n.positions[3 * i + 2] } },
  index: { count: n.indices.length, getX: (k) => n.indices[k] },
});

let failed = 0, left = 0;
const next = {};
for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".glb")).sort()) {
  const hash = crypto.createHash("sha1").update(fs.readFileSync(path.join(DIR, f))).digest("hex");
  const was = seen[f];
  if (!ALL && was?.hash === hash) { next[f] = was; left += was.pairs; continue; }
  const { nodes } = await readGlb(path.join(DIR, f));
  let pairs = 0;
  const where = [];
  for (const n of nodes) {
    const r = coplanarOverlaps(geoOf(n));
    if (r.pairs) { pairs += r.pairs; where.push(`${n.name} ${r.pairs}`); }
  }
  const bar = BASE || f === ACCEPT ? pairs : was?.pairs ?? 0;
  if (pairs > bar) {
    failed++;
    next[f] = was ?? { hash: "", pairs: 0 };   // (the bar stays: fix the model)
    console.log(`FAIL  ${f}: ${pairs} coplanar pairs (z-fighting), the bar is ${bar} — ${where.slice(0, 6).join(", ")}`);
  } else {
    next[f] = { hash, pairs, ...(f === ACCEPT ? { why: WHY } : was?.why && pairs > 0 ? { why: was.why } : {}) };
    left += pairs;
    console.log(`PASS  ${f}: ${pairs} pairs${pairs < bar ? ` (was ${bar})` : ""}${pairs ? ` — ${where.slice(0, 4).join(", ")}` : ""}`);
  }
}
fs.writeFileSync(CACHE, JSON.stringify(next, null, 1) + "\n");
console.log(failed ? `\n${failed} FAILED` : `\nALL PASS (${left} old pairs left to clean up)`);
process.exit(failed ? 1 : 0);
