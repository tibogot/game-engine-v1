/**
 * MAP 3 — EL KANTARA, "LA PORTE DU DÉSERT" (2026-10-13): its ground SHAPED FOR PLAY from the data in
 * games/alg-rts/maps/kantara.js, built FROM THE EMPTY BASE (tools/algBaseLevel.mjs) every time — the
 * base's look (sky, light, grass and plant settings), nothing of another map. The plan:
 * games/alg-rts/TODO.md "MAP 3".
 *
 *   node tools/algKantaraLevel.mjs                       rebuild El Kantara from the base
 *   node tools/algKantaraLevel.mjs [--from <base.v3proj>] [--out <new.v3proj>]
 *
 * THE GROUND, AS COH 3's DESERT (the second try — the first, a flat reg with a plateau walled in slabs
 * and canyons, looked nothing like its frames):
 *   rolling     kantara.js HILLS everywhere: two scales of soft hills, calm round the sites, the road
 *               and the grove; rising ~5 m to the north (the Aurès' foot)
 *   the sand    kantara.js SAND: a raised MASS of sand (the west and south-west; ridges across the red
 *               ground elsewhere) CUT INTO LEVELS — near-flat tops, a sharp lip (the crest), a short
 *               steep drop to the next level down: CoH's "dunes" (you: "the whole terrain goes down;
 *               plateaus with a sharp crest"). The crests follow the mass's contours: irregular arcs.
 *   the oued    out of the gorge, south past the palm grove: a channel with soft banks, fords
 *   the road    carved (tools/lib/trackCarve.mjs), a little wider than a piste
 *   the frame   the AURÈS WALL to the north (terraced, grey), the GORGE through it; mesas east and west;
 *               tall dunes south and south-west — all outside the box
 * THE ROCK    kantara.js ROCK: OUTCROPS (a big slab, smaller ones beside it along the slope) and low
 *             SHELVES (a row of low slabs along a contour; 0 for now) on the hills' SHOULDERS (convex, 6-20°),
 *             their long side along the slope's contour, sunk a third into the ground →
 *             games/alg-rts/maps/kantaraRocks.js (the game adds them as algLandmarks' own)
 * THE PAINT   BY THE RELIEF, as CoH's: 0 RED PEBBLY ground (desert_pebbly), the base;
 *             2 SAND (desert_sand: wind ripples, faint) on the dunes, the shoulders and DRIFTED round
 *             every rock's foot; 1 RED earth (desert_hollow) in the hollows and on the dunes' LEE;
 *             3 the grove's earth; 4 grey rock (the Aurès wall, the oued's bed); 5 sandstone (steep
 *             frame faces); 6 the road. No grass (no grass data); plants on every slot but the road.
 * THE PLANTS  the base's slots: date palms in the grove, junipers on the Aurès wall, alfa tufts on the
 *             reg, doum palms, oleander and tamarisk along the oued, prickly pear round the grove
 * Photos regraded by tools/algGradePhoto.mjs (a paint tint only darkens).
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { blankManifest, BASE_LEVEL } from "./lib/algLevelBase.mjs";
import { measureRtsMap, printRtsMetrics } from "./lib/rtsMapMetrics.mjs";
import { trackCarver, PISTE } from "./lib/trackCarve.mjs";
import { buildSandstoneRock, SANDSTONE_GAME } from "../games/alg-rts/algSandstone.js";
import { PLAY, LAYOUT, MAP, PLAIN, HILLS, SAND, ROCK, GORGE, FAR_MESAS, GROVE } from "../games/alg-rts/maps/kantara.js";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
args.out ??= "public/levels/alg-kantara.v3proj";
args.from ??= BASE_LEVEL;   // every time from the empty base, never from another map (2026-10-13)
const ROCKS_FILE = "games/alg-rts/maps/kantaraRocks.js";

const tpl = await readProject(args.from);
const man = tpl.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const cell = W / (N - 1);

// ── Noise (Math.imul: the plain JS multiply loses bits past 2^53) ──────────
const hash = (x, z, s) => { let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const sm = (t) => t * t * (3 - 2 * t);
function noise(x, z, s = 1) {
  const xi = Math.floor(x), zi = Math.floor(z), fx = sm(x - xi), fz = sm(z - zi);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;   // 0..1
}
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const smooth01 = (t) => smoothstep(0, 1, t);

// ── Polylines ────────────────────────────────────────────────────────────
/** Catmull-Rom through the points, resampled every `step` m. */
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
/** A polyline's distance field (16 m bins of segments): { d, px, pz, tx, tz, s } — s the arc length
 *  of the nearest point, of `len` in all. */
