// Shots — GAME code. What a round looks like between the muzzle and the thing
// it hits. Damage lands ON ARRIVAL, as it always has: a shot is decided by
// combat.js when it is fired and delivered here a moment later.
//
// ── WEAPONS (Company of Heroes, not a laser show) ────────────────────────────
// Every gun used to fire the same glowing orange rocket with a trail, which
// is the old RTS's look and reads as science fiction. Now a unit's `weapon`
// (unitTypes.js / structures.js) picks how its shots look:
//
//   rifle    one tracer per shot — thin, fast, in the side's colour
//   mg       a BURST: the first round carries the shot's damage and hits; the
//            rest spray round the target and kick up dirt where they land.
//            Pure decoration — the damage per second is exactly what it was —
//            but it is the difference between a stat and a machine gun.
//   cannon   one heavy shell streak, a flash and a puff of gun smoke at the
//            muzzle, a small blast where it lands
//   gunship  the Huey: door-gun bursts, and every fourth shot a real rocket
//            (it carries that shot's damage) with a smoke trail
//
// Tracers are tracerField.js (one draw, GPU-placed, one row written per round).
// Rockets and mortar shells are the only projectiles simulated on the CPU.
import * as THREE from "three";
import { BLOOM } from "./bloom.js";
import { createSpriteField } from "./spriteField.js";
import { createTracerField, TRACER_COLOURS } from "./tracerField.js";

/**
 * How each weapon's rounds look. `speed` is VISUAL (m/s): slow enough to see
 * cross the screen, fast enough that a 40 m shot still lands in ~0.2 s.
 */
export const WEAPONS = {
  rifle:   { speed: 170, width: 0.32, length: 5,  burst: 1 },
  mg:      { speed: 200, width: 0.4,  length: 7,  burst: 3, gap: 0.07, spread: 3.2 },
  cannon:  { speed: 150, width: 0.9,  length: 11, burst: 1, shell: true },
  gunship: { speed: 200, width: 0.4,  length: 7,  burst: 3, gap: 0.06, spread: 3.8, rocketEvery: 4 },
};

// Rockets (the gunship's). Sizes are tuned for RTS zoom (camera ~150 m up).
const MAX_ROCKETS = 24;
const ROCKET_R = 0.28;
const ROCKET_L = 1.7;
const ROCKET_SPEED = 75;
const SMOKE_EVERY = 0.03;

/** Shells in the air at once, and how hard their arc is thrown. */
const MAX_SHELLS = 24;
const SHELL_G = 34;       // metres/s² — a game arc, not ballistics: it has to read in ~3 s
const SHELL_R = 0.42;

