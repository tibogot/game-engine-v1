/**
 * Very Very Valet-style rigid-body car physics.
 *
 * One rigid body (the chassis) + 4 wheel raycast probes. Each grounded wheel
 * applies 3 forces at its hub world position:
 *
 *   1. SUSPENSION    — spring + damper along chassis-up, with quadratic
 *                      bottom-out that stops high-speed slope tunneling.
 *   2. STEERING      — lateral grip kills sideways tire velocity, clamped
 *                      by the friction circle (|F_lat| ≤ μ·Fn).
 *   3. LONGITUDINAL  — throttle / brake / reverse with power-curve falloff
 *                      toward a top-speed cap, also friction-circle-clamped.
 *
 * Companions: anti-roll stabilizer (only fires when wheels are grounded and
 * the chassis isn't past sideways), angular velocity cap, optional chassis
 * wall probes for lateral collision.
 *
 * Source of truth: `models/lotus-vvv-physics.html` (the standalone test page).
 * This module is its v2 export — play mode can drive a "vvv" car against
 * cliffBvh + the terrain heightmap.
 *
 * The wheel doesn't query the world directly. Callers pass:
 *   - `groundQuery(ox, oy, oz, dx, dy, dz, maxDist) → { distance, point } | null`
 *     for the wheel probes (BVH-backed in v2, Raycaster-backed standalone)
 *   - `wallQuery(ox, oy, oz, dx, dy, dz, maxDist) → { distance, point } | null`
 *     for chassis lateral probes (also pluggable)
 */
import * as THREE from "three";

// ============================================================
// === DEFAULT TUNINGS — shallow-copy before mutating per-instance.
// ============================================================
export const DEFAULT_VVV_CHASSIS = {
  width:  1.8,
  height: 0.6,
  length: 3.6,
  mass:   1400,
  /** Visual-only Y offset of the chassis mesh above the body (m). */
  visualLift: 0,
  /** CoM this many meters below the mesh layout origin (+Z fwd, centered chassis). */
  comLower: 0.0,
};

/** Standalone (`models/lotus-vvv-physics.html`) uses real g. Keep it that way —
 *  the spring/damper tuning below was derived for 9.81, not the arcade 28. */
export const VVV_GRAVITY = 9.81;

export const DEFAULT_VVV_WHEEL = {
  radius:    0.36,
  thickness: 0.24,
  rimRadius: 0.22,
  rimWidth:  0.26,
};

export const DEFAULT_VVV_TIRE = {
  rayLength:       1.0,
  rayPadAbove:     0.6,
  rayForwardBias:  0.6,
  rayLateralBias:  1.0,
  /** Visual-only smoothing rate (1/s) for wheel-droop transitions. */
  suspVisSmooth:   12,
  restLength:      0.55,
  springStrength:  65000,
  damper:          6500,
  bottomOutThresh: 0.7,
  bottomOutMult:   8,
  gripFront:       1.0,
  gripRear:        1.0,
  gripHandbrake:   0.08,
  accelForce:      4000,
  topSpeed:        30,
  powerCurveExp:   2.0,
  brakeForce:      8000,
  reverseAccel:    2000,
  brakeReverseThreshold: 0.5,
  engineBrake:     800,
  maxSteerAngle:   0.55,
  steerSmooth:     8.0,
  frictionCoeff:   5.0,
  maxAngVel:       9.0,
  /** Torque pulling chassis-up toward world-up (N·m per rad of tilt). */
  stabilizerStrength: 8000,
  /** Damps roll/pitch spin (N·m per rad/s) — 0 = exact standalone behaviour. */
  stabilizerRollDamp: 0,
};

export const DEFAULT_VVV_WALL = {
  probeRange:   0.9,
  stiffness:    300000,
  damper:       14000,
  clampPenFrac: 0.4,
};

/** Wheel local positions: front/rear ± 1.4m on Z, left/right ± 1.05m on X,
 *  hub 0.10m below CoM. Front pair steer + drive; rear drives only. */
/**
 * Spring/damper tuned for ~30–40 mm static deflection per wheel at `gravity`.
 * Call after real wheel radius is known (sets `restLength` ≈ radius + gap).
 */
/**
 * Match standalone VVV: restLength ≈ |hub below CoM| + tyre radius + travel,
 * sized so a static car compresses ~5 cm (≈ standalone). Keeps the standalone's
 * 65000 N/m / 6500 N·s/m tuning when mass and gravity match its defaults.
 */
