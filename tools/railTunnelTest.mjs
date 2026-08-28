// ============================================================================
// THE CAR MUST NOT PASS THROUGH A GUARDRAIL — from any direction.
//
// The player's report was specific and it turned out to be exact: side-on hits
// hold, but "the top of the thin cap" leaks. Measured here against the REAL
// straight-piece rail collision proxy baked into the REAL RoadBvh, which is what
// roadGame's bakeCollision feeds the vehicle (railMesh.userData.collisionGeometry).
//
// WHY IT LEAKED. The proxy was two vertical walls with an open top, and two
// vertical walls cannot stop VERTICAL motion. A car coming down on the beam
// entered the 0.38 m gap between them; once the 2.10 m hull had swallowed the
// slab, every sample inside asked the cavity recovery which way was out and got
// a different answer each substep (measured: ±0.2–0.4 m of lateral teleport per
// tick), so it was ejected to whichever side won — 28 of 72 descents crossed to
// the far side AT ROAD LEVEL. Head-on and oblique hits never leaked at all,
// exactly as reported.
//
// THE FIX IS IN TWO PLACES, and both are needed:
//   • modularRoadRail.js  — railCollisionWalls() closes the top.
//   • modularRoadVehicle.js — SOLID.sitImpactSpeed. The resolver threw away
//     every mostly-up contact to stop the hull PARKING on a rail; that rule is
//     about resting, and it was silently applied to arrivals too, so the new lid
//     would have been discarded like everything else.
//
// Run:  node tools/railTunnelTest.mjs
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.railTunnelTest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));

const { Vehicle, FIXED_DT, CHASSIS_HULL, SOLID } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, roadParams } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { railParams } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadRail.js")).href);
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

/** A straight run; solids = the rail proxy, exactly as the game bakes it. */
let conn = new THREE.Matrix4();
const deckGeos = [], solidGeos = [];
for (let i = 0; i < 8; i++) {
  const p = buildPiece("straight", conn);
  const g = p.geometry.clone(); g.applyMatrix4(p.world); deckGeos.push(g);
  const proxy = p.railCollision ?? p.railGeometry;
  if (proxy) { const r = proxy.clone(); r.applyMatrix4(p.world); solidGeos.push(r); }
  conn = p.connectorOut;
}
const mk = (geos) => {
  const bvh = new RoadBvh();
  const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  for (const m of meshes) m.updateMatrixWorld(true);
  bvh.bakeFromMeshes(meshes);
  return bvh;
};
const deck = mk(deckGeos), solids = mk(solidGeos);

const hw = roadParams.width / 2;
const rw = Math.min(Math.max(0, roadParams.railWidth), hw * 0.45);
const railX = hw - rw * 0.5;
const beamTop = roadParams.railHeight + railParams.gap + railParams.height;
const HULL_BOTTOM = -0.30; // CHASSIS_HULL's floor, pinned by ride height

console.log(`\nrail centre x=±${railX.toFixed(2)}  beam top y=${beamTop.toFixed(2)}`);
console.log(`hull ${CHASSIS_HULL.width} m wide vs a 0.38 m slab  ·  SOLID.sitImpactSpeed ${SOLID.sitImpactSpeed} m/s`);
console.log(`solids ${solids.triCount} tris\n`);

/**
 * Throw the car at the RIGHT-hand rail and classify where it ended up.
 *
 * BLOCKED — never crossed the rail plane.
 * OVER    — crossed with the hull bottom clear of the beam top. A legitimate
 *           jump: you cleared the barrier rather than passing through it.
 * TUNNEL  — crossed while the hull still overlapped the beam. The bug.
 */
