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
 *   2 Date grove    round the oasis: clumps of 3 trunks, every one its own shape
 *   3 Juniper scrub every dry slope, sparse
 * Ground-foliage field (8 slots, `foliagePaint`, 2 RGBA pages of 1024²):
 *   0 Alfa          flats and gentle slopes, in drifts
 *   1 Doum palm     the valley sides
 *   2 Reed-mace     the oasis edge
 *   3 Oleander      the wadi banks, pink
 *   4 Tamarisk      behind the oleander, round the oases
 *   5 Prickly pear  hedges round the hamlets
 *   6 Thistle       purple DRIFTS on the open ground round the villages
 *   7 Asphodel      white DRIFTS on the grazed slopes
 *
 * DENSE WHERE THEY GROW (2026-10-04, you: "the small plants are too sparse —
 * denser where we place them, not spread"). A 0.75 m slot holds one plant: it
 * grows if (the SUM of the paints there, capped at 1) x the field density x a
 * clump noise beats a hash; then the type is drawn by its SHARE of the paint.
 * At field density 0.45 and alfa painted under the thistles, a thistle drift
 * was ~1 thistle in 4 slots. Now the field density is 0.9 and every other
 * species is painted at HALF (GROUND_HALF: the same plants as before), while
 * the flowers' drifts are fewer, wider, full strength in their core, and push
 * the alfa and doum out of them: ~3x denser thistle and asphodel where they
 * grow, a solid patch of colour. Oleander keeps its full paint: its pink
 * ribbons along the wadis double.
 *
 * Density is DERIVED from the map: height (from the land's own histogram),
 * slope (nothing above the 34° nav limit), the lakes (tools/algOasis.mjs),
 * the wadi beds and the tracks (paint slots 4 and 6: bare),
 * and the game's SITES, kept clear. Idempotent: every run rewrites the
 * channels it owns from scratch.
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { FOLIAGE_PRESETS } from "../v3/app/state/foliageScatterState.js";
import { NAV_MAX_SLOPE_DEG } from "./lib/rtsMapMetrics.mjs";
import { LAYOUT, PLAY } from "../games/alg-rts/layout.js";

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
// PINNED (2026-09-29): the bands as measured on the battlefield's own ground
// before the far mountains (tools/algMountains.mjs) raised the map's outer
// ring to 200 m — from the histogram they would have moved, and every cedar
// and oak inside the play box with them. `--histogram` to measure afresh.
const PINNED = { p30: 9.791198186576366, p55: 19.77616921067238, p70: 31.71105682849884, p90: 63.24579566717148 };
const fresh = args.includes("--histogram");
const P30 = fresh ? pct(0.3) : PINNED.p30, P55 = fresh ? pct(0.55) : PINNED.p55, P70 = fresh ? pct(0.7) : PINNED.p70, P90 = fresh ? pct(0.9) : PINNED.p90;

const lakes = man.lakes?.lakes ?? [];
// Each pool's REAL radius, from its wet area: a lake's rectangle was 3.2
// radii when algOasis.mjs made it, but a moved one (algOasisMove.mjs) is fitted
// tight round its pool, and sizeX / 3.2 crowded its palms into the water.
for (const l of lakes) {
  let wetN = 0;
  for (let x = l.cx - l.sizeX / 2; x <= l.cx + l.sizeX / 2; x += 1) for (let z = l.cz - l.sizeZ / 2; z <= l.cz + l.sizeZ / 2; z += 1) if (H(x, z) < l.level) wetN++;
  l._poolR = Math.max(4, Math.sqrt(wetN / Math.PI));
}
/** Distance from a lake's centre in units of its pool's radius. */
const oasisD = (x, z) => {
  let best = 99;
  for (const l of lakes) best = Math.min(best, Math.hypot(x - l.cx, z - l.cz) / l._poolR);
  return best;
};
const wet = (x, z) => lakes.some((l) => H(x, z) < l.level + 0.15 && Math.abs(x - l.cx) < l.sizeX / 2 && Math.abs(z - l.cz) < l.sizeZ / 2);
const siteFade = (x, z) => {
  let k = 1;
  for (const s of SITES) k = Math.min(k, smooth((Math.hypot(x - s.x, z - s.z) - s.r) / 8));
  return k;
};
// The map's faded border (tools/algShapeMap.mjs) is the plain: bare.
const borderFade = (x, z) => smooth((Math.min(W / 2 - Math.abs(x), W / 2 - Math.abs(z)) - 150) / 60);
// Outside the PLAY box (scenery, the far mountains): thinner, 40% of the
// density from 80 m out — seen from the play camera as texture on the
// slopes, not paid for as a forest nobody walks in.
const playFade = (x, z) => { const d = Math.hypot(Math.max(PLAY.x0 - x, 0, x - PLAY.x1), Math.max(PLAY.z0 - z, 0, z - PLAY.z1)); return 1 - 0.6 * smooth((d - 20) / 60); };

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
  // Groves, not single trees: each plant is a clump of 3 (dateGrove), so a
  // little thinner than the single palm was.
  // Denser and closer in (2026-09-29, the oasis look): a grove, not a scatter.
  { name: "Date grove", preset: "dateGrove", fn: (x, z) => { const d = oasisD(x, z); return band(d, 1.05, 2.5, 0.2) * (0.45 + 0.55 * patches(x, z, 9, 0.55, 9)) * 0.3; } },
  { name: "Juniper scrub", preset: "juniperScrub", fn: (x, z, h, s) => band(s, 5, 30, 4) * (0.25 + 0.75 * patches(x, z, 30, 0.45, 11)) * 0.32 },
];
/** Metres from a wadi's centreline, over its half-width (1 = the bed's edge). */
const wadiD = (x, z) => {
  let best = 99;
  for (const w of LAYOUT.wadis ?? []) {
    const P = w.points, hw = (w.width ?? 12) / 2;
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t) / hw);
    }
  }
  return best;
};
/** Metres to the nearest village's centre (hamlet, dechra, ksar). */
const villageD = (x, z) => Math.min(...LAYOUT.sites.filter((s) => ["hamlet", "dechra", "ksar"].includes(s.kind)).map((s) => Math.hypot(x - s.x, z - s.z)));
/** Metres outside a hamlet's cleared ring (negative = inside it). */
const hamletOut = (x, z) => Math.min(...LAYOUT.sites.filter((s) => s.kind === "hamlet").map((s) => Math.hypot(x - s.x, z - s.z) - s.r));

