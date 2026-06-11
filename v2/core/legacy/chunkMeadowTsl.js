/**
 * Shared meadow procedural stack matching splatmap-painter10bvh+post.html `meadowProc` + `groundLayerMask`.
 * Uniforms are shared across all chunk TSL materials (one sync updates every chunk).
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  mix,
  smoothstep,
  clamp,
  sub,
  add,
  mul,
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

function groundLayerMask(U) {
  const p = vec2(
    positionWorld.x.mul(U.scale).add(U.offsetX),
    positionWorld.z.mul(U.scale).add(U.offsetY),
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

function syncMeadowLayerUniforms(L, U) {
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

/** Default meadow = painter `sPARAMS` default preset. */
export const MEADOW_DEFAULT_PARAMS = {
  brightness: 1.05,
  contrast: 1.1,
  baseColor: "#dfcba9",
  layer1: {
    enable: true,
    noiseType: "perlin",
    color: "#a07818",
    strength: 0.32,
    useFbm: true,
    octaves: 3.5,
    lacunarity: 2.4,
    gain: 0.5,
    scale: 0.031,
    offsetX: 17,
    offsetY: 43,
    invert: false,
    maskLow: 0.38,
    maskHigh: 0.68,
    maskSharpness: 1.0,
    voronoiJitter: 0.8,
  },
  layer2: {
    enable: false,
    noiseType: "perlin",
    color: "#e0c850",
    strength: 0.35,
    useFbm: true,
    octaves: 2.5,
    lacunarity: 2.2,
    gain: 0.5,
    scale: 0.045,
    offsetX: 88.1,
    offsetY: 16.4,
    invert: false,
    maskLow: 0.45,
    maskHigh: 0.78,
    maskSharpness: 1.0,
    voronoiJitter: 0.7,
  },
};

