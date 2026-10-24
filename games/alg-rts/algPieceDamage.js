// SMALL PIECES THAT BREAK (2026-10-24, building damage C — the field walls, the prickly-pear hedges, the supply points'
// depots): each piece its health; a burst on it (algDamage.blast, as the town's houses) wears it down — DAMAGED below
// `damagedAt` of it, a RUIN at 0, with a puff of dust as it goes. What a state MEANS is the caller's (`onState`: the
// wall's model and its cover, the hedge's plants and its sight, the depot's model); this only keeps the health.
// Not repaired (CoH: a broken wall stays broken).

/**
 * @param app
 * @param o.rows      [{ x, z, r, state }] — a piece's centre, its reach (m) and its starting state; row i is piece i
 * @param o.hp        its health
 * @param o.per       (size) → health taken by a burst of combat-fx `size` (algTownDamage's scale)
 * @param o.onState   (i, state, prev) — the piece's new state
 * @param o.minSize   bursts smaller than this do nothing (rifle fire never reaches here; a grenade is 6)
 * @param o.dust      the puff's size as it breaks (0: none)
 */
export function createPieceDamage(app, { rows, hp, per, onState, minSize = 5, damagedAt = 0.55, dust = 5 }) {
  const P = rows.map((r) => ({ ...r, hp: r.state === "ruin" ? 0 : r.state === "damaged" ? hp * damagedAt * 0.9 : hp }));
  // a grid of 16 m cells: a burst looks at the pieces near it only (hundreds of walls on a map)
  const cells = new Map(), key = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
  P.forEach((p, i) => { const k = key(p.x, p.z); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); });
  function set(i, st) {
    const p = P[i], prev = p.state;
    if (prev === st) return;
    p.state = st;
    if (dust) app.algCombat?.fx?.explosion?.(p.x, (app.getWorldHeight?.(p.x, p.z) ?? 0) + 0.6, p.z, { size: st === "ruin" ? dust * 1.4 : dust, dust: true });
    onState(i, st, prev);
  }
  return {
    pieces: P,
    state: (i) => P[i]?.state ?? "intact",
    /** A burst at (x, z) of combat-fx `size` (algDamage.blast). */
    blast(x, z, size) {
      if (size < minSize) return;
      const reach = 1 + size * 0.15;
      const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const i of cells.get(`${cx + a},${cz + b}`) ?? []) {
          const p = P[i];
          if (p.state === "ruin" || Math.hypot(p.x - x, p.z - z) > p.r + reach) continue;
          p.hp -= per(size) * (0.8 + Math.random() * 0.4);
          if (p.hp <= 0) set(i, "ruin");
          else if (p.hp < hp * damagedAt) set(i, "damaged");
        }
      }
    },
    /** Dev / tests: a piece to a state. */
    force(i, st) { const p = P[i]; if (!p) return; p.hp = st === "ruin" ? 0 : st === "damaged" ? hp * damagedAt * 0.9 : hp; set(i, st); },
  };
}
