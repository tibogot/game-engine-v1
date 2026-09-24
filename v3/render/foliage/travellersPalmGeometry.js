/**
 * TRAVELLER'S PALM — *Ravenala*, the flat fan. Not a true palm (it is kin to
 * the banana, which is why its blades are banana blades), and the one tree on
 * the map whose whole silhouette is a single PLANE: from the side a huge
 * half-circle fan, end on almost nothing at all.
 *
 * An ornamental in Vietnam — planted at houses, temples and town gardens rather
 * than growing wild — so it belongs at the hamlet, the résidence and the temple
 * approach, where it makes a place look PLANTED.
 *
 * BUILT FROM YOUR PHOTOGRAPHS (2026-09-23). Four things make it, in the order
 * they read from the ground up:
 *
 *   1. THE SHEATH. Where the fan meets the trunk the leaf bases overlap into
 *      a solid pale pleated V, glowing yellow-green when the sun is behind
 *      it — a narrow wedge (about ±35°), NOT a half-disc: the first build made
 *      it a half-disc and it read as a paper fan. A third of the fan's radius
 *      and the most recognisable thing about the tree. One wedge per leaf,
 *      each wedge's own UV putting the shader's midrib highlight down its
 *      centre, so the pleats come free.
 *   2. THE PETIOLES. Dozens of long BARE stalks leaving the top of the V and
 *      opening out to the full fan, like the ribs of a hand fan — about a
 *      third of its radius. A crossed pair of thin strips each, so a stalk
 *      never vanishes edge-on.
 *   3. THE BLADES. Banana blades (the banana's own torn texture, as two
 *      half-cards laid IN the fan's plane), dark, bending over and twisting out of it —
 *      which is what makes the top of the fan a ragged arc instead of a clean
 *      semicircle. The oldest, outermost ones droop furthest.
 *   4. A SLENDER RINGED TRUNK, straight, about as tall as the fan is high.
 *
 * ── PARTS ────────────────────────────────────────────────────────────────────
 *   0  sheath wedges and petioles — LEAF parts, so they take the canopy normal
 *      and the see-through glow. As a stalk (part 1, true normal) a flat
 *      vertical plane faced away from the sun on half the trees and went dark:
 *      the black-faces lesson again. `along` is held near 0 so they do not
 *      flutter, and `t` high so they sit at the pale end of the leaf ramp.
 *   3  the trunk, with leaf-scar rings from the culm shader; at FAR a closed
 *      4-sided tube (see the trunk code for why not crossed strips).
 *   5  the blades (addPlaneBlade, lift 0.85 like the banana).
 *
 * ── SHARED KEYS, RE-READ ─────────────────────────────────────────────────────
 *   fronds        leaves in the fan
 *   frondLength   plant height, unit frame
 *   leaflets      leaf-scar rings up the trunk
 *   leafletWidth  blade width
 *   leafletAngle  the blade's V-fold, degrees
 *   spread        how far round the fan opens (1 = a half circle and a bit)
 *   arch          how far a blade bends over along its length
 *   droop         how much the blade halves hang
 *   stemWidth     trunk thickness
 *   bareStalk     trunk height, as a share of the plant
 *   plumesPerStem dead leaves hanging under the fan
 *   plumeSpread   fan radius, as % of plant height
 *   `size` 12 m.
 */
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const UP = [0, 1, 0];

const LEAF = 0, TRUNK = 3;

