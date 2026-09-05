/**
 * V2 world rendering stack for V3: sun/CSM, fog, sky modes, interior lighting,
 * lens flare, post-FX, world ocean, procedural-sky day/night cloud deck.
 * Volumetric cloud systems (classic / optimized / V3 flight) are intentionally omitted.
 */
import * as THREE from "three";
import {
  uniform,
  float,
  positionWorld,
  cameraPosition,
  normalize,
  dot,
  pow,
  mix,
  clamp,
  fog,
  length,
  select,
  triNoise3D,
  densityFogFactor,
} from "three/tsl";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { createLensFlareSystem } from "../../v2/effects/lensFlare.js";
import { PostFxPipeline } from "../../v2/render/post/postFxPipeline.js";
import { createDayNightSky } from "../render/sky/dayNightSky.js";
import { createDayNightCloudLayer } from "../render/clouds/dayNightCloudLayer.js";
import { createWorldOcean } from "../render/water/worldOcean.js";
import { InteriorVolumeRegistry } from "../../v2/render/lighting/interiorVolumeRegistry.js";
import { createInteriorLightingNodes } from "../../v2/render/lighting/interiorLightingTsl.js";

const PROC_ENV_IDLE = 3.0;
const STREAM_QUEUE_PRESSURE = 12;

