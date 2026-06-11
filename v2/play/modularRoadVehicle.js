import * as THREE from "three";

/**
 * VVV-pattern raycast vehicle — recreated (not imported) from the Lotus VVV
 * physics lab so it can be tuned independently. A 6-DOF rigid body with four
 * multi-ray wheel probes (tire ring + optional sphere sweep), oriented-box
 * chassis collision vs the solids BVH, deck contact for elevated track, and
 * surface-aligned stabilizer.
 *
 * All tuning lives in the exported mutable objects below; build a UI against
 * them and the changes take effect live. Dimension/mass edits need
 * `vehicle.rebuildBody()`.
 */

export const GRAVITY = 9.81;

export const CHASSIS = {
  width: 1.8,
  height: 0.6,
  length: 3.6,
  mass: 1400,
  /** CoM offset from the collision-box center (+X right, +Y up, +Z front). */
  comX: 0,
  comY: 0,
  comZ: 0,
  /** Visual-only mesh lift along chassis-up (physics unchanged). */
  visualLift: 0,
};

/** Wheel hubs in chassis-local space. z>0 = front. */
export const WHEEL_LOCAL = [
  { name: "FL", pos: new THREE.Vector3(-1.05, -0.1, 1.4), steer: true, drive: true },
  { name: "FR", pos: new THREE.Vector3(1.05, -0.1, 1.4), steer: true, drive: true },
  { name: "RL", pos: new THREE.Vector3(-1.05, -0.1, -1.4), steer: false, drive: true },
  { name: "RR", pos: new THREE.Vector3(1.05, -0.1, -1.4), steer: false, drive: true },
];

export const TIRE = {
  rayLength: 1.0,
  rayPadAbove: 0.6,
  /** Legacy forward/lateral offsets — used only when rayRingCount < 3. */
  rayForwardBias: 0.6,
  rayLateralBias: 1.0,
  /** Rays around the bottom semicircle of the tire (longitudinal × vertical plane). */
  rayRingCount: 10,
  rayRingScale: 0.92, // × wheel radius
  /** Swept-sphere cast along the probe (catches ramp lips between discrete rays). */
  useSphereSweep: true,
  sphereSweepScale: 0.88, // × wheel radius
  suspVisSmooth: 12,
  restLength: 0.55,
  springStrength: 65000,
  damper: 6500,
  bottomOutThresh: 0.7,
  bottomOutMult: 8,
  // Per-axle friction multipliers (× frictionCoeff). Lower the rear for
  // oversteer, lower the front for understeer. Handbrake swaps the rear out.
  gripFront: 1.0,
  gripRear: 1.0,
  gripHandbrake: 0.35,
  // Lateral slip model: force builds linearly with slip then saturates at the
  // friction circle. `tireStiffness` is the slope (≈ 1/peak-slip-angle); higher
  // = sharper, more grip before sliding. `lowSpeedRef` keeps slip well-defined
  // near standstill so the car doesn't jitter when parked.
  tireStiffness: 7.0,
  lowSpeedRef: 2.5,
  accelForce: 4000,
  topSpeed: 30,
  powerCurveExp: 2.0,
  brakeForce: 8000,
  reverseAccel: 2000,
  brakeReverseThreshold: 0.5,
  engineBrake: 800,
  maxSteerAngle: 0.55,
  steerSmooth: 8.0,
  // Speed-sensitive steering: the usable steer angle shrinks as speed rises so
  // the car isn't twitchy / spin-happy at the top end. At/above `steerSpeedRef`
  // (m/s) the angle is reduced by `steerSpeedReduce` (fraction).
  steerSpeedRef: 26,
  steerSpeedReduce: 0.55,
  frictionCoeff: 1.5,
  maxAngVel: 9.0,
  // Anti-roll / orientation. When grounded the chassis aligns its up-axis to the
  // averaged ground normal (so it leans into banks and follows loops instead of
  // fighting toward world-up); `stabilizerDamp` damps the roll/pitch rate.
  stabilizerStrength: 9000,
  stabilizerDamp: 2600,
  // Airborne control: gentle tumble damping + player torque (W/S pitch, A/D roll,
  // Q/E yaw spin). Yaw is damped far less (`airYawDamp`) than pitch/roll so a
  // flat spin actually carries once you start it.
  airAngularDamp: 1400,
  airControl: 5000,
  airYawControl: 4500,
  airYawDamp: 250,
};

/** Drivetrain. `layout` picks which axle(s) get engine torque; for AWD,
 *  `powerBias` is the rear power fraction (0 = all front … 1 = all rear, 0.5 =
 *  even). Braking always acts on all four wheels regardless of layout. Total
 *  drive force is preserved across layouts, so RWD just concentrates it on the
 *  rear (more power-oversteer) rather than halving acceleration. */
export const DRIVETRAIN = {
  layout: "AWD", // 'FWD' | 'RWD' | 'AWD'
  powerBias: 0.5,
};

/** Aerodynamics. `drag` bounds top speed and tames downhill runaway (quadratic,
 *  opposing velocity). `downforce` presses the car onto whatever surface it's on
 *  (along -chassis-up) and scales with speed² — light by default, but it adds
 *  load-sensitive grip in fast corners and margin through loops. */
export const AERO = {
  drag: 0.45,
  downforce: 3.0,
};

/** Chassis shell vs the deck BVH — stops the body clipping into elevated track
 *  (ramps, loops, hard landings). Bottom corners get pushed out along the deck
 *  normal once they sink within `skin` of the surface. */
export const DECK = {
  enabled: true,
  skin: 0.05,
  searchRadius: 0.8,
  stiffness: 220000,
  damper: 9000,
};

export const WHEEL = {
  radius: 0.36,
  thickness: 0.24,
  rimRadius: 0.22,
  rimWidth: 0.26,
};

/** Forward-facing headlights (cheap, no shadows). Two SpotLights parented to the
 *  chassis mesh so they follow position + orientation for free. Mount/aim offsets
 *  are chassis-local meters: +Z front, +Y up, +X right. */
export const HEADLIGHTS = {
  enabled: false,
  color: "#fff2d6",
  intensity: 1200, // candela-ish (decay 2) — tune against night exposure
  distance: 90,
  angle: 0.6, // cone half-angle (rad)
  penumbra: 0.5,
  decay: 2,
  lampEmissive: 3.0, // emissive lamp face brightness (>1 so it blooms)
  // mount on the chassis (local m)
  side: 0.6,
  height: 0.05,
  forward: 1.75,
  // aim point relative to the mount (local m)
  aimForward: 16,
  aimDrop: 3.2,
};

/** Rear taillights — emissive meshes only (no real lights, bloom-friendly). They
 *  glow dimly while the headlights are on (night) and flare bright under braking
 *  or handbrake. Mount offsets are chassis-local meters (rear face is -Z). */
