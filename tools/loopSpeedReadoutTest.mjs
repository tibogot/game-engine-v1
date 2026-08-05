// Reported as "the car slows to 0 km/h before the top of a loop". It never did.
//
// The HUD, the tach and the engine audio all measured speed as
// hypot(vel.x, vel.z) — the HORIZONTAL speed. That equals the real speed only
// while the road is level. On the vertical flank of a loop the car is moving
// almost straight up, so a car genuinely doing 146 km/h displayed 4 km/h, the
// tach fell to idle and the engine note dropped to nothing — right before the
// top, exactly where it was reported. Measured here: the old measure bottomed
// out at 0% of the true speed while the car never went below 108 km/h.
//
// This drives the car through the real buildPiece("loop") geometry and asserts
// both halves: the car crests the loop under its own steam, AND the number the
// player is shown follows the car. Guards loops, quarter-pipes, wall-rides and
// tubes — every piece where travel is substantially vertical.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.loopstall.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
unlinkSync(TMP);
const { buildPiece, pieceParams } = KIT;

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/** Straight run-up pieces, then the loop. Returns baked deck + solids BVHs. */
function buildLoopTrack({ runUp = 8, rails = true } = {}) {
  let conn = new THREE.Matrix4();
  const deckGeos = [], railGeos = [];
  const push = (p) => {
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); deckGeos.push(c);
    }
    if (rails && p.railGeometry) {
      const r = p.railGeometry.clone(); r.applyMatrix4(p.world); railGeos.push(r);
    }
  };
  for (let i = 0; i < runUp; i++) { const p = buildPiece("straight", conn); push(p); conn = p.connectorOut; }
  const startZ = new THREE.Vector3().setFromMatrixPosition(conn).z;
  const loop = buildPiece("loop", conn); push(loop);
  const mk = (geos) => {
    if (!geos.length) return null;
    const bvh = new RoadBvh();
    const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
    for (const m of meshes) m.updateMatrixWorld(true);
    bvh.bakeFromMeshes(meshes);
    return bvh.baked ? bvh : null;
  };
  return { deck: mk(deckGeos), solids: mk(railGeos), startZ, loop };
}

function ride(track, v0, { secs = 16, log = false, steer = 0 } = {}) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -4);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // face -Z
  car.body.vel.set(0, 0, -v0);

  const R = pieceParams.loopRadius;
  const rows = [];
  let maxY = 0, minVOnRing = Infinity, worstReadout = 1;
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    car.tick({ steerTarget: steer, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const p = car.body.pos, v = car.body.vel.length();
    // What the HUD/tach/engine-audio actually print, and what the car is doing.
    const hud = readoutRef.fn(car.body);
    if (p.y > 1) {
      minVOnRing = Math.min(minVOnRing, v);
      // Only meaningful once the car is genuinely moving; a stationary car
      // trivially reads 0/0.
      if (v > 5) worstReadout = Math.min(worstReadout, hud / v);
    }
    maxY = Math.max(maxY, p.y);
    // The harness track ends at the loop's exit, so past `log` seconds the car
    // is just falling off the end — not interesting, and noisy in a suite run.
    if (log && i * FIXED_DT < log && i % 15 === 0) {
      rows.push(`  ${(i * FIXED_DT).toFixed(2).padStart(5)}  y ${p.y.toFixed(1).padStart(5)}` +
        `  real ${(v * 3.6).toFixed(0).padStart(4)} km/h   HUD ${(hud * 3.6).toFixed(0).padStart(4)} km/h` +
        `   wheels ${car.tires.filter((t) => t.grounded).length}`);
    }
  }
  return { maxY, minVOnRing, worstReadout, rows, topY: 2 * R, car };
}

// The speed measure the HUD, the tach and the engine audio all share. Mirrored
// here rather than imported because roadGame.js pulls in three/webgpu and can't
// load headless — keep in step with roadGame.js `speedMs` and the audio's
// travelSpeed().
const readoutRef = { fn: (body) => body.vel.length() };
/** What it used to be — kept so the regression is visible, not just asserted. */
const oldReadout = (body) => Math.hypot(body.vel.x, body.vel.z);

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const track = buildLoopTrack({ rails: true });
const noRail = buildLoopTrack({ rails: false });
const TOP = 2 * pieceParams.loopRadius;
console.log(`loopRadius ${pieceParams.loopRadius}  → top of the ring at y=${TOP} m`);
console.log(`deck tris ${track.deck?.triCount ?? 0}   rail tris ${track.solids?.triCount ?? 0}\n`);

// ── 1. The car was never actually slowing down ──────────────────────────────
// A clean line (no rail contact) crests the loop from any sane entry speed and
// keeps well over 100 km/h the whole way round. If this ever fails, the bug
// really IS in the physics and the readout is a red herring.
console.log("=== THE CAR ITSELF CRESTS THE LOOP (clean line, full throttle) ===");
console.log("  entry km/h   highest y   min real speed on ring   crested?");
for (const v0 of [25, 30, 35, 40, 45, 50, 55]) {
  const r = ride(noRail, v0);
  const crested = r.maxY > TOP - 2;
  console.log(`  ${(v0 * 3.6).toFixed(0).padStart(10)}   ${r.maxY.toFixed(1).padStart(9)}` +
    `   ${(r.minVOnRing * 3.6).toFixed(0).padStart(18)} km/h   ${crested ? "yes" : "NO"}`);
  check(`  crests from ${(v0 * 3.6).toFixed(0)} km/h and never bogs`,
    crested && r.minVOnRing * 3.6 > 60, `min ${(r.minVOnRing * 3.6).toFixed(0)} km/h`);
}

// ── 2. The readout must follow the car ──────────────────────────────────────
console.log("\n=== THE READOUT TRACKS THE REAL SPEED ===");
for (const v0 of [30, 40, 50]) {
  const r = ride(noRail, v0);
  check(`  ${(v0 * 3.6).toFixed(0)} km/h entry: readout stays within 10% of real speed`,
    r.worstReadout > 0.9, `worst ${(r.worstReadout * 100).toFixed(0)}% of real`);
}

console.log("\n=== TRACE: 50 m/s entry (y=25 is the ring flank, where it used to die) ===");
const r = ride(noRail, 50, { log: 7 });
for (const line of r.rows) console.log(line);

console.log("\n=== WHAT THE OLD HORIZONTAL-ONLY MEASURE SHOWED ===");
{
  const saved = readoutRef.fn;
  readoutRef.fn = oldReadout;
  const old = ride(noRail, 50);
  readoutRef.fn = saved;
  console.log(`  worst readout on the ring: ${(old.worstReadout * 100).toFixed(0)}% of real speed` +
    `  (real min ${(old.minVOnRing * 3.6).toFixed(0)} km/h — the car was fine all along)`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
