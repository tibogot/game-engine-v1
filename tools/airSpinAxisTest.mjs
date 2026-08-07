// WHAT DOES Q/E ACTUALLY ROTATE, AND ABOUT WHAT?
//
// Two scenarios, because the whole question is what happens when the two
// candidate axes stop agreeing:
//   FLAT JUMP  — chassis up ≈ world up, so both axes are the same thing.
//   BOWL LIP   — nose straight up, so world up IS the car's roll axis and a
//                "flat spin" about it can only barrel-roll.
//
// The measurement is frame-relative, not Euler angles: track the car's own
// forward and up against where they started.
//   fwd·fwd0 → −1  and  up·up0 → +1   = a 180 IN THE CAR'S OWN PLANE (a skater's
//                                       180: you come down nose-first, same way up)
//   fwd·fwd0 → +1  and  up·up0 → −1   = a ROLL about the nose (what is happening now)
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const R2D = 57.2958;
const TMP = join(ROOT, `.yaw.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TIRE } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, pieceParams } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
unlinkSync(TMP);
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0,0,0,0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0,0,0,0].map(() => ({})); this.wheelSpin = [0,0,0,0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};
const mkBvh = (gs) => { const b = new RoadBvh(); b.bakeFromMeshes(gs.map((g) => {
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.updateMatrixWorld(true); return m; })); return b.baked ? b : null; };

function build(ids, pp) {
  let conn = new THREE.Matrix4(); const deck = [], rails = [];
  for (const id of ids) {
    const p = buildPiece(id, conn, pp);
    for (const g of [p.geometry, p.shellGeometry]) { if (!g) continue; const c = g.clone(); c.applyMatrix4(p.world); deck.push(c); }
    if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); rails.push(r); }
    conn = p.connectorOut;
  }
  const g = new THREE.PlaneGeometry(600,900); g.rotateX(-Math.PI/2); g.translate(0,-0.05,-400); deck.push(g);
  return { deck: mkBvh(deck), solids: mkBvh(rails) };
}

function run(label, ids, pp, holdFor) {
  const track = build(ids, pp);
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids); car.getFloorY = () => -300; car.enabled = true;
  car.body.pos.set(0,0.65,-4); car.body.quat.setFromAxisAngle(new THREE.Vector3(0,1,0), Math.PI);
  car.body.vel.set(0,0,-40); car._resetInterpolation();

  const f = new THREE.Vector3(), u = new THREE.Vector3();
  let f0 = null, u0 = null, tHold = 0, done = null;
  for (let i = 0; i < Math.round(30/FIXED_DT); i++) {
    const air = !car.tires.some((t) => t.grounded);
    f.set(0,0,1).applyQuaternion(car.body.quat);
    u.set(0,1,0).applyQuaternion(car.body.quat);
    // Start the spin once properly airborne and clear of the ramp.
    if (f0 === null && air && car.body.pos.y > 3) { f0 = f.clone(); u0 = u.clone(); }
    const spinning = f0 !== null && tHold < holdFor;
    if (spinning) tHold += FIXED_DT;
    car.tick({ steerTarget: 0, throttle: f0 === null ? 1 : 0, handbrake: false,
      yaw: spinning ? 1 : 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
    if (f0 !== null && tHold >= holdFor && done === null) {
      done = { fd: f.dot(f0), ud: u.dot(u0),
        noseUp: Math.asin(THREE.MathUtils.clamp(f0.y, -1, 1)) * R2D };
    }
    if (done) break;
  }
  if (!done) { console.log(`  ${label.padEnd(26)} never got airborne`); return null; }
  const verdict = done.fd < -0.7 && done.ud > 0.7 ? "180 IN THE CAR'S PLANE (what we want)"
    : done.ud < -0.7 && done.fd > 0.7 ? "ROLL about the nose  <-- WRONG"
    : "something in between";
  console.log(`  ${label.padEnd(26)} nose was ${done.noseUp.toFixed(0).padStart(3)}° up   ` +
    `fwd·fwd0 ${done.fd.toFixed(2).padStart(5)}   up·up0 ${done.ud.toFixed(2).padStart(5)}   ${verdict}`);
  return done;
}

const RUN = ["straight","straight","straight","straight","straight","straight"];
const flatPP = { ...pieceParams };
const bowlPP = { ...pieceParams, qpRadius: 60, qpAngle: 90 };
console.log(`\nspin-axis crossover: |fwd.y| ${TIRE.airYawUprightStart} -> ${TIRE.airYawUprightFull}`);
console.log("(below the first the axis is world up, above the second it is the car's own up)\n");
let bad = 0;
const check = (r, label) => {
  const ok = r && r.fd < -0.7 && r.ud > 0.7;
  if (!ok) bad++;
  return ok;
};
check(run("flat jump ramp", [...RUN, "jump", "straight"], flatPP, 0.7), "jump");
check(run("PARK BOWL lip", [...RUN, "quarterpipe"], bowlPP, 0.7), "bowl");
console.log(bad
  ? `\nFAIL - ${bad} scenario(s) did not produce a 180 in the car's own plane\n`
  : "\nall green - Q/E is a 180 on a jump AND up a wall\n");
process.exit(bad ? 1 : 0);
