/**
 * JUNGLE TREE — the emergent that stands over a Vietnamese rainforest.
 *
 * The map had NO trees at all before this: eight empty tree slots, nothing
 * painted, and every "tree" on screen was a foliage card, the tallest an 11 m
 * palm. So the canopy layer — the thing that makes jungle read as jungle from
 * an RTS camera — did not exist.
 *
 * ── WHAT MAKES A RAINFOREST GIANT READ ───────────────────────────────────────
 *   1. THE LONG CLEAN BOLE. No branch for the lower two thirds. This is the
 *      single strongest tell and it is free: a tree that branches low reads as
 *      an orchard tree, an oak, a European wood. Competition for light in a
 *      closed canopy kills every low branch, and the bare column is what you
 *      see under the roof.
 *   2. BUTTRESS ROOTS. Thin vertical planks flaring out of the foot. Tropical
 *      soil is shallow, so these trees brace themselves instead of rooting
 *      deep. A trunk that meets the ground as a plain cylinder reads as a
 *      telegraph pole with leaves on.
 *   3. A FLAT, WIDE CROWN — a parasol, wider than it is deep, held ABOVE
 *      everything else. Not a ball. The branches leave steeply and then
 *      flatten out under their own weight into horizontal plates.
 *   4. LEAVES IN PLATES AT THE BRANCH ENDS, not along the branch, with sky
 *      between the plates. That gappiness is what stops a stand of these from
 *      turning into one green mass.
 *
 * ── PARTS ────────────────────────────────────────────────────────────────────
 *   3  BARK    trunk, buttresses, branches — `colorHead`, normal lifted 45%
 *              (the bamboo culm path). `along` is pinned at -1 so the culm
 *              shader's node scar and waxy bloom never fire: a dipterocarp is
 *              not jointed. What survives is the up-trunk ramp, the fine
 *              vertical striation, and per-tree ageing from `rand`.
 *   4  CANOPY  a leaf plate, alpha from canopyClusterTexture.js, shaded as a
 *              leaf (colour ramp, translucency, flutter).
 *
 * ── SHARED KEYS, RE-READ ─────────────────────────────────────────────────────
 *   fronds        branches in the crown
 *   frondLength   tree height, unit frame
 *   leaflets      leaf plates per branch
 *   leafletWidth  plate size
 *   leafletAngle  how far a plate tilts out of horizontal, degrees
 *   spread        crown radius as a fraction of height
 *   arch          how far a branch flattens from steep to horizontal
 *   droop         extra tilt on the outermost plates
 *   stemWidth     trunk thickness
 *   bareStalk     the clean bole: where the lowest branch leaves, 0-1
 *   plumesPerStem buttress roots
 *   plumeSpread   buttress reach, % of tree height
 *   `size` is the height in METRES — 26 for an emergent, which is 2.4x the
 *   palm beside it and is the point of the thing.
 */

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const UP = [0, 1, 0];

const BARK = 3, CANOPY = 4;

/** No bamboo node anywhere on a tree: -1 is "middle of an internode". */
const NO_NODE = -1;

/** A curve integrated from an angle-from-vertical function (as the palm's). */
function integrate(samples, len, thetaAt) {
  const pts = [];
  let r = 0, y = 0;
  const ds = len / samples;
  for (let j = 0; j <= samples; j++) {
    pts.push({ v: j / samples, r, y, th: thetaAt(j / samples) });
    const thm = thetaAt((j + 0.5) / samples);
    r += Math.sin(thm) * ds;
    y += Math.cos(thm) * ds;
  }
  return pts;
}

