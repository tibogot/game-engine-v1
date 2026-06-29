/**
 * v3/render/water/oceanShader.js — V3 ocean shader (TSL / WebGPU)
 *
 * Fixes over v2/core/legacy/ocean-shader.js:
 *  1. Accepts `heightTexNode` (live TSL TextureNode from sculptBrush ping-pong)
 *     instead of a static DataTexture, so sculpted terrain is always correct.
 *  2. Multiplies heightmap R channel by `maxHeight` (500) before comparing with
 *     `waterY` — fixes the unit mismatch that made the depth ramp wrong.
 *  3. 8-tap shore-proximity sampling: samples the heightmap in a ring around each
 *     fragment and uses the MINIMUM depth found for the colour ramp.  This makes
 *     the coastal cyan band appear around ALL coastlines in island mode, not just
 *     where the terrain drops to zero right at the tile edge.
 *  4. Analytical sky gradient (zenith → horizon) replaces PMREM env-map
 *     reflections, eliminating the SkyMesh BoxGeometry cube artefact.
 *     Sky colours are pushed each frame via setSkyColors(zenith, horizon).
 *
 * API is identical to v2 worldOcean so only the import line needs changing.
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn, uniform, float, vec2, vec3, vec4,
  mix, smoothstep, sin, cos, sqrt, dot, length, round, fract, floor,
  min, max, exp, abs, pow, saturate, clamp,
  normalize, texture, attribute, positionWorld, positionLocal, modelWorldMatrix,
  cameraPosition, mx_noise_float, Loop, If,
} from "three/tsl";

const TWO_PI  = 6.2831853;
const GRAVITY = 9.8;
const N_WAVES = 6;
const WAVE_DIR_OFFSET = [0.0, 0.65, -0.5, 0.28, -0.82, 0.45];

// ─── Voronoi + FBM foam noise (identical to v2) ───────────────────────────────
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

const foamVoronoiF1 = Fn(([pIm]) => {
  const ip = floor(pIm).toVar();
  const fp = fract(pIm).toVar();
  const md = float(10.0).toVar();
  for (const [nx, ny] of [[-1,-1],[0,-1],[1,-1],[-1,0],[0,0],[1,0],[-1,1],[0,1],[1,1]]) {
    const cellOffset = vec2(float(nx), float(ny));
    const rnd = foamHash22(ip.add(cellOffset));
    md.assign(min(md, length(cellOffset.add(rnd).sub(fp))));
  }
  return md;
});

const foamWorleyFbm = Fn(([pIm]) => {
  const p = pIm.toVar();
  const value = float(0.0).toVar();
  const amp   = float(0.5).toVar();
  const total = float(0.0).toVar();
  Loop(5, () => {
    value.addAssign(foamVoronoiF1(p).mul(amp));
    total.addAssign(amp);
    p.assign(p.mul(2.0));
    amp.assign(amp.mul(0.5));
  });
  return value.div(total);
});

const foamValueFbm = Fn(([pIm]) => {
  const p = pIm.toVar();
  const value = float(0.0).toVar();
  const amp   = float(1.0).toVar();
  const total = float(0.0).toVar();
  Loop(5, () => {
    value.addAssign(amp.mul(foamValueNoise2D(p)));
    total.addAssign(amp);
    p.assign(p.mul(2.3));
    amp.assign(amp.mul(0.4));
  });
  return value.div(total);
});

// ─── Defaults ─────────────────────────────────────────────────────────────────
export const OCEAN_DEFAULTS = {
  shoreColor:        "#8fe5d8",
  midColor:          "#2ca8a8",
  deepColor:         "#0b3a4a",
  highlightColor:    "#a0e6e0",

  depthAbsorb:        0.14,
  depthRampShoreMid:  0.32,
  depthRampMidDeep:   0.68,
  openOceanDepth:     60.0,

  shoreDampEnabled:   true,
  shoreDampStart:     1.2,
  shoreDampEnd:       16.0,
  shoreLandMargin:    0.45,
  shoreVertKeep:      0.38,
  shoreSurfFoamBoost: 1.55,
  shoreSurfWidth:     4.5,
  shoreReflDamp:      0.42,
  shoreWhitecapDamp:  true,

  surfNoiseScale1:    0.06,
  surfNoiseScale2:    0.13,
  surfNoiseSpeed1:    0.22,
  surfNoiseSpeed2:   -0.16,
  procNoiseSpeed:     1.0,
  surfNormalStrength: 0.14,

  fftEnabled:         true,
  fftSwellAmp:        1.15,
  fftRippleAmp:       0.55,
  fftChoppiness:      1.28,
  fftNormalStrength:  1.05,
  windSpeed:          14.0,
  jonswapGamma:       3.3,
  windSpreadPow:      8,
  fftSeed:            1337,
  fftFoamDecay:       0.4,

  whitecapEnabled:        true,
  whitecapIntensity:      0.88,
  whitecapThreshold:      0.58,
  whitecapSoftness:       0.24,
  whitecapNoiseScale:     0.38,
  whitecapNoiseSpeed:     0.16,
  whitecapWarpStrength:   0.55,
  whitecapWarpScale:      0.2,
  whitecapContrast:       1.55,
  whitecapBrightness:     1.12,
  whitecapProcThreshold:  0.36,
  whitecapProcSoftness:   0.2,

  sssEnabled:    true,
  sssIntensity:  0.42,
  sssColor:      "#48d8b8",

  waveEnabled:        true,
  gerstnerBlend:      0.15,
  waveAmp:            0.85,
  waveLength:         42.0,
  waveSteep:          0.62,
  waveSpeed:          0.85,
  windAngleDeg:       38.0,
  windSpreadDeg:      42.0,
  waveAmpFalloff:     0.82,
  waveLenFalloff:     0.74,
  waveNormalStrength: 0.9,
  dispFadeStart:      90.0,
  dispFadeEnd:        480.0,

  glintColor:     "#fff2d8",
  glintIntensity: 0.55,
  glintPower:     180.0,

  fresnelExp: 4.2,
  fresnelSky: 0.12,
  fresnelMax: 0.72,

  // sky reflection (replaces PMREM env map — no cube artefact)
  skyReflectIntensity: 1.05,
  skyZenithColor:      "#1a4a8c",
  skyHorizonColor:     "#b0cce8",
  // kept for UI back-compat (maps to skyReflectIntensity)
  envReflectIntensity: 1.05,

  horizonFadeEnabled: true,
  horizonUseSky:      true,
  horizonColor:       "#cdddea",
  horizonFadeStart:   1800.0,
  horizonFadeEnd:     9000.0,

  snellCritCos:       0.66,
  snellSoft:          0.12,
  underwaterSkyBoost: 1.1,
  underwaterMurk:     0.5,

  opacity: 1.0,

  foamEnabled:         true,
  foamColor:           "#f0fbfa",
  foamBandWidth:       2.6,
  foamIntensity:       1.25,
  foamSharpness:       1.35,
  foamNoiseAmt:        0.78,
  foamNoiseScale:      0.28,
  foamNoiseSpeed:      0.2,
  foamWarpStrength:    0.5,
  foamWarpScale:       0.24,
  foamFineScale:       0.9,
  foamFineAmt:         0.34,
  foamFineSpeed:       0.32,
  foamContrast:        1.2,
  foamCutoff:          0.42,
  foamTransitionWidth: 0.14,
  foamBreatheAmp:      0.55,
  foamBreatheHz:       0.35,
};

const DEG2RAD = Math.PI / 180;

// ─── Factory ──────────────────────────────────────────────────────────────────
/**
 * @param {object}              deps
 * @param {THREE.TextureNode}   deps.heightTexNode — live TSL TextureNode (sculptBrush ping-pong)
 * @param {number}              deps.terrainSize   — world size (e.g. 2048)
 * @param {number}              deps.maxHeight     — MAX_HEIGHT constant (e.g. 500)
 * @param {object|null}         deps.fft           — from createOceanFFTGPUSimulation()
 */
