// ============================================================================
// ORBIT AROUND WHAT YOU POINT AT — the maths, headless.
//
// surfaceOrbit.js takes over a middle-button drag that starts on a surface and
// rotates the camera AND OrbitControls' target rigidly about the point under
// the cursor. Three things have to hold or it is worse than the old pivot:
//
//   · the press on a surface puts the pivot ON that surface (raycast, instance-
//     aware, ground-sampler fallback, excluded objects ignored);
//   · a drag keeps the camera at its distance from the pivot and does NOT
//     re-aim at it — the view direction turns with the camera, no jump;
//   · a press on nothing is left alone, so OrbitControls behaves as before.
//
// Run:  node tools/surfaceOrbitTest.mjs
// ============================================================================
import * as THREE from "three";
import { createSurfaceOrbit } from "../games/modular-road-v3/surfaceOrbit.js";

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

// A stand-in canvas and a minimal OrbitControls: only what the module reads.
const dom = {
  rect: { left: 0, top: 0, width: 800, height: 600 },
  getBoundingClientRect() { return this.rect; },
  listeners: {},
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
  removeEventListener() {},
  setPointerCapture() {}, releasePointerCapture() {},
};
const camera = new THREE.PerspectiveCamera(60, 800 / 600, 0.5, 4096);
camera.position.set(0, 20, 60);
const controls = { target: new THREE.Vector3(0, 30, -30), minPolarAngle: 0, maxPolarAngle: Math.PI * 0.92, updates: 0,
  update() { this.updates++; camera.lookAt(this.target); } };
controls.update();

// The world: a tower as an INSTANCED box, a plain box, a hidden box, an
// excluded box, and a ground sampler at y = 0 that is not geometry.
const tower = new THREE.InstancedMesh(new THREE.BoxGeometry(20, 60, 20), new THREE.MeshBasicMaterial(), 2);
tower.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-40, 30, -40));
tower.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 30, -30));
tower.instanceMatrix.needsUpdate = true;
tower.name = "Tower";
const hidden = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial());
hidden.position.set(0, 5, 10); hidden.visible = false;
const banned = new THREE.Mesh(new THREE.BoxGeometry(200, 1, 200), new THREE.MeshBasicMaterial());
banned.position.set(0, 100, 0); banned.name = "SkyLid";
const root = new THREE.Group();
root.add(tower, hidden, banned);
root.updateMatrixWorld(true);

let orbitting = true;
const so = createSurfaceOrbit({
  camera, controls, domElement: dom,
  targets: () => [root], exclude: () => [banned],
  groundHeight: (x, z) => (Math.abs(x) < 500 && Math.abs(z) < 500 ? 0 : NaN),
  active: () => orbitting,
});
const fire = (t, e) => { for (const f of dom.listeners[t] ?? []) f(e); };
const ev = (x, y, button = 1, id = 1) => ({
  clientX: x, clientY: y, button, pointerId: id, stopped: false,
  stopImmediatePropagation() { this.stopped = true; }, preventDefault() {},
});

// ── 1. Picking ───────────────────────────────────────────────────────────────
{
  // The tower at (0,30,-30) sits in the middle of the view.
  const hit = so.pickAt(400, 300);
  check("a press in the middle hits the instanced tower", !!hit && hit.object === tower && hit.point.z > -40 && hit.point.z < -19.9,
    hit ? `${hit.object?.name} at ${hit.point.toArray().map((v) => v.toFixed(1))}` : "no hit");
  check("...with a building-sized framing radius", !!hit && hit.radius > 20 && hit.radius < 60, hit ? `${hit.radius.toFixed(1)} m` : "");
  // Straight down past the tower's foot: the hidden and excluded boxes are
  // ignored, and the sampler's ground is found by the march.
  const g = so.pickAt(400, 560);
  check("a press on the ground finds the sampler's surface, not the hidden or excluded box",
    !!g && g.object === null && Math.abs(g.point.y) < 0.05, g ? `y ${g.point.y.toFixed(3)}, object ${g.object?.name ?? "ground"}` : "no hit");
  // Up into the sky: nothing.
  const sky = so.pickAt(400, 10);
  check("a press on the sky hits nothing", sky === null);
}

