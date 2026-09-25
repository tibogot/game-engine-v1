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
  const P = [], COL = [], SP = [], HAND = [], HEAD = [], NRM = [];
  let species = 0;
  let head = 0;   // 1 while building a standing bird's neck and head (it pecks)
  // Standing birds: the peck weight PER VERTEX, from its position — 0 at the
  // breast rising smoothly to 1 at the head. Tagged per triangle, the ring
  // where the neck meets the breast was half in, half out: the peck swung
  // one half away and tore a hollow in the bird (your note, 2026-09-26).
  // From the position, a shared vertex always has one weight: no seam can
  // open, and the neck CURVES down instead of hinging like a lid.
  let headFn = null;
  const tri = (a, b, c, col, hand = [0, 0, 0], normal = [0, 1, 0]) => {
    P.push(...a, ...b, ...c);
    const vs = [a, b, c];
    for (let i = 0; i < 3; i++) {
      COL.push(...col); SP.push(species); HAND.push(hand[i]); NRM.push(...normal);
      HEAD.push(headFn ? headFn(vs[i]) : head);
    }
  };
  /**
   * A FACETED triangle (the standing birds): its own flat normal, wound to face
   * away from `inside` — the facets catch the light like the low-poly heron
   * you showed (2026-09-26), where the flying birds' "up" normals lit every
   * face alike and read as paper.
   */
  const facet = (a, b, c, col, inside) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const m = [(a[0] + b[0] + c[0]) / 3 - inside[0], (a[1] + b[1] + c[1]) / 3 - inside[1], (a[2] + b[2] + c[2]) / 3 - inside[2]];
    if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) { [b, c] = [c, b]; n = n.map((q) => -q); }
    const l = Math.hypot(...n) || 1;
    tri(a, b, c, col, [0, 0, 0], n.map((q) => q / l));
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

  // ── 3 EGRET and 4 GREY HERON, STANDING ────────────────────────────────────
  // Rebuilt like a real low-poly model (your reference, 2026-09-26): ONE
  // continuous body — tail, full breast, shoulder, the S of the neck, the
  // head — lofted through 8-sided rings along a spine, every facet with its
  // own normal; a dagger bill; the folded wing tips crossing over the tail;
  // legs that bend back at the ankle, three toes forward and one back. The
  // neck, head and bill carry `aHead` and dip about the shoulder (y 0.64,
  // z 0.13) to peck. Feet at y = 0, about 1 m tall, +Z forward.
  const SIDES = 8;
  const standing = (sp, look) => {
    species = sp;
    // Above the breast (y 0.665) toward the head (0.95); the bill and crest
    // ride at 1. Legs, wings and the body stay put.
    headFn = (v) => {
      const t = Math.max(0, Math.min(1, (v[1] - 0.68) / (0.93 - 0.68)));
      return v[2] > -0.05 ? t * t * (3 - 2 * t) : 0;
    };
    // Spine stations: position, half-width, half-height, part.
    const st = [
      [[0, 0.37, -0.52], 0.004, 0.004, "tail"],
      [[0, 0.42, -0.42], 0.06, 0.045, "tail"],
      [[0, 0.49, -0.27], 0.11, 0.1, "body"],
      [[0, 0.55, -0.11], 0.125, 0.125, "body"],
      [[0, 0.61, 0.02], 0.11, 0.115, "body"],
      [[0, 0.665, 0.105], 0.07, 0.075, "breast"],
      [[0, 0.72, 0.14], 0.036, 0.04, "neck"],
      [[0, 0.79, 0.112], 0.029, 0.031, "neck"],
      [[0, 0.86, 0.1], 0.027, 0.029, "neck"],
      [[0, 0.915, 0.125], 0.029, 0.031, "neck"],
      [[0, 0.952, 0.168], 0.035, 0.037, "head"],
      [[0, 0.962, 0.208], 0.031, 0.031, "head"],
      [[0, 0.955, 0.243], 0.017, 0.016, "headFront"],
    ];
    const rings = st.map(([pp, w, h], i) => {
      const prev = st[Math.max(0, i - 1)][0], next = st[Math.min(st.length - 1, i + 1)][0];
      const t = [next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]];
      const tl = Math.hypot(...t) || 1;
      // Side = +X (the spine lies in the y-z plane); up = t × side.
      const up = [0, t[2] / tl, -t[1] / tl];
      return Array.from({ length: SIDES }, (_, k) => {
        const ang = (k / SIDES) * Math.PI * 2;
        const cx = Math.cos(ang) * w, cy = Math.sin(ang) * h;
        return { p: [pp[0] + cx, pp[1] + up[1] * cy, pp[2] + up[2] * cy], s: Math.sin(ang), c: Math.cos(ang) };
      });
    });
    for (let i = 0; i < st.length - 1; i++) {
      const part = st[i][3], partN = st[i + 1][3];
      head = ["neck", "head", "headFront"].includes(partN) && part !== "body" ? 1 : 0;
      const mid = [(st[i][0][0] + st[i + 1][0][0]) / 2, (st[i][0][1] + st[i + 1][0][1]) / 2, (st[i][0][2] + st[i + 1][0][2]) / 2];
      for (let k = 0; k < SIDES; k++) {
        const A = rings[i][k], B = rings[i][(k + 1) % SIDES], Cc = rings[i + 1][(k + 1) % SIDES], D = rings[i + 1][k];
        const col = look.body(part, (A.s + B.s) / 2, (A.c + B.c) / 2, i);
        facet(A.p, B.p, Cc.p, col, mid);
        facet(A.p, Cc.p, D.p, col, mid);
      }
    }
    // Cap the head's front (the bill grows out of it).
    head = 1;
    const hf = st[st.length - 1][0], hr = rings[st.length - 1];
    const tip = [0, 0.945, 0.415];
    for (let k = 0; k < SIDES; k++) {
      const A = hr[k].p, B = hr[(k + 1) % SIDES].p;
      // The bill: a long dagger, the lower mandible a shade darker.
      facet(A, B, tip, hr[k].s < 0 ? look.billUnder : look.bill, [hf[0], hf[1], hf[2] + 0.05]);
    }
    // The eye: a small dark bead on each side of the head.
    for (const sx of [1, -1]) {
      const e = [sx * 0.03, 0.965, 0.205];
      facet([e[0], e[1] + 0.008, e[2] - 0.006], [e[0], e[1] - 0.006, e[2] - 0.006], [e[0], e[1], e[2] + 0.01], look.eye, [0, 0.96, 0.205]);
    }
    // The crest: a few long plumes trailing back from the nape (heron).
    if (look.crest) {
      for (const [dx, dy, len] of [[0.006, 0.0, 0.14], [-0.006, 0.004, 0.12], [0, 0.01, 0.1]]) {
        const r0 = [dx, 0.985 + dy, 0.175], r1 = [dx, 0.975 + dy, 0.2];
        facet(r0, r1, [dx * 2, 0.97 + dy - len * 0.15, 0.175 - len], look.crest, [0, 0.9, 0.19]);
      }
    }
    head = 0;
    // The folded wings: a long faceted blade down each flank, over the tail.
    for (const sx of [1, -1]) {
      const a0 = [sx * 0.118, 0.6, 0.0], a1 = [sx * 0.13, 0.53, -0.16], tipW = [sx * 0.035, 0.36, -0.56], lo = [sx * 0.112, 0.46, -0.22];
      facet(a0, a1, tipW, look.wing, [0, 0.54, -0.12]);
      facet(a1, lo, tipW, look.wingEdge, [0, 0.54, -0.12]);
    }
    // Legs: thigh hidden in the belly, the shank to the ankle (it bends BACK),
    // the tarsus to the foot; four-sided, thin. Toes: three forward, one back.
    for (const sx of [1, -1]) {
      const hip = [sx * 0.045, 0.47, -0.1], ankle = [sx * 0.05, 0.25, -0.13], foot = [sx * 0.055, 0.012, -0.07];
      const tube = (p0, p1, r) => {
        const c = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2];
        const o = [[r, 0, 0], [0, 0, r], [-r, 0, 0], [0, 0, -r]];
        for (let k = 0; k < 4; k++) {
          const u = o[k], v = o[(k + 1) % 4];
          const A = [p0[0] + u[0], p0[1], p0[2] + u[2]], B = [p0[0] + v[0], p0[1], p0[2] + v[2]];
          const Cc = [p1[0] + v[0], p1[1], p1[2] + v[2]], D = [p1[0] + u[0], p1[1], p1[2] + u[2]];
          facet(A, B, Cc, look.leg, c);
          facet(A, Cc, D, look.leg, c);
        }
      };
      tube(hip, ankle, 0.011);
      tube(ankle, foot, 0.008);
      for (const [dx, dz] of [[0.035, 0.075], [0, 0.085], [-0.035, 0.075], [0, -0.045]]) {
        const t2 = [foot[0] + dx, 0.004, foot[2] + dz];
        facet([foot[0] - 0.005, 0.012, foot[2]], [foot[0] + 0.005, 0.012, foot[2]], t2, look.leg, [foot[0], 0.05, foot[2]]);
      }
    }
  };
  const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
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
  headFn = null;

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(COL, 3));
  // One vec3 per vertex (species, wing-hand weight, head): three separate
  // attributes would take the mesh to WebGPU's 8 vertex buffers.
  const BIRD = new Float32Array(SP.length * 3);
  for (let i = 0; i < SP.length; i++) { BIRD[i * 3] = SP[i]; BIRD[i * 3 + 1] = HAND[i]; BIRD[i * 3 + 2] = HEAD[i]; }
  g.setAttribute("aBird", new THREE.BufferAttribute(BIRD, 3));
  // Flying birds: flat UP normals — lit as the sky sees them, the back by the
  // sun, the underside (DoubleSide flips it) in shade. Standing birds: each
  // facet its own (see facet above).
  g.setAttribute("normal", new THREE.Float32BufferAttribute(NRM, 3));
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
  // A grey heron, standing (the same 1.5x for the same reason).
  { key: "heronStanding", rate: 0, glide: 1, size: 1.5 },
];
