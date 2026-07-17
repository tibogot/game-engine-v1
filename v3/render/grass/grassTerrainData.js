import * as THREE from "three";

const DENSITY_RES = 512;
const HEIGHT_RES  = 1024; // must match HEIGHTMAP_SIZE — 1:1 copy, no resampling artefacts
const NORMAL_RES  = 512;  // normals can be half-res; still 4× better than before
const CLIFF_RES   = 512;  // cliff-top height/normal grid — 4m/texel at 2048m world

const CLIFF_INVALID = -9999; // sentinel Y where no cliff top exists at a texel

/**
 * Owns every CPU/GPU texture the hybrid grass rings need:
 *   densityTex      — 512²  Uint8  RGBA; .r = painted coverage (0-255)
 *   grassHeightTex  — 1024² Float32 RGBA; .r = world-space Y in metres
 *   terrainNormalTex— 512²  Float32 RGBA; .rgb = FD terrain normal
 *
 * Cliff grass layer (Genshin-style wide-top cliffs — grass on the cliff top
 * that never conflicts with terrain grass because it lives on its own height
 * surface + its own paint mask):
 *   cliffHeightTex  — 512²  Float32 RGBA; .x = cliff-top world Y (-9999 = none),
 *                                          .yzw = cliff-top surface normal
 *   cliffDensityTex — 512²  Uint8   RGBA; .r = painted cliff-grass coverage
 *
 * Rebuilt from the CPU heightmap mirror after every sculpt readback.
 * stampDensity/fill/clear drive the grass-paint tool.
 */
export class GrassTerrainData {
  constructor() {
    this.densityRes = DENSITY_RES;
    this.heightRes  = HEIGHT_RES;
    this.normalRes  = NORMAL_RES;
    this.cliffRes   = CLIFF_RES;

    // ── Density ──────────────────────────────────────────────────────────
    const dData = new Uint8Array(DENSITY_RES * DENSITY_RES * 4);
    this.densityTex = new THREE.DataTexture(dData, DENSITY_RES, DENSITY_RES, THREE.RGBAFormat);
    this.densityTex.wrapS = this.densityTex.wrapT = THREE.ClampToEdgeWrapping;
    this.densityTex.minFilter = this.densityTex.magFilter = THREE.LinearFilter;
    this.densityTex.needsUpdate = true;

    // ── Height (world-space Y) — full terrain resolution ─────────────────
    const hData = new Float32Array(HEIGHT_RES * HEIGHT_RES * 4);
    this.grassHeightTex = new THREE.DataTexture(hData, HEIGHT_RES, HEIGHT_RES, THREE.RGBAFormat, THREE.FloatType);
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

    // ── Cliff-top height (world-space Y, -9999 where no cliff) + normal ────
    const chData = new Float32Array(CLIFF_RES * CLIFF_RES * 4);
    for (let i = 0; i < CLIFF_RES * CLIFF_RES; i++) {
      chData[i * 4]     = CLIFF_INVALID;
      chData[i * 4 + 2] = 1; // default up-normal
    }
    this.cliffHeightTex = new THREE.DataTexture(chData, CLIFF_RES, CLIFF_RES, THREE.RGBAFormat, THREE.FloatType);
    this.cliffHeightTex.wrapS = this.cliffHeightTex.wrapT = THREE.ClampToEdgeWrapping;
    // NEAREST — bilinear across the -9999 sentinel would smear ghost heights
    // into the gap between separate cliffs.
    this.cliffHeightTex.minFilter = this.cliffHeightTex.magFilter = THREE.NearestFilter;
    this.cliffHeightTex.needsUpdate = true;

    // ── Cliff grass painted density ───────────────────────────────────────
    const cdData = new Uint8Array(DENSITY_RES * DENSITY_RES * 4);
    this.cliffDensityTex = new THREE.DataTexture(cdData, DENSITY_RES, DENSITY_RES, THREE.RGBAFormat);
    this.cliffDensityTex.wrapS = this.cliffDensityTex.wrapT = THREE.ClampToEdgeWrapping;
    this.cliffDensityTex.minFilter = this.cliffDensityTex.magFilter = THREE.LinearFilter;
    this.cliffDensityTex.needsUpdate = true;

    // ── Susuki painted density (own layer — plumes are not grass) ─────────
    const sdData = new Uint8Array(DENSITY_RES * DENSITY_RES * 4);
    this.susukiDensityTex = new THREE.DataTexture(sdData, DENSITY_RES, DENSITY_RES, THREE.RGBAFormat);
    this.susukiDensityTex.wrapS = this.susukiDensityTex.wrapT = THREE.ClampToEdgeWrapping;
    this.susukiDensityTex.minFilter = this.susukiDensityTex.magFilter = THREE.LinearFilter;
    this.susukiDensityTex.needsUpdate = true;
    this._hasSusukiData = false;

    this._hasCliffData    = false; // any cliff density painted
    this._hasCliffSurface = false; // any valid cliff-top height baked
    this.cliffSurfaceGen  = -1;    // propStore.gen at last surface bake (staleness check)
  }

