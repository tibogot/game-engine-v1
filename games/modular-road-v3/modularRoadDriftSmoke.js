import * as THREE from "three";

/**
 * Rear-wheel drift smoke for modular-road test drive.
 * Recreated from v2 play-mode DriftSmoke (camera-facing billboards, pooled
 * particles) — standalone, no v2 imports.
 */

export const DEFAULT_DRIFT_SMOKE_TEXTURE = "/textures/smoke.png";

export const DEFAULT_DRIFT_SMOKE_SETTINGS = {
  enabled: true,
  emitRate: 64,
  trigger: 0.04,
  opacity: 0.5,
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
};

const POOL_SIZE = 256;
const VERTS_PER_PARTICLE = 6;
const FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 3;
const COLOR_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 4;
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

export class ModularRoadDriftSmoke {
  /**
   * @param {THREE.Scene} scene
   * @param {typeof DEFAULT_DRIFT_SMOKE_SETTINGS} [settings]
   * @param {string} [textureUrl]
   */
  constructor(scene, settings = DEFAULT_DRIFT_SMOKE_SETTINGS, textureUrl = DEFAULT_DRIFT_SMOKE_TEXTURE) {
    this.settings = settings;

    const positions = new Float32Array(POOL_SIZE * FLOATS_PER_PARTICLE);
    const colors = new Float32Array(POOL_SIZE * COLOR_FLOATS_PER_PARTICLE);
    const uvs = new Float32Array(POOL_SIZE * UV_FLOATS_PER_PARTICLE);
    for (let i = 0; i < POOL_SIZE; i++) {
      uvs.set(_smokeUvs, i * UV_FLOATS_PER_PARTICLE);
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);
    const colorAttr = new THREE.BufferAttribute(colors, 4);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", colorAttr);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setDrawRange(0, 0);

    const map = new THREE.TextureLoader().load(
      textureUrl,
      undefined,
      undefined,
      (err) => console.warn("[modular-road] drift smoke texture failed:", textureUrl, err),
    );
    map.colorSpace = THREE.SRGBColorSpace;

    const material = new THREE.MeshBasicMaterial({
      map,
      color: 0xffffff,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.positions = positions;
    this.colors = colors;
    this.geometry = geometry;
    this.material = material;
    this.map = map;
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
    }));
    this.emitIndex = 0;
    this.emitAccum = [0, 0];
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
      } else if (rearIdx === 0) {
        _rearContact0.set(0, -9999, 0);
      } else {
        _rearContact1.set(0, -9999, 0);
      }
      rearIdx++;
    }

    const slipAmount = THREE.MathUtils.clamp(rearSlip * 0.85, 0, 1);
    const driftIntensity = Math.max(driftAmount, handbrakeAmount, slipAmount);
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

      // Fade IN over the first slice of life, then the quadratic fade out.
      const fadeIn = s.fadeIn ?? 0;
      const rampIn = fadeIn > 0 ? Math.min(1, age / fadeIn) : 1;
      const alpha = (s.opacity ?? OPACITY) * rampIn * (1 - age) * (1 - age);

      // Dense/dark fresh → pale/thin as it disperses.
      if (s.colorHot && s.colorCool) {
        _smokeHot.set(s.colorHot);
        _smokeCool.set(s.colorCool);
        _smokeTint.copy(_smokeHot).lerp(_smokeCool, Math.sqrt(age));
      } else {
        _smokeTint.setHex(SMOKE_COLOR_HEX);
        if (s.color) _smokeTint.set(s.color);
      }

      this._writeParticle(alive++, p.position, size, p.rotation, alpha);
    }

    const vertCount = alive * VERTS_PER_PARTICLE;
    this.geometry.setDrawRange(0, vertCount);
    this.mesh.visible = vertCount > 0;
    if (vertCount > 0) {
      const posAttr = this.geometry.attributes.position;
      posAttr.addUpdateRange(0, alive * FLOATS_PER_PARTICLE);
      posAttr.needsUpdate = true;
      const colorAttr = this.geometry.attributes.color;
      colorAttr.addUpdateRange(0, alive * COLOR_FLOATS_PER_PARTICLE);
      colorAttr.needsUpdate = true;
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
  }

  /** Sun direction, pointing TOWARD the sun. Drives the per-billboard gradient. */
  setSunDirection(v) {
    if (v && v.lengthSq() > 1e-8) _smokeSun.copy(v).normalize();
  }

  /** `_smokeTint` is set by the caller (age ramp) before this runs. */
  _writeParticle(index, center, size, rotation, alpha) {
    const half = size * 0.5;
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const posOffset = index * FLOATS_PER_PARTICLE;
    const colorOffset = index * COLOR_FLOATS_PER_PARTICLE;

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
      const co = colorOffset + i * 4;
      this.colors[co] = _smokeTint.r * lit;
      this.colors[co + 1] = _smokeTint.g * lit;
      this.colors[co + 2] = _smokeTint.b * lit;
      this.colors[co + 3] = alpha;
    }
  }
}
