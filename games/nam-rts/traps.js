// The cheap nasty kit — GAME LOGIC (mesh-free, like units.js and structures.js).
//
// Punji pits, booby traps, spider holes and supply caches: the Front's cheap
// war. None of it beats your army in a fight. What it does is make MOVING
// expensive — and it is the only part of this game that punishes you for not
// looking where you are going.
//
// ── The one rule everything here turns on ────────────────────────────────────
//
// A concealed thing is hidden until a RIFLEMAN notices it, and noticing is a
// roll, not a certainty (`concealed.notice` per second, per man in `spot`).
// Vehicles notice nothing at all. So:
//
//   · a squad sweeping a trail usually finds what is on it — five men rolling
//   · one man hurrying up it alone often does not
//   · a column of armour with no infantry in front finds everything the hard way
//
// That is the lesson the whole kit teaches, and it is taught by the odds rather
// than by a rule the player has to be told.
//
// Once found, a trap is DRAWN, marked with a danger ring, and stamped into the
// nav grid: your men walk around it from then on. Knowing where it is IS the
// counter — which is why finding one is a small victory and not just a tax.
//
// Hidden is spelled with flags combat.js already had (`passive`, `deploy`), so
// none of the targeting code knows traps exist. See structures.js.
import * as THREE from "three";

export const TRAPS = {
  sweep: 0.2,            // seconds between spot / trigger checks
  ring: 0x000000,        // danger ring colour is per-kind below
  colors: {
    punji: 0xff7a3a,
    boobyTrap: 0xff4a3a,
  },
};

/** A seeded random in [0, 1) — mulberry32, as enemyAI.js uses. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * `combat` gives the kit its teeth (onImpact, splashAt); `navGrid` is what
 * makes a found trap avoidable; `enemyEarn` is the Front's purse (a cache pays
 * it), `resources` yours (a burnt cache pays you). All optional: without them
 * the kit still hides, springs and dies, which is what the tests drive.
 */
