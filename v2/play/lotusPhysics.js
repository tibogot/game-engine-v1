/**
 * Lotus — arcade driving only (throttle, steer, drift, nitro, body lean).
 * World vertical position, suspension, BVH wheel rays, and slope sliding live in
 * `CarPhysics.updateSuspension` + `playMode` (same pipeline as Bruno; do not duplicate gravity here).
 */

export const DEFAULT_LOTUS_PHYSICS_PARAMS = {
  accel: 34,
  accelBoost: 62,
  brake: 30,
  reverseAccel: 10,
  maxSpeed: 58,
  maxSpeedBoost: 88,
  coast: 1.0,
  drag: 0.0035,
  handbrakeDecel: 4,

  baseAccelLowSpeedMul: 0.55,
  baseAccelRampToKmh: 120,

  turnRate: 1.2,
  turnRateDrift: 2.4,
  turnRateCounter: 1.6,

  gripBase: 14,
  gripSpeedDecay: 0.12,
  gripMinSpeed: 4.0,
  gripHandbrake: 0.6,
  gripCounterBonus: 3.0,
  gripBrakeTurn: 1.8,
  gripRecoveryRate: 8.0,
  gripHandbrakeApplyRate: 8.0,

  driftEntrySpeed: 10,
  driftAngleMin: 0.08,
  driftAngleExit: 0.04,

  driftBoostBuildRate: 1.0,
  driftBoostMax: 1.0,
  driftBoostAngleMin: 0.15,
  driftBoostAngleMax: 0.8,
  driftBoostAnglePenaltyEnd: 1.2,
  driftBoostSpeedAdd: 15,
  driftBoostDuration: 1.5,
  driftBoostQualifyTime: 0.5,

  bodyRollMax: 0.15,
  bodyPitchMax: 0.18,
  bodySmooth: 6,

  wheelRadius: 0.38,

  nitroAccelBonus: 24,
  nitroMaxSpeedBonus: 28,
  nitroDrainPerSec: 0.28,
  nitroRegenPerSec: 0.16,
  nitroMinToUse: 0.05,

  boostBlendSmooth: 12,
  nitroFxBlendSmooth: 16,

  /** Copied each frame into `CarPhysics.lotusChassis` for suspension / wheel rays. */
  gravity: 28,
  rideHeight: 0.35,
  maxSlopeCos: 0.5,
  wheelBase: 1.9,
  track: 1.1,
  wheelBvhRayPadAboveHub: 1.05,
  wheelBvHMaxAboveHub: 3.2,
};

function _expSmooth(current, target, dtSec, rate) {
  return current + (target - current) * (1 - Math.exp(-rate * dtSec));
}

