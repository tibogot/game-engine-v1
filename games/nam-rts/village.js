// A HAMLET — the arrangement, not the pieces.
//
// The kit (v3/render/objects/rtsVillage.js + rtsVillageHut.js) builds houses,
// granaries, fences and clutter. What makes those read as a village is where
// they stand relative to each other, and that is this file.
//
// THE RULES THE PLAN FOLLOWS, which are what a real hamlet does:
//
//   1. A LANE, and everything faces it. Houses stand back from it in two
//      staggered rows with their doors toward it; nothing is ever laid on a
//      grid. The lane stays clear end to end, so units move THROUGH the
//      village instead of round it — a village you cannot walk into is scenery.
//   2. YARDS. A fence along each frontage with a gap in front of the door.
//      Fences are what turn scattered props into property: a house with a
//      fenced yard reads as somebody's, a house without reads as a model.
//   3. THE CLUTTER LIVES AT THE DOORS. Jars, a drying rack, a straw rick, a
//      cooking hearth — all within a few metres of a doorway, never out in the
//      open, because that is where people put things down.
//   4. A CENTRE. The well where the lane widens, the spirit shrine beside it.
//      Every village has a place people stand, and it gives the eye somewhere
//      to land.
//   5. NOTHING REPEATS. Two house types, alternating rows, every piece its own
//      seed and its own few degrees off square.
//
// The plan is PURE DATA (`hamletPlan`), so the layout can be tested without a
// renderer: spacing, the clear lane, and nothing standing inside anything else.
import * as THREE from "three";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { buildVillageHutLod0 } from "../../v3/render/objects/rtsVillageHut.js";
import {
  buildBambooClump, buildBananaClump, buildBigRoofHouse, buildCookHearth, buildDryingRack,
  buildFence, buildGranary, buildJarCluster, buildOxCart, buildPigPen, buildShrine,
  buildStrawRick, buildWashingLine, buildWell,
} from "../../v3/render/objects/rtsVillage.js";

/** The lane, and how much room each kind of piece needs around its centre. */
export const HAMLET = {
  laneHalf: 5,        // metres either side of the lane's centre line, kept clear
  laneLength: 72,
  radius: 52,         // everything is inside this of the hamlet's centre
  // The room each kind takes, as the RECTANGLE it really is and not a circle
  // round it: a house is half as deep as it is wide, a cart is a long thin
  // thing with its shafts on the ground, a drying rack is a table. Spacing them
  // as circles pushes everything a couple of metres further apart than it
  // should be, which is exactly how a village stops looking like one.
  // (Measured from the built geometry; the test checks they still fit.)
  size: {
    bigHouse: { hx: 4.6, hz: 4.9 }, stiltHouse: { hx: 5.9, hz: 4.0 },
    granary: { hx: 1.9, hz: 2.2 }, well: { hx: 2.7, hz: 2.7 }, shrine: { hx: 0.6, hz: 0.6 },
    jars: { hx: 1.5, hz: 1.2 }, rack: { hx: 1.5, hz: 0.9 }, rick: { hx: 1.7, hz: 1.6 },
    hearth: { hx: 1.5, hz: 0.8 }, cart: { hx: 1.5, hz: 4.4 }, fence: { hx: 0, hz: 0.35 },
    bamboo: { hx: 3.2, hz: 2.9 }, banana: { hx: 3.4, hz: 2.5 },
    pigPen: { hx: 2.4, hz: 1.9 }, washing: { hx: 2.8, hz: 0.4 },
    // The TRUNK. The fan is six metres up and may spread over anything.
    travellersPalm: { hx: 0.5, hz: 0.5 },
  },
  // A house's WALLS, inside the eaves. Jars, a rack or a fence may stand under
  // the overhang — that is where a real one keeps them, out of the rain — but
  // nothing may stand inside the walls. Buildings are spaced by the roof; the
  // clutter round their doors is spaced by this.
  walls: {
    bigHouse: { hx: 3.7, hz: 3.0 },
    stiltHouse: { hx: 3.8, hz: 3.1 },
  },
};

