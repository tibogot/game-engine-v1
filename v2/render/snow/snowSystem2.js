/**
 * snowSystem2.js — Procedural snow v2
 *
 * Drop-in replacement for SnowSystem. Identical public API so main.js only
 * needs a one-flag swap (`toolState.snow.v2Mode = true`).
 *
 * Key differences from v1:
 *   • Fully procedural TSL surface — no photo PBR textures.
 *   • Bruno Simon multiplicative groove: snow × (1 − compression) — never
 *     goes negative regardless of groove depth.
 *   • GPU-side trail stamps via QuadMesh + quintic falloff + 5-tap blur.
 *   • Micro-facet hash sparkle on emissive (ACES tone-mapping blooms it).
 *   • Edge-based alpha (tile edges only) — groove never goes transparent.
 *   • Per-stamp previous-XZ tracking for smooth segment walking (4 wheels
 *     or 1 foot/body, auto-detected from active-slot count).
 *
 * NOT in v2 yet (same as day-1 v1 scope):
 *   • Painted snow-mask accumulation (this.mask is a no-op stub).
 *   • Altitude ramp / cliff slope rejection.
 *   • Per-foot IK stamps for the human character.
 */

import * as THREE from "three";
import {
  Fn, Loop,
  cameraPosition,
  cross, float, floor, int, max, min, mix,
  modelViewMatrix,
  positionGeometry, positionWorld,
  reflect, step,
  texture, uniform, uniformArray, uv,
  varying, vec2, vec3, vec4,
  mx_noise_float,
} from "three/tsl";
import { QuadMesh } from "three/webgpu";

// ── Constants ──────────────────────────────────────────────────────────────
const TRAIL_RES  = 512;    // trail render-target resolution (pixels)
const TRAIL_NEUT = 0.5;    // neutral (untouched) channel value
const MAX_STAMPS = 48;     // max stamp quads per frame (4 wheels × ~10 steps + slack)

export class SnowSystem2 {
  constructor({ scene, config }) {
    this._scene  = scene;
    this._config = config;

    this._group      = new THREE.Group();
    this._group.name = "SnowSystem2";
    scene.add(this._group);

    // Stub mask — callers that access snowSystem.mask get a valid no-op object.
    // Full painted-accumulation support can be added later without API changes.
    this.mask = { exportData: () => null, importData: () => {} };

    // ── Trail GPU state ────────────────────────────────────────────────────
    this._trailRTs      = [null, null];
    this._trailIdx      = 0;
    this._trailSrcNode  = null;
    this._trailDispNode = null;
    this._trailPassQuad = null;
    this._trailPassU    = null;
    this._stampVecs     = Array.from({ length: MAX_STAMPS }, () => new THREE.Vector4());
    this._stampCount    = 0;
    this._trailCenter   = new THREE.Vector2(0, 0);
    this._pendingShift  = new THREE.Vector2(0, 0);
    this._shiftDirty    = false;

    // Per-slot previous XZ for segment walking: 4 wheels × (x,z) = 8 floats.
    // NaN signals "no previous position yet" — emit point stamp on first touch.
    this._prevXZs       = new Float32Array(8).fill(NaN);
    this._prevChassisXZ = new THREE.Vector2(NaN, NaN);

    // ── Snow mesh ──────────────────────────────────────────────────────────
    this._mesh       = null;
    this._geo        = null;
    this._mat        = null;
    this._uSnow      = null;
    this._built      = false;
    this._renderer   = null;
    this._tileSize   = 60;
    this._subdivisions = 384;
    this._sunDir     = new THREE.Vector3(0, 1, 0);
  }

  // ── Public property ────────────────────────────────────────────────────────
  get group() { return this._group; }

  // ── Public API (matches SnowSystem exactly) ────────────────────────────────

  /**
   * One-time setup. heightTex and windTex are accepted for API compatibility
   * but not used — v2 generates its surface procedurally.
   */
  async init(renderer, _heightTex, _windTex, toolState, _opts = {}) {
    this._renderer  = renderer;
    this._toolState = toolState;
    this._initTrailGPU(renderer);
  }

