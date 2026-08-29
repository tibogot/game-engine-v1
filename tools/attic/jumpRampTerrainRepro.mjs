// THE RAMP ON REAL (NON-FLAT) GROUND.
//
// Everything so far tested the jumpkicker prop over a dead-flat floor, where it
// is clean: 600 randomised approaches, max launch 33.1° against a 29.7° lip.
// But the player drops it on TERRAIN, and two things in the vehicle read the
// terrain heightfield directly, ignoring the prop entirely:
//
//   1. ground.raycastFirst (modularRoadGround.js) adds the terrain as a plain
//      VERTICAL projection at the probe's XZ and takes it if it is nearer than
//      the ramp — including at NEGATIVE distance (the `vertDist >= -1.0` window).
//   2. Vehicle._applyChassisGroundContact pushes any chassis corner that is
//      below the terrain with a 180 kN/m spring along **world +Y**. It is the
//      only force in the whole vehicle hard-coded to world up — i.e. the only
//      thing that can launch a car STRAIGHT UP regardless of the surface it is
//      on.
//
// The prop's underside is a flat 22 × 14 m plane snapped to the terrain at ONE
// point, so on any sloped ground the terrain cuts up through the ramp. This
// measures what that does, as a function of how much the ground rises over the
// ramp's length.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.jumprampterr.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { jumpRampGeometry } =
  await import(new URL("../../games/modular-road-v3/modularRoadParkour.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../../v3/play/modularRoadBvh.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../../v3/play/modularRoadGround.js", import.meta.url).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const W = 14, L = 22, H = 8, R2D = 57.2958;
const LIP = Math.atan((H * Math.PI / 2) / L) * R2D;
const base = jumpRampGeometry(W, L, H, 32);
const rampMesh = new THREE.Mesh(base);
rampMesh.updateMatrixWorld(true);
const deckBvh = new RoadBvh(); deckBvh.bakeFromMeshes([rampMesh]);
const solBvh = new RoadBvh(); solBvh.bakeFromMeshes([rampMesh]);

/**
 * Terrain that rises `rise` metres over the ramp's 22 m, starting AT the ramp
 * base (which is where the prop was snapped, so terrain(0) = 0 exactly).
 * Beyond the ramp it keeps going, as ground does.
 */
const terrainFor = (rise) => (x, z) => (-z / L) * rise;

function build(rise) {
  const getTH = terrainFor(rise);
  const g = createVehicleGround({ getTerrainHeight: getTH });
  g.setRoadBvh(deckBvh);
  g.setRoadSolidsBvh(solBvh);
  return { g, getTH };
}

function drive(rise, speed, { trace = false } = {}) {
  const { g, getTH } = build(rise);
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = g.ground; c.solidsBvh = g.solids;
  // EXACTLY what roadGame.js:751 does. This is the line my earlier harnesses
  // stubbed to -1e4, which switched the world-up corner spring off entirely.
  c.getFloorY = (x, z) => getTH(x, z);
  c.enabled = true;
  c.body.pos.set(0, WHEEL.radius + 0.18, 30);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -speed);

  let peakY = -1e9, launch = null, wasG = true, prevVy = 0, maxDVy = 0, maxAt = null;
  const rows = [];
  for (let i = 0; i < Math.round(6 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const p = c.body.pos, v = c.body.vel;
    const rel = p.y - getTH(p.x, p.z); // height above the ground, not above y=0
    peakY = Math.max(peakY, rel);
    const dvy = v.y - prevVy;
    if (dvy > maxDVy && p.z < -2) { maxDVy = dvy; maxAt = p.z; }
    prevVy = v.y;
    if (wasG && c.groundedCount === 0 && p.z < -L * 0.6 && !launch) {
      launch = { vy: v.y, vh: Math.hypot(v.x, v.z) };
    }
    wasG = c.groundedCount > 0;
    if (trace && p.z < -L + 6 && p.z > -L - 12) {
      rows.push({ z: p.z, y: p.y, terr: getTH(p.x, p.z), vy: v.y, dvy, g: c.groundedCount });
    }
    if (p.y < -40 || p.z < -L - 70) break;
  }
  return {
    deg: launch ? Math.atan2(launch.vy, launch.vh) * R2D : NaN,
    vy: launch?.vy ?? NaN, peakY, maxDVy, maxAt, rows,
  };
}

console.log(`Lip angle ${LIP.toFixed(1)}°. Ramp is ${L} m long and ${H} m tall, underside flat at y=0.`);
console.log(`"rise" = how much the ground climbs over those ${L} m at the spot the prop was dropped.\n`);

console.log("=== LAUNCH ANGLE vs GROUND SLOPE UNDER THE PROP (entry 26 m/s) ===");
console.log("   rise   slope |  launch°     Vy    peak(agl)   worst +ΔVy/tick @ z");
for (const rise of [0, 0.5, 1, 2, 3, 4, 6, 8, 10, 12]) {
  const r = drive(rise, 26);
  const slope = (Math.atan(rise / L) * R2D).toFixed(1);
  const flag = r.deg > LIP + 10 || r.maxDVy > 2 ? "   <== POP" : "";
  console.log(
    `  ${rise.toFixed(1).padStart(5)} ${slope.padStart(6)}° | ${(isFinite(r.deg) ? r.deg.toFixed(1) : "—").padStart(7)}°` +
    ` ${r.vy.toFixed(1).padStart(6)} ${r.peakY.toFixed(1).padStart(10)}` +
    `   ${r.maxDVy.toFixed(2).padStart(6)} @ ${r.maxAt !== null ? r.maxAt.toFixed(1) : "—"}${flag}`,
  );
}

console.log("\n=== SPEED × SLOPE (launch angle; lip is 29.7°) ===");
console.log("        rise→ " + [0, 1, 2, 3, 4, 6, 8].map((r) => `${r}m`.padStart(8)).join(""));
for (const speed of [14, 18, 22, 26, 30]) {
  const cells = [0, 1, 2, 3, 4, 6, 8].map((rise) => {
    const r = drive(rise, speed);
    return (isFinite(r.deg) ? `${r.deg.toFixed(0)}°` : "—").padStart(8);
  });
  console.log(`   ${String(speed).padStart(3)} m/s  ${cells.join("")}`);
}

console.log("\n=== TICK TRACE — 3 m rise, 26 m/s ===");
console.log("       z      y   terrain   agl     Vy     ΔVy  gr");
for (const r of drive(3, 26, { trace: true }).rows) {
  const agl = r.y - r.terr;
  const flag = r.dvy > 0.5 ? "  <== PUSH" : "";
  console.log(
    `  ${r.z.toFixed(2).padStart(7)} ${r.y.toFixed(2).padStart(6)} ${r.terr.toFixed(2).padStart(8)}` +
    ` ${agl.toFixed(2).padStart(6)} ${r.vy.toFixed(2).padStart(7)} ${r.dvy.toFixed(3).padStart(7)} ${String(r.g).padStart(3)}${flag}`,
  );
}
console.log("");
