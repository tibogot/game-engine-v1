// The "ring half" case: how much entry speed does the inside of a loop cost,
// and where does the car actually die on it?
//
// Ideal (frictionless, no drag) requirement to crest a loop of radius R:
//   v_top >= sqrt(gR)  (or you fall off the roof)  and  v_in >= sqrt(5gR).
// This measures what the actual tyre model needs on top of that.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.loop.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, GRAVITY, FIXED_DT, SURFACE_GRIP } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

/** Inside of a vertical ring of radius R in the y–z plane, centre (0,R,0).
 *  Bottom of the ring is the ground at y=0; x is free (infinitely wide). */
function loopGround(R) {
  const cy = R;
  return {
    baked: true,
    raycastFirst(o, d, far) {
      // |o + t d - C|² = R², in the y–z plane only (x is the ring's axis).
      const py = o.y - cy, pz = o.z;
      const a = d.y * d.y + d.z * d.z;
      if (a < 1e-9) return null;
      const b = 2 * (py * d.y + pz * d.z);
      const c = py * py + pz * pz - R * R;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return null;
      const sq = Math.sqrt(disc);
      let t = (-b + sq) / (2 * a);            // the far root = the wall ahead of us
      if (t < 0 || t > far) t = (-b - sq) / (2 * a);
      if (t < 0 || t > far) return null;
      const hy = o.y + d.y * t, hz = o.z + d.z * t;
      const inv = 1 / R;
      return {
        point: { x: o.x + d.x * t, y: hy, z: hz },
        distance: t, faceIndex: 0,
        normal: { x: 0, y: -(hy - cy) * inv, z: -hz * inv }, // inward
      };
    },
    spherecast() { return null; },
    closestPointWithNormal() { return null; },
  };
}
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/** Enter the ring at the bottom heading -z, full throttle. Track how far round
 *  it gets (angle from the bottom) and the speed there. */
function ride(R, v0, throttle = 1) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = loopGround(R); c.enabled = true;
  c.body.pos.set(0, 0.65, 0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -v0);
  let maxAng = 0, vAtMax = v0, minV = v0, lost = null;
  for (let i = 0; i < Math.round(14 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    // Angle travelled round the ring from the bottom (0 = entry, π = top).
    const ang = Math.atan2(-c.body.pos.z, -(c.body.pos.y - R));
    const a = ang < 0 ? ang + 2 * Math.PI : ang;
    if (a > maxAng && a < 2 * Math.PI - 0.2) { maxAng = a; vAtMax = c.body.vel.length(); }
    minV = Math.min(minV, c.body.vel.length());
    if (lost === null && c.tires.every((t) => !t.grounded) && a > 0.3) lost = a;
  }
  return { deg: maxAng * 57.2958, v: vAtMax, min: minV, lostAt: lost === null ? null : lost * 57.2958 };
}

for (const R of [12, 25]) {
  console.log(`\n=== RING RADIUS ${R} m  (top of the loop at ${2 * R} m) ===`);
  console.log(`  ideal entry to crest it:      ${Math.sqrt(5 * GRAVITY * R).toFixed(1)} m/s (${(Math.sqrt(5 * GRAVITY * R) * 3.6).toFixed(0)} km/h)`);
  console.log(`  ideal speed AT the top:       ${Math.sqrt(GRAVITY * R).toFixed(1)} m/s`);
  console.log("  entry m/s   reached   speed there   min v   lost contact at");
  for (const v0 of [20, 25, 30, 35, 40, 45, 48]) {
    const r = ride(R, v0);
    console.log(
      `  ${String(v0).padStart(9)}   ${r.deg.toFixed(0).padStart(5)}°   ${r.v.toFixed(1).padStart(11)}` +
      `   ${r.min.toFixed(1).padStart(5)}   ${r.lostAt === null ? "        —" : r.lostAt.toFixed(0).padStart(7) + "°"}` +
      `${r.deg > 175 ? "   crested" : "   FELL SHORT"}`,
    );
  }
}

console.log("\n=== SURFACE_GRIP is what makes the ring survivable at all ===");
const saved = SURFACE_GRIP.enabled;
for (const on of [true, false]) {
  SURFACE_GRIP.enabled = on;
  const r = ride(25, 45);
  console.log(`  SURFACE_GRIP ${on ? "on " : "off"}  reached ${r.deg.toFixed(0).padStart(3)}°  min v ${r.min.toFixed(1)}`);
}
SURFACE_GRIP.enabled = saved;
