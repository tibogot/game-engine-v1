/** Default Bruno / jeep: compound hull (3 spheres) + suspension + probes — all GUI-tunable. */
export const DEFAULT_JEEP_TUNING = {
  hullSpheres: [
    { fwd: 1.38, right: 0, y: 0.44, r: 0.4, label: "front" },
    { fwd: 0.12, right: 0, y: 0.58, r: 0.48, label: "cabin" },
    { fwd: -1.22, right: 0, y: 0.46, r: 0.42, label: "rear" },
  ],
  /** Extra cast length beyond step (world-ish; scaled by scaleFactor). */
  sweepFwdMargin: 0.32,
  /** AABB-style horizontal probes for depenetration (half-length / half-width, scaled). */
  probeHalfLength: 1.02,
  probeHalfWidth: 0.48,
  /** Y offsets above `carY + rideHeight * sf` for low / high probe rows. */
  probeYLow: 0.14,
  probeYHigh: 0.7,
  collisionSkin: 0.08,
  probeSearchRadius: 0.52,
  probePenetrationSlack: 0.28,
  stepOverHeight: 1.0,
  maxSlopeCos: 0.5,
  rideHeight: 0.48,
  suspStiffness: 80,
  suspDampCompress: 8,
  suspDampRelax: 2.5,
  suspMaxTravel: 0.6,
  mass: 1,
  gravity: 28,
  airPitchSmooth: 4,
  jumpImpulse: 9,
  /**
   * Downward BVH ray for wheels starts at hubY + this·sf (not from Y=∞).
   * Avoids tunnel ceilings being picked as “ground”.
   */
  wheelBvhRayPadAboveHub: 1.15,
  /**
   * Reject BVH wheel hits above hubY + this·sf (ceiling / bridge underside safety).
   * Keep large enough for steep ramp approach.
   */
  wheelBvHMaxAboveHub: 3.25,
  wheelBase: 1.9,
  track: 1.1,
};

function _cloneJeepTuning() {
  const j = { ...DEFAULT_JEEP_TUNING };
  j.hullSpheres = DEFAULT_JEEP_TUNING.hullSpheres.map((h) => ({ ...h }));
  return j;
}

/**
 * Horizontal collision for Lotus: lower / tighter than jeep hull (same BVH API).
 * Tuned for normalized footprint + CAR_MODEL_SCALE–sized root.
 */
export const DEFAULT_LOTUS_COLLISION_HULL = {
  hullSpheres: [
    { fwd: 1.42, right: 0, y: 0.26, r: 0.3, label: "front" },
    { fwd: 0.05, right: 0, y: 0.34, r: 0.34, label: "cabin" },
    { fwd: -1.28, right: 0, y: 0.28, r: 0.3, label: "rear" },
  ],
  sweepFwdMargin: 0.26,
  probeHalfLength: 0.86,
  probeHalfWidth: 0.38,
  probeYLow: 0.06,
  probeYHigh: 0.48,
  collisionSkin: 0.08,
  probeSearchRadius: 0.42,
  probePenetrationSlack: 0.24,
  stepOverHeight: 0.75,
  /** Probe / sweep vertical reference vs `carY` (player root), match Lotus ride. */
  rideHeight: 0.35,
};

function _cloneLotusHull() {
  const h = { ...DEFAULT_LOTUS_COLLISION_HULL };
  h.hullSpheres = DEFAULT_LOTUS_COLLISION_HULL.hullSpheres.map((s) => ({ ...s }));
  return h;
}

/** Lotus: same spring-damper fields as jeep tuning; values can diverge per vehicle. */
export const DEFAULT_LOTUS_CHASSIS = {
  rideHeight: 0.35,
  suspStiffness: 92,
  suspDampCompress: 8.5,
  suspDampRelax: 2.6,
  suspMaxTravel: 0.52,
  mass: 1,
  gravity: 28,
  airPitchSmooth: 5,
  jumpImpulse: 9,
  wheelBvhRayPadAboveHub: 1.05,
  wheelBvHMaxAboveHub: 3.2,
  wheelBase: 1.9,
  track: 1.1,
  maxSlopeCos: 0.5,
};

