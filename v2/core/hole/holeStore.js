import * as THREE from "three";
import {
  chunkKey,
  chunkMinWorldX,
  chunkMinWorldZ,
  getChunkCountPerAxis,
  parseChunkKey,
  worldToChunkIndex,
} from "../terrain/chunkMath.js";

export class HoleStore {
  constructor(config) {
    this.config = config;
    this.resolution = config.paint.splatResolution;
    /** @type {Map<string, { data: Uint8Array, tex: THREE.DataTexture }>} */
    this.chunks = new Map();
  }

  getChunkByKey(key) {
    return this.chunks.get(key) ?? null;
  }

  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;

    const res = this.resolution;
    const data = new Uint8Array(res * res * 4);
    const tex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;

    // hasAnyHole: true if any R-channel pixel exceeds the alpha-test threshold.
    // Used to hide the chunk's terrain skirt (the LOD-seam curtain) when the
    // player can see into the hole from above. Skirts at the chunk perimeter
    // sample the edge texels of `data`, so a hole painted in the middle of a
    // chunk never reaches them — this flag is the chunk-wide signal instead.
    const entry = { data, tex, hasAnyHole: false };
    this.chunks.set(key, entry);
    return entry;
  }

  chunkHasAnyHole(key) {
    return this.chunks.get(key)?.hasAnyHole === true;
  }

  /**
   * Point-sample the hole mask at a world XZ. Returns true if that spot has
   * been painted out — same threshold the shader uses, so visual + collision
   * stay in lockstep. Cheap: bails on `hasAnyHole` for untouched chunks.
   */
  isHoleAt(wx, wz) {
    const cfg = this.config;
    const cs = cfg.world.chunkSize;
    const half = cfg.world.size * 0.5;
    const maxC = getChunkCountPerAxis(cfg) - 1;
    const cx = Math.floor((wx + half) / cs);
    const cz = Math.floor((wz + half) / cs);
    if (cx < 0 || cz < 0 || cx > maxC || cz > maxC) return false;
    const entry = this.chunks.get(chunkKey(cx, cz));
    if (!entry || !entry.hasAnyHole) return false;
    const res = this.resolution;
    const minWX = chunkMinWorldX(cx, cfg);
    const minWZ = chunkMinWorldZ(cz, cfg);
    let px = Math.floor(((wx - minWX) / cs) * res);
    let pz = Math.floor(((wz - minWZ) / cs) * res);
    if (px < 0) px = 0; else if (px >= res) px = res - 1;
    if (pz < 0) pz = 0; else if (pz >= res) pz = res - 1;
    return entry.data[(pz * res + px) * 4] >= HAS_ANY_HOLE_THRESHOLD;
  }

  getChunkIndicesInBounds(minX, minZ, maxX, maxZ) {
    const { cx: cx0, cz: cz0 } = worldToChunkIndex(minX, minZ, this.config);
    const { cx: cx1, cz: cz1 } = worldToChunkIndex(maxX, maxZ, this.config);
    const max = getChunkCountPerAxis(this.config) - 1;
    const out = [];
    for (let cz = Math.max(0, cz0); cz <= Math.min(max, cz1); cz++) {
      for (let cx = Math.max(0, cx0); cx <= Math.min(max, cx1); cx++) {
        out.push({ cx, cz });
      }
    }
    return out;
  }

  applyHoleStroke(stroke) {
    const res = this.resolution;
    const cs = this.config.world.chunkSize;
    const pxSize = cs / res;
    const r = stroke.radius;
    const invR = 1 / r;
    const touched = new Set();
    const erase = stroke.erase;

    const chunks = this.getChunkIndicesInBounds(
      stroke.cx - r, stroke.cz - r,
      stroke.cx + r, stroke.cz + r,
    );

    for (const { cx, cz } of chunks) {
      const entry = this.ensureChunk(cx, cz);
      const minWX = chunkMinWorldX(cx, this.config);
      const minWZ = chunkMinWorldZ(cz, this.config);

      const pxMinX = Math.max(0, Math.floor((stroke.cx - r - minWX) / pxSize));
      const pxMaxX = Math.min(res - 1, Math.ceil((stroke.cx + r - minWX) / pxSize));
      const pxMinZ = Math.max(0, Math.floor((stroke.cz - r - minWZ) / pxSize));
      const pxMaxZ = Math.min(res - 1, Math.ceil((stroke.cz + r - minWZ) / pxSize));

      let anyTouched = false;
      const data = entry.data;

      for (let pz = pxMinZ; pz <= pxMaxZ; pz++) {
        const wz = minWZ + (pz + 0.5) * pxSize;
        const dz = wz - stroke.cz;
        for (let px = pxMinX; px <= pxMaxX; px++) {
          const wx = minWX + (px + 0.5) * pxSize;
          const dx = wx - stroke.cx;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > r) continue;
          const t = 1 - d * invR;
          const falloff = Math.pow(t, stroke.falloff);
          const delta = falloff * stroke.strength * 255;
          const idx = (pz * res + px) * 4;

          let v = data[idx];
          v = erase ? Math.max(0, v - delta) : Math.min(255, v + delta);
          data[idx] = v;
          data[idx + 3] = v;
          anyTouched = true;
        }
      }

      if (anyTouched) {
        entry.tex.needsUpdate = true;
        entry.hasAnyHole = computeHasAnyHole(entry.data);
        touched.add(chunkKey(cx, cz));
      }
    }
    return touched;
  }

  /**
   * Paint the hole mask over an arbitrary world-space region. `weightFn(wx, wz)`
   * is evaluated at every texel center inside the bounds and returns 0..1
   * (0 = leave texel untouched, 1 = fully punched). Used by tunnel mode to
   * discard the thin terrain "membrane" strip where the heightfield surface
   * crosses a tube mouth. Additive like a full-strength stroke. Returns the
   * set of touched chunk keys — caller is responsible for marking terrain
   * chunk meshes dirty.
   */
  paintHoleRegion(minX, minZ, maxX, maxZ, weightFn) {
    const res = this.resolution;
    const cs = this.config.world.chunkSize;
    const pxSize = cs / res;
    const touched = new Set();

    for (const { cx, cz } of this.getChunkIndicesInBounds(minX, minZ, maxX, maxZ)) {
      const entry = this.ensureChunk(cx, cz);
      const minWX = chunkMinWorldX(cx, this.config);
      const minWZ = chunkMinWorldZ(cz, this.config);

      const pxMinX = Math.max(0, Math.floor((minX - minWX) / pxSize));
      const pxMaxX = Math.min(res - 1, Math.ceil((maxX - minWX) / pxSize));
      const pxMinZ = Math.max(0, Math.floor((minZ - minWZ) / pxSize));
      const pxMaxZ = Math.min(res - 1, Math.ceil((maxZ - minWZ) / pxSize));

      let anyTouched = false;
      const data = entry.data;

      for (let pz = pxMinZ; pz <= pxMaxZ; pz++) {
        const wz = minWZ + (pz + 0.5) * pxSize;
        for (let px = pxMinX; px <= pxMaxX; px++) {
          const wx = minWX + (px + 0.5) * pxSize;
          const w = weightFn(wx, wz);
          if (w <= 0) continue;
          const idx = (pz * res + px) * 4;
          const v = Math.min(255, Math.max(data[idx], Math.round(w * 255)));
          if (v === data[idx]) continue;
          data[idx] = v;
          data[idx + 3] = v;
          anyTouched = true;
        }
      }

      if (anyTouched) {
        entry.tex.needsUpdate = true;
        entry.hasAnyHole = computeHasAnyHole(entry.data);
        touched.add(chunkKey(cx, cz));
      }
    }
    return touched;
  }

  restoreFromSnapshot(snapshotMap) {
    for (const [key, data] of snapshotMap) {
      let entry = this.chunks.get(key);
      if (!entry) {
        const { cx, cz } = parseChunkKey(key);
        entry = this.ensureChunk(cx, cz);
      }
      entry.data.set(data);
      entry.tex.needsUpdate = true;
      entry.hasAnyHole = computeHasAnyHole(entry.data);
    }
  }

  clearAll() {
    for (const entry of this.chunks.values()) {
      entry.data.fill(0);
      entry.tex.needsUpdate = true;
      entry.hasAnyHole = false;
    }
  }

  exportData() {
    const out = [];
    for (const [key, entry] of this.chunks) {
      const hasData = entry.data.some((v, i) => i % 4 === 0 && v > 0);
      if (!hasData) continue;
      let bin = "";
      for (let i = 0; i < entry.data.length; i++) bin += String.fromCharCode(entry.data[i]);
      out.push({ key, data: btoa(bin) });
    }
    return out.length > 0 ? out : null;
  }

  importData(chunks) {
    if (!chunks) return;
    for (const { key, data: b64 } of chunks) {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const { cx, cz } = parseChunkKey(key);
      const entry = this.ensureChunk(cx, cz);
      entry.data.set(u8.subarray(0, entry.data.length));
      entry.tex.needsUpdate = true;
      entry.hasAnyHole = computeHasAnyHole(entry.data);
    }
  }

  dispose() {
    for (const entry of this.chunks.values()) entry.tex.dispose();
    this.chunks.clear();
  }
}

// Matches the shader's alpha-test threshold (step(0.25, holeTex.r)).
const HAS_ANY_HOLE_THRESHOLD = 64;
function computeHasAnyHole(data) {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= HAS_ANY_HOLE_THRESHOLD) return true;
  }
  return false;
}
