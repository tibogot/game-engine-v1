import * as THREE from "three";

const DEG = Math.PI / 180;

export class LivePropManager {
  constructor(scene, propStore) {
    this.scene = scene;
    this.store = propStore;
    this._factories = new Map();
    this._live = new Map();
    this._lastGen = -1;
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

      const key = i;
      wantedKeys.add(key);

      let entry = this._live.get(key);

      if (!entry || entry.factoryId !== type.factoryId || entry._paramSnap !== JSON.stringify(inst.liveParams)) {
        if (entry) this._destroyEntry(entry);
        entry = this._createEntry(type, inst, i);
        if (!entry) continue;
        this._live.set(key, entry);
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

  _createEntry(type, inst, instIdx) {
    const factory = this._factories.get(type.factoryId);
    if (!factory) return null;

    const params = inst.liveParams ? { ...inst.liveParams } : { ...type.defaultParams };
    const obj = factory(params);
    if (!obj?.group) return null;

    this.scene.add(obj.group);

    return {
      obj,
      factoryId: type.factoryId,
      instIdx,
      _paramSnap: JSON.stringify(inst.liveParams),
    };
  }

  _destroyEntry(entry) {
    if (entry.obj.dispose) entry.obj.dispose();
    this.scene.remove(entry.obj.group);
  }

  _applyTransform(entry, inst) {
    const g = entry.obj.group;
    g.position.set(inst.px, inst.py, inst.pz);
    g.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
    g.scale.set(inst.sx, inst.sy, inst.sz);
  }

  raycast(raycaster) {
    let best = null;
    let bestDist = Infinity;
    const intersects = [];

    for (const [key, entry] of this._live) {
      intersects.length = 0;
      entry.obj.group.traverse((child) => {
        if (!child.isMesh) return;
        const hits = raycaster.intersectObject(child, false);
        intersects.push(...hits);
      });

      for (const hit of intersects) {
        if (hit.distance < bestDist) {
          bestDist = hit.distance;
          best = { instIdx: key, distance: bestDist };
        }
      }
    }

    return best;
  }

  getLiveEntry(instIdx) {
    return this._live.get(instIdx) ?? null;
  }

  /** Iterate every live entry whose factory result has `kind` matching the test. */
  forEachByKind(kindTest, cb) {
    for (const [instIdx, entry] of this._live) {
      const k = entry.obj?.kind;
      if (k && kindTest(k)) cb(entry, instIdx);
    }
  }

  /** Toggle group visibility (used by collectible runtime to "consume" without mutating the store). */
  setEntryVisible(instIdx, visible) {
    const entry = this._live.get(instIdx);
    if (entry?.obj?.group) entry.obj.group.visible = !!visible;
  }

  /** Force all live entries visible — called when leaving play mode so collected items reappear. */
  showAll() {
    for (const entry of this._live.values()) {
      if (entry?.obj?.group) entry.obj.group.visible = true;
    }
  }

  updateParamSnap(instIdx) {
    const entry = this._live.get(instIdx);
    if (!entry) return;
    const inst = this.store.instances[instIdx];
    if (inst) entry._paramSnap = JSON.stringify(inst.liveParams);
  }

  dispose() {
    for (const entry of this._live.values()) {
      this._destroyEntry(entry);
    }
    this._live.clear();
  }
}
