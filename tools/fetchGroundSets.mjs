/**
 * FETCH GROUND SETS — Poly Haven (CC0) ground materials for the terrain's
 * paint layers, at 1k (the terrain's layer array is one size), into
 * public/textures/ground/<slug>/<slug>_{diff,nor_gl,rough,ao}_1k.jpg, and the
 * list the GROUND LAB offers (public/textures/ground/sets.json: every set on
 * disk, its maps and its REAL size in metres — Poly Haven's `dimensions`,
 * for the tile scale).
 *
 * The picks (2026-10-02, research for the Aurès): AERIAL sets (20-25 m of
 * ground in one photo — they hold up from an RTS camera without tiling) and
 * dry close-range ground for the near detail. All CC0.
 *
 *   node tools/fetchGroundSets.mjs            download what is missing, rewrite sets.json
 *   node tools/fetchGroundSets.mjs --list     only rewrite sets.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public/textures/ground");

export const PICKS = [
  // aerial: whole stretches of ground in one photo
  "dirt_aerial_03", "dirt_aerial_02", "aerial_ground_rock", "coast_sand_05",
  // dry close-range ground
  "dry_ground_01", "dry_ground_rocks", "sandy_gravel_02", "red_mud_stones", "terrain_red_01",
  "mud_cracked_dry_03", "rocks_ground_05", "dry_decay_leaves",
];
const MAPS = [["Diffuse", "diff"], ["nor_gl", "nor_gl"], ["Rough", "rough"], ["AO", "ao"]];

const listOnly = process.argv.includes("--list");
if (!listOnly) {
  for (const slug of PICKS) {
    const dir = path.join(DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    const files = await (await fetch(`https://api.polyhaven.com/files/${slug}`)).json().catch(() => null);
    if (!files) { console.log(`  ${slug}: not found`); continue; }
    for (const [ph, suf] of MAPS) {
      const out = path.join(dir, `${slug}_${suf}_1k.jpg`);
      if (fs.existsSync(out)) continue;
      const e = files[ph]?.["1k"]?.jpg;
      if (!e?.url) continue;
      fs.writeFileSync(out, Buffer.from(await (await fetch(e.url)).arrayBuffer()));
    }
    console.log(`  ${slug}: ok`);
  }
}

// sets.json: every folder with a diffuse, its maps and real size.
const sets = [];
for (const slug of fs.readdirSync(DIR)) {
  const d = path.join(DIR, slug);
  if (!fs.statSync(d).isDirectory() || !fs.existsSync(path.join(d, `${slug}_diff_1k.jpg`))) continue;
  const maps = MAPS.map(([, s]) => s).filter((s) => fs.existsSync(path.join(d, `${slug}_${s}_1k.jpg`)));
  let size = null;
  try {
    const info = await (await fetch(`https://api.polyhaven.com/info/${slug}`)).json();
    if (info?.dimensions) size = +(info.dimensions[0] / 1000).toFixed(2);   // mm → m
  } catch { /* offline: unknown */ }
  sets.push({ slug, maps, size, aerial: /aerial|rocky_terrain_02|coast_sand_05/.test(slug) });
}
sets.sort((a, b) => (b.aerial - a.aerial) || a.slug.localeCompare(b.slug));
fs.writeFileSync(path.join(DIR, "sets.json"), JSON.stringify({ note: "Ground sets for the Ground Lab (tools/fetchGroundSets.mjs). size: metres one photo spans (Poly Haven).", sets }, null, 1));
console.log(`sets.json: ${sets.length} sets`);
