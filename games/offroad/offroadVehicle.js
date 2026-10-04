// THE OFF-ROAD VEHICLE — physics for a 4x4 crawling over a terrain heightmap
// and rocks. A COPY, not a dependency: the core comes from the Apex Rush car
// (v3/play/modularRoadVehicle.js, as of commit 1b1927a) and was then cut down
// and extended for off-road. Apex Rush is not imported and never affected.
//
// Copied (and simplified) from Apex Rush:
//   RigidBody            6-DOF, box inertia, semi-implicit Euler    (≈ its 2749-2890)
//   ring-ray wheel probe + sphere sweep, spring/damper with bottom-out,
//   damper along the surface normal, in-plane lateral slip   (Tire, ≈ 2982-3622)
//   Ackermann steering, fixed 1/120 s tick with 2 substeps,
//   chassis-corner terrain contact, grounded stabilizer      (Vehicle)
//   the ground interface: createVehicleGround / RoadBvh (imported, unchanged)
// New for off-road:
//   per-wheel SPIN (ω) with an engine torque curve, HIGH / LOW range, open or
//   LOCKED differentials, brake torque (wheels can lock), a hill hold, rolling
//   resistance and grip per SURFACE, long-travel suspension, and the bodywork
//   resting on / pushed off rocks (the belly can hang up on a boulder).
//
// TUNING IS PER INSTANCE (`vehicle.cfg`): two trucks never share a setting,
// and nothing here is a module-level singleton — the trap the Apex Rush
// tables have (they are live globals its dev panel edits).
//
// Axes: +Z forward, +Y up, +X is the truck's LEFT (three is right-handed).
// A positive steer angle turns LEFT. SI units: m, kg, N, s, rad.
import * as THREE from "three";

export const FIXED_DT = 1 / 120;
export const GRAVITY = 9.81;
const SUBSTEPS = 2;

export const OFFROAD_DEFAULTS = {
  mass: 2100,
  /** Box the inertia tensor is taken from (m). Smaller than the body: mass sits low and central. */
  inertiaBox: { width: 1.6, height: 0.9, length: 3.8 },
  /** Centre of mass above the GROUND at rest, in the model frame (the model's origin is on the ground). */
  // 0.75 m: with the 1.62 m track that is a static stability factor (track/2 ÷
  // CoM height) of 1.08 — an SUV's. At 0.92 m (0.88) full lock at 28 km/h rolled
  // the truck onto its side in the lab.
  comHeight: 0.75,
  wheel: { radius: 0.42, width: 0.32, inertia: 1.6, halfTrack: 0.81, wheelbase: 2.8 },
  susp: {
    /** Mount-to-ground distance at full droop (m). Long: off-road articulation. */
    restLength: 0.86,
    spring: 34000,          // N/m per wheel
    damper: 4200,           // N/(m/s)
    bottomOutThresh: 0.85,  // fraction of restLength past which the bump stop adds a squared term
    bottomOutMult: 8,
    rayPad: 0.55,           // probe starts this far above the mount
    ringCount: 9,           // rays around the bottom of the tyre (climbs rock edges)
    ringScale: 0.92,
    sphereSweep: true,
    sphereScale: 0.85,
    normalSmooth: 30,       // 1/s low-pass on the contact normal
    damperNormalMinFacing: 0.7,
  },
  tire: {
    mu: 1.0,                // base friction; × the surface's own
    latStiffness: 6,        // lateral slip → force (brush model, as Apex Rush)
    lowSpeedRef: 1.5,       // m/s: below this slip is measured against it
    longStiffness: 8,       // longitudinal slip → force
    longRef: 1.5,           // m/s
  },
  steer: {
    maxAngle: 0.62,         // rad at the centreline, standing still
    rate: 2.8,              // 1/s toward the input
    returnRate: 4.5,        // 1/s back to centre
    highSpeedRef: 12,       // m/s where the lock is reduced to…
    highSpeedScale: 0.35,
    ackermann: 1,
  },
  engine: {
    torque: 3400,           // N·m at the wheels, total, HIGH range, from rest
    maxWheelSpeed: 27,      // m/s at which the curve reaches zero (HIGH)
    lowRatio: 2.7,          // LOW range: × torque, ÷ speed
    curveExp: 1.4,
    reverseScale: 0.7,
    engineBrake: 500,       // N·m total, off throttle
  },
  brakes: { torque: 2300, handbrake: 4200, switchToReverse: 0.6 },
  /** Hill hold: below this speed with no throttle the truck is held (an automatic 4x4's hill hold). */
  hold: { speed: 0.5, spring: 60000, damper: 14000 },
  drivetrain: { layout: "AWD", frontShare: 0.5, diffLock: false, lowRange: false },
  stabilizer: { align: 900, damp: 600 },
  /** Anti-roll bars, N per m of left/right compression difference, per axle. */
  antiRoll: { front: 22000, rear: 16000 },
  chassis: {
    /** Bodywork extents in the MODEL frame (ground at y = 0): sample points for contact. */
    halfWidth: 0.9, zFront: 2.12, zBack: -2.33, yBottom: 0.42, yTop: 2.15,
    cornerSpring: 160000, cornerDamper: 9000, cornerFriction: 0.6,
  },
  solids: { skin: 0.05, probe: 0.6, spring: 220000, damper: 12000, friction: 0.5, maxPen: 0.5 },
  dragCoeff: 0.6,           // N per (m/s)²
  rollingResistance: 0.015, // × load, before the surface's own
  maxAngVel: 12,
};

