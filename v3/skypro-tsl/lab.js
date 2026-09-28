// Sky Pro TSL lab: the Sky Pro sky mode's modules (v3/render/skypro/ — Tidewater's atmosphere, the Sky
// Pro cumulus, the cirrus, the haze and shafts, the sky environment) on three.js / TSL, over a small lab
// world (./labScene.js). Same panel, camera buttons and grade as the reference lab
// (v3/skypro-real-lab.html), so the two can be compared shot for shot — one tab at a time.
// Units are Tidewater's (sun illuminance 11), so its exposure (0.55) and auto-exposure target (0.25) apply as is.

import * as THREE from "three/webgpu";
import {
  Fn, uniform, vec2, vec3, vec4, float, normalize, max, mix, exp, select, smoothstep, dot, length, pow,
  screenUV, screenCoordinate, fract, sin, texture, textureStore, uvec2, localId, wgsl, wgslFn,
} from "three/tsl";
import { createSkyProAtmosphere } from "../render/skypro/skyproAtmosphere.js";
import { createSkyProClouds } from "../render/skypro/skyproClouds.js";
import { createCirrus, clOver } from "../render/skypro/skyproCirrus.js";
import { createAirHaze } from "../render/skypro/skyproHaze.js";
import { createSkyEnvironment } from "../render/skypro/skyproEnv.js";
import { createLabScene } from "./labScene.js";

const status = document.getElementById("status");
const say = (t) => { status.textContent = t; };

const settings = {
  timeOfDay: 16.2,
  sunAzimuth: 0,
  timeSpeed: 0,
  exposureEV: 0,
  autoExposure: true,
  coverage: 0.49,
  windDeg: Math.atan2(0.94, 0.35) * 180 / Math.PI,
  windSpeed: 12, // Tidewater; the Sky Pro preset's own drift is 89
  lightResetDeg: 2.56, // = Sky Pro (the dense trace while the sun moves is what fixes the drag)
  horizonMask: false, // true = Tidewater's below-horizon mask (the reference's look)
  cirrus: 0.5, // Tidewater Clouds.js default (0 = off)
  cirrusAlt: 9000,
  haze: 1.6, // Tidewater default: a humid tropical day, ~12 km visibility (0 = clear air)
  skyLight: true, // the sky + clouds as the environment (envTSL.js); off = the stand-in ambient
  shafts: 1.0, // sun shafts / god rays (0 = off)
  ground: true,
  renderScale: 1,
};

// Tidewater Sky.js sunDirectionFromTime (+x east, -z north, +y up)
function sunDirectionFromTime(hours, latitudeDeg = 24, declinationDeg = 6, out = new THREE.Vector3()) {
  const phi = THREE.MathUtils.degToRad(latitudeDeg);
  const dec = THREE.MathUtils.degToRad(declinationDeg);
  const H = THREE.MathUtils.degToRad((hours - 12) * 15);
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(H);
  const up = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  return out.set(east, up, -north).normalize();
}

