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
const GLB = { house: "houses.glb", oilStation: "oilstation.glb" };

const args = process.argv.slice(2);
const script = args.find((a) => !a.startsWith("--") && !["--only"].includes(args[args.indexOf(a) - 1]));
if (!script) { console.log("usage: node tools/blenderKit.mjs <script> [--only a,b] [--quick] [--gpu] [--merge] [--uastc]"); process.exit(1); }
const glb = GLB[script] ?? `${script}.glb`;
const cache = path.join(ROOT, ".cache", "blender", glb.replace(/\.glb$/, ""));
const parts = path.join(cache, "parts");
const flag = (f) => args.includes(f);
const MIP_BAR = 25;   // a material's AVERAGE colour shift at the game's mip (summed RGB x 100, 0-300): the port houses read 1-14 after the fix (2026-10-30). Not yet proven on a known fault — the lab's lodView at the switch distance stays the eye check
const only = flag("--only") ? args[args.indexOf("--only") + 1] : null;
const t0 = Date.now();
const secs = () => `${Math.round((Date.now() - t0) / 1000)} s`;

// 1. BLENDER: the types asked for (all without --only), each into parts/<type>.glb
// (its own checks read from its output — bkit.bake: MIPCHECK, a material's colour moving at the mip the game draws it with;
// BAKEBLACK, an atlas that came out black. Both failed SILENTLY before 2026-10-30: the port houses' brown window bars, two
// black atlases)
const blenderBad = [];
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
  let tb = false;   // (a traceback printed whole: its File lines say where)
  for (const line of out.split(/\r?\n/)) {
    if (/^Traceback/.test(line)) tb = true;
    if (tb || /^(TRIS|BAKE|MIPCHECK|FARFROM|THIN|UVFIT|SHARED|TIME|UVZERO|GROUNDZ|Error)|Error:|DONE/.test(line)) console.log(`  ${line}`);
    const mc = /^MIPCHECK (\S+) (\S+) (\S+) ([\d.]+)/.exec(line);
    if (mc && !flag("--quick") && +mc[4] > MIP_BAR) blenderBad.push(`${mc[2]}: ${mc[3]} ${mc[4]}`);
    if (/^BAKEBLACK/.test(line)) blenderBad.push(line);
    const gz = /^GROUNDZ \S+ (\S+) (\d+)/.exec(line);
    if (gz && +gz[2] > 0) blenderBad.push(`${gz[1]}: ${gz[2]} faces at the ground${String.fromCharCode(39)}s height (z-fight the terrain)`);
    const uz = /^UVZERO final (\S+) (\d+)/.exec(line);
    if (uz && +uz[2] > 0) blenderBad.push(`${uz[1]}: ${uz[2]} faces unwrapped to a line`);
  }
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

// 2b. THE FAR LEVELS a kit did not build (its spec `autoLod`) MADE FROM THEIR NEAR — tools/lod/autoLod.mjs: the same UVs and
// texture, simplified within one pixel of shape at the switch; then PROVED — tools/lod/lodCheck.mjs renders each near and its
// far where the game switches and fails the build if they differ (2026-10-31, you: "SOLID with no problems at all").
// A kit with its own far levels is left as it was (reported, not failed: "i dont want to remake all my assets").
const autoMade = [];
{
  const { NodeIO } = await import("@gltf-transform/core");
  const { ALL_EXTENSIONS } = await import("@gltf-transform/extensions");
  const { addFarLevels } = await import("./lod/autoLod.mjs");
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(raw);
  const made = (await addFarLevels(doc)).filter((r) => !r.skipped);
  for (const r of made) { autoMade.push(r.name); console.log(`  AUTOLOD ${r.name} ${r.near} -> ${r.far} tris (${(r.err * 1000).toFixed(1)} mm)`); }
  if (made.length) await io.write(raw, doc);
}

// 3. OPTIMISE into the game (ETC1S for a kit — UASTC with --uastc)
const dst = path.join(ROOT, "public", "models", "alg", glb);
const o = spawnSync(process.execPath, [path.join(ROOT, "tools", "optimizeGlb.mjs"), raw, dst, ...(flag("--uastc") ? [] : ["--etc1s"])], { cwd: ROOT, encoding: "utf8" });
if (o.status !== 0) { console.log(`optimise FAILED:\n${o.stdout}${o.stderr}`); process.exit(1); }
console.log(`  → public/models/alg/${glb} (${(fs.statSync(dst).size / 1e6).toFixed(2)} MB)`);

// 4. THE GATES on it
let bad = 0;
if (autoMade.length) {
  const lc = spawnSync(process.execPath, [path.join(ROOT, "tools", "lod", "lodCheck.mjs"), raw, "--out", path.join(cache, "lodcheck")], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 });
  const lines = `${lc.stdout}`.split(/\r?\n/).filter((l) => /^LODCHECK/.test(l) && autoMade.some((n) => l.includes(` ${n} `)));
  const fails = lines.filter((l) => /FAIL/.test(l));
  if (fails.length) { bad++; console.log(`  FAIL lodCheck (near and far differ where the game switches — diff images in .cache/blender/${path.basename(cache)}/lodcheck):\n    ${fails.join("\n    ")}`); }
  else console.log(`  ok   lodCheck: ${lines.length} near/far pairs look the same at the switch`);
}
if (blenderBad.length) { bad++; console.log(`  FAIL mipCheck (a material's average colour shifts past ${MIP_BAR} at the game's mip, or a black atlas): ${blenderBad.join(" | ")}`); }
else if (!flag("--merge")) console.log(`  ok   mipCheck${flag("--quick") ? " (quick: not judged)" : ""}`);
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
