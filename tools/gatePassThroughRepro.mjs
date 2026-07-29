// Diagnostic: can the car pass THROUGH the swing gate's panel?
//
// The gate is not a collider. It is a CONSTRAINT: each tick the panel is
// displaced to the edge of the car's footprint, so the car pushes it aside
// rather than being stopped by it. That works right up to the point where the
// panel cannot be displaced far enough — `want` is clamped to `maxAngle` — and
// past that clamp there is nothing left holding the car out. The panel stops,
// the car keeps going, and the two occupy the same space.
//
// Measures it directly: every tick, is the car's plan-view rectangle overlapping
// the panel SEGMENT? Not "did the gate open" — did the bodywork and the panel
// intersect, and by how much.
//
// Not pass/fail — an instrument. Run it, read the table.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VTMP = join(ROOT, `.gp.${process.pid}.mjs`);
writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const PTMP = join(ROOT, `.gpp.${process.pid}.mjs`);
writeFileSync(PTMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadPropPhysics.js"), "utf8")
  .replace('from "../../v3/play/modularRoadVehicle.js"', `from "./${VTMP.split(/[\\/]/).pop()}"`));
const { PropPhysics, PHYSICS_PROP_TYPES } = await import(pathToFileURL(PTMP).href);
const { CHASSIS_HULL } = await import(pathToFileURL(VTMP).href);
unlinkSync(PTMP); unlinkSync(VTMP);

const DT = 1 / 120;
const P = PHYSICS_PROP_TYPES.gate;

/** Distance from point p to segment ab, all in plan (x,z). */
function ptSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * How far the panel segment reaches INSIDE the car's plan rectangle.
 * 0 = clear. Positive = the panel and the bodywork are in the same place.
 */
function panelInsideCar(angle, carPos, carQuat) {
  const hw = CHASSIS_HULL.width / 2, hl = CHASSIS_HULL.length / 2;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
  const rgt = new THREE.Vector3(1, 0, 0).applyQuaternion(carQuat);
  const fx = fwd.x, fz = fwd.z, rx = rgt.x, rz = rgt.z;
  const cx = carPos.x + fx * CHASSIS_HULL.offsetZ;
  const cz = carPos.z + fz * CHASSIS_HULL.offsetZ;
  // Panel runs from the hinge (origin) out along bearing `angle`.
  const ax = 0, az = 0;
  const bx = Math.cos(angle) * P.width, bz = -Math.sin(angle) * P.width;
  // Sample the segment and ask how deep each sample is inside the rectangle.
  let deepest = 0;
  const N = 48;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
    const u = (px - cx) * rx + (pz - cz) * rz;   // lateral in car frame
    const w = (px - cx) * fx + (pz - cz) * fz;   // longitudinal
    if (Math.abs(u) > hw || Math.abs(w) > hl) continue; // outside the rectangle
    deepest = Math.max(deepest, Math.min(hw - Math.abs(u), hl - Math.abs(w)));
  }
  return deepest;
}

console.log("=== SETUP ===");
console.log(`  panel reach ${P.width} m   maxAngle ${P.maxAngle} rad (${(P.maxAngle * 180 / Math.PI).toFixed(1)}°)`);
console.log(`  car hull ${CHASSIS_HULL.width} x ${CHASSIS_HULL.length} m`);
console.log(`  a panel needs ~90° to lie along the doorway and let a car past.`);

/** Drive along +Z through the gate, crossing the panel plane at x. */
function pass({ x, speed, yaw = 0 }) {
  const root = new THREE.Object3D();
  const phys = new PropPhysics({ props: { instances: [{ id: "gate", root }] }, getGroundBvh: () => null });
  phys.sync();
  const g = phys.sims[0];
  const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  const body = {
    pos: new THREE.Vector3(x, 0.5, -14).addScaledVector(dir, 0),
    vel: dir.clone().multiplyScalar(speed),
    quat,
    getVelocityAtPoint(_p, o) { return o.copy(this.vel); },
  };
  let worstOverlap = 0, worstAt = null, peak = 0, sawMax = false;
  for (let i = 0; i < 10 / DT && body.pos.z < 16; i++) {
    body.pos.addScaledVector(body.vel, DT);
    phys.tick(DT, { enabled: true, body });
    peak = Math.max(peak, Math.abs(g.angle));
    if (Math.abs(g.angle) >= P.maxAngle - 1e-4) sawMax = true;
    const ov = panelInsideCar(g.angle, body.pos, body.quat);
    if (ov > worstOverlap) { worstOverlap = ov; worstAt = +body.pos.z.toFixed(1); }
  }
  return { worstOverlap, worstAt, peak, sawMax, exit: body.vel.length() };
}

console.log("\n=== DOES THE PANEL END UP INSIDE THE CAR? ===");
console.log("  crossing at   speed   yaw   peak swing   hit limit   panel inside car");
let worst = 0;
for (const x of [0.8, 2.2, 3.6, 4.3]) {
  for (const speed of [10, 28]) {
    for (const yaw of [0, 0.35]) {
      const r = pass({ x, speed, yaw });
      worst = Math.max(worst, r.worstOverlap);
      console.log(`  x=${x.toFixed(1)}`.padEnd(16)
        + `${String(speed).padStart(3)}   `
        + `${yaw.toFixed(2)}   `
        + `${r.peak.toFixed(2)} rad`.padEnd(13)
        + `${r.sawMax ? "YES" : "no "}`.padEnd(12)
        + (r.worstOverlap > 0.02
          ? `${r.worstOverlap.toFixed(2)} m  <-- THROUGH IT (at z=${r.worstAt})`
          : "clear"));
    }
  }
}
console.log(`\n  WORST: the panel was ${worst.toFixed(2)} m inside the bodywork.`);
console.log("  maxAngle caps how far the panel can be displaced; past that cap");
console.log("  nothing is holding the car out, because the panel is a constraint");
console.log("  and not a collider.");
