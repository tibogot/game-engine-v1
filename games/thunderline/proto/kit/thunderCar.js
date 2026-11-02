// THE THUNDERLINE CAR (assets-src/car/thunder_car.glb: our rework of "Saba V12 '95 - Low poly model" by
// DanielZhabotinsky, CC BY — credit it in the game). Loaded into the SAME slots as the Lotus
// (chassisModel.js / wheelModel.js), so the old car's physics drives it unchanged:
//   - the body, turned to the chassis frame's +Z front and dropped so the file's wheel centres
//     (±0.92, 0.374, ±1.40, built on the Lotus hard points) sit on the physics hubs (±0.92, −0.1, ±1.40)
//   - one wheel template (the file's front-left wheel, turned to face +X like the right side)
//   - the lamps the car drives: brake lights (Brakelights, TailBar) and headlamp lenses (Headlights,
//     DRL_L, DRL_R), and the headlamp spot mounts in chassis space
// Optimised (scratchpad optimise_car.py, then tools/optimizeGlb.mjs: KTX2 + meshopt): LOD0 ~29k tris,
// ~16 draws; LOD1 ~8k for the ghost; a ShadowProxy hull that alone (with the tyres) casts shadows.
// Sources: assets-src/car/thunder_car.glb, thunder_car_lod1.glb (the uncompressed exports).
import * as THREE from "three";
import { getSharedGltfLoader, initGlbLoaderRenderer } from "../../../../v3/render/foliage/glbLoader.js";
import { WHEEL_LOCAL, HEADLIGHTS } from "../../../../v3/play/modularRoadVehicle.js";
import { applyBloomMRT } from "../../../../v3/render/bloomMRT.js";
import { CAR_TUNE } from "./carTune.js";
import { texture, color, max, smoothstep, mix, clamp, uniform, float, dot, pow, normalView, positionViewDirection } from "three/tsl";

// THE PAINT (user, 2026-10-29: "the car texture is kind of dark, make it yellow"): the livery texture's dark blue body
// recoloured to `body` (its shading kept: the texture's brightness, relative to the blue's), its bright cyan stripes to
// `stripe`. A colour here, not a new texture: no source of the livery is kept.
export const PAINT = { body: 0xffc21a, stripe: 0x15161a, navy: 0.045, metal: 0.35, nightRim: 0.15, rimPower: 3 };
// THE CAR AT NIGHT (2026-11-02): under the night sky the paint read as a black silhouette from the chase camera — the old
// game's answer (modular-road-v3 CAR_NIGHT): a fresnel rim on the paint, faded in by the sky's night (updateThunderLamps).
// The paint's own colour at grazing angles, as if the sky caught its edges: no light, no shader change between day and night.
const NIGHT_RIM = uniform(0);

export const THUNDER_CAR_URL = "/models/thunderline/thunder_car.glb";
export const THUNDER_CAR_LOD1_URL = "/models/thunderline/thunder_car_lod1.glb";
const FILE_WHEEL_Y = 0.374; // the file's wheel centre height (its ground is y = 0)

const cache = new Map(); // url -> Promise<gltf>
/**
 * Through the engine's SHARED glTF loader (KTX2 textures + meshopt geometry: v3/TEXTURE_COMPRESSION.md).
 * @returns {Promise<{ chassis: {object, brakeLights, headlampLenses, headlampMounts}, wheel: {object, radius, width} }>}
 */
export function loadThunderCar(renderer, url = THUNDER_CAR_URL) {
  initGlbLoaderRenderer(renderer);
  if (!cache.has(url)) cache.set(url, getSharedGltfLoader().loadAsync(url));
  return cache.get(url).then((gltf) => build(gltf.scene.clone(true), url === THUNDER_CAR_URL));
}

