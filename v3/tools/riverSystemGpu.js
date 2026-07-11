import * as THREE from "three";
import { QuadMesh, MeshBasicNodeMaterial } from "three/webgpu";
import {
  Fn,
  If,
  Break,
  Loop,
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  mx_noise_float,
  positionWorld,
  pow,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from "three/tsl";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";
import { createLakeMaterial } from "../render/water/lakeMaterial.js";
import { depthWaterParams } from "../app/state/depthWaterState.js";

/**
 * River+ for V3 — fully GPU-resident carve pipeline.
 *
 * Carving no longer round-trips the heightmap through the CPU. The spline is
 * sampled into a small path texture and rasterized into the sculpt heightmap
 * RT with scissored fragment passes (same pattern as sculptBrush), so a
 * re-carve costs a fraction of a millisecond and runs live while dragging.
 *
 * Base management:
 *  - rtBase holds the UNCARVED terrain, captured lazily at first carve.
 *  - Every re-carve restores rtBase → rtMain, then re-rasterizes all rivers.
 *  - Carve passes tag carved texels in the G channel of rtMain. When external
 *    tools edit the terrain (sculpt stroke, procedural gen, load), main.js
 *    calls notifyTerrainEdited(): a rebase pass folds rtMain back into rtBase,
 *    using G to keep the uncarved base under untouched river channels.
 *  - cpuBase mirrors rtBase for the water-level profile (smoothed + monotonic
 *    downhill along the centerline, computed on the CPU — a few hundred taps).
 *
 * Water surface: flat across the width, follows the downhill profile along the
 * length. U coordinate is arc-length in METRES so flow speed and foam features
 * are world-scaled. Per-column slope drives rapids foam on steep drops.
 *
 * Profile shape: the downhill-enforced water level is clamped to never sit more
 * than `maxGorgeDepth` metres below the LOCAL uncarved ground, so a spline drawn
 * across a mountain carves a bounded gorge over the pass instead of excavating
 * the whole mountain down to valley level.
 *
 * Branches: rivers form a tree. An endpoint dropped near another river snaps
 * onto its centerline (seg.link = { parentId, end }) and becomes a tributary —
 * its profile solve runs after the parent's and pins the mouth to the parent's
 * water level at that station, so the confluence is level-continuous. The carve
 * needs no junction geometry: every river min()-rasterizes into the same
 * heightmap, so overlapping channels union for free.
 */

const MAX_PATH_POINTS = 384;   // path texture width (points per river)
const CHUNK_SEGS      = 32;    // spline segments rasterized per scissored pass
const MAX_UNDO        = 40;

function makeHeightRT(w = HEIGHTMAP_SIZE, h = HEIGHTMAP_SIZE) {
  const rt = new THREE.RenderTarget(w, h, {
    format:          THREE.RGBAFormat,
    type:            THREE.HalfFloatType,
    minFilter:       THREE.LinearFilter,
    magFilter:       THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer:     false,
    colorSpace:      THREE.NoColorSpace,
  });
  rt.texture.flipY = false;
  return rt;
}

/** Bilinear sample of a normalized height field at world coords → metres. */
function sampleBaseWorld(heights, wx, wz) {
  const S = HEIGHTMAP_SIZE;
  const res = S - 1;
  const u = (wx + WORLD_SIZE * 0.5) / WORLD_SIZE;
  const v = (wz + WORLD_SIZE * 0.5) / WORLD_SIZE;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const fx = u * res;
  const fz = v * res;
  const ix0 = Math.floor(fx);
  const iz0 = Math.floor(fz);
  const ix1 = Math.min(ix0 + 1, res);
  const iz1 = Math.min(iz0 + 1, res);
  const tx = fx - ix0;
  const tz = fz - iz0;
  const h0 = heights[iz0 * S + ix0] * (1 - tx) + heights[iz0 * S + ix1] * tx;
  const h1 = heights[iz1 * S + ix0] * (1 - tx) + heights[iz1 * S + ix1] * tx;
  return (h0 * (1 - tz) + h1 * tz) * MAX_HEIGHT;
}

export class RiverSystemGPU {
  /**
   * @param {object} opts
   * @param {THREE.Scene}    opts.scene
   * @param {object}         opts.toolState          shared river/river2 slices
   * @param {object}         opts.renderer           WebGPURenderer
   * @param {function}       opts.getRT              () => rtMain (sculpt.getCurrentRT)
   * @param {object}         opts.heightTexNode      live TSL TextureNode of rtMain
   * @param {Float32Array}   opts.cpuHeightmap       main.js CPU mirror (normalized)
   * @param {function}       opts.ensureCpuHeightmap async () => refresh cpuHeightmap from GPU
   * @param {function}       opts.onCarveCommitted   () => sync grass/trees/bvh after a committed carve
   */
  constructor({ scene, toolState, renderer, getRT, heightTexNode, cpuHeightmap, ensureCpuHeightmap, onCarveCommitted, waterNormalMap = null }) {
    this.scene = scene;
    this.toolState = toolState;
    this.renderer = renderer;
    this.getRT = getRT;
    this.heightTexNode = heightTexNode;
    this.cpuHeightmap = cpuHeightmap;
    this.ensureCpuHeightmap = ensureCpuHeightmap;
    this.onCarveCommitted = onCarveCommitted;
    this.waterNormalMap = waterNormalMap;

    // segments: { id, points: Vector3[], mesh: Mesh|null,
    //             profile: {pts,levels,arc,slopes}|null,
    //             link: { parentId, end: 0|1 }|null  — tributary mouth on a parent river }
    this.segments = [];
    this.selectedIdx = -1;
    this.dragging = false;
    this._nextSegId = 1;
    this._profileStack = new Set(); // re-entrancy guard for parent-profile recursion

    this.undoStack = [];
    this.redoStack = [];
    this._time = 0;

    // ── GPU carve state ───────────────────────────────────────────────────────
    this._rtBase = null;           // uncarved terrain (captured lazily)
    this._rtBasePong = null;       // rebase ping-pong target
    this._rtScratch = makeHeightRT();
    this._cpuBase = null;          // Float32Array mirror of rtBase (normalized)
    this._baseReady = false;
    this._basePromise = null;      // in-flight first capture
    this._rebaseTimer = 0;
    this._baseReadbackInFlight = false;
    this._baseReadbackPending = false;
    this._liveCarveQueued = false;

    // Path texture: MAX_PATH_POINTS × 1 RGBA32F — (u, v, levelNorm, 0)
    this._pathData = new Float32Array(MAX_PATH_POINTS * 4);
    this._pathTex = new THREE.DataTexture(
      this._pathData, MAX_PATH_POINTS, 1, THREE.RGBAFormat, THREE.FloatType,
    );
    this._pathTex.minFilter = THREE.NearestFilter;
    this._pathTex.magFilter = THREE.NearestFilter;
    this._pathTex.needsUpdate = true;

    this._initCarvePasses();
    this._initWaterMaterials();

    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "RiverGpuHandles";
    this.scene.add(this.handleGroup);
    this.handleMeshes = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GPU passes
  // ═══════════════════════════════════════════════════════════════════════════

  _initCarvePasses() {
    // Copy pass — preserves R (height) and G (carve flag). Used for
    // main→scratch (carve read source), base→main (restore), main→base (capture).
    this._copySrc = texture(this._pathTex); // placeholder; .value swapped per use
    const copyMat = new MeshBasicNodeMaterial();
    copyMat.fragmentNode = Fn(() => {
      const s = texture(this._copySrc, uv());
      return vec4(s.r, s.g, float(0), float(1));
    })();
    this._copyQuad = new QuadMesh(copyMat);

    // Carve pass — reads scratch, writes main. Rasterizes CHUNK_SEGS spline
    // segments: nearest-segment distance in UV space, bed level from the
    // per-point water profile, lower-only min() so banks never rise.
    this._uSegStart   = uniform(0);   // first point index of this chunk
    this._uSegEnd     = uniform(0);   // exclusive segment end (last point index)
    this._uHalfW      = uniform(0.01);   // channel half-width, UV units
    this._uShoulder   = uniform(0.01);   // blend shoulder, UV units
    this._uDepthN     = uniform(0.01);   // carve depth, normalized height
    this._uBedCurveN  = uniform(0);      // extra center depth (U-shaped bed), normalized

    const scratchTex = this._rtScratch.texture;
    const pathTex = this._pathTex;

    const carveMat = new MeshBasicNodeMaterial();
    carveMat.fragmentNode = Fn(() => {
      const uvC = uv();
      const src = texture(scratchTex, uvC);
      const h = src.r;

      const bestD2 = float(1e9).toVar();
      const bestLevel = float(0).toVar();

      Loop(CHUNK_SEGS, ({ i }) => {
        const idx = float(i).add(this._uSegStart);
        If(idx.greaterThanEqual(this._uSegEnd), () => { Break(); });

        const a = texture(pathTex, vec2(idx.add(0.5).div(MAX_PATH_POINTS), 0.5));
        const b = texture(pathTex, vec2(idx.add(1.5).div(MAX_PATH_POINTS), 0.5));

        const ab = b.xy.sub(a.xy);
        const len2 = max(dot(ab, ab), float(1e-12));
        const t = clamp(dot(uvC.sub(a.xy), ab).div(len2), float(0), float(1));
        const p = a.xy.add(ab.mul(t));
        const d = uvC.sub(p);
        const d2 = dot(d, d);
        If(d2.lessThan(bestD2), () => {
          bestD2.assign(d2);
          bestLevel.assign(mix(a.z, b.z, t));
        });
      });

      const dist = sqrt(bestD2);
      // U-shaped bed: deepest at the centerline, back to base depth at the banks.
      const centerT = clamp(dist.div(this._uHalfW), float(0), float(1));
      const bed = bestLevel.sub(this._uDepthN)
        .sub(this._uBedCurveN.mul(float(1).sub(centerT.mul(centerT))));

      // 1 inside the channel, smooth 1→0 across the shoulder.
      const blend = float(1).sub(smoothstep(this._uHalfW, this._uHalfW.add(this._uShoulder), dist));
      const target = mix(h, bed, blend);
      const newH = min(h, target);

      // Tag carved texels so notifyTerrainEdited() can rebase around them.
      const carved = max(src.g, smoothstep(float(0), float(0.00002), h.sub(newH)));
      return vec4(newH, carved, float(0), float(1));
    })();
    this._carveQuad = new QuadMesh(carveMat);

    // Rebase pass — newBase = mix(main, oldBase, mainCarveFlag).
    // Where the river carved (G=1) the old uncarved base survives; everywhere
    // else the externally edited terrain becomes the new base.
    this._rebaseMainSrc = texture(this._pathTex); // .value swapped per use
    this._rebaseBaseSrc = texture(this._pathTex);
    const rebaseMat = new MeshBasicNodeMaterial();
    rebaseMat.fragmentNode = Fn(() => {
      const m = texture(this._rebaseMainSrc, uv());
      const b = texture(this._rebaseBaseSrc, uv());
      return vec4(mix(m.r, b.r, clamp(m.g, float(0), float(1))), float(0), float(0), float(1));
    })();
    this._rebaseQuad = new QuadMesh(rebaseMat);
  }

  /** Scissored quad render into an RT (same contract as sculptBrush._render). */
  _render(quad, dstRT, rect) {
    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (rect) {
      dstRT.scissor.set(rect.x, rect.y, rect.w, rect.h);
      renderer.setScissorTest(true);
    }
    renderer.setRenderTarget(dstRT);
    quad.render(renderer);
    renderer.setRenderTarget(null);
    if (rect) renderer.setScissorTest(false);
    renderer.autoClear = prevAutoClear;
  }

  _blit(srcTexture, dstRT, rect = null) {
    this._copySrc.value = srcTexture;
    this._render(this._copyQuad, dstRT, rect);
  }

  _clampRect(x0, y0, x1, y1) {
    const S = HEIGHTMAP_SIZE;
    x0 = Math.max(0, Math.min(S, Math.floor(x0)));
    y0 = Math.max(0, Math.min(S, Math.floor(y0)));
    x1 = Math.max(0, Math.min(S, Math.ceil(x1)));
    y1 = Math.max(0, Math.min(S, Math.ceil(y1)));
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Base (uncarved terrain) lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  _hasCarvableSegment() {
    return this.segments.some((s) => s.points.length >= 2);
  }

  /** Lazily capture rtMain + cpuHeightmap as the uncarved base. */
  async _captureBase() {
    if (this._baseReady) return;
    if (this._basePromise) return this._basePromise;
    this._basePromise = (async () => {
      await this.ensureCpuHeightmap?.();
      if (!this._rtBase) {
        this._rtBase = makeHeightRT();
        this._rtBasePong = makeHeightRT();
      }
      this._blit(this.getRT().texture, this._rtBase);
      this._cpuBase = new Float32Array(this.cpuHeightmap);
      this._baseReady = true;
      this._basePromise = null;
    })();
    return this._basePromise;
  }

  _dropBase() {
    this._baseReady = false;
    this._cpuBase = null;
    // Keep the RTs allocated — they're reused on the next capture.
  }

  /**
   * External terrain edit (sculpt stroke, procedural gen, undo, load).
   * Folds rtMain into rtBase around the tagged river channels, then refreshes
   * the CPU base mirror. Debounced — bursty edits collapse into one rebase.
   */
  notifyTerrainEdited() {
    if (!this._baseReady) return;
    clearTimeout(this._rebaseTimer);
    this._rebaseTimer = setTimeout(() => this._rebaseNow(), 150);
  }

  _rebaseNow() {
    if (!this._baseReady) return;
    this._rebaseMainSrc.value = this.getRT().texture;
    this._rebaseBaseSrc.value = this._rtBase.texture;
    this._render(this._rebaseQuad, this._rtBasePong, null);
    const t = this._rtBase;
    this._rtBase = this._rtBasePong;
    this._rtBasePong = t;
    void this._readbackBaseToCpu();
  }

  async _readbackBaseToCpu() {
    if (this._baseReadbackInFlight) {
      this._baseReadbackPending = true;
      return;
    }
    this._baseReadbackInFlight = true;
    this._baseReadbackPending = false;
    try {
      const raw = await this.renderer.readRenderTargetPixelsAsync(
        this._rtBase, 0, 0, HEIGHTMAP_SIZE, HEIGHTMAP_SIZE,
      );
      if (!this._cpuBase) return;
      const isHalf = raw instanceof Uint16Array;
      for (let i = 0; i < HEIGHTMAP_SIZE * HEIGHTMAP_SIZE; i++) {
        const r = raw[i * 4];
        this._cpuBase[i] = isHalf ? THREE.DataUtils.fromHalfFloat(r) : r;
      }
    } finally {
      this._baseReadbackInFlight = false;
      if (this._baseReadbackPending) void this._readbackBaseToCpu();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Water-level profile (CPU — a few hundred taps into the base mirror)
  // ═══════════════════════════════════════════════════════════════════════════

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
   * Tributary variant: descend TOWARD a pinned mouth. The mouth level comes from
   * the parent river, so it is fixed; walking upstream from it, the level may
   * only rise (a source lower than the mouth becomes a flat backwater arm).
   */
  _enforceDownhillTo(arr, mouthIdx, mouthLevel) {
    const n = arr.length;
    if (n < 2) return;
    arr[mouthIdx] = mouthLevel;
    if (mouthIdx === 0) {
      for (let i = 1; i < n; i++) if (arr[i] < arr[i - 1]) arr[i] = arr[i - 1];
    } else {
      for (let i = n - 2; i >= 0; i--) if (arr[i] < arr[i + 1]) arr[i] = arr[i + 1];
    }
  }

  _profilePointCount() {
    const rp = this.toolState.river2;
    return Math.min(MAX_PATH_POINTS - 2, Math.max(120, rp.segments | 0));
  }

  /**
   * Sample the centerline into spaced points and build the smooth, strictly
   * downhill water-level profile from the UNCARVED base, plus arc lengths
   * (metres) and per-point downhill slopes for the rapids foam.
   */
  _computeProfile(seg) {
    if (seg.points.length < 2 || !this._cpuBase) return null;
    const rp = this.toolState.river2;
    const curve = new THREE.CatmullRomCurve3(seg.points, !!rp.closed, "catmullrom", 0.5);
    const pts = curve.getSpacedPoints(this._profilePointCount());
    const n = pts.length;

    // Water level = the LOWEST uncarved ground across the carve corridor, not the
    // height at the centreline.
    //
    // Sampling only the centreline is fine on a valley floor but wrong on a
    // hillside: the ground on the downhill flank sits below the centreline, so the
    // water surface ends up above it and the river spills sideways out of its own
    // trench. Carving cannot save it — the carve only ever lowers terrain, it never
    // builds a levee. Taking the corridor minimum puts the surface under the lowest
    // rim, which is also what a real river does: it finds the bottom of the valley.
    const reach = rp.width * 0.5 + rp.carveShoulder;
    const OFFSETS = [-1, -0.5, 0, 0.5, 1];
    const levels = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(n - 1, i + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len; tz /= len;
      const px = -tz, pz = tx;   // perpendicular, XZ

      let lo = Infinity;
      for (const o of OFFSETS) {
        const dx = px * reach * o, dz = pz * reach * o;
        const h = sampleBaseWorld(this._cpuBase, pts[i].x + dx, pts[i].z + dz);
        if (h < lo) lo = h;
      }
      levels[i] = lo;
    }

    // Local uncarved ground (lightly smoothed) — the bound the gorge clamp
    // measures from. Captured BEFORE the heavy smoothing/enforcement below.
    const bound = Float32Array.from(levels);
    this._smoothInPlace(bound, 2);

    // Tributary mouth pin: the linked endpoint must sit at the parent's water
    // level at that station, or the confluence gets a step.
    let pin = null;
    if (seg.link && !rp.closed) {
      const parent = this._segById(seg.link.parentId);
      if (parent && parent !== seg && parent.points.length >= 2) {
        const pp = this._ensureProfile(parent);
        if (pp) {
          const idx = seg.link.end === 0 ? 0 : n - 1;
          const c = this._closestOnPolyline(pp.pts, pts[idx].x, pts[idx].z);
          if (c) pin = { idx, level: pp.levels[c.i] + (pp.levels[c.i + 1] - pp.levels[c.i]) * c.t };
        }
      }
    }

    // Downhill enforcement digs a spline crossing a mountain down to valley
    // level; the clamp raises the level back to at most `maxGorgeDepth` below
    // the local ground, so the water rides over the pass in a bounded gorge.
    const gorge = Math.max(0, rp.maxGorgeDepth ?? 10);
    const enforce = () => {
      if (pin) this._enforceDownhillTo(levels, pin.idx, pin.level);
      else this._enforceDownhill(levels);
    };
    const clampGorge = () => {
      if (!(gorge > 0)) return;
      for (let i = 0; i < n; i++) {
        const floor = bound[i] - gorge;
        if (levels[i] < floor) levels[i] = floor;
      }
    };
    this._smoothInPlace(levels, 8);
    enforce();
    clampGorge();
    this._smoothInPlace(levels, 3);
    enforce();
    clampGorge();
    if (pin) levels[pin.idx] = pin.level; // exact continuity at the mouth

    const arc = new Float32Array(n);
    for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + pts[i].distanceTo(pts[i - 1]);

    const slopes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      const run = Math.max(0.001, arc[i1] - arc[i0]);
      slopes[i] = Math.max(0, Math.abs(levels[i0] - levels[i1]) / run);
    }

    return { pts, levels, arc, slopes };
  }

  _ensureProfile(seg) {
    if (!seg.profile) {
      if (this._profileStack.has(seg)) return null; // defensive: broken link cycle
      this._profileStack.add(seg);
      try {
        seg.profile = this._computeProfile(seg);
      } finally {
        this._profileStack.delete(seg);
      }
    }
    return seg.profile;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Branch links (tributaries) — rivers form a tree via endpoint snapping
  // ═══════════════════════════════════════════════════════════════════════════

  _segById(id) {
    return this.segments.find((s) => s.id === id) ?? null;
  }

  _childrenOf(seg) {
    return this.segments.filter((s) => s.link && s.link.parentId === seg.id);
  }

  /** Would linking `seg` under `parentSeg` create a cycle? */
  _wouldCycle(parentSeg, seg) {
    let cur = parentSeg;
    const seen = new Set();
    while (cur) {
      if (cur === seg) return true;
      if (!cur.link || seen.has(cur.id)) return false;
      seen.add(cur.id);
      cur = this._segById(cur.link.parentId);
    }
    return false;
  }

  /** A river's centerline, densely sampled — link snapping and re-gluing target. */
  _segCurvePoints(seg) {
    const curve = new THREE.CatmullRomCurve3(seg.points, !!this.toolState.river2.closed, "catmullrom", 0.5);
    return curve.getSpacedPoints(160);
  }

  /** Closest point on a polyline in XZ. Returns { x, z, dist, i, t } or null. */
  _closestOnPolyline(pts, x, z) {
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x, az = pts[i].z;
      const abx = pts[i + 1].x - ax, abz = pts[i + 1].z - az;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / len2)) : 0;
      const px = ax + abx * t, pz = az + abz * t;
      const d = Math.hypot(x - px, z - pz);
      if (!best || d < best.dist) best = { x: px, z: pz, dist: d, i, t };
    }
    return best;
  }

  _snapRadius() {
    return Math.max(4, (this.toolState.river2.width ?? 8) * 0.75);
  }

  /**
   * Re-evaluate this river's endpoint links. The closest other-river centerline
   * within the snap radius wins (one link per river); the endpoint is glued
   * exactly onto it. An endpoint dragged out of range unlinks. With branchSnap
   * off the feature is dormant: no new links, existing ones untouched.
   */
  _updateEndpointLinks(seg) {
    const rp = this.toolState.river2;
    if (!(rp.branchSnap ?? true) || rp.closed || seg.points.length < 1) return;
    const radius = this._snapRadius();
    const ends = seg.points.length === 1 ? [0] : [0, 1];
    let best = null;
    for (const end of ends) {
      const p = seg.points[end === 0 ? 0 : seg.points.length - 1];
      for (const parent of this.segments) {
        if (parent === seg || parent.points.length < 2) continue;
        if (this._wouldCycle(parent, seg)) continue;
        const c = this._closestOnPolyline(this._segCurvePoints(parent), p.x, p.z);
        if (!c || c.dist > radius) continue;
        if (!best || c.dist < best.dist) best = { end, parent, c };
      }
    }
    if (best) {
      seg.link = { parentId: best.parent.id, end: best.end };
      const p = seg.points[best.end === 0 ? 0 : seg.points.length - 1];
      p.x = best.c.x;
      p.z = best.c.z;
    } else {
      seg.link = null;
    }
  }

  /** Invalidate a river's profile and every downstream-dependent tributary's. */
  _invalidateWithDescendants(seg, visited = new Set()) {
    if (visited.has(seg.id)) return;
    visited.add(seg.id);
    seg.profile = null;
    for (const c of this._childrenOf(seg)) this._invalidateWithDescendants(c, visited);
  }

  /** After a river's shape changed, slide its tributaries' mouths back onto it. */
  _reglueChildren(seg, visited = new Set()) {
    if (visited.has(seg.id)) return;
    visited.add(seg.id);
    if (seg.points.length < 2) return;
    const pts = this._segCurvePoints(seg);
    for (const child of this._childrenOf(seg)) {
      const p = child.points[child.link.end === 0 ? 0 : child.points.length - 1];
      if (p) {
        const c = this._closestOnPolyline(pts, p.x, p.z);
        if (c) { p.x = c.x; p.z = c.z; }
      }
      child.profile = null;
      this._reglueChildren(child, visited);
    }
  }

  /** Every structural edit funnels through here before the re-carve. */
  _afterStructuralEdit(seg) {
    this._invalidateWithDescendants(seg);
    this._updateEndpointLinks(seg);
    this._reglueChildren(seg);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Carving
  // ═══════════════════════════════════════════════════════════════════════════

  /** Upload one river's profile into the path texture (UV coords + normalized level). */
  _uploadPath(profile) {
    const { pts, levels } = profile;
    const n = Math.min(pts.length, MAX_PATH_POINTS);
    const d = this._pathData;
    const half = WORLD_SIZE * 0.5;
    for (let i = 0; i < n; i++) {
      d[i * 4 + 0] = (pts[i].x + half) / WORLD_SIZE;
      d[i * 4 + 1] = (pts[i].z + half) / WORLD_SIZE;
      d[i * 4 + 2] = levels[i] / MAX_HEIGHT;
      d[i * 4 + 3] = 0;
    }
    this._pathTex.needsUpdate = true;
    return n;
  }

  /** Rasterize one river into rtMain with chunked scissored passes. */
  _carveSegment(seg) {
    const profile = this._ensureProfile(seg);
    if (!profile) return;
    const rp = this.toolState.river2;
    const n = this._uploadPath(profile);
    if (n < 2) return;

    const halfW = rp.width * 0.5;
    const reach = halfW + rp.carveShoulder;
    const S = HEIGHTMAP_SIZE;
    const half = WORLD_SIZE * 0.5;
    const rtMain = this.getRT();

    this._uHalfW.value = halfW / WORLD_SIZE;
    this._uShoulder.value = Math.max(0.25, rp.carveShoulder) / WORLD_SIZE;
    this._uDepthN.value = rp.carveDepth / MAX_HEIGHT;
    this._uBedCurveN.value = (rp.bedCurve ?? 0) * rp.carveDepth / MAX_HEIGHT;

    const { pts } = profile;
    for (let s = 0; s < n - 1; s += CHUNK_SEGS) {
      const e = Math.min(s + CHUNK_SEGS, n - 1); // exclusive segment end == last point idx
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = s; i <= e; i++) {
        const p = pts[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
      const rect = this._clampRect(
        ((minX - reach + half) / WORLD_SIZE) * S - 2,
        ((minZ - reach + half) / WORLD_SIZE) * S - 2,
        ((maxX + reach + half) / WORLD_SIZE) * S + 2,
        ((maxZ + reach + half) / WORLD_SIZE) * S + 2,
      );
      if (!rect) continue;

      this._uSegStart.value = s;
      this._uSegEnd.value = e;
      this._blit(rtMain.texture, this._rtScratch, rect);
      this._render(this._carveQuad, rtMain, rect);
    }
  }

  /** Restore the uncarved base into rtMain, then re-rasterize every river. */
  _recarveAllGpu() {
    if (!this._baseReady) return false;
    this._blit(this._rtBase.texture, this.getRT());
    let any = false;
    for (const seg of this.segments) {
      if (seg.points.length < 2) continue;
      this._carveSegment(seg);
      any = true;
    }
    return any;
  }

  /**
   * Full re-carve. `commit` also refreshes the CPU heightmap mirror and
   * dependent systems (grass, trees, BVH) — call it on mouse-up, not per frame.
   */
  applyCarve({ rebuild = true, commit = true } = {}) {
    if (!this._hasCarvableSegment()) {
      if (this._baseReady) {
        this._blit(this._rtBase.texture, this.getRT());
        this._dropBase();
        if (commit) this.onCarveCommitted?.();
      }
      if (rebuild) this._rebuildVisual();
      return;
    }

    if (!this._baseReady) {
      void this._captureBase().then(() => {
        this._recarveAllGpu();
        if (rebuild) this._rebuildVisual();
        if (commit) this.onCarveCommitted?.();
        this._updateSelectedY();
      });
      return;
    }

    this._recarveAllGpu();
    if (rebuild) this._rebuildVisual();
    if (commit) this.onCarveCommitted?.();
  }

  refreshCarving() {
    this._invalidateProfiles();
    this.applyCarve({ rebuild: true, commit: true });
  }

  _invalidateProfiles() {
    for (const seg of this.segments) seg.profile = null;
  }

  /** Throttled live re-carve while dragging a handle (one per animation frame). */
  _queueLiveCarve() {
    if (this._liveCarveQueued) return;
    this._liveCarveQueued = true;
    requestAnimationFrame(() => {
      this._liveCarveQueued = false;
      if (!this.dragging) return; // finalizeMove already did the committed pass
      const ai = this._activeIdx();
      if (ai >= 0) this._invalidateWithDescendants(this.segments[ai]);
      this.applyCarve({ rebuild: false, commit: false });
      this._rebuildActiveSegMesh();
      this._updateDragHandles();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Water surface geometry
  // ═══════════════════════════════════════════════════════════════════════════

  /** True when the water surface is cut by the depth buffer rather than by its own edge. */
  _isDepthStyle() {
    return this.toolState.river2.shaderStyle === "Depth" && !!this.waterNormalMap;
  }

  /**
   * Half-width of the water ribbon, in metres.
   *
   * Depth style spans the ENTIRE carve footprint. The waterline is then found per
   * pixel by the material's Discard, so the ribbon only has to over-cover. The
   * legacy styles draw their own edge, so they keep the old ad-hoc width.
   *
   * The old width was a constant `width/2 + min(shoulder, width)/2`, but the real
   * waterline distance varies station to station with the local bank slope — it was
   * measured at 8.5 m to 10.25 m along one river against a fixed 8 m ribbon. No
   * constant can match it, which is why the depth style stops trying.
   */
  _ribbonHalfWidth() {
    const rp = this.toolState.river2;
    return this._isDepthStyle()
      ? rp.width * 0.5 + rp.carveShoulder
      : rp.width * 0.5 + Math.min(rp.carveShoulder, rp.width) * 0.5;
  }

  /**
   * Water surface height at a station, in metres.
   *
   * Depth style sits `freeboard` metres BELOW the profile, i.e. down inside the
   * trench. The carve only ever lowers terrain (`newH = min(h, target)`), so a
   * surface at or above the profile can never meet a bank on flat ground — it just
   * floats. Legacy styles keep `heightOffset`, which is that bug.
   */
  _waterY(level) {
    const rp = this.toolState.river2;
    if (!this._isDepthStyle()) return level + rp.heightOffset;
    // Never breach the channel rim, and always keep some water over the bed.
    const fb = Math.min(Math.max(rp.waterFreeboard ?? 0.4, 0.02), rp.carveDepth - 0.05);
    return level - fb;
  }

  _buildRiverGeometry(seg) {
    const profile = this._ensureProfile(seg);
    if (!profile) return null;
    const { pts, levels, arc, slopes } = profile;
    const n = pts.length;
    const halfW = this._ribbonHalfWidth();

    const positions = new Float32Array(n * 6);
    const uvs = new Float32Array(n * 4);
    const slopeAttr = new Float32Array(n * 2);
    const tangents = new Float32Array(n * 6);
    const indices = [];

    const tan = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const pos = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(n - 1, i + 1)];
      tan.subVectors(next, prev);
      tan.y = 0;
      tan.normalize();
      const px = -tan.z;
      const pz = tan.x;

      const y = this._waterY(levels[i]);
      positions[i * 6 + 0] = pos.x - px * halfW;
      positions[i * 6 + 1] = y;
      positions[i * 6 + 2] = pos.z - pz * halfW;
      positions[i * 6 + 3] = pos.x + px * halfW;
      positions[i * 6 + 4] = y;
      positions[i * 6 + 5] = pos.z + pz * halfW;

      // Centreline direction, duplicated to both edge vertices. The depth material
      // builds its tangent frame from this so wave crests run across the current.
      for (const o of [0, 3]) {
        tangents[i * 6 + o + 0] = tan.x;
        tangents[i * 6 + o + 1] = 0;
        tangents[i * 6 + o + 2] = tan.z;
      }

      uvs[i * 4 + 0] = arc[i];
      uvs[i * 4 + 1] = 0;
      uvs[i * 4 + 2] = arc[i];
      uvs[i * 4 + 3] = 1;

      slopeAttr[i * 2 + 0] = slopes[i];
      slopeAttr[i * 2 + 1] = slopes[i];

      if (i < n - 1) {
        const b = i * 2;
        indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute("aSlope", new THREE.BufferAttribute(slopeAttr, 1));
    geo.setAttribute("aTangent", new THREE.BufferAttribute(tangents, 3));
    geo.setIndex(indices);
    return geo;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Water materials
  // ═══════════════════════════════════════════════════════════════════════════

  _initWaterMaterials() {
    const rp = this.toolState.river2;
    const u = this.wU = {
      time:           uniform(0),
      flowSpeed:      uniform(rp.flowSpeed ?? 2.5),          // m/s
      opacity:        uniform(rp.opacity ?? 0.9),
      shallowColor:   uniform(new THREE.Color(rp.shallowColor ?? "#4fd8c2")),
      deepColor:      uniform(new THREE.Color(rp.deepColor ?? "#14526e")),
      highlightColor: uniform(new THREE.Color(rp.highlightColor ?? "#cdf3ff")),
      foamColor:      uniform(new THREE.Color(rp.foamColor ?? "#ffffff")),
      bandCount:      uniform(rp.bandCount ?? 3),
      depthAbsorb:    uniform(rp.depthAbsorb ?? 0.8),         // 1/m
      foamDepth:      uniform(rp.foamDepth ?? 0.6),           // m
      foamScale:      uniform(rp.foamScale ?? 1.5),           // features/m
      streakScale:    uniform(rp.streakScale ?? 6),           // streak length, m
      streakStrength: uniform(rp.streakStrength ?? 0.35),
      rapidsSlope:    uniform(rp.rapidsSlope ?? 0.08),
      rapidsBoost:    uniform(rp.rapidsBoost ?? 1.5),
      sparkleStrength: uniform(rp.sparkleStrength ?? 0.25),
      rimStrength:    uniform(rp.rimStrength ?? 0.25),
      riverWidth:     uniform(rp.width ?? 8),
      foamWidth:      uniform(rp.foamWidth ?? 0.18),          // legacy Basic bank foam
    };

    const heightTexNode = this.heightTexNode;

    /** Water depth in metres under this fragment (live GPU heightmap). */
    const waterDepth = Fn(() => {
      const hUV = vec2(
        clamp(positionWorld.x.div(WORLD_SIZE).add(0.5), float(0.001), float(0.999)),
        clamp(positionWorld.z.div(WORLD_SIZE).add(0.5), float(0.001), float(0.999)),
      );
      const terrainY = texture(heightTexNode, hUV).r.mul(MAX_HEIGHT);
      return positionWorld.y.sub(terrainY);
    });

    // ── Toon material — depth-banded color, wobbly edge foam, flow streaks ────
    const toonFrag = Fn(() => {
      const uvC = uv();                      // u = arc metres, v = 0..1 across
      const slope = attribute("aSlope");
      const depth = waterDepth();

      const slopeT = smoothstep(u.rapidsSlope, u.rapidsSlope.mul(3), slope);
      const flowPhase = u.time.mul(u.flowSpeed).mul(slopeT.mul(u.rapidsBoost).add(1));
      const fu = uvC.x.sub(flowPhase);       // flow-space U, metres
      const vM = uvC.y.sub(0.5).mul(u.riverWidth); // across, metres

      // Posterized depth ramp (soft band edges).
      const t = float(1).sub(exp(depth.max(0).mul(u.depthAbsorb).negate()));
      const bands = u.bandCount.max(2);
      const x = t.mul(bands);
      const q = clamp(
        floor(x).add(smoothstep(float(0.7), float(1), fract(x))).div(bands.sub(1)),
        float(0), float(1),
      );
      const col = mix(u.shallowColor, u.deepColor, q).toVar();

      // Flow streaks — long thin noise bands scrolling downstream.
      const sn = mx_noise_float(vec2(fu.div(u.streakScale), vM.mul(1.2)));
      const sn2 = mx_noise_float(vec2(fu.div(u.streakScale).mul(1.7).add(13.7), vM.mul(1.6).add(4.3)));
      const streak = smoothstep(float(0.34), float(0.42), sn.mul(0.65).add(sn2.mul(0.35)));
      col.assign(mix(col, u.highlightColor, streak.mul(u.streakStrength)));

      // Edge foam — depth-driven with a noisy wobble + crisp inner rim.
      const foamZone = smoothstep(u.foamDepth, float(0), depth);
      const fn = mx_noise_float(vec2(
        fu.mul(u.foamScale).mul(0.8),
        vM.mul(u.foamScale),
      )).mul(0.5).add(0.5);
      const foam = smoothstep(fn.sub(0.08), fn.add(0.08), foamZone.mul(1.15));
      const rim = smoothstep(u.foamDepth.mul(0.22), float(0), depth);

      // Rapids foam — dense agitation on steep drops.
      const rn = mx_noise_float(vec2(fu.mul(1.6), vM.mul(2.2).add(7.7))).mul(0.5).add(0.5);
      const rapids = slopeT.mul(smoothstep(float(0.35), float(0.6), rn));

      const foamTotal = clamp(max(max(foam.mul(0.9), rim), rapids), float(0), float(1));
      col.assign(mix(col, u.foamColor, foamTotal));

      // Sparkles — flickering glints drifting with the flow.
      const sp = mx_noise_float(vec2(fu.mul(3.1), vM.mul(3.7)));
      const spGate = mx_noise_float(vec2(vM.mul(0.9).add(u.time.mul(1.7)), uvC.x.mul(0.13)));
      const sparkle = smoothstep(float(0.55), float(0.72), sp.mul(spGate.mul(0.5).add(0.5)));
      col.assign(col.add(u.highlightColor.mul(sparkle).mul(u.sparkleStrength)));

      // Grazing-angle sheen.
      const viewY = clamp(cameraPosition.sub(positionWorld).normalize().y, float(0), float(1));
      const fres = pow(float(1).sub(viewY), float(3)).mul(u.rimStrength);
      col.assign(mix(col, u.highlightColor, fres));

      // Soften the exact shoreline intersection; foam stays opaque.
      const shoreFade = smoothstep(float(-0.08), float(0.18), depth);
      const alpha = mix(u.opacity, float(1), foamTotal.mul(0.85)).mul(shoreFade);
      return vec4(col, alpha);
    });

    // ── Basic material — flat two-tone with bank foam (cheap fallback) ────────
    const basicFrag = Fn(() => {
      const uvC = uv();
      const fu = uvC.x.sub(u.time.mul(u.flowSpeed));
      const wave = mx_noise_float(vec2(fu.mul(0.4), uvC.y.mul(3))).mul(0.5).add(0.5);
      const centerDist = abs(uvC.y.sub(0.5)).mul(2);
      const depthColor = mix(u.deepColor, u.shallowColor, pow(centerDist, float(0.6)));
      const surface = mix(depthColor, u.highlightColor, wave.sub(0.5).mul(0.36).add(0.18).clamp(0, 1));
      const bankFoam = max(
        smoothstep(u.foamWidth, float(0), uvC.y),
        smoothstep(float(1).sub(u.foamWidth), float(1), uvC.y),
      );
      return vec4(mix(surface, u.foamColor, bankFoam.mul(0.85)), u.opacity);
    });

    const mkMat = (frag) => {
      const mat = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      const f = frag();
      mat.colorNode = f.rgb;
      mat.opacityNode = f.a;
      return mat;
    };
    this._toonMat = mkMat(toonFrag);
    this._basicMat = mkMat(basicFrag);

    // Depth style — the same material lakes use. Its waterline comes from the scene
    // depth buffer, so it needs no bank foam, no depth ramp and no width uniform.
    this._depthWater = null;
    if (this.waterNormalMap) {
      this._depthWater = createLakeMaterial({
        normalMap: this.waterNormalMap,
        uvMode: "ribbon",
        // The depth-style footprint, regardless of the style selected right now.
        ribbonWidth: (rp.width * 0.5 + rp.carveShoulder) * 2,
        params: this._depthParams(),
      });
    }
  }

  /**
   * toolState.river2 -> createLakeMaterial params.
   * `flowSpeed` is metres/second downstream; the ribbon UV mode scrolls the normals
   * along arc length, so it needs no flowDir (that's the lake's wind angle).
   */
  _depthParams() {
    const rp = this.toolState.river2;
    return { ...depthWaterParams(rp.water), flowSpeed: rp.flowSpeed ?? 2.5 };
  }

  _activeMaterial() {
    if (this._isDepthStyle()) return this._depthWater.material;
    return this.toolState.river2.shaderStyle === "Basic" ? this._basicMat : this._toonMat;
  }

  /** @param {THREE.Vector3} v — unit vector pointing TOWARD the sun */
  setSunDir(v) { this._depthWater?.setSunDir(v); }
  setSkyColors(zenith, horizon) { this._depthWater?.setSkyColors(zenith, horizon); }

  syncMaterial() {
    const p = this.toolState.river2;
    const u = this.wU;
    u.flowSpeed.value = p.flowSpeed;
    u.opacity.value = p.opacity;
    u.shallowColor.value.set(p.shallowColor);
    u.deepColor.value.set(p.deepColor);
    u.highlightColor.value.set(p.highlightColor ?? "#cdf3ff");
    u.foamColor.value.set(p.foamColor ?? "#ffffff");
    u.bandCount.value = p.bandCount ?? 3;
    u.depthAbsorb.value = p.depthAbsorb ?? 0.8;
    u.foamDepth.value = p.foamDepth ?? 0.6;
    u.foamScale.value = p.foamScale ?? 1.5;
    u.streakScale.value = p.streakScale ?? 6;
    u.streakStrength.value = p.streakStrength ?? 0.35;
    u.rapidsSlope.value = p.rapidsSlope ?? 0.08;
    u.rapidsBoost.value = p.rapidsBoost ?? 1.5;
    u.sparkleStrength.value = p.sparkleStrength ?? 0.25;
    u.rimStrength.value = p.rimStrength ?? 0.25;
    u.riverWidth.value = p.width ?? 8;
    u.foamWidth.value = p.foamWidth ?? 0.18;

    if (this._depthWater) {
      this._depthWater.uniforms.ribbonWidth.value = this._ribbonHalfWidth() * 2;
      this._depthWater.syncParams(this._depthParams());
    }

    const mat = this._activeMaterial();
    for (const seg of this.segments) {
      if (seg.mesh && seg.mesh.material !== mat) seg.mesh.material = mat;
    }
  }

  update(dtSec) {
    this._time += dtSec;
    this.wU.time.value = this._time;
    this._depthWater?.update(dtSec, this._time);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Segment management (same public surface as the old system)
  // ═══════════════════════════════════════════════════════════════════════════

  _activeIdx() {
    if (this.segments.length === 0) return -1;
    return Math.max(0, Math.min(this.toolState.river2.activeRiverIndex | 0, this.segments.length - 1));
  }

  _clampActive() {
    if (this.segments.length === 0) {
      this.toolState.river2.activeRiverIndex = 0;
      return;
    }
    this.toolState.river2.activeRiverIndex = Math.max(
      0, Math.min(this.toolState.river2.activeRiverIndex | 0, this.segments.length - 1),
    );
  }

  /** id: pass null for a fresh id; an explicit id (undo/import) bumps the counter past it. */
  _makeSeg(points = [], id = null, link = null) {
    if (id == null) id = this._nextSegId++;
    else this._nextSegId = Math.max(this._nextSegId, id + 1);
    return { id, points, mesh: null, profile: null, link };
  }

  startNewRiver() {
    this._pushUndo();
    this.segments.push(this._makeSeg());
    this.toolState.river2.activeRiverIndex = this.segments.length - 1;
    this.selectedIdx = -1;
    this._rebuildVisual();
  }

  addPoint(pos) {
    this._pushUndo();
    if (this.segments.length === 0) {
      this.segments.push(this._makeSeg());
      this.toolState.river2.activeRiverIndex = 0;
    }
    this._clampActive();
    const seg = this.segments[this._activeIdx()];
    seg.points.push(pos.clone());
    this._afterStructuralEdit(seg);
    this.selectedIdx = seg.points.length - 1;
    this.applyCarve({ rebuild: true, commit: true });
    this._updateSelectedY();
  }

  deleteSelected() {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const seg = this.segments[ai];
    if (this.selectedIdx >= seg.points.length) return;
    this._pushUndo();
    seg.points.splice(this.selectedIdx, 1);
    this._afterStructuralEdit(seg);
    this.selectedIdx = Math.min(this.selectedIdx, seg.points.length - 1);
    this.applyCarve({ rebuild: true, commit: true });
    this._updateSelectedY();
  }

  deleteActiveRiver() {
    const ai = this._activeIdx();
    if (ai < 0) return;
    this._pushUndo();
    const seg = this.segments[ai];
    // Orphaned tributaries become independent rivers.
    for (const c of this._childrenOf(seg)) {
      c.link = null;
      this._invalidateWithDescendants(c);
    }
    this._disposeSegMesh(seg);
    this.segments.splice(ai, 1);
    this.selectedIdx = -1;
    this.dragging = false;
    this._clampActive();
    this.applyCarve({ rebuild: true, commit: true });
  }

  /** Called during drag — live GPU re-carve, throttled to one per frame. */
  moveSelected(pos) {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const seg = this.segments[ai];
    if (this.selectedIdx >= seg.points.length) return;
    const currentY = seg.points[this.selectedIdx].y;
    seg.points[this.selectedIdx].copy(pos);
    seg.points[this.selectedIdx].y = currentY;
    this._queueLiveCarve();
  }

  /** Mouse-up after dragging — committed carve (CPU mirror + grass/tree sync). */
  finalizeMove() {
    this.dragging = false;
    const ai = this._activeIdx();
    if (ai >= 0) this._afterStructuralEdit(this.segments[ai]);
    this.applyCarve({ rebuild: true, commit: true });
  }

  setSelectedPointY(y) {
    const ai = this._activeIdx();
    if (ai < 0 || this.selectedIdx < 0) return;
    const seg = this.segments[ai];
    if (this.selectedIdx >= seg.points.length) return;
    seg.points[this.selectedIdx].y = y;
    this._rebuildHandles();
  }

  pickPoint(raycaster) {
    const spheres = this.handleMeshes.filter((m) => m.isMesh);
    if (spheres.length === 0) return -1;
    const hits = raycaster.intersectObjects(spheres, false);
    if (hits.length === 0) return -1;
    return this.handleMeshes.indexOf(hits[0].object);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Undo / redo (spline snapshots — terrain re-derives from the base)
  // ═══════════════════════════════════════════════════════════════════════════

  _snapshot() {
    return {
      segments: this.segments.map((s) => ({
        id: s.id,
        link: s.link ? { ...s.link } : null,
        points: s.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
      })),
      activeRiverIndex: this.toolState.river2.activeRiverIndex,
      selectedIdx: this.selectedIdx,
    };
  }

  _pushUndo() {
    this.undoStack.push(this._snapshot());
    this.redoStack.length = 0;
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  _restore(snap) {
    this._disposeAllMeshes();
    this.segments = snap.segments.map((s) => this._makeSeg(
      s.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
      s.id ?? null,
      s.link ? { ...s.link } : null,
    ));
    this.toolState.river2.activeRiverIndex = snap.activeRiverIndex;
    this.selectedIdx = snap.selectedIdx;
    this._clampActive();
    this.applyCarve({ rebuild: true, commit: true });
    this._updateSelectedY();
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return false;
    this.redoStack.push(this._snapshot());
    this._restore(snap);
    return true;
  }

  redo() {
    const snap = this.redoStack.pop();
    if (!snap) return false;
    this.undoStack.push(this._snapshot());
    this._restore(snap);
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Visual rebuild (water meshes + handles)
  // ═══════════════════════════════════════════════════════════════════════════

  rebuildAllMeshes() {
    for (const seg of this.segments) {
      this._disposeSegMesh(seg);
      if (seg.points.length < 2) continue;
      const geo = this._buildRiverGeometry(seg);
      if (!geo) continue;
      seg.mesh = new THREE.Mesh(geo, this._activeMaterial());
      seg.mesh.renderOrder = 2;
      seg.mesh.frustumCulled = false;
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
    seg.mesh.frustumCulled = false;
    this.scene.add(seg.mesh);
  }

  _rebuildHandles() {
    while (this.handleGroup.children.length) {
      const child = this.handleGroup.children[0];
      this.handleGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.handleMeshes = [];

    const ai = this._activeIdx();
    if (ai < 0) {
      this._syncHandlesVisibility();
      return;
    }
    const pts = this.segments[ai].points;
    for (let i = 0; i < pts.length; i++) {
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 8),
        new THREE.MeshBasicMaterial({ color: i === this.selectedIdx ? 0xffff00 : 0x00cc44 }),
      );
      sphere.position.copy(pts[i]);
      this.handleGroup.add(sphere);
      this.handleMeshes.push(sphere);
    }

    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts, !!this.toolState.river2.closed, "catmullrom", 0.5);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(80));
      const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x44ff88 }));
      this.handleGroup.add(line);
      this.handleMeshes.push(line);
    }
    this._syncHandlesVisibility();
  }

  _updateDragHandles() {
    const ai = this._activeIdx();
    if (ai < 0) return;
    const pts = this.segments[ai].points;
    for (let i = 0; i < pts.length && i < this.handleMeshes.length; i++) {
      const m = this.handleMeshes[i];
      if (m.isMesh) m.position.copy(pts[i]);
    }
    const lastHandle = this.handleMeshes[this.handleMeshes.length - 1];
    if (lastHandle && !lastHandle.isMesh && pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts, !!this.toolState.river2.closed, "catmullrom", 0.5);
      const posAttr = lastHandle.geometry.attributes.position;
      const newPts = curve.getPoints(80);
      for (let i = 0; i < newPts.length; i++) {
        posAttr.setXYZ(i, newPts[i].x, newPts[i].y, newPts[i].z);
      }
      posAttr.needsUpdate = true;
    }
  }

  _syncHandlesVisibility() {
    this.handleGroup.visible = this.toolState.mode === "river2" && this.toolState.river2.showHandles;
  }

  _rebuildVisual() {
    this.rebuildAllMeshes();
    this._rebuildHandles();
  }

  _updateSelectedY() {
    const ai = this._activeIdx();
    if (ai >= 0 && this.selectedIdx >= 0 && this.selectedIdx < this.segments[ai].points.length) {
      this.toolState.river2.selectedPointY = this.segments[ai].points[this.selectedIdx].y;
    }
  }

  _disposeSegMesh(seg) {
    if (!seg.mesh) return;
    this.scene.remove(seg.mesh);
    seg.mesh.geometry.dispose();
    seg.mesh = null;
  }

  _disposeAllMeshes() {
    for (const seg of this.segments) this._disposeSegMesh(seg);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Serialization
  // ═══════════════════════════════════════════════════════════════════════════

  exportData() {
    return this.segments.map((s) => ({
      id: s.id,
      link: s.link ? { ...s.link } : null,
      points: s.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    }));
  }

  importData(data) {
    this._disposeAllMeshes();
    if (this._baseReady) {
      this._blit(this._rtBase.texture, this.getRT());
      this._dropBase();
    }
    this.segments = (Array.isArray(data) ? data : []).map((s) => this._makeSeg(
      Array.isArray(s.points) ? s.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)) : [],
      Number.isFinite(s.id) ? s.id : null,
      s.link && Number.isFinite(s.link.parentId)
        ? { parentId: s.link.parentId, end: s.link.end === 0 ? 0 : 1 }
        : null,
    ));
    // Sanitize imported links: drop danglers and break any cycle.
    for (const seg of this.segments) {
      if (!seg.link) continue;
      const parent = this._segById(seg.link.parentId);
      if (!parent || parent === seg || this._wouldCycle(parent, seg)) seg.link = null;
    }
    this.selectedIdx = -1;
    this.dragging = false;
    this._clampActive();
    this.applyCarve({ rebuild: true, commit: true });
  }

  dispose() {
    clearTimeout(this._rebaseTimer);
    if (this._baseReady) {
      this._blit(this._rtBase.texture, this.getRT());
      this._dropBase();
      this.onCarveCommitted?.();
    }
    this._disposeAllMeshes();
    while (this.handleGroup.children.length) {
      const child = this.handleGroup.children[0];
      this.handleGroup.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.scene.remove(this.handleGroup);
    this._rtBase?.dispose();
    this._rtBasePong?.dispose();
    this._rtScratch.dispose();
    this._pathTex.dispose();
    this._toonMat.dispose();
    this._basicMat.dispose();
  }
}
