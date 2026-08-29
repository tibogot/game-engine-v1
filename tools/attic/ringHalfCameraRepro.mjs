// THE ACTUAL CAUSE of "after a ring half the first 180° of roll swings the car
// through a big arc instead of rotating it about itself".
//
// It is not the physics. tools/ringHalfRollRepro.mjs bisected the whole air
// controller — heading hold, arc assist, landing assist, stabiliser, idle-axis
// damping — and NONE of them change the car's motion, the COM path is ballistic
// to 0.3 m/s², and tools/airRollRegimes.mjs shows a ramp jump leaves a LARGER
// stray rotation than a loop exit does and is not reported as broken.
//
// It is THE CAMERA. The chase rig blends between a world-frame rig and a
// CAR-FRAME rig, and the car-frame one places the camera along the car's own up
// axis:
//     _cDesired = pos − camFwd·dist + _carUp·height
// Going over the top of a ring half the car is inverted, so the blend is fully
// committed to that rig. The blend is then HELD for `loopAirHold` (0.35 s) after
// the wheels leave and released at `loopAirLerp` (1.2/s, τ = 0.83 s) — so for
// most of a second after the exit the camera is still pinned to the car's frame.
//
// Roll the car and `_carUp` sweeps with it, so THE CAMERA ORBITS THE CAR at
// hypot(dist, height) = 8.15 m. On screen that is indistinguishable from the car
// swinging through a wide arc about a pivot somewhere out in space — which is
// exactly how it was reported. By the time the blend has let go the car has
// rolled ~180°, and from then on it visibly rotates about itself.
//
// THERE ARE TWO SEPARATE ARTEFACTS HERE and it is worth keeping them apart,
// because fixing only the first one turns it into the second:
//
//   ORBIT — the camera dragged round by the roll. Reverses when the roll input
//           reverses. Reads as "the car swings through a big arc".
//   VAULT — the camera walking from below an inverted car to above it as the
//           loop blend unwinds (the two rigs are 2·height = 6.4 m apart while
//           inverted). Direction-independent. Reads as "the car is shoved down".
//
// Flipping the roll direction separates them cleanly, which is what the last
// section does. Measured: shipped is orbit 182° / vault −3°; releasing the blend
// on roll input (the first fix tried) trades that for orbit −1° / vault 176°,
// which was immediately reported as the car being pushed down. Freezing the
// rig's up-axis AND holding the blend until the roll finishes gets both to ~0,
// because a righted car makes the two rigs coincide and the handover is free.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const R2D = 57.2958;
/** Seconds after the exit to ignore, so the one-off rig handover is excluded. */
const SETTLE = 0.3;
const TMP = join(ROOT, `.ringcam.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, pieceParams } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { createChaseCamera } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/chaseCamera.js")).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

function buildRingHalf(runUp = 14) {
  const pp = { ...pieceParams, loopHalf: "in" };
  let conn = new THREE.Matrix4();
  const deck = [], rails = [];
  const push = (p) => {
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); deck.push(c);
    }
    if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); rails.push(r); }
  };
  for (let i = 0; i < runUp; i++) { const p = buildPiece("straight", conn, pp); push(p); conn = p.connectorOut; }
  push(buildPiece("loop_half", conn, pp));
  // A LANDING PAD. Without one the car sails off the top of the ring half into
  // the gap between the ring and the run-up and never touches down, so the
  // landing — which is where the remaining jump actually is — cannot be
  // measured at all. Ground at y=0 across the whole flight path, which is also
  // what the piece looks like in a real track: you come off the top inverted
  // and land on the floor.
  {
    const g = new THREE.PlaneGeometry(200, 260);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -130);
    deck.push(g);
  }
  const mk = (gs) => {
    if (!gs.length) return null;
    const b = new RoadBvh();
    const ms = gs.map((g) => { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.updateMatrixWorld(true); return m; });
    b.bakeFromMeshes(ms);
    return b.baked ? b : null;
  };
  return { deck: mk(deck), solids: mk(rails) };
}

/** Drive the ring half, hold roll off the top, and watch where the CAMERA goes. */
function run({ v0 = 45, secs = 14, patch = null, rollDir = -1 } = {}) {
  const track = buildRingHalf();
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  car.getFloorY = () => -200;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -4);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -v0);
  car._resetInterpolation();

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const chase = createChaseCamera({ camera, vehicle: car });
  if (patch) Object.assign(chase.params, patch);
  chase.reset();

  const fwd = new THREE.Vector3(), off = new THREE.Vector3();
  const ref = new THREE.Vector3(), prevOff = new THREE.Vector3();
  let airborne = false, tAir = 0, rolled = 0, swing = 0, sustained = 0, signed = 0, first = true;
  // How far the camera rises/falls relative to the car along WORLD up. A rig
  // handover moves the camera 2*height = 6.4 m vertically over an inverted
  // car, and against an unchanged ballistic path that reads as the CAR being
  // shoved downwards — the second bug, caused by fixing the first one badly.
  let hey0 = null, heyDrop = 0, landT = null;
  // Fastest the camera moves RELATIVE TO THE CAR, and the same restricted to
  // the landing. A smooth follow camera keeps both small; a rig snap spikes.
  const relPrev = new THREE.Vector3(); let relInit = false;
  let peakRel = 0, peakLandRel = 0;
  // WHAT THE PLAYER ACTUALLY SEES AT TOUCHDOWN: how far the camera sits above
  // the car, sampled from the moment the wheels land. `peakRel` cannot see this
  // — it is dominated by the CAR's own impact deceleration and reads ~21 m/s
  // whatever the camera does, which is why it showed no difference for any
  // camera parameter. The settle excursion below is the honest measure.
  let landH0 = null, landHMin = Infinity, landHMax = -Infinity;
  const rows = [];

  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    const grounded = car.tires.filter((t) => t.grounded).length;
    if (!airborne && grounded === 0 && car.body.pos.y > 20) airborne = true;
    car.tick({ steerTarget: airborne ? rollDir : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    // The chase rig follows the INTERPOLATED render pose, and that is only
    // written by syncVisuals — without this the camera chases a pose frozen at
    // the spawn point and trails the car by hundreds of metres.
    car.syncVisuals(FIXED_DT, 1);
    chase.update(FIXED_DT);
    if (!airborne) continue;
    tAir += FIXED_DT;
    // DO NOT STOP AT TOUCHDOWN. Deferring the rig handover to the landing is a
    // real failure mode (it just moves the jump), and an instrument that breaks
    // on `grounded` cannot see it — which is exactly how it got shipped once.
    const nowGrounded = car.tires.some((t) => t.grounded);
    if (nowGrounded && landT === null) landT = tAir;
    if (landT !== null && tAir > landT + 1.2) break;

    fwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    rolled += car.body.angVel.dot(fwd) * FIXED_DT;
    // Where the camera sits relative to the car, in the plane perpendicular to
    // the roll axis. If the camera is steady in the WORLD this barely moves; if
    // it is pinned to the car's frame it sweeps round with the roll.
    off.copy(camera.position).sub(car.body.pos);
    off.addScaledVector(fwd, -off.dot(fwd));
    if (first) { ref.copy(off).normalize(); prevOff.copy(off).normalize(); first = false; }
    else {
      const cur = off.clone().normalize();
      // Accumulate the signed angle stepped this frame — total path, not net.
      const step = Math.abs(Math.acos(THREE.MathUtils.clamp(cur.dot(prevOff), -1, 1))) * R2D;
      // SIGNED about the roll axis. An ORBIT (camera dragged round by the roll)
      // reverses with the roll direction; a VAULT (camera walking from below an
      // inverted car to above it as the blend unwinds) does not. Flipping the
      // input is therefore the clean way to tell the two apart.
      const sgn = Math.sign(prevOff.clone().cross(cur).dot(fwd)) || 0;
      signed += sgn * step;
      swing += step;
      // THE NUMBER THAT MATTERS. Handing the rig back from the car frame to the
      // world frame is a one-off sweep — the two rigs sit on opposite sides of
      // an inverted car, 6.4 m apart — and total path length cannot tell that
      // apart from the camera ORBITING WITH the roll, which is the actual
      // illusion. So ignore the settling transition and measure only what the
      // camera does for the REST of the roll: a world-fixed camera should sit
      // still there, and every degree it moves is a degree the car appears to
      // swing instead of rotating on the spot.
      if (tAir > SETTLE) sustained += step;
      prevOff.copy(cur);
    }
    {
      const hey = camera.position.y - car.body.pos.y;
      if (hey0 === null) hey0 = hey;
      heyDrop = Math.max(heyDrop, hey - hey0);
      const rel = camera.position.clone().sub(car.body.pos);
      if (relInit) {
        const spd = rel.distanceTo(relPrev) / FIXED_DT;
        // Strictly before touchdown vs from touchdown on — a fix that only
        // moves the handover from one to the other is not a fix.
        if (landT === null) peakRel = Math.max(peakRel, spd);
        else peakLandRel = Math.max(peakLandRel, spd);
      }
      relPrev.copy(rel); relInit = true;
      if (landT !== null) {
        const h = camera.position.y - car.body.pos.y;
        if (landH0 === null) landH0 = h;
        landHMin = Math.min(landHMin, h); landHMax = Math.max(landHMax, h);
      }
    }
    if (i % 8 === 0 && tAir < 2.0) {
      rows.push(`  ${tAir.toFixed(2).padStart(5)}  rolled ${(Math.abs(rolled) * R2D).toFixed(0).padStart(4)}°` +
        `   camera swing around car ${swing.toFixed(0).padStart(4)}°` +
        `   camera dist ${off.length().toFixed(1).padStart(4)} m`);
    }
  }
  const settle = landH0 === null ? 0 : Math.max(landHMax - landH0, landH0 - landHMin);
  return { swing, sustained, signed, heyDrop, peakRel, peakLandRel, settle,
    landH0: landH0 ?? 0, landHMin, landHMax, rolled: Math.abs(rolled) * R2D, rows };
}

console.log("Camera rig: dist 7.5 m, height 3.2 m ⇒ orbit radius hypot = 8.15 m");
console.log("loopAirHold 0.35 s, loopAirLerp 1.2 (τ 0.83 s)\n");

console.log("=== AS SHIPPED — camera swing around the car while the player rolls ===");
const base = run();
for (const line of base.rows) console.log(line);
console.log(`\n  total camera swing around the car: ${base.swing.toFixed(0)}°  ` +
  `while the car rolled ${base.rolled.toFixed(0)}°`);

console.log("\n=== IS IT THE LOOP-FOLLOW BLEND? ===");
// Release the blend the instant the wheels leave: the car-frame rig then stops
// being used the moment the trick starts.
const noHold = run({ patch: { loopAirHold: 0, loopAirLerp: 30 } });
console.log(`  blend released at once   camera swing ${noHold.swing.toFixed(0)}°  (car rolled ${noHold.rolled.toFixed(0)}°)`);
// And with the rig pinned to the world entirely.
const noLoop = run({ patch: { loopStart: -2, loopFull: -3 } });
console.log(`  loop-follow disabled     camera swing ${noLoop.swing.toFixed(0)}°  (car rolled ${noLoop.rolled.toFixed(0)}°)`);

// NOTE: `rollInput: 9` is how "shipped" is reproduced below — it pushes the
// deadzone past any possible input, so the rig-up freeze and the blend hold can
// never engage and the camera behaves exactly as it did before the fix.

console.log("\n=== BOTH PROPERTIES AT ONCE ===");
console.log("sustained = camera orbiting WITH the roll (the car appears to swing)");
console.log("cam rise   = camera climbing over the car (the car appears shoved DOWN)");
console.log("  variant                       sustained    cam rise vs car");
for (const [name, patch] of [
  ["shipped (before any fix)     ", { rollInput: 9 }],
  ["first fix (release the blend)", { rollInput: 9, loopAirHold: 0, loopAirLerp: 30 }],
  ["THIS FIX (freeze the rig up) ", null],
]) {
  const t = run({ patch });
  console.log(`  ${name}   ${t.sustained.toFixed(0).padStart(6)}°   ${t.heyDrop.toFixed(1).padStart(12)} m`);
}

console.log("\n=== ORBIT vs VAULT: flip the roll direction ===");
console.log("Signed camera rotation about the roll axis. An ORBIT reverses with the");
console.log("input (the camera is being dragged round by the roll — the reported bug);");
console.log("a VAULT is the same either way (the blend walking the camera over the car).");
console.log("  variant                        roll LEFT   roll RIGHT   orbit part");
for (const [name, patch] of [
  ["shipped (before any fix)     ", { rollInput: 9 }],
  ["THIS FIX (freeze the rig up) ", null],
]) {
  const l = run({ patch, rollDir: -1 }).signed;
  const r = run({ patch, rollDir: 1 }).signed;
  // The half-difference is the part that follows the input; the half-sum is the
  // direction-independent vault.
  console.log(`  ${name}   ${l.toFixed(0).padStart(9)}°   ${r.toFixed(0).padStart(10)}°   ${((l - r) / 2).toFixed(0).padStart(10)}°`);
}

console.log("\n=== THE LANDING ===");
console.log("How fast the camera moves RELATIVE TO THE CAR (m/s). This is the number a");
console.log("'smooth follow camera' has to keep small — a rig snap shows up as a spike,");
console.log("and deferring the handover to touchdown just relocates it there.");
console.log("  variant                       peak in flight   peak at landing");
for (const [name, patch] of [
  ["shipped (before any fix)     ", { rollInput: 9 }],
  ["THIS FIX                     ", null],
]) {
  const t = run({ patch });
  console.log(`  ${name}   ${t.peakRel.toFixed(1).padStart(11)}     ${t.peakLandRel.toFixed(1).padStart(13)}`);
}

console.log("\n=== PICKING rigUpLerp ===");
console.log("Ease the rig's up-axis to WORLD UP during the roll, so the two rigs");
console.log("converge and touchdown has nothing to snap. Too slow and it has not");
console.log("converged before landing; too fast and the traverse itself is a lurch.");
console.log("  rigUpLerp   in flight   at landing   orbit part");
for (const k of [0.8, 1.5, 2.5, 4, 6, 10]) {
  const a = run({ patch: { rigUpLerp: k }, rollDir: -1 });
  const b = run({ patch: { rigUpLerp: k }, rollDir: 1 });
  console.log(`  ${k.toFixed(1).padStart(9)}   ${a.peakRel.toFixed(1).padStart(9)}   ${a.peakLandRel.toFixed(1).padStart(10)}` +
    `   ${((a.signed - b.signed) / 2).toFixed(0).padStart(9)}°`);
}

console.log("\n=== AGAINST THE FLOOR ===");
console.log("The floor = loop-follow disabled outright: the best any change here can do,");
console.log("since it is a plain world-frame chase. If the landing spike is the same at");
console.log("the floor then it is the IMPACT (the car's fall arrested in a few frames,");
console.log("camera catching up), not a rig snap, and no camera change can remove it.");
console.log("  variant                     in flight   at landing   orbit part");
for (const [name, patch] of [
  ["shipped                    ", { rollInput: 9 }],
  ["THIS FIX                   ", null],
  ["floor (loop-follow off)    ", { loopStart: -2, loopFull: -3 }],
]) {
  const a = run({ patch, rollDir: -1 });
  const b = run({ patch, rollDir: 1 });
  console.log(`  ${name}   ${a.peakRel.toFixed(1).padStart(9)}   ${a.peakLandRel.toFixed(1).padStart(10)}` +
    `   ${((a.signed - b.signed) / 2).toFixed(0).padStart(9)}°`);
}

// NOTE ON THE `at landing` COLUMN ABOVE: it is ~21 m/s for EVERY variant, and
// that is not the camera — it is the CAR's own impact deceleration leaking into
// a relative-speed measure. It reads the same with loop-follow disabled and did
// not move for any camera parameter tried, so it must not be used to judge
// landing smoothness. The excursion below is the honest measure, and it is what
// caught an attempted "fix" (easing the lag-compensation vector) that actually
// made the landing 18x worse — 0.1 m of settle became 1.8 m.
console.log("\n=== WHAT THE LANDING ACTUALLY LOOKS LIKE ===");
console.log("Camera height above the car, from touchdown through the next 1.2 s.");
console.log("The excursion is the visible 'camera jumps at landing'; it should be small.");
console.log("  variant                  at touchdown    min     max   excursion");
for (const [name, patch] of [
  ["shipped                ", { rollInput: 9 }],
  ["THIS FIX               ", null],
  ["floor (loop-follow off)", { loopStart: -2, loopFull: -3 }],
]) {
  const t = run({ patch });
  console.log(`  ${name}   ${t.landH0.toFixed(1).padStart(11)}   ${t.landHMin.toFixed(1).padStart(5)}` +
    `   ${t.landHMax.toFixed(1).padStart(5)}   ${t.settle.toFixed(1).padStart(9)} m`);
}