function build(root, lit = true) {
  const hubY = WHEEL_LOCAL[0].pos.y;
  const object = new THREE.Group();
  object.name = "ThunderCarGLB";
  const body = new THREE.Group();
  body.rotation.y = Math.PI; // the file's front is −Z; the chassis frame's front is +Z
  body.position.y = hubY - FILE_WHEEL_Y;
  body.add(root);
  object.add(body);

  // the wheels leave the body: the car spins and steers its own copies of one template
  // the TOP-LEVEL wheel nodes only: a multi-material wheel loads as a group "Wheel_FL" whose meshes are
  // named "Wheel_FL_1"… too — taking those emptied the template (the wheels were invisible)
  const wheels = [];
  root.traverse((o) => { if (/^Wheel_/.test(o.name) && !/^Wheel_/.test(o.parent?.name ?? "")) wheels.push(o); });
  const src = wheels.find((w) => w.name === "Wheel_FL") ?? wheels[0];
  // THE BRAKES RIDE WITH THEIR WHEEL (user, 2026-10-29: "when the wheel moves with the suspension, does the rest of
  // the wheel move too?"): disc + caliper sit on the upright — up and down with the wheel, turned with the steering,
  // never spun. Kept: each brake's offset from its wheel's centre in the file (root frame); the car places them
  // (arcadeCar.js syncVisuals: object.userData.brakes)
  object.updateMatrixWorld(true);
  const wheelAt = new Map(wheels.map((w) => [w.name.replace(/^Wheel_/, ""), root.worldToLocal(w.getWorldPosition(new THREE.Vector3()))]));
  const brakes = [];
  root.traverse((o) => {
    const m = /^Brake_(FL|FR|RL|RR)$/.exec(o.name);
    if (!m || !wheelAt.has(m[1]) || o.parent !== root) return;
    brakes.push({ obj: o, corner: m[1], offset: o.position.clone().sub(wheelAt.get(m[1])), quat: o.quaternion.clone() });
  });
  object.userData.brakes = brakes;
  object.userData.root = root;
  for (const w of wheels) w.removeFromParent();
  const wheelRoot = src.clone(true);
  wheelRoot.position.set(0, 0, 0);
  wheelRoot.rotation.set(0, Math.PI, 0); // the left wheel's face turned outward on the right, like the template the car expects
  const wheel = new THREE.Group();
  wheel.name = "ThunderWheel";
  wheel.add(wheelRoot);
  wheel.updateMatrixWorld(true);
  // SIZED TO THE PHYSICS WHEEL (carTune.js): loading a wheel model also sets the car's physics radius, a
  // shared global — this file's own wheel made the builder's prediction, the drive page and the tests
  // roll on a different wheel from the one they were tuned on (the White tier's Halfpipe fell off, its
  // laps drifted; bisected to 6131488f, 2026-10-20). The model is scaled to the tuned radius instead.
  let ws = new THREE.Box3().setFromObject(wheel).getSize(new THREE.Vector3());
  const fit = CAR_TUNE.wheel.radius / (ws.y / 2);
  wheel.scale.setScalar(fit);
  wheel.updateMatrixWorld(true);
  ws = new THREE.Box3().setFromObject(wheel).getSize(new THREE.Vector3());
  wheel.userData.fit = fit;
  // (the tyre AND the rim cast: a tyre is a ring — alone its shadow had a hole, "the shadow of the wheel being hollow",
  // user 2026-10-29. This file's rim is the "WheelAtlas" material, not named rim)
  wheel.traverse((o) => { if (o.isMesh) { o.castShadow = /tyre|tire|rim|wheel/i.test(`${o.material?.name}`); o.receiveShadow = false; } });
  // THE TYRE IS INSIDE-OUT in the file (864 of its 1008 triangles and their normals face inward). On a
  // DoubleSide node material that still draws, but faceDirection turns the shading normal INTO the rubber,
  // so it caught only the light from behind and read tan. Turned right side out once per loaded geometry
  // (clones share it): winding reversed, normals negated.
  // OPEN (TODO.md): the tyre still reads tan in the drive page's light, not yet explained — neither the
  // KTX2 copy, the metal/rough map nor the winding is the cause.
  wheel.traverse((o) => {
    if (!o.isMesh || !/tyre|tire/i.test(o.material?.name ?? "")) return;
    turnOutward(o.geometry);
    o.material.metalness = 0;
    o.material.roughness = 0.85;
  });

  // lamps and shadows
  const brakeLights = [], headlampLenses = [];
  // SHADOWS: only the ShadowProxy hull casts (with the tyres, set on the wheel template above) — every
  // body part casting cost one draw per part per shadow cascade (57 casters). The proxy draws nothing
  // in the view: no colour, no depth.
  const hidden = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (/^ShadowProxy/.test(o.name) || /^ShadowProxy/.test(o.parent?.name ?? "")) { o.material = hidden; o.castShadow = true; o.receiveShadow = false; return; }
    o.castShadow = false;
    o.receiveShadow = true;
    if (o.material?.name === "ThunderPaint") o.material = paintMaterial(o.material);
    if (lit && LAMP_OF[o.material?.name]) o.material = lampMaterial(o.material, LAMP_OF[o.material.name]);
    if (/^(Brakelights|TailBar)/.test(o.name)) brakeLights.push(o);
    if (/^(Headlights|DRL_)/.test(o.name)) headlampLenses.push(o);
  });
  object.updateMatrixWorld(true);
  // the two headlamp spots: the left and right halves of the Headlights mesh, in chassis space
  const head = headlampLenses.find((m) => /^Headlights/.test(m.name));
  let headlampMounts = null;
  if (head) {
    const b = new THREE.Box3().setFromObject(head);
    const c = b.getCenter(new THREE.Vector3()), hx = (b.max.x - b.min.x) / 4;
    headlampMounts = [new THREE.Vector3(c.x - hx, c.y, b.max.z), new THREE.Vector3(c.x + hx, c.y, b.max.z)];
  }
  return {
    // (lit: the lamps are ours — updateThunderLamps — and the vehicle's own lamp lists stay empty)
    chassis: { object, brakeLights: lit ? [] : brakeLights, headlampLenses: lit ? [] : headlampLenses, headlampMounts, lamps: lit },
    wheel: { object: wheel, radius: ws.y / 2, width: ws.x },
  };
}

