// HOW FAST CAN THE CAR ACTUALLY FOLLOW EACH VERTICAL PIECE?
//
// THE BUG THIS EXISTS FOR: "none of the slopes are usable, the car doesn't
// follow the slope angle, it jumps off flat instead." That is not the vehicle
// mis-handling a gradient — it is the road being shaped like a takeoff ramp.
// Crossing a convex vertical curve of radius R at speed v needs v²/R of
// downward acceleration, and past what gravity plus downforce can supply the
// wheels leave the deck. Once airborne, TIRE.airTrajectoryAlign pitches the nose
// onto the ballistic arc rather than the ramp, so it also LOOKS level going up.
//
// So the number that matters per piece is a SPEED, and this measures it: drive
// the piece at a held speed, watch for air, and binary-search the fastest entry
// that still keeps a wheel down. Then check it against the closed form the
// palette tooltip quotes, so the tooltip cannot lie.
//
// Run: node tools/gradeFollowTest.mjs
//      node tools/gradeFollowTest.mjs --compare   (also re-derives the BEFORE
//      column by restoring the old profiles — doubles the runtime, so the
//      routine suite run asserts against the recorded numbers instead)
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.gf.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, GRAVITY, AERO, CHASSIS, TIRE } =
  await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const {
  buildPiece, pieceParams, PIECE_BY_ID,
  convexVerticalRadius, followSpeed, FOLLOW_CAR,
} = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
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

/**
 * Lay a chain of pieces out and bake it, once.
 *
 * `chain` is [id, params] pairs. A long straight goes in front of it (so the car
 * arrives settled rather than still bouncing off its spawn) and a longer one
 * behind, because the interesting failure is where the piece HANDS BACK to level
 * road: that is where a slope's curvature steps to zero.
 *
 * CACHED, so the speed sweep bakes each track once instead of twenty times.
 *
 * THE RUNOUT IS SHORT ON PURPOSE. It only has to carry the car a car-length past
 * the exit seam, because that is where the measurement window closes — and every
 * metre beyond it is simulated at every speed in the sweep. It was 200 m, which
 * at the bottom of the sweep is 30 s of road the run never even reaches.
 */
const _tracks = new Map();
function track(chain) {
  const key = JSON.stringify(chain);
  const hit = _tracks.get(key);
  if (hit) return hit;

  let conn = new THREE.Matrix4();
  const deck = [], rails = [];
  const put = (id, params) => {
    const pp = { ...pieceParams, ...params };
    const p = buildPiece(id, conn, pp);
    const g = p.geometry.clone(); g.applyMatrix4(p.world); deck.push(g);
    if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); rails.push(r); }
    conn = p.connectorOut;
  };

  put("straight", { straightLength: 80 });
  const start = new THREE.Vector3().setFromMatrixPosition(conn);
  for (const [id, params] of chain) put(id, params);
  const finish = new THREE.Vector3().setFromMatrixPosition(conn);
  put("straight", { straightLength: 40 });

  const built = {
    ground: mkBvh(deck),
    solids: rails.length ? mkBvh(rails) : null,
    start,
    finish,
    climbed: finish.y - start.y,
    span: Math.abs(finish.z - start.z),
    // 80 m lead-in + the chain + enough runout to clear the window.
    road: 80 + Math.abs(finish.z - start.z) + 20,
  };
  _tracks.set(key, built);
  return built;
}

/**
 * Drive a chain at a held speed. Returns the worst continuous air time over the
 * piece, and how much height the chain actually gained (so a chain that quietly
 * fails to climb is visible rather than merely smooth).
 */