export function deriveVvvTireFromVehicle({
  mass,
  wheelRadius,
  hubLocalY = -0.1,
  gravity = VVV_GRAVITY,
  staticDeflection = 0.055,
  travel = 0.09,
  damperRatio = 0.5,
}) {
  const hubDrop = Math.abs(hubLocalY);
  const restLength = hubDrop + wheelRadius + travel;
  const wheelLoad = mass * gravity * 0.25;
  const springStrength = Math.min(
    120000,
    Math.max(40000, wheelLoad / staticDeflection),
  );
  const mWheel = mass / 4;
  const damper = damperRatio * 2 * Math.sqrt(springStrength * mWheel);
  return {
    restLength,
    springStrength,
    damper,
    rayLength: Math.max(0.85, restLength + 0.5),
  };
}

export function createDefaultVvvWheelLayout() {
  return [
    { name: "FL", pos: new THREE.Vector3(-1.05, -0.10,  1.40), steer: true,  drive: true  },
    { name: "FR", pos: new THREE.Vector3( 1.05, -0.10,  1.40), steer: true,  drive: true  },
    { name: "RL", pos: new THREE.Vector3(-1.05, -0.10, -1.40), steer: false, drive: true  },
    { name: "RR", pos: new THREE.Vector3( 1.05, -0.10, -1.40), steer: false, drive: true  },
  ];
}

/** 4 chassis lateral probe positions for wall collision (face centers). */
export function createDefaultVvvWallProbes(chassis) {
  const hw = chassis.width / 2;
  const hl = chassis.length / 2;
  return [
    { name: "front", pos: new THREE.Vector3( 0,  0,  hl), dir: new THREE.Vector3( 0, 0,  1) },
    { name: "rear",  pos: new THREE.Vector3( 0,  0, -hl), dir: new THREE.Vector3( 0, 0, -1) },
    { name: "right", pos: new THREE.Vector3( hw, 0,   0), dir: new THREE.Vector3( 1, 0,  0) },
    { name: "left",  pos: new THREE.Vector3(-hw, 0,   0), dir: new THREE.Vector3(-1, 0,  0) },
  ];
}

// ============================================================
// === RIGID BODY — 6-DOF dynamics, force/torque accumulators
// ============================================================
export class RigidBody {
  constructor({ mass, size }) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.localInvInertia = new THREE.Matrix3();
    this._setInertiaFromBox(mass, size);
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
  }

  _setInertiaFromBox(mass, { width: w, height: h, length: l }) {
    const Ixx = (mass / 12) * (h * h + l * l);
    const Iyy = (mass / 12) * (w * w + l * l);
    const Izz = (mass / 12) * (w * w + h * h);
    this.localInvInertia.set(
      1 / Ixx, 0, 0,
      0, 1 / Iyy, 0,
      0, 0, 1 / Izz,
    );
  }

  /** Call this when mass or chassis dimensions change. */
  rebuildInertia({ mass, size }) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this._setInertiaFromBox(mass, size);
  }

  /** Add a force at the centre of mass (no torque). */
  addForce(F) {
    this.forceAccum.add(F);
  }

  /** Add a force at a world point. Generates both linear push AND torque
   *  around the CoM: τ = (worldPoint − pos) × F. */
  addForceAtPoint(F, worldPoint) {
    this.forceAccum.add(F);
    this._r.subVectors(worldPoint, this.pos);
    this._tau.crossVectors(this._r, F);
    this.torqueAccum.add(this._tau);
  }

  /** Velocity of a body-fixed point: v + ω × r. */
  getVelocityAtPoint(worldPoint, out) {
    this._r.subVectors(worldPoint, this.pos);
    this._rotVel.crossVectors(this.angVel, this._r);
    return out.addVectors(this.vel, this._rotVel);
  }

  /** Semi-implicit Euler step. Call AFTER all forces applied. Clears accums. */
  integrate(dt) {
    // Linear: a = F/m
    this.vel.x += this.forceAccum.x * this.invMass * dt;
    this.vel.y += this.forceAccum.y * this.invMass * dt;
    this.vel.z += this.forceAccum.z * this.invMass * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    // Angular: world-space inverse inertia = R · I_local⁻¹ · Rᵀ
    this._mat.makeRotationFromQuaternion(this.quat);
    this._R3.setFromMatrix4(this._mat);
    this._R3t.copy(this._R3).transpose();
    this._worldInvI
      .copy(this._R3)
      .multiply(this.localInvInertia)
      .multiply(this._R3t);

    // α = I_world⁻¹ · τ
    this._tau.copy(this.torqueAccum).applyMatrix3(this._worldInvI);
    this.angVel.x += this._tau.x * dt;
    this.angVel.y += this._tau.y * dt;
    this.angVel.z += this._tau.z * dt;

    // Quaternion: q̇ = 0.5 · ω_quat · q  (ω_quat = (ωx, ωy, ωz, 0))
    const wx = this.angVel.x, wy = this.angVel.y, wz = this.angVel.z;
    const qx = this.quat.x, qy = this.quat.y, qz = this.quat.z, qw = this.quat.w;
    const dqx = 0.5 * ( wx * qw + wy * qz - wz * qy);
    const dqy = 0.5 * (-wx * qz + wy * qw + wz * qx);
    const dqz = 0.5 * ( wx * qy - wy * qx + wz * qw);
    const dqw = 0.5 * (-wx * qx - wy * qy - wz * qz);
    this.quat.set(qx + dqx * dt, qy + dqy * dt, qz + dqz * dt, qw + dqw * dt);
    this.quat.normalize();

    this.forceAccum.set(0, 0, 0);
    this.torqueAccum.set(0, 0, 0);
  }

  /** Hard cap on angular velocity magnitude. Prevents numerical runaway. */
  capAngularVelocity(maxAngVel) {
    const wSq = this.angVel.lengthSq();
    if (wSq > maxAngVel * maxAngVel) {
      this.angVel.setLength(maxAngVel);
    }
  }
}