/**
 * The hamlet's pieces in LOCAL metres: lane along X, +Z is the far row. Pure
 * data — no geometry, no app — so the layout is testable on its own.
 */
export function hamletPlan() {
  const out = [];
  const add = (kind, x, z, rotY = 0, extra = {}) => out.push({ kind, x, z, rotY, ...extra });

  // ── The two rows of houses ─────────────────────────────────────────────────
  // Near row (-Z) has its doors toward the lane at rotY 0; far row is turned
  // about so its doors face back down the lane. Staggered, so no two houses
  // ever stand opposite each other across it.
  const near = [
    ["bigHouse", -27, -12.5, 0.05, 3],
    ["stiltHouse", -9.5, -14, -0.07, 9],
    ["bigHouse", 9, -12.8, 0.04, 21],
    ["stiltHouse", 27.5, -14.5, 0.09, 33],
  ];
  const far = [
    ["stiltHouse", -19, 14.5, Math.PI - 0.05, 41],
    ["bigHouse", 1.5, 17, Math.PI + 0.06, 47],
    ["stiltHouse", 20, 15, Math.PI - 0.08, 53],
  ];
  for (const [kind, x, z, rotY, seed] of [...near, ...far]) add(kind, x, z, rotY, { seed });

  // ── The centre: the well where the lane widens, the shrine beside it ───────
  add("well", 3, 8.6, 0.2, { seed: 7 });
  add("shrine", -3.5, 7.2, 0.35, { seed: 11 });

  // ── Behind each house: the granary and the straw rick ──────────────────────
  // Rice is stored AWAY from the lane — behind the house, in the back yard.
  add("granary", -30, -20.5, 0.3, { seed: 5 });
  add("granary", 6, -21, -0.25, { seed: 15 });
  add("granary", -22, 22, 0.15, { seed: 25 });
  add("granary", 23.5, 22.5, -0.3, { seed: 35 });
  add("rick", -20, -20, 0, { seed: 23 });
  add("rick", 16.5, -21.2, 0, { seed: 27 });
  add("rick", 8, 23.6, 0, { seed: 43 });

  // ── At the doors ───────────────────────────────────────────────────────────
  add("jars", -21, -9.2, 0.4, { seed: 17 });
  add("jars", 12.5, -7.8, -0.5, { seed: 37 });
  add("jars", 14, 10.6, 2.4, { seed: 57 });
  add("rack", -14.5, -8.2, 0.12, { seed: 19 });
  add("rack", 22, -8.5, -0.2, { seed: 39 });
  add("rack", 23, 9.4, Math.PI + 0.2, { seed: 59 });
  add("hearth", -33, -8.8, 0.5, { seed: 29 });
  add("hearth", 3.5, -8.4, -0.4, { seed: 49 });
  add("hearth", -24.5, 10.4, 1.1, { seed: 69 });
  add("cart", -34, 8.5, 1.35, { seed: 31 });

  // ── What they planted ──────────────────────────────────────────────────────
  // BAMBOO round the outside, which is what a hamlet's edge actually is — a
  // planted windbreak, a fence and the building supply, all one thing — and
  // BANANA in the back yards, where every house keeps it. Without them the
  // village is a clearing with houses in it, which is what it looked like.
  add("bamboo", -41, -12, 0, { seed: 37 });
  add("bamboo", -39, 17, 0, { seed: 39 });
  add("bamboo", 38, -17, 0, { seed: 45 });
  add("bamboo", 36, 20, 0, { seed: 51 });
  add("bamboo", 1, -28, 0, { seed: 55 });
  add("banana", -27, -28.5, 0.4, { seed: 41 });
  add("banana", 13, -28, 1.1, { seed: 61 });
  add("banana", -12, 22, 2.2, { seed: 71 });
  add("banana", 28, 11.5, 0.7, { seed: 81 });
  add("pigPen", -7, -22, 0.25, { seed: 43 });
  add("washing", -4.5, -9.6, 0.1, { seed: 47 });
  // TRAVELLER'S PALMS, the ornamental: a pair framing the square behind the
  // well and the shrine, and one in a back yard. Fans face the camera, not
  // the lane (see placeHamlet).
  // Planted, not grown — that is what a pair of them SAYS. Drawn by the
  // engine's placed foliage (placedPlants.js), not the kit.
  add("travellersPalm", -9.5, 10.5, 0.1, { seed: 0.21, scale: 0.95 });
  add("travellersPalm", 8.5, 10.8, -0.08, { seed: 0.58, scale: 1.05 });
  add("travellersPalm", 18.5, -24.5, 0.3, { seed: 0.83, scale: 0.85 });

  // ── Fences: the frontages, each with a gap in front of a door ──────────────
  // Runs along the lane at the yard line, and a return down one side of each
  // yard so it reads as an enclosure rather than a hedge.
  const front = [
    [-31, -6.4, 11, true], [-16, -6.6, 12, true], [4, -6.5, 13, true], [23, -6.8, 12, true],
    // Nothing fenced across the middle of the far side: that is the open
    // ground the well and the shrine stand on, and the village's one square.
    [-22, 7.6, 12, true], [-11, 7.4, 7, false], [19, 7.8, 12, true],
  ];
  for (const [x, z, len, gate] of front) add("fence", x, z, 0, { length: len, gate, seed: 100 + x });
  const sides = [
    [-36.5, -13, 13, Math.PI / 2], [-1, -13.5, 13, Math.PI / 2],
    [18, -13, 12, Math.PI / 2], [-28, 15, 13, Math.PI / 2], [11, 14.5, 13, Math.PI / 2],
  ];
  for (const [x, z, len, rotY] of sides) add("fence", x, z, rotY, { length: len, seed: 200 + x });
  return out;
}