export const TAILLIGHTS = {
  enabled: true,
  color: "#ff2020",
  runningIntensity: 0.6, // dim glow when headlights are on
  brakeIntensity: 4.0, // bright flare on brake / handbrake
  width: 0.35,
  height: 0.16,
  side: 0.62, // ±X
  up: 0.12, // +Y
  back: 1.78, // distance behind centre (placed at -Z)
};

export const WALL = {
  probeRange: 0.9,
  stiffness: 300000,
  damper: 14000,
  clampPenFrac: 0.4,
};

/** Chassis-vs-solids (guardrails, ramp walls) via the solids BVH. Samples the
 *  oriented chassis box (8 corners + 12 edge midpoints + 6 face centres) and
 *  pushes each point out of the nearest surface within `radius`. */
export const SOLID = {
  enabled: true,
  radius: 0.4, // search distance per box sample (m)
  stiffness: 260000,
  damper: 12000,
  clampPenFrac: 0.5,
};

/** Cached each rebuild — offset from box center to CoM in chassis-local space. */
const _COM_OFFSET = new THREE.Vector3();

function _syncComOffset() {
  _COM_OFFSET.set(CHASSIS.comX, CHASSIS.comY, CHASSIS.comZ);
}

/* ----------------------------------------------------------------------- */
/* Rigid body — 6-DOF, force/torque accumulators                            */
/* ----------------------------------------------------------------------- */

class RigidBody {
  constructor({ mass, size }) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.localInvInertia = new THREE.Matrix3();
    this._setInertia(mass, size);

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

  _setInertia(mass, { width: w, height: h, length: l, comX = 0, comY = 0, comZ = 0 }) {
    const Ixx = (mass / 12) * (h * h + l * l) + mass * (comY * comY + comZ * comZ);
    const Iyy = (mass / 12) * (w * w + l * l) + mass * (comX * comX + comZ * comZ);
    const Izz = (mass / 12) * (w * w + h * h) + mass * (comX * comX + comY * comY);
    this.localInvInertia.set(1 / Ixx, 0, 0, 0, 1 / Iyy, 0, 0, 0, 1 / Izz);
  }

  addForce(F) {
    this.forceAccum.add(F);
  }

  addForceAtPoint(F, worldPoint) {
    this.forceAccum.add(F);
    this._r.subVectors(worldPoint, this.pos);
    this._tau.crossVectors(this._r, F);
    this.torqueAccum.add(this._tau);
  }

  getVelocityAtPoint(worldPoint, out) {
    this._r.subVectors(worldPoint, this.pos);
    this._rotVel.crossVectors(this.angVel, this._r);
    return out.addVectors(this.vel, this._rotVel);
  }

  integrate(dt) {
    this.vel.x += this.forceAccum.x * this.invMass * dt;
    this.vel.y += this.forceAccum.y * this.invMass * dt;
    this.vel.z += this.forceAccum.z * this.invMass * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    this._mat.makeRotationFromQuaternion(this.quat);
    this._R3.setFromMatrix4(this._mat);
    this._R3t.copy(this._R3).transpose();
    this._worldInvI.copy(this._R3).multiply(this.localInvInertia).multiply(this._R3t);

    this._tau.copy(this.torqueAccum).applyMatrix3(this._worldInvI);
    this.angVel.x += this._tau.x * dt;
    this.angVel.y += this._tau.y * dt;
    this.angVel.z += this._tau.z * dt;

    const wx = this.angVel.x, wy = this.angVel.y, wz = this.angVel.z;
    const qx = this.quat.x, qy = this.quat.y, qz = this.quat.z, qw = this.quat.w;
    const dqx = 0.5 * (wx * qw + wy * qz - wz * qy);
    const dqy = 0.5 * (-wx * qz + wy * qw + wz * qx);
    const dqz = 0.5 * (wx * qy - wy * qx + wz * qw);
    const dqw = 0.5 * (-wx * qx - wy * qy - wz * qz);
    this.quat.set(qx + dqx * dt, qy + dqy * dt, qz + dqz * dt, qw + dqw * dt);
    this.quat.normalize();

    this.forceAccum.set(0, 0, 0);
    this.torqueAccum.set(0, 0, 0);
  }
}

/* ----------------------------------------------------------------------- */
/* Tire — raycast probe + suspension/steering/longitudinal forces           */
/* ----------------------------------------------------------------------- */

class Tire {
  constructor({ name, localPos, steer, drive }) {
    this.name = name;
    this.localPos = localPos.clone();
    this.canSteer = steer;
    this.canDrive = drive;
    this.isFront = localPos.z > 0;

    this.grounded = false;
    this.compression = 0;
    this.hitDistance = TIRE.rayLength;
    this.hitPoint = new THREE.Vector3();
    this.hitNormal = new THREE.Vector3(0, 1, 0);
    this.worldPos = new THREE.Vector3();
    this.lastSuspension = new THREE.Vector3();
    this.lastSteering = new THREE.Vector3();
    this.lastAccel = new THREE.Vector3();
    this._smoothDist = undefined;

    this._tireVel = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wheelFwd = new THREE.Vector3();
    this._wheelRight = new THREE.Vector3();
    this._steerQuat = new THREE.Quaternion();
    this._F = new THREE.Vector3();
    this._down = new THREE.Vector3();
    this._rayO = new THREE.Vector3();
    this._rayOff = new THREE.Vector3();
    this._bestP = new THREE.Vector3();
    this._bestN = new THREE.Vector3(0, 1, 0);
  }

