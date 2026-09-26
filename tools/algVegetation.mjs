/**
 * THE AURÈS VEGETATION, written INTO the map — species in its plant slots,
 * density in its paint maps — so it is map content, saved and editable in
 * the editor, instead of a game script placing trees at boot.
 *
 *   node tools/algVegetation.mjs [--file public/levels/alg-aures.v3proj] [--dry]
 *
 * Tall-plant field (4 slots, the RGBA of `susukiDensity`, 512² over the map):
 *   0 Atlas cedar   the heights, in stands
 *   1 Holm oak      mid slopes, scattered and in groves
 *   2 Date palm     round the oasis, in clumps
 *   3 Juniper scrub every dry slope, sparse
 * Ground-foliage field (8 slots, `foliagePaint`, 2 RGBA pages of 1024²):
 *   0 Alfa          flats and gentle slopes, in drifts
 *   1 Doum palm     the valley sides
 *   2 Reed-mace     the oasis edge
 *   3-7             unused (zero paint), kept as they were
 *
 * Density is DERIVED from the map: height (from the land's own histogram),
 * slope (nothing above the 34° nav limit), the lakes (tools/algOasis.mjs),
 * and the game's SITES, kept clear. Idempotent: every run rewrites the
 * channels it owns from scratch.
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { FOLIAGE_PRESETS } from "../v3/app/state/foliageScatterState.js";
import { NAV_MAX_SLOPE_DEG } from "./lib/rtsMapMetrics.mjs";
import { LAYOUT } from "../games/alg-rts/layout.js";

const args = process.argv.slice(2);
const FILE = args.includes("--file") ? args[args.indexOf("--file") + 1] : "public/levels/alg-aures.v3proj";
const dry = args.includes("--dry");

/**
 * Where nothing grows: the post and its wire, the vehicle park and helipad
 * by the gate, the hamlet (games/alg-rts/showroom.js). Circles, metres.
 */
const SITES = [
  // Every layout site except the oases (their palms ARE the site). The
  // French base clears a wider ring: its vehicle park and helipad reach
  // ~60 m out of the gate (games/alg-rts/showroom.js BASE_PARK).
  ...LAYOUT.sites.filter((s) => s.kind !== "oasis").map((s) => ({ x: s.x, z: s.z, r: s.kind === "french" ? 72 : s.r })),
];

const project = await readProject(FILE);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));

// ── Ground queries ──────────────────────────────────────────────────────────
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, ((x + W / 2) / W) * (N - 1)));
  const fv = Math.max(0, Math.min(N - 1.001, ((z + W / 2) / W) * (N - 1)));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hm[y0 * N + x0], b = hm[y0 * N + x0 + 1], c = hm[(y0 + 1) * N + x0], d = hm[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const slopeDeg = (x, z) => {
  const e = 1.5;
  const gx = (H(x + e, z) - H(x - e, z)) / (2 * e), gz = (H(x, z + e) - H(x, z - e)) / (2 * e);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
};
const land = [];
for (const v of hm) if (v * TOP > 2) land.push(v * TOP);
land.sort((a, b) => a - b);
const pct = (p) => land[Math.min(land.length - 1, Math.floor(p * land.length))];
const P30 = pct(0.3), P55 = pct(0.55), P70 = pct(0.7), P90 = pct(0.9);

const lakes = man.lakes?.lakes ?? [];
/** Distance from a lake's centre in units of its pool radius (sizeX / 3.2). */
const oasisD = (x, z) => {
  let best = 99;
  for (const l of lakes) best = Math.min(best, Math.hypot(x - l.cx, z - l.cz) / (l.sizeX / 3.2));
  return best;
};
const wet = (x, z) => lakes.some((l) => H(x, z) < l.level + 0.15 && Math.hypot(x - l.cx, z - l.cz) < l.sizeX / 2);
const siteFade = (x, z) => {
  let k = 1;
  for (const s of SITES) k = Math.min(k, smooth((Math.hypot(x - s.x, z - s.z) - s.r) / 8));
  return k;
};
// The map's faded border (tools/algShapeMap.mjs) is the plain: bare.
const borderFade = (x, z) => smooth((Math.min(W / 2 - Math.abs(x), W / 2 - Math.abs(z)) - 150) / 60);

// ── Noise ───────────────────────────────────────────────────────────────────
const hash = (x, y, s) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const vnoise = (x, y, s) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};
/** Patches: 0 in the gaps, 1 in the stands; `scale` metres, `cover` 0-1 share. */
const patches = (x, z, scale, cover, s) => {
  const n = vnoise(x / scale, z / scale, s) * 0.7 + vnoise(x / (scale * 0.35), z / (scale * 0.35), s + 7) * 0.3;
  return smooth((n - (1 - cover)) / 0.12);
};
function smooth(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }
const band = (v, a, b, soft) => smooth((v - a) / soft) * (1 - smooth((v - b) / soft));

