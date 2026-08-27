/**
 * The rounded start/finish nose must STOP a fast car and then LET IT LEAVE.
 * Punch-through was the old bug; a 1.6 m field-side trough reintroduced the
 * hole-wall perch (blocked, then glued). Sweep keeps you out; the slab stays
 * the same 0.38 m as a side rail.
 *
 *   node tools/roundedNoseCollisionTest.mjs
 */
import { register } from "node:module";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

register("./threeWebgpuHook.mjs", import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THREE = await import("three/webgpu");
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const {
  pieceParams, roadParams, buildPiece, initialConnector,
} = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);

const TMP = join(ROOT, `.nosenose.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, SOLID, CHASSIS_HULL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group();
  this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group();
  this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({}));
  this.wheelSpin = [0, 0, 0, 0];
  this.headlights = [];
  this.headlightTargets = [];
  this.headlamps = [];
  this.taillights = [];
  this._wheelInstances = [];
  this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const flat = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: 0, z: o.z }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};

function bake(geo) {
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes([{
    geometry: geo,
    matrixWorld: new THREE.Matrix4(),
    updateMatrixWorld() {},
  }]);
  return bvh;
}

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

console.log(`hull ${CHASSIS_HULL.width}×${CHASSIS_HULL.height}×${CHASSIS_HULL.length}  skin ${SOLID.skin}  reach ${SOLID.insideReach}  sweepMargin ${SOLID.sweepMargin}`);

/**
 * Ram the finish_new nose (dead-end at min Z) along −Z, like finishing a sprint.
 * start_new nose is at max Z — ram along +Z (reverse into the start bubble).
 */
function ram(id, speed, { withDeck = false, x = 0 } = {}) {
  const built = buildPiece(id, initialConnector(), { ...pieceParams });
  const geo = built.railCollision;
  const box = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  const solids = bake(geo);
  const deck = withDeck ? bake(built.geometry) : flat;

  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = deck;
  c.solidsBvh = solids;
  c.enabled = true;

  const noseAtMinZ = id === "finish_new" || id === "rounded_end";
  const halfLen = CHASSIS_HULL.length / 2;
  let into, startZ, velZ, noseZ, throughZ;
  if (noseAtMinZ) {
    noseZ = box.min.z;
    // Sit on the stub, nose of the car pointing at the rounded end.
    startZ = noseZ + 8 + halfLen;
    velZ = -speed;
    throughZ = noseZ - 0.6;
    into = (z) => z < throughZ;
  } else {
    noseZ = box.max.z;
    startZ = noseZ - 8 - halfLen;
    velZ = +speed;
    throughZ = noseZ + 0.6;
    into = (z) => z > throughZ;
  }

  c.body.pos.set(x, 0.45, startZ);
  c.body.vel.set(0, 0, velZ);
  if (!noseAtMinZ) {
    // Default spawn faces −Z. Identity faces +Z, into the start nose.
    c.body.quat.identity();
  }

  let minDistToNose = Infinity;
  let touched = false;
  let through = false;
  let maxY = c.body.pos.y;
  const budget = 4 / FIXED_DT;
  const trace = [];
  for (let i = 0; i < budget; i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0, rollTarget: 0 });
    if (c._solidTouch) touched = true;
    maxY = Math.max(maxY, c.body.pos.y);
    const noseOfCar = noseAtMinZ
      ? c.body.pos.z - halfLen
      : c.body.pos.z + halfLen;
    const d = Math.abs(noseOfCar - noseZ);
    if (d < minDistToNose) minDistToNose = d;
    if (i % 8 === 0 && trace.length < 12) {
      trace.push(`t=${(i * FIXED_DT).toFixed(2)} x=${c.body.pos.x.toFixed(1)} y=${c.body.pos.y.toFixed(2)} z=${c.body.pos.z.toFixed(2)} v=${c.body.vel.length().toFixed(0)} solid=${c._solidTouch}`);
    }
    if (into(c.body.pos.z) && Math.abs(c.body.pos.x) < 6) { through = true; break; }
    const spd = Math.hypot(c.body.vel.x, c.body.vel.y, c.body.vel.z);
    if (spd < 0.5 && d < 3) break;
  }

  // Reverse away. A car glued in the U-trough stays put — that is the hole-wall
  // perch this test must not reintroduce.
  const zHit = c.body.pos.z;
  c.body.vel.set(0, 0, noseAtMinZ ? 12 : -12);
  for (let i = 0; i < 0.5 / FIXED_DT; i++) {
    c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0, rollTarget: 0 });
  }
  const freed = noseAtMinZ ? c.body.pos.z > zHit + 1.2 : c.body.pos.z < zHit - 1.2;

  built.geometry?.dispose();
  built.railGeometry?.dispose();
  built.railCollision?.dispose();

  return {
    through,
    touched,
    minDistToNose,
    z: c.body.pos.z,
    y: c.body.pos.y,
    x: c.body.pos.x,
    maxY,
    vz: c.body.vel.z,
    noseZ,
    startZ,
    trace,
    freed,
  };
}

for (const id of ["finish_new", "start_new"]) {
  for (const withDeck of [false, true]) {
    console.log(`\n======== ${id} ${withDeck ? "rail+deck" : "rail only"} ========`);
    for (const speed of [20, 40, 60]) {
      const r = ram(id, speed, { withDeck });
      check(
        !r.through && r.freed,
        `${id} ${speed} m/s  ${r.through ? "WENT THROUGH" : !r.freed ? "STUCK" : r.touched ? "blocked+free" : "never touched"}  `
        + `minDist ${r.minDistToNose.toFixed(2)}  z ${r.z.toFixed(2)} y ${r.y.toFixed(2)} vz ${r.vz.toFixed(1)}`,
      );
    }
  }
}

console.log("\n======== finish_new off-centre + deck ========");
for (const x of [1, 2, 3, 4]) {
  for (const speed of [40, 55]) {
    const r = ram("finish_new", speed, { withDeck: true, x });
    check(
      !r.through,
      `x=${x} ${speed} m/s  ${r.through ? "WENT THROUGH" : r.freed ? "blocked+free" : "blocked"}  `
      + `end x=${r.x.toFixed(1)} z=${r.z.toFixed(2)} y=${r.y.toFixed(2)} maxY=${r.maxY.toFixed(2)}`,
    );
    if (r.through) for (const line of r.trace) console.log(`     ${line}`);
  }
}

console.log("\n======== rounded_end / rounded_start (same U as start_new / finish_new) ========");
for (const id of ["rounded_end", "rounded_start"]) {
  for (const speed of [40, 55]) {
    const r = ram(id, speed, { withDeck: true });
    check(
      !r.through && r.freed,
      `${id} ${speed} m/s  ${r.through ? "WENT THROUGH" : !r.freed ? "STUCK" : "blocked+free"}`,
    );
  }
  const r = ram(id, 55, { withDeck: true, x: 2 });
  check(!r.through, `${id} x=2 55 m/s  ${r.through ? "WENT THROUGH" : "blocked"}`);
}

if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall ok");
