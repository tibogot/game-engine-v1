/**
 * BillboardGrassStore — instances in terrain chunks (save/undo) + patch index (streaming).
 */
import {
  chunkKey,
  worldToChunkIndex,
  getChunkCountPerAxis,
} from "../terrain/chunkMath.js";
import {
  BILLBOARD_GRASS_PATCH_SIZE,
  BILLBOARD_GRASS_OCC_RES,
  patchKey,
  worldToPatchIndex,
  patchIndexRangeForWorldRect,
} from "./billboardGrassPatchMath.js";

export class BillboardGrassStore {
  constructor(config) {
    this.config = config;
    this.patchSize = BILLBOARD_GRASS_PATCH_SIZE;
    this._occRes = BILLBOARD_GRASS_OCC_RES;

    /** Terrain chunks — serialized / undo snapshots. */
    /** @type {Map<string, Array<{x:number, z:number, y:number, rotY:number, scale:number, slotIdx:number}>>} */
    this.chunks = new Map();

    /** Render/streaming patches (16 m world grid). */
    /** @type {Map<string, Array<{x:number, z:number, y:number, rotY:number, scale:number, slotIdx:number}>>} */
    this.patches = new Map();

    this._chunkGen = new Map();
    this._patchGen = new Map();
    this._globalGen = 0;
    this._occupancy = new Uint8Array(this._occRes * this._occRes);
  }

  _bumpChunkGen(key) {
    this._globalGen++;
    this._chunkGen.set(key, this._globalGen);
  }

  _bumpPatchGen(pk) {
    this._globalGen++;
    this._patchGen.set(pk, this._globalGen);
  }

  getChunkGen(key) {
    return this._chunkGen.get(key) ?? 0;
  }

  getPatchGen(pk) {
    return this._patchGen.get(pk) ?? 0;
  }

  _markOccupancyAt(wx, wz) {
    const ws = this.config.world.size;
    const half = ws * 0.5;
    const block = ws / this._occRes;
    const ox = Math.max(0, Math.min(this._occRes - 1, Math.floor((wx + half) / block)));
    const oz = Math.max(0, Math.min(this._occRes - 1, Math.floor((wz + half) / block)));
    this._occupancy[oz * this._occRes + ox] = 1;
  }

  /** True if any occupancy block overlaps the world XZ rectangle. */
  patchHasData(minX, maxX, minZ, maxZ) {
    const ws = this.config.world.size;
    const half = ws * 0.5;
    const block = ws / this._occRes;
    const minOx = Math.max(0, Math.floor((minX + half) / block));
    const maxOx = Math.min(this._occRes - 1, Math.floor((maxX + half) / block));
    const minOz = Math.max(0, Math.floor((minZ + half) / block));
    const maxOz = Math.min(this._occRes - 1, Math.floor((maxZ + half) / block));
    for (let oz = minOz; oz <= maxOz; oz++) {
      for (let ox = minOx; ox <= maxOx; ox++) {
        if (this._occupancy[oz * this._occRes + ox]) return true;
      }
    }
    return false;
  }

  rebuildOccupancy() {
    this._occupancy.fill(0);
    for (const items of this.patches.values()) {
      for (const f of items) this._markOccupancyAt(f.x, f.z);
    }
  }

  _rebuildPatchesFromChunks() {
    this.patches.clear();
    this._patchGen.clear();
    const ws = this.config.world.size;
    for (const items of this.chunks.values()) {
      for (const f of items) {
        const { px, pz } = worldToPatchIndex(f.x, f.z, ws, this.patchSize);
        const pk = patchKey(px, pz);
        if (!this.patches.has(pk)) this.patches.set(pk, []);
        this.patches.get(pk).push(f);
      }
    }
    for (const pk of this.patches.keys()) this._bumpPatchGen(pk);
    this.rebuildOccupancy();
  }

  add(wx, wz, y, rotY, scale, slotIdx) {
    const ws = this.config.world.size;
    const { cx, cz } = worldToChunkIndex(wx, wz, this.config);
    const ck = chunkKey(cx, cz);
    if (!this.chunks.has(ck)) this.chunks.set(ck, []);
    const item = { x: wx, z: wz, y, rotY, scale, slotIdx };
    this.chunks.get(ck).push(item);
    this._bumpChunkGen(ck);

    const { px, pz } = worldToPatchIndex(wx, wz, ws, this.patchSize);
    const pk = patchKey(px, pz);
    if (!this.patches.has(pk)) this.patches.set(pk, []);
    this.patches.get(pk).push(item);
    this._bumpPatchGen(pk);
    this._markOccupancyAt(wx, wz);
  }

