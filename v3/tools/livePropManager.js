import * as THREE from "three";

const DEG = Math.PI / 180;

export class LivePropManager {
  constructor(scene, propStore) {
    this.scene = scene;
    this.store = propStore;
    this._factories = new Map();
    this._live      = new Map();  // storeIdx → { obj, factoryId, _paramSnap }
    this._lastGen   = -1;
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
  }

  _sync() {
    const wantedKeys = new Set();

    for (let i = 0; i < this.store.instances.length; i++) {
      const inst = this.store.instances[i];
      const type = this.store.types[inst.typeIdx];
      if (!type?.live) continue;

      wantedKeys.add(i);
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
      if (!wantedKeys.has(key)) {
        this._destroyEntry(entry);
        this._live.delete(key);
      }
    }
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
    if (entry.obj.dispose) {
      // Factory owns disposal (e.g. flag disposes its unique cloth geo;
      // collectibles are a no-op because they share geometry across instances).
      entry.obj.dispose();
    } else {
      // Fallback for factories that don't expose dispose().
      entry.obj.group.traverse(child => {
        if (child.isMesh) { child.geometry?.dispose(); }
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
    let best = null, bestDist = Infinity;
    const hits = [];
    for (const [storeIdx, entry] of this._live) {
      hits.length = 0;
      entry.obj.group.traverse(child => {
        if (!child.isMesh) return;
        const r = raycaster.intersectObject(child, false);
        hits.push(...r);
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

  getLiveEntry(storeIdx) { return this._live.get(storeIdx) ?? null; }

  setParam(storeIdx, key, value) {
    const inst = this.store.instances[storeIdx];
    if (!inst?.liveParams) return;
    inst.liveParams[key] = value;
    const entry = this._live.get(storeIdx);
    if (entry?.obj.setParam) entry.obj.setParam(key, value);
    entry._paramSnap = JSON.stringify(inst.liveParams);
    this.store._bump();
  }

  dispose() {
    for (const entry of this._live.values()) this._destroyEntry(entry);
    this._live.clear();
  }
}
