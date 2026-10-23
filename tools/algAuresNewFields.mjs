/**
 * THE NEW AURÈS' FIELDS (2026-10-22, you: "why does your new Aurès still use old assets, I see the old field — we
 * made new ones way better"). The Oued Abdi's fields (tools/algAbdiDecals.mjs) on the Aurès ground, in place of
 * the old procedural gardens, terraces and threshing floors (maps/auresNew.js MAP.skip):
 *
 *   soil     a photographic decal per plot (decalPhotoArt: ploughed or stubble — the Abdi's baked art,
 *            public/textures/decals/abdi/), the long side along the contour, on gentle ground round the villages
 *   walls    the Blender dry-stone walls (tools/blender/fieldwall.py) along most sides, a gate gap, a few breached
 *   hedges   prickly pear outside most of the unwalled sides and along the pistes near the villages
 *   crops    a third of the plots in BARLEY (the level's plant paint; the other plants wiped inside every plot)
 *
 * The level is the old Aurès' COPIED (public/levels/alg-aures.v3proj → alg-aures-new.v3proj): the old map keeps its
 * own, untouched. Its 162 decals are kept; the plots' are added.
 *
 *   node tools/algAuresNewFields.mjs        → public/levels/alg-aures-new.v3proj + games/alg-rts/maps/auresNewFields.js
 */
import fs from "node:fs";
import path from "node:path";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { FOLIAGE_PRESETS } from "../v3/app/state/foliageScatterState.js";
import { LAYOUT, MAP as OLD_MAP, PLAY } from "../games/alg-rts/maps/aures.js";
import { MAP as NEW_MAP } from "../games/alg-rts/maps/auresNew.js";

