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

/**
 * How smoked a sight line has to be before a weapon gives up on it. A mature
 * screening grenade reads 0.85 through its middle and about 0.17 at its rim,
 * so 0.6 means the cloud has to be genuinely between the two — standing at the
 * edge of someone else's smoke does not make you invisible.
 */
const SMOKE_BLIND = 0.6;

export function createCombat({
  units, structures, fx, structuresRenderer, projectiles, fire, craters,
  smoke = null, cover = null, onDeath = () => {},
}) {
  const _muzzle = new THREE.Vector3();

  const combatants = () => [...units.list, ...structures.list];

  /** Where a shot leaves from. */
  function muzzleOf(e) {
    if (e.isStructure) return structuresRenderer.muzzleOf(e);
    return _muzzle.set(e.position.x, e.position.y + (e.isAir ? 0 : 1.6), e.position.z).clone();
  }

  const flat = (a, b) => Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);

  /**
   * Can `a` see `b`, or is there smoke in the way?
   *
   * Asked of the sim's smoke COLUMNS, never of the particles — the answer has
   * to be the same on every machine and at every frame rate. Cheap enough to
   * ask per candidate: about half a microsecond with all 24 columns live.
   */
  const canSee = (a, b) => !smoke || smoke.occlusionBetween(
    a.position.x, a.position.z, b.position.x, b.position.z) < SMOKE_BLIND;

  /**
   * Nearest valid enemy that can actually be PICKED UP — within range, not
   * behind smoke, and not lying concealed in the jungle further out than the
   * jungle lets you see.
   *
   * Concealment shortens the reach per CANDIDATE rather than dimming the
   * seer's range as a whole, because it is a property of where the target is
   * standing: a soldier in elephant grass and a tank in the open, both at 30 m,
   * are not equally findable, and a single scaled range could not say so.
   */
  function acquire(e) {
    let best = null, bestD = Infinity;
    const reach = e.range * ACQUIRE_MULT;
    for (const o of combatants()) {
      if (!o.alive || o.team === e.team) continue;
      if (o.passive) continue;
      if (o.isAir && !e.canHitAir) continue; // jeeps can't shoot helicopters
      const d = flat(e, o);
      if (d > reach || d >= bestD) continue;
      // Concealment before smoke: it is a grid lookup and two float compares,
      // where the smoke test walks every live column.
      if (cover && d > reach * cover.acquireRangeScale(e.position.x, e.position.z, o)) continue;
      if (!canSee(e, o)) continue;
      bestD = d; best = o;
    }
    return best;
  }

  /** Called when a rocket connects (damage lands on IMPACT, not on fire). */
  function onImpact(target, amount, at, owner = null) {
    if (!target?.alive) return;
    fx.impact(at.x, at.y, at.z);

    // HARD COVER takes a bite out of the damage. Applied here, at the moment of
    // impact, and measured from where the shot CAME from — so the same sandbag
    // wall protects against the enemy in front and not against the one who has
    // worked around the flank, which is the entire point of cover.
    //
    // A shot with no owner (burning napalm, a scripted hit) is not coming from
    // anywhere, so nothing shelters you from it.
    if (cover && owner?.position) {
      amount *= 1 - cover.coverBetween(
        owner.position.x, owner.position.z, target.position.x, target.position.z);
    }

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

      // Smoke rolling in between breaks the shot. An AUTO-acquired target is
      // forgotten so the unit looks for someone it can actually see; an
      // explicit attack order is KEPT — the player pointed at that thing, and
      // silently retargeting would be the game overruling them. Either way it
      // holds fire, which is what makes a screening grenade worth throwing.
      if (!canSee(e, tgt)) {
        if (!e.attackTarget) e.target = null;
        continue;
      }

      if (d <= e.range && e.cooldown <= 0) {
        e.cooldown = 1 / (e.fireRate || 1);
        e.target = tgt;
        // Fire a VISIBLE rocket. Damage lands when it connects (see onImpact),
        // not instantly — so shots read on screen and can chase a moving target.
        const from = muzzleOf(e);
        fx.muzzle(from.x, from.y, from.z);
        projectiles.spawn(from, tgt, e.damage, e);
        // A muzzle flash in a dark jungle is the loudest thing on the map.
        // This is what stops concealment being a free permanent buff: it buys
        // an AMBUSH, and spends itself the moment you take it.
        cover?.reveal(e);
      }
    }
  }

  return { update, acquire, onImpact };
}