function polyField(pts) {
  const segs = [], at = [0];
  for (let k = 0; k < pts.length - 1; k++) {
    segs.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
    at.push(at[k] + Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]));
  }
  const B = 16, grid = new Map(), key = (i, j) => `${i},${j}`;
  segs.forEach((s, idx) => {
    const i0 = Math.floor(Math.min(s[0], s[2]) / B), i1 = Math.floor(Math.max(s[0], s[2]) / B);
    const j0 = Math.floor(Math.min(s[1], s[3]) / B), j1 = Math.floor(Math.max(s[1], s[3]) / B);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx); }
  });
  const field = (x, z, reach = 400) => {
    let best = Infinity, px = x, pz = z, tx = 1, tz = 0, s = 0;
    const ci = Math.floor(x / B), cj = Math.floor(z / B);
    for (let r = 0; r * B <= reach; r++) {
      for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        for (const idx of grid.get(key(i, j)) ?? []) {
          const [ax, az, bx, bz] = segs[idx], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
          const d = Math.hypot(x - (ax + dx * u), z - (az + dz * u));
          if (d < best) { best = d; px = ax + dx * u; pz = az + dz * u; const l = Math.sqrt(L); tx = dx / l; tz = dz / l; s = at[idx] + u * l; }
        }
      }
      if (best < (r - 1) * B) break;   // nothing nearer can be further out
    }
    return { d: best, px, pz, tx, tz, s };
  };
  field.len = at[at.length - 1];
  return field;
}

// THE OUED: none in the box since 2026-10-13 (CoH's desert has no riverbed; its grey bed spoiled the sand) —
// the code keeps working with one, for a map that wants it.
const wadi = LAYOUT.wadis[0] ?? { width: 0, depth: 0, fords: [] };
const wadiAt = LAYOUT.wadis[0] ? polyField(spline(wadi.points, 2)) : Object.assign(() => ({ d: Infinity, s: 0 }), { len: 1 });
const roadAt = polyField(spline(MAP.tracks[0].points, 2));
const gorgeAt = polyField(spline(GORGE.points, 4));
/** Distance outside the play box (0 inside). */
const outside = (x, z) => Math.hypot(Math.max(PLAY.x0 - x, 0, x - PLAY.x1), Math.max(PLAY.z0 - z, 0, z - PLAY.z1));
const flats = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + 18 }));

/** 0..1: the Aurès wall (north, outside the box), 0 in the gorge. */
function wallK(x, z) {
  const t = smoothstep(232, 330, -z);
  if (t <= 0) return 0;
  return t * smoothstep(GORGE.half, GORGE.half + 40, gorgeAt(x, z, 120).d);
}
/** 0..1: the frame's tall dunes (south and south-west, outside the box). */
const duneK = (x, z) => Math.max(smoothstep(236, 300, z), smoothstep(236, 300, -x) * smoothstep(-80, 20, z));
/** 0..1: the sand sector (the box's west), its edge ragged. */
function sandSector(x, z) {
  const c = Math.cos(SAND.yaw), s = Math.sin(SAND.yaw), dx = x - SAND.x, dz = z - SAND.z;
  const e = Math.hypot((dx * c - dz * s) / SAND.rx, (dx * s + dz * c) / SAND.rz) + (noise(x / 45, z / 45, 47) - 0.5) * 0.4;
  return 1 - smoothstep(0.6, 1.05, e);
}
/** 0..1: a sand RIDGE crossing the red ground (CoH frame 8), sparse, elongated; its edge WIDE (~20 m) so
 *  the mass rises gently enough to cut into levels, not a cliff. */
function ridgeK(x, z) {
  const along = (-x * SAND.wind[1] + z * SAND.wind[0]) / 80, across = (x * SAND.wind[0] + z * SAND.wind[1]) / 40;
  const n = noise(along, across, 61) * 0.8 + noise(x / 30, z / 30, 62) * 0.2;
  return smoothstep(1 - SAND.ridges - 0.12, 1 - SAND.ridges + 0.22, n) * (1 - sandSector(x, z));
}
/** THE SAND MASS (m): the field's (`mass` in its middle, falling over ~60 m to its edge) and the ridges',
 *  its contours wiggled (~25 m) — the crests will follow them: irregular arcs. */
