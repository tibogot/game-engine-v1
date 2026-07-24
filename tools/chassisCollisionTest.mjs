// ============================================================================
// Chassis-collision harness for the modular-road vehicle.
//
// Drives the car into real road geometry from many speeds and angles and
// asserts the two things that must never happen:
//   • it must never end up UNDER / INSIDE a road slab
//   • it must never come to rest jammed against geometry it should slide off
//
// Run:  node tools/chassisCollisionTest.mjs
//
// Headless-only shims: the Vehicle constructor builds node materials for the
// head/tail lights, which need a GPU. _buildMeshes is stubbed to plain Object3Ds
// — nothing below reads the meshes, only the rigid body.
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Strip the two GPU-only imports so the module loads under node.
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.chassisTest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));

const { Vehicle, CHASSIS, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, roadParams } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
unlinkSync(TMP);

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

/** A straight run of road, `n` pieces long, as baked deck + solids BVHs. */
export function buildTrack(n = 6) {
  let conn = new THREE.Matrix4();
  const deckGeos = [], railGeos = [];
  for (let i = 0; i < n; i++) {
    const p = buildPiece("straight", conn);
    const g = p.geometry.clone(); g.applyMatrix4(p.world); deckGeos.push(g);
    if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); railGeos.push(r); }
    conn = p.connectorOut;
  }
  const mk = (geos) => {
    if (!geos.length) return null;
    const bvh = new RoadBvh();
    const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
    for (const m of meshes) m.updateMatrixWorld(true);
    bvh.bakeFromMeshes(meshes);
    return bvh.baked ? bvh : null;
  };
  return { deck: mk(deckGeos), solids: mk(railGeos), length: n * 8 };
}

/**
 * A run of TUBE pieces. Tubes are RIDEABLE — the thick-walled annulus lands in
 * the DECK bvh and the car drives the inner wall — so a car must never exit
 * through the wall.
 */
export function buildTubeTrack(n = 4) {
  let conn = new THREE.Matrix4();
  const geos = [];
  for (let i = 0; i < n; i++) {
    const piece = buildPiece(i === 0 ? "straight" : "tube", conn);
    for (const g of [piece.geometry, piece.shellGeometry]) {
      if (!g) continue;
      const c = g.clone();
      c.applyMatrix4(piece.world);
      geos.push(c);
    }
    conn = piece.connectorOut;
  }
  const bvh = new RoadBvh();
  const meshes = geos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
  for (const m of meshes) m.updateMatrixWorld(true);
  bvh.bakeFromMeshes(meshes);
  return { deck: bvh.baked ? bvh : null, solids: null };
}

/** The deck's top surface is y=0 and it is roadParams.thickness deep. */
export const DECK_TOP = 0;
export const DECK_BOTTOM = -Math.max(0.05, roadParams.thickness);

export function makeCar(track) {
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(track.deck, track.solids);
  // These are SKY tracks, so the terrain safety floor is far below. Without this
  // getFloorY is null and the chassis-corner floor defaults to y=0 — exactly the
  // deck's top surface — which fires a 180 kN/m spring at any car below the road
  // and looks like a collision launch that is really a harness artifact.
  car.getFloorY = () => -50;
  car.enabled = true;
  return car;
}

/**
 * Run one scenario.
 * @returns {{underRoad:boolean, minY:number, endY:number, endSpeed:number,
 *            stuck:boolean, maxDepth:number}}
 */
/**
 * Run one scenario.
 *
 * `recovered` is the thing that actually matters for "is the car stuck": either
 * it is still moving, or it is sitting on the deck at ride height with wheels
 * down — i.e. the player can drive away. A car correctly stopped by a head-on
 * wall is NOT stuck, so speed alone is the wrong measure.
 */
export function simulate({ track, pos, vel, quat, steer = 0, throttle = 0, ticks = 480 }) {
  const car = makeCar(track);
  car.body.pos.copy(pos);
  car.body.vel.copy(vel);
  // Face the direction of travel unless the caller pinned an orientation. The
  // car's forward is +Z, so leaving the identity quaternion while driving -Z
  // means throttle acts as a BRAKE — which silently invalidated every
  // "can it drive away?" assertion until this was found.
  if (quat) {
    car.body.quat.copy(quat);
  } else if (Math.hypot(vel.x, vel.z) > 0.5) {
    car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(vel.x, vel.z));
  }
  car.body.angVel.set(0, 0, 0);

  let minY = Infinity, peakY = -Infinity;
  const half = CHASSIS.height / 2;
  const inFootprint = (p) => Math.abs(p.x) < 9 && p.z > -80 && p.z < 10;
  for (let i = 0; i < ticks; i++) {
    car.tick({ steerTarget: steer, throttle, handbrake: false, yaw: 0 });
    minY = Math.min(minY, car.body.pos.y);
    peakY = Math.max(peakY, car.body.pos.y);
  }
  const p = car.body.pos;
  const endSpeed = Math.hypot(car.body.vel.x, car.body.vel.z);
  const endedUnderRoad = inFootprint(p) && p.y + half < DECK_BOTTOM;
  const onDeck = car.groundedCount >= 3 && p.y > DECK_TOP && p.y < DECK_TOP + 1.5;
  return {
    minY, peakY, endSpeed,
    endY: p.y, endX: p.x, endZ: p.z,
    grounded: car.groundedCount,
    endedUnderRoad,
    stuckTime: car.stuckTime,
    recovered: endSpeed > 2 || onDeck,
  };
}

export { THREE, CHASSIS, FIXED_DT };
