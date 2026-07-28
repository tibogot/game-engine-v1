// THE USER'S OWN TRACK, driven headlessly.
//
// games/modular-road-v3/jump-debug.json — three 32 m straights, a 24° jump
// piece, a 110 m gap, then the landing road, all at y = 40.
//
// This builds the REAL geometry with the real builder and kit, bakes the real
// deck/solids BVHs, and drives the real Vehicle over it. No analytic ramp, no
// hand-set launch velocity: the car drives up the actual jump piece and leaves
// it however that piece's shape says it should.
//
// Every earlier instrument approximated the launch, and the launch is where the
// bug is made — so this is the first faithful measurement.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const R2D = 57.2958;

// The vehicle pulls GPU imports; strip them the same way the other tools do.
const VTMP = join(ROOT, `.jd.${process.pid}.mjs`);
writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(VTMP).href);
unlinkSync(VTMP);

const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
const { roadParams, guardrailParams, pieceParams } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { importTrack } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadTrackIO.js")).href);
const { RoadBvh } = await import(
  pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
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

// ── BUILD THE TRACK ─────────────────────────────────────────────────────────
const scene = new THREE.Scene();
const mat = () => new THREE.MeshBasicMaterial();
const builder = new ModularRoadBuilder({
  scene, material: mat(), railMaterial: mat(), shellMaterial: mat(), decorMaterial: mat(),
  isBuildMode: () => true,
});
const data = JSON.parse(readFileSync(join(ROOT, "games/modular-road-v3/jump-debug.json"), "utf8"));
const stub = { exportInstances: () => [], importInstances: () => {}, clear() {}, instances: [] };
const portalStub = { exportLayout: () => ({}), importLayout: () => {}, clear() {}, params: {} };
const res = importTrack(data, {
  builder, props: stub, movers: stub, portals: portalStub,
  roadParams, guardrailParams, pieceParams, portalParams: {},
});
if (!res.ok) throw new Error("track import failed: " + res.error);
scene.updateMatrixWorld(true);

const deckBvh = new RoadBvh();
const solidsBvh = new RoadBvh();
deckBvh.bakeFromMeshes(builder.pieces.map((p) => p.mesh).filter((m) => m && !m.userData.noCollision));
const solids = [];
for (const p of builder.pieces) { if (p.railMesh) solids.push(p.railMesh); if (p.shellMesh) solids.push(p.shellMesh); }
if (solids.length) solidsBvh.bakeFromMeshes(solids);

// No terrain anywhere near the track (it floats at y=40), so the ground adapter
// only ever answers from the road BVH — exactly as in the game's sky build.
const ground = createVehicleGround({ getTerrainHeight: () => -1000 });
ground.setRoadBvh(deckBvh.baked ? deckBvh : null);
ground.setRoadSolidsBvh(solidsBvh.baked ? solidsBvh : null);

console.log(`TRACK: ${builder.pieces.length} pieces, deck tris ${deckBvh.triCount}`);
const inPos = (p) => new THREE.Vector3().setFromMatrixPosition(p.connectorIn);
builder.pieces.forEach((p, i) => {
  const v = inPos(p);
  console.log(`  ${i} ${p.id.padEnd(9)} chain ${p.chainId}  in (${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`);
});

// ── DRIVE IT ────────────────────────────────────────────────────────────────
const _f = new THREE.Vector3();
const _up = new THREE.Vector3();
const sup = (c) => c.tires.some((t) => t.grounded && t.compression > 0);

/**
 * Start on the first straight, drive down the road, off the jump, barrel-roll,
 * land on the far chain. `target` is how far the roll is held, in degrees.
 */
function drive({ dir = -1, target = 360, speed = 40, secs = 20 } = {}) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.setBvh(ground.ground, ground.solids);
  c.enabled = true;
  const start = inPos(builder.pieces[0]);
  c.body.pos.set(start.x, start.y + 0.6, start.z - 6);
  // The chain runs toward -Z, so the car's +Z forward is turned around.
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -speed);
  c._resetInterpolation();

  let rolled = 0, launched = false, land = null;
  let hdgLaunch = 0, pitchRate = 0, maxAir = 0, swing = 0, lateral = 0;
  let wasSup = true;
  const post = { peakYaw: 0, at: 0, slip: 0, maxSlip: 0, grounded: 0, speed: 0 };

  for (let i = 0; i < secs / FIXED_DT; i++) {
    const t = i * FIXED_DT;
    _f.set(0, 0, 1).applyQuaternion(c.body.quat);
    if (launched && !land) rolled += c.body.angVel.dot(_f) * FIXED_DT * R2D;
    const rolling = launched && !land && Math.abs(rolled) < target;
    c.tick({ steerTarget: rolling ? dir : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });

    _f.set(0, 0, 1).applyQuaternion(c.body.quat);
    _up.set(0, 1, 0).applyQuaternion(c.body.quat);
    const nowSup = sup(c);
    const hdg = Math.atan2(_f.x, _f.z) * R2D;

    if (!launched && wasSup && !nowSup) {
      launched = true; hdgLaunch = hdg;
      _up.set(1, 0, 0).applyQuaternion(c.body.quat);
      pitchRate = c.body.angVel.dot(_up);
      _up.set(0, 1, 0).applyQuaternion(c.body.quat);
    }
    if (launched && !land) {
      let d = hdg - hdgLaunch; while (d > 180) d -= 360; while (d < -180) d += 360;
      if (Math.abs(d) > Math.abs(maxAir)) maxAir = d;
    }
    if (launched && !land && nowSup && !wasSup) {
      let d = hdg - hdgLaunch; while (d > 180) d -= 360; while (d < -180) d += 360;
      land = {
        t, hdgOff: d, x: c.body.pos.x, rolled,
        tilt: Math.acos(THREE.MathUtils.clamp(_up.y, -1, 1)) * R2D,
      };
    }
    if (land) {
      let d = hdg - hdgLaunch; while (d > 180) d -= 360; while (d < -180) d += 360;
      if (t - land.t <= 2.0) { swing = d; lateral = c.body.pos.x - land.x; }
      // AFTER landing, with the throttle still held: when does it let go, and
      // what is the car doing at that moment?
      const yr = Math.abs(c.body.angVel.y);
      if (yr > post.peakYaw) {
        post.peakYaw = yr;
        post.at = t - land.t;
        post.slip = c.slipAngle * R2D;
        post.grounded = c.groundedCount;
        post.speed = Math.hypot(c.body.vel.x, c.body.vel.z);
      }
      post.maxSlip = Math.max(post.maxSlip, Math.abs(c.slipAngle * R2D));
    }
    wasSup = nowSup;
  }
  return { land, maxAir, swing, lateral, pitchRate, post };
}

