/**
 * MAP 4 — AURÈS, OUED ABDI (2026-10-19, games/alg-rts/AURES2_PLAN.md): its ground SHAPED FOR PLAY from the
 * layout in games/alg-rts/maps/abdi.js, built FROM THE EMPTY BASE (tools/algBaseLevel.mjs) every time — the
 * Aurès look (sky, light, plants), nothing of another map. The old Aurès (alg-aures.v3proj) is not touched.
 *
 *   node tools/algAbdiLevel.mjs [--from <base.v3proj>] [--out <new.v3proj>]
 *
 * READABLE FIRST (the old Aurès' lessons): the fighting ground calm and walkable — CoH-flat where the points
 * are, the slopes BETWEEN places as steps and ramps; rocky paint only on the frame nobody fights on.
 *   the valley   the floor falling gently south-east, low swells, calm round every site
 *   the djebel   north and west: inside the box TERRACED (walkable steps, the FLN's ground), outside it the
 *                skyline rising to ~95 m
 *   the knoll    the town's, a flat-topped rise ~9 m over the valley
 *   the oued     across the valley, its banks steep, three fords (the chokepoints)
 *   the gullies  two ravines down from the djebel (the FLN's ways down), floors walkable
 *   the pistes   carved (tools/lib/trackCarve.mjs)
 * THE PAINT (the base's Aurès slots, kept so the game's splats / stones / minimap work unchanged):
 *   0 valley soil · 1 red earth (hollows, terraces) · 2 scree (the frame's slopes) · 3 the oasis' grove ·
 *   4 the oued's bed · 5 cliff rock (the frame's faces only) · 6 the pistes
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { blankManifest, BASE_LEVEL } from "./lib/algLevelBase.mjs";
import { measureRtsMap, printRtsMetrics } from "./lib/rtsMapMetrics.mjs";
import { trackCarver, PISTE } from "./lib/trackCarve.mjs";
import fs from "node:fs";
import { PLAY, LAYOUT } from "../games/alg-rts/maps/abdi.js";
import { buildSandstoneRock, SANDSTONE_GAME } from "../games/alg-rts/algSandstone.js";
import { STREAM_POWER_DEFAULTS, createStreamPowerScratch, streamPowerErode } from "../v3/terrain/streamPowerErosion.js";
import { EROSION_DEFAULTS, buildErosionKernel, erodeDroplets, smoothHeights } from "../v3/terrain/globalErosion.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
args.out ??= "public/levels/alg-abdi.v3proj";
args.from ??= BASE_LEVEL;

const tpl = await readProject(args.from);
const man = tpl.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const cell = W / (N - 1);

// ── Noise, polylines (as tools/algKantaraLevel.mjs) ────────────────────────
const hash = (x, z, s) => { let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sm = (t) => t * t * (3 - 2 * t);
function noise(x, z, s = 1) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = sm(x - xi), fz = sm(z - zi);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smooth01 = (t) => smoothstep(0, 1, t);
function spline(pts, step = 2) {
  const out = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let i = 0; i < n; i++) {
      const t = i / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function polyField(pts) {
  const segs = [], at = [0];
  for (let k = 0; k < pts.length - 1; k++) {
    segs.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
    at.push(at[k] + Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]));
  }
  const Bn = 16, grid = new Map(), key = (i, j) => `${i},${j}`;
  segs.forEach((s, idx) => {
    const i0 = Math.floor(Math.min(s[0], s[2]) / Bn), i1 = Math.floor(Math.max(s[0], s[2]) / Bn);
    const j0 = Math.floor(Math.min(s[1], s[3]) / Bn), j1 = Math.floor(Math.max(s[1], s[3]) / Bn);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx); }
  });
  const field = (x, z, reach = 400) => {
    let best = Infinity, px = x, pz = z, tx = 1, tz = 0, s = 0;
    const ci = Math.floor(x / Bn), cj = Math.floor(z / Bn);
    for (let r = 0; r * Bn <= reach; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        for (const idx of grid.get(key(i, j)) ?? []) {
          const [ax, az, bx, bz] = segs[idx], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
          const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
          if (d < best) { best = d; px = ax + dx * u; pz = az + dz * u; const l = Math.sqrt(L); tx = dx / l; tz = dz / l; s = at[idx] + u * l; }
        }
      }
      if (best < (r - 1) * Bn) break;
    }
    return { d: best, px, pz, tx, tz, s };
  };
  field.len = at[at.length - 1];
  return field;
}
const outside = (x, z) => Math.hypot(Math.max(PLAY.x0 - x, 0, x - PLAY.x1), Math.max(PLAY.z0 - z, 0, z - PLAY.z1));

// ── The layout's shapes ───────────────────────────────────────────────────
const wadi = LAYOUT.wadis[0];
// (the oued runs on, past the box, to the map's edges)
const wadiAt = polyField(spline([[-560, -20], ...wadi.points, [560, 10]], 2));
const gullyAt = LAYOUT.gullies.map((g) => polyField(spline(g.points, 2)));
const pisteAt = LAYOUT.pistes.map((p) => polyField(spline(p, 2)));
const site = (k) => LAYOUT.sites.find((s) => s.kind === k);
const TOWN = site("town"), KNOLL = { x: TOWN.knoll[0], z: TOWN.knoll[1], r: TOWN.knoll[2] };
const OASIS = site("oasis");
const flats = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + 14 }));
/** 1 away from the sites, 0 on them (the ground calmed under a place). */
const calmK = (x, z) => flats.reduce((k, f) => Math.min(k, smoothstep(f.r * 0.55, f.r, Math.hypot(x - f.x, z - f.z))), 1);

const PLAIN = 22;
/** The valley floor: falling gently to the south-east. */
const floorAt = (x, z) => PLAIN - z * 0.01 - x * 0.006;
/** How far INTO the djebel (m, north-west of its foot; the foot a line from (-250, 20) to (250, -120), wobbling). */
const djebelD = (x, z) => (20 - (x + 250) * 0.28 + 14 * (noise(x / 70, 3.3, 5) - 0.5)) - z;
// THE TOWN'S HILL: the top platform's height, then each ring terrace (radii from the knoll's centre, height over
// the valley floor); risers 1.5 m wide between them; the shoulder down to the floor by KNOLL_SHOULDER
const KNOLL_TOP = 12.6, KNOLL_SHOULDER = 62, RISER = 0.55;
const KNOLL_RINGS = [{ r0: 12.5, r1: 23, h: 10 }, { r0: 23, r1: 36, h: 7.4 }, { r0: 36, r1: 49, h: 4.8 }];
/** Distance from the knoll's centre, WARPED with the angle (2026-10-20: perfect circles read as a target from the
 *  RTS camera; Ghardaïa's streets follow the hill's own wobbly contours). The rings, the houses and the paint use it. */
