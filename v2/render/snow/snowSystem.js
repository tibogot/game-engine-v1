/**
 * Snow tile for the v2 editor.
 *
 * Architecture (synthesis of `snowball.html` + folio's moving window + RevoGrass):
 *
 *  - Display mesh: `PlaneGeometry(tileSize, tileSize, subdivisions, subdivisions)`
 *    rotated flat on XZ, centered on the active anchor (player in play mode,
 *    camera target in editor) each frame. Independent of world size.
 *
 *  - Surface material: `MeshStandardNodeMaterial` driven by real PBR snow
 *    textures (`textures/pbr_materials/Snow010A/*`) — color, roughness, normal-GL, AO,
 *    displacement — tiled by world XZ. Adds a soft glitter highlight on
 *    top of the PBR roughness for visual sparkle.
 *
 *  - Vertex displacement: world Y = terrainY + accumulation + smallDisplacement
 *      − trailGroove. Where:
 *      • terrainY comes from the engine's `globalHeightTex` (R = world Y).
 *      • accumulation = baseDepth + paintedMask × strength + altitudeRamp.
 *      • smallDisplacement = (snowDispTex × 2 − 1) × dispStrength — natural
 *        snow surface ripples, ±~3 cm typically.
 *      • trailGroove = (neutral − trailTex.R) × grooveScale — deep ruts from
 *        the wheel trail map.
 *
 *  - Trail map: 1024² Uint8 RGBA `DataTexture`, RepeatWrapping disabled,
 *    covering a `trailWorldSize` window centered on the player. Per-frame the
 *    4 wheel + 1 chassis world positions are CPU-stamped (segment-walked from
 *    the previous position) into the R channel using a soft cubic falloff.
 *    When the player drifts more than `trailScrollThreshold × trailWorldSize`
 *    from the center the window recenters (and clears).
 *
 *  - Painted accumulation mask: `SnowMask` (R8, world-fixed, painted by
 *    `SnowMaskPaintSystem`). Multiplies the painted accumulation contribution.
 *
 *  - Edge fade alpha: when total snow depth above terrain → 0 the snow fades
 *    out, so painted-edge transitions look natural.
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  cross,
  float,
  int,
  max,
  min,
  mix,
  modelViewMatrix,
  positionGeometry,
  positionWorld,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { SnowMask } from "../../core/snow/snowMask.js";
import { getSnowConfig } from "../../core/snow/snowConfig.js";

const SNOW_TEX_BASE = "/textures/pbr_materials/Snow010A/";
const SNOW_TEX_FILES = {
  color: "Snow010A_1K-JPG_Color.jpg",
  rough: "Snow010A_1K-JPG_Roughness.jpg",
  normal: "Snow010A_1K-JPG_NormalGL.jpg",
  ao: "Snow010A_1K-JPG_AmbientOcclusion.jpg",
  disp: "Snow010A_1K-JPG_Displacement.jpg",
};

const TRAIL_RES = 1024;
const TRAIL_NEUTRAL_F = 0.5; // RGBA8 normalised — "no carving yet" baseline.
/**
 * Maximum number of stamps packed into the uniform array each frame. Each
 * wheel emits ≈3-4 segment-stamps/frame at 30 m/s, so 96 comfortably covers
 * 4 wheels + chassis at peak speed.
 */
const MAX_STAMPS = 96;

function srgbColor(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

/** Tracks the textures we've loaded once and shares them across rebuilds. */
let _sharedPbrPromise = null;
function loadSnowPbr() {
  if (_sharedPbrPromise) return _sharedPbrPromise;
  const loader = new THREE.TextureLoader();
  _sharedPbrPromise = Promise.all([
    loader.loadAsync(SNOW_TEX_BASE + SNOW_TEX_FILES.color),
    loader.loadAsync(SNOW_TEX_BASE + SNOW_TEX_FILES.rough),
    loader.loadAsync(SNOW_TEX_BASE + SNOW_TEX_FILES.normal),
    loader.loadAsync(SNOW_TEX_BASE + SNOW_TEX_FILES.ao),
    loader.loadAsync(SNOW_TEX_BASE + SNOW_TEX_FILES.disp),
  ]).then(([color, rough, normal, ao, disp]) => {
    color.colorSpace = THREE.SRGBColorSpace;
    rough.colorSpace = THREE.NoColorSpace;
    normal.colorSpace = THREE.NoColorSpace;
    ao.colorSpace = THREE.NoColorSpace;
    disp.colorSpace = THREE.NoColorSpace;
    const all = [color, rough, normal, ao, disp];
    for (const t of all) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 8;
    }
    return { color, rough, normal, ao, disp };
  });
  return _sharedPbrPromise;
}

