// COMBAT FOR THE ALGERIA GAME — the shared machinery (games/shared-rts:
// combat.js targeting / chasing / firing / damage / death; projectiles.js the
// visible rounds by each unit's `weapon`; combatFx.js the muzzle flashes,
// impacts and blasts; flameField.js the burning wrecks; craterSystem.js the
// scorch marks), wired to this game's units.
//
// The buildings fight and are fought (algStructures.js); cover and
// concealment are this map's (algCover.js). SMOKE SCREENS (algSmoke.js) break
// the lines of fire: a smoke grenade's cloud, combat asks it before every shot.
import { armourMul } from "./algArmour.js";
import { createCombatFx } from "../shared-rts/combatFx.js";
import { createBookShots } from "../shared-rts/bookShots.js";
import { SMOKE_TINTS } from "../shared-rts/litSmoke.js";
import { createFlameField } from "../shared-rts/flameField.js";
import { createCraterSystem } from "../shared-rts/craterSystem.js";
import { createProjectiles } from "../shared-rts/projectiles.js";
import { createCombat } from "../shared-rts/combat.js";
import { BLOOD, createBloodField } from "../shared-rts/bloodField.js";
import { createAlgLights } from "./algLights.js";
import { createAlgSmoke } from "./algSmoke.js";

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
export const ALG_FIRE = {
  rifle: { speed: 100, width: 0.09, length: 1.6, tracerEvery: 6, dim: 0.45, dark: 6, jitter: 0.3, dirt: 0.9 },
  mg: { speed: 100, width: 0.12, length: 2.5, tracerEvery: 4, dim: 0.6, dark: 4, jitter: 0.8, dirt: 1.1, burst: 4, gap: 0.06, spread: 3.2 },
  cannon: { speed: 140, width: 0.35, length: 5, dim: 0.75 },
  // The FLN's sniper: EVERY round a tracer — the player's way to see where it came from.
  sniper: { speed: 150, width: 0.08, length: 2.2, tracerEvery: 1, dim: 0.6, dark: 1, jitter: 0.1, dirt: 1 },
  // The Alouette: its AA-52's bursts only — NO rockets/bombs (you, 2026-10-07: "the Alouette
  // shouldn't keep bombs — a called-in air strike, as in CoH").
  gunship: { speed: 100, width: 0.12, length: 2.5, tracerEvery: 3, dim: 0.6, dark: 3, jitter: 0.8, dirt: 1.1, burst: 5, gap: 0.05, spread: 3.6, rocketEvery: 0 },
};
/**
 * MEN BLOWN APART, the Company of Heroes 1 way (you, 2026-10-02): most deaths
 * stay deaths; a man killed right under a shell, a mortar bomb or a grenade
 * comes apart (shared crowdSkinning GIB — in the skinning pass, no draw of
 * its own). `mode`: "coh" (inside 30% of the blast radius, or 40% of the time
 * inside half of it), "always" (every man a blast kills — the lab), "off".
 * ON BY DEFAULT, CoH's close blasts (you, 2026-10-04; it was off since 2026-10-02):
 * ?gore=0 boots it off, Dev → Gore or the battle lab switch it live. Blood is separate (?blood=0).
 */
export const GIBS = { mode: typeof location !== "undefined" && new URLSearchParams(location.search).get("gore") === "0" ? "off" : "coh" };
const gibChance = (d, r) => (GIBS.mode === "always" ? d < r : GIBS.mode === "coh" ? d < r * 0.3 || (d < r * 0.5 && Math.random() < 0.4) : false);

export const ALG_TRACERS = { red: [0.95, 0.42, 0.18], green: [0.95, 0.42, 0.18] };