function run({
  y, speed, vy = 0, angleDeg = 90, rollDeg = 0, pitchDeg = 0, offset = 4, secs = 4,
  // Which way the car POINTS, independent of which way it moves.
  //   "travel"    — nose down the velocity vector. The driving-into-it cases.
  //   "road"      — nose along the road. A car that gets airborne and comes back
  //                 down is still pointing down the track, and it matters: the
  //                 hull is 4.85 m long against 2.10 m wide, so a car facing
  //                 ACROSS the road presents more than twice the span to the
  //                 rail and straddles it far more deeply.
  //   "broadside" — nose across the road. The stunt-game case: you were spun in
  //                 the air and land sideways on the barrier.
  heading = "travel",
}) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50; // sky track: keep the terrain floor far below
  car.enabled = true;
  car.body.pos.set(railX - offset, y, -20); // the track sweeps along −z
  const a = (angleDeg * Math.PI) / 180;
  car.body.vel.set(speed * Math.sin(a), vy, -speed * Math.cos(a));
  // Local +z is forward, so a Y-rotation of (π − a) puts the nose on the
  // velocity vector; at a = 90° that is +x, straight at the rail.
  const face = heading === "road" ? Math.PI // nose down the track, which runs −z
    : heading === "broadside" ? Math.PI / 2
      : Math.PI - a;
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), face);
  const q = new THREE.Quaternion();
  if (pitchDeg) car.body.quat.multiply(q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (pitchDeg * Math.PI) / 180));
  if (rollDeg) car.body.quat.multiply(q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (rollDeg * Math.PI) / 180));

  let crossed = false, crossY = 0;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    if (!crossed && car.body.pos.x > railX + 0.6) { crossed = true; crossY = car.body.pos.y; }
    if (car.body.pos.y < -5 || car.body.pos.z < -170) break;
  }
  if (!crossed) return "BLOCKED";
  return crossY + HULL_BOTTOM > beamTop - 0.02 ? "OVER" : "TUNNEL";
}

const tally = (label, cases) => {
  const bad = [];
  for (const c of cases) {
    if (run(c) === "TUNNEL") bad.push(c);
  }
  check(
    bad.length === 0,
    `${label}: ${cases.length - bad.length}/${cases.length} held`
    + (bad.length ? `  — through the rail: ${bad.map((c) => JSON.stringify(c)).slice(0, 4).join(" ")}` : ""),
  );
};

// ── 1. SIDE-ON. These always held; they are here so a future change to the
//      walls cannot quietly undo the half that already worked. ───────────────
console.log("— into the side —");
const oblique = [];
for (const angleDeg of [10, 20, 35, 55, 90]) {
  for (const speed of [22, 40, 60]) oblique.push({ y: 0.55, speed, angleDeg });
}
tally("oblique approaches, 10°–90° at up to 60 m/s", oblique);

const tilted = [];
for (const rollDeg of [0, 25, 45, 70]) {
  for (const speed of [22, 40]) tilted.push({ y: 0.9, speed, rollDeg });
}
for (const pitchDeg of [20, 45]) {
  for (const speed of [22, 40]) tilted.push({ y: 0.9, speed, pitchDeg });
}
tally("rolled and pitched hulls, hitting on a corner", tilted);

// ── 2. ONTO THE TOP. The reported case, and the one that leaked. ────────────
console.log("\n— onto the beam top —");
const descents = [];
for (const vy of [-4, -8, -12, -16, -20, -25, -30, -34]) {
  for (const speed of [0, 3, 6, 10, 15, 22, 30]) {
    for (const offset of [0.6, 1.2]) {
      descents.push({ y: 3.2, speed, vy, offset, heading: "road" });
    }
  }
}
tally("descents onto the beam, 4–34 m/s of fall × 0–30 m/s of drift", descents);

// Landing ON the rail and drifting back INBOARD must put the car on the road,
// never through the barrier it started on top of.
const inboard = [];
for (const vy of [-8, -16, -25]) {
  for (const speed of [-3, -10, -20]) {
    inboard.push({ y: 3.2, speed, vy, offset: 0, heading: "road" });
  }
}
tally("landing on the rail with inboard drift", inboard);

// BROADSIDE. Spun in the air and coming down across the barrier, so 4.85 m of
// hull straddles a 0.38 m slab. The worst case the geometry can be asked for,
// and a stunt track produces it regularly.
const broadside = [];
for (const vy of [-8, -16, -25]) {
  for (const speed of [0, 6, 15]) {
    for (const offset of [0.6, 1.2]) {
      broadside.push({ y: 3.2, speed, vy, offset, heading: "broadside" });
    }
  }
}
tally("landing broadside across the rail", broadside);

console.log(`\n${failed ? `FAIL — ${failed} check(s)` : "the rail holds from every direction"}\n`);
process.exit(failed ? 1 : 0);
