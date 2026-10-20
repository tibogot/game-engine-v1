// COMPRESS IMAGE TEXTURES TO KTX2 (2026-10-19) — the sibling of optimizeGlb.mjs for the loose images in
// public/. The sources stay as they are (PNG / JPG / WebP, in git); this writes a compressed copy of each
// into public/ktx2/ (GENERATED, gitignored) plus public/ktx2/manifest.json, which the engine's shared
// loader (v3/render/textureLoad.js) reads to pick the .ktx2 over the image. A release build runs this too.
//
//   node tools/compressTextures.mjs                      every image under the default folders
//   node tools/compressTextures.mjs textures/decals ...  only these folders / files (paths inside public/)
//   options: --force (ignore the cache) · --max 2048 (shrink larger images) · --dry (list, write nothing)
//            --jobs 3 (parallel encodes)
//
// Per image:
//   1. sharp decodes it (it reads WebP, which the KTX tools can't), FLIPS it vertically and rounds the size
//      to a multiple of 4 (GPU block formats need it). The flip: a KTX2 texture is uploaded with
//      flipY = false, an image texture with flipY = true; flipping the pixels here makes the two sample
//      identically, so a caller can swap one for the other without touching UVs.
//   2. `ktx create` encodes UASTC (transcodes to BC7 on desktop GPUs: 1 byte/pixel instead of 4) with
//      mipmaps and zstd. Colour maps are sRGB; normal / roughness / AO / height / mask / noise maps are
//      linear (classified by the file NAME, see LINEAR below).
//   3. The manifest records the source's content hash, so a re-run only encodes what changed.
//
// Needs KTX-Software (C:/Program Files/KTX-Software/bin) and sharp (shipped inside the global
// @gltf-transform/cli install, the same one optimizeGlb.mjs uses).
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const OUT = path.join(PUBLIC, "ktx2");
const MANIFEST = path.join(OUT, "manifest.json");
const KTX = "C:/Program Files/KTX-Software/bin/ktx.exe";

