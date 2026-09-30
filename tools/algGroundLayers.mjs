/**
 * THE AURÈS PAINT LAYERS, RE-CHOSEN (2026-10-01; you: "those textures are
 * tiling and it doesn't look good at all … maybe their uv scale is wrong").
 *
 * What was wrong, photo by photo (each looked at, at its real size):
 *   Scree      gravelly_sand — almost pure fine orange sand; at any scale it
 *              reads as smooth plastic sand, never as scree. → rocks_ground_02
 *              (brown ground, gravel, loose angular rocks).
 *   Ridge      rock_boulder_cracked — pink, and at 7× its size the cracks make
 *              metre-wide polygons like dried mud. → rock_boulder_dry (pale
 *              grey-beige limestone: the Aurès).
 *   Cliff      cliff_side — orange sandstone strata, 16 m for a 1.8 m photo:
 *              every gully wall read as red paint. → rock_boulder_dry too,
 *              darker and warmer than the ridge (tried first: kept + tinted,
 *              still orange).
 * Soil (brown_mud_dry), wadi (rocky_trail), grove and track are kept.
 * Repetition itself is the ground cache's hex tiling (groundCache.js), not
 * the scale.
 *
 *   node tools/algGroundLayers.mjs          # fetch + write (keeps .bak)
 *   node tools/algGroundLayers.mjs --dry
 */
import fs from "node:fs";
import path from "node:path";
import { readProject, writeProject } from "./lib/v3proj.mjs";

const LEVEL = "public/levels/alg-aures.v3proj";
const OUT_DIR = "public/textures/ground";
const dry = process.argv.includes("--dry");

const MAPS = [["Diffuse", "albedo", "diff"], ["nor_gl", "normal", "nor_gl"], ["Rough", "rough", "rough"], ["AO", "ao", "ao"]];

/** slot → { slug (omit = keep the maps), tileM, tint } */
const PLAN = {
  1: { slug: "rock_boulder_dry", tileM: 7, tint: "#ddd3c4", name: "Limestone ridge" },
  2: { slug: "rocks_ground_02", tileM: 6, tint: "#ffffff", name: "Scree slope" },
  // The same limestone as the ridge, darker and warmer: the orange sandstone
  // strata (cliff_side) read as red paint on every gully wall.
  5: { slug: "rock_boulder_dry", tileM: 8, tint: "#c9b8a2", name: "Cliff rock" },
};

async function fetchSet(slug) {
  const r = await fetch(`https://api.polyhaven.com/files/${slug}`);
  if (!r.ok) throw new Error(`polyhaven ${slug}: HTTP ${r.status}`);
  const files = await r.json();
  const refs = {};
  for (const [ph, field, suffix] of MAPS) {
    const e = files[ph]?.["1k"]?.jpg;
    if (!e?.url) { refs[field] = null; continue; }
    const name = `${slug}_${suffix}_1k.jpg`;
    const dest = path.join(OUT_DIR, slug, name);
    if (!dry && !(fs.existsSync(dest) && fs.statSync(dest).size === e.size)) {
      const b = Buffer.from(await (await fetch(e.url)).arrayBuffer());
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, b);
    }
    refs[field] = { name, url: `/textures/ground/${slug}/${name}` };
  }
  return refs;
}

const project = await readProject(LEVEL);
const W = project.manifest.terrain.worldSize;
const layers = project.manifest.paintLayers;
for (const [slotKey, p] of Object.entries(PLAN)) {
  const L = layers[Number(slotKey)];
  const was = `${L.name} · ${L.albedo?.name} · tile ${(W / L.uvScale).toFixed(1)} m · tint ${L.tint}`;
  if (p.slug) Object.assign(L, await fetchSet(p.slug));
  if (p.name) L.name = p.name;
  L.uvScale = Math.round(W / p.tileM);
  L.tint = p.tint;
  console.log(`slot ${slotKey}: ${was}\n     → ${L.name} · ${L.albedo?.name} · tile ${(W / L.uvScale).toFixed(1)} m · tint ${L.tint}`);
}
if (dry) { console.log("dry run — nothing written"); process.exit(0); }
fs.copyFileSync(LEVEL, `${LEVEL}.bak`);
await writeProject(LEVEL, project);
console.log(`wrote ${LEVEL} (previous kept as .bak)`);
