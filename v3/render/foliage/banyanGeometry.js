/**
 * BANYAN — *cây đa*, Ficus benghalensis: the tree at the village's communal
 * house and at the temple gate, the landmark every Vietnamese hamlet is
 * described by. Built from your photograph (the clipped dome) and the ones on
 * Wikimedia Commons (the wild crown at a paddy path, the fused trunk at An Phú,
 * the root curtains).
 *
 * WHAT MAKES A BANYAN, in the order they read from an RTS camera:
 *
 *   1. THE DOME. A crown far wider than the tree is tall — about twice — and
 *      ROUNDED: a surface of small leaves in big soft lumps, like cumulus, with
 *      a flattish underside held a few metres off the ground. Built as a
 *      half-ellipsoid (a tall upper semi-axis, a short lower one, so the
 *      underside is shallow) covered in big LEAF-CLUSTER CARDS
 *      (banyanLeafTexture.js — each card a lumpy clump of small rounded
 *      leaves with its own per-leaf shade, lit from its top). The cards FACE
 *      THE CAMERA (your arborist page's leaf cards), so every clump — the far
 *      side of the dome included — shows its full face and the crown fills
 *      itself: no solid core behind it (the first build had one; with
 *      billboards it was only a dark blob), and ~60 BIG clumps rather than
 *      260 small ones (your call). Neighbouring clumps share a low-frequency swell, so the
 *      crown billows in big lumps.
 *   2. THE TRUNK. Not a cylinder: a bundle of FUSED STRANDS (aerial roots that
 *      thickened and grew together), each a fluted tube, flaring into long low
 *      root spurs and splitting a few metres up into the heavy limbs that
 *      carry the crown out sideways — wrapped in CORDS, thin roots that fell
 *      from the limbs and grew down the trunk into the ground. The cords are
 *      what makes it read as a banyan and not an oak.
 *   3. AERIAL ROOTS. Straight lines hanging from the underside — most end in
 *      the air, a few reach the ground as thicker PILLARS, which is how an old
 *      banyan walks outward.
 *
 * ── PARTS ────────────────────────────────────────────────────────────────────
 *   3  trunk strands, limbs, roots — the culm path with `along` -1 (no rings;
 *      the culm's fine striae read as the fluting). Roots carry a higher
 *      `rand`, which the culm tone turns warmer: young roots are reddish.
 *   6.35 leaf-cluster BILLBOARDS (default): camera-facing, see the clump loop
 *   4  leaf-cluster cards with `billboard: false` (the "banyan" texture), normal = the dome's
 *      outward normal, then rounded again from the crown's centre
 *      (foliageGeometry LEAF_ROUNDING) so the dome shades as a dome.
 *
 * ── SHARED KEYS, RE-READ ─────────────────────────────────────────────────────
 *   fronds        main limbs (strands that leave the bundle)
 *   frondLength   plant height, unit frame
 *   leaflets      leaf clumps on the dome
 *   leafletWidth  clump size
 *   leafletAngle  how far the side cards of a clump tilt off the dome, degrees
 *   spread        crown radius, in plant heights (1 = twice as wide as tall)
 *   arch          how far the limbs rise before they run outward
 *   droop         how far the crown's rim hangs below its widest point
 *   stemWidth     trunk thickness
 *   bareStalk     height of the crown's underside, in plant heights
 *   plumesPerStem aerial roots, in tens
 *   plumeSpread   % of aerial roots that reach the ground as pillars
 *   `size` 18 m.
 */

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const UP = [0, 1, 0];

const WOOD = 3, CARD = 4;
/** Part 6 + the normal lift in its fraction: a card the
 * vertex stage turns to face the camera (foliageSystem positionNode). 0.35,
 * not the leaves' 0.55: the card carries the dome's ROUNDED normal (outward
 * from the crown, then rounded again by LEAF_ROUNDING), and lifting it most
 * of the way to up flattened the ball back out — your call, 2026-09-24. */
export const BILLBOARD = 6.35;
const NO_RINGS = -1;

/**
 * The wood kit, shared with the other trees (dipterocarpGeometry.js): tubes
 * along a path and quadratic curves to lay them on.
 */