const SRC = "public/levels/alg-aures.v3proj", OUT = "public/levels/alg-aures-new.v3proj";
const DIR = "public/textures/decals/abdi";
const project = await readProject(SRC);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, ((x + W / 2) / W) * (N - 1))), fv = Math.max(0, Math.min(N - 1.001, ((z + W / 2) / W) * (N - 1)));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hm[y0 * N + x0], b = hm[y0 * N + x0 + 1], c = hm[(y0 + 1) * N + x0], d = hm[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const slope = (x, z) => Math.atan(Math.hypot(H(x + 1, z) - H(x - 1, z), H(x, z + 1) - H(x, z - 1)) / 2) * 180 / Math.PI;
const hash = (x, z, s = 0) => { let h = Math.imul(Math.round(x * 10) + s * 977, 73856093) ^ Math.imul(Math.round(z * 10), 19349663); h = Math.imul(h ^ (h >>> 13), 1274126177); return (h >>> 0) / 4294967296; };
const lineD = (pts, x, z) => {
  let best = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
    best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return best;
};

// ── the art: the Abdi's baked marks (tools/algAbdiDecals.mjs), appended to the level's own decal slots ──
const MEANS = JSON.parse(fs.readFileSync(path.join(DIR, "means.json"), "utf8"));
const LOOKS = JSON.parse(fs.readFileSync(path.join(DIR, "kinds.json"), "utf8"));
const KINDS = ["ploughed", "stubble", "trampled", "sweptYard", "apron", "crater", "charred", "debris", "tankTracks"];
const slots = [...(man.decals?.slots ?? [])], decals = [...(man.decals?.decals ?? [])], V = {};
for (const f of fs.readdirSync(DIR).filter((f) => KINDS.includes(f.replace(/_\d+\.webp$/, "")) && /_\d+\.webp$/.test(f)).sort()) {
  const key = f.replace(/\.webp$/, ""), kind = key.replace(/_\d+$/, "");
  (V[kind] ??= []).push({ slot: slots.length, key });
  slots.push({ name: `abdi ${key}`, albedoUrl: `/textures/decals/abdi/${f}`, normalUrl: `/textures/decals/abdi/${key}_n.webp` });
}
// (the Abdi's: matched to the ground's tone; ploughed's own near-black mean, the scorch and craters on the unburnt
// soil's — tools/algAbdiDecals.mjs MATCH / MEAN_OVERRIDE / TINT / SIZE)
const SOIL = [0.624, 0.397, 0.219];
const MEAN = { ploughed: [0.102, 0.061, 0.028], stubble: SOIL, charred: SOIL, crater: SOIL, trampled: SOIL };
const MATCH = { ploughed: 0.65, stubble: 0.6, trampled: 1, sweptYard: 1, apron: 1, crater: 1, charred: 1, debris: 0.6, tankTracks: 1 };
const TINT = { ploughed: "#f2e6da", stubble: "#fff4dc", trampled: "#e6d8c8", sweptYard: "#fff2e2", apron: "#e8ddd0", crater: "#ffffff", charred: "#ffffff", debris: "#ffffff", tankTracks: "#bba796" };
const SIZE = { trampled: [14, 14], sweptYard: [12, 12], apron: [12, 12], crater: [7, 7], charred: [10, 10], debris: [16, 16], tankTracks: [4.4, 10] };
/** One mark: `sx` across, `sz` along its yaw (m; default its kind's size × k), the panel's look (kinds.json) over it. */
function mark(kind, x, z, yaw, o = {}) {
  const v = V[kind][Math.floor(hash(x, z, 5) * V[kind].length) % V[kind].length], lk = LOOKS[kind] ?? {};
  const t = [1, 3, 5].map((i) => parseInt((o.tint ?? TINT[kind]).slice(i, i + 2), 16) / 255), wm = lk.warmth ?? 0, k = lk.darkness ?? 1;
  const c = [t[0] * k * (1 + 0.25 * wm), t[1] * k * (1 + 0.04 * wm), t[2] * k * (1 - 0.3 * wm)];
  const [w0, l0] = SIZE[kind] ?? [10, 10];
  decals.push({
    px: x, py: H(x, z), pz: z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2),
    slot: v.slot, sx: (o.sx ?? w0 * (o.k ?? 1)) * (lk.size ?? 1), sy: 5, sz: (o.sz ?? l0 * (o.k ?? 1)) * (lk.size ?? 1), mean: MEAN[kind] ?? MEANS[v.key], match: lk.match ?? MATCH[kind],
    opacity: Math.min(1, (o.opacity ?? 0.95) * (lk.strength ?? 1)), tint: "#" + c.map((q) => Math.round(Math.max(0, Math.min(1, q)) * 255).toString(16).padStart(2, "0")).join(""),
    roughness: 0.92, normalStrength: lk.relief ?? 1, angleFade: 60, edgeFade: lk.edge ?? o.edge ?? 0.2, priority: o.priority ?? 0,
  });
}
const soil = (kind, x, z, yaw, w, d, tint) => mark(kind, x, z, yaw, { sx: d, sz: w, tint });

// ── what the fields keep clear of ──
const TRACKS = OLD_MAP.tracks.map((t) => t.points);
const trackDist = (x, z) => Math.min(...TRACKS.map((p) => lineD(p, x, z)));
const wadiClear = (x, z, pad) => LAYOUT.wadis.every((w) => lineD(w.points, x, z) > w.width + pad);
// the map's pieces that stay (measured in the game 2026-10-22: the showroom's bounding circles — the post, its
// helipad and motor pool, the SAS post, the koubba, cemetery, wells, zeribas, the FLN's places, the ruins, the
// farms and huts; the old gardens, terraces and threshing floors are gone: MAP.skip)
const PIECES = [[92, 214, 41], [75, 269, 25], [78, 163, 24], [160, 130, 23], [-273, 86, 16], [-256, 70, 21], [-188, 155, 6], [132, 97, 5],
  [237, -62, 5], [203, 96, 16], [229, -33, 14], [-201, -167, 40], [-256, -152, 16], [-137, -193, 7], [-245, -125, 6], [-248, -109, 7],
  [-250, -95, 2], [66, -254, 6], [-101, -35, 6], [-233, -53, 8], [144, -90, 7], [187, -224, 9], [-100, -141, 4], [252, 294, 4], [37, -79, 3],
  [-81, 263, 23], [-281, 262, 17], [-3, 132, 15], [230, 151, 22], [161, -73, 21], [-253, -30, 23], [190, 256, 22], [250, 233, 7], [-40, 210, 7],
  [216, 195, 8], [-132, 220, 7], [33, 103, 8], [-85, 172, 7], [-14, 290, 18], [-14, 39, 19], [-47, 94, 14], [-218, 295, 12], [257, 92, 17],
  [37, 40, 14], [-180, 245, 12]];
