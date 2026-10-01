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
/**
 * WEAPON FIRE, the COMPANY OF HEROES way (you, 2026-10-01: "it looks like a
 * futuristic laser"; the research: CoH tracers travel ~100 m/s, belts carry
 * 1 tracer in 4-5, misses throw ground puffs, a Men of War mod fixed its
 * "blaster" look with smaller, dimmer, less saturated streaks):
 *   rifle   NO streak on most shots (1 in 6, faint and short): the muzzle
 *           and the dust where it lands do the reading
 *   mg      1 tracer in 4, short (2.5 m), thin (0.12 m), dim, starting a few
 *           metres out of the muzzle, jittered so they are not parallel
 *   cannon  the shell stays a visible streak (a tank round is seen)
 * The colours: desaturated red-orange for both sides (the ALN fought with
 * French and German arms: no Soviet green here).
 */
const ALG_FIRE = {
  rifle: { speed: 100, width: 0.09, length: 1.6, tracerEvery: 6, dim: 0.45, dark: 6, jitter: 0.3, dirt: 0.9 },
  mg: { speed: 100, width: 0.12, length: 2.5, tracerEvery: 4, dim: 0.6, dark: 4, jitter: 0.8, dirt: 1.1, burst: 4, gap: 0.06, spread: 3.2 },
  cannon: { speed: 140, width: 0.35, length: 5, dim: 0.75 },
};
/**
 * MEN BLOWN APART, the Company of Heroes 1 way (you, 2026-10-02): most deaths
 * stay deaths; a man killed right under a shell, a mortar bomb or a grenade
 * comes apart (shared crowdSkinning GIB — in the skinning pass, no draw of
 * its own). `mode`: "coh" (inside 30% of the blast radius, or 40% of the time
 * inside half of it), "always" (every man a blast kills — the lab), "off".
 * OFF BY DEFAULT for this war (you, 2026-10-02): ?gore=1 boots it on (CoH),
 * Dev → Gore or the battle lab switch it live. Blood is separate (?blood=0).
 */
export const GIBS = { mode: typeof location !== "undefined" && new URLSearchParams(location.search).get("gore") === "1" ? "coh" : "off" };
const gibChance = (d, r) => (GIBS.mode === "always" ? d < r : GIBS.mode === "coh" ? d < r * 0.3 || (d < r * 0.5 && Math.random() < 0.4) : false);

const ALG_TRACERS = { red: [0.95, 0.42, 0.18], green: [0.95, 0.42, 0.18] };

export async function createAlgCombat(app, { units, structures: built = null, cover = null, blocksSight = null, onDeath = () => {}, onShot = null, onSplash = null, hitChance = null }) {
  // The CoH look (2026-10-01, research in TODO.md): see ALG_FIRE above.
  const fx = createCombatFx({ app, style: "coh" });
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
    weapons: ALG_FIRE, tracerColours: ALG_TRACERS,
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
    units, structures, fx, structuresRenderer, projectiles, fire, craters, cover, blocksSight, onShot, onSplash, hitChance, gibChance,
    onHit: (e, amount, at, owner) => { if (onFootUnit(e) && at) blood.hit(at, owner?.position ?? null); },
    onDeath: (e) => {
      if (e.isStructure) built?.wreck(e);
      else if (onFootUnit(e)) app.algSounds?.death(e);
      onDeath(e);
    },
  });

  return {
    fx, fire, craters, projectiles, combat, blood,
    /**
     * A man came apart (unitRenderer onGib): a burst of blood where he stood,
     * a pool where his trunk lands, small ones under his limbs. `parts`:
     * [{ part, x, y, z }] where each comes to rest (crowdSkinning GIB order).
     */
    gib(unit, parts) {
      const p = unit.position;
      for (let k = 0; k < 3; k++) blood.hit({ x: p.x, y: p.y + 1.1, z: p.z }, { x: p.x + Math.random() - 0.5, z: p.z + Math.random() - 0.5 });
      for (const q of parts) if (q.part === 0 || Math.random() < 0.6) blood.pool(q.x, q.z, undefined, q.part === 0 ? 0.9 : 0.35);
    },
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
