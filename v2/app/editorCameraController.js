import * as THREE from "three";

/**
 * Editor scene camera — orbit + fly, zoom-to-cursor, focus, Shift+MMB pivot height.
 */
export function createEditorCameraController({
  camera,
  controls,
  domElement,
  isActive,
  pickWorldAtClient,
  getSelectionFocus,
}) {
  const _offset = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _focusDir = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  const _flyFwd = new THREE.Vector3();
  const _flyRight = new THREE.Vector3();
  const _euler = new THREE.Euler(0, 0, 0, "YXZ");

  const MIN_DIST = 0.5; // match camera near plane — close enough for prop/grass detail
  const MAX_DIST = 4000;
  const FLY_BASE_SPEED = 48;
  const FLY_SPRINT = 2.4;

  let flyMode = false;
  let flyYaw = 0;
  let flyPitch = 0;
  let keysHeld = Object.create(null);
  let shiftPivotDrag = false;
  let lastPivotY = 0;
  let badgeEl = null;

  controls.minDistance = MIN_DIST;
  controls.maxDistance = MAX_DIST;
  controls.enableZoom = false;
  controls.screenSpacePanning = true;

  function syncFlyAnglesFromCamera() {
    _offset.subVectors(camera.position, controls.target);
    if (_offset.lengthSq() < 1e-8) {
      flyYaw = camera.rotation.y;
      flyPitch = camera.rotation.x;
      return;
    }
    flyYaw = Math.atan2(_offset.x, _offset.z);
    flyPitch = Math.asin(
      THREE.MathUtils.clamp(_offset.y / _offset.length(), -1, 1),
    );
  }

  function showBadge(on) {
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.id = "editor-fly-badge";
      badgeEl.style.cssText = [
        "position:fixed",
        "top:52px",
        "left:50%",
        "transform:translateX(-50%)",
        "z-index:6",
        "display:none",
        "pointer-events:none",
        "font-family:system-ui,sans-serif",
        "font-size:10px",
        "font-weight:600",
        "letter-spacing:0.14em",
        "text-transform:uppercase",
        "color:#c8e8ff",
        "padding:6px 12px",
        "border-radius:999px",
        "background:rgba(8,16,28,0.82)",
        "border:1px solid rgba(100,180,255,0.35)",
      ].join(";");
      badgeEl.textContent = "Fly · WASD · QE up/down · RMB look · ` exit";
      document.body.appendChild(badgeEl);
    }
    badgeEl.style.display = on ? "block" : "none";
  }

  function setFlyMode(on) {
    if (flyMode === on) return;
    flyMode = on;
    if (flyMode) {
      syncFlyAnglesFromCamera();
      controls.enabled = false;
      domElement.style.cursor = "crosshair";
    } else {
      controls.target.copy(camera.position).add(
        _dir.set(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(20),
      );
      controls.enabled = isActive();
      domElement.style.cursor = "";
    }
    showBadge(flyMode);
  }

  function focusOnPoint(point, { distance } = {}) {
    if (!point) return false;
    _offset.subVectors(camera.position, controls.target);
    let dist =
      distance ??
      (_offset.length() > MIN_DIST ? _offset.length() : Math.max(MIN_DIST, 24));
    dist = THREE.MathUtils.clamp(dist, MIN_DIST, MAX_DIST);

    if (_offset.lengthSq() < 1e-6) {
      _focusDir.set(0.65, 0.35, 0.65).normalize();
    } else {
      _focusDir.copy(_offset).normalize();
    }

    controls.target.copy(point);
    camera.position.copy(point).addScaledVector(_focusDir, dist);
    controls.update();
    return true;
  }

  function focusAtCenter() {
    const rect = domElement.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const sel = getSelectionFocus?.();
    if (sel) return focusOnPoint(sel);
    const hit = pickWorldAtClient?.(cx, cy);
    if (hit?.point) return focusOnPoint(hit.point);
    return false;
  }

  function focusAtClient(clientX, clientY) {
    const hit = pickWorldAtClient?.(clientX, clientY);
    if (hit?.point) return focusOnPoint(hit.point);
    return false;
  }

  function zoom(event) {
    if (!isActive() || flyMode) return;
    if (event.shiftKey || event.altKey) return;

    event.preventDefault();
    event.stopPropagation();

    // Normalize scroll to pixels across deltaMode variants (pixel/line/page).
    const pixels =
      event.deltaMode === 1 ? event.deltaY * 32 :
      event.deltaMode === 2 ? event.deltaY * 500 :
      event.deltaY;

    // Ignore near-zero ghost events fired by trackpads at gesture boundaries.
    if (Math.abs(pixels) < 1) return;

    _offset.subVectors(camera.position, controls.target);
    const dist0 = _offset.length();

    // Smooth proportional dolly. ~100px (one mouse click) ≈ 13% closer/farther.
    // Clamped so a single fast scroll can't jump more than 20%.
    const scale = THREE.MathUtils.clamp(Math.pow(0.9985, -pixels), 0.8, 1.25);
    const dist1 = THREE.MathUtils.clamp(dist0 * scale, MIN_DIST, MAX_DIST);
    if (Math.abs(dist1 - dist0) < 1e-6) return;

    // Move camera along orbit radius. Target stays fixed — orbit pivot never drifts.
    _offset.setLength(dist1);
    camera.position.copy(controls.target).add(_offset);
    controls.update();
  }

  function onWheel(event) {
    zoom(event);
  }

  function onPointerDown(event) {
    if (!isActive() || flyMode) return;
    if (event.button === 1 && event.shiftKey) {
      shiftPivotDrag = true;
      lastPivotY = event.clientY;
      controls.enabled = false;
      event.preventDefault();
    }
  }

  function onPointerMove(event) {
    if (!shiftPivotDrag) return;
    const dy = (event.clientY - lastPivotY) * 0.08;
    lastPivotY = event.clientY;
    controls.target.y += dy;
    camera.position.y += dy;
    controls.update();
  }

  function onPointerUp() {
    if (shiftPivotDrag) {
      shiftPivotDrag = false;
      if (!flyMode && isActive()) controls.enabled = true;
    }
  }

  function onDblClick(event) {
    if (!isActive() || flyMode || event.button !== 0) return;
    if (focusAtClient(event.clientX, event.clientY)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onKeyDown(event) {
    if (event.defaultPrevented || !isActive()) return;
    if (event.target?.closest?.("input, textarea, select")) return;

    keysHeld[event.code] = true;

    if (event.code === "Backquote" && !event.repeat) {
      event.preventDefault();
      setFlyMode(!flyMode);
      return;
    }

    if (
      event.code === "Period" &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      focusAtCenter();
      return;
    }

    if (event.code === "Escape" && flyMode && !event.repeat) {
      event.preventDefault();
      setFlyMode(false);
    }
  }

  function onKeyUp(event) {
    keysHeld[event.code] = false;
  }

  function onMouseMove(event) {
    if (!flyMode || document.pointerLockElement === domElement) {
      if (flyMode && document.pointerLockElement === domElement) {
        flyYaw -= event.movementX * 0.0022;
        flyPitch -= event.movementY * 0.0022;
        flyPitch = THREE.MathUtils.clamp(flyPitch, -1.45, 1.45);
      }
      return;
    }
    if (event.buttons & 2) {
      flyYaw -= event.movementX * 0.0022;
      flyPitch -= event.movementY * 0.0022;
      flyPitch = THREE.MathUtils.clamp(flyPitch, -1.45, 1.45);
    }
  }

  function update(dtSec) {
    if (!flyMode) return;

    const sprint =
      keysHeld.ShiftLeft || keysHeld.ShiftRight ? FLY_SPRINT : 1;
    const speed = FLY_BASE_SPEED * sprint * dtSec;

    _euler.set(flyPitch, flyYaw, 0, "YXZ");
    camera.quaternion.setFromEuler(_euler);

    _flyFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _flyFwd.y = 0;
    if (_flyFwd.lengthSq() > 1e-8) _flyFwd.normalize();

    _flyRight.crossVectors(_flyFwd, _up).normalize();

    let mx = 0;
    let mz = 0;
    let my = 0;
    if (keysHeld.KeyW || keysHeld.ArrowUp) mz -= 1;
    if (keysHeld.KeyS || keysHeld.ArrowDown) mz += 1;
    if (keysHeld.KeyA || keysHeld.ArrowLeft) mx -= 1;
    if (keysHeld.KeyD || keysHeld.ArrowRight) mx += 1;
    if (keysHeld.KeyE || keysHeld.PageUp) my += 1;
    if (keysHeld.KeyQ || keysHeld.PageDown) my -= 1;

    const len = Math.hypot(mx, mz);
    if (len > 0) {
      mx /= len;
      mz /= len;
    }

    camera.position.addScaledVector(_flyFwd, mz * speed);
    camera.position.addScaledVector(_flyRight, mx * speed);
    camera.position.y += my * speed;

    controls.target
      .copy(camera.position)
      .add(_dir.set(0, 0, -1).applyQuaternion(camera.quaternion).multiplyScalar(30));
  }

  function onPlayEnter() {
    setFlyMode(false);
    shiftPivotDrag = false;
  }

  domElement.addEventListener("wheel", onWheel, { passive: false, capture: true });
  domElement.addEventListener("pointerdown", onPointerDown, { capture: true });
  domElement.addEventListener("pointermove", onPointerMove);
  domElement.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  domElement.addEventListener("dblclick", onDblClick);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);

  return {
    update,
    focusAtCenter,
    focusOnPoint,
    setFlyMode,
    get flyMode() {
      return flyMode;
    },
    onPlayEnter,
    dispose() {
      domElement.removeEventListener("wheel", onWheel, { capture: true });
      domElement.removeEventListener("pointerdown", onPointerDown, { capture: true });
      domElement.removeEventListener("pointermove", onPointerMove);
      domElement.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      domElement.removeEventListener("dblclick", onDblClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      badgeEl?.remove();
      badgeEl = null;
    },
  };
}
