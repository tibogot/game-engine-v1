// DRIVING THE OFF-ROAD TRUCK in a loaded level: the procedural truck
// (offroadTruck.js) on the physics (offroadVehicle.js) in the world built from
// the level (offroadWorld.js), stepped at a fixed 1/120 s from the engine's
// pre-update hook, with keyboard input and a chase camera.
//
// Keys (by e.key, so AZERTY's ZQSD works as well as WASD and the arrows):
//   Z/W/↑ throttle · S/↓ brake, then reverse · Q/A/← D/→ steer · Space handbrake
//   G high/low range · X diff locks · R back on the wheels · Enter drive on/off
import * as THREE from "three";
import { buildOffroadTruck } from "./offroadTruck.js";
import { OffroadVehicle, FIXED_DT } from "./offroadVehicle.js";
import { createOffroadWorld } from "./offroadWorld.js";

const KEYS = {
  fwd: ["z", "w", "arrowup"],
  back: ["s", "arrowdown"],
  left: ["q", "a", "arrowleft"],
  right: ["d", "arrowright"],
  handbrake: [" "],
};
const CAM = { dist: 9, height: 3.6, lookAhead: 2.5, lookUp: 1.3, posRate: 4, minAboveGround: 1.4 };

/**
 * @param {object} app the engine handle, level loaded
 * @param {object} o
 * @param {{x:number,z:number,yaw:number}} o.spawn
 * @param {{mu:number,roll:number}[]} [o.surfaces] grip per paint slot
 * @param {object} [o.truck] overrides for buildOffroadTruck
 * @param {object} [o.physics] overrides for OFFROAD_DEFAULTS
 * @param {(state:object)=>void} [o.onStatus] ~10×/s while driving
 */
export function createOffroadDrive(app, { spawn, surfaces, truck: truckOpts = {}, physics = {}, onStatus = null } = {}) {
  const world = createOffroadWorld(app, { surfaces });
  const truck = buildOffroadTruck(truckOpts);
  app.scene.add(truck.root);
  const vehicle = new OffroadVehicle({ ground: world.ground, solids: world.solids, getFloorY: world.getFloorY, getSurface: world.getSurface, config: physics });
  vehicle.spawn(spawn.x, spawn.z, spawn.yaw ?? 0);

  const down = new Set();
  let active = false, acc = 0, statusT = 0;
  const camPos = new THREE.Vector3(), camInit = { done: false };
  const _fwd = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3();
  const held = (list) => list.some((k) => down.has(k));

  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (e.type === "keydown") {
      if (k === "enter") { setActive(!active); e.preventDefault(); return; }
      if (!active) return;
      down.add(k);
      if (k === "g") vehicle.cfg.drivetrain.lowRange = !vehicle.cfg.drivetrain.lowRange;
      if (k === "x") vehicle.cfg.drivetrain.diffLock = !vehicle.cfg.drivetrain.diffLock;
      if (k === "r") vehicle.resetUpright();
      if (k === " " || k.startsWith("arrow")) e.preventDefault();
      e.stopImmediatePropagation();       // the lab's own hotkeys stay quiet while driving
    } else down.delete(k);
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("blur", () => down.clear());

  function setActive(on) {
    active = on;
    down.clear();
    camInit.done = false;
    app.controls.enableDamping = !on;
  }

  function status() {
    return {
      active,
      speedKmh: vehicle.speed * 3.6,
      lowRange: !!vehicle.cfg.drivetrain.lowRange,
      diffLock: !!vehicle.cfg.drivetrain.diffLock,
      wheelsDown: vehicle.groundedCount,
    };
  }

  const hook = (dt) => {
    const controls = active
      ? {
          throttle: (held(KEYS.fwd) ? 1 : 0) - (held(KEYS.back) ? 1 : 0),
          steer: (held(KEYS.left) ? 1 : 0) - (held(KEYS.right) ? 1 : 0),
          handbrake: held(KEYS.handbrake),
          brake: 0,
        }
      : { throttle: 0, steer: 0, handbrake: false, brake: 0 };
    acc += Math.min(Math.max(dt, 0), 0.1);
    while (acc >= FIXED_DT) { vehicle.tick(controls); acc -= FIXED_DT; }
    vehicle.interpolate(acc / FIXED_DT);
    vehicle.syncVisuals(truck);
    if (!Number.isFinite(vehicle.body.pos.y) || vehicle.body.pos.y < -50) vehicle.spawn(spawn.x, spawn.z, spawn.yaw ?? 0);

    if (active) {
      // Chase camera: behind along the HORIZONTAL heading, eased, never in the ground.
      _fwd.set(0, 0, 1).applyQuaternion(vehicle.renderQuat);
      _fwd.y = 0;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
      _fwd.normalize();
      const p = vehicle.renderPos;
      _d.copy(p).addScaledVector(_fwd, -CAM.dist);
      _d.y = p.y + CAM.height;
      const g = app.getWorldHeight(_d.x, _d.z);
      if (Number.isFinite(g)) _d.y = Math.max(_d.y, g + CAM.minAboveGround);
      if (!camInit.done) { camPos.copy(_d); camInit.done = true; }
      else camPos.lerp(_d, 1 - Math.exp(-CAM.posRate * dt));
      _t.copy(p).addScaledVector(_fwd, CAM.lookAhead);
      _t.y += CAM.lookUp;
      app.camera.position.copy(camPos);
      app.controls.target.copy(_t);
      statusT += dt;
      if (onStatus && statusT > 0.1) { statusT = 0; onStatus(status()); }
    }
  };
  app.addPreUpdateHook(hook);

  return {
    vehicle, truck, world,
    get active() { return active; },
    setActive,
    status,
    dispose() {
      app.removePreUpdateHook(hook);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      app.scene.remove(truck.root);
    },
  };
}