const painted = new WeakMap(); // the file's material → ours (clones share it)
function paintMaterial(m) {
  if (painted.has(m)) return painted.get(m);
  const n = new THREE.MeshPhysicalNodeMaterial();
  for (const k of ["name", "side", "metalnessMap", "roughnessMap", "metalness", "roughness", "normalMap", "clearcoat", "clearcoatRoughness", "envMapIntensity"]) if (m[k] !== undefined) n[k] = m[k];
  if (m.normalScale) n.normalScale.copy(m.normalScale);
  n.metalness = PAINT.metal; // (× the file's metalness map: fully metallic, yellow read as mustard gold)
  const c = texture(m.map).rgb; // (linear: the map is sRGB-tagged)
  const lum = max(c.r, max(c.g, c.b));
  const stripe = smoothstep(0.1, 0.25, c.g); // the navy body has almost no green; the cyan stripes a lot
  const body = color(PAINT.body).mul(clamp(lum.div(PAINT.navy), 0.35, 1.25));
  n.colorNode = mix(body, color(PAINT.stripe), stripe);
  const facing = clamp(dot(normalView, positionViewDirection), 0, 1);
  n.emissiveNode = n.colorNode.mul(pow(float(1).sub(facing), PAINT.rimPower)).mul(NIGHT_RIM);
  n.userData.source = m;
  painted.set(m, n);
  return n;
}

/** Reverse a geometry's winding and negate its normals, once (the flag survives the clones sharing it). */
function turnOutward(geo) {
  if (geo.userData.turnedOutward) return;
  geo.userData.turnedOutward = true;
  const ix = geo.index;
  for (let t = 0; t < ix.count; t += 3) { const b = ix.getX(t + 1); ix.setX(t + 1, ix.getX(t + 2)); ix.setX(t + 2, b); }
  ix.needsUpdate = true;
  const n = geo.attributes.normal;
  for (let i = 0; i < n.array.length; i++) n.array[i] = -n.array[i]; // quantized int16: -32767..32767 negates exactly
  n.needsUpdate = true;
}

