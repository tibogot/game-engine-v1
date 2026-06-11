/**
 * waterMaterial.js — Ocean-style Voronoi water body material (TSL / WebGPU).
 *
 * Creates a self-contained water body shader with:
 *   - Animated Voronoi cells (noise-distorted, flowing)
 *   - Three-stop color ramp (deep → mid → highlight)
 *   - Shore detection via heightmap (foam + glow at terrain intersection)
 *   - Per-body uniforms synced from toolState.water
 *
 * Also re-exports the lake-shader.js factory for Lake-style bodies.
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  Fn,
  uniform,
  float,
  vec2,
  vec4,
  mix,
  smoothstep,
  step,
  floor,
  fract,
  sin,
  dot,
  length,
  min,
  max,
  exp,
  abs,
  saturate,
  clamp,
  texture,
  positionWorld,
  add,
  div,
  sub,
} from "three/tsl";
import { createLakeShader } from "../../core/legacy/lake-shader.js";

const PI2 = 6.2831;
const NEIGHBORS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

// ── TSL Voronoi helpers (shared across all ocean-style bodies) ──────────────

const _hash22 = Fn(([p]) => {
  const px = dot(p, vec2(127.1, 311.7));
  const py = dot(p, vec2(269.5, 183.3));
  return fract(sin(vec2(px, py)).mul(43758.5453));
});

const _smin = Fn(([a, b, k]) => {
  const h = max(k.sub(abs(a.sub(b))), float(0)).div(k);
  return min(a, b).sub(h.mul(h).mul(h).mul(k).div(6));
});

const _cellPt = Fn(([seed, t, spd]) =>
  float(0.5).add(float(0.5).mul(sin(t.mul(spd).add(float(PI2).mul(seed))))),
);

const _voroF1 = Fn(([p, t, spd]) => {
  const ip = floor(p);
  const fp = fract(p);
  const md = float(10).toVar();
  for (const [nx, ny] of NEIGHBORS) {
    const n = vec2(float(nx), float(ny));
    const rnd = _hash22(ip.add(n));
    const pt = vec2(_cellPt(rnd.x, t, spd), _cellPt(rnd.y, t, spd));
    md.assign(min(md, length(n.add(pt).sub(fp))));
  }
  return md;
});

const _voroSmooth = Fn(([p, t, spd, sm]) => {
  const ip = floor(p);
  const fp = fract(p);
  const res = float(10).toVar();
  for (const [nx, ny] of NEIGHBORS) {
    const n = vec2(float(nx), float(ny));
    const rnd = _hash22(ip.add(n));
    const pt = vec2(_cellPt(rnd.x, t, spd), _cellPt(rnd.y, t, spd));
    const d = length(n.add(pt).sub(fp));
    res.assign(_smin(res, d, sm));
  }
  return res;
});

const _nHash = Fn(([p]) => {
  const pp = fract(p.mul(vec2(127.1, 311.7)));
  const d = dot(pp, pp.add(45.32));
  return fract(pp.x.add(d).mul(pp.y.add(d)));
});

const _vnoise2 = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const uu = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(_nHash(i), _nHash(i.add(vec2(1, 0))), uu.x),
    mix(_nHash(i.add(vec2(0, 1))), _nHash(i.add(vec2(1, 1))), uu.x),
    uu.y,
  );
});

const _fbm2 = Fn(([p_immutable]) => {
  const p = p_immutable.toVar();
  const v = _vnoise2(p).mul(0.5).toVar();
  p.assign(p.mul(2));
  v.addAssign(_vnoise2(p).mul(0.25));
  return v;
});

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {THREE.DataTexture} deps.heightTex
 * @param {number} deps.terrainSize
 * @returns {{ oceanMaterial, lakeShader, uniforms, syncUniforms, updateTime }}
 */
