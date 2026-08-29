// ROAD HOLD — can the car follow a compact slope at the speed it actually drives?
//
// THE BUG, restated after the first attempt at it failed. Reshaping the slope
// and crest profiles raised the speed at which each piece stops being
// followable, but only from 32-54 km/h to 61-119 (tools/gradeFollowTest.mjs
// measures that, and still does — it deliberately runs UNTAGGED, so it reports
// the pure geometry limit). The car reaches 180. So from the driver's seat
// nothing had changed: every up-slope still launched, every down-slope still
// dropped away, and the player's report was "I don't see NO DIFFERENCES at all".
//
// The reason is not fixable by shaping. Following a convex vertical curve of
// radius R at speed v needs v²/R of downward acceleration, so the unaided limit
// is √(g·R) plus a little from downforce. A piece 30 m long that gains 10 m HAS
// a ~35 m crest radius; at 50 m/s that curve demands over 7 g and gravity brings
// one. To follow a 10 m rise flat out the piece has to be ~70 m long — which is
// what the Grade in / Climb / Grade out family is for, and it is a different
// answer to a different question ("build me a climb"), not this one ("I placed a
// hill and the car flew off it").
//
// SO THE CAR HOLDS THE ROAD. SURFACE_GRIP already hands the tyres the
// centripetal force a curve demands; it was restricted to CONCAVE surfaces
// because doing it over a crest would kill every jump. That restriction is now
// per-deck rather than global: pieces the author meant to be driven over carry a
// hold tag (FOLLOW_ROAD → RoadBvh.vertHold → Tire.hitRoadHold), pieces meant to
// launch do not.
//
// This file exists to prove the three things that claim rests on:
//   1. the tag survives the bake — MeshBVH PERMUTES the index buffer, so a
//      per-face tag would be scrambled and would still look almost right;
//   2. with it, every Slopes preset is followable at top speed;
//   3. without it, jumps still throw the car exactly as far.
//
// Run: node tools/roadHoldTest.mjs
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.rh.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, ROAD_HOLD, CHASSIS, GRAVITY, TIRE, WHEEL } =
  await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const {
  buildPiece, pieceParams, isFollowRoad, FOLLOW_ROAD,
  convexVerticalRadius, followSpeed, heldSpeed, FOLLOW_HOLD,
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
const kmh = (v) => `${(v * 3.6).toFixed(0)}`;

/* ══ 1. THE TAG HAS TO SURVIVE THE BAKE ════════════════════════════════════ */
//
// The one that would silently destroy everything else. `bakeFromMeshes` merges
// every deck into a single buffer, and then MeshBVH REORDERS THAT BUFFER'S
// INDICES as it builds the tree — so triangle N of the finished geometry is not
// triangle N of what went in. Tagging per FACE would therefore mislabel faces
// in a way that is nearly invisible: neighbours mostly share a tag, so it looks
// fine until a wheel lands on the one triangle that does not.
//
// Tagging per VERTEX is immune, because vertices are only ever REFERENCED
// differently, never moved. This drives that distinction into the ground with a
// track built specifically so the two answers differ: many small tagged and
// untagged slabs interleaved, so the tree has plenty of reason to reorder.
console.log("\n═══ THE HOLD TAG SURVIVES THE BVH BAKE ═══");
{
  const meshes = [];
  const N = 24;
  for (let i = 0; i < N; i++) {
    // 8 m squares in a row along -Z, alternating tagged / untagged.
    const g = new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2).translate(0, 0, -i * 8);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    m.userData.roadHold = i % 2 === 0;
    m.updateMatrixWorld(true);
    meshes.push(m);
  }
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes(meshes);
  check(bvh.baked, "the interleaved test track baked");
  check(!!bvh.vertHold, "...and carries a per-vertex hold tag");

  const down = new THREE.Vector3(0, -1, 0);
  let right = 0, wrong = 0;
  for (let i = 0; i < N; i++) {
    const hit = bvh.raycastFirst(new THREE.Vector3(0, 5, -i * 8), down, 20);
    if (!hit) { wrong++; continue; }
    if (hit.roadHold === (i % 2 === 0)) right++; else wrong++;
  }
  check(wrong === 0,
    `every one of ${N} probes read the tag of the slab it actually hit (${right} right, ${wrong} wrong)`);

  // And the sweep path, which is the one that usually WINS a wheel probe.
  let sweepWrong = 0;
  for (let i = 0; i < N; i++) {
    const h = bvh.spherecast(0, 5, -i * 8, 0.3, 0, -1, 0, 20);
    if (!h || h.roadHold !== (i % 2 === 0)) sweepWrong++;
  }
  check(sweepWrong === 0,
    "the swept-sphere path reports it too — it beats the rays to the contact most ticks");

  // The proof that this test is not vacuous: the tree really did reorder, so a
  // per-face array built before construction would have been wrong.
  const idx = bvh.geometry.getIndex().array;
  let permuted = false;
  for (let i = 0; i < Math.min(idx.length, 300); i += 3) {
    if (idx[i] !== idx[0] + i / 3 * 0 && i > 0 && idx[i] < idx[i - 3]) { permuted = true; break; }
  }
  check(permuted,
    "MeshBVH did permute the index buffer — which is why the tag is per vertex, not per face");
}

