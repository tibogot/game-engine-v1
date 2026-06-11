/**
 * lake-shader.js — Modular lake water shader (TSL / WebGPU)
 *
 * Extracted from lake-unreal.html. Features:
 *   - Procedural dual-layer surface normals (mx_noise_float gradients)
 *   - Three-stop depth ramp: shore (pale) → mid → deep + Fresnel highlight
 *   - Proper perturbed-normal Fresnel
 *   - Planar reflections (optional, host provides RT)
 *   - Shore foam V1 (Voronoi FBM / Perlin, jagged cutoff)
 *   - Shore foam V2 (domain warp, Voronoi/value noise, independent system)
 *   - Shore inward pulse rings (A+B): time-traveling bands from shore toward deeper water
 *   - Shore contact transparency (shallow alpha wobble)
 *   - Terrain-slope mask: gentle beaches keep shallow α / pale tint; steep cliffs damp them (no “fake shallow” on walls)
 *   - Debug: lakeDebugNo* uniforms strip one layer at a time (isolate shore seam)
 *   - Optional open-water anime Voronoi (“caustic foam” tint, separate from shore foam)
 *   - Foam delay ramp (pushes foam inland)
 *   - Vertex displacement (sine ripples + noise)
 *   - Whole-lake vertical bob (dual sine)
 *
 * Usage:
 *   import { createLakeShader, LAKE_DEFAULTS } from "./lake-shader.js";
 *   const lake = createLakeShader({ THREE, heightTex, terrainSize: 800 });
 *   // lake.material   — MeshBasicNodeMaterial (template, clone per body)
 *   // lake.uniforms   — all uniform refs
 *   // lake.syncParams(p) — push PARAMS into uniforms
 *   // lake.update(dt, elapsed) — call each frame (bob, time)
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn, uniform, float, vec2, vec3, vec4, uv,
  mix, smoothstep, step, floor, fract, sin, cos,
  dot, length, min, max, exp, abs, pow, saturate, clamp,
  normalize, texture, uniformTexture, positionWorld, positionLocal,
  positionView, cameraPosition, mx_noise_float, Loop,
  modelWorldMatrix, modelWorldMatrixInverse,
} from "three/tsl";

// ─── Default parameters (mirrors lake-unreal.html) ──────────────────────────
export const LAKE_DEFAULTS = {
  // Surface colours (three-stop depth ramp + Fresnel highlight)
  /** Thin water / pale shore — ramp starts here, blends toward `midColor`. */
  shoreColor:      "#ffffff",
  /** Mid-thickness cyan band between shore and deep. */
  midColor:        "#38d0d0",
  /** Deepest water body color. */
  deepColor:       "#39b7b7",
  /** Grazing-angle tint (not depth). */
  highlightColor:  "#6aa0b2",
  /**
   * Depth ramp knees in `depthBlendColor` space (0 = thinnest, 1 = thickest).
   * Shore→mid completes by `min(kneeShoreMid, kneeMidDeep)`; mid→deep starts from `max(...)`.
   */
  depthRampShoreMid: 0.36,
  depthRampMidDeep:  0.72,
  opacity:         0.96,
  /** Max surface α when depth → full (multiply with `opacity`; keep high for solid deep water). */
  deepOpacity:     1,

  // Procedural surface normals
  surfNoiseScale1:     0.2,
  surfNoiseScale2:     0.2,
  surfNoiseSpeed1:     0.1,
  surfNoiseSpeed2:    -0.078,
  procNoiseSpeed:      8,
  surfNormalStrength:   0.32,

  // Fresnel
  fresnelExp:      4.2,
  fresnelSky:      0.48,

  // Depth absorption
  /** Thickness → deep *color* (exp falloff). Lower = slower color shift. */
  depthAbsorb:     0.38,
  /**
   * Thickness → opaque *alpha* (separate from color). Higher = deep water becomes solid sooner
   * (Genshin-style: very clear at shore, opaque in the bowl).
   */
  depthAlphaAbsorb: 0.92,
  shallowPale:     0.55,
  shallowAlpha:    0.42,
  /**
   * |∇terrain| (rise/run in world units) from heightmap — dampens shallow transparency on cliffs.
   * Below `shoreSlopeBeach` → full beach shallow treatment; above `shoreSlopeCliff` → full dampen.
   */
  shoreSlopeShallowEnabled: true,
  shoreSlopeSampleEps:   0.65,
  shoreSlopeBeach:       0.2,
  shoreSlopeCliff:       0.95,
  /** 0–1: how strongly cliffs force α toward opaque (vs depth-only shallowAlpha). */
  shallowAlphaSlopeDampen: 1,
  /** 0–1: reduce shore-contact α cut on steep ground. */
  shoreContactSlopeDampen: 1,
  /** 0–1: reduce shallow “pale lift” on cliffs (deep pool beside rock stays darker). */
  shallowPaleSlopeDampen: 0.78,

  // Reflections (host must provide RT)
  reflectEnabled:    true,
  reflectStrength:   0.52,
  reflectDistort:    0.034,

  /** Anime-style Voronoi “caustic foam” on the open water (independent of shore foam). */
  causticFoamEnabled:   false,
  causticFoamBlend:     0.72,
  causticFoamScale:     0.28,
  causticFoamSmoothness: 0.55,
  causticFoamEdgeThreshold: 0.067,
  causticFoamEdgeSoftness:  0.012,
  causticFoamFlowX:     0,
  causticFoamFlowZ:     0.08,
  causticFoamCellSpeed: 0.45,
  causticFoamNoiseScale:   1.5,
  causticFoamNoiseTime:    0.55,
  causticFoamNoiseFlow:    0.18,
  causticFoamDistort:      0.28,
  causticFoamMidPos:       0.084,
  causticFoamColor:        "#dff8ff",

  // Vertex displacement
  vertNoiseAmp:       0.018,
  vertNoiseScale:     0.48,
  vertNoiseSpeedX:    0.24,
  vertNoiseSpeedZ:   -0.19,
  surfRippleEnabled:  true,
  surfRippleAmp:      0.014,
  surfRippleFreq:     0.36,
  surfRippleSpeed:    1.05,

  // Whole-lake bob
  bobEnabled:         true,
  bobAmplitude:       0.038,
  bobHz:              0.42,
  bobSecondaryAmp:    0.012,
  bobSecondaryHz:     0.86,

  // Shore foam V1
  shoreFoamWidth:       0.55,
  shoreFoamNoise:       0.35,
  shoreFoamIntensity:   1.15,
  shoreFoamSharpness:   1.35,
  shoreNoiseWorldScale: 14,
  shoreNoiseAnimSpeed:  1.0,
  shoreNoiseScrollV:    0.68,
  shoreNoiseContrast:   1.0,
  shoreNoiseFineScale:  26,
  shoreNoiseFineAmt:    0.14,
  shoreNoiseFineSpeed:  1.2,
  shoreJaggedCutoff:    0.42,
  shoreFoamTransitionWidth: 0.14,
  shoreFoamNoiseStyle:  "voronoiFbm",
  shoreNoiseAnisoX:     1,
  shoreNoiseAnisoZ:     1,
  shoreWorleyJitter:    0.85,
  shoreWorleyWarpScale: 3,
  shoreWorleyWarpStrength: 0.55,
  shoreWorleyContrast:  1.5,
  shoreWorleyThreshold: 0.35,
  shoreWorleySoftness:  0.18,
  shoreWorleyBrightness:1,
  shoreFoamVoroSmoothness: 0.11,
  shoreFoamVoroCellSpeed:  0.48,
  shoreFoamVoroEdgeGain:   3.2,
  shoreFoamVoroFbmWeight:  0.72,
  shorePrimaryFoamColor: "#ffffff",

  /** Inward-traveling pulse rings on the lake (same idea as lake-unreal.html waterFrag). */
  shorePulseNoiseAnisoX: 1,
  shorePulseNoiseAnisoZ: 1,
  shorePulseOpacity: 1,
  shorePulse2Opacity: 1,
  shorePulseFoamColor: "#c9ebff",
  shorePulse2FoamColor: "#a8d8ff",
  shorePulseNoiseStyle: "voronoiFbm",
  shorePulseEnabled: true,
  shorePulseAnimSpeed: 0.38,
  shorePulseMaxRange: 3.2,
  shorePulseTravelPower: 1,
  shorePulseMinDist: 0.02,
  shorePulseRingWidth: 0.11,
  shorePulseRing2WidthMul: 1,
  shorePulseIntensity: 0.72,
  shorePulseFade: 1.65,
  shorePulseStagger: 0.5,
  shorePulse2Intensity: 0.45,
  shorePulseRing2Sharpness: 1.15,
  shorePulse2Fade: 1.65,
  shorePulseNoiseAmt: 0.35,
  shorePulseNoiseScale: 9,
  shorePulseNoiseAnimSpeed: 0.55,
  shorePulseRingSharpness: 1.15,

  // Shore foam V2
  shoreFoamV2Enabled:    false,
  shoreFoamV2Width:      0.62,
  shoreFoamV2Intensity:  1.2,
  shoreFoamV2Sharpness:  1.55,
  shoreFoamV2NoiseAmt:   0.6,
  shoreFoamV2WorldScale: 15,
  shoreFoamV2AnimSpeed:  1.0,
  shoreFoamV2ScrollV:    0.72,
  shoreFoamV2AnisoX:     1,
  shoreFoamV2AnisoZ:     1,
  shoreFoamV2WarpScale:  3.2,
  shoreFoamV2WarpStrength: 0.65,
  shoreFoamV2FineScale:  25,
  shoreFoamV2FineAmt:    0.35,
  shoreFoamV2FineSpeed:  1.2,
  shoreFoamV2Contrast:   1.35,
  shoreFoamV2Cutoff:     0.45,
  shoreFoamV2TransitionWidth: 0.14,
  shoreFoamV2Color:      "#f0f9ff",
  shoreFoamV2VoronoiMix:     0.5,
  shoreFoamV2VoronoiJitter:  0.78,
  shoreFoamV2VoronoiScale:   1.15,
  shoreFoamV2VoronoiRadius:  0.38,
  shoreFoamV2VoronoiContrast:1.25,

  // Shore contact transparency
  shoreContactEnabled:    true,
  /** World units: shallow-depth range over which contact α eases to full (wider = gentler shore). */
  shoreContactBandWidth:  1.18,
  /** Minimum α multiplier in the contact zone (higher = less “empty” near shore). */
  shoreContactAlphaMul:   0.44,
  shoreContactNoiseScale: 6.5,
  /** Edge α wobble; kept moderate — dual noise + edge gate reduce crawl. */
  shoreContactNoiseAmp:   0.12,
  /**
   * Pow exponent on the raw contact mask (0.35–1). Lower = softer, longer transparent shoulder
   * and no hard step at the inner edge of the band.
   */
  shoreContactCurve:      0.58,

  // Foam delay ramp
  shoreFoamDelayEnabled:  true,
  shoreFoamDelayStart:    0.08,
  shoreFoamDelaySoft:     0.35,

  // Foam color
  foamColor: "#e8f4ff",
  glowColor: "#88ccff",
  lineWidth: 0.42,
  glowWidth: 1.35,
  waterlineIntensity: 0,

  /** Shore debug: when 1, strips that layer so you can isolate the seam (re-enable one by one). */
  lakeDebugNoPrimaryFoam:   false,
  lakeDebugNoWaterline:     false,
  lakeDebugNoShoreContact:  false,
  lakeDebugNoReflection:    false,
  lakeDebugNoFresnelSky:    false,
  lakeDebugNoSurfNormals:   false,
};