function sandMassAt(x, z) {
  // LUMPY (measured: a smooth 6.5 m mass gave three crests in 150 m; CoH's come every ~10-15 m): mounds
  // of ~55 m and ~22 m on the base — a crest each time the mass climbs a step, so they need its slope
  // (~0.2: a step of 1.8 m every ~9 m), their contours curved
  const lumps = (noise(x / 55, z / 55, 63) - 0.5) * 2 * SAND.lumps + (noise(x / 22, z / 22, 66) - 0.5) * 2 * SAND.lumps * 0.3;
  const field = sandSector(x, z) * (SAND.mass + lumps);
  const ridge = ridgeK(x, z) * (SAND.ridgeMass + lumps * 0.6);
  return Math.max(0, field, ridge);
}
/** The mass CUT INTO LEVELS: each level a near-flat top rising gently (a quarter of a step) to the next
 *  level's foot, then the drop — steepest at its LIP (the crest), eased at its toe. */
function terrace(M, G = 0.2) {
  if (M <= 0) return 0;
  // the drop's share of a level SIZED FROM THE MASS'S SLOPE G here, so every drop is ~SAND.riser° wherever
  // the mass rises gently or fast (a fixed share gave 14° drops on the gentle mass: soft lips)
  const S = SAND.step, run = (0.8 * S) / Math.tan((SAND.riser * Math.PI) / 180);
  const r = Math.min(0.6, Math.max(0.06, (run * G) / S)), q = M / S, k = Math.floor(q), f = q - k;
  // the top a fifth of the step, the drop t^1.3 (its lip 1.3× its mean slope — t² made 45° lips, lines
  // the nav grid would have blocked)
  const g = f < 1 - r ? 0.2 * f / (1 - r) : 0.2 + 0.8 * ((f - (1 - r)) / r) ** 1.3;
  return S * (k + g);
}
/** 0..1: the sand in the box (where the mass lies). */
const sandMask = (x, z) => smoothstep(0.08, 0.9, sandMassAt(x, z));
/** 0..1: sand, in or outside the box. */
const sandK = (x, z) => Math.max(duneK(x, z), sandMask(x, z));
/** The palm grove's ellipse: < 1 inside. */
function groveE(x, z) {
  const c = Math.cos(GROVE.yaw), s = Math.sin(GROVE.yaw), dx = x - GROVE.x, dz = z - GROVE.z;
  return Math.hypot((dx * c - dz * s) / GROVE.rx, (dx * s + dz * c) / GROVE.rz);
}
/** 0..1: how CALM the ground is here (1 = the hills' full height): the sites, the grove, the road. */
function calmK(x, z) {
  let k = 1;
  for (const f of flats) k = Math.min(k, smoothstep(f.r * 0.55, f.r, Math.hypot(x - f.x, z - f.z)));
  k = Math.min(k, 0.25 + 0.75 * smoothstep(0.85, 1.25, groveE(x, z)));
  return k;
}
/** The dunes' profile at a point (0 trough .. 1 crest): the long windward back, the slip face. Wind
 *  from the north-east; the crests curve (a warped coordinate). */
// THE WIND (kantara.js SAND.wind): the way the slip faces face — AWAY from the afternoon sun (from the
// west), so every crest throws its shadow onto its own lee (CoH's frames: the low sun does the work).
const [WX, WZ] = (() => { const [a, b] = SAND.wind, l = Math.hypot(a, b); return [a / l, b / l]; })();
function duneProfile(x, z, wave, lee = 0.32) {
  // the crests curve: the coordinate warped at ~2 and ~0.8 spacings (CoH's crests are arcs, not lines)
  const u = (x * WX + z * WZ) / wave + 1.4 * noise(x / (wave * 2.2), z / (wave * 2.2), 24) + 0.35 * noise(x / (wave * 0.8), z / (wave * 0.8), 28), f = u - Math.floor(u);
  // the crest's height varies ALONG it (0.7..1): separate dunes, not parallel ridges — but never so low
  // that the crest goes soft (0.35 / 0.55 flattened half of them)
  const along = 0.7 + 0.3 * smoothstep(0.25, 0.75, noise((-x * WZ + z * WX) / (wave * 1.4), u * 0.7, 26));
  // THE CREST (you: "what makes a dune look like a dune is the crest"): the windward back keeps
  // climbing to the very top (a^1.25 — a smoothstep went flat there and rounded every crest), then the
  // slip face drops at once, steep from the edge, easing out at its foot ((1-b)^2)
  const W0 = 1 - lee;
  // the slip face is a STRAIGHT slope at the sand's resting angle, only its foot eased (its last 25 %):
  // the knife-edge crest is where this meets the gentle back (measured: an eased face read as 7°)
  if (f < W0) return Math.pow(f / W0, 1.25) * along;
  const b = (f - W0) / (1 - W0);
  return (b < 0.75 ? 1 - b * (1 / 0.875) : ((1 - b) / 0.25) ** 2 * (0.25 / 0.875)) * along;
}

