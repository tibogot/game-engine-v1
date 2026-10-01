// COMBAT FOR THE ALGERIA GAME — the shared machinery (games/shared-rts:
// combat.js targeting / chasing / firing / damage / death; projectiles.js the
// visible rounds by each unit's `weapon`; combatFx.js the muzzle flashes,
// impacts and blasts; flameField.js the burning wrecks; craterSystem.js the
// scorch marks), wired to this game's units.
//
// The buildings fight and are fought (algStructures.js); cover and
// concealment are this map's (algCover.js). Not yet (TODO.md): smoke, sound.
import { createCombatFx } from "../shared-rts/combatFx.js";
import { createFlameField } from "../shared-rts/flameField.js";
import { createCraterSystem } from "../shared-rts/craterSystem.js";
import { createProjectiles } from "../shared-rts/projectiles.js";
import { createCombat } from "../shared-rts/combat.js";
import { createBloodField } from "../shared-rts/bloodField.js";

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units     the shared units
 * @param {(e: object) => void} [o.onDeath]
 */
export async function createAlgCombat(app, { units, structures: built = null, cover = null, blocksSight = null, onDeath = () => {}, onShot = null, onSplash = null, hitChance = null }) {
  const fx = createCombatFx({ app });
  const fire = createFlameField({ app });
  const craters = await createCraterSystem({ app });

  // Every blast flushes birds out of the trees near it (rtsBirds.flush); a
  // man going down (the dust puff) does not. The birds come after combat
  // (algGame.js), so they are looked up at the moment of the blast.
  const explosion = fx.explosion;
  fx.explosion = (x, y, z, opts) => { explosion(x, y, z, opts); if (!opts?.dust) { app.algBirds?.flush(x, z, { size: opts?.size ?? 10 }); app.algSounds?.blast(x, y, z, opts?.size ?? 10); app.algDamage?.blast(x, z, opts?.size ?? 10); } };
  const grenade = fx.grenade;
  fx.grenade = (x, y, z) => { grenade(x, y, z); app.algBirds?.flush(x, z, { size: 4 }); app.algSounds?.blast(x, y, z, 6); app.algDamage?.blast(x, z, 6); };

  // Late-bound: projectiles need combat.onImpact, combat needs projectiles.
  let combat = null;
  const projectiles = createProjectiles({
    app, fx,
    // Every shot puts up any storks standing near it, and is HEARD (algSounds.js).
    sfx: {
      shot: (owner, w, at) => { app.algBirds?.disturb(at.x, at.z); app.algSounds?.sfx.shot(owner, w, at); },
      rocket: (at) => app.algSounds?.sfx.rocket?.(at),
      impact: (at) => app.algSounds?.sfx.impact(at),
      incoming: (at, left) => app.algSounds?.sfx.incoming(at, left),
    },
    onImpact: (target, dmg, at, owner, opts) => combat?.onImpact(target, dmg, at, owner, opts),
    onArcImpact: (at, dmg, splash, owner, o) => combat?.splashAt(at, dmg, splash, owner, o),
  });

  // BLOOD (bloodField.js): a man hit sprays from the wound, a man down lies
  // in his pool. Two draws for the whole battle; ?blood=0 = none.
  const blood = createBloodField({ app });
  const onFootUnit = (e) => !!e?.type?.foot;

  // The buildings (algStructures.js): targets, and the armed ones fighters.
  const structures = { list: built?.list ?? [] };
  const structuresRenderer = { muzzleOf: (s) => built?.muzzleOf(s) ?? s.position.clone() };
  combat = createCombat({
    units, structures, fx, structuresRenderer, projectiles, fire, craters, cover, blocksSight, onShot, onSplash, hitChance,
    onHit: (e, amount, at, owner) => { if (onFootUnit(e) && at) blood.hit(at, owner?.position ?? null); },
    onDeath: (e) => {
      if (e.isStructure) built?.wreck(e);
      else if (onFootUnit(e)) app.algSounds?.death(e);
      onDeath(e);
    },
  });

  return {
    fx, fire, craters, projectiles, combat, blood,
    /** On the fixed sim clock, after the units have moved. */
    step(dt, simTime) {
      combat.update(dt);
      built?.step(dt, projectiles);      // the mortar pit's bombs
      cover?.step(dt, units.list);       // "I just fired" reveal timers
      projectiles.update(dt, app.camera);
      fire.update(dt, simTime);
    },
    /** Every rendered frame: the flashes, impacts and blasts face the camera. */
    frame(dt) { fx.update(dt, app.camera); blood.update(dt, app.camera); },
  };
}