function _cloneLotusChassis() {
  return { ...DEFAULT_LOTUS_CHASSIS };
}

export class CarPhysics {
  constructor() {
    this.jeep = _cloneJeepTuning();
    this.lotusHull = _cloneLotusHull();
    this.lotusChassis = _cloneLotusChassis();
    /** @type {"jeep" | "lotus" | null} */
    this._suspChassisKind = null;
    this.inAir = false;
    this.velY = 0;
    this.onSteepSlope = false;
    this.airPitch = 0;
    this.wheelContactYs = [0, 0, 0, 0];
    this.wheelGrounded = [true, true, true, true];
    const eq = this._suspEqComp(this.jeep);
    this.wheelSuspLengths = [eq, eq, eq, eq];
    this._prevGroundYs = [0, 0, 0, 0];
    this._initialized = false;

    /** Filled each frame by `updateSuspension` for HUD / lil-gui. */
    this.telemetry = {
      totalSpringForce: 0,
      netVerticalForce: 0,
      weight: 0,
      wheelForce: [0, 0, 0, 0],
      groundedCount: 0,
      compression: [0, 0, 0, 0],
    };
  }

  _suspEqComp(j = this.jeep) {
    return (j.mass * j.gravity) / (4 * j.suspStiffness);
  }

  /**
   * BVH height under a wheel: ray from just above hub downward (not from infinity).
   * @returns {number|null}
   */
  _sampleBvhWheelY(cliffBvh, wx, wz, hubY, scaleFactor, surf = null) {
    if (!cliffBvh?.baked) return null;
    const s = surf || this.jeep;
    const sf = scaleFactor;
    const rayOy = hubY + s.wheelBvhRayPadAboveHub * sf + 1e-4;
    const bvhH = cliffBvh.raycastHeightFrom(wx, rayOy, wz);
    if (bvhH == null) return null;
    const maxY = hubY + s.wheelBvHMaxAboveHub * sf;
    if (bvhH > maxY) return null;
    return bvhH;
  }

  /**
   * @param {object | null} surfaceTuning ground-ray tuning (`rideHeight`, `wheelBvhRayPadAboveHub`, `wheelBvHMaxAboveHub`). Defaults to jeep when null — pass `lotusPhysics.params` for Lotus wheels.
   */
  getWheelGroundHeight(
    wx,
    wz,
    carY,
    getTerrainHeight,
    cliffBvh,
    scaleFactor = 1,
    surfaceTuning = null,
  ) {
    const s = surfaceTuning || this.jeep;
    const hubY = carY + s.rideHeight * scaleFactor;
    let h = getTerrainHeight(wx, wz);
    if (cliffBvh?.baked) {
      const bvhH = this._sampleBvhWheelY(
        cliffBvh,
        wx,
        wz,
        hubY,
        scaleFactor,
        s,
      );
      if (bvhH != null && bvhH > h) {
        h = bvhH;
      }
    }
    return h;
  }

  getGroundHeight(
    px,
    pz,
    carY,
    getTerrainHeight,
    cliffBvh,
    scaleFactor = 1,
    surfaceTuning = null,
  ) {
    const terrainY = getTerrainHeight(px, pz);
    let groundY = terrainY;
    if (cliffBvh?.baked) {
      const s = surfaceTuning || this.jeep;
      const hubY = carY + s.rideHeight * scaleFactor;
      const bvhY = this._sampleBvhWheelY(
        cliffBvh,
        px,
        pz,
        hubY,
        scaleFactor,
        s,
      );
      if (bvhY != null && bvhY > terrainY) {
        groundY = bvhY;
      }
    }
    return groundY;
  }

