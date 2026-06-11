/**
 * SplatStore — per-chunk dual RGBA splat textures for 8-layer paint mode.
 *
 * Memory model:
 *   - Two 128×128 RGBA8 DataTextures per chunk, created on first paint only.
 *   - splat0 channels R/G/B/A store weights of layers 1/2/3/4 (0..255).
 *   - splat1 channels R/G/B   store weights of layers 5/6/7 (0..255).
 *   - splat1 channel  A       stores meadow density.
 *   - Layer 0 is the implicit base — w0 = 1 - sum(all 7 layers), clamped/normalized in shader.
 *   - Default = all zeros → every chunk shows 100% layer 0 with no allocation cost.
 *
 * activeLayer mapping:
 *   0       = eraser (clears all channels in both buffers)
 *   1..4    = splat0 channels R/G/B/A
 *   5..7    = splat1 channels R/G/B
 *   8       = meadow (splat1.A)
 */
import * as THREE from "three";
import {
  chunkKey,
  chunkMinWorldX,
  chunkMinWorldZ,
  getChunkCountPerAxis,
  parseChunkKey,
  worldToChunkIndex,
} from "../terrain/chunkMath.js";
import { sculptSn2 } from "../terrain/sculptNoiseFbm.js";

function _makeSplatArrayTex(data, res) {
  const tex = new THREE.DataArrayTexture(data, res, res, 2);
  tex.format = THREE.RGBAFormat;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class SplatStore {
  constructor(config) {
    this.config = config;
    this.resolution = config.paint.splatResolution;
    /** @type {Map<string, { data0: Uint8Array, data1: Uint8Array, combinedTex: THREE.DataArrayTexture }>} */
    this.chunks = new Map();
  }

  hasChunkSplat(cx, cz) {
    return this.chunks.has(chunkKey(cx, cz));
  }

  getChunkSplatByKey(key) {
    return this.chunks.get(key) ?? null;
  }

  ensureChunkSplat(cx, cz) {
    const key = chunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing) return existing;

    const res = this.resolution;
    const pixelBytes = res * res * 4;
    const combinedData = new Uint8Array(pixelBytes * 2);
    const data0 = new Uint8Array(combinedData.buffer, 0, pixelBytes);
    const data1 = new Uint8Array(combinedData.buffer, pixelBytes, pixelBytes);
    const combinedTex = _makeSplatArrayTex(combinedData, res);

    const entry = { data0, data1, combinedTex };
    this.chunks.set(key, entry);
    return entry;
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

  /**
   * Paint brush stamp with optional noise mask.
   * @param {object} stroke
   * @param {number} stroke.cx - brush center world X
   * @param {number} stroke.cz - brush center world Z
   * @param {number} stroke.radius
   * @param {number} stroke.strength - 0..1
   * @param {number} stroke.falloff
   * @param {number} stroke.activeLayer - 0=eraser, 1..7=overlay, 8=meadow
   * @param {number} [stroke.noiseMask=0]
   * @param {number} [stroke.noiseScale=3]
   * @param {number} [stroke.noiseOctaves=3]
   * @param {boolean} [stroke.noiseEdgeOnly=false]
   * @param {Float32Array} [stroke.maskData=null]
   * @param {number} [stroke.maskSize=0]
   * @param {number} [stroke.maskRotation=0]
   * @returns {Set<string>}
   */
  applySplatStroke(stroke) {
    const res = this.resolution;
    const cs = this.config.world.chunkSize;
    const pxSize = cs / res;
    const r = stroke.radius;
    const invR = 1 / r;
    const touched = new Set();

    const noiseMask = stroke.noiseMask ?? 0;
    const noiseScale = stroke.noiseScale ?? 3;
    const noiseOctaves = Math.round(stroke.noiseOctaves ?? 3);
    const noiseEdgeOnly = stroke.noiseEdgeOnly ?? false;

    const maskData = stroke.maskData ?? null;
    const maskSize = stroke.maskSize ?? 0;
    const maskRot = stroke.maskRotation ?? 0;
    const maskCos = maskData ? Math.cos(maskRot) : 1;
    const maskSin = maskData ? Math.sin(maskRot) : 0;
    const invDiameter = 1 / (2 * r);

    const activeLayer = stroke.activeLayer;
    const isEraser = activeLayer === 0;

    // Map activeLayer → which buffer + channel
    let targetBuf = 0; // 0 = data0, 1 = data1
    let targetChan = 0;
    if (!isEraser) {
      if (activeLayer <= 4) {
        targetBuf = 0;
        targetChan = activeLayer - 1;
      } else {
        targetBuf = 1;
        targetChan = activeLayer - 5;
      }
    }

    const chunks = this.getChunkIndicesInBounds(
      stroke.cx - r,
      stroke.cz - r,
      stroke.cx + r,
      stroke.cz + r,
    );

    for (const { cx, cz } of chunks) {
      const entry = this.ensureChunkSplat(cx, cz);
      const minWX = chunkMinWorldX(cx, this.config);
      const minWZ = chunkMinWorldZ(cz, this.config);

      const pxMinX = Math.max(0, Math.floor((stroke.cx - r - minWX) / pxSize));
      const pxMaxX = Math.min(res - 1, Math.ceil((stroke.cx + r - minWX) / pxSize));
      const pxMinZ = Math.max(0, Math.floor((stroke.cz - r - minWZ) / pxSize));
      const pxMaxZ = Math.min(res - 1, Math.ceil((stroke.cz + r - minWZ) / pxSize));

      let anyTouched = false;
      const d0 = entry.data0;
      const d1 = entry.data1;

      for (let pz = pxMinZ; pz <= pxMaxZ; pz++) {
        const wz = minWZ + (pz + 0.5) * pxSize;
        const dz = wz - stroke.cz;
        for (let px = pxMinX; px <= pxMaxX; px++) {
          const wx = minWX + (px + 0.5) * pxSize;
          const dx = wx - stroke.cx;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (!maskData && d > r) continue;
          const t = Math.max(0, 1 - d * invR);

          let falloff;
          if (maskData) {
            const rx = dx * maskCos - dz * maskSin;
            const rz = dx * maskSin + dz * maskCos;
            const mu = rx * invDiameter + 0.5;
            const mv = rz * invDiameter + 0.5;
            if (mu < 0 || mu > 1 || mv < 0 || mv > 1) continue;
            const maskVal = _sampleMask(maskData, maskSize, mu, mv);
            if (maskVal <= 0.001) continue;
            falloff = maskVal;
          } else {
            falloff = Math.pow(t, stroke.falloff);
          }

          if (noiseMask > 0) {
            let n = _fbmNoise(wx * noiseScale, wz * noiseScale, noiseOctaves);
            if (noiseEdgeOnly) {
              const edgeFactor = 1 - t;
              n = 1 - edgeFactor * (1 - n) * noiseMask;
            } else {
              n = n * noiseMask + (1 - noiseMask);
            }
            falloff *= Math.max(0, n);
          }

          const w = falloff * stroke.strength;
          if (w <= 0) continue;
          const delta = w * 255;
          const idx = (pz * res + px) * 4;

          if (isEraser) {
            d0[idx] = Math.max(0, d0[idx] - delta);
            d0[idx + 1] = Math.max(0, d0[idx + 1] - delta);
            d0[idx + 2] = Math.max(0, d0[idx + 2] - delta);
            d0[idx + 3] = Math.max(0, d0[idx + 3] - delta);
            d1[idx] = Math.max(0, d1[idx] - delta);
            d1[idx + 1] = Math.max(0, d1[idx + 1] - delta);
            d1[idx + 2] = Math.max(0, d1[idx + 2] - delta);
            d1[idx + 3] = Math.max(0, d1[idx + 3] - delta);
          } else {
            const buf = targetBuf === 0 ? d0 : d1;
            buf[idx + targetChan] = Math.min(255, buf[idx + targetChan] + delta);
          }
          anyTouched = true;
        }
      }

      if (anyTouched) {
        entry.combinedTex.needsUpdate = true;
        touched.add(chunkKey(cx, cz));
      }
    }
    return touched;
  }

  /** Snapshot both buffers for undo. */
  snapshotChunks(keys) {
    const snap = new Map();
    for (const key of keys) {
      const entry = this.chunks.get(key);
      if (entry) {
        snap.set(key, {
          d0: new Uint8Array(entry.data0),
          d1: new Uint8Array(entry.data1),
        });
      }
    }
    return snap;
  }

  /** Restore from snapshot (dual-buffer format). */
  restoreFromSnapshot(snapshotMap) {
    for (const [key, snap] of snapshotMap) {
      let entry = this.chunks.get(key);
      if (!entry) {
        const { cx, cz } = parseChunkKey(key);
        entry = this.ensureChunkSplat(cx, cz);
      }
      if (snap.d0) {
        entry.data0.set(snap.d0);
      } else if (snap instanceof Uint8Array) {
        entry.data0.set(snap);
      }
      if (snap.d1) {
        entry.data1.set(snap.d1);
      }
      entry.combinedTex.needsUpdate = true;
    }
  }

  clearAll() {
    for (const entry of this.chunks.values()) {
      entry.data0.fill(0);
      entry.data1.fill(0);
      entry.combinedTex.needsUpdate = true;
    }
  }

  fillAllWithLayer(activeLayer) {
    for (const entry of this.chunks.values()) {
      if (activeLayer === 0) {
        entry.data0.fill(0);
        entry.data1.fill(0);
      } else {
        entry.data0.fill(0);
        entry.data1.fill(0);

        let buf, chan;
        if (activeLayer <= 4) {
          buf = entry.data0;
          chan = activeLayer - 1;
        } else {
          buf = entry.data1;
          chan = activeLayer - 5;
        }
        for (let i = 0; i < buf.length; i += 4) {
          buf[i + chan] = 255;
        }
      }
      entry.combinedTex.needsUpdate = true;
    }
  }

  dispose() {
    for (const entry of this.chunks.values()) {
      entry.combinedTex.dispose();
    }
    this.chunks.clear();
  }
}

function _sampleMask(data, size, u, v) {
  const fx = u * (size - 1);
  const fy = v * (size - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, size - 1);
  const y1 = Math.min(y0 + 1, size - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  return (
    data[y0 * size + x0] * (1 - tx) * (1 - ty) +
    data[y0 * size + x1] * tx * (1 - ty) +
    data[y1 * size + x0] * (1 - tx) * ty +
    data[y1 * size + x1] * tx * ty
  );
}

function _fbmNoise(x, y, octaves) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let m = 0;
  for (let i = 0; i < octaves; i++) {
    s += sculptSn2(x * f, y * f) * a;
    m += a;
    a *= 0.5;
    f *= 2;
  }
  return m > 0 ? s / m : 0;
}
