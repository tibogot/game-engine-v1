// The debug orbit cam (C): drive the car AND look at it from any angle at once.
//
// What actually needs guarding is the GEOMETRY, and one property in particular:
// the WORLD frame must not rotate with the car. That is the whole reason the rig
// exists — you park it side-on and watch the car pitch and roll THROUGH the view
// while reading the horizon behind it. If the azimuth quietly rode the car's
// heading, the car would sit at a fixed on-screen angle and the camera would be
// worth nothing for exactly the job it was built for.
//
// The mouse handlers are not covered here (they are three lines of arithmetic
// behind a DOM event); the frames, presets and the switch between them are.
import * as THREE from "three";
import { createDebugCamera } from "../games/modular-road-v3/debugCamera.js";

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const R2D = 180 / Math.PI;

/** Minimal DOM stub — the rig only ever adds/removes listeners on it. */
const stubDom = () => ({
  addEventListener() {}, removeEventListener() {},
  setPointerCapture() {}, releasePointerCapture() {},
});
/** Records what the rig binds, and lets a test fire a synthetic event at it. */
function stubRoot() {
  const bound = [];
  return {
    bound,
    addEventListener(type, fn, opts) { bound.push({ type, fn, opts }); },
    removeEventListener(type, fn) {
      const i = bound.findIndex((b) => b.type === type && b.fn === fn);
      if (i >= 0) bound.splice(i, 1);
    },
    /** Dispatch to every handler registered for `type`. */
    fire(type, ev) {
      let calls = 0;
      for (const b of bound) if (b.type === type) { b.fn(ev); calls++; }
      return calls;
    },
  };
}
/** A wheel event good enough for the handler: it only reads these fields. */
const wheelEv = (deltaY, target, deltaMode = 0) => {
  const e = { deltaY, deltaMode, target, defaultPrevented: false, stopped: false };
  e.preventDefault = () => { e.defaultPrevented = true; };
  e.stopImmediatePropagation = () => { e.stopped = true; };
  return e;
};

/** A stand-in car we can pose and move by hand. */
function makeCar() {
  return {
    body: {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
    },
    get renderPos() { return this.body.pos; },
    get renderQuat() { return this.body.quat; },
  };
}
function makeRig(active = true) {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const vehicle = makeCar();
  const domElement = stubDom();
  const root = stubRoot();
  const cam = createDebugCamera({
    camera, vehicle, domElement, isActive: () => active, eventRoot: root,
  });
  cam._testRoot = root;
  cam._testDom = domElement;
  // Settle the input smoothing so a single update lands on the requested angle.
  const settle = (n = 60) => { for (let i = 0; i < n; i++) cam.update(1 / 60); };
  return { camera, vehicle, cam, settle };
}
/** Horizontal bearing from the car to the camera, degrees. */
const bearing = (camera, vehicle) => {
  const d = camera.position.clone().sub(vehicle.body.pos);
  return Math.atan2(d.x, d.z) * R2D;
};

console.log("=== IT FOLLOWS THE CAR, NOT A FIXED POINT ===");
// This is what `freeLook` + OrbitControls could not do: OrbitControls copies its
// target from the car once and then orbits a stale world point, so the car drives
// out of frame. The whole feature is that the target keeps up.
{
  const { camera, vehicle, cam, settle } = makeRig();
  cam.enter();
  settle();
  const d0 = camera.position.distanceTo(vehicle.body.pos);
  // Drive a long way, in a direction that is not an axis.
  vehicle.body.pos.set(413, 27, -268);
  vehicle.body.vel.set(30, 0, -18);
  settle();
  const d1 = camera.position.distanceTo(vehicle.body.pos);
  check(
    "the camera holds its distance after the car travels 500 m",
    near(d0, d1, 0.01),
    `${d0.toFixed(2)} m → ${d1.toFixed(2)} m`,
  );
  // And it is genuinely LOOKING at the car, not merely near it.
  const view = new THREE.Vector3();
  camera.getWorldDirection(view);
  const toCar = vehicle.body.pos.clone().sub(camera.position).normalize();
  check("and it is still aimed at the car", view.dot(toCar) > 0.9999,
    `view·toCar = ${view.dot(toCar).toFixed(5)}`);
}

