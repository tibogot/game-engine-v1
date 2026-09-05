// BUILD "LOOP-BACK SHOWCASE" — the vertical U-turn, generated with the real
// builder and then DRIVEN before it is written out.
//
//     finish ←──────── upper deck ────────┐
//                                          │        /| flip ramp
//     start  ──────── lower road ──────────┴───────/ |
//
// Out along the bottom, up the steep face, over the curl at the top — which
// sends the car BACK the way it came, upside down — and down onto a deck ABOVE
// the road it arrived on. So the landing is not down-range: it is directly over
// the run-up, facing the other way. Where exactly it comes down is MEASURED by
// driving it, because the reversal and the flip are both things no ballistic
// helper in the kit knows about.
//
//   node tools/buildLoopbackTrack.mjs
import * as THREE from "three";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
const { ModularRoadBuilder, CATEGORY_PRESETS } = await import(
  pathToFileURL(join(GAME, "modularRoadBuilder.js")).href);
const { exportTrack } = await import(pathToFileURL(join(GAME, "modularRoadTrackIO.js")).href);
const KIT = await import(pathToFileURL(join(GAME, "modularRoadKit.js")).href);

const TMP = join(ROOT, `.lbtrack.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(
  pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/** The editor builds ~40 m above the terrain; a track authored at zero loads
 *  half-buried. */
const START_HEIGHT = 70;
/** How high above the run-up the return deck sits. HIGH — up where the car IS
 *  when it comes back over, not a landing strip it falls 70 m onto. The car
 *  leaves the curl ~36 m up and peaks ~87 m up; a deck at 60 m catches it a
 *  few metres into its descent, which is the reference: land on the tower, not
 *  in the valley. */
const DECK_RISE = 46;

const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);
const say = (s) => console.log(`  ${s}`);

/* ── BUILD ───────────────────────────────────────────────────────────────── */

/** @param {number|null} landZ  measured z the car comes back down at, or null
 *   on the first pass (nothing has driven it yet). */
function build(landZ, deckRise = DECK_RISE) {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  const tile = (id) => {
    for (const list of Object.values(CATEGORY_PRESETS)) {
      const t = list.find((x) => x.id === id);
      if (t) return t.preset ?? t;
    }
    throw new Error(`no tile ${id}`);
  };
  const put = (id, n = 1) => { b.setActivePreset(tile(id)); for (let i = 0; i < n; i++) b.place(); };
  const putBase = (id) => { b.setActivePiece(id); b.place(); };

  b.setSnap({ enabled: true, step: 8, yawDeg: 15 });
  b.beginNewChain(new THREE.Vector3(0, START_HEIGHT, 0), 0, { exact: true });
  putBase("start");
  // TWO straights, not five. The curl converts speed into height almost
  // exactly (the engine is faded out on the wall — see TIRE.wallDriveFadeStart),
  // so the run-up IS the apex: five straights arrive at 45 m/s and put the car
  // 87 m in the sky; two arrive around 32 and it goes up, over, and comes down
  // onto the deck a few seconds later, which is the reference.
  put("straight_long", 2);
  put("flip_ramp");

  // ── THE RETURN DECK ──────────────────────────────────────────────────────
  // A fresh chain, elevated, pointing back down the track. Travel here is +Z,
  // and `beginNewChain` wants the CONNECTOR's yaw, whose −Z column is travel —
  // so the yaw that produces +Z travel is atan2(0, −1) = π.
  const land = landZ ?? -40;
  // THE DECK RUNS THE OTHER WAY. Travel on the return leg is +Z, so a platform
  // "begins" at its LOWEST z and runs back toward the start — the instinct from
  // a normal down-range landing puts the whole deck behind the car and it lands
  // in the gap in front of it. It also must not reach back over the ramp: an
  // elevated deck opened too early is a CEILING the car climbs into.
  const rampTopZ = pos(b.currentConnector).z;
  // Clearance scales with the ramp: a taller one throws the car further back
  // before it comes down, and its own footprint is longer.
  const deckStart = Math.max(land - 45, rampTopZ + 25);
  b.beginNewChain(
    new THREE.Vector3(0, START_HEIGHT + deckRise, deckStart), Math.PI, { exact: true });
  b.setActivePreset({
    base: "platform",
    params: { platformLength: 150, platformWidth: 44 },
  });
  b.place();
  put("straight_long", 3);
  putBase("finish");
  return { b, land, deckRise };
}

/* ── DRIVE ───────────────────────────────────────────────────────────────── */

function bakeGround(b) {
  b.scene.updateMatrixWorld(true);
  const decks = [], solids = [];
  for (const p of b.pieces) {
    const m = p.mesh;
    if (m && !m.userData.noCollision) {
      const proxy = m.userData.collisionGeometry;
      decks.push(proxy
        ? { geometry: proxy, matrixWorld: m.matrixWorld, userData: m.userData, updateMatrixWorld() {} }
        : m);
    }
    for (const extra of [p.railMesh, p.shellMesh]) {
      if (!extra) continue;
      const proxy = extra.userData.collisionGeometry;
      solids.push(proxy
        ? { geometry: proxy, matrixWorld: extra.matrixWorld, updateMatrixWorld() {} }
        : extra);
    }
  }
  const d = new RoadBvh(); d.bakeFromMeshes(decks);
  const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
  g.setRoadBvh(d);
  if (solids.length) { const s = new RoadBvh(); s.bakeFromMeshes(solids); g.setRoadSolidsBvh(s); }
  return g;
}

const _u = new THREE.Vector3();

/** Hold the throttle from the start line and watch what the curl does. */
function drive(b, deckRise, { pitch = 0, roll = 0, pitchFrom = 0.4, pitchTo = 1.6 } = {}) {
  const ground = bakeGround(b);
  const startM = b.pieces.find((p) => p.id === "start").connectorOut;
  const startRot = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().extractRotation(startM));
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(startRot);

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.groundBvh = ground.ground; car.solidsBvh = ground.solids;
  car.getFloorY = () => -1e4; car.enabled = true;
  car.body.pos.copy(pos(startM)).addScaledVector(fwd, 4);
  car.body.pos.y += WHEEL.radius + 0.25;
  car.body.quat.copy(startRot).multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));

  const deckY = START_HEIGHT + deckRise;
  let peak = 0, left = null, air = 0, landZ = null, landUp = null, reversed = false, minUp = 1;
  for (let i = 0; i < Math.round(40 / FIXED_DT); i++) {
    const pressing = left && air > pitchFrom && air <= pitchTo;
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0,
      pitch: pressing ? pitch : 0, airSteer: pressing ? roll : 0 });
    const p = car.body.pos;
    _u.set(0, 1, 0).applyQuaternion(car.body.quat);
    peak = Math.max(peak, p.y);
    if (!left && car.groundedCount === 0 && p.y > START_HEIGHT + 3) {
      left = { y: p.y, vz: car.body.vel.z, up: _u.y, speed: car.body.vel.length() };
      reversed = car.body.vel.z > 1;
      minUp = 1;
    } else if (left) {
      minUp = Math.min(minUp, _u.y);
      if (landZ === null) air += FIXED_DT; // flight time, not slide time
      // The moment it comes back down to deck height, still travelling back.
      if (landZ === null && p.y <= deckY + 1.2 && car.body.vel.y < 0) {
        landZ = p.z; landUp = _u.y;
      }
      if (p.y < START_HEIGHT - 30) break;
    }
  }
  return { peak, left, reversed, landZ, landUp, air, minUp };
}

/* ── CALIBRATE ───────────────────────────────────────────────────────────── */
// Where the car comes down is measured, not solved: it is flying BACKWARDS off
// an inverted launch, which no ballistic helper in the kit models.
console.log("\nBUILDING LOOP-BACK SHOWCASE\n");
// The deck HEIGHT is measured too: just under the apex the car actually
// reaches on this track, so it touches down a few metres into its descent
// instead of dropping 40 m onto a platform (the reference: land on the tower).
// …and the deck sits a little BELOW the top of the curl, from the geometry, not
// from a drive: the car only rises ~9 m above the top now, so "just under the
// apex" and "clear of the climb" are the same few metres — a deck up there was
// a ceiling. Six metres under the exit it is unmistakably a tower you land on,
// and the car is clearly descending when it gets there.
// The deck HEIGHT is measured too, and set just under the apex the car actually
// reaches: high enough that it touches down shortly after turning over rather
// than dropping tens of metres onto it, which is the whole point of putting the
// landing up there. Both the height and the position converge together.
// The deck height comes from the RAMP, not from a driven peak. Deriving it
// from the measured apex diverges: a deck placed high changes the flight, which
// moves the apex, which moves the deck — one run reported a 297 m peak. The
// ramp lip plus a few metres is both stable and the right answer, since that is
// where the car is when it comes back over.
const probe = build(null, DECK_RISE);
const topRise = pos(probe.b.pieces.find((p) => p.id === "loopback").connectorOut).y - START_HEIGHT;
// BELOW the lip, not above it. Above, the car meets the deck's leading edge
// while it is still climbing away from the ramp — measured on a 38 m ramp with
// the deck at 46 m: 0.9 s of air and a landing 11 m from the lip, which is the
// deck getting in the way of the trick rather than catching it. Sitting under
// the lip means the car is unambiguously descending when it arrives, and has
// flown its arc first. Still very high above the ROAD, which is the point.
const deckRise = Math.max(18, Math.round(topRise - 8));
let landZ = null, built = null;
for (let pass = 1; pass <= 8; pass++) {
  built = build(landZ, deckRise);
  const run = drive(built.b, deckRise);
  const got = run.landZ ?? built.land;
  say(`pass ${pass}: deck sized for z ${built.land.toFixed(0)}, `
    + `car came down at z ${run.landZ === null ? "—" : run.landZ.toFixed(0)}`);
  const shift = Math.abs(got - built.land);
  landZ = got;
  if (shift < 3) break;
}
const b = built.b;

console.log("\nTHE RUN\n");
const runA = drive(b, built.deckRise);
say(`over the top and up to ${runA.peak.toFixed(1)} m (deck is ${built.deckRise} m above the road)`);
if (runA.left) {
  say(`leaves the lip ${runA.left.y.toFixed(1)} m up at ${runA.left.speed.toFixed(0)} m/s, `
    + `${runA.reversed ? "travelling BACK the way it came" : "still going onward"}, `
    + `turning over (lowest up ${runA.minUp.toFixed(2)}${runA.minUp < -0.9 ? " — fully inverted" : ""})`);
}
say(`comes down at z ${runA.landZ === null ? "—" : runA.landZ.toFixed(0)}, `
  + `${runA.air.toFixed(1)} s of air, ${runA.landUp === null ? "" : runA.landUp > 0.5 ? "on its wheels" : "still inverted"}`);
// The car comes off turning over backwards; how far round it is when it arrives
// depends on the flight, and the pitch keys are what the player finishes or
// arrests it with. Drive it both ways so the report shows the rotation is theirs.
// The car comes off the top upside down, so the natural correction is a HALF
// ROLL (W/X), which is what the reference game has you do; pitch is the other
// option. Drive both so the report shows the landing is the player's.
// The car arrives ~200 degrees round and holds there, so there are two ways to
// land it and the player picks: FINISH the rotation with nose-up (to a full
// 360) or HALF ROLL out of it with W/X. How long you hold is the skill, so
// search for a hold that works rather than asserting one — too little lands on
// the roof, too much goes straight past upright.
const search = (opts) => {
  for (let hold = 0.2; hold <= 2.2; hold += 0.05) {
    const r = drive(b, built.deckRise, { ...opts, pitchFrom: 0.4, pitchTo: 0.4 + hold });
    if ((r.landUp ?? -1) > 0.5) return { r, hold };
  }
  return { r: drive(b, built.deckRise, { ...opts, pitchFrom: 0.4, pitchTo: 1.4 }), hold: 0 };
};
const B = search({ pitch: 1 });   // finish the flip
const C = search({ roll: 1 });    // roll out of it
const runB = B.r, runC = C.r;
const way = (r) => r.landUp === null ? "—" : r.landUp > 0.5 ? "ON ITS WHEELS" : "inverted";
say(`nose-up ${B.hold.toFixed(2)}s -> ${way(runB)}    half-roll ${C.hold.toFixed(2)}s -> ${way(runC)}`);

/* ── CHECKS ──────────────────────────────────────────────────────────────── */
console.log("\nCHECKS\n");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};
check("the car gets up the face and over the top", !!runA.left && runA.peak > START_HEIGHT + 18,
  `${(runA.peak - START_HEIGHT).toFixed(1)} m above the road`);
check("it comes off travelling BACK the way it came", runA.reversed,
  runA.left ? `vz ${runA.left.vz.toFixed(1)} m/s` : "never left the ramp");
check("it turns fully upside down", runA.minUp < -0.9, `lowest up ${runA.minUp.toFixed(2)}`);
// The run-up runs from z 0 (start) down to the ramp, so coming BACK means
// returning to a z between the two — i.e. above the road it drove out along.
const rampZ = pos(b.pieces.find((p) => p.id === "loopback").connectorIn).z;
check("it comes down over the road it arrived on",
  runA.landZ !== null && runA.landZ > rampZ + 8 && runA.landZ < 5,
  runA.landZ === null
    ? "never returned to deck height"
    : `z ${runA.landZ.toFixed(0)}, ${(runA.landZ - rampZ).toFixed(0)} m back up the run-up (which runs 0 → ${rampZ.toFixed(0)})`);
check("there is enough air to roll it out", runA.air > 1.5, `${runA.air.toFixed(1)} s`);
const ups = [runA, runB, runC].map((r) => r.landUp ?? -1);
check("the trick is landable — some way of flying it arrives on its wheels",
  ups.some((u) => u > 0.5),
  `no input ${ups[0].toFixed(2)}, nose-up ${ups[1].toFixed(2)}, roll ${ups[2].toFixed(2)}`);

let worstSeam = 0;
for (const c of b.chains) {
  const ps = b.pieces.filter((p) => p.chainId === c.id);
  for (let i = 1; i < ps.length; i++) {
    if (ps[i].detached) continue;
    worstSeam = Math.max(worstSeam, pos(ps[i - 1].connectorOut).distanceTo(pos(ps[i].connectorIn)));
  }
}
check("every seam inside every chain is tight", worstSeam < 1e-6,
  `worst ${worstSeam.toExponential(2)} m`);
check("it has a start and a finish", b.pieces.some((p) => p.id === "start")
  && b.pieces.some((p) => p.id === "finish"));
const ys = b.pieces.flatMap((p) => [pos(p.connectorIn).y, pos(p.connectorOut).y]);
check(`nothing sinks underground (lowest ${Math.min(...ys).toFixed(0)} m)`, Math.min(...ys) > 15);

/* ── WRITE ───────────────────────────────────────────────────────────────── */
// Through the kit's own exportTrack against the kit's current defaults, so every
// tuning block comes out empty and the file inherits today's road cross-section
// instead of pinning the one it was authored against.
const empty = { exportInstances: () => [], exportLayout: () => [] };
const out = exportTrack({
  builder: b,
  props: empty, movers: empty, portals: empty,
  roadParams: KIT.roadParams,
  guardrailParams: KIT.guardrailParams,
  pieceParams: KIT.pieceParams,
  portalParams: KIT.portalParams,
  defaults: {
    roadParams: KIT.ROAD_PARAM_DEFAULTS,
    guardrailParams: KIT.GUARDRAIL_PARAM_DEFAULTS,
    pieceParams: KIT.PIECE_PARAM_DEFAULTS,
  },
});
out.spawn = null;

if (fail) {
  console.log(`\n${fail} FAILURE(S) — not written\n`);
  process.exit(1);
}
writeFileSync(join(GAME, "loopback-showcase.json"), JSON.stringify(out, null, 1));
console.log(`\nwrote games/modular-road-v3/loopback-showcase.json — ${out.pieces.length} pieces\n`);
