// Combat — GAME LOGIC. Targeting, chasing, firing, damage, death.
//
// Units and structures are treated UNIFORMLY: both are "combatants" with
// position / team / hp / range / damage / fireRate. One system covers jeeps,
// helicopters and turrets, so adding a new fighting thing needs no new code
// here — just the stats.
//
// Shots are HITSCAN (instant): fire → damage → tracer FX. That's what most RTS
// small-arms do; it avoids per-projectile physics and reads clearly at RTS zoom.
import * as THREE from "three";

const ACQUIRE_MULT = 1.15; // auto-acquire slightly beyond weapon range

export function createCombat({
  units, structures, fx, structuresRenderer, projectiles, fire, craters, onDeath = () => {},
}) {
  const _muzzle = new THREE.Vector3();

  const combatants = () => [...units.list, ...structures.list];

  /** Where a shot leaves from. */
  function muzzleOf(e) {
    if (e.isStructure) return structuresRenderer.muzzleOf(e);
    return _muzzle.set(e.position.x, e.position.y + (e.isAir ? 0 : 1.6), e.position.z).clone();
  }

  const flat = (a, b) => Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);

  /** Nearest valid enemy within acquire range, or null. */
  function acquire(e) {
    let best = null, bestD = Infinity;
    const reach = e.range * ACQUIRE_MULT;
    for (const o of combatants()) {
      if (!o.alive || o.team === e.team) continue;
      if (o.passive) continue;
      if (o.isAir && !e.canHitAir) continue; // jeeps can't shoot helicopters
      const d = flat(e, o);
      if (d <= reach && d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** Called when a rocket connects (damage lands on IMPACT, not on fire). */
  function onImpact(target, amount, at) {
    if (!target?.alive) return;
    fx.impact(at.x, at.y, at.z);

    if (target.takeDamage) target.takeDamage(amount);
    else {
      target.hp -= amount;
      if (target.hp <= 0) { target.hp = 0; target.alive = false; }
    }

    if (!target.alive) {
      fx.explosion(target.position.x, target.position.y, target.position.z);
      // The wreck burns. Bigger things burn bigger and longer.
      const big = target.isStructure;
      fire?.addFire(
        target.position.x,
        target.position.y + (big ? 2 : 0.6),
        target.position.z,
        big ? (target.typeKey === "base" || target.typeKey === "enemyBase" ? 9 : 5) : 2.4,
        big ? 26 : 11,
      );
      craters?.addCrater(
        target.position.x,
        target.position.z,
        target.typeKey === "base" || target.typeKey === "enemyBase" ? 7.5
          : target.typeKey === "turret" ? 4.8
            : target.typeKey === "trainingDummy" ? 3.2
              : target.isStructure ? 4.8 : 2.4,
      );
      onDeath(target);
    }
  }

  function update(dt) {
    for (const e of combatants()) {
      if (!e.alive || !e.range) continue;
      // A building still rising out of the ground, or a turret still running its
      // calibration sweep, is a target but not yet a shooter. (It stays in
      // `acquire`'s candidate list — enemies can and should shoot it meanwhile.)
      if (e.constructing || (e.deploy ?? 1) < 1) continue;
      e.cooldown = Math.max(0, (e.cooldown ?? 0) - dt);

      // Forget dead targets.
      if (e.target && !e.target.alive) e.target = null;
      if (e.attackTarget && !e.attackTarget.alive) e.attackTarget = null;

      // An explicit attack order beats auto-acquire.
      let tgt = e.attackTarget ?? e.target;
      if (!tgt || !tgt.alive) {
        tgt = acquire(e);
        e.target = tgt;
      }
      if (!tgt) continue;

      const d = flat(e, tgt);

      // Units close the distance; structures can't move, so they just wait.
      if (!e.isStructure) {
        if (d > e.range * 0.9) {
          // Chase — re-issue periodically so we track a moving target without
          // running A* every frame. orderTo (not moveOrder) so the attack order
          // survives.
          e.chaseCd = (e.chaseCd ?? 0) - dt;
          if (e.chaseCd <= 0) {
            e.orderTo(tgt.position.x, tgt.position.z);
            e.chaseCd = 0.5;
          }
          continue; // still closing — hold fire
        }
        // In range — hold position and shoot. haltMovement (not stop) so the
        // attack order survives; stop() would forget the target we're shooting.
        if (e.isMoving) e.haltMovement();
      }

      if (d <= e.range && e.cooldown <= 0) {
        e.cooldown = 1 / (e.fireRate || 1);
        e.target = tgt;
        // Fire a VISIBLE rocket. Damage lands when it connects (see onImpact),
        // not instantly — so shots read on screen and can chase a moving target.
        const from = muzzleOf(e);
        fx.muzzle(from.x, from.y, from.z);
        projectiles.spawn(from, tgt, e.damage, e);
      }
    }
  }

  return { update, acquire, onImpact };
}
