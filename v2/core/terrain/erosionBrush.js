/**
 * Hydraulic erosion brush — ported from `splatmap-chunks.html` `applyErosionBrushAt`
 * and helpers (`buildErosionKernel`, `erosionSampleHG`, …).
 */
import * as THREE from "three";
import {
  chunkKey,
  worldHalf,
  getChunkCountPerAxis,
  getChunkDataIndex,
} from "./chunkMath.js";

/** v1 brush used `maxSteps = 60` for the brush (global pass uses 80). */
const EROSION_BRUSH_MAX_STEPS = 60;
const EROSION_GLOBAL_MAX_STEPS = 80;

/**
 * World-space half-extent for chunk undo snapshots: brush radius + droplet walk + deposit kernel.
 * @param {number} erosionKernelRadiusGrid — v1 `PARAMS.erosion.radius` (grid cells, not world meters).
 */
export function erosionSnapshotMarginWorld(config, brushRadius, erosionKernelRadiusGrid = 3) {
  const step = config.world.chunkSize / config.world.dataResolution;
  const rk = Math.ceil(erosionKernelRadiusGrid);
  return brushRadius + EROSION_BRUSH_MAX_STEPS * step * 2.5 + rk * step * 3;
}

function erosionGlobalGridMax(config) {
  const maxC = getChunkCountPerAxis(config) - 1;
  return (maxC + 1) * config.world.dataResolution;
}

function globalGridVertToChunk(ig, config) {
  const res = config.world.dataResolution;
  const maxC = getChunkCountPerAxis(config) - 1;
  const maxG = erosionGlobalGridMax(config);
  if (ig < 0 || ig > maxG) return null;
  if (ig === maxG) return { c: maxC, i: res };
  const c = Math.floor(ig / res);
  const i = ig - c * res;
  return { c, i };
}

function heightAtGlobalGrid(terrainStore, igx, igz, config) {
  const step = config.world.chunkSize / config.world.dataResolution;
  const wh = worldHalf(config);
  const wx = -wh + igx * step;
  const wz = -wh + igz * step;
  return terrainStore.getChunkHeightfieldHeight(wx, wz);
}

function addHeightDeltaGlobalVertex(terrainStore, igx, igz, delta, touchedKeys, config) {
  if (Math.abs(delta) < 1e-14) return;
  const locX = globalGridVertToChunk(igx, config);
  const locZ = globalGridVertToChunk(igz, config);
  if (!locX || !locZ) return;
  const heights = terrainStore.ensureChunkData(locX.c, locZ.c);
  const idx = getChunkDataIndex(locX.i, locZ.i, config);
  const cmin = config.sculpt.sculptClampMin;
  const cmax = config.sculpt.sculptClampMax;
  heights[idx] = THREE.MathUtils.clamp(heights[idx] + delta, cmin, cmax);
  touchedKeys.add(chunkKey(locX.c, locZ.c));
}

function erosionSampleHG(terrainStore, px, pz, config) {
  const maxG = erosionGlobalGridMax(config);
  const x0 = Math.floor(px);
  const z0 = Math.floor(pz);
  const x1 = Math.min(maxG, x0 + 1);
  const z1 = Math.min(maxG, z0 + 1);
  const tx = px - x0;
  const tz = pz - z0;
  const h00 = heightAtGlobalGrid(terrainStore, x0, z0, config);
  const h10 = heightAtGlobalGrid(terrainStore, x1, z0, config);
  const h01 = heightAtGlobalGrid(terrainStore, x0, z1, config);
  const h11 = heightAtGlobalGrid(terrainStore, x1, z1, config);
  return {
    h:
      h00 * (1 - tx) * (1 - tz) +
      h10 * tx * (1 - tz) +
      h01 * (1 - tx) * tz +
      h11 * tx * tz,
    gx: (h10 - h00) * (1 - tz) + (h11 - h01) * tz,
    gz: (h01 - h00) * (1 - tx) + (h11 - h10) * tx,
  };
}

