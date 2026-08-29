// Diagnostic: why do the WHEEL MESHES sink into the ground?
//
// Visible now that the debug orbit cam (C) can sit at ground level. The physics
// is fine — this is entirely about where syncVisuals() DRAWS the wheel, which is
// a different calculation from where the tyre force is applied.
//
// syncVisuals places each wheel at `hub - suspExt` along chassis-up. That
// USED to be `clamp(_smoothDist - radius, minSuspExt, maxDroop)`, and both ends
// of the clamp plus the easing could each put the tyre under the road:
//   • `_smoothDist` eases at suspVisSmooth, so on rising ground the mesh lags
//     the contact the tyre has already found;
//   • `minSuspExt` was a FLOOR, and a floor can only push the wheel DOWN.
// Now the wheel is clamped to its measured contact and the BODY lifts to keep
// the arch gap — see TIRE.archLiftBody. This measures both sides of that trade
// so neither can be fixed at the other's expense.
//
// An instrument, not a pass/fail test. The assertions live in wheelVisualTest.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.wheelsink.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/**
 * Heightfield ground, queried exactly the way v3's real terrain adapter does it
 * (vertical projection at the ray origin's XZ, `vertDist >= -1` window) — see
 * createVehicleGround in v3/play/modularRoadGround.js.
 */
function makeGround(H) {
  const n = new THREE.Vector3();
  const normalAt = (x, z, eps = 0.6) => {
    const hL = H(x - eps, z), hR = H(x + eps, z);
    const hD = H(x, z - eps), hU = H(x, z + eps);
    return n.set(-(hR - hL) / (2 * eps), 1, -(hU - hD) / (2 * eps)).normalize();
  };
  return {
    baked: true,
    raycastFirst(o, d, far) {
      const y = H(o.x, o.z);
      const vert = o.y - y;
      if (vert > far || vert < -1.0) return null;
      const nn = normalAt(o.x, o.z);
      return { distance: vert, point: { x: o.x, y, z: o.z }, normal: { x: nn.x, y: nn.y, z: nn.z } };
    },
    spherecast() { return null; },
    closestPointWithNormal() { return null; },
  };
}

const _ax = new THREE.Vector3();
/**
 * Lowest world-Y of the DRAWN wheel disc.
 *
 * A disc of radius r about unit axle `a` reaches r·sqrt(1 − a.y²) below its
 * centre — not r, which would over-report the sink whenever the car is rolled.
 */
function wheelBottomY(vehicle, i, W) {
  const g = vehicle.tireGroups[i];
  _ax.set(1, 0, 0).applyQuaternion(g.quaternion);
  return g.position.y - W.radius * Math.sqrt(Math.max(0, 1 - _ax.y * _ax.y));
}

/**
 * Drive forward over `H` and report the deepest the drawn wheels ever sink.
 * @returns {{worst:number, atFlat:number, worstWheel:string}}
 */
function drive(H, {
  M = { Vehicle, TIRE, WHEEL, FIXED_DT },
  secs = 4, throttle = 1, startZ = -12, startSpeed = 12,
  dropFrom = 0, pitchTo = 0, ignoreBefore = 0,
}) {
  const ground = makeGround(H);
  const c = new M.Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.getFloorY = null;
  c.body.pos.set(0, H(0, startZ) + 0.7 + dropFrom, startZ);
  c.body.vel.set(0, 0, startSpeed);
  // Start already aligned to the surface, so a STEADY slope run measures the
  // steady state rather than the car pitching up onto it.
  c.body.quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitchTo);

  let worst = 0, worstWheel = "";
  const n = Math.round(secs / M.FIXED_DT);
  let worstArch = 0;
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    c.syncVisuals(M.FIXED_DT, 1);
    const t = i * M.FIXED_DT;
    if (t < ignoreBefore) continue; // let the car settle first
    for (let w = 0; w < 4; w++) {
      const g = c.tireGroups[w];
      const surf = H(g.position.x, g.position.z);
      const sink = surf - wheelBottomY(c, w, M.WHEEL);
      if (sink > worst) { worst = sink; worstWheel = c.tires[w].name; }
      // ARCH INTRUSION: how far the tyre has closed on the bodywork relative to
      // the settled pose the GLB arches were fitted around.
      //
      // MUST INCLUDE THE BODY LIFT. The gap the arch sees is wheel-to-BODY, and
      // the body is drawn `_archLift` above the physics pose — measuring
      // hub-to-wheel alone reports the fix making things worse, when what it
      // actually did was move the body out of the way.
      const gap = c.tires[w].visualExt + c._archLift;
      worstArch = Math.max(worstArch, STATIC_EXT - gap);
    }
  }
  return { worst, worstWheel, arch: worstArch };
}

const FLAT = () => 0;
const step = (h) => (x, z) => (z > 0 ? h : 0);
/** UNBROKEN constant slope — no kink anywhere along the run. */
const ramp = (deg) => {
  const k = Math.tan((deg * Math.PI) / 180);
  return (x, z) => z * k;
};
/** Flat, then a sharp break into a slope at z = 0. */
const kink = (deg) => {
  const k = Math.tan((deg * Math.PI) / 180);
  return (x, z) => (z > 0 ? z * k : 0);
};
const rad = (d) => (d * Math.PI) / 180;
const cm = (v) => `${(v * 100).toFixed(1)} cm`;
/** Suspension extension at rest — the pose the GLB arches were fitted around. */
const STATIC_EXT = 0.137;

