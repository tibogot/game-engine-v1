import * as THREE from "three";
import { Vehicle, FIXED_DT } from "./modularRoadVehicle.js";
import { createVehicleGround } from "./modularRoadGround.js";
import { RoadBvh } from "./modularRoadBvh.js";

/**
 * GAME CAR — the modular-road game's own car in the editor's play mode.
 *
 * The stunt car (stuntCarMode.js) drives the v2 COPY of the vehicle, which has
 * not followed the game's car (kerbs, contact impulse, road hold, crash). This
 * mode drives the v3 copy the game itself imports (games/modular-road-v3/
 * roadGame.js), stepped the way the game steps it: fixed 1/120 s ticks from an
 * accumulator, then one interpolated syncVisuals per frame. So what a road
 * feels like here — its width, its kerbs, its islands — is what it feels like
 * in the game.
 *
 * Collision is the same contract as the stunt car: road decks for the wheels,
 * road solids for the chassis (getStuntRoadMeshes / getStuntRoadSolidMeshes),
 * plus the terrain, cliffs and trees. Same interface as createStuntCarMode, so
 * playMode treats the two alike.
 */

const CAM = {
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

const WHEEL_RUT_RADIUS = 0.3;
const WHEEL_RUT_STEP = 0.18;
/** Longest frame the accumulator catches up on (a tab switch must not run 2 s of physics). */
const MAX_FRAME = 0.1;

export function createGameCarMode({
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
  vehicle.group.visible = false;

  const ground = createVehicleGround({
    getTerrainHeight: sampleGroundY,
    cliffBvh: getCliffBvh?.(),
    treeBvh: getTreeBvh?.(),
  });

  const roadBvh = new RoadBvh();
  const roadSolidsBvh = new RoadBvh();
  let accum = 0;
  let camHeading = new THREE.Vector3(0, 0, 1);
  let camLookDir = new THREE.Vector3(0, 0, 1);
  let camInit = false;
  let heading = 0;

  function bakeRoadBvhs() {
    scene.updateMatrixWorld(true);
    const decks = (getStuntRoadMeshes() || []).filter((m) => m?.geometry);
    ground.setRoadBvh(decks.length && roadBvh.bakeFromMeshes(decks) !== false && roadBvh.baked ? roadBvh : null);
    const solids = (getStuntRoadSolidMeshes() || []).filter((m) => m?.geometry);
    ground.setRoadSolidsBvh(solids.length && roadSolidsBvh.bakeFromMeshes(solids) !== false && roadSolidsBvh.baked ? roadSolidsBvh : null);
  }

  function resetFrom(x, y, z, yaw) {
    bakeRoadBvhs();
    const gy = sampleGroundY(x, z);
    const spawnY = (Number.isFinite(gy) ? gy : y) + 1.0;
    const q = new THREE.Quaternion().setFromAxisAngle(_axisY, yaw + Math.PI);
    vehicle.setSpawn(new THREE.Vector3(x, spawnY, z), q);
    vehicle.respawn();
    vehicle.enabled = true;
    accum = 0;
    camInit = false;
    heading = yaw;
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
      rollTarget: 0,
      throttle: (keys.w ? 1 : 0) - (keys.s ? 1 : 0),
      handbrake: !!keys.space,
      yaw: (keys.e ? 1 : 0) - (keys.q ? 1 : 0),
    };
    accum += Math.min(dt, MAX_FRAME);
    while (accum >= FIXED_DT) {
      vehicle.tick(controls);
      accum -= FIXED_DT;
    }
    vehicle.syncVisuals(dt, accum / FIXED_DT);

    const b = vehicle.body;
    pos.x = b.pos.x;
    pos.y = b.pos.y;
    pos.z = b.pos.z;

    _fwd.set(0, 0, 1).applyQuaternion(b.quat);
    let h = Math.atan2(_fwd.x, _fwd.z) - Math.PI;
    while (h > Math.PI) h -= 2 * Math.PI;
    while (h < -Math.PI) h += 2 * Math.PI;
    heading = h;
  }

  function positionCamera(dt) {
    const C = CAM;
    // The drawn car is interpolated between ticks; follow it, not the body.
    const pos = vehicle.group.position;
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

    camHeading.lerp(_tgtH, 1 - Math.exp(-C.headingLerp * dt)).normalize();
    camLookDir.lerp(_vel, 1 - Math.exp(-C.lookLerp * dt));
    camLookDir.y = Math.max(-C.maxLookPitch, Math.min(C.maxLookPitch, camLookDir.y));
    camLookDir.normalize();

    _desired.copy(pos).addScaledVector(camHeading, -C.dist).addScaledVector(_worldUp, C.height);
    camera.position.lerp(_desired, 1 - Math.exp(-C.posLerp * dt));
    _look.copy(pos).addScaledVector(camLookDir, C.lookAhead);
    _look.y += C.lookUp;
    camera.up.set(0, 1, 0);
    camera.lookAt(_look);
  }

  function syncVisuals(visible) {
    vehicle.group.visible = visible;
    vehicle.enabled = visible;
  }

  const _wheelXZs = new Float32Array(8);
  const _wheelTouch = new Float32Array(4);
  function getSnowContacts() {
    const tires = vehicle.tires;
    if (!tires?.length) return null;
    const n = Math.min(4, tires.length);
    for (let i = 0; i < n; i++) {
      _wheelXZs[i * 2] = tires[i].worldPos.x;
      _wheelXZs[i * 2 + 1] = tires[i].worldPos.z;
      _wheelTouch[i] = tires[i].grounded ? 1 : 0;
    }
    for (let i = n; i < 4; i++) _wheelTouch[i] = 0;
    return { xzs: _wheelXZs, touching: _wheelTouch, isVehicle: true, radius: WHEEL_RUT_RADIUS, step: WHEEL_RUT_STEP };
  }

  return {
    get loaded() { return true; },
    get heading() { return heading; },
    get grounded() { return vehicle.groundedCount > 0; },
    getSpeed() { return Math.hypot(vehicle.body.vel.x, vehicle.body.vel.z); },
    getSnowContacts,
    resetFrom,
    update,
    positionCamera,
    syncVisuals,
    hide() {
      vehicle.enabled = false;
      vehicle.group.visible = false;
    },
    rebakeRoad: bakeRoadBvhs,
    /** The Vehicle itself, for probes and tuning panels. */
    vehicle,
  };
}
