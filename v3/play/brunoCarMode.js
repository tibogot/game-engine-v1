import * as THREE from "three";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { CarPhysics } from "../../v2/play/carPhysics.js";

const CAR_MODEL = "/models/bruno.glb";
const CAR_MODEL_YAW = Math.PI / 2;
const CAR_MODEL_SCALE = 1.9;
const CAR_WHEEL_BASE = 1.9;
const CAR_TRACK = 1.1;
const CAR_RIDE_HEIGHT = 0.48;
const CAR_WHEEL_RADIUS = 0.42;
const CAR_SUSP_TRAVEL = 0.45;

const CAR_ACCEL = 26;
const CAR_ACCEL_BOOST = 52;
const CAR_BRAKE = 35;
const CAR_REVERSE_ACCEL = 12;
const CAR_MAX_SPEED = 45;
const CAR_MAX_SPEED_BOOST = 72;
const CAR_COAST = 1.35;
const CAR_DRAG = 0.0042;
const CAR_TURN_RATE = 1.0;
const CAR_TURN_RATE_DRIFT = 2.0;
const CAR_GRIP_NORMAL = 12;
const CAR_GRIP_DRIFT = 0.8;
const CAR_GRIP_BRAKE_TURN = 2.0;
const CAR_DRIFT_ENTRY_SPEED = 8;
const CAR_DRIFT_ANGLE_MIN = 0.1;
const CAR_HANDBRAKE_DECEL = 3;
const CAR_BODY_ROLL_MAX = 0.2;
const CAR_BODY_PITCH_MAX = 0.12;
const CAR_TERRAIN_BODY_SMOOTH = 13;
const CAR_CAM_DIST = 8.5;
const CAR_CAM_HEIGHT = 3.2;
const CAR_CAM_CHASE_SPEED = 3.5;
const CAR_CAM_DRIFT_LAG = 1.8;

