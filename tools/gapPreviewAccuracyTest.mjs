// IS THE RED LANDING ARC TELLING THE TRUTH?
//
// gapPreview.js draws a pure parabola from the open connector: x = x0 + v0·t +
// ½g·t², launch direction = the connector's −Z column, speed = the panel's
// `refSpeed`. The real car is not a point mass in a vacuum, so this measures the
// gap two ways:
//
//   MODEL error   — hand the real Vehicle the exact launch state the preview
//                   assumes (connector position, refSpeed along −Z) and let the
//                   real integrator fly it. Anything that differs is the
//                   preview's physics model: AERO.drag, the airborne assists.
//   FULL error    — drive the real car up the real kit ramp at refSpeed and see
//                   where it actually comes down. Adds launch-state error: the
//                   ramp lip, suspension unload, and whatever the exit tangent
//                   really is.
//
// Landing is compared like-for-like: the preview marks where a point launched at
// deck height returns to deck height, so the car is measured where its CoM
// returns to ITS OWN launch height. The constant ride-height offset cancels.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const R2D = 57.2958;

const VTMP = join(ROOT, `.gp.${process.pid}.mjs`);
writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, AERO, CHASSIS, FIXED_DT, GRAVITY } = await import(pathToFileURL(VTMP).href);
unlinkSync(VTMP);

// gapArc.js, NOT gapPreview.js: the preview's node materials need `three` to be
// aliased to `three/webgpu`, which only vite does. The solver is split out
// precisely so this tool can measure the shipping maths under plain node.
const { solveGapArc } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/gapArc.js")).href);
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
const { pieceParams, guardrailParams } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
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

/** Nothing to hit — used for the free-flight (MODEL) runs. */
const emptyGround = {
  baked: true,
  raycastFirst() { return null; },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};