/* ══ 2. LAUNCHERS ARE OFF THE LIST ═════════════════════════════════════════ */
console.log("\n═══ WHAT MAY HOLD THE CAR, AND WHAT MAY NOT ═══");
{
  // A ramp the car cannot leave is a worse bug than a hill it cannot hold, so
  // this is the check that guards the whole feature against over-reach.
  const LAUNCHERS = [
    "jump", "dive", "gap", "landing", "brow",
    "quarterpipe", "quarterpipe_down",
    "tube_cannon", "cannon",
  ];
  const leaked = LAUNCHERS.filter((id) => isFollowRoad(id));
  check(leaked.length === 0,
    `nothing meant to launch is allowed to hold: ${LAUNCHERS.length} ids checked`
    + `${leaked.length ? ` — LEAKED: ${leaked.join(", ")}` : ""}`);

  // And the pieces the complaint was about must be on it, or the fix is off.
  const MUST_HOLD = ["slope", "crest", "grade_in", "grade", "grade_out"];
  const missing = MUST_HOLD.filter((id) => !isFollowRoad(id));
  check(missing.length === 0,
    `every vertical road piece holds${missing.length ? ` — MISSING: ${missing.join(", ")}` : ""}`);
  check(FOLLOW_ROAD.size > 0 && FOLLOW_ROAD.size < 30,
    `the list stays a curated set, not a catalog dump (${FOLLOW_ROAD.size} pieces)`);

  // The kit COPIES the car's numbers because it cannot import the vehicle (the
  // vehicle pulls in renderer material helpers — hence the TMP rewrite at the
  // top of this file). Copies drift; this is what stops them, and it is why the
  // palette tooltip can be trusted to describe the car that actually ships.
  check(FOLLOW_HOLD.maxG === ROAD_HOLD.maxG,
    `the kit's copy of the hold ceiling matches the car (${FOLLOW_HOLD.maxG} vs ${ROAD_HOLD.maxG} g)`);
  check(FOLLOW_HOLD.loadFloor === ROAD_HOLD.loadFloor,
    `...and its copy of the crest-load floor (${FOLLOW_HOLD.loadFloor} vs ${ROAD_HOLD.loadFloor})`);
  check(FOLLOW_HOLD.topSpeed === TIRE.topSpeed,
    `...and its copy of top speed (${FOLLOW_HOLD.topSpeed} vs ${TIRE.topSpeed} m/s)`);

  // ── THE ONE THAT WOULD HAVE CAUGHT THE FIRST VERSION ─────────────────────
  //
  // A hold that can pull harder than the strut can push back is not a hold, it
  // is a crusher: saturated, it drives the wheel hub through the deck and the
  // drawn tyre with it. The droop-servo version shipped at maxG 16, which is
  // 54,936 N at a corner against a strut that produces 49,907 N squashed
  // absolutely flat — 5 kN on the wrong side of this line, and that is exactly
  // what the "wheels enter inside the road" report was.
  //
  // Nothing in the physics enforces it, so it is enforced here.
  //
  // The comparison is against the strut's force at the compression where the
  // DRAWN WHEEL runs out of room, not at full squash. Full squash is the wrong
  // bar: with a firm bump stop it is an enormous number the hold could never
  // approach, so the check would pass while the wheel was already buried. The
  // wheel is pinned to its contact and the body-lift hack absorbs archLiftMax
  // of shortfall, so the budget is `radius - archLiftMax` of hub clearance —
  // i.e. everything up to `restLength -` that much of compression.
  const visualBudget = TIRE.restLength - (WHEEL.radius - TIRE.archLiftMax);
  const strutAtBudget = visualBudget * TIRE.springStrength
    + Math.pow(Math.max(0, visualBudget - TIRE.restLength * TIRE.bottomOutThresh), 2)
      * TIRE.springStrength * TIRE.bottomOutMult;
  const holdCap = ROAD_HOLD.maxG * CHASSIS.mass * GRAVITY * 0.25;
  check(holdCap < strutAtBudget,
    `a saturated hold cannot push the wheel into the deck: ${(holdCap / 1000).toFixed(1)} kN`
    + ` per corner against ${(strutAtBudget / 1000).toFixed(1)} kN of strut at the`
    + ` ${visualBudget.toFixed(2)} m the wheel has to spare`);

  // And the bump stop has to engage INSIDE that budget, or the strut is still on
  // its soft linear rate when the wheel runs out of room and a sustained load
  // parks the tyre in the road however strong the stop becomes later.
  check(TIRE.restLength * TIRE.bottomOutThresh < visualBudget,
    `the bump stop engages before the wheel runs out of room:`
    + ` knee ${(TIRE.restLength * TIRE.bottomOutThresh).toFixed(3)} m`
    + ` < budget ${visualBudget.toFixed(3)} m`);
}