export async function createAlgCombat(app, { units, structures: built = null, cover = null, blocksSight = null, onDeath = () => {}, onShot = null, onSplash = null, hitChance = null, splashMul = null }) {
  // The CoH look (2026-10-01, research in TODO.md): see ALG_FIRE above.
  // LIT SMOKE (shared litSmoke.js, 2026-10-02): the dust and smoke lit by
  // the sun (a six-way book) instead of the old painted-light book.
  // ?litsmoke=0 boots with the old one (the battle lab switches it live).
  // The blasts' dust columns drift with the map's wind (algWind: the flags'
  // convention, along (cos d, sin d); x2.2 m/s as the vehicles' dust).
  const wind = () => {
    const w = app.showroom?.wind;
    if (!w) return [0, 0];
    const t = performance.now() / 1000, d = w.dirRad(t), v = w.speed(t) * 2.2;
    return [Math.cos(d) * v, Math.sin(d) * v];
  };
  const fx = createCombatFx({ app, style: "coh", litSmoke: new URLSearchParams(location.search).get("litsmoke") !== "0", wind });
  const fire = createFlameField({ app });
  // THE BATTLE LEAVES MARKS (2026-10-07): lit shell holes (bowl, rim, thrown earth — the texture
  // decal read as a flat black blot), 256 kept, and the plants where the shell landed blown away.
  const craters = await createCraterSystem({ app, look: "procedural", max: 256 });
  const stamp = craters.addCrater;
  craters.addCrater = (x, z, r = 4) => {
    stamp(x, z, r);
    if (r >= 1.5) app.clearVegetation?.(x, z, r * 0.7, { grass: r * 0.6, edge: 0.6 });
  };

  // Every blast flushes birds out of the trees near it (rtsBirds.flush); a
  // man going down (the dust puff) does not. The birds come after combat
  // (algGame.js), so they are looked up at the moment of the blast.
  const explosion = fx.explosion;
  fx.explosion = (x, y, z, opts) => { explosion(x, y, z, opts); if (!opts?.dust) { app.algBirds?.flush(x, z, { size: opts?.size ?? 10 }); app.algSounds?.blast(x, y, z, opts?.size ?? 10); app.algDamage?.blast(x, z, opts?.size ?? 10); app.algAnimals?.hurt(x, z, (opts?.size ?? 10) * 0.5, 70); } };
  // THE MORTAR (2026-10-16, you, CoH 3 refs assets-src/refs/coh3/mortar_*.png): baked in the
  // fire-bake lab — the LAUNCH (a bright burst at the mouth, then a pale column rising and drifting
  // downwind) and the IMPACT ("Mortar in earth": a blink of fire, a fountain of earth spikes, the
  // dome slumping). Pooled cards (bookShots.js); the flash, the clods and a dust that lingers after
  // the book are the old pieces. Without the books: the old blast, no launch smoke.
  // (+ the CONSTRUCTION DUST, 2026-10-22: a loop book played once per card, slowed — algBuild.js lays them round a site)
  const shots = await createBookShots({ app, books: { mortarImpact: { pool: 10, fireK: 4 }, mortarLaunch: { pool: 8, fireK: 8 }, constructionDust: { pool: 24, fireK: 0, speed: 0.6 },
    // (+ a machine or a building DESTROYED, 2026-10-22 — the Fire Pro pass: the fuel fireball, then the wreck burning)
    blast: { pool: 4, fireK: 4 }, wreck: { pool: 10, fireK: 2 } } });
  app.algBookShots = shots;
  app.algWind = wind;
  const MORTAR_SIZE = { mortar60: 0.78, mortar81: 1, mortar120: 1.3 };
  const later = [];   // [time left, fn]: the crater, once the blast hides where it lands
  if (shots.has("mortarImpact")) fx.mortar = (x, y, z, kind, { crater = null } = {}) => {
    const k = MORTAR_SIZE[kind] ?? 1, [wx, wz] = wind();
    if (crater) later.push([0.25, crater]);
    fx.flash(x, y + 1, z, 0.1);
    fx.throwDirt(x, y, z, Math.round(12 * k), 8 * k);
    shots.play("mortarImpact", x, z, { size: shots.meta("mortarImpact").size * k });
    // The dust that hangs over the hole after the book (3.5 s), drifting off slowly (at the full
    // wind it streaked away as a puff of its own).
    fx.lit?.puff(x, y + 2.4 * k, z, { size: 8 * k, duration: 7, delay: 1.8, tint: SMOKE_TINTS.dust, opacity: 0.4, grow: 1.25, vel: [wx * 0.4, 0.3, wz * 0.4] });
    app.algBirds?.flush(x, z, { size: 8 * k }); app.algSounds?.blast(x, y, z, 8 * k); app.algDamage?.blast(x, z, 8 * k); app.algAnimals?.hurt(x, z, 4 * k, 70);
  };
  if (shots.has("mortarLaunch")) fx.shellLaunch = (from, dir, kind) => {
    if (!kind?.startsWith?.("mortar")) return;
    const k = MORTAR_SIZE[kind] ?? 1;
    // The first frame is FIRE (the ref): the blast flash, briefly — the book's own lasts a frame.
    fx.flash(from.x, from.y + 0.4, from.z, 0.07);
    // The book's mouth is 0.9 m up its ground point: the column leaves the tube's mouth.
    const gy = app.getWorldHeight?.(from.x, from.z) ?? from.y;
    const lift = Math.max(0, from.y - gy - 0.9 * k);
    // Light grey (the CoH ref's column, not the book's near-white: a cotton ball in the game's sun).
    shots.play("mortarLaunch", from.x, from.z, { size: shots.meta("mortarLaunch").size * k, wind: wind(), lift, tint: [0.24, 0.24, 0.235], opacity: 0.9 });
  };

  // A MACHINE OR A BUILDING DESTROYED (2026-10-22, the Fire Pro pass — it was the old procedural blast and the flame
  // field): the baked FUEL FIREBALL (fire-bake lab "Shell blast") rolling into soot, the clods and the flash; then the
  // WRECK BURNING (the "Burning wreck" loop book cycled for its life — bookShots `life`), its blaze lit at night
  // (algLights burn). Bigger things: a bigger ball, a bigger fire, longer. shared combat.js asks (fx.destroyed).
  if (shots.has("blast") && shots.has("wreck")) fx.destroyed = (u, { hq = false } = {}) => {
    const p = u.position, big = !!u.isStructure;
    const k = big ? (hq ? 2 : 1.4) : Math.min(1.3, Math.max(0.7, (u.radius ?? u.type?.radius ?? 3) / 3));
    const size = big ? (hq ? 26 : 15) : Math.max(8, (u.radius ?? u.type?.radius ?? 4) * 2.4);   // (the old blast's: what the sounds and damage were tuned to)
    fx.flash(p.x, p.y + 1.5, p.z, 0.14);
    fx.throwDirt(p.x, p.y, p.z, Math.round(16 * k), 9 * k);
    // A BUILDING: drawn at its centre the ball and the fire burnt INSIDE it — a column out of the roof with no flame
    // (seen on the motor pool): the blast at mid-height, one fire on the roof, two at its edges toward the camera.
    const h = big ? (u.visionEye ?? 4.5) / 0.9 : 0, R = u.radius ?? 6;
    shots.play("blast", p.x, p.z, { size: shots.meta("blast").size * k * 0.8, wind: wind(), lift: h * 0.45 });
    const life = big ? (hq ? 60 : 40) : 35, wk = big ? k * 1.1 : k;   // (a vehicle: algWrecks P.burn, then its smoulder)
    const W = shots.meta("wreck").size;
    later.push([0.7, () => {
      if (!big) {
        shots.play("wreck", p.x, p.z, { size: W * wk, life, wind: wind(), lift: 0.2 });
        app.algLights?.burn?.(p.x, p.y + 0.6, p.z, 2.4, life);
        return;
      }
      shots.play("wreck", p.x, p.z, { size: W * wk, life, wind: wind(), lift: h * 0.8 });
      app.algLights?.burn?.(p.x, p.y + h, p.z, 4, life);
      const c = app.camera.position, a = Math.atan2(c.x - p.x, c.z - p.z);
      for (const da of [-0.9, 0.9]) {
        const ex = p.x + Math.sin(a + da) * R * 0.55, ez = p.z + Math.cos(a + da) * R * 0.55;
        shots.play("wreck", ex, ez, { size: W * wk * 0.7, life: life * 0.7, wind: wind(), lift: 0.2 });
      }
    }]);
    app.algBirds?.flush(p.x, p.z, { size }); app.algSounds?.blast(p.x, p.y, p.z, size); app.algDamage?.blast(p.x, p.z, size); app.algAnimals?.hurt(p.x, p.z, size * 0.5, 70);
    return true;
  };

  const grenade = fx.grenade;
  fx.grenade = (x, y, z) => { grenade(x, y, z); app.algBirds?.flush(x, z, { size: 4 }); app.algSounds?.blast(x, y, z, 6); app.algDamage?.blast(x, z, 6); app.algAnimals?.hurt(x, z, 4, 70); };
  // A STRAY ROUND landing (projectiles' misses): an animal standing there is hit (ANIMALS DIE).
  const dirt = fx.dirt;
  if (dirt) fx.dirt = (x, y, z, size) => { dirt(x, y, z, size); app.algAnimals?.hurt(x, z, 0.8, 9); };
  // AT NIGHT the shots, blasts and fires light what is round them (algLights.js: the engine's
  // local lights, nothing by day). ?combatlights=0 = without.
  if (new URLSearchParams(location.search).get("combatlights") !== "0") app.algLights = createAlgLights({ app, fx, fire });

  // SMOKE SCREENS (algSmoke.js): drawn with the battle's lit puffs, read by combat for sight.
  const smoke = createAlgSmoke({ app, lit: fx.lit ?? null });

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
    // A smoke grenade (kind "smoke") lands as a cloud, not a blast.
    onArcImpact: (at, dmg, splash, owner, o) => (o?.kind === "smoke" ? smoke.burst(at.x, at.z) : combat?.splashAt(at, dmg, splash, owner, o)),
  });

  // BLOOD (bloodField.js): a man hit sprays from the wound, a man down lies
  // in his pool. Two draws for the whole battle; ?blood=0 = none.
  // A pool lasts as long as its body (algUnits: CORPSES, 90 s).
  const blood = createBloodField({ app, params: { ...BLOOD, poolLife: 95 } });
  const onFootUnit = (e) => !!e?.type?.foot;

  // The buildings (algStructures.js): targets, and the armed ones fighters.
  const structures = { list: built?.list ?? [] };
  const structuresRenderer = { muzzleOf: (s) => built?.muzzleOf(s) ?? s.position.clone() };
  combat = createCombat({
    units, structures, fx, structuresRenderer, projectiles, fire, craters, cover, blocksSight, onShot, onSplash, splashMul, hitChance, gibChance, smoke,
    // Vehicles fire from their guns (the weapons pass): the renderer knows the muzzles.
    unitMuzzle: (e) => app.algUnits?.unitRenderer?.muzzleOf(e) ?? null,
    // ARMOUR BY FACING (algArmour.js): a bullet off a tank's front glances; its rear does not.
    armourMul,
    onHit: (e, amount, at, owner) => { if (onFootUnit(e) && at) blood.hit(at, owner?.position ?? null); },
    onDeath: (e) => {
      if (e.isStructure) built?.wreck(e);
      else if (onFootUnit(e)) app.algSounds?.death(e);
      onDeath(e);
    },
  });

  return {
    fx, fire, craters, projectiles, combat, blood, smoke,
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
      smoke.step(dt);
      combat.update(dt);
      built?.step(dt, projectiles);      // the mortar pit's bombs
      cover?.step(dt, units.list);       // "I just fired" reveal timers
      projectiles.update(dt, app.camera);
      fire.update(dt, simTime);
    },
    /** Every rendered frame: the flashes, impacts and blasts face the camera. */
    frame(dt) {
      fx.update(dt, app.camera); shots.update(dt, app.camera); blood.update(dt, app.camera);
      for (let i = later.length - 1; i >= 0; i--) if ((later[i][0] -= dt) <= 0) { later[i][1](); later.splice(i, 1); }
    },
  };
}
