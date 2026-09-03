/**
 * Lighting: a clamp-on basking lamp, window daylight, and the day/night cycle.
 *
 * The scene is lit the way a real vivarium is lit, and that turns out to matter more
 * than any shader here. A terrarium has ONE hard, hot, local key light hanging over one
 * end, and a large soft cool fill from the room. That contrast — a bright basking spot
 * with a long shadow, falling off into cool shade at the far end — is the entire visual
 * identity of the object. Lighting it evenly makes an expensive glass box look like a
 * product render of nothing.
 *
 * The night state is not "the same lights, dimmer". Keepers swap to a deep red night
 * bulb, so at night the tank is lit red from above and blue from the room, with the
 * window gone. Interpolating brightness alone would miss the entire look.
 */
import * as THREE from "three/webgpu";
import { TANK } from "./terrariumGlass.js";
import { BASK, substrateHeight } from "./terrariumSubstrate.js";

export const LIGHT_DEFAULTS = {
  dayNight: 1.0,

  // CANDELA, not lumens, and the difference cost an hour of chasing the wrong bug.
  //
  // Setting SpotLight.power = 1400 (a plausible basking bulb) gives intensity = power/PI
  // = 445 cd. At 45 cm that is E = 445 / 0.45² ≈ 2200, and a 0.14-albedo rock renders at
  // albedo·E/PI ≈ 98 — about 7 stops past white. Every surface under the lamp clipped,
  // which looked exactly like a broken shader: flat white patches with no detail. I
  // darkened the soil and then the stone twice chasing it before measuring the light.
  //
  // Three's photometric units are correct; the scene is just SMALL. Irradiance falls as
  // 1/d², so a lamp 45 cm from its subject needs single-digit candela to land near 1.0
  // the way an outdoor sun at intensity ~3 does. Real lumens would need the exposure
  // compensation a real camera applies — so the honest knob here is intensity.
  lampIntensity: 6.2,
  lampAngle: 0.52,       // radians, half-cone
  lampHeight: 0.60,
  // Deliberately generous. The lamp is a hard local key with a 1/d² falloff across a
  // 90 cm box, so without a strong ambient base the cool end reads as pure black rather
  // than as shade — the tank needs the room in it, not just the bulb.
  windowPower: 3.4,
  fill: 0.95,
};

const DAY_LAMP = new THREE.Color(0xffc78a);
const NIGHT_LAMP = new THREE.Color(0xff2f0c);
const DAY_WINDOW = new THREE.Color(0xd6e6ff);
const NIGHT_WINDOW = new THREE.Color(0x3a5f9e);
const DAY_SKY = new THREE.Color(0xbcd2f0);
const DAY_GROUND = new THREE.Color(0x6b5842);
const NIGHT_SKY = new THREE.Color(0x1a2436);
const NIGHT_GROUND = new THREE.Color(0x140f0c);

function buildFixture() {
  const group = new THREE.Group();
  group.name = "lamp-fixture";

  const metal = new THREE.MeshStandardNodeMaterial({
    color: 0xb9bcc0, metalness: 0.95, roughness: 0.28,
  });
  const dark = new THREE.MeshStandardNodeMaterial({
    color: 0x1d2024, metalness: 0.6, roughness: 0.55,
  });

  // Reflector dome. Open-ended cone, double sided so you see the bright inner surface
  // from below — that lit interior is most of what says "lamp" from the default camera.
  const dome = new THREE.Mesh(
    new THREE.CylinderGeometry(0.036, 0.088, 0.078, 40, 1, true),
    metal,
  );
  dome.material.side = THREE.DoubleSide;
  dome.castShadow = true;
  group.add(dome);

  // Bulb, hanging just inside the dome mouth.
  const bulbMat = new THREE.MeshStandardNodeMaterial({
    color: 0x0a0a0a, roughness: 0.25, metalness: 0,
    emissive: DAY_LAMP.clone(), emissiveIntensity: 8,
  });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.027, 24, 16), bulbMat);
  bulb.position.y = -0.018;
  group.add(bulb);

  // Cap and socket.
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.036, 0.022, 24), dark);
  cap.position.y = 0.048;
  cap.castShadow = true;
  group.add(cap);

  return { group, bulbMat, dome };
}

/**
 * The clamp arm. Purely set dressing, but a lamp floating unsupported over a tank is one
 * of those details that reads as "unfinished 3D scene" before you consciously notice why.
 */
function buildArm(lampPos) {
  const metal = new THREE.MeshStandardNodeMaterial({
    color: 0x9aa0a6, metalness: 0.92, roughness: 0.34,
  });
  const group = new THREE.Group();
  group.name = "lamp-arm";

  const back = -TANK.d / 2 - 0.045;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(lampPos.x, 0.02, back),
    new THREE.Vector3(lampPos.x, lampPos.y * 0.55, back),
    new THREE.Vector3(lampPos.x, lampPos.y + 0.075, back + 0.05),
    new THREE.Vector3(lampPos.x, lampPos.y + 0.085, lampPos.z - 0.03),
    new THREE.Vector3(lampPos.x, lampPos.y + 0.058, lampPos.z),
  ]);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.007, 12, false), metal);
  tube.castShadow = true;
  group.add(tube);

  // Table clamp.
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.055, 0.075), metal);
  clamp.position.set(lampPos.x, 0.026, back - 0.005);
  clamp.castShadow = true;
  group.add(clamp);

  return group;
}

