/**
 * Rapier DynamicRayCastVehicleController wrapper for the Lotus parkour sandbox.
 *
 * Drive model follows folio-2025 PhysicsVehicle (+X forward, axle +Z, all-wheel drive).
 * @see folio-2025-main/sources/Game/Physics/PhysicsVehicle.js
 */
import * as THREE from "three";

export const DEFAULT_RAPIER_DRIVE = {
  /** Per-wheel engine force (Rapier raycast units; folio uses ~300×dt on a ~10 kg car). */
  engineForceAmplitude: 3200,
  boostMultiplier: 1.85,
  /** Reverse uses same FWD axle as three.js example, at lower force to limit pitch. */
  reverseForceScale: 0.5,
  /** Extra yaw torque when throttle + steer (arcade, like BVH lotusPhysics). */
  arcadeYawAssist: 360,
  pitchDamping: 0.88,
  brakeAmplitude: 42,
  idleBrake: 0.06,
  reverseBrake: 0.45,
  handbrakeBrake: 0.95,
  maxSpeed: 58,
  maxSpeedBoost: 88,
  steerAngle: 0.42,
  handbrakeFriction: 0.35,
  frictionSlip: 1.4,
  sideFrictionStiffness: 2.8,
  suspensionStiffness: 38,
  suspensionCompression: 10,
  suspensionRelaxation: 2.7,
  maxSuspensionTravel: 0.28,
  maxSuspensionForce: 8500,
  chassisMass: 420,
  wheelRadius: 0.34,
  suspensionRestLength: 0.14,
  linearDamping: 0.02,
  angularDamping: 0.35,
  /** Folio places COM well below the collider ({ y: -0.5 } on a low body box). */
  comOffsetY: -0.38,
  /** Visual-only GLB lift above wheel hubs (metres). */
  chassisVisualLift: 0.11,
};

/** Match rest length + spawn to GLB hub height so the body sits on the wheels. */
export function deriveSuspensionFromGeometry(hubLocalY, wheelRadius, meshMinY = 0) {
  const ride = Math.max(0.05, hubLocalY - meshMinY);
  const rest = THREE.MathUtils.clamp(ride - wheelRadius * 0.92, 0.06, 0.2);
  return {
    suspensionRestLength: rest,
    maxSuspensionTravel: THREE.MathUtils.clamp(ride * 0.45, 0.18, 0.32),
  };
}

function setVehicleForwardAxis(controller, axis) {
  controller.setIndexForwardAxis = axis;
}

/** Lotus / folio layout: +X forward (FL/FR at +X). Default Rapier axis is Z. */
const CHASSIS_FORWARD_AXIS = 0;

/** three.js Rapier example + folio: engine on steered front wheels (0,1) for turn-under-throttle. */
const STEER_WHEELS = [0, 1];
const DRIVE_WHEELS = [0, 1];
const _forward = new THREE.Vector3();

/**
 * @param {object} RAPIER
 * @param {import("@dimforge/rapier3d").World} world
 * @param {{
 *   wheelConnections: THREE.Vector3[],
 *   chassisCenter?: THREE.Vector3,
 *   chassisHalfExtents: THREE.Vector3,
 *   params?: Partial<typeof DEFAULT_RAPIER_DRIVE>,
 * }} config
 */