function knollD(x, z) {
  const dx = x - KNOLL.x, dz = z - KNOLL.z, r = Math.hypot(dx, dz) || 1e-6;
  return r * (1 + 0.13 * (noise(1.3 * dx / r + 5, 1.3 * dz / r + 5, 31) - 0.5) + 0.05 * (noise(3.1 * dx / r + 9, 3.1 * dz / r + 2, 32) - 0.5));
}
function knollStep(kd, riser = RISER) {
  let v = KNOLL_TOP, prev = KNOLL_TOP;
  for (const R of KNOLL_RINGS) { v += (R.h - prev) * smoothstep(R.r0 - riser, R.r0 + riser, kd); prev = R.h; }
  return v;
}
// THE TOWN'S LANES (2026-10-20: packed wall to wall, the town was one block to the pathfinder and its risers 2.6 m
// cliffs): three streets up the hill, LANE_W wide — from the square straight up to the mosque's gate, and one up
// each flank; in them the risers become RAMPS (stretched over 7 m: ~20 deg, under the nav grid's 34) and no
// house stands. Straight rays from the knoll's centre.
const LANE_W = 5;
// (in a lane the steps are ONE even slope, through the rings' middles: two smooth risers squeezed by the warp
// merged into 39 deg — measured; this is ~13 deg, ~16 where the warp squeezes it)
function knollLane(kd, end) {
  const lo = KNOLL_RINGS[KNOLL_RINGS.length - 1].h;
  return kd <= 6 ? KNOLL_TOP : kd >= end ? lo : KNOLL_TOP + (lo - KNOLL_TOP) * (kd - 6) / (end - 6);
}
// [cos, sin, the ring distance where its slope ends]: the middle lane at the SQUARE's back edge (the square's
// height there — 2026-10-20: the square's notch dragged it into a 40 deg drop and sealed the hilltop off), the
// flanks at the last ring
const LANES = (() => {
  const a0 = Math.atan2(TOWN.z - KNOLL.z, TOWN.x - KNOLL.x), toSq = Math.hypot(TOWN.x - KNOLL.x, TOWN.z - KNOLL.z) - 11;
  return [a0, a0 + 2.1, a0 - 2.1].map((a, i) => [Math.cos(a), Math.sin(a), i === 0 ? knollD(KNOLL.x + Math.cos(a) * toSq, KNOLL.z + Math.sin(a) * toSq) : KNOLL_RINGS[KNOLL_RINGS.length - 1].r1]);
})();
/** The nearest lane: its distance across, its slope's end, whether it is the middle one. */
function laneAt(x, z) {
  const px = x - KNOLL.x, pz = z - KNOLL.z;
  let best = { d: Infinity, end: 0, mid: false };
  LANES.forEach(([c, sn, end], i) => { if (px * c + pz * sn > 5) { const d = Math.abs(-px * sn + pz * c); if (d < best.d) best = { d, end, mid: i === 0 }; } });
  return best;
}
const laneDist = (x, z) => laneAt(x, z).d;
const laneK = (x, z) => 1 - smoothstep(LANE_W / 2, LANE_W / 2 + 0.8, laneDist(x, z));   // (sharp edges: the houses line the street, their walls hide the step)
/** The terraces: levels STEP_H high, each a walkable plateau with a short ramp up to the next. */
const STEP_H = 5, STEP_L = 32;
function terraces(d) {
  if (d <= 0) return 0;
  const s = d / STEP_L, f = s - Math.floor(s);
  return (Math.floor(s) + smoothstep(0.62, 0.95, f)) * STEP_H;
}