  async ensureBuilt(sp) {
    if (!this._built) await this.rebuild(sp);
  }

  async rebuild(sp) {
    // Remove previous mesh
    if (this._mesh) {
      this._group.remove(this._mesh);
      this._mesh = null;
    }
    this._geo?.dispose();
    this._mat?.dispose();

    this._tileSize     = sp.tileSize     ?? 60;
    this._subdivisions = sp.subdivisions ?? 384;

    if (!this._uSnow) {
      this._uSnow = this._buildUniforms(sp);
    } else {
      this._uSnow.uTileHalf.value = this._tileSize * 0.5;
      this.syncFromState(sp);
    }

    this._geo  = this._buildGeo(this._tileSize, this._subdivisions);
    this._mat  = this._buildMaterial(this._uSnow, this._trailDispNode);
    this._mesh = new THREE.Mesh(this._geo, this._mat);
    this._mesh.frustumCulled = false;
    this._mesh.receiveShadow = true;
    this._group.add(this._mesh);
    this._built = true;
  }

  /** Hot-sync uniform values from toolState.snow without rebuilding geometry. */
  syncFromState(sp) {
    if (!this._uSnow) return;
    const u = this._uSnow;
    u.uBaseDepth.value        = sp.baseDepth              ?? 0.30;
    u.uNoiseFreq1.value       = sp.noiseFreq1             ?? 0.06;
    u.uNoiseFreq2.value       = sp.noiseFreq2             ?? 0.14;
    u.uNoiseAmp.value         = sp.noiseAmp               ?? 0.12;
    u.uGrooveScale.value      = sp.grooveScale            ?? 1.0;
    u.uNormalShift.value      = sp.normalNeighbourShift   ?? 0.35;
    u.uTrailWorldSize.value   = sp.trailWorldSize         ?? 50;
    u.uRimScale.value         = sp.rimRidgeScale          ?? 0.14;
    u.uRimOffset.value        = sp.rimSampleOffset        ?? 0.55;
    u.uCavityStrength.value   = sp.trailAlbedoCavity      ?? 0.55;
    u.uRoughnessDip.value     = sp.trailRoughnessBoost    ?? 0.28;
    u.uGlitterIntensity.value = sp.glitterIntensity       ?? 2.0;
    u.uGlitterScarcity.value  = sp.glitterScarcity        ?? 250;
    u.uGlitterFreq.value      = sp.glitterFreq            ?? 200;
    if (sp.tileSize) u.uTileHalf.value = sp.tileSize * 0.5;
  }

  /** v2 is runtime-only — slope/cliff rejection is a future addition. */
  applyCliffSlope(_start, _end, _active) {}

  setEnabled(on) {
    this._group.visible = on;
  }

  async precompile(renderer, camera) {
    if (!this._mesh) return;
    await renderer.compileAsync(this._mesh, camera);
  }

  /**
   * Per-frame update. The optional 4th argument `sunDir` (THREE.Vector3,
   * world-space direction TOWARD the sun) keeps the micro-facet sparkle
   * aligned as the sun moves. Call as:
   *   snowSystem2.update(sp, focusPos, wheelData, sunDir)
   */
  update(sp, anchorPos, wheelData = null, sunDir = null) {
    if (!this._built || !this._mesh) return;

    if (sunDir && this._uSnow) this._uSnow.uSunDir.value.copy(sunDir);

    // Snap anchor to subdivision grid for stable UV lookups
    const gridStep = this._tileSize / this._subdivisions;
    const ax = Math.round(anchorPos.x / gridStep) * gridStep;
    const az = Math.round(anchorPos.z / gridStep) * gridStep;
    this._uSnow.uAnchor.value.set(ax, az);
    this._mesh.position.set(ax, 0, az);

    // Build stamps, update trail center, render pass
    const trailSize = sp.trailWorldSize ?? 100;
    this._updateTrailCenter(anchorPos.x, anchorPos.z, trailSize);
    this._stampCount = 0;
    if (wheelData) this._processWheelData(wheelData, sp);

    const needsPass = this._shiftDirty || this._stampCount > 0
                   || (sp.trailRegrowPerFrame ?? 0) > 0;
    if (needsPass) this._renderTrailPass(sp.trailRegrowPerFrame ?? 0);

    this._uSnow.uTrailCenter.value.copy(this._trailCenter);
  }

