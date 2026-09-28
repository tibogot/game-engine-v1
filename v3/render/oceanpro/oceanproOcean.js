// OCEAN PRO — the third ocean mode (worldOcean.mode "pro"), as one object the engine drives.
//
// Everything in it is its own (the user's decision, 2026-09-28, as for Sky Pro): Tidewater's FFT sea
// (oceanproFFT.js), its CDLOD mesh (oceanproCDLOD.js), its foam pattern and sea-detail noise
// (oceanproTextures.js), its shore waves (oceanproShoreField.js + oceanproShore.js) and its water
// surface + shading (oceanproShader.js). The classic ocean and Ocean V2 are untouched and share
// nothing with it. MIT, Copyright (c) 2026 DRG Software Solutions LLC — see
// v3/skypro-real/tidewater/LICENSE.
//
// It is lit the way Tidewater's water is: by the Sky Pro sky (its sun colour, sky irradiance and
// horizon, in Tidewater's units, and its environment image for the reflections). Without Sky Pro it
// falls back to the world's sun and a two-colour sky gradient — it works, but it is tuned for Sky Pro.
//
// Stage 1 = the open sea (FFT waves, whitecaps, gusts / slicks / windrows, reflection with SSR,
// refraction and the water volume, crest translucency). Stage 2a = the shore: the swell's travel-time
// field (CPU, from the heightmap), breaking waves (shoaling, plunging face, bore, whitewater roller),
// the swash sheet running up the sand with its foam line, light through thin crests, the milky surf
// zone. Still to come: the thrown lip, the surf foam's look and transport, caustics, underwater, wakes.
//
//   const o = createOceanPro( { renderer, scene, camera, heightTexNode, terrainSize, maxHeight } );
//   o.setHeights( heights, size )                             the CPU heightmap (for the shore field)
//   o.update( dt, { seaLevel, skyPro, sun, shadowNode } )    per frame
//   o.params                                                  the live settings (OCEANPRO_DEFAULTS)
//   o.setEnabled( on ), o.dispose()

import * as THREE from "three/webgpu";
import {
  Fn, attribute, positionGeometry, uniform, min, max, length, vec4, float, texture, sampler, select,
  frontFacing, screenUV, varyingProperty, cameraViewMatrix, cameraProjectionMatrix,
  cameraProjectionMatrixInverse, cameraWorldMatrix, cameraPosition, cameraFar,
  viewportSharedTexture, viewportDepthTexture, nodeObject,
} from "three/tsl";
import { OceanProFFT } from "./oceanproFFT.js";
import { OceanProCDLOD } from "./oceanproCDLOD.js";
import { createFoamTexture, createSeaDetailTexture } from "./oceanproTextures.js";
import { buildOceanProShader } from "./oceanproShader.js";
import { computeShoreField, makeHeightAt, SHELF } from "./oceanproShoreField.js";
import { SHORE_DEFAULTS } from "./oceanproShore.js";
import { OceanProShoreSim } from "./oceanproShoreSim.js";
import { surfFoamCode } from "./oceanproSurfFoam.js";
import { OceanProBreakers, buildCoastStations, fftDispCode } from "./oceanproBreakers.js";
import { OceanProSpray } from "./oceanproSpray.js";

/** The settings the mode saves with a project (toolState.worldOcean.pro). */
export const OCEANPRO_DEFAULTS = {
  /** the local wind sea (Tidewater: 7 m/s toward 25°, 120 km fetch) */
  windSpeed: 7,
  windDeg: 25,
  fetchKm: 120,
  /** the swell from far away (Tidewater: scale 0.48, 6 m/s, from 5°, 1200 km); also the direction
   * the surf arrives from at the shore */
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
  /** the shore: breaking waves and swash (Tidewater's ShoreParams) */
  surf: true,
  surfHeight: SHORE_DEFAULTS.amplitude, // offshore amplitude (H/2, m)
  surfPeriod: SHORE_DEFAULTS.period, // s
  surfVariation: SHORE_DEFAULTS.variation,
  surfBreak: SHORE_DEFAULTS.gamma, // breaks when H > this x depth
  surfCurl: SHORE_DEFAULTS.curl,
  surfRunup: SHORE_DEFAULTS.runup,
  surfTurbidity: SHORE_DEFAULTS.turbidity,
  /** the thrown lip of plunging breakers (Tidewater's Breakers) */
  lips: true,
  /** the spray the breakers throw: drops, torn sheets, mist (Tidewater's Spray) */
  spray: true,
  /** emission multiplier of the spray */
  sprayAmount: 1,
  /** 0 = shaded; 1 back faces, 2 normals, 3 foam, 6 water path, 7 seabed seen, 8 depth */
  debug: 0,
};

