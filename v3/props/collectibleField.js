/**
 * The collectible field — every coin/heart/key/GLB collectible in the world, drawn as
 * one instanced mesh per kind-part and animated on the GPU (see collectibles.js).
 *
 * CPU work per frame is a single uniform write (the clock + player position). Instance buffers
 * are rebuilt only when the PropStore changes, and a pickup touches exactly one float.
 *
 * Pickup queries go through a uniform-grid index, so testing "what's near the player" costs the
 * same whether the world holds 20 coins or 20,000.
 */
import * as THREE from "three";
import {
  collectibleUniforms, getCollectibleKind, isCollectibleFactoryId,
  INSTANCE_ATTRS, INSTANCE_STRIDE, BIRTH_OFFSET,
} from "./collectibles.js";

const DEG = Math.PI / 180;
const GRID_CELL = 8;          // metres — a couple of pickup radii
const ALIVE = -1;
const HIDDEN = -2;

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _mInv = new THREE.Matrix4();
const _ray = new THREE.Ray();
const _box = new THREE.Box3();
const _hit = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();

export function createCollectibleField(scene) {
  /** kind → { meshes[], attrs, slots, capacity, dirty } */
  const pools = new Map();
  /** storeIdx → { kind, slot } */
  const byStore = new Map();
  /** cellKey → array of { kind, slot } */
  const grid = new Map();

  let clock = 0;

  /* ─────────── pool building ─────────── */

  function ensurePool(kind, needed) {
    let pool = pools.get(kind);
    const capacity = Math.max(64, 1 << Math.ceil(Math.log2(Math.max(needed, 1))));

    if (pool && pool.capacity >= needed) return pool;
    if (pool) destroyPool(pool);

    const spec = getCollectibleKind(kind);
    if (!spec) return null;

    // One interleaved instance buffer — keeps us under WebGPU's 8-vertex-buffer ceiling
    // even when a GLB submesh already brings 5-6 attributes of its own.
    const data = new Float32Array(capacity * INSTANCE_STRIDE);
    const ib = new THREE.InstancedInterleavedBuffer(data, INSTANCE_STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);
    const attrs = {};
    for (const { name, size, offset } of INSTANCE_ATTRS) {
      attrs[name] = new THREE.InterleavedBufferAttribute(ib, size, offset);
    }

    const meshes = [];
    for (const part of spec.parts) {
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = part.geometry.index;
      for (const key of Object.keys(part.geometry.attributes)) {
        geo.setAttribute(key, part.geometry.attributes[key]);
      }
      for (const { name } of INSTANCE_ATTRS) geo.setAttribute(name, attrs[name]);
      geo.instanceCount = 0;

      const mesh = new THREE.Mesh(geo, part.material);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      // Instances live anywhere in the world; the mesh itself sits at the origin, so three's
      // bounding sphere would cull it wrongly. Vertex-side distance cull handles the far field.
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      scene.add(mesh);
      meshes.push(mesh);
    }

    pool = { kind, spec, meshes, attrs, data, ib, slots: [], capacity };
    pools.set(kind, pool);
    return pool;
  }

  function destroyPool(pool) {
    for (const mesh of pool.meshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
    }
    pools.delete(pool.kind);
  }

  /* ─────────── sync from the PropStore ─────────── */

  /** Rebuild instance buffers. Called only when propStore.gen changes. */
  function sync(store) {
    const wanted = new Map();
    for (let i = 0; i < store.instances.length; i++) {
      const inst = store.instances[i];
      const type = store.types[inst.typeIdx];
      if (!type?.live || !isCollectibleFactoryId(type.factoryId)) continue;
      let list = wanted.get(type.factoryId);
      if (!list) wanted.set(type.factoryId, (list = []));
      list.push(i);
    }

    // Keep pickup/hidden state across a re-sync (moving one coin must not respawn the rest).
    const prevState = new Map();
    for (const [storeIdx, ref] of byStore) {
      const pool = pools.get(ref.kind);
      if (!pool) continue;
      const birth = pool.data[ref.slot * INSTANCE_STRIDE + BIRTH_OFFSET];
      if (birth !== ALIVE) prevState.set(storeIdx, birth);
    }

    byStore.clear();
    grid.clear();

    for (const pool of [...pools.values()]) {
      if (!wanted.has(pool.kind)) {
        pool.slots.length = 0;
        for (const mesh of pool.meshes) mesh.geometry.instanceCount = 0;
      }
    }

    for (const [kind, list] of wanted) {
      const pool = ensurePool(kind, list.length);
      if (!pool) continue;
      const { spec } = pool;
      pool.slots.length = 0;

      for (let s = 0; s < list.length; s++) {
        const storeIdx = list[s];
        const inst = store.instances[storeIdx];
        const p = { ...spec.defaults, ...inst.liveParams };

        const baseY = spec.baseY(p);
        const unit = spec.unitScale(p);
        _e.set(inst.rx * DEG, inst.ry * DEG, inst.rz * DEG);
        _q.setFromEuler(_e);

        writeSlot(pool, s, {
          x: inst.px, y: inst.py, z: inst.pz,
          phase: hashPhase(storeIdx),
          qx: _q.x, qy: _q.y, qz: _q.z, qw: _q.w,
          sx: inst.sx * unit, sy: inst.sy * unit, sz: inst.sz * unit,
          pickupRadius: p.pickupRadius,
          spinSpeed: p.spinSpeed, bobAmp: p.bobAmp, bobSpeed: p.bobSpeed, baseY,
        });
        pool.data[s * INSTANCE_STRIDE + BIRTH_OFFSET] = prevState.get(storeIdx) ?? ALIVE;

        const slot = {
          storeIdx, kind, slot: s,
          x: inst.px, y: inst.py + baseY, z: inst.pz,
          pickupRadius: p.pickupRadius,
          radius: spec.radius * Math.max(inst.sx, inst.sy, inst.sz) * unit,
        };
        pool.slots.push(slot);
        byStore.set(storeIdx, slot);
        gridInsert(slot);
      }

      pool.ib.needsUpdate = true;
      for (const mesh of pool.meshes) mesh.geometry.instanceCount = list.length;
    }
  }

  function writeSlot(pool, s, v) {
    const d = pool.data;
    const o = s * INSTANCE_STRIDE;
    d[o + 0] = v.x;
    d[o + 1] = v.y;
    d[o + 2] = v.z;
    d[o + 3] = v.phase;
    d[o + 4] = v.qx;
    d[o + 5] = v.qy;
    d[o + 6] = v.qz;
    d[o + 7] = v.qw;
    d[o + 8] = v.sx;
    d[o + 9] = v.sy;
    d[o + 10] = v.sz;
    d[o + 11] = v.pickupRadius;
    d[o + 12] = v.spinSpeed;
    d[o + 13] = v.bobAmp;
    d[o + 14] = v.bobSpeed;
    d[o + 15] = v.baseY;
  }

  /**
   * Push one instance's liveParams (spin/bob/pickup radius/size) into its attribute slot.
   * Used by the props panel sliders — no rebuild, no re-upload of the other instances' data.
   */
  function updateParams(store, storeIdx) {
    const slot = byStore.get(storeIdx);
    if (!slot) return false;
    const pool = pools.get(slot.kind);
    const inst = store.instances[storeIdx];
    if (!pool || !inst) return false;

    const { spec, data } = pool;
    const p = { ...spec.defaults, ...inst.liveParams };
    const o = slot.slot * INSTANCE_STRIDE;
    const baseY = spec.baseY(p);
    const unit = spec.unitScale(p);

    data[o + 8] = inst.sx * unit;
    data[o + 9] = inst.sy * unit;
    data[o + 10] = inst.sz * unit;
    data[o + 11] = p.pickupRadius;
    data[o + 12] = p.spinSpeed;
    data[o + 13] = p.bobAmp;
    data[o + 14] = p.bobSpeed;
    data[o + 15] = baseY;
    pool.ib.needsUpdate = true;

    slot.y = inst.py + baseY;
    slot.pickupRadius = p.pickupRadius;
    slot.radius = spec.radius * Math.max(inst.sx, inst.sy, inst.sz) * unit;
    return true;
  }

  /** Deterministic per-instance phase so coins don't spin in lockstep — and don't reshuffle on edit. */
  function hashPhase(i) {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 100;
  }

  /* ─────────── spatial grid ─────────── */

  const cellKey = (cx, cz) => cx * 73856093 ^ cz * 19349663;

  function gridInsert(slot) {
    const cx = Math.floor(slot.x / GRID_CELL);
    const cz = Math.floor(slot.z / GRID_CELL);
    const key = cellKey(cx, cz);
    let cell = grid.get(key);
    if (!cell) grid.set(key, (cell = []));
    cell.push(slot);
  }

  /**
   * Visit every collectible whose cell overlaps a `radius` circle around (x, z).
   * Cost scales with the cells touched, not with the number of collectibles in the world.
   */
  function forEachNear(x, z, radius, cb) {
    const minX = Math.floor((x - radius) / GRID_CELL);
    const maxX = Math.floor((x + radius) / GRID_CELL);
    const minZ = Math.floor((z - radius) / GRID_CELL);
    const maxZ = Math.floor((z + radius) / GRID_CELL);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const cell = grid.get(cellKey(cx, cz));
        if (!cell) continue;
        for (const slot of cell) cb(slot);
      }
    }
  }

  /* ─────────── per-instance state ─────────── */

  function setBirth(storeIdx, value) {
    const slot = byStore.get(storeIdx);
    if (!slot) return false;
    const pool = pools.get(slot.kind);
    if (!pool) return false;
    pool.data[slot.slot * INSTANCE_STRIDE + BIRTH_OFFSET] = value;
    pool.ib.needsUpdate = true;
    return true;
  }

  function isAlive(storeIdx) {
    const slot = byStore.get(storeIdx);
    const pool = slot ? pools.get(slot.kind) : null;
    return pool ? pool.data[slot.slot * INSTANCE_STRIDE + BIRTH_OFFSET] === ALIVE : false;
  }

  /** Start the pickup pop. The GPU plays it out and collapses the instance when it ends. */
  function collect(storeIdx) {
    return setBirth(storeIdx, clock);
  }

  function setHidden(storeIdx, hidden) {
    setBirth(storeIdx, hidden ? HIDDEN : ALIVE);
  }

  function showAll() {
    for (const pool of pools.values()) {
      for (let s = 0; s < pool.slots.length; s++) {
        pool.data[s * INSTANCE_STRIDE + BIRTH_OFFSET] = ALIVE;
      }
      pool.ib.needsUpdate = true;
    }
  }

  /* ─────────── editor picking ─────────── */

  /**
   * Ray vs. per-instance box, using the authored transform (spin/bob are ignored — picking a
   * moving target is worse UX than picking its resting box).
   */
  function raycast(raycaster) {
    let best = null;
    let bestDist = Infinity;
    const origin = raycaster.ray.origin;

    for (const pool of pools.values()) {
      const { spec, data } = pool;
      for (const slot of pool.slots) {
        const o = slot.slot * INSTANCE_STRIDE;
        if (data[o + BIRTH_OFFSET] !== ALIVE) continue;

        // Cheap reject: ray vs. bounding sphere around the instance.
        const r = slot.radius + 0.25;
        const dx = slot.x - origin.x;
        const dy = slot.y - origin.y;
        const dz = slot.z - origin.z;
        const along = dx * raycaster.ray.direction.x
          + dy * raycaster.ray.direction.y
          + dz * raycaster.ray.direction.z;
        if (along < 0 || along >= bestDist) continue;
        const perp2 = dx * dx + dy * dy + dz * dz - along * along;
        if (perp2 > r * r) continue;

        _q.set(data[o + 4], data[o + 5], data[o + 6], data[o + 7]);
        _pos.set(slot.x, slot.y, slot.z);
        _scl.set(data[o + 8], data[o + 9], data[o + 10]);
        _m.compose(_pos, _q, _scl);
        _mInv.copy(_m).invert();
        _ray.copy(raycaster.ray).applyMatrix4(_mInv);

        const b = spec.bbox ?? boundsOf(spec);
        _box.copy(b);
        if (!_ray.intersectBox(_box, _hit)) continue;
        const dist = _hit.applyMatrix4(_m).distanceTo(origin);
        if (dist < bestDist) {
          bestDist = dist;
          best = { instIdx: slot.storeIdx, distance: dist };
        }
      }
    }
    return best;
  }

  const _boundsCache = new WeakMap();
  function boundsOf(spec) {
    let b = _boundsCache.get(spec);
    if (b) return b;
    b = new THREE.Box3();
    for (const part of spec.parts) {
      if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
      b.union(part.geometry.boundingBox);
    }
    _boundsCache.set(spec, b);
    return b;
  }

  /* ─────────── frame ─────────── */

  function update(dt) {
    clock += dt;
    collectibleUniforms.clock.value = clock;
  }

  function setPlayer(pos, playing) {
    collectibleUniforms.playing.value = playing ? 1 : 0;
    if (pos) collectibleUniforms.player.value.copy(pos);
  }

  function dispose() {
    for (const pool of [...pools.values()]) destroyPool(pool);
    byStore.clear();
    grid.clear();
  }

  return {
    sync, update, updateParams, setPlayer, raycast,
    collect, setHidden, showAll, isAlive, forEachNear,
    getSlot: (storeIdx) => byStore.get(storeIdx) ?? null,
    getKindSpec: (kind) => getCollectibleKind(kind),
    /** Kinds with at least one instance placed — drives HUD visibility. */
    kindsPresent: () => {
      const out = [];
      for (const pool of pools.values()) if (pool.slots.length) out.push(pool.kind);
      return out;
    },
    get clock() { return clock; },
    dispose,
  };
}
