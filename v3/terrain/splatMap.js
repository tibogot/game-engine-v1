/**
 * SplatMap — single-texture splat storage for V3's chunkless terrain.
 *
 * Uses one 512×512×2 DataArrayTexture covering the entire 2048m world (4m/texel).
 * Same layer encoding as V2's SplatStore:
 *   slice 0: R=L1, G=L2, B=L3, A=L4
 *   slice 1: R=L5, G=L6, B=L7, A=meadow
 *   Layer 0 (base) is implicit: w0 = max(0, 1 – sum(L1..L7))
 *
 * activeLayer mapping:
 *   0       = eraser
 *   1..4    = slice0 R/G/B/A
 *   5..7    = slice1 R/G/B
 *   8       = meadow (slice1.A)
 *
 * The API is tile-ready: the backing storage can be replaced with chunked
 * tiles for larger worlds without changing the shader or UI.
 */
import * as THREE from "three";
import { WORLD_SIZE, SPLAT_SIZE } from "./heightmapTexture.js";

// Configured independently of the heightmap (see heightmapTexture.js). Old
// configs with no splatSize resolve to the previous half-heightmap value.
export const SPLAT_RES = SPLAT_SIZE;

function _makeDataArrayTex(data) {
  const tex = new THREE.DataArrayTexture(data, SPLAT_RES, SPLAT_RES, 2);
  tex.format    = THREE.RGBAFormat;
  tex.wrapS     = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ── simple value-noise FBM for noise mask (CPU-side) ──────────────────────────
function _hash(a, b) {
  let n = (a * 1619 + b * 31337) & 0x7fffffff;
  n = (n >> 13) ^ n;
  return (((n * (n * n * 60493 + 19990303) + 1376312589) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
}
function _vn(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix,       fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return (_hash(ix,iy)*(1-ux)+_hash(ix+1,iy)*ux)*(1-uy)
       + (_hash(ix,iy+1)*(1-ux)+_hash(ix+1,iy+1)*ux)*uy;
}
function _fbmNoise(x, y, octaves) {
  let s = 0, a = 0.5, f = 1, m = 0;
  for (let i = 0; i < octaves; i++) { s += _vn(x*f, y*f)*a; m += a; a *= 0.5; f *= 2; }
  return m > 0 ? (s / m) * 0.5 + 0.5 : 0.5;
}
function _sampleMask(data, size, u, v) {
  const fx = u*(size-1), fy = v*(size-1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0+1,size-1), y1 = Math.min(y0+1,size-1);
  const tx = fx-x0, ty = fy-y0;
  return data[y0*size+x0]*(1-tx)*(1-ty)+data[y0*size+x1]*tx*(1-ty)
       + data[y1*size+x0]*(1-tx)*ty    +data[y1*size+x1]*tx*ty;
}

export class SplatMap {
  constructor() {
    const bytes      = SPLAT_RES * SPLAT_RES * 4;
    this._combined   = new Uint8Array(bytes * 2);
    this.data0       = new Uint8Array(this._combined.buffer, 0,     bytes);
    this.data1       = new Uint8Array(this._combined.buffer, bytes, bytes);
    this.tex         = _makeDataArrayTex(this._combined);
  }

  applySplatStroke(stroke) {
    const r         = stroke.radius;
    const invR      = 1 / r;
    const pxSize    = WORLD_SIZE / SPLAT_RES;
    const noiseMask = stroke.noiseMask    ?? 0;
    const noiseScale= stroke.noiseScale   ?? 3;
    const noiseOcts = Math.round(stroke.noiseOctaves ?? 3);
    const noiseEdge = stroke.noiseEdgeOnly ?? false;
    const maskData  = stroke.maskData     ?? null;
    const maskSize  = stroke.maskSize     ?? 0;
    const maskRot   = stroke.maskRotation ?? 0;
    const maskCos   = maskData ? Math.cos(maskRot) : 1;
    const maskSin   = maskData ? Math.sin(maskRot) : 0;
    const invDiam   = 1 / (2 * r);

    const activeLayer = stroke.activeLayer;
    const isEraser    = activeLayer === 0;
    let targetBuf = 0, targetChan = 0;
    if (!isEraser) {
      if (activeLayer <= 4) { targetBuf = 0; targetChan = activeLayer - 1; }
      else                  { targetBuf = 1; targetChan = activeLayer - 5; }
    }

    const half = WORLD_SIZE * 0.5;
    const u0 = Math.max(0,          Math.floor(((stroke.cx - r) + half) / WORLD_SIZE * SPLAT_RES));
    const u1 = Math.min(SPLAT_RES-1, Math.ceil(((stroke.cx + r) + half) / WORLD_SIZE * SPLAT_RES));
    const v0 = Math.max(0,          Math.floor(((stroke.cz - r) + half) / WORLD_SIZE * SPLAT_RES));
    const v1 = Math.min(SPLAT_RES-1, Math.ceil(((stroke.cz + r) + half) / WORLD_SIZE * SPLAT_RES));

    let anyTouched = false;
    const d0 = this.data0, d1 = this.data1;

    for (let pz = v0; pz <= v1; pz++) {
      const wz = (pz + 0.5) * pxSize - half;
      const dz = wz - stroke.cz;
      for (let px = u0; px <= u1; px++) {
        const wx = (px + 0.5) * pxSize - half;
        const dx = wx - stroke.cx;
        const d  = Math.sqrt(dx*dx + dz*dz);

        let falloff;
        if (maskData) {
          const rx  = dx*maskCos - dz*maskSin;
          const rz  = dx*maskSin + dz*maskCos;
          const mu  = rx*invDiam + 0.5;
          const mv  = rz*invDiam + 0.5;
          if (mu < 0 || mu > 1 || mv < 0 || mv > 1) continue;
          falloff = _sampleMask(maskData, maskSize, mu, mv);
          if (falloff <= 0.001) continue;
        } else {
          if (d > r) continue;
          falloff = Math.pow(Math.max(0, 1 - d*invR), stroke.falloff);
        }

        if (noiseMask > 0) {
          let n = _fbmNoise(wx*noiseScale, wz*noiseScale, noiseOcts);
          if (noiseEdge) {
            const t = Math.max(0, 1 - d*invR);
            n = 1 - (1-t)*(1-n)*noiseMask;
          } else {
            n = n*noiseMask + (1-noiseMask);
          }
          falloff *= Math.max(0, n);
        }

        const w     = falloff * stroke.strength;
        if (w <= 0) continue;
        const delta = w * 255;
        const idx   = (pz * SPLAT_RES + px) * 4;

        if (isEraser) {
          d0[idx]   = Math.max(0, d0[idx]   - delta);
          d0[idx+1] = Math.max(0, d0[idx+1] - delta);
          d0[idx+2] = Math.max(0, d0[idx+2] - delta);
          d0[idx+3] = Math.max(0, d0[idx+3] - delta);
          d1[idx]   = Math.max(0, d1[idx]   - delta);
          d1[idx+1] = Math.max(0, d1[idx+1] - delta);
          d1[idx+2] = Math.max(0, d1[idx+2] - delta);
          d1[idx+3] = Math.max(0, d1[idx+3] - delta);
        } else if (activeLayer === 8) {
          // Meadow is an overlay mask, not part of the 7-weight blend —
          // lerp it toward 1 without disturbing the paint layers.
          const buf = d1;
          const t   = buf[idx + targetChan] / 255;
          buf[idx + targetChan] = Math.min(255, ((t + w * (1 - t)) * 255 + 0.5) | 0);
        } else {
          // Unity/Unreal-style weight painting: lerp the target layer toward
          // full weight and scale every other layer down to make room, so
          // strength 1 fully REPLACES what's underneath instead of blending
          // 50/50 forever (weights behave as if they always sum to 1).
          const buf  = targetBuf === 0 ? d0 : d1;
          const s    = Math.min(1, w);
          const t    = buf[idx + targetChan] / 255;
          const tNew = t + s * (1 - t);
          const k    = (1 - t) > 1e-4 ? (1 - tNew) / (1 - t) : 0;
          for (let c = 0; c < 4; c++) {
            if (targetBuf === 0 && c === targetChan) continue;
            d0[idx + c] = (d0[idx + c] * k + 0.5) | 0;
          }
          for (let c = 0; c < 3; c++) { // slice1 alpha (meadow) stays untouched
            if (targetBuf === 1 && c === targetChan) continue;
            d1[idx + c] = (d1[idx + c] * k + 0.5) | 0;
          }
          buf[idx + targetChan] = Math.min(255, (tNew * 255 + 0.5) | 0);
        }
        anyTouched = true;
      }
    }

    if (anyTouched) {
      // Weight painting rescales channels in BOTH slices; only the meadow
      // overlay stays confined to slice 1.
      if (activeLayer === 8) {
        this.tex.addLayerUpdate(1);
      } else {
        this.tex.addLayerUpdate(0);
        this.tex.addLayerUpdate(1);
      }
      this.tex.needsUpdate = true;
    }
    // Touched rect in splat texel coords — used for rect-based undo entries.
    return anyTouched ? { x: u0, y: v0, w: u1 - u0 + 1, h: v1 - v0 + 1 } : null;
  }

  /** Copy a sub-rect of both slices (undo storage — ~rect-sized, not map-sized). */
  copyRect(rect, srcD0 = this.data0, srcD1 = this.data1) {
    const { x, y, w, h } = rect;
    const d0 = new Uint8Array(w * h * 4);
    const d1 = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const src = ((y + row) * SPLAT_RES + x) * 4;
      const dst = row * w * 4;
      d0.set(srcD0.subarray(src, src + w * 4), dst);
      d1.set(srcD1.subarray(src, src + w * 4), dst);
    }
    return { x, y, w, h, d0, d1 };
  }

  /** Write a copyRect() patch back into the live splat data. */
  pasteRect(patch) {
    const { x, y, w, h, d0, d1 } = patch;
    for (let row = 0; row < h; row++) {
      const dst = ((y + row) * SPLAT_RES + x) * 4;
      const src = row * w * 4;
      this.data0.set(d0.subarray(src, src + w * 4), dst);
      this.data1.set(d1.subarray(src, src + w * 4), dst);
    }
    this.tex.addLayerUpdate(0);
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
  }

  /** Both slices as one contiguous buffer (project save / splat export). */
  get combined() { return this._combined; }

  /** Replace all splat data (project load). Requires SPLAT_RES-sized input. */
  setCombined(bytes) {
    this._combined.set(bytes);
    this.tex.addLayerUpdate(0);
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
  }

  /**
   * Replace all splat data from a DIFFERENT resolution, rescaling both slices.
   * Splat channels are blend weights over the same world extent, so rescaling is
   * a plain image resize — this is what lets a project painted at one splat
   * resolution open at another without losing the paint.
   */
  setCombinedResampled(bytes, srcRes) {
    if (srcRes === SPLAT_RES) return this.setCombined(bytes);
    const sliceBytes = srcRes * srcRes * 4;
    if (bytes.byteLength < sliceBytes * 2) {
      throw new Error(`Splat data is too small for a ${srcRes}² source.`);
    }
    const src = bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    _resampleRGBA8(src.subarray(0, sliceBytes),              srcRes, this.data0, SPLAT_RES);
    _resampleRGBA8(src.subarray(sliceBytes, sliceBytes * 2), srcRes, this.data1, SPLAT_RES);
    this.tex.addLayerUpdate(0);
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
  }

  snapshot() {
    return { d0: new Uint8Array(this.data0), d1: new Uint8Array(this.data1) };
  }

  restoreSnapshot(snap) {
    this.data0.set(snap.d0);
    this.data1.set(snap.d1);
    this.tex.needsUpdate = true;
  }

  clearAll() {
    this.data0.fill(0);
    this.data1.fill(0);
    this.tex.needsUpdate = true;
  }

  fillAllWithLayer(activeLayer) {
    this.data0.fill(0);
    this.data1.fill(0);
    if (activeLayer === 0) { this.tex.needsUpdate = true; return; }
    let buf, chan;
    if (activeLayer <= 4) { buf = this.data0; chan = activeLayer - 1; }
    else                  { buf = this.data1; chan = activeLayer - 5; }
    for (let i = 0; i < buf.length; i += 4) buf[i + chan] = 255;
    this.tex.needsUpdate = true;
  }

  /**
   * Bake the auto-paint rules into the splatmap (replaces all paint layers;
   * meadow overlay untouched). Same model as the live shader auto-material:
   * cliff layer past a slope band, optional high-altitude layer above a height
   * band, flat layer as the remainder — with FBM threshold breakup.
   *
   * @param {{
   *   cpuHeightmap: Float32Array, heightmapSize: number,
   *   worldSize: number, maxHeight: number,
   *   params: { flat:number, cliff:number, high:number,
   *             slopeStartDeg:number, slopeEndDeg:number,
   *             highStart:number, highEnd:number, noise:number }
   * }} opts
   */
  applyAutoRules({ cpuHeightmap, heightmapSize, worldSize, maxHeight, params }) {
    const { flat, cliff, high, slopeStartDeg, slopeEndDeg, highStart, highEnd, noise } = params;
    const d0 = this.data0, d1 = this.data1;
    const half = worldSize * 0.5;

    const write = (idx, layer, w) => {
      if (layer < 0 || layer > 6 || w <= 0) return;
      const b = layer < 4 ? d0 : d1;
      const c = layer < 4 ? layer : layer - 4;
      b[idx + c] = Math.min(255, b[idx + c] + ((w * 255 + 0.5) | 0));
    };

    for (let pz = 0; pz < SPLAT_RES; pz++) {
      const sv = (pz + 0.5) / SPLAT_RES;
      for (let px = 0; px < SPLAT_RES; px++) {
        const su  = (px + 0.5) / SPLAT_RES;
        const idx = (pz * SPLAT_RES + px) * 4;

        // Clear the 7 weight channels (keep meadow d1[idx+3]).
        d0[idx] = d0[idx+1] = d0[idx+2] = d0[idx+3] = 0;
        d1[idx] = d1[idx+1] = d1[idx+2] = 0;

        const slopeD = _slopeDegs(cpuHeightmap, heightmapSize, su, sv, worldSize, maxHeight);
        const hM     = _sampleHm(cpuHeightmap, heightmapSize, su, sv) * maxHeight;
        const wx = su * worldSize - half;
        const wz = sv * worldSize - half;
        const br = (_fbmNoise(wx * 0.02, wz * 0.02, 3) - 0.5) * 2 * noise; // ≈ ±noise

        const cliffW = _smoothstep(slopeStartDeg, slopeEndDeg, slopeD + br * 12);
        const highW  = high >= 0
          ? _smoothstep(highStart, highEnd, hM + br * 40) * (1 - cliffW)
          : 0;
        const flatW  = 1 - cliffW - highW;

        write(idx, cliff, cliffW);
        write(idx, high, highW);
        write(idx, flat, flatW);
      }
    }
    this.tex.addLayerUpdate(0);
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
  }
}

// ── Resampling ────────────────────────────────────────────────────────────────

/**
 * Resize one RGBA8 slice. Upsampling uses bilinear (smooth weight ramps);
 * downsampling box-averages the source footprint so shrinking does not alias
 * thin painted strokes away. Both preserve the weight sum at each texel.
 */
function _resampleRGBA8(src, srcRes, dst, dstRes) {
  const scale = srcRes / dstRes;

  if (dstRes < srcRes) {
    for (let dy = 0; dy < dstRes; dy++) {
      const sy0 = Math.floor(dy * scale);
      const sy1 = Math.min(srcRes, Math.max(sy0 + 1, Math.ceil((dy + 1) * scale)));
      for (let dx = 0; dx < dstRes; dx++) {
        const sx0 = Math.floor(dx * scale);
        const sx1 = Math.min(srcRes, Math.max(sx0 + 1, Math.ceil((dx + 1) * scale)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          let si = (sy * srcRes + sx0) * 4;
          for (let sx = sx0; sx < sx1; sx++, si += 4) {
            r += src[si]; g += src[si+1]; b += src[si+2]; a += src[si+3]; n++;
          }
        }
        const di = (dy * dstRes + dx) * 4;
        dst[di]   = (r / n + 0.5) | 0;
        dst[di+1] = (g / n + 0.5) | 0;
        dst[di+2] = (b / n + 0.5) | 0;
        dst[di+3] = (a / n + 0.5) | 0;
      }
    }
    return;
  }

  const max = srcRes - 1;
  for (let dy = 0; dy < dstRes; dy++) {
    const fy = Math.min(max, Math.max(0, (dy + 0.5) * scale - 0.5));
    const y0 = fy | 0, y1 = Math.min(y0 + 1, max), ty = fy - y0;
    for (let dx = 0; dx < dstRes; dx++) {
      const fx = Math.min(max, Math.max(0, (dx + 0.5) * scale - 0.5));
      const x0 = fx | 0, x1 = Math.min(x0 + 1, max), tx = fx - x0;
      const i00 = (y0 * srcRes + x0) * 4, i10 = (y0 * srcRes + x1) * 4;
      const i01 = (y1 * srcRes + x0) * 4, i11 = (y1 * srcRes + x1) * 4;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty,       w11 = tx * ty;
      const di = (dy * dstRes + dx) * 4;
      for (let c = 0; c < 4; c++) {
        dst[di + c] = (src[i00+c]*w00 + src[i10+c]*w10
                     + src[i01+c]*w01 + src[i11+c]*w11 + 0.5) | 0;
      }
    }
  }
}

// ── Auto-rule helpers ─────────────────────────────────────────────────────────

function _sampleHm(hm, size, u, v) {
  const fu = Math.max(0, Math.min(0.9999, u)) * (size - 1);
  const fv = Math.max(0, Math.min(0.9999, v)) * (size - 1);
  const x0 = fu | 0, y0 = fv | 0;
  const x1 = Math.min(x0 + 1, size - 1), y1 = Math.min(y0 + 1, size - 1);
  const tx = fu - x0, ty = fv - y0;
  return hm[y0*size+x0]*(1-tx)*(1-ty) + hm[y0*size+x1]*tx*(1-ty)
       + hm[y1*size+x0]*(1-tx)*ty     + hm[y1*size+x1]*tx*ty;
}

function _slopeDegs(hm, size, u, v, worldSize, maxHeight) {
  const s  = 1 / size;
  const tw = worldSize / size;                           // world units per heightmap texel
  const gx = (_sampleHm(hm, size, u+s, v) - _sampleHm(hm, size, u-s, v)) * maxHeight / (2*tw);
  const gz = (_sampleHm(hm, size, u, v+s) - _sampleHm(hm, size, u, v-s)) * maxHeight / (2*tw);
  return Math.acos(Math.min(1, 1 / Math.sqrt(1 + gx*gx + gz*gz))) * (180 / Math.PI);
}

function _smoothstep(e0, e1, x) {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
