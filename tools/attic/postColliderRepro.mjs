// Diagnostic: WHY does the car drive through the swing gate's hinge post, even
// though the post is now in the static solids bake and draws in the wireframe?
//
// Hypothesis under test: the chassis is collided as 26 SAMPLE POINTS on an
// oriented box (8 corners + 12 edge midpoints + 6 face centres), each tested as
// a small sphere of radius `band` against the BVH. On a 1.8 m wide box the front
// face samples sit at x = −0.9, 0, +0.9 — 0.9 m apart. A post is 0.22 m across.
// It fits BETWEEN the samples, so nothing ever reports a contact.
//
// Long walls (rails, tube shells) are immune because every sample lands on them,
// which is why this never showed up before something genuinely thin was solid.
//
// Not pass/fail — an instrument. Run it, read the table.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.postrepro.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, SOLID, CHASSIS, CHASSIS_HULL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { GATE_POST_RADIUS, GATE_POST_HEIGHT } =
  await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPropPhysics.js")).href)
    .catch(() => ({ GATE_POST_RADIUS: 0.11, GATE_POST_HEIGHT: 1.9 }));

console.log("=== SETUP ===");
console.log(`  CHASSIS ${CHASSIS.width} x ${CHASSIS.height} x ${CHASSIS.length}`);
console.log(`  SOLID.skin ${SOLID.skin}  sweepMargin ${SOLID.sweepMargin}`);
console.log(`  post radius ${GATE_POST_RADIUS} (diameter ${(2 * GATE_POST_RADIUS).toFixed(2)} m), height ${GATE_POST_HEIGHT}`);

// ── THE SAMPLE GRID, STATED PLAINLY ─────────────────────────────────────────
{
  const xs = [-CHASSIS.width / 2, 0, CHASSIS.width / 2];
  console.log("\n=== FRONT-FACE SAMPLE SPACING vs POST WIDTH ===");
  console.log(`  samples across the front face at x = ${xs.join(", ")}`);
  const gap = CHASSIS.width / 2;
  const reach = GATE_POST_RADIUS + SOLID.skin;
  console.log(`  gap between adjacent samples   ${gap.toFixed(2)} m`);
  console.log(`  post half-width + skin         ${reach.toFixed(2)} m`);
  console.log(`  => a post can hide in the gap: ${reach < gap / 2 ? "YES" : "no"}`
    + `  (needs ${reach.toFixed(2)} < ${(gap / 2).toFixed(2)})`);
}

/** Where the post stands. Mutable, so a run can place it ahead of a car that is
 *  already up to speed — spawning a car AT speed with stationary wheels means
 *  100% longitudinal slip, and the tyre model brakes it to a crawl before it
 *  ever arrives. Accelerate honestly, then put the post in front of it. */
const POST = { x: 0, z: 0 };
/** The hinge post as an analytic vertical cylinder standing at (px, 0..h, pz). */
function postSolid() {
  const px = POST.x, pz = POST.z;
  return {
    baked: true,
    raycastFirst() { return null; },
    spherecast() { return null; },
    closestPointWithNormal(x, y, z, radius, outN) {
      if (y < -radius || y > GATE_POST_HEIGHT + radius) return null;
      const dx = x - px, dz = z - pz;
      const r = Math.hypot(dx, dz);
      const d = r - GATE_POST_RADIUS;
      if (d > radius) return null;
      if (r > 1e-6) outN.set(dx / r, 0, dz / r);
      else outN.set(1, 0, 0);
      return { distance: Math.max(0, d) };
    },
  };
}
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
 * Drive straight down +Z at a post standing `offset` to the side of the car's
 * centreline, and report whether the chassis ever registered a contact.
 *
 * `mode` picks which detector the post is presented to:
 *   "sampled"  the triangle path — post as a solids BVH, hit by hull samples
 *   "capsule"  the analytic path — post as an exact capsule
 */
