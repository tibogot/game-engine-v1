/**
 * THE OASIS LOOK — what makes a spring in a dry valley read as an OASIS:
 * the contrast. Dark damp earth at the water, lush green under the palms,
 * then a sharp edge to the pale desert (you, 2026-09-29: "the water is nice
 * but the texture around doesn't read oasis with this brown-green texture").
 *
 *   node tools/algOasisLook.mjs [--file public/levels/alg-aures.v3proj] [--dry]
 *
 * For every lake in the map (the oases, tools/algOasis.mjs / algOasisMove.mjs):
 *   GROVE FLOOR  paint slot 3 becomes forrest_ground_01 (green grass, leaf and
 *                frond litter — a watered palm garden's floor, not the
 *                brown-olive lawn grass_ground was), out to ~2.4 pool radii
 *                from the WATER (not the centre: the grove follows the shore),
 *                a noisy edge fading over 6 m — sharp, as irrigation stops.
 *                Wadi beds and tracks keep their paint.
 *   DAMP RING    wet-mud decals (decalPhotoArt "mud" baked on the valley
 *                soil's own photo, public/textures/decals/alg/mud_*) all along
 *                the waterline: the dark band of soaked earth.
 *   GRASS        real blades (the engine's grass field, painted grassDensity
 *                .r) under the palms, none in the damp ring or the water;
 *                olive-green, dry-tipped, shin high — the only grass on the map.
 * Idempotent: clears its own paint, decals and grass round each lake first.
 * Then run tools/algVegetation.mjs (the palms and reeds key on the lakes).
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";

const args = process.argv.slice(2);
const FILE = args.includes("--file") ? args[args.indexOf("--file") + 1] : "public/levels/alg-aures.v3proj";
const dry = args.includes("--dry");
const SLOT = 3;
const DECAL_DIR = "public/textures/decals/alg";

const project = await readProject(FILE);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const cell = W / (N - 1);
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, (x + W / 2) / cell)), fv = Math.max(0, Math.min(N - 1.001, (z + W / 2) / cell));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hm[y0 * N + x0], b = hm[y0 * N + x0 + 1], c = hm[(y0 + 1) * N + x0], d = hm[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const hash = (x, y, s = 5) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
const vnoise = (x, y, s = 5) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};

// ── The layer ───────────────────────────────────────────────────────────────
const tex = (id) => {
  const f = (m) => ({ name: `${id}_${m}_1k.jpg`, url: `/textures/ground/${id}/${id}_${m}_1k.jpg` });
  return { albedo: f("diff"), normal: f("nor_gl"), rough: f("rough"), ao: f("ao") };
};
man.paintLayers[SLOT] = {
  name: "Oasis grove", ...tex("forrest_ground_01"),
  uvScale: 140, normalStr: 1, aoStr: 0.9, roughStr: 1, triplanar: false, tint: "#f2f5e6",
  uvRotation: 0, contourAlign: 0, rockShade: 0, procedural: null, blocksGrass: false, blocksTrees: false,
  auto: { enabled: false, heightMin: 0, heightMax: 500, slopeMin: 0, slopeMax: 90, blend: 15, strength: 1 },
};

const RES = man.splatRes, splat = project.blobs.get("splat"), off = RES * RES * 4;
const ch = (q, c) => (c < 4 ? q + c : off + q + c - 4);
const GRES = 512, grass = project.blobs.get("grassDensity");
const lakes = man.lakes?.lakes ?? [];

// Decal slots: our own, rebuilt (others kept).
const D = man.decals ?? { slots: [], decals: [] };
const keepSlots = D.slots.map((s, i) => [s, i]).filter(([s]) => !s.name.startsWith("alg oasis "));
const remap = new Map(keepSlots.map(([, i], k) => [i, k]));
const slots = keepSlots.map(([s]) => s);
const decals = D.decals.filter((d) => remap.has(d.slot)).map((d) => ({ ...d, slot: remap.get(d.slot) }));
const mudFiles = (fs.existsSync(DECAL_DIR) ? fs.readdirSync(DECAL_DIR) : []).filter((f) => /^mud_\d+\.webp$/.test(f)).sort();
const mudSlots = mudFiles.map((f) => {
  const key = f.replace(".webp", "");
  slots.push({ name: `alg oasis ${key}`, albedoUrl: `/textures/decals/alg/${f}`, normalUrl: `/textures/decals/alg/${key}_n.webp` });
  return slots.length - 1;
});

const report = [];
for (const l of lakes) {
  // Pool: the ground under the level inside the lake's rectangle.
  const R0 = Math.max(l.sizeX, l.sizeZ) * 2.2;                    // working radius, metres
  const x0 = l.cx - R0, z0 = l.cz - R0, span = 2 * R0, n = Math.ceil(span);   // 1 m grid
  const wet = new Uint8Array(n * n);
  let wetN = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = x0 + j + 0.5, z = z0 + i + 0.5;
    if (Math.abs(x - l.cx) <= l.sizeX / 2 && Math.abs(z - l.cz) <= l.sizeZ / 2 && H(x, z) < l.level) { wet[i * n + j] = 1; wetN++; }
  }
  const poolR = Math.sqrt(wetN / Math.PI);
  // Distance to the water, metres (two-pass chamfer).
  const dist = new Float32Array(n * n).fill(1e9);
  for (let k = 0; k < n * n; k++) if (wet[k]) dist[k] = 0;
  const pass = (fwd) => {
    const s = fwd ? 1 : -1;
    for (let i = fwd ? 0 : n - 1; fwd ? i < n : i >= 0; i += s) for (let j = fwd ? 0 : n - 1; fwd ? j < n : j >= 0; j += s) {
      const k = i * n + j;
      for (const [di, dj, c] of [[-s, 0, 1], [0, -s, 1], [-s, -s, 1.414], [-s, s, 1.414]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const v = dist[ii * n + jj] + c;
        if (v < dist[k]) dist[k] = v;
      }
    }
  };
  pass(true); pass(false);
  const dAt = (x, z) => {
    const j = Math.floor(x - x0), i = Math.floor(z - z0);
    return i < 0 || j < 0 || i >= n || j >= n ? 1e9 : dist[i * n + j];
  };
  const GROVE = poolR * 1.4 + 10;      // metres of grove round the water

  // GROVE FLOOR: clear our slot round this lake, then paint it by distance to water.
  let painted = 0;
  const pz0 = Math.max(0, Math.floor(((z0 + W / 2) / W) * RES)), pz1 = Math.min(RES - 1, Math.ceil(((z0 + span + W / 2) / W) * RES));
  const px0 = Math.max(0, Math.floor(((x0 + W / 2) / W) * RES)), px1 = Math.min(RES - 1, Math.ceil(((x0 + span + W / 2) / W) * RES));
  for (let pz = pz0; pz <= pz1; pz++) for (let px = px0; px <= px1; px++) {
    const q = (pz * RES + px) * 4;
    if (splat[ch(q, SLOT)]) { splat[q] = Math.min(255, splat[q] + splat[ch(q, SLOT)]); splat[ch(q, SLOT)] = 0; }
    const x = ((px + 0.5) / RES) * W - W / 2, z = ((pz + 0.5) / RES) * W - W / 2;
    if (splat[ch(q, 4)] > 100 || splat[ch(q, 6)] > 100) continue;   // wadi bed, track
    const d = dAt(x, z);
    const edge = GROVE * (0.8 + 0.4 * vnoise(x / 11, z / 11, 17));
    const w = 1 - smooth((d - (edge - 6)) / 6);
    if (w <= 0.004) continue;
    const keep = 1 - w;
    for (let c = 0; c < 7; c++) if (c !== SLOT) splat[ch(q, c)] = Math.round(splat[ch(q, c)] * keep);
    splat[ch(q, SLOT)] = Math.min(255, Math.round(w * 255));
    painted++;
  }

  // GRASS: under the palms, not in the damp ring (first ~3 m) nor the water.
  let blades = 0;
  const g0 = Math.max(0, Math.floor(((x0 + W / 2) / W) * GRES)), g1 = Math.min(GRES - 1, Math.ceil(((x0 + span + W / 2) / W) * GRES));
  const h0 = Math.max(0, Math.floor(((z0 + W / 2) / W) * GRES)), h1 = Math.min(GRES - 1, Math.ceil(((z0 + span + W / 2) / W) * GRES));
  for (let gz = h0; gz <= h1; gz++) for (let gx = g0; gx <= g1; gx++) {
    const x = ((gx + 0.5) / GRES) * W - W / 2, z = ((gz + 0.5) / GRES) * W - W / 2;
    const k = (gz * GRES + gx) * 4, d = dAt(x, z);
    const edge = GROVE * (0.8 + 0.4 * vnoise(x / 11, z / 11, 17));
    const q = (Math.floor(((z + W / 2) / W) * RES) * RES + Math.floor(((x + W / 2) / W) * RES)) * 4;
    const bare = splat[ch(q, 4)] > 100 || splat[ch(q, 6)] > 100;
    const v = bare ? 0 : smooth((d - 2.5) / 3) * (1 - smooth((d - (edge - 10)) / 8)) * (0.55 + 0.45 * vnoise(x / 6, z / 6, 23));
    grass[k] = Math.round(Math.max(0, Math.min(1, v)) * 255);
    if (grass[k]) blades++;
  }

  // DAMP RING: mud decals along the waterline, every ~5 m, a metre and a half out.
  let laid = 0;
  if (mudSlots.length) {
    const edgePts = [];
    for (let i = 1; i < n - 1; i++) for (let j = 1; j < n - 1; j++) {
      const k = i * n + j;
      if (!wet[k] && (wet[k - 1] || wet[k + 1] || wet[k - n] || wet[k + n])) edgePts.push([x0 + j + 0.5, z0 + i + 0.5]);
    }
    const chosen = [];
    for (const p of edgePts) if (!chosen.some((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) < 5)) chosen.push(p);
    for (const [ex, ez] of chosen) {
      // Out from the water: away from the pool's centre, a metre and a half.
      const ax = ex - l.cx, az = ez - l.cz, L = Math.hypot(ax, az) || 1;
      const x = ex + (ax / L) * 1.5, z = ez + (az / L) * 1.5, yaw = hash(Math.round(x * 10), Math.round(z * 10), 31) * Math.PI * 2;
      decals.push({
        px: x, py: H(x, z), pz: z, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2),
        slot: mudSlots[Math.floor(hash(Math.round(x), Math.round(z), 37) * mudSlots.length) % mudSlots.length],
        sx: 8, sy: 5, sz: 8, opacity: 0.9, tint: "#ffffff", roughness: 0.55, normalStrength: 1,
        angleFade: 55, edgeFade: 0.2, priority: 2,
      });
      laid++;
    }
  }
  report.push(`lake (${l.cx.toFixed(0)}, ${l.cz.toFixed(0)}): pool r ${poolR.toFixed(1)} m, grove ${GROVE.toFixed(0)} m round the water; ${painted} splat texels, ${blades} grass texels, ${laid} mud decals`);
}
man.decals = { ...D, slots, decals };

// The grass LOOK is nam-rts's (tools/algGrassFromNam.mjs); this paints only where.

for (const r of report) console.log(r);
console.log(`slot ${SLOT} "Oasis grove" = forrest_ground_01; ${mudSlots.length} mud slots; decals in map ${decals.length}`);
if (!dry) { await writeProject(FILE, project); console.log(`wrote ${FILE}`); }
