// Turning ON a parkour ramp must not hit an invisible wall.
//
// The visual sides are vertical faces up to the deck. If those go in the
// solids tree, the chassis hull (which sits ~16 cm above the tyres) drives
// into them the moment you yaw toward the edge — sparks, a shove back onto
// the piece. Slope lab does it at the entry; Jump lab in the middle of the
// scoop. Same wall.
//
//   node tools/rampTurnOffTest.mjs
import { registerHeadlessThree } from "./headlessThreeHooks.mjs";
registerHeadlessThree();

const THREE = await import("three");
const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
const { fileURLToPath, pathToFileURL } = await import("node:url");
const { dirname, join } = await import("node:path");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.rampTurnOff.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const parkour = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadParkour.js")).href);

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

let fails = 0;
const ok = (cond, msg, extra = "") => {
  if (!cond) fails++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${extra ? `  — ${extra}` : ""}`);
};

function split(group) {
  group.updateMatrixWorld(true);
  const deck = [], solids = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    const d = o.geometry?.userData?.deckGeometry;
    deck.push(d ? { geometry: d, matrixWorld: o.matrixWorld, updateMatrixWorld() {} } : o);
    const s = o.geometry?.userData?.solidGeometry;
    solids.push(s ? { geometry: s, matrixWorld: o.matrixWorld, updateMatrixWorld() {} } : o);
  });
  return { deck, solids };
}

function bake(meshes, ground) {
  const bvh = new RoadBvh();
  const all = meshes.slice();
  if (ground) {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial(),
    );
    g.updateMatrixWorld(true);
    all.push(g);
  }
  bvh.bakeFromMeshes(all);
  return bvh.baked ? bvh : null;
}

function driveOffSide({ deck, solids, x, z0, speed, steerAt, secs = 6 }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  car.body.pos.set(x, WHEEL.radius + 0.18, z0);
  car.body.vel.set(0, 0, -speed);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  let turning = false;
  let sparksOn = 0;
  let maxLat = 0;
  let firstN = null;
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    if (!turning && car.body.pos.y >= steerAt) turning = true;
    car.tick({
      steerTarget: turning ? 1 : 0,
      throttle: 1,
      handbrake: false,
      yaw: 0,
      pitch: 0,
    });
    const lat = Math.abs(car.body.pos.x - x);
    maxLat = Math.max(maxLat, lat);
    // Still over the 12 m ramp (half-width 6 m, hull ~1 m) and scraping.
    if (turning && lat < 6.5 && car.body.pos.y > 0.35 && car.hitSolid) {
      sparksOn++;
      if (!firstN) firstN = car.scrapeNormal.clone();
    }
    if (car.body.pos.y < -5) break;
  }
  return { maxLat, sparksOn, firstN, endY: car.body.pos.y };
}

function chargeSide({ solids, wallX, z, toward }) {
  const ground = bake([], true);
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(ground, solids);
  car.getFloorY = () => 0;
  car.enabled = true;
  car.body.pos.set(wallX + toward * 5, WHEEL.radius + 0.18, z);
  car.body.vel.set(-toward * 12, 0, 0);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), toward > 0 ? -Math.PI / 2 : Math.PI / 2);
  let hit = 0;
  let minDist = Infinity;
  for (let i = 0; i < Math.round(2 / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (car.hitSolid) hit++;
    minDist = Math.min(minDist, Math.abs(car.body.pos.x - wallX));
  }
  return { hit, minDist, endX: car.body.pos.x };
}

for (const [label, build, steerAt, lane] of [
  ["Slope lab (turn at the entry)", parkour.buildSlopeLabGroup, 0.6, 2],
  ["Jump lab (turn in the middle)", parkour.buildJumpLabGroup, 4.0, 2],
]) {
  const group = build();
  const { deck: deckM, solids: solidM } = split(group);
  ok(solidM.every((m) => m.geometry), `${label}: every ramp has a solids stand-in`);
  const deck = bake(deckM, true);
  const solids = bake(solidM, false);
  const lanes = group.children.map((c) => c.position.x);
  const zNear = new THREE.Box3().setFromObject(group).max.z;
  const r = driveOffSide({
    deck, solids, x: lanes[lane], z0: zNear + 24, speed: 16, steerAt,
  });
  const n = r.firstN
    ? `(${r.firstN.x.toFixed(2)},${r.firstN.y.toFixed(2)},${r.firstN.z.toFixed(2)})`
    : "none";
  ok(r.maxLat > 7.5, `${label}: left over the side`,
    `maxLat ${r.maxLat.toFixed(2)} m, sparks-on-ramp ${r.sparksOn}, n ${n}`);
  ok(r.sparksOn < 30, `${label}: did not grind the cheek on the way off`,
    `${r.sparksOn} hull-solid ticks while still on the piece`);
}

{
  // A car on the GROUND still has to bounce off the side of a tall ramp.
  const geo = parkour.jumpRampGeometry(12, 22, 10, 32);
  const mesh = new THREE.Mesh(geo);
  mesh.updateMatrixWorld(true);
  const solids = bake([{
    geometry: geo.userData.solidGeometry,
    matrixWorld: mesh.matrixWorld,
    updateMatrixWorld() {},
  }], false);
  const r = chargeSide({ solids, wallX: 6, z: -12, toward: 1 });
  ok(r.hit > 5 && r.minDist > 0.4, "ground-level charge into a jump flank is still a wall",
    `hits ${r.hit}, closest ${r.minDist.toFixed(2)} m, end x ${r.endX.toFixed(2)}`);
}

console.log(fails ? `\n${fails} check(s) failed` : "\nall green");
process.exit(fails ? 1 : 0);
