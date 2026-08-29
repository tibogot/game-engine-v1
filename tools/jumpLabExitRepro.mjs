// Drive up a Jump lab ramp, then TURN to leave over the side.
//
// Reported: "instead of turning and leaving the jump it blocks the car on the
// jump, like there is an invisible guardrail on the side". The earlier edge
// sweep drove straight up the lanes with no steering and so never produced
// this at all — the car here approaches the flank from ON TOP, moving
// sideways, which is a different contact entirely.
//
// Prints where the car is when it stops moving sideways, and the normal of
// whatever it is touching, so the blocking surface can be named rather than
// guessed at.
import { registerHeadlessThree } from "./headlessThreeHooks.mjs";
registerHeadlessThree();

const THREE = await import("three");
const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
const { fileURLToPath, pathToFileURL } = await import("node:url");
const { dirname, join } = await import("node:path");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.jumpExit.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
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

const group = parkour.buildJumpLabGroup();
group.updateMatrixWorld(true);
const deckM = [], solidM = [];
group.traverse((o) => {
  if (!o.isMesh) return;
  const d = o.geometry?.userData?.deckGeometry;
  deckM.push(d ? { geometry: d, matrixWorld: o.matrixWorld, updateMatrixWorld() {} } : o);
  const s = o.geometry?.userData?.solidGeometry;
  solidM.push(s ? { geometry: s, matrixWorld: o.matrixWorld, updateMatrixWorld() {} } : o);
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial());
ground.updateMatrixWorld(true);
const bake = (m) => { const b = new RoadBvh(); b.bakeFromMeshes(m); return b.baked ? b : null; };
const deck = bake([...deckM, ground]);
const solids = bake(solidM);

const box = new THREE.Box3().setFromObject(group);
const lanes = group.children.map((c) => c.position.x);
const zNear = box.max.z;

const n = new THREE.Vector3();
const up = new THREE.Vector3();

/**
 * Climb the ramp, then steer hard to leave over the side.
 * @param steerAt height (m) at which the driver commits to the turn
 */
function exitOverSide({ lane, speed, steerAt, dir = 1, secs = 6 }) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  car.body.pos.set(lanes[lane], 0.55, zNear + 24);
  car.body.vel.set(0, 0, -speed);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  let turning = false;
  let blocked = 0, maxLateral = 0, solidTicks = 0;
  let firstBlockX = null, firstBlockY = null;
  const x0 = lanes[lane];
  for (let i = 0; i < Math.round(secs / FIXED_DT); i++) {
    if (!turning && car.body.pos.y >= steerAt) turning = true;
    car.tick({ steerTarget: turning ? dir : 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (car.hitSolid) solidTicks++;
    const lat = Math.abs(car.body.pos.x - x0);
    maxLateral = Math.max(maxLateral, lat);
    // Touching a solid while trying to go sideways and not getting anywhere.
    if (car.hitSolid) {
      blocked++;
      if (firstBlockX === null) {
        firstBlockX = car.body.pos.x - x0;
        firstBlockY = car.body.pos.y;
        n.copy(car.scrapeNormal ?? car._scrapeNormal ?? n);
      }
    }
    if (car.body.pos.y < -5) break;
  }
  up.set(0, 1, 0).applyQuaternion(car.body.quat);
  return {
    maxLateral, blocked, solidTicks, firstBlockX, firstBlockY,
    endLat: car.body.pos.x - x0,
    endY: car.body.pos.y,
    normal: firstBlockX === null ? null : `(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)})`,
  };
}

console.log("Jump lab: climb the ramp, then steer off the SIDE.");
console.log("Ramps are 12 m wide, so the edge is 6 m from the lane centre.\n");
console.log("  lane speed steerAt |  maxLat   endLat    endY  blocked  solid  blockAt(x,y)  normal");
for (const lane of [0, 2, 4]) {
  for (const speed of [10, 16, 22, 30]) {
    for (const steerAt of [0.5, 1.5, 3, 5, 8, 12]) {
      const r = exitOverSide({ lane, speed, steerAt });

      if (r.blocked === 0) continue;
      console.log(
        `  ${String(lane + 1).padStart(4)} ${String(speed).padStart(5)} ${steerAt.toFixed(1).padStart(7)} |`
        + ` ${r.maxLateral.toFixed(2).padStart(7)} ${r.endLat.toFixed(2).padStart(8)}`
        + ` ${r.endY.toFixed(1).padStart(7)} ${String(r.blocked).padStart(8)}`
        + ` ${String(r.solidTicks).padStart(6)}`
        + `  ${r.firstBlockX === null ? "      —     " : `${r.firstBlockX.toFixed(2)},${r.firstBlockY.toFixed(1)}`.padStart(12)}`
        + `  ${r.normal ?? ""}`,
      );
    }
  }
}
console.log("\n  maxLat = furthest it got sideways from the lane centre (needs > ~7 m");
console.log("  to clear a 6 m half-width). A normal of (±1,0,0) is the ramp FLANK.");
