// THE ALGERIA GAME'S BIRDS — the shared engine (games/shared-rts/rtsBirds.js)
// with this country's species, built from the shared kit (birdKit.js):
//
//   0 WHITE STORK  flying: white, the flight feathers BLACK (the hand and a
//                  black trailing edge — from above the stork is a white body
//                  on black-edged wings), the neck held OUT (a heron folds it,
//                  a stork never does), a long red bill, red legs trailing.
//                  They cross the valley in loose flocks and come down in the
//                  open fields and by the oasis water.
//   1 CROW         black, the wedge tail, fingered wing tips (as nam's).
//   2 GRIFFON VULTURE  huge (2.6 m span), tawny with dark flight feathers,
//                  deeply fingered, a short square tail, the pale head: it
//                  SOARS — glides nine tenths of the time — and circles high
//                  over the djebel for good.
//   3 WHITE STORK  standing: white, the folded wings black, red bill and legs.
//                  In the fields; and one on its NEST on the dechra's minaret.
//
// Nature is real size, not the 1.3x of units and buildings.
import * as THREE from "three";
import { createBirdBuilder } from "../shared-rts/birdKit.js";
import { createRtsBirds } from "../shared-rts/rtsBirds.js";

const C = {
  white: [0.94, 0.93, 0.9], whiteShade: [0.8, 0.8, 0.78],
  black: [0.07, 0.07, 0.08], blackSheen: [0.12, 0.12, 0.14],
  red: [0.86, 0.22, 0.13], redDark: [0.7, 0.16, 0.1],
  tawny: [0.58, 0.44, 0.29], tawnyLight: [0.66, 0.52, 0.36], umber: [0.16, 0.12, 0.09], pale: [0.86, 0.82, 0.74],
};

function algBirdShapes() {
  const k = createBirdBuilder();
  const { tri, body, wing, standing } = k;

  // ── 0 WHITE STORK, flying ────────────────────────────────────────────────
  k.species(0);
  body([0, 0.01, 0.24], [0, 0, -0.22], -0.01, 0.065, 0.055, C.white, C.whiteShade);
  // The neck held straight out, the small head, the long red bill.
  tri([0.03, 0.02, 0.2], [0, 0.02, 0.42], [-0.03, 0.02, 0.2], C.white);
  tri([0.03, 0.02, 0.2], [-0.03, 0.02, 0.2], [0, 0.0, 0.4], C.whiteShade);
  tri([0.012, 0.02, 0.41], [0, 0.015, 0.64], [-0.012, 0.02, 0.41], C.red);
  tri([0.012, 0.02, 0.41], [-0.012, 0.02, 0.41], [0, 0.005, 0.6], C.redDark);
  // A short white tail, and the red legs trailing past it.
  tri([0, 0, -0.18], [0.05, 0, -0.3], [-0.05, 0, -0.3], C.white);
  tri([0.014, -0.03, -0.2], [0.008, -0.03, -0.56], [-0.014, -0.03, -0.2], C.red);
  tri([-0.014, -0.03, -0.2], [-0.008, -0.03, -0.56], [0.014, -0.03, -0.2], C.red);
  for (const s of [1, -1]) {
    // White coverts, a BLACK trailing edge, black fingered primaries.
    wing(s, [[0.05, 0.01, 0.12], [0.05, 0.01, -0.12]], [[0.33, 0.02, 0.1], [0.33, 0.02, -0.19]],
      [[0.62, 0, -0.03]], C.white, C.black, 5, C.black);
  }

  // ── 1 CROW ───────────────────────────────────────────────────────────────
  k.species(1);
  body([0, 0.01, 0.22], [0, 0, -0.18], 0, 0.06, 0.05, C.blackSheen, C.black);
  tri([0.03, 0.02, 0.2], [0, 0.01, 0.34], [-0.03, 0.02, 0.2], C.black);
  tri([0, 0, -0.14], [0.09, 0, -0.38], [-0.09, 0, -0.38], C.black);
  tri([0.09, 0, -0.38], [0, 0, -0.42], [-0.09, 0, -0.38], C.black);
  for (const s of [1, -1]) {
    wing(s, [[0.04, 0.01, 0.1], [0.04, 0.01, -0.1]], [[0.24, 0.02, 0.09], [0.24, 0.02, -0.13]],
      [[0.47, 0, 0.0]], C.blackSheen, C.blackSheen, 4);
  }

  // ── 2 GRIFFON VULTURE ────────────────────────────────────────────────────
  k.species(2);
  body([0, 0.01, 0.2], [0, 0, -0.2], -0.01, 0.085, 0.07, C.tawny, C.tawnyLight);
  // The pale head on a short neck, the ruff, a dark hooked bill.
  tri([0.035, 0.02, 0.18], [0, 0.03, 0.3], [-0.035, 0.02, 0.18], C.pale);
  tri([0.012, 0.03, 0.29], [0, 0.02, 0.35], [-0.012, 0.03, 0.29], C.umber);
  // The short, square dark tail.
  tri([0.06, 0, -0.16], [0.07, 0, -0.33], [-0.07, 0, -0.33], C.umber);
  tri([0.06, 0, -0.16], [-0.07, 0, -0.33], [-0.06, 0, -0.16], C.umber);
  for (const s of [1, -1]) {
    // Broad, long, plank-like: tawny coverts, dark secondaries, six fingers.
    wing(s, [[0.07, 0.01, 0.15], [0.07, 0.01, -0.14]], [[0.36, 0.02, 0.15], [0.36, 0.02, -0.2]],
      [[0.63, 0, 0.0]], C.tawny, C.umber, 6, C.umber);
  }

  // ── 3 WHITE STORK, standing (the kit's lofted standing bird) ─────────────
  standing(3, {
    body: (part, sn) => (part === "tail" ? C.black : sn < -0.2 && (part === "body" || part === "breast") ? C.whiteShade : C.white),
    bill: C.red, billUnder: C.redDark, eye: [0.1, 0.08, 0.07],
    wing: C.black, wingEdge: [0.14, 0.13, 0.13], leg: [0.82, 0.3, 0.22], crest: null,
  });
  return k.finish();
}