/* ══ THE DRIVING RIG ══════════════════════════════════════════════════════ */

/**
 * Bake a chain, tagging each piece's deck the way the builder does.
 *
 * `hold` forces the tag off for the whole track, which is how the before/after
 * below is measured: same geometry, same speed, only the tag differs. That is a
 * far stronger statement than comparing against a recorded number, because
 * nothing else can drift underneath it.
 */
const _tracks = new Map();
function track(chain, hold = true) {
  const key = `${hold}|${JSON.stringify(chain)}`;
  const cached = _tracks.get(key);
  if (cached) return cached;

  let conn = new THREE.Matrix4();
  const decks = [];
  const put = (id, params) => {
    const p = buildPiece(id, conn, { ...pieceParams, ...params });
    const g = p.geometry.clone(); g.applyMatrix4(p.world);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    m.userData.roadHold = hold && isFollowRoad(id);
    m.updateMatrixWorld(true);
    decks.push(m);
    conn = p.connectorOut;
  };

  put("straight", { straightLength: 80 });
  const start = new THREE.Vector3().setFromMatrixPosition(conn);
  for (const [id, params] of chain) put(id, params);
  const finish = new THREE.Vector3().setFromMatrixPosition(conn);
  put("straight", { straightLength: 40 });

  const bvh = new RoadBvh();
  bvh.bakeFromMeshes(decks);
  const built = {
    ground: bvh.baked ? bvh : null,
    start,
    finish,
    road: 80 + Math.abs(finish.z - start.z) + 20,
  };
  _tracks.set(key, built);
  return built;
}

/**
 * Drive a chain at a held speed and report the worst continuous air time over
 * the piece, plus the peak assist the car asked for (so a pass can be read as
 * "held easily" or "held at the cap").
 */
/**
 * `after` is how far past the exit seam to keep watching, in metres. It matters
 * for the LAUNCHERS: a jump throws the car AT its lip, so a window that closes
 * at the seam measures the run-up and misses the entire flight.
 */
