/**
 * Volumetric cloud box (ray-marched) — ported from `clouds_terrain_1600-superjet.html`.
 * Depth prepass, occlusion mask, god-rays, scene → `finalRT`, composite, canvas blit (superjet-style).
 * Cloud mesh lives on {@link VOLUME_LAYER} so a layer-0 depth prepass excludes it.
 */
import * as THREE from "three";
import {
  float,
  vec2,
  vec3,
  vec4,
  Fn,
  Loop,
  If,
  Break,
  Discard,
  dot,
  exp,
  mix,
  normalize,
  texture,
  texture3D,
  uniform,
  uv,
  screenUV,
  modelViewMatrix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  cameraPosition,
  positionGeometry,
  varying,
  max,
  min,
  abs,
  pow,
  smoothstep,
  length,
  fract,
  mul,
  add,
  div,
} from "three/tsl";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";

const VOLUME_LAYER = 10;
const PI_VAL = 3.14159265359;
const MAX_RM_STEPS = 120;
const MAX_LIGHT_STEPS = 32;
const MAX_GOD_SAMPLES = 128;
const SUN_DISC_GEOM_RADIUS = 340;
/** Same as `clouds_terrain_1600-superjet.html` for distance-based step LOD. */
const LOD_DIST_NEAR = 180;
const LOD_DIST_FAR = 1200;