function _smoothstep(x, edge0, edge1) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class LotusPhysics {
  constructor() {
    this.params = { ...DEFAULT_LOTUS_PHYSICS_PARAMS };

    this._handbrakeBlend = 0;
    this._driftTime = 0;
    this.driftBoostMeter = 0;
    this._driftBoostActive = false;
    this._driftBoostRemaining = 0;
    this._driftBoostPower = 0;
    this._wasDrifting = false;
  }

  /**
   * @param {LotusDrivingState} state
   * @param {LotusDrivingInput} input
   * @param {number} dtSec
   * @returns {LotusDrivingResult}
   */
  updateDriving(state, input, dtSec) {
    const p = this.params;
    let {
      vx,
      vz,
      heading,
      nitro,
      drifting,
      driftAngle,
      boostBlend,
      nitroFxBlend,
      wheelSpin,
      onSteepSlope,
    } = state;
    const {
      forward,
      backward,
      leftKey,
      rightKey,
      handbrake,
      nitroHeld,
      boostKeys,
    } = input;

    const curSpeed = Math.hypot(vx, vz);

    const hx = -Math.sin(heading);
    const hz = -Math.cos(heading);
    const rx = Math.cos(heading);
    const rz = -Math.sin(heading);

    const nitroActive = nitroHeld && nitro > p.nitroMinToUse && !backward;

    boostBlend = _expSmooth(boostBlend, boostKeys ? 1 : 0, dtSec, p.boostBlendSmooth);
    nitroFxBlend = _expSmooth(nitroFxBlend, nitroActive ? 1 : 0, dtSec, p.nitroFxBlendSmooth);

    // —— Longitudinal: accel / brake / coast / drag / cap ——
    const accelBase = p.accel + (p.accelBoost - p.accel) * boostBlend;
    let accel = accelBase + nitroFxBlend * p.nitroAccelBonus;
    if (!boostKeys && !nitroActive) {
      const speedKmh = curSpeed * 3.6;
      const rampT = _smoothstep(speedKmh, 0, p.baseAccelRampToKmh);
      accel *= p.baseAccelLowSpeedMul + (1 - p.baseAccelLowSpeedMul) * rampT;
    }
    if (onSteepSlope) accel *= 0.1;

    if (forward) {
      vx += hx * accel * dtSec;
      vz += hz * accel * dtSec;
    } else if (backward) {
      if (curSpeed > 1) {
        vx -= hx * p.brake * dtSec;
        vz -= hz * p.brake * dtSec;
      } else {
        vx -= hx * p.reverseAccel * dtSec;
        vz -= hz * p.reverseAccel * dtSec;
      }
    } else if (curSpeed > 0.05) {
      const decel = p.coast / curSpeed;
      vx -= vx * decel * dtSec;
      vz -= vz * decel * dtSec;
    } else {
      vx = 0;
      vz = 0;
    }

    if (handbrake && curSpeed > 0.1) {
      const hb = p.handbrakeDecel / curSpeed;
      vx -= vx * hb * dtSec;
      vz -= vz * hb * dtSec;
    }

    const speed2 = vx * vx + vz * vz;
    if (speed2 > 0.01) {
      const spd = Math.sqrt(speed2);
      const factor = Math.max(0, 1 - p.drag * spd * dtSec);
      vx *= factor;
      vz *= factor;
    }

    const maxBase = p.maxSpeed + (p.maxSpeedBoost - p.maxSpeed) * boostBlend;
    const maxSpd = maxBase + nitroFxBlend * p.nitroMaxSpeedBonus;
    const newSpeed = Math.hypot(vx, vz);
    if (newSpeed > maxSpd) {
      const s = maxSpd / newSpeed;
      vx *= s;
      vz *= s;
    }

    if (nitroActive && curSpeed > 1) {
      nitro = Math.max(0, nitro - p.nitroDrainPerSec * dtSec);
    } else {
      nitro = Math.min(1, nitro + p.nitroRegenPerSec * dtSec);
    }

    // —— Lateral grip + steering ——
    let steerInput = 0;
    if (leftKey) steerInput = 1;
    if (rightKey) steerInput = -1;

    const fwdDot = vx * hx + vz * hz;
    let latDot = vx * rx + vz * rz;

    let speedGrip = Math.max(
      p.gripMinSpeed,
      p.gripBase - curSpeed * p.gripSpeedDecay,
    );

    if (handbrake && curSpeed > p.driftEntrySpeed && steerInput !== 0) {
      this._handbrakeBlend = _expSmooth(
        this._handbrakeBlend,
        1,
        dtSec,
        p.gripHandbrakeApplyRate,
      );
    } else {
      this._handbrakeBlend = _expSmooth(
        this._handbrakeBlend,
        0,
        dtSec,
        p.gripRecoveryRate,
      );
    }

    let grip = speedGrip + (p.gripHandbrake - speedGrip) * this._handbrakeBlend;

    const driftDir = Math.sign(latDot);
    const isCounterSteering =
      drifting &&
      driftDir !== 0 &&
      steerInput !== 0 &&
      Math.sign(steerInput) !== Math.sign(driftDir);
    if (isCounterSteering) {
      const counterStrength = Math.min(1, Math.abs(driftAngle) / 0.5);
      grip += p.gripCounterBonus * counterStrength;
    }
    if (backward && steerInput !== 0 && curSpeed > 3) {
      grip = Math.min(grip, p.gripBrakeTurn);
    }

    const lateralKill = 1 - Math.exp(-grip * dtSec);
    vx -= rx * latDot * lateralKill;
    vz -= rz * latDot * lateralKill;

    if (steerInput !== 0 && curSpeed > 0.5) {
      const turnRate = drifting
        ? isCounterSteering
          ? p.turnRateCounter
          : p.turnRateDrift
        : p.turnRate;
      heading += steerInput * turnRate * dtSec;
    }

    // Drift angle uses pre-yaw basis (matches legacy Lotus / Bruno feel).
    const updatedLatDot = vx * rx + vz * rz;
    driftAngle =
      curSpeed > 1 ? Math.abs(Math.atan2(updatedLatDot, Math.abs(fwdDot))) : 0;

    if (!drifting) {
      drifting = driftAngle > p.driftAngleMin && curSpeed > p.driftEntrySpeed;
    } else {
      drifting =
        driftAngle > p.driftAngleExit && curSpeed > p.driftEntrySpeed * 0.5;
    }

    // —— Drift boost meter + exit burst ——
    if (drifting && curSpeed > p.driftEntrySpeed) {
      this._driftTime += dtSec;
      if (this._driftTime > p.driftBoostQualifyTime) {
        const angleQuality = _smoothstep(
          driftAngle,
          p.driftBoostAngleMin,
          p.driftBoostAngleMax,
        );
        const anglePenalty =
          driftAngle > p.driftBoostAngleMax
            ? 1 -
              _smoothstep(
                driftAngle,
                p.driftBoostAngleMax,
                p.driftBoostAnglePenaltyEnd,
              )
            : 1;
        this.driftBoostMeter = Math.min(
          p.driftBoostMax,
          this.driftBoostMeter +
            p.driftBoostBuildRate * angleQuality * anglePenalty * dtSec,
        );
      }
    } else {
      if (
        this._wasDrifting &&
        this._driftTime > p.driftBoostQualifyTime &&
        this.driftBoostMeter > 0.1
      ) {
        this._driftBoostActive = true;
        this._driftBoostRemaining = p.driftBoostDuration * this.driftBoostMeter;
        this._driftBoostPower = this.driftBoostMeter;
      }
      this._driftTime = 0;
      this.driftBoostMeter = 0;
    }
    this._wasDrifting = drifting;

    if (this._driftBoostActive) {
      this._driftBoostRemaining -= dtSec;
      if (this._driftBoostRemaining <= 0) {
        this._driftBoostActive = false;
        this._driftBoostPower = 0;
      } else {
        const boostFrac =
          this._driftBoostRemaining /
          (p.driftBoostDuration * this._driftBoostPower);
        const speedBonus = p.driftBoostSpeedAdd * Math.min(1, boostFrac);
        const bhx = -Math.sin(heading);
        const bhz = -Math.cos(heading);
        vx += bhx * speedBonus * dtSec * 2;
        vz += bhz * speedBonus * dtSec * 2;
      }
    }

    // —— Visual body targets ——
    const latSign = Math.sign(updatedLatDot);
    const speedForRoll = Math.hypot(vx, vz);
    const driftRollSpeedGain = _smoothstep(speedForRoll, 8, 24);
    const driftRoll =
      -latSign * Math.min(p.bodyRollMax, driftAngle * 0.85) * driftRollSpeedGain;
    const throttlePitch = forward ? 0.045 : backward ? -0.06 : 0;
    const speedNorm = Math.min(1, curSpeed / Math.max(1, p.maxSpeed));
    const dynamicPitch = -speedNorm * 0.04;
    const rawPitch = dynamicPitch + throttlePitch;
    const targetDynPitch = Math.max(
      -p.bodyPitchMax,
      Math.min(p.bodyPitchMax, rawPitch),
    );
    const targetDynRoll = drifting ? driftRoll : 0;
    const bodySmooth = 1 - Math.exp(-p.bodySmooth * dtSec);

    wheelSpin -= (fwdDot / p.wheelRadius) * dtSec;

    return {
      vx,
      vz,
      heading,
      nitro,
      drifting,
      driftAngle,
      boostBlend,
      nitroFxBlend,
      wheelSpin,
      bodyRollTarget: targetDynRoll,
      bodyPitchTarget: targetDynPitch,
      bodySmooth,
      driftBoostMeter: this.driftBoostMeter,
      driftBoostActive: this._driftBoostActive,
    };
  }
}