function drive(chain, speed, hold = true, after = 6) {
  const t = track(chain, hold);
  const { start, finish } = t;

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(t.ground, null);
  car.getFloorY = () => -300;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -6);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -speed);
  car._resetInterpolation();

  let air = 0, worstAir = 0, entered = false, done = false, peakAssist = 0, held = 0, ticks = 0;
  let peakDroop = 0;
  // ── JITTER ────────────────────────────────────────────────────────────────
  // The car holding the slope is only half of "usable" — it also has to hold it
  // SMOOTHLY, and the failure mode of a servo against a hard on/off trigger is a
  // limit cycle rather than a bad average. Two numbers catch it:
  //
  //  • `chatter`: how many times the hold switched on or off across all four
  //    wheels. A crest should engage once and release once, i.e. single digits;
  //    a relay oscillation shows up as dozens.
  //  • `shake`: RMS of the JERK of the body's vertical velocity — the tick-to-
  //    tick change in vertical acceleration. This is what the camera and the
  //    player's eye actually see, and unlike the force it cannot be smooth while
  //    the ride is not.
  let chatter = 0, jerkSum = 0, jerkN = 0;
  const wasOn = [false, false, false, false];
  let prevVy = car.body.vel.y, prevAy = 0;
  const total = Math.round(Math.min(30, (t.road / speed) * 1.8 + 3) / FIXED_DT);
  for (let i = 0; i < total && !done; i++) {
    const sp = car.body.vel.length();
    car.tick({
      steerTarget: 0,
      throttle: sp < speed ? 1 : 0,
      brake: sp > speed * 1.08 ? 0.4 : 0,
      handbrake: false, yaw: 0, pitch: 0,
    });
    car.syncVisuals(FIXED_DT, 1);

    const z = car.body.pos.z;
    const inWindow = z <= start.z + 1 && z >= finish.z - after;
    if (inWindow) entered = true;
    else if (entered) done = true;

    const ay = (car.body.vel.y - prevVy) / FIXED_DT;
    const jerk = (ay - prevAy) / FIXED_DT;
    prevVy = car.body.vel.y;
    prevAy = ay;

    if (inWindow) {
      ticks++;
      for (let w = 0; w < car.tires.length; w++) {
        const tt = car.tires[w];
        peakAssist = Math.max(peakAssist, tt.roadHoldForce);
        if (tt.grounded) peakDroop = Math.max(peakDroop, -tt.compression);
        // Thresholded, not `> 0`: the applied pull is eased, so it decays
        // asymptotically and never reaches exactly zero. Counting bare
        // non-zeroness would flatter the easing instead of measuring the relay.
        const on = tt.roadHoldForce > 0.02 * CHASSIS.mass * GRAVITY;
        if (on !== wasOn[w]) { chatter++; wasOn[w] = on; }
      }
      // Skip the first few ticks: entering the window has a legitimate step in
      // it (the seam onto the piece), and it is the SUSTAINED shake that matters.
      if (ticks > 4) { jerkSum += jerk * jerk; jerkN++; }
      if (car.tires.some((tt) => tt.grounded && tt.hitRoadHold)) held++;
      if (car.tires.every((tt) => !tt.grounded)) {
        air += FIXED_DT;
        if (air > worstAir) worstAir = air;
      } else air = 0;
    }
    if (car.body.pos.y < -40) break;
  }
  return {
    worstAir,
    reached: entered,
    peakAssist,
    peakDroop,
    chatter,
    shake: jerkN ? Math.sqrt(jerkSum / jerkN) : 0,
    // Fraction of the window with at least one wheel on tagged deck.
    holdSeen: ticks ? held / ticks : 0,
  };
}

/** A wheel skipping a seam is not "the car took off". 80 ms of all-four-off is. */
const AIR_TOL = 0.08;
/** ~173 km/h — near TIRE.topSpeed (50 m/s), i.e. how the game is actually played. */
const FAST = 48;

