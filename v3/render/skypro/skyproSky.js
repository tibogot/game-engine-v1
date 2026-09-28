// SKY PRO — the sky mode, as one object the engine drives (v3/app/worldEnvironment.js, skyMode "skypro").
//
// Everything in it is its own, on purpose (user's decision, 2026-09-28): Tidewater's atmosphere
// (skyproAtmosphere.js — NOT skyAtmosphere.js / dayNightSky.js), the Sky Pro cumulus
// (skyproClouds.js), Tidewater's cirrus (skyproCirrus.js) and a sky environment baked from them
// (skyproEnv.js). The other sky modes are untouched and share nothing with it. MIT, Copyright (c) 2026
// DRG Software Solutions LLC — see v3/skypro-real/tidewater/LICENSE.
//
// What the engine gets:
//   const s = createSkyProSky( { renderer, camera, params } ); await s.ready;
//   scene.add( s.mesh )              the dome: sky + sun, moon and stars + cumulus + cirrus
//                                    (Tidewater Sky.js skyViewRadiance with the cirrus layered behind
//                                    the cumulus, as its Clouds.js did)
//   s.update( dt, { sunDir, moonDir, night, drawingBufferSize } )   the per-frame work (bakes, cloud
//                                    trace, environment); sunDir = the REAL sun, from the engine's clock
//   s.light()                        what the world should be lit by, in Tidewater's units:
//                                    { sunColor [lin rgb], skyIrradiance, horizon, keyIsMoon, moonColor,
//                                      keyDir (Vector3 toward the key light: the sun, or the moon at night) }
//   s.environment                    the texture for scene.environment (three runs its PMREM)
//   s.params                         the live settings (SKYPRO_DEFAULTS' shape; the editor binds it)
//   s.dispose()
//
//   s.postProcess( rt, { depthTex, light, shadowDepth } )   the air haze and sun shafts
//                                    (skyproHaze.js) on the linear HDR frame in rt, written back
//                                    into it; depthTex = the scene depth, light + shadowDepth =
//                                    a directional light and its shadow map (optional)
//   s.cloudShadow                    { texture, center, size, strength }: the cumulus shadow
//                                    map over the ground, for the sun's colorNode

import * as THREE from "three/webgpu";
import { Fn, uniform, vec2, vec3, vec4, float, normalize, positionWorld, cameraPosition, max, min, exp, mix, smoothstep, screenUV, texture, uv } from "three/tsl";
import { createSkyProAtmosphere } from "./skyproAtmosphere.js";
import { createSkyProClouds } from "./skyproClouds.js";
import { createCirrus, clOver } from "./skyproCirrus.js";
import { createSkyEnvironment } from "./skyproEnv.js";
import { createAirHaze } from "./skyproHaze.js";

/** The settings the mode saves with a project (toolState.skyProSky). */
export const SKYPRO_DEFAULTS = {
  /** cumulus cover (the "Partly cloudy" preset's shell coverage) */
  coverage: 0.49,
  /** m/s at the deck: Tidewater 12; the Sky Pro preset's own drift (a time-lapse) is 89 */
  windSpeed: 12,
  /** degrees, the direction the wind blows toward (atan2 of Tidewater's default wind) */
  windDeg: Math.round(Math.atan2(0.94, 0.35) * 180 / Math.PI),
  /** cirrus amount, Tidewater's 0..1 (0 = off); higher is a thicker veil than Tidewater allowed */
  cirrus: 0.5,
  cirrusAlt: 9000,
  /** Tidewater hides clouds below the horizon; off = clouds seen from above and inside the deck */
  horizonMask: false,
  /** Tidewater's exposure for its units (the engine's exposure follows it while this sky is shown) */
  exposure: 0.55,
  /** the lower hemisphere of the sky light (a flat ground of this albedo) */
  groundAlbedo: "#54493a",
  /** air haze density (Tidewater AirHaze: marine + aerosol layers); 0 = no haze pass at all */
  haze: 1.6,
  /** sun shafts through the shadow map and the cloud shadow, 0..1 (Tidewater 1) */
  shafts: 1.0,
  /** screen-space god rays round a low sun in view */
  godRays: true,
  /**
   * INTERNAL (no control): the world's lights from before this sky took them over, restored
   * when the mode is left. Kept HERE, in the saved slice, not in memory: the editor persists
   * its lights, so after a reload in this mode the saved lights ARE this sky's, and a snapshot
   * held in memory would be gone — leaving the mode would strand the other skies under a sun
   * of ~10 (Tidewater's units) instead of the ~2 they were tuned with. null = none taken.
   */
  savedLight: null,
};

