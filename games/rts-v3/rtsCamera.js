// RTS camera for the v3 engine — GAME code, lives with the game project.
//
// Two modes, toggleable at runtime:
//   • "orbit" — hands control back to the engine's editor OrbitControls (good
//     for inspecting the world while building the game).
//   • "rts"   — top-down angled view: WASD / edge-scroll pan, wheel zoom,
//     Q/E rotate, and the look-point follows the terrain height.
//
// How it coexists with the engine without touching engine source:
//   • The engine streams its terrain clipmap around `controls.target` and calls
//     `controls.update()` every frame. With `controls.enabled = false` and no
//     input, that call just preserves the camera.position we set — so we drive
//     the camera each frame and keep `controls.target` on our focus point so the
//     terrain follows us.
//   • We grab the wheel event at the window-capture phase and stop it, so the
//     engine's editor-camera zoom never sees it while we're in RTS mode.
import * as THREE from "three";

const DEG = Math.PI / 180;

export function createRtsCamera({ app, edgeScroll = true } = {}) {
  const { camera, controls, getWorldHeight, worldSize } = app;

  // ── Tunables ────────────────────────────────────────────────────────────────
  const PITCH      = 55 * DEG;   // look-down angle from the horizon
  const DIST_MIN   = 30;
  const DIST_MAX   = 400;
  const PAN_BASE   = 0.9;        // world units / frame per unit of zoom distance
  const ROT_SPEED  = 1.4 * DEG;  // radians / frame while Q or E held
  const EDGE_PX    = 24;         // screen border thickness that triggers edge-scroll
  const HALF       = (worldSize ?? 1000) * 0.5;

  // ── State ───────────────────────────────────────────────────────────────────
  let mode  = "orbit";
  const focus = new THREE.Vector3(0, 0, 0); // ground point the camera looks at
  let dist  = 160;
  let yaw   = 0;                             // rotation of the view around Y
  let dragging = false;
  const keys = Object.create(null);
  const pointer = { x: 0.5, y: 0.5, inside: false };
  const _tmp = new THREE.Vector3();

  // ── Input ─────────────────────────────────────────────────────────────────
  const onKeyDown = (e) => { keys[e.code] = true; };
  const onKeyUp   = (e) => { keys[e.code] = false; };
  const onMouseMove = (e) => {
    pointer.x = e.clientX / window.innerWidth;
    pointer.y = e.clientY / window.innerHeight;
    pointer.inside = true;
  };
  const onMouseLeave = () => { pointer.inside = false; };
  // Claim the wheel at capture so the engine's editor camera never zooms while RTS-active.
  const onWheel = (e) => {
    if (mode !== "rts") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    dist = THREE.MathUtils.clamp(dist * (e.deltaY > 0 ? 1.1 : 0.9), DIST_MIN, DIST_MAX);
  };

  function bind() {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseout", onMouseLeave);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  }
  function unbind() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseout", onMouseLeave);
    window.removeEventListener("wheel", onWheel, { capture: true });
  }

  // ── Per-frame drive (our own rAF; independent of the engine's render loop) ──
  function tick() {
    if (mode === "rts") drive();
    raf = requestAnimationFrame(tick);
  }

  function drive() {
    // Pan speed scales with zoom so it feels constant on screen.
    const pan = PAN_BASE * (dist / 100);
    // Forward/right on the ground plane, rotated by yaw.
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);

    let mf = 0, mr = 0;
    if (keys.KeyW || keys.ArrowUp)    mf += 1;
    if (keys.KeyS || keys.ArrowDown)  mf -= 1;
    if (keys.KeyD || keys.ArrowRight) mr += 1;
    if (keys.KeyA || keys.ArrowLeft)  mr -= 1;

    if (edgeScroll && pointer.inside) {
      if (pointer.y < EDGE_PX / window.innerHeight) mf += 1;
      if (pointer.y > 1 - EDGE_PX / window.innerHeight) mf -= 1;
      if (pointer.x > 1 - EDGE_PX / window.innerWidth) mr += 1;
      if (pointer.x < EDGE_PX / window.innerWidth) mr -= 1;
    }

    if (keys.KeyQ) yaw -= ROT_SPEED;
    if (keys.KeyE) yaw += ROT_SPEED;

    focus.x = THREE.MathUtils.clamp(focus.x + (fx * mf + rx * mr) * pan, -HALF, HALF);
    focus.z = THREE.MathUtils.clamp(focus.z + (fz * mf + rz * mr) * pan, -HALF, HALF);
    focus.y = getWorldHeight ? getWorldHeight(focus.x, focus.z) : 0;

    // Place the camera behind/above the focus at the fixed pitch.
    const horiz  = dist * Math.cos(PITCH);
    const height = dist * Math.sin(PITCH);
    camera.position.set(
      focus.x - Math.sin(yaw) * horiz,
      focus.y + height,
      focus.z - Math.cos(yaw) * horiz,
    );
    camera.lookAt(focus);
    controls.target.copy(focus); // keep the terrain clipmap centred on us
  }

  // ── Mode switching ──────────────────────────────────────────────────────────
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    if (mode === "rts") {
      // Seed the focus from wherever the orbit camera was looking.
      focus.copy(controls.target);
      focus.y = getWorldHeight ? getWorldHeight(focus.x, focus.z) : focus.y;
      dist = THREE.MathUtils.clamp(camera.position.distanceTo(focus), DIST_MIN, DIST_MAX);
      controls.enabled = false;
      drive(); // apply immediately so there's no one-frame jump
    } else {
      // Hand control back to the engine's OrbitControls.
      controls.target.copy(focus);
      controls.enabled = true;
      controls.update?.();
    }
  }
  const toggle = () => setMode(mode === "rts" ? "orbit" : "rts");
  const getMode = () => mode;

  bind();
  let raf = requestAnimationFrame(tick);

  return {
    setMode,
    toggle,
    getMode,
    /** Recentre the view on a world point (e.g. jump to a selected unit). */
    focusOn(x, z) { focus.set(x, 0, z); focus.y = getWorldHeight ? getWorldHeight(x, z) : 0; },
    dispose() { cancelAnimationFrame(raf); unbind(); },
  };
}
