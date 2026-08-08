// DO THE PARK BOWL PRESETS ACTUALLY CATCH THE CAR?
//
// A bowl only works at ONE scale of entry speed, and the palette HARDCODES its
// radius — so a preset is a physics claim frozen into a data table, and nothing
// else in the codebase would notice if it stopped being true. Two ways it can
// silently rot: someone retunes `qpRadius` in a preset, or the quarter-pipe
// geometry / the car's speed changes underneath them.
//
// The rule: a transition trades speed for height, v²/2 = g·h, and for a quarter
// circle that climb IS the radius. So R = v²/(2g) is the STALL point (the car
// arrives at the lip with nothing left and rolls back down with no air), and the
// catching window sits below it. MEASURED, radius as a fraction of v²/(2g):
//
//     entry 46 m/s (v²/2g = 108 m)   R=30 overshoots · R=40 catches
//     entry 30 m/s (v²/2g =  46 m)   R=20 overshoots · R=25 catches
//     entry 22 m/s (v²/2g =  25 m)   R=14 overshoots · R=18 catches · R=22 stalls
//
// Note what does NOT change: the apex. It is v²/(2g) with the ramp height
// cancelling out, so all five radii at 46 m/s peak at 83–92 m. Making the bowl
// smaller does not lower the flight — only arriving slower does.
//
// Run: node tools/parkBowlTest.mjs
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.pb.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, pieceParams } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { CATEGORY_PRESETS } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
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

const mkBvh = (gs) => {
  const b = new RoadBvh();
  b.bakeFromMeshes(gs.map((geo) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    m.updateMatrixWorld(true); return m;
  }));
  return b.baked ? b : null;
};

/** Drive at the bowl holding `target` m/s on the approach; report where it lands. */
function drive(radius, angle, target) {
  const pp = { ...pieceParams, qpRadius: radius, qpAngle: angle };
  let conn = new THREE.Matrix4();
  const deck = [], rails = [];
  let qpStartZ = 0;
  for (const id of [...Array(6).fill("straight"), "quarterpipe"]) {
    const p = buildPiece(id, conn, pp);
    if (id === "quarterpipe") qpStartZ = new THREE.Vector3().setFromMatrixPosition(p.world).z;
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); deck.push(c);
    }
    if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); rails.push(r); }
    conn = p.connectorOut;
  }
  const floor = new THREE.PlaneGeometry(600, 900);
  floor.rotateX(-Math.PI / 2); floor.translate(0, -0.05, -400);
  deck.push(floor);

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(mkBvh(deck), mkBvh(rails));
  car.getFloorY = () => -300;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -4);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -Math.min(target, 40));
  car._resetInterpolation();

  // The rideable face spans z from the piece origin down to the lip.
  const lipZ = qpStartZ - radius * Math.sin(angle * Math.PI / 180);
  let entry = 0, apex = -Infinity, landZ = null, tAir = 0, air = false;
  for (let i = 0; i < Math.round(40 / FIXED_DT); i++) {
    const beforeRamp = car.body.pos.z > qpStartZ;
    const sp = car.body.vel.length();
    if (beforeRamp) entry = sp;
    car.tick({ steerTarget: 0, throttle: beforeRamp && sp < target ? 1 : 0,
      handbrake: false, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
    const grounded = car.tires.some((t) => t.grounded);
    if (!air && !grounded && car.body.pos.y > 1.0) air = true;
    if (air && landZ === null) {
      tAir += FIXED_DT;
      apex = Math.max(apex, car.body.pos.y);
      if (grounded && tAir > 0.15) landZ = car.body.pos.z;
    }
    if (landZ !== null) break;
  }
  return {
    entry, apex, air,
    // WHERE along the face it lands, not merely whether: 0 = the ramp's base,
    // 1.00 = back at the lip, >1 = past the ramp entirely. A binary caught/missed
    // is a knife-edge, and a single sample of one proves nothing — which is
    // exactly how a bowl that overshoots at every real speed passed this once.
    frac: landZ === null ? null : (qpStartZ - landZ) / (qpStartZ - lipZ),
    // Tolerance of half a car past the lip, and it is not slack — without it the
    // pass/fail line sits EXACTLY on the ideal result. Dropping back in at the
    // coping is frac ≈ 1.00, so a strict `>= lipZ` makes the best possible
    // outcome a coin flip on the last centimetre: R=45 read 1.00 at 38 m/s and
    // failed. The car is 3.6 m long, so a CENTRE 1.8 m past the lip still has the
    // car overlapping the ramp — and the landing is recorded from real wheel
    // contact, which past the ramp would not happen for another 45 m of fall.
    caught: landZ !== null && landZ <= qpStartZ && landZ >= lipZ - 1.8,
  };
}

// The presets under test, each with the BAND of approach speeds it must survive.
//
// A BAND, NOT A POINT, and that is the whole lesson here: the first version of
// this test sampled one speed per preset, and passed a 25 m bowl that overshoots
// at every speed the car actually arrives at. "Does it land on the face" is a
// knife-edge — one sample of it proves nothing. Read from the palette itself, so
// retuning a preset retunes the test with it.
const CASES = [
  ["quarterpipe_bowl", [46, 42], "full racing speed"],
  ["quarterpipe_bowl_small", [46, 42, 38, 34], "everything from full speed down to 34 m/s"],
];

console.log("\n═══ PARK BOWL PRESETS — does the car land back on the face? ═══");
console.log("  landing point along the face: 1.00 = back at the lip, >1 = past the ramp\n");
for (const [id, band, blurb] of CASES) {
  const preset = Object.values(CATEGORY_PRESETS).flat().find((p) => p.id === id);
  if (!preset) { check(false, `preset "${id}" is missing from the palette`); continue; }
  const R = preset.params.qpRadius, A = preset.params.qpAngle;
  const rows = band.map((v) => ({ v, r: drive(R, A, v >= 46 ? 99 : v) }));
  console.log(`  ${preset.label.padEnd(20)} R=${String(R).padStart(3)}m   ` + rows.map(({ v, r }) =>
    `${v}:${!r.air ? "stall" : r.frac === null ? "----" : r.frac.toFixed(2)}`).join("  "));
  const bad = rows.filter(({ r }) => !r.air || !r.caught).map(({ v }) => v);
  check(bad.length === 0,
    `"${preset.label}" catches the car at ${blurb} — it pops off the lip and lands back on the same
         face at EVERY speed in the band${bad.length ? `, FAILED at ${bad.join(", ")} m/s` : ""}`);
}

// 40 m is a FLOOR, not a tuning choice: below it the car leaves the lip too fast
// and lands beyond the ramp however the approach is built. Assert the failing side
// too, so "just make it smaller" cannot quietly ship again — it already did once.
const tooSmall = drive(25, 90, 99);
console.log("");
check(!tooSmall.caught,
  `and a 25 m bowl still overshoots at full speed (lands ${tooSmall.frac?.toFixed(2) ?? "?"} along the face,
         i.e. past the lip) — the small preset sits just above a real floor, and this is that floor`);

console.log(`\n${failed ? `FAIL — ${failed} check(s)` : "all checks green"}\n`);
process.exit(failed ? 1 : 0);
