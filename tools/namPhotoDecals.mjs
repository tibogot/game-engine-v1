/**
 * Swap nam-valley's decals onto the PHOTOGRAPHIC set (v3/render/decals/
 * decalPhotoArt.js) and re-lay the existing decals so the new art fits them.
 *
 * The art is baked in the browser (it needs a canvas to decode the photos):
 *
 *   const M = await import('/v3/render/decals/decalPhotoArt.js');
 *   // for each [kind, seed]: M.bakePhotoDecal(kind, { seed }) ->
 *   //   { size, albedo.toDataURL('image/webp', 0.9), normal.toDataURL('image/webp', 0.95) }
 *
 * saved as one JSON `{ "<kind>_<seed>": { kind, seed, size, albedo, normal } }`.
 * This tool writes those to public/textures/decals/nam/ and patches the map.
 *
 *   node tools/namPhotoDecals.mjs <bake.json> [--dry]
 *   node tools/namPhotoDecals.mjs <bake.json> --files-only
 *
 * --files-only writes the images and stops: for a RE-BAKE of art the map
 * already uses (same `<kind>_<seed>` keys, so same paths). The first run
 * renames the slots, so running the full patch twice would find nothing to
 * re-lay anyway.
 *
 * WHAT THE RE-LAY DOES, AND WHY
 * -----------------------------
 * Each recipe is baked FOR a box of a given size in metres (the photo is
 * sampled in metres), so a decal must be placed at that size or its grain
 * stretches — the old ruts were 25 × 6 m boxes wearing a square image, 4x
 * coarser along their length than across.
 *
 *   ruts / track marks  25 m strips -> 10 m segments, overlapping by ENDFADE so
 *                       the faded ends cross-fade; width to the art's (3.2/4.4)
 *   foot paths          13 m strips -> 10 m segments, width 2.4
 *   mud / puddles       made square at the same area (art is round)
 *   aprons / scorch /   size kept — they were placed to fit what they sit
 *   debris / craters    round, and the art is round
 *
 * Variants: several bakes of one kind are separate slots; each decal picks one
 * by a hash of its position, so the same one always gets the same one.
 *
 * Refuses to LOSE decals: every old one maps to one or more new ones.
 */
import fs from "node:fs";
import path from "node:path";
import { readProject, writeProject } from "./lib/v3proj.mjs";

const LEVEL = "public/levels/nam-valley.v3proj";
const OUT = "public/textures/decals/nam";
const ENDFADE = 1.5;   // decalPhotoArt ENDFADE_M

const bakePath = process.argv[2];
const dry = process.argv.includes("--dry");
if (!bakePath) {
  console.error("usage: node tools/namPhotoDecals.mjs <bake.json> [--dry]");
  process.exit(1);
}

// The MCP tool that saved the bake may prefix a line of prose; take the JSON.
const raw = fs.readFileSync(bakePath, "utf8");
const bake = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));

// ── files ───────────────────────────────────────────────────────────────────
const files = {};
for (const [key, b] of Object.entries(bake)) {
  const put = (suffix, dataUrl) => {
    const m = String(dataUrl).match(/^data:image\/(webp|png);base64,(.+)$/);
    if (!m) throw new Error(`${key}: not a webp/png data URL`);
    const name = `${key}${suffix}.${m[1]}`;
    if (!dry) {
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(m[2], "base64"));
    }
    return `/textures/decals/nam/${name}`;
  };
  files[key] = { albedoUrl: put("", b.albedo), normalUrl: put("_n", b.normal), size: b.size, kind: b.kind };
}
const variants = (kind) => Object.keys(files).filter((k) => files[k].kind === kind).sort();

if (process.argv.includes("--files-only")) {
  for (const [k, f] of Object.entries(files)) console.log(`${dry ? "would write" : "wrote"} ${f.albedoUrl}  ${f.normalUrl}  (${k})`);
  process.exit(0);
}

// ── slots ───────────────────────────────────────────────────────────────────
// The OLD slot index of each kind stays that kind (so nothing else in the map
// that names a slot changes meaning); extra variants are appended.
const { version, manifest, blobs, fileBytes } = await readProject(LEVEL);
const D = manifest.decals;
const oldSlots = D.slots;
const byName = (name) => oldSlots.findIndex((s) => s.name === name);

const MAP = [
  // [old slot name, photo kind, opacity, roughness, relay]
  // Mud 0.4, judged in the game: 0.3 threw white glints off every wet bump
  // (read as snow), 0.55 made the patch vanish.
  ["Mud",         "mud",        0.95, 0.4,  "square"],
  ["Wheel ruts",  "ruts",       0.9,  0.9,  "strip"],
  ["Scorch",      "scorch",     null, 0.95, "keep"],
  ["footPath",    "footPath",   0.9,  0.95, "strip"],
  ["dirtApron",   "apron",      1.0,  0.85, "keep"],
  ["puddle",      "puddle",     1.0,  0.08, "square"],
  ["trackMarks",  "tankTracks", 0.9,  0.9,  "strip"],
  ["debrisRays",  "debris",     0.9,  0.95, "keep"],
];

