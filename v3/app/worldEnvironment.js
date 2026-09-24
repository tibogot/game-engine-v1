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
  min,
  max,
  vec3,
} from "three/tsl";
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js";
import { groundPatch } from "../render/viewGroundBand.js";
import { SkyMesh } from "three/addons/objects/SkyMesh.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { projectAssets } from "../io/projectAssets.js";
import { nearAnchoredSplits, describeCascades } from "./csmSplits.js";
import {
  wrapSunShadow,
  unwrapSunShadow,
  setTerrainSunDirection,
  setTerrainShadowParams,
} from "../render/lighting/terrainSunShadow.js";
import { mergeKnownKeys } from "./state/mergeKnownKeys.js";
import { createLensFlareSystem } from "../../v2/effects/lensFlare.js";
import { createLensFlare2 } from "../../v2/effects/lensFlare2.js";
import { applyBloomMRT } from "../render/bloomMRT.js";
import { PostFxPipeline } from "../../v2/render/post/postFxPipeline.js";
import { createDayNightSky } from "../render/sky/dayNightSky.js";
import { createAtmosphereSky, skyBandWeights } from "../render/sky/atmosphereSkyDome.js";
import { createSkyAtmosphere } from "../render/sky/skyAtmosphere.js";
import { createCloudSkyLight } from "../render/sky/cloudSkyLight.js";
import { createSkyWorldLight, WORLD_LIGHT_REFERENCE } from "../render/sky/skyWorldLight.js";
import { SKY_LENS_FLARE_LOOK } from "../render/sky/skyLensFlareLook.js";
import { createModularRoadClouds } from "../render/clouds/volumetricCloudDeck.js";
import { createPaintedClouds } from "../render/clouds/paintedCloudDeck.js";
import { createDayNightCloudLayer } from "../render/clouds/dayNightCloudLayer.js";
import { createWorldOcean } from "../render/water/worldOcean.js";
import { createWorldOceanV2 } from "../render/water/worldOceanV2.js";
import { HEIGHTMAP_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";
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
  /**
   * This frame's zenith/horizon/sun from the atmosphere dome's look — see
   * driveAtmosphereSky. Scratch colours because the fog, the cloud deck and the ocean all
   * read them every frame. LINEAR, like everything that came out of a `Color.set(hex)`, so
   * consumers must `copy` and never `set` again — see the colour-space note on driveFogSun.
   *
   * DECLARED UP HERE, with the other scratch, and not beside the rest of the atmosphere
   * state further down. `syncFog()` and `driveFogSun()` run during setup, ABOVE that
   * block, and driveFogSun reads `_atmoColors`. While the editor booted into another sky
   * mode the `skyMode === "atmosphere"` test short-circuited before touching it; the day
   * that became the DEFAULT mode, the same line became a temporal-dead-zone ReferenceError
   * and the editor failed to start.
   */
  const _atmoZenith = new THREE.Color();
  const _atmoHorizon = new THREE.Color();
  const _atmoSunColor = new THREE.Color();
  const _atmoScratch = new THREE.Color();
  /** Null until the dome has been driven once; then always these same three colours. */
  let _atmoColors = null;
  const _atmoColorsRef = {
    zenith: _atmoZenith, horizon: _atmoHorizon, sunColor: _atmoSunColor,
  };

  const _fogAwayNight = new THREE.Color();
  const _interiorFocusPos = new THREE.Vector3();

  let _appTimeSec = 0;
  let _lastLightSnap = "";
  let _lastProcSkySnap = "";
  let _lastInteriorSnap = "";

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

  /*
   * FIT THE SUN'S SHADOW TO THE GROUND THE CAMERA CAN ACTUALLY SEE.
   *
   * The old version sized the box from the camera-to-focus DISTANCE
   * (`half = dist * 0.55`), which is not the same question and under-covered
   * badly: at a 52 m orbit it gave +/-28 m while the visible ground ran from
   * 23 m to 97 m out and 130 m wide, so most of the screen simply had no
   * shadows in it. groundPatch answers the real question.
   *
   * TEXEL SNAPPING is the part a naive fit leaves out, and it is not optional.
   * A frustum that follows the camera slides by a fraction of a texel every
   * frame, and every shadow edge in the scene crawls and fizzes as it does.
   * Quantising the centre to whole texels IN LIGHT SPACE makes the map move in
   * discrete jumps that land on the same texels, so edges sit still.
   *
   * The radius is also quantised, for the same reason applied to size rather
   * than position: a frustum that grows smoothly re-scales the texel grid every
   * frame, which no amount of position snapping can hide.
   */
  const _fitEye = new THREE.Vector3();
  const _fitCentre = new THREE.Vector3();
  const _fitView = new THREE.Matrix4();
  const _fitUp = new THREE.Vector3(0, 1, 0);
  const _fitSide = new THREE.Vector3(1, 0, 0);
  const _fitAxisX = new THREE.Vector3();
  const _fitAxisY = new THREE.Vector3();
  function fitDirectionalShadowToView(cam, focus, maxFar, lightMargin) {
    const shadowCam = sun.shadow.camera;
    const patch = groundPatch(cam, focus?.y ?? 0);

    // Quantise the size so the texel grid only changes when the view really
    // does — 8% steps are invisible and stop the per-frame re-scale.
    const raw = THREE.MathUtils.clamp(patch.radius, 12, Math.max(24, maxFar));
    const half = Math.pow(2, Math.ceil(Math.log2(raw) * 12) / 12);
    const mapSize = sun.shadow.mapSize.x || 2048;
    const texel = (2 * half) / mapSize;

    _fitCentre.set(patch.cx, focus?.y ?? 0, patch.cz);
    // Snap in LIGHT space: build the light's view basis, quantise the centre's
    // x/y in it, and put it back. Snapping in world space does nothing, because
    // the grid that matters is the shadow map's, not the world's.
    _fitEye.copy(_fitCentre).addScaledVector(_effectiveLightDir, lightMargin + half * 2);
    const upish = Math.abs(_effectiveLightDir.y) > 0.99 ? _fitSide : _fitUp;
    _fitView.lookAt(_fitEye, _fitCentre, upish);
    _fitView.setPosition(0, 0, 0);
    _fitView.invert();                                  // world -> light basis
    _fitAxisX.setFromMatrixColumn(_fitView, 0);
    _fitAxisY.setFromMatrixColumn(_fitView, 1);
    const lx = _fitCentre.dot(_fitAxisX);
    const ly = _fitCentre.dot(_fitAxisY);
    _fitCentre
      .addScaledVector(_fitAxisX, Math.round(lx / texel) * texel - lx)
      .addScaledVector(_fitAxisY, Math.round(ly / texel) * texel - ly);

    shadowTarget.position.copy(_fitCentre);
    placeSun();

    shadowCam.left = -half;
    shadowCam.right = half;
    shadowCam.top = half;
    shadowCam.bottom = -half;
    shadowCam.near = 0.5;
    // Deep enough that a caster standing OUTSIDE the patch, up-light of it,
    // still reaches the map — a low sun throws long shadows in from off screen.
    //
    // MEASURED FROM THE LIGHT'S REAL DISTANCE, not from the patch radius.
    // placeSun parks the sun a FIXED `sunDistance` from the target, so a small
    // patch used to produce a frustum shorter than that: at the RTS camera's
    // closest zoom the patch was ±64 m, far came out 506, and the sun sat 600
    // away — the ground lay BEHIND the far plane, nothing rendered into the
    // shadow map, and every shadow in the scene disappeared at once.
    const lightDist = sun.position.distanceTo(shadowTarget.position);
    shadowCam.far = lightDist + half * 2 + lightMargin + 50;
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
  let _lastCsmSplitMode = toolState.csm.splitMode ?? "custom";
  let _lastCsmNearSplit = toolState.csm.nearSplit ?? 10;
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
      splitMode: String(cfg.splitMode ?? "custom"),
      nearSplit: Number(cfg.nearSplit ?? 10),
      enabled: !!cfg.enabled,
    };
  }

  /*
   * The split callback reads toolState LIVE, so `nearSplit` needs no rebuild —
   * updateFrustums() re-runs it. Unlike the cascade COUNT (which is baked into
   * the compiled pipeline and so is boot-only on r184), splits are just uniforms
   * and ortho boxes: mode and anchor are both safe to change while running.
   */
  function csmSplitsCallback(amount, near, far, target) {
    return nearAnchoredSplits(amount, near, far, toolState.csm.nearSplit ?? 10, target);
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
        mode: toolState.csm.splitMode ?? "custom",
        customSplitsCallback: csmSplitsCallback,
        lightMargin: toolState.csm.lightMargin,
      });
      csm.fade = !!toolState.csm.fade;
      syncCascadeShadowSettings();
      if (toolState.csm.enabled) sun.shadow.shadowNode = wrapSunShadow(csm);
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
    // Uniforms only: flipping terrain shadows never recompiles anything.
    setTerrainShadowParams({
      enabled: toolState.csm.terrainShadows !== false,
      softness: toolState.csm.terrainShadowSoftness ?? 0.5,
      shadeFloor: toolState.csm.terrainShadeFloor ?? 0.45,
    });
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
    sun.shadow.shadowNode = cfg.enabled ? wrapSunShadow(csm) : null;

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
      sun.shadow.shadowNode = wrapSunShadow(csm);
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
    if (cfg.splitMode !== _lastCsmSplitMode || cfg.nearSplit !== _lastCsmNearSplit) {
      _lastCsmSplitMode = cfg.splitMode;
      _lastCsmNearSplit = cfg.nearSplit;
      csm.mode = cfg.splitMode;
      csm.customSplitsCallback = csmSplitsCallback;
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
      sun.shadow.shadowNode = wrapSunShadow(csm);
      setCsmCascadeLightsInScene(true);
    }
  }

  const F = toolState.fog;
  const uHFogEnabled = uniform(F.height.enabled ? 1 : 0);
  // 0 = analytic (Crytek half-space), 1 = valley band, 2 = monsoon. Was a
  // boolean; a third mode needed a number, and naming it after the mode
  // rather than one of its values stops the next one needing another rename.
  const uHFogMode = uniform(F.height.mode === "monsoon" ? 2 : F.height.mode === "valley" ? 1 : 0);
  /*
   * FOG COLOURS CONVERT ONCE — here and at every `.set(hex)` below.
   *
   * `THREE.Color`'s constructor and `.set()` ALREADY run sRGB->linear: both default to
   * SRGBColorSpace and call `ColorManagement.toWorkingColorSpace`, and nothing in v3
   * disables colour management. Each of these used to chain `.convertSRGBToLinear()`
   * on top, applying the curve a SECOND time.
   *
   * Not subtle: height fog #a8c4e0 landed at 0.127 linear red instead of 0.392 (3.1x
   * too dark), and the sun tint #ffd6a0 lost 3.5x of its blue. About 70 of 255 display
   * code values — and a HUE shift rather than a brightness one, because the transfer
   * function is non-linear and crushes the weak channels hardest. Fog read too blue,
   * the sun tint too orange.
   *
   * It hid because both fog types default to `enabled: false`, so it only showed once
   * fog was switched on. Same bug was fixed in games/modular-road-v3 and games/rts-v3.
   *
   * THE HEXES ARE NOT REBASED. On the road deck the literals were rebased so the tuned
   * look held byte-for-byte; fog is atmosphere, not art direction, and these values are
   * what the colour pickers have been promising all along. Fog gets LIGHTER here, and
   * that is the correction.
   */
  const uHFogColor = uniform(new THREE.Color(F.height.color));
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
  // ── MONSOON mode ──────────────────────────────────────────────────────────
  const uMonDensity = uniform(F.height.monDensity ?? 0.02);
  const uMonFalloff = uniform(F.height.monFalloff ?? 0.045);
  const uMonHeight = uniform(F.height.monHeight ?? 12);
  const uMonStrata = uniform(F.height.monStrata ?? 0.45);
  const uMonStrataScale = uniform(F.height.monStrataScale ?? 0.02);
  const uMonSunTint = uniform(new THREE.Color(F.height.monSunTint ?? "#ffcf9a"));
  const uMonSunStrength = uniform(F.height.monSunStrength ?? 0.75);
  const uMonTintPow = uniform(F.height.monTintPow ?? 3.0);
  const uDFogEnabled = uniform(F.distance.enabled ? 1 : 0);
  const uDFogColor = uniform(new THREE.Color(F.distance.color));
  const uDFogSunTint = uniform(new THREE.Color(F.distance.sunTint));
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

  /*
   * ── MONSOON: the height-fog integral done for a camera that LOOKS DOWN ────
   *
   * The analytic mode above is the Crytek half-space integral and it is right,
   * but only for rays going UP or level. `_hfRayY` clamps a downward ray to
   * zero — a real fix for a real NaN (exp of a big positive number), and the
   * reason the height fog does almost nothing in a top-down game: with the ray
   * flattened, the whole integral collapses to the density AT THE CAMERA, and
   * an RTS camera sits 30-110 m above the layer where that density is ~0.
   *
   * The integral is symmetric in its endpoints, so there is no need to clamp
   * anything: evaluate it from the LOWER of camera and fragment and the
   * exponent is never positive, whichever way the ray points. Same closed
   * form, same cost, and it works looking straight down.
   *
   *   tau = density · e^(-falloff·(yLow - h)) · dist · (1 - e^-k)/k,  k = falloff·dy
   *
   * On top of that, the two things that make jungle mist read as air rather
   * than grey paint: it lies in SHEETS (triNoise3D squashed in Y, so the wisps
   * stratify instead of clumping), and it GLOWS toward the sun, which is the
   * whole Apocalypse Now look — backlit haze with the hills as flat cutouts.
   */
  const _monLowY = min(cameraPosition.y, positionWorld.y);
  const _monDy = max(cameraPosition.y, positionWorld.y).sub(_monLowY);
  const _monK = uMonFalloff.mul(_monDy);
  const _monG = select(
    _monK.lessThan(1e-4),
    float(1),
    _monK.negate().exp().oneMinus().div(_monK.max(1e-4)),
  );
  // e^(-falloff·(yLow - h)); yLow below the layer height makes this > 1, which
  // is correct (denser down there) and is the one term that can still run away,
  // so it keeps the same min(50) guard the analytic mode uses.
  const _monBase = uMonFalloff.mul(uMonHeight.sub(_monLowY)).min(50).exp();
  // Sheets: Y scaled up so the noise stratifies into layers rather than blobs.
  const _monWisp = triNoise3D(
    vec3(positionWorld.x, positionWorld.y.mul(4.0), positionWorld.z).mul(uMonStrataScale),
    float(0.15),
    uValleyTime,
  );
  const _monStrataMul = float(1).add(_monWisp.sub(0.5).mul(uMonStrata).mul(2));
  const _monTau = uMonDensity.mul(_monBase).mul(_hfDist).mul(_monG).mul(max(_monStrataMul, 0));
  const _monsoonFactorRaw = _monTau.negate().min(50).exp().oneMinus();

  const _hFactorRaw = select(
    uHFogMode.greaterThan(1.5), _monsoonFactorRaw,
    select(uHFogMode.greaterThan(0.5), _valleyFactorRaw, _analyticFactorRaw),
  );
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
  // Monsoon carries its OWN sun tint, so backlit haze works with distance fog
  // off. Toward the sun the mist glows; away from it, it keeps its own colour.
  const _monSunAmt = clamp(dot(_fogView, uDFogSunDir), 0, 1);
  const _monsoonColor = mix(
    uHFogColor,
    uMonSunTint,
    pow(_monSunAmt, uMonTintPow).mul(uMonSunStrength),
  );
  const _hFogColorEff = select(uHFogMode.greaterThan(1.5), _monsoonColor, uHFogColor);
  const _weatherFogColor = mix(_hFogColorEff, _distFogColor, _dFactor.div(_weatherW));
  const _blendedFogColor = mix(
    _weatherFogColor,
    interiorNodes.uColor,
    clamp(_iFactor.div(_combinedFactor.add(0.0001)), 0, 1),
  );
  scene.fogNode = fog(_blendedFogColor, _combinedFactor);

  function syncFog() {
    uHFogEnabled.value = F.height.enabled ? 1 : 0;
    uHFogMode.value = F.height.mode === "monsoon" ? 2 : F.height.mode === "valley" ? 1 : 0;
    uMonDensity.value = F.height.monDensity ?? 0.02;
    uMonFalloff.value = F.height.monFalloff ?? 0.045;
    uMonHeight.value = F.height.monHeight ?? 12;
    uMonStrata.value = F.height.monStrata ?? 0.45;
    uMonStrataScale.value = F.height.monStrataScale ?? 0.02;
    uMonSunTint.value.set(F.height.monSunTint ?? "#ffcf9a");
    uMonSunStrength.value = F.height.monSunStrength ?? 0.75;
    uMonTintPow.value = F.height.monTintPow ?? 3.0;
    uHFogColor.value.set(F.height.color);
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
    uDFogColor.value.set(F.distance.color);
    uDFogDensity.value = F.distance.density;
  }

  function driveFogSun() {
    const D = toolState.fog.distance;
    const sunUp = sunDir.y;
    uDFogSunDir.value.copy(sunDir);
    uDFogSunTint.value.set(D.sunTint);
    uDFogTintPow.value = D.tintPow ?? 2.0;
    uDFogSunStrength.value = THREE.MathUtils.clamp((sunUp + 0.1) / 0.15, 0, 1);
    if (D.matchSky && toolState.skyMode === "atmosphere" && _atmoColors) {
      // Same job as the procedural branch below — distant geometry dissolves into the
      // horizon BEHIND it — but read off the dome that is actually drawing that horizon.
      uDFogColor.value.copy(_atmoColors.horizon);
    } else if (D.matchSky && toolState.skyMode === "procedural") {
      const ps = toolState.proceduralSky;
      const dayF = THREE.MathUtils.clamp((sunUp + 0.15) / 0.4, 0, 1);
      /*
       * THE WORST OF THE EIGHT — a THIRD pass of the curve, not a second.
       *
       * `.set()` has already linearised both horizon colours, and the lerp below is a
       * blend of two LINEAR colours, which is the correct space to blend them in. The
       * `.convertSRGBToLinear()` that used to close this line therefore converted an
       * already-doubly-converted colour again.
       *
       * `matchSky` exists so distant geometry dissolves into the horizon behind it.
       * The sky reads `horizonDay` correctly (dayNightSky.js), the fog read it three
       * times over, so the two could never meet however the dials were set.
       */
      _fogAwayColor.set(ps.horizonDay);
      _fogAwayNight.set(ps.horizonNight);
      _fogAwayColor.lerp(_fogAwayNight, 1 - dayF);
      uDFogColor.value.copy(_fogAwayColor);
    } else {
      uDFogColor.value.set(D.color);
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

  /*
   * ── THE SECOND DOME: "atmosphere" sky mode ────────────────────────────────
   *
   * v3/render/sky/atmosphereSkyDome.js, on v3/render/sky/skyAtmosphere.js. It came out of
   * the racing game (where it is the boot default) so the editor and every game share one
   * sky; it is a fourth MODE rather than a replacement because the point is to judge it
   * against the other three in a real world. Nothing is deleted until that comparison is
   * made — see v3/AUDIT.md, "Sky".
   *
   * BUILT LAZILY. Three LUT bakes plus a large shader is ~0.7 s of one-off compile, and
   * nobody who never picks this mode should pay it at editor boot. The cost lands on the
   * frame you switch to it, once per session.
   */
  let atmoSky = null;   // createAtmosphereSky()
  let atmoModel = null; // createSkyAtmosphere() — the Hillaire LUT chain it draws with
  /*
   * ── AND ITS CLOUDS ────────────────────────────────────────────────────────
   *
   * This mode brings the racing game's two cloud decks with it, because a sky and the
   * clouds under it are one look, not two features: `cloudSkyLight` derives the deck's key
   * light, its ambient and its aerial target from the SAME atmosphere the dome is drawn
   * with, so they track the day cycle together. The editor's own `dayNightCloudLayer` is a
   * different deck (base 1900 m vs 260 m) and stays with the Procedural mode.
   *
   * `atmoPainted` is built BEFORE the dome and handed in, because whether it exists is a
   * shader difference — see `cloudTier`.
   */
  let atmoClouds = null;   // createModularRoadClouds() — the marched deck
  let atmoPainted = null;  // createPaintedClouds() — the cheap tier, compiled into the dome
  const atmoCloudLight = createCloudSkyLight();
  /*
   * ── AND THE WORLD IT LIGHTS ───────────────────────────────────────────────
   *
   * Without this the editor draws the game's sky over a world lit by static defaults, and
   * it reads visibly darker and flatter than the same sky in the game. Measured side by
   * side at the same moment: exposure 0.70 vs 0.997, env 0.20 vs 0.447, sun 2.2 vs 2.577,
   * ambient 0.4 vs 0.595 — every game value a computed fraction, every editor value a
   * round default, which is the tell that one end was being driven and the other was not.
   *
   * The reference is the racing game's, and the game wrote down why: the editor's own
   * 0.2 env / 0.4 hemi is "why the scene reads dark — almost nothing fills the shadows".
   * Held per-MODE rather than written into toolState.light, so choosing this sky cannot
   * quietly relight the other three modes or a project saved under them.
   */
  const atmoWorldLight = createSkyWorldLight();
  const atmoLightRef = { ...WORLD_LIGHT_REFERENCE };
  /** toolState.light values from before this mode took the lights over. */
  let _atmoLightSaved = null;
  /** The tuned flare look is applied once, the first time this mode is entered. */
  let _atmoFlareApplied = false;
  /** The tier the current dome+deck pair was BUILT for; a change means a rebuild. */
  let _atmoBuiltTier = null;

  function isDomeMode(mode) {
    return mode === "procedural" || mode === "atmosphere";
  }

  function ensureAtmosphereSky() {
    const tier = toolState.atmosphereSky.cloudTier ?? "volumetric";
    if (atmoSky && _atmoBuiltTier === tier) return atmoSky;
    // A tier change across the painted boundary is a REBUILD, not a uniform — see below.
    if (atmoSky) disposeAtmosphereSky();
    try {
      atmoModel = createSkyAtmosphere({ renderer });
      /*
       * The painted deck goes IN to the dome; the volumetric one draws itself and is
       * composited separately (see renderFrame). Handing `null` when the tier is not
       * "painted" leaves the painted fetches out of the compiled dome entirely, so a tier
       * that is not being used costs nothing per sky pixel — which is the one thing a
       * performance fallback must never get wrong.
       */
      if (tier === "painted") {
        atmoPainted = createPaintedClouds({
          params: toolState.atmospherePaintedClouds,
          camera,
        });
      }
      atmoSky = createAtmosphereSky({
        atmosphere: atmoModel,
        paintedClouds: atmoPainted,
        params: toolState.atmosphereSky,
      });
      atmoSky.mesh.visible = false;
      scene.add(atmoSky.mesh);

      if (tier === "volumetric") {
        atmoClouds = createModularRoadClouds({
          renderer, scene, camera,
          params: toolState.atmosphereClouds,
        });
        // The deck does NOT parent its own mesh — it hands one back and the caller places
        // it (the game does the same). It lives on LAYERS.GAME_CLOUDS, so the main scene
        // pass skips it and the deck marches it alone.
        scene.add(atmoClouds.mesh);
      }
      _atmoBuiltTier = tier;
    } catch (err) {
      console.warn("[V3] Atmosphere sky failed to init; staying on the current sky.", err);
      disposeAtmosphereSky();
    }
    return atmoSky;
  }

  /**
   * Tear the whole pair down. `dispose()` on the dome frees its geometry and material but
   * does NOT unparent the mesh, so dropping the reference without removing it leaves a
   * dead dome in scene.children on every tier switch.
   */
  function disposeAtmosphereSky() {
    if (atmoSky) {
      scene.remove(atmoSky.mesh);
      atmoSky.dispose?.();
    }
    atmoSky = null;
    // Three render targets and three materials — dropping the reference leaks all six.
    atmoModel?.dispose?.();
    atmoModel = null;
    if (atmoClouds) {
      scene.remove(atmoClouds.mesh); // dispose frees buffers, it does not unparent
      atmoClouds.dispose?.();
    }
    atmoClouds = null;
    atmoPainted?.dispose?.();
    atmoPainted = null;
    _atmoBuiltTier = null;
    _atmoColors = null;
  }

  /** Switch cloud tier. Rebuilds, because the painted deck is compiled into the dome. */
  function setAtmosphereCloudTier(tier) {
    if (!["volumetric", "painted", "off"].includes(tier)) return;
    /*
     * NO "has it changed?" GUARD AGAINST toolState.
     *
     * The panel's dropdown is BOUND to `atmosphereSky.cloudTier` — it writes the new value
     * into the object and THEN calls this. Comparing the argument against that field
     * therefore always found them equal and returned without doing anything, so the tier
     * silently never switched. `_atmoBuiltTier` (what the current dome+deck pair was
     * actually built for) is the only honest thing to compare against, and
     * ensureAtmosphereSky already does exactly that.
     */
    toolState.atmosphereSky.cloudTier = tier;
    if (toolState.skyMode !== "atmosphere") return; // built lazily on the next switch in
    if (_atmoBuiltTier === tier) return;
    ensureAtmosphereSky();
    if (atmoSky) {
      atmoSky.mesh.visible = _skyShown;
      driveAtmosphereSky(0);
    }
    resetProcEnvRig();
  }

  /**
   * Per-frame drive for the atmosphere dome. Time of day comes from `proceduralSky`, not
   * from this dome's own `timeOfDay`: the hour is one world fact, so switching modes must
   * not teleport the sun. `setTimeOfDay` on the dome only writes its params — the SUN
   * itself is still placed by the engine's `setTimeOfDay`/`updateSunSky`, so shadows,
   * CSM and the sun disc keep agreeing.
   */
  function driveAtmosphereSky(dtSec) {
    if (!atmoSky) return;
    const A = toolState.atmosphereSky;
    const ps = toolState.proceduralSky;
    /*
     * THE LIGHT IS THE SUN — the dome does NOT get to derive its own.
     *
     * Standalone, this dome computes the sun from its own clock. In the editor that is
     * the wrong master: the sun is the directional light, placed from
     * `light.sunAzimuth/sunElevation`, and time of day is only ONE of the things that
     * writes those — dragging the sun sliders moves the light and never touches the
     * clock. dayNightSky has always been handed `sunDir` for exactly this reason.
     *
     * Getting this wrong is not subtle: measured on a default editor, the clock sat at
     * 21.27 while the light was at +12° elevation, so the dome painted a night sky over
     * a world lit for midday. The moon is `_skyMoonDir`, the same realistic moon the
     * other dome is given, not the `_moonDir` antipode the clouds use.
     *
     * The mirrored params below still matter for everything the direction does not carry:
     * `autoAdvance` OFF so the engine's clock is the only one advancing the hour, and the
     * observer numbers so the dome's own moon maths agrees if it ever falls back to them.
     */
    A.timeOfDay = ps.timeOfDay;
    A.latitude = ps.latitude;
    A.dayOfYear = ps.dayOfYear;
    A.moonAge = ps.moonAge;
    A.autoAdvance = false;
    /*
     * PUSH THE PANEL'S VALUES IN. `createAtmosphereSky` does `{ ...SKY_DEFAULTS, ...params }`
     * — it COPIES the params object rather than holding it, which is right for a game that
     * configures its sky once at build time and wrong for an editor, where every slider
     * writes to `toolState.atmosphereSky` and would otherwise move nothing at all.
     *
     * Safe to assign wholesale: the only keys the dome writes back are `sunElevation` /
     * `sunAzimuth` (not in this slice, so never clobbered) and `sunDiscCos`, which is
     * re-derived from `sunSizeDeg` inside the same update a few lines later.
     */
    Object.assign(atmoSky.params, A);
    computeMoonDir(_skyMoonDir);
    const look = atmoSky.update({
      dt: dtSec,
      camera,
      sunDir,          // the light's direction, not the dome's own clock
      moonDir: _skyMoonDir,
    });
    /*
     * BAKE THE LUTS. Without this line the sky is BLACK — and not obviously as a
     * bake failure, because every other part of the dome (stars, moon, the authored
     * gradient underneath) still draws correctly.
     *
     * `skyRadiance` is a sampler read of the sky-view render target, and nothing else
     * ever renders into it. The dome does not bake it: the atmosphere is handed IN, so
     * whoever owns it owns its clock. The game does this on its own line for the same
     * reason. The atmosphere also wants the camera ALTITUDE, because half the point of
     * a physical sky is that it changes as you climb.
     *
     * Cheap by design: it re-bakes only when the sun, the moon or the height actually
     * moved, so a frozen time of day costs nothing per frame.
     */
    if (look) {
      atmoModel?.update(look.sunDir, Math.max(0, camera.position.y), look.moonDir);
    }

    /*
     * ── THE CLOUDS UNDER THIS SKY ─────────────────────────────────────────────
     *
     * Everything the deck is lit by comes out of the same atmosphere the dome is drawn
     * with: the key light is the real slant-path transmittance to the deck's altitude
     * (warm white at noon, ember at 2°, the moon once the sun is truly down), ambient is
     * the sky's own zenith and horizon, and distant clouds fade toward the horizon they
     * sit on. That derivation is shared with the game — see cloudSkyLight.js, and do not
     * re-derive any of it here.
     */
    if (atmoClouds?.enabled) {
      atmoCloudLight.params.skyTint = A.cloudSkyTint ?? 0.6;
      const mid = (atmoClouds.params.base ?? 260) + (atmoClouds.params.thickness ?? 620) * 0.5;
      atmoCloudLight.sync(A, camera.position.y, mid);
      // The caller owns the sun; `sync` only takes the slot over once the sun is down,
      // because the march has exactly one directional light and the swap has to happen
      // together with the colour that goes with it.
      if (atmoCloudLight.usingMoon()) atmoCloudLight.frame.sunDir.copy(atmoCloudLight.moonDir);
      else atmoCloudLight.frame.sunDir.copy(sunDir);
      atmoClouds.update(dtSec, atmoCloudLight.frame);
    }

    /*
     * ── AND THE WORLD UNDER IT ────────────────────────────────────────────────
     *
     * Key colour from the sun's own transmittance, ambient from the sky's zenith and
     * haze, exposure and env strength on the sky's daylight curve, the moon as a real key
     * light at night. Key-cached on solar elevation, so with a frozen clock this computes
     * once and returns null forever.
     */
    if (atmoWorldLight.params.enabled && _atmoColors && look) {
      const lit = atmoWorldLight.compute(look, _atmoColors, atmoLightRef, camera.position.y);
      if (lit) {
        const Li = toolState.light;
        if (!_atmoLightSaved) {
          // Snapshot once, so leaving the mode gives the world back exactly as it was.
          _atmoLightSaved = {
            dirColor: Li.dirColor, dirIntensity: Li.dirIntensity,
            hemiSkyColor: Li.hemiSkyColor, hemiGroundColor: Li.hemiGroundColor,
            hemiIntensity: Li.hemiIntensity, exposure: Li.exposure,
            moonIntensity: Li.moonIntensity, envIntensity: Li.envIntensity,
          };
        }
        // Encoded back to sRGB hex: the engine consumes these as authored strings and
        // decodes them, so handing over linear values would land 5-10x too dark.
        Li.dirColor = atmoWorldLight.toHex(lit.dirColor);
        Li.dirIntensity = lit.dirIntensity;
        Li.hemiSkyColor = atmoWorldLight.toHex(lit.hemiSkyColor);
        Li.hemiGroundColor = atmoWorldLight.toHex(lit.hemiGroundColor);
        Li.hemiIntensity = lit.hemiIntensity;
        Li.exposure = lit.exposure;
        Li.moonIntensity = lit.moonIntensity;
        Li.envIntensity = lit.envIntensity;
        updateSunSky();
        _procEnvNeeds = true; // the sky moved, so the IBL has to follow
      }
    }

    /*
     * ── AND THE FLARE ─────────────────────────────────────────────────────────
     *
     * Two couplings, both per-frame and both cheap:
     *
     * SIZE follows the sky's own sun. The flare was authored against `sunSizeDeg` 3.4 and
     * is otherwise sized purely in screen fractions, so dialling the sun up left its
     * halation and starburst behind and the two stopped reading as the same object. Only
     * the parts that are an IMAGE OF THE SOURCE follow this — ghosts and halo are images
     * of the LENS and keep their own size (see setSourceScale).
     *
     * COLOUR is the sky's, not a constant, so the flare goes deep orange at sunset instead
     * of staying noon-warm all day. `look.sunColor` is the sun through the current air
     * mass and is ALREADY LINEAR (the dome builds it with toLinearHex), so it goes
     * straight across — converting it again is the 5-10x error that stays self-consistent
     * and therefore hides. It is shared scratch inside the dome, so the flare copies it.
     */
    if (look && toolState.lensFlare.enabled) {
      const size = A.sunSizeDeg;
      if (size) {
        // Fed to BOTH, so the dev-panel A/B between the two flares never leaves one
        // holding a stale sun size.
        lensFlareLegacy.setSourceScale?.(size / 3.4);
        lensFlareNext.setSourceScale?.(size / 3.4);
      }
      // Only the analytic flare has a notion of a live source colour.
      if (look.sunColor) lensFlareNext.setSourceColor?.(look.sunColor);
    }
    /*
     * Blend the look's three altitude bands into scratch, ONCE, for the fog, the cloud
     * deck and the ocean below. Each of those used to read `proceduralSky`'s authored
     * day/night colour PAIRS, which this dome does not have — its look is a function of
     * the hour, not a pair to lerp.
     *
     * Deliberately not `atmoSky.getColors()`, which is the same arithmetic but re-runs
     * `evaluateSky` — the full authored-look blend that `update()` just finished — and
     * allocates about twenty Colors doing it. Per frame, for three consumers, that is a
     * second evaluation and a steady stream of garbage for nothing. The band weights are
     * exported and allocation-free, and the look is right here.
     */
    if (look) {
      const b = skyBandWeights(camera.position.y, A);
      _atmoZenith.copy(look.zenithBelow).multiplyScalar(b.below)
        .add(_atmoScratch.copy(look.zenithInside).multiplyScalar(b.inside))
        .add(_atmoScratch.copy(look.zenithAbove).multiplyScalar(b.above));
      _atmoHorizon.copy(look.horizonBelow).multiplyScalar(b.below)
        .add(_atmoScratch.copy(look.horizonInside).multiplyScalar(b.inside))
        .add(_atmoScratch.copy(look.horizonAbove).multiplyScalar(b.above));
      _atmoSunColor.copy(look.sunColor);
      _atmoColors = _atmoColorsRef;
    }
  }

  let pmremGenerator = null;
  let disposeSkyEnv = null;
  let disposeHdrEnv = null;
  let hdrTexture = null;
  /** What a project saves for the imported HDR: "asset:<hash>" (kept in the project). */
  let hdrRef = null;

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

  /**
   * The sky the IBL is baked from: a game's registered one wins, otherwise whichever of
   * the engine's two domes the sky mode is showing. Without the atmosphere branch the
   * world would be lit and reflected by the procedural dome while a different sky is
   * drawn overhead — the exact two-skies-in-one-frame bug setCustomEnvSky exists to stop,
   * and it shows first on wet and metallic surfaces.
   */
  function activeEnvSky() {
    if (customEnvSky) return customEnvSky;
    if (toolState.skyMode === "atmosphere" && atmoSky) return atmoSky;
    return dayNightSky;
  }

  /**
   * Drop the capture rig so it is rebuilt around whatever dome is current, and ask for an
   * immediate re-bake. Shared by setCustomEnvSky and by switching between the two dome
   * modes — the rig holds a CLONE of the dome mesh, so without this the environment keeps
   * showing the previous sky until something else happens to invalidate it.
   */
  function resetProcEnvRig() {
    _procEnvScene = null;
    if (_procCubeRT) { _procCubeRT.dispose(); _procCubeRT = null; }
    _procCubeCam = null;
    _procEnvFace = -1;
    _procEnvIdle = 0;
    _procEnvNeeds = true;
  }

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
    const envSkyMesh = activeEnvSky().mesh;
    const domeClone = envSkyMesh.clone();
    domeClone.visible = true;
    domeClone.position.set(0, 0, 0);
    _procEnvScene.add(domeClone);
    _procCubeRT = new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType });
    _procCubeCam = new THREE.CubeCamera(0.1, 20000, _procCubeRT);
    /*
     * ORIENT THE FACES. three only aims a CubeCamera's six cameras inside
     * `update()` (which picks the renderer's coordinate system first), and the
     * faces here are rendered one per frame straight through `children[face]`,
     * so `update()` never runs. Until 2026-09-15 all six cameras looked down −Z:
     * every face of the environment was the same view toward −Z, the zenith of
     * the IBL was a picture of the horizon, and wherever two faces met — at
     * each 45° azimuth — reflections jumped. The sea showed it as a lighter
     * rectangle on the horizon; everything else lit by the environment was
     * just quietly wrong.
     */
    _procCubeCam.coordinateSystem = renderer.coordinateSystem;
    _procCubeCam.updateCoordinateSystem();
    _procCubeCam.updateMatrixWorld(true);
    pmremGenerator = pmremGenerator ?? new THREE.PMREMGenerator(renderer);
  }

  function renderProcEnvFace(face) {
    ensureProcEnvRig();
    const prev = renderer.getRenderTarget();
    // Sun disc OUT of the IBL: its energy already reaches surfaces via the
    // directional light — capturing it in the env map counted it twice (lifted
    // ambient + a phantom specular sun). The aureole/glow stays in.
    const envSky = activeEnvSky();
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
    resetProcEnvRig();
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
      // Drive the dome the rig is about to clone. Driving the other one would bake the
      // environment from a dome still holding last frame's sun.
      if (toolState.skyMode === "atmosphere") driveAtmosphereSky(0);
      else driveProceduralSky();
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

  /*
   * A game with its own sky hides the engine's (setSkyVisible(false)) instead
   * of finding the dome meshes by name. Every sky-mode change goes through
   * syncSkyVisibility, so switching modes never brings a hidden sky back.
   * Lighting, IBL and time of day keep running; point the IBL at the game's
   * sky with setCustomEnvSky.
   */
  let _skyShown = true;
  function syncSkyVisibility() {
    const mode = toolState.skyMode;
    sky.visible = _skyShown && mode === "physical";
    dayNightSky.mesh.visible = _skyShown && mode === "procedural";
    if (atmoSky) atmoSky.mesh.visible = _skyShown && mode === "atmosphere";
    /*
     * Belt and braces. The deck sits on LAYERS.GAME_CLOUDS (19) and the main camera only
     * renders layer 0, so it cannot draw in another mode anyway — but its `update()` is
     * the only thing that writes `mesh.visible`, and that stops running the moment the
     * mode changes, which would leave a stale `true` for anyone who later points a camera
     * with that layer enabled at the scene.
     */
    if (atmoClouds) atmoClouds.mesh.visible = _skyShown && mode === "atmosphere" && atmoClouds.enabled;
    if (mode === "hdr") scene.background = _skyShown ? hdrTexture ?? null : null;
  }
  function setSkyVisible(on) {
    _skyShown = !!on;
    syncSkyVisibility();
  }

  /**
   * Hand the world's lighting back exactly as it was before the Atmosphere mode took it
   * over. Without this, leaving the mode would strand the other three under whatever the
   * sky happened to be doing at that hour — and a project saved afterwards would carry it.
   */
  function restoreLightFromAtmosphere() {
    if (!_atmoLightSaved) return;
    Object.assign(toolState.light, _atmoLightSaved);
    _atmoLightSaved = null;
    atmoWorldLight.invalidate();
  }

  function applySkyMode(mode, prevMode) {
    const prev = prevMode !== undefined ? prevMode : toolState.skyMode;
    if (prev === "atmosphere" && mode !== "atmosphere") restoreLightFromAtmosphere();
    if (prev !== mode) {
      toolState.skyExposureByMode[prev] = toolState.light.exposure;
      /*
       * The Atmosphere sky owns its own exposure — skyWorldLight writes it every time the
       * sun moves, off the reference (1.0, the racing game's). Seeding it from the
       * per-mode memory here would be overwritten a frame later anyway, and 0.7 (which
       * this mode inherited from Procedural) is most of why it first read dark.
       */
      const nextExposure = mode === "atmosphere"
        ? atmoLightRef.exposure
        : toolState.skyExposureByMode[mode] ?? (isDomeMode(mode) ? 0.7 : 0.5);
      if (toolState.light.exposure !== nextExposure) {
        toolState.light.exposure = nextExposure;
      }
    }
    toolState.skyMode = mode;
    dayNightSky.mesh.visible = mode === "procedural";
    if (atmoSky) atmoSky.mesh.visible = mode === "atmosphere";
    // Moving between the two domes changes which mesh the IBL rig holds a clone of.
    if (isDomeMode(mode) && isDomeMode(prev) && mode !== prev) resetProcEnvRig();
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
    } else if (isDomeMode(mode)) {
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
      /*
       * The ~0.7 s build lands HERE, on the switch, rather than at editor boot — three LUT
       * bakes and a large shader. If it throws, ensureAtmosphereSky has already warned and
       * left atmoSky null; falling through to the procedural dome's rebuild keeps the
       * world lit by a sky that exists instead of going black.
       */
      if (mode === "atmosphere") {
        /*
         * THE FLARE'S LOOK, ONCE. The editor's flare defaults (intensity 3, halation 3,
         * ghosts 2) blow the frame to white next to a physically-scattered sun; this is
         * the look tuned against that sun. Applied the first time the mode is entered and
         * never again, so anything dialled afterwards stays dialled — and the flare is
         * left OFF unless the user turned it on, because arriving in a new sky mode is no
         * reason to switch an effect on for them.
         */
        if (!_atmoFlareApplied) {
          _atmoFlareApplied = true;
          const wasEnabled = toolState.lensFlare.enabled;
          mergeKnownKeys(toolState.lensFlare, SKY_LENS_FLARE_LOOK);
          toolState.lensFlare.enabled = wasEnabled;
          syncFlareChoice();
        }
        ensureAtmosphereSky();
        if (atmoSky) {
          atmoSky.mesh.visible = _skyShown;
          driveAtmosphereSky(0);
        }
      }
      rebuildProceduralSkyEnv();
    }
    syncSkyVisibility();
    updateSunSky();
  }

  function importHdr() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".hdr";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const ref = await projectAssets.addRef(file);
      await _loadHdrTexture(projectAssets.resolveUrl(ref));
      hdrRef = ref;
      applySkyMode("hdr");
    };
    input.click();
  }

  function _loadHdrTexture(url) {
    return new Promise((resolve, reject) => {
      new HDRLoader().load(url, (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        if (hdrTexture) hdrTexture.dispose();
        hdrTexture = tex;
        resolve();
      }, undefined, reject);
    });
  }

  /*
   * ── THE WORLD LOOK IN A PROJECT ──────────────────────────────────────────
   *
   * Sky mode and everything that shapes what the sky and light look like:
   * sun, exposure, both skies' params (time of day lives in proceduralSky),
   * clouds, fog, lens flare, Post FX, and interior lighting (how dark tunnels
   * and caves get — part of the level's look). NOT saved: shadow quality (CSM),
   * render scale, audio — those are machine or game settings (a game sets CSM
   * at boot: startV3App({ csm })).
   *
   * The load merges per key, only for keys this build still has, so an older
   * file keeps today's default for a param added later, and a retired param
   * is ignored (same contract as the ocean and lakes).
   */
  const LOOK_SLICES = [
    "light", "skyExposureByMode", "physicalSky", "proceduralSky", "atmosphereSky",
    "atmosphereClouds", "atmospherePaintedClouds",
    "volumetricCloudDayNight", "cloudShadows", "cloudGodRays", "cloudBloom",
    "lensFlare", "postFx", "fog", "interior",
  ];
  const SKY_MODES = ["physical", "hdr", "procedural", "atmosphere"];

  function exportLook() {
    const look = { skyMode: toolState.skyMode, hdr: hdrRef };
    for (const key of LOOK_SLICES) look[key] = structuredClone(toolState[key]);
    return look;
  }

  async function importLook(look) {
    if (!look) return;
    for (const key of LOOK_SLICES) {
      if (look[key] && toolState[key]) mergeKnownKeys(toolState[key], look[key]);
    }
    let mode = SKY_MODES.includes(look.skyMode) ? look.skyMode : toolState.skyMode;
    if (mode === "hdr") {
      const url = look.hdr ? projectAssets.resolveUrl(look.hdr) : null;
      try {
        if (!url) throw new Error("no HDR file in this project");
        await _loadHdrTexture(url);
        hdrRef = look.hdr;
      } catch (err) {
        console.warn("[V3] Project sky is an HDR that could not be restored; using the procedural sky.", err);
        mode = "procedural";
      }
    }
    // Same mode as prev: no exposure swap, the saved exposure stays as saved.
    applySkyMode(mode, mode);
    if (isDomeMode(mode)) setTimeOfDay(toolState.proceduralSky.timeOfDay);
    syncFog();
    driveFogSun();
    applyPostFxState();
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
    // The terrain's own shadow marches toward whichever light is lighting the
    // scene — the moon at night, like the cascades.
    setTerrainSunDirection(_effectiveLightDir);
  }

  function updateSunSky() {
    const Li = toolState.light;
    sunDirectionFromAngles(Li.sunAzimuth, Li.sunElevation, sunDir);
    const sunUp = sunDir.y;
    if (isDomeMode(toolState.skyMode) && sunUp < 0) {
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
      const sunFade = isDomeMode(toolState.skyMode)
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

  /*
   * TWO FLARES, ONE PARAMS OBJECT.
   *
   * `lensFlare2` is the analytic rewrite (v2/effects/lensFlare2.js): 4 draw calls instead
   * of 16, every shape computed rather than baked into an 8-bit canvas, and the bright
   * parts routed into the emissive MRT so the flare actually blooms alongside the sun disc
   * it sits on. The original is kept, running off the SAME params object, so the two can be
   * A/B'd in the running game rather than in a lab — which is the only place a look change
   * has ever actually been judged here.
   *
   * Only one of them updates per frame; the other is parked invisible, so the loser costs
   * nothing but its (tiny) construction.
   */
  const lensFlareLegacy = createLensFlareSystem({
    scene,
    camera,
    getSunDir: () => sunDir,
    getParams: () => toolState.lensFlare,
  });
  const lensFlareNext = createLensFlare2({
    scene,
    camera,
    getSunDir: () => sunDir,
    getParams: () => toolState.lensFlare,
    /* Injected rather than imported inside the effect: v2 never reaches up into v3, and a
     * caller with no selective bloom simply passes nothing. */
    bloomMRT: applyBloomMRT,
  });
  /* Parked from birth. Its quads default to intensity 1 at the origin, so an un-updated
   * legacy group would paint a full-strength flare over frame 0. */
  lensFlareLegacy.group.visible = false;
  /** Which one is live. `toolState.lensFlare.legacy` flips it; default is the new one. */
  let lensFlare = lensFlareNext;
  function syncFlareChoice() {
    const wantLegacy = !!toolState.lensFlare.legacy;
    const want = wantLegacy ? lensFlareLegacy : lensFlareNext;
    if (want === lensFlare) return;
    lensFlare.group.visible = false;
    lensFlare = want;
  }

  /*
   * THE FIRST applySkyMode RUNS HERE, below the flares, not up beside updateSunSky().
   *
   * Applying a dome mode drives the sky once so the world is not lit by nothing on frame
   * 0, and that drive touches the flare (size from the sun's angular size, colour from the
   * sun through the current air mass). While the editor booted into another mode the
   * atmosphere branch short-circuited and the order never mattered; the day the atmosphere
   * sky became the DEFAULT, running before `lensFlareNext` existed was a temporal-dead-zone
   * ReferenceError and the editor failed to start. Nothing between there and here depends
   * on the sky mode having been applied.
   */
  applySkyMode(toolState.skyMode);

  /*
   * PUT THE SUN WHERE THE CLOCK SAYS, ONCE, AT BOOT.
   *
   * The hour and the sun's angles are two independent pieces of state: `setTimeOfDay`
   * writes the angles FROM the hour, but nothing called it at startup, so a fresh editor
   * booted with a clock reading 10.5 and a light sitting at the v2 default 43° / 135° —
   * which is 10.5 h nowhere on Earth (at latitude 45 on day 172 it is 61.6°). Nobody
   * noticed while the domes were driven purely by the light, because their LOOK never
   * consulted the clock. The atmosphere dome's dawn-vs-dusk bias does, and the racing
   * game has always done this on its own boot line, so the two disagreed on what hour it
   * was even when they agreed on the number.
   *
   * ONCE, and only for a dome mode: doing it inside `applySkyMode` would throw away
   * hand-placed sun angles every time the mode changed, and a loaded project already
   * reconciles the same way at the end of `importLook`.
   */
  if (isDomeMode(toolState.skyMode)) setTimeOfDay(toolState.proceduralSky.timeOfDay);

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

  /*
   * ── THE SECOND OCEAN ──────────────────────────────────────────────────────
   *
   * `worldOcean.mode === "v2"` draws oceanSurface.js instead. The old one above
   * is untouched and stays the default; nothing here runs unless the switch is
   * thrown.
   *
   * LAZY, and only one of them ever visible. Each ocean owns a GPU FFT
   * simulation and a clipmap, so building both up front would double that for a
   * session that never asks. A game (rts-v3, modular-road) picks its mode at
   * boot and pays for exactly one.
   *
   * The v2 ocean also wants a CPU heightmap to bake its shoreline distance field
   * from, which lives in main.js — hence `setOceanHeights` below rather than a
   * constructor argument. Until it is called the field is flat, which reads as
   * open water with no land: correct, just not yet the terrain.
   */
  let oceanV2 = null;
  let _oceanHeights = null;
  let _oceanNormalMap = null;
  /** Sea level the shore field was last baked at; null = nothing baked yet. */
  let _shoreBakedLevel = null;
  let _shoreBakeTimer  = 0;
  /** Shore-field resolution: match the heightmap it is derived from. */
  const oceanV2FieldRes = HEIGHTMAP_SIZE;

  function waterNormalMapForOcean() {
    if (!_oceanNormalMap) {
      _oceanNormalMap = new THREE.TextureLoader().load("/textures/waterNormal.webp");
      _oceanNormalMap.wrapS = _oceanNormalMap.wrapT = THREE.RepeatWrapping;
      _oceanNormalMap.colorSpace = THREE.NoColorSpace;
      _oceanNormalMap.anisotropy = 8;
    }
    return _oceanNormalMap;
  }

  /*
   * Only the sea LEVEL is shared with the classic ocean — it is where the world's
   * water is, whichever shader draws it. Everything else V2 reads from its own
   * bag, so tuning one ocean never moves the other. (Wind, swell, choppiness,
   * sim rate and the mesh used to be forwarded from the top level; projects
   * saved before the split are migrated on load — see main.js importData.)
   */
  function oceanV2Params() {
    const o = toolState.worldOcean;
    const out = { ...(o.v2 ?? {}) };
    if (o.seaLevel !== undefined) out.seaLevel = o.seaLevel;
    return out;
  }

  /**
   * The shadow node the sea should sample: the live cascades while they are the
   * sun's shadow, otherwise none. Only the CSM path is wired — with cascades off
   * the lighting builds its own private node for the sun, and a second one here
   * would render the sun's shadow map a second time.
   */
  function oceanShadowNode() {
    return csm && toolState.csm.enabled && sun.castShadow && unwrapSunShadow(sun.shadow.shadowNode) === csm
      ? csm : null;
  }

  /** FFT grid the live V2 ocean was BUILT with — it cannot change in place. */
  let _oceanV2FftSize = null;

  function ensureOceanV2() {
    if (oceanV2) return oceanV2;
    const initial = oceanV2Params();
    _oceanV2FftSize = initial.fftSize ?? null;
    oceanV2 = createWorldOceanV2({
      // Build straight into this project's sea state: the spectrum bake is
      // ~200 ms, and building on defaults would pay it twice.
      params: initial,
      lod: initial.fftSize ? { fftSize: initial.fftSize } : {},
      shadowNode: oceanShadowNode(),
      renderer,
      scene,
      heightTexNode,
      terrainSize,
      /*
       * The LIVE terrain scale, not the 500 default. Heightmaps are stored
       * normalised, so this is the number that turns a stored value into
       * metres — and the shore field compares those metres against the sea
       * level to find the waterline. Hard-code it and a project configured to
       * any other max height bakes its coastline in the wrong place: at 1000,
       * every hill reads half as tall, the computed waterline climbs inland,
       * and at the real shore the field reports open water. `foamWanted` never
       * clears its gate, so the entire foam block is skipped and no amount of
       * tuning brings the surf back.
       */
      maxHeight: MAX_HEIGHT,
      heightmapSize: oceanV2FieldRes,
      normalMap: waterNormalMapForOcean(),
      envMap: scene.environment ?? null,
    });
    oceanV2.syncParams(oceanV2Params());
    oceanV2.setSunDir(_effectiveLightDir);
    _shoreBakedLevel = null; // nothing baked into a brand-new field
    rebakeShoreIfStale({ immediate: true });
    return oceanV2;
  }

  /*
   * The shore field is a function of BOTH the terrain and the sea level: it
   * stores signed distance to the WATERLINE, and moving the water moves the
   * line. So a rebake is owed whenever either one changes — not only on a
   * sculpt. Miss the sea-level half and the foam band stays welded to the
   * waterline it was baked at, which on a big move means no foam at all: the
   * field says "deep water everywhere" because that is where the sea used to be.
   *
   * ~100 ms at 1024², and the sea-level slider fires on every pointer move, so
   * the bake is coalesced to the trailing edge of a drag. The old field stays
   * on screen for that moment — the foam lags the water by a beat — which is
   * the cheaper of the two bad options against a 100 ms hitch per pixel of
   * slider travel.
   */
  function rebakeShoreNow() {
    _shoreBakeTimer = 0;
    if (!oceanV2 || !_oceanHeights || toolState.worldOcean.mode !== "v2") return;
    const level = toolState.worldOcean.seaLevel;
    oceanV2.rebakeShore(_oceanHeights, level);
    _shoreBakedLevel = level;
  }

  /** Bake only when the field is actually stale. `immediate` skips the debounce. */
  function rebakeShoreIfStale({ immediate = false } = {}) {
    // Not while the ocean is OFF: a map can keep mode "v2" with the ocean
    // disabled (nam-valley does), and every terrain height sync then paid a
    // ~150 ms bake for water nobody sees — ~11 s of nam-rts's boot, one per
    // building pad. The stamp stays stale; applyOceanMode bakes on enable.
    if (!oceanV2 || !_oceanHeights || toolState.worldOcean.mode !== "v2" || !toolState.worldOcean.enabled) return;
    if (_shoreBakedLevel === toolState.worldOcean.seaLevel) return;
    clearTimeout(_shoreBakeTimer);
    if (immediate) rebakeShoreNow();
    else _shoreBakeTimer = setTimeout(rebakeShoreNow, 150);
  }

  /** Only one ocean visible, and the inactive one fully off (its FFT idles). */
  function applyOceanMode() {
    const o = toolState.worldOcean;
    const wantV2 = o.mode === "v2";
    if (wantV2) ensureOceanV2();
    worldOcean.setEnabled(!wantV2 && !!o.enabled);
    oceanV2?.setEnabled(wantV2 && !!o.enabled);
    // The shore field is skipped while the ocean is off (rebakeShoreIfStale);
    // turning it on is when a stale one has to catch up.
    if (wantV2 && o.enabled) rebakeShoreIfStale({ immediate: true });
  }

  /**
   * Hand the v2 ocean the CPU heightmap so it can bake its shoreline field.
   * ~100 ms at 1024², so main.js calls this on a settled sculpt, never per frame.
   */
  function setOceanHeights(heights) {
    _oceanHeights = heights;
    // New terrain at the SAME sea level is still stale, so drop the stamp
    // rather than letting the level comparison decide there is nothing to do.
    _shoreBakedLevel = null;
    rebakeShoreIfStale({ immediate: true });
  }

  // Depth-buffer water surfaces (LakeSystem, River v2) are owned by main.js but driven
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
    /*
     * UNDER THE ATMOSPHERE DOME, THE DECK IS LIT BY THAT SKY.
     *
     * The lines above blend `proceduralSky`'s authored day/night colour PAIRS, which the
     * atmosphere dome does not have — its look is a function of the hour, run through the
     * same transmittance integral the sky is drawn with. Leaving the deck on the pairs is
     * exactly the bug the racing game fixed: clouds lit by a frozen noon palette at every
     * hour, so a sunset only ever dimmed a noon-white lamp while the sky behind them went
     * gold. `_atmoColors` is this frame's evaluation, computed once in driveAtmosphereSky.
     */
    if (toolState.skyMode === "atmosphere" && _atmoColors) {
      if (sunUp >= 0) _cloudLightColor.copy(_atmoColors.sunColor);
      _cloudAmbColor.copy(_atmoColors.horizon);
    }
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
      skyMesh: activeEnvSky().mesh,
    });
  }

  function worldOceanChanged() {
    worldOcean.syncParams(toolState.worldOcean);
    // The FFT grid size is baked into the simulation and the shader's cascade
    // taps, so a new size means a new ocean. One rebuild per change, not per frame.
    const wantSize = toolState.worldOcean.v2?.fftSize ?? null;
    if (oceanV2 && wantSize !== _oceanV2FftSize) {
      oceanV2.dispose();
      oceanV2 = null;
    }
    oceanV2?.syncParams(oceanV2Params());
    applyOceanMode();
    rebakeShoreIfStale(); // sea level moved ⇒ the waterline moved
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
      oceanV2?.setSunDir(_effectiveLightDir);
    }

    syncFlareChoice();
    lensFlare.update();

    if (toolState.fog.distance.enabled) driveFogSun();

    if (isDomeMode(toolState.skyMode)) {
      const ps = toolState.proceduralSky;
      const procDt = Math.min(dtSec, 0.05);
      /*
       * ONE CLOCK for both domes. The hour lives in `proceduralSky` whichever dome is
       * drawing it, so switching modes does not teleport the sun and a project saves one
       * time of day rather than two that disagree.
       */
      if (ps.autoAdvance) {
        setTimeOfDay((ps.timeOfDay + ps.daySpeed * procDt) % 24);
      }
      let procSnap;
      if (toolState.skyMode === "atmosphere") {
        driveAtmosphereSky(procDt);
        /*
         * The IBL re-bake key. It has to name everything that moves this dome's look or
         * the environment freezes at whatever it baked first — a failure that looks like
         * nothing is wrong until you drag the time of day and the world does not follow.
         */
        const A = toolState.atmosphereSky;
        procSnap = `atmo,${Li.sunAzimuth},${Li.sunElevation},${ps.timeOfDay},${ps.latitude},${ps.dayOfYear},${ps.moonAge},${A.atmosphereMix},${A.cloudBase},${A.cloudThickness},${A.airglow},${A.starBrightness},${A.milkyWay},${A.sunDiscBright},${A.moonDiscBright},${A.horizonPow},${A.horizonGlow},${A.nadirPow},${A.zenithDepth}`;
      } else {
        driveProceduralSky();
        procSnap = `${Li.sunAzimuth},${Li.sunElevation},${ps.scatter},${ps.rayleigh},${ps.mie},${ps.mieG},${ps.sunIntensity},${ps.msAmount},${ps.zenithDay},${ps.horizonDay},${ps.zenithNight},${ps.horizonNight},${ps.sunsetColor},${ps.groundColor},${ps.sunColor},${ps.moonColor},${ps.cloudEnabled},${ps.cloudCoverage},${ps.cloudColor}`;
      }
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
    if (toolState.skyMode === "physical" || isDomeMode(toolState.skyMode)) {
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
    // The sea mirrors the sky it is under — see the cloud deck above for why the authored
    // day/night pairs are the wrong source when the atmosphere dome is the one overhead.
    if (toolState.skyMode === "atmosphere" && _atmoColors) {
      _oceanZenith.copy(_atmoColors.zenith);
      _oceanHorizon.copy(_atmoColors.horizon);
    }
    worldOcean.setSkyColors(_oceanZenith, _oceanHorizon);
    worldOcean.update(dtSec, _appTimeSec, camera);
    if (oceanV2) {
      oceanV2.setSkyColors(_oceanZenith, _oceanHorizon);
      /*
       * Follow the scene's environment map. Pushed every frame rather than
       * hooked at each site that assigns it, because `scene.environment` is
       * replaced from four separate paths (procedural sky bake, procedural
       * cubemap, loaded HDR, and cleared for the flat sky) and any hook would
       * be one `scene.environment = ...` away from going stale. setEnvMap
       * compares identity and returns immediately when nothing moved.
       */
      oceanV2.setEnvMap(scene.environment ?? null);
      // The water under the sea is lit by the same two lights as the world
      // above it — including the moon at night and the interior dimming.
      oceanV2.setLight({
        sunColor: sun.color, sunIntensity: sun.intensity,
        ambientColor: hemi.color, ambientIntensity: hemi.intensity,
      });
      // Identity compare inside; only a shadows on/off toggle recompiles.
      oceanV2.setShadowNode(oceanShadowNode());
      oceanV2.update(dtSec, _appTimeSec, camera);
    }

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

    /*
     * The Atmosphere sky's own marched deck. It goes through exactly the same composite
     * path a game's registered deck does — it IS the same module — but it is the engine's,
     * so it must not shadow a game that registered one of its own: a game's system still
     * wins below. Only reached in that sky mode; every other mode falls through.
     */
    /*
     * BOTH decks come through here, for different reasons. The volumetric one marches
     * itself and composites its colour; the PAINTED one is drawn by the sky dome and
     * registers only to cast its ground shadows and god rays — which is why routing it
     * matters even though you can already see it.
     */
    const deck = atmoClouds ?? atmoPainted;
    if (!customCloudSystem?.enabled && toolState.skyMode === "atmosphere" && deck?.enabled) {
      if (postFxPipeline.isActive()) {
        deck.setDepthSource?.(postFxPipeline.getSceneDepthTexture?.() ?? null);
        postFxPipeline.renderWithClouds(deck, cloudFollowAnchor, dtSec);
        return;
      }
      deck.setDepthSource?.(null);
      if (deck.renderFrame()) return;
    }

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

    /*
     * The editor's OWN deck belongs to the Procedural sky only. The Atmosphere sky brought
     * its own two decks with it (handled above), and they are a different deck entirely —
     * base 260 m and tuned to be flown through, against this one's 1900 m ceiling. Running
     * both would draw two cloud layers at once.
     */
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
          skyMesh: activeEnvSky().mesh,
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

  /**
   * What the cascades currently cover and how sharp each one is — the numbers
   * the World panel prints, and the ones to read before changing `maxFar` or
   * `nearSplit`. Null when there is no CSM. Texel and pixel sizes are metres.
   */
  function describeCsm() {
    if (!csm) return null;
    const far = Math.min(camera.far, csm.maxFar);
    return {
      maxFar: csm.maxFar,
      mapSize: Math.round(Number(toolState.csm.mapSize)),
      mode: csm.mode,
      cascades: describeCascades({
        breaks: csm.breaks,
        near: camera.near,
        far,
        fov: camera.fov,
        aspect: camera.aspect,
        mapSize: toolState.csm.mapSize,
        screenHeight: renderer.domElement?.height || 1080,
      }),
    };
  }

  return {
    sun,
    hemi,
    /**
     * How the Atmosphere sky lights the world, for a game that wants a different
     * NOON from the editor's: `{ skyFill, dir, hemi, exposure, env }`. The last four
     * are the noon reference the sky's day curve multiplies (WORLD_LIGHT_REFERENCE),
     * so every other hour follows; `skyFill` is skyWorldLight's ambient source. Both
     * are in the sky-light cache key, so the change lands on the next frame. Only
     * the Atmosphere mode reads them.
     */
    /** The world-light settings in force: { skyFill, warmth, dir, hemi, exposure, env }. */
    getWorldLight: () => ({ skyFill: atmoWorldLight.params.skyFill, warmth: atmoWorldLight.params.warmth, ...atmoLightRef }),
    setWorldLight({ skyFill, warmth, ...ref } = {}) {
      if (Number.isFinite(skyFill)) atmoWorldLight.params.skyFill = skyFill;
      if (Number.isFinite(warmth)) atmoWorldLight.params.warmth = warmth;
      for (const k of ["dir", "hemi", "exposure", "env"]) {
        if (Number.isFinite(ref[k])) atmoLightRef[k] = ref[k];
      }
    },
    /** The shadow node, or null — it is REBUILT when cascades change, so read it live. */
    getCsm: () => csm,
    /**
     * The plain sun's own shadow camera — what renders the shadow map when the
     * cascades are OFF and fitDirectionalShadowToView is driving instead.
     *
     * Systems that keep their own shadow-only draw lists (the scatter fields)
     * need to know which cameras will render them, and they were asking the CSM
     * alone. With cascades off that list came back EMPTY and every painted
     * plant silently stopped casting — which reads as "the new shadow mode
     * looks flatter" rather than as a missing render pass.
     */
    getSunShadowCamera: () => sun.shadow?.camera ?? null,
    describeCsm,
    setSkyVisible,
    get skyVisible() { return _skyShown; },
    worldOcean,
    getOceanV2: () => oceanV2,
    setOceanHeights,
    get lensFlare() { return lensFlare; },
    lensFlareLegacy,
    lensFlareNext,
    postFxPipeline,
    sunDir,
    getEffectiveLightDir: () => _effectiveLightDir,
    setCustomCloudSystem,
    /**
     * The lens flare, so a game can own its look and — more importantly — tell it what
     * is in front of the sun. See createLensFlareSystem's setOcclusion.
     */
    lensFlareParams: () => toolState.lensFlare,
    /* Fed to BOTH, so flipping between them mid-drive never leaves one holding a stale
     * occlusion or a stale sun size. */
    setLensFlareOcclusion: (v) => { lensFlareLegacy.setOcclusion(v); lensFlareNext.setOcclusion(v); },
    setLensFlareSourceScale: (v) => { lensFlareLegacy.setSourceScale?.(v); lensFlareNext.setSourceScale?.(v); },
    /** The sun's LINEAR colour through the current air mass. New flare only — the old one
     *  has no notion of a live source colour. */
    setLensFlareSourceColor: (c) => lensFlareNext.setSourceColor?.(c),
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
    /** The atmosphere dome, or null until the mode has been switched on once (lazy). */
    getAtmosphereSky: () => atmoSky,
    /** The Atmosphere sky's marched deck, or null (lazy / not on that tier). */
    getAtmosphereClouds: () => atmoClouds,
    setAtmosphereCloudTier,

    importHdr,
    exportLook,
    importLook,
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