function naturalAt(x, z) {
  const calm = calmK(x, z), o = outside(x, z);
  let djRise = 0;
  let h = floorAt(x, z);
  // low swells on the valley floor (two scales), calmed on the sites
  const swell = (noise(x / 90, z / 90, 3) - 0.5) * 2 * 1.4 + (noise(x / 34, z / 34, 7) - 0.5) * 2 * 0.45;
  h += swell * calm;
  // THE DJEBEL: terraced inside the box (at most ~4 steps), then the skyline outside it
  // (the CRESTS RAGGED — you, 2026-10-19: "everything seems too smooth": straight terrace edges read as a
  // mathematical ramp; the step's position wanders at two scales, so a crest juts out and bites in)
  const d = djebelD(x, z) + 9 * (noise(x / 28, z / 28, 71) - 0.5) + 3.5 * (noise(x / 9, z / 9, 72) - 0.5);
  if (d > 0) {
    const inBox = Math.min(terraces(d), 4 * STEP_H);
    djRise = inBox * (0.85 + 0.3 * noise(x / 60, z / 60, 11)) + smoothstep(0, 160, o) * smoothstep(0, 60, d) * 75 * (0.7 + 0.5 * noise(x / 90, z / 90, 13));
    h += djRise;
  }
  // THE FACES ERODED: on a terrace's ramp only (the flats stay flat), RILLS cut down the fall line (ridged
  // noise stretched across the djebel's foot line), small LEDGES of harder strata, a rough skin
  if (d > 0) {
    const ph = (d / STEP_L) % 1, face = smoothstep(0.58, 0.7, ph) * (1 - smoothstep(0.93, 1.0, ph)) * (d / STEP_L < 4 ? 1 : 0.6);
    if (face > 0) {
      const u = x * 0.96 + z * 0.27;   // along the foot line (the faces run roughly along it)
      const rill = 1 - Math.abs(noise(u / 5.5, d / 14, 73) * 2 - 1);   // ridged: sharp-bottomed channels
      h -= face * (1.1 * Math.pow(rill, 3) + 0.35 * (noise(x / 3, z / 3, 74) - 0.5));
      h += face * 0.45 * smoothstep(0.55, 0.62, noise(u / 20, d / 4, 75));   // a harder ledge, here and there
    }
  }
  // a fine roughness on the valley floor too (±0.25 m at ~6 m): ground, not a table — calmed on the sites
  h += (noise(x / 6, z / 6, 76) - 0.5) * 0.5 * calm;
  // the frame south and east: low hills rising past the box
  if (o > 0 && d <= 0) h += smoothstep(0, 140, o) * 22 * (0.5 + noise(x / 80, z / 80, 17));
  // THE KNOLL (the town, 2026-10-20): STEPPED like Ghardaia's hill — a top platform (the mosque) and three
  // RING TERRACES (the town's rows of houses, each row's fronts over the roofs of the row below), short risers
  // between them; a soft shoulder below the last. Exact (flat) on the valley side; the djebel wins where it is
  // higher (north: the town's back stays bare terraces).
  const kd = knollD(x, z);
  if (kd < KNOLL_SHOULDER + 6) {
    const fl = floorAt(x, z), last = KNOLL_RINGS[KNOLL_RINGS.length - 1];
    if (kd < last.r1) { const L = laneAt(x, z), lk = 1 - smoothstep(LANE_W / 2, LANE_W / 2 + 0.8, L.d), hk = fl + knollStep(kd) * (1 - lk) + knollLane(kd, L.end) * lk; h = Math.max(hk, fl + djRise); }
    else h = Math.max(h, fl + last.h * (1 - smoothstep(last.r1, KNOLL_SHOULDER, kd + 4 * (noise(x / 20, z / 20, 19) - 0.5))));
  }
  // THE GULLIES: ravines down the djebel — a flat floor 10 m wide, banks steep, depth with the terraces
  for (const g of gullyAt) {
    const q = g(x, z, 40);
    if (q.d < 20) {
      const depth = Math.min(8, 2 + Math.max(0, d) * 0.06);
      h -= depth * (1 - smoothstep(5, 14, q.d + 2 * (noise(x / 9, z / 9, 23) - 0.5)));
    }
  }
  // THE OUED: the valley eased toward it, a channel with STEEP banks, shallower at its fords
  const w = wadiAt(x, z, 60);
  if (w.d < wadi.width + 16) {
    const f = (w.s - 0) / wadiAt.len;
    // (the fords' fractions are along the box's oued: re-measured on the extended line)
    const ford = FORDS.reduce((k, fp) => Math.max(k, 1 - smoothstep(10, 22, Math.abs(w.s - fp))), 0);
    const fl = floorAt(x, z);
    h = fl + (h - fl) * smoothstep(wadi.width * 0.7, wadi.width + 16, w.d);
    const bank = ford > 0.01 ? smoothstep(wadi.width * 0.3, wadi.width * 1.2, w.d) : smoothstep(wadi.width * 0.45, wadi.width * 0.62, w.d);
    h -= (1 - bank) * wadi.depth * (1 - 0.8 * ford);
    void f;
  }
  return h;
}
// the fords: their arc length along the extended oued
const FORDS = (() => {
  const inner = polyField(spline(wadi.points, 2));
  return wadi.fords.map((fr) => {
    // the point at that fraction of the box's oued, then its arc length on the extended line
    const pts = spline(wadi.points, 2), target = fr * inner.len;
    let acc = 0;
    for (let k = 1; k < pts.length; k++) {
      const l = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (acc + l >= target) { const t = (target - acc) / l; const p = [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t]; return wadiAt(p[0], p[1], 20).s; }
      acc += l;
    }
    return 0;
  });
})();
// ── FLUVIAL EROSION (you, 2026-10-19: "what makes the old Aurès look cool is the fluvial erosion"): the natural
// shape on the level's grid, eroded by the engine's own stream power (dendritic gullies, sharp ridges) and a
// droplet pass (debris fans, fine rills) — kept only on the DJEBEL and the FRAME (the slopes nobody fights
// on); the valley, the sites, the oued's fords and the pistes are laid AFTER, so the fighting ground stays
// exact. ?no erosion: --erosion 0.
const ERODE = args.erosion !== "0";
const RAW = new Float32Array(N * N), ERO = new Float32Array(N * N), MASK = new Float32Array(N * N);
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = -W / 2 + j * cell, z = -W / 2 + i * cell, k = i * N + j;
  RAW[k] = naturalAt(x, z);
  // where erosion may change the ground: up in the djebel (past its first step), and the frame; never near a
  // site, the oued, a piste or a gully's floor
  // (from the djebel's FIRST step now, full by its second — 2026-10-19: in the box it read mild)
  let m = Math.max(smoothstep(4, 26, djebelD(x, z)), smoothstep(10, 60, outside(x, z)));
  for (const f of flats) m = Math.min(m, smoothstep(f.r, f.r + 20, Math.hypot(x - f.x, z - f.z)));
  m = Math.min(m, smoothstep(KNOLL_SHOULDER, KNOLL_SHOULDER + 20, Math.hypot(x - KNOLL.x, z - KNOLL.z)));   // (the town's hill: its rings stay flat)
  if (m > 0) {
    m *= smoothstep(wadi.width + 6, wadi.width + 24, wadiAt(x, z, 50).d);
    for (const p of pisteAt) m *= smoothstep(6, 16, p(x, z, 20).d);
  }
  MASK[k] = m;
}
ERO.set(RAW);
if (ERODE) {
  const t0 = Date.now();
  streamPowerErode(ERO, N, 200, { ...STREAM_POWER_DEFAULTS, strength: 0.02, smoothing: 0.035 }, createStreamPowerScratch(N));
  erodeDroplets(ERO, N, 250000, { ...EROSION_DEFAULTS, erosionRate: 0.35, depositionRate: 0.25 }, buildErosionKernel(3));
  smoothHeights(ERO, N, 2, 0.15);
  console.log(`erosion: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
/** The natural ground with the erosion blended in where the mask allows (bilinear on the grid). */
function erodedAt(x, z) {
  const fu = Math.max(0, Math.min(N - 1.001, (x + W / 2) / cell)), fv = Math.max(0, Math.min(N - 1.001, (z + W / 2) / cell));
  const j0 = fu | 0, i0 = fv | 0, tx = fu - j0, tz = fv - i0;
  const at = (A, i, j) => A[i * N + j];
  const lerp = (A) => (at(A, i0, j0) * (1 - tx) + at(A, i0, j0 + 1) * tx) * (1 - tz) + (at(A, i0 + 1, j0) * (1 - tx) + at(A, i0 + 1, j0 + 1) * tx) * tz;
  const m = lerp(MASK);
  return m > 0 ? naturalAt(x, z) + (lerp(ERO) - lerp(RAW)) * m : naturalAt(x, z);
}

/** EVERY SITE LEVELLED: the ground under a place blended to its own height (its centre's, before
 *  levelling), a soft rim beyond — a camp on a terrace step or a souk on the knoll's shoulder stood on 4-10 m
 *  of relief (measured, the first build). */
// (not the town: its hill's rings and its square's pad)
const LEVEL = LAYOUT.sites.filter((s) => s.kind !== "town").map((s) => ({ x: s.x, z: s.z, r: s.r * 0.9, rim: s.r * 0.6 + 8, h: naturalAt(s.x, s.z) }));
function levelledAt(x, z) {
  let h = erodedAt(x, z);
  for (const L of LEVEL) {
    const d = Math.hypot(x - L.x, z - L.z);
    if (d < L.r + L.rim) h = L.h + (h - L.h) * smoothstep(L.r, L.r + L.rim, d);
  }
  return h;
}
// ── THE TOWN (2026-10-20): the M'zab kit (algHouse.js) on the knoll's rings, the souk SQUARE at the site ──
// Footprints in the kit's local real metres (x0 x1 z0 z1, front at -Z, steps / stairs / yards in); the game x1.3.
const FOOT = { dar: [-3.6, 3.6, -3.9, 3.4], tour: [-2.6, 2.6, -3.3, 2.8], bas: [-3.2, 3.2, -4.0, 4.6], terrasse: [-3.0, 7.45, -3.5, 3.0],
  souk: [-6.0, 6.0, -5.0, 2.4], mosquee: [-6.0, 6.0, -6.5, 6.5], maison: [-3.8, 8.45, -3.5, 3.0], haute: [-2.6, 2.6, -3.7, 2.8], cour: [-3.4, 3.4, -4.2, 5.0] };
const HS = 1.3;
const rotY = (th, lx, lz) => [lx * Math.cos(th) + lz * Math.sin(th), -lx * Math.sin(th) + lz * Math.cos(th)];   // (three.js rotation.y)
const yawFacing = (fx, fz) => Math.atan2(-fx, -fz);                                                          // front (local -Z) toward (fx, fz)
/** A house whose footprint's centre is at (cx, cz), facing (fx, fz): its position, yaw, 4 corners, size. */
function houseAt(type, cx, cz, fx, fz) {
  const [x0, x1, z0, z1] = FOOT[type].map((v) => v * HS), th = yawFacing(fx, fz);
  const [ox, oz] = rotY(th, (x0 + x1) / 2, (z0 + z1) / 2);
  const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([a, b]) => { const [u, v] = rotY(th, a, b); return [cx - ox + u, cz - oz + v]; });
  return { type, x: cx - ox, z: cz - oz, yaw: th, corners, w: x1 - x0, d: z1 - z0 };
}
function inBox(o, x, z, pad) {
  const [a, b] = rotY(-o.yaw, x - o.x, z - o.z), [x0, x1, z0, z1] = FOOT[o.type].map((v) => v * HS);
  return a > x0 - pad && a < x1 + pad && b > z0 - pad && b < z1 + pad;
}
// the SQUARE: at the souk site, its long side across the slope; held up at the last ring's height (a platform, the
// piste climbing to it), dug into the ring above for its souks
const SQ = (() => { const ux = TOWN.x - KNOLL.x, uz = TOWN.z - KNOLL.z, L = Math.hypot(ux, uz); return { x: TOWN.x, z: TOWN.z, ux: ux / L, uz: uz / L, tx: -uz / L, tz: ux / L, hw: 16, hd: 11, h: KNOLL_RINGS[2].h }; })();
const sqLocal = (x, z) => [(x - SQ.x) * SQ.tx + (z - SQ.z) * SQ.tz, (x - SQ.x) * SQ.ux + (z - SQ.z) * SQ.uz];   // (along, outward)
const SQ_PAD = { a: SQ.hw + 10.5, b0: -(SQ.hd + 10.6), b1: SQ.hd, blend: 3 };
function squareK(x, z) {
  const [a, b] = sqLocal(x, z);
  const da = Math.max(0, Math.abs(a) - SQ_PAD.a), db = Math.max(0, SQ_PAD.b0 - b, b - SQ_PAD.b1);
  const k = 1 - smoothstep(0, SQ_PAD.blend, Math.hypot(da, db));
  return b < -SQ.hd && k > 0 ? k * (1 - laneK(x, z)) : k;
}
let ground = (x, z) => levelledAt(x, z);
{ const base = ground; ground = (x, z) => { const k = squareK(x, z), h = base(x, z); return k > 0 ? h + (floorAt(x, z) + SQ.h - h) * k : h; }; }
const town = [];
// THE MOSQUE on the hilltop, its court toward the square (its minaret then rises at the back, over the town)
town.push({ ...houseAt("mosquee", KNOLL.x, KNOLL.z, SQ.ux, SQ.uz), state: "intact" });
// the SOUKS round the square: two along its back (the hill side), one each end, all facing in
for (const a of [-10.4, 10.4]) town.push({ ...houseAt("souk", SQ.x + SQ.tx * a - SQ.ux * (SQ.hd + 5.1), SQ.z + SQ.tz * a - SQ.uz * (SQ.hd + 5.1), SQ.ux, SQ.uz), state: a < 0 ? "intact" : "damaged" });
for (const sd of [-1, 1]) town.push({ ...houseAt("souk", SQ.x + SQ.tx * sd * (SQ.hw + 5.1) - SQ.ux * 2, SQ.z + SQ.tz * sd * (SQ.hw + 5.1) - SQ.uz * 2, -SQ.tx * sd, -SQ.tz * sd), state: "intact" });
// the RINGS: walk round each, a house a step (its width, wall to wall — a LANE every few), facing down the hill;
// a house stays only where its whole box stands flat on its ring (off the risers, the square, the djebel)
// (the white ones — the whitewashed kit, the pale blue terrasse — about one in eight: the town is ochre; a
// quarter white read as a whitewashed town, 2026-10-20)
const RING_MIX = [["dar", "tour", "dar", "dar", "haute", "dar", "tour", "dar"], ["dar", "tour", "dar", "terrasse", "dar", "bas", "dar", "dar"], ["dar", "dar", "bas", "dar", "tour", "dar", "bas", "dar"]];
const onRing = (R, cs) => cs.every(([x, z]) => { const kd = knollD(x, z); if (squareK(x, z) > 0) return false; return kd > R.r0 + RISER + 0.1 && kd < R.r1 - RISER - 0.1 && Math.abs(ground(x, z) - floorAt(x, z) - R.h) < 0.15; });
/** A house's box clear of every lane (its corners' spread across the lane's line misses the strip). */
const offLanes = (cs) => LANES.every(([c, sn]) => {
  const ps = cs.map(([x, z]) => [(x - KNOLL.x) * c + (z - KNOLL.z) * sn, -(x - KNOLL.x) * sn + (z - KNOLL.z) * c]);
  if (ps.every(([al]) => al < 4)) return true;
  const lo = Math.min(...ps.map((q) => q[1])), hi = Math.max(...ps.map((q) => q[1]));
  return lo > LANE_W / 2 + 0.9 || hi < -(LANE_W / 2 + 0.9);
});
const clearOfTown = (cs, pad = 0.3) => cs.every(([x, z]) => town.every((o) => !inBox(o, x, z, pad)));
KNOLL_RINGS.forEach((R, ri) => {
  const rm = (R.r0 + R.r1) / 2;
  let phi = Math.atan2(SQ.uz, SQ.ux) + 0.4, k = 0, pending = null, tries = 0;
  const end = phi + Math.PI * 2 - 0.2;
  while (phi < end) {
    // (a miss keeps its TYPE for a few slides along: a fresh pick each miss favoured the small towers — 19 of 46)
    const type = pending ?? RING_MIX[ri][Math.floor(hash(ri, k, 3) * RING_MIX[ri].length)], [x0, x1, z0, z1] = FOOT[type];
    const w = (x1 - x0) * HS, dd = (z1 - z0) * HS, slack = R.r1 - R.r0 - 2 * RISER - 0.6 - dd;
    const pc = phi + (w / 2) / rm;
    if (slack >= -0.1) {
      // (the ring's radius here: knollD = r x its warp at this angle; a few radii across the band tried, the
      // first whose box stands flat wins — a straight box on a wobbly curve)
      const ux = Math.cos(pc), uz = Math.sin(pc), warp = knollD(KNOLL.x + ux * 30, KNOLL.z + uz * 30) / 30, jit = (hash(ri, k, 9) - 0.5) * 0.16;
      const h = [hash(ri, k, 4), 0.5, 0.15, 0.85, 0, 1].map((t) => {
        const r = (R.r0 + RISER + 0.15 + dd / 2 + Math.max(0, slack) * t) / warp;
        return houseAt(type, KNOLL.x + ux * r, KNOLL.z + uz * r, Math.cos(pc + jit), Math.sin(pc + jit));
      }).find((c) => onRing(R, c.corners) && offLanes(c.corners) && clearOfTown(c.corners));
      if (h) {
        const q = hash(ri, k, 5);
        town.push({ ...h, state: q < 0.07 ? "ruin" : q < 0.17 ? "damaged" : "intact" });
        phi += (w + (hash(ri, k, 6) < 0.22 ? 2.8 : 0.3)) / rm; k++; pending = null; tries = 0;
        continue;
      }
    }
    phi += 1.2 / rm; k++;
    if (++tries < 6) pending = type; else { pending = null; tries = 0; }
  }
});
// THE TOWN'S EDGE: low houses behind their yards on the shoulder, each on its own levelled PAD
const pads = [];
{
  const rm = 57, a0 = Math.atan2(SQ.uz, SQ.ux);
  let phi = a0 - Math.PI, k = 0;
  for (; phi < a0 + Math.PI; k++) {
    const pc = phi + 5.2 / rm, ux = Math.cos(pc), uz = Math.sin(pc);
    const h = houseAt("bas", KNOLL.x + ux * rm, KNOLL.z + uz * rm, ux, uz);
    const hs = h.corners.map(([x, z]) => ground(x, z)), lo = Math.min(...hs), hi = Math.max(...hs);
    const ok = hash(9, k, 7) < 0.55 && hi - lo < 3.6 && offLanes(h.corners) && clearOfTown(h.corners, 2)
      && h.corners.every(([x, z]) => squareK(x, z) === 0 && djebelD(x, z) < -6 && Math.min(...pisteAt.map((q) => q(x, z, 20).d)) > 7 && wadiAt(x, z, 40).d > wadi.width + 6);
    if (ok) {
      town.push({ ...h, state: hash(9, k, 8) < 0.15 ? "damaged" : "intact" });
      pads.push({ o: town[town.length - 1], h: (lo + hi) / 2 });
      phi += (h.w + 3) / rm;
    } else phi += 3 / rm;
  }
}
{
  const base = ground, [x0, x1, z0, z1] = FOOT.bas.map((v) => v * HS);
  ground = (x, z) => {
    let h = base(x, z);
    for (const P of pads) {
      const [a, b] = rotY(-P.o.yaw, x - P.o.x, z - P.o.z);
      const dd = Math.hypot(Math.max(0, x0 - 1 - a, a - x1 - 1), Math.max(0, z0 - 1 - b, b - z1 - 1));
      if (dd < 4) h += (P.h - h) * (1 - smoothstep(0, 4, dd));
    }
    return h;
  };
}
/** The ground with every piste CARVED in. */
for (const p of pisteAt) { const base = ground, carve = trackCarver(base, p, PISTE); ground = (x, z) => carve(x, z, base(x, z)); }
const heightAt = ground;

// ── Heights ──────────────────────────────────────────────────────────────
const hgt = new Float32Array(N * N);
let hi = 0, lo = Infinity;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const v = heightAt(-W / 2 + j * cell, -W / 2 + i * cell);   // row 0 = north (−Z)
  hgt[i * N + j] = Math.max(0, v) / TOP;
  if (v > hi) hi = v; if (v < lo) lo = v;
}
if (hi > TOP) throw new Error(`the ground reaches ${hi.toFixed(1)} m, over the level's ${TOP} m`);
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, (x + W / 2) / cell)), fv = Math.max(0, Math.min(N - 1.001, (z + W / 2) / cell));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hgt[y0 * N + x0], b = hgt[y0 * N + x0 + 1], c = hgt[(y0 + 1) * N + x0], d = hgt[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const grad = (x, z, e = 2) => [(H(x + e, z) - H(x - e, z)) / (2 * e), (H(x, z + e) - H(x, z - e)) / (2 * e)];
const slopeDeg = (x, z) => (Math.atan(Math.hypot(...grad(x, z, 1.5))) * 180) / Math.PI;
function hollow(x, z, r = 9) {
  let s = 0;
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; s += H(x + Math.cos(a) * r, z + Math.sin(a) * r); }
  return s / 8 - H(x, z);
}

