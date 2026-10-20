// node games/thunderline/proto/kit/trackRun.mjs <ids,comma,separated> [--speed=55] [--trace]
// The real car (carTune, carRules, the shared autopilot) drives a SEQUENCE OF PIECES laid end to end,
// starting at --speed m/s on the first one. Per piece: speed in / lowest / out, how far the car
// leaned off vertical (a tube wall), air time — and where it failed (fell, stopped, came out wrong).
// For calibrating new shapes at Thunderline's speed before they go in the builder (tubes first).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { TILES, integrate, ensureTile, socketMatrix, deckFrame, SECTIONS } from "./kit.js";
import { oldLookOf } from "./oldTiles.js";
import { createAutopilot } from "./autopilot.js";
import { applyCarTune } from "./carTune.js";
import { createCarRules, magnetZones } from "./carRules.js";
import { buildTubeLook, buildHalfpipeLook, closureAt, wallAt } from "./tubeLook.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const TMP = join(ROOT, `.trackRun.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TIRE, WHEEL, SOLID, CRASH } = await import(pathToFileURL(TMP).href).finally(() => unlinkSync(TMP));
export { Vehicle, FIXED_DT, SOLID, CRASH }; // wallTest.mjs drives this same module copy
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);
const { buildSweepGeometry, buildProfile, ROAD_PARAM_DEFAULTS, NO_CHECKER } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { buildRailCollision } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadRail.js")).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = this.tires.map(() => new THREE.Group()); this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = this.tires.map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};
applyCarTune({ TIRE, WHEEL, SOLID, CRASH });
const ts = process.argv.find((a) => a.startsWith("--tubesteer="));
if (ts) globalThis.__TUBE_STEER = Number(ts.slice(12));
const OPEN = process.argv.includes("--open"); // open edges: no rails
const NO_BRAKE = process.argv.includes("--nobrake");
const mm = process.argv.find((a) => a.startsWith("--mag=")); if (mm) globalThis.__MAG_MODE = mm.slice(6);
const pv = process.argv.find((a) => a.startsWith("--pivot=")); if (pv) TILES.twist_120.twistPivot = TILES.twist_120_L.twistPivot = Number(pv.slice(8));
const sp = process.argv.find((a) => a.startsWith("--spiral="));
if (sp) globalThis.__SPIRAL = Number(sp.slice(9));

const ROAD_HOLD = new Set(["bank_in_22", "bank_out_22", "fast_turn_128"]);

/** Lay `ids` end to end at height 200; collision as the drive page builds it. */
export function layout(ids) {
  const decks = [], solids = [], ride = [], spans = [];
  let M = new THREE.Matrix4().makeTranslation(0, 200, 0);
  ids.forEach((id, k) => {
    const t = ensureTile(id) ?? TILES[id];
    if (!t) throw new Error(`unknown piece ${id}`);
    const b = integrate(t);
    const hw = SECTIONS[t.section ?? "road"].hw;
    let deck, rail;
    if (t.tube || t.halfpipe) {
      const bb = integrate(t, { maxGap: 2 });
      const frames = [], sAt = [];
      let lastS = -1;
      for (const r of bb.rings) { if (r.s - lastS < 0.05) continue; lastS = r.s; const f = deckFrame(r, hw); frames.push({ pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R }); sAt.push(r.s); }
      ({ deck, rail } = { deck: (t.halfpipe ? buildHalfpipeLook : buildTubeLook)(t, frames, sAt, bb.L, { buildSweepGeometry, NO_CHECKER, THREE }).deck, rail: null });
    } else if (t.customLook) {
      const look = oldLookOf(t, true);
      deck = look.deckCollision; rail = look.railCollision;
    } else {
      // runs of road between gaps (a gap jump's hole has no road), as oldLook.js builds them
      const runs = [[]];
      for (const r of integrate(t, { maxGap: 2 }).rings) {
        if (r.air) { if (runs.at(-1).length) runs.push([]); continue; }
        const f = deckFrame(r, hw);
        runs.at(-1).push({ pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R });
      }
      const parts = runs.filter((r) => r.length >= 2);
      const merge = (gs) => (gs.length === 1 ? gs[0] : mergeGeometries(gs));
      const rp = t.section === "wide" ? { ...ROAD_PARAM_DEFAULTS, width: hw * 2 } : ROAD_PARAM_DEFAULTS;
      deck = merge(parts.map((r) => buildSweepGeometry(r, buildProfile(rp, !OPEN), {})));
      rail = OPEN ? null : merge(parts.map((r) => buildRailCollision(r, rp)));
    }
    const mesh = new THREE.Mesh(deck.clone().applyMatrix4(M), new THREE.MeshBasicMaterial());
    mesh.userData.roadHold = ROAD_HOLD.has(id.replace(/_L$/, "")) || !!t.roadHold;
    mesh.userData.freeCarve = !!t.freeCarve;
    decks.push(mesh);
    if (rail) solids.push(new THREE.Mesh(rail.clone().applyMatrix4(M), new THREE.MeshBasicMaterial()));
    const from = ride.length;
    for (const r of b.rings) { const f = deckFrame(r, hw); const Pr = r.pivot != null ? f.P.clone().addScaledVector(f.U, r.pivot) : f.P; ride.push({ P: Pr.applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M), piece: k, tube: t.tube ? closureAt(t, r.s, b.L) : t.halfpipe ? 0.5 * wallAt(t, r.s, b.L) : 0, air: !!r.air }); }
    spans.push({ id, from, to: ride.length - 1, M: M.clone() });
    M = M.clone().multiply(socketMatrix(b.exit));
  });
  const bake = (ms) => { for (const m of ms) m.updateMatrixWorld(true); const v = new RoadBvh(); v.bakeFromMeshes(ms); return v.baked ? v : null; };
  const ground = createVehicleGround({ getTerrainHeight: () => NaN });
  ground.setRoadBvh(bake(decks));
  ground.setRoadSolidsBvh(bake(solids));
  return { ground, ride, spans, magnets: magnetZones(spans.map((s) => ({ id: s.id, M: s.M })), TILES, integrate) };
}