// ============================================================
// === TIRE — 5-ray contact-patch probe + 3 forces (VVV pattern)
// ============================================================
export class Tire {
  constructor({ name, localPos, steer, drive }) {
    this.name = name;
    this.localPos = localPos.clone();
    this.canSteer = !!steer;
    this.canDrive = !!drive;

    this.grounded = false;
    this.compression = 0;
    this.hitDistance = DEFAULT_VVV_TIRE.rayLength;
    this.hitPoint = new THREE.Vector3();
    this.worldPos = new THREE.Vector3();
    this.lastSuspension = new THREE.Vector3();
    this.lastSteering = new THREE.Vector3();
    this.lastAccel = new THREE.Vector3();

    this._tireVel = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wheelFwd = new THREE.Vector3();
    this._wheelRight = new THREE.Vector3();
    this._steerQuat = new THREE.Quaternion();
    this._F = new THREE.Vector3();
  }

  /**
   * @param {RigidBody} body
   * @param {number} dt
   * @param {object} ctx
   * @param {number}   ctx.steerAngle  Steering angle (rad).
   * @param {number}   ctx.throttle    -1..+1 longitudinal input.
   * @param {boolean}  ctx.handbrake
   * @param {(ox:number, oy:number, oz:number, dx:number, dy:number, dz:number, maxDist:number)
   *           => { distance:number, point:{x:number,y:number,z:number} } | null} ctx.groundQuery
   *   Wheel probe callback. MUST cast a ray from (ox,oy,oz) along (dx,dy,dz)
   *   for up to `maxDist` and return the FIRST hit (or null).
   * @param {object} ctx.tireT   Tire tuning (DEFAULT_VVV_TIRE shape).
   * @param {object} ctx.wheelT  Wheel tuning (DEFAULT_VVV_WHEEL shape).
   */
  apply(body, dt, ctx) {
    const { steerAngle, throttle, handbrake, groundQuery, tireT, wheelT } = ctx;

    // World-space hub
    this.worldPos.copy(this.localPos).applyQuaternion(body.quat).add(body.pos);

    // Body basis vectors
    this._up.set(0, 1, 0).applyQuaternion(body.quat);
    this._fwd.set(0, 0, 1).applyQuaternion(body.quat);
    this._right.set(1, 0, 0).applyQuaternion(body.quat);

    // Steer rotation (front wheels only)
    this._wheelFwd.copy(this._fwd);
    this._wheelRight.copy(this._right);
    if (this.canSteer && steerAngle !== 0) {
      this._steerQuat.setFromAxisAngle(this._up, steerAngle);
      this._wheelFwd.applyQuaternion(this._steerQuat);
      this._wheelRight.applyQuaternion(this._steerQuat);
    }

    // 5-ray contact-patch probe. All rays start `padAbove` above the hub
    // (along chassis-up) and shoot DOWN. Take the smallest hit distance =
    // highest surface seen.
    const pad = tireT.rayPadAbove;
    const maxDist = tireT.rayLength + pad;
    const fwdBias = tireT.rayForwardBias * wheelT.radius;
    const latBias = tireT.rayLateralBias * wheelT.thickness * 0.5;
    const dirX = -this._up.x;
    const dirY = -this._up.y;
    const dirZ = -this._up.z;
    const baseX = this.worldPos.x + this._up.x * pad;
    const baseY = this.worldPos.y + this._up.y * pad;
    const baseZ = this.worldPos.z + this._up.z * pad;

    let bestDist = Infinity;
    let bestX = 0, bestY = 0, bestZ = 0;

    const tryProbe = (ox, oy, oz) => {
      const hit = groundQuery(ox, oy, oz, dirX, dirY, dirZ, maxDist);
      if (hit && hit.distance < bestDist) {
        bestDist = hit.distance;
        bestX = hit.point.x; bestY = hit.point.y; bestZ = hit.point.z;
      }
    };

    // Center
    tryProbe(baseX, baseY, baseZ);
    // Forward / rear
    if (fwdBias > 1e-4) {
      tryProbe(
        baseX + this._wheelFwd.x * fwdBias,
        baseY + this._wheelFwd.y * fwdBias,
        baseZ + this._wheelFwd.z * fwdBias,
      );
      tryProbe(
        baseX - this._wheelFwd.x * fwdBias,
        baseY - this._wheelFwd.y * fwdBias,
        baseZ - this._wheelFwd.z * fwdBias,
      );
    }
    // Left / right
    if (latBias > 1e-4) {
      tryProbe(
        baseX + this._wheelRight.x * latBias,
        baseY + this._wheelRight.y * latBias,
        baseZ + this._wheelRight.z * latBias,
      );
      tryProbe(
        baseX - this._wheelRight.x * latBias,
        baseY - this._wheelRight.y * latBias,
        baseZ - this._wheelRight.z * latBias,
      );
    }

    this.lastSuspension.set(0, 0, 0);
    this.lastSteering.set(0, 0, 0);
    this.lastAccel.set(0, 0, 0);

    if (bestDist === Infinity) {
      this.grounded = false;
      this.compression = 0;
      this.hitDistance = tireT.rayLength;
      return;
    }

    this.grounded = true;
    this.hitPoint.set(bestX, bestY, bestZ);
    // distFromHub: + = surface below hub (normal), − = surface above (tunneled).
    const distFromHub = bestDist - pad;
    this.hitDistance = distFromHub;
    this.compression = tireT.restLength - distFromHub;

    body.getVelocityAtPoint(this.worldPos, this._tireVel);

    // ---- 1) SUSPENSION (along chassis-up) ----
    // Exact standalone (`models/lotus-vvv-physics.html`) formula. Damper opposes
    // hub velocity along chassis-up; quadratic bottom-out kicks in past 70 % of
    // restLength to stop high-speed ramp tunneling.
    const upVel = this._tireVel.dot(this._up);
    let springMag = this.compression * tireT.springStrength;
    const ovr = this.compression - tireT.restLength * tireT.bottomOutThresh;
    if (ovr > 0) {
      springMag += ovr * ovr * tireT.springStrength * tireT.bottomOutMult;
    }
    const suspMag = Math.max(0, springMag - tireT.damper * upVel);
    this._F.copy(this._up).multiplyScalar(suspMag);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastSuspension.copy(this._F);

    // ---- 2) STEERING (lateral grip, friction-circle clamped) ----
    const sideVel = this._tireVel.dot(this._wheelRight);
    const grip = this.canSteer
      ? tireT.gripFront
      : (handbrake ? tireT.gripHandbrake : tireT.gripRear);
    const desiredVelChange = -sideVel * grip;
    const tireMass = body.mass / 4;
    let steerMag = tireMass * (desiredVelChange / dt);
    const maxLat = tireT.frictionCoeff * suspMag;
    if (steerMag >  maxLat) steerMag =  maxLat;
    if (steerMag < -maxLat) steerMag = -maxLat;
    this._F.copy(this._wheelRight).multiplyScalar(steerMag);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastSteering.copy(this._F);

    // ---- 3) LONGITUDINAL (throttle / brake / reverse / engine brake) ----
    if (this.canDrive) {
      let accelMag = 0;
      const carSpeed = body.vel.dot(this._fwd);
      const thr = tireT.brakeReverseThreshold;
      if (throttle > 0) {
        if (carSpeed < -thr) {
          accelMag = tireT.brakeForce;
        } else {
          const normSpeed = Math.min(1, Math.abs(carSpeed) / tireT.topSpeed);
          const power = Math.max(0, 1 - Math.pow(normSpeed, tireT.powerCurveExp));
          accelMag = tireT.accelForce * power;
        }
      } else if (throttle < 0) {
        if (carSpeed > thr) {
          accelMag = -tireT.brakeForce;
        } else {
          const normSpeed = Math.min(1, Math.abs(carSpeed) / tireT.topSpeed);
          const power = Math.max(0, 1 - Math.pow(normSpeed, tireT.powerCurveExp));
          accelMag = -tireT.reverseAccel * power;
        }
      } else {
        const fwdVel = this._tireVel.dot(this._wheelFwd);
        accelMag = -Math.sign(fwdVel) * Math.min(
          Math.abs(fwdVel) * 200,
          tireT.engineBrake,
        );
      }
      const maxLong = tireT.frictionCoeff * suspMag;
      if (accelMag >  maxLong) accelMag =  maxLong;
      if (accelMag < -maxLong) accelMag = -maxLong;
      this._F.copy(this._wheelFwd).multiplyScalar(accelMag);
      body.addForceAtPoint(this._F, this.worldPos);
      this.lastAccel.copy(this._F);
    }
  }
}