// Folders compressed by default. Left out: textures/ui (small, must stay crisp) and brush-stamps (the
// editor reads them on the CPU).
const DEFAULT_ROOTS = ["textures", "city-ads", "games", "models", "assets"];
const SKIP = [/^textures\/ui\//, /^brush-stamps\//, /^ktx2\//];
const IMAGE = /\.(png|jpe?g|webp)$/i;
// Data, not colour: stored linear. Matched on the file name only.
const LINEAR = /(normal|_nor(_gl|_dx)?(?=[_.\-]|$)|_n\.|nrm|rough|_ao(?=[_.\-]|$)|ambientocclusion|occlusion|\borm\b|_arm(?=[_.\-]|$)|height|disp|metal|mask|noise|_spec|gloss|flow|depth|opacity|alpha\b)/i;

export const KTX_TOOL = KTX;
export function loadSharp() {
  const req = createRequire(import.meta.url);
  const candidates = [
    "sharp",
    path.join(process.env.APPDATA ?? "", "npm/node_modules/@gltf-transform/cli/node_modules/sharp"),
  ];
  for (const c of candidates) { try { return req(c); } catch { /* next */ } }
  throw new Error("sharp not found: install @gltf-transform/cli globally (npm i -g @gltf-transform/cli)");
}

function parseArgs(argv) {
  const o = { force: false, dry: false, max: 0, jobs: Math.max(1, Math.min(3, os.cpus().length >> 2)), paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") o.force = true;
    else if (a === "--dry") o.dry = true;
    else if (a === "--max") o.max = +argv[++i];
    else if (a === "--jobs") o.jobs = Math.max(1, +argv[++i]);
    else o.paths.push(a.replace(/\\/g, "/").replace(/^\/?public\//, "").replace(/^\//, ""));
  }
  return o;
}

function walk(rel, out) {
  const abs = path.join(PUBLIC, rel);
  if (!fs.existsSync(abs)) { console.warn(`  (missing: public/${rel})`); return; }
  if (fs.statSync(abs).isFile()) { if (IMAGE.test(rel)) out.push(rel); return; }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (SKIP.some((s) => s.test(r + (e.isDirectory() ? "/" : "")))) continue;
    if (e.isDirectory()) walk(r, out);
    else if (IMAGE.test(e.name)) out.push(r);
  }
}

export const isLinearName = (rel) => LINEAR.test(path.basename(rel));
export const ktx2PathFor = (rel) => `ktx2/${rel}.ktx2`;   // x.png and x.jpg can't collide

async function encodeOne(sharp, rel, max, tmpDir) {
  return encodeFile(sharp, path.join(PUBLIC, rel), path.join(PUBLIC, ktx2PathFor(rel)), { srgb: !isLinearName(rel), max, tmpDir });
}

/** Encode any image file to a KTX2 file (flipped, size rounded to ×4, UASTC + mips + zstd). */
export async function encodeFile(sharp, src, dst, { srgb = true, max = 0, tmpDir = os.tmpdir() } = {}) {
  let img = sharp(src, { failOn: "none" }).rotate();          // .rotate() = honour EXIF orientation
  const meta = await img.metadata();
  let w = meta.width, h = meta.height;
  if (max && Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  const w4 = Math.max(4, Math.round(w / 4) * 4), h4 = Math.max(4, Math.round(h / 4) * 4);
  const tmp = path.join(tmpDir, createHash("sha1").update(src).digest("hex").slice(0, 16) + ".png");
  await img.resize(w4, h4, { fit: "fill", kernel: "lanczos3" }).flip().ensureAlpha()
    .png({ compressionLevel: 1 }).toFile(tmp);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await run(KTX, [
    "create",
    "--format", srgb ? "R8G8B8A8_SRGB" : "R8G8B8A8_UNORM",
    "--assign-tf", srgb ? "srgb" : "linear",
    "--encode", "uastc", "--uastc-quality", "2",
    "--zstd", "18",
    "--generate-mipmap",
    tmp, dst,
  ], { maxBuffer: 1 << 24 });
  fs.rmSync(tmp, { force: true });
  return { w: w4, h: h4, srcW: meta.width, srcH: meta.height, srgb, bytes: fs.statSync(dst).size };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(KTX)) throw new Error(`KTX-Software not found at ${KTX}`);
  const sharp = loadSharp();
  const files = [];
  for (const r of (o.paths.length ? o.paths : DEFAULT_ROOTS)) walk(r, files);
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : { version: 1, textures: {} };
  // Drop entries whose source is gone.
  for (const k of Object.keys(manifest.textures)) if (!fs.existsSync(path.join(PUBLIC, k))) delete manifest.textures[k];

  const todo = [];
  for (const rel of files) {
    const hash = createHash("sha1").update(fs.readFileSync(path.join(PUBLIC, rel))).digest("hex");
    const e = manifest.textures[rel];
    const fresh = e && e.hash === hash && e.max === (o.max || 0) && fs.existsSync(path.join(PUBLIC, ktx2PathFor(rel)));
    if (o.force || !fresh) todo.push({ rel, hash });
  }
  console.log(`${files.length} images, ${todo.length} to encode${o.dry ? " (dry run)" : ""}`);
  if (o.dry) { for (const t of todo) console.log(`  ${t.rel}  ${isLinearName(t.rel) ? "linear" : "sRGB"}`); return; }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ktx2-"));
  let done = 0, failed = 0, srcBytes = 0, outBytes = 0;
  const t0 = Date.now();
  const save = () => fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  const worker = async () => {
    for (let t; (t = todo.shift()); ) {
      try {
        const r = await encodeOne(sharp, t.rel, o.max, tmpDir);
        manifest.textures[t.rel] = { file: ktx2PathFor(t.rel), hash: t.hash, max: o.max || 0, ...r };
        srcBytes += fs.statSync(path.join(PUBLIC, t.rel)).size; outBytes += r.bytes;
        done++;
        const note = r.w !== r.srcW || r.h !== r.srcH ? `  (${r.srcW}×${r.srcH} → ${r.w}×${r.h})` : "";
        console.log(`  ✓ ${t.rel}  ${r.srgb ? "sRGB" : "linear"}  ${(r.bytes / 1024).toFixed(0)} KB${note}`);
        if (done % 10 === 0) save();
      } catch (err) {
        failed++;
        console.log(`  ✗ ${t.rel}: ${String(err.stderr || err.message).trim().split("\n")[0]}`);
      }
    }
  };
  fs.mkdirSync(OUT, { recursive: true });
  await Promise.all(Array.from({ length: o.jobs }, worker));
  save();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const mb = (b) => (b / 1048576).toFixed(1);
  console.log(`done: ${done} encoded, ${failed} failed, ${((Date.now() - t0) / 1000).toFixed(0)} s` +
    (done ? ` · files ${mb(srcBytes)} MB → ${mb(outBytes)} MB` : ""));
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