function naturalAt(x, z) {
  const calm = calmK(x, z), o = outside(x, z);
  // THE ROLLING GROUND: two scales of soft hills (zero mean), rising to the north
  let h = PLAIN - z * 0.012;
  const hills = (noise(x / HILLS.wave, z / HILLS.wave, 3) - 0.5) * 2 * HILLS.amp + (noise(x / HILLS.wave2, z / HILLS.wave2, 7) - 0.5) * 2 * HILLS.amp2;
  h += hills * calm;
  // THE SAND, as CoH's: the mass CUT INTO LEVELS (sharp crests, each a step down) in the field and the
  // ridges; the frame's tall dunes outside the box
  const dk = duneK(x, z);
  const M = sandMassAt(x, z);
  if (M > 0) {
    const G = Math.hypot(sandMassAt(x + 1.5, z) - sandMassAt(x - 1.5, z), sandMassAt(x, z + 1.5) - sandMassAt(x, z - 1.5)) / 3;
    h += (1 - dk) * terrace(M, G) * calm;
  }
  if (dk > 0) h += dk * (3 + 13 * duneProfile(x, z, 46) * (0.6 + 0.5 * noise(x / 100, z / 100, 29)));
  // THE FRAME: the mesas (east and west), the Aurès wall (terraced) and its gorge (north)
  for (const m of FAR_MESAS) {
    const a = Math.atan2(z - m.z, x - m.x), r = m.r * (1 + 0.18 * (noise(Math.cos(a) * 2 + 9, Math.sin(a) * 2 + 9, 31) - 0.5));
    h += m.h * smoothstep(-0.5, 4, r - Math.hypot(x - m.x, z - m.z));
  }
  const wk = wallK(x, z);
  if (wk > 0) {
    const s = wk * 4, terr = (Math.floor(s) + smoothstep(0.55, 1, s - Math.floor(s))) / 4;
    h += 115 * terr * (0.75 + 0.35 * noise(x / 80, z / 80, 17));
  }
  // past the box the hills grow a little (the camera sees past its edge: no flat skirt)
  if (o > 0) h += hills * 0.6 * smoothstep(0, 120, o);
  // THE OUED: a channel, soft banks; shallower at its fords
  const w = wadiAt(x, z, 60);
  if (w.d < wadi.width + 10) {
    const f = w.s / wadiAt.len;
    const ford = (wadi.fords ?? []).reduce((k, fp) => Math.max(k, 1 - smoothstep(0.004, 0.012, Math.abs(f - fp))), 0);
    // the valley floor: the hills ease toward the oued, so the channel cuts a plain, not a ridge
    const floor = PLAIN - z * 0.012;
    h = floor + (h - floor) * smoothstep(wadi.width * 0.6, wadi.width + 10, w.d);
    h -= (1 - smoothstep(wadi.width * 0.4, wadi.width, w.d)) * wadi.depth * (1 - 0.75 * ford);
  }
  return h;
}
/** The ground with the road CARVED in (a little wider than a piste). */
const ROAD_PROFILE = { ...PISTE, half: 3.2, shoulder: 3 };
const carve = trackCarver((x, z) => naturalAt(x, z), roadAt, ROAD_PROFILE);
const heightAt = (x, z) => carve(x, z, naturalAt(x, z));

// ── Heights ──────────────────────────────────────────────────────────────
const hgt = new Float32Array(N * N);
let hi = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const v = heightAt(-W / 2 + j * cell, -W / 2 + i * cell);   // row 0 = north (−Z)
  hgt[i * N + j] = v / TOP;
  if (v > hi) hi = v;
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
/** The relief's curvature: the ring's mean height minus the point's (+ a hollow, − a shoulder / crest). */
function hollow(x, z, r = 9) {
  let s = 0;
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; s += H(x + Math.cos(a) * r, z + Math.sin(a) * r); }
  return s / 8 - H(x, z);
}

