/**
 * v3/tools/riverV3/riverV3System.js — River v3: a river NETWORK in the editor.
 *
 * Built BESIDE River v2, which is untouched. What changes is the model:
 * reaches joined at junctions (riverV3Network.js), so tributaries, splits and
 * deltas are one connected system whose levels meet, whose water adds up and
 * whose channels merge (riverV3Terrain.js). What is shared on purpose is the
 * look: the water surface runs River v2's shader (riverV2Material.js) with
 * River v2's look parameters, so the two can never drift apart.
 *
 * Terrain is the "riverV3" operator of the height stack (heightLayers.js):
 * the river reads GROUND and shapes only its own footprint.
 *
 * EDITING (mode "riverv3"):
 *   click terrain           append to the active reach (or prepend when its
 *                           FIRST node is selected; or start a reach)
 *   …onto another reach     the new end JOINS it: that reach is split at the
 *                           point and a junction made — drawing downstream
 *                           onto a river makes a tributary, drawing upstream
 *                           from one makes a branch out of it
 *   node selected + click   (an interior node, or an end sitting on a junction)
 *                           starts a new reach out of that point: a branch
 *   drag a node / junction  moves it; a junction drags every reach end on it
 *   Delete                  removes the selected node / junction
 */

import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { attribute } from "three/tsl";
import { WORLD_SIZE, MAX_HEIGHT, HEIGHTMAP_SIZE } from "../../terrain/heightmapTexture.js";
import { createRiverMaterial } from "../../render/water/riverV2Material.js";
import { riverWaterParams } from "../../app/state/riverV2State.js";
import { buildFlowIndex, sampleFlow, sampleFlowAt } from "../riverV2Channel.js";
import { shareInstancePipeline } from "../../render/instancePipeline.js";
import { solveNetwork } from "./riverV3Network.js";
import { packReaches, buildRiverV3TerrainOp, snapshotReaches, networkDirtyRect } from "./riverV3Terrain.js";

const LAYER = "riverV3";
const MAX_UNDO = 64;
const ARROW_SPACING = 14;
const RIBBON_OVERHANG = 2.5;
const CULL_ROWS = 16;
const CULL_SLACK = 4;
/** Metres beyond a reach's half width within which a click JOINS it. */
const JOIN_SLACK = 3;

const COL_ACTIVE = 0x7fe9ff, COL_IDLE = 0x2c7f96, COL_PINNED = 0xffc04a, COL_SELECTED = 0xffffff;
const COL_JUNCTION = 0xff7a3d, COL_WIDTH = 0x8cff9a, COL_LEVEL = 0xffd166;

const _cullMat = new THREE.Matrix4();
const _cullFrustum = new THREE.Frustum();

export class RiverV3System {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {object}      deps.toolState       carries a `.riverV3` slice
   * @param {object}      deps.heightLayers    the terrain stack
   * @param {THREE.Texture} deps.waterNormalMap
   * @param {function}    [deps.getCamera]
   * @param {function}    [deps.onConformCommitted]
   * @param {function}    [deps.onWaterMeshesChanged]
   */
  constructor({ scene, toolState, heightLayers, waterNormalMap, getCamera = null, onConformCommitted = null, onWaterMeshesChanged = null }) {
    this.scene = scene;
    this.toolState = toolState;
    this.layers = heightLayers;
    this.getCamera = getCamera;
    this.onConformCommitted = onConformCommitted;
    this.onWaterMeshesChanged = onWaterMeshesChanged;

    /** @type {{id:number,x:number,z:number,y:number|null}[]} */
    this.junctions = [];
    /** @type {{id:number,nodes:object[],from:number|null,to:number|null,q:number|null}[]} */
    this.reaches = [];
    this._nextId = 1;
    this.activeReachId = null;
    /** { kind: "node", reachId, nodeIdx } | { kind: "junction", junctionId } | null */
    this.selected = null;
    this.dragging = false;
    this._drag = null;
    this.editActive = false;
    this._undo = [];
    this._redo = [];
    this._time = 0;

    this.sol = null;
    this._flowIndex = null;
    this._flowIds = [];
    this._lastSnap = null;
    /** reach id → { x, z }: open mouths (a waterfall takes the water there). */
    this._openMouths = new Map();
    /** reach id → { mesh, cullChunks } */
    this._meshes = new Map();

    this.group = new THREE.Group(); this.group.name = "RiverV3"; scene.add(this.group);
    this.handleGroup = new THREE.Group(); this.handleGroup.name = "RiverV3Handles"; this.handleGroup.visible = false; scene.add(this.handleGroup);
    this.arrowGroup = new THREE.Group(); this.arrowGroup.name = "RiverV3Arrows"; this.arrowGroup.visible = false; scene.add(this.arrowGroup);

    this._waterNormalMap = waterNormalMap;
    this._water = createRiverMaterial({ normalMap: waterNormalMap });
    this._grabFree = false;

    this._geoNode = new THREE.SphereGeometry(1, 12, 8);
    this._geoJunction = new THREE.OctahedronGeometry(1.5, 0);
    this._geoWidth = new THREE.OctahedronGeometry(1, 0);
    this._geoLevel = new THREE.ConeGeometry(0.7, 2, 8);
    this._matCache = new Map();
    const cone = new THREE.ConeGeometry(0.45, 1.5, 7); cone.rotateX(Math.PI / 2); cone.translate(0, 0, 0.2);
    this._geoArrow = cone;
    const arrowMat = new MeshBasicNodeMaterial();
    arrowMat.colorNode = attribute("aColor", "vec3");
    arrowMat.fog = false;
    this._arrowMat = arrowMat;

    this.syncMaterial();
  }

