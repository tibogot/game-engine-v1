/**
 * Snow deformation system for V3.
 *
 * The snow surface itself is defined once in snowShared.js and rendered with
 * real volume by the terrain LOD material everywhere it is painted. This
 * system adds the *local* refinement: a high-subdivision tile follows the
 * player and subtracts trail compression (footprints, wheel ruts) recorded in
 * a GPU ping-pong render-target.
 *
 *   tile:    y = terrainH + snowDepth(wxz) × (1 − compression) + rim
 *   terrain: y = terrainH + snowDepth(wxz) × (1 − tileMask)
 *
 * At the tile border compression and tileMask both reach 0, so tile and
 * terrain evaluate the SAME function — the hand-off is invisible, with no
 * alpha ring and no height band. Inside the tile the terrain drops to bare
 * ground, so tile − terrain = depth·tileMask·(1−comp) ≥ 0 and the coarse
 * terrain can never poke up through grooves.
 *
 * The trail render-target is half-float: an 8-bit target quantizes under the
 * per-frame 5-tap blur and produces visible contour bands around prints.
 *
 * Geometry reads DERIVED blur levels, not the accumulator: whenever the trail
 * changes, blur passes band-limit the compression at two widths — fine (512²,
 * ~±0.05 m) and coarse (256², cascaded, ~±0.4 m) — because the tile mesh is a
 * radially-warped grid: ~0.055 m/vertex under the player (curved rut edges
 * read as curves, not polygons) stretching to ~0.36 m at the rim. Each vertex
 * blends the two levels by its distance from centre, so its sampling rate
 * always matches the signal's band-limit — no staircase, no polygon corners
 * on turns, no re-aliasing on the stretched outer verts. The rim is analytic
 * (c·(1−c) lip on the compression transition — dilate/max rims alias into
 * beads on coarse lattices). Shading normals read the fine blur level so rut
 * walls light softly; albedo/roughness read the crisp accumulator so prints
 * still tint sharply.
 *
 * API:
 *   createSnowSystem(renderer, scene, initialHeightTex)
 *     → { shared, mesh, params, u, setHeightTex, setSnowMaskTex, setPlayMode,
 *         setDeformActive, setVisible, updateSunDir, updateAnchor, tick,
 *         resetTrail, dispose }
 *
 * Call tick(px, pz, grounded, contacts?) every frame while in play mode.
 * contacts: { xzs: Float32Array(8), touching: Float32Array(4), isVehicle? }
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn, Loop, If, Break,
  float, int, max, min, mix,
  modelViewMatrix,
  positionGeometry, positionWorld,
  smoothstep, step,
  texture, uniform, uniformArray, uv,
  vec2, vec3, vec4,
  mx_noise_float,
} from "three/tsl";
import { createSnowShared } from "./snowShared.js";

// ── Constants ────────────────────────────────────────────────────────────────
const TRAIL_RES  = 1024;  // trail render-target resolution (~20 px/m — feet read as prints)
const TRAIL_NEUT = 0.5;   // neutral (untouched) value in the RT
const MAX_STAMPS = 64;    // max stamp disks per frame (4 wheels/paws need headroom)

const TILE_SIZE      = 50;  // matches trailWorldSize — full RT window has vertices
const TILE_HALF      = TILE_SIZE * 0.5;
const TILE_FEATHER   = 10;  // metres — terrain↔tile displacement hand-off width
const TILE_EDGE_FADE = 2;   // metres — opacity fade over the coincident border strip

// Radially-warped tile grid: vertices concentrate under the player (where the
// camera is and where fresh trail curves live) and stretch toward the edge.
// warp(t) = H·(a·t + (1−a)·sign(t)·|t|^p) for t ∈ [−1,1] gives ~0.055 m/vertex
// at the centre (snow-lab density) and ~0.36 m at the rim — 205k tris total vs
// the 2.9M a uniform grid would need for the same centre density. A curved rut
// edge drawn with 0.2 m segments reads as visibly polygonal when turning; at
// 0.055 m it reads as a curve.
const SUBDIVISIONS = 320;
const WARP_LINEAR  = 0.35; // linear share `a` — sets centre density
const WARP_POWER   = 3;    // superlinear exponent `p` — sets edge stretch
const CENTER_STEP  = TILE_HALF * WARP_LINEAR * (2 / SUBDIVISIONS); // ≈ 0.055 m

// Displacement chain — geometry never samples the crisp accumulator directly.
// Two band-limit levels matching the graded mesh: fine for the dense centre,
// a wider blur for the stretched outer vertices (blended radially in the
// vertex stage) so the coarse region can't re-alias into terraces.
const DISP_RES        = TRAIL_RES / 2;  // 512 — fine level
const DISP_RES_COARSE = TRAIL_RES / 4;  // 256 — coarse level
// Radial blend between the two levels, in metres from the tile centre.
const LOD_BLEND_NEAR = 6;
const LOD_BLEND_FAR  = 17;

// ── Default parameters (all live-editable via system.params) ────────────────
export const SNOW_PARAMS_DEFAULTS = {
  // snow surface
  baseDepth:        0.30,   // resting snow layer height (m)
  noiseFreq1:       0.06,   // low-frequency surface variation
  noiseFreq2:       0.14,   // high-frequency surface variation
  noiseAmp:         0.12,   // noise amplitude (m)
  // deformation trail window
  trailWorldSize:   50,     // world-space diameter of the scrolling RT window (m)
  // deformation look
  grooveScale:      1.0,    // 0=no groove, 1=fully compress to ground
  rimScale:         0.14,   // height of the pushed-up rim ridge
  rimOffset:        0.55,   // world offset used to detect the rim gradient (m)
  trailSoftness:    0.30,   // trail edge smoothing half-width (m) — 0.3 ≈ the
                            // snow-lab's steady-state feedback-blur softness
  // stamping (per-frame)
  stampPush:        0.5,    // how deep each stamp pushes (relative to trail neut)
  stampRadius:      0.42,   // world radius of each stamp disk (m) — snow-lab default
  stampStepWorld:   0.10,   // interpolation step along movement path (m)
  footRadius:       0.14,   // human foot — discrete prints, not a body trail
  footPush:         0.45,
  footStepWorld:    0.06,   // short segments while planted (not a continuous rut)
  regrowRate:       0,      // per-frame regrow toward neutral (0 = permanent)
  // visual
  cavityStrength:   0.55,
  roughnessDip:     0.28,
  glitterIntensity: 2.0,
  glitterScarcity:  250.0,
  glitterFreq:      200.0,
  // slope coverage: normal.y >= start = full snow, <= reject = no snow
  slopeStartY:      0.78,   // ~39 degrees
  slopeRejectY:     0.55,   // ~57 degrees
};

// ── Warped tile grid ─────────────────────────────────────────────────────────
// Regular (N+1)² grid topology — watertight, no stitching — with vertex
// positions warped radially per axis. Density is a pure vertex-distribution
// choice: the surface stays the same world-space function everywhere.
function buildWarpedTileGeometry(N) {
  const warp = (t) => {
    const a = Math.abs(t);
    return TILE_HALF * (WARP_LINEAR * t + (1 - WARP_LINEAR) * Math.sign(t) * Math.pow(a, WARP_POWER));
  };

  const vertsPerSide = N + 1;
  const positions = new Float32Array(vertsPerSide * vertsPerSide * 3);
  const normals   = new Float32Array(vertsPerSide * vertsPerSide * 3);
  const indices   = new Uint32Array(N * N * 6);

  let vi = 0;
  for (let iz = 0; iz <= N; iz++) {
    const z = warp((iz / N) * 2 - 1);
    for (let ix = 0; ix <= N; ix++) {
      positions[vi]     = warp((ix / N) * 2 - 1);
      positions[vi + 1] = 0;
      positions[vi + 2] = z;
      normals[vi + 1]   = 1;
      vi += 3;
    }
  }

  let ii = 0;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const a = iz * vertsPerSide + ix;
      const b = a + 1, c = a + vertsPerSide, d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal",   new THREE.BufferAttribute(normals,   3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

// ── Main factory ─────────────────────────────────────────────────────────────
export function createSnowSystem(renderer, scene, initialHeightTex, sharedHeightNode = null, terrainNormals = null) {
  const params = { ...SNOW_PARAMS_DEFAULTS };

  // Shared surface definition — also handed to the terrain LOD material.
  const shared = createSnowShared(initialHeightTex, params, sharedHeightNode, terrainNormals);
  shared.u.uTileHalf.value    = TILE_HALF;
  shared.u.uTileFeather.value = TILE_FEATHER;

  // ── Ping-pong trail render-targets ─────────────────────────────────────────
  function _makeRT(res) {
    const rt = new THREE.RenderTarget(res, res, {
      format:          THREE.RGBAFormat,
      type:            THREE.HalfFloatType,
      colorSpace:      THREE.NoColorSpace,
      minFilter:       THREE.LinearFilter,
      magFilter:       THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer:     false,
    });
    rt.texture.flipY = false;
    return rt;
  }

  function _clearRT(rt, level) {
    const prevRT  = renderer.getRenderTarget();
    const prevCol = new THREE.Color();
    renderer.getClearColor(prevCol);
    const prevA   = renderer.getClearAlpha();
    renderer.setClearColor(new THREE.Color(level, level, level), 1);
    renderer.setRenderTarget(rt);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevCol, prevA);
  }

  const rts = [_makeRT(TRAIL_RES), _makeRT(TRAIL_RES)];
  _clearRT(rts[0], TRAIL_NEUT);
  _clearRT(rts[1], TRAIL_NEUT);
  let rtIdx = 0;  // current read index

  // Derived displacement targets (re-rendered only on trail change). These
  // store compression [0,1] (0 = pristine), NOT the accumulator's neutral-0.5
  // encoding — so their cleared/neutral level is 0. The coarse level is a
  // two-pass cascade: a single 3×3 tent can't widen the kernel enough for the
  // stretched outer vertices without leaving gaps between taps.
  const blurTmpRT     = _makeRT(DISP_RES);         // fine cascade intermediate
  const blurRT        = _makeRT(DISP_RES);         // fine band-limited compression
  const blurCoarseRT  = _makeRT(DISP_RES_COARSE);  // coarse cascade intermediate
  const blurCoarse2RT = _makeRT(DISP_RES_COARSE);  // wide band-limit for outer verts
  _clearRT(blurTmpRT, 0);
  _clearRT(blurRT, 0);
  _clearRT(blurCoarseRT, 0);
  _clearRT(blurCoarse2RT, 0);

  // TSL texture nodes that get their .value swapped each frame
  const trailSrcNode  = texture(rts[0].texture);  // input to the pass shader
  const trailDispNode = texture(rts[0].texture);  // crisp — fragment shading + blur input

  // ── Trail pass shader (QuadMesh, runs once per frame when needed) ──────────
  const stampVecs = Array.from({ length: MAX_STAMPS }, () => new THREE.Vector4());
  const passU = {
    uShiftUV:    uniform(new THREE.Vector2(0, 0)),
    uRegrow:     uniform(0),
    uStampCount: uniform(0),
    uStamps:     uniformArray(stampVecs, "vec4"),
  };

  const neutral = float(TRAIL_NEUT);
  const passMat = new THREE.MeshBasicNodeMaterial();
  passMat.toneMapped = passMat.fog = passMat.depthTest = passMat.depthWrite = false;

  passMat.colorNode = Fn(() => {
    const uvHere = uv();
    const srcUV  = uvHere.add(passU.uShiftUV);
    const inBnds = step(float(0), srcUV.x).mul(step(srcUV.x, float(1)))
                   .mul(step(float(0), srcUV.y)).mul(step(srcUV.y, float(1)));

    // Carry the previous frame as-is. No per-frame blur: this pass runs every
    // frame while moving, so any diffusion here erases footprints (a foot is
    // only a couple of texels) within seconds. The quintic stamp disks below
    // are already soft-edged; softness belongs in the stamp, not the carry.
    // .sample() (not texture(node, uv)) — the ping-pong swap changes
    // trailSrcNode.value every frame, and texture(node, uv) would bake the
    // build-time texture in, silently dropping all accumulated history.
    const sampled = trailSrcNode.sample(srcUV.clamp(0, 1)).r;
    const carried = mix(neutral, sampled, inBnds);
    const regrown = min(neutral, carried.add(passU.uRegrow));

    const val = regrown.toVar("val");
    // Quintic stamp disks — smoother edges than cubic, no polygon stepping.
    // Early-break once past the active stamp count: a walking character stamps
    // ~2 disks/frame, so the loop exits after 2 iterations instead of grinding
    // through all 64 slots per texel. The count is uniform across the RT, so
    // the break is coherent (no divergence).
    Loop({ start: int(0), end: int(MAX_STAMPS), type: "int", condition: "<" }, ({ i }) => {
      If(float(i).greaterThanEqual(passU.uStampCount), () => { Break(); });
      const s      = passU.uStamps.element(i);
      const radius = s.z.max(float(1e-5));
      const push   = s.w;
      const d      = uvHere.distance(vec2(s.x, s.y));
      const t      = float(1).sub(d.div(radius)).clamp(0, 1);
      const tq     = t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));
      val.assign(max(float(0), val.sub(tq.mul(push))));
    });

    return vec4(val, val, val, float(1));
  })();

  const trailPassQuad = new QuadMesh(passMat);

  // ── Stamp helpers ──────────────────────────────────────────────────────────
  let stampCount     = 0;
  const trailCenter  = new THREE.Vector2(0, 0);
  const pendingShift = new THREE.Vector2(0, 0);
  let shiftDirty     = false;
  const prevXZ       = new THREE.Vector2(NaN, NaN);   // ball / body-centre trail
  const prevSlotXZ   = new Float32Array(8).fill(NaN); // per-foot / per-wheel slots

  function _pushStamp(wx, wz, push, radius) {
    if (stampCount >= MAX_STAMPS) return;
    const sz = params.trailWorldSize;
    const su = (wx - trailCenter.x) / sz + 0.5;
    const sv = (wz - trailCenter.y) / sz + 0.5;
    const sr = radius / sz;
    if (su < -sr || su > 1 + sr || sv < -sr || sv > 1 + sr) return;
    stampVecs[stampCount].set(su, sv, sr, push);
    stampCount++;
  }

  function _processContacts(contacts) {
    const { xzs, touching, isVehicle } = contacts;
    if (!xzs || !touching) return;

    let activeCount = 0;
    for (let i = 0; i < 4; i++) if (touching[i] > 0) activeCount++;

    // Callers may override stamp size per entity (capsule body width, dog paws,
    // wheel ruts) so each pawn leaves a footprint that matches its shape rather
    // than the generic foot/vehicle defaults.
    const vehicle = isVehicle ?? (activeCount > 1);
    const radius  = contacts.radius ?? (vehicle ? params.stampRadius    : params.footRadius);
    const push    = contacts.push   ?? (vehicle ? params.stampPush      : params.footPush);
    const step    = contacts.step   ?? (vehicle ? params.stampStepWorld : params.footStepWorld);

    for (let i = 0; i < 4; i++) {
      if (!touching[i]) {
        prevSlotXZ[i * 2]     = NaN;
        prevSlotXZ[i * 2 + 1] = NaN;
        continue;
      }
      const cx = xzs[i * 2];
      const cz = xzs[i * 2 + 1];
      const px = prevSlotXZ[i * 2];
      const pz = prevSlotXZ[i * 2 + 1];
      if (Number.isFinite(px)) {
        _pushSegment(px, pz, cx, cz, push, radius, step);
      } else {
        _pushStamp(cx, cz, push, radius);
      }
      prevSlotXZ[i * 2]     = cx;
      prevSlotXZ[i * 2 + 1] = cz;
    }
  }

  function _pushSegment(ax, az, bx, bz, push, radius, stepWorld = params.stampStepWorld) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) { _pushStamp(bx, bz, push, radius); return; }
    const steps = Math.max(1, Math.ceil(len / stepWorld));
    for (let i = 0; i <= steps; i++) {
      _pushStamp(ax + (bx - ax) * (i / steps), az + (bz - az) * (i / steps), push, radius);
      if (stampCount >= MAX_STAMPS) break;
    }
  }

  function _shiftTrailCenter(px, pz) {
    const sz = params.trailWorldSize;
    const ts = sz / (TRAIL_RES - 1);
    const nx = Math.round(px / ts) * ts;
    const nz = Math.round(pz / ts) * ts;
    const dx = Math.round((nx - trailCenter.x) / ts);
    const dz = Math.round((nz - trailCenter.y) / ts);
    if (dx === 0 && dz === 0) { pendingShift.set(0, 0); return; }
    pendingShift.set(dx, dz);
    shiftDirty = true;
    trailCenter.set(nx, nz);
  }

  function _runTrailPass() {
    const ri = rtIdx;
    const wi = 1 - ri;
    trailSrcNode.value = rts[ri].texture;
    passU.uShiftUV.value.set(pendingShift.x / TRAIL_RES, pendingShift.y / TRAIL_RES);
    passU.uRegrow.value     = Math.max(0, params.regrowRate);
    passU.uStampCount.value = stampCount;

    const prevRT  = renderer.getRenderTarget();
    const prevCol = new THREE.Color();
    renderer.getClearColor(prevCol);
    const prevA = renderer.getClearAlpha();

    renderer.setRenderTarget(rts[wi]);
    trailPassQuad.render(renderer);

    // Derived displacement chain — blur reads the freshly written accumulator,
    // so swap trailDispNode first. Only runs here, i.e. only on change frames.
    rtIdx               = wi;
    trailDispNode.value = rts[wi].texture;
    renderer.setRenderTarget(blurTmpRT);
    blurFineQuadA.render(renderer);
    renderer.setRenderTarget(blurRT);
    blurFineQuadB.render(renderer);
    renderer.setRenderTarget(blurCoarseRT);
    blurCoarseQuadA.render(renderer);
    renderer.setRenderTarget(blurCoarse2RT);
    blurCoarseQuadB.render(renderer);

    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevCol, prevA);

    pendingShift.set(0, 0);
    shiftDirty = false;
  }

  // ── Snow material uniforms (surface uniforms live in shared.u) ────────────
  const u = {
    ...shared.u,
    uTrailCenter:    uniform(new THREE.Vector2(0, 0)),
    uTrailWorldSize: uniform(params.trailWorldSize),
    uGrooveScale:    uniform(params.grooveScale),
    uRimScale:       uniform(params.rimScale),
    uRimOffset:      uniform(params.rimOffset),
    uTrailSoft:      uniform(params.trailSoftness),
  };

  // ── Displacement chain (blur → rim, two levels), runs after each trail pass ─
  // Band-limits the compression to what the graded mesh can represent — the
  // source of the low-poly look was the ~0.05 m/texel accumulator being
  // point-sampled by a much coarser vertex grid.
  function _makePassMat(colorFn) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.toneMapped = m.fog = m.depthTest = m.depthWrite = false;
    m.colorNode = Fn(colorFn)();
    return m;
  }

  // 3×3 tent blur. srcNode is sampled at ±offNode (a TSL node, so the width
  // can be uniform-driven and live-editable); convert() maps the source
  // encoding to compression [0,1] (identity for already-converted sources).
  function _makeBlurMat(srcNode, offNode, convert) {
    return _makePassMat(() => {
      const uvHere = uv();
      const w3 = [1, 2, 1];
      let acc = null;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const w = (w3[i + 1] * w3[j + 1]) / 16;
          const p = uvHere.add(vec2(offNode.mul(i), offNode.mul(j))).clamp(0, 1);
          const c = convert(srcNode.sample(p).r).mul(w);
          acc = acc ? acc.add(c) : c;
        }
      }
      return vec4(acc, float(0), float(0), float(1));
    });
  }

  // NOTE: no dilate/ring-max rim pass. max() creates kinks (unbandlimited
  // content) that re-alias on the coarse texel lattice — it showed up as
  // beading along diagonal rut edges. The rim is instead derived analytically
  // in the vertex stage from the smooth compression itself (c·(1−c) peaks on
  // the transition band), which is alias-free by construction.

  const blurTmpNode     = texture(blurTmpRT.texture);
  const blurNode        = texture(blurRT.texture);
  const blurCoarseNode  = texture(blurCoarseRT.texture);
  const blurCoarse2Node = texture(blurCoarse2RT.texture);
  const _toComp = (v) => neutral.sub(v).max(0).mul(float(1 / TRAIL_NEUT));

  // Fine: two cascaded tents at ±uTrailSoft/2 — the LOOK control. At the 0.30
  // default this reproduces the snow-lab's steady-state softness (its 512² RT
  // + per-frame feedback blur settles at ~0.3–0.5 m soft edges) WITHOUT the
  // feedback (trail never erodes). Lower it for crisp prints, raise for
  // powder. .sample() via trailDispNode — its .value swaps every ping-pong
  // frame.
  const _softOffUV      = u.uTrailSoft.mul(0.5).div(u.uTrailWorldSize);
  const blurFineQuadA   = new QuadMesh(_makeBlurMat(trailDispNode, _softOffUV, _toComp));
  const blurFineQuadB   = new QuadMesh(_makeBlurMat(blurTmpNode,   _softOffUV, (v) => v));
  // Coarse: two more cascaded tents at ±1 coarse texel (~±0.4 m extra with
  // bilinear) — wide enough that the ~0.35 m outer vertices can't alias on it.
  const _coarseOffUV    = float(1.0 / DISP_RES_COARSE);
  const blurCoarseQuadA = new QuadMesh(_makeBlurMat(blurNode,       _coarseOffUV, (v) => v));
  const blurCoarseQuadB = new QuadMesh(_makeBlurMat(blurCoarseNode, _coarseOffUV, (v) => v));

  // ── Snow TSL material ──────────────────────────────────────────────────────
  // Opaque over covered snow; opacity only fades where the painted coverage
  // thins out (surface hugs the tinted terrain there) and over the 2 m border
  // strip where tile and terrain are the same surface anyway.
  const mat = new THREE.MeshStandardNodeMaterial({
    transparent:        true,
    depthWrite:         true,
    alphaTest:          0.02,
    roughness:          0.93,
    metalness:          0,
    polygonOffset:      true,
    polygonOffsetFactor:-2,   // wins the depth test where tile ≈ coplanar with terrain
    polygonOffsetUnits: -2,
  });
  mat.envMapIntensity = 0.6;

  // ── TSL helpers ────────────────────────────────────────────────────────────

  // world XZ → [0,1] UV within the scrolling trail window
  const trailUVfn = Fn(([wxz]) =>
    wxz.sub(u.uTrailCenter).div(u.uTrailWorldSize).add(0.5)
  );

  // Soft fade within the 4% border of the trail RT to hide edge artifacts
  const trailEdgeFade = Fn(([tuv]) => {
    const fw  = float(0.04);
    const fuX = min(tuv.x.div(fw).clamp(0, 1), float(1).sub(tuv.x).div(fw).clamp(0, 1));
    const fuY = min(tuv.y.div(fw).clamp(0, 1), float(1).sub(tuv.y).div(fw).clamp(0, 1));
    return fuX.mul(fuY);
  });

  // Trail compression [0,1] at world XZ. Multiplied by tileMask so it reaches
  // exactly 0 at the tile border — this is what guarantees the terrain
  // hand-off is seamless AND that the tile never dips below the terrain.
  const compressionAt = Fn(([wxz]) => {
    const tuv = trailUVfn(wxz);
    const raw = neutral.sub(trailDispNode.sample(tuv.clamp(0, 1)).r)
      .max(0).mul(float(1.0 / TRAIL_NEUT));
    return raw.mul(trailEdgeFade(tuv)).mul(shared.tileMask(wxz));
  });

  // Same, from the fine blurred level — used for the shading normal so rut
  // walls light softly (the lab's smoothness is as much shading as geometry;
  // a crisp-gradient normal paints hard edges over any mesh).
  const compressionSoftAt = Fn(([wxz]) => {
    const tuv = trailUVfn(wxz);
    return blurNode.sample(tuv.clamp(0, 1)).r
      .mul(trailEdgeFade(tuv)).mul(shared.tileMask(wxz));
  });

  // ── Vertex: shared snow surface minus compression, plus rim lip ───────────
  // Two blur-level taps per vertex, blended by distance from the tile centre
  // so each vertex reads a signal matched to its local grid density — dense
  // centre verts get detail, stretched outer verts get a wider blur they
  // can't alias on. Rim = c·(1−c)·4: an analytic lip riding the compression
  // transition band — smooth by construction (no dilate/max kinks to alias),
  // peaks at rimScale·depth on the rut walls, zero in the groove and on
  // pristine snow. Fade + tileMask are applied here (one consistent factor
  // for compression AND rim), so both still reach exactly 0 at the tile
  // border — the terrain hand-off invariant is unchanged.
  mat.positionNode = Fn(() => {
    const lxz   = positionGeometry.xz;
    const wxz   = lxz.add(u.uAnchor);
    const depth = shared.snowDepth(wxz);

    const tuv  = trailUVfn(wxz).clamp(0, 1);
    const fade = trailEdgeFade(tuv).mul(shared.tileMask(wxz));
    const cF   = blurNode.sample(tuv).r;
    const cC   = blurCoarse2Node.sample(tuv).r;
    const lodT = smoothstep(float(LOD_BLEND_NEAR), float(LOD_BLEND_FAR),
                            max(lxz.x.abs(), lxz.y.abs()));
    const cB   = mix(cF, cC, lodT).mul(fade);

    const comp = cB.mul(u.uGrooveScale).clamp(0, 1);
    const rim  = cB.mul(float(1).sub(cB)).mul(4)
      .mul(u.uRimScale).mul(depth);

    const y = shared.getTerrainH(wxz)
      .add(depth.mul(float(1).sub(comp)))
      .add(rim);
    return vec3(lxz.x, y, lxz.y);
  })();

  // ── Fragment: per-pixel normal, shared shading, coverage opacity ──────────
  const wXZ = positionWorld.xz;

  const compRaw = compressionAt(wXZ);
  const compF   = compRaw.mul(u.uGrooveScale).clamp(0, 1);

  // Normal = analytic terrain normal + compression-gradient perturb + a small
  // high-frequency noise perturb so undisturbed snow isn't mirror-flat. The
  // gradient reads the *soft* compression: crisp-gradient normals draw a hard
  // lighting edge along every rut wall, which reads as polygonal even on
  // smooth geometry. Albedo/roughness below keep the crisp value so prints
  // still tint sharply.
  // Gradient shift tracks the softness control (the lab's normalShift 0.35).
  const gEps = u.uTrailSoft.clamp(0.1, 0.6);
  const cGR  = compressionSoftAt(wXZ.add(vec2(gEps, float(0))));
  const cGL  = compressionSoftAt(wXZ.sub(vec2(gEps, float(0))));
  const cGU  = compressionSoftAt(wXZ.add(vec2(float(0), gEps)));
  const cGD  = compressionSoftAt(wXZ.sub(vec2(float(0), gEps)));
  const dScale = u.uBaseDepth.mul(u.uGrooveScale).div(gEps.mul(2));
  const gradX  = cGR.sub(cGL).mul(dScale);
  const gradZ  = cGU.sub(cGD).mul(dScale);

  const f2   = u.uNoiseFreq2;
  const nEps = float(0.15);
  const nsC  = mx_noise_float(vec3(wXZ.x.mul(f2),           float(0), wXZ.y.mul(f2)));
  const nsX  = mx_noise_float(vec3(wXZ.x.add(nEps).mul(f2), float(0), wXZ.y.mul(f2)));
  const nsZ  = mx_noise_float(vec3(wXZ.x.mul(f2),           float(0), wXZ.y.add(nEps).mul(f2)));
  const nK   = u.uNoiseAmp.mul(0.5).div(nEps);
  const npX  = nsC.sub(nsX).mul(nK);
  const npZ  = nsC.sub(nsZ).mul(nK);

  const surfN = shared.terrainNormal(wXZ, float(2.0))
    .add(vec3(gradX.add(npX), float(0), gradZ.add(npZ)))
    .normalize();
  mat.normalNode = modelViewMatrix.mul(vec4(surfN, float(0))).xyz.normalize();

  mat.colorNode     = shared.snowAlbedo(compF);
  mat.roughnessNode = shared.snowRoughness(compF);
  mat.emissiveNode  = shared.snowSparkle(wXZ, compF);

  // Opacity: fade where painted coverage thins (snow height → 0 there, so it
  // dissolves onto the identically-tinted terrain), plus a short fade at the
  // tile rim where tile and terrain interpolate the same surface.
  const adxF     = wXZ.x.sub(u.uAnchor.x).abs();
  const adzF     = wXZ.y.sub(u.uAnchor.y).abs();
  const edgeDist = min(u.uTileHalf.sub(adxF), u.uTileHalf.sub(adzF));
  const rimFade  = smoothstep(float(0), float(TILE_EDGE_FADE), edgeDist);
  mat.opacityNode = smoothstep(float(0.05), float(0.5), shared.covBlend(wXZ)).mul(rimFade);

  // ── Deformation tile mesh (50 m, centre-dense warped grid, play mode only) ─
  const geo = buildWarpedTileGeometry(SUBDIVISIONS);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.renderOrder   = 1;    // renders above the terrain
  mesh.visible       = false;
  scene.add(mesh);
  let playModeActive = false;
  let deformActive = false;

  function _syncTileOn() {
    const on = playModeActive && deformActive;
    mesh.visible = on;
    // Terrain reads this: it renders the full snow surface wherever the tile
    // is off, and hands the tile footprint over when it's on. Flipping both
    // in the same call keeps the swap invisible.
    shared.u.uTileOn.value = on ? 1 : 0;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Swap to a different heightmap GPU texture (e.g. after loading a save). */
  function setHeightTex(tex) {
    shared.setHeightTex(tex);
  }

  /** Set the painted snow coverage map.  Pass snowMap.tex from SnowMap. */
  function setSnowMaskTex(tex) {
    shared.setMaskTex(tex);
  }

  function setPlayMode(on) {
    playModeActive = !!on;
    _syncTileOn();
  }

  function setDeformActive(on) {
    deformActive = !!on;
    _syncTileOn();
  }

  /** @deprecated use setPlayMode */
  function setVisible(on) {
    setPlayMode(on);
  }

  /** Call with worldEnv.getSunDir() each frame so sparkle tracks the sun. */
  function updateSunDir(dir) {
    if (dir) u.uSunDir.value.copy(dir);
  }

  /** Snap the snow tile anchor to the centre vertex spacing (anti-swim). */
  function updateAnchor(px, pz) {
    const ax = Math.round(px / CENTER_STEP) * CENTER_STEP;
    const az = Math.round(pz / CENTER_STEP) * CENTER_STEP;
    u.uAnchor.value.set(ax, az);
    mesh.position.set(ax, 0, az);
  }

  /**
   * @param {number} px
   * @param {number} pz
   * @param {boolean} grounded
   * @param {{ xzs: Float32Array, touching: Float32Array, isVehicle?: boolean,
   *           radius?: number, push?: number, step?: number } | null} [contacts]
   *   Per-slot ground contacts (feet / paws / wheels). When set, no body-centre
   *   trail. radius/push/step override the foot/vehicle stamp defaults so each
   *   pawn's footprint matches its shape (capsule body width, dog paws, ruts).
   */
  function tick(px, pz, grounded, contacts = null) {
    _shiftTrailCenter(px, pz);
    stampCount = 0;

    if (contacts) {
      if (grounded) _processContacts(contacts);
      else prevSlotXZ.fill(NaN);
    } else if (grounded) {
      if (Number.isFinite(prevXZ.x)) {
        _pushSegment(prevXZ.x, prevXZ.y, px, pz, params.stampPush, params.stampRadius);
      } else {
        _pushStamp(px, pz, params.stampPush, params.stampRadius);
      }
      prevXZ.set(px, pz);
    } else {
      prevXZ.set(px, pz);
    }

    if (shiftDirty || stampCount > 0 || params.regrowRate > 0) {
      _runTrailPass();
    }

    u.uTrailCenter.value.copy(trailCenter);
  }

  /** Reset trail to neutral (call when exiting play mode). */
  function resetTrail() {
    _clearRT(rts[0], TRAIL_NEUT);
    _clearRT(rts[1], TRAIL_NEUT);
    _clearRT(blurTmpRT, 0);
    _clearRT(blurRT, 0);
    _clearRT(blurCoarseRT, 0);
    _clearRT(blurCoarse2RT, 0);
    rtIdx = 0;
    trailDispNode.value = rts[0].texture;
    trailCenter.set(0, 0);
    pendingShift.set(0, 0);
    shiftDirty = false;
    prevXZ.set(NaN, NaN);
    prevSlotXZ.fill(NaN);
    stampCount = 0;
  }

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
    passMat.dispose();
    blurFineQuadA.material.dispose();
    blurFineQuadB.material.dispose();
    blurCoarseQuadA.material.dispose();
    blurCoarseQuadB.material.dispose();
    rts[0].dispose();
    rts[1].dispose();
    blurTmpRT.dispose();
    blurRT.dispose();
    blurCoarseRT.dispose();
    blurCoarse2RT.dispose();
  }

  /** Debug: current trail RT (read side) — lets tools inspect stamp coverage. */
  function getTrailRT() {
    return rts[rtIdx];
  }

  return {
    shared,
    mesh,
    params,
    u,
    getTrailRT,
    setHeightTex,
    setSnowMaskTex,
    setPlayMode,
    setDeformActive,
    setVisible,
    updateSunDir,
    updateAnchor,
    tick,
    resetTrail,
    dispose,
  };
}
