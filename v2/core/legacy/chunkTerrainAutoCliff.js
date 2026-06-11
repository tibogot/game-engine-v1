/**
 * Auto cliff shading matching splatmap-painter10bvh+post.html:
 * heightTex finite-difference flatness → slope mask, Rock028 triplanar albedo/normal/roughness + AO.
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  texture,
  positionWorld,
  positionLocal,
  normalWorld,
  mix,
  smoothstep,
  clamp,
  sqrt,
  max,
  uniform,
  step,
} from "three/tsl";
import { normalMap } from "three/tsl";
import {
  applyImageSlotAlbedoAndAO,
  applyImageSlotRoughness,
  evaluateImageSlotNormalRaw,
} from "./chunkTerrainImageSlotsTsl.js";

function packChannelIntoDataTexture(dt, imgEl, channelIdx) {
  const size = dt.image.width;
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = size;
  const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });
  tmpCtx.drawImage(imgEl, 0, 0, size, size);
  const src = tmpCtx.getImageData(0, 0, size, size).data;
  const dst = dt.image.data;
  for (let i = 0, n = dst.length >> 2; i < n; i++)
    dst[i * 4 + channelIdx] = src[i * 4];
  dt.needsUpdate = true;
}

function packNormalIntoDataTextureBA(dt, imgEl) {
  const size = dt.image.width;
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = size;
  const tmpCtx = tmp.getContext("2d", { willReadFrequently: true });
  tmpCtx.drawImage(imgEl, 0, 0, size, size);
  const src = tmpCtx.getImageData(0, 0, size, size).data;
  const dst = dt.image.data;
  for (let i = 0, n = dst.length >> 2; i < n; i++) {
    dst[i * 4 + 2] = src[i * 4];
    dst[i * 4 + 3] = src[i * 4 + 1];
  }
  dt.needsUpdate = true;
}

const ROCK028_RES = 1024;
const TEX_BASE = "/textures/pbr_materials/Rock028";

/**
 * @returns {Promise<{ colorTex: THREE.Texture, dataTex: THREE.DataTexture }>}
 */
export function loadRock028Textures() {
  const loader = new THREE.TextureLoader();
  return new Promise((resolve, reject) => {
    const colorTex = loader.load(
      `${TEX_BASE}/Rock028_2K-JPG_Color.jpg`,
      () => {},
      undefined,
      reject,
    );
    colorTex.wrapS = colorTex.wrapT = THREE.RepeatWrapping;
    colorTex.colorSpace = THREE.SRGBColorSpace;

    const dataTex = new THREE.DataTexture(
      new Uint8Array(ROCK028_RES * ROCK028_RES * 4),
      ROCK028_RES,
      ROCK028_RES,
      THREE.RGBAFormat,
    );
    dataTex.wrapS = dataTex.wrapT = THREE.RepeatWrapping;
    dataTex.colorSpace = THREE.LinearSRGBColorSpace;

    let pending = 3;
    const doneOne = () => {
      pending--;
      if (pending === 0) resolve({ colorTex, dataTex });
    };

    loader.load(`${TEX_BASE}/Rock028_2K-JPG_Roughness.jpg`, (t) => {
      packChannelIntoDataTexture(dataTex, t.image, 0);
      doneOne();
    });
    loader.load(`${TEX_BASE}/Rock028_2K-JPG_AmbientOcclusion.jpg`, (t) => {
      packChannelIntoDataTexture(dataTex, t.image, 1);
      doneOne();
    });
    loader.load(`${TEX_BASE}/Rock028_2K-JPG_NormalGL.jpg`, (t) => {
      packNormalIntoDataTextureBA(dataTex, t.image);
      doneOne();
    });
  });
}

/** Same defaults as splatmap-painter slope + rock folders (TSL uniform nodes). */
export function createAutoCliffUniforms() {
  return {
    uSlopeStart: uniform(0.6),
    uSlopeEnd: uniform(0.7),
    uRockScale: uniform(0.05),
    uRockBrightness: uniform(0.85),
    uRockContrast: uniform(1.1),
    uRockTint: uniform(new THREE.Color(1, 1, 1)),
    uRockNormalStr: uniform(1.0),
    uRockBlendSharp: uniform(1.0),
    uRockRoughMul: uniform(1.0),
    uTriplanarSharp: uniform(4.0),
  };
}

