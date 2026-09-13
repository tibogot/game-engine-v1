// Knock-over cones and push-through gates.
//
// The design claim under test is that a general physics engine was NOT needed:
// the vehicle's own RigidBody covers cones (the easy 80% of rigid-body dynamics
// — impulse, tumble, settle, sleep), and a gate is 1 degree of freedom so it is
// simulated directly rather than as a constrained body.
//
// The things that actually break in a hand-rolled version, all covered here:
//   • bodies that never sleep — settled cones integrating and jittering forever
//   • two-way coupling leaking into the car's tuned physics
//   • reset not restoring the AUTHORED pose after props were knocked about
//   • a deleted prop leaving a ghost body behind
//   • physics props landing in the static collision bake (an invisible wall)
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

// Bare "three" is three/webgpu under vite but not in node; the physics module
// also pulls the vehicle for RigidBody + CHASSIS, which drags in GPU imports.
const VTMP = join(ROOT, `.pv.${process.pid}.mjs`);
writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const vehicleRel = `from "./${VTMP.split(/[\\/]/).pop()}"`;
const CTMP = join(ROOT, `.pc.${process.pid}.mjs`);
writeFileSync(CTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropContact.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', vehicleRel));
const PTMP = join(ROOT, `.pp.${process.pid}.mjs`);
writeFileSync(PTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropPhysics.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', vehicleRel)
  .replace('from "./modularRoadPropContact.js"', `from "./${CTMP.split(/[\\/]/).pop()}"`));
let PropPhysics, PHYSICS_PROP_TYPES, CHASSIS_HULL;
try {
  ({ PropPhysics, PHYSICS_PROP_TYPES } = await import(pathToFileURL(PTMP).href));
  ({ CHASSIS_HULL } = await import(pathToFileURL(VTMP).href));
} finally {
  unlinkSync(PTMP); unlinkSync(CTMP); unlinkSync(VTMP);
}

/** Flat ground at y=0, same shape as the deck BVH the game passes in. */
const ground = {
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
/** Minimal stand-in for PropManager — the physics only reads `instances`. */
function fakeProps(list) {
  return {
    instances: list.map(({ id, x = 0, y, z = 0, quat }) => {
      const root = new THREE.Object3D();
      // Default: ground-flush, the way make() authors it.
      root.position.set(x, y ?? PHYSICS_PROP_TYPES[id]?.radius ?? 0, z);
      if (quat) root.quaternion.copy(quat);
      return { id, root };
    }),
  };
}
/** Minimal stand-in for the Vehicle — only body + enabled are read. */
function fakeCar({ pos, vel }) {
  const body = {
    pos: pos.clone(), vel: vel.clone(), quat: new THREE.Quaternion(),
    getVelocityAtPoint(_p, out) { return out.copy(this.vel); },
  };
  return { enabled: true, body };
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const mk = (list) => {
  const props = fakeProps(list);
  const phys = new PropPhysics({ props, getGroundBvh: () => ground });
  phys.sync();
  return { props, phys };
};
const DT = 1 / 120;
const run = (phys, car, secs) => { for (let i = 0; i < secs / DT; i++) phys.tick(DT, car); };
/** A car that actually MOVES, and swerves away `leaveAfter` s after first contact. */
const drive = (phys, car, secs, { leaveAfter = Infinity, each } = {}) => {
  let hitAt = null;
  for (let i = 0; i < secs / DT; i++) {
    const t = i * DT;
    car.body.pos.addScaledVector(car.body.vel, DT);
    if (hitAt === null && phys.awakeCount) hitAt = t;
    if (hitAt !== null && t - hitAt > leaveAfter) car.body.pos.x = 1e3;
    phys.tick(DT, car);
    each?.(t);
  }
};
const upY = (q) => V(0, 1, 0).applyQuaternion(q).y;
/** Lowest ground contact point of a shaped body, world y. */
const lowestY = (s) => {
  let m = Infinity;
  s.phys.solver.forGroundPoints(s, (p) => { m = Math.min(m, p.y); });
  return m;
};
/** Ground points within 1.5 cm of the floor — 1 means balanced on a point. */
const supports = (s) => {
  let n = 0;
  s.phys.solver.forGroundPoints(s, (p) => { if (p.y < 0.015) n++; });
  return n;
};

console.log("=== SETUP ===");
{
  const { phys } = mk([{ id: "cone", x: 0 }, { id: "cone", x: 2 }, { id: "gate", x: 10 }, { id: "box", x: 20 }]);
  check("only physics types get a sim (the box is ignored)", phys.sims.length === 3, `${phys.sims.length}`);
  check("cones become rigid bodies", phys.sims.filter((s) => s.body).length === 2);
  check("the gate is a hinge, NOT a rigid body",
    phys.sims.find((s) => s.profile.kind === "hinge") && !phys.sims.find((s) => s.profile.kind === "hinge").body);
  check("everything starts asleep — an untouched track costs nothing",
    phys.awakeCount === 0);
}

console.log("\n=== A CAR HITS A CONE ===");
// Contact-point body: the tumble is not written in, it comes from WHERE the
// bumper lands (above the weighted base) and the inertia. So these measure the
// outcome of a real pass, with the car driving on and then away.
{
  const { phys } = mk([{ id: "cone", x: 0, z: 0 }]);
  const s = phys.sims[0];
  s.phys = phys;
  const car = fakeCar({ pos: V(0.3, 0.5, -4), vel: V(0, 0, 25) });
  let maxV = 0, maxH = 0, minUp = 1, maxW = 0, woke = false;
  drive(phys, car, 1.5, {
    leaveAfter: 0.08,
    each: () => {
      woke ||= !s.asleep;
      maxV = Math.max(maxV, s.body.vel.length());
      maxH = Math.max(maxH, s.inst.root.position.y);
      minUp = Math.min(minUp, upY(s.body.quat));
      maxW = Math.max(maxW, s.body.angVel.length());
    },
  });
  check("the cone wakes on contact", woke);
  check("it is thrown forward, along the car's travel",
    s.body.pos.z > 5, `${s.body.pos.z.toFixed(1)} m down the road`);
  // Physically a light prop CAN leave faster than the bumper (restitution);
  // what must not happen is the car pumping it again and again.
  const cap = 25 * (1 + PHYSICS_PROP_TYPES.cone.carRestitution) + 0.5;
  check("it leaves at about bumper speed, not a multiple of it",
    maxV < cap, `peak ${maxV.toFixed(1)} m/s (cap ${cap.toFixed(1)})`);
  check("it TUMBLES, from the hit landing above its centre of mass",
    minUp < 0, `cone axis reached up.y ${minUp.toFixed(2)}`);
  check("it leaves the ground, but windscreen-high rather than a mortar",
    maxH > 0.8 && maxH < 4, `root peaked at ${maxH.toFixed(2)} m`);
  check("spin stays a cartwheel, well under the numerical cap",
    maxW < 40, `peak ${maxW.toFixed(1)} rad/s`);
}

console.log("\n=== A CAR DRIVING ON DOES NOT PUMP THE CONE ===");
// The old impulse fired on every tick of overlap without looking at how fast
// the cone was ALREADY going, so a car catching it up re-launched it each time.
{
  const { phys } = mk([{ id: "cone", x: 0, z: 0 }]);
  const s = phys.sims[0];
  const car = fakeCar({ pos: V(0, 0.5, -4), vel: V(0, 0, 25) });
  let maxV = 0;
  drive(phys, car, 2, { each: () => { maxV = Math.max(maxV, s.body.vel.length()); } });
  const cap = 25 * (1 + PHYSICS_PROP_TYPES.cone.carRestitution) + 0.5;
  check("a cone the car keeps meeting never exceeds one bounce off it",
    maxV < cap, `peak ${maxV.toFixed(1)} m/s over 2 s of pushing (cap ${cap.toFixed(1)})`);
}

console.log("\n=== MASS DECIDES THE THROW ===");
{
  const P = PHYSICS_PROP_TYPES.cone;
  const throwAt = (mass) => {
    const m0 = P.mass;
    P.mass = mass;
    try {
      const { phys } = mk([{ id: "cone", x: 0, z: 0 }]);
      const s = phys.sims[0];
      let maxV = 0;
      drive(phys, fakeCar({ pos: V(0, 0.5, -4), vel: V(0, 0, 25) }), 0.6,
        { leaveAfter: 0.02, each: () => { maxV = Math.max(maxV, s.body.vel.length()); } });
      return maxV;
    } finally { P.mass = m0; }
  };
  const light = throwAt(P.mass), heavy = throwAt(900);
  check("a heavy prop takes less of the car's speed than a light one",
    heavy < light - 2, `${P.mass} kg -> ${light.toFixed(1)} m/s, 900 kg -> ${heavy.toFixed(1)} m/s`);
}

console.log("\n=== ONE-WAY COUPLING ===");
{
  const { phys } = mk([{ id: "cone", x: 0, z: 0 }]);
  const car = fakeCar({ pos: V(0, 0.6, -1.2), vel: V(0, 0, 25) });
  const v0 = car.body.vel.clone(), p0 = car.body.pos.clone();
  run(phys, car, 0.3);
  check("the car's velocity is never touched by a prop",
    car.body.vel.equals(v0), `${car.body.vel.toArray()}`);
  check("nor its position", car.body.pos.equals(p0));
}

console.log("\n=== IT SETTLES AND SLEEPS ===");
for (const id of ["cone", "barrel"]) {
  const { phys } = mk([{ id, x: 0, z: 0 }]);
  const s = phys.sims[0];
  s.phys = phys;
  const car = fakeCar({ pos: V(0.3, 0.5, -4), vel: V(0, 0, 30) });
  let woke = false;
  drive(phys, car, 0.5, { leaveAfter: 0.08, each: () => { woke ||= phys.awakeCount === 1; } });
  check(`${id}: awake after the hit`, woke);
  run(phys, null, 25);
  check(`${id}: it comes to rest and SLEEPS (or it jitters and burns CPU forever)`,
    phys.awakeCount === 0, `awake ${phys.awakeCount}`);
  check(`${id}: it rests ON the ground, not sunk into it or floating`,
    Math.abs(lowestY(s)) < 0.01, `lowest point y = ${lowestY(s).toFixed(4)}`);
  // THE FLOATING-BARREL BUG. One sphere about the centre never rotated with
  // the body, so a drum on its side hovered at half its HEIGHT above the road.
  check(`${id}: it rests on a face or an edge, never balanced on a single point`,
    supports(s) >= 2, `${supports(s)} support points`);
  check(`${id}: a sleeping prop costs nothing — no drift while asleep`, (() => {
    const p = s.body.pos.clone();
    run(phys, null, 2);
    return s.body.pos.equals(p);
  })());
  const expectRoot = s.body.pos.clone().sub(s.com.clone().applyQuaternion(s.body.quat));
  check(`${id}: the visual root follows the body (offset from its centre of mass)`,
    s.inst.root.position.distanceTo(expectRoot) < 1e-9 && s.inst.root.quaternion.equals(s.body.quat));
}

console.log("\n=== A CONE RIGHTS ITSELF, OR FALLS OVER — NOTHING IN BETWEEN ===");
// Gravity acts at the centre of mass, low in the weighted base, so a nudged
// cone stands back up and one pushed past its tipping point lies down. Before,
// nothing applied any torque and a cone kept whatever tilt it had.
{
  const settle = (deg) => {
    const q = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), deg * Math.PI / 180);
    const { phys } = mk([{ id: "cone", y: 0.6, quat: q }]);
    const s = phys.sims[0];
    s.asleep = false;
    run(phys, null, 5);
    return { up: upY(s.body.quat), asleep: s.asleep };
  };
  const t30 = settle(30), t70 = settle(70);
  check("tilted 30 degrees, it stands back up", t30.up > 0.99 && t30.asleep, `up.y ${t30.up.toFixed(3)}`);
  check("tilted 70 degrees, it lies down on its side", t70.up < 0 && t70.asleep, `up.y ${t70.up.toFixed(3)}`);
}

console.log("\n=== A CAR DRIVING THROUGH A BARREL KNOCKS IT OVER ===");
// Reported as "I'm just pushing them". Three causes, all in the car contact:
//  • gravity's 0.08 m/s counted as entering through the hull ROOF, so the drum
//    was popped 0.51 m up onto the box and carried there (the entry window);
//  • the hull's flat front hit a 1.5 m drum dead on its centre of mass, so
//    nothing could tip it (the measured bonnet slope, CAR_NOSE);
//  • the drum had no contact points in the bumper band at all (denser rings).
{
  const rest = PHYSICS_PROP_TYPES.barrel.radius;
  const { phys } = mk([{ id: "barrel", x: 0, z: 0 }]);
  const s = phys.sims[0];
  const car = fakeCar({ pos: V(0, 0.5, -5), vel: V(0, 0, 15) });
  let minUp = 1, hoisted = 0, onBumperLate = 0;
  drive(phys, car, 3, {
    each: (t) => {
      const up = upY(s.body.quat);
      minUp = Math.min(minUp, up);
      // Never tipped yet, upright, lifted, and touching the car = sitting on
      // it. (A drum mid-flip passes upright in the air too — that is fine.)
      const onCar = phys.solver.count && phys.solver.contacts[0].cv.lengthSq() > 0;
      if (onCar && minUp > 0.9 && s.inst.root.position.y > rest + 0.3) {
        hoisted = Math.max(hoisted, s.inst.root.position.y - rest);
      }
      if (t > 1.5 && phys.solver.count && phys.solver.contacts[0].cv.lengthSq() > 0) onBumperLate += DT;
    },
  });
  check("a 15 m/s hit knocks the drum over instead of plowing it upright",
    minUp < 0.3, `drum axis reached up.y ${minUp.toFixed(2)}`);
  check("it is never hoisted upright onto the car",
    hoisted === 0, hoisted ? `lifted ${hoisted.toFixed(2)} m while upright` : "");
  check("the car is not still shoving it a second and a half later",
    onBumperLate < 0.2, `${onBumperLate.toFixed(2)} s on the bumper after t=1.5 s`);
}

console.log("\n=== A BARREL ON ITS SIDE ROLLS ===");
{
  const P = PHYSICS_PROP_TYPES.barrel;
  const r = P.size.width / 2;
  const q = new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 2); // axis along Z
  const { phys } = mk([{ id: "barrel", y: r + 0.01, quat: q }]);
  const s = phys.sims[0];
  s.asleep = false;
  s.body.vel.set(4, 0, 0);             // shoved sideways with no spin at all
  run(phys, null, 0.6);
  const ratio = Math.abs(s.body.angVel.z) * r / Math.abs(s.body.vel.x);
  check("ground friction spins a sliding drum up until it ROLLS (v = w·r)",
    Math.abs(ratio - 1) < 0.05, `w·r / v = ${ratio.toFixed(3)}`);
  // Solid-cylinder slide-to-roll keeps 2/3 of the speed; drag takes a little.
  check("...keeping about two thirds of its speed, as a solid cylinder does",
    s.body.vel.x > 4 * 0.55 && s.body.vel.x < 4 * 0.7, `${s.body.vel.x.toFixed(2)} of 4 m/s`);
  check("it rolls at its RADIUS above the road, not half its height",
    Math.abs(s.body.pos.y - r) < 0.01, `centre y ${s.body.pos.y.toFixed(3)}, radius ${r.toFixed(3)}`);
}