export function run(ids, speed, { trace = false } = {}) {
  const { ground, ride, spans, magnets } = layout(ids);
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.SUBSTEPS = 3;
  car.setBvh(ground.ground, ground.solids);
  car.getFloorY = () => NaN;
  car.setSolidCapsules([]);
  const r0 = ride[0];
  car.setSpawn(r0.P.clone().addScaledVector(r0.U, 0.6).addScaledVector(r0.T, 4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(r0.T.x, r0.T.z)));
  car.enabled = true; car.respawn();
  car.body.vel.copy(r0.T).multiplyScalar(speed);
  const pilot = createAutopilot(ride);
  const rules = createCarRules(car, { magnets });
  const per = spans.map((s) => ({ id: s.id, vin: null, vmin: Infinity, vout: null, tilt: 0, air: 0 }));
  const up = new THREE.Vector3();
  let lastSteer = 0;
  let result = "through", lowY = Math.min(...ride.map((r) => r.P.y)), slow = 0;
  for (let tick = 0; tick < 120 * 60; tick++) {
    const inp = pilot.input(car);
    if (NO_BRAKE) inp.throttle = 1; // --nobrake: a player who never lifts
    lastSteer = inp.steerTarget;
    rules.step(inp, FIXED_DT);
    const k = ride[pilot.idx].piece, s = per[k], v = car.body.vel.length();
    if (s.vin == null) s.vin = v;
    s.vmin = Math.min(s.vmin, v);
    s.vout = v;
    up.set(0, 1, 0).applyQuaternion(car.body.quat);
    s.tilt = Math.max(s.tilt, (Math.acos(THREE.MathUtils.clamp(up.y, -1, 1)) * 180) / Math.PI);
    if (car.groundedCount === 0) s.air += FIXED_DT;
    if (trace && tick % 12 === 0) { const r = ride[pilot.idx], R = new THREE.Vector3().crossVectors(r.T, r.U).normalize(); console.log(`t ${(tick * FIXED_DT).toFixed(2)} ${spans[k].id} v ${(v * 3.6).toFixed(0)} up.y ${up.y.toFixed(2)} g ${car.groundedCount} off-centre ${car.body.pos.clone().sub(r.P).dot(R).toFixed(1)} m steer ${lastSteer.toFixed(2)} heading ${((Math.atan2(car.body.vel.clone().dot(R), car.body.vel.dot(r.T)) * 180) / Math.PI).toFixed(1)}°`); }
    if (car.body.pos.y < lowY - 40) { result = `FELL in ${spans[k].id}`; break; }
    slow = v < 3 ? slow + FIXED_DT : 0;
    if (slow > 2) { result = `STOPPED in ${spans[k].id}`; break; }
    if (pilot.idx >= ride.length - 3) break;
  }
  return { result, per };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ids = (process.argv[2] ?? "").split(",").filter(Boolean);
  const speeds = (process.argv.find((a) => a.startsWith("--speed="))?.slice(8) ?? "55").split(",").map(Number);
  for (const sp of speeds) {
    const { result, per } = run(ids, sp, { trace: process.argv.includes("--trace") });
    console.log(`\nstart ${Math.round(sp * 3.6)} km/h → ${result}`);
    for (const p of per) {
      if (p.vin == null) { console.log(`  ${p.id.padEnd(16)} (not reached)`); continue; }
      const kmh = (x) => String(Math.round(x * 3.6)).padStart(4);
      console.log(`  ${p.id.padEnd(16)} in ${kmh(p.vin)}  low ${kmh(p.vmin)}  out ${kmh(p.vout)} km/h · tilt ${String(Math.round(p.tilt)).padStart(3)}° · air ${p.air.toFixed(1)} s`);
    }
  }
}
