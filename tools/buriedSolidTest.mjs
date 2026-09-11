// ============================================================================
// A SOLID UNDER THE ROAD CANNOT BE HIT BY A CHASSIS ON THE ROAD.
//
// Reported from the game as "an invisible mesh blocks the car" at the tunnel
// portal on both side roads, with sparks when hit fast, and blocking BACKWARD
// too, "exactly where the blue line meets the red one" — the parapet's end cap
// meeting the lip deck at the portal plane. The parapet's end cap and the
// portal headwall both stop EXACTLY at street level, buried under the lip
// strip. Nothing on the road can touch them. But the chassis resolver's
// walled-in recovery could: a low hull sample within `insideReach` of that
// buried face, whose sideways ray meets the parapet, was judged INSIDE a wall
// and shoved out by up to a metre.
//
// The fix is SOLID.buriedBelow: a contact whose closest point lies at or below
// the lowest grounded tyre's contact is not a wall. This locks in:
//   • a buried face flush with the deck does not touch the car, forward or
//     backward, straight or oblique, alone or beside a real wall (the portal);
//   • the same face raised above the deck still blocks — the filter must never
//     eat a real wall.
//
// Run:  node tools/buriedSolidTest.mjs
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.buriedSolidTest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, SOLID } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group();
  this.chassisMesh = new THREE.Object3D();
  this.tireGroups = this.tires.map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group();
  this.arrowGroup.visible = false;
  this.arrows = this.tires.map(() => ({}));
  this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

const mk = (geos) => {
  const bvh = new RoadBvh();
  const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  for (const m of meshes) m.updateMatrixWorld(true);
  bvh.bakeFromMeshes(meshes);
  return bvh;
};

/** A flat road at y = 0, 40 m wide, running along z from +50 to −250. */
const deckGeo = new THREE.PlaneGeometry(40, 300).rotateX(-Math.PI / 2).translate(0, 0, -100);
const deck = mk([deckGeo]);

/** A vertical quad across the road at `z`, from x0..x1, y0..y1. */
const across = (z, x0, x1, y0, y1) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([
    x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z,
  ], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
};
/** A vertical quad along the road at `x`, from z0..z1, y0..y1. */
const along = (x, z0, z1, y0, y1) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([
    x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0,
  ], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
};

const PLANE_Z = -60;

/**
 * Drive the car through z = PLANE_Z at `speed` and report: did it cross, how
 * much speed it kept, and whether the solids resolver ever touched it.
 * `dir` +1 drives forward (nose −z), −1 reverses through it.
 */
function run(solids, { speed = 20, x = 0, yawDeg = 0, dir = 1, secs = Math.max(3, 60 / speed) }) {
  // A car spawned at speed with no throttle coasts down hard (it arrives at 8
  // m/s doing 1.3), so the slow cases hold a little throttle to reach the
  // plane at all; their `kept` figure is then not meaningful and not asserted.
  const throttle = speed < 10 ? 0.35 * dir : 0;
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  const startZ = PLANE_Z + dir * 30;
  car.body.pos.set(x, 0.55, startZ);
  // Nose along −z (local +z forward → Y rotation π), then yawed.
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + (yawDeg * Math.PI) / 180);
  car.body.vel.set(-dir * speed * Math.sin((yawDeg * Math.PI) / 180), 0, -dir * speed * Math.cos((yawDeg * Math.PI) / 180));
  // Settle the suspension for a few ticks with no motion first.
  const v0 = car.body.vel.clone();
  car.body.vel.set(0, 0, 0);
  for (let i = 0; i < 30; i++) car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  car.body.pos.set(x, car.body.pos.y, startZ);
  car.body.vel.copy(v0);

  let crossed = false, touched = 0, minSpeed = Infinity;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.tick({ steerTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    if (car._solidTouch) touched++;
    const s = Math.hypot(car.body.vel.x, car.body.vel.z);
    if (Math.abs(car.body.pos.z - PLANE_Z) < 8) minSpeed = Math.min(minSpeed, s);
    if (dir > 0 ? car.body.pos.z < PLANE_Z - 6 : car.body.pos.z > PLANE_Z + 6) { crossed = true; break; }
  }
  return { crossed, touched, minSpeed, kept: speed < 10 ? 1 : minSpeed / speed };
}

