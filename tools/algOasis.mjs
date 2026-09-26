/**
 * AN OASIS in an Algeria map — a spring pool in the valley floor, and the
 * damp palm-grove ground round it.
 *
 * A v3 lake is a water PLANE at a level: water shows wherever the ground is
 * under it (lakeSystem.js). So an oasis is a basin carved into the heightmap
 * with the plane just above its floor, and the SHORE is wherever the basin's
 * slope crosses that level. The basin is a union of noise-warped lobes, so
 * the shore is irregular, not a circle.
 *
 *   node tools/algOasis.mjs --file public/levels/alg-aures.v3proj --x 132 --z 128 --r 20
 *
 * Writes into the .v3proj: the heightmap (the basin), one lake in `lakes`,
 * and paint slot 3 "Oasis ground" (grass_ground, Poly Haven CC0) in a ring
 * round the water, feathered out into the valley soil. Idempotent per site:
 * run it once per oasis; re-running on the same site deepens the basin.
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const FILE = args.file ?? "public/levels/alg-aures.v3proj";
const CX = +(args.x ?? 132), CZ = +(args.z ?? 128), RAD = +(args.r ?? 20);
const DEPTH = +(args.depth ?? 2.8);       // metres the basin floor sits under the rim
const GROVE = +(args.grove ?? 2.6);       // grove ground reaches this many radii out
const SEED = +(args.seed ?? 11);
const SLOT = 3;

const project = await readProject(FILE);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));

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
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Lobes: a main pool and three smaller ones off it, each its own radius.
const lobes = [{ x: CX, z: CZ, r: RAD }];
for (let k = 0; k < 3; k++) {
  const a = hash(k, 3) * Math.PI * 2;
  const d = RAD * (0.55 + hash(k, 5) * 0.35);
  lobes.push({ x: CX + Math.cos(a) * d, z: CZ + Math.sin(a) * d, r: RAD * (0.45 + hash(k, 7) * 0.3) });
}
/** 1 deep inside the pool, falling to 0 at its (warped) edge. */
const inPool = (x, z) => {
  const warp = (vnoise(x / 9, z / 9) - 0.5) * 0.5;
  let best = 0;
  for (const L of lobes) best = Math.max(best, 1 - Math.hypot(x - L.x, z - L.z) / (L.r * (1 + warp)));
  return best;
};

const cell = W / (N - 1);
const toX = (j) => j * cell - W / 2, toZ = (i) => i * cell - W / 2;
// The ground the basin is cut from: the mean height round the site.
let sum = 0, n = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const d = Math.hypot(toX(j) - CX, toZ(i) - CZ);
  if (d < RAD * 1.5) { sum += hm[i * N + j] * TOP; n++; }
}
const ground = sum / n;
const floor = ground - DEPTH;
let cut = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = toX(j), z = toZ(i);
  if (Math.hypot(x - CX, z - CZ) > RAD * 2.2) continue;
  const p = inPool(x, z);
  // Bowl: flat floor in the middle, a gentle bank (the shore is walkable
  // right to the water, as round a real spring).
  const target = floor + (ground - floor) * (1 - smooth(p / 0.55));
  const k = i * N + j, h = hm[k] * TOP;
  // Blend toward the bowl only inside a soft margin, so the valley floor
  // outside is untouched.
  const w = smooth((p + 0.35) / 0.35);
  const nh = h + (Math.min(h, target) - h) * w;
  if (nh < h - 0.01) cut++;
  hm[k] = nh / TOP;
}
project.blobs.set("heightmap", Buffer.from(hm.buffer));

// The lake: level a little above the floor; the plane spans the basin.
const level = floor + DEPTH * 0.55;
man.lakes = man.lakes ?? { params: {}, lakes: [] };
man.lakes.lakes = (man.lakes.lakes ?? []).filter((l) => Math.hypot(l.cx - CX, l.cz - CZ) > 1);
man.lakes.lakes.push({ cx: CX, cz: CZ, sizeX: RAD * 3.2, sizeZ: RAD * 3.2, level });
// A spring pool, not a jungle river. The lake shader's Beer-Lambert runs over
// depth / depthDistance: at the default 20 m a pool a metre or two deep
// absorbed almost nothing and showed its bright sand bed — it read as SAND
// (2026-09-26). 3.5 m: dark green within a couple of metres, clear at the
// edge. The bed is silt and weed, not beach sand, and caustics are faint.
Object.assign(man.lakes.params.water ?? {}, { absorptionR: 0.55, absorptionG: 0.16, absorptionB: 0.3, inscatterTint: "#0b2418", inscatterStrength: 0.9, absorptionScale: 14, depthDistance: 3.5 });
if (man.lakes.params.lakebed) Object.assign(man.lakes.params.lakebed, { sandColor: "#5b5238", deepColor: "#1d2a1e", tintDepth: 2.5, causticsIntensity: 0.5, shallowBoost: 0.6 });

// Paint: slot 3 = the grove floor, damp and grassy, in a feathered ring.
const tex = (id) => {
  const f = (m) => ({ name: `${id}_${m}_1k.jpg`, url: `/textures/ground/${id}/${id}_${m}_1k.jpg` });
  return { albedo: f("diff"), normal: f("nor_gl"), rough: f("rough"), ao: f("ao") };
};
man.paintLayers[SLOT] = {
  name: "Oasis ground", ...tex("grass_ground"),
  uvScale: 128, normalStr: 1, aoStr: 0.8, roughStr: 1, triplanar: false, tint: "#b8b890",
  uvRotation: 0, contourAlign: 0, rockShade: 0, procedural: null, blocksGrass: false, blocksTrees: false,
  auto: { enabled: false, heightMin: 0, heightMax: 500, slopeMin: 0, slopeMax: 90, blend: 15, strength: 1 },
};
const RES = man.splatRes;
const splat = project.blobs.get("splat");
const off = RES * RES * 4;
let painted = 0;
for (let pz = 0; pz < RES; pz++) {
  const z = ((pz + 0.5) / RES) * W - W / 2;
  if (Math.abs(z - CZ) > RAD * GROVE * 1.3) continue;
  for (let px = 0; px < RES; px++) {
    const x = ((px + 0.5) / RES) * W - W / 2;
    const d = Math.hypot(x - CX, z - CZ) / RAD;
    const edge = GROVE * (0.85 + (vnoise(x / 14, z / 14) - 0.5) * 0.5);
    const w = 1 - smooth((d - edge * 0.6) / (edge * 0.4));
    if (w <= 0.004) continue;
    const i = (pz * RES + px) * 4;
    // Take the share from the other layers, keep the sum.
    const keep = 1 - w;
    for (let c = 0; c < 4; c++) splat[i + c] = Math.round(splat[i + c] * keep);
    for (let c = 0; c < 3; c++) splat[off + i + c] = Math.round(splat[off + i + c] * keep);
    splat[i + SLOT] = Math.min(255, splat[i + SLOT] + Math.round(w * 255));
    painted++;
  }
}

await writeProject(FILE, project);
console.log(`oasis at (${CX}, ${CZ}) r ${RAD} m: ground ${ground.toFixed(2)} m, floor ${floor.toFixed(2)}, water level ${level.toFixed(2)}`);
console.log(`${cut} heightmap texels cut, ${painted} splat texels painted, lakes in map: ${man.lakes.lakes.length}`);
