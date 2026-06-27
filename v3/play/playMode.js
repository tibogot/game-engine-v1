import * as THREE from "three";
import { CapsuleController } from "./capsuleController.js";
import { WORLD_SIZE } from "../terrain/heightmapTexture.js";

const MOUSE_SENSITIVITY = 0.003;
const CAM_DIST          = 8;
const CAM_PITCH_DEFAULT = 0.42;
const CAM_PITCH_MIN     = 0.06;
const CAM_PITCH_MAX     = 1.3;

// Snap LOD center to the heightmap texel size (2048m / 128 = 16m) to prevent
// distant LOD rings from morphing as the player walks through sub-texel positions.
export const LOD_SNAP = 16;

export function createPlayMode({
  renderer, camera, controls,
  sampleTerrainHeight, uCursorUV,
  capsuleMesh,
  onEnterMenu, onStartWalking, onExit,
}) {
  let active  = false; // true when in play mode (menu OR walking)
  let walking = false; // true only while pointer is locked

  const capsule = new CapsuleController({ walkSpeed: 6, runSpeed: 14, jumpVel: 9, gravity: 20 });

  let savedCamPos   = null;
  let savedCamQuat  = null;
  let savedTarget   = null;
  let savedCamOrder = "XYZ";

  let camYaw   = 0;
  let camPitch = CAM_PITCH_DEFAULT;

  const keys   = { w: false, a: false, s: false, d: false, space: false, shift: false };
  const _lookAt = new THREE.Vector3();

  function getTerrainHeight(wx, wz) {
    const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
    const v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    return sampleTerrainHeight(u, v);
  }

  function positionCamera() {
    const chestY = capsule.position.y + 1.2;
    const cosP   = Math.cos(camPitch);
    const sinP   = Math.sin(camPitch);

    camera.position.set(
      capsule.position.x + Math.sin(camYaw) * CAM_DIST * cosP,
      chestY              + CAM_DIST * sinP,
      capsule.position.z + Math.cos(camYaw) * CAM_DIST * cosP,
    );
    _lookAt.set(capsule.position.x, chestY, capsule.position.z);
    camera.lookAt(_lookAt);

    if (capsuleMesh) {
      // Physics capsule: position.y = feet, total visual centre = feet + r + halfH
      const cy = capsule.position.y + capsule.params.capRadius + capsule.params.capHeight / 2;
      capsuleMesh.position.set(capsule.position.x, cy, capsule.position.z);
      capsuleMesh.rotation.y = capsule.yaw;
    }
  }

  // ── Keyboard (only active while walking, not while menu is showing) ──────────
  function onKeyDown(e) {
    if (!walking) return;
    switch (e.code) {
      case "KeyW": case "ArrowUp":             keys.w     = true; break;
      case "KeyS": case "ArrowDown":           keys.s     = true; break;
      case "KeyA": case "ArrowLeft":           keys.a     = true; break;
      case "KeyD": case "ArrowRight":          keys.d     = true; break;
      case "Space": e.preventDefault();        keys.space = true; break;
      case "ShiftLeft": case "ShiftRight":     keys.shift = true; break;
    }
  }
  function onKeyUp(e) {
    switch (e.code) {
      case "KeyW": case "ArrowUp":             keys.w     = false; break;
      case "KeyS": case "ArrowDown":           keys.s     = false; break;
      case "KeyA": case "ArrowLeft":           keys.a     = false; break;
      case "KeyD": case "ArrowRight":          keys.d     = false; break;
      case "Space":                            keys.space = false; break;
      case "ShiftLeft": case "ShiftRight":     keys.shift = false; break;
    }
  }
  function onMouseMove(e) {
    if (!walking) return;
    camYaw   += e.movementX * MOUSE_SENSITIVITY;
    camPitch -= e.movementY * MOUSE_SENSITIVITY;
    camPitch  = Math.max(CAM_PITCH_MIN, Math.min(CAM_PITCH_MAX, camPitch));
  }

  function onPointerLockChange() {
    const locked = document.pointerLockElement === renderer.domElement;
    if (locked && active && !walking) {
      walking = true;
      onStartWalking?.();
    }
    if (!locked && walking) {
      // Escape during walking → back to menu state, NOT a full exit.
      walking = false;
      Object.keys(keys).forEach(k => (keys[k] = false));
      onEnterMenu?.(); // show the menu card again
    }
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup",   onKeyUp);
  renderer.domElement.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);

  // ── Public API ───────────────────────────────────────────────────────────────

  function enter() {
    if (active) return;
    active  = true;
    walking = false;

    savedCamPos   = camera.position.clone();
    savedCamQuat  = camera.quaternion.clone();
    savedTarget   = controls.target.clone();
    savedCamOrder = camera.rotation.order;

    // Derive initial yaw from the orbit camera's horizontal offset from target.
    const dx = camera.position.x - controls.target.x;
    const dz = camera.position.z - controls.target.z;
    camYaw   = Math.atan2(dx, dz);
    camPitch = CAM_PITCH_DEFAULT;

    controls.enabled = false;
    uCursorUV.value.set(-2, -2);

    const tx = controls.target.x;
    const tz = controls.target.z;
    capsule.reset(tx, getTerrainHeight(tx, tz), tz);

    if (capsuleMesh) capsuleMesh.visible = true;
    positionCamera();

    onEnterMenu?.();
  }

  function startWalking() {
    if (!active || walking) return;
    try { renderer.domElement.requestPointerLock(); } catch (_) {}
    // walking = true is set in onPointerLockChange once the lock is confirmed.
  }

  function exit() {
    if (!active) return;
    active  = false;
    walking = false;

    if (document.pointerLockElement) document.exitPointerLock();

    camera.rotation.order = savedCamOrder;
    camera.position.copy(savedCamPos);
    camera.quaternion.copy(savedCamQuat);

    controls.target.copy(savedTarget);
    controls.enabled = true;
    controls.update();

    if (capsuleMesh) capsuleMesh.visible = false;

    Object.keys(keys).forEach(k => (keys[k] = false));

    onExit?.();
  }

  function update(dt) {
    if (!active) return;

    if (walking) {
      const fwd   = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
      const right  = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
      const mx = -Math.sin(camYaw) * fwd + Math.cos(camYaw) * right;
      const mz = -Math.cos(camYaw) * fwd - Math.sin(camYaw) * right;

      capsule.update(dt, {
        input: { mx, mz, jump: keys.space, run: keys.shift, crouch: false },
        collider: null,
        getTerrainHeight,
        worldHalf: WORLD_SIZE / 2,
      });
    }

    positionCamera();
  }

  return {
    enter,
    startWalking,
    exit,
    update,
    get active()         { return active; },
    get walking()        { return walking; },
    get playerPosition() { return capsule.position; },
    getStats() {
      const p = capsule.position;
      return {
        x: p.x.toFixed(1),
        y: p.y.toFixed(1),
        z: p.z.toFixed(1),
        speed: capsule.debug.moveSpeed.toFixed(1),
        grounded: capsule.grounded,
      };
    },
  };
}
