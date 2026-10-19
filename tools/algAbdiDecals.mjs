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
import { PLAY, LAYOUT } from "../games/alg-rts/maps/abdi.js";

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
const MATCH = { ruts: 1, tankTracks: 1, footPath: 1, apron: 1, sweptYard: 1, debris: 0.6, charred: 1 };
// (a charred mark matched on the UNBURNT earth it was baked on — the soil photo's own mean, linear — or its black
// core, dragging the art's mean down, lifted the halo into a pale ring)
const MEAN_OVERRIDE = { charred: [0.624, 0.397, 0.219] };
// …then each WEAR its own shift on that (matched alone, the paths and aprons vanished — the nam-rts lesson: "within
// a stop of the ground" at 100 m is absent): packed paths and tracks darker and warmer (no cracks, trodden),
// a swept yard lighter (fine dust)
const TINT = { ruts: "#c9b8a8", tankTracks: "#bba796", footPath: "#c4ad99", apron: "#e8ddd0", sweptYard: "#fff2e2", debris: "#ffffff", charred: "#ffffff" };
const SIZE = { ruts: [3.2, 10], tankTracks: [4.4, 10], footPath: [2.4, 10], apron: [12, 12], sweptYard: [12, 12], charred: [10, 10], debris: [16, 16] };
const decals = [];
const pick = (kind, x, z) => V[kind][Math.floor(hash(x, z, 5) * V[kind].length) % V[kind].length];
function box(kind, x, z, yaw, o) {
  const [sx, sz] = SIZE[kind], slot = pick(kind, x, z);
  decals.push({
    px: x, py: H(x, z), pz: z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2),
    slot, sx: sx * (o.k ?? 1), sy: 5, sz: sz * (o.k ?? 1), mean: MEAN_OVERRIDE[kind] ?? MEANS[slotKey[slot]], match: MATCH[kind],
    opacity: o.opacity, tint: TINT[kind], roughness: o.roughness ?? 0.92, normalStrength: o.normal ?? 1,
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
