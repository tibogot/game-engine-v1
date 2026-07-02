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
  Fn, Loop,
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
const MAX_STAMPS = 48;    // max stamp disks per frame (cars need headroom)

const TILE_SIZE      = 50;  // matches trailWorldSize — full RT window has vertices
const TILE_HALF      = TILE_SIZE * 0.5;
const SUBDIVISIONS   = 256; // ~0.2 m/vertex — medium quality, ~75% fewer tris than 512
const TILE_FEATHER   = 10;  // metres — terrain↔tile displacement hand-off width
const TILE_EDGE_FADE = 2;   // metres — opacity fade over the coincident border strip

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

// ── Main factory ─────────────────────────────────────────────────────────────
export function createSnowSystem(renderer, scene, initialHeightTex) {
  const params = { ...SNOW_PARAMS_DEFAULTS };

  // Shared surface definition — also handed to the terrain LOD material.
  const shared = createSnowShared(initialHeightTex, params);
  shared.u.uTileHalf.value    = TILE_HALF;
  shared.u.uTileFeather.value = TILE_FEATHER;

  // ── Ping-pong trail render-targets ─────────────────────────────────────────
  function _makeRT() {
    const rt = new THREE.RenderTarget(TRAIL_RES, TRAIL_RES, {
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

  function _clearRT(rt) {
    const prevRT  = renderer.getRenderTarget();
    const prevCol = new THREE.Color();
    renderer.getClearColor(prevCol);
    const prevA   = renderer.getClearAlpha();
    renderer.setClearColor(new THREE.Color(TRAIL_NEUT, TRAIL_NEUT, TRAIL_NEUT), 1);
    renderer.setRenderTarget(rt);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevCol, prevA);
  }

  const rts = [_makeRT(), _makeRT()];
  _clearRT(rts[0]);
  _clearRT(rts[1]);
  let rtIdx = 0;  // current read index

  // TSL texture nodes that get their .value swapped each frame
  const trailSrcNode  = texture(rts[0].texture);  // input to the pass shader
  const trailDispNode = texture(rts[0].texture);  // sampled by the snow material

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
    // Quintic stamp disks — smoother edges than cubic, no polygon stepping
    Loop({ start: int(0), end: int(MAX_STAMPS), type: "int", condition: "<" }, ({ i }) => {
      const active = i.lessThan(passU.uStampCount).select(float(1), float(0));
      const s      = passU.uStamps.element(i);
      const radius = s.z.max(float(1e-5));
      const push   = s.w.mul(active);
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

    const vehicle = isVehicle ?? (activeCount > 1);
    const radius  = vehicle ? params.stampRadius   : params.footRadius;
    const push    = vehicle ? params.stampPush      : params.footPush;
    const step    = vehicle ? params.stampStepWorld : params.footStepWorld;

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

    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevCol, prevA);

    rtIdx               = wi;
    trailDispNode.value = rts[wi].texture;
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
  };

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

  // ── Vertex: shared snow surface minus compression, plus rim ridge ─────────
  mat.positionNode = Fn(() => {
    const lxz   = positionGeometry.xz;
    const wxz   = lxz.add(u.uAnchor);
    const depth = shared.snowDepth(wxz);

    const cH   = compressionAt(wxz);
    const comp = cH.mul(u.uGrooveScale).clamp(0, 1);

    // Rim ridge: pushed-up snow around track edges, from the compression
    // gradient at ±rimOffset. Scales with local depth so thin snow at painted
    // edges gets a proportionally small rim.
    const cR = compressionAt(wxz.add(vec2(u.uRimOffset, float(0))));
    const cL = compressionAt(wxz.sub(vec2(u.uRimOffset, float(0))));
    const cU = compressionAt(wxz.add(vec2(float(0), u.uRimOffset)));
    const cD = compressionAt(wxz.sub(vec2(float(0), u.uRimOffset)));
    const edgeFactor = cR.max(cL).max(cU).max(cD).sub(cH).max(0);
    const rim        = edgeFactor.mul(u.uRimScale).mul(depth);

    const y = shared.getTerrainH(wxz)
      .add(depth.mul(float(1).sub(comp)))
      .add(rim);
    return vec3(lxz.x, y, lxz.y);
  })();

  // ── Fragment: per-pixel normal, shared shading, coverage opacity ──────────
  const wXZ = positionWorld.xz;

  const compRaw = compressionAt(wXZ);
  const compF   = compRaw.mul(u.uGrooveScale).clamp(0, 1);

  // Normal = analytic terrain normal + compression-gradient perturb (makes
  // prints read crisp and catch light even between vertices) + a small
  // high-frequency noise perturb so undisturbed snow isn't mirror-flat.
  const gEps = u.uTrailWorldSize.mul(float(1.5 / TRAIL_RES));
  const cGR  = compressionAt(wXZ.add(vec2(gEps, float(0))));
  const cGL  = compressionAt(wXZ.sub(vec2(gEps, float(0))));
  const cGU  = compressionAt(wXZ.add(vec2(float(0), gEps)));
  const cGD  = compressionAt(wXZ.sub(vec2(float(0), gEps)));
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

  // ── Deformation tile mesh (50 m, high-res, play mode only) ──────────────
  const geo = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE, SUBDIVISIONS, SUBDIVISIONS);
  geo.rotateX(-Math.PI * 0.5);

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

  // ── Grid snap step (matches terrain grid sub-division) ────────────────────
  const _gridStep = TILE_SIZE / SUBDIVISIONS;   // ~0.2 m

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

  /** Snap the snow tile to a grid aligned with vertex positions. */
  function updateAnchor(px, pz) {
    const ax = Math.round(px / _gridStep) * _gridStep;
    const az = Math.round(pz / _gridStep) * _gridStep;
    u.uAnchor.value.set(ax, az);
    mesh.position.set(ax, 0, az);
  }

  /**
   * @param {number} px
   * @param {number} pz
   * @param {boolean} grounded
   * @param {{ xzs: Float32Array, touching: Float32Array, isVehicle?: boolean } | null} [contacts]
   *   Per-slot ground contacts (feet / wheels). When set, no body-centre trail.
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
    _clearRT(rts[0]);
    _clearRT(rts[1]);
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
    rts[0].dispose();
    rts[1].dispose();
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