const _v = new THREE.Vector3();
const _c = new THREE.Vector2();
const FIELD_RES = 512;

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
  // the shore simulation (foam carried by the water, wet sand) in a window that follows the camera
  const sim = new OceanProShoreSim(renderer);
  // the spray the breakers throw (a GPU particle ring), and the plunging breakers' thrown lip along
  // the coast near the camera (their crest finder is the spray's emitter)
  const spray = new OceanProSpray({ renderer, scene, fftDisp: fftDispCode(fft) });
  const breakers = new OceanProBreakers({ renderer, scene, fft, spray });
  const surfFoam = surfFoamCode();
  // one shader per scene-depth type (multisampled or not; see oceanproShader.js DEPTH_T), built on need
  const shaders = new Map();
  const shaderFor = (ms) => {
    if (!shaders.has(ms)) shaders.set(ms, buildOceanProShader({ fft, cdlod, depthMultisampled: ms, simCode: sim.material, surfFoam }));
    return shaders.get(ms);
  };
  let depthMs = (renderer.samples ?? 0) > 1;

  // stand-ins until a sky / clouds / shore field exist (1x1, nearest or float: no sampler)
  const white = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  white.magFilter = white.minFilter = THREE.NearestFilter;
  white.needsUpdate = true;
  const skyStandIn = new THREE.DataTexture(new Uint16Array([0, 0, 0, 15360]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  skyStandIn.needsUpdate = true;
  const fieldStandIn = new THREE.DataTexture(new Float32Array([1e4, 0, 0, 1e4]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  fieldStandIn.magFilter = fieldStandIn.minFilter = THREE.NearestFilter;
  fieldStandIn.needsUpdate = true;
  // The linear-clamp sampler the scene colour and the sky image are read with. It comes from this
  // fixed 1x1 texture: three declares no sampler of its own for a viewport texture, nor for the
  // sky slot once it holds Sky Pro's render-target image (both seen: "unresolved nodeUniformN_sampler").
  const clampSrc = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
  clampSrc.magFilter = clampSrc.minFilter = THREE.LinearFilter;
  clampSrc.wrapS = clampSrc.wrapT = THREE.ClampToEdgeWrapping;
  clampSrc.generateMipmaps = false;
  clampSrc.needsUpdate = true;

  // ---- uniforms (the opLoad layout, see oceanproShader.js)
  const U = Array.from({ length: 20 }, () => uniform(new THREE.Vector4()));
  const uSea = uniform(0);
  // u0 = ( camera position, sea level ) and u3.w = far come from the camera being drawn
  const u0 = vec4(cameraPosition, uSea);
  const u3 = vec4(U[3].xyz, cameraFar);
  const gate = (loadFn) => loadFn(cameraViewMatrix, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraWorldMatrix,
    u0, U[1], U[2], u3, U[4], U[5], U[6], U[7], U[8], U[9], U[10], U[11], U[12], U[13], U[14], U[15], U[16], U[17], U[18], U[19]);

  const dispNode = texture(fft.displacementTexture);
  const derivNode = texture(fft.derivativeTexture);
  const foamNode = texture(foamTex);
  const detailNode = texture(detailTex);
  const cloudNode = texture(white);
  const skyNode = texture(skyStandIn);
  const fieldNode = texture(fieldStandIn);
  const clampNode = texture(clampSrc);
  // the shore simulation's state (nearest, loads: no sampler) and the surf lace (linear, mipmapped)
  const simNode = texture(sim.stateA);
  const laceNode = texture(sim.lace.tex);
  const sceneColor = viewportSharedTexture();
  const sceneDepth = viewportDepthTexture();

  // ---- the material
  const vAux0 = varyingProperty("vec4", "vOpAux0");
  const vAux1 = varyingProperty("vec4", "vOpAux1");
  const vAux2 = varyingProperty("vec4", "vOpAux2");
  const vAux3 = varyingProperty("vec4", "vOpAux3");
  let shadowNode = null;

  function buildMaterial() {
    const { loadFn, vertexFn, fragmentFn } = shaderFor(depthMs);
    const m = new THREE.MeshBasicNodeMaterial();
    m.name = "OceanPro";
    m.side = THREE.DoubleSide;
    m.fog = true;
    m.positionNode = Fn(() => {
      const out = vertexFn(gate(loadFn), attribute("nodeData", "vec4"), positionGeometry.xz, dispNode, sampler(dispNode), heightTexNode, fieldNode).toVar();
      vAux0.assign(out.element(0));
      vAux1.assign(out.element(1));
      vAux2.assign(out.element(2));
      vAux3.assign(out.element(3));
      /*
       * TO THE HORIZON. The mesh reaches ~40 km (Tidewater draws to a 60 km far plane); the
       * engine's camera stops at `far` (4 km in the editor). A vertex beyond it is pulled along
       * its own view ray to just inside the far plane: the same pixel, only a nearer depth, so the
       * sea is drawn out to the horizon. The shading uses the TRUE position (vAux0.xyz), so the
       * reflection, the waves and the water depth are those of the real distance.
       */
      const p = out.element(0).xyz;
      const d = p.sub(cameraPosition);
      const s = min(float(1), cameraFar.mul(0.97).div(max(length(d), 1e-3)));
      return cameraPosition.add(d.mul(s));
    })();
    // the sun's shadow at this fragment: the engine's shadow node (cascades), else lit
    const sunShadow = shadowNode ? nodeObject(shadowNode).r : float(1);
    // (the scene colour and the sky image are sampled with clampNode's sampler, see clampSrc)
    // (the true world position, not positionWorld: far vertices are drawn pulled in, see above)
    m.colorNode = fragmentFn(gate(loadFn), vAux0.xyz, screenUV, select(frontFacing, float(1), float(0)), vAux0, vAux1, vAux2, vAux3, sunShadow,
      derivNode, sampler(derivNode), foamNode, sampler(foamNode), detailNode, sampler(detailNode),
      heightTexNode, fieldNode, cloudNode, sceneColor, sampler(clampNode), sceneDepth, skyNode, sampler(clampNode),
      simNode, laceNode, sampler(laceNode));
    return m;
  }

  let material = buildMaterial();
  // the lip is shaded with the ocean's own frame (its shared WGSL and uniform gate)
  {
    const sh = shaderFor(depthMs);
    breakers.buildMesh({ all: sh.all, loadFn: sh.loadFn, gate, cloudNode, skyNode, clampNode });
    spray.buildMesh({ all: sh.all, loadFn: sh.loadFn, gate, cloudNode, crestTexture: breakers.crest, heightTexNode });
  }
  const mesh = new THREE.Mesh(cdlod.geometry, material);
  mesh.name = "OceanPro";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // after the opaque world: the water reads the scene's colour and depth under it
  mesh.renderOrder = 50;
  scene.add(mesh);

  // ---- the shore field (CPU, from the heightmap; rebuilt when the land, the sea level or the swell
  // direction change — debounced, it is a few hundred ms)
  const field = { heights: null, size: 0, key: "", timer: 0, tex: null, origin: 0, span: 1, res: 1, ms: 0 };
  function fieldKey(seaLevel) {
    return `${seaLevel}|${P.swellDeg}|${field.size}`;
  }
  function buildField(seaLevel) {
    if (!field.heights) return;
    const t0 = performance.now();
    const span = terrainSize + 2 * SHELF;
    const heightAt = makeHeightAt({ heights: field.heights, size: field.size, terrainSize, maxHeight, heightBase });
    const sd = THREE.MathUtils.degToRad(P.swellDeg);
    field.swellAng = sd;
    const f = computeShoreField({ heightAt, origin: -span / 2, size: span }, {
      res: FIELD_RES, swellDir: [Math.cos(sd), Math.sin(sd)], seaLevel,
    });
    if (!field.tex || field.tex.image.width !== f.res) {
      field.tex?.dispose();
      field.tex = new THREE.DataTexture(f.data, f.res, f.res, THREE.RGBAFormat, THREE.FloatType);
      field.tex.name = "oceanpro shore field";
      field.tex.magFilter = field.tex.minFilter = THREE.NearestFilter;
      field.tex.generateMipmaps = false;
    } else {
      field.tex.image.data.set(f.data);
    }
    field.tex.needsUpdate = true;
    fieldNode.value = field.tex;
    field.origin = f.origin; field.span = f.size; field.res = f.res;
    // the coastline the breakers stand on: where the swell reaches it (exposure from the field)
    const expo = (x, z) => {
      const i = Math.min(f.res - 1, Math.max(0, Math.floor((x - f.origin) / f.size * f.res)));
      const j = Math.min(f.res - 1, Math.max(0, Math.floor((z - f.origin) / f.size * f.res)));
      const k = (j * f.res + i) * 4;
      return Math.hypot(f.data[k + 1], f.data[k + 2]);
    };
    const tc = performance.now();
    breakers.setCoast(buildCoastStations({ heightAt, seaLevel, half: terrainSize / 2, keep: (x, z) => expo(x, z) > 0.15 }));
    field.coastMs = performance.now() - tc;
    field.ms = performance.now() - t0;
  }
  /** The CPU heightmap (normalised, size x size, row = +z) the shore field is solved over. */
  function setHeights(heights, size) {
    field.heights = heights;
    field.size = size;
    field.key = ""; // stale whatever the sea level
    field.heightAt = makeHeightAt({ heights, size, terrainSize, maxHeight, heightBase });
    rowOrder.stale = true;
  }

  /*
   * The ROW ORDER in which raw WGSL sees the heightmap. The terrain samples it through three (which
   * flips a render target's rows back); the ocean's raw textureLoad sees the rows as they sit on the
   * GPU, and that depends on how the map got there (a sculpt pass, a load's blit, a plain upload),
   * not only on whether it is a render target: a rule on isRenderTargetTexture read a loaded map
   * mirrored in z (every depth wrong: the waves broke 70 m out instead of 25). So it is MEASURED:
   * one column of the GPU texture read back and compared with the CPU copy, both ways, whenever
   * the heights or the texture change. Until a measurement lands: the render-target rule.
   */
  const rowOrder = { flip: null, stale: true, pending: false, tex: null };
  function heightFlip() {
    return rowOrder.flip ?? !!heightTexNode.value?.isRenderTargetTexture;
  }
  function measureRowOrder() {
    const tex = heightTexNode.value;
    if (tex !== rowOrder.tex) { rowOrder.tex = tex; rowOrder.stale = true; }
    if (!rowOrder.stale || rowOrder.pending || !tex || !field.heights) return;
    const g = renderer.backend.get(tex)?.texture;
    const N = field.size;
    const texel = g?.format === "rgba32float" ? 16 : g?.format === "r32float" ? 4 : 0;
    if (!g || !texel || g.height !== N || !(g.usage & GPUTextureUsage.COPY_SRC)) return;
    rowOrder.stale = false;
    rowOrder.pending = true;
    const dev = renderer.backend.device;
    const col = Math.floor(N * 0.53);
    const buf = dev.createBuffer({ size: 256 * N, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = dev.createCommandEncoder({ label: "oceanpro height row order" });
    enc.copyTextureToBuffer({ texture: g, origin: { x: col, y: 0 } }, { buffer: buf, bytesPerRow: 256 }, [1, N, 1]);
    dev.queue.submit([enc.finish()]);
    const heights = field.heights;
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const f = new Float32Array(buf.getMappedRange());
      let direct = 0, flipped = 0;
      for (let j = 0; j < N; j++) {
        const v = f[j * 64];
        direct += Math.abs(v - heights[j * N + col]);
        flipped += Math.abs(v - heights[(N - 1 - j) * N + col]);
      }
      buf.unmap();
      buf.destroy();
      rowOrder.pending = false;
      // (a map symmetric in z can't tell: keep what we had)
      if (Math.abs(direct - flipped) > 1e-3 * N) rowOrder.flip = flipped < direct;
    }).catch(() => { rowOrder.pending = false; buf.destroy(); });
  }

  // ---- per frame
  let time = 0;
  let lastSimArgs = null;
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
    // (debug: `paused` holds the waves still, to inspect one moment)
    if (!P.paused) time += dt;

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
    measureRowOrder();
    cdlod.baseY = uSea.value;
    cdlod.update(camera);

    // the shore field: rebuilt on the trailing edge of a change (a sea-level or swell drag)
    if (P.surf && field.heights) {
      const fk = fieldKey(uSea.value);
      if (fk !== field.key) {
        const first = !field.tex;
        field.key = fk;
        clearTimeout(field.timer);
        if (first) buildField(uSea.value);
        else field.timer = setTimeout(() => buildField(uSea.value), 250);
      }
    }

    // the shore simulation: its window where the camera looks at the sea, then one step
    const simOn = P.surf && !!field.tex && fieldNode.value === field.tex;
    if (simOn) {
      camera.getWorldDirection(_v);
      const cp = camera.position;
      let t = _v.y < -0.02 ? (uSea.value - cp.y) / _v.y : 150;
      t = Math.min(Math.max(t, 0), 150);
      _c.set(cp.x + _v.x * t, cp.z + _v.z * t);
      sim.follow(_c);
      lastSimArgs = {
        dt, time, seaLevel: uSea.value, terrainSize, maxHeight, heightBase,
        flip: heightFlip(),
        shore: [U[16].value.toArray(), U[17].value.toArray(), U[18].value.toArray()],
        heightTexture: heightTexNode.value, fieldTexture: field.tex,
      };
      sim.update(lastSimArgs);
      // the crests (and the spray they throw), then the spray moves
      const sprayOn = P.spray !== false;
      const sprayArgs = {
        ...lastSimArgs, cameraPos: camera.position, windDir, windSpeed: P.windSpeed,
        sprayGain: sprayOn ? P.sprayAmount ?? 1 : 0, dispTexture: fft.displacementTexture,
      };
      breakers.update({ ...sprayArgs, focus: _c });
      if (sprayOn) spray.update(sprayArgs);
    }
    breakers.setVisible(simOn && P.lips !== false);
    spray.setVisible(simOn && P.spray !== false);
    U[19].value.set(sim.min.x, sim.min.y, sim.size, simOn ? 1 : 0);

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
    // .w: the heightmap's rows read flipped in raw WGSL (measured, see measureRowOrder)
    U[6].value.set(P.scattering[0], P.scattering[1], P.scattering[2], heightFlip() ? 1 : 0);
    U[7].value.set(windDir.x, windDir.y, terrainSize, maxHeight);
    U[9].value.set(hz.x * 0.45, hz.y * 0.6, hz.z * 0.95, heightBase);
    U[10].value.set(fft.sizes[0], fft.sizes[1], fft.sizes[2], fft.sizes[3]);
    U[11].value.set(P.foamBias, 1, 1, P.foamCoverage);
    U[12].value.set(2.2, 0.09, detailOffset.x, detailOffset.y);
    U[13].value.set(P.gusts, P.slicks, P.windrows, 0);
    U[14].value.set(P.backscatter, P.sss, 0.06, 1);
    U[15].value.set(P.roughness, P.reflection, P.ssr ? 1 : 0, P.debug);
    // the shore (oceanproShore.js shoreLoad): off until its field exists
    const surfOn = P.surf && fieldNode.value === field.tex && !!field.tex;
    U[16].value.set(P.surfPeriod, P.surfHeight, P.surfVariation, P.surfBreak);
    U[17].value.set(SHORE_DEFAULTS.breakSpan, P.surfCurl, P.surfRunup, surfOn ? 1 : 0);
    // (the field is centred: its origin is - span / 2; the slot carries the swell angle it was built for)
    U[18].value.set(P.surfTurbidity, field.swellAng ?? 0, field.span, field.res);
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
    clearTimeout(field.timer);
    scene.remove(mesh);
    material.dispose();
    cdlod.geometry.dispose();
    fft.dispose();
    foamTex.dispose();
    detailTex.dispose();
    white.dispose();
    skyStandIn.dispose();
    fieldStandIn.dispose();
    clampSrc.dispose();
    sim.dispose();
    breakers.dispose();
    spray.dispose();
    field.tex?.dispose();
  }

  return {
    mesh, params: P, update, setEnabled, setShadowNode, setHeights, dispose, fft, cdlod,
    get visible() { return mesh.visible; },
    /** ms the last shore field took to solve (CPU) */
    get shoreFieldMs() { return field.ms; },
    sim, breakers, spray,
    /** ms the coastline extraction took (CPU, with the shore field) */
    get coastMs() { return field.coastMs ?? 0; },
    /**
     * GPU ms of the raw compute (three's GPU timer does not see it): n FFT steps and n shore
     * simulation steps, each timed alone by waiting for the queue to drain around them.
     */
    async measureCompute(n = 20) {
      const q = renderer.backend.device.queue;
      const run = async (fn) => {
        await q.onSubmittedWorkDone();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) fn();
        await q.onSubmittedWorkDone();
        return (performance.now() - t0) / n;
      };
      const fftMs = await run(() => fft.update(1 / 60));
      const simMs = lastSimArgs ? await run(() => sim.update(lastSimArgs)) : null;
      return { fftMs, simMs, stations: breakers.count };
    },
    /** For debugging: the live uniform vectors (the opLoad layout) and the shore field's data. */
    get debug() { return { U: U.map((u) => u.value.toArray()), field: field.tex?.image ?? null, fieldOrigin: field.origin, fieldSpan: field.span }; },
    /** The sea floor under world (x, z) as the water sees it (m; the shelf beyond the map), or null. */
    heightAt: (x, z) => (field.heightAt ? field.heightAt(x, z) : null),
  };
}