console.log("\n=== LAP RESET PUTS THEM BACK ===");
{
  const { phys } = mk([{ id: "cone", x: 3, z: 1 }, { id: "gate", x: 10 }]);
  const cone = phys.sims[0], gate = phys.sims[1];
  const home = cone.home.pos.clone();
  const car = fakeCar({ pos: V(3, 0.5, -4), vel: V(0, 0, 30) });
  drive(phys, car, 1.5, { leaveAfter: 0.08 });
  check("the cone really was displaced first", cone.inst.root.position.distanceTo(home) > 0.5,
    `${cone.inst.root.position.distanceTo(home).toFixed(1)} m away`);
  gate.angle = 1.0; gate.angVel = 2;
  phys.reset();
  check("cone returns to its AUTHORED position",
    cone.body.pos.distanceTo(home.clone().add(cone.com.clone().applyQuaternion(cone.home.quat))) < 1e-9);
  check("and its authored rotation", cone.body.quat.equals(cone.home.quat));
  check("with no leftover momentum", cone.body.vel.length() === 0 && cone.body.angVel.length() === 0);
  check("cone goes back to sleep", cone.asleep === true);
  check("the visual mesh is reset too, not just the body",
    cone.inst.root.position.equals(home));
  check("the gate swings shut", gate.angle === 0 && gate.angVel === 0);
}