console.log(`SOLID.buriedBelow ${SOLID.buriedBelow} m  ·  SOLID.insideReach ${SOLID.insideReach} m\n`);

// ── 1. A buried face flush with the deck: not a wall. ─────────────────────
console.log("— a face across the road, its top edge flush with the deck —");
{
  const buried = mk([across(PLANE_Z, -10, 10, -1, 0)]);
  for (const c of [
    { speed: 20 }, { speed: 45 }, { speed: 8 },
    { speed: 20, dir: -1 }, { speed: 45, dir: -1 },
    { speed: 20, yawDeg: 15 }, { speed: 30, yawDeg: -25 },
  ]) {
    const r = run(buried, c);
    check(r.crossed && r.touched === 0 && r.kept > 0.8,
      `${JSON.stringify(c)}: ${r.crossed ? "crossed" : "BLOCKED"}, touched ${r.touched} ticks, kept ${(r.kept * 100).toFixed(0)}% of speed`);
  }
}

// ── 2. The same face raised above the deck is a wall and must still block. ─
console.log("\n— the same face standing on the deck —");
{
  const wall = mk([across(PLANE_Z, -10, 10, 0, 1)]);
  for (const c of [{ speed: 20 }, { speed: 45 }, { speed: 20, dir: -1 }]) {
    const r = run(wall, c);
    check(!r.crossed && r.touched > 0,
      `${JSON.stringify(c)}: ${r.crossed ? "WENT THROUGH" : "blocked"}, touched ${r.touched} ticks`);
  }
  // And a low kerb — well under the hull floor, but ABOVE the ground — is not
  // buried: the filter must not grow into "ignore anything low".
  const kerb = mk([across(PLANE_Z, -10, 10, 0, 0.14), across(PLANE_Z - 0.3, -10, 10, 0, 0.14)]);
  const r = run(kerb, { speed: 20 });
  check(r.touched > 0, `a 14 cm kerb is still seen (touched ${r.touched} ticks, ${r.crossed ? "crossed" : "blocked"}) — it must not be mistaken for buried`);
}

// ── 3. THE PORTAL: a real wall along the road, and a buried cap across its
//      end. The car hugs the wall (25 cm gap) and passes the cap at speed,
//      forward and backward. This is the reported layout. ───────────────────
console.log("\n— beside a wall, over its buried end cap (the underpass portal) —");
{
  const wallX = 1.05 + 0.25; // hull half-width + the gap
  const portal = mk([
    along(wallX, PLANE_Z, PLANE_Z - 40, -1, 1),         // the parapet, start at the plane
    across(PLANE_Z, wallX - 1.2, wallX, -1, 0),           // its buried end cap under the lip
    across(PLANE_Z, -10, wallX + 0.5, -7, 0),             // the headwall, top at street level
  ]);
  for (const c of [
    { speed: 20 }, { speed: 45 }, { speed: 6 },
    { speed: 20, dir: -1 }, { speed: 45, dir: -1 },
  ]) {
    const r = run(portal, c);
    check(r.crossed && r.touched === 0 && r.kept > 0.8,
      `${JSON.stringify(c)}: ${r.crossed ? "crossed" : "BLOCKED"}, touched ${r.touched} ticks, kept ${(r.kept * 100).toFixed(0)}% of speed`);
  }
  // Control: steer INTO the wall and it must still be a wall. The wall runs
  // both sides of the plane here so the drift meets it before the cap.
  const ctl = mk([
    along(wallX, PLANE_Z + 40, PLANE_Z - 40, -1, 1),
    across(PLANE_Z, wallX - 1.2, wallX, -1, 0),
  ]);
  const r = run(ctl, { speed: 20, yawDeg: -20 });
  check(r.touched > 0, `steering into the parapet still touches it (${r.touched} ticks)`);
}

console.log(failed ? `\n${failed} FAILURE(S)` : "\nALL PASS");
process.exit(failed ? 1 : 0);