function mergeCfg(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? mergeCfg(base[k], v) : v;
  }
  return out;
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ───────────────────────── Rigid body (copied) ───────────────────────── */

export class RigidBody {
  constructor({ mass, size }) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.localInvInertia = new THREE.Matrix3();
    const { width: w, height: h, length: l } = size;
    const Ixx = (mass / 12) * (h * h + l * l), Iyy = (mass / 12) * (w * w + l * l), Izz = (mass / 12) * (w * w + h * h);
    this.localInvInertia.set(1 / Ixx, 0, 0, 0, 1 / Iyy, 0, 0, 0, 1 / Izz);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();
    this.forceAccum = new THREE.Vector3();
    this.torqueAccum = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._tau = new THREE.Vector3();
    this._rotVel = new THREE.Vector3();
    this._R3 = new THREE.Matrix3();
    this._R3t = new THREE.Matrix3();
    this._mat = new THREE.Matrix4();
    this._worldInvI = new THREE.Matrix3();
    this._wiQ = [NaN, NaN, NaN, NaN];
  }
  addForce(F) { this.forceAccum.add(F); }
  addForceAtPoint(F, p) {
    this.forceAccum.add(F);
    this._r.subVectors(p, this.pos);
    this._tau.crossVectors(this._r, F);
    this.torqueAccum.add(this._tau);
  }
  getVelocityAtPoint(p, out) {
    this._r.subVectors(p, this.pos);
    this._rotVel.crossVectors(this.angVel, this._r);
    return out.addVectors(this.vel, this._rotVel);
  }
  worldInvInertia() {
    const q = this.quat, c = this._wiQ;
    if (c[0] !== q.x || c[1] !== q.y || c[2] !== q.z || c[3] !== q.w) {
      this._mat.makeRotationFromQuaternion(q);
      this._R3.setFromMatrix4(this._mat);
      this._R3t.copy(this._R3).transpose();
      this._worldInvI.copy(this._R3).multiply(this.localInvInertia).multiply(this._R3t);
      c[0] = q.x; c[1] = q.y; c[2] = q.z; c[3] = q.w;
    }
    return this._worldInvI;
  }
  integrate(dt) {
    this.vel.addScaledVector(this.forceAccum, this.invMass * dt);
    this.pos.addScaledVector(this.vel, dt);
    this._tau.copy(this.torqueAccum).applyMatrix3(this.worldInvInertia());
    this.angVel.addScaledVector(this._tau, dt);
    const wx = this.angVel.x, wy = this.angVel.y, wz = this.angVel.z;
    const qx = this.quat.x, qy = this.quat.y, qz = this.quat.z, qw = this.quat.w;
    this.quat.set(
      qx + 0.5 * (wx * qw + wy * qz - wz * qy) * dt,
      qy + 0.5 * (-wx * qz + wy * qw + wz * qx) * dt,
      qz + 0.5 * (wx * qy - wy * qx + wz * qw) * dt,
      qw + 0.5 * (-wx * qx - wy * qy - wz * qz) * dt,
    ).normalize();
    this.forceAccum.set(0, 0, 0);
    this.torqueAccum.set(0, 0, 0);
  }
}

/* ───────────────────────── Wheel ───────────────────────── */

class Wheel {
  constructor(name, mountLocal, side, front) {
    this.name = name;
    this.mount = mountLocal;            // chassis-local (CoM origin)
    this.side = side;                   // +1 = left (+X)
    this.front = front;
    this.steerable = front;
    this.omega = 0;                     // spin, rad/s (+ = rolling forward)
    this.spinAngle = 0;
    this.steerAngle = 0;
    this.grounded = false;
    this.dist = Infinity;               // mount → ground along chassis-down
    this.compression = 0;
    this.load = 0;                      // N, the suspension force this substep
    this.Fx = 0; this.Fy = 0;
    this.slip = 0;                      // |ωR − v| m/s, for marks / dust
    this.mu = 1; this.roll = 0;
    this.source = null;
    this.hitPoint = new THREE.Vector3();
    this.hitNormal = new THREE.Vector3(0, 1, 0);
    this._hadGround = false;
    // per-substep kinematics, shared with the drivetrain solve
    this.vLong = 0; this.vLat = 0; this.Fmax = 0; this.Cs = 0;
    this.worldPos = new THREE.Vector3();
    this.fwd = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.planeRight = new THREE.Vector3();
    this.patch = new THREE.Vector3();
  }
}

