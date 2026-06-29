/**
 * v3/render/water/worldOcean.js — V3 global LOD ocean
 *
 * Wraps v3/render/water/oceanShader.js + v2 GPU FFT sim with the same
 * createWorldOcean({ renderer, scene, heightTexNode, terrainSize, maxHeight })
 * API that worldEnvironment.js expects.
 *
 * Key differences from v2/render/water/worldOcean.js:
 *  - Accepts `heightTexNode` (live TSL TextureNode) so the ocean always reads
 *    the sculpted terrain from the active ping-pong render target.
 *  - Exposes setSkyColors(zenith, horizon) for day/night sky reflection tinting.
 *  - setEnvMap() is a no-op (analytical sky in the shader — no PMREM needed).
 */

import * as THREE from "three";
import { createOceanShader } from "./oceanShader.js";
import {
  createOceanFFTGPUSimulation,
  OCEAN_FFT_GPU_DEFAULTS,
} from "../../../v2/core/legacy/ocean-fft-gpu.js";

// ── CDLOD clipmap geometry (identical to v2) ──────────────────────────────────
function buildRingGeometryXZ(seg, outerHalf, innerHalf) {
  const N    = seg + 1;
  const cell = (outerHalf * 2) / seg;
  const positions = new Float32Array(N * N * 3);
  const aCell     = new Float32Array(N * N);
  const aOuter    = new Float32Array(N * N);
  let p = 0, q = 0;
  for (let j = 0; j < N; j++) {
    const z = -outerHalf + j * cell;
    for (let i = 0; i < N; i++) {
      positions[p]     = -outerHalf + i * cell;
      positions[p + 1] = 0;
      positions[p + 2] = z;
      aCell[q]  = cell;
      aOuter[q] = outerHalf;
      p += 3; q++;
    }
  }
  const idx = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const cx = -outerHalf + (i + 0.5) * cell;
      const cz = -outerHalf + (j + 0.5) * cell;
      if (Math.max(Math.abs(cx), Math.abs(cz)) < innerHalf - 1e-3) continue;
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aCell",    new THREE.BufferAttribute(aCell,     1));
  geo.setAttribute("aOuterHalf", new THREE.BufferAttribute(aOuter,  1));
  geo.setIndex(idx);
  return geo;
}

function buildClipmap({ levels, gridM, baseCell, horizonScale }) {
  const meshes    = [];
  const mainOuter = (gridM * baseCell * Math.pow(2, levels - 1)) / 2;
  const target    = mainOuter * Math.max(1, horizonScale);
  let triCount = 0, lastOuterHalf = 0;
  for (let k = 0; k < levels + 16; k++) {
    const outerHalf = (gridM * baseCell * Math.pow(2, k)) / 2;
    const innerHalf = k === 0 ? 0 : outerHalf / 2;
    const geo = buildRingGeometryXZ(gridM, outerHalf, innerHalf);
    triCount += geo.getIndex().count / 3;
    meshes.push(geo);
    lastOuterHalf = outerHalf;
    if (k >= levels - 1 && outerHalf >= target) break;
  }
  return { geos: meshes, snapStep: baseCell * 2, triCount, reach: lastOuterHalf };
}

/**
 * @param {object}            deps
 * @param {THREE.WebGPURenderer} deps.renderer
 * @param {THREE.Scene}       deps.scene
 * @param {THREE.TextureNode} deps.heightTexNode — live TSL TextureNode (sculptBrush ping-pong)
 * @param {number}            deps.terrainSize   — world size (e.g. 2048)
 * @param {number}            [deps.maxHeight=500] — MAX_HEIGHT constant
 */