console.log("\n=== THE GATE ===");
{
  const { phys } = mk([{ id: "gate", x: 0, y: 0, z: 0 }]);
  const g = phys.sims[0];
  // Car driving through the panel, which extends along +X from the hinge.
  const car = fakeCar({ pos: V(1.1, 0.5, -0.3), vel: V(0, 0, 14) });
  run(phys, car, 0.4);
  check("the car pushes it open", Math.abs(g.angle) > 0.15, `${g.angle.toFixed(2)} rad`);
  const peak = Math.abs(g.angle);
  check("it never exceeds its hinge limit", peak <= PHYSICS_PROP_TYPES.gate.maxAngle + 1e-6,
    `${peak.toFixed(2)} <= ${PHYSICS_PROP_TYPES.gate.maxAngle}`);
  run(phys, null, 6);
  check("it swings back closed once the car is gone", Math.abs(g.angle) < 0.05,
    `${g.angle.toFixed(3)} rad`);
  check("and settles rather than oscillating forever", Math.abs(g.angVel) < 0.05,
    `${g.angVel.toFixed(3)} rad/s`);
  check("a 1-DOF sim cannot explode — angle stays finite", Number.isFinite(g.angle));
}

console.log("\n=== A PLACED CONE SITS ON THE GROUND ===");
// PropManager keeps a prop's AUTHORED y when placing (it only sets x/z), so
// make() has to leave it ground-flush. The cone drops its geometry by the
// collision radius — so the ROOT can be the body centre, or a knocked cone
// pivots on its tip — and must lift the root by the same amount. Missing that
// lift is exactly why it sat half-buried.
{
  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  const cone = src.slice(src.indexOf('id: "cone"'), src.indexOf('id: "gate"'));
  check("the cone's visual offset comes FROM the collision radius, not a copy",
    /PHYSICS_PROP_TYPES\.cone\.radius/.test(cone),
    "a hardcoded duplicate is how it drifted and ended up buried");
  check("geometry is dropped by that radius", /position\.y -= R/.test(cone));
  check("and the ROOT is lifted by it, so the base lands on y=0",
    /g\.position\.y = R/.test(cone));
  const tyre = src.slice(src.indexOf('id: "tyre"'), src.indexOf('id: "flag"'));
  check("the tyre exists as a physics prop, not only the static tire wall",
    /id: "tyre"/.test(tyre) && /stack: TIRE_SIZE/.test(tyre));
  check("the tyre's rest height is half its thickness, so it lies flat on y=0",
    /g\.position\.y = hw/.test(tyre));

  // Net effect: base at 0 — exactly where the ground contact holds it, so a
  // resting cone (or barrel) never jumps or sinks when it wakes.
  for (const id of ["cone", "barrel"]) {
    const { phys } = mk([{ id, x: 0, z: 0 }]);
    const s2 = phys.sims[0];
    s2.phys = phys;
    const y0 = s2.inst.root.position.y;
    check(`a ${id} placed flush has its base on the ground`, Math.abs(lowestY(s2)) < 1e-6,
      `lowest point ${lowestY(s2).toFixed(4)}`);
    s2.asleep = false;
    run(phys, null, 3);
    check(`a woken, untouched ${id} stays exactly where it was placed`,
      Math.abs(s2.inst.root.position.y - y0) < 0.005 && upY(s2.body.quat) > 0.9999 && s2.asleep,
      `dy ${(s2.inst.root.position.y - y0).toFixed(4)}, asleep ${s2.asleep}`);
  }
}

