// OPTIMIZE A GLB FOR THE GAME (2026-10-18, you: "any asset we create should be very optimized … merged,
// instanced, compression, anything"). The same library as the online optimizers (gltf-transform), run here so
// every Blender asset goes through the same steps, repeatably:
//
//   node tools/optimizeGlb.mjs <in.glb> <out.glb> [--max 2048] [--etc1s] [--level 2]
//
//   1. resize    textures larger than --max (default: leave them) down to it
//   2. KTX2      UASTC (default: the quality of baked colour, BC7 on desktop GPUs) or --etc1s (smaller
//                download, the GPU cost is the same on desktop: it transcodes to BC7 too); mipmaps; zstd
//   3. meshopt   quantized, compressed geometry (EXT_meshopt_compression; the shared loader decodes it)
//
// Needs the gltf-transform CLI (npm i -g @gltf-transform/cli) and KTX-Software's toktx (installed in
// C:/Program Files/KTX-Software/bin, put on the PATH here). Prints the sizes before and after.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [src, dst] = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--etc1s"].includes(args[i - 1])));
if (!src || !dst) { console.error("usage: node tools/optimizeGlb.mjs <in.glb> <out.glb> [--max 2048] [--etc1s] [--level 2]"); process.exit(1); }
const KTX = "C:/Program Files/KTX-Software/bin";
const env = { ...process.env, PATH: (existsSync(KTX) ? KTX + path.delimiter : "") + process.env.PATH };
const tmp = mkdtempSync(path.join(tmpdir(), "optglb-"));
let cur = path.resolve(src), n = 0;
function step(cmd, ...extra) {
  const out = path.join(tmp, `${n++}.glb`);
  const r = spawnSync("gltf-transform", [cmd, cur, out, ...extra], { env, stdio: ["ignore", "inherit", "inherit"], shell: true });
  if (r.status !== 0) { console.error(`gltf-transform ${cmd} failed`); process.exit(1); }
  cur = out;
}
const max = flag("--max", null);
if (max) step("resize", "--width", max, "--height", max);
// (normal maps NEVER in ETC1S — its blocks smear the relief: the colour in ETC1S, the normals in UASTC — the
// scanned stones' baked normals, 2026-10-21)
if (args.includes("--etc1s")) { step("etc1s", "--quality", "200", "--slots", "baseColorTexture"); step("uastc", "--level", "2", "--rdo", "--rdo-lambda", "2", "--zstd", "18", "--slots", "normalTexture"); }
else step("uastc", "--level", flag("--level", "2"), "--rdo", "--rdo-lambda", "2", "--zstd", "18");
step("meshopt", "--level", "medium");
copyFileSync(cur, path.resolve(dst));
rmSync(tmp, { recursive: true, force: true });
const mb = (f) => (statSync(f).size / 1e6).toFixed(2) + " MB";
console.log(`${src} (${mb(src)}) → ${dst} (${mb(dst)})`);
