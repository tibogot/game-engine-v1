/**
 * Shared ground procedural stack matching splatmap-painter10bvh+post.html `groundProc` + `groundLayerMask`.
 * Mirror of chunkMeadowTsl.js — base color + 2 noise layers w/ FBM, mask shaping, invert, 5 noise types.
 * All parameters are runtime uniforms, so Tweakpane sliders can drive the shared material without rebuilds.
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  mix,
  smoothstep,
  clamp,
  sub,
  pow,
  max,
  step,
  uniform,
  positionWorld,
} from "three/tsl";
import {
  valueNoise2D,
  perlinNoise2D,
  fbmPerlin2D,
  simplexNoise2D,
  voronoiF1Normalized,
  whiteNoise2D,
} from "./tsl-noise.js";

function toLinear(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

function noiseTypeToIndex(s) {
  return { value: 0, perlin: 1, simplex: 2, voronoi: 3, white: 4 }[s] ?? 0;
}

function selectGroundNoise(nVal, nPerl, nSim, nVoro, nWhite, uType) {
  let n = nVal;
  n = mix(n, nPerl, step(float(0.5), uType));
  n = mix(n, nSim, step(float(1.5), uType));
  n = mix(n, nVoro, step(float(2.5), uType));
  n = mix(n, nWhite, step(float(3.5), uType));
  return n;
}

function groundLayerUniforms(L) {
  return {
    enable: uniform(L.enable ? 1 : 0),
    noiseType: uniform(noiseTypeToIndex(L.noiseType)),
    color: uniform(new THREE.Color(L.color).convertSRGBToLinear()),
    strength: uniform(L.strength, "float"),
    useFbm: uniform(L.useFbm ? 1 : 0),
    octaves: uniform(L.octaves, "float"),
    lacunarity: uniform(L.lacunarity, "float"),
    gain: uniform(L.gain, "float"),
    scale: uniform(L.scale, "float"),
    offsetX: uniform(L.offsetX, "float"),
    offsetY: uniform(L.offsetY, "float"),
    invert: uniform(L.invert ? 1 : 0),
    maskLow: uniform(L.maskLow, "float"),
    maskHigh: uniform(L.maskHigh, "float"),
    maskSharpness: uniform(L.maskSharpness, "float"),
    voronoiJitter: uniform(L.voronoiJitter, "float"),
  };
}

function groundLayerMask(U, worldXZ) {
  const p = vec2(
    worldXZ.x.mul(U.scale).add(U.offsetX),
    worldXZ.y.mul(U.scale).add(U.offsetY),
  );
  const nVal = valueNoise2D(p);
  const nPerlS = perlinNoise2D(p);
  const nPerlF = fbmPerlin2D(p, U.octaves, U.lacunarity, U.gain);
  const nPerl = mix(nPerlS, nPerlF, U.useFbm);
  const nSim = simplexNoise2D(p);
  const nVoro = voronoiF1Normalized(p, U.voronoiJitter);
  const nWhite = whiteNoise2D(p);
  let n = selectGroundNoise(nVal, nPerl, nSim, nVoro, nWhite, U.noiseType);
  n = mix(n, float(1).sub(n), U.invert);
  const raw = smoothstep(U.maskLow, U.maskHigh, n);
  const mask = pow(max(raw, float(0.0001)), U.maskSharpness).mul(U.strength).mul(U.enable);
  return mask;
}

function syncGroundLayerUniforms(L, U) {
  U.enable.value = L.enable ? 1 : 0;
  U.noiseType.value = noiseTypeToIndex(L.noiseType);
  U.color.value.set(L.color).convertSRGBToLinear();
  U.strength.value = L.strength;
  U.useFbm.value = L.useFbm ? 1 : 0;
  U.octaves.value = L.octaves;
  U.lacunarity.value = L.lacunarity;
  U.gain.value = L.gain;
  U.scale.value = L.scale;
  U.offsetX.value = L.offsetX;
  U.offsetY.value = L.offsetY;
  U.invert.value = L.invert ? 1 : 0;
  U.maskLow.value = L.maskLow;
  U.maskHigh.value = L.maskHigh;
  U.maskSharpness.value = L.maskSharpness;
  U.voronoiJitter.value = L.voronoiJitter;
}

/** Default ground = painter `gPARAMS` default preset. */
export const GROUND_DEFAULT_PARAMS = {
  brightness: 1.3,
  contrast: 0.95,
  baseColor: "#74CA5E",
  layer1: {
    enable: true,
    noiseType: "perlin",
    color: "#2a4518",
    strength: 0.4,
    useFbm: true,
    octaves: 3,
    lacunarity: 2.0,
    gain: 0.5,
    scale: 0.012,
    offsetX: 0,
    offsetY: 0,
    invert: false,
    maskLow: 0.35,
    maskHigh: 0.8,
    maskSharpness: 1.0,
    voronoiJitter: 0.8,
  },
  layer2: {
    enable: false,
    noiseType: "perlin",
    color: "#5aaa30",
    strength: 0.4,
    useFbm: true,
    octaves: 2.5,
    lacunarity: 2.2,
    gain: 0.5,
    scale: 0.04,
    offsetX: 13.7,
    offsetY: 31.1,
    invert: false,
    maskLow: 0.4,
    maskHigh: 0.75,
    maskSharpness: 1.0,
    voronoiJitter: 0.7,
  },
};