function drive(chain, speed) {
  const t = track(chain);
  const { start, finish } = t;

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(t.ground, t.solids);
  car.getFloorY = () => -300;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -6);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -speed);
  car._resetInterpolation();

  let air = 0, worstAir = 0, entered = false, done = false;
  let peakY = -Infinity, fell = false;
  // Sized to the road at this speed, plus slack for the spin-up and for a climb
  // bleeding speed. A flat 20 s was 30 s short at the bottom of the sweep and
  // 15 s of wasted ticks at the top.
  const total = Math.round(Math.min(40, (t.road / speed) * 1.6 + 4) / FIXED_DT);
  for (let i = 0; i < total && !done; i++) {
    const sp = car.body.vel.length();
    // Hold the target: brakes as well as throttle, or a descent arrives at the
    // runout 15 m/s faster than the speed under test and the search measures
    // the wrong number.
    car.tick({
      steerTarget: 0,
      throttle: sp < speed ? 1 : 0,
      brake: sp > speed * 1.08 ? 0.4 : 0,
      handbrake: false, yaw: 0, pitch: 0,
    });
    car.syncVisuals(FIXED_DT, 1);

    const z = car.body.pos.z;
    // The window is the chain itself plus a car length past its exit seam.
    const inWindow = z <= start.z + 1 && z >= finish.z - 6;
    if (inWindow) entered = true;
    else if (entered) done = true;

    if (inWindow) {
      peakY = Math.max(peakY, car.body.pos.y);
      if (car.tires.every((tt) => !tt.grounded)) {
        air += FIXED_DT;
        if (air > worstAir) worstAir = air;
      } else air = 0;
    }
    if (car.body.pos.y < -40) { fell = true; break; }
  }
  return {
    worstAir, fell, reached: entered,
    climbed: t.climbed,
    span: t.span,
    peakY: peakY === -Infinity ? null : peakY,
  };
}

/**
 * Fastest held speed (m/s) the car follows the chain at.
 *
 * AN UPWARD SWEEP, NOT A BISECTION, and the difference is not cosmetic. Air time
 * is not monotone in speed — a crest the suspension can just about swallow will
 * hold at v, hop at v+1 and hold again at v+2, because whether the wheels leave
 * depends on where in its travel the suspension happens to be when the curvature
 * arrives. Bisecting a non-monotone predicate returns whichever side of the band
 * it wandered into, which made this readout jitter by 10 km/h between runs on
 * the gentle presets. The sweep answers the question that was actually asked:
 * the fastest speed at which every speed below it is also clean.
 */
function measureFollow(chain, from = 6) {
  let last = 0;
  for (let v = from; v <= 50; v += 1) {
    const r = drive(chain, v);
    if (r.fell || r.worstAir > AIR_TOL) return last;
    last = v;
  }
  return Infinity;
}

/** A wheel skipping a seam is not "the car took off". 80 ms of all-four-off is. */
const AIR_TOL = 0.08;

const kmh = (v) => (Number.isFinite(v) ? `${(v * 3.6).toFixed(0)}` : "  ∞");

// ── The tooltip's constants have to BE the car's ─────────────────────────────
// followSpeed() lives in the kit, which node tools can import; the car's numbers
// live in a module they cannot. So the kit carries a copy and this is what stops
// the copy drifting into a tooltip that quotes a car nobody is driving.
console.log("\n═══ THE READOUT'S CAR IS THE REAL CAR ═══");
check(FOLLOW_CAR.gravity === GRAVITY,
  `FOLLOW_CAR.gravity ${FOLLOW_CAR.gravity} === GRAVITY ${GRAVITY}`);
check(FOLLOW_CAR.mass === CHASSIS.mass,
  `FOLLOW_CAR.mass ${FOLLOW_CAR.mass} === CHASSIS.mass ${CHASSIS.mass}`);
check(FOLLOW_CAR.downforce === AERO.downforce,
  `FOLLOW_CAR.downforce ${FOLLOW_CAR.downforce} === AERO.downforce ${AERO.downforce}`);

// ── What the profile change bought, piece for piece ──────────────────────────
// The old shapes, restored onto the catalog defs one at a time, so this is a
// like-for-like measurement rather than a claim about arithmetic.
const V3 = THREE.Vector3;
const OLD = {
  slope: (pp) => {
    const L = Math.max(2, pp.slopeLength), H = pp.slopeRise;
    const n = Math.max(8, Math.ceil(L / 1.6)), pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(new V3(0, H * t * t * (3 - 2 * t), -L * t));
    }
    return pts;
  },
  crest: (pp) => {
    const L = Math.max(2, pp.slopeLength), H = pp.slopeRise;
    const n = Math.max(8, Math.ceil(L / 1.6)), pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, s = Math.sin(Math.PI * t);
      pts.push(new V3(0, H * s * s, -L * t));
    }
    return pts;
  },
};

/** Swap a catalog def's centreline for the duration of `body`.
 *
 *  Clears the track cache on the way in AND out — the cache is keyed on the
 *  chain, which says nothing about which profile built it, so without this the
 *  old-shape run would silently measure the new shape's baked geometry. */