  get params() { return this.toolState.riverV3; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lookups
  // ═══════════════════════════════════════════════════════════════════════════

  reach(id) { return this.reaches.find((r) => r.id === id) ?? null; }
  junction(id) { return this.junctions.find((j) => j.id === id) ?? null; }
  get activeReach() { return this.reach(this.activeReachId); }
  get meshes() { return [...this._meshes.values()].map((m) => m.mesh).filter(Boolean); }

  /** Ground under the river (GROUND of the height stack), metres. */
  sampleBase(wx, wz) {
    const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE, v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
    return this.layers.sampleGroundNormalized(u, v) * MAX_HEIGHT;
  }

  /** What the water is doing at (x, z) — River v2's query, over the network. */
  sampleFlow(x, z) {
    const f = sampleFlow(this._flowIndex, x, z);
    if (f) f.reachId = this._flowIds[f.riverIndex] ?? null;
    return f;
  }
  sampleFlowAt(x, y, z) { return sampleFlowAt(this._flowIndex, x, y, z); }

  // ═══════════════════════════════════════════════════════════════════════════
  // Solve + conform
  // ═══════════════════════════════════════════════════════════════════════════

  _conformParams() {
    const p = this.params;
    const slope = Math.max(0.02, p.maxBankSlope ?? 0.9);
    return {
      bedCurve: p.bedCurve ?? 0.55,
      freeboardN: (p.freeboard ?? 0.6) / MAX_HEIGHT,
      lipFrac: Math.min(0.9, Math.max(0.02, p.lipFraction ?? 0.28)),
      slopeToUv: MAX_HEIGHT / (slope * WORLD_SIZE),
      flareMax: Math.max(1, p.bankFlareMax ?? 4),
    };
  }

  /**
   * Solve the network, hand the height stack the new operator (recomposing
   * only where it changed), rebuild the water.
   * @param {{rebuild?:boolean, commit?:boolean}} [opts]
   */
  applyConform({ rebuild = true, commit = true } = {}) {
    const live = this.reaches.filter((r) => r.nodes.length >= 2);
    if (!live.length) {
      this.sol = null; this._flowIndex = null; this._flowIds = []; this._lastSnap = null;
      if (this.layers.operator(LAYER)) this.layers.setOperator(LAYER, null);
      if (rebuild) this._rebuildVisual();
      if (commit) this.onConformCommitted?.();
      return;
    }
    this.sol = solveNetwork({
      junctions: this.junctions, reaches: live,
      sampleGround: (x, z) => this.sampleBase(x, z), params: this.params,
    });
    const list = live.filter((r) => this.sol.reaches.has(r.id))
      .map((r) => ({ id: r.id, solved: this.sol.reaches.get(r.id), mouth: this._openMouths.get(r.id) ?? null }));
    this._flowIds = list.map((e) => e.id);
    this._flowIndex = buildFlowIndex(list.map((e) => e.solved), { worldSize: WORLD_SIZE, bedCurve: this.params.bedCurve });

    const packed = packReaches(list, { worldSize: WORLD_SIZE, maxHeight: MAX_HEIGHT });
    const u = this._conformParams();
    const op = buildRiverV3TerrainOp({ packed, size: HEIGHTMAP_SIZE, u });
    const snap = op ? snapshotReaches(packed, op.maxReach, JSON.stringify(u)) : null;
    const dirty = this.layers.operator(LAYER) ? networkDirtyRect(this._lastSnap, snap, HEIGHTMAP_SIZE) : null;
    this._lastSnap = snap;
    this.layers.setOperator(LAYER, op, dirty);

    if (rebuild) this._rebuildVisual();
    if (commit) this.onConformCommitted?.();
  }

  refreshConform() { this.applyConform({ commit: true }); }

  // ── Mouths: where a reach hands its water to a waterfall (as River v2) ────

  /**
   * The downstream end of a FREE reach (one that ends on no junction) as a
   * waterfall lip: `{ x, y, z, yaw, width, speed, depth }`, or null.
   */
  mouthOf(reachId) {
    const r = this.reach(reachId), s = this.sol?.reaches.get(reachId);
    if (!r || r.to != null || !s || s.count < 2) return null;
    const n = s.count - 1;
    return { x: s.x[n], y: s.level[n], z: s.z[n], yaw: Math.atan2(s.tanX[n], s.tanZ[n]), width: s.width[n], speed: s.speed[n], depth: s.depth[n] };
  }

  /** Every free reach end: [{ id, ...mouthOf }]. */
  mouths() {
    const out = [];
    for (const r of this.reaches) { const m = this.mouthOf(r.id); if (m) out.push({ id: r.id, ...m }); }
    return out;
  }

  /**
   * Open (a fall takes the water; the channel runs to the LIP at x, z and stops
   * dead) or close a reach's mouth. Re-conforms.
   */
  setMouthOpen(reachId, open, x = null, z = null) {
    const had = this._openMouths.get(reachId) ?? null;
    if (!open) {
      if (!had) return;
      this._openMouths.delete(reachId);
    } else {
      const s = this.sol?.reaches.get(reachId), n = s ? s.count - 1 : 0;
      const next = { x: Number.isFinite(x) ? x : s?.x[n], z: Number.isFinite(z) ? z : s?.z[n] };
      if (!Number.isFinite(next.x)) return;
      if (had && had.x === next.x && had.z === next.z) return;
      this._openMouths.set(reachId, next);
    }
    if (this.reach(reachId)) this.applyConform({ commit: true });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Water surface (River v2's shader, one ribbon per reach)
  // ═══════════════════════════════════════════════════════════════════════════

  _buildRibbon(reach, s) {
    const old = this._meshes.get(reach.id);
    if (old?.mesh) { this.group.remove(old.mesh); old.mesh.geometry.dispose(); }
    this._meshes.delete(reach.id);
    if (!s || s.count < 2) return;

    const p = this.params;
    const drop = p.surfaceDrop ?? 0.05;
    const step = Math.max(0.25, p.meshStep ?? 0.8);
    const cols = Math.max(2, Math.round(p.meshAcross ?? 12));
    const rows = Math.max(2, Math.min(4096, Math.round(s.total / step) + 1));
    const vCount = rows * (cols + 1);
    const pos = new Float32Array(vCount * 3), uvs = new Float32Array(vCount * 2);
    const flow = new Float32Array(vCount * 4), wave = new Float32Array(vCount * 2);
    let si = 0;
    for (let r = 0; r < rows; r++) {
      const arc = (r / (rows - 1)) * s.total;
      while (si < s.count - 2 && s.arc[si + 1] < arc) si++;
      const a0 = s.arc[si], a1 = s.arc[si + 1];
      const t = a1 > a0 ? Math.min(1, Math.max(0, (arc - a0) / (a1 - a0))) : 0;
      const lerp = (arr) => arr[si] + (arr[si + 1] - arr[si]) * t;
      const cx = lerp(s.x), cz = lerp(s.z);
      let tx = lerp(s.tanX), tz = lerp(s.tanZ);
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const px = -tz, pz = tx;
      const halfW = lerp(s.width) * 0.5;
      const span = halfW + Math.min(lerp(s.bank) * 0.5, RIBBON_OVERHANG);
      const y = lerp(s.level) - drop;
      const spd = lerp(s.speed), tb = lerp(s.turb), dp = lerp(s.depth);
      for (let c = 0; c <= cols; c++) {
        const across = (c / cols - 0.5) * 2 * span;
        const v = r * (cols + 1) + c;
        pos[v * 3] = cx + px * across; pos[v * 3 + 1] = y; pos[v * 3 + 2] = cz + pz * across;
        uvs[v * 2] = arc; uvs[v * 2 + 1] = across;
        flow[v * 4] = tx; flow[v * 4 + 1] = tz; flow[v * 4 + 2] = spd; flow[v * 4 + 3] = halfW;
        wave[v * 2] = tb; wave[v * 2 + 1] = dp;
      }
    }
    const idx = new Uint32Array((rows - 1) * cols * 6);
    let o = 0;
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c, b = a + 1, d = a + cols + 1, e = d + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = d; idx[o++] = b; idx[o++] = e; idx[o++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.setAttribute("aFlow", new THREE.BufferAttribute(flow, 4));
    g.setAttribute("aWave", new THREE.BufferAttribute(wave, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius += 2;
    const mesh = new THREE.Mesh(g, this._water.material);
    mesh.name = `RiverV3:${reach.id}`;
    mesh.renderOrder = 10;
    mesh.userData.viewCulled = true;          // waterSurfaceMap restores the full range
    this.group.add(mesh);
    this._meshes.set(reach.id, { mesh, cullChunks: this._chunks(pos, rows, cols) });
    this._syncAddPass(mesh);
  }

  /** The grab-free water's ADD pass (riverV2Material `material2`), as River v2. */
  _syncAddPass(m) {
    const want = this._water.material2 ?? null;
    let add = m.userData.addPass ?? null;
    if (!want) { if (add) { m.remove(add); m.userData.addPass = null; } return; }
    if (!add) {
      add = new THREE.Mesh(m.geometry, want);
      add.name = m.name + ":add"; add.renderOrder = m.renderOrder + 0.5; add.frustumCulled = false;
      add.userData.isAddPass = true;
      m.add(add); m.userData.addPass = add;
    }
    add.geometry = m.geometry; add.material = want;
  }

  _chunks(pos, rows, cols) {
    const out = [], stride = cols + 1, box = new THREE.Box3(), p = new THREE.Vector3();
    for (let r0 = 0; r0 < rows - 1; r0 += CULL_ROWS) {
      const r1 = Math.min(rows - 1, r0 + CULL_ROWS);
      box.makeEmpty();
      for (let r = r0; r <= r1; r++) for (let c = 0; c <= cols; c++) {
        const v = (r * stride + c) * 3;
        box.expandByPoint(p.set(pos[v], pos[v + 1], pos[v + 2]));
      }
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      sphere.radius += CULL_SLACK;
      out.push({ sphere, box: box.clone().expandByScalar(CULL_SLACK), start: r0 * cols * 6, end: r1 * cols * 6 });
    }
    return out;
  }

  /** Draw only what the camera sees (see River v2: an unculled ribbon buys the full-screen water grabs). */
  cullForCamera(camera) {
    camera.updateMatrixWorld();
    _cullMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _cullFrustum.setFromProjectionMatrix(_cullMat, camera.coordinateSystem, camera.reversedDepth);
    let visible = 0;
    for (const { mesh, cullChunks } of this._meshes.values()) {
      let first = -1, last = -1;
      for (let i = 0; i < cullChunks.length; i++) {
        if (!_cullFrustum.intersectsSphere(cullChunks[i].sphere)) continue;
        if (!_cullFrustum.intersectsBox(cullChunks[i].box)) continue;
        if (first < 0) first = i;
        last = i;
      }
      mesh.visible = first >= 0;
      if (first >= 0) { mesh.geometry.setDrawRange(cullChunks[first].start, cullChunks[last].end - cullChunks[first].start); visible++; }
    }
    this._visibleCount = visible;
  }
  get visibleCount() { return this._visibleCount ?? this._meshes.size; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Handles + arrows
  // ═══════════════════════════════════════════════════════════════════════════

  _handleMat(color) {
    let m = this._matCache.get(color);
    if (!m) { m = new THREE.MeshBasicMaterial({ color, depthTest: true, fog: false }); this._matCache.set(color, m); }
    return m;
  }
  _handleScale() {
    const cam = this.getCamera?.();
    return cam ? Math.min(6, Math.max(0.45, cam.position.length() / 90)) : 1;
  }
  _clear(group) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const c = group.children[i];
      group.remove(c);
      if (c.isInstancedMesh) c.dispose?.();
    }
  }
  _nodeY(reach, k) {
    const nd = reach.nodes[k];
    if (Number.isFinite(nd.y)) return nd.y;
    const s = this.sol?.reaches.get(reach.id);
    if (s?.nodeLevel?.[k] != null) return s.nodeLevel[k];
    return this.sampleBase(nd.x, nd.z);
  }

  _rebuildHandles() {
    this._clear(this.handleGroup);
    if (!this.params.showHandles) return;
    const sc = this._handleScale();
    const onJunction = (r, k) => (k === 0 && r.from != null) || (k === r.nodes.length - 1 && r.to != null);
    for (const r of this.reaches) {
      const active = r.id === this.activeReachId;
      r.nodes.forEach((nd, k) => {
        if (onJunction(r, k)) return;               // the junction handle stands there
        const sel = this.selected?.kind === "node" && this.selected.reachId === r.id && this.selected.nodeIdx === k;
        const color = sel ? COL_SELECTED : Number.isFinite(nd.y) ? COL_PINNED : active ? COL_ACTIVE : COL_IDLE;
        const m = new THREE.Mesh(this._geoNode, this._handleMat(color));
        m.position.set(nd.x, this._nodeY(r, k), nd.z);
        m.scale.setScalar(sc * (active ? 1 : 0.75));
        m.userData = { kind: "node", reachId: r.id, nodeIdx: k };
        m.renderOrder = 950;
        this.handleGroup.add(m);
      });
    }
    // The selected node gets a width pair (green diamonds across the stream)
    // and a level cone (gold, above it); a selected junction gets the cone.
    // Only on the selection: on every node at once a river becomes a hedge.
    const sn = this.selectedNode();
    if (sn) {
      const y = this._nodeY(sn.reach, sn.nodeIdx), t = this._nodeTangent(sn.reach, sn.nodeIdx);
      const half = (sn.node.width ?? this.params.newWidth) * 0.5;
      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(this._geoWidth, this._handleMat(COL_WIDTH));
        m.position.set(sn.node.x - t.z * half * side, y, sn.node.z + t.x * half * side);
        m.scale.setScalar(sc * 0.8);
        m.userData = { kind: "width", reachId: sn.reach.id, nodeIdx: sn.nodeIdx, side };
        m.renderOrder = 951;
        this.handleGroup.add(m);
      }
      this._addLevelCone(sn.node.x, y, sn.node.z, sc, { kind: "level", reachId: sn.reach.id, nodeIdx: sn.nodeIdx });
    } else if (this.selected?.kind === "junction") {
      const J = this.junction(this.selected.junctionId);
      const lv = J ? (this.sol?.junctions.get(J.id)?.level ?? this.sampleBase(J.x, J.z)) : 0;
      if (J) this._addLevelCone(J.x, lv, J.z, sc, { kind: "level", junctionId: J.id });
    }
    for (const J of this.junctions) {
      const sel = this.selected?.kind === "junction" && this.selected.junctionId === J.id;
      const m = new THREE.Mesh(this._geoJunction, this._handleMat(sel ? COL_SELECTED : Number.isFinite(J.y) ? COL_PINNED : COL_JUNCTION));
      const lv = this.sol?.junctions.get(J.id)?.level ?? this.sampleBase(J.x, J.z);
      m.position.set(J.x, lv, J.z);
      m.scale.setScalar(sc);
      m.userData = { kind: "junction", junctionId: J.id };
      m.renderOrder = 951;
      this.handleGroup.add(m);
    }
  }

  _addLevelCone(x, y, z, sc, data) {
    const m = new THREE.Mesh(this._geoLevel, this._handleMat(COL_LEVEL));
    m.position.set(x, y + sc * 3.2, z);
    m.scale.setScalar(sc);
    m.userData = data;
    m.renderOrder = 951;
    this.handleGroup.add(m);
  }

  /** Unit flow direction at a node (from its neighbours). */
  _nodeTangent(reach, k) {
    const n = reach.nodes, a = n[Math.max(0, k - 1)], b = n[Math.min(n.length - 1, k + 1)];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
    return { x: dx / L, z: dz / L };
  }

  _rebuildArrows() {
    this._clear(this.arrowGroup);
    if (!this.params.showArrows || !this.sol) return;
    const items = [];
    for (const s of this.sol.reaches.values()) {
      let next = 0;
      for (let i = 0; i < s.count; i++) {
        if (s.arc[i] < next) continue;
        next = s.arc[i] + ARROW_SPACING;
        items.push({ x: s.x[i], y: s.level[i] + 0.35, z: s.z[i], tx: s.tanX[i], tz: s.tanZ[i], speed: s.speed[i], uphill: s.uphill[i], scale: Math.min(3, Math.max(0.6, s.width[i] * 0.14)) });
      }
    }
    if (!items.length) return;
    const mesh = shareInstancePipeline(new THREE.InstancedMesh(this._geoArrow, this._arrowMat, items.length));
    mesh.frustumCulled = false; mesh.renderOrder = 940;
    const colors = new Float32Array(items.length * 3);
    const m4 = new THREE.Matrix4(), fwd = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), right = new THREE.Vector3(), up2 = new THREE.Vector3(), scl = new THREE.Matrix4();
    const maxSpeed = this.params.maxSpeed ?? 9;
    items.forEach((it, i) => {
      fwd.set(it.tx, 0, it.tz).normalize(); right.crossVectors(up, fwd).normalize(); up2.crossVectors(fwd, right).normalize();
      m4.makeBasis(right, up2, fwd); scl.makeScale(it.scale, it.scale, it.scale); m4.multiply(scl); m4.setPosition(it.x, it.y, it.z);
      mesh.setMatrixAt(i, m4);
      const t = Math.min(1, it.speed / Math.max(0.5, maxSpeed * 0.6));
      if (it.uphill) colors.set([1, 0.12, 0.12], i * 3);
      else colors.set([0.25 + 0.75 * t, 0.6 + 0.4 * t, 1], i * 3);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.geometry.setAttribute("aColor", new THREE.InstancedBufferAttribute(colors, 3));
    this.arrowGroup.add(mesh);
  }

  _rebuildVisual() {
    const liveIds = new Set(this.reaches.map((r) => r.id));
    for (const id of [...this._meshes.keys()]) {
      if (!liveIds.has(id) || !this.sol?.reaches.has(id)) {
        const m = this._meshes.get(id).mesh;
        this.group.remove(m); m.geometry.dispose();
        this._meshes.delete(id);
      }
    }
    if (this.sol) for (const r of this.reaches) if (this.sol.reaches.has(r.id)) this._buildRibbon(r, this.sol.reaches.get(r.id));
    this.onWaterMeshesChanged?.();
    this._rebuildHandles();
    this._rebuildArrows();
  }

  setEditActive(on) {
    this.editActive = !!on;
    this.refreshVisibility();
    if (!on) this.cancelDrag();
  }
  refreshVisibility() {
    this.handleGroup.visible = this.editActive && !!this.params.showHandles;
    this.arrowGroup.visible = this.editActive && !!this.params.showArrows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Material / frame
  // ═══════════════════════════════════════════════════════════════════════════

  syncMaterial() { this._water.syncParams(riverWaterParams(this.params.water)); }

  update(dt) {
    this._time += dt;
    this._water.update(dt, this._time);
    if (this.editActive && this.handleGroup.visible) {
      const sc = this._handleScale();
      for (const h of this.handleGroup.children) h.scale.setScalar(sc * (h.userData.kind === "junction" ? 1 : 0.9));
    }
  }
  setSunDir(v) { this._lastSun = v?.clone?.() ?? v; this._water.setSunDir(v); }
  setSkyColors(z, h) { this._lastSky = [z, h]; this._water.setSkyColors(z, h); }

  /** As River v2's: heightmap depth, no framebuffer grabs (for an RTS camera). */
  setGrabFree(on, groundYNode = null) {
    on = !!on;
    if (on === this._grabFree) return;
    this._grabFree = on;
    const old = this._water;
    this._water = createRiverMaterial({ normalMap: this._waterNormalMap, grabFree: on, groundYNode: on ? groundYNode : null });
    this.syncMaterial();
    if (this._lastSun) this._water.setSunDir(this._lastSun);
    if (this._lastSky) this._water.setSkyColors(...this._lastSky);
    for (const { mesh } of this._meshes.values()) { mesh.material = this._water.material; this._syncAddPass(mesh); }
    old.material?.dispose?.(); old.material2?.dispose?.();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Editing
  // ═══════════════════════════════════════════════════════════════════════════

  _newNode(x, z) {
    const p = this.params;
    return { x, z, y: null, width: p.newWidth, depth: p.newDepth, bank: p.newBank };
  }
  _newReach(nodes = [], from = null, to = null) {
    const r = { id: this._nextId++, nodes, from, to, q: null };
    this.reaches.push(r);
    return r;
  }
  _newJunction(x, z) {
    const J = { id: this._nextId++, x, z, y: null };
    this.junctions.push(J);
    return J;
  }

  /** The reach (other than `exceptId`) whose centreline passes within joining distance of (x, z). */
  _reachNear(x, z, exceptId) {
    let best = null;
    for (const r of this.reaches) {
      if (r.id === exceptId) continue;
      const s = this.sol?.reaches.get(r.id);
      if (!s) continue;
      for (let i = 0; i < s.count; i++) {
        const d = Math.hypot(s.x[i] - x, s.z[i] - z);
        const tol = s.width[i] * 0.5 + JOIN_SLACK;
        if (d <= tol && (!best || d < best.d)) best = { reach: r, d, x: s.x[i], z: s.z[i], span: s.span[i] };
      }
    }
    return best;
  }

  /** An existing junction within joining distance of (x, z). */
  _junctionNear(x, z) {
    let best = null;
    for (const J of this.junctions) {
      const d = Math.hypot(J.x - x, J.z - z);
      if (d <= 6 && (!best || d < best.d)) best = { J, d };
    }
    return best?.J ?? null;
  }

  /**
   * Split `reach` at world point (x, z) on its span `span`: a node is inserted
   * there, the reach is cut in two and a junction joins the halves. Returns the
   * junction. The upstream half keeps the reach's id.
   */
  _splitReach(reach, x, z, span) {
    const k = Math.max(0, Math.min(reach.nodes.length - 2, span));
    const a = reach.nodes[k], b = reach.nodes[k + 1];
    const near = (n) => Math.hypot(n.x - x, n.z - z) < 1.5;
    let at;
    if (near(a)) at = k;
    else if (near(b)) at = k + 1;
    else {
      const nd = this._newNode(x, z);
      nd.width = (a.width + b.width) / 2; nd.depth = (a.depth + b.depth) / 2; nd.bank = (a.bank + b.bank) / 2;
      reach.nodes.splice(k + 1, 0, nd);
      at = k + 1;
    }
    // An end node already on a junction: nothing to split.
    if (at === 0 && reach.from != null) return this.junction(reach.from);
    if (at === reach.nodes.length - 1 && reach.to != null) return this.junction(reach.to);
    const nd = reach.nodes[at];
    const J = this._newJunction(nd.x, nd.z);
    if (at === 0) { reach.from = J.id; return J; }
    if (at === reach.nodes.length - 1) { reach.to = J.id; return J; }
    const down = this._newReach(reach.nodes.slice(at).map((n) => ({ ...n })), J.id, reach.to);
    reach.nodes = reach.nodes.slice(0, at + 1);
    reach.to = J.id;
    void down;
    return J;
  }

  /** Put an end node exactly on a junction. */
  _snapEnd(reach, end, J) {
    const nd = end === 0 ? reach.nodes[0] : reach.nodes[reach.nodes.length - 1];
    nd.x = J.x; nd.z = J.z;
    if (end === 0) reach.from = J.id; else reach.to = J.id;
  }

  /**
   * Click on the terrain (see the header for what it does in each case).
   */
  addNode({ x, z }) {
    this._pushUndo();
    const sel = this.selected?.kind === "node" ? this.selected : null;
    let reach = this.activeReach;

    // A branch out of an interior node (or out of a junction the user selected).
    const branchFrom = (() => {
      if (this.selected?.kind === "junction") return this.junction(this.selected.junctionId);
      if (!sel) return null;
      const r = this.reach(sel.reachId);
      if (!r) return null;
      const last = r.nodes.length - 1;
      if (sel.nodeIdx > 0 && sel.nodeIdx < last) {
        const nd = r.nodes[sel.nodeIdx];
        return this._splitReach(r, nd.x, nd.z, sel.nodeIdx);
      }
      return null;
    })();
    if (branchFrom) {
      reach = this._newReach([{ ...this._newNode(branchFrom.x, branchFrom.z) }, this._newNode(x, z)], branchFrom.id, null);
      this.activeReachId = reach.id;
      this.selected = { kind: "node", reachId: reach.id, nodeIdx: 1 };
      this._afterEdit();
      return;
    }

    if (!reach) {
      reach = this._newReach([]);
      this.activeReachId = reach.id;
    }
    const prepend = sel && sel.reachId === reach.id && sel.nodeIdx === 0 && reach.nodes.length > 1;
    // Joining: the new end lands on another reach or an existing junction.
    const J0 = reach.nodes.length ? this._junctionNear(x, z) : null;
    const hit = !J0 && reach.nodes.length ? this._reachNear(x, z, reach.id) : null;
    if (J0 || hit) {
      const J = J0 ?? this._splitReach(hit.reach, hit.x, hit.z, hit.span);
      if (prepend) {
        if (reach.from == null) { reach.nodes.unshift(this._newNode(J.x, J.z)); this._snapEnd(reach, 0, J); }
        this.selected = { kind: "junction", junctionId: J.id };
      } else if (reach.to == null) {
        reach.nodes.push(this._newNode(J.x, J.z));
        this._snapEnd(reach, 1, J);
        this.selected = { kind: "junction", junctionId: J.id };
      }
      this._afterEdit();
      return;
    }
    if (prepend && reach.from == null) {
      reach.nodes.unshift(this._newNode(x, z));
      this.selected = { kind: "node", reachId: reach.id, nodeIdx: 0 };
    } else if (reach.to == null) {
      reach.nodes.push(this._newNode(x, z));
      this.selected = { kind: "node", reachId: reach.id, nodeIdx: reach.nodes.length - 1 };
    } else {
      // The active reach already ends on a junction: start a new one here.
      reach = this._newReach([this._newNode(x, z)]);
      this.activeReachId = reach.id;
      this.selected = { kind: "node", reachId: reach.id, nodeIdx: 0 };
    }
    this._afterEdit();
  }

  startNewReach() {
    this._pushUndo();
    const r = this._newReach([]);
    this.activeReachId = r.id;
    this.selected = null;
    this._afterEdit();
  }

  /** Flip a reach end for end: its nodes AND its junction ends. */
  reverseActiveReach() {
    const r = this.activeReach;
    if (!r || r.nodes.length < 2) return false;
    this._pushUndo();
    r.nodes.reverse();
    [r.from, r.to] = [r.to, r.from];
    this.selected = null;
    this._afterEdit();
    return true;
  }

  deleteActiveReach() {
    const r = this.activeReach;
    if (!r) return false;
    this._pushUndo();
    this.reaches = this.reaches.filter((x) => x !== r);
    this.activeReachId = this.reaches.at(-1)?.id ?? null;
    this.selected = null;
    this._afterEdit();
    return true;
  }

  clearAll() {
    this._pushUndo();
    this.reaches = []; this.junctions = []; this.activeReachId = null; this.selected = null;
    this._afterEdit();
  }

  deleteSelected() {
    const s = this.selected;
    if (!s) return false;
    this._pushUndo();
    if (s.kind === "junction") {
      for (const r of this.reaches) { if (r.from === s.junctionId) r.from = null; if (r.to === s.junctionId) r.to = null; }
      this.junctions = this.junctions.filter((J) => J.id !== s.junctionId);
    } else {
      const r = this.reach(s.reachId);
      if (r) {
        const last = r.nodes.length - 1;
        if (s.nodeIdx === 0) r.from = null;
        if (s.nodeIdx === last) r.to = null;
        r.nodes.splice(s.nodeIdx, 1);
        if (r.nodes.length === 0) this.reaches = this.reaches.filter((x) => x !== r);
      }
    }
    this.selected = null;
    this._afterEdit();
    return true;
  }

  /** Drop junctions nothing touches, re-seat reach ends on their junctions. */
  _tidy() {
    const used = new Set();
    for (const r of this.reaches) {
      if (r.nodes.length === 0) continue;
      if (r.from != null) { const J = this.junction(r.from); if (J) { used.add(J.id); r.nodes[0].x = J.x; r.nodes[0].z = J.z; } else r.from = null; }
      if (r.to != null) { const J = this.junction(r.to); if (J) { used.add(J.id); const n = r.nodes.at(-1); n.x = J.x; n.z = J.z; } else r.to = null; }
    }
    this.junctions = this.junctions.filter((J) => used.has(J.id));
    if (this.activeReachId != null && !this.reach(this.activeReachId)) this.activeReachId = this.reaches.at(-1)?.id ?? null;
  }

  _afterEdit(commit = true) {
    this._tidy();
    this.applyConform({ commit });
    this.syncSelectionToState();
  }

  // ── Selection → panel ─────────────────────────────────────────────────────

  selectedNode() {
    const s = this.selected;
    if (s?.kind !== "node") return null;
    const reach = this.reach(s.reachId);
    const node = reach?.nodes[s.nodeIdx];
    return node ? { reach, node, nodeIdx: s.nodeIdx } : null;
  }

  syncSelectionToState() {
    const p = this.params, sel = this.selectedNode();
    if (sel) {
      p.selWidth = sel.node.width; p.selDepth = sel.node.depth; p.selBank = sel.node.bank;
      p.selLevel = this._nodeY(sel.reach, sel.nodeIdx);
    } else if (this.selected?.kind === "junction") {
      const J = this.junction(this.selected.junctionId);
      p.selLevel = this.sol?.junctions.get(J?.id)?.level ?? 0;
    }
  }

  setSelectedChannel({ width, depth, bank } = {}) {
    const sel = this.selectedNode();
    if (!sel) return false;
    if (width != null) sel.node.width = width;
    if (depth != null) sel.node.depth = depth;
    if (bank != null) sel.node.bank = bank;
    this.applyConform({ commit: true });
    return true;
  }

  /** Pin the selected node's (or junction's) water level. */
  setSelectedLevel(y) {
    if (this.selected?.kind === "junction") {
      const J = this.junction(this.selected.junctionId);
      if (!J) return false;
      J.y = y;
    } else {
      const sel = this.selectedNode();
      if (!sel) return false;
      sel.node.y = y;
    }
    this.applyConform({ commit: true });
    return true;
  }

  releaseSelectedLevel() {
    if (this.selected?.kind === "junction") { const J = this.junction(this.selected.junctionId); if (J) J.y = null; }
    else { const sel = this.selectedNode(); if (sel) sel.node.y = null; }
    this.applyConform({ commit: true });
  }

  // ── Picking and dragging ──────────────────────────────────────────────────

  pick(raycaster) {
    if (!this.params.showHandles) return null;
    for (const h of raycaster.intersectObjects(this.handleGroup.children, false)) {
      if (h.object.userData?.kind) return { ...h.object.userData };
    }
    return null;
  }

  beginDrag(pick) {
    if (!pick) return false;
    // Width and level handles carry the node / junction they belong to.
    this.selected = pick.junctionId != null ? { kind: "junction", junctionId: pick.junctionId } : { kind: "node", reachId: pick.reachId, nodeIdx: pick.nodeIdx };
    if (pick.reachId != null) this.activeReachId = pick.reachId;
    this._pushUndo();
    this._drag = { ...pick };
    this.dragging = true;
    this.syncSelectionToState();
    this._rebuildHandles();
    return true;
  }

  /** "node" / "junction" move over the terrain; "width" / "level" use analytic planes. */
  get dragKind() { return this._drag?.kind ?? null; }

  /**
   * @param {{terrainHit?:{x:number,z:number}|null, raycaster?:THREE.Raycaster, camera?:THREE.Camera}} ctx
   */
  dragTo({ terrainHit = null, raycaster = null, camera = null }) {
    const d = this._drag;
    if (!d) return;
    if (d.kind === "junction" || d.kind === "node") {
      if (!terrainHit) return;
      const tgt = d.kind === "junction" ? this.junction(d.junctionId) : this.reach(d.reachId)?.nodes[d.nodeIdx];
      if (!tgt) return;
      tgt.x = terrainHit.x; tgt.z = terrainHit.z;
      this._tidy();
    } else if (d.kind === "width") {
      const r = this.reach(d.reachId), nd = r?.nodes[d.nodeIdx];
      if (!nd || !raycaster) return;
      const hit = this._rayOnHorizontalPlane(raycaster, this._nodeY(r, d.nodeIdx));
      if (!hit) return;
      const t = this._nodeTangent(r, d.nodeIdx);
      // Across-stream distance only: dragging along the river changes nothing.
      nd.width = Math.min(200, Math.max(1, 2 * Math.abs((hit.x - nd.x) * -t.z + (hit.z - nd.z) * t.x)));
    } else if (d.kind === "level") {
      const at = d.junctionId != null ? this.junction(d.junctionId) : this.reach(d.reachId)?.nodes[d.nodeIdx];
      if (!at || !raycaster || !camera) return;
      const y = this._rayOnVerticalPlane(raycaster, camera, at.x, at.z);
      if (y == null) return;
      // RELATIVE to where the drag began: the cone floats a few metres above
      // the water, and taking the hit height itself (River v2 does) made the
      // level jump up by that much on the first move.
      if (d.startHit == null) {
        d.startHit = y;
        d.startLevel = d.junctionId != null
          ? (this.sol?.junctions.get(d.junctionId)?.level ?? y)
          : this._nodeY(this.reach(d.reachId), d.nodeIdx);
      }
      at.y = d.startLevel + (y - d.startHit);  // dragging the cone PINS the level
    }
    this.applyConform({ commit: false });
    this.syncSelectionToState();
  }

  _rayOnHorizontalPlane(raycaster, y) {
    const r = raycaster.ray;
    if (Math.abs(r.direction.y) < 1e-6) return null;
    const t = (y - r.origin.y) / r.direction.y;
    return t < 0 ? null : { x: r.origin.x + r.direction.x * t, z: r.origin.z + r.direction.z * t };
  }

  /** Height where the ray meets the vertical plane through (x, z) facing the camera. */
  _rayOnVerticalPlane(raycaster, camera, x, z) {
    const nx = camera.position.x - x, nz = camera.position.z - z, L = Math.hypot(nx, nz) || 1;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(nx / L, 0, nz / L), new THREE.Vector3(x, 0, z));
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return Math.max(-MAX_HEIGHT, Math.min(MAX_HEIGHT * 1.5, hit.y));
  }

  endDrag() {
    if (!this._drag) return false;
    this._drag = null;
    this.dragging = false;
    this.applyConform({ commit: true });
    return true;
  }
  cancelDrag() { this._drag = null; this.dragging = false; }

  // ── Undo ──────────────────────────────────────────────────────────────────

  _snapshot() {
    return JSON.stringify({ junctions: this.junctions, reaches: this.reaches, active: this.activeReachId, next: this._nextId });
  }
  _restore(json) {
    const d = JSON.parse(json);
    this.junctions = d.junctions; this.reaches = d.reaches; this.activeReachId = d.active;
    this._nextId = Math.max(this._nextId, d.next);
    this.selected = null;
    this._afterEdit();
  }
  _pushUndo() {
    this._undo.push(this._snapshot());
    if (this._undo.length > MAX_UNDO) this._undo.shift();
    this._redo.length = 0;
  }
  undo() { if (!this._undo.length) return false; this._redo.push(this._snapshot()); this._restore(this._undo.pop()); return true; }
  redo() { if (!this._redo.length) return false; this._undo.push(this._snapshot()); this._restore(this._redo.pop()); return true; }

  // ── Persistence ───────────────────────────────────────────────────────────

  exportData() {
    if (!this.reaches.length) return null;
    const { selWidth, selDepth, selBank, selLevel, ...params } = this.params;
    void selWidth; void selDepth; void selBank; void selLevel;
    return {
      version: 1,
      params: { ...params, water: { ...params.water } },
      junctions: this.junctions.map((J) => ({ ...J })),
      reaches: this.reaches.map((r) => ({ id: r.id, from: r.from, to: r.to, q: r.q, nodes: r.nodes.map((n) => ({ ...n })) })),
    };
  }

  importData(data) {
    this.reaches = []; this.junctions = []; this.selected = null; this.activeReachId = null;
    this._undo.length = 0; this._redo.length = 0;
    if (data?.params) {
      for (const [k, v] of Object.entries(data.params)) {
        if (k === "water") { if (v && typeof v === "object") Object.assign(this.params.water, v); }
        else if (v != null) this.params[k] = v;
      }
    }
    for (const J of data?.junctions ?? []) this.junctions.push({ id: J.id, x: J.x, z: J.z, y: Number.isFinite(J.y) ? J.y : null });
    for (const r of data?.reaches ?? []) {
      if (!Array.isArray(r.nodes) || !r.nodes.length) continue;
      this.reaches.push({
        id: r.id, from: r.from ?? null, to: r.to ?? null, q: Number.isFinite(r.q) ? r.q : null,
        nodes: r.nodes.map((n) => ({ x: n.x, z: n.z, y: Number.isFinite(n.y) ? n.y : null, width: n.width ?? this.params.newWidth, depth: n.depth ?? this.params.newDepth, bank: n.bank ?? this.params.newBank })),
      });
    }
    this._nextId = Math.max(1, ...this.junctions.map((J) => J.id + 1), ...this.reaches.map((r) => r.id + 1));
    this.activeReachId = this.reaches.at(-1)?.id ?? null;
    this.syncMaterial();
    this._lastSnap = null;
    this._afterEdit();
  }

  /**
   * Take a River v2 river over as a single reach (the "Convert to River v3"
   * path): same nodes, same channel. v2 must then be cleared by the caller, or
   * both would shape the same ground.
   */
  importFromV2(rivers) {
    this._pushUndo();
    for (const rv of rivers ?? []) {
      if (!rv?.nodes?.length) continue;
      this._newReach(rv.nodes.map((n) => ({ x: n.x, z: n.z, y: Number.isFinite(n.y) ? n.y : null, width: n.width, depth: n.depth, bank: n.bank })));
    }
    this.activeReachId = this.reaches.at(-1)?.id ?? null;
    this._afterEdit();
  }
}