// ------------------------------------------------------------------ GPU timer (every pass on the device)
class GpuTimer {
  constructor(device) {
    this.device = device;
    this.enabled = device.features.has("timestamp-query");
    this.ms = 0; this.passes = []; this._samples = []; this._labels = [];
    if (!this.enabled) return;
    const MAX = this.MAX = 256;
    this.querySet = device.createQuerySet({ type: "timestamp", count: MAX * 2 });
    this.resolve = device.createBuffer({ size: MAX * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.ring = Array.from({ length: 4 }, () => ({ buffer: device.createBuffer({ size: MAX * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false }));
    const self = this, proto = GPUCommandEncoder.prototype;
    const rp = proto.beginRenderPass, cp = proto.beginComputePass;
    const tag = (desc, kind) => {
      if (self._labels.length >= MAX || (desc && desc.timestampWrites)) return desc;
      const i = self._labels.length;
      self._labels.push((desc && desc.label) || kind);
      return { ...(desc || {}), timestampWrites: { querySet: self.querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } };
    };
    proto.beginRenderPass = function (desc) { return rp.call(this, tag(desc, "render")); };
    proto.beginComputePass = function (desc) { return cp.call(this, tag(desc, "compute")); };
  }
  // after everything of the frame was submitted
  endFrame() {
    if (!this.enabled) return;
    const n = this._labels.length, labels = this._labels;
    this._labels = [];
    if (!n) return;
    const slot = this.ring.find((s) => !s.busy);
    if (!slot) return;
    slot.busy = true;
    const enc = this.device.createCommandEncoder();
    enc.resolveQuerySet(this.querySet, 0, n * 2, this.resolve, 0);
    enc.copyBufferToBuffer(this.resolve, 0, slot.buffer, 0, n * 16);
    this.device.queue.submit([enc.finish()]);
    slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigInt64Array(slot.buffer.getMappedRange().slice(0, n * 16));
      slot.buffer.unmap();
      slot.busy = false;
      this._result(labels, t);
    }).catch(() => { slot.busy = false; });
  }
  _result(labels, t) {
    let first = null, last = null;
    const per = new Map();
    for (let i = 0; i < labels.length; i++) {
      const a = t[i * 2], b = t[i * 2 + 1];
      if (b <= 0n || b < a) continue;
      if (first === null || a < first) first = a;
      if (last === null || b > last) last = b;
      per.set(labels[i], (per.get(labels[i]) || 0) + Number(b - a) / 1e6);
    }
    if (first === null) return;
    // SUM of the passes, not last end - first begin: three submits every compute separately, and the
    // idle gaps between submits are not GPU work (they tripled the span in the first measurements)
    let busy = 0;
    for (const v of per.values()) busy += v;
    this._samples.push({ total: busy, per });
    if (this._samples.length > 60) this._samples.shift();
    const tot = this._samples.map((s) => s.total).sort((x, y) => x - y);
    this.ms = tot[tot.length >> 1];
    const acc = new Map();
    for (const s of this._samples) for (const [k, v] of s.per) acc.set(k, (acc.get(k) || 0) + v / this._samples.length);
    this.passes = [...acc].sort((x, y) => y[1] - x[1]);
  }
}

// ------------------------------------------------------------------ free camera (same as the reference lab)
class FlyCamera {
  constructor(camera, dom) {
    this.camera = camera;
    camera.rotation.order = "YXZ";
    this.yaw = 0; this.pitch = 0.12;
    this.keys = new Set();
    this.speed = 60;
    dom.addEventListener("pointerdown", (e) => { if (e.button === 0) dom.requestPointerLock?.(); });
    document.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.55, 1.55);
    });
    window.addEventListener("keydown", (e) => { if (!(e.target instanceof HTMLInputElement)) this.keys.add(e.code); });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }
  update(dt) {
    const k = this.keys, c = this.camera;
    c.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const boost = k.has("ShiftLeft") || k.has("ShiftRight") ? 12 : 1;
    const v = this.speed * boost * dt;
    if (k.has("KeyW")) c.position.addScaledVector(fwd, v);
    if (k.has("KeyS")) c.position.addScaledVector(fwd, -v);
    if (k.has("KeyD")) c.position.addScaledVector(right, v);
    if (k.has("KeyA")) c.position.addScaledVector(right, -v);
    if (k.has("KeyE") || k.has("Space")) c.position.y += v;
    if (k.has("KeyQ") || k.has("KeyC")) c.position.y -= v;
    c.position.y = Math.max(c.position.y, 1.0);
  }
  look(yawDeg, pitchDeg) {
    this.yaw = THREE.MathUtils.degToRad(yawDeg);
    this.pitch = THREE.MathUtils.degToRad(pitchDeg);
  }
}

