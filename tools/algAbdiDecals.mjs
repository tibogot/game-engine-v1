/**
 * THE OUED ABDI'S GROUND MARKS (2026-10-19, you: "the decals — make them look like AAA Company of Heroes
 * decals"). Photographic decals (v3/render/decals/decalPhotoArt.js: a modelled relief — 5 cm ruts, berms,
 * tread, clods — over the map's OWN ground photos at their tile scale, so a mark has the earth's very grain)
 * laid BY RULE on alg-abdi.v3proj, the way the ground got worn:
 *
 *   ruts         along every piste (10 m segments, overlapping, each its own strength, a few left out,
 *                each shifted sideways — drivers don't hold the centreline)
 *   tank tracks  the armour's way out of the post, across the valley to the souk and the hamlet
 *   foot paths   between the places the villagers and the bands walk: oasis ↔ farm, hamlet ↔ sheepfold,
 *                the gully mouths down to the town, the camp to the cave, the dechra to its koubba
 *   aprons       packed earth at every place; a swept yard at the farms and the hamlet
 *   scorch +     where the war already passed: the gully's mouth, the town's edge, the lookout, the ford
 *   debris
 *
 *   node tools/algAbdiDecals.mjs --decals <bake.json>   (first) write the browser bake to public/textures/decals/abdi/
 *   node tools/algAbdiDecals.mjs                        lay them on the level (after tools/algAbdiLevel.mjs, which
 *                                                       rebuilds the level without its decals)
 * Decals are baked into the ground cache in the game: lit and shadowed with the terrain.
 */
import fs from "node:fs";
import path from "node:path";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { FOLIAGE_PRESETS } from "../v3/app/state/foliageScatterState.js";
import { PLAY, LAYOUT } from "../games/alg-rts/maps/abdi.js";
import { TOWN_HOUSES } from "../games/alg-rts/maps/abdiTown.js";

const FILE = "public/levels/alg-abdi.v3proj";
const DIR = "public/textures/decals/abdi";
const ENDFADE = 1.5;   // decalPhotoArt ENDFADE_M
const args = process.argv.slice(2);

if (args.includes("--decals")) {
  const raw = fs.readFileSync(args[args.indexOf("--decals") + 1], "utf8");
  const bake = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  fs.mkdirSync(DIR, { recursive: true });
  for (const [key, b] of Object.entries(bake)) {
    for (const [suffix, url] of [["", b.albedo], ["_n", b.normal]]) {
      const m = String(url).match(/^data:image\/(webp|png);base64,(.+)$/);
      if (!m) throw new Error(`${key}: not a webp/png data URL`);
      fs.writeFileSync(path.join(DIR, `${key}${suffix}.${m[1]}`), Buffer.from(m[2], "base64"));
    }
  }
  console.log(`wrote ${Object.keys(bake).length} decals to ${DIR}`);
  process.exit(0);
}

const project = await readProject(FILE);
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

// ── the art: one slot per baked variant ──
const files = fs.readdirSync(DIR).filter((f) => /\.(webp|png)$/.test(f));
// each art's mean colour (linear, measured in the browser): the ground cache maps it onto the ground's own tone
const MEANS = JSON.parse(fs.readFileSync(path.join(DIR, "means.json"), "utf8"));
const slots = [], V = {}, slotKey = [];
for (const f of files.filter((f) => !f.includes("_n.")).sort()) {
  const key = f.replace(/\.(webp|png)$/, ""), kind = key.replace(/_\d+$/, "");
  (V[kind] ??= []).push(slots.length);
  slotKey.push(key);
  slots.push({ name: `abdi ${key}`, albedoUrl: `/textures/decals/abdi/${f}`, normalUrl: `/textures/decals/abdi/${key}_n.webp` });
}
// MATCH to the ground's tone (groundCache): the wear takes the ground's colour; a scorch keeps its own black.
const MATCH = { ploughed: 0.65, stubble: 0.6,   // (ploughed 0: a near-black square on the pale valley — measured: its art 0.10/0.06/0.03, the soil 0.62/0.40/0.22)
   ruts: 1, tankTracks: 1, footPath: 1, apron: 1, sweptYard: 1, debris: 0.6, charred: 1, crater: 1, trampled: 1 };
