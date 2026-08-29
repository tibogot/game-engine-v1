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
// smaller does not lower the flight — only arriving slower does. What a taller
// wall DOES lower is the flight above the LIP, v²/(2g) − R, because the climb
// happens on the ramp instead of in the air: 28 m and 6.2 s at R=60 against
// 10 m and 4.3 s at R=74. That is what the XL preset buys, and its cost is a
// stall floor at ~44 m/s.
//
// THE CAR LANDS ON THE COPING, and the `clearsRim` column below reports how far
// under the lip it touches down so that stays visible. It is a KNOWN ROUGH EDGE
// — the back tyre grazes the top of the ramp on the way back in — and it is NOT
// fixable from this table, which is the point of measuring it here.
//
// A vertical lip throws the car straight up, so it comes straight back down onto
// the rim it just left: 0.99–1.00 along the face at every radius and speed. And
// tipping the lip past vertical is far too coarse a lever, because near the lip
// the face IS vertical, so a few centimetres of backward drift means falling the
// whole vertical section before finding surface. Measured at R=60, metres under
// the lip at 46 / 42 m/s: 90.0° → -1.6 / -1.6 (on the rim), 90.5° → +6.3 / -1.7,
// 92° → +23 / +12, 96° → +42 / +27. 96° shipped once and was reported straight
// back as "falls far from the top, doesn't feel nice". Nothing between 90.0 and
// 90.3 moves the landing off the rim at all, and 90.5 drops it 7.7 m. There is
// no window.
//
// THE OTHER OBVIOUS FIX ALSO FAILS: rounding the lip. A convex roll-over at the
// top — skatepark coping, a round bar instead of a corner — was built and
// measured, and it makes the landing WORSE, because the graze is already the
// gentlest thing that can happen here. With a sharp lip the car meets a VERTICAL
// face: nothing supports it, so it slides down and the transition curve turns it
// over ~0.4 s (peak 0.9 g). Any coping puts an up-facing surface at the top of a
// 35 m drop, and the car lands ON it and stops dead — measured peak |dVy| of
// 24 g at a 0.15 m radius, 63 g at 0.25 m, 167 g at 0.45 m. It also has to carry
// its own shallow cross-section: sweeping the road profile (1.02 m from kerb top
// to slab underside) around a centre only `radius` below the deck turns every
// point deeper than the radius inside-out, and that inverted fan is solid to the
// wheel probes — at radii 0.08–0.25 the car stopped dead at the lip and never
// got airborne (apex 62 m against 95.57 m).
//
// Nor can the bowl be tuned to just barely reach the lip and pop gently: at full
// throttle the car still arrives with enough left that an 80 m wall gives 11 m
// over the lip and 3.4 s of air, with the same rim contact.
//
// What the graze actually is, instrumented: the rear tyre straddles the rim for
// four ticks while the contact point flickers over ~7 cm (59.98, 59.91, 59.92,
// 59.97) as different probe rays in the wheel's ring alternately catch the face
// and miss past it — then it slides down perfectly monotonically. It is an
// edge-straddle artifact, not faceting (the 1.5°/step cap puts the sag at 5 mm).
//
// The piece that gives a SMOOTH re-entry is the Park Pipe, not this one: ride
// along it and carve up it, and only the sideways part of the speed becomes
// height, so the car comes back down onto the transition instead of onto its own
// coping. See tools/parkPipeTest.mjs.
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
  const A = angle * Math.PI / 180;
  const lipZ = qpStartZ - radius * Math.sin(A);
  const lipY = radius * (1 - Math.cos(A));
  let entry = 0, apex = -Infinity, landZ = null, landY = null, tAir = 0, air = false;
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
      if (grounded && tAir > 0.15) { landZ = car.body.pos.z; landY = car.body.pos.y; }
    }
    if (landZ !== null) break;
  }
  return {
    entry, apex, air, lipY, landY, tAir: landZ === null ? null : tAir,
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
    // How far UNDER the lip the car touches down. Reported, not asserted: with a
    // vertical lip this is always about -1.6 m (i.e. ON the rim), and the header
    // explains why no value of qpAngle fixes that. It is here so that if the lip
    // geometry ever does gain a coping, the improvement shows up as a number.
    underLip: landY === null ? null : lipY - landY,
  };
}