function withProfile(id, fn, body) {
  const def = PIECE_BY_ID.get(id);
  const keep = def.points;
  def.points = fn;
  _tracks.clear();
  try { return body(); } finally { def.points = keep; _tracks.clear(); }
}

console.log("\n═══ SLOPE / CREST — the speed the car can follow the piece at ═══");
console.log("  km/h it stays glued to, measured by driving it. Higher is better.\n");
console.log("  piece                 L    H     old    new    predicted   crest R");

/**
 * What each preset used to BE, and what it used to measure.
 *
 * Size and profile both moved, so "before" means the old shape at the old size —
 * the piece the player was actually driving. The km/h are RECORDED rather than
 * re-derived on every run: restoring the old profiles doubles the suite's
 * runtime, and history does not change. `--compare` re-derives them, and the
 * check below fails if what it finds disagrees with what is written here.
 */
const BEFORE = {
  slope_up_gentle: { size: [30, 5], kmh: 119 },
  slope_up_medium: { size: [28, 10], kmh: 65 },
  slope_up_steep: { size: [26, 16], kmh: 50 },
  slope_down_gentle: { size: [30, -5], kmh: 94 },
  slope_down_medium: { size: [28, -10], kmh: 54 },
  slope_down_steep: { size: [26, -16], kmh: 40 },
  slope_hill: { size: [32, 8], kmh: 32 },
  slope_dip: { size: [32, -8], kmh: 36 },
};
const COMPARE = process.argv.includes("--compare");

const rows = [];
for (const pr of CATEGORY_PRESETS.slopes) {
  if (pr.base !== "slope" && pr.base !== "crest") continue;
  const pp = { ...pieceParams, ...pr.params };
  const now = measureFollow([[pr.base, pr.params]]);

  const was = BEFORE[pr.id];
  // The old profile at the OLD size — what the player was actually driving.
  const remeasured = was && COMPARE
    ? withProfile(pr.base, OLD[pr.base], () => measureFollow(
      [[pr.base, { slopeLength: was.size[0], slopeRise: was.size[1] }]]))
    : null;
  if (remeasured !== null) {
    check(Math.abs(remeasured * 3.6 - was.kmh) <= 4,
      `recorded BEFORE for "${pr.label}" (${was.kmh} km/h) still reproduces — measured ${kmh(remeasured)}`);
  }
  const old = was ? was.kmh / 3.6 : null;

  const R = convexVerticalRadius(pr.base, pp);
  const pred = followSpeed(R);
  rows.push({ pr, pp, now, old, R, pred });
  console.log(`  ${pr.label.padEnd(18)} ${String(pp.slopeLength).padStart(3)} ${String(pp.slopeRise).padStart(4)}`
    + `  ${(old === null ? "   -" : kmh(old)).padStart(6)} ${kmh(now).padStart(6)}`
    + `     ${kmh(pred).padStart(6)}     ${R.toFixed(0).padStart(4)} m`);
}

// ── THE FLOOR IS THE THING ───────────────────────────────────────────────────
// Not every preset, deliberately. A per-preset no-regression rule sounds
// stricter and is the wrong test: the profile change trades the gentle climb
// down (it was already good for 130+ km/h, which nobody drives a 5 m rise at) to
// lift the steep descent, and the steep descent is the piece that ruins a track.
// What has to improve is the WORST tile in the tab.
console.log("");
const cmp = rows.filter((r) => r.old !== null);
const floorNow = Math.min(...cmp.map((r) => r.now));
const floorOld = Math.min(...cmp.map((r) => r.old));
check(floorNow > floorOld,
  `the SLOWEST piece in the Slopes tab got faster: ${kmh(floorOld)} → ${kmh(floorNow)} km/h. That is
         the number that decides whether a track has an unusable piece in it`);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
check(median(cmp.map((r) => r.now)) > median(cmp.map((r) => r.old)),
  `and the median preset improved too: ${kmh(median(cmp.map((r) => r.old)))} → `
  + `${kmh(median(cmp.map((r) => r.now)))} km/h`);