/* ───────────────────────── Wheel spin ───────────────────────── */

/** Longitudinal tyre force at spin ω: linear in slip, capped at the grip limit. */
function tyreForce(w, omega, R) {
  return clamp(w.Cs * (omega * R - w.vLong), -w.Fmax, w.Fmax);
}

/**
 * The spin ω' of a wheel group after one substep, solved EXACTLY rather than
 * stepped: wheel inertia, engine torque, brake torque and the grip-limited
 * tyre force must balance —
 *
 *     I (ω' − ω0) / dt  =  Td − R·ΣF(ω') − Tb·sign(ω')
 *
 * The tyre side is a capped linear function of ω' (monotonic), so the balance
 * has exactly one root and a bisection finds it. The brake is friction: it
 * opposes the spin and can hold the wheel STILL (locked) whenever the rest of
 * the balance at ω' = 0 is within its torque. Stepping this explicitly is
 * unstable (a stiff tyre on a light wheel at 240 Hz), and the earlier
 * linearised two-pass version mis-handled a brake near the grip limit — the
 * front wheels ended up spinning faster than the ground and DRIVING the truck
 * while braking (15 m/s took 45 m to stop).
 */
function solveSpin(g, omega0, I, Td, Tb, R, dt) {
  const base = (om) => {
    let s = I * (om - omega0) / dt - Td;
    for (const w of g) if (w.grounded) s += R * tyreForce(w, om, R);
    return s;   // increasing in om
  };
  const b0 = base(0);
  if (Math.abs(b0) <= Tb) return 0;                 // the brake holds it: locked
  const target = b0 > 0 ? Tb : -Tb;                 // root where base(om) = target
  // Bracket: base grows at least I/dt per rad/s, so this span always contains it.
  const span = (Math.abs(b0) + Tb) * dt / I + 1e-6;
  let lo = b0 > 0 ? -span : 0, hi = b0 > 0 ? 0 : span;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (base(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ───────────────────────── Vehicle ───────────────────────── */

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _F = new THREE.Vector3();
const _up = new THREE.Vector3(), _fwd = new THREE.Vector3(), _down = new THREE.Vector3();
const _rayO = new THREE.Vector3(), _bestP = new THREE.Vector3(), _bestN = new THREE.Vector3();
const _q = new THREE.Quaternion(), _n = new THREE.Vector3(), _c = new THREE.Vector3(), _spd = new THREE.Vector3();

export class OffroadVehicle {
  /**
   * @param {object} o
   * @param {object} o.ground    createVehicleGround(...).ground — raycastFirst / spherecast
   * @param {object} [o.solids]  a RoadBvh of the rocks (bodywork contact), or null
   * @param {(x:number,z:number)=>number} o.getFloorY  terrain height (chassis-corner contact)
   * @param {(x:number,z:number,source:string|null)=>{mu:number,roll:number}} [o.getSurface]
   * @param {object} [o.config]  overrides of OFFROAD_DEFAULTS (deep-merged)
   */
  constructor({ ground, solids = null, getFloorY, getSurface = null, config = {} }) {
    this.cfg = mergeCfg(OFFROAD_DEFAULTS, config);
    this.ground = ground;
    this.solids = solids;
    this.getFloorY = getFloorY;
    this.getSurface = getSurface;
    this.input = { throttle: 0, steer: 0, brake: 0, handbrake: false };
    this.steerState = 0;
    this._holdActive = false;
    this._holdAnchor = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.renderPos = new THREE.Vector3();
    this.renderQuat = new THREE.Quaternion();
    this.rebuild();
  }

  /** Re-derive the body, the wheel mounts and the contact samples from `cfg`. Keeps the pose. */
  rebuild() {
    const c = this.cfg, W = c.wheel;
    const old = this.body;
    this.body = new RigidBody({ mass: c.mass, size: c.inertiaBox });
    if (old) { this.body.pos.copy(old.pos); this.body.quat.copy(old.quat); this.body.vel.copy(old.vel); this.body.angVel.copy(old.angVel); }
    // The mount height is chosen so that, at static load, the wheel centre sits
    // exactly where the model draws it (radius above the ground).
    const staticLoad = (c.mass * GRAVITY) / 4;
    this.restDist = c.susp.restLength - staticLoad / c.susp.spring;
    this.mountModelY = this.restDist;   // model frame: ground at 0
    const y = this.mountModelY - c.comHeight;
    const hz = W.wheelbase / 2;
    this.wheels = [
      new Wheel("FL", new THREE.Vector3(W.halfTrack, y, hz), 1, true),
      new Wheel("FR", new THREE.Vector3(-W.halfTrack, y, hz), -1, true),
      new Wheel("RL", new THREE.Vector3(W.halfTrack, y, -hz), 1, false),
      new Wheel("RR", new THREE.Vector3(-W.halfTrack, y, -hz), -1, false),
    ];
    // Bodywork samples (chassis-local): every corner, edge midpoints and the
    // belly — the belly points are what hang the truck up on a boulder.
    const ch = c.chassis, hw = ch.halfWidth;
    const ys = [ch.yBottom, (ch.yBottom + ch.yTop) / 2, ch.yTop].map((v) => v - c.comHeight);
    const zs = [ch.zBack, ch.zBack / 2, 0, ch.zFront / 2, ch.zFront];
    const xs = [-hw, 0, hw];
    this.samples = [];
    for (const sx of xs) for (const sy of ys) for (const sz of zs) {
      const surface = Math.abs(sx) === hw || sy === ys[0] || sy === ys[2] || sz === zs[0] || sz === zs[4];
      if (surface) this.samples.push(new THREE.Vector3(sx, sy, sz));
    }
    this.corners = [];
    for (const sx of [-hw, hw]) for (const sy of [ys[0], ys[2]]) for (const sz of [ch.zBack, ch.zFront]) this.corners.push(new THREE.Vector3(sx, sy, sz));
  }

  /** Place the truck with its wheels on the ground at (x, z), heading `yaw` (rad, 0 = +Z). */
  spawn(x, z, yaw = 0) {
    const b = this.body;
    const h = this.getFloorY(x, z);
    b.pos.set(x, (Number.isFinite(h) ? h : 0) + this.cfg.comHeight + 0.05, z);
    b.quat.setFromAxisAngle(_up.set(0, 1, 0), yaw);
    b.vel.set(0, 0, 0);
    b.angVel.set(0, 0, 0);
    for (const w of this.wheels) { w.omega = 0; w._hadGround = false; }
    this._holdActive = false;
    this.steerState = 0;
    this.prevPos.copy(b.pos); this.prevQuat.copy(b.quat);
    this.renderPos.copy(b.pos); this.renderQuat.copy(b.quat);
  }

  /** Back on its wheels where it is, facing the way it was going. */
  resetUpright() {
    _fwd.set(0, 0, 1).applyQuaternion(this.body.quat);
    this.spawn(this.body.pos.x, this.body.pos.z, Math.atan2(_fwd.x, _fwd.z));
  }

  /** Signed forward speed (m/s). Its own scratch vector: the step loop owns _fwd. */
  get speed() { return _spd.set(0, 0, 1).applyQuaternion(this.body.quat).dot(this.body.vel); }
  get groundedCount() { let n = 0; for (const w of this.wheels) if (w.grounded) n++; return n; }

  /** One fixed tick (FIXED_DT). `controls`: { throttle −1..1, steer −1..1 (+ = left), brake 0..1, handbrake }. */
  tick(controls = {}) {
    Object.assign(this.input, controls);
    this.prevPos.copy(this.body.pos);
    this.prevQuat.copy(this.body.quat);
    // Steering: rate-limited toward the input, back to centre a little faster.
    const target = clamp(this.input.steer ?? 0, -1, 1);
    const rate = Math.abs(target) < Math.abs(this.steerState) || Math.sign(target) !== Math.sign(this.steerState)
      ? this.cfg.steer.returnRate : this.cfg.steer.rate;
    const d = target - this.steerState;
    this.steerState += clamp(d, -rate * FIXED_DT, rate * FIXED_DT);
    const dt = FIXED_DT / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) this._substep(dt);
  }

  /** Interpolated pose for drawing between fixed ticks (alpha 0..1). */
  interpolate(alpha) {
    this.renderPos.lerpVectors(this.prevPos, this.body.pos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.body.quat, alpha);
  }

  _steerCentre() {
    const c = this.cfg.steer;
    const k = clamp(Math.abs(this.speed) / c.highSpeedRef, 0, 1);
    return this.steerState * c.maxAngle * (1 - k * (1 - c.highSpeedScale));
  }

  /** Ackermann (copied): the inside wheel turns further. */
  _wheelSteer(centre, localX) {
    const k = this.cfg.steer.ackermann, L = this.cfg.wheel.wheelbase;
    if (k <= 0 || centre === 0) return centre;
    const mag = Math.abs(centre), R = L / Math.tan(mag), half = Math.abs(localX);
    const inside = (centre > 0) === (localX > 0);
    const arm = inside ? Math.max(0.15, R - half) : R + half;
    return Math.sign(centre) * (mag + (Math.atan(L / arm) - mag) * k);
  }

  _substep(dt) {
    const b = this.body, c = this.cfg;
    _up.set(0, 1, 0).applyQuaternion(b.quat);
    _fwd.set(0, 0, 1).applyQuaternion(b.quat);
    _down.copy(_up).negate();
    b.addForce(_F.set(0, -GRAVITY * c.mass, 0));
    // Aero drag (copied idea; no downforce off-road).
    const sp = b.vel.length();
    if (sp > 0.01) b.addForce(_F.copy(b.vel).multiplyScalar(-c.dragCoeff * sp));

    const centre = this._steerCentre();
    for (const w of this.wheels) {
      w.steerAngle = w.steerable ? this._wheelSteer(centre, w.mount.x) : 0;
      this._wheelContact(w, dt);
    }
    this._antiRoll();
    this._drivetrain(dt);
    for (const w of this.wheels) this._wheelForces(w);
    this._hillHold();
    this._chassisFloor();
    if (this.solids?.baked) this._solidContact();
    this._stabilize();
    b.integrate(dt);
    const wMax = c.maxAngVel;
    if (b.angVel.lengthSq() > wMax * wMax) b.angVel.setLength(wMax);
    for (const w of this.wheels) w.spinAngle += w.omega * dt;
  }

  /** Probe (ring rays + sphere sweep, copied), suspension force, contact kinematics. */
  _wheelContact(w, dt) {
    const b = this.body, c = this.cfg, S = c.susp, R = c.wheel.radius;
    w.worldPos.copy(w.mount).applyQuaternion(b.quat).add(b.pos);
    w.fwd.copy(_fwd);
    w.right.set(1, 0, 0).applyQuaternion(b.quat);
    if (w.steerAngle !== 0) {
      _q.setFromAxisAngle(_up, w.steerAngle);
      w.fwd.applyQuaternion(_q);
      w.right.applyQuaternion(_q);
    }
    const pad = S.rayPad, far = S.restLength + pad;
    let best = Infinity, src = null;
    const consider = (hit, dist) => {
      if (!hit || !(dist < best)) return;
      best = dist;
      _bestP.set(hit.point.x, hit.point.y, hit.point.z);
      if (hit.normal) _bestN.set(hit.normal.x, hit.normal.y, hit.normal.z); else _bestN.set(0, 1, 0);
      src = hit.source ?? null;
    };
    const n = Math.round(S.ringCount), ringR = R * S.ringScale;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (i / (n - 1)), ca = Math.cos(a), sa = Math.sin(a);
      _rayO.copy(w.worldPos).addScaledVector(_up, pad).addScaledVector(w.fwd, ca * ringR).addScaledVector(_down, sa * ringR);
      const hit = this.ground.raycastFirst(_rayO, _down, far);
      if (hit) consider(hit, hit.distance + sa * ringR);
    }
    if (S.sphereSweep && this.ground.spherecast) {
      _rayO.copy(w.worldPos).addScaledVector(_up, pad);
      const sr = R * S.sphereScale;
      const sh = this.ground.spherecast(_rayO.x, _rayO.y, _rayO.z, sr, _down.x, _down.y, _down.z, far);
      if (sh) consider(sh, sh.distance + sr);
    }
    w.Fx = w.Fy = 0;
    // The terrain answers by VERTICAL projection whatever way the ray points,
    // so a truck on its side (chassis-down horizontal) still "hits" it and the
    // strut shoves sideways — 36 kN per wheel, measured lying at 82°. Past ~70°
    // of tilt a terrain contact is not a wheel contact.
    if (best === Infinity || (src === "terrain" && _up.y < 0.35)) {
      w.grounded = false; w.compression = 0; w.load = 0; w.dist = Infinity; w._hadGround = false;
      w.Fmax = 0; w.Cs = 0; w.slip = 0;
      return;
    }
    w.grounded = true;
    w.source = src;
    w.hitPoint.copy(_bestP);
    _n.copy(_bestN);
    if (_n.dot(_up) < 0) _n.negate();
    _n.normalize();
    if (!w._hadGround) w.hitNormal.copy(_n);
    else w.hitNormal.lerp(_n, 1 - Math.exp(-S.normalSmooth * dt)).normalize();
    w._hadGround = true;
    const distFromMount = best - pad;
    w.dist = distFromMount;
    w.compression = S.restLength - Math.max(0, distFromMount);

    // Suspension (copied): damper along the surface normal while loaded.
    b.getVelocityAtPoint(w.worldPos, _v);
    const upDotN = _up.dot(w.hitNormal);
    const upVel = w.compression > 0 && upDotN > S.damperNormalMinFacing ? _v.dot(w.hitNormal) / upDotN : _v.dot(_up);
    let spring = w.compression * S.spring;
    const ovr = w.compression - S.restLength * S.bottomOutThresh;
    if (ovr > 0) spring += ovr * ovr * S.spring * S.bottomOutMult;
    const load = Math.max(0, spring - upVel * S.damper);
    w.load = load;
    b.addForceAtPoint(_F.copy(_up).multiplyScalar(load), w.worldPos);

    // Contact-plane kinematics for the tyre.
    _v2.copy(_v).addScaledVector(w.hitNormal, -_v.dot(w.hitNormal));
    w.planeRight.copy(w.right).addScaledVector(w.hitNormal, -w.right.dot(w.hitNormal));
    const rl = w.planeRight.length();
    if (rl > 1e-4) w.planeRight.multiplyScalar(1 / rl); else w.planeRight.copy(w.right);
    w.vLat = _v2.dot(w.planeRight);
    w.vLong = _v.dot(w.fwd);
    const surf = this.getSurface ? this.getSurface(w.hitPoint.x, w.hitPoint.z, src) : null;
    w.mu = surf?.mu ?? 1;
    w.roll = surf?.roll ?? 0;
    w.Fmax = c.tire.mu * w.mu * load;
    // Linearised longitudinal slip stiffness (N per m/s) for the implicit spin solve.
    w.Cs = (w.Fmax * c.tire.longStiffness) / Math.max(Math.abs(w.vLong), c.tire.longRef);
    w.patch.copy(w.worldPos).addScaledVector(_up, -distFromMount);
  }

  /**
   * ANTI-ROLL BARS: per axle, a force proportional to the left/right
   * compression difference, up on the more compressed side and down on the
   * other — less body roll in a turn, so less weight swung outward. Applied
   * at the grounded wheels only (a hanging wheel just droops), and folded
   * into their load so the grip follows the transfer.
   */
  _antiRoll() {
    const b = this.body, ar = this.cfg.antiRoll;
    for (const [L, Rt, k] of [[this.wheels[0], this.wheels[1], ar.front], [this.wheels[2], this.wheels[3], ar.rear]]) {
      if (!k || (!L.grounded && !Rt.grounded)) continue;
      const dF = k * ((L.grounded ? L.compression : 0) - (Rt.grounded ? Rt.compression : 0));
      for (const [w, f] of [[L, dF], [Rt, -dF]]) {
        if (!w.grounded) continue;
        const nl = Math.max(0, w.load + f);
        b.addForceAtPoint(_F.copy(_up).multiplyScalar(nl - w.load), w.worldPos);
        w.load = nl;
        w.Fmax = this.cfg.tire.mu * w.mu * nl;
        w.Cs = (w.Fmax * this.cfg.tire.longStiffness) / Math.max(Math.abs(w.vLong), this.cfg.tire.longRef);
      }
    }
  }

  /**
   * Engine → differentials → wheel spin → longitudinal tyre force.
   *
   * Each GROUP of wheels shares one spin: an open axle is two groups of one
   * (equal torque, independent spin — a lifted wheel spins up and, because the
   * engine curve reads the average driven spin, the torque falls away: the
   * open-diff stall), a locked truck is one group of four. Each group's spin is
   * solved exactly against the grip-limited tyre force (solveSpin above).
   */
  _drivetrain(dt) {
    const c = this.cfg, R = c.wheel.radius, Iw = c.wheel.inertia, E = c.engine, D = c.drivetrain;
    const thr = clamp(this.input.throttle ?? 0, -1, 1);
    const low = !!D.lowRange;
    const Tmax = E.torque * (low ? E.lowRatio : 1);
    const vMax = E.maxWheelSpeed / (low ? E.lowRatio : 1);
    const speed = this.speed;
    // Average driven rim speed, for the engine curve.
    let avg = 0;
    for (const w of this.wheels) avg += w.omega * R;
    avg /= 4;
    let Tengine = 0, brakeAll = clamp(this.input.brake ?? 0, 0, 1);
    if (thr > 0) {
      if (speed < -c.brakes.switchToReverse) brakeAll = Math.max(brakeAll, thr);
      else Tengine = thr * Tmax * Math.max(0, 1 - Math.pow(clamp(avg / vMax, 0, 1), E.curveExp));
    } else if (thr < 0) {
      if (speed > c.brakes.switchToReverse) brakeAll = Math.max(brakeAll, -thr);
      else Tengine = thr * Tmax * E.reverseScale * Math.max(0, 1 - Math.pow(clamp(-avg / (vMax * 0.45), 0, 1), E.curveExp));
    } else {
      Tengine = -clamp(avg * 300, -E.engineBrake, E.engineBrake);
    }
    // Per-wheel engine share: front/rear split, then half to each side.
    const share = (w) => (D.layout === "RWD" ? (w.front ? 0 : 0.5) : D.layout === "FWD" ? (w.front ? 0.5 : 0) : (w.front ? D.frontShare : 1 - D.frontShare) / 2);
    const groups = D.diffLock ? [this.wheels] : this.wheels.map((w) => [w]);
    // AN OPEN DIFF gives both wheels of an axle the SAME torque, and no more
    // than the weaker one can push against: a wheel in the air resists almost
    // nothing, so its partner on the ground gets almost nothing either — the
    // classic open-diff stall, and the reason the lockers exist. (Without this
    // the grounded wheels kept their full share and the truck crept out of a
    // cross-axle pit with open diffs.) The small floor lets a hanging wheel
    // still spin up, as it visibly does.
    const OPEN_FLOOR = 150;
    const axleCap = (w) => {
      const a = w.front ? [this.wheels[0], this.wheels[1]] : [this.wheels[2], this.wheels[3]];
      const weak = Math.min(...a.map((x) => (x.grounded ? x.Fmax : 0)));
      return R * weak + OPEN_FLOOR;
    };
    for (const g of groups) {
      let I = 0, Td = 0, Tb = 0;
      for (const w of g) {
        I += Iw;
        const t = Tengine * share(w);
        Td += D.diffLock ? t : Math.sign(t) * Math.min(Math.abs(t), axleCap(w));
        Tb += brakeAll * c.brakes.torque + (this.input.handbrake && !w.front ? c.brakes.handbrake : 0);
      }
      const omega = solveSpin(g, g[0].omega, I, Td, Tb, R, dt);
      for (const w of g) {
        w.Fx = w.grounded ? tyreForce(w, omega, R) : 0;
        w.omega = omega;
        w.slip = w.grounded ? Math.abs(omega * R - w.vLong) : 0;
      }
    }
  }

  /** Lateral grip (brush model, copied), rolling resistance, friction circle, apply at the patch. */
  _wheelForces(w) {
    if (!w.grounded) return;
    const c = this.cfg, b = this.body;
    const vRef = Math.max(Math.abs(w.vLong), c.tire.lowSpeedRef);
    let fy = -clamp((w.vLat / vRef) * c.tire.latStiffness, -1, 1) * w.Fmax;
    let fx = w.Fx;
    // Rolling resistance: grass and sand hold the truck back, rock barely does.
    const rr = (c.rollingResistance + w.roll) * w.load;
    fx -= rr * clamp(w.vLong / 0.3, -1, 1);
    const demand = Math.hypot(fx, fy);
    if (demand > w.Fmax && demand > 1e-6) { const s = w.Fmax / demand; fx *= s; fy *= s; }
    w.Fx = fx; w.Fy = fy;
    b.addForceAtPoint(_F.copy(w.planeRight).multiplyScalar(fy), w.patch);
    b.addForceAtPoint(_F.copy(w.fwd).multiplyScalar(fx), w.patch);
  }

  /**
   * HILL HOLD. Below `hold.speed` with no throttle, a spring to where the truck
   * stopped keeps it there on any slope its tyres can hold — an automatic 4x4's
   * hold. Without it the brush tyre (no force at zero slip) lets it creep
   * downhill (the Apex Rush car has the same property; a race car never parks).
   */
  _hillHold() {
    const b = this.body, H = this.cfg.hold;
    const grounded = this.groundedCount;
    // Engages below `hold.speed` of GROUND speed (a settling drop is not
    // motion), then stays latched until the throttle is touched — a truck
    // that is held does not let go because the slope nudged it.
    const noThrottle = Math.abs(this.input.throttle ?? 0) < 0.05;
    const groundSpeed = Math.hypot(b.vel.x, b.vel.z);
    if (!noThrottle || grounded < 2) { this._holdActive = false; return; }
    if (!this._holdActive && groundSpeed > H.speed) return;
    if (!this._holdActive) { this._holdActive = true; this._holdAnchor.copy(b.pos); }
    let budget = 0;
    for (const w of this.wheels) if (w.grounded) budget += w.Fmax;
    _v.subVectors(this._holdAnchor, b.pos);
    _F.copy(_v).multiplyScalar(H.spring).addScaledVector(b.vel, -H.damper);
    _F.y = 0;                                // the suspension owns the vertical
    const mag = _F.length();
    if (mag > budget) _F.multiplyScalar(budget / mag);
    b.addForce(_F);
    // A held truck's wheels do not turn.
    for (const w of this.wheels) w.omega = 0;
    // Damp yaw too, or it pivots on the spring.
    _up.set(0, 1, 0).applyQuaternion(b.quat);
    b.torqueAccum.addScaledVector(_up, -b.angVel.dot(_up) * 4000);
  }

  /** Chassis corners against the terrain (copied, without the roof states). */
  _chassisFloor() {
    const b = this.body, ch = this.cfg.chassis;
    for (const corner of this.corners) {
      _c.copy(corner).applyQuaternion(b.quat).add(b.pos);
      const floorY = this.getFloorY(_c.x, _c.z);
      if (!(_c.y < floorY)) continue;           // NaN floor = skip the corner
      const pen = floorY - _c.y;
      b.getVelocityAtPoint(_c, _v);
      const up = pen * ch.cornerSpring + Math.max(0, -_v.y) * ch.cornerDamper;
      b.addForceAtPoint(_F.set(0, up, 0), _c);
      const hs = Math.hypot(_v.x, _v.z);
      if (hs > 0.01) b.addForceAtPoint(_F.set((-_v.x / hs) * ch.cornerFriction * up, 0, (-_v.z / hs) * ch.cornerFriction * up), _c);
    }
  }

  /**
   * The bodywork against the rocks: every sample point near a rock face gets a
   * penalty spring out along the face normal, a damper on the closing speed and
   * friction — so the truck can be hung up on its belly, scrape along a crag,
   * or be stopped by a boulder its wheels cannot climb.
   */
  _solidContact() {
    const b = this.body, S = this.cfg.solids;
    for (const s of this.samples) {
      _c.copy(s).applyQuaternion(b.quat).add(b.pos);
      const hit = this.solids.closestPointWithNormal(_c.x, _c.y, _c.z, S.probe, _n);
      if (!hit) continue;
      let pen;
      if (hit.behind) { _n.negate(); pen = hit.distance + S.skin; }   // inside: out the way it came
      else pen = S.skin - hit.distance;
      if (pen <= 0) continue;
      pen = Math.min(pen, S.maxPen);
      b.getVelocityAtPoint(_c, _v);
      const vn = _v.dot(_n);
      const fn = Math.max(0, pen * S.spring - vn * S.damper);
      b.addForceAtPoint(_F.copy(_n).multiplyScalar(fn), _c);
      _v2.copy(_v).addScaledVector(_n, -vn);
      const vt = _v2.length();
      if (vt > 0.01) b.addForceAtPoint(_F.copy(_v2).multiplyScalar(-(S.friction * fn) / vt), _c);
    }
  }

  /** Grounded stabilizer (copied, much weaker): leave room for articulation. */
  _stabilize() {
    const b = this.body, st = this.cfg.stabilizer;
    let n = 0;
    _n.set(0, 0, 0);
    for (const w of this.wheels) if (w.grounded) { n++; _n.add(w.hitNormal); }
    if (n === 0 || _n.lengthSq() < 1e-8) return;
    _n.normalize();
    _up.set(0, 1, 0).applyQuaternion(b.quat);
    if (n >= 2) b.torqueAccum.addScaledVector(_v.crossVectors(_up, _n), st.align * n * 0.25);
    const wYaw = b.angVel.dot(_up);
    b.torqueAccum.addScaledVector(_v.copy(b.angVel).addScaledVector(_up, -wYaw), -st.damp);
  }

  /**
   * Drive the procedural truck (offroadTruck.js) from the interpolated pose:
   * root at the pose minus the centre of mass, each wheel at its suspension
   * travel, steered, spinning. Call after interpolate().
   */
  syncVisuals(truck) {
    const c = this.cfg, R = c.wheel.radius;
    truck.root.position.copy(_v.set(0, -c.comHeight, 0).applyQuaternion(this.renderQuat).add(this.renderPos));
    truck.root.quaternion.copy(this.renderQuat);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], vis = truck.wheels.find((t) => t.name === w.name);
      if (!vis) continue;
      // Wheel centre below the mount by (dist − R), between full droop and the bump stop.
      const ext = w.grounded ? clamp(w.dist - R, -0.05, c.susp.restLength - R) : c.susp.restLength - R;
      vis.group.position.set(w.mount.x, this.mountModelY - ext, w.mount.z);
      vis.group.rotation.y = w.steerAngle;
      vis.spin.rotation.x = w.spinAngle;
    }
  }
}