export const GROUND_PRESETS = {
  default: GROUND_DEFAULT_PARAMS,
  dryGrassland: {
    brightness: 1.22,
    contrast: 1.0,
    baseColor: "#9aaa6a",
    layer1: {
      enable: true,
      noiseType: "perlin",
      color: "#4a5030",
      strength: 0.38,
      useFbm: true,
      octaves: 3.5,
      lacunarity: 2.2,
      gain: 0.52,
      scale: 0.018,
      offsetX: 4.2,
      offsetY: -9.1,
      invert: false,
      maskLow: 0.32,
      maskHigh: 0.76,
      maskSharpness: 1.15,
      voronoiJitter: 0.75,
    },
    layer2: {
      enable: true,
      noiseType: "value",
      color: "#6b7550",
      strength: 0.22,
      useFbm: false,
      octaves: 2,
      lacunarity: 2.0,
      gain: 0.5,
      scale: 0.055,
      offsetX: 40,
      offsetY: -22,
      invert: false,
      maskLow: 0.45,
      maskHigh: 0.82,
      maskSharpness: 0.9,
      voronoiJitter: 0.8,
    },
  },
  mud: {
    brightness: 0.92,
    contrast: 1.12,
    baseColor: "#4a3a2a",
    layer1: {
      enable: true,
      noiseType: "voronoi",
      color: "#2a1a10",
      strength: 0.48,
      useFbm: false,
      octaves: 3,
      lacunarity: 2.0,
      gain: 0.5,
      scale: 0.028,
      offsetX: 0,
      offsetY: 0,
      invert: false,
      maskLow: 0.25,
      maskHigh: 0.72,
      maskSharpness: 1.2,
      voronoiJitter: 0.65,
    },
    layer2: {
      enable: true,
      noiseType: "perlin",
      color: "#3d3228",
      strength: 0.28,
      useFbm: true,
      octaves: 2.5,
      lacunarity: 2.4,
      gain: 0.48,
      scale: 0.065,
      offsetX: 71,
      offsetY: 33,
      invert: true,
      maskLow: 0.4,
      maskHigh: 0.78,
      maskSharpness: 1.0,
      voronoiJitter: 0.7,
    },
  },
  sand: {
    brightness: 1.38,
    contrast: 0.88,
    baseColor: "#e6d2a8",
    layer1: {
      enable: true,
      noiseType: "simplex",
      color: "#c9b078",
      strength: 0.32,
      useFbm: true,
      octaves: 2.5,
      lacunarity: 2.3,
      gain: 0.45,
      scale: 0.035,
      offsetX: 12,
      offsetY: 28,
      invert: false,
      maskLow: 0.38,
      maskHigh: 0.7,
      maskSharpness: 0.85,
      voronoiJitter: 0.85,
    },
    layer2: {
      enable: true,
      noiseType: "white",
      color: "#f0e4c8",
      strength: 0.12,
      useFbm: false,
      octaves: 2,
      lacunarity: 2.0,
      gain: 0.5,
      scale: 0.09,
      offsetX: -5,
      offsetY: 60,
      invert: false,
      maskLow: 0.55,
      maskHigh: 0.92,
      maskSharpness: 1.4,
      voronoiJitter: 0.8,
    },
  },
  rockySoil: {
    brightness: 1.05,
    contrast: 1.08,
    baseColor: "#6b6b68",
    layer1: {
      enable: true,
      noiseType: "value",
      color: "#4a4845",
      strength: 0.42,
      useFbm: true,
      octaves: 4,
      lacunarity: 2.1,
      gain: 0.55,
      scale: 0.022,
      offsetX: -18,
      offsetY: 7,
      invert: false,
      maskLow: 0.3,
      maskHigh: 0.68,
      maskSharpness: 1.25,
      voronoiJitter: 0.8,
    },
    layer2: {
      enable: true,
      noiseType: "voronoi",
      color: "#8a8680",
      strength: 0.26,
      useFbm: false,
      octaves: 2,
      lacunarity: 2.0,
      gain: 0.5,
      scale: 0.048,
      offsetX: 55,
      offsetY: -40,
      invert: false,
      maskLow: 0.42,
      maskHigh: 0.85,
      maskSharpness: 1.1,
      voronoiJitter: 0.55,
    },
  },
  darkForest: {
    brightness: 0.88,
    contrast: 1.05,
    baseColor: "#2d4a32",
    layer1: {
      enable: true,
      noiseType: "perlin",
      color: "#1a2818",
      strength: 0.45,
      useFbm: true,
      octaves: 4,
      lacunarity: 2.35,
      gain: 0.52,
      scale: 0.015,
      offsetX: 22,
      offsetY: -14,
      invert: false,
      maskLow: 0.28,
      maskHigh: 0.74,
      maskSharpness: 1.05,
      voronoiJitter: 0.78,
    },
    layer2: {
      enable: true,
      noiseType: "simplex",
      color: "#3d5c38",
      strength: 0.3,
      useFbm: true,
      octaves: 3,
      lacunarity: 2.0,
      gain: 0.5,
      scale: 0.052,
      offsetX: -30,
      offsetY: 41,
      invert: true,
      maskLow: 0.35,
      maskHigh: 0.7,
      maskSharpness: 0.95,
      voronoiJitter: 0.72,
    },
  },
  genshinGrass: {
    brightness: 2.0,
    contrast: 0.95,
    baseColor: "#80cf6d",
    layer1: {
      enable: true,
      noiseType: "perlin",
      color: "#588637",
      strength: 0.4,
      useFbm: true,
      octaves: 4,
      lacunarity: 3.3,
      gain: 0.8,
      scale: 0.1,
      offsetX: 0,
      offsetY: 0,
      invert: false,
      maskLow: 0.3,
      maskHigh: 0.87,
      maskSharpness: 0.6,
      voronoiJitter: 0.8,
    },
    layer2: {
      enable: true,
      noiseType: "perlin",
      color: "#5aaa30",
      strength: 0.51,
      useFbm: true,
      octaves: 3,
      lacunarity: 3.0,
      gain: 0.8,
      scale: 0.1,
      offsetX: 14,
      offsetY: 31,
      invert: false,
      maskLow: 0.4,
      maskHigh: 0.72,
      maskSharpness: 1.65,
      voronoiJitter: 0.8,
    },
  },
};