  /** Cast rays + optional sphere sweep; keep the closest ground hit. */
  _probeGround(castGround, castSphereSweep, pad, far) {
    const fwdBias = TIRE.rayForwardBias * WHEEL.radius;
    const latBias = TIRE.rayLateralBias * WHEEL.thickness * 0.5;
    const ringN = Math.round(TIRE.rayRingCount);
    const ringR = WHEEL.radius * TIRE.rayRingScale;

    let bestDist = Infinity;
    let bestPoint = null;

    // `dist` lets a caller pass a distance already normalized back to the hub
    // (ring rays / sphere sweep start BELOW the hub, so their raw hit distance
    // under-reports the true hub-to-ground gap). Falls back to hit.distance.
    const consider = (hit, dist) => {
      if (!hit) return;
      const d = dist !== undefined ? dist : hit.distance;
      if (d >= bestDist) return;
      bestDist = d;
      if (hit.point?.isVector3) this._bestP.copy(hit.point);
      else if (hit.point) this._bestP.set(hit.point.x, hit.point.y, hit.point.z);
      bestPoint = this._bestP;
      if (hit.normal?.isVector3) this._bestN.copy(hit.normal);
      else if (hit.normal) this._bestN.set(hit.normal.x, hit.normal.y, hit.normal.z);
      else if (hit.face?.normal) this._bestN.copy(hit.face.normal);
      else this._bestN.set(0, 1, 0);
    };

    const sample = (dirVec, off) => {
      this._rayO.copy(this.worldPos).addScaledVector(this._up, pad);
      if (dirVec) this._rayO.addScaledVector(dirVec, off);
      consider(castGround(this._rayO, this._down, far));
    };

    if (ringN >= 3) {
      // Bottom semicircle: rear → underside → front (in the wheel fwd/down plane).
      for (let i = 0; i < ringN; i++) {
        const a = Math.PI * (i / (ringN - 1));
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        this._rayO.copy(this.worldPos).addScaledVector(this._up, pad);
        this._rayO.addScaledVector(this._wheelFwd, ca * ringR);
        this._rayO.addScaledVector(this._down, sa * ringR);
        // This ray starts sa*ringR below the hub plane; add it back so the
        // distance is measured from the hub, not the lowered ring origin.
        const hit = castGround(this._rayO, this._down, far);
        if (hit) consider(hit, hit.distance + sa * ringR);
      }
    } else {
      sample(null, 0);
      if (fwdBias > 1e-4) {
        sample(this._wheelFwd, fwdBias);
        sample(this._wheelFwd, -fwdBias);
      }
      if (latBias > 1e-4) {
        sample(this._wheelRight, latBias);
        sample(this._wheelRight, -latBias);
      }
    }

    if (TIRE.useSphereSweep && castSphereSweep) {
      this._rayO.copy(this.worldPos).addScaledVector(this._up, pad);
      const sr = WHEEL.radius * TIRE.sphereSweepScale;
      const sh = castSphereSweep(
        this._rayO.x,
        this._rayO.y,
        this._rayO.z,
        sr,
        this._down.x,
        this._down.y,
        this._down.z,
        far,
      );
      if (sh) {
        // The sphere (radius sr) contacts ground sr below its center, so the
        // true hub-to-ground gap is sh.distance + sr (sh.distance is how far
        // the center travelled from the hub-raised origin).
        consider({ distance: sh.distance, point: sh.point, normal: sh.normal }, sh.distance + sr);
      }
    }

    return bestDist === Infinity ? null : { dist: bestDist, point: bestPoint };
  }

  apply(body, dt, steerAngle, throttle, handbrake, castGround, castSphereSweep, driveScale = 1) {
    this.worldPos
      .copy(this.localPos)
      .sub(_COM_OFFSET)
      .applyQuaternion(body.quat)
      .add(body.pos);
    this._up.set(0, 1, 0).applyQuaternion(body.quat);
    this._fwd.set(0, 0, 1).applyQuaternion(body.quat);
    this._right.set(1, 0, 0).applyQuaternion(body.quat);

    this._wheelFwd.copy(this._fwd);
    this._wheelRight.copy(this._right);
    if (this.canSteer && steerAngle !== 0) {
      this._steerQuat.setFromAxisAngle(this._up, steerAngle);
      this._wheelFwd.applyQuaternion(this._steerQuat);
      this._wheelRight.applyQuaternion(this._steerQuat);
    }

    const pad = TIRE.rayPadAbove;
    const far = TIRE.rayLength + pad;
    this._down.copy(this._up).multiplyScalar(-1);

    const probe = this._probeGround(castGround, castSphereSweep, pad, far);

    this.lastSuspension.set(0, 0, 0);
    this.lastSteering.set(0, 0, 0);
    this.lastAccel.set(0, 0, 0);

    if (!probe) {
      this.grounded = false;
      this.compression = 0;
      this.hitDistance = TIRE.rayLength;
      return;
    }

    const bestDist = probe.dist;
    this.grounded = true;
    this.hitPoint.copy(probe.point);
    this.hitNormal.copy(this._bestN);
    if (this.hitNormal.dot(this._up) < 0) this.hitNormal.negate();
    if (this.hitNormal.lengthSq() < 1e-8) this.hitNormal.copy(this._up);
    this.hitNormal.normalize();
    const distFromHub = bestDist - pad;
    this.hitDistance = distFromHub;
    this.compression = TIRE.restLength - distFromHub;

    body.getVelocityAtPoint(this.worldPos, this._tireVel);

    // 1) Suspension (vertical) with quadratic bottom-out.
    const upVel = this._tireVel.dot(this._up);
    let springMag = this.compression * TIRE.springStrength;
    const ovr = this.compression - TIRE.restLength * TIRE.bottomOutThresh;
    if (ovr > 0) springMag += ovr * ovr * TIRE.springStrength * TIRE.bottomOutMult;
    const dampMag = upVel * TIRE.damper;
    const suspMag = Math.max(0, springMag - dampMag);
    this._F.copy(this._up).multiplyScalar(suspMag);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastSuspension.copy(this._F);

    // Friction circle radius — load-sensitive: `suspMag` is the dynamic normal
    // load, so weight transfer (outer wheels compress more) feeds straight into
    // available grip. Per-axle μ multiplier sets the handling balance.
    const axleGrip = this.canSteer
      ? TIRE.gripFront
      : handbrake
      ? TIRE.gripHandbrake
      : TIRE.gripRear;
    const Fmax = TIRE.frictionCoeff * axleGrip * suspMag;

    // 2) Lateral grip — slip-based brush model. Force rises linearly with the
    // lateral slip ratio (≈ tan slip angle) up to the friction limit, then the
    // tire SLIDES (force saturates) instead of perfectly cancelling velocity.
    const vLat = this._tireVel.dot(this._wheelRight);
    const vLong = this._tireVel.dot(this._wheelFwd);
    const vRef = Math.max(Math.abs(vLong), TIRE.lowSpeedRef);
    let latNorm = -(vLat / vRef) * TIRE.tireStiffness;
    if (latNorm > 1) latNorm = 1;
    else if (latNorm < -1) latNorm = -1;
    let Fy = latNorm * Fmax;

    // 3) Longitudinal. Braking acts on every wheel; engine torque (accel /
    // reverse / engine-brake) is scaled by this wheel's drivetrain share, so
    // FWD/RWD/AWD just changes *where* the drive force is applied.
    let Fx = 0;
    const carSpeed = body.vel.dot(this._fwd);
    const thr = TIRE.brakeReverseThreshold;
    if (throttle > 0) {
      if (carSpeed < -thr) {
        Fx = TIRE.brakeForce;
      } else {
        const normSpeed = Math.min(1, Math.abs(carSpeed) / TIRE.topSpeed);
        Fx = driveScale * TIRE.accelForce * Math.max(0, 1 - Math.pow(normSpeed, TIRE.powerCurveExp));
      }
    } else if (throttle < 0) {
      if (carSpeed > thr) {
        Fx = -TIRE.brakeForce;
      } else {
        const normSpeed = Math.min(1, Math.abs(carSpeed) / TIRE.topSpeed);
        Fx = -driveScale * TIRE.reverseAccel * Math.max(0, 1 - Math.pow(normSpeed, TIRE.powerCurveExp));
      }
    } else if (driveScale > 0) {
      const fwdVel = this._tireVel.dot(this._wheelFwd);
      Fx = -Math.sign(fwdVel) * Math.min(Math.abs(fwdVel) * 200, TIRE.engineBrake);
    }
    if (Fx > Fmax) Fx = Fmax;
    else if (Fx < -Fmax) Fx = -Fmax;

    // 4) Combined-slip friction circle — lateral and longitudinal share one
    // budget. Hard braking eats cornering grip (trail-braking / lockup feel);
    // power-on at a low-grip rear axle eats lateral grip (power oversteer).
    const demand = Math.hypot(Fx, Fy);
    if (demand > Fmax && demand > 1e-6) {
      const s = Fmax / demand;
      Fx *= s;
      Fy *= s;
    }

    this._F.copy(this._wheelRight).multiplyScalar(Fy);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastSteering.copy(this._F);

    this._F.copy(this._wheelFwd).multiplyScalar(Fx);
    body.addForceAtPoint(this._F, this.worldPos);
    this.lastAccel.copy(this._F);
  }
}

