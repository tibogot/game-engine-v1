// LES AURÈS — 1956, REBUILT (2026-10-22, you: "keep the old Aurès as legacy … maybe we need a new Aurès because the
// terrain itself is cool"). THE SAME GROUND AND LAYOUT as the old map (maps/aures.js — untouched, the legacy map: its
// level file, its sites, wadis, tracks, supply points, gardens and terraces), with what stands on it REBUILT from the
// new kits, village by village:
//   · the merged procedural villages (the two mechtas, the dechra, the ksar) are left out (MAP.skip) and each is
//     rebuilt as SEPARATE houses of the Blender kits (algHouse.js) in the map's TOWN field — garrisons, damage and
//     collapse (algTownDamage) from day one, each on its own levelled pad (algGame: a row without a baked height);
//   · the old gardens, terraces and threshing floors left out too: the Oued Abdi's FIELDS in their place (tools/
//     algAuresNewFields.mjs: soil decals and barley in the map's OWN copy of the level, alg-aures-new.v3proj; the
//     Blender dry-stone walls and the prickly-pear hedges in MAP.fields);
//   · the rest arrives as it is rebuilt (the post, the stone dechra kit, the field walls, the stones…).
// ?map=auresNew (the menu's "Les Aurès — 1956"; the old map is "Les Aurès (ancien)"). Plan: games/alg-rts/AURES_NEW_PLAN.md.
import { LAYOUT as OLD_LAYOUT, MAP as OLD_MAP, PLAY as OLD_PLAY } from "./aures.js";
import { t } from "../i18n/i18n.js";
import { COVER_CLEAR, COVER_ROCKS, FIELD_HEDGES, FIELD_PLOTS, FIELD_WALLS } from "./auresNewFields.js";

// THE PLAY BOX, TIGHTER (2026-10-24, you: "the Aurès is quite a big map for an RTS compared to Company of Heroes … we
// might adapt it"; "make the best, our inspiration is CoH 3"). The old 610 x 610 m kept its empty north-east and far
// south — nothing to hold there, ground only crossed. The north edge in from -285 to -225 (the katiba camp at -162
// keeps its back), the south from 325 to 280 (the post and the helipad keep theirs): 610 x 505 m. Its soldiers run
// 5.5 m/s — post to the far villages ~60 s, CoH's rhythm. What is left gets its COVER (tools/algAuresNewFields.mjs).
export const PLAY = { ...OLD_PLAY, z0: -225, z1: 280 };
export const LAYOUT = OLD_LAYOUT;

// ── The houses: the kits' footprints (local real metres x0 x1 z0 z1, the front at -Z; the game ×1.3 — tools/algAbdiLevel.mjs
// and maps/training.js) ────────────────────────────────────────────────────────────────────────────────────────
const FOOT = { dar: [-3.6, 3.6, -3.9, 3.4], tour: [-2.6, 2.6, -3.3, 2.8], bas: [-3.2, 3.2, -4.0, 4.6], terrasse: [-3.0, 7.45, -3.5, 3.0],
  souk: [-6.0, 6.0, -5.0, 2.4], mosquee: [-6.0, 6.0, -6.5, 6.5], maison: [-3.8, 8.45, -3.5, 3.0], haute: [-2.6, 2.6, -3.7, 2.8], cour: [-3.4, 3.4, -4.2, 5.0],
  boutique: [-4.6, 4.6, -3.6, 2.6] };
const HS = 1.3;
const rotY = (th, lx, lz) => [lx * Math.cos(th) + lz * Math.sin(th), -lx * Math.sin(th) + lz * Math.cos(th)];
/** A house whose FOOTPRINT's centre is (cx, cz), its front toward (tx, tz): the town field's row (y null: a pad). */
function house(type, state, cx, cz, tx, tz) {
  const [x0, x1, z0, z1] = FOOT[type].map((v) => v * HS), th = Math.atan2(-(tx - cx), -(tz - cz));
  const [ox, oz] = rotY(th, (x0 + x1) / 2, (z0 + z1) / 2);
  return [type, state, cx - ox, null, cz - oz, th, cx, cz, (x1 - x0) / 2, (z1 - z0) / 2];
}
/**
 * A village: its houses on an ARC round a small square at (sx, sz), their fronts toward it — the arc on the side away
 * from the camera (north, -Z) so every front faces the player at three-quarters (you: buildings face the camera), a
 * gap of `gap` m between neighbours' FRONT corners (the fronts converge on the square). `ring`: [radius of the footprints'
 * centres, from°, to°] (atan2(z, x) degrees: -90 = north).
 */