// (a charred mark matched on the UNBURNT earth it was baked on — the soil photo's own mean, linear — or its black
// core, dragging the art's mean down, lifted the halo into a pale ring)
const SOIL = [0.624, 0.397, 0.219];
const MEAN_OVERRIDE = { ploughed: [0.102, 0.061, 0.028], stubble: SOIL, charred: SOIL, crater: SOIL, trampled: SOIL };   // (the crater's soot and the trampled prints too)
// …then each WEAR its own shift on that (matched alone, the paths and aprons vanished — the nam-rts lesson: "within
// a stop of the ground" at 100 m is absent): packed paths and tracks darker and warmer (no cracks, trodden),
// a swept yard lighter (fine dust)
const TINT = { ploughed: "#f2e6da", stubble: "#fff4dc", ruts: "#c9b8a8", tankTracks: "#bba796", footPath: "#c4ad99", apron: "#e8ddd0", sweptYard: "#fff2e2", debris: "#ffffff", charred: "#ffffff", crater: "#ffffff", trampled: "#e6d8c8" };   // (trampled: dust, barely darker — #d2c0ae read as a stain)
const SIZE = { ploughed: [20, 14], stubble: [20, 14], ruts: [3.2, 10], tankTracks: [4.4, 10], footPath: [2.4, 10], apron: [12, 12], sweptYard: [12, 12], charred: [10, 10], debris: [16, 16], crater: [7, 7], trampled: [14, 14] };
const decals = [];
const pick = (kind, x, z) => V[kind][Math.floor(hash(x, z, 5) * V[kind].length) % V[kind].length];
function box(kind, x, z, yaw, o) {
  const [sx, sz] = SIZE[kind], slot = pick(kind, x, z);
  decals.push({
    px: x, py: H(x, z), pz: z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2),
    slot, sx: o.sx ?? sx * (o.k ?? 1), sy: 5, sz: o.sz ?? sz * (o.k ?? 1), mean: MEAN_OVERRIDE[kind] ?? MEANS[slotKey[slot]], match: MATCH[kind],
    opacity: o.opacity, tint: o.tint ?? TINT[kind], roughness: o.roughness ?? 0.92, normalStrength: o.normal ?? 1,
    angleFade: 60, edgeFade: o.edgeFade ?? 0.16, priority: o.priority ?? 1,
  });
}
/** A strip of 10 m segments along a polyline (Catmull-Rom'd), each its own strength, a few left out. */
function strip(kind, pts, { opacity, skip = 0.15, wander = 0.6, priority = 1 }) {
  const fine = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2));
    for (let i = 0; i < n; i++) {
      const t = i / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      fine.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  fine.push(pts[pts.length - 1]);
  const s = [0];
  for (let i = 1; i < fine.length; i++) s.push(s[i - 1] + Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]));
  const at = (d) => { let i = 1; while (i < s.length - 1 && s[i] < d) i++; const u = (d - s[i - 1]) / Math.max(1e-6, s[i] - s[i - 1]); return [fine[i - 1][0] + (fine[i][0] - fine[i - 1][0]) * u, fine[i - 1][1] + (fine[i][1] - fine[i - 1][1]) * u]; };
  const L = SIZE[kind][1], step = L - ENDFADE, total = s[s.length - 1];
  let n = 0;
  for (let d = L / 2; d < total - L / 2 + step * 0.5; d += step) {
    const dc = Math.min(d, total - L / 2), a = at(Math.max(0, dc - L / 2)), b = at(Math.min(total, dc + L / 2));
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], mid = at(dc);
    if (Math.hypot(mid[0] - c[0], mid[1] - c[1]) > 0.6) continue;   // a bend tighter than a strip can follow
    if (slope(c[0], c[1]) > 18) continue;                              // not up a bank
    const r = hash(c[0], c[1], 1);
    if (r < skip) continue;
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]), side = (hash(c[0], c[1], 2) - 0.5) * 2 * wander;
    c[0] += Math.cos(yaw) * side; c[1] -= Math.sin(yaw) * side;
    box(kind, c[0], c[1], yaw, { opacity: opacity * (0.6 + 0.4 * r), priority });
    n++;
  }
  return n;
}
const site = (name) => LAYOUT.sites.find((s) => s.name.startsWith(name));
const S = Object.fromEntries(LAYOUT.sites.map((s) => [s.kind + ":" + s.name, s]));
const stats = {};
// RUTS on every piste
stats.ruts = LAYOUT.pistes.reduce((a, p) => a + strip("ruts", p, { opacity: 0.7, skip: 0.12, wander: 0.4 }), 0);
// (a trail WANDERS: every ~12 m a bend of ±3 m — 2026-10-19: straight 10 m strips read as a ruled pencil line)
const meander = (pts) => {
  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k], len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 12));
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    for (let i = 1; i <= n; i++) {
      const t = i / n, j = i < n ? (hash(ax + i, az - i, 9) - 0.5) * 6 : 0;
      out.push([ax + (bx - ax) * t + nx * j, az + (bz - az) * t + nz * j]);
    }
  }
  return out;
};
// TANK TRACKS: out of the post, over the middle ford to the souk; and east to the hamlet (off the piste, the
// armour cuts the corner)
const post = site("Poste"), souk = site("Abdi"), hamlet = site("Mechta"), farm = site("Ferme"), oasis = site("Aïn"), dechra = site("Dechra"), camp = site("Katiba"), cave = site("Grotte"), koubba = site("Sidi"), sheep = site("Bergerie"), pass = site("Débouché"), kef = site("Kef");
// (continuous and wandering: with gaps and straight runs they read as a dashed road marking — 2026-10-19)
stats.tank = strip("tankTracks", meander([[post.x - 10, post.z - 25], [80, 110], [45, 58], [25, 25]]), { opacity: 0.75, skip: 0, wander: 0.3, priority: 2 })
  + strip("tankTracks", meander([[post.x + 15, post.z - 25], [150, 110], [168, 60], [hamlet.x - 8, hamlet.z + 20]]), { opacity: 0.7, skip: 0, wander: 0.3, priority: 2 });
