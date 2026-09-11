// Does the inverted launcher come from wheels hitting the BACK of a face?
//
// ANSWER: NO. MEASURED 2026-09-12 — do not spend time on this idea again.
// A normal pointing away from the car turns up on 50-57% of contacts in EVERY
// case, including a flat upright landing (56.8%) and a clean loop (51.1%), as
// well as the launching ones. The raw triangle normal is a coin flip, which is
// exactly why Tire.apply negates it rather than trusting it, and it carries no
// signal that separates a launch from normal driving. The launcher has to be
// found somewhere else.
//
// Tire.apply does `if (this._rawNormal.dot(this._up) < 0) this._rawNormal.negate()`
// — it forces the contact normal to face the car's up axis. That throws away the
// one fact that says "this wheel is behind the surface, not on it". Measure how
// often the raw normal is actually facing away, during a launch and during a
// loop, and see whether the two are separable.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.flipProbe.${process.pid}.mjs`);
let src = readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};");

const NEG = "    if (this._rawNormal.dot(this._up) < 0) this._rawNormal.negate();";
if (!src.includes(NEG)) throw new Error("negation site not found");
src = src.replace(NEG,
  "    globalThis.__flip && globalThis.__flip(this.name, this._rawNormal.dot(this._up), this._up.y);\n" + NEG);
writeFileSync(TMP, src);

const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
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

function bake(geos) {
  const b = new RoadBvh();
  const ms = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  for (const m of ms) m.updateMatrixWorld(true);
  b.bakeFromMeshes(ms);
  return b.baked ? b : null;
}

function straightTrack(n) {
  let conn = new THREE.Matrix4();
  const geos = [];
  for (let i = 0; i < n; i++) {
    const p = buildPiece("straight", conn);
    const g = p.geometry.clone(); g.applyMatrix4(p.world); geos.push(g);
    conn = p.connectorOut;
  }
  return bake(geos);
}

function loopTrack() {
  let conn = new THREE.Matrix4();
  const geos = [];
  const push = (p) => {
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      const c = g.clone(); c.applyMatrix4(p.world); geos.push(c);
    }
  };
  for (let i = 0; i < 8; i++) { const p = buildPiece("straight", conn); push(p); conn = p.connectorOut; }
  push(buildPiece("loop", conn));
  return bake(geos);
}

function makeCar(deck) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.setBvh(deck, null);
  c.getFloorY = () => -50;
  c.enabled = true;
  return c;
}

function tally(label, setup, ticks, throttle) {
  let facing = 0, away = 0, awayUprightish = 0;
  globalThis.__flip = (_n, dot, upY) => {
    if (dot < 0) { away++; if (upY > 0.5) awayUprightish++; } else facing++;
  };
  const car = setup();
  let peak = 0;
  const v0 = car.body.vel.length();
  for (let i = 0; i < ticks; i++) {
    car.tick({ steerTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    peak = Math.max(peak, car.body.vel.length());
  }
  globalThis.__flip = null;
  const tot = facing + away;
  console.log(`${label.padEnd(30)} contacts ${String(tot).padStart(6)}`
    + `   facing ${String(facing).padStart(6)}   AWAY ${String(away).padStart(6)}`
    + ` (${tot ? ((away / tot) * 100).toFixed(1) : "0.0"}%)`
    + `   of those, car upright: ${awayUprightish}`
    + `   peak |v| ${peak.toFixed(0)} (in ${v0.toFixed(0)})`);
}

const flat = straightTrack(14);
const loop = loopTrack();

console.log("A raw contact normal pointing AWAY from the car's up axis means the");
console.log("wheel is behind the surface, not on it. Tire.apply negates it.\n");

for (const roll of [0, 90, 110, 135, 160, 180]) {
  tally(`inverted landing, roll ${roll}°`, () => {
    const c = makeCar(flat);
    c.body.pos.set(0, 1.3, -20);
    c.body.vel.set(0, -0.1, -22);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (roll * Math.PI) / 180);
    return c;
  }, 120, 0);
}
console.log("");
for (const v0 of [35, 45, 55]) {
  tally(`LOOP at ${(v0 * 3.6).toFixed(0)} km/h`, () => {
    const c = makeCar(loop);
    c.body.pos.set(0, 0.65, -4);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, 0, -v0);
    return c;
  }, Math.round(8 / FIXED_DT), 1);
}