// ---------------------------------------------------------------- THE LAMPS
// (user, 2026-11-02: "some nice lights … as best as possible … very optimized"). The file's lamp glass, one material
// per lamp FUNCTION, each glowing by one shared colour uniform (colour × brightness) into the selective bloom's
// emissive buffer: switching a lamp is a uniform write, never a shader change. Five functions:
//   drl     the day-running light bars: the car's signature, always lit (brighter at night)
//   head    the headlamp glass: lit with the beams (the vehicle's spot lights, HEADLIGHTS)
//   tail    the tail lamp housings: with the headlights; up a step under braking
//   stop    the stop strip: dark until you brake — braking lights a different AREA, not just a brighter one
//   reverse white, while the car rolls backwards
// The amber blinkers stay plain glass. Brightness = emissive before tone mapping (bloom threshold 0).
export const LAMPS = {
  drl: { color: 0xdaf6ff, day: 2.2, night: 3.2 },
  head: { color: 0xeef4ff, on: 6 }, // (cool white LED, like the beams and the day-running bars)
  tail: { color: 0xff1a0a, day: 0, night: 2.4, brake: 4 },
  stop: { color: 0xff1206, brake: 12 },
  reverse: { color: 0xf2f5ff, on: 12 }, // (two small lamps in the bar: bright, or they read as nothing)
  attack: 0.04, release: 0.12, // s: LEDs, quick both ways (a hint of fade, never a flicker)
};
// THE BEAMS (the vehicle's two spot lights, HEADLIGHTS — set for this car by driveSession): nearly level, a slow falloff and
// a soft edge, so the road lights 60-100 m ahead at racing speed (the old aim, 11° down with decay 2, lit a hot blob ~8 m
// in front of the nose and nothing past it)
export const THUNDER_BEAM = { color: "#eef4ff", intensity: 120, decay: 1, distance: 150, angle: 0.5, penumbra: 0.75, aimDrop: 0.8, aimForward: 16 };
const LAMP_OF = { DRL: "drl", Headlights: "head", TailRed: "tail", BrakeRed: "stop", ReverseWhite: "reverse" };
const LAMP_U = Object.fromEntries(Object.keys(LAMP_OF).map((k) => [LAMP_OF[k], uniform(new THREE.Color(0, 0, 0))]));
const lampLevel = { drl: 0, head: 0, tail: 0, stop: 0, reverse: 0 };
const lamped = new WeakMap(); // the file's material → ours (clones share it)
function lampMaterial(m, fn) {
  if (lamped.has(m)) return lamped.get(m);
  const n = new THREE.MeshStandardNodeMaterial();
  for (const k of ["name", "side", "map", "roughness", "metalness", "roughnessMap", "metalnessMap", "normalMap", "transparent", "opacity", "envMapIntensity"]) if (m[k] !== undefined && m[k] !== null) n[k] = m[k];
  n.color.copy(m.color);
  // the glass, dark when off (the file's lamp colours are bright: they read as lit at noon)
  n.color.multiplyScalar(fn === "drl" || fn === "head" || fn === "reverse" ? 0.35 : 0.5);
  let glow = LAMP_U[fn];
  // (the headlamp glass: its projector pattern — by the map's BLUE: the white projectors glow, the amber marker shapes the
  // same map paints on the bonnet and the bumper stay dark: they read as orange triangles lit on the bonnet, user 11-02)
  if (m.emissiveMap) glow = glow.mul(smoothstep(0.55, 0.95, texture(m.emissiveMap).b));
  n.emissiveNode = glow;
  applyBloomMRT(n, glow);
  lamped.set(m, n);
  return n;
}
const _fwd = new THREE.Vector3();
/**
 * Once a frame, the car's lamps from what it does: the headlights' switch (HEADLIGHTS.enabled), the brake pedal, rolling
 * backwards; `night` 0–1 (the sky's). Five uniform writes.
 */
export function updateThunderLamps(vehicle, night, dt) {
  const L = LAMPS, inp = vehicle.input ?? {};
  _fwd.set(0, 0, 1).applyQuaternion(vehicle.body.quat);
  const vF = vehicle.body.vel.dot(_fwd), pedal = (inp.throttle ?? 0) < 0;
  // the brake pedal: S while rolling forward (or still: held, before it backs up), or the handbrake
  const braking = !!inp.handbrake || (pedal && vF > -0.5);
  const reversing = vF <= -0.5 && (inp.throttle ?? 0) <= 0; // (in reverse: backing up, or rolling back off the pedal)
  const head = HEADLIGHTS.enabled;
  NIGHT_RIM.value = PAINT.nightRim * night;
  const want = {
    drl: L.drl.day + (L.drl.night - L.drl.day) * night,
    head: head ? L.head.on : 0,
    tail: braking ? L.tail.brake : head ? L.tail.night : L.tail.day,
    stop: braking ? L.stop.brake : 0,
    reverse: reversing ? L.reverse.on : 0,
  };
  for (const k in want) {
    const a = lampLevel[k], b = want[k];
    const t = Math.min(1, dt / (b > a ? L.attack : L.release));
    const v = Math.abs(b - a) < 1e-3 ? b : a + (b - a) * t;
    lampLevel[k] = v;
    LAMP_U[k].value.set(L[k].color).multiplyScalar(v);
  }
}
