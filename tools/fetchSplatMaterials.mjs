/**
 * FETCH THE SPLAT MATERIALS — Poly Haven (CC0) sets for ground SPLATS.
 *
 * Splats are Company of Heroes' ground detail: patches of one material (cracked
 * mud, gravel, rubble, a scorch) laid by the hundred over a few base tiles,
 * each rotated, scaled and tinted. The engine bakes them into the ground cache
 * (v3/terrain/groundCache.js), so they cost nothing per frame. Each needs its
 * colour, normal, roughness and HEIGHT: the height is what breaks a splat's
 * edge along the material's own pebbles and cracks instead of a soft circle.
 *
 *   node tools/fetchSplatMaterials.mjs            # download what is missing
 *   node tools/fetchSplatMaterials.mjs --force    # download everything again
 *
 * Downloads 1k jpg under public/textures/splats/<slug>/. What SHIPS is two
 * 512² WebPs per material (v3/terrain/splatMaterials.js reads only those):
 *   <slug>_c.webp  the colour
 *   <slug>_s.webp  r, g = normal x, y (nor_gl) · b = height (disp)
 * Node has no image codec here, so the packing runs in a browser tab on the
 * dev server: draw each jpg into a 512² canvas, merge the channels, and
 * convertToBlob({ type: "image/webp", quality: 0.9 }); then delete the jpgs
 * (52 MB of 1k jpg → 3.7 MB, 2026-10-01). A splat tile is 2-5 m, so 512
 * texels over it is still finer than the cache's 2 cm.
 */
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = "public/textures/splats";
const RES = "1k";
const force = process.argv.includes("--force");

/** Poly Haven map name → file suffix we keep. */
const MAPS = [["Diffuse", "diff"], ["nor_gl", "nor_gl"], ["Rough", "rough"], ["Displacement", "disp"]];

/** The library (slugs). Keep in step with games' splat rules. */
export const SPLAT_SLUGS = [
  "dry_ground_rocks", "mud_cracked_dry_03", "mud_cracked_dry_riverbed_002", "dry_riverbed_rock",
  "rocky_gravel", "sandy_gravel", "rocks_ground_02", "burned_ground_01", "dry_decay_leaves",
  "red_sand", "farm_furrows", "stony_dirt_path", "rubble", "cracked_red_ground",
  "river_small_rocks", "muddy_tracks", "dry_ground_01",
];

async function files(slug) {
  const r = await fetch(`https://api.polyhaven.com/files/${encodeURIComponent(slug)}`);
  if (!r.ok) throw new Error(`polyhaven ${slug}: HTTP ${r.status}`);
  return r.json();
}

let bytesTotal = 0;
for (const slug of SPLAT_SLUGS) {
  const f = await files(slug);
  const dir = path.join(OUT_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const got = [];
  for (const [ph, suffix] of MAPS) {
    const entry = f[ph]?.[RES]?.jpg ?? f[ph]?.[RES]?.png;
    if (!entry?.url) { got.push(`${suffix}:—`); continue; }
    const ext = entry.url.split(".").pop();
    const dest = path.join(dir, `${slug}_${suffix}.${ext}`);
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size === entry.size) { got.push(`${suffix}:ok`); continue; }
    const r = await fetch(entry.url);
    if (!r.ok) throw new Error(`${entry.url}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(dest, buf);
    bytesTotal += buf.length;
    got.push(`${suffix}:${Math.round(buf.length / 1024)}K`);
  }
  console.log(`${slug.padEnd(30)} ${got.join("  ")}`);
}
console.log(`\ndownloaded ${(bytesTotal / 1e6).toFixed(1)} MB into ${OUT_DIR}/`);
