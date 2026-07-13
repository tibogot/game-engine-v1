import * as THREE from "three";
import { CapsuleController, DEFAULT_CAPSULE_PARAMS } from "./capsuleController.js";
import { WORLD_SIZE } from "../terrain/heightmapTexture.js";
import { createModeWheel, V3_MODE_ORDER, V3_MODE_META, V3_QUADRUPED_MODES } from "./modeWheel.js";
import { createFlightMode } from "./flightMode.js";
import { createBrunoCarMode } from "./brunoCarMode.js";
import { createStuntCarMode } from "./stuntCarMode.js";
import { createBallDebugMode, BALL_R } from "./ballDebugMode.js";

const MOUSE_SENSITIVITY = 0.003;
const CAM_DIST          = 8;
const CAM_PITCH_DEFAULT = 0.42;
const CAM_PITCH_MIN     = 0.06;
const CAM_PITCH_MAX     = 1.3;
const CAP_R = 0.4;
const CAP_H = 1.2;
const CAPSULE_MOVE_SPEED = 12;

export const LOD_SNAP = 16;

/** Tuned on-foot baseline — play-mode reset + physics panel defaults. */
export const HUMAN_CAPSULE_DEFAULTS = {
  ...DEFAULT_CAPSULE_PARAMS,
  walkSpeed: 3,
  runSpeed: 6,
  jumpVel: 11,
  gravity: 20,
  groundSpringK: 35,
};

