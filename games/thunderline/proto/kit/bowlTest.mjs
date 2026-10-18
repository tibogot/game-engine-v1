// node games/thunderline/proto/kit/bowlTest.mjs
// Calibrate the FITTED BOWL at Thunderline's speeds with the real car (top 63, 3 substeps). For each
// radius × arrival speed: does the car leave the lip, how high does it go, and where does it come
// back down? "back" = it re-entered the same face (the park-bowl trick, the old note's 0.5–0.75 ×
// v²/2g rule), "over" = it flew past the ramp, "stall" = never left the lip.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { TILES, integrate, ensureTile, socketMatrix } from "./kit.js";
import { oldLookOf, BOWL_LANE } from "./oldTiles.js";
import { createAutopilot, wallCut } from "./autopilot.js";
import { applyCarTune } from "./carTune.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.bowlTest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, TIRE, WHEEL } = await import(pathToFileURL(TMP).href).finally(() => unlinkSync(TMP));
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);
const { buildSweepGeometry, buildProfile, ROAD_PARAM_DEFAULTS } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { deckFrame, SECTIONS } = await import("./kit.js");

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = this.tires.map(() => new THREE.Group()); this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = this.tires.map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};
applyCarTune({ TIRE, WHEEL }); // the drive page's car (carTune.js)

/** A run-up of new-kit straights, then the bowl. Returns the ground adapter + the lip height. */
function buildRun(R, hand = "") {
  const deckMeshes = [], solidMeshes = [], ride = [];
  let M = new THREE.Matrix4().makeTranslation(0, 100, 0);
  const add = (id) => {
    const t = ensureTile(id) ?? TILES[id];
    const b = integrate(t);
    if (t.customLook) {
      const look = oldLookOf(t, true);
      const d = look.deckCollision.clone().applyMatrix4(M);
      const mesh = new THREE.Mesh(d, new THREE.MeshBasicMaterial());
      mesh.userData.freeCarve = !!t.freeCarve;
      mesh.userData.roadHold = !!t.roadHold;
      deckMeshes.push(mesh);
      if (look.railCollision) solidMeshes.push(new THREE.Mesh(look.railCollision.clone().applyMatrix4(M), new THREE.MeshBasicMaterial()));
    } else {
      const hw = SECTIONS.road.hw;
      const frames = b.rings.map((r) => { const f = deckFrame(r, hw); return { pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R }; });
      const deck = buildSweepGeometry(frames, buildProfile(ROAD_PARAM_DEFAULTS, true), {}).clone().applyMatrix4(M);
      deckMeshes.push(new THREE.Mesh(deck, new THREE.MeshBasicMaterial()));
    }
    const hw = SECTIONS.road.hw;
    for (const r of b.rings) { const f = deckFrame(r, hw); ride.push({ P: f.P.clone().applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M) }); }
    const entry = M.clone();
    M = M.clone().multiply(socketMatrix(b.exit));
    return { entry, b };
  };
  add("straight_64"); add("straight_64"); add("straight_64");
  const bowl = add(`bowl_${R}${hand}`);
  add("straight_64"); add("straight_64"); add("straight_64"); // the return lane
  const bake = (ms) => { for (const m of ms) m.updateMatrixWorld(true); const v = new RoadBvh(); v.bakeFromMeshes(ms); return v.baked ? v : null; };
  const ground = createVehicleGround({ getTerrainHeight: () => NaN });
  ground.setRoadBvh(bake(deckMeshes));
  ground.setRoadSolidsBvh(bake(solidMeshes));
  const lipY = Math.max(...bowl.b.rings.map((r) => r.p.clone().applyMatrix4(bowl.entry).y));
  const baseY = new THREE.Vector3().setFromMatrixPosition(bowl.entry).y;
  return { ground, lipY, baseY, bowlEntry: bowl.entry, ride };
}

