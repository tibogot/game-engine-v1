// MISSION 2 — THE NORTH CONSTANTINOIS COAST, AUGUST 1955 (the Philippeville
// uprising, the El Halia mine). ?map=coast.
//
// World metres, north up = -Z. The map (public/levels/alg-coast.v3proj, built
// by tools/algCoastLevel.mjs from algDem --site coast-filfila: 3 km of the
// real coast west of the Filfila massif in 1024 m, real slopes): a bay in the
// north-west, its beach plain, a cliffed headland rising to the north-east,
// low ridges inland to the east. Sea level 20 m.
//
// AS WALKABLE AS THE AURÈS, OR MORE (you, 2026-10-04 — CoH ground is near
// flat; cover comes from what stands on it, not from cliffs). The box,
// MEASURED (tools/algMapBox.mjs --box 500 --at 100,-20): sea along the north
// and west edges, land 84% (21 ha), walkable 99.6%, gentle ≤15° 83% (the
// Aurès box: 94%, 57%), no neck under 24 m.
//
// PROVISIONAL: the starts below only let the map load (the view needs both);
// the post, the ALN start, the points and the AI are step 6 of the mission.

/** THE PLAYABLE AREA: 500 m, the bay's shore along its north and west. */
export const PLAY = { x0: -150, x1: 350, z0: -270, z1: 230 };

export const LAYOUT = {
  sites: [
    // ── Starts (PROVISIONAL) ────────────────────────────────────────────────
    // The post on the plain behind the beach; the ALN in the ridges inland.
    { kind: "french", name: "Poste de la plage", x: -30, z: 130, r: 34, turn: 35 },
    { kind: "aln", name: "Katiba des crêtes", x: 290, z: -120, r: 26, turn: -30 },
  ],
  wadis: [],
};

export const MAP = {
  id: "coast",
  name: "Côte du Constantinois — août 1955",
  level: "/levels/alg-coast.v3proj",
  tracks: [],
  supply: [],
  handPlaced: false,
};
