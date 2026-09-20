/**
 * ABILITIES — the player's verbs beyond "move" and "shoot".
 *
 * Two files, split on purpose: THIS one is the rule (what exists, what it
 * costs, whether it is ready, what it does) and lives in the sim;
 * abilityTargeting.js is the cursor and lives in the frame. An ability that
 * knew about pointer events could not be fired by an AI, replayed, or tested
 * without a browser, and all three are things this will want.
 *
 * ── WHERE A COOLDOWN LIVES ──────────────────────────────────────────────────
 *
 * On the CASTER, not on the ability. A smoke grenade belongs to a squad, so
 * selecting a different squad must offer a different grenade; if the timer sat
 * on the definition, one soldier throwing smoke would put every soldier in the
 * army on cooldown. Off-map support is the exception and says so: the napalm
 * timer is global because there is one aircraft, not one per radio.
 *
 * ── WHY SMOKE IS FREE AND NAPALM IS NOT ─────────────────────────────────────
 *
 * Smoke costs nothing but time. It kills nobody, and a resource price on a
 * purely defensive tool means a losing player — exactly the one who needs to
 * break contact — cannot afford to. Napalm kills, so it is paid for.
 */

/**
 * `target: "point"` asks for one click. `target: "run"` asks for a click and a
 * drag, because a corridor needs a heading as well as a place.
 */
export const ABILITIES = {
  smokeGrenade: {
    key: "smokeGrenade",
    label: "Smoke",
    hint: "Screening smoke — breaks line of sight both ways",
    target: "point",
    /** Which unit types may throw it. */
    casters: ["soldier", "builder"],
    range: 42,
    radius: 12,
    cost: 0,
    cooldown: 32,
    /** Per CASTER, so two squads have two grenades. */
    scope: "caster",
    cast({ game, x, z }) {
      game.smoke?.spawn({ x, z, kind: "screen" });
    },
  },

  napalmRun: {
    key: "napalmRun",
    label: "Napalm Run",
    hint: "Off-map air support — burns a corridor and denies it",
    target: "run",
    /** Called from the radio, which is what an air strike is called on. */
    casterStructures: ["radio"],
    range: 260,          // the aircraft is off-map; the radio's reach is doctrine
    radius: 11,
    length: 70,
    cost: 300,
    cooldown: 105,
    /** ONE aircraft for the whole army — see the note above. */
    scope: "global",
    cast({ game, x, z, dirX, dirZ }) {
      game.napalm?.strike({ x, z, dirX, dirZ });
    },
  },
};

export const ABILITY_KEYS = Object.keys(ABILITIES);

/**
 * @param {object} o
 *   game       { smoke, napalm } — what the abilities act on
 *   resources  spend / canAfford
 */
export function createAbilities({ game, resources }) {
  /** Global cooldowns, by ability key. */
  const globalCd = new Map();

  /** Everything `e` can cast, whether or not it is ready. */
  function forEntity(e) {
    if (!e?.alive || e.constructing) return [];
    const out = [];
    for (const a of Object.values(ABILITIES)) {
      const ok = e.isStructure
        ? a.casterStructures?.includes(e.typeKey)
        : a.casters?.includes(e.typeKey);
      if (ok) out.push(a);
    }
    return out;
  }

  /** Everything ANY of the selection can cast, deduplicated. */
  function forSelection(selected) {
    const seen = new Map();
    for (const e of selected ?? []) {
      for (const a of forEntity(e)) if (!seen.has(a.key)) seen.set(a.key, a);
    }
    return [...seen.values()];
  }

  /** Seconds until `a` is ready for `caster`, 0 when it is. */
  function cooldownLeft(a, caster) {
    if (a.scope === "global") return Math.max(0, globalCd.get(a.key) ?? 0);
    return Math.max(0, caster?.abilityCd?.[a.key] ?? 0);
  }

  /**
   * The best caster in the selection for `a` — the one whose cooldown is
   * lowest. Selecting four squads and pressing Smoke should throw the grenade
   * of whichever squad HAS one, not fail because the first one in the list is
   * still reloading.
   */
  function pickCaster(a, selected) {
    let best = null, bestCd = Infinity;
    for (const e of selected ?? []) {
      if (!forEntity(e).includes(a)) continue;
      const cd = cooldownLeft(a, e);
      if (cd < bestCd) { bestCd = cd; best = e; }
    }
    return best;
  }

  /** Can this be cast right now, and if not, why? */
  function check(a, selected) {
    const caster = pickCaster(a, selected);
    if (!caster) return { ok: false, reason: "no caster" };
    const cd = cooldownLeft(a, caster);
    if (cd > 0) return { ok: false, reason: "cooling", cd, caster };
    if (a.cost > 0 && !resources.canAfford(a.cost)) return { ok: false, reason: "cost", caster };
    return { ok: true, caster };
  }

  /**
   * Fire it. Returns false and changes NOTHING when it cannot — the caller is
   * UI, and a half-applied cast (paid for but not thrown) is the bug that
   * costs a player a match.
   */
  function cast(a, selected, at) {
    const c = check(a, selected);
    if (!c.ok) return false;
    // Out of range is checked here and not in `check`, because `check` answers
    // "is this button live" and the range depends on where the cursor is.
    const caster = c.caster;
    const d = Math.hypot(at.x - caster.position.x, at.z - caster.position.z);
    if (d > a.range) return false;
    if (a.cost > 0 && !resources.spend(a.cost)) return false;

    if (a.scope === "global") globalCd.set(a.key, a.cooldown);
    else (caster.abilityCd ??= {})[a.key] = a.cooldown;

    a.cast({ game, caster, x: at.x, z: at.z, dirX: at.dirX ?? 0, dirZ: at.dirZ ?? 1 });
    return true;
  }

  /** FIXED-STEP. Cooldowns are outcomes, so they run on the sim clock. */
  function step(dt, entities) {
    for (const [k, v] of globalCd) {
      const n = v - dt;
      if (n <= 0) globalCd.delete(k); else globalCd.set(k, n);
    }
    for (const e of entities) {
      const cds = e.abilityCd;
      if (!cds) continue;
      for (const k in cds) {
        cds[k] -= dt;
        if (cds[k] <= 0) delete cds[k];
      }
    }
  }

  return { forEntity, forSelection, cooldownLeft, pickCaster, check, cast, step, ABILITIES };
}