export function createPlayMode({
  scene,
  renderer, camera, controls,
  sampleTerrainHeight, sampleTerrainNormal = null, uCursorUV,
  character,
  husky = null,
  fox = null,
  bruno = null,
  stunt = null,
  getCollider = () => null,
  getCliffBvh = () => null,
  getTreeBvh = () => null,
  getStuntRoadMeshes = () => [],
  getStuntRoadSolidMeshes = () => [],
  /** Player start placed in the editor: { x, z, yaw } — null falls back to the camera target. */
  getSpawnPoint = () => null,
  onEnterMenu, onStartWalking, onExit,
  onModeChange,
  onRequestImmersive,
}) {
  let active  = false;
  let walking = false;
  let editorRelaxedPointer = false;
  let rmbLookActive = false;
  let moveMode = "char";

  // The tuned on-foot baseline. Every param reset below MUST restore these —
  // resetting to bare DEFAULT_CAPSULE_PARAMS (walk 6 / run 14) is what made the
  // character run 2× faster after exiting and re-entering play mode.
  const HUMAN_CAPSULE_PARAMS = { ...HUMAN_CAPSULE_DEFAULTS };

  const capsule = new CapsuleController(HUMAN_CAPSULE_PARAMS);

  const capMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(CAP_R, CAP_H, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0xff6633, roughness: 0.7 }),
  );
  capMesh.castShadow = true;
  capMesh.visible = false;
  scene.add(capMesh);

  let onFootWire = null;
  let colliderDebugOn = false;
  let onFootWireDims = { r: 0, h: 0 };

  let charYaw = 0;

  let savedCamPos   = null;
  let savedCamQuat  = null;
  let savedTarget   = null;
  let savedCamOrder = "XYZ";

  let camYaw   = 0;
  let camPitch = CAM_PITCH_DEFAULT;

  const keys = {
    w: false, a: false, s: false, d: false,
    space: false, shift: false, ctrl: false, q: false, e: false, x: false,
  };
  // v2 playMode.js keysHeld — used for movement + barrel-roll edge detect
  const keysHeld = Object.create(null);
  let _keyQPrev = false;
  const _lookAt = new THREE.Vector3();
  const _snowXZs = new Float32Array(8);
  const _snowTouch = new Float32Array(4);
  const _footL = new THREE.Vector3();
  const _footR = new THREE.Vector3();
  const _pawTmp = new THREE.Vector3();
  const _pawY = new Float32Array(4);

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
    getTerrainHeight,
    getCliffBvh,
    getTreeBvh,
  });

  const brunoCar = bruno ?? createBrunoCarMode({
    scene,
    sampleGroundY,
    getCliffBvh,
    getTreeBvh,
  });

  const stuntCar = stunt ?? createStuntCarMode({
    scene,
    camera,
    sampleGroundY,
    getCliffBvh,
    getTreeBvh,
    getStuntRoadMeshes,
    getStuntRoadSolidMeshes,
  });

  const ballDebug = createBallDebugMode({
    scene,
    sampleGroundY,
    getCollider,
  });

  function isCarMode() {
    return moveMode === "car" || moveMode === "stunt";
  }

  function isBrunoMode() {
    return moveMode === "car";
  }

  function isStuntMode() {
    return moveMode === "stunt";
  }

  function isBallMode() {
    return moveMode === "ball";
  }

  function isFlyMode() {
    return moveMode === "fly";
  }

  function isFlying() {
    return isFlyMode() && flight.loaded;
  }

  /**
   * Quadruped pawns share one slot: same CapsuleController, same QuadrupedOnFoot
   * rig, only different models and clip FSMs. Mode name === key, so adding another
   * animal is a registry entry here plus one in V3_MODE_ORDER.
   */
  const quadrupeds = { husky, fox };

  function isQuadrupedMode(mode = moveMode) {
    return V3_QUADRUPED_MODES.includes(mode);
  }

  /** The pawn for the current mode, or null if it isn't a quadruped / hasn't loaded. */
  function activePawn() {
    const pawn = quadrupeds[moveMode];
    return pawn?.loaded ? pawn : null;
  }

  function isOnFoot() {
    return moveMode === "capsule" || moveMode === "char" || isQuadrupedMode();
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

  /**
   * Yaw conventions in play mode — every mode is stored in its own, so switching
   * between them has to convert or the new mode comes out spun 180°:
   *
   *   facing  (character, husky, capsule) — forward is +Z: (sin y,  cos y)
   *   heading (cars, plane)               — forward is -Z: (-sin h, -cos h) = facing + π
   *   camYaw  (chase camera, ball)        — points from the player TOWARD the camera,
   *                                         i.e. behind them: facing + π
   *
   * `currentYaw()` normalizes all of them to FACING; setMoveMode() converts back
   * on the way into each mode.
   */
  const flipYaw = (y) => Math.atan2(Math.sin(y + Math.PI), Math.cos(y + Math.PI));

  function currentYaw() {
    if (isQuadrupedMode()) return charYaw;
    switch (moveMode) {
      case "char": return character?.yaw ?? charYaw;
      case "fly": return flipYaw(flight.state.heading);
      case "car": return flipYaw(brunoCar.heading);
      case "stunt": return flipYaw(stuntCar.heading);
      case "ball": return flipYaw(camYaw);
      default: return capsule.yaw;
    }
  }

  function applyModeVisuals() {
    const flyMode = isFlyMode();
    const pawn = activePawn();
    // A quadruped mode whose model hasn't loaded yet falls back to the capsule.
    const pawnPending = isQuadrupedMode() && !pawn;
    const charMode = moveMode === "char";
    const capMode = moveMode === "capsule";
    const brunoMode = isBrunoMode() && brunoCar.loaded;
    const stuntMode = isStuntMode();

    capMesh.visible = active && (capMode || pawnPending);
    character?.setVisible(active && charMode && character.loaded);
    for (const [name, q] of Object.entries(quadrupeds)) {
      if (q?.root) q.root.visible = active && q === pawn && moveMode === name;
    }
    flight.syncVisuals(capsule.position, flyMode);
    if (!brunoMode) brunoCar.hide();
    if (stuntMode) stuntCar.syncVisuals(true);
    else stuntCar.hide();
    ballDebug.syncVisuals(capsule.position, moveMode === "ball");
  }

  function setMoveMode(target) {
    if (!V3_MODE_META[target] || target === moveMode) return;
    const yaw = currentYaw();     // FACING — the shared currency between modes
    const heading = flipYaw(yaw); // what the cars and the plane want
    const p = capsule.position;

    // Leaving a quadruped: hand the capsule back its human dimensions before the
    // next mode gets to set its own.
    if (isQuadrupedMode() && !isQuadrupedMode(target)) {
      quadrupeds[moveMode]?.restoreHumanCapsuleParams?.(capsule);
    }

    if (isCarMode() && target !== "car" && target !== "stunt") {
      p.y = sampleGroundY(p.x, p.z);
      capsule.reset(p.x, p.y, p.z);
      charYaw = yaw;
      capsule.yaw = yaw;
      brunoCar.hide();
      stuntCar.hide();
    }

    if (target === "fly") {
      focusGameCanvas();
      if (editorRelaxedPointer) onRequestImmersive?.();
      else {
        try { renderer.domElement.requestPointerLock(); } catch (_) {}
      }
      const p = capsule.position;
      const spawn = flight.resetFrom(
        p.x,
        Math.max(p.y + 2, sampleGroundY(p.x, p.z) + 3),
        p.z,
        heading,
      );
      p.x = spawn.x;
      p.y = spawn.y;
      p.z = spawn.z;
    } else if (moveMode === "fly") {
      p.y = sampleGroundY(p.x, p.z);
      capsule.reset(p.x, p.y, p.z);
      charYaw = yaw;
      capsule.yaw = yaw;
    } else if (moveMode === "ball") {
      const gy = sampleGroundY(p.x, p.z);
      p.y = gy + BALL_R;
      capsule.reset(p.x, p.y, p.z);
      charYaw = yaw;
      capsule.yaw = yaw;
      ballDebug.hide();
    }

    // On foot (and in the ball) the chase camera sits behind the facing.
    if (target === "char" || target === "capsule" || target === "ball" || isQuadrupedMode(target)) {
      camYaw = flipYaw(yaw);
    }

    if (isQuadrupedMode(target)) {
      const pawn = quadrupeds[target];
      pawn?.resetAnimState?.();
      pawn?.applyCapsuleParams?.(capsule);
      charYaw = yaw;
    } else if (target === "char") {
      capsule.setParams({ ...HUMAN_CAPSULE_PARAMS });
      charYaw = yaw;
      character?.setYaw?.(yaw);
    } else if (target === "capsule") {
      capsule.setParams({ ...HUMAN_CAPSULE_PARAMS });
      capsule.yaw = yaw;
    } else if (target === "car") {
      const spawn = brunoCar.resetFrom(p.x, p.y, p.z, heading);
      p.x = spawn.x;
      p.y = spawn.y;
      p.z = spawn.z;
      charYaw = yaw;
    } else if (target === "stunt") {
      const spawn = stuntCar.resetFrom(p.x, p.y, p.z, heading);
      p.x = spawn.x;
      p.y = spawn.y;
      p.z = spawn.z;
      charYaw = yaw;
    } else if (target === "ball") {
      const gy = sampleGroundY(p.x, p.z);
      const spawn = ballDebug.resetFrom(p.x, Math.max(p.y, gy + BALL_R), p.z);
      p.x = spawn.x;
      p.y = spawn.y;
      p.z = spawn.z;
      charYaw = yaw;
    }

    moveMode = target;
    applyModeVisuals();
    applyColliderDebug();
    showModeToast(V3_MODE_META[target].label);
    onModeChange?.(target);
  }

  function positionCameraOnFoot() {
    const capBase = CAP_R + CAP_H * 0.5;
    // Quadrupeds are looked at mid-body, so the look height scales with the pawn
    // rather than being a per-animal magic number.
    const pawn = activePawn();
    const lookY = isBallMode()
      ? capsule.position.y
      : pawn
        ? capsule.position.y + pawn.targetHeight * 0.55
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

  function positionCamera(dt = 0) {
    if (isFlyMode()) {
      flight.positionCamera(
        camera,
        capsule.position.x,
        capsule.position.y + 0.45,
        capsule.position.z,
        camPitch,
        CAM_DIST,
        dt,
      );
      return;
    }
    if (isBrunoMode()) {
      brunoCar.positionCamera(camera, capsule.position, dt);
      return;
    }
    if (isStuntMode()) {
      stuntCar.positionCamera(dt);
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

  function updateOnFootWire(visible) {
    if (!visible) {
      if (onFootWire) onFootWire.visible = false;
      return;
    }
    const p = capsule.params;
    const r = p.capRadius;
    const h = capsule.crouching ? p.capHeight * p.crouchHeightScale : p.capHeight;
    if (!onFootWire) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x44ff88,
        wireframe: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      });
      onFootWire = new THREE.Mesh(new THREE.CapsuleGeometry(r, h, 6, 12), mat);
      onFootWire.frustumCulled = false;
      scene.add(onFootWire);
      onFootWireDims = { r, h };
    } else if (onFootWireDims.r !== r || onFootWireDims.h !== h) {
      onFootWire.geometry.dispose();
      onFootWire.geometry = new THREE.CapsuleGeometry(r, h, 6, 12);
      onFootWireDims = { r, h };
    }
    onFootWire.visible = true;
    onFootWire.position.set(
      capsule.position.x,
      capsule.position.y + r + h * 0.5,
      capsule.position.z,
    );
  }

  function applyColliderDebug() {
    if (!colliderDebugOn) {
      updateOnFootWire(false);
      flight.setShowCollider(false);
      return;
    }
    const fly = isFlyMode();
    updateOnFootWire(!fly && isOnFoot());
    flight.setShowCollider(fly);
  }

  function setShowCollider(v) {
    colliderDebugOn = !!v;
    applyColliderDebug();
  }

  function getCapsuleParams() {
    return { ...capsule.params };
  }

  function setCapsuleParams(patch) {
    capsule.setParams(patch);
  }

  function resetCapsuleParams() {
    capsule.setParams({ ...HUMAN_CAPSULE_DEFAULTS });
  }

  function isMoveKeysHeld() {
    return keys.w || keys.a || keys.s || keys.d;
  }


  function onRelaxedPointerDown(e) {
    if (!active || !editorRelaxedPointer) return;
    if (e.button === 2) {
      e.preventDefault();
      rmbLookActive = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    }
  }

  function onRelaxedPointerUp(e) {
    if (!active || !editorRelaxedPointer) return;
    if (e.button === 2) {
      rmbLookActive = false;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  }

  function onRelaxedContextMenu(e) {
    if (!active || !editorRelaxedPointer) return;
    e.preventDefault();
  }

  function attachRelaxedPointerListeners() {
    const el = renderer.domElement;
    el.addEventListener("pointerdown", onRelaxedPointerDown);
    el.addEventListener("pointerup", onRelaxedPointerUp);
    el.addEventListener("contextmenu", onRelaxedContextMenu);
  }

  function detachRelaxedPointerListeners() {
    const el = renderer.domElement;
    el.removeEventListener("pointerdown", onRelaxedPointerDown);
    el.removeEventListener("pointerup", onRelaxedPointerUp);
    el.removeEventListener("contextmenu", onRelaxedContextMenu);
  }

  function setEditorPointerMode(relaxed) {
    if (!active) return;
    rmbLookActive = false;
    detachRelaxedPointerListeners();
    if (document.pointerLockElement) document.exitPointerLock();

    editorRelaxedPointer = !!relaxed;
    const el = renderer.domElement;
    document.body.classList.toggle("play-immersive-cursor", active && !relaxed);

    if (relaxed) {
      el.style.cursor = "";
      attachRelaxedPointerListeners();
      walking = true;
      onStartWalking?.();
    } else {
      walking = false;
      el.style.cursor = "none";
      try { el.requestPointerLock(); } catch (_) {}
    }
  }

  function focusGameCanvas() {
    const el = renderer.domElement;
    if (document.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
    }
  }

  function tryFlightBarrelRoll() {
    if (!isFlyMode() || !flight.loaded || flight.state.barrelActive) return false;
    flight.triggerBarrelRoll();
    return true;
  }

  function onKeyDown(e) {
    if (!active) return;
    keysHeld[e.code] = true;

    const modeFromDigit = !e.repeat ? parseModeDigit(e.code) : null;

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

    // v2/playMode.js _onKeyDown — barrel roll (KeyQ while flying)
    if (!eventRepeatSafe(e) && e.code === "KeyQ" && isFlyMode()) {
      e.preventDefault();
      tryFlightBarrelRoll();
      return;
    }

    if (!e.repeat) {
      // Pawn one-shots (bite / sit / bark …) get first refusal on the key.
      const pawn = activePawn();
      if (pawn?.onKeyDown?.(e.code)) {
        e.preventDefault();
        return;
      }
    }

    if (moveMode === "char" && character?.loaded && !e.repeat) {
      if (e.code === "KeyR" && character.tryAttack(capsule.inAir)) {
        e.preventDefault();
        return;
      }
      if (e.code === "KeyC" && character.tryRoll()) {
        e.preventDefault();
        return;
      }
      if (e.code === "KeyX" && character.trySlide(isMoveKeysHeld(), capsule.inAir)) {
        e.preventDefault();
        return;
      }
      if (e.code === "KeyQ" && character.trySpellToggle()) {
        e.preventDefault();
        return;
      }
      if (e.code === "KeyJ" && character.trySpellShoot()) {
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
      case "ControlLeft": case "ControlRight": keys.ctrl = true; break;
      case "KeyQ": if (!isFlyMode()) keys.q = true; break;
      case "KeyE": keys.e = true; break;
      case "KeyX": keys.x = true; break;
    }
  }

  function onKeyUp(e) {
    keysHeld[e.code] = false;
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
      case "ControlLeft": case "ControlRight": keys.ctrl = false; break;
      case "KeyQ": keys.q = false; break;
      case "KeyE": keys.e = false; break;
      case "KeyX": keys.x = false; break;
    }
  }

  function onMouseMove(e) {
    if (modeWheel.open) {
      modeWheel.feedMouse(e.movementX || 0, e.movementY || 0);
      return;
    }
    if (!active) return;

    const locked = !!document.pointerLockElement;
    const relaxedLook = editorRelaxedPointer && rmbLookActive && !locked;
    if (!locked && !relaxedLook) return;

    if (isFlyMode()) {
      if (!flight.loaded) return;
      flight.applyMouse(
        e.movementX || 0,
        e.movementY || 0,
        capsule.position.x,
        capsule.position.z,
      );
      return;
    }

    if (isCarMode()) return;

    camYaw   += e.movementX * MOUSE_SENSITIVITY;
    camPitch -= e.movementY * MOUSE_SENSITIVITY;
    camPitch  = Math.max(CAM_PITCH_MIN, Math.min(CAM_PITCH_MAX, camPitch));
  }

  function onPointerLockChange() {
    const locked = document.pointerLockElement === renderer.domElement;
    if (locked) focusGameCanvas();
    if (locked && active && !walking) {
      walking = true;
      onStartWalking?.();
    }
    if (!locked && walking && !editorRelaxedPointer) {
      walking = false;
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

  if (!renderer.domElement.hasAttribute("tabindex")) {
    renderer.domElement.tabIndex = 0;
  }

  const PLAY_KEY_OPTS = { capture: true };

  function attachPlayInput() {
    // Window capture — runs before editor UI / gizmo handlers can swallow keys.
    window.addEventListener("keydown", onKeyDown, PLAY_KEY_OPTS);
    window.addEventListener("keyup", onKeyUp, PLAY_KEY_OPTS);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("pointerlockchange", onPointerLockChange);
  }

  function detachPlayInput() {
    window.removeEventListener("keydown", onKeyDown, PLAY_KEY_OPTS);
    window.removeEventListener("keyup", onKeyUp, PLAY_KEY_OPTS);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
  }

  function enter(opts = {}) {
    if (active) return;
    active = true;
    walking = false;
    moveMode = "char";
    editorRelaxedPointer = !!opts.editorRelaxedPointer;
    rmbLookActive = false;

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

    // Player start wins when one is placed; otherwise drop in at the orbit target.
    const spawn = opts.spawn ?? getSpawnPoint();
    const tx = spawn ? spawn.x : controls.target.x;
    const tz = spawn ? spawn.z : controls.target.z;
    if (spawn && Number.isFinite(spawn.yaw)) camYaw = spawn.yaw;
    capsule.reset(tx, sampleGroundY(tx, tz), tz);

    // camYaw sits BEHIND the player, so the facing is the flip of it — spawning
    // the character at camYaw itself would stand them nose-to-camera.
    charYaw = flipYaw(camYaw);
    capsule.yaw = charYaw;
    character?.setYaw?.(charYaw);

    applyModeVisuals();
    positionCamera(0);

    focusGameCanvas();
    const el = renderer.domElement;
    document.body.classList.toggle("play-immersive-cursor", !editorRelaxedPointer);
    if (editorRelaxedPointer) {
      el.style.cursor = "";
      attachRelaxedPointerListeners();
      walking = true;
      onStartWalking?.();
    } else {
      el.style.cursor = "none";
      onEnterMenu?.();
    }

    attachPlayInput();
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
    rmbLookActive = false;
    detachRelaxedPointerListeners();
    document.body.classList.remove("play-immersive-cursor");
    renderer.domElement.style.cursor = "";

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
    for (const q of Object.values(quadrupeds)) {
      if (q?.root) q.root.visible = false;
    }
    capMesh.visible = false;
    colliderDebugOn = false;
    updateOnFootWire(false);
    flight.setShowCollider(false);
    flight.syncVisuals(capsule.position, false);
    brunoCar.hide();
    stuntCar.hide();
    ballDebug.hide();
    capsule.setParams({ ...HUMAN_CAPSULE_PARAMS });

    Object.keys(keys).forEach((k) => { keys[k] = false; });
    for (const code of Object.keys(keysHeld)) delete keysHeld[code];
    _keyQPrev = false;
    detachPlayInput();
    onExit?.();
  }

  function updateOnFoot(dt) {
    let fwd = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
    let right = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    let mx = -Math.sin(camYaw) * fwd + Math.cos(camYaw) * right;
    let mz = -Math.cos(camYaw) * fwd - Math.sin(camYaw) * right;

    const pawn = activePawn();
    const charMode = moveMode === "char" && character?.loaded;
    const inSlide = charMode && character.inSlide;
    const rolling = charMode && character.rolling;

    let speedOverride = null;
    if (moveMode === "capsule") speedOverride = CAPSULE_MOVE_SPEED;

    if (charMode) {
      const moveOverride = character.getMoveOverride(isMoveKeysHeld(), keys.x);
      if (moveOverride) {
        mx = moveOverride.mx;
        mz = moveOverride.mz;
        speedOverride = moveOverride.speed;
      }
      if (character.attacking || character.inSpell) {
        mx = 0;
        mz = 0;
      }
    }

    const wantCrouch = charMode && keys.ctrl && !capsule.inAir && !rolling && !inSlide
      && !character.attacking && !character.inSpell;

    capsule.update(dt, {
      input: {
        mx, mz,
        jump: keys.space,
        run: keys.shift,
        crouch: pawn ? false : wantCrouch,
      },
      moveSpeedOverride: speedOverride,
      canJump: charMode
        ? !rolling && !inSlide && character.jumpPhase !== "land"
          && !character.attacking && !character.inSpell
        : true,
      collider: getCollider(),
      getTerrainHeight,
      getTerrainNormal: sampleTerrainNormal,
      worldHalf: WORLD_SIZE / 2,
    });

    updateOnFootWire(colliderDebugOn && isOnFoot());

    if (pawn) {
      // keysHeld is passed raw (keyed by e.code) so the pawns can read modifier
      // holds like KeyC for the husky's head-low idle and the fox's sneak.
      charYaw = pawn.updateFrame({
        dtSec: dt,
        playerPos: capsule.position,
        charYaw,
        mx, mz,
        ctrl: capsule,
        collider: getCollider(),
        getTerrainHeight,
        keys: keysHeld,
        gallop: keys.shift,
        moveSpeed: capsule.debug.moveSpeed,
      });
    } else if (charMode) {
      character.update(dt, capsule, {
        mx, mz,
        run: keys.shift,
        crouch: capsule.crouching,
      });
      charYaw = character.yaw;
    }
  }

  function update(dt) {
    if (!active) return;

    if (isFlyMode()) {
      const qDown = !!keysHeld.KeyQ;
      if (qDown && !_keyQPrev) tryFlightBarrelRoll();
      _keyQPrev = qDown;

      flight.update(dt, keys, capsule.position);
    } else {
      _keyQPrev = false;
    }

    if (isOnFoot()) {
      updateOnFoot(dt);
    } else if (isBrunoMode()) {
      brunoCar.update(dt, keys, capsule.position);
    } else if (isStuntMode()) {
      stuntCar.update(dt, keys, capsule.position);
    } else if (isBallMode()) {
      ballDebug.update(dt, keys, camYaw, capsule.position);
    }

    if (isBrunoMode() && brunoCar.loaded) {
      brunoCar.syncVisuals(dt, keys, true, capsule.position);
    }

    syncCapsuleMesh();
    applyModeVisuals();
    if (isFlyMode()) flight.updateGun(dt, camera, keys.e);
    positionCamera(dt);
  }

  /** Ground contact points for snow stamping — feet, paws, wheels, or body. */
  function getSnowContacts() {
    if (moveMode === "fly") return null;

    // Ball uses a continuous centre trail (snow-lab style).
    if (moveMode === "ball") return null;

    // Cars stamp a rut under each wheel; the car modules own the wheel
    // positions and per-wheel ground contact.
    if (moveMode === "car")   return brunoCar.getSnowContacts?.() ?? null;
    if (moveMode === "stunt") return stuntCar.getSnowContacts?.() ?? null;

    _snowXZs.fill(0);
    _snowTouch.fill(0);

    if (moveMode === "char") {
      const grounded = capsule.grounded;
      const bL = character?.footBoneL;
      const bR = character?.footBoneR;
      if (grounded && bL && bR) {
        bL.getWorldPosition(_footL);
        bR.getWorldPosition(_footR);
        const groundY = capsule.position.y;
        const lTouch = (_footL.y - groundY) < 0.18 ? 1 : 0;
        const rTouch = (_footR.y - groundY) < 0.18 ? 1 : 0;
        _snowXZs[0] = _footL.x;
        _snowXZs[1] = _footL.z;
        _snowXZs[2] = _footR.x;
        _snowXZs[3] = _footR.z;
        _snowTouch[0] = lTouch;
        _snowTouch[1] = rTouch;
        return { xzs: _snowXZs, touching: _snowTouch, isVehicle: false };
      }
    }

    // Quadrupeds leave four paw prints. Each paw touches when it sits near the
    // lowest paw of the frame (the planted ones); swinging paws lift clear.
    // Comparing to the frame minimum keeps this robust to the model's overall
    // ground offset without needing per-model tuning.
    const snowPawn = activePawn();
    if (snowPawn?.paws && capsule.grounded) {
      const paws = snowPawn.paws;
      let minY = Infinity;
      for (let i = 0; i < 4; i++) {
        paws[i].getWorldPosition(_pawTmp);
        _snowXZs[i * 2]     = _pawTmp.x;
        _snowXZs[i * 2 + 1] = _pawTmp.z;
        _pawY[i] = _pawTmp.y;
        if (_pawY[i] < minY) minY = _pawY[i];
      }
      // Print size tracks the animal — the fox's paws are not the husky's.
      const sizeK = snowPawn.targetHeight / 1.2;
      for (let i = 0; i < 4; i++) {
        _snowTouch[i] = (_pawY[i] - minY) < 0.07 * sizeK ? 1 : 0;
      }
      return { xzs: _snowXZs, touching: _snowTouch, isVehicle: false, radius: 0.12 * sizeK };
    }

    // Capsule (and char/quadrupeds before their model loads) — a body-width trail
    // sized to the capsule so it reads as the body dragging through the snow,
    // not a thin footprint line.
    if (moveMode === "capsule" || moveMode === "char" || isQuadrupedMode()) {
      const touch = capsule.grounded ? 1 : 0;
      _snowXZs[0] = capsule.position.x;
      _snowXZs[1] = capsule.position.z;
      _snowTouch[0] = touch;
      return {
        xzs: _snowXZs,
        touching: _snowTouch,
        isVehicle: false,
        radius: capsule.params?.capRadius ?? 0.4,
      };
    }

    return null;
  }

  return {
    enter,
    startWalking,
    exit,
    update,
    setMoveMode,
    setEditorPointerMode,
    get active() { return active; },
    get walking() { return walking; },
    get relaxedPointer() { return editorRelaxedPointer; },
    get moveMode() { return moveMode; },
    get wheelOpen() { return modeWheel.open; },
    get showCollider() { return colliderDebugOn; },
    setShowCollider,
    get onFootActive() {
      return active && isOnFoot();
    },
    get flyActive() {
      return active && isFlyMode();
    },
    getCapsuleParams,
    setCapsuleParams,
    resetCapsuleParams,
    getFlightParams: () => flight.getFlightParams(),
    setFlightParams: (patch) => flight.setFlightParams(patch),
    resetFlightParams: () => flight.resetFlightParams(),
    getFlightHudState: () => (active && isFlyMode() ? flight.getHudState() : null),
    get playerPosition() { return capsule.position; },
    getSnowContacts,
    getStats() {
      const p = capsule.position;
      let speed = capsule.debug.moveSpeed;
      let grounded = capsule.grounded;
      if (isFlying()) {
        speed = Math.abs(flight.speed);
        grounded = "fly";
      } else if (isBrunoMode()) {
        speed = brunoCar.getSpeed();
        grounded = brunoCar.grounded;
      } else if (isStuntMode()) {
        speed = stuntCar.getSpeed();
        grounded = stuntCar.grounded;
      } else if (isBallMode()) {
        speed = ballDebug.speed;
        grounded = ballDebug.grounded;
      }
      return {
        x: p.x.toFixed(1),
        y: p.y.toFixed(1),
        z: p.z.toFixed(1),
        speed: speed.toFixed(1),
        grounded,
        mode: V3_MODE_META[moveMode]?.label ?? moveMode,
      };
    },
    getFlightDebug() {
      return {
        moveMode,
        loaded: flight.loaded,
        barrelActive: flight.state.barrelActive,
        barrelPhase: flight.state.barrelPhase,
        keyQ: !!keysHeld.KeyQ,
      };
    },
  };
}
