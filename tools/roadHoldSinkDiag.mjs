// WHY THE CAR SANK INTO THE SLOPES, AND WHAT IT COST TO STOP IT.
//
// Reported: "the car wheels enter inside the road a lot on the slopes and that
// looks very bad", "the magnet doesn't feel smooth", and — the diagnostic one —
// "no matter the settings except 0". This file measures all of it. There turned
// out to be THREE separate causes, and only the first was the road hold.
//
// ── 1. THE HOLD OUT-PUSHED THE SPRING ──────────────────────────────────────
// The droop servo's ceiling was maxG 16, i.e. 16 x 1400 x 9.81 / 4 = 54,936 N at
// a corner, against a strut that produces 49,907 N squashed absolutely flat.
// Saturated — which it was, always, on every preset — it simply won, and drove
// the hub through the deck. That is also why the sliders felt dead: a servo
// pinned at its cap is a switch, and 0 was the only setting that moved it.
// Fixed by sizing the force from the CURVATURE it has to pay for (v.omega)
// instead of from how far the wheel had already fallen behind.
//
// ── 2. THE SLOPE PROFILES OVERLOADED THEIR CONCAVE HALF ────────────────────
// Not the crest — the BOTTOM of the climb. SLOPE_CONCAVE_FRAC was 0.35, giving
// the concave half the short side on the reasoning that the suspension would
// absorb it. It did not: 16.3 g demanded on Up Steep against a strut good for
// 14.5. Fixed by making the profiles symmetric again and resizing the presets.
//
// ── 3. THE BUMP STOP ENGAGED AFTER THE WHEEL HAD RUN OUT OF ROOM ───────────
// The one that was nobody's fault and predates all of this. The drawn wheel is
// pinned to its contact and the body-lift hack covers 0.12 m, so the tyre is
// inside the deck once compression passes 0.31 m — but the knee sat at 0.385 m
// and rose so gently that a sustained 8 g load settled at 0.463 m. Turning both
// assists off entirely still measured 29.6 cm of tyre in the road, so this was
// never a slopes bug: it is what the car did under ANY sustained high-g load,
// and ROAD_HOLD only made it visible by keeping the wheels down long enough to
// see it. Fixed by moving the knee to 0.2475 m and making it firm.
//
// WHAT THE THREE ADD UP TO, worst case across the Slopes presets at 173 km/h:
//
//                      before      after
//     tyre in deck     41 cm       3 cm
//     time in deck     56%         33%     (and 0% on the gentle presets)
//     peak compression 0.88 m      0.34 m   (against 0.55 m of travel)
//     hub vs surface   0.33 m under 0.21 m clear
//
// The columns below are the live version of that table. `hub` is the headline:
// the wheel hub's closest approach to the deck, which must stay above
// WHEEL.radius - TIRE.archLiftMax (0.24 m) or the mesh has nowhere legal to be.
//
// Run: node tools/roadHoldSinkDiag.mjs
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.rhs.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, ROAD_HOLD, CHASSIS, GRAVITY, TIRE, WHEEL } =
  await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, pieceParams } =
  await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
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

/* ══ WHAT THE SUSPENSION CAN ACTUALLY PUSH BACK WITH ═══════════════════════ */
//
// The bar is the strut's force at the compression where the DRAWN WHEEL runs
// out of room, NOT at full squash. Full squash is the wrong bar: with a firm
// bump stop it is a huge number the hold could never approach, so comparing
// against it would look healthy while the tyre was already buried. The wheel is
// pinned to its contact and the body-lift hack absorbs archLiftMax of
// shortfall, so the budget is `radius - archLiftMax` of hub clearance.
const visualBudget = TIRE.restLength - (WHEEL.radius - TIRE.archLiftMax);
const strutAtBudget = visualBudget * TIRE.springStrength
  + Math.pow(Math.max(0, visualBudget - TIRE.restLength * TIRE.bottomOutThresh), 2)
    * TIRE.springStrength * TIRE.bottomOutMult;
const holdCap = (ROAD_HOLD.maxG ?? 0) * CHASSIS.mass * GRAVITY * 0.25;
const staticLoad = CHASSIS.mass * GRAVITY * 0.25;
const knee = TIRE.restLength * TIRE.bottomOutThresh;

console.log("═══ THE FORCE BUDGET AT ONE CORNER ═══\n");
console.log(`  static load, car at rest       ${staticLoad.toFixed(0).padStart(7)} N`
  + `   (${(staticLoad / TIRE.springStrength * 100).toFixed(1)} cm of squash)`);
console.log(`  bump stop starts to bite       ${(knee * TIRE.springStrength).toFixed(0).padStart(7)} N`
  + `   (${(knee * 100).toFixed(1)} cm)`);
console.log(`  strut where the wheel runs out ${strutAtBudget.toFixed(0).padStart(7)} N`
  + `   (${(visualBudget * 100).toFixed(1)} cm — past here the tyre is in the deck)`);
console.log(`  ROAD_HOLD ceiling              ${holdCap.toFixed(0).padStart(7)} N`
  + `   (maxG ${ROAD_HOLD.maxG} / 4 corners)`);
