import * as THREE from "three";
import { chunkCenterWorld, chunkKey, getChunkCountPerAxis } from "../terrain/chunkMath.js";
import { pickLodByDistance, pickLodWithHysteresis } from "./lodPolicy.js";

export class ChunkStreamManager {
  constructor({ config, scene, terrainStore, mesher, material, perf, onChunkCreated = null }) {
    this.config = config;
    this.scene = scene;
    this.terrainStore = terrainStore;
    this.mesher = mesher;
    this.material = material;
    this.perf = perf;
    this.onChunkCreated = onChunkCreated;

    this.activeChunks = new Map();
    this.needed = new Set();
    // key -> { minIx, maxIx, minIz, maxIz } | null (null = full rebuild)
    this.dirtyChunks = new Map();

    this.createQueue = [];
    this.remeshQueue = [];
    this.unloadQueue = [];

    this._tmpCenter = new THREE.Vector3();
    this._raycastMeshesCache = null;

    // Idle-skip state: last anchor position / LOD settings the grid was
    // scanned with. Seeded so the first update() always runs a full scan.
    this._lastAnchor = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._lastRadius = -1;
    this._lastLodEnabled = null;
  }

  /**
   * Merge dirty-chunk rects from an outside system (sculpt). If an entry is
   * `null`, the chunk needs a full rebuild (no incremental path applies).
   * @param {Map<string, null | {minIx, maxIx, minIz, maxIz}>} rects
   */
  markDirtyRects(rects) {
    for (const [key, rect] of rects) {
      const prev = this.dirtyChunks.get(key);
      if (rect === null || prev === null) {
        this.dirtyChunks.set(key, null);
        continue;
      }
      if (!prev) {
        this.dirtyChunks.set(key, {
          minIx: rect.minIx,
          maxIx: rect.maxIx,
          minIz: rect.minIz,
          maxIz: rect.maxIz,
        });
        continue;
      }
      if (rect.minIx < prev.minIx) prev.minIx = rect.minIx;
      if (rect.maxIx > prev.maxIx) prev.maxIx = rect.maxIx;
      if (rect.minIz < prev.minIz) prev.minIz = rect.minIz;
      if (rect.maxIz > prev.maxIz) prev.maxIz = rect.maxIz;
    }
  }

  /** Force full-rebuild marking for a set of keys (undo/redo, LOD stitch). */
  markDirtyFull(keys) {
    for (const key of keys) this.dirtyChunks.set(key, null);
  }

  /** Mark every active chunk as dirty for full rebuild (used on project load). */
  markAllDirty() {
    for (const key of this.activeChunks.keys()) this.dirtyChunks.set(key, null);
  }