  /**
   * @param {object | null} hullTuning hull + probes; use `lotusHull` for Lotus, else null = jeep.
   */
  resolveMovement(
    px,
    pz,
    stepX,
    stepZ,
    carY,
    heading,
    vx,
    vz,
    cliffBvh,
    scaleFactor = 1,
    hullTuning = null,
  ) {
    if (!cliffBvh?.baked) return { x: px + stepX, z: pz + stepZ, vx, vz };

    const j = hullTuning || this.jeep;
    const sf = scaleFactor;
    const fwdX = -Math.sin(heading);
    const fwdZ = -Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);

    const baseStepLen = Math.hypot(stepX, stepZ);
    let finalStepX = stepX;
    let finalStepZ = stepZ;
    let finalVx = vx;
    let finalVz = vz;

    if (baseStepLen > 0.01) {
      let stepRatio = 1;
      for (const h of j.hullSpheres) {
        const ox = px + (fwdX * h.fwd + rightX * h.right) * sf;
        const oz = pz + (fwdZ * h.fwd + rightZ * h.right) * sf;
        const oy = carY + h.y * sf;
        const r = h.r * sf;
        const maxCast = baseStepLen + r + j.sweepFwdMargin * sf;
        const sweepResult = cliffBvh.spherecast(
          ox, oy, oz, r,
          stepX, 0, stepZ,
          maxCast,
        );
        if (sweepResult) {
          const topY = cliffBvh.raycastHeight(sweepResult.point.x, sweepResult.point.z);
          const isStepOver =
            topY != null && topY <= carY + j.stepOverHeight * sf;
          if (!isStepOver) {
            const safeDist = Math.max(
              0,
              sweepResult.distance - r - j.collisionSkin,
            );
            const rPart = safeDist / baseStepLen;
            stepRatio = Math.min(stepRatio, rPart);
          }
        }
      }
      if (stepRatio < 1) {
        finalStepX = stepX * stepRatio;
        finalStepZ = stepZ * stepRatio;
      }
    }

    let posX = px + finalStepX;
    let posZ = pz + finalStepZ;

    const halfL = j.probeHalfLength * sf;
    const halfW = j.probeHalfWidth * sf;
    const ride = j.rideHeight * sf;
    const probeY_low = carY + ride + j.probeYLow * sf;
    const probeY_high = carY + ride + j.probeYHigh * sf;
    const stepOverY = carY + j.stepOverHeight * sf;
    const skin = j.collisionSkin;
    const searchR = j.probeSearchRadius;
    const penSlack = j.probePenetrationSlack;

