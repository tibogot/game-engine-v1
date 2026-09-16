/**
 * Waterfalls — the runtime half (runs in games too; the editing half is
 * v3/tools/waterfallEditor.js).
 *
 * A waterfall is its lip (waterfallPath.js FALL_DEFAULTS). The system solves
 * each lip against the world — terrain, solid props, the water surfaces below —
 * and builds ONE mesh holding every fall in the scene: one draw call, however
 * many falls. Each fall contributes two layers: the body sheet, and a thinner
 * veil standing off it (the loose outer water that gives a real fall its depth).
 *
 * Solving is CPU work done only when something changed — a fall edited, the
 * terrain sculpted, a lake or river moved (`markDirty`). A fall is a few
 * hundred integration steps per column; the whole scene re-solves in a few
 * milliseconds and the frame loop never touches it otherwise.
 *
 * Look: shared by all falls (waterfallState.js), two styles like River v2 —
 * realistic (waterfallMaterial.js) and stylized (waterfallStylizedMaterial.js).
 */
import * as THREE from "three";
import { solveFall, FALL_DEFAULTS } from "./waterfallPath.js";
import { createWaterfallMaterial } from "./waterfallMaterial.js";
import { createWaterfallStylizedMaterial } from "./waterfallStylizedMaterial.js";
import { createWaterfallPool } from "./waterfallPool.js";
import { createWaterfallCap } from "./waterfallCap.js";
import { createWaterfallSpray } from "./waterfallSpray.js";
import { createWaterfallLookState, effectiveWaterfallLook } from "../../app/state/waterfallState.js";

/** After the water surfaces (lakes 100, rivers 10) and decals (9). */
export const WATERFALL_RENDER_ORDER = 110;

let _nextId = 1;
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

