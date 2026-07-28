// The chassis SOLID HULL and the exact capsule colliders.
//
// Two problems, one root cause. The car was collided against walls as a 1.8 ×
// 0.6 × 3.6 box — a shape chosen for ride height and for the inertia tensor,
// nowhere near the 4.85 m car you see — and that box was tested as 26 SAMPLE
// POINTS, which put the front-face samples 0.9 m apart. Everything a stunt track
// is normally made of (rails, tube shells, walls) is long enough that some
// sample always lands on it, so both stayed invisible until a 0.22 m gate post
// became solid and the car drove straight through it.
//
// So: the hull is now the silhouette, sampled on a regular grid at its own
// spacing, and round primitives skip sampling altogether.
//
// See tools/postColliderRepro.mjs for the measurements this locks in.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const TMP = join(ROOT, `.hull.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, CHASSIS, CHASSIS_HULL, SOLID, WHEEL, WHEEL_LOCAL, FIXED_DT } =
  await import(pathToFileURL(TMP).href);
// Same redirect as tools/propPhysicsTest.mjs: bare "three" is three/webgpu under
// vite but not in node, and the prop module pulls the vehicle for CHASSIS_HULL.
const PTMP = join(ROOT, `.hullp.${process.pid}.mjs`);
writeFileSync(PTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropPhysics.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', `from "./${TMP.split(/[\\/]/).pop()}"`));
const { GATE_POST_RADIUS, GATE_POST_HEIGHT } = await import(pathToFileURL(PTMP).href);
unlinkSync(PTMP); unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};
const flat = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: 0, z: o.z }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};
const car = () => {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = flat;
  c.enabled = true;
  return c;
};

console.log("=== THE HULL IS THE CAR; THE CORE BOX IS NOT ===");
{
  // Measured off the GLB in games/modular-road-v3/chassisModel.js.
  check("the hull is roughly the body's real footprint",
    CHASSIS_HULL.length > 4.5 && CHASSIS_HULL.width > 2.0,
    `${CHASSIS_HULL.width} x ${CHASSIS_HULL.height} x ${CHASSIS_HULL.length}`);
  check("...and is bigger than the core box in every axis",
    CHASSIS_HULL.width > CHASSIS.width && CHASSIS_HULL.height > CHASSIS.height
    && CHASSIS_HULL.length > CHASSIS.length);

  // THE ONE THING THE HULL MAY NOT DO. The bottom is pinned to the core box's
  // floor: SOLID.skin inflates the collider, and if that reaches the tyre
  // contact patch the car is inside every `collision: "both"` ramp it drives
  // over and gets shoved up off it. This is why the hull is the car from the
  // sills up rather than the whole body.
  const hullFloor = CHASSIS_HULL.offsetY - CHASSIS_HULL.height / 2;
  const patch = WHEEL_LOCAL[0].pos.y - WHEEL.radius;
  check("the hull floor is exactly the core box's floor",
    Math.abs(hullFloor - (-CHASSIS.height / 2)) < 1e-6, `${hullFloor.toFixed(3)}`);
  check("...which keeps the inflated collider clear of the contact patch",
    hullFloor - SOLID.skin > patch,
    `floor ${hullFloor.toFixed(2)} − skin ${SOLID.skin} = ${(hullFloor - SOLID.skin).toFixed(3)} > patch ${patch.toFixed(2)}`);

  // Growing the hull must NOT have retuned the car. The inertia tensor comes off
  // CHASSIS, and that is the whole point of keeping the two shapes apart.
  const src = readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8");
  check("inertia is still derived from the CORE box, not the hull",
    /_setInertia\(CHASSIS\.mass, CHASSIS\)/.test(src));
  check("deck corners are still the CORE box, so landings are unchanged",
    !/CHASSIS_HULL/.test(src.slice(src.indexOf("_refreshLocalFrames() {"),
      src.indexOf("_refreshHullSamples() {"))));
}

console.log("\n=== SAMPLE SPACING IS A COLLIDER SIZE LIMIT ===");
{
  const c = car();
  const n = c.SOLID_BOX_SAMPLES.length;
  check("the hull is sampled on a grid, not on 26 landmarks", n > 100, `${n} samples`);

  // Every sample is a sphere of `skin`. The largest gap between neighbours is
  // what decides the thinnest wall that can still be seen — state it as the
  // measurable it is rather than trusting the grid maths.
  let worst = 0;
  for (const a of c.SOLID_BOX_SAMPLES) {
    let nearest = Infinity;
    for (const b of c.SOLID_BOX_SAMPLES) {
      if (a === b) continue;
      nearest = Math.min(nearest, a.distanceTo(b));
    }
    worst = Math.max(worst, nearest);
  }
  check("no sample is further than the configured spacing from a neighbour",
    worst <= CHASSIS_HULL.sampleSpacing + 1e-6,
    `worst ${worst.toFixed(3)} <= ${CHASSIS_HULL.sampleSpacing}`);
  // A guardrail post is the thinnest TRIANGLE geometry a track actually has.
  const railPostReach = 0.16 + SOLID.skin;
  check("a guardrail post is still thicker than the sample gap",
    worst < 2 * railPostReach, `${worst.toFixed(2)} < ${(2 * railPostReach).toFixed(2)}`);

  // Sampling has a floor no spacing removes, which is exactly why round
  // primitives do not go through it.
  check("a gate post is NOT — which is why it must be a capsule",
    2 * (GATE_POST_RADIUS + SOLID.skin) < worst,
    `post reaches ${(2 * (GATE_POST_RADIUS + SOLID.skin)).toFixed(2)}, gap ${worst.toFixed(2)}`);
}