const pisteD = (x, z, r) => Math.min(...pisteAt.map((p) => p(x, z, r).d));
// ── THE ROCK: the building lab's sandstone (algSandstone — layered, jointed, undercut) as CLIFFS and OUTCROPS
// (you, 2026-10-19: "with the rock system we built we should be able to make more realistic cliffs") ──────────
//   CRESTS   in the box, on the djebel's terrace crests (convex, the top of a face): an outcrop — a big block,
//            one or two smaller along the crest — cover and landmarks, as CoH's
//   CLIFFS   outside the box, on the frame's steep faces: rows of big slabs along the contour, sunk deep
const SIZE = SANDSTONE_GAME.map(([sh, sd]) => {
  const g = buildSandstoneRock(sh, sd);
  g.computeBoundingBox();
  const b = g.boundingBox;
  return { shape: sh, len: b.max.x - b.min.x, deep: b.max.z - b.min.z, tall: b.max.y - b.min.y };
});
const ofShape = (sh) => SIZE.map((q, v) => ({ ...q, v })).filter((q) => q.shape === sh);
const rand = (() => { let r = 1958; return () => ((r = Math.imul(r ^ (r >>> 15), 2246822507) + 1013904223) >>> 0) / 4294967296; })();
const rocks = [];
function slab(x, z, yaw, Sz, k, sink) {
  const c = Math.cos(yaw), sn = Math.sin(yaw), hl = (Sz.len * k) / 2, hd = (Sz.deep * k) / 2;
  let lo = Infinity;
  for (const a of [-1, 0, 1]) for (const e of [-1, 0, 1]) lo = Math.min(lo, H(x + a * hl * c + e * hd * sn, z - a * hl * sn + e * hd * c));
  rocks.push({ x, y: lo - sink * Sz.tall * k, z, yaw, k, v: Sz.v });
}
const contourYaw = (x, z) => { const [gx, gz] = grad(x, z, 3); return Math.atan2(gx, -gz) + Math.PI / 2; };
const taken = [];
const clearOf = (x, z, pad) =>
  !LAYOUT.sites.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + pad) && pisteD(x, z, 40) > 12 && wadiAt(x, z, 40).d > wadi.width + 12
  && gullyAt.every((g) => g(x, z, 30).d > 12)
  && Math.hypot(x - KNOLL.x, z - KNOLL.z) > KNOLL_SHOULDER + pad;   // (the town's hill: an outcrop stood in its west lane)
