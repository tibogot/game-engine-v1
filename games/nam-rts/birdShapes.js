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
// Frame: +Z forward, +Y up, +X right; about 1 m span before the per-species
// size. Wings are two segments: aHand 0 = the arm (from the body to the
// elbow), 1 = the hand (elbow to tip) — the vertex stage lifts the hand more,
// so a flap CURLS instead of hinging like a card.
import * as THREE from "three";

const C = {
  white: [0.93, 0.92, 0.88], whiteShade: [0.8, 0.8, 0.77],
  yellow: [0.92, 0.72, 0.18], black: [0.07, 0.07, 0.08], blackSheen: [0.12, 0.12, 0.14],
  ivory: [0.95, 0.86, 0.55], grey: [0.55, 0.55, 0.52],
};

export function birdShapes() {
  const P = [], COL = [], SP = [], HAND = [], HEAD = [];
  let species = 0;
  let head = 0;   // 1 while building a standing bird's neck and head (it pecks)
  const tri = (a, b, c, col, hand = [0, 0, 0]) => {
    P.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) { COL.push(...col); SP.push(species); HAND.push(hand[i]); HEAD.push(head); }
  };
  const quad = (a, b, c, d, col, hand) => {
    tri(a, b, c, col, hand ? [hand[0], hand[1], hand[2]] : undefined);
    tri(a, c, d, col, hand ? [hand[0], hand[2], hand[3]] : undefined);
  };
  /** A spindle body: nose, tail, and a ring of four at `mid`. */
  const body = (nose, tail, mid, w, h, top, under = top) => {
    const U = [0, h, mid], D = [0, -h, mid], L = [-w, 0, mid], R = [w, 0, mid];
    tri(nose, U, L, top); tri(nose, R, U, top); tri(nose, L, D, under); tri(nose, D, R, under);
    tri(tail, L, U, top); tri(tail, U, R, top); tri(tail, D, L, under); tri(tail, R, D, under);
  };
  /**
   * One wing, side s (+1 right, -1 left): arm from the body root to the
   * elbow, hand from the elbow to the tip. Points are [x, y, z] for s = +1.
   */
  const wing = (s, root, elbow, tip, col, colEdge = col, fingers = 0) => {
    const m = (p) => [p[0] * s, p[1], p[2]];
    const [rf, rb] = root, [ef, eb] = elbow;
    // Arm (hand 0 at the root, a touch at the elbow so the bend is smooth).
    quad(m(rf), m(ef), m(eb), m(rb), col, [0, 0.35, 0.35, 0]);
    if (colEdge !== col) {
      // A pale trailing edge along the arm (hornbill).
      const eb2 = [eb[0], eb[1] - 0.001, eb[2] - 0.05], rb2 = [rb[0], rb[1] - 0.001, rb[2] - 0.05];
      quad(m(rb), m(eb), m(eb2), m(rb2), colEdge, [0, 0.35, 0.35, 0]);
    }
    if (!fingers) {
      tri(m(ef), m(tip[0]), m(tip[1] ?? eb), col, [0.35, 1, 1]);
      tri(m(ef), m(tip[1] ?? eb), m(eb), col, [0.35, 1, 0.35]);
    } else {
      // Fingered primaries: separate slender feathers fanning from the hand.
      const n = fingers;
      for (let k = 0; k < n; k++) {
        const f = n === 1 ? 0.5 : k / (n - 1);
        const a = [ef[0] + (eb[0] - ef[0]) * f, 0, ef[2] + (eb[2] - ef[2]) * f];
        const b = [ef[0] + (eb[0] - ef[0]) * (f + 0.25), 0, ef[2] + (eb[2] - ef[2]) * (f + 0.25)];
        const t = [tip[0][0] - f * 0.06, tip[0][1], tip[0][2] - f * 0.2];
        tri(m(a), m(t), m(b), col, [0.35, 1, 0.35]);
      }
      tri(m(ef), m([ef[0] + 0.06, 0, ef[2] - 0.06]), m(eb), col, [0.35, 0.6, 0.35]);
    }
  };

  // ── 0 EGRET ──────────────────────────────────────────────────────────────
  species = 0;
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
  species = 1;
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
  species = 2;
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

  // ── 3 EGRET, STANDING ────────────────────────────────────────────────────
  // On a river bank or in the shallows: the body tilted up at the chest, the
  // S-neck raised, the dagger bill level, black legs to the ground. About
  // 0.9 m tall; the feet are at y = 0. Seen from the RTS camera it is a white
  // spindle with a neck — which is exactly how a stand of egrets reads on a
  // paddy. The neck and head carry `aHead`: the vertex stage dips them to peck.
  species = 3;
  {
    // Body: a spindle from the chest (up and forward) to the tail (down, back).
    const ring = (cy, cz, w, h) => [[0, cy + h, cz], [w, cy, cz], [0, cy - h, cz], [-w, cy, cz]];
    const chest = [0, 0.64, 0.16], tail = [0, 0.5, -0.24];
    const R = ring(0.58, -0.03, 0.075, 0.07);
    for (let k = 0; k < 4; k++) {
      const a = R[k], b = R[(k + 1) % 4];
      const col = k >= 1 && k <= 2 ? C.whiteShade : C.white;   // the underside a shade darker
      // Wound to face OUT: the bird's normals are all "up", and a back face
      // gets it flipped — the first winding lit the whole body as an
      // underside, a blue-grey diamond.
      tri(chest, b, a, col);
      tri(tail, a, b, col);
    }
    // Legs: two thin black blades to the ground (crossed, so they show from above).
    for (const s of [1, -1]) {
      const top = [0.03 * s, 0.52, -0.02], foot = [0.035 * s, 0, 0.0];
      tri(top, [top[0] + 0.012, top[1], top[2]], foot, C.black);
      tri(top, [top[0], top[1], top[2] + 0.012], foot, C.black);
    }
    // Neck (S, raised) and head, with the bill: these peck.
    head = 1;
    const n0 = [0, 0.66, 0.13], n1 = [0, 0.8, 0.09], n2 = [0, 0.9, 0.14];
    const wN = 0.022;
    for (const [p, q] of [[n0, n1], [n1, n2]]) {
      tri([p[0] - wN, p[1], p[2]], [p[0] + wN, p[1], p[2]], [q[0] + wN, q[1], q[2]], C.white);
      tri([p[0] - wN, p[1], p[2]], [q[0] + wN, q[1], q[2]], [q[0] - wN, q[1], q[2]], C.white);
      tri([p[0], p[1], p[2] - wN], [p[0], p[1], p[2] + wN], [q[0], q[1], q[2] + wN], C.whiteShade);
      tri([p[0], p[1], p[2] - wN], [q[0], q[1], q[2] + wN], [q[0], q[1], q[2] - wN], C.whiteShade);
    }
    tri([0.028, 0.9, 0.12], [0, 0.93, 0.19], [-0.028, 0.9, 0.12], C.white);          // head
    tri([0.012, 0.905, 0.18], [0, 0.9, 0.34], [-0.012, 0.905, 0.18], C.yellow);       // bill
    tri([0.012, 0.905, 0.18], [-0.012, 0.905, 0.18], [0, 0.89, 0.3], C.yellow);
    head = 0;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(COL, 3));
  // One vec3 per vertex (species, wing-hand weight, head): three separate
  // attributes would take the mesh to WebGPU's 8 vertex buffers.
  const BIRD = new Float32Array(SP.length * 3);
  for (let i = 0; i < SP.length; i++) { BIRD[i * 3] = SP[i]; BIRD[i * 3 + 1] = HAND[i]; BIRD[i * 3 + 2] = HEAD[i]; }
  g.setAttribute("aBird", new THREE.BufferAttribute(BIRD, 3));
  // Flat, UP normals: the whole bird is lit as the sky sees it — the back by the
  // sun, the underside (DoubleSide flips it) in shade.
  const N = new Float32Array(P.length);
  for (let i = 1; i < N.length; i += 3) N[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
  return g;
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
];
