/**
 * V2 COPY of the daynight-sky lab's `god-rays-pass.js` (source of truth at repo
 * root). Self-contained; used by `dayNightCloudLayer.js`. Do NOT edit the lab.
 *
 * Screen-space god rays (superjet-style): occlusion RT + radial march.
 * Rays are composited with the scene *before* clouds (see dayNightCloudLayer.js).
 */
import * as THREE from "three/webgpu";
import { float, vec2, vec3, vec4, Fn, Loop, If, Break, uniform, uv, texture } from "three/tsl";

const MAX_GOD_SAMPLES = 96;
/** Must match superjet sun sphere geometry radius. */
const SUN_GEOM_RADIUS = 340;

export const GOD_RAYS_DEFAULTS = {
  enabled: true,
  effectScale: 0.35,
  exposure: 0.58,
  samples: 64,
  density: 0.98,
  decay: 0.975,
  weight: 0.55,
  skipOffscreen: true,
  occCloudSteps: 12,
  sunDistance: 8000,
  sunDiscRadius: 260,
  sunTint: "#ffddaa",
  matchLightColor: false,
};

export function createGodRaysPass() {
  const occlusionRT = new THREE.RenderTarget(4, 4, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });
  const godraysRT = new THREE.RenderTarget(4, 4, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  const occlusionTex = texture(occlusionRT.texture);
  const godraysTex = texture(godraysRT.texture);

  const uLightUv = uniform(new THREE.Vector2(0.5, 0.5));
  const uSunColor = uniform(new THREE.Color(GOD_RAYS_DEFAULTS.sunTint));
  const uDensity = uniform(GOD_RAYS_DEFAULTS.density);
  const uDecay = uniform(GOD_RAYS_DEFAULTS.decay);
  const uWeight = uniform(GOD_RAYS_DEFAULTS.weight);
  const uExposure = uniform(GOD_RAYS_DEFAULTS.exposure);
  const uSamples = uniform(GOD_RAYS_DEFAULTS.samples);

  const godRaysNode = Fn(() => {
    // Match WebGPU post UV (same flip as scene/cloud composite sampling).
    const vUv = vec2(uv().x, uv().y.oneMinus());
    const lightPos = vec2(uLightUv.x, uLightUv.y);
    const delta = lightPos.sub(vUv);
    const step = delta.div(uSamples.max(1));
    const colorAcc = vec3(0).toVar();
    const illuminationDecay = float(1).toVar();
    Loop(MAX_GOD_SAMPLES, ({ i }) => {
      If(float(i).greaterThanEqual(uSamples), () => Break());
      const sampleCoord = vUv.add(float(i).mul(step));
      const sc = occlusionTex.sample(sampleCoord);
      colorAcc.addAssign(sc.rgb.mul(illuminationDecay).mul(uWeight));
      illuminationDecay.mulAssign(uDecay);
    });
    return vec4(colorAcc.mul(uSunColor).mul(uDensity).mul(uExposure), 1);
  });

  const godRaysMat = new THREE.MeshBasicNodeMaterial();
  godRaysMat.colorNode = godRaysNode();
  godRaysMat.depthTest = false;
  godRaysMat.depthWrite = false;
  godRaysMat.toneMapped = false;

  const matBlack = new THREE.MeshBasicMaterial({
    color: 0x000000,
    fog: false,
    toneMapped: false,
  });
  const matWhite = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    fog: false,
    toneMapped: false,
  });

  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_GEOM_RADIUS, 32, 32),
    matWhite.clone(),
  );
  sunMesh.name = "GodRaysSunDisc";
  sunMesh.frustumCulled = false;
  sunMesh.renderOrder = 20;
  sunMesh.visible = false;

  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  postScene.add(postQuad);

  const _sunNdc = new THREE.Vector3();
  const _sunWorld = new THREE.Vector3();
  const _black = new THREE.Color(0x000000);
  const _tintScratch = new THREE.Color();
  let effW = 4;
  let effH = 4;

  function resize(fullW, fullH, effectScale) {
    const s = THREE.MathUtils.clamp(effectScale, 0.2, 1);
    const w = Math.max(2, Math.floor(fullW * s));
    const h = Math.max(2, Math.floor(fullH * s));
    if (w !== effW || h !== effH) {
      effW = w;
      effH = h;
      occlusionRT.setSize(w, h);
      godraysRT.setSize(w, h);
    }
  }

  /** Screen UV of the celestial disc (same space as godRaysNode vUv). */
  function setLightUvFromDirection(camera, dir, sunDistance) {
    camera.updateMatrixWorld();
    _sunWorld.copy(camera.position).addScaledVector(dir, sunDistance);
    _sunWorld.project(camera);
    uLightUv.value.set(
      _sunWorld.x * 0.5 + 0.5,
      1.0 - (_sunWorld.y * 0.5 + 0.5),
    );
  }

  function updateSun(frame, P) {
    const cam = frame.camera;
    const dir = frame.sunDir ?? frame.lightDir;
    sunMesh.position.copy(cam.position).addScaledVector(dir, P.sunDistance);
    sunMesh.scale.setScalar(P.sunDiscRadius / SUN_GEOM_RADIUS);
    if (P.matchLightColor) {
      uSunColor.value.copy(frame.lightColor);
    } else {
      _tintScratch.set(P.sunTint);
      uSunColor.value.copy(_tintScratch);
    }
  }

  function sunOnScreen(camera, dir, sunDistance, margin = 0.3) {
    _sunNdc.copy(camera.position).addScaledVector(dir, sunDistance).project(camera);
    const u = _sunNdc.x * 0.5 + 0.5;
    const v = 1.0 - (_sunNdc.y * 0.5 + 0.5);
    return (
      _sunNdc.z <= 1 &&
      u > -margin &&
      u < 1 + margin &&
      v > -margin &&
      v < 1 + margin
    );
  }

  /** @returns {boolean} whether the god-rays buffer was filled this frame */
  function render(renderer, {
    scene,
    camera,
    cloudMesh,
    cloudOccMaterial,
    cloudLayer,
    skyMesh,
    occluders = [],
    P,
    frame,
    fullWidth,
    fullHeight,
  }) {
    if (!P.enabled) return false;
    resize(fullWidth, fullHeight, P.effectScale);

    const rayDir = frame.sunDir ?? frame.lightDir;
    updateSun(frame, P);
    setLightUvFromDirection(camera, rayDir, P.sunDistance);
    if (P.skipOffscreen && !sunOnScreen(camera, rayDir, P.sunDistance)) return false;

    camera.updateMatrixWorld();
    uExposure.value = P.exposure;
    uSamples.value = Math.min(MAX_GOD_SAMPLES, Math.round(P.samples));
    uDensity.value = P.density;
    uDecay.value = P.decay;
    uWeight.value = P.weight;

    const bgSaved = scene.background;
    const fogSaved = scene.fog;
    const skyVis = skyMesh?.visible ?? true;
    const cloudMatSaved = cloudMesh?.material;
    const sunVis = sunMesh.visible;
    const sunMatSaved = sunMesh.material;
    const savedMats = new Map();

    scene.background = _black;
    scene.fog = null;
    if (skyMesh) skyMesh.visible = false;
    sunMesh.visible = true;
    sunMesh.material = matWhite;

    if (cloudMesh?.visible && cloudOccMaterial) {
      cloudMesh.material = cloudOccMaterial;
    }

    for (const o of occluders) {
      if (o?.material !== undefined) {
        savedMats.set(o.uuid, o.material);
        o.material = matBlack;
      }
    }

    const prevMask = camera.layers.mask;
    if (cloudLayer != null) camera.layers.enable(cloudLayer);

    renderer.setRenderTarget(occlusionRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);

    camera.layers.mask = prevMask;

    if (cloudMesh && cloudMatSaved) cloudMesh.material = cloudMatSaved;
    for (const o of occluders) {
      if (savedMats.has(o.uuid)) o.material = savedMats.get(o.uuid);
    }
    sunMesh.visible = sunVis;
    sunMesh.material = sunMatSaved;
    if (skyMesh) skyMesh.visible = skyVis;
    scene.background = bgSaved;
    scene.fog = fogSaved;

    postQuad.material = godRaysMat;
    renderer.setRenderTarget(godraysRT);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(postScene, postCam);

    return true;
  }

  function dispose() {
    occlusionRT.dispose();
    godraysRT.dispose();
    godRaysMat.dispose();
    matBlack.dispose();
    matWhite.dispose();
    sunMesh.geometry.dispose();
    sunMesh.material.dispose();
    postQuad.geometry.dispose();
  }

  return {
    sunMesh,
    godraysTex,
    render,
    dispose,
  };
}