export function createOceanShader({ heightTexNode, terrainSize, maxHeight = 500, fft = null }) {
  const u = {};

  u.time   = uniform(0);
  u.waterY = uniform(0);

  u.shoreColor     = uniform(new THREE.Color(OCEAN_DEFAULTS.shoreColor));
  u.midColor       = uniform(new THREE.Color(OCEAN_DEFAULTS.midColor));
  u.deepColor      = uniform(new THREE.Color(OCEAN_DEFAULTS.deepColor));
  u.highlightColor = uniform(new THREE.Color(OCEAN_DEFAULTS.highlightColor));

  u.depthAbsorb       = uniform(OCEAN_DEFAULTS.depthAbsorb);
  u.depthRampShoreMid = uniform(OCEAN_DEFAULTS.depthRampShoreMid);
  u.depthRampMidDeep  = uniform(OCEAN_DEFAULTS.depthRampMidDeep);
  u.openOceanDepth    = uniform(OCEAN_DEFAULTS.openOceanDepth);

  u.shoreDampEnabled   = uniform(OCEAN_DEFAULTS.shoreDampEnabled ? 1 : 0);
  u.shoreDampStart     = uniform(OCEAN_DEFAULTS.shoreDampStart);
  u.shoreDampEnd       = uniform(OCEAN_DEFAULTS.shoreDampEnd);
  u.shoreLandMargin    = uniform(OCEAN_DEFAULTS.shoreLandMargin);
  u.shoreVertKeep      = uniform(OCEAN_DEFAULTS.shoreVertKeep);
  u.shoreSurfFoamBoost = uniform(OCEAN_DEFAULTS.shoreSurfFoamBoost);
  u.shoreSurfWidth     = uniform(OCEAN_DEFAULTS.shoreSurfWidth);
  u.shoreReflDamp      = uniform(OCEAN_DEFAULTS.shoreReflDamp);
  u.shoreWhitecapDamp  = uniform(OCEAN_DEFAULTS.shoreWhitecapDamp ? 1 : 0);

  u.surfNoiseScale1    = uniform(OCEAN_DEFAULTS.surfNoiseScale1);
  u.surfNoiseScale2    = uniform(OCEAN_DEFAULTS.surfNoiseScale2);
  u.surfNoiseSpeed1    = uniform(OCEAN_DEFAULTS.surfNoiseSpeed1);
  u.surfNoiseSpeed2    = uniform(OCEAN_DEFAULTS.surfNoiseSpeed2);
  u.procNoiseSpeed     = uniform(OCEAN_DEFAULTS.procNoiseSpeed);
  u.surfNormalStrength = uniform(OCEAN_DEFAULTS.surfNormalStrength);

  u.fftEnabled        = uniform(OCEAN_DEFAULTS.fftEnabled ? 1 : 0);
  u.fftSwellAmp       = uniform(OCEAN_DEFAULTS.fftSwellAmp);
  u.fftRippleAmp      = uniform(OCEAN_DEFAULTS.fftRippleAmp);
  u.fftNormalStrength = uniform(OCEAN_DEFAULTS.fftNormalStrength);

  const fftCascades    = fft ? fft.cascades : [];
  const ampForCascade  = (i) =>
    i === 0 ? u.fftSwellAmp
      : i === fftCascades.length - 1 ? u.fftRippleAmp
        : float(1);

  u.whitecapEnabled        = uniform(OCEAN_DEFAULTS.whitecapEnabled ? 1 : 0);
  u.whitecapIntensity      = uniform(OCEAN_DEFAULTS.whitecapIntensity);
  u.whitecapThreshold      = uniform(OCEAN_DEFAULTS.whitecapThreshold);
  u.whitecapSoftness       = uniform(OCEAN_DEFAULTS.whitecapSoftness);
  u.whitecapNoiseScale     = uniform(OCEAN_DEFAULTS.whitecapNoiseScale);
  u.whitecapNoiseSpeed     = uniform(OCEAN_DEFAULTS.whitecapNoiseSpeed);
  u.whitecapWarpStrength   = uniform(OCEAN_DEFAULTS.whitecapWarpStrength);
  u.whitecapWarpScale      = uniform(OCEAN_DEFAULTS.whitecapWarpScale);
  u.whitecapContrast       = uniform(OCEAN_DEFAULTS.whitecapContrast);
  u.whitecapBrightness     = uniform(OCEAN_DEFAULTS.whitecapBrightness);
  u.whitecapProcThreshold  = uniform(OCEAN_DEFAULTS.whitecapProcThreshold);
  u.whitecapProcSoftness   = uniform(OCEAN_DEFAULTS.whitecapProcSoftness);
  u.sssEnabled    = uniform(OCEAN_DEFAULTS.sssEnabled ? 1 : 0);
  u.sssIntensity  = uniform(OCEAN_DEFAULTS.sssIntensity);
  u.sssColor      = uniform(new THREE.Color(OCEAN_DEFAULTS.sssColor));
  u.gerstnerBlend = uniform(OCEAN_DEFAULTS.gerstnerBlend);

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

  u.sunDir         = uniform(new THREE.Vector3(0.4, 0.55, 0.3).normalize());
  u.glintColor     = uniform(new THREE.Color(OCEAN_DEFAULTS.glintColor));
  u.glintIntensity = uniform(OCEAN_DEFAULTS.glintIntensity);
  u.glintPower     = uniform(OCEAN_DEFAULTS.glintPower);

  u.fresnelExp = uniform(OCEAN_DEFAULTS.fresnelExp);
  u.fresnelSky = uniform(OCEAN_DEFAULTS.fresnelSky);
  u.fresnelMax = uniform(OCEAN_DEFAULTS.fresnelMax);

  // analytical sky reflection (replaces PMREM)
  u.skyReflectIntensity = uniform(OCEAN_DEFAULTS.skyReflectIntensity);
  u.skyZenithColor      = uniform(new THREE.Color(OCEAN_DEFAULTS.skyZenithColor));
  u.skyHorizonColor     = uniform(new THREE.Color(OCEAN_DEFAULTS.skyHorizonColor));

  u.horizonFadeEnabled = uniform(OCEAN_DEFAULTS.horizonFadeEnabled ? 1 : 0);
  u.horizonUseSky      = uniform(OCEAN_DEFAULTS.horizonUseSky ? 1 : 0);
  u.horizonColor       = uniform(new THREE.Color(OCEAN_DEFAULTS.horizonColor));
  u.horizonFadeStart   = uniform(OCEAN_DEFAULTS.horizonFadeStart);
  u.horizonFadeEnd     = uniform(OCEAN_DEFAULTS.horizonFadeEnd);

  u.underwaterT        = uniform(0);
  u.snellCritCos       = uniform(OCEAN_DEFAULTS.snellCritCos);
  u.snellSoft          = uniform(OCEAN_DEFAULTS.snellSoft);
  u.underwaterSkyBoost = uniform(OCEAN_DEFAULTS.underwaterSkyBoost);
  u.underwaterMurk     = uniform(OCEAN_DEFAULTS.underwaterMurk);

  u.opacity = uniform(OCEAN_DEFAULTS.opacity);

  u.foamEnabled         = uniform(OCEAN_DEFAULTS.foamEnabled ? 1 : 0);
  u.foamColor           = uniform(new THREE.Color(OCEAN_DEFAULTS.foamColor));
  u.foamBandWidth       = uniform(OCEAN_DEFAULTS.foamBandWidth);
  u.foamIntensity       = uniform(OCEAN_DEFAULTS.foamIntensity);
  u.foamSharpness       = uniform(OCEAN_DEFAULTS.foamSharpness);
  u.foamNoiseAmt        = uniform(OCEAN_DEFAULTS.foamNoiseAmt);
  u.foamNoiseScale      = uniform(OCEAN_DEFAULTS.foamNoiseScale);
  u.foamNoiseSpeed      = uniform(OCEAN_DEFAULTS.foamNoiseSpeed);
  u.foamWarpStrength    = uniform(OCEAN_DEFAULTS.foamWarpStrength);
  u.foamWarpScale       = uniform(OCEAN_DEFAULTS.foamWarpScale);
  u.foamFineScale       = uniform(OCEAN_DEFAULTS.foamFineScale);
  u.foamFineAmt         = uniform(OCEAN_DEFAULTS.foamFineAmt);
  u.foamFineSpeed       = uniform(OCEAN_DEFAULTS.foamFineSpeed);
  u.foamContrast        = uniform(OCEAN_DEFAULTS.foamContrast);
  u.foamCutoff          = uniform(OCEAN_DEFAULTS.foamCutoff);
  u.foamTransitionWidth = uniform(OCEAN_DEFAULTS.foamTransitionWidth);
  u.foamBreatheAmp      = uniform(OCEAN_DEFAULTS.foamBreatheAmp);
  u.foamBreatheHz       = uniform(OCEAN_DEFAULTS.foamBreatheHz);

  const uTerrainSize = uniform(terrainSize);
  // maxHeight baked as a constant float node — never changes at runtime
  const uMaxHeight   = float(maxHeight);

  // ── Gerstner helpers (identical to v2) ───────────────────────────────────
  function waveParams(i, xz) {
    const Ai    = u.waveAmp.mul(pow(u.waveAmpFalloff, float(i)));
    const Li    = u.waveLength.mul(pow(u.waveLenFalloff, float(i)));
    const ki    = float(TWO_PI).div(max(Li, float(0.001)));
    const angle = u.windAngle.add(u.windSpread.mul(float(WAVE_DIR_OFFSET[i])));
    const Di    = vec2(cos(angle), sin(angle));
    const omega = sqrt(float(GRAVITY).mul(ki)).mul(u.waveSpeed);
    const phase = ki.mul(dot(Di, xz)).sub(omega.mul(u.time));
    const Qi    = clamp(
      u.waveSteep.div(ki.mul(Ai).mul(float(N_WAVES)).add(float(1e-4))),
      float(0), float(1),
    );
    return { Ai, ki, Di, phase, Qi };
  }

  function gerstnerDisp(xz, ampScale) {
    const dx = float(0).toVar();
    const dy = float(0).toVar();
    const dz = float(0).toVar();
    for (let i = 0; i < N_WAVES; i++) {
      const { Ai, Di, phase, Qi } = waveParams(i, xz);
      const cosP = cos(phase), sinP = sin(phase);
      const qa   = Qi.mul(Ai);
      dx.addAssign(qa.mul(Di.x).mul(cosP));
      dz.addAssign(qa.mul(Di.y).mul(cosP));
      dy.addAssign(Ai.mul(sinP));
    }
    return vec3(dx, dy, dz).mul(ampScale);
  }

  function gerstnerSlope(xz, ampScale) {
    const sx = float(0).toVar();
    const sz = float(0).toVar();
    for (let i = 0; i < N_WAVES; i++) {
      const { Ai, ki, Di, phase } = waveParams(i, xz);
      const wa = ki.mul(Ai);
      sx.addAssign(Di.x.mul(wa).mul(cos(phase)));
      sz.addAssign(Di.y.mul(wa).mul(cos(phase)));
    }
    const k = ampScale.mul(u.waveNormalStrength);
    return vec2(sx.negate().mul(k), sz.negate().mul(k));
  }

  function ampScaleAt(xz) {
    const dist = length(xz.sub(cameraPosition.xz));
    return saturate(float(1).sub(smoothstep(u.dispFadeStart, u.dispFadeEnd, dist)));
  }

  // ── Heightmap helpers (V3: multiply .r by maxHeight for world metres) ─────
  function terrainSampleAt(xz) {
    const hUV = vec2(
      xz.x.div(uTerrainSize).add(0.5),
      xz.y.div(uTerrainSize).add(0.5),
    );
    const uvClamped = vec2(
      clamp(hUV.x, float(0.001), float(0.999)),
      clamp(hUV.y, float(0.001), float(0.999)),
    );
    // heightTexNode.r is 0..1 normalized; multiply by maxHeight → world metres
    const terrainY   = texture(heightTexNode, uvClamped).r.mul(uMaxHeight);
    return { terrainY, depthSigned: u.waterY.sub(terrainY) };
  }

  function shoreWaveMask(depthSigned) {
    const wet  = smoothstep(u.shoreLandMargin.negate(), u.shoreLandMargin, depthSigned);
    const deep = smoothstep(u.shoreDampStart, u.shoreDampEnd, depthSigned);
    return wet.mul(deep).mul(u.shoreDampEnabled);
  }

  function applyShoreToDisp(disp, mask) {
    const xzMask = mask.mul(mask);
    const yMask  = mix(u.shoreVertKeep, float(1), mask);
    return vec3(disp.x.mul(xzMask), disp.y.mul(yMask), disp.z.mul(xzMask));
  }

  // ── 8-tap shore-proximity depth (V3 fix for island mode) ──────────────────
  // Returns the minimum (waterY - terrainY) found in a ring of SHORE_RADIUS
  // metres around the fragment.  Low values mean land is nearby → shore colour.
  // We also include the current pixel so it can't be higher than the local depth.
  const SHORE_RADIUS = 60.0; // world-space metres
  const SHORE_DIRS   = [
    [1,0],[-1,0],[0,1],[0,-1],
    [0.707,0.707],[-0.707,0.707],[0.707,-0.707],[-0.707,-0.707],
  ];

  function shoreColorDepthAt(xz, inside) {
    // start conservative — open-ocean depth
    const minD = u.openOceanDepth.toVar();

    // include the current pixel's depth (unit-corrected, mixed with open-ocean outside)
    const hUV0 = vec2(
      clamp(xz.x.div(uTerrainSize).add(0.5), float(0.001), float(0.999)),
      clamp(xz.y.div(uTerrainSize).add(0.5), float(0.001), float(0.999)),
    );
    const tY0 = texture(heightTexNode, hUV0).r.mul(uMaxHeight);
    const d0  = mix(u.openOceanDepth, u.waterY.sub(tY0), inside);
    minD.assign(min(minD, d0));

    // 8 neighbour samples in a ring
    for (const [ox, oz] of SHORE_DIRS) {
      const sXZ = xz.add(vec2(float(ox * SHORE_RADIUS), float(oz * SHORE_RADIUS)));
      const sUV = vec2(
        clamp(sXZ.x.div(uTerrainSize).add(0.5), float(0.001), float(0.999)),
        clamp(sXZ.y.div(uTerrainSize).add(0.5), float(0.001), float(0.999)),
      );
      const sH = texture(heightTexNode, sUV).r.mul(uMaxHeight);
      minD.assign(min(minD, u.waterY.sub(sH)));
    }

    return max(minD, float(0));
  }

  // ── FFT helpers (identical to v2) ─────────────────────────────────────────
  function fftDispAt(xz, ampScale) {
    if (!fftCascades.length) return vec3(0);
    let sum = vec3(0);
    fftCascades.forEach((c, i) => {
      const d = texture(c.dispTex, xz.div(c.tileSize)).level(0).xyz;
      sum = sum.add(d.mul(ampForCascade(i)));
    });
    return sum.mul(ampScale).mul(u.fftEnabled);
  }

  function fftSlopeAt(xz, ampScale) {
    if (!fftCascades.length) return vec2(0);
    let sum = vec2(0);
    fftCascades.forEach((c, i) => {
      const d = texture(c.derivTex, xz.div(c.tileSize));
      const g = vec2(d.x.div(float(1).add(d.z)), d.y.div(float(1).add(d.w)));
      sum = sum.add(g.mul(ampForCascade(i)));
    });
    return sum.mul(u.fftNormalStrength).mul(ampScale).mul(u.fftEnabled);
  }

  function worleyFoamPattern(xz, scale, speed, warpStr, warpScale, contrast, threshold, softness, brightness) {
    const scroll = vec2(u.time.mul(speed), u.time.mul(speed.mul(0.71)));
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
    const foamCascades = fftCascades.length > 2 ? fftCascades.slice(0, -1) : fftCascades;
    let jMin = texture(foamCascades[0].dispTex, xz.div(foamCascades[0].tileSize)).w;
    for (const c of foamCascades.slice(1)) {
      jMin = min(jMin, texture(c.dispTex, xz.div(c.tileSize)).w);
    }
    const lo      = u.whitecapThreshold.sub(u.whitecapSoftness);
    const breaking = float(1).sub(smoothstep(lo, u.whitecapThreshold, jMin));
    const gate     = breaking.mul(u.whitecapEnabled).mul(u.fftEnabled).mul(ampScale);
    const detail   = float(0).toVar();
    If(gate.greaterThan(float(0.001)), () => {
      detail.assign(worleyFoamPattern(
        xz,
        u.whitecapNoiseScale, u.whitecapNoiseSpeed,
        u.whitecapWarpStrength, u.whitecapWarpScale,
        u.whitecapContrast, u.whitecapProcThreshold,
        u.whitecapProcSoftness, u.whitecapBrightness,
      ));
    });
    return breaking.mul(detail).mul(u.whitecapIntensity).mul(ampScale);
  }

  // ── Analytical sky (V3 — replaces PMREM) ──────────────────────────────────
  // Evaluates the sky gradient at an arbitrary direction.
  // r.y = 1 → zenith, r.y = 0 → horizon, r.y < 0 → below horizon (= horizon).
  function analyticalSky(dir) {
    const t = smoothstep(float(-0.1), float(0.45), dir.y);
    return mix(u.skyHorizonColor, u.skyZenithColor, t);
  }

  // ── Vertex stage (CDLOD morph + Gerstner + FFT displacement) ─────────────
  const oceanPosition = Fn(() => {
    const localXZ    = positionLocal.xz;
    const cell       = attribute("aCell", "float");
    const outerHalf  = max(attribute("aOuterHalf", "float"), float(1e-3));
    const cheb       = max(abs(localXZ.x), abs(localXZ.y));
    const morphK     = saturate(cheb.div(outerHalf).sub(0.75).div(0.25));
    const grid       = cell.mul(2);
    const snapXZ     = round(localXZ.div(grid)).mul(grid);
    const morphedXZ  = mix(localXZ, snapXZ, morphK);

    const worldBase  = modelWorldMatrix.mul(vec4(positionLocal, float(1))).xz;
    const worldXZ    = worldBase.add(morphedXZ.sub(localXZ));
    const ampScale   = ampScaleAt(worldXZ);
    const { depthSigned } = terrainSampleAt(worldXZ);
    const shoreMask  = shoreWaveMask(depthSigned);

    const fftDisp   = applyShoreToDisp(fftDispAt(worldXZ, ampScale), shoreMask);
    const gerstner  = applyShoreToDisp(
      gerstnerDisp(worldXZ, ampScale.mul(u.waveEnabled).mul(u.gerstnerBlend).mul(u.fftEnabled)),
      shoreMask,
    );
    return vec3(morphedXZ.x, float(0), morphedXZ.y).add(fftDisp).add(gerstner);
  });

  // ── Fragment shader ────────────────────────────────────────────────────────
  const oceanFrag = Fn(() => {
    const wXZ = positionWorld.xz;

    // ── Heightmap sample for foam band + wave damping ──────────────────────
    const hUV = vec2(
      wXZ.x.div(uTerrainSize).add(0.5),
      wXZ.y.div(uTerrainSize).add(0.5),
    );
    const insideX = float(1).sub(smoothstep(float(0.95), float(1.0), abs(hUV.x.sub(0.5)).mul(2)));
    const insideZ = float(1).sub(smoothstep(float(0.95), float(1.0), abs(hUV.y.sub(0.5)).mul(2)));
    const inside  = insideX.mul(insideZ);
    const uvClamped = vec2(
      clamp(hUV.x, float(0.001), float(0.999)),
      clamp(hUV.y, float(0.001), float(0.999)),
    );
    // per-pixel depth (world metres) for foam and wave damping
    const terrainYPx = texture(heightTexNode, uvClamped).r.mul(uMaxHeight);
    const dShoreRaw  = u.waterY.sub(terrainYPx);
    const dShore     = mix(u.openOceanDepth, dShoreRaw, inside);
    const shoreMask  = shoreWaveMask(dShoreRaw).mul(inside);
    const shallowT   = float(1).sub(
      smoothstep(float(0), u.shoreSurfWidth, max(dShoreRaw, float(0))),
    );

    // ── Colour-ramp depth: 8-tap neighbourhood minimum (V3 island fix) ─────
    // Use the smallest depth found in a 60 m ring so that the cyan shore
    // colour band extends around ALL coastlines regardless of water depth.
    const colorDepth = shoreColorDepthAt(wXZ, inside);

    // ── Three-stop depth ramp (shore → mid → deep) ────────────────────────
    const tDepth  = float(1).sub(exp(colorDepth.mul(u.depthAbsorb).negate())).saturate();
    const kneeLo  = min(u.depthRampShoreMid, u.depthRampMidDeep);
    const kneeHi  = max(u.depthRampShoreMid, u.depthRampMidDeep);
    const wShoreMid = smoothstep(float(0), max(kneeLo, float(0.02)), tDepth);
    const wMidDeep  = smoothstep(min(kneeHi, float(0.98)), float(1), tDepth);
    const cShoreMid  = mix(u.shoreColor, u.midColor, wShoreMid);
    const absorption = mix(cShoreMid, u.deepColor, wMidDeep).saturate();

    // ── Dual-layer noise normals ───────────────────────────────────────────
    const nSpd    = max(u.procNoiseSpeed, float(0.001));
    const scroll1 = vec2(u.time.mul(u.surfNoiseSpeed1.mul(nSpd)), u.time.mul(u.surfNoiseSpeed1.mul(0.71).mul(nSpd)));
    const scroll2 = vec2(u.time.mul(u.surfNoiseSpeed2.mul(nSpd)), u.time.mul(u.surfNoiseSpeed2.mul(-0.63).mul(nSpd)));
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
      .mul(u.surfNormalStrength).mul(mix(float(0.25), float(1), u.fftEnabled)).mul(shoreMask);
    const dnz  = s1z.sub(s10).add(s2z.sub(s20).mul(0.62))
      .mul(u.surfNormalStrength).mul(mix(float(0.25), float(1), u.fftEnabled)).mul(shoreMask);

    // ── FFT + Gerstner slopes ──────────────────────────────────────────────
    const ampScaleF = ampScaleAt(wXZ).mul(shoreMask);
    const fftSlope  = fftSlopeAt(wXZ, ampScaleF);
    const gSlope    = gerstnerSlope(
      wXZ,
      ampScaleAt(wXZ).mul(u.waveEnabled).mul(u.gerstnerBlend).mul(u.fftEnabled).mul(shoreMask),
    );
    const worldN = normalize(vec3(
      dnx.negate().add(fftSlope.x.negate()).add(gSlope.x),
      float(1),
      dnz.negate().add(fftSlope.y.negate()).add(gSlope.y),
    ));

    // ── Fresnel ───────────────────────────────────────────────────────────
    const viewDir   = normalize(cameraPosition.sub(positionWorld));
    const NdotV     = max(dot(worldN, viewDir), float(0.001));
    const fresnelRaw = pow(float(1).sub(saturate(NdotV)), u.fresnelExp);
    const fresnel    = min(fresnelRaw, u.fresnelMax);
    const grazing    = saturate(float(1).sub(NdotV));
    const hlCol      = mix(u.highlightColor, u.deepColor, pow(grazing, float(1.2)));
    const skyTint    = hlCol.mul(fresnel).mul(u.fresnelSky);

    // ── Analytical sky reflection (V3 — no cube artefact) ─────────────────
    // Wave-perturbed reflection direction: the shimmer comes naturally from the
    // per-pixel normal variation, so no roughness-based mip needed.
    const reflectDir = viewDir.negate().reflect(worldN).normalize();
    const skyRadiance = analyticalSky(reflectDir);
    const envRefl = skyRadiance
      .mul(fresnel)
      .mul(u.skyReflectIntensity)
      .mul(mix(float(1), u.shoreReflDamp, shallowT));

    const lit = absorption.add(skyTint).add(envRefl);

    // ── Sun glint ─────────────────────────────────────────────────────────
    const halfV  = normalize(viewDir.add(u.sunDir));
    const spec   = pow(max(dot(worldN, halfV), float(0)), u.glintPower).mul(u.glintIntensity);
    const withGlint = lit.add(u.glintColor.mul(spec));

    // ── SSS ───────────────────────────────────────────────────────────────
    const sunDotN  = dot(worldN, u.sunDir);
    const crestLit = saturate(sunDotN.negate());
    const viewToSun = saturate(dot(viewDir, u.sunDir.negate()));
    const sss       = crestLit.mul(viewToSun).mul(u.sssIntensity).mul(u.sssEnabled);
    const withSss   = withGlint.add(u.sssColor.mul(sss));

    // ── Whitecap foam ─────────────────────────────────────────────────────
    const whitecap     = fftWhitecapAt(wXZ, ampScaleAt(wXZ))
      .mul(mix(float(1), shoreMask, u.shoreWhitecapDamp));
    const withWhitecap = mix(withSss, u.foamColor, whitecap);

    // ── Coastal foam band ─────────────────────────────────────────────────
    const breath    = sin(u.time.mul(u.foamBreatheHz).mul(float(TWO_PI))).mul(u.foamBreatheAmp);
    const dShoreBand = dShoreRaw.add(breath);
    const absD      = abs(dShoreBand);
    const bandBase  = float(1).sub(smoothstep(float(0), u.foamBandWidth, absD));
    const bandShaped = pow(max(bandBase, float(0.0001)), u.foamSharpness);
    const scrollF   = vec2(u.time.mul(u.foamNoiseSpeed), u.time.mul(u.foamNoiseSpeed.mul(0.73)));
    const shoreProc = float(0).toVar();
    If(bandShaped.mul(inside).mul(u.foamEnabled).greaterThan(float(0.001)), () => {
      shoreProc.assign(worleyFoamPattern(
        wXZ.add(scrollF.mul(0.15)),
        u.foamNoiseScale, u.foamNoiseSpeed,
        u.foamWarpStrength, u.foamWarpScale,
        u.foamContrast, u.foamCutoff,
        u.foamTransitionWidth, float(1),
      ));
    });
    const noiseBlend = mix(float(1), shoreProc, u.foamNoiseAmt);
    const unified    = saturate(bandShaped.mul(noiseBlend));
    const foamMask   = saturate(
      unified.mul(u.foamIntensity).mul(mix(float(1), u.shoreSurfFoamBoost, shallowT)),
    ).mul(u.foamEnabled).mul(inside);

    // ── Composite + horizon fade ───────────────────────────────────────────
    const composited  = mix(withWhitecap, u.foamColor, foamMask).saturate();
    const horizDist   = length(wXZ.sub(cameraPosition.xz));
    const hf          = smoothstep(u.horizonFadeStart, u.horizonFadeEnd, horizDist).mul(u.horizonFadeEnabled);
    const horizonTarget = u.horizonColor.toVar();
    If(hf.greaterThan(float(0.001)), () => {
      const vRay  = positionWorld.sub(cameraPosition);
      const vDir  = normalize(vec3(vRay.x, max(vRay.y, float(0.02)), vRay.z));
      // V3: use analytical sky instead of PMREM for horizon fade
      const skyCol = analyticalSky(vDir);
      horizonTarget.assign(mix(u.horizonColor, skyCol, u.horizonUseSky));
    });
    const aboveColor = mix(composited, horizonTarget, hf);

    // ── Underwater surface (Snell window + TIR) ───────────────────────────
    const underside = u.deepColor.toVar();
    If(u.underwaterT.greaterThan(float(0.001)), () => {
      const viewDirU = normalize(cameraPosition.sub(positionWorld));
      const cosT     = abs(dot(worldN, viewDirU));
      const win       = smoothstep(
        u.snellCritCos.sub(u.snellSoft), u.snellCritCos.add(u.snellSoft), cosT,
      );
      const refrDir  = normalize(vec3(
        worldN.x.negate().mul(0.6).add(viewDirU.x.mul(0.4)),
        float(1.0),
        worldN.z.negate().mul(0.6).add(viewDirU.z.mul(0.4)),
      ));
      // V3: analytical sky inside Snell window — cube-free
      const skyU    = analyticalSky(refrDir);
      const sunWin  = pow(max(dot(refrDir, u.sunDir), float(0)), float(48)).mul(win);
      const windowCol = skyU.mul(u.underwaterSkyBoost).add(u.glintColor.mul(sunWin.mul(0.7)));
      const tirCol    = u.deepColor.mul(u.underwaterMurk);
      underside.assign(mix(tirCol, windowCol, win));
    });

    const finalColor = mix(aboveColor, underside, u.underwaterT);
    return vec4(finalColor, u.opacity);
  });

  // ── Material ──────────────────────────────────────────────────────────────
  const fragOut  = oceanFrag();
  const material = new MeshBasicNodeMaterial({
    transparent: false,
    depthWrite:  true,
    side:        THREE.DoubleSide,
    colorNode:   fragOut.rgb,
    opacityNode: fragOut.a,
    positionNode: oceanPosition(),
  });

  // ── syncParams ────────────────────────────────────────────────────────────
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

    if (p.whitecapEnabled        != null) u.whitecapEnabled.value        = p.whitecapEnabled ? 1 : 0;
    if (p.whitecapIntensity      != null) u.whitecapIntensity.value      = p.whitecapIntensity;
    if (p.whitecapThreshold      != null) u.whitecapThreshold.value      = p.whitecapThreshold;
    if (p.whitecapSoftness       != null) u.whitecapSoftness.value       = p.whitecapSoftness;
    if (p.whitecapNoiseScale     != null) u.whitecapNoiseScale.value     = p.whitecapNoiseScale;
    if (p.whitecapNoiseSpeed     != null) u.whitecapNoiseSpeed.value     = p.whitecapNoiseSpeed;
    if (p.whitecapWarpStrength   != null) u.whitecapWarpStrength.value   = p.whitecapWarpStrength;
    if (p.whitecapWarpScale      != null) u.whitecapWarpScale.value      = p.whitecapWarpScale;
    if (p.whitecapContrast       != null) u.whitecapContrast.value       = p.whitecapContrast;
    if (p.whitecapBrightness     != null) u.whitecapBrightness.value     = p.whitecapBrightness;
    if (p.whitecapProcThreshold  != null) u.whitecapProcThreshold.value  = p.whitecapProcThreshold;
    if (p.whitecapProcSoftness   != null) u.whitecapProcSoftness.value   = p.whitecapProcSoftness;
    if (p.sssEnabled   != null) u.sssEnabled.value   = p.sssEnabled ? 1 : 0;
    if (p.sssIntensity != null) u.sssIntensity.value = p.sssIntensity;
    if (p.sssColor     != null) c(p.sssColor, u.sssColor.value);

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

    // envReflectIntensity from the UI maps to skyReflectIntensity
    if (p.envReflectIntensity != null) u.skyReflectIntensity.value = p.envReflectIntensity;
    if (p.skyReflectIntensity != null) u.skyReflectIntensity.value = p.skyReflectIntensity;
    if (p.skyZenithColor  != null) c(p.skyZenithColor,  u.skyZenithColor.value);
    if (p.skyHorizonColor != null) c(p.skyHorizonColor, u.skyHorizonColor.value);

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
        material.depthWrite  = !wantTransparent;
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

  function update(dt, elapsed) {
    u.time.value = elapsed;
  }

  function setSkyColors(zenith, horizon) {
    if (zenith)  u.skyZenithColor.value.copy(zenith);
    if (horizon) u.skyHorizonColor.value.copy(horizon);
  }

  return { material, uniforms: u, syncParams, update, setSkyColors };
}
