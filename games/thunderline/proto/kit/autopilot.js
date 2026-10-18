// The TEST AUTOPILOT and the car rules the prototypes add on top of the old car. Shared by the drive
// page (P toggles it), the builder's background prediction and the Node tests, so all three drive
// a track the same way. Not gameplay: an objective check that the car can drive every piece.
import * as THREE from "three";

const _inv = new THREE.Quaternion();
const _nose = new THREE.Vector3();
const _local = new THREE.Vector3();
const _t = new THREE.Vector3();
const _u = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const WALL_SIN = Math.sin((30 * Math.PI) / 180);

/**
 * NO ENGINE UP A WALL (Thunderline rule): while the wheels are on a surface and the nose points more
 * than 30° up, the throttle does nothing. The old car fades its drive 15°→45° only on road-held
 * pieces, so on a bowl full throttle drove it up the wall and it flew 50–100 m higher than the speed
 * it arrived with (bowlTest.mjs). The old car reads the throttle as on/off, so this is a cut at the
 * input; the real build puts it in the car. Braking (throttle < 0) still works.
 */
export function wallCut(car, input) {
  if (input.throttle <= 0 || car.groundedCount === 0) return input;
  _nose.set(0, 0, 1).applyQuaternion(car.body.quat);
  return _nose.y > WALL_SIN ? { ...input, throttle: 0 } : input;
}

/**
 * @param {{P: THREE.Vector3, T: THREE.Vector3, U?: THREE.Vector3}[]} ride  the centreline, in driving order
 */
export function createAutopilot(ride) {
  let idx = 0;
  // GAPS in the ride: a long step that does not follow the road (a flight from lip to landing, a
  // bowl's jump from the climbing lane to the return lane). A straight's one 64 m step is not one.
  const gapAfter = ride.map((r, i) => {
    const n = ride[i + 1];
    if (!n) return false;
    const d = n.P.distanceTo(r.P);
    return d > 8 && n.P.clone().sub(r.P).divideScalar(d).dot(r.T) < 0.98;
  });
  // never aim across a gap: steering at the far side while still on the wall carves the car off the face
  const aim = (from, dist) => {
    let i = from, acc = 0;
    while (i + 1 < ride.length && acc < dist && !gapAfter[i]) { acc += ride[i].P.distanceTo(ride[i + 1].P); i++; }
    return ride[i];
  };
  // in the air: the road on the FAR side of the next gap within 150 m (the landing; a bowl's return
  // lane), else the road right under the car (over a landing: its slope, not its level end)
  const across = (from) => {
    let acc = 0;
    for (let i = from; i + 1 < ride.length && acc < 150; i++) {
      if (gapAfter[i]) return ride[i + 1];
      acc += ride[i].P.distanceTo(ride[i + 1].P);
    }
    return ride[from];
  };
  return {
    get idx() { return idx; },
    reset() { idx = 0; },
    input(car) {
      const p = car.body.pos;
      // nearest ride point, searched forward from the last one (the track crosses itself), running the
      // way the car moves (coming back down a bowl, the climbing lane right under it points up)
      let best = idx, bd = Infinity;
      const vel = car.body.vel, moving = vel.lengthSq() > 25;
      for (let i = Math.max(0, idx - 20); i < Math.min(ride.length, idx + 400); i++) {
        if (moving && ride[i].T.dot(vel) < 0) continue;
        const d = ride[i].P.distanceToSquared(p);
        if (d < bd) { bd = d; best = i; }
      }
      idx = best;
      _inv.copy(car.body.quat).invert();
      _local.copy(aim(best, 25).P).sub(p).applyQuaternion(_inv); // car local: +Z forward, +X left
      const steer = THREE.MathUtils.clamp((_local.x / Math.max(_local.z, 4)) * 2.5, -1, 1);
      const far = aim(best, 90).T;
      _nose.set(0, 0, 1).applyQuaternion(car.body.quat);
      const bend = Math.acos(THREE.MathUtils.clamp(far.dot(_nose), -1, 1));
      const v = car.body.vel.length();
      const grounded = car.groundedCount > 0;
      // brake for flat brake turns only: not banked sweepers, not loops (their far point is above/behind)
      const throttle = bend > 1.1 && Math.abs(far.y) < 0.4 && Math.abs(_nose.y) < 0.4 && v > 26 && grounded ? -1 : 1;
      // IN THE AIR, line up with the road across the gap (the landing): yaw the nose onto its
      // direction, pitch onto its slope, roll onto its up — proportional, in the car's own frame
      // (measured: +yaw turns the nose to the car's +X, +pitch raises it, +roll drops the +X side).
      // A big error goes first on its own axis: a bowl's 180° spin (the lip throws the car up
      // nose-first, the road back down the face points the other way), a flip ramp's half roll.
      let yaw = 0, roll = 0, pitch = 0;
      if (!grounded) {
        const n = across(best);
        _t.copy(n.T).applyQuaternion(_inv);
        _u.copy(n.U ?? UP).applyQuaternion(_inv);
        const yawE = Math.atan2(_t.x, _t.z), pitchE = Math.asin(THREE.MathUtils.clamp(_t.y, -1, 1)), rollE = Math.atan2(_u.x, _u.y);
        const k = (e) => (Math.abs(e) < 0.04 ? 0 : THREE.MathUtils.clamp(e * 2, -1, 1));
        if (Math.abs(yawE) > 1.6) yaw = Math.sign(yawE);
        else if (Math.abs(rollE) > 1.6) roll = Math.sign(rollE);
        else { yaw = k(yawE); pitch = k(pitchE); roll = k(rollE); }
      }
      return wallCut(car, { steerTarget: steer, rollTarget: roll, throttle, handbrake: false, yaw, pitch, analog: true });
    },
  };
}
