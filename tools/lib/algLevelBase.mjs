/**
 * A LEVEL WITH NOTHING IN IT (2026-10-13, you: "a new map starts from nothing and we add elements").
 * The map tools (coast, training, El Kantara) used to start from ANOTHER map's file and strip what
 * they knew of — and kept what they didn't: the coast's Pro sea at 30 m drew over El Kantara's
 * 20 m plain. This is the one place that says what "empty" is.
 *
 * KEPT (the look, not the content): the sky and light settings, the grass and plant FIELD settings,
 * the plant slot catalogue, the paint blend, the 7 paint slots' photos (a map sets its own).
 * EMPTIED: trees, props, decals, lakes, roads, splines, waterfalls, rivers, tunnels, the spawn; the
 * sea (classic, at 0 m, under any ground); the far terrain; every blob but the four a map writes.
 */

/** Empty a manifest of its content (in place). */
export function blankManifest(man) {
  man.trees = { ...man.trees, instances: [] };
  man.props = { ...man.props, instances: [] };
  man.decals = { ...man.decals, decals: [] };
  man.lakes = { ...man.lakes, lakes: [] };
  man.roads = { nodes: [], edges: [], nextNodeId: 1, selectedNodeId: null };
  if (man.splines) man.splines = { ...man.splines, points: [], tunnels: [], guardrails: [], kerbs: [], linearFeatures: [] };
  for (const k of ["waterfalls", "riversV2", "riverNetwork", "tunnels", "spawn"]) man[k] = null;
  if (man.farTerrain) man.farTerrain = { ...man.farTerrain, enabled: false };
  // NO SEA: classic at 0 m, under the ground (the Aurès' own). A Pro ocean at its sea level drew even
  // switched off.
  if (man.environment?.worldOcean) man.environment = { ...man.environment, worldOcean: { ...man.environment.worldOcean, enabled: false, seaLevel: 0, mode: "classic" } };
  man.ambientEffects = [];
  return man;
}

/**
 * The four blobs a map writes, empty: the heightmap flat at `height` m, the paint all slot 0, no plants.
 * Everything else (snow, grass density, cliff paint, far heights) is dropped — the engine runs without.
 */
export function blankBlobs(man, { height = 20 } = {}) {
  const { heightmapSize: N, maxHeight: TOP } = man.terrain;
  const S = man.terrain.splatSize ?? man.splatRes;
  const hgt = new Float32Array(N * N).fill(height / TOP);
  const splat = Buffer.alloc(S * S * 8);
  for (let t = 0; t < S * S; t++) splat[t * 4] = 255;   // plane 0, channel 0: slot 0
  return new Map([
    ["heightmap", Buffer.from(hgt.buffer)],
    ["splat", splat],
    ["susukiDensity", Buffer.alloc(512 * 512 * 4)],
    ["foliagePaint", Buffer.alloc(1024 * 1024 * 4 * 2)],
  ]);
}

/** The base every new alg-rts map starts from (tools/algBaseLevel.mjs writes it). */
export const BASE_LEVEL = "public/levels/alg-base.v3proj";