export async function createWorldEnvironment({
  scene,
  renderer,
  camera,
  controls,
  playMode,
  toolState,
  heightTexNode,
  terrainSize,
  getSplineSystem = () => null,
  getTerrainMeshes = () => [],
}) {
  const sunDir = new THREE.Vector3();
  const _effectiveLightDir = new THREE.Vector3();
  const _shadowFocus = new THREE.Vector3();
  const _shadowCamDist = new THREE.Vector3();
  const _moonDir = new THREE.Vector3();
  // Realistic sky moon (own ecliptic track) + its sun-lit direction. Kept
  // separate from _moonDir (the antipode used for cloud night-lighting) so the
  // sky upgrade doesn't change cloud behavior.
  const _skyMoonDir = new THREE.Vector3();
  const _moonLightDir = new THREE.Vector3();
  const _procSkyFogColor = new THREE.Color();
  const _todSunDir = new THREE.Vector3();
  const _cloudLightColor = new THREE.Color();
  const _cloudAmbColor = new THREE.Color();
  const _cloudAmbNight = new THREE.Color();
  const _fogAwayColor = new THREE.Color();
  const _fogAwayNight = new THREE.Color();
  const _interiorFocusPos = new THREE.Vector3();

  let _appTimeSec = 0;
  let _lastLightSnap = "";
  let _lastProcSkySnap = "";
  let _lastInteriorSnap = "";
  let _oceanEnvRef = null;

  // Scratch colours for driving ocean sky reflection each frame.
  const _oceanZenith  = new THREE.Color();
  const _oceanHorizon = new THREE.Color();
  const _tmpOceanC    = new THREE.Color();

  function sunDirectionFromAngles(azDeg, elDeg, target = new THREE.Vector3()) {
    const az = THREE.MathUtils.degToRad(azDeg);
    const el = THREE.MathUtils.degToRad(elDeg);
    return target
      .set(
        Math.cos(el) * Math.cos(az),
        Math.sin(el),
        Math.cos(el) * Math.sin(az),
      )
      .normalize();
  }

  // Hour angle H + declination → world direction, in the same frame as
  // sunDirectionFromAngles (X=east, Y=up, Z=south → azimuth = atan2(z,x)).
  function equatorialToDir(H, decl, lat, out) {
    const sinD = Math.sin(decl), cosD = Math.cos(decl);
    const sinL = Math.sin(lat), cosL = Math.cos(lat);
    const cosH = Math.cos(H), sinH = Math.sin(H);
    return out
      .set(
        -cosD * sinH,
        sinL * sinD + cosL * cosD * cosH,
        cosD * sinL * cosH - sinD * cosL,
      )
      .normalize();
  }

  // Realistic moon direction: rides the ecliptic, shares the sun-implied
  // sidereal time, and trails the sun by its synodic age (0=new .5=full 1=new).
  // Cheap → recomputed every frame so it tracks latitude/day/age live.
  function computeMoonDir(out) {
    const ps = toolState.proceduralSky;
    const DEG = Math.PI / 180, OB = 23.44 * DEG;
    const lat = (ps.latitude ?? 45) * DEG;
    const lamSun = ((360 * ((ps.dayOfYear ?? 172) - 80)) / 365.25) * DEG;
    const raSun = Math.atan2(Math.cos(OB) * Math.sin(lamSun), Math.cos(lamSun));
    const Hsun = ((ps.timeOfDay ?? 12) - 12) * 15 * DEG;
    const lamMoon = lamSun + (ps.moonAge ?? 0.55) * 2 * Math.PI;
    const declMoon = Math.asin(Math.sin(OB) * Math.sin(lamMoon));
    const raMoon = Math.atan2(Math.cos(OB) * Math.sin(lamMoon), Math.cos(lamMoon));
    return equatorialToDir(Hsun + raSun - raMoon, declMoon, lat, out);
  }

  function fitDirectionalShadowToView(cam, focus, maxFar, lightMargin) {
    const shadowCam = sun.shadow.camera;
    _shadowCamDist.subVectors(cam.position, focus);
    const dist = _shadowCamDist.length();
    const half = THREE.MathUtils.clamp(
      Math.max(12, Math.min(maxFar * 0.4, dist * 0.55)),
      12,
      maxFar,
    );
    shadowCam.left = -half;
    shadowCam.right = half;
    shadowCam.top = half;
    shadowCam.bottom = -half;
    shadowCam.near = 0.5;
    shadowCam.far = half * 2 + lightMargin + 50;
    shadowCam.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
  }

  const L = toolState.light;
  const hemi = new THREE.HemisphereLight(
    L.hemiSkyColor,
    L.hemiGroundColor,
    L.hemiIntensity,
  );
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(L.dirColor, L.dirIntensity);
  sun.castShadow = true;
  const shadowTarget = new THREE.Object3D();
  scene.add(shadowTarget);
  sun.target = shadowTarget;
  sun.shadow.mapSize.set(toolState.csm.mapSize, toolState.csm.mapSize);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 400;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -80;
  sun.shadow.camera.right = sun.shadow.camera.top = 80;
  sun.shadow.bias = L.shadowBias;
  sun.shadow.normalBias = L.shadowNormalBias;
  sun.shadow.radius = toolState.csm.shadowRadius;
  scene.add(sun);

  let csm = null;
  let _lastCsmCascades = toolState.csm.cascades;
  let _lastCsmMaxFar = toolState.csm.maxFar;
  let _lastCsmMargin = toolState.csm.lightMargin;
  let _lastCsmMapSize = toolState.csm.mapSize;
  let _lastCsmFade = toolState.csm.fade;
  let _lastCsmRadius = toolState.csm.shadowRadius ?? 4;
  let _lastCsmEnabled = toolState.csm.enabled;
  let _csmPipelineVersion = 0;

  function invalidateSunShadowPipeline() {
    _csmPipelineVersion++;
    const ver = _csmPipelineVersion;
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m?.isNodeMaterial) continue;
        if (!m._csmOrigCPCK) m._csmOrigCPCK = m.customProgramCacheKey.bind(m);
        const orig = m._csmOrigCPCK;
        m.customProgramCacheKey = () => orig() + `|csm${ver}`;
        m.needsUpdate = true;
      }
    });
  }

  function setCsmCascadeLightsInScene(active) {
    if (!csm) return;
    const parent = sun.parent;
    for (let i = 0; i < csm.lights.length; i++) {
      const lw = csm.lights[i];
      if (active) {
        if (lw.parent === null) {
          parent.add(lw.target);
          parent.add(lw);
        }
      } else if (lw.parent) {
        lw.parent.remove(lw.target);
        lw.parent.remove(lw);
      }
    }
  }

  function syncCascadeShadowSettings() {
    if (!csm) return;
    const mapSize = Math.round(Number(toolState.csm.mapSize));
    const shadowRadius = Number(toolState.csm.shadowRadius ?? 4);
    const normalBias = sun.shadow.normalBias;
    const baseBias = sun.shadow.bias;
    const cascadeCamFar = Number(toolState.csm.lightMargin) + 500;
    sun.shadow.mapSize.set(mapSize, mapSize);
    sun.shadow.radius = shadowRadius;
    sun.shadow.needsUpdate = true;
    for (let i = 0; i < csm.lights.length; i++) {
      const sh = csm.lights[i].shadow;
      sh.mapSize.set(mapSize, mapSize);
      sh.radius = shadowRadius;
      sh.normalBias = normalBias * Math.sqrt(i + 1);
      sh.bias = baseBias * (i + 1);
      if (sh.camera) {
        sh.camera.far = cascadeCamFar;
        sh.camera.updateProjectionMatrix();
      }
      sh.needsUpdate = true;
    }
  }

  function csmCfgNum(cfg) {
    return {
      cascades: Math.round(Number(cfg.cascades)),
      fade: !!cfg.fade,
      mapSize: Math.round(Number(cfg.mapSize)),
      maxFar: Number(cfg.maxFar),
      lightMargin: Number(cfg.lightMargin),
      shadowRadius: Number(cfg.shadowRadius ?? 4),
      enabled: !!cfg.enabled,
    };
  }

  function recreateCsm() {
    if (!renderer.shadowMap) return;
    if (csm) {
      sun.shadow.shadowNode = null;
      csm.dispose();
      csm = null;
    }
    try {
      csm = new CSMShadowNode(sun, {
        cascades: toolState.csm.cascades,
        maxFar: toolState.csm.maxFar,
        mode: "practical",
        lightMargin: toolState.csm.lightMargin,
      });
      csm.fade = !!toolState.csm.fade;
      syncCascadeShadowSettings();
      if (toolState.csm.enabled) sun.shadow.shadowNode = csm;
    } catch (err) {
      console.warn(
        "[V3] CSMShadowNode recreate failed; using non-CSM directional shadow.",
        err,
      );
      csm = null;
    }
  }

  function syncCsmFromToolState() {
    const cfg = csmCfgNum(toolState.csm);
    const focus = playMode?.active ? playMode.playerPosition : controls.target;
    _shadowFocus.copy(focus);
    shadowTarget.position.set(_shadowFocus.x, 0, _shadowFocus.z);
    // The target just moved, so the sun has to move with it — otherwise the light
    // DIRECTION changes as the camera pans (see placeSun).
    placeSun();

    if (!csm) {
      if (!cfg.enabled) {
        fitDirectionalShadowToView(camera, _shadowFocus, cfg.maxFar, cfg.lightMargin);
      }
      return;
    }

    sun.castShadow = true;
    const prevEnabled = _lastCsmEnabled;
    sun.shadow.shadowNode = cfg.enabled ? csm : null;

    if (cfg.enabled !== prevEnabled) {
      _lastCsmEnabled = cfg.enabled;
      setCsmCascadeLightsInScene(cfg.enabled);
      invalidateSunShadowPipeline();
    }

    if (!cfg.enabled) {
      fitDirectionalShadowToView(camera, _shadowFocus, cfg.maxFar, cfg.lightMargin);
      syncCascadeShadowSettings();
      return;
    }

    const recreateNeeded =
      cfg.cascades !== _lastCsmCascades || cfg.fade !== _lastCsmFade;

    if (recreateNeeded) {
      _lastCsmCascades = cfg.cascades;
      _lastCsmFade = cfg.fade;
      _lastCsmMapSize = cfg.mapSize;
      _lastCsmMaxFar = cfg.maxFar;
      _lastCsmMargin = cfg.lightMargin;
      _lastCsmRadius = cfg.shadowRadius;
      recreateCsm();
      sun.shadow.shadowNode = csm;
      setCsmCascadeLightsInScene(true);
      invalidateSunShadowPipeline();
      return;
    }

    if (cfg.mapSize !== _lastCsmMapSize) {
      _lastCsmMapSize = cfg.mapSize;
      syncCascadeShadowSettings();
    }

    if (cfg.maxFar !== _lastCsmMaxFar) {
      csm.maxFar = cfg.maxFar;
      _lastCsmMaxFar = cfg.maxFar;
      csm.updateFrustums();
    }
    if (cfg.lightMargin !== _lastCsmMargin) {
      csm.lightMargin = cfg.lightMargin;
      _lastCsmMargin = cfg.lightMargin;
      csm.updateFrustums();
    }
    if (cfg.shadowRadius !== _lastCsmRadius) {
      _lastCsmRadius = cfg.shadowRadius;
      syncCascadeShadowSettings();
    }

    if (csm.mainFrustum) {
      syncCascadeShadowSettings();
    }
  }

  function setCsmEnabled(on) {
    if (!sun.shadow) return;
    toolState.csm.enabled = on;
    syncCsmFromToolState();
  }

  function syncCsm() {
    syncCsmFromToolState();
  }

  if (renderer.shadowMap) {
    recreateCsm();
    if (toolState.csm.enabled) {
      sun.shadow.shadowNode = csm;
      setCsmCascadeLightsInScene(true);
    }
  }

  const F = toolState.fog;
  const uHFogEnabled = uniform(F.height.enabled ? 1 : 0);
  const uHFogValleyMode = uniform(F.height.mode === "valley" ? 1 : 0);
  const uHFogColor = uniform(new THREE.Color(F.height.color).convertSRGBToLinear());
  const uHFogDensity = uniform(F.height.density);
  const uHFogFalloff = uniform(F.height.falloff ?? 0.05);
  const uHFogHeight = uniform(F.height.height);
  const uValleyBase = uniform(F.height.base ?? -20);
  const uValleyTop = uniform(F.height.top ?? 55);
  const uValleyHaze = uniform(F.height.haze ?? 0.0012);
  const uValleyNoiseWobble = uniform(F.height.noiseWobble ?? 22);
  const uValleyNoiseScaleA = uniform(F.height.noiseScaleA ?? 0.005);
  const uValleyNoiseScaleB = uniform(F.height.noiseScaleB ?? 0.01);
  const uValleyTime = uniform(0);
  const uDFogEnabled = uniform(F.distance.enabled ? 1 : 0);
  const uDFogColor = uniform(new THREE.Color(F.distance.color).convertSRGBToLinear());
  const uDFogSunTint = uniform(new THREE.Color(F.distance.sunTint).convertSRGBToLinear());
  const uDFogSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uDFogTintPow = uniform(F.distance.tintPow ?? 2.0);
  const uDFogSunStrength = uniform(0);
  const uDFogDensity = uniform(F.distance.density);

  const _hfVec = positionWorld.sub(cameraPosition);
  const _hfDist = length(_hfVec);
  // Height fog integrates along the view ray toward the sky. Downward rays (top-down
  // orbit / zoom-out) made _hfK deeply negative → exp(+|k|) overflow → NaN fog factor
  // → terrain washed to black even with height fog "disabled" (NaN * 0 = NaN in WGSL).
  const _hfRayY = _hfVec.y.div(_hfDist.max(1e-4)).max(0);
  const _hfK = uHFogFalloff.mul(_hfDist).mul(_hfRayY);
  const _hfFlat = _hfK.abs().lessThan(1e-4);
  const _hfG = select(
    _hfFlat,
    float(1),
    _hfK.negate().min(float(50)).exp().oneMinus().div(_hfK.max(1e-4)),
  );
  const _hfCamTerm = uHFogFalloff
    .mul(cameraPosition.y.sub(uHFogHeight))
    .negate()
    .min(50)
    .exp();
  const _hfTau = uHFogDensity.mul(_hfCamTerm).mul(_hfDist).mul(_hfG);
  const _analyticFactorRaw = _hfTau.negate().min(50).exp().oneMinus();

  // Valley band fog (three.js webgpu_custom_fog): world-Y layer + animated triNoise3D wisps.
  const _valleyNoiseA = triNoise3D(
    positionWorld.mul(uValleyNoiseScaleA),
    float(0.2),
    uValleyTime,
  );
  const _valleyNoiseB = triNoise3D(
    positionWorld.mul(uValleyNoiseScaleB),
    float(0.2),
    uValleyTime.mul(1.2),
  );
  const _valleyNoise = _valleyNoiseA.add(_valleyNoiseB);
  const _valleyTop = uValleyTop.add(_valleyNoise.sub(0.7).mul(uValleyNoiseWobble));
  const _valleyBand = _valleyTop
    .sub(positionWorld.y)
    .div(_valleyTop.sub(uValleyBase).max(1e-4))
    .saturate()
    .mul(0.98);
  const _valleyFactorRaw = _valleyBand
    .oneMinus()
    .mul(densityFogFactor(uValleyHaze).oneMinus())
    .oneMinus();

  const _hFactorRaw = select(uHFogValleyMode.greaterThan(0.5), _valleyFactorRaw, _analyticFactorRaw);
  const _hFactor = select(uHFogEnabled.greaterThan(0.5), _hFactorRaw, float(0));
  const _dFactorRaw = densityFogFactor(uDFogDensity);
  const _dFactor = select(uDFogEnabled.greaterThan(0.5), _dFactorRaw, float(0));

  const interiorRegistry = new InteriorVolumeRegistry();
  const interiorNodes = createInteriorLightingNodes(interiorRegistry);
  const _iFactor = interiorNodes.interiorFogFactorNode;
  const _weatherFactor = clamp(_hFactor.add(_dFactor), 0, 1);
  const _combinedFactor = clamp(_weatherFactor.add(_iFactor), 0, 1);
  const _weatherW = _hFactor.add(_dFactor).add(0.0001);
  const _fogView = normalize(positionWorld.sub(cameraPosition));
  const _fogSunAmt = clamp(dot(_fogView, uDFogSunDir), 0, 1);
  const _distFogColor = mix(
    uDFogColor,
    uDFogSunTint,
    pow(_fogSunAmt, uDFogTintPow).mul(uDFogSunStrength),
  );
  const _weatherFogColor = mix(uHFogColor, _distFogColor, _dFactor.div(_weatherW));
  const _blendedFogColor = mix(
    _weatherFogColor,
    interiorNodes.uColor,
    clamp(_iFactor.div(_combinedFactor.add(0.0001)), 0, 1),
  );
  scene.fogNode = fog(_blendedFogColor, _combinedFactor);

  function syncFog() {
    uHFogEnabled.value = F.height.enabled ? 1 : 0;
    uHFogValleyMode.value = F.height.mode === "valley" ? 1 : 0;
    uHFogColor.value.set(F.height.color).convertSRGBToLinear();
    uHFogDensity.value = F.height.density;
    uHFogFalloff.value = F.height.falloff ?? 0.05;
    uHFogHeight.value = F.height.height;
    uValleyBase.value = F.height.base ?? -20;
    uValleyTop.value = F.height.top ?? 55;
    uValleyHaze.value = F.height.haze ?? 0.0012;
    uValleyNoiseWobble.value = F.height.noiseWobble ?? 22;
    uValleyNoiseScaleA.value = F.height.noiseScaleA ?? 0.005;
    uValleyNoiseScaleB.value = F.height.noiseScaleB ?? 0.01;
    uDFogEnabled.value = F.distance.enabled ? 1 : 0;
    uDFogColor.value.set(F.distance.color).convertSRGBToLinear();
    uDFogDensity.value = F.distance.density;
  }

  function driveFogSun() {
    const D = toolState.fog.distance;
    const sunUp = sunDir.y;
    uDFogSunDir.value.copy(sunDir);
    uDFogSunTint.value.set(D.sunTint).convertSRGBToLinear();
    uDFogTintPow.value = D.tintPow ?? 2.0;
    uDFogSunStrength.value = THREE.MathUtils.clamp((sunUp + 0.1) / 0.15, 0, 1);
    if (D.matchSky && toolState.skyMode === "procedural") {
      const ps = toolState.proceduralSky;
      const dayF = THREE.MathUtils.clamp((sunUp + 0.15) / 0.4, 0, 1);
      _fogAwayColor.set(ps.horizonDay);
      _fogAwayNight.set(ps.horizonNight);
      _fogAwayColor.lerp(_fogAwayNight, 1 - dayF);
      uDFogColor.value.copy(_fogAwayColor).convertSRGBToLinear();
    } else {
      uDFogColor.value.set(D.color).convertSRGBToLinear();
    }
  }

  function syncInteriorUniforms() {
    interiorNodes.syncFromRegistry(interiorRegistry, toolState.interior);
  }

  function rebuildInteriorVolumes() {
    interiorRegistry.rebuild(getSplineSystem(), null, toolState.interior);
    syncInteriorUniforms();
  }

  syncFog();
  driveFogSun();
  syncInteriorUniforms();
  rebuildInteriorVolumes();

  const sky = new SkyMesh();
  sky.scale.setScalar(toolState.physicalSky.meshScale);
  if (sky.material) sky.material.fog = false;
  scene.add(sky);

  const dayNightSky = createDayNightSky();
  dayNightSky.mesh.visible = false;
  scene.add(dayNightSky.mesh);

  let pmremGenerator = null;
  let disposeSkyEnv = null;
  let disposeHdrEnv = null;
  let hdrTexture = null;

  let _procEnvScene = null;
  let _procCubeRT = null;
  let _procCubeCam = null;
  let _procEnvRT = null;
  /**
   * A game-owned sky to bake the IBL from, instead of the engine's dome.
   *
   * Same idea as setCustomCloudSystem: the game may be drawing its own sky, and the
   * environment map has to come from the sky the player can SEE or the world reflects
   * one sky while standing under another. Contract: `{ mesh, setSunDiscScale? }`.
   */
  let customEnvSky = null;
  let _procEnvFace = -1;
  let _procEnvIdle = 0;
  let _procEnvNeeds = false;

  function applyPhysicalSkyMeshUniforms() {
    const S = toolState.physicalSky;
    sky.turbidity.value = S.turbidity;
    sky.rayleigh.value = S.rayleigh;
    sky.mieCoefficient.value = S.mie;
    sky.mieDirectionalG.value = S.mieG;
    sky.cloudCoverage.value = S.cloudCoverage;
    sky.cloudDensity.value = S.cloudDensity;
    sky.cloudElevation.value = S.cloudElevation;
  }

  function rebuildSkyEnv() {
    try {
      applyPhysicalSkyMeshUniforms();
      updateSunSky();
      if (disposeSkyEnv) {
        disposeSkyEnv();
        disposeSkyEnv = null;
      }
      pmremGenerator = pmremGenerator ?? new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      envScene.add(sky.clone());
      const pmremRT = pmremGenerator.fromScene(envScene, 0.04);
      scene.environment = pmremRT.texture;
      disposeSkyEnv = () => pmremRT.dispose();
    } catch (err) {
      console.warn("[V3] PMREM from SkyMesh failed; IBL disabled.", err);
    }
  }

  function rebuildHdrEnv() {
    if (!hdrTexture) return;
    try {
      if (disposeHdrEnv) {
        disposeHdrEnv();
        disposeHdrEnv = null;
      }
      pmremGenerator = pmremGenerator ?? new THREE.PMREMGenerator(renderer);
      const pmremRT = pmremGenerator.fromEquirectangular(hdrTexture);
      scene.environment = pmremRT.texture;
      scene.background = hdrTexture;
      disposeHdrEnv = () => pmremRT.dispose();
    } catch (err) {
      console.warn("[V3] PMREM from HDR failed; IBL disabled.", err);
      scene.background = hdrTexture;
    }
  }

  function setTimeOfDay(t) {
    // Astronomical sun: latitude + day-of-year (solar declination) + hour angle,
    // so the daily arc TILTS with latitude/season instead of rising straight up.
    const ps = toolState.proceduralSky;
    const DEG = Math.PI / 180, OB = 23.44 * DEG;
    const lat = (ps.latitude ?? 45) * DEG;
    const lamSun = ((360 * ((ps.dayOfYear ?? 172) - 80)) / 365.25) * DEG;
    const declSun = Math.asin(Math.sin(OB) * Math.sin(lamSun));
    const Hsun = (t - 12) * 15 * DEG; // hour angle: 15°/h, 0 at solar noon
    equatorialToDir(Hsun, declSun, lat, _todSunDir);
    // Round-trip through angles so manual override + updateSunSky still apply.
    toolState.light.sunElevation = THREE.MathUtils.radToDeg(
      Math.asin(THREE.MathUtils.clamp(_todSunDir.y, -1, 1)),
    );
    toolState.light.sunAzimuth =
      (THREE.MathUtils.radToDeg(Math.atan2(_todSunDir.z, _todSunDir.x)) + 360) % 360;
    toolState.proceduralSky.timeOfDay = t;
  }

  function driveProceduralSky() {
    _moonDir.copy(sunDir).negate(); // antipode: cloud night-light dir (unchanged)
    computeMoonDir(_skyMoonDir);    // realistic moon for the sky disc
    _moonLightDir.copy(sunDir);     // moon lit by the real sun → phase from geometry
    const Df = toolState.fog.distance;
    dayNightSky.update(toolState.proceduralSky, {
      time: _appTimeSec,
      renderer,                     // for the sky-view LUT bake
      sunDir,
      moonDir: _skyMoonDir,
      moonLightDir: _moonLightDir,
      camera,
      fog: {
        enabled: Df.enabled,
        color: _procSkyFogColor.set(Df.color),
        density: Df.density,
        hazeHeight: toolState.proceduralSky.hazeHeight,
      },
    });
  }

  function ensureProcEnvRig() {
    if (_procCubeRT) return;
    _procEnvScene = new THREE.Scene();
    // Clone whichever dome is actually being SHOWN. A game that registers its own sky
    // (see setCustomEnvSky) would otherwise be lit and reflected by the engine's dome
    // while a different sky is drawn on screen — two skies in one frame, which shows up
    // first on wet and metallic surfaces.
    const envSkyMesh = customEnvSky?.mesh ?? dayNightSky.mesh;
    const domeClone = envSkyMesh.clone();
    domeClone.visible = true;
    domeClone.position.set(0, 0, 0);
    _procEnvScene.add(domeClone);
    _procCubeRT = new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType });
    _procCubeCam = new THREE.CubeCamera(0.1, 20000, _procCubeRT);
    _procCubeCam.updateMatrixWorld(true);
    pmremGenerator = pmremGenerator ?? new THREE.PMREMGenerator(renderer);
  }

  function renderProcEnvFace(face) {
    ensureProcEnvRig();
    const prev = renderer.getRenderTarget();
    // Sun disc OUT of the IBL: its energy already reaches surfaces via the
    // directional light — capturing it in the env map counted it twice (lifted
    // ambient + a phantom specular sun). The aureole/glow stays in.
    const envSky = customEnvSky ?? dayNightSky;
    envSky.setSunDiscScale?.(0);
    renderer.setRenderTarget(_procCubeRT, face);
    renderer.render(_procEnvScene, _procCubeCam.children[face]);
    envSky.setSunDiscScale?.(1);
    renderer.setRenderTarget(prev);
  }

  function convolveProcEnv() {
    _procEnvRT = pmremGenerator.fromCubemap(_procCubeRT.texture, _procEnvRT);
    scene.environment = _procEnvRT.texture;
  }

  /**
   * Register (or clear with null) the sky the IBL is baked from. Tears the capture rig
   * down so it is rebuilt around the new dome, and asks for an immediate re-bake —
   * without that the world would keep reflecting the previous sky until something else
   * happened to invalidate it.
   */
  function setCustomEnvSky(sky) {
    customEnvSky = sky ?? null;
    _procEnvScene = null;
    if (_procCubeRT) { _procCubeRT.dispose(); _procCubeRT = null; }
    _procCubeCam = null;
    _procEnvFace = -1;
    _procEnvIdle = 0;
    _procEnvNeeds = true;
  }

  /**
   * Ask for an IBL re-bake. The engine invalidates on its OWN sky's parameters, so a
   * game driving a custom sky (time of day, weather) has to say when its look moved.
   */
  function invalidateProcEnv() {
    _procEnvNeeds = true;
  }

  function disposeProcEnvRT() {
    if (_procEnvRT) {
      _procEnvRT.dispose();
      _procEnvRT = null;
    }
  }

  function updateProcEnvBake(dt) {
    if (_procEnvFace < 0) {
      if (!_procEnvNeeds && !toolState.proceduralSky.autoAdvance) return;
      _procEnvIdle -= dt;
      if (_procEnvIdle > 0) return;
      _procEnvNeeds = false;
      _procEnvFace = 0;
    }
    renderProcEnvFace(_procEnvFace);
    _procEnvFace++;
    if (_procEnvFace >= 6) {
      convolveProcEnv();
      _procEnvFace = -1;
      _procEnvIdle = PROC_ENV_IDLE;
    }
  }

  function rebuildProceduralSkyEnv() {
    try {
      updateSunSky();
      driveProceduralSky();
      ensureProcEnvRig();
      for (let f = 0; f < 6; f++) renderProcEnvFace(f);
      convolveProcEnv();
      _procEnvFace = -1;
      _procEnvIdle = PROC_ENV_IDLE;
      _procEnvNeeds = false;
    } catch (err) {
      console.warn("[V3] PMREM from procedural sky failed; IBL disabled.", err);
    }
  }

  function applySkyMode(mode, prevMode) {
    const prev = prevMode !== undefined ? prevMode : toolState.skyMode;
    if (prev !== mode) {
      toolState.skyExposureByMode[prev] = toolState.light.exposure;
      const nextExposure =
        toolState.skyExposureByMode[mode] ?? (mode === "procedural" ? 0.7 : 0.5);
      if (toolState.light.exposure !== nextExposure) {
        toolState.light.exposure = nextExposure;
      }
    }
    toolState.skyMode = mode;
    dayNightSky.mesh.visible = mode === "procedural";
    if (mode === "physical") {
      if (disposeHdrEnv) {
        disposeHdrEnv();
        disposeHdrEnv = null;
      }
      disposeProcEnvRT();
      sky.visible = true;
      scene.background = null;
      scene.backgroundIntensity = 1;
      rebuildSkyEnv();
    } else if (mode === "hdr") {
      sky.visible = false;
      disposeProcEnvRT();
      if (hdrTexture) {
        if (disposeSkyEnv) {
          disposeSkyEnv();
          disposeSkyEnv = null;
        }
        rebuildHdrEnv();
      } else {
        if (disposeHdrEnv) {
          disposeHdrEnv();
          disposeHdrEnv = null;
        }
        scene.background = null;
        scene.backgroundIntensity = 1;
        scene.environment = null;
      }
    } else if (mode === "procedural") {
      sky.visible = false;
      if (disposeSkyEnv) {
        disposeSkyEnv();
        disposeSkyEnv = null;
      }
      if (disposeHdrEnv) {
        disposeHdrEnv();
        disposeHdrEnv = null;
      }
      scene.background = null;
      scene.backgroundIntensity = 1;
      rebuildProceduralSkyEnv();
    }
    updateSunSky();
  }

  function importHdr() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".hdr";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const loader = new HDRLoader();
      loader.load(url, (tex) => {
        URL.revokeObjectURL(url);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        if (hdrTexture) hdrTexture.dispose();
        hdrTexture = tex;
        applySkyMode("hdr");
      });
    };
    input.click();
  }

  /**
   * Place the sun RELATIVE TO ITS SHADOW TARGET, never relative to the origin.
   *
   * A DirectionalLight's direction is `normalize(target - position)`. The shadow
   * target follows the camera (see syncCsmFromToolState), so anchoring the sun to
   * the world origin made the light direction depend on WHERE THE CAMERA WAS
   * LOOKING: correct at the origin, and increasingly skewed the further out you
   * went — sunDistance is only 600, less than half a world away.
   *
   * Measured before this fix, with the sun configured at 43° elevation / 135°
   * azimuth: looking at the origin gave 43°/135° (right); looking 737 units out
   * gave 20.5°/163.5°; at the far corner, 18.6°/66.2° — the shadows had swung 70°
   * around the compass. Shadows also disagreed with the sun drawn in the SKY,
   * which always used the true direction.
   *
   * Nobody caught it because the editor orbits the terrain centre — which is the
   * origin, the one place the maths came out right.
   */
  function placeSun() {
    sun.position
      .copy(shadowTarget.position)
      .addScaledVector(_effectiveLightDir, toolState.light.sunDistance);
  }

  function updateSunSky() {
    const Li = toolState.light;
    sunDirectionFromAngles(Li.sunAzimuth, Li.sunElevation, sunDir);
    const sunUp = sunDir.y;
    if (toolState.skyMode === "procedural" && sunUp < 0) {
      _effectiveLightDir.copy(sunDir).negate();
      placeSun();
      sun.color.set(toolState.proceduralSky.moonColor);
      sun.intensity =
        (Li.moonIntensity ?? 0.3) *
        THREE.MathUtils.smoothstep(-sunUp, 0.0, 0.15);
    } else {
      _effectiveLightDir.copy(sunDir);
      placeSun();
      sun.color.set(Li.dirColor);
      const sunFade =
        toolState.skyMode === "procedural"
          ? THREE.MathUtils.smoothstep(sunUp, -0.05, 0.1)
          : 1;
      sun.intensity = Li.dirIntensity * sunFade;
    }
    hemi.color.set(Li.hemiSkyColor);
    hemi.groundColor.set(Li.hemiGroundColor);
    hemi.intensity = Li.hemiIntensity;
    sun.shadow.bias = Li.shadowBias;
    sun.shadow.normalBias = Li.shadowNormalBias;
    syncCascadeShadowSettings();
    renderer.toneMappingExposure = Li.exposure;
    if (toolState.skyMode === "hdr") {
      scene.environmentIntensity = Li.hdrEnvIntensity ?? 1;
      scene.backgroundIntensity = Li.hdrBackgroundIntensity ?? 0.7;
    } else {
      scene.environmentIntensity = Li.envIntensity;
      scene.backgroundIntensity = 1;
    }
    applyPhysicalSkyMeshUniforms();
    sky.scale.setScalar(toolState.physicalSky.meshScale);
    if (sky.sunPosition?.value?.copy) {
      sky.sunPosition.value.copy(sunDir);
    } else if (sky.sunPosition?.copy) {
      sky.sunPosition.copy(sunDir);
    }
  }

  updateSunSky();
  applySkyMode(toolState.skyMode);

  const lensFlare = createLensFlareSystem({
    scene,
    camera,
    getSunDir: () => sunDir,
    getParams: () => toolState.lensFlare,
  });

  const postFxPipeline = new PostFxPipeline({ renderer, scene, camera });
  // v3 uses SELECTIVE bloom: only the emissive MRT buffer blooms (lanterns,
  // LEDs, string lights…), so the bright sky never glows. Same trick as the
  // objects lab. The sun disc/god rays are separate effects, unaffected.
  postFxPipeline.setBloomSelective(true);

  function applyPostFxState() {
    const p = toolState.postFx;
    postFxPipeline.setBloomParams(p.bloom);
    postFxPipeline.setBloomEnabled(p.bloom.enabled);
    postFxPipeline.setFxaaEnabled(p.fxaa.enabled);
    postFxPipeline.setSsaoParams(p.ssao);
    postFxPipeline.setSsaoEnabled(p.ssao.enabled);
    postFxPipeline.setPolishParams(p.polish);
    postFxPipeline.setPolishEnabled(p.polish.enabled);
    postFxPipeline.setSharpenParams(p.sharpen);
    postFxPipeline.setSharpenEnabled(p.sharpen.enabled);
    postFxPipeline.setChromaticAberrationParams(p.chromaticAberration);
    postFxPipeline.setChromaticAberrationEnabled(p.chromaticAberration.enabled);
    postFxPipeline.setDofParams(p.dof);
    postFxPipeline.setDofEnabled(p.dof.enabled);
    postFxPipeline.setEnabled(p.enabled);
  }
  applyPostFxState();

  const worldOcean = createWorldOcean({
    renderer,
    scene,
    heightTexNode,
    terrainSize,
    maxHeight: 500,
  });
  worldOcean.syncParams(toolState.worldOcean);
  worldOcean.setSunDir(_effectiveLightDir);

  // Depth-buffer water surfaces (LakeSystem, River+) are owned by main.js but driven
  // from here: the effective light direction and the day/night sky colours are only
  // fresh inside updateFrame(). Each surface may implement setSunDir, setSkyColors
  // and updateWater; all three are optional.
  const waterSurfaces = [];
  function addWaterSurface(surface) {
    if (!surface || waterSurfaces.includes(surface)) return;
    waterSurfaces.push(surface);
    surface.setSunDir?.(_effectiveLightDir);
  }

  let dayNightCloudLayer = null;
  function ensureDayNightCloudLayer() {
    if (dayNightCloudLayer) return dayNightCloudLayer;
    try {
      dayNightCloudLayer = createDayNightCloudLayer({ scene, camera, renderer });
      scene.add(dayNightCloudLayer.mesh);
      scene.add(dayNightCloudLayer.sunMesh);
    } catch (err) {
      console.warn("[V3] Daynight cloud layer failed to init:", err);
    }
    return dayNightCloudLayer;
  }

  function driveDayNightClouds(dtSec) {
    if (!dayNightCloudLayer) return;
    const P = toolState.volumetricCloudDayNight;
    const ps = toolState.proceduralSky;
    const sunUp = sunDir.y;
    const dayF = THREE.MathUtils.clamp((sunUp + 0.15) / 0.4, 0, 1);
    let lightDir;
    if (sunUp >= 0) {
      lightDir = sunDir;
      _cloudLightColor.set(ps.sunColor);
    } else {
      lightDir = _moonDir;
      _cloudLightColor.set(ps.moonColor);
    }
    _cloudAmbColor.set(ps.horizonDay);
    _cloudAmbNight.set(ps.horizonNight);
    _cloudAmbColor.lerp(_cloudAmbNight, 1 - dayF);
    dayNightCloudLayer.update(P, {
      dt: Math.min(dtSec, 0.05),
      camera,
      lightDir,
      lightColor: _cloudLightColor,
      lightIntensity: THREE.MathUtils.lerp(0.35, 3.0, dayF),
      ambientColor: _cloudAmbColor,
      ambientIntensity: THREE.MathUtils.lerp(0.2, 0.5, dayF),
      fog: { color: _cloudAmbColor },
    });
    const cs = toolState.cloudShadows;
    dayNightCloudLayer.setCloudShadow({
      enabled: cs.enabled && P.enabled,
      strength: cs.strength * dayF,
      sunDir,
    });
    dayNightCloudLayer.setBloom(toolState.cloudBloom);
    // God rays on the post-FX path: prepareFrame() renders the shaft buffer and
    // the linear cloud composite adds it (the owns-the-frame path passes the
    // same config through tryRenderFrame instead).
    dayNightCloudLayer.setGodRaysOpts?.({
      P: toolState.cloudGodRays,
      frame: { camera, sunDir, lightColor: _cloudLightColor },
      occluders: getTerrainMeshes(),
      skyMesh: dayNightSky.mesh,
    });
  }

  function worldOceanChanged() {
    worldOcean.syncParams(toolState.worldOcean);
  }

  function updateFrame(dtSec, { streamQueueDepth = 0 } = {}) {
    _appTimeSec += dtSec;
    uValleyTime.value = _appTimeSec;

    const focusPos = playMode?.active ? playMode.playerPosition : camera.position;
    const cloudFollowAnchor = playMode?.active ? playMode.playerPosition : controls.target;

    const Li = toolState.light;
    const S = toolState.physicalSky;
    const lightSnap = `${Li.sunAzimuth},${Li.sunElevation},${Li.dirColor},${Li.dirIntensity},${Li.moonIntensity},${toolState.proceduralSky.moonColor},${Li.hemiSkyColor},${Li.hemiGroundColor},${Li.hemiIntensity},${Li.shadowBias},${Li.shadowNormalBias},${Li.exposure},${Li.envIntensity},${Li.hdrEnvIntensity},${Li.hdrBackgroundIntensity},${Li.sunDistance},${S.turbidity},${S.rayleigh},${S.mie},${S.mieG},${S.cloudCoverage},${S.cloudDensity},${S.cloudElevation},${S.meshScale}`;

    if (lightSnap !== _lastLightSnap) {
      _lastLightSnap = lightSnap;
      updateSunSky();
      worldOcean.setSunDir(_effectiveLightDir);
    }

    lensFlare.update();

    if (toolState.fog.distance.enabled) driveFogSun();

    if (toolState.skyMode === "procedural") {
      const ps = toolState.proceduralSky;
      const procDt = Math.min(dtSec, 0.05);
      if (ps.autoAdvance) {
        setTimeOfDay((ps.timeOfDay + ps.daySpeed * procDt) % 24);
      }
      driveProceduralSky();
      const procSnap = `${Li.sunAzimuth},${Li.sunElevation},${ps.scatter},${ps.rayleigh},${ps.mie},${ps.mieG},${ps.sunIntensity},${ps.msAmount},${ps.zenithDay},${ps.horizonDay},${ps.zenithNight},${ps.horizonNight},${ps.sunsetColor},${ps.groundColor},${ps.sunColor},${ps.moonColor},${ps.cloudEnabled},${ps.cloudCoverage},${ps.cloudColor}`;
      if (procSnap !== _lastProcSkySnap) {
        _lastProcSkySnap = procSnap;
        _procEnvNeeds = true;
        if (!ps.autoAdvance) _procEnvIdle = 0.3;
      }
      if (streamQueueDepth < STREAM_QUEUE_PRESSURE) {
        updateProcEnvBake(procDt);
      }
    }

    const Int = toolState.interior;
    const interiorSnap = `${Int.enabled},${Int.strength},${Int.color},${Int.ambientScale},${Int.tunnelRadiusScale},${Int.segmentStep},${Int.edgeSoftness},${Int.openingLength},${Int.boxEdgeSoftness},${Int.caveShrink},${getSplineSystem()?.tunnels?.length ?? 0}`;
    if (interiorSnap !== _lastInteriorSnap) {
      _lastInteriorSnap = interiorSnap;
      syncInteriorUniforms();
    }

    let fillScale = 1;
    if (Int.enabled) {
      _interiorFocusPos.copy(focusPos);
      const interiorAmb = interiorRegistry.sampleFactorAt(_interiorFocusPos, Int);
      fillScale = THREE.MathUtils.lerp(1, Int.ambientScale ?? 0.22, interiorAmb);
    }
    hemi.intensity = Li.hemiIntensity * fillScale;
    if (toolState.skyMode === "physical" || toolState.skyMode === "procedural") {
      scene.environmentIntensity = Li.envIntensity * fillScale;
    } else if (toolState.skyMode === "hdr") {
      scene.environmentIntensity = (Li.hdrEnvIntensity ?? 1) * fillScale;
    }

    _shadowFocus.copy(cloudFollowAnchor);
    syncCsmFromToolState();

    const ps   = toolState.proceduralSky;
    const sunY = _effectiveLightDir.y;
    const dayT = THREE.MathUtils.clamp((sunY + 0.1) / 0.35, 0, 1);
    _oceanZenith.set(ps.zenithDay).lerp(_tmpOceanC.set(ps.zenithNight), 1 - dayT);
    _oceanHorizon.set(ps.horizonDay).lerp(_tmpOceanC.set(ps.horizonNight), 1 - dayT);
    worldOcean.setSkyColors(_oceanZenith, _oceanHorizon);
    worldOcean.update(dtSec, _appTimeSec, camera);

    for (const s of waterSurfaces) {
      s.setSkyColors?.(_oceanZenith, _oceanHorizon);
      s.setSunDir?.(_effectiveLightDir);
      s.updateWater?.(dtSec, _appTimeSec);
    }
  }

  /**
   * A GAME-SUPPLIED cloud system, or null (the default, and the editor's state).
   *
   * ADDITIVE HOOK — inert unless a game registers something, and it changes nothing about
   * the editor's own deck, which is still the `dayNightCloudLayer` path below.
   *
   * It exists because the two use cases genuinely differ: the editor's deck is a ceiling
   * viewed from far below, while games/modular-road-v3 flies a car THROUGH its clouds and
   * needs a completely different step schedule, noise frequency and coverage model. Rather
   * than bend one shader into serving both, a game can own its own and register it here.
   *
   * Contract: `{ enabled, update(dt, frame), renderFrame(), prepareFrame(),
   *              compositeOntoLinearHDR(renderer, rt), setDepthSource(tex) }`.
   */
  let customCloudSystem = null;
  function setCustomCloudSystem(system) {
    customCloudSystem = system ?? null;
  }

  function renderFrame(dtSec) {
    const cloudFollowAnchor = playMode?.active ? playMode.playerPosition : controls.target;

    // Game clouds take priority over the editor deck when registered AND enabled. Disabled
    // costs nothing: we fall straight through to the normal path below.
    if (customCloudSystem?.enabled) {
      if (postFxPipeline.isActive()) {
        // Hand it the depth the solids pass already wrote so it can march afterwards
        // instead of re-rendering the scene to make its own.
        customCloudSystem.setDepthSource?.(postFxPipeline.getSceneDepthTexture?.() ?? null);
        postFxPipeline.renderWithClouds(customCloudSystem, cloudFollowAnchor, dtSec);
        return;
      }
      customCloudSystem.setDepthSource?.(null); // owns-the-frame path uses its own buffer
      if (customCloudSystem.renderFrame()) return;
    }

    const dncOn =
      toolState.skyMode === "procedural" && toolState.volumetricCloudDayNight.enabled;

    if (dncOn) ensureDayNightCloudLayer();
    if (!dncOn && dayNightCloudLayer) dayNightCloudLayer.mesh.visible = false;

    let didCloudRt = false;
    if (dncOn && dayNightCloudLayer) {
      driveDayNightClouds(dtSec);
      if (postFxPipeline.isActive()) {
        postFxPipeline.renderWithClouds(dayNightCloudLayer, cloudFollowAnchor, dtSec);
        didCloudRt = true;
      } else {
        didCloudRt = dayNightCloudLayer.tryRenderFrame({
          godRays: toolState.cloudGodRays,
          frame: { camera, sunDir, lightColor: _cloudLightColor },
          occluders: getTerrainMeshes(),
          skyMesh: dayNightSky.mesh,
        });
      }
    }

    if (!didCloudRt) {
      if (postFxPipeline.isActive()) {
        postFxPipeline.render();
      } else {
        renderer.render(scene, camera);
      }
    }
  }

  function setSize(w, h) {
    postFxPipeline.setSize(w, h);
  }

  return {
    sun,
    hemi,
    csm,
    worldOcean,
    lensFlare,
    postFxPipeline,
    sunDir,
    getEffectiveLightDir: () => _effectiveLightDir,
    setCustomCloudSystem,
    /**
     * The lens flare, so a game can own its look and — more importantly — tell it what
     * is in front of the sun. See createLensFlareSystem's setOcclusion.
     */
    lensFlareParams: () => toolState.lensFlare,
    setLensFlareOcclusion: (v) => lensFlare.setOcclusion(v),
    setLensFlareSourceScale: (v) => lensFlare.setSourceScale?.(v),
    setPurkinje: (o) => postFxPipeline?.setPurkinje?.(o),
    setCustomEnvSky,
    invalidateProcEnv,
    syncCsm,
    syncCsmFromToolState,
    setCsmEnabled,
    applyPostFxState,
    syncFog,
    driveFogSun,
    applySkyMode,
    importHdr,
    setTimeOfDay,
    rebuildProceduralSkyEnv,
    rebuildSkyEnv,
    syncInteriorUniforms,
    rebuildInteriorVolumes,
    worldOceanChanged,
    addWaterSurface,
    updateFrame,
    renderFrame,
    setSize,
  };
}