    for (let iter = 0; iter < 3; iter++) {
      let pushed = false;

      const probePoints = [
        { x: posX + fwdX * halfL, z: posZ + fwdZ * halfL },
        { x: posX - fwdX * halfL, z: posZ - fwdZ * halfL },
        { x: posX + rightX * halfW, z: posZ + rightZ * halfW },
        { x: posX - rightX * halfW, z: posZ - rightZ * halfW },
        {
          x: posX + fwdX * halfL + rightX * halfW,
          z: posZ + fwdZ * halfL + rightZ * halfW,
        },
        {
          x: posX + fwdX * halfL - rightX * halfW,
          z: posZ + fwdZ * halfL - rightZ * halfW,
        },
        {
          x: posX - fwdX * halfL + rightX * halfW,
          z: posZ - fwdZ * halfL + rightZ * halfW,
        },
        {
          x: posX - fwdX * halfL - rightX * halfW,
          z: posZ - fwdZ * halfL - rightZ * halfW,
        },
      ];

      for (const probe of probePoints) {
        for (const py of [probeY_low, probeY_high]) {
          const closest = cliffBvh.closestPointToPoint(
            probe.x, py, probe.z,
            skin + searchR,
          );
          if (!closest) continue;

          const dx = probe.x - closest.x;
          const dy = py - closest.y;
          const dz = probe.z - closest.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist >= skin + penSlack) continue;
          if (dist < 1e-6) continue;

          const topCheck = cliffBvh.raycastHeight(closest.x, closest.z);
          if (topCheck != null && topCheck <= stepOverY) continue;

          const ny = dy / dist;
          if (ny > 0.7) continue;

          const nx = dx / dist;
          const nz = dz / dist;
          const nHoriz = Math.sqrt(nx * nx + nz * nz);
          if (nHoriz < 0.01) continue;

          const nnx = nx / nHoriz;
          const nnz = nz / nHoriz;
          const pen = skin + penSlack - dist;
          if (pen > 0.001) {
            posX += nnx * pen * 0.6;
            posZ += nnz * pen * 0.6;
            pushed = true;

            const vDot = finalVx * nnx + finalVz * nnz;
            if (vDot < 0) {
              finalVx -= vDot * nnx;
              finalVz -= vDot * nnz;
            }
          }
        }
      }
      if (!pushed) break;
    }

    return { x: posX, z: posZ, vx: finalVx, vz: finalVz };
  }

  updateSuspension(
    bodyYInput,
    wheelWorldXZs,
    scaleFactor,
    heading,
    dtSec,
    getTerrainHeight,
    cliffBvh,
    vx,
    vz,
    jumpRequested,
    chassisTuning = null,
  ) {
    const j = chassisTuning || this.jeep;
    const kind = chassisTuning ? "lotus" : "jeep";
    if (this._suspChassisKind !== kind) {
      this._initialized = false;
      this._suspChassisKind = kind;
    }

    const sf = scaleFactor;
    const rideOffset = j.rideHeight * sf;
    const restLen = rideOffset + this._suspEqComp(j);
    const maxTravel = j.suspMaxTravel;

    const bodyY = bodyYInput + rideOffset;

    for (let i = 0; i < 4; i++) {
      const wx = wheelWorldXZs[i * 2];
      const wz = wheelWorldXZs[i * 2 + 1];
      let groundH = getTerrainHeight(wx, wz);
      if (cliffBvh?.baked) {
        const bvhH = this._sampleBvhWheelY(cliffBvh, wx, wz, bodyY, sf, j);
        if (bvhH != null && bvhH > groundH) groundH = bvhH;
      }
      this.wheelContactYs[i] = groundH;
    }

    if (!this._initialized) {
      for (let i = 0; i < 4; i++) this._prevGroundYs[i] = this.wheelContactYs[i];
      this._initialized = true;
    }

    // Full-overhang detection: ALL 4 wheels report ground above the body. This
    // only happens when step-over let the car phase under a slope and the body
    // is geometrically beneath an overhanging surface. In that case the spring
    // force at clamped-max-compression on 4 wheels rocket-launches the car.
    // Partial cases (slope climbing where only front wheels are slightly above
    // body in transients) are untouched — at least one wheel is always below
    // body on real slopes.
    let fullOverhang = true;
    for (let i = 0; i < 4; i++) {
      if (this.wheelContactYs[i] <= bodyY) { fullOverhang = false; break; }
    }

    let totalForce = 0;
    let groundedCount = 0;
    const wheelF = this.telemetry.wheelForce;
    const compDbg = this.telemetry.compression;

    for (let i = 0; i < 4; i++) {
      wheelF[i] = 0;
      compDbg[i] = 0;
      const groundY = this.wheelContactYs[i];
      const distToGround = bodyY - groundY;
      const compression = restLen - distToGround;

      if (compression > 0) {
        this.wheelGrounded[i] = true;
        groundedCount++;

        // Full overhang: don't fire the spring. Body integrates with gravity;
        // maxGroundY clamp will lift it (also suppressed below to a smooth rate).
        if (fullOverhang) {
          compDbg[i] = maxTravel;
          this.wheelSuspLengths[i] = 0;
          continue;
        }

        const clampedComp = Math.min(compression, maxTravel);
        compDbg[i] = clampedComp;
        const rawGroundVelY = (groundY - this._prevGroundYs[i]) / Math.max(dtSec, 0.001);
        const groundVelY = Math.max(-80, Math.min(80, rawGroundVelY));
        const compVel = -(this.velY - groundVelY);
        const dampRate =
          compVel > 0 ? j.suspDampCompress : j.suspDampRelax;
        const force = j.suspStiffness * clampedComp + dampRate * compVel;
        const fClamped = Math.max(0, force);
        totalForce += fClamped;
        wheelF[i] = fClamped;
        this.wheelSuspLengths[i] = distToGround;
      } else {
        this.wheelGrounded[i] = false;
        this.wheelSuspLengths[i] = restLen;
      }
    }

    for (let i = 0; i < 4; i++) this._prevGroundYs[i] = this.wheelContactYs[i];

    if (jumpRequested && groundedCount > 0 && !this.inAir) {
      this.velY = j.jumpImpulse;
    }

    const weight = j.mass * j.gravity;
    const netForce = totalForce - weight;
    this.velY += (netForce / j.mass) * dtSec;

    let newBodyY = bodyY + this.velY * dtSec;

    let maxGroundY = -Infinity;
    for (let i = 0; i < 4; i++) {
      if (this.wheelContactYs[i] > maxGroundY) maxGroundY = this.wheelContactYs[i];
    }
    if (newBodyY < maxGroundY) {
      if (fullOverhang) {
        // Smooth lift instead of teleport — avoids carrying upward inertia
        // when the body needs to step up out of a low overhang.
        newBodyY = Math.min(maxGroundY, newBodyY + maxTravel);
        this.velY = 0;
      } else {
        newBodyY = maxGroundY;
        if (this.velY < 0) this.velY = 0;
      }
    }

    this.inAir = groundedCount === 0;

    if (this.inAir) {
      const hSpeed = Math.sqrt(vx * vx + vz * vz);
      const targetPitch = hSpeed > 1 ? Math.atan2(this.velY, hSpeed) : 0;
      this.airPitch +=
        (targetPitch - this.airPitch) *
        (1 - Math.exp(-j.airPitchSmooth * dtSec));
    } else {
      this.airPitch *= (1 - Math.min(1, 8 * dtSec));
    }

    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    const wheelBaseDist = j.wheelBase * sf;
    const trackDist = j.track * sf;

    const frontAvgY = (this.wheelContactYs[0] + this.wheelContactYs[1]) * 0.5;
    const rearAvgY = (this.wheelContactYs[2] + this.wheelContactYs[3]) * 0.5;
    const leftAvgY = (this.wheelContactYs[0] + this.wheelContactYs[2]) * 0.5;
    const rightAvgY = (this.wheelContactYs[1] + this.wheelContactYs[3]) * 0.5;

    const dHdFwd = (frontAvgY - rearAvgY) / wheelBaseDist;
    const dHdRight = (rightAvgY - leftAvgY) / trackDist;
    const terrainPitch = Math.atan2(dHdFwd, 1);
    const terrainRoll = Math.atan2(dHdRight, 1);

    const nLenSq = dHdFwd * dHdFwd + dHdRight * dHdRight + 1;
    const nLen = Math.sqrt(nLenSq);
    const normalY = 1 / nLen;
    const tooSteep = normalY < j.maxSlopeCos;
    this.onSteepSlope = tooSteep && !this.inAir;

    const nx = dHdFwd * sinH - dHdRight * cosH;
    const nz = dHdFwd * cosH + dHdRight * sinH;

    let slideVx = 0,
      slideVz = 0;
    if (tooSteep && !this.inAir) {
      slideVx = (nx / nLen) * j.gravity * 0.5 * dtSec;
      slideVz = (nz / nLen) * j.gravity * 0.5 * dtSec;
    }

    const outputY = newBodyY - rideOffset;

    this.telemetry.totalSpringForce = totalForce;
    this.telemetry.netVerticalForce = netForce;
    this.telemetry.weight = weight;
    this.telemetry.groundedCount = groundedCount;

    return {
      y: outputY,
      terrainPitch,
      terrainRoll,
      slideVx,
      slideVz,
      tooSteep,
      slopeX: nx / nLen,
      slopeZ: nz / nLen,
    };
  }
}