console.log("");
if (holdCap > strutAtBudget) {
  console.log(`  ⇒ THE HOLD OUTRANKS THE SPRING BY ${(holdCap - strutAtBudget).toFixed(0)} N`
    + ` where it matters.`);
  console.log(`    Saturated, it pushes the wheel into the deck on its own. No`);
  console.log(`    corrector or curvature tuning changes that — only maxG, or a`);
  console.log(`    bump stop that engages sooner.`);
} else {
  console.log(`  ⇒ the strut wins by ${(strutAtBudget - holdCap).toFixed(0)} N: even a fully`
    + ` saturated hold cannot`);
  console.log(`    push the wheel through the road by itself.`);
}
console.log(`
  And the number the assist is sized BY, rather than tuned to: at 48 m/s`);
console.log(`  a 33 m brow demands v²/R = ${(48 * 48 / 33).toFixed(0)} m/s² = `
  + `${(48 * 48 / 33 / GRAVITY).toFixed(1)} g, i.e. `
  + `${(CHASSIS.mass * 48 * 48 / 33 / 4 / 1000).toFixed(1)} kN per corner.`);

/* ══ TRACK ════════════════════════════════════════════════════════════════ */
const _tracks = new Map();
function track(chain) {
  const key = JSON.stringify(chain);
  if (_tracks.has(key)) return _tracks.get(key);
  const decks = [];
  let conn = new THREE.Matrix4();
  const put = (id, params) => {
    const p = buildPiece(id, conn, { ...pieceParams, ...params });
    const g = p.geometry.clone(); g.applyMatrix4(p.world);
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    mesh.userData.roadHold = true;
    mesh.updateMatrixWorld(true);
    decks.push(mesh);
    conn = p.connectorOut;
  };
  put("straight", { straightLength: 80 });
  const start = new THREE.Vector3().setFromMatrixPosition(conn);
  for (const [id, params] of chain) put(id, params);
  const finish = new THREE.Vector3().setFromMatrixPosition(conn);
  put("straight", { straightLength: 40 });
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes(decks);
  const built = { ground: bvh.baked ? bvh : null, start, finish };
  _tracks.set(key, built);
  return built;
}

const _down = new THREE.Vector3(0, -1, 0);
const _from = new THREE.Vector3();

/**
 * Drive the piece and watch the SUSPENSION, not the air time.
 *
 * The headline number is `minHub`: how close the wheel hub gets to the deck. The
 * drawn tyre is a sphere of WHEEL.radius around it, and _updateWheelExtensions
 * pins the tyre to the measured contact — so the moment the hub is nearer the
 * road than the tyre is wide, the mesh has nowhere legal to be and the wheel is
 * inside the deck. `archLift` is the body being jacked upward to hide exactly
 * that, capped at TIRE.archLiftMax, and a lift pinned at its cap is the "wheels
 * in the road" the player sees.
 */
function drive(chain, speed) {
  const t = track(chain);
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(t.ground, null);
  car.getFloorY = () => -300;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -6);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -speed);
  car._resetInterpolation();

  let entered = false, done = false;
  let minHub = Infinity, maxComp = 0, maxLift = 0, peakHold = 0, sunkTicks = 0, ticks = 0;
  let maxSink = 0, bottomTicks = 0;
  // Force steadiness: RMS of the tick-to-tick CHANGE in the applied hold, as a
  // fraction of the mean. A force that is doing proportional work varies
  // smoothly; a saturated switch is flat, then a cliff.
  let fPrev = 0, fJumpSum = 0, fSum = 0, fN = 0;
  const total = Math.round(14 / FIXED_DT);
  for (let i = 0; i < total && !done; i++) {
    const sp = car.body.vel.length();
    car.tick({
      steerTarget: 0, throttle: sp < speed ? 1 : 0,
      brake: sp > speed * 1.08 ? 0.4 : 0,
      handbrake: false, yaw: 0, pitch: 0,
    });
    car.syncVisuals(FIXED_DT, 1);
    const z = car.body.pos.z;
    const inWindow = z <= t.start.z + 1 && z >= t.finish.z - 4;
    if (inWindow) entered = true; else if (entered) done = true;
    if (!inWindow) continue;
    ticks++;

    let f = 0;
    for (const tt of car.tires) {
      f += tt.roadHoldForce || 0;
      if (!tt.grounded) continue;
      if (tt.hitDistance < minHub) minHub = tt.hitDistance;
      if (tt.compression > maxComp) maxComp = tt.compression;
      if (tt.compression > knee) bottomTicks++; // module-level knee
      // WHAT THE RENDERER IS ACTUALLY FORCED TO DRAW. _updateWheelExtensions
      // pins the wheel centre to the measured contact (ext = hitDistance -
      // radius), so the tyre sits ON the road for as long as that offset is
      // legal — and it stays legal down to -archLiftMax, because the body-lift
      // hack pays for the rest. Only past THAT is the wheel inside the deck:
      //
      //     penetration = radius - archLiftMax - hitDistance
      //
      // (The first version of this metric used radius - hitDistance and so
      // over-reported by the whole 0.12 m the lift covers, which made healthy
      // pieces look broken.)
      const sink = WHEEL.radius - TIRE.archLiftMax - tt.hitDistance;
      if (sink > 0) { sunkTicks++; if (sink > maxSink) maxSink = sink; }
    }
    peakHold = Math.max(peakHold, f);
    if (car._archLift > maxLift) maxLift = car._archLift;
    if (ticks > 4) { fJumpSum += (f - fPrev) ** 2; fSum += f; fN++; }
    fPrev = f;
    if (car.body.pos.y < -40) break;
  }
  const meanF = fN ? fSum / fN : 0;
  return {
    minHub, maxComp, maxLift, peakHold, maxSink,
    sunkPct: ticks ? (100 * sunkTicks) / (ticks * 4) : 0,
    bottomPct: ticks ? (100 * bottomTicks) / (ticks * 4) : 0,
    // Roughness of the applied force, normalised — dimensionless so it compares
    // across pieces. High = the force is stepping rather than flowing.
    rough: meanF > 1 ? Math.sqrt(fJumpSum / fN) / meanF : 0,
  };
}

