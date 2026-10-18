// The TEST AUTOPILOT and the car rules the prototypes add on top of the old car. Shared by the drive
// page (P toggles it), the builder's background prediction and the Node tests, so all three drive
// a track the same way. Not gameplay: an objective check that the car can drive every piece.
import * as THREE from "three";

const _inv = new THREE.Quaternion();
const _nose = new THREE.Vector3();
const _local = new THREE.Vector3();
const _t = new THREE.Vector3();
const _u = new THREE.Vector3();
const _vdir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const WALL_SIN = Math.sin((30 * Math.PI) / 180);
const AIR_DRAG = 0.45 / 1400; // the car's AERO.drag / mass
const TUBE_R = 8; // tubeLook.js TUBE.R

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
  let idx = 0, airAim = null;
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
  // in the air: the road on the FAR side of the next gap within 400 m (the landing; a bowl's return
  // lane), else the road right under the car (over a landing: its slope, not its level end)
  const across = (from) => {
    let acc = 0;
    for (let i = from; i + 1 < ride.length && acc < 400; i++) {
      if (gapAfter[i]) return ride[i + 1];
      if (ride[i].air && !ride[i + 1].air) return ride[i + 1]; // a ride that draws the flight (test track)
      acc += ride[i].P.distanceTo(ride[i + 1].P);
    }
    return ride[from];
  };
  // in the air: WHERE WILL IT TOUCH DOWN — the car's flight (gravity + drag) projected forward against
  // the rings ahead; the first one whose surface it passes through within half a road. Lining up with
  // the landing's first ring was not enough: a car faster than the band's slow edge flies past it and
  // lands on the run-out (15° off, measured).
  const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _d = new THREE.Vector3();
  let touchCache = null, touchAge = 99;
  const touchdown = (car, from) => {
    if (touchAge++ < 6 && touchCache) return touchCache;
    touchAge = 0;
    _p.copy(car.body.pos);
    _v.copy(car.body.vel);
    const lo = from, hi = Math.min(ride.length, from + 600);
    for (let step = 0; step < 150; step++) { // 5 s at 1/30 s
      const dt = 1 / 30;
      _v.addScaledVector(_v, -AIR_DRAG * _v.length() * dt);
      _v.y -= 9.81 * dt;
      _p.addScaledVector(_v, dt);
      for (let i = lo; i < hi; i++) {
        const r = ride[i];
        if (r.air) continue;
        _d.copy(_p).sub(r.P);
        if (_d.lengthSq() > 900) continue; // 30 m
        if (_d.dot(r.U ?? UP) < 0.5 && Math.abs(_d.dot(r.T)) < 4 && r.T.dot(_v) > 0) return (touchCache = { r, t: (step + 1) * dt });
      }
    }
    return (touchCache = null);
  };
  // IN A TUBE, ride the wall like a player: hold the angle the turn asks for — atan(lateral accel / g)
  // up the OUTSIDE wall — within what the pipe has closed there. Steering round the floor line held
  // the car flat on the bottom (16°); not steering at all let it swing over the roof (126°) and fly
  // out of the exit on the wall.
  const _c = new THREE.Vector3(), _rr = new THREE.Vector3(), _dd = new THREE.Vector3(), _left = new THREE.Vector3(), _tphi = new THREE.Vector3();
  let lastPhi = 0;
  function tubeSteer(car, i) {
    const r = ride[i], ahead = ride[Math.min(ride.length - 1, i + 2)];
    _rr.crossVectors(r.T, r.U).normalize(); // the tube's right
    _c.copy(r.P).addScaledVector(r.U, TUBE_R); // the pipe's axis here
    _dd.copy(car.body.pos).sub(_c);
    const phi = Math.atan2(_dd.dot(_rr), -_dd.dot(r.U)); // 0 = bottom, + = up the right wall
    // curvature of the path here → the lateral acceleration the turn asks for
    const ds = Math.max(1e-3, ahead.P.distanceTo(r.P));
    const aSide = car.body.vel.lengthSq() * _dd.copy(ahead.T).sub(r.T).divideScalar(ds).dot(_rr); // + = turning right
    const reach = Math.max(0, Math.PI * r.tube - 0.35); // how far up the wall there still is wall
    const want = THREE.MathUtils.clamp(-Math.atan2(aSide, 9.81), -Math.min(reach, 1.35), Math.min(reach, 1.35));
    // which way does steering LEFT move the car around the pipe?
    _left.set(1, 0, 0).applyQuaternion(car.body.quat); // car local +X is left
    _tphi.copy(_rr).multiplyScalar(Math.cos(phi)).addScaledVector(r.U, Math.sin(phi)); // +φ direction
    const sense = Math.sign(_left.dot(_tphi)) || 1;
    const rate = phi - lastPhi;
    lastPhi = phi;
    return THREE.MathUtils.clamp(((want - phi) * 2.2 - rate * 25) * sense, -1, 1);
  }
  // the other way: only keep the nose pointing down the pipe (the ride's direction a little ahead),
  // and let the car's height on the wall settle where the turn puts it
  const _fw = new THREE.Vector3();
  function tubeHeading(car, i) {
    const T = ride[Math.min(ride.length - 1, i + 3)].T;
    _fw.set(0, 0, 1).applyQuaternion(car.body.quat);
    _left.set(1, 0, 0).applyQuaternion(car.body.quat);
    const err = Math.atan2(T.dot(_left), T.dot(_fw)); // + = the pipe goes to the car's left
    return THREE.MathUtils.clamp(err * 4, -1, 1);
  }
  return {
    get idx() { return idx; },
    get airAim() { return airAim; },
    reset() { idx = 0; touchCache = null; },
    /** Where along the ride the car is (also while a player drives: the fall camera needs it). */
    locate(car) {
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
      return idx;
    },
    /** In the air: the ride point the car will touch down on (its flight projected), or null. */
    touchdown(car) { return car.groundedCount > 0 ? null : touchdown(car, idx)?.r ?? null; },
    input(car) {
      const p = car.body.pos;
      const best = this.locate(car);
      _inv.copy(car.body.quat).invert();
      _local.copy(aim(best, 25).P).sub(p).applyQuaternion(_inv); // car local: +Z forward, +X left
      let steer = THREE.MathUtils.clamp((_local.x / Math.max(_local.z, 4)) * 2.5, -1, 1);
      if (ride[idx].tube > 0.3 && car.groundedCount > 0) steer = globalThis.__TUBE_MODE === "angle" ? tubeSteer(car, idx) : tubeHeading(car, idx);
      const farR = aim(best, 90), far = farR.T;
      _nose.set(0, 0, 1).applyQuaternion(car.body.quat);
      const bend = Math.acos(THREE.MathUtils.clamp(far.dot(_nose), -1, 1));
      const v = car.body.vel.length();
      const grounded = car.groundedCount > 0;
      // brake for flat brake turns only: not banked sweepers, not loops (their far point is above/behind)
      // (never in a tube: its wall holds the car, nobody brakes in there — it braked every tube to 93 km/h)
      const throttle = bend > 1.1 && Math.abs(far.y) < 0.4 && Math.abs(_nose.y) < 0.4 && v > 26 && grounded && !ride[best].tube && !farR.tube ? -1 : 1;
      // IN THE AIR, line up with the road across the gap (the landing): yaw the nose onto its
      // direction, pitch onto its slope, roll onto its up — proportional, in the car's own frame
      // (measured: +yaw turns the nose to the car's +X, +pitch raises it, +roll drops the +X side).
      // A big error goes first on its own axis: a bowl's 180° spin (the lip throws the car up
      // nose-first, the road back down the face points the other way), a flip ramp's half roll.
      let yaw = 0, roll = 0, pitch = 0;
      if (grounded) touchCache = null;
      if (!grounded) {
        const td = touchdown(car, best);
        const n = td?.r ?? across(best);
        _t.copy(n.T).applyQuaternion(_inv);
        _u.copy(n.U ?? UP).applyQuaternion(_inv);
        const yawE = Math.atan2(_t.x, _t.z), rollE = Math.atan2(_u.x, _u.y);
        // PITCH: a smooth jump (user, 2026-10-18: "the car is pointing down very quick in the air,
        // doesn't look like a smooth jump"). The nose FOLLOWS THE FLIGHT PATH, and only in the last
        // ~1.2 s before the predicted touchdown blends onto the landing's slope (done 0.3 s before).
        const w = td ? THREE.MathUtils.clamp(1 - (td.t - 0.3) / 0.9, 0, 1) : 1;
        _vdir.copy(car.body.vel).normalize().lerp(n.T, w).normalize().applyQuaternion(_inv);
        const pitchE = Math.asin(THREE.MathUtils.clamp(_vdir.y, -1, 1));
        const k = (e) => (Math.abs(e) < 0.03 ? 0 : THREE.MathUtils.clamp(e * 1.5, -1, 1));
        if (Math.abs(yawE) > 1.6) yaw = Math.sign(yawE); // big turns (a bowl's 180) start at once
        else if (Math.abs(rollE) > 1.6) roll = Math.sign(rollE); // a flip ramp's half roll too
        else { yaw = k(yawE); pitch = k(pitchE); roll = k(rollE); }
        airAim = { at: ride.indexOf(n), yawE, pitchE, rollE }; // what it is lining up with (tests read it)
      }
      return wallCut(car, { steerTarget: steer, rollTarget: roll, throttle, handbrake: false, yaw, pitch, analog: true });
    },
  };
}
