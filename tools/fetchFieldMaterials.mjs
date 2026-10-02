/**
 * FETCH THE FIELD MATERIALS — Poly Haven (CC0) photo sets for alg-rts' fields
 * (algFields.js). You, 2026-10-02: the procedural soil "looks not realistic
 * compared to the image textures we use in the game" — so the fields wear
 * photographed ground like the terrain round them.
 *
 * Four sets, packed into ONE 2x2 atlas pair (a field reads its own cell and
 * the soil cell: 4 taps, one draw for every field):
 *   cell 0  farm_furrows   ploughed land (its furrows, scaled up for the RTS camera;
 *                          the patch's clean middle, cropped groove to groove —
 *                          tiled MIRRORED both ways)
 *   cell 1  raked_dirt     stubble: raked earth with straw lying on it
 *   cell 2  sparse_grass   barley / green crop
 *   cell 3  farm_soil      the headland and the soil between crop rows
 *
 * Output (public/textures/fields/):
 *   fields_c.webp   colour, 2x2 cells of `--res` (default 1024)
 *   fields_n.webp   r, g = normal x, y (OpenGL, nor_gl) · b = height (disp)
 * Downloads the 1k (or 2k) jpgs to a temp dir; packs with Python + PIL.
 *
 *   node tools/fetchFieldMaterials.mjs [--res 1024]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FIELD_SLUGS = ["farm_furrows", "raked_dirt", "sparse_grass", "farm_soil"];
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const RES = arg("res", 1024);
const SRC = RES > 1024 ? "2k" : "1k";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public/textures/fields");
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fields-"));

for (const slug of FIELD_SLUGS) {
  const r = await fetch(`https://api.polyhaven.com/files/${slug}`);
  if (!r.ok) throw new Error(`polyhaven ${slug}: HTTP ${r.status}`);
  const f = await r.json();
  for (const [map, suffix] of [["Diffuse", "diff"], ["nor_gl", "nor"], ["Displacement", "disp"]]) {
    const e = f[map]?.[SRC]?.jpg ?? f[map]?.[SRC]?.png;
    if (!e?.url) { console.log(`  ${slug} ${suffix}: none`); continue; }
    const res = await fetch(e.url);
    fs.writeFileSync(path.join(tmp, `${slug}_${suffix}.${e.url.split(".").pop()}`), Buffer.from(await res.arrayBuffer()));
    console.log(`  ${slug} ${suffix}  ${(e.size / 1024).toFixed(0)} KB`);
  }
}

const py = `
import sys, glob, os
from PIL import Image
tmp, out, res, slugs = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4].split(",")
C = Image.new("RGB", (res * 2, res * 2)); N = Image.new("RGB", (res * 2, res * 2))
# farm_furrows is a PATCH, not a tile: a dark band down each side, a pale
# frame top and bottom. Its clean middle only (the shader tiles that cell
# MIRRORED, invisible along straight furrows).
# Down the rows the crop runs from the MIDDLE OF ONE GROOVE to the middle of
# another (the darkest rows near each end): mirrored there, the seam is a
# groove meeting itself — invisible (a plain repeat broke the furrows).
CROP = {"farm_furrows": [0.24, 0.04, 0.76, 0.96]}   # u: only the furrows' even middle (they darken toward the patch ends: a band at every mirror)
def groove_crop(slug):
    g = glob.glob(os.path.join(tmp, f"{slug}_diff.*"))[0]
    im = Image.open(g).convert("L"); w, h = im.size; a = CROP[slug]
    band = im.crop((int(a[0] * w), 0, int(a[2] * w), h)).resize((64, h))
    px = band.load()
    prof = [sum(px[x, y] for x in range(64)) for y in range(h)]
    k = max(1, h // 200)   # smooth
    sm = [sum(prof[max(0, y - k):y + k + 1]) / len(prof[max(0, y - k):y + k + 1]) for y in range(h)]
    lo = min(range(int(0.03 * h), int(0.2 * h)), key=lambda y: sm[y])
    hi = min(range(int(0.8 * h), int(0.97 * h)), key=lambda y: sm[y])
    a[1], a[3] = lo / h, hi / h
    print(f"  {slug}: grooves at {a[1]:.3f} and {a[3]:.3f}")
for s in CROP: groove_crop(s)
def load(slug, suffix, mode):
    g = glob.glob(os.path.join(tmp, f"{slug}_{suffix}.*"))
    if not g: return None
    im = Image.open(g[0]).convert(mode)
    if slug in CROP:
        w, h = im.size; a = CROP[slug]
        im = im.crop((int(a[0] * w), int(a[1] * h), int(a[2] * w), int(a[3] * h)))
    return im.resize((res, res), Image.LANCZOS)
for i, slug in enumerate(slugs):
    x, y = (i % 2) * res, (i // 2) * res
    C.paste(load(slug, "diff", "RGB"), (x, y))
    n = load(slug, "nor", "RGB"); d = load(slug, "disp", "L")
    r, g, _ = n.split()
    N.paste(Image.merge("RGB", (r, g, d if d else Image.new("L", (res, res), 128))), (x, y))
C.save(os.path.join(out, "fields_c.webp"), "WEBP", quality=90, method=6)
N.save(os.path.join(out, "fields_n.webp"), "WEBP", quality=92, method=6)
`;
const p = spawnSync("python", ["-c", py, tmp, out, String(RES), FIELD_SLUGS.join(",")], { stdio: "inherit" });
fs.rmSync(tmp, { recursive: true, force: true });
if (p.status !== 0) { console.error("python/PIL failed"); process.exit(1); }
for (const n of ["fields_c.webp", "fields_n.webp"]) console.log(`  ${n}  ${(fs.statSync(path.join(out, n)).size / 1024).toFixed(0)} KB`);
