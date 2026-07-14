// RTS camera for the v3 engine — GAME code, lives with the game project.
//
// Two modes, toggleable at runtime:
//   • "orbit" — hands control back to the engine's editor OrbitControls (good
//     for inspecting the world while building the game).
//   • "rts"   — top-down angled view: WASD pan, wheel zoom, Q/E rotate, and the
//     look-point follows the terrain height.
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

export function createRtsCamera({ app } = {}) {
  const { camera, controls, getWorldHeight, worldSize } = app;

  // ── Tunables (live-editable from the dev panel via the returned `params`) ────
  const params = {
    pitch:    40 * DEG,   // look-down angle — CoH-style tactical view
    panSpeed: 0.9,        // world units / frame per unit of zoom distance
    rotSpeed: 1.4 * DEG,  // radians / frame while Q or E held
  };
  const DIST_MIN   = 18;   // closest zoom — near ground-level tactics
  const DIST_MAX   = 280;
  const DIST_DEFAULT = 52; // starting zoom — close like Company of Heroes
  const HALF       = (worldSize ?? 1000) * 0.5;

  // ── State ───────────────────────────────────────────────────────────────────
  let mode  = "orbit";
  const focus = new THREE.Vector3(0, 0, 0); // ground point the camera looks at
  let dist  = DIST_DEFAULT;
  let yaw   = 0;                             // rotation of the view around Y
  let rtsEntered = false; // first RTS entry keeps DIST_DEFAULT; orbit→rts adopts zoom
  const keys = Object.create(null);

  // ── Input ─────────────────────────────────────────────────────────────────
  const onKeyDown = (e) => { keys[e.code] = true; };
  const onKeyUp   = (e) => { keys[e.code] = false; };
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
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  }
  function unbind() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("wheel", onWheel, { capture: true });
  }

  // Driven by the single game loop in rtsGame.js (no self-running rAF).
  function update() {
    if (mode === "rts") drive();
  }

  function drive() {
    // Pan speed scales with zoom so it feels constant on screen.
    const pan = params.panSpeed * (dist / 100);
    // Forward/right on the ground plane, rotated by yaw.
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);

    let mf = 0, mr = 0;
    if (keys.KeyW || keys.ArrowUp)    mf += 1;
    if (keys.KeyS || keys.ArrowDown)  mf -= 1;
    if (keys.KeyD || keys.ArrowRight) mr += 1;
    if (keys.KeyA || keys.ArrowLeft)  mr -= 1;

    if (keys.KeyQ) yaw -= params.rotSpeed;
    if (keys.KeyE) yaw += params.rotSpeed;

    focus.x = THREE.MathUtils.clamp(focus.x + (fx * mf + rx * mr) * pan, -HALF, HALF);
    focus.z = THREE.MathUtils.clamp(focus.z + (fz * mf + rz * mr) * pan, -HALF, HALF);
    focus.y = getWorldHeight ? getWorldHeight(focus.x, focus.z) : 0;

    // Place the camera behind/above the focus at the fixed pitch.
    const horiz  = dist * Math.cos(params.pitch);
    const height = dist * Math.sin(params.pitch);
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
      // Boot starts zoomed in; only adopt orbit distance when toggling back from orbit.
      if (rtsEntered) {
        dist = THREE.MathUtils.clamp(camera.position.distanceTo(focus), DIST_MIN, DIST_MAX);
      } else {
        dist = DIST_DEFAULT;
      }
      rtsEntered = true;
      // The engine's editor loop re-enables `controls.enabled` every frame, so
      // disable the individual interactions too — otherwise mouse-drag orbits
      // the camera while our RTS drive fights it back.
      controls.enabled = false;
      controls.enableRotate = false;
      controls.enablePan = false;
      controls.enableZoom = false;
      drive(); // apply immediately so there's no one-frame jump
    } else {
      // Hand control back to the engine's OrbitControls.
      controls.target.copy(focus);
      controls.enabled = true;
      controls.enableRotate = true;
      controls.enablePan = true;
      controls.enableZoom = true;
      controls.update?.();
    }
  }
  const toggle = () => setMode(mode === "rts" ? "orbit" : "rts");
  const getMode = () => mode;

  bind();

  return {
    params, // live-editable { pitch, panSpeed, rotSpeed } for the dev panel
    update, // called by the game loop
    setMode,
    toggle,
    getMode,
    /** Recentre the view on a world point (e.g. jump to a selected unit). */
    focusOn(x, z) { focus.set(x, 0, z); focus.y = getWorldHeight ? getWorldHeight(x, z) : 0; },
    dispose() { unbind(); },
  };
}