function village(sx, sz, types, { ring = [22, -168, -12], gap = 3.5, damaged = -1 } = {}) {
  const [R, a0, a1] = ring, out = [];
  let a = (a0 * Math.PI) / 180;
  types.forEach((ty, k) => {
    const [x0, x1, z0, z1] = FOOT[ty].map((v) => v * HS), w = x1 - x0, Rf = R - (z1 - z0) / 2;
    a += (w / 2) / Rf;
    if (a > (a1 * Math.PI) / 180) return;
    out.push(house(ty, k === damaged ? "damaged" : "intact", sx + R * Math.cos(a), sz + R * Math.sin(a), sx, sz));
    a += (w / 2 + gap) / Rf;
  });
  return out;
}
const site = (name) => OLD_LAYOUT.sites.find((s) => s.name === name);
const OA = site("Mechta Ouled Ali"), EO = site("Mechta el Oued"), DE = site("Dechra Tighanimine"), KS = site("Ksar el Hamra");

// THE TWO MECHTAS: the whitewashed kit, five or six houses round each square (one shelled)
const MECHTA_OA = village(OA.x, OA.z, ["cour", "maison", "haute", "boutique", "cour", "haute"], { ring: [30, -178, -2], damaged: 2 });
const MECHTA_EO = village(EO.x, EO.z, ["haute", "cour", "maison", "boutique", "haute"], { ring: [27, -178, -2], damaged: 3 });
// THE DECHRA up its slope: the M'zab kit's plain houses (ochre plaster — the stone dechra kit to come), two rows
const DECHRA = [
  ...village(DE.x, DE.z, ["bas", "dar", "bas", "terrasse", "bas"], { ring: [21, -170, -10] }),
  ...village(DE.x, DE.z, ["dar", "bas", "dar", "tour", "dar", "bas"], { ring: [37, -165, -15], damaged: 4 }),
];
// THE KSAR on its knoll: the mosque on the summit, two rings of M'zab houses round it (the town of the Ghardaïa photo)
const KSAR = [
  house("mosquee", "intact", KS.x, KS.z, KS.x, KS.z + 30),
  ...village(KS.x, KS.z, ["dar", "tour", "dar", "terrasse", "dar", "tour"], { ring: [24, -205, 25], gap: 3 }),
  ...village(KS.x, KS.z, ["dar", "bas", "tour", "dar", "terrasse", "dar", "bas", "dar"], { ring: [40, -210, 30], gap: 3.5, damaged: 5 }),
];

export const MAP = {
  ...OLD_MAP,
  id: "auresNew",
  base: "aures",   // (the Aurès' briefing, post name and map title — algBattle, algUnits, tacticalMap)
  name: t("Aurès · vallée de Tighanimine"),
  level: "/levels/alg-aures-new.v3proj",
  // the old merged villages, left out: rebuilt below as separate houses; the old gardens, terraces and threshing
  // floors: the fields below
  skip: ["mechta", "mechta2", "dechra", "ksar", "gardenOA1", "gardenOA2", "threshOA", "gardenEO1", "gardenEO2", "threshEO", "terracesEO",
    "terracesD1", "terracesD2", "terracesD3", "gardenD", "threshD", "terracesOpen1", "terracesOpen2", "terracesOpen3", "terracesOpen4"],
  // (the old almond terraces of the open slopes, algLandmarks: none)
  // (the lone trees and outcrops keep off the cover runs and the supply points — tools/algAuresNewFields.mjs COVER_CLEAR)
  scenery: { over: { terraces: 0 }, keepClear: COVER_CLEAR },
  // (its farmsteads, ruins, rocks and lone trees: scattered in the OLD box, so they stay where they were — algLandmarks)
  sceneryBox: OLD_PLAY,
  // the boulder groups of the cover pass (the gully mouths, the ravine pass, the west slopes)
  sandstone: { ...(OLD_MAP.sandstone ?? {}), rocks: COVER_ROCKS },
  // (no trampled-yard splat at the villages: its 2.4 m photo repeated across the square — seen)
  splats: { yards: false },
  // the supply points: the old map's, the South pass moved in from (31, -241) — outside the tighter box — to the flatter
  // ground beside its track
  supply: OLD_MAP.supply.map((p) => (p.name === "South pass" ? { ...p, x: 55, z: -190 } : p)),
  fields: { plots: FIELD_PLOTS, walls: FIELD_WALLS, hedges: FIELD_HEDGES },
  town: { houses: [...MECHTA_OA, ...MECHTA_EO, ...DECHRA, ...KSAR], replacesHamlet: true },
};
