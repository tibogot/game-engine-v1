import { conformToRoadSurface } from "../terrain/heightPathWriter.js";

/**
 * Terrain conform for the Smart Road system on V3's flat heightmap — the
 * "flatten" from v2/smart-road-lab.html, made non-destructive.
 *
 * The lab's trick: keep a BASE terrain and always re-grade from it, so the
 * road never feeds back into its own drape height. Here the base is a
 * normalized snapshot of cpuHeightmap taken on entering road mode (rebase).
 * The road system drapes on `sampleGround` (base when available), and each
 * live re-grade restores the previously-graded texels from base before
 * conforming again — dragging a node moves the grade instead of stacking it.
 *
 * Bake = accept the current grade as the new base (or, with live grading off,
 * one v2-style destructive conform). The caller owns GPU pushes.
 */
export class RoadConformSystem {
  /**
   * @param {object} opts
   * @param {Float32Array} opts.cpuHeightmap normalized heights (÷ maxHeight)
   * @param {number} opts.heightmapSize
   * @param {number} opts.worldSize
   * @param {number} opts.maxHeight
   * @param {object} opts.terrainStore v3TerrainStoreAdapter (beginWrite/commit/workMeters)
   */
  constructor({ cpuHeightmap, heightmapSize, worldSize, maxHeight, terrainStore }) {
    this.cpuHeightmap = cpuHeightmap;
    this.heightmapSize = heightmapSize;
    this.worldSize = worldSize;
    this.maxHeight = maxHeight;
    this.terrainStore = terrainStore;
    this._base = null;      // normalized snapshot (pre-grade terrain)
    this._lastRect = null;  // texel rect changed by the last live conform
  }

  get hasBase() { return this._base !== null; }

  /** Snapshot the CURRENT terrain as the grade baseline. Call after the CPU
   *  mirror is fresh (ensureCpuHeightmapFromGpu) — mode entry, and bake. */
  rebase() {
    if (this._base && this._base.length === this.cpuHeightmap.length) {
      this._base.set(this.cpuHeightmap);
    } else {
      this._base = new Float32Array(this.cpuHeightmap);
    }
    this._lastRect = null;
  }

  /** World height (metres) from the BASE terrain — the road drape function.
   *  Falls back to the live heightmap before the first rebase. */
  sampleGround(wx, wz) {
    const src = this._base || this.cpuHeightmap;
    const size = this.heightmapSize;
    const dataResolution = size - 1;
    const u = (wx + this.worldSize / 2) / this.worldSize;
    const v = (wz + this.worldSize / 2) / this.worldSize;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const fx = u * dataResolution;
    const fz = v * dataResolution;
    const ix0 = Math.floor(fx);
    const iz0 = Math.floor(fz);
    const ix1 = Math.min(ix0 + 1, dataResolution);
    const iz1 = Math.min(iz0 + 1, dataResolution);
    const tx = fx - ix0;
    const tz = fz - iz0;
    const h0 = src[iz0 * size + ix0] * (1 - tx) + src[iz0 * size + ix1] * tx;
    const h1 = src[iz1 * size + ix0] * (1 - tx) + src[iz1 * size + ix1] * tx;
    return (h0 * (1 - tz) + h1 * tz) * this.maxHeight;
  }

  /** Copy base → cpuHeightmap inside a texel rect. Returns true if any texel changed. */
  _restoreRect(rect) {
    if (!rect || !this._base) return false;
    const size = this.heightmapSize;
    let changed = false;
    for (let iz = rect.minIz; iz <= rect.maxIz; iz++) {
      const row = iz * size;
      for (let ix = rect.minIx; ix <= rect.maxIx; ix++) {
        const idx = row + ix;
        if (this.cpuHeightmap[idx] !== this._base[idx]) {
          this.cpuHeightmap[idx] = this._base[idx];
          changed = true;
        }
      }
    }
    return changed;
  }

  _conformParams(system, params) {
    const sw = params.sidewalk ? (params.sidewalkWidth ?? 0) : 0;
    return {
      heightmapSize: this.heightmapSize,
      worldSize: this.worldSize,
      footprints: system.getFootprints(),
      getSurfaceH: (x, z) => system.roadSurfaceH(x, z),
      halfW: system.params.width * 0.5 + sw,
      embedDepth: params.flattenDepth ?? 0.35,
      shoulder: params.shoulder ?? 6,
      liftSkip: 1.5, // deck >1.5 m above ground = bridge/viaduct → leave terrain
    };
  }

  /**
   * Live re-grade: un-apply the previous grade (restore from base), then
   * conform to the current network. Returns true if cpuHeightmap changed
   * (caller pushes to GPU).
   */
  applyLive(system, params) {
    if (!this._base) return false;
    const restored = this._restoreRect(this._lastRect);
    this._lastRect = null;
    const opts = this._conformParams(system, params);
    if (!opts.footprints.length) return restored;

    this.terrainStore.beginWrite(); // syncs workMeters from the restored cpuHeightmap
    const { changed, rect } = conformToRoadSurface(this.terrainStore.workMeters, opts);
    if (changed) {
      // Mark dirty so commit() copies workMeters back into cpuHeightmap.
      this.terrainStore.ensureChunkData(0, 0);
      this.terrainStore.commit();
      this._lastRect = rect;
    } else {
      this.terrainStore.cancelWrite();
    }
    return changed || restored;
  }

  /**
   * Bake: make the current grade permanent. With a live grade applied this is
   * just a rebase; otherwise (live grading off) run one destructive v2-style
   * conform on the current terrain first. Returns true if cpuHeightmap changed.
   */
  bake(system, params) {
    let changed = false;
    if (!this._lastRect) {
      const opts = this._conformParams(system, params);
      if (opts.footprints.length) {
        this.terrainStore.beginWrite();
        const res = conformToRoadSurface(this.terrainStore.workMeters, opts);
        if (res.changed) {
          this.terrainStore.ensureChunkData(0, 0);
          this.terrainStore.commit();
          changed = true;
        } else {
          this.terrainStore.cancelWrite();
        }
      }
    }
    this.rebase();
    return changed;
  }

  /** Undo the live grade (restore graded texels to base). Returns true if changed. */
  removeGrade() {
    const changed = this._restoreRect(this._lastRect);
    this._lastRect = null;
    return changed;
  }
}