console.log("\n=== ZERO FOLLOW LAG — THE CAR STAYS PINNED IN FRAME ===");
// Deliberately rigid, not smoothed. A smoothed follow lags a target moving at
// constant v by v/lerp, and that lag reads as the car sliding around in frame
// while the horizon swims — which is the exact signal you are trying to judge.
{
  const { camera, vehicle, cam } = makeRig();
  cam.enter();
  cam.update(1 / 60);
  let worst = 0;
  // Accelerate hard and turn — the case where a smoothed rig loses the target.
  for (let i = 0; i < 240; i++) {
    vehicle.body.vel.set(Math.sin(i / 40) * 60, 0, 50);
    vehicle.body.pos.addScaledVector(vehicle.body.vel, 1 / 60);
    cam.update(1 / 60);
    const view = new THREE.Vector3();
    camera.getWorldDirection(view);
    const toCar = vehicle.body.pos.clone().sub(camera.position).normalize();
    worst = Math.max(worst, Math.acos(THREE.MathUtils.clamp(view.dot(toCar), -1, 1)) * R2D);
  }
  check("the car never leaves the centre of frame, even at 60 m/s through a swerve",
    worst < 0.01, `worst off-centre ${worst.toFixed(4)}°`);
}

console.log("\n=== WORLD FRAME: THE VIEW ANGLE DOES NOT RIDE THE CAR ===");
{
  const { camera, vehicle, cam, settle } = makeRig();
  cam.enter();
  cam.preset("left");
  settle();
  const b0 = bearing(camera, vehicle);
  // Spin the car through a full circle of headings — and give it matching
  // velocity, since that is what the CAR frame reads its heading from.
  let worst = 0;
  for (let deg = 0; deg <= 360; deg += 15) {
    const a = deg / R2D;
    vehicle.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
    vehicle.body.vel.set(Math.sin(a) * 40, 0, Math.cos(a) * 40);
    settle(4);
    let d = bearing(camera, vehicle) - b0;
    if (d > 180) d -= 360; if (d < -180) d += 360;
    worst = Math.max(worst, Math.abs(d));
  }
  check(
    "the camera stays on the same side of the WORLD as the car spins 360°",
    worst < 0.5,
    `bearing moved at most ${worst.toFixed(2)}°`,
  );
}

console.log("\n=== CAR FRAME: THE VIEW ANGLE DOES RIDE THE CAR ===");
{
  const { camera, vehicle, cam, settle } = makeRig();
  cam.enter();
  check("default frame is WORLD — the one that reads attitude", cam.frame === "world", cam.frame);
  cam.toggleFrame();
  check("V switches to CAR", cam.frame === "car", cam.frame);
  cam.preset("left");
  settle();
  let worst = 0;
  for (const deg of [0, 45, 90, 180, 270]) {
    const a = deg / R2D;
    vehicle.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
    vehicle.body.vel.set(Math.sin(a) * 40, 0, Math.cos(a) * 40);
    settle();
    // In CAR frame the bearing must track the heading one-for-one. The constant
    // is the same one the WORLD-frame preset check above pins down: preset
    // "left" reads as a bearing of −90° for a car facing +Z (heading 0), i.e.
    // heading + 270. Anything other than a pure one-for-one offset shows up as a
    // heading-DEPENDENT error, which is what this is actually testing.
    let d = bearing(camera, vehicle) - deg - 270;
    while (d > 180) d -= 360; while (d < -180) d += 360;
    worst = Math.max(worst, Math.abs(d));
  }
  check(
    "the camera holds the same angle RELATIVE TO THE CAR as it turns",
    worst < 0.5,
    `off by at most ${worst.toFixed(2)}°`,
  );
}

console.log("\n=== SWITCHING FRAMES DOES NOT MOVE THE CAMERA ===");
// Toggling is a debugging action taken mid-run; if it teleported the view you
// would lose whatever you were watching.
{
  const { camera, vehicle, cam, settle } = makeRig();
  vehicle.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.1);
  vehicle.body.vel.set(Math.sin(1.1) * 40, 0, Math.cos(1.1) * 40);
  cam.enter();
  cam.preset("right");
  settle();
  const before = camera.position.clone();
  cam.toggleFrame();
  settle();
  const after = camera.position.clone();
  check(
    "world → car keeps the camera exactly where it was",
    before.distanceTo(after) < 0.01,
    `moved ${before.distanceTo(after).toFixed(4)} m`,
  );
  cam.toggleFrame();
  settle();
  check(
    "and back again",
    before.distanceTo(camera.position) < 0.01,
    `moved ${before.distanceTo(camera.position).toFixed(4)} m`,
  );
}