export function createLighting(scene, params = LIGHT_DEFAULTS) {
  const state = { ...params };
  const group = new THREE.Group();
  group.name = "lighting";

  const lampPos = new THREE.Vector3(BASK.x, state.lampHeight, 0.02);
  const fixture = buildFixture();
  fixture.group.position.copy(lampPos);
  group.add(fixture.group);

  const arm = buildArm(lampPos);
  group.add(arm);

  // ── the basking lamp ──────────────────────────────────────────────────────────────
  const spot = new THREE.SpotLight(0xffffff, 1);
  spot.position.copy(lampPos).add(new THREE.Vector3(0, -0.018, 0));
  spot.angle = state.lampAngle;
  // Wide penumbra: a bare reflector dome is a big emitter relative to a 90 cm tank, so
  // its pool has a long soft edge. A tight penumbra draws a hard disc on the soil that
  // looks like a projected texture rather than like light.
  spot.penumbra = 0.85;
  spot.decay = 2;
  spot.distance = 0;
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  // At this scale the default shadow camera range is wildly wrong: the whole subject is
  // 60 cm from the light, so the depth precision has to be packed into that band.
  spot.shadow.camera.near = 0.08;
  spot.shadow.camera.far = 1.6;
  spot.shadow.bias = -0.00025;
  spot.shadow.normalBias = 0.0015;
  spot.target.position.set(BASK.x, substrateHeight(BASK.x, BASK.z), BASK.z);
  group.add(spot, spot.target);

  // ── daylight through the window ───────────────────────────────────────────────────
  // Directional rather than another spot: the window is metres away and its shadows are
  // effectively parallel across a 90 cm tank.
  const windowLight = new THREE.DirectionalLight(0xffffff, 1);
  windowLight.position.set(-1.6, 1.05, -0.55);
  windowLight.castShadow = true;
  windowLight.shadow.mapSize.set(2048, 2048);
  const s = 0.75;
  windowLight.shadow.camera.left = -s;
  windowLight.shadow.camera.right = s;
  windowLight.shadow.camera.top = s;
  windowLight.shadow.camera.bottom = -s;
  windowLight.shadow.camera.near = 0.1;
  windowLight.shadow.camera.far = 5;
  windowLight.shadow.bias = -0.0004;
  windowLight.shadow.normalBias = 0.002;
  windowLight.target.position.set(0.1, 0.05, 0);
  group.add(windowLight, windowLight.target);

  // ── fill ──────────────────────────────────────────────────────────────────────────
  // The environment map does most of the ambient work; this is a small directional bias
  // so the underside of things never goes fully black.
  const hemi = new THREE.HemisphereLight(DAY_SKY, DAY_GROUND, state.fill);
  group.add(hemi);

  scene.add(group);

  const _lampCol = new THREE.Color();
  const _winCol = new THREE.Color();

  function apply() {
    const d = THREE.MathUtils.clamp(state.dayNight, 0, 1);
    // Weighted so dusk holds for a while rather than snapping — the interesting looks
    // are all in the middle of this slider.
    const k = d * d * (3 - 2 * d);

    _lampCol.copy(NIGHT_LAMP).lerp(DAY_LAMP, k);
    spot.color.copy(_lampCol);
    // The night bulb is genuinely dimmer, not just redder: it exists to warm, not light.
    spot.intensity = state.lampIntensity * (0.22 + 0.78 * k);
    spot.angle = state.lampAngle;

    _winCol.copy(NIGHT_WINDOW).lerp(DAY_WINDOW, k);
    windowLight.color.copy(_winCol);
    // The night floor is not physical, it is legibility. Cut the window to nearly zero
    // and the tank goes genuinely black — correct for an unlit room at 3am, and useless
    // for a game the player is meant to keep watching. This keeps a cold rim on the
    // glass and the substrate so the enclosure still reads as an object.
    windowLight.intensity = state.windowPower * (0.16 + 0.84 * k);

    hemi.color.copy(NIGHT_SKY).lerp(DAY_SKY, k);
    hemi.groundColor.copy(NIGHT_GROUND).lerp(DAY_GROUND, k);
    hemi.intensity = state.fill * (0.40 + 0.60 * k);

    fixture.bulbMat.emissive.copy(_lampCol);
    fixture.bulbMat.emissiveIntensity = 3 + 9 * k;

    const y = state.lampHeight;
    fixture.group.position.y = y;
    spot.position.y = y - 0.018;
  }
  apply();

  return {
    group, spot, windowLight, hemi, fixture, lampPos,
    state,
    set(key, value) { state[key] = value; apply(); },
    apply,
  };
}
