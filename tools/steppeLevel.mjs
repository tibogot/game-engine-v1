/**
 * STEPPE LEVEL — the steppe rider's first world (user, 2026-10-21: "add the far mountain so it
 * breaks the horizon and use the terrain just as parkour and different things to see how horse and
 * robot behave on real terrain … river, texturing, grass later … keep the default grid for now").
 *
 * A 1 km map on the editor's default GRID ground (no paint, no grass, no props), shaped as a TEST
 * COURSE round the spawn — each piece a known shape, so the horse and the rider can be measured on it:
 *   - SLOPE RAMPS: six straight ramps, 5° 10° 15° 20° 25° 30°, up to a plateau and down the far side
 *   - a CROSS SLOPE: a long hillside at 12° to ride ALONG (the horse rolled, not pitched)
 *   - ROLLING HILLS (±3 m, ~30 m apart) and a MOGUL field (±0.35 m, ~4 m apart: the hoof IK)
 *   - a wide DITCH (2 m deep, gentle), a narrow one (1 m, steep), a RIDGE (a sharp crest), a BOWL
 *   - the BIG HILL: 35 m high, ~300 m across — a gallop up and down
 *   - gentle swells out to the edge, then the FAR MOUNTAINS (the engine's far terrain, as
 *     Thunderline's valley and the rock lab) breaking the horizon from ~2 km out
 * The world is ordinary level data: open it in the editor and reshape it —
 *   /v3/editor.html?project=/levels/steppe.v3proj
 *
 *   node tools/steppeLevel.mjs [--from public/levels/rock-lab.v3proj] [--out public/levels/steppe.v3proj]
 *
 * Also writes games/steppe-rider/spots.js (the spawn + a teleport to each piece).
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const FROM = args.from ?? "public/levels/rock-lab.v3proj";
const OUT = args.out ?? "public/levels/steppe.v3proj";
const SPOTS = "games/steppe-rider/spots.js";

// ── Size: 1 km, 1 m height cells ──────────────────────────────────────────
const W = 1024, N = 1024, TOP = 120, S = 512;
const HALF = W / 2, CELL = W / (N - 1);
const BASE = 10;                                 // the plain's height (m): the ditches and the bowl go below it

// ── Noise (Math.imul hashing: value noise without it repeats in bands) ─────
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
/** ≈ −1..1 */
const fbm = (x, y, s = 1) => (vnoise(x, y, s) * 0.55 + vnoise(x * 2.03, y * 2.03, s + 1) * 0.3 + vnoise(x * 4.1, y * 4.1, s + 2) * 0.15) * 2 - 1;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RAD = Math.PI / 180;

// a rectangle's mask (local frame: u along, v across), soft over `edge` m
const box = (u, v, u0, u1, hw, edge) => smooth(u0 - edge, u0, u) * (1 - smooth(u1, u1 + edge, u)) * (1 - smooth(hw, hw + edge, Math.abs(v)));

// ── The pieces (world x east, z south; the spawn at the middle, facing north = −z) ─
const SPAWN = { x: 0, z: 40, yaw: Math.PI };     // (yaw atan2(x, z): π = facing −z)
const PIECES = [];
const piece = (p) => (PIECES.push(p), p);

