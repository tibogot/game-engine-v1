// node games/thunderline/proto/kit/landingTest.mjs
// LANDINGS (DESIGN.md §6 "land flat, keep your speed"): does the physics alone reward a clean landing?
// The real car flies every jump of the test track three ways — the autopilot lining up with the
// landing ("aligned"), no air input ("hands off"), and a held nose-up mistake ("crooked") — and each
// touchdown after ≥ 0.8 s of air reports the attitude error and the speed kept.
//
// (setup below copied from ghostTest.mjs)
// P5 (DESIGN.md §9): can a ghost be just the INPUTS? The real car (old physics, top 63, 3 substeps,
// boost pads) drives the test track under the autopilot while every tick's input is recorded; then a
// fresh car replays only those inputs. Deterministic physics → every tick matches bit for bit.
// Apex Rush's biggest complaint was physics that is NOT deterministic — this is the check that ours is.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { TILES, integrate, deckFrame, SECTIONS } from "./kit.js";
import { layoutTestTrack } from "./testTrack.js";
import { createAutopilot, wallCut } from "./autopilot.js";
import { applyCarTune } from "./carTune.js";
import { createLandingJudge } from "./landing.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

// the car, loaded the way tools/chassisCollisionTest.mjs does (strip the two GPU-only imports)
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.landingTest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TIRE, AERO, CHASSIS, WHEEL, SOLID, CRASH } = await import(pathToFileURL(TMP).href).finally(() => unlinkSync(TMP));
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);
const { buildSweepGeometry, buildProfile, ROAD_PARAM_DEFAULTS } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { buildRailCollision } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadRail.js")).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group();
  this.chassisMesh = new THREE.Object3D();
  this.tireGroups = this.tires.map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group();
  this.arrowGroup.visible = false;
  this.arrows = this.tires.map(() => ({}));
  this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

// ---- the same tune and track as drive.html ----
const TOP = 63;
applyCarTune({ TIRE, WHEEL, SOLID, CRASH });
const built = {};
for (const [id, t] of Object.entries(TILES)) built[id] = { b: integrate(t) };
const lay = layoutTestTrack({ built, speed: TOP * 0.91, jumpSpeeds: [55.8, 48.6, 50.6], airDrag: AERO.drag / CHASSIS.mass });
if (lay.warnings.length) { console.log("track warnings:", lay.warnings); process.exit(1); }

// collision, as drive.js: the old kit's sweep on the new paths (deck) + the rail collision proxy (solids)
const deckGeos = [], solidGeos = [];
for (const p of lay.placements) {
  const t = TILES[p.id];
  const hw = SECTIONS[t.section ?? "road"].hw;
  const rp = t.section === "wide" ? { ...ROAD_PARAM_DEFAULTS, width: hw * 2 } : ROAD_PARAM_DEFAULTS;
  const frames = [];
  let lastS = -1;
  for (const r of integrate(t, { maxGap: 2 }).rings) {
    if (r.s - lastS < 0.05) continue;
    lastS = r.s;
    const f = deckFrame(r, hw);
    frames.push({ pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R });
  }
  const deck = buildSweepGeometry(frames, buildProfile(rp, !p.open), {}).clone();
  deck.applyMatrix4(p.M);
  const mesh = new THREE.Mesh(deck, new THREE.MeshBasicMaterial());
  mesh.userData.roadHold = ["bank_in_22", "bank_out_22", "fast_turn_128"].includes(p.id.replace(/_L$/, ""));
  deckGeos.push(mesh);
  if (!p.open) {
    const rail = buildRailCollision(frames, rp);
    if (rail) { const g = rail.clone(); g.applyMatrix4(p.M); solidGeos.push(new THREE.Mesh(g, new THREE.MeshBasicMaterial())); }
  }
}
const bake = (meshes) => { for (const m of meshes) m.updateMatrixWorld(true); const b = new RoadBvh(); b.bakeFromMeshes(meshes); return b.baked ? b : null; };
const deckBvh = bake(deckGeos), solidsBvh = bake(solidGeos);
// through the same ground adapter the drive page uses (sky mode: no terrain), so Node and Chrome
// run the identical code path
const ground = createVehicleGround({ getTerrainHeight: () => NaN });
ground.setRoadBvh(deckBvh);
ground.setRoadSolidsBvh(solidsBvh);

