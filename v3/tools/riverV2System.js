/**
 * v3/tools/riverV2System.js — River v2.
 *
 * THE SPLINE IS THE MASTER AND THE TERRAIN CONFORMS TO IT.
 *
 * That is the whole design, and everything else is a consequence:
 *
 *  - The water level between nodes is the author's interpolated curve, never a
 *    trace of the ground, so a river can be lifted into the air and its channel
 *    and banks come with it.
 *  - The conform CUTS AND FILLS. It writes a complete cross-section — bed, then
 *    a lip standing `freeboard` above the water, then a shoulder easing back to
 *    natural ground — and that section meets untouched terrain exactly at its
 *    outer edge, by construction. Raising an embankment is not a special case;
 *    it is the same formula with the ground below the lip instead of above it.
 *  - The bank FLARES where it must. A wall is widened until its slope is under
 *    `maxBankSlope`, so a river lifted 20 m above a floodplain grows a broad
 *    levee rather than a vertical fence.
 *  - Width, depth and bank are PER NODE and interpolate along the spline, so a
 *    river narrows into a gorge and opens into a pool without being split in two.
 *  - The bed returns to exactly the water level at ±width/2, so the drawn
 *    waterline lands on the channel rim with no gap to tune.
 *
 * Non-destructive, like the road conform: the unconformed terrain is kept and
 * every re-conform restores from it before rewriting, so dragging a node moves
 * the channel instead of stacking a new one on top of the last.
 *
 * The base is held on the CPU (`_cpuBase`) and pushed to the GPU as a texture
 * only when it actually changes — mode entry, an external sculpt, a project
 * load. The alternative, reading the base back off a render target, costs a
 * 16 MB transfer every time and buys nothing: the same numbers are already in
 * the CPU heightmap mirror when the snapshot is taken.
 */

import * as THREE from "three";
import { QuadMesh, MeshBasicNodeMaterial } from "three/webgpu";
import {
  Fn, If, Break, Loop, uniform, float, vec2, vec4,
  mix, smoothstep, step, dot, clamp, max, min, sqrt, pow, abs, texture, uv, attribute,
} from "three/tsl";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "../terrain/heightmapTexture.js";
import { createRiverMaterial } from "../render/water/riverV2Material.js";
import { createRiverStylizedMaterial } from "../render/water/riverV2StylizedMaterial.js";
import { riverWaterParams, RIVER_NODE_DEFAULTS } from "../app/state/riverV2State.js";
import {
  solveRiver, closestStation, planConformChunks, conformStride, LOOP_SEGS, MIN_NODES,
  buildFlowIndex, sampleFlow, sampleFlowAt,
} from "./riverV2Channel.js";
import { shareInstancePipeline } from "../render/instancePipeline.js";

/** Path-texture width. Matches the solver's station ceiling, so no river is split. */
const MAX_PATH_POINTS = 2048;
/** Undo ring depth. Entries are small JSON snapshots of the node arrays. */
const MAX_UNDO = 64;
/** Metres between flow-direction arrows. */
const ARROW_SPACING = 14;
/** Metres the ribbon overhangs each bank so the depth test finds the waterline. */
const RIBBON_OVERHANG = 2.5;
/** Ribbon rows per culling chunk: at the default 0.8 m step, ~50 m of river. */
const RIVER_CULL_ROWS = 64;
/** Metres added to each chunk sphere: wave lift, plus a margin at the view edge. */
const RIVER_CULL_SLACK = 4;
const _cullMat = new THREE.Matrix4();
const _cullFrustum = new THREE.Frustum();

const COL_ACTIVE = 0x7fe9ff;
const COL_IDLE = 0x2c7f96;
const COL_PINNED = 0xffc04a;
const COL_SELECTED = 0xffffff;
const COL_WIDTH = 0x8cff9a;
const COL_LEVEL = 0xffd166;

let _nextRiverId = 1;

/** Bilinear sample of a normalized heightmap, in metres. */
function sampleNormalized(map, wx, wz) {
  const size = HEIGHTMAP_SIZE;
  const res = size - 1;
  const u = (wx + WORLD_SIZE / 2) / WORLD_SIZE;
  const v = (wz + WORLD_SIZE / 2) / WORLD_SIZE;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const fx = u * res;
  const fz = v * res;
  const ix0 = Math.floor(fx);
  const iz0 = Math.floor(fz);
  const ix1 = Math.min(ix0 + 1, res);
  const iz1 = Math.min(iz0 + 1, res);
  const tx = fx - ix0;
  const tz = fz - iz0;
  const h0 = map[iz0 * size + ix0] * (1 - tx) + map[iz0 * size + ix1] * tx;
  const h1 = map[iz1 * size + ix0] * (1 - tx) + map[iz1 * size + ix1] * tx;
  return (h0 * (1 - tz) + h1 * tz) * MAX_HEIGHT;
}

/**
 * The conform is TWO stages: "nearest", then "resolve".
 *
 * Stage one runs once per chunk of spline and carries forward, per texel, the
 * closest segment found so far as (distance2, path index, t). It writes no
 * terrain. Because `min` over distance is associative, the chunks compose in
 * any order and each only has to look at its own segments — a chunk's rect
 * already covers everything within `reach` of them, and any texel whose true
 * nearest segment lies elsewhere is inside THAT chunk's rect too.
 *
 * Stage two runs once, full screen, and turns the winning segment into a
 * height by evaluating the cross-section against the untouched base terrain.
 *
 * The obvious design — have each chunk write the terrain directly — is what
 * shipped twice and was visibly wrong twice: it makes a pass's answer depend on
 * seeing every segment that could win for any texel it touches, which neither
 * an arc-length margin nor a spatial window can guarantee on a river that folds
 * back on itself. Splitting the search from the write removes the requirement.
 */
function nearestSearch(uvC, pathTex, prev, uSegStart, uSegEnd) {
  const bestD2 = prev.r.toVar();
  const bestIdx = prev.g.toVar();
  const bestT = prev.b.toVar();

  const W = float(MAX_PATH_POINTS);
  Loop(LOOP_SEGS, ({ i }) => {
    const idx = float(i).add(uSegStart);
    If(idx.greaterThanEqual(uSegEnd), () => { Break(); });

    // Row 0 is (u, v, level, halfWidth) — only the position is needed here.
    const a0 = texture(pathTex, vec2(idx.add(0.5).div(W), 0.25));
    const b0 = texture(pathTex, vec2(idx.add(1.5).div(W), 0.25));
    // Row 1's zw hold the river's OPEN MOUTH (a waterfall lip) in UV, on every
    // point of that river; z < 0 when the mouth is closed.
    const a1 = texture(pathTex, vec2(idx.add(0.5).div(W), 0.75));

    const ab = b0.xy.sub(a0.xy);
    const len2 = max(dot(ab, ab), float(1e-12));
    const t = clamp(dot(uvC.sub(a0.xy), ab).div(len2), float(0), float(1));
    const p = a0.xy.add(ab.mul(t));
    const d = uvC.sub(p);
    const d2 = dot(d, d);

    // Past an open mouth the river simply stops: no bed, no bank, no fill.
    // Ordinarily the end owns a half-disc beyond itself, which is right for a
    // river petering out on a plain and wrong for one going over a cliff — the
    // fill there buries the very edge the water is meant to leave. The cut is
    // a half-plane through the mouth, and EVERY segment of the river honours
    // it: excluding only the last one hands those texels to the one before,
    // whose bank flare reaches them just the same.
    const toMouth = a1.zw.sub(a0.xy);
    const pastMouth = a1.z.greaterThanEqual(0).and(dot(uvC.sub(a1.zw), toMouth).greaterThan(0));

    If(d2.lessThan(bestD2).and(pastMouth.not()), () => {
      bestD2.assign(d2);
      bestIdx.assign(idx);
      bestT.assign(t);
    });
  });

  return vec4(bestD2, bestIdx, bestT, float(1));
}

/** Channel parameters of the winning segment, from the shared path texture. */
function channelAt(pathTex, idx, t) {
  const W = float(MAX_PATH_POINTS);
  const uA = idx.add(0.5).div(W);
  const uB = idx.add(1.5).div(W);
  const a0 = texture(pathTex, vec2(uA, 0.25));
  const b0 = texture(pathTex, vec2(uB, 0.25));
  const a1 = texture(pathTex, vec2(uA, 0.75));   // (depth, bank, -, -)
  const b1 = texture(pathTex, vec2(uB, 0.75));
  return {
    level: mix(a0.z, b0.z, t),
    halfW: mix(a0.w, b0.w, t),
    depth: mix(a1.x, b1.x, t),
    bank: mix(a1.y, b1.y, t),
  };
}