// CRESTS (in the box)
for (let i = 0, tries = 0; i < 26 && tries < 30000; tries++) {
  const x = PLAY.x0 + 12 + rand() * (PLAY.x1 - PLAY.x0 - 24), z = PLAY.z0 + 12 + rand() * (PLAY.z1 - PLAY.z0 - 24);
  if (djebelD(x, z) < 8) continue;
  const sl = slopeDeg(x, z);
  if (sl < 8 || sl > 30 || hollow(x, z, 7) > -0.3) continue;      // a convex crest, the top of a face
  if (!clearOf(x, z, 18) || taken.some((t) => Math.hypot(t.x - x, t.z - z) < 34)) continue;
  const yaw = contourYaw(x, z) + (rand() - 0.5) * 0.35, c = Math.cos(yaw), sn = Math.sin(yaw);
  const big = ofShape(rand() < 0.55 ? "block" : "mesa"), Bg = big[(rand() * big.length) | 0], kb = 0.55 + rand() * 0.35;
  slab(x, z, yaw, Bg, kb, 0.35 + rand() * 0.15);
  for (let j = 0, n = 1 + ((rand() * 2) | 0); j < n; j++) {
    const side = rand() < 0.5 ? -1 : 1, pool = ofShape(rand() < 0.6 ? "low" : "block"), Sz = pool[(rand() * pool.length) | 0], k = 0.4 + rand() * 0.3;
    const off = side * ((Bg.len * kb) / 2 + (Sz.len * k) / 2 * 0.75 + rand() * 2.5), across = (rand() - 0.5) * 3;
    slab(x + off * c + across * sn, z - off * sn + across * c, yaw + (rand() - 0.5) * 0.6, Sz, k, 0.35 + rand() * 0.15);
  }
  taken.push({ x, z });
  i++;
}
const crestSlabs = rocks.length;
// CLIFFS (the frame's steep faces, seen from the box's edge)
for (let i = 0, tries = 0; i < 40 && tries < 40000; tries++) {
  const x = -W / 2 + 60 + rand() * (W - 120), z = -W / 2 + 60 + rand() * (W - 120), o = outside(x, z);
  if (o < 12 || o > 150 || slopeDeg(x, z) < 22 || taken.some((t) => Math.hypot(t.x - x, t.z - z) < 30)) continue;
  let cx = x, cz = z;
  for (let j = 0, n = 3 + ((rand() * 3) | 0); j < n; j++) {
    const yaw = contourYaw(cx, cz), pool = ofShape(rand() < 0.7 ? "mesa" : "block"), Sz = pool[(rand() * pool.length) | 0], k = 0.9 + rand() * 0.5;
    slab(cx, cz, yaw + (rand() - 0.5) * 0.2, Sz, k, 0.45);
    const step = Sz.len * k * 0.8;
    cx += Math.cos(yaw) * step; cz -= Math.sin(yaw) * step;
    if (slopeDeg(cx, cz) < 16) break;
  }
  taken.push({ x, z });
  i++;
}
const r2 = (v) => Math.round(v * 100) / 100;
fs.writeFileSync("games/alg-rts/maps/abdiRocks.js", `// GENERATED by tools/algAbdiLevel.mjs — do not edit: the sandstone outcrops on the djebel's crests (${crestSlabs}
// slabs, in the box) and the frame's cliffs (${rocks.length - crestSlabs}). { x, y, z, yaw, k, v }: v an index into
// algSandstone SANDSTONE_GAME, k its scale, y its base (sunk into the ground).
export const ROCKS = [
${rocks.map((r) => `  { x: ${r2(r.x)}, y: ${r2(r.y)}, z: ${r2(r.z)}, yaw: ${r2(r.yaw)}, k: ${r2(r.k)}, v: ${r.v} },`).join("\n")}
];
`);
console.log(`rocks: ${crestSlabs} crest slabs in the box, ${rocks.length - crestSlabs} cliff slabs on the frame`);
// THE TOWN's houses (the game: an instanced house field, algHouse.js) — y the lowest corner's ground (no house floats)
for (const o of town) o.y = Math.min(...o.corners.map(([x, z]) => H(x, z)));
fs.writeFileSync("games/alg-rts/maps/abdiTown.js", `// GENERATED by tools/algAbdiLevel.mjs — do not edit: the town on the knoll (${town.length} houses: the M'zab kit
// and a few whitewashed, algHouse.js) — [type, state, x, y, z, yaw, fx, fz, hx, hz]: fx fz hx hz its footprint's centre and
// half sizes (world metres, turned by yaw: the nav grid, the cover); the souk square's centre, its outward axis, size, height.
export const TOWN_HOUSES = [
${town.map((o) => `  ["${o.type}", "${o.state}", ${r2(o.x)}, ${r2(o.y)}, ${r2(o.z)}, ${r2(o.yaw)}, ${r2(o.corners.reduce((a, c) => a + c[0], 0) / 4)}, ${r2(o.corners.reduce((a, c) => a + c[1], 0) / 4)}, ${r2(o.w / 2)}, ${r2(o.d / 2)}],`).join("\n")}
];
export const TOWN_SQUARE = { x: ${r2(SQ.x)}, z: ${r2(SQ.z)}, y: ${r2(H(SQ.x, SQ.z))}, ux: ${r2(SQ.ux)}, uz: ${r2(SQ.uz)}, hw: ${SQ.hw}, hd: ${SQ.hd} };
`);
const byType = {}; for (const o of town) byType[o.type] = (byType[o.type] ?? 0) + 1;
console.log(`town: ${town.length} houses ${JSON.stringify(byType)}`);