console.log("\n=== THE CANNED ANGLES ARE THE ANGLES THEY CLAIM ===");
{
  const { camera, vehicle, cam, settle } = makeRig();
  cam.enter();
  // Behind means behind the car's facing, so point the car somewhere definite.
  vehicle.body.quat.identity();          // facing +Z
  vehicle.body.vel.set(0, 0, 40);
  let ok = true;
  const rows = [];
  // In WORLD frame the presets are world bearings measured from "behind a car
  // facing +Z", i.e. the −Z side.
  for (const [name, want] of [["behind", 180], ["front", 0], ["left", -90], ["right", 90]]) {
    cam.preset(name);
    settle();
    let got = bearing(camera, vehicle);
    let d = got - want;
    while (d > 180) d -= 360; while (d < -180) d += 360;
    rows.push(`${name} ${got.toFixed(0)}°`);
    if (Math.abs(d) > 0.5) ok = false;
  }
  check("1/2/3/4 put the camera behind / in front / left / right", ok, rows.join("  "));
  // Side-on at eye level is the point of the presets: a high angle hides pitch.
  cam.preset("left");
  settle();
  const rise = camera.position.y - vehicle.body.pos.y;
  check(
    "the presets sit near eye level so a pitch angle is readable as a silhouette",
    Math.abs(rise) < 1.5,
    `${rise.toFixed(2)} m above the car`,
  );
}

console.log("\n=== THE HORIZON STAYS LEVEL ===");
// camera.up must NOT roll with the car — the horizon is the reference you read
// the car's roll against. (The chase rig deliberately does the opposite.)
{
  const { camera, vehicle, cam, settle } = makeRig();
  cam.enter();
  cam.preset("left");
  let worst = 0;
  for (const deg of [0, 30, 90, 150, 179]) {
    // Roll the car about its own forward axis.
    vehicle.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), deg / R2D);
    settle();
    worst = Math.max(worst, 1 - camera.up.dot(new THREE.Vector3(0, 1, 0)));
  }
  check("camera.up stays world-up while the car rolls to inverted",
    worst < 1e-6, `worst deviation ${worst.toExponential(1)}`);
}

console.log("\n=== ENTERING IS CONTINUOUS, NOT A CUT ===");
// enter() re-seeds from wherever the chase rig left the camera, so pressing C
// mid-jump does not snap you to a canned angle and lose the moment.
{
  const { camera, vehicle, cam, settle } = makeRig();
  vehicle.body.pos.set(10, 4, -30);
  const parked = new THREE.Vector3(10 + 6, 4 + 2.5, -30 - 4);
  camera.position.copy(parked);
  cam.enter();
  cam.update(1 / 60);
  check(
    "pressing C keeps the camera where the chase rig had it",
    camera.position.distanceTo(parked) < 0.01,
    `moved ${camera.position.distanceTo(parked).toFixed(4)} m`,
  );
  // And it must stay there rather than easing to a default over the next second.
  settle();
  check("and it stays there", camera.position.distanceTo(parked) < 0.01,
    `drifted ${camera.position.distanceTo(parked).toFixed(4)} m after 1 s`);
}

console.log("\n=== ZOOM ACTUALLY MOVES THE CAMERA ===");
// This shipped BROKEN and the first version of this test did not catch it,
// because it only asserted the LIMITS were sane and never that a scroll changed
// anything. It didn't: v2/app/editorCameraController.js binds wheel on the
// canvas with capture:true at engine boot and stopPropagation()s every plain
// scroll, so the rig's own canvas listener was never called. Measured in the
// live page: 15 wheel events, distance 8.15 m → 8.15 m → 8.15 m.
{
  const { camera, vehicle, cam, settle } = makeRig();
  cam.enter();
  settle();
  const d0 = camera.position.distanceTo(vehicle.body.pos);
  cam.zoomBy(6);
  settle();
  const dOut = camera.position.distanceTo(vehicle.body.pos);
  cam.zoomBy(-12);
  settle();
  const dIn = camera.position.distanceTo(vehicle.body.pos);
  check("zooming out moves the camera away", dOut > d0 * 1.3,
    `${d0.toFixed(2)} m → ${dOut.toFixed(2)} m`);
  check("zooming in brings it back past where it started", dIn < d0 * 0.8,
    `${dOut.toFixed(2)} m → ${dIn.toFixed(2)} m`);
  check("and it is still aimed at the car after zooming", (() => {
    const v = new THREE.Vector3(); camera.getWorldDirection(v);
    return v.dot(vehicle.body.pos.clone().sub(camera.position).normalize()) > 0.9999;
  })());
}