console.log("\n=== THE GATE IS HELD OPEN UNTIL THE CAR IS THROUGH ===");
// Impulses alone could not do this. The spring kept closing the panel INTO the
// car mid-pass, and at speed the car was through the doorway before an impulse
// had built at all — so a fast car appeared to drive straight through. A door is
// not nudged, it is DISPLACED, and stays displaced while something is in it.
{
  /** Drive a car along +Z through a gate hinged at the origin. */
  const pass = (speed) => {
    const root = new THREE.Object3D();
    const phys = new PropPhysics({ props: { instances: [{ id: "gate", root }] }, getGroundBvh: () => null });
    phys.sync();
    const g = phys.sims[0];
    const body = {
      // Halfway ALONG the panel — derived, not hardcoded. This was a literal
      // 1.1, which was the mid-point of a 2.2 m panel; widening the gate turned
      // it into a quarter-point near the hinge, where clearing the car needs a
      // much larger swing, and the gate saturated against its hinge limit.
      pos: V(PHYSICS_PROP_TYPES.gate.width / 2, 0.5, -8), vel: V(0, 0, speed), quat: new THREE.Quaternion(),
      getVelocityAtPoint(_p, o) { return o.copy(this.vel); },
    };
    let opened = false, minWhilePassing = Infinity, peak = 0, closedAt = null;
    // RUN LONG ENOUGH FOR THE MANOEUVRE, not a flat 5 s.
    //
    // The gate stays in contact until the car is `width + carR` from the hinge
    // (see _tickHinge), so a WIDER gate is released later — and the spring then
    // needs its own ~2.5 s to decay from full swing whatever the car is doing.
    // A fixed window made "does it close?" a question about the clock: at 4 m/s
    // the car was still inside the doorway when the sim ended.
    const clearZ = PHYSICS_PROP_TYPES.gate.width + 2;
    const secs = (8 + clearZ) / speed + 4;
    for (let i = 0; i < secs / DT; i++) {
      body.pos.addScaledVector(body.vel, DT);
      phys.tick(DT, { enabled: true, body });
      const a = Math.abs(g.angle);
      peak = Math.max(peak, a);
      if (!opened && a > 0.05) opened = true;
      if (opened && body.pos.z < 2.5) minWhilePassing = Math.min(minWhilePassing, a);
      // Only once the car is genuinely CLEAR of the panel's reach — otherwise
      // this measures the gate closing on a car that is still in the doorway.
      if (opened && closedAt === null && body.pos.z > clearZ && a < 0.08) closedAt = body.pos.z;
    }
    return { peak, minWhilePassing, exit: body.vel.z, closedAt, opened };
  };

  console.log("  speed   peak    min while passing   closes at   exit");
  let allOpen = true, allHeld = true, allClosed = true, allThrough = true;
  for (const sp of [4, 10, 20, 45]) {
    const r = pass(sp);
    console.log(`  ${String(sp).padStart(2)}     ${r.peak.toFixed(2)}       ${r.minWhilePassing.toFixed(2)} rad`
      + `        ${r.closedAt === null ? " --" : r.closedAt.toFixed(1) + "m"}      ${r.exit.toFixed(1)} m/s`);
    if (r.peak < 0.8) allOpen = false;
    // Never springs shut through the car mid-pass.
    if (!(r.minWhilePassing > 0.02)) allHeld = false;
    // And it does close again once clear — a gate stuck open is not a gate.
    if (r.closedAt === null) allClosed = false;
    if (r.exit < 2) allThrough = false;
  }
  check("a FAST car pushes it open just as a slow one does", allOpen);
  check("it never springs shut through the car mid-pass", allHeld);
  check("it closes again once the car is clear, behind it", allClosed);
  check("the car always gets through — a gate must never trap you", allThrough);

  // The floor exists because the penalty compounds with TIME in contact, so a
  // slow car was punished hardest: 45 m/s kept 88% and 6 m/s kept 14%.
  const slow = pass(4), fast = pass(45);
  check("a crawling car can still nose it open (minPushSpeed floor)",
    slow.exit >= PHYSICS_PROP_TYPES.gate.minPushSpeed - 0.1,
    `${slow.exit.toFixed(1)} >= ${PHYSICS_PROP_TYPES.gate.minPushSpeed}`);
  check("a fast car keeps most of its speed — a knock, not a wall",
    fast.exit / 45 > 0.85, `${(100 * fast.exit / 45).toFixed(0)}%`);
  // It must still COST something, or the gate is decoration.
  const mid = pass(20);
  check("shoving a closed gate open does cost speed", mid.exit < 20 - 1,
    `20 -> ${mid.exit.toFixed(1)} m/s`);
}

