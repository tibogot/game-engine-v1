// Rockets — GAME code. Visible, travelling projectiles with glowing exhaust
// trails, replacing the instant hitscan. Damage lands ON IMPACT, so you can see
// the shot cross the battlefield (and it can miss a dead target).
//
// Pooled: combat spawns these constantly, so nothing is allocated per shot.
import * as THREE from "three";
import { makeBloomMaterial, BLOOM } from "./bloom.js";

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

  // ── Rocket bodies ───────────────────────────────────────────────────────────
  const bodyMat = makeBloomMaterial(
    { color: 0xffe9a8, blending: THREE.AdditiveBlending }, BLOOM.muzzle,
  );
  const rockets = [];
  for (let i = 0; i < MAX_ROCKETS; i++) {
    const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(ROCKET_R, ROCKET_L, 4, 8), bodyMat);
    // Capsule is built along Y; rotate so its long axis is local +Z, which is
    // where Object3D.lookAt() points a (non-camera) object.
    mesh.rotation.x = Math.PI / 2;
    mesh.frustumCulled = false;
    // NOTE: do NOT hide the mesh here. Visibility is driven by the PIVOT alone —
    // hiding both and only un-hiding the pivot leaves the child invisible
    // forever, which is exactly why no rockets showed up.
    const pivot = new THREE.Group();
    pivot.add(mesh);
    pivot.visible = false;
    scene.add(pivot);
    rockets.push({
      pivot, alive: false, speed: 0,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      target: null, damage: 0, owner: null, puffT: 0, ttl: 0,
    });
  }

  // ── Exhaust trail puffs ─────────────────────────────────────────────────────
  const puffMat = makeBloomMaterial(
    { color: 0xff9a3c, opacity: 1, blending: THREE.AdditiveBlending, soft: true }, BLOOM.tracer,
  );
  const puffs = [];
  for (let i = 0; i < MAX_PUFFS; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(PUFF_SIZE, PUFF_SIZE), puffMat);
    m.visible = false;
    m.frustumCulled = false;
    scene.add(m);
    puffs.push({ mesh: m, t: 0 });
  }

  const freeRocket = () => rockets.find((r) => !r.alive) ?? null;
  const freePuff = () => puffs.find((p) => !p.mesh.visible) ?? puffs[0];

  const _dir = new THREE.Vector3();
  const _aim = new THREE.Vector3();

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
    r.pivot.visible = true;
    r.pivot.position.copy(r.pos);
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
      r.pivot.position.copy(r.pos);
      r.pivot.lookAt(r.pos.clone().add(r.vel));

      // Trail.
      r.puffT -= dt;
      if (r.puffT <= 0) {
        r.puffT = PUFF_EVERY;
        const p = freePuff();
        p.mesh.position.copy(r.pos);
        p.mesh.visible = true;
        p.t = PUFF_LIFE;
      }

      // Impact?
      let hit = false;
      if (r.target?.alive) {
        const to = targetPoint(r.target);
        if (r.pos.distanceTo(to) <= Math.max(2.2, step)) hit = true;
      } else {
        // Target died mid-flight — let the rocket run out and fizzle.
        if (r.ttl <= 0) hit = false;
      }

      if (hit) {
        onImpact(r.target, r.damage, r.pos.clone(), r.owner);
        r.alive = false;
        r.pivot.visible = false;
      } else if (r.ttl <= 0) {
        r.alive = false;
        r.pivot.visible = false;
      }
    }

    for (const p of puffs) {
      if (!p.mesh.visible) continue;
      p.t -= dt;
      if (p.t <= 0) { p.mesh.visible = false; continue; }
      const k = p.t / PUFF_LIFE;                    // 1 → 0 over its life
      if (camera) p.mesh.quaternion.copy(camera.quaternion); // billboard
      // All puffs share ONE material (one pipeline), so we can't fade opacity
      // per puff — fade by SHRINKING instead. Additive + shrinking reads as
      // dissipating exhaust. Starts fat and bright, thins out behind the rocket.
      p.mesh.scale.setScalar(0.35 + k * 1.05);
    }
  }

  return { spawn, update };
}