function erosionDepositGrid(terrainStore, px, pz, amt, touchedKeys, config) {
  if (Math.abs(amt) < 1e-14) return;
  const maxG = erosionGlobalGridMax(config);
  const x0 = Math.floor(px);
  const z0 = Math.floor(pz);
  const x1 = Math.min(maxG, x0 + 1);
  const z1 = Math.min(maxG, z0 + 1);
  const tx = px - x0;
  const tz = pz - z0;
  addHeightDeltaGlobalVertex(terrainStore, x0, z0, amt * (1 - tx) * (1 - tz), touchedKeys, config);
  addHeightDeltaGlobalVertex(terrainStore, x1, z0, amt * tx * (1 - tz), touchedKeys, config);
  addHeightDeltaGlobalVertex(terrainStore, x0, z1, amt * (1 - tx) * tz, touchedKeys, config);
  addHeightDeltaGlobalVertex(terrainStore, x1, z1, amt * tx * tz, touchedKeys, config);
}

function erosionErodeKernel(terrainStore, px, pz, amt, bOffX, bOffZ, bW, touchedKeys, config) {
  const maxG = erosionGlobalGridMax(config);
  const cx = Math.floor(px);
  const cz = Math.floor(pz);
  for (let i = 0; i < bW.length; i++) {
    const nx = cx + bOffX[i];
    const nz = cz + bOffZ[i];
    if (nx < 0 || nx > maxG || nz < 0 || nz > maxG) continue;
    addHeightDeltaGlobalVertex(terrainStore, nx, nz, -amt * bW[i], touchedKeys, config);
  }
}

function buildErosionKernel(erRad) {
  const r = Math.ceil(erRad);
  const bOffX = [];
  const bOffZ = [];
  const bW = [];
  let totalW = 0;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= erRad) continue;
      const w = erRad - dist;
      bOffX.push(dx);
      bOffZ.push(dz);
      bW.push(w);
      totalW += w;
    }
  }
  for (let i = 0; i < bW.length; i++) bW[i] /= totalW;
  return { bOffX, bOffZ, bW };
}

/**
 * @param {import("./terrainStore.js").TerrainStore} terrainStore
 * @param {THREE.Vector3} worldPoint
 * @param {number} brushRadius
 * @param {number} brushStrength — v2 0.02..2.5; mapped to droplet count like v1 `brushStrength * 1.5` at v1 scale 60→90.
 * @param {{ erosionRate: number, depositionRate: number, evaporation: number, inertia: number, capacity: number, radius: number }} erosionParams
 * @returns {Set<string>} chunk keys touched
 */
export function applyErosionBrushToTerrain(terrainStore, worldPoint, brushRadius, brushStrength, erosionParams) {
  const config = terrainStore.config;
  const Ke = erosionParams.erosionRate;
  const Kd = erosionParams.depositionRate;
  const Kev = erosionParams.evaporation;
  const Kin = erosionParams.inertia;
  const Kc = erosionParams.capacity;
  const erRad = erosionParams.radius;
  const G = 4;
  const maxSteps = EROSION_BRUSH_MAX_STEPS;
  const minSlope = 0.001;

  const STEP = config.world.chunkSize / config.world.dataResolution;
  const wh = worldHalf(config);
  const maxG = erosionGlobalGridMax(config);
  const gcx = (worldPoint.x + wh) / STEP;
  const gcz = (worldPoint.z + wh) / STEP;
  const gridR = brushRadius / STEP;
  /** v1: `round(brushStrength * 1.5)` at default 60 → 90 droplets; v2 default strength 0.55 → same count. */
  const N = Math.max(1, Math.min(400, Math.round(brushStrength * (90 / 0.55))));

  const { bOffX, bOffZ, bW } = buildErosionKernel(erRad);
  const touchedKeys = new Set();

  for (let iter = 0; iter < N; iter++) {
    const angle = Math.random() * 2 * Math.PI;
    const rr = Math.sqrt(Math.random()) * gridR;
    let px = gcx + Math.cos(angle) * rr;
    let pz = gcz + Math.sin(angle) * rr;
    if (px < 1 || px >= maxG - 1 || pz < 1 || pz >= maxG - 1) continue;

    let ddx = 0;
    let ddz = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < maxSteps; step++) {
      const { h, gx, gz } = erosionSampleHG(terrainStore, px, pz, config);
      ddx = ddx * Kin - gx * (1 - Kin);
      ddz = ddz * Kin - gz * (1 - Kin);
      const len = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
      ddx /= len;
      ddz /= len;
      const nx2 = px + ddx;
      const nz2 = pz + ddz;
      if (nx2 < 0 || nx2 >= maxG || nz2 < 0 || nz2 >= maxG) break;

      const dh = erosionSampleHG(terrainStore, nx2, nz2, config).h - h;
      const cap = Math.max(minSlope, -dh) * speed * water * Kc;
      if (sediment > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(sediment, dh) : (sediment - cap) * Kd;
        sediment -= amt;
        erosionDepositGrid(terrainStore, px, pz, amt, touchedKeys, config);
      } else {
        const amt = Math.min((cap - sediment) * Ke, -dh + 0.001);
        sediment += amt;
        erosionErodeKernel(terrainStore, px, pz, amt, bOffX, bOffZ, bW, touchedKeys, config);
      }
      speed = Math.min(8, Math.sqrt(Math.max(0, speed * speed - dh * G)));
      water *= 1 - Kev;
      if (water < 0.005) break;
      px = nx2;
      pz = nz2;
    }
    erosionDepositGrid(terrainStore, px, pz, sediment * Kd, touchedKeys, config);
  }

  return touchedKeys;
}

