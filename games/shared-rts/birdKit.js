// THE BIRD KIT — the building blocks both RTS games make their birds from
// (shared-rts/rtsBirds.js draws them). Each game builds its OWN species with
// these (nam-rts/birdShapes.js: egret, crow, hornbill, egret and heron
// standing; alg-rts/algBirds.js: stork, crow, vulture, stork standing), all in
// ONE geometry so every bird on a map stays one draw.
//
// Every vertex carries its species in `aBird.x`; the instance's species
// collapses the others to a point. Seen from an RTS camera a bird is a few
// pixels: what reads is the SILHOUETTE and the colour against the ground, so
// a species is built around what identifies it from above.
//
// Frame: +Z forward, +Y up, +X right; about 1 m span before the per-species
// size. Wings are two segments: aHand 0 = the arm (from the body to the
// elbow), 1 = the hand (elbow to tip) — the vertex stage lifts the hand more,
// so a flap CURLS instead of hinging like a card. A STANDING bird is lofted
// through rings along a spine, faceted, feet at y = 0, about 1 m tall; its
// neck and head carry `aHead` and dip about the shoulder (y 0.64, z 0.13) to
// peck.
import * as THREE from "three";

/** A builder: set the species, add its triangles, then `finish()` for the geometry. */
export function createBirdBuilder({ srgb = false } = {}) {
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
  // Standing birds' LEGS: the hand channel carries the leg weight instead (a
  // standing bird's wings never beat) — signed by side (+1 right, -1 left),
  // 0 at the hip to 1 at the foot, from the position like the head's: the
  // vertex stage swings each leg from its hip when the bird walks.
  let legFn = null;
  const tri = (a, b, c, col, hand = [0, 0, 0], normal = [0, 1, 0]) => {
    P.push(...a, ...b, ...c);
    const vs = [a, b, c];
    // `normal`: one for the face, or [na, nb, nc] — one per corner (smooth).
    const perV = Array.isArray(normal[0]);
    for (let i = 0; i < 3; i++) {
      COL.push(...col); SP.push(species); HAND.push(legFn ? legFn(vs[i]) : hand[i]); NRM.push(...(perV ? normal[i] : normal));
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
  const triRaw = tri;   // the wing builder shadows `tri` with a winding-aware one
  /** A spindle body: nose, tail, and a ring of four at `mid`. */
  const body = (nose, tail, mid, w, h, top, under = top) => {
    const U = [0, h, mid], D = [0, -h, mid], L = [-w, 0, mid], R = [w, 0, mid];
    tri(nose, U, L, top); tri(nose, R, U, top); tri(nose, L, D, under); tri(nose, D, R, under);
    tri(tail, L, U, top); tri(tail, U, R, top); tri(tail, D, L, under); tri(tail, R, D, under);
  };
  /**
   * One wing, side s (+1 right, -1 left): arm from the body root to the
   * elbow, hand from the elbow to the tip. Points are [x, y, z] for s = +1.
   * `colEdge`: a trailing edge along the arm in another colour (hornbill,
   * stork); `fingers`: separate primaries fanning from the hand (crow,
   * vulture); `handCol`: the hand in its own colour (a stork's black primaries).
   */
  const wing = (s, root, elbow, tip, col, colEdge = col, fingers = 0, handCol = col) => {
    const m = (p) => [p[0] * s, p[1], p[2]];
    // Mirroring a triangle (x → −x) REVERSES its winding: the left wing's
    // faces pointed down, and under DoubleSide a face seen from its back is
    // lit as an underside — one wing white, the other in shade, dark
    // (your note, 2026-09-26). The left wing's corners go in the other order.
    const tri = (a, b, c, col2, h = [0, 0, 0]) => (s > 0 ? triRaw(a, b, c, col2, h) : triRaw(a, c, b, col2, [h[0], h[2], h[1]]));
    const quad = (a, b, c, d, col2, h) => { tri(a, b, c, col2, [h[0], h[1], h[2]]); tri(a, c, d, col2, [h[0], h[2], h[3]]); };
    const [rf, rb] = root, [ef, eb] = elbow;
    // Arm (hand 0 at the root, a touch at the elbow so the bend is smooth).
    quad(m(rf), m(ef), m(eb), m(rb), col, [0, 0.35, 0.35, 0]);
    if (colEdge !== col) {
      // A trailing edge along the arm in its own colour.
      const eb2 = [eb[0], eb[1] - 0.001, eb[2] - 0.05], rb2 = [rb[0], rb[1] - 0.001, rb[2] - 0.05];
      quad(m(rb), m(eb), m(eb2), m(rb2), colEdge, [0, 0.35, 0.35, 0]);
    }
    if (!fingers) {
      tri(m(ef), m(tip[0]), m(tip[1] ?? eb), handCol, [0.35, 1, 1]);
      tri(m(ef), m(tip[1] ?? eb), m(eb), handCol, [0.35, 1, 0.35]);
    } else {
      // Fingered primaries: separate slender feathers fanning from the hand.
      const n = fingers;
      for (let k = 0; k < n; k++) {
        const f = n === 1 ? 0.5 : k / (n - 1);
        const a = [ef[0] + (eb[0] - ef[0]) * f, 0, ef[2] + (eb[2] - ef[2]) * f];
        const b = [ef[0] + (eb[0] - ef[0]) * (f + 0.25), 0, ef[2] + (eb[2] - ef[2]) * (f + 0.25)];
        const t = [tip[0][0] - f * 0.06, tip[0][1], tip[0][2] - f * 0.2];
        tri(m(a), m(t), m(b), handCol, [0.35, 1, 0.35]);
      }
      tri(m(ef), m([ef[0] + 0.06, 0, ef[2] - 0.06]), m(eb), handCol, [0.35, 0.6, 0.35]);
    }
  };

  /**
   * A STANDING bird as species `sp` (a wader or a stork): ONE continuous body
   * — tail, full breast, shoulder, the S of the neck, the head — lofted
   * through 8-sided rings along a spine, every facet with its own normal; a
   * dagger bill; the folded wing tips crossing over the tail; legs that bend
   * back at the ankle, three toes forward and one back. `look` colours it:
   * body(part, sin, cos, ring) → rgb, bill, billUnder, eye, wing, wingEdge,
   * leg, crest (null for none).
   */
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
      legFn = (v) => sx * Math.max(0.001, Math.min(1, (hip[1] - v[1]) / (hip[1] - 0.004)));
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
    legFn = null;
    headFn = null;
  };

  /**
   * A FLYING bird's body as species `sp`: a SMOOTH loft (10 sides, 12
   * stations, each ring's normals its ellipse's own — it shades round, as the
   * standing egret reads; the first faceted 6-sided body still looked
   * low-poly, you 2026-09-30) — vent, belly, breast, the neck stretched out or
   * short, the head — then a faceted bill, a fanned tail of separate feathers
   * and, for a stork, legs trailing. RIGID: hand weight -1, which the
   * wingbeat leaves alone (rtsBirds.js). The wings: smoothWing().
   *
   * o: { body: [halfLen, halfW, halfH], neck: [len, dropY], head: r,
   *      bill: [len, col, colUnder], tail: { len, w, n, shape: "fan"|"wedge"|"square", col },
   *      legs: [len, col] | null, col(part, s, c) → rgb (s/c: sin/cos round the ring) }
   */
  const SM = 10;
  const smoothTri = (a, b, c, na, nb, nc, col) => tri(a, b, c, col, [0, 0, 0], [na, nb, nc]);
  /**
   * A flat piece (a wing, a feather) FACING UP whatever order its corners
   * came in: the material draws both sides and flips a back face's normal,
   * so a piece wound downward shaded as its own underside from above.
   */
  const upTri = (a, b, c, col, h, n) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    if (u[2] * v[0] - u[0] * v[2] < 0) tri(a, c, b, col, [h[0], h[2], h[1]], [n[0], n[2], n[1]]);
    else tri(a, b, c, col, h, n);
  };
  const flying = (sp, o) => {
    species = sp;
    legFn = () => -1;                     // rigid: not flapped (see the shader)
    const [B, W, H] = o.body, [NL, ND] = o.neck, HR = o.head;
    const neckW = Math.max(HR * 0.7, W * 0.3);
    const ez = (t) => t * t * (3 - 2 * t);
    // Spine stations: [z, y, halfW, halfH, part] — a smooth egg of a body.
    const st = [
      [-B * 1.02, 0.01, W * 0.16, H * 0.14, "vent"],
      [-B * 0.8, 0.006, W * 0.52, H * 0.46, "body"],
      [-B * 0.45, 0.002, W * 0.86, H * 0.82, "body"],
      [-B * 0.1, 0, W, H, "body"],
      [B * 0.3, 0, W * 0.97, H * 0.97, "breast"],
      [B * 0.66, 0.004, W * 0.78, H * 0.8, "breast"],
      [B * 0.92, 0.008, W * 0.5, H * 0.52, "neck"],
    ];
    for (let k = 1; k <= 3; k++) {       // the neck, tapering to the head, dropping
      const t = k / 4;
      st.push([B + NL * t, 0.008 - ND * ez(t), W * 0.5 + (neckW - W * 0.5) * t, H * 0.52 + (neckW - H * 0.52) * t, "neck"]);
    }
    const hz = B + NL, hy = 0.008 - ND;
    st.push([hz, hy + HR * 0.08, HR, HR * 0.95, "head"]);
    st.push([hz + HR * 0.9, hy + HR * 0.02, HR * 0.72, HR * 0.66, "head"]);
    st.push([hz + HR * 1.45, hy - HR * 0.08, HR * 0.34, HR * 0.3, "head"]);
    const rings = st.map(([z, y, w, h]) => Array.from({ length: SM }, (_, k) => {
      const ang = (k / SM) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      const n = [c / Math.max(w, 1e-4), s / Math.max(h, 1e-4), 0], l = Math.hypot(n[0], n[1]) || 1;
      return { p: [c * w, y + s * h, z], n: [n[0] / l, n[1] / l, 0], s, c };
    }));
    // Tilt each ring's normals along the spine's taper (a narrowing ring faces a little forward/back).
    for (let i = 0; i < st.length; i++) {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
      const dr = (b[2] + b[3]) / 2 - (a[2] + a[3]) / 2, dz = b[0] - a[0] || 1e-4;
      const lean = -dr / dz;
      for (const r of rings[i]) { const n = [r.n[0], r.n[1], lean * 0.8]; const l = Math.hypot(...n); r.n = n.map((q) => q / l); }
    }
    for (let i = 0; i < st.length - 1; i++) {
      for (let k = 0; k < SM; k++) {
        const A = rings[i][k], Bq = rings[i][(k + 1) % SM], Cc = rings[i + 1][(k + 1) % SM], D = rings[i + 1][k];
        const col = o.col(st[i + 1][4], (A.s + Bq.s) / 2, (A.c + Bq.c) / 2);
        // Wound OUTWARD (the ring runs anticlockwise seen from the front): the
        // material draws both sides and flips a back face's normal — inward = black.
        smoothTri(A.p, Bq.p, Cc.p, A.n, Bq.n, Cc.n, col);
        smoothTri(A.p, Cc.p, D.p, A.n, Cc.n, D.n, col);
      }
    }
    // The vent closed to a point behind it.
    const v0 = st[0], vTip = [0, v0[1], v0[0] - W * 0.12], vN = [0, 0, -1];
    for (let k = 0; k < SM; k++) smoothTri(rings[0][k].p, vTip, rings[0][(k + 1) % SM].p, rings[0][k].n, vN, rings[0][(k + 1) % SM].n, o.col("vent", rings[0][k].s, rings[0][k].c));
    // The bill: a faceted cone off the head's front ring, the lower half darker.
    const L = st.length - 1, hf = st[L], [BL, bc, bcu] = o.bill;
    const tip = [0, hf[1] - HR * 0.12, hf[0] + BL];
    for (let k = 0; k < SM; k++) {
      const A = rings[L][k];
      facet(A.p, rings[L][(k + 1) % SM].p, tip, A.s < 0 ? bcu : bc, [0, hf[1], hf[0] - 0.01]);
    }
    // The tail: n separate feathers fanned out, each a tapered blade with a
    // rounded end, overlapping (normal up — lit as the wings are).
    const T = o.tail, tz = -B * 0.72, ty = 0.012, n = T.n ?? 7;
    for (let k = 0; k < n; k++) {
      const f = n === 1 ? 0 : k / (n - 1) * 2 - 1;                     // -1..1 across
      const len = T.shape === "wedge" ? T.len * (1 - 0.28 * Math.abs(f)) : T.shape === "square" ? T.len * (1 - 0.04 * Math.abs(f)) : T.len * (1 - 0.1 * f * f);
      const ang = f * (T.shape === "square" ? 0.18 : 0.42);
      const dx = Math.sin(ang), dz = -Math.cos(ang), fw = T.w / n * 1.9;
      const px = f * W * 0.35, e = [px + dx * len, ty - 0.002 * k, tz + dz * len];
      const m = [px + dx * len * 0.55, ty - 0.002 * k, tz + dz * len * 0.55];
      const side = [-dz * fw, 0, dx * fw];
      const up = [0, 1, 0], y = ty - 0.002 * k;
      upTri([px, y, tz], [m[0] - side[0], m[1], m[2] - side[2]], [m[0] + side[0], m[1], m[2] + side[2]], T.col, [0, 0, 0], [up, up, up]);
      upTri([m[0] - side[0], m[1], m[2] - side[2]], [e[0] - side[0] * 0.7, e[1], e[2] - side[2] * 0.7], [m[0] + side[0], m[1], m[2] + side[2]], T.col, [0, 0, 0], [up, up, up]);
      upTri([m[0] + side[0], m[1], m[2] + side[2]], [e[0] - side[0] * 0.7, e[1], e[2] - side[2] * 0.7], [e[0] + side[0] * 0.7, e[1], e[2] + side[2] * 0.7], T.col, [0, 0, 0], [up, up, up]);
      upTri([e[0] - side[0] * 0.7, e[1], e[2] - side[2] * 0.7], [e[0] + dx * fw * 0.8, e[1], e[2] + dz * fw * 0.8], [e[0] + side[0] * 0.7, e[1], e[2] + side[2] * 0.7], T.col, [0, 0, 0], [up, up, up]);
    }
    // Legs trailing (a stork): thin round shanks from the belly past the tail, toes bunched.
    if (o.legs) {
      const [LL, lc] = o.legs;
      for (const sx of [1, -1]) {
        const a = [sx * W * 0.3, -H * 0.6, -B * 0.3], b = [sx * W * 0.16, -H * 0.3, -B - LL];
        const r = 0.009;
        for (let q = 0; q < 4; q++) {
          const a0 = (q / 4) * Math.PI * 2, a1 = ((q + 1) / 4) * Math.PI * 2;
          const o0 = [Math.cos(a0) * r, Math.sin(a0) * r], o1 = [Math.cos(a1) * r, Math.sin(a1) * r];
          const n0 = [Math.cos(a0), Math.sin(a0), 0], n1 = [Math.cos(a1), Math.sin(a1), 0];
          smoothTri([a[0] + o0[0], a[1] + o0[1], a[2]], [b[0] + o1[0] * 0.8, b[1] + o1[1] * 0.8, b[2]], [a[0] + o1[0], a[1] + o1[1], a[2]], n0, n1, n1, lc);
          smoothTri([a[0] + o0[0], a[1] + o0[1], a[2]], [b[0] + o0[0] * 0.8, b[1] + o0[1] * 0.8, b[2]], [b[0] + o1[0] * 0.8, b[1] + o1[1] * 0.8, b[2]], n0, n0, n1, lc);
        }
      }
    }
    legFn = null;
  };

  /**
   * A SMOOTH WING, side s (+1 right, -1 left), for a flying() body: a curved
   * outline subdivided along the span (the leading edge rounded, the hand
   * swept back), a slight camber (the chord's front third raised), smooth
   * normals, and the primaries as SEPARATE tapered feathers with rounded
   * ends fanning from the hand, overlapping — not saw teeth. Hand weight
   * rises from 0 at the root to 0.35 at the wrist and 1 at the tip (the
   * wingbeat curls the hand more than the arm).
   *
   * o: { root: x (the body's side), span, wrist: 0-1, keys: [[t, front z, back z]]
   *      (the outline, t 0-1 along the span, root to the wrist's end),
   *      camber, col(t, u) → rgb (u 0 front → 1 back of the chord),
   *      fingers: { n, len, width, col } | null }
   */
  const smoothWing = (s, o) => {
    const m = (p) => [p[0] * s, p[1], p[2]];
    // Mirrored, then wound to face up (upTri): the winding takes care of itself.
    const put = (a, b, c, col, h, n) => upTri(m(a), m(b), m(c), col, h, n.map((v) => [v[0] * s, v[1], v[2]]));
    const keys = o.keys;
    const at = (t) => {
      let i = 0;
      while (i < keys.length - 2 && keys[i + 1][0] < t) i++;
      const [t0, f0, b0] = keys[i], [t1, f1, b1] = keys[i + 1];
      const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
      const e = u * u * (3 - 2 * u);
      return [f0 + (f1 - f0) * e, b0 + (b1 - b0) * e];
    };
    const NS = 10, CH = [0, 0.3, 0.55, 1];   // span segments; chord rows (a stork's black starts halfway)
    const handW = (t) => (t < o.wrist ? 0.35 * (t / o.wrist) : 0.35 + 0.65 * ((t - o.wrist) / (1 - o.wrist)));
    const P = [];
    for (let i = 0; i <= NS; i++) {
      const t = i / NS, x = o.root + o.span * t, [zf, zb] = at(t);
      // The wing droops a touch toward the tip (a soaring bird's shallow bow).
      const yb = 0.01 - 0.02 * t * t;
      P.push(CH.map((u) => {
        const camber = u === 0.3 ? o.camber * (1 - 0.6 * t) : 0;
        return { p: [x, yb + camber, zf + (zb - zf) * u], t, u, h: handW(t) };
      }));
    }
    // Normals: up, tipped forward over the raised front third, back behind it.
    const nrm = (q) => {
      const c = o.camber * (1 - 0.6 * q.t);
      const dz = q.u < 0.3 ? -c * 3 : q.u > 0.3 ? c * 1.2 : 0;
      const l = Math.hypot(dz, 1);
      return [0, 1 / l, dz / l];
    };
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < CH.length - 1; j++) {
        const a = P[i][j], b = P[i + 1][j], c = P[i + 1][j + 1], d = P[i][j + 1];
        const col = o.col((a.t + b.t) / 2, (CH[j] + CH[j + 1]) / 2);
        put(a.p, b.p, c.p, col, [a.h, b.h, c.h], [nrm(a), nrm(b), nrm(c)]);
        put(a.p, c.p, d.p, col, [a.h, c.h, d.h], [nrm(a), nrm(c), nrm(d)]);
      }
    }
    // The primaries: separate feathers springing from the END of the hand
    // (its tip edge), fanned from the leading corner — pointing a touch
    // forward — to the trailing corner, swept back; the middle ones longest.
    // (First version: out of the middle of the hand, the inner ones pointing
    // forward — "completely wrong", you 2026-09-30.)
    const F = o.fingers;
    if (F) {
      const [zf1, zb1] = at(1), x1 = o.root + o.span - 0.004;
      for (let k = 0; k < F.n; k++) {
        const f = F.n === 1 ? 0.5 : k / (F.n - 1);                      // 0 leading corner → 1 trailing corner
        const t = 1;
        const base = [x1 - 0.01 * f, 0.01 - 0.02 - 0.0012 * k, zf1 + (zb1 - zf1) * (0.08 + 0.84 * f)];
        const ang = -0.12 + 0.95 * f;                                    // + = swept back
        const dir = [Math.cos(ang), 0, -Math.sin(ang)];
        const len = F.len * (0.62 + 0.38 * Math.sin(Math.min(1, 0.2 + 1.1 * f) * Math.PI * 0.72 + 0.35));
        const w = F.width * 0.62 * (1 - 0.25 * Math.abs(f - 0.4));
        const side = [-dir[2] * w, 0, dir[0] * w];
        const mid = [base[0] + dir[0] * len * 0.55, base[1] - 0.004, base[2] + dir[2] * len * 0.55];
        const end = [base[0] + dir[0] * len, base[1] - 0.008, base[2] + dir[2] * len];
        const up = [0, 1, 0], hB = handW(t), h1 = 1;
        const L0 = [base[0] - side[0] * 0.6, base[1], base[2] - side[2] * 0.6], R0 = [base[0] + side[0] * 0.6, base[1], base[2] + side[2] * 0.6];
        const L1 = [mid[0] - side[0], mid[1], mid[2] - side[2]], R1 = [mid[0] + side[0], mid[1], mid[2] + side[2]];
        const L2 = [end[0] - side[0] * 0.55, end[1], end[2] - side[2] * 0.55], R2 = [end[0] + side[0] * 0.55, end[1], end[2] + side[2] * 0.55];
        const T2 = [end[0] + dir[0] * w * 0.9, end[1], end[2] + dir[2] * w * 0.9];
        put(L0, R0, R1, F.col, [hB, hB, h1], [up, up, up]);
        put(L0, R1, L1, F.col, [hB, h1, h1], [up, up, up]);
        put(L1, R1, R2, F.col, [h1, h1, h1], [up, up, up]);
        put(L1, R2, L2, F.col, [h1, h1, h1], [up, up, up]);
        put(L2, R2, T2, F.col, [h1, h1, h1], [up, up, up]);
      }
    }
  };

  function finish() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    // `srgb`: the colours were written as sRGB swatches (0.07 = black) — to
    // linear, or a "black" crow rendered mid-grey (alg-rts, 2026-09-30). nam
    // keeps its approved look (false).
    const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    g.setAttribute("color", new THREE.Float32BufferAttribute(srgb ? COL.map(toLin) : COL, 3));
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

  return {
    /** Everything added from now on belongs to species `i` (its index in the game's table). */
    species(i) { species = i; },
    tri, facet, quad, body, wing, standing, flying, smoothWing, finish,
  };
}

/** Mix two rgb colours. */
export const mixc = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