async function main() {
  if (!navigator.gpu) { say("WebGPU is not available in this browser."); return; }
  say("Starting WebGPU…");
  const adapter = await navigator.gpu.requestAdapter();
  const want = ["timestamp-query", "float32-filterable"].filter((x) => adapter.features.has(x));
  const device = await adapter.requestDevice({ requiredFeatures: want });
  const timer = new GpuTimer(device);

  const renderer = new THREE.WebGPURenderer({ antialias: false, device });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.autoClear = false; // the sky pass and the scene share the HDR target
  renderer.shadowMap.enabled = true;
  document.getElementById("app").appendChild(renderer.domElement);
  await renderer.init();

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.06, 60000);
  camera.position.set(0, 2, 0);
  const fly = new FlyCamera(camera, renderer.domElement);

  say("Building the atmosphere…");
  const atmo = createSkyProAtmosphere({ renderer });
  const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), lightDir = new THREE.Vector3();
  atmo.update({ dt: 0, cameraY: camera.position.y, sunDir: sunDirectionFromTime(settings.timeOfDay, 24, 6, sunDir) });

  say("Loading the cloud noise…");
  const clouds = createSkyProClouds({ renderer, atmosphere: atmo });
  await clouds.ready;
  say("Baking the cirrus…");
  const cirrus = createCirrus({ renderer, atmosphere: atmo });
  const world = createLabScene({ clouds, atmosphere: atmo });
  const haze = createAirHaze({ renderer, atmosphere: atmo, clouds });
  const env = createSkyEnvironment({ renderer, atmosphere: atmo, clouds, cirrus, groundAlbedo: world.GROUND_ALBEDO });

  // ---- the view: sky + clouds (+ lab ground), Tidewater's grade, ACES by the renderer
  const uInvVP = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  const uLight = uniform(new THREE.Vector3(0, 1, 0));
  const uSunColor = uniform(new THREE.Vector3(1, 1, 1));
  const uGround = uniform(1);
  const uFrame = uniform(0);
  const uPxAngle = uniform(0.001); // one pixel's angle (rad): the cirrus fibres are filtered by it
  const albedo = vec3(0.33, 0.29, 0.22);

  const viewDir = Fn(() => {
    const ndc = vec2(screenUV.x.mul(2.0).sub(1.0), float(1.0).sub(screenUV.y.mul(2.0)));
    const p = uInvVP.mul(vec4(ndc, 0.5, 1.0));
    return normalize(p.xyz.div(p.w).sub(uCamPos));
  });

  const hash = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));

  // 1) HDR view (sky, clouds, lab ground) -> hdrRT;  2) 1/16 copy -> meterRT -> auto exposure
  // (Tidewater PostFX._buildMeter, one 256-thread workgroup);  3) grade + ACES -> the canvas
  const display = Fn(() => {
    const dir = viewDir().toVar();
    // Tidewater Sky.js skyViewRadiance: everything behind the clouds + the moon, the sun's disc apart
    const base = atmo.skyBackground(dir).add(atmo.moon(dir));
    const sun = atmo.sunDisk(dir);
    const c = clouds.viewSample(dir).toVar();
    // cumulus in front of the cirrus veil (Clouds.js clOver), then over the sky; the sun's disc is
    // dimmed by both
    const all = clOver(c, cirrus.sample(dir, uPxAngle)).toVar();
    const sky = base.mul(all.a).add(sun.mul(clouds.sunTransmittance(all.a))).add(all.rgb);

    // LAB ONLY: flat sea-level ground to see the cloud shadows on (as in the reference lab)
    const t = uCamPos.y.negate().div(dir.y.min(-1e-4));
    const P = uCamPos.add(dir.mul(t));
    const direct = uSunColor.mul(uLight.y.max(0.0)).mul(clouds.shadowAt(P.xz)).div(Math.PI); // Lambert: / PI (Tidewater lighting.js)
    // sky light = the sky's irradiance integrated from our sky-view LUT (Tidewater's frame.skyIrradiance)
    const g = albedo.mul(direct.add(atmo.irradianceNode));
    const hz = atmo.skyLuminance(normalize(vec3(dir.x, 0.02, dir.z)));
    const k = float(1.0).sub(exp(t.div(-12000.0)));
    const groundCol = mix(g, hz, k);
    const useGround = uGround.greaterThan(0.5).and(dir.y.lessThan(-1e-4)).and(uCamPos.y.greaterThan(0.0));
    // the clouds between the camera and the ground (seen from above the deck) lie over it
    const groundWithClouds = groundCol.mul(c.a).add(c.rgb);
    return vec4(select(useGround, groundWithClouds, sky), 1.0);
  });

  // the view: sky pass, then the scene (depth kept for the haze)
  const hdrRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, depthTexture: new THREE.DepthTexture(1, 1) });
  const viewSrcDown = texture(hdrRT.texture), viewSrcFinal = texture(hdrRT.texture); // .value = the hazed view
  const meterRT = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });

  const downMat = new THREE.MeshBasicNodeMaterial();
  downMat.colorNode = viewSrcDown;
  const downQuad = new THREE.QuadMesh(downMat);

  // auto exposure: ping-pong 1x1 textures (read last frame's value, write this frame's)
  const expTex = [0, 1].map(() => {
    const t = new THREE.StorageTexture(1, 1);
    t.type = THREE.HalfFloatType;
    t.minFilter = t.magFilter = THREE.NearestFilter;
    return t;
  });
  const uAE0 = uniform(new THREE.Vector4(1, 0.25, 0.6, 6.0)); // enabled, refLum, min, max (Tidewater's)
  const uAE1 = uniform(new THREE.Vector4(1.6, 1.1, 1 / 60, 0)); // up, down, dt, night
  const WG = 256;
  let reduce = "";
  for (let s = WG / 2; s > 0; s >>= 1) reduce += `
	if ( t < ${s}u ) {
		aeSumL[ t ] += aeSumL[ t + ${s}u ];
		aeSumW[ t ] += aeSumW[ t + ${s}u ];
	}
	workgroupBarrier();`;
  const meterShared = wgsl(`var<workgroup> aeSumL: array<f32, ${WG}>;\nvar<workgroup> aeSumW: array<f32, ${WG}>;\n`);
  // Tidewater's meter, verbatim but for the I/O (a return value instead of a storage buffer)
  const meterFn = wgslFn(/* wgsl */`
fn aeMeter( t: u32, aeTex: texture_2d<f32>, prevTex: texture_2d<f32>, p0: vec4f, p1: vec4f ) -> vec4f {
	let size = textureDimensions( aeTex );
	let n = size.x * size.y;
	var accL = 0.0; var accW = 0.0;
	for ( var i = 0u; i < 160u; i++ ) {
		let idx = t + i * ${WG}u;
		if ( idx < n ) {
			let x = idx % size.x; let y = idx / size.x;
			let c = textureLoad( aeTex, vec2i( i32( x ), i32( y ) ), 0 ).rgb;
			let l = log2( max( dot( c, vec3f( 0.2126, 0.7152, 0.0722 ) ), 1e-4 ) );
			let uvc = vec2f( ( f32( x ) + 0.5 ) / f32( size.x ), ( f32( y ) + 0.5 ) / f32( size.y ) ) - 0.5;
			let w = max( 1.0 - length( uvc * vec2f( 1.0, 1.4 ) ) * 1.2, 0.15 );
			accL += l * w;
			accW += w;
		}
	}
	aeSumL[ t ] = accL;
	aeSumW[ t ] = accW;
	workgroupBarrier();
${reduce}
	let avg = exp2( aeSumL[ 0 ] / max( aeSumW[ 0 ], 1e-4 ) );
	let ratio = p0.y / avg;
	let partial = select( ratio, pow( ratio, 0.8 ), ratio > 1.0 );
	let tgt = clamp( partial, p0.z, mix( p0.w, 2.0, p1.w ) );
	let prev = textureLoad( prevTex, vec2i( 0 ), 0 ).x;
	let cur = select( 1.0, prev, prev > 0.0 );
	let rate = select( p1.y, p1.x, tgt > cur );
	let k = 1.0 - exp( - p1.z * rate );
	let next = exp2( mix( log2( max( cur, 1e-3 ) ), log2( tgt ), k ) );
	return vec4f( select( 1.0, next, p0.x > 0.5 ) );
}`, [meterShared]);
  // every thread writes the same value (sumL[0] is visible to all after the last barrier), so the
  // store needs no branch and the barriers stay in uniform control flow
  const meterPasses = [0, 1].map((k) => Fn(() => {
    textureStore(expTex[k], uvec2(0, 0), meterFn(localId.x, texture(meterRT.texture), texture(expTex[1 - k]), uAE0, uAE1));
  })().compute([1, 1, 1], [WG, 1, 1]).setName("Auto Exposure"));
  const expNode = texture(expTex[0]);
  let aeK = 0;

  const finalMat = new THREE.MeshBasicNodeMaterial();
  finalMat.colorNode = Fn(() => {
    const col = viewSrcFinal.rgb.mul(expNode.sample(vec2(0.5)).level(0).x).toVar();
    // Tidewater PostFX grade (warmth, saturation, contrast, vignette, grain); ACES = the renderer's
    col.assign(col.mul(vec3(1.02, 1.0, 0.98)));
    const l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col.assign(mix(vec3(l), col, 1.06));
    col.assign(pow(max(col, vec3(0.0)).div(0.18), vec3(1.04)).mul(0.18));
    const dv = screenUV.sub(0.5).mul(vec2(1.0, 0.8));
    col.assign(col.mul(float(1.0).sub(smoothstep(0.25, 0.75, length(dv)).mul(0.28))));
    const px = screenCoordinate.xy.add(uFrame.mul(vec2(17.0, 29.0)));
    const n = hash(px).add(hash(px.add(vec2(7.919, 1.0473)))).sub(1.0).mul(0.5);
    col.assign(col.add(col.mul(n.mul(0.012))));
    return vec4(col, 1.0);
  })();
  const finalQuad = new THREE.QuadMesh(finalMat);

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = display();
  material.depthTest = false; material.depthWrite = false;
  const quad = new THREE.QuadMesh(material);

  say("Compiling shaders…");

  // ---- panel
  const resize = () => {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * settings.renderScale);
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  buildPanel({ settings, clouds, fly, camera, resize, timer, extraPasses: [...meterPasses, ...Object.values(atmo.passes)] });

  const bufferSize = new THREE.Vector2();
  const T = [0, 0, 0];
  const up = new THREE.Vector3(0, 1, 0);
  let last = performance.now();
  let first = true;
  let simTime = 0;

  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (settings.timeSpeed !== 0) settings.timeOfDay = (settings.timeOfDay + dt * settings.timeSpeed + 24) % 24;
    fly.update(dt);

    // sun / moon, as Tidewater's App.updateSun + applyAtmosphereReadback
    sunDirectionFromTime(settings.timeOfDay, 24, 6, sunDir).applyAxisAngle(up, THREE.MathUtils.degToRad(settings.sunAzimuth));
    const night = THREE.MathUtils.smoothstep(-sunDir.y, 0.02, 0.18);
    moonDir.set(-sunDir.x, Math.abs(sunDir.y) * 0.8 + 0.25, -sunDir.z).normalize();
    lightDir.copy(sunDir.y > -0.07 ? sunDir : moonDir);
    simTime += dt;
    atmo.update({ dt, cameraY: camera.position.y, sunDir, moonDir, starIntensity: night, night, time: simTime, sunDiskIntensity: 1 });
    const moonColor = new THREE.Vector3(0.6, 0.7, 1.0).multiplyScalar(0.12 * night);
    if (sunDir.y > -0.07) {
      // Tidewater applyAtmosphereReadback: sea-level transmittance x SUN_ILLUMINANCE x a horizon fade
      atmo.sunColorAt(0, sunDir.y, T);
      const fade = THREE.MathUtils.smoothstep(sunDir.y, -0.03, 0.02);
      uSunColor.value.set(T[0] * fade, T[1] * fade, T[2] * fade);
    } else uSunColor.value.copy(moonColor);
    uLight.value.copy(lightDir);
    // Tidewater: frame.skyIrradiance (sky E/PI + a night floor) x night, for the clouds' night ambient
    const irr = atmo.skyIrradiance || [0, 0, 0], nA = 0.012 * night;
    const nightAmb = [(irr[0] + nA * 0.6) * night, (irr[1] + nA * 0.7) * night, (irr[2] + nA) * night];

    clouds.coverage.value = settings.coverage;
    clouds.windSpeed.value = settings.windSpeed;
    clouds.lightResetDeg = settings.lightResetDeg;
    clouds.horizonMask = settings.horizonMask;
    clouds.resolutionScale = 1;
    const wr = THREE.MathUtils.degToRad(settings.windDeg);
    renderer.getDrawingBufferSize(bufferSize);
    camera.updateMatrixWorld();
    clouds.update(dt, camera, {
      sunDir, lightDir, night, moonColor,
      windDir: new THREE.Vector2(Math.cos(wr), Math.sin(wr)),
      nightAmbient: nightAmb,
      drawingBufferSize: bufferSize,
    });

    uInvVP.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    uCamPos.value.copy(camera.position);
    uGround.value = settings.ground ? 1 : 0;
    uPxAngle.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / bufferSize.y;
    cirrus.amount.value = settings.cirrus;
    cirrus.altitude.value = settings.cirrusAlt;
    cirrus.update(dt, camera, {
      lightDir, sunDir, moonE: moonColor, coverage: settings.coverage,
      windDir: new THREE.Vector2(Math.cos(wr), Math.sin(wr)), windSpeed: settings.windSpeed,
    });
    uFrame.value = (uFrame.value + 1) % 1024;
    renderer.toneMappingExposure = 0.55 * Math.pow(2, settings.exposureEV);

    const w = bufferSize.x, h = bufferSize.y;
    if (hdrRT.width !== w || hdrRT.height !== h) {
      hdrRT.setSize(w, h);
      meterRT.setSize(Math.max(1, w >> 4), Math.max(1, h >> 4));
    }
    world.update(camera, lightDir, uSunColor.value);
    // the sky environment (LAB: the ground's mean cloud shadow from the coverage, crudely)
    env.update({ lightDir, sunColor: uSunColor.value, cloudMean: 1 - 0.6 * settings.coverage });
    world.setEnvironment(settings.skyLight ? env.texture : null);
    renderer.setRenderTarget(hdrRT);
    renderer.clear();
    quad.render(renderer);
    renderer.render(world.scene, camera);
    haze.params.density = settings.haze;
    haze.params.shafts = settings.shafts;
    haze.params.enabled = settings.haze > 0 || settings.shafts > 0;
    const hazed = haze.render({
      colorTex: hdrRT.texture, depthTex: hdrRT.depthTexture, camera, light: world.sun, shadowDepth: world.shadowDepth,
      sunDir: lightDir, trueSunDir: sunDir, sunColor: uSunColor.value, size: bufferSize, viewDir,
    });
    viewSrcDown.value = hazed;
    viewSrcFinal.value = hazed;
    renderer.setRenderTarget(meterRT);
    downQuad.render(renderer);
    renderer.setRenderTarget(null);
    uAE0.value.x = settings.autoExposure ? 1 : 0;
    uAE1.value.z = dt;
    uAE1.value.w = night;
    renderer.compute(meterPasses[aeK]);
    expNode.value = expTex[aeK];
    aeK = 1 - aeK;
    finalQuad.render(renderer);
    timer.endFrame();
    if (first) { first = false; say(""); }
  };

  window.__skyProTSL = { renderer, camera, atmo, clouds, cirrus, haze, env, world, settings, timer, fly, THREE, tsl: await import("three/tsl") };
  renderer.setAnimationLoop(frame);
}

