// GHOSTS (DESIGN.md §8, measured in P5): a run is its INPUTS on the fixed tick, replayed by a second
// car through the same rules (carRules.js) — bit-exact in the same browser — plus a POSE KEYFRAME
// every second the replay snaps to (another browser's math drifts ~1 cm a lap), plus the respawns
// (a teleport is not an input). Recording starts at the restart, countdown included.

const KEY_EVERY = 120; // ticks: one keyframe a second

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
    start() { rec = { v: 1, inputs: [], keys: {}, respawns: [] }; },
    /** after each tick: the input that tick used, and the car after it */
    tick(input, car) {
      if (!rec) return;
      rec.inputs.push(packInput(input));
      const n = rec.inputs.length;
      if (n % KEY_EVERY === 0) rec.keys[n] = pose(car.body);
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
