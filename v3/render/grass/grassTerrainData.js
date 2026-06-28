import * as THREE from "three";

const DENSITY_RES = 512;
const NORMAL_RES  = 128;

/**
 * Owns every CPU/GPU texture the hybrid grass rings need:
 *   densityTex      — 512² Uint8 RGBA; .r = painted coverage (0-255)
 *   grassHeightTex  — 128² Float32 RGBA; .r = world-space Y in metres
 *   terrainNormalTex— 128² Float32 RGBA; .rgb = FD terrain normal
 *
 * Rebuilt from the CPU heightmap mirror after every sculpt readback.
 * stampDensity/fill/clear drive the grass-paint tool.
 */
export class GrassTerrainData {
  constructor() {
    this.densityRes = DENSITY_RES;
    this.normalRes  = NORMAL_RES;

    // ── Density ──────────────────────────────────────────────────────────
    const dData = new Uint8Array(DENSITY_RES * DENSITY_RES * 4);
    this.densityTex = new THREE.DataTexture(dData, DENSITY_RES, DENSITY_RES, THREE.RGBAFormat);
    this.densityTex.wrapS = this.densityTex.wrapT = THREE.ClampToEdgeWrapping;
    this.densityTex.minFilter = this.densityTex.magFilter = THREE.LinearFilter;
    this.densityTex.needsUpdate = true;

    // ── Height (world-space Y) ────────────────────────────────────────────
    const hData = new Float32Array(NORMAL_RES * NORMAL_RES * 4);
    this.grassHeightTex = new THREE.DataTexture(hData, NORMAL_RES, NORMAL_RES, THREE.RGBAFormat, THREE.FloatType);
    this.grassHeightTex.wrapS = this.grassHeightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.grassHeightTex.minFilter = this.grassHeightTex.magFilter = THREE.LinearFilter;
    this.grassHeightTex.needsUpdate = true;

    // ── Normals (FD from heightmap) ───────────────────────────────────────
    const nData = new Float32Array(NORMAL_RES * NORMAL_RES * 4);
    for (let i = 0; i < NORMAL_RES * NORMAL_RES; i++) {
      nData[i * 4 + 1] = 1;
      nData[i * 4 + 3] = 1;
    }
    this.terrainNormalTex = new THREE.DataTexture(nData, NORMAL_RES, NORMAL_RES, THREE.RGBAFormat, THREE.FloatType);
    this.terrainNormalTex.wrapS = this.terrainNormalTex.wrapT = THREE.ClampToEdgeWrapping;
    this.terrainNormalTex.minFilter = this.terrainNormalTex.magFilter = THREE.LinearFilter;
    this.terrainNormalTex.needsUpdate = true;
  }

  /**
   * Recompute height + normal textures from the CPU heightmap mirror.
   * @param {Float32Array} cpuHeightmap  normalized 0-1 heights (heightmapSize²)
   * @param {number}       hmSize        heightmap texel edge (e.g. 128)
   * @param {number}       maxHeight     metres at value 1.0
   * @param {number}       worldSize     terrain edge in metres (e.g. 2048)
   */
  rebuildFromHeightmap(cpuHeightmap, hmSize, maxHeight, worldSize) {
    const res  = NORMAL_RES;
    const hOut = this.grassHeightTex.image.data;
    const nOut = this.terrainNormalTex.image.data;
    const ws2  = (worldSize / res) * 2;

    const getH = (u, v) => {
      const x = Math.max(0, Math.min(hmSize - 1, Math.round(u * (hmSize - 1))));
      const z = Math.max(0, Math.min(hmSize - 1, Math.round(v * (hmSize - 1))));
      return cpuHeightmap[z * hmSize + x] * maxHeight;
    };

    const du = 1 / (res - 1);
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const u  = ix / (res - 1);
        const v  = iz / (res - 1);
        const i4 = (iz * res + ix) * 4;

        hOut[i4]     = getH(u, v);
        hOut[i4 + 1] = 0;
        hOut[i4 + 2] = 0;
        hOut[i4 + 3] = 1;

        const nx  = getH(Math.max(0, u - du), v) - getH(Math.min(1, u + du), v);
        const nz  = getH(u, Math.max(0, v - du)) - getH(u, Math.min(1, v + du));
        const len = Math.sqrt(nx * nx + ws2 * ws2 + nz * nz);
        nOut[i4]     = nx / len;
        nOut[i4 + 1] = ws2 / len;
        nOut[i4 + 2] = nz / len;
        nOut[i4 + 3] = 1;
      }
    }

    this.grassHeightTex.needsUpdate   = true;
    this.terrainNormalTex.needsUpdate = true;
  }

  /** Paint or erase grass density at world position (cx, cz). */
  stampDensity({ cx, cz, radius, strength, falloff, worldSize, erase }) {
    const res  = DENSITY_RES;
    const data = this.densityTex.image.data;
    const half = worldSize * 0.5;
    const rPx  = (radius / worldSize) * res;
    const cxPx = ((cx + half) / worldSize) * res;
    const czPx = ((cz + half) / worldSize) * res;
    const r2   = rPx * rPx;
    const x0   = Math.max(0, Math.floor(cxPx - rPx));
    const x1   = Math.min(res - 1, Math.ceil(cxPx + rPx));
    const z0   = Math.max(0, Math.floor(czPx - rPx));
    const z1   = Math.min(res - 1, Math.ceil(czPx + rPx));

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cxPx, dz = z - czPx;
        if (dx * dx + dz * dz > r2) continue;
        const t  = Math.sqrt(dx * dx + dz * dz) / rPx;
        const w  = Math.pow(Math.max(0, 1 - t), falloff) * strength;
        const i  = (z * res + x) * 4;
        const v  = erase
          ? Math.max(0,   data[i] - w * 255)
          : Math.min(255, data[i] + w * 255);
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    this.densityTex.needsUpdate = true;
  }

  getDensitySnapshot()        { return new Uint8Array(this.densityTex.image.data); }
  restoreDensitySnapshot(s)   { this.densityTex.image.data.set(s); this.densityTex.needsUpdate = true; }
  fillDensity()               { this.densityTex.image.data.fill(255); this.densityTex.needsUpdate = true; }
  clearDensity()              { this.densityTex.image.data.fill(0);   this.densityTex.needsUpdate = true; }
}
