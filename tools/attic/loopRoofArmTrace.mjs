// Which DECK_CONTACT sample actually arms ROOF._roofGuard while driving a loop?
//
// Instruments the REAL arming sites by patching a temporary copy of the vehicle
// module, rather than re-implementing the condition (which is how the first
// attempt at this missed the answer).
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.loopArmTrace.${process.pid}.mjs`);
let src = readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};");

const LOG = `globalThis.__armLog && globalThis.__armLog(SITE, corner, this._deckN, this._deckUp, this._cWorld, this.body.pos);`;

// Approach site.
const a = "            if (ROOF.enabled && isRoofSample && this._deckN.y > ROOF.guardUpMin) {\r\n              this._roofGuard = ROOF.guardHold;";
const a2 = a.replace(/\r\n/g, "\n");
if (src.includes(a)) src = src.replace(a, a + "\r\n              " + LOG.replace("SITE", '"approach"'));
else if (src.includes(a2)) src = src.replace(a2, a2 + "\n              " + LOG.replace("SITE", '"approach"'));
else throw new Error("approach site not found");

// Contact site.
const b = "      if (isRoofSample) this._roofGuard = ROOF.guardHold;";
if (!src.includes(b)) throw new Error("contact site not found");
src = src.replace(b, "      if (isRoofSample) { this._roofGuard = ROOF.guardHold; "
  + LOG.replace("SITE", '"contact"') + " }");

writeFileSync(TMP, src);
const { Vehicle, FIXED_DT, ROOF } = await import(pathToFileURL(TMP).href);
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

let conn = new THREE.Matrix4();
const geos = [], railGeos = [];
const push = (p) => {
  for (const g of [p.geometry, p.shellGeometry]) {
    if (!g) continue;
    const c = g.clone(); c.applyMatrix4(p.world); geos.push(c);
  }
  if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); railGeos.push(r); }
};
for (let i = 0; i < 8; i++) { const p = buildPiece("straight", conn); push(p); conn = p.connectorOut; }
push(buildPiece("loop", conn));
const deck = new RoadBvh();
const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
for (const m of meshes) m.updateMatrixWorld(true);
deck.bakeFromMeshes(meshes);

const seen = new Map();
globalThis.__armLog = (site, corner, n, up, cw, pos) => {
  const key = `${site} corner(${corner.x.toFixed(2)},${corner.y.toFixed(2)},${corner.z.toFixed(2)})`;
  if (!seen.has(key)) {
    seen.set(key, {
      n: n.clone(), up: up.clone(), cw: cw.clone(), pos: pos.clone(), count: 0,
    });
  }
  seen.get(key).count++;
};

const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
const solids = new RoadBvh();
const rm = railGeos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
for (const m of rm) m.updateMatrixWorld(true);
solids.bakeFromMeshes(rm);
car.setBvh(deck, (process.argv[3] === "rails" && solids.baked) ? solids : null);
car.getFloorY = () => -50;
car.enabled = true;
car.body.pos.set(0, 0.65, -4);
car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
car.body.vel.set(0, 0, -(Number(process.argv[2]) || 55));

let maxY = 0;
for (let i = 0; i < Math.round(16 / FIXED_DT); i++) {
  car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
  maxY = Math.max(maxY, car.body.pos.y);

}
console.log(`ROOF.suspensionGuard ${ROOF.suspensionGuard}   car reached y ${maxY.toFixed(1)}\n`);
if (!seen.size) console.log("The guard was never armed.");
for (const [k, v] of seen) {
  console.log(`${k}  x${v.count}`);
  console.log(`   deck normal (${v.n.x.toFixed(2)}, ${v.n.y.toFixed(2)}, ${v.n.z.toFixed(2)})`
    + `   chassis-up (${v.up.x.toFixed(2)}, ${v.up.y.toFixed(2)}, ${v.up.z.toFixed(2)})`);
  console.log(`   sample world (${v.cw.x.toFixed(2)}, ${v.cw.y.toFixed(2)}, ${v.cw.z.toFixed(2)})`
    + `   car (${v.pos.x.toFixed(2)}, ${v.pos.y.toFixed(2)}, ${v.pos.z.toFixed(2)})`);
}
