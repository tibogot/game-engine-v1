import * as THREE from "three";
import {
  COLLECTIBLE_KINDS,
  getCollectibleInstancingAssets,
  isInstancedCollectibleFactoryId,
} from "../../v2/core/props/collectibleFactory.js";

const DEG = Math.PI / 180;
const MAX_COLLECTIBLE_INSTANCES = 4096;

const _root = new THREE.Object3D();
const _local = new THREE.Object3D();
const _worldMat = new THREE.Matrix4();
const _zeroScale = new THREE.Matrix4().makeScale(0, 0, 0);

export class LivePropManager {
  constructor(scene, propStore) {
    this.scene = scene;
    this.store = propStore;
    this._factories = new Map();
    /** storeIdx → group-based live prop */
    this._live = new Map();
    /** factoryId (coin/heart/key) → instanced pool */
    this._collectiblePools = new Map();
    this._lastGen = -1;
  }

  isInstancedCollectible(factoryId) {
    return isInstancedCollectibleFactoryId(factoryId);
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
    this._updateCollectibleInstances(dt);
  }

  _sync() {
    const wantedGroup = new Set();
    /** @type {Map<string, Array<{ storeIdx: number, inst: object }>>} */
    const wantedCollectibles = new Map();
    for (const kind of COLLECTIBLE_KINDS) wantedCollectibles.set(kind, []);

    for (let i = 0; i < this.store.instances.length; i++) {
      const inst = this.store.instances[i];
      const type = this.store.types[inst.typeIdx];
      if (!type?.live) continue;

      if (isInstancedCollectibleFactoryId(type.factoryId)) {
        wantedCollectibles.get(type.factoryId)?.push({ storeIdx: i, inst });
        continue;
      }

      wantedGroup.add(i);
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
      if (!wantedGroup.has(key)) {
        this._destroyEntry(entry);
        this._live.delete(key);
      }
    }

    this._syncCollectiblePools(wantedCollectibles);
  }

  _syncCollectiblePools(wantedCollectibles) {
    for (const kind of COLLECTIBLE_KINDS) {
      const list = wantedCollectibles.get(kind) ?? [];
      let pool = this._collectiblePools.get(kind);

      if (list.length === 0) {
        if (pool) {
          pool.im.count = 0;
          pool.slots.length = 0;
          pool._slotByStore.clear();
        }
        continue;
      }

      if (!pool) {
        const assets = getCollectibleInstancingAssets(kind);
        if (!assets) continue;
        const im = new THREE.InstancedMesh(
          assets.geometry,
          assets.material,
          MAX_COLLECTIBLE_INSTANCES,
        );
        im.count = 0;
        im.castShadow = true;
        im.receiveShadow = false;
        im.frustumCulled = false;
        this.scene.add(im);
        pool = {
          im,
          assets,
          slots: [],
          _slotByStore: new Map(),
          _prevByStore: new Map(),
        };
        this._collectiblePools.set(kind, pool);
      }

      const prevByStore = pool._prevByStore;
      pool._prevByStore = new Map();
      pool.slots = [];
      pool._slotByStore.clear();

      for (const { storeIdx, inst } of list) {
        const prev = prevByStore.get(storeIdx);
        const p = { ...pool.assets.defaults, ...inst.liveParams };
        const slot = {
          storeIdx,
          hidden: prev?.hidden ?? false,
          phase: prev?.phase ?? Math.random() * 100,
          spinY: prev?.spinY ?? 0,
          spinSpeed: p.spinSpeed,
          bobAmp: p.bobAmp,
          bobSpeed: p.bobSpeed,
          baseY: pool.assets.baseY(p),
        };
        pool.slots.push(slot);
        pool._slotByStore.set(storeIdx, pool.slots.length - 1);
        pool._prevByStore.set(storeIdx, slot);
      }

      pool.im.count = pool.slots.length;
    }
  }