// The flowers' drifts (0-1), shared by their own slots and by the species they push out.
const thistleDrift = (x, z, s) => (1 - smooth((s - 16) / 5)) * (1 - smooth((villageD(x, z) - 220) / 60)) * patches(x, z, 18, 0.3, 31);
const asphodelDrift = (x, z, s) => band(s, 5, 25, 4) * patches(x, z, 32, 0.3, 33);
/** What is left for the green species inside a flower drift. */
const outOfDrifts = (x, z, s) => 1 - 0.85 * Math.max(thistleDrift(x, z, s), asphodelDrift(x, z, s));
// Everything but the flowers and the oleander at half the paint: the field
// density doubled (0.45 → 0.9), so these grow exactly as many as before.
const GROUND_HALF = 0.5;

const GROUND = [
  { name: "Alfa", preset: "alfa", fn: (x, z, h, s) => (1 - smooth((s - 20) / 6)) * patches(x, z, 25, 0.45, 13) * 0.55 * GROUND_HALF * outOfDrifts(x, z, s) },
  // Doum: the valley sides — moderate slopes (8-26°), in clumps, sparse. (Off
  // from 2026-09-26: its far LOD drew flat green mats; fixed 2026-09-30.)
  { name: "Doum palm", preset: "doumPalm", fn: (x, z, h, s) => smooth((s - 8) / 4) * (1 - smooth((s - 26) / 5)) * patches(x, z, 18, 0.6, 29) * 0.35 * GROUND_HALF * outOfDrifts(x, z, s) },
  // Nam's typha is lime green with orange heads — a paddy in the monsoon.
  // An oasis in summer: olive leaves going straw at the tips, dark brown
  // heads (you: "flat bright colour is really not good for our terrain").
  { name: "Reed-mace", preset: "typha", look: { colorBase: "#3b4a2a", colorTip: "#9a9460", colorHead: "#4a3020", translucency: 0.45 }, fn: (x, z) => band(oasisD(x, z), 0.92, 1.22, 0.08) * GROUND_HALF },
  // The wadi banks: oleander right on the lip of the bed, tamarisk behind
  // it and round the oases' outer ring, in patches.
  { name: "Oleander", preset: "oleander", fn: (x, z) => band(wadiD(x, z), 0.95, 1.9, 0.25) * patches(x, z, 14, 0.6, 21) * 0.5 },
  { name: "Tamarisk", preset: "tamarisk", fn: (x, z) => Math.max(band(wadiD(x, z), 1.6, 3.2, 0.4) * patches(x, z, 22, 0.4, 23) * 0.18, band(oasisD(x, z), 2.2, 3.4, 0.3) * patches(x, z, 16, 0.5, 25) * 0.2) * GROUND_HALF },
  // Prickly-pear hedges round the hamlets: a broken ring just outside.
  { name: "Prickly pear", preset: "pricklyPear", fn: (x, z) => band(hamletOut(x, z), 1, 9, 2) * patches(x, z, 9, 0.55, 27) * 0.45 * GROUND_HALF },
  // THE WILDFLOWERS (2026-10-01, late summer), in DRIFTS — at the RTS camera
  // a flower is a patch of colour, not a plant: thistles (purple) on the
  // rough open ground round the villages, asphodel (pale, drying) on the
  // grazed hillsides.
  // Full strength in the drift (was ×0.8 / ×0.7 in smaller, more scattered patches).
  { name: "Thistle", preset: "thistle", fn: (x, z, h, s) => thistleDrift(x, z, s) },
  { name: "Asphodel", preset: "asphodel", fn: (x, z, h, s) => asphodelDrift(x, z, s) },
];

