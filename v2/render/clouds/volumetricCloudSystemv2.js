/**
 * Optimized volumetric cloud path (fork) — from `cloudsvolumetricagain2.html` ideas:
 * cheap occlusion-only march, cloud rendered to `cloudRT` at `cloudBufferScale`, then composited.
 * Does not modify {@link ./volumetricCloudSystem.js}.
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

/** Sun disc — drawn with terrain in beauty pass, excluded from cloud-only pass. */
const SUN_OPT_LAYER = 11;
/** Full-quality cloud volume — own pass into `cloudRT`. */
const CLOUD_OPT_LAYER = 12;
const PI_VAL = 3.14159265359;
const MAX_RM_STEPS = 120;
const MAX_LIGHT_STEPS = 32;
const MAX_GOD_SAMPLES = 128;
/** Upper bound for occlusion-only ray loop (actual steps from tool state, ≤ this). */
const MAX_OCC_LOOP = 32;
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


/**
 * @param {object} opts
 * @param {THREE.WebGPURenderer} opts.renderer
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {object} opts.toolState — uses `toolState.volumetricCloudOptimized` (not classic `volumetricCloud`).
 * @param {() => THREE.Vector3} opts.getSunDir
 * @param {THREE.DirectionalLight} opts.sun
 * @param {THREE.HemisphereLight} opts.hemi
 * @param {() => THREE.Object3D[]} [opts.getOccluderMeshes] — terrain/solids for occlusion pass (e.g. chunk meshes).
 */
