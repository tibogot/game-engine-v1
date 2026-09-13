// City street clutter on the shared prop contact solver.
//
// What moved here from a private model, and what must hold because of it:
//   • the same solver as the track builder (no per-kind throw table)
//   • a hit is the car's HULL touching the object, not a strip ahead of the car
//   • fixed 120 Hz steps, so a hit does not depend on the frame rate
//   • the ground is the collider the car drives on, not one flat height
//   • a settled object returns its pool slot and can be hit again
//   • mass decides it: concrete barely moves, a bin flies
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

// Same harness as propPhysicsTest: the vehicle drags in GPU imports node lacks.
const tmp = (name) => join(ROOT, `.${name}.${process.pid}.mjs`);
const base = (p) => p.split(/[\\/]/).pop();
const VTMP = tmp("kv"), CTMP = tmp("kc"), KTMP = tmp("kk");
writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
writeFileSync(CTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropContact.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', `from "./${base(VTMP)}"`));
writeFileSync(KTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadCityKnockables.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', `from "./${base(VTMP)}"`)
  .replace('from "./modularRoadPropContact.js"', `from "./${base(CTMP)}"`));
let createCityKnockables, CITY_KNOCK;
try {
  ({ createCityKnockables, CITY_KNOCK } = await import(pathToFileURL(KTMP).href));
} finally {
  unlinkSync(KTMP); unlinkSync(CTMP); unlinkSync(VTMP);
}
const { CLUTTER_PHYSICS } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadCityClutter.js")).href);

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** InstancedMesh stand-in: the pool only writes matrices into slots. */
function fakeMesh(n) {
  const written = new Map();
  return {
    count: n,
    written,
    instanceMatrix: { needsUpdate: false },
    setMatrixAt(i, m) { written.set(i, m.clone()); },
  };
}
/** Placements the way modularRoadCityFurniture's place() makes them. */
function placements(points, gy = 0) {
  return points.map(([x, z], i) => ({
    m: new THREE.Matrix4().compose(V(x, gy, z), new THREE.Quaternion(), V(1, 1, 1)),
    x, z, idx: i,
  }));
}
function world(kind, points, { gy = 0, params } = {}) {
  const list = placements(points, gy);
  const mesh = fakeMesh(list.length);
  const k = createCityKnockables({ groups: [{ list, mesh, profile: CLUTTER_PHYSICS[kind] }], groundY: gy, params });
  return { k, list, mesh };
}
function car(pos, vel) {
  return { pos: pos.clone(), vel: vel.clone(), quat: new THREE.Quaternion(), angVel: V(0, 0, 0) };
}
/**
 * Drive at a render frame rate; the car swerves off `leaveAfter` s after the
 * first placement actually MOVES. (Not after `stats.knocked`: a body wakes when
 * the hull comes within its reach, a moment before it is touched, and a counter
 * carried over from an earlier pass would read as a hit at t = 0.)
 */
function drive(k, c, secs, { fps = 60, leaveAfter = Infinity, ground = null, each, list } = {}) {
  const dt = 1 / fps;
  const start = list?.map((e) => poseOf(e).p.clone());
  let hitAt = null;
  for (let t = 0; t < secs; t += dt) {
    c.pos.addScaledVector(c.vel, dt);
    k.update(dt, c, ground);
    if (hitAt === null && list?.some((e, i) => poseOf(e).p.distanceTo(start[i]) > 0.005)) hitAt = t;
    if (hitAt !== null && t - hitAt > leaveAfter) c.pos.x = 1e4;
    each?.(t);
  }
}
const poseOf = (e) => {
  const p = V(0, 0, 0), q = new THREE.Quaternion(), s = V(0, 0, 0);
  (e.liveM ?? e.m).decompose(p, q, s);
  return { p, up: V(0, 1, 0).applyQuaternion(q).y };
};

console.log("=== IDLE ===");
{
  const { k, list, mesh } = world("cone", [[0, 0], [3, 0]]);
  for (let i = 0; i < 120; i++) k.update(1 / 60, null, null);
  check("with no car nothing is simulated", k.stats.active === 0 && k.stats.knocked === 0);
  check("and nothing is written", mesh.written.size === 0 && list.every((e) => !e.liveM));
  const far = car(V(0, 0.5, -40), V(0, 0, 0));
  for (let i = 0; i < 60; i++) k.update(1 / 60, far, null);
  check("a car nowhere near touches nothing", k.stats.knocked === 0);
}

console.log("\n=== A CAR DRIVES THROUGH A CITY CONE ===");
{
  const { k, list, mesh } = world("cone", [[0, 0]]);
  const e = list[0];
  let minUp = 1, peakY = 0, peakActive = 0;
  drive(k, car(V(0.2, 0.5, -6), V(0, 0, 20)), 6, {
    list,
    leaveAfter: 0.1,
    each: () => {
      const s = poseOf(e);
      minUp = Math.min(minUp, s.up);
      peakY = Math.max(peakY, s.p.y);
      peakActive = Math.max(peakActive, k.stats.active);
    },
  });
  check("the hull touching it wakes exactly one body", k.stats.knocked === 1 && peakActive === 1,
    `knocked ${k.stats.knocked}, peak active ${peakActive}`);
  check("it is knocked over, not slid upright", minUp < 0.3, `up.y reached ${minUp.toFixed(2)}`);
  check("it leaves the ground", peakY > 0.3, `base peaked ${peakY.toFixed(2)} m up`);
  const rest = poseOf(e);
  check("it travels down the road", rest.p.z > 4, `rests ${rest.p.z.toFixed(1)} m on`);
  check("it settles and gives its pool slot back", k.stats.active === 0 && !e.active);
  check("its resting pose stays on the instance", !!e.liveM && mesh.written.has(0));
  check("culling and the broadphase now look where it LANDED",
    Math.abs(e.x - rest.p.x) < 1e-9 && Math.abs(e.z - rest.p.z) < 1e-9);
  check("it rests on the road, not under or above it", Math.abs(rest.p.y) < 0.35, `base y ${rest.p.y.toFixed(3)}`);
}

console.log("\n=== A SETTLED OBJECT CAN BE HIT AGAIN ===");
// The old pool marked an object `knocked` forever: drive at it a second time and
// you went straight through.
{
  const { k, list } = world("bin", [[0, 0]]);
  drive(k, car(V(0, 0.5, -6), V(0, 0, 12)), 5, { list, leaveAfter: 0.1 });
  const first = poseOf(list[0]).p.clone();
  check("first hit moved it", first.z > 1, `${first.z.toFixed(1)} m`);
  drive(k, car(V(first.x, 0.5, first.z - 6), V(0, 0, 12)), 5, { list, leaveAfter: 0.1 });
  const second = poseOf(list[0]).p;
  check("the second hit wakes it again", k.stats.knocked === 2, `knocked ${k.stats.knocked}`);
  check("...and moves it again", second.z > first.z + 1, `${first.z.toFixed(1)} -> ${second.z.toFixed(1)} m`);
}

console.log("\n=== MASS DECIDES IT ===");
{
  const moved = (kind, speed) => {
    const { k, list } = world(kind, [[0, 0]]);
    drive(k, car(V(0, 0.5, -6), V(0, 0, speed)), 5, { list, leaveAfter: 0.15 });
    return poseOf(list[0]).p.length();
  };
  const jersey = moved("jersey", 4), bin = moved("bin", 15), barrier = moved("barrier", 15);
  check("a 2 t concrete jersey nudged at 4 m/s moves centimetres", jersey < 0.3, `${jersey.toFixed(2)} m`);
  check("a 350 kg water barrier at 15 m/s goes less far than a 15 kg bin", barrier < bin * 0.8,
    `barrier ${barrier.toFixed(1)} m, bin ${bin.toFixed(1)} m`);
  check("a bin at 15 m/s is sent flying", bin > 5, `${bin.toFixed(1)} m`);
}

console.log("\n=== A CAR THAT DRIVES ON DOES NOT PLOW CONCRETE AT ITS OWN SPEED ===");
// The car is never slowed (one-way), so it used to act as an infinite-mass
// pusher for as long as it overlapped: a 2 t jersey met at 20 m/s was dragged
// to 20 m/s and slid 27 m. The virtual car hands it a 1.4 t collision's worth.
{
  const { k, list } = world("jersey", [[0, 0]]);
  let peakV = 0, last = poseOf(list[0]).p.clone();
  drive(k, car(V(0, 0.5, -6), V(0, 0, 20)), 5, {
    each: () => {
      const p = poseOf(list[0]).p;
      peakV = Math.max(peakV, p.distanceTo(last) * 60);
      last = p.clone();
    },
  });
  const d = poseOf(list[0]).p.length();
  // Two-body momentum: 20 · 1400 / 3400 ≈ 8.2 m/s, then concrete on tarmac.
  // Frame-to-frame, so a push-out TELEPORT counts as speed too — which is how a
  // 1 m sideways jump (the spent test read along a side face's normal) showed up.
  check("it takes a collision's speed, not the car's, and never teleports", peakV < 11,
    `peak ${peakV.toFixed(1)} m/s (car 20)`);
  check("and slides metres, not a block", d > 1 && d < 8, `${d.toFixed(1)} m`);
}

console.log("\n=== THE FRAME RATE DOES NOT DECIDE THE HIT ===");
{
  const rest = (fps) => {
    const { k, list } = world("cone", [[0, 0]]);
    drive(k, car(V(0.2, 0.5, -6), V(0, 0, 20)), 6, { fps, list, leaveAfter: 0.1 });
    return poseOf(list[0]).p;
  };
  const a = rest(30), b = rest(60), c = rest(144);
  const spread = Math.max(a.distanceTo(b), b.distanceTo(c), a.distanceTo(c));
  check("30, 60 and 144 fps land the cone in about the same place",
    spread < 2.5, `30:${a.z.toFixed(1)} 60:${b.z.toFixed(1)} 144:${c.z.toFixed(1)} m, spread ${spread.toFixed(2)}`);
}

console.log("\n=== IT LANDS ON THE GROUND THE CAR DRIVES ON ===");
// A bridge deck 6 m up: the old pool clamped everything to the street plane,
// so a cone knocked on a viaduct fell through it to the road below.
{
  const deckY = 6;
  const deck = {
    baked: true,
    raycastFirst(o, _d, far) {
      const dist = o.y - deckY;
      return dist >= -1 && dist <= far ? { distance: dist, point: { x: o.x, y: deckY, z: o.z }, normal: { x: 0, y: 1, z: 0 } } : null;
    },
  };
  // The pool's own street plane is at 0: only the collider knows about the deck.
  const { k, list } = world("cone", [[0, 0]], { gy: 0 });
  list[0].m.setPosition(0, deckY, 0);
  drive(k, car(V(0.2, deckY + 0.5, -6), V(0, 0, 15)), 6, { list, leaveAfter: 0.1, ground: deck });
  const p = poseOf(list[0]).p;
  check("a cone knocked on a raised deck rests on the deck, not the street below", p.y > deckY - 0.35 && p.y < deckY + 0.35,
    `base y ${p.y.toFixed(2)} (deck ${deckY}, street 0)`);
}

console.log("\n=== THE POOL CAP HOLDS ===");
{
  const pts = [];
  for (let i = 0; i < 60; i++) pts.push([((i % 3) - 1) * 0.6, i * 0.35]);
  const { k } = world("cone", pts, { params: { pool: 8 } });
  let peak = 0;
  drive(k, car(V(0, 0.5, -6), V(0, 0, 25)), 4, { each: () => { peak = Math.max(peak, k.stats.active); } });
  check("never more bodies than the pool allows", peak <= 8, `peak ${peak}`);
  check("default pool is the documented 32", CITY_KNOCK.pool === 32);
}

console.log("\n=== NOTHING NON-FINITE REACHES THE INSTANCE BUFFER ===");
{
  const { k, list, mesh } = world("pallet", [[0, 0], [1.3, 0]]);
  drive(k, car(V(0.6, 0.5, -6), V(0, 0, 40)), 6);
  let finite = true;
  for (const m of mesh.written.values()) if (!m.elements.every(Number.isFinite)) finite = false;
  for (const e of list) if (e.liveM && !e.liveM.elements.every(Number.isFinite)) finite = false;
  check("every matrix written is finite", finite);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
