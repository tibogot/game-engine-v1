/**
 * A COAST LEVEL for the Algeria RTS from a map cut (tools/algDem.mjs):
 * the cut's land, a SEABED under its sea, the LOOK of a template level
 * (sky, light, grass and plant settings, paint layers), Ocean Pro from the
 * Tidewater bay level (`--ocean`), and none of its
 * content (decals, lakes, trees, props, painted plants, far terrain).
 *
 *   node tools/algCoastLevel.mjs --cut <dir>/coast-filfila \
 *        --from public/levels/alg-aures.v3proj --out public/levels/alg-coast.v3proj \
 *        [--sea 30] [--swell 45] [--wind 40] [--ocean public/levels/tidewater-bay.v3proj]
 *
 * THE SEA: the cut's sea (tools/lib/coastSea.mjs) sits flat at its sea level,
 * no depth under it — Ocean Pro colours and foams by DEPTH. The land is lifted
 * so the shore meets `--sea` m (the ocean's seaLevel), and the sea floor falls
 * away from the shore on TIDEWATER'S BAY PROFILE (tools/makeTidewaterBay.mjs:
 * 5% for 70 m, 6% to 260 m, 7% beyond, a longshore bar), by distance from the
 * shore. (A smoothstep shelf was tried first: it starts FLAT, so tens of
 * metres of ankle-deep water all foamed, and its flat floor drew a hard line.)
 * Outside the heightmap the engine draws ground at 0 m — under the sea, so
 * open water runs to the horizon.
 *
 * The ground is one paint layer (the template's first) until it is painted.
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { coastSeaMask, chamferDistance } from "./lib/coastSea.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.cut || !args.from || !args.out) throw new Error("usage: --cut <dir>/<name> --from <template.v3proj> --out <new.v3proj> [--sea 30]");
if (fs.existsSync(args.out) && args.force !== "1") throw new Error(`${args.out} exists — --force 1 to rebuild it`);
const SEA = +(args.sea ?? 30);   // Tidewater's: the heightmap can't go below 0, so the deep water needs room

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Height under the sea (m, negative) `d` m out from the shore: Tidewater's bay profile. */
function seabed(d, along) {
  const depth = d < 70 ? d * 0.05 : d < 260 ? 3.5 + (d - 70) * 0.06 : 14.9 + (d - 260) * 0.07;
  let y = -Math.min(depth, SEA - 0.5);
  // the longshore bar and its trough (about zero mean over the profile)
  const bar = Math.exp(-(((d - 44) / 10) ** 2)) * 0.28 - Math.exp(-(((d - 26) / 9) ** 2)) * 0.31;
  return y + bar * (0.7 + 0.3 * Math.sin(along / 50 + 1.3)) * smoothstep(5, 15, d);
}
/**
 * The BEACH, added to the land `e` m in from the shore: Tidewater's swash slope
 * (6.8%) and the berm at the top of the swash, then level — so the cut's land
 * is lifted by the same ~2.7 m everywhere past the berm. Without it the cut's
 * coast sits a few cm over the sea for tens of metres and the swash ran far
 * inland across it.
 */
function beach(e) {
  return Math.min(e * 0.068, 2.584) + 0.14 * Math.exp(-(((e - 38) / 5) ** 2));
}

const meta = JSON.parse(fs.readFileSync(`${args.cut}.json`, "utf8"));
const raw = fs.readFileSync(`${args.cut}.f32`);
const N = meta.size, W = meta.world, cell = W / (N - 1);
const cut = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)).map((v) => v * meta.top);

const tpl = await readProject(args.from);
const man = tpl.manifest;
const { worldSize, heightmapSize, maxHeight: TOP } = man.terrain;
if (worldSize !== W || heightmapSize !== N) throw new Error(`the cut is ${W} m / ${N}², the template ${worldSize} m / ${heightmapSize}²`);

// ── Heights ────────────────────────────────────────────────────────────────
const sea = coastSeaMask(cut, N, W, meta.seaLevel);
const shoreDist = chamferDistance(N, (k) => !sea[k]);   // cells to the nearest land
const landDist = chamferDistance(N, (k) => sea[k] === 1);  // cells to the nearest sea
const lift = SEA - (meta.seaLevel ?? meta.floor);
const h = new Float32Array(N * N);
let hi = 0, seaCells = 0;
for (let k = 0; k < N * N; k++) {
  if (sea[k]) {
    const i = (k / N) | 0, j = k - i * N;
    h[k] = SEA + seabed(shoreDist[k] * cell, (j - i) * cell * Math.SQRT1_2);   // "along": a diagonal, the bay's shore runs NE–SW
    seaCells++;
  } else {
    h[k] = Math.max(SEA + 0.05, cut[k] + lift) + beach(landDist[k] * cell);
  }
  if (h[k] > hi) hi = h[k];
}
if (hi > TOP) throw new Error(`land reaches ${hi.toFixed(1)} m, over the level's ${TOP} m`);
const norm = h.map((v) => v / TOP);

// ── Manifest: the template's look, none of its content ─────────────────────
man.trees = { ...man.trees, instances: [] };
man.props = { ...man.props, instances: [] };
man.decals = { ...man.decals, decals: [] };
man.lakes = { ...man.lakes, lakes: [] };
man.roads = { nodes: [], edges: [], nextNodeId: 1, selectedNodeId: null };
man.splines = Object.fromEntries(Object.keys(man.splines ?? {}).map((k) => [k, []]));
for (const k of ["waterfalls", "riversV2", "riverNetwork", "tunnels", "spawn"]) man[k] = null;
if (man.farTerrain) man.farTerrain = { ...man.farTerrain, enabled: false };
// THE OCEAN: Ocean Pro as tuned on the Tidewater bay (`--ocean`), at our sea level.
const oceanFrom = args.ocean ?? "public/levels/tidewater-bay.v3proj";
const ocean = structuredClone((await readProject(oceanFrom)).manifest.environment?.worldOcean ?? null);
if (!ocean) throw new Error(`${oceanFrom} has no environment.worldOcean`);
// THE SWELL comes in FROM THE SEA (`--swell`, the direction it travels, degrees,
// x = 0, z = 90): Tidewater's 263 sent it north, off our land into the bay — the
// shore field then foamed the open water in blocks with hard edges.
const SWELL = +(args.swell ?? 45), WIND = +(args.wind ?? 40);
ocean.pro = { ...ocean.pro, swellDeg: SWELL, windDeg: WIND };
man.environment = { ...man.environment, worldOcean: { ...ocean, enabled: true, seaLevel: SEA } };

// ── Blobs: the new heights, one paint layer, no painted plants ─────────────
const S = man.terrain.splatSize ?? man.splatRes;
const splat = Buffer.alloc(S * S * 8);   // two planar RGBA planes, layer c in plane c >> 2, channel c & 3
for (let t = 0; t < S * S; t++) splat[t * 4] = 255;
const blobs = new Map([
  ["heightmap", Buffer.from(norm.buffer)],
  ["splat", splat],
]);
const bytes = await writeProject(args.out, { manifest: man, blobs });

console.log(`${args.out}: ${(bytes / 1e6).toFixed(1)} MB`);
console.log(`sea level ${SEA} m (the cut's ${meta.seaLevel?.toFixed(2)} m lifted ${lift.toFixed(2)} m), seabed on Tidewater's bay profile`);
console.log(`sea ${((100 * seaCells) / (N * N)).toFixed(1)}% of the map, land to ${hi.toFixed(1)} m; ground = paint layer 0 "${man.paintLayers?.[0]?.name ?? "?"}"`);
