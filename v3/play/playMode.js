import * as THREE from "three";
import { CapsuleController, DEFAULT_CAPSULE_PARAMS } from "./capsuleController.js";
import { WORLD_SIZE } from "../terrain/heightmapTexture.js";
import { createModeWheel, V3_MODE_ORDER, V3_MODE_META } from "./modeWheel.js";
import { createFlightMode } from "./flightMode.js";

const MOUSE_SENSITIVITY = 0.003;
const CAM_DIST          = 8;
const CAM_PITCH_DEFAULT = 0.42;
const CAM_PITCH_MIN     = 0.06;
const CAM_PITCH_MAX     = 1.3;
const CAP_R = 0.4;
const CAP_H = 1.2;
const CAPSULE_MOVE_SPEED = 12;

export const LOD_SNAP = 16;

export function createPlayMode({
  scene,
  renderer, camera, controls,
  sampleTerrainHeight, uCursorUV,
  character,
  husky = null,
  getCollider = () => null,
  getCliffBvh = () => null,
  onEnterMenu, onStartWalking, onExit,
  onModeChange,
}) {
  let active  = false;
  let walking = false;
  let moveMode = "char";

  const capsule = new CapsuleController({
    walkSpeed: 3,
    runSpeed: 6,
    jumpVel: 11,
    gravity: 20,
    groundSpringK: 35,
  });

  const capMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(CAP_R, CAP_H, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0xff6633, roughness: 0.7 }),
  );
  capMesh.castShadow = true;
  capMesh.visible = false;
  scene.add(capMesh);

  let charYaw = 0;

  let savedCamPos   = null;
  let savedCamQuat  = null;
  let savedTarget   = null;
  let savedCamOrder = "XYZ";

  let camYaw   = 0;
  let camPitch = CAM_PITCH_DEFAULT;

  const keys = { w: false, a: false, s: false, d: false, space: false, shift: false };
  const _lookAt = new THREE.Vector3();
  const _flyLook = new THREE.Vector3();

  const modeWheel = createModeWheel({
    getCurrentMode: () => moveMode,
    onPick: (mode) => setMoveMode(mode),
  });

  function getTerrainHeight(wx, wz) {
    const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
    const v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    return sampleTerrainHeight(u, v);
  }

  function sampleGroundY(wx, wz, fromY = 99999) {
    const terrainY = getTerrainHeight(wx, wz);
    const cliffBvh = getCliffBvh();
    if (!cliffBvh?.baked) return terrainY;
    const bvhY = cliffBvh.raycastHeightFrom(wx, fromY, wz);
    if (bvhY != null && bvhY > terrainY) return bvhY;
    return terrainY;
  }

  const flight = createFlightMode({
    scene,
    sampleGroundY,
  });

  function isFlyMode() {
    return moveMode === "fly";
  }

  function isFlying() {
    return isFlyMode() && flight.loaded;
  }

  function isOnFoot() {
    return moveMode === "capsule" || moveMode === "char" || moveMode === "husky";
  }

  let _modeToastEl = null;
  let _modeToastTimer = null;
  function showModeToast(label) {
    if (!_modeToastEl) {
      _modeToastEl = document.createElement("div");
      _modeToastEl.id = "v3-play-mode-toast";
      _modeToastEl.style.cssText = [
        "position:fixed", "top:72px", "left:50%", "transform:translateX(-50%)",
        "z-index:9000", "pointer-events:none", "font:600 13px/1 system-ui,sans-serif",
        "color:#f2f8fc", "padding:8px 16px", "border-radius:999px",
        "background:rgba(8,16,28,0.88)", "border:1px solid rgba(120,180,255,0.35)",
        "opacity:0", "transition:opacity 150ms ease",
      ].join(";");
      document.body.appendChild(_modeToastEl);
    }
    _modeToastEl.textContent = label;
    _modeToastEl.style.opacity = "1";
    clearTimeout(_modeToastTimer);
    _modeToastTimer = setTimeout(() => { _modeToastEl.style.opacity = "0"; }, 1400);
  }

  function currentYaw() {
    switch (moveMode) {
      case "char": return character?.yaw ?? charYaw;
      case "husky": return charYaw;
      case "fly": return flight.state.heading;
      default: return capsule.yaw;
    }
  }

  function applyModeVisuals() {
    const flyMode = isFlyMode();
    const huskyMode = moveMode === "husky" && husky?.loaded;
    const charMode = moveMode === "char";
    const capMode = moveMode === "capsule";

    capMesh.visible = active && (capMode || (huskyMode && !husky?.loaded));
    character?.setVisible(active && charMode && character.loaded);
    if (husky?.root) husky.root.visible = active && huskyMode && husky.loaded;
    flight.syncVisuals(capsule.position, flyMode && flight.loaded);
  }

  function setMoveMode(target) {
    if (!V3_MODE_META[target] || target === moveMode) return;
    const yaw = currentYaw();
    const p = capsule.position;

    if (moveMode === "husky" && target !== "husky") {
      husky?.restoreHumanCapsuleParams?.(capsule);
    }

    if (target === "fly") {
      flight.resetFrom(p.x, Math.max(p.y + 2, sampleGroundY(p.x, p.z) + 3), p.z, yaw);
      capsule.position.y = flight.state.height;
    } else if (moveMode === "fly") {
      p.y = sampleGroundY(p.x, p.z);
      capsule.reset(p.x, p.y, p.z);
      charYaw = yaw;
      capsule.yaw = yaw;
    }

    if (target === "husky") {
      husky?.resetAnimState?.();
      husky?.applyCapsuleParams?.(capsule);
      charYaw = yaw;
    } else if (target === "char") {
      capsule.setParams({ ...DEFAULT_CAPSULE_PARAMS });
      charYaw = yaw;
      character?.setYaw?.(yaw);
    } else if (target === "capsule") {
      capsule.setParams({ ...DEFAULT_CAPSULE_PARAMS });
      capsule.yaw = yaw;
    }

    moveMode = target;
    applyModeVisuals();
    showModeToast(V3_MODE_META[target].label);
    onModeChange?.(target);
  }

  function positionCameraOnFoot() {
    const capBase = CAP_R + CAP_H * 0.5;
    const lookY = moveMode === "husky" && husky?.loaded
      ? capsule.position.y + 0.66
      : capsule.position.y + (moveMode === "capsule" ? capBase + 0.6 : 1.875);
    const cosP = Math.cos(camPitch);
    const sinP = Math.sin(camPitch);

    camera.position.set(
      capsule.position.x + Math.sin(camYaw) * CAM_DIST * cosP,
      lookY + CAM_DIST * sinP,
      capsule.position.z + Math.cos(camYaw) * CAM_DIST * cosP,
    );
    camera.up.set(0, 1, 0);
    _lookAt.set(capsule.position.x, lookY, capsule.position.z);
    camera.lookAt(_lookAt);
  }

  function positionCamera() {
    if (isFlyMode()) {
      _flyLook.set(capsule.position.x, capsule.position.y, capsule.position.z);
      flight.positionCamera(camera, _flyLook, camPitch, CAM_DIST);
      return;
    }
    positionCameraOnFoot();
  }

  function syncCapsuleMesh() {
    if (!capMesh.visible) return;
    const capBase = CAP_R + CAP_H * 0.5;
    capMesh.position.set(
      capsule.position.x,
      capsule.position.y + capBase,
      capsule.position.z,
    );
    capMesh.rotation.y = capsule.yaw;
  }

  function isFormField(target) {
    return target instanceof HTMLInputElement
      || target instanceof HTMLSelectElement
      || target instanceof HTMLTextAreaElement;
  }

  function onKeyDown(e) {
    if (!active) return;

    const modeFromDigit = !e.repeat ? parseModeDigit(e.code) : null;
    const isModeKey = e.code === "KeyG" || !!modeFromDigit
      || (e.code === "Escape" && modeWheel.open);

    if (!isModeKey && isFormField(e.target)) return;

    if (!eventRepeatSafe(e) && e.code === "KeyG") {
      e.preventDefault();
      e.stopPropagation();
      modeWheel.onKeyDownG();
      return;
    }

    if (!eventRepeatSafe(e) && e.code === "Escape" && modeWheel.open) {
      e.preventDefault();
      e.stopPropagation();
      modeWheel.cancel();
      return;
    }

    if (modeFromDigit) {
      e.preventDefault();
      e.stopPropagation();
      setMoveMode(modeFromDigit);
      return;
    }

    if (!walking) return;

    if (moveMode === "husky" && husky?.loaded && !e.repeat) {
      if (husky.onKeyDown?.(e.code)) {
        e.preventDefault();
        return;
      }
    }

    switch (e.code) {
      case "KeyW": case "ArrowUp":    keys.w = true; break;
      case "KeyS": case "ArrowDown":  keys.s = true; break;
      case "KeyA": case "ArrowLeft":  keys.a = true; break;
      case "KeyD": case "ArrowRight": keys.d = true; break;
      case "Space": e.preventDefault(); keys.space = true; break;
      case "ShiftLeft": case "ShiftRight": keys.shift = true; break;
    }
  }

  function onKeyUp(e) {
    if (e.code === "KeyG" && active) {
      e.preventDefault();
      e.stopPropagation();
      modeWheel.onKeyUpG();
      return;
    }
    switch (e.code) {
      case "KeyW": case "ArrowUp":    keys.w = false; break;
      case "KeyS": case "ArrowDown":  keys.s = false; break;
      case "KeyA": case "ArrowLeft":  keys.a = false; break;
      case "KeyD": case "ArrowRight": keys.d = false; break;
      case "Space":                   keys.space = false; break;
      case "ShiftLeft": case "ShiftRight": keys.shift = false; break;
    }
  }

  function onMouseMove(e) {
    if (modeWheel.open) {
      modeWheel.feedMouse(e.movementX || 0, e.movementY || 0);
      return;
    }
    if (!walking) return;

    if (isFlyMode()) {
      flight.applyMouse(
        e.movementX * MOUSE_SENSITIVITY / FLY_MOUSE_SCALE,
        e.movementY * MOUSE_SENSITIVITY / FLY_MOUSE_SCALE,
        capsule.position.x,
        capsule.position.z,
      );
      return;
    }

    camYaw   += e.movementX * MOUSE_SENSITIVITY;
    camPitch -= e.movementY * MOUSE_SENSITIVITY;
    camPitch  = Math.max(CAM_PITCH_MIN, Math.min(CAM_PITCH_MAX, camPitch));
  }

  const FLY_MOUSE_SCALE = MOUSE_SENSITIVITY / 0.0022;

  function onPointerLockChange() {
    const locked = document.pointerLockElement === renderer.domElement;
    if (locked && active && !walking) {
      walking = true;
      onStartWalking?.();
    }
    if (!locked && walking) {
      walking = false;
      Object.keys(keys).forEach((k) => { keys[k] = false; });
      onEnterMenu?.();
    }
  }

  function eventRepeatSafe(e) { return !e.repeat; }

  function parseModeDigit(code) {
    let digit = null;
    if (code.startsWith("Digit")) digit = code.slice(5);
    else if (/^Numpad[0-9]$/.test(code)) digit = code.slice(6);
    if (!digit) return null;
    return V3_MODE_ORDER.find((name) => V3_MODE_META[name].digit === digit) ?? null;
  }

  const KEY_OPTS = { capture: true };
  document.addEventListener("keydown", onKeyDown, KEY_OPTS);
  document.addEventListener("keyup", onKeyUp, KEY_OPTS);
  renderer.domElement.addEventListener("keydown", onKeyDown, KEY_OPTS);
  renderer.domElement.addEventListener("keyup", onKeyUp, KEY_OPTS);
  renderer.domElement.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  if (!renderer.domElement.hasAttribute("tabindex")) {
    renderer.domElement.tabIndex = 0;
  }

  function enter() {
    if (active) return;
    active = true;
    walking = false;
    moveMode = "char";

    savedCamPos   = camera.position.clone();
    savedCamQuat  = camera.quaternion.clone();
    savedTarget   = controls.target.clone();
    savedCamOrder = camera.rotation.order;

    const dx = camera.position.x - controls.target.x;
    const dz = camera.position.z - controls.target.z;
    camYaw   = Math.atan2(dx, dz);
    camPitch = CAM_PITCH_DEFAULT;

    controls.enabled = false;
    uCursorUV.value.set(-2, -2);

    const tx = controls.target.x;
    const tz = controls.target.z;
    capsule.reset(tx, sampleGroundY(tx, tz), tz);
    charYaw = camYaw;
    capsule.yaw = camYaw;

    applyModeVisuals();
    positionCamera();
    onEnterMenu?.();
  }

  function startWalking() {
    if (!active || walking) return;
    try { renderer.domElement.requestPointerLock(); } catch (_) {}
  }

  function exit() {
    if (!active) return;
    active = false;
    walking = false;
    modeWheel.cancel();

    if (document.pointerLockElement) document.exitPointerLock();

    camera.rotation.order = savedCamOrder;
    camera.position.copy(savedCamPos);
    camera.quaternion.copy(savedCamQuat);
    camera.up.set(0, 1, 0);

    controls.target.copy(savedTarget);
    controls.enabled = true;
    controls.update();

    character?.setVisible(false);
    character?.reset();
    if (husky?.root) husky.root.visible = false;
    capMesh.visible = false;
    flight.syncVisuals(capsule.position, false);
    capsule.setParams({ ...DEFAULT_CAPSULE_PARAMS });

    Object.keys(keys).forEach((k) => { keys[k] = false; });
    onExit?.();
  }

  function updateOnFoot(dt) {
    const fwd = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
    const right = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    const mx = -Math.sin(camYaw) * fwd + Math.cos(camYaw) * right;
    const mz = -Math.cos(camYaw) * fwd - Math.sin(camYaw) * right;

    const huskyMode = moveMode === "husky" && husky?.loaded;
    const charMode = moveMode === "char";
    let speedOverride = null;
    if (moveMode === "capsule") speedOverride = CAPSULE_MOVE_SPEED;

    capsule.update(dt, {
      input: { mx, mz, jump: keys.space, run: keys.shift, crouch: false },
      moveSpeedOverride: speedOverride,
      collider: getCollider(),
      getTerrainHeight: sampleGroundY,
      worldHalf: WORLD_SIZE / 2,
    });

    if (huskyMode) {
      charYaw = husky.updateFrame({
        dtSec: dt,
        playerPos: capsule.position,
        charYaw,
        mx, mz,
        ctrl: capsule,
        collider: getCollider(),
        getTerrainHeight: sampleGroundY,
        keys: {
          ShiftLeft: keys.shift,
          ShiftRight: keys.shift,
        },
        gallop: keys.shift,
        moveSpeed: capsule.debug.moveSpeed,
      });
    } else if (charMode) {
      character?.update(dt, capsule, { mx, mz, run: keys.shift, crouch: false });
      charYaw = character?.yaw ?? charYaw;
    }
  }

  function update(dt) {
    if (!active) return;

    if (walking) {
      if (isFlyMode()) {
        flight.update(dt, keys, capsule.position);
      } else if (isOnFoot()) {
        updateOnFoot(dt);
      }
    }

    syncCapsuleMesh();
    applyModeVisuals();
    positionCamera();
  }

  return {
    enter,
    startWalking,
    exit,
    update,
    setMoveMode,
    get active() { return active; },
    get walking() { return walking; },
    get moveMode() { return moveMode; },
    get wheelOpen() { return modeWheel.open; },
    get playerPosition() { return capsule.position; },
    getStats() {
      const p = capsule.position;
      return {
        x: p.x.toFixed(1),
        y: p.y.toFixed(1),
        z: p.z.toFixed(1),
        speed: isFlying()
          ? Math.abs(flight.state.speed).toFixed(1)
          : capsule.debug.moveSpeed.toFixed(1),
        grounded: isFlying() ? "fly" : capsule.grounded,
        mode: V3_MODE_META[moveMode]?.label ?? moveMode,
      };
    },
  };
}