// ── The species' rules: density 0-1 at a world point ───────────────────────
const TALL = [
  { name: "Atlas cedar", preset: "atlasCedar", fn: (x, z, h, s) => band(h, P70, 999, 12) * (1 - smooth((s - 26) / 6)) * patches(x, z, 70, 0.45, 3) * 0.7 },
  { name: "Holm oak", preset: "holmOak", fn: (x, z, h, s) => band(h, P30, P90, 10) * band(s, 6, 28, 5) * patches(x, z, 45, 0.3, 5) * 0.3 },
  { name: "Date palm", preset: "datePalm", fn: (x, z) => { const d = oasisD(x, z); return band(d, 1.08, 2.4, 0.25) * patches(x, z, 9, 0.55, 9) * 0.3; } },
  { name: "Juniper scrub", preset: "juniperScrub", fn: (x, z, h, s) => band(s, 5, 30, 4) * (0.25 + 0.75 * patches(x, z, 30, 0.45, 11)) * 0.32 },
];
const GROUND = [
  { name: "Alfa", preset: "alfa", fn: (x, z, h, s) => (1 - smooth((s - 20) / 6)) * patches(x, z, 25, 0.45, 13) * 0.55 },
  // Doum: NOT painted for now — the fan-palm builder's far LOD draws it as
  // flat green mats across the hillside (2026-09-26). Slot kept, zero paint.
  { name: "Doum palm", preset: "doumPalm", fn: () => 0 },
  { name: "Reed-mace", preset: "typha", fn: (x, z) => band(oasisD(x, z), 0.92, 1.22, 0.08) },
];

// The wadi beds (paint slot 4, tools/algWadi.mjs): gravel, flash floods — bare.
const splat = project.blobs.get("splat");
const SRES = man.splatRes;
const wadiBed = (x, z) => {
  const px = Math.min(SRES - 1, Math.max(0, Math.floor(((x + W / 2) / W) * SRES)));
  const pz = Math.min(SRES - 1, Math.max(0, Math.floor(((z + W / 2) / W) * SRES)));
  return splat[SRES * SRES * 4 + (pz * SRES + px) * 4] / 255;
};
const common = (x, z) => {
  const h = H(x, z), s = slopeDeg(x, z);
  if (s > NAV_MAX_SLOPE_DEG || wet(x, z) || wadiBed(x, z) > 0.25) return null;
  const k = siteFade(x, z) * borderFade(x, z);
  return k > 0 ? { h, s, k } : null;
};

function paintMap(res, pages, list) {
  const out = new Uint8Array(res * res * 4 * pages);
  const count = new Array(list.length).fill(0);
  for (let pz = 0; pz < res; pz++) {
    const z = ((pz + 0.5) / res) * W - W / 2;
    for (let px = 0; px < res; px++) {
      const x = ((px + 0.5) / res) * W - W / 2;
      const g = common(x, z);
      if (!g) continue;
      list.forEach((sp, ch) => {
        const v = Math.round(Math.max(0, Math.min(1, sp.fn(x, z, g.h, g.s) * g.k)) * 255);
        if (!v) return;
        const page = (ch / 4) | 0, c = ch % 4;
        out[page * res * res * 4 + (pz * res + px) * 4 + c] = v;
        count[ch]++;
      });
    }
  }
  return { out, count };
}

// ── Slots ───────────────────────────────────────────────────────────────────
const slot = (sp, extra = {}) => ({
  name: sp.name, preset: sp.preset, castShadow: true,
  ...structuredClone(FOLIAGE_PRESETS[sp.preset]),
  heightMin: -200, heightMax: 900, onLayer: -1, nearRiver: 0, ...extra,
});
man.susuki.plants = TALL.map((sp) => slot(sp));
// The tall field's reach and density, as nam-valley's canopy (a tree field
// must reach as far as the RTS camera sees: 60/140 m LODs were a grass's).
// translucencyMul 0.6: at the field default (1.1) the date palms read pale lime.
Object.assign(man.susuki.field, { translucencyMul: 0.6, density: 0.1, clumping: 0.35, clumpSize: 12, lodDistance: 90, lodDistance2: 200, fadeStart: 330, fadeEnd: 420, shadowDistance: 35 });
GROUND.forEach((sp, i) => { man.foliagePlants[i] = slot(sp); });
Object.assign(man.foliageField, { density: 0.45, lodDistance: 70, lodDistance2: 170, fadeStart: 300, fadeEnd: 380 });

const tall = paintMap(512, 1, TALL);
const ground = paintMap(1024, 2, GROUND);
project.blobs.set("susukiDensity", Buffer.from(tall.out.buffer));
project.blobs.set("foliagePaint", Buffer.from(ground.out.buffer));

console.log(`land height bands: p30 ${P30.toFixed(0)} · p55 ${P55.toFixed(0)} · p70 ${P70.toFixed(0)} · p90 ${P90.toFixed(0)} m; lakes ${lakes.length}`);
TALL.forEach((sp, i) => console.log(`tall ${i} ${sp.name.padEnd(14)} ${tall.count[i]} texels`));
GROUND.forEach((sp, i) => console.log(`ground ${i} ${sp.name.padEnd(12)} ${ground.count[i]} texels`));
if (!dry) {
  await writeProject(FILE, project);
  console.log(`wrote ${FILE}`);
}