  get hasSusukiData() { return this._hasSusukiData; }

  get hasCliffData()    { return this._hasCliffData; }
  get hasCliffSurface() { return this._hasCliffSurface; }

  /**
   * Recompute height + normal textures from the CPU heightmap mirror.
   * @param {Float32Array} cpuHeightmap  normalized 0-1 heights (hmSize²)
   * @param {number}       hmSize        heightmap texel edge (e.g. 1024)
   * @param {number}       maxHeight     metres at value 1.0
   * @param {number}       worldSize     terrain edge in metres (e.g. 2048)
   */
  rebuildFromHeightmap(cpuHeightmap, hmSize, maxHeight, worldSize) {
    // ── Heights at full terrain resolution (1:1 copy when HEIGHT_RES === hmSize) ──
    const hRes = HEIGHT_RES;
    const hOut = this.grassHeightTex.image.data;

    if (hRes === hmSize) {
      // Direct copy — no coordinate mapping, no rounding, no bilinear error.
      for (let i = 0; i < hRes * hRes; i++) {
        const i4 = i * 4;
        hOut[i4]     = cpuHeightmap[i] * maxHeight;
        hOut[i4 + 1] = 0;
        hOut[i4 + 2] = 0;
        hOut[i4 + 3] = 1;
      }
    } else {
      for (let iz = 0; iz < hRes; iz++) {
        for (let ix = 0; ix < hRes; ix++) {
          const u  = ix / (hRes - 1);
          const v  = iz / (hRes - 1);
          const sx = Math.max(0, Math.min(hmSize - 1, Math.round(u * (hmSize - 1))));
          const sz = Math.max(0, Math.min(hmSize - 1, Math.round(v * (hmSize - 1))));
          const i4 = (iz * hRes + ix) * 4;
          hOut[i4]     = cpuHeightmap[sz * hmSize + sx] * maxHeight;
          hOut[i4 + 1] = 0;
          hOut[i4 + 2] = 0;
          hOut[i4 + 3] = 1;
        }
      }
    }
    this.grassHeightTex.needsUpdate = true;

    // ── Normals at half resolution ────────────────────────────────────────
    const nRes = NORMAL_RES;
    const nOut = this.terrainNormalTex.image.data;
    const ws2  = (worldSize / nRes) * 2;
    const du   = 1 / (nRes - 1);

    const getH = (u, v) => {
      const x = Math.max(0, Math.min(hmSize - 1, Math.round(u * (hmSize - 1))));
      const z = Math.max(0, Math.min(hmSize - 1, Math.round(v * (hmSize - 1))));
      return cpuHeightmap[z * hmSize + x] * maxHeight;
    };

    for (let iz = 0; iz < nRes; iz++) {
      for (let ix = 0; ix < nRes; ix++) {
        const u  = ix / (nRes - 1);
        const v  = iz / (nRes - 1);
        const i4 = (iz * nRes + ix) * 4;

        const nx  = getH(Math.max(0, u - du), v) - getH(Math.min(1, u + du), v);
        const nz  = getH(u, Math.max(0, v - du)) - getH(u, Math.min(1, v + du));
        const len = Math.sqrt(nx * nx + ws2 * ws2 + nz * nz);
        nOut[i4]     = nx / len;
        nOut[i4 + 1] = ws2 / len;
        nOut[i4 + 2] = nz / len;
        nOut[i4 + 3] = 1;
      }
    }
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

  // ── Susuki paint layer ───────────────────────────────────────────────────

  /** Paint or erase susuki density at world position (cx, cz). */
  stampSusukiDensity({ cx, cz, radius, strength, falloff, worldSize, erase }) {
    const res  = DENSITY_RES;
    const data = this.susukiDensityTex.image.data;
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
        const t = Math.sqrt(dx * dx + dz * dz) / rPx;
        const w = Math.pow(Math.max(0, 1 - t), falloff) * strength;
        const i = (z * res + x) * 4;
        const v = erase
          ? Math.max(0,   data[i] - w * 255)
          : Math.min(255, data[i] + w * 255);
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    this.susukiDensityTex.needsUpdate = true;
    if (!erase) this._hasSusukiData = true;
  }

  getSusukiDensitySnapshot()      { return new Uint8Array(this.susukiDensityTex.image.data); }
  restoreSusukiDensitySnapshot(s) {
    this.susukiDensityTex.image.data.set(s);
    this.susukiDensityTex.needsUpdate = true;
    this._hasSusukiData = s.some((v) => v > 0);
  }
  fillSusukiDensity()  { this.susukiDensityTex.image.data.fill(255); this.susukiDensityTex.needsUpdate = true; this._hasSusukiData = true; }
  clearSusukiDensity() { this.susukiDensityTex.image.data.fill(0);   this.susukiDensityTex.needsUpdate = true; this._hasSusukiData = false; }

  // ── Cliff-top grass layer ────────────────────────────────────────────────

  /**
   * Bake the cliff-top height + normal grid by raycasting straight down onto
   * the solid cliff meshes. A texel is a valid cliff top only where the down-ray
   * hits an up-facing face (normal.y > 0.3) that sits above the terrain — this
   * is what lets a wide overhanging top carry grass without the narrow base or
   * the ground beneath ever competing for the same texel.
   *
   * @param {(wx:number, wz:number) => ({y:number, ny:number} | null)} raycastDown
   *        topmost solid hit below y=+∞ at world (wx,wz); {y, ny=|normal.y|} or null
   * @param {(wx:number, wz:number) => number} terrainHeightAt  terrain Y at world XZ
   * @param {number} worldSize
   */
  rebuildCliffHeightTex(raycastDown, terrainHeightAt, worldSize) {
    const res  = CLIFF_RES;
    const data = this.cliffHeightTex.image.data;
    let anySurface = false;

    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const wx = worldSize * ((ix + 0.5) / res - 0.5);
        const wz = worldSize * ((iz + 0.5) / res - 0.5);
        const i4 = (iz * res + ix) * 4;

        const hit       = raycastDown(wx, wz);
        const terrainY  = terrainHeightAt(wx, wz);
        let h = CLIFF_INVALID;
        if (hit && hit.ny > 0.3 && hit.y > terrainY + 0.08) {
          h = hit.y;
          anySurface = true;
        }
        data[i4]     = h;
        data[i4 + 1] = 0;
        data[i4 + 2] = 1;
        data[i4 + 3] = 0;
      }
    }