// ── The sandstone outcrops and shelves ────────────────────────────────────
// Their real sizes, from the generator (the game builds exactly these: algSandstone SANDSTONE_GAME).
const SIZE = SANDSTONE_GAME.map(([sh, sd]) => {
  const g = buildSandstoneRock(sh, sd);
  g.computeBoundingBox();
  const b = g.boundingBox;
  return { shape: sh, len: b.max.x - b.min.x, deep: b.max.z - b.min.z, tall: b.max.y - b.min.y };
});
const ofShape = (sh) => SIZE.map((s, v) => ({ ...s, v })).filter((s) => s.shape === sh);
const rand = (() => { let s = ROCK.seed; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 1013904223) >>> 0) / 4294967296; })();
const rocks = [];
/** A slab sunk `sink` of its height into the ground under its footprint, its long side along `yaw`. */
function slab(x, z, yaw, S, k, sink) {
  const c = Math.cos(yaw), s = Math.sin(yaw), hl = (S.len * k) / 2, hd = (S.deep * k) / 2;
  let lo = Infinity;
  for (const a of [-1, 0, 1]) for (const e of [-1, 0, 1]) lo = Math.min(lo, H(x + a * hl * c + e * hd * s, z - a * hl * s + e * hd * c));
  rocks.push({ x, y: lo - sink * S.tall * k, z, yaw, k, v: S.v });
}
const taken = [];
/** A free shoulder for a rock: in the box, convex, 6-20°, off the road, the sites, the oued and the grove. */
function shoulder(x, z, apart, minSlope = 6, maxHollow = -0.25) {
  if (outside(x, z) > -14 && !(x > PLAY.x0 + 14 && x < PLAY.x1 - 14 && z > PLAY.z0 + 14 && z < PLAY.z1 - 14)) return false;
  const sl = slopeDeg(x, z);
  if (sl < minSlope || sl > 20 || hollow(x, z) > maxHollow) return false;
  if (roadAt(x, z, 30).d < 16 || wadiAt(x, z, 40).d < 24 || groveE(x, z) < 1.25) return false;
  if (LAYOUT.sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + 22)) return false;
  return !taken.some((t) => Math.hypot(t.x - x, t.z - z) < apart);
}
/** The slope's contour direction at a point (yaw for a slab whose long side runs along it). */
const contourYaw = (x, z) => { const [gx, gz] = grad(x, z, 3); return Math.atan2(gx, -gz) + Math.PI / 2; };
// OUTCROPS: a big slab (a banc or a block), one to three smaller beside it along the contour
for (let i = 0, tries = 0; i < ROCK.outcrops && tries < 20000; tries++) {
  const x = PLAY.x0 + rand() * (PLAY.x1 - PLAY.x0), z = PLAY.z0 + rand() * (PLAY.z1 - PLAY.z0);
  if (!shoulder(x, z, ROCK.spacing)) continue;
  if (sandSector(x, z) > 0.5 && rand() > ROCK.sandShare) continue;
  const yaw = contourYaw(x, z) + (rand() - 0.5) * 0.4, c = Math.cos(yaw), s = Math.sin(yaw);
  const big = ofShape(rand() < 0.4 ? "mesa" : "block"), B = big[(rand() * big.length) | 0], kb = (0.75 + rand() * 0.4) * ROCK.scale;
  slab(x, z, yaw, B, kb, 0.3 + rand() * 0.15);
  const n = 1 + ((rand() * 3) | 0);
  for (let j = 0; j < n; j++) {
    const side = rand() < 0.5 ? -1 : 1, pool = ofShape(rand() < 0.6 ? "low" : "block"), S = pool[(rand() * pool.length) | 0], k = (0.45 + rand() * 0.35) * ROCK.scale;
    const off = side * ((B.len * kb) / 2 + (S.len * k) / 2 * 0.7 + rand() * 3), across = (rand() - 0.5) * 5;
    slab(x + off * c + across * s, z - off * s + across * c, yaw + (rand() - 0.5) * 0.7, S, k, 0.3 + rand() * 0.2);
  }
  taken.push({ x, z });
  i++;
}
const outcropSlabs = rocks.length;
// SHELVES: a row of low slabs following a contour (CoH's red bands on a hillside)
for (let i = 0, tries = 0; i < ROCK.shelves && tries < 20000; tries++) {
  let x = PLAY.x0 + rand() * (PLAY.x1 - PLAY.x0), z = PLAY.z0 + rand() * (PLAY.z1 - PLAY.z0);
  if (!shoulder(x, z, ROCK.spacing * 1.2, 4, -0.1) || sandSector(x, z) > 0.4) continue;
  const n = 3 + ((rand() * 3) | 0), pool = ofShape("low");
  const sx = x, sz = z;
  for (let j = 0; j < n; j++) {
    const S = pool[(rand() * pool.length) | 0], k = 0.7 + rand() * 0.3, yaw = contourYaw(x, z);
    slab(x, z, yaw + (rand() - 0.5) * 0.25, S, k, 0.35);
    const step = S.len * k * 0.85;   // along the contour to the next
    x += Math.cos(yaw) * step; z -= Math.sin(yaw) * step;
    if (slopeDeg(x, z) < 4 || roadAt(x, z, 30).d < 14 || outside(x, z) > 0) break;
  }
  taken.push({ x: sx, z: sz });
  i++;
}
const r2 = (v) => Math.round(v * 100) / 100;
fs.writeFileSync(ROCKS_FILE, `// GENERATED by tools/algKantaraLevel.mjs — do not edit: the sandstone outcrops (${outcropSlabs} slabs) and
// shelves (${rocks.length - outcropSlabs}) on the hills' shoulders. { x, y, z, yaw, k, v }: v an index into
// algSandstone SANDSTONE_GAME, k its scale, y its base (sunk into the ground).
export const ROCKS = [
${rocks.map((r) => `  { x: ${r2(r.x)}, y: ${r2(r.y)}, z: ${r2(r.z)}, yaw: ${r2(r.yaw)}, k: ${r2(r.k)}, v: ${r.v} },`).join("\n")}
];
`);