export function createRapierLotusVehicle(RAPIER, world, config) {
  const params = { ...DEFAULT_RAPIER_DRIVE, ...config.params };
  const wheelConnections = config.wheelConnections;
  const chassisCenter = config.chassisCenter ?? new THREE.Vector3();
  const half = config.chassisHalfExtents;

  const chassisBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setCanSleep(false)
      .setLinearDamping(params.linearDamping)
      .setAngularDamping(params.angularDamping),
  );

  const com = {
    x: chassisCenter.x,
    y: chassisCenter.y + params.comOffsetY,
    z: chassisCenter.z,
  };
  const inertia = {
    x: (params.chassisMass / 3) * (half.y * half.y + half.z * half.z),
    y: (params.chassisMass / 3) * (half.x * half.x + half.z * half.z),
    z: (params.chassisMass / 3) * (half.x * half.x + half.y * half.y),
  };

  const chassisCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(chassisCenter.x, chassisCenter.y, chassisCenter.z)
      .setMassProperties(params.chassisMass, com, inertia, { w: 1, x: 0, y: 0, z: 0 })
      .setFriction(0.4),
    chassisBody,
  );

  const filterFlags = RAPIER.QueryFilterFlags?.EXCLUDE_SENSORS;
  function wheelRayFilter(collider) {
    return collider.parent()?.handle !== chassisBody.handle;
  }

  const controller = world.createVehicleController(chassisBody);
  controller.indexUpAxis = 1;
  setVehicleForwardAxis(controller, CHASSIS_FORWARD_AXIS);

  const suspensionDir = { x: 0, y: -1, z: 0 };
  const axleCs = { x: 0, y: 0, z: 1 };

  for (let i = 0; i < wheelConnections.length; i++) {
    const c = wheelConnections[i];
    const conn = { x: c.x, y: c.y, z: c.z };
    controller.addWheel(
      conn,
      suspensionDir,
      axleCs,
      params.suspensionRestLength,
      params.wheelRadius,
    );
    controller.setWheelDirectionCs(i, suspensionDir);
    controller.setWheelAxleCs(i, axleCs);
    controller.setWheelSuspensionStiffness(i, params.suspensionStiffness);
    controller.setWheelSuspensionCompression(i, params.suspensionCompression);
    controller.setWheelSuspensionRelaxation(i, params.suspensionRelaxation);
    controller.setWheelMaxSuspensionTravel(i, params.maxSuspensionTravel);
    controller.setWheelMaxSuspensionForce(i, params.maxSuspensionForce);
    controller.setWheelFrictionSlip(i, params.frictionSlip);
    controller.setWheelSideFrictionStiffness(i, params.sideFrictionStiffness);
  }

  let boostBlend = 0;
  let steerVisual = 0;
  /** Updated each frame in readState — used next stepPrePhysics (folio pattern). */
  let motionSpeed = 0;
  let goingForward = true;

  function updateVehicleStep(dtSec) {
    controller.updateVehicle(Math.min(dtSec, 1 / 60), filterFlags, undefined, wheelRayFilter);
  }

  /** BVH scene: yaw 0 → drive world -Z; chassis +X is forward. */
  function setSpawn(x, y, z, headingY) {
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, headingY + Math.PI * 0.5, 0, "YXZ"),
    );
    chassisBody.setTranslation({ x, y, z }, true);
    chassisBody.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    motionSpeed = 0;
    goingForward = true;
    controller.updateVehicle(1 / 60, filterFlags, undefined, wheelRayFilter);
  }

  function stepPrePhysics(dtSec, input) {
    boostBlend += ((input.boost ? 1 : 0) - boostBlend) * Math.min(1, 12 * dtSec);

    const topSpeed = THREE.MathUtils.lerp(
      params.maxSpeed,
      params.maxSpeedBoost,
      boostBlend,
    );
    const overflow = Math.max(0, motionSpeed - topSpeed);

    let accelerating = 0;
    if (input.forward) accelerating = 1;
    else if (input.backward) accelerating = -1;

    let engineForce =
      (accelerating *
        (1 + (input.boost ? boostBlend * params.boostMultiplier : 0)) *
        params.engineForceAmplitude) /
      (1 + overflow * 0.08);

    let brake = input.handbrake ? params.handbrakeBrake : 0;
    if (!input.handbrake && accelerating === 0 && motionSpeed > 0.25) {
      brake = params.idleBrake;
    }

    if (
      motionSpeed > 0.5 &&
      ((accelerating > 0 && !goingForward) || (accelerating < 0 && goingForward))
    ) {
      brake = params.reverseBrake;
      engineForce = 0;
    }

    brake *= params.brakeAmplitude * dtSec;

    const steerSpeedScale = THREE.MathUtils.clamp(
      1.05 - motionSpeed / (topSpeed * 1.4),
      0.55,
      1.05,
    );
    const steerT = input.steer * params.steerAngle * steerSpeedScale;
    steerVisual += (steerT - steerVisual) * Math.min(1, 14 * dtSec);
    for (const i of STEER_WHEELS) {
      controller.setWheelSteering(i, steerVisual);
    }

    const slip = input.handbrake ? params.handbrakeFriction : params.frictionSlip;
    const driveSet = new Set(DRIVE_WHEELS);
    const reverseScale = accelerating < 0 ? params.reverseForceScale : 1;

    for (let i = 0; i < wheelConnections.length; i++) {
      const wheelEngine = driveSet.has(i) ? engineForce * reverseScale : 0;
      controller.setWheelEngineForce(i, wheelEngine);
      controller.setWheelBrake(i, brake);
      controller.setWheelFrictionSlip(i, slip);
    }

    updateVehicleStep(dtSec);
  }

  /** Ground pitch/roll damp + arcade yaw when throttle + steer. */
  function stepPostPhysics(dtSec, input) {
    const grounded = countGroundedWheels();
    if (grounded < 2) return;

    const av = chassisBody.angvel();
    const damp = Math.min(1, 14 * dtSec) * params.pitchDamping;
    chassisBody.setAngvel(
      {
        x: av.x * (1 - damp),
        y: av.y,
        z: av.z * (1 - damp),
      },
      true,
    );

    const throttle = !!(input?.forward || input?.backward);
    const steer = input?.steer ?? 0;
    if (Math.abs(steer) > 0.04 && throttle && motionSpeed > 0.55) {
      const speedFactor = THREE.MathUtils.clamp(motionSpeed / 14, 0.35, 1.15);
      const sign = input.backward && !input.forward ? -1 : 1;
      chassisBody.applyTorqueImpulse(
        { x: 0, y: sign * steer * params.arcadeYawAssist * speedFactor * dtSec, z: 0 },
        true,
      );
    }
  }

  function readState(out) {
    const t = chassisBody.translation();
    const r = chassisBody.rotation();
    const lv = chassisBody.linvel();
    out.pos.set(t.x, t.y, t.z);
    out.quat.set(r.x, r.y, r.z, r.w);
    out.vel.set(lv.x, lv.y, lv.z);
    out.speed = Math.hypot(lv.x, lv.z);
    out.grounded = countGroundedWheels() >= 2;
    out.steerVisual = steerVisual;
    out.boostBlend = boostBlend;

    motionSpeed = Math.hypot(lv.x, lv.y, lv.z);
    _forward.set(1, 0, 0).applyQuaternion(out.quat);
    if (motionSpeed > 0.35) {
      goingForward = out.vel.dot(_forward) / motionSpeed > 0.5;
    }

    return out;
  }

  function countGroundedWheels() {
    let n = 0;
    for (let i = 0; i < wheelConnections.length; i++) {
      if (controller.wheelIsInContact(i)) n++;
    }
    return n;
  }

  function syncWheelVisuals(carWheels, carModelYaw, dtSec) {
    for (let i = 0; i < carWheels.length; i++) {
      const w = carWheels[i];
      const conn = controller.wheelChassisConnectionPointCs(i);
      const rest = controller.wheelSuspensionRestLength(i) ?? params.suspensionRestLength;
      const susp = controller.wheelSuspensionLength(i);
      const hubY = conn?.y ?? wheelConnections[i].y;
      const hubX = conn?.x ?? wheelConnections[i].x;
      const hubZ = conn?.z ?? wheelConnections[i].z;
      const targetY = hubY - (susp ?? rest);

      if (w._smoothLocalY === undefined) w._smoothLocalY = targetY;
      w._smoothLocalY += (targetY - w._smoothLocalY) * Math.min(1, 32 * dtSec);
      w.container.position.set(hubX, w._smoothLocalY, hubZ);

      w.container.rotation.set(
        0,
        carModelYaw + (w.isLeft ? 0 : Math.PI) + (w.steer ? steerVisual : 0),
        0,
      );
      if (w.cylinder) {
        const spin = controller.wheelRotation(i) ?? 0;
        w.cylinder.rotation.x = spin * (w.isLeft ? 1 : -1);
        w.cylinder.rotation.z = 0;
      }
    }
  }

  return {
    params,
    chassisBody,
    chassisCollider,
    controller,
    wheelConnections,
    setSpawn,
    stepPrePhysics,
    stepPostPhysics,
    readState,
    syncWheelVisuals,
    countGroundedWheels,
  };
}

/** Body Y so wheel bottoms sit on floorY when level. */
export function computeRapierSpawnY(floorY, hubLocalY, params) {
  return (
    floorY -
    hubLocalY +
    params.suspensionRestLength +
    params.wheelRadius +
    0.008
  );
}