/* ══ 3. EVERY SLOPES PRESET, AT THE SPEED PEOPLE DRIVE ═════════════════════ */
console.log("\n═══ THE SLOPES TAB AT 173 km/h ═══");
console.log("  air time over the piece, tag off vs tag on. The tag is the only difference.\n");
console.log("  piece                 L    H    unaided   held    droop   pull   switches   shake (off/on)");

const rows = [];
for (const pr of CATEGORY_PRESETS.slopes) {
  if (pr.base !== "slope" && pr.base !== "crest") continue;
  const pp = { ...pieceParams, ...pr.params };
  const chain = [[pr.base, pr.params]];
  const off = drive(chain, FAST, false);
  const on = drive(chain, FAST, true);
  const R = convexVerticalRadius(pr.base, pp);
  rows.push({ pr, off, on, R });
  console.log(`  ${pr.label.padEnd(18)} ${String(pp.slopeLength).padStart(3)} ${String(pp.slopeRise).padStart(4)}`
    + `   ${off.worstAir.toFixed(2).padStart(5)}s   ${on.worstAir.toFixed(2).padStart(5)}s`
    + `  ${on.peakDroop.toFixed(2).padStart(5)}m ${(on.peakAssist / (CHASSIS.mass * GRAVITY)).toFixed(1).padStart(4)}g`
    + `   ${String(on.chatter).padStart(5)}`
    + `   ${off.shake.toFixed(0).padStart(6)} /${on.shake.toFixed(0).padStart(6)}`);
}

console.log("");
// Sanity: the run has to have actually driven the piece, or every "no air"
// result below is a car that never arrived.
check(rows.every((r) => r.on.reached && r.off.reached),
  "every preset was actually driven end to end");
check(rows.every((r) => r.on.peakAssist > 0),
  "the hold fired on every one of them — the tag reaches the tyres in the sim, not just the BVH");

// ── THE ONE PIECE THAT IS SUPPOSED TO WIN ────────────────────────────────────
// "Hill Jump" is the 32 m / 8 m crest the Slopes tab used to be full of, kept
// deliberately under a name that says what it does. Its brow is a 10 m radius,
// which at this speed demands 23 g — well past ROAD_HOLD.maxG — so it launches
// the car even on tagged deck.
//
// That is the cap doing its job rather than failing to: the hold is authority
// enough for road, not infinite, so geometry violent enough is STILL a jump and
// the tab keeps a launcher for anyone who wants one. It is also the guard on the
// cap itself — drop maxG much lower and the ordinary slopes start flying again;
// raise it a lot and this stops being a jump.
const LAUNCH_BY_DESIGN = new Set(["Hill Jump"]);
const road = rows.filter((r) => !LAUNCH_BY_DESIGN.has(r.pr.label));
const byDesign = rows.filter((r) => LAUNCH_BY_DESIGN.has(r.pr.label));

check(road.every((r) => r.on.holdSeen > 0.8),
  "the wheels are on tagged deck for over 80% of every piece the car is meant to follow");

// THE HEADLINE. Not "improved", not "a bit better": no air at all, at a speed
// where the unaided car is a projectile on every one of these tiles.
const stillFlying = road.filter((r) => r.on.worstAir > AIR_TOL);
check(stillFlying.length === 0,
  `NOTHING in the Slopes tab launches the car at ${kmh(FAST)} km/h any more`
  + ` (${road.length} presets)`
  + `${stillFlying.length ? ` — still airborne: ${stillFlying.map((r) => `${r.pr.label} ${r.on.worstAir.toFixed(2)}s`).join(", ")}` : ""}`);

check(byDesign.every((r) => r.on.worstAir > 0.3),
  `...except the one whose name says it launches: Hill Jump still gets`
  + ` ${byDesign.map((r) => `${r.on.worstAir.toFixed(2)}s`).join("")} of air, because a 10 m brow`
  + ` asks 23 g and the hold only brings ${ROAD_HOLD.maxG}`);

