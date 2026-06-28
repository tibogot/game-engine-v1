import * as THREE from "three";
import { RiverCarvingSystem } from "../../v2/tools/river/riverCarvingSystem.js";
import { sampleHeightWorld } from "../terrain/heightPathWriter.js";

const _tan = new THREE.Vector3();
const _perp = new THREE.Vector3();

/**
 * River+ for V3.
 *
 * Design goals (best-effort "nice river", not a 1:1 v2 port):
 *  - Water surface is FLAT across the river width (no per-edge terrain bumps).
 *  - Water level flows smoothly DOWNHILL along the path (never uphill, no noise).
 *  - Terrain is carved into a flat-bottomed channel: bed = water − depth, so the
 *    banks always clear the water (no clipping) and there is real depth beneath.
 *
 * The water surface is derived from a smoothed + monotonic profile of the
 * UNCARVED terrain under the centerline, so re-carving never feeds back on
 * itself. The carve floor is simply that profile minus carveDepth.
 */
export class V3RiverCarvingSystem extends RiverCarvingSystem {
  constructor({ commitTerrain, ensureCpuHeightmap, heightmapSize, worldSize, ...opts }) {
    super(opts);
    this._commitTerrain = commitTerrain;
    this._ensureCpuHeightmap = ensureCpuHeightmap;
    this._hmSize = heightmapSize;
    this._worldSize = worldSize;
    this._carveGen = 0;
    /** Full uncarved heightmap (metres) captured before the first carve. */
    this._v3FullBase = null;
  }

  _prepareWorkBuffer() {
    this.terrainStore.beginWrite?.();
  }

  /** Uncarved terrain height — both the water profile and carve read from this. */
  _getBaseWorldHeight(wx, wz) {
    if (this._v3FullBase?.length) {
      return sampleHeightWorld(this._v3FullBase, this._hmSize, this._worldSize, wx, wz);
    }
    return this.getWorldHeight(wx, wz);
  }

  _smoothInPlace(arr, passes) {
    const n = arr.length;
    for (let pass = 0; pass < passes; pass++) {
      let prev = arr[0];
      for (let i = 1; i < n - 1; i++) {
        const cur = arr[i];
        arr[i] = (prev + cur * 2 + arr[i + 1]) * 0.25;
        prev = cur;
      }
    }
  }

  /** Force the profile to never flow uphill (descend from the higher endpoint). */
  _enforceDownhill(arr) {
    const n = arr.length;
    if (n < 2) return;
    if (arr[0] >= arr[n - 1]) {
      for (let i = 1; i < n; i++) if (arr[i] > arr[i - 1]) arr[i] = arr[i - 1];
    } else {
      for (let i = n - 2; i >= 0; i--) if (arr[i] > arr[i + 1]) arr[i] = arr[i + 1];
    }
  }

  /**
   * Sample the centerline and build a smooth, downhill water-level profile.
   * @returns {{ pts: THREE.Vector3[], levels: Float32Array }|null}
   */
  _computeProfile(seg) {
    if (seg.points.length < 2) return null;
    const rp = this.toolState.river2;
    const curve = new THREE.CatmullRomCurve3(seg.points, !!rp.closed, "catmullrom", 0.5);
    const count = Math.max(120, rp.segments);
    const pts = curve.getSpacedPoints(count);

    const levels = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      levels[i] = this._getBaseWorldHeight(pts[i].x, pts[i].z);
    }

    // Heavy smoothing → strict downhill → light smoothing → downhill again.
    // Removes terrain noise while guaranteeing a believable flowing surface.
    this._smoothInPlace(levels, 8);
    this._enforceDownhill(levels);
    this._smoothInPlace(levels, 3);
    this._enforceDownhill(levels);