/** Allocate a 1024² RGBA8 RT configured for the trail map (linear filter, clamp, no mip/depth). */
function createTrailRT() {
  const rt = new THREE.RenderTarget(TRAIL_RES, TRAIL_RES, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.flipY = false;
  return rt;
}

/** Clear an RT to TRAIL_NEUTRAL_F grey, restoring renderer state afterward. */
function clearTrailRT(renderer, rt) {
  const savedRT = renderer.getRenderTarget();
  const savedClear = new THREE.Color();
  renderer.getClearColor(savedClear);
  const savedAlpha = renderer.getClearAlpha();
  renderer.setClearColor(
    new THREE.Color(TRAIL_NEUTRAL_F, TRAIL_NEUTRAL_F, TRAIL_NEUTRAL_F),
    1,
  );
  renderer.setRenderTarget(rt);
  renderer.clear(true, false, false);
  renderer.setRenderTarget(savedRT);
  renderer.setClearColor(savedClear, savedAlpha);
}

function buildUniforms(sp) {
  return {
    uAnchorXZ: uniform(new THREE.Vector2(0, 0)),
    uTerrainSize: uniform(0),
    uTileSize: uniform(0),

    /** Accumulation drivers. */
    uBaseDepth: uniform(sp.baseDepth ?? 0.0),
    uPaintedAccumStrength: uniform(sp.paintedAccumStrength ?? 1.2),
    uAccumMaskEnabled: uniform(sp.accumMaskEnabled !== false ? 1 : 0),
    uAltitudeY0: uniform(sp.altitudeY0 ?? 30),
    uAltitudeY1: uniform(sp.altitudeY1 ?? 200),
    uAltitudeDepth: uniform(sp.altitudeDepth ?? 0.6),

    /** Surface detail (PBR displacement texture). */
    uTileFreq: uniform(sp.tileFreq ?? 0.18),
    uDispStrength: uniform(sp.dispStrength ?? 0.06),
    /** Detail mapping: blend `tileFreq` with `tileFreq × detailFreqRatio`. */
    uDetailFreqRatio: uniform(sp.detailFreqRatio ?? 0.18),
    uDetailMix: uniform(sp.detailMix ?? 0.45),
    /** Rim ridges: positive Y where a rut neighbour is depressed. */
    uRimRidgeScale: uniform(sp.rimRidgeScale ?? 0.6),
    uRimSampleOffset: uniform(sp.rimSampleOffset ?? 1.5),

    /** Trail map. */
    uTrailCenter: uniform(new THREE.Vector2(0, 0)),
    uTrailWorldSize: uniform(sp.trailWorldSize ?? 200),
    uTrailGrooveScale: uniform(sp.trailGrooveScale ?? 1.5),
    uTrailAlbedoCavity: uniform(sp.trailAlbedoCavity ?? 0.45),
    uTrailRoughnessBoost: uniform(sp.trailRoughnessBoost ?? 0.55),
    uTrailAoInGroove: uniform(sp.trailAoInGroove ?? 0.8),

    /** Material look. */
    uSnowColorMul: uniform(sp.snowColorMul ?? 1.0),
    uColorBrightness: uniform(sp.colorBrightness ?? 1.0),
    uNormalScale: uniform(sp.normalScale ?? 0.7),

    /**
     * Slope rejection (auto-cliff parity). `uSlopeMin/Max` are smoothstep
     * edges on the heightmap-flatness signal (flat = 1, steep → 0) —
     * identical formula to `chunkTerrainAutoCliff.getSlopeMask()`. When
     * `slopeLinkToCliff` is on in toolState, main.js pushes
     * `autoCliff.slopeStart/slopeEnd` straight into these uniforms via
     * `applyCliffSlope()` so the snow-rock boundary stays glued.
     */
    uSlopeRejectEnabled: uniform(sp.slopeRejectEnabled !== false ? 1 : 0),
    uSlopeMin: uniform(sp.slopeMin ?? 0.6),
    uSlopeMax: uniform(sp.slopeMax ?? 0.7),
    uSlopeSoftness: uniform(sp.slopeSoftness ?? 1.0),
    uSlopeAffectsTrail: uniform(sp.slopeAffectsTrail !== false ? 1 : 0),

    /** Alpha edge fade (snow depth → opaque). */
    uFadeEdgeLow: uniform(sp.fadeEdgeLow ?? 0.02),
    uFadeEdgeHigh: uniform(sp.fadeEdgeHigh ?? 0.25),
    uNormalNeighbourShift: uniform(sp.normalNeighbourShift ?? 0.35),

    /** Glitter highlight (cheap dot-noise pass). */
    uGlitterIntensity: uniform(sp.glitterIntensity ?? 1.6),
    uGlitterScarcity: uniform(sp.glitterScarcity ?? 280),
    uGlitterFreq: uniform(sp.glitterFreq ?? 1.3),
  };
}

function buildGeometry(cfg) {
  const geom = new THREE.PlaneGeometry(
    cfg.tileSize,
    cfg.tileSize,
    cfg.subdivisions,
    cfg.subdivisions,
  );
  /** Rotate so positionGeometry becomes (x, 0, z) — flat on XZ. */
  geom.rotateX(-Math.PI * 0.5);
  return geom;
}

/**
 * Build the snow display `MeshStandardNodeMaterial`. All sampling happens
 * directly in the vertex / fragment shader — no offscreen elevation RT.
 */
function buildMaterial(uniforms, heightTex, accumMaskTex, trailTexNode, pbr, htexRes) {
  const mat = new THREE.MeshStandardNodeMaterial({
    transparent: true,
    alphaTest: 0.05,
    roughness: 0.95,
    metalness: 0,
  });
  mat.envMapIntensity = 0.4;

  /**
   * Slope mask — sampled ONCE per vertex (at the anchor point), then
   * threaded through `sampleSnow` so all 3 normal-basis samples share it.
   * Mirrors `chunkTerrainAutoCliff.getSlopeMask` exactly: same 4/htexRes
   * neighbour step, same `1/(1+|grad|)` flatness, same smoothstep edges.
   *
   * Sharing across A/B/C is both faster and visually correct — auto-cliff
   * samples slope over ~12.5 m (4 texels × terrainSize/htexRes) while the
   * snow normal basis is only 0.35 m apart, so slope is effectively
   * constant across the basis.
   */
  const heightTexStep = float(4.0 / htexRes);
  const sampleSlopeMask = Fn(([worldXZ]) => {
    const uv = worldXZ.div(uniforms.uTerrainSize).add(0.5);
    const hR = texture(heightTex, uv.add(vec2(heightTexStep, float(0)))).r;
    const hL = texture(heightTex, uv.add(vec2(heightTexStep.negate(), float(0)))).r;
    const hU = texture(heightTex, uv.add(vec2(float(0), heightTexStep))).r;
    const hD = texture(heightTex, uv.add(vec2(float(0), heightTexStep.negate()))).r;
    const worldStepHM = heightTexStep.mul(uniforms.uTerrainSize);
    const dhdx = hR.sub(hL).div(worldStepHM.mul(float(2)));
    const dhdz = hU.sub(hD).div(worldStepHM.mul(float(2)));
    const steepness = sqrt(dhdx.mul(dhdx).add(dhdz.mul(dhdz)));
    const flatness = float(1).div(float(1).add(steepness));
    const raw = smoothstep(uniforms.uSlopeMin, uniforms.uSlopeMax, flatness);
    return mix(
      float(1),
      raw.pow(uniforms.uSlopeSoftness),
      uniforms.uSlopeRejectEnabled,
    );
  });

  /**
   * Compute the snow surface world Y at a given world XZ.
   *
   * Returns `vec2(worldY, snowDepth)` — depth is the total accumulation
   * above terrain (used for the alpha edge fade). `slopeMask` is sampled
   * once per vertex outside and passed in.
   */
  const sampleSnow = Fn(([worldXZ, slopeMask]) => {
    /** Terrain Y from the engine's global heightmap. */
    const terrainUV = worldXZ.div(uniforms.uTerrainSize).add(0.5);
    const terrainY = texture(heightTex, terrainUV).r;

    /** Painted accumulation in world space. */
    const paintedRaw = texture(accumMaskTex, terrainUV).r;
    const painted = paintedRaw
      .mul(uniforms.uPaintedAccumStrength)
      .mul(uniforms.uAccumMaskEnabled);

    /** Altitude ramp: 0 below Y0, +altitudeDepth at Y1. */
    const altRange = max(
      float(0.001),
      uniforms.uAltitudeY1.sub(uniforms.uAltitudeY0),
    );
    const altRatio = terrainY
      .sub(uniforms.uAltitudeY0)
      .div(altRange)
      .clamp(0, 1);
    const altitude = altRatio.mul(uniforms.uAltitudeDepth);

    /** Coarse accumulation depth (artist-driven), gated by slope rejection. */
    const accum = max(
      float(0),
      uniforms.uBaseDepth.add(painted).add(altitude),
    ).mul(slopeMask);

    /**
     * Fine PBR displacement, two-scale detail-mapped to break the obvious
     * 5.5 m tile repeat. `uDetailFreqRatio < 1` gives the macro layer a
     * larger pattern (≈30 m at default 0.18); `uDetailMix` chooses the
     * blend between detail-scale (0) and macro-scale (1).
     */
    const dispUVa = worldXZ.mul(uniforms.uTileFreq);
    const dispUVb = worldXZ.mul(uniforms.uTileFreq.mul(uniforms.uDetailFreqRatio));
    const dispA = texture(pbr.disp, dispUVa).r;
    const dispB = texture(pbr.disp, dispUVb).r;
    const dispSample = mix(dispA, dispB, uniforms.uDetailMix);
    const fineDisp = dispSample.mul(2).sub(1).mul(uniforms.uDispStrength);

    /** Trail groove from scrolling stamp map. */
    const trailRelUV = worldXZ
      .sub(uniforms.uTrailCenter)
      .div(uniforms.uTrailWorldSize)
      .add(0.5);
    /** Soft window mask so groove fades to zero at the trail-map edge. */
    const fadeW = float(0.04);
    const fadeU = min(
      trailRelUV.x.div(fadeW).clamp(0, 1),
      float(1).sub(trailRelUV.x).div(fadeW).clamp(0, 1),
    );
    const fadeV = min(
      trailRelUV.y.div(fadeW).clamp(0, 1),
      float(1).sub(trailRelUV.y).div(fadeW).clamp(0, 1),
    );
    const trailMask = fadeU.mul(fadeV);
    const trailUv = trailRelUV.clamp(0, 1);
    const trailR = texture(trailTexNode, trailUv).r;
    const neutral = float(TRAIL_NEUTRAL_F);
    const depHere = neutral.sub(trailR).max(0);
    /**
     * Trail features inherit the slope mask when `uSlopeAffectsTrail` is on
     * — otherwise ruts visibly peek through where the snow itself has been
     * rejected by the slope test.
     */
    const trailSlopeGate = mix(float(1), slopeMask, uniforms.uSlopeAffectsTrail);
    const trailGroove = depHere
      .mul(uniforms.uTrailGrooveScale)
      .mul(trailMask)
      .mul(trailSlopeGate);

    /**
     * Rim ridges — sample 4 trail neighbours `uRimSampleOffset` m away. If
     * the deepest neighbour is more depressed than this point, we're just
     * outside a rut → push positive Y proportional to that delta.
     */
    const rimOffsetUV = uniforms.uRimSampleOffset.div(uniforms.uTrailWorldSize);
    const tU = texture(trailTexNode, trailUv.add(vec2(rimOffsetUV, 0)).clamp(0, 1)).r;
    const tD = texture(trailTexNode, trailUv.sub(vec2(rimOffsetUV, 0)).clamp(0, 1)).r;
    const tV = texture(trailTexNode, trailUv.add(vec2(0, rimOffsetUV)).clamp(0, 1)).r;
    const tNV = texture(trailTexNode, trailUv.sub(vec2(0, rimOffsetUV)).clamp(0, 1)).r;
    const depNbrMax = neutral.sub(tU).max(0)
      .max(neutral.sub(tD).max(0))
      .max(neutral.sub(tV).max(0))
      .max(neutral.sub(tNV).max(0));
    const rim = depNbrMax.sub(depHere).max(0);
    const rimRidge = rim
      .mul(uniforms.uRimRidgeScale)
      .mul(trailMask)
      .mul(trailSlopeGate);

    const depth = max(
      float(0),
      accum.add(fineDisp).sub(trailGroove).add(rimRidge),
    );
    return vec2(terrainY.add(depth), depth);
  });

  /**
   * Cross-stage varyings. `MeshStandardNodeMaterial` already consumes a chunk
   * of the 16-interpolant WebGPU budget, so we stay lean: 4 varyings = 10
   * floats. `vSnowNormalView` / `vSnowTangentView` / `vSnowBitangentView`
   * carry the snow-surface TBN basis in view space; `vSnowDepth` drives the
   * alpha fade.
   */
  const vSnowDepth = varying(float(0), "v_sn_d");
  const vSnowNormalView = varying(vec3(0, 1, 0), "v_sn_n");
  const vSnowTangentView = varying(vec3(1, 0, 0), "v_sn_t");
  const vSnowBitangentView = varying(vec3(0, 0, 1), "v_sn_b");

  mat.positionNode = Fn(() => {
    /** Local XZ in [-tileHalf, +tileHalf] → world XZ via the mesh-position anchor. */
    const localXZ = positionGeometry.xz;
    const worldXZ = localXZ.add(uniforms.uAnchorXZ);

    const shift = uniforms.uNormalNeighbourShift;
    /** Slope mask computed once at the anchor, shared by all basis samples. */
    const slopeMask = sampleSlopeMask(worldXZ);
    const sA = sampleSnow(worldXZ, slopeMask);
    const sB = sampleSnow(worldXZ.add(vec2(shift, 0)), slopeMask);
    const sC = sampleSnow(worldXZ.add(vec2(0, shift.negate())), slopeMask);

    vSnowDepth.assign(sA.y);

    /**
     * World-space TBN derived from three surface samples:
     *   pA at (x, z), pB at (x+s, z), pC at (x, z-s)
     *
     * dTu = pB − pA  → world-space tangent along +X (U).
     * dTv = pC − pA  → world-space tangent along −Z (V — matches the V axis
     *                  of the PlaneGeometry after its rotateX(−π/2)).
     * N   = normalize(cross(dTu, dTv)) — upward surface normal.
     *
     * Transformed to view space (`modelViewMatrix * (vec, 0)` drops translation).
     */
    const pA = vec3(worldXZ.x, sA.x, worldXZ.y);
    const pB = vec3(worldXZ.x.add(shift), sB.x, worldXZ.y);
    const pC = vec3(worldXZ.x, sC.x, worldXZ.y.sub(shift));
    const dTu = pB.sub(pA);
    const dTv = pC.sub(pA);
    const N = cross(dTu, dTv).normalize();

    vSnowNormalView.assign(modelViewMatrix.mul(vec4(N, 0)).xyz.normalize());
    vSnowTangentView.assign(modelViewMatrix.mul(vec4(dTu.normalize(), 0)).xyz.normalize());
    vSnowBitangentView.assign(modelViewMatrix.mul(vec4(dTv.normalize(), 0)).xyz.normalize());

    return vec3(localXZ.x, sA.x, localXZ.y);
  })();

  /**
   * Manually compose the final view-space normal:
   *   1. Sample the PBR normal map at world-XZ tiled UV → tangent-space normal.
   *   2. Apply user `uNormalScale` to the XY (tangent-plane) components.
   *   3. Blend with the recomputed snow surface basis:
   *        N_view = normalize(T·n.x + B·n.y + N·n.z)
   *
   * This replaces TSL's built-in `normalMap()`, which derives its TBN from
   * the flat PlaneGeometry and so completely ignores the snow shape.
   */
  const tiledUV = positionWorld.xz.mul(uniforms.uTileFreq);
  const nTexSample = texture(pbr.normal, tiledUV).rgb;
  const nTs = nTexSample.mul(2).sub(1);
  const nTsScaled = vec3(nTs.xy.mul(uniforms.uNormalScale), nTs.z);
  mat.normalNode = vSnowTangentView.mul(nTsScaled.x)
    .add(vSnowBitangentView.mul(nTsScaled.y))
    .add(vSnowNormalView.mul(nTsScaled.z))
    .normalize();

  /** Painted/altitude/etc. accumulation drives the alpha edge fade. */
  mat.alphaNode = vSnowDepth.smoothstep(
    uniforms.uFadeEdgeLow,
    uniforms.uFadeEdgeHigh,
  );

  /** Trail center → albedo cavity (darker rut), AO multiply (deeper shadow). */
  const trailUv = positionWorld.xz
    .sub(uniforms.uTrailCenter)
    .div(uniforms.uTrailWorldSize)
    .add(0.5)
    .clamp(0, 1);
  const trailR = texture(trailTexNode, trailUv).r;
  const trailGroove = float(TRAIL_NEUTRAL_F)
    .sub(trailR)
    .mul(uniforms.uTrailGrooveScale);

  /**
   * Color = detail-mapped PBR albedo × brightness × (1 − albedoCavity × groove).
   * Sample at two scales and mix to break the 5.5 m tile repeat.
   */
  const tiledUVa = tiledUV;
  const tiledUVb = positionWorld.xz.mul(uniforms.uTileFreq.mul(uniforms.uDetailFreqRatio));
  const colA = texture(pbr.color, tiledUVa).rgb;
  const colB = texture(pbr.color, tiledUVb).rgb;
  const baseCol = mix(colA, colB, uniforms.uDetailMix)
    .mul(uniforms.uSnowColorMul)
    .mul(uniforms.uColorBrightness);
  const directCavity = float(1).sub(trailGroove.mul(uniforms.uTrailAlbedoCavity));

  /** Subtle glitter — cheap dot-noise over the snow color. */
  const glitterUv = positionWorld.xz.mul(uniforms.uGlitterFreq);
  const glitter = texture(pbr.disp, glitterUv).r
    .pow(uniforms.uGlitterScarcity)
    .mul(uniforms.uGlitterIntensity);

  mat.colorNode = baseCol.mul(directCavity).add(vec3(glitter, glitter, glitter));

  /** Roughness: PBR rough + groove boost (clamped). */
  mat.roughnessNode = min(
    float(1),
    texture(pbr.rough, tiledUV).r.add(trailGroove.mul(uniforms.uTrailRoughnessBoost)),
  );

  /** AO: baked PBR AO × groove darkening (clamped). */
  const aoBaked = texture(pbr.ao, tiledUV).r;
  const aoGroove = float(1).sub(trailGroove.mul(uniforms.uTrailAoInGroove));
  mat.aoNode = max(float(0.1), aoBaked.mul(aoGroove).clamp(0, 1));

  return mat;
}

export class SnowSystem {
  constructor({ scene, config }) {
    this.scene = scene;
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = "Snow";
    scene.add(this.group);

    this.mask = new SnowMask(512);

    /**
     * GPU trail map (ping-pong). Two `RenderTarget`s carry the trail state
     * between frames; a single `QuadMesh` pass per frame does the shift +
     * regrow + stamping. Per-frame CPU cost: packing up to `MAX_STAMPS`
     * `vec4`s into a uniform array.
     */
    this._trailRTs = [null, null];
    this._trailIdx = 0;
    this._trailSrcTexNode = null;
    this._trailDisplayTexNode = null;
    this._trailPassQuad = null;
    this._trailPassMaterial = null;
    this._trailPassUniforms = null;
    this._stampUVecs = new Array(MAX_STAMPS)
      .fill(null)
      .map(() => new THREE.Vector4(0, 0, 0, 0));
    this._stampActiveCount = 0;

    this._trailCenter = new THREE.Vector2(0, 0);
    this._prevStamp = [
      new THREE.Vector2(NaN, NaN), // wheels 0..3
      new THREE.Vector2(NaN, NaN),
      new THREE.Vector2(NaN, NaN),
      new THREE.Vector2(NaN, NaN),
      new THREE.Vector2(NaN, NaN), // chassis
    ];
    /** Per-frame shift delta in trail texels (consumed by the GPU pass). */
    this._pendingShiftTex = new THREE.Vector2(0, 0);
    this._pendingShiftDirty = false;

    this._pbr = null;
    this._mesh = null;
    this._geometry = null;
    this._material = null;
    this._uniforms = null;
    this._snowConfig = null;
    this._initialized = false;
    this._enabled = false;
    this._renderer = null;
    this._heightTex = null;
  }

  async init(renderer, heightTex, _noiseTexUnused, toolState, _opts = {}) {
    if (this._initialized) return;
    this._renderer = renderer;
    this._heightTex = heightTex;
    /**
     * `htexRes` matches `HTEX_RES` in main.js — used by slope-rejection
     * sampling so the 4/htexRes neighbour step is identical to auto-cliff.
     */
    this._htexRes = _opts.htexRes ?? 512;
    this._pbr = await loadSnowPbr();
    this._initTrailGPU(renderer);
    this._initialized = true;
    if (toolState.snow?.enabled) {
      await this.rebuild(toolState.snow);
    }
  }

  /**
   * One-time GPU trail subsystem setup.
   *
   *  - Allocates two RGBA8 `RenderTarget`s (`TRAIL_RES²`) for ping-pong.
   *  - Clears both to the "no carving" neutral grey.
   *  - Builds a single `QuadMesh` whose fragment program does, in order:
   *      1. Resample the previous frame's trail at the shifted UV
   *         (`uShiftUV` ≈ player movement in trail-UV units), filling
   *         out-of-window samples with neutral.
   *      2. Lerp toward neutral by `uRegrowRate` (per-frame regrowth).
   *      3. Loop over up to `MAX_STAMPS` packed `vec4(u, v, radiusUV, push)`
   *         stamps and subtract a cubic-falloff disk from the value.
   */
  _initTrailGPU(renderer) {
    this._trailRTs[0] = createTrailRT();
    this._trailRTs[1] = createTrailRT();
    this._trailIdx = 0;
    clearTrailRT(renderer, this._trailRTs[0]);
    clearTrailRT(renderer, this._trailRTs[1]);

    /** Texture-node refs (`.value` is hot-swapped to the latest RT each frame). */
    this._trailSrcTexNode = texture(this._trailRTs[0].texture);
    this._trailDisplayTexNode = texture(this._trailRTs[0].texture);

    const passU = {
      uShiftUV: uniform(new THREE.Vector2(0, 0)),
      uRegrowRate: uniform(0),
      uStampCount: uniform(0),
      uStamps: uniformArray(this._stampUVecs, "vec4"),
    };
    this._trailPassUniforms = passU;

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.toneMapped = false;
    mat.fog = false;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.transparent = false;
    mat.colorNode = Fn(() => {
      /** Sample previous frame's trail at the shifted UV. */
      const uvHere = uv();
      const srcUv = uvHere.add(passU.uShiftUV);
      const inX = step(float(0), srcUv.x).mul(step(srcUv.x, float(1)));
      const inY = step(float(0), srcUv.y).mul(step(srcUv.y, float(1)));
      const inBounds = inX.mul(inY);
      const sampled = texture(this._trailSrcTexNode, srcUv.clamp(0, 1)).r;
      const carried = mix(float(TRAIL_NEUTRAL_F), sampled, inBounds);
      /**
       * Additive regrowth: each frame nudge the carried value up by
       * `uRegrowRate` (in normalised [0,1] units), clamped at neutral. This
       * matches the old CPU semantics where `0.002` ≈ 4 s to fully heal a
       * rut, while `mix(...)` would have been multiplicative decay (which
       * looked like trails vanishing in ~1 s).
       */
      const regrown = min(
        float(TRAIL_NEUTRAL_F),
        carried.add(passU.uRegrowRate),
      );

      const valVar = regrown.toVar("trailVal");
      /**
       * Compile-time loop bound (`MAX_STAMPS`) gated per-iteration by
       * `i < uStampCount`. WebGPU disallows truly dynamic loops in this
       * position; the gate just multiplies inactive stamps' push by 0.
       */
      Loop(
        { start: int(0), end: int(MAX_STAMPS), type: "int", condition: "<" },
        ({ i }) => {
          const active = i.lessThan(passU.uStampCount).select(float(1), float(0));
          const s = passU.uStamps.element(i);
          const center = vec2(s.x, s.y);
          const radius = s.z.max(float(1e-5));
          const push = s.w.mul(active);
          const d = uvHere.distance(center);
          const t = float(1).sub(d.div(radius)).clamp(0, 1);
          const fall = t.mul(t).mul(t);
          valVar.assign(max(float(0), valVar.sub(fall.mul(push))));
        },
      );

      return vec4(valVar, valVar, valVar, float(1));
    })();

    this._trailPassMaterial = mat;
    this._trailPassQuad = new QuadMesh(mat);
  }

  async ensureBuilt(sp) {
    if (!this._initialized || !this._heightTex) return;
    if (this._mesh) return;
    await this.rebuild(sp);
  }

  async rebuild(sp) {
    this.disposeMesh();
    if (!this._heightTex || !this._pbr) {
      console.warn("[Snow] rebuild skipped — heightTex/PBR not ready");
      return;
    }

    this._snowConfig = getSnowConfig(sp);
    const cfg = this._snowConfig;
    this._uniforms = buildUniforms(sp);
    const u = this._uniforms;
    u.uTerrainSize.value = this.config.world.size;
    u.uTileSize.value = cfg.tileSize;
    u.uTrailCenter.value.copy(this._trailCenter);

    this._geometry = buildGeometry(cfg);
    this._material = buildMaterial(
      u,
      this._heightTex,
      this.mask.texture,
      this._trailDisplayTexNode,
      this._pbr,
      this._htexRes,
    );

    this._mesh = new THREE.Mesh(this._geometry, this._material);
    this._mesh.frustumCulled = false;
    this._mesh.castShadow = false;
    this._mesh.receiveShadow = true;
    this._mesh.renderOrder = 0;
    this.group.add(this._mesh);

    this.setEnabled(sp.enabled);
  }

  disposeMesh() {
    if (this._mesh) {
      this.group.remove(this._mesh);
      this._mesh = null;
    }
    if (this._geometry) {
      this._geometry.dispose();
      this._geometry = null;
    }
    if (this._material) {
      this._material.dispose();
      this._material = null;
    }
    this._uniforms = null;
  }

  dispose() {
    this.disposeMesh();
    for (let i = 0; i < this._trailRTs.length; i++) {
      this._trailRTs[i]?.dispose();
      this._trailRTs[i] = null;
    }
    this._trailPassMaterial?.dispose();
    this._trailPassMaterial = null;
    this._trailPassQuad = null;
    this._trailSrcTexNode = null;
    this._trailDisplayTexNode = null;
    this._trailPassUniforms = null;
    this.mask?.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
    this._initialized = false;
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.group.visible = !!on && !!this._mesh;
  }

  syncFromState(sp) {
    if (!this._uniforms) return;
    const u = this._uniforms;
    u.uBaseDepth.value = sp.baseDepth ?? 0.0;
    u.uPaintedAccumStrength.value = sp.paintedAccumStrength ?? 1.2;
    u.uAccumMaskEnabled.value = sp.accumMaskEnabled !== false ? 1 : 0;
    u.uAltitudeY0.value = sp.altitudeY0 ?? 30;
    u.uAltitudeY1.value = sp.altitudeY1 ?? 200;
    u.uAltitudeDepth.value = sp.altitudeDepth ?? 0.6;
    u.uTileFreq.value = sp.tileFreq ?? 0.18;
    u.uDispStrength.value = sp.dispStrength ?? 0.06;
    u.uDetailFreqRatio.value = sp.detailFreqRatio ?? 0.18;
    u.uDetailMix.value = sp.detailMix ?? 0.45;
    u.uRimRidgeScale.value = sp.rimRidgeScale ?? 0.6;
    u.uRimSampleOffset.value = sp.rimSampleOffset ?? 1.5;
    u.uTrailWorldSize.value = sp.trailWorldSize ?? 200;
    u.uTrailGrooveScale.value = sp.trailGrooveScale ?? 1.5;
    u.uTrailAlbedoCavity.value = sp.trailAlbedoCavity ?? 0.45;
    u.uTrailRoughnessBoost.value = sp.trailRoughnessBoost ?? 0.55;
    u.uTrailAoInGroove.value = sp.trailAoInGroove ?? 0.8;
    u.uSnowColorMul.value = sp.snowColorMul ?? 1.0;
    u.uColorBrightness.value = sp.colorBrightness ?? 1.0;
    u.uNormalScale.value = sp.normalScale ?? 0.7;
    u.uSlopeRejectEnabled.value = sp.slopeRejectEnabled !== false ? 1 : 0;
    /**
     * When linked, slopeMin/Max come from `applyCliffSlope` (main.js pushes
     * the cliff values whenever they change). When unlinked, snow's own
     * sliders drive the uniforms. Skipping the write in the linked path
     * avoids overwriting freshly-installed cliff values.
     */
    if (!sp.slopeLinkToCliff) {
      u.uSlopeMin.value = sp.slopeMin ?? 0.6;
      u.uSlopeMax.value = sp.slopeMax ?? 0.7;
    }
    u.uSlopeSoftness.value = sp.slopeSoftness ?? 1.0;
    u.uSlopeAffectsTrail.value = sp.slopeAffectsTrail !== false ? 1 : 0;
    u.uFadeEdgeLow.value = sp.fadeEdgeLow ?? 0.02;
    u.uFadeEdgeHigh.value = sp.fadeEdgeHigh ?? 0.25;
    u.uNormalNeighbourShift.value = sp.normalNeighbourShift ?? 0.35;
    u.uGlitterIntensity.value = sp.glitterIntensity ?? 1.6;
    u.uGlitterScarcity.value = sp.glitterScarcity ?? 280;
    u.uGlitterFreq.value = sp.glitterFreq ?? 1.3;
    this.setEnabled(sp.enabled);
  }

  /**
   * Called by main.js whenever the auto-cliff slope sliders move. When the
   * snow state has `slopeLinkToCliff` on, write the cliff values into the
   * snow uniforms so the two systems stay glued. When unlinked, no-op.
   */
  applyCliffSlope(cliffSlopeStart, cliffSlopeEnd, linkActive) {
    if (!this._uniforms || !linkActive) return;
    this._uniforms.uSlopeMin.value = cliffSlopeStart;
    this._uniforms.uSlopeMax.value = cliffSlopeEnd;
  }

  /**
   * Per-frame trail-map recenter (GPU-side).
   *
   * Snaps the desired center to the trail-texel grid, computes the integer
   * texel delta, and stages it as `uShiftUV` (in UV-space units) for the
   * trail pass. The shader reads the previous frame's texel at
   * `currentUV + uShiftUV` so previously stamped texels stay world-aligned;
   * out-of-window samples fall back to neutral.
   */
  _updateTrailCenter(anchorX, anchorZ) {
    const sz = this._uniforms.uTrailWorldSize.value;
    const texelSize = sz / (TRAIL_RES - 1);

    const newCx = Math.round(anchorX / texelSize) * texelSize;
    const newCz = Math.round(anchorZ / texelSize) * texelSize;

    const dxTex = Math.round((newCx - this._trailCenter.x) / texelSize);
    const dzTex = Math.round((newCz - this._trailCenter.y) / texelSize);

    if (dxTex === 0 && dzTex === 0) {
      this._pendingShiftTex.set(0, 0);
      return;
    }

    this._pendingShiftTex.set(dxTex, dzTex);
    this._pendingShiftDirty = true;
    this._trailCenter.set(newCx, newCz);
    this._uniforms.uTrailCenter.value.copy(this._trailCenter);
  }

  /**
   * Push a single soft-disk stamp into the per-frame uniform array. Returns
   * `false` (and is a no-op) when the array is already full or when the
   * stamp is outside the visible trail window.
   */
  _pushStamp(wx, wz, pushUnit, radiusWorld) {
    if (this._stampActiveCount >= MAX_STAMPS) return false;
    const sz = this._uniforms.uTrailWorldSize.value;
    const u = (wx - this._trailCenter.x) / sz + 0.5;
    const v = (wz - this._trailCenter.y) / sz + 0.5;
    const radiusUV = radiusWorld / sz;
    /** Cull stamps fully outside the window (with margin = radius). */
    if (u < -radiusUV || u > 1 + radiusUV) return false;
    if (v < -radiusUV || v > 1 + radiusUV) return false;
    this._stampUVecs[this._stampActiveCount].set(u, v, radiusUV, pushUnit);
    this._stampActiveCount += 1;
    return true;
  }

  /** Push a chain of soft disks along the segment (ax,az) → (bx,bz). */
  _pushStampSegment(ax, az, bx, bz, pushUnit, radius, stepWorld) {
    const ddx = bx - ax;
    const ddz = bz - az;
    const len = Math.hypot(ddx, ddz);
    if (len < 1e-3) {
      this._pushStamp(bx, bz, pushUnit, radius);
      return;
    }
    const steps = Math.max(1, Math.ceil(len / stepWorld));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this._pushStamp(ax + ddx * t, az + ddz * t, pushUnit, radius)) break;
    }
  }

  /**
   * Per-frame update.
   *
   * @param {object} sp toolState.snow
   * @param {THREE.Vector3} anchorPos active anchor (player or camera target).
   * @param {object} [wheelData] `{ wheelXZs: Float32Array(8), wheelTouching: Float32Array(4), chassisXZ: THREE.Vector2, chassisTouching: number }`
   */
  update(sp, anchorPos, wheelData = null) {
    if (!this._initialized || !this._enabled || !this._mesh || !this._uniforms) return;

    const u = this._uniforms;

    /** Snap anchor to tile-subdivision grid for stable texture lookups. */
    const subdivisionSize = this._snowConfig.tileSize / this._snowConfig.subdivisions;
    const ax = Math.round(anchorPos.x / subdivisionSize) * subdivisionSize;
    const az = Math.round(anchorPos.z / subdivisionSize) * subdivisionSize;
    u.uAnchorXZ.value.set(ax, az);
    this._mesh.position.set(ax, 0, az);

    /** Slide the trail window with the player; existing ruts stay world-aligned. */
    this._updateTrailCenter(anchorPos.x, anchorPos.z);

    /** Collect wheel + chassis stamps into the GPU stamp uniform array. */
    this._stampActiveCount = 0;
    if (wheelData && sp.wheelEnabled !== false) {
      /** Push value is in [0,1] normalised units (RGBA8 fragment subtract). */
      const wPush = (sp.wheelDepth ?? 0.5) * (sp.wheelPushScale ?? 0.6);
      const wRadius = sp.wheelRadius ?? 0.4;
      const stepWorld = sp.trailStampStep ?? 0.15;
      for (let i = 0; i < 4; i++) {
        const touching = wheelData.wheelTouching?.[i] ?? 0;
        if (touching <= 0) {
          this._prevStamp[i].set(NaN, NaN);
          continue;
        }
        const wx = wheelData.wheelXZs[i * 2];
        const wz = wheelData.wheelXZs[i * 2 + 1];
        const prev = this._prevStamp[i];
        if (Number.isFinite(prev.x)) {
          this._pushStampSegment(prev.x, prev.y, wx, wz, wPush, wRadius, stepWorld);
        } else {
          this._pushStamp(wx, wz, wPush, wRadius);
        }
        prev.set(wx, wz);
      }
      const cTouching = wheelData.chassisTouching ?? 0;
      if (cTouching > 0 && (sp.chassisStampEnabled ?? false)) {
        const cPush = (sp.chassisDepth ?? 0.2) * (sp.chassisPushScale ?? 0.35);
        const cRadius = sp.chassisRadius ?? 1.2;
        const prev = this._prevStamp[4];
        if (Number.isFinite(prev.x)) {
          this._pushStampSegment(
            prev.x, prev.y,
            wheelData.chassisXZ.x, wheelData.chassisXZ.y,
            cPush, cRadius, stepWorld,
          );
        } else {
          this._pushStamp(wheelData.chassisXZ.x, wheelData.chassisXZ.y, cPush, cRadius);
        }
        prev.set(wheelData.chassisXZ.x, wheelData.chassisXZ.y);
      } else {
        this._prevStamp[4].set(NaN, NaN);
      }
    } else {
      for (const p of this._prevStamp) p.set(NaN, NaN);
    }

    const regrow = Math.max(0, Math.min(1, sp.trailRegrowPerFrame ?? 0));
    const needPass =
      this._pendingShiftDirty || this._stampActiveCount > 0 || regrow > 0;

    if (needPass) {
      this._renderTrailPass(regrow);
    }
  }

  /**
   * Render one shift + regrow + stamp pass. Reads `_trailRTs[readIdx]`,
   * writes `_trailRTs[writeIdx]`, swaps and rebinds the snow material's
   * trail texture node to point at the new latest result.
   */
  _renderTrailPass(regrow) {
    const renderer = this._renderer;
    if (!renderer || !this._trailPassQuad) return;

    const readIdx = this._trailIdx;
    const writeIdx = 1 - readIdx;
    const readRT = this._trailRTs[readIdx];
    const writeRT = this._trailRTs[writeIdx];

    /** Bind read texture + uniforms for this pass. */
    this._trailSrcTexNode.value = readRT.texture;
    /**
     * `uShiftUV` is the per-frame UV-space offset that, when added to the
     * destination UV, maps to the source UV of the texel that should land
     * here. Player moves +X → center moves +X → newUV(0.5,0.5) should pull
     * from oldUV(0.5 + dxTex/N, 0.5) → uShiftUV.x = +dxTex/N.
     */
    const shiftU = this._pendingShiftTex.x / TRAIL_RES;
    const shiftV = this._pendingShiftTex.y / TRAIL_RES;
    this._trailPassUniforms.uShiftUV.value.set(shiftU, shiftV);
    this._trailPassUniforms.uRegrowRate.value = regrow;
    this._trailPassUniforms.uStampCount.value = this._stampActiveCount;

    /** Render — preserve global renderer state. */
    const savedRT = renderer.getRenderTarget();
    const savedClear = new THREE.Color();
    renderer.getClearColor(savedClear);
    const savedAlpha = renderer.getClearAlpha();

    renderer.setRenderTarget(writeRT);
    this._trailPassQuad.render(renderer);

    renderer.setRenderTarget(savedRT);
    renderer.setClearColor(savedClear, savedAlpha);

    /** Swap and republish the latest texture to the snow material. */
    this._trailIdx = writeIdx;
    this._trailDisplayTexNode.value = writeRT.texture;

    /** Consume the pending shift so subsequent frames don't re-apply it. */
    this._pendingShiftTex.set(0, 0);
    this._pendingShiftDirty = false;
  }

  precompile(renderer, camera) {
    if (!this._mesh) return Promise.resolve();
    return renderer.compileAsync(this._mesh, camera);
  }
}
