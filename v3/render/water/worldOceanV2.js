/**
 * v3/render/water/worldOceanV2.js — host for the new ocean
 *
 * Same shape as `createWorldOcean()` in worldOcean.js (setEnabled / setSeaLevel /
 * setSunDir / setSkyColors / syncParams / update / dispose) so that if this
 * candidate wins it drops into worldEnvironment.js by changing one import. It
 * does NOT import the old one, and the old one does not know this exists.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE THINGS THIS DOES DIFFERENTLY FROM worldOcean.js
 *
 * 1. ONE DRAW CALL, NOT TEN.
 *    The old host builds each CDLOD ring as its own Mesh — at the default
 *    `levels 7 / gridM 64 / horizonScale 6` that is ten meshes reaching 16 km,
 *    so ten draw calls and ten pipeline binds for a surface with one material.
 *    Nothing about the ring structure needs separate meshes: the morph is driven
 *    entirely by the per-vertex `aCell` / `aOuterHalf` attributes, and every ring
 *    is frustum-culling-exempt anyway. So they are concatenated into a single
 *    BufferGeometry here. Identical pixels, one draw.
 *
 *    (This is the same lesson the terrain clipmap already learned. It matters
 *    more in the racing game than in the editor: that game counts draws.)
 *
 * 2. HORVATH, THREE CASCADES, 256².
 *    `ocean-fft-gpu.js` ships two spectra. `"zelda"` is two cascades (512 m and
 *    48 m) at 128²: one sample every 4 m on the swell, and NOTHING between 48 m
 *    and 512 m — which is exactly the band that makes open water read as sea
 *    rather than swell with ripples painted on. `"horvath"` is the Poseidon
 *    open-ocean model: 250 / 17 / 5 m on disjoint wavenumber bands, fetch-based
 *    JONSWAP with a TMA depth correction and Donelan-Banner spreading.
 *
 *    Its one drawback — no CPU mirror, so CPU buoyancy would be wrong — costs
 *    nothing here: nothing in v3 or the games samples wave height on the CPU.
 *    The classic ocean keeps zelda; this is a host default, not the module's.
 *
 *    256² is where every production sea starts. The FFT is compute at the
 *    throttled `fftUpdateHz`, not per frame; see the measurement in the ocean
 *    notes before changing it.
 *
 * 3. THE SHORE FIELD IS OWNED HERE.
 *    Rebaked when the terrain or the sea level changes, never per frame. See
 *    shorelineField.js for why that is a CPU transform.
 *
 * @see oceanSurface.js   — the shader
 * @see shorelineField.js — the distance field
 */

import * as THREE from "three";
import { createOceanSurface, OCEAN2_DEFAULTS } from "./oceanSurface.js";
import { createShorelineField } from "./shorelineField.js";
import { createOceanUnderwater } from "./oceanUnderwater.js";
import {
  createOceanFFTGPUSimulation,
  OCEAN_FFT_GPU_DEFAULTS,
} from "../../../v2/core/legacy/ocean-fft-gpu.js";

export const OCEAN2_LOD_DEFAULTS = {
  /** Rings before the horizon extension kicks in. */
  levels: 7,
  /** Quads per side in every ring. */
  gridM: 64,
  /** Metres per quad in the innermost ring. */
  baseCell: 1.0,
  /** Multiple of the base clipmap extent the sea must still reach. */
  horizonScale: 6.0,
  fftUpdateHz: 30,
  /** "horvath" (3 cascades, 250/17/5 m) or "zelda" (2 cascades, 512/48 m).
   *  Build-time: it sets how many cascades the shader samples. */
  spectrumMode: "horvath",
  /** FFT grid per cascade, power of two. Build-time. */
  fftSize: 256,
};

/**
 * One ring of the clipmap: a grid with a square hole in the middle. `aCell` and
 * `aOuterHalf` travel with the vertices so the CDLOD morph works no matter which
 * geometry a vertex ends up in — which is what lets every ring live in one
 * buffer.
 */
