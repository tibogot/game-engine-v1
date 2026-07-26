// Landing on a guardrail must never beach the car permanently.
//
// THE TRAP: wheels only probe the DECK bvh; guardrails live in the SOLIDS bvh.
// So a car resting on a rail has ZERO grounded wheels — no drive force, no tyre
// friction, no way out. roadGame has a give-up path (recoverToSafePose at
// STUCK.respawnAfter) and it documented this exact case... but it never fired,
// because the detector demanded BOTH a held throttle and < 1.5 m/s. Measured on
// a real landing: the player is off the gas and the car creeps at ~2.1 m/s, so
// neither held. `beached` covers it — no throttle needed, roomier speed gate.
//
// The other half of the job is NOT over-firing: a wall ride is the same shape
// (0 wheels down, touching a solid) and must never be mistaken for beaching.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.rail.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, STUCK, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

/** Road deck for |x| < 4. Nothing drivable beyond it — a stunt track has no terrain. */
const road = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6 || Math.abs(o.x) > 4) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: 0, z: o.z }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};
/**
 * Guardrail along z, FLAT-TOPPED and wide enough that the car genuinely comes to
 * rest on it. That is deliberate: the peaked cap the kit actually builds helps
 * the car SLIDE off (verified — it does), and a car that slides off and falls is
 * caught by roadGame's FALL_Y path, which already works. What is under test here
 * is the DETECTOR for the case where the car does not slide: resting on a solid
 * with no drivable surface under any wheel.
 */
function rail(railX, top = 1.0, halfW = 1.6) {
  return {
    baked: true, raycastFirst() { return null; }, spherecast() { return null; },
    closestPointWithNormal(x, y, z, radius, outN) {
      const dx = x - railX;
      if (Math.abs(dx) > halfW + radius) return null;
      if (y > top) {
        const d = y - top;
        if (d > radius) return null;
        outN.set(0, 1, 0);
        return { distance: d };
      }
      const d = Math.abs(dx) - halfW;
      if (d > radius) return null;
      outN.set(dx >= 0 ? 1 : -1, 0, 0);
      return { distance: Math.max(0, d) };
    },
  };
}
/** Tall flat wall at x = wallX — for the wall-ride false-positive check. */
function wall(wallX) {
  return {
    baked: true, raycastFirst() { return null; }, spherecast() { return null; },
    closestPointWithNormal(x, y, z, radius, outN) {
      const d = Math.abs(x - wallX) - 0.2;
      if (d > radius) return null;
      outN.set(x >= wallX ? 1 : -1, 0, 0);
      return { distance: Math.max(0, d) };
    },
  };
}
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

function sim({ solids, pos, vel, throttle = 0, steer = 0, secs = 6 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = road; c.solidsBvh = solids; c.enabled = true;
  c.body.pos.copy(pos); c.body.vel.copy(vel); c.body.quat.identity();
  let peak = 0, firedAt = null;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: steer, throttle, handbrake: false, yaw: 0, pitch: 0 });
    peak = Math.max(peak, c.stuckTime);
    if (firedAt === null && c.stuckTime >= STUCK.respawnAfter) firedAt = i * FIXED_DT;
  }
  return { peak, firedAt, grounded: c.groundedCount, touching: c.hitSolid, car: c };
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

console.log("=== LANDING ON THE RAIL — RECOVERY MUST FIRE ===");
for (const [label, throttle] of [["player lifts OFF the gas", 0], ["throttle held", 1]]) {
  const r = sim({ solids: rail(8), pos: V(8, 2.4, 0), vel: V(0, -5, 2), throttle });
  console.log(`  ${label}: grounded=${r.grounded} touching=${r.touching} `
    + `peak stuckTime ${r.peak.toFixed(2)}s, recovery at ${r.firedAt === null ? "NEVER" : r.firedAt.toFixed(2) + "s"}`);
  check(`recovery fires when ${label} (was NEVER)`, r.firedAt !== null);
  check(`  and within a couple of seconds, not eventually`, r.firedAt !== null && r.firedAt < 5);
}

console.log("\n=== IT MUST NOT FIRE WHEN THE CAR IS FINE ===");
{
  // Driving normally down the middle of the road.
  const drive = sim({ solids: rail(4.5), pos: V(0, 0.6, 0), vel: V(0, 0, 20), throttle: 1 });
  check("never fires while simply driving", drive.firedAt === null, `peak ${drive.peak.toFixed(2)}s`);

  // Merely brushing a rail while stationary is not being trapped by it.
  const parked = sim({ solids: rail(3.0, 1.2, 0.2), pos: V(1.95, 0.6, 0), vel: V(0, 0, 0), throttle: 1, steer: -1 });
  check("never fires from simply resting alongside a rail",
    parked.firedAt === null, `grounded=${parked.grounded} peak ${parked.peak.toFixed(2)}s`);

  // WALL RIDE: 0 wheels down, touching a solid — the same shape as beaching,
  // separated only by speed. This is the false positive that matters.
  const ride = sim({ solids: wall(2.0), pos: V(1.5, 1.4, 0), vel: V(0, 0, 34), throttle: 1, secs: 2 });
  check("never fires during a fast wall ride (0 wheels down, touching a solid)",
    ride.firedAt === null, `peak ${ride.peak.toFixed(2)}s`);

  // THE CRITICAL NEGATIVE. The condition no longer requires throttle OR solid
  // contact — the only thing standing between "stuck" and "parked" is the wheel
  // count. So a car sitting still in the middle of the road, on all four wheels,
  // must never accumulate a single tick, however long it sits there.
  const parkedOnRoad = sim({
    solids: rail(40), pos: V(0, 0.45, 0), vel: V(0, 0, 0), throttle: 0, secs: 12,
  });
  console.log(`  parked mid-road: grounded=${parkedOnRoad.grounded} peak ${parkedOnRoad.peak.toFixed(2)}s`);
  check("a car PARKED on the road is never treated as stuck, however long",
    parkedOnRoad.firedAt === null && parkedOnRoad.peak < 0.5,
    "4 wheels down is the whole safeguard now");
  check("and it really was on all four wheels", parkedOnRoad.grounded >= 3,
    `${parkedOnRoad.grounded}/4`);
}

console.log("\n=== THE GATE ITSELF ===");
check("beachedSpeed is roomier than the old horizontal gate",
  STUCK.beachedSpeed > STUCK.speed, `${STUCK.beachedSpeed} > ${STUCK.speed}`);
check("but still well under wall-ride speed, so a ride is never mistaken for it",
  STUCK.beachedSpeed < 8, `${STUCK.beachedSpeed}`);
check("recovery is quick enough not to feel like a hang", STUCK.respawnAfter <= 3,
  `${STUCK.respawnAfter}s`);

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