const SKY_RADIUS = 4000;

/**
 * @param {object} o
 * @param {THREE.WebGPURenderer} o.renderer
 * @param {THREE.PerspectiveCamera} o.camera
 * @param {object} [o.params]  live settings (merged over SKYPRO_DEFAULTS; the object is KEPT, not copied)
 */
export function createSkyProSky({ renderer, camera, params = {} }) {
  for (const [k, v] of Object.entries(SKYPRO_DEFAULTS)) if (params[k] === undefined) params[k] = v;
  const P = params;

  const atmosphere = createSkyProAtmosphere({ renderer });
  const clouds = createSkyProClouds({ renderer, atmosphere });
  const cirrus = createCirrus({ renderer, atmosphere });
  const ground = new THREE.Color();
  const env = createSkyEnvironment({ renderer, atmosphere, clouds, cirrus, groundAlbedo: [0.33, 0.29, 0.22] });

  // ---- the dome: Tidewater Sky.js skyViewRadiance, the cirrus behind the cumulus
  const uPxAngle = uniform(0.001);
  // the ground below the horizon (see the dome): key light, its direction, the floor's albedo, mean cloud shadow
  const uKey = uniform(new THREE.Vector3(0, 0, 0));
  const uKeyDir = uniform(new THREE.Vector3(0, 1, 0));
  const uFloor = uniform(new THREE.Vector3(0.33, 0.29, 0.22));
  const uCloudMean = uniform(1);
  const uHaze = uniform(1.6);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition)).toVar();
    // the sky half is read at or above the horizon: in the blend band just below it, the sky-view
    // LUT's near-black lower half drew a dark blue strip under the horizon
    const skyDir = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z)).toVar();
    const base = atmosphere.skyBackground(skyDir).add(atmosphere.moon(skyDir));
    const sun = atmosphere.sunDisk(dir);
    const c = clouds.viewSample(dir).toVar();
    const all = clOver(c, cirrus.sample(dir, uPxAngle)).toVar();
    const sky = base.mul(all.a).add(sun.mul(clouds.sunTransmittance(all.a))).add(all.rgb);
    /*
     * BELOW THE HORIZON. Tidewater's sky-view LUT is near black down there — its sea always
     * covered it. The editor shows the dome beyond the terrain's edge, so this sky paints the
     * ground the world stands on: a flat floor at sea level under the key light and the sky
     * (Tidewater's lighting: sun / PI, sky irradiance already / PI), fading to the horizon's sky
     * colour with distance. The clouds between the camera and it (seen from above) lie over it.
     */
    const camY = max(cameraPosition.y, 1.0);
    const t = camY.div(max(dir.y.negate(), 1e-4));
    const E = uKey.mul(max(uKeyDir.y, 0.0)).mul(uCloudMean).div(Math.PI).add(atmosphere.irradianceNode);
    const floor = vec3(uFloor).mul(E);
    const hz = atmosphere.skyLuminance(normalize(vec3(dir.x, 0.02, dir.z)));
    // The air between: the haze pass's own two layers (skyproHaze.js hazeLayerDepth, marine +
    // aerosol) at its density, so the floor fades into the horizon exactly as the terrain does;
    // a 12 km fade underneath for when the haze is off.
    const d = min(t, 1e6);
    const dy = min(dir.y, -1e-4);   // (looking down; kept off 0 so the sky half stays finite)
    const layer = (sigma, H) => {
      const k = dy.mul(d).div(H);
      return exp(camY.div(-H)).mul(sigma).mul(float(H).mul(float(1.0).sub(exp(k.negate()))).div(dy));
    };
    const tau = layer(1.5e-4, 110).add(layer(3.2e-5, 1400)).mul(uHaze);
    const far = max(float(1.0).sub(exp(tau.negate())), float(1.0).sub(exp(d.div(-12000.0))));
    const groundView = mix(floor, hz, far).mul(c.a).add(c.rgb);
    return vec4(mix(groundView, sky, smoothstep(-0.02, 0.0, dir.y)), 1.0);
  })();
  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.depthTest = false;
  material.fog = false;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 24), material);
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  mesh.name = "SkyProSkyDome";
  // centred on whatever camera draws it (the main view, or an env probe's cube camera)
  mesh.onBeforeRender = (_r, _s, cam) => { mesh.position.copy(cam.position); mesh.updateMatrixWorld(); };

  // ---- per frame
  const lightDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), windDir = new THREE.Vector2();
  const bufferSize = new THREE.Vector2();
  const sunColor = [0, 0, 0], T = [0, 0, 0];
  const moonColor = new THREE.Vector3();
  let time = 0;
  const out = { sunColor: [0, 0, 0], skyIrradiance: [0, 0, 0], horizon: [0, 0, 0], keyIsMoon: false, moonColor, keyDir: lightDir };

  /**
   * @param {number} dt
   * @param {object} o  sunDir (the REAL sun, from the engine's clock — may be below the horizon),
   *                    moonDir (optional: Tidewater's moon, opposite the sun, if absent),
   *                    drawingBufferSize (Vector2, optional)
   */
  function update(dt, o) {
    time += dt;
    const s = o.sunDir;
    const night = THREE.MathUtils.smoothstep(-s.y, 0.02, 0.18);   // Tidewater App.updateSun
    if (o.moonDir) moonDir.copy(o.moonDir);
    else moonDir.set(-s.x, Math.abs(s.y) * 0.8 + 0.25, -s.z).normalize();
    const keyIsMoon = s.y <= -0.07;
    lightDir.copy(keyIsMoon ? moonDir : s);
    moonColor.set(0.6, 0.7, 1.0).multiplyScalar(0.12 * night);

    atmosphere.update({ dt, cameraY: camera.position.y, sunDir: s, moonDir, starIntensity: night, night, time, sunDiskIntensity: 1 });

    // Tidewater applyAtmosphereReadback: the sun at sea level x its illuminance x a horizon fade
    atmosphere.sunColorAt(0, s.y, T);
    const fade = THREE.MathUtils.smoothstep(s.y, -0.03, 0.02);
    sunColor[0] = T[0] * fade; sunColor[1] = T[1] * fade; sunColor[2] = T[2] * fade;
    const irr = atmosphere.skyIrradiance || [0, 0, 0];
    const nA = 0.012 * night;
    const skyIrr = [irr[0] + nA * 0.6, irr[1] + nA * 0.7, irr[2] + nA];

    if (o.drawingBufferSize) bufferSize.copy(o.drawingBufferSize);
    else renderer.getDrawingBufferSize(bufferSize);
    const wr = THREE.MathUtils.degToRad(P.windDeg);
    windDir.set(Math.cos(wr), Math.sin(wr));
    clouds.coverage.value = P.coverage;
    clouds.windSpeed.value = P.windSpeed;
    clouds.horizonMask = !!P.horizonMask;
    camera.updateMatrixWorld();
    clouds.update(dt, camera, {
      sunDir: s, lightDir, moonColor, windDir, drawingBufferSize: bufferSize,
      nightAmbient: [skyIrr[0] * night, skyIrr[1] * night, skyIrr[2] * night],
    });
    cirrus.amount.value = P.cirrus;
    cirrus.altitude.value = P.cirrusAlt;
    cirrus.update(dt, camera, { lightDir, sunDir: s, moonE: moonColor, coverage: P.coverage, windDir, windSpeed: P.windSpeed });
    uPxAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / Math.max(1, bufferSize.y);

    const keyLight = keyIsMoon ? moonColor : new THREE.Vector3(...sunColor);
    ground.set(P.groundAlbedo);
    uKey.value.copy(keyLight);
    uKeyDir.value.copy(lightDir);
    uFloor.value.set(ground.r, ground.g, ground.b);
    uCloudMean.value = 1 - 0.6 * P.coverage;
    uHaze.value = Math.max(0, P.haze);
    env.update({ lightDir, sunColor: keyLight, cloudMean: 1 - 0.6 * P.coverage, groundAlbedo: [ground.r, ground.g, ground.b] });

    out.sunColor[0] = sunColor[0]; out.sunColor[1] = sunColor[1]; out.sunColor[2] = sunColor[2];
    out.skyIrradiance = skyIrr;
    out.horizon = atmosphere.horizon || [0, 0, 0];
    out.keyIsMoon = keyIsMoon;
  }

  // ---- the air haze and sun shafts, on the engine's linear HDR frame
  const haze = createAirHaze({ renderer, atmosphere, clouds });
  const uInvVP = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  // the world view direction at this pixel (the haze's god-ray mask reads the cloud view with it)
  const viewDir = Fn(() => {
    const ndc = vec2(screenUV.x.mul(2.0).sub(1.0), float(1.0).sub(screenUV.y.mul(2.0)));
    const p = uInvVP.mul(vec4(ndc, 0.5, 1.0));
    return normalize(p.xyz.div(p.w).sub(uCamPos));
  });
  // the hazed frame is copied back into the engine's target (a pass cannot read what it writes)
  const copySrc = texture(new THREE.Texture());
  const copyMat = new THREE.MeshBasicNodeMaterial();
  copyMat.fragmentNode = copySrc.sample(uv()).level(0);   // render-target to render-target: uv(), see the haze
  copyMat.depthTest = false; copyMat.depthWrite = false;
  const copyQuad = new THREE.QuadMesh(copyMat);
  const keyVec = new THREE.Vector3();

  /**
   * @param {THREE.RenderTarget} rt  the linear HDR frame (read, then overwritten)
   * @param {object} o  depthTex (the scene depth), light + shadowDepth (optional: a directional
   *                    light whose shadow camera matches that depth map), size (Vector2),
   *                    seaLevel (m: where the marine haze layer sits; 0 without a sea)
   */
  function postProcess(rt, o) {
    if (!(P.haze > 0)) return;
    haze.params.enabled = true;
    haze.params.density = P.haze;
    haze.params.shafts = P.shafts;
    haze.params.godRays = !!P.godRays;
    camera.updateMatrixWorld();
    uInvVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    uCamPos.value.copy(camera.position);
    keyVec.copy(uKey.value);
    if (o.size) bufferSize.copy(o.size);
    const hazed = haze.render({
      colorTex: rt.texture, depthTex: o.depthTex, camera, light: o.light, shadowDepth: o.shadowDepth,
      sunDir: lightDir, sunColor: keyVec, size: bufferSize, viewDir, seaLevel: o.seaLevel ?? 0,
    });
    if (hazed === rt.texture) return;
    copySrc.value = hazed;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    copyQuad.render(renderer);
    renderer.setRenderTarget(prev);
  }

  const ready = clouds.ready;

  function dispose() {
    mesh.geometry.dispose();
    material.dispose();
    env.target?.dispose?.();
  }

  return {
    mesh, params: P, ready, update, dispose, postProcess, haze,
    light: () => out,
    cloudShadow: {
      texture: clouds.textures.shadowMap,
      center: clouds.shadowUniforms.center,
      size: clouds.shadowUniforms.size,
      strength: clouds.shadowUniforms.strength,
    },
    get environment() { return env.texture; },
    atmosphere, clouds, cirrus, env,
  };
}
void vec2; void vec3; void float;