console.log("\n=== NOTHING BUT THE PANEL OPENS THE GATE ===");
// The contact test used to be plan-view RADIUS from the hinge and nothing else,
// so anything inside `width + carR` counted — including the far side of the post,
// where the panel is not. `want = carAng ± halfW` then clamped to maxAngle and
// flung the gate wide open with nothing touching it, and the resistance braked a
// car that never met the panel. The panel is a RAY at bearing `angle`; the car
// has to overlap that ray, and be at the panel's HEIGHT.
{
  const P = PHYSICS_PROP_TYPES.gate;
  /**
   * Drive a straight line past a gate hinged at the origin (panel along +X) and
   * report the biggest swing it provoked and the speed the car kept.
   */
  const driveBy = ({ x, y = 0.5, z0 = -8, speed = 20 }) => {
    const root = new THREE.Object3D();
    const phys = new PropPhysics({ props: { instances: [{ id: "gate", root }] }, getGroundBvh: () => null });
    phys.sync();
    const g = phys.sims[0];
    const body = {
      pos: V(x, y, z0), vel: V(0, 0, speed), quat: new THREE.Quaternion(),
      getVelocityAtPoint(_p, o) { return o.copy(this.vel); },
    };
    let peak = 0;
    for (let i = 0; i < 16 / DT && body.pos.z < 16; i++) {
      body.pos.addScaledVector(body.vel, DT);
      phys.tick(DT, { enabled: true, body });
      peak = Math.max(peak, Math.abs(g.angle));
    }
    return { peak, exit: body.vel.z };
  };

  // BEHIND THE POST. Inside the old radius test (3 < 4.4 + 1.25) but 180° away
  // from the panel — the gate must not move and the car must not be braked.
  const behind = driveBy({ x: -3 });
  check("driving past the BACK of the hinge post leaves the gate shut",
    behind.peak < 0.02, `peak ${behind.peak.toFixed(3)} rad`);
  check("...and does not brake the car either", behind.exit > 19.9,
    `${behind.exit.toFixed(1)} m/s`);

  // OVER THE TOP. Panel top is baseY + height; a car well above it is jumping
  // the gate, not going through it.
  const over = driveBy({ x: P.width / 2, y: P.baseY + P.height + 1.5 });
  check("a car flying OVER the panel does not swing it",
    over.peak < 0.02, `peak ${over.peak.toFixed(3)} rad`);

  // The control: the same run at panel height still works, so the two tests
  // above are not passing because contact broke everywhere.
  const through = driveBy({ x: P.width / 2 });
  check("...while the same line at panel height still opens it",
    through.peak > 0.8, `peak ${through.peak.toFixed(2)} rad`);
}

