// OCEAN PRO — the third ocean mode (worldOcean.mode "pro"), as one object the engine drives.
//
// Everything in it is its own (the user's decision, 2026-09-28, as for Sky Pro): Tidewater's FFT sea
// (oceanproFFT.js), its CDLOD mesh (oceanproCDLOD.js), its foam pattern and sea-detail noise
// (oceanproTextures.js) and its water surface + shading (oceanproShader.js). The classic ocean and
// Ocean V2 are untouched and share nothing with it. MIT, Copyright (c) 2026 DRG Software Solutions
// LLC — see v3/skypro-real/tidewater/LICENSE.
//
// It is lit the way Tidewater's water is: by the Sky Pro sky (its sun colour, sky irradiance and
// horizon, in Tidewater's units, and its environment image for the reflections). Without Sky Pro it
// falls back to the world's sun and a two-colour sky gradient — it works, but it is tuned for Sky Pro.
//
// Stage 1 = the open sea (FFT waves, whitecaps, gusts / slicks / windrows, reflection with SSR,
// refraction and the water volume, crest translucency). The shore (breakers, swash, surf foam) and
// the extras (caustics, underwater, wakes) come after.
//
//   const o = createOceanPro( { renderer, scene, camera, heightTexNode, terrainSize, maxHeight } );
//   o.update( dt, { seaLevel, skyPro, sun, shadowNode } )    per frame
//   o.params                                                  the live settings (OCEANPRO_DEFAULTS)
//   o.setEnabled( on ), o.dispose()

import * as THREE from "three/webgpu";
import {
  Fn, attribute, positionGeometry, positionWorld, uniform, vec4, float, texture, sampler, select,
  frontFacing, screenUV, varyingProperty, cameraViewMatrix, cameraProjectionMatrix,
  cameraProjectionMatrixInverse, cameraWorldMatrix, cameraPosition, cameraFar,
  viewportSharedTexture, viewportDepthTexture, nodeObject,
} from "three/tsl";
import { OceanProFFT } from "./oceanproFFT.js";
import { OceanProCDLOD } from "./oceanproCDLOD.js";
import { createFoamTexture, createSeaDetailTexture } from "./oceanproTextures.js";
import { buildOceanProShader } from "./oceanproShader.js";

/** The settings the mode saves with a project (toolState.worldOcean.pro). */
export const OCEANPRO_DEFAULTS = {
  /** the local wind sea (Tidewater: 7 m/s toward 25°, 120 km fetch) */
  windSpeed: 7,
  windDeg: 25,
  fetchKm: 120,
  /** the swell from far away (Tidewater: scale 0.48, 6 m/s, from 5°, 1200 km) */
  swellScale: 0.48,
  swellDeg: 5,
  choppiness: 0.9,
  /** whitecaps start where the surface compresses below this Jacobian */
  foamBias: 0.58,
  foamCoverage: 1,
  /** gusts ("cat's paws"), slicks and windrows (SeaDetail) */
  gusts: 1,
  slicks: 1,
  windrows: 0.3,
  /** water optics, per metre (Tidewater frame defaults) */
  absorption: [0.42, 0.075, 0.035],
  scattering: [0.012, 0.018, 0.024],
  backscatter: 0.035,
  sss: 1,
  roughness: 0.035,
  reflection: 1,
  ssr: true,
  /** 0 = shaded; 1 back faces, 2 normals, 3 foam, 6 water path, 7 seabed seen, 8 depth */
  debug: 0,
};

const _v = new THREE.Vector3();

