/**
 * FETCH BUILDING MATERIALS — Poly Haven (CC0) photo materials for alg-rts's buildings (2026-10-11,
 * you: "everything but the new rocks reads cheap"), at 1k, into
 * public/textures/build/<slug>/<slug>_{diff,nor_gl,rough}_1k.jpg. The buildings are built the way
 * the sandstone rocks are (algSandstone.js): real photos projected in the piece's own space, their
 * normal maps for the relief — not the kit atlas's painted cells.
 *
 *   node tools/fetchBuildingMaterials.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "public/textures/build");

// The picks: dry rubble stone in mud mortar (the Aurès houses), a clay plaster, raw planks and a
// willow's bark (beams, logs), burlap (sacks, tarps), a reed thatch (brush on the roofs).
export const PICKS = ["rabdentse_ruins_wall", "clay_plaster", "raw_plank_wall", "bark_willow_02", "hessian_230", "reed_roof_04"];
const MAPS = [["Diffuse", "diff"], ["nor_gl", "nor_gl"], ["Rough", "rough"]];

for (const slug of PICKS) {
  const dir = path.join(DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const files = await (await fetch(`https://api.polyhaven.com/files/${slug}`)).json().catch(() => null);
  if (!files) { console.log(`  ${slug}: not found`); continue; }
  for (const [ph, suf] of MAPS) {
    const out = path.join(dir, `${slug}_${suf}_1k.jpg`);
    if (fs.existsSync(out)) continue;
    const e = files[ph]?.["1k"]?.jpg;
    if (!e?.url) { console.log(`  ${slug}: no ${ph}`); continue; }
    fs.writeFileSync(out, Buffer.from(await (await fetch(e.url)).arrayBuffer()));
  }
  let size = null;
  try { const info = await (await fetch(`https://api.polyhaven.com/info/${slug}`)).json(); size = info?.dimensions ? +(info.dimensions[0] / 1000).toFixed(2) : null; } catch { /* offline */ }
  console.log(`  ${slug}: ok${size ? ` (${size} m a tile)` : ""}`);
}
