/**
 * Build public/levels/tidewater-bay.v3proj: a test map for Ocean Pro's surf — Tidewater's bay beach
 * (its seabed and beach profile from TerrainData._base, with its longshore bar, berm and cusps),
 * nothing else on it. The sea is to +z, the swell comes in from +z as in Tidewater (swellDir
 * (-0.12, -1)), the sea level is 30 m (the heightmap can't go below 0).
 *
 *   node tools/makeTidewaterBay.mjs
 *
 * The settings (paint layers, look, grass config...) come from nam-valley; every object, plant,
 * river, decal and ambient effect is removed, and the ground is painted with its "Beach sand".
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const SRC = "public/levels/nam-valley.v3proj";
const OUT = "public/levels/tidewater-bay.v3proj";
const SEA = 30;

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// the shoreline: a gentle bay, 60 m deep and ~500 m wide
const shoreZ = (x) => -60 * Math.exp(-Math.pow(x / 260, 2)) + Math.sin(x / 83) * 2.5;

/** Height (m, relative to the sea) at (x, z): Tidewater's bay profile. */
function bayHeight(x, z) {
  const d = z - shoreZ(x); // > 0: the sea
  if (d >= 0) {
    let depth;
    if (d < 70) depth = d * 0.05;
    else if (d < 260) depth = 3.5 + (d - 70) * 0.06;
    else depth = 14.9 + (d - 260) * 0.07;
    let h = -Math.min(depth, SEA - 0.5);
    // longshore bar and trough (roughly zero mean over the profile)
    const bar = Math.exp(-Math.pow((d - 44) / 10, 2)) * 0.28 - Math.exp(-Math.pow((d - 26) / 9, 2)) * 0.31;
    h += bar * (0.7 + 0.3 * Math.sin(x / 50 + 1.3)) * smoothstep(5, 15, d);
    return h;
  }
  const e = -d;
  let h;
  if (e < 38) h = e * 0.068;
  else if (e < 70) h = 2.584 + (e - 38) * 0.03;
  else if (e < 230) h = 3.544 + (e - 70) * 0.075;
  else h = 15.544 + (e - 230) * 0.04;
  // beach cusps ~24 m apart in the upper swash, the berm crest at the top of the swash
  h += Math.sin((x + Math.sin(x / 60) * 9) * (2 * Math.PI / 24)) * 0.09 * smoothstep(4, 12, e) * (1 - smoothstep(20, 32, e));
  h += 0.14 * Math.exp(-Math.pow((e - 38) / 5, 2));
  return h;
}

const p = await readProject(SRC);
const m = p.manifest;
const { worldSize, heightmapSize: N, maxHeight } = m.terrain;
const splatN = m.terrain.splatSize;

// ---- the ground
const heights = new Float32Array(N * N);
for (let j = 0; j < N; j++) {
  const z = -worldSize / 2 + (j + 0.5) * worldSize / N; // row 0 = -z
  for (let i = 0; i < N; i++) {
    const x = -worldSize / 2 + (i + 0.5) * worldSize / N;
    heights[j * N + i] = Math.max(0, SEA + bayHeight(x, z)) / maxHeight;
  }
}
p.blobs.set("heightmap", Buffer.from(heights.buffer));

// ---- paint: all "Beach sand" (slice 0 holds layers 0..3, slice 1 layers 4..7)
const sand = m.paintLayers.findIndex((l) => /sand/i.test(l.name ?? ""));
if (sand < 0 || sand > 3) throw new Error("no sand layer in slice 0");
const splat = Buffer.alloc(splatN * splatN * 8);
for (let k = 0; k < splatN * splatN; k++) splat[k * 4 + sand] = 255;
p.blobs.set("splat", splat);

// ---- nothing grows, nothing stands
for (const name of ["grassDensity", "grassHeight", "susukiDensity", "foliagePaint", "cliffGrassDensity", "cliffPaint", "snow"]) {
  const b = p.blobs.get(name);
  if (b) p.blobs.set(name, Buffer.alloc(b.length));
}
if (m.props) m.props.instances = [];
if (m.trees) m.trees.instances = [];
if (m.decals) m.decals.decals = [];
if (m.riversV2) m.riversV2.rivers = [];
if (m.lakes) m.lakes.lakes = [];
for (const a of m.ambientEffects ?? []) a.enabled = false;
m.spawn = null;

// ---- Sky Pro and Ocean Pro, the swell as Tidewater's
const env = m.environment;
env.look.skyMode = "skypro";
// No editor fog: Tidewater has none (its air is Sky Pro's haze). nam-valley's monsoon layer, based at
// sea level, sat on the seabed and the water refracted it — the "sea too bright at night" of 2026-10-03.
if (env.look.fog) {
  env.look.fog.height.enabled = false;
  env.look.fog.distance.enabled = false;
}
env.worldOcean.enabled = true;
env.worldOcean.seaLevel = SEA;
env.worldOcean.mode = "pro";
env.worldOcean.pro = { ...(env.worldOcean.pro ?? {}), swellDeg: +(Math.atan2(-0.993, -0.119) * 180 / Math.PI + 360).toFixed(2) };

await writeProject(OUT, { manifest: m, blobs: p.blobs });
console.log(`wrote ${OUT}: bay shoreline at z ≈ ${shoreZ(0).toFixed(1)} m (x = 0), sea level ${SEA} m, sand layer ${sand}`);
