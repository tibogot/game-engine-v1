/**
 * V2 TerrainStore-shaped adapter over V3's flat CPU/GPU heightmap.
 * One virtual chunk covers the whole world so v2 SplineSystem.applyPlateau()
 * works unchanged. Heights exposed to v2 code are world metres; cpuHeightmap
 * stores normalized values (÷ maxHeight on commit).
 */
import {
  lowerAlongPolyline,
  sampleHeightWorld,
  snapshotHeightBox,
  restoreHeightBox,
} from "./heightPathWriter.js";

export function createV3TerrainStoreAdapter({
  cpuHeightmap,
  heightmapSize,
  worldSize,
  maxHeight,
  config = null,
}) {
  const workMeters = new Float32Array(heightmapSize * heightmapSize);
  let writeOpen = false;
  let writeDirty = false;

  const _noopChunk = new Float32Array(1);

  function syncFromNormalized() {
    for (let i = 0; i < cpuHeightmap.length; i++) {
      workMeters[i] = cpuHeightmap[i] * maxHeight;
    }
  }

  function beginWrite() {
    syncFromNormalized();
    writeOpen = true;
    writeDirty = false;
  }

  function commit() {
    if (!writeDirty) return false;
    for (let i = 0; i < cpuHeightmap.length; i++) {
      cpuHeightmap[i] = workMeters[i] / maxHeight;
    }
    writeOpen = false;
    writeDirty = false;
    return true;
  }

  function cancelWrite() {
    writeOpen = false;
    writeDirty = false;
  }

  return {
    getWorldHeight(wx, wz) {
      if (writeOpen) {
        return sampleHeightWorld(workMeters, heightmapSize, worldSize, wx, wz);
      }
      const u = (wx + worldSize / 2) / worldSize;
      const v = (wz + worldSize / 2) / worldSize;
      if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
      const dataResolution = heightmapSize - 1;
      const fx = u * dataResolution;
      const fz = v * dataResolution;
      const ix0 = Math.floor(fx);
      const iz0 = Math.floor(fz);
      const ix1 = Math.min(ix0 + 1, dataResolution);
      const iz1 = Math.min(iz0 + 1, dataResolution);
      const tx = fx - ix0;
      const tz = fz - iz0;
      const i00 = iz0 * heightmapSize + ix0;
      const i10 = iz0 * heightmapSize + ix1;
      const i01 = iz1 * heightmapSize + ix0;
      const i11 = iz1 * heightmapSize + ix1;
      const h0 = cpuHeightmap[i00] * (1 - tx) + cpuHeightmap[i10] * tx;
      const h1 = cpuHeightmap[i01] * (1 - tx) + cpuHeightmap[i11] * tx;
      return (h0 * (1 - tz) + h1 * tz) * maxHeight;
    },

    /** v2 SplineSystem.applyPlateau — only chunk (0,0) is valid. */
    ensureChunkData(cx, cz) {
      if (cx !== 0 || cz !== 0) return _noopChunk;
      if (!writeOpen) beginWrite();
      writeDirty = true;
      return workMeters;
    },

    /** v2 river/tunnel carve API. dirtyChunks is ignored (no chunk remesh in v3). */
    lowerTerrainAlongPoints(pts, halfW, margin, _dirtyChunks) {
      if (!writeOpen) beginWrite();
      const changed = lowerAlongPolyline(workMeters, {
        heightmapSize,
        worldSize,
        pts,
        halfW,
        margin,
      });
      if (changed) writeDirty = true;
    },

    /** Restore entire height field from a full-map metres snapshot (river base). */
    restoreFullHeights(src) {
      if (!writeOpen) beginWrite();
      if (src?.length === workMeters.length) workMeters.set(src);
      writeDirty = true;
    },

    copyWorkHeights() {
      return new Float32Array(workMeters);
    },

    snapshotChunksNearPath(pts, halfW, margin) {
      if (!writeOpen) syncFromNormalized();
      if (!Array.isArray(pts) || pts.length === 0) return new Map();
      const reach = halfW + margin;
      let minWX = Infinity;
      let maxWX = -Infinity;
      let minWZ = Infinity;
      let maxWZ = -Infinity;
      for (const p of pts) {
        if (p.x < minWX) minWX = p.x;
        if (p.x > maxWX) maxWX = p.x;
        if (p.z < minWZ) minWZ = p.z;
        if (p.z > maxWZ) maxWZ = p.z;
      }
      const snap = snapshotHeightBox(workMeters, {
        heightmapSize,
        worldSize,
        minWX,
        maxWX,
        minWZ,
        maxWZ,
        pad: reach,
      });
      return new Map([["0,0", snap]]);
    },

    restoreChunkHeightsFromMap(snapshotMap) {
      if (!writeOpen) beginWrite();
      for (const snap of snapshotMap.values()) {
        if (snap?.data) restoreHeightBox(workMeters, snap);
      }
      writeDirty = true;
    },

    beginWrite,
    commit,
    cancelWrite,
    get workMeters() { return workMeters; },
    config,
  };
}

/** Config slice expected by v2 SplineSystem plateau + chunk math. */
export function createV3SplineTerrainConfig(worldSize, heightmapSize, maxHeight) {
  return {
    world: {
      size: worldSize,
      chunkSize: worldSize,
      dataResolution: heightmapSize - 1,
    },
    sculpt: {
      sculptClampMin: -50,
      sculptClampMax: maxHeight * 3,
    },
  };
}
