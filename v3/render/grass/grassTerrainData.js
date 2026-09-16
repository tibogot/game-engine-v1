import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import { Fn, clamp, dot, float, floor, int, max, min, smoothstep, sqrt, texture, uniform, uv, vec2, vec4 } from "three/tsl";

const DENSITY_RES = 512;
const HEIGHT_RES  = 1024; // placeholder — initSurfaceBake resizes to the real heightmapSize (1:1 copy)
const NORMAL_RES  = 512;  // normals can be half-res; still 4× better than before
const CLIFF_RES   = 512;  // cliff-top height/normal grid — 4m/texel at 2048m world

const CLIFF_INVALID = -9999; // sentinel Y where no cliff top exists at a texel

/**
 * Painted blade height: .r / HEIGHT_ONE = multiplier on the blade height.
 * 128 = 1× (the default everywhere), 32 = 0.25×, 255 ≈ 2×.
 */
const HEIGHT_ONE = 128;
export const GRASS_HEIGHT_MIN = 0.25;
export const GRASS_HEIGHT_MAX = 255 / HEIGHT_ONE;

/**
 * Float render target for the baked grass surface. Full float wherever the GPU
 * can filter it: half-float quantizes a 500 m height range into ~0.5 m steps,
 * which would read as terraced grass on smooth ground.
 */
