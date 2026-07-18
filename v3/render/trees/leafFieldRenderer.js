/**
 * GPU leaf field — indirect-drawn tree canopies for atlas merge groups.
 *
 * The endgame of the tree draw-call work: instead of the chunked
 * FoliageLodRenderer building one CPU mesh per cell × tier (draws scale with
 * visible cells), each merge group renders ALL its leaves with ONE indirect
 * draw. Per frame a compute pass walks every leaf slot, culls by camera
 * frustum + distance, and appends surviving leaves to a compact payload
 * buffer; the indirect instanceCount comes straight from the GPU atomic —
 * the CPU never knows how many leaves are visible (susukiSystem pattern).
 *
 * LOD is CONTINUOUS, replacing the 3 discrete tiers: leaf tables are stored
 * pre-shuffled, and a tree at distance d keeps only the first
 * keepP(d)·count leaves of its table while the survivors grow by
 * 1/sqrt(keepP) — density thins smoothly leaf-by-leaf (no tier popping, no
 * cross-fade machinery). Endpoints match the old tiers: 50% @ ×1.414 around
 * lod1Distance, 25% @ ×2 toward fade-out, 0 where the impostors take over.
 *
 * Static data (rewritten on tree edits, debounced like the impostor field):
 *   treeA[i]      vec4  (x, y, z, scale)
 *   treeB[i]      vec4  (rotY, memberIdx, tableOffset, leafCount)
 *   leafToTree[k] uint  (treeIdx << 16 | leafIdx)   — exact dispatch mapping
 *   table[o*2..]  vec4  (local x,y,z, size), (rand.x, rand.y, heightFrac, 0)
 * Per-frame payload (compute-written, visCap entries × 3 vec4):
 *   (leafCenterW, size·scale·sizeMul), (rand, heightFrac, memberIdx),
 *   (treeCenterW, 1)
 *
 * The draw uses the SAME merged foliage material as the chunked path, with
 * instance data injected from the payload buffer (opts.data) and the param
 * uniform-array shared with the group (opts.sharedArrays) — one param sync
 * covers both. Terrain-normal tree tilt (t.nx/nz) is NOT applied here (yaw
 * only); canopies of slope-planted trees render upright.
 */
import * as THREE from "three";
import {
  Fn, If, attribute, atomicAdd, atomicStore, cos, float, instanceIndex,
  instancedArray, int, length, negate, sin, smoothstep, step, storage,
  uint, uniform, uniformArray, vec2, vec3, vec4,
} from "three/tsl";
import {
  createMergedFoliageMaterial,
  setFoliageTexture,
  MAX_MERGED_SLOTS,
} from "../../../v2/render/foliage/foliageMaterial.js";
import { computeFrustumVisibility } from "../../../v2/core/revoGrass/revoGrassSsboUtils.js";

const REPACK_DEBOUNCE = 250;   // ms — coalesce per-stamp gen bumps while painting
const VIS_CAP = 300000;        // max on-screen leaves per group (payload budget)
const MAX_TREES = 65535;       // treeIdx packs into 16 bits
const CULL_WORKGROUP = 64;

function pow2(n) {
  let c = 1024;
  while (c < n) c *= 2;
  return c;
}

export class LeafFieldRenderer {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    /** mergeKey -> field entry */
    this.entries = new Map();

    // Camera/LOD uniforms shared by every group's compute.
    this.u = {
      uCamPos: uniform(new THREE.Vector3()),
      uCamMatrix: uniform(new THREE.Matrix4()),
      uFx: uniform(1),
      uFy: uniform(1),
      uLod0: uniform(80),
      uLod1: uniform(200),
      uFadeMid: uniform(420),
      uFade0: uniform(560),
      uFade1: uniform(620),
      uCullPadNdcX: uniform(0.45),
      uCullPadNdcYNear: uniform(0.75),
      uCullPadNdcYFar: uniform(0.45),
    };