// SLOPE RAMPS: six lanes side by side, north of the spawn; each climbs at its grade to a 6 m
// plateau (12 m long), then down at the same grade. Lanes 14 m wide, 6 m apart.
const RAMP = { z0: -40, rise: 6, top: 12, lane: 14, gap: 6, grades: [5, 10, 15, 20, 25, 30] };
const rampX0 = -((RAMP.grades.length - 1) * (RAMP.lane + RAMP.gap)) / 2;
RAMP.grades.forEach((g, i) => piece({ kind: "ramp", label: `Ramp ${g}°`, grade: g, x: rampX0 + i * (RAMP.lane + RAMP.gap), z: RAMP.z0 }));
function rampH(x, z) {
  let h = 0;
  for (const p of PIECES) {
    if (p.kind !== "ramp") continue;
    const run = RAMP.rise / Math.tan(p.grade * RAD), u = p.z - z, v = x - p.x;   // u: metres north of the lane's foot
    if (Math.abs(v) > RAMP.lane / 2 + 1.5 || u < -1 || u > 2 * run + RAMP.top + 1) continue;
    const up = clamp(u / run, 0, 1), down = clamp((2 * run + RAMP.top - u) / run, 0, 1);
    const side = 1 - smooth(RAMP.lane / 2, RAMP.lane / 2 + 1.5, Math.abs(v));      // its sides fall away over 1.5 m
    h = Math.max(h, RAMP.rise * Math.min(up, down) * side);
  }
  return h;
}

// the CROSS SLOPE: east of the spawn, a hillside 160 m long (north–south) rising WEST→EAST at 12°
const CROSS = piece({ kind: "cross", label: "Cross slope 12° (ride along it)", x: 150, z: 0, len: 160, width: 50, grade: 12 });
function crossH(x, z) {
  const u = z - CROSS.z, v = x - (CROSS.x - CROSS.width / 2);
  if (Math.abs(u) > CROSS.len / 2 + 20 || v < -5 || v > CROSS.width + 25) return 0;
  const rise = Math.tan(CROSS.grade * RAD) * clamp(v, 0, CROSS.width);
  const ends = 1 - smooth(CROSS.len / 2, CROSS.len / 2 + 20, Math.abs(u));
  const back = 1 - smooth(CROSS.width, CROSS.width + 25, v);                      // over the top it eases down
  return rise * ends * (v > CROSS.width ? back : 1);
}

// ROLLING HILLS: west of the spawn
const ROLL = piece({ kind: "rolling", label: "Rolling hills", x: -170, z: 0, r: 90 });
const rollH = (x, z) => { const m = 1 - smooth(ROLL.r - 25, ROLL.r, Math.hypot(x - ROLL.x, z - ROLL.z)); return m ? m * 3 * fbm(x / 30, z / 30, 21) : 0; };

// MOGULS: south-west, a field of small bumps
const MOG = piece({ kind: "moguls", label: "Moguls (±35 cm)", x: -110, z: 130, r: 40 });
const mogH = (x, z) => { const m = 1 - smooth(MOG.r - 8, MOG.r, Math.hypot(x - MOG.x, z - MOG.z)); return m ? m * 0.35 * Math.sin(x * 1.57 + Math.sin(z * 0.9)) * Math.sin(z * 1.49 + Math.sin(x * 0.7)) : 0; };

// DITCHES: south of the spawn, east–west, 60 m long — a wide gentle one and a narrow steep one
const DITCH_W = piece({ kind: "ditch", label: "Ditch, wide (2 m deep)", x: 0, z: 120, len: 60, depth: 2, half: 5 });
const DITCH_N = piece({ kind: "ditch", label: "Ditch, narrow (1 m, steep)", x: 0, z: 160, len: 60, depth: 1, half: 1.6 });
function ditchH(x, z) {
  let h = 0;
  for (const d of [DITCH_W, DITCH_N]) {
    const u = Math.abs(x - d.x), v = Math.abs(z - d.z);
    if (u > d.len / 2 + 6 || v > d.half + 1) continue;
    const ends = 1 - smooth(d.len / 2, d.len / 2 + 6, u);
    const prof = Math.cos(Math.min(1, v / d.half) * Math.PI / 2) ** (d.half < 2 ? 0.5 : 2);   // narrow: steep walls
    h = Math.min(h, -d.depth * prof * ends);
  }
  return h;
}