    // Second pass: finite-difference normals from neighbouring valid heights
    // (invalid neighbours reuse the centre height → flat where the top is flat).
    const ws2 = (worldSize / res) * 2;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const i4 = (iz * res + ix) * 4;
        const h  = data[i4];
        if (h <= CLIFF_INVALID + 1) continue;
        const getH = (x, z) => {
          const cx = Math.max(0, Math.min(res - 1, x));
          const cz = Math.max(0, Math.min(res - 1, z));
          const val = data[(cz * res + cx) * 4];
          return val > CLIFF_INVALID + 1 ? val : h;
        };
        const nx  = getH(ix - 1, iz) - getH(ix + 1, iz);
        const nz  = getH(ix, iz - 1) - getH(ix, iz + 1);
        const len = Math.sqrt(nx * nx + ws2 * ws2 + nz * nz);
        data[i4 + 1] = nx / len;
        data[i4 + 2] = ws2 / len;
        data[i4 + 3] = nz / len;
      }
    }

    this.cliffHeightTex.needsUpdate = true;
    this._hasCliffSurface = anySurface;
  }

  /** Paint or erase cliff-grass density at world position (cx, cz). */
  stampCliffDensity({ cx, cz, radius, strength, falloff, worldSize, erase }) {
    const res  = DENSITY_RES;
    const data = this.cliffDensityTex.image.data;
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
        const t = Math.sqrt(dx * dx + dz * dz) / rPx;
        const w = Math.pow(Math.max(0, 1 - t), falloff) * strength;
        const i = (z * res + x) * 4;
        const v = erase
          ? Math.max(0,   data[i] - w * 255)
          : Math.min(255, data[i] + w * 255);
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    this.cliffDensityTex.needsUpdate = true;
    if (!erase) this._hasCliffData = true;
  }

  getCliffDensitySnapshot()      { return new Uint8Array(this.cliffDensityTex.image.data); }
  restoreCliffDensitySnapshot(s) {
    this.cliffDensityTex.image.data.set(s);
    this.cliffDensityTex.needsUpdate = true;
    this._hasCliffData = s.some((v) => v > 0);
  }
  fillCliffDensity()  { this.cliffDensityTex.image.data.fill(255); this.cliffDensityTex.needsUpdate = true; this._hasCliffData = true; }
  clearCliffDensity() { this.cliffDensityTex.image.data.fill(0);   this.cliffDensityTex.needsUpdate = true; this._hasCliffData = false; }
}