    return { pts, levels };
  }

  /** Carve floor polyline = water profile − depth (flat-bottomed channel). */
  _getCarvePath(seg) {
    const prof = this._computeProfile(seg);
    if (!prof) return null;
    const depth = this.toolState.river2.carveDepth;
    const { pts, levels } = prof;
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      out[i] = { x: pts[i].x, y: levels[i] - depth, z: pts[i].z };
    }
    return out;
  }

  /** Flat-across-width, smooth-along-length water ribbon at the profile level. */
  _buildRiverGeometry(seg) {
    const prof = this._computeProfile(seg);
    if (!prof) return null;
    const rp = this.toolState.river2;
    const { pts, levels } = prof;
    const segs = pts.length - 1;
    const halfW = rp.width * 0.5;
    const off = rp.heightOffset;

    const arc = new Float32Array(segs + 1);
    for (let i = 1; i <= segs; i++) arc[i] = arc[i - 1] + pts[i].distanceTo(pts[i - 1]);
    const total = arc[segs] || 1;

    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= segs; i++) {
      const pos = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(segs, i + 1)];
      _tan.subVectors(next, prev).normalize();
      _perp.set(-_tan.z, 0, _tan.x).normalize();

      const y = levels[i] + off;
      const lx = pos.x - _perp.x * halfW;
      const lz = pos.z - _perp.z * halfW;
      const rx = pos.x + _perp.x * halfW;
      const rz = pos.z + _perp.z * halfW;

      positions.push(lx, y, lz, rx, y, rz);
      const u = arc[i] / total;
      uvs.push(u, 0, u, 1);

      if (i < segs) {
        const b = i * 2;
        indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  _hasCarvableSegment() {
    return this.segments.some((s) => s.points.length >= 2);
  }

  _restoreUncarvedBase() {
    if (this._v3FullBase) {
      this.terrainStore.restoreFullHeights?.(this._v3FullBase);
    }
  }

  _captureBaseIfNeeded() {
    if (!this._v3FullBase) {
      this._v3FullBase = this.terrainStore.copyWorkHeights?.() ?? null;
    }
  }

  _applyAllCarves() {
    const rp = this.toolState.river2;
    let any = false;
    for (const seg of this.segments) {
      const pts = this._getCarvePath(seg);
      if (!pts) continue;
      this.terrainStore.lowerTerrainAlongPoints(pts, rp.width * 0.5, rp.carveShoulder, null);
      any = true;
    }
    return any;
  }

  rebuildAllMeshes() {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      this._disposeSegMesh(seg);
      if (seg.points.length < 2) continue;
      const geo = this._buildRiverGeometry(seg);
      if (!geo) continue;
      seg.mesh = new THREE.Mesh(geo, this._activeMaterial());
      seg.mesh.renderOrder = 2;
      this.scene.add(seg.mesh);
    }
  }

  _rebuildActiveSegMesh() {
    const ai = this._activeIdx();
    if (ai < 0) return;
    const seg = this.segments[ai];
    this._disposeSegMesh(seg);
    if (seg.points.length < 2) return;
    const geo = this._buildRiverGeometry(seg);
    if (!geo) return;
    seg.mesh = new THREE.Mesh(geo, this._activeMaterial());
    seg.mesh.renderOrder = 2;
    this.scene.add(seg.mesh);
  }

  /** Sync GPU → CPU, restore base, carve all segments, push to GPU, rebuild mesh. */
  async applyCarve({ rebuild = true } = {}) {
    const gen = ++this._carveGen;
    await this._ensureCpuHeightmap?.();
    if (gen !== this._carveGen) return;

    this._prepareWorkBuffer();
    this._baseTerrainSnapshot = null;

    if (!this._hasCarvableSegment()) {
      if (this._v3FullBase) {
        this._restoreUncarvedBase();
        this.markTerrainDirty(null);
        this._v3FullBase = null;
      }
      if (gen !== this._carveGen) return;
      if (rebuild) this._rebuildVisual();
      return;
    }

    this._captureBaseIfNeeded();
    this._restoreUncarvedBase();

    if (gen !== this._carveGen) return;

    this._applyAllCarves();
    this.markTerrainDirty(null);

    if (gen !== this._carveGen) return;
    if (rebuild) this._rebuildVisual();
  }

  /** v2 hook — routed through applyCarve. */
  _updateCarving() {
    void this.applyCarve({ rebuild: false });
  }

  refreshCarving() {
    if (this._hasCarvableSegment()) void this.applyCarve({ rebuild: true });
  }

  addPoint(pos) {
    this._pushUndo();
    if (this.segments.length === 0) {
      this.segments.push({ points: [], mesh: null });
      this.toolState.river2.activeRiverIndex = 0;
    }
    this._clampActive();
    const ai = this._activeIdx();
    const pts = this.segments[ai].points;
    pts.push(pos.clone());
    this.selectedIdx = pts.length - 1;
    void this.applyCarve({ rebuild: true }).then(() => this._updateSelectedY());
  }

  deleteSelected() {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const pts = this.segments[ai].points;
    if (this.selectedIdx >= pts.length) return;
    this._pushUndo();
    pts.splice(this.selectedIdx, 1);
    this.selectedIdx = Math.min(this.selectedIdx, pts.length - 1);
    void this.applyCarve({ rebuild: true }).then(() => this._updateSelectedY());
  }

  deleteActiveRiver() {
    const ai = this._activeIdx();
    if (ai < 0) return;
    this._pushUndo();
    this._disposeSegMesh(this.segments[ai]);
    this.segments.splice(ai, 1);
    this.selectedIdx = -1;
    this.dragging = false;
    this._clampActive();
    void this.applyCarve({ rebuild: true });
  }

  finalizeMove() {
    this.dragging = false;
    void this.applyCarve({ rebuild: true });
  }

  setSelectedPointY(y) {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const pts = this.segments[ai].points;
    if (this.selectedIdx >= pts.length) return;
    pts[this.selectedIdx].y = y;
    void this.applyCarve({ rebuild: true });
  }

  _restore(snap) {
    this._disposeAllMeshes();
    this.segments = snap.segments.map((s) => ({
      points: s.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      mesh: null,
    }));
    this.toolState.river2.activeRiverIndex = snap.activeRiverIndex;
    this.selectedIdx = snap.selectedIdx;
    this._clampActive();
    void this.applyCarve({ rebuild: true }).then(() => this._updateSelectedY());
  }

  dispose() {
    if (this._v3FullBase) {
      void this._ensureCpuHeightmap?.().then(() => {
        this._prepareWorkBuffer();
        this._restoreUncarvedBase();
        this._commitTerrain?.();
        this._v3FullBase = null;
      });
    }
    this._disposeAllMeshes();
    while (this.handleGroup.children.length) {
      const child = this.handleGroup.children[0];
      this.handleGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.scene.remove(this.handleGroup);
    this._basicMat.dispose();
    this._stylizedMat.dispose();
  }
}
