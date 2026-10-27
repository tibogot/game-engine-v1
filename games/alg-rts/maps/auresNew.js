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
  boutique: [-4.6, 4.6, -3.6, 2.6],
  // the MECHTA (tools/blender/mechta.py): its walls, the doorstep, the ladder and the jars out front
  petite: [-2.7, 2.7, -2.9, 2.2], etage: [-3.7, 3.7, -3.5, 2.9], pente: [-3.5, 4.45, -4.1, 2.9],   // (pente: its outside stair on the right)
  appentis: [-1.85, 1.85, -1.7, 1.65], enclos: [-4.0, 4.0, -3.0, 3.0], tabouna: [-0.9, 0.9, -1.15, 0.8],
  // the DECHRA's (DECHRA_PLAN.md): the mosque and its minaret, a terrace wall's module (its face at z -0.3), the lane steps
  masjid: [-4.6, 6.6, -4.1, 3.6], soutien: [-2.0, 2.0, -0.3, 0.65], escalier: [-1.25, 1.25, -2.45, 1.05], djemaa: [-3.0, 3.0, -1.5, 1.45] };
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
/**
 * A STONE HAMLET, a CLUSTER (2026-10-27, you: "for the layout we should make it better — do what you think will look the
 * best"; the arc read as a ring of lone houses round a 48 m square): the houses SHOULDER TO SHOULDER in short rows, their
 * fronts toward the camera (south, +Z); a second row behind across a 3 m lane (its doors on the lane); a house at each
 * side of a small square in front, facing in — the village's point in that square. Local metres from the site:
 * a row `{ types, x, z }` starts at x (its left end) with its FRONT line at z; `states` per index; a side house
 * `{ type, x, z }` its footprint's centre, facing the square. Each house its own levelled pad (algGame).
 * The hamlet's smaller pieces (the mechta kit's — the town's PROPS: no garrison, no sight box): a row's `yards` (its
 * houses' indices) get a WALLED YARD behind them, its open side 15 cm into the house's back wall; `props`
 * `{ type, x, z }` (a lean-to, an oven) their footprint's centre, facing the camera. Returns { houses, props }.
 */
function hamlet(sx, sz, { rows, sides = [], props = [] }) {
  const houses = [], extra = [];
  for (const { types, x, z, gap = 0.2, states = {}, yards = [] } of rows) {
    let lx = x;
    types.forEach((ty, k) => {
      const [x0, x1, z0, z1] = FOOT[ty].map((v) => v * HS), w = x1 - x0, d = z1 - z0;
      const cx = sx + lx + w / 2, cz = sz + z - d / 2 + (k % 2 ? -0.5 : 0.3);   // (the fronts a little in and out: no ruled line)
      houses.push(house(ty, states[k] ?? "intact", cx, cz, cx, cz + 50));
      if (yards.includes(k)) {   // (the house's back wall 0.1 m in from its footprint's back; the yard 3 m deep)
        const front = cz - d / 2 + 0.1 * HS + 0.15, yz = front - FOOT.enclos[3] * HS;
        extra.push(house("enclos", "intact", cx, yz, cx, yz + 50));
      }
      lx += w + gap;
    });
  }
  for (const { type, x, z, state = "intact" } of sides) houses.push(house(type, state, sx + x, sz + z, sx, sz + z));
  for (const { type, x, z, state = "intact" } of props) extra.push(house(type, state, sx + x, sz + z, sx + x, sz + z + 50));
  return { houses, props: extra };
}
/**
 * A TERRACED VILLAGE (2026-10-27, DECHRA_PLAN.md — the stone dechra): rows of houses up the slope, each row on its
 * TERRACE, a dry-stone retaining wall along each terrace's downhill edge, steps up through the walls. In the slope's
 * frame: `f` the way DOWNHILL (the houses' fronts face it), u along the contour, v downhill from the site.
 *   rows   { types, u, v, level }   v the row's FRONT line; its houses shoulder to shoulder from u
 *   walls  { u0, v, level, n }      n wall modules from u0, their face at v, standing on terrace `level` - 1
 *   props  { type, u, v, level, pad } (steps, the djemaa…) their footprint's centre
 * Each row carries { site, level, pad } (its 11th field): algGame stands it at the village's base (its level-0 houses'
 * mean ground) + level × 2.6 m (a wall's height), levelling a pad there — the walls and steps (pad false) unlevelled.
 */