export function buildJungleTree(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;

  const H = type.frondLength ?? 1;
  const branchN = Math.max(3, Math.round((type.fronds ?? 7) * (far ? 0 : near ? 1 : 0.7)));
  const platesPer = Math.max(1, Math.round((type.leaflets ?? 3) * (near ? 1 : 0.65)));
  // A 26 m dipterocarp is about 0.9 m through at chest height: 1:29, and it
  // tapers hard, unlike a palm.
  const trunkR = 0.017 * H * (type.stemWidth ?? 1);
  const crownR = H * (type.spread ?? 0.34);
  // A cluster is a TWIG BUNDLE, about 2 m across on a 26 m tree — not a
  // six-metre plate. See the note on `cluster`: the whole failure mode of the
  // earlier versions was that the cards were big enough to see.
  const plateR = crownR * 0.155 * (type.leafletWidth ?? 1);
  const plateTilt = ((type.leafletAngle ?? 22) * Math.PI) / 180;
  const arch = type.arch ?? 0.85;
  const droop = type.droop ?? 0.35;
  const bare = type.bareStalk ?? 0.62;
  const buttN = far ? 0 : Math.round(type.plumesPerStem ?? 5);
  const buttR = H * ((type.plumeSpread ?? 9) / 100);
  const buttH = buttR * 1.5;
  const sides = near ? 9 : 6;

  // ── The bole ──────────────────────────────────────────────────────────────
  // Barely off vertical. A rainforest trunk grows straight up — it is racing
  // its neighbours for the roof — and a leaning one reads as a palm.
  const az = rand() * Math.PI * 2;
  const dir = [Math.cos(az), 0, Math.sin(az)];
  const side = [-Math.sin(az), 0, Math.cos(az)];
  const samples = 16;
  const lean = 0.055;
  // The bole ends where the last branch leaves it: a spike of bare trunk
  // standing above the crown is the silhouette of a dead tree.
  const topT = 0.93;
  const line = integrate(samples, H * topT, (v) => lean * Math.max(0, 1 - v * 1.35));
  const at = (t) => {
    const jf = Math.min(samples - 1e-4, Math.max(0, t)) * samples;
    const j0 = Math.min(samples - 1, Math.floor(jf)), k = jf - j0;
    const A = line[j0], B = line[j0 + 1];
    const r = A.r + (B.r - A.r) * k, y = A.y + (B.y - A.y) * k, th = A.th + (B.th - A.th) * k;
    return {
      p: [dir[0] * r, y, dir[2] * r],
      fwd: norm([Math.sin(th) * dir[0], Math.cos(th), Math.sin(th) * dir[2]]),
    };
  };
  // Tapers to 40% at the crown, with the foot swelling into the buttresses.
  const radiusAt = (t) => trunkR * (1 - 0.6 * t) * (1 + 1.5 * Math.exp(-t * (H / buttH) * 1.6));
  const barkTone = 0.2 + rand() * 0.5;

  const ring = (t, radius) => {
    const { p, fwd } = at(t);
    const ax2 = norm(cross(fwd, side));
    const base = vcount();
    for (let s = 0; s < sides; s++) {
      const ph = (s / sides) * Math.PI * 2;
      const cs = Math.cos(ph), sn = Math.sin(ph);
      const n = norm([side[0] * cs + ax2[0] * sn, side[1] * cs + ax2[1] * sn, side[2] * cs + ax2[2] * sn]);
      push(add(p, n, radius), n, s / sides, t, [BARK, t, barkTone, NO_NODE]);
    }
    return base;
  };
  // Outward winding — see ref: an inside-out tube renders black.
  const stitch = (b0, b1) => {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      I.push(b0 + s, b0 + s2, b1 + s, b0 + s2, b1 + s2, b1 + s);
    }
  };

  if (far) {
    // Two crossed quads. At the range this level is for, the bole is one or
    // two pixels wide and all that is asked of it is to be THERE, dark, under
    // the crown — without it the canopy floats.
    for (const across of [true, false]) {
      const base = vcount();
      const segs = 3;
      for (let q = 0; q <= segs; q++) {
        const t = q / segs;
        const { p, fwd } = at(t);
        const axis = across ? side : norm(cross(fwd, side));
        const n = norm(cross(fwd, axis));
        for (const s of [-1, 1]) push(add(p, axis, s * radiusAt(t)), n, s * 0.5 + 0.5, t, [BARK, t, barkTone, NO_NODE]);
      }
      for (let q = 0; q < segs; q++) {
        const i0 = base + q * 2;
        I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
      }
    }
  } else {
    // Rings bunched near the foot, where the flare is, and sparse up the
    // straight part where nothing changes.
    const ts = near ? [0, 0.04, 0.1, 0.2, 0.42, 0.68, 0.86, 1] : [0, 0.08, 0.25, 0.6, 1];
    let prev = null;
    for (const t of ts) {
      const b = ring(t, radiusAt(t));
      if (prev !== null) stitch(prev, b);
      prev = b;
    }
  }

  // ── Buttress roots ────────────────────────────────────────────────────────
  // A flat fin each: the material is double-sided, so one strip reads from
  // both flanks, and what this is for is the SILHOUETTE at the foot. The
  // outer edge falls away in a curve — a buttress is a fillet between trunk
  // and ground, not a triangle.
  for (let b = 0; b < buttN; b++) {
    const ba = (b / buttN) * Math.PI * 2 + rand() * 0.5;
    const out = [Math.cos(ba), 0, Math.sin(ba)];
    const nrm = norm([-Math.sin(ba), 0, Math.cos(ba)]);
    const reach = buttR * (0.7 + rand() * 0.6);
    const high = buttH * (0.75 + rand() * 0.5);
    const segs = 4;
    const base = vcount();
    for (let s = 0; s <= segs; s++) {
      const f = s / segs;
      // Outer edge: from far out at the ground to the trunk at the top,
      // pulled in fast so the profile is concave.
      const rOut = reach + (radiusAt(0) * 0.9 - reach) * Math.pow(f, 0.55);
      const y = high * f;
      const rIn = radiusAt(y / H) * 0.92;
      push(add([0, y, 0], out, rIn), nrm, 0, y / H, [BARK, y / H, barkTone, NO_NODE]);
      push(add([0, y, 0], out, rOut), nrm, 1, y / H, [BARK, y / H, barkTone, NO_NODE]);
    }
    for (let s = 0; s < segs; s++) {
      const i0 = base + s * 2;
      I.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
  }

  // ── The crown ─────────────────────────────────────────────────────────────
  /**
   * ONE CLUSTER: a crossed pair of cards, both through the same point, both
   * containing `n` (the direction the cluster faces out of the crown), rolled
   * to a random angle about it.
   *
   * WHY CROSSED, AND WHY SMALL. The first three versions of this crown were
   * built from eight or ten BIG plates, one per branch end, six metres across.
   * Every one of them failed the same way: you could see the cards. A flat
   * quad that big is a slab from one angle, a bright line from another, and
   * two of them overlapping read as shattered glass. No amount of work on the
   * texture fixes it, because the problem is that the eye can resolve the
   * card.
   *
   * A real crown is resolved as a MASS with a ragged edge, so it is built as
   * a shell of MANY SMALL clusters — about the size of a real twig bundle,
   * 2 m rather than 6 — spread over the surface of the crown. At that size no
   * single card is legible, the overlaps read as depth instead of as sheets,
   * and the silhouette is made of two dozen leaf tips rather than four
   * straight edges. It costs four triangles a cluster, so seventy of them is
   * 280 triangles — less than the trunk.
   */
  const cluster = (c, n, r, rnd, hFrac) => {
    // Any two axes spanning the plane the cards stand in.
    const a1 = norm(cross(Math.abs(n[1]) > 0.9 ? [1, 0, 0] : UP, n));
    const a2 = norm(cross(n, a1));
    const roll = rnd * Math.PI * 2;
    for (const k of [0, 1]) {
      const th = roll + k * Math.PI * 0.5;
      const ct = Math.cos(th), st = Math.sin(th);
      const across = norm(add(add([0, 0, 0], a1, ct), a2, st));
      const upish = norm(cross(n, across));
      const bse = vcount();
      // v runs up the card, which is how the texture is drawn (the twigs enter
      // at v = 0) and what `along` feeds: the outer leaves flutter and take
      // the pale end of the colour ramp.
      for (const vv of [0, 1]) {
        for (const uu of [-1, 1]) {
          const p = add(add(c, upish, r * (vv * 2 - 1) * 0.85), across, uu * r);
          // uv is the CARD's own, not the tree's. This line read `hFrac` for
          // v for three versions of this tree, which gave every vertex of a
          // card the same v — so the card sampled ONE ROW of the cluster
          // texture and stretched it top to bottom. That, and not the leaf
          // drawing, is what made the crown come out as combs, then ladders,
          // then chain-link, however the texture was redrawn. The height the
          // colour ramp wants rides in aPlant.y, which is a different channel.
          push(p, n, uu * 0.5 + 0.5, vv, [CANOPY, hFrac, rnd, vv]);
        }
      }
      I.push(bse, bse + 1, bse + 2, bse + 1, bse + 3, bse + 2);
    }
  };

  /**
   * Where the clusters sit: a PARABOLOID CAP, wide and shallow — the parasol.
   * `u` is area-uniform (sqrt), so they do not bunch in the middle, and the
   * golden angle keeps successive ones apart instead of in spokes.
   *
   * The normal is blended from straight up at the middle to outward at the
   * rim, which is what gives the crown its dome shading and stops the rim
   * clusters from being seen edge-on.
   */
  const crownTop = H * 0.995;
  const crownDepth = H * 0.2;
  const shell = (count, r) => {
    for (let i = 0; i < count; i++) {
      const u = (i + 0.6) / count;
      const rad = crownR * Math.sqrt(u) * (0.88 + rand() * 0.24);
      const a = i * 2.39996 + rand() * 0.5;
      const k = rad / crownR;
      const y = crownTop - crownDepth * k * k - rand() * H * 0.035;
      const c = [Math.cos(a) * rad, y, Math.sin(a) * rad];
      // Up in the middle, outward at the rim, with a little slop so the shell
      // is not a perfect surface of revolution.
      const out = [Math.cos(a) * k, 0, Math.sin(a) * k];
      // Weighted well toward UP even at the rim. A crown is lit from the sky:
      // a cluster whose normal lies over toward the horizon turns away from
      // the sun and goes black, which is the one artifact the whole map was
      // just cleaned of. The outward part is there to give the dome its form,
      // not to be physically right about which way a twig faces.
      const n = norm([out[0] * 0.75 + (rand() - 0.5) * 0.3, 1.3 - k * 0.42 + (rand() - 0.5) * 0.16, out[2] * 0.75 + (rand() - 0.5) * 0.3]);
      cluster(c, n, r * (0.8 + rand() * 0.45), rand(), Math.max(0, Math.min(1, y / H)));
    }
  };

  if (far) {
    // The coarse level. The bamboo lesson: a coarse level must GROW its
    // surviving cards as it drops their count, or the stand reads as wisps at
    // the range it exists for. Ten clusters at 2.6x.
    shell(10, plateR * 2.6);
    return finish();
  }

  for (let i = 0; i < branchN; i++) {
    // Golden angle round the trunk, and up the last third of it. Both matter:
    // stacked azimuths give a two-sided tree, and branches all at one height
    // give a wheel.
    const a = i * 2.39996 + rand() * 0.35;
    const t0 = bare + (1 - bare) * ((i + 0.5) / branchN) * 0.92;
    const outDir = [Math.cos(a), 0, Math.sin(a)];
    const start = at(t0);
    const L = crownR * (0.72 + rand() * 0.42) * (0.75 + 0.25 * (t0 - bare) / Math.max(1e-3, 1 - bare));
    // Steep off the trunk, flattening toward horizontal at the tip: the
    // parasol. pow(v, 0.7) puts most of the bend in the first half, which is
    // how a branch carrying its own weight actually hangs.
    const th0 = 0.62;
    const bl = integrate(4, L, (v) => th0 + arch * (1.5 - th0) * Math.pow(v, 0.7));
    const bSides = near ? 4 : 3;
    const bAt = (j) => {
      const B = bl[j];
      return {
        p: [start.p[0] + outDir[0] * B.r, start.p[1] + B.y, start.p[2] + outDir[2] * B.r],
        fwd: norm([Math.sin(B.th) * outDir[0], Math.cos(B.th), Math.sin(B.th) * outDir[2]]),
        v: B.v,
      };
    };
    const bR = (v) => trunkR * (0.6 - 0.42 * v) * (1 + 0.8 * Math.exp(-v * 9));
    let prev = null;
    for (let j = 0; j < bl.length; j++) {
      const { p, fwd, v } = bAt(j);
      const axis = norm(cross(fwd, UP));
      const ax2 = norm(cross(fwd, axis));
      const base = vcount();
      const hF = Math.max(0, Math.min(1, p[1] / H));
      for (let s = 0; s < bSides; s++) {
        const ph = (s / bSides) * Math.PI * 2;
        const cs = Math.cos(ph), sn = Math.sin(ph);
        const n = norm([axis[0] * cs + ax2[0] * sn, axis[1] * cs + ax2[1] * sn, axis[2] * cs + ax2[2] * sn]);
        push(add(p, n, bR(v)), n, s / bSides, hF, [BARK, hF, barkTone, NO_NODE]);
      }
      if (prev !== null) {
        for (let s = 0; s < bSides; s++) {
          const s2 = (s + 1) % bSides;
          I.push(prev + s, prev + s2, base + s, prev + s2, base + s2, base + s);
        }
      }
      prev = base;
    }

    // A few clusters hang UNDER the branch, out at its end. The shell above
    // is the roof; these are what you see when the camera is low and looking
    // into the tree, and without them a branch ends in nothing.
    for (let k = 0; k < platesPer; k++) {
      const f = platesPer === 1 ? 1 : 0.45 + 0.55 * (k / (platesPer - 1));
      const j = Math.min(bl.length - 1, Math.round(f * (bl.length - 1)));
      const node = bAt(j);
      const hF = Math.max(0, Math.min(1, node.p[1] / H));
      const c = add(node.p, UP, -plateR * 0.35);
      // Outward and slightly UP, even though these hang under the branch. A
      // shading normal here is a convention, not a measurement: pointed down,
      // as the geometry would have it, these clusters fell past the terminator
      // and went black — the same failure the whole map had last week.
      const n = norm([outDir[0] * 0.8, 0.62, outDir[2] * 0.8]);
      cluster(c, n, plateR * (0.7 + 0.3 * f), rand(), hF);
    }
  }

  // The roof. Laid over the branches rather than hung off them: a crown is a
  // surface, and hanging clusters off branch ends alone leaves a ring with a
  // hole in the middle — straight down the trunk from above, which is exactly
  // the camera this game is played from.
  shell(near ? 86 : 32, plateR);

  return finish();
}
