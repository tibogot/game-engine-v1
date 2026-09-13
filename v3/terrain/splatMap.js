/**
 * SplatMap — single-texture splat storage for V3's chunkless terrain.
 *
 * Uses one 512×512×2 DataArrayTexture covering the entire 2048m world (4m/texel).
 * Same layer encoding as V2's SplatStore:
 *   slice 0: R=L1, G=L2, B=L3, A=L4
 *   slice 1: R=L5, G=L6, B=L7, A=TERRAIN HOLES (was the retired Meadow mask)
 *   Layer 0 (base) is implicit: w0 = max(0, 1 – sum(L1..L7))
 *
 * activeLayer mapping:
 *   0       = eraser
 *   1..4    = slice0 R/G/B/A
 *   5..7    = slice1 R/G/B
 *   8       = hole  (slice1.A lerped toward 1)
 *  -8       = hole erase (slice1.A lerped toward 0) — the hole card with Alt
 *
 * HOLES live in the channel Meadow freed, so the terrain shader reads them
 * through the splat texture it already binds (the fragment stage is at
 * WebGPU's 16-sampler ceiling). They are NOT paint: the eraser, Clear and Fill
 * leave them alone, and hasAnyPaint() ignores them so a hole never switches the
 * paint shader branch on by itself.
 *
 * Two SOURCES feed that one channel, and slice1.A is always max(user, proc):
 *   holeUser — painted with the Hole card. Saved, undone with paint.
 *   holeProc — owned by tools (tunnels). Rebuilt from their own data, never
 *              saved. Kept apart so moving or deleting a tunnel can clear its
 *              old opening without erasing a hole someone painted nearby.
 *
 * The API is tile-ready: the backing storage can be replaced with chunked
 * tiles for larger worlds without changing the shader or UI.
 */
import * as THREE from "three";
import { WORLD_SIZE, SPLAT_SIZE } from "./heightmapTexture.js";
import { concavityMaskCpu } from "../ui/brushFilterSection.js";

// Configured independently of the heightmap (see heightmapTexture.js). Old
// configs with no splatSize resolve to the previous half-heightmap value.
export const SPLAT_RES = SPLAT_SIZE;