const TERRACE_G = 2.0 * HS;
function terraced(key, sx, sz, [fx, fz], { rows, walls = [], props = [] }) {
  const n = Math.hypot(fx, fz), f = [fx / n, fz / n], r = [-f[1], f[0]];
  const at = (u, v) => [sx + u * r[0] + v * f[0], sz + u * r[1] + v * f[1]];
  const facing = (cx, cz) => [cx + f[0] * 50, cz + f[1] * 50];
  const houses = [], extra = [];
  for (const { types, u, v, level, gap = 0.2, states = {} } of rows) {
    let lu = u;
    types.forEach((ty, k) => {
      const [x0, x1, z0, z1] = FOOT[ty].map((q) => q * HS), w = x1 - x0, d = z1 - z0;
      const [cx, cz] = at(lu + w / 2, v - d / 2 + (k % 2 ? -0.4 : 0.2));
      houses.push([...house(ty, states[k] ?? "intact", cx, cz, ...facing(cx, cz)), { site: key, level }]);
      lu += w + gap;
    });
  }
  for (const { u0, v, level, n: count } of walls) {
    const [x0, x1, z0, z1] = FOOT.soutien.map((q) => q * HS), L = x1 - x0, d = z1 - z0;
    for (let i = 0; i < count; i++) {
      const [cx, cz] = at(u0 + L * (i + 0.5), v - d / 2);   // (end to end: one module's end face against the next's)
      extra.push([...house("soutien", "intact", cx, cz, ...facing(cx, cz)), { site: key, level: level - 1, pad: false }]);
    }
  }
  for (const { type, u, v, level, pad = true, state = "intact" } of props) {
    const [cx, cz] = at(u, v);
    extra.push([...house(type, state, cx, cz, ...facing(cx, cz)), { site: key, level, pad }]);
  }
  return { houses, props: extra };
}
const site = (name) => OLD_LAYOUT.sites.find((s) => s.name === name);
const OA = site("Mechta Ouled Ali"), EO = site("Mechta el Oued"), DE = site("Dechra Tighanimine"), KS = site("Ksar el Hamra");

// THE TWO MECHTAS: the whitewashed kit, five or six houses round each square (one shelled)
// — or, with ?mechta=1 (2026-10-27, MECHTA_PLAN.md: the Aurès' own STONE houses, waiting for your verdict), the mechta
// kit as a CLUSTER (hamlet() above): two rows behind a small square, a house on each side of it; one shelled, one a ruin
const STONE_MECHTA = typeof location !== "undefined" && new URLSearchParams(location.search).get("mechta") === "1";
// (the back row closed by the HILLSIDE house, yards behind two of its houses, a lean-to at each row's end, an oven in the square)
const STONE_OA = STONE_MECHTA && hamlet(OA.x, OA.z, {
  rows: [{ types: ["petite", "etage", "petite"], x: -12, z: -6 },
    { types: ["etage", "petite", "pente"], x: -14, z: -18, states: { 0: "damaged" }, yards: [0, 2] }],
  sides: [{ type: "petite", x: -15.5, z: 1 }, { type: "petite", x: 15.5, z: 0, state: "ruin" }],
  props: [{ type: "appentis", x: 14.8, z: -8.2 }, { type: "appentis", x: -16.7, z: -20.2 }, { type: "tabouna", x: 8, z: 2 }] });
const STONE_EO = STONE_MECHTA && hamlet(EO.x, EO.z, {
  rows: [{ types: ["etage", "petite"], x: -8.5, z: -6, states: { 1: "ruin" } },
    { types: ["petite", "pente", "petite"], x: -12, z: -17.5, yards: [1] }],
  sides: [{ type: "petite", x: -13.5, z: 0.5, state: "damaged" }],
  props: [{ type: "appentis", x: 11.0, z: -8.2 }, { type: "tabouna", x: 6, z: 2 }] });