// ...and the same geometry without the tag, which is what the player was
// driving. If this ever goes green the test has stopped measuring anything.
const flewUnaided = rows.filter((r) => r.off.worstAir > AIR_TOL);
check(flewUnaided.length === rows.length,
  `and untagged, ALL ${flewUnaided.length} of them throw the car — the tag is what fixed this,`
  + ` not a shape change`);

/* ══ 3a. AND IT HAS TO HOLD THEM SMOOTHLY ══════════════════════════════════ */
//
// "It sticks now, but the car jitters a bit." Holding the road is half the job;
// a servo that holds it by buzzing against its own trigger is not a fix, it is a
// different complaint.
//
// THE CONTROL HAS TO BE CHOSEN CAREFULLY. Comparing hold-on against hold-off at
// 173 km/h is meaningless for smoothness, because the hold-off car is in FREE
// FLIGHT — measured at 70 units of jerk on the descents, which is not smooth
// driving, it is not driving at all. So this drives each piece at 80% of its
// UNAIDED limit, where both cars stay glued and the only difference is whether
// the hold is contributing. Any jitter the mechanism adds shows up here, against
// a control that is genuinely on the road.
console.log("\n═══ ...AND HOLDS THEM SMOOTHLY ═══");
console.log("  each piece at 80% of its own unaided limit, where BOTH cars stay down.\n");
console.log("  piece                speed    shake off    shake on   switches");
{
  const worse = [];
  for (const r of rows) {
    const slow = Math.max(8, followSpeed(r.R) * 0.8);
    const off = drive([[r.pr.base, r.pr.params]], slow, false);
    const on = drive([[r.pr.base, r.pr.params]], slow, true);
    console.log(`  ${r.pr.label.padEnd(18)} ${kmh(slow).padStart(4)} km/h`
      + `   ${off.shake.toFixed(0).padStart(8)}    ${on.shake.toFixed(0).padStart(8)}`
      + `   ${String(on.chatter).padStart(5)}`);
    // Generous factor: the hold is doing real work at these speeds on the
    // steeper tiles, and some extra jerk is the crest being followed rather
    // than the mechanism ringing. A relay oscillation is not a 50% difference,
    // it is orders of magnitude — the first version measured 20x here.
    if (on.shake > Math.max(400, off.shake * 1.5)) {
      worse.push(`${r.pr.label} ${off.shake.toFixed(0)}→${on.shake.toFixed(0)}`);
    }
  }
  console.log("");
  check(worse.length === 0,
    `the hold does not add jitter where the car was already following the road`
    + `${worse.length ? ` — ${worse.join(", ")}` : ""}`);
}

/* ══ 3b. THE TOOLTIP HAS TO MEAN IT ════════════════════════════════════════ */
console.log("\n═══ WHAT THE PALETTE PROMISES ═══");
{
  // The tile tooltip quotes heldSpeed for anything on the FOLLOW_ROAD list —
  // "holds at any speed" for most of the Slopes tab. That is a promise made
  // before you place the piece, so it has to be checked against the car rather
  // than against the formula it came from.
  const lied = [];
  for (const r of rows) {
    const promised = heldSpeed(r.R);
    const flewAtFast = r.on.worstAir > AIR_TOL;
    // "holds at any speed" and it flew, or "launches above X" with X above the
    // test speed and it flew anyway — either way the tooltip was wrong.
    if (flewAtFast && promised > FAST) lied.push(`${r.pr.label} (promised ${kmh(promised)}+)`);
  }
  check(lied.length === 0,
    `no tile promises more than the car delivers${lied.length ? ` — ${lied.join(", ")}` : ""}`);

  // And the other direction, so the tooltip is not uselessly pessimistic: a
  // piece the formula says holds at any speed must be one the car really holds.
  const anySpeed = rows.filter((r) => !Number.isFinite(heldSpeed(r.R)));
  check(anySpeed.length > 0 && anySpeed.every((r) => r.on.worstAir <= AIR_TOL),
    `every tile that claims "holds at any speed" does (${anySpeed.length} of ${rows.length})`);
}