export const HOLE_LAYER = 8;
export const HOLE_ERASE_LAYER = -8;

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
    // hasAnyPaint() cache — drives the terrain shader's uHasPaint branch gate.
    this._hasPaint      = false; // buffers start zeroed
    this._hasPaintDirty = false;
    this._combinedU32   = new Uint32Array(this._combined.buffer);
    // hasAnyHoles() cache — decides whether the terrain compiles its hole mask.
    this._hasHoles      = false;
    this._holesDirty    = false;
    // Hole sources, one byte per texel (see the header). slice1.A = max of both.
    this.holeUser       = new Uint8Array(SPLAT_RES * SPLAT_RES);
    this.holeProc       = new Uint8Array(SPLAT_RES * SPLAT_RES);
  }

  /** slice1.A = max(user, proc) over a texel rect (inclusive), marks the flag stale. */
  _composeHoles(x0 = 0, y0 = 0, x1 = SPLAT_RES - 1, y1 = SPLAT_RES - 1) {
    const d1 = this.data1, u = this.holeUser, p = this.holeProc;
    for (let y = y0; y <= y1; y++) {
      let i = y * SPLAT_RES + x0;
      for (let x = x0; x <= x1; x++, i++) {
        d1[(i << 2) + 3] = u[i] > p[i] ? u[i] : p[i];
      }
    }
    this._holesDirty = true;
  }

  /** Take the user hole source from the alpha of slice 1 (after a bulk load). */
  _userHolesFromAlpha() {
    const d1 = this.data1, u = this.holeUser;
    for (let i = 0; i < u.length; i++) u[i] = d1[(i << 2) + 3];
  }

  /**
   * Replace the TOOL hole source (tunnels). `bytes` is SPLAT_RES² (0..255), or
   * null to clear it. Recomposes the channel and uploads slice 1.
   */
  setProcHoles(bytes) {
    if (bytes) this.holeProc.set(bytes); else this.holeProc.fill(0);
    this._composeHoles();
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
  }

  /** Replace the USER hole source (e.g. keep holes across a splatmap import). */
  setUserHoles(bytes) {
    this.holeUser.set(bytes);
    this._composeHoles();
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
  }

  /**
   * Both slices as one buffer for SAVING: a copy whose hole channel holds only
   * the USER holes. Tool holes are rebuilt from the tools' own saved data, so
   * writing them here would bake a tunnel's opening in forever.
   */
  exportCombined() {
    const out = this._combined.slice();
    const off = SPLAT_RES * SPLAT_RES * 4, u = this.holeUser;
    for (let i = 0; i < u.length; i++) out[off + (i << 2) + 3] = u[i];
    return out;
  }

  /** Mark every derived flag stale after a bulk write. */
  _markDirty() {
    this._hasPaintDirty = true;
    this._holesDirty = true;
  }

  /** True if any texel of the hole channel (slice1.A) is non-zero. Cached. */
  hasAnyHoles() {
    if (this._holesDirty) {
      this._holesDirty = false;
      this._hasHoles = false;
      const d1 = this.data1;
      for (let i = 3; i < d1.length; i += 4) {
        if (d1[i] !== 0) { this._hasHoles = true; break; }
      }
    }
    return this._hasHoles;
  }

  /**
   * Hole amount 0..1 at a world position, bilinear on texel centres — the same
   * sampling the terrain shader does, so "a hole here" means the same on the
   * CPU (collision, placement) as on screen (the shader cuts at 0.5).
   */
  holeAt(wx, wz) {
    if (!this.hasAnyHoles()) return 0;
    const fx = (wx + WORLD_SIZE * 0.5) / WORLD_SIZE * SPLAT_RES - 0.5;
    const fz = (wz + WORLD_SIZE * 0.5) / WORLD_SIZE * SPLAT_RES - 0.5;
    if (fx < -0.5 || fz < -0.5 || fx > SPLAT_RES - 0.5 || fz > SPLAT_RES - 0.5) return 0;
    const x0 = Math.max(0, Math.min(SPLAT_RES - 1, Math.floor(fx)));
    const z0 = Math.max(0, Math.min(SPLAT_RES - 1, Math.floor(fz)));
    const x1 = Math.min(SPLAT_RES - 1, x0 + 1), z1 = Math.min(SPLAT_RES - 1, z0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0)), tz = Math.max(0, Math.min(1, fz - z0));
    const d1 = this.data1;
    const a = d1[(z0 * SPLAT_RES + x0) * 4 + 3], b = d1[(z0 * SPLAT_RES + x1) * 4 + 3];
    const c = d1[(z1 * SPLAT_RES + x0) * 4 + 3], d = d1[(z1 * SPLAT_RES + x1) * 4 + 3];
    return ((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz) / 255;
  }

  /** Zero the USER holes (legacy files whose alpha was Meadow paint). Tool holes stay. */
  clearHoleChannel() {
    this.holeUser.fill(0);
    this._composeHoles();
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
    this._markDirty();
  }

  /**
   * True if any paint WEIGHT is non-zero (holes excluded). Cached; mutators mark
   * it dirty and the next call rescans (u32-wide, early-exit — sub-ms worst case).
   */
  hasAnyPaint() {
    if (this._hasPaintDirty) {
      this._hasPaintDirty = false;
      this._hasPaint = false;
      const u32 = this._combinedU32;
      const half = u32.length >> 1;
      for (let i = 0; i < half; i++) {
        if (u32[i] !== 0) { this._hasPaint = true; break; }
      }
      // Slice 1: R,G,B only. Little-endian u32 of RGBA bytes is A<<24|B<<16|G<<8|R.
      if (!this._hasPaint) {
        for (let i = half; i < u32.length; i++) {
          if ((u32[i] & 0x00ffffff) !== 0) { this._hasPaint = true; break; }
        }
      }
    }
    return this._hasPaint;
  }

  /**
   * Summed painted weight (0..1) of the flagged layers at a world position —
   * nearest texel. `flags[i]` is layer i+1 (L1..L7). Used to keep trees and
   * foliage off layers that block them, e.g. a path.
   */
  flaggedWeightAt(wx, wz, flags) {
    const half = WORLD_SIZE * 0.5;
    const px = Math.floor((wx + half) / WORLD_SIZE * SPLAT_RES);
    const pz = Math.floor((wz + half) / WORLD_SIZE * SPLAT_RES);
    if (px < 0 || pz < 0 || px >= SPLAT_RES || pz >= SPLAT_RES) return 0;
    const i = (pz * SPLAT_RES + px) * 4;
    let w = 0;
    for (let l = 0; l < 4; l++) if (flags[l]) w += this.data0[i + l];
    for (let l = 4; l < 7; l++) if (flags[l]) w += this.data1[i + l - 4];
    return Math.min(1, w / 255);
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
    // Brush filter (height / slope band / concavity). Null unless one is actually
    // on, so the loop below is the exact old code path when filters are off.
    const flt = stroke.filter && stroke.filter.hm
      && (stroke.filter.heightOn || stroke.filter.slopeOn || stroke.filter.concavityOn)
      ? stroke.filter
      : null;

    const activeLayer = stroke.activeLayer;
    const isEraser    = activeLayer === 0;
    const isHoleOp    = activeLayer === HOLE_LAYER || activeLayer === HOLE_ERASE_LAYER;
    let targetBuf = 0, targetChan = 0;
    if (!isEraser && !isHoleOp) {
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
    const hU = this.holeUser, hP = this.holeProc;

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

        if (flt) {
          // Same band shape as the sculpt filter in sculptBrush.js: full effect
          // inside [min, max], fading over `soft` outside it.
          const su = (px + 0.5) / SPLAT_RES;
          const sv = (pz + 0.5) / SPLAT_RES;
          let m = 1;
          if (flt.heightOn) {
            const hM = _sampleHm(flt.hm, flt.hmSize, su, sv) * flt.maxHeight;
            m *= _bandMask(hM, flt.heightMin, flt.heightMax, flt.heightSoft);
          }
          if (m > 0 && flt.slopeOn) {
            const sD = _slopeDegs(flt.hm, flt.hmSize, su, sv, flt.worldSize, flt.maxHeight);
            m *= _bandMask(sD, flt.slopeMin, flt.slopeMax, flt.slopeSoft);
          }
          if (m > 0 && flt.concavityOn) {
            // Same maths as the sculpt filter (sculptBrush.js filterMask).
            const r = flt.concavityRadius / flt.worldSize, rd = r * Math.SQRT1_2;
            const hm = flt.hm, n = flt.hmSize;
            const ring = (_sampleHm(hm, n, su + r, sv) + _sampleHm(hm, n, su - r, sv)
              + _sampleHm(hm, n, su, sv + r) + _sampleHm(hm, n, su, sv - r)
              + _sampleHm(hm, n, su + rd, sv + rd) + _sampleHm(hm, n, su - rd, sv + rd)
              + _sampleHm(hm, n, su + rd, sv - rd) + _sampleHm(hm, n, su - rd, sv - rd)) * 0.125;
            const depth = (ring - _sampleHm(hm, n, su, sv)) * flt.maxHeight;
            m *= concavityMaskCpu(depth, flt.concavityMode, flt.concavityMin, flt.concavitySoft);
          }
          falloff *= m;
          if (falloff <= 0) continue;
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
          // d1[idx+3] is the HOLE channel: the paint eraser leaves holes alone.
        } else if (activeLayer === HOLE_LAYER || activeLayer === HOLE_ERASE_LAYER) {
          // Holes are a mask, not part of the 7-weight blend: lerp the USER
          // source toward 1 (hole) or 0 (fill), then recompose with tool holes —
          // so Alt cannot fill in a tunnel's opening, only a painted hole.
          const hi = idx >> 2;
          const t = hU[hi] / 255;
          const s = Math.min(1, w);
          hU[hi] = activeLayer === HOLE_LAYER
            ? Math.min(255, ((t + s * (1 - t)) * 255 + 0.5) | 0)
            : Math.max(0, ((t * (1 - s)) * 255 + 0.5) | 0);
          d1[idx + 3] = hU[hi] > hP[hi] ? hU[hi] : hP[hi];
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
          for (let c = 0; c < 3; c++) { // slice1 alpha (holes) stays untouched
            if (targetBuf === 1 && c === targetChan) continue;
            d1[idx + c] = (d1[idx + c] * k + 0.5) | 0;
          }
          buf[idx + targetChan] = Math.min(255, (tNew * 255 + 0.5) | 0);
        }
        anyTouched = true;
      }
    }

    if (anyTouched) {
      // Weight painting rescales channels in BOTH slices; holes stay confined
      // to slice 1.
      if (isHoleOp) {
        this.tex.addLayerUpdate(1);
      } else {
        this.tex.addLayerUpdate(0);
        this.tex.addLayerUpdate(1);
      }
      this.tex.needsUpdate = true;
      if (isHoleOp) {
        // Painting a hole adds one; only erasing could remove the last.
        if (activeLayer === HOLE_LAYER) { this._hasHoles = true; this._holesDirty = false; }
        else this._holesDirty = true;
      } else if (isEraser) {
        // Painting adds paint; only erasing could have removed the last of it.
        this._hasPaintDirty = true;
      } else {
        this._hasPaint = true; this._hasPaintDirty = false;
      }
    }
    // Touched rect in splat texel coords — used for rect-based undo entries.
    return anyTouched ? { x: u0, y: v0, w: u1 - u0 + 1, h: v1 - v0 + 1 } : null;
  }

  /**
   * Copy a sub-rect of both slices plus the USER hole source (undo storage —
   * ~rect-sized, not map-sized). `srcHU` lets a stroke copy its pre-edit state.
   */
  copyRect(rect, srcD0 = this.data0, srcD1 = this.data1, srcHU = this.holeUser) {
    const { x, y, w, h } = rect;
    const d0 = new Uint8Array(w * h * 4);
    const d1 = new Uint8Array(w * h * 4);
    const hu = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      const src = ((y + row) * SPLAT_RES + x) * 4;
      const dst = row * w * 4;
      d0.set(srcD0.subarray(src, src + w * 4), dst);
      d1.set(srcD1.subarray(src, src + w * 4), dst);
      const s1 = (y + row) * SPLAT_RES + x;
      hu.set(srcHU.subarray(s1, s1 + w), row * w);
    }
    return { x, y, w, h, d0, d1, hu };
  }

  /**
   * Write a copyRect() patch back into the live splat data. The hole channel is
   * recomposed against the CURRENT tool holes, so undoing paint never restores
   * the opening of a tunnel that has since moved.
   */
  pasteRect(patch) {
    const { x, y, w, h, d0, d1, hu } = patch;
    for (let row = 0; row < h; row++) {
      const dst = ((y + row) * SPLAT_RES + x) * 4;
      const src = row * w * 4;
      this.data0.set(d0.subarray(src, src + w * 4), dst);
      this.data1.set(d1.subarray(src, src + w * 4), dst);
      const u = this.holeUser, base = (y + row) * SPLAT_RES + x;
      if (hu) u.set(hu.subarray(row * w, row * w + w), base);
      else for (let i = 0; i < w; i++) u[base + i] = d1[src + (i << 2) + 3];
    }
    this._composeHoles(x, y, x + w - 1, y + h - 1);
    this.tex.addLayerUpdate(0);
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
    this._markDirty();
  }

  /**
   * Both slices as one contiguous LIVE buffer — its hole channel includes tool
   * holes. Use exportCombined() for anything written to disk.
   */
  get combined() { return this._combined; }

  /**
   * Replace all splat data (project load). Requires SPLAT_RES-sized input. The
   * input's hole channel becomes the USER holes; tool holes are re-applied.
   */
  setCombined(bytes) {
    this._combined.set(bytes);
    this._userHolesFromAlpha();
    this._composeHoles();
    this.tex.addLayerUpdate(0);
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
    this._markDirty();
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
    this._userHolesFromAlpha();
    this._composeHoles();
    this.tex.addLayerUpdate(0);
    this.tex.addLayerUpdate(1);
    this.tex.needsUpdate = true;
    this._markDirty();
  }

  snapshot() {
    return { d0: new Uint8Array(this.data0), d1: new Uint8Array(this.data1), hu: new Uint8Array(this.holeUser) };
  }

  restoreSnapshot(snap) {
    this.data0.set(snap.d0);
    this.data1.set(snap.d1);
    if (snap.hu) this.holeUser.set(snap.hu); else this._userHolesFromAlpha();
    this._composeHoles();
    this.tex.needsUpdate = true;
    this._markDirty();
  }

  /** Zero the paint weights of slice 1 but keep its hole channel. */
  _clearSlice1Weights() {
    const d1 = this.data1;
    for (let i = 0; i < d1.length; i += 4) { d1[i] = 0; d1[i + 1] = 0; d1[i + 2] = 0; }
  }

  clearAll() {
    // Paint only — holes are kept (they have their own card and Alt-erase).
    this.data0.fill(0);
    this._clearSlice1Weights();
    this.tex.needsUpdate = true;
    this._hasPaint = false;
    this._hasPaintDirty = false;
  }

  fillAllWithLayer(activeLayer) {
    // Filling the whole map with holes would delete the terrain: not a fill.
    if (activeLayer === HOLE_LAYER || activeLayer === HOLE_ERASE_LAYER) return;
    this.data0.fill(0);
    this._clearSlice1Weights();
    this._hasPaint = activeLayer !== 0;
    this._hasPaintDirty = false;
    if (activeLayer === 0) { this.tex.needsUpdate = true; return; }
    let buf, chan;
    if (activeLayer <= 4) { buf = this.data0; chan = activeLayer - 1; }
    else                  { buf = this.data1; chan = activeLayer - 5; }
    for (let i = 0; i < buf.length; i += 4) buf[i + chan] = 255;
    this.tex.needsUpdate = true;
  }

  /**
   * Bake the auto-paint rules into the splatmap (replaces all paint layers;
   * holes untouched). Same model as the live shader auto-material:
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

        // Clear the 7 weight channels (keep the hole channel d1[idx+3]).
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
    this._hasPaintDirty = true;
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

/** Full inside [lo, hi] (either order), fading to 0 over `soft` outside it. */
function _bandMask(v, lo, hi, soft) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  const w = Math.max(soft, 1e-4);
  return _smoothstep(a - w, a, v) * (1 - _smoothstep(b, b + w, v));
}

function _smoothstep(e0, e1, x) {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