export function createTraps({
  structures, units, combat = null, navGrid = null, resources = null,
  enemyEarn = null, onReveal = null, onLog = () => {}, seed = 4711,
} = {}) {
  const rand = seeded(seed);
  const _near = [];
  const limping = [];      // { unit, t, prev } — men slowed by a pit
  const knownCaches = new Set();
  let sweepT = 0;
  let sprung = 0, found = 0, looted = 0;

  const kit = () => structures.list.filter((s) => s.alive && s.concealed);
  const playersNear = (s, r) => {
    const out = units.near?.(s.position.x, s.position.z, r, _near) ?? units.list;
    return out.filter((u) => u.alive && u.team === "player" && !u.isAir);
  };

  /** It has been found: draw it, mark it, and let the pathfinder route round it. */
  function reveal(s, why) {
    if (!s.reveal?.()) return;
    found++;
    if (s.type.navBlock && navGrid?.addStructureObstacle) {
      // Grown to half a nav cell if the real thing is smaller. The grid blocks
      // a cell when the cell's CENTRE falls inside the rectangle, and its cells
      // are 4 m: a truthful 3.2 m pit stamps NOTHING most of the time, which is
      // how a "found" trap still swallowed men walking straight over it.
      const half = (navGrid.cell ?? 4) / 2;
      const fp = s.type.navBlock;
      s.footprint = {
        cx: fp.cx ?? 0, cz: fp.cz ?? 0,
        hx: Math.max(fp.hx, half), hz: Math.max(fp.hz, half),
      };
      navGrid.addStructureObstacle(s);
    }
    // The jungle that was hiding it is pulled off it (namGame clears the
    // vegetation): a pit you have found is a pit you can SEE, stakes and all,
    // and the bare patch is the mark of it from across the valley.
    onReveal?.(s);
    onLog(`${s.name} ${why}`);
  }

  /**
   * It goes off. A pit takes the one man who stepped in it (and only a man);
   * a booby trap takes whoever is standing round it and is spent.
   *
   * The victim is hurt through combat.onImpact with NO owner, so directional
   * cover cannot shelter him: nothing between you and the ground you are
   * standing on.
   */
  function spring(s, victim) {
    const t = s.type.trap;
    const at = new THREE.Vector3(s.position.x, s.position.y + 0.4, s.position.z);
    sprung++;
    reveal(s, "sprung");
    if (t.splash) {
      combat?.splashAt(at, t.damage, t.splash, s, { vehicleMul: t.vehicleMul ?? 1 });
    } else {
      combat?.onImpact(victim, t.damage, at, null);
      if (t.limp) limp(victim, t.limp, t.limpScale ?? 0.5);
    }
    onLog(`${s.name} caught ${victim.type?.name ?? victim.typeKey}`);
    if (t.oneShot) { s.alive = false; return; }
    // A pit that stays live must not catch the same man ten times a second,
    // standing in it: it takes HIM, and then it is an open hole he is climbing
    // out of. It never catches him twice — he knows exactly where it is now —
    // and it needs `rearm` seconds before it can take anyone else.
    (s.caught ??= new Set()).add(victim);
    s.rearm = t.rearm ?? 8;
  }

  /** A man out of a pit walks home slowly instead of dying in it. */
  function limp(u, seconds, scale) {
    if (!u?.alive) return;
    const had = limping.find((l) => l.unit === u);
    if (had) { had.t = Math.max(had.t, seconds); return; }
    limping.push({ unit: u, t: seconds, prev: u.speedScale ?? 1 });
    u.speedScale = (u.speedScale ?? 1) * scale;
  }

  function runLimps(dt) {
    for (let i = limping.length - 1; i >= 0; i--) {
      const l = limping[i];
      l.t -= dt;
      if (l.t > 0 && l.unit.alive) continue;
      if (l.unit.alive) l.unit.speedScale = l.prev;
      limping.splice(i, 1);
    }
  }

  /** One sweep: who has found what, and what has been stepped on. */
  function look(dt) {
    for (const s of kit()) {
      const c = s.concealed;
      const t = s.type.trap;
      const reach = Math.max(c.spot ?? 0, c.ambush ?? 0, (t?.trigger ?? 0) + 1);
      const near = playersNear(s, reach);
      if (!near.length) continue;

      // Stepped on it — before any chance of noticing, because the trigger
      // ring is inside the spotting ring: a man who is already standing on it
      // has run out of chances.
      if (t) {
        s.rearm = Math.max(0, (s.rearm ?? 0) - dt);
        const victim = s.rearm > 0 ? null : near.find((u) => {
          if (flat(u.position, s.position) > t.trigger) return false;
          if (s.caught?.has(u)) return false;
          return !t.infantryOnly || u.typeKey === "soldier";
        });
        if (victim) { spring(s, victim); continue; }
      }

      if (!s.hidden) continue;

      // A hole opens up: he is not hiding from you any more, he is shooting.
      if (c.ambush && near.some((u) => flat(u.position, s.position) <= c.ambush)) {
        reveal(s, "opened fire");
        continue;
      }

      // Noticed. Every rifleman inside `spot` gets his own roll; the odds are
      // per SECOND, so walking slowly past one is much safer than running.
      let p = 1;
      for (const u of near) {
        if (u.typeKey !== "soldier") continue;           // vehicles see nothing
        if (flat(u.position, s.position) > c.spot) continue;
        p *= Math.exp(-(c.notice ?? 0.8) * dt);
      }
      if (p < 1 && rand() > p) reveal(s, "spotted");
    }
  }

  /** Caches pay the Front every second they stand; burning one pays you. */
  function economy(dt) {
    for (const s of structures.list) {
      if (!s.alive || !s.type.income) continue;
      knownCaches.add(s);
      enemyEarn?.(s.type.income * dt);
    }
    for (const s of knownCaches) {
      if (s.alive) continue;
      knownCaches.delete(s);
      const loot = s.type.loot ?? 0;
      if (loot) { resources?.earn(loot); looted += loot; }
      onLog(`${s.name} destroyed (+${loot})`);
    }
  }

  /** FIXED-STEP, with the rest of the sim. */
  function step(dt) {
    runLimps(dt);
    economy(dt);
    sweepT -= dt;
    if (sweepT > 0) return;
    look(TRAPS.sweep - sweepT);
    sweepT += TRAPS.sweep;
  }

  return {
    step,
    reveal,
    /** Live kit, and the part of it your side has found (the renderer draws only this). */
    get all() { return kit(); },
    get revealed() { return kit().filter((s) => !s.hidden); },
    get counts() { return { sprung, found, looted, limping: limping.length }; },
  };
}
