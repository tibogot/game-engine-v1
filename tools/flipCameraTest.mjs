// THE FLIP RAMP'S CAMERA — does the shot compose on the CLIMB, and hold still?
//
// The pivot is one 180° sweep of the boom around the car while it goes up the
// curl: roof, then side, then underside. Every part of that has broken at least
// once, and none of it is visible to `chaseFramingTest`, which drives the kit's
// ordinary pieces and never launches anything backwards. So it gets its own
// harness, driving the real ramp with the real vehicle and the real rig:
//
//   * it swept the wrong WAY round (both ends of the pivot lie in the same
//     vertical plane, so the azimuth picked a side on rounding)
//   * it was still HUNTING in the air — "before the landing it's like the
//     camera is moving and adapting and that's wrong"
//   * it ran at ~300°/s, the rig's own backstop, and blew through the side view
//     in a single instant — "it's going a bit fast […] the camera should stay a
//     bit more when it's at the side"
//
//   node tools/flipCameraTest.mjs
import * as THREE from "three";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
const { ModularRoadBuilder, CATEGORY_PRESETS } = await import(
  pathToFileURL(join(GAME, "modularRoadBuilder.js")).href);
const { createChaseCamera, CHASE_CAM: CAM } = await import(
  pathToFileURL(join(GAME, "chaseCamera.js")).href);

const TMP = join(ROOT, `.flipcam.${process.pid}.mjs`);
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

const START_HEIGHT = 70;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);

let fail = 0;
const check = (name, ok, note = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
};

/* ── THE RAMP, ON ITS OWN ─────────────────────────────────────────────────── */
// No return deck: this is about the climb and the first moments of the flight,
// and a deck only adds a surface for the car to land on mid-measurement.

function build() {
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
  const put = (id, n = 1) => {
    b.setActivePreset(tile(id));
    for (let i = 0; i < n; i++) b.place();
  };
  b.setSnap({ enabled: true, step: 8, yawDeg: 15 });
  b.beginNewChain(new THREE.Vector3(0, START_HEIGHT, 0), 0, { exact: true });
  b.setActivePiece("start"); b.place();
  put("straight_long", 2);
  put("flip_ramp");
  return b;
}

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

/* ── DRIVE IT, AND WATCH THE CAMERA ───────────────────────────────────────── */

const _up = new THREE.Vector3(0, 1, 0);

/**
 * Samples, every tick: how fast the VIEW is turning, and where the camera sits
 * around the car — as an azimuth in the frame the car entered on, which is the
 * pivot's own coordinate. 180° of it is the whole shot.
 */
