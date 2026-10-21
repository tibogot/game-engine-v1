// THE TOWN'S HOUSES BREAK AND COLLAPSE (2026-10-22 — the biggest gameplay gap left: Company of Heroes' signature).
// A map's town (algGame: one instanced field, algHouse createHouseField) — every house has its health; shells, mortar
// bombs and grenades bursting on it wear it down (algDamage.blast feeds `blast`):
//
//   DAMAGED   below DAMAGED_AT of its health: its damaged model (walls holed, roof part gone), a burst of dust, a
//             heap of rubble at its foot; the men inside take more from what bursts on it (blastMul).
//   COLLAPSED at 0: its ruin model, a big burst of dust and smoke; the men inside thrown out by the door, hurt, some
//             killed; it takes no garrison again, no longer stops a shot or a look over its broken walls (sight
//             lowered), its walls only SOFT cover. (Its nav footprint stays: the ruin model keeps its broken shell.)
//
// Not repaired (CoH: a ruin stays a ruin). The mosque stands longest.
import * as THREE from "three";

const P = {
  hp: { default: 520, tour: 700, dar: 600, souk: 480, bas: 380, cour: 380, boutique: 380, mosquee: 1100 },
  damagedAt: 0.55,
  minSize: 5,            // a grenade (6) does a little; rifle fire nothing
  per: (size) => Math.max(0, size - 4) * 16,   // a mortar bomb (10) ~96, a tank shell (13) ~144, a grenade (6) ~32
  reach: 1.5,            // m past its footprint a burst still counts
  ruinTop: 1.6,          // m: the rubble's height for sight
  hurtOnCollapse: [30, 90],
  blastMulDamaged: 1.6,
};

/**
 * @param app
 * @param o.field     the town's house field (setState(id, state))
 * @param o.houses    MAP.town.houses rows [type, state, x, y, z, yaw, fx, fz, hx, hz] — row i is field id i
 * @param o.footprints  the nav footprints (handles), index i
 * @param o.garrisons   the garrison houses (algGarrison addHouse results), index i (null for a ruin from the start)
 * @param o.par       parapet heights by type (real metres; × 1.3)
 */
export function createTownDamage(app, { field, houses, footprints = [], garrisons = [], par = {} }) {
  const H = houses.map(([ty, st, , y, , yaw, fx, fz, hx, hz], i) => {
    const max = P.hp[ty] ?? P.hp.default;
    const hp = st === "ruin" ? 0 : st === "damaged" ? max * P.damagedAt * 0.9 : max;
    return { i, ty, state: st, y, yaw, fx, fz, hx, hz, hp, max };
  });
  const state = (i) => H[i]?.state ?? "intact";
  const inside = (h, x, z, r) => {
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw), dx = x - h.fx, dz = z - h.fz;
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    return Math.abs(lx) <= h.hx + r && Math.abs(lz) <= h.hz + r;
  };
  function dust(h, big) {
    const fx = app.algCombat?.fx;
    fx?.explosion?.(h.fx, h.y + 1.5, h.fz, { size: big ? 18 + Math.min(10, h.hx) : 9, dust: true });
    if (big) {
      // the corners too: the whole house comes down
      const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
      for (const [a, b] of [[-1, -1], [1, 1], [1, -1]]) fx?.explosion?.(h.fx + a * h.hx * 0.7 * c + b * h.hz * 0.7 * s, h.y + 1, h.fz - a * h.hx * 0.7 * s + b * h.hz * 0.7 * c, { size: 11, dust: true });
      app.algAmbience?.smoulder(h.fx, h.y + 2, h.fz, 75, { strength: 0.9, r: 2.5 });
    }
  }
  function setState(h, st) {
    if (h.state === st) return;
    h.state = st;
    field.setState(h.i, st);
    const g = garrisons[h.i];
    if (st === "damaged") {
      dust(h, false);
      if (g) g.blastMul = P.blastMulDamaged;
    }
    if (st === "ruin") {
      dust(h, true);
      // the men inside out by the door, hurt, some killed
      if (g) {
        const G = app.algGarrison;
        [...g.men].forEach((u, k) => {
          G?.exit?.(u, k + 1);
          u.takeDamage?.(P.hurtOnCollapse[0] + Math.random() * (P.hurtOnCollapse[1] - P.hurtOnCollapse[0]));
        });
        g.cap = 0; g.ruined = true;
      }
      // no more stopping a shot or a look: its sight box down to the rubble
      app.algSight?.setBox?.(h.fx, h.fz, h.hx, h.hz, h.yaw, h.y + P.ruinTop);
      app.fogOfWar?.rebuildHeights?.();
      // (its nav footprint STAYS: the ruin keeps its broken shell walls — men walking across went through them)
    }
    app.algDamage?.coverChanged?.();
  }
  return {
    params: P, houses: H, state,
    /** A burst at (x, z) of combat-fx `size` (algDamage.blast). */
    blast(x, z, size) {
      if (size < P.minSize) return;
      for (const h of H) {
        if (h.state === "ruin" || !inside(h, x, z, P.reach + size * 0.08)) continue;
        h.hp -= P.per(size) * (0.8 + Math.random() * 0.4);
        if (h.hp <= 0) setState(h, "ruin");
        else if (h.hp < h.max * P.damagedAt) setState(h, "damaged");
      }
    },
    /** Dev / tests: take a house to a state. */
    force(i, st) { const h = H[i]; if (!h) return; h.hp = st === "ruin" ? 0 : st === "damaged" ? h.max * P.damagedAt * 0.9 : h.max; setState(h, st); },
  };
}
