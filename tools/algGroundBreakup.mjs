// GROUND BREAKUP — the alg-rts map's ground in PATCHES, not one brown (the AAA gap list, 2026-10-07:
// "terrain detail first — what would look like Company of Heroes"). CoH's ground is a few base
// textures broken up at the 10-60 m scale: patches of other earth, stony ground, and the ground WORN
// where men and vehicles live. Ours was valley soil end to end at play zoom.
//
//   node tools/algGroundBreakup.mjs [--dry]
//
// What it does to public/levels/alg-aures.v3proj (re-runnable: it starts from the layers as they are,
// so run it once after algTracks / algVegetation, or restore the map first):
//   SLOT 1   "Limestone ridge" used the SAME photo as slot 5 "Cliff rock": its weight goes to slot 5,
//            and slot 1 becomes "Red earth" (red_dirt_mud_01, tinted to the Aurès' ochre-red).
//   RED      soft patches of red earth over the valley soil, 20-60 m, edges bitten by fine noise.
//   STONY    sparser patches of scree (slot 2) where the ground is rougher.
//   WORN     the ground round the post, the villages, the camp and the wells trampled pale (the track
//            material, slot 6), strongest at the centre, broken at the edge, with spokes along the
//            approaches. Only where valley soil is the ground (not the wadi, oasis, rock, tracks).
// Then run `node tools/algVegetation.mjs` if the plants should follow (slot 6 stays bare of trees).
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { LAYOUT, PLAY } from "../games/alg-rts/layout.js";

const FILE = "public/levels/alg-aures.v3proj";
const dry = process.argv.includes("--dry");
const project = await readProject(FILE);
const man = project.manifest;
const W = man.terrain.worldSize, RES = man.splatRes, texel = W / RES;
const splat = project.blobs.get("splat");
const off = RES * RES * 4;
const ch = (q, c) => (c < 4 ? q + c : off + q + c - 4);

// ── noise (value noise, smooth) ─────────────────────────────────────────────
const hash = (x, y, s) => {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s, 1442695041)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
};
const vnoise = (x, y, s) => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};
const fbm = (x, y, s, o = 3) => { let t = 0, a = 0.5, f = 1, n = 0; for (let k = 0; k < o; k++) { t += vnoise(x * f, y * f, s + k) * a; n += a; a *= 0.5; f *= 2; } return t / n; };
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ── slot 1: limestone → cliff rock; slot 1 = red earth ──────────────────────
const tex = (id) => {
  const f = (m) => ({ name: `${id}_${m}_1k.jpg`, url: `/textures/ground/${id}/${id}_${m}_1k.jpg` });
  return { albedo: f("diff"), normal: f("nor_gl"), rough: f("rough"), ao: f("ao") };
};
let moved = 0;
if (man.paintLayers[1].name !== "Red earth") {
  for (let q = 0; q < RES * RES * 4; q += 4) {
    const w1 = splat[ch(q, 1)];
    if (!w1) continue;
    splat[ch(q, 5)] = Math.min(255, splat[ch(q, 5)] + w1);
    splat[ch(q, 1)] = 0;
    moved++;
  }
}
man.paintLayers[1] = {
  ...man.paintLayers[1], name: "Red earth", ...tex("red_dirt_mud_01"),
  uvScale: 64, normalStr: 1.6, aoStr: 0.8, roughStr: 1, triplanar: false, tint: "#d2bca6",   // ochre-red: the first #e8c8a8 read orange
  blocksGrass: false, blocksTrees: false,
};

// ── painting helper: put weight w (0..1) of slot `s` on a texel, scaling the rest ─
function put(k, s, w) {
  if (w <= 0.004) return false;
  const q = k * 4;
  const cur = splat[ch(q, s)] / 255;
  if (w <= cur) return false;
  const keep = (1 - w) / Math.max(1e-6, 1 - cur);
  for (let c = 0; c < 7; c++) if (c !== s) splat[ch(q, c)] = Math.round(splat[ch(q, c)] * keep);
  splat[ch(q, s)] = Math.min(255, Math.round(w * 255));
  return true;
}
const soilShare = (k) => { const q = k * 4; let t = 0; for (let c = 0; c < 7; c++) t += splat[ch(q, c)]; return t ? splat[ch(q, 0)] / t : 0; };

// Inside the battle box, with a margin the camera can see.
const M = 60;
const px0 = Math.max(0, Math.floor((PLAY.x0 - M + W / 2) / texel)), px1 = Math.min(RES - 1, Math.ceil((PLAY.x1 + M + W / 2) / texel));
const pz0 = Math.max(0, Math.floor((PLAY.z0 - M + W / 2) / texel)), pz1 = Math.min(RES - 1, Math.ceil((PLAY.z1 + M + W / 2) / texel));

// Wear centres: every site (the post's the biggest), its radius out a bit.
const WEAR = LAYOUT.sites.filter((s) => s.kind !== "pass").map((s) => ({
  x: s.x, z: s.z, r: s.r * (s.kind === "french" ? 1.35 : s.kind === "point" ? 1.0 : 1.15), peak: s.kind === "french" ? 0.9 : 0.75,
}));

let red = 0, stony = 0, worn = 0;
for (let pz = pz0; pz <= pz1; pz++) for (let px = px0; px <= px1; px++) {
  const k = pz * RES + px;
  const x = (px + 0.5) * texel - W / 2, z = (pz + 0.5) * texel - W / 2;
  const soil = soilShare(k);
  if (soil < 0.55) continue;                         // only valley soil gets broken up
  const edge = (vnoise(x / 2.3, z / 2.3, 7) - 0.5) * 0.35;   // fine bite on every edge
  // RED EARTH: big soft patches.
  const r = fbm(x / 70, z / 70, 101) + edge * 0.5;
  const wr = smooth((r - 0.56) / 0.14) * 0.55 * soil;
  if (put(k, 1, wr)) red++;
  // STONY: sparser, smaller.
  const st = fbm(x / 32, z / 32, 211) + edge * 0.6;
  const ws = smooth((st - 0.64) / 0.1) * 0.6 * soil;
  if (put(k, 2, ws)) stony++;
  // WORN: round the sites, a trodden pale ground, spokes along the approaches.
  let ww = 0;
  for (const c of WEAR) {
    const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz);
    if (d > c.r * 1.6) continue;
    const ang = Math.atan2(dz, dx);
    const spokes = 0.5 + 0.5 * Math.cos(ang * 5 + c.x) ** 8;                // paths out, a few directions
    const reach = c.r * (0.75 + 0.55 * spokes) * (0.85 + 0.3 * vnoise(x / 9, z / 9, 13));
    const t = d / reach + (vnoise(x / 1.6, z / 1.6, 17) - 0.5) * 0.45;
    ww = Math.max(ww, (1 - smooth((t - 0.55) / 0.5)) * c.peak);
  }
  if (put(k, 6, ww * soil)) worn++;
}

console.log(`limestone → cliff rock: ${moved} texels; red ${red}, stony ${stony}, worn ${worn} texels painted`);
if (!dry) { await writeProject(FILE, project); console.log(`wrote ${FILE}`); }
