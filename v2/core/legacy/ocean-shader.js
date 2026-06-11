/**
 * ocean-shader.js — Stylized LOD ocean shader (TSL / WebGPU)
 *
 * Designed for a single map-covering ocean surface built from camera-centered
 * LOD ring tiles (geo-clipmap). One material instance is shared across every
 * ring mesh — all shading and displacement are world-space, so recentering the
 * tiles on the camera each frame is seamless.
 *
 * Features:
 *   - Three-stop turquoise depth ramp (shore → mid → deep) from seabed sample.
 *     Islands are simply terrain that rises above `waterY`.
 *   - Dual-layer mx_noise_float gradient normals (fine surface detail)
 *   - Dual-cascade Tessendorf FFT displacement (swell JONSWAP + ripple Phillips)
 *     with gradient-matched normals; Jacobian break mask × Voronoi/FBM foam detail
 *   - Optional Gerstner swell overlay (vertex) with analytic per-pixel normal.
 *     Displacement is faded out by camera distance, so far LOD rings stay flat.
 *   - Image-based environment reflections (PMREM sky) with wave-perturbed normals
 *   - Shore wave damping from terrain heightmap (waves fade in shallow surf / on land)
 *   - Subsurface scattering approximation on backlit wave crests
 *   - Optional sun-glint specular highlight off the wave normal
 *   - Perturbed, bounded Fresnel — grazing angles tint toward `deepColor`
 *   - Animated coastal foam band at the shoreline
 *   - Open-water-outside-terrain fallback: fragments beyond the heightmap read
 *     as deep, eliminating the "invalid sample horizon" problem
 *
 * GEOMETRY CONTRACT: ring meshes must lie in the XZ plane (y = 0 locally) and
 * be transformed by translation only (no rotation/scale). The vertex stage adds
 * world-space displacement directly to the local position, which is only valid
 * when local XZ == world XZ up to a translation.
 *
 * Usage:
 *   import { createOceanShader, OCEAN_DEFAULTS } from "./ocean-shader.js";
 *   const ocean = createOceanShader({ heightTex, terrainSize: 1600 });
 *   const mesh  = new THREE.Mesh(ringGeoXZ, ocean.material); // share material
 *   // Each frame:
 *   ocean.uniforms.waterY.value = seaY;
 *   ocean.update(dt, elapsedSec, [mesh]);
 *   // To push a PARAMS object:
 *   ocean.syncParams(PARAMS.ocean);
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn, uniform, float, vec2, vec3, vec4,
  mix, smoothstep, sin, cos, sqrt, dot, length, round, fract, floor,
  min, max, exp, abs, pow, saturate, clamp,
  normalize, texture, attribute, positionWorld, positionLocal, modelWorldMatrix,
  cameraPosition, mx_noise_float, pmremTexture, Loop, If,
} from "three/tsl";

const TWO_PI = 6.2831853;
const GRAVITY = 9.8;
/** Number of Gerstner waves summed (unrolled). */
const N_WAVES = 6;
/** Deterministic per-wave direction offsets in [-1,1] (scaled by windSpread). */
const WAVE_DIR_OFFSET = [0.0, 0.65, -0.5, 0.28, -0.82, 0.45];

// ─── Voronoi + FBM foam noise (domain-warped Worley) ─────────────────────────
const foamHash22 = Fn(([p]) => {
  const px = dot(p, vec2(127.1, 311.7));
  const py = dot(p, vec2(269.5, 183.3));
  return fract(sin(vec2(px, py)).mul(43758.5453));
});

const foamHash21 = Fn(([p]) =>
  fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)),
);

