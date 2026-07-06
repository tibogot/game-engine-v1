/**
 * V3 flight physics — v2-style point rays for collision (holes/openings), arcade velocity.
 */
import * as THREE from "three";

export const DEFAULT_FLIGHT_PARAMS = {
  sphereRadius: 2.2,

  thrust: 10.5,
  reverseThrust: 8,
  brake: 26,
  coast: 3.8,
  drag: 0.014,
  maxSpeedFwd: 56,
  maxSpeedFwdBoost: 78,
  maxSpeedRev: 18,
  boostMult: 1.5,

  gravity: 0,
  stallSpeed: 14,
  stallSink: 6,

  pitchMin: -1.22,
  pitchMax: 0.9,
  rollMax: 0.78,
  rollYawRate: 0.9,
  rollSmooth: 10,
  rollTargetDecay: 5,
  rollMouseScale: 0.0042,
  aileronRate: 2.8,

  deckAglMax: 1.35,
  deckSpeedMax: 16,
  deckBlendRate: 4,

  mouseSensX: 0.0022,
  mouseSensY: 0.00235,
  barrelDuration: 0.88,

  // v2 ray collision tuning
  sweepMargin: 0.9,
  wingSpanExtra: 0.8,
  probeUpDist: 1.5,
  probeDownDist: 1.5,
  hitSweepSpeedMult: 0.75,
  hitSpeedLoss: 0.4,
  hitSpeedMin: 0.3,

  // Thrust reserve (Shift boost)
  boostDrainPerSec: 0.14,
  boostRegenPerSec: 0.22,
  boostMinReserve: 0.06,
};

const _fwd = new THREE.Vector3();
const _prev = new THREE.Vector3();

/** Ground under the plane — cast down from player height, not from sky (v2 playMode). */
function flightFloorY(getTerrainHeight, sampleGroundY, collider, x, z, py) {
  const stepUp = 1.0;
  const fromY = py + stepUp;
  const terrainY = getTerrainHeight(x, z);
  if (terrainY > fromY) {
    const bvhY = collider?.raycastHeightFrom?.(x, fromY, z);
    return bvhY ?? terrainY;
  }
  return sampleGroundY(x, z, fromY);
}

export class FlightController {
  constructor(params = {}) {
    this.params = { ...DEFAULT_FLIGHT_PARAMS, ...params };
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    /** Scalar forward speed — horizontal track follows heading each frame (v2 arcade). */
    this.planeSpeed = 0;
    this.heading = 0;
    this.pitch = 0;
    this.roll = 0;
    this.rollTarget = 0;
    this.aileronAngle = 0;
    this.groundCamYawOff = 0;
    this.barrelActive = false;
    this.barrelPhase = 0;
    this.barrelDir = 1;
    this.thrustReserve = 1;
    this.debug = { onDeck: false, agl: 0, speed: 0 };
  }

  setParams(patch) {
    Object.assign(this.params, patch);
  }

  reset(x, y, z, yaw) {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.planeSpeed = 0;
    this.heading = yaw;
    this.pitch = 0;
    this.roll = 0;
    this.rollTarget = 0;
    this.aileronAngle = 0;
    this.groundCamYawOff = 0;
    this.barrelActive = false;
    this.barrelPhase = 0;
    this.thrustReserve = 1;
  }

  bodyForward(out = _fwd) {
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    return out.set(-sinH * cosP, sinP, -cosH * cosP);
  }

  horizontalSpeed() {
    return Math.abs(this.planeSpeed);
  }

  speed() {
    return Math.abs(this.planeSpeed);
  }

  triggerBarrelRoll() {
    if (this.barrelActive) return;
    this.barrelActive = true;
    this.barrelPhase = 0;
    this.barrelDir = this.roll >= 0 ? 1 : -1;
  }

