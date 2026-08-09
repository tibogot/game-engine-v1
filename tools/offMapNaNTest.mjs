// DRIVING OFF THE EDGE OF THE MAP MUST NOT KILL THE SESSION.
//
// The reported symptom was "the screen goes totally black, the speedometer says
// NaN, and then B and R do nothing at all". Three separate faults in a line, and
// the middle one is why the last one looks like an input bug:
//
//   1. SOURCE. v3's CPU heightmap read (sampleHeightNormalized in v3/app/main.js)
//      clamped x0/y0 on the LOW side and x1/y1 on the HIGH side, so no clamp
//      covered a HIGH x0/y0. Past the +Z edge of the map y0 indexes off the end
//      of a Float32Array, which reads `undefined` — not 0 — and undefined*t is
//      NaN. Past the +X edge x0 instead WRAPS onto the next texel row, so the
//      ground silently teleports. Off the negative sides the weights go to −88
//      and the bilinear blend EXTRAPOLATES without limit.
//
//   2. PROPAGATION. Vehicle._applyChassisGroundContact skipped a corner with
//      `if (cornerY >= floorY) continue`. Every comparison against NaN is false,
//      so a NaN floor was treated as a HIT, gave a NaN penetration depth, and
//      pushed a NaN force into the rigid body. (The WHEEL probes were already
//      guarded — `isFinite(terrainY)` in modularRoadGround.js — so the chassis
//      corners were the only way in.) One NaN force is permanent: pos and vel
//      never come back, the chase camera matrix is NaN (black screen) and the
//      HUD reads NaN (speedometer).
//
//   3. NO RECOVERY. roadGame's checkFall respawns on `y < FALL_Y`, which is
//      false against NaN, so the one thing that would have rescued the car never
//      fired. And the frame loop re-armed its rAF as the LAST statement of the
//      frame, so the first throw out of a NaN frame stopped the loop for good —
//      R and B still ran, they just had no frame left to draw in.
//
// MEASURED before the fix, on the shipping 2048 m / 1024-texel terrain (map
// spans ±1024 m) sloping in both axes:
//
//     (    0, 1024)   101.2 m     last texel, fine
//     (    0, 1025)   NaN         y0 = 1024 reads past the Float32Array
//     (    0, 1100)   NaN
//     ( 1025,    0)    62.8 m     x0 wraps a row — 64 m of ground gone in 1 m
//     (-2000,-2000)    12.5 m     extrapolated, unbounded
//
// Run: node tools/offMapNaNTest.mjs
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.om.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? "  ok   " : "  FAIL "}${msg}`); };

/* ─── 1. THE SAMPLER ──────────────────────────────────────────────────────────
 * sampleHeightNormalized lives inside main.js's module closure and is not
 * exported, so it is lifted out of the SOURCE rather than reimplemented here —
 * a copy of the maths in this file would keep passing after main.js regressed,
 * which is the one thing this test exists to catch. */
// Line endings are normalised first: the repo is checked out CRLF on Windows,
// and a `\n  }` anchor silently matches nothing against `\r\n  }`.
const mainSrc = readFileSync(join(ROOT, "v3/app/main.js"), "utf8").replace(/\r\n/g, "\n");
const fnMatch = mainSrc.match(/\n  function sampleHeightNormalized\(u, v\) \{[\s\S]*?\n  \}\n/);
if (!fnMatch) {
  console.log("  FAIL  could not find sampleHeightNormalized() in v3/app/main.js — has it moved?");
  process.exit(1);
}

const HEIGHTMAP_SIZE = 1024, WORLD_SIZE = 2048, MAX_HEIGHT = 500;
const cpuHeightmap = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
// Sloped in BOTH axes: a flat test terrain hides the +X row-wrap completely,
// because the wrong row holds the same value as the right one.
for (let y = 0; y < HEIGHTMAP_SIZE; y++) {
  for (let x = 0; x < HEIGHTMAP_SIZE; x++) {
    cpuHeightmap[y * HEIGHTMAP_SIZE + x] = 0.1 + 0.0001 * x + 0.00005 * y;
  }
}
const sampleHeightNormalized = new Function(
  "HEIGHTMAP_SIZE", "cpuHeightmap",
  `${fnMatch[0]}; return sampleHeightNormalized;`,
)(HEIGHTMAP_SIZE, cpuHeightmap);
const getWorldHeight = (wx, wz) => sampleHeightNormalized(
  (wx + WORLD_SIZE / 2) / WORLD_SIZE, (wz + WORLD_SIZE / 2) / WORLD_SIZE) * MAX_HEIGHT;

console.log("\n═══ OFF-MAP TERRAIN SAMPLING ═══");
console.log(`  map spans ±${WORLD_SIZE / 2} m at ${HEIGHTMAP_SIZE} texels\n`);

const EDGE = WORLD_SIZE / 2;
const PROBES = [
  ["inside",            0,        0],
  ["inside, near +X+Z", 1000,  1000],
  ["+Z edge +1 m",      0,      EDGE + 1],
  ["+Z edge +76 m",     0,      EDGE + 76],
  ["+X edge +1 m",      EDGE + 1,      0],
  ["+X edge +76 m",     EDGE + 76,     0],
  ["+X+Z corner",       EDGE + 1, EDGE + 1],
  ["−X far out",        -2000,         0],
  ["−Z far out",        0,         -2000],
  ["−X−Z corner",       -2000,     -2000],
  ["absurdly far",      1e6,         1e6],
];
for (const [label, x, z] of PROBES) {
  const h = getWorldHeight(x, z);
  check(Number.isFinite(h), `${label.padEnd(20)} (${String(x).padStart(7)}, ${String(z).padStart(7)}) -> ${
    Number.isFinite(h) ? `${h.toFixed(1)} m` : String(h)}`);
}

// Clamp-to-edge, not extrapolation: outside the border the height must MATCH the
// nearest in-bounds sample and then stay put, however far out you go.
const edgeH = getWorldHeight(0, EDGE);
const out1 = getWorldHeight(0, EDGE + 50);
const out2 = getWorldHeight(0, EDGE + 5000);
check(Math.abs(out1 - edgeH) < 0.5 && Math.abs(out2 - edgeH) < 0.5,
  `past the +Z border the terrain is FLAT at the edge height: edge ${edgeH.toFixed(1)} m,
         +50 m out ${out1.toFixed(1)} m, +5000 m out ${out2.toFixed(1)} m`);

// The +X row-wrap: one metre must not move the ground by tens of metres.
const inX = getWorldHeight(EDGE, 0), outX = getWorldHeight(EDGE + 1, 0);
check(Math.abs(outX - inX) < 1,
  `crossing the +X border does not TELEPORT the ground (row-wrap): ${
    inX.toFixed(1)} m -> ${outX.toFixed(1)} m over one metre`);

/* ─── 2. THE VEHICLE ──────────────────────────────────────────────────────────
 * Independent of the sampler fix: whatever a host's getFloorY does, a car must
 * not be destroyed by it. Fed NaN outright, which is what the old sampler
 * returned. */
console.log("\n═══ VEHICLE AGAINST A NaN FLOOR ═══\n");

function driveWithFloor(getFloorY, ticks = 240) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(null, null);          // no road — terrain/floor only, as off-map
  car.getFloorY = getFloorY;
  car.enabled = true;
  car.body.pos.set(0, 1.0, 0);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -30);
  car._resetInterpolation();
  for (let i = 0; i < ticks; i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
  }
  const p = car.body.pos, v = car.body.vel;
  return {
    finite: [p.x, p.y, p.z, v.x, v.y, v.z].every(Number.isFinite),
    speed: v.length(),
  };
}

const nanFloor = driveWithFloor(() => NaN);
check(nanFloor.finite,
  `a floor that returns NaN leaves the body FINITE after 2 s of driving
         (pos/vel all finite: ${nanFloor.finite})`);

// And the ordinary case still works — the guard must not have switched contact off.
const realFloor = driveWithFloor(() => 0);
check(realFloor.finite && realFloor.speed > 1,
  `a normal floor still supports the car: finite ${realFloor.finite}, speed ${
    realFloor.speed.toFixed(1)} m/s`);

/* ─── 3. THE RECOVERY PATHS ──────────────────────────────────────────────────
 * Source assertions, because both live inside roadGame's closure. They are what
 * turns "a bad frame" back into "a playable game", and both were missing. */
console.log("\n═══ roadGame RECOVERY PATHS ═══\n");

const gameSrc = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8")
  .replace(/\r\n/g, "\n");
const checkFall = gameSrc.match(/function checkFall\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
check(/Number\.isFinite/.test(checkFall),
  `checkFall() tests for a non-finite pose — every other test in it is a "<",
         and "<" against NaN is false, so a NaN car is never recovered without this`);

const rafIdx = gameSrc.indexOf("app._roadRaf = requestAnimationFrame(tick)");
const tickIdx = gameSrc.indexOf("const tick = () => {");
check(rafIdx > tickIdx && rafIdx - tickIdx < 200,
  `the frame loop re-arms its rAF at the TOP of tick, not the bottom — scheduled
         last, one throw stops the loop for good and every key silently dies`);

console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
