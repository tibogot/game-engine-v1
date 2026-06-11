/**
 * Cliff instancer blend material — v1 cliffBlendMat parity:
 * active terrain ground on flat tops (normalWorld.y), cliff-rock triplanar on steep faces,
 * slope noise, optional cliff paint layer (R = strength).
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  mix,
  texture,
  positionWorld,
  normalWorld,
  smoothstep,
  clamp,
  uniform,
  mx_noise_float,
} from "three/tsl";
import { normalMap } from "three/tsl";
import { cliffBlendGroundColor } from "../../render/cliffs/cliffBlendGroundColor.js";

/**
 * @param {object} opts
 * @param {number} opts.worldSize
 * @param {number} opts.worldHalf
 * @param {THREE.Texture} opts.rockColorTex
 * @param {THREE.Texture} opts.rockDataTex
 * @param {ReturnType<import("./chunkTerrainAutoCliff.js").createAutoCliffUniforms>} opts.cliffU
 * @param {THREE.Texture} opts.cliffPaintTex
 * @param {Parameters<typeof cliffBlendGroundColor>[1]} opts.groundDeps
 */
export function createCliffInstancerBlendMaterial(opts) {
  const {
    worldSize,
    worldHalf,
    rockColorTex,
    rockDataTex,
    cliffU,
    cliffPaintTex,
    groundDeps,
  } = opts;

  const uCBSlopeLow = uniform(0.5);
  const uCBSlopeHigh = uniform(0.85);
  const uCBNoiseScale = uniform(0.06);
  const uCBNoiseStr = uniform(0.15);
  const uCBGroundScale = uniform(1.0);
  const uCBGroundOffsetX = uniform(0.0);
  const uCBGroundOffsetZ = uniform(0.0);
  const uCBRockScaleMul = uniform(1.0);

  const uWs = float(worldSize);
  const uWh = float(worldHalf);

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0,
  });

  mat.side = THREE.DoubleSide;
  mat.transparent = false;
  mat.depthWrite = true;
  mat.depthTest = true;
  mat.opacity = 1;
  mat.blending = THREE.NormalBlending;
  mat.premultipliedAlpha = false;
  mat.envMapIntensity = 0;

  const getCBPaintUV = () =>
    positionWorld.xz.add(vec2(uWh, uWh)).div(vec2(uWs, uWs));

  const cliffGroundWorldXZ = () =>
    positionWorld.xz
      .add(vec2(uCBGroundOffsetX, uCBGroundOffsetZ))
      .mul(uCBGroundScale);

  const evaluateGround = () =>
    cliffBlendGroundColor(cliffGroundWorldXZ(), groundDeps);

  mat.colorNode = Fn(() => {
    const ground = evaluateGround();

    const cbRockScale = cliffU.uRockScale.mul(uCBRockScaleMul);
    const rockUV_XZ = positionWorld.xz.mul(cbRockScale);
    const rockUV_XY = positionWorld.xy.mul(cbRockScale);
    const rockUV_ZY = positionWorld.zy.mul(cbRockScale);
    const triWRaw = normalWorld.abs().pow(cliffU.uTriplanarSharp);
    const triW = triWRaw.div(triWRaw.x.add(triWRaw.y).add(triWRaw.z));
    const rawRock = texture(rockColorTex, rockUV_XZ)
      .rgb.mul(triW.y)
      .add(texture(rockColorTex, rockUV_XY).rgb.mul(triW.z))
      .add(texture(rockColorTex, rockUV_ZY).rgb.mul(triW.x));
    const cRock = clamp(
      rawRock.sub(float(0.5)).mul(cliffU.uRockContrast).add(float(0.5)),
      0.0,
      1.0,
    );
    const rock = cRock.mul(cliffU.uRockBrightness).mul(cliffU.uRockTint);

    const noiseOffset = mx_noise_float(positionWorld.xz.mul(uCBNoiseScale)).mul(
      uCBNoiseStr,
    );
    const slopeVal = normalWorld.y.add(noiseOffset);
    const blend = smoothstep(uCBSlopeLow, uCBSlopeHigh, slopeVal);

    let col = mix(rock, ground, blend);

    const cpaint = texture(cliffPaintTex, getCBPaintUV());
    col = mix(col, ground, cpaint.r);

    return col;
  })();

  mat.normalNode = (() => {
    const cbRockScaleN = cliffU.uRockScale.mul(uCBRockScaleMul);
    const _nuvXZ = positionWorld.xz.mul(cbRockScaleN);
    const _nuvXY = positionWorld.xy.mul(cbRockScaleN);
    const _nuvZY = positionWorld.zy.mul(cbRockScaleN);
    const _ntWRaw = normalWorld.abs().pow(cliffU.uTriplanarSharp);
    const _ntW = _ntWRaw.div(_ntWRaw.x.add(_ntWRaw.y).add(_ntWRaw.z));
    const rNrmBA_XZ = texture(rockDataTex, _nuvXZ).ba;
    const rNrmBA_XY = texture(rockDataTex, _nuvXY).ba;
    const rNrmBA_ZY = texture(rockDataTex, _nuvZY).ba;
    const rNrmBA = rNrmBA_XZ
      .mul(_ntW.y)
      .add(rNrmBA_XY.mul(_ntW.z))
      .add(rNrmBA_ZY.mul(_ntW.x));
    const rNrmVec = vec3(rNrmBA.x, rNrmBA.y, float(1.0));
    const noiseOffset2 = mx_noise_float(
      positionWorld.xz.mul(uCBNoiseScale),
    ).mul(uCBNoiseStr);
    const blend2 = smoothstep(
      uCBSlopeLow,
      uCBSlopeHigh,
      normalWorld.y.add(noiseOffset2),
    );
    const flatNm = vec3(0.5, 0.5, 1.0);
    return normalMap(mix(rNrmVec, flatNm, blend2));
  })();

  mat.roughnessNode = Fn(() => {
    const cbRockScaleR = cliffU.uRockScale.mul(uCBRockScaleMul);
    const noiseOffset3 = mx_noise_float(
      positionWorld.xz.mul(uCBNoiseScale),
    ).mul(uCBNoiseStr);
    const blend3 = smoothstep(
      uCBSlopeLow,
      uCBSlopeHigh,
      normalWorld.y.add(noiseOffset3),
    );
    const rockRough = texture(
      rockDataTex,
      positionWorld.xz.mul(cbRockScaleR),
    ).r;
    return mix(rockRough, float(0.9), blend3);
  })();

  return {
    material: mat,
    uCBSlopeLow,
    uCBSlopeHigh,
    uCBNoiseScale,
    uCBNoiseStr,
    uCBGroundScale,
    uCBGroundOffsetX,
    uCBGroundOffsetZ,
    uCBRockScaleMul,
  };
}