const foamValueNoise2D = Fn(([pIm]) => {
  const p = pIm.toVar();
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = foamHash21(i);
  const b = foamHash21(i.add(vec2(1.0, 0.0)));
  const c = foamHash21(i.add(vec2(0.0, 1.0)));
  const d = foamHash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

/** Voronoi F1 — 3×3 search unrolled in JS to avoid WGSL loop scoping artifacts. */
const foamVoronoiF1 = Fn(([pIm]) => {
  const ip = floor(pIm).toVar();
  const fp = fract(pIm).toVar();
  const md = float(10.0).toVar();
  for (const [nx, ny] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
    const cellOffset = vec2(float(nx), float(ny));
    const rnd = foamHash22(ip.add(cellOffset));
    md.assign(min(md, length(cellOffset.add(rnd).sub(fp))));
  }
  return md;
});

const foamWorleyFbm = Fn(([pIm]) => {
  const p = pIm.toVar();
  const value = float(0.0).toVar();
  const amp = float(0.5).toVar();
  const totalAmp = float(0.0).toVar();
  Loop(5, () => {
    value.addAssign(foamVoronoiF1(p).mul(amp));
    totalAmp.addAssign(amp);
    p.assign(p.mul(2.0));
    amp.assign(amp.mul(0.5));
  });
  return value.div(totalAmp);
});

const foamValueFbm = Fn(([pIm]) => {
  const p = pIm.toVar();
  const value = float(0.0).toVar();
  const amp = float(1.0).toVar();
  const totalAmp = float(0.0).toVar();
  Loop(5, () => {
    value.addAssign(amp.mul(foamValueNoise2D(p)));
    totalAmp.addAssign(amp);
    p.assign(p.mul(2.3));
    amp.assign(amp.mul(0.4));
  });
  return value.div(totalAmp);
});

// ─── Defaults ────────────────────────────────────────────────────────────────
export const OCEAN_DEFAULTS = {
  // Depth ramp colours (three-stop: shore → mid → deep)
  /** Very shallow tint — where water just covers the seabed. */
  shoreColor:        "#8fe5d8",
  /** Mid turquoise — the main colour most pixels read. */
  midColor:          "#2ca8a8",
  /** Deep open-ocean colour — dark teal. */
  deepColor:         "#0b3a4a",
  /** Grazing-angle highlight (tinted toward deep near the horizon). */
  highlightColor:    "#a0e6e0",

  /** exp(-depth * depthAbsorb) drives the ramp. Lower = slower fade to deep. */
  depthAbsorb:        0.14,
  /** Ramp knee in [0..1]: below this is shore→mid blend. */
  depthRampShoreMid:  0.32,
  /** Ramp knee in [0..1]: above this is mid→deep blend. Must be > shoreMid. */
  depthRampMidDeep:   0.68,
  /** Depth used for fragments outside the heightmap bounds. Prevents grey horizon. */
  openOceanDepth:     60.0,

  // ── Shore wave damping (heightmap-driven) ───────────────────────────────────
  shoreDampEnabled:   true,
  /** Water depth (m) where swell begins returning. */
  shoreDampStart:     1.2,
  /** Water depth (m) where swell reaches full strength. */
  shoreDampEnd:       16.0,
  /** Soft land/wet boundary around sea level (m). */
  shoreLandMargin:    0.45,
  /** Vertical wave fraction kept in the surf zone (horizontal damps faster). */
  shoreVertKeep:      0.38,
  /** Extra coastal foam multiplier in the surf zone. */
  shoreSurfFoamBoost: 1.55,
  /** Width (m) of the boosted surf-foam zone from the shoreline. */
  shoreSurfWidth:     4.5,
  /** Environment reflection strength in shallow surf (0 = none). */
  shoreReflDamp:      0.42,
  /** Open-ocean whitecaps fade out in shallow water. */
  shoreWhitecapDamp:  true,

  // Surface normals (fine noise detail)
  surfNoiseScale1:    0.06,
  surfNoiseScale2:    0.13,
  surfNoiseSpeed1:    0.22,
  surfNoiseSpeed2:   -0.16,
  procNoiseSpeed:     1.0,
  surfNormalStrength: 0.14,

  // ── FFT ocean (primary displacement) ───────────────────────────────────────
  fftEnabled:         true,
  fftSwellAmp:        1.15,
  fftRippleAmp:       0.55,
  fftChoppiness:      1.28,
  fftNormalStrength:  1.05,
  /** Wind speed (m/s) — drives JONSWAP spectrum rebuild. */
  windSpeed:          14.0,
  jonswapGamma:       3.3,
  windSpreadPow:      8,
  fftSeed:            1337,
  /** Whitecap foam recovery rate (lower = foam lingers longer). */
  fftFoamDecay:       0.4,

  // ── Whitecap foam (Jacobian break mask × Voronoi/FBM detail) ───────────────
  whitecapEnabled:    true,
  whitecapIntensity:  0.88,
  /** Jacobian below this → foam (lower = more foam). */
  whitecapThreshold:  0.58,
  whitecapSoftness:   0.24,
  /** World-space Worley scale (larger = bigger foam patches). */
  whitecapNoiseScale: 0.38,
  whitecapNoiseSpeed: 0.16,
  /** FBM domain-warp strength / scale for organic foam edges. */
  whitecapWarpStrength: 0.55,
  whitecapWarpScale:    0.2,
  whitecapContrast:     1.55,
  whitecapBrightness:   1.12,
  /** Worley shaping after contrast (cell visibility). */
  whitecapProcThreshold: 0.36,
  whitecapProcSoftness:  0.2,

  // ── Subsurface scattering (crest transmission) ─────────────────────────────
  sssEnabled:         true,
  sssIntensity:       0.42,
  sssColor:           "#48d8b8",

  // ── Gerstner overlay (vertex displacement + analytic normal) ─────────────────
  /** When false, Gerstner overlay is muted so OFF = calm flat sea vs FFT ON. */
  waveEnabled:        true,
  /** Blend 0..1 for optional analytical swells on top of FFT (only when FFT is on). */
  gerstnerBlend:      0.15,
  /** Base amplitude (world units) of the largest Gerstner wave. */
  waveAmp:            0.85,
  /** Base wavelength (world units) of the largest wave. */
  waveLength:         42.0,
  /** Choppiness 0..1 — horizontal pinch at wave crests. */
  waveSteep:          0.62,
  /** Multiplier on the dispersion-derived wave speed. */
  waveSpeed:          0.85,
  /** Dominant wind direction (degrees). */
  windAngleDeg:       38.0,
  /** Directional spread of the wave bank around the wind (degrees). */
  windSpreadDeg:      42.0,
  /** Amplitude falloff per successive (shorter) wave. */
  waveAmpFalloff:     0.82,
  /** Wavelength falloff per successive wave. */
  waveLenFalloff:     0.74,
  /** How strongly the Gerstner slope tilts the shading normal. */
  waveNormalStrength: 0.9,
  /** Camera distance where wave displacement begins fading out. */
  dispFadeStart:      90.0,
  /** Camera distance where wave displacement reaches zero (rings beyond stay flat). */
  dispFadeEnd:        480.0,

  // ── Sun glint (specular off the wave normal) ────────────────────────────────
  glintColor:         "#fff2d8",
  glintIntensity:     0.55,
  glintPower:         180.0,

  // Fresnel (bounded — no sky bleed)
  fresnelExp:         4.2,
  /** Highlight contribution. Keep modest (< 0.5) to avoid pale horizons. */
  fresnelSky:         0.12,
  /** Hard cap on the Fresnel weight before it's used as a colour mix. */
  fresnelMax:         0.72,

  // ── Environment reflections (PMREM sky) ────────────────────────────────────
  envReflectEnabled:  true,
  /** Strength of sky/environment reflection (uses baked scene.environment). */
  envReflectIntensity: 1.05,
  /** PMREM roughness on calm patches (looking down at water). */
  envRoughnessCalm:   0.03,
  /** PMREM roughness on steep / choppy patches and grazing views. */
  envRoughnessRipple: 0.28,

  // ── Horizon atmosphere fade (dissolves the ocean/sky seam at the far edge) ──
  // The flat ocean plane never reaches the true (infinite) horizon, so a thin
  // band of bright sky shows below it. Fading the far water toward a horizon
  // colour hides that seam and adds aerial perspective.
  horizonFadeEnabled: true,
  /** true = fade far water to the actual sky (env) along the view ray (best seam
   *  hide); false = fade to the flat `horizonColor` below. */
  horizonUseSky:      true,
  horizonColor:       "#cdddea",
  /** Camera distance where the fade begins. */
  horizonFadeStart:   1800.0,
  /** Camera distance where water is fully the horizon colour. */
  horizonFadeEnd:     9000.0,

  // ── Underwater (surface seen from below: Snell window + total internal refl) ─
  // `underwaterT` is a live uniform (0 above water → 1 submerged), driven by the
  // host from camera submersion; the rest are look tunables.
  /** cos of the water critical angle (~48.6°): above this verticality = sky window. */
  snellCritCos:       0.66,
  /** Soft width of the Snell-window edge. */
  snellSoft:          0.12,
  /** Brightness of the refracted sky seen through the window. */
  underwaterSkyBoost: 1.1,
  /** TIR (mirror) darkness — scales deepColor outside the window. */
  underwaterMurk:     0.5,

  // Alpha
  opacity:            1.0,

  // Coastal foam
  foamEnabled:        true,
  foamColor:          "#f0fbfa",
  /** World-space half-width of the foam band around the shoreline. */
  foamBandWidth:      2.6,
  foamIntensity:      1.25,
  /** >1 = thinner, crunchier band; <1 = softer. */
  foamSharpness:      1.35,
  /** 0 = solid band, 1 = fully noise-modulated. */
  foamNoiseAmt:       0.78,
  /** Primary noise scale in world-unit^-1 (chunky waves). */
  foamNoiseScale:     0.28,
  foamNoiseSpeed:     0.2,
  foamWarpStrength:   0.5,
  foamWarpScale:      0.24,
  /** Fine detail noise. */
  foamFineScale:      0.9,
  foamFineAmt:        0.34,
  foamFineSpeed:      0.32,
  foamContrast:       1.2,
  /** Mask cutoff (pixels below this fade out). */
  foamCutoff:         0.42,
  foamTransitionWidth:0.14,
  /** Breathing amplitude — pulses the shoreline in/out in world units. */
  foamBreatheAmp:     0.55,
  foamBreatheHz:      0.35,
};

const DEG2RAD = Math.PI / 180;

// ─── Factory ─────────────────────────────────────────────────────────────────
/**
 * @param {object} deps
 * @param {THREE.Texture} deps.heightTex — heightmap DataTexture (R = seabed world Y)
 * @param {number}        deps.terrainSize — world size of the terrain (e.g. 1600)
 * @param {object|null}   deps.fft — from createOceanFFTSimulation()
 * @param {THREE.Texture|null} deps.envMap — PMREM / equirect environment (scene.environment)
 * @returns {{ material, uniforms, syncParams, update, setEnvMap }}
 */
export function createOceanShader({ heightTex, terrainSize, fft = null, envMap = null }) {
  const u = {};

  // Time + water Y (driven from host)
  u.time   = uniform(0);
  u.waterY = uniform(0);

  // Colours
  u.shoreColor     = uniform(new THREE.Color(OCEAN_DEFAULTS.shoreColor));
  u.midColor       = uniform(new THREE.Color(OCEAN_DEFAULTS.midColor));
  u.deepColor      = uniform(new THREE.Color(OCEAN_DEFAULTS.deepColor));
  u.highlightColor = uniform(new THREE.Color(OCEAN_DEFAULTS.highlightColor));

  // Depth ramp
  u.depthAbsorb       = uniform(OCEAN_DEFAULTS.depthAbsorb);
  u.depthRampShoreMid = uniform(OCEAN_DEFAULTS.depthRampShoreMid);
  u.depthRampMidDeep  = uniform(OCEAN_DEFAULTS.depthRampMidDeep);
  u.openOceanDepth    = uniform(OCEAN_DEFAULTS.openOceanDepth);

  // Shore damping
  u.shoreDampEnabled   = uniform(OCEAN_DEFAULTS.shoreDampEnabled ? 1 : 0);
  u.shoreDampStart     = uniform(OCEAN_DEFAULTS.shoreDampStart);
  u.shoreDampEnd       = uniform(OCEAN_DEFAULTS.shoreDampEnd);
  u.shoreLandMargin    = uniform(OCEAN_DEFAULTS.shoreLandMargin);
  u.shoreVertKeep      = uniform(OCEAN_DEFAULTS.shoreVertKeep);
  u.shoreSurfFoamBoost = uniform(OCEAN_DEFAULTS.shoreSurfFoamBoost);
  u.shoreSurfWidth     = uniform(OCEAN_DEFAULTS.shoreSurfWidth);
  u.shoreReflDamp      = uniform(OCEAN_DEFAULTS.shoreReflDamp);
  u.shoreWhitecapDamp  = uniform(OCEAN_DEFAULTS.shoreWhitecapDamp ? 1 : 0);

  // Normals (noise)
  u.surfNoiseScale1    = uniform(OCEAN_DEFAULTS.surfNoiseScale1);
  u.surfNoiseScale2    = uniform(OCEAN_DEFAULTS.surfNoiseScale2);
  u.surfNoiseSpeed1    = uniform(OCEAN_DEFAULTS.surfNoiseSpeed1);
  u.surfNoiseSpeed2    = uniform(OCEAN_DEFAULTS.surfNoiseSpeed2);
  u.procNoiseSpeed     = uniform(OCEAN_DEFAULTS.procNoiseSpeed);
  u.surfNormalStrength = uniform(OCEAN_DEFAULTS.surfNormalStrength);

  // FFT ocean
  u.fftEnabled        = uniform(OCEAN_DEFAULTS.fftEnabled ? 1 : 0);
  u.fftSwellAmp       = uniform(OCEAN_DEFAULTS.fftSwellAmp);
  u.fftRippleAmp      = uniform(OCEAN_DEFAULTS.fftRippleAmp);
  u.fftNormalStrength = uniform(OCEAN_DEFAULTS.fftNormalStrength);

  // Cascade list (2 = zelda swell+ripple, 3 = horvath/Poseidon). Tile sizes are
  // fixed per sim build, so they're compile-time constants here. The look-amp
  // uniforms map to the first/last cascade (historical double-scale parity);
  // middle cascades of a 3+ set ride at 1.
  const fftCascades = fft ? fft.cascades : [];
  const ampForCascade = (i) =>
    i === 0 ? u.fftSwellAmp
      : i === fftCascades.length - 1 ? u.fftRippleAmp
        : float(1);

  // Whitecaps + SSS
  u.whitecapEnabled   = uniform(OCEAN_DEFAULTS.whitecapEnabled ? 1 : 0);
  u.whitecapIntensity = uniform(OCEAN_DEFAULTS.whitecapIntensity);
  u.whitecapThreshold = uniform(OCEAN_DEFAULTS.whitecapThreshold);
  u.whitecapSoftness  = uniform(OCEAN_DEFAULTS.whitecapSoftness);
  u.whitecapNoiseScale     = uniform(OCEAN_DEFAULTS.whitecapNoiseScale);
  u.whitecapNoiseSpeed     = uniform(OCEAN_DEFAULTS.whitecapNoiseSpeed);
  u.whitecapWarpStrength   = uniform(OCEAN_DEFAULTS.whitecapWarpStrength);
  u.whitecapWarpScale      = uniform(OCEAN_DEFAULTS.whitecapWarpScale);
  u.whitecapContrast       = uniform(OCEAN_DEFAULTS.whitecapContrast);
  u.whitecapBrightness     = uniform(OCEAN_DEFAULTS.whitecapBrightness);
  u.whitecapProcThreshold  = uniform(OCEAN_DEFAULTS.whitecapProcThreshold);
  u.whitecapProcSoftness   = uniform(OCEAN_DEFAULTS.whitecapProcSoftness);
  u.sssEnabled        = uniform(OCEAN_DEFAULTS.sssEnabled ? 1 : 0);
  u.sssIntensity      = uniform(OCEAN_DEFAULTS.sssIntensity);
  u.sssColor          = uniform(new THREE.Color(OCEAN_DEFAULTS.sssColor));
  u.gerstnerBlend     = uniform(OCEAN_DEFAULTS.gerstnerBlend);

  // Gerstner waves
  u.waveEnabled        = uniform(OCEAN_DEFAULTS.waveEnabled ? 1 : 0);
  u.waveAmp            = uniform(OCEAN_DEFAULTS.waveAmp);
  u.waveLength         = uniform(OCEAN_DEFAULTS.waveLength);
  u.waveSteep          = uniform(OCEAN_DEFAULTS.waveSteep);
  u.waveSpeed          = uniform(OCEAN_DEFAULTS.waveSpeed);
  u.windAngle          = uniform(OCEAN_DEFAULTS.windAngleDeg * DEG2RAD);
  u.windSpread         = uniform(OCEAN_DEFAULTS.windSpreadDeg * DEG2RAD);
  u.waveAmpFalloff     = uniform(OCEAN_DEFAULTS.waveAmpFalloff);
  u.waveLenFalloff     = uniform(OCEAN_DEFAULTS.waveLenFalloff);
  u.waveNormalStrength = uniform(OCEAN_DEFAULTS.waveNormalStrength);
  u.dispFadeStart      = uniform(OCEAN_DEFAULTS.dispFadeStart);
  u.dispFadeEnd        = uniform(OCEAN_DEFAULTS.dispFadeEnd);

  // Sun glint
  u.sunDir         = uniform(new THREE.Vector3(0.4, 0.55, 0.3).normalize());
  u.glintColor     = uniform(new THREE.Color(OCEAN_DEFAULTS.glintColor));
  u.glintIntensity = uniform(OCEAN_DEFAULTS.glintIntensity);
  u.glintPower     = uniform(OCEAN_DEFAULTS.glintPower);

  // Fresnel
  u.fresnelExp = uniform(OCEAN_DEFAULTS.fresnelExp);
  u.fresnelSky = uniform(OCEAN_DEFAULTS.fresnelSky);
  u.fresnelMax = uniform(OCEAN_DEFAULTS.fresnelMax);

  // Environment reflections
  u.envReflectEnabled   = uniform(OCEAN_DEFAULTS.envReflectEnabled ? 1 : 0);
  u.envReflectIntensity = uniform(OCEAN_DEFAULTS.envReflectIntensity);
  u.envRoughnessCalm    = uniform(OCEAN_DEFAULTS.envRoughnessCalm);
  u.envRoughnessRipple  = uniform(OCEAN_DEFAULTS.envRoughnessRipple);

  const placeholderEnv = new THREE.DataTexture(
    new Uint8Array([186, 210, 228, 255]), 1, 1, THREE.RGBAFormat,
  );
  placeholderEnv.mapping = THREE.EquirectangularReflectionMapping;
  placeholderEnv.needsUpdate = true;
  let envSourceTexture = envMap || placeholderEnv;
  const envPmrem = pmremTexture(envSourceTexture);

  // Horizon fade
  u.horizonFadeEnabled = uniform(OCEAN_DEFAULTS.horizonFadeEnabled ? 1 : 0);
  u.horizonUseSky      = uniform(OCEAN_DEFAULTS.horizonUseSky ? 1 : 0);
  u.horizonColor       = uniform(new THREE.Color(OCEAN_DEFAULTS.horizonColor));
  u.horizonFadeStart   = uniform(OCEAN_DEFAULTS.horizonFadeStart);
  u.horizonFadeEnd     = uniform(OCEAN_DEFAULTS.horizonFadeEnd);

  // Underwater (surface from below)
  u.underwaterT        = uniform(0);
  u.snellCritCos       = uniform(OCEAN_DEFAULTS.snellCritCos);
  u.snellSoft          = uniform(OCEAN_DEFAULTS.snellSoft);
  u.underwaterSkyBoost = uniform(OCEAN_DEFAULTS.underwaterSkyBoost);
  u.underwaterMurk     = uniform(OCEAN_DEFAULTS.underwaterMurk);

  // Alpha
  u.opacity = uniform(OCEAN_DEFAULTS.opacity);

  // Coastal foam
  u.foamEnabled        = uniform(OCEAN_DEFAULTS.foamEnabled ? 1 : 0);
  u.foamColor          = uniform(new THREE.Color(OCEAN_DEFAULTS.foamColor));
  u.foamBandWidth      = uniform(OCEAN_DEFAULTS.foamBandWidth);
  u.foamIntensity      = uniform(OCEAN_DEFAULTS.foamIntensity);
  u.foamSharpness      = uniform(OCEAN_DEFAULTS.foamSharpness);
  u.foamNoiseAmt       = uniform(OCEAN_DEFAULTS.foamNoiseAmt);
  u.foamNoiseScale     = uniform(OCEAN_DEFAULTS.foamNoiseScale);
  u.foamNoiseSpeed     = uniform(OCEAN_DEFAULTS.foamNoiseSpeed);
  u.foamWarpStrength   = uniform(OCEAN_DEFAULTS.foamWarpStrength);
  u.foamWarpScale      = uniform(OCEAN_DEFAULTS.foamWarpScale);
  u.foamFineScale      = uniform(OCEAN_DEFAULTS.foamFineScale);
  u.foamFineAmt        = uniform(OCEAN_DEFAULTS.foamFineAmt);
  u.foamFineSpeed      = uniform(OCEAN_DEFAULTS.foamFineSpeed);
  u.foamContrast       = uniform(OCEAN_DEFAULTS.foamContrast);
  u.foamCutoff         = uniform(OCEAN_DEFAULTS.foamCutoff);
  u.foamTransitionWidth= uniform(OCEAN_DEFAULTS.foamTransitionWidth);
  u.foamBreatheAmp     = uniform(OCEAN_DEFAULTS.foamBreatheAmp);
  u.foamBreatheHz      = uniform(OCEAN_DEFAULTS.foamBreatheHz);

  const uTerrainSize = uniform(terrainSize);

  // ── Gerstner helpers ─────────────────────────────────────────────────────
  // Per-wave parameters derived from the base uniforms (i is a JS int → the
  // direction offset and falloff exponent are compile-time constants).
  function waveParams(i, xz) {
    const Ai = u.waveAmp.mul(pow(u.waveAmpFalloff, float(i)));
    const Li = u.waveLength.mul(pow(u.waveLenFalloff, float(i)));
    const ki = float(TWO_PI).div(max(Li, float(0.001)));
    const angle = u.windAngle.add(u.windSpread.mul(float(WAVE_DIR_OFFSET[i])));
    const Di = vec2(cos(angle), sin(angle));
    const omega = sqrt(float(GRAVITY).mul(ki)).mul(u.waveSpeed);
    const phase = ki.mul(dot(Di, xz)).sub(omega.mul(u.time));
    const Qi = clamp(
      u.waveSteep.div(ki.mul(Ai).mul(float(N_WAVES)).add(float(1e-4))),
      float(0), float(1),
    );
    return { Ai, ki, Di, phase, Qi };
  }

  /** World-space Gerstner displacement (vec3), faded by ampScale. */
  function gerstnerDisp(xz, ampScale) {
    const dx = float(0).toVar();
    const dy = float(0).toVar();
    const dz = float(0).toVar();
    for (let i = 0; i < N_WAVES; i++) {
      const { Ai, Di, phase, Qi } = waveParams(i, xz);
      const cosP = cos(phase);
      const sinP = sin(phase);
      const qa = Qi.mul(Ai);
      dx.addAssign(qa.mul(Di.x).mul(cosP));
      dz.addAssign(qa.mul(Di.y).mul(cosP));
      dy.addAssign(Ai.mul(sinP));
    }
    return vec3(dx, dy, dz).mul(ampScale);
  }

  /** Gerstner slope contribution to the shading normal (vec2 = X/Z tilt). */
  function gerstnerSlope(xz, ampScale) {
    const sx = float(0).toVar();
    const sz = float(0).toVar();
    for (let i = 0; i < N_WAVES; i++) {
      const { Ai, ki, Di, phase } = waveParams(i, xz);
      const wa = ki.mul(Ai);
      const cosP = cos(phase);
      sx.addAssign(Di.x.mul(wa).mul(cosP));
      sz.addAssign(Di.y.mul(wa).mul(cosP));
    }
    const k = ampScale.mul(u.waveNormalStrength);
    return vec2(sx.negate().mul(k), sz.negate().mul(k));
  }

  /** Distance-based displacement fade for a given world XZ. */
  function ampScaleAt(xz) {
    const dist = length(xz.sub(cameraPosition.xz));
    return saturate(
      float(1).sub(smoothstep(u.dispFadeStart, u.dispFadeEnd, dist)),
    );
  }

  /** Heightmap UV + terrain Y at world XZ. */
  function terrainSampleAt(xz) {
    const hUV = vec2(
      xz.x.div(uTerrainSize).add(0.5),
      xz.y.div(uTerrainSize).add(0.5),
    );
    const uvClamped = vec2(
      clamp(hUV.x, float(0.001), float(0.999)),
      clamp(hUV.y, float(0.001), float(0.999)),
    );
    const terrainY = texture(heightTex, uvClamped).r;
    return { terrainY, depthSigned: u.waterY.sub(terrainY) };
  }

  /** 0 on dry land, ramps to 1 in deep water (signed depth = waterY − terrainY). */
  function shoreWaveMask(depthSigned) {
    const wet = smoothstep(
      u.shoreLandMargin.negate(),
      u.shoreLandMargin,
      depthSigned,
    );
    const deep = smoothstep(u.shoreDampStart, u.shoreDampEnd, depthSigned);
    return wet.mul(deep).mul(u.shoreDampEnabled);
  }

  /** Damp horizontal displacement more than vertical near shore. */
  function applyShoreToDisp(disp, mask) {
    const xzMask = mask.mul(mask);
    const yMask = mix(u.shoreVertKeep, float(1), mask);
    return vec3(disp.x.mul(xzMask), disp.y.mul(yMask), disp.z.mul(xzMask));
  }

  // FFT maps are rgba16f storage textures with RepeatWrapping — sample with the
  // RAW (unwrapped) uv so screen-space derivatives stay continuous across tile
  // seams (fract() would break mip selection there).
  /** Tileable FFT displacement sample (dx, height, dz). Vertex stage → no
   *  implicit derivatives, so the mip level is pinned to 0. */
  function fftDispAt(xz, ampScale) {
    if (!fftCascades.length) return vec3(0);
    let sum = vec3(0);
    fftCascades.forEach((c, i) => {
      const d = texture(c.dispTex, xz.div(c.tileSize)).level(0).xyz;
      sum = sum.add(d.mul(ampForCascade(i)));
    });
    return sum.mul(ampScale).mul(u.fftEnabled);
  }

  /** FFT surface slope → normal tilt (x/z). Fragment stage — trilinear automip
   *  keeps far water calm instead of aliasing. Fold-aware (Poseidon/gasgiant):
   *  slope = dDy/dx ÷ (1 + chop·dDx/dx), so pinched crests tilt correctly. */
  function fftSlopeAt(xz, ampScale) {
    if (!fftCascades.length) return vec2(0);
    let sum = vec2(0);
    fftCascades.forEach((c, i) => {
      const d = texture(c.derivTex, xz.div(c.tileSize));
      const g = vec2(
        d.x.div(float(1).add(d.z)),
        d.y.div(float(1).add(d.w)),
      );
      sum = sum.add(g.mul(ampForCascade(i)));
    });
    return sum.mul(u.fftNormalStrength).mul(ampScale).mul(u.fftEnabled);
  }

  /** Jacobian whitecap factor from FFT displacement textures. */
  function worleyFoamPattern(
    xz, scale, speed, warpStr, warpScale, contrast, threshold, softness, brightness,
  ) {
    const scroll = vec2(
      u.time.mul(speed),
      u.time.mul(speed.mul(0.71)),
    );
    const baseUV = xz.mul(scale).add(scroll).toVar();
    const warpUV = baseUV.mul(warpScale);
    const w1 = foamValueFbm(warpUV);
    const w2 = foamValueFbm(warpUV.add(vec2(4.0, 4.0)));
    baseUV.addAssign(vec2(w1.sub(0.5), w2.sub(0.5)).mul(warpStr));
    let n = foamWorleyFbm(baseUV);
    n = pow(saturate(n), contrast);
    n = smoothstep(threshold, threshold.add(softness), n);
    return saturate(n.mul(brightness));
  }

  function fftWhitecapAt(xz, ampScale) {
    if (!fftCascades.length) return float(0);
    // w = accumulated turbulence (snaps down on a Jacobian fold, recovers at
    // fftFoamDecay) — whitecaps linger and dissipate instead of flickering.
    // With 3+ cascades the finest is skipped (constant speckle — Poseidon).
    const foamCascades = fftCascades.length > 2
      ? fftCascades.slice(0, -1) : fftCascades;
    let jMin = texture(foamCascades[0].dispTex, xz.div(foamCascades[0].tileSize)).w;
    for (const c of foamCascades.slice(1)) {
      jMin = min(jMin, texture(c.dispTex, xz.div(c.tileSize)).w);
    }
    const lo = u.whitecapThreshold.sub(u.whitecapSoftness);
    const breaking = float(1).sub(smoothstep(lo, u.whitecapThreshold, jMin));
    // Gate the expensive Worley noise: only breaking crests (and only where
    // whitecaps are enabled + in wave range) ever need it. Calm/far warps skip it.
    const gate = breaking.mul(u.whitecapEnabled).mul(u.fftEnabled).mul(ampScale);
    const detail = float(0).toVar();
    If(gate.greaterThan(float(0.001)), () => {
      detail.assign(worleyFoamPattern(
        xz,
        u.whitecapNoiseScale,
        u.whitecapNoiseSpeed,
        u.whitecapWarpStrength,
        u.whitecapWarpScale,
        u.whitecapContrast,
        u.whitecapProcThreshold,
        u.whitecapProcSoftness,
        u.whitecapBrightness,
      ));
    });
    return breaking.mul(detail).mul(u.whitecapIntensity).mul(ampScale);
  }

  // ── Vertex stage: CDLOD morph + Gerstner displacement ────────────────────
  // Ring meshes carry per-vertex `aCell` (this LOD's cell size) and `aOuterHalf`
  // (this LOD's half-extent). In the outer band of each ring the vertex is
  // morphed onto the next-coarser grid (cell × 2) so the shared edge with the
  // coarser ring matches exactly — this is what kills the LOD seams once waves
  // displace the surface. The mesh transform is translation-only, so local XZ
  // equals world XZ up to the group offset and morphing in local space is valid.
  const oceanPosition = Fn(() => {
    const localXZ = positionLocal.xz;
    const cell = attribute("aCell", "float");
    const outerHalf = max(attribute("aOuterHalf", "float"), float(1e-3));
    // Square (Chebyshev) radius — the ring boundary is a square at outerHalf.
    const cheb = max(abs(localXZ.x), abs(localXZ.y));
    const morphK = saturate(cheb.div(outerHalf).sub(0.75).div(0.25));
    const grid = cell.mul(2);
    const snapXZ = round(localXZ.div(grid)).mul(grid);
    const morphedXZ = mix(localXZ, snapXZ, morphK);

    const worldBase = modelWorldMatrix.mul(vec4(positionLocal, float(1))).xz;
    const worldXZ = worldBase.add(morphedXZ.sub(localXZ));
    const ampScale = ampScaleAt(worldXZ);
    const { depthSigned } = terrainSampleAt(worldXZ);
    const shoreMask = shoreWaveMask(depthSigned);

    const fftDisp = applyShoreToDisp(
      fftDispAt(worldXZ, ampScale),
      shoreMask,
    );
    const gerstner = applyShoreToDisp(
      gerstnerDisp(
        worldXZ,
        ampScale.mul(u.waveEnabled).mul(u.gerstnerBlend).mul(u.fftEnabled),
      ),
      shoreMask,
    );
    return vec3(morphedXZ.x, float(0), morphedXZ.y).add(fftDisp).add(gerstner);
  });

  // ── Fragment shader ────────────────────────────────────────────────────────
  const oceanFrag = Fn(() => {
    const wXZ = positionWorld.xz;

    // Single heightmap sample — reused for depth ramp and foam band.
    // Fragments outside the heightmap UV are forced to "deep" to kill horizon artefacts.
    const hUV = vec2(
      wXZ.x.div(uTerrainSize).add(0.5),
      wXZ.y.div(uTerrainSize).add(0.5),
    );
    const insideX = float(1).sub(
      smoothstep(float(0.95), float(1.0), abs(hUV.x.sub(0.5)).mul(2)),
    );
    const insideZ = float(1).sub(
      smoothstep(float(0.95), float(1.0), abs(hUV.y.sub(0.5)).mul(2)),
    );
    const inside = insideX.mul(insideZ);
    const uvClamped = vec2(
      clamp(hUV.x, float(0.001), float(0.999)),
      clamp(hUV.y, float(0.001), float(0.999)),
    );
    const terrainY = texture(heightTex, uvClamped).r;
    const dShoreRaw = u.waterY.sub(terrainY);            // signed, used for foam band
    const dShore    = mix(u.openOceanDepth, dShoreRaw, inside);
    const depth     = max(dShore, float(0));
    const shoreMask = shoreWaveMask(dShoreRaw).mul(inside);
    const shallowT  = float(1).sub(
      smoothstep(float(0), u.shoreSurfWidth, max(dShoreRaw, float(0))),
    );

    // ── Three-stop depth ramp (shore → mid → deep) ──────────────────────────
    const tDepth = float(1)
      .sub(exp(depth.mul(u.depthAbsorb).negate()))
      .saturate();
    const kneeLo = min(u.depthRampShoreMid, u.depthRampMidDeep);
    const kneeHi = max(u.depthRampShoreMid, u.depthRampMidDeep);
    const wShoreMid = smoothstep(float(0), max(kneeLo, float(0.02)), tDepth);
    const wMidDeep  = smoothstep(min(kneeHi, float(0.98)), float(1), tDepth);
    const cShoreMid = mix(u.shoreColor, u.midColor, wShoreMid);
    const absorption = mix(cShoreMid, u.deepColor, wMidDeep).saturate();

    // ── Dual-layer procedural noise normal (fine detail) ────────────────────
    const nSpd = max(u.procNoiseSpeed, float(0.001));
    const scroll1 = vec2(
      u.time.mul(u.surfNoiseSpeed1.mul(nSpd)),
      u.time.mul(u.surfNoiseSpeed1.mul(0.71).mul(nSpd)),
    );
    const scroll2 = vec2(
      u.time.mul(u.surfNoiseSpeed2.mul(nSpd)),
      u.time.mul(u.surfNoiseSpeed2.mul(-0.63).mul(nSpd)),
    );
    const uvN1 = wXZ.mul(u.surfNoiseScale1).add(scroll1);
    const uvN2 = wXZ.mul(u.surfNoiseScale2).add(scroll2);
    const eps  = float(0.065);
    const s10  = mx_noise_float(uvN1);
    const s1x  = mx_noise_float(uvN1.add(vec2(eps, 0)));
    const s1z  = mx_noise_float(uvN1.add(vec2(0, eps)));
    const s20  = mx_noise_float(uvN2);
    const s2x  = mx_noise_float(uvN2.add(vec2(eps.mul(1.15), 0)));
    const s2z  = mx_noise_float(uvN2.add(vec2(0, eps.mul(1.15))));
    const dnx  = s1x.sub(s10).add(s2x.sub(s20).mul(0.62))
      .mul(u.surfNormalStrength)
      .mul(mix(float(0.25), float(1), u.fftEnabled))
      .mul(shoreMask);
    const dnz  = s1z.sub(s10).add(s2z.sub(s20).mul(0.62))
      .mul(u.surfNormalStrength)
      .mul(mix(float(0.25), float(1), u.fftEnabled))
      .mul(shoreMask);

    // ── FFT + Gerstner wave slopes ───────────────────────────────────────────
    const ampScaleF = ampScaleAt(wXZ).mul(shoreMask);
    const fftSlope = fftSlopeAt(wXZ, ampScaleF);
    const gSlope = gerstnerSlope(
      wXZ,
      ampScaleAt(wXZ)
        .mul(u.waveEnabled)
        .mul(u.gerstnerBlend)
        .mul(u.fftEnabled)
        .mul(shoreMask),
    );
    const worldN = normalize(vec3(
      dnx.negate().add(fftSlope.x.negate()).add(gSlope.x),
      float(1),
      dnz.negate().add(fftSlope.y.negate()).add(gSlope.y),
    ));

    // ── Fresnel + environment reflection (PMREM sky) ─────────────────────────
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const NdotV   = max(dot(worldN, viewDir), float(0.001));
    const fresnelRaw = pow(float(1).sub(saturate(NdotV)), u.fresnelExp);
    const fresnel    = min(fresnelRaw, u.fresnelMax);
    const grazing = saturate(float(1).sub(NdotV));
    const hlCol   = mix(u.highlightColor, u.deepColor, pow(grazing, float(1.2)));
    const skyTint = hlCol.mul(fresnel).mul(u.fresnelSky);

    const reflectDir = viewDir.negate().reflect(worldN).normalize();
    const slopeMag = length(vec2(fftSlope.x, fftSlope.y));
    const envRough = mix(
      u.envRoughnessCalm,
      u.envRoughnessRipple,
      saturate(grazing.mul(0.45).add(slopeMag.mul(0.35))),
    );
    const reflectMixed = pow(envRough, float(4)).mix(reflectDir, worldN).normalize();
    const envRadiance = envPmrem.context({
      getUV: () => reflectMixed,
      getTextureLevel: () => envRough,
    });
    const envRefl = envRadiance
      .mul(fresnel)
      .mul(u.envReflectIntensity)
      .mul(u.envReflectEnabled)
      .mul(mix(float(1), u.shoreReflDamp, shallowT));

    const lit = absorption.add(skyTint).add(envRefl);

    // ── Sun glint (Blinn specular off the wave normal) ──────────────────────
    const halfV = normalize(viewDir.add(u.sunDir));
    const spec  = pow(max(dot(worldN, halfV), float(0)), u.glintPower)
      .mul(u.glintIntensity);
    const withGlint = lit.add(u.glintColor.mul(spec));

    // ── Subsurface scattering (backlit crest transmission) ───────────────────
    const sunDotN = dot(worldN, u.sunDir);
    const crestLit = saturate(sunDotN.negate());
    const viewToSun = saturate(dot(viewDir, u.sunDir.negate()));
    const sss = crestLit.mul(viewToSun).mul(u.sssIntensity).mul(u.sssEnabled);
    const withSss = withGlint.add(u.sssColor.mul(sss));

    // ── Jacobian whitecap foam (open ocean) ──────────────────────────────────
    const whitecap = fftWhitecapAt(wXZ, ampScaleAt(wXZ))
      .mul(mix(float(1), shoreMask, u.shoreWhitecapDamp));
    const withWhitecap = mix(withSss, u.foamColor, whitecap);

    // ── Coastal foam band (Worley/FBM detail on shoreline mask) ─────────────
    const breath = sin(u.time.mul(u.foamBreatheHz).mul(float(TWO_PI)))
      .mul(u.foamBreatheAmp);
    const dShoreBand = dShoreRaw.add(breath);
    const absD       = abs(dShoreBand);
    const bandBase   = float(1).sub(smoothstep(float(0), u.foamBandWidth, absD));
    const bandShaped = pow(max(bandBase, float(0.0001)), u.foamSharpness);

    const scrollF = vec2(
      u.time.mul(u.foamNoiseSpeed),
      u.time.mul(u.foamNoiseSpeed.mul(0.73)),
    );
    // Gate the Worley noise to the shoreline band — open ocean (band ≈ 0) and
    // out-of-bounds fragments skip it entirely.
    const shoreProc = float(0).toVar();
    If(bandShaped.mul(inside).mul(u.foamEnabled).greaterThan(float(0.001)), () => {
      shoreProc.assign(worleyFoamPattern(
        wXZ.add(scrollF.mul(0.15)),
        u.foamNoiseScale,
        u.foamNoiseSpeed,
        u.foamWarpStrength,
        u.foamWarpScale,
        u.foamContrast,
        u.foamCutoff,
        u.foamTransitionWidth,
        float(1),
      ));
    });
    const noiseBlend = mix(float(1), shoreProc, u.foamNoiseAmt);
    const unified  = saturate(bandShaped.mul(noiseBlend));

    const foamMask = saturate(
      unified
        .mul(u.foamIntensity)
        .mul(mix(float(1), u.shoreSurfFoamBoost, shallowT)),
    )
      .mul(u.foamEnabled)
      .mul(inside);

    // ── Composite ───────────────────────────────────────────────────────────
    const composited = mix(withWhitecap, u.foamColor, foamMask).saturate();
    // Aerial-perspective fade to hide the ocean/sky seam at the far edge. Fade
    // target = the actual sky (env) sampled along the view ray, clamped to the
    // horizon, so the far water matches the sky sliver above the geometry edge.
    const horizDist = length(wXZ.sub(cameraPosition.xz));
    const hf = smoothstep(u.horizonFadeStart, u.horizonFadeEnd, horizDist)
      .mul(u.horizonFadeEnabled);
    const horizonTarget = u.horizonColor.toVar();
    If(hf.greaterThan(float(0.001)), () => {
      const vRay = positionWorld.sub(cameraPosition);
      const vDir = normalize(vec3(vRay.x, max(vRay.y, float(0.02)), vRay.z));
      const skyCol = envPmrem.context({
        getUV: () => vDir,
        getTextureLevel: () => float(1.0),
      });
      horizonTarget.assign(mix(u.horizonColor, skyCol, u.horizonUseSky));
    });
    const aboveColor = mix(composited, horizonTarget, hf);

    // ── Underwater: surface seen from below (Snell window + TIR) ─────────────
    // Only when submerged (uniform-gated → free above water). Verticality of the
    // view (|N·V|) selects the bright refracted-sky disc straight up vs. the
    // dark total-internal-reflection mirror toward the horizon; wave normals
    // ripple the boundary and the sun shows through the window.
    const underside = u.deepColor.toVar();
    If(u.underwaterT.greaterThan(float(0.001)), () => {
      const viewDirU = normalize(cameraPosition.sub(positionWorld));
      const cosT = abs(dot(worldN, viewDirU)); // 1 = looking straight up
      const win = smoothstep(
        u.snellCritCos.sub(u.snellSoft),
        u.snellCritCos.add(u.snellSoft),
        cosT,
      );
      const refrDir = normalize(vec3(
        worldN.x.negate().mul(0.6).add(viewDirU.x.mul(0.4)),
        float(1.0),
        worldN.z.negate().mul(0.6).add(viewDirU.z.mul(0.4)),
      ));
      const skyU = envPmrem.context({
        getUV: () => refrDir,
        getTextureLevel: () => float(1.0),
      });
      const sunWin = pow(max(dot(refrDir, u.sunDir), float(0)), float(48)).mul(win);
      const windowCol = skyU.mul(u.underwaterSkyBoost).add(u.glintColor.mul(sunWin.mul(0.7)));
      const tirCol = u.deepColor.mul(u.underwaterMurk);
      underside.assign(mix(tirCol, windowCol, win));
    });

    const finalColor = mix(aboveColor, underside, u.underwaterT);
    return vec4(finalColor, u.opacity);
  });

  // ── Build material ─────────────────────────────────────────────────────────
  // The "see-through" depth look is faked from the heightmap ramp, so at
  // opacity 1 (the normal case) the surface is visually opaque — render it in
  // the OPAQUE pass with depth writes. Early-Z then culls the ocean behind
  // islands AND stops the seabed terrain being shaded just to be painted over
  // (the transparent/depthWrite:false path paid both, full-screen). syncParams
  // flips to the transparent pass only when the user lowers opacity.
  const fragOut = oceanFrag();
  const material = new MeshBasicNodeMaterial({
    transparent: false,
    depthWrite:  true,
    side:        THREE.DoubleSide,
    colorNode:   fragOut.rgb,
    opacityNode: fragOut.a,
    positionNode: oceanPosition(),
  });

  // ── syncParams: accept a PARAMS-like object and push into uniforms ─────────
  function syncParams(p) {
    if (!p) return;
    const c = (hex, target) => target.set(hex);

    if (p.shoreColor     != null) c(p.shoreColor,     u.shoreColor.value);
    if (p.midColor       != null) c(p.midColor,       u.midColor.value);
    if (p.deepColor      != null) c(p.deepColor,      u.deepColor.value);
    if (p.highlightColor != null) c(p.highlightColor, u.highlightColor.value);

    if (p.depthAbsorb        != null) u.depthAbsorb.value        = p.depthAbsorb;
    if (p.depthRampShoreMid  != null) u.depthRampShoreMid.value  = p.depthRampShoreMid;
    if (p.depthRampMidDeep   != null) u.depthRampMidDeep.value   = p.depthRampMidDeep;
    if (p.openOceanDepth     != null) u.openOceanDepth.value     = p.openOceanDepth;

    if (p.shoreDampEnabled   != null) u.shoreDampEnabled.value   = p.shoreDampEnabled ? 1 : 0;
    if (p.shoreDampStart     != null) u.shoreDampStart.value     = p.shoreDampStart;
    if (p.shoreDampEnd       != null) u.shoreDampEnd.value       = p.shoreDampEnd;
    if (p.shoreLandMargin    != null) u.shoreLandMargin.value    = p.shoreLandMargin;
    if (p.shoreVertKeep      != null) u.shoreVertKeep.value      = p.shoreVertKeep;
    if (p.shoreSurfFoamBoost != null) u.shoreSurfFoamBoost.value = p.shoreSurfFoamBoost;
    if (p.shoreSurfWidth     != null) u.shoreSurfWidth.value     = p.shoreSurfWidth;
    if (p.shoreReflDamp      != null) u.shoreReflDamp.value      = p.shoreReflDamp;
    if (p.shoreWhitecapDamp  != null) u.shoreWhitecapDamp.value  = p.shoreWhitecapDamp ? 1 : 0;

    if (p.surfNoiseScale1    != null) u.surfNoiseScale1.value    = p.surfNoiseScale1;
    if (p.surfNoiseScale2    != null) u.surfNoiseScale2.value    = p.surfNoiseScale2;
    if (p.surfNoiseSpeed1    != null) u.surfNoiseSpeed1.value    = p.surfNoiseSpeed1;
    if (p.surfNoiseSpeed2    != null) u.surfNoiseSpeed2.value    = p.surfNoiseSpeed2;
    if (p.procNoiseSpeed     != null) u.procNoiseSpeed.value     = p.procNoiseSpeed;
    if (p.surfNormalStrength != null) u.surfNormalStrength.value = p.surfNormalStrength;

    if (p.fftEnabled        != null) u.fftEnabled.value        = p.fftEnabled ? 1 : 0;
    if (p.fftSwellAmp       != null) u.fftSwellAmp.value       = p.fftSwellAmp;
    if (p.fftRippleAmp      != null) u.fftRippleAmp.value      = p.fftRippleAmp;
    if (p.fftNormalStrength != null) u.fftNormalStrength.value = p.fftNormalStrength;
    if (p.gerstnerBlend     != null) u.gerstnerBlend.value     = p.gerstnerBlend;

    if (p.whitecapEnabled   != null) u.whitecapEnabled.value   = p.whitecapEnabled ? 1 : 0;
    if (p.whitecapIntensity != null) u.whitecapIntensity.value = p.whitecapIntensity;
    if (p.whitecapThreshold != null) u.whitecapThreshold.value = p.whitecapThreshold;
    if (p.whitecapSoftness  != null) u.whitecapSoftness.value  = p.whitecapSoftness;
    if (p.whitecapNoiseScale     != null) u.whitecapNoiseScale.value     = p.whitecapNoiseScale;
    if (p.whitecapNoiseSpeed     != null) u.whitecapNoiseSpeed.value     = p.whitecapNoiseSpeed;
    if (p.whitecapWarpStrength   != null) u.whitecapWarpStrength.value   = p.whitecapWarpStrength;
    if (p.whitecapWarpScale      != null) u.whitecapWarpScale.value      = p.whitecapWarpScale;
    if (p.whitecapContrast       != null) u.whitecapContrast.value       = p.whitecapContrast;
    if (p.whitecapBrightness     != null) u.whitecapBrightness.value     = p.whitecapBrightness;
    if (p.whitecapProcThreshold  != null) u.whitecapProcThreshold.value  = p.whitecapProcThreshold;
    if (p.whitecapProcSoftness   != null) u.whitecapProcSoftness.value   = p.whitecapProcSoftness;
    if (p.sssEnabled        != null) u.sssEnabled.value        = p.sssEnabled ? 1 : 0;
    if (p.sssIntensity      != null) u.sssIntensity.value      = p.sssIntensity;
    if (p.sssColor          != null) c(p.sssColor, u.sssColor.value);

    if (p.waveEnabled        != null) u.waveEnabled.value        = p.waveEnabled ? 1 : 0;
    if (p.waveAmp            != null) u.waveAmp.value            = p.waveAmp;
    if (p.waveLength         != null) u.waveLength.value         = p.waveLength;
    if (p.waveSteep          != null) u.waveSteep.value          = p.waveSteep;
    if (p.waveSpeed          != null) u.waveSpeed.value          = p.waveSpeed;
    if (p.windAngleDeg       != null) u.windAngle.value          = p.windAngleDeg * DEG2RAD;
    if (p.windSpreadDeg      != null) u.windSpread.value         = p.windSpreadDeg * DEG2RAD;
    if (p.waveAmpFalloff     != null) u.waveAmpFalloff.value     = p.waveAmpFalloff;
    if (p.waveLenFalloff     != null) u.waveLenFalloff.value     = p.waveLenFalloff;
    if (p.waveNormalStrength != null) u.waveNormalStrength.value = p.waveNormalStrength;
    if (p.dispFadeStart      != null) u.dispFadeStart.value      = p.dispFadeStart;
    if (p.dispFadeEnd        != null) u.dispFadeEnd.value        = p.dispFadeEnd;

    if (p.glintColor     != null) c(p.glintColor, u.glintColor.value);
    if (p.glintIntensity != null) u.glintIntensity.value = p.glintIntensity;
    if (p.glintPower     != null) u.glintPower.value     = p.glintPower;
    if (p.sunDir         != null) u.sunDir.value.copy(p.sunDir).normalize();

    if (p.fresnelExp != null) u.fresnelExp.value = p.fresnelExp;
    if (p.fresnelSky != null) u.fresnelSky.value = p.fresnelSky;
    if (p.fresnelMax != null) u.fresnelMax.value = p.fresnelMax;

    if (p.envReflectEnabled   != null) u.envReflectEnabled.value   = p.envReflectEnabled ? 1 : 0;
    if (p.envReflectIntensity != null) u.envReflectIntensity.value = p.envReflectIntensity;
    if (p.envRoughnessCalm    != null) u.envRoughnessCalm.value    = p.envRoughnessCalm;
    if (p.envRoughnessRipple  != null) u.envRoughnessRipple.value  = p.envRoughnessRipple;

    if (p.horizonFadeEnabled != null) u.horizonFadeEnabled.value = p.horizonFadeEnabled ? 1 : 0;
    if (p.horizonUseSky      != null) u.horizonUseSky.value = p.horizonUseSky ? 1 : 0;
    if (p.horizonColor       != null) c(p.horizonColor, u.horizonColor.value);
    if (p.horizonFadeStart   != null) u.horizonFadeStart.value = p.horizonFadeStart;
    if (p.horizonFadeEnd     != null) u.horizonFadeEnd.value = p.horizonFadeEnd;

    if (p.snellCritCos       != null) u.snellCritCos.value = p.snellCritCos;
    if (p.snellSoft          != null) u.snellSoft.value = p.snellSoft;
    if (p.underwaterSkyBoost != null) u.underwaterSkyBoost.value = p.underwaterSkyBoost;
    if (p.underwaterMurk     != null) u.underwaterMurk.value = p.underwaterMurk;

    if (p.opacity != null) {
      u.opacity.value = p.opacity;
      const wantTransparent = p.opacity < 0.999;
      if (material.transparent !== wantTransparent) {
        material.transparent = wantTransparent;
        material.depthWrite = !wantTransparent;
        material.needsUpdate = true;
      }
    }

    if (p.foamEnabled         != null) u.foamEnabled.value         = p.foamEnabled ? 1 : 0;
    if (p.foamColor           != null) c(p.foamColor, u.foamColor.value);
    if (p.foamBandWidth       != null) u.foamBandWidth.value       = p.foamBandWidth;
    if (p.foamIntensity       != null) u.foamIntensity.value       = p.foamIntensity;
    if (p.foamSharpness       != null) u.foamSharpness.value       = p.foamSharpness;
    if (p.foamNoiseAmt        != null) u.foamNoiseAmt.value        = p.foamNoiseAmt;
    if (p.foamNoiseScale      != null) u.foamNoiseScale.value      = p.foamNoiseScale;
    if (p.foamNoiseSpeed      != null) u.foamNoiseSpeed.value      = p.foamNoiseSpeed;
    if (p.foamWarpStrength    != null) u.foamWarpStrength.value    = p.foamWarpStrength;
    if (p.foamWarpScale       != null) u.foamWarpScale.value       = p.foamWarpScale;
    if (p.foamFineScale       != null) u.foamFineScale.value       = p.foamFineScale;
    if (p.foamFineAmt         != null) u.foamFineAmt.value         = p.foamFineAmt;
    if (p.foamFineSpeed       != null) u.foamFineSpeed.value       = p.foamFineSpeed;
    if (p.foamContrast        != null) u.foamContrast.value        = p.foamContrast;
    if (p.foamCutoff          != null) u.foamCutoff.value          = p.foamCutoff;
    if (p.foamTransitionWidth != null) u.foamTransitionWidth.value = p.foamTransitionWidth;
    if (p.foamBreatheAmp      != null) u.foamBreatheAmp.value      = p.foamBreatheAmp;
    if (p.foamBreatheHz       != null) u.foamBreatheHz.value       = p.foamBreatheHz;
  }

  /**
   * Call each frame.
   * @param {number}       dt       delta seconds (unused but kept for API parity)
   * @param {number}       elapsed  total elapsed seconds
   * @param {THREE.Mesh[]} meshes   ocean mesh(es) — waterY is read from meshes[0].position.y
   * @param {object|null}  fftSim   optional FFT simulation (syncParams + update handled externally)
   */
  function update(dt, elapsed, meshes, fftSim) {
    u.time.value = elapsed;
    if (meshes && meshes.length > 0) {
      u.waterY.value = meshes[0].position.y;
    }
    if (fftSim) fftSim.update(elapsed);
  }

  /** Update the sky PMREM after rebaking scene.environment. */
  function setEnvMap(tex) {
    if (!tex) return;
    envSourceTexture = tex;
    envPmrem.value = tex;
  }

  return { material, uniforms: u, syncParams, update, setEnvMap, fft };
}