/** World position of a local plan point, for a hamlet centred at (cx, cz). */
export function toWorld(p, { x: cx, z: cz, rotY = 0 }) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return { x: cx + p.x * c + p.z * s, z: cz - p.x * s + p.z * c, rotY: p.rotY + rotY };
}

/**
 * The stilt house at HAMLET proportions: lower walls, a DEEPER overhang and a
 * shallower pitch than the lab's defaults. Stock, it stood beside the
 * big-roofed house as a pale flat-walled box — in a village the roof has to be
 * most of what you see and the walls have to be in its shade. Exported so the
 * test measures the house the game actually builds, and not another one.
 */
export const STILT_HOUSE = {
  width: 7.4, depth: 6.0, stilt: 1.05, wallHeight: 2.2,
  pitch: 0.78, overhang: 2.0, gableOverhang: 1.0, courses: 10, thatchToneSpread: 0.38,
};

/** Build one piece's geometry. Houses carry their own seed so none repeats. */
function geometryFor(p) {
  switch (p.kind) {
    case "bigHouse": return buildBigRoofHouse({ seed: p.seed });
    // Every second roof keeps a paler, newer thatch (`thatchTone`).
    case "stiltHouse": return buildVillageHutLod0({ ...STILT_HOUSE, seed: p.seed, thatchTone: p.seed % 2 ? 0.14 : 0.34 });
    case "granary": return buildGranary({ seed: p.seed });
    case "well": return buildWell({ seed: p.seed });
    case "shrine": return buildShrine({ seed: p.seed });
    case "fence": return buildFence({ seed: p.seed, length: p.length, gate: p.gate });
    case "jars": return buildJarCluster({ seed: p.seed });
    case "rack": return buildDryingRack({ seed: p.seed });
    case "rick": return buildStrawRick({ seed: p.seed });
    case "hearth": return buildCookHearth({ seed: p.seed });
    case "cart": return buildOxCart({ seed: p.seed });
    case "bamboo": return buildBambooClump({ seed: p.seed });
    case "banana": return buildBananaClump({ seed: p.seed, plants: 2 + (p.seed % 3) });
    case "pigPen": return buildPigPen({ seed: p.seed });
    case "washing": return buildWashingLine({ seed: p.seed });
    default: return null;
  }
}