// The wadi beds (paint slot 4, tools/algWadi.mjs): gravel, flash floods — bare.
const splat = project.blobs.get("splat");
const SRES = man.splatRes;
const wadiBed = (x, z) => {
  const px = Math.min(SRES - 1, Math.max(0, Math.floor(((x + W / 2) / W) * SRES)));
  const pz = Math.min(SRES - 1, Math.max(0, Math.floor(((z + W / 2) / W) * SRES)));
  return splat[SRES * SRES * 4 + (pz * SRES + px) * 4] / 255;
};
// The tracks (paint slot 6, tools/algTracks.mjs): beaten earth — bare. Read
// with a margin (the widest weight within ~1.5 m), so a shrub's crown does
// not overhang the piste.
const trackAt = (x, z) => {
  let best = 0;
  for (const [ox, oz] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]]) {
    const px = Math.min(SRES - 1, Math.max(0, Math.floor(((x + ox + W / 2) / W) * SRES)));
    const pz = Math.min(SRES - 1, Math.max(0, Math.floor(((z + oz + W / 2) / W) * SRES)));
    best = Math.max(best, splat[SRES * SRES * 4 + (pz * SRES + px) * 4 + 2] / 255);
  }
  return best;
};
const common = (x, z) => {
  const h = H(x, z), s = slopeDeg(x, z);
  if (s > NAV_MAX_SLOPE_DEG || wet(x, z) || wadiBed(x, z) > 0.25 || trackAt(x, z) > 0.2) return null;
  const k = siteFade(x, z) * borderFade(x, z) * playFade(x, z);
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
GROUND.forEach((sp, i) => { man.foliagePlants[i] = slot(sp, sp.look ?? {}); });
// Wind ON for the ground plants (the engine ships it off, "judged at rest"):
// reeds, oleander and tamarisk stood frozen while the flags flew (you saw it).
man.foliageField = { ...(man.foliageField ?? {}), windMul: 1, flutter: 0.5 };
// clumping stays 0.75 (tried 0.35 2026-10-04: +0.3-0.5 ms for little visible gain).
Object.assign(man.foliageField, { density: 0.9, clumping: 0.75, lodDistance: 70, lodDistance2: 170, fadeStart: 300, fadeEnd: 380 });

const tall = paintMap(512, 1, TALL);
const ground = paintMap(1024, 2, GROUND);
project.blobs.set("susukiDensity", Buffer.from(tall.out.buffer));
project.blobs.set("foliagePaint", Buffer.from(ground.out.buffer));

console.log(`land height bands: p30 ${P30.toFixed(0)} · p55 ${P55.toFixed(0)} · p70 ${P70.toFixed(0)} · p90 ${P90.toFixed(0)} m; lakes ${lakes.length}`);
TALL.forEach((sp, i) => console.log(`tall ${i} ${sp.name.padEnd(14)} ${tall.count[i]} texels`));
GROUND.forEach((sp, i) => console.log(`ground ${i} ${sp.name.padEnd(12)} ${ground.count[i]} texels`));
for (const l of lakes) delete l._poolR;   // a working value, not map data
if (!dry) {
  await writeProject(FILE, project);
  console.log(`wrote ${FILE}`);
}