export function createWaterMaterials({ heightTex, terrainSize }) {
  const _terrainSize = float(terrainSize);

  // Shared internal constants
  const uSmoothness = uniform(0.55);
  const uEdgeSoft = uniform(0.01);
  const uMidPos = uniform(0.084);
  const uNoiseFlow = uniform(0.2);
  const uGlowColor = uniform(new THREE.Color("#88ccff"));

  // Time uniform (driven each frame)
  const uTime = uniform(0.0);

  // Water body uniforms (synced from toolState.water)
  const u = {
    scale: uniform(0.3),
    edgeThreshold: uniform(0.067),
    flowZ: uniform(0.08),
    cellSpeed: uniform(0.45),
    noiseScale: uniform(1.52),
    noiseTimeScale: uniform(0.6),
    distort: uniform(0.35),
    deepColor: uniform(new THREE.Color("#3a6a8c")),
    midColor: uniform(new THREE.Color("#7ed4f8")),
    highlightColor: uniform(new THREE.Color("#e8f8ff")),
    opacity: uniform(0.78),
    lineWidth: uniform(0.5),
    glowWidth: uniform(2.0),
    lineIntensity: uniform(2.5),
    lineColor: uniform(new THREE.Color("#e8f4ff")),
  };

  // Shore detection: sample heightmap at world XZ
  const _shoreAbove = Fn(() => {
    const hUV = vec2(
      add(div(positionWorld.x, _terrainSize), float(0.5)),
      add(div(positionWorld.z, _terrainSize), float(0.5)),
    );
    return sub(texture(heightTex, hUV).r, positionWorld.y);
  });

  // Ocean-style water body fragment
  const buildWaterBodyFrag = Fn(() => {
    const worldXZ = positionWorld.xz;
    const tNoise = uTime.mul(u.noiseTimeScale);
    const noiseUV = worldXZ
      .mul(u.noiseScale)
      .add(vec2(tNoise.mul(uNoiseFlow), float(0)));
    const noiseFac = _fbm2(noiseUV);
    const distort = vec2(noiseFac.sub(0.5), noiseFac.sub(0.5)).mul(u.distort);
    const uvVoro = worldXZ
      .mul(u.scale)
      .add(vec2(float(0), u.flowZ.mul(tNoise)))
      .add(distort);
    const f1 = _voroF1(uvVoro, tNoise, u.cellSpeed);
    const sf1 = _voroSmooth(uvVoro, tNoise, u.cellSpeed, uSmoothness);
    const edge = f1.sub(sf1);
    const t = smoothstep(
      u.edgeThreshold.sub(uEdgeSoft),
      u.edgeThreshold.add(uEdgeSoft),
      edge,
    );
    const safeMP = max(uMidPos, float(0.0001));
    const seg0 = clamp(t.div(safeMP), float(0), float(1));
    const seg1 = clamp(
      t.sub(safeMP).div(float(1).sub(safeMP).add(float(0.0001))),
      float(0),
      float(1),
    );
    const inSeg1 = smoothstep(safeMP.sub(0.001), safeMP.add(0.001), t);
    const baseColor = mix(
      mix(u.deepColor, u.midColor, seg0),
      mix(u.midColor, u.highlightColor, seg1),
      inSeg1,
    );
    const waterAlpha = mix(float(0.6), float(1), t).mul(u.opacity);
    const terrainAbove = _shoreAbove();
    const onShore = step(float(0), terrainAbove);
    const line = sub(
      float(1),
      smoothstep(float(0), u.lineWidth, terrainAbove),
    ).mul(onShore);
    const glow = exp(
      terrainAbove.div(max(u.glowWidth, float(0.001))).mul(float(-1)),
    ).mul(onShore);
    const foamAlpha = saturate(
      max(line, glow.mul(float(0.5))).mul(u.lineIntensity),
    );
    const foamCol = mix(uGlowColor, u.lineColor, line);
    const finalColor = saturate(baseColor.add(foamCol.mul(foamAlpha)));
    return vec4(finalColor, waterAlpha);
  });

  // Build ocean template material
  const oceanMaterial = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const frag = buildWaterBodyFrag();
  oceanMaterial.colorNode = frag.rgb;
  oceanMaterial.opacityNode = frag.a;

  // Lake shader (imported module)
  const lakeShader = createLakeShader({ heightTex, terrainSize });

  // Lake reflection state
  let _reflScale = 0.5;
  let _reflEveryN = 2;
  let lakeReflectRT = new THREE.RenderTarget(4, 4, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  lakeReflectRT.texture.name = "LakeReflect";
  const lakeReflectCam = new THREE.PerspectiveCamera(45, 1, 0.05, 4000);
  const _reflVPHelper = new THREE.Matrix4();
  const _reflClearColor = new THREE.Color(0x1a3048);
  const _reflLookDir = new THREE.Vector3();
  const _reflLookAt = new THREE.Vector3();
  const _reflFrustum = new THREE.Frustum();
  const _reflProjMat = new THREE.Matrix4();
  const _reflSphere = new THREE.Sphere();
  let _reflFrameCounter = 0;

  /**
   * @param {THREE.Camera} camera
   * @param {THREE.WebGPURenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Mesh[]} waterBodies
   * @param {THREE.Mesh[]} lakeBodies
   * @param {THREE.Object3D[]} [excludeObjects] — hidden during the reflection pass (e.g. grass group)
   */
  function renderLakeReflection(
    camera,
    renderer,
    scene,
    waterBodies,
    lakeBodies,
    excludeObjects,
  ) {
    if (lakeBodies.length === 0) return;

    _reflProjMat.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    _reflFrustum.setFromProjectionMatrix(_reflProjMat);
    let anyVisible = false;
    for (const m of lakeBodies) {
      if (!m.visible) continue;
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      _reflSphere.copy(m.geometry.boundingSphere).applyMatrix4(m.matrixWorld);
      if (_reflFrustum.intersectsSphere(_reflSphere)) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) return;

    _reflFrameCounter++;
    if (_reflFrameCounter % _reflEveryN !== 0) return;

    const waterY = lakeBodies[0].position.y;

    // Mirror camera
    lakeReflectCam.fov = camera.fov;
    lakeReflectCam.near = camera.near;
    lakeReflectCam.far = camera.far;
    const w = Math.max(4, Math.floor(window.innerWidth * _reflScale));
    const h = Math.max(4, Math.floor(window.innerHeight * _reflScale));
    lakeReflectCam.aspect = w / h;
    lakeReflectCam.updateProjectionMatrix();
    lakeReflectCam.position.copy(camera.position);
    lakeReflectCam.position.y = 2 * waterY - camera.position.y;
    camera.getWorldDirection(_reflLookDir);
    _reflLookAt.copy(camera.position).addScaledVector(_reflLookDir, 10);
    _reflLookAt.y = 2 * waterY - _reflLookAt.y;
    lakeReflectCam.up.set(0, -1, 0);
    lakeReflectCam.lookAt(_reflLookAt);
    lakeReflectCam.updateMatrixWorld(true);
    if (lakeReflectRT.width !== w || lakeReflectRT.height !== h)
      lakeReflectRT.setSize(w, h);

    _reflVPHelper.multiplyMatrices(
      lakeReflectCam.projectionMatrix,
      lakeReflectCam.matrixWorldInverse,
    );
    lakeShader.uniforms.reflectVP.value.copy(_reflVPHelper);

    // Hide water bodies + excluded objects during reflection render
    const savedVis = [];
    for (const m of waterBodies) {
      savedVis.push(m.visible);
      m.visible = false;
    }
    const savedExcludeVis = [];
    if (excludeObjects) {
      for (const obj of excludeObjects) {
        savedExcludeVis.push(obj.visible);
        obj.visible = false;
      }
    }

    const prevBg = scene.background;
    const prevAutoClear = renderer.autoClear;
    scene.background = _reflClearColor;
    renderer.autoClear = true;
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(lakeReflectRT);
    renderer.render(scene, lakeReflectCam);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
    scene.background = prevBg;

    for (let i = 0; i < waterBodies.length; i++)
      waterBodies[i].visible = savedVis[i];
    if (excludeObjects) {
      for (let i = 0; i < excludeObjects.length; i++)
        excludeObjects[i].visible = savedExcludeVis[i];
    }

    lakeShader.uniforms.reflectTex.value = lakeReflectRT.texture;
    lakeShader.uniforms.reflectEnabled.value = 1;
  }

  function setReflectionParams(scale, everyN) {
    _reflScale = Math.max(0.1, Math.min(1, scale));
    _reflEveryN = Math.max(1, Math.round(everyN));
  }

  function syncUniforms(waterParams) {
    u.scale.value = waterParams.scale;
    u.edgeThreshold.value = waterParams.edgeThreshold;
    u.flowZ.value = waterParams.flowZ;
    u.cellSpeed.value = waterParams.cellSpeed;
    u.noiseScale.value = waterParams.noiseScale;
    u.noiseTimeScale.value = waterParams.noiseTimeScale;
    u.distort.value = waterParams.distort;
    u.deepColor.value.set(waterParams.deepColor);
    u.midColor.value.set(waterParams.midColor);
    u.highlightColor.value.set(waterParams.highlightColor);
    u.opacity.value = waterParams.opacity;
    u.lineWidth.value = waterParams.lineWidth;
    u.glowWidth.value = waterParams.glowWidth;
    u.lineIntensity.value = waterParams.waterlineIntensity;
    u.lineColor.value.set(waterParams.foamColor);
    lakeShader.syncParams({
      shoreColor: waterParams.shoreColor,
      midColor: waterParams.midColor,
      deepColor: waterParams.deepColor,
      highlightColor: waterParams.highlightColor,
      depthRampShoreMid: waterParams.depthRampShoreMid,
      depthRampMidDeep: waterParams.depthRampMidDeep,
      opacity: waterParams.opacity,
      foamColor: waterParams.foamColor,
    });
  }

  function updateTime(elapsedSec) {
    uTime.value = elapsedSec;
  }

  const LAKE_PLANE_SEGMENTS = 64;

  function makeGeo(w, l, style) {
    const segs = style === "Lake" ? LAKE_PLANE_SEGMENTS : 1;
    const geo = new THREE.PlaneGeometry(w, l, segs, segs);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  function makeMat(style) {
    return (style === "Lake" ? lakeShader.material : oceanMaterial).clone();
  }

  function dispose() {
    oceanMaterial.dispose();
    lakeReflectRT.dispose();
  }

  return {
    oceanMaterial,
    lakeShader,
    uniforms: u,
    uTime,
    syncUniforms,
    updateTime,
    makeGeo,
    makeMat,
    renderLakeReflection,
    setReflectionParams,
    dispose,
  };
}