const HOUSES = NEW_MAP.town.houses.map((r) => [r[6], r[7], Math.hypot(r[8], r[9])]);
const SUPPLY = (OLD_MAP.supply ?? []).filter((s) => Number.isFinite(s?.x)).map((s) => [s.x, s.z, 10]);
const clear = (x, z, rad, pad) => !LAYOUT.sites.some((q) => Math.hypot(x - q.x, z - q.z) < q.r + rad + pad)
  && ![...PIECES, ...HOUSES, ...SUPPLY].some(([px, pz, r]) => Math.hypot(x - px, z - pz) < r + rad + pad);
// …nor in an oasis's grove: the palms and the tamarisk ring round them (algVillageLife inGrove — a plot's walls ran
// through the Aïn Tighanimine palms, seen)
const OASES = LAYOUT.sites.filter((s) => s.kind === "oasis");
const inGrove = (x, z, pad) => OASES.some((o) => Math.hypot(x - o.x, z - o.z) < (o.r ?? 20) * 2.2 + 12 + pad);
const inBox = (x, z, m) => x > PLAY.x0 + m && x < PLAY.x1 - m && z > PLAY.z0 + m && z < PLAY.z1 - m;

// ── THE PLOTS, round the villages that farm ──
const plots = [], stats = {};
const site = (name) => LAYOUT.sites.find((s) => s.name === name);
// [site, plots, the farthest out (m past its ring)]
for (const [name, n, out] of [["Mechta Ouled Ali", 9, 85], ["Mechta el Oued", 8, 85], ["Dechra Tighanimine", 6, 90], ["Ksar el Hamra", 6, 95]]) {
  const st = site(name);
  let made = 0;
  for (let t = 0; t < 1500 && made < n; t++) {
    const a = hash(st.x + t, st.z, 61) * 6.283, r = st.r + 8 + hash(st.x, st.z + t, 62) * out;
    const x = st.x + Math.cos(a) * r, z = st.z + Math.sin(a) * r;
    const w = 16 + hash(x, z, 63) * 10, d = 11 + hash(x, z, 64) * 6, rad = Math.hypot(w, d) / 2;
    if (!inBox(x, z, rad) || slope(x, z) > 11 || inGrove(x, z, rad)) continue;
    if (trackDist(x, z) < rad + 5 || !wadiClear(x, z, rad + 5)) continue;
    if (!clear(x, z, rad, 2)) continue;
    if (plots.some((q) => Math.hypot(x - q.x, z - q.z) < rad + q.rad + 4)) continue;
    // the long side ALONG the contour
    const gx = H(x + 2, z) - H(x - 2, z), gz = H(x, z + 2) - H(x, z - 2);
    const yaw = Math.hypot(gx, gz) > 1e-3 ? Math.atan2(-gz, gx) : hash(x, z, 65) * 6.283;
    const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => H(x + (u * w / 2) * Math.cos(yaw) + (v * d / 2) * Math.sin(yaw), z - (u * w / 2) * Math.sin(yaw) + (v * d / 2) * Math.cos(yaw)));
    if (Math.max(...cs) - Math.min(...cs) > 2.8) continue;
    // (one crop slot here — the level's paint holds 8 plants and the Aurès uses 7: ripe barley only)
    const rk = hash(x, z, 66), kind = rk < 0.38 ? "ploughed" : rk < 0.66 ? "stubble" : "barley";
    plots.push({ x, z, yaw, w, d, rad, kind, of: st.name });
    soil(kind === "ploughed" ? "ploughed" : "stubble", x, z, yaw, w, d, kind === "barley" ? "#ffe9b0" : null);
    made++;
  }
  stats[name] = made;
}