export function createOceanPro({ renderer, scene, camera, heightTexNode, terrainSize, maxHeight = 500, heightBase = 0, params = {} }) {
  for (const [k, v] of Object.entries(OCEANPRO_DEFAULTS)) if (params[k] === undefined) params[k] = Array.isArray(v) ? [...v] : v;
  const P = params;

  const fft = new OceanProFFT(renderer, {
    local: { windSpeed: P.windSpeed, windDirection: P.windDeg, fetch: P.fetchKm, spreadBlend: 0.85, swell: 0.05 },
    swell: { scale: P.swellScale, windSpeed: 6, windDirection: P.swellDeg, fetch: 1200, spreadBlend: 1.0, swell: 0.9, shortWavesFade: 0.1 },
  });
  const cdlod = new OceanProCDLOD({ gridSize: 32, leafSize: 8, levels: 12, minY: -25, maxY: 25 });
  const foamTex = createFoamTexture(renderer);
  const detailTex = createSeaDetailTexture();
  // one shader per scene-depth type (multisampled or not; see oceanproShader.js DEPTH_T), built on need
  const shaders = new Map();
  const shaderFor = (ms) => {
    if (!shaders.has(ms)) shaders.set(ms, buildOceanProShader({ fft, cdlod, depthMultisampled: ms }));
    return shaders.get(ms);
  };
  let depthMs = (renderer.samples ?? 0) > 1;

  // stand-ins until a sky / clouds exist (1x1, nearest: no sampler for the cloud map)
  const white = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  white.magFilter = white.minFilter = THREE.NearestFilter;
  white.needsUpdate = true;
  const skyStandIn = new THREE.DataTexture(new Uint16Array([0, 0, 0, 15360]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  skyStandIn.needsUpdate = true;

  // ---- uniforms (the opLoad layout, see oceanproShader.js)
  const U = Array.from({ length: 16 }, () => uniform(new THREE.Vector4()));
  const uSea = uniform(0);
  // u0 = ( camera position, sea level ) and u3.w = far come from the camera being drawn
  const u0 = vec4(cameraPosition, uSea);
  const u3 = vec4(U[3].xyz, cameraFar);
  const gate = (loadFn) => loadFn(cameraViewMatrix, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraWorldMatrix,
    u0, U[1], U[2], u3, U[4], U[5], U[6], U[7], U[8], U[9], U[10], U[11], U[12], U[13], U[14], U[15]);

  const dispNode = texture(fft.displacementTexture);
  const derivNode = texture(fft.derivativeTexture);
  const foamNode = texture(foamTex);
  const detailNode = texture(detailTex);
  const cloudNode = texture(white);
  const skyNode = texture(skyStandIn);
  const sceneColor = viewportSharedTexture();
  const sceneDepth = viewportDepthTexture();

  // ---- the material
  const vAux0 = varyingProperty("vec4", "vOpAux0");
  const vAux1 = varyingProperty("vec4", "vOpAux1");
  let shadowNode = null;

  function buildMaterial() {
    const { loadFn, vertexFn, fragmentFn } = shaderFor(depthMs);
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = "OceanPro";
    m.side = THREE.DoubleSide;
    m.fog = true;
    m.positionNode = Fn(() => {
      const out = vertexFn(gate(loadFn), attribute("nodeData", "vec4"), positionGeometry.xz, dispNode, sampler(dispNode), heightTexNode).toVar();
      vAux0.assign(out.element(0));
      vAux1.assign(out.element(1));
      return out.element(0).xyz;
    })();
    // the sun's shadow at this fragment: the engine's shadow node (cascades), else lit
    const sunShadow = shadowNode ? nodeObject(shadowNode).r : float(1);
    // (the scene colour is sampled with the sky image's linear-clamp sampler: three binds no sampler
    // of its own for a viewport texture handed to a function)
    m.colorNode = fragmentFn(gate(loadFn), positionWorld, screenUV, select(frontFacing, float(1), float(0)), vAux0, vAux1, sunShadow,
      derivNode, sampler(derivNode), foamNode, sampler(foamNode), detailNode, sampler(detailNode),
      heightTexNode, cloudNode, sceneColor, sampler(skyNode), sceneDepth, skyNode, sampler(skyNode));
    return m;
  }

  let material = buildMaterial();
  const mesh = new THREE.Mesh(cdlod.geometry, material);
  mesh.name = "OceanPro";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // after the opaque world: the water reads the scene's colour and depth under it
  mesh.renderOrder = 50;
  scene.add(mesh);

  // ---- per frame
  let time = 0;
  const detailOffset = new THREE.Vector2();
  const windDir = new THREE.Vector2();
  const spectrumKey = { v: "" };

  /**
   * @param {number} dt
   * @param {object} o  seaLevel; skyPro (the Sky Pro sky, or null); sun (the engine's DirectionalLight,
   *                    for the fallback light); shadowNode (the sun's shadow node, or null)
   */
  function update(dt, o) {
    if (!mesh.visible) return;
    dt = Math.min(Math.max(dt, 0), 0.1);
    time += dt;

    // the spectrum follows the wind / swell settings (re-initialised only when they change)
    const key = [P.windSpeed, P.windDeg, P.fetchKm, P.swellScale, P.swellDeg].join(",");
    if (key !== spectrumKey.v) {
      spectrumKey.v = key;
      Object.assign(fft.local, { windSpeed: P.windSpeed, windDirection: P.windDeg, fetch: P.fetchKm });
      Object.assign(fft.swell, { scale: P.swellScale, windDirection: P.swellDeg });
      fft.updateSpectrumUniforms();
    }
    fft.params.choppiness = P.choppiness;
    fft.params.foamBias = P.foamBias;
    fft.update(dt);

    uSea.value = o.seaLevel ?? 0;
    cdlod.baseY = uSea.value;
    cdlod.update(camera);

    // the scene depth it reads is multisampled when the frame renders into an MSAA target: its
    // WGSL type follows (three picks the type when the material compiles)
    const ms = !!o.depthMultisampled;
    if (o.shadowNode !== undefined && o.shadowNode !== shadowNode) { shadowNode = o.shadowNode; depthMs = ms; rebuild(); }
    else if (ms !== depthMs) { depthMs = ms; rebuild(); }

    // the wind the sea detail and the roughness see (Tidewater frame.windDir: where it blows toward)
    const wr = THREE.MathUtils.degToRad(P.windDeg);
    windDir.set(Math.cos(wr), Math.sin(wr));
    detailOffset.addScaledVector(windDir, P.windSpeed * 0.7 * dt);

    // ---- the light (Tidewater's units with Sky Pro)
    const sp = o.skyPro;
    if (sp) {
      const L = sp.light();
      U[1].value.set(L.keyDir.x, L.keyDir.y, L.keyDir.z, P.windSpeed);
      const sc = L.keyIsMoon ? [L.moonColor.x, L.moonColor.y, L.moonColor.z] : L.sunColor;
      U[2].value.set(sc[0], sc[1], sc[2], time);
      U[3].value.set(L.skyIrradiance[0], L.skyIrradiance[1], L.skyIrradiance[2], 0);
      U[4].value.set(L.horizon[0], L.horizon[1], L.horizon[2], uSea.value);
      if (skyNode.value !== sp.environment) skyNode.value = sp.environment;
      const cs = sp.cloudShadow;
      if (cloudNode.value !== cs.texture) cloudNode.value = cs.texture;
      U[8].value.set(cs.center.value.x, cs.center.value.y, cs.size.value, cs.strength.value);
    } else {
      // no Sky Pro: the world's sun and a flat sky (the look is tuned for Sky Pro)
      const sun = o.sun;
      _v.copy(sun.position).sub(sun.target.position).normalize();
      U[1].value.set(_v.x, _v.y, _v.z, P.windSpeed);
      U[2].value.set(sun.color.r * sun.intensity, sun.color.g * sun.intensity, sun.color.b * sun.intensity, time);
      const f = o.fogColor ?? new THREE.Color(0.6, 0.7, 0.8);
      U[3].value.set(f.r * 0.35, f.g * 0.4, f.b * 0.5, 0);
      U[4].value.set(f.r, f.g, f.b, uSea.value);
      if (skyNode.value !== skyStandIn) skyNode.value = skyStandIn;
      if (cloudNode.value !== white) cloudNode.value = white;
      U[8].value.set(0, 0, 1, 0);
    }
    const hz = U[4].value;
    U[5].value.set(P.absorption[0], P.absorption[1], P.absorption[2], sp ? 1 : 0);
    // .w: the heightmap is a render target (after a sculpt): its rows read flipped in raw WGSL
    U[6].value.set(P.scattering[0], P.scattering[1], P.scattering[2], heightTexNode.value?.isRenderTargetTexture ? 1 : 0);
    U[7].value.set(windDir.x, windDir.y, terrainSize, maxHeight);
    U[9].value.set(hz.x * 0.45, hz.y * 0.6, hz.z * 0.95, heightBase);
    U[10].value.set(fft.sizes[0], fft.sizes[1], fft.sizes[2], fft.sizes[3]);
    U[11].value.set(P.foamBias, 1, 1, P.foamCoverage);
    U[12].value.set(2.2, 0.09, detailOffset.x, detailOffset.y);
    U[13].value.set(P.gusts, P.slicks, P.windrows, 0);
    U[14].value.set(P.backscatter, P.sss, 0.06, 1);
    U[15].value.set(P.roughness, P.reflection, P.ssr ? 1 : 0, P.debug);
  }

  /** A new material (one compile): the shadow node and the depth type are part of the shader. */
  function rebuild() {
    const old = material;
    material = buildMaterial();
    mesh.material = material;
    old.dispose();
  }
  /** The sun's shadow node is part of the shader: a new one rebuilds the material. */
  function setShadowNode(node) {
    shadowNode = node ?? null;
    rebuild();
  }

  function setEnabled(on) {
    mesh.visible = !!on;
  }

  function dispose() {
    scene.remove(mesh);
    material.dispose();
    cdlod.geometry.dispose();
    fft.dispose();
    foamTex.dispose();
    detailTex.dispose();
    white.dispose();
    skyStandIn.dispose();
  }

  return {
    mesh, params: P, update, setEnabled, setShadowNode, dispose, fft, cdlod,
    get visible() { return mesh.visible; },
  };
}