    this._viewInv = new THREE.Matrix4();
    this._lastGen = -1;
    this._repackAt = 0;
    this._treeStore = null;
  }

  // ── Group sync ─────────────────────────────────────────────────────────────

  /**
   * (Re)build field entries from the renderer's merge groups. Call after any
   * preset load/clear. Entries whose group membership changed are rebuilt
   * from scratch (leaf tables, buffers, material) — rare, preset-load-time.
   */
  syncGroups(mergeGroups, slotPresets, treeStore) {
    this._treeStore = treeStore;
    for (const key of [...this.entries.keys()]) {
      if (!mergeGroups.groups.has(key)) this._disposeEntry(key);
    }
    for (const [key, g] of mergeGroups.groups) {
      const existing = this.entries.get(key);
      if (existing && existing.cardGen === g.cardGen) continue;
      this._disposeEntry(key);
      this._createEntry(key, g, slotPresets);
    }
    if (treeStore) this._repackAll(treeStore);
  }

  /** Build the per-slot shuffled leaf tables for a group. */
  _buildTables(g, slotPresets) {
    const rows = [];
    const slotTable = new Map(); // slotIdx -> { offset, count, memberIdx }
    for (const [si, mi] of g.members) {
      const preset = slotPresets[si];
      const lod0 = preset?.lods?.[0];
      if (!lod0 || lod0.count === 0) {
        slotTable.set(si, { offset: 0, count: 0, memberIdx: mi });
        continue;
      }
      const n = lod0.count;
      const bYMin = (preset.bounds && preset.bounds.yMin) ?? 0;
      const bRange = Math.max(((preset.bounds && preset.bounds.yMax) ?? 8) - bYMin, 0.001);
      // Deterministic shuffle: the cull keeps a PREFIX of the table, so the
      // stored order must be spatially uniform — cluster-sequential order
      // would thin whole clusters last.
      const order = Array.from({ length: n }, (_, i) => i);
      let seed = 1234567;
      const rng = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0xffffffff;
      };
      for (let i = n - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      }
      const offset = rows.length / 2;
      const c = lod0.centerData, s = lod0.scaleData, r = lod0.randData;
      for (const src of order) {
        const ly = c[src * 3 + 1];
        rows.push(
          [c[src * 3], ly, c[src * 3 + 2], s[src]],
          [r[src * 2], r[src * 2 + 1],
           Math.min(1, Math.max(0, (ly - bYMin) / bRange)), 0],
        );
      }
      slotTable.set(si, { offset, count: n, memberIdx: mi });
    }
    const arr = new Float32Array(rows.length * 4);
    rows.forEach((row, i) => arr.set(row, i * 4));
    return { tableArr: arr, slotTable };
  }

  _createEntry(key, g, slotPresets) {
    const { tableArr, slotTable } = this._buildTables(g, slotPresets);
    let maxLeavesPerTree = 1;
    for (const [, info] of slotTable) maxLeavesPerTree = Math.max(maxLeavesPerTree, info.count);
    if (maxLeavesPerTree === 1 && tableArr.length === 0) return; // nothing to draw, ever

    const entry = {
      key,
      group: g,
      cardGen: g.cardGen,
      tableArrData: tableArr,
      slotTable,
      slotSet: new Set(slotTable.keys()),
      maxLeavesPerTree,
      treeCap: 1024,
      leafSlotCap: pow2(Math.max(65536, maxLeavesPerTree * 1024)),
      visCap: VIS_CAP,
      treeCount: 0,
      leafCount: 0,
      uLeafCountF: uniform(0),
      uVisCapF: uniform(VIS_CAP),
      uBounds: uniformArray(
        Array.from({ length: MAX_MERGED_SLOTS }, () => new THREE.Vector4(0, 4, 0, 6)),
      ),
    };
    this.entries.set(key, entry);
    this._syncBounds(entry, slotPresets);
    this._allocEntry(entry);
  }

  _syncBounds(entry, slotPresets) {
    for (const [si, info] of entry.slotTable) {
      const b = slotPresets[si]?.bounds;
      const v = entry.uBounds.array[info.memberIdx];
      if (b?.canopyCenter) v.set(b.canopyCenter.x, b.canopyCenter.y, b.canopyCenter.z, b.aoRadius ?? 6);
      else v.set(0, 4, 0, 6);
    }
  }

  /** Allocate buffers/computes/mesh for the entry's current caps. */
  _allocEntry(entry) {
    const u = this.u;
    const g = entry.group;

    // ── CPU-written static buffers ──
    entry.treeAAttr = new THREE.StorageBufferAttribute(new Float32Array(entry.treeCap * 4), 4);
    entry.treeBAttr = new THREE.StorageBufferAttribute(new Float32Array(entry.treeCap * 4), 4);
    entry.leafToTreeAttr = new THREE.StorageBufferAttribute(new Uint32Array(entry.leafSlotCap), 1);
    entry.tableAttr = new THREE.StorageBufferAttribute(entry.tableArrData, 4);

    const treeA = storage(entry.treeAAttr, "vec4", entry.treeCap).toReadOnly();
    const treeB = storage(entry.treeBAttr, "vec4", entry.treeCap).toReadOnly();
    const leafToTree = storage(entry.leafToTreeAttr, "uint", entry.leafSlotCap).toReadOnly();
    const table = storage(entry.tableAttr, "vec4", entry.tableArrData.length / 4).toReadOnly();

    // ── GPU-only payload ──
    const payload = instancedArray(entry.visCap * 3, "vec4");

    // ── Geometry (union leaf card) + indirect args ──
    const geo = entry.group.cardGeometry.clone();
    const indirectData = new Uint32Array(5);
    indirectData[0] = geo.index.count;
    entry.indirectAttr = new THREE.IndirectStorageBufferAttribute(indirectData, 5);
    if (typeof geo.setIndirect === "function") geo.setIndirect(entry.indirectAttr);
    else geo.indirect = entry.indirectAttr;
    const indirectStorage = storage(entry.indirectAttr, "uint", 5).toAtomic();

    // ── Compute: reset + cull/expand ──
    entry.computeReset = Fn(() => {
      atomicStore(indirectStorage.element(1), uint(0));
    })().compute(1, [1]);

    entry.computeCull = Fn(() => {
      If(float(instanceIndex).lessThan(entry.uLeafCountF), () => {
        const packed = leafToTree.element(instanceIndex);
        const treeIdx = packed.shiftRight(uint(16));
        const liU = packed.bitAnd(uint(0xffff));
        const li = float(liU);
        const A = treeA.element(treeIdx);
        const B = treeB.element(treeIdx);

        const dx = A.x.sub(u.uCamPos.x);
        const dz = A.z.sub(u.uCamPos.z);
        const dist = length(vec2(dx, dz));

        // Continuous thinning: keepP = fade / sizeMul² keeps total canopy
        // coverage roughly constant as leaves drop out with distance.
        const sizeMul = float(1)
          .add(smoothstep(u.uLod0, u.uLod1, dist).mul(0.41421))
          .add(smoothstep(u.uLod1, u.uFadeMid, dist).mul(0.58579));
        const fade = float(1).sub(smoothstep(u.uFade0, u.uFade1, dist));
        const keepP = fade.div(sizeMul.mul(sizeMul));

        If(li.lessThan(keepP.mul(B.w)), () => {
          const scale = A.w;
          const cy = cos(B.x);
          const sy = sin(B.x);
          const rot = (v) => vec3(
            v.x.mul(cy).add(v.z.mul(sy)),
            v.y,
            negate(v.x).mul(sy).add(v.z.mul(cy)),
          );
          const bounds = entry.uBounds.element(int(B.y.add(0.5)));
          const treePos = vec3(A.x, A.y, A.z);
          const treeCenterW = treePos.add(rot(bounds.xyz).mul(scale));
          const radius = bounds.w.mul(scale).mul(1.3).add(float(1));
          const vis = computeFrustumVisibility(
            treeCenterW, u.uCamMatrix, u.uFx, u.uFy, radius,
            u.uCullPadNdcX, u.uCullPadNdcYNear, u.uCullPadNdcYFar,
          );
          // NEAR OVERRIDE: with the camera beside/inside a canopy, the NDC
          // test of its CENTER goes degenerate (behind the near plane /
          // off-screen) and culled the leaves right in front of the player.
          // Any tree the camera could be touching is always visible.
          const nearVis = step(dist, radius.add(float(12)));
          If(vis.add(nearVis).greaterThan(0.5), () => {
            const tableIdx = uint(B.z.add(0.5)).add(liU);
            const t0 = table.element(tableIdx.mul(uint(2)));
            const t1 = table.element(tableIdx.mul(uint(2)).add(uint(1)));
            const leafW = treePos.add(rot(t0.xyz).mul(scale));
            const slot = atomicAdd(indirectStorage.element(1), uint(1));
            If(slot.lessThan(uint(entry.visCap)), () => {
              const p = slot.mul(uint(3));
              payload.element(p).assign(vec4(leafW, t0.w.mul(scale).mul(sizeMul)));
              payload.element(p.add(uint(1))).assign(vec4(t1.x, t1.y, t1.z, B.y));
              payload.element(p.add(uint(2))).assign(vec4(treeCenterW, 1));
            });
          });
        });
      });
    })().compute(entry.leafSlotCap, [CULL_WORKGROUP]);

    // ── Material: merged foliage graph fed from the payload buffer ──
    const pi = instanceIndex.mul(uint(3));
    const p0 = payload.element(pi);
    const p1 = payload.element(pi.add(uint(1)));
    const p2 = payload.element(pi.add(uint(2)));
    // Overflow gate: instances past visCap have no payload — collapse them.
    const capGate = step(float(instanceIndex), entry.uVisCapF.sub(0.5));
    const built = createMergedFoliageMaterial({
      atlasGrid: this._atlasGridOf(g),
      sharedArrays: g.arrays,
      data: {
        rand: p1.xy,
        leafCenterW: p0.xyz,
        treeCenterW: p2.xyz,
        leafSize: p0.w.mul(capGate),
        heightFrac: p1.z,
        slotId: int(p1.w.add(0.5)),
      },
    });
    entry.material = built.material;
    entry.uniforms = built.uniforms;
    entry.leafMapNode = built.leafMapNode;
    const tex = g.leafMapNode.value;
    if (tex) {
      setFoliageTexture({ leafMapNode: built.leafMapNode, uniforms: built.uniforms }, tex);
      built.uniforms.maskInAlpha.value = 0; // shared atlas mask lives in RED
    }
    entry.material.roughness = g.material?.roughness ?? 0.88;

    entry.mesh = new THREE.Mesh(geo, entry.material);
    entry.mesh.count = entry.visCap;
    entry.mesh.frustumCulled = false;
    entry.mesh.castShadow = true;
    entry.mesh.receiveShadow = false;
    entry.mesh.name = `LeafField:${entry.key}`;
    this.scene.add(entry.mesh);
  }

  _atlasGridOf(g) {
    const v = g.uniforms.atlasGrid.value;
    return [v.x, v.y, v.z, v.w];
  }

  _disposeEntry(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.mesh) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.material.dispose();
    }
    this.entries.delete(key);
  }

  // ── Static repack (CPU → storage buffers) ──────────────────────────────────

  _repackAll(treeStore) {
    for (const [, entry] of this.entries) this._repackEntry(entry, treeStore);
    this._lastGen = treeStore.globalGen;
  }

  _repackEntry(entry, treeStore) {
    const trees = [];
    for (const [, arr] of treeStore.chunks) {
      for (const t of arr) if (entry.slotSet.has(t.slotIdx)) trees.push(t);
    }
    if (trees.length > MAX_TREES) {
      console.warn(`[LeafField] ${entry.key}: ${trees.length} trees > ${MAX_TREES} — extra trees not rendered`);
      trees.length = MAX_TREES;
    }

    // Capacity growth: rebuild the entry with bigger buffers (rare).
    let leafSlots = 0;
    for (const t of trees) leafSlots += entry.slotTable.get(t.slotIdx)?.count ?? 0;
    if (trees.length > entry.treeCap || leafSlots > entry.leafSlotCap) {
      entry.treeCap = pow2(trees.length);
      entry.leafSlotCap = pow2(leafSlots);
      this._disposeEntryKeepMeta(entry);
      this._allocEntry(entry);
    }

    const a = entry.treeAAttr.array;
    const b = entry.treeBAttr.array;
    const l2t = entry.leafToTreeAttr.array;
    let cursor = 0;
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      const info = entry.slotTable.get(t.slotIdx);
      a[i * 4] = t.x;
      a[i * 4 + 1] = t.y ?? 0;
      a[i * 4 + 2] = t.z;
      a[i * 4 + 3] = t.scale;
      b[i * 4] = t.rotY;
      b[i * 4 + 1] = info.memberIdx;
      b[i * 4 + 2] = info.offset;
      b[i * 4 + 3] = info.count;
      const packedBase = i << 16;
      for (let li = 0; li < info.count; li++) l2t[cursor++] = packedBase | li;
    }
    entry.treeCount = trees.length;
    entry.leafCount = cursor;
    entry.uLeafCountF.value = cursor;
    entry.treeAAttr.needsUpdate = true;
    entry.treeBAttr.needsUpdate = true;
    entry.leafToTreeAttr.needsUpdate = true;
    if (cursor === 0 && entry.indirectAttr) {
      // Nothing to cull: computes are skipped, so zero the draw on the CPU.
      entry.indirectAttr.array[1] = 0;
      entry.indirectAttr.needsUpdate = true;
    }
  }

  _disposeEntryKeepMeta(entry) {
    if (entry.mesh) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.material.dispose();
      entry.mesh = null;
    }
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────

  update(treeStore, camera, lodCfg) {
    if (this.entries.size === 0) return;

    // Debounced repack on store edits (paint strokes bump gen per stamp).
    if (treeStore.globalGen !== this._lastGen) {
      this._lastGen = treeStore.globalGen;
      this._repackAt = performance.now() + REPACK_DEBOUNCE;
    }
    if (this._repackAt && performance.now() >= this._repackAt) {
      this._repackAt = 0;
      this._repackAll(treeStore);
    }

    const u = this.u;
    camera.updateMatrixWorld();
    this._viewInv.copy(camera.matrixWorld).invert();
    u.uCamMatrix.value.multiplyMatrices(camera.projectionMatrix, this._viewInv);
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    const e = camera.projectionMatrix.elements;
    u.uFx.value = e[0];
    u.uFy.value = e[5];

    const d0 = lodCfg.lod0Distance ?? 80;
    const d1 = lodCfg.lod1Distance ?? 200;
    const dF = lodCfg.fadeOutDistance ?? 600;
    u.uLod0.value = d0;
    u.uLod1.value = d1;
    u.uFadeMid.value = d1 + (dF - d1) * 0.55;
    u.uFade0.value = dF - 40;
    u.uFade1.value = dF + 20;

    const computes = [];
    for (const [, entry] of this.entries) {
      if (entry.leafCount === 0 || !entry.mesh) continue;
      computes.push(entry.computeReset, entry.computeCull);
    }
    if (computes.length) this.renderer.compute(computes);
  }

  updateTime(t) {
    for (const [, entry] of this.entries) {
      if (entry.uniforms) entry.uniforms.time.value = t;
    }
  }

  setSunDir(x, y, z) {
    for (const [, entry] of this.entries) {
      if (entry.uniforms) entry.uniforms.sunDir.value.set(x, y, z).normalize();
    }
  }

  dispose() {
    for (const key of [...this.entries.keys()]) this._disposeEntry(key);
  }
}
