import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  attribute, cameraFar, cameraNear, Discard, float, Fn, length, max, mix,
  perspectiveDepthToViewZ, positionView, saturate, screenUV, smoothstep,
  texture, uniform, uv, viewportDepthTexture,
} from "three/tsl";

/**
 * Rear-wheel drift smoke for modular-road test drive.
 *
 * Camera-facing billboards, pooled, one draw call. The SHAPE of each puff is
 * procedural (see `makeSmokeNoiseTexture`) rather than a sprite: there is no
 * smoke .png any more, and deliberately so.
 *
 * ── WHY THE SPRITE WENT AWAY ──────────────────────────────────────────────────
 * The old texture was a 3.6 KB featureless white gaussian. The eye reads "volume"
 * almost entirely from internal contrast at several scales, and a radial gradient
 * has none — so no amount of simulation tuning could make it look like anything
 * but a stack of grey dots. Three things replace it, and together they are most
 * of what separates this from the old look:
 *
 *   1. EROSION, not fading. Each puff's alpha is a threshold against a lumpy
 *      density field, and the threshold RISES over life. So a puff dissolves
 *      from its thin edges inward and breaks into wisps, the way smoke actually
 *      disperses, instead of uniformly dimming like a sprite on a fade curve.
 *      This is the single biggest contributor — more than the texture itself.
 *   2. A per-particle noise frame (random offset + scale, drifting slowly over
 *      life). Every puff therefore has its own silhouette AND churns internally,
 *      where before all 256 were the same circle at different rotations.
 *   3. SOFT DEPTH FADE against the scene depth buffer. Untouched, the quads
 *      intersect the road deck along a razor line, which is the single most
 *      obvious "these are cards" tell in the whole effect.
 *
 * Alongside those: many more, much thinner particles. Volumetric appearance comes
 * from accumulated overlap of near-transparent layers; the old settings had few,
 * thick layers, which is exactly the confetti look.
 */

/**
 * Scene depth grab, shared by every smoke system (there is only ever one, but a
 * ViewportTextureNode issues its own full-res framebuffer copy per render, so it
 * lives at module scope on principle — same reasoning as v3's water).
 */
const _sceneDepthTex = /*#__PURE__*/ viewportDepthTexture();

export const DEFAULT_DRIFT_SMOKE_SETTINGS = {
  enabled: true,
  emitRate: 150,
  trigger: 0.04,
  /**
   * Per-puff peak alpha. LOW on purpose. Density is meant to come from many
   * overlapping thin layers, not from a few opaque ones — at 0.5 (the old value)
   * you can pick out every individual quad.
   */
  opacity: 0.22,
  sizeMin: 0.42,
  sizeMax: 0.85,
  sizeGrowth: 3.4,
  lifeMin: 0.8,
  lifeMax: 1.9,
  rise: 0.75,
  spread: 0.55,
  drag: 0.12,
  /** Legacy flat tint. Only used if colorHot/colorCool are cleared. */
  color: "",

  // ── WHAT MAKES IT READ AS SMOKE RATHER THAN GREY SPRITES ──────────────────
  /**
   * Tyre smoke is DENSE and dark where it leaves the contact patch, and pales
   * as it expands and thins. A single flat tint is the main reason billboard
   * smoke looks like confetti — the puffs never change, so the eye reads them
   * as a repeating sprite instead of a dispersing volume.
   */
  colorHot: "#4a4a52",   // fresh at the contact patch
  colorCool: "#b4b8c2",  // thinned out and drifting
  /**
   * Per-particle brightness spread, ±fraction. Even with the hot→cool ramp,
   * two puffs of the same age are otherwise the exact same colour, which the
   * eye picks up as a repeat.
   */
  tintJitter: 0.12,
  /**
   * Fraction of life spent fading IN. Without it every particle appears at full
   * opacity, which pops visibly at the emitter — the single most obvious tell.
   */
  fadeIn: 0.15,
  /**
   * Swirl. Real smoke is turbulent; straight-line particles with drag look
   * ballistic. Applied as an ACCELERATION (not a position offset) so it
   * accumulates into curling paths instead of a uniform wobble.
   */
  turbulence: 1.5,
  /** Upward acceleration over life — hot rubber smoke keeps climbing rather
   *  than coasting to a stop under drag. */
  buoyancy: 0.55,
  /**
   * Directional shading, 0..1. Each billboard gets a brightness gradient across
   * it, aligned with the sun projected into the quad's own axes — so puffs are
   * lit on the sun side and shaded away from it. Costs nothing (the vertex
   * colours are already being written per corner) and is most of what separates
   * flat sprites from something that looks lit.
   */
  sunTint: 0.42,

  // ── SHAPE ─────────────────────────────────────────────────────────────────
  /**
   * Noise tiles across the quad. ~1 means the puff spans roughly one tile, so
   * the lobes are a quarter of the puff across — cauliflower, not static.
   * Higher gets wispier and busier, lower gets blobbier.
   */
  noiseScale: 1.0,
  /** Tiles/second the noise frame slides over a puff's life. This is the
   *  internal churn: 0 freezes each puff's pattern the moment it is born. */
  noiseDrift: 0.12,
  /** Erosion threshold at birth. Above ~0.3 puffs are born already ragged. */
  erodeStart: 0.06,
  /**
   * Erosion threshold at death. Must exceed peak density (~1.27) for a puff to
   * vanish completely on its own; the alpha tail covers it if not.
   */
  erodeEnd: 1.25,
  /** Width of the erosion ramp. Small = crisp torn edges, large = soft haze. */
  erodeSoft: 0.3,
  /**
   * Metres over which a puff fades out as it approaches whatever is behind it.
   * This is what stops the quads slicing the tarmac along a hard line. 0 off.
   */
  softDepth: 0.9,
};