function buildRing(seg, outerHalf, innerHalf) {
  const N = seg + 1;
  const cell = (outerHalf * 2) / seg;
  const positions = new Float32Array(N * N * 3);
  const aCell = new Float32Array(N * N);
  const aOuter = new Float32Array(N * N);

  let p = 0;
  let q = 0;
  for (let j = 0; j < N; j++) {
    const z = -outerHalf + j * cell;
    for (let i = 0; i < N; i++) {
      positions[p] = -outerHalf + i * cell;
      positions[p + 1] = 0;
      positions[p + 2] = z;
      aCell[q] = cell;
      aOuter[q] = outerHalf;
      p += 3;
      q++;
    }
  }

  const idx = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const cx = -outerHalf + (i + 0.5) * cell;
      const cz = -outerHalf + (j + 0.5) * cell;
      if (Math.max(Math.abs(cx), Math.abs(cz)) < innerHalf - 1e-3) continue;
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return { positions, aCell, aOuter, idx, vertCount: N * N };
}

/**
 * Every ring concatenated into ONE geometry.
 * @returns {{ geometry: THREE.BufferGeometry, snapStep: number, rings: number,
 *             triangles: number, reach: number }}
 */
function buildClipmapGeometry({ levels, gridM, baseCell, horizonScale }) {
  const mainOuter = (gridM * baseCell * 2 ** (levels - 1)) / 2;
  const target = mainOuter * Math.max(1, horizonScale);

  const rings = [];
  let reach = 0;
  for (let k = 0; k < levels + 16; k++) {
    const outerHalf = (gridM * baseCell * 2 ** k) / 2;
    rings.push(buildRing(gridM, outerHalf, k === 0 ? 0 : outerHalf / 2));
    reach = outerHalf;
    if (k >= levels - 1 && outerHalf >= target) break;
  }

  let vTotal = 0;
  let iTotal = 0;
  for (const r of rings) {
    vTotal += r.vertCount;
    iTotal += r.idx.length;
  }

  const positions = new Float32Array(vTotal * 3);
  const aCell = new Float32Array(vTotal);
  const aOuter = new Float32Array(vTotal);
  // 42k vertices at the defaults, so 16-bit indices would overflow.
  const indices = new Uint32Array(iTotal);

  let vOff = 0;
  let iOff = 0;
  for (const r of rings) {
    positions.set(r.positions, vOff * 3);
    aCell.set(r.aCell, vOff);
    aOuter.set(r.aOuter, vOff);
    for (let i = 0; i < r.idx.length; i++) indices[iOff + i] = r.idx[i] + vOff;
    vOff += r.vertCount;
    iOff += r.idx.length;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aCell", new THREE.BufferAttribute(aCell, 1));
  geometry.setAttribute("aOuterHalf", new THREE.BufferAttribute(aOuter, 1));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  // The mesh is re-centred on the camera every frame and is meant to be visible
  // in every direction, so a bounding sphere is only a chance to be wrong.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  return {
    geometry,
    snapStep: baseCell * 2,
    rings: rings.length,
    triangles: iTotal / 3,
    reach,
  };
}

/**
 * @param {object}               deps
 * @param {THREE.WebGPURenderer} deps.renderer
 * @param {THREE.Scene}          deps.scene
 * @param {THREE.TextureNode}    deps.heightTexNode — live terrain heightmap node
 * @param {number}               deps.terrainSize
 * @param {number}               [deps.maxHeight=500]
 * @param {number}               [deps.heightmapSize=1024] — shore-field resolution
 * @param {THREE.Texture|null}   [deps.normalMap]
 * @param {object}               [deps.lod] — OCEAN2_LOD_DEFAULTS overrides
 */
