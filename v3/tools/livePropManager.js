import * as THREE from "three";
import { isCollectibleFactoryId } from "../props/collectibles.js";
import { createCollectibleField } from "../props/collectibleField.js";

const DEG = Math.PI / 180;

/**
 * Live (animated) props.
 *
 * Two very different populations live here:
 *
 *   - Group props (flag, procedural objects): one THREE.Group each, updated on the CPU.
 *   - Collectibles (coin/heart/key/GLB): handed to the CollectibleField, which draws each kind
 *     in one instanced call and animates it on the GPU. Thousands of coins cost no per-frame CPU.
 */
export class LivePropManager {
  constructor(scene, propStore) {
    this.scene = scene;
    this.store = propStore;
    this._factories = new Map();
    /** storeIdx → group-based live prop */
    this._live = new Map();
    this.collectibles = createCollectibleField(scene);
    this._lastGen = -1;
  }

  isInstancedCollectible(factoryId) {
    return isCollectibleFactoryId(factoryId);
  }

  registerFactory(factoryId, createFn) {
    this._factories.set(factoryId, createFn);
  }

  update(dt) {
    if (this.store.gen !== this._lastGen) {
      this._lastGen = this.store.gen;
      this._sync();
    }
    for (const entry of this._live.values()) {
      if (entry.obj.update) entry.obj.update(dt);
    }
    this.collectibles.update(dt);
  }

  _sync() {
    const wanted = new Set();

    for (let i = 0; i < this.store.instances.length; i++) {
      const inst = this.store.instances[i];
      const type = this.store.types[inst.typeIdx];
      if (!type?.live || isCollectibleFactoryId(type.factoryId)) continue;

      wanted.add(i);
      let entry = this._live.get(i);
      const paramSnap = JSON.stringify(inst.liveParams);

      if (!entry || entry.factoryId !== type.factoryId || entry._paramSnap !== paramSnap) {
        if (entry) this._destroyEntry(entry);
        entry = this._createEntry(type, inst);
        if (!entry) continue;
        entry._paramSnap = paramSnap;
        this._live.set(i, entry);
      }
      this._applyTransform(entry, inst);
    }

    for (const [key, entry] of this._live) {
      if (!wanted.has(key)) {
        this._destroyEntry(entry);
        this._live.delete(key);
      }
    }

    this.collectibles.sync(this.store);
  }

  _createEntry(type, inst) {
    const factory = this._factories.get(type.factoryId);
    if (!factory) return null;
    const params = inst.liveParams ? { ...inst.liveParams } : { ...type.defaultParams };
    const obj = factory(params);
    if (!obj?.group) return null;
    this.scene.add(obj.group);
    return { obj, factoryId: type.factoryId };
  }

  _destroyEntry(entry) {
    this.scene.remove(entry.obj.group);
    if (entry.obj.dispose) entry.obj.dispose();
    else {
      entry.obj.group.traverse((child) => {
        if (child.isMesh) child.geometry?.dispose();
      });
    }
  }

  _applyTransform(entry, inst) {
    const g = entry.obj.group;
    g.position.set(inst.px, inst.py, inst.pz);
    g.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
    g.scale.set(inst.sx, inst.sy, inst.sz);
  }

  raycast(raycaster) {
    let best = this.collectibles.raycast(raycaster);
    let bestDist = best?.distance ?? Infinity;
    const hits = [];

    for (const [storeIdx, entry] of this._live) {
      hits.length = 0;
      entry.obj.group.traverse((child) => {
        if (!child.isMesh) return;
        hits.push(...raycaster.intersectObject(child, false));
      });
      for (const hit of hits) {
        if (hit.distance < bestDist) {
          bestDist = hit.distance;
          best = { instIdx: storeIdx, distance: bestDist };
        }
      }
    }

    return best;
  }

  getLiveEntry(storeIdx) {
    const entry = this._live.get(storeIdx);
    if (entry) return entry;

    const inst = this.store.instances[storeIdx];
    const type = inst ? this.store.types[inst.typeIdx] : null;
    if (!type?.live || !isCollectibleFactoryId(type.factoryId)) return null;
    if (!this.collectibles.getSlot(storeIdx)) return null;

    // Panel-facing view of a GPU-resident collectible — it has no THREE.Group to hand back.
    return {
      factoryId: type.factoryId,
      instIdx: storeIdx,
      instanced: true,
      obj: {
        kind: type.factoryId,
        getParams: () => ({ ...inst.liveParams }),
        setParam: (key, value) => {
          inst.liveParams[key] = value;
          this.collectibles.updateParams(this.store, storeIdx);
        },
      },
    };
  }

  /**
   * Player-BVH collision source. Emits geometry for SOLID live props only — collectibles are
   * pass-through pickups and never reach here (they aren't in `_live`).
   */
  forEachMeshInstance(cb) {
    const im = new THREE.Matrix4();
    const wm = new THREE.Matrix4();
    for (const entry of this._live.values()) {
      if (entry.obj?.kind) continue;
      const root = entry.obj?.group;
      if (!root) continue;
      root.updateMatrixWorld(true);
      root.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        if (obj.userData?.noCollision) return;
        if (obj.isInstancedMesh) {
          for (let i = 0; i < obj.count; i++) {
            obj.getMatrixAt(i, im);
            wm.multiplyMatrices(obj.matrixWorld, im);
            cb(obj.geometry, wm);
          }
        } else {
          cb(obj.geometry, obj.matrixWorld);
        }
      });
    }
  }

  setParam(storeIdx, key, value) {
    const inst = this.store.instances[storeIdx];
    if (!inst?.liveParams) return;
    inst.liveParams[key] = value;

    const entry = this._live.get(storeIdx);
    if (entry?.obj.setParam) entry.obj.setParam(key, value);
    else this.collectibles.updateParams(this.store, storeIdx);

    if (entry) entry._paramSnap = JSON.stringify(inst.liveParams);
    this.store._bump();
  }

  updateParamSnap(storeIdx) {
    const entry = this._live.get(storeIdx);
    if (!entry) return;
    const inst = this.store.instances[storeIdx];
    if (inst) entry._paramSnap = JSON.stringify(inst.liveParams);
  }

  setEntryVisible(storeIdx, visible) {
    const entry = this._live.get(storeIdx);
    if (entry?.obj?.group) {
      entry.obj.group.visible = !!visible;
      return;
    }
    this.collectibles.setHidden(storeIdx, !visible);
  }

  showAll() {
    for (const entry of this._live.values()) {
      if (entry?.obj?.group) entry.obj.group.visible = true;
    }
    this.collectibles.showAll();
  }

  dispose() {
    for (const entry of this._live.values()) this._destroyEntry(entry);
    this._live.clear();
    this.collectibles.dispose();
  }
}