console.log("\n=== AN EXACT CAPSULE HAS NO THINNESS LIMIT ===");
{
  /** Roll the car at the post from `offset` to the side, and report contact. */
  const ram = (offset, speed) => {
    const c = car();
    c.body.pos.set(0, 0.5, 0);
    const drive = (t) => c.tick({ steerTarget: 0, throttle: t, handbrake: false, yaw: 0, pitch: 0 });
    // Accelerate honestly — a car spawned AT speed with stationary wheels is at
    // 100% slip and the tyre model brakes it to a crawl before it arrives.
    for (let i = 0; i < 40 / FIXED_DT && -c.body.vel.z < speed; i++) drive(1);
    if (-c.body.vel.z < speed - 1) return null;
    const pz = c.body.pos.z - 14; // forward is −Z at the default spawn pose
    c.setSolidCapsules([{
      a: new THREE.Vector3(offset, 0, pz),
      b: new THREE.Vector3(offset, GATE_POST_HEIGHT, pz),
      radius: GATE_POST_RADIUS,
    }]);
    let touched = false;
    for (let i = 0; i < 6 / FIXED_DT && c.body.pos.z > pz - 8; i++) {
      drive(1);
      if (c._solidTouch) touched = true;
    }
    return touched;
  };

  // Sweep across the car, INCLUDING the offsets that fall between sample
  // columns — those are the ones the sampled path missed 11 times in 14.
  let hits = 0, runs = 0, ran = true;
  for (const off of [0, 0.2, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    for (const sp of [10, 30]) {
      const r = ram(off, sp);
      if (r === null) { ran = false; continue; }
      runs++;
      if (r) hits++;
    }
  }
  check("the harness actually got the car up to speed", ran && runs === 14, `${runs} runs`);
  check("EVERY approach to a capsule post registers, at every offset and speed",
    hits === runs, `${hits}/${runs}`);

  // And it must not invent contacts either — a post the car misses is a miss.
  const clear = ram(CHASSIS_HULL.width / 2 + 1.0, 20);
  check("a post the car passes wide of is not a phantom hit", clear === false);
}

console.log("\n=== THE CAPSULE PATH IS NOT GATED ON THERE BEING A BVH ===");
{
  // _resolveSolids used to be called only when a static solids BVH was baked,
  // which silently disabled capsules AND the dynamic movers on any track with no
  // static solids at all.
  const src = readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8");
  check("the substep gate no longer demands solidsBvh",
    !/if \(SOLID\.enabled && this\.solidsBvh && this\.solidsBvh\.baked\) this\._resolveSolids/.test(src));

  const c = car();
  c.solidsBvh = null;
  c.body.pos.set(0, 0.5, 0);
  c.setSolidCapsules([{
    a: new THREE.Vector3(0, 0, -6), b: new THREE.Vector3(0, 2, -6), radius: 0.4,
  }]);
  let touched = false;
  for (let i = 0; i < 8 / FIXED_DT; i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (c._solidTouch) touched = true;
  }
  check("a capsule blocks the car with no solids BVH present at all", touched);
}

console.log("\n=== A FAILED NUDGE MUST ESCALATE, NOT LOOP ===");
{
  // The stuck-recovery nudge throws the car upward, which for the length of the
  // hop looks exactly like getting free — so the timer drained, `_stuckNudged`
  // re-armed, and a car could bounce on the same rail forever without ever
  // reaching the respawn. Sizing rule, not a feel number.
  const src = readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8");
  const nudgeAfter = Number(/nudgeAfter: ([\d.]+)/.exec(src)[1]);
  const nudgeHold = Number(/nudgeHold: ([\d.]+)/.exec(src)[1]);
  const respawnAfter = Number(/respawnAfter: ([\d.]+)/.exec(src)[1]);
  check("one failed nudge reaches the respawn on its own",
    nudgeAfter + nudgeHold > respawnAfter,
    `${nudgeAfter} + ${nudgeHold} > ${respawnAfter}`);
  check("the hold outlasts the hop it is there to cover",
    nudgeHold > 2 * 3.5 / 9.81, `${nudgeHold} > ${(2 * 3.5 / 9.81).toFixed(2)}s of flight`);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