// ── THEIR WALLS (the Abdi's rules) ──
const MOD = 2.4 * 1.3, walls = [];
plots.forEach((q) => {
  const c = Math.cos(q.yaw), sn = Math.sin(q.yaw), at = (lx, lz) => [q.x + lx * c + lz * sn, q.z - lx * sn + lz * c];
  const gateSide = Math.floor(hash(q.x, q.z, 70) * 4);
  [[-1, "z"], [1, "z"], [-1, "x"], [1, "x"]].forEach(([sd, along], si) => {
    if (hash(q.x + si, q.z, 71) > 0.72) return;
    const len = along === "z" ? q.w : q.d, off = (along === "z" ? q.d : q.w) / 2 + 0.6;
    const n = Math.max(1, Math.round(len / MOD)), step = len / n;
    const gate = si === gateSide ? Math.floor(hash(q.x, q.z + si, 72) * n) : -1;
    for (let k = 0; k < n; k++) {
      if (k === gate) continue;
      const tt = -len / 2 + step * (k + 0.5);
      const [x, z] = along === "z" ? at(sd * off, tt) : at(tt, sd * off);
      const r = hash(x, z, 73);
      walls.push([["a", "b", "c"][Math.floor(hash(x, z, 74) * 3)], r < 0.05 ? "ruin" : r < 0.13 ? "damaged" : "intact", x, H(x, z) - 0.05, z, along === "z" ? q.yaw + Math.PI / 2 : q.yaw]);
    }
  });
});

// ── THE PRICKLY-PEAR HEDGES ──
const HMOD = 3.0 * 1.3, hedges = [];
const inPlot = (x, z, pad) => plots.find((q) => {
  const c = Math.cos(q.yaw), sn = Math.sin(q.yaw), dx = x - q.x, dz = z - q.z;
  return Math.abs(dx * c - dz * sn) < q.d / 2 + pad && Math.abs(dx * sn + dz * c) < q.w / 2 + pad;
});
const hedgeAt = (x, z, yaw) => {
  if (!inBox(x, z, 4) || slope(x, z) > 18 || inGrove(x, z, 2) || !wadiClear(x, z, 4) || !clear(x, z, 0, 3) || trackDist(x, z) < 4.5 || inPlot(x, z, 0.5)) return;
  if (walls.some((w) => Math.hypot(x - w[2], z - w[4]) < 1.6) || hedges.some((h) => Math.hypot(x - h[2], z - h[4]) < HMOD * 0.8)) return;
  const r = hash(x, z, 83);
  hedges.push([["a", "b", "c"][Math.floor(hash(x, z, 84) * 3)], r < 0.05 ? "ruin" : r < 0.13 ? "damaged" : "intact", x, H(x, z) - 0.08, z, yaw + (hash(x, z, 85) - 0.5) * 0.1]);
};
plots.forEach((q) => {
  const c = Math.cos(q.yaw), sn = Math.sin(q.yaw), at = (lx, lz) => [q.x + lx * c + lz * sn, q.z - lx * sn + lz * c];
  [[-1, "z"], [1, "z"], [-1, "x"], [1, "x"]].forEach(([sd, along], si) => {
    if (hash(q.x + si, q.z, 71) <= 0.72 || hash(q.x, q.z + si, 80) > 0.6) return;
    const len = along === "z" ? q.w : q.d, off = (along === "z" ? q.d : q.w) / 2 + 1.4;
    const n = Math.max(1, Math.round(len / HMOD)), step = len / n;
    for (let k = 0; k < n; k++) {
      if (hash(q.x + k, q.z + si, 81) < 0.12) continue;
      const tt = -len / 2 + step * (k + 0.5);
      const [x, z] = along === "z" ? at(sd * off, tt) : at(tt, sd * off);
      hedgeAt(x, z, along === "z" ? q.yaw + Math.PI / 2 : q.yaw);
    }
  });
});
const farmed = ["Mechta Ouled Ali", "Mechta el Oued", "Dechra Tighanimine", "Ksar el Hamra"].map(site);
TRACKS.forEach((p, pi) => {
  for (let k = 0; k < p.length - 1; k++) {
    const [ax, az] = p[k], [bx, bz] = p[k + 1], L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, yaw = Math.atan2(-uz, ux);
    for (let s = 0; s < L; s += HMOD) {
      const cx = ax + ux * s, cz = az + uz * s;
      if (!farmed.some((q) => Math.hypot(cx - q.x, cz - q.z) < q.r + 80)) continue;
      const run = Math.floor(s / (HMOD * 5) + pi * 7 + k * 3);
      if (hash(run, pi, 86) < 0.45) continue;
      const side = hash(run, k, 87) < 0.5 ? -1 : 1;
      hedgeAt(cx - uz * 7 * side, cz + ux * 7 * side, yaw);
    }
  }
});
stats.walls = walls.length; stats.hedges = hedges.length;