const f = (v, w = 7, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—").padStart(w);

// ── BUILD A RAMP AND READ ITS OPEN CONNECTOR ────────────────────────────────
/** straights + one `jump`, chain left OPEN — exactly the build-mode state the
 *  preview draws from. Returns { builder, ground, connector }. */
function buildRamp(jumpAngle) {
  const scene = new THREE.Scene();
  const mat = () => new THREE.MeshBasicMaterial();
  const builder = new ModularRoadBuilder({
    scene, material: mat(), railMaterial: mat(), shellMaterial: mat(), decorMaterial: mat(),
    isBuildMode: () => true,
  });
  const savedAngle = pieceParams.jumpAngle;
  const savedRail = guardrailParams.enabled;
  pieceParams.jumpAngle = jumpAngle;
  guardrailParams.enabled = false;
  builder.activePieceId = "straight";
  for (let i = 0; i < 5; i++) builder.place();   // 5 × 32 m run-up
  builder.activePieceId = "jump";
  builder.place();
  pieceParams.jumpAngle = savedAngle;
  guardrailParams.enabled = savedRail;

  scene.updateMatrixWorld(true);
  const deckBvh = new RoadBvh();
  deckBvh.bakeFromMeshes(builder.pieces.map((p) => p.mesh).filter((m) => m && !m.userData.noCollision));
  const ground = createVehicleGround({ getTerrainHeight: () => -1000 });
  ground.setRoadBvh(deckBvh.baked ? deckBvh : null);
  ground.setRoadSolidsBvh(null);
  return { builder, ground, connector: builder.currentConnector.clone() };
}

/** Drag term the shipping preview now uses. */
const DRAG_K = AERO.drag / CHASSIS.mass;

/** What the red arc claims, at this connector and speed. `dragK: 0` reproduces
 *  the old vacuum parabola, for the before/after columns. */
function predict(connector, refSpeed, dragK = DRAG_K) {
  return solveGapArc(connector, refSpeed, { gravity: GRAVITY, dragK, landingDrop: 0 });
}

/** Orientation whose local +Z (car forward) points down the connector's −Z. */
function quatFromConnector(connector) {
  const m = new THREE.Matrix4().extractRotation(connector);
  const flip = new THREE.Matrix4().makeRotationY(Math.PI);
  return new THREE.Quaternion().setFromRotationMatrix(m.multiply(flip));
}

const _v = new THREE.Vector3();

/**
 * Fly the real Vehicle and report where its CoM returns to its launch height.
 * Sub-tick interpolated so the answer is not quantised to a 1/120 s step.
 */
function flyFrom({ pos, quat, vel, ground = emptyGround, secs = 12 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  if (ground === emptyGround) { c.groundBvh = emptyGround; c.solidsBvh = null; }
  else c.setBvh(ground.ground, ground.solids);
  c.enabled = true;
  c.body.pos.copy(pos);
  c.body.quat.copy(quat);
  c.body.vel.copy(vel);
  c._resetInterpolation();

  const y0 = pos.y;
  let prev = c.body.pos.clone();
  let prevY = y0;
  let apex = y0;
  for (let i = 1; i < secs / FIXED_DT; i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    const p = c.body.pos;
    apex = Math.max(apex, p.y);
    if (i > 4 && prevY > y0 && p.y <= y0) {
      const a = (prevY - y0) / (prevY - p.y);
      _v.copy(prev).lerp(p, a);
      return {
        pos: _v.clone(),
        t: (i - 1 + a) * FIXED_DT,
        dist: Math.hypot(_v.x - pos.x, _v.z - pos.z),
        apex: apex - y0,
      };
    }
    prevY = p.y; prev.copy(p);
  }
  return null;
}

console.log(`vehicle: mass ${CHASSIS.mass} kg, AERO.drag ${AERO.drag}, topSpeed ${TIRE.topSpeed} m/s`);
console.log(`preview: gravity ${GRAVITY}, dragK ${DRAG_K.toExponential(3)} /m, launch = connector −Z\n`);

// ── 1. MODEL ERROR ──────────────────────────────────────────────────────────
console.log("=== 1. MODEL ERROR — same launch state, real integrator ===");
console.log("   the ONLY differences are drag and the airborne assists\n");
console.log("  ramp  speed   vacuum arc   SHIPPING arc      real car    vacuum err   shipping err");
const modelRows = [];
for (const jumpAngle of [8, 12, 20, 28]) {
  const { connector } = buildRamp(jumpAngle);
  for (const refSpeed of [25, 30, 40, 50]) {
    const vac = predict(connector, refSpeed, 0);
    const p = predict(connector, refSpeed);
    const from = new THREE.Vector3().setFromMatrixPosition(connector);
    const e = connector.elements;
    const dir = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
    const a = flyFrom({
      pos: from.clone().setY(from.y + 1.0),   // clear of the deck; offset cancels
      quat: quatFromConnector(connector),
      vel: dir.clone().multiplyScalar(refSpeed),
    });
    if (!p || !a) { console.log(`  ${String(jumpAngle).padStart(3)}°  ${String(refSpeed).padStart(3)}     no landing`); continue; }
    const err = a.dist - p.dist;
    const vacErr = a.dist - vac.dist;
    modelRows.push({ jumpAngle, refSpeed, err, rel: err / p.dist, vacRel: vacErr / vac.dist });
    console.log(
      `  ${String(jumpAngle).padStart(3)}°  ${String(refSpeed).padStart(3)}    ${f(vac.dist, 8)} m    ${f(p.dist, 8)} m   ${f(a.dist, 8)} m   ${f(100 * vacErr / vac.dist, 6, 1)}%       ${f(100 * err / p.dist, 6, 1)}%`,
    );
  }
}
{
  const worst = (rows, key) => rows.reduce((a, b) => (Math.abs(b[key]) > Math.abs(a[key]) ? b : a));
  const wv = worst(modelRows, "vacRel"), ws = worst(modelRows, "rel");
  console.log(`\n  worst vacuum error   ${f(100 * wv.vacRel, 5, 1)}%  at ${wv.jumpAngle}° / ${wv.refSpeed} m/s`);
  console.log(`  worst SHIPPING error ${f(100 * ws.rel, 5, 1)}%  at ${ws.jumpAngle}° / ${ws.refSpeed} m/s`);
  console.log("  (negative = the car lands SHORT of the marker)");
}

// ── 2. FULL ERROR — drive the actual ramp ───────────────────────────────────
console.log("\n=== 2. FULL ERROR — the car drives up the real ramp ===");
console.log("   adds launch-state error: exit tangent, suspension unload, lip\n");
console.log("  ramp  target  launch spd  launch ang  Δang   launch off   SHIPPING   actual    error   vacuum   @true speed");
const fullRows = [];
for (const jumpAngle of [8, 12, 20, 28]) {
  const { builder, ground, connector } = buildRamp(jumpAngle);
  const e = connector.elements;
  const connAngle = Math.asin(THREE.MathUtils.clamp(-e[9] /
    Math.hypot(e[8], e[9], e[10]), -1, 1)) * R2D;
  const connPos = new THREE.Vector3().setFromMatrixPosition(connector);
  const connDir = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  // Curvature of the ramp: pitch swept between its two seams over its arc.
  const ramp = builder.pieces[builder.pieces.length - 1];
  const inE = ramp.connectorIn.elements;
  const inAngle = Math.asin(THREE.MathUtils.clamp(-inE[9] /
    Math.hypot(inE[8], inE[9], inE[10]), -1, 1)) * R2D;
  const arcLen = new THREE.Vector3().setFromMatrixPosition(ramp.connectorIn).distanceTo(connPos);
  const radius = arcLen / Math.max(1e-6, Math.abs(connAngle - inAngle) / R2D);

  for (const refSpeed of [25, 30, 40, 50]) {
    const p = predict(connector, refSpeed);
    const vac = predict(connector, refSpeed, 0);
    // Start on the first straight at refSpeed and hold it with a P controller,
    // so the car arrives at the lip at exactly the speed the arc was drawn for.
    const start = new THREE.Vector3().setFromMatrixPosition(builder.pieces[0].connectorIn);
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.setBvh(ground.ground, ground.solids);
    c.enabled = true;
    const q0 = quatFromConnector(builder.pieces[0].connectorIn);
    const fwd0 = new THREE.Vector3(0, 0, 1).applyQuaternion(q0);
    c.body.pos.copy(start).addScaledVector(fwd0, 4).setY(start.y + 0.6);
    c.body.quat.copy(q0);
    c.body.vel.copy(fwd0).multiplyScalar(refSpeed);
    c._resetInterpolation();

    const sup = () => c.tires.some((t) => t.grounded && t.compression > 0);
    let launched = null, prev = c.body.pos.clone(), prevY = 0, land = null, wasSup = true;
    let apex = -1e9;
    for (let i = 0; i < 14 / FIXED_DT; i++) {
      const sp = Math.hypot(c.body.vel.x, c.body.vel.z);
      const thr = launched ? 0 : THREE.MathUtils.clamp((refSpeed - sp) * 0.5, -1, 1);
      c.tick({ steerTarget: 0, throttle: thr, handbrake: false, yaw: 0, pitch: 0 });
      const nowSup = sup();
      const pos = c.body.pos;
      if (!launched && wasSup && !nowSup) {
        launched = {
          pos: pos.clone(), t: i * FIXED_DT,
          speed: c.body.vel.length(),
          angle: Math.atan2(c.body.vel.y, Math.hypot(c.body.vel.x, c.body.vel.z)) * R2D,
        };
        prevY = pos.y; prev.copy(pos); apex = pos.y;
      } else if (launched && !land) {
        apex = Math.max(apex, pos.y);
        if (prevY > launched.pos.y && pos.y <= launched.pos.y) {
          const a = (prevY - launched.pos.y) / (prevY - pos.y);
          const q = prev.clone().lerp(pos, a);
          land = { pos: q, apex: apex - launched.pos.y };
        }
        prevY = pos.y; prev.copy(pos);
      }
      wasSup = nowSup;
    }
    if (!p || !launched || !land) {
      console.log(`  ${String(jumpAngle).padStart(3)}°   ${String(refSpeed).padStart(3)}      (never launched / never came down)`);
      continue;
    }
    // Compare from the PREVIEW's origin — the connector — since that is what the
    // marker is placed relative to on screen.
    const from = connPos;
    const actualDist = Math.hypot(land.pos.x - from.x, land.pos.z - from.z);
    const err = actualDist - p.dist;
    // How far along the travel direction the car actually left the deck.
    const off = launched.pos.clone().sub(from).dot(connDir);
    // The same shipping arc, but drawn at the speed the car ACTUALLY left at.
    // Whatever is left after this is the ramp's doing, not the slider's.
    const pTrue = predict(connector, launched.speed);
    fullRows.push({
      jumpAngle, refSpeed, err, rel: err / p.dist,
      vacRel: (actualDist - vac.dist) / vac.dist,
      trueRel: (actualDist - pTrue.dist) / pTrue.dist,
    });
    console.log(
      `  ${String(jumpAngle).padStart(3)}°  ${String(refSpeed).padStart(3)}    ${f(launched.speed, 7)}   ${f(launched.angle, 7)}°  ${f(launched.angle - connAngle, 5, 1)}°  ${f(off, 7)} m ${f(p.dist, 8)} m ${f(actualDist, 8)} m ${f(100 * err / p.dist, 6, 1)}%  ${f(100 * (actualDist - vac.dist) / vac.dist, 6, 1)}%      ${f(100 * (actualDist - pTrue.dist) / pTrue.dist, 6, 1)}%`,
    );
  }
  console.log(`        connector exit ${f(connAngle, 5, 1)}°, ramp radius ${f(radius, 6, 1)} m, ` +
    `half-wheelbase chord bias ${f(-(1.35 / radius) * R2D, 5, 2)}°`);
}
{
  const stat = (key) => {
    const w = fullRows.reduce((a, b) => (Math.abs(b[key]) > Math.abs(a[key]) ? b : a));
    const mean = fullRows.reduce((a, b) => a + b[key], 0) / fullRows.length;
    const rms = Math.sqrt(fullRows.reduce((a, b) => a + b[key] * b[key], 0) / fullRows.length);
    return { w, mean, rms };
  };
  for (const [label, key] of [["vacuum (old)", "vacRel"], ["SHIPPING", "rel"], ["@true speed", "trueRel"]]) {
    const { w, mean, rms } = stat(key);
    console.log(`\n  ${label.padEnd(13)} mean ${f(100 * mean, 5, 1)}%   rms ${f(100 * rms, 4, 1)}%   worst ${f(100 * w[key], 5, 1)}% at ${w.jumpAngle}°/${w.refSpeed}`);
  }
  console.log("\n  Read the last row FIRST. Once the arc is drawn at the speed the car");
  console.log("  actually left at, the rms halves — so most of the 'error' in the middle");
  console.log("  row is the refSpeed slider not matching the approach, which is the");
  console.log("  author's input, not a bug. (refSpeed 50 is the clearest case: the car");
  console.log("  tops out near 48, and range goes as v², so it is 8% long on speed alone.)");
  console.log("\n  What is left after that is launch scatter, and it is NOT fixable from a");
  console.log("  connector matrix: the same ramp leaves at a different pitch at each speed");
  console.log("  (Δang column, 28° ramp: −0.7° / −4.2° / −1.8° / −0.8°) because the");
  console.log("  suspension is mid-rebound when the lip arrives. The car also leaves ~2 m");
  console.log("  PAST the lip, which pushes the other way and roughly cancels it.");
}

// ── 3. THE SOLVER'S OWN STEP SIZE ───────────────────────────────────────────
// The arc runs every build-mode frame, so SOLVE_DT is a cost/accuracy trade.
// This is the check that 1/120 is not overkill (or, worse, not enough).
console.log("\n=== 3. INTEGRATION STEP — is SOLVE_DT justified? ===");
console.log("   range at each step size vs a 1/2000 s reference\n");
console.log("  ramp  speed      1/30       1/60      1/120      1/480    |  ref 1/2000");
{
  // Re-solve with an overridden step by scaling the whole problem is not
  // possible through the public API, so integrate here with the same scheme.
  const rangeAt = (connector, speed, dt) => {
    const e = connector.elements;
    const from = new THREE.Vector3().setFromMatrixPosition(connector);
    const dir = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
    const p = from.clone(), v = dir.clone().multiplyScalar(speed), prev = p.clone();
    for (let t = 0; t < 12; t += dt) {
      prev.copy(p);
      const k = DRAG_K * v.length() * dt;
      v.x -= v.x * k; v.y -= v.y * k + GRAVITY * dt; v.z -= v.z * k;
      p.addScaledVector(v, dt);
      if (prev.y > from.y && p.y <= from.y) {
        const a = (prev.y - from.y) / (prev.y - p.y);
        const q = prev.clone().lerp(p, a);
        return Math.hypot(q.x - from.x, q.z - from.z);
      }
    }
    return NaN;
  };
  for (const jumpAngle of [12, 28]) {
    const { connector } = buildRamp(jumpAngle);
    for (const refSpeed of [25, 40, 50]) {
      const ref = rangeAt(connector, refSpeed, 1 / 2000);
      const cols = [30, 60, 120, 480]
        .map((n) => f(rangeAt(connector, refSpeed, 1 / n) - ref, 9, 3))
        .join(" ");
      console.log(`  ${String(jumpAngle).padStart(3)}°  ${String(refSpeed).padStart(3)}   ${cols}  |  ${f(ref, 8)} m`);
    }
  }
  console.log("\n  (columns are metres of error against the reference)");
}
