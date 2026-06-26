import { terrainGenHeightAtWorld } from "../../v2/core/terrain/proceduralTerrainGen.js";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

export const DEFAULT_GEN = {
  mode:        "ridge",
  scale:       4,
  octaves:     6,
  height:      120,
  seed:        42,
  domainWarp:  0,
  dropoff:     1.2,
  dropoffShape:"circle",
  plains:      0,
  offsetX:     0,
  offsetZ:     0,
  additive:    false,
  tiltX:       0,
  tiltZ:       0,
};

/**
 * Caldera mask: rises from 0 at center to 1 at the rim (~55% of map radius),
 * then fades back to 0 at the terrain boundary. The v2 "ring" shape has no
 * outer fade so it creates hard edges at the heightmap boundary.
 */
function calderaFalloff(nx, nz) {
  const dx = (nx - 0.5) * 2;
  const dz = (nz - 0.5) * 2;
  const r = Math.sqrt(dx * dx + dz * dz) / Math.SQRT2; // 0=center, 1=corner
  const rim = 0.52;
  if (r < rim) {
    return Math.pow(r / rim, 2);             // quadratic rise to rim
  }
  const outer = (r - rim) / (1.0 - rim);    // 0 at rim → 1 at corner
  return Math.pow(Math.max(0, 1 - outer), 1.5); // smooth fall to 0 at edge
}

/** Fill a normalized heightmap (0+ stored units) from procedural world heights. */
export function buildProceduralHeightmap(gen = DEFAULT_GEN) {
  const heights = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  const half = WORLD_SIZE * 0.5;
  const inv = 1 / HEIGHTMAP_SIZE;

  // "caldera" is a v3-only shape — run the base gen with a wide circle, then
  // overlay the ring mask here so both center and outer edges fade cleanly.
  const isCaldera = gen.dropoffShape === "caldera";
  const baseGen = isCaldera ? { ...gen, dropoffShape: "circle", dropoff: 0.7 } : gen;

  for (let iz = 0; iz < HEIGHTMAP_SIZE; iz++) {
    const wz = -half + (iz + 0.5) * inv * WORLD_SIZE;
    const nz = wz / WORLD_SIZE + 0.5;
    for (let ix = 0; ix < HEIGHTMAP_SIZE; ix++) {
      const wx = -half + (ix + 0.5) * inv * WORLD_SIZE;
      const nx = wx / WORLD_SIZE + 0.5;
      let h = terrainGenHeightAtWorld(wx, wz, baseGen, WORLD_SIZE);
      if (isCaldera) h *= calderaFalloff(nx, nz);
      heights[iz * HEIGHTMAP_SIZE + ix] = h / MAX_HEIGHT;
    }
  }
  return heights;
}