console.log("\n=== THE GATE OPENS WHEN THE BONNET ARRIVES, NOT THE MIDDLE ===");
// The car was collided against the panel as a plan-view CIRCLE centred on
// `car.pos` — the chassis ORIGIN, i.e. the middle of a 4.85 m car. The bonnet
// sticks out ~2.5 m in front of the only point the gate was looking at, so the
// panel could not react until the car's middle had nearly arrived and the nose
// was already 1.2–1.8 m through it. That is what "I just drive through the gate"
// was, and it survived the whole hull rework because the gate never used the
// hull. tools/gateFootprintRepro.mjs has the before/after table.
{
  const noseAhead = CHASSIS_HULL.length / 2 + CHASSIS_HULL.offsetZ;

  /** Drive +Z through a gate hinged at the origin; report where it first moved. */
  const firstMove = ({ x, speed }) => {
    const root = new THREE.Object3D();
    const phys = new PropPhysics({ props: { instances: [{ id: "gate", root }] }, getGroundBvh: () => null });
    phys.sync();
    const g = phys.sims[0];
    const body = {
      pos: V(x, 0.5, -10), vel: V(0, 0, speed), quat: new THREE.Quaternion(),
      getVelocityAtPoint(_p, o) { return o.copy(this.vel); },
    };
    for (let i = 0; i < 8 / DT && body.pos.z < 12; i++) {
      body.pos.addScaledVector(body.vel, DT);
      phys.tick(DT, { enabled: true, body });
      // Panel plane is z = 0 while shut, so this is how far the NOSE is past it.
      if (Math.abs(g.angle) > 0.01) return body.pos.z + noseAhead;
    }
    return null;
  };

  let worst = 0, all = true;
  for (const x of [1.0, 2.2, 3.5, 4.2]) {
    for (const speed of [8, 20, 40]) {
      const over = firstMove({ x, speed });
      if (over === null) { all = false; continue; }
      worst = Math.max(worst, over);
    }
  }
  check("the gate reacts at every crossing point and speed", all);
  // One tick at 40 m/s is 0.33 m, so anything under that is as tight as a fixed
  // step can be. It was 1.84 m.
  check("the panel moves as the bonnet reaches it, not a car-length later",
    worst < 0.35, `worst nose overlap ${worst.toFixed(2)} m (was 1.84)`);

  // The footprint is a RECTANGLE, so a car alongside the gate — within a circle
  // of its length but nowhere near the panel — still must not touch it.
  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropPhysics.js"), "utf8");
  check("the contact test uses the hull footprint, not a radius",
    /_carFootprint\(car, s\.angle\)/.test(src) && /CHASSIS_HULL\.length/.test(src));
}