export function createWorldOcean({ renderer, scene, heightTexNode, terrainSize, maxHeight = 500 }) {
  const fft = createOceanFFTGPUSimulation({ renderer, ...OCEAN_FFT_GPU_DEFAULTS });

  const ocean = createOceanShader({ heightTexNode, terrainSize, maxHeight, fft });

  const group = new THREE.Group();
  group.name    = "WorldOcean";
  group.visible = false;
  scene.add(group);

  // DOM underwater overlay (zero GPU cost)
  const uwOverlay = document.createElement("div");
  uwOverlay.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:3;opacity:0;";
  (renderer.domElement.parentElement || document.body).appendChild(uwOverlay);
  let uwT = 0;
  const uw = {
    enabled: false, eyeOffset: 0, transitionSpeed: 5,
    tint: "#0a3a44", tintMax: 0.72, depthDarken: 0.015,
  };

  let enabled  = false;
  let seaLevel = 0;
  let fftHz    = 30;
  let fftAccum = 0;
  let snapStep = 2;
  let lodSig   = "";
  let baked    = false;

  function updateUnderwater(dt, camera) {
    const active    = enabled && uw.enabled;
    const submerged = active && camera.position.y < seaLevel + uw.eyeOffset;
    uwT += ((submerged ? 1 : 0) - uwT) * (1 - Math.exp(-uw.transitionSpeed * Math.max(dt, 1e-4)));
    if (uwT < 0.001) { if (uwOverlay.style.opacity !== "0") uwOverlay.style.opacity = "0"; return; }
    const depthBelow = Math.max(0, seaLevel - camera.position.y);
    const op = uwT * Math.min(0.95, uw.tintMax + depthBelow * uw.depthDarken);
    uwOverlay.style.background = uw.tint;
    uwOverlay.style.opacity    = op.toFixed(3);
  }

  function rebuildClip(p) {
    const sig = `${p.levels}|${p.gridM}|${p.baseCell}|${p.horizonScale}`;
    if (sig === lodSig && group.children.length) return;
    lodSig = sig;
    for (let i = group.children.length - 1; i >= 0; i--) {
      const m = group.children[i];
      group.remove(m);
      m.geometry.dispose();
    }
    const clip = buildClipmap(p);
    snapStep = clip.snapStep;
    for (const geo of clip.geos) {
      const mesh = new THREE.Mesh(geo, ocean.material);
      mesh.frustumCulled = false;
      mesh.renderOrder   = 1;
      group.add(mesh);
    }
  }

  return {
    group,
    ocean,
    fft,

    setEnabled(v)   { enabled = !!v; group.visible = enabled; },
    setSeaLevel(y)  { seaLevel = y; },

    // no-op — analytical sky needs no env map
    setEnvMap(_tex) {},

    setSunDir(v) {
      if (v) ocean.uniforms.sunDir.value.copy(v).normalize();
    },

    setSkyColors(zenith, horizon) {
      ocean.setSkyColors(zenith, horizon);
    },

    syncParams(p) {
      if (!p) return;
      rebuildClip(p);
      fftHz = p.fftUpdateHz ?? 30;
      ocean.syncParams(p);
      fft.syncParams(p);
      this.setSeaLevel(p.seaLevel ?? 0);
      this.setEnabled(!!p.enabled);
      uw.enabled         = !!p.underwaterEnabled;
      uw.eyeOffset       = p.uwEyeOffset ?? 0;
      uw.transitionSpeed = p.uwTransitionSpeed ?? 5;
      uw.tint            = p.uwTint ?? "#0a3a44";
      uw.tintMax         = p.uwTintMax ?? 0.72;
      uw.depthDarken     = p.uwDepthDarken ?? 0.015;
    },

    update(dt, elapsed, camera) {
      updateUnderwater(dt, camera);
      if (!enabled || group.children.length === 0) return;
      group.position.set(
        Math.round(camera.position.x / snapStep) * snapStep,
        seaLevel,
        Math.round(camera.position.z / snapStep) * snapStep,
      );
      ocean.uniforms.waterY.value = seaLevel;
      ocean.update(dt, elapsed);
      if (!baked) {
        fft.update(elapsed);
        baked    = true;
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
      for (const m of group.children) m.geometry?.dispose();
      scene.remove(group);
      ocean.material.dispose();
      fft.dispose();
      uwOverlay.remove();
    },
  };
}