const FAST = 48;
console.log(`\n\n═══ WHAT THE SUSPENSION DOES AT ${(FAST * 3.6).toFixed(0)} km/h ═══`);
console.log(`  hub  = closest the wheel hub came to the deck. Below`
  + ` ${(WHEEL.radius - TIRE.archLiftMax).toFixed(2)} m`);
console.log(`         (radius ${WHEEL.radius} less the ${TIRE.archLiftMax} m of body lift that hides it)`);
console.log(`         the drawn wheel is INSIDE the road.`);
console.log(`  comp = peak squash, against ${TIRE.restLength} m of travel and a`);
console.log(`         bottom-out knee at ${knee_(TIRE)} m.`);
console.log(`  lift = how far the body had to be jacked up to hide the sink`);
console.log(`         (cap ${TIRE.archLiftMax} m — pinned there means it could not).\n`);
function knee_(T) { return (T.restLength * T.bottomOutThresh).toFixed(3); }
// THE CONTROL. Same geometry, same speed, hold switched off — so anything that
// shows up in BOTH columns is not the hold's doing and chasing it here is a
// waste. (The hold-off car is airborne for much of the piece and LANDS, which is
// its own legitimate source of deep compression: read the columns together.)
console.log("  piece                 hub     comp    bottomed   sink    in-road   lift    hold    rough"
  + "   | hub(off)  comp(off)");

const rows = [];
for (const pr of CATEGORY_PRESETS.slopes) {
  if (pr.base !== "slope" && pr.base !== "crest") continue;
  const r = drive([[pr.base, pr.params]], FAST);
  const wasOn = ROAD_HOLD.enabled;
  ROAD_HOLD.enabled = false;
  const off = drive([[pr.base, pr.params]], FAST);
  ROAD_HOLD.enabled = wasOn;
  rows.push({ pr, r, off });
  const hub = Number.isFinite(r.minHub) ? r.minHub.toFixed(3) : "  -  ";
  const hubOff = Number.isFinite(off.minHub) ? off.minHub.toFixed(3) : "  -  ";
  console.log(`  ${pr.label.padEnd(18)} ${hub.padStart(6)}  ${r.maxComp.toFixed(3).padStart(6)}`
    + `   ${r.bottomPct.toFixed(0).padStart(5)}%  ${r.maxSink.toFixed(3).padStart(6)}`
    + `   ${r.sunkPct.toFixed(0).padStart(5)}%  ${r.maxLift.toFixed(3).padStart(5)}`
    + `  ${(r.peakHold / 1000).toFixed(0).padStart(4)}kN`
    + `  ${r.rough.toFixed(2).padStart(5)}`
    + `   | ${hubOff.padStart(6)}   ${off.maxComp.toFixed(3).padStart(6)}`);
}

console.log("");
const sank = rows.filter((r) => r.r.maxSink > 0.01);
const bottomed = rows.filter((r) => r.r.maxComp > TIRE.restLength * TIRE.bottomOutThresh);
const pinned = rows.filter((r) => r.r.maxLift >= TIRE.archLiftMax - 1e-4);
console.log(`  ${sank.length}/${rows.length} presets put the drawn wheel inside the deck`
  + `${sank.length ? ` — worst ${(Math.max(...sank.map((r) => r.r.maxSink)) * 100).toFixed(0)} cm` : ""}`);
console.log(`  ${bottomed.length}/${rows.length} drove the strut past its bottom-out knee`);
console.log(`  ${pinned.length}/${rows.length} pinned the body-lift hack at its ${TIRE.archLiftMax} m cap`);
console.log(`\n  peak hold seen: ${(Math.max(...rows.map((r) => r.r.peakHold)) / 1000).toFixed(1)} kN`
  + ` across four corners, against a whole car that weighs`
  + ` ${(CHASSIS.mass * GRAVITY / 1000).toFixed(1)} kN.`);