  update(anchorWorldPos) {
    // Idle early-out: re-scanning the 33×33 chunk window is pointless unless
    // the anchor moved, something is dirty, LOD settings changed, or a
    // previous frame left budget-capped work in the queues.
    if (
      this.dirtyChunks.size === 0 &&
      this.createQueue.length === 0 &&
      this.remeshQueue.length === 0 &&
      this.unloadQueue.length === 0 &&
      this.config.lod.activeRadiusInChunks === this._lastRadius &&
      this.config.lod.enabled === this._lastLodEnabled &&
      anchorWorldPos.distanceToSquared(this._lastAnchor) < 0.25
    ) {
      this.perf.stream.created = 0;
      this.perf.stream.remeshed = 0;
      this.perf.stream.unloaded = 0;
      return;
    }
    this._lastAnchor.copy(anchorWorldPos);
    this._lastRadius = this.config.lod.activeRadiusInChunks;
    this._lastLodEnabled = this.config.lod.enabled;

    this.needed.clear();
    this.createQueue.length = 0;
    this.remeshQueue.length = 0;
    this.unloadQueue.length = 0;

    const max = getChunkCountPerAxis(this.config);
    const half = this.config.world.size * 0.5;
    const camChunkX = Math.floor((anchorWorldPos.x + half) / this.config.world.chunkSize);
    const camChunkZ = Math.floor((anchorWorldPos.z + half) / this.config.world.chunkSize);

    for (let dz = -this.config.lod.activeRadiusInChunks; dz <= this.config.lod.activeRadiusInChunks; dz++) {
      for (
        let dx = -this.config.lod.activeRadiusInChunks;
        dx <= this.config.lod.activeRadiusInChunks;
        dx++
      ) {
        const cx = camChunkX + dx;
        const cz = camChunkZ + dz;
        if (cx < 0 || cz < 0 || cx >= max || cz >= max) continue;
        const key = chunkKey(cx, cz);
        this.needed.add(key);

        const center = chunkCenterWorld(cx, cz, this._tmpCenter, this.config);
        const dist = center.distanceTo(anchorWorldPos);
        const active = this.activeChunks.get(key);
        const targetLod = this.config.lod.enabled
          ? active
            ? pickLodWithHysteresis(dist, active.segments, this.config)
            : pickLodByDistance(dist, this.config)
          : this.config.lod.levels[0];

        if (!active) {
          this.createQueue.push({ key, cx, cz, lod: targetLod, dist });
          continue;
        }

        if (active.segments !== targetLod.segments) {
          this.remeshQueue.push({
            key,
            cx,
            cz,
            lod: targetLod,
            reason: "lod",
            dirtyRect: null,
          });
          continue;
        }

        if (this.dirtyChunks.has(key)) {
          this.remeshQueue.push({
            key,
            cx,
            cz,
            lod: targetLod,
            reason: "dirty",
            dirtyRect: this.dirtyChunks.get(key),
          });
        }
      }
    }

    for (const [key, ch] of this.activeChunks) {
      if (!this.needed.has(key)) this.unloadQueue.push({ key, cx: ch.cx, cz: ch.cz });
    }

    this.createQueue.sort((a, b) => a.dist - b.dist);
    this.processQueues();
    this.perf.queues.create = this.createQueue.length;
    this.perf.queues.remesh = this.remeshQueue.length;
    this.perf.queues.unload = this.unloadQueue.length;
    this.perf.activeChunks = this.activeChunks.size;
  }

  processQueues() {
    let creates = 0;
    let cheapCreates = 0;
    const maxCreates = this.config.budgets.createPerFrame;
    const maxCheapCreates = this.config.budgets.cheapCreateBonusPerFrame;
    const cheapThreshold = this.config.budgets.cheapSegmentThreshold;

    let i = 0;
    while (i < this.createQueue.length) {
      const item = this.createQueue[i];
      const isCheap = item.lod.segments <= cheapThreshold;
      if (!isCheap && creates >= maxCreates) break;
      if (isCheap && cheapCreates >= maxCheapCreates) break;
      this.createChunk(item);
      this.createQueue.splice(i, 1);
      if (isCheap) cheapCreates++;
      else creates++;
    }

    // Sculpt (incremental) remeshes are cheap — give them a larger budget than
    // full-rebuild remeshes so a drag never outpaces the queue.
    const sculptBudget =
      this.config.budgets.sculptRemeshPerFrame ?? this.config.budgets.remeshPerFrame;
    const fullBudget = this.config.budgets.remeshPerFrame;
    let sculptDone = 0;
    let fullDone = 0;
    let remeshDone = 0;
    for (let r = this.remeshQueue.length - 1; r >= 0; r--) {
      const item = this.remeshQueue[r];
      const incremental = item.dirtyRect && item.reason === "dirty";
      if (incremental) {
        if (sculptDone >= sculptBudget) continue;
        this.remeshChunk(item);
        this.remeshQueue.splice(r, 1);
        sculptDone++;
        remeshDone++;
      } else {
        if (fullDone >= fullBudget) continue;
        this.remeshChunk(item);
        this.remeshQueue.splice(r, 1);
        fullDone++;
        remeshDone++;
      }
    }

    let unloadDone = 0;
    for (let u = this.unloadQueue.length - 1; u >= 0; u--) {
      if (unloadDone >= this.config.budgets.unloadPerFrame) break;
      const item = this.unloadQueue[u];
      this.unloadChunk(item.key);
      this.unloadQueue.splice(u, 1);
      unloadDone++;
    }

    this.perf.stream.created = creates + cheapCreates;
    this.perf.stream.remeshed = remeshDone;
    this.perf.stream.unloaded = unloadDone;
  }

