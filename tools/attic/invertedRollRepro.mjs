// Reported: near-inverted in the air, press roll to bring the car back onto its
// wheels, and it does not simply roll — it gets swung through a wide arc, "like
// the car is put in a position" instead of rotating about itself.
//
// NOT TUBE-SPECIFIC, and that was the key correction from the player: this drop
// is off FLAT GROUND with no tube and no ramp in it, and it reproduces. Tubes
// and big ramps just put you near-inverted more often than anything else does.
//
// THE SYMPTOM (shipped code before the fix). Inverted at 16 m, tap the roll key
// 0.35 s — about 11 deg of commanded roll — then release: the car rolled another
// 169 deg on its own, vs 37 with the assist off. Hold the key instead and the
// commanded -206 deg/s was bent to -192 -> -116 -> -12 -> +241 deg/s, chassis-up
// rocking 0.98/0.73/0.56/0.71. Two controllers wedging each other ~33 deg off
// level rather than one of them owning the axis.
//
// THE RULE THAT FIXED IT, set by the game's author: while roll is held, roll
// input owns the car and nothing else may rotate it. Implemented as an honest
// input yield (no `landingReassert`) plus an ATTITUDE GATE so the assist only
// ever TRIMS a car already within ~60 deg of level — it never performs the
// 90-180 deg recovery, because that recovery IS the orbit being complained
// about. See the note on TIRE.airLandInputYield for the four tuning-level fixes
// that were tried first and rejected.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.invroll.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const R2D = 57.2958;

console.log("=== SETUP ===");
console.log(`  airRollRate ${TIRE.airRollRate} rad/s (${(TIRE.airRollRate * R2D).toFixed(0)}°/s)`
  + `   airResponse ${TIRE.airResponse}   airSettle ${TIRE.airSettle}`);
console.log(`  airLandTorque ${TIRE.airLandTorque}  airLandDamp ${TIRE.airLandDamp}`
  + `  airLandTime ${TIRE.airLandTime}  pitchLevel ${TIRE.airLandPitchLevel}`);
console.log(`  airLandInputYield ${TIRE.airLandInputYield}   maxAngVel ${TIRE.maxAngVel}`);

const flat = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: 0, z: o.z }, distance: t, normal: { x: 0, y: 1, z: 0 }, faceIndex: 0 };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};
const noSolids = { baked: false, closestPointWithNormal: () => null };

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Car leaves a tube inverted, at height, still carrying the orbital roll rate.
 *
 * `roll0` is that residual: orbiting an r=8 tube with 20 m/s of circumferential
 * speed leaves 20/8 = 2.5 rad/s about the tube axis, which is roughly the
 * chassis forward axis on the way out.
 */
function invertedDrop({
  y0 = 16, fwd = 28, roll0 = 0, input = 1, secs = 3,
  landAssist = TIRE.airLandAssist, releaseAt = null,
}) {
  const save = TIRE.airLandAssist;
  TIRE.airLandAssist = landAssist;

  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = flat; c.solidsBvh = noSolids; c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, y0, 0);
  // Inverted: 180° about the chassis forward (+Z) axis.
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  c.body.vel.set(0, 0, fwd);
  _fwd.set(0, 0, 1).applyQuaternion(c.body.quat);
  c.body.angVel.copy(_fwd).multiplyScalar(roll0);

  let rollAccum = 0, peakRate = 0, peakEngage = 0;
  let landedAt = null, uprightAt = null;
  const rows = [];
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    const t = i * FIXED_DT;
    const held = releaseAt === null || t < releaseAt;
    c.tick({ steerTarget: held ? input : 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });

    _up.set(0, 1, 0).applyQuaternion(c.body.quat);
    _fwd.set(0, 0, 1).applyQuaternion(c.body.quat);
    const rate = c.body.angVel.dot(_fwd);           // roll rate about chassis forward
    rollAccum += rate * FIXED_DT;
    if (Math.abs(rate) > Math.abs(peakRate)) peakRate = rate;
    peakEngage = Math.max(peakEngage, c._landEngage ?? 0);
    if (uprightAt === null && _up.y > 0.95) uprightAt = t;
    if (landedAt === null && c.groundedCount > 0) landedAt = t;
    if (i % Math.round(0.1 / FIXED_DT) === 0) {
      rows.push({
        t, y: c.body.pos.y, upY: _up.y, rate,
        deg: rollAccum * R2D, eng: c._landEngage ?? 0, g: c.groundedCount,
      });
    }
  }
  TIRE.airLandAssist = save;
  return {
    rollDeg: rollAccum * R2D, peakRate, peakEngage, landedAt, uprightAt,
    finalUpY: _up.y, rows,
  };
}