// a RIDGE: south-east, a sharp crest 4 m high, 80 m long (north–south), ~8 m across at its foot
const RIDGE = piece({ kind: "ridge", label: "Ridge (a sharp crest)", x: 110, z: 150, len: 80, height: 4, half: 8 });
const ridgeH = (x, z) => { const u = Math.abs(z - RIDGE.z), v = Math.abs(x - RIDGE.x); if (u > RIDGE.len / 2 + 10 || v > RIDGE.half) return 0; return RIDGE.height * (1 - v / RIDGE.half) ** 1.6 * (1 - smooth(RIDGE.len / 2, RIDGE.len / 2 + 10, u)); };

// a BOWL: north-west, 44 m across, 7 m deep
const BOWL = piece({ kind: "bowl", label: "Bowl (7 m deep)", x: -150, z: -150, r: 22, depth: 7 });
const bowlH = (x, z) => { const r = Math.hypot(x - BOWL.x, z - BOWL.z); return r > BOWL.r ? 0 : -BOWL.depth * (1 - smooth(0, BOWL.r, r)); };

// the BIG HILL: far north, 35 m high, ~300 m across — a gallop up and down
const HILL = piece({ kind: "hill", label: "The big hill (35 m)", x: 60, z: -300, r: 160, height: 35 });
const hillH = (x, z) => { const r = Math.hypot((x - HILL.x) * 1.15, z - HILL.z); return r > HILL.r ? 0 : HILL.height * (0.5 + 0.5 * Math.cos(Math.PI * r / HILL.r)) * (1 + 0.08 * fbm(x / 60, z / 60, 31)); };

// the plain: gentle swells (±1.5 m, ~120 m), calm round the course
const COURSE_R = 230;
const plainH = (x, z) => { const calm = smooth(COURSE_R - 40, COURSE_R + 60, Math.hypot(x, z * 0.8)); return (0.35 + 0.65 * calm) * 1.5 * fbm(x / 120, z / 120, 11) + calm * 2.5 * fbm(x / 260, z / 260, 12); };

const heightAt = (x, z) => BASE + plainH(x, z) + rampH(x, z) + crossH(x, z) + rollH(x, z) + mogH(x, z) + ditchH(x, z) + ridgeH(x, z) + bowlH(x, z) + hillH(x, z);