export function buildTravellersPalm(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;

  const H = type.frondLength ?? 1;
  const leafN = Math.max(6, Math.round((type.fronds ?? 26) * (far ? 0.6 : near ? 1 : 0.65)));
  const rings = Math.max(4, Math.round((type.leaflets ?? 12) * (near ? 1 : 0.5)));
  // Slender: a 12 m Ravenala is about 25 cm through.
  const trunkR = 0.011 * H * (type.stemWidth ?? 1);
  const trunkH = H * (type.bareStalk ?? 0.5);
  const R2 = H * ((type.plumeSpread ?? 52) / 100);   // fan radius, to the blade tips
  const R0 = R2 * 0.3;                               // the sheath fan
  const R1 = R2 * 0.62;                              // where the blades begin
  const thetaMax = 1.62 * (type.spread ?? 1);
  const vFold = ((type.leafletAngle ?? 20) * Math.PI) / 180;
  const arch = type.arch ?? 0.9;
  const droop = type.droop ?? 0.5;
  const widthScale = type.leafletWidth ?? 1;
  const deadN = far ? 0 : Math.round(type.plumesPerStem ?? 2);
  const sides = near ? 7 : 5;

  // ── The fan's plane ───────────────────────────────────────────────────────
  // Everything above the trunk lies in the vertical plane through `dir`.
  // `side` is that plane's normal. FIXED, not random: the fan spans local X
  // and faces ±Z, so a place that puts one down (placedFoliage.js) knows which
  // way it shows its face — at rotY 0, across a lane that runs along X. The
  // painted fields hash a heading per plant anyway.
  const az = 0;
  rand();   // keep the sequence the trunk and the leaves were tuned on
  const dir = [Math.cos(az), 0, Math.sin(az)];
  const side = [-Math.sin(az), 0, Math.cos(az)];

  // ── Trunk ─────────────────────────────────────────────────────────────────
  // Straight: the fan is heavy, and a leaning Ravenala reads as a banana.
  const tilt = 0.012 + rand() * 0.02;
  const lean = [Math.cos(az + 1.3), 0, Math.sin(az + 1.3)];
  const at = (t) => {
    const r = Math.sin(tilt) * trunkH * t;
    return {
      p: [lean[0] * r, Math.cos(tilt) * trunkH * t, lean[2] * r],
      fwd: norm([Math.sin(tilt) * lean[0], Math.cos(tilt), Math.sin(tilt) * lean[2]]),
    };
  };
  const radiusAt = (t) => trunkR * (1 - 0.15 * t) * (1 + 0.45 * Math.exp(-t * 20));

  // FAR is a closed 4-sided tube, not the fan palm's crossed strips: a
  // crossed pair has to be part 2 to dodge the part-3 back-face flip, part 2
  // is alpha-tested against the card texture, and at distance the mip blurs
  // the texture's thin solid midrib strip into transparency — the trunk
  // vanished. A closed tube shows no back face, so it can stay part 3, and at
  // 16 triangles it costs what the strips did. A little fatter, since four
  // sides lose a third of the silhouette.
  const tubeSides = far ? 4 : sides;
  const ring = (t, radius, alongVal) => {
    const { p, fwd } = at(t);
    const ax2 = norm(cross(fwd, side));
    const base = vcount();
    for (let s = 0; s < tubeSides; s++) {
      const ph = (s / tubeSides) * Math.PI * 2;
      const cs = Math.cos(ph), sn = Math.sin(ph);
      const n = norm([side[0] * cs + ax2[0] * sn, side[1] * cs + ax2[1] * sn, side[2] * cs + ax2[2] * sn]);
      push(add(p, n, radius), n, s / tubeSides, t, [TRUNK, t, 0.12, alongVal]);
    }
    return base;
  };
  // Outward winding — see ref: an inside-out tube renders black.
  const stitch = (b0, b1) => {
    for (let s = 0; s < tubeSides; s++) {
      const s2 = (s + 1) % tubeSides;
      I.push(b0 + s, b0 + s2, b1 + s, b0 + s2, b1 + s2, b1 + s);
    }
  };
  let prev = null;
  const join = (b) => { if (prev !== null) stitch(prev, b); prev = b; };
  if (far) {
    // `along` -1: no scar rings, one pixel wide at this range.
    for (const t of [0, 0.5, 1]) join(ring(t, radiusAt(t) * 1.4, -1));
  } else {
    for (let k = 0; k <= rings; k++) {
      const t = k / rings;
      join(ring(t, radiusAt(t) * (k === 0 ? 1 : 1.05), 0));
      if (k < rings) {
        const mid = (k + 0.5) / rings;
        join(ring(mid, radiusAt(mid), 1));
        if (near) join(ring(mid, radiusAt(mid), -1));
      }
    }
  }

  // The fan's centre: a little above the trunk's top, where the sheaths start.
  const top = at(1);
  const C = add(top.p, UP, trunkH * 0.01);
  /** A direction in the fan's plane, `th` radians off vertical. */
  const inPlane = (th) => norm([dir[0] * Math.sin(th), Math.cos(th), dir[2] * Math.sin(th)]);

  // The leaves, spread evenly across the fan from one side to the other. The
  // outermost are the oldest: lowest, most tilted, drooping furthest.
  const leaves = [];
  for (let i = 0; i < leafN; i++) {
    const f = leafN === 1 ? 0.5 : i / (leafN - 1);
    const th = (f * 2 - 1) * thetaMax + (rand() - 0.5) * (thetaMax / leafN) * 0.6;
    leaves.push({ th, age: Math.abs(th) / thetaMax, r: rand() });
  }

  // ── 1. The sheath fan ─────────────────────────────────────────────────────
  // A narrow V, NOT a half-disc: in the photographs the sheaths are packed
  // into a wedge only about ±35° wide, and it is the petioles leaving its top
  // edge that open out to the full fan. So each leaf's sheath runs at a
  // fraction of its petiole's angle. One wedge between neighbouring leaves,
  // its top edge rounded a little lower toward the sides.
  const SHEATH_ANG = 0.38;
  const sheathTop = (L) => add(C, inPlane(L.th * SHEATH_ANG), R0 * (1 - 0.1 * L.age * L.age));
  for (let i = 0; i < leafN - 1; i++) {
    const pa = sheathTop(leaves[i]);
    const pb = sheathTop(leaves[i + 1]);
    const base = vcount();
    // uv.x runs 0 -> 1 across the wedge, so the leaf shader's midrib stripe
    // (uv.x = 0.5) lands down its centre: one pleat per leaf, for nothing.
    push(C, side, 0.5, 0, [LEAF, 1, 0.3, 0.04]);
    push(pa, side, 0, 1, [LEAF, 1, 0.3, 0.04]);
    push(pb, side, 1, 1, [LEAF, 1, 0.3, 0.04]);
    I.push(base, base + 1, base + 2);
  }

  // ── 2 + 3. Petioles and blades ────────────────────────────────────────────
  const petW = H * 0.0035;
  for (const L of leaves) {
    const reach = R1 * (0.93 + L.r * 0.12);
    const tip = add(C, inPlane(L.th), reach);
    // The petiole: a crossed pair of thin strips from a little inside the
    // sheath's top edge out to the blade. Mid-green — `t` a little below the
    // sheath's. Its own direction, since it leaves the V at a narrower angle
    // than it arrives at.
    const from = add(C, sub(sheathTop(L), C), 0.85);
    const d = norm(sub(tip, from));
    L.th = Math.atan2(d[0] * dir[0] + d[2] * dir[2], d[1]);
    const across = [side, norm(cross(d, side))];
    for (const ax of across) {
      const base = vcount();
      for (const [p, v] of [[from, 0], [tip, 1]]) {
        for (const s of [-1, 1]) push(add(p, ax, s * petW), cross(ax, d), s * 0.5 + 0.5, v, [LEAF, 0.72, 0.3, 0.04]);
      }
      I.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }

    // The blade: its two halves lie IN the fan's plane (face-on from the front,
    // which is how every photograph shows them), folded a little out of it.
    // The texture's bare bottom fifth is only midrib, so the card starts that
    // far back down the petiole and the join is seamless.
    const bladeLen = (R2 - R1) * (0.85 + L.r * 0.3) * (1 - 0.1 * L.age);
    addPlaneBlade({
      origin: add(tip, d, -bladeLen * 0.2), th: L.th, len: bladeLen * 1.2,
      // The old outer blades bend over furthest; every blade twists out of
      // the plane a little, one way or the other, which is what rags the arc.
      bend: arch * (0.2 + L.age * 0.85), twist: (L.r - 0.5) * 0.9 * droop,
      halfW: bladeLen * 0.2 * widthScale * (far ? 1.3 : 1),
      fold: far ? 0 : vFold, dead: false, plantT: 0.3 + L.r * 0.2,
    });
  }

  // ── Dead leaves ───────────────────────────────────────────────────────────
  // A couple hanging below the fan against the trunk, brown, as a real one
  // carries until they drop.
  for (let k = 0; k < deadN; k++) {
    const s = k % 2 === 0 ? 1 : -1;
    const th = s * (2.5 + rand() * 0.3);
    addPlaneBlade({
      origin: add(C, inPlane(th), R0 * 0.15), th, len: (R2 - R0) * 0.7,
      bend: 0.15, twist: (rand() - 0.5) * 0.6,
      halfW: (R2 - R1) * 0.09 * widthScale,
      fold: vFold * 1.8, dead: true, plantT: 0.95,
    });
  }

  return finish();

  /**
   * One blade as two half-cards on the banana texture (midrib at u = 0), laid
   * in the fan's plane rather than horizontally as `addFrondCards` lays a
   * palm's. `th` is its angle off vertical in the plane (signed: which side of
   * the fan), `bend` how far it turns further over by its tip, `twist` how far
   * it turns OUT of the plane, `fold` the V between its halves.
   */
  function addPlaneBlade({ origin, th, len, bend, twist, halfW, fold, dead, plantT }) {
    const rows = near ? 6 : far ? 2 : 3;
    const sgn = th >= 0 ? 1 : -1;
    const frondRand = dead ? 2.3 : rand();
    const part = 5.85;
    // Walk the midrib: the angle opens away from vertical by `bend`, and the
    // direction swings out of the plane by `twist`, both growing to the tip.
    const pts = [];
    let p = origin;
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      const a = th + sgn * bend * Math.pow(v, 1.5);
      const o = twist * v;
      const fwd = norm(add(inPlane(a), side, Math.sin(o)));
      pts.push({ p, v, fwd });
      p = add(p, fwd, len / rows);
    }
    for (const s of [-1, 1]) {
      const base = vcount();
      for (const { p: q, v, fwd } of pts) {
        // Across the blade in the plane, then folded toward one face.
        const acr = norm(cross(side, fwd));
        const dd = norm(add(add([0, 0, 0], acr, s * Math.cos(fold)), side, Math.sin(fold) * (twist >= 0 ? 1 : -1)));
        // NOT the card's own normal. A blade in a vertical plane has a normal
        // that is nearly horizontal, ±side at random, so half of them faced
        // away from the sun and went black. Both faces shade as the fan's
        // rounded outside instead: MOSTLY UP, and a little out to its own side
        // of the fan. Not along the blade (it points down on a drooping one),
        // and not far out sideways either: the shader flips any leaf normal
        // that faces away from the camera, and a normal lying in the fan's
        // plane sits right on that edge, so blades flipped dark at random.
        // Straight up is the one direction every camera above the ground
        // agrees about.
        const n = norm(add(add(UP, dir, sgn * 0.25), dd, 0.08));
        const w = halfW * (1 - 0.15 * v);
        push(q, n, 0, v, [part, plantT, frondRand, v]);
        push(add(q, dd, w), n, 1, v, [part, plantT, frondRand, v]);
      }
      for (let j = 0; j < rows; j++) {
        const i0 = base + j * 2;
        I.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
      }
    }
  }
}