export class RiverV2System {
  /**
   * @param {object} deps
   * @param {THREE.Scene}   deps.scene
   * @param {object}        deps.toolState        object carrying a `.riverV2` slice
   * @param {THREE.WebGPURenderer} deps.renderer
   * @param {function}      deps.getRT            () => the live heightmap RenderTarget
   * @param {Float32Array}  deps.cpuHeightmap     normalized CPU mirror of that RT
   * @param {THREE.Texture} deps.waterNormalMap
   * @param {function}      [deps.getCamera]      for constant-size handles
   * @param {function}      [deps.onConformCommitted] terrain changed; push to dependents
   * @param {function}      [deps.onWaterMeshesChanged] ribbons rebuilt; rebake water map
   */
  constructor({
    scene, toolState, renderer, getRT, cpuHeightmap, waterNormalMap,
    getCamera = null, onConformCommitted = null, onWaterMeshesChanged = null,
    onRiverFieldChanged = null,
  }) {
    this.scene = scene;
    this.toolState = toolState;
    this.renderer = renderer;
    this.getRT = getRT;
    this.cpuHeightmap = cpuHeightmap;
    this.getCamera = getCamera;
    this.onConformCommitted = onConformCommitted;
    this.onWaterMeshesChanged = onWaterMeshesChanged;
    /** (hasRivers) => void — the nearest-segment field became (un)available. */
    this.onRiverFieldChanged = onRiverFieldChanged;

    /** @type {{id:number, nodes:Array, solved:object|null, mesh:THREE.Mesh|null}[]} */
    this.rivers = [];
    this.selected = null;   // { riverIdx, nodeIdx }
    this.dragging = false;
    this.editActive = false;

    this._drag = null;
    this._time = 0;
    this._flowIndex = null;
    this._undo = [];
    this._redo = [];

    // ── Scene graph ─────────────────────────────────────────────────────────
    this.group = new THREE.Group();
    this.group.name = "RiverV2";
    scene.add(this.group);

    this.handleGroup = new THREE.Group();
    this.handleGroup.name = "RiverV2Handles";
    this.handleGroup.visible = false;
    scene.add(this.handleGroup);

    this.arrowGroup = new THREE.Group();
    this.arrowGroup.name = "RiverV2Arrows";
    this.arrowGroup.visible = false;
    scene.add(this.arrowGroup);

    // Two looks, one geometry: the realistic surface, and the stylized one
    // built on first use (params.water.style). `_water` is whichever is shown.
    this._realistic = createRiverMaterial({ normalMap: waterNormalMap });
    this._stylized = null;
    this._water = this._realistic;
    /**
     * Rivers whose downstream end is open because a waterfall takes the water:
     * id → { x, z }, the point the channel runs to (the fall's LIP, which is
     * the brink — not the last node, which is usually short of it).
     */
    this._openMouths = new Map();

    // ── Terrain base, held on the CPU ───────────────────────────────────────
    this._cpuBase = null;                       // normalized, unconformed
    this._coverage = null;                      // Uint8Array, 1 where a river wrote
    this._baseTexData = null;
    this._baseTex = null;
    this._rebaseTimer = 0;

    this._initPasses();
    // The field starts as whatever was in VRAM; clear it before anything can
    // read it, or a distance of 0 would read as "river everywhere".
    this._render(this._clearNearQuad, this._rtNear, null);
    this._buildHandlePrototypes();
    this.syncMaterial();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GPU passes
  // ═══════════════════════════════════════════════════════════════════════════

  _initPasses() {
    const size = HEIGHTMAP_SIZE;

    // Read source for the conform pass. It holds a copy of the height RT, so it
    // uses the SAME precision rule sculptBrush picked for that RT — anything
    // else either loses height precision or claims some the source never had.
    const type = this.renderer?.backend?.device?.features?.has("float32-filterable")
      ? THREE.FloatType : THREE.HalfFloatType;
    const makeRT = () => {
      const rt = new THREE.RenderTarget(size, size, {
        format: THREE.RGBAFormat, type,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        generateMipmaps: false, depthBuffer: false, colorSpace: THREE.NoColorSpace,
      });
      rt.texture.flipY = false;
      return rt;
    };
    this._rtScratch = makeRT();

    // The unconformed terrain, mirrored on the CPU and uploaded when it changes.
    // Allocated up front because the resolve pass samples it, and that pass is
    // built here. RGBA rather than Red even though only R is used: it is the
    // format every other height surface in this engine uses.
    this._baseTexData = new Float32Array(size * size * 4);
    this._baseTex = new THREE.DataTexture(
      this._baseTexData, size, size, THREE.RGBAFormat, THREE.FloatType,
    );
    this._baseTex.minFilter = THREE.NearestFilter;
    this._baseTex.magFilter = THREE.NearestFilter;
    this._baseTex.flipY = false;
    this._baseSrc = texture(this._baseTex);

    // Path texture: two rows per river.
    //   row 0 — (u, v, level, halfWidth)     positions in UV, level normalized
    //   row 1 — (depth, bank, mouthU, mouthV) depth normalized, bank in UV; the
    //           open mouth's UV on every point, mouthU = -1 when closed
    this._pathData = new Float32Array(MAX_PATH_POINTS * 2 * 4);
    this._pathTex = new THREE.DataTexture(
      this._pathData, MAX_PATH_POINTS, 2, THREE.RGBAFormat, THREE.FloatType,
    );
    this._pathTex.minFilter = THREE.NearestFilter;
    this._pathTex.magFilter = THREE.NearestFilter;
    this._pathTex.needsUpdate = true;

    // ── Copy pass ──────────────────────────────────────────────────────────
    // Preserves G and B: the removed River+ carve tool tagged carved texels in G,
    // and blitting zeroes over it would silently break its rebase.
    this._copySrc = texture(this._pathTex);
    const copyMat = new MeshBasicNodeMaterial();
    copyMat.fragmentNode = Fn(() => {
      const s = texture(this._copySrc, uv());
      return vec4(s.r, s.g, s.b, float(1));
    })();
    this._copyQuad = new QuadMesh(copyMat);

    // The nearest-RT ping-pong gets its own node: swapping one texture node
    // between differently-filtered sources asks the backend to rebuild the
    // pipeline on a hot path.
    this._nearCopySrc = texture(this._pathTex);
    const nearCopyMat = new MeshBasicNodeMaterial();
    nearCopyMat.fragmentNode = Fn(() => {
      const c = texture(this._nearCopySrc, uv());
      return vec4(c.r, c.g, c.b, float(1));
    })();
    this._nearCopyQuad = new QuadMesh(nearCopyMat);

    // ── Nearest-segment search + resolve (see the note above the builders) ──
    this._uSegStart = uniform(0);
    this._uSegEnd = uniform(0);
    this._uBedCurve = uniform(0.55);
    this._uFreeboardN = uniform(0.001);   // normalized height
    this._uLipFrac = uniform(0.28);
    /** Converts a normalized height difference into the UV run it needs at
     *  `maxBankSlope`. = MAX_HEIGHT / (slope * WORLD_SIZE). */
    this._uSlopeToUv = uniform(1);
    this._uFlareMax = uniform(4);

    const pathTex = this._pathTex;

    // Per-texel winner so far: (distance2, path index, t). Ping-ponged through
    // a scratch the same way the height passes used to be.
    this._rtNear = makeRT();
    this._rtNearScratch = makeRT();

    const clearMat = new MeshBasicNodeMaterial();
    clearMat.fragmentNode = Fn(() => vec4(float(1e9), float(0), float(0), float(1)))();
    this._clearNearQuad = new QuadMesh(clearMat);

    const nearMat = new MeshBasicNodeMaterial();
    nearMat.fragmentNode = Fn(() => {
      const uvC = uv();
      const prev = texture(this._rtNearScratch.texture, uvC);
      return nearestSearch(uvC, pathTex, prev, this._uSegStart, this._uSegEnd);
    })();
    this._nearQuad = new QuadMesh(nearMat);

    const resolveMat = new MeshBasicNodeMaterial();
    resolveMat.fragmentNode = Fn(() => {
      const uvC = uv();
      const near = texture(this._rtNear.texture, uvC);
      // The cross-section is evaluated against the UNTOUCHED base, so a resolve
      // is a restore and an apply in one — and is idempotent.
      const natural = texture(this._baseSrc, uvC).r.toVar();
      const keep = texture(this._rtScratch.texture, uvC);   // River+'s G/B flags

      const dist = sqrt(near.r);
      const ch = channelAt(pathTex, near.g, near.b);

      // ── Channel: bed falls from the rim to `depth` at the centreline ──────
      // Both shapes return to 0 at u = 1, i.e. the bed meets the water level
      // exactly at ±width/2. That is what makes the waterline land on the mesh
      // edge with nothing to tune.
      const uCh = clamp(dist.div(max(ch.halfW, float(1e-6))), float(0), float(1));
      const flat = float(1).sub(pow(uCh, float(8)));   // flat-bottomed canal
      const para = float(1).sub(uCh.mul(uCh));         // parabolic natural channel
      const bedShape = mix(flat, para, this._uBedCurve);
      const tChannel = ch.level.sub(ch.depth.mul(bedShape));

      // ── Bank: waterline → lip → natural ground ───────────────────────────
      // The lip stands `freeboard` above the water and is what actually holds
      // the river in when the surrounding ground is lower than the surface.
      const rim = ch.level.add(this._uFreeboardN);
      // Widen the shoulder until its slope is acceptable, so a tall embankment
      // or a deep gorge wall ramps instead of standing vertical.
      const need = abs(natural.sub(rim)).mul(this._uSlopeToUv);
      const flare = clamp(need, ch.bank, ch.bank.mul(this._uFlareMax));
      const uB = clamp(dist.sub(ch.halfW).div(max(flare, float(1e-6))), float(0), float(1));
      const aRise = smoothstep(float(0), this._uLipFrac, uB);
      const bEase = smoothstep(this._uLipFrac, float(1), uB);
      const tBank = mix(mix(ch.level, rim, aRise), natural, bEase);

      const inChannel = step(dist, ch.halfW);
      const shaped = mix(tBank, tChannel, inChannel);
      // Where no river was ever found the search left distance at 1e9, and the
      // bank branch has already eased all the way back to natural — but pin it
      // exactly so an empty world is bit-identical to its base.
      const target = mix(shaped, natural, step(float(1e8), near.r));

      return vec4(target, keep.g, keep.b, float(1));
    })();
    this._resolveQuad = new QuadMesh(resolveMat);
  }

  /** Scissored quad render into an RT (same contract as sculptBrush). */
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
  // Terrain base
  // ═══════════════════════════════════════════════════════════════════════════

  get hasBase() { return this._cpuBase !== null; }

  /** Snapshot the CURRENT terrain as the unconformed base. The caller must have
   *  refreshed the CPU mirror first (main.js awaits ensureCpuHeightmapFromGpu). */
  _ensureBase() {
    if (this._cpuBase) return;
    this._cpuBase = Float32Array.from(this.cpuHeightmap);
    this._uploadBase();
  }

  /**
   * Push `_cpuBase` to the GPU.
   *
   * The base gets its OWN texture node and quad rather than reusing the general
   * copy pass. That pass's node is bound to the height RT, which is linearly
   * filtered; this texture is float and nearest-filtered, and swapping one node
   * between the two sampler types every restore is asking the backend to
   * rebuild the pipeline on a hot path — or, without float32-filterable, to
   * build an invalid one.
   *
   * RGBA rather than Red, even though only R is read: it is the format every
   * other height surface in this engine uses, and the 12 MB saved is not worth
   * being the one place that does something different.
   */
  /**
   * Push `_cpuBase` to the GPU. The texture itself is allocated in _initPasses
   * because the resolve pass samples it.
   */
  _uploadBase() {
    const n = HEIGHTMAP_SIZE * HEIGHTMAP_SIZE;
    const d = this._baseTexData;
    const b = this._cpuBase;
    for (let i = 0; i < n; i++) d[i * 4] = b[i];
    this._baseTex.needsUpdate = true;
  }

  /** Blit the nearest-search RT into its own ping-pong scratch. */
  _blitNear(rect = null) {
    this._nearCopySrc.value = this._rtNear.texture;
    this._render(this._nearCopyQuad, this._rtNearScratch, rect);
  }

  /**
   * Turn the current nearest-segment field into terrain. One full-screen pass,
   * evaluated against the untouched base — so it is a restore and an apply at
   * once, and running it twice changes nothing.
   */
  _resolve() {
    const rtMain = this.getRT();
    // The pass carries River+'s G/B flags through, and reads them from scratch,
    // so scratch has to hold the current heightmap first.
    this._blit(rtMain.texture, this._rtScratch);
    this._render(this._resolveQuad, rtMain, null);
  }

  /** Restore the whole terrain to its unconformed state: resolve with nothing
   *  found, which the cross-section defines as "leave the base alone". */
  _restoreBase() {
    if (!this._cpuBase) return;
    this._render(this._clearNearQuad, this._rtNear, null);
    this._resolve();
  }

  _dropBase() {
    this._cpuBase = null;
    this._coverage = null;
  }

  /** Drop the flow lookup when the last river goes, so a query cannot answer
   *  from a river that no longer exists. */
  _dropFlowIndex() { this._flowIndex = null; }

  /** Terrain was edited by something else (sculpt, procedural gen, load). */
  notifyTerrainEdited() {
    if (!this._cpuBase) return;
    clearTimeout(this._rebaseTimer);
    this._rebaseTimer = setTimeout(() => this._rebaseNow(), 60);
  }

  /**
   * Fold external edits into the base — but only OUTSIDE the river footprint.
   * Inside it, the base must keep the pre-river ground or the channel would
   * re-conform against its own output and dig itself deeper every stroke.
   */
  _rebaseNow() {
    if (!this._cpuBase) return;
    const cov = this._coverage;
    const n = this._cpuBase.length;
    for (let i = 0; i < n; i++) {
      if (!cov || cov[i] === 0) this._cpuBase[i] = this.cpuHeightmap[i];
    }
    this._uploadBase();
    this.applyConform({ commit: true });
  }

  /** Unconformed ground height in metres. The solver's view of the world. */
  sampleBase(wx, wz) {
    const map = this._cpuBase || this.cpuHeightmap;
    return sampleNormalized(map, wx, wz);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Solve
  // ═══════════════════════════════════════════════════════════════════════════

  get params() { return this.toolState.riverV2; }

  _solvable() { return this.rivers.some((r) => r.nodes.length >= MIN_NODES); }

  _solveAll() {
    const p = this.params;
    const ground = (x, z) => this.sampleBase(x, z);
    for (const r of this.rivers) {
      r.solved = solveRiver({ nodes: r.nodes, sampleGround: ground, params: p });
    }
    this._flowIndex = buildFlowIndex(this.rivers.map((r) => r.solved), {
      worldSize: WORLD_SIZE,
      bedCurve: p.bedCurve,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Flow query — for physics, gameplay and audio
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * What is the water doing at this world position?
   *
   * The solver already knows the surface level, the velocity and the channel
   * cross-section at every station, so this is a lookup rather than a second
   * model — and it reuses the conform's own bed formula, so the depth reported
   * is the depth the terrain actually has.
   *
   * @returns {null|object} `{ surfaceY, bedY, depth, speed, dirX, dirZ,
   *   distance, inChannel, width, halfWidth, arc, turbulence, riverIndex }`,
   *   or null when no river is close enough to have an opinion.
   */
  sampleFlow(x, z) { return sampleFlow(this._flowIndex, x, z); }

  /** As sampleFlow, plus `submerged` / `submergedDepth` for a 3D point. */
  sampleFlowAt(x, y, z) { return sampleFlowAt(this._flowIndex, x, y, z); }

  /**
   * Force per unit mass that the current would apply to something floating at
   * this point — the one derived quantity almost every caller wants, so it is
   * not re-derived in five places.
   *
   * @param {number} drag how strongly the body couples to the water, 0..1
   * @returns {null|{x:number, z:number, speed:number, submergedDepth:number}}
   */
  flowForceAt(x, y, z, drag = 1) {
    const f = sampleFlowAt(this._flowIndex, x, y, z);
    if (!f || !f.submerged) return null;
    // Coupling ramps over the first metre of immersion: something barely
    // touching the surface should not be shoved as hard as something in it.
    const bite = Math.min(1, f.submergedDepth / 1) * drag;
    return {
      x: f.dirX * f.speed * bite,
      z: f.dirZ * f.speed * bite,
      speed: f.speed,
      submergedDepth: f.submergedDepth,
    };
  }

  /** Widest the conform can reach from the centreline at a station, in metres. */
  _reachAt(solved, i) {
    return solved.width[i] * 0.5 + solved.bank[i] * (this.params.bankFlareMax ?? 4);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Conform
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Upload the centreline for the conform, taking every `stride`-th station.
   *
   * @returns {number} path points written; the caller indexes chunks in this
   *   PATH space, and path point k is station `k * stride`.
   */
  /**
   * Pack EVERY river's centreline into the one shared path texture, back to
   * back, and return where each landed.
   *
   * They share a texture because the resolve pass looks up the winning segment
   * by a single global index — so the winner may come from any river, which is
   * also what makes a confluence resolve correctly instead of one river's pass
   * overwriting another's.
   *
   * @returns {Array<null|{offset:number,count:number,idxOf:function,solved:object}>}
   */
  _uploadAllPaths() {
    const d = this._pathData;
    const half = WORLD_SIZE * 0.5;
    const row1 = MAX_PATH_POINTS * 4;
    const live = this.rivers.filter((r) => r.solved && r.solved.count >= 2).length;
    const budget = Math.max(64, Math.floor(MAX_PATH_POINTS / Math.max(1, live)));

    const layout = [];
    let off = 0;
    for (const river of this.rivers) {
      const s = river.solved;
      if (!s || s.count < 2) { layout.push(null); continue; }

      const stride = conformStride(s.count, budget);
      const last = s.count - 1;
      const n = Math.min(Math.max(2, Math.ceil(last / stride) + 1), MAX_PATH_POINTS - off);
      if (n < 2) { layout.push(null); continue; }

      // The final point is pinned to the last station so a decimated path still
      // ends exactly where the river does.
      const idxOf = (k) => (k >= n - 1 ? last : Math.min(last, k * stride));
      for (let k = 0; k < n; k++) {
        const i = idxOf(k);
        const j = off + k;
        d[j * 4 + 0] = (s.x[i] + half) / WORLD_SIZE;
        d[j * 4 + 1] = (s.z[i] + half) / WORLD_SIZE;
        d[j * 4 + 2] = s.level[i] / MAX_HEIGHT;
        d[j * 4 + 3] = (s.width[i] * 0.5) / WORLD_SIZE;
        d[row1 + j * 4 + 0] = s.depth[i] / MAX_HEIGHT;
        d[row1 + j * 4 + 1] = s.bank[i] / WORLD_SIZE;
        // The mouth, if open, on every point (the search tests a half-plane
        // through it for every segment); z = -1 marks a closed mouth.
        //
        // It is the WATERFALL'S LIP, not the last node. The channel has to keep
        // cutting all the way to the brink, or the natural ground between the
        // two stands above the water and slices through it.
        const mouth = this._openMouths.get(river.id);
        if (mouth) {
          const mx = Number.isFinite(mouth.x) ? mouth.x : s.x[last];
          const mz = Number.isFinite(mouth.z) ? mouth.z : s.z[last];
          d[row1 + j * 4 + 2] = (mx + half) / WORLD_SIZE;
          d[row1 + j * 4 + 3] = (mz + half) / WORLD_SIZE;
        } else {
          d[row1 + j * 4 + 2] = -1;
          d[row1 + j * 4 + 3] = 0;
        }
      }
      layout.push({ offset: off, count: n, idxOf, solved: s });
      off += n;
    }
    this._pathTex.needsUpdate = true;
    return layout;
  }

  _syncConformUniforms() {
    const p = this.params;
    this._uBedCurve.value = p.bedCurve ?? 0.55;
    this._uFreeboardN.value = (p.freeboard ?? 0.6) / MAX_HEIGHT;
    this._uLipFrac.value = Math.min(0.9, Math.max(0.02, p.lipFraction ?? 0.28));
    const slope = Math.max(0.02, p.maxBankSlope ?? 0.9);
    this._uSlopeToUv.value = MAX_HEIGHT / (slope * WORLD_SIZE);
    this._uFlareMax.value = Math.max(1, p.bankFlareMax ?? 4);
  }

  /**
   * Run the nearest-segment search for one river, in chunks.
   *
   * Each pass looks ONLY at its own segments and is scissored to their
   * footprint. That is sufficient: a texel whose nearest segment lies in some
   * other chunk is inside that chunk's rect too, because "nearest" means within
   * `reach` of it. `min` over distance then composes the passes in any order.
   */
  _searchRiver(entry) {
    if (!entry) return;
    const s = entry.solved;
    const S = HEIGHTMAP_SIZE;
    const half = WORLD_SIZE * 0.5;
    const plan = planConformChunks(entry.count, LOOP_SEGS);

    for (const { a, b } of plan.chunks) {
      const i0 = entry.idxOf(a);
      const i1 = entry.idxOf(b);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, reach = 0;
      for (let i = i0; i <= i1; i++) {
        if (s.x[i] < minX) minX = s.x[i];
        if (s.x[i] > maxX) maxX = s.x[i];
        if (s.z[i] < minZ) minZ = s.z[i];
        if (s.z[i] > maxZ) maxZ = s.z[i];
        reach = Math.max(reach, this._reachAt(s, i));
      }
      const rect = this._clampRect(
        ((minX - reach + half) / WORLD_SIZE) * S - 2,
        ((minZ - reach + half) / WORLD_SIZE) * S - 2,
        ((maxX + reach + half) / WORLD_SIZE) * S + 2,
        ((maxZ + reach + half) / WORLD_SIZE) * S + 2,
      );
      if (!rect) continue;

      this._uSegStart.value = entry.offset + a;
      this._uSegEnd.value = entry.offset + b;
      this._blitNear(rect);
      this._render(this._nearQuad, this._rtNear, rect);
    }
  }

  /**
   * Conservative CPU footprint, for the rebase merge. Discs at each station of
   * the maximum possible reach: stations are closer together than the smallest
   * reach, so the discs overlap and cover the whole corridor. Over-covering by
   * a texel or two only means slightly more ground is protected from external
   * sculpting than strictly necessary.
   */
  _rebuildCoverage() {
    const S = HEIGHTMAP_SIZE;
    if (!this._coverage) this._coverage = new Uint8Array(S * S);
    else this._coverage.fill(0);
    const cov = this._coverage;
    const half = WORLD_SIZE * 0.5;
    const perTexel = WORLD_SIZE / (S - 1);

    for (const r of this.rivers) {
      const s = r.solved;
      if (!s) continue;
      for (let i = 0; i < s.count; i++) {
        const reach = this._reachAt(s, i);
        const rt = reach / perTexel;
        const cx = ((s.x[i] + half) / WORLD_SIZE) * (S - 1);
        const cz = ((s.z[i] + half) / WORLD_SIZE) * (S - 1);
        const x0 = Math.max(0, Math.floor(cx - rt));
        const x1 = Math.min(S - 1, Math.ceil(cx + rt));
        const z0 = Math.max(0, Math.floor(cz - rt));
        const z1 = Math.min(S - 1, Math.ceil(cz + rt));
        const r2 = rt * rt;
        for (let iz = z0; iz <= z1; iz++) {
          const dz = iz - cz;
          const row = iz * S;
          for (let ix = x0; ix <= x1; ix++) {
            const dx = ix - cx;
            if (dx * dx + dz * dz <= r2) cov[row + ix] = 1;
          }
        }
      }
    }
  }

  /**
   * Full re-conform: restore the base, then rewrite every river's cross-section.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.rebuild=true] also rebuild ribbons, handles, arrows
   * @param {boolean} [opts.commit=true]  refresh the CPU mirror and dependent
   *   systems (grass, trees, collision). Call with commit on mouse-up, not per
   *   frame of a drag.
   */
  applyConform({ rebuild = true, commit = true } = {}) {
    if (!this._solvable()) {
      if (this._cpuBase) {
        this._restoreBase();
        this._dropBase();
        if (commit) this.onConformCommitted?.();
      }
      // Clear the field too, or the bank sand would outlive the last river.
      this._render(this._clearNearQuad, this._rtNear, null);
      this._dropFlowIndex();
      this.onRiverFieldChanged?.(false);
      if (rebuild) this._rebuildVisual();
      return;
    }

    this._ensureBase();
    this._solveAll();
    this._syncConformUniforms();

    // Search every river into the shared nearest-segment field, then resolve it
    // to terrain once. The resolve reads the untouched base, so there is no
    // separate restore step and re-running it is a no-op.
    const layout = this._uploadAllPaths();
    this._render(this._clearNearQuad, this._rtNear, null);
    for (const entry of layout) this._searchRiver(entry);
    this._resolve();

    this.onRiverFieldChanged?.(true);

    if (rebuild) this._rebuildVisual();
    if (commit) {
      // Only the rebase reads the footprint, and a rebase cannot happen while a
      // handle is being dragged — so this stays out of the per-mousemove path.
      this._rebuildCoverage();
      this.onConformCommitted?.();
    }
  }

  /** Panel hook — a conform-affecting parameter changed. */
  refreshConform() { this.applyConform({ commit: true }); }

  // ── Mouths (where a river hands its water to a waterfall) ─────────────────

  /**
   * Mark a river's downstream end as OPEN: the conform stops dead at the last
   * station instead of filling a half-disc past it. Set by the waterfall system
   * when a fall attaches to that river, cleared when it detaches. Re-conforms.
   */
  setMouthOpen(riverId, open, x = null, z = null) {
    const had = this._openMouths.get(riverId) ?? null;
    if (!open) {
      if (!had) return;
      this._openMouths.delete(riverId);
    } else {
      const next = { x: Number.isFinite(x) ? x : null, z: Number.isFinite(z) ? z : null };
      if (had && had.x === next.x && had.z === next.z) return;
      this._openMouths.set(riverId, next);
    }
    if (this.rivers.some((r) => r.id === riverId)) this.applyConform({ commit: true });
  }

  /**
   * The downstream end of river `riverId` as a waterfall lip:
   * `{ x, y, z, yaw, width, speed, depth }`, or null if the river is not solved.
   * y is the water surface, yaw the direction the water leaves in.
   */
  mouthOf(riverId) {
    const river = this.rivers.find((r) => r.id === riverId);
    const s = river?.solved;
    if (!s || s.count < 2) return null;
    const n = s.count - 1;
    return {
      x: s.x[n], y: s.level[n], z: s.z[n],
      yaw: Math.atan2(s.tanX[n], s.tanZ[n]),
      width: s.width[n], speed: s.speed[n], depth: s.depth[n],
    };
  }

  /** Every river's mouth (for "which river is this fall near?"): [{ id, ...mouthOf }]. */
  mouths() {
    const out = [];
    for (const r of this.rivers) {
      const m = this.mouthOf(r.id);
      if (m) out.push({ id: r.id, ...m });
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ribbon meshes
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build one river's water surface.
   *
   * Tessellated, not a two-vertex strip. The surface is DISPLACED in the vertex
   * stage — swell advecting downstream, standing waves where the flow is fast —
   * and a strip with one quad per station has nothing to displace: the waves
   * would exist only in the shader's imagination. So the solved stations are
   * resampled at `meshStep` metres along and `meshAcross` columns wide, which
   * is decoupled from the solver's own station spacing (that one also drives
   * the conform, and making it fine enough for waves would cost far more).
   *
   * The mesh still overhangs the banks: the waterline is found per pixel by the
   * depth test, so the edge must sit outside it or the shore is a hard cut.
   */
  _buildRibbon(river) {
    const s = river.solved;
    if (river.mesh) {
      this.group.remove(river.mesh);
      river.mesh.geometry.dispose();
      river.mesh = null;
    }
    if (!s || s.count < 2) return;

    const p = this.params;
    const drop = p.surfaceDrop ?? 0.05;
    const step = Math.max(0.25, p.meshStep ?? 0.8);
    const cols = Math.max(2, Math.round(p.meshAcross ?? 12));
    const rows = Math.max(2, Math.min(4096, Math.round(s.total / step) + 1));

    const vCount = rows * (cols + 1);
    const pos = new Float32Array(vCount * 3);
    const uvs = new Float32Array(vCount * 2);
    const flow = new Float32Array(vCount * 4);
    // (turbulence, depth) — depth sets the standing-wave spacing, see the note
    // on waveHeight in riverV2Material.js.
    const wave = new Float32Array(vCount * 2);

    // Walk the solved stations once, interpolating between them per row.
    let si = 0;
    for (let r = 0; r < rows; r++) {
      const arc = (r / (rows - 1)) * s.total;
      while (si < s.count - 2 && s.arc[si + 1] < arc) si++;
      const a0 = s.arc[si];
      const a1 = s.arc[si + 1];
      const t = a1 > a0 ? Math.min(1, Math.max(0, (arc - a0) / (a1 - a0))) : 0;
      const lerp = (arr) => arr[si] + (arr[si + 1] - arr[si]) * t;

      const cx = lerp(s.x);
      const cz = lerp(s.z);
      let tx = lerp(s.tanX);
      let tz = lerp(s.tanZ);
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const px = -tz;
      const pz = tx;

      const halfW = lerp(s.width) * 0.5;
      const span = halfW + Math.min(lerp(s.bank) * 0.5, RIBBON_OVERHANG);
      const y = lerp(s.level) - drop;
      const spd = lerp(s.speed);
      const tb = lerp(s.turb);
      const dp = lerp(s.depth);

      for (let c = 0; c <= cols; c++) {
        const across = (c / cols - 0.5) * 2 * span;
        const v = r * (cols + 1) + c;
        pos[v * 3 + 0] = cx + px * across;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = cz + pz * across;
        uvs[v * 2 + 0] = arc;
        uvs[v * 2 + 1] = across;
        flow[v * 4 + 0] = tx;
        flow[v * 4 + 1] = tz;
        flow[v * 4 + 2] = spd;
        flow[v * 4 + 3] = halfW;
        wave[v * 2 + 0] = tb;
        wave[v * 2 + 1] = dp;
      }
    }

    const idx = new Uint32Array((rows - 1) * cols * 6);
    let o = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b = a + 1;
        const d = a + (cols + 1);
        const e = d + 1;
        idx[o++] = a; idx[o++] = b; idx[o++] = d;
        idx[o++] = b; idx[o++] = e; idx[o++] = d;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    g.setAttribute("aFlow", new THREE.BufferAttribute(flow, 4));
    g.setAttribute("aWave", new THREE.BufferAttribute(wave, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    // The vertex stage lifts the surface by at most the wave amplitude, which
    // the bounding sphere knows nothing about; a little slack stops a crest
    // popping the whole river out on a grazing frustum edge.
    if (g.boundingSphere) g.boundingSphere.radius += 2;

    const mesh = new THREE.Mesh(g, this._water.material);
    mesh.name = `RiverV2:${river.id}`;
    mesh.frustumCulled = true;
    mesh.renderOrder = 10;
    river.mesh = mesh;
    river.cullChunks = this._ribbonChunks(pos, rows, cols);
    mesh.userData.viewCulled = true;   // waterSurfaceMap restores the full range
    this.group.add(mesh);
  }

  /**
   * Bounding spheres for runs of RIVER_CULL_ROWS rows, with the index range
   * each one covers — what cullForCamera tests instead of the one sphere.
   *
   * One sphere around a whole river is useless for culling: nam-valley's is
   * 362 m across, so it touches the view from most of the map. MEASURED at RTS
   * zoom-out with 0 of the river's 13,949 vertices on screen, it was still
   * drawn every frame, and drawing ANY water triggers the two full-resolution
   * framebuffer copies every water shader shares (lakeMaterial.js
   * sceneColorGrab / sceneDepthGrab): 1.9 ms at 1919x888 for no water pixels.
   */
  _ribbonChunks(pos, rows, cols) {
    const chunks = [];
    const stride = cols + 1;
    const box = new THREE.Box3(), p = new THREE.Vector3();
    for (let r0 = 0; r0 < rows - 1; r0 += RIVER_CULL_ROWS) {
      const r1 = Math.min(rows - 1, r0 + RIVER_CULL_ROWS);   // last row, inclusive
      box.makeEmpty();
      for (let r = r0; r <= r1; r++) {
        for (let c = 0; c <= cols; c++) {
          const v = (r * stride + c) * 3;
          box.expandByPoint(p.set(pos[v], pos[v + 1], pos[v + 2]));
        }
      }
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      sphere.radius += RIVER_CULL_SLACK;
      chunks.push({ sphere, start: r0 * cols * 6, end: r1 * cols * 6 });
    }
    return chunks;
  }

  /**
   * Draw only the stretch of each river the camera can see: one contiguous
   * drawRange from the first visible chunk to the last, or nothing at all. Call
   * once per frame AFTER the camera has moved and BEFORE the render — a stale
   * camera would pop the river in a frame late at the screen edge.
   *
   * The ribbon's group is the identity (the vertices are world space), so the
   * chunk spheres are tested as they are. Anything else that renders these
   * meshes with its own camera must restore the full range first — see
   * waterSurfaceMap's bake.
   */
  cullForCamera(camera) {
    camera.updateMatrixWorld();
    _cullMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // The same call three's own culling makes (common/Renderer.js).
    _cullFrustum.setFromProjectionMatrix(_cullMat, camera.coordinateSystem, camera.reversedDepth);
    let visible = 0;
    for (const r of this.rivers) {
      const m = r.mesh, chunks = r.cullChunks;
      if (!m || !chunks?.length) continue;
      let first = -1, last = -1;
      for (let i = 0; i < chunks.length; i++) {
        if (!_cullFrustum.intersectsSphere(chunks[i].sphere)) continue;
        if (first < 0) first = i;
        last = i;
      }
      m.visible = first >= 0;
      if (first >= 0) {
        m.geometry.setDrawRange(chunks[first].start, chunks[last].end - chunks[first].start);
        visible++;
      }
    }
    this._visibleCount = visible;
  }

  /** Rivers that drew anything in the last cullForCamera. */
  get visibleCount() { return this._visibleCount ?? this.rivers.length; }

  rebuildMeshes() {
    for (const r of this.rivers) this._buildRibbon(r);
    this.onWaterMeshesChanged?.();
  }

  /** All live water meshes — for the water-surface map bake (lakebed, caustics). */
  get meshes() { return this.rivers.map((r) => r.mesh).filter(Boolean); }

  /**
   * The nearest-segment field the conform leaves behind: R = distance² to the
   * closest river centreline in UV units, G = path index, B = t along it.
   *
   * It is a live distance field for the whole river network, updated on every
   * edit, which is exactly what the sand band on the banks needs — so that
   * costs a texture fetch rather than a bake of its own. See riverSandTsl.js.
   */
  get nearTexture() { return this._rtNear.texture; }
  get pathTexture() { return this._pathTex; }

  // ═══════════════════════════════════════════════════════════════════════════
  // Handles and flow arrows
  // ═══════════════════════════════════════════════════════════════════════════

  _buildHandlePrototypes() {
    this._geoNode = new THREE.SphereGeometry(1, 12, 8);
    this._geoWidth = new THREE.OctahedronGeometry(1, 0);
    this._geoLevel = new THREE.ConeGeometry(0.7, 2, 8);

    this._matCache = new Map();

    // Arrow: a cone rotated to point along +Z, so a basis matrix built from the
    // flow tangent orients it directly.
    const cone = new THREE.ConeGeometry(0.45, 1.5, 7);
    cone.rotateX(Math.PI / 2);
    cone.translate(0, 0, 0.2);
    const shaft = new THREE.BoxGeometry(0.16, 0.16, 1.1);
    shaft.translate(0, 0, -0.85);
    this._geoArrow = mergeSimple([cone, shaft]);

    const arrowMat = new MeshBasicNodeMaterial();
    arrowMat.colorNode = attribute("aColor", "vec3");
    arrowMat.fog = false;
    this._arrowMat = arrowMat;
    this._arrows = null;
  }

  _handleMat(color) {
    let m = this._matCache.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, depthTest: true, fog: false });
      this._matCache.set(color, m);
    }
    return m;
  }

  _handleScale() {
    const cam = this.getCamera?.();
    if (!cam) return 1;
    // Roughly constant on screen: handles stay grabbable when zoomed out and do
    // not swallow the river when zoomed in.
    const d = cam.position.length();
    return Math.min(6, Math.max(0.45, d / 90));
  }

  _clearGroup(group) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const c = group.children[i];
      group.remove(c);
      if (c.isInstancedMesh) c.dispose?.();
    }
  }

  _rebuildVisual() {
    this.rebuildMeshes();
    this._rebuildHandles();
    this._rebuildArrows();
  }

  _rebuildHandles() {
    this._clearGroup(this.handleGroup);
    const p = this.params;
    if (!p.showHandles) return;
    const sc = this._handleScale();

    for (let ri = 0; ri < this.rivers.length; ri++) {
      const river = this.rivers[ri];
      const active = ri === this._activeIdx();
      for (let ni = 0; ni < river.nodes.length; ni++) {
        const nd = river.nodes[ni];
        const isSel = this.selected && this.selected.riverIdx === ri && this.selected.nodeIdx === ni;
        const color = isSel ? COL_SELECTED
          : Number.isFinite(nd.y) ? COL_PINNED
            : active ? COL_ACTIVE : COL_IDLE;
        const m = new THREE.Mesh(this._geoNode, this._handleMat(color));
        m.position.set(nd.x, this._nodeDisplayY(river, ni), nd.z);
        m.scale.setScalar(sc * (active ? 1 : 0.75));
        m.userData = { kind: "node", riverIdx: ri, nodeIdx: ni };
        m.renderOrder = 950;
        this.handleGroup.add(m);
      }
    }

    // The selected node also gets a width pair and a level handle. Showing these
    // on every node at once turns a river into a hedge of gizmos.
    const sel = this._selectedNode();
    if (sel) {
      const { river, node, riverIdx, nodeIdx } = sel;
      const y = this._nodeDisplayY(river, nodeIdx);
      const t = this._nodeTangent(river, nodeIdx);
      const px = -t.z, pz = t.x;
      const halfW = (node.width ?? this.params.newWidth) * 0.5;

      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(this._geoWidth, this._handleMat(COL_WIDTH));
        m.position.set(node.x + px * halfW * side, y, node.z + pz * halfW * side);
        m.scale.setScalar(sc * 0.8);
        m.userData = { kind: "width", riverIdx, nodeIdx, side };
        m.renderOrder = 951;
        this.handleGroup.add(m);
      }

      const lv = new THREE.Mesh(this._geoLevel, this._handleMat(COL_LEVEL));
      lv.position.set(node.x, y + sc * 3.2, node.z);
      lv.scale.setScalar(sc);
      lv.userData = { kind: "level", riverIdx, nodeIdx };
      lv.renderOrder = 951;
      this.handleGroup.add(lv);
    }
  }

  /**
   * Flow-direction arrows.
   *
   * Not decoration: node order defines which way the river runs, and a profile
   * that climbs against it is a real authoring mistake with no other symptom
   * until the water visibly sits wrong. Those stretches are drawn RED, so the
   * debug view doubles as the validity check.
   */
  _rebuildArrows() {
    this._clearGroup(this.arrowGroup);
    this._arrows = null;
    if (!this.params.showArrows) return;

    const items = [];
    for (const river of this.rivers) {
      const s = river.solved;
      if (!s) continue;
      let next = 0;
      for (let i = 0; i < s.count; i++) {
        if (s.arc[i] < next) continue;
        next = s.arc[i] + ARROW_SPACING;
        items.push({
          x: s.x[i], y: s.level[i] + 0.35, z: s.z[i],
          tx: s.tanX[i], tz: s.tanZ[i],
          speed: s.speed[i], uphill: s.uphill[i],
          scale: Math.min(3, Math.max(0.6, s.width[i] * 0.14)),
        });
      }
    }
    if (!items.length) return;

    const mesh = shareInstancePipeline(new THREE.InstancedMesh(this._geoArrow, this._arrowMat, items.length));
    mesh.frustumCulled = false;
    mesh.renderOrder = 940;

    const colors = new Float32Array(items.length * 3);
    const m4 = new THREE.Matrix4();
    const fwd = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3();
    const up2 = new THREE.Vector3();
    const scl = new THREE.Matrix4();

    const maxSpeed = this.params.maxSpeed ?? 9;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      fwd.set(it.tx, 0, it.tz).normalize();
      right.crossVectors(up, fwd).normalize();
      up2.crossVectors(fwd, right).normalize();
      m4.makeBasis(right, up2, fwd);
      scl.makeScale(it.scale, it.scale, it.scale);
      m4.multiply(scl);
      m4.setPosition(it.x, it.y, it.z);
      mesh.setMatrixAt(i, m4);

      // Slow water is deep blue, fast water washes out to white; a reach that
      // climbs against the flow is red whatever its speed.
      const t = Math.min(1, it.speed / Math.max(0.5, maxSpeed * 0.6));
      if (it.uphill) {
        colors[i * 3 + 0] = 1; colors[i * 3 + 1] = 0.12; colors[i * 3 + 2] = 0.12;
      } else {
        colors[i * 3 + 0] = 0.25 + 0.75 * t;
        colors[i * 3 + 1] = 0.6 + 0.4 * t;
        colors[i * 3 + 2] = 1;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.geometry.setAttribute(
      "aColor", new THREE.InstancedBufferAttribute(colors, 3),
    );

    this._arrows = mesh;
    this.arrowGroup.add(mesh);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Selection helpers
  // ═══════════════════════════════════════════════════════════════════════════

  _activeIdx() {
    if (!this.rivers.length) return -1;
    const i = this.params.activeRiverIndex | 0;
    return Math.max(0, Math.min(this.rivers.length - 1, i));
  }

  get activeRiver() {
    const i = this._activeIdx();
    return i < 0 ? null : this.rivers[i];
  }

  _selectedNode() {
    if (!this.selected) return null;
    const river = this.rivers[this.selected.riverIdx];
    if (!river) return null;
    const node = river.nodes[this.selected.nodeIdx];
    if (!node) return null;
    return { river, node, riverIdx: this.selected.riverIdx, nodeIdx: this.selected.nodeIdx };
  }

  /** Where a node's handle is drawn: its solved water level, or the ground. */
  _nodeDisplayY(river, nodeIdx) {
    const nd = river.nodes[nodeIdx];
    if (Number.isFinite(nd.y)) return nd.y;
    const s = river.solved;
    if (s && s.nodeLevel && s.nodeLevel[nodeIdx] != null) return s.nodeLevel[nodeIdx];
    return this.sampleBase(nd.x, nd.z);
  }

  _nodeTangent(river, nodeIdx) {
    const nodes = river.nodes;
    const a = Math.max(0, nodeIdx - 1);
    const b = Math.min(nodes.length - 1, nodeIdx + 1);
    let dx = nodes[b].x - nodes[a].x;
    let dz = nodes[b].z - nodes[a].z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  }

  /** Mirror the selected node's channel into the panel-facing state fields. */
  syncSelectionToState() {
    const sel = this._selectedNode();
    const p = this.params;
    if (!sel) {
      p.selWidth = p.newWidth;
      p.selDepth = p.newDepth;
      p.selBank = p.newBank;
      p.selLevel = 0;
      return;
    }
    p.selWidth = sel.node.width ?? p.newWidth;
    p.selDepth = sel.node.depth ?? p.newDepth;
    p.selBank = sel.node.bank ?? p.newBank;
    p.selLevel = this._nodeDisplayY(sel.river, sel.nodeIdx);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Picking and dragging
  // ═══════════════════════════════════════════════════════════════════════════

  pick(raycaster) {
    if (!this.params.showHandles) return null;
    const hits = raycaster.intersectObjects(this.handleGroup.children, false);
    for (const h of hits) {
      if (h.object.userData?.kind) return { ...h.object.userData };
    }
    return null;
  }

  select(pick) {
    if (!pick) return;
    this.selected = { riverIdx: pick.riverIdx, nodeIdx: pick.nodeIdx };
    this.params.activeRiverIndex = pick.riverIdx;
    this.syncSelectionToState();
    this._rebuildHandles();
  }

  beginDrag(pick) {
    if (!pick) return false;
    this.select(pick);
    this._pushUndo();
    this._drag = { ...pick };
    this.dragging = true;
    return true;
  }

  /**
   * @param {object} ctx
   * @param {THREE.Raycaster} ctx.raycaster
   * @param {{x:number,z:number}|null} ctx.terrainHit
   * @param {THREE.Camera} ctx.camera
   */
  dragTo({ raycaster, terrainHit, camera }) {
    const d = this._drag;
    if (!d) return;
    const river = this.rivers[d.riverIdx];
    const node = river?.nodes[d.nodeIdx];
    if (!node) return;

    if (d.kind === "node") {
      if (!terrainHit) return;
      node.x = terrainHit.x;
      node.z = terrainHit.z;
    } else if (d.kind === "width") {
      const y = this._nodeDisplayY(river, d.nodeIdx);
      const hit = this._rayOnHorizontalPlane(raycaster, y);
      if (!hit) return;
      const t = this._nodeTangent(river, d.nodeIdx);
      const px = -t.z, pz = t.x;
      // Project onto the across-stream axis, so dragging along the river does
      // not change the width.
      const dist = Math.abs((hit.x - node.x) * px + (hit.z - node.z) * pz);
      node.width = Math.min(200, Math.max(1, dist * 2));
    } else if (d.kind === "level") {
      const y = this._dragLevelY(raycaster, node, camera);
      if (y == null) return;
      // Dragging the level handle is what PINS a node: from here on the solver
      // holds this height instead of dropping the node onto the valley floor.
      node.y = y;
    }

    this.applyConform({ commit: false });
    this.syncSelectionToState();
  }

  /** What the current drag is moving, so the caller only pays for a terrain
   *  raycast when a node is actually being dragged across the ground. */
  get dragKind() { return this._drag?.kind ?? null; }

  endDrag() {
    if (!this._drag) return false;
    this._drag = null;
    this.dragging = false;
    this.applyConform({ commit: true });
    return true;
  }

  cancelDrag() {
    this._drag = null;
    this.dragging = false;
  }

  _rayOnHorizontalPlane(raycaster, y) {
    const r = raycaster.ray;
    if (Math.abs(r.direction.y) < 1e-6) return null;
    const t = (y - r.origin.y) / r.direction.y;
    if (t < 0) return null;
    return {
      x: r.origin.x + r.direction.x * t,
      z: r.origin.z + r.direction.z * t,
    };
  }

  /** Vertical drag: intersect the ray with a vertical plane through the node
   *  that faces the camera, and take the height of the hit. */
  _dragLevelY(raycaster, node, camera) {
    if (!camera) return null;
    const nx = camera.position.x - node.x;
    const nz = camera.position.z - node.z;
    const len = Math.hypot(nx, nz) || 1;
    const n = new THREE.Vector3(nx / len, 0, nz / len);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      n, new THREE.Vector3(node.x, 0, node.z),
    );
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return Math.max(-MAX_HEIGHT, Math.min(MAX_HEIGHT * 1.5, hit.y));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Editing
  // ═══════════════════════════════════════════════════════════════════════════

  _newNode(x, z) {
    const p = this.params;
    return {
      x, z,
      y: null,                 // AUTO — the solver drops it onto the valley floor
      width: p.newWidth ?? RIVER_NODE_DEFAULTS.width,
      depth: p.newDepth ?? RIVER_NODE_DEFAULTS.depth,
      bank: p.newBank ?? RIVER_NODE_DEFAULTS.bank,
    };
  }

  startNewRiver() {
    this._pushUndo();
    this.rivers.push({ id: _nextRiverId++, nodes: [], solved: null, mesh: null });
    this.params.activeRiverIndex = this.rivers.length - 1;
    this.selected = null;
    this._rebuildVisual();
  }

  /**
   * Click on the terrain.
   *
   * Appends to the end of the active river, or PREPENDS when the first node is
   * selected — so a river can be traced upstream from its mouth without
   * restarting it, which is how anyone actually draws one.
   */
  addNode({ x, z }) {
    this._pushUndo();
    if (!this.rivers.length) {
      this.rivers.push({ id: _nextRiverId++, nodes: [], solved: null, mesh: null });
      this.params.activeRiverIndex = 0;
    }
    const ri = this._activeIdx();
    const river = this.rivers[ri];
    const node = this._newNode(x, z);

    const prepend = this.selected
      && this.selected.riverIdx === ri
      && this.selected.nodeIdx === 0
      && river.nodes.length > 1;

    if (prepend) {
      river.nodes.unshift(node);
      this.selected = { riverIdx: ri, nodeIdx: 0 };
    } else {
      river.nodes.push(node);
      this.selected = { riverIdx: ri, nodeIdx: river.nodes.length - 1 };
    }

    this._snapMouthToNeighbour(ri);
    this.applyConform({ commit: true });
    this.syncSelectionToState();
  }

  /** Alt-click near the centreline: insert a node into the span it landed on. */
  insertNodeNear({ x, z }) {
    const ri = this._activeIdx();
    const river = this.rivers[ri];
    if (!river || river.nodes.length < 2) return false;

    // Insert against the CONTROL polyline, not the curve: the curve interpolates
    // the control points, so the span index is the same either way and this
    // needs no curve evaluation.
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < river.nodes.length - 1; i++) {
      const a = river.nodes[i];
      const b = river.nodes[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / len2));
      const dx = x - (a.x + abx * t);
      const dz = z - (a.z + abz * t);
      const d = Math.hypot(dx, dz);
      if (d < bestD) { bestD = d; best = i; }
    }
    // Reject clicks that are nowhere near the river.
    const solved = river.solved;
    const tol = solved ? Math.max(8, solved.width[0]) : 12;
    if (best < 0 || bestD > tol * 2) return false;

    this._pushUndo();
    const a = river.nodes[best];
    const b = river.nodes[best + 1];
    const node = this._newNode(x, z);
    // An inserted node inherits the channel it was inserted into, so adding
    // detail never changes the shape of the river.
    node.width = (a.width + b.width) * 0.5;
    node.depth = (a.depth + b.depth) * 0.5;
    node.bank = (a.bank + b.bank) * 0.5;
    river.nodes.splice(best + 1, 0, node);
    this.selected = { riverIdx: ri, nodeIdx: best + 1 };
    this.applyConform({ commit: true });
    this.syncSelectionToState();
    return true;
  }

  deleteSelected() {
    const sel = this._selectedNode();
    if (!sel) return false;
    this._pushUndo();
    sel.river.nodes.splice(sel.nodeIdx, 1);
    if (!sel.river.nodes.length) {
      this.rivers.splice(sel.riverIdx, 1);
      this.params.activeRiverIndex = Math.max(0, this.rivers.length - 1);
      this.selected = null;
    } else {
      this.selected = {
        riverIdx: sel.riverIdx,
        nodeIdx: Math.min(sel.nodeIdx, sel.river.nodes.length - 1),
      };
    }
    this.applyConform({ commit: true });
    this.syncSelectionToState();
    return true;
  }

  deleteActiveRiver() {
    const i = this._activeIdx();
    if (i < 0) return false;
    this._pushUndo();
    const r = this.rivers[i];
    if (r.mesh) { this.group.remove(r.mesh); r.mesh.geometry.dispose(); }
    this.rivers.splice(i, 1);
    this.params.activeRiverIndex = Math.max(0, this.rivers.length - 1);
    this.selected = null;
    this.applyConform({ commit: true });
    this.syncSelectionToState();
    return true;
  }

  clearAll() {
    this._pushUndo();
    for (const r of this.rivers) {
      if (r.mesh) { this.group.remove(r.mesh); r.mesh.geometry.dispose(); }
    }
    this.rivers.length = 0;
    this.selected = null;
    this.params.activeRiverIndex = 0;
    this.applyConform({ commit: true });
  }

  /** Un-pin the selected node: back to following the valley floor. */
  releaseSelectedLevel() {
    const sel = this._selectedNode();
    if (!sel) return false;
    this._pushUndo();
    sel.node.y = null;
    this.applyConform({ commit: true });
    this.syncSelectionToState();
    return true;
  }

  /** Pin every node of the active river at its currently solved level. */
  pinActiveRiver() {
    const river = this.activeRiver;
    if (!river?.solved) return false;
    this._pushUndo();
    for (let i = 0; i < river.nodes.length; i++) {
      river.nodes[i].y = river.solved.nodeLevel[i];
    }
    this.applyConform({ commit: true });
    this.syncSelectionToState();
    return true;
  }

  /** Un-pin every node of the active river. */
  releaseActiveRiver() {
    const river = this.activeRiver;
    if (!river) return false;
    this._pushUndo();
    for (const nd of river.nodes) nd.y = null;
    this.applyConform({ commit: true });
    this.syncSelectionToState();
    return true;
  }

  /** Lift or lower every PINNED node of the active river together. */
  nudgeActiveRiver(dy) {
    const river = this.activeRiver;
    if (!river?.solved) return false;
    this._pushUndo();
    for (let i = 0; i < river.nodes.length; i++) {
      const base = Number.isFinite(river.nodes[i].y)
        ? river.nodes[i].y : river.solved.nodeLevel[i];
      river.nodes[i].y = base + dy;
    }
    this.applyConform({ commit: true });
    this.syncSelectionToState();
    return true;
  }

  /** Reverse the flow: node order IS the direction, so this reverses the array. */
  reverseActiveRiver() {
    const river = this.activeRiver;
    if (!river || river.nodes.length < 2) return false;
    this._pushUndo();
    river.nodes.reverse();
    if (this.selected?.riverIdx === this._activeIdx()) {
      this.selected.nodeIdx = river.nodes.length - 1 - this.selected.nodeIdx;
    }
    this.applyConform({ commit: true });
    this.syncSelectionToState();
    return true;
  }

  /** Apply the selected node's channel to every node of its river. */
  applySelectedChannelToRiver() {
    const sel = this._selectedNode();
    if (!sel) return false;
    this._pushUndo();
    for (const nd of sel.river.nodes) {
      nd.width = sel.node.width;
      nd.depth = sel.node.depth;
      nd.bank = sel.node.bank;
    }
    this.applyConform({ commit: true });
    return true;
  }

  /** Panel edited one of the selected node's channel values. */
  setSelectedChannel({ width, depth, bank } = {}) {
    const sel = this._selectedNode();
    if (!sel) return false;
    if (width != null) sel.node.width = width;
    if (depth != null) sel.node.depth = depth;
    if (bank != null) sel.node.bank = bank;
    this.applyConform({ commit: true });
    return true;
  }

  /** Panel edited the selected node's level — which pins it. */
  setSelectedLevel(y) {
    const sel = this._selectedNode();
    if (!sel) return false;
    sel.node.y = y;
    this.applyConform({ commit: true });
    return true;
  }

  /**
   * A confluence, kept deliberately small: when a river's endpoint lands on
   * another river, pin it to that river's water level there. Nothing else is
   * shared — no junction geometry, no linked solve — because the interpolating
   * profile already makes the two surfaces meet once their levels agree.
   */
  _snapMouthToNeighbour(riverIdx) {
    const river = this.rivers[riverIdx];
    if (!river || river.nodes.length < 1) return;
    const ends = [0, river.nodes.length - 1];
    for (const ei of ends) {
      const nd = river.nodes[ei];
      if (Number.isFinite(nd.y)) continue;
      for (let oi = 0; oi < this.rivers.length; oi++) {
        if (oi === riverIdx) continue;
        const other = this.rivers[oi];
        if (!other.solved) continue;
        const snapR = Math.max(4, (nd.width ?? 10) * 0.75);
        const c = closestStation(other.solved, nd.x, nd.z, snapR);
        if (c) { nd.y = c.level; break; }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Undo / redo
  // ═══════════════════════════════════════════════════════════════════════════

  _snapshot() {
    return JSON.stringify(this.rivers.map((r) => ({
      id: r.id,
      nodes: r.nodes.map((n) => ({
        x: n.x, z: n.z, y: Number.isFinite(n.y) ? n.y : null,
        width: n.width, depth: n.depth, bank: n.bank,
      })),
    })));
  }

  _restore(json) {
    const data = JSON.parse(json);
    for (const r of this.rivers) {
      if (r.mesh) { this.group.remove(r.mesh); r.mesh.geometry.dispose(); }
    }
    this.rivers = data.map((r) => ({
      id: r.id, nodes: r.nodes, solved: null, mesh: null,
    }));
    _nextRiverId = Math.max(_nextRiverId, ...this.rivers.map((r) => r.id + 1), 1);
    this.selected = null;
    this.params.activeRiverIndex = Math.max(0, Math.min(
      this.params.activeRiverIndex | 0, this.rivers.length - 1,
    ));
    this.applyConform({ commit: true });
    this.syncSelectionToState();
  }

  _pushUndo() {
    this._undo.push(this._snapshot());
    if (this._undo.length > MAX_UNDO) this._undo.shift();
    this._redo.length = 0;
  }

  undo() {
    if (!this._undo.length) return false;
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop());
    return true;
  }

  redo() {
    if (!this._redo.length) return false;
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop());
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Material / frame
  // ═══════════════════════════════════════════════════════════════════════════

  syncMaterial() {
    const w = this.params.water;
    this._realistic.syncParams(riverWaterParams(w));
    const stylized = w.style === "stylized";
    if (stylized && !this._stylized) this._stylized = createRiverStylizedMaterial();
    this._stylized?.syncParams(w);
    const next = stylized ? this._stylized : this._realistic;
    if (next !== this._water) {
      this._water = next;
      for (const r of this.rivers) if (r.mesh) r.mesh.material = next.material;
    }
  }

  /** Drives its own clock from main's loop, so it does NOT implement the
   *  worldEnvironment `updateWater` hook — that would advance time twice. */
  update(dt) {
    this._time += dt;
    this._water.update(dt, this._time);
    if (this._water !== this._realistic) this._realistic.update(dt, this._time);
    if (this.editActive && this.handleGroup.visible) {
      const sc = this._handleScale();
      for (const h of this.handleGroup.children) {
        const k = h.userData?.kind;
        if (k === "node") h.scale.setScalar(sc * 0.9);
        else if (k === "width") h.scale.setScalar(sc * 0.8);
        else if (k === "level") h.scale.setScalar(sc);
      }
    }
  }

  /** worldEnvironment water-surface contract (sun/sky only — see update()). */
  setSunDir(v) { this._realistic.setSunDir(v); }
  setSkyColors(z, h) { this._realistic.setSkyColors(z, h); }

  setEditActive(on) {
    this.editActive = !!on;
    this.handleGroup.visible = on && !!this.params.showHandles;
    this.arrowGroup.visible = on && !!this.params.showArrows;
    if (!on) this.cancelDrag();
  }

  refreshVisibility() {
    this.handleGroup.visible = this.editActive && !!this.params.showHandles;
    this.arrowGroup.visible = this.editActive && !!this.params.showArrows;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════════════════

  exportData() {
    if (!this.rivers.length) return null;
    const p = this.params;
    return {
      params: {
        stationSpacing: p.stationSpacing, forceDownhill: p.forceDownhill,
        minGradient: p.minGradient, levelSmoothing: p.levelSmoothing,
        bedCurve: p.bedCurve, freeboard: p.freeboard, lipFraction: p.lipFraction,
        maxBankSlope: p.maxBankSlope, bankFlareMax: p.bankFlareMax,
        manningN: p.manningN, flowScale: p.flowScale, minSlope: p.minSlope,
        minSpeed: p.minSpeed, maxSpeed: p.maxSpeed, surfaceDrop: p.surfaceDrop,
        meshStep: p.meshStep, meshAcross: p.meshAcross,
        froudeStart: p.froudeStart, froudeFull: p.froudeFull,
        newWidth: p.newWidth, newDepth: p.newDepth, newBank: p.newBank,
        sand: { ...p.sand },
        water: { ...p.water },
      },
      rivers: this.rivers.map((r) => ({
        id: r.id,
        nodes: r.nodes.map((n) => ({
          x: n.x, z: n.z, y: Number.isFinite(n.y) ? n.y : null,
          width: n.width, depth: n.depth, bank: n.bank,
        })),
      })),
    };
  }

  /** The terrain as it was before any river touched it. Saved with the project
   *  so a reload re-conforms rather than conforming an already-conformed world. */
  exportBaseHeightmap() {
    return this._cpuBase ? Float32Array.from(this._cpuBase) : null;
  }

  importData(data) {
    for (const r of this.rivers) {
      if (r.mesh) { this.group.remove(r.mesh); r.mesh.geometry.dispose(); }
    }
    this.rivers = [];
    this.selected = null;
    this._undo.length = 0;
    this._redo.length = 0;

    const list = Array.isArray(data) ? data : data?.rivers;
    if (data?.params) {
      const p = this.params;
      for (const [k, v] of Object.entries(data.params)) {
        if (k === "water" || k === "sand") {
          if (v && typeof v === "object") Object.assign(p[k], v);
        } else if (v != null) {
          p[k] = v;
        }
      }
    }
    if (Array.isArray(list)) {
      for (const r of list) {
        if (!Array.isArray(r?.nodes) || r.nodes.length === 0) continue;
        this.rivers.push({
          id: r.id ?? _nextRiverId++,
          nodes: r.nodes.map((n) => ({
            x: n.x, z: n.z,
            y: Number.isFinite(n.y) ? n.y : null,
            width: n.width ?? this.params.newWidth,
            depth: n.depth ?? this.params.newDepth,
            bank: n.bank ?? this.params.newBank,
          })),
          solved: null, mesh: null,
        });
      }
    }
    _nextRiverId = Math.max(_nextRiverId, ...this.rivers.map((r) => r.id + 1), 1);
    this.params.activeRiverIndex = Math.max(0, this.rivers.length - 1);
    this.syncMaterial();
    this.applyConform({ commit: true });
    this.syncSelectionToState();
  }

  /** Called before a project's heightmap is swapped in, so the loaded terrain is
   *  never folded into the previous scene's base. */
  resetForLoad() {
    clearTimeout(this._rebaseTimer);
    this._dropBase();
  }
}

/** Minimal geometry merge — the two arrow parts share a material and have the
 *  same attribute set, so a full mergeGeometries dependency is not needed. */
function mergeSimple(geos) {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const nAttr = g.attributes.normal;
    pos.set(p, vo * 3);
    if (nAttr) nor.set(nAttr.array, vo * 3);
    const gi = g.index ? g.index.array : null;
    const c = g.attributes.position.count;
    if (gi) {
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < c; i++) idx[io + i] = i + vo;
      io += c;
    }
    vo += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
