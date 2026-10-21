// CHECK LEVELS BEFORE SHIPPING (2026-10-21, EDITOR_REVIEW_2026_10 C15). A game only finds a level's
// problems at run time — a missing texture or model is a console.warn in the middle of a match. This
// reads each .v3proj and reports, per level:
//   ERRORS   (exit 1): a file it names that is not in public/ · an embedded `asset:` ref with no asset ·
//            NaN / Infinity heights · an instance pointing at a slot that doesn't exist · a prop slot
//            that can't be restored (a GLB imported from disk and not embedded)
//   WARNINGS:          objects outside the world · heights pinned at 0 or maxHeight (clipped) ·
//                      retired keys still in the file (groundTsl, meadowTsl, foliage)
//   STATS:             file / blob sizes, object counts — to compare levels and spot a bloated one
//
//   node tools/levelCheck.mjs                        every level in public/levels
//   node tools/levelCheck.mjs public/levels/a.v3proj  just these
//   options: --quiet (only levels with problems) · --json (machine-readable)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const { readProject } = await import(pathToFileURL(path.join(ROOT, "tools/lib/v3proj.mjs")).href);

const FILE_REF = /\.(glb|gltf|png|jpe?g|webp|ktx2|hdr|exr|bin|json|wav|mp3|ogg)(\?.*)?$/i;
const RETIRED_KEYS = ["groundTsl", "meadowTsl", "foliage"];

/** Every string in the manifest that names a file served from public/ ("/textures/…"). */
function fileRefs(manifest) {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === "string") { if (v.startsWith("/") && FILE_REF.test(v)) out.push({ ref: v, at: p }); }
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) if (k !== "blobs") walk(v[k], p ? `${p}.${k}` : k);
  };
  walk(manifest, "");
  return out;
}

function assetRefs(manifest) {
  const s = JSON.stringify(manifest), out = new Set();
  for (const m of s.matchAll(/asset:([0-9a-f]{40})/g)) out.add(m[1]);
  return out;
}