function fly(speedIn) {
  const b = build();
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
    new THREE.Quaternion().setFromAxisAngle(_up, Math.PI));
  car.body.vel.copy(fwd).multiplyScalar(speedIn);

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const chase = createChaseCamera({ camera, vehicle: car });
  chase.snap?.();

  // The frame the pivot is expressed in, latched the same way the rig latches
  // it: the horizontal travel direction on the way in.
  const wallFwd = fwd.clone().setY(0).normalize();
  const side = new THREE.Vector3().crossVectors(_up, wallFwd).normalize();

  const view = new THREE.Vector3(), prevView = new THREE.Vector3();
  const rel = new THREE.Vector3(), carUp = new THREE.Vector3();
  let az = null, swept = 0, sideSign = 0;
  let peakRate = 0, dwell = 0, run = 0, airMotion = 0, airT = 0;
  let prevRate = 0, peakAccel = 0, peakAccelAt = null, sweepT = 0, wallFrames = 0;
  let peakNoseAccel = 0, peakNoseAt = 0, prevW = null;
  const _w = new THREE.Vector3();
  let climbing = false, launched = false, t = 0;

  for (let i = 0; i < Math.round(14 / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0, airSteer: 0 });
    // The rig follows the INTERPOLATED render pose, which the game advances in
    // its frame loop. Headless there is no frame loop, so it would sit at the
    // spawn point forever and the camera would simply be left behind — 96 m
    // behind, measured, with the shot never running at all.
    car._renderPos.copy(car.body.pos);
    car._renderQuat.copy(car.body.quat);
    chase.update(FIXED_DT);
    t += FIXED_DT;

    camera.getWorldDirection(view);
    carUp.set(0, 1, 0).applyQuaternion(car.body.quat);
    // Chassis forward is +Z, same axis the rig reads — see chaseCamera's _carFwd.
    const noseY = new THREE.Vector3(0, 0, 1).applyQuaternion(car.body.quat).y;
    // Same gate the rig uses, so "on the wall" here means what it means there.
    const onWall = car.groundedCount > 0 && !!car._holdContact && noseY > 0.5;

    if (i > 0) {
      const rate = prevView.angleTo(view) * R2D / FIXED_DT;
      if (onWall) {
        climbing = true;
        peakRate = Math.max(peakRate, rate);
        sweepT += FIXED_DT;
        wallFrames++;
        // The second derivative, which is what actually reads as brutal — a fast
        // steady sweep looks smooth, a small twitch does not. Same bound
        // chaseFramingTest holds the rest of the kit to.
        // From the SECOND frame of the climb: on the first there is no previous
        // rate to difference against, and taking one anyway reports the whole
        // rate as an acceleration — which is a property of the metric, not of
        // the camera, and it reads as a 10000°/s² spike that is not there.
        if (wallFrames > 1) {
          const acc = Math.abs(rate - prevRate) / FIXED_DT;
          if (acc > peakAccel) { peakAccel = acc; peakAccelAt = { t, swept }; }
        }
        // THE CAR'S OWN motion, from the rigid body's ANGULAR VELOCITY. The
        // camera aims at the car and builds its boom on the car's frame, so
        // anything the chassis does abruptly arrives in the shot no matter how
        // smooth the pivot itself is — which makes the chassis the right thing
        // to judge the camera against.
        //
        // NOT differentiated from asin(forward.y), which is the obvious way and
        // is wrong here. d(asin)/dy is unbounded as y approaches 1, and this ramp
        // takes the nose straight THROUGH vertical: measured, that read 26797°/s²
        // at the moment the body itself was doing 648, a 41x overstatement, and
        // the spike sat at nose 89° every single time. It was chased through the
        // segment joins, the road hold and the tessellation before the metric
        // itself turned out to be the thing with the discontinuity.
        if (prevW !== null) {
          const na = _w.copy(car.body.angVel).sub(prevW).length() / FIXED_DT * R2D;
          if (na > peakNoseAccel) { peakNoseAccel = na; peakNoseAt = swept; }
        }
        (prevW ??= new THREE.Vector3()).copy(car.body.angVel);
        prevRate = rate;
        // A dwell is a stretch of the CLIMB where the shot is simply held.
        // Only counted once the sweep is under way, so the flat approach to the
        // ramp — where nothing is turning either — cannot pass for one.
        if (swept > 30 && swept < 150 && rate < 25) { run += FIXED_DT; dwell = Math.max(dwell, run); }
        else run = 0;
      } else if (launched && airT < 0.6) { airMotion += prevView.angleTo(view) * R2D; airT += FIXED_DT; }
    }
    prevView.copy(view);

    if (onWall) {
      rel.copy(camera.position).sub(car.body.pos);
      const a = Math.atan2(rel.dot(side), rel.dot(wallFwd)) * R2D;
      if (az === null) az = a;
      else {
        let d = a - az;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        az = a; swept += Math.abs(d);
        if (Math.abs(swept - 90) < 45 && sideSign === 0) sideSign = Math.sign(rel.dot(side));
      }
    }
    if (process.env.DBG && i % 12 === 0 && car.body.pos.y > START_HEIGHT + 0.5) {
      console.log(`    t=${t.toFixed(2)} y=${(car.body.pos.y - START_HEIGHT).toFixed(1)}`
        + ` nose=${(Math.asin(Math.max(-1, Math.min(1, noseY))) * R2D).toFixed(0)}`
        + ` gnd=${car.groundedCount} hold=${car._holdContact ? 1 : 0} wall=${onWall ? 1 : 0}`
        + ` swept=${swept.toFixed(0)}`        + ` az=${az === null ? 'n/a' : az.toFixed(0)}`        + ` rel=${rel.dot(wallFwd).toFixed(1)}/${rel.dot(side).toFixed(1)}`);
    }
    if (climbing && !launched && car.groundedCount === 0) launched = true;
    if (launched && car.body.pos.y < START_HEIGHT - 20) break;
  }
  return { swept, peakRate, dwell, airMotion, sideSign, peakAccel, peakAccelAt, sweepT,
    peakNoseAccel, peakNoseAt };
}

/* ── CHECKS ───────────────────────────────────────────────────────────────── */

console.log("\nTHE FLIP RAMP'S CAMERA\n");
console.log(`  window nose ${CAM.pivotFromDeg}° -> ${CAM.pivotSideDeg}° (side) -> ${CAM.pivotToDeg}°`
  + `,  smoothing ${CAM.flipSmoothTime}s (vs ${CAM.boomSmoothTime}s normally)\n`);