// ── THE CROPS AND THE CLEARING (the plant paint): the reed-mace slot (2: 878 texels on the whole map) becomes ripe
// barley; inside every plot the other plants are wiped, a barley plot painted full ──
{
  man.foliagePlants[2] = { name: "Barley", preset: "barley", castShadow: true, ...structuredClone(FOLIAGE_PRESETS.barley), heightMin: -200, heightMax: 900, onLayer: -2, nearRiver: 0 };
  const paint = (key, res, chans, crop) => {
    const b = project.blobs.get(key);
    if (!b) return 0;
    let n = 0;
    for (let pz = 0; pz < res; pz++) for (let px = 0; px < res; px++) {
      const x = ((px + 0.5) / res) * W - W / 2, z = ((pz + 0.5) / res) * W - W / 2;
      if (chans === 8) b[(pz * res + px) * 4 + 2] = 0;   // (the old reed-mace, everywhere)
      const q = inPlot(x, z, 0.8);
      if (!q) continue;
      for (let ch = 0; ch < chans; ch++) b[((ch / 4) | 0) * res * res * 4 + (pz * res + px) * 4 + (ch % 4)] = 0;
      if (crop && q.kind === "barley" && inPlot(x, z, -0.6)) b[(pz * res + px) * 4 + 2] = 235;
      n++;
    }
    return n;
  };
  stats.cropTexels = paint("foliagePaint", 1024, 8, true);
  paint("susukiDensity", 512, 4, false);
}

