/**
 * Procedural snow-cap material for object meshes (roofs, rocks, trees, GLBs).
 *
 * WebGPU note: driving `positionNode` with noise/uniform displacement alongside
 * the fragment snow graph causes black silhouettes in Three r184. We keep
 * displacement visual via normal perturbation instead; thickness still controls
 * the bump strength live from the inspector.
 */
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three";
import {
  Fn,
  cameraPosition,
  dot,
  float,
  mix,
  mx_noise_float,
  normalLocal,
  normalWorld,
  normalize,
  positionLocal,
  positionWorld,
  reflect,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl";

export function createSnowCapUniforms(params = {}) {
  return {
    amount: uniform(params.amount ?? 1),
    thickness: uniform(params.thickness ?? 0.28),
    coverage: uniform(params.coverage ?? 0.52),
    buildup: uniform(params.buildup ?? 1.55),
    displaceEnabled: uniform(params.displaceEnabled !== false ? 1 : 0),
    topMin: uniform(params.topMin ?? 0.08),
    topMax: uniform(params.topMax ?? 0.88),
    sideGather: uniform(params.sideGather ?? 0.12),
    useWorldUp: uniform(params.useWorldUp !== false ? 1 : 0),
    useWorldUV: uniform(params.useWorldUV !== false ? 1 : 0),
    noiseScale: uniform(params.noiseScale ?? 0.35),
    freq1: uniform(params.freq1 ?? 0.18),
    freq2: uniform(params.freq2 ?? 0.42),
    noiseAmp: uniform(params.noiseAmp ?? 0.85),
    microFreq: uniform(params.microFreq ?? 1.6),
    microAmp: uniform(params.microAmp ?? 0.08),
    roughSnow: uniform(params.roughnessSnow ?? 0.96),
    roughBase: uniform(params.roughnessBase ?? 0.62),
    coldShadow: uniform(params.coldShadow ?? 0.55),
    glitterIntensity: uniform(params.glitterIntensity ?? 2.2),
    glitterScarcity: uniform(params.glitterScarcity ?? 220),
    glitterFreq: uniform(params.glitterFreq ?? 180),
    shimmerAmp: uniform(params.shimmerAmp ?? 0.35),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
  };
}

export function syncSnowCapUniforms(u, p) {
  u.amount.value = p.amount ?? 1;
  u.thickness.value = p.thickness ?? 0.28;
  u.coverage.value = p.coverage ?? 0.52;
  u.buildup.value = p.buildup ?? 1.55;
  u.displaceEnabled.value = p.displaceEnabled !== false ? 1 : 0;
  u.topMin.value = p.topMin ?? 0.08;
  u.topMax.value = p.topMax ?? 0.88;
  u.sideGather.value = p.sideGather ?? 0.12;
  u.useWorldUp.value = p.useWorldUp !== false ? 1 : 0;
  u.useWorldUV.value = p.useWorldUV !== false ? 1 : 0;
  u.noiseScale.value = p.noiseScale ?? 0.35;
  u.freq1.value = p.freq1 ?? 0.18;
  u.freq2.value = p.freq2 ?? 0.42;
  u.noiseAmp.value = p.noiseAmp ?? 0.85;
  u.microFreq.value = p.microFreq ?? 1.6;
  u.microAmp.value = p.microAmp ?? 0.08;
  u.roughSnow.value = p.roughnessSnow ?? 0.96;
  u.roughBase.value = p.roughnessBase ?? 0.62;
  u.coldShadow.value = p.coldShadow ?? 0.55;
  u.glitterIntensity.value = p.glitterIntensity ?? 2.2;
  u.glitterScarcity.value = p.glitterScarcity ?? 220;
  u.glitterFreq.value = p.glitterFreq ?? 180;
  u.shimmerAmp.value = p.shimmerAmp ?? 0.35;
}

export function createSnowCapMaterial(baseHex, sharedU) {
  const u = sharedU;
  const uBase = uniform(new THREE.Color(baseHex));

  const capUV = Fn(() => {
    const worldXZ = vec2(positionWorld.x, positionWorld.z).mul(u.noiseScale);
    const localXZ = vec2(positionLocal.x, positionLocal.z).mul(u.noiseScale);
    return mix(localXZ, worldXZ, u.useWorldUV);
  });

  const snowMask = Fn(() => {
    const N = normalize(mix(normalLocal, normalWorld, u.useWorldUp));
    const topMask = smoothstep(u.topMin, u.topMax, N.y);
    const sideMask = smoothstep(float(0), u.sideGather, N.y);
    const facing = topMask.add(sideMask.mul(float(1).sub(topMask)));
    const uv = capUV();
    const p1 = vec3(uv.x.mul(u.freq1), float(0), uv.y.mul(u.freq1));
    const p2 = vec3(uv.x.mul(u.freq2), float(0), uv.y.mul(u.freq2));
    const n1 = mx_noise_float(p1).mul(0.5).add(0.5);
    const n2 = mx_noise_float(p2).mul(0.5).add(0.5);
    const n = n1.mul(n2).mul(u.noiseAmp);
    const coverage = smoothstep(float(1).sub(u.coverage), float(1), n);
    return coverage.mul(facing).mul(u.amount);
  });

  const snowCol = Fn(() => {
    const uv = capUV();
    const shadowN = mx_noise_float(vec3(uv.x.mul(8), float(0), uv.y.mul(8)))
      .mul(0.5).add(0.5);
    const cold = vec3(0.76, 0.84, 0.98);
    const clean = vec3(0.98, 0.99, 1.0);
    let col = mix(cold, clean, smoothstep(0.12, 0.82, shadowN));
    col = mix(col, clean, float(1).sub(u.coldShadow).mul(shadowN));
    return col;
  });

  const snowEmissive = Fn(() => {
    const mask = snowMask();
    const uv = capUV();
    const mfCell = uv.mul(u.glitterFreq);
    const h1 = mx_noise_float(vec3(mfCell.x, float(0), mfCell.y).mul(0.19));
    const h2 = mx_noise_float(vec3(mfCell.x, float(17.3), mfCell.y).mul(0.23));
    const mfN = vec3(h1.sub(0.5).mul(0.55), float(1), h2.sub(0.5).mul(0.55)).normalize();
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const reflRay = reflect(u.sunDir.negate(), mfN);
    const specDot = dot(reflRay, viewDir).clamp(0, 1);
    const sparkle = specDot.pow(float(1200)).mul(u.glitterIntensity).mul(mask);
    const shimmerN = mx_noise_float(vec3(uv.x.mul(0.4), float(0), uv.y.mul(0.4)))
      .mul(0.5).add(0.5);
    const shimmer = shimmerN.pow(u.glitterScarcity).mul(u.glitterIntensity.mul(u.shimmerAmp)).mul(mask);
    const e = sparkle.add(shimmer);
    return vec3(e, e, e.mul(0.85));
  });

  const mat = new MeshStandardNodeMaterial({ metalness: 0 });
  mat.colorNode = mix(uBase, snowCol(), snowMask());
  mat.emissiveNode = snowEmissive();
  mat.roughnessNode = mix(u.roughBase, u.roughSnow, snowMask());
  mat.envMapIntensity = 0.6;
  return mat;
}

export function extractMeshBaseColor(mat) {
  if (!mat) return 0x888888;
  if (mat.color?.isColor) return mat.color.getHex();
  if (Array.isArray(mat) && mat[0]?.color) return mat[0].color.getHex();
  return 0x888888;
}