/**
 * Whole-map hydraulic erosion pass — ports `splatmap-chunks.html` `runGlobalErosion`.
 * Seeds `iterations` droplets anywhere across the global grid and evolves each for up
 * to 80 steps. Identical physics to the brush path, shared helpers.
 *
 * @param {import("./terrainStore.js").TerrainStore} terrainStore
 * @param {{ iterations: number, erosionRate: number, depositionRate: number, evaporation: number, inertia: number, capacity: number, radius: number }} erosionParams
 * @returns {Set<string>} chunk keys touched
 */
export function applyGlobalErosionToTerrain(terrainStore, erosionParams) {
  const config = terrainStore.config;
  const Ke = erosionParams.erosionRate;
  const Kd = erosionParams.depositionRate;
  const Kev = erosionParams.evaporation;
  const Kin = erosionParams.inertia;
  const Kc = erosionParams.capacity;
  const erRad = erosionParams.radius;
  const G = 4;
  const minSlope = 0.001;
  const N = Math.max(1, Math.floor(erosionParams.iterations || 0));

  const maxG = erosionGlobalGridMax(config);
  const { bOffX, bOffZ, bW } = buildErosionKernel(erRad);
  const touchedKeys = new Set();

  for (let iter = 0; iter < N; iter++) {
    let px = 1 + Math.random() * (maxG - 2);
    let pz = 1 + Math.random() * (maxG - 2);
    let ddx = 0;
    let ddz = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < EROSION_GLOBAL_MAX_STEPS; step++) {
      const { h, gx, gz } = erosionSampleHG(terrainStore, px, pz, config);
      ddx = ddx * Kin - gx * (1 - Kin);
      ddz = ddz * Kin - gz * (1 - Kin);
      const len = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
      ddx /= len;
      ddz /= len;
      const nx2 = px + ddx;
      const nz2 = pz + ddz;
      if (nx2 < 0 || nx2 >= maxG || nz2 < 0 || nz2 >= maxG) break;

      const dh = erosionSampleHG(terrainStore, nx2, nz2, config).h - h;
      const cap = Math.max(minSlope, -dh) * speed * water * Kc;
      if (sediment > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(sediment, dh) : (sediment - cap) * Kd;
        sediment -= amt;
        erosionDepositGrid(terrainStore, px, pz, amt, touchedKeys, config);
      } else {
        const amt = Math.min((cap - sediment) * Ke, -dh + 0.001);
        sediment += amt;
        erosionErodeKernel(terrainStore, px, pz, amt, bOffX, bOffZ, bW, touchedKeys, config);
      }
      speed = Math.min(8, Math.sqrt(Math.max(0, speed * speed - dh * G)));
      water *= 1 - Kev;
      if (water < 0.005) break;
      px = nx2;
      pz = nz2;
    }
    erosionDepositGrid(terrainStore, px, pz, sediment * Kd, touchedKeys, config);
  }

  return touchedKeys;
}