// ─── TSL helper functions ────────────────────────────────────────────────────

const _hash22 = Fn(([p]) => {
  const px = dot(p, vec2(127.1, 311.7));
  const py = dot(p, vec2(269.5, 183.3));
  return fract(sin(vec2(px, py)).mul(43758.5453));
});

const _neighbors = [
  [-1,-1],[0,-1],[1,-1],
  [-1, 0],[0, 0],[1, 0],
  [-1, 1],[0, 1],[1, 1],
];

const _smin = Fn(([a, b, k]) => {
  const h = max(k.sub(abs(a.sub(b))), float(0)).div(k);
  return min(a, b).sub(h.mul(h).mul(h).mul(k).div(6));
});

const _cellPt = Fn(([seed, time, cellSpeed]) => {
  return float(0.5).add(
    float(0.5).mul(sin(time.mul(cellSpeed).add(float(6.2831).mul(seed)))),
  );
});

/** Animated Voronoi F1 + smooth-min F1 (anime-water-scene2 style, jittered cell points). */
const _animeVoronoiF1 = Fn(([p, tNoise, cellSpeed]) => {
  const ip = floor(p);
  const fp = fract(p);
  const md = float(10.0).toVar();
  for (const [nx, ny] of _neighbors) {
    const n = vec2(float(nx), float(ny));
    const rnd = _hash22(ip.add(n));
    const pt = vec2(
      _cellPt(rnd.x, tNoise, cellSpeed),
      _cellPt(rnd.y, tNoise, cellSpeed),
    );
    md.assign(min(md, length(n.add(pt).sub(fp))));
  }
  return md;
});

const _animeVoronoiSmoothF1 = Fn(([p, tNoise, cellSpeed, smoothness]) => {
  const ip = floor(p);
  const fp = fract(p);
  const res = float(10.0).toVar();
  for (const [nx, ny] of _neighbors) {
    const n = vec2(float(nx), float(ny));
    const rnd = _hash22(ip.add(n));
    const pt = vec2(
      _cellPt(rnd.x, tNoise, cellSpeed),
      _cellPt(rnd.y, tNoise, cellSpeed),
    );
    res.assign(_smin(res, length(n.add(pt).sub(fp)), smoothness));
  }
  return res;
});

const _nHash = Fn(([p]) => {
  const pp = fract(p.mul(vec2(127.1, 311.7)));
  const d = dot(pp, pp.add(45.32));
  return fract(pp.x.add(d).mul(pp.y.add(d)));
});

const _vnoise2 = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const uu = f.mul(f).mul(float(3).sub(f.mul(2)));
  const n00 = _nHash(i);
  const n10 = _nHash(i.add(vec2(1, 0)));
  const n01 = _nHash(i.add(vec2(0, 1)));
  const n11 = _nHash(i.add(vec2(1, 1)));
  return mix(mix(n00, n10, uu.x), mix(n01, n11, uu.x), uu.y);
});

const _fbm2 = Fn(([p_immutable]) => {
  const p = p_immutable.toVar();
  const v = _vnoise2(p).mul(0.5).toVar();
  p.assign(p.mul(2));
  v.addAssign(_vnoise2(p).mul(0.25));
  return v;
});

const _voronoiF1Jitter = Fn(([p, jitter]) => {
  const ip = floor(p);
  const fp = fract(p);
  const md = float(10.0).toVar();
  for (const [nx, ny] of _neighbors) {
    const cellOffset = vec2(float(nx), float(ny));
    const rnd = _hash22(ip.add(cellOffset));
    const pt = mix(vec2(0.5, 0.5), rnd, jitter);
    md.assign(min(md, length(cellOffset.add(pt).sub(fp))));
  }
  return md;
});

const _valueFbm5 = Fn(([p_immutable]) => {
  const p = p_immutable.toVar();
  const value = float(0.0).toVar();
  const amp = float(1.0).toVar();
  const totalAmp = float(0.0).toVar();
  Loop(5, () => {
    value.addAssign(amp.mul(_vnoise2(p)));
    totalAmp.addAssign(amp);
    p.assign(p.mul(2.3));
    amp.assign(amp.mul(0.4));
  });
  return value.div(max(totalAmp, float(1e-4)));
});

const _worleyFbm5 = Fn(([p_immutable, jitter]) => {
  const p = p_immutable.toVar();
  const value = float(0.0).toVar();
  const amp = float(0.5).toVar();
  const totalAmp = float(0.0).toVar();
  Loop(5, () => {
    value.addAssign(_voronoiF1Jitter(p, jitter).mul(amp));
    totalAmp.addAssign(amp);
    p.assign(p.mul(2.0));
    amp.assign(amp.mul(0.5));
  });
  return value.div(max(totalAmp, float(1e-4)));
});

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {THREE}  deps.THREE        — three.js namespace
 * @param {THREE.Texture} deps.heightTex — heightmap DataTexture (R = world Y)
 * @param {number} deps.terrainSize   — world size of the terrain (e.g. 800)
 * @returns {{ material, uniforms, syncParams, update }}
 */