function ram({ offset, speed, mode }) {
  POST.x = offset;
  POST.z = 1e6; // out of the way until the car is up to speed
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = flat;
  c.enabled = true;
  c.body.pos.set(0, 0.5, 0);
  const drive = (t) => c.tick({ steerTarget: 0, throttle: t, handbrake: false, yaw: 0, pitch: 0 });

  // ACCELERATE FROM REST to the test speed, wheels spinning up with the car.
  // The car's forward axis is −Z at the default spawn orientation.
  for (let i = 0; i < 40 / FIXED_DT && -c.body.vel.z < speed; i++) drive(1);
  if (-c.body.vel.z < speed - 1) return { reached: false };

  // Now stand the post 14 m ahead and attach whichever detector is under test.
  POST.z = c.body.pos.z - 14;
  if (mode === "sampled") c.solidsBvh = postSolid();
  else {
    c.setSolidCapsules([{
      a: new THREE.Vector3(POST.x, 0, POST.z),
      b: new THREE.Vector3(POST.x, GATE_POST_HEIGHT, POST.z),
      radius: GATE_POST_RADIUS,
    }]);
  }

  const startZ = c.body.pos.z;
  let touched = false, minSpeed = Infinity;
  for (let i = 0; i < 6 / FIXED_DT && c.body.pos.z > POST.z - 8; i++) {
    drive(1);
    if (c._solidTouch) touched = true;
    if (c.body.pos.z < POST.z + 4) minSpeed = Math.min(minSpeed, c.body.vel.length());
  }
  return {
    reached: true, touched, minSpeed,
    travelled: startZ - c.body.pos.z,
  };
}

// ── WHAT THE FINER HULL COSTS ───────────────────────────────────────────────
// The grid is ~8x the sample count of the old 26-point layout, and every sample
// is a BVH closest-point query per substep. Worth knowing before shipping it.
{
  // A REAL BVH, not the analytic stand-in: the sample count multiplies the
  // per-query cost, so measuring against a two-line closest-point function would
  // measure the wrong thing entirely. This is a 200 m guardrail wall of the sort
  // the resolver actually runs against every substep of every lap.
  const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.1, 200, 2, 4, 400));
  wall.position.set(2.4, 0.55, 0);
  wall.updateMatrixWorld(true);
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes([wall]);

  const bench = (spacing) => {
    CHASSIS_HULL.sampleSpacing = spacing;
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = flat;
    c.solidsBvh = bvh;
    c.enabled = true;
    c.body.pos.set(1.2, 0.5, 0); // alongside the wall, so queries actually hit
    const N = 4000;
    for (let i = 0; i < 400; i++) c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    return { us: Number(process.hrtime.bigint() - t0) / 1e3 / N, n: c.SOLID_BOX_SAMPLES.length };
  };

  console.log("\n=== COST, AGAINST A REAL BAKED BVH ===");
  console.log(`  bvh baked: ${bvh.baked}`);
  const shipped = CHASSIS_HULL.sampleSpacing;
  console.log("  spacing   samples   whole-vehicle tick   (budget at 120 Hz = 8333 us)");
  for (const s of [1.2, 0.9, 0.6, shipped, 0.3]) {
    const r = bench(s);
    console.log(`  ${s.toFixed(2)} m`.padEnd(12) + String(r.n).padStart(5)
      + `      ${r.us.toFixed(1)} us`
      + (s === shipped ? "   <- shipped" : ""));
  }
  CHASSIS_HULL.sampleSpacing = shipped;
}

for (const mode of ["sampled", "capsule"]) {
  console.log(`\n=== RAMMING THE POST HEAD ON — ${mode.toUpperCase()} DETECTION ===`);
  console.log("  post offset from centreline   speed   registered a hit?   slowest while passing");
  let missed = 0, total = 0;
  // Sweep the post across the full width of the car, including dead centre and
  // dead between sample columns. Every one of these is a hit the player expects.
  for (const offset of [0, 0.2, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    for (const speed of [10, 30]) {
      const r = ram({ offset, speed, mode });
      if (!r.reached) { console.log(`  ${offset.toFixed(2)} m — car never reached ${speed} m/s`); continue; }
      total++;
      if (!r.touched) missed++;
      console.log(`  ${offset.toFixed(2)} m`.padEnd(32)
        + `${String(speed).padStart(3)}     `
        + `${r.touched ? "yes" : "NO  <-- ghost"}`.padEnd(20)
        + `${Number.isFinite(r.minSpeed) ? r.minSpeed.toFixed(1) + " m/s" : "--"}`);
    }
  }
  console.log(`  ${missed}/${total} approaches passed clean through a solid post.`);
}
