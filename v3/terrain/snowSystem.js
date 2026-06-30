/**
 * Snow deformation system for V3 — ported from v2/snow-lab.html.
 *
 * Core idea: a small, high-subdivision plane mesh follows the player.
 * Its vertex shader lifts each vertex to terrain_height + snow_depth.
 * A GPU ping-pong render-target records deformation stamps (footprints,
 * wheel tracks) and blurs them every frame for an organic look.
 *
 * API:
 *   createSnowSystem(renderer, scene, initialHeightTex)
 *     → { tick, setHeightTex, setPlayMode, updateSunDir, updateAnchor, params, dispose }
 *
 * Call setHeightTex(heightTexNode.value) once after sculptBrush initialises,
 * then tick(px, pz, grounded, contacts?) every frame while in play mode.
 * contacts: { xzs: Float32Array(8), touching: Float32Array(4), isVehicle? }
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn, Loop,
  cameraPosition,
  cross, float, floor, int, max, min, mix,
  modelViewMatrix,
  positionGeometry, positionWorld,
  reflect, smoothstep, step,
  texture, uniform, uniformArray, uv,
  varying, vec2, vec3, vec4,
  mx_noise_float,
} from "three/tsl";
import { WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

// ── Constants ────────────────────────────────────────────────────────────────
const TRAIL_RES  = 512;   // trail render-target resolution (px)
const TRAIL_NEUT = 0.5;   // neutral (untouched) value in the RT
const MAX_STAMPS = 48;    // max stamp disks per frame (cars need headroom)

const TILE_SIZE    = 50;  // matches trailWorldSize — full RT window has vertices
const TILE_HALF    = TILE_SIZE * 0.5;
const SUBDIVISIONS = 256; // ~0.2 m/vertex — medium quality, ~75% fewer tris than 512
const TILE_FEATHER = 10;  // metres — height blend at deform-tile border

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

  // ── Ping-pong trail render-targets ─────────────────────────────────────────
  function _makeRT() {
    const rt = new THREE.RenderTarget(TRAIL_RES, TRAIL_RES, {
      format:          THREE.RGBAFormat,
      type:            THREE.UnsignedByteType,
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

    // 5-tap cross blur — smooths deformation edges, gives organic look
    const px = float(1.0 / TRAIL_RES);
    const sC = texture(trailSrcNode, srcUV.clamp(0, 1)).r;
    const sR = texture(trailSrcNode, srcUV.add(vec2(px,       float(0))).clamp(0, 1)).r;
    const sL = texture(trailSrcNode, srcUV.sub(vec2(px,       float(0))).clamp(0, 1)).r;
    const sU = texture(trailSrcNode, srcUV.add(vec2(float(0), px      )).clamp(0, 1)).r;
    const sD = texture(trailSrcNode, srcUV.sub(vec2(float(0), px      )).clamp(0, 1)).r;
    const sampled = sC.mul(0.5).add(sR.add(sL).add(sU).add(sD).mul(0.125));
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

  // ── Snow material uniforms ─────────────────────────────────────────────────
  const u = {
    uAnchor:          uniform(new THREE.Vector2(0, 0)),
    uTileHalf:        uniform(TILE_HALF),
    uBaseDepth:       uniform(params.baseDepth),
    uNoiseFreq1:      uniform(params.noiseFreq1),
    uNoiseFreq2:      uniform(params.noiseFreq2),
    uNoiseAmp:        uniform(params.noiseAmp),
    uTrailCenter:     uniform(new THREE.Vector2(0, 0)),
    uTrailWorldSize:  uniform(params.trailWorldSize),
    uGrooveScale:     uniform(params.grooveScale),
    uRimScale:        uniform(params.rimScale),
    uRimOffset:       uniform(params.rimOffset),
    uCavityStrength:  uniform(params.cavityStrength),
    uRoughnessDip:    uniform(params.roughnessDip),
    uGlitterIntensity:uniform(params.glitterIntensity),
    uGlitterScarcity: uniform(params.glitterScarcity),
    uGlitterFreq:     uniform(params.glitterFreq),
    uSunDir:          uniform(new THREE.Vector3(0, 1, 0)),
    uSlopeStartY:     uniform(params.slopeStartY),
    uSlopeRejectY:    uniform(params.slopeRejectY),
    uTileFeather:     uniform(TILE_FEATHER),
  };

  // Heightmap texture node — .value swappable via setHeightTex()
  const heightNode = texture(initialHeightTex);

  // Snow coverage mask — single-channel [0,1].  Default 1×1 white → visible everywhere.
  // Call setSnowMaskTex(snowMap.tex) to restrict snow to painted areas.
  const _defMaskData = new Uint8Array([0]);   // black = no snow until painted
  const _defMaskTex  = new THREE.DataTexture(_defMaskData, 1, 1, THREE.RedFormat);
  _defMaskTex.needsUpdate = true;
  const snowMaskNode = texture(_defMaskTex);

  // ── Snow TSL material ──────────────────────────────────────────────────────
  const mat = new THREE.MeshStandardNodeMaterial({
    transparent:        true,
    alphaTest:          0.02,
    roughness:          0.93,
    metalness:          0,
    polygonOffset:      true,
    polygonOffsetFactor:-2,   // pulls deform tile in front of static layer
    polygonOffsetUnits: -2,
  });
  mat.envMapIntensity = 0.6;

  // ── Shared TSL helpers ────────────────────────────────────────────────────

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

  // Undisturbed snow depth (no trail) — shared by static mesh and deform edge blend
  const snowDepthUndisturbed = Fn(([wxz]) => {
    const p1    = vec3(wxz.x.mul(u.uNoiseFreq1), float(0), wxz.y.mul(u.uNoiseFreq1));
    const p2    = vec3(wxz.x.mul(u.uNoiseFreq2), float(0), wxz.y.mul(u.uNoiseFreq2));
    const noise = mx_noise_float(p1).mul(0.5).add(0.5)
                   .mul(mx_noise_float(p2).mul(0.5).add(0.5))
                   .mul(u.uNoiseAmp);
    return u.uBaseDepth.add(noise).max(float(0.01));
  });

  // 0 at deform-tile border, 1 deep inside — height blend (full feather width)
  const deformTileBlend = Fn(([wxz]) => {
    const adx = wxz.x.sub(u.uAnchor.x).abs();
    const adz = wxz.y.sub(u.uAnchor.y).abs();
    const distToEdge = min(u.uTileHalf.sub(adx), u.uTileHalf.sub(adz));
    return smoothstep(float(0), u.uTileFeather, distToEdge);
  });

  // Terrain height (metres) sampled from the GPU heightmap at world XZ
  const getTerrainH = Fn(([wxz]) => {
    const hUV = wxz.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE)).clamp(0, 1);
    return texture(heightNode, hUV).r.mul(float(MAX_HEIGHT));
  });

  // Terrain-only normal for slope rejection.  Snow depth is intentionally excluded:
  // steep cliffs reject snow even before any trail or rim deformation is applied.
  const terrainNormal = Fn(([wxz, eps]) => {
    const hA = getTerrainH(wxz);
    const hX = getTerrainH(wxz.add(vec2(eps, float(0))));
    const hZ = getTerrainH(wxz.add(vec2(float(0), eps.negate())));
    const pA = vec3(wxz.x, hA, wxz.y);
    const pX = vec3(wxz.x.add(eps), hX, wxz.y);
    const pZ = vec3(wxz.x, hZ, wxz.y.sub(eps));
    return cross(pX.sub(pA).normalize(), pZ.sub(pA).normalize()).normalize();
  });

  const slopeMask = Fn(([wxz]) => {
    return smoothstep(u.uSlopeRejectY, u.uSlopeStartY, terrainNormal(wxz, float(2.0)).y);
  });

  // Snow depth at world XZ — base layer (no rim, used for TBN neighbour samples)
  // Uses Bruno Simon's multiplicative approach: snow × (1 − compression).
  const snowDepthBase = Fn(([wxz]) => {
    const p1    = vec3(wxz.x.mul(u.uNoiseFreq1), float(0), wxz.y.mul(u.uNoiseFreq1));
    const p2    = vec3(wxz.x.mul(u.uNoiseFreq2), float(0), wxz.y.mul(u.uNoiseFreq2));
    const noise = mx_noise_float(p1).mul(0.5).add(0.5)
                   .mul(mx_noise_float(p2).mul(0.5).add(0.5))
                   .mul(u.uNoiseAmp);

    const tuv    = trailUVfn(wxz).clamp(0, 1);
    const tMask  = trailEdgeFade(trailUVfn(wxz));
    const tR     = texture(trailDispNode, tuv).r;
    const comp   = neutral.sub(tR).max(0).mul(float(1.0 / TRAIL_NEUT));
    const trackH = float(1).sub(comp.mul(u.uGrooveScale).clamp(0, 1));
    // Clamp 1 cm minimum — prevents z-fighting with terrain when fully pressed
    return u.uBaseDepth.add(noise).mul(mix(float(1), trackH, tMask)).max(float(0.01));
  });

  // Snow depth with rim ridge pushed up around track edges
  const snowDepthFull = Fn(([wxz]) => {
    const base   = snowDepthBase(wxz);
    const tuv    = trailUVfn(wxz).clamp(0, 1);
    const tMask  = trailEdgeFade(trailUVfn(wxz));
    const rimOff = u.uRimOffset.div(u.uTrailWorldSize);

    const cH = neutral.sub(texture(trailDispNode, tuv).r).max(0).mul(float(1.0 / TRAIL_NEUT));
    const cR = neutral.sub(texture(trailDispNode, tuv.add(vec2(rimOff,  float(0))).clamp(0, 1)).r).max(0).mul(float(1.0 / TRAIL_NEUT));
    const cL = neutral.sub(texture(trailDispNode, tuv.sub(vec2(rimOff,  float(0))).clamp(0, 1)).r).max(0).mul(float(1.0 / TRAIL_NEUT));
    const cU = neutral.sub(texture(trailDispNode, tuv.add(vec2(float(0), rimOff )).clamp(0, 1)).r).max(0).mul(float(1.0 / TRAIL_NEUT));
    const cD = neutral.sub(texture(trailDispNode, tuv.sub(vec2(float(0), rimOff )).clamp(0, 1)).r).max(0).mul(float(1.0 / TRAIL_NEUT));
    const edgeFactor = cR.max(cL).max(cU).max(cD).sub(cH).max(0);
    const rim        = edgeFactor.mul(u.uRimScale).mul(u.uBaseDepth).mul(tMask);
    return base.add(rim);
  });

  const vTileBlend = varying(float(1), "snow_tb");

  // ── Vertex: terrain-conforming position + TBN normal ──────────────────────
  mat.positionNode = Fn(() => {
    const lxz   = positionGeometry.xz;
    const wxz   = lxz.add(u.uAnchor);

    const tileBlend = deformTileBlend(wxz);
    vTileBlend.assign(tileBlend);

    const sA = mix(snowDepthUndisturbed(wxz),  snowDepthFull(wxz),  tileBlend);
    const yA = getTerrainH(wxz).add(sA);

    const maskUV = wxz.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE)).clamp(0, 1);
    const painted = step(float(0.02), texture(snowMaskNode, maskUV).r.mul(slopeMask(wxz)));
    return vec3(lxz.x, mix(float(-9999), yA, painted), lxz.y);
  })();

  // Use the same per-pixel heightmap normal strategy as terrainLOD. Interpolated
  // geometry normals show the dense snow mesh as tiny tiles under grazing light.
  mat.normalNode = modelViewMatrix
    .mul(vec4(terrainNormal(positionWorld.xz, float(2.0)), float(0)))
    .xyz.normalize();

  // ── Fragment: color / roughness / sparkle ─────────────────────────────────
  // positionWorld.xz in fragment = positionGeometry.xz + mesh.position.xz = world XZ
  const wXZ         = positionWorld.xz;
  const fragTUV     = wXZ.sub(u.uTrailCenter).div(u.uTrailWorldSize).add(0.5).clamp(0, 1);
  const fragTrail   = texture(trailDispNode, fragTUV).r;
  const compression = neutral.sub(fragTrail).max(0).mul(float(1.0 / TRAIL_NEUT));

  const snowBase   = vec3(float(0.88), float(0.93), float(0.98));   // pristine: cool blue-white
  const packedSnow = vec3(float(0.60), float(0.66), float(0.76));   // packed: blue-grey
  const cavity     = float(1).sub(compression.mul(u.uCavityStrength));
  const snowColor  = mix(snowBase, packedSnow, compression.mul(u.uCavityStrength).clamp(0, 1));

  // Micro-facet sparkle: hash each crystal cell, mirror sun direction into view
  const mfCell  = floor(wXZ.mul(u.uGlitterFreq));
  const h1      = mx_noise_float(vec3(mfCell.x, float(0),    mfCell.y).mul(float(0.193)));
  const h2      = mx_noise_float(vec3(mfCell.x, float(17.3), mfCell.y).mul(float(0.251)));
  const mfN     = vec3(h1.sub(0.5).mul(0.6), float(1.0), h2.sub(0.5).mul(0.6)).normalize();
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const refl    = reflect(u.uSunDir.negate(), mfN);
  const specDot = refl.dot(viewDir).clamp(0, 1);
  // Very tight lobe (pow 1500) → sub-pixel crystal flash; disabled in packed zones
  const sparkle = specDot.pow(float(1500.0)).mul(u.uGlitterIntensity).mul(float(1).sub(compression));

  // Softer ambient shimmer (noise-based)
  const gp      = wXZ.mul(float(0.3));
  const gn      = mx_noise_float(vec3(gp.x, float(0), gp.y)).mul(0.5).add(0.5);
  const shimmer = gn.pow(u.uGlitterScarcity).mul(u.uGlitterIntensity.mul(0.4));

  const deformColor = snowColor.mul(cavity);
  const deformRough = float(0.93).sub(compression.mul(u.uRoughnessDip)).clamp(0.65, 1.0);
  const deformEmit  = vec3(
    sparkle.add(shimmer),
    sparkle.add(shimmer),
    sparkle.add(shimmer.mul(0.8)),
  );

  mat.colorNode     = mix(snowBase, deformColor, vTileBlend);
  mat.roughnessNode = mix(float(0.93), deformRough, vTileBlend);
  mat.emissiveNode  = deformEmit.mul(vTileBlend);
  mat.alphaNode     = vTileBlend;

  // ── Deformation tile mesh (50 m, high-res, play mode only) ──────────────
  const geo = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE, SUBDIVISIONS, SUBDIVISIONS);
  geo.rotateX(-Math.PI * 0.5);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.renderOrder   = 1;    // renders above the terrain snow overlay
  mesh.visible       = false;
  scene.add(mesh);
  let playModeActive = false;
  let deformActive = false;

  // ── Grid snap step (matches terrain grid sub-division) ────────────────────
  const _gridStep = TILE_SIZE / SUBDIVISIONS;   // 0.25 m

  // ── Public API ────────────────────────────────────────────────────────────

  /** Swap to a different heightmap GPU texture (e.g. after loading a save). */
  function setHeightTex(tex) {
    heightNode.value = tex;
  }

  /** Set the painted snow coverage map.  Pass snowMap.tex from SnowMap. */
  function setSnowMaskTex(tex) {
    snowMaskNode.value = tex;
  }

  /**
   * Play mode: terrain material shows static snow; deform tile handles only local
   * snow depth + grooves so the ball stays visible in trenches (lab-like).
   */
  function setPlayMode(on) {
    playModeActive = !!on;
    mesh.visible = playModeActive && deformActive;
  }

  function setDeformActive(on) {
    deformActive = !!on;
    mesh.visible = playModeActive && deformActive;
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

  return {
    mesh,
    params,
    u,
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