// ── The heightmap (row 0 = north, −z) ─────────────────────────────────────
const H = new Float32Array(N * N);
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < N; i++) {
  const z = -HALF + i * CELL;
  for (let j = 0; j < N; j++) {
    const x = -HALF + j * CELL, h = heightAt(x, z);
    H[i * N + j] = h; lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
}
console.log(`heights ${lo.toFixed(1)}–${hi.toFixed(1)} m (top ${TOP})`);
if (lo < 0 || hi > TOP) throw new Error("heights out of 0..TOP");

// ── Manifest: the template's look (Sky Pro), none of its content ──────────
const tpl = await readProject(FROM);
const man = tpl.manifest;
man.terrain = { worldSize: W, heightmapSize: N, splatSize: S, maxHeight: TOP };
man.splatRes = S;
man.trees = { ...man.trees, instances: [] };
man.decals = { ...man.decals, decals: [] };
man.lakes = { ...man.lakes, lakes: [] };
man.roads = { nodes: [], edges: [], nextNodeId: 1, selectedNodeId: null };
man.splines = Object.fromEntries(Object.keys(man.splines ?? {}).map((k) => [k, []]));
for (const k of ["waterfalls", "riversV2", "riverNetwork", "tunnels", "spawn"]) man[k] = null;
if (man.environment?.worldOcean) man.environment.worldOcean = { ...man.environment.worldOcean, enabled: false };
man.props = { types: [], instances: [], slots: [] };
// no paint, no grass: the editor's default GRID ground (texturing and grass come later)
delete man.paintLayers;
if (man.grass) man.grass = { ...man.grass, system: man.grass.system };

// ── FAR MOUNTAINS (the engine's far terrain past the map's edge) ─────────
// Rolling foothills near the map, ridged ranges rising from ~1.5 km and peaking 2.5–4 km out:
// a far range reads as FAR at 4–8° over the horizon (Thunderline's lesson: closer and taller
// it stood like a wall). The grid's own colour out there too (no paint slots).
const FAR = { n: 512, extent: 4000 };
const farH = new Float32Array(FAR.n * FAR.n);
{
  const fcell = (2 * FAR.extent) / (FAR.n - 1);
  const ridge = (x, z, s) => { const r = 1 - Math.abs(fbm(x, z, s)); return r * r; };
  for (let i = 0; i < FAR.n; i++) {
    const z = -FAR.extent + i * fcell;
    for (let j = 0; j < FAR.n; j++) {
      const x = -FAR.extent + j * fcell;
      const out = Math.hypot(Math.max(Math.abs(x) - HALF, 0), Math.max(Math.abs(z) - HALF, 0));
      const ang = Math.atan2(z, x), foot = 1300 + 350 * fbm(Math.cos(ang) * 1.7 + 4, Math.sin(ang) * 1.7 - 2, 61);
      const rise = smooth(foot, foot + 1600, out);
      const wx = x + 280 * fbm(x / 1400, z / 1400, 62), wz = z + 280 * fbm(x / 1400, z / 1400, 63);
      const massif = 0.5 + 0.5 * (0.5 + 0.5 * fbm(x / 3000 + 5, z / 3000 - 3, 64));
      const h = BASE + 6 * fbm(x / 300, z / 300, 65) * smooth(0, 600, out)
        + rise * massif * (120 + 520 * ridge(wx / 900, wz / 900, 66) + 140 * ridge(wx / 300, wz / 300, 67));
      farH[i * FAR.n + j] = h;
    }
  }
}
const NO_PAINT = { flatSlot: -1, highSlot: -1, screeSlot: -1, cliffSlot: -1 };
man.farTerrain = { enabled: true, n: FAR.n, extent: FAR.extent, stand: 1, standStart: 0, standEnd: 1, blend: 200, rule: NO_PAINT };

const norm = H.map((v) => Math.max(0, Math.min(1, v / TOP)));
const blobs = new Map([
  ["heightmap", Buffer.from(norm.buffer)],
  ["farHeight", Buffer.from(farH.buffer)],
]);
const bytes = await writeProject(OUT, { manifest: man, blobs });
console.log(`wrote ${OUT}: ${(bytes / 1e6).toFixed(2)} MB`);

// ── Spots for the game page: the spawn + a teleport in front of each piece ─
const r1 = (v) => Math.round(v * 10) / 10;
const before = (p) => {
  switch (p.kind) {
    case "ramp": return { x: p.x, z: p.z + 25, yaw: Math.PI };                       // facing north up the ramp
    case "cross": return { x: p.x - 8, z: p.z + p.len / 2 - 5, yaw: Math.PI };       // on it at its south end, along it
    case "ditch": return { x: p.x, z: p.z - 15, yaw: 0 };                           // north of it, facing south across
    case "ridge": return { x: p.x - 20, z: p.z, yaw: Math.PI / 2 };                  // facing east, over the crest
    case "hill": return { x: p.x, z: p.z + p.r * 0.85, yaw: Math.PI };                // at its foot, facing up
    default: { const a = Math.atan2(p.x, p.z); return { x: p.x + Math.sin(a) * (p.r + 12), z: p.z + Math.cos(a) * (p.r + 12), yaw: a + Math.PI }; }
  }
};
const spots = { spawn: SPAWN, pieces: PIECES.map((p) => ({ label: p.label, ...Object.fromEntries(Object.entries(before(p)).map(([k, v]) => [k, r1(v)])) })) };
fs.mkdirSync("games/steppe-rider", { recursive: true });
fs.writeFileSync(SPOTS, `// Written by tools/steppeLevel.mjs — do not edit by hand.\nexport const SPOTS = ${JSON.stringify(spots, null, 1)};\n`);
console.log(`wrote ${SPOTS}: ${PIECES.length} pieces`);
