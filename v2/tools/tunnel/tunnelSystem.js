import * as THREE from "three";
import {
  chunkKey,
  getChunkCountPerAxis,
  worldToChunkIndex,
} from "../../core/terrain/chunkMath.js";

/**
 * Tunnel mode — composite "macro" tool for drivable/walkable tunnels through
 * heightfield mountains. It owns NO geometry of its own; one Create action
 * orchestrates the existing systems so all of them stay in agreement:
 *
 *   1. Mouth staging — clicked points become the tube centerline (lifted by
 *      `radius` + `mouthLift` so the tube FLOOR sits at the click height), and
 *      both ends are extended outward horizontally so the mouth pokes proud of
 *      the mountain face.
 *   2. Trench carve — terrain near each mouth is lowered (never raised) to
 *      just below the tube floor via `terrainStore.lowerTerrainAlongPoints`,
 *      forming the approach cutting and making the face steep at the portal.
 *   3. Membrane hole — wherever the heightfield surface still crosses the
 *      tube interior (the thin strip at each portal where terrain rises from
 *      below the floor to above the ceiling), hole-mask texels are painted so
 *      the terrain stops rendering inside the tube AND the collision sentinel
 *      (`holeStore.isHoleAt`) stops claiming that ground. This is what makes
 *      the entrance actually open — visually and physically.
 *   4. Tube — created through `splineSystem.addTunnel`, which already feeds
 *      rendering, serialization, BVH collision and interior lighting.
 *   5. BVH rebake + height-dependent systems refresh via callbacks.
 *
 * Undo/redo is COMPOSITE: one command per tunnel bundles the terrain height
 * snapshots, the hole-mask snapshots, and the tube — so Ctrl+Z removes the
 * whole thing at once instead of leaving notch scars behind.
 */
export class TunnelSystem {
  constructor({
    scene,
    toolState,
    config,
    terrainStore,
    holeStore,
    chunkStream,
    splineSystem,
    onHeightsChanged,
    onRebakeBvh,
  }) {
    this.scene = scene;
    this.toolState = toolState;
    this.config = config;
    this.terrainStore = terrainStore;
    this.holeStore = holeStore;
    this.chunkStream = chunkStream;
    this.splineSystem = splineSystem;
    this.onHeightsChanged = onHeightsChanged || (() => {});
    this.onRebakeBvh = onRebakeBvh || (() => {});

    /** @type {THREE.Vector3[]} clicked tube-centerline points (already lifted). */
    this.draftPoints = [];
    this.undoStack = [];
    this.redoStack = [];

    this.previewGroup = new THREE.Group();
    this.previewGroup.name = "TunnelDraftPreview";
    scene.add(this.previewGroup);
    this._previewPointMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
    this._previewPointGeo = new THREE.SphereGeometry(0.8, 12, 10);
    this._previewTubeOuterMat = new THREE.MeshBasicMaterial({
      color: 0xcc2222,
      transparent: true,
      opacity: 0.42,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
    });
    this._previewTubeInnerMat = new THREE.MeshBasicMaterial({
      color: 0x2a2a32,
      transparent: true,
      opacity: 0.55,
      depthWrite: true,
      depthTest: true,
      side: THREE.BackSide,
    });
  }

  // ------------------------------------------------------------- draft UX

  /** Click on terrain → add a centerline point lifted so the floor sits at the click. */
  addDraftPoint(hitPoint) {
    const s = this.toolState.tunnel;
    const p = hitPoint.clone();
    p.y += s.radius + s.mouthLift;
    this.draftPoints.push(p);
    this._rebuildPreview();
  }

  removeLastDraftPoint() {
    if (this.draftPoints.length === 0) return;
    this.draftPoints.pop();
    this._rebuildPreview();
  }

  cancelDraft() {
    if (this.draftPoints.length === 0) return;
    this.draftPoints.length = 0;
    this._rebuildPreview();
  }

  get draftCount() {
    return this.draftPoints.length;
  }