/**
 * Pool size. 4× the old 256, which was SATURATED during a real drift (128
 * emits/s across both wheels × 1.9 s life ≈ 243 alive), meaning any lifetime
 * increase silently starved the emitter instead of lasting longer.
 */
const POOL_SIZE = 1024;
const VERTS_PER_PARTICLE = 6;
const FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 3;
const TINT_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 4;
const NOISE_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 4;
const UV_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 2;

const EMIT_RATE = 48;
const LIFE_MIN = 0.65;
const LIFE_MAX = 1.45;
const SIZE_MIN = 0.55;
const SIZE_MAX = 1.05;
const SIZE_GROWTH = 2.6;
const OPACITY = 0.55;
const RISE = 0.75;
const SPREAD = 0.55;
const SPEED_DRAG = 0.12;
const _smokeTint = new THREE.Color();
const _smokeHot = new THREE.Color();
const _smokeCool = new THREE.Color();
/** Sun direction (TOWARD the sun), fed in by the game. Identity = straight up. */
const _smokeSun = new THREE.Vector3(0, 1, 0);
const SMOKE_COLOR_HEX = 0x6a6c76;

/** Billboard corners as two triangles. Hoisted: this used to be rebuilt inside
 *  _writeParticle, i.e. seven array allocations per particle per frame (~1000/frame
 *  at a full pool) for a constant. */
const _CORNERS = [
  [-1, -1], [1, -1], [-1, 1],
  [1, -1], [1, 1], [-1, 1],
];

const ENTRY_SPEED = 8;
const INTENSITY_MIN = 0.04;
/** How much a tyre at its LONGITUDINAL limit smokes, vs a sideways slide. Lower
 *  than the mark's equivalent: a braking tyre scrubs a line but does not throw
 *  the cloud a drift does, and a full-strength puff under every stop reads as a
 *  car permanently on fire. 0 disables it. */
const BRAKE_SMOKE = 0.45;

const DRIFT_ANGLE_MIN = 0.1;
const MARK_Y_OFFSET = 0.045;

const _smokeRight = new THREE.Vector3();
const _smokeUp = new THREE.Vector3();
const _smokeCorner = new THREE.Vector3();
const _smokeHalfRight = new THREE.Vector3();
const _smokeHalfUp = new THREE.Vector3();
const _smokeUvs = [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1];

const _velHoriz = new THREE.Vector3();
const _chassisFwd = new THREE.Vector3();
const _rearContact0 = new THREE.Vector3();
const _rearContact1 = new THREE.Vector3();
const _scratchVel = new THREE.Vector3();
const _wheelFwd = new THREE.Vector3();
const _wheelRight = new THREE.Vector3();
const _rearPoints = [_rearContact0, _rearContact1];

// ─── Procedural puff shape ────────────────────────────────────────────────────

const NOISE_SIZE = 256;
/** Baked once, shared by every instance. ~10 ms, one time, 256 KB on the GPU. */
let _noiseTexture = null;