const f = (v, w = 7, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—").padStart(w);

console.log("\n=== NO ROLL — the control ===");
{
  const r = drive({ target: 0 });
  console.log(`  pitch rate off the lip ${f(r.pitchRate, 6, 2)} rad/s`);
  console.log(`  heading drift in air   ${f(r.maxAir, 6, 2)}°`);
  console.log(`  heading at landing     ${f(r.land?.hdgOff, 6, 2)}°   tilt ${f(r.land?.tilt, 5, 0)}°`);
  console.log(`  sideways after landing ${f(r.lateral, 6, 2)} m`);
}

console.log("\n=== BARREL ROLL, A vs D, and how precise it has to be ===");
console.log("  released at    A: air / land / sideways        D: air / land / sideways");
for (const tg of [180, 270, 320, 350, 360, 380, 420]) {
  const a = drive({ dir: 1, target: tg });
  const d = drive({ dir: -1, target: tg });
  const fmt = (r) => `${f(r.maxAir, 6, 2)}° ${f(r.land?.hdgOff, 6, 2)}° ${f(r.lateral, 6, 2)}m`;
  console.log(`  ${String(tg).padStart(4)}°        ${fmt(a)}      ${fmt(d)}`);
}
console.log("\n  'air' is heading drift before touching anything; 'land' is heading at");
console.log("  touchdown; 'sideways' is how far it slid across in the 2 s after.");

console.log("\n=== AFTER LANDING, THROTTLE STILL HELD ===");
// The remaining report: land straight, keep holding forward, and the car snaps.
// That is a GROUND event now, not an air one — so what is it doing when it goes?
console.log("  case          peak yaw   how long after landing   slip then   max slip   speed");
for (const [label, opts] of [
  ["no roll", { target: 0 }],
  ["roll 360 (A)", { dir: 1, target: 360 }],
  ["roll 360 (D)", { dir: -1, target: 360 }],
  ["roll 270 (D)", { dir: -1, target: 270 }],
]) {
  const r = drive(opts);
  const p = r.post;
  console.log(
    `  ${label.padEnd(13)} ${f(p.peakYaw, 6, 2)} rad/s   ${f(p.at, 8, 2)}s        ${f(p.slip, 7, 1)}°  ${f(p.maxSlip, 7, 1)}°  ${f(p.speed, 5, 1)}`,
  );
}

console.log("\n=== TIMELINE AFTER TOUCHDOWN (roll 360 D, throttle held) ===");
// The road is roadParams.width wide, so the guardrails sit at ±width/2. If the
// car slides out to them, the RAIL is what spins it — SOLID.spin turns an
// off-centre chassis hit into yaw, and that would read as "boom".
{
  const halfW = 8; // roadParams.width 16
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.setBvh(ground.ground, ground.solids); c.enabled = true;
  const start = inPos(builder.pieces[0]);
  c.body.pos.set(start.x, start.y + 0.6, start.z - 6);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -40); c._resetInterpolation();
  let rolled = 0, launched = false, landT = null, wasSup = true;
  console.log("     t     x       z      y    speed  yawRate  grnd  rail?");
  for (let i = 0; i < 20 / FIXED_DT; i++) {
    const t = i * FIXED_DT;
    _f.set(0, 0, 1).applyQuaternion(c.body.quat);
    if (launched && landT === null) rolled += c.body.angVel.dot(_f) * FIXED_DT * R2D;
    const rolling = launched && landT === null && Math.abs(rolled) < 360;
    c.tick({ steerTarget: rolling ? -1 : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const nowSup = sup(c);
    if (!launched && wasSup && !nowSup) launched = true;
    if (launched && landT === null && nowSup && !wasSup) landT = t;
    wasSup = nowSup;
    if (landT !== null && (i % 30 === 0 || c.hitSolid)) {
      const p = c.body.pos;
      console.log(`  ${(t - landT).toFixed(2).padStart(5)} ${p.x.toFixed(2).padStart(6)} ${p.z.toFixed(1).padStart(7)} ${p.y.toFixed(1).padStart(6)} ${Math.hypot(c.body.vel.x, c.body.vel.z).toFixed(1).padStart(6)} ${c.body.angVel.y.toFixed(2).padStart(7)}   ${c.groundedCount}   ${c.hitSolid ? "HIT RAIL" : Math.abs(p.x) > halfW - 1.2 ? "near" : ""}`);
    }
    if (landT !== null && t - landT > 4) break;
  }
}

console.log("\n=== DOES IT REACH THE ROAD EDGE / RAIL? ===");
// The deck is 16 m wide, so its edge is at x = ±8 and the guardrail sits on it.
// A car that lands sliding sideways walks out there — and once a wheel drops off
// the edge, or the chassis touches the rail, the reaction is off-centre and the
// car snaps. That would be "boom", and it would only ever follow a roll.
{
  const halfW = 8;
  for (const tg of [180, 270, 360, 420]) {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.setBvh(ground.ground, ground.solids); c.enabled = true;
    const start = inPos(builder.pieces[0]);
    c.body.pos.set(start.x, start.y + 0.6, start.z - 6);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, 0, -40); c._resetInterpolation();
    let rolled = 0, launched = false, landT = null, wasSup = true;
    let maxX = 0, hitRail = false, peakYaw = 0, wheelsLost = 0, atEdge = null;
    for (let i = 0; i < 20 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      _f.set(0, 0, 1).applyQuaternion(c.body.quat);
      if (launched && landT === null) rolled += c.body.angVel.dot(_f) * FIXED_DT * R2D;
      const rolling = launched && landT === null && Math.abs(rolled) < tg;
      c.tick({ steerTarget: rolling ? -1 : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      const nowSup = sup(c);
      if (!launched && wasSup && !nowSup) launched = true;
      if (launched && landT === null && nowSup && !wasSup) landT = t;
      wasSup = nowSup;
      if (landT !== null && c.body.pos.y > 35) {
        maxX = Math.max(maxX, Math.abs(c.body.pos.x));
        if (c.hitSolid) hitRail = true;
        peakYaw = Math.max(peakYaw, Math.abs(c.body.angVel.y));
        if (c.groundedCount < 4 && atEdge === null && Math.abs(c.body.pos.x) > 3) {
          atEdge = { x: c.body.pos.x, g: c.groundedCount, t: t - landT };
        }
        wheelsLost = Math.min(4, c.groundedCount);
      }
    }
    console.log(
      `  roll ${String(tg).padStart(3)}°  max |x| ${f(maxX, 5, 2)} m (edge ${halfW})  rail ${hitRail ? "HIT" : "no "}`
      + `  peak yaw ${f(peakYaw, 5, 2)}  first wheel off at x=${atEdge ? atEdge.x.toFixed(1) : "—"}`,
    );
  }
}

console.log("\n=== FLIP AND SPIN OFF THE REAL RAMP ===");
// The user reports Shift/Ctrl "not working at all" and Q/E leaving the car
// shoved sideways. Both are air controls that the heading hold could interfere
// with, so they have to be checked on the REAL launch — the synthetic one does
// not reproduce it.
{
  function air({ pitch = 0, yaw = 0, steer = 0, secs = 20 } = {}) {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.setBvh(ground.ground, ground.solids); c.enabled = true;
    const start = inPos(builder.pieces[0]);
    c.body.pos.set(start.x, start.y + 0.6, start.z - 6);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, 0, -40); c._resetInterpolation();
    let launched = false, land = null, wasSup = true;
    let pitchAcc = 0, yawAcc = 0, rollAcc = 0, hdgLaunch = 0, lateral = 0, landX = 0;
    for (let i = 0; i < secs / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      const _r = new THREE.Vector3(1, 0, 0).applyQuaternion(c.body.quat);
      const _u = new THREE.Vector3(0, 1, 0).applyQuaternion(c.body.quat);
      _f.set(0, 0, 1).applyQuaternion(c.body.quat);
      if (launched && !land) {
        pitchAcc += c.body.angVel.dot(_r) * FIXED_DT * R2D;
        yawAcc += c.body.angVel.dot(_u) * FIXED_DT * R2D;
        rollAcc += c.body.angVel.dot(_f) * FIXED_DT * R2D;
      }
      const fly = launched && !land;
      c.tick({
        steerTarget: fly ? steer : 0, throttle: 1, handbrake: false,
        yaw: fly ? yaw : 0, pitch: fly ? pitch : 0,
      });
      const nowSup = sup(c);
      if (!launched && wasSup && !nowSup) {
        launched = true;
        _f.set(0, 0, 1).applyQuaternion(c.body.quat);
        hdgLaunch = Math.atan2(_f.x, _f.z) * R2D;
      }
      if (launched && !land && nowSup && !wasSup) { land = t; landX = c.body.pos.x; }
      if (land !== null && t - land <= 2 && c.body.pos.y > 35) lateral = c.body.pos.x - landX;
      wasSup = nowSup;
    }
    return { pitchAcc, yawAcc, rollAcc, lateral, landed: land !== null };
  }
  const rows = [
    ["nothing", {}],
    ["Shift (flip up)", { pitch: 1 }],
    ["Ctrl (flip down)", { pitch: -1 }],
    ["E (spin)", { yaw: 1 }],
    ["Q (spin)", { yaw: -1 }],
    ["A (roll)", { steer: 1 }],
  ];
  console.log("  input              pitch      yaw       roll     sideways after landing");
  for (const [label, opts] of rows) {
    const r = air(opts);
    console.log(
      `  ${label.padEnd(18)} ${f(r.pitchAcc, 7, 0)}°  ${f(r.yawAcc, 7, 0)}°  ${f(r.rollAcc, 7, 0)}°   ${f(r.lateral, 7, 2)} m`,
    );
  }
  console.log("\n  Each input should move ITS OWN axis and leave the others near zero.");
}

console.log("\n=== WHICH TERM CROSS-COUPLES A ROLL INTO YAW? ===");
// A pure roll input should produce roll and nothing else. On this track it also
// produces pitch and yaw. Each air-control term is switched off in turn to find
// which one is doing it. FLIP is clean, so whatever it is has to be something
// roll and yaw touch that pitch does not.
{
  function rollRun() {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.setBvh(ground.ground, ground.solids); c.enabled = true;
    const start = inPos(builder.pieces[0]);
    c.body.pos.set(start.x, start.y + 0.6, start.z - 6);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, 0, -40); c._resetInterpolation();
    let launched = false, land = null, wasSup = true, rolled = 0;
    let pitchAcc = 0, yawAcc = 0, lateral = 0, landX = 0;
    for (let i = 0; i < 20 / FIXED_DT; i++) {
      const t = i * FIXED_DT;
      const _r = new THREE.Vector3(1, 0, 0).applyQuaternion(c.body.quat);
      const _u = new THREE.Vector3(0, 1, 0).applyQuaternion(c.body.quat);
      _f.set(0, 0, 1).applyQuaternion(c.body.quat);
      if (launched && !land) {
        pitchAcc += c.body.angVel.dot(_r) * FIXED_DT * R2D;
        yawAcc += c.body.angVel.dot(_u) * FIXED_DT * R2D;
        rolled += c.body.angVel.dot(_f) * FIXED_DT * R2D;
      }
      const rolling = launched && !land && Math.abs(rolled) < 360;
      c.tick({ steerTarget: rolling ? -1 : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      const nowSup = sup(c);
      if (!launched && wasSup && !nowSup) launched = true;
      if (launched && !land && nowSup && !wasSup) { land = t; landX = c.body.pos.x; }
      if (land !== null && t - land <= 2 && c.body.pos.y > 35) lateral = c.body.pos.x - landX;
      wasSup = nowSup;
    }
    return { pitchAcc, yawAcc, lateral };
  }
  const base = rollRun();
  console.log(`  ${"as shipped".padEnd(34)} pitch ${f(base.pitchAcc, 6, 0)}°  yaw ${f(base.yawAcc, 6, 1)}°  sideways ${f(base.lateral, 6, 2)} m`);
  const trial = (name, mut) => {
    const saved = {};
    for (const k of Object.keys(mut)) { saved[k] = TIRE[k]; TIRE[k] = mut[k]; }
    const r = rollRun();
    for (const k of Object.keys(saved)) TIRE[k] = saved[k];
    console.log(`  ${name.padEnd(34)} pitch ${f(r.pitchAcc, 6, 0)}°  yaw ${f(r.yawAcc, 6, 1)}°  sideways ${f(r.lateral, 6, 2)} m`);
  };
  trial("heading hold off", { airHeadingHold: 0 });
  trial("idle-axis damping off (airSettle)", { airSettle: 0 });
  trial("arc assist off", { airTrajectoryAlign: 0 });
  trial("landing assist off", { airLandAssist: 0 });
  trial("stabilizer damping off", { stabilizerDamp: 0 });
  trial("yaw assist off (ground)", { yawAssist: 0 });
  trial("lateral align fade off", { lateralAlignFull: -0.9, lateralAlignZero: -1 });
}

console.log("\n=== GEOMETRY SANITY ===");
{
  const bb = new THREE.Box3();
  for (const p of builder.pieces) { if (p.mesh) bb.expandByObject(p.mesh); }
  console.log(`  deck  x [${bb.min.x.toFixed(1)}, ${bb.max.x.toFixed(1)}]  y [${bb.min.y.toFixed(1)}, ${bb.max.y.toFixed(1)}]  z [${bb.min.z.toFixed(1)}, ${bb.max.z.toFixed(1)}]`);
  const rb = new THREE.Box3();
  let nRail = 0;
  for (const p of builder.pieces) { if (p.railMesh) { rb.expandByObject(p.railMesh); nRail++; } }
  if (nRail) console.log(`  rails (${nRail} meshes)  x [${rb.min.x.toFixed(2)}, ${rb.max.x.toFixed(2)}]  y [${rb.min.y.toFixed(1)}, ${rb.max.y.toFixed(1)}]`);
  else console.log("  no guardrails on this track");
}

console.log("\n=== EVERY-TICK SCAN OF THE LANDING RUN ===");
// Coarse sampling showed nothing. If there is an abrupt turn it is brief, so
// look at every single tick and report the worst yaw events with where they are.
{
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.setBvh(ground.ground, ground.solids); c.enabled = true;
  const start = inPos(builder.pieces[0]);
  c.body.pos.set(start.x, start.y + 0.6, start.z - 6);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -40); c._resetInterpolation();
  let rolled = 0, launched = false, landT = null, landZ = 0, wasSup = true;
  const events = [];
  let prevYaw = 0;
  for (let i = 0; i < 25 / FIXED_DT; i++) {
    const t = i * FIXED_DT;
    _f.set(0, 0, 1).applyQuaternion(c.body.quat);
    if (launched && landT === null) rolled += c.body.angVel.dot(_f) * FIXED_DT * R2D;
    const rolling = launched && landT === null && Math.abs(rolled) < 360;
    c.tick({ steerTarget: rolling ? -1 : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const nowSup = sup(c);
    if (!launched && wasSup && !nowSup) launched = true;
    if (launched && landT === null && nowSup && !wasSup) { landT = t; landZ = c.body.pos.z; }
    wasSup = nowSup;
    if (landT !== null && c.body.pos.y > 35) {
      const yaw = c.body.angVel.y;
      // Angular ACCELERATION about world up — an abrupt turn is a spike here.
      const dYaw = Math.abs(yaw - prevYaw) / FIXED_DT;
      events.push({
        t: t - landT, z: c.body.pos.z, dz: landZ - c.body.pos.z, x: c.body.pos.x,
        yaw, dYaw, g: c.groundedCount, solid: c.hitSolid,
        slip: c.slipAngle * R2D,
      });
      prevYaw = yaw;
    }
  }
  events.sort((a, b) => b.dYaw - a.dYaw);
  console.log(`  landed at z ${landZ.toFixed(1)}; road ends at z -352`);
  console.log("  worst yaw ACCELERATION events after landing:");
  console.log("     t     metres past landing     x      yawAccel   yawRate  grnd  slip   solid");
  for (const e of events.slice(0, 6)) {
    console.log(
      `  ${e.t.toFixed(2).padStart(5)}   ${e.dz.toFixed(1).padStart(8)} m        ${e.x.toFixed(2).padStart(6)}  ${e.dYaw.toFixed(2).padStart(8)}  ${e.yaw.toFixed(3).padStart(7)}   ${e.g}   ${e.slip.toFixed(1).padStart(5)}°  ${e.solid ? "RAIL" : ""}`,
    );
  }
}
