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
  /** Scratch for acquire's grid query — acquisition runs one combatant at a time. */
  const _nearUnits = [];

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
    const consider = (o) => {
      if (!o.alive || o.team === e.team) return;
      if (o.passive) return;
      if (o.isAir && !e.canHitAir) return; // jeeps can't shoot helicopters
      const d = flat(e, o);
      // An AA gun (the ZPU) takes any aircraft in reach over anything on the
      // ground: aircraft are ranked as if much nearer. The reach test below
      // still uses the real distance.
      const rank = e.prefersAir && o.isAir ? d * 0.25 : d;
      if (d > reach || rank >= bestD) return;
      // Concealment before smoke: it is a grid lookup and two float compares,
      // where the smoke test walks every live column.
      if (cover && d > reach * cover.acquireRangeScale(e.position.x, e.position.z, o)) return;
      if (!canSee(e, o)) return;
      bestD = rank; best = o;
    };
    // Units from the spatial grid (only those within reach are ever looked
    // at — this was every unit, for every idle unit, every tick: O(n²) and an
    // array copy per call), then the structures, which are few.
    for (const o of units.near(e.position.x, e.position.z, reach, _nearUnits)) consider(o);
    for (const o of structures.list) consider(o);
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

  /**
   * A shell lands: everything on the ground within `radius` of the point takes
   * damage, full at the centre and falling off to nothing at the rim. Aircraft
   * are not touched, and COVER DOES NOT SHELTER anyone — a mortar bomb comes
   * down from above, which is exactly what makes it the answer to men dug in
   * behind sandbags. The owner's own side is not hit.
   *
   * `vehicleMul` scales what anything that is not a rifleman takes: a mortar
   * bomb does not care, but the Front's booby traps (traps.js) are a grenade in
   * a tin, and a grenade in a tin does not hurt an M48.
   */
  const _splashNear = [];
  function splashAt(at, damage, radius, owner = null, { vehicleMul = 1 } = {}) {
    fx.explosion(at.x, at.y, at.z);
    craters?.addCrater(at.x, at.z, Math.max(2.5, radius * 0.7));
    const hit = (o) => {
      if (!o.alive || o.isAir || o.passive) return;
      if (owner && o.team === owner.team) return;
      const d = Math.hypot(o.position.x - at.x, o.position.z - at.z);
      if (d > radius) return;
      const soft = o.isStructure || o.typeKey === "soldier";
      const amount = damage * (1 - (d / radius) ** 1.5) * (soft ? 1 : vehicleMul);
      if (amount > 0) onImpact(o, amount, at, null);       // null owner: no directional cover
    };
    for (const o of units.near(at.x, at.z, radius, _splashNear)) hit(o);
    for (const o of structures.list) hit(o);
  }

  /** One combatant's turn: forget, acquire, close in, shoot. */
  function engage(e, dt) {
    if (!e.alive || !e.range) return;
    // A building still rising out of the ground, or a turret still running its
    // calibration sweep, is a target but not yet a shooter. (It stays in
    // `acquire`'s candidate list — enemies can and should shoot it meanwhile.)
    if (e.constructing || (e.deploy ?? 1) < 1) return;
    e.cooldown = Math.max(0, (e.cooldown ?? 0) - dt);
    // Holding fire (a squad falling back, enemyAI.js): no targets, or combat
    // would halt the man in range to shoot and the retreat would never happen.
    if (e.holdFire) { e.target = null; return; }

    // Forget dead targets.
    if (e.target && !e.target.alive) e.target = null;
    if (e.attackTarget && !e.attackTarget.alive) e.attackTarget = null;

    // An explicit attack order beats auto-acquire.
    let tgt = e.attackTarget ?? e.target;
    if (!tgt || !tgt.alive) {
      tgt = acquire(e);
      e.target = tgt;
    }
    // An AA gun busy with something on the ground looks up every half second:
    // a helicopter coming into reach takes over.
    if (e.prefersAir && tgt && !tgt.isAir && !e.attackTarget) {
      e.reacquireCd = (e.reacquireCd ?? 0) - dt;
      if (e.reacquireCd <= 0) {
        e.reacquireCd = 0.5;
        const up = acquire(e);
        if (up?.isAir) { tgt = up; e.target = up; }
      }
    }
    if (!tgt) return;

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
        return; // still closing — hold fire
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
      return;
    }

    if (d <= e.range && e.cooldown <= 0) {
      e.cooldown = 1 / (e.fireRate || 1);
      e.target = tgt;
      // Fire a VISIBLE rocket. Damage lands when it connects (see onImpact),
      // not instantly — so shots read on screen and can chase a moving target.
      const from = muzzleOf(e);
      fx.muzzle(from.x, from.y, from.z);
      // An AA gun hits aircraft harder than ground (airMul / groundMul, 1 for
      // everything else).
      const dmg = e.damage * (tgt.isAir ? (e.airMul ?? 1) : (e.groundMul ?? 1));
      projectiles.spawn(from, tgt, dmg, e);
      // A muzzle flash in a dark jungle is the loudest thing on the map.
      // This is what stops concealment being a free permanent buff: it buys
      // an AMBUSH, and spends itself the moment you take it.
      cover?.reveal(e);
    }
  }

  // Two plain loops rather than one over [...units, ...structures]: that
  // spread built a fresh array of every combatant every tick.
  function update(dt) {
    for (const e of units.list) engage(e, dt);
    for (const e of structures.list) engage(e, dt);
  }

  return { update, acquire, onImpact, splashAt };
}