// ------------------------------------------------------------------ panel (same as the reference lab)
function buildPanel({ settings, clouds, fly, camera, resize, timer, extraPasses = [] }) {
  const panel = document.getElementById("panel");
  const row = (label, input, out) => {
    const r = document.createElement("label");
    r.className = "row";
    const s = document.createElement("span");
    s.textContent = label;
    r.append(s, input);
    if (out) r.append(out);
    panel.append(r);
  };
  const slider = (label, key, min, max, step, fmt = (v) => v.toFixed(2), onInput = null) => {
    const i = document.createElement("input");
    i.type = "range"; i.min = min; i.max = max; i.step = step; i.value = settings[key];
    const o = document.createElement("output");
    const show = () => { o.textContent = fmt(Number(settings[key])); };
    i.addEventListener("input", () => { settings[key] = Number(i.value); show(); if (onInput) onInput(); });
    show();
    row(label, i, o);
    return { input: i, show };
  };
  const check = (label, key) => {
    const i = document.createElement("input");
    i.type = "checkbox"; i.checked = settings[key];
    i.addEventListener("change", () => { settings[key] = i.checked; });
    row(label, i);
  };
  const h = (t) => { const e = document.createElement("h3"); e.textContent = t; panel.append(e); };
  const hhmm = (v) => `${String(Math.floor(v)).padStart(2, "0")}:${String(Math.floor((v % 1) * 60)).padStart(2, "0")}`;

  h("Sun");
  const tod = slider("Time of day", "timeOfDay", 0, 24, 0.01, hhmm);
  slider("Sun azimuth", "sunAzimuth", -180, 180, 1, (v) => `${v.toFixed(0)}°`);
  slider("Time speed", "timeSpeed", 0, 2, 0.01, (v) => `${v.toFixed(2)} h/s`);
  h("Clouds (Partly cloudy preset)");
  slider("Coverage", "coverage", 0, 1, 0.01);
  slider("Wind direction", "windDeg", -180, 180, 1, (v) => `${v.toFixed(0)}°`);
  slider("Wind speed", "windSpeed", 0, 100, 1, (v) => `${v.toFixed(0)} m/s`);
  slider("Sun-move reset", "lightResetDeg", 2.56, 30, 0.5, (v) => `${v.toFixed(1)}°`);
  check("Horizon mask (ref)", "horizonMask");
  h("Air (Tidewater AirHaze.js)");
  slider("Haze", "haze", 0, 4, 0.05);
  slider("Sun shafts", "shafts", 0, 3, 0.05);
  check("Sky light (env)", "skyLight");
  h("Cirrus (Tidewater Clouds.js)");
  slider("Cirrus", "cirrus", 0, 3, 0.01); // Tidewater range 0..1; above 1 = a thicker veil than it allows
  slider("Cirrus altitude", "cirrusAlt", 6000, 13000, 100, (v) => `${(v / 1000).toFixed(1)} km`);
  h("Output");
  slider("Exposure", "exposureEV", -3, 3, 0.1, (v) => `${v.toFixed(1)} EV`);
  check("Auto exposure", "autoExposure");
  slider("Render scale", "renderScale", 0.5, 1, 0.05, (v) => v.toFixed(2), resize);
  check("Ground (lab only)", "ground");

  h("Camera");
  const views = document.createElement("div");
  views.className = "views";
  const view = (label, y, yaw, pitch) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => {
      camera.position.set(0, y, 0);
      fly.look(yaw, pitch);
      clouds.resetHistory();
    });
    views.append(b);
  };
  view("Ground 2 m", 2, 0, 12);
  view("Toward sun", 2, 90, 8);
  view("RTS 130 m", 130, 0, -35);
  view("High 2 km", 2000, 0, 5);
  view("In the deck 6 km", 6000, 0, 0);
  view("Above 11 km", 11000, 0, -20);
  panel.append(views);

  const stats = document.createElement("pre");
  stats.id = "stats";
  panel.append(stats);
  const help = document.createElement("p");
  help.className = "help";
  help.textContent = "Click the view to look (Esc releases). WASD / ZQSD move, E/Space up, Q/C down, Shift x12.";
  panel.append(help);

  let acc = 0, frames = 0, last = performance.now();
  const tick = () => {
    const now = performance.now();
    acc += now - last; frames++; last = now;
    if (acc > 500) {
      const ms = acc / frames;
      acc = 0; frames = 0;
      const p = camera.position;
      let s = `frame  ${ms.toFixed(2)} ms (wall, vsync-bound)\n`;
      s += timer.enabled ? `GPU    ${timer.ms.toFixed(2)} ms (sum of passes, median of 60)\n` : "GPU    n/a (no timestamp-query)\n";
      // three labels compute passes computeGroup_<node id>; name them after our compute nodes
      const names = {};
      const P = clouds.passes;
      for (const n of [P.weatherPass, P.boundsPass, P.panoPass, P.shadowPass, P.tracePass, ...P.resolvePasses, ...extraPasses]) if (n) names[n.id] = n.name;
      const nameOf = (k) => k.replace(/^computeGroup_(\d+)$/, (m, id) => names[id] || m).replace(/^render$/, "Sky + view (render)");
      for (const [k, v] of timer.passes.slice(0, 9)) s += `  ${nameOf(k).padEnd(22).slice(0, 22)} ${v.toFixed(3)}\n`;
      s += `cam    ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} m`;
      stats.textContent = s;
      if (settings.timeSpeed !== 0) { tod.input.value = settings.timeOfDay; tod.show(); }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((e) => {
  console.error(e);
  say("Failed: " + e.message);
});