/** Bruno jeep — arcade drive + CarPhysics suspension (v2 playMode port). */
export function createBrunoCarMode({
  scene,
  sampleGroundY,
  getCliffBvh,
  getTreeBvh,
}) {
  const physics = new CarPhysics();
  const wheelWorldXZs = new Float32Array(8);

  let loaded = false;
  let carRoot = null;
  let carChassis = null;
  let carWheels = [];

  let heading = 0;
  let camYaw = 0;
  let vx = 0;
  let vz = 0;
  let velY = 0;
  let inAir = false;
  let onSteepSlope = false;
  let wheelSpin = 0;
  let steerSmooth = 0;
  let terrainPitch = 0;
  let terrainRoll = 0;
  let bodyPitch = 0;
  let bodyRoll = 0;
  let terrainPitchTarget = 0;
  let terrainRollTarget = 0;
  let driftAngle = 0;
  let drifting = false;
  let _boostBlend = 0;

  function load() {
    getSharedGltfLoader().load(
      CAR_MODEL,
      (gltf) => {
        const src = gltf.scene;
        let chassisSrc = null;
        let wheelSrc = null;
        src.traverse((o) => {
          if (!chassisSrc && /^chassis(\.|\d|$)/.test(o.name)) chassisSrc = o;
          if (!wheelSrc && /^wheelContainer(\.|\d|$)/.test(o.name)) wheelSrc = o;
        });
        if (!chassisSrc || !wheelSrc) {
          console.warn("[Play] bruno.glb missing chassis/wheelContainer — using raw scene.");
          if (!chassisSrc) chassisSrc = src;
          if (!wheelSrc) wheelSrc = src.clone(true);
        }

        const chassisVisual = chassisSrc.clone(true);
        chassisVisual.position.set(0, 0, 0);
        chassisVisual.rotation.set(0, CAR_MODEL_YAW, 0);
        chassisVisual.traverse((o) => {
          if (/^wheelContainer(\.|\d|$)/.test(o.name)) o.parent?.remove(o);
          if (o.isMesh || o.isSkinnedMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });

        carChassis = new THREE.Group();
        carChassis.rotation.order = "YXZ";
        carChassis.add(chassisVisual);

        carRoot = new THREE.Group();
        carRoot.rotation.order = "YXZ";
        carRoot.scale.setScalar(CAR_MODEL_SCALE);
        carRoot.add(carChassis);
        carRoot.visible = false;
        scene.add(carRoot);

        const hw = CAR_WHEEL_BASE * 0.5;
        const ht = CAR_TRACK * 0.5;
        const offsets = [
          { x: -ht, z: -hw, steer: true, name: "FL" },
          { x: ht, z: -hw, steer: true, name: "FR" },
          { x: -ht, z: hw, steer: false, name: "RL" },
          { x: ht, z: hw, steer: false, name: "RR" },
        ];
        carWheels = offsets.map((w) => {
          const container = wheelSrc.clone(true);
          container.position.set(w.x, -CAR_RIDE_HEIGHT, w.z);
          const isLeft = w.x < 0;
          container.rotation.set(0, CAR_MODEL_YAW + (isLeft ? Math.PI : 0), 0);
          let suspension = null;
          let cylinder = null;
          container.traverse((c) => {
            if (!suspension && /^wheelSuspension(\.|\d|$)/.test(c.name)) suspension = c;
            if (!cylinder && /^wheelCylinder(\.|\d|$)/.test(c.name)) cylinder = c;
            if (c.isMesh || c.isSkinnedMesh) {
              c.castShadow = true;
              c.receiveShadow = true;
            }
          });
          carChassis.add(container);
          return {
            container,
            suspension: suspension || container,
            cylinder: cylinder || container,
            offset: new THREE.Vector3(w.x, 0, w.z),
            steer: w.steer,
            isLeft,
            _smoothLocalY: -CAR_RIDE_HEIGHT,
          };
        });

        loaded = true;
        console.log(`[Play] Bruno loaded (${CAR_MODEL})`);
      },
      undefined,
      (err) => console.warn(`[Play] Bruno load failed (${CAR_MODEL}):`, err),
    );
  }
  load();

  function resetFrom(x, y, z, yaw) {
    const gy = sampleGroundY(x, z);
    heading = yaw;
    camYaw = yaw;
    vx = 0;
    vz = 0;
    velY = 0;
    inAir = false;
    wheelSpin = 0;
    steerSmooth = 0;
    terrainPitch = 0;
    terrainRoll = 0;
    bodyPitch = 0;
    bodyRoll = 0;
    physics._initialized = false;
    return { x, y: gy, z };
  }

  function _fillWheelXZ(pos, sf) {
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);
    for (let i = 0; i < 4; i++) {
      const lx = carWheels[i].offset.x * sf;
      const lz = carWheels[i].offset.z * sf;
      wheelWorldXZs[i * 2] = pos.x + lx * cosH + lz * sinH;
      wheelWorldXZs[i * 2 + 1] = pos.z - lx * sinH + lz * cosH;
    }
  }

  function update(dt, keys, pos) {
    if (!loaded) return;

    const forward = keys.w;
    const backward = keys.s;
    const leftKey = keys.a;
    const rightKey = keys.d;
    const handbrake = keys.space;
    const boostKeys = keys.shift;

    _boostBlend = THREE.MathUtils.lerp(_boostBlend, boostKeys ? 1 : 0, 1 - Math.exp(-8 * dt));

    let accel = THREE.MathUtils.lerp(CAR_ACCEL, CAR_ACCEL_BOOST, _boostBlend);
    if (onSteepSlope) accel *= 0.1;

    const curSpeed = Math.hypot(vx, vz);
    const hx = -Math.sin(heading);
    const hz = -Math.cos(heading);

    if (forward) {
      vx += hx * accel * dt;
      vz += hz * accel * dt;
    } else if (backward) {
      if (curSpeed > 1) {
        vx -= hx * CAR_BRAKE * dt;
        vz -= hz * CAR_BRAKE * dt;
      } else {
        vx -= hx * CAR_REVERSE_ACCEL * dt;
        vz -= hz * CAR_REVERSE_ACCEL * dt;
      }
    } else if (curSpeed > 0.05) {
      const decel = CAR_COAST / curSpeed;
      vx -= vx * decel * dt;
      vz -= vz * decel * dt;
    } else {
      vx = 0;
      vz = 0;
    }

    if (handbrake && curSpeed > 0.1) {
      const decel = CAR_HANDBRAKE_DECEL / curSpeed;
      vx -= vx * decel * dt;
      vz -= vz * decel * dt;
    }

    const speed2 = vx * vx + vz * vz;
    if (speed2 > 0.01) {
      const spd = Math.sqrt(speed2);
      vx *= Math.max(0, 1 - CAR_DRAG * spd * dt);
      vz *= Math.max(0, 1 - CAR_DRAG * spd * dt);
    }

    const maxSpd = THREE.MathUtils.lerp(CAR_MAX_SPEED, CAR_MAX_SPEED_BOOST, _boostBlend);
    const newSpeed = Math.hypot(vx, vz);
    if (newSpeed > maxSpd) {
      const s = maxSpd / newSpeed;
      vx *= s;
      vz *= s;
    }

    let steerInput = 0;
    if (leftKey) steerInput = 1;
    if (rightKey) steerInput = -1;
    if (steerInput !== 0 && curSpeed > 0.5) {
      heading += steerInput * (drifting ? CAR_TURN_RATE_DRIFT : CAR_TURN_RATE) * dt;
    }

    const rx = Math.cos(heading);
    const rz = -Math.sin(heading);
    const latDot = vx * rx + vz * rz;
    const fwdDot = vx * hx + vz * hz;
    let grip = CAR_GRIP_NORMAL;
    if (handbrake && curSpeed > CAR_DRIFT_ENTRY_SPEED && steerInput !== 0) grip = CAR_GRIP_DRIFT;
    else if (backward && steerInput !== 0 && curSpeed > 3) grip = CAR_GRIP_BRAKE_TURN;
    const lateralKill = 1 - Math.exp(-grip * dt);
    vx -= rx * latDot * lateralKill;
    vz -= rz * latDot * lateralKill;

    driftAngle = curSpeed > 1 ? Math.abs(Math.atan2(latDot, Math.abs(fwdDot))) : 0;
    drifting = driftAngle > CAR_DRIFT_ANGLE_MIN && curSpeed > CAR_DRIFT_ENTRY_SPEED;

    const latSign = Math.sign(latDot);
    const driftRollSpeedGain = THREE.MathUtils.smoothstep(curSpeed, 8, 24);
    bodyRoll = THREE.MathUtils.lerp(
      bodyRoll,
      -latSign * Math.min(CAR_BODY_ROLL_MAX, driftAngle * 0.85) * driftRollSpeedGain,
      1 - Math.exp(-10 * dt),
    );
    bodyPitch = THREE.MathUtils.lerp(bodyPitch, forward ? 0.055 : backward ? -0.08 : 0, 1 - Math.exp(-8 * dt));

    let stepX = vx * dt;
    let stepZ = vz * dt;
    const cliffBvh = getCliffBvh?.();
    if (cliffBvh?.baked && Math.hypot(stepX, stepZ) > 1e-4) {
      const resolved = physics.resolveMovement(
        pos.x, pos.z, stepX, stepZ, pos.y, heading, vx, vz, cliffBvh, CAR_MODEL_SCALE,
      );
      stepX = resolved.x - pos.x;
      stepZ = resolved.z - pos.z;
      vx = resolved.vx;
      vz = resolved.vz;
    }
    pos.x += stepX;
    pos.z += stepZ;

    const sf = CAR_MODEL_SCALE;
    _fillWheelXZ(pos, sf);
    physics.inAir = inAir;
    physics.velY = velY;
    const vert = physics.updateSuspension(
      pos.y,
      wheelWorldXZs,
      sf,
      heading,
      dt,
      sampleGroundY,
      cliffBvh,
      vx,
      vz,
      false,
      null,
    );
    pos.y = vert.y;
    velY = physics.velY;
    inAir = physics.inAir;
    onSteepSlope = physics.onSteepSlope;
    terrainPitchTarget = vert.terrainPitch;
    terrainRollTarget = vert.terrainRoll;
    if (vert.slideVx || vert.slideVz) {
      vx += vert.slideVx;
      vz += vert.slideVz;
    }

    wheelSpin -= (fwdDot / CAR_WHEEL_RADIUS) * dt;
  }

  function syncVisuals(dt, keys, visible, pos) {
    if (!carRoot) return;
    carRoot.visible = visible && loaded;
    if (!carRoot.visible) return;

    const sf = CAR_MODEL_SCALE;
    const rootY = pos.y + (CAR_RIDE_HEIGHT + CAR_WHEEL_RADIUS) * sf;
    carRoot.position.set(pos.x, rootY, pos.z);
    carRoot.rotation.y = heading;

    const terrainSmooth = 1 - Math.exp(-CAR_TERRAIN_BODY_SMOOTH * dt);
    if (inAir) {
      terrainPitch = THREE.MathUtils.lerp(terrainPitch, physics.airPitch, terrainSmooth);
      terrainRoll = THREE.MathUtils.lerp(terrainRoll, 0, terrainSmooth);
    } else {
      terrainPitch = THREE.MathUtils.lerp(terrainPitch, terrainPitchTarget, terrainSmooth);
      terrainRoll = THREE.MathUtils.lerp(terrainRoll, terrainRollTarget, terrainSmooth);
    }
    const finalPitch = THREE.MathUtils.clamp(
      terrainPitch + bodyPitch, -CAR_BODY_PITCH_MAX * 1.2, CAR_BODY_PITCH_MAX * 1.2,
    );
    const finalRoll = THREE.MathUtils.clamp(
      terrainRoll + bodyRoll, -CAR_BODY_ROLL_MAX, CAR_BODY_ROLL_MAX,
    );
    carChassis.rotation.set(finalPitch, 0, finalRoll);

    for (let i = 0; i < carWheels.length; i++) {
      const w = carWheels[i];
      const grounded = i < 4 && physics.wheelGrounded[i];
      let targetLocalY = -CAR_RIDE_HEIGHT;
      if (!inAir && grounded) {
        targetLocalY = -physics.wheelSuspLengths[i] / sf;
        targetLocalY = Math.min(targetLocalY, -CAR_RIDE_HEIGHT + CAR_SUSP_TRAVEL);
        targetLocalY = Math.max(targetLocalY, -CAR_RIDE_HEIGHT - CAR_SUSP_TRAVEL);
      }
      w._smoothLocalY += (targetLocalY - w._smoothLocalY) * Math.min(1, 25 * dt);
      w.container.position.set(w.offset.x, w._smoothLocalY, w.offset.z);
    }

    const steerTarget = (keys.a ? 0.4 : 0) + (keys.d ? -0.4 : 0);
    steerSmooth = THREE.MathUtils.lerp(steerSmooth, steerTarget, 1 - Math.exp(-12 * dt));
    for (const w of carWheels) {
      const baseYaw = CAR_MODEL_YAW + (w.isLeft ? Math.PI : 0);
      w.container.rotation.y = baseYaw + (w.steer ? steerSmooth : 0);
      if (w.cylinder) w.cylinder.rotation.z = (w.isLeft ? -1 : 1) * wheelSpin;
    }
  }

  function positionCamera(camera, pos, dt) {
    let chaseTarget = heading;
    if (drifting) {
      const rx = Math.cos(heading);
      const rz = -Math.sin(heading);
      const latSign = Math.sign(vx * rx + vz * rz);
      chaseTarget += latSign * driftAngle * CAR_CAM_DRIFT_LAG;
    }
    let camDelta = chaseTarget - camYaw;
    while (camDelta > Math.PI) camDelta -= 2 * Math.PI;
    while (camDelta < -Math.PI) camDelta += 2 * Math.PI;
    camYaw += camDelta * (1 - Math.exp(-CAR_CAM_CHASE_SPEED * dt));

    const lookY = pos.y + 1.0;
    camera.position.set(
      pos.x + Math.sin(camYaw) * CAR_CAM_DIST,
      lookY + CAR_CAM_HEIGHT,
      pos.z + Math.cos(camYaw) * CAR_CAM_DIST,
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(pos.x, lookY, pos.z);
  }

  function getSpeed() {
    return Math.hypot(vx, vz);
  }

  return {
    get loaded() { return loaded; },
    get heading() { return heading; },
    get grounded() { return !inAir; },
    getSpeed,
    resetFrom,
    update,
    syncVisuals,
    positionCamera,
    hide() {
      if (carRoot) carRoot.visible = false;
    },
  };
}