console.log("\n=== THE WHEEL IS BOUND WHERE IT CANNOT BE STOLEN ===");
// The fix is not "add a listener", it is WHERE. Binding on the canvas puts this
// rig behind an engine listener that swallows the event; binding on window at
// CAPTURE puts it in front. games/rts-v3/rtsCamera.js does the same thing for
// the same reason. If someone "tidies" this back onto the canvas, this fails.
{
  const { cam } = makeRig();
  const w = cam._testRoot.bound.find((b) => b.type === "wheel");
  check("the wheel handler is bound on the event root, not the canvas", !!w);
  check("…in the CAPTURE phase, so it runs before the engine's canvas listener",
    w?.opts?.capture === true, JSON.stringify(w?.opts ?? null));
  check("…and non-passive, so it can preventDefault the page scroll",
    w?.opts?.passive === false, JSON.stringify(w?.opts ?? null));
}

console.log("\n=== A SCROLL OVER THE CANVAS ZOOMS; ONE OVER THE PANEL DOES NOT ===");
// Target-gated, or scrolling the dev panel would dolly the camera instead of
// scrolling the panel.
{
  const { cam, camera, vehicle, settle } = makeRig();
  cam.enter(); settle();
  const before = cam.distance;
  const onCanvas = wheelEv(300, cam._testDom);
  cam._testRoot.fire("wheel", onCanvas);
  const afterCanvas = cam.distance;
  const elsewhere = wheelEv(300, { notTheCanvas: true });
  cam._testRoot.fire("wheel", elsewhere);
  const afterPanel = cam.distance;
  check("a scroll over the render canvas zooms", afterCanvas > before,
    `${before.toFixed(2)} m → ${afterCanvas.toFixed(2)} m`);
  check("and it is consumed, so the editor camera cannot also dolly",
    onCanvas.stopped && onCanvas.defaultPrevented);
  check("a scroll anywhere else is left alone", afterPanel === afterCanvas,
    `stayed ${afterPanel.toFixed(2)} m, event untouched: ${!elsewhere.stopped}`);
  check("…and is NOT swallowed, so the dev panel still scrolls", !elsewhere.stopped);
  settle();
  check("the zoom reaches the camera, not just the state",
    Math.abs(camera.position.distanceTo(vehicle.body.pos) - cam.distance) < 0.01,
    `camera ${camera.position.distanceTo(vehicle.body.pos).toFixed(2)} m vs state ${cam.distance.toFixed(2)} m`);
}

console.log("\n=== TRACKPAD deltaMode AND GHOST EVENTS ===");
{
  const { cam, settle } = makeRig();
  cam.enter(); settle();
  const d0 = cam.distance;
  // deltaMode 1 = LINES. Treated as raw pixels this would be a ~30× overshoot.
  cam._testRoot.fire("wheel", wheelEv(3, cam._testDom, 1));
  const lines = cam.distance;
  const pixels = (() => {
    const { cam: c2 } = makeRig(); c2.enter();
    c2._testRoot.fire("wheel", wheelEv(3 * 32, c2._testDom, 0));
    return c2.distance;
  })();
  check("deltaMode 1 (lines) is normalised to the same zoom as its pixel equivalent",
    Math.abs(lines - pixels) < 1e-6, `${lines.toFixed(3)} vs ${pixels.toFixed(3)}`);
  // Trackpads emit near-zero deltas at gesture boundaries.
  const before = cam.distance;
  cam._testRoot.fire("wheel", wheelEv(0.4, cam._testDom));
  check("a sub-pixel trackpad ghost event does not creep the zoom",
    cam.distance === before, `${before.toFixed(4)} → ${cam.distance.toFixed(4)}`);
  void d0;
}

console.log("\n=== ZOOM LIMITS ===");
{
  const { camera, vehicle, cam, settle } = makeRig();
  cam.enter();
  cam.recenter();
  settle();
  const d = camera.position.distanceTo(vehicle.body.pos);
  check("recentre puts the car back at the centre of the orbit",
    d > cam.params.minDist - 1e-6 && d < cam.params.maxDist,
    `${d.toFixed(2)} m, limits ${cam.params.minDist}–${cam.params.maxDist} m`);
  check("the near limit is close enough to inspect a wheel", cam.params.minDist <= 1.5,
    `${cam.params.minDist} m`);
  check("the far limit covers a whole jump", cam.params.maxDist >= 100,
    `${cam.params.maxDist} m`);
  cam.zoomBy(-500);
  check("zooming in forever stops at the near limit", cam.distance === cam.params.minDist,
    `${cam.distance} m`);
  cam.zoomBy(500);
  check("and out forever stops at the far limit", cam.distance === cam.params.maxDist,
    `${cam.distance} m`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