export async function createVolumetricCloudSystemOptimized({
  renderer,
  scene,
  camera,
  toolState,
  getSunDir,
  sun,
  hemi,
  getOccluderMeshes = () => [],
}) {
  const p0 = toolState.volumetricCloudOptimized;
  const _drawingBuf = new THREE.Vector2();
  let w = 1;
  let h = 1;
  let hw = 1;
  let hh = 1;
  let cw = 1;
  let ch = 1;

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
      toolState.volumetricCloudOptimized.effectBufferScale ?? 0.35,
      0.2,
      1,
    );
    hw = Math.max(1, Math.floor(w * es));
    hh = Math.max(1, Math.floor(h * es));
    const cs = THREE.MathUtils.clamp(
      toolState.volumetricCloudOptimized.cloudBufferScale ?? 0.5,
      0.25,
      1,
    );
    cw = Math.max(1, Math.floor(w * cs));
    ch = Math.max(1, Math.floor(h * cs));
  }
  layoutEffectBufferSizes();

  const depthTarget = new THREE.RenderTarget(w, h);
  depthTarget.depthTexture = new THREE.DepthTexture(w, h);
  depthTarget.depthTexture.format = THREE.DepthFormat;
  depthTarget.depthTexture.type = THREE.FloatType;

  const occlusionRT = new THREE.RenderTarget(hw, hh, effectRTDefaults);
  const godraysRT = new THREE.RenderTarget(hw, hh, effectRTDefaults);
  const finalRT = new THREE.RenderTarget(w, h, finalRTDefaults);
  const cloudRT = new THREE.RenderTarget(cw, ch, finalRTDefaults);
  const historyRT_A = new THREE.RenderTarget(cw, ch, finalRTDefaults);
  const historyRT_B = new THREE.RenderTarget(cw, ch, finalRTDefaults);
  let pingPongIndex = 0;
  let temporalFrameCount = 0;

  const prevVPMatrix = new THREE.Matrix4();
  const prevCloudWorldMatrix = new THREE.Matrix4();
  const _reprojectMatrix = new THREE.Matrix4();
  const _invCurrentVP = new THREE.Matrix4();
  const _invCurrCloudWorld = new THREE.Matrix4();
  const _currentVP = new THREE.Matrix4();

  const occBgBlack = new THREE.Color(0x000000);

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

  let maskVolumeTexture = new THREE.Data3DTexture(new Uint8Array(8), 2, 2, 2);
  maskVolumeTexture.format = THREE.RedFormat;
  maskVolumeTexture.minFilter = THREE.LinearFilter;
  maskVolumeTexture.magFilter = THREE.LinearFilter;
  maskVolumeTexture.needsUpdate = true;
  const maskVolumeTex = texture3D(maskVolumeTexture, null, 0);

  function bakeVolume3D() {
    const p = toolState.volumetricCloudOptimized;
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

  function bakeMaskVolume3D() {
    const p = toolState.volumetricCloudOptimized;
    const size = Math.max(8, Math.min(192, Math.round(p.textureSize)));
    const data = new Uint8Array(size * size * size);

    function makeNoiseGen(seed) {
      const rnd = createSeededRandom(seed);
      const perm = new Uint8Array(256);
      for (let i = 0; i < 256; i++) perm[i] = i;
      for (let i = 255; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      const pt = new Uint8Array(512);
      for (let i = 0; i < 256; i++) pt[i] = pt[i + 256] = perm[i];
      return createNoiseGeneratorFromPermutation(pt);
    }

    const mainNoise = makeNoiseGen(p.maskSeed);
    const detailNoise = makeNoiseGen(p.seedDetalhe);
    const _v = new THREE.Vector3();

    let index = 0;
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const px = x / (size - 1) - 0.5;
          const py = y / (size - 1) - 0.5;
          const pz = z / (size - 1) - 0.5;

          const sy = Math.max(0.05,
            (p.achatamentoCima + p.achatamentoBaixo) * 0.5 +
            Math.sign(py) * (p.achatamentoCima - p.achatamentoBaixo) * 0.5);
          const sx = Math.max(0.05,
            (p.achatamentoXpos + p.achatamentoXneg) * 0.5 +
            Math.sign(px) * (p.achatamentoXpos - p.achatamentoXneg) * 0.5);
          const sz = Math.max(0.05,
            (p.achatamentoZpos + p.achatamentoZneg) * 0.5 +
            Math.sign(pz) * (p.achatamentoZpos - p.achatamentoZneg) * 0.5);

          const dx = px / sx;
          const dy = py / sy;
          const dz = pz / sz;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

          const ex = dx + 0.0001;
          const ey = dy + 0.0001;
          const ez = dz + 0.0001;
          const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
          const dirX = ex / len;
          const dirY = ey / len;
          const dirZ = ez / len;

          const nP = mainNoise(_v.set(
            dirX * p.frequenciaRuido,
            dirY * p.frequenciaRuido,
            dirZ * p.frequenciaRuido,
          ));
          const nD = detailNoise(_v.set(
            dirX * p.frequenciaRuidoDetalhe,
            dirY * p.frequenciaRuidoDetalhe,
            dirZ * p.frequenciaRuidoDetalhe,
          ));

          const sdf = p.raio + nP * p.forcaRuido + nD * p.forcaRuidoDetalhe - dist;
          data[index++] = Math.floor(smoothstepJS(0, p.maskSoftness, sdf) * 255);
        }
      }
    }

    if (maskVolumeTexture) maskVolumeTexture.dispose();
    maskVolumeTexture = new THREE.Data3DTexture(data, size, size, size);
    maskVolumeTexture.format = THREE.RedFormat;
    maskVolumeTexture.minFilter = THREE.LinearFilter;
    maskVolumeTexture.magFilter = THREE.LinearFilter;
    maskVolumeTexture.unpackAlignment = 1;
    maskVolumeTexture.needsUpdate = true;
    maskVolumeTex.value = maskVolumeTexture;
  }

  bakeMaskVolume3D();

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
  const uReversedDepth = uniform(camera.reversedDepth ? 1 : 0);
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
  const uOccMaxSteps = uniform(
    Math.max(4, Math.min(MAX_OCC_LOOP, Math.round(p0.occlusionRaymarchSteps ?? 12))),
  );
  const uTemporalBlendFactor = uniform(p0.temporalBlendFactor ?? 0.92);
  const uTemporalFrame = uniform(0);
  const uReprojectMatrix = uniform(new THREE.Matrix4());
  const uCloudResolution = uniform(new THREE.Vector2(cw, ch));

  const u_mask_visualize = uniform(p0.visualizeMask ? 1 : 0);

  function rebuildMaskTextures() {
    bakeMaskVolume3D();
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
    const df = uReversedDepth.greaterThan(0.5).select(float(1.0).sub(d), d);
    const lin = zNear.mul(zFar).div(zFar.add(df.mul(zNear.sub(zFar))));
    return df.greaterThanEqual(float(0.999999)).select(zFar, lin);
  });

  const vOriginVar = varying(
    vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz),
  );
  const vDirectionVar = varying(positionGeometry.sub(vOriginVar));

  const getDensity = Fn(([p]) => {
    const maskFactor = maskVolumeTex.sample(p.add(0.5)).r;
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
      If(inB.not(), () => Break());
      lightRayDensity.addAssign(getDensity(lp).mul(stepLength));
    });
    return exp(lightRayDensity.negate());
  });

  const goldenRatio = float(0.61803398875);
  const blueNoiseSample = texture(
    blueNoise2D,
    fract(screenUV.mul(uResolution).div(uBlueNoiseSize).add(goldenRatio.mul(uTemporalFrame))),
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

    const alpha = float(1.0).sub(transmittance.r);
    const rgbOut = accumulatedColor.toVar();
    If(
      uFogVolumeEnabled.greaterThan(0.5),
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

  const cloudOccColorNode = Fn(() => {
    const rayDir = normalize(vDirectionVar);
    const bounds = hitBox({ orig: vOriginVar, dir: rayDir }).toVar();
    If(bounds.x.greaterThanEqual(bounds.y), () => Discard());
    bounds.x.assign(max(bounds.x, 0.0));
    const rayLength = bounds.y.sub(bounds.x);
    If(rayLength.lessThan(0.001), () => Discard());
    const stepSize = rayLength.div(uOccMaxSteps.max(1));
    const jitter = blueNoiseSample.r;
    const transmittance = float(1.0).toVar();
    Loop(MAX_OCC_LOOP, ({ i: ii }) => {
      If(float(ii).greaterThanEqual(uOccMaxSteps), () => Break());
      const travel = bounds.x
        .add(jitter.mul(stepSize))
        .add(float(ii).mul(stepSize));
      const p = vOriginVar.add(rayDir.mul(travel));
      const density = getDensity(p);
      If(density.greaterThan(0.01), () => {
        transmittance.mulAssign(
          exp(density.mul(stepSize).mul(uOpacity).negate()),
        );
        If(transmittance.lessThan(0.01), () => Break());
      });
    });
    return vec4(vec3(0.0), float(1.0).sub(transmittance));
  });

  const cloudOccMat = new THREE.MeshBasicNodeMaterial();
  cloudOccMat.fog = false;
  cloudOccMat.colorNode = cloudOccColorNode();
  cloudOccMat.transparent = true;
  cloudOccMat.side = THREE.BackSide;
  cloudOccMat.depthWrite = false;
  cloudOccMat.depthTest = false;

  const cloudMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cloudMat);
  cloudMesh.scale.setScalar(p0.containerScale);
  cloudMesh.position.set(0, p0.cloudHeightY, 0);
  cloudMesh.layers.set(CLOUD_OPT_LAYER);
  cloudMesh.name = "VolumetricCloudVolumeOptimized";
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

  const cloudTexForComposite = texture(cloudRT.texture);
  const cloudBlitUV = vec2(uv().x, float(1.0).sub(uv().y));
  const cloudCompositeMat = new THREE.MeshBasicNodeMaterial();
  cloudCompositeMat.colorNode = texture(cloudTexForComposite, cloudBlitUV);
  cloudCompositeMat.transparent = true;
  cloudCompositeMat.blending = THREE.CustomBlending;
  cloudCompositeMat.blendSrc = THREE.OneFactor;
  cloudCompositeMat.blendDst = THREE.OneMinusSrcAlphaFactor;
  cloudCompositeMat.depthTest = false;
  cloudCompositeMat.depthWrite = false;
  cloudCompositeMat.toneMapped = false;

  const currentCloudTexRef = texture(cloudRT.texture);
  const historyCloudTexRef = texture(historyRT_A.texture);

  const temporalResolveNode = Fn(() => {
    const rawUV = uv();
    const flippedUV = vec2(rawUV.x, float(1.0).sub(rawUV.y));
    const currentColor = texture(currentCloudTexRef, flippedUV).toVar();

    const ndcXY = flippedUV.mul(2.0).sub(1.0);
    const clipPos = vec4(ndcXY.x, ndcXY.y, float(0.0), float(1.0));
    const prevClip = uReprojectMatrix.mul(clipPos);
    const prevNDC = prevClip.xy.div(prevClip.w);
    const prevScreenUV = prevNDC.mul(0.5).add(0.5);

    const inBounds = prevScreenUV.x.greaterThanEqual(0.0)
      .and(prevScreenUV.x.lessThanEqual(1.0))
      .and(prevScreenUV.y.greaterThanEqual(0.0))
      .and(prevScreenUV.y.lessThanEqual(1.0));

    const velocity = length(prevScreenUV.sub(flippedUV));
    const velocityReject = smoothstep(float(0.2), float(0.4), velocity);

    const prevHistUV = vec2(prevScreenUV.x, float(1.0).sub(prevScreenUV.y));
    const historyColor = texture(historyCloudTexRef, prevHistUV);

    const texel = vec2(1.0).div(uCloudResolution);
    const s00 = texture(currentCloudTexRef, flippedUV.add(vec2(-1, -1).mul(texel)));
    const s10 = texture(currentCloudTexRef, flippedUV.add(vec2(0, -1).mul(texel)));
    const s20 = texture(currentCloudTexRef, flippedUV.add(vec2(1, -1).mul(texel)));
    const s01 = texture(currentCloudTexRef, flippedUV.add(vec2(-1, 0).mul(texel)));
    const s11 = currentColor;
    const s21 = texture(currentCloudTexRef, flippedUV.add(vec2(1, 0).mul(texel)));
    const s02 = texture(currentCloudTexRef, flippedUV.add(vec2(-1, 1).mul(texel)));
    const s12 = texture(currentCloudTexRef, flippedUV.add(vec2(0, 1).mul(texel)));
    const s22 = texture(currentCloudTexRef, flippedUV.add(vec2(1, 1).mul(texel)));

    const nMin = min(s00, min(s10, min(s20, min(s01, min(s11, min(s21, min(s02, min(s12, s22))))))));
    const nMax = max(s00, max(s10, max(s20, max(s01, max(s11, max(s21, max(s02, max(s12, s22))))))));

    const clampedHist = historyColor.clamp(nMin, nMax);

    const blendFactor = uTemporalBlendFactor
      .mul(inBounds.select(float(1.0), float(0.0)))
      .mul(float(1.0).sub(velocityReject));

    return mix(currentColor, clampedHist, blendFactor);
  });

  const temporalResolveMat = new THREE.MeshBasicNodeMaterial();
  temporalResolveMat.colorNode = temporalResolveNode();
  temporalResolveMat.blending = THREE.NoBlending;
  temporalResolveMat.depthTest = false;
  temporalResolveMat.depthWrite = false;
  temporalResolveMat.toneMapped = false;

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
  sunSphere.layers.set(SUN_OPT_LAYER);
  sunSphere.name = "VolumetricCloudSunDiscOptimized";
  scene.add(sunSphere);

  function updateSunDiscWorld() {
    const pv = toolState.volumetricCloudOptimized;
    sunSphere.position.copy(getSunDir()).multiplyScalar(pv.sunMeshDistance ?? 8000);
    sunSphere.scale.setScalar(
      (pv.sunDiscRadius ?? 260) / SUN_DISC_GEOM_RADIUS,
    );
  }

  const _frustum = new THREE.Frustum();
  const _camViewProj = new THREE.Matrix4();
  const _cloudCenterWorld = new THREE.Vector3();
  const _sunNdc = new THREE.Vector3();
  const _originalMaterials = new Map();

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
      depthTarget.depthTexture.type = THREE.FloatType;
      depthTexNode.value = depthTarget.depthTexture;
      finalRT.setSize(w, h);
      finalSceneTex.value = finalRT.texture;
    }

    occlusionRT.setSize(hw, hh);
    godraysRT.setSize(hw, hh);
    occlusionTexForGodRays.value = occlusionRT.texture;
    godraysResultTex.value = godraysRT.texture;
    cloudRT.setSize(cw, ch);
    historyRT_A.setSize(cw, ch);
    historyRT_B.setSize(cw, ch);
    cloudTexForComposite.value = cloudRT.texture;
    uResolution.value.set(w, h);
    uCloudResolution.value.set(cw, ch);
    temporalFrameCount = 0;
  }

  function syncUniformsFromToolState() {
    const p = toolState.volumetricCloudOptimized;
    const fd = toolState.fog.distance;
    uTextureTiling.value = p.textureTiling;
    uOpacity.value = p.opacity;
    uLightSteps.value = p.lightSteps;
    uDensityThreshold.value = p.densityThreshold;
    uDensityMultiplier.value = p.densityMultiplier;
    uCameraNear.value = camera.near;
    uCameraFar.value = camera.far;
    uReversedDepth.value = camera.reversedDepth ? 1 : 0;
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
    u_mask_visualize.value = p.visualizeMask ? 1 : 0;
    cloudMesh.scale.setScalar(p.containerScale);
    const pv = toolState.volumetricCloudOptimized;
    uOccMaxSteps.value = Math.max(
      4,
      Math.min(MAX_OCC_LOOP, Math.round(pv.occlusionRaymarchSteps ?? 12)),
    );
    godRaysDensity.value = pv.godRaysDensity ?? 0.98;
    godRaysDecay.value = pv.godRaysDecay ?? 0.975;
    godRaysWeight.value = pv.godRaysWeight ?? 0.55;
    uTemporalBlendFactor.value = pv.temporalBlendFactor ?? 0.92;
  }

  /**
   * World XZ anchor for optional follow smoothing (e.g. orbit pivot or player — not camera eye).
   * @param {THREE.Vector3} anchorXZ
   * @param {number} dtSec — frame delta for animation & same timing feel as superjet.
   * @returns {boolean} true if this system rendered the frame (skip default render)
   */
  function tryRenderFrame(anchorXZ, dtSec) {
    const p = toolState.volumetricCloudOptimized;
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
      uLightSteps.value = Math.max(
        1,
        Math.round(p.lightSteps * quality),
      );
      godRaysSamples.value = Math.max(
        10,
        Math.round((p.godRaysSamplesUI ?? 64) * (0.52 + 0.48 * quality)),
      );
    } else {
      uMaxSteps.value = p.raymarchSteps;
      uLightSteps.value = p.lightSteps;
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

    _originalMaterials.clear();
    const bgSaved = scene.background;
    const fogSaved = scene.fog;
    scene.fog = null;
    scene.background = occBgBlack;
    sunSphere.material = occlusionMaterialWhite;
    cloudMesh.material = cloudOccMat;
    for (const o of getOccluderMeshes()) {
      if (o !== cloudMesh && o !== sunSphere && o.material !== undefined) {
        _originalMaterials.set(o.uuid, o.material);
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
    camera.layers.enable(SUN_OPT_LAYER);
    camera.layers.enable(CLOUD_OPT_LAYER);
    renderer.setRenderTarget(occlusionRT);
    renderer.clear();
    renderer.render(scene, camera);

    sunSphere.material = sunMaterial;
    cloudMesh.material = cloudMat;
    for (const o of getOccluderMeshes()) {
      if (o !== cloudMesh && o !== sunSphere && _originalMaterials.has(o.uuid)) {
        o.material = _originalMaterials.get(o.uuid);
      }
    }
    _originalMaterials.clear();
    scene.background = bgSaved;
    scene.fog = fogSaved;
    camera.layers.enableAll();

    occlusionTexForGodRays.value = occlusionRT.texture;
    _sunNdc.copy(sunSphere.position).project(camera);
    godRaysLightUv.value.set(
      _sunNdc.x * 0.5 + 0.5,
      1.0 - (_sunNdc.y * 0.5 + 0.5),
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

    camera.layers.set(0);
    camera.layers.enable(SUN_OPT_LAYER);
    renderer.setRenderTarget(finalRT);
    renderer.clear();
    renderer.render(scene, camera);

    uResolution.value.set(cw, ch);
    camera.layers.set(CLOUD_OPT_LAYER);
    const savedClearAlpha = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    const savedBg2 = scene.background;
    scene.background = null;
    renderer.setRenderTarget(cloudRT);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setClearAlpha(savedClearAlpha);
    scene.background = savedBg2;
    uResolution.value.set(w, h);

    _currentVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

    if (p.temporalEnabled) {
      uTemporalFrame.value = temporalFrameCount % 16;
      const writeRT = pingPongIndex === 0 ? historyRT_A : historyRT_B;
      const readRT = pingPongIndex === 0 ? historyRT_B : historyRT_A;

      currentCloudTexRef.value = cloudRT.texture;
      historyCloudTexRef.value = readRT.texture;

      if (temporalFrameCount > 0) {
        _invCurrentVP.copy(_currentVP).invert();
        _invCurrCloudWorld.copy(cloudMesh.matrixWorld).invert();
        _reprojectMatrix.copy(prevVPMatrix)
          .multiply(prevCloudWorldMatrix)
          .multiply(_invCurrCloudWorld)
          .multiply(_invCurrentVP);
        uReprojectMatrix.value.copy(_reprojectMatrix);
      }

      const savedBlend = uTemporalBlendFactor.value;
      if (temporalFrameCount === 0) uTemporalBlendFactor.value = 0;

      postQuad.material = temporalResolveMat;
      renderer.setRenderTarget(writeRT);
      renderer.clear();
      renderer.render(postScene, postCam);

      if (temporalFrameCount === 0) uTemporalBlendFactor.value = savedBlend;

      cloudTexForComposite.value = writeRT.texture;
      prevVPMatrix.copy(_currentVP);
      prevCloudWorldMatrix.copy(cloudMesh.matrixWorld);
      pingPongIndex = 1 - pingPongIndex;
      temporalFrameCount++;
    } else {
      cloudTexForComposite.value = cloudRT.texture;
      temporalFrameCount = 0;
      uTemporalFrame.value = 0;
    }

    postQuad.material = cloudCompositeMat;
    renderer.autoClear = false;
    renderer.setRenderTarget(finalRT);
    renderer.render(postScene, postCam);

    finalSceneTex.value = finalRT.texture;
    postQuad.material = compositeMat;
    renderer.setRenderTarget(finalRT);
    renderer.render(postScene, postCam);
    renderer.autoClear = true;

    postQuad.material = screenMat;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(postScene, postCam);

    // Restore camera layers — otherwise disabling the cloud leaves the camera
    // restricted to CLOUD_OPT_LAYER and the next direct scene render is black.
    camera.layers.enableAll();

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
    cloudOccMat.dispose();
    cloudCompositeMat.dispose();
    postQuad.geometry.dispose();
    volumeTexture.dispose();
    maskVolumeTexture.dispose();
    depthPlaceholder.dispose();
    cloudRT.dispose();
    historyRT_A.dispose();
    historyRT_B.dispose();
    temporalResolveMat.dispose();
    if (blueNoise2D?.dispose) blueNoise2D.dispose();
  }

  function resetTemporalHistory() {
    temporalFrameCount = 0;
    pingPongIndex = 0;
  }

  return {
    cloudMesh,
    sunSphere,
    tryRenderFrame,
    setDepthTargetSize: resizeAllRenderTargets,
    rebuildVolume: bakeVolume3D,
    rebuildMaskTextures,
    resetTemporalHistory,
    dispose,
  };
}