// ── Paint, by the relief — calm in the box, rock only on the frame ──────────
const S = man.terrain.splatSize ?? man.splatRes;
const splat = Buffer.alloc(S * S * 8);
const put = (t, c, v) => { splat[(c >> 2) * S * S * 4 + t * 4 + (c & 3)] = v; };
for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
  const x = -W / 2 + ((j + 0.5) * W) / S, z = -W / 2 + ((i + 0.5) * W) / S, t = i * S + j;
  const w = new Float32Array(7), sl = slopeDeg(x, z), o = outside(x, z), frame = smoothstep(10, 50, o);
  const road = 1 - smoothstep(3.0, 5.2, pisteD(x, z, 20));
  const bed = 1 - smoothstep(wadi.width * 0.35, wadi.width * 0.6, wadiAt(x, z, 30).d);
  // the frame only: cliff faces where steep, scree on its slopes; in the box a steep bank is red earth
  const cliff = frame * smoothstep(30, 42, sl);
  const scree = frame * smoothstep(14, 26, sl);
  const grove = 1 - smoothstep(OASIS.r + 6, OASIS.r + 26, Math.hypot(x - OASIS.x, z - OASIS.z) + 10 * (noise(x / 14, z / 14, 46) - 0.5));
  const d = djebelD(x, z);
  // RED EARTH in BIG ZONES (CoH's frames: pale ochre crests and open ground, red-orange hollows and slopes —
  // broad areas, not speckle; measured 2026-10-19): the hollows at two scales, the slopes and the terrace
  // faces, large patches (90-150 m) with ragged edges; more of it up on the djebel
  // (the first pass, zone 0.7: luma 108, saturation 0.62 — too red; CoH 133-159, 0.45-0.51)
  const zone = smoothstep(0.58, 0.7, noise(x / 120, z / 120, 43) * 0.75 + noise(x / 35, z / 35, 44) * 0.25);
  const red = Math.min(1, smoothstep(0.2, 0.8, hollow(x, z, 14) + (noise(x / 22, z / 22, 41) - 0.5) * 0.35) * 0.55
    + smoothstep(10, 24, sl) * 0.8 + zone * 0.45 + smoothstep(0, 40, d) * 0.2);
  // THE FACES DARKER AND VARIED (you, 2026-10-19: "the terrace faces are uniformly bright red"): on the steep,
  // part of the red goes to slot 2 — a DARK red stony earth — in streaks down the slope (noise stretched
  // along the fall line) and deeper at the foot of each face; CoH's red slopes are dark and light in bands.
  const [gx, gz] = grad(x, z, 1.5), gl = Math.hypot(gx, gz) || 1;
  const along = (x * gz - z * gx) / gl;   // across the fall line: streaks run DOWN the face
  const streak = smoothstep(0.4, 0.7, noise(along / 5, (x * gx + z * gz) / gl / 30, 61) * 0.7 + noise(x / 9, z / 9, 62) * 0.3);
  // (the foot's weight halved and NOTHING dark on a gully's floor: the channels read as black slits — 2026-10-19)
  const foot = smoothstep(0.3, 1.2, hollow(x, z, 6));
  const gullyD = Math.min(...gullyAt.map((g) => g(x, z, 24).d));
  const gullyFloor = 1 - smoothstep(4, 9, gullyD), gullyWall = 1 - smoothstep(9, 18, gullyD);
  // THE TOWN's ground (2026-10-20): packed earth on its terraces, lanes and risers — the red faces read as a
  // bullseye round the knoll
  const townK = 1 - smoothstep(KNOLL_RINGS[KNOLL_RINGS.length - 1].r1, KNOLL_SHOULDER - 4, knollD(x, z));
  const darkRed = smoothstep(14, 26, sl) * Math.min(1, 0.25 + 0.6 * streak + 0.25 * foot) * (1 - gullyFloor) * (1 - 0.65 * gullyWall) * (1 - townK);
  w[6] = Math.max(road, townK * (0.45 + 0.3 * noise(x / 7, z / 7, 47)));
  let rest = 1 - road;
  w[4] = rest * bed; rest -= w[4];
  w[5] = rest * cliff; rest -= w[5];
  w[2] = rest * Math.max(scree, darkRed * red); rest -= w[2];
  w[3] = rest * grove; rest -= w[3];
  w[1] = rest * red * (1 - townK); rest -= w[1];
  w[0] = rest;
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  for (let c = 0; c < 7; c++) if (w[c]) put(t, c, Math.round((255 * w[c]) / sum));
}