/** Integer hash → [0,1). Math.imul keeps the multiplies in 32-bit. */
function ihash(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/**
 * Value noise on a lattice that WRAPS at `period`. Tileability is not a nicety
 * here: puffs sample the texture at arbitrary offsets with RepeatWrapping, so a
 * non-tiling texture would put a visible seam through random puffs.
 */
function pvnoise(x, y, period, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period;
  const y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const n00 = ihash(x0, y0, seed);
  const n10 = ihash(x1, y0, seed);
  const n01 = ihash(x0, y1, seed);
  const n11 = ihash(x1, y1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/**
 * Billowy turbulence — sum of |2n-1|, inverted. The absolute value creases the
 * noise at every zero crossing, which is what gives smoke and cumulus their
 * cauliflower lobes; plain FBM is far too smooth and reads as fog.
 */
function billow(u, v, basePeriod, octaves, seed) {
  let amp = 1;
  let norm = 0;
  let sum = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * Math.abs(pvnoise(u * p, v * p, p, seed + o * 101) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return 1 - sum / norm;
}

/** Plain tileable FBM, used only for the fine edge fray. */
function fbm(u, v, basePeriod, octaves, seed) {
  let amp = 1;
  let norm = 0;
  let sum = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * pvnoise(u * p, v * p, p, seed + o * 71);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/**
 * R = coarse billow (the lobes), G = fine detail (the fray at the eroded edge).
 * Both are normalised across the whole image rather than by their theoretical
 * range: turbulence never reaches its bounds, so an analytic remap would waste
 * most of the 8 bits and the erosion thresholds would all bunch up.
 */
function makeSmokeNoiseTexture() {
  if (_noiseTexture) return _noiseTexture;
  const n = NOISE_SIZE;
  const coarse = new Float32Array(n * n);
  const fine = new Float32Array(n * n);
  let cMin = Infinity, cMax = -Infinity, fMin = Infinity, fMax = -Infinity;
  for (let y = 0; y < n; y++) {
    const v = y / n;
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const i = y * n + x;
      const c = billow(u, v, 4, 4, 1337);
      const f = fbm(u, v, 12, 3, 8501);
      coarse[i] = c;
      fine[i] = f;
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
      if (f < fMin) fMin = f;
      if (f > fMax) fMax = f;
    }
  }
  const cScale = 255 / Math.max(cMax - cMin, 1e-6);
  const fScale = 255 / Math.max(fMax - fMin, 1e-6);
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = (coarse[i] - cMin) * cScale;
    data[i * 4 + 1] = (fine[i] - fMin) * fScale;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // Data, not colour: an sRGB decode here would crush the low end of the
  // density field and shift every erosion threshold.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _noiseTexture = tex;
  return tex;
}

export class ModularRoadDriftSmoke {
  /**
   * @param {THREE.Scene} scene
   * @param {typeof DEFAULT_DRIFT_SMOKE_SETTINGS} [settings]
   */
  constructor(scene, settings = DEFAULT_DRIFT_SMOKE_SETTINGS) {
    this.settings = settings;

    const positions = new Float32Array(POOL_SIZE * FLOATS_PER_PARTICLE);
    const tints = new Float32Array(POOL_SIZE * TINT_FLOATS_PER_PARTICLE);
    const noise = new Float32Array(POOL_SIZE * NOISE_FLOATS_PER_PARTICLE);
    const uvs = new Float32Array(POOL_SIZE * UV_FLOATS_PER_PARTICLE);
    for (let i = 0; i < POOL_SIZE; i++) {
      uvs.set(_smokeUvs, i * UV_FLOATS_PER_PARTICLE);
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);
    // Named `aTint`, not `color`: a node material treats a `color` attribute as
    // the built-in vertex-colour slot, and this one is driven entirely by hand.
    const tintAttr = new THREE.BufferAttribute(tints, 4);
    tintAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aTint", tintAttr);
    const noiseAttr = new THREE.BufferAttribute(noise, 4);
    noiseAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aNoise", noiseAttr);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setDrawRange(0, 0);

    this.noiseMap = makeSmokeNoiseTexture();
    this.uSoftDepth = uniform(settings.softDepth ?? 0.9);
    this.uErodeSoft = uniform(Math.max(0.01, settings.erodeSoft ?? 0.3));

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    material.colorNode = attribute("aTint", "vec4").xyz;
    material.opacityNode = this._buildOpacityNode();

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.positions = positions;
    this.tints = tints;
    this.noise = noise;
    this.geometry = geometry;
    this.material = material;
    this.particles = Array.from({ length: POOL_SIZE }, () => ({
      life: 0,
      maxLife: 1,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      size: 1,
      rotation: 0,
      spin: 0,
      turbPhase: 0,
      turbFreq: 3,
      noiseU: 0,
      noiseV: 0,
      noiseDu: 0,
      noiseDv: 0,
      noiseScale: 1,
      tintMul: 1,
    }));
    this.emitIndex = 0;
    this.emitAccum = [0, 0];
  }

  /**
   * Alpha = erosion threshold against a lumpy density field, then a soft depth
   * fade. Everything colour-side is precomputed per particle on the CPU and
   * arrives in `aTint`, so this stays the only per-pixel work.
   */
  _buildOpacityNode() {
    const st = uv();
    const tint = attribute("aTint", "vec4");
    /** xy = noise frame offset, z = noise tiles per quad, w = erosion threshold. */
    const nParams = attribute("aNoise", "vec4");
    const softDepth = this.uSoftDepth;
    const erodeSoft = this.uErodeSoft;
    const noiseMap = this.noiseMap;

    return Fn(() => {
      // Round soft mask. Written as 1-smoothstep rather than a reversed-edge
      // smoothstep because WGSL leaves edge0 > edge1 undefined.
      const r = length(st.sub(0.5)).mul(2);
      const falloff = float(1).sub(smoothstep(0.22, 1.0, r));

      const n = texture(noiseMap, st.mul(nParams.z).add(nParams.xy));
      // Coarse lobes carry the shape; a little fine detail keeps the torn edge
      // from looking like a smooth contour line of the coarse field.
      const detail = mix(n.r, n.g, 0.35);
      const density = falloff.mul(float(0.32).add(detail.mul(0.95)));

      // The threshold rises over life (CPU side), so the puff erodes away from
      // its thin edges inward instead of dimming uniformly.
      const thresh = nParams.w;
      const alpha = smoothstep(thresh, thresh.add(erodeSoft), density)
        .mul(tint.w)
        .toVar();

      // Soft particles: fade as the quad approaches whatever is behind it, so
      // the billboard never shows a hard intersection line with the tarmac.
      const sceneDist = perspectiveDepthToViewZ(
        _sceneDepthTex.sample(screenUV).r, cameraNear, cameraFar,
      ).negate();
      const fragDist = positionView.z.negate();
      alpha.mulAssign(saturate(sceneDist.sub(fragDist).div(max(softDepth, float(1e-3)))));

      // Most of a puff's quad is eroded away; discarding those pixels is worth
      // real time when ~600 large overlapping quads are on screen.
      Discard(alpha.lessThan(0.003));
      return alpha;
    })();
  }

  reset() {
    for (const p of this.particles) p.life = 0;
    this.emitAccum[0] = 0;
    this.emitAccum[1] = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  /**
   * @param {import("./modularRoadVehicle.js").Vehicle} vehicle
   * @param {THREE.Camera} camera
   * @param {number} dt
   * @param {Record<string, boolean>} [keys]
   */
  updateFromVehicle(vehicle, camera, dt, keys = {}) {
    if (!vehicle?.enabled) {
      this.update(dt, _rearPoints, false, 0, 0, 0, camera);
      return;
    }

    const body = vehicle.body;
    _velHoriz.copy(body.vel);
    _velHoriz.y = 0;
    const speed = _velHoriz.length();

    _chassisFwd.set(0, 0, 1).applyQuaternion(body.quat);
    _chassisFwd.y = 0;
    if (_chassisFwd.lengthSq() > 1e-8) _chassisFwd.normalize();

    let driftAngle = 0;
    if (speed > 0.5 && _chassisFwd.lengthSq() > 1e-8) {
      driftAngle = Math.acos(
        THREE.MathUtils.clamp(_velHoriz.dot(_chassisFwd) / speed, -1, 1),
      );
    }

    const driftAmount = THREE.MathUtils.clamp(
      (driftAngle - DRIFT_ANGLE_MIN) / 0.5,
      0,
      1,
    );
    const handbrake = !!keys.Space || !!vehicle.input?.handbrake;
    const handbrakeAmount = handbrake
      ? THREE.MathUtils.smoothstep(speed, ENTRY_SPEED, ENTRY_SPEED * 2.2)
      : 0;

    let rearSlip = 0;
    let rearOver = 0;
    let rearIdx = 0;
    let hasRear = false;
    for (const tire of vehicle.tires) {
      if (tire.canSteer) continue;
      const contact = rearIdx === 0 ? _rearContact0 : _rearContact1;
      if (tire.grounded) {
        hasRear = true;
        contact.copy(tire.hitPoint).addScaledVector(tire.hitNormal, MARK_Y_OFFSET);
        body.getVelocityAtPoint(tire.worldPos, _scratchVel);
        _wheelFwd.set(0, 0, 1).applyQuaternion(body.quat);
        _wheelRight.set(1, 0, 0).applyQuaternion(body.quat);
        const vLat = Math.abs(_scratchVel.dot(_wheelRight));
        const vLong = Math.abs(_scratchVel.dot(_wheelFwd));
        rearSlip = Math.max(rearSlip, vLat / Math.max(vLong, 3.5));
        rearOver = Math.max(rearOver, tire.overDemand ?? 0);
      } else if (rearIdx === 0) {
        _rearContact0.set(0, -9999, 0);
      } else {
        _rearContact1.set(0, -9999, 0);
      }
      rearIdx++;
    }

    const slipAmount = THREE.MathUtils.clamp(rearSlip * 0.85, 0, 1);
    // Hard braking smokes too — see the matching note in modularRoadTireMarks.js.
    // Every other term here measures LATERAL slip, so a straight-line stop showed
    // nothing at all. `tire.overDemand` is the same measurement in the other axis:
    // how far past its grip the tyre's longitudinal demand went.
    const brakeAmount = BRAKE_SMOKE > 0
      ? THREE.MathUtils.clamp(rearOver * BRAKE_SMOKE, 0, 1)
        * THREE.MathUtils.smoothstep(speed, ENTRY_SPEED, ENTRY_SPEED * 2)
      : 0;
    const driftIntensity = Math.max(driftAmount, handbrakeAmount, slipAmount, brakeAmount);
    const inAir = vehicle.groundedCount === 0;
    const s = this.settings;
    const trigger = s.trigger ?? INTENSITY_MIN;
    const emitSmoke =
      hasRear &&
      !inAir &&
      speed > ENTRY_SPEED * 0.55 &&
      (driftIntensity > trigger ||
        (handbrake && speed > ENTRY_SPEED * 0.55));
    const smokeIntensity = Math.max(driftIntensity, handbrake ? 0.45 : 0);

    this.update(
      dt,
      hasRear ? _rearPoints : [],
      emitSmoke,
      smokeIntensity,
      body.vel.x,
      body.vel.z,
      camera,
    );
  }

  update(dt, rearPoints, emit, intensity, velocityX, velocityZ, camera) {
    const s = this.settings;
    if (s.enabled === false) emit = false;
    this.uSoftDepth.value = Math.max(1e-3, s.softDepth ?? 0.9);
    this.uErodeSoft.value = Math.max(0.01, s.erodeSoft ?? 0.3);

    if (emit) {
      const emitRate =
        (s.emitRate ?? EMIT_RATE) * THREE.MathUtils.clamp(intensity, 0, 1);
      for (let i = 0; i < rearPoints.length; i++) {
        const point = rearPoints[i];
        if (!point || point.y < -9000) continue;
        this.emitAccum[i] += emitRate * dt;
        while (this.emitAccum[i] >= 1) {
          this.emitAt(point, intensity, velocityX, velocityZ);
          this.emitAccum[i] -= 1;
        }
      }
    } else {
      this.emitAccum[0] = 0;
      this.emitAccum[1] = 0;
    }

    camera.updateMatrixWorld();
    _smokeRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    _smokeUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

    const erodeStart = s.erodeStart ?? 0.06;
    const erodeEnd = s.erodeEnd ?? 1.25;
    const noiseDrift = s.noiseDrift ?? 0.12;

    let alive = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;

      const age = 1 - p.life / p.maxLife;

      // Turbulence as ACCELERATION so it integrates into a curling path. Each
      // particle carries its own phase/frequency, otherwise the whole plume
      // swirls in lockstep and reads as a single wobbling sheet.
      const turb = s.turbulence ?? 0;
      if (turb > 0) {
        const t = (p.maxLife - p.life) * p.turbFreq + p.turbPhase;
        p.velocity.x += Math.sin(t) * turb * dt;
        p.velocity.z += Math.cos(t * 1.37) * turb * dt;
        p.velocity.y += Math.sin(t * 0.73) * turb * 0.35 * dt;
      }
      p.velocity.y += (s.buoyancy ?? 0) * dt;

      p.velocity.multiplyScalar(Math.max(0, 1 - dt * 0.85));
      p.position.addScaledVector(p.velocity, dt);
      p.rotation += p.spin * dt;

      // Turbulent diffusion widens fast then slows, so growth goes as √age
      // rather than linearly — a linear ramp makes puffs look like inflating
      // balloons, all expanding at the same steady rate.
      const size = p.size * (1 + Math.sqrt(age) * (s.sizeGrowth ?? SIZE_GROWTH));

      // Fade IN over the first slice of life. The fade OUT is mostly the erosion
      // threshold below; this tail only guarantees a clean zero at death for
      // whatever erode settings are dialled in.
      const fadeIn = s.fadeIn ?? 0;
      const rampIn = fadeIn > 0 ? Math.min(1, age / fadeIn) : 1;
      const alpha = (s.opacity ?? OPACITY) * rampIn * Math.pow(1 - age, 0.6);

      // Dense/dark fresh → pale/thin as it disperses.
      if (s.colorHot && s.colorCool) {
        _smokeHot.set(s.colorHot);
        _smokeCool.set(s.colorCool);
        _smokeTint.copy(_smokeHot).lerp(_smokeCool, Math.sqrt(age));
      } else {
        _smokeTint.setHex(SMOKE_COLOR_HEX);
        if (s.color) _smokeTint.set(s.color);
      }
      _smokeTint.multiplyScalar(p.tintMul);

      // Erosion eats in from the thin edges, slowly at first: age^1.3 keeps the
      // puff coherent while it is still being thrown off the tyre, then opens it
      // up as it drifts. A linear ramp starts shredding it immediately.
      const elapsed = p.maxLife - p.life;
      const thresh = erodeStart + (erodeEnd - erodeStart) * Math.pow(age, 1.3);

      this._writeParticle(
        alive++, p.position, size, p.rotation, alpha, thresh,
        p.noiseU + p.noiseDu * elapsed * noiseDrift,
        p.noiseV + p.noiseDv * elapsed * noiseDrift,
        p.noiseScale,
      );
    }

    const vertCount = alive * VERTS_PER_PARTICLE;
    this.geometry.setDrawRange(0, vertCount);
    this.mesh.visible = vertCount > 0;
    if (vertCount > 0) {
      const posAttr = this.geometry.attributes.position;
      posAttr.addUpdateRange(0, alive * FLOATS_PER_PARTICLE);
      posAttr.needsUpdate = true;
      const tintAttr = this.geometry.attributes.aTint;
      tintAttr.addUpdateRange(0, alive * TINT_FLOATS_PER_PARTICLE);
      tintAttr.needsUpdate = true;
      const noiseAttr = this.geometry.attributes.aNoise;
      noiseAttr.addUpdateRange(0, alive * NOISE_FLOATS_PER_PARTICLE);
      noiseAttr.needsUpdate = true;
    }
  }

  emitAt(point, intensity, velocityX, velocityZ) {
    const s = this.settings;
    const p = this.particles[this.emitIndex];
    this.emitIndex = (this.emitIndex + 1) % POOL_SIZE;

    const speed = Math.hypot(velocityX, velocityZ);
    const dirX = speed > 1e-4 ? velocityX / speed : 0;
    const dirZ = speed > 1e-4 ? velocityZ / speed : 0;
    const sideJitter = (Math.random() - 0.5) * (s.spread ?? SPREAD);
    p.position.set(
      point.x - dirX * (0.12 + Math.random() * 0.25) + sideJitter * dirZ,
      point.y + 0.02 + Math.random() * 0.1,
      point.z - dirZ * (0.12 + Math.random() * 0.25) - sideJitter * dirX,
    );
    p.velocity.set(
      -dirX * speed * (s.drag ?? SPEED_DRAG) + (Math.random() - 0.5) * 0.45,
      (s.rise ?? RISE) * (0.65 + Math.random() * 0.7),
      -dirZ * speed * (s.drag ?? SPEED_DRAG) + (Math.random() - 0.5) * 0.45,
    );

    const lifeMin = Math.max(0.05, s.lifeMin ?? LIFE_MIN);
    const lifeMax = Math.max(lifeMin, s.lifeMax ?? LIFE_MAX);
    p.maxLife = THREE.MathUtils.lerp(lifeMin, lifeMax, Math.random());
    p.life = p.maxLife;

    const sizeMin = Math.max(0.01, s.sizeMin ?? SIZE_MIN);
    const sizeMax = Math.max(sizeMin, s.sizeMax ?? SIZE_MAX);
    p.size =
      THREE.MathUtils.lerp(sizeMin, sizeMax, Math.random()) *
      THREE.MathUtils.lerp(0.75, 1.25, THREE.MathUtils.clamp(intensity, 0, 1));
    p.rotation = Math.random() * Math.PI * 2;
    p.spin = (Math.random() - 0.5) * 1.7;
    // Per-particle swirl. Without an independent phase AND frequency the whole
    // plume oscillates together, which reads as one wobbling sheet rather than
    // turbulence.
    p.turbPhase = Math.random() * Math.PI * 2;
    p.turbFreq = 2.2 + Math.random() * 3.4;

    // A random window into the tiling noise: this is what gives every puff its
    // own silhouette. The drift direction then churns that window over life.
    p.noiseU = Math.random() * 8;
    p.noiseV = Math.random() * 8;
    const driftAngle = Math.random() * Math.PI * 2;
    p.noiseDu = Math.cos(driftAngle);
    p.noiseDv = Math.sin(driftAngle);
    p.noiseScale = (s.noiseScale ?? 1) * (0.78 + Math.random() * 0.55);
    const jitter = s.tintJitter ?? 0;
    p.tintMul = 1 + (Math.random() - 0.5) * 2 * jitter;
  }

  /** Sun direction, pointing TOWARD the sun. Drives the per-billboard gradient. */
  setSunDirection(v) {
    if (v && v.lengthSq() > 1e-8) _smokeSun.copy(v).normalize();
  }

  /** `_smokeTint` is set by the caller (age ramp) before this runs. */
  _writeParticle(index, center, size, rotation, alpha, thresh, nu, nv, nScale) {
    const half = size * 0.5;
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const posOffset = index * FLOATS_PER_PARTICLE;
    const tintOffset = index * TINT_FLOATS_PER_PARTICLE;
    const noiseOffset = index * NOISE_FLOATS_PER_PARTICLE;

    // FAKE DIRECTIONAL LIGHTING. The billboard has no normals to light, but it
    // does have two known axes — so project the sun onto them and shade ACROSS
    // the quad. The sun-facing edge brightens, the far edge darkens, and a flat
    // sprite starts reading as a lit volume. 0.7071 normalises the unit-square
    // corner directions.
    const sunTint = this.settings.sunTint ?? 0;
    const sr = sunTint > 0 ? _smokeSun.dot(_smokeRight) * 0.7071 : 0;
    const su = sunTint > 0 ? _smokeSun.dot(_smokeUp) * 0.7071 : 0;

    for (let i = 0; i < VERTS_PER_PARTICLE; i++) {
      const x = _CORNERS[i][0];
      const y = _CORNERS[i][1];
      const rx = (x * cosR - y * sinR) * half;
      const ry = (x * sinR + y * cosR) * half;
      _smokeHalfRight.copy(_smokeRight).multiplyScalar(rx);
      _smokeHalfUp.copy(_smokeUp).multiplyScalar(ry);
      _smokeCorner.copy(center).add(_smokeHalfRight).add(_smokeHalfUp);

      const po = posOffset + i * 3;
      this.positions[po] = _smokeCorner.x;
      this.positions[po + 1] = _smokeCorner.y;
      this.positions[po + 2] = _smokeCorner.z;

      // Corner direction is the UNROTATED (x, y): the texture rotates with the
      // quad but the lighting must stay fixed in world space.
      const lit = 1 + sunTint * (x * sr + y * su);
      const to = tintOffset + i * 4;
      this.tints[to] = _smokeTint.r * lit;
      this.tints[to + 1] = _smokeTint.g * lit;
      this.tints[to + 2] = _smokeTint.b * lit;
      this.tints[to + 3] = alpha;

      const no = noiseOffset + i * 4;
      this.noise[no] = nu;
      this.noise[no + 1] = nv;
      this.noise[no + 2] = nScale;
      this.noise[no + 3] = thresh;
    }
  }
}