// ── THE GROUND MARKS (2026-10-23, the Oued Abdi's kinds — you: "anything to make the terrain even better") ──
// Kept off the plots, the houses' footprints and the water; each mark its own size and turn.
const HOUSE_BOX = NEW_MAP.town.houses.map((r) => ({ x: r[6], z: r[7], yaw: r[5], hx: r[8], hz: r[9] }));
const inHouse = (x, z, pad) => HOUSE_BOX.some((b) => {
  const c = Math.cos(b.yaw), sn = Math.sin(b.yaw), dx = x - b.x, dz = z - b.z;
  return Math.abs(dx * c - dz * sn) < b.hx + pad && Math.abs(dx * sn + dz * c) < b.hz + pad;
});
const free = (x, z, pad = 2) => !inPlot(x, z, pad) && !inHouse(x, z, pad) && wadiClear(x, z, 1) && inBox(x, z, 0) && !inGrove(x, z, 0);
stats.marks = {};
const count = (k) => { stats.marks[k] = (stats.marks[k] ?? 0) + 1; };
const villages = ["Mechta Ouled Ali", "Mechta el Oued", "Dechra Tighanimine", "Ksar el Hamra"].map(site);
// the village SQUARES: packed earth where the yard splat was (it repeated) — a swept yard at the mechtas, an apron at
// the dechra and the ksar, a few overlapping round the square, wide soft edges (a 12 m box reads as a square)
for (const v of villages) {
  const yard = v.kind === "hamlet", n = 3;
  for (let k = 0; k < n; k++) {
    const a = hash(v.x, v.z, 10 + k) * 6.283, r = k ? 9 : 0, x = v.x + Math.cos(a) * r, z = v.z + Math.sin(a) * r;
    if (!free(x, z, -3)) continue;
    mark(yard ? "sweptYard" : "apron", x, z, hash(x, z, 20) * 6.28, { opacity: 0.6, k: 1.1 + hash(x, z, 30) * 0.5, edge: 0.45 }); count("yards");
  }
}
// TRAMPLED earth where the squads stand to take a place: the four villages and the supply points
for (const [x0, z0, r] of [...villages.map((v) => [v.x, v.z, 14]), ...SUPPLY.map(([x, z]) => [x, z, 5])]) {
  for (let k = 0; k < 2; k++) {
    const a = hash(x0, z0, 80 + k) * 6.283, d = k ? r * 0.6 : r * 0.1, x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d;
    if (!free(x, z, 0)) continue;
    mark("trampled", x, z, hash(x, z, 11) * 6.28, { opacity: 0.85, k: 0.8 + hash(x, z, 12) * 0.4, priority: 1, edge: 0.45 }); count("trampled");
  }
}
// SHELL CRATERS, scorch and debris where the fighting is: the two gully mouths, the ksar's edge toward the valley,
// the fords, the road below Mechta Ouled Ali (CoH's ground reads as fought over by its craters above all)
const KS = site("Ksar el Hamra"), KS_EDGE = { x: KS.x + 10, z: KS.z + 62 }, OA_ROAD = { x: 178, z: 102 };
const ford = (w, f) => { const P = w.points, i = Math.min(P.length - 2, Math.floor(f * (P.length - 1))), u = f * (P.length - 1) - i; return [P[i][0] + (P[i + 1][0] - P[i][0]) * u, P[i][1] + (P[i + 1][1] - P[i][1]) * u]; };
const FIGHTS = [
  ...LAYOUT.sites.filter((s) => s.kind === "pass" && inBox(s.x, s.z, 10)).map((s) => [s.x, s.z, 5, 3]),
  [KS_EDGE.x, KS_EDGE.z, 4, 2],
  ...LAYOUT.wadis.flatMap((w) => (w.fords ?? []).slice(0, 2).map((f) => [...ford(w, f), 3, 1])),
  [OA_ROAD.x, OA_ROAD.z, 3, 1],
];
for (const [x0, z0, nCrater, nScorch] of FIGHTS) {
  for (let k = 0; k < nCrater; k++) {
    const a = hash(x0, z0, 60 + k) * 6.283, d = 4 + hash(x0, z0, 70 + k) * 20, x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d;
    if (slope(x, z) > 22 || !free(x, z, 3)) continue;
    mark("crater", x, z, hash(x, z, 8) * 6.28, { opacity: 1, k: 0.7 + hash(x, z, 9) * 0.6, priority: 4 }); count("craters");
  }
  for (let k = 0; k < nScorch; k++) {
    const a = hash(x0, z0, 40 + k) * 6.283, d = 6 + hash(x0, z0, 50 + k) * 16, x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d;
    if (slope(x, z) > 20 || !free(x, z, 3)) continue;
    mark("charred", x, z, hash(x, z, 3) * 6.28, { opacity: 1, k: 1.1 + hash(x, z, 4) * 0.6, priority: 3 }); count("scorch");
    mark("debris", x + 1, z - 1, hash(x, z, 6) * 6.28, { opacity: 0.8, k: 0.5 + hash(x, z, 7) * 0.4, priority: 2 }); count("debris");
  }
}
// TANK TRACKS: the armour's own way out of the post west and up the valley toward the ksar, off the piste (the way
// to Ouled Ali crossed the Aïn Tighanimine oasis — seen) — a relaxed curve (the ruts' lesson: no straight strips
// meeting at an angle), 10 m pieces overlapping, continuous
{
  const post = LAYOUT.sites.find((s) => s.kind === "french");
  let P = [[post.x - 22, post.z - 20], [40, 150], [20, 95], [12, 40]];
  const R = []; for (let k = 0; k < P.length - 1; k++) for (let i = 0; i < 10; i++) R.push([P[k][0] + (P[k + 1][0] - P[k][0]) * i / 10, P[k][1] + (P[k + 1][1] - P[k][1]) * i / 10]);
  R.push(P[P.length - 1]); P = R;
  for (let it = 0; it < 30; it++) P = P.map((q, k) => (k === 0 || k === P.length - 1 ? q : [q[0] * 0.5 + (P[k - 1][0] + P[k + 1][0]) * 0.25, q[1] * 0.5 + (P[k - 1][1] + P[k + 1][1]) * 0.25]));
  const S = [0]; for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const at = (d) => { let i = 1; while (i < S.length - 1 && S[i] < d) i++; const u = (d - S[i - 1]) / Math.max(1e-6, S[i] - S[i - 1]); return [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * u, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * u]; };
  for (let d = 5; d < S[S.length - 1] - 5; d += 6) {
    const a = at(d - 5), b = at(d + 5), c = at(d);
    if (!free(c[0], c[1], 0) || slope(c[0], c[1]) > 18) continue;
    mark("tankTracks", c[0], c[1], Math.atan2(b[0] - a[0], b[1] - a[1]), { opacity: 0.75, priority: 2 }); count("tankTracks");
  }
}

