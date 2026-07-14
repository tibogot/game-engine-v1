// Rockets — GAME code. Visible, travelling projectiles with glowing exhaust
// trails, replacing the instant hitscan. Damage lands ON IMPACT, so you can see
// the shot cross the battlefield (and it can miss a dead target).
//
// Everything here is INSTANCED, not pooled-as-meshes: all rockets in flight are
// one draw call and the entire trail is one more, however heavy the battle gets.
// (This used to be 48 rocket Meshes + 220 puff Meshes, each drawn separately —
// a busy firefight was hundreds of draw calls on its own.)
import * as THREE from "three";
import { makeBloomMaterial, BLOOM } from "./bloom.js";
import { createSpriteField } from "./spriteField.js";

// Sizes are tuned for RTS zoom (camera ~150 m up). A "realistic" 0.2 m rocket is
// literally invisible from there — these are deliberately oversized so shots read.
const MAX_ROCKETS = 48;
const MAX_PUFFS = 220;
const PUFF_EVERY = 0.018; // seconds between trail puffs
const PUFF_LIFE = 0.5;
const ROCKET_R = 0.55;    // rocket radius
const ROCKET_L = 3.2;     // rocket length
const PUFF_SIZE = 2.6;    // trail puff quad

export function createProjectiles({ app, onImpact = () => {} }) {
  const { scene } = app;

  // ── Rocket bodies — one InstancedMesh for every rocket in flight ────────────
  const bodyMat = makeBloomMaterial(
    { color: 0xffe9a8, blending: THREE.AdditiveBlending }, BLOOM.muzzle,
  );
  // Capsule is built along Y; bake a rotation into the GEOMETRY so its long axis
  // is +Z — which is where a lookAt() quaternion points an object.
  const bodyGeo = new THREE.CapsuleGeometry(ROCKET_R, ROCKET_L, 4, 8).rotateX(Math.PI / 2);
  const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX_ROCKETS);
  bodyMesh.count = 0;
  bodyMesh.frustumCulled = false;
  scene.add(bodyMesh);

  const rockets = [];
  for (let i = 0; i < MAX_ROCKETS; i++) {
    rockets.push({
      alive: false, speed: 0,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      target: null, damage: 0, owner: null, puffT: 0, ttl: 0,
    });
  }

  // ── Exhaust trail — one instanced sprite field for the whole trail ──────────
  // Each puff now fades on its OWN (per-instance life), which the shared-material
  // mesh pool couldn't do — it had to fake dissipation by shrinking alone.
  const puffs = createSpriteField({
    scene, max: MAX_PUFFS, color: 0xff9a3c, size: PUFF_SIZE, bloomScale: BLOOM.tracer,
    scaleAt: (p) => 0.35 + p * 1.05,
  });

  const freeRocket = () => rockets.find((r) => !r.alive) ?? null;

  const _dir = new THREE.Vector3();
  const _aim = new THREE.Vector3();
  const _obj = new THREE.Object3D();
  const _look = new THREE.Vector3();

  /** Fire a rocket from `from` at `target` (a combatant). */
  function spawn(from, target, damage, owner, speed = 70) {
    const r = freeRocket();
    if (!r) return;
    r.alive = true;
    r.pos.copy(from);
    r.target = target;
    r.damage = damage;
    r.owner = owner;
    r.puffT = 0;
    r.ttl = 5; // safety: never live forever
    aimAt(r, target);
    r.speed = speed;
  }

  function targetPoint(t) {
    return _aim.set(
      t.position.x,
      t.position.y + (t.isStructure ? (t.typeKey === "base" ? 8 : 5) : 1.6),
      t.position.z,
    );
  }

  function aimAt(r, target) {
    const to = targetPoint(target);
    _dir.subVectors(to, r.pos).normalize();
    r.vel.copy(_dir);
  }

  function update(dt, camera) {
    let n = 0;

    for (const r of rockets) {
      if (!r.alive) continue;
      r.ttl -= dt;

      // Light homing so a rocket still connects with a moving unit.
      if (r.target?.alive) {
        const to = targetPoint(r.target);
        _dir.subVectors(to, r.pos).normalize();
        r.vel.lerp(_dir, Math.min(1, dt * 6)).normalize();
      }

      const step = r.speed * dt;
      r.pos.addScaledVector(r.vel, step);

      // Trail.
      r.puffT -= dt;
      if (r.puffT <= 0) {
        r.puffT = PUFF_EVERY;
        puffs.spawn(r.pos.x, r.pos.y, r.pos.z, PUFF_LIFE);
      }

      // Impact?
      let hit = false;
      if (r.target?.alive) {
        const to = targetPoint(r.target);
        if (r.pos.distanceTo(to) <= Math.max(2.2, step)) hit = true;
      }

      if (hit) {
        onImpact(r.target, r.damage, r.pos.clone(), r.owner);
        r.alive = false;
        continue;
      }
      if (r.ttl <= 0) {
        // Target died mid-flight (or we never connected) — fizzle out.
        r.alive = false;
        continue;
      }

      // Still flying: write its instance.
      _obj.position.copy(r.pos);
      _obj.lookAt(_look.copy(r.pos).add(r.vel));
      _obj.scale.setScalar(1);
      _obj.updateMatrix();
      bodyMesh.setMatrixAt(n, _obj.matrix);
      n++;
    }

    bodyMesh.count = n;
    bodyMesh.instanceMatrix.needsUpdate = true;

    puffs.update(dt, camera);
  }

  return { spawn, update };
}
