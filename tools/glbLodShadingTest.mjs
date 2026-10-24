/**
 * THE FAR MODELS SHADE LIKE THEIR NEAR — in npm test (2026-10-24, you: "be sure this normal problem will never happen
 * again"). Runs tools/glbLodShadingCheck.mjs on every model of public/models/alg (the far level's shading against the
 * near's: the fake streaks and stripes that read as shadows vanishing when the camera came close — ada0bba2).
 *
 * The full check takes minutes, so a model is only checked when it CHANGED: each one's content hash is remembered once it
 * passes (tools/glbLodShadingPassed.json, committed). A rebuilt model is checked on the next run; a failing one fails
 * the suite (its numbers printed). Its first catch: the reworked haystack's far level, 4.8 % off — rebuilt at 1.1 %.
 *
 *   node tools/glbLodShadingTest.mjs            (npm test runs it)
 *   node tools/glbLodShadingTest.mjs --all      re-check every model, whatever the cache says
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DIR = path.join(ROOT, "public", "models", "alg");
const CACHE = path.join(HERE, "glbLodShadingPassed.json");
const ALL = process.argv.includes("--all");

const passed = !ALL && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
const hashOf = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".glb")).sort();
const hashes = Object.fromEntries(files.map((f) => [f, hashOf(path.join(DIR, f))]));
const todo = files.filter((f) => passed[f] !== hashes[f]);

let failed = 0;
const next = Object.fromEntries(files.filter((f) => passed[f] === hashes[f]).map((f) => [f, hashes[f]]));
for (const f of todo) {
  const r = spawnSync(process.execPath, [path.join(HERE, "glbLodShadingCheck.mjs"), path.join(DIR, f)], { cwd: ROOT, encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status === 0) { next[f] = hashes[f]; console.log(`PASS  ${f}: far levels shade like their near`); }
  else { failed++; console.log(`FAIL  ${f}: a far level shades unlike its near\n${out.split("\n").filter((l) => /%|FAIL|Error/.test(l)).join("\n")}`); }
}
if (!todo.length) console.log(`PASS  ${files.length} models unchanged since they passed`);
fs.writeFileSync(CACHE, JSON.stringify(next, null, 1) + "\n");
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