export function createProjectiles({ app, fx = null, sfx = null, onImpact = () => {}, onArcImpact = () => {} }) {
  // `sfx` (namSounds.js) is told about every shot, rocket, landing round and
  // shell coming down; it decides what, if anything, is heard.
  const { scene } = app;
  const groundY = (x, z) => app.getWorldHeight?.(x, z) ?? 0;

  /** The sim-side clock the tracers are placed on. */
  let clock = 0;
  const tracers = createTracerField({ app });

  // ── Rockets — one InstancedMesh for every rocket in flight ──────────────────
  // A dark body; the light is the motor's flare behind it and the smoke is
  // grey, not a glowing orange trail.
  const bodyMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a3b36, roughness: 0.6, metalness: 0.4 });
  // Capsule is built along Y; bake a rotation into the GEOMETRY so its long axis
  // is +Z — which is where a lookAt() quaternion points an object.
  const bodyGeo = new THREE.CapsuleGeometry(ROCKET_R, ROCKET_L, 3, 7).rotateX(Math.PI / 2);
  const bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX_ROCKETS);
  bodyMesh.count = 0;
  bodyMesh.frustumCulled = false;
  bodyMesh.castShadow = false;
  scene.add(bodyMesh);

  const rockets = [];
  for (let i = 0; i < MAX_ROCKETS; i++) {
    rockets.push({
      alive: false, speed: 0,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      target: null, damage: 0, owner: null, puffT: 0, ttl: 0,
    });
  }

  // The motor's flare (additive, blooms) and its smoke (alpha, grey).
  const flares = createSpriteField({
    scene, max: 48, color: 0xffc070, size: 1.8, bloomScale: BLOOM.muzzle,
    scaleAt: (p) => 0.5 + p * 0.5,
  });
  const smokeTrail = createSpriteField({
    scene, max: 320, color: 0x8f8d88, size: 2.2, bloomScale: 0,
    blending: THREE.NormalBlending,
    scaleAt: (p) => 0.45 + (1 - p) * 1.4,
    fadeAt: (p) => p * 0.55,
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
    s.whistled = false;
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

  const _dir = new THREE.Vector3();
  const _aim = new THREE.Vector3();
  const _obj = new THREE.Object3D();
  const _look = new THREE.Vector3();

  function targetPoint(t, out = _aim) {
    return out.set(
      t.position.x,
      t.position.y + (t.isStructure ? (t.typeKey === "base" ? 8 : 5) : t.isAir ? 0 : 1.3),
      t.position.z,
    );
  }

  // ── Rounds in the air: what happens when each one ARRIVES ─────────────────
  // { at: time, kind: "hit" | "dirt" | "fire", ... } — sorted by nothing; a
  // handful live at once and each is looked at once per step.
  const pending = [];

  /** Put one round in the air from `from` to `to`, arriving after its flight. */
  function round(w, from, to, colour, t0 = clock) {
    const t1 = t0 + Math.max(0.03, from.distanceTo(to) / w.speed);
    tracers.fire(from.x, from.y, from.z, to.x, to.y, to.z, t0, t1,
      { width: w.width, length: w.length, colour });
    return t1;
  }

  /** Where a round that is NOT the hit goes: into the ground round the target. */
  function missPoint(target, spread) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.2 + Math.random() * spread;
    const x = target.position.x + Math.cos(a) * r;
    const z = target.position.z + Math.sin(a) * r;
    if (target.isAir) {
      // Past an aircraft, not into it: the round carries on and falls out of sight.
      return new THREE.Vector3(x, target.position.y + (Math.random() - 0.5) * 4, z);
    }
    return new THREE.Vector3(x, groundY(x, z), z);
  }

  /**
   * Fire at `target` (a combatant) from `from`. `owner.weapon` picks the look
   * (rifle when there is no owner — the stress test's shots).
   */
  function spawn(from, target, damage, owner, _speed = null) {
    const w = WEAPONS[owner?.weapon] ?? WEAPONS.rifle;
    const colour = w.shell ? TRACER_COLOURS.shell
      : owner?.team === "enemy" ? TRACER_COLOURS.green : TRACER_COLOURS.red;
    const src = from.clone();
    sfx?.shot(owner, w, src);

    if (w.shell) {
      // A tank gun: the shell leaves the end of the barrel, not the hull's
      // middle, and the muzzle blast is the loudest thing in the fight.
      if (owner && !owner.isStructure) {
        _dir.set(target.position.x - owner.position.x, 0, target.position.z - owner.position.z).normalize();
        // The barrel reaches past the hull (1.1 radii puts the M48 muzzle at
        // its 5.5 m barrel tip): 0.9 of the radius left the gun
        // smoke floating a few metres short of the muzzle.
        src.set(owner.position.x, owner.position.y + 2.0, owner.position.z)
          .addScaledVector(_dir, (owner.radius ?? 3) * 1.1);
      }
      fx?.cannon(src.x, src.y, src.z);
      // The renderer throws the turret back when this changes (unitRenderer.js).
      if (owner) owner.gunShots = (owner.gunShots ?? 0) + 1;
    } else {
      fx?.muzzle(src.x, src.y, src.z);
    }

    // The gunship's rocket: every `rocketEvery`th shot, carrying the damage.
    if (w.rocketEvery && owner) {
      owner.shotN = (owner.shotN ?? 0) + 1;
      if (owner.shotN % w.rocketEvery === 0 && launchRocket(src, target, damage, owner)) return;
    }

    const to = targetPoint(target).clone();
    const t1 = round(w, src, to, colour);
    pending.push({ at: t1, kind: "hit", target, damage, owner, to, shell: !!w.shell });

    // The rest of an MG burst: later rounds, scattered, into the dirt.
    for (let k = 1; k < (w.burst ?? 1); k++) {
      pending.push({
        at: clock + k * w.gap, kind: "fire", w, colour, target,
        from: src.clone(),
      });
    }
  }

  function launchRocket(from, target, damage, owner) {
    const r = rockets.find((x) => !x.alive);
    if (!r) return false;
    r.alive = true;
    r.pos.copy(from);
    r.target = target;
    r.damage = damage;
    r.owner = owner;
    r.puffT = 0;
    r.ttl = 5; // safety: never live forever
    r.vel.subVectors(targetPoint(target), r.pos).normalize();
    r.speed = ROCKET_SPEED;
    sfx?.rocket(from);
    return true;
  }

  function settle() {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (clock < p.at) continue;
      pending.splice(i, 1);
      if (p.kind === "hit") {
        // The target may have died while the round was in the air: combat's
        // onImpact ignores the dead, and the round simply lands where it was.
        if (p.target?.alive) onImpact(p.target, p.damage, p.to, p.owner, { shell: p.shell, bullet: !p.shell });
        else if (!p.shell) fx?.dirt(p.to.x, groundY(p.to.x, p.to.z), p.to.z);
        if (!p.shell) sfx?.impact(p.to);
      } else if (p.kind === "fire") {
        if (!p.target?.alive) continue;          // the burst stops when he does
        fx?.muzzle(p.from.x, p.from.y, p.from.z);
        const to = missPoint(p.target, p.w.spread);
        const t1 = round(p.w, p.from, to, p.colour);
        if (!p.target.isAir) pending.push({ at: t1, kind: "dirt", to });
      } else if (p.kind === "dirt") {
        fx?.dirt(p.to.x, p.to.y, p.to.z);
        sfx?.impact(p.to);
      }
    }
  }

  function update(dt, camera) {
    clock += dt;
    settle();

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

      // Motor flare every step, smoke puffs on a timer.
      flares.spawn(r.pos.x - r.vel.x * 1.2, r.pos.y - r.vel.y * 1.2, r.pos.z - r.vel.z * 1.2, 0.06);
      r.puffT -= dt;
      if (r.puffT <= 0) {
        r.puffT = SMOKE_EVERY;
        smokeTrail.spawn(r.pos.x, r.pos.y, r.pos.z, 1.3);
      }

      let hit = false;
      if (r.target?.alive && r.pos.distanceTo(targetPoint(r.target)) <= Math.max(2.2, step)) hit = true;
      if (hit) {
        onImpact(r.target, r.damage, r.pos.clone(), r.owner, { shell: true });
        r.alive = false;
        continue;
      }
      if (r.ttl <= 0) { r.alive = false; continue; }   // target died mid-flight: fizzle

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
    if (n > 0) bodyMesh.instanceMatrix.needsUpdate = true;

    // Shells: ballistic, and they land on the POINT, whatever has moved.
    let m = 0;
    for (const s of shells) {
      if (!s.alive) continue;
      s.t += dt;
      s.vel.y -= SHELL_G * dt;
      s.pos.addScaledVector(s.vel, dt);
      // The whistle on the way down, timed to end as it lands.
      if (!s.whistled && s.flight - s.t < 1.6) { s.whistled = true; sfx?.incoming(s.to, s.flight - s.t); }
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
    if (m > 0) shellMesh.instanceMatrix.needsUpdate = true;

    flares.update(dt, camera);
    smokeTrail.update(dt, camera);
    tracers.render(clock);
  }

  return {
    spawn, spawnArc, drawWarnings, update, tracers,
    get shellsInAir() { return shells.filter((s) => s.alive).length; },
  };
}