// The presets under test, each with the BAND of approach speeds it must survive.
//
// A BAND, NOT A POINT, and that is the whole lesson here: the first version of
// this test sampled one speed per preset, and passed a 25 m bowl that overshoots
// at every speed the car actually arrives at. "Does it land on the face" is a
// knife-edge — one sample of it proves nothing. Read from the palette itself, so
// retuning a preset retunes the test with it.
// WHAT SETS THE TOP OF A BAND is the load the face has to supply to hold the
// car round it, v^2 / R. Measured on the small bowl, which is the only one
// tight enough to reach the limit: 42 m/s holds (4.50 g) and 43 m/s does not
// (4.71 g) — and it does not fail gently, it lands 38 m PAST the ramp. So the
// ceiling is ~4.6 g, and a bowl's fastest usable approach is sqrt(4.6 g R):
//
//     R=40  ->  42 m/s      R=60  ->  52 m/s      R=74  ->  58 m/s
//
// The car tops out at 48.3 m/s, so 60 and 74 are usable flat out and 40 is not.
// The small bowl used to claim "everything from full speed down to 34", which is
// backwards — small means SLOWER, not more forgiving. Its band is its real one
// now, and BOWL_LIMIT_G below asserts every band against the rule rather than
// leaving three hand-written lists to drift.
const BOWL_LIMIT_G = 4.6;
const CASES = [
  ["quarterpipe_bowl", [46, 42], "full racing speed"],
  ["quarterpipe_bowl_small", [42, 38, 34], "42 m/s and below — v^2/R rules out full speed"],
  // The XL bowl trades the band for the shorter flight — it only pops flat out,
  // by design, so it is tested at the one speed it claims.
  ["quarterpipe_bowl_tall", [46], "full racing speed only"],
];

console.log("\n═══ PARK BOWL PRESETS — does the car land back on the face? ═══");
console.log("  landing point along the face: 1.00 = back at the lip, >1 = past the ramp");
console.log("  and how far UNDER the rim it touches down — 0 m is a tyre on the coping\n");
for (const [id, band, blurb] of CASES) {
  const preset = Object.values(CATEGORY_PRESETS).flat().find((p) => p.id === id);
  if (!preset) { check(false, `preset "${id}" is missing from the palette`); continue; }
  const R = preset.params.qpRadius, A = preset.params.qpAngle;
  const rows = band.map((v) => ({ v, r: drive(R, A, v >= 46 ? 99 : v) }));
  console.log(`  ${preset.label.padEnd(20)} R=${String(R).padStart(3)}m A=${A}°  ` + rows.map(({ v, r }) =>
    `${v}:${!r.air ? "stall" : r.frac === null ? "----" : r.frac.toFixed(2)}` +
    `${r.underLip === null ? "" : `(${r.underLip >= 0 ? "+" : ""}${r.underLip.toFixed(1)}m)`}`).join("  "));
  const bad = rows.filter(({ r }) => !r.air || !r.caught).map(({ v }) => v);
  check(bad.length === 0,
    `"${preset.label}" catches the car at ${blurb} — it pops off the lip and lands back on the same
         face at EVERY speed in the band${bad.length ? `, FAILED at ${bad.join(", ")} m/s` : ""}`);
  // The band and the geometry have to agree, or the next preset gets a band
  // copied from a neighbour with a different radius and fails the same way.
  const top = Math.max(...band);
  const load = (top * top) / R / 9.81;
  check(load <= BOWL_LIMIT_G,
    `...and the top of that band is within what an R=${R} face can hold `
    + `— ${top} m/s needs ${load.toFixed(2)} g, ceiling ${BOWL_LIMIT_G} g `
    + `(fastest usable ≈ ${Math.sqrt(BOWL_LIMIT_G * 9.81 * R).toFixed(0)} m/s)`);
}

// The dead end, asserted so it cannot be walked into again. An over-vertical lip
// is the intuitive fix for the tyre-on-the-coping graze, and it was shipped once
// and reported straight back: it does not nudge the landing a few metres down
// the face, it throws the car MOST OF THE WAY down it.
{
  const preset = Object.values(CATEGORY_PRESETS).flat().find((p) => p.id === "quarterpipe_bowl");
  const R = preset.params.qpRadius;
  const over = drive(R, 96, 99);
  console.log("");
  check(over.underLip > 20,
    `tipping this bowl's lip to 96° does NOT nudge the landing — it drops the car
         ${over.underLip.toFixed(0)} m below the rim (${over.frac.toFixed(2)} along the face) instead of the ~1 m the graze
         needs. The lever is far too coarse because the face is vertical at the lip.
         Rounding the lip instead does not work either — see the header; the graze
         is inherent to a vertical launch, and the Park Pipe is the piece that
         re-enters smoothly`);
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