/**
 * Returns a bundle { groundProc, groundUniforms, syncFromParams } where groundProc is the
 * TSL color Fn (call as `groundProc()` inside a parent colorNode Fn to get base+layers mixed).
 */
export function createGroundTslBundle(initial) {
  const gBase = uniform(toLinear(initial.baseColor));
  const gContrast = uniform(initial.contrast, "float");
  const gBrightness = uniform(initial.brightness, "float");
  const gL1 = groundLayerUniforms(initial.layer1);
  const gL2 = groundLayerUniforms(initial.layer2);

  /** TSL vec3: same stack as terrain `tslGround` base (no splat / meadow / cliff). */
  function groundColorAtWorldXZ(worldXZ) {
    let col = gBase;
    col = mix(col, gL1.color, groundLayerMask(gL1, worldXZ));
    col = mix(col, gL2.color, groundLayerMask(gL2, worldXZ));
    col = clamp(
      sub(col, float(0.5)).mul(gContrast).add(float(0.5)).mul(gBrightness),
      float(0),
      float(1),
    );
    return col;
  }

  const groundProc = Fn(() => groundColorAtWorldXZ(positionWorld.xz));

  function syncFromParams(p) {
    gBase.value.set(p.baseColor).convertSRGBToLinear();
    gContrast.value = p.contrast;
    gBrightness.value = p.brightness;
    syncGroundLayerUniforms(p.layer1, gL1);
    syncGroundLayerUniforms(p.layer2, gL2);
  }

  return {
    groundProc,
    groundColorAtWorldXZ,
    groundUniforms: { gBase, gContrast, gBrightness, gL1, gL2 },
    syncFromParams,
  };
}

export function applyGroundPresetToParams(presetId, targetParams) {
  const p = GROUND_PRESETS[presetId];
  if (!p) return;
  targetParams.brightness = p.brightness;
  targetParams.contrast = p.contrast;
  targetParams.baseColor = p.baseColor;
  Object.assign(targetParams.layer1, { ...p.layer1 });
  Object.assign(targetParams.layer2, { ...p.layer2 });
}
