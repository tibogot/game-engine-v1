/**
 * Jump lab lanes 2–3 used to launch STRAIGHT UP at the lip.
 *
 *   node tools/jumpLabLipTest.mjs
 *
 * Same geometry as the parkour Jump lab (12 × 22 m scoops, rises 4 / 7 / 10).
 * Collision is the game's split: deck proxy + solids proxy, not the visual wedge.
 * Launch angle must stay near the lip, not go vertical.
 */
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.jumplablip.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { jumpRampGeometry } =
  await import(new URL("../games/modular-road-v3/modularRoadParkour.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../v3/play/modularRoadBvh.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../v3/play/modularRoadGround.js", import.meta.url).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};
Vehicle.prototype._syncWheelInstances = function () {};

const W = 12, L = 22, R2D = 57.2958;
const lipDeg = (H) => Math.atan((H * Math.PI / 2) / L) * R2D;
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

function bake(geo) {
  const mesh = new THREE.Mesh(geo);
  mesh.updateMatrixWorld(true);
  const wrap = (g) => ({ geometry: g, matrixWorld: mesh.matrixWorld, updateMatrixWorld() {} });
  const d = new RoadBvh(); d.bakeFromMeshes([wrap(geo.userData.deckGeometry)]);
  const s = new RoadBvh(); s.bakeFromMeshes([wrap(geo.userData.solidGeometry)]);
  const g = createVehicleGround({ getTerrainHeight: () => 0 });
  g.setRoadBvh(d); g.setRoadSolidsBvh(s);
  return g;
}

function drive(H, speed = 24) {
  const geo = jumpRampGeometry(W, L, H, 32);
  check(`rise ${H} m has a solids stand-in`, !!geo.userData.solidGeometry);
  const ground = bake(geo);
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground.ground; c.solidsBvh = ground.solids;
  c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, WHEEL.radius + 0.18, 30);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -speed);

  let launch = null, wasG = true, peakY = -1e9;
  for (let i = 0; i < Math.round(5 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const p = c.body.pos, v = c.body.vel;
    peakY = Math.max(peakY, p.y);
    if (wasG && c.groundedCount === 0 && p.z < -L * 0.6 && !launch) {
      launch = Math.atan2(v.y, Math.hypot(v.x, v.z)) * R2D;
    }
    wasG = c.groundedCount > 0;
    if (p.z < -L - 40) break;
  }
  return { deg: launch ?? NaN, peakY, lip: lipDeg(H) };
}

console.log("=== Jump lab lanes — launch must follow the lip, not go vertical ===");
for (const H of [4, 7, 10, 14, 18]) {
  const r = drive(H);
  const extra = r.deg - r.lip;
  console.log(`  rise ${H} m  lip ${r.lip.toFixed(1)}°  launch ${r.deg.toFixed(1)}°  (Δ ${extra.toFixed(1)}°)  peak y ${r.peakY.toFixed(1)}`);
  check(`rise ${H} m is not a vertical pop`, Number.isFinite(r.deg) && r.deg < 55,
    `${r.deg.toFixed(1)}°`);
  check(`rise ${H} m stays near the lip angle`, Math.abs(r.deg - r.lip) < 12,
    `${r.deg.toFixed(1)}° vs ${r.lip.toFixed(1)}°`);
}

console.log(fail ? `\n${fail} check(s) failed` : "\nall green");
process.exit(fail ? 1 : 0);
