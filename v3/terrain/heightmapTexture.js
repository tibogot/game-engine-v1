import * as THREE from "three";

/**
 * Terrain configuration — the three numbers that define a terrain, same model
 * as Unity/Unreal: world size (m), heightmap resolution (texels), height range.
 *
 * The config is resolved from localStorage HERE, at module-evaluation time,
 * before any importer runs — so every module (including module-scope constant
 * derivations) sees the configured values. Changing the size therefore means
 * writing the new config and reloading the editor (Unity semantics: terrain
 * resolution is a creation-time decision, resizing rebuilds the terrain).
 */

const CONFIG_KEY = "v3.terrainConfig";

export const TERRAIN_SIZE_LIMITS = {
  worldSize:     { min: 512,  max: 16384 },
  heightmapSize: { min: 256,  max: 4096 },
  splatSize:     { min: 256,  max: 4096 },
  maxHeight:     { min: 100,  max: 2000 },
};

const DEFAULTS = { worldSize: 2048, heightmapSize: 1024, splatSize: 512, maxHeight: 500 };

/**
 * Splat resolution used to be hardwired to half the heightmap. Configs and
 * projects written before `splatSize` existed carry no value, so they fall back
 * to that exact formula (2048 cap included) and load bit-identically.
 */
export function legacySplatSize(heightmapSize) {
  return Math.min(2048, Math.max(256, Math.round(heightmapSize / 2)));
}

function clampCfg(v, { min, max }, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function readSavedConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw);
    const heightmapSize = clampCfg(p.heightmapSize, TERRAIN_SIZE_LIMITS.heightmapSize, DEFAULTS.heightmapSize);
    return {
      worldSize:     clampCfg(p.worldSize,     TERRAIN_SIZE_LIMITS.worldSize,     DEFAULTS.worldSize),
      heightmapSize,
      splatSize:     clampCfg(p.splatSize,     TERRAIN_SIZE_LIMITS.splatSize,     legacySplatSize(heightmapSize)),
      maxHeight:     clampCfg(p.maxHeight,     TERRAIN_SIZE_LIMITS.maxHeight,     DEFAULTS.maxHeight),
    };
  } catch {
    return DEFAULTS;
  }
}

const cfg = readSavedConfig();

export const WORLD_SIZE     = cfg.worldSize;
export const HEIGHTMAP_SIZE = cfg.heightmapSize;
// Ground-paint (splatmap) resolution — independent of the heightmap since it
// drives texture detail, not terrain shape. Costs VRAM/RAM/save size only: the
// shader samples the same 3 bindings whatever the resolution.
export const SPLAT_SIZE = cfg.splatSize;
// Scale factor: stored_value × MAX_HEIGHT = world metres.
// No upper clamp on stored values — mountains can exceed 1.0 × MAX_HEIGHT.
export const MAX_HEIGHT = cfg.maxHeight;

/**
 * Persist a new terrain config. Takes effect on the NEXT page load — callers
 * should reload the editor after this (and stash any pending heightmap to
 * import via pendingLoad.js first).
 */
export function saveTerrainConfig({ worldSize, heightmapSize, splatSize, maxHeight }) {
  const hm = clampCfg(heightmapSize, TERRAIN_SIZE_LIMITS.heightmapSize, HEIGHTMAP_SIZE);
  const next = {
    worldSize:     clampCfg(worldSize,     TERRAIN_SIZE_LIMITS.worldSize,     WORLD_SIZE),
    heightmapSize: hm,
    // Absent splatSize (pre-splatSize project files) → the legacy half-heightmap
    // rule, so opening an old project never silently changes paint resolution.
    splatSize:     clampCfg(splatSize,     TERRAIN_SIZE_LIMITS.splatSize,     legacySplatSize(hm)),
    maxHeight:     clampCfg(maxHeight,     TERRAIN_SIZE_LIMITS.maxHeight,     MAX_HEIGHT),
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  return next;
}

export function createHeightmapTexture() {
  // Start flat; sculpt everything from scratch.
  const data = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  const tex = new THREE.DataTexture(data, HEIGHTMAP_SIZE, HEIGHTMAP_SIZE, THREE.RedFormat, THREE.FloatType);
  tex.needsUpdate = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