  dispose() {
    if (this._mesh) this._group.remove(this._mesh);
    this._geo?.dispose();
    this._mat?.dispose();
    this._trailRTs[0]?.dispose();
    this._trailRTs[1]?.dispose();
    this._trailPassQuad?.geometry?.dispose();
    this._built = false;
  }

  // ── Private: Trail GPU ─────────────────────────────────────────────────────

  _createTrailRT() {
    const rt = new THREE.RenderTarget(TRAIL_RES, TRAIL_RES, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });
    rt.texture.flipY = false;
    return rt;
  }

  _clearTrailRT(renderer, rt) {
    const savedRT = renderer.getRenderTarget();
    const saved   = new THREE.Color();
    renderer.getClearColor(saved);
    const savedA  = renderer.getClearAlpha();
    renderer.setClearColor(new THREE.Color(TRAIL_NEUT, TRAIL_NEUT, TRAIL_NEUT), 1);
    renderer.setRenderTarget(rt);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(savedRT);
    renderer.setClearColor(saved, savedA);
  }

  _initTrailGPU(renderer) {
    this._trailRTs[0] = this._createTrailRT();
    this._trailRTs[1] = this._createTrailRT();
    this._clearTrailRT(renderer, this._trailRTs[0]);
    this._clearTrailRT(renderer, this._trailRTs[1]);

    this._trailSrcNode  = texture(this._trailRTs[0].texture);
    this._trailDispNode = texture(this._trailRTs[0].texture);

    this._trailPassU = {
      uShiftUV:    uniform(new THREE.Vector2(0, 0)),
      uRegrow:     uniform(0),
      uStampCount: uniform(0),
      uStamps:     uniformArray(this._stampVecs, "vec4"),
    };
    const pu      = this._trailPassU;
    const neutral = float(TRAIL_NEUT);

    const passMat = new THREE.MeshBasicNodeMaterial();
    passMat.toneMapped = false;
    passMat.fog        = false;
    passMat.depthTest  = false;
    passMat.depthWrite = false;

    passMat.colorNode = Fn(() => {
      const uvHere = uv();
      const srcUV  = uvHere.add(pu.uShiftUV);
      const inBnds = step(float(0), srcUV.x).mul(step(srcUV.x, float(1)))
                    .mul(step(float(0), srcUV.y)).mul(step(srcUV.y, float(1)));

      // 5-tap cross blur on the source — smooths deformation edges each frame
      const px = float(1.0 / TRAIL_RES);
      const sC = texture(this._trailSrcNode, srcUV.clamp(0, 1)).r;
      const sR = texture(this._trailSrcNode, srcUV.add(vec2(px,       float(0))).clamp(0, 1)).r;
      const sL = texture(this._trailSrcNode, srcUV.sub(vec2(px,       float(0))).clamp(0, 1)).r;
      const sU = texture(this._trailSrcNode, srcUV.add(vec2(float(0), px      )).clamp(0, 1)).r;
      const sD = texture(this._trailSrcNode, srcUV.sub(vec2(float(0), px      )).clamp(0, 1)).r;
      const sampled = sC.mul(0.5).add(sR.add(sL).add(sU).add(sD).mul(0.125));
      const carried = mix(neutral, sampled, inBnds);
      const regrown = min(neutral, carried.add(pu.uRegrow));

      const val = regrown.toVar("val");
      // Quintic-falloff stamps: 6t⁵ − 15t⁴ + 10t³ (C² at both ends)
      Loop({ start: int(0), end: int(MAX_STAMPS), type: "int", condition: "<" }, ({ i }) => {
        const active = i.lessThan(pu.uStampCount).select(float(1), float(0));
        const s      = pu.uStamps.element(i);
        const ctr    = vec2(s.x, s.y);
        const radius = s.z.max(float(1e-5));
        const push   = s.w.mul(active);
        const d      = uvHere.distance(ctr);
        const t      = float(1).sub(d.div(radius)).clamp(0, 1);
        const tq     = t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));
        val.assign(max(float(0), val.sub(tq.mul(push))));
      });

      return vec4(val, val, val, float(1));
    })();

    this._trailPassQuad = new QuadMesh(passMat);
  }

  _renderTrailPass(regrowRate) {
    const ri = this._trailIdx;
    const wi = 1 - ri;
    this._trailSrcNode.value = this._trailRTs[ri].texture;
    this._trailPassU.uShiftUV.value.set(
      this._pendingShift.x / TRAIL_RES,
      this._pendingShift.y / TRAIL_RES,
    );
    this._trailPassU.uRegrow.value     = Math.max(0, regrowRate);
    this._trailPassU.uStampCount.value = this._stampCount;

    const savedRT = this._renderer.getRenderTarget();
    const saved   = new THREE.Color();
    this._renderer.getClearColor(saved);
    const savedA  = this._renderer.getClearAlpha();

    this._renderer.setRenderTarget(this._trailRTs[wi]);
    this._trailPassQuad.render(this._renderer);

    this._renderer.setRenderTarget(savedRT);
    this._renderer.setClearColor(saved, savedA);

    this._trailIdx            = wi;
    this._trailDispNode.value = this._trailRTs[wi].texture;
    this._pendingShift.set(0, 0);
    this._shiftDirty = false;
  }

  _updateTrailCenter(bx, bz, trailWorldSize) {
    const ts = trailWorldSize / (TRAIL_RES - 1);
    const nx = Math.round(bx / ts) * ts;
    const nz = Math.round(bz / ts) * ts;
    const dx = Math.round((nx - this._trailCenter.x) / ts);
    const dz = Math.round((nz - this._trailCenter.y) / ts);
    if (dx === 0 && dz === 0) { this._pendingShift.set(0, 0); return; }
    this._pendingShift.set(dx, dz);
    this._shiftDirty = true;
    this._trailCenter.set(nx, nz);
  }

  _pushStamp(wx, wz, push, radius, sz) {
    if (this._stampCount >= MAX_STAMPS) return;
    const u = (wx - this._trailCenter.x) / sz + 0.5;
    const v = (wz - this._trailCenter.y) / sz + 0.5;
    const r = radius / sz;
    if (u < -r || u > 1 + r || v < -r || v > 1 + r) return;
    this._stampVecs[this._stampCount].set(u, v, r, push);
    this._stampCount++;
  }

  _pushSegment(ax, az, bx, bz, push, radius, sz, stampStep) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) { this._pushStamp(bx, bz, push, radius, sz); return; }
    const steps = Math.max(1, Math.ceil(len / stampStep));
    for (let i = 0; i <= steps && this._stampCount < MAX_STAMPS; i++) {
      const t = i / steps;
      this._pushStamp(ax + dx * t, az + dz * t, push, radius, sz);
    }
  }

  _processWheelData(wd, sp) {
    const sz        = sp.trailWorldSize ?? 100;
    const stampStep = sp.trailStampStep ?? 0.15;

    // Auto-detect vehicle vs foot/body: vehicles have >1 active slot.
    let activeCount = 0;
    for (let i = 0; i < 4; i++) if (wd.wheelTouching[i] > 0) activeCount++;
    const isVehicle = activeCount > 1;

    const radius = isVehicle ? (sp.wheelRadius   ?? 0.4)  : (sp.v2FootRadius ?? 0.14);
    const push   = isVehicle
      ? (sp.wheelDepth ?? 0.5) * (sp.wheelPushScale ?? 0.6)
      : (sp.v2FootDepth ?? 0.5);

    // Per-slot stamps (wheels or feet/body in slot 0)
    for (let i = 0; i < 4; i++) {
      if (!wd.wheelTouching[i]) {
        // Slot left ground — reset so next contact starts fresh
        this._prevXZs[i * 2    ] = NaN;
        this._prevXZs[i * 2 + 1] = NaN;
        continue;
      }
      const cx = wd.wheelXZs[i * 2];
      const cz = wd.wheelXZs[i * 2 + 1];
      const px = this._prevXZs[i * 2];
      const pz = this._prevXZs[i * 2 + 1];
      if (Number.isFinite(px)) {
        this._pushSegment(px, pz, cx, cz, push, radius, sz, stampStep);
      } else {
        this._pushStamp(cx, cz, push, radius, sz);
      }
      this._prevXZs[i * 2    ] = cx;
      this._prevXZs[i * 2 + 1] = cz;
    }

    // Optional chassis body stamp (shallow wide crush, vehicle only)
    if (sp.chassisStampEnabled && wd.chassisTouching) {
      const cx  = wd.chassisXZ.x;
      const cz  = wd.chassisXZ.y;
      const cpx = this._prevChassisXZ.x;
      const cpz = this._prevChassisXZ.y;
      const cr   = sp.chassisRadius   ?? 1.2;
      const cpush = (sp.chassisDepth ?? 0.2) * (sp.chassisPushScale ?? 0.35);
      if (Number.isFinite(cpx)) {
        this._pushSegment(cpx, cpz, cx, cz, cpush, cr, sz, stampStep);
      } else {
        this._pushStamp(cx, cz, cpush, cr, sz);
      }
      this._prevChassisXZ.set(cx, cz);
    } else {
      this._prevChassisXZ.set(NaN, NaN);
    }
  }

  // ── Private: Uniforms ──────────────────────────────────────────────────────

  _buildUniforms(sp) {
    return {
      uAnchor:          uniform(new THREE.Vector2(0, 0)),
      uTileHalf:        uniform((sp.tileSize ?? 60) * 0.5),
      uBaseDepth:       uniform(sp.baseDepth              ?? 0.30),
      uNoiseFreq1:      uniform(sp.noiseFreq1             ?? 0.06),
      uNoiseFreq2:      uniform(sp.noiseFreq2             ?? 0.14),
      uNoiseAmp:        uniform(sp.noiseAmp               ?? 0.12),
      uTrailCenter:     uniform(new THREE.Vector2(0, 0)),
      uTrailWorldSize:  uniform(sp.trailWorldSize         ?? 50),
      uGrooveScale:     uniform(sp.grooveScale            ?? 1.0),
      uRimScale:        uniform(sp.rimRidgeScale          ?? 0.14),
      uRimOffset:       uniform(sp.rimSampleOffset        ?? 0.55),
      uNormalShift:     uniform(sp.normalNeighbourShift   ?? 0.35),
      uCavityStrength:  uniform(sp.trailAlbedoCavity      ?? 0.55),
      uRoughnessDip:    uniform(sp.trailRoughnessBoost    ?? 0.28),
      uGlitterIntensity:uniform(sp.glitterIntensity       ?? 2.0),
      uGlitterScarcity: uniform(sp.glitterScarcity        ?? 250),
      uGlitterFreq:     uniform(sp.glitterFreq            ?? 200),
      uSunDir:          uniform(new THREE.Vector3(0, 1, 0)),
    };
  }

  // ── Private: Geometry ──────────────────────────────────────────────────────

  _buildGeo(tileSize, subdivisions) {
    const g = new THREE.PlaneGeometry(tileSize, tileSize, subdivisions, subdivisions);
    g.rotateX(-Math.PI * 0.5);
    return g;
  }

  // ── Private: Material (fully procedural TSL) ───────────────────────────────

  _buildMaterial(u, trailTexNode) {
    const mat = new THREE.MeshStandardNodeMaterial({
      transparent: true,
      alphaTest: 0.05,
      roughness: 0.93,
      metalness: 0,
    });
    mat.envMapIntensity = 0.6;

    const neutral = float(TRAIL_NEUT);

    // Trail UV helper
    const trailUVfn = Fn(([wxz]) =>
      wxz.sub(u.uTrailCenter).div(u.uTrailWorldSize).add(0.5)
    );

    // Fade mask at the edges of the trail window (avoids hard clipping)
    const fadeEdgeMask = Fn(([tuv]) => {
      const fw  = float(0.04);
      const fuX = min(tuv.x.div(fw).clamp(0, 1), float(1).sub(tuv.x).div(fw).clamp(0, 1));
      const fuY = min(tuv.y.div(fw).clamp(0, 1), float(1).sub(tuv.y).div(fw).clamp(0, 1));
      return fuX.mul(fuY);
    });

    // ── Base snow height (no rim — used for TBN neighbour samples B/C) ──────
    const snowHeightBase = Fn(([wxz]) => {
      const p1 = vec3(wxz.x.mul(u.uNoiseFreq1), float(0), wxz.y.mul(u.uNoiseFreq1));
      const p2 = vec3(wxz.x.mul(u.uNoiseFreq2), float(0), wxz.y.mul(u.uNoiseFreq2));
      const n1 = mx_noise_float(p1).mul(0.5).add(0.5);
      const n2 = mx_noise_float(p2).mul(0.5).add(0.5);
      const noise = n1.mul(n2).mul(u.uNoiseAmp);

      const tuv          = trailUVfn(wxz).clamp(0, 1);
      const tMask        = fadeEdgeMask(trailUVfn(wxz));
      const tR           = texture(trailTexNode, tuv).r;
      const compression  = neutral.sub(tR).max(0).mul(float(1.0 / TRAIL_NEUT));
      // Bruno Simon multiplicative: snow × (1 − compression) — groove bounded by baseDepth
      const tracksHeight = float(1).sub(compression.mul(u.uGrooveScale).clamp(0, 1));
      const snowFull     = u.uBaseDepth.add(noise);
      // Clamp minimum to 1 cm — prevents z-fighting with ground when fully compressed
      return snowFull.mul(mix(float(1), tracksHeight, tMask)).max(float(0.01));
    });

    // ── Full height with rim ridge (actual displaced vertex A) ───────────────
    const snowHeightFull = Fn(([wxz]) => {
      const base   = snowHeightBase(wxz);
      const tuv    = trailUVfn(wxz).clamp(0, 1);
      const tMask  = fadeEdgeMask(trailUVfn(wxz));
      const rimOff = u.uRimOffset.div(u.uTrailWorldSize);

      const compHere = neutral.sub(texture(trailTexNode, tuv).r).max(0).mul(float(1.0 / TRAIL_NEUT));
      const compR    = neutral.sub(texture(trailTexNode, tuv.add(vec2(rimOff, float(0))).clamp(0, 1)).r).max(0).mul(float(1.0 / TRAIL_NEUT));
      const compL    = neutral.sub(texture(trailTexNode, tuv.sub(vec2(rimOff, float(0))).clamp(0, 1)).r).max(0).mul(float(1.0 / TRAIL_NEUT));
      const compU    = neutral.sub(texture(trailTexNode, tuv.add(vec2(float(0), rimOff)).clamp(0, 1)).r).max(0).mul(float(1.0 / TRAIL_NEUT));
      const compD    = neutral.sub(texture(trailTexNode, tuv.sub(vec2(float(0), rimOff)).clamp(0, 1)).r).max(0).mul(float(1.0 / TRAIL_NEUT));
      const compNbr  = compR.max(compL).max(compU).max(compD);
      // Rim height is proportional to snow depth so it scales with baseDepth
      const rim = compNbr.sub(compHere).max(0).mul(u.uRimScale).mul(u.uBaseDepth).mul(tMask);
      return base.add(rim);
    });

    // ── Varyings ─────────────────────────────────────────────────────────────
    const vNorm = varying(vec3(0, 1, 0), "v2_n");
    const vTang = varying(vec3(1, 0, 0), "v2_t");
    const vBitn = varying(vec3(0, 0, 1), "v2_b");

    // ── Vertex: displace + compute TBN from 3 surface samples ────────────────
    mat.positionNode = Fn(() => {
      const lxz   = positionGeometry.xz;
      const wxz   = lxz.add(u.uAnchor);
      const shift = u.uNormalShift;

      const yA = snowHeightFull(wxz);
      const yB = snowHeightBase(wxz.add(vec2(shift, float(0))));
      const yC = snowHeightBase(wxz.add(vec2(float(0), shift.negate())));

      const pA = vec3(wxz.x,            yA, wxz.y);
      const pB = vec3(wxz.x.add(shift), yB, wxz.y);
      const pC = vec3(wxz.x,            yC, wxz.y.sub(shift));
      const dU = pB.sub(pA).normalize();
      const dV = pC.sub(pA).normalize();
      const N  = cross(dU, dV).normalize();

      vNorm.assign(modelViewMatrix.mul(vec4(N,  float(0))).xyz.normalize());
      vTang.assign(modelViewMatrix.mul(vec4(dU, float(0))).xyz.normalize());
      vBitn.assign(modelViewMatrix.mul(vec4(dV, float(0))).xyz.normalize());

      return vec3(lxz.x, yA, lxz.y);
    })();

    // ── Alpha: tile-edge fade only — groove never goes transparent ────────────
    const _lxz    = positionWorld.xz.sub(u.uAnchor);
    const _th     = u.uTileHalf;
    const _margin = _th.mul(float(0.10));
    const _edgeX  = min(_lxz.x.add(_th), _th.sub(_lxz.x)).div(_margin).clamp(0, 1);
    const _edgeZ  = min(_lxz.y.add(_th), _th.sub(_lxz.y)).div(_margin).clamp(0, 1);
    mat.alphaNode  = _edgeX.mul(_edgeZ);

    mat.normalNode = vNorm;

    // ── Fragment: color + roughness + sparkle emissive ────────────────────────
    const fragTUV    = positionWorld.xz.sub(u.uTrailCenter).div(u.uTrailWorldSize).add(0.5).clamp(0, 1);
    const fragTrail  = texture(trailTexNode, fragTUV).r;
    const compression = neutral.sub(fragTrail).max(0).mul(float(1.0 / TRAIL_NEUT));

    const snowBase   = vec3(float(0.88), float(0.93), float(0.98));
    const packedSnow = vec3(float(0.60), float(0.66), float(0.76));
    const cavity     = float(1).sub(compression.mul(u.uCavityStrength));
    const snowColor  = mix(snowBase, packedSnow, compression.mul(u.uCavityStrength).clamp(0, 1));

    // Micro-facet hash sparkle — tiny random crystal cells that mirror the sun
    const mfCell  = floor(positionWorld.xz.mul(u.uGlitterFreq));
    const h1      = mx_noise_float(vec3(mfCell.x, float(0),    mfCell.y).mul(float(0.193)));
    const h2      = mx_noise_float(vec3(mfCell.x, float(17.3), mfCell.y).mul(float(0.251)));
    const mfN     = vec3(h1.sub(0.5).mul(0.6), float(1.0), h2.sub(0.5).mul(0.6)).normalize();
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const refl_   = reflect(u.uSunDir.negate(), mfN);
    const specDot = refl_.dot(viewDir).clamp(0, 1);
    // Tight lobe (~0.5° half-angle) for pinpoint crystal flashes
    const sparkle = specDot.pow(float(1500.0))
                          .mul(u.uGlitterIntensity)
                          .mul(float(1).sub(compression)); // no sparkle in ruts

    // Soft ambient shimmer (lower-frequency noise)
    const gp      = positionWorld.xz.mul(float(0.3));
    const gn      = mx_noise_float(vec3(gp.x, float(0), gp.y)).mul(0.5).add(0.5);
    const shimmer = gn.pow(u.uGlitterScarcity).mul(u.uGlitterIntensity.mul(0.4));

    mat.colorNode     = snowColor.mul(cavity);
    mat.roughnessNode = float(0.93).sub(compression.mul(u.uRoughnessDip)).clamp(0.65, 1.0);
    // ACES filmic naturally blooms emissive values above 1.0 — no extra pass needed
    mat.emissiveNode  = vec3(
      sparkle.add(shimmer),
      sparkle.add(shimmer),
      sparkle.add(shimmer.mul(0.8)),
    );

    return mat;
  }
}