  _updateCollectibleInstances(dt) {
    for (const pool of this._collectiblePools.values()) {
      if (!pool.im.count) {
        pool.im.visible = false;
        continue;
      }
      pool.im.visible = true;

      for (let i = 0; i < pool.slots.length; i++) {
        const slot = pool.slots[i];
        const inst = this.store.instances[slot.storeIdx];
        if (!inst || slot.hidden) {
          pool.im.setMatrixAt(i, _zeroScale);
          continue;
        }

        slot.phase += dt;
        slot.spinY += slot.spinSpeed * dt;
        const bob = Math.sin(slot.phase * slot.bobSpeed) * slot.bobAmp;

        _local.position.set(0, slot.baseY + bob, 0);
        _local.rotation.set(0, slot.spinY, 0);
        _local.updateMatrix();

        _root.position.set(inst.px, inst.py, inst.pz);
        _root.rotation.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
        _root.scale.set(inst.sx, inst.sy, inst.sz);
        _root.updateMatrix();

        _worldMat.multiplyMatrices(_root.matrix, _local.matrix);
        pool.im.setMatrixAt(i, _worldMat);
      }

      pool.im.instanceMatrix.needsUpdate = true;
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
    let best = null;
    let bestDist = Infinity;
    const hits = [];

    for (const pool of this._collectiblePools.values()) {
      if (!pool.im.count) continue;
      hits.length = 0;
      const r = raycaster.intersectObject(pool.im, false);
      hits.push(...r);
      for (const hit of hits) {
        if (hit.instanceId == null || hit.distance >= bestDist) continue;
        const storeIdx = pool.slots[hit.instanceId]?.storeIdx;
        if (storeIdx == null) continue;
        bestDist = hit.distance;
        best = { instIdx: storeIdx, distance: bestDist };
      }
    }

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
    if (!type?.live || !isInstancedCollectibleFactoryId(type.factoryId)) return null;

    const pool = this._collectiblePools.get(type.factoryId);
    if (!pool?._slotByStore.has(storeIdx)) return null;

    return {
      factoryId: type.factoryId,
      instIdx: storeIdx,
      instanced: true,
      obj: {
        kind: type.factoryId,
        getParams: () => ({ ...inst.liveParams }),
        setParam: (key, value) => {
          inst.liveParams[key] = value;
          const pool = this._collectiblePools.get(type.factoryId);
          const slotIdx = pool?._slotByStore.get(storeIdx);
          const slot = slotIdx != null ? pool?.slots[slotIdx] : null;
          if (slot && pool) {
            const p = { ...pool.assets.defaults, ...inst.liveParams };
            if (key === "spinSpeed" || key === "bobAmp" || key === "bobSpeed") {
              slot[key] = p[key];
            } else if (key === "radius" || key === "size") {
              slot.baseY = pool.assets.baseY(p);
            } else if (key === "pickupRadius") {
              // runtime-only param
            }
          }
        },
      },
    };
  }

  /**
   * Player-BVH collision source. Emits geometry for SOLID live props — skips
   * collectibles (coin/heart/key), which are pass-through pickups.
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

    const type = this.store.types[inst.typeIdx];
    if (type && isInstancedCollectibleFactoryId(type.factoryId)) {
      const pool = this._collectiblePools.get(type.factoryId);
      const slotIdx = pool?._slotByStore.get(storeIdx);
      const slot = slotIdx != null ? pool.slots[slotIdx] : null;
      if (slot) {
        const p = { ...pool.assets.defaults, ...inst.liveParams };
        if (key === "spinSpeed" || key === "bobAmp" || key === "bobSpeed") {
          slot[key] = p[key];
        } else if (key === "radius" || key === "size") {
          slot.baseY = pool.assets.baseY(p);
        }
      }
    }

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
    const inst = this.store.instances[storeIdx];
    const type = inst ? this.store.types[inst.typeIdx] : null;
    if (!type || !isInstancedCollectibleFactoryId(type.factoryId)) return;
    const pool = this._collectiblePools.get(type.factoryId);
    const slot = pool?.slots[pool._slotByStore.get(storeIdx)];
    if (slot) slot.hidden = !visible;
  }

  showAll() {
    for (const entry of this._live.values()) {
      if (entry?.obj?.group) entry.obj.group.visible = true;
    }
    for (const pool of this._collectiblePools.values()) {
      for (const slot of pool.slots) slot.hidden = false;
    }
  }

  dispose() {
    for (const entry of this._live.values()) this._destroyEntry(entry);
    this._live.clear();
    for (const pool of this._collectiblePools.values()) {
      this.scene.remove(pool.im);
      pool.im.dispose();
    }
    this._collectiblePools.clear();
  }
}
