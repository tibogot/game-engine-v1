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
  maxHeight:     { min: 100,  max: 2000 },
};

const DEFAULTS = { worldSize: 2048, heightmapSize: 1024, maxHeight: 500 };

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
    return {
      worldSize:     clampCfg(p.worldSize,     TERRAIN_SIZE_LIMITS.worldSize,     DEFAULTS.worldSize),
      heightmapSize: clampCfg(p.heightmapSize, TERRAIN_SIZE_LIMITS.heightmapSize, DEFAULTS.heightmapSize),
      maxHeight:     clampCfg(p.maxHeight,     TERRAIN_SIZE_LIMITS.maxHeight,     DEFAULTS.maxHeight),
    };
  } catch {
    return DEFAULTS;
  }
}

const cfg = readSavedConfig();

export const WORLD_SIZE     = cfg.worldSize;
export const HEIGHTMAP_SIZE = cfg.heightmapSize;
// Scale factor: stored_value × MAX_HEIGHT = world metres.
// No upper clamp on stored values — mountains can exceed 1.0 × MAX_HEIGHT.
export const MAX_HEIGHT = cfg.maxHeight;

/**
 * Persist a new terrain config. Takes effect on the NEXT page load — callers
 * should reload the editor after this (and stash any pending heightmap to
 * import via pendingLoad.js first).
 */
export function saveTerrainConfig({ worldSize, heightmapSize, maxHeight }) {
  const next = {
    worldSize:     clampCfg(worldSize,     TERRAIN_SIZE_LIMITS.worldSize,     WORLD_SIZE),
    heightmapSize: clampCfg(heightmapSize, TERRAIN_SIZE_LIMITS.heightmapSize, HEIGHTMAP_SIZE),
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