console.log("\n=== THE GATE NEVER ENDS UP INSIDE THE CAR ===");
// Two separate ways it did. The panel could not be displaced far enough (`want`
// is clamped to maxAngle) and the car drove on with it 0.57 m into the bodywork;
// and once the car was mostly through, `held` went false while its TAIL was
// still in the doorway, so the spring swung the gate shut across the car —
// measured in the running page at ~1.0 m, half a car width.
{
  const P = PHYSICS_PROP_TYPES.gate;
  const hull = CHASSIS_HULL;
  const hw = hull.width / 2, hl = hull.length / 2;

  /** Deepest reach of the panel segment into the car's plan rectangle. */
  const panelInsideCar = (angle, pos, quat) => {
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    const rgt = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    const cx = pos.x + fwd.x * hull.offsetZ, cz = pos.z + fwd.z * hull.offsetZ;
    let deep = 0;
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const px = Math.cos(angle) * P.width * t, pz = -Math.sin(angle) * P.width * t;
      const u = (px - cx) * rgt.x + (pz - cz) * rgt.z;
      const w = (px - cx) * fwd.x + (pz - cz) * fwd.z;
      if (Math.abs(u) > hw || Math.abs(w) > hl) continue;
      deep = Math.max(deep, Math.min(hw - Math.abs(u), hl - Math.abs(w)));
    }
    return deep;
  };

  const runPass = ({ x, speed }) => {
    const root = new THREE.Object3D();
    const phys = new PropPhysics({ props: { instances: [{ id: "gate", root }] }, getGroundBvh: () => null });
    phys.sync();
    const g = phys.sims[0];
    const body = {
      pos: V(x, 0.5, -14), vel: V(0, 0, speed), quat: new THREE.Quaternion(),
      getVelocityAtPoint(_p, o) { return o.copy(this.vel); },
    };
    let worst = 0, drift = 0, addedSpeed = 0;
    for (let i = 0; i < 10 / DT && body.pos.z < 16; i++) {
      body.pos.addScaledVector(body.vel, DT);
      const before = body.vel.length();
      phys.tick(DT, { enabled: true, body });
      addedSpeed += Math.max(0, body.vel.length() - before);
      worst = Math.max(worst, panelInsideCar(g.angle, body.pos, body.quat));
      drift = Math.max(drift, Math.abs(body.pos.x - x));
    }
    return { worst, drift, addedSpeed };
  };

  // Crossings CLEAR OF THE HINGE POST. A car within ~1.24 m of the hinge is
  // sitting on the post (hull half-width 1.05 + the post's 0.19 reach), and no
  // panel angle can clear a car that the panel's own root is underneath — that
  // case belongs to the post, which is a capsule collider on the vehicle side.
  let worst = 0, drift = 0, added = 0;
  for (const x of [1.4, 2.2, 3.0, 3.6, 4.3]) {
    for (const speed of [8, 20, 40]) {
      const r = runPass({ x, speed });
      worst = Math.max(worst, r.worst);
      drift = Math.max(drift, r.drift);
      added = Math.max(added, r.addedSpeed);
    }
  }
  check("the panel never ends up inside the bodywork",
    worst < 0.02, `worst ${worst.toFixed(3)} m (was 0.57 forcing, ~1.0 closing)`);

  // THE REQUIREMENT THAT MATTERS. An earlier fix achieved the above by pushing
  // the CAR out of the panel, which was worse than the bug: the panel is swung
  // BY the car, so the overlap to correct can be enormous, and the gate flung
  // the car sideways out of the doorway — 12.6 m over one pass, 1.87 m in a
  // single tick.
  check("...and the gate never moves the car to achieve it",
    drift < 1e-6, `${drift.toFixed(3)} m of lateral drift`);
  check("...nor ever speeds it up", added < 1e-6, `${added.toFixed(3)} m/s added`);

  const src = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropPhysics.js"), "utf8");
  check("the fix is on the PANEL — it only ever writes the hinge angle",
    /_keepPanelClearOfCar\(s, car\)/.test(src));
  check("...and nothing in the gate touches car.pos",
    !/car\.pos\.addScaledVector/.test(src));
  // Resistance still exists, but as a pure speed scrub: applied along the panel
  // normal it steered the car, because that normal swings with the panel.
  check("resistance scrubs SPEED rather than pushing along the panel normal",
    /car\.vel\.multiplyScalar\(Math\.max\(0, \(speed - drop\) \/ speed\)\)/.test(src));

  // The panel has to be able to lay back past the doorway, or it is pinned
  // against the car on every ordinary pass.
  check("the panel can swing past 90 degrees", P.maxAngle > Math.PI / 2,
    `${P.maxAngle} rad = ${(P.maxAngle * 180 / Math.PI).toFixed(0)}°`);
}
console.log("\n=== THE COLLIDER OVERLAY DRAWS WHAT THE SIM USES ===");
// "Show colliders" is a debugging instrument, so a wireframe that does not sit
// on the thing it describes costs more time than it saves. Both of its errors
// were in roadGame.js, not in the sim.
{
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  const dyn = game.slice(game.indexOf("function updateDynamicDebug"),
    game.indexOf("function setCollisionDebug"));
  // _tickHinge already writes `root.quaternion = home * R(angle)`. Multiplying
  // R(angle) in again here made the wireframe lead the panel BY THE SWING — 86°
  // out at the hinge limit, which is what "it doesn't follow the gate" was.
  check("the hinge wireframe does not re-apply the swing the root already carries",
    !/setFromAxisAngle/.test(dyn));
  // And it is built at the panel's real height rather than centred on the root,
  // which had it drawing half a metre underground.
  const build = game.slice(game.indexOf("function buildDynamicDebug"),
    game.indexOf("function updateDynamicDebug"));
  check("the hinge wireframe is lifted to the panel's own baseY",
    /translate\(p\.width \/ 2, p\.baseY/.test(build));
  check("the sim's panel height and the mesh's are the same constants",
    /GATE_HEIGHT/.test(readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8")));
}

console.log("\n=== CONES STAY STRICTLY ONE-WAY ===");
{
  const { phys } = mk([{ id: "cone", x: 0, z: 0 }, { id: "barrel", x: 1.5, z: 3 }]);
  const car = fakeCar({ pos: V(0, 0.5, -4), vel: V(0, 0, 25) });
  const vehicle = { enabled: true, body: car.body };
  const v0 = car.body.vel.clone();
  let touched = 0;
  for (let i = 0; i < 0.8 / DT; i++) {
    car.body.pos.addScaledVector(car.body.vel, DT);
    phys.tick(DT, vehicle);
    touched = Math.max(touched, phys.awakeCount);
  }
  check("the pass really did hit both the cone and the barrel", touched === 2, `${touched} awake`);
  check("neither perturbs the car, even with a vehicle handle available",
    car.body.vel.equals(v0), `${car.body.vel.toArray()}`);
}

console.log("\n=== DELETING A PROP CANNOT LEAVE A GHOST ===");
{
  const { props, phys } = mk([{ id: "cone", x: 0 }, { id: "cone", x: 5 }]);
  check("two sims to begin with", phys.sims.length === 2);
  props.instances.pop();               // PropManager deletes via its own key handler
  phys.tick(DT, null);                 // next tick self-heals
  check("the sim list follows a delete the game never told us about",
    phys.sims.length === 1, `${phys.sims.length}`);
}

console.log("\n=== SAVED WITH THE TRACK, AND OUT OF THE COLLISION BAKE ===");
{
  const propsSrc = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  /** Source text of one PROP_CATALOG entry, `id:` up to the start of the next. */
  const catalogEntry = (id) => {
    const start = propsSrc.indexOf(`id: "${id}"`);
    if (start < 0) return null;
    const next = propsSrc.indexOf('\n    id: "', start + 1);
    return propsSrc.slice(start, next < 0 ? propsSrc.length : next);
  };
  /** Source with comments stripped — retired helpers are kept commented in this
   *  file "for restore", and a plain regex happily matches them from in there,
   *  which turns a dead code path into a passing check. */
  const uncommented = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  // THE INVARIANT IS PER-MESH, NOT PER-PROP. A moving collider in the static bake
  // is an invisible wall welded where it was authored while the visible prop
  // swings/flies off on its own — but "no simulated geometry in the bake" does
  // not mean "no geometry at all". The swing gate's POST never moves and is a
  // solid; only its panel is excluded. So: every mesh a physics prop simulates
  // must be either out of the bake by prop, or out by `noCollide`.
  for (const id of Object.keys(PHYSICS_PROP_TYPES)) {
    const entry = catalogEntry(id);
    check(`"${id}" is in PROP_CATALOG, so it saves/loads with the track`, !!entry);
    const collision = /collision: "([a-z]+)"/.exec(entry ?? "")?.[1];
    // The gate's stripe used to be a second mesh and needed excluding too; it is
    // painted into the panel's texture now, so the panel is all that moves.
    const simulated = { cone: [], gate: ["panel"] }[id] ?? [];
    const excluded = collision === "none"
      || simulated.every((m) => new RegExp(`${m}\\.userData\\.noCollide = true`).test(entry ?? ""));
    check(`"${id}" keeps its SIMULATED geometry out of the static bake`,
      excluded, collision === "none" ? "collision:none" : `collision:${collision} + noCollide`);
  }
  check("collisionMeshes() honours the per-mesh opt-out",
    /noCollide/.test(propsSrc.slice(propsSrc.indexOf("collisionMeshes()"))));
  // And the half that has to STAY solid: a hinge post you drive through is not a
  // gate. It is only bakeable because it is a cylinder on the rotation axis.
  check("the gate's hinge post IS a static solid",
    /collision: "solid"/.test(catalogEntry("gate") ?? ""));

  // NO COPLANAR DECAL GEOMETRY. A second mesh laid on a flat face z-fights the
  // moment depth precision runs out, which on a track this size is a few tens of
  // metres away — the gate's white band shimmered for exactly this reason. Bands
  // and stripes are painted into a shared texture instead, which also keeps each
  // prop to one draw.
  check("the pole's hazard rings are a texture, not stacked geometry",
    /Texture\(\)/.test(catalogEntry("pole") ?? ""),
    "coplanar decal meshes always z-fight eventually");
  // The gate's red/white band is GONE — the panel is solid red now, and the 1-D
  // texture is kept commented in modularRoadProps.js "for restore". So there is
  // no texture left to assert; what still has to hold is the reason it was one,
  // which is that nothing coplanar got stacked back onto the panel face.
  check("the gate's panel carries no stacked band mesh",
    !/\b(band|stripe)\b/i.test(uncommented(catalogEntry("gate") ?? "")));
  // Only the pole's — and matched against UNCOMMENTED source, because the gate's
  // retired helper still sits in the file as a comment and was quietly
  // satisfying this check from inside it.
  check("...and that texture is built once for the whole catalog, not per prop",
    /if \(_poleBandTex\) return _poleBandTex;/.test(uncommented(propsSrc)));
  // ROUND-TRIPPED, NOT GREPPED. These two used to match the literal source of
  // exportTrack/importTrack, and they broke the moment that function was
  // restructured — while still being perfectly true. modularRoadTrackIO has no
  // runtime imports at all (its manager types are JSDoc-only), so the real
  // thing runs here against stubs and the assertion survives a refactor.
  const trackIO = await import(
    pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadTrackIO.js")).href);
  const savedProps = [{ type: "cone", position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }];
  const stubMgr = (out) => ({
    exportInstances: () => out,
    importInstances(v) { this.got = v; },
    exportLayout: () => [],
    importLayout(v) { this.got = v; },
  });
  const propsStub = stubMgr(savedProps);
  const ioCtx = (b, p) => ({
    builder: b, props: p, movers: stubMgr([]), portals: stubMgr([]),
    roadParams: {}, guardrailParams: {}, pieceParams: {}, portalParams: {}, roadLook: {},
  });
  const savedTrack = trackIO.exportTrack(
    ioCtx({ exportTrackPieces: () => [] }, propsStub));
  check("track export includes props",
    JSON.stringify(savedTrack.props) === JSON.stringify(savedProps));

  const loadedInto = stubMgr([]);
  const res = trackIO.importTrack(
    JSON.parse(JSON.stringify(savedTrack)),
    ioCtx({ importTrackPieces() {}, resetHistory() {}, count: 0 }, loadedInto));
  check("track import restores them",
    res.ok && JSON.stringify(loadedInto.got) === JSON.stringify(savedProps),
    res.ok ? "" : res.error);
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  check("physics re-syncs after a track import (positions become the new home)",
    /propPhysics\.sync\(\)/.test(game));
  check("props reset with everything else on respawn", /propPhysics\.reset\(\)/.test(game));
  // AND AFTER A GIZMO EDIT, which is the one that was missing. The sim captures
  // the authored transform once as `home` and then writes `home × swing` onto the
  // root every frame, so moving or rotating a simulated prop without re-syncing
  // leaves `home` at the pose it was first dropped in — and physics puts it back
  // there the instant play starts. Reported as a swing gate that ignored its
  // rotation on entering play mode. Only cones and gates could ever show it,
  // which is why every other prop moved fine.
  {
    const cb = game.match(/onChange:\s*\(\)\s*=>\s*\{[^}]*flags\?\.sync\(\)[^}]*\}/s)?.[0] ?? "";
    check("physics re-syncs after a prop is MOVED or ROTATED with the gizmo",
      /propPhysics\??\.sync\(\)/.test(cb),
      "the PropManager onChange fires on add/delete/gizmo-release — flags.sync() is "
      + "already there for the same class of bug, propPhysics.sync() must be too");
  }
  check("physics ticks on the FIXED step, not the render frame",
    /propPhysics\.tick\(FIXED_DT/.test(game));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