function createSeededRandom(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstepJS(edge0, edge1, x) {
  const t = Math.max(
    0,
    Math.min(1, (x - edge0) / Math.max(1e-5, edge1 - edge0)),
  );
  return t * t * (3 - 2 * t);
}

function fbm(perlin, x, y, z, octaves, persistence, lacunarity) {
  let total = 0.0;
  let frequency = 1.0;
  let amplitude = 1.0;
  let maxValue = 0.0;
  for (let i = 0; i < octaves; i++) {
    total +=
      perlin.noise(x * frequency, y * frequency, z * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return total / Math.max(1e-6, maxValue);
}

function createNoiseGeneratorFromPermutation(permTable) {
  const fade = (t) => t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  const lerp = (t, a, b) => a + t * (b - a);
  const grad = (hash, x, y, z) => {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  };
  return function noise(p) {
    const P = new THREE.Vector3(
      Math.floor(p.x),
      Math.floor(p.y),
      Math.floor(p.z),
    );
    const p_fract = p.clone().sub(P);
    const f = new THREE.Vector3(
      fade(p_fract.x),
      fade(p_fract.y),
      fade(p_fract.z),
    );
    const xi = P.x & 255,
      yi = P.y & 255,
      zi = P.z & 255;
    const A = permTable[xi],
      B = permTable[(xi + 1) & 255];
    const AA = permTable[(A + yi) & 255],
      BA = permTable[(B + yi) & 255];
    const AB = permTable[(A + yi + 1) & 255],
      BB = permTable[(B + yi + 1) & 255];
    const AAA = permTable[(AA + zi) & 255],
      BAA = permTable[(BA + zi) & 255];
    const ABA = permTable[(AB + zi) & 255],
      BBA = permTable[(BB + zi) & 255];
    const AAB = permTable[(AA + zi + 1) & 255],
      BAB = permTable[(BA + zi + 1) & 255];
    const ABB = permTable[(AB + zi + 1) & 255],
      BBB = permTable[(BB + zi + 1) & 255];
    const g1 = grad(AAA, p_fract.x, p_fract.y, p_fract.z),
      g2 = grad(BAA, p_fract.x - 1, p_fract.y, p_fract.z);
    const g3 = grad(ABA, p_fract.x, p_fract.y - 1, p_fract.z),
      g4 = grad(BBA, p_fract.x - 1, p_fract.y - 1, p_fract.z);
    const g5 = grad(AAB, p_fract.x, p_fract.y, p_fract.z - 1),
      g6 = grad(BAB, p_fract.x - 1, p_fract.y, p_fract.z - 1);
    const g7 = grad(ABB, p_fract.x, p_fract.y - 1, p_fract.z - 1),
      g8 = grad(BBB, p_fract.x - 1, p_fract.y - 1, p_fract.z - 1);
    return lerp(
      f.z,
      lerp(f.y, lerp(f.x, g1, g2), lerp(f.x, g3, g4)),
      lerp(f.y, lerp(f.x, g5, g6), lerp(f.x, g7, g8)),
    );
  };
}

function buildMaskTexture3D(maskSize, freq, seed) {
  const rnd = createSeededRandom(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const permTable = new Uint8Array(512);
  for (let i = 0; i < 256; i++) permTable[i] = permTable[i + 256] = p[i];
  const noiseGen = createNoiseGeneratorFromPermutation(permTable);
  const noiseMaskData = new Uint8Array(maskSize * maskSize * maskSize);
  const directionVector = new THREE.Vector3();
  for (let z = 0; z < maskSize; z++) {
    for (let y = 0; y < maskSize; y++) {
      for (let x = 0; x < maskSize; x++) {
        directionVector.set(
          (x / (maskSize - 1)) * 2.0 - 1.0,
          (y / (maskSize - 1)) * 2.0 - 1.0,
          (z / (maskSize - 1)) * 2.0 - 1.0,
        );
        if (directionVector.lengthSq() > 0) {
          directionVector.normalize();
          const noiseValue = noiseGen(
            directionVector.multiplyScalar(freq),
          );
          noiseMaskData[z * maskSize * maskSize + y * maskSize + x] =
            noiseValue * 128 + 128;
        }
      }
    }
  }
  const t = new THREE.Data3DTexture(
    noiseMaskData,
    maskSize,
    maskSize,
    maskSize,
  );
  t.format = THREE.RedFormat;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/**
 * @param {object} opts
 * @param {THREE.WebGPURenderer} opts.renderer
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {object} opts.toolState
 * @param {() => THREE.Vector3} opts.getSunDir
 * @param {THREE.DirectionalLight} opts.sun
 * @param {THREE.HemisphereLight} opts.hemi
 * @param {() => THREE.Object3D[]} [opts.getOccluderMeshes] — terrain/solids for occlusion pass (e.g. chunk meshes).
 */
export async function createVolumetricCloudSystem({
  renderer,
  scene,
  camera,
  toolState,
  getSunDir,
  sun,
  hemi,
  getOccluderMeshes = () => [],
}) {
  const p0 = toolState.volumetricCloud;
  const _drawingBuf = new THREE.Vector2();
  let w = 1;
  let h = 1;
  let hw = 1;
  let hh = 1;

  const finalRTDefaults = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
  };
  const effectRTDefaults = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  };

  function layoutEffectBufferSizes() {
    renderer.getDrawingBufferSize(_drawingBuf);
    w = Math.max(1, Math.floor(_drawingBuf.x));
    h = Math.max(1, Math.floor(_drawingBuf.y));
    const es = THREE.MathUtils.clamp(
      toolState.volumetricCloud.effectBufferScale ?? 0.35,
      0.2,
      1,
    );
    hw = Math.max(1, Math.floor(w * es));
    hh = Math.max(1, Math.floor(h * es));
  }
  layoutEffectBufferSizes();

  const depthTarget = new THREE.RenderTarget(w, h);
  depthTarget.depthTexture = new THREE.DepthTexture(w, h);
  depthTarget.depthTexture.format = THREE.DepthFormat;
  depthTarget.depthTexture.type = THREE.UnsignedShortType;

  const occlusionRT = new THREE.RenderTarget(hw, hh, effectRTDefaults);
  const godraysRT = new THREE.RenderTarget(hw, hh, effectRTDefaults);
  const finalRT = new THREE.RenderTarget(w, h, finalRTDefaults);

  const occlusionMaterialBlack = new THREE.MeshBasicMaterial({
    color: 0x000000,
    fog: false,
    toneMapped: false,
  });
  const occlusionLineBlack = new THREE.LineBasicMaterial({
    color: 0x000000,
    fog: false,
    toneMapped: false,
  });
  const occlusionMaterialWhite = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    fog: false,
    toneMapped: false,
  });
  /* Used in the depth prepass when `useDepthPrepassOverride` is on — only
     swapped onto chunk-terrain meshes so foliage / grass / plane keep their
     `positionNode` vertex displacement and write correct depth.
     `MeshBasicNodeMaterial` (Node variant) is the WebGPU-native path —
     plain `MeshBasicMaterial` triggers WebGPU validation errors about
     missing vertex buffer slot 1 when swapped onto chunk geometries. */
  const depthOnlyMat = new THREE.MeshBasicNodeMaterial();
  depthOnlyMat.fog = false;
  depthOnlyMat.toneMapped = false;
  depthOnlyMat.colorNode = vec4(0.0, 0.0, 0.0, 1.0);

  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  postScene.add(postQuad);

  const depthPlaceholder = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat);
  depthPlaceholder.needsUpdate = true;
  const depthTexNode = texture(depthPlaceholder, screenUV);

  let volumeTexture = new THREE.Data3DTexture(new Uint8Array(8), 2, 2, 2);
  volumeTexture.format = THREE.RedFormat;
  volumeTexture.minFilter = THREE.LinearFilter;
  volumeTexture.magFilter = THREE.LinearFilter;
  volumeTexture.needsUpdate = true;
  const volumeTex = texture3D(volumeTexture, null, 0);

  function bakeVolume3D() {
    const p = toolState.volumetricCloud;
    const size = Math.max(8, Math.min(192, Math.round(p.textureSize)));
    const data = new Uint8Array(size * size * size);
    const seededRandom = createSeededRandom(p.seed >>> 0);
    const perlin = new ImprovedNoise(seededRandom);
    let index = 0;
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const nx_norm = x / (size - 1);
          const ny_norm = y / (size - 1);
          const nz_norm = z / (size - 1);
          const base_x = nx_norm * p.noiseScale + p.seed;
          const base_y = ny_norm * p.noiseScale + p.seed;
          const base_z = nz_norm * p.noiseScale + p.seed;
          const scale = p.noiseScale;
          const fbmArgs = [p.octaves, p.persistence, p.lacunarity];
          const n1 = fbm(perlin, base_x, base_y, base_z, ...fbmArgs);
          const n2 = fbm(perlin, base_x - scale, base_y, base_z, ...fbmArgs);
          const n3 = fbm(perlin, base_x, base_y - scale, base_z, ...fbmArgs);
          const n4 = fbm(perlin, base_x, base_y, base_z - scale, ...fbmArgs);
          const n5 = fbm(perlin, base_x - scale, base_y - scale, base_z, ...fbmArgs);
          const n6 = fbm(perlin, base_x - scale, base_y, base_z - scale, ...fbmArgs);
          const n7 = fbm(perlin, base_x, base_y - scale, base_z - scale, ...fbmArgs);
          const n8 = fbm(
            perlin,
            base_x - scale,
            base_y - scale,
            base_z - scale,
            ...fbmArgs,
          );
          const w_x = 1 - nx_norm;
          const w_y = 1 - ny_norm;
          const w_z = 1 - nz_norm;
          let noiseValue =
            n1 * w_x * w_y * w_z +
            n2 * nx_norm * w_y * w_z +
            n3 * w_x * ny_norm * w_z +
            n4 * w_x * w_y * nz_norm +
            n5 * nx_norm * ny_norm * w_z +
            n6 * nx_norm * w_y * nz_norm +
            n7 * w_x * ny_norm * nz_norm +
            n8 * nx_norm * ny_norm * nz_norm;
          noiseValue = (noiseValue + 1.0) / 2.0;
          const finalValue = Math.pow(
            noiseValue,
            p.noiseIntensity,
          );
          const density = smoothstepJS(
            p.cloudCoverage - p.cloudSoftness,
            p.cloudCoverage + p.cloudSoftness,
            finalValue,
          );
          data[index++] = Math.floor(density * 255);
        }
      }
    }
    if (volumeTexture) volumeTexture.dispose();
    volumeTexture = new THREE.Data3DTexture(data, size, size, size);
    volumeTexture.format = THREE.RedFormat;
    volumeTexture.minFilter = THREE.LinearFilter;
    volumeTexture.magFilter = THREE.LinearFilter;
    volumeTexture.unpackAlignment = 1;
    volumeTexture.wrapS = THREE.RepeatWrapping;
    volumeTexture.wrapT = THREE.RepeatWrapping;
    volumeTexture.wrapR = THREE.RepeatWrapping;
    volumeTexture.needsUpdate = true;
    volumeTex.value = volumeTexture;
  }

  bakeVolume3D();

  let maskTexture = buildMaskTexture3D(128, p0.frequenciaRuido, p0.maskSeed);
  let detailMaskTexture = buildMaskTexture3D(
    128,
    p0.frequenciaRuidoDetalhe,
    p0.seedDetalhe,
  );

  const textureLoader = new THREE.TextureLoader();
  const blueNoiseUrl = new URL("../../../assets/HDR_L_0.png", import.meta.url).href;
  let blueNoise2D = null;
  try {
    blueNoise2D = await textureLoader.loadAsync(blueNoiseUrl);
  } catch {
    blueNoise2D = null;
  }
  if (!blueNoise2D) {
    const data = new Uint8Array(128 * 128 * 4);
    let state = 1337 >>> 0;
    const rnd = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) % 256;
    };
    for (let i = 0; i < 128 * 128; i++) {
      const v = rnd();
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    blueNoise2D = new THREE.DataTexture(data, 128, 128, THREE.RGBAFormat);
    blueNoise2D.needsUpdate = true;
  }
  blueNoise2D.wrapS = THREE.RepeatWrapping;
  blueNoise2D.wrapT = THREE.RepeatWrapping;
  blueNoise2D.minFilter = THREE.NearestFilter;
  blueNoise2D.magFilter = THREE.NearestFilter;

  const uTextureTiling = uniform(p0.textureTiling);
  const uTextureOffset = uniform(new THREE.Vector3());
  const uOpacity = uniform(p0.opacity);
  const uMaxSteps = uniform(p0.raymarchSteps);
  const uLightSteps = uniform(p0.lightSteps);
  const uDensityThreshold = uniform(p0.densityThreshold);
  const uDensityMultiplier = uniform(p0.densityMultiplier);
  const uCameraNear = uniform(camera.near);
  const uCameraFar = uniform(camera.far);
  const uFogVolumeEnabled = uniform(0);
  const uFogModeExp2 = uniform(0);
  const uFogNear = uniform(280);
  const uFogFar = uniform(5200);
  const uFogDensity = uniform(0.00022);
  const uFogColorVol = uniform(new THREE.Color(0x9db8d4));
  const uResolution = uniform(new THREE.Vector2(w, h));
  const uBlueNoiseSize = uniform(
    new THREE.Vector2(blueNoise2D.image.width, blueNoise2D.image.height),
  );
  const uSunColor = uniform(sun.color.clone());
  const uSunIntensity = uniform(sun.intensity);
  const uAmbientIntensity = uniform(hemi.intensity);
  const uAmbientColor = uniform(hemi.color.clone());
  const uLightDir = uniform(getSunDir().clone());
  const uOcclusionMode = uniform(0);

  const u_mask_raio = uniform(p0.raio);
  const u_mask_achatamentoCima = uniform(p0.achatamentoCima);
  const u_mask_achatamentoBaixo = uniform(p0.achatamentoBaixo);
  const u_mask_achatamentoXpos = uniform(p0.achatamentoXpos);
  const u_mask_achatamentoXneg = uniform(p0.achatamentoXneg);
  const u_mask_achatamentoZpos = uniform(p0.achatamentoZpos);
  const u_mask_achatamentoZneg = uniform(p0.achatamentoZneg);
  const u_mask_softness = uniform(p0.maskSoftness);
  const u_mask_forcaRuido = uniform(p0.forcaRuido);
  const u_mask_forcaRuidoDetalhe = uniform(p0.forcaRuidoDetalhe);
  const u_mask_visualize = uniform(p0.visualizeMask ? 1 : 0);

  const maskTex = texture3D(maskTexture, null, 0);
  const detailMaskTex = texture3D(detailMaskTexture, null, 0);

  function rebuildMaskTextures() {
    const p = toolState.volumetricCloud;
    if (maskTexture) maskTexture.dispose();
    if (detailMaskTexture) detailMaskTexture.dispose();
    maskTexture = buildMaskTexture3D(128, p.frequenciaRuido, p.maskSeed);
    detailMaskTexture = buildMaskTexture3D(
      128,
      p.frequenciaRuidoDetalhe,
      p.seedDetalhe,
    );
    maskTex.value = maskTexture;
    detailMaskTex.value = detailMaskTexture;
  }

  const hitBox = Fn(({ orig, dir }) => {
    const box_min = vec3(-0.5);
    const box_max = vec3(0.5);
    const inv_dir = vec3(1).div(dir);
    const tmin_tmp = box_min.sub(orig).mul(inv_dir);
    const tmax_tmp = box_max.sub(orig).mul(inv_dir);
    const tmin = min(tmin_tmp, tmax_tmp);
    const tmax = max(tmin_tmp, tmax_tmp);
    const t0 = max(tmin.x, max(tmin.y, tmin.z));
    const t1 = min(tmax.x, min(tmax.y, tmax.z));
    return vec2(t0, t1);
  });

  const EXTINCTION_MULT = vec3(0.6, 0.65, 0.7);
  const DUAL_LOBE_WEIGHT = float(0.8);
  const PHASE_G = float(0.3);

  const HenyeyGreenstein = Fn(([g, mu]) => {
    const gg = g.mul(g);
    const denom = float(1.0).add(gg).sub(g.mul(mu).mul(2.0));
    return float(1.0)
      .sub(gg)
      .div(pow(denom, float(1.5)))
      .mul(float(1.0 / (4.0 * PI_VAL)));
  });

  const PhaseFunction = Fn(([mu]) =>
    HenyeyGreenstein(PHASE_G.negate(), mu)
      .mul(float(1.0).sub(DUAL_LOBE_WEIGHT))
      .add(HenyeyGreenstein(PHASE_G, mu).mul(DUAL_LOBE_WEIGHT)),
  );

  const linearizeDepth = Fn(([d, zNear, zFar]) => {
    const lin = zNear.mul(zFar).div(zFar.add(d.mul(zNear.sub(zFar))));
    return d.greaterThanEqual(float(0.999999)).select(zFar, lin);
  });

  const vOriginVar = varying(
    vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz),
  );
  const vDirectionVar = varying(positionGeometry.sub(vOriginVar));

  const getMaskFactor = Fn(([p]) => {
    const sy = u_mask_achatamentoCima
      .add(u_mask_achatamentoBaixo)
      .mul(0.5)
      .add(
        p.y
          .sign()
          .mul(u_mask_achatamentoCima.sub(u_mask_achatamentoBaixo))
          .mul(0.5),
      )
      .max(0.05);
    const sx = u_mask_achatamentoXpos
      .add(u_mask_achatamentoXneg)
      .mul(0.5)
      .add(
        p.x
          .sign()
          .mul(u_mask_achatamentoXpos.sub(u_mask_achatamentoXneg))
          .mul(0.5),
      )
      .max(0.05);
    const sz = u_mask_achatamentoZpos
      .add(u_mask_achatamentoZneg)
      .mul(0.5)
      .add(
        p.z
          .sign()
          .mul(u_mask_achatamentoZpos.sub(u_mask_achatamentoZneg))
          .mul(0.5),
      )
      .max(0.05);
    const pDistorted = vec3(p.x.div(sx), p.y.div(sy), p.z.div(sz));
    const dist = length(pDistorted);
    const dir = normalize(pDistorted.add(vec3(0.0001)));
    const tex_coord = dir
      .mul(u_mask_raio)
      .mul(0.5)
      .add(0.5)
      .clamp(0.0, 1.0);
    const noisePrincipal = maskTex.sample(tex_coord).r.mul(2.0).sub(1.0);
    const noiseDet = detailMaskTex.sample(tex_coord).r.mul(2.0).sub(1.0);
    const dispP = noisePrincipal.mul(u_mask_forcaRuido);
    const dispD = noiseDet.mul(u_mask_forcaRuidoDetalhe);
    const sdf = u_mask_raio.add(dispP).add(dispD).sub(dist);
    return smoothstep(float(0.0), u_mask_softness, sdf);
  });

  const getDensity = Fn(([p]) => {
    const maskFactor = getMaskFactor(p);
    const texCoord = p
      .add(0.5)
      .mul(uTextureTiling)
      .add(uTextureOffset)
      .fract();
    const noiseDensity = volumeTex.sample(texCoord).r;
    const visualize = u_mask_visualize.greaterThan(0.5);
    const finalDensity = visualize.select(float(1.0), noiseDensity);
    const passThresh = visualize.or(
      noiseDensity.greaterThanEqual(uDensityThreshold),
    );
    const contrib = finalDensity.mul(uDensityMultiplier).mul(maskFactor);
    const inner = passThresh.select(contrib, float(0));
    return maskFactor.greaterThan(0.0).select(inner, float(0));
  });

  const CalculateLightEnergy = Fn(([samplePos, lightDirWorld]) => {
    const stepLength = float(1.0).div(uLightSteps.max(1));
    const lightRayDensity = float(0.0).toVar();
    Loop(MAX_LIGHT_STEPS, ({ i: li }) => {
      If(uLightSteps.lessThanEqual(0), () => Break());
      If(float(li).greaterThanEqual(uLightSteps), () => Break());
      const t = float(li).add(0.5).mul(stepLength);
      const lp = samplePos.add(lightDirWorld.mul(t));
      const inB = lp.x
        .greaterThan(-0.5)
        .and(lp.x.lessThan(0.5))
        .and(lp.y.greaterThan(-0.5))
        .and(lp.y.lessThan(0.5))
        .and(lp.z.greaterThan(-0.5))
        .and(lp.z.lessThan(0.5));
      If(inB, () => {
        lightRayDensity.addAssign(getDensity(lp).mul(stepLength));
      });
    });
    return exp(lightRayDensity.negate());
  });

  const blueNoiseSample = texture(
    blueNoise2D,
    fract(screenUV.mul(uResolution).div(uBlueNoiseSize)),
  );

  const cloudColorNode = Fn(() => {
    const rayDir = normalize(vDirectionVar);
    const bounds = hitBox({ orig: vOriginVar, dir: rayDir }).toVar();
    If(bounds.x.greaterThanEqual(bounds.y), () => Discard());
    bounds.x.assign(max(bounds.x, 0.0));
    const rayLength = bounds.y.sub(bounds.x);
    If(rayLength.lessThan(0.001), () => Discard());

    const stepSize = rayLength.div(uMaxSteps.max(1));
    const jitter = blueNoiseSample.r;
    const sceneDepthSample = depthTexNode.r;
    const sceneLinearDistance = linearizeDepth(
      sceneDepthSample,
      uCameraNear,
      uCameraFar,
    );

    const mu = dot(rayDir, normalize(uLightDir)).toVar();
    const fade_zone = stepSize.mul(2.0);

    const accumulatedColor = vec3(0.0).toVar();
    const transmittance = vec3(1.0, 1.0, 1.0).toVar();
    const lightDirWorld = normalize(uLightDir);

    Loop(MAX_RM_STEPS, ({ i: ii }) => {
      If(float(ii).greaterThanEqual(uMaxSteps), () => Break());

      const dist_traveled = float(ii)
        .mul(stepSize)
        .add(jitter.mul(stepSize));
      const dist_remaining = rayLength.sub(dist_traveled);
      If(dist_remaining.lessThan(0.0), () => Break());

      const travel = bounds.x
        .add(jitter.mul(stepSize))
        .add(float(ii).mul(stepSize));
      const p = vOriginVar.add(rayDir.mul(travel));

      const viewSpacePos = modelViewMatrix.mul(vec4(p, 1.0));
      const rayPointDistance = abs(
        viewSpacePos.z.div(viewSpacePos.w.max(1e-6)),
      );
      If(rayPointDistance.greaterThan(sceneLinearDistance), () => Break());

      const density = getDensity(p).toVar();

      If(density.greaterThan(0.01), () => {
        const lightEnergy = CalculateLightEnergy(p, lightDirWorld);
        const sunLuminance = uSunColor.mul(uSunIntensity).mul(lightEnergy);
        const sunScattering = sunLuminance.mul(PhaseFunction(mu));
        const ambientLuminance = uAmbientColor.mul(uAmbientIntensity);
        const ambientScattering = ambientLuminance;
        const totalScattering = sunScattering
          .add(ambientScattering)
          .mul(density)
          .mul(stepSize);
        const fade_alpha = smoothstep(
          float(0.0),
          fade_zone,
          dist_remaining,
        );
        const scaledScatter = totalScattering.mul(fade_alpha);
        const stepTransmittance = exp(
          density.mul(stepSize).mul(uOpacity).mul(EXTINCTION_MULT).negate(),
        );
        accumulatedColor.addAssign(transmittance.mul(scaledScatter));
        transmittance.mulAssign(stepTransmittance);
        If(length(transmittance).lessThan(0.01), () => Break());
      });
    });

    If(uOcclusionMode.greaterThan(0.5), () => {
      accumulatedColor.assign(vec3(0.0));
    });

    const alpha = float(1.0).sub(transmittance.r);
    const rgbOut = accumulatedColor.toVar();
    If(
      uFogVolumeEnabled.greaterThan(0.5).and(uOcclusionMode.lessThan(0.5)),
      () => {
        const entryLocal = vOriginVar.add(rayDir.mul(bounds.x));
        const entryWorld = modelWorldMatrix.mul(vec4(entryLocal, 1.0)).xyz;
        const fogDist = length(entryWorld.sub(cameraPosition));
        const linearFog = smoothstep(uFogNear, uFogFar, fogDist);
        const expFog = float(1.0).sub(
          exp(
            uFogDensity.mul(uFogDensity).mul(fogDist).mul(fogDist).negate(),
          ),
        );
        const fogMix = uFogModeExp2
          .greaterThan(0.5)
          .select(expFog, linearFog);
        rgbOut.assign(mix(rgbOut, uFogColorVol, fogMix));
      },
    );
    return vec4(rgbOut, alpha);
  });

  const cloudMat = new THREE.MeshBasicNodeMaterial();
  cloudMat.fog = false;
  cloudMat.colorNode = cloudColorNode();
  cloudMat.transparent = true;
  cloudMat.side = THREE.BackSide;
  cloudMat.depthWrite = false;
  cloudMat.depthTest = false;

  const cloudMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cloudMat);
  cloudMesh.scale.setScalar(p0.containerScale);
  cloudMesh.position.set(0, p0.cloudHeightY, 0);
  cloudMesh.layers.set(VOLUME_LAYER);
  cloudMesh.name = "VolumetricCloudVolume";
  scene.add(cloudMesh);

  const occlusionTexForGodRays = texture(occlusionRT.texture);
  const godraysResultTex = texture(godraysRT.texture);
  const godRaysLightUv = uniform(new THREE.Vector2(0.5, 0.5));
  const godRaysSunColor = uniform(new THREE.Color(0xffddaa));
  const godRaysDensity = uniform(p0.godRaysDensity ?? 0.98);
  const godRaysDecay = uniform(p0.godRaysDecay ?? 0.975);
  const godRaysWeight = uniform(p0.godRaysWeight ?? 0.55);
  const godRaysExposure = uniform(p0.godRaysExposureUI ?? 0.58);
  const godRaysSamples = uniform(p0.godRaysSamplesUI ?? 64);

  const godRaysNodeFixed = Fn(() => {
    const vUv = uv();
    const lightPos = vec2(godRaysLightUv.x, godRaysLightUv.y);
    const delta = lightPos.sub(vUv);
    const step = delta.div(godRaysSamples.max(1));
    const colorAcc = vec3(0).toVar();
    const illuminationDecay = float(1.0).toVar();
    Loop(MAX_GOD_SAMPLES, ({ i: gi }) => {
      If(float(gi).greaterThanEqual(godRaysSamples), () => Break());
      const sampleCoord = vUv.add(float(gi).mul(step));
      const sc = texture(occlusionTexForGodRays, sampleCoord);
      colorAcc.addAssign(sc.rgb.mul(illuminationDecay).mul(godRaysWeight));
      illuminationDecay.mulAssign(godRaysDecay);
    });
    return vec4(
      colorAcc
        .mul(godRaysSunColor)
        .mul(godRaysDensity)
        .mul(godRaysExposure),
      1.0,
    );
  });

  const godRaysMat = new THREE.MeshBasicNodeMaterial();
  godRaysMat.colorNode = godRaysNodeFixed();
  godRaysMat.depthTest = false;
  godRaysMat.depthWrite = false;
  godRaysMat.toneMapped = false;

  const finalSceneTex = texture(finalRT.texture);
  const compositeMat = new THREE.MeshBasicNodeMaterial();
  compositeMat.colorNode = texture(godraysResultTex, uv());
  compositeMat.transparent = true;
  compositeMat.blending = THREE.AdditiveBlending;
  compositeMat.depthTest = false;
  compositeMat.depthWrite = false;
  compositeMat.toneMapped = false;

  const screenMat = new THREE.MeshBasicNodeMaterial();
  const blitUV = vec2(uv().x, float(1.0).sub(uv().y));
  screenMat.colorNode = texture(finalSceneTex, blitUV);
  screenMat.depthTest = false;
  screenMat.depthWrite = false;

  const sunMaterial = new THREE.MeshBasicMaterial({
    color: 0xffe8cc,
    transparent: true,
    fog: false,
    toneMapped: false,
    depthWrite: false,
  });
  const sunSphere = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_DISC_GEOM_RADIUS, 32, 32),
    sunMaterial,
  );
  sunSphere.renderOrder = 15;
  sunSphere.layers.set(VOLUME_LAYER);
  sunSphere.name = "VolumetricCloudSunDisc";
  scene.add(sunSphere);

  function updateSunDiscWorld() {
    const pv = toolState.volumetricCloud;
    sunSphere.position.copy(getSunDir()).multiplyScalar(pv.sunMeshDistance ?? 8000);
    sunSphere.scale.setScalar(
      (pv.sunDiscRadius ?? 260) / SUN_DISC_GEOM_RADIUS,
    );
  }

  const _frustum = new THREE.Frustum();
  const _camViewProj = new THREE.Matrix4();
  const _cloudCenterWorld = new THREE.Vector3();

  function resizeAllRenderTargets() {
    const prevW = w;
    const prevH = h;
    layoutEffectBufferSizes();

    const drawingSizeChanged = w !== prevW || h !== prevH;
    if (drawingSizeChanged) {
      depthTarget.setSize(w, h);
      if (depthTarget.depthTexture) depthTarget.depthTexture.dispose();
      depthTarget.depthTexture = new THREE.DepthTexture(w, h);
      depthTarget.depthTexture.format = THREE.DepthFormat;
      depthTarget.depthTexture.type = THREE.UnsignedShortType;
      depthTexNode.value = depthTarget.depthTexture;
      finalRT.setSize(w, h);
      finalSceneTex.value = finalRT.texture;
    }

    occlusionRT.setSize(hw, hh);
    godraysRT.setSize(hw, hh);
    occlusionTexForGodRays.value = occlusionRT.texture;
    godraysResultTex.value = godraysRT.texture;
    uResolution.value.set(w, h);
  }

  function syncUniformsFromToolState() {
    const p = toolState.volumetricCloud;
    const fd = toolState.fog.distance;
    uTextureTiling.value = p.textureTiling;
    uOpacity.value = p.opacity;
    uLightSteps.value = p.lightSteps;
    uDensityThreshold.value = p.densityThreshold;
    uDensityMultiplier.value = p.densityMultiplier;
    uCameraNear.value = camera.near;
    uCameraFar.value = camera.far;
    uLightDir.value.copy(getSunDir());
    uSunColor.value.copy(sun.color);
    uSunIntensity.value = sun.intensity;
    uAmbientColor.value.copy(hemi.color);
    uAmbientIntensity.value = hemi.intensity;
    if (fd.enabled) {
      uFogVolumeEnabled.value = 1;
      uFogModeExp2.value = 1;
      uFogNear.value = 50;
      uFogFar.value = 4000;
      uFogDensity.value = Math.max(1e-6, fd.density);
      uFogColorVol.value.set(fd.color);
    } else {
      uFogVolumeEnabled.value = 0;
    }
    u_mask_raio.value = p.raio;
    u_mask_achatamentoCima.value = p.achatamentoCima;
    u_mask_achatamentoBaixo.value = p.achatamentoBaixo;
    u_mask_achatamentoXpos.value = p.achatamentoXpos;
    u_mask_achatamentoXneg.value = p.achatamentoXneg;
    u_mask_achatamentoZpos.value = p.achatamentoZpos;
    u_mask_achatamentoZneg.value = p.achatamentoZneg;
    u_mask_softness.value = p.maskSoftness;
    u_mask_forcaRuido.value = p.forcaRuido;
    u_mask_forcaRuidoDetalhe.value = p.forcaRuidoDetalhe;
    u_mask_visualize.value = p.visualizeMask ? 1 : 0;
    cloudMesh.scale.setScalar(p.containerScale);
    const pv = toolState.volumetricCloud;
    godRaysDensity.value = pv.godRaysDensity ?? 0.98;
    godRaysDecay.value = pv.godRaysDecay ?? 0.975;
    godRaysWeight.value = pv.godRaysWeight ?? 0.55;
  }

  /**
   * World XZ anchor for optional follow smoothing (e.g. orbit pivot or player — not camera eye).
   * @param {THREE.Vector3} anchorXZ
   * @param {number} dtSec — frame delta for animation & same timing feel as superjet.
   * @returns {boolean} true if this system rendered the frame (skip default render)
   */
  function tryRenderFrame(anchorXZ, dtSec) {
    const p = toolState.volumetricCloud;
    if (!p.enabled) {
      cloudMesh.visible = false;
      sunSphere.visible = false;
      return false;
    }
    sunSphere.visible = true;
    syncUniformsFromToolState();
    updateSunDiscWorld();
    if (p.followCamera) {
      const s = p.cloudFollowSmoothing;
      cloudMesh.position.x += (anchorXZ.x - cloudMesh.position.x) * s;
      cloudMesh.position.z += (anchorXZ.z - cloudMesh.position.z) * s;
    }
    cloudMesh.position.y = p.cloudHeightY;
    cloudMesh.updateMatrixWorld(true);

    cloudMesh.getWorldPosition(_cloudCenterWorld);
    const dist = camera.position.distanceTo(_cloudCenterWorld);
    let lodBlend = 0;
    if (p.lodAuto) {
      lodBlend = THREE.MathUtils.smoothstep(LOD_DIST_NEAR, LOD_DIST_FAR, dist);
    }
    const quality = 1 - lodBlend * 0.72;
    if (p.lodAuto) {
      uMaxSteps.value = Math.max(
        12,
        Math.round(p.raymarchSteps * quality),
      );
      godRaysSamples.value = Math.max(
        10,
        Math.round((p.godRaysSamplesUI ?? 64) * (0.52 + 0.48 * quality)),
      );
    } else {
      uMaxSteps.value = p.raymarchSteps;
      godRaysSamples.value = p.godRaysSamplesUI ?? 64;
    }

    _camViewProj.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    _frustum.setFromProjectionMatrix(
      _camViewProj,
      renderer.coordinateSystem,
      camera.reversedDepth,
    );
    const inFrustum = _frustum.intersectsObject(cloudMesh);
    if (p.lodFrustumCull && !inFrustum) {
      cloudMesh.visible = false;
    } else {
      cloudMesh.visible = true;
    }

    const dimGod =
      p.lodFrustumCull && p.frustumDimGodRays && !inFrustum;
    godRaysExposure.value = dimGod
      ? 0
      : (p.godRaysExposureUI ?? 0.58);

    if (p.isAnimating) {
      const d = Math.min(0.05, Math.max(0, dtSec));
      uTextureOffset.value.x += p.animationSpeedX * d;
      uTextureOffset.value.y += p.animationSpeedY * d;
      uTextureOffset.value.z += p.animationSpeedZ * d;
      uTextureOffset.value.x -= Math.floor(uTextureOffset.value.x);
      uTextureOffset.value.y -= Math.floor(uTextureOffset.value.y);
      uTextureOffset.value.z -= Math.floor(uTextureOffset.value.z);
    }

    /* --- Depth prepass (full-res). Optional selective per-mesh material
       swap on the terrain-chunk meshes only — those are heavy (full PBR /
       splatmap) but don't use vertex displacement, so swapping them is
       safe. Foliage / grass / plane keep their real materials. */
    camera.layers.set(0);
    renderer.setRenderTarget(depthTarget);
    renderer.clear();
    const _depthPrepassSwaps = new Map();
    if (p.useDepthPrepassOverride) {
      for (const o of getOccluderMeshes()) {
        if (o !== cloudMesh && o !== sunSphere && o.material !== undefined) {
          _depthPrepassSwaps.set(o.uuid, o.material);
          if (Array.isArray(o.material)) {
            o.material = o.material.map(() => depthOnlyMat);
          } else {
            o.material = depthOnlyMat;
          }
        }
      }
    }
    renderer.render(scene, camera);
    if (_depthPrepassSwaps.size > 0) {
      for (const o of getOccluderMeshes()) {
        if (_depthPrepassSwaps.has(o.uuid)) {
          o.material = _depthPrepassSwaps.get(o.uuid);
        }
      }
      _depthPrepassSwaps.clear();
    }
    depthTexNode.value = depthTarget.depthTexture;

    const originalMaterials = new Map();
    const bgSaved = scene.background;
    const fogSaved = scene.fog;
    scene.fog = null;
    scene.background = new THREE.Color(0x000000);
    sunSphere.material = occlusionMaterialWhite;
    uOcclusionMode.value = 1;
    for (const o of getOccluderMeshes()) {
      if (o !== cloudMesh && o !== sunSphere && o.material !== undefined) {
        originalMaterials.set(o.uuid, o.material);
        if (Array.isArray(o.material)) {
          const black = o.isLineSegments
            ? occlusionLineBlack
            : occlusionMaterialBlack;
          o.material = o.material.map(() => black);
        } else {
          o.material = o.isLineSegments
            ? occlusionLineBlack
            : occlusionMaterialBlack;
        }
      }
    }

    camera.layers.set(0);
    camera.layers.enable(VOLUME_LAYER);
    renderer.setRenderTarget(occlusionRT);
    renderer.clear();
    renderer.render(scene, camera);

    sunSphere.material = sunMaterial;
    uOcclusionMode.value = 0;
    for (const o of getOccluderMeshes()) {
      if (o !== cloudMesh && o !== sunSphere && originalMaterials.has(o.uuid)) {
        o.material = originalMaterials.get(o.uuid);
      }
    }
    originalMaterials.clear();
    scene.background = bgSaved;
    scene.fog = fogSaved;
    camera.layers.enableAll();

    occlusionTexForGodRays.value = occlusionRT.texture;
    const sunNdc = new THREE.Vector3()
      .copy(sunSphere.position)
      .project(camera);
    godRaysLightUv.value.set(
      sunNdc.x * 0.5 + 0.5,
      1.0 - (sunNdc.y * 0.5 + 0.5),
    );

    postQuad.material = godRaysMat;
    renderer.setRenderTarget(godraysRT);
    renderer.clear();
    renderer.render(postScene, postCam);
    godraysResultTex.value = godraysRT.texture;

    /* `sunSphere` was visible during the occlusion pass (it provided the
       bright source for god-rays). Now hide it from the final beauty pass
       if a sky mesh already draws its own sun — otherwise the cloud's disc
       would visually duplicate it. God-rays still converge on the same
       direction because that's baked into the occlusion mask above. */
    if (!p.showCloudSunDisc) sunSphere.visible = false;

    camera.layers.enableAll();
    renderer.setRenderTarget(finalRT);
    renderer.clear();
    renderer.render(scene, camera);

    finalSceneTex.value = finalRT.texture;
    postQuad.material = compositeMat;
    renderer.autoClear = false;
    renderer.setRenderTarget(finalRT);
    renderer.render(postScene, postCam);
    renderer.autoClear = true;

    postQuad.material = screenMat;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(postScene, postCam);

    return true;
  }

  function dispose() {
    scene.remove(cloudMesh);
    cloudMesh.geometry.dispose();
    cloudMesh.material.dispose();
    scene.remove(sunSphere);
    sunSphere.geometry.dispose();
    sunMaterial.dispose();
    occlusionMaterialBlack.dispose();
    occlusionLineBlack.dispose();
    occlusionMaterialWhite.dispose();
    depthOnlyMat.dispose();
    depthTarget.dispose();
    occlusionRT.dispose();
    godraysRT.dispose();
    finalRT.dispose();
    godRaysMat.dispose();
    compositeMat.dispose();
    screenMat.dispose();
    postQuad.geometry.dispose();
    volumeTexture.dispose();
    maskTexture.dispose();
    detailMaskTexture.dispose();
    depthPlaceholder.dispose();
    if (blueNoise2D?.dispose) blueNoise2D.dispose();
  }

  return {
    cloudMesh,
    tryRenderFrame,
    setDepthTargetSize: resizeAllRenderTargets,
    rebuildVolume: bakeVolume3D,
    rebuildMaskTextures,
    dispose,
  };
}