  _rebuildPreview() {
    const geos = new Set();
    for (const child of [...this.previewGroup.children]) {
      this.previewGroup.remove(child);
      if (child.geometry && child.geometry !== this._previewPointGeo) {
        geos.add(child.geometry);
      }
    }
    for (const g of geos) g.dispose();

    for (const p of this.draftPoints) {
      const m = new THREE.Mesh(this._previewPointGeo, this._previewPointMat);
      m.position.copy(p);
      this.previewGroup.add(m);
    }
    if (this.draftPoints.length >= 2) {
      const centerPts = this._stagedCenterPoints();
      const curve = new THREE.CatmullRomCurve3(centerPts, false, "catmullrom", 0.5);
      const s = this.toolState.tunnel;
      const tubeGeo = new THREE.TubeGeometry(
        curve,
        Math.max(24, Math.min(120, Math.ceil(curve.getLength() / 2))),
        s.radius,
        12,
        false,
      );
      this.previewGroup.add(
        new THREE.Mesh(tubeGeo, this._previewTubeOuterMat),
      );
      this.previewGroup.add(
        new THREE.Mesh(tubeGeo, this._previewTubeInnerMat),
      );
    }
  }

  /** Draft points + horizontal mouth extensions at both ends (level Y). */
  _stagedCenterPoints() {
    const s = this.toolState.tunnel;
    const pts = this.draftPoints.map((p) => p.clone());
    if (pts.length >= 2 && s.mouthExtend > 0.01) {
      const a = pts[0], a2 = pts[1];
      const dirA = new THREE.Vector3(a.x - a2.x, 0, a.z - a2.z);
      if (dirA.lengthSq() > 1e-6) {
        dirA.normalize();
        pts.unshift(
          new THREE.Vector3(
            a.x + dirA.x * s.mouthExtend,
            a.y,
            a.z + dirA.z * s.mouthExtend,
          ),
        );
      }
      const b = pts[pts.length - 1], b2 = pts[pts.length - 2];
      const dirB = new THREE.Vector3(b.x - b2.x, 0, b.z - b2.z);
      if (dirB.lengthSq() > 1e-6) {
        dirB.normalize();
        pts.push(
          new THREE.Vector3(
            b.x + dirB.x * s.mouthExtend,
            b.y,
            b.z + dirB.z * s.mouthExtend,
          ),
        );
      }
    }
    return pts;
  }

  // ------------------------------------------------------------- creation

  /** Build the tunnel from the current draft. Returns true on success. */
  createFromDraft() {
    if (this.draftPoints.length < 2) return false;
    const s = this.toolState.tunnel;
    const radius = Math.max(0.5, s.radius);

    const centerPts = this._stagedCenterPoints();
    const curve = new THREE.CatmullRomCurve3(centerPts, false, "catmullrom", 0.5);
    const length = curve.getLength();
    const samples = curve.getSpacedPoints(Math.max(16, Math.ceil(length)));

    // --- snapshots (before) ---
    const carvePtsA = this._mouthCarvePoints(samples, radius, s, false);
    const carvePtsB = this._mouthCarvePoints(samples, radius, s, true);
    const carveMargin = radius * s.trenchWidthFactor + Math.max(1.5, radius * 0.8);
    // Snapshot one extra chunk ring: shared-edge propagation in the carve can
    // write a single vertex column into a neighbor just outside the AABB.
    const snapMargin = carveMargin + this.config.world.chunkSize;
    const terrainKeys = new Set([
      ...this._chunkKeysAroundPoints(carvePtsA, snapMargin),
      ...this._chunkKeysAroundPoints(carvePtsB, snapMargin),
    ]);
    const terrainBefore = this._snapshotTerrain(terrainKeys);
    const holeBefore = this._snapshotExistingHoleChunks(
      samples,
      radius + s.mouthPortalMargin + 2,
    );

    // --- 1+2: carve approach trenches at both mouths ---
    const dirtyRects = new Map();
    const halfW = radius * s.trenchWidthFactor;
    this.terrainStore.lowerTerrainAlongPoints(carvePtsA, halfW, carveMargin, dirtyRects);
    this.terrainStore.lowerTerrainAlongPoints(carvePtsB, halfW, carveMargin, dirtyRects);

    // --- 3: punch terrain out of the tube interior + open both mouth discs ---
    const holeTouched = this._paintMembrane(samples, radius, s.membraneMargin);
    for (const key of this._paintMouthPortals(samples, radius, s.mouthPortalMargin)) {
      holeTouched.add(key);
    }

    // --- 4: the tube itself (render + BVH + interior lighting + save) ---
    const tunnel = this.splineSystem.addTunnel({
      points: centerPts,
      radius,
      radialSegs: s.radialSegs,
      pathSegs: s.pathSegs,
      color: s.color,
      outerColor: s.outerColor,
      innerColor: s.innerColor,
    });

    // --- snapshots (after) + dirty marking ---
    const terrainAfter = this._snapshotTerrain(
      new Set([...terrainKeys, ...dirtyRects.keys()]),
    );
    const holeAfter = new Map();
    for (const key of holeTouched) {
      const entry = this.holeStore.getChunkByKey(key);
      if (entry) holeAfter.set(key, new Uint8Array(entry.data));
    }

    const allDirty = new Set([...dirtyRects.keys(), ...holeTouched]);
    if (allDirty.size > 0) this.chunkStream.markDirtyFull(allDirty);

    this.undoStack.push({
      tunnelParams: {
        points: centerPts.map((p) => ({ x: p.x, y: p.y, z: p.z })),
        radius,
        radialSegs: s.radialSegs,
        pathSegs: s.pathSegs,
        color: s.color,
        outerColor: s.outerColor,
        innerColor: s.innerColor,
      },
      tunnel,
      terrainBefore,
      terrainAfter,
      holeBefore,
      holeAfter,
      dirtyKeys: [...allDirty],
    });
    this.redoStack.length = 0;
    if (this.undoStack.length > 32) this.undoStack.shift();

    this.draftPoints.length = 0;
    this._rebuildPreview();
    this.onHeightsChanged();
    this.onRebakeBvh();
    return true;
  }

