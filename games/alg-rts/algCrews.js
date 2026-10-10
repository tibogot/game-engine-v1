// CREWS BAIL OUT (2026-10-10, the CoH gaps): a French vehicle destroyed is not always its crew dead.
// Out of the wreck come the ones who made it — none to all of them, each hurt — as a small
// ÉQUIPAGE squad (algSquads.js SQUADS.equipage): selectable, it can retreat, it fights with MAT 49s
// at short range, it can't be reinforced (a crew is not replaced by appelés). They run a few metres
// clear of the burning wreck first. Their own type (algUnitTypes.js equipage): black berets, no grenades.
// The helicopter's crew does not (it falls in the djebel).

const P = {
  crew: { willys: 2, gmc: 2, halftrack: 3, amx13: 3, ebr: 3 },
  survive: 0.55,        // each man's chance of getting out
  hp: [0.35, 0.8],      // what he has left, of his max
  clear: 9,             // m: run this far from the wreck
};

export function createAlgCrews(app, { units, squads, navGrid, rng = Math.random }) {
  /** A vehicle died: its crew, those who get out. Returns the squad (or null). */
  function bail(v) {
    const n = P.crew[v.typeKey];
    if (!n || v.team !== "player" || v.isAir) return null;
    const out = [];
    for (let i = 0; i < n; i++) if (rng() < P.survive) out.push(i);
    if (!out.length) return null;
    const h = v.heading ?? 0, back = (v.radius ?? 3) + 1;
    const men = [];
    out.forEach((_, k) => {
      // Out of the hatches / doors, round the back of the hull.
      const a = h + Math.PI + (k - (out.length - 1) / 2) * 0.9;
      const w = navGrid?.nearestOpenWorld(v.position.x + Math.sin(a) * back, v.position.z + Math.cos(a) * back, true) ?? { x: v.position.x + Math.sin(a) * back, z: v.position.z + Math.cos(a) * back };
      const u = units.spawn("equipage", w.x, w.z, { team: v.team });
      if (!u) return;
      u.hp = u.maxHp * (P.hp[0] + rng() * (P.hp[1] - P.hp[0]));
      men.push(u);
    });
    if (!men.length) return null;
    squads.adopt(men, "equipage");
    // Away from the fire: a few metres on, the way each came out.
    men.forEach((u) => {
      const dx = u.position.x - v.position.x, dz = u.position.z - v.position.z, d = Math.hypot(dx, dz) || 1;
      const to = navGrid?.nearestOpenWorld(v.position.x + (dx / d) * P.clear, v.position.z + (dz / d) * P.clear, true) ?? { x: v.position.x + (dx / d) * P.clear, z: v.position.z + (dz / d) * P.clear };
      u.orderTo(to.x, to.z);
    });
    return squads.of(men[0]);
  }
  return { params: P, bail };
}
