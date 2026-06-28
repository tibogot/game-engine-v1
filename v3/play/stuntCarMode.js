import * as THREE from "three";
import { Vehicle } from "../../v2/play/modularRoadVehicle.js";
import { createVehicleGround } from "../../v2/play/modularRoadGround.js";
import { RoadBvh } from "../../v2/play/modularRoadBvh.js";

const STUNT_CAM = {
  fov: 60,
  dist: 7.5,
  height: 3.2,
  lookAhead: 5.5,
  lookUp: 1.2,
  minSpeed: 3.0,
  maxLookPitch: 0.85,
  headingLerp: 4.0,
  lookLerp: 5.0,
  posLerp: 7.0,
};

const _fwd = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _tgtH = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _axisY = new THREE.Vector3(0, 1, 0);

/** Stunt rigid-body car — v2 modular-road Vehicle + terrain ground adapter. */
export function createStuntCarMode({
  scene,
  camera,
  sampleGroundY,
  getCliffBvh,
  getTreeBvh,
  getStuntRoadMeshes = () => [],
  getStuntRoadSolidMeshes = () => [],
}) {
  const vehicle = new Vehicle({ scene, showArrows: false });
  vehicle.getFloorY = (x, z) => sampleGroundY(x, z);

  const ground = createVehicleGround({
    getTerrainHeight: sampleGroundY,
    cliffBvh: getCliffBvh?.(),
    treeBvh: getTreeBvh?.(),
  });

  let roadBvh = null;
  let roadSolidsBvh = null;
  let camHeading = new THREE.Vector3(0, 0, 1);
  let camLookDir = new THREE.Vector3(0, 0, 1);
  let camInit = false;
  let heading = 0;
  let vx = 0;
  let vz = 0;

  function bakeRoadBvhs() {
    scene.updateMatrixWorld(true);
    const meshes = (getStuntRoadMeshes() || []).filter((m) => m?.geometry);
    if (meshes.length) {
      if (!roadBvh) roadBvh = new RoadBvh();
      roadBvh.bakeFromMeshes(meshes);
      ground.setRoadBvh(roadBvh.baked ? roadBvh : null);
    } else {
      ground.setRoadBvh(null);
    }
    const solids = (getStuntRoadSolidMeshes() || []).filter((m) => m?.geometry);
    if (solids.length) {
      if (!roadSolidsBvh) roadSolidsBvh = new RoadBvh();
      roadSolidsBvh.bakeFromMeshes(solids);
      ground.setRoadSolidsBvh(roadSolidsBvh.baked ? roadSolidsBvh : null);
    } else {
      ground.setRoadSolidsBvh(null);
    }
  }

  function resetFrom(x, y, z, yaw) {
    bakeRoadBvhs();
    const gy = sampleGroundY(x, z);
    const spawnY = gy + 1.0;
    const sq = new THREE.Quaternion().setFromAxisAngle(_axisY, yaw + Math.PI);
    vehicle.setSpawn(new THREE.Vector3(x, spawnY, z), sq);
    vehicle.respawn();
    vehicle.enabled = true;
    camInit = false;
    heading = yaw;
    vx = 0;
    vz = 0;
    return { x, y: spawnY, z };
  }

  function update(dt, keys, pos) {
    ground.setCliffBvh(getCliffBvh?.());
    const treeBvh = getTreeBvh?.();
    if (treeBvh) treeBvh.ensureBaked?.();
    ground.setTreeBvh(treeBvh);
    vehicle.setBvh(ground.ground, ground.solids);

    const controls = {
      steerTarget: (keys.a ? 1 : 0) - (keys.d ? 1 : 0),
      throttle: (keys.w ? 1 : 0) - (keys.s ? 1 : 0),
      handbrake: !!keys.space,
      yaw: (keys.e ? 1 : 0) - (keys.q ? 1 : 0),
    };
    vehicle.update(dt, controls);

    const b = vehicle.body;
    pos.x = b.pos.x;
    pos.y = b.pos.y;
    pos.z = b.pos.z;
    vx = b.vel.x;
    vz = b.vel.z;

    _fwd.set(0, 0, 1).applyQuaternion(b.quat);
    let h = Math.atan2(_fwd.x, _fwd.z) - Math.PI;
    while (h > Math.PI) h -= 2 * Math.PI;
    while (h < -Math.PI) h += 2 * Math.PI;
    heading = h;
  }

  function positionCamera(dt) {
    const C = STUNT_CAM;
    const pos = vehicle.body.pos;
    _vel.copy(vehicle.body.vel);
    const speed = _vel.length();
    const grounded = vehicle.groundedCount > 0;
    _fwd.set(0, 0, 1).applyQuaternion(vehicle.body.quat);
    const reversing = grounded && _vel.dot(_fwd) < -0.5;

    if (speed > C.minSpeed && !reversing) _vel.multiplyScalar(1 / speed);
    else _vel.copy(_fwd);

    const hSpeed = Math.hypot(vehicle.body.vel.x, vehicle.body.vel.z);
    if (hSpeed > C.minSpeed && !reversing) {
      _tgtH.set(vehicle.body.vel.x, 0, vehicle.body.vel.z).multiplyScalar(1 / hSpeed);
    } else if (grounded) {
      _tgtH.set(_fwd.x, 0, _fwd.z);
      if (_tgtH.lengthSq() > 1e-6) _tgtH.normalize();
      else _tgtH.copy(camHeading);
    } else {
      _tgtH.copy(camHeading);
    }

    if (!camInit) {
      camHeading.copy(_tgtH);
      camLookDir.copy(_vel);
      camInit = true;
    }

    const kh = 1 - Math.exp(-C.headingLerp * dt);
    camHeading.lerp(_tgtH, kh).normalize();
    const kl = 1 - Math.exp(-C.lookLerp * dt);
    camLookDir.lerp(_vel, kl);
    if (camLookDir.y > C.maxLookPitch) camLookDir.y = C.maxLookPitch;
    else if (camLookDir.y < -C.maxLookPitch) camLookDir.y = -C.maxLookPitch;
    camLookDir.normalize();

    _desired.copy(pos)
      .addScaledVector(camHeading, -C.dist)
      .addScaledVector(_worldUp, C.height);
    const kp = 1 - Math.exp(-C.posLerp * dt);
    camera.position.lerp(_desired, kp);
    _look.copy(pos).addScaledVector(camLookDir, C.lookAhead);
    _look.y += C.lookUp;
    camera.up.set(0, 1, 0);
    camera.lookAt(_look);
  }

  function syncVisuals(visible) {
    if (vehicle.group) vehicle.group.visible = visible;
    if (!visible) vehicle.enabled = false;
    else if (visible) vehicle.enabled = true;
  }

  return {
    get loaded() { return true; },
    get heading() { return heading; },
    get grounded() { return vehicle.groundedCount > 0; },
    getSpeed() { return Math.hypot(vx, vz); },
    resetFrom,
    update,
    positionCamera,
    syncVisuals,
    hide() {
      vehicle.enabled = false;
      if (vehicle.group) vehicle.group.visible = false;
    },
    rebakeRoad: bakeRoadBvhs,
  };
}