export function createLakeShader({ heightTex, terrainSize }) {

  // ── Uniforms ───────────────────────────────────────────────────────────────
  const u = {};

  // Time (driven by host)
  u.time             = uniform(0);

  // Surface colours
  u.shoreColor       = uniform(new THREE.Color(LAKE_DEFAULTS.shoreColor));
  u.midColor         = uniform(new THREE.Color(LAKE_DEFAULTS.midColor));
  u.deepColor        = uniform(new THREE.Color(LAKE_DEFAULTS.deepColor));
  u.highlightColor   = uniform(new THREE.Color(LAKE_DEFAULTS.highlightColor));
  u.depthRampShoreMid = uniform(LAKE_DEFAULTS.depthRampShoreMid);
  u.depthRampMidDeep  = uniform(LAKE_DEFAULTS.depthRampMidDeep);
  u.opacity          = uniform(LAKE_DEFAULTS.opacity);
  u.deepOpacity      = uniform(LAKE_DEFAULTS.deepOpacity);

  // Procedural surface normals
  u.surfNoiseScale1     = uniform(LAKE_DEFAULTS.surfNoiseScale1);
  u.surfNoiseScale2     = uniform(LAKE_DEFAULTS.surfNoiseScale2);
  u.surfNoiseSpeed1     = uniform(LAKE_DEFAULTS.surfNoiseSpeed1);
  u.surfNoiseSpeed2     = uniform(LAKE_DEFAULTS.surfNoiseSpeed2);
  u.procNoiseSpeed      = uniform(LAKE_DEFAULTS.procNoiseSpeed);
  u.surfNormalStrength  = uniform(LAKE_DEFAULTS.surfNormalStrength);

  // Fresnel
  u.fresnelExp       = uniform(LAKE_DEFAULTS.fresnelExp);
  u.fresnelSky       = uniform(LAKE_DEFAULTS.fresnelSky);

  // Depth absorption
  u.depthAbsorb       = uniform(LAKE_DEFAULTS.depthAbsorb);
  u.depthAlphaAbsorb  = uniform(LAKE_DEFAULTS.depthAlphaAbsorb);
  u.shallowPale       = uniform(LAKE_DEFAULTS.shallowPale);
  u.shallowAlpha      = uniform(LAKE_DEFAULTS.shallowAlpha);
  u.shoreSlopeShallowEnabled = uniform(LAKE_DEFAULTS.shoreSlopeShallowEnabled ? 1 : 0);
  u.shoreSlopeSampleEps      = uniform(LAKE_DEFAULTS.shoreSlopeSampleEps);
  u.shoreSlopeBeach          = uniform(LAKE_DEFAULTS.shoreSlopeBeach);
  u.shoreSlopeCliff          = uniform(LAKE_DEFAULTS.shoreSlopeCliff);
  u.shallowAlphaSlopeDampen    = uniform(LAKE_DEFAULTS.shallowAlphaSlopeDampen);
  u.shoreContactSlopeDampen    = uniform(LAKE_DEFAULTS.shoreContactSlopeDampen);
  u.shallowPaleSlopeDampen     = uniform(LAKE_DEFAULTS.shallowPaleSlopeDampen);

  // Reflections
  u.reflectEnabled   = uniform(LAKE_DEFAULTS.reflectEnabled ? 1 : 0);
  u.reflectStrength  = uniform(LAKE_DEFAULTS.reflectStrength);
  u.reflectDistort   = uniform(LAKE_DEFAULTS.reflectDistort);
  u.reflectVP        = uniform(new THREE.Matrix4());

  // Open-water anime Voronoi (caustic-style foam tint)
  u.causticFoamEnabled       = uniform(LAKE_DEFAULTS.causticFoamEnabled ? 1 : 0);
  u.causticFoamBlend         = uniform(LAKE_DEFAULTS.causticFoamBlend);
  u.causticFoamScale         = uniform(LAKE_DEFAULTS.causticFoamScale);
  u.causticFoamSmoothness    = uniform(LAKE_DEFAULTS.causticFoamSmoothness);
  u.causticFoamEdgeThreshold = uniform(LAKE_DEFAULTS.causticFoamEdgeThreshold);
  u.causticFoamEdgeSoftness  = uniform(LAKE_DEFAULTS.causticFoamEdgeSoftness);
  u.causticFoamFlowX         = uniform(LAKE_DEFAULTS.causticFoamFlowX);
  u.causticFoamFlowZ         = uniform(LAKE_DEFAULTS.causticFoamFlowZ);
  u.causticFoamCellSpeed     = uniform(LAKE_DEFAULTS.causticFoamCellSpeed);
  u.causticFoamNoiseScale    = uniform(LAKE_DEFAULTS.causticFoamNoiseScale);
  u.causticFoamNoiseTime     = uniform(LAKE_DEFAULTS.causticFoamNoiseTime);
  u.causticFoamNoiseFlow     = uniform(LAKE_DEFAULTS.causticFoamNoiseFlow);
  u.causticFoamDistort       = uniform(LAKE_DEFAULTS.causticFoamDistort);
  u.causticFoamMidPos        = uniform(LAKE_DEFAULTS.causticFoamMidPos);
  u.causticFoamColor         = uniform(new THREE.Color(LAKE_DEFAULTS.causticFoamColor));
  // 1×1 white placeholder — replaced by host with reflection RT texture
  const _placeholderTex = new THREE.DataTexture(
    new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat,
  );
  _placeholderTex.needsUpdate = true;
  u.reflectTex       = uniformTexture(_placeholderTex);

  // Vertex displacement
  u.vertNoiseAmp     = uniform(LAKE_DEFAULTS.vertNoiseAmp);
  u.vertNoiseScale   = uniform(LAKE_DEFAULTS.vertNoiseScale);
  u.vertNoiseSpeedX  = uniform(LAKE_DEFAULTS.vertNoiseSpeedX);
  u.vertNoiseSpeedZ  = uniform(LAKE_DEFAULTS.vertNoiseSpeedZ);
  u.surfRippleEnabled= uniform(LAKE_DEFAULTS.surfRippleEnabled ? 1 : 0);
  u.surfRippleAmp    = uniform(LAKE_DEFAULTS.surfRippleAmp);
  u.surfRippleFreq   = uniform(LAKE_DEFAULTS.surfRippleFreq);
  u.surfRippleSpeed  = uniform(LAKE_DEFAULTS.surfRippleSpeed);

  // Bob (mesh Y driven by host in update())
  u.waterY           = uniform(0); // current water Y (includes bob offset)

  // Shore foam V1
  u.shoreFoamWidth        = uniform(LAKE_DEFAULTS.shoreFoamWidth);
  u.shoreFoamNoiseAmt     = uniform(LAKE_DEFAULTS.shoreFoamNoise);
  u.shoreFoamIntensity    = uniform(LAKE_DEFAULTS.shoreFoamIntensity);
  u.shoreFoamSharpness    = uniform(LAKE_DEFAULTS.shoreFoamSharpness);
  u.shoreNoiseWorldScale  = uniform(LAKE_DEFAULTS.shoreNoiseWorldScale);
  u.shoreNoiseAnimSpeed   = uniform(LAKE_DEFAULTS.shoreNoiseAnimSpeed);
  u.shoreNoiseScrollV     = uniform(LAKE_DEFAULTS.shoreNoiseScrollV);
  u.shoreNoiseContrast    = uniform(LAKE_DEFAULTS.shoreNoiseContrast);
  u.shoreNoiseFineScale   = uniform(LAKE_DEFAULTS.shoreNoiseFineScale);
  u.shoreNoiseFineAmt     = uniform(LAKE_DEFAULTS.shoreNoiseFineAmt);
  u.shoreNoiseFineSpeed   = uniform(LAKE_DEFAULTS.shoreNoiseFineSpeed);
  u.shoreJaggedCutoff     = uniform(LAKE_DEFAULTS.shoreJaggedCutoff);
  u.shoreFoamTransitionWidth = uniform(LAKE_DEFAULTS.shoreFoamTransitionWidth);
  u.shoreFoamNoiseMode    = uniform(LAKE_DEFAULTS.shoreFoamNoiseStyle === "voronoiFbm" ? 1 : 0);
  u.shoreNoiseAnisoX      = uniform(LAKE_DEFAULTS.shoreNoiseAnisoX);
  u.shoreNoiseAnisoZ      = uniform(LAKE_DEFAULTS.shoreNoiseAnisoZ);
  u.shoreWorleyJitter     = uniform(LAKE_DEFAULTS.shoreWorleyJitter);
  u.shoreWorleyWarpScale  = uniform(LAKE_DEFAULTS.shoreWorleyWarpScale);
  u.shoreWorleyWarpStrength = uniform(LAKE_DEFAULTS.shoreWorleyWarpStrength);
  u.shoreWorleyContrast   = uniform(LAKE_DEFAULTS.shoreWorleyContrast);
  u.shoreWorleyThreshold  = uniform(LAKE_DEFAULTS.shoreWorleyThreshold);
  u.shoreWorleySoftness   = uniform(LAKE_DEFAULTS.shoreWorleySoftness);
  u.shoreWorleyBrightness = uniform(LAKE_DEFAULTS.shoreWorleyBrightness);
  u.shoreFoamVoroSmoothness = uniform(LAKE_DEFAULTS.shoreFoamVoroSmoothness);
  u.shoreFoamVoroCellSpeed  = uniform(LAKE_DEFAULTS.shoreFoamVoroCellSpeed);
  u.shoreFoamVoroEdgeGain   = uniform(LAKE_DEFAULTS.shoreFoamVoroEdgeGain);
  u.shoreFoamVoroFbmWeight  = uniform(LAKE_DEFAULTS.shoreFoamVoroFbmWeight);
  u.shorePrimaryFoamColor   = uniform(new THREE.Color(LAKE_DEFAULTS.shorePrimaryFoamColor));

  u.shorePulseNoiseMode = uniform(LAKE_DEFAULTS.shorePulseNoiseStyle === "voronoiFbm" ? 1 : 0);
  u.shorePulseNoiseAnisoX = uniform(LAKE_DEFAULTS.shorePulseNoiseAnisoX);
  u.shorePulseNoiseAnisoZ = uniform(LAKE_DEFAULTS.shorePulseNoiseAnisoZ);
  u.shorePulseOpacity = uniform(LAKE_DEFAULTS.shorePulseOpacity);
  u.shorePulse2Opacity = uniform(LAKE_DEFAULTS.shorePulse2Opacity);
  u.shorePulseFoamColor = uniform(new THREE.Color(LAKE_DEFAULTS.shorePulseFoamColor));
  u.shorePulse2FoamColor = uniform(new THREE.Color(LAKE_DEFAULTS.shorePulse2FoamColor));
  u.shorePulseEnabled = uniform(LAKE_DEFAULTS.shorePulseEnabled ? 1 : 0);
  u.shorePulseAnimSpeed = uniform(LAKE_DEFAULTS.shorePulseAnimSpeed);
  u.shorePulseMaxRange = uniform(LAKE_DEFAULTS.shorePulseMaxRange);
  u.shorePulseTravelPower = uniform(LAKE_DEFAULTS.shorePulseTravelPower);
  u.shorePulseMinDist = uniform(LAKE_DEFAULTS.shorePulseMinDist);
  u.shorePulseRingWidth = uniform(LAKE_DEFAULTS.shorePulseRingWidth);
  u.shorePulseRing2WidthMul = uniform(LAKE_DEFAULTS.shorePulseRing2WidthMul);
  u.shorePulseIntensity = uniform(LAKE_DEFAULTS.shorePulseIntensity);
  u.shorePulseFade = uniform(LAKE_DEFAULTS.shorePulseFade);
  u.shorePulseStagger = uniform(LAKE_DEFAULTS.shorePulseStagger);
  u.shorePulse2Intensity = uniform(LAKE_DEFAULTS.shorePulse2Intensity);
  u.shorePulse2Fade = uniform(LAKE_DEFAULTS.shorePulse2Fade);
  u.shorePulseNoiseAmt = uniform(LAKE_DEFAULTS.shorePulseNoiseAmt);
  u.shorePulseNoiseScale = uniform(LAKE_DEFAULTS.shorePulseNoiseScale);
  u.shorePulseNoiseAnimSpeed = uniform(LAKE_DEFAULTS.shorePulseNoiseAnimSpeed);
  u.shorePulseRingSharpness = uniform(LAKE_DEFAULTS.shorePulseRingSharpness);
  u.shorePulseRing2Sharpness = uniform(LAKE_DEFAULTS.shorePulseRing2Sharpness);

  // Shore foam V2
  u.shoreFoamV2Enabled     = uniform(LAKE_DEFAULTS.shoreFoamV2Enabled ? 1 : 0);
  u.shoreFoamV2Width       = uniform(LAKE_DEFAULTS.shoreFoamV2Width);
  u.shoreFoamV2Intensity   = uniform(LAKE_DEFAULTS.shoreFoamV2Intensity);
  u.shoreFoamV2Sharpness   = uniform(LAKE_DEFAULTS.shoreFoamV2Sharpness);
  u.shoreFoamV2NoiseAmt    = uniform(LAKE_DEFAULTS.shoreFoamV2NoiseAmt);
  u.shoreFoamV2WorldScale  = uniform(LAKE_DEFAULTS.shoreFoamV2WorldScale);
  u.shoreFoamV2AnimSpeed   = uniform(LAKE_DEFAULTS.shoreFoamV2AnimSpeed);
  u.shoreFoamV2ScrollV     = uniform(LAKE_DEFAULTS.shoreFoamV2ScrollV);
  u.shoreFoamV2AnisoX      = uniform(LAKE_DEFAULTS.shoreFoamV2AnisoX);
  u.shoreFoamV2AnisoZ      = uniform(LAKE_DEFAULTS.shoreFoamV2AnisoZ);
  u.shoreFoamV2WarpScale   = uniform(LAKE_DEFAULTS.shoreFoamV2WarpScale);
  u.shoreFoamV2WarpStrength= uniform(LAKE_DEFAULTS.shoreFoamV2WarpStrength);
  u.shoreFoamV2FineScale   = uniform(LAKE_DEFAULTS.shoreFoamV2FineScale);
  u.shoreFoamV2FineAmt     = uniform(LAKE_DEFAULTS.shoreFoamV2FineAmt);
  u.shoreFoamV2FineSpeed   = uniform(LAKE_DEFAULTS.shoreFoamV2FineSpeed);
  u.shoreFoamV2Contrast    = uniform(LAKE_DEFAULTS.shoreFoamV2Contrast);
  u.shoreFoamV2Cutoff      = uniform(LAKE_DEFAULTS.shoreFoamV2Cutoff);
  u.shoreFoamV2TransitionWidth = uniform(LAKE_DEFAULTS.shoreFoamV2TransitionWidth);
  u.shoreFoamV2VoronoiMix      = uniform(LAKE_DEFAULTS.shoreFoamV2VoronoiMix);
  u.shoreFoamV2VoronoiJitter   = uniform(LAKE_DEFAULTS.shoreFoamV2VoronoiJitter);
  u.shoreFoamV2VoronoiScale    = uniform(LAKE_DEFAULTS.shoreFoamV2VoronoiScale);
  u.shoreFoamV2VoronoiRadius   = uniform(LAKE_DEFAULTS.shoreFoamV2VoronoiRadius);
  u.shoreFoamV2VoronoiContrast = uniform(LAKE_DEFAULTS.shoreFoamV2VoronoiContrast);
  u.shoreFoamV2Color           = uniform(new THREE.Color(LAKE_DEFAULTS.shoreFoamV2Color));

  // Shore contact transparency
  u.shoreContactEnabled    = uniform(LAKE_DEFAULTS.shoreContactEnabled ? 1 : 0);
  u.shoreContactBandWidth  = uniform(LAKE_DEFAULTS.shoreContactBandWidth);
  u.shoreContactAlphaMul   = uniform(LAKE_DEFAULTS.shoreContactAlphaMul);
  u.shoreContactNoiseScale = uniform(LAKE_DEFAULTS.shoreContactNoiseScale);
  u.shoreContactNoiseAmp   = uniform(LAKE_DEFAULTS.shoreContactNoiseAmp);
  u.shoreContactCurve      = uniform(LAKE_DEFAULTS.shoreContactCurve);

  // Foam delay
  u.shoreFoamDelayEnabled  = uniform(LAKE_DEFAULTS.shoreFoamDelayEnabled ? 1 : 0);
  u.shoreFoamDelayStart    = uniform(LAKE_DEFAULTS.shoreFoamDelayStart);
  u.shoreFoamDelaySoft     = uniform(LAKE_DEFAULTS.shoreFoamDelaySoft);

  // Foam colours
  u.foamColor       = uniform(new THREE.Color(LAKE_DEFAULTS.foamColor));
  u.glowColor       = uniform(new THREE.Color(LAKE_DEFAULTS.glowColor));
  u.lineWidth       = uniform(LAKE_DEFAULTS.lineWidth);
  u.glowWidth       = uniform(LAKE_DEFAULTS.glowWidth);
  u.waterlineIntensity = uniform(LAKE_DEFAULTS.waterlineIntensity);

  u.lakeDebugNoPrimaryFoam  = uniform(LAKE_DEFAULTS.lakeDebugNoPrimaryFoam ? 1 : 0);
  u.lakeDebugNoWaterline    = uniform(LAKE_DEFAULTS.lakeDebugNoWaterline ? 1 : 0);
  u.lakeDebugNoShoreContact = uniform(LAKE_DEFAULTS.lakeDebugNoShoreContact ? 1 : 0);
  u.lakeDebugNoReflection   = uniform(LAKE_DEFAULTS.lakeDebugNoReflection ? 1 : 0);
  u.lakeDebugNoFresnelSky   = uniform(LAKE_DEFAULTS.lakeDebugNoFresnelSky ? 1 : 0);
  u.lakeDebugNoSurfNormals  = uniform(LAKE_DEFAULTS.lakeDebugNoSurfNormals ? 1 : 0);

  // Terrain size for heightmap UV
  const uTerrainSize = uniform(terrainSize);

  // ── Heightmap-based shore depth ────────────────────────────────────────────
  // Returns how far water is above terrain at this XZ (positive = water, negative = shore/land)
  const shoreDepthFn = Fn(() => {
    const hUV = vec2(
      positionWorld.x.div(uTerrainSize).add(0.5),
      positionWorld.z.div(uTerrainSize).add(0.5),
    );
    const terrainWorldY = texture(heightTex, hUV).r;
    return u.waterY.sub(terrainWorldY); // positive = water above terrain
  });

  /** Bilinear-safe height sample at world XZ (for slope). */
  const _terrainHAtXZ = Fn(([wx, wz]) => {
    const hUV = vec2(
      wx.div(uTerrainSize).add(0.5),
      wz.div(uTerrainSize).add(0.5),
    );
    const uvc = vec2(
      clamp(hUV.x, float(0.008), float(0.992)),
      clamp(hUV.y, float(0.008), float(0.992)),
    );
    return texture(heightTex, uvc).r;
  });

  /** |∇h| in world units (≈0 flat beach, large on cliffs). */
  const terrainSlopeMagFn = Fn(() => {
    const eps = max(u.shoreSlopeSampleEps, float(0.04));
    const x = positionWorld.x;
    const z = positionWorld.z;
    const hxp = _terrainHAtXZ(x.add(eps), z);
    const hxm = _terrainHAtXZ(x.sub(eps), z);
    const hzp = _terrainHAtXZ(x, z.add(eps));
    const hzm = _terrainHAtXZ(x, z.sub(eps));
    const dhdx = hxp.sub(hxm).div(eps.mul(2));
    const dhdz = hzp.sub(hzm).div(eps.mul(2));
    return length(vec2(dhdx, dhdz));
  });

  // ── Shore foam V1 layer masks (+ inward pulse rings y/z) ───────────────────
  const shoreFoamLayerMasks = Fn(([wXZ, distS]) => {
    const absD = abs(distS);
    const foamBase = float(1).sub(smoothstep(float(0), u.shoreFoamWidth, absD));
    const foamShaped = pow(max(foamBase, float(0.0001)), u.shoreFoamSharpness);

    const shoreScroll = vec2(
      u.time.mul(u.shoreNoiseAnimSpeed),
      u.time.mul(u.shoreNoiseAnimSpeed.mul(u.shoreNoiseScrollV)),
    );
    const wAniso = vec2(wXZ.x.mul(u.shoreNoiseAnisoX), wXZ.y.mul(u.shoreNoiseAnisoZ));
    const shoreUVMain = wAniso.mul(u.shoreNoiseWorldScale).add(shoreScroll);
    const shoreUVFine = wAniso.mul(u.shoreNoiseFineScale).add(
      vec2(u.time.mul(u.shoreNoiseFineSpeed), u.time.mul(u.shoreNoiseFineSpeed.mul(0.71))),
    );

    // Perlin path
    const foamN0 = mx_noise_float(shoreUVMain);
    const foamN1 = mx_noise_float(shoreUVFine);
    const foamNPerlin = foamN0.add(foamN1.mul(u.shoreNoiseFineAmt)).mul(u.shoreNoiseContrast);

    // Worley FBM path
    const uvWorPri = shoreUVMain.toVar();
    const wWarpP = uvWorPri.mul(u.shoreWorleyWarpScale);
    const sw1 = _valueFbm5(wWarpP);
    const sw2 = _valueFbm5(wWarpP.add(vec2(4, 4)));
    uvWorPri.addAssign(vec2(sw1.sub(0.5), sw2.sub(0.5)).mul(u.shoreWorleyWarpStrength));
    const nWorPri = _worleyFbm5(uvWorPri, u.shoreWorleyJitter).toVar();
    nWorPri.assign(pow(nWorPri, u.shoreWorleyContrast));
    nWorPri.assign(smoothstep(u.shoreWorleyThreshold, u.shoreWorleyThreshold.add(u.shoreWorleySoftness), nWorPri));
    nWorPri.mulAssign(u.shoreWorleyBrightness);
    const worleyFoam01 = nWorPri.saturate();
    const perlinFoam01 = foamNPerlin.mul(0.5).add(0.5).saturate();

    const foamNoise01 = mix(perlinFoam01, worleyFoam01, u.shoreFoamNoiseMode);
    const noiseBlend = mix(float(1), foamNoise01, u.shoreFoamNoiseAmt);
    const unifiedFoam = foamShaped.mul(noiseBlend).saturate();
    const tw = max(u.shoreFoamTransitionWidth, float(0.02));
    const bandLo = max(u.shoreJaggedCutoff.sub(tw), float(0));
    const bandHi = min(u.shoreJaggedCutoff.add(tw), float(1));
    const shorePrimaryA = smoothstep(bandLo, bandHi, unifiedFoam).mul(u.shoreFoamIntensity).saturate();

    const distInLake = max(float(0), distS);
    const pulseRange = u.shorePulseMaxRange;
    const pulseNoiseXY = vec2(
      u.time.mul(u.shorePulseNoiseAnimSpeed),
      u.time.mul(u.shorePulseNoiseAnimSpeed.mul(float(0.72))),
    );
    const wPAniso = vec2(
      wXZ.x.mul(u.shorePulseNoiseAnisoX),
      wXZ.y.mul(u.shorePulseNoiseAnisoZ),
    );
    const pulseUVMain = wPAniso.mul(u.shorePulseNoiseScale).add(pulseNoiseXY);
    const pulseNPerlin = mx_noise_float(pulseUVMain);
    const uvWorA = pulseUVMain.toVar();
    const wWarpA = uvWorA.mul(u.shoreWorleyWarpScale);
    const sa1 = _valueFbm5(wWarpA);
    const sa2 = _valueFbm5(wWarpA.add(vec2(4, 4)));
    uvWorA.addAssign(vec2(sa1.sub(0.5), sa2.sub(0.5)).mul(u.shoreWorleyWarpStrength));
    const nWorA = _worleyFbm5(uvWorA, u.shoreWorleyJitter).toVar();
    nWorA.assign(pow(nWorA, u.shoreWorleyContrast));
    nWorA.assign(
      smoothstep(
        u.shoreWorleyThreshold,
        u.shoreWorleyThreshold.add(u.shoreWorleySoftness),
        nWorA,
      ),
    );
    nWorA.mulAssign(u.shoreWorleyBrightness);
    const pulseNWorley = nWorA;
    const pulseModN = mix(
      pulseNPerlin.mul(0.5).add(0.5),
      pulseNWorley,
      u.shorePulseNoiseMode,
    );
    const pulseMod = mix(float(1), pulseModN, u.shorePulseNoiseAmt);

    const pulseT0 = fract(u.time.mul(u.shorePulseAnimSpeed));
    const pulseT = pow(pulseT0, max(u.shorePulseTravelPower, float(0.001)));
    const pulseFront = pulseT.mul(pulseRange);
    const pulseRingRaw = float(1).sub(
      smoothstep(float(0), u.shorePulseRingWidth, abs(distInLake.sub(pulseFront))),
    );
    const pulseRing = pow(
      max(pulseRingRaw.mul(pulseMod), float(0.0001)),
      u.shorePulseRingSharpness,
    );
    const pulseFade = pow(float(1).sub(pulseT0), u.shorePulseFade);
    const pulseA = pulseRing
      .mul(pulseFade)
      .mul(u.shorePulseIntensity)
      .mul(step(u.shorePulseMinDist, distInLake));

    const pulseT02 = fract(u.time.mul(u.shorePulseAnimSpeed).add(u.shorePulseStagger));
    const pulseT2 = pow(pulseT02, max(u.shorePulseTravelPower, float(0.001)));
    const pulseFront2 = pulseT2.mul(pulseRange);
    const ringW2 = u.shorePulseRingWidth.mul(u.shorePulseRing2WidthMul);
    const pulseRing2Raw = float(1).sub(
      smoothstep(float(0), ringW2, abs(distInLake.sub(pulseFront2))),
    );
    const pulseUVMain2 = wPAniso
      .mul(u.shorePulseNoiseScale.mul(float(1.07)))
      .add(pulseNoiseXY.mul(float(1.03)));
    const pulseN2Perlin = mx_noise_float(pulseUVMain2);
    const uvWorB = pulseUVMain2.toVar();
    const wWarpB = uvWorB.mul(u.shoreWorleyWarpScale);
    const sb1 = _valueFbm5(wWarpB);
    const sb2 = _valueFbm5(wWarpB.add(vec2(4, 4)));
    uvWorB.addAssign(vec2(sb1.sub(0.5), sb2.sub(0.5)).mul(u.shoreWorleyWarpStrength));
    const nWorB = _worleyFbm5(uvWorB, u.shoreWorleyJitter).toVar();
    nWorB.assign(pow(nWorB, u.shoreWorleyContrast));
    nWorB.assign(
      smoothstep(
        u.shoreWorleyThreshold,
        u.shoreWorleyThreshold.add(u.shoreWorleySoftness),
        nWorB,
      ),
    );
    nWorB.mulAssign(u.shoreWorleyBrightness);
    const pulseN2Worley = nWorB;
    const pulseMod2N = mix(
      pulseN2Perlin.mul(0.5).add(0.5),
      pulseN2Worley,
      u.shorePulseNoiseMode,
    );
    const pulseMod2 = mix(float(1), pulseMod2N, u.shorePulseNoiseAmt);
    const pulseRing2 = pow(
      max(pulseRing2Raw.mul(pulseMod2), float(0.0001)),
      u.shorePulseRing2Sharpness,
    );
    const pulseFade2 = pow(float(1).sub(pulseT02), u.shorePulse2Fade);
    const pulseB = pulseRing2
      .mul(pulseFade2)
      .mul(u.shorePulse2Intensity)
      .mul(step(u.shorePulseMinDist, distInLake));

    const en = u.shorePulseEnabled;
    return vec3(shorePrimaryA, pulseA.mul(en), pulseB.mul(en));
  });

  // ── Shore foam V2 ──────────────────────────────────────────────────────────
  const shoreFoamV2Mask = Fn(([wXZ, distS]) => {
    const absD = abs(distS);
    const foamBase = float(1).sub(smoothstep(float(0), u.shoreFoamV2Width, absD));
    const foamShaped = pow(max(foamBase, float(0.0001)), u.shoreFoamV2Sharpness);

    const scroll = vec2(
      u.time.mul(u.shoreFoamV2AnimSpeed),
      u.time.mul(u.shoreFoamV2AnimSpeed.mul(u.shoreFoamV2ScrollV)),
    );
    const wAniso = vec2(wXZ.x.mul(u.shoreFoamV2AnisoX), wXZ.y.mul(u.shoreFoamV2AnisoZ));
    const uvMain = wAniso.mul(u.shoreFoamV2WorldScale).add(scroll);
    const uvFine = wAniso.mul(u.shoreFoamV2FineScale).add(
      vec2(u.time.mul(u.shoreFoamV2FineSpeed), u.time.mul(u.shoreFoamV2FineSpeed.mul(0.71))),
    );

    // Domain warp
    const uvWarp = uvMain.toVar();
    const warpBase = uvWarp.mul(u.shoreFoamV2WarpScale).toVar();
    const w1 = _vnoise2(warpBase);
    const w2 = _vnoise2(warpBase.add(vec2(13.1, 7.7)));
    uvWarp.addAssign(vec2(w1.sub(0.5), w2.sub(0.5)).mul(u.shoreFoamV2WarpStrength));

    const nMain = _vnoise2(uvWarp);
    const nFine = _vnoise2(uvFine.add(vec2(w2.sub(0.5), w1.sub(0.5)).mul(u.shoreFoamV2WarpStrength)));
    const nMix = mix(nMain, nFine, u.shoreFoamV2FineAmt).saturate();
    const valueFoam01 = pow(max(nMix, float(0.0001)), u.shoreFoamV2Contrast).saturate();

    // Voronoi F1 bubbly foam
    const voroUv = uvWarp.mul(u.shoreFoamV2VoronoiScale);
    const f1 = _voronoiF1Jitter(voroUv, u.shoreFoamV2VoronoiJitter);
    const voroCell01 = float(1).sub(smoothstep(float(0), u.shoreFoamV2VoronoiRadius, f1)).saturate();
    const voronoiFoam01 = pow(max(voroCell01, float(0.0001)), u.shoreFoamV2VoronoiContrast).saturate();

    const foamNoise01 = mix(valueFoam01, voronoiFoam01, u.shoreFoamV2VoronoiMix).saturate();
    const noiseBlend = mix(float(1), foamNoise01, u.shoreFoamV2NoiseAmt);
    const unified = foamShaped.mul(noiseBlend).saturate();
    const tw = max(u.shoreFoamV2TransitionWidth, float(0.02));
    const bandLo = max(u.shoreFoamV2Cutoff.sub(tw), float(0));
    const bandHi = min(u.shoreFoamV2Cutoff.add(tw), float(1));
    return smoothstep(bandLo, bandHi, unified).mul(u.shoreFoamV2Intensity).saturate();
  });

  // ── Fragment shader ────────────────────────────────────────────────────────
  const lakeFrag = Fn(() => {
    const worldXZ = positionWorld.xz;

    // ── Depth-based colour (heightmap) ───────────────────────────────────────
    const distShore = shoreDepthFn(); // positive = water above terrain
    const shallowDepth = max(float(0), distShore);
    const depthBlendColor = float(1)
      .sub(exp(shallowDepth.mul(u.depthAbsorb).negate()))
      .saturate();
    const depthBlendAlpha = float(1)
      .sub(exp(shallowDepth.mul(u.depthAlphaAbsorb).negate()))
      .saturate();
    const slopeLo = min(u.shoreSlopeBeach, u.shoreSlopeCliff);
    const slopeHi = max(u.shoreSlopeBeach, u.shoreSlopeCliff);
    const cliffBlend = smoothstep(slopeLo, slopeHi, terrainSlopeMagFn()).mul(
      u.shoreSlopeShallowEnabled,
    );
    const beachKeepPale = float(1).sub(cliffBlend.mul(u.shallowPaleSlopeDampen));
    const paleLift = vec3(0.12, 0.19, 0.21);
    const shoreTint = u.shoreColor
      .add(paleLift.mul(u.shallowPale).mul(beachKeepPale))
      .saturate();
    const kneeLo = min(u.depthRampShoreMid, u.depthRampMidDeep);
    const kneeHi = max(u.depthRampShoreMid, u.depthRampMidDeep);
    const tDepth = depthBlendColor;
    const wShoreMid = smoothstep(float(0), max(kneeLo, float(0.02)), tDepth);
    const wMidDeep = smoothstep(min(kneeHi, float(0.98)), float(1), tDepth);
    const cMidBand = mix(shoreTint, u.midColor, wShoreMid);
    const absorptionBase = mix(cMidBand, u.deepColor, wMidDeep).saturate();

    // ── Open-water anime Voronoi (optional “caustic foam” tint) ─────────────
    const tNoiseCf = u.time.mul(u.causticFoamNoiseTime);
    const noiseUVCf = worldXZ
      .mul(u.causticFoamNoiseScale)
      .add(vec2(tNoiseCf.mul(u.causticFoamNoiseFlow), float(0)));
    const noiseFacCf = _fbm2(noiseUVCf);
    const distortCf = vec2(noiseFacCf.sub(0.5), noiseFacCf.sub(0.5)).mul(
      u.causticFoamDistort,
    );
    const uvVoroCf = worldXZ
      .mul(u.causticFoamScale)
      .add(vec2(u.causticFoamFlowX.mul(tNoiseCf), u.causticFoamFlowZ.mul(tNoiseCf)))
      .add(distortCf);
    const f1Cf = _animeVoronoiF1(uvVoroCf, tNoiseCf, u.causticFoamCellSpeed);
    const sf1Cf = _animeVoronoiSmoothF1(
      uvVoroCf,
      tNoiseCf,
      u.causticFoamCellSpeed,
      u.causticFoamSmoothness,
    );
    const edgeCf = f1Cf.sub(sf1Cf);
    const tCellCf = smoothstep(
      u.causticFoamEdgeThreshold.sub(u.causticFoamEdgeSoftness),
      u.causticFoamEdgeThreshold.add(u.causticFoamEdgeSoftness),
      edgeCf,
    );
    const safeMpCf = max(u.causticFoamMidPos, float(0.0001));
    const seg0Cf = clamp(tCellCf.div(safeMpCf), float(0), float(1));
    const seg1Cf = clamp(
      tCellCf.sub(safeMpCf).div(float(1).sub(safeMpCf).add(float(0.0001))),
      float(0),
      float(1),
    );
    const inSeg1Cf = smoothstep(safeMpCf.sub(0.001), safeMpCf.add(0.001), tCellCf);
    const midLiftCf = mix(absorptionBase, u.midColor, float(0.35));
    const causticFoamLayer = mix(
      mix(absorptionBase, midLiftCf, seg0Cf),
      mix(midLiftCf, u.causticFoamColor, seg1Cf),
      inSeg1Cf,
    );
    const absorptionColor = mix(
      absorptionBase,
      causticFoamLayer,
      u.causticFoamBlend.mul(u.causticFoamEnabled),
    );

    // ── Procedural surface normals (dual-layer mx_noise_float gradients) ─────
    const nSpd = max(u.procNoiseSpeed, float(0.001));
    const scrollN1 = vec2(
      u.time.mul(u.surfNoiseSpeed1.mul(nSpd)),
      u.time.mul(u.surfNoiseSpeed1.mul(0.71).mul(nSpd)),
    );
    const scrollN2 = vec2(
      u.time.mul(u.surfNoiseSpeed2.mul(nSpd)),
      u.time.mul(u.surfNoiseSpeed2.mul(-0.63).mul(nSpd)),
    );
    const uvN1 = worldXZ.mul(u.surfNoiseScale1).add(scrollN1);
    const uvN2 = worldXZ.mul(u.surfNoiseScale2).add(scrollN2);
    const epsN = float(0.065);
    const s10  = mx_noise_float(uvN1);
    const s1px = mx_noise_float(uvN1.add(vec2(epsN, 0)));
    const s1pz = mx_noise_float(uvN1.add(vec2(0, epsN)));
    const s20  = mx_noise_float(uvN2);
    const s2px = mx_noise_float(uvN2.add(vec2(epsN.mul(1.15), 0)));
    const s2pz = mx_noise_float(uvN2.add(vec2(0, epsN.mul(1.15))));
    const g1x = s1px.sub(s10);
    const g1z = s1pz.sub(s10);
    const g2x = s2px.sub(s20);
    const g2z = s2pz.sub(s20);
    const dnx = g1x.add(g2x.mul(0.62)).mul(u.surfNormalStrength);
    const dnz = g1z.add(g2z.mul(0.62)).mul(u.surfNormalStrength);
    const worldNPerturbed = normalize(vec3(dnx.negate(), float(1), dnz.negate()));
    const flatUp = vec3(float(0), float(1), float(0));
    const worldN = normalize(
      mix(flatUp, worldNPerturbed, float(1).sub(u.lakeDebugNoSurfNormals)),
    );

    // ── Fresnel (perturbed normal) ───────────────────────────────────────────
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const NdotV   = max(dot(worldN, viewDir), float(0.001));
    const fresnel = pow(float(1).sub(saturate(NdotV)), u.fresnelExp);
    const fresnelSkyMul = float(1).sub(u.lakeDebugNoFresnelSky);
    const absorptionSky = absorptionColor.add(
      u.highlightColor.mul(fresnel).mul(u.fresnelSky).mul(fresnelSkyMul),
    );

    // ── Planar reflections (host provides RT + VP matrix) ──────────────────
    const clipR  = u.reflectVP.mul(vec4(positionWorld, float(1)));
    const wClip  = clipR.w;
    const ndcR   = clipR.xy.div(max(abs(wClip), float(1e-4)));
    const uvR0   = ndcR.mul(0.5).add(0.5);
    // Distort with surface normal perturbation + flip Y
    const uvR    = vec2(uvR0.x, float(1).sub(uvR0.y))
      .add(vec2(dnx, dnz).mul(u.reflectDistort));
    const uvRc   = vec2(
      clamp(uvR.x, float(0.02), float(0.98)),
      clamp(uvR.y, float(0.02), float(0.98)),
    );
    const reflSample = texture(u.reflectTex, uvRc).rgb;
    const reflFront  = step(float(0), wClip); // only in front of reflect cam
    const reflAmt    = fresnel
      .mul(u.reflectStrength)
      .mul(reflFront)
      .mul(u.reflectEnabled)
      .mul(float(1).sub(u.lakeDebugNoReflection));
    const surfaceColor = mix(absorptionSky, reflSample, reflAmt);

    // ── Alpha ────────────────────────────────────────────────────────────────
    // `depthAlphaAbsorb` can exceed color absorb so deep water goes solid while staying pale→teal.
    // Steep terrain (cliffs) damps shallow α so deep pools beside rocks don’t read as “glass beach”.
    const depthAlphaLift = pow(depthBlendAlpha, float(0.88)).saturate();
    const baseAlphaThin = mix(u.shallowAlpha, float(1), depthAlphaLift);
    const alphaDepthThin = mix(
      baseAlphaThin,
      float(1),
      cliffBlend.mul(u.shallowAlphaSlopeDampen),
    );
    const waterAlpha = u.deepOpacity.mul(u.opacity).mul(alphaDepthThin);

    // ── Shore contact transparency ───────────────────────────────────────────
    // Silhouette: ramp wet from slightly negative distShore (heightmap vs mesh mismatch).
    // Depth: smoothstep band, then pow(contactRaw, curve) for a soft shoulder (no hard inner rim).
    // Noise: two octaves + edge-gated weight so the boundary doesn’t sparkle/crawl.
    const contactOn = u.shoreContactEnabled.mul(float(1).sub(u.lakeDebugNoShoreContact));
    const shoreEdgeBias = max(u.shoreContactBandWidth.mul(0.28), float(0.05));
    const shoreWet = smoothstep(shoreEdgeBias.negate(), float(0), distShore);
    const contactBandLin = float(1).sub(smoothstep(float(0), u.shoreContactBandWidth, shallowDepth));
    const contactRaw = contactBandLin.mul(shoreWet);
    const curve = clamp(u.shoreContactCurve, float(0.32), float(1));
    const contactBlend = pow(max(contactRaw, float(1e-5)), curve);
    const nUv = worldXZ.mul(u.shoreContactNoiseScale).add(vec2(u.time.mul(0.31), u.time.mul(-0.27)));
    const nContactLo = mx_noise_float(nUv).mul(0.5).add(0.5);
    const nContactHi = mx_noise_float(nUv.mul(0.53).add(vec2(19.2, 8.7))).mul(0.5).add(0.5);
    const nContact = nContactLo.mul(0.58).add(nContactHi.mul(0.42));
    const noiseEdge = pow(max(contactRaw, float(0)), float(1.22));
    const noiseW = noiseEdge.mul(u.shoreContactNoiseAmp).mul(contactOn);
    const contactBlendSlope = contactBlend.mul(
      float(1).sub(cliffBlend.mul(u.shoreContactSlopeDampen)),
    );
    const alphaContactMul = mix(
      float(1),
      u.shoreContactAlphaMul,
      contactBlendSlope.mul(contactOn),
    );
    const alphaNoiseWobble = mix(float(1), nContact, noiseW);
    const finalAlpha = waterAlpha.mul(alphaContactMul).mul(alphaNoiseWobble);

    // ── Shore foam V1 (heightmap-based) + pulse masks .y / .z ─────────────────
    const shoreLayers = shoreFoamLayerMasks(worldXZ, distShore);
    const shorePrimaryOld = shoreLayers.x;

    // ── Shore foam V2 (independent) ──────────────────────────────────────────
    const shorePrimaryV2 = shoreFoamV2Mask(worldXZ, distShore);
    const useV2 = u.shoreFoamV2Enabled;
    const shorePrimary = mix(shorePrimaryOld, shorePrimaryV2, useV2);
    const pulseAMask = shoreLayers.y.mul(float(1).sub(useV2));
    const pulseBMask = shoreLayers.z.mul(float(1).sub(useV2));

    // ── Foam delay ramp ──────────────────────────────────────────────────────
    const foamDelayRamp = mix(
      float(1),
      smoothstep(u.shoreFoamDelayStart, u.shoreFoamDelayStart.add(u.shoreFoamDelaySoft), shallowDepth),
      u.shoreFoamDelayEnabled,
    );
    const pMask = shorePrimary.mul(foamDelayRamp);
    // Primary shore foam also peaks at abs(distShore)≈0 (same kernel as foamBase). With default
    // white shorePrimaryFoamColor that stacks as a jagged bright line at the heightmap zero-crossing
    // (triangle edges), independent of waterlineIntensity. Fade it in over a thin band when
    // shore contact transparency is on so the edge reads as alpha contact, not additive foam.
    const absDistShore = abs(distShore);
    const primaryFoamRimW = max(u.shoreContactBandWidth.mul(0.18), float(0.022));
    const primaryFoamRimFade = mix(
      float(1),
      smoothstep(float(0), primaryFoamRimW, absDistShore),
      contactOn,
    );
    const pMaskFinal = pMask.mul(primaryFoamRimFade);

    // ── Simple waterline glow (heightmap-based) ──────────────────────────────
    const terrainAbove = distShore.negate(); // positive = terrain above water
    const onShore = step(float(0), terrainAbove);
    const line = float(1).sub(smoothstep(float(0), u.lineWidth, terrainAbove)).mul(onShore);
    const glow = exp(terrainAbove.div(max(u.glowWidth, float(0.001))).mul(-1)).mul(onShore);
    const foamAlphaRaw = saturate(max(line, glow.mul(0.5)).mul(u.waterlineIntensity));
    // Waterline `line` peaks at terrainAbove≈0; additive foamCol then reads as a bright rim on
    // top of shore-contact alpha. When contact is on: ramp in from 0 (kills bilinear spikes)
    // and fade where contactBlend is strong so transparency meets terrain without a white band.
    const waterlineRampInW = max(u.shoreContactBandWidth.mul(0.4), u.lineWidth.mul(0.15));
    const waterlineShoreFade = mix(
      float(1),
      smoothstep(float(0), waterlineRampInW, terrainAbove),
      contactOn,
    );
    const waterlineContactFade = float(1).sub(contactBlend.mul(contactOn));
    const foamAlpha = foamAlphaRaw
      .mul(waterlineShoreFade)
      .mul(waterlineContactFade)
      .mul(float(1).sub(u.lakeDebugNoWaterline));
    const foamCol = mix(u.glowColor, u.foamColor, line);

    // ── Composite ────────────────────────────────────────────────────────────
    const primaryFoamColor = mix(u.shorePrimaryFoamColor, u.shoreFoamV2Color, useV2);
    const primaryFoamMul = float(1).sub(u.lakeDebugNoPrimaryFoam);
    const afterFoam = surfaceColor
      .add(foamCol.mul(foamAlpha))
      .add(primaryFoamColor.mul(pMaskFinal).mul(primaryFoamMul));
    const afterPulseA = mix(
      afterFoam,
      u.shorePulseFoamColor,
      min(float(1), pulseAMask.mul(u.shorePulseOpacity)),
    );
    const finalColor = mix(
      afterPulseA,
      u.shorePulse2FoamColor,
      min(float(1), pulseBMask.mul(u.shorePulse2Opacity)),
    ).saturate();

    return vec4(finalColor, finalAlpha);
  });

  // ── Vertex shader (displacement) ───────────────────────────────────────────
  const lakeVert = Fn(() => {
    const wp  = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
    const wxz = wp.xz;
    const t   = u.time.mul(u.surfRippleSpeed);

    // Sine ripples
    const w1 = sin(wxz.x.mul(u.surfRippleFreq).add(t));
    const w2 = cos(wxz.y.mul(u.surfRippleFreq.mul(1.17)).sub(t.mul(0.82)));
    const hWave = w1.add(w2.mul(0.55)).mul(u.surfRippleAmp).mul(u.surfRippleEnabled);

    // Procedural noise displacement
    const vnSpd = max(u.procNoiseSpeed, float(0.001));
    const vertScroll = vec2(
      u.time.mul(u.vertNoiseSpeedX.mul(vnSpd)),
      u.time.mul(u.vertNoiseSpeedZ.mul(vnSpd)),
    );
    const vertUV = wxz.mul(u.vertNoiseScale).add(vertScroll);
    const nA = mx_noise_float(vertUV);
    const nB = mx_noise_float(
      vertUV.mul(1.73).add(vec2(u.time.mul(float(0.11).mul(vnSpd)), u.time.mul(float(-0.15).mul(vnSpd)))),
    );
    const hNoise = nA.sub(0.5).mul(0.62).add(nB.sub(0.5).mul(0.38)).mul(u.vertNoiseAmp);

    const h = hWave.add(hNoise);
    const wNew = wp.add(vec3(0, h, 0));
    return modelWorldMatrixInverse.mul(vec4(wNew, 1)).xyz;
  });

  // ── Build material ─────────────────────────────────────────────────────────
  const fragOut = lakeFrag();
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    positionNode: lakeVert(),
    colorNode:   fragOut.rgb,
    opacityNode: fragOut.a,
  });

  // ── Bob state ──────────────────────────────────────────────────────────────
  let bobBaseY   = 0;
  let bobEnabled = LAKE_DEFAULTS.bobEnabled;
  let bobAmp     = LAKE_DEFAULTS.bobAmplitude;
  let bobHz      = LAKE_DEFAULTS.bobHz;
  let bobAmp2    = LAKE_DEFAULTS.bobSecondaryAmp;
  let bobHz2     = LAKE_DEFAULTS.bobSecondaryHz;

  // ── syncParams: push a PARAMS-like object into uniforms ────────────────────
  function syncParams(p) {
    const c = (hex, target) => target.set(hex);

    if (p.shoreColor != null)      c(p.shoreColor,      u.shoreColor.value);
    if (p.midColor != null)        c(p.midColor,        u.midColor.value);
    if (p.deepColor != null)       c(p.deepColor,       u.deepColor.value);
    if (p.highlightColor != null)  c(p.highlightColor,  u.highlightColor.value);
    if (p.depthRampShoreMid != null) u.depthRampShoreMid.value = p.depthRampShoreMid;
    if (p.depthRampMidDeep != null)  u.depthRampMidDeep.value  = p.depthRampMidDeep;
    if (p.opacity != null)         u.opacity.value         = p.opacity;
    if (p.deepOpacity != null)     u.deepOpacity.value     = p.deepOpacity;

    if (p.surfNoiseScale1 != null)    u.surfNoiseScale1.value    = p.surfNoiseScale1;
    if (p.surfNoiseScale2 != null)    u.surfNoiseScale2.value    = p.surfNoiseScale2;
    if (p.surfNoiseSpeed1 != null)    u.surfNoiseSpeed1.value    = p.surfNoiseSpeed1;
    if (p.surfNoiseSpeed2 != null)    u.surfNoiseSpeed2.value    = p.surfNoiseSpeed2;
    if (p.procNoiseSpeed != null)     u.procNoiseSpeed.value     = p.procNoiseSpeed;
    if (p.surfNormalStrength != null)  u.surfNormalStrength.value = p.surfNormalStrength;

    if (p.fresnelExp != null)      u.fresnelExp.value      = p.fresnelExp;
    if (p.fresnelSky != null)      u.fresnelSky.value      = p.fresnelSky;

    if (p.depthAbsorb != null)      u.depthAbsorb.value      = p.depthAbsorb;
    if (p.depthAlphaAbsorb != null) u.depthAlphaAbsorb.value = p.depthAlphaAbsorb;
    if (p.shallowPale != null)     u.shallowPale.value     = p.shallowPale;
    if (p.shallowAlpha != null)    u.shallowAlpha.value    = p.shallowAlpha;
    if (p.shoreSlopeShallowEnabled != null) u.shoreSlopeShallowEnabled.value = p.shoreSlopeShallowEnabled ? 1 : 0;
    if (p.shoreSlopeSampleEps != null)      u.shoreSlopeSampleEps.value      = p.shoreSlopeSampleEps;
    if (p.shoreSlopeBeach != null)          u.shoreSlopeBeach.value          = p.shoreSlopeBeach;
    if (p.shoreSlopeCliff != null)          u.shoreSlopeCliff.value          = p.shoreSlopeCliff;
    if (p.shallowAlphaSlopeDampen != null)  u.shallowAlphaSlopeDampen.value  = p.shallowAlphaSlopeDampen;
    if (p.shoreContactSlopeDampen != null)  u.shoreContactSlopeDampen.value  = p.shoreContactSlopeDampen;
    if (p.shallowPaleSlopeDampen != null)   u.shallowPaleSlopeDampen.value   = p.shallowPaleSlopeDampen;

    if (p.reflectEnabled != null)  u.reflectEnabled.value  = p.reflectEnabled ? 1 : 0;
    if (p.reflectStrength != null) u.reflectStrength.value = p.reflectStrength;
    if (p.reflectDistort != null)  u.reflectDistort.value  = p.reflectDistort;

    if (p.causticFoamEnabled != null)       u.causticFoamEnabled.value       = p.causticFoamEnabled ? 1 : 0;
    if (p.causticFoamBlend != null)         u.causticFoamBlend.value         = p.causticFoamBlend;
    if (p.causticFoamScale != null)         u.causticFoamScale.value         = p.causticFoamScale;
    if (p.causticFoamSmoothness != null)    u.causticFoamSmoothness.value    = p.causticFoamSmoothness;
    if (p.causticFoamEdgeThreshold != null) u.causticFoamEdgeThreshold.value = p.causticFoamEdgeThreshold;
    if (p.causticFoamEdgeSoftness != null)  u.causticFoamEdgeSoftness.value  = p.causticFoamEdgeSoftness;
    if (p.causticFoamFlowX != null)         u.causticFoamFlowX.value         = p.causticFoamFlowX;
    if (p.causticFoamFlowZ != null)         u.causticFoamFlowZ.value         = p.causticFoamFlowZ;
    if (p.causticFoamCellSpeed != null)     u.causticFoamCellSpeed.value     = p.causticFoamCellSpeed;
    if (p.causticFoamNoiseScale != null)    u.causticFoamNoiseScale.value    = p.causticFoamNoiseScale;
    if (p.causticFoamNoiseTime != null)     u.causticFoamNoiseTime.value     = p.causticFoamNoiseTime;
    if (p.causticFoamNoiseFlow != null)     u.causticFoamNoiseFlow.value     = p.causticFoamNoiseFlow;
    if (p.causticFoamDistort != null)       u.causticFoamDistort.value       = p.causticFoamDistort;
    if (p.causticFoamMidPos != null)        u.causticFoamMidPos.value        = p.causticFoamMidPos;
    if (p.causticFoamColor != null)         c(p.causticFoamColor, u.causticFoamColor.value);

    if (p.vertNoiseAmp != null)    u.vertNoiseAmp.value    = p.vertNoiseAmp;
    if (p.vertNoiseScale != null)  u.vertNoiseScale.value  = p.vertNoiseScale;
    if (p.vertNoiseSpeedX != null) u.vertNoiseSpeedX.value = p.vertNoiseSpeedX;
    if (p.vertNoiseSpeedZ != null) u.vertNoiseSpeedZ.value = p.vertNoiseSpeedZ;
    if (p.surfRippleEnabled != null) u.surfRippleEnabled.value = p.surfRippleEnabled ? 1 : 0;
    if (p.surfRippleAmp != null)   u.surfRippleAmp.value   = p.surfRippleAmp;
    if (p.surfRippleFreq != null)  u.surfRippleFreq.value  = p.surfRippleFreq;
    if (p.surfRippleSpeed != null) u.surfRippleSpeed.value = p.surfRippleSpeed;

    // Bob (CPU-side)
    if (p.bobEnabled != null)      bobEnabled = p.bobEnabled;
    if (p.bobAmplitude != null)    bobAmp     = p.bobAmplitude;
    if (p.bobHz != null)           bobHz      = p.bobHz;
    if (p.bobSecondaryAmp != null) bobAmp2    = p.bobSecondaryAmp;
    if (p.bobSecondaryHz != null)  bobHz2     = p.bobSecondaryHz;

    // Shore V1
    if (p.shoreFoamWidth != null)        u.shoreFoamWidth.value        = p.shoreFoamWidth;
    if (p.shoreFoamNoise != null)        u.shoreFoamNoiseAmt.value     = p.shoreFoamNoise;
    if (p.shoreFoamIntensity != null)    u.shoreFoamIntensity.value    = p.shoreFoamIntensity;
    if (p.shoreFoamSharpness != null)    u.shoreFoamSharpness.value    = p.shoreFoamSharpness;
    if (p.shoreNoiseWorldScale != null)  u.shoreNoiseWorldScale.value  = p.shoreNoiseWorldScale;
    if (p.shoreNoiseAnimSpeed != null)   u.shoreNoiseAnimSpeed.value   = p.shoreNoiseAnimSpeed;
    if (p.shoreNoiseScrollV != null)     u.shoreNoiseScrollV.value     = p.shoreNoiseScrollV;
    if (p.shoreNoiseContrast != null)    u.shoreNoiseContrast.value    = p.shoreNoiseContrast;
    if (p.shoreNoiseFineScale != null)   u.shoreNoiseFineScale.value   = p.shoreNoiseFineScale;
    if (p.shoreNoiseFineAmt != null)     u.shoreNoiseFineAmt.value     = p.shoreNoiseFineAmt;
    if (p.shoreNoiseFineSpeed != null)   u.shoreNoiseFineSpeed.value   = p.shoreNoiseFineSpeed;
    if (p.shoreJaggedCutoff != null)     u.shoreJaggedCutoff.value     = p.shoreJaggedCutoff;
    if (p.shoreFoamTransitionWidth != null) u.shoreFoamTransitionWidth.value = p.shoreFoamTransitionWidth;
    if (p.shoreFoamNoiseStyle != null)   u.shoreFoamNoiseMode.value    = p.shoreFoamNoiseStyle === "voronoiFbm" ? 1 : 0;
    if (p.shoreNoiseAnisoX != null)      u.shoreNoiseAnisoX.value      = p.shoreNoiseAnisoX;
    if (p.shoreNoiseAnisoZ != null)      u.shoreNoiseAnisoZ.value      = p.shoreNoiseAnisoZ;
    if (p.shoreWorleyJitter != null)     u.shoreWorleyJitter.value     = p.shoreWorleyJitter;
    if (p.shoreWorleyWarpScale != null)  u.shoreWorleyWarpScale.value  = p.shoreWorleyWarpScale;
    if (p.shoreWorleyWarpStrength != null) u.shoreWorleyWarpStrength.value = p.shoreWorleyWarpStrength;
    if (p.shoreWorleyContrast != null)   u.shoreWorleyContrast.value   = p.shoreWorleyContrast;
    if (p.shoreWorleyThreshold != null)  u.shoreWorleyThreshold.value  = p.shoreWorleyThreshold;
    if (p.shoreWorleySoftness != null)   u.shoreWorleySoftness.value   = p.shoreWorleySoftness;
    if (p.shoreWorleyBrightness != null) u.shoreWorleyBrightness.value = p.shoreWorleyBrightness;
    if (p.shoreFoamVoroSmoothness != null) u.shoreFoamVoroSmoothness.value = p.shoreFoamVoroSmoothness;
    if (p.shoreFoamVoroCellSpeed != null)  u.shoreFoamVoroCellSpeed.value  = p.shoreFoamVoroCellSpeed;
    if (p.shoreFoamVoroEdgeGain != null)   u.shoreFoamVoroEdgeGain.value   = p.shoreFoamVoroEdgeGain;
    if (p.shoreFoamVoroFbmWeight != null)  u.shoreFoamVoroFbmWeight.value  = p.shoreFoamVoroFbmWeight;
    if (p.shorePrimaryFoamColor != null) c(p.shorePrimaryFoamColor, u.shorePrimaryFoamColor.value);

    if (p.shorePulseNoiseStyle != null) {
      u.shorePulseNoiseMode.value = p.shorePulseNoiseStyle === "voronoiFbm" ? 1 : 0;
    }
    if (p.shorePulseNoiseAnisoX != null) u.shorePulseNoiseAnisoX.value = p.shorePulseNoiseAnisoX;
    if (p.shorePulseNoiseAnisoZ != null) u.shorePulseNoiseAnisoZ.value = p.shorePulseNoiseAnisoZ;
    if (p.shorePulseOpacity != null) u.shorePulseOpacity.value = p.shorePulseOpacity;
    if (p.shorePulse2Opacity != null) u.shorePulse2Opacity.value = p.shorePulse2Opacity;
    if (p.shorePulseFoamColor != null) c(p.shorePulseFoamColor, u.shorePulseFoamColor.value);
    if (p.shorePulse2FoamColor != null) c(p.shorePulse2FoamColor, u.shorePulse2FoamColor.value);
    if (p.shorePulseEnabled != null) u.shorePulseEnabled.value = p.shorePulseEnabled ? 1 : 0;
    if (p.shorePulseAnimSpeed != null) u.shorePulseAnimSpeed.value = p.shorePulseAnimSpeed;
    if (p.shorePulseMaxRange != null) u.shorePulseMaxRange.value = p.shorePulseMaxRange;
    if (p.shorePulseTravelPower != null) u.shorePulseTravelPower.value = p.shorePulseTravelPower;
    if (p.shorePulseMinDist != null) u.shorePulseMinDist.value = p.shorePulseMinDist;
    if (p.shorePulseRingWidth != null) u.shorePulseRingWidth.value = p.shorePulseRingWidth;
    if (p.shorePulseRing2WidthMul != null) u.shorePulseRing2WidthMul.value = p.shorePulseRing2WidthMul;
    if (p.shorePulseIntensity != null) u.shorePulseIntensity.value = p.shorePulseIntensity;
    if (p.shorePulseFade != null) u.shorePulseFade.value = p.shorePulseFade;
    if (p.shorePulseStagger != null) u.shorePulseStagger.value = p.shorePulseStagger;
    if (p.shorePulse2Intensity != null) u.shorePulse2Intensity.value = p.shorePulse2Intensity;
    if (p.shorePulse2Fade != null) u.shorePulse2Fade.value = p.shorePulse2Fade;
    if (p.shorePulseNoiseAmt != null) u.shorePulseNoiseAmt.value = p.shorePulseNoiseAmt;
    if (p.shorePulseNoiseScale != null) u.shorePulseNoiseScale.value = p.shorePulseNoiseScale;
    if (p.shorePulseNoiseAnimSpeed != null) u.shorePulseNoiseAnimSpeed.value = p.shorePulseNoiseAnimSpeed;
    if (p.shorePulseRingSharpness != null) u.shorePulseRingSharpness.value = p.shorePulseRingSharpness;
    if (p.shorePulseRing2Sharpness != null) u.shorePulseRing2Sharpness.value = p.shorePulseRing2Sharpness;

    // Shore V2
    if (p.shoreFoamV2Enabled != null)     u.shoreFoamV2Enabled.value     = p.shoreFoamV2Enabled ? 1 : 0;
    if (p.shoreFoamV2Width != null)       u.shoreFoamV2Width.value       = p.shoreFoamV2Width;
    if (p.shoreFoamV2Intensity != null)   u.shoreFoamV2Intensity.value   = p.shoreFoamV2Intensity;
    if (p.shoreFoamV2Sharpness != null)   u.shoreFoamV2Sharpness.value  = p.shoreFoamV2Sharpness;
    if (p.shoreFoamV2NoiseAmt != null)    u.shoreFoamV2NoiseAmt.value    = p.shoreFoamV2NoiseAmt;
    if (p.shoreFoamV2WorldScale != null)  u.shoreFoamV2WorldScale.value  = p.shoreFoamV2WorldScale;
    if (p.shoreFoamV2AnimSpeed != null)   u.shoreFoamV2AnimSpeed.value   = p.shoreFoamV2AnimSpeed;
    if (p.shoreFoamV2ScrollV != null)     u.shoreFoamV2ScrollV.value     = p.shoreFoamV2ScrollV;
    if (p.shoreFoamV2AnisoX != null)      u.shoreFoamV2AnisoX.value      = p.shoreFoamV2AnisoX;
    if (p.shoreFoamV2AnisoZ != null)      u.shoreFoamV2AnisoZ.value      = p.shoreFoamV2AnisoZ;
    if (p.shoreFoamV2WarpScale != null)   u.shoreFoamV2WarpScale.value   = p.shoreFoamV2WarpScale;
    if (p.shoreFoamV2WarpStrength != null) u.shoreFoamV2WarpStrength.value = p.shoreFoamV2WarpStrength;
    if (p.shoreFoamV2FineScale != null)   u.shoreFoamV2FineScale.value   = p.shoreFoamV2FineScale;
    if (p.shoreFoamV2FineAmt != null)     u.shoreFoamV2FineAmt.value     = p.shoreFoamV2FineAmt;
    if (p.shoreFoamV2FineSpeed != null)   u.shoreFoamV2FineSpeed.value   = p.shoreFoamV2FineSpeed;
    if (p.shoreFoamV2Contrast != null)    u.shoreFoamV2Contrast.value    = p.shoreFoamV2Contrast;
    if (p.shoreFoamV2Cutoff != null)      u.shoreFoamV2Cutoff.value      = p.shoreFoamV2Cutoff;
    if (p.shoreFoamV2TransitionWidth != null) u.shoreFoamV2TransitionWidth.value = p.shoreFoamV2TransitionWidth;
    if (p.shoreFoamV2VoronoiMix != null)      u.shoreFoamV2VoronoiMix.value      = p.shoreFoamV2VoronoiMix;
    if (p.shoreFoamV2VoronoiJitter != null)   u.shoreFoamV2VoronoiJitter.value   = p.shoreFoamV2VoronoiJitter;
    if (p.shoreFoamV2VoronoiScale != null)    u.shoreFoamV2VoronoiScale.value    = p.shoreFoamV2VoronoiScale;
    if (p.shoreFoamV2VoronoiRadius != null)   u.shoreFoamV2VoronoiRadius.value   = p.shoreFoamV2VoronoiRadius;
    if (p.shoreFoamV2VoronoiContrast != null) u.shoreFoamV2VoronoiContrast.value = p.shoreFoamV2VoronoiContrast;
    if (p.shoreFoamV2Color != null)       c(p.shoreFoamV2Color, u.shoreFoamV2Color.value);

    // Contact
    if (p.shoreContactEnabled != null)    u.shoreContactEnabled.value    = p.shoreContactEnabled ? 1 : 0;
    if (p.shoreContactBandWidth != null)  u.shoreContactBandWidth.value  = p.shoreContactBandWidth;
    if (p.shoreContactAlphaMul != null)   u.shoreContactAlphaMul.value   = p.shoreContactAlphaMul;
    if (p.shoreContactNoiseScale != null) u.shoreContactNoiseScale.value = p.shoreContactNoiseScale;
    if (p.shoreContactNoiseAmp != null)   u.shoreContactNoiseAmp.value   = p.shoreContactNoiseAmp;
    if (p.shoreContactCurve != null)      u.shoreContactCurve.value      = p.shoreContactCurve;

    // Foam delay
    if (p.shoreFoamDelayEnabled != null)  u.shoreFoamDelayEnabled.value  = p.shoreFoamDelayEnabled ? 1 : 0;
    if (p.shoreFoamDelayStart != null)    u.shoreFoamDelayStart.value    = p.shoreFoamDelayStart;
    if (p.shoreFoamDelaySoft != null)     u.shoreFoamDelaySoft.value     = p.shoreFoamDelaySoft;

    // Foam colours
    if (p.foamColor != null)         c(p.foamColor,  u.foamColor.value);
    if (p.glowColor != null)         c(p.glowColor,  u.glowColor.value);
    if (p.lineWidth != null)         u.lineWidth.value         = p.lineWidth;
    if (p.glowWidth != null)         u.glowWidth.value         = p.glowWidth;
    if (p.waterlineIntensity != null) u.waterlineIntensity.value = p.waterlineIntensity;

    if (p.lakeDebugNoPrimaryFoam != null)   u.lakeDebugNoPrimaryFoam.value   = p.lakeDebugNoPrimaryFoam ? 1 : 0;
    if (p.lakeDebugNoWaterline != null)     u.lakeDebugNoWaterline.value     = p.lakeDebugNoWaterline ? 1 : 0;
    if (p.lakeDebugNoShoreContact != null)  u.lakeDebugNoShoreContact.value  = p.lakeDebugNoShoreContact ? 1 : 0;
    if (p.lakeDebugNoReflection != null)    u.lakeDebugNoReflection.value    = p.lakeDebugNoReflection ? 1 : 0;
    if (p.lakeDebugNoFresnelSky != null)    u.lakeDebugNoFresnelSky.value    = p.lakeDebugNoFresnelSky ? 1 : 0;
    if (p.lakeDebugNoSurfNormals != null)   u.lakeDebugNoSurfNormals.value   = p.lakeDebugNoSurfNormals ? 1 : 0;
  }

  /**
   * Call each frame. Advances time, computes bob offset.
   * @param {number} dt    — delta time in seconds
   * @param {number} elapsed — total elapsed seconds
   * @param {THREE.Mesh[]} meshes — lake body meshes to bob
   */
  let _prevBobOffset = 0;

  function update(dt, elapsed, meshes) {
    u.time.value = elapsed;

    if (!meshes || meshes.length === 0) return;

    if (bobEnabled) {
      const bobOffset =
        Math.sin(elapsed * bobHz * Math.PI * 2) * bobAmp +
        Math.sin(elapsed * bobHz2 * Math.PI * 2) * bobAmp2;
      // Apply delta-bob so gizmo moves are preserved
      const delta = bobOffset - _prevBobOffset;
      for (const m of meshes) m.position.y += delta;
      _prevBobOffset = bobOffset;
    }
    // Always sync waterY so shore foam knows the surface height
    u.waterY.value = meshes[0].position.y;
  }

  return { material, uniforms: u, syncParams, update };
}