const UPV = new THREE.Vector3(0, 1, 0);
function fly(mode) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.SUBSTEPS = 3;
  car.setBvh(ground.ground, ground.solids);
  car.getFloorY = () => NaN;
  car.setSolidCapsules([]);
  // as ghostTest: 12 m down the first piece
  const startPos = new THREE.Vector3().setFromMatrixPosition(lay.start), startFwd = new THREE.Vector3(0, 0, -1).transformDirection(lay.start);
  car.setSpawn(startPos.clone().addScaledVector(startFwd, 12).add(new THREE.Vector3(0, 0.6, 0)), new THREE.Quaternion().setFromAxisAngle(UPV, Math.atan2(startFwd.x, startFwd.z)));
  car.enabled = true; car.respawn();
  const pilot = createAutopilot(lay.ride);
  const judge = createLandingJudge(car);
  const out = [], nose = new THREE.Vector3();
  let boost = 0, vBefore = 0, lap = null;
  for (let tick = 0; tick < 120 * 150; tick++) {
    let inp = pilot.input(car);
    if (mode === "hands off") inp = { ...inp, yaw: 0, pitch: 0, rollTarget: 0 };
    if (mode === "crooked") inp = { ...inp, yaw: 0, rollTarget: 0, pitch: car.groundedCount === 0 && judge.air < 0.6 ? 1 : 0 };
    if (car.groundedCount === 0) vBefore = car.body.vel.length();
    car.tick(wallCut(car, inp));
    if (process.argv.includes("--trace") && mode === "aligned" && car.groundedCount === 0 && judge.air > 2.8 && out.length === 0 && tick % 6 === 0) {
      const a = pilot.airAim, d = (x) => ((x * 180) / Math.PI).toFixed(1);
      const r = lay.ride[a.at];
      console.log(`  t ${judge.air.toFixed(2)} aim ${a.at} ${r.air ? "air" : r.id} yawE ${d(a.yawE)} pitchE ${d(a.pitchE)} rollE ${d(a.rollE)} in p ${inp.pitch.toFixed(2)} r ${inp.rollTarget.toFixed(2)} y ${inp.yaw.toFixed(2)} T.y ${r.T.y.toFixed(2)} vel.y/|v| ${(car.body.vel.y / car.body.vel.length()).toFixed(2)}`);
    }
    const ev = judge.tick(FIXED_DT);
    if (ev) { boost = Math.max(boost, ev.boost); out.push({ ...ev, vBefore, t: tick }); }
    // the landing boost pushes like a boost pad (drive.js BOOST.accel 14 m/s²) while on the ground
    nose.set(0, 0, 1).applyQuaternion(car.body.quat);
    if (boost > 0 && car.groundedCount > 0) car.body.vel.addScaledVector(nose, 14 * FIXED_DT);
    boost = Math.max(0, boost - FIXED_DT);
    const v = car.body.vel.length();
    for (const q of out) if (tick === q.t + 120) q.v1 = v;
    if (pilot.idx >= lay.ride.length - 5) { lap = tick * FIXED_DT; break; }
    if (car.body.pos.y < -2000 || !Number.isFinite(car.body.pos.y)) { out.push({ fell: true, at: pilot.idx, of: lay.ride.length, t: tick * FIXED_DT }); break; }
  }
  return { out, lap };
}
for (const mode of ["aligned", "hands off", "crooked"]) {
  const { out, lap } = fly(mode);
  console.log(`\n${mode}: lap ${lap?.toFixed(1) ?? "—"} s`);
  for (const r of out) {
    if (r.fell) { console.log(`  FELL at ride ${r.at}/${r.of}, ${r.t.toFixed(1)} s`); continue; }
    const kmh = (x) => (x == null ? "  — " : String(Math.round(x * 3.6)).padStart(4));
    console.log(`  air ${r.air.toFixed(1)} s · ${r.err.toFixed(0).padStart(3)}° ${r.grade.padEnd(7)} · ${kmh(r.vBefore)} → ${kmh(r.v1)} km/h 1 s later`);
  }
}
