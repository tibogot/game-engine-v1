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
 * 2. THE SPECTRUM IS OPT-IN TO HORVATH.
 *    `ocean-fft-gpu.js` has shipped two spectra for a while. The old ocean has
 *    only ever asked for `"zelda"` — two cascades, JONSWAP + Phillips. The other,
 *    `"horvath"`, is the Poseidon open-ocean model: three cascades on disjoint
 *    wavenumber bands, fetch-based JONSWAP with a TMA depth correction and
 *    Donelan-Banner spreading. It is strictly the better sea and it was sitting
 *    there unused. It is not the default here only because that file warns it has
 *    no CPU mirror, so anything sampling wave height on the CPU for buoyancy
 *    would be wrong — there are no boats in this game, but the flag stays honest.
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
  /** "zelda" (2 cascades, CPU-mirrored) or "horvath" (3 cascades, better sea). */
  spectrumMode: "zelda",
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
  heightmapSize = 1024,
  normalMap = null,
  lod = {},
}) {
  const lodCfg = { ...OCEAN2_LOD_DEFAULTS, ...lod };

  const fft = createOceanFFTGPUSimulation({
    renderer,
    ...OCEAN_FFT_GPU_DEFAULTS,
    spectrumMode: lodCfg.spectrumMode,
  });

  const shoreField = createShorelineField({
    size: heightmapSize,
    terrainSize,
    maxHeight,
  });

  const surface = createOceanSurface({
    heightTexNode,
    shoreTexture: shoreField.texture,
    normalMap,
    terrainSize,
    maxHeight,
    fft,
  });

  const group = new THREE.Group();
  group.name = "WorldOceanV2";
  group.visible = false;
  scene.add(group);

  // ── Underwater tint overlay (DOM, so it costs no GPU at all) ───────────────
  const uwOverlay = document.createElement("div");
  uwOverlay.style.cssText =
    "position:absolute;inset:0;pointer-events:none;z-index:3;opacity:0;";
  (renderer.domElement.parentElement || document.body).appendChild(uwOverlay);

  const uw = {
    enabled: false, eyeOffset: 0, transitionSpeed: 5,
    tint: "#08323c", tintMax: 0.7, depthDarken: 0.015,
  };
  let uwT = 0;

  let enabled = false;
  let seaLevel = 0;
  let fftHz = lodCfg.fftUpdateHz;
  let fftAccum = 0;
  let baked = false;
  let snapStep = 2;
  let lodSig = "";
  let mesh = null;
  const stats = { rings: 0, triangles: 0, draws: 0, reach: 0, shoreBakeMs: 0 };

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

  function updateUnderwater(dt, camera) {
    const active = enabled && uw.enabled;
    const submerged = active && camera.position.y < seaLevel + uw.eyeOffset;
    uwT += ((submerged ? 1 : 0) - uwT)
      * (1 - Math.exp(-uw.transitionSpeed * Math.max(dt, 1e-4)));
    surface.setUnderwater(uwT);
    if (uwT < 0.001) {
      if (uwOverlay.style.opacity !== "0") uwOverlay.style.opacity = "0";
      return;
    }
    const below = Math.max(0, seaLevel - camera.position.y);
    uwOverlay.style.background = uw.tint;
    uwOverlay.style.opacity =
      (uwT * Math.min(0.95, uw.tintMax + below * uw.depthDarken)).toFixed(3);
  }

  return {
    group,
    surface,
    fft,
    shoreField,
    stats,

    setEnabled(v) { enabled = !!v; group.visible = enabled; },
    setSeaLevel(y) { seaLevel = y; surface.uniforms.waterY.value = y; },
    setEnvMap() {},   // analytic sky — no PMREM needed
    setSunDir(v) { surface.setSunDir(v); },
    setSkyColors(zenith, horizon) { surface.setSky({ zenith, horizon }); },
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
      fft.syncParams(p);
      if (p.seaLevel != null) this.setSeaLevel(p.seaLevel);
      if (p.enabled != null) this.setEnabled(!!p.enabled);
      if (p.underwaterEnabled != null) uw.enabled = !!p.underwaterEnabled;
      if (p.uwEyeOffset != null) uw.eyeOffset = p.uwEyeOffset;
      if (p.uwTransitionSpeed != null) uw.transitionSpeed = p.uwTransitionSpeed;
      if (p.uwTint != null) uw.tint = p.uwTint;
      if (p.uwTintMax != null) uw.tintMax = p.uwTintMax;
      if (p.uwDepthDarken != null) uw.depthDarken = p.uwDepthDarken;
    },

    update(dt, elapsed, camera) {
      updateUnderwater(dt, camera);
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
      surface.dispose();
      shoreField.dispose();
      fft.dispose();
      uwOverlay.remove();
    },
  };
}

export { OCEAN2_DEFAULTS };
