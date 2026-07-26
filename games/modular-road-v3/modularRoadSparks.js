// ============================================================================
// GUARDRAIL SPARKS — bright short-lived streaks where the chassis scrapes a
// solid (guardrail, tunnel wall, ramp cheek).
//
// PERF SHAPE, which is the whole reason this is its own file rather than more
// particles bolted onto the smoke:
//
//   • ONE mesh, ONE draw call, ONE material, for every spark on screen.
//   • A fixed pool (no allocation after construction) written into a
//     pre-allocated interleaved buffer, exactly like the tire marks and smoke.
//   • `setDrawRange` to the live count, so dead sparks cost nothing — an idle
//     lap costs a single `visible = false`.
//   • No texture. A spark is a bright streak; a quad with a vertex-colour ramp
//     does that better than a sampled sprite AND skips the sampler entirely
//     (v3 is near the Windows WebGPU 16-sampler cap — see the terrain notes).
//
// Sparks are VELOCITY-STRETCHED rather than round: a spark is a hot particle
// moving fast enough to smear across the frame, so the quad is oriented along
// its own velocity and stretched by its speed. Round sparks read as embers.
//
// They are also ADDITIVE and unlit — a spark emits light, it does not receive
// it — and they write no depth, so they never occlude each other or the car.
// ============================================================================
import * as THREE from "three";
import { output } from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

export const DEFAULT_SPARK_SETTINGS = {
  enabled: true,
  /** Sparks per second at full scrape. */
  emitRate: 150,
  /** Minimum closing/scraping speed (m/s) that produces anything at all. */
  minSpeed: 2.5,
  /** Speed (m/s) at which the shower is at full rate. */
  fullSpeed: 22,
  lifeMin: 0.18,
  lifeMax: 0.5,
  /** Metres of streak per m/s of spark speed. */
  stretch: 0.05,
  width: 0.035,
  /** Launch speed away from the surface. */
  speedMin: 5,
  speedMax: 14,
  gravity: 22,
  drag: 1.6,
  /** Sparks bounce off the road once — real ones skitter, and it doubles the
   *  apparent count for the cost of one dot product. */
  bounce: 0.35,
  colorHot: "#fff6d0",
  colorCool: "#ff6a12",
  intensity: 3.2,
};

const POOL = 220;
const VERTS = 6;
const POS_F = VERTS * 3;
const COL_F = VERTS * 4;

const _hot = new THREE.Color();
const _cool = new THREE.Color();
const _tint = new THREE.Color();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _bit = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
/** Quad corners as (alongVelocity, acrossVelocity). */
const _CORNERS = [
  [-1, -1], [1, -1], [-1, 1],
  [1, -1], [1, 1], [-1, 1],
];