  createChunk({ key, cx, cz, lod }) {
    this.terrainStore.ensureChunkData(cx, cz);
    const mesh = this.mesher.createChunkMesh(
      cx,
      cz,
      lod.segments,
      this.terrainStore,
      this.material,
      this.getNeighborSegments(cx, cz),
    );
    mesh.userData.chunkKey = key;
    this.scene.add(mesh);
    this.activeChunks.set(key, { key, cx, cz, segments: lod.segments, mesh });
    this.dirtyChunks.delete(key);
    this._raycastMeshesCache = null;
    if (this.onChunkCreated) this.onChunkCreated(mesh, key, cx, cz);
    // Neighbor LOD stitching depends on this chunk's segment count; refresh adjacent meshes.
    this.markNeighborStitchDirty(cx, cz, lod.segments);
  }

  remeshChunk({ key, cx, cz, lod, dirtyRect }) {
    const active = this.activeChunks.get(key);
    if (!active) return;
    const prevSegments = active.segments;
    this.terrainStore.ensureChunkData(cx, cz);
    // Incremental only when LOD unchanged and we have a rect. Otherwise full.
    const rect = prevSegments === lod.segments ? dirtyRect : null;
    this.mesher.remesh(
      active.mesh,
      cx,
      cz,
      lod.segments,
      this.terrainStore,
      this.getNeighborSegments(cx, cz),
      rect,
    );
    active.segments = lod.segments;
    this.dirtyChunks.delete(key);
    if (prevSegments !== lod.segments) {
      this.markNeighborStitchDirty(cx, cz, lod.segments);
    }
  }

  unloadChunk(key) {
    const active = this.activeChunks.get(key);
    if (!active) return;
    this.scene.remove(active.mesh);
    this.mesher.disposeChunkMesh(active.mesh);
    this.activeChunks.delete(key);
    this.dirtyChunks.delete(key);
    this._raycastMeshesCache = null;
  }

  raycastMeshes() {
    if (!this._raycastMeshesCache) {
      this._raycastMeshesCache = Array.from(this.activeChunks.values(), (x) => x.mesh);
    }
    return this._raycastMeshesCache;
  }

  /** Swap shared terrain material for all active chunk meshes (tile ↔ TSL). Caller owns disposal. */
  setSharedMaterial(material) {
    this.material = material;
    for (const ch of this.activeChunks.values()) {
      ch.mesh.material = material;
    }
    this._raycastMeshesCache = null;
  }

  getChunkKeysInBrushBounds(minX, minZ, maxX, maxZ) {
    const half = this.config.world.size * 0.5;
    const chunkSize = this.config.world.chunkSize;
    const minCX = Math.floor((minX + half) / chunkSize);
    const maxCX = Math.floor((maxX + half) / chunkSize);
    const minCZ = Math.floor((minZ + half) / chunkSize);
    const maxCZ = Math.floor((maxZ + half) / chunkSize);
    const out = new Set();
    const maxChunk = getChunkCountPerAxis(this.config) - 1;

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        if (cx < 0 || cz < 0 || cx > maxChunk || cz > maxChunk) continue;
        out.add(chunkKey(cx, cz));
      }
    }
    return out;
  }

  dispose() {
    for (const key of [...this.activeChunks.keys()]) this.unloadChunk(key);
    this.mesher.pool.disposeAll();
  }

  getNeighborSegments(cx, cz) {
    const maxChunk = getChunkCountPerAxis(this.config) - 1;
    const getSeg = (x, z) => {
      if (x < 0 || z < 0 || x > maxChunk || z > maxChunk) return null;
      const ch = this.activeChunks.get(chunkKey(x, z));
      return ch ? ch.segments : null;
    };
    return {
      east: getSeg(cx + 1, cz),
      west: getSeg(cx - 1, cz),
      south: getSeg(cx, cz + 1),
      north: getSeg(cx, cz - 1),
    };
  }

  markNeighborStitchDirty(cx, cz, selfSegments) {
    const maxChunk = getChunkCountPerAxis(this.config) - 1;
    const maybeMark = (nx, nz) => {
      if (nx < 0 || nz < 0 || nx > maxChunk || nz > maxChunk) return;
      const nk = chunkKey(nx, nz);
      const neighbor = this.activeChunks.get(nk);
      if (!neighbor) return;
      if (neighbor.segments === selfSegments) return;
      // LOD seam re-snap touches all edge verts; no incremental rect possible.
      this.dirtyChunks.set(nk, null);
    };

    maybeMark(cx + 1, cz);
    maybeMark(cx - 1, cz);
    maybeMark(cx, cz + 1);
    maybeMark(cx, cz - 1);
  }
}