export function woodKit(ctx) {
  const { push, vcount, I } = ctx;
  /**
   * A tube along `pts` (≥ 2 points) with a radius per point. `sides` round,
   * a seam vertex so uv.x closes, outward winding. `t` (the culm ramp) runs
   * from `t0` to `t1` along it.
   */
  const tube = (pts, radii, sides, { t0 = 0, t1 = 1, tone = 0.1, cap = false } = {}) => {
    const n = pts.length;
    let prev = null;
    for (let j = 0; j < n; j++) {
      const fwd = norm(sub(pts[Math.min(n - 1, j + 1)], pts[Math.max(0, j - 1)]));
      // A frame that never flips: seed it from whichever axis is least parallel.
      const ref = Math.abs(fwd[1]) < 0.9 ? UP : [1, 0, 0];
      const ax1 = norm(cross(fwd, ref)), ax2 = cross(fwd, ax1);
      const base = vcount();
      const tt = t0 + (t1 - t0) * (j / (n - 1));
      for (let s = 0; s <= sides; s++) {
        const ph = (s / sides) * Math.PI * 2;
        const nrm = add([ax1[0] * Math.cos(ph), ax1[1] * Math.cos(ph), ax1[2] * Math.cos(ph)], ax2, Math.sin(ph));
        push(add(pts[j], nrm, radii[j]), nrm, s / sides, tt, [WOOD, tt, tone, NO_RINGS]);
      }
      if (prev !== null) {
        for (let s = 0; s < sides; s++) I.push(prev + s, prev + s + 1, base + s, prev + s + 1, base + s + 1, base + s);
      }
      prev = base;
    }
    if (cap) {
      // Close the far end with a point, for the roots that end in the air.
      const last = pts[n - 1], fwd = norm(sub(last, pts[n - 2]));
      const tip = vcount();
      push(add(last, fwd, radii[n - 1] * 1.5), fwd, 0.5, t1, [WOOD, t1, tone, NO_RINGS]);
      for (let s = 0; s < sides; s++) I.push(prev + s, prev + s + 1, tip);
    }
  };
  /** A quadratic Bézier sampled at `k + 1` points. */
  const bez = (a, q, b, k) => Array.from({ length: k + 1 }, (_, i) => {
    const t = i / k;
    return lerp3(lerp3(a, q, t), lerp3(q, b, t), t);
  });
  return { tube, bez };
}

