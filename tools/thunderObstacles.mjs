/**
 * THUNDERLINE'S OBSTACLE ASSETS, one at a time (2026-10-28, you: "better AAA assets for the obstacles … with ktx texture
 * and optimization and LOD"). Each asset is a Blender script (tools/blender/thunder<Name>.py) that writes its mesh to
 * .cache/blender/thunder-obstacles/<name>.glb, its textures to public/textures/thunderline/obstacles/<name>_*.png and
 * previews to assets-src/refs/thunderline-obstacles/. This runs it, optimises the mesh into the game (meshopt: the
 * textures are loaded apart, through loadTexture) and makes the textures' KTX2 copies (npm run textures on them).
 *
 *   node tools/thunderObstacles.mjs tyre            the tyre, full quality
 *   node tools/thunderObstacles.mjs tyre --quick    a quick bake: to judge the shape fast
 *   node tools/thunderObstacles.mjs tyre --nopreview
 *
 * (Blender: the BLENDER env var, else Blender 5.0's default install.)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLENDER = process.env.BLENDER ?? "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
if (!name) { console.log("usage: node tools/thunderObstacles.mjs <name> [--quick] [--nopreview]"); process.exit(1); }
const script = path.join(ROOT, "tools", "blender", `thunder${name[0].toUpperCase()}${name.slice(1)}.py`);
if (!fs.existsSync(script)) { console.log(`no ${script}`); process.exit(1); }
const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)} s`;

// 1. BLENDER
const r = spawnSync(BLENDER, ["-b", "--factory-startup", "--python", script, "--", ...args.filter((a) => a.startsWith("--"))], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
let tb = false;
for (const line of out.split(/\r?\n/)) {
  if (/^Traceback/.test(line)) tb = true;
  if (tb || /^(TRIS|Error)|Error:|DONE/.test(line)) console.log(`  ${line}`);
}
if (r.status !== 0 || /Traceback/.test(out) || !/DONE/.test(out)) { console.log(`blender FAILED (${secs()})`); process.exit(1); }
console.log(`  blender done (${secs()})`);

// 2. THE MESH into the game (meshopt; no textures inside)
const raw = path.join(ROOT, ".cache", "blender", "thunder-obstacles", `${name}.glb`);
const dstDir = path.join(ROOT, "public", "models", "thunderline", "obstacles");
fs.mkdirSync(dstDir, { recursive: true });
const dst = path.join(dstDir, `${name}.glb`);
const o = spawnSync(process.execPath, [path.join(ROOT, "tools", "optimizeGlb.mjs"), raw, dst], { cwd: ROOT, encoding: "utf8" });
if (o.status !== 0) { console.log(`optimise FAILED:\n${o.stdout}${o.stderr}`); process.exit(1); }
console.log(`  → public/models/thunderline/obstacles/${name}.glb (${(fs.statSync(dst).size / 1024).toFixed(0)} KB)`);

// 3. THE TEXTURES' KTX2 copies (public/ktx2/, gitignored; the sources stay PNG)
const texDir = "textures/thunderline/obstacles";
const c = spawnSync(process.execPath, [path.join(ROOT, "tools", "compressTextures.mjs"), texDir], { cwd: ROOT, encoding: "utf8" });
console.log(c.status === 0 ? `  → KTX2 copies of ${texDir}` : `  KTX2 FAILED:\n${c.stdout}${c.stderr}`);
const pngs = fs.readdirSync(path.join(ROOT, "public", texDir)).filter((f) => f.startsWith(`${name}_`) && f.endsWith(".png"));
for (const f of pngs) console.log(`    ${f} ${(fs.statSync(path.join(ROOT, "public", texDir, f)).size / 1024).toFixed(0)} KB`);
console.log(`done (${secs()})`);
