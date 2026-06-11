import { getChunkCountPerAxis as getChunkCountPerAxisFromConfig } from "../../app/config.js";

export function getChunkCountPerAxis(config) {
  return getChunkCountPerAxisFromConfig(config);
}

export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

export function parseChunkKey(key) {
  const [cx, cz] = key.split(",").map(Number);
  return { cx, cz };
}

export function worldHalf(config) {
  return config.world.size * 0.5;
}

export function chunkMinWorldX(cx, config) {
  return -worldHalf(config) + cx * config.world.chunkSize;
}

export function chunkMinWorldZ(cz, config) {
  return -worldHalf(config) + cz * config.world.chunkSize;
}

export function chunkCenterWorld(cx, cz, out, config) {
  const minX = chunkMinWorldX(cx, config);
  const minZ = chunkMinWorldZ(cz, config);
  out.set(minX + config.world.chunkSize * 0.5, 0, minZ + config.world.chunkSize * 0.5);
  return out;
}

export function worldToChunkIndex(wx, wz, config) {
  const half = worldHalf(config);
  const chunkSize = config.world.chunkSize;
  return {
    cx: Math.floor((wx + half) / chunkSize),
    cz: Math.floor((wz + half) / chunkSize),
  };
}

export function clampChunkCoord(c, config) {
  const max = getChunkCountPerAxis(config) - 1;
  return Math.max(0, Math.min(max, c));
}

export function isValidChunkCoord(cx, cz, config) {
  const max = getChunkCountPerAxis(config) - 1;
  return cx >= 0 && cz >= 0 && cx <= max && cz <= max;
}

export function getChunkDataIndex(ix, iz, config) {
  return iz * (config.world.dataResolution + 1) + ix;
}

