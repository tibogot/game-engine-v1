/**
 * GPU leaf field — indirect-drawn tree canopies (susukiSystem pattern).
 *
 * Two entry kinds share the same architecture:
 *   "group" — atlas merge groups: BILLBOARD cards, merged foliage material
 *             bound to the group's shared param uniform-array.
 *   "pine"  — per-slot pine-editor presets: ORIENTED cards (baked whorl
 *             quaternions), classic per-slot foliage material with pineMode
 *             shading; its uniforms mirror the preset's own every frame so
 *             panel edits flow through.
 *
 * Per frame one compute pass per entry walks every leaf slot, culls by
 * camera frustum + distance, and appends survivors to a compact payload
 * buffer; the indirect instanceCount comes straight from the GPU atomic.
 *
 * LOD is CONTINUOUS (replaces the chunked renderer's 3 cell tiers): leaf
 * tables are stored pre-shuffled and a tree at distance d keeps the first
 * keepP(d)·count entries while survivors grow by 1/sqrt(keepP). For pines
 * this is the fix for "LOD1 big-leaf popping": density thins card-by-card,
 * evenly around the whorls, with no discrete jump.
 *
 * Static data (rewritten on tree edits, debounced like the impostor field):
 *   treeA[i]      vec4  (x, y, z, scale)
 *   treeB[i]      vec4  (rotY, memberIdx, tableOffset, leafCount)
 *   leafToTree[k] uint  (treeIdx << 16 | leafIdx)   — exact dispatch mapping
 *   table         vec4× TABLE_STRIDE per leaf:
 *     group: (local xyz, size), (rand.xy, heightFrac, 0)
 *     pine:  (local xyz, size), (card quat), (rand.xy, heightFrac, 0)
 * Payload (compute-written, visCap × PAYLOAD_STRIDE vec4):
 *   (leafCenterW, size·scale·sizeMul), (rand, heightFrac, memberIdx),
 *   (treeCenterW, 1)[, (world quat — tree yaw ∘ card quat)]
 *
 * Terrain-normal tree tilt (t.nx/nz) is NOT applied (yaw only).
 */
import * as THREE from "three";
import {
  Fn, If, atomicAdd, atomicStore, cos, float, instanceIndex,
  instancedArray, int, length, negate, sin, smoothstep, step, storage,
  uint, uniform, uniformArray, vec2, vec3, vec4,
} from "three/tsl";
import {
  createFoliageMaterial,
  createMergedFoliageMaterial,
  setFoliageTexture,
  MAX_MERGED_SLOTS,
} from "../../../v2/render/foliage/foliageMaterial.js";

/**
 * Sphere-vs-frustum in NDC with SYMMETRIC radius padding. Deliberately NOT
 * revoGrass's computeFrustumVisibility: that one SUBTRACTS the radius from
 * the screen-top margin (for ground grass, anything projecting near the top
 * is far away), which for a TALL tree culled the whole canopy while it was
 * still on screen — the "leaves disappear when I get close and look down"
 * play-mode bug. Here the radius always widens acceptance on every side.
 */
const treeFrustumVisibility = Fn(
  ([worldPos, cameraMatrix, fx, fy, radius, padX, padY]) => {
    const one = float(1);
    const clip = cameraMatrix.mul(vec4(worldPos, 1));
    const invW = one.div(clip.w);
    const ndc = clip.xyz.mul(invW);
    const eyeDepthAbs = clip.w.abs().max(float(1e-6));
    const rx = fx.mul(radius).div(eyeDepthAbs).add(padX);
    const ry = fy.mul(radius).div(eyeDepthAbs).add(padY);
    const visX = step(ndc.x.abs(), one.add(rx));
    const visY = step(ndc.y.abs(), one.add(ry));
    const visZ = step(float(-1), ndc.z).mul(step(ndc.z, one));
    return visX.mul(visY).mul(visZ);
  },
);

const REPACK_DEBOUNCE = 250;   // ms — coalesce per-stamp gen bumps while painting
const VIS_CAP = 300000;        // max on-screen leaves per entry (payload budget)
const MAX_TREES = 65535;       // treeIdx packs into 16 bits
const CULL_WORKGROUP = 64;

function pow2(n) {
  let c = 1024;
  while (c < n) c *= 2;
  return c;
}

/** Deterministic shuffle — the cull keeps a PREFIX of the table, so stored
 *  order must be spatially uniform (cluster/whorl order would thin unevenly). */
function shuffledOrder(n) {
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
  return order;
}

export class LeafFieldRenderer {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    /** entryKey ("g:<mergeKey>" | "p:<slotIdx>") -> field entry */
    this.entries = new Map();
    /** Slot indices whose leaves this field draws (chunked path skips them).
     *  Mutated in place — consumers can hold a reference. */
    this.claimedSlots = new Set();

