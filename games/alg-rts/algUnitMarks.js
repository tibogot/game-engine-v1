// UNIT MARKS — every man readable at a glance (2026-10-07, CoH audit 2 item 6: in a staged fight
// at play zoom the men were small khaki figures on green grass, nothing to find them by unless
// selected). A thin TEAM-COLOURED ring on the ground under each man on foot: blue yours, red an
// enemy you can SEE (the fog decides), faint — a mark, not a selection. A selected man keeps his
// selection ring instead; a man in a house has none (the house's badge says it).
//
// ONE draw for all of them (shared selectionRingField: an instanced ring draped on the ground).
// Per frame: one pass over the units, ~6 floats each. ?marks=0 = without.
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";

export const UNIT_MARKS = {
  radius: 0.95,             // m, the ring's outer edge (a man's footprint at 1.3x scale)
  player: 0x5aa0ff,
  enemy: 0xff5a46,
  opacity: 0.55,
};

export function createAlgUnitMarks(app, { units, selection, fogOfWar = null, params = UNIT_MARKS }) {
  const P = params;
  const field = createSelectionRingField({ app, max: 512, inner: 0.72, segments: 24, opacity: P.opacity });
  field.mesh.name = "UnitMarks";
  let on = true;

  function frame() {
    field.begin();
    if (on) {
      const sel = new Set(selection?.selected ?? []);
      for (const u of units.list) {
        if (!u.alive || u.inside || u.vanished || u.ghost || !u.type?.foot || sel.has(u)) continue;
        if (u.team === "enemy" && fogOfWar?.enabled && !fogOfWar.isVisible(u.position.x, u.position.z)) continue;
        if (u.team !== "player" && u.team !== "enemy") continue;
        field.add(u.position.x, u.position.z, P.radius, u.team === "player" ? P.player : P.enemy);
      }
    }
    field.commit();
  }

  return {
    params: P, frame,
    setEnabled(v) { on = !!v; },
    get enabled() { return on; },
    dispose() { field.dispose(); },
  };
}