// ── 2. A drag orbits about the pivot without re-aiming ───────────────────────
{
  const e = ev(400, 300);
  fire("pointerdown", e);
  check("a press on a surface takes the drag over from OrbitControls", e.stopped && so.dragging);
  const pivot = so.pivot.clone();
  const d0 = camera.position.distanceTo(pivot);
  const look0 = new THREE.Vector3(); camera.getWorldDirection(look0);
  const tgt0 = controls.target.clone();
  // The target is NOT the pivot (it is the old one), and the view was not re-aimed.
  check("...and does not move the target onto the pivot (no jump)", tgt0.distanceTo(pivot) > 1);
  const m1 = ev(500, 300); fire("pointermove", m1);
  const d1 = camera.position.distanceTo(pivot);
  const look1 = new THREE.Vector3(); camera.getWorldDirection(look1);
  check("a horizontal drag keeps the camera at its distance from the pivot", Math.abs(d1 - d0) < 1e-6, `${d0.toFixed(3)} → ${d1.toFixed(3)}`);
  check("...and turns the view with it", look1.angleTo(look0) > 0.3, `${THREE.MathUtils.radToDeg(look1.angleTo(look0)).toFixed(1)}°`);
  // The pivot stays fixed in the image: it projects to the same screen point.
  const p0 = pivot.clone().project(camera);
  check("...while the pivot stays put on screen", Math.abs(p0.x) < 0.02 && Math.abs(p0.y) < 0.02, `ndc ${p0.x.toFixed(3)}, ${p0.y.toFixed(3)}`);
  const camY = camera.position.y;
  const m2 = ev(500, 380); fire("pointermove", m2);
  check("a vertical drag changes elevation", camera.position.y !== camY && Math.abs(camera.position.distanceTo(pivot) - d0) < 1e-6);
  // Over the pole: dragging far down must not flip the camera through it.
  for (let i = 0; i < 40; i++) fire("pointermove", ev(500, 380 + i * 40));
  const up = camera.position.clone().sub(pivot).normalize().y;
  check("...but never goes over the pivot's pole", up > -0.999 && up < 0.999 && camera.up.y === 1, `dir.y ${up.toFixed(3)}`);
  fire("pointerup", ev(500, 380));
  check("the drag ends cleanly", !so.dragging);
}

// ── 3. A press on nothing is left to OrbitControls ───────────────────────────
{
  // Back to the opening pose: after forty drags downward the top of the
  // screen is not sky any more.
  camera.position.set(0, 20, 60); controls.target.set(0, 30, -30); controls.update();
  const e = ev(400, 10);
  fire("pointerdown", e);
  check("a press on the sky is not intercepted", !e.stopped && !so.dragging);
  orbitting = false;
  const e2 = ev(400, 300);
  fire("pointerdown", e2);
  check("...nor is anything while the camera is not orbiting", !e2.stopped && !so.dragging);
  orbitting = true;
  const e3 = ev(400, 300, 0);
  fire("pointerdown", e3);
  check("...nor the left button, which places pieces", !e3.stopped && !so.dragging);
}

// ── 4. Framing ───────────────────────────────────────────────────────────────
{
  camera.position.set(300, 200, 300); controls.target.set(0, 0, 0); controls.update();
  const before = so.pickAt(400, 300);
  const ok = so.frameAt(400, 300);
  check("frameAt puts the target on the surface and the camera at a fitted distance",
    ok && !!before && controls.target.distanceTo(before.point) < 1e-6,
    `target ${controls.target.toArray().map((v) => v.toFixed(1))}, dist ${camera.position.distanceTo(controls.target).toFixed(1)} m`);
  const dist = camera.position.distanceTo(controls.target);
  check("...within the fit bounds", dist >= 3 && dist <= 600, `${dist.toFixed(1)} m`);
  // Double press = frame.
  const a = ev(400, 300); fire("pointerdown", a); fire("pointerup", ev(400, 300));
  const b = ev(401, 301); fire("pointerdown", b);
  check("a double press frames rather than drags", b.stopped && !so.dragging);
}

console.log(`\n${fail ? `${fail} FAILURE(S)  ` : "ALL PASS  "}(${pass} passed)`);
process.exit(fail ? 1 : 0);
