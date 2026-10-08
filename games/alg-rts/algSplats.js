// GROUND SPLATS — the Company of Heroes layer of the Aurès ground (you,
// 2026-10-01: "that same CoH terrain texture, whatever we need to do").
//
// CoH maps use a handful of base tiles and do the rest with SPLATS: patches of
// one material — cracked mud, gravel, rubble, a scorch — laid by the hundred,
// turned, scaled, tinted and faded into the tiles. The engine bakes them into
// the ground cache (v3/terrain/groundCache.js), so ten thousand cost the frame
// what ten do. This file is the placement: RULES read from the map (its paint,
// its hollows and slopes, its villages), deterministic from a seed.
//
//   valley soil    stony patches, cracked mud in the hollows, pale dust
//                  pans, a red cast here and there
//   scree          loose gravel and rock fans
//   limestone      broken rock
//   wadi bed       cracked riverbed mud, rounded stones
//   oasis grove    dead leaves under the palms
//   dirt track     stony path on the shoulders, wheel-churned mud down it
//   villages       rubble at the walls, trampled ground in the yards,
//                  furrowed fields beside them
//   everywhere     wind-blown sand, rare old scorches
//
// Materials: Poly Haven (CC0), tools/fetchSplatMaterials.mjs.
import { loadSplatMaterials, prefetchSplatMaterials, splatMaterialFromSlug } from "../../v3/terrain/splatMaterials.js";
import { LAYOUT, PLAY } from "./layout.js";
import { TRACK_LINES } from "./algTracks.js";

/** The library, and the tint that sits each photo in the Aurès palette. */
const MATS = {
  stony:     { slug: "dry_ground_rocks",             tint: [1.0, 0.94, 0.86] },
  crackMud:  { slug: "mud_cracked_dry_03",           tint: [1.02, 0.93, 0.82] },
  bedMud:    { slug: "mud_cracked_dry_riverbed_002", tint: [1.0, 0.95, 0.88] },
  bedRock:   { slug: "dry_riverbed_rock",            tint: [1.0, 0.96, 0.9] },
  gravel:    { slug: "rocky_gravel",                 tint: [1.02, 0.95, 0.86] },
  sandGrav:  { slug: "sandy_gravel",                 tint: [1.0, 0.94, 0.84] },
  rocks:     { slug: "rocks_ground_02",              tint: [1.0, 0.95, 0.88] },
  burnt:     { slug: "burned_ground_01",             tint: [0.9, 0.86, 0.82] },
  leaves:    { slug: "dry_decay_leaves",             tint: [0.95, 0.9, 0.8] },
  redSand:   { slug: "red_sand",                     tint: [1.0, 0.9, 0.8] },
  furrows:   { slug: "farm_furrows",                 tint: [1.0, 0.92, 0.8] },
  path:      { slug: "stony_dirt_path",              tint: [1.0, 0.93, 0.84] },
  rubble:    { slug: "rubble",                       tint: [1.02, 0.97, 0.9] },
  redCrack:  { slug: "cracked_red_ground",           tint: [0.95, 0.88, 0.8] },
  pebbles:   { slug: "river_small_rocks",            tint: [1.0, 0.95, 0.88] },
  ruts:      { slug: "muddy_tracks",                 tint: [0.95, 0.86, 0.74] },
  dust:      { slug: "dry_ground_01",                tint: [1.04, 0.97, 0.88] },
};
/** The pistes' wheel ruts (procedural, groundCache rut strips; live: restyleStrips):
 *  rut width m, wander m, opacity, relief, and the dust photo's tile m (MATS.dust). */
const STRIP = { rut: 0.3, wander: 1.0, opacity: 0.85, normal: 1.0, tile: 3, tint: [1.08, 1.0, 0.9] };
const MAT_KEYS = Object.keys(MATS);
const M = Object.fromEntries(MAT_KEYS.map((k, i) => [k, i]));