function run(R, speed, hand = "") {
  const { ground, lipY, baseY, bowlEntry, ride } = buildRun(R, hand);
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.SUBSTEPS = 3;
  car.setBvh(ground.ground, ground.solids);
  car.getFloorY = () => NaN;
  car.setSolidCapsules([]);
  // start 30 m before the bowl at `speed`, heading down the run (−Z); the shared autopilot drives
  const start = new THREE.Vector3().setFromMatrixPosition(bowlEntry).add(new THREE.Vector3(0, 0.6, 30));
  car.setSpawn(start, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  car.enabled = true; car.respawn();
  car.body.vel.set(0, 0, -speed);
  const pilot = createAutopilot(ride);
  const laneX = start.x + (hand ? -1 : 1) * BOWL_LANE;
  let peak = -Infinity, left = false, airTime = 0, verdict = "stall", landed = false, out = null;
  for (let i = 0; i < 120 * 25; i++) {
    let input = pilot.input(car);
    if (!WALL_CUT) input = { ...input, throttle: input.throttle < 0 ? input.throttle : 1 };
    if (!SPIN) input = { ...input, yaw: 0 };
    car.tick(input);
    const p = car.body.pos;
    if (TRACE && i % 30 === 0) console.log(`t ${(i * FIXED_DT).toFixed(2)} y ${(p.y - lipY).toFixed(1)} z ${(p.z - start.z).toFixed(1)} x ${(p.x - start.x).toFixed(1)} v ${car.body.vel.length().toFixed(1)} g ${car.groundedCount} yaw ${input.yaw} roll ${input.rollTarget} thr ${input.throttle}`);
    peak = Math.max(peak, p.y);
    if (!left && car.groundedCount === 0 && p.y > lipY - 2) left = true;
    if (left && car.groundedCount === 0) airTime += FIXED_DT;
    if (left && car.groundedCount >= 2 && airTime > 0.3) { landed = true; verdict = "back"; }
    // out: back past the start line, heading +Z — in the return lane?
    if (landed && p.z > start.z) {
      const fwd = car.body.vel.z > 0;
      out = { dx: p.x - laneX, v: car.body.vel.length(), fwd };
      verdict = !fwd ? "fakie" : Math.abs(p.x - laneX) < SECTIONS.road.hw - 1 ? "lane" : "off-lane";
      break;
    }
    if (p.y < baseY - 30) { verdict = left ? "over" : "fell"; break; }
  }
  return { verdict, peakOverLip: peak - lipY, airTime, out };
}

const PROBE = process.argv.find((a) => a.startsWith("--lipprobe="))?.slice(11);
if (PROBE) {
  // the real car up 4 straights from a standstill into PROBE: every wheels-up moment, speed + direction
  const deckMeshes = [], solidMeshes = [], ride = [];
  let M = new THREE.Matrix4().makeTranslation(0, 120, 0);
  for (const id of ["straight_64", "straight_64", "straight_64", "straight_64", PROBE]) {
    const t = ensureTile(id) ?? TILES[id], b = integrate(t);
    const look = t.customLook ? oldLookOf(t, true) : null;
    const hw = SECTIONS.road.hw;
    const frames = b.rings.map((r) => { const f = deckFrame(r, hw); return { pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R }; });
    const deck = look ? look.deckCollision : buildSweepGeometry(frames, buildProfile(ROAD_PARAM_DEFAULTS, true), {});
    const mesh = new THREE.Mesh(deck.clone().applyMatrix4(M), new THREE.MeshBasicMaterial());
    mesh.userData.roadHold = !!t.roadHold; mesh.userData.freeCarve = !!t.freeCarve;
    deckMeshes.push(mesh);
    if (look?.railCollision) solidMeshes.push(new THREE.Mesh(look.railCollision.clone().applyMatrix4(M), new THREE.MeshBasicMaterial()));
    for (const r of b.rings) { const f = deckFrame(r, hw); ride.push({ P: f.P.clone().applyMatrix4(M), T: r.T.clone().transformDirection(M), U: f.U.clone().transformDirection(M) }); }
    M = M.clone().multiply(socketMatrix(b.exit));
  }
  const bake = (ms) => { for (const m of ms) m.updateMatrixWorld(true); const v = new RoadBvh(); v.bakeFromMeshes(ms); return v.baked ? v : null; };
  const ground = createVehicleGround({ getTerrainHeight: () => NaN });
  ground.setRoadBvh(bake(deckMeshes)); ground.setRoadSolidsBvh(bake(solidMeshes));
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.SUBSTEPS = 3; car.setBvh(ground.ground, ground.solids); car.getFloorY = () => NaN; car.setSolidCapsules([]);
  car.setSpawn(new THREE.Vector3(0, 120.6, -12), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
  car.enabled = true; car.respawn();
  const pilot = createAutopilot(ride);
  let was = true;
  for (let i = 0; i < 120 * 14; i++) {
    const inp = pilot.input(car);
    if (car.body.pos.z < -255 && i % 6 === 0 && car.body.pos.y < 142) console.log(`    in: thr ${inp.throttle} steer ${inp.steerTarget.toFixed(2)} pitch ${inp.pitch} roll ${inp.rollTarget} yaw ${inp.yaw} g ${car.groundedCount} v ${Math.round(car.body.vel.length() * 3.6)}`);
    car.tick(inp);
    const g = car.groundedCount > 0;
    if (was && !g && i > 10) console.log(`t ${(i * FIXED_DT).toFixed(2)} UP pos ${car.body.pos.toArray().map((x) => x.toFixed(1))} vel ${car.body.vel.toArray().map((x) => x.toFixed(1))} ${Math.round(car.body.vel.length() * 3.6)} km/h`);
    if (i % 60 === 0 && car.body.pos.z < -240) console.log(`  t ${(i * FIXED_DT).toFixed(2)} z ${car.body.pos.z.toFixed(1)} y ${car.body.pos.y.toFixed(1)} ${Math.round(car.body.vel.length() * 3.6)} km/h g ${car.groundedCount}`);
    was = g;
  }
  process.exit(0);
}
const SPIN = !process.argv.includes("--nospin");
const TRACE = process.argv.includes("--trace");
const WALL_CUT = !process.argv.includes("--walldrive");
const HAND = process.argv.includes("--left") ? "_L" : "";
console.log(`${WALL_CUT ? "engine cut up walls (Thunderline rule)" : "old car: engine drives up walls"} · ${SPIN ? "air 180" : "no spin"} · return lane ${HAND ? "left" : "right"}`);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const radii = (args[0] ?? "90,100,110,120,130,140").split(",").map(Number);
const speeds = (args[1] ?? "44,48,52,56,60").split(",").map(Number);
console.log("cell = result · air time · apex above the lip · exit speed   (lane = out forward in the return lane)");
console.log("R \ v(m/s)  " + speeds.map((v) => String(v).padStart(30)).join(""));
for (const R of radii) {
  const row = speeds.map((v) => {
    const r = run(R, v, HAND);
    const tail = r.out ? ` ${Math.round(r.out.v * 3.6)}km/h` : "";
    return `${r.verdict} ${r.airTime.toFixed(1)}s ${Math.round(r.peakOverLip)}m${tail}`.padStart(30);
  });
  console.log(`R ${String(R).padEnd(10)}` + row.join(""));
}
console.log("\nv²/2g at those speeds:", speeds.map((v) => `${v}:${Math.round((v * v) / 19.62)}m`).join(" "));
