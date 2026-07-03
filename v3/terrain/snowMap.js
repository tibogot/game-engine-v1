/**
 * SnowMap — single-channel paint texture for snow coverage.
 *
 * 512×512 R8 texture covering the full 2048m world (4m/texel).
 * Value 0 = no snow, 255 = full snow — sampled as 0..1 float in the shader.
 * Independent of the SplatMap so it doesn't consume a paint layer.
 */
import * as THREE from "three";
import { WORLD_SIZE, HEIGHTMAP_SIZE } from "./heightmapTexture.js";

// Tracks SplatMap: half the heightmap resolution, clamped, at any terrain size.
export const SNOW_MAP_RES = Math.min(2048, Math.max(256, HEIGHTMAP_SIZE / 2));

export class SnowMap {
  constructor() {
    this._data = new Uint8Array(SNOW_MAP_RES * SNOW_MAP_RES);

    this.tex = new THREE.DataTexture(
      this._data,
      SNOW_MAP_RES, SNOW_MAP_RES,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.tex.wrapS      = THREE.ClampToEdgeWrapping;
    this.tex.wrapT      = THREE.ClampToEdgeWrapping;
    this.tex.minFilter  = THREE.LinearFilter;
    this.tex.magFilter  = THREE.LinearFilter;
    this.tex.needsUpdate = true;
  }

  /**
   * Paint a brush stroke into the snow coverage map.
   *
   * @param {{
   *   cx: number, cz: number,   world-space centre
   *   radius: number,            world-space radius (m)
   *   strength: number,          0..1
   *   falloff: number,           shape exponent (1=linear, 2=smooth, 4=hard core)
   *   erase: boolean,            true = remove snow
   * }} stroke
   * @returns {boolean} true if any pixel was changed
   */
  paintAt(stroke) {
    const { cx, cz, radius, strength, falloff, erase } = stroke;
    const invR   = 1 / radius;
    const pxSize = WORLD_SIZE / SNOW_MAP_RES;
    const half   = WORLD_SIZE * 0.5;

    const u0 = Math.max(0,              Math.floor(((cx - radius) + half) / WORLD_SIZE * SNOW_MAP_RES));
    const u1 = Math.min(SNOW_MAP_RES-1, Math.ceil( ((cx + radius) + half) / WORLD_SIZE * SNOW_MAP_RES));
    const v0 = Math.max(0,              Math.floor(((cz - radius) + half) / WORLD_SIZE * SNOW_MAP_RES));
    const v1 = Math.min(SNOW_MAP_RES-1, Math.ceil( ((cz + radius) + half) / WORLD_SIZE * SNOW_MAP_RES));

    let touched = false;
    const data  = this._data;

    for (let pz = v0; pz <= v1; pz++) {
      const wz = (pz + 0.5) * pxSize - half;
      const dz = wz - cz;
      for (let px = u0; px <= u1; px++) {
        const wx = (px + 0.5) * pxSize - half;
        const d  = Math.hypot(wx - cx, dz);
        if (d > radius) continue;

        const falloffW = Math.pow(Math.max(0, 1 - d * invR), falloff);
        const delta    = Math.round(falloffW * strength * 255);
        if (delta <= 0) continue;

        const idx = pz * SNOW_MAP_RES + px;
        data[idx] = erase
          ? Math.max(0,   data[idx] - delta)
          : Math.min(255, data[idx] + delta);
        touched = true;
      }
    }

    if (touched) this.tex.needsUpdate = true;
    return touched;
  }

  snapshot() {
    return new Uint8Array(this._data);
  }

  restoreSnapshot(snap) {
    this._data.set(snap);
    this.tex.needsUpdate = true;
  }

  /**
   * Bilinear coverage sample at normalized UV — CPU mirror of the shader's
   * coverage(). Used to sink the character/vehicles into painted snow.
   * @returns {number} 0..1
   */
  coverageAtUV(u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    const fx = u * SNOW_MAP_RES - 0.5;
    const fy = v * SNOW_MAP_RES - 0.5;
    const x0 = Math.max(0, Math.floor(fx));
    const y0 = Math.max(0, Math.floor(fy));
    const x1 = Math.min(SNOW_MAP_RES - 1, x0 + 1);
    const y1 = Math.min(SNOW_MAP_RES - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0));
    const ty = Math.min(1, Math.max(0, fy - y0));
    const d  = this._data;
    const h0 = d[y0 * SNOW_MAP_RES + x0] * (1 - tx) + d[y0 * SNOW_MAP_RES + x1] * tx;
    const h1 = d[y1 * SNOW_MAP_RES + x0] * (1 - tx) + d[y1 * SNOW_MAP_RES + x1] * tx;
    return (h0 * (1 - ty) + h1 * ty) / 255;
  }

  hasSnowNear(cx, cz, radius, threshold = 2) {
    const pxSize = WORLD_SIZE / SNOW_MAP_RES;
    const half   = WORLD_SIZE * 0.5;
    const r2     = radius * radius;

    const u0 = Math.max(0,              Math.floor(((cx - radius) + half) / WORLD_SIZE * SNOW_MAP_RES));
    const u1 = Math.min(SNOW_MAP_RES-1, Math.ceil( ((cx + radius) + half) / WORLD_SIZE * SNOW_MAP_RES));
    const v0 = Math.max(0,              Math.floor(((cz - radius) + half) / WORLD_SIZE * SNOW_MAP_RES));
    const v1 = Math.min(SNOW_MAP_RES-1, Math.ceil( ((cz + radius) + half) / WORLD_SIZE * SNOW_MAP_RES));

    const data = this._data;
    for (let pz = v0; pz <= v1; pz++) {
      const wz = (pz + 0.5) * pxSize - half;
      const dz = wz - cz;
      for (let px = u0; px <= u1; px++) {
        const wx = (px + 0.5) * pxSize - half;
        const dx = wx - cx;
        if (dx * dx + dz * dz <= r2 && data[pz * SNOW_MAP_RES + px] >= threshold) {
          return true;
        }
      }
    }
    return false;
  }

  clearAll() {
    this._data.fill(0);
    this.tex.needsUpdate = true;
  }

  fillAll() {
    this._data.fill(255);
    this.tex.needsUpdate = true;
  }
}