const MECHTA_OA = STONE_OA ? STONE_OA.houses : village(OA.x, OA.z, ["cour", "maison", "haute", "boutique", "cour", "haute"], { ring: [30, -178, -2], damaged: 2 });
const MECHTA_EO = STONE_EO ? STONE_EO.houses : village(EO.x, EO.z, ["haute", "cour", "maison", "boutique", "haute"], { ring: [27, -178, -2], damaged: 3 });
// THE STONE DECHRA (?dechra=1 while you judge it — DECHRA_PLAN.md): four terraces up the slope (it falls toward
// +0.6 x +0.8 z, ~17°: measured), the mechta's houses shoulder to shoulder on each, a retaining wall along every
// terrace with steps through it; the DJEMAA square (the village's point) in the second row's gap; the MOSQUE at the top,
// its minaret the landmark. One house shelled, one a ruin.
const STONE_DECHRA = typeof location !== "undefined" && new URLSearchParams(location.search).get("dechra") === "1";
const STONE_DE = STONE_DECHRA && terraced("DE", DE.x, DE.z, [0.6, 0.8], {
  rows: [
    { types: ["petite", "etage", "petite", "etage"], u: -17, v: 17, level: 0 },
    { types: ["etage", "petite"], u: -23, v: 4, level: 1, states: { 1: "damaged" } },   // (the square between)
    { types: ["petite", "pente"], u: 6, v: 4, level: 1 },
    { types: ["petite", "etage", "petite", "etage", "petite"], u: -20, v: -9, level: 2, states: { 3: "ruin" } },
    { types: ["petite", "masjid", "petite"], u: -14.5, v: -22, level: 3 },
  ],
  walls: [
    { u0: -21.77, v: 5.6, level: 1, n: 4 }, { u0: 2.27, v: 5.6, level: 1, n: 4 },
    { u0: -24.6, v: -7.4, level: 2, n: 5 }, { u0: 4.6, v: -7.4, level: 2, n: 4 },
    { u0: -16.7, v: -20.4, level: 3, n: 3 }, { u0: 2.1, v: -20.4, level: 3, n: 3 },
  ],
  props: [
    { type: "escalier", u: 0.65, v: 6.64, level: 0, pad: false }, { type: "escalier", u: 3.0, v: -6.37, level: 1, pad: false },
    { type: "escalier", u: 0.5, v: -19.36, level: 2, pad: false },
    { type: "djemaa", u: -3, v: -2, level: 1 }, { type: "tabouna", u: 4, v: 1.5, level: 1 },
  ] });
// (without ?dechra=1: the M'zab kit's plain houses as before, two rows)
const DECHRA = STONE_DE ? STONE_DE.houses : [
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
  // (+ the old procedural wells: the Blender village props put one in each square — MAP.villageProps)
  skip: ["wellHamlet1", "wellHamlet2", "wellDechra", "mechta", "mechta2", "dechra", "ksar", "gardenOA1", "gardenOA2", "threshOA", "gardenEO1", "gardenEO2", "threshEO", "terracesEO",
    "terracesD1", "terracesD2", "terracesD3", "gardenD", "threshD", "terracesOpen1", "terracesOpen2", "terracesOpen3", "terracesOpen4"],
  // (the old almond terraces of the open slopes, algLandmarks: none)
  // (the lone trees and outcrops keep off the cover runs and the supply points — tools/algAuresNewFields.mjs COVER_CLEAR)
  scenery: { over: { terraces: 0 }, keepClear: COVER_CLEAR },
  // (its farmsteads, ruins, rocks and lone trees: scattered in the OLD box, so they stay where they were — algLandmarks)
  sceneryBox: OLD_PLAY,
  // the village life in Blender (tools/blender/villageProps.py): haystacks, firewood, ovens, hives round each village;
  // a well, a trough, jars and benches in its square (algVillageLife)
  villageProps: true,
  // the boulder groups of the cover pass (the gully mouths, the ravine pass, the west slopes)
  sandstone: { ...(OLD_MAP.sandstone ?? {}), rocks: COVER_ROCKS },
  // (no trampled-yard splat at the villages: its 2.4 m photo repeated across the square — seen)
  splats: { yards: false },
  // the supply points: the old map's, the South pass moved in from (31, -241) — outside the tighter box — to the flatter
  // ground beside its track
  supply: OLD_MAP.supply.map((p) => (p.name === "South pass" ? { ...p, x: 55, z: -190 } : p)),
  fields: { plots: FIELD_PLOTS, walls: FIELD_WALLS, hedges: FIELD_HEDGES },
  town: { houses: [...MECHTA_OA, ...MECHTA_EO, ...DECHRA, ...KSAR], props: [...(STONE_OA?.props ?? []), ...(STONE_EO?.props ?? []), ...(STONE_DE?.props ?? [])], replacesHamlet: true },
};