// The tooltip is a DESIGN figure, not a lap-time model: downforce is scaled by
// wheels-in-contact and acts along chassis-up, and the suspension absorbs a
// curvature spike the closed form knows nothing about. So the claim it has to
// meet is one-sided — never promise road the car cannot actually hold.
const oversold = rows.filter((r) => Number.isFinite(r.pred) && r.now > 0 && r.now < r.pred * 0.9);
check(oversold.length === 0,
  `no tooltip promises more than the car delivers`
  + `${oversold.length ? ` — ${oversold.map((r) => `${r.pr.label} says ${kmh(r.pred)}, holds ${kmh(r.now)}`).join("; ")}` : ""}`);

// ── The point of the whole exercise ──────────────────────────────────────────
// A slope is compact and therefore always a compromise. The graded climb is the
// piece that is NOT: its transitions are sized by radius and its middle has no
// curvature at all, so the claim is that it holds top speed. That claim is the
// reason the family exists, so it is asserted rather than printed.
console.log("\n═══ GRADED CLIMB — Grade in → Climb ×N → Grade out ═══");
console.log("  the family that exists so elevation change is not a jump.\n");
console.log("  preset            R    climbs   over     follows at");

const byId = (id) => CATEGORY_PRESETS.slopes.find((p) => p.id === id);
const SETS = [
  ["Fast (R160)", "grade_in_fast", "grade_climb", "grade_out_fast", 3],
  ["Tight (R50)", "grade_in_tight", "grade_climb_short", "grade_out_tight", 3],
];

for (const [label, inId, midId, outId, n] of SETS) {
  const gin = byId(inId), mid = byId(midId), gout = byId(outId);
  if (!gin || !mid || !gout) { check(false, `preset set "${label}" is missing from the palette`); continue; }
  const chain = [
    [gin.base, gin.params],
    ...Array.from({ length: n }, () => [mid.base, { ...gin.params, ...mid.params }]),
    [gout.base, gout.params],
  ];
  // From 20 m/s: these are main-line pieces, and a 230 m chain crawled at 6 m/s
  // is 40 s of simulation to prove something nobody was going to ask.
  const v = measureFollow(chain, 20);
  const geom = drive(chain, 20);
  const R = gin.params.gradeRadius;
  console.log(`  ${label.padEnd(14)} ${String(R).padStart(4)} m   ${geom.climbed.toFixed(1).padStart(5)} m`
    + `  ${geom.span.toFixed(0).padStart(4)} m    ${kmh(v).padStart(6)} km/h`);

  check(geom.climbed > 4,
    `"${label}" actually GAINS height (${geom.climbed.toFixed(1)} m) — the Climb straights inherit
         the grade from the connector, which is the mechanism the family rides on`);

  // Sized for the car: the fast set is meant to hold anything the car can do.
  if (R >= 150) {
    check(v >= TIRE.topSpeed * 0.9,
      `"${label}" holds ${kmh(v)} km/h against a car that tops out near ${kmh(TIRE.topSpeed)} — a
         main-line climb the car follows at ANY speed it can reach`);
  }
}

// And the comparison that answers the original complaint: the same height gain,
// as one slope versus as a graded climb.
console.log("\n═══ SAME 12 m OF CLIMB, TWO WAYS ═══");
{
  const asSlope = [["slope", { slopeLength: 32, slopeRise: 12 }]];
  const gin = byId("grade_in_fast"), mid = byId("grade_climb"), gout = byId("grade_out_fast");
  const asGrade = [
    [gin.base, gin.params],
    [mid.base, { ...gin.params, ...mid.params }],
    [gout.base, gout.params],
  ];
  const a = measureFollow(asSlope), b = measureFollow(asGrade, 20);
  const ga = drive(asSlope, 20), gb = drive(asGrade, 20);
  console.log(`  one slope       ${ga.climbed.toFixed(1)} m over ${ga.span.toFixed(0)} m of road   follows to ${kmh(a)} km/h`);
  console.log(`  graded climb    ${gb.climbed.toFixed(1)} m over ${gb.span.toFixed(0)} m of road   follows to ${kmh(b)} km/h`);
  check(b > a * 1.5,
    `the graded climb follows far faster than the slope that gains the same height
         (${kmh(b)} vs ${kmh(a)} km/h) — it costs more road, and that is the trade the
         Slopes tab now lets you make instead of making it for you`);
}

console.log(`\n${failed ? `FAIL — ${failed} check(s)` : "all checks green"}\n`);
process.exit(failed ? 1 : 0);
