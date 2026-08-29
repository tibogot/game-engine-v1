// Reported: "on the new half-tube pieces the car never gets air off the lip —
// the most it does is sit at the edge."
//
// Same method as tubeControlRepro: the surface is ANALYTIC, so nothing here can
// be blamed on triangles, seams or BVH normals. The only difference from that
// file is that this cylinder STOPS at the lip — beyond ±(span/2) from the floor
// there is no surface at all, which is exactly what a half tube is.
//
// The question is narrow: driving ACROSS the pipe (the way a snowboarder rides a
// half-pipe, not the way you helix a closed tube), does the car ever leave the
// lip, and how high does it go?
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.halftuberepro.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, AERO, CHASSIS, WHEEL, FIXED_DT, GRAVITY, SURFACE_GRIP } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const R2D = 57.2958;
const R = 8;          // kit default tubeRadius
const CY = R;         // axis height, so the floor is y = 0
let SPAN = 180;       // halfTubeSpan, degrees of arc that survives

/** Half-angle from the floor at which the surface ends. */
const lipAng = () => (SPAN / 2) / R2D;
/** World y of the lip for the current span. */
const lipY = () => CY - Math.cos(lipAng()) * R;

function inwardNormalAt(x, y, out) {
  const u = x, v = y - CY;
  const d = Math.hypot(u, v) || 1e-9;
  return out.set(-u / d, -v / d, 0);
}

/** Is this point on the surviving arc? angle measured from the floor (0,-1). */
function onArc(x, y) {
  const u = x, v = y - CY;
  const d = Math.hypot(u, v) || 1e-9;
  // cos of angle from straight down
  return -v / d >= Math.cos(lipAng()) - 1e-9;
}

function castInner(o, d, far, radius = R) {
  const u = o.x, v = o.y - CY;
  const a = d.x * d.x + d.y * d.y;
  if (a < 1e-12) return null;
  const b = 2 * (u * d.x + v * d.y);
  const c = u * u + v * v - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > far) return null;
  const px = o.x + d.x * t, py = o.y + d.y * t, pz = o.z + d.z * t;
  if (!onArc(px, py)) return null;              // ← the whole difference: open top
  const n = inwardNormalAt(px, py, new THREE.Vector3());
  return { distance: t, point: { x: px, y: py, z: pz }, normal: { x: n.x, y: n.y, z: n.z }, faceIndex: 0 };
}

const _cpN = new THREE.Vector3();
const halfTube = {
  baked: true,
  raycastFirst(o, d, far) { return castInner(o, d, far); },
  spherecast(ox, oy, oz, radius, dx, dy, dz, maxDist) {
    const len = Math.hypot(dx, dy, dz) || 1;
    return castInner({ x: ox, y: oy, z: oz }, { x: dx / len, y: dy / len, z: dz / len },
      maxDist, Math.max(0.01, R - radius));
  },
  closestPointWithNormal(px, py, pz, maxDist, outN) {
    const u = px, v = py - CY;
    const d = Math.hypot(u, v);
    if (d < 1e-9) return null;
    const sx = (u / d) * R, sy = CY + (v / d) * R;
    if (!onArc(sx, sy)) return null;
    const gap = R - d;
    if (gap > maxDist) return null;
    inwardNormalAt(px, py, _cpN);
    outN.copy(_cpN);
    return { x: sx, y: sy, z: pz, distance: Math.max(0, gap) };
  },
};
const noSolids = { baked: false, closestPointWithNormal: () => null };

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/**
 * Start on the floor of the pipe heading at `headingDeg` off the tube axis
 * (0 = straight down the pipe, 90 = straight at the wall).
 */
function makeCar(speed, headingDeg) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = halfTube;
  c.solidsBvh = noSolids;
  c.getFloorY = () => -1e4;
  c.enabled = true;
  const h = headingDeg / R2D;
  c.body.pos.set(0, WHEEL.radius + 0.18, 0);
  // identity quat = forward +Z; yaw so forward points at the -x wall.
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h);
  c.body.vel.set(-Math.sin(h) * speed, 0, Math.cos(h) * speed);
  c.body.angVel.set(0, 0, 0);
  return c;
}

const _fwd = new THREE.Vector3();

/**
 * Ride at a fixed heading, no steering — a straight run at the wall. Reports the
 * highest the car ever gets and how much of that was above the lip (= real air).
 */
function launch({ speed = 30, heading = 90, secs = 4, throttle = 1, sgGain = null, steer = 0 }) {
  const s = SURFACE_GRIP.gain;
  if (sgGain !== null) SURFACE_GRIP.gain = sgGain;
  const c = makeCar(speed, heading);
  const n = Math.round(secs / FIXED_DT);
  let peakY = -1e9, airTicks = 0, peakAirY = -1e9;
  let vAtLip = null, sgAtLip = 0, lastG = 4, tLeave = 0;
  const LY = lipY();
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: steer, throttle, handbrake: false, yaw: 0, pitch: 0 });
    const y = c.body.pos.y;
    if (y > peakY) peakY = y;
    const g = c.groundedCount;
    if (g === 0) {
      airTicks++;
      if (y > peakAirY) peakAirY = y;
      if (lastG > 0 && vAtLip === null) {
        vAtLip = c.body.vel.clone();
        sgAtLip = c._sgMag;
        tLeave = i * FIXED_DT;
      }
    }
    lastG = g;
  }
  SURFACE_GRIP.gain = s;
  return {
    peakY, aboveLip: peakY - LY, airPct: (100 * airTicks) / n,
    vAtLip, sgAtLip, tLeave, endSpeed: c.body.vel.length(),
  };
}

