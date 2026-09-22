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

/** Shells in the air at once, and how hard their arc is thrown. */
const MAX_SHELLS = 24;
const SHELL_G = 34;       // metres/s² — a game arc, not ballistics: it has to read in ~3 s
const SHELL_R = 0.42;

export function createProjectiles({ app, onImpact = () => {}, onArcImpact = () => {} }) {
  const { scene } = app;

  // ── Rocket bodies — one InstancedMesh for every rocket in flight ────────────
  // FrontSide: the capsule is closed geometry, its inside is never visible —
  // and DoubleSide transparent costs two draws per pass in the WebGPU renderer.
  const bodyMat = makeBloomMaterial(
    { color: 0xffe9a8, blending: THREE.AdditiveBlending, side: THREE.FrontSide }, BLOOM.muzzle,
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

  // ── Mortar shells — the other kind of shot: an ARC, at a PLACE ─────────────
  // A rocket flies at a thing it can see. A mortar bomb goes up and comes down
  // on a patch of ground, out of anyone's line of sight, and hurts whoever is
  // standing there when it lands. Dark and small in flight on purpose: what
  // you are meant to see is the warning ring on the ground (drawWarnings).
  const shellMat = new THREE.MeshStandardNodeMaterial({ color: 0x2b2b28, roughness: 0.8, metalness: 0.2 });
  const shellGeo = new THREE.CapsuleGeometry(SHELL_R, SHELL_R * 2.4, 3, 7).rotateX(Math.PI / 2);
  const shellMesh = new THREE.InstancedMesh(shellGeo, shellMat, MAX_SHELLS);
  shellMesh.count = 0;
  shellMesh.frustumCulled = false;
  shellMesh.castShadow = false;
  scene.add(shellMesh);

  const shells = [];
  for (let i = 0; i < MAX_SHELLS; i++) {
    shells.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), to: new THREE.Vector3(), t: 0, flight: 0, damage: 0, splash: 0, owner: null });
  }

  /**
   * Lob a shell from `from` onto the point `to`, landing in `flight` seconds
   * (default: further is longer). `splash` metres of blast; the game decides
   * what that does (onArcImpact → combat.splashAt).
   */
  function spawnArc(from, to, { damage = 30, splash = 9, owner = null, flight = null } = {}) {
    const s = shells.find((r) => !r.alive);
    if (!s) return null;
    s.alive = true;
    s.pos.copy(from);
    s.to.copy(to);
    s.damage = damage;
    s.splash = splash;
    s.owner = owner;
    s.t = 0;
    s.flight = flight ?? Math.min(5.5, 1.9 + from.distanceTo(to) / 80);
    // The velocity that puts it on the point in exactly that time under SHELL_G.
    s.vel.subVectors(to, from).divideScalar(s.flight);
    s.vel.y += 0.5 * SHELL_G * s.flight;
    return s;
  }

  /**
   * The rings on the ground under everything in the air — call between a ring
   * field's begin() and commit(), on the RENDER side. They tighten and turn
   * red as the shell comes down: the second or so you have to move.
   */
  function drawWarnings(rings) {
    if (!rings) return;
    for (const s of shells) {
      if (!s.alive) continue;
      const left = Math.max(0, 1 - s.t / s.flight);            // 1 → 0
      const r = s.splash * (1 + left * 0.9);
      rings.add(s.to.x, s.to.z, r, left < 0.35 ? 0xff3a2a : 0xffb020);
    }
  }

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
    // count 0 still issues a draw per pass — drop out of the render list.
    bodyMesh.visible = n > 0;
    bodyMesh.instanceMatrix.needsUpdate = true;

    // Shells: ballistic, and they land on the POINT, whatever has moved.
    let m = 0;
    for (const s of shells) {
      if (!s.alive) continue;
      s.t += dt;
      s.vel.y -= SHELL_G * dt;
      s.pos.addScaledVector(s.vel, dt);
      if (s.t >= s.flight) {
        s.alive = false;
        onArcImpact(s.to.clone(), s.damage, s.splash, s.owner);
        continue;
      }
      _obj.position.copy(s.pos);
      _obj.lookAt(_look.copy(s.pos).add(s.vel));
      _obj.scale.setScalar(1);
      _obj.updateMatrix();
      shellMesh.setMatrixAt(m, _obj.matrix);
      m++;
    }
    shellMesh.count = m;
    shellMesh.visible = m > 0;
    shellMesh.instanceMatrix.needsUpdate = true;

    puffs.update(dt, camera);
  }

  return { spawn, spawnArc, drawWarnings, update, get shellsInAir() { return shells.filter((s) => s.alive).length; } };
}
