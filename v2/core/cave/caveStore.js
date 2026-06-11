import * as THREE from "three";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Anchored "box room" caves placed under a painted terrain hole.
 *
 * One cave = a hollow rectangular chamber: floor + 4 inward-facing walls +
 * 4 ceiling strips around a square opening (the rim of the hole above lets
 * the player drop in). All geometry is merged into a single mesh per anchor.
 * The mesh participates in `cliffBvh.bake` via `forEachMeshInstance` so the
 * playMode floor/ceiling/wall raycasts pick up the cave's triangles without
 * any new physics plumbing.
 */
export class CaveStore {
  constructor(scene) {
    this.scene = scene;
    /** @type {Map<number, CaveAnchor>} */
    this.anchors = new Map();
    this._nextId = 1;

    this.material = new THREE.MeshStandardMaterial({
      color: 0x4a4a4a,
      roughness: 0.95,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });

    /** Listeners notified after any add / remove / clear / restore op. */
    this._changeListeners = new Set();
  }

  onChange(fn) {
    this._changeListeners.add(fn);
    return () => this._changeListeners.delete(fn);
  }
  _notify() {
    for (const fn of this._changeListeners) fn();
  }

  /**
   * @param {{
   *   x: number, z: number, surfaceY: number,
   *   width?: number, depth?: number, height?: number,
   *   opening?: number, ceilingOffset?: number,
   *   id?: number,
   * }} opts
   */
  addAnchor(opts) {
    const id = opts.id ?? this._nextId++;
    if (opts.id != null && opts.id >= this._nextId) this._nextId = opts.id + 1;
    const anchor = {
      id,
      x: opts.x ?? 0,
      z: opts.z ?? 0,
      surfaceY: opts.surfaceY ?? 0,
      width: opts.width ?? 12,
      depth: opts.depth ?? 12,
      height: opts.height ?? 6,
      opening: opts.opening ?? 4,
      ceilingOffset: opts.ceilingOffset ?? 0.5,
    };
    anchor.geometry = buildCaveBoxRoomGeometry(anchor);
    anchor.mesh = new THREE.Mesh(anchor.geometry, this.material);
    anchor.mesh.castShadow = false;
    anchor.mesh.receiveShadow = true;
    anchor.mesh.position.set(
      anchor.x,
      anchor.surfaceY - anchor.ceilingOffset,
      anchor.z,
    );
    anchor.mesh.updateMatrixWorld();
    anchor.mesh.userData.caveAnchorId = id;
    this.scene.add(anchor.mesh);
    this.anchors.set(id, anchor);
    this._notify();
    return id;
  }

  removeAnchor(id) {
    const a = this.anchors.get(id);
    if (!a) return false;
    this.scene.remove(a.mesh);
    a.geometry.dispose();
    this.anchors.delete(id);
    this._notify();
    return true;
  }

  clearAll() {
    if (this.anchors.size === 0) return;
    for (const a of this.anchors.values()) {
      this.scene.remove(a.mesh);
      a.geometry.dispose();
    }
    this.anchors.clear();
    this._notify();
  }

  getAll() {
    return [...this.anchors.values()];
  }

  count() {
    return this.anchors.size;
  }

  /** Called by `cliffBvh.bake` so cave triangles end up in the player BVH. */
  forEachMeshInstance(cb) {
    for (const a of this.anchors.values()) {
      a.mesh.updateMatrixWorld();
      cb(a.geometry, a.mesh.matrixWorld);
    }
  }

  serialize() {
    if (this.anchors.size === 0) return null;
    return {
      anchors: this.getAll().map((a) => ({
        id: a.id,
        x: a.x, z: a.z, surfaceY: a.surfaceY,
        width: a.width, depth: a.depth, height: a.height,
        opening: a.opening, ceilingOffset: a.ceilingOffset,
      })),
    };
  }

  deserialize(data) {
    this.clearAll();
    if (!data?.anchors) return;
    for (const a of data.anchors) this.addAnchor(a);
  }

  dispose() {
    this.clearAll();
    this.material.dispose();
    this._changeListeners.clear();
  }
}

/**
 * @typedef {{
 *   id: number, x: number, z: number, surfaceY: number,
 *   width: number, depth: number, height: number,
 *   opening: number, ceilingOffset: number,
 *   geometry: THREE.BufferGeometry,
 *   mesh: THREE.Mesh,
 * }} CaveAnchor
 */

/**
 * Build a hollow rectangular room with a square hole in the ceiling.
 * Local coords: ceiling at Y=0, floor at Y=-height. Mesh world position is
 * `(anchor.x, anchor.surfaceY - ceilingOffset, anchor.z)`, so the ceiling
 * sits just below the surface and the opening lines up with the hole above.
 *
 * Geometry is the merge of 9 plane pieces: 1 floor + 4 walls + 4 ceiling
 * strips. DoubleSide material avoids any winding mistakes biting us — the
 * cave is hidden by the terrain anyway, except where the hole punches
 * through.
 */
function buildCaveBoxRoomGeometry({ width, depth, height, opening }) {
  const W = width / 2;
  const D = depth / 2;
  const O = Math.min(opening, width - 0.1, depth - 0.1) / 2;
  const top = 0;
  const bot = -height;

  const pieces = [];

  // Floor — full width × depth, horizontal at Y = bot.
  const floor = new THREE.PlaneGeometry(width, depth);
  floor.rotateX(-Math.PI / 2);
  floor.translate(0, bot, 0);
  pieces.push(floor);

  // 4 walls — vertical, full height. Default PlaneGeometry faces +Z; rotate
  // to point each one inward. DoubleSide so we don't care if any face flips.
  const wallS = new THREE.PlaneGeometry(width, height);
  wallS.translate(0, top - height / 2, -D);
  pieces.push(wallS);

  const wallN = new THREE.PlaneGeometry(width, height);
  wallN.rotateY(Math.PI);
  wallN.translate(0, top - height / 2, D);
  pieces.push(wallN);

  const wallW = new THREE.PlaneGeometry(depth, height);
  wallW.rotateY(Math.PI / 2);
  wallW.translate(-W, top - height / 2, 0);
  pieces.push(wallW);

  const wallE = new THREE.PlaneGeometry(depth, height);
  wallE.rotateY(-Math.PI / 2);
  wallE.translate(W, top - height / 2, 0);
  pieces.push(wallE);

  // Ceiling — 4 strips framing a square opening of side `opening`.
  // North/south strips span full width; east/west strips fill the gap
  // between them around the opening.
  const stripDepth = D - O;
  if (stripDepth > 0.001) {
    const ceilN = new THREE.PlaneGeometry(width, stripDepth);
    ceilN.rotateX(Math.PI / 2);
    ceilN.translate(0, top, (D + O) / 2);
    pieces.push(ceilN);

    const ceilS = new THREE.PlaneGeometry(width, stripDepth);
    ceilS.rotateX(Math.PI / 2);
    ceilS.translate(0, top, -(D + O) / 2);
    pieces.push(ceilS);
  }
  const sideWidth = W - O;
  if (sideWidth > 0.001) {
    const ceilE = new THREE.PlaneGeometry(sideWidth, opening);
    ceilE.rotateX(Math.PI / 2);
    ceilE.translate((W + O) / 2, top, 0);
    pieces.push(ceilE);

    const ceilW = new THREE.PlaneGeometry(sideWidth, opening);
    ceilW.rotateX(Math.PI / 2);
    ceilW.translate(-(W + O) / 2, top, 0);
    pieces.push(ceilW);
  }

  const merged = BufferGeometryUtils.mergeGeometries(pieces, false);
  for (const p of pieces) p.dispose();
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}