export async function checkLevel(file) {
  const errors = [], warnings = [], stats = {};
  const size = fs.statSync(file).size;
  let p;
  try { p = await readProject(file); }
  catch (err) { return { file, errors: [`cannot be read: ${err.message}`], warnings, stats }; }
  const m = p.manifest, t = m.terrain ?? {};
  const W = t.worldSize ?? 0, half = W / 2, maxH = t.maxHeight ?? 0, hm = t.heightmapSize ?? 0;
  stats.fileMB = +(size / 1048576).toFixed(1);
  stats.terrain = `${W} m, ${hm}², max ${maxH} m`;

  // ── terrain ──
  if (!(W > 0) || !(hm > 0) || !(maxH > 0)) errors.push(`terrain config incomplete: ${JSON.stringify(t)}`);
  if (hm && (hm & (hm - 1))) warnings.push(`heightmap ${hm}² is not a power of two`);
  const hb = p.blobs.get("heightmap");
  if (!hb) errors.push("no heightmap blob");
  else {
    const h = new Float32Array(hb.buffer, hb.byteOffset, hb.byteLength >> 2);
    if (hm && h.length !== hm * hm) errors.push(`heightmap has ${h.length} samples, terrain says ${hm}² = ${hm * hm}`);
    let bad = 0, lo = Infinity, hi = -Infinity, atTop = 0;
    for (const v of h) {
      if (!Number.isFinite(v)) { bad++; continue; }
      if (v < lo) lo = v; if (v > hi) hi = v;
      if (v >= 0.9999) atTop++;
    }
    if (bad) errors.push(`${bad} heightmap samples are NaN / Infinity`);
    stats.heights = `${(lo * maxH).toFixed(1)} … ${(hi * maxH).toFixed(1)} m`;
    if (atTop > h.length * 0.001) warnings.push(`${atTop} heightmap samples sit at max height ${maxH} m (clipped peaks?)`);
  }

  // ── files it names ──
  const refs = fileRefs(m);
  const missing = new Map();
  for (const { ref, at } of refs) {
    const local = path.join(PUBLIC, decodeURIComponent(ref.split("?")[0]));
    if (!fs.existsSync(local)) missing.set(ref, at);
  }
  for (const [ref, at] of missing) errors.push(`missing file ${ref}  (${at})`);
  stats.filesNamed = new Set(refs.map((r) => r.ref)).size;
  const assetList = new Set((m.assets ?? []).map((a) => a.hash ?? a.id ?? a).filter(Boolean));
  for (const h of assetRefs(m)) if (!assetList.has(h) && ![...p.blobs.keys()].some((k) => k.includes(h))) {
    errors.push(`embedded asset asset:${h.slice(0, 10)}… is referenced but not in the file`);
  }

  // ── props ──
  const pslots = m.props?.slots ?? [], pinst = m.props?.instances ?? [];
  pslots.forEach((s, i) => {
    const restorable = s.builtin || s.live || s.factoryId || s.rock || s.kind || s.assetRef || s.asset || s.glbRef
      || JSON.stringify(s).includes("asset:");
    if (!restorable) errors.push(`prop slot ${i} "${s.name}" can't be restored in a game (a GLB imported from disk, not embedded)`);
  });
  let pOut = 0, pBad = 0;
  for (const it of pinst) {
    if (!(it.typeIdx >= 0 && it.typeIdx < pslots.length)) pBad++;
    if (Math.abs(it.px) > half || Math.abs(it.pz) > half) pOut++;
  }
  if (pBad) errors.push(`${pBad} props point at a slot that doesn't exist`);
  if (pOut) warnings.push(`${pOut} props outside the ${W} m world`);
  stats.props = `${pinst.length} in ${pslots.length} slots`;

  // ── trees ──
  const tslots = m.trees?.slots ?? [], tinst = m.trees?.instances ?? [];
  let tOut = 0, tBad = 0;
  for (const it of tinst) {
    const [x, z, , , , slot] = it;
    if (Math.abs(x) > half || Math.abs(z) > half) tOut++;
    if (!(slot >= 0 && slot < tslots.length)) tBad++;
  }
  if (tBad) errors.push(`${tBad} trees point at a slot that doesn't exist`);
  if (tOut) warnings.push(`${tOut} trees outside the world`);
  stats.trees = tinst.length;

  // ── decals ──
  const dslots = m.decals?.slots ?? [], dinst = m.decals?.decals ?? m.decals?.instances ?? [];
  let dOut = 0, dBad = 0;
  for (const d of dinst) {
    if (Math.abs(d.px) > half || Math.abs(d.pz) > half) dOut++;
    if (!(d.slot >= 0 && d.slot < dslots.length)) dBad++;
  }
  if (dBad) errors.push(`${dBad} decals point at a slot that doesn't exist`);
  if (dOut) warnings.push(`${dOut} decals outside the world`);
  stats.decals = dinst.length;

  // ── the rest ──
  const sp = m.spawn;
  if (sp && (Math.abs(sp.x) > half || Math.abs(sp.z) > half)) warnings.push(`player start (${sp.x}, ${sp.z}) is outside the world`);
  for (const k of RETIRED_KEYS) if (m[k] != null) warnings.push(`retired key "${k}" still in the file (ignored; a re-save drops it)`);
  stats.lakes = m.lakes?.lakes?.length ?? (Array.isArray(m.lakes) ? m.lakes.length : 0);
  stats.rivers = (m.riversV2?.rivers?.length ?? 0) + (m.riverNetwork?.rivers?.length ?? m.riverNetwork?.channels?.length ?? 0);
  stats.blobsMB = Object.fromEntries([...p.blobs].map(([k, b]) => [k, +(b.length / 1048576).toFixed(2)]).filter(([, v]) => v >= 0.5));
  return { file, errors, warnings, stats };
}

async function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet"), asJson = args.includes("--json");
  let files = args.filter((a) => !a.startsWith("--"));
  if (!files.length) {
    const dir = path.join(PUBLIC, "levels");
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".v3proj")).sort().map((f) => path.join(dir, f));
  }
  const results = [];
  for (const f of files) results.push(await checkLevel(f));
  if (asJson) { console.log(JSON.stringify(results, null, 1)); }
  else {
    for (const r of results) {
      if (quiet && !r.errors.length && !r.warnings.length) continue;
      const tag = r.errors.length ? "ERRORS" : r.warnings.length ? "warn  " : "ok    ";
      const s = r.stats;
      console.log(`${tag} ${path.basename(r.file)}  ${s.fileMB ?? "?"} MB · ${s.terrain ?? ""} · heights ${s.heights ?? "?"} · props ${s.props ?? 0} · trees ${s.trees ?? 0} · decals ${s.decals ?? 0} · files ${s.filesNamed ?? 0}`);
      for (const e of r.errors) console.log(`    ✗ ${e}`);
      for (const w of r.warnings) console.log(`    ! ${w}`);
    }
    const ne = results.reduce((a, r) => a + r.errors.length, 0), nw = results.reduce((a, r) => a + r.warnings.length, 0);
    console.log(`${results.length} levels · ${ne} errors · ${nw} warnings`);
  }
  if (results.some((r) => r.errors.length)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