// ============================================================
// === STABILIZER — anti-roll/anti-pitch torque
// ============================================================
const _stabUp = new THREE.Vector3();
const _stabTorque = new THREE.Vector3();

/** Applies a restoring torque that pulls chassis-up toward world-up. Only
 *  fires while at least one wheel is grounded AND the chassis hasn't tipped
 *  past sideways — so a crashed car stays crashed, but normal driving stays
 *  planted. Idempotent if tireT.stabilizerStrength === 0. */
export function applyVvvStabilizer(body, tires, tireT) {
  if (tireT.stabilizerStrength <= 0) return;
  let grounded = 0;
  for (let i = 0; i < tires.length; i++) if (tires[i].grounded) grounded++;
  if (grounded === 0) return;

  _stabUp.set(0, 1, 0).applyQuaternion(body.quat);
  const cosT = _stabUp.y; // 1 upright, 0 sideways, -1 inverted
  if (cosT < 0.3) return;

  const tilt = 1 - cosT;
  const k = tireT.stabilizerStrength * tilt;
  _stabTorque.set(-_stabUp.z * k, 0, _stabUp.x * k);
  const rollDamp = tireT.stabilizerRollDamp ?? 0;
  if (rollDamp > 0) {
    _stabTorque.x -= body.angVel.x * rollDamp;
    _stabTorque.z -= body.angVel.z * rollDamp;
  }
  body.torqueAccum.add(_stabTorque);
}