console.log("=== SETUP ===");
console.log(`  half tube r=${R}, floor y=0, lip y=${lipY().toFixed(2)} at span ${SPAN}°`);
console.log(`  ballistic floor→lip needs ${Math.sqrt(2 * GRAVITY * lipY()).toFixed(1)} m/s of PURELY UPWARD speed`);
console.log(`  SURFACE_GRIP gain ${SURFACE_GRIP.gain} maxG ${SURFACE_GRIP.maxG} ease ${SURFACE_GRIP.ease}`);
console.log(`  AERO.downforce ${AERO.downforce}   topSpeed ${TIRE.topSpeed}`);

console.log("\n=== 1. STRAIGHT AT THE WALL — DOES IT EVER LEAVE THE LIP? ===");
console.log("  No steering, full throttle, car aimed `heading`° off the pipe axis.");
console.log("  'above lip' > 0 means it actually cleared the rim.\n");
console.log("   heading  speed   peak y   above lip   air%   speed at lip");
for (const heading of [30, 60, 90]) {
  for (const speed of [15, 25, 35, 45]) {
    const r = launch({ speed, heading });
    console.log(
      `   ${String(heading).padStart(6)}°  ${String(speed).padStart(4)}`
      + `   ${r.peakY.toFixed(2).padStart(6)}`
      + `   ${r.aboveLip.toFixed(2).padStart(8)}`
      + `   ${r.airPct.toFixed(0).padStart(4)}%`
      + `   ${r.vAtLip ? r.vAtLip.length().toFixed(1).padStart(6) : "     -"}`
      + (r.vAtLip ? `   (vy ${r.vAtLip.y.toFixed(1)}, sg ${(r.sgAtLip / (CHASSIS.mass * GRAVITY)).toFixed(1)}g)` : ""),
    );
  }
  console.log("");
}

console.log("=== 2. IS SURFACE_GRIP HOLDING IT DOWN? (gain sweep, heading 90) ===");
console.log("  gain 0 = the assist does not exist. If air appears only at gain 0,");
console.log("  the concave-grip assist is what is eating the launch.\n");
console.log("   gain   speed   peak y   above lip   air%");
for (const g of [0, 0.5, 0.85, 1.2]) {
  for (const speed of [25, 35]) {
    const r = launch({ speed, heading: 90, sgGain: g });
    console.log(
      `   ${g.toFixed(2).padStart(4)}   ${String(speed).padStart(4)}`
      + `   ${r.peakY.toFixed(2).padStart(6)}   ${r.aboveLip.toFixed(2).padStart(8)}`
      + `   ${r.airPct.toFixed(0).padStart(4)}%`,
    );
  }
}

console.log("\n=== 3. ENERGY AUDIT: WHERE DOES THE CLIMB GO? ===");
console.log("  A pure ballistic climb from the floor keeps ALL its speed as height.");
console.log("  'ideal' is v0²/2g; 'reached' is what the car actually did.\n");
console.log("   speed   ideal climb   reached   kept%");
for (const speed of [15, 25, 35, 45]) {
  const r = launch({ speed, heading: 90 });
  const ideal = (speed * speed) / (2 * GRAVITY);
  console.log(
    `   ${String(speed).padStart(4)}   ${ideal.toFixed(1).padStart(9)} m`
    + `   ${r.peakY.toFixed(2).padStart(6)} m   ${(100 * r.peakY / ideal).toFixed(0).padStart(4)}%`,
  );
}

console.log("\n=== 4. SPAN: DOES A SHALLOWER PIPE LAUNCH? ===");
console.log("  120° span puts the lip lower and the wall NOT vertical at the rim, so");
console.log("  the exit tangent points up-and-out instead of straight up.\n");
console.log("   span   lip y   speed   peak y   above lip   air%");
for (const sp of [120, 150, 180, 240]) {
  SPAN = sp;
  for (const speed of [25, 35]) {
    const r = launch({ speed, heading: 90 });
    console.log(
      `   ${String(sp).padStart(4)}°  ${lipY().toFixed(2).padStart(5)}`
      + `   ${String(speed).padStart(5)}   ${r.peakY.toFixed(2).padStart(6)}`
      + `   ${r.aboveLip.toFixed(2).padStart(8)}   ${r.airPct.toFixed(0).padStart(4)}%`,
    );
  }
}
SPAN = 180;

console.log("\n=== 5. TRACE OF ONE RUN (35 m/s straight at the wall) ===");
{
  const c = makeCar(35, 90);
  console.log("      t      x       y    wheels   bank    vy      sg(g)");
  for (let i = 0; i < Math.round(3 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (i % Math.round(0.1 / FIXED_DT)) continue;
    const p = c.body.pos;
    const bank = Math.atan2(p.x, -(p.y - CY)) * R2D;
    _fwd.set(0, 0, 1).applyQuaternion(c.body.quat);
    console.log(
      `   ${(i * FIXED_DT).toFixed(2).padStart(5)}`
      + ` ${p.x.toFixed(2).padStart(6)}  ${p.y.toFixed(2).padStart(6)}`
      + `     ${c.groundedCount}    ${bank.toFixed(0).padStart(5)}°`
      + ` ${c.body.vel.y.toFixed(1).padStart(6)}`
      + `   ${(c._sgMag / (CHASSIS.mass * GRAVITY)).toFixed(2).padStart(5)}`,
    );
  }
}
console.log("");