const CASES = [
  // Steady states — the car is settled and nothing is changing.
  ["flat cruise", FLAT, { ignoreBefore: 1.0 }],
  ["steady 15°", ramp(15), { pitchTo: rad(15), ignoreBefore: 1.0 }],
  ["steady 25°", ramp(25), { pitchTo: rad(25), ignoreBefore: 1.0 }],
  // Transients — something changes under the wheel.
  ["0.10 m step", step(0.10), {}],
  ["0.20 m step", step(0.20), {}],
  ["kink into 25°", kink(25), {}],
  ["2 m drop", FLAT, { startZ: 0, startSpeed: 0, dropFrom: 2.0 }],
];

function run(label, mutate = () => {}) {
  const save = { min: TIRE.minSuspExt, smooth: TIRE.suspVisSmooth, droop: TIRE.maxDroop };
  mutate();
  const out = [];
  for (const [, H, opts] of CASES) out.push(drive(H, { ...opts }).worst);
  Object.assign(TIRE, { minSuspExt: save.min, suspVisSmooth: save.smooth, maxDroop: save.droop });
  console.log(`  ${label.padEnd(30)}` + out.map((v) => cm(v).padStart(14)).join(""));
  return out;
}

console.log("HOW FAR THE DRAWN WHEEL SINKS BELOW THE SURFACE");
console.log("(worst over the run; positive = wheel mesh is inside the ground)\n");
console.log("  " + "".padEnd(30) + CASES.map(([n]) => n.slice(0, 13).padStart(14)).join(""));
const base = run("as shipped");
run("minSuspExt = 0 (no bump stop)", () => { TIRE.minSuspExt = 0; });
run("suspVisSmooth = 1000 (no lag)", () => { TIRE.suspVisSmooth = 1000; });
run("both off", () => { TIRE.minSuspExt = 0; TIRE.suspVisSmooth = 1000; });

console.log("\n  minSuspExt is a VISUAL bump stop: it forces at least 10 cm of extension so");
console.log("  the tyre cannot ride up into an arch modelled around the settled pose. The");
console.log("  cost is paid at the other end — once the suspension compresses past it, the");
console.log(`  wheel is held DOWN, i.e. into the road. Static ride uses ~13.7 cm, so only`);
console.log(`  ~3.7 cm of compression is available before it starts biting.`);
console.log("\n  suspVisSmooth eases the drawn extension at 12/s (~83 ms). On a rising edge");
console.log("  the real contact comes up faster than the drawn wheel does.");

console.log("\n=== WHAT THE BUMP STOP IS PROTECTING (the other side of the trade) ===");
// Raising minSuspExt keeps the tyre out of the arch; lowering it keeps the tyre
// out of the road. The arch budget is what chassisModelTest.mjs checks.
{
  console.log("  minSuspExt   worst sink into ground   extension left at full compression");
  for (const v of [0, 0.04, 0.07, 0.10, 0.14]) {
    const save = TIRE.minSuspExt;
    TIRE.minSuspExt = v;
    let worst = 0;
    for (const [, H, opts] of CASES) worst = Math.max(worst, drive(H, opts).worst);
    TIRE.minSuspExt = save;
    const flag = v === save ? "   <= shipped" : "";
    console.log(`  ${v.toFixed(2)} m       ${cm(worst).padStart(10)}              ${cm(v)}${flag}`);
  }
}

// ── THE FIX, AS SHIPPED ─────────────────────────────────────────────────────
// Two parts, both in _updateWheelExtensions:
//   1. never DRAW the wheel below its own measured contact (`t.hitDistance`),
//      which kills the easing lag entirely;
//   2. when that leaves less than `minSuspExt` of arch gap, LIFT THE BODY by the
//      shortfall instead of shoving the tyre down — TIRE.archLiftBody.
// Part 1 alone just trades ground-clipping for arch-clipping; the pair is what
// removes the trade. `archLiftBody: 0` reproduces the old behaviour exactly, so
// the A/B below is the shipped knob rather than a patched source.
console.log("\n=== BEFORE / AFTER (archLiftBody 0 = the old clamp) ===");
{
  const save = TIRE.archLiftBody;
  const rowsSink = {}, rowsArch = {};
  for (const share of [0, 1]) {
    TIRE.archLiftBody = share;
    const sink = [], arch = [];
    for (const [, H, opts] of CASES) {
      const r = drive(H, { ...opts });
      sink.push(r.worst); arch.push(r.arch);
    }
    rowsSink[share] = sink; rowsArch[share] = arch;
  }
  TIRE.archLiftBody = save;
  const row = (label, vals) =>
    console.log(`  ${label.padEnd(26)}` + vals.map((v) => cm(v).padStart(14)).join(""));
  console.log("  " + "".padEnd(26) + CASES.map(([n]) => n.slice(0, 13).padStart(14)).join(""));
  console.log("  -- wheel sunk into the ground (want 0) --");
  row("archLiftBody 0 (old)", rowsSink[0]);
  row("archLiftBody 1 (now)", rowsSink[1]);
  console.log("  -- tyre inside the wheel arch (want 0) --");
  row("archLiftBody 0 (old)", rowsArch[0]);
  row("archLiftBody 1 (now)", rowsArch[1]);
  console.log("\n  Both rows go to ~0 together, which is the point: the old clamp could only");
  console.log("  ever move the problem between them. What is left on 'kink into 25°' is");
  console.log("  neither — it is the probe measuring in the hub's column while the wheel is");
  console.log("  a DISC, so at a sharp concave break the leading edge contacts first. That");
  console.log("  needs a forward circle-cast for the visual contact, not a tuning value.");
}