export class ModularRoadSparks {
  constructor(scene, settings = DEFAULT_SPARK_SETTINGS) {
    this.settings = settings;

    const positions = new Float32Array(POOL * POS_F);
    const colors = new Float32Array(POOL * COL_F);
    const geometry = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(positions, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", pa);
    const ca = new THREE.BufferAttribute(colors, 4);
    ca.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("color", ca);
    geometry.setDrawRange(0, 0);

    // Additive + no depth write: sparks are emitters, they must not occlude.
    // toneMapped false keeps them above the bloom threshold instead of being
    // compressed into the same grey as everything else.
    const material = new THREE.MeshBasicNodeMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    // BLOOM SOURCE IS `output`, NOT `materialEmissive`.
    //
    // `materialEmissive` is a reference to `material.emissive`, and an UNLIT
    // material has no such property — the uniform resolves to undefined and the
    // renderer dies reading `.r` off it:
    //   TypeError: Cannot read properties of undefined (reading 'r')
    //     at NodeUniformsGroup.updateColor
    // It works everywhere else in this project because every other caller is a
    // MeshStandardNodeMaterial. The unlit ones (collectibles, the neon road)
    // all pass an explicit node for exactly this reason.
    //
    // `output` — the material's final fragment colour — is also the RIGHT node
    // here: a spark's emission IS its colour, so the bloom picks up the per
    // particle hot-white→orange ramp instead of one flat tint.
    applyBloomMRT(material, output);

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false; // one mesh spanning the whole track
    this.mesh.renderOrder = 24;      // over the smoke
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.positions = positions;
    this.colors = colors;
    this.geometry = geometry;
    this.material = material;
    this.particles = Array.from({ length: POOL }, () => ({
      life: 0, maxLife: 1,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      groundY: -1e9,
      bounced: false,
    }));
    this.emitIndex = 0;
    this.emitAccum = 0;
  }

  reset() {
    for (const p of this.particles) p.life = 0;
    this.emitAccum = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  /**
   * @param {import("../../v3/play/modularRoadVehicle.js").Vehicle} vehicle
   * @param {THREE.Camera} camera
   * @param {number} dt
   */
  updateFromVehicle(vehicle, camera, dt) {
    const s = this.settings;
    let emit = 0;
    // LATCHED contact, not the raw per-tick flag. `hitSolid` is true for a single
    // 120 Hz tick, and projection response clears the penetration immediately, so
    // a continuous rail scrape is really an on/off flicker at tick rate. Sampling
    // that once per 60 Hz frame caught a fraction of it — which is exactly why
    // the sparks looked intermittent. `scraping` holds across the flicker.
    if (s.enabled !== false && vehicle?.enabled && vehicle.scraping) {
      // Scrape speed is computed vehicle-side now (tangent to the surface, with
      // impact speed as a floor for a head-on hit).
      const speed = vehicle.scrapeSpeed;
      if (speed > s.minSpeed) {
        emit = THREE.MathUtils.clamp(
          (speed - s.minSpeed) / Math.max(0.01, s.fullSpeed - s.minSpeed), 0, 1,
        );
      }
    }

    if (emit > 0) {
      this.emitAccum += s.emitRate * emit * dt;
      const n = vehicle.scrapeNormal;
      const p = vehicle.scrapePoint;
      const groundY = vehicle.body.pos.y - 0.6;
      while (this.emitAccum >= 1) {
        this._emit(p, n, vehicle.body.vel, emit, groundY);
        this.emitAccum -= 1;
      }
    } else {
      this.emitAccum = 0;
    }

    this.update(dt, camera);
  }

  _emit(point, normal, carVel, intensity, groundY) {
    const s = this.settings;
    const p = this.particles[this.emitIndex];
    this.emitIndex = (this.emitIndex + 1) % POOL;

    p.pos.copy(point);
    // Spray OUT of the surface, biased backwards along the car's travel — a
    // scrape throws its sparks behind the contact, not radially.
    const sp = THREE.MathUtils.lerp(s.speedMin, s.speedMax, Math.random()) * (0.5 + intensity * 0.5);
    _dir.copy(normal).multiplyScalar(0.6 + Math.random() * 0.5);
    _dir.x += (Math.random() - 0.5) * 0.9;
    _dir.y += Math.random() * 0.8;
    _dir.z += (Math.random() - 0.5) * 0.9;
    _dir.normalize();
    p.vel.copy(_dir).multiplyScalar(sp).addScaledVector(carVel, -0.18);
    p.maxLife = THREE.MathUtils.lerp(s.lifeMin, s.lifeMax, Math.random());
    p.life = p.maxLife;
    p.groundY = groundY;
    p.bounced = false;
  }

  update(dt, camera) {
    const s = this.settings;
    camera.updateMatrixWorld();
    _toCam.setFromMatrixPosition(camera.matrixWorld);

    _hot.set(s.colorHot);
    _cool.set(s.colorCool);

    let alive = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;

      p.vel.y -= s.gravity * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - s.drag * dt));
      p.pos.addScaledVector(p.vel, dt);

      // One skitter off the deck. Cheap, and it is most of what makes a shower
      // read as sparks rather than a firework.
      if (!p.bounced && p.pos.y < p.groundY && p.vel.y < 0) {
        p.pos.y = p.groundY;
        p.vel.y = -p.vel.y * s.bounce;
        p.vel.x *= 0.7; p.vel.z *= 0.7;
        p.bounced = true;
      }

      const age = 1 - p.life / p.maxLife;
      // Hot white → orange as it cools, and fades out on a curve so the tail of
      // the shower thins instead of all vanishing together.
      _tint.copy(_hot).lerp(_cool, age * age);
      const a = (1 - age) * s.intensity;
      this._write(alive++, p, a, s);
    }

    const verts = alive * VERTS;
    this.geometry.setDrawRange(0, verts);
    this.mesh.visible = verts > 0;
    if (verts > 0) {
      const pa = this.geometry.attributes.position;
      pa.addUpdateRange(0, alive * POS_F);
      pa.needsUpdate = true;
      const ca = this.geometry.attributes.color;
      ca.addUpdateRange(0, alive * COL_F);
      ca.needsUpdate = true;
    }
  }

  /** Velocity-aligned, speed-stretched quad facing the camera. */
  _write(index, p, alpha, s) {
    const speed = p.vel.length();
    // Along = direction of travel; across = perpendicular to it AND to the view
    // ray, which is what keeps a stretched quad facing the camera.
    if (speed > 1e-4) _tan.copy(p.vel).multiplyScalar(1 / speed);
    else _tan.set(0, 1, 0);
    _side.copy(_toCam).sub(p.pos);
    _bit.crossVectors(_tan, _side);
    if (_bit.lengthSq() < 1e-8) _bit.set(1, 0, 0); else _bit.normalize();

    const half = (s.width + speed * s.stretch) * 0.5;
    const wide = s.width * 0.5;
    const po = index * POS_F;
    const co = index * COL_F;

    for (let i = 0; i < VERTS; i++) {
      const u = _CORNERS[i][0];
      const v = _CORNERS[i][1];
      _a.copy(_tan).multiplyScalar(u * half);
      _b.copy(_bit).multiplyScalar(v * wide);
      const x = p.pos.x + _a.x + _b.x;
      const y = p.pos.y + _a.y + _b.y;
      const z = p.pos.z + _a.z + _b.z;
      const o = po + i * 3;
      this.positions[o] = x;
      this.positions[o + 1] = y;
      this.positions[o + 2] = z;

      // Brightest at the leading tip, trailing off behind — a streak, not a bar.
      const lead = u > 0 ? 1 : 0.35;
      const c = co + i * 4;
      this.colors[c] = _tint.r * lead;
      this.colors[c + 1] = _tint.g * lead;
      this.colors[c + 2] = _tint.b * lead;
      this.colors[c + 3] = alpha * lead;
    }
  }
}
