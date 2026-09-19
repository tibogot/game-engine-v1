// Hitting the MOVING traffic.
//
// What has to hold, and why each one is here rather than assumed:
//   • a car alongside you is not a car you hit — the clutter pool's "within
//     reach" test would take a whole lane out of service as you passed it
//   • a struck car leaves its ring AND the fleet, in one operation, or a lane
//     brakes forever for a leader lying on its roof
//   • it arrives MOVING: traffic had somewhere to be, parked cars do not
//   • the player pays for the momentum it takes, and never below the floor
//   • mass decides it, as everywhere else on this solver
//   • wrecks are bounded, and a wreck never outlives its instance capacity
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

// Same harness as cityKnockablesTest: the vehicle drags in GPU imports node lacks.
const tmp = (name) => join(ROOT, `.${name}.${process.pid}.mjs`);
const base = (p) => p.split(/[\\/]/).pop();
const VTMP = tmp("tv"), CTMP = tmp("tc"), ITMP = tmp("ti");
writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
writeFileSync(CTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropContact.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', `from "./${base(VTMP)}"`));
writeFileSync(ITMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadCityTrafficImpact.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', `from "./${base(VTMP)}"`)
  .replace('from "./modularRoadPropContact.js"', `from "./${base(CTMP)}"`));
let createTrafficImpacts, trafficCarProfile, TRAFFIC_IMPACT;
try {
  ({ createTrafficImpacts, trafficCarProfile, TRAFFIC_IMPACT } = await import(pathToFileURL(ITMP).href));
} finally {
  unlinkSync(ITMP); unlinkSync(CTMP); unlinkSync(VTMP);
}

/**
 * THE REAL CAR_BODIES, read out of the file that owns it.
 *
 * Not a copy: the profile is derived from that table's `pts` and `width`, and a
 * test carrying its own four cars would pass while the collider disagreed with
 * the shape on screen. The furniture module itself cannot be imported here (TSL,
 * atlases, bloom), so the literal is lifted by brace matching — it is pure data.
 */
const CAR_BODIES = (() => {
  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadCityFurniture.js"), "utf8");
  const at = src.indexOf("export const CAR_BODIES = [");
  if (at < 0) throw new Error("CAR_BODIES not found — has the table moved or been renamed?");
  const from = src.indexOf("[", at);
  let depth = 0, end = -1;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-eval
  const list = eval(src.slice(from, end));
  if (!Array.isArray(list) || !list.length) throw new Error("CAR_BODIES did not parse");
  return list;
})();

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** InstancedMesh stand-in — the impact system only writes matrices and colours. */
function fakeMesh(n) {
  return {
    count: n,
    written: new Map(),
    instanceMatrix: { needsUpdate: false },
    setMatrixAt(i, m) { this.written.set(i, m.clone()); },
    setColorAt() {},
  };
}

/**
 * A lane of traffic running along +Z, which is the yaw-0 heading (the nose maps
 * to (sin yaw, 0, cos yaw)) — so the pose this writes is the pose the game's
 * updateTraffic writes, by the same rule.
 */
function fleetOf(specs, { params } = {}) {
  const list = specs.map((s, i) => ({
    body: s.body ?? 0,
    color: 0xffffff,
    li: 0,
    v: s.v ?? 11,
    z: s.z,
    x: s.x ?? 0,
    yaw: s.yaw ?? 0,
    turn: null,
    wx: 0, wy: 0, wz: 0, slot: i, poseF: 0,
  }));
  const ring = [...list];
  let frame = 0;
  const meshes = CAR_BODIES.map((_, bi) => fakeMesh(specs.filter((s) => (s.body ?? 0) === bi).length));
  const detached = [];
  const impacts = createTrafficImpacts({
    fleet: {
      list: () => list,
      frame: () => frame,
      detach(c) {
        const a = ring.indexOf(c); if (a >= 0) ring.splice(a, 1);
        const b = list.indexOf(c); if (b >= 0) list.splice(b, 1);
        c.turn = null;
        detached.push(c);
      },
    },
    meshes, bodies: CAR_BODIES, groundY: 0, params,
  });
  /** One frame of the traffic sim: advance, then stamp the drawn pose. */
  function stamp(dt) {
    frame++;
    const n = CAR_BODIES.map(() => 0);
    for (const c of list) {
      c.z += c.v * dt * Math.cos(c.yaw);
      c.x += c.v * dt * Math.sin(c.yaw);
      c.wx = c.x; c.wy = 0; c.wz = c.z;
      c.slot = n[c.body]++;
      c.poseF = frame;
    }
  }
  return { impacts, list, ring, detached, meshes, stamp };
}

function car(pos, vel) {
  return { pos: pos.clone(), vel: vel.clone(), quat: new THREE.Quaternion(), angVel: V(0, 0, 0) };
}

/**
 * Drive at a render frame rate, stamping the traffic first, as the game does.
 * `leaveAfter` swerves the player away that long after the first impact — a
 * player who keeps driving into a wreck keeps pushing it, so without this
 * nothing ever settles and "does it come to rest" cannot be asked.
 */
function drive(w, c, secs, { fps = 60, each, leaveAfter = Infinity } = {}) {
  const dt = 1 / fps;
  let hitAt = null;
  for (let t = 0; t < secs; t += dt) {
    c.pos.addScaledVector(c.vel, dt);
    w.stamp(dt);
    w.impacts.update(dt, c, null);
    if (hitAt === null && w.impacts.stats.hit > 0) hitAt = t;
    if (hitAt !== null && t - hitAt > leaveAfter) { c.pos.x = 1e4; c.vel.set(0, 0, 0); }
    each?.(t, c);
  }
}
const wreckPose = (w, i = 0) => w.impacts.wrecks[i]?.body.pos.clone() ?? null;

console.log("=== THE PROFILE COMES OFF THE REAL TABLE ===");
{
  const saloon = CAR_BODIES.find((b) => b.name === "saloon");
  const p = trafficCarProfile(saloon);
  let zMin = Infinity, zMax = -Infinity, yMax = 0;
  for (const [z, y] of saloon.pts) { zMin = Math.min(zMin, z); zMax = Math.max(zMax, z); yMax = Math.max(yMax, y); }
  check("length and height are the table's own extents",
    Math.abs(p.shape.length - (zMax - zMin)) < 1e-9 && Math.abs(p.shape.height - yMax) < 1e-9,
    `${p.shape.length.toFixed(2)} x ${p.shape.height.toFixed(2)} m`);
  check("width is the table's width", p.shape.width === saloon.width);
  check("it sits on the road, not floating", p.shape.baseY === 0);
  check("the centre of mass is low, like a car", p.comY < p.shape.height * 0.5,
    `${p.comY.toFixed(2)} m of ${p.shape.height.toFixed(2)}`);
  const unnamed = trafficCarProfile({ ...saloon, name: "coupe-nobody-weighed" });
  check("a body nobody has weighed still gets a sane mass",
    unnamed.mass > 800 && unnamed.mass < 2500, `${unnamed.mass} kg`);
  const van = trafficCarProfile(CAR_BODIES.find((b) => b.name === "van"));
  check("a van outweighs a hatchback",
    van.mass > trafficCarProfile(CAR_BODIES.find((b) => b.name === "hatchback")).mass);
}

console.log("\n=== IDLE ===");
{
  const w = fleetOf([{ z: 0 }, { z: 30 }]);
  for (let i = 0; i < 120; i++) { w.stamp(1 / 60); w.impacts.update(1 / 60, null, null); }
  check("with no car nothing is struck", w.impacts.stats.hit === 0 && w.impacts.wrecks.length === 0);
  check("and the fleet is untouched", w.list.length === 2 && w.ring.length === 2);
  const far = car(V(60, 0.5, 0), V(0, 0, 0));
  for (let i = 0; i < 120; i++) { w.stamp(1 / 60); w.impacts.update(1 / 60, far, null); }
  check("a car nowhere near strikes nothing", w.impacts.stats.hit === 0);
}

console.log("\n=== DRIVING ALONGSIDE IS NOT A COLLISION ===");
// THE reason this file has its own overlap test. A saloon's shape reach is
// ~2.6 m, so "within reach" fires a full car's width away — and a traffic car
// woken by mistake leaves its lane and coasts to a halt beside you.
{
  const w = fleetOf([{ z: 0, v: 11 }]);
  // Two lanes apart, overtaking: close enough for the broadphase, never touching.
  const c = car(V(3.6, 0.5, -20), V(0, 0, 24));
  let minGap = Infinity;
  drive(w, c, 3.0, {
    each: () => { if (w.list[0]) minGap = Math.min(minGap, Math.abs(w.list[0].wx - c.pos.x)); },
  });
  check("passing in the next lane strikes nothing", w.impacts.stats.hit === 0,
    `closest ${minGap.toFixed(2)} m across, reach alone would have fired`);
  check("the car is still traffic", w.list.length === 1 && w.ring.length === 1);
}

console.log("\n=== A REAR-END AT SPEED ===");
{
  const w = fleetOf([{ z: 0, v: 11 }]);
  const c = car(V(0, 0.5, -14), V(0, 0, 34));
  const struck = w.list[0];
  let paid = 34;
  drive(w, c, 5.0, {
    leaveAfter: 0.4,
    each: () => { if (w.impacts.stats.hit) paid = Math.min(paid, c.vel.length() || paid); },
  });
  check("exactly one car is struck", w.impacts.stats.hit === 1, `hit ${w.impacts.stats.hit}`);
  check("it left the ring AND the fleet",
    w.ring.length === 0 && w.list.length === 0 && w.detached[0] === struck);
  check("its half-finished corner is cleared", struck.turn === null);
  check("the player paid for it", paid < 34, `34 m/s into an 11 m/s car left ${paid.toFixed(1)}`);
  const rest = wreckPose(w);
  check("the wreck is shoved down the road", rest && rest.z > 4, `rests at z ${rest?.z.toFixed(1)}`);
  check("it rests on the road, not through it or above it",
    rest && Math.abs(rest.y - trafficCarProfile(CAR_BODIES[0]).comY) < 0.4,
    `centre of mass at y ${rest?.y.toFixed(2)}`);
  check("it settles rather than sliding forever", w.impacts.stats.awake === 0);
  check("it is drawn in the slot the live car vacated", w.meshes[0].written.has(0));
}

console.log("\n=== IT ARRIVES MOVING ===");
// A car hit from the side must carry on the way it was going. Hit a parked car
// and it only goes where you pushed it; hit traffic and it had somewhere to be.
{
  const w = fleetOf([{ z: 0, v: 13 }]);
  const c = car(V(-8, 0.5, 2.0), V(26, 0, 0));      // T-bone from the left
  drive(w, c, 2.5, {});
  const rest = wreckPose(w);
  check("a T-boned car keeps going down its own lane", rest && rest.z > 3,
    `carried ${rest?.z.toFixed(1)} m along the lane`);
  check("and is pushed across it too", rest && rest.x > 0.5, `${rest?.x.toFixed(1)} m across`);
}

console.log("\n=== A CREEPING QUEUE IS NOT A CRASH ===");
// A player stopped in a lane at a red light must not turn the queue behind him
// into a scrapyard. Below the closing floor, traffic overlaps him as it always has.
{
  const w = fleetOf([{ z: 6, v: 0.6 }]);
  const c = car(V(0, 0.5, 0), V(0, 0, 0));
  drive(w, c, 14.0, {});
  check("a car creeping into a stopped player strikes nothing", w.impacts.stats.hit === 0,
    `closing ${0.6} m/s, floor ${TRAFFIC_IMPACT.minImpactSpeed}`);
}

console.log("\n=== MASS DECIDES IT ===");
{
  const bi = (name) => CAR_BODIES.findIndex((b) => b.name === name);
  const shove = (name) => {
    const w = fleetOf([{ z: 0, v: 11, body: bi(name) }]);
    drive(w, car(V(0, 0.5, -14), V(0, 0, 34)), 4.0, {});
    return { z: wreckPose(w)?.z ?? 0, hit: w.impacts.stats.hit };
  };
  const hatch = shove("hatchback"), van = shove("van");
  check("both are struck", hatch.hit === 1 && van.hit === 1);
  check("the same hit moves the hatchback further than the van", hatch.z > van.z,
    `hatchback ${hatch.z.toFixed(1)} m, van ${van.z.toFixed(1)} m`);
}

console.log("\n=== THE PLAYER IS CHARGED, BUT NOT STOPPED DEAD ===");
{
  const w = fleetOf([{ z: 0, v: 0 }], { params: { minPushSpeed: 4 } });
  const c = car(V(0, 0.5, -10), V(0, 0, 6));
  drive(w, c, 4.0, {});
  check("nudging a wreck never falls under the floor", c.vel.length() >= 4 - 1e-6,
    `${c.vel.length().toFixed(2)} m/s, floor 4`);

  const w2 = fleetOf([{ z: 0, v: 11 }], { params: { scrub: false } });
  const c2 = car(V(0, 0.5, -14), V(0, 0, 34));
  drive(w2, c2, 1.0, {});
  check("with the scrub off the car keeps every metre per second",
    Math.abs(c2.vel.length() - 34) < 1e-9, `${c2.vel.length().toFixed(3)} m/s`);
  check("and the car is still struck", w2.impacts.stats.hit === 1);
}

console.log("\n=== WRECKS ARE BOUNDED ===");
{
  const KEEP = 4;
  const specs = [];
  for (let i = 0; i < 10; i++) specs.push({ z: i * 26, v: 0 });
  // The scrub is off here on purpose: a player who really pays for ten cars in
  // a row is stopped by the third, and this is a test of the CAP.
  const w = fleetOf(specs, { params: { keep: KEEP, pool: 3, dropRange: 20, scrub: false } });
  const c = car(V(0, 0.5, -10), V(0, 0, 40));
  let peak = 0, peakAwake = 0;
  drive(w, c, 12.0, {
    each: () => {
      peak = Math.max(peak, w.impacts.wrecks.length);
      peakAwake = Math.max(peakAwake, w.impacts.stats.awake);
    },
  });
  check("more cars are struck than are kept", w.impacts.stats.hit > KEEP, `${w.impacts.stats.hit} struck`);
  check("wrecks never exceed the cap", peak <= KEEP, `peaked at ${peak}`);
  check("simulated bodies never exceed the pool", peakAwake <= 3, `peaked at ${peakAwake}`);
  check("no wreck is ever written past its mesh's capacity",
    [...w.meshes[0].written.keys()].every((i) => i < w.meshes[0].count));
  check("the fleet shrank by exactly what was struck",
    w.list.length === specs.length - w.impacts.stats.hit);
}

console.log("\n=== AND THEN IT IS SOLID ===");
// The whole point of the capsule: one-way coupling spends the virtual car and
// then lets the real one through, so without this you hit a car and drive
// through the wreck of it.
{
  const { OBSTACLE_DEFAULTS } = await import(
    pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadCityObstacles.js")).href);
  const saloon = trafficCarProfile(CAR_BODIES.find((b) => b.name === "saloon"));
  check("a saloon's capsule is the parked car's, within the inset",
    saloon.capsule.radius < OBSTACLE_DEFAULTS.carRadius
    && saloon.capsule.radius > OBSTACLE_DEFAULTS.carRadius - 0.3
    && saloon.capsule.half < OBSTACLE_DEFAULTS.carHalfLength
    && saloon.capsule.half > OBSTACLE_DEFAULTS.carHalfLength - 0.4,
    `r ${saloon.capsule.radius.toFixed(2)} vs parked ${OBSTACLE_DEFAULTS.carRadius}, `
    + `half ${saloon.capsule.half.toFixed(2)} vs ${OBSTACLE_DEFAULTS.carHalfLength}`);
  // The inset is load-bearing: flush to the box, the de-collision never lets
  // the contact solver see a penetration and a settled wreck cannot be pushed.
  check("and it sits strictly INSIDE the contact box on every axis",
    saloon.capsule.radius < saloon.shape.width * 0.5
    && saloon.capsule.half + saloon.capsule.radius < saloon.shape.length * 0.5,
    `side ${saloon.capsule.radius.toFixed(2)} < ${(saloon.shape.width * 0.5).toFixed(2)}, `
    + `end ${(saloon.capsule.half + saloon.capsule.radius).toFixed(2)} < ${(saloon.shape.length * 0.5).toFixed(2)}`);
  const van = trafficCarProfile(CAR_BODIES.find((b) => b.name === "van"));
  check("a van gets a van-sized one, not a saloon's", van.capsule.radius > saloon.capsule.radius);

  const w = fleetOf([{ z: 0, v: 11 }]);
  check("with nothing struck there are no capsules", w.impacts.capsulesNear(0, 0, 70).length === 0);
  const c = car(V(0, 0.5, -14), V(0, 0, 34));
  drive(w, c, 0.8, {});
  const caps = w.impacts.capsulesNear(c.pos.x, c.pos.z, 70);
  check("a struck car hands one to the vehicle", caps.length === 1);
  check("it is the wreck's OWN object, not a copy — a copy would freeze it "
    + "at the pose the window was last rebuilt at", caps[0] === w.impacts.wrecks[0].cap);
  const axis = caps[0] ? caps[0].a.distanceTo(caps[0].b) : 0;
  check("it is a car-length sausage lying down",
    Math.abs(axis - saloon.capsule.half * 2) < 1e-6 && Math.abs(caps[0].a.y - caps[0].b.y) < 0.4,
    `${(axis + 2 * caps[0].radius).toFixed(2)} m end to end, radius ${caps[0]?.radius.toFixed(2)}`);
  const at0 = caps[0].a.clone();
  drive(w, c, 1.0, {});
  check("and it FOLLOWS the wreck without being handed over again",
    caps[0].a.distanceTo(at0) > 1, `moved ${caps[0].a.distanceTo(at0).toFixed(1)} m`);
  const rest = w.impacts.wrecks[0].body.pos;
  check("the capsule sits on the wreck, not where it was hit",
    Math.hypot(caps[0].a.x - rest.x, caps[0].a.z - rest.z) < saloon.capsule.half + 0.2);
  check("a window somewhere else does not see it",
    w.impacts.capsulesNear(rest.x + 400, rest.z, 70).length === 0);

  // The capsule must say how fast it is MOVING, or the vehicle resolves it as a
  // wall and stops the car dead against the thing it is pushing.
  const body = w.impacts.wrecks[0].body;
  body.vel.set(3, 0, 12);
  body.angVel.set(0, 2, 0);
  const out = V(0, 0, 0);
  caps[0].velAt(body.pos, out);
  check("velAt at the centre is the wreck's own velocity",
    out.distanceTo(V(3, 0, 12)) < 1e-9, `${out.toArray().map(n => n.toFixed(2)).join(", ")}`);
  const nose = body.pos.clone().add(V(0, 0, 2));
  caps[0].velAt(nose, out);
  // v + w x r, with w = (0,2,0) and r = (0,0,2)  =>  (4, 0, 0) added.
  check("and it carries the spin, so a turning wreck's nose is not its centre",
    out.distanceTo(V(3 + 4, 0, 12)) < 1e-6, `${out.toArray().map(n => n.toFixed(2)).join(", ")}`);
}

console.log("\n=== DISABLED MEANS ABSENT ===");
{
  const w = fleetOf([{ z: 0 }], { params: { enabled: false } });
  check("no system is built at all", w.impacts === null);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
