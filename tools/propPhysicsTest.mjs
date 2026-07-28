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
const PTMP = join(ROOT, `.pp.${process.pid}.mjs`);
writeFileSync(PTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropPhysics.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', `from "./${VTMP.split(/[\\/]/).pop()}"`));
const { PropPhysics, PROP_PHYSICS, PHYSICS_PROP_TYPES } = await import(pathToFileURL(PTMP).href);
const { CHASSIS } = await import(pathToFileURL(VTMP).href);
unlinkSync(PTMP); unlinkSync(VTMP);

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
    instances: list.map(({ id, x = 0, y = 0.28, z = 0 }) => {
      const root = new THREE.Object3D();
      root.position.set(x, y, z);
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
{
  const { phys } = mk([{ id: "cone", x: 0, z: 0 }]);
  const s = phys.sims[0];
  const before = s.body.pos.clone();
  // Car arriving at the cone at 25 m/s.
  const car = fakeCar({ pos: V(0, 0.6, -1.2), vel: V(0, 0, 25) });
  phys.tick(DT, car);
  check("the cone wakes on contact", !s.asleep);
  check("it is thrown forward, along the car's travel",
    s.body.vel.z > 5, `vz = ${s.body.vel.z.toFixed(1)} m/s`);
  check("but never outruns the car that hit it — that reads as a glitch",
    s.body.vel.length() < 25, `${s.body.vel.length().toFixed(1)} m/s vs the car's 25`);
  check("it gets some loft — a flat-sliding cone looks dead",
    s.body.vel.y > 0, `vy = ${s.body.vel.y.toFixed(2)}`);
  check("it TUMBLES: an off-centre hit produces spin, which is what sells it",
    s.body.angVel.length() > 1, `|w| = ${s.body.angVel.length().toFixed(1)} rad/s`);
  check("spin is capped to a cartwheel, not a blur",
    s.body.angVel.length() <= PROP_PHYSICS.maxSpin + 1e-6,
    `${s.body.angVel.length().toFixed(1)} <= ${PROP_PHYSICS.maxSpin} rad/s`);
  run(phys, null, 0.5);
  check("it actually moves", s.body.pos.distanceTo(before) > 1,
    `${s.body.pos.distanceTo(before).toFixed(1)} m`);
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
{
  const { phys } = mk([{ id: "cone", x: 0, z: 0 }]);
  const s = phys.sims[0];
  const car = fakeCar({ pos: V(0, 0.6, -1.2), vel: V(0, 0, 30) });
  phys.tick(DT, car);
  check("awake right after the hit", phys.awakeCount === 1);
  run(phys, null, 8);
  check("it comes to rest and SLEEPS (or it jitters and burns CPU forever)",
    phys.awakeCount === 0, `awake ${phys.awakeCount}`);
  check("it rests ON the ground, not sunk into it or floating",
    Math.abs(s.body.pos.y - PHYSICS_PROP_TYPES.cone.radius) < 0.05,
    `y = ${s.body.pos.y.toFixed(3)} (radius ${PHYSICS_PROP_TYPES.cone.radius})`);
  check("a sleeping prop costs nothing — no drift while asleep", (() => {
    const p = s.body.pos.clone();
    run(phys, null, 2);
    return s.body.pos.equals(p);
  })());
  check("the visual mesh follows the body", s.inst.root.position.equals(s.body.pos));
}

console.log("\n=== LAP RESET PUTS THEM BACK ===");
{
  const { phys } = mk([{ id: "cone", x: 3, z: 1 }, { id: "gate", x: 10 }]);
  const cone = phys.sims[0], gate = phys.sims[1];
  const home = cone.home.pos.clone();
  const car = fakeCar({ pos: V(3, 0.6, -0.2), vel: V(0, 0, 30) });
  run(phys, car, 1.5);
  check("the cone really was displaced first", cone.body.pos.distanceTo(home) > 0.5,
    `${cone.body.pos.distanceTo(home).toFixed(1)} m away`);
  gate.angle = 1.0; gate.angVel = 2;
  phys.reset();
  check("cone returns to its AUTHORED position", cone.body.pos.equals(home));
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

  // Net effect: base at 0, body centre at +radius — exactly where the ground
  // contact wants to hold it, so a resting cone never jumps when it wakes.
  const { phys } = mk([{ id: "cone", x: 0, y: PHYSICS_PROP_TYPES.cone.radius, z: 0 }]);
  const s2 = phys.sims[0];
  const y0 = s2.body.pos.y;
  phys.tick(DT, fakeCar({ pos: V(0, 0.6, -1.2), vel: V(0, 0, 8) }));
  run(phys, null, 6);
  check("a cone placed flush settles at the SAME height it was placed",
    Math.abs(s2.body.pos.y - y0) < 0.03,
    `placed ${y0.toFixed(2)} -> settled ${s2.body.pos.y.toFixed(2)}`);
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
  const { phys } = mk([{ id: "cone", x: 0, z: 0 }]);
  const car = fakeCar({ pos: V(0, 0.6, -1.2), vel: V(0, 0, 25) });
  const vehicle = { enabled: true, body: car.body };
  const v0 = car.body.vel.clone();
  for (let i = 0; i < 0.5 / DT; i++) phys.tick(DT, vehicle);
  check("a cone never perturbs the car, even with a vehicle handle available",
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
    const simulated = { cone: [], gate: ["panel", "stripe"] }[id] ?? [];
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
  const io = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadTrackIO.js"), "utf8");
  check("track export includes props", /props:\s*props\.exportInstances\(\)/.test(io));
  check("track import restores them", /importInstances\(data\.props\)/.test(io));
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  check("physics re-syncs after a track import (positions become the new home)",
    /propPhysics\.sync\(\)/.test(game));
  check("props reset with everything else on respawn", /propPhysics\.reset\(\)/.test(game));
  check("physics ticks on the FIXED step, not the render frame",
    /propPhysics\.tick\(FIXED_DT/.test(game));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