export const MEADOW_PRESETS = {
  default: MEADOW_DEFAULT_PARAMS,
  summerStraw: {
    brightness: 1.14,
    contrast: 0.96,
    baseColor: "#ead8b8",
    layer1: {
      enable: true,
      noiseType: "perlin",
      color: "#b89850",
      strength: 0.3,
      useFbm: true,
      octaves: 3,
      lacunarity: 2.35,
      gain: 0.48,
      scale: 0.038,
      offsetX: -6,
      offsetY: 51,
      invert: false,
      maskLow: 0.36,
      maskHigh: 0.72,
      maskSharpness: 0.95,
      voronoiJitter: 0.82,
    },
    layer2: {
      enable: true,
      noiseType: "value",
      color: "#d4c090",
      strength: 0.18,
      useFbm: true,
      octaves: 2.5,
      lacunarity: 2.1,
      gain: 0.5,
      scale: 0.062,
      offsetX: 33,
      offsetY: -12,
      invert: false,
      maskLow: 0.48,
      maskHigh: 0.85,
      maskSharpness: 1.1,
      voronoiJitter: 0.75,
    },
  },
  springLush: {
    brightness: 1.08,
    contrast: 1.05,
    baseColor: "#d4e8b8",
    layer1: {
      enable: true,
      noiseType: "perlin",
      color: "#5a8040",
      strength: 0.36,
      useFbm: true,
      octaves: 4,
      lacunarity: 2.3,
      gain: 0.5,
      scale: 0.026,
      offsetX: 24,
      offsetY: -8,
      invert: false,
      maskLow: 0.34,
      maskHigh: 0.66,
      maskSharpness: 1.05,
      voronoiJitter: 0.78,
    },
    layer2: {
      enable: true,
      noiseType: "simplex",
      color: "#8fb860",
      strength: 0.24,
      useFbm: true,
      octaves: 3,
      lacunarity: 2.2,
      gain: 0.5,
      scale: 0.048,
      offsetX: -40,
      offsetY: 36,
      invert: false,
      maskLow: 0.42,
      maskHigh: 0.78,
      maskSharpness: 0.9,
      voronoiJitter: 0.72,
    },
  },
  shadedCool: {
    brightness: 0.9,
    contrast: 1.14,
    baseColor: "#c8bdb0",
    layer1: {
      enable: true,
      noiseType: "perlin",
      color: "#6a6860",
      strength: 0.38,
      useFbm: true,
      octaves: 3.5,
      lacunarity: 2.45,
      gain: 0.52,
      scale: 0.029,
      offsetX: 9,
      offsetY: 22,
      invert: false,
      maskLow: 0.32,
      maskHigh: 0.64,
      maskSharpness: 1.15,
      voronoiJitter: 0.8,
    },
    layer2: {
      enable: true,
      noiseType: "simplex",
      color: "#8a8580",
      strength: 0.2,
      useFbm: false,
      octaves: 2.5,
      lacunarity: 2.0,
      gain: 0.5,
      scale: 0.055,
      offsetX: 62,
      offsetY: -28,
      invert: true,
      maskLow: 0.4,
      maskHigh: 0.76,
      maskSharpness: 1.0,
      voronoiJitter: 0.68,
    },
  },
  wildflower: {
    brightness: 1.06,
    contrast: 1.08,
    baseColor: "#e8d4c4",
    layer1: {
      enable: true,
      noiseType: "perlin",
      color: "#b88840",
      strength: 0.34,
      useFbm: true,
      octaves: 3.5,
      lacunarity: 2.4,
      gain: 0.5,
      scale: 0.032,
      offsetX: 11,
      offsetY: 47,
      invert: false,
      maskLow: 0.37,
      maskHigh: 0.69,
      maskSharpness: 1.0,
      voronoiJitter: 0.8,
    },
    layer2: {
      enable: true,
      noiseType: "voronoi",
      color: "#9a7898",
      strength: 0.16,
      useFbm: false,
      octaves: 2,
      lacunarity: 2.0,
      gain: 0.5,
      scale: 0.058,
      offsetX: -25,
      offsetY: 19,
      invert: false,
      maskLow: 0.5,
      maskHigh: 0.88,
      maskSharpness: 1.35,
      voronoiJitter: 0.62,
    },
  },
  goldenHour: {
    brightness: 1.2,
    contrast: 1.02,
    baseColor: "#f0d4a0",
    layer1: {
      enable: true,
      noiseType: "perlin",
      color: "#c09030",
      strength: 0.35,
      useFbm: true,
      octaves: 3,
      lacunarity: 2.35,
      gain: 0.46,
      scale: 0.034,
      offsetX: 19,
      offsetY: 38,
      invert: false,
      maskLow: 0.35,
      maskHigh: 0.7,
      maskSharpness: 0.92,
      voronoiJitter: 0.85,
    },
    layer2: {
      enable: true,
      noiseType: "simplex",
      color: "#e8b860",
      strength: 0.22,
      useFbm: true,
      octaves: 2.5,
      lacunarity: 2.25,
      gain: 0.48,
      scale: 0.05,
      offsetX: 72,
      offsetY: -15,
      invert: false,
      maskLow: 0.46,
      maskHigh: 0.82,
      maskSharpness: 1.05,
      voronoiJitter: 0.74,
    },
  },
};

/**
 * @param {typeof MEADOW_DEFAULT_PARAMS} initial
 * @returns {{ meadowProc: ReturnType<typeof Fn>, syncFromParams: (p: typeof MEADOW_DEFAULT_PARAMS) => void }}
 */
export function createMeadowTslBundle(initial) {
  const sBase = uniform(toLinear(initial.baseColor));
  const sContrast = uniform(initial.contrast, "float");
  const sBrightness = uniform(initial.brightness, "float");
  const sL1 = groundLayerUniforms(initial.layer1);
  const sL2 = groundLayerUniforms(initial.layer2);

  const meadowProc = Fn(() => {
    let col = sBase;
    col = mix(col, sL1.color, groundLayerMask(sL1));
    col = mix(col, sL2.color, groundLayerMask(sL2));
    col = clamp(
      sub(col, float(0.5)).mul(sContrast).add(float(0.5)).mul(sBrightness),
      float(0),
      float(1),
    );
    return col;
  });

  function syncFromParams(p) {
    sBase.value.set(p.baseColor).convertSRGBToLinear();
    sContrast.value = p.contrast;
    sBrightness.value = p.brightness;
    syncMeadowLayerUniforms(p.layer1, sL1);
    syncMeadowLayerUniforms(p.layer2, sL2);
  }

  return { meadowProc, syncFromParams };
}

export function applyMeadowPresetToParams(presetId, targetParams) {
  const p = MEADOW_PRESETS[presetId];
  if (!p) return;
  targetParams.brightness = p.brightness;
  targetParams.contrast = p.contrast;
  targetParams.baseColor = p.baseColor;
  Object.assign(targetParams.layer1, { ...p.layer1 });
  Object.assign(targetParams.layer2, { ...p.layer2 });
}