function _makeSurfaceRT(res) {
  const rt = new THREE.RenderTarget(res, res, {
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.flipY = false;
  return rt;
}

/** 8-bit target for a masked density copy — same format as the painted DataTexture. */
function _makeDensityRT(res) {
  const rt = new THREE.RenderTarget(res, res, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.flipY = false;
  return rt;
}

/**
 * Owns every CPU/GPU texture the hybrid grass rings need:
 *   densityTex      — 512²  Uint8  RGBA; .r = painted coverage (0-255)
 *   grassHeightTex  — heightmapSize² Float32 RGBA; .r = world-space Y in metres
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

    // ── Height (world-space Y) + normals — GPU, baked from the terrain ────
    // These used to be CPU DataTextures rebuilt from the heightmap mirror after
    // every readback: a 1M-texel copy plus a 512² finite-difference pass, then
    // ~20 MB re-uploaded. MEASURED at 17.3 ms per readback (JIT-warmed) and it
    // ran ~8×/second while dragging a brush — the single largest item in the
    // sculpt stroke, and it ran even with no grass painted.
    //
    // The data already existed on the GPU: terrainNormalMap bakes the same
    // surface (.xyz world normal, .w normalized height) once per edit. These are
    // now render targets filled from it, so the CPU does none of this work.
    // Consumers (hybrid grass, susuki) are unchanged — they sample
    // `.grassHeightTex` for .x metres and `.terrainNormalTex` for .xyz as before.
    this._heightRT = _makeSurfaceRT(HEIGHT_RES);
    this._normalRT = _makeSurfaceRT(NORMAL_RES);
    this.grassHeightTex  = this._heightRT.texture;
    this.terrainNormalTex = this._normalRT.texture;
    this._surfaceBake = null;

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

    // ── Painted blade height (Ghost of Tsushima's artist height data) ─────
    // Its own layer, not a spare channel of the density: every density write
    // (and so every saved project) fills all four channels with the coverage,
    // so an old file would load as random heights. Unmasked — height means
    // nothing where no grass grows.
    const hData = new Uint8Array(DENSITY_RES * DENSITY_RES * 4).fill(HEIGHT_ONE);
    this.bladeHeightTex = new THREE.DataTexture(hData, DENSITY_RES, DENSITY_RES, THREE.RGBAFormat);
    this.bladeHeightTex.wrapS = this.bladeHeightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.bladeHeightTex.minFilter = this.bladeHeightTex.magFilter = THREE.LinearFilter;
    this.bladeHeightTex.needsUpdate = true;

    // ── Density with blocking paint layers masked out — GPU ──────────────
    // What the grass and susuki rings actually sample. Painted density times
    // "not on a layer that blocks grass" (a path, a shore), baked only when
    // the density paint, the ground paint or a layer's blocking flag changes.
    // With no blocking layer it is an exact copy of the painted density, so
    // the grass is unchanged until someone opts a layer in. Done as a bake
    // rather than inside the grass compute because that compute is v2's shared
    // HybridGrassSystem, which the v2 editor also runs.
    this._grassMaskRT  = _makeDensityRT(DENSITY_RES);
    this._susukiMaskRT = _makeDensityRT(DENSITY_RES);
    this.grassDensityMaskedTex  = this._grassMaskRT.texture;
    this.susukiDensityMaskedTex = this._susukiMaskRT.texture;
    this._densityMask = null;

    this._hasGrassData    = false; // any terrain density painted
    this._hasCliffData    = false; // any cliff density painted
    this._hasCliffSurface = false; // any valid cliff-top height baked
    this.cliffSurfaceGen  = -1;    // propStore.gen at last surface bake (staleness check)
  }

  /**
   * True once ANY terrain grass density is painted. Same contract as
   * hasSusukiData/hasCliffData: the render loop uses it to skip the ring
   * compute + draws entirely while the field is empty. Erasing with the brush
   * deliberately does NOT clear it (a partial erase can't prove the map is
   * empty without a full rescan) — Clear all / a restore does.
   */
  get hasGrassData() { return this._hasGrassData; }

  get hasSusukiData() { return this._hasSusukiData; }

  get hasCliffData()    { return this._hasCliffData; }
  get hasCliffSurface() { return this._hasCliffSurface; }

  /**
   * Wire the GPU bake. Must be called once, after the terrain surface bake
   * exists — it renders immediately so nothing ever samples a cleared target
   * (a zeroed normal normalizes to NaN, which would break every blade).
   *
   * USE fragmentNode, NOT colorNode. A node material's colorNode supplies only
   * RGB — the alpha is taken from material opacity, so a vec4's .w is silently
   * DISCARDED and written as 1. fragmentNode writes the vec4 verbatim, which is
   * why sculptBrush's passes use it too. This cost an hour: the height plane
   * baked as a constant 500 m and every blade was culled by the frustum test on
   * a bogus world position.
   *
   * Height comes from the heightmap itself rather than the terrain surface
   * bake's packed .w, because that .w is a victim of the very same colorNode
   * alpha rule (see terrainNormalMap.js) and currently always reads 1.
   *
   * PARITY: this reproduces the old CPU maths texel for texel, deliberately,
   * including its quirks — the corner UV convention (u = ix/(nRes-1), not the
   * texel centre uv() gives), the NEAREST heightmap tap that Math.round did, and
   * the ±1 output-texel (±4 m) difference baseline. Reusing the terrain's own
   * normal bake instead would have been tidier and slightly sharper, but it
   * would also have changed grass shading on rolling ground. This is a
   * performance change, so it is not allowed to change the picture.
   *
   * @param {object} o
   * @param {THREE.WebGPURenderer} o.renderer
   * @param {object} o.heightTexNode   shared TSL node over the live height RT
   * @param {number} o.heightmapSize   heightmap texel edge (hmSize)
   * @param {number} o.worldSize       terrain edge in metres
   * @param {number} o.maxHeight       metres at normalized height 1.0
   */
  initSurfaceBake({ renderer, heightTexNode, heightmapSize, worldSize, maxHeight }) {
    // 1:1 with the heightmap, whatever the project's size. A fixed 1024 put a
    // 2048² terrain's grass on a half-resolution ground, and the mesh-matching
    // blade height (HybridGrassSystem terrainSurface) needs texel parity.
    if (heightmapSize !== this.heightRes) {
      this._heightRT.setSize(heightmapSize, heightmapSize);
      this.heightRes = heightmapSize;
    }
    const hMat = new THREE.MeshBasicNodeMaterial();
    hMat.toneMapped = hMat.fog = false;
    hMat.depthTest = hMat.depthWrite = false;
    // .x = world Y in metres, the layout the grass/susuki compute expects.
    hMat.fragmentNode = Fn(() => vec4(
      texture(heightTexNode, uv()).r.mul(float(maxHeight)),
      float(0), float(0), float(1),
    ))();

    const nMat = new THREE.MeshBasicNodeMaterial();
    nMat.toneMapped = nMat.fog = false;
    nMat.depthTest = nMat.depthWrite = false;
    {
      const NRES = NORMAL_RES;
      const HM   = heightmapSize;
      const ws2  = (worldSize / NRES) * 2;
      const du   = 1 / (NRES - 1);

      // uv() is texel-centred; the CPU loop indexed with u = ix/(nRes-1).
      const toCorner = (c) => c.mul(float(NRES)).sub(float(0.5)).div(float(NRES - 1));

      // NEAREST tap on the heightmap — the GPU equivalent of the CPU's
      // Math.round(u * (hmSize - 1)) index, snapped back to that texel's centre.
      const getH = (u, v) => {
        const tx = clamp(floor(clamp(u, float(0), float(1)).mul(float(HM - 1)).add(float(0.5))), float(0), float(HM - 1));
        const tz = clamp(floor(clamp(v, float(0), float(1)).mul(float(HM - 1)).add(float(0.5))), float(0), float(HM - 1));
        return texture(heightTexNode, vec2(
          tx.add(float(0.5)).div(float(HM)),
          tz.add(float(0.5)).div(float(HM)),
        )).r.mul(float(maxHeight));
      };

      nMat.fragmentNode = Fn(() => {
        const u = toCorner(uv().x);
        const v = toCorner(uv().y);
        const nx = getH(max(u.sub(float(du)), float(0)), v)
          .sub(getH(min(u.add(float(du)), float(1)), v));
        const nz = getH(u, max(v.sub(float(du)), float(0)))
          .sub(getH(u, min(v.add(float(du)), float(1))));
        const len = sqrt(nx.mul(nx).add(float(ws2 * ws2)).add(nz.mul(nz)));
        return vec4(nx.div(len), float(ws2).div(len), nz.div(len), float(1));
      })();
    }

    this._surfaceBake = {
      renderer,
      hQuad: new QuadMesh(hMat),
      nQuad: new QuadMesh(nMat),
      hMat, nMat,
    };
    this.bakeSurface();
  }

  /**
   * Re-bake height + normal from the terrain surface. Cheap (two small
   * fullscreen passes) and driven by the same height-version gate that drives
   * terrainNormals.bake(), so sculpting, erosion, undo/redo, road grading and
   * project loads all refresh it without knowing this exists.
   */
  bakeSurface() {
    const b = this._surfaceBake;
    if (!b) return false;
    const { renderer } = b;
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this._heightRT);
    b.hQuad.render(renderer);
    renderer.setRenderTarget(this._normalRT);
    b.nQuad.render(renderer);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
    return true;
  }

  /**
   * Wire the masked-density bake (see the constructor note).
   *
   * @param {object} o
   * @param {THREE.WebGPURenderer} o.renderer
   * @param {THREE.DataArrayTexture} o.splatTex  SplatMap.tex — 2 slices:
   *   slice 0 RGBA = layers 1-4, slice 1 RGB = layers 5-7, A = terrain holes
   */
  initDensityMask({ renderer, splatTex }) {
    const uBlockA = uniform(new THREE.Vector4(0, 0, 0, 0));
    const uBlockB = uniform(new THREE.Vector4(0, 0, 0, 0));
    const make = (srcTex) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.toneMapped = m.fog = false;
      m.depthTest = m.depthWrite = false;
      m.fragmentNode = Fn(() => {
        const c = uv();
        const d = texture(srcTex, c).x;
        const s0 = texture(splatTex, c).depth(int(0));
        const s1 = texture(splatTex, c).depth(int(1));
        const blocked = dot(s0, uBlockA).add(dot(s1, uBlockB));
        // Soft, so the grass thins toward a path edge instead of cutting off.
        // Terrain holes always clear grass, and a little BEFORE the terrain's
        // own 0.5 cut so no blade stands on the rim floating over the opening.
        const keep = float(1).sub(smoothstep(0.3, 0.6, blocked))
          .mul(float(1).sub(smoothstep(0.2, 0.35, s1.w)));
        const v = d.mul(keep);
        return vec4(v, v, v, 1);
      })();
      return new QuadMesh(m);
    };
    this._densityMask = {
      renderer, splatTex, uBlockA, uBlockB,
      grassQuad: make(this.densityTex),
      susukiQuad: make(this.susukiDensityTex),
      blockKey: "",
      seen: { d: -1, s: -1, splat: -1, block: "" },
    };
    this.updateDensityMask(null);
  }

  /**
   * Re-bake the masked density if anything feeding it changed. Cheap to call
   * every frame: it compares texture versions and returns without rendering.
   *
   * @param {?boolean[]} blocksGrass  per paint layer (index 0 = layer 1), or
   *   null to keep the current flags
   * @returns {boolean} true if it re-baked
   */
  updateDensityMask(blocksGrass) {
    const b = this._densityMask;
    if (!b) return false;
    if (blocksGrass) {
      const key = blocksGrass.map((x) => (x ? 1 : 0)).join("");
      if (key !== b.blockKey) {
        b.blockKey = key;
        const f = (i) => (blocksGrass[i] ? 1 : 0);
        b.uBlockA.value.set(f(0), f(1), f(2), f(3));
        b.uBlockB.value.set(f(4), f(5), f(6), 0);
      }
    }
    const seen = b.seen;
    const dV = this.densityTex.version, sV = this.susukiDensityTex.version, spV = b.splatTex.version;
    if (seen.d === dV && seen.s === sV && seen.splat === spV && seen.block === b.blockKey) return false;
    seen.d = dV; seen.s = sV; seen.splat = spV; seen.block = b.blockKey;
    const { renderer } = b;
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this._grassMaskRT);
    b.grassQuad.render(renderer);
    renderer.setRenderTarget(this._susukiMaskRT);
    b.susukiQuad.render(renderer);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
    return true;
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
    if (!erase) this._hasGrassData = true;
  }

  getDensitySnapshot()        { return new Uint8Array(this.densityTex.image.data); }
  restoreDensitySnapshot(s)   { this.densityTex.image.data.set(s); this.densityTex.needsUpdate = true; this._hasGrassData = s.some((v) => v > 0); }
  fillDensity()               { this.densityTex.image.data.fill(255); this.densityTex.needsUpdate = true; this._hasGrassData = true; }
  clearDensity()              { this.densityTex.image.data.fill(0);   this.densityTex.needsUpdate = true; this._hasGrassData = false; }

  // ── Blade height paint layer ─────────────────────────────────────────────

  /**
   * Ease the painted blade height toward `target` (a multiplier) at world
   * (cx, cz); `erase` eases back to 1×. Same brush shape as the density.
   */
  stampBladeHeight({ cx, cz, radius, strength, falloff, worldSize, target, erase }) {
    const res  = DENSITY_RES;
    const data = this.bladeHeightTex.image.data;
    const half = worldSize * 0.5;
    const rPx  = (radius / worldSize) * res;
    const cxPx = ((cx + half) / worldSize) * res;
    const czPx = ((cz + half) / worldSize) * res;
    const r2   = rPx * rPx;
    const x0   = Math.max(0, Math.floor(cxPx - rPx));
    const x1   = Math.min(res - 1, Math.ceil(cxPx + rPx));
    const z0   = Math.max(0, Math.floor(czPx - rPx));
    const z1   = Math.min(res - 1, Math.ceil(czPx + rPx));
    const goal = erase
      ? HEIGHT_ONE
      : Math.min(255, Math.max(0, Math.round(Math.min(GRASS_HEIGHT_MAX, Math.max(GRASS_HEIGHT_MIN, target)) * HEIGHT_ONE)));

    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cxPx, dz = z - czPx;
        if (dx * dx + dz * dz > r2) continue;
        const t = Math.sqrt(dx * dx + dz * dz) / rPx;
        const w = Math.min(1, Math.pow(Math.max(0, 1 - t), falloff) * strength);
        const i = (z * res + x) * 4;
        const v = Math.round(data[i] + (goal - data[i]) * w);
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    this.bladeHeightTex.needsUpdate = true;
  }

  /** Every texel to `multiplier` (1 = reset). */
  fillBladeHeight(multiplier = 1) {
    const v = Math.round(Math.min(GRASS_HEIGHT_MAX, Math.max(GRASS_HEIGHT_MIN, multiplier)) * HEIGHT_ONE);
    const data = this.bladeHeightTex.image.data;
    for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
    this.bladeHeightTex.needsUpdate = true;
  }
  resetBladeHeight() { this.fillBladeHeight(1); }
  getBladeHeightSnapshot()     { return new Uint8Array(this.bladeHeightTex.image.data); }
  restoreBladeHeightSnapshot(s) { this.bladeHeightTex.image.data.set(s); this.bladeHeightTex.needsUpdate = true; }

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