export function createWorldOceanV2({
  renderer,
  scene,
  heightTexNode,
  terrainSize,
  maxHeight = 500,
  heightBase = 0,
  heightmapSize = 1024,
  normalMap = null,
  lod = {},
  envMap = null,
  params = null,
  shadowNode = null,
}) {
  const lodCfg = { ...OCEAN2_LOD_DEFAULTS, ...lod };

  /*
   * The spectrum is baked on the CPU — ~200 ms at 256² × 3 cascades, measured —
   * so it is built ONCE with this ocean's own sea state (not the module's storm
   * defaults, which would be baked and then thrown away), and later changes are
   * coalesced: a wind-slider drag fires syncParams on every pointer move, and a
   * 200 ms stall per move is not a slider. Only a real change rebakes.
   */
  const SPECTRUM_KEYS = [
    "windSpeed", "windAngleDeg", "jonswapGamma", "windSpreadPow", "fftSeed",
    "seaFetchKm", "swellStrength", "swellWindSpeed", "swellAngleOffsetDeg", "seaDepthM",
  ];
  const _spectrum = {};
  for (const k of SPECTRUM_KEYS) {
    const v = params?.[k] ?? OCEAN2_DEFAULTS[k] ?? OCEAN_FFT_GPU_DEFAULTS[k];
    if (v != null) _spectrum[k] = v;
  }
  let _bakedSpectrum = JSON.stringify(_spectrum);
  let _spectrumTimer = 0;

  const fft = createOceanFFTGPUSimulation({
    renderer,
    ...OCEAN_FFT_GPU_DEFAULTS,
    ..._spectrum,
    seed: _spectrum.fftSeed,
    spectrumMode: lodCfg.spectrumMode,
    size: lodCfg.fftSize,
  });

  /** Split spectrum keys out of `p`; schedule one rebake if they moved. */
  function syncSpectrum(p) {
    const rest = { ...p };
    for (const k of SPECTRUM_KEYS) {
      if (p[k] == null) continue;
      _spectrum[k] = p[k];
      delete rest[k];
    }
    const sig = JSON.stringify(_spectrum);
    if (sig !== _bakedSpectrum) {
      clearTimeout(_spectrumTimer);
      _spectrumTimer = setTimeout(() => {
        _spectrumTimer = 0;
        _bakedSpectrum = JSON.stringify(_spectrum);
        fft.syncParams({ ..._spectrum });
      }, 150);
    }
    return rest;
  }

  const shoreField = createShorelineField({
    size: heightmapSize,
    terrainSize,
    maxHeight,
    heightBase,
  });

  const surface = createOceanSurface({
    heightTexNode,
    shoreTexture: shoreField.texture,
    normalMap,
    terrainSize,
    maxHeight,
    heightBase,
    fft,
    envMap,
    shadowNode,
  });

  const group = new THREE.Group();
  group.name = "WorldOceanV2";
  group.visible = false;
  scene.add(group);

  // ── Underwater: see oceanUnderwater.js ─────────────────────────────────────
  const underwater = createOceanUnderwater({ surface });
  scene.add(underwater.group);
  const uw = {
    enabled: OCEAN2_DEFAULTS.uwEnabled,
    snowEnabled: OCEAN2_DEFAULTS.uwSnowEnabled,
    causticsEnabled: OCEAN2_DEFAULTS.uwCausticsEnabled,
    causticsIntensity: OCEAN2_DEFAULTS.uwCausticsIntensity,
    causticsMaxDepth: OCEAN2_DEFAULTS.uwCausticsMaxDepth,
    causticsRange: OCEAN2_DEFAULTS.uwCausticsRange,
    lightGain: OCEAN2_DEFAULTS.uwLightGain,
    activeBand: OCEAN2_DEFAULTS.uwActiveBand,
  };
  underwater.setSnowCount(OCEAN2_DEFAULTS.uwSnowCount);
  /** Last light handed to setLight, kept so a gain change re-applies it. */
  const _light = {
    sun: new THREE.Color(1, 0.96, 0.9), sunIntensity: 3,
    amb: new THREE.Color(0.55, 0.65, 0.75), ambIntensity: 1,
  };
  const _sunDir = new THREE.Vector3(0.4, 0.55, 0.3).normalize();
  const _refr = new THREE.Vector3();

  /**
   * Scene lights → the radiance the water scatters. Irradiance on the sea
   * plane (sun · cos elevation, plus the sky), divided by π like a Lambert
   * surface does, so the murk and the seabed track each other through the day.
   */
  function applyLight() {
    const g = uw.lightGain / Math.PI;
    const sunI = _light.sunIntensity * Math.max(_sunDir.y, 0) * g;
    const ambI = _light.ambIntensity * g;
    surface.uniforms.uwLightSun.value.set(_light.sun.r * sunI, _light.sun.g * sunI, _light.sun.b * sunI);
    surface.uniforms.uwLightAmb.value.set(_light.amb.r * ambI, _light.amb.g * ambI, _light.amb.b * ambI);
    // Direction toward the sun seen from below: Snell on the elevation, so it
    // never sits lower than ~41° above the horizon under water.
    const horiz = Math.hypot(_sunDir.x, _sunDir.z);
    const sinUnder = Math.min(horiz, 1) / 1.333;
    const cosUnder = Math.sqrt(1 - sinUnder * sinUnder);
    if (horiz > 1e-5) {
      _refr.set((_sunDir.x / horiz) * sinUnder, cosUnder, (_sunDir.z / horiz) * sinUnder);
    } else {
      _refr.set(0, 1, 0);
    }
    surface.uniforms.uwSunDirUnder.value.copy(_refr);
  }
  applyLight();

  let enabled = false;
  let seaLevel = 0;
  let fftHz = lodCfg.fftUpdateHz;
  let fftAccum = 0;
  let baked = false;
  let snapStep = 2;
  let lodSig = "";
  let mesh = null;
  const stats = {
    rings: 0, triangles: 0, draws: 0, reach: 0, shoreBakeMs: 0,
    fftSize: lodCfg.fftSize, cascades: fft.cascades.length, spectrumMode: lodCfg.spectrumMode,
  };

  function rebuildClipmap(cfg) {
    const sig = `${cfg.levels}|${cfg.gridM}|${cfg.baseCell}|${cfg.horizonScale}`;
    if (sig === lodSig && mesh) return;
    lodSig = sig;

    if (mesh) {
      group.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }

    const clip = buildClipmapGeometry(cfg);
    snapStep = clip.snapStep;
    surface.uniforms.meshBaseCell.value = cfg.baseCell;
    mesh = new THREE.Mesh(clip.geometry, surface.material);
    mesh.frustumCulled = false;
    // Opaque objects sort front-to-back, so without an explicit order the sea
    // could draw before the terrain and grab an empty backbuffer to refract.
    mesh.renderOrder = 10;
    mesh.name = "OceanClipmap";
    group.add(mesh);

    stats.rings = clip.rings;
    stats.triangles = clip.triangles;
    stats.draws = 1;
    stats.reach = clip.reach;
  }

  rebuildClipmap(lodCfg);

  /*
   * The whole CPU side of "is the camera in the water": one height test. Inside
   * the band the GPU pass decides per pixel (waves wash over the lens); outside
   * it both meshes are hidden, so they are not drawn and nothing is copied.
   * The snow only needs the camera below the tallest possible crest.
   */
  function updateUnderwater(camera) {
    const near = enabled && uw.enabled && camera.position.y < seaLevel + uw.activeBand;
    underwater.water.visible = near;
    underwater.snow.visible = near && uw.snowEnabled
      && camera.position.y < seaLevel + uw.activeBand * 0.5;
  }

  return {
    group,
    surface,
    fft,
    shoreField,
    stats,

    underwater,

    setEnabled(v) {
      enabled = !!v;
      group.visible = enabled;
      if (!enabled) underwater.water.visible = underwater.snow.visible = false;
    },
    setSeaLevel(y) { seaLevel = y; surface.uniforms.waterY.value = y; },
    /** The sun's shadow node, or null. Recompiles on change only. See oceanSurface. */
    setShadowNode(node) { surface.setShadowNode(node); },
    setSunDir(v) {
      surface.setSunDir(v);
      if (v) { _sunDir.copy(v).normalize(); applyLight(); }
    },
    /**
     * The scene's lights, so the water under the sea is lit by what lights the
     * world above it. Cheap; call per frame. Optional — without it the water
     * assumes a plain noon.
     * @param {{ sunColor?: THREE.Color, sunIntensity?: number,
     *           ambientColor?: THREE.Color, ambientIntensity?: number }} o
     */
    setLight({ sunColor, sunIntensity, ambientColor, ambientIntensity } = {}) {
      if (sunColor) _light.sun.copy(sunColor);
      if (sunIntensity != null) _light.sunIntensity = sunIntensity;
      if (ambientColor) _light.amb.copy(ambientColor);
      if (ambientIntensity != null) _light.ambIntensity = ambientIntensity;
      applyLight();
    },
    /**
     * What the terrain needs to draw caustics under this sea. Plain numbers —
     * the host pushes them into its seabed shader (lakebedTsl.setOcean).
     */
    getCausticsState() {
      return {
        on: enabled && uw.causticsEnabled,
        seaLevel,
        intensity: uw.causticsIntensity,
        maxDepth: uw.causticsMaxDepth,
        range: uw.causticsRange,
      };
    },
    setSkyColors(zenith, horizon) { surface.setSky({ zenith, horizon }); },
    /** Scene environment map for the reflection; null falls back to the
     *  analytic sky. No-ops unless the texture identity changed. */
    setEnvMap(tex) { surface.setEnvMap(tex); },
    setSky(o) { surface.setSky(o); },

    /**
     * Rebake the shoreline field. Call after a sculpt or a sea-level change,
     * debounced — it is ~100 ms at 1024², not a per-frame cost.
     * @param {Float32Array} heights normalised heights, heightmapSize² long
     */
    rebakeShore(heights, level = seaLevel) {
      stats.shoreBakeMs = shoreField.update(heights, level);
      return stats.shoreBakeMs;
    },

    syncParams(p) {
      if (!p) return;
      rebuildClipmap({ ...lodCfg, ...p });
      if (p.fftUpdateHz != null) fftHz = p.fftUpdateHz;
      surface.syncParams(p);
      fft.syncParams(syncSpectrum(p));
      if (p.seaLevel != null) this.setSeaLevel(p.seaLevel);
      if (p.enabled != null) this.setEnabled(!!p.enabled);
      if (p.uwEnabled != null) uw.enabled = !!p.uwEnabled;
      if (p.uwSnowEnabled != null) uw.snowEnabled = !!p.uwSnowEnabled;
      if (p.uwSnowCount != null) underwater.setSnowCount(p.uwSnowCount);
      if (p.uwCausticsEnabled != null) uw.causticsEnabled = !!p.uwCausticsEnabled;
      if (p.uwCausticsIntensity != null) uw.causticsIntensity = p.uwCausticsIntensity;
      if (p.uwCausticsMaxDepth != null) uw.causticsMaxDepth = p.uwCausticsMaxDepth;
      if (p.uwCausticsRange != null) uw.causticsRange = p.uwCausticsRange;
      if (p.uwActiveBand != null) uw.activeBand = p.uwActiveBand;
      if (p.uwLightGain != null) { uw.lightGain = p.uwLightGain; applyLight(); }
    },

    update(dt, elapsed, camera) {
      updateUnderwater(camera);
      if (!enabled || !mesh) return;

      // Snap to a multiple of the finest cell so the grid does not shimmer as
      // the camera moves — the classic clipmap requirement.
      group.position.set(
        Math.round(camera.position.x / snapStep) * snapStep,
        seaLevel,
        Math.round(camera.position.z / snapStep) * snapStep,
      );
      surface.update(dt, elapsed);

      // The FFT is throttled below the frame rate; the first tick must run
      // before anything samples the cascades or the sea is dead flat for a frame.
      if (!baked) {
        fft.update(elapsed);
        baked = true;
        fftAccum = 0;
        return;
      }
      fftAccum += dt;
      const interval = 1 / Math.max(1, fftHz);
      if (fftAccum >= interval) {
        fftAccum = Math.min(fftAccum - interval, interval);
        fft.update(elapsed);
      }
    },

    dispose() {
      if (mesh) {
        group.remove(mesh);
        mesh.geometry.dispose();
      }
      scene.remove(group);
      clearTimeout(_spectrumTimer);
      scene.remove(underwater.group);
      underwater.dispose();
      surface.dispose();
      shoreField.dispose();
      fft.dispose();
    },
  };
}

export { OCEAN2_DEFAULTS };
