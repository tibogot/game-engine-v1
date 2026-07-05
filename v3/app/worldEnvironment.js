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
  const uHFogColor = uniform(new THREE.Color(F.height.color).convertSRGBToLinear());
  const uHFogDensity = uniform(F.height.density);
  const uHFogFalloff = uniform(F.height.falloff ?? 0.05);
  const uHFogHeight = uniform(F.height.height);
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
  const _hFactorRaw = _hfTau.negate().min(50).exp().oneMinus();
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
    uHFogColor.value.set(F.height.color).convertSRGBToLinear();
    uHFogDensity.value = F.height.density;
    uHFogFalloff.value = F.height.falloff ?? 0.05;
    uHFogHeight.value = F.height.height;
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
    const domeClone = dayNightSky.mesh.clone();
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
    renderer.setRenderTarget(_procCubeRT, face);
    renderer.render(_procEnvScene, _procCubeCam.children[face]);
    renderer.setRenderTarget(prev);
  }

  function convolveProcEnv() {
    _procEnvRT = pmremGenerator.fromCubemap(_procCubeRT.texture, _procEnvRT);
    scene.environment = _procEnvRT.texture;
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

  function updateSunSky() {
    const Li = toolState.light;
    sunDirectionFromAngles(Li.sunAzimuth, Li.sunElevation, sunDir);
    const sunUp = sunDir.y;
    if (toolState.skyMode === "procedural" && sunUp < 0) {
      _effectiveLightDir.copy(sunDir).negate();
      sun.position.copy(_effectiveLightDir).multiplyScalar(Li.sunDistance);
      sun.color.set(toolState.proceduralSky.moonColor);
      sun.intensity =
        (Li.moonIntensity ?? 0.3) *
        THREE.MathUtils.smoothstep(-sunUp, 0.0, 0.15);
    } else {
      _effectiveLightDir.copy(sunDir);
      sun.position.copy(sunDir).multiplyScalar(Li.sunDistance);
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
  }

  function worldOceanChanged() {
    worldOcean.syncParams(toolState.worldOcean);
  }

  function updateFrame(dtSec, { streamQueueDepth = 0 } = {}) {
    _appTimeSec += dtSec;

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
      const procSnap = `${Li.sunAzimuth},${Li.sunElevation},${ps.scatter},${ps.rayleigh},${ps.mie},${ps.mieG},${ps.sunIntensity},${ps.msAmount},${ps.msExtinct},${ps.zenithDay},${ps.horizonDay},${ps.zenithNight},${ps.horizonNight},${ps.sunsetColor},${ps.groundColor},${ps.sunColor},${ps.moonColor},${ps.cloudEnabled},${ps.cloudCoverage},${ps.cloudColor}`;
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
  }

  function renderFrame(dtSec) {
    const cloudFollowAnchor = playMode?.active ? playMode.playerPosition : controls.target;
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
    updateFrame,
    renderFrame,
    setSize,
  };
}
