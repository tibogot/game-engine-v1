/**
 * PAINT AN ALGERIA MAP — four ground layers baked from slope and height.
 *
 * The editor's auto-paint knows three layers (flat / cliff / high). Dry
 * mountain ground reads as FOUR: soil on the flats, loose scree on the
 * slopes, bare strata where it is too steep to walk (the nav limit, so the
 * texture tells the player where units cannot go), and pale limestone on the
 * highest ridges. This writes the layer slots and the splatmap straight into
 * the .v3proj.
 *
 *   node tools/algPaint.mjs --file public/levels/alg-aures.v3proj
 *
 * Textures are Poly Haven (CC0), 1k, kept under public/textures/ground/ and
 * referenced by path like nam-valley's, not embedded in the project.
 * The high band is set from the HEIGHT HISTOGRAM (percentiles), because the
 * same metres mean different things on every map.
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { NAV_MAX_SLOPE_DEG } from "./lib/rtsMapMetrics.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const FILE = args.file ?? "public/levels/alg-aures.v3proj";
const SEED = +(args.seed ?? 3);

const tex = (id) => {
  const f = (m) => ({ name: `${id}_${m}_1k.jpg`, url: `/textures/ground/${id}/${id}_${m}_1k.jpg` });
  return { albedo: f("diff"), normal: f("nor_gl"), rough: f("rough"), ao: f("ao") };
};
const layer = (name, id, extra = {}) => ({
  name, ...tex(id),
  uvScale: 128, normalStr: 1, aoStr: 0.8, roughStr: 1, triplanar: false, tint: "#ffffff",
  uvRotation: 0, contourAlign: 0, rockShade: 0, procedural: null,
  blocksGrass: false, blocksTrees: false,
  auto: { enabled: false, heightMin: 0, heightMax: 500, slopeMin: 0, slopeMax: 90, blend: 15, strength: 1 },
  ...extra,
});

// Slot → layer. Slots 3, 4, 6 are left as they are and get no weight.
const SOIL = 0, RIDGE = 1, SCREE = 2, CLIFF = 5;
const LAYERS = {
  [SOIL]:  layer("Valley soil", "brown_mud_dry"),
  [RIDGE]: layer("Limestone ridge", "rock_boulder_cracked", { uvScale: 110 }),
  [SCREE]: layer("Scree slope", "gravelly_sand"),
  // Triplanar: a cliff face projected from above smears into streaks.
  [CLIFF]: layer("Cliff strata", "cliff_side", { uvScale: 64, triplanar: true, blocksTrees: true }),
};

const project = await readProject(FILE);
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = project.manifest.terrain;
const RES = project.manifest.splatRes;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));

for (const [slot, l] of Object.entries(LAYERS)) project.manifest.paintLayers[slot] = l;
// nam-valley's blend: height-aware transitions and a macro variation, so the
// layers meet along the rocks' own relief instead of in a smooth fade.
project.manifest.paintBlend = { heightBlend: 0.55, contrast: 0.5, macroStrength: 0.35, macroWarmth: 0.22, macroScale: 80 };

// High band from the histogram of LAND (the faded border would drag it down).
const land = [];
for (const v of hm) if (v * TOP > 2) land.push(v * TOP);
land.sort((a, b) => a - b);
const pct = (p) => land[Math.min(land.length - 1, Math.floor(p * land.length))];
const HIGH0 = pct(0.8), HIGH1 = pct(0.95);

const sample = (u, v) => {
  const fu = Math.max(0, Math.min(0.9999, u)) * (N - 1), fv = Math.max(0, Math.min(0.9999, v)) * (N - 1);
  const x0 = fu | 0, y0 = fv | 0, x1 = Math.min(x0 + 1, N - 1), y1 = Math.min(y0 + 1, N - 1), tx = fu - x0, ty = fv - y0;
  return (hm[y0 * N + x0] * (1 - tx) * (1 - ty) + hm[y0 * N + x1] * tx * (1 - ty) + hm[y1 * N + x0] * (1 - tx) * ty + hm[y1 * N + x1] * tx * ty) * TOP;
};
const hash = (x, y) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(SEED, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

const combined = project.blobs.get("splat");
if (combined.length !== RES * RES * 8) throw new Error(`splat is ${combined.length} bytes, expected ${RES}²×8`);
const off = RES * RES * 4;
const s = 1 / N, tw = W / N;
const share = [0, 0, 0, 0];
for (let pz = 0; pz < RES; pz++) {
  const v = (pz + 0.5) / RES;
  for (let px = 0; px < RES; px++) {
    const u = (px + 0.5) / RES;
    const gx = (sample(u + s, v) - sample(u - s, v)) / (2 * tw);
    const gz = (sample(u, v + s) - sample(u, v - s)) / (2 * tw);
    const slope = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
    const h = sample(u, v);
    const x = u * W, z = v * W;
    const n = (vnoise(x / 40, z / 40) * 0.65 + vnoise(x / 12 + 9, z / 12 + 5) * 0.35) * 2 - 1;   // ≈ ±1

    // Cliff starts AT the nav limit: rock means "units can't go here".
    const cliff = smooth(NAV_MAX_SLOPE_DEG, NAV_MAX_SLOPE_DEG + 8, slope + n * 3);
    const scree = smooth(13, 22, slope + n * 5) * (1 - cliff);
    const rest = 1 - cliff - scree;
    const ridge = smooth(HIGH0, HIGH1, h + n * 8) * rest;
    const soil = rest - ridge;

    const i = (pz * RES + px) * 4;
    const w = [soil, ridge, scree];
    for (let c = 0; c < 4; c++) combined[i + c] = c < 3 ? Math.round(w[c] * 255) : 0;
    combined[off + i] = 0;                        // slot 4
    combined[off + i + 1] = Math.round(cliff * 255); // slot 5
    combined[off + i + 2] = 0;                    // slot 6 (alpha = holes, kept)
    share[0] += soil; share[1] += ridge; share[2] += scree; share[3] += cliff;
  }
}
await writeProject(FILE, project);
const T = RES * RES;
console.log(`high band from the land histogram: p80 ${HIGH0.toFixed(1)} m → p95 ${HIGH1.toFixed(1)} m`);
console.log(`coverage: soil ${(100 * share[0] / T).toFixed(1)}%  ridge ${(100 * share[1] / T).toFixed(1)}%  scree ${(100 * share[2] / T).toFixed(1)}%  cliff ${(100 * share[3] / T).toFixed(1)}%`);
console.log(`written ${FILE}`);
