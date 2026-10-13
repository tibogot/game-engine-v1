/**
 * A GROUND PHOTO REGRADED TO A NEW COLOUR (2026-10-13, map 3 — El Kantara): the terrain's paint tint
 * is a hex colour, it multiplies, so it can only DARKEN a photo; every sand / dirt photo we have
 * averages under half brightness and no warmer than tan. This writes a copy of a Poly Haven set
 * whose albedo keeps the photo's own light and dark (its luminance about its mean) but sits on a
 * new mean colour; the normal, rough and ao maps are copied unchanged under the new name.
 * (coast_sand_light was made the same way by hand, 2026-10-12.)
 *
 *   node tools/algGradePhoto.mjs --from coast_sand_01 --to desert_stony --mean c2a588 [--chroma 0.25] [--contrast 1]
 *
 *   --mean      the new mean colour (sRGB hex)
 *   --chroma    how much of the photo's own colour variation to keep (0 = only its luminance)
 *   --contrast  its luminance about the mean, scaled
 *
 * Needs jpeg-js (pure JS, not a dependency of the repo): JPEG_JS=<path to jpeg-js> or
 * `npm i --no-save jpeg-js`.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.from || !args.to || !args.mean) throw new Error("--from <set> --to <new set> --mean <hex>");
const require = createRequire(import.meta.url);
const jpeg = require(process.env.JPEG_JS ?? "jpeg-js");

const ROOT = "public/textures/ground";
const src = path.join(ROOT, args.from), dst = path.join(ROOT, args.to);
fs.mkdirSync(dst, { recursive: true });
const chroma = Number(args.chroma ?? 0.25), contrast = Number(args.contrast ?? 1);
const hex = args.mean.replace("#", "");
const target = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

for (const f of fs.readdirSync(src)) {
  const out = path.join(dst, f.replace(args.from, args.to));
  if (!/_diff_/.test(f)) { fs.copyFileSync(path.join(src, f), out); continue; }
  const img = jpeg.decode(fs.readFileSync(path.join(src, f)), { useTArray: true });
  const d = img.data, n = d.length / 4;
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += d[i * 4 + c] / n;
  const mLum = lumOf(...mean), tLum = lumOf(...target);
  for (let i = 0; i < n; i++) {
    const o = i * 4, l = lumOf(d[o], d[o + 1], d[o + 2]);
    const rel = 1 + (l / mLum - 1) * contrast;          // its light and dark about the mean
    for (let c = 0; c < 3; c++) {
      const own = d[o + c] / mean[c] - l / mLum;           // the photo's own colour, off its grey
      d[o + c] = Math.max(0, Math.min(255, Math.round(target[c] * (rel + own * chroma))));
    }
  }
  fs.writeFileSync(out, jpeg.encode({ data: d, width: img.width, height: img.height }, 92).data);
  console.log(`${out}: mean ${mean.map((v) => v.toFixed(0)).join(",")} (luma ${mLum.toFixed(0)}) → ${target.join(",")} (luma ${tLum.toFixed(0)})`);
}
// Each set listed for the Ground Lab, its size the source's.
const setsFile = path.join(ROOT, "sets.json"), sets = JSON.parse(fs.readFileSync(setsFile, "utf8"));
if (!sets.sets.some((s) => s.slug === args.to)) {
  const s = sets.sets.find((e) => e.slug === args.from);
  sets.sets.push({ ...s, slug: args.to, gradedFrom: args.from, mean: `#${hex}` });
  fs.writeFileSync(setsFile, JSON.stringify(sets, null, 1) + "\n");
}
