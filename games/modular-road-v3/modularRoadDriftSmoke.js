import * as THREE from "three";

/**
 * Rear-wheel drift smoke for modular-road test drive.
 * Recreated from v2 play-mode DriftSmoke (camera-facing billboards, pooled
 * particles) — standalone, no v2 imports.
 */

export const DEFAULT_DRIFT_SMOKE_TEXTURE = "/textures/smoke.png";

export const DEFAULT_DRIFT_SMOKE_SETTINGS = {
  enabled: true,
  emitRate: 48,
  trigger: 0.04,
  opacity: 0.55,
  sizeMin: 0.55,
  sizeMax: 1.05,
  sizeGrowth: 2.6,
  lifeMin: 0.65,
  lifeMax: 1.45,
  rise: 0.75,
  spread: 0.55,
  drag: 0.12,
  color: "#6a6c76",
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
const SMOKE_COLOR_HEX = 0x6a6c76;

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
      p.velocity.multiplyScalar(Math.max(0, 1 - dt * 0.85));
      p.position.addScaledVector(p.velocity, dt);
      p.rotation += p.spin * dt;

      const size = p.size * (1 + age * (s.sizeGrowth ?? SIZE_GROWTH));
      const alpha = (s.opacity ?? OPACITY) * (1 - age) * (1 - age);
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
  }

  _writeParticle(index, center, size, rotation, alpha) {
    _smokeTint.setHex(SMOKE_COLOR_HEX);
    if (this.settings.color) _smokeTint.set(this.settings.color);

    const half = size * 0.5;
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const posOffset = index * FLOATS_PER_PARTICLE;
    const colorOffset = index * COLOR_FLOATS_PER_PARTICLE;
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];

    for (let i = 0; i < VERTS_PER_PARTICLE; i++) {
      const x = corners[i][0];
      const y = corners[i][1];
      const rx = (x * cosR - y * sinR) * half;
      const ry = (x * sinR + y * cosR) * half;
      _smokeHalfRight.copy(_smokeRight).multiplyScalar(rx);
      _smokeHalfUp.copy(_smokeUp).multiplyScalar(ry);
      _smokeCorner.copy(center).add(_smokeHalfRight).add(_smokeHalfUp);

      const po = posOffset + i * 3;
      this.positions[po] = _smokeCorner.x;
      this.positions[po + 1] = _smokeCorner.y;
      this.positions[po + 2] = _smokeCorner.z;

      const co = colorOffset + i * 4;
      this.colors[co] = _smokeTint.r;
      this.colors[co + 1] = _smokeTint.g;
      this.colors[co + 2] = _smokeTint.b;
      this.colors[co + 3] = alpha;
    }
  }
}
