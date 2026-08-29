// Diagnostic: the gate does not open until the car's NOSE is already through it.
//
// _tickHinge collides the car as a plan-view CIRCLE of radius
// `CHASSIS_HULL.width/2 + 0.35` centred on `car.pos` — the chassis origin, which
// is the middle of the car. But the car is 4.85 m long, so its nose sticks out
// ~2.4 m ahead of the point the gate is measuring. The panel therefore cannot
// react until the car's MIDDLE is nearly at it, and by then the bonnet is well
// past the panel plane.
//
// The hull work did nothing for this: the hull is what the SOLIDS resolver uses,
// and the gate has its own separate proxy that was never connected to it.
//
// Measures the overlap at the moment the gate first moves. Read the table.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const VTMP = join(ROOT, `.gf.${process.pid}.mjs`);
writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const PTMP = join(ROOT, `.gfp.${process.pid}.mjs`);
writeFileSync(PTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropPhysics.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', `from "./${VTMP.split(/[\\/]/).pop()}"`));
const { PropPhysics, PHYSICS_PROP_TYPES } = await import(pathToFileURL(PTMP).href);
const { CHASSIS_HULL } = await import(pathToFileURL(VTMP).href);
unlinkSync(PTMP); unlinkSync(VTMP);

const DT = 1 / 120;
const P = PHYSICS_PROP_TYPES.gate;
const noseAhead = CHASSIS_HULL.length / 2 + CHASSIS_HULL.offsetZ;

console.log("=== SETUP ===");
console.log(`  hull ${CHASSIS_HULL.width} x ${CHASSIS_HULL.length}, nose ${noseAhead.toFixed(2)} m ahead of car.pos`);
console.log(`  gate panel reach ${P.width} m`);

/**
 * Drive the car along +Z through a gate hinged at the origin (panel along +X),
 * crossing the panel plane at `x` from the hinge, and report where the car was
 * when the panel FIRST moved.
 */
function pass({ x, speed }) {
  const root = new THREE.Object3D();
  const phys = new PropPhysics({ props: { instances: [{ id: "gate", root }] }, getGroundBvh: () => null });
  phys.sync();
  const g = phys.sims[0];
  const body = {
    pos: new THREE.Vector3(x, 0.5, -10), vel: new THREE.Vector3(0, 0, speed),
    quat: new THREE.Quaternion(), // +Z forward, so the nose leads by `noseAhead`
    getVelocityAtPoint(_p, o) { return o.copy(this.vel); },
  };
  let firstMoveZ = null, peak = 0;
  for (let i = 0; i < 8 / DT && body.pos.z < 12; i++) {
    body.pos.addScaledVector(body.vel, DT);
    phys.tick(DT, { enabled: true, body });
    if (firstMoveZ === null && Math.abs(g.angle) > 0.01) firstMoveZ = body.pos.z;
    peak = Math.max(peak, Math.abs(g.angle));
  }
  // The panel plane is z = 0 (gate closed). Positive overlap = the nose is
  // already PAST the panel by that much when the gate finally reacts.
  const overlap = firstMoveZ === null ? null : firstMoveZ + noseAhead;
  return { firstMoveZ, overlap, peak };
}

console.log("\n=== HOW FAR IN IS THE CAR WHEN THE PANEL FIRST MOVES? ===");
console.log("  crossing at   speed   car.pos.z   nose past the panel   peak swing");
let worst = 0;
for (const x of [1.0, 2.2, 3.5, 4.2]) {
  for (const speed of [8, 20, 40]) {
    const r = pass({ x, speed });
    if (r.overlap === null) { console.log(`  x=${x}  ${speed} m/s — never moved`); continue; }
    worst = Math.max(worst, r.overlap);
    console.log(`  x=${x.toFixed(1)} m`.padEnd(16)
      + `${String(speed).padStart(3)}     `
      + `${r.firstMoveZ.toFixed(2)}`.padStart(7) + "     "
      + `${r.overlap >= 0 ? "+" : ""}${r.overlap.toFixed(2)} m`.padEnd(20)
      + `${r.peak.toFixed(2)} rad`);
  }
}
console.log(`\n  WORST: the bonnet is ${worst.toFixed(2)} m through the panel before it moves at all.`);
console.log("  A gate that is struck by the middle of the car is a gate you drive through.");