/**
 * How each kind meets the world. Houses take a levelled pad, block the way and
 * stop bullets; a FENCE does none of those — a woven fence stops nothing, and
 * blocking nav with it would wall the hamlet off with 4 m nav cells for the
 * sake of a metre of bamboo. Clutter stands on the ground as it lies.
 */
const PLACEMENT = {
  bigHouse: { pad: true, clear: 10, apron: 1.2 },
  stiltHouse: { pad: true, clear: 11, apron: 1.2 },
  granary: { pad: true, clear: 5 },
  well: { pad: true, clear: 6 },
  rick: { pad: false, nav: true, cover: true, clear: 4 },
  cart: { pad: false, nav: true, cover: false, clear: 3.5 },
  // Bamboo is a THICKET: you walk round it and it stops a bullet. Banana you
  // walk straight through, and it hides nothing worth hiding.
  bamboo: { pad: false, nav: true, cover: true, clear: 4 },
  banana: { pad: false, nav: false, cover: false, clear: 3 },
  pigPen: { pad: true, clear: 4 },
  washing: { pad: false, nav: false, cover: false, clear: 2 },
  shrine: { pad: false, nav: false, cover: false, clear: 2.5 },
  fence: { pad: false, nav: false, cover: false, clear: 2 },
  jars: { pad: false, nav: false, cover: false, clear: 2.5 },
  rack: { pad: false, nav: false, cover: false, clear: 3 },
  hearth: { pad: false, nav: false, cover: false, clear: 2.5 },
};

/**
 * Place a hamlet centred on (x, z), through placedObjects (pads, nav, cover,
 * vegetation, merged draws). The jungle is opened along the whole lane first:
 * a village stands in a CLEARING, and clearing per piece leaves grass standing
 * in the middle of the lane.
 */
export async function placeHamlet(app, placed, { x, z, rotY = 0 } = {}) {
  const mat = rtsObjectMaterial();
  const items = [];
  // The clearing: three overlapping discs down the lane rather than one huge
  // one, so the hamlet's ground is a lane-shaped opening and not a crop circle.
  for (const t of [-1, 0, 1]) {
    const p = toWorld({ x: t * 24, z: 0, rotY: 0 }, { x, z, rotY });
    app.clearVegetation?.(p.x, p.z, 26, { grass: 21 });
  }
  for (const p of hamletPlan()) {
    const geo = geometryFor(p);
    if (!geo) continue;
    const w = toWorld(p, { x, z, rotY });
    items.push({
      obj: new THREE.Mesh(geo, mat), x: w.x, z: w.z, rotY: w.rotY,
      // A hut stands on SWEPT EARTH — its yard, broomed daily — not on the
      // laterite pad a firebase bulldozes (buildingAprons.js).
      ground: "swept",
      ...(PLACEMENT[p.kind] ?? {}),
    });
  }
  await placed.place(items);
  // Planted plants after the pads, so each stands on the final ground.
  let plants = 0;
  for (const p of hamletPlan()) {
    if (p.kind !== "travellersPalm" || !app.plant) continue;
    const w = toWorld(p, { x, z, rotY });
    // The fan faces the DEFAULT camera (looking +Z), whatever way the site is
    // turned: an ornamental is there to be seen, and edge-on it is a pole.
    app.plant(p.kind, w.x, w.z, { rotY: p.rotY, scale: p.scale, seed: p.seed });
    plants++;
  }
  return items.length + plants;
}