man.decals = { ...(man.decals ?? {}), slots, decals };
const bytes = await writeProject(OUT, { manifest: man, blobs: project.blobs });
const r2 = (v) => Math.round(v * 100) / 100;
fs.writeFileSync("games/alg-rts/maps/auresNewFields.js", `// GENERATED by tools/algAuresNewFields.mjs — do not edit: the new Aurès' FIELD PLOTS (${plots.length}) — their soil
// decals and barley in public/levels/alg-aures-new.v3proj — { x, z, yaw, w, d, kind, of } (as maps/abdiFields.js)
export const FIELD_PLOTS = [
${plots.map((q) => `  { x: ${r2(q.x)}, z: ${r2(q.z)}, yaw: ${r2(q.yaw)}, w: ${r2(q.w)}, d: ${r2(q.d)}, kind: "${q.kind}", of: ${JSON.stringify(q.of)} },`).join("\n")}
];
// their DRY-STONE WALLS (tools/blender/fieldwall.py): [type, state, x, y, z, yaw]
export const FIELD_WALLS = [
${walls.map((w) => `  ["${w[0]}", "${w[1]}", ${r2(w[2])}, ${r2(w[3])}, ${r2(w[4])}, ${r2(w[5])}],`).join("\n")}
];
// the PRICKLY-PEAR HEDGES (3.9 m modules): [type, state, x, y, z, yaw]
export const FIELD_HEDGES = [
${hedges.map((w) => `  ["${w[0]}", "${w[1]}", ${r2(w[2])}, ${r2(w[3])}, ${r2(w[4])}, ${r2(w[5])}],`).join("\n")}
];
`);
console.log(`${OUT}: ${(bytes / 1e6).toFixed(1)} MB — ${slots.length} slots, ${decals.length} decals ${JSON.stringify(stats)}`);