const slots = oldSlots.map((s) => ({ ...s }));
const slotsOf = {};   // kind -> [slot indices], first = the old slot
for (const [name, kind] of MAP) {
  const i = byName(name);
  if (i < 0) { console.log(`slot "${name}" not in this map — skipped`); continue; }
  const vs = variants(kind);
  if (!vs.length) throw new Error(`no bake for kind "${kind}"`);
  slots[i] = { name: `${kind} (photo)`, albedoUrl: files[vs[0]].albedoUrl, normalUrl: files[vs[0]].normalUrl };
  slotsOf[kind] = [i];
  for (const v of vs.slice(1)) {
    slotsOf[kind].push(slots.length);
    slots.push({ name: `${kind} (photo ${v.split("_").pop()})`, albedoUrl: files[v].albedoUrl, normalUrl: files[v].normalUrl });
  }
}

// ── re-lay ──────────────────────────────────────────────────────────────────
/** Rotate (0,0,z) by the decal's quaternion: its local length axis in world. */
function axisZ(d) {
  const { qx: x, qy: y, qz: z, qw: w } = d;
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}
const hash = (d) => {
  let h = Math.imul(Math.round(d.px * 10), 73856093) ^ Math.imul(Math.round(d.pz * 10), 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h >>> 0) / 4294967296;
};

const out = [];
const count = {};
for (const d of D.decals) {
  const oldName = oldSlots[d.slot]?.name;
  const row = MAP.find((m) => m[0] === oldName);
  if (!row || !slotsOf[row[1]]) { out.push(d); continue; }
  const [, kind, opacity, roughness, relay] = row;
  const [W, L] = files[variants(kind)[0]].size;
  const pick = (dd) => { const s = slotsOf[kind]; return s[Math.floor(hash(dd) * s.length) % s.length]; };
  const base = {
    ...d,
    opacity: opacity ?? Math.min(0.9, d.opacity * 1.3),
    roughness,
    normalStrength: 1,
  };
  if (relay === "strip") {
    // Segments of L with ENDFADE overlap, centred on the old strip.
    const step = L - ENDFADE;
    const nSeg = Math.max(1, Math.ceil((d.sz - ENDFADE) / step));
    const span = (nSeg - 1) * step;
    const [ax, ay, az] = axisZ(d);
    for (let s = 0; s < nSeg; s++) {
      const off = -span / 2 + s * step;
      const seg = { ...base, px: d.px + ax * off, py: d.py + ay * off, pz: d.pz + az * off, sx: W, sz: L };
      seg.slot = pick(seg);
      out.push(seg);
    }
  } else if (relay === "square") {
    const s = Math.sqrt(d.sx * d.sz);
    const sq = { ...base, sx: s, sz: s };
    sq.slot = pick(sq);
    out.push(sq);
  } else {
    const k = { ...base };
    k.slot = pick(k);
    out.push(k);
  }
  count[kind] = (count[kind] ?? 0) + 1;
}
// Unique ids for anything the system keys on.
out.forEach((d, i) => { if ("id" in d) d.id = i; });

// ── report + write ──────────────────────────────────────────────────────────
console.log(`${LEVEL}  v${version}  ${(fileBytes / 1e6).toFixed(1)} MB`);
console.log(`slots ${oldSlots.length} -> ${slots.length}`);
slots.forEach((s, i) => console.log(`  ${String(i).padStart(2)} ${s.name}`));
const perSlot = {};
for (const d of out) perSlot[d.slot] = (perSlot[d.slot] ?? 0) + 1;
console.log(`decals ${D.decals.length} -> ${out.length}`);
for (const [i, n] of Object.entries(perSlot)) console.log(`  slot ${String(i).padStart(2)} ${slots[i].name.padEnd(24)} ${n}`);
if (out.length < D.decals.length) {
  console.error("REFUSING: that would drop decals.");
  process.exit(1);
}
console.log(`files -> ${OUT}/ (${Object.keys(files).length} bakes × 2)`);

if (dry) { console.log("\ndry run — nothing written"); process.exit(0); }

manifest.decals = { ...D, slots, decals: out };
fs.copyFileSync(LEVEL, `${LEVEL}.bak`);
const written = await writeProject(LEVEL, { manifest, blobs });
console.log(`\nwrote ${(written / 1e6).toFixed(1)} MB (was ${(fileBytes / 1e6).toFixed(1)} MB); previous kept at nam-valley.v3proj.bak`);