/** Per-species flight: flap rate (beats/s), share of the time gliding, size (m span scale). */
const SPECIES = [
  { key: "stork", rate: 2.0, glide: 0.65, size: 1.9 },
  { key: "crow", rate: 4.6, glide: 0.1, size: 0.85 },
  { key: "vulture", rate: 1.4, glide: 0.9, size: 2.6 },
  { key: "storkStanding", rate: 0, glide: 1, size: 1.25 },
];

export const ALG_BIRDS = {
  shapes: algBirdShapes,
  species: SPECIES,
  standingFrom: 3,
  kinds: {
    // Storks in a loose V, crows straggling; vultures in ones and twos, high and slow.
    stork: { shape: 0, n: [6, 14], formation: "v", weight: 0.45 },
    crow: { shape: 1, n: [5, 11], formation: "straggle", weight: 0.4 },
    vulture: { shape: 2, n: [2, 4], formation: "line", altAdd: 30, speedMul: 0.7, weight: 0.15 },
  },
  lander: "stork",
  standing: [[3, 1]],
  // Out of the palms and the cedars when something blows up: crows first.
  flushKinds: (size) => ["crow", size >= 12 ? "stork" : "crow", "crow"],
};

/**
 * The birds on this map: the flocks and the stands (shared engine), the
 * stork on the minaret's nest, vultures wheeling over the djebel.
 * @param {object} o
 * @param {object} o.showroom   placed pieces (the dechra carries its nest)
 * @param {{x:number,z:number}[]} o.soarOver  where vultures circle for good
 */
export function createAlgBirds(app, { units = null, showroom = null, soarOver = [] } = {}) {
  const birds = createRtsBirds({ app, units, birds: ALG_BIRDS });

  // The stork on its nest, and its mate: one stands, the other sits lower
  // (brooding), a quarter turn apart.
  const dechra = showroom?.dechra, nest = dechra?.geometry?.userData?.nest;
  if (nest) {
    dechra.updateMatrixWorld(true);
    const p = dechra.localToWorld(new THREE.Vector3(nest.x, nest.y, nest.z));
    birds.addPerch({ x: p.x, y: p.y, z: p.z, yaw: dechra.rotation.y + 2.4, shape: 3, size: 1.25 });
    const q = dechra.localToWorld(new THREE.Vector3(nest.x - 0.55, nest.y - 0.25, nest.z + 0.2));
    birds.addPerch({ x: q.x, y: q.y, z: q.z, yaw: dechra.rotation.y - 0.8, shape: 3, size: 1.05 });
  }
  // Griffon vultures on the thermals over the massif, high, for good.
  for (const s of soarOver) birds.circleOver(s.x, s.z, { kind: "vulture", n: s.n ?? 3, r: s.r ?? 70, alt: s.alt ?? 85, speed: 8 });

  // The world is built: scan the open fields and the oasis banks for stands.
  birds.worldReady();
  app.addPreRenderHook((dt) => birds.update(dt));
  return birds;
}