  _removeFromPatch(item) {
    const ws = this.config.world.size;
    const { px, pz } = worldToPatchIndex(item.x, item.z, ws, this.patchSize);
    const pk = patchKey(px, pz);
    const list = this.patches.get(pk);
    if (!list) return;
    const idx = list.indexOf(item);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) {
      this.patches.delete(pk);
      this._patchGen.delete(pk);
    } else {
      this._bumpPatchGen(pk);
    }
  }

  removeInRadius(wx, wz, radius, slotFilter = -1) {
    const r2 = radius * radius;
    const half = this.config.world.size * 0.5;
    const cs = this.config.world.chunkSize;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    const minCX = Math.max(0, Math.floor((wx - radius + half) / cs));
    const maxCX = Math.min(maxC, Math.floor((wx + radius + half) / cs));
    const minCZ = Math.max(0, Math.floor((wz - radius + half) / cs));
    const maxCZ = Math.min(maxC, Math.floor((wz + radius + half) / cs));

    let changed = false;

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const ck = chunkKey(cx, cz);
        const items = this.chunks.get(ck);
        if (!items?.length) continue;
        const kept = [];
        for (const f of items) {
          const dx = f.x - wx;
          const dz = f.z - wz;
          const remove =
            dx * dx + dz * dz < r2 && (slotFilter < 0 || f.slotIdx === slotFilter);
          if (remove) {
            this._removeFromPatch(f);
            changed = true;
          } else {
            kept.push(f);
          }
        }
        if (kept.length !== items.length) {
          if (kept.length === 0) this.chunks.delete(ck);
          else this.chunks.set(ck, kept);
          this._bumpChunkGen(ck);
        }
      }
    }

    if (changed) this._rebuildOccupancyInRadius(wx, wz, radius);
  }

  /** Update only occupancy blocks touched by a brush (not the whole map). */
  _rebuildOccupancyInRadius(wx, wz, radius) {
    const ws = this.config.world.size;
    const half = ws * 0.5;
    const block = ws / this._occRes;
    const minOx = Math.max(0, Math.floor((wx - radius + half) / block));
    const maxOx = Math.min(this._occRes - 1, Math.floor((wx + radius + half) / block));
    const minOz = Math.max(0, Math.floor((wz - radius + half) / block));
    const maxOz = Math.min(this._occRes - 1, Math.floor((wz + radius + half) / block));
    for (let oz = minOz; oz <= maxOz; oz++) {
      for (let ox = minOx; ox <= maxOx; ox++) {
        this._occupancy[oz * this._occRes + ox] = 0;
      }
    }
    const { minPx, maxPx, minPz, maxPz } = patchIndexRangeForWorldRect(
      wx - radius,
      wx + radius,
      wz - radius,
      wz + radius,
      ws,
      this.patchSize,
    );
    for (let pz = minPz; pz <= maxPz; pz++) {
      for (let px = minPx; px <= maxPx; px++) {
        const items = this.patches.get(patchKey(px, pz));
        if (!items) continue;
        for (const f of items) this._markOccupancyAt(f.x, f.z);
      }
    }
  }

  hasNearby(wx, wz, dist) {
    const d2 = dist * dist;
    const ws = this.config.world.size;
    const { minPx, maxPx, minPz, maxPz } = patchIndexRangeForWorldRect(
      wx - dist,
      wx + dist,
      wz - dist,
      wz + dist,
      ws,
      this.patchSize,
    );
    for (let pz = minPz; pz <= maxPz; pz++) {
      for (let px = minPx; px <= maxPx; px++) {
        const items = this.patches.get(patchKey(px, pz));
        if (!items) continue;
        for (const f of items) {
          const dx = f.x - wx;
          const dz = f.z - wz;
          if (dx * dx + dz * dz < d2) return true;
        }
      }
    }
    return false;
  }

  getPatchItems(pk) {
    return this.patches.get(pk) ?? null;
  }

  /** Instances in all patches overlapping a world-aligned cell. */
  getItemsInPatchCell(cellX, cellZ, patchW) {
    const half = patchW * 0.5;
    const minX = cellX - half;
    const maxX = cellX + half;
    const minZ = cellZ - half;
    const maxZ = cellZ + half;
    const ws = this.config.world.size;
    const { minPx, maxPx, minPz, maxPz } = patchIndexRangeForWorldRect(
      minX,
      maxX,
      minZ,
      maxZ,
      ws,
      this.patchSize,
    );
    const out = [];
    for (let pz = minPz; pz <= maxPz; pz++) {
      for (let px = minPx; px <= maxPx; px++) {
        const list = this.patches.get(patchKey(px, pz));
        if (list) out.push(...list);
      }
    }
    return out;
  }

  getChunkKeysInRadius(wx, wz, radius) {
    const half = this.config.world.size * 0.5;
    const cs = this.config.world.chunkSize;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    const minCX = Math.max(0, Math.floor((wx - radius + half) / cs));
    const maxCX = Math.min(maxC, Math.floor((wx + radius + half) / cs));
    const minCZ = Math.max(0, Math.floor((wz - radius + half) / cs));
    const maxCZ = Math.min(maxC, Math.floor((wz + radius + half) / cs));
    const keys = [];
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        keys.push(chunkKey(cx, cz));
      }
    }
    return keys;
  }

  restoreFromSnapshot(snapshot) {
    this.chunks.clear();
    this._chunkGen.clear();
    for (const [key, items] of snapshot) {
      if (items.length === 0) continue;
      this.chunks.set(key, items.map((f) => ({ ...f })));
      this._bumpChunkGen(key);
    }
    this._rebuildPatchesFromChunks();
  }

  syncAllHeights(terrainStore) {
    for (const items of this.chunks.values()) {
      for (const f of items) {
        f.y = terrainStore.getWorldHeight(f.x, f.z);
      }
    }
    for (const pk of this.patches.keys()) this._bumpPatchGen(pk);
  }

  clear() {
    this.chunks.clear();
    this.patches.clear();
    this._chunkGen.clear();
    this._patchGen.clear();
    this._occupancy.fill(0);
    this._globalGen++;
  }

  toJSON() {
    const out = [];
    for (const [key, items] of this.chunks) {
      if (items.length > 0) out.push({ key, items: items.map((f) => ({ ...f })) });
    }
    return out;
  }

  fromJSON(data) {
    this.clear();
    if (!Array.isArray(data)) return;
    for (const { key, items } of data) {
      if (Array.isArray(items) && items.length > 0) {
        this.chunks.set(key, items.map((f) => ({ ...f })));
        this._bumpChunkGen(key);
      }
    }
    this._rebuildPatchesFromChunks();
  }

  getTotalCount() {
    let n = 0;
    for (const items of this.patches.values()) n += items.length;
    return n;
  }

  getPatchCount() {
    return this.patches.size;
  }
}