  applyMouse(mx, my, { onDeck }) {
    const p = this.params;
    if (onDeck) {
      this.groundCamYawOff -= mx * p.mouseSensX;
      return;
    }
    this.groundCamYawOff = 0;
    this.heading -= mx * p.mouseSensX;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + my * p.mouseSensY,
      p.pitchMin,
      p.pitchMax,
    );
    this.rollTarget = THREE.MathUtils.clamp(
      this.rollTarget - mx * p.rollMouseScale,
      -p.rollMax,
      p.rollMax,
    );
  }

  /** v2 playMode fly collision — point rays at plane centre, per-hit speed loss. */
  _applyV2Collision(collider, prevPos, groundY) {
    const p = this.params;
    const r = p.sphereRadius;
    const px = this.position.x;
    const py = this.position.y;
    const pz = this.position.z;

    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    const sinH = Math.sin(this.heading);
    const cosH = Math.cos(this.heading);
    const fwdX = -sinH * cosP;
    const fwdY = sinP;
    const fwdZ = -cosH * cosP;
    const rightX = cosH;
    const rightZ = -sinH;
    const wingSpan = r + p.wingSpanExtra;

    const moveDx = px - prevPos.x;
    const moveDz = pz - prevPos.z;
    const moveLen = Math.hypot(moveDx, moveDz);
    let speedMult = 1;

    if (moveLen > 1e-5 && collider?.raycast3D) {
      const sweep = collider.raycast3D(
        prevPos.x, prevPos.y, prevPos.z,
        moveDx, 0, moveDz,
        moveLen + r * p.sweepMargin,
      );
      if (sweep) {
        const nx = moveDx / moveLen;
        const nz = moveDz / moveLen;
        const safeDist = Math.max(0, sweep.distance - r * p.sweepMargin);
        this.position.x = prevPos.x + nx * safeDist;
        this.position.z = prevPos.z + nz * safeDist;
        speedMult = Math.min(speedMult, p.hitSweepSpeedMult);
      }
    }

    const probeDist = Math.max(r, r + moveLen);
    const rays = [
      { dx: fwdX, dy: fwdY, dz: fwdZ, dist: probeDist },
      { dx: rightX, dy: 0, dz: rightZ, dist: wingSpan },
      { dx: -rightX, dy: 0, dz: -rightZ, dist: wingSpan },
      { dx: 0, dy: 1, dz: 0, dist: p.probeUpDist },
      { dx: 0, dy: -1, dz: 0, dist: p.probeDownDist },
    ];

    for (const ray of rays) {
      const hit = collider.raycast3D(px, py, pz, ray.dx, ray.dy, ray.dz, ray.dist);
      if (!hit) continue;
      const pushDist = ray.dist - hit.distance;
      if (pushDist <= 0) continue;
      this.position.x -= ray.dx * pushDist;
      this.position.y -= ray.dy * pushDist;
      this.position.z -= ray.dz * pushDist;
      if (this.position.y < groundY) this.position.y = groundY;
      speedMult = Math.min(
        speedMult,
        Math.max(p.hitSpeedMin, 1 - pushDist * p.hitSpeedLoss),
      );
    }

    if (speedMult < 1) {
      this.planeSpeed *= speedMult;
      return true;
    }
    return false;
  }

  /** Rebuild velocity from heading/pitch/speed so turns track the nose instantly (v2 feel). */
  _syncVelocityFromControls(onDeck) {
    const p = this.params;
    const spdAbs = Math.abs(this.planeSpeed);
    const sg = this.planeSpeed >= 0 ? 1 : -1;

    if (spdAbs > 1e-4) {
      this.velocity.set(
        -Math.sin(this.heading) * sg * spdAbs,
        Math.sin(this.pitch) * this.planeSpeed,
        -Math.cos(this.heading) * sg * spdAbs,
      );
    } else {
      this.velocity.set(0, 0, 0);
    }

    if (!onDeck && p.gravity > 0) {
      this.velocity.y -= p.gravity;
    }
    if (!onDeck && spdAbs < p.stallSpeed) {
      const stallFrac = THREE.MathUtils.clamp(1 - spdAbs / p.stallSpeed, 0, 1);
      if (stallFrac > 0) this.velocity.y -= stallFrac * p.stallSink;
    }
  }

  update(dt, keys, { collider, sampleGroundY, getTerrainHeight }) {
    const p = this.params;
    dt = Math.min(dt, 0.05);

    _prev.copy(this.position);
    const floorY = flightFloorY(
      getTerrainHeight, sampleGroundY, collider,
      this.position.x, this.position.z, this.position.y,
    );
    const agl = this.position.y - floorY;
    const spdAbs = Math.abs(this.planeSpeed);
    const onDeck = agl < p.deckAglMax && spdAbs < p.deckSpeedMax;
    this.debug.onDeck = onDeck;
    this.debug.agl = agl;

    const thr = keys.w ? 1 : keys.s ? -1 : 0;
    const boostHeld = !!(keys.shift && thr === 1 && this.thrustReserve > p.boostMinReserve);
    const drag = p.drag * this.planeSpeed * Math.abs(this.planeSpeed);
    let coast = p.coast;
    if (agl < 1.15) coast *= 2.1;

    if (thr === 1) {
      let a = p.thrust;
      if (boostHeld) a *= p.boostMult;
      this.planeSpeed += a * dt;
    } else if (thr === -1) {
      if (this.planeSpeed > 0.55) this.planeSpeed -= p.brake * dt;
      else this.planeSpeed -= p.reverseThrust * dt;
    } else {
      if (this.planeSpeed > 0) {
        this.planeSpeed = Math.max(0, this.planeSpeed - (coast + drag) * dt);
      } else if (this.planeSpeed < 0) {
        this.planeSpeed = Math.min(0, this.planeSpeed + (coast + drag) * dt);
      }
    }

    const maxFwd = boostHeld ? p.maxSpeedFwdBoost : p.maxSpeedFwd;
    this.planeSpeed = THREE.MathUtils.clamp(this.planeSpeed, -p.maxSpeedRev, maxFwd);
    if (Math.abs(this.planeSpeed) < 0.04 && thr === 0) this.planeSpeed = 0;

    if (boostHeld) {
      this.thrustReserve = Math.max(0, this.thrustReserve - p.boostDrainPerSec * dt);
    } else {
      this.thrustReserve = Math.min(1, this.thrustReserve + p.boostRegenPerSec * dt);
    }

    if (this.barrelActive) {
      this.barrelPhase += dt / p.barrelDuration;
      if (this.barrelPhase >= 1) {
        this.barrelActive = false;
        this.barrelPhase = 0;
      }
    }

    const dtRoll = Math.min(dt, 0.08);
    this.rollTarget = THREE.MathUtils.lerp(
      this.rollTarget, 0, 1 - Math.exp(-p.rollTargetDecay * dtRoll),
    );
    this.roll = THREE.MathUtils.lerp(
      this.roll, this.rollTarget, 1 - Math.exp(-p.rollSmooth * dtRoll),
    );

    if (!onDeck) {
      this.heading += this.roll * p.rollYawRate * dt;
      if (keys.z) this.aileronAngle += p.aileronRate * dt;
      if (keys.c) this.aileronAngle -= p.aileronRate * dt;
    } else {
      const deckK = 1 - Math.exp(-p.deckBlendRate * dt);
      this.pitch = THREE.MathUtils.lerp(this.pitch, 0, deckK);
      this.rollTarget = THREE.MathUtils.lerp(this.rollTarget, 0, deckK);
      const lvl = 1 - Math.exp(-3 * dt);
      this.aileronAngle *= 1 - lvl;
      if (Math.abs(this.aileronAngle) < 0.01) this.aileronAngle = 0;
    }

    this._syncVelocityFromControls(onDeck);

    const vx = this.velocity.x * dt;
    const vy = this.velocity.y * dt;
    const vz = this.velocity.z * dt;
    this.position.x += vx;
    this.position.y += vy;
    this.position.z += vz;

    let collided = false;
    if (collider?.baked) {
      const groundAfterMove = flightFloorY(
        getTerrainHeight, sampleGroundY, collider,
        this.position.x, this.position.z, this.position.y,
      );
      collided = this._applyV2Collision(collider, _prev, groundAfterMove);
    }

    const floorNow = flightFloorY(
      getTerrainHeight, sampleGroundY, collider,
      this.position.x, this.position.z, this.position.y,
    );

    if (onDeck) {
      const deckK = 1 - Math.exp(-p.deckBlendRate * dt);
      this.position.y = THREE.MathUtils.lerp(this.position.y, floorNow, deckK);
    } else {
      this.position.y = Math.max(floorNow, this.position.y);
    }

    this.debug.agl = this.position.y - floorNow;
    this.debug.speed = this.speed();
    return this.position;
  }

  getHudState() {
    return {
      speed: this.speed(),
      agl: this.debug.agl,
      pitch: this.pitch,
      roll: this.roll,
      barrelActive: this.barrelActive,
      barrelPhase: this.barrelPhase,
      barrelDir: this.barrelDir,
      aileronAngle: this.aileronAngle,
      thrustReserve: this.thrustReserve,
    };
  }
}