  /**
   * Trench-floor polyline for one mouth: curve samples from the tube end going
   * `mouthExtend + carveLength` inward, dropped to floor level minus
   * `trenchDepth`. The carve is lower-only, so deeper inside the mountain
   * (where terrain is far above the tube) nothing changes.
   */
  _mouthCarvePoints(samples, radius, s, fromEnd) {
    const span = Math.max(2, Math.ceil(s.mouthExtend + s.carveLength));
    const pts = [];
    const n = samples.length;
    for (let i = 0; i < Math.min(span, n); i++) {
      const src = fromEnd ? samples[n - 1 - i] : samples[i];
      pts.push(
        new THREE.Vector3(src.x, src.y - radius - s.trenchDepth, src.z),
      );
    }
    return pts;
  }

  /**
   * Paint hole-mask texels wherever the (post-carve) heightfield surface
   * passes through the tube's interior cross-section. Walks the centerline in
   * 1m steps and paints a small window around each sample, so cost stays
   * proportional to tunnel length rather than its AABB.
   */
  _paintMembrane(samples, radius, vMargin) {
    const touched = new Set();
    const latLimit = radius + 0.35;
    const win = radius + 1.5;

    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      const minX = Math.min(a.x, b.x) - win;
      const maxX = Math.max(a.x, b.x) + win;
      const minZ = Math.min(a.z, b.z) - win;
      const maxZ = Math.max(a.z, b.z) + win;

      const segTouched = this.holeStore.paintHoleRegion(
        minX, minZ, maxX, maxZ,
        (wx, wz) => {
          // project onto the segment in XZ
          const dx = b.x - a.x, dz = b.z - a.z;
          const lenSq = dx * dx + dz * dz;
          let t = 0;
          if (lenSq > 1e-8) {
            t = ((wx - a.x) * dx + (wz - a.z) * dz) / lenSq;
            t = Math.max(0, Math.min(1, t));
          }
          const px = a.x + t * dx, pz = a.z + t * dz;
          const ex = wx - px, ez = wz - pz;
          const lat = Math.sqrt(ex * ex + ez * ez);
          if (lat > latLimit) return 0;

          const centerY = a.y * (1 - t) + b.y * t;
          const chordHalf = Math.sqrt(Math.max(0, radius * radius - lat * lat));
          const H = this.terrainStore.getWorldHeight(wx, wz);
          return H > centerY - chordHalf - vMargin &&
            H < centerY + chordHalf + vMargin
            ? 1
            : 0;
        },
      );
      for (const key of segTouched) touched.add(key);
    }
    return touched;
  }

  /**
   * Circular hole punch at both mouths so the terrain face doesn't seal the
   * open tube ends. Paints along the first/last stretch of the centerline so
   * the overhang (`mouthExtend`) is included.
   */
  _paintMouthPortals(samples, radius, extraMargin) {
    const touched = new Set();
    if (samples.length < 2) return touched;
    const portalR = radius + Math.max(0.5, extraMargin);
    const span = Math.min(12, Math.max(3, Math.ceil(samples.length * 0.08)));
    const portalPts = [];
    for (let i = 0; i < span; i++) portalPts.push(samples[i]);
    for (let i = Math.max(span, samples.length - span); i < samples.length; i++) {
      portalPts.push(samples[i]);
    }

    for (const pt of portalPts) {
      const minX = pt.x - portalR;
      const maxX = pt.x + portalR;
      const minZ = pt.z - portalR;
      const maxZ = pt.z + portalR;
      const edge = portalR * 0.12;
      const segTouched = this.holeStore.paintHoleRegion(
        minX, minZ, maxX, maxZ,
        (wx, wz) => {
          const d = Math.hypot(wx - pt.x, wz - pt.z);
          if (d > portalR) return 0;
          if (d > portalR - edge) return (portalR - d) / edge;
          return 1;
        },
      );
      for (const key of segTouched) touched.add(key);
    }
    return touched;
  }

  // ---------------------------------------------------------- undo / redo

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    if (cmd.tunnel) this.splineSystem.removeTunnel(cmd.tunnel);
    this.terrainStore.restoreChunkHeightsFromMap(cmd.terrainBefore);
    this._restoreHoles(cmd.holeBefore, cmd.holeAfter);
    this.chunkStream.markDirtyFull(cmd.dirtyKeys);
    this.redoStack.push(cmd);
    this.onHeightsChanged();
    this.onRebakeBvh();
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.terrainStore.restoreChunkHeightsFromMap(cmd.terrainAfter);
    this.holeStore.restoreFromSnapshot(cmd.holeAfter);
    cmd.tunnel = this.splineSystem.addTunnel({
      points: cmd.tunnelParams.points,
      radius: cmd.tunnelParams.radius,
      radialSegs: cmd.tunnelParams.radialSegs,
      pathSegs: cmd.tunnelParams.pathSegs,
      color: cmd.tunnelParams.color,
    });
    this.chunkStream.markDirtyFull(cmd.dirtyKeys);
    this.undoStack.push(cmd);
    this.onHeightsChanged();
    this.onRebakeBvh();
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Restore hole chunks: keys painted by this tunnel that had no prior data get zeroed. */
  _restoreHoles(holeBefore, holeAfter) {
    const restore = new Map();
    for (const key of holeAfter.keys()) {
      const prior = holeBefore.get(key);
      if (prior) {
        restore.set(key, prior);
      } else {
        const entry = this.holeStore.getChunkByKey(key);
        if (entry) restore.set(key, new Uint8Array(entry.data.length));
      }
    }
    if (restore.size > 0) this.holeStore.restoreFromSnapshot(restore);
  }

  // ------------------------------------------------------------- helpers

  _chunkKeysAroundPoints(pts, margin) {
    const keys = new Set();
    if (pts.length === 0) return keys;
    const minX = Math.min(...pts.map((p) => p.x)) - margin;
    const maxX = Math.max(...pts.map((p) => p.x)) + margin;
    const minZ = Math.min(...pts.map((p) => p.z)) - margin;
    const maxZ = Math.max(...pts.map((p) => p.z)) + margin;
    const a = worldToChunkIndex(minX, minZ, this.config);
    const b = worldToChunkIndex(maxX, maxZ, this.config);
    const maxC = getChunkCountPerAxis(this.config) - 1;
    for (let cz = Math.max(0, a.cz); cz <= Math.min(maxC, b.cz); cz++) {
      for (let cx = Math.max(0, a.cx); cx <= Math.min(maxC, b.cx); cx++) {
        keys.add(chunkKey(cx, cz));
      }
    }
    return keys;
  }

  _snapshotTerrain(keys) {
    const map = new Map();
    for (const key of keys) {
      const [cx, cz] = key.split(",").map(Number);
      const heights = this.terrainStore.ensureChunkData(cx, cz);
      map.set(key, new Float32Array(heights));
    }
    return map;
  }

  /** Snapshot only hole chunks that already exist near the tunnel (cheap). */
  _snapshotExistingHoleChunks(samples, margin) {
    const minX = Math.min(...samples.map((p) => p.x)) - margin;
    const maxX = Math.max(...samples.map((p) => p.x)) + margin;
    const minZ = Math.min(...samples.map((p) => p.z)) - margin;
    const maxZ = Math.max(...samples.map((p) => p.z)) + margin;
    const map = new Map();
    for (const { cx, cz } of this.holeStore.getChunkIndicesInBounds(minX, minZ, maxX, maxZ)) {
      const entry = this.holeStore.getChunkByKey(chunkKey(cx, cz));
      if (entry) map.set(chunkKey(cx, cz), new Uint8Array(entry.data));
    }
    return map;
  }

  dispose() {
    this.cancelDraft();
    this.scene.remove(this.previewGroup);
    this._previewPointGeo.dispose();
    this._previewPointMat.dispose();
    this._previewTubeOuterMat.dispose();
    this._previewTubeInnerMat.dispose();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