// ============================================================
// === CHASSIS WALL PROBES — lateral collision response
// ============================================================
const _wpOrigin = new THREE.Vector3();
const _wpDir = new THREE.Vector3();
const _wpVel = new THREE.Vector3();
const _wpF = new THREE.Vector3();

/**
 * Cast lateral probes from each chassis face outward; push the body back
 * along the surface normal when penetrated. Hard-clamps inward velocity
 * when penetration exceeds `wallT.clampPenFrac` × `probeRange`.
 *
 * @param {RigidBody} body
 * @param {Array<{ pos: THREE.Vector3, dir: THREE.Vector3 }>} probeLocals
 * @param {object} wallT  DEFAULT_VVV_WALL-shaped tuning.
 * @param {(ox:number, oy:number, oz:number, dx:number, dy:number, dz:number, maxDist:number)
 *          => { distance:number, point:{x:number,y:number,z:number} } | null} wallQuery
 */
export function applyVvvWallProbes(body, probeLocals, wallT, wallQuery) {
  for (let i = 0; i < probeLocals.length; i++) {
    const p = probeLocals[i];
    _wpOrigin.copy(p.pos).applyQuaternion(body.quat).add(body.pos);
    _wpDir.copy(p.dir).applyQuaternion(body.quat);

    const hit = wallQuery(
      _wpOrigin.x, _wpOrigin.y, _wpOrigin.z,
      _wpDir.x, _wpDir.y, _wpDir.z,
      wallT.probeRange,
    );
    if (!hit) continue;
    const pen = wallT.probeRange - hit.distance;
    if (pen <= 0) continue;

    body.getVelocityAtPoint(hit.point, _wpVel);
    const inwardVel = _wpVel.dot(_wpDir);
    const dampMag = Math.max(0, inwardVel) * wallT.damper;
    const forceMag = pen * wallT.stiffness + dampMag;

    _wpF.copy(_wpDir).multiplyScalar(-forceMag);
    body.addForceAtPoint(_wpF, hit.point);

    if (pen > wallT.probeRange * wallT.clampPenFrac) {
      const vInto = body.vel.dot(_wpDir);
      if (vInto > 0) {
        body.vel.addScaledVector(_wpDir, -vInto);
      }
    }
  }
}