// ── Plants (the base's slots) ──────────────────────────────────────────────
const patches = (x, z, scale, cover, s) => {
  const n = noise(x / scale, z / scale, s) * 0.7 + noise(x / (scale * 0.35), z / (scale * 0.35), s + 7) * 0.3;
  return smooth01((n - (1 - cover)) / 0.12);
};
const clear = [...LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + 8 })), { x: KNOLL.x, z: KNOLL.z, r: 50 }, ...town.map((o) => ({ x: o.x, z: o.z, r: Math.hypot(o.w, o.d) / 2 + 2 }))];   // (the town: its hill and every house)
const fordPts = FORDS;
function growK(x, z, bedOk = false) {
  let k = smooth01((pisteD(x, z, 20) - 5) / 4) * (1 - smoothstep(26, 34, slopeDeg(x, z)));
  if (!bedOk) k *= smoothstep(wadi.width * 0.5, wadi.width * 0.9, wadiAt(x, z, 30).d);
  const w = wadiAt(x, z, 40);
  if (w.d < 30) for (const fs of fordPts) k *= smoothstep(14, 26, Math.abs(w.s - fs));   // the fords stay open
  for (const c of clear) k = Math.min(k, smooth01((Math.hypot(x - c.x, z - c.z) - c.r) / 8));
  return k;
}
const bankK = (x, z, a, b) => smoothstep(b, a, wadiAt(x, z, 40).d);
const oasisIn = (x, z) => 1 - smoothstep(OASIS.r + 4, OASIS.r + 22, Math.hypot(x - OASIS.x, z - OASIS.z));
const djebel = (x, z) => smoothstep(0, 50, djebelD(x, z));
const TALL = {
  0: (x, z) => 0.5 * djebel(x, z) * smoothstep(20, 120, outside(x, z)) * patches(x, z, 40, 0.55, 30),        // cedars on the skyline
  1: (x, z) => 0.3 * djebel(x, z) * (1 - smoothstep(20, 80, outside(x, z))) * patches(x, z, 34, 0.32, 31),   // holm oaks: the FLN's cover
  2: (x, z) => 0.6 * oasisIn(x, z) * patches(x, z, 16, 0.55, 34) + 0.25 * bankK(x, z, 16, 30) * patches(x, z, 30, 0.25, 35),   // date palms
  3: (x, z) => 0.35 * djebel(x, z) * patches(x, z, 26, 0.4, 36),                                               // juniper scrub
};
const GROUND = {
  0: (x, z) => (0.4 + 0.3 * smoothstep(0, 0.5, hollow(x, z))) * patches(x, z, 24, 0.4, 40) * (1 - oasisIn(x, z)),   // alfa
  1: (x, z) => 0.3 * Math.max(oasisIn(x, z) * 0.7, bankK(x, z, 14, 24) * 0.6) * patches(x, z, 20, 0.35, 41),        // doum palms
  3: (x, z) => 0.5 * bankK(x, z, 8, 14),                                                                              // oleander
  4: (x, z) => 0.35 * bankK(x, z, 10, 20) * patches(x, z, 25, 0.5, 44),                                              // tamarisk
  5: (x, z) => 0.4 * Math.max(...LAYOUT.sites.filter((s) => ["farm", "hamlet", "oasis"].includes(s.kind)).map((s) => { const r = Math.hypot(x - s.x, z - s.z); return smoothstep(s.r + 4, s.r + 10, r) * (1 - smoothstep(s.r + 16, s.r + 26, r)); })) * patches(x, z, 10, 0.5, 42),   // prickly pear hedges
  7: (x, z) => 0.25 * (1 - djebel(x, z)) * patches(x, z, 40, 0.3, 47),                                               // asphodel
};
function plantPaint(res, pages, fns) {
  const out = Buffer.alloc(res * res * 4 * pages), counts = {};
  for (let pz = 0; pz < res; pz++) {
    const z = ((pz + 0.5) / res) * W - W / 2;
    for (let px = 0; px < res; px++) {
      const x = ((px + 0.5) / res) * W - W / 2;
      if (outside(x, z) > 220) continue;
      const k = growK(x, z), kBank = growK(x, z, true);
      for (const [ch, fn] of Object.entries(fns)) {
        const g = pages === 2 && (+ch === 3 || +ch === 4) ? kBank : k;
        const v = Math.round(Math.max(0, Math.min(1, fn(x, z) * g)) * 255);
        if (!v) continue;
        out[((ch / 4) | 0) * res * res * 4 + (pz * res + px) * 4 + (ch % 4)] = v;
        counts[ch] = (counts[ch] ?? 0) + 1;
      }
    }
  }
  return { out, counts };
}
const tallPaint = plantPaint(512, 1, TALL);
const groundPaint = plantPaint(1024, 2, GROUND);