/** 0..1: sand drifted round a rock's foot (a ragged ring a few metres past it). Rocks in 32 m bins. */
const rockBins = new Map();
for (const r of rocks) {
  const R = (SIZE[r.v].len * r.k) / 2 * 0.85, key = `${Math.floor(r.x / 32)},${Math.floor(r.z / 32)}`;
  if (!rockBins.has(key)) rockBins.set(key, []);
  rockBins.get(key).push({ x: r.x, z: r.z, R });
}
function driftK(x, z) {
  let k = 0;
  const bi = Math.floor(x / 32), bj = Math.floor(z / 32);
  for (let i = bi - 1; i <= bi + 1; i++) for (let j = bj - 1; j <= bj + 1; j++) {
    for (const r of rockBins.get(`${i},${j}`) ?? []) {
      const d = Math.hypot(x - r.x, z - r.z);
      if (d < r.R + 8) k = Math.max(k, 1 - smoothstep(r.R, r.R + 4 + 3 * noise(x / 3, z / 3, 51), d));
    }
  }
  return k;
}

// ── Paint, BY THE RELIEF ───────────────────────────────────────────────────
const S = man.terrain.splatSize ?? man.splatRes;
const splat = Buffer.alloc(S * S * 8);   // two planar RGBA planes: layer c in plane c >> 2, channel c & 3
const put = (t, c, v) => { splat[(c >> 2) * S * S * 4 + t * 4 + (c & 3)] = v; };
for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
  const x = -W / 2 + ((j + 0.5) * W) / S, z = -W / 2 + ((i + 0.5) * W) / S, t = i * S + j;
  const w = new Float32Array(7), sl = slopeDeg(x, z), wk = wallK(x, z);
  const bed = 1 - smoothstep(wadi.width * 0.4, wadi.width * 0.8, wadiAt(x, z, 30).d);
  const road = 1 - smoothstep(3.4, 5.6, roadAt(x, z, 30).d);
  const grey = Math.max(Math.min(1, smoothstep(0.02, 0.2, wk) * (0.5 + smoothstep(14, 26, sl))), bed);
  const faces = (1 - smoothstep(0.02, 0.2, wk)) * smoothstep(26, 40, sl) * smoothstep(10, 40, outside(x, z));   // the frame's faces only: in the box a steep face is sand
  // RED in the hollows and on the steeper faces (CoH: pale crests, red dips), ragged by noise; less
  // in the deep sand (its hollows fill with sand)
  const hv = hollow(x, z), sk = sandK(x, z);
  // THE LEE (CoH's painted polish): the slip faces — falling toward the wind's way — a deeper orange
  const [gx, gz] = grad(x, z, 1.5), gl = Math.hypot(gx, gz) || 1;
  const lee = smoothstep(0.35, 0.85, -(gx * WX + gz * WZ) / gl) * smoothstep(9, 20, sl) * smoothstep(0.2, 0.6, sk);
  // SAND DRIFTED at the foot of the rocks (CoH's frames: every outcrop sits in its own sand)
  const drift = driftK(x, z);
  const red = Math.min(1, smoothstep(0.05, 0.55, hv + (noise(x / 16, z / 16, 41) - 0.5) * 0.5) * (1 - 0.45 * sk)
    + smoothstep(12, 22, sl) * 0.35 * (1 - sk) + smoothstep(0.7, 0.82, noise(x / 30, z / 30, 43)) * 0.4 * (1 - sk)
    ) * (1 - drift);
  // CoH's blend (frames A-C): the RED PEBBLY ground the base; SAND where the sand lies (its edge ragged,
  // two scales of noise) and drifted round the rocks; RED EARTH in the hollows and on the dunes' lee.
  const sand = Math.max(smoothstep(0.2, 0.55, sk + (noise(x / 12, z / 12, 45) - 0.5) * 0.35 + (noise(x / 4, z / 4, 52) - 0.5) * 0.12), drift);
  const grove = 1 - smoothstep(0.85, 1.1, groveE(x, z) + (noise(x / 14, z / 14, 46) - 0.5) * 0.2);
  w[6] = road;
  let rest = 1 - road;
  w[4] = rest * grey; rest -= w[4];
  w[5] = rest * faces; rest -= w[5];
  w[3] = rest * grove; rest -= w[3];
  w[1] = rest * red; rest -= w[1];
  w[2] = rest * sand; rest -= w[2];
  w[0] = rest;
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  for (let c = 0; c < 7; c++) if (w[c]) put(t, c, Math.round((255 * w[c]) / sum));
}

