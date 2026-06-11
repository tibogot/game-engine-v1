/**
 * TreeStore — per-chunk tree instance storage with generation tracking.
 *
 * Each tree instance: { x, z, rotY, scale, slotIdx, y (cached from terrain) }
 * Stored per-chunk (same spatial grid as terrain) for efficient spatial queries.
 *
 * Generation counter per chunk lets the renderer skip matrix rebuilds for
 * chunks whose tree data hasn't changed since last frame.
 */
import {
  chunkKey,
  worldToChunkIndex,
  getChunkCountPerAxis,
} from "../terrain/chunkMath.js";

export class TreeStore {
  constructor(config) {
    this.config = config;
    /** @type {Map<string, Array<{x:number, z:number, y:number, rotY:number, scale:number, slotIdx:number}>>} */
    this.chunks = new Map();
    /** Monotonic generation counter per chunk — bumped on every mutation. */
    this._gen = new Map();
    this._globalGen = 0;
  }

  _bumpGen(key) {
    this._globalGen++;
    this._gen.set(key, this._globalGen);
  }

  getGen(key) {
    return this._gen.get(key) ?? 0;
  }

  /** Store-wide generation — bumped on any mutation. Lets renderers early-out when nothing changed. */
  get globalGen() {
    return this._globalGen;
  }

  addTree(wx, wz, y, rotY, scale, slotIdx) {
    const { cx, cz } = worldToChunkIndex(wx, wz, this.config);
    const key = chunkKey(cx, cz);
    if (!this.chunks.has(key)) this.chunks.set(key, []);
    this.chunks.get(key).push({ x: wx, z: wz, y, rotY, scale, slotIdx });
    this._bumpGen(key);
  }

  removeTreesInRadius(wx, wz, radius, slotFilter = -1) {
    const r2 = radius * radius;
    const half = this.config.world.size * 0.5;
    const cs = this.config.world.chunkSize;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    const minCX = Math.max(0, Math.floor((wx - radius + half) / cs));
    const maxCX = Math.min(maxC, Math.floor((wx + radius + half) / cs));
    const minCZ = Math.max(0, Math.floor((wz - radius + half) / cs));
    const maxCZ = Math.min(maxC, Math.floor((wz + radius + half) / cs));

    const touchedKeys = [];
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const key = chunkKey(cx, cz);
        const trees = this.chunks.get(key);
        if (!trees || trees.length === 0) continue;
        const kept = [];
        for (const t of trees) {
          const dx = t.x - wx;
          const dz = t.z - wz;
          const remove =
            dx * dx + dz * dz < r2 && (slotFilter < 0 || t.slotIdx === slotFilter);
          if (!remove) kept.push(t);
        }
        if (kept.length !== trees.length) {
          touchedKeys.push(key);
          if (kept.length === 0) this.chunks.delete(key);
          else this.chunks.set(key, kept);
          this._bumpGen(key);
        }
      }
    }
    return touchedKeys;
  }

  hasTreeNearby(wx, wz, dist) {
    const d2 = dist * dist;
    const half = this.config.world.size * 0.5;
    const cs = this.config.world.chunkSize;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    const minCX = Math.max(0, Math.floor((wx - dist + half) / cs));
    const maxCX = Math.min(maxC, Math.floor((wx + dist + half) / cs));
    const minCZ = Math.max(0, Math.floor((wz - dist + half) / cs));
    const maxCZ = Math.min(maxC, Math.floor((wz + dist + half) / cs));

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const trees = this.chunks.get(chunkKey(cx, cz));
        if (!trees) continue;
        for (const t of trees) {
          const dx = t.x - wx;
          const dz = t.z - wz;
          if (dx * dx + dz * dz < d2) return true;
        }
      }
    }
    return false;
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

  snapshotChunks(keys) {
    const snap = new Map();
    for (const key of keys) {
      const trees = this.chunks.get(key);
      snap.set(key, trees ? trees.map((t) => ({ ...t })) : []);
    }
    return snap;
  }

  restoreFromSnapshot(snap) {
    for (const [key, trees] of snap) {
      if (trees.length === 0) this.chunks.delete(key);
      else this.chunks.set(key, trees.map((t) => ({ ...t })));
      this._bumpGen(key);
    }
  }

  syncAllHeights(terrainStore) {
    for (const [key, trees] of this.chunks) {
      for (const t of trees) {
        t.y = terrainStore.getWorldHeight(t.x, t.z);
      }
      this._bumpGen(key);
    }
  }

  syncHeightsForChunks(keys, terrainStore) {
    for (const key of keys) {
      const trees = this.chunks.get(key);
      if (!trees) continue;
      for (const t of trees) {
        t.y = terrainStore.getWorldHeight(t.x, t.z);
      }
      this._bumpGen(key);
    }
  }

  get totalCount() {
    let n = 0;
    for (const trees of this.chunks.values()) n += trees.length;
    return n;
  }

  clear() {
    for (const key of this.chunks.keys()) this._bumpGen(key);
    this.chunks.clear();
  }
}
