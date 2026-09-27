// Bird silhouettes for rtsBirds.js — three species in flight and a standing
// egret, in ONE geometry, so every bird on the map stays one draw. Each vertex
// carries its shape in `aBird.x`; the instance's shape (`iBird.x`) collapses
// the other three to a point.
//
// Seen from an RTS camera a bird is a few pixels: what reads is the
// SILHOUETTE and the colour against the ground, not detail. So each species is
// built around what identifies it from above:
//
//   0 EGRET     white, broad rounded wings, the long S-neck folded back into
//               a heavy "throat", a yellow dagger bill, black legs TRAILING
//               well past the tail — the paddy bird.
//   1 CROW      black, a stubby body, a wedge-fan tail, "fingered" wing tips.
//   2 HORNBILL  (Oriental pied) big and black, white belly, a white trailing
//               edge on the wing, white tail corners, and the ivory-yellow
//               bill-and-casque — Southeast Asia in one shape.
//
// The building blocks (body, wings, the standing bird) are the shared kit,
// games/shared-rts/birdKit.js; the species and their colours are this game's.
import { createBirdBuilder, mixc } from "../shared-rts/birdKit.js";

const C = {
  white: [0.93, 0.92, 0.88], whiteShade: [0.8, 0.8, 0.77],
  yellow: [0.92, 0.72, 0.18], black: [0.07, 0.07, 0.08], blackSheen: [0.12, 0.12, 0.14],
  ivory: [0.95, 0.86, 0.55], grey: [0.55, 0.55, 0.52],
};

