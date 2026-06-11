/**
 * Parkour sandbox physics — extends v2 CarPhysics read-only.
 * Do NOT modify ../v2/play/carPhysics.js; parkour-specific BVH fixes live here.
 */
import { CarPhysics } from "../v2/play/carPhysics.js";

export {
  DEFAULT_LOTUS_CHASSIS,
  DEFAULT_LOTUS_COLLISION_HULL,
} from "../v2/play/carPhysics.js";

function isOverheadBvHHit(hitY, normalY, stepOverY) {
  if (hitY <= stepOverY) return false;
  if (normalY != null && Number.isFinite(normalY)) {
    if (normalY < -0.45) return true;
    if (Math.abs(normalY) < 0.55) return false;
  }
  return hitY > stepOverY + 1.25;
}


/** v2-style step-over test — must use Y=∞ column height so walls read as tall, not y=0 ground. */
function isStepOverLip(cliffBvh, wx, wz, stepOverY) {
  if (!cliffBvh?.baked) return false;
  const topY = cliffBvh.raycastHeight(wx, wz);
  return topY != null && topY <= stepOverY;
}

export class ParkourCarPhysics extends CarPhysics {
  _sampleBvhWheelY(cliffBvh, wx, wz, hubY, scaleFactor, surf = null) {
    if (!cliffBvh?.baked) return null;
    const s = surf || this.jeep;
    const sf = scaleFactor;
    const pad = s.wheelBvhRayPadAboveHub * sf;
    const maxY = hubY + s.wheelBvHMaxAboveHub * sf;

    const tryRay = (oy) => {
      const h = cliffBvh.raycastHeightFrom(wx, oy, wz);
      if (h == null || h > maxY) return null;
      return h;
    };

    let bvhH = tryRay(hubY + pad + 1e-4);
    if (bvhH == null) bvhH = tryRay(maxY + pad + 1e-4);
    return bvhH;
  }

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
    const ride = j.rideHeight * sf;
    const fwdX = -Math.sin(heading);
    const fwdZ = -Math.cos(heading);
    const rightX = Math.cos(heading);
    const rightZ = -Math.sin(heading);

    const baseStepLen = Math.hypot(stepX, stepZ);
    let finalStepX = stepX;
    let finalStepZ = stepZ;
    let finalVx = vx;
    let finalVz = vz;
    const stepOverY = carY + j.stepOverHeight * sf;

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
          const hitNy = sweepResult.normal?.y ?? 0;
          // Bridge deck belly — ignore. Vertical walls fall through to block test.
          if (isOverheadBvHHit(sweepResult.point.y, hitNy, stepOverY)) {
            continue;
          }
          const isStepOver = isStepOverLip(
            cliffBvh,
            sweepResult.point.x,
            sweepResult.point.z,
            stepOverY,
          );
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
    const probeY_low = carY + ride + j.probeYLow * sf;
    const probeY_high = carY + ride + j.probeYHigh * sf;
    const skin = j.collisionSkin;
    const searchR = j.probeSearchRadius;
    const penSlack = j.probePenetrationSlack;

    for (let iter = 0; iter < 6; iter++) {
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

          if (
            isStepOverLip(cliffBvh, closest.x, closest.z, stepOverY)
          ) {
            continue;
          }

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
            posX += nnx * pen;
            posZ += nnz * pen;
            pushed = true;

            const vDot = finalVx * nnx + finalVz * nnz;
            if (vDot < 0) {
              // Restitution: 0 = old stick (just kill normal component),
              // >0 reflects outward. Owner sets `this.wallRestitution`.
              const e = Math.max(0, this.wallRestitution ?? 0);
              finalVx -= (1 + e) * vDot * nnx;
              finalVz -= (1 + e) * vDot * nnz;
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

    let fullOverhang = true;
    for (let i = 0; i < 4; i++) {
      if (this.wheelContactYs[i] <= bodyY) {
        fullOverhang = false;
        break;
      }
    }
    // Ramp / slope: wheel heights differ — not an overhead shelf.
    if (fullOverhang) {
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < 4; i++) {
        const y = this.wheelContactYs[i];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (maxY - minY > j.wheelBase * 0.012 * sf) fullOverhang = false;
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

        if (fullOverhang) {
          compDbg[i] = maxTravel;
          this.wheelSuspLengths[i] = 0;
          continue;
        }

        const clampedComp = Math.min(compression, maxTravel);
        compDbg[i] = clampedComp;
        const rawGroundVelY =
          (groundY - this._prevGroundYs[i]) / Math.max(dtSec, 0.001);
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
    let minGroundY = Infinity;
    for (let i = 0; i < 4; i++) {
      const gy = this.wheelContactYs[i];
      if (gy > maxGroundY) maxGroundY = gy;
      if (gy < minGroundY) minGroundY = gy;
    }

    const frontAvgY =
      (this.wheelContactYs[0] + this.wheelContactYs[1]) * 0.5;
    const rearAvgY =
      (this.wheelContactYs[2] + this.wheelContactYs[3]) * 0.5;
    const leftAvgY = (this.wheelContactYs[0] + this.wheelContactYs[2]) * 0.5;
    const rightAvgY = (this.wheelContactYs[1] + this.wheelContactYs[3]) * 0.5;
    const slopeSpan = Math.abs(frontAvgY - rearAvgY);
    const onSlope =
      slopeSpan > 0.04 * sf ||
      maxGroundY - minGroundY > j.wheelBase * 0.01 * sf;

    // Flat: hub rideHeight above highest contact. Slopes: anchor from lowest
    // contact so rear wheels stay sprung when the nose climbs (max-only lifts rear).
    const minHubY = onSlope
      ? minGroundY + rideOffset
      : maxGroundY + rideOffset;

    if (onSlope) {
      if (newBodyY < minHubY) {
        newBodyY = minHubY;
        if (this.velY < 0) this.velY = 0;
      }
    } else if (newBodyY < maxGroundY) {
      if (fullOverhang) {
        newBodyY = Math.min(minHubY, newBodyY + maxTravel);
        this.velY = 0;
      } else {
        newBodyY = maxGroundY;
        if (this.velY < 0) this.velY = 0;
      }
    } else if (newBodyY < minHubY) {
      newBodyY = minHubY;
      if (this.velY < 0) this.velY = 0;
    }

    this.inAir = groundedCount === 0;

    if (this.inAir) {
      const hSpeed = Math.sqrt(vx * vx + vz * vz);
      const targetPitch = hSpeed > 1 ? Math.atan2(this.velY, hSpeed) : 0;
      this.airPitch +=
        (targetPitch - this.airPitch) *
        (1 - Math.exp(-j.airPitchSmooth * dtSec));
    } else {
      this.airPitch *= 1 - Math.min(1, 8 * dtSec);
    }

    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    const wheelBaseDist = j.wheelBase * sf;
    const trackDist = j.track * sf;

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

    let slideVx = 0;
    let slideVz = 0;
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
