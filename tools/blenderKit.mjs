/**
 * BUILD A BLENDER KIT, ONE PIECE AT A TIME (2026-10-27, you: "is there a way we can go faster when making assets in
 * blender and do we always have to wait long?" — a fix to one mechta piece rebuilt all 18 models, 15-20 min).
 *
 * Each kit script (tools/blender/<script>.py, house.py's buildKit) writes every type it builds to its own file,
 * .cache/blender/<kit>/parts/<type>.glb. This runs it, then MERGES every part — the ones just built and the ones
 * cached — into the kit (gltf-transform, no re-encoding), optimises it into public/models/alg, and runs the three gates
 * on it (size, coplanar, far-level shading).
 *
 *   node tools/blenderKit.mjs mechta                    the whole kit
 *   node tools/blenderKit.mjs mechta --only pente       that type alone (a,b: those), the others from the cache
 *   node tools/blenderKit.mjs mechta --only pente --quick   a quick bake (512 px, light AO): to judge the shape fast
 *   node tools/blenderKit.mjs mechta --gpu              bake on the graphics card (it shares the GPU with the screen)
 *   node tools/blenderKit.mjs mechta --merge            no Blender: merge the cached parts, optimise, gates
 *
 * The kit says which of its parts are QUICK builds — rebuild them without --quick before a commit. (Blender: the
 * BLENDER env var, else Blender 5.0's default install.)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLENDER = process.env.BLENDER ?? "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe";
// the script → its kit file, where they differ (house.py writes houses.glb)
const GLB = { house: "houses.glb" };

const args = process.argv.slice(2);
const script = args.find((a) => !a.startsWith("--") && !["--only"].includes(args[args.indexOf(a) - 1]));
if (!script) { console.log("usage: node tools/blenderKit.mjs <script> [--only a,b] [--quick] [--gpu] [--merge] [--uastc]"); process.exit(1); }
const glb = GLB[script] ?? `${script}.glb`;
const cache = path.join(ROOT, ".cache", "blender", glb.replace(/\.glb$/, ""));
const parts = path.join(cache, "parts");
const flag = (f) => args.includes(f);
const only = flag("--only") ? args[args.indexOf("--only") + 1] : null;
const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)} s`;

// 1. BLENDER: the types asked for (all without --only), each into parts/<type>.glb
if (!flag("--merge")) {
  const py = path.join(ROOT, "tools", "blender", `${script}.py`);
  if (!fs.existsSync(py)) { console.log(`no ${py}`); process.exit(1); }
  const bargs = ["-b", "--factory-startup", "--python", py, "--", cache];
  if (only) bargs.push("--only", only);
  if (flag("--quick")) bargs.push("--quick");
  if (flag("--gpu")) bargs.push("--gpu");
  console.log(`blender: ${script}.py${only ? ` --only ${only}` : ""}${flag("--quick") ? " --quick" : ""}${flag("--gpu") ? " --gpu" : ""}`);
  const r = spawnSync(BLENDER, bargs, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  for (const line of out.split(/\r?\n/)) if (/^(TRIS|BAKE|Error|Traceback)|Error:|DONE/.test(line)) console.log(`  ${line}`);
  if (r.status !== 0 || /Traceback/.test(out)) { console.log(`blender FAILED (${secs()})`); process.exit(1); }
  console.log(`  blender done (${secs()})`);
}

// 2. MERGE every part into the kit
const files = fs.existsSync(parts) ? fs.readdirSync(parts).filter((f) => f.endsWith(".glb")).sort() : [];
if (!files.length) { console.log(`no parts in ${parts} — build the kit once without --only`); process.exit(1); }
const quick = files.map((f) => f.replace(/\.glb$/, "")).filter((t) => fs.existsSync(path.join(parts, `${t}.quick`)));
const raw = path.join(cache, glb);
const m = spawnSync("gltf-transform", ["merge", ...files.map((f) => `"${path.join(parts, f)}"`), `"${raw}"`, "--merge-scenes"], { shell: true, encoding: "utf8" });
if (m.status !== 0) { console.log(`merge FAILED:\n${m.stderr}`); process.exit(1); }
console.log(`merged ${files.length} parts (${files.map((f) => f.replace(/\.glb$/, "")).join(", ")})`);

// 3. OPTIMISE into the game (ETC1S for a kit — UASTC with --uastc)
const dst = path.join(ROOT, "public", "models", "alg", glb);
const o = spawnSync(process.execPath, [path.join(ROOT, "tools", "optimizeGlb.mjs"), raw, dst, ...(flag("--uastc") ? [] : ["--etc1s"])], { cwd: ROOT, encoding: "utf8" });
if (o.status !== 0) { console.log(`optimise FAILED:\n${o.stdout}${o.stderr}`); process.exit(1); }
console.log(`  → public/models/alg/${glb} (${(fs.statSync(dst).size / 1e6).toFixed(2)} MB)`);

// 4. THE GATES on it
let bad = 0;
for (const gate of ["glbExtentTest", "glbCoplanarTest", "glbLodShadingTest"]) {
  const g = spawnSync(process.execPath, [path.join(ROOT, "tools", `${gate}.mjs`)], { cwd: ROOT, encoding: "utf8" });
  const mine = `${g.stdout}`.split(/\r?\n/).filter((l) => l.includes(glb));
  const fail = mine.some((l) => /FAIL/.test(l));
  if (fail) bad++;
  console.log(`  ${fail ? "FAIL" : "ok  "} ${gate}${mine.length ? `: ${mine.map((l) => l.trim()).join(" | ")}` : ""}`);
}
if (quick.length) console.log(`\nQUICK parts in the kit: ${quick.join(", ")} — rebuild them without --quick before committing`);
console.log(`\n${bad ? `${bad} gate(s) FAILED` : "all gates pass"} (${secs()})`);
process.exit(bad ? 1 : 0);