export function birdShapes() {
  const k = createBirdBuilder();
  const { tri, body, wing, standing } = k;

  // ── 0 EGRET ──────────────────────────────────────────────────────────────
  k.species(0);
  body([0, 0.01, 0.2], [0, 0, -0.3], -0.02, 0.07, 0.06, C.white, C.whiteShade);
  // The folded S-neck: a heavy throat pouch forward of the chest, then the head.
  tri([0, 0.05, 0.14], [0.045, -0.02, 0.16], [0, 0.02, 0.33], C.white);
  tri([0, 0.05, 0.14], [0, 0.02, 0.33], [-0.045, -0.02, 0.16], C.white);
  tri([-0.045, -0.02, 0.16], [0, 0.02, 0.33], [0.045, -0.02, 0.16], C.whiteShade);
  // The dagger bill.
  tri([0.012, 0.02, 0.32], [0, 0.015, 0.5], [-0.012, 0.02, 0.32], C.yellow);
  tri([0.012, 0.02, 0.32], [-0.012, 0.02, 0.32], [0, 0.005, 0.46], C.yellow);
  // Legs trailing well past the tail.
  tri([0.015, -0.03, -0.24], [0.008, -0.03, -0.62], [-0.015, -0.03, -0.24], C.black);
  tri([-0.015, -0.03, -0.24], [-0.008, -0.03, -0.62], [0.015, -0.03, -0.24], C.black);
  for (const s of [1, -1]) {
    wing(s, [[0.05, 0.01, 0.11], [0.05, 0.01, -0.14]], [[0.3, 0.02, 0.1], [0.3, 0.02, -0.19]],
      [[0.56, 0, -0.04], [0.5, 0, -0.2]], C.white);
  }

  // ── 1 CROW ───────────────────────────────────────────────────────────────
  k.species(1);
  body([0, 0.01, 0.22], [0, 0, -0.18], 0, 0.06, 0.05, C.blackSheen, C.black);
  tri([0.03, 0.02, 0.2], [0, 0.01, 0.34], [-0.03, 0.02, 0.2], C.black);        // head + bill
  // Wedge-fan tail.
  tri([0, 0, -0.14], [0.09, 0, -0.38], [-0.09, 0, -0.38], C.black);
  tri([0.09, 0, -0.38], [0, 0, -0.42], [-0.09, 0, -0.38], C.black);
  for (const s of [1, -1]) {
    wing(s, [[0.04, 0.01, 0.1], [0.04, 0.01, -0.1]], [[0.24, 0.02, 0.09], [0.24, 0.02, -0.13]],
      [[0.47, 0, 0.0]], C.blackSheen, C.blackSheen, 4);
  }

  // ── 2 HORNBILL ───────────────────────────────────────────────────────────
  k.species(2);
  body([0, 0.01, 0.2], [0, 0, -0.26], -0.02, 0.08, 0.07, C.black, C.white);    // white belly
  // The long tail, white-cornered.
  tri([0, 0, -0.2], [0.07, 0, -0.52], [-0.07, 0, -0.52], C.black);
  tri([0.07, 0, -0.52], [0.075, 0, -0.6], [0.02, 0, -0.55], C.white);
  tri([-0.07, 0, -0.52], [-0.02, 0, -0.55], [-0.075, 0, -0.6], C.white);
  // Head, and the great bill with the casque on top.
  tri([0.04, 0.03, 0.18], [0, 0.05, 0.3], [-0.04, 0.03, 0.18], C.black);
  tri([0.022, 0.04, 0.28], [0, 0.03, 0.56], [-0.022, 0.04, 0.28], C.ivory);
  tri([0.018, 0.06, 0.27], [0, 0.085, 0.36], [-0.018, 0.06, 0.27], C.ivory);   // casque
  tri([0.018, 0.06, 0.27], [-0.018, 0.06, 0.27], [0, 0.04, 0.46], C.ivory);
  for (const s of [1, -1]) {
    wing(s, [[0.06, 0.01, 0.12], [0.06, 0.01, -0.14]], [[0.33, 0.02, 0.12], [0.33, 0.02, -0.18]],
      [[0.6, 0, -0.02], [0.54, 0, -0.2]], C.black, C.white);
  }

  // ── 3 EGRET and 4 GREY HERON, STANDING (the kit's lofted standing bird) ──
  // The great egret: all white, the underside a shade into the grey, a yellow
  // bill, black legs.
  standing(3, {
    body: (part, sn) => mixc([0.95, 0.95, 0.93], [0.78, 0.79, 0.78], Math.max(0, -sn) * (part === "body" || part === "tail" ? 0.8 : 0.5)),
    bill: [0.93, 0.74, 0.2], billUnder: [0.8, 0.6, 0.15], eye: [0.9, 0.78, 0.2],
    wing: [0.93, 0.93, 0.9], wingEdge: [0.84, 0.85, 0.83], leg: [0.09, 0.09, 0.1], crest: null,
  });
  // The grey heron (your reference): blue-grey back and wings, a white neck
  // and face with a black eye-stripe and crest, a pale breast, an orange-yellow
  // bill, pale pinkish legs.
  standing(4, {
    body: (part, sn, cs, i) => {
      const grey = [0.47, 0.53, 0.62], pale = [0.86, 0.87, 0.88], white = [0.95, 0.95, 0.95], black = [0.1, 0.11, 0.13];
      if (part === "tail" || part === "body") return mixc(grey, pale, Math.max(0, -sn) * 0.9);
      if (part === "breast") return mixc(grey, white, Math.max(0, -sn + 0.2));
      if (part === "neck") return sn < -0.3 && cs * cs < 0.2 ? [0.72, 0.74, 0.78] : white;   // a grey streak down the front
      if (part === "head") return sn > 0.35 || (Math.abs(cs) > 0.7 && sn > -0.2 && i === 10) ? black : white;
      return white;
    },
    bill: [0.95, 0.52, 0.12], billUnder: [0.85, 0.44, 0.1], eye: [0.95, 0.85, 0.15],
    wing: [0.43, 0.49, 0.58], wingEdge: [0.33, 0.38, 0.46], leg: [0.6, 0.49, 0.44], crest: [0.08, 0.09, 0.11],
  });
  return k.finish();
}

/** Per-species flight: flap rate (beats/s), how much of the time they glide, size (m span scale). */
export const SPECIES = [
  { key: "egret", rate: 2.4, glide: 0.45, size: 1.1 },
  { key: "crow", rate: 4.6, glide: 0.1, size: 0.85 },
  { key: "hornbill", rate: 3.0, glide: 0.55, size: 1.4 },
  // A standing egret: no wingbeat (the vertex stage holds its wings still).
  // 1.5x a real great egret: in 0.8 m meadow grass a true-size one showed
  // only its head, and from the RTS camera that is nothing.
  { key: "egretStanding", rate: 0, glide: 1, size: 1.5 },
  // A grey heron, standing (the same 1.5x for the same reason).
  { key: "heronStanding", rate: 0, glide: 1, size: 1.5 },
];
