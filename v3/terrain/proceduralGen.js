import { terrainGenHeightAtWorld } from "../../v2/core/terrain/proceduralTerrainGen.js";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

/** Defaults aligned with v2 `V2_CONFIG.sculpt.gen` (seed tweaked for v3). */
export const DEFAULT_GEN = {
  mode: "ridge",
  scale: 4.0,
  octaves: 6,
  height: 120,
  seed: 42,
  domainWarp: 0.5,
  dropoff: 1.2,
  dropoffShape: "circle",
  offsetX: 0,
  offsetZ: 0,
  plains: 0,
  additive: false,
  tiltX: 0,
  tiltZ: 0,
};

/** Fill a normalized heightmap (0+ stored units) from procedural world heights. */
export function buildProceduralHeightmap(gen = DEFAULT_GEN) {
  const heights = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  const half = WORLD_SIZE * 0.5;
  const inv = 1 / HEIGHTMAP_SIZE;

  for (let iz = 0; iz < HEIGHTMAP_SIZE; iz++) {
    const wz = -half + (iz + 0.5) * inv * WORLD_SIZE;
    for (let ix = 0; ix < HEIGHTMAP_SIZE; ix++) {
      const wx = -half + (ix + 0.5) * inv * WORLD_SIZE;
      const h = terrainGenHeightAtWorld(wx, wz, gen, WORLD_SIZE);
      heights[iz * HEIGHTMAP_SIZE + ix] = h / MAX_HEIGHT;
    }
  }
  return heights;
}
