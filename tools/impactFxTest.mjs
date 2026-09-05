// IMPACT FEEDBACK — the camera acknowledging a landing, and staying out of the
// physics while it does.
//
// Two effects, both presentation only: a short shake when the car comes down
// hard, and a FOV punch when it leaves the ground fast. The whole risk of this
// kind of feature is that it stops being feedback and becomes a fault — it
// twitches on kerbs, it outlives the impact, it tilts the horizon, or it quietly
// gets into the simulation. So each of those is a check.
//
//   node tools/impactFxTest.mjs
import * as THREE from "three";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
const { ModularRoadBuilder, CATEGORY_PRESETS } = await import(
  pathToFileURL(join(GAME, "modularRoadBuilder.js")).href);
const { createChaseCamera, CHASE_CAM: CAM } = await import(
  pathToFileURL(join(GAME, "chaseCamera.js")).href);

const TMP = join(ROOT, `.impactfx.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(
  pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const START = 70;
const R2D = 180 / Math.PI;
const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);

let fail = 0;
const check = (name, ok, note = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
};

/* ── A PLAIN STRAIGHT ROAD ────────────────────────────────────────────────── */
// Flat, so the only thing that can produce an impact is the drop height, and
// the control run has nothing to trip over.

function build(ramp = false) {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  const tile = (id) => {
    for (const list of Object.values(CATEGORY_PRESETS)) {
      const t = list.find((x) => x.id === id);
      if (t) return t.preset ?? t;
    }
    throw new Error(`no tile ${id}`);
  };
  b.setSnap({ enabled: true, step: 8, yawDeg: 15 });
  b.beginNewChain(new THREE.Vector3(0, START, 0), 0, { exact: true });
  b.setActivePiece("start"); b.place();
  b.setActivePreset(tile("straight_long"));
  for (let i = 0; i < 3; i++) b.place();
  if (ramp) { b.setActivePreset(tile("ramp_40")); b.place(); }
  b.setActivePreset(tile("straight_long"));
  for (let i = 0; i < 3; i++) b.place();
  return b;
}

function bakeGround(b) {
  b.scene.updateMatrixWorld(true);
  const decks = [];
  for (const p of b.pieces) {
    const m = p.mesh;
    if (!m || m.userData.noCollision) continue;
    const proxy = m.userData.collisionGeometry;
    decks.push(proxy
      ? { geometry: proxy, matrixWorld: m.matrixWorld, userData: m.userData, updateMatrixWorld() {} }
      : m);
  }
  const d = new RoadBvh(); d.bakeFromMeshes(decks);
  const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
  g.setRoadBvh(d);
  return g;
}

/**
 * Drop the car from `drop` metres onto the flat road and watch what the camera
 * does about it. `params` goes to the rig, so the same run can be repeated with
 * the effect turned off for an exact A/B.
 */
function run({ drop = 0, seconds = 4, params = {}, ramp = false } = {}) {
  const b = build(ramp);
  const ground = bakeGround(b);
  const startM = b.pieces.find((p) => p.id === "start").connectorOut;
  const startRot = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().extractRotation(startM));
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(startRot);

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.groundBvh = ground.ground; car.solidsBvh = ground.solids;
  car.getFloorY = () => -1e4; car.enabled = true;
  car.body.pos.copy(pos(startM)).addScaledVector(fwd, 30);
  car.body.pos.y += WHEEL.radius + 0.25 + drop;
  car.body.quat.copy(startRot).multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  car.body.vel.copy(fwd).multiplyScalar(20);

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const chase = createChaseCamera({ camera, vehicle: car, params });
  chase.snap?.();

  const view = new THREE.Vector3();
  const _toCar = new THREE.Vector3();
  const frames = [];
  let impact = 0, peakTilt = 0, shakeEndsAt = null, landedAt = null, peakFov = 0;
  let t = 0, launched = false, wasGrounded = true;
  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 0.3, handbrake: false, yaw: 0, pitch: 0, airSteer: 0 });
    car._renderPos.copy(car.body.pos);
    car._renderQuat.copy(car.body.quat);
    if (car.landImpact > impact) { impact = car.landImpact; landedAt = t; }
    // The same edge the rig fires the punch on, tracked independently so the
    // check below cannot quietly pass on a run that never took off.
    const gnd = car.groundedCount > 0;
    if (wasGrounded && !gnd && car.body.vel.y > CAM.launchMinRise) launched = true;
    wasGrounded = gnd;
    chase.update(FIXED_DT);
    t += FIXED_DT;

    camera.getWorldDirection(view);
    // How far the horizon is off level, which is the artefact the rig has always
    // refused and the one a shake is most likely to reintroduce.
    const tilt = Math.abs(Math.asin(THREE.MathUtils.clamp(
      camera.up.clone().normalize().dot(
        new THREE.Vector3().crossVectors(view, new THREE.Vector3(0, 1, 0)).normalize()),
      -1, 1))) * R2D;
    if (landedAt !== null) {
      peakTilt = Math.max(peakTilt, tilt);
      // Measured off the shake's own envelope rather than off the horizon: the
      // horizon no longer moves at all, which is the point of the design but
      // leaves nothing to time.
      if (chase.state.shake > 0.02) shakeEndsAt = t;
    }
    peakFov = Math.max(peakFov, camera.fov);
    // Where the car sits relative to the view axis. `carBelowCentre` puts it a
    // fixed number of degrees below centre and NOTHING else in the rig is
    // allowed to move it — so this number is the framing, and it must be
    // untouched by anything here.
    const off = Math.acos(THREE.MathUtils.clamp(
      _toCar.copy(car.body.pos).sub(camera.position).normalize().dot(view), -1, 1)) * R2D;
    frames.push({ t, px: camera.position.x, py: camera.position.y, pz: camera.position.z,
      tilt, off, y: car.body.pos.y, fov: camera.fov });
  }
  return { impact, landedAt, peakTilt, shakeEndsAt, peakFov, frames, launched };
}

/* ── CHECKS ───────────────────────────────────────────────────────────────── */

console.log("\nIMPACT FEEDBACK\n");

const flat = run({ drop: 0 });
const flatOff = run({ drop: 0, params: { shakeMetres: 0 } });
const hard = run({ drop: 14 });
const off = run({ drop: 14, params: { shakeMetres: 0 } });

/** Worst per-frame difference in a field between a run and its shake-off twin. */
const worst = (a, b, key) => {
  let w = 0;
  for (let i = 0; i < Math.min(a.frames.length, b.frames.length); i++) {
    w = Math.max(w, Math.abs(a.frames[i][key] - b.frames[i][key]));
  }
  return w;
};
const camMoved = (a, b) => {
  let w = 0;
  for (let i = 0; i < Math.min(a.frames.length, b.frames.length); i++) {
    w = Math.max(w, Math.hypot(a.frames[i].px - b.frames[i].px,
      a.frames[i].py - b.frames[i].py, a.frames[i].pz - b.frames[i].pz));
  }
  return w;
};

const flatShook = camMoved(flat, flatOff);
const hardShook = camMoved(hard, off);
console.log(`  driving flat   impact ${flat.impact.toFixed(1)} m/s   `
  + `camera moved ${flatShook.toFixed(3)} m`);
console.log(`  14 m drop      impact ${hard.impact.toFixed(1)} m/s   `
  + `camera moved ${hardShook.toFixed(3)} m   `
  + `settles ${hard.shakeEndsAt !== null && hard.landedAt !== null
    ? (hard.shakeEndsAt - hard.landedAt).toFixed(2) : "n/a"}s after landing`);
console.log(`  framing        car held to ${worst(hard, off, "off").toExponential(1)}° `
  + `of its screen position through the shake`);
console.log(`  horizon        worst tilt ${hard.frames.reduce((m, f) => Math.max(m, f.tilt), 0)
  .toFixed(4)}°\n`);

check("a real landing is reported, and scaled by how hard it was",
  hard.impact > CAM.shakeFrom && hard.impact > flat.impact + 8,
  `${hard.impact.toFixed(1)} m/s off a 14 m drop vs ${flat.impact.toFixed(1)} driving flat`);

// The failure mode this guards is a camera that flinches at every seam.
check("ordinary driving does not shake it at all",
  flatShook === 0, `camera moved ${flatShook.toExponential(1)} m over `
  + `${flat.frames.length} frames on flat road`);

check("a hard landing does",
  hardShook > 0.02, `camera moved ${hardShook.toFixed(3)} m`);

// SCALED, not switched. The amplitude is the impact mapped through
// shakeFrom..shakeFull and then through the attack, so a heavier landing has to
// shake harder — a shake that is the same size for every impact stops carrying
// any information about what just happened.
const huge = run({ drop: 40, seconds: 6 });
const hugeOff = run({ drop: 40, seconds: 6, params: { shakeMetres: 0 } });
const hugeShook = camMoved(huge, hugeOff);
check("and it scales with the landing rather than being one fixed thump",
  hugeShook > hardShook * 1.5,
  `${hard.impact.toFixed(0)} m/s -> ${hardShook.toFixed(3)} m, `
  + `${huge.impact.toFixed(0)} m/s -> ${hugeShook.toFixed(3)} m`);

// THE TWO INVARIANTS. The rig holds the car at a FIXED screen position under an
// EXACTLY level horizon, and `chaseFramingTest` polices both across the whole
// kit. The first version of this feature rotated the VIEW and broke them both —
// 1.54° of framing drift and a 0.22° tilt on the jump ramp. Displacing the
// camera BEFORE the view is composed costs neither, and that is the whole
// reason the shake is built the way it is, so it is checked here too.
check("…and the car does not move on screen while it does",
  worst(hard, off, "off") < 1e-9,
  `held to ${worst(hard, off, "off").toExponential(1)}° of its framing`);

const worstTilt = hard.frames.reduce((m, f) => Math.max(m, f.tilt), 0);
check("…and the horizon stays exactly level",
  worstTilt < 1e-4, `worst tilt ${worstTilt.toExponential(1)}°`);

const settle = hard.shakeEndsAt !== null && hard.landedAt !== null
  ? hard.shakeEndsAt - hard.landedAt : 99;
check("and it is over almost immediately — a shake that outlives the impact is a fault",
  settle < 1.2, `${settle.toFixed(2)}s to settle (decay ${CAM.shakeDecay}s, attack ${CAM.shakeAttack}s)`);

// A/B AGAINST THE KICK TURNED OFF, on a run that actually leaves the ground.
// The speed FOV alone reaches 70° on a flat run, so any check of the form
// "the FOV got big" passes without the punch existing at all — which is what
// the first version of this check did.
const jump = run({ ramp: true, seconds: 14 });
const jumpOff = run({ ramp: true, seconds: 14, params: { launchFovKick: 0 } });
console.log(`  off a ramp     launched ${jump.launched}   `
  + `fov peak ${jump.peakFov.toFixed(1)}° vs ${jumpOff.peakFov.toFixed(1)}° with the punch off\n`);

check("the car actually leaves the ground on the ramp run",
  jump.launched, "otherwise the FOV check below proves nothing");

const punch = jump.peakFov - jumpOff.peakFov;
check("the launch punches the FOV",
  punch > 2, `+${punch.toFixed(1)}° over the same run with launchFovKick: 0`);

// DECAY MEASURED FROM THE PUNCH, not from the end of the run. The car comes off
// a 40 m ramp and is still in the air — or bouncing, and re-triggering — when a
// fixed-length run stops, so "is it back to normal at the end" tests how long
// the run was rather than how fast the punch bleeds off.
let peakAt = 0, peakDiff = 0;
const diffAt = (i) => jump.frames[i].fov - jumpOff.frames[i].fov;
for (let i = 0; i < Math.min(jump.frames.length, jumpOff.frames.length); i++) {
  if (diffAt(i) > peakDiff) { peakDiff = diffAt(i); peakAt = i; }
}
const want = peakAt + Math.round(3 * CAM.launchFovDecay / FIXED_DT);
const after = Math.min(jump.frames.length - 1, want);
const left = diffAt(after);
// Without this the check quietly measures how LONG THE RUN WAS: if the launch
// happens near the end, `after` clamps to the last frame and the punch has not
// had its three decay constants to bleed off. That is exactly what it did at
// 6 s — reporting +3.4° left and looking like a decay bug.
check("the run is long enough to see the punch decay",
  want <= jump.frames.length - 1,
  `needed ${(want * FIXED_DT).toFixed(1)}s of run, had ${(jump.frames.length * FIXED_DT).toFixed(1)}s`);
check("and it bleeds back off rather than sticking",
  left < peakDiff * 0.25,
  `+${peakDiff.toFixed(1)}° at the punch, +${left.toFixed(1)}° `
  + `${(3 * CAM.launchFovDecay).toFixed(2)}s later (three decay constants)`);

// AND IT STAYS OUT OF THE SIMULATION. The camera reads a number the vehicle
// publishes and never writes back, so the car's trajectory must be identical to
// the bit with the shake off — if it is not, presentation has got into physics.
const worstCar = worst(hard, off, "y");
check("it cannot get into the physics — same car, frame for frame",
  worstCar === 0, `worst difference in the car's height: ${worstCar.toExponential(1)} m`);

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall checks green\n");
process.exit(fail ? 1 : 0);