/**
 * Shared slope + cliff-rock triplanar (painter splatMat). Use inside one Fn(() => { ... }) per material.
 */
export function createCliffShadingContext(
  heightTex,
  rockColorTex,
  rockDataTex,
  cliffU,
  worldSize,
  worldHalf,
  htexRes,
) {
  const uTerrainHalf = float(worldHalf);
  const uTerrainSize = float(worldSize);
  const uHeightTexStep = float(4.0 / htexRes);
  const uHeightToWorld = float((4.0 * worldSize) / htexRes);

  const getWorldHeightUV = () =>
    positionWorld.xz.add(uTerrainHalf).div(uTerrainSize);

  const getHeightTexFlatness = () => {
    const uv = getWorldHeightUV();
    const hR = texture(heightTex, uv.add(vec2(uHeightTexStep, float(0)))).r;
    const hL = texture(
      heightTex,
      uv.add(vec2(uHeightTexStep.negate(), float(0))),
    ).r;
    const hU = texture(heightTex, uv.add(vec2(float(0), uHeightTexStep))).r;
    const hD = texture(
      heightTex,
      uv.add(vec2(float(0), uHeightTexStep.negate())),
    ).r;
    const dhdx = hR.sub(hL).div(uHeightToWorld.mul(float(2)));
    const dhdz = hU.sub(hD).div(uHeightToWorld.mul(float(2)));
    const steepness = sqrt(dhdx.mul(dhdx).add(dhdz.mul(dhdz)));
    return float(1).div(float(1).add(steepness));
  };

  const getSlopeMask = () =>
    smoothstep(cliffU.uSlopeStart, cliffU.uSlopeEnd, getHeightTexFlatness());

  const triWeights = () => {
    const raw = normalWorld.abs().pow(cliffU.uTriplanarSharp);
    return raw.div(raw.x.add(raw.y).add(raw.z));
  };

  const rockAlbedo = () => {
    const w = triWeights();
    const rockUV_XZ = positionWorld.xz.mul(cliffU.uRockScale);
    const rockUV_XY = positionWorld.xy.mul(cliffU.uRockScale);
    const rockUV_ZY = positionWorld.zy.mul(cliffU.uRockScale);
    const rawRock = texture(rockColorTex, rockUV_XZ)
      .rgb.mul(w.y)
      .add(texture(rockColorTex, rockUV_XY).rgb.mul(w.z))
      .add(texture(rockColorTex, rockUV_ZY).rgb.mul(w.x));
    const contrastedRock = clamp(
      rawRock.sub(float(0.5)).mul(cliffU.uRockContrast).add(float(0.5)),
      float(0),
      float(1),
    );
    return contrastedRock.mul(cliffU.uRockBrightness).mul(cliffU.uRockTint);
  };

  const rockAO = () => {
    const w = triWeights();
    const rockUV_XZ = positionWorld.xz.mul(cliffU.uRockScale);
    const rockUV_XY = positionWorld.xy.mul(cliffU.uRockScale);
    const rockUV_ZY = positionWorld.zy.mul(cliffU.uRockScale);
    return texture(rockDataTex, rockUV_XZ)
      .g.mul(w.y)
      .add(texture(rockDataTex, rockUV_XY).g.mul(w.z))
      .add(texture(rockDataTex, rockUV_ZY).g.mul(w.x));
  };

  /** Call inside same Fn as terrain color; `col` = vec3 terrain (+ splat). */
  const augmentColor = (col) => {
    const slopeMask = getSlopeMask().pow(cliffU.uRockBlendSharp);
    const ra = rockAlbedo();
    let out = mix(ra, col, slopeMask);
    out = out.mul(mix(rockAO(), float(1.0), slopeMask));
    return out;
  };

  /** Call only inside Fn(() => { ... }) — returns cliff raw normal in 0-1 space (before normalMap). */
  const evaluateNormalInFn = () => {
    const w = triWeights();
    const rockUV_XZ = positionWorld.xz.mul(cliffU.uRockScale);
    const rockUV_XY = positionWorld.xy.mul(cliffU.uRockScale);
    const rockUV_ZY = positionWorld.zy.mul(cliffU.uRockScale);
    const _dXZ = texture(rockDataTex, rockUV_XZ);
    const _dXY = texture(rockDataTex, rockUV_XY);
    const _dZY = texture(rockDataTex, rockUV_ZY);
    const _nxXZ = _dXZ.b.mul(2.0).sub(1.0);
    const _nyXZ = _dXZ.a.mul(2.0).sub(1.0);
    const _nzXZ = sqrt(
      max(float(0.0), float(1.0).sub(_nxXZ.mul(_nxXZ)).sub(_nyXZ.mul(_nyXZ))),
    );
    const _nxXY = _dXY.b.mul(2.0).sub(1.0);
    const _nyXY = _dXY.a.mul(2.0).sub(1.0);
    const _nzXY = sqrt(
      max(float(0.0), float(1.0).sub(_nxXY.mul(_nxXY)).sub(_nyXY.mul(_nyXY))),
    );
    const _nxZY = _dZY.b.mul(2.0).sub(1.0);
    const _nyZY = _dZY.a.mul(2.0).sub(1.0);
    const _nzZY = sqrt(
      max(float(0.0), float(1.0).sub(_nxZY.mul(_nxZY)).sub(_nyZY.mul(_nyZY))),
    );
    const _nWXZ = vec3(_nxXZ, _nzXZ, _nyXZ);
    const _nWXY = vec3(_nxXY, _nyXY, _nzXY);
    const _nWZY = vec3(_nzZY, _nyZY, _nxZY);
    const _nBlend = _nWXZ
      .mul(w.y)
      .add(_nWXY.mul(w.z))
      .add(_nWZY.mul(w.x))
      .normalize();
    const rock028NmRGB = _nBlend.mul(0.5).add(0.5);
    const flatNm = vec3(0.5, 0.5, 1.0);
    const rock028NmStrength = mix(flatNm, rock028NmRGB, cliffU.uRockNormalStr);
    const flatTerrainNm = vec3(0.5, 0.5, 1.0);
    return mix(
      rock028NmStrength,
      flatTerrainNm,
      getSlopeMask().pow(cliffU.uRockBlendSharp),
    );
  };

  const buildNormalNode = () =>
    Fn(() => normalMap(evaluateNormalInFn(), vec2(0.25, 0.25)))();

  /** Rock normal (0-1 space), strength-applied, BEFORE slope-mask blending with terrain. */
  const evaluateRockNormalRawInFn = () => {
    const w = triWeights();
    const rockUV_XZ = positionWorld.xz.mul(cliffU.uRockScale);
    const rockUV_XY = positionWorld.xy.mul(cliffU.uRockScale);
    const rockUV_ZY = positionWorld.zy.mul(cliffU.uRockScale);
    const _dXZ = texture(rockDataTex, rockUV_XZ);
    const _dXY = texture(rockDataTex, rockUV_XY);
    const _dZY = texture(rockDataTex, rockUV_ZY);
    const _nxXZ = _dXZ.b.mul(2.0).sub(1.0);
    const _nyXZ = _dXZ.a.mul(2.0).sub(1.0);
    const _nzXZ = sqrt(
      max(float(0.0), float(1.0).sub(_nxXZ.mul(_nxXZ)).sub(_nyXZ.mul(_nyXZ))),
    );
    const _nxXY = _dXY.b.mul(2.0).sub(1.0);
    const _nyXY = _dXY.a.mul(2.0).sub(1.0);
    const _nzXY = sqrt(
      max(float(0.0), float(1.0).sub(_nxXY.mul(_nxXY)).sub(_nyXY.mul(_nyXY))),
    );
    const _nxZY = _dZY.b.mul(2.0).sub(1.0);
    const _nyZY = _dZY.a.mul(2.0).sub(1.0);
    const _nzZY = sqrt(
      max(float(0.0), float(1.0).sub(_nxZY.mul(_nxZY)).sub(_nyZY.mul(_nyZY))),
    );
    const _nWXZ = vec3(_nxXZ, _nzXZ, _nyXZ);
    const _nWXY = vec3(_nxXY, _nyXY, _nzXY);
    const _nWZY = vec3(_nzZY, _nyZY, _nxZY);
    const _nBlend = _nWXZ
      .mul(w.y)
      .add(_nWXY.mul(w.z))
      .add(_nWZY.mul(w.x))
      .normalize();
    const rock028NmRGB = _nBlend.mul(0.5).add(0.5);
    const flatNm = vec3(0.5, 0.5, 1.0);
    return mix(flatNm, rock028NmRGB, cliffU.uRockNormalStr);
  };

  /** Rock roughness only (before slope-mask blending). */
  const evaluateRockRoughnessRawInFn = () => {
    const w = triWeights();
    const _rrXZ = positionWorld.xz.mul(cliffU.uRockScale);
    const _rrXY = positionWorld.xy.mul(cliffU.uRockScale);
    const _rrZY = positionWorld.zy.mul(cliffU.uRockScale);
    return clamp(
      texture(rockDataTex, _rrXZ)
        .r.mul(w.y)
        .add(texture(rockDataTex, _rrXY).r.mul(w.z))
        .add(texture(rockDataTex, _rrZY).r.mul(w.x))
        .mul(cliffU.uRockRoughMul),
      float(0),
      float(1),
    );
  };

  /** Call only inside `Fn(() => { ... })` — cliff-only roughness before image-slot mix. */
  const evaluateRoughnessInFn = () => {
    const baseRough = float(0.85);
    return mix(
      evaluateRockRoughnessRawInFn(),
      baseRough,
      getSlopeMask().pow(cliffU.uRockBlendSharp),
    );
  };

  const buildRoughnessNode = () => Fn(() => evaluateRoughnessInFn())();

  return {
    augmentColor,
    buildNormalNode,
    buildRoughnessNode,
    evaluateRoughnessInFn,
    evaluateNormalInFn,
    getSlopeMask,
    evaluateRockNormalRawInFn,
    evaluateRockRoughnessRawInFn,
  };
}