const runs = [26, 32, 38].map((v) => ({ v, r: fly(v) }));
for (const { v, r } of runs) {
  console.log(`  in @${v} m/s   swept ${r.swept.toFixed(0)}° over ${r.sweepT.toFixed(2)}s `
    + `(avg ${(r.swept / r.sweepT).toFixed(0)}°/s, peak ${r.peakRate.toFixed(0)})   `
    + `holds the side ${r.dwell.toFixed(2)}s   `
    + `jerk ${r.peakAccel.toFixed(0)}°/s² @swept ${r.peakAccelAt?.swept.toFixed(0)}°`
    + ` [chassis ${r.peakNoseAccel.toFixed(0)}°/s²]   drifts ${r.airMotion.toFixed(1)}° in the air`);
}
console.log("");

const worstSwept = Math.min(...runs.map((x) => x.r.swept));
check("the camera goes all the way round the car — roof, side, underside",
  worstSwept > 140, `least ${worstSwept.toFixed(0)}° of azimuth swept`);

// AVERAGE, not peak. The ramp fixes the total: 180° of sweep over whatever the
// climb lasts, so the only real question is whether the shot uses all of that
// or crams it into part of it. The old window finished at nose 65° and used
// barely half the climb, which is what "it's going a bit fast" was.
const worstAvg = Math.max(...runs.map((x) => x.r.swept / x.r.sweepT));
check("the sweep is spread over the whole climb, not crammed into part of it",
  worstAvg < 160, `worst average ${worstAvg.toFixed(0)}°/s (the old window ran ~300)`);

const worstPeak = Math.max(...runs.map((x) => x.r.peakRate));
check("and it never reaches the rig's own backstop",
  worstPeak < CAM.boomMaxRate, `peak ${worstPeak.toFixed(0)}°/s (backstop ${CAM.boomMaxRate})`);

// AGAINST THE CAR, not against a fixed number. `chaseFramingTest` holds the
// rest of the kit to 1200°/s² of view acceleration, and that is the right bar
// there because on those pieces the chassis is not being thrown around. Here it
// is: the body's own angular acceleration runs 4800-6400°/s² through the curl,
// two to three times anything the camera shows. A rig that aims AT the car and
// builds its boom on the car's frame cannot be smoother than the car without
// lagging it, so the thing worth asserting is that the camera SMOOTHS that
// rather than amplifying it.
//
// An earlier version claimed 15800-28378°/s² and a 7-13x ratio. That was a
// broken metric, not a rough car — see the note at the measurement above.
const worstAccel = Math.max(...runs.map((x) => x.r.peakAccel));
const ratios = runs.map((x) => x.r.peakNoseAccel / Math.max(1, x.r.peakAccel));
check("the camera smooths the ramp rather than passing it on",
  Math.min(...ratios) > 1.8,
  `camera ${worstAccel.toFixed(0)}°/s² against the chassis' own `
  + `${Math.max(...runs.map((x) => x.r.peakNoseAccel)).toFixed(0)}°/s² `
  + `— ${Math.min(...ratios).toFixed(0)}x smoother at worst`);

const worstDwell = Math.min(...runs.map((x) => x.r.dwell));
// It shrinks with entry speed, because it IS the straight face: enter faster
// and the car is on that face for less time. That is the right behaviour — the
// hold belongs to the ramp — so the bar is what still reads as a held shot at
// the top of the speed range, not a fixed duration at every speed.
check("IT HOLDS THE SIDE VIEW instead of blowing through it",
  worstDwell > 0.12,
  `shortest hold ${worstDwell.toFixed(2)}s — the straight face, which is where the nose angle stops`);

const worstAir = Math.max(...runs.map((x) => x.r.airMotion));
check("and it is FINISHED by the top: the shot does not hunt on the way to the deck",
  worstAir < 12, `worst ${worstAir.toFixed(1)}° of drift in the first 0.6s of flight`);

const sides = runs.map((x) => x.r.sideSign);
check("it always goes round the SAME side, at every entry speed",
  sides.every((s) => s !== 0 && s === sides[0]),
  `sides ${sides.join(", ")} (sign of camera·side at the midpoint)`);

// The dwell is the ramp's, not the camera's: it exists because the face is
// straight, so if anyone unhitches the pivot's midpoint from the face angle it
// silently goes away and the sweep goes back to being an instant.
const KIT = await import(pathToFileURL(join(GAME, "modularRoadKit.js")).href);
check("the pivot's midpoint is still hinged on the ramp's straight face",
  CAM.pivotSideDeg === KIT.PIECE_PARAM_DEFAULTS.loopbackAngle,
  `camera ${CAM.pivotSideDeg}° vs ramp face ${KIT.PIECE_PARAM_DEFAULTS.loopbackAngle}°`);
check("and it still finishes before the lip, with room to settle",
  CAM.pivotToDeg < KIT.PIECE_PARAM_DEFAULTS.loopbackExit - 15,
  `ends at ${CAM.pivotToDeg}°, lip at ${KIT.PIECE_PARAM_DEFAULTS.loopbackExit}°`);

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall checks green\n");
process.exit(fail ? 1 : 0);
