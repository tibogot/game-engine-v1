// RTS camera for the v3 engine — GAME code, lives with the game project.
//
// Two modes, toggleable at runtime:
//   • "orbit" — hands control back to the engine's editor OrbitControls (good
//     for inspecting the world while building the game).
//   • "rts"   — top-down angled view: WASD pan, wheel zoom, Q/E rotate, and the
//     look-point eases toward terrain height (no per-frame snapping).
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
    // PITCH IS NOT ONE ANGLE. A Company-of-Heroes camera looks more HORIZONTAL
    // zoomed in, where you are among the units and want to see them, and more
    // TOP-DOWN pulled out, where you want to read the map and not have the
    // near hillside in the way. A single fixed angle has to be wrong at one
    // end; it was 40 degrees at both.
    pitchNear: 30 * DEG,  // at DIST_MIN
    pitchFar:  58 * DEG,  // at distMax
    panSpeed:  55,        // metres/SECOND at DIST_DEFAULT, scaled by zoom
    rotSpeed:  80 * DEG,  // radians/SECOND while Q or E held
    heightSmooth: 4,      // terrain-height follow rate (1/s); 0 = snap instantly
    zoomSmooth: 12,       // how fast the zoom eases to the wheel's target (1/s)
    edgeScroll: true,     // pan when the pointer rests near the viewport edge
    edgeBand:   14,       // px from the edge that starts an edge-scroll pan
    minClearance: 6,      // metres the camera keeps above the ground beneath IT
    distMax:   130,       // furthest zoom — see the note on DIST_CEILING
  };
  const DIST_MIN   = 18;   // closest zoom — near ground-level tactics
  // A hard ceiling the dev panel cannot exceed. At 280 the camera sat 180 m up
  // and saw 400 m of ground: no blade or leaf field can populate that, so the
  // whole view fell back to the terrain's grass TINT and the hand-off band
  // swept across as you panned. It is also not a view you can give orders
  // from. `params.distMax` is the live knob; this is the edge of sane.
  const DIST_CEILING = 200;
  const DIST_DEFAULT = 52; // starting zoom — close like Company of Heroes
  const HALF       = (worldSize ?? 1000) * 0.5;
  const clampDist = (d) => THREE.MathUtils.clamp(d, DIST_MIN, Math.min(params.distMax, DIST_CEILING));

  // ── State ───────────────────────────────────────────────────────────────────
  let mode  = "orbit";
  const focus = new THREE.Vector3(0, 0, 0); // ground point the camera looks at
  let focusY = 0;                            // smoothed elevation (focus.y follows this)
  let dist  = DIST_DEFAULT;
  let distTarget = DIST_DEFAULT;             // the wheel moves this; `dist` chases it
  let yaw   = 0;                             // rotation of the view around Y
  let pitch = params.pitchNear;              // derived from the zoom, see drive()
  // Pointer state for edge scrolling. `overCanvas` is what keeps the dev panel
  // from scrolling the world every time you reach for a slider: the panel
  // overlays the canvas, so moving onto it fires pointerleave here.
  let ptrX = 0, ptrY = 0, overCanvas = false;
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
    // The wheel moves the TARGET; drive() eases toward it. Stepping `dist`
    // itself made every notch a jump, which is the single thing that reads as
    // cheap next to a commercial RTS.
    distTarget = clampDist(distTarget * (e.deltaY > 0 ? 1.12 : 1 / 1.12));
  };
  const dom = () => app.renderer?.domElement ?? null;
  const onPointerMove = (e) => { ptrX = e.clientX; ptrY = e.clientY; overCanvas = true; };
  const onPointerLeave = () => { overCanvas = false; };

  function bind() {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    const el = dom();
    el?.addEventListener("pointermove", onPointerMove);
    el?.addEventListener("pointerleave", onPointerLeave);
  }
  function unbind() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("wheel", onWheel, { capture: true });
    const el = dom();
    el?.removeEventListener("pointermove", onPointerMove);
    el?.removeEventListener("pointerleave", onPointerLeave);
  }

  /**
   * Edge scroll, as every RTS has: the pointer resting within `edgeBand` px of
   * the viewport edge pans that way, ramping up across the band so a pointer
   * that merely passes the edge does not yank the view.
   * @returns {{ mf: number, mr: number }} forward / right, each -1..1
   */
  function edgePan() {
    if (!params.edgeScroll || !overCanvas) return { mf: 0, mr: 0 };
    const el = dom();
    if (!el) return { mf: 0, mr: 0 };
    const r = el.getBoundingClientRect();
    const band = Math.max(1, params.edgeBand);
    const ramp = (d) => THREE.MathUtils.clamp(1 - d / band, 0, 1);
    const mr = ramp(ptrX - r.left) * -1 + ramp(r.right - ptrX);
    const mf = ramp(ptrY - r.top) * 1 + ramp(r.bottom - ptrY) * -1;
    return { mf, mr };
  }

  // Driven by the single game loop in rtsGame.js (no self-running rAF).
  function update(dt = 0) {
    if (mode === "rts") drive(dt);
  }

  function terrainY(x, z) {
    return getWorldHeight ? getWorldHeight(x, z) : 0;
  }

  /** Frame-rate-independent ease toward sampled terrain height. */
  function easeHeight(current, target, dt) {
    if (params.heightSmooth <= 0 || dt <= 0) return target;
    const t = 1 - Math.exp(-params.heightSmooth * dt);
    return current + (target - current) * t;
  }

  /** 0 at the closest zoom, 1 at the furthest — what pitch is derived from. */
  function zoomT() {
    const hi = Math.min(params.distMax, DIST_CEILING);
    return hi > DIST_MIN ? THREE.MathUtils.clamp((dist - DIST_MIN) / (hi - DIST_MIN), 0, 1) : 0;
  }

  function drive(dt) {
    // EVERY rate below is per SECOND. They used to be per FRAME, which meant
    // the camera panned and turned at half speed on a 30 Hz machine and twice
    // as far on a 120 Hz one — the kind of bug that is invisible on the
    // machine it was written on. easeHeight already had it right.
    distTarget = clampDist(distTarget);
    dist = dt > 0 && params.zoomSmooth > 0
      ? dist + (distTarget - dist) * (1 - Math.exp(-params.zoomSmooth * dt))
      : distTarget;
    pitch = params.pitchNear + (params.pitchFar - params.pitchNear) * zoomT();

    // Pan speed scales with zoom so it feels constant on screen.
    const pan = params.panSpeed * (dist / DIST_DEFAULT) * dt;
    // Forward/right on the ground plane, rotated by yaw.
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);

    let mf = 0, mr = 0;
    if (keys.KeyW || keys.ArrowUp)    mf += 1;
    if (keys.KeyS || keys.ArrowDown)  mf -= 1;
    if (keys.KeyD || keys.ArrowRight) mr += 1;
    if (keys.KeyA || keys.ArrowLeft)  mr -= 1;
    const edge = edgePan();
    mf += edge.mf;
    mr += edge.mr;

    if (keys.KeyQ) yaw -= params.rotSpeed * dt;
    if (keys.KeyE) yaw += params.rotSpeed * dt;

    focus.x = THREE.MathUtils.clamp(focus.x + (fx * mf + rx * mr) * pan, -HALF, HALF);
    focus.z = THREE.MathUtils.clamp(focus.z + (fz * mf + rz * mr) * pan, -HALF, HALF);
    focusY = easeHeight(focusY, terrainY(focus.x, focus.z), dt);
    focus.y = focusY;

    // Place the camera behind/above the focus at the zoom's pitch.
    const horiz  = dist * Math.cos(pitch);
    const height = dist * Math.sin(pitch);
    camera.position.set(
      focus.x - Math.sin(yaw) * horiz,
      focus.y + height,
      focus.z - Math.cos(yaw) * horiz,
    );
    // The camera sits BEHIND the focus, so on a slope the ground behind can be
    // higher than the camera is — it ends up inside the hill, looking at the
    // back of it. MEASURED on nam-valley: 7.8 m of clearance on a hilltop
    // against 20 m on the flat. Ride over it instead; looking at the focus
    // afterwards means the pitch steepens slightly rather than the shot
    // breaking, which is what you want climbing a ridge.
    const under = terrainY(camera.position.x, camera.position.z) + params.minClearance;
    if (camera.position.y < under) camera.position.y = under;
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
      focusY = terrainY(focus.x, focus.z);
      focus.y = focusY;
      // Boot starts zoomed in; only adopt orbit distance when toggling back from orbit.
      dist = rtsEntered ? clampDist(camera.position.distanceTo(focus)) : DIST_DEFAULT;
      distTarget = dist;   // or the first frame would ease away from where we just put it
      rtsEntered = true;
      // The engine's editor loop re-enables `controls.enabled` every frame, so
      // disable the individual interactions too — otherwise mouse-drag orbits
      // the camera while our RTS drive fights it back.
      controls.enabled = false;
      controls.enableRotate = false;
      controls.enablePan = false;
      controls.enableZoom = false;
      drive(0); // apply immediately so there's no one-frame jump
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
    focusOn(x, z) {
      focus.set(x, 0, z);
      focusY = terrainY(x, z);
      focus.y = focusY;
    },
    getFocusY: () => focusY,
    /**
     * WHAT THE CAMERA CAN SEE, in metres of ground — the thing every distance
     * in the vegetation actually wants.
     *
     * Grass tile size, blade fade, foliage LOD steps and fade windows are all
     * really answers to "how far away is the ground I can see", and every one
     * of them is currently a constant stored per MAP. They were hand-fitted to
     * one zoom and go stale the moment the camera changes — which is how the
     * blades came to cover the bottom third of the screen and the foliage LOD
     * steps ended up nearer than the closest visible ground.
     *
     * So the camera says it once and the fields read it, instead of each of
     * them keeping its own guess.
     *
     * `nearGround` / `farGround` are horizontal distances from the camera's XZ
     * to where the bottom and top of the frustum meet FLAT ground at the focus
     * height. Flat is an approximation — real terrain rises and falls — but it
     * is a stable one, which a raycast against a moving hillside is not, and
     * LOD distances want stability more than they want the exact number.
     * Looking at or above the horizon the top ray never lands, so `farGround`
     * clamps to the camera's own far plane.
     */
    /**
     * Zoom to `t` (0 = closest, 1 = furthest — the same scale as zoomT). By
     * default it lands at once, so a scripted view (the stress benchmark, a
     * cutscene) is exact on the next frame; `snap: false` eases like the wheel.
     */
    setZoom(t, { snap = true } = {}) {
      const hi = Math.min(params.distMax, DIST_CEILING);
      distTarget = clampDist(DIST_MIN + THREE.MathUtils.clamp(t, 0, 1) * (hi - DIST_MIN));
      if (snap) dist = distTarget;
    },
    getView() {
      const halfFov = (camera.fov ?? 60) * DEG * 0.5;
      const h = Math.max(camera.position.y - focus.y, 0.01);
      const reach = (angle) => (angle > 1e-3 ? h / Math.tan(angle) : Infinity);
      return {
        focus, yaw, pitch, dist, zoomT: zoomT(),
        height: h,
        nearGround: reach(pitch + halfFov),
        farGround: Math.min(reach(pitch - halfFov), camera.far ?? 4000),
      };
    },
    dispose() { unbind(); },
  };
}