console.log("");
console.log("=== THE RULE: WHILE ROLL IS HELD, ONLY ROLL HAPPENS ===");
console.log("  Inverted at 16 m, roll held all the way down. The assist must be");
console.log("  completely out of the loop (engage 0) and the rate must track the");
console.log("  commanded " + Math.round(TIRE.airRollRate * R2D) + " deg/s.");
console.log("");
console.log("   config        peak engage   rate @0.6s  @1.0s  @1.4s   final upY");
for (const [label, la] of [["assist ON", 1], ["assist OFF", 0]]) {
  const r = invertedDrop({ roll0: 2.5, landAssist: la });
  const at = (t) => {
    const s = r.rows.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b), r.rows[0]);
    return Math.round(s.rate * R2D).toString().padStart(6);
  };
  console.log(
    "   " + label.padEnd(12)
    + "  " + r.peakEngage.toFixed(2).padStart(10)
    + "   " + at(0.6) + " " + at(1.0) + " " + at(1.4)
    + "    " + r.finalUpY.toFixed(2).padStart(6),
  );
}
console.log("");
console.log("  Identical columns = the assist is not touching a held roll, which is");
console.log("  the whole rule. Landing tilted because you held roll into the ground");
console.log("  is now the player's outcome by design.");
console.log("");

console.log("=== INVERTED NEAR A SURFACE: THE PHANTOM CONTACT ===");
console.log("  ground.raycastFirst treats TERRAIN as a vertical projection and ignores");
console.log("  the ray DIRECTION. Inverted, the wheel probe starts 0.6 m along");
console.log("  chassis-up (= world DOWN) and casts along chassis-down (= world UP),");
console.log("  yet the terrain still reports a hit at |origin.y - groundY|. The");
console.log("  suspension then pushes along chassis-up, which is world DOWN.");
console.log("");
console.log("  Car held INVERTED at height h, one tick, no input:");
console.log("");
console.log("      h     compression   susp force   accel beyond gravity   verdict");
for (const h of [12, 4, 2.2, 1.6, 1.2, 0.9]) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = flat; c.solidsBvh = noSolids; c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, h, 0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
  c.body.vel.set(0, 0, 20);
  c.body.angVel.set(0, 0, 0);
  const vy0 = c.body.vel.y;
  c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  const aExtra = (c.body.vel.y - vy0) / FIXED_DT + 9.81;
  let comp = 0, susp = 0, gr = 0;
  for (const t of c.tires) {
    if (!t.grounded) continue;
    gr++; comp = Math.max(comp, t.compression); susp += t.lastSuspension.length();
  }
  console.log(
    "   " + h.toFixed(1).padStart(5)
    + "   " + comp.toFixed(3).padStart(11)
    + "   " + (susp / 1000).toFixed(1).padStart(8) + " kN"
    + "   " + aExtra.toFixed(0).padStart(15) + " m/s2"
    + "   " + (aExtra < -20 ? "<== SLAMMED DOWN (" + gr + "/4 phantom)" : "ok"),
  );
}
console.log("");

// The REAL v3 terrain probe, copied faithfully from v3/play/modularRoadGround.js
// createVehicleGround().ground.raycastFirst. NOTE the total absence of any check
// on the ray DIRECTION — this is a vertical projection at the origin's XZ, and
// that is the whole point of this section.
const realTerrain = {
  baked: true,
  raycastFirst(origin, dir, far) {
    const terrainY = 0;
    const vertDist = origin.y - terrainY;
    if (dir.y < 0 && vertDist <= far && vertDist >= -1.0) {
      return {
        distance: vertDist,
        point: { x: origin.x, y: terrainY, z: origin.z },
        normal: { x: 0, y: 1, z: 0 },
      };
    }
    return null;
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};

console.log("=== SAME TEST, BUT AGAINST THE **REAL** TERRAIN PROBE ===");
console.log("  Everything above used a mock that rejects upward rays. The shipped one");
console.log("  does not check direction at all, so an INVERTED car — whose probe casts");
console.log("  world-UP — still gets a terrain hit, at full compression, and the");
console.log("  suspension pushes along chassis-up, which is world DOWN.");
console.log("");
console.log("      h     wheels   compression   susp force   accel beyond gravity");
for (const h of [12, 4, 2.2, 1.6, 1.2, 0.9]) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = realTerrain; c.solidsBvh = noSolids; c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, h, 0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);   // inverted
  c.body.vel.set(0, 0, 20);
  c.body.angVel.set(0, 0, 0);
  const vy0 = c.body.vel.y;
  c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  const aExtra = (c.body.vel.y - vy0) / FIXED_DT + 9.81;
  let comp = 0, susp = 0, gr = 0;
  for (const t of c.tires) {
    if (!t.grounded) continue;
    gr++; comp = Math.max(comp, t.compression); susp += t.lastSuspension.length();
  }
  console.log(
    "   " + h.toFixed(1).padStart(5)
    + "   " + (gr + "/4").padStart(6)
    + "   " + comp.toFixed(3).padStart(11)
    + "   " + (susp / 1000).toFixed(1).padStart(8) + " kN"
    + "   " + aExtra.toFixed(0).padStart(15) + " m/s2"
    + (aExtra < -20 ? "   <== SLAMMED DOWN" : ""),
  );
}
console.log("");