function seedOf(id) {
  const s = Math.sin(id * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

export class WaterfallSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {(x:number, yFrom:number, z:number) => ({y,nx,ny,nz}|null)} [o.sampleGround]
   * @param {(x:number, z:number) => number} [o.sampleWater]
   * @param {() => object|null} [o.getRiverWater] River v2's water look, for `followRiver`
   * @param {(riverId:number) => object|null} [o.getRiverMouth] River v2's downstream end
   *   as `{ x, y, z, yaw, width, speed, depth }` (riverV2System.mouthOf)
   * @param {(x:number, z:number) => number} [o.sampleBaseGround] the ground BEFORE any
   *   river conformed it (riverV2System.sampleBase)
   * @param {() => Array} [o.getRiverMouths] every river's mouth, with `id`
   * @param {(riverId:number, open:boolean) => void} [o.setRiverMouthOpen]
   */
  constructor({
    scene, renderer = null, normalMap = null, sampleGround = null, sampleWater = null,
    getRiverWater = null, getRiverMouth = null, getRiverMouths = null, setRiverMouthOpen = null,
    sampleBaseGround = null,
  }) {
    this.normalMap = normalMap;
    this.sampleBaseGround = sampleBaseGround;
    this.renderer = renderer;
    this.getRiverMouth = getRiverMouth;
    this.getRiverMouths = getRiverMouths;
    this.setRiverMouthOpen = setRiverMouthOpen;
    this.falls = [];
    this.look = createWaterfallLookState();
    this.sampleGround = sampleGround ?? ((x, yFrom, z) => ({ y: 0, nx: 0, ny: 1, nz: 0 }));
    this.sampleWater = sampleWater ?? (() => -Infinity);
    this.getRiverWater = getRiverWater;

    this._solved = new Map();     // id → solveFall result
    this._ranges = [];            // [{ id, start, count }] in index order (for picking)
    this._dirty = true;
    this._time = 0;
    this.visibleCount = 0;

    this.group = new THREE.Group();
    this.group.name = "Waterfalls";
    scene.add(this.group);

    this._effective = effectiveWaterfallLook(this.look, this.getRiverWater?.());
    this._realistic = createWaterfallMaterial(this._effective, {
      normalMap,
      riverWater: this.getRiverWater?.(),
    });
    this._stylized = null;
    this._active = this._realistic;

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this._realistic.material);
    this.mesh.name = "WaterfallSheets";
    this.mesh.renderOrder = WATERFALL_RENDER_ORDER;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    // Hidden until update() has a fall to draw: a render before that (the boot
    // precompile) must not bind the scene-depth grab on the multisampled canvas.
    this.mesh.visible = false;
    this.group.add(this.mesh);

    // The impact: foam on whatever it lands in, and the spray and mist above it.
    this.pool = createWaterfallPool(this._effective);
    this.cap = createWaterfallCap(this._effective);
    this.group.add(this.pool.mesh, this.cap.mesh);
    this.spray = renderer ? createWaterfallSpray({ renderer, look: this._effective }) : null;
    if (this.spray) this.group.add(this.spray.sprayMesh, this.spray.mistMesh);

    this.syncLook();
  }

  // ── Data ────────────────────────────────────────────────────────────────

  add(params) {
    const f = { ...FALL_DEFAULTS, ...params };
    if (!Number.isInteger(f.id) || this.get(f.id)) f.id = _nextId;
    _nextId = Math.max(_nextId, f.id + 1);
    this.falls.push(f);
    this.markDirty(f.id);
    return f;
  }

  duplicate(id, offset = { x: 0, y: 0, z: 0 }) {
    const src = this.get(id);
    if (!src) return null;
    const { id: _, ...rest } = src;
    return this.add({ ...rest, px: src.px + offset.x, py: src.py + offset.y, pz: src.pz + offset.z });
  }

  get(id) { return this.falls.find((f) => f.id === id) ?? null; }

  remove(id) {
    const i = this.falls.findIndex((f) => f.id === id);
    if (i < 0) return false;
    const river = this.falls[i].river ?? null;
    this.falls.splice(i, 1);
    this._solved.delete(id);
    this._dirty = true;
    if (river != null) this._syncMouths(river);
    return true;
  }

  clear() {
    const rivers = [...new Set(this.falls.map((f) => f.river).filter((r) => r != null))];
    this.falls.length = 0;
    this._solved.clear();
    this._dirty = true;
    for (const r of rivers) this._syncMouths(r);
  }

  /** Re-solve one fall (id) or all of them (no id: terrain or water changed). */
  markDirty(id = null) {
    if (id === null) this._solved.clear();
    else this._solved.delete(id);
    this._dirty = true;
  }

  /** The fall list with ids, as a string — for undo. The look is not part of it. */
  snapshot() { return JSON.stringify(this.falls); }

  restore(snap) {
    const rivers = [...new Set(this.falls.map((f) => f.river).filter((r) => r != null))];
    this.falls.length = 0;
    this._solved.clear();
    for (const f of JSON.parse(snap)) this.add(f);
    this._dirty = true;
    for (const r of rivers) this._syncMouths(r);
    this._syncMouths();
  }

  /**
   * An attached fall takes its lip from the river's mouth. Called before every
   * solve, so a river edit moves the fall with it. Returns true if it changed.
   */
  _syncAttached(f) {
    if (f.river == null || !this.getRiverMouth) return false;
    const m = this.getRiverMouth(f.river);
    if (!m) { f.river = null; return true; }

    /*
     * WHERE THE LIP GOES. Not at the river's mouth: a river ends where its
     * author put the last node, which is rarely exactly on the brink. Between
     * the two the water has to run over ordinary ground, and that stretch reads
     * as a dry gap between the river and the fall.
     *
     * So the lip is marched DOWNSTREAM from the mouth to the point where the
     * ground actually falls away, and the crest is stretched back to cover the
     * distance — flat water from the river's own surface to the brink.
     */
    /*
     * The brink is read off the UNCONFORMED ground, not the ground as it stands.
     * The river's channel now runs to this lip, so the cut follows wherever the
     * lip goes — and reading the cut ground to place the lip makes the two chase
     * each other: the lip finds a brink, the channel digs to it, the dug ground
     * reads as a brink further back, the lip retreats.
     */
    const dx = Math.sin(m.yaw), dz = Math.cos(m.yaw);
    const base = this.sampleBaseGround
      ? (x, z) => this.sampleBaseGround(x, z)
      : (x, z) => this.sampleGround(x, m.y + 6, z)?.y ?? -Infinity;
    const base0 = base(m.x, m.z);
    let lipX = m.x, lipZ = m.z, bridge = 0;
    for (let d = 0.5; d <= 60; d += 0.5) {
      const x = m.x + dx * d, z = m.z + dz * d;
      const g = base(x, z);
      if (!Number.isFinite(g) || g < base0 - 1.2) break;   // the ground has gone: the brink
      if (g > base0 + 1.5) break;                          // a bar across the way
      lipX = x; lipZ = z; bridge = d;
    }
    // Reach back past the mouth so the crest lies over the river's own surface,
    // by exactly the band the two crossfade across.
    const crest = bridge + (f.crestOverlap ?? 2.5);

    const changed = f.px !== lipX || f.py !== m.y || f.pz !== lipZ || f.yaw !== m.yaw
      || f.width !== m.width || f.speed !== m.speed || f.crest !== crest || f.spread !== 0;
    f.px = lipX; f.py = m.y; f.pz = lipZ; f.yaw = m.yaw;
    f.width = m.width; f.speed = m.speed;
    // The fall carries the river's own water, at the river's own depth.
    f.depth = Math.max(0.05, m.depth);
    f.crest = crest;
    // No fan-out on an attached fall: the sheet leaves the lip exactly as wide
    // as the river that feeds it, which is the whole point of attaching.
    f.spread = 0;
    // The river's channel has to reach the lip, so it must know where it moved to.
    if (changed) this.setRiverMouthOpen?.(f.river, true, lipX, lipZ);
    return changed;
  }

  /** The solved path of a fall (solving it now if needed). */
  solved(id) {
    const f = this.get(id);
    if (!f) return null;
    if (this._syncAttached(f)) this._solved.delete(id);
    let s = this._solved.get(id);
    if (!s) {
      s = solveFall(f, { sampleGround: this.sampleGround, sampleWater: this.sampleWater });
      this._solved.set(id, s);
    }
    return s;
  }

  /** Attach fall `id` to river `riverId` (null detaches). Opens/closes the river's mouth. */
  attach(id, riverId) {
    const f = this.get(id);
    if (!f) return false;
    const prev = f.river ?? null;
    f.river = riverId ?? null;
    this._syncMouths(prev);
    this._syncAttached(f);
    this.markDirty(id);
    return true;
  }

  /**
   * Tell River v2 which mouths are open — those a fall is attached to — and
   * where each one's channel should run to, which is that fall's lip.
   */
  _syncMouths(alsoCheck = null) {
    if (!this.setRiverMouthOpen) return;
    const open = new Set();
    for (const f of this.falls) {
      if (f.river == null) continue;
      open.add(f.river);
      this.setRiverMouthOpen(f.river, true, f.px, f.pz);
    }
    if (alsoCheck != null && !open.has(alsoCheck)) this.setRiverMouthOpen(alsoCheck, false);
  }

  /** The river mouth within `radius` metres of (x, z), nearest first, or null. */
  nearestMouth(x, z, radius = 8) {
    if (!this.getRiverMouths) return null;
    let best = null;
    for (const m of this.getRiverMouths()) {
      const d = Math.hypot(m.x - x, m.z - z);
      if (d <= Math.max(radius, m.width * 0.75) && (!best || d < best.d)) best = { ...m, d };
    }
    return best;
  }

  /** Solve a fall that is not in the scene (placement preview). */
  preview(params) {
    return solveFall({ ...FALL_DEFAULTS, ...params }, { sampleGround: this.sampleGround, sampleWater: this.sampleWater });
  }

  exportData() {
    return {
      look: { ...this.look },
      falls: this.falls.map(({ id, ...rest }) => ({ ...rest })),
    };
  }

  /** Replace everything with saved data (null = no waterfalls, default look). */
  importData(data) {
    this.clear();
    Object.assign(this.look, createWaterfallLookState(), data?.look ?? {});
    for (const f of data?.falls ?? []) {
      const { id: _, ...rest } = f;
      this.add(rest);
    }
    this._syncMouths();
    this.syncLook();
  }

  // ── Look ────────────────────────────────────────────────────────────────

  /** Push the look to the materials; swaps realistic ↔ stylized. Cheap, call on any change. */
  syncLook() {
    const prevVeil = this._effective?.veilOffset;
    this._effective = effectiveWaterfallLook(this.look, this.getRiverWater?.());
    const eff = this._effective;
    this._realistic.syncParams(eff, this.getRiverWater?.());
    this.pool.syncParams(eff);
    this.cap.syncParams(eff);
    this.spray?.syncParams(eff);
    const stylized = eff.style === "stylized";
    if (stylized && !this._stylized) this._stylized = createWaterfallStylizedMaterial(eff);
    this._stylized?.syncParams(eff);
    const next = stylized ? this._stylized : this._realistic;
    if (next !== this._active) {
      this._active = next;
      this.mesh.material = next.material;
    }
    // The veil stands off the body in the geometry.
    if (prevVeil !== undefined && prevVeil !== eff.veilOffset) this._dirty = true;
  }

  get style() { return this._effective.style; }

  // ── Lighting (worldEnvironment.addWaterSurface drives these) ───────────

  setSunDir(v) { this._realistic.setSunDir(v); this.spray?.setSunDir(v); }
  /** River v2 drives the sheet's clock through the shared shader. */
  /**
   * worldEnvironment hands over the day/night sky. The sheet reflects it and
   * scatters it (which is what keeps the glass off black against dark rock),
   * and the mist takes its ambient from it.
   */
  setSkyColors(zenith, horizon) {
    this._realistic.setSkyColors(zenith, horizon);
    if (zenith) this.spray?.setSkyColor(zenith);
  }
  updateWater() {}
  setSunLight(color, intensity) {
    this._realistic.setSunLight(color, intensity);
    this.spray?.setSunLight(color, intensity);
  }

  /** The scene's fill light — what actually lights the mist away from the sun. */
  setAmbient(color, intensity) { this.spray?.setAmbient(color, intensity); }

  // ── Picking ─────────────────────────────────────────────────────────────

  /** Nearest fall under a ray, as { fall, distance, point } (null if none). */
  raycast(raycaster) {
    if (!this.falls.length || !this.mesh.geometry.index) return null;
    const hits = raycaster.intersectObject(this.mesh, false);
    for (const h of hits) {
      const idx = h.faceIndex * 3;
      const r = this._ranges.find((q) => idx >= q.start && idx < q.start + q.count);
      const fall = r ? this.get(r.id) : null;
      if (fall) return { fall, distance: h.distance, point: h.point };
    }
    return null;
  }

  /** World bounds of one fall (or every fall), for framing. */
  bounds(id = null, target = new THREE.Box3()) {
    target.makeEmpty();
    for (const f of this.falls) {
      if (id !== null && f.id !== id) continue;
      const s = this.solved(f.id);
      if (!s) continue;
      target.expandByPoint(new THREE.Vector3(s.bounds.minX, s.bounds.minY, s.bounds.minZ));
      target.expandByPoint(new THREE.Vector3(s.bounds.maxX, s.bounds.maxY, s.bounds.maxZ));
    }
    return target;
  }

  // ── Frame ───────────────────────────────────────────────────────────────

  update(dt, camera) {
    this._time += dt;
    this._active.update(this._time);
    if (this._active !== this._realistic) this._realistic.update(this._time);
    if (this.getRiverWater && this.look.followRiver && (this._followTick = (this._followTick ?? 0) + 1) % 15 === 0) {
      // River v2's look can change under us (its own panel): cheap compare.
      const key = JSON.stringify(effectiveWaterfallLook(this.look, this.getRiverWater()));
      if (key !== this._followKey) { this._followKey = key; this.syncLook(); }
    }
    if (this._dirty) this._rebuild();

    // Frustum count: the depth-read rule in main.js only needs the scene-depth
    // path while a fall can actually be on screen.
    let vis = 0;
    if (this.falls.length && camera) {
      _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pv, camera.coordinateSystem);
      for (const f of this.falls) {
        const s = this._solved.get(f.id);
        if (!s) continue;
        const b = s.bounds;
        _sphere.center.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
        _sphere.radius = 0.5 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) + 2;
        if (_frustum.intersectsSphere(_sphere)) vis++;
      }
    }
    this.visibleCount = vis;
    this.mesh.visible = vis > 0;

    // The impact effects follow the same visibility, and are fed the falls
    // nearest the camera first (the particle field has a fixed emitter budget).
    this.pool.update(this._time);
    this.cap.update(this._time);
    this.spray?.update();
    if (vis !== this._lastVis || this._impactDirty) {
      this._lastVis = vis;
      this._impactDirty = false;
      this._syncImpacts(camera);
    }
  }

  /** Feed the pool discs and the particle emitters from the solved falls. */
  _syncImpacts(camera) {
    const eff = this._effective;
    const entries = [];
    for (const f of this.falls) {
      const s = this._solved.get(f.id);
      if (s) entries.push({ fall: f, solved: s });
    }
    if (camera) {
      const c = camera.position;
      entries.sort((a, b) => {
        const A = a.solved.impact, B = b.solved.impact;
        return ((A.x - c.x) ** 2 + (A.y - c.y) ** 2 + (A.z - c.z) ** 2)
          - ((B.x - c.x) ** 2 + (B.y - c.y) ** 2 + (B.z - c.z) ** 2);
      });
    }
    this.pool.setPools(entries, eff);
    this.cap.setCaps(entries, eff);
    this.spray?.setEmitters(entries, eff);
  }

  _rebuild() {
    this._dirty = false;
    this._impactDirty = true;
    const solved = this.falls.map((f) => ({ f, s: this.solved(f.id) }));
    let verts = 0, idx = 0;
    for (const { s } of solved) {
      verts += s.count * 2;
      idx += (s.cols - 1) * (s.rows - 1) * 6 * 2;
    }
    const geo = new THREE.BufferGeometry();
    this._ranges = [];
    if (verts === 0) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geo;
      return;
    }
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 3);
    const aFlow = new Float32Array(verts * 4);
    const aFall = new Float32Array(verts * 4);
    const aSide = new Float32Array(verts * 4);
    const aMisc = new Float32Array(verts * 4);
    // Upper bound: quads are skipped, never added.
    const index = new Uint32Array(idx);
    let indexCount = 0;
    const veilOffset = this._effective.veilOffset;

    let vBase = 0, iBase = 0;
    const P = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), N = new THREE.Vector3();
    for (const { f, s } of solved) {
      const { cols, rows } = s;
      const seed = seedOf(f.id);
      const lipDepth = Math.max(0.02, f.depth);
      const thinning = Math.max(0, Math.min(1, this._effective.thinning ?? 0));
      const rangeStart = iBase;
      const at = (j, i, out) => {
        const v = (Math.min(cols - 1, Math.max(0, j)) * rows + Math.min(rows - 1, Math.max(0, i))) * 3;
        return out.set(s.position[v], s.position[v + 1], s.position[v + 2]);
      };
      const rowWidth = new Float32Array(rows);
      for (let i = 0; i < rows; i++) rowWidth[i] = Math.max(0.25, at(0, i, A).distanceTo(at(cols - 1, i, B)));

      for (let layer = 0; layer < 2; layer++) {
        for (let j = 0; j < cols; j++) {
          for (let i = 0; i < rows; i++) {
            const v = j * rows + i;
            const o = vBase + v;
            // Across and along tangents from the grid neighbours.
            const across = at(j + 1, i, A).sub(at(j - 1, i, B));
            if (across.lengthSq() < 1e-8) across.set(-s.impact.dirZ, 0, s.impact.dirX);
            across.normalize();
            const along = at(j, i + 1, B).sub(at(j, i - 1, N));
            if (along.lengthSq() < 1e-8) along.set(0, -1, 0);
            N.crossVectors(across, along).normalize();

            at(j, i, P);
            // The crest lies over the river's own surface (and its waves): a few
            // centimetres up, or the two fight for the same pixels.
            P.y += s.crest[v] * 0.08;
            const acrossM = s.across[v] * rowWidth[i];
            let halfW = rowWidth[i] / 2;
            if (layer === 1) {
              const off = veilOffset * (0.3 + s.frac[v] * 1.7);
              P.addScaledVector(N, off).addScaledVector(across, acrossM * 0.08);
              halfW *= 1.08;
            }
            pos.set([P.x, P.y, P.z], o * 3);
            nrm.set([N.x, N.y, N.z], o * 3);
            // Thickness: the river's depth, thinned toward the flux-conserved
            // value by `thinning` (0 = the same water as the river).
            const thick = lipDepth + (s.thickness[v] - lipDepth) * thinning;
            aFlow.set([layer === 1 ? acrossM * 1.08 : acrossM, s.time[v], s.speed[v], thick], o * 4);
            aFall.set([s.arc[v], s.frac[v], seed, layer], o * 4);
            aSide.set([across.x, across.y, across.z, halfW], o * 4);
            aMisc.set([s.contact[v], f.foam, Math.max(0.02, f.depth), s.crest[v]], o * 4);
          }
        }
        // A quad is only drawn where both its columns carry water and the two
        // are still side by side. Columns can end in very different places (one
        // reaches the pool, its neighbour catches a ledge), and joining those
        // stretches a quad the length of the fall — a long white spike.
        const maxSpan = Math.max(3, (s.width / Math.max(1, cols - 1)) * 6);
        for (let j = 0; j < cols - 1; j++) {
          if (s.colDead[j] || s.colDead[j + 1]) continue;
          for (let i = 0; i < rows - 1; i++) {
            const a = vBase + j * rows + i, b = a + rows, c = a + 1, d = b + 1;
            at(j, i, A); at(j + 1, i, B);
            if (A.distanceTo(B) > maxSpan) continue;
            at(j, i + 1, A); at(j + 1, i + 1, B);
            if (A.distanceTo(B) > maxSpan) continue;
            index.set([a, b, c, c, b, d], iBase);
            iBase += 6;
          }
        }
        vBase += s.count;
      }
      this._ranges.push({ id: f.id, start: rangeStart, count: iBase - rangeStart });
      indexCount = iBase;
    }

    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute("aFlow", new THREE.BufferAttribute(aFlow, 4));
    geo.setAttribute("aFall", new THREE.BufferAttribute(aFall, 4));
    geo.setAttribute("aSide", new THREE.BufferAttribute(aSide, 4));
    geo.setAttribute("aMisc", new THREE.BufferAttribute(aMisc, 4));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.setDrawRange(0, indexCount);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this._realistic.material.dispose();
    this._stylized?.material.dispose();
    this.pool.dispose();
    this.cap.dispose();
    this.spray?.dispose();
    this.group.removeFromParent();
  }
}
