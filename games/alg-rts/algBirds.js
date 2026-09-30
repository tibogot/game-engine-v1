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
  const k = createBirdBuilder({ srgb: true });
  const { standing, flying, smoothWing } = k;

  // ── 0 WHITE STORK, flying ────────────────────────────────────────────────
  // (the lofted bodies: birdKit flying(), 2026-09-30 — the spindles read flat)
  flying(0, {
    body: [0.19, 0.062, 0.058], neck: [0.2, 0.012], head: 0.03,
    bill: [0.19, C.red, C.redDark],
    tail: { len: 0.11, w: 0.06, shape: "fan", col: C.white },
    legs: [0.3, C.red],
    col: (part, s) => (s < -0.25 && part !== "head" ? C.whiteShade : C.white),
  });
  for (const s of [1, -1]) {
    // Long and broad; white coverts, the whole BLACK trailing half (the
    // flight feathers), six black primaries spread at the tip.
    smoothWing(s, {
      root: 0.05, span: 0.36, wrist: 0.55, camber: 0.014,
      // A long, even-width board (straight edges), the wrist a touch forward, the hand narrowing: fingers from its end.
      keys: [[0, 0.1, -0.12], [0.5, 0.105, -0.125], [0.6, 0.118, -0.12], [1, 0.08, -0.06]],
      col: (t, u) => (u > 0.5 || t > 0.78 ? C.black : C.white),
      fingers: { n: 6, len: 0.2, width: 0.034, col: C.black },
    });
  }

  // ── 1 CROW ───────────────────────────────────────────────────────────────
  flying(1, {
    body: [0.16, 0.058, 0.052], neck: [0.05, 0.004], head: 0.042,
    bill: [0.085, C.blackSheen, C.black],
    tail: { len: 0.2, w: 0.075, shape: "wedge", col: C.black },
    legs: null,
    col: (part, s) => (s > 0.3 ? C.blackSheen : C.black),
  });
  for (const s of [1, -1]) {
    smoothWing(s, {
      root: 0.045, span: 0.25, wrist: 0.55, camber: 0.012,
      keys: [[0, 0.09, -0.09], [0.55, 0.1, -0.1], [1, 0.075, -0.04]],
      col: (t, u) => (u < 0.35 ? C.blackSheen : C.black),
      fingers: { n: 5, len: 0.15, width: 0.028, col: C.black },
    });
  }

  // ── 2 GRIFFON VULTURE ────────────────────────────────────────────────────
  // The head sunk between the shoulders, the pale ruff, a hooked dark bill.
  flying(2, {
    body: [0.18, 0.085, 0.07], neck: [0.06, 0.02], head: 0.038,
    bill: [0.05, C.umber, C.umber],
    tail: { len: 0.14, w: 0.075, shape: "square", col: C.umber },
    legs: null,
    col: (part, s) => (part === "neck" || part === "head" ? C.pale : s < -0.2 ? C.tawnyLight : C.tawny),
  });
  for (const s of [1, -1]) {
    // Broad, long, plank-like: tawny coverts, dark flight feathers, seven fingers.
    smoothWing(s, {
      root: 0.07, span: 0.38, wrist: 0.55, camber: 0.016,
      keys: [[0, 0.14, -0.14], [0.5, 0.15, -0.15], [0.62, 0.165, -0.145], [1, 0.12, -0.06]],
      col: (t, u) => (u > 0.55 ? C.umber : C.tawny),
      fingers: { n: 7, len: 0.2, width: 0.036, col: C.umber },
    });
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
