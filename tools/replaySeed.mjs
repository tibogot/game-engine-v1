// REPLAY A CAR STATE CAPTURED FROM THE RUNNING GAME, on the real track.
//
// The game's yaw-snap watcher prints a line like:
//     REPLAY [x,y,z, qx,qy,qz,qw, vx,vy,vz, wx,wy,wz]
// Paste it as the argument:
//     node tools/replaySeed.mjs "[0.1,40.6,-251.2, 0,1,0,0, 0,0,-35, 0,-0.01,0]"
//
// WHY THIS EXISTS. The vehicle driven over jump-debug.json headlessly is
// directionally STABLE — a yaw poke of 0.01, 0.05, even 0.2 rad/s decays to
// zero, coasting or on throttle, with or without syncVisuals, and the live
// tuning has been confirmed identical to the defaults. Yet the running game
// diverges exponentially from the same code and the same numbers.
//
// Every reproduction I built starts the car from a pose *I* chose. This starts
// it from the pose the GAME was actually in. If it diverges here, the cause is
// in the vehicle and I can bisect it; if it does not, the cause is something the
// game does to the car between ticks, and that is a different search.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import * as THREE from "three";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const R2D = 57.2958;

const raw = process.argv[2];
if (!raw) {
  console.error("usage: node tools/replaySeed.mjs \"[x,y,z, qx,qy,qz,qw, vx,vy,vz, wx,wy,wz]\"");
  console.error("       (copy the REPLAY [...] line the game prints on a yaw snap)");
  process.exit(1);
}
const s = JSON.parse(raw.replace(/^REPLAY\s*/, ""));
if (s.length !== 13) { console.error("expected 13 numbers, got " + s.length); process.exit(1); }

const VT = join(ROOT, `.rs.${process.pid}.mjs`);
writeFileSync(VT, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(VT).href);
unlinkSync(VT);
const { ModularRoadBuilder } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
const { roadParams, guardrailParams, pieceParams } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { importTrack } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadTrackIO.js")).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const scene = new THREE.Scene();
const mat = () => new THREE.MeshBasicMaterial();
const builder = new ModularRoadBuilder({
  scene, material: mat(), railMaterial: mat(), shellMaterial: mat(), decorMaterial: mat(),
  isBuildMode: () => true,
});
const data = JSON.parse(readFileSync(join(ROOT, "games/modular-road-v3/jump-debug.json"), "utf8"));
const stub = { exportInstances: () => [], importInstances: () => {}, clear() {}, instances: [] };
importTrack(data, {
  builder, props: stub, movers: stub,
  portals: { exportLayout: () => ({}), importLayout: () => {}, clear() {}, params: {} },
  roadParams, guardrailParams, pieceParams, portalParams: {},
});
scene.updateMatrixWorld(true);
const deck = new RoadBvh(); const sol = new RoadBvh();
deck.bakeFromMeshes(builder.pieces.map((p) => p.mesh).filter((m) => m && !m.userData.noCollision));
const sm = [];
for (const p of builder.pieces) { if (p.railMesh) sm.push(p.railMesh); if (p.shellMesh) sm.push(p.shellMesh); }
if (sm.length) sol.bakeFromMeshes(sm);
const g = createVehicleGround({ getTerrainHeight: () => -1000 });
g.setRoadBvh(deck); g.setRoadSolidsBvh(sol.baked ? sol : null);

const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
c.setBvh(g.ground, g.solids);
c.enabled = true;
c.body.pos.set(s[0], s[1], s[2]);
c.body.quat.set(s[3], s[4], s[5], s[6]).normalize();
c.body.vel.set(s[7], s[8], s[9]);
c.body.angVel.set(s[10], s[11], s[12]);
c._resetInterpolation();

const _u = new THREE.Vector3(); const _f = new THREE.Vector3(); const _r = new THREE.Vector3();
console.log("Replaying the captured state on jump-debug.json, NO input at all.\n");
console.log("     t       z       x   tilt  yaw(car)   roll   latVel   slip   spd  gr solid");
let peak = 0;
for (let i = 0; i < 8 / FIXED_DT; i++) {
  c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  c.syncVisuals(FIXED_DT, 1);
  _u.set(0, 1, 0).applyQuaternion(c.body.quat);
  _f.set(0, 0, 1).applyQuaternion(c.body.quat);
  _r.crossVectors(_u, _f);
  const yaw = c.body.angVel.dot(_u);
  peak = Math.max(peak, Math.abs(yaw));
  if (i % 30 === 0) {
    const b = c.body;
    console.log(
      `  ${(i * FIXED_DT).toFixed(2).padStart(5)} ${b.pos.z.toFixed(1).padStart(8)} ${b.pos.x.toFixed(1).padStart(7)}`
      + ` ${(Math.acos(Math.max(-1, Math.min(1, _u.y))) * R2D).toFixed(0).padStart(5)}°`
      + ` ${yaw.toFixed(2).padStart(8)} ${b.angVel.dot(_f).toFixed(2).padStart(6)}`
      + ` ${b.vel.dot(_r).toFixed(1).padStart(7)} ${(c.slipAngle * R2D).toFixed(0).padStart(6)}°`
      + ` ${Math.hypot(b.vel.x, b.vel.z).toFixed(0).padStart(5)}  ${c.groundedCount}   ${c.hitSolid ? 1 : 0}`,
    );
  }
  if (c.body.pos.y < 35) { console.log("  (left the road)"); break; }
}
console.log(`\n  peak yaw about the car's own up-axis: ${peak.toFixed(3)} rad/s`);
console.log(peak > 1.0
  ? "  DIVERGED — the cause is in the vehicle, and this seed reproduces it."
  : "  stayed stable — the cause is NOT in the vehicle stepping from this state.");