export function buildBanyan(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;

  const H = type.frondLength ?? 1;
  const Rc = H * (type.spread ?? 1);                     // crown radius
  const yb = H * (type.bareStalk ?? 0.38);                // underside height
  const Cy = yb + (H - yb) * 0.28;                        // widest point
  const aUp = H - Cy, aDown = (Cy - yb) * (1 + (type.droop ?? 0.3));
  const trunkR = 0.075 * H * (type.stemWidth ?? 1);       // the bundle's radius
  const limbN = Math.max(3, Math.round(type.fronds ?? 6));
  const clumpN = Math.max(16, Math.round((type.leaflets ?? 60) * (far ? 0.5 : near ? 1 : 0.75)));
  const cardsPer = far ? 1 : 2;
  const clumpR = 0.42 * Rc * (type.leafletWidth ?? 1) * (far ? 1.25 : near ? 1 : 1.08);
  const tiltOff = ((type.leafletAngle ?? 38) * Math.PI) / 180;
  // Cards follow the camera unless the type says `billboard: false` (fixed
  // cards lying on the dome) — the A/B switch, as on the arborist page.
  const billboard = type.billboard !== false;
  const arch = type.arch ?? 0.6;
  const rootN = Math.round((type.plumesPerStem ?? 16) * 10 * (far ? 0 : near ? 1 : 0.45));
  const pillarShare = (type.plumeSpread ?? 12) / 100;
  const pillarN = Math.max(far ? 6 : 0, Math.round((type.plumesPerStem ?? 16) * 10 * pillarShare * (near ? 1 : 0.6)));

  /** Point on the crown's ellipsoid, from angles off vertical and round. */
  const shell = (th, ph, k = 1) => {
    const s = Math.sin(th), c = Math.cos(th);
    const a = c >= 0 ? aUp : aDown;
    return [Rc * s * Math.cos(ph) * k, Cy + a * c * k, Rc * s * Math.sin(ph) * k];
  };
  /** Its outward normal. */
  const shellN = (p) => {
    const dy = p[1] - Cy;
    const a = dy >= 0 ? aUp : aDown;
    return norm([p[0] / (Rc * Rc), dy / (a * a), p[2] / (Rc * Rc)]);
  };
  /** Height of the crown's underside at a horizontal radius (for the roots). */
  const undersideAt = (r) => {
    const q = Math.min(1, r / Rc);
    return Cy - aDown * Math.sqrt(Math.max(0, 1 - q * q));
  };

  // Tubes and curves: the one primitive for trunk strands, limbs and roots.
  const { tube, bez } = woodKit(ctx);

  // ── 3. THE TRUNK: fused strands, flaring into spurs, splitting into limbs ──
  const strandN = far ? 6 : near ? 15 : 10;
  const trunkSides = far ? 4 : near ? 7 : 5;
  const forkY = yb * 0.62;
  const twist = 0.8;
  const limbEnds = [];
  const limbPaths = [];
  for (let i = 0; i < strandN; i++) {
    const a = (i / strandN) * Math.PI * 2 + (rand() - 0.5) * 0.4;
    const ring = trunkR * (0.4 + rand() * 0.35);
    const rs = trunkR * (0.3 + rand() * 0.16) * (far ? 1.3 : 1);
    // The root spur: broad, low and long — an old banyan stands on a skirt of
    // buttressing roots that run out metres from the trunk before they dive.
    const spur = trunkR * (2.2 + rand() * 1.6);
    const wob = rand() * Math.PI * 2;
    const steps = far ? 3 : near ? 10 : 6;
    const pts = [], radii = [];
    for (let k = 0; k <= steps; k++) {
      const s = k / steps;
      const y = s * forkY;
      // In from the spur fast, then a slow wander — strands are not columns.
      const r = ring + (spur - ring) * Math.exp(-s * 9) + trunkR * 0.12 * Math.sin(s * 7 + wob);
      const aa = a + twist * s;
      pts.push([Math.cos(aa) * r, y - (k === 0 ? 0.006 * H : 0), Math.sin(aa) * r]);
      // A spur is broad and low; the strand swells a little where they fuse.
      radii.push(rs * (1 + 0.7 * Math.exp(-s * 6)));
    }
    const top = pts[pts.length - 1];
    if (i < limbN) {
      // A LIMB: up and out along an arch to a point inside the crown.
      const la = a + twist + (rand() - 0.5) * 0.5;
      const reach = Rc * (0.42 + rand() * 0.3);
      const endY = yb + (Cy - yb) * (0.5 + rand() * 0.6);
      const end = [Math.cos(la) * reach, endY, Math.sin(la) * reach];
      const ctrl = [Math.cos(la) * reach * (0.25 + 0.15 * (1 - arch)), forkY + (endY - forkY) * (0.6 + 0.5 * arch), Math.sin(la) * reach * (0.25 + 0.15 * (1 - arch))];
      const limb = bez(top, ctrl, end, far ? 3 : near ? 8 : 5).slice(1);
      for (let k = 0; k < limb.length; k++) {
        pts.push(limb[k]);
        radii.push(rs * (1 - 0.65 * ((k + 1) / limb.length)));
      }
      limbEnds.push({ p: end, a: la, r: rs * 0.35 });
      limbPaths.push({ pts: limb, rs });
    } else {
      // An inner strand: rises into the fork and ends inside the bundle.
      pts.push([top[0] * 0.6, forkY * 1.12, top[2] * 0.6]);
      radii.push(rs * 0.5);
    }
    tube(pts, radii, trunkSides, { t0: 0, t1: 1, tone: 0.06 + rand() * 0.08 });
  }

  // CORDS — the rope-work that makes a banyan trunk a BANYAN trunk (An Phú,
  // and every close photograph): thin aerial roots that dropped from the limbs,
  // found the trunk, and grew down it into the ground, fusing as they went.
  // Each one leaves a limb partway out, falls to the trunk's surface, and
  // winds down it to a flared foot.
  if (!far) {
    const cordN = near ? 22 : 10;
    for (let c = 0; c < cordN; c++) {
      const L = limbPaths[c % limbPaths.length];
      const j = Math.min(L.pts.length - 1, 1 + Math.floor(rand() * Math.max(1, L.pts.length * 0.5)));
      const start = L.pts[j];
      const a0 = Math.atan2(start[2], start[0]) + (rand() - 0.5) * 0.6;
      const skin = trunkR * (1.0 + rand() * 0.25);        // just proud of the bundle
      const foot = trunkR * (1.6 + rand() * 1.6);
      const turn = (rand() - 0.5) * 1.6;
      const rc = trunkR * (0.1 + rand() * 0.12);
      const pts = [start];
      const n = near ? 7 : 4;
      for (let k = 0; k <= n; k++) {
        const s = k / n;                                  // 0 at the fork, 1 at the ground
        const y = forkY * 0.95 * (1 - s) - (k === n ? 0.006 * H : 0);
        const r = skin + (foot - skin) * Math.pow(s, 4);
        const aa = a0 + turn * s;
        pts.push([Math.cos(aa) * r, y, Math.sin(aa) * r]);
      }
      tube(pts, pts.map((_, k) => rc * (k === 0 ? 0.7 : 1 + 0.8 * Math.pow(k / (pts.length - 1), 4))),
        near ? 4 : 3, { t0: 0.6, t1: 0, tone: 0.08 + rand() * 0.14 });
    }
  }

  // Secondary branches off each limb, up into the crown — what shows through
  // the gaps between clumps as dark lines.
  if (!far) {
    for (const L of limbEnds) {
      const nb = near ? 3 : 2;
      for (let b = 0; b < nb; b++) {
        const ba = L.a + (rand() - 0.5) * 1.6;
        const th = 0.5 + rand() * 0.9;
        const end = shell(th, ba, 0.88);
        const ctrl = lerp3(L.p, end, 0.5);
        ctrl[1] += 0.04 * H;
        const pts = bez(L.p, ctrl, end, near ? 4 : 3);
        tube(pts, pts.map((_, k) => L.r * (1 - 0.7 * (k / (pts.length - 1)))), near ? 4 : 3, { t0: 0.8, t1: 1, tone: 0.1 });
      }
    }
  }

  // ── 4. AERIAL ROOTS ────────────────────────────────────────────────────────
  // Hanging roots: straight down from the underside, ending in the air.
  const rootSides = 3;
  for (let k = 0; k < rootN; k++) {
    const a = rand() * Math.PI * 2;
    const r = Rc * (0.12 + Math.sqrt(rand()) * 0.8);
    const yTop = undersideAt(r) + 0.01 * H;
    const len = yTop * (0.15 + rand() * 0.5);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rr = H * (0.003 + rand() * 0.003);
    tube([[x, yTop, z], [x + (rand() - 0.5) * 0.01 * H, yTop - len, z + (rand() - 0.5) * 0.01 * H]], [rr, rr * 0.6],
      rootSides, { t0: 0.5, t1: 0.3, tone: 0.18 + rand() * 0.2, cap: true });
  }
  // Pillars: the roots that reached the ground and thickened into trunks.
  for (let k = 0; k < pillarN; k++) {
    const a = rand() * Math.PI * 2;
    const r = Rc * (0.3 + rand() * 0.5);
    const yTop = undersideAt(r) + 0.02 * H;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rr = H * (0.006 + rand() * 0.007) * (far ? 1.6 : 1);
    tube([[x, -0.004 * H, z], [x, yTop * 0.5, z], [x, yTop, z]], [rr * 1.4, rr, rr * 0.8],
      far ? 3 : 5, { t0: 0.1, t1: 0.6, tone: 0.12 + rand() * 0.1 });
  }

  // ── 1. THE DOME: leaf clumps of cards ─────────────────────────────────────
  // Fibonacci points over the ellipsoid, thinned on the underside (it is in
  // shade and seen edge-on; the core covers it), then pushed in or out.
  const golden = Math.PI * (3 - Math.sqrt(5));
  // A CAP over the crown's top first: the spiral leaves the pole thin, and
  // the RTS camera looks straight at it — it showed as a dark hole.
  const cap = far ? 3 : 5;
  const spots = [];
  for (let k = 0; k <= cap; k++) spots.push(k === 0 ? [0.05, 0] : [0.3, (k / cap) * Math.PI * 2 + 0.4]);
  for (let i = 0; i < clumpN; i++) {
    const u = (i + 0.5) / clumpN;
    // Denser toward the top: the view is from above and the top is lit.
    spots.push([Math.acos(1 - 2 * Math.pow(u, 0.85)), i * golden]);
  }
  for (const [th, ph0] of spots) {
    // Nothing much below the widest point: the underside is the core's, in
    // shade, and it is what shows the trunk and the roots under the crown.
    if (th > Math.PI * 0.64) continue;
    const ph = ph0 + (rand() - 0.5) * 0.3;
    // Neighbouring clumps share a low-frequency swell, so the crown billows
    // in big lumps (cumulus, in every photo) rather than a fine even fuzz.
    const lump = 1 + 0.09 * Math.sin(3 * ph + 2 * th) * Math.cos(2 * ph - 3 * th) + (rand() - 0.5) * 0.06;
    const c = shell(th, ph, lump);
    const n = shellN(c);
    // Tangent frame on the dome. The card's texture is lit from its top
    // (banyanLeafTexture.js), so its v axis must run UP the dome: with this
    // frame B = n x T, and at a turn of π that is up-slope. A few tenths of a
    // radian either way so the clumps don't line up; near the crown's top,
    // where "up the dome" means nothing, any turn will do.
    const t0 = norm(cross(n, Math.abs(n[1]) < 0.95 ? UP : [1, 0, 0]));
    const b0 = cross(n, t0);
    const rot = Math.abs(n[1]) < 0.9 ? Math.PI + (rand() - 0.5) * 0.6 : rand() * Math.PI * 2;
    const T = add([t0[0] * Math.cos(rot), t0[1] * Math.cos(rot), t0[2] * Math.cos(rot)], b0, Math.sin(rot));
    const B = cross(n, T);
    // Smaller under the widest point: a camera-facing card there hangs its
    // lower half DOWN, and at full size the rim drooped to three metres off
    // the ground and hid the trunk and the root curtains under it.
    const rho = clumpR * (0.75 + rand() * 0.5) * (th > Math.PI * 0.5 ? 0.62 : 1);
    const hFrac = Math.max(0, Math.min(1, c[1] / H));
    const cardRand = rand();
    if (billboard) {
      // BILLBOARDS (the default, from your arborist page): each card is four
      // vertices at one centre that the vertex stage spreads to face the
      // camera; `along` carries its half-size, `uv` its corner, and `rand`
      // (0.5 = upright) a small roll. The clump's cards sit a little apart —
      // out along the normal and across it — so a clump has depth.
      for (let k = 0; k < cardsPer; k++) {
        const o = add(add(add(c, n, (k - 0.5) * rho * 0.35), T, (rand() - 0.5) * rho * 0.6), B, (rand() - 0.5) * rho * 0.6);
        const s = rho * (k === 0 ? 1 : 0.78);
        const roll = 0.5 + (rand() - 0.5) * 0.16;
        const base = vcount();
        for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          push(o, n, cu, cv, [BILLBOARD, 0.35 + 0.65 * hFrac, roll, s]);
        }
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      continue;
    }
    for (let k = 0; k < cardsPer; k++) {
      // k = 0 lies on the surface; the others tilt off it about T, either way.
      const tilt = k === 0 ? 0 : (k % 2 ? 1 : -1) * tiltOff * (0.7 + rand() * 0.6);
      const ct = Math.cos(tilt), st = Math.sin(tilt);
      const bb = add([B[0] * ct, B[1] * ct, B[2] * ct], n, st);
      const nn = add([n[0] * ct, n[1] * ct, n[2] * ct], B, -st);
      const o = add(c, n, k === 0 ? 0 : rho * 0.12);
      const s = rho * (k === 0 ? 1 : 0.8);
      const base = vcount();
      for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = add(add(o, T, du * s), bb, dv * s);
        // `along` small: a crown this size barely flutters.
        push(p, nn, (du + 1) / 2, (dv + 1) / 2, [CARD, 0.35 + 0.65 * hFrac, cardRand, 0.15]);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  return finish();
}