/* ══ 4. THE ASSIST IS NOT A PERMANENT MAGNET ═══════════════════════════════ */
console.log("\n═══ IT COSTS NOTHING WHERE THERE IS NO CURVE ═══");
{
  // A straight is tagged nowhere and curved nowhere, so the assist must be
  // exactly zero. This is the regression guard on ordinary driving: if flat road
  // ever picks up an invisible extra 100 kg, the whole car changes and nobody
  // would know where it came from.
  const flat = drive([["straight", { straightLength: 60 }]], FAST, true);
  check(flat.peakAssist === 0,
    `flat road asks for no hold at all (peak ${flat.peakAssist.toFixed(2)} N)`);
  // The reference for reading the shake column above. Flat road at the same
  // speed has no hold and no curvature, so whatever jerk it shows is the floor:
  // the suspension crossing the deck's tessellation, and nothing else.
  console.log(`  ── flat road at ${kmh(FAST)} km/h shakes ${flat.shake.toFixed(0)}`
    + ` — the floor for the column above, with no hold and no curve involved`);

  // And a crest the car was ALREADY following unaided must stay free too. The
  // trigger is a strut past its rest length, so a curve gentle enough that the
  // suspension keeps up never opens a gap and never summons anything. This is
  // what makes the feature invisible where it is not needed, rather than a
  // permanent downforce bonus on every tagged piece.
  const gentle = drive([["crest", { slopeLength: 90, slopeRise: 3 }]], 20, true);
  check(gentle.peakAssist < 0.1 * CHASSIS.mass * GRAVITY,
    `a crest the car could already hold is left alone: peak pull`
    + ` ${(gentle.peakAssist / (CHASSIS.mass * GRAVITY)).toFixed(2)} g`);
}

/* ══ 5. JUMPS STILL JUMP ═══════════════════════════════════════════════════ */
console.log("\n═══ AND THE RAMPS ARE UNTOUCHED ═══");
{
  // The whole reason the original SURFACE_GRIP note refused to do this. If a
  // jump stops throwing the car, the feature has eaten the game.
  const cases = [
    ["jump", { jumpLength: 18, jumpAngle: 12 }, 35],
    ["jump", { jumpLength: 22, jumpAngle: 18 }, 40],
    ["dive", { jumpLength: 18, jumpAngle: 14 }, 35],
  ];
  for (const [id, params, speed] of cases) {
    // 60 m of window past the lip: a ramp throws the car AT the seam, so a
    // window that closes there measures the run-up and misses the flight.
    const r = drive([[id, params]], speed, true, 60);
    check(r.worstAir > 0.2,
      `${id} (${params.jumpAngle}°) at ${kmh(speed)} km/h still launches: ${r.worstAir.toFixed(2)}s of air`);
    check(r.peakAssist === 0,
      `...with the hold never firing, because ${id} is not on the list`);
  }
}

/* ══ 6. THE SWITCH TURNS IT OFF ════════════════════════════════════════════ */
console.log("\n═══ ROAD_HOLD.enabled = false RESTORES THE OLD CAR EXACTLY ═══");
{
  // Not a nicety: it is how anyone can tell whether a handling complaint is this
  // feature's fault, and it is what the dev panel toggle drives.
  const worst = rows.reduce((a, b) => (a.off.worstAir > b.off.worstAir ? a : b));
  const chain = [[worst.pr.base, worst.pr.params]];
  ROAD_HOLD.enabled = false;
  const zeroed = drive(chain, FAST, true);
  ROAD_HOLD.enabled = true;
  check(Math.abs(zeroed.worstAir - worst.off.worstAir) < 0.05,
    `switched off, tagged deck behaves exactly like untagged: ${zeroed.worstAir.toFixed(2)}s`
    + ` vs ${worst.off.worstAir.toFixed(2)}s on "${worst.pr.label}"`);
  check(zeroed.peakAssist === 0, "...and applies no force at all");
}

console.log(`\n${failed ? `FAIL — ${failed} check(s)` : "all checks green"}\n`);
process.exit(failed ? 1 : 0);