// ── Manifest: the base's look; its slots' MEANINGS kept (the game's splats / stones / minimap read them),
// THREE PHOTOS changed for the CoH read (2026-10-19, measured: the Aurès' brown_mud_dry is among the darkest,
// speckiest ground photos — the valley measured luma 98, R/G 1.18 against CoH's 133-159 and 1.4) ──
blankManifest(man);
const photo = (dir, file) => ({ name: file, url: `${dir}/${file}` });
const PH = { diff: "diff_1k.jpg", nor: "nor_gl_1k.jpg", rough: "rough_1k.jpg", ao: "ao_1k.jpg" };
const set = (slot, name, id, look) => {
  const dir = `/textures/ground/${id}`;
  man.paintLayers[slot] = { ...man.paintLayers[slot], name,
    albedo: photo(dir, `${id}_${PH.diff}`), normal: photo(dir, `${id}_${PH.nor}`), rough: photo(dir, `${id}_${PH.rough}`), ao: photo(dir, `${id}_${PH.ao}`),
    ...look };
};
set(0, "Valley soil", "mud_cracked_dry_03", { uvScale: W / 2.6, normalStr: 0.45, aoStr: 0.3, tint: "#f6e2cc" });   // pale dry earth (luma 174) — small, soft cracks: a grain, not a salt-flat pattern
set(1, "Red earth", "desert_hollow", { uvScale: W / 16, normalStr: 0.7, aoStr: 0.35, tint: "#ecd2c0" });        // the CoH red-orange, toned
set(2, "Dark red earth", "red_mud_stones", { uvScale: W / 10, normalStr: 0.8, aoStr: 0.4, tint: "#d9bca8" });   // (the scree slot: the frame's slopes AND the faces' dark streaks)
set(6, "Dirt track", "desert_road", { uvScale: W / 6.4, normalStr: 0.6, aoStr: 0.3, tint: "#f0e0cc" });        // pale, as CoH's tracks
const blobs = new Map([["heightmap", Buffer.from(hgt.buffer)], ["splat", splat], ["susukiDensity", tallPaint.out], ["foliagePaint", groundPaint.out]]);
const bytes = await writeProject(args.out, { manifest: man, blobs });
console.log(`${args.out}: ${(bytes / 1e6).toFixed(1)} MB — the ground ${lo.toFixed(1)}..${hi.toFixed(1)} m`);
console.log(`plants (texels): tall ${JSON.stringify(tallPaint.counts)} · ground ${JSON.stringify(groundPaint.counts)}`);
for (const s of LAYOUT.sites) {
  let mx = 0; for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; mx = Math.max(mx, Math.abs(H(s.x + Math.cos(a) * s.r * 0.7, s.z + Math.sin(a) * s.r * 0.7) - H(s.x, s.z))); }
  console.log(`  ${s.name.padEnd(22)} ${H(s.x, s.z).toFixed(1)} m, relief over its ground ${mx.toFixed(1)} m`);
}
const bx = Math.round(PLAY.x1 - PLAY.x0), box = new Float32Array(bx * bx);
for (let i = 0; i < bx; i++) for (let j = 0; j < bx; j++) box[i * bx + j] = H(PLAY.x0 + j, PLAY.z0 + i);
printRtsMetrics(measureRtsMap(box, bx, bx - 1), "the box");