    // Camera/LOD uniforms shared by every entry's compute.
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
      uCullPadNdcY: uniform(0.5),
    };

    this._viewInv = new THREE.Matrix4();
    this._lastGen = -1;
    this._repackAt = 0;
    this._treeStore = null;
  }

  // ── Entry sync ─────────────────────────────────────────────────────────────

  /**
   * (Re)build field entries from the renderer's merge groups AND stand-alone
   * pine slots. Call after any preset load/clear.
   */
  syncGroups(mergeGroups, slotPresets, treeStore) {
    this._treeStore = treeStore;

    const want = new Map(); // entryKey -> descriptor
    for (const [key, g] of mergeGroups.groups) {
      want.set("g:" + key, { kind: "group", group: g, rev: g.cardGen });
    }
    slotPresets.forEach((preset, si) => {
      if (!preset?.pineLayout || !preset.lods?.[0]) return;
      want.set("p:" + si, { kind: "pine", si, preset, rev: preset });
    });

    for (const key of [...this.entries.keys()]) {
      if (!want.has(key)) this._disposeEntry(key);
    }
    for (const [key, desc] of want) {
      const existing = this.entries.get(key);
      if (existing && existing.rev === desc.rev) continue;
      this._disposeEntry(key);
      this._createEntry(key, desc, slotPresets);
    }

    this.claimedSlots.clear();
    for (const [, entry] of this.entries) {
      for (const si of entry.slotSet) this.claimedSlots.add(si);
    }

    if (treeStore) this._repackAll(treeStore);
  }

  // ── Leaf tables ────────────────────────────────────────────────────────────

  /** Group tables: every member slot's billboard leaves (2 vec4/leaf). */
  _buildGroupTables(g, slotPresets) {
    const rows = [];
    const slotTable = new Map();
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
      const offset = rows.length / 2;
      const c = lod0.centerData, s = lod0.scaleData, r = lod0.randData;
      for (const src of shuffledOrder(n)) {
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

  /** Pine table: one slot's oriented cards (3 vec4/leaf, quat from the
   *  baked local instance matrix). */
  _buildPineTable(si, preset) {
    const lod0 = preset.lods[0];
    const n = lod0.count;
    const bYMin = (preset.bounds && preset.bounds.yMin) ?? 0;
    const bRange = Math.max(((preset.bounds && preset.bounds.yMax) ?? 8) - bYMin, 0.001);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const rows = [];
    const c = lod0.centerData, sd = lod0.scaleData, r = lod0.randData;
    for (const src of shuffledOrder(n)) {
      m.fromArray(lod0.matrices, src * 16);
      m.decompose(p, q, s);
      const ly = c[src * 3 + 1];
      rows.push(
        [c[src * 3], ly, c[src * 3 + 2], sd[src]],
        [q.x, q.y, q.z, q.w],
        [r[src * 2], r[src * 2 + 1],
         Math.min(1, Math.max(0, (ly - bYMin) / bRange)), 0],
      );
    }
    const arr = new Float32Array(rows.length * 4);
    rows.forEach((row, i) => arr.set(row, i * 4));
    const slotTable = new Map([[si, { offset: 0, count: n, memberIdx: 0 }]]);
    return { tableArr: arr, slotTable };
  }

  _createEntry(key, desc, slotPresets) {
    const oriented = desc.kind === "pine";
    const { tableArr, slotTable } = oriented
      ? this._buildPineTable(desc.si, desc.preset)
      : this._buildGroupTables(desc.group, slotPresets);
    let maxLeavesPerTree = 1;
    for (const [, info] of slotTable) maxLeavesPerTree = Math.max(maxLeavesPerTree, info.count);
    if (tableArr.length === 0) return;

    const entry = {
      key,
      kind: desc.kind,
      rev: desc.rev,
      group: desc.group ?? null,
      preset: desc.preset ?? null,
      si: desc.si,
      tableStride: oriented ? 3 : 2,
      payloadStride: oriented ? 4 : 3,
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
    const oriented = entry.kind === "pine";
    const TS = entry.tableStride;
    const PS = entry.payloadStride;

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
    const payload = instancedArray(entry.visCap * PS, "vec4");

    // ── Geometry + indirect args ──
    const geo = this._entryCardGeometry(entry);
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
          const vis = treeFrustumVisibility(
            treeCenterW, u.uCamMatrix, u.uFx, u.uFy, radius,
            u.uCullPadNdcX, u.uCullPadNdcY,
          );
          // NEAR OVERRIDE: with the camera beside/inside a canopy, the NDC
          // test of its CENTER goes degenerate (behind the near plane /
          // off-screen) and culled the leaves right in front of the player.
          const nearVis = step(dist, radius.add(float(12)));
          If(vis.add(nearVis).greaterThan(0.5), () => {
            const tableIdx = uint(B.z.add(0.5)).add(liU).mul(uint(TS));
            const t0 = table.element(tableIdx);
            const leafW = treePos.add(rot(t0.xyz).mul(scale));
            const slot = atomicAdd(indirectStorage.element(1), uint(1));
            If(slot.lessThan(uint(entry.visCap)), () => {
              const p = slot.mul(uint(PS));
              const tRand = table.element(tableIdx.add(uint(TS - 1)));
              payload.element(p).assign(vec4(leafW, t0.w.mul(scale).mul(sizeMul)));
              payload.element(p.add(uint(1))).assign(vec4(tRand.x, tRand.y, tRand.z, B.y));
              payload.element(p.add(uint(2))).assign(vec4(treeCenterW, 1));
              if (oriented) {
                // World card orientation = tree yaw ∘ baked card quat.
                // yaw quat = (0, sh, 0, ch); composed inline.
                const cq = table.element(tableIdx.add(uint(1)));
                const half = B.x.mul(0.5);
                const sh = sin(half);
                const ch = cos(half);
                payload.element(p.add(uint(3))).assign(vec4(
                  ch.mul(cq.x).add(sh.mul(cq.z)),
                  ch.mul(cq.y).add(sh.mul(cq.w)),
                  ch.mul(cq.z).sub(sh.mul(cq.x)),
                  ch.mul(cq.w).sub(sh.mul(cq.y)),
                ));
              }
            });
          });
        });
      });
    })().compute(entry.leafSlotCap, [CULL_WORKGROUP]);

    // ── Material: shared foliage graph fed from the payload buffer ──
    const pi = instanceIndex.mul(uint(PS));
    const p0 = payload.element(pi);
    const p1 = payload.element(pi.add(uint(1)));
    const p2 = payload.element(pi.add(uint(2)));
    // Overflow gate: instances past visCap have no payload — collapse them.
    const capGate = step(float(instanceIndex), entry.uVisCapF.sub(0.5));
    const data = {
      rand: p1.xy,
      leafCenterW: p0.xyz,
      treeCenterW: p2.xyz,
      leafSize: p0.w.mul(capGate),
      heightFrac: p1.z,
      slotId: int(p1.w.add(0.5)),
    };
    if (oriented) data.cardQuat = payload.element(pi.add(uint(3)));

    let built;
    if (oriented) {
      built = createFoliageMaterial({ pineLayout: true, data });
    } else {
      built = createMergedFoliageMaterial({
        atlasGrid: this._atlasGridOf(entry.group),
        sharedArrays: entry.group.arrays,
        data,
      });
    }
    entry.material = built.material;
    entry.uniforms = built.uniforms;
    entry.leafMapNode = built.leafMapNode;
    this._syncEntryMaterial(entry);

    entry.mesh = new THREE.Mesh(geo, entry.material);
    entry.mesh.count = entry.visCap;
    entry.mesh.frustumCulled = false;
    entry.mesh.castShadow = true;
    entry.mesh.receiveShadow = false;
    entry.mesh.name = `LeafField:${entry.key}`;
    this.scene.add(entry.mesh);
  }

  /** Bare per-card geometry for the entry's mesh. */
  _entryCardGeometry(entry) {
    if (entry.kind === "group") return entry.group.cardGeometry.clone();
    // Pine: the lods[0] geometry is the trimmed card PLUS instanced attrs —
    // strip them (the field feeds instance data from the payload buffer).
    const geo = entry.preset.lods[0].geometry.clone();
    for (const name of ["aRand", "aLeafCenter", "aTreeCenter", "aLeafScale"]) {
      if (geo.getAttribute(name)) geo.deleteAttribute(name);
    }
    return geo;
  }

  /** Texture + per-frame-safe material state from the entry's source. */
  _syncEntryMaterial(entry) {
    if (entry.kind === "group") {
      const g = entry.group;
      const tex = g.leafMapNode.value;
      if (tex && entry.leafMapNode.value !== tex) {
        setFoliageTexture({ leafMapNode: entry.leafMapNode, uniforms: entry.uniforms }, tex);
        entry.uniforms.maskInAlpha.value = 0; // shared atlas mask lives in RED
      }
      entry.material.roughness = g.material?.roughness ?? 0.88;
      return;
    }
    // Pine: mirror EVERY same-named uniform from the preset's own material —
    // panel edits, wind, sun, pineMode/pivotAo/etc. all flow through.
    const src = entry.preset.uniforms;
    const dst = entry.uniforms;
    for (const k in src) {
      const s = src[k];
      const d = dst[k];
      if (!s || !d) continue;
      if (s.value && s.value.isColor) d.value.copy(s.value);
      else if (s.value && s.value.isVector4) d.value.copy(s.value);
      else if (s.value && s.value.isVector3) d.value.copy(s.value);
      else if (s.value && s.value.isVector2) d.value.copy(s.value);
      else if (typeof s.value === "number") d.value = s.value;
    }
    const tex = entry.preset.leafMapNode?.value;
    if (tex && entry.leafMapNode.value !== tex) entry.leafMapNode.value = tex;
    entry.material.roughness = entry.preset.material?.roughness ?? 0.88;
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
      if (entry.kind === "pine") this._syncEntryMaterial(entry);
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
    this.claimedSlots.clear();
  }
}