// ── Plants (the base's slots) ──────────────────────────────────────────────
const patches = (x, z, scale, cover, s) => {
  const n = noise(x / scale, z / scale, s) * 0.7 + noise(x / (scale * 0.35), z / (scale * 0.35), s + 7) * 0.3;
  return smooth01((n - (1 - cover)) / 0.12);
};
const clearCircles = LAYOUT.sites.map((s) => ({ x: s.x, z: s.z, r: s.r + 10 }));
const rockCircles = rocks.map((r) => ({ x: r.x, z: r.z, r: (SIZE[r.v].len * r.k) / 2 + 1.5 }));
/** 0 where nothing grows: the road, the sites, the slabs, the steep, the oued's bed. */
function growK(x, z, bedOk = false) {
  let k = smooth01((roadAt(x, z, 20).d - 6) / 5) * (1 - smoothstep(24, 32, slopeDeg(x, z)));
  if (!bedOk) k *= smoothstep(wadi.width * 0.5, wadi.width * 0.9, wadiAt(x, z, 30).d);
  for (const c of clearCircles) k = Math.min(k, smooth01((Math.hypot(x - c.x, z - c.z) - c.r) / 8));
  for (const c of rockCircles) if (Math.abs(c.x - x) < c.r && Math.abs(c.z - z) < c.r && Math.hypot(c.x - x, c.z - z) < c.r) return 0;
  return k;
}
const bankK = (x, z, a, b) => smoothstep(b, a, wadiAt(x, z, 40).d);
const groveIn = (x, z) => 1 - smoothstep(0.8, 1.0, groveE(x, z));
const groveRing = (x, z) => { const e = groveE(x, z); return smoothstep(0.9, 1.0, e) * (1 - smoothstep(1.1, 1.3, e)); };
const TALL = {
  2: (x, z) => 0.55 * groveIn(x, z) * patches(x, z, 18, 0.5, 34) + 0.35 * bankK(x, z, 14, 26) * patches(x, z, 30, 0.3, 35) * (1 - sandK(x, z)),   // date palms
  3: (x, z) => 0.4 * smoothstep(0.1, 0.4, wallK(x, z)) * patches(x, z, 30, 0.45, 36),   // junipers on the Aurès wall
};
const GROUND = {
  // alfa tufts: on the reg, more in the hollows (CoH's scrub sits in the dips), few on the sand
  // (at 0.18-0.43 × 22 % cover it rounded to nothing — measured, 5 % of the box non-zero; CoH frame 9's
  // scrub is sparse but plain to see) — and a band of tufts where the sand thins out onto the red ground
  0: (x, z) => {
    const m = sandMask(x, z), edge = smoothstep(0.05, 0.25, m) * (1 - smoothstep(0.35, 0.7, m));
    return ((0.45 + 0.35 * smoothstep(0, 0.5, hollow(x, z))) * patches(x, z, 26, 0.35, 40) * (1 - 0.85 * sandK(x, z)) + 0.55 * edge * patches(x, z, 9, 0.5, 47)) * (1 - groveIn(x, z));
  },
  1: (x, z) => 0.3 * Math.max(groveRing(x, z), bankK(x, z, 12, 22) * 0.6) * patches(x, z, 20, 0.35, 41),   // doum palms
  3: (x, z) => 0.55 * bankK(x, z, 7, 13) * (0.4 + 0.6 * smoothstep(1.4, 0.9, groveE(x, z))),   // oleander
  4: (x, z) => 0.4 * bankK(x, z, 9, 18) * patches(x, z, 25, 0.5, 44),   // tamarisk (the oued)
  5: (x, z) => 0.45 * groveRing(x, z) * patches(x, z, 12, 0.45, 42),   // prickly pear
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
        const g = pages === 2 && (+ch === 3 || +ch === 4) ? kBank : k;   // oleander, tamarisk: on the banks
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

// ── Manifest: the base's look (already empty: tools/lib/algLevelBase.mjs); El Kantara's photos ──
blankManifest(man);
// THE SCRUB (slot 0, the base's alfa) DRY, as CoH's tufts (frame 9: yellow-grey, not green): sun-bleached
// stems, a dusty base, a little smaller and rounder.
Object.assign(man.foliagePlants[0], { name: "Desert scrub", dry: 0.8, colorBase: "#6e6446", colorTip: "#bfae7c", colorHead: "#d6c79a", size: 0.95, spread: 0.55, arch: 0.55 });
const photo = (dir, file) => ({ name: file, url: `${dir}/${file}` });
const PH = { diff: "diff_1k.jpg", nor: "nor_gl_1k.jpg", rough: "rough_1k.jpg", ao: "ao_1k.jpg" };
const set = (slot, name, id, look) => {
  const dir = `/textures/ground/${id}`;
  man.paintLayers[slot] = { ...man.paintLayers[slot], name,
    albedo: photo(dir, `${id}_${PH.diff}`), normal: photo(dir, `${id}_${PH.nor}`), rough: photo(dir, `${id}_${PH.rough}`), ao: photo(dir, `${id}_${PH.ao}`),
    // blocksGrass OFF (2026-10-13): it masks the PLANTS too (main.js foliageDensity.updateMask) — it killed
    // every alfa tuft on the red ground. The level has no grass data, so no grass draws anyway.
    triplanar: false, blocksGrass: false, blocksTrees: false, procedural: null, ...look };
};
set(0, "Red ground", "desert_pebbly", { uvScale: W / 3, normalStr: 0.7, aoStr: 0.4, tint: "#ffffff" });   // gravelly_sand regraded red-orange (CoH frame C)
set(1, "Red earth", "desert_hollow", { uvScale: W / 20, normalStr: 0.6, aoStr: 0.3, tint: "#ffffff" });
set(2, "Sand", "desert_sand", { uvScale: W / 16, normalStr: 0.2, aoStr: 0.15, tint: "#ffffff" });   // CoH's ripples are faint
set(3, "Grove earth", "dirt_aerial_02", { uvScale: W / 20, normalStr: 0.6, aoStr: 0.35, tint: "#a89070", blocksGrass: false });
set(4, "Grey rock", "rock_boulder_dry", { uvScale: W / 5, normalStr: 0.8, aoStr: 0.4, tint: "#d8cfc2", triplanar: true, blocksTrees: true });
set(5, "Sandstone", "cliff_side", { uvScale: W / 4, normalStr: 0.8, aoStr: 0.4, tint: "#ffffff", triplanar: true, blocksTrees: true });
set(6, "Road", "desert_road", { uvScale: W / 6.4, normalStr: 0.6, aoStr: 0.3, tint: "#ffffff", blocksTrees: true, blocksGrass: true });

const blobs = new Map([["heightmap", Buffer.from(hgt.buffer)], ["splat", splat], ["susukiDensity", tallPaint.out], ["foliagePaint", groundPaint.out]]);
const bytes = await writeProject(args.out, { manifest: man, blobs });
console.log(`${args.out}: ${(bytes / 1e6).toFixed(1)} MB — the ground to ${hi.toFixed(1)} m`);
console.log(`slabs: ${outcropSlabs} in ${ROCK.outcrops} outcrops, ${rocks.length - outcropSlabs} in shelves → ${ROCKS_FILE}`);
console.log(`plants (texels): tall ${JSON.stringify(tallPaint.counts)} · ground ${JSON.stringify(groundPaint.counts)}`);
// Walkable, IN THE BOX (the Aurès: 94% ≤ 34°, 57% ≤ 15°) — the slabs block more on top of this
const bx = Math.round(PLAY.x1 - PLAY.x0), box = new Float32Array(bx * bx);
for (let i = 0; i < bx; i++) for (let j = 0; j < bx; j++) box[i * bx + j] = H(PLAY.x0 + j, PLAY.z0 + i);
printRtsMetrics(measureRtsMap(box, bx, bx - 1), "the box");
