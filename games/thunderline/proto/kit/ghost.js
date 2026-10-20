import * as THREE from "three";
// GHOSTS (DESIGN.md §8, measured in P5): a run is its INPUTS on the fixed tick, replayed by a second
// car through the same rules (carRules.js) — bit-exact in the same browser — plus a POSE KEYFRAME
// every second the replay snaps to (another browser's math drifts ~1 cm a lap), plus the respawns
// (a teleport is not an input). Recording starts at the restart, countdown included.
// POSES (performance pass, 2026-10-20): the run's pose (position + rotation) every POSE_EVERY ticks too, and
// a ghost that has them is PLAYED BACK from them, interpolated — no second physics car each tick (it doubled
// the physics). The inputs stay for checking records; a ghost saved before (inputs only) replays as before.

const KEY_EVERY = 120; // ticks: one keyframe a second
const POSE_EVERY = 4; // ticks: 30 poses a second
const r2 = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 1e4) / 1e4;

const packInput = (i) => [i.steerTarget, i.rollTarget, i.throttle, i.handbrake ? 1 : 0, i.yaw, i.pitch, i.analog ? 1 : 0];
const unpackInput = (a) => ({ steerTarget: a[0], rollTarget: a[1], throttle: a[2], handbrake: !!a[3], yaw: a[4], pitch: a[5], analog: !!a[6] });
const pose = (b) => [...b.pos.toArray(), ...b.quat.toArray(), ...b.vel.toArray(), ...b.angVel.toArray()];
function setPose(car, p) {
  car.body.pos.fromArray(p, 0);
  car.body.quat.fromArray(p, 3);
  car.body.vel.fromArray(p, 7);
  car.body.angVel.fromArray(p, 10);
}

export function createGhostRecorder() {
  let rec = null;
  return {
    start() { rec = { v: 2, inputs: [], keys: {}, respawns: [], poses: [], wheels: [], poseEvery: POSE_EVERY }; },
    /** after each tick: the input that tick used, and the car after it */
    tick(input, car) {
      if (!rec) return;
      rec.inputs.push(packInput(input));
      const n = rec.inputs.length;
      if (n % KEY_EVERY === 0) rec.keys[n] = pose(car.body);
      if (n % POSE_EVERY === 0) {
        const b = car.body;
        rec.poses.push(r2(b.pos.x), r2(b.pos.y), r2(b.pos.z), r4(b.quat.x), r4(b.quat.y), r4(b.quat.z), r4(b.quat.w));
        // each wheel's hub-to-ground distance (−1 = in the air): the replay draws the wheels on the road
        for (const t of car.tires) rec.wheels.push(t.grounded ? r2(t.hitDistance) : -1);
      }
    },
    /** a respawn between ticks: the replay applies the same teleport before the next tick */
    respawn(car) { if (rec) rec.respawns.push({ at: rec.inputs.length, pose: pose(car.body) }); },
    finish(time) { if (rec) rec.time = time; return rec; },
    get data() { return rec; },
  };
}

/**
 * Replays a recorded run with `car` stepped through `rules` (the same carRules as the player).
 * start(spawnPos, spawnQuat) at the restart, then tick() once per physics tick.
 */
export function createGhostPlayer(car, rules, ghost) {
  if (ghost.poses?.length >= 14) return createPosePlayer(car, ghost);
  let n = 0, nextRespawn = 0, maxDrift = 0;
  return {
    get maxDrift() { return maxDrift; },
    get done() { return n >= ghost.inputs.length; },
    get tickIndex() { return n; },
    /** the same calls as the player's restart, so tick 0 starts from the identical state */
    start(pos, quat) {
      n = 0; nextRespawn = 0; maxDrift = 0;
      car.setEnabled(true);
      car.setSpawn(pos, quat);
      car.respawn();
      rules.reset();
    },
    tick(dt) {
      if (n >= ghost.inputs.length) { car.setEnabled(false); return; }
      while (nextRespawn < ghost.respawns.length && ghost.respawns[nextRespawn].at === n) {
        const r = ghost.respawns[nextRespawn++];
        car.respawnAt(car.body.pos, car.body.quat);
        setPose(car, r.pose);
        rules.reset();
      }
      rules.step(unpackInput(ghost.inputs[n]), dt);
      n++;
      const k = ghost.keys[n];
      if (k) {
        // how far the replay had drifted from the recording (0 in the same browser: bit-exact)
        const dx = car.body.pos.x - k[0], dy = car.body.pos.y - k[1], dz = car.body.pos.z - k[2];
        maxDrift = Math.max(maxDrift, Math.hypot(dx, dy, dz));
        setPose(car, k); // the keyframe the recording car had after this same tick
      }
    },
  };
}

// a wheel resting on a flat deck: hub 0.50 m above the road (measured, the real car held on the line)
const REST_HIT = 0.5;

/**
 * A ghost played back from its recorded POSES: the car's body set each tick, its own interpolation draws it.
 * THE WHEELS (user, 2026-10-20: "the ghost doesn't sit on the ground, it's a bit under"): no physics runs, so
 * no probe finds the road and the drawn wheels hung at full droop, ~10 cm into the deck. Each pose carries the
 * wheels' ground distances (ghost.wheels) and they are handed to the car's tyres; a ghost saved before that
 * rests its wheels on the road.
 */
function createPosePlayer(car, ghost) {
  const P = ghost.poses, every = ghost.poseEvery ?? POSE_EVERY, count = P.length / 7, ticks = count * every;
  const W = ghost.wheels?.length === count * 4 ? ghost.wheels : null;
  const wheel = (k, i) => (W ? W[Math.min(count - 1, Math.max(0, k)) * 4 + i] : REST_HIT);
  let n = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const at = (k, v, q) => { const i = Math.min(count - 1, Math.max(0, k)) * 7; v.set(P[i], P[i + 1], P[i + 2]); q.set(P[i + 3], P[i + 4], P[i + 5], P[i + 6]).normalize(); };
  return {
    get maxDrift() { return 0; },
    get done() { return n >= ticks; },
    get tickIndex() { return n; },
    start(pos, quat) {
      n = 0;
      car.setEnabled(true);
      car.setSpawn(pos, quat);
      car.respawn();
    },
    tick(dt) {
      if (n >= ticks) { car.setEnabled(false); return; }
      n++;
      // pose sample k is the car after tick (k + 1) * every
      const f = n / every - 1, k = Math.floor(f), t = f - k;
      at(k, a, qa);
      at(k + 1, b, qb);
      const body = car.body;
      car._prevPos.copy(body.pos);
      car._prevQuat.copy(body.quat);
      if (a.distanceToSquared(b) > 400) { body.pos.copy(t < 0.5 ? a : b); body.quat.copy(t < 0.5 ? qa : qb); } // a respawn: snap
      else { body.pos.lerpVectors(a, b, t); body.quat.slerpQuaternions(qa, qb, t); }
      body.vel.subVectors(body.pos, car._prevPos).divideScalar(dt); // for the body lean, the lights
      if (k < 0) car._prevPos.copy(body.pos);
      car.tires.forEach((tire, i) => {
        const da = wheel(k, i), db = wheel(k + 1, i);
        const d = da >= 0 && db >= 0 ? da + (db - da) * t : t < 0.5 ? da : db;
        tire.grounded = d >= 0;
        if (d >= 0) tire.hitDistance = d;
      });
    },
  };
}