// FOOT PATHS between the places people walk
const paths = [
  [[oasis.x, oasis.z], [-120, 75], [farm.x, farm.z]],
  [[hamlet.x, hamlet.z], [195, -25], [sheep.x, sheep.z]],
  [[pass.x, pass.z], [60, -70], [souk.x + 10, souk.z - 30]],
  [[-110, 10], [-60, 0], [souk.x - 30, souk.z]],
  [[camp.x, camp.z], [-170, -185], [cave.x, cave.z]],
  [[dechra.x, dechra.z], [-215, -78], [koubba.x, koubba.z]],
  [[oasis.x, oasis.z], [-30, 60], [souk.x - 10, souk.z + 35]],
  [[kef.x, kef.z], [150, -140], [pass.x + 15, pass.z - 5]],
];
stats.paths = paths.reduce((a, p) => a + strip("footPath", meander(p), { opacity: 0.8, skip: 0.1, wander: 0.3 }), 0);
// APRONS and SWEPT YARDS at the places
stats.aprons = 0;
for (const s of LAYOUT.sites) {
  if (["koubba", "cave", "helipad", "motorPool"].includes(s.kind)) continue;
  const yard = ["farm", "hamlet", "oasis"].includes(s.kind);
  const n = Math.max(1, Math.round(s.r / 14));
  for (let k = 0; k < n; k++) {
    const a = hash(s.x, s.z, 10 + k) * Math.PI * 2, r = k ? s.r * 0.45 : 0;
    // (a wide edge fade: at 0.16 the 12 m box read as a square)
    box(yard ? "sweptYard" : "apron", s.x + Math.cos(a) * r, s.z + Math.sin(a) * r, hash(s.x, s.z, 20 + k) * 6.28, { opacity: 0.6, k: 0.9 + hash(s.x, s.z, 30 + k) * 0.5, priority: 0, edgeFade: 0.45 });
    stats.aprons++;
  }
}
// SCORCH and DEBRIS where the war passed
stats.scorch = 0;
for (const [x, z, n] of [[pass.x, pass.z, 3], [souk.x + 30, souk.z + 30, 2], [kef.x, kef.z, 2], [40, 58, 2], [-120, -20, 2], [100, -30, 1]]) {
  for (let k = 0; k < n; k++) {
    const a = hash(x, z, 40 + k) * 6.28, r = 6 + hash(x, z, 50 + k) * 18, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    if (slope(px, pz) > 20) continue;
    box("charred", px, pz, hash(px, pz, 3) * 6.28, { opacity: 1, k: 1.1 + hash(px, pz, 4) * 0.6, priority: 3 });   // (10-17 m: CoH's are big; 6-11 m read as a dot)
    box("debris", px + 1, pz - 1, hash(px, pz, 6) * 6.28, { opacity: 0.8, k: 0.5 + hash(px, pz, 7) * 0.4, priority: 2 });
    stats.scorch++;
  }
}
// CRATERS: shell holes in clusters where the fighting was (the mortars on the pass, the town's edge, the lookout,
// the middle ford) — CoH's ground reads as FOUGHT OVER by its craters more than by anything else
stats.craters = 0;
for (const [x, z, n] of [[pass.x, pass.z, 5], [souk.x + 30, souk.z + 30, 4], [kef.x, kef.z, 4], [40, 58, 3], [-120, -20, 3], [100, -30, 3], [souk.x - 35, souk.z - 20, 3]]) {
  for (let k = 0; k < n; k++) {
    const a = hash(x, z, 60 + k) * 6.28, r = 4 + hash(x, z, 70 + k) * 22, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
    if (slope(px, pz) > 22) continue;
    box("crater", px, pz, hash(px, pz, 8) * 6.28, { opacity: 1, k: 0.7 + hash(px, pz, 9) * 0.6, priority: 4 });
    stats.craters++;
  }
}
// TRAMPLED earth: boot-printed, scuffed ground at every capture point (where the squads stand to take it) and
// where the paths fray into the villages
stats.trampled = 0;
for (const s of LAYOUT.sites.filter((s) => s.point)) {
  const n = Math.max(1, Math.round(s.r / 16));
  for (let k = 0; k < n; k++) {
    const a = hash(s.x, s.z, 80 + k) * 6.28, r = k ? s.r * 0.5 : s.r * 0.15, px = s.x + Math.cos(a) * r, pz = s.z + Math.sin(a) * r;
    box("trampled", px, pz, hash(px, pz, 11) * 6.28, { opacity: 0.85, k: 0.8 + hash(px, pz, 12) * 0.4, priority: 1, edgeFade: 0.45 });
    stats.trampled++;
  }
}
for (const p of paths) for (const [x, z] of [p[0], p[p.length - 1]]) {
  box("trampled", x + (hash(x, z, 13) - 0.5) * 8, z + (hash(x, z, 14) - 0.5) * 8, hash(x, z, 15) * 6.28, { opacity: 0.7, k: 0.6 + hash(x, z, 16) * 0.3, priority: 1, edgeFade: 0.45 });
  stats.trampled++;
}
// THE FIELDS (2026-10-20 — PIECES_INVENTORY.md: "the fields look cheap in the old Aurès"): plots round the
// places that farm — the farm, the sheepfold, the hamlet, the oasis, the dechra — on gentle ground, their furrows
// along the contour (contour ploughing), off the pistes, the oued, the town and each other (4 m lanes). Their
// soil a decal each (decalPhotoArt: ploughed — the mule's furrows, the headlands — or stubble); the plots are
// written for the game (maps/abdiFields.js: their walls and crops next).
const lineD = (pts, x, z) => {
  let best = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
    best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return best;
};
const pisteDist = (x, z) => Math.min(...LAYOUT.pistes.map((q) => lineD(q, x, z)));
const OUED = LAYOUT.wadis[0];
const TOWN = LAYOUT.sites.find((q) => q.kind === "town"), KNOLL = { x: TOWN.knoll[0], z: TOWN.knoll[1] };
// the SAS post beside the first hamlet (showroom.js SAS_POST: 66, 25 in the hamlet's frame, its yaw the camera's
// three-quarter turn — layout.js VIEW_YAW / siteYaw): a plot ran under its wall
const SAS = (() => {
  const fr = LAYOUT.sites.find((q) => q.kind === "french"), al = LAYOUT.sites.find((q) => q.kind === "aln"), hm = LAYOUT.sites.find((q) => q.kind === "hamlet");
  const yaw = Math.atan2(al.x - fr.x, al.z - fr.z) + ((hm.turn ?? 30) * Math.PI) / 180, c = Math.cos(yaw), sn = Math.sin(yaw);
  return { x: hm.x + 66 * c + 25 * sn, z: hm.z - 66 * sn + 25 * c, r: 16 };
})();
const plots = [];
stats.fields = 0;
for (const [name, n] of [["Ferme", 6], ["Bergerie", 4], ["Mechta", 6], ["Aïn", 4], ["Dechra", 4]]) {
  const st = site(name);
  if (!st) continue;
  let made = 0;
  for (let t = 0; t < 400 && made < n; t++) {
    const a = hash(st.x + t, st.z, 61) * 6.283, r = st.r + 10 + hash(st.x, st.z + t, 62) * 55;
    const x = st.x + Math.cos(a) * r, z = st.z + Math.sin(a) * r;
    const w = 16 + hash(x, z, 63) * 10, d = 11 + hash(x, z, 64) * 6, rad = Math.hypot(w, d) / 2;
    if (Math.abs(x) > 240 || Math.abs(z) > 240 || slope(x, z) > 10) continue;
    if (pisteDist(x, z) < rad + 6 || lineD(OUED.points, x, z) < rad + OUED.width + 6 || Math.hypot(x - KNOLL.x, z - KNOLL.z) < 66 + rad) continue;
    if (LAYOUT.sites.some((q) => Math.hypot(x - q.x, z - q.z) < q.r + rad + 2) || Math.hypot(x - SAS.x, z - SAS.z) < SAS.r + rad) continue;
    if (TOWN_HOUSES.some((hh) => Math.hypot(x - hh[2], z - hh[4]) < rad + 8)) continue;
    if (plots.some((q) => Math.hypot(x - q.x, z - q.z) < rad + q.rad + 4)) continue;
    // the long side ALONG the contour (the furrows follow the slope's level, as a plough on a hillside)
    const gx = H(x + 2, z) - H(x - 2, z), gz = H(x, z + 2) - H(x, z - 2);
    const yaw = Math.hypot(gx, gz) > 1e-3 ? Math.atan2(-gz, gx) : hash(x, z, 65) * 6.283;
    const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => H(x + (u * w / 2) * Math.cos(yaw) + (v * d / 2) * Math.sin(yaw), z - (u * w / 2) * Math.sin(yaw) + (v * d / 2) * Math.cos(yaw)));
    if (Math.max(...cs) - Math.min(...cs) > 2.6) continue;
    // a third of the plots CROPPED (barley, ripe or green: the ground plants, below), the rest worked earth
    const rk = hash(x, z, 66), kind = rk < 0.35 ? "ploughed" : rk < 0.6 ? "stubble" : rk < 0.85 ? "barley" : "barleyGreen";
    plots.push({ x, z, yaw, w, d, rad, kind, of: st.name });
    // (the box's local z ALONG the contour — the furrows run along it, the recipe's length: w; d across;
    // a crop: the stubble rows tinted its colour, the ground between its stalks)
    box(kind === "ploughed" ? "ploughed" : "stubble", x, z, yaw, { opacity: 0.95, sx: d, sz: w, priority: 0, edgeFade: 0.2, tint: { barley: "#ffe9b0", barleyGreen: "#a9c47a" }[kind] });   // (0.08: a square tile)
    made++; stats.fields++;
  }
}
// THEIR WALLS (tools/blender/fieldwall.py, a 2.4 m dry-stone module x1.3): along most sides, a gap for the gate,
// a few breached or tumbled; the three variants mixed. [type a|b|c, state, x, y, z, yaw]
const MOD = 2.4 * 1.3, walls = [];
plots.forEach((q, pi) => {
  const c = Math.cos(q.yaw), sn = Math.sin(q.yaw), at = (lx, lz) => [q.x + lx * c + lz * sn, q.z - lx * sn + lz * c];
  const gateSide = Math.floor(hash(q.x, q.z, 70) * 4);
  // the four sides: along the contour (local z) at x = +-d/2, across it (local x) at z = +-w/2
  const sides = [[-1, "z"], [1, "z"], [-1, "x"], [1, "x"]];
  sides.forEach(([sd, along], si) => {
    if (hash(q.x + si, q.z, 71) > 0.72) return;                       // not every side walled
    const len = along === "z" ? q.w : q.d, off = (along === "z" ? q.d : q.w) / 2 + 0.6;
    const n = Math.max(1, Math.round(len / MOD)), step = len / n;
    const gate = si === gateSide ? Math.floor(hash(q.x, q.z + si, 72) * n) : -1;
    for (let k = 0; k < n; k++) {
      if (k === gate) continue;                                        // the gate
      const t = -len / 2 + step * (k + 0.5);
      const [x, z] = along === "z" ? at(sd * off, t) : at(t, sd * off);
      const yaw = along === "z" ? q.yaw + Math.PI / 2 : q.yaw;         // (the module runs along its local X)
      const r = hash(x, z, 73);
      walls.push([["a", "b", "c"][Math.floor(hash(x, z, 74) * 3)], r < 0.05 ? "ruin" : r < 0.13 ? "damaged" : "intact", x, H(x, z) - 0.05, z, yaw]);
    }
  });
});
stats.fieldWalls = walls.length;
// THE PRICKLY-PEAR HEDGES (3.9 m modules — algGame lays the procedural prickly pear along each): outside most of the plots' UNWALLED
// sides, and in runs along the pistes near the farmed places (the Maghreb's hedge of figuiers de Barbarie), with
// gaps; a few crushed or dried. Concealment beside them (the game), no cover (a cactus stops no bullet).
// [type a|b|c, state, x, y, z, yaw]
const HMOD = 3.0 * 1.3, hedges = [];
const hedgeFree = (x, z) => {
  if (Math.abs(x) > 245 || Math.abs(z) > 245 || slope(x, z) > 18) return false;
  if (lineD(OUED.points, x, z) < OUED.width + 4 || Math.hypot(x - KNOLL.x, z - KNOLL.z) < 70 || Math.hypot(x - SAS.x, z - SAS.z) < SAS.r + 4) return false;
  if (LAYOUT.sites.some((q) => Math.hypot(x - q.x, z - q.z) < q.r + 3)) return false;
  if (TOWN_HOUSES.some((hh) => Math.hypot(x - hh[2], z - hh[4]) < 8)) return false;
  if (plots.some((q) => {
    const c = Math.cos(q.yaw), sn = Math.sin(q.yaw), dx = x - q.x, dz = z - q.z;
    return Math.abs(dx * c - dz * sn) < q.d / 2 + 0.5 && Math.abs(dx * sn + dz * c) < q.w / 2 + 0.5;
  })) return false;
  return !walls.some((w) => Math.hypot(x - w[2], z - w[4]) < 1.6) && !hedges.some((h) => Math.hypot(x - h[2], z - h[4]) < HMOD * 0.8);
};
const hedgeAt = (x, z, yaw) => {
  if (!hedgeFree(x, z)) return;
  const r = hash(x, z, 83);
  hedges.push([["a", "b", "c"][Math.floor(hash(x, z, 84) * 3)], r < 0.05 ? "ruin" : r < 0.13 ? "damaged" : "intact", x, H(x, z) - 0.08, z, yaw + (hash(x, z, 85) - 0.5) * 0.1]);
};
plots.forEach((q) => {
  const c = Math.cos(q.yaw), sn = Math.sin(q.yaw), at = (lx, lz) => [q.x + lx * c + lz * sn, q.z - lx * sn + lz * c];
  [[-1, "z"], [1, "z"], [-1, "x"], [1, "x"]].forEach(([sd, along], si) => {
    if (hash(q.x + si, q.z, 71) <= 0.72 || hash(q.x, q.z + si, 80) > 0.6) return;   // (walled, or left open)
    const len = along === "z" ? q.w : q.d, off = (along === "z" ? q.d : q.w) / 2 + 1.4;
    const n = Math.max(1, Math.round(len / HMOD)), step = len / n;
    for (let k = 0; k < n; k++) {
      if (hash(q.x + k, q.z + si, 81) < 0.12) continue;                // a gap
      const t = -len / 2 + step * (k + 0.5);
      const [x, z] = along === "z" ? at(sd * off, t) : at(t, sd * off);
      hedgeAt(x, z, along === "z" ? q.yaw + Math.PI / 2 : q.yaw);
    }
  });
});
// along the pistes within 90 m of a farmed place: one side, 7 m off the centre line, in runs of 3-7 with gaps
const farmed = [farm, sheep, hamlet, oasis, dechra].filter(Boolean);
LAYOUT.pistes.forEach((p, pi) => {
  for (let k = 0; k < p.length - 1; k++) {
    const [ax, az] = p[k], [bx, bz] = p[k + 1], L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
    const yaw = Math.atan2(-uz, ux);                                     // (the module's local X along the piste)
    for (let s = 0; s < L; s += HMOD) {
      const cx = ax + ux * s, cz = az + uz * s;
      if (!farmed.some((q) => Math.hypot(cx - q.x, cz - q.z) < q.r + 90)) continue;
      const run = Math.floor(s / (HMOD * 5) + pi * 7 + k * 3);
      if (hash(run, pi, 86) < 0.45) continue;                          // runs and gaps
      const side = hash(run, k, 87) < 0.5 ? -1 : 1;
      hedgeAt(cx - uz * 7 * side, cz + ux * 7 * side, yaw);
    }
  }
});
stats.hedges = hedges.length;
// THE CROPS AND THE CLEARING, in the level's plant paint (2026-10-20): the ground-foliage slots 2 and 6 (the old
// Aurès' reed-mace and thistle — painted nowhere on this map) become RIPE and GREEN BARLEY; inside every plot
// all the other plants are wiped (worked land: no alfa, no scrub, no tree) and a cropped plot is painted full of
// its barley. (Concealment comes with it: the crop's density — algCover reads the ground paint.)
{
  const slot = (name, preset) => ({ name, preset, castShadow: true, ...structuredClone(FOLIAGE_PRESETS[preset]), heightMin: -200, heightMax: 900, onLayer: -2, nearRiver: 0 });   // (-2: sown — even, no clumps)
  man.foliagePlants[2] = slot("Barley", "barley");
  man.foliagePlants[6] = slot("Green barley", "barleyGreen");
  const inPlot = (x, z, pad) => plots.find((q) => {
    const c = Math.cos(q.yaw), sn = Math.sin(q.yaw), dx = x - q.x, dz = z - q.z;
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    return Math.abs(lx) < q.d / 2 + pad && Math.abs(lz) < q.w / 2 + pad;
  });
  const paint = (key, res, pages, chans, crop) => {
    const b = project.blobs.get(key);
    if (!b) return 0;
    let n = 0;
    for (let pz = 0; pz < res; pz++) for (let px = 0; px < res; px++) {
      const x = ((px + 0.5) / res) * W - W / 2, z = ((pz + 0.5) / res) * W - W / 2;
      const q = inPlot(x, z, 0.8);
      if (!q) continue;
      for (let ch = 0; ch < chans; ch++) b[((ch / 4) | 0) * res * res * 4 + (pz * res + px) * 4 + (ch % 4)] = 0;
      if (crop && q.kind.startsWith("barley") && inPlot(x, z, -0.6)) {
        const ch = q.kind === "barley" ? 2 : 6;
        b[((ch / 4) | 0) * res * res * 4 + (pz * res + px) * 4 + (ch % 4)] = 235;
      }
      n++;
    }
    return n;
  };
  stats.cropTexels = paint("foliagePaint", 1024, 2, 8, true);
  paint("susukiDensity", 512, 1, 4, false);
}
const r2 = (v) => Math.round(v * 100) / 100;
fs.writeFileSync("games/alg-rts/maps/abdiFields.js", `// GENERATED by tools/algAbdiDecals.mjs — do not edit: the Oued Abdi's FIELD PLOTS (${plots.length}), their soil laid
// as decals — { x, z, yaw, w, d, kind, of }: the plot's centre, its yaw (three.js rotation.y; local z ALONG the contour), its width along
// and depth across the slope (m), "ploughed" | "stubble" | "barley" | "barleyGreen", the place that works it. Their walls and crops: next.
export const FIELD_PLOTS = [
${plots.map((q) => `  { x: ${r2(q.x)}, z: ${r2(q.z)}, yaw: ${r2(q.yaw)}, w: ${r2(q.w)}, d: ${r2(q.d)}, kind: "${q.kind}", of: ${JSON.stringify(q.of)} },`).join("\n")}
];
// their DRY-STONE WALLS (tools/blender/fieldwall.py): [type, state, x, y, z, yaw]
export const FIELD_WALLS = [
${walls.map((w) => `  ["${w[0]}", "${w[1]}", ${r2(w[2])}, ${r2(w[3])}, ${r2(w[4])}, ${r2(w[5])}],`).join("\n")}
];
// the PRICKLY-PEAR HEDGES (3.9 m modules, algGame lays procedural prickly pears along each): [type, state, x, y, z, yaw]
export const FIELD_HEDGES = [
${hedges.map((w) => `  ["${w[0]}", "${w[1]}", ${r2(w[2])}, ${r2(w[3])}, ${r2(w[4])}, ${r2(w[5])}],`).join("\n")}
];
`);
// THE LOOKS tuned in the game (Dev → Decals, algDecalPanel.js → kinds.json): per kind, over what the rules laid
const LOOKS = JSON.parse(fs.readFileSync(path.join(DIR, "kinds.json"), "utf8"));
const slotKind = (i) => slotKey[i].replace(/_\d+$/, "");
for (const d of decals) {
  const lk = LOOKS[slotKind(d.slot)];
  if (!lk) continue;
  const t = [1, 3, 5].map((i) => parseInt(d.tint.slice(i, i + 2), 16) / 255), w = lk.warmth ?? 0, k = lk.darkness ?? 1;
  const c = [t[0] * k * (1 + 0.25 * w), t[1] * k * (1 + 0.04 * w), t[2] * k * (1 - 0.3 * w)];
  d.tint = "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
  d.opacity = Math.min(1, d.opacity * (lk.strength ?? 1));
  d.sx *= lk.size ?? 1; d.sz *= lk.size ?? 1;
  d.normalStrength *= lk.relief ?? 1;
  if (lk.match != null) d.match = lk.match;
  if (lk.edge != null) d.edgeFade = lk.edge;
}
man.decals = { ...(man.decals ?? {}), slots, decals };
const bytes = await writeProject(FILE, { manifest: man, blobs: project.blobs });
console.log(`${FILE}: ${(bytes / 1e6).toFixed(1)} MB — ${slots.length} slots, ${decals.length} decals ${JSON.stringify(stats)}`);
void PLAY;