/* ----------------------------------------------------------------------- */
/* Vehicle — meshes + physics step + visual sync                            */
/* ----------------------------------------------------------------------- */

export class Vehicle {
  constructor({ scene, showArrows = false }) {
    this.scene = scene;
    this.collidables = [];
    this.walls = [];
    this.wallBoxes = [];
    this.groundBvh = null;
    this.solidsBvh = null;
    /** Reference height for the chassis-corner safety floor. modular-road's world
     *  floor is at y=0 (the default); v2 sets this to a terrain sampler so the
     *  floor follows the heightfield instead of pinning the car to world y=0.
     *  @type {((x:number,z:number)=>number) | null} */
    this.getFloorY = null;
    /** @type {import("./modularRoadParkour.js").ParkourMover[]} */
    this.dynamicMovers = [];
    this.enabled = false;
    this.spawnPos = new THREE.Vector3(0, 0.7, -4);
    this.spawnQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

    this.body = new RigidBody({ mass: CHASSIS.mass, size: CHASSIS });
    this.tires = WHEEL_LOCAL.map((w) => new Tire({ name: w.name, localPos: w.pos, steer: w.steer, drive: w.drive }));
    this.input = { steer: 0, throttle: 0, handbrake: false, yaw: 0 };

    this.group = new THREE.Group();
    this.group.name = "Vehicle";
    this.group.visible = false;
    scene.add(this.group);

    this._buildMeshes(showArrows);
    this._initScratch();

    this.raycaster = new THREE.Raycaster();
    this._bvhRay = new THREE.Ray();
    this._castGround = (origin, dir, far) => {
      if (this.groundBvh && this.groundBvh.baked) {
        return this.groundBvh.raycastFirst(origin, dir, far);
      }
      this.raycaster.ray.origin.copy(origin);
      this.raycaster.ray.direction.copy(dir);
      this.raycaster.far = far;
      const hits = this.raycaster.intersectObjects(this.collidables, false);
      return hits.length ? hits[0] : null;
    };
    this._castSphereSweep = (ox, oy, oz, radius, dx, dy, dz, maxDist) => {
      if (this.groundBvh && this.groundBvh.baked) {
        return this.groundBvh.spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist);
      }
      return null;
    };
    this.SUBSTEPS = 4;
    this.respawn();
  }

  _buildMeshes(showArrows) {
    this.chassisMesh = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.width, CHASSIS.height, CHASSIS.length),
      new THREE.MeshStandardMaterial({ color: 0x5b6cd6, roughness: 0.55, metalness: 0.3 }),
    );
    this.chassisMesh.castShadow = true;
    this.chassisMesh.receiveShadow = true;
    this.group.add(this.chassisMesh);
    this._buildHeadlights();
    this._buildTaillights();

    const tireGeo = new THREE.CylinderGeometry(WHEEL.radius, WHEEL.radius, WHEEL.thickness, 28);
    tireGeo.rotateZ(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
    const rimGeo = new THREE.CylinderGeometry(WHEEL.rimRadius, WHEEL.rimRadius, WHEEL.rimWidth, 18);
    rimGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xb0b8c0, roughness: 0.35, metalness: 0.85 });
    const spokeGeo = new THREE.CircleGeometry(WHEEL.rimRadius * 0.92, 6);
    const spokeMat = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide });

    this.tireGroups = this.tires.map(() => {
      const g = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      tire.castShadow = true;
      rim.castShadow = true;
      const spokeL = new THREE.Mesh(spokeGeo, spokeMat);
      const spokeR = new THREE.Mesh(spokeGeo, spokeMat);
      spokeL.position.x = -WHEEL.rimWidth / 2 - 0.001;
      spokeR.position.x = WHEEL.rimWidth / 2 + 0.001;
      spokeL.rotation.y = Math.PI / 2;
      spokeR.rotation.y = -Math.PI / 2;
      g.add(tire, rim, spokeL, spokeR);
      this.group.add(g);
      return g;
    });

    this.arrowGroup = new THREE.Group();
    this.arrowGroup.visible = showArrows;
    this.group.add(this.arrowGroup);
    this.arrows = this.tires.map(() => {
      const up = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.1, 0x60ff80, 0.18, 0.1);
      const side = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.1, 0x4090ff, 0.18, 0.1);
      const fwd = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.1, 0xff5060, 0.18, 0.1);
      this.arrowGroup.add(up, side, fwd);
      return { up, side, fwd };
    });
    this.wheelSpin = [0, 0, 0, 0];
  }

  _buildHeadlights() {
    this.headlights = [];
    this.headlightTargets = [];
    this.headlamps = []; // emissive lamp faces (bloom source)
    const H = HEADLIGHTS;
    this._lampGeo = this._lampGeo ?? new THREE.BoxGeometry(1, 1, 1);
    for (const s of [-1, 1]) {
      const light = new THREE.SpotLight(H.color, H.intensity, H.distance, H.angle, H.penumbra, H.decay);
      light.castShadow = false;
      light.position.set(s * H.side, H.height, H.forward);
      const target = new THREE.Object3D();
      target.position.set(s * H.side, H.height - H.aimDrop, H.forward + H.aimForward);
      this.chassisMesh.add(light);
      this.chassisMesh.add(target);
      light.target = target;
      light.visible = H.enabled;
      this.headlights.push(light);
      this.headlightTargets.push(target);

      const lamp = new THREE.Mesh(
        this._lampGeo,
        new THREE.MeshStandardMaterial({
          color: H.color,
          emissive: H.color,
          emissiveIntensity: H.lampEmissive,
          roughness: 0.4,
          metalness: 0,
        }),
      );
      lamp.castShadow = false;
      lamp.receiveShadow = false;
      lamp.position.set(s * H.side, H.height, H.forward + 0.02);
      lamp.scale.set(0.22, 0.12, 0.05);
      lamp.visible = H.enabled;
      this.chassisMesh.add(lamp);
      this.headlamps.push(lamp);
    }
  }

  setHeadlights(on) {
    HEADLIGHTS.enabled = !!on;
    this.applyHeadlightParams();
  }

  /** Re-sync the headlight rig after editing HEADLIGHTS params live. */
  applyHeadlightParams() {
    const H = HEADLIGHTS;
    for (let i = 0; i < this.headlights.length; i++) {
      const s = i === 0 ? -1 : 1;
      const l = this.headlights[i];
      l.color.set(H.color);
      l.intensity = H.intensity;
      l.distance = H.distance;
      l.angle = H.angle;
      l.penumbra = H.penumbra;
      l.decay = H.decay;
      l.visible = H.enabled;
      l.position.set(s * H.side, H.height, H.forward);
      this.headlightTargets[i].position.set(s * H.side, H.height - H.aimDrop, H.forward + H.aimForward);
    }
    for (let i = 0; i < this.headlamps.length; i++) {
      const s = i === 0 ? -1 : 1;
      const m = this.headlamps[i];
      m.material.color.set(H.color);
      m.material.emissive.set(H.color);
      m.material.emissiveIntensity = H.lampEmissive;
      m.position.set(s * H.side, H.height, H.forward + 0.02);
      m.visible = H.enabled;
    }
  }

  _buildTaillights() {
    this.taillights = [];
    const T = TAILLIGHTS;
    const geo = new THREE.BoxGeometry(1, 1, 1); // unit box, scaled per params
    for (const s of [-1, 1]) {
      const mat = new THREE.MeshStandardMaterial({
        color: T.color,
        emissive: T.color,
        emissiveIntensity: T.runningIntensity,
        roughness: 0.4,
        metalness: 0,
      });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = false;
      m.receiveShadow = false;
      m.position.set(s * T.side, T.up, -T.back);
      m.scale.set(T.width, T.height, 0.06);
      m.visible = false;
      this.chassisMesh.add(m);
      this.taillights.push(m);
    }
  }

  /** Re-sync taillight color / size / mount after editing TAILLIGHTS params. */
  applyTaillightParams() {
    const T = TAILLIGHTS;
    for (let i = 0; i < this.taillights.length; i++) {
      const s = i === 0 ? -1 : 1;
      const m = this.taillights[i];
      m.material.color.set(T.color);
      m.material.emissive.set(T.color);
      m.position.set(s * T.side, T.up, -T.back);
      m.scale.set(T.width, T.height, 0.06);
    }
  }

  /** Per-frame: dim running glow when headlights are on, bright on brake. */
  _updateTaillights() {
    if (!this.taillights.length) return;
    const T = TAILLIGHTS;
    this._tlFwd.set(0, 0, 1).applyQuaternion(this.body.quat);
    const vFwd = this.body.vel.dot(this._tlFwd);
    const braking = this.input.handbrake || (this.input.throttle < 0 && vFwd > 0.5);
    let intensity = 0;
    if (braking) intensity = T.brakeIntensity;
    else if (HEADLIGHTS.enabled) intensity = T.runningIntensity;
    const on = T.enabled && intensity > 0;
    for (const m of this.taillights) {
      m.visible = on;
      m.material.emissiveIntensity = intensity;
    }
  }

  _initScratch() {
    this._tlFwd = new THREE.Vector3();
    this._gravityF = new THREE.Vector3();
    this._hw = CHASSIS.width / 2;
    this._hh = CHASSIS.height / 2;
    this._hl = CHASSIS.length / 2;
    this.CHASSIS_CORNERS = [];
    this.PROBE_LOCALS = [
      { pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1) },
      { pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, -1) },
      { pos: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0) },
      { pos: new THREE.Vector3(), dir: new THREE.Vector3(-1, 0, 0) },
    ];
    for (let i = 0; i < 8; i++) this.CHASSIS_CORNERS.push(new THREE.Vector3());
    /** Oriented box samples for solids BVH — corners + edge mids + face centres. */
    this.SOLID_BOX_SAMPLES = [];
    for (let i = 0; i < 26; i++) this.SOLID_BOX_SAMPLES.push(new THREE.Vector3());
    this._sphC = new THREE.Vector3();
    this._sphN = new THREE.Vector3();
    this._sphV = new THREE.Vector3();
    this._sphF = new THREE.Vector3();
    this._refreshLocalFrames();

    this.CORNER_SPRING = 180000;
    this.CORNER_DAMPER = 6000;
    this.CORNER_FRICTION = 0.6;

    this._cWorld = new THREE.Vector3();
    this._cVel = new THREE.Vector3();
    this._cF = new THREE.Vector3();
    this._cVelHoriz = new THREE.Vector3();
    this._stabUp = new THREE.Vector3();
    this._stabTorque = new THREE.Vector3();
    this._stabN = new THREE.Vector3();
    this._stabCross = new THREE.Vector3();
    this._stabWTilt = new THREE.Vector3();
    this._airRight = new THREE.Vector3();
    this._airFwd = new THREE.Vector3();
    this._deckN = new THREE.Vector3();
    this.BOTTOM_CORNERS = [0, 1, 4, 5];
    this._aeroF = new THREE.Vector3();
    this._aeroUp = new THREE.Vector3();
    this._surfV = new THREE.Vector3();
    this._probeOrigin = new THREE.Vector3();
    this._probeDirW = new THREE.Vector3();
    this._probeVel = new THREE.Vector3();
    this._probeF = new THREE.Vector3();
    this._depenDir = new THREE.Vector3();

    this._wheelUp = new THREE.Vector3();
    this._wheelOffset = new THREE.Vector3();
    this._steerLocalQ = new THREE.Quaternion();
    this._spinLocalQ = new THREE.Quaternion();
    this._wheelFwdWorld = new THREE.Vector3();
    this._wheelTireVel = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._xAxis = new THREE.Vector3(1, 0, 0);
    this._zAxis = new THREE.Vector3(0, 0, 1);
    this._arrowDir = new THREE.Vector3();
    this._geomCenter = new THREE.Vector3();
    _syncComOffset();
  }

  /** Map a chassis-box-local point to world space (body.pos = CoM). */
  _geomToWorld(geomLocal, out) {
    const body = this.body;
    return out.copy(geomLocal).sub(_COM_OFFSET).applyQuaternion(body.quat).add(body.pos);
  }

  _refreshLocalFrames() {
    const hw = (this._hw = CHASSIS.width / 2);
    const hh = (this._hh = CHASSIS.height / 2);
    const hl = (this._hl = CHASSIS.length / 2);
    const c = this.CHASSIS_CORNERS;
    c[0].set(-hw, -hh, -hl); c[1].set(hw, -hh, -hl);
    c[2].set(-hw, hh, -hl); c[3].set(hw, hh, -hl);
    c[4].set(-hw, -hh, hl); c[5].set(hw, -hh, hl);
    c[6].set(-hw, hh, hl); c[7].set(hw, hh, hl);
    this.PROBE_LOCALS[0].pos.set(0, 0, hl);
    this.PROBE_LOCALS[1].pos.set(0, 0, -hl);
    this.PROBE_LOCALS[2].pos.set(hw, 0, 0);
    this.PROBE_LOCALS[3].pos.set(-hw, 0, 0);
    // Oriented chassis box — 8 corners, 12 edge midpoints, 6 face centres.
    const sb = this.SOLID_BOX_SAMPLES;
    for (let i = 0; i < 8; i++) sb[i].copy(c[i]);
    const edgePairs = [
      [0, 1], [2, 3], [4, 5], [6, 7],
      [0, 2], [1, 3], [4, 6], [5, 7],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (let i = 0; i < 12; i++) {
      sb[8 + i].copy(c[edgePairs[i][0]]).add(c[edgePairs[i][1]]).multiplyScalar(0.5);
    }
    sb[20].set(0, 0, hl); // front
    sb[21].set(0, 0, -hl); // rear
    sb[22].set(-hw, 0, 0); // left
    sb[23].set(hw, 0, 0); // right
    sb[24].set(0, hh, 0); // top
    sb[25].set(0, -hh, 0); // bottom
  }

  /** Re-derive inertia + local frames + visual box after mass/size/CoM edits. */
  rebuildBody() {
    _syncComOffset();
    this.body.mass = CHASSIS.mass;
    this.body.invMass = 1 / CHASSIS.mass;
    this.body._setInertia(CHASSIS.mass, CHASSIS);
    this._refreshLocalFrames();
    this.chassisMesh.geometry.dispose();
    this.chassisMesh.geometry = new THREE.BoxGeometry(CHASSIS.width, CHASSIS.height, CHASSIS.length);
  }

  setColliders(collidables, walls = []) {
    this.collidables = collidables.slice();
    for (const c of this.collidables) c.updateMatrixWorld(true);
    this.walls = walls.slice();
    for (const w of this.walls) w.updateMatrixWorld(true);
    this.wallBoxes = this.walls.map((w) => new THREE.Box3().setFromObject(w));
  }

  /** Attach baked BVHs. `ground` drives wheel probes; `solids` blocks the chassis. */
  setBvh(ground, solids) {
    this.groundBvh = ground || null;
    this.solidsBvh = solids || null;
  }

  /** Moving parkour solids — each mover rebakes its own BVH and pushes via surface velocity. */
  setDynamicMovers(movers) {
    this.dynamicMovers = movers ? movers.slice() : [];
  }

  setSpawn(pos, quat) {
    this.spawnPos.copy(pos);
    if (quat) this.spawnQuat.copy(quat);
  }

  respawn() {
    this.body.pos.copy(this.spawnPos);
    this.body.vel.set(0, 0, 0);
    this.body.quat.copy(this.spawnQuat);
    this.body.angVel.set(0, 0, 0);
  }

  /** Recover in place: keep position + heading, zero the roll/pitch and spin,
   *  drop vertical speed, and lift slightly so the wheels clear the surface. */
  flipUpright() {
    const q = this.body.quat;
    const yaw = Math.atan2(2 * (q.w * q.y + q.z * q.x), 1 - 2 * (q.y * q.y + q.x * q.x));
    this.body.quat.setFromAxisAngle(this._yAxis, yaw);
    this.body.angVel.set(0, 0, 0);
    this.body.vel.y = 0;
    this.body.pos.y += 0.6;
  }

  /**
   * Teleport chassis — optional speed preservation along new forward.
   * @param {THREE.Vector3} worldPos
   * @param {THREE.Quaternion} worldQuat
   * @param {{ preserveSpeed?: boolean, dampVertical?: boolean }} [opts]
   */
  teleportTo(worldPos, worldQuat, opts = {}) {
    const body = this.body;
    let speed = 0;
    if (opts.preserveSpeed) {
      this._wheelFwdWorld.set(body.vel.x, 0, body.vel.z);
      speed = this._wheelFwdWorld.length();
    }
    body.pos.copy(worldPos);
    body.quat.copy(worldQuat);
    body.angVel.set(0, 0, 0);
    if (opts.preserveSpeed && speed > 0.05) {
      this._wheelFwdWorld.set(0, 0, 1).applyQuaternion(worldQuat);
      this._wheelFwdWorld.y = 0;
      if (this._wheelFwdWorld.lengthSq() > 1e-8) {
        this._wheelFwdWorld.normalize().multiplyScalar(speed);
        body.vel.copy(this._wheelFwdWorld);
      }
    }
    if (opts.dampVertical) body.vel.y *= 0.25;
  }

  setEnabled(on) {
    this.enabled = on;
    this.group.visible = on;
    if (on) this.respawn();
  }

  setArrowsVisible(v) {
    this.arrowGroup.visible = v;
  }

  /** @param {{steerTarget:number, throttle:number, handbrake:boolean}} controls */
  update(dt, controls) {
    if (!this.enabled) return;
    const k = 1 - Math.exp(-TIRE.steerSmooth * dt);
    this.input.steer += ((controls.steerTarget ?? 0) - this.input.steer) * k;
    this.input.throttle = controls.throttle ?? 0;
    this.input.handbrake = !!controls.handbrake;
    this.input.yaw = controls.yaw ?? 0;

    this._physicsStep(dt);
    this._depenetrateFromWalls();
    this._syncVisuals(dt);
  }

  /** Steer angle after speed-sensitive reduction (shared by physics + visuals). */
  _steerAngle() {
    const speed = this.body.vel.length();
    let t = speed / Math.max(0.1, TIRE.steerSpeedRef);
    if (t > 1) t = 1;
    const factor = 1 - TIRE.steerSpeedReduce * t;
    return this.input.steer * TIRE.maxSteerAngle * factor;
  }

  /** Rear power fraction from the drivetrain layout (FWD=0, RWD=1, AWD=bias). */
  _driveBias() {
    if (DRIVETRAIN.layout === "FWD") return 0;
    if (DRIVETRAIN.layout === "RWD") return 1;
    return Math.min(1, Math.max(0, DRIVETRAIN.powerBias));
  }

  _physicsStep(dt) {
    const subDt = dt / this.SUBSTEPS;
    const steerAngle = this._steerAngle();
    const body = this.body;
    // Per-axle drive scale: total drive is preserved (front+rear share = 2 wheels
    // × 2 axles' worth), so each axle's two wheels carry their power fraction.
    const bias = this._driveBias();
    const fScale = 2 * (1 - bias);
    const rScale = 2 * bias;
    for (let s = 0; s < this.SUBSTEPS; s++) {
      this._gravityF.set(0, -GRAVITY * body.mass, 0);
      body.addForce(this._gravityF);
      this._applyAero();
      for (const tire of this.tires) {
        const driveScale = tire.isFront ? fScale : rScale;
        tire.apply(
          body,
          subDt,
          steerAngle,
          this.input.throttle,
          this.input.handbrake,
          this._castGround,
          this._castSphereSweep,
          driveScale,
        );
      }
      if (this.walls.length) this._applyWallProbes();
      if (SOLID.enabled && this.solidsBvh && this.solidsBvh.baked) this._resolveSolids();
      if (DECK.enabled && this.groundBvh && this.groundBvh.baked) this._applyDeckContact();
      this._applyChassisGroundContact();
      this._applyStabilizer();
      body.integrate(subDt);
      const wMax = TIRE.maxAngVel;
      if (body.angVel.lengthSq() > wMax * wMax) body.angVel.setLength(wMax);
    }
  }

  _applyStabilizer() {
    const body = this.body;
    let grounded = 0;
    this._stabN.set(0, 0, 0);
    for (const t of this.tires) {
      if (t.grounded) {
        grounded++;
        this._stabN.add(t.hitNormal);
      }
    }
    this._stabUp.set(0, 1, 0).applyQuaternion(body.quat);

    if (grounded > 0) {
      if (TIRE.stabilizerStrength <= 0 || this._stabN.lengthSq() < 1e-8) return;
      // Align chassis-up to the averaged ground normal (banks/loops follow the
      // surface), with damping on the roll/pitch rate but not on yaw (steering).
      this._stabN.normalize();
      this._stabCross.crossVectors(this._stabUp, this._stabN);
      this._stabTorque.copy(this._stabCross).multiplyScalar(TIRE.stabilizerStrength);
      const wYaw = body.angVel.dot(this._stabUp);
      this._stabWTilt.copy(body.angVel).addScaledVector(this._stabUp, -wYaw);
      this._stabTorque.addScaledVector(this._stabWTilt, -TIRE.stabilizerDamp);
      body.torqueAccum.add(this._stabTorque);
    } else {
      // Airborne: damp pitch/roll firmly but yaw lightly (so a flat spin carries),
      // plus player air control — W/S pitch, A/D roll, Q/E yaw spin.
      const wYaw = body.angVel.dot(this._stabUp);
      this._stabWTilt.copy(body.angVel).addScaledVector(this._stabUp, -wYaw);
      this._stabTorque.copy(this._stabWTilt).multiplyScalar(-TIRE.airAngularDamp);
      this._stabTorque.addScaledVector(this._stabUp, -wYaw * TIRE.airYawDamp);
      if (TIRE.airControl > 0) {
        this._airRight.set(1, 0, 0).applyQuaternion(body.quat);
        this._airFwd.set(0, 0, 1).applyQuaternion(body.quat);
        this._stabTorque.addScaledVector(this._airRight, -this.input.throttle * TIRE.airControl);
        this._stabTorque.addScaledVector(this._airFwd, this.input.steer * TIRE.airControl);
      }
      this._stabTorque.addScaledVector(this._stabUp, this.input.yaw * TIRE.airYawControl);
      body.torqueAccum.add(this._stabTorque);
    }
  }

  _applyChassisGroundContact() {
    const body = this.body;
    for (const corner of this.CHASSIS_CORNERS) {
      this._geomToWorld(corner, this._cWorld);
      const floorY = this.getFloorY ? this.getFloorY(this._cWorld.x, this._cWorld.z) : 0;
      if (this._cWorld.y >= floorY) continue;
      const pen = floorY - this._cWorld.y;
      body.getVelocityAtPoint(this._cWorld, this._cVel);
      const dampMag = Math.max(0, -this._cVel.y) * this.CORNER_DAMPER;
      const upMag = pen * this.CORNER_SPRING + dampMag;
      this._cF.set(0, upMag, 0);
      body.addForceAtPoint(this._cF, this._cWorld);
      this._cVelHoriz.set(this._cVel.x, 0, this._cVel.z);
      const horizSpeed = this._cVelHoriz.length();
      if (horizSpeed > 0.01) {
        this._cVelHoriz.multiplyScalar(1 / horizSpeed);
        const fricMag = -this.CORNER_FRICTION * upMag;
        this._cF.set(this._cVelHoriz.x * fricMag, 0, this._cVelHoriz.z * fricMag);
        body.addForceAtPoint(this._cF, this._cWorld);
      }
    }
  }

  _applyWallProbes() {
    const body = this.body;
    for (const p of this.PROBE_LOCALS) {
      this._geomToWorld(p.pos, this._probeOrigin);
      this._probeDirW.copy(p.dir).applyQuaternion(body.quat);
      this.raycaster.ray.origin.copy(this._probeOrigin);
      this.raycaster.ray.direction.copy(this._probeDirW);
      this.raycaster.far = WALL.probeRange;
      const hits = this.raycaster.intersectObjects(this.walls, false);
      if (hits.length === 0) continue;
      const hit = hits[0];
      const pen = WALL.probeRange - hit.distance;
      if (pen <= 0) continue;
      body.getVelocityAtPoint(hit.point, this._probeVel);
      const inwardVel = this._probeVel.dot(this._probeDirW);
      const dampMag = Math.max(0, inwardVel) * WALL.damper;
      const forceMag = pen * WALL.stiffness + dampMag;
      this._probeF.copy(this._probeDirW).multiplyScalar(-forceMag);
      body.addForceAtPoint(this._probeF, hit.point);
      if (pen > WALL.probeRange * WALL.clampPenFrac) {
        const vInto = body.vel.dot(this._probeDirW);
        if (vInto > 0) body.vel.addScaledVector(this._probeDirW, -vInto);
      }
    }
  }

  _applyAero() {
    const v = this.body.vel;
    const sp = v.length();
    if (sp < 1e-3) return;
    if (AERO.drag > 0) {
      this._aeroF.copy(v).multiplyScalar(-AERO.drag * sp); // -drag·sp·v  (∝ sp²)
      this.body.addForce(this._aeroF);
    }
    if (AERO.downforce > 0) {
      this._aeroUp.set(0, 1, 0).applyQuaternion(this.body.quat);
      this._aeroF.copy(this._aeroUp).multiplyScalar(-AERO.downforce * sp * sp);
      this.body.addForce(this._aeroF); // along -chassis-up → presses onto track
    }
  }

  _applyDeckContact() {
    const body = this.body;
    const skin = DECK.skin;
    for (const ci of this.BOTTOM_CORNERS) {
      this._geomToWorld(this.CHASSIS_CORNERS[ci], this._cWorld);
      const res = this.groundBvh.closestPointWithNormal(
        this._cWorld.x, this._cWorld.y, this._cWorld.z, DECK.searchRadius, this._deckN,
      );
      if (!res) continue;
      // Signed distance from surface to corner along the (outward) normal.
      const sd =
        (this._cWorld.x - res.x) * this._deckN.x +
        (this._cWorld.y - res.y) * this._deckN.y +
        (this._cWorld.z - res.z) * this._deckN.z;
      if (sd >= skin) continue; // corner safely above the deck → wheels handle it
      const pen = skin - sd;
      body.getVelocityAtPoint(this._cWorld, this._cVel);
      const inward = -this._cVel.dot(this._deckN);
      const dampMag = Math.max(0, inward) * DECK.damper;
      const forceMag = pen * DECK.stiffness + dampMag;
      this._cF.copy(this._deckN).multiplyScalar(forceMag);
      body.addForceAtPoint(this._cF, this._cWorld);
    }
  }

  _resolveSolids() {
    if (SOLID.enabled && this.solidsBvh?.baked) this._resolveSolidBvh(this.solidsBvh, null);
    for (const mover of this.dynamicMovers) {
      if (mover.bvh?.baked) this._resolveSolidBvh(mover.bvh, (p, out) => mover.velocityAt(p, out));
    }
  }

  _resolveSolidBvh(bvh, surfaceVelFn) {
    const body = this.body;
    const r = SOLID.radius;
    for (const sp of this.SOLID_BOX_SAMPLES) {
      this._geomToWorld(sp, this._sphC);
      const res = bvh.closestPointWithNormal(
        this._sphC.x, this._sphC.y, this._sphC.z, r, this._sphN,
      );
      if (!res) continue;
      const pen = r - res.distance;
      if (pen <= 0) continue;
      body.getVelocityAtPoint(this._sphC, this._sphV);
      if (surfaceVelFn) {
        surfaceVelFn(this._sphC, this._surfV);
        this._sphV.sub(this._surfV);
      }
      const inward = -this._sphV.dot(this._sphN);
      const dampMag = Math.max(0, inward) * SOLID.damper;
      const forceMag = pen * SOLID.stiffness + dampMag;
      this._sphF.copy(this._sphN).multiplyScalar(forceMag);
      body.addForceAtPoint(this._sphF, this._sphC);
      if (surfaceVelFn && pen > 0.02) {
        surfaceVelFn(this._sphC, this._surfV);
        body.vel.addScaledVector(this._surfV, Math.min(0.4, pen * 1.8));
      }
      if (pen > r * SOLID.clampPenFrac) {
        const vInto = body.vel.dot(this._sphN);
        if (vInto < 0) body.vel.addScaledVector(this._sphN, -vInto);
        if (surfaceVelFn) {
          surfaceVelFn(this._sphC, this._surfV);
          body.vel.addScaledVector(this._surfV, 0.12);
        }
      }
    }
  }

  _depenetrateFromWalls() {
    const c = this.body.pos;
    for (const box of this.wallBoxes) {
      if (c.x < box.min.x || c.x > box.max.x) continue;
      if (c.y < box.min.y || c.y > box.max.y) continue;
      if (c.z < box.min.z || c.z > box.max.z) continue;
      const dxMin = c.x - box.min.x, dxMax = box.max.x - c.x;
      const dzMin = c.z - box.min.z, dzMax = box.max.z - c.z;
      let minD = dxMin;
      this._depenDir.set(-1, 0, 0);
      if (dxMax < minD) { minD = dxMax; this._depenDir.set(1, 0, 0); }
      if (dzMin < minD) { minD = dzMin; this._depenDir.set(0, 0, -1); }
      if (dzMax < minD) { minD = dzMax; this._depenDir.set(0, 0, 1); }
      c.addScaledVector(this._depenDir, minD + 0.05);
      const vDot = this.body.vel.dot(this._depenDir);
      if (vDot < 0) this.body.vel.addScaledVector(this._depenDir, -vDot);
    }
  }

  _syncVisuals(dt) {
    const body = this.body;
    this._updateTaillights();
    this._geomCenter.copy(_COM_OFFSET).applyQuaternion(body.quat).add(body.pos);
    this.chassisMesh.position.copy(this._geomCenter);
    if (CHASSIS.visualLift !== 0) {
      this._wheelUp.set(0, 1, 0).applyQuaternion(body.quat);
      this.chassisMesh.position.addScaledVector(this._wheelUp, CHASSIS.visualLift);
    }
    this.chassisMesh.quaternion.copy(body.quat);

    const steerAngle = this._steerAngle();
    for (let i = 0; i < this.tires.length; i++) {
      const t = this.tires[i];
      const cfg = WHEEL_LOCAL[i];
      this._wheelUp.copy(this._yAxis).applyQuaternion(body.quat);
      const targetDist = t.grounded ? t.hitDistance : TIRE.rayLength;
      if (t._smoothDist === undefined) t._smoothDist = targetDist;
      const k = 1 - Math.exp(-TIRE.suspVisSmooth * dt);
      t._smoothDist += (targetDist - t._smoothDist) * k;
      const suspExt = Math.max(0, t._smoothDist - WHEEL.radius);
      this._wheelOffset.copy(this._wheelUp).multiplyScalar(-suspExt);
      this.tireGroups[i].position.copy(t.worldPos).add(this._wheelOffset);

      this._wheelFwdWorld.copy(this._zAxis).applyQuaternion(body.quat);
      if (cfg.steer && steerAngle !== 0) {
        this._steerLocalQ.setFromAxisAngle(this._wheelUp, steerAngle);
        this._wheelFwdWorld.applyQuaternion(this._steerLocalQ);
      }
      body.getVelocityAtPoint(t.worldPos, this._wheelTireVel);
      const omega = this._wheelTireVel.dot(this._wheelFwdWorld) / WHEEL.radius;
      this.wheelSpin[i] += omega * dt;
      if (this.wheelSpin[i] > Math.PI * 2) this.wheelSpin[i] -= Math.PI * 2;
      else if (this.wheelSpin[i] < -Math.PI * 2) this.wheelSpin[i] += Math.PI * 2;

      this._spinLocalQ.setFromAxisAngle(this._xAxis, this.wheelSpin[i]);
      if (cfg.steer) {
        this._steerLocalQ.setFromAxisAngle(this._yAxis, steerAngle);
        this.tireGroups[i].quaternion.multiplyQuaternions(body.quat, this._steerLocalQ).multiply(this._spinLocalQ);
      } else {
        this.tireGroups[i].quaternion.multiplyQuaternions(body.quat, this._spinLocalQ);
      }

      if (this.arrowGroup.visible) {
        const a = this.arrows[i];
        this._placeArrow(a.up, t.worldPos, t.lastSuspension);
        this._placeArrow(a.side, t.worldPos, t.lastSteering);
        this._placeArrow(a.fwd, t.worldPos, t.lastAccel);
      }
    }
  }

  _placeArrow(arrow, origin, force) {
    const mag = force.length();
    if (mag < 1e-3) {
      arrow.setLength(0.001, 0.001, 0.001);
      return;
    }
    this._arrowDir.copy(force).normalize();
    arrow.position.copy(origin);
    arrow.setDirection(this._arrowDir);
    const visLen = Math.min(3.5, mag * 0.0008);
    arrow.setLength(visLen, Math.min(0.25, visLen * 0.18), Math.min(0.16, visLen * 0.12));
  }

  /** Signed km/h forward speed for a HUD. */
  get speedKmh() {
    return this.body.vel.length() * 3.6;
  }

  get groundedCount() {
    return this.tires.reduce((n, t) => n + (t.grounded ? 1 : 0), 0);
  }
}