/**
 * Splat base + auto cliff.
 */
export function createChunkSplatCliffMaterial(
  splatTex,
  chunkSize,
  heightTex,
  rockColorTex,
  rockDataTex,
  cliffU,
  worldSize,
  worldHalf,
  htexRes,
  imgWeightTex = null,
  imageSlots = null,
) {
  splatTex.anisotropy = 8;
  splatTex.flipY = false;

  const cs = float(chunkSize);
  const cliff = createCliffShadingContext(
    heightTex,
    rockColorTex,
    rockDataTex,
    cliffU,
    worldSize,
    worldHalf,
    htexRes,
  );

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.02,
  });
  mat.envMapIntensity = 0;

  mat.colorNode = Fn(() => {
    const splatUV = positionLocal.xz.div(cs).add(vec2(0.5, 0.5));
    const s = texture(splatTex, splatUV);
    const base = vec3(0.22, 0.38, 0.13);
    const layR = vec3(0.34, 0.27, 0.16);
    const layG = vec3(0.36, 0.52, 0.22);
    const layB = vec3(0.46, 0.4, 0.28);
    let col = base;
    col = mix(col, layR, s.r);
    col = mix(col, layG, s.g);
    col = mix(col, layB, s.b);
    if (imgWeightTex && imageSlots) {
      col = applyImageSlotAlbedoAndAO(
        col,
        cs,
        float(worldSize),
        imgWeightTex,
        imageSlots,
      );
    }
    return cliff.augmentColor(col);
  })();

  if (imgWeightTex && imageSlots) {
    mat.normalNode = Fn(() => {
      const cliffRawNm = cliff.evaluateNormalInFn();
      const splatUV = positionLocal.xz.div(cs).add(vec2(0.5, 0.5));
      const imgW = texture(imgWeightTex, splatUV);
      const { raw: imgRawNm, weight: imgSlotW } = evaluateImageSlotNormalRaw(
        float(worldSize),
        imageSlots,
        imgW,
      );
      const combined = mix(cliffRawNm, imgRawNm, imgSlotW);
      return normalMap(combined, vec2(0.25, 0.25));
    })();
    mat.roughnessNode = Fn(() =>
      applyImageSlotRoughness(
        cliff.evaluateRoughnessInFn(),
        cs,
        float(worldSize),
        imgWeightTex,
        imageSlots,
      ),
    )();
  } else {
    mat.normalNode = cliff.buildNormalNode();
    mat.roughnessNode = cliff.buildRoughnessNode();
  }

  mat.opacityNode = Fn(() => {
    const splatUV = positionLocal.xz.div(cs).add(vec2(0.5, 0.5));
    const s = texture(splatTex, splatUV);
    return float(1.0).sub(step(float(0.25), s.a));
  })();
  mat.alphaTest = 0.5;
  mat.transparent = false;

  return mat;
}