// Paint slots (tools/algPaint.mjs and friends).
const SOIL = 0, RIDGE = 1, SCREE = 2, GROVE = 3, WADI = 4, CLIFF = 5, TRACK = 6;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Value noise 0..1 (integer hash — a sin hash patterns on big maps). */
function vnoise(x, z) {
  const h = (i, j) => {
    let n = Math.imul(i, 374761393) + Math.imul(j, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * The rules. Each: which material, where (a weight 0..1 from the ground at a
 * point), how dense (splats per 100 m² at weight 1), how big (metres), and
 * the look (opacity, softness, height push, warp, tile).
 */
function rules(g) {
  return [
    // ── valley soil ───────────────────────────────────────────────────────
    { mat: "dust", per100: 0.10, size: [12, 22], aspect: [0.6, 1], opacity: [0.35, 0.6], soft: 0.5, push: 0.2, warp: 0.45, tile: 4,
      where: (p) => p.w[SOIL] * g.clump(p, 60, 0.3) },
    { mat: "stony", per100: 0.55, size: [3, 8], aspect: [0.5, 1], opacity: [0.7, 1], soft: 0.3, push: 0.9, warp: 0.4, tile: 2.5,
      where: (p) => p.w[SOIL] * g.clump(p, 25, 0.45) * (1 - p.hollow) },
    { mat: "crackMud", per100: 0.6, size: [4, 10], aspect: [0.45, 1], opacity: [0.55, 0.9], soft: 0.14, push: 1.5, warp: 0.45, tile: 5,
      where: (p) => p.w[SOIL] * p.flat * Math.min(1, p.hollow * 1.6) },
    { mat: "redCrack", per100: 0.07, size: [5, 10], aspect: [0.5, 1], opacity: [0.35, 0.6], soft: 0.4, push: 0.8, warp: 0.45, tile: 3,
      where: (p) => p.w[SOIL] * g.clump(p, 90, 0.55) },
    { mat: "sandGrav", per100: 0.3, size: [2, 5], aspect: [0.5, 1], opacity: [0.6, 0.95], soft: 0.3, push: 0.9, warp: 0.38, tile: 2,
      where: (p) => (p.w[SOIL] + p.w[SCREE] * 0.5) * g.clump(p, 18, 0.5) },
    { mat: "redSand", per100: 0.06, size: [6, 14], aspect: [0.3, 0.6], opacity: [0.3, 0.55], soft: 0.5, push: 0.5, warp: 0.4, tile: 4, windAligned: true,
      where: (p) => p.w[SOIL] * p.flat * g.clump(p, 70, 0.5) },
    // ── scree and limestone ───────────────────────────────────────────────
    { mat: "gravel", per100: 1.1, size: [3, 8], aspect: [0.4, 0.9], opacity: [0.7, 1], soft: 0.3, push: 1.0, warp: 0.4, tile: 2.2, downhill: true,
      where: (p) => p.w[SCREE] },
    { mat: "rocks", per100: 0.5, size: [2.5, 6], aspect: [0.5, 1], opacity: [0.7, 1], soft: 0.25, push: 1.2, warp: 0.4, tile: 2.2,
      where: (p) => p.w[SCREE] * 0.6 + p.w[RIDGE] * 0.5 + p.footOfSlope * 0.8 },
    { mat: "rocks", per100: 0.45, size: [4, 10], aspect: [0.5, 1], opacity: [0.7, 1], soft: 0.25, push: 1.1, warp: 0.4, tile: 3.5,
      where: (p) => p.w[RIDGE] * (0.5 + p.crest) },
    // ── wadi ──────────────────────────────────────────────────────────────
    { mat: "bedMud", per100: 1.0, size: [5, 12], aspect: [0.4, 0.9], opacity: [0.75, 1], soft: 0.25, push: 1.0, warp: 0.4, tile: 3,
      where: (p) => p.w[WADI] },
    { mat: "pebbles", per100: 0.9, size: [2.5, 6], aspect: [0.4, 0.9], opacity: [0.75, 1], soft: 0.3, push: 1.1, warp: 0.4, tile: 1.8,
      where: (p) => p.w[WADI] * g.clump(p, 20, 0.35) },
    { mat: "bedRock", per100: 0.35, size: [3, 7], aspect: [0.5, 1], opacity: [0.7, 1], soft: 0.3, push: 1.2, warp: 0.4, tile: 2.5,
      where: (p) => p.w[WADI] * g.clump(p, 30, 0.5) },
    // ── oasis grove ───────────────────────────────────────────────────────
    { mat: "leaves", match: 0.45, per100: 1.4, size: [3, 7], aspect: [0.6, 1], opacity: [0.6, 0.95], soft: 0.35, push: 0.7, warp: 0.45, tile: 2,
      where: (p) => p.w[GROVE] },
    // ── tracks: stony shoulders, churned middle ──────────────────────────
    { mat: "path", per100: 2.2, size: [2, 4.5], aspect: [0.5, 1], opacity: [0.55, 0.85], soft: 0.35, push: 0.8, warp: 0.4, tile: 2,
      where: (p) => (p.w[TRACK] > 0.08 && p.w[TRACK] < 0.6 ? 1 : 0) },
    { mat: "ruts", per100: 0.7, size: [3, 6], aspect: [0.35, 0.6], opacity: [0.35, 0.6], soft: 0.4, push: 0.6, warp: 0.2, tile: 3,
      where: (p) => (p.w[TRACK] > 0.7 ? 1 : 0) },
    // ── old scorches, rare ────────────────────────────────────────────────
    { mat: "burnt", match: 0.15, per100: 0.004, size: [4, 9], aspect: [0.6, 1], opacity: [0.35, 0.6], soft: 0.4, push: 0.8, warp: 0.45, tile: 3,
      where: (p) => p.w[SOIL] + p.w[SCREE] },
  ];
}

/**
 * Lay the splats and hand them to the ground cache. Returns
 * { count, byMat, ms } or null when the cache is off.
 */
/** Start fetching and decoding the splat photos now — algGame calls it at the top of the boot. */
export function prefetchAlgSplats() { prefetchSplatMaterials(MAT_KEYS.map((k) => splatMaterialFromSlug(MATS[k].slug))); }

export async function createAlgSplats(app, { seed = 1957, margin = 90 } = {}) {
  const gc = app.groundCache;
  if (!gc) return null;
  const t0 = performance.now();
  const lib = await loadSplatMaterials(MAT_KEYS.map((k) => splatMaterialFromSlug(MATS[k].slug)));
  gc.setSplatMaterials(lib);

  const rnd = mulberry32(seed);
  const H = (x, z) => app.getWorldHeight(x, z);
  const weights = (x, z) => app.samplePaintWeights?.(x, z) ?? [0, 0, 0, 0, 0, 0, 0];
  const g = {
    /** Clumps: a low-frequency noise gate, so a material comes in patches of patches. */
    clump: (p, scale, keep) => {
      const n = vnoise(p.x / scale + 17.3, p.z / scale - 5.1);
      return Math.max(0, Math.min(1, (n - (1 - keep)) / Math.max(0.05, keep) * 1.6));
    },
  };
  const R = rules(g);
  const wind = 0.9;   // prevailing wind heading (rad): the sand drifts lie along it

  const out = [];
  const byMat = {};
  const CELL = 3;
  const x0 = PLAY.x0 - margin, x1 = PLAY.x1 + margin, z0 = PLAY.z0 - margin, z1 = PLAY.z1 + margin;
  for (let z = z0; z < z1; z += CELL) {
    for (let x = x0; x < x1; x += CELL) {
      const px = x + rnd() * CELL, pz = z + rnd() * CELL;
      const w = weights(px, pz);
      if (!w) continue;
      // The ground here: slope, hollow/crest (height minus the 10 m ring).
      const h = H(px, pz);
      const hx = H(px + 1.5, pz) - H(px - 1.5, pz), hz = H(px, pz + 1.5) - H(px, pz - 1.5);
      const slope = Math.hypot(hx, hz) / 3;           // rise per metre
      const ring = (H(px + 10, pz) + H(px - 10, pz) + H(px, pz + 10) + H(px, pz - 10)) * 0.25;
      const cav = h - ring;
      const ring2 = (H(px + 18, pz) + H(px - 18, pz) + H(px, pz + 18) + H(px, pz - 18)) * 0.25;
      const p = {
        x: px, z: pz, w,
        flat: Math.max(0, 1 - slope / 0.35),
        hollow: Math.max(0, Math.min(1, -cav / 1.2)),
        crest: Math.max(0, Math.min(1, cav / 1.5)),
        // Just under a steeper slope: the ground 18 m out stands well above.
        footOfSlope: slope < 0.3 ? Math.max(0, Math.min(1, (ring2 - h) / 6)) : 0,
        downhill: Math.atan2(-hz, -hx),
      };
      const area = CELL * CELL / 100;
      for (const r of R) {
        const want = r.where(p);
        if (want <= 0.02) continue;
        if (rnd() > r.per100 * area * want) continue;
        const size = r.size[0] + (r.size[1] - r.size[0]) * Math.pow(rnd(), 1.6);
        const aspect = r.aspect[0] + (r.aspect[1] - r.aspect[0]) * rnd();
        let yaw = rnd() * Math.PI * 2;
        if (r.windAligned) yaw = wind + (rnd() - 0.5) * 0.4;
        if (r.downhill) yaw = p.downhill + (rnd() - 0.5) * 0.5;   // fans run down the slope
        const mt = MATS[r.mat].tint, vary = 0.94 + rnd() * 0.12;
        out.push({
          x: px, z: pz, w: size * aspect, l: size, yaw, mat: M[r.mat],
          opacity: r.opacity[0] + (r.opacity[1] - r.opacity[0]) * rnd(),
          tint: [mt[0] * vary, mt[1] * vary, mt[2] * vary],
          tile: r.tile * (0.85 + rnd() * 0.3), soft: r.soft, push: r.push, warp: r.warp, normal: 1, match: r.match ?? 0.85,
          _layer: R.indexOf(r),
        });
        byMat[r.mat] = (byMat[r.mat] ?? 0) + 1;
      }
    }
  }

  // ── villages: rubble at the walls, trampled yards, fields beside ────────
  for (const s of LAYOUT.sites) {
    if (!["hamlet", "dechra", "ksar", "french", "aln", "koubba"].includes(s.kind)) continue;
    const r = s.r ?? 20;
    // Trampled ground — the yard.
    out.push({ x: s.x, z: s.z, w: r * 1.5, l: r * 1.7, yaw: rnd() * 6.28, mat: M.path, opacity: 0.75, tint: MATS.path.tint,
      tile: 2.4, soft: 0.5, push: 0.5, warp: 0.45, normal: 0.8, _layer: -2 });
    // Rubble AT THE WALLS: fallen plaster and stone lies where it fell, along
    // the foot of a building (a nav-blocked cell within 2.5 m), never in the
    // open or on the oasis grass. A ring of it read as spots (2026-10-01).
    const blocked = (x, z) => !!app.navGrid?.isBlockedAtWorld?.(x, z);
    const nearWall = (x, z) => !blocked(x, z) && (blocked(x + 2.5, z) || blocked(x - 2.5, z) || blocked(x, z + 2.5) || blocked(x, z - 2.5));
    let placed = 0;
    for (let tries = 0; tries < r * 12 && placed < r * 0.8; tries++) {
      const a = rnd() * Math.PI * 2, d = r * Math.sqrt(rnd()) * 1.2;
      const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
      if (!nearWall(x, z)) continue;
      const wr = weights(x, z);
      if (!wr || wr[GROVE] > 0.2 || wr[WADI] > 0.3) continue;
      const sz = 1.5 + rnd() * 2.5;
      out.push({ x, z, w: sz * (0.5 + rnd() * 0.5), l: sz, yaw: rnd() * 6.28,
        mat: M.rubble, opacity: 0.55 + rnd() * 0.35, tint: MATS.rubble.tint, tile: 1.6, soft: 0.2, push: 1.3, warp: 0.4, normal: 1, match: 0.85, _layer: 99 });
      placed++;
    }
    byMat.rubble = (byMat.rubble ?? 0) + placed;
    // Fields: a few furrowed plots beside a hamlet/dechra, on the flat.
    if (s.kind === "hamlet" || s.kind === "dechra") {
      for (let f = 0; f < 3; f++) {
        const a = rnd() * Math.PI * 2, d = r * (1.5 + rnd() * 0.8);
        const fx = s.x + Math.cos(a) * d, fz = s.z + Math.sin(a) * d;
        const hx = H(fx + 3, fz) - H(fx - 3, fz), hz = H(fx, fz + 3) - H(fx, fz - 3);
        if (Math.hypot(hx, hz) / 6 > 0.12) continue;           // fields only on the flat
        const w0 = weights(fx, fz);
        if (!w0 || w0[WADI] > 0.3 || w0[TRACK] > 0.3) continue;
        out.push({ x: fx, z: fz, w: 14 + rnd() * 10, l: 22 + rnd() * 14, yaw: (s.turn ?? 0) * Math.PI / 180 + (rnd() - 0.5) * 0.3,
          mat: M.furrows, opacity: 0.8, tint: MATS.furrows.tint, tile: 4, soft: 0.12, push: 0.3, warp: 0.08, normal: 1, _layer: -1 });
        byMat.furrows = (byMat.furrows ?? 0) + 1;
      }
    }
  }
  // A campfire's scorch at the katiba camp.
  const camp = LAYOUT.sites.find((s) => s.kind === "aln");
  if (camp) out.push({ x: camp.x + 4, z: camp.z - 3, w: 5, l: 6, yaw: 0.7, mat: M.burnt, opacity: 0.85, tint: MATS.burnt.tint, tile: 3, soft: 0.3, push: 0.8, warp: 0.4, normal: 1, match: 0.1, _layer: 100 });

  // ── WHEEL RUTS DOWN THE PISTES (2026-10-02, the ground pass; CoH lays
  // roads as splines): a chain of RUT STRIPS down every piste (groundCache:
  // warp < 0), each a segment of the track (resampled every 4 m: one strip per
  // 2 points), long enough to overlap the next. The ruts are procedural — they
  // wander, narrow, fade and come back — in packed dust; `arc` (the length
  // down the road, each piste its own 10 km apart) keeps the noise continuous
  // from strip to strip. Drawn LAST, over everything else. ──
  const strips = [];
  TRACK_LINES.forEach((t, ti) => {
    if (t.kind !== "piste") return;
    const L = t.line;
    let arc = ti * 10000;
    for (let i = 0; i + 2 < L.length; i += 2) {
      const a = L[i], b = L[i + 2];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1;
      strips.push({
        x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w: 6.4, l: d * 1.45, yaw: Math.atan2(-dx / d, dz / d),
        mat: M.dust, opacity: STRIP.opacity, tint: STRIP.tint, tile: STRIP.tile,
        soft: STRIP.rut, arc: arc + d / 2, warp: -STRIP.wander, normal: STRIP.normal, match: 0.6, _layer: 200,
      });
      arc += d;
    }
  });
  byMat.rutStrips = strips.length;

  // Draw order: broad and faint first, fine and strong on top.
  out.sort((a, b) => (a._layer - b._layer) || (b.w * b.l - a.w * a.l));
  let stripsOn = new URLSearchParams(location.search).get("ruts") !== "0";
  const push = () => gc.setSplats(stripsOn ? [...out, ...strips] : out);
  push();
  const ms = Math.round(performance.now() - t0);
  console.log(`[alg splats] ${out.length + strips.length} splats in ${ms} ms`, byMat);
  return {
    count: out.length + strips.length, byMat, ms, splats: out, strips,
    /** The library index of a material key (MATS), for a game's own splats. */
    matIndex: (key) => M[key],
    /** Lay more splats (the contact shade, algGroundContact.js), drawn after these. */
    add(list) { out.push(...list); push(); gc.markAllStale?.(); },
    /** The piste strips on / off (the Ground Lab's before / after); `?ruts=0` boots off. */
    setStrips(on) { stripsOn = !!on; push(); gc.markAllStale?.(); },
    /** Re-lay the ruts with new looks ({ rut, wander, opacity, normal, tile }), live. */
    restyleStrips(p) { Object.assign(STRIP, p); for (const s of strips) { s.soft = STRIP.rut; s.warp = -Math.max(STRIP.wander, 0.01); s.tile = STRIP.tile; s.opacity = STRIP.opacity; s.normal = STRIP.normal; } push(); gc.markAllStale?.(); },
    get stripStyle() { return { ...STRIP }; },
  };
}
