/**
 * BAMBOO — a clump of culms, built the way Southeast Asian bamboo grows.
 *
 * Its own file because a bamboo is not a rosette: everything else in
 * foliageGeometry.js radiates from one crown at the ground, and this radiates
 * from a dozen crowns ten metres up. The attribute contract is the same one
 * (see that file's header) and the same material shades it.
 *
 * ── WHAT MAKES A BAMBOO READ AS BAMBOO ───────────────────────────────────────
 * In the order of how much each one carries, because the cheap ones are the
 * ones that matter:
 *
 *   1. NODES, UNEVENLY SPACED. The culm is divided by raised rings, and the
 *      internodes between them are short at the base, longest around the lower
 *      third, and shorten again toward the tip. Evenly spaced rings read as a
 *      striped pipe, which is the single most common way a bamboo goes wrong.
 *      A node is three things stacked — a dark sheath-scar line, the raised
 *      ring, a pale waxy bloom just above — and the shader draws two of them
 *      from `along` (see below), so it costs no texture.
 *   2. A CLEAN LOWER POLE. Nothing branches for the first half. That stretch
 *      of bare parallel verticals IS the bamboo silhouette; branch it low and
 *      you have drawn a generic tree.
 *   3. THE CLUMP. Vietnamese bamboo is clumping (Bambusa), not running: 3-9
 *      culms out of one rhizome, splaying slightly, at mixed ages and heights.
 *      One culm alone never looks right, whatever you do to it.
 *   4. THE ARCH, ALL OF IT IN THE TOP THIRD. A tall culm is a straight pole
 *      that bows only near its crown, under the weight of its own leaves.
 *      Bending it evenly along its length gives a fishing rod; leaving it dead
 *      straight gives scaffolding.
 *   5. LEAVES: small, narrow (about 8:1), lanceolate, in sprays of 5-9 on thin
 *      branches, and they hang.
 *
 * ── PARTS AND COLOUR ─────────────────────────────────────────────────────────
 * `part` picks the shading path in foliageSystem.js:
 *   1  branch   the pale stem colour, solid
 *   4  CARD     the leaf spray — colorBase → colorTip, translucent, flutters,
 *               shaped by the alpha of bambooSprayTexture.js. Leaves used to be
 *               part-0 geometry blades; see that file for why they are cards.
 *   3  CULM     colorHead, solid, and KEEPS ITS TRUE NORMAL — the one thing
 *               bamboo needed that the other plants did not. Parts 0 and 2 are
 *               shaded with a canopy normal bent 95% to straight up, which is
 *               right for a leaflet and wrong for a pole: a culm lit that way
 *               loses its round shading and reads as a flat green stripe.
 *               So the culm is part 3, outside the "soft" range.
 *
 * `along` on a culm vertex is the SIGNED DISTANCE TO THE NEAREST NODE, in
 * half-internodes: 0 on the node, +1 mid-internode above it, −1 mid-internode
 * below. The fragment shader draws the scar (|along| ≈ 0) and the bloom (small
 * positive) from it. The up-culm colour ramp reads `t` instead.
 */

// Local copies: foliageGeometry.js keeps its vector helpers private, and these
// are four lines. Same semantics, deliberately.
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/**
 * Part ids, named so the builder reads. CARD is a leaf in every way (colour,
 * translucency, canopy normal, flutter) except that its shape is the alpha of
 * bambooSprayTexture.js rather than its outline.
 */
const BRANCH = 1, CULM = 3, CARD = 4;

/**
 * Where the nodes sit up a culm, as fractions of its length.
 *
 * Internode length peaks around a third of the way up and falls off to both
 * ends — the real distribution, and the reason a bamboo does not read as a
 * ruler. Normalised so the stops still end at 1 whatever the jitter did.
 *
 * @returns {number[]} n + 1 stops, 0 … 1
 */
function nodeStops(n, rand) {
  const w = [];
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const s = k / Math.max(1, n - 1);
    const len = 0.35 + 0.95 * Math.sin(Math.PI * Math.pow(s, 0.72)) + (rand() - 0.5) * 0.14;
    w.push(Math.max(0.15, len));
    sum += w[k];
  }
  const stops = [0];
  let acc = 0;
  for (let k = 0; k < n; k++) {
    acc += w[k] / sum;
    stops.push(Math.min(1, acc));
  }
  return stops;
}

/**
 * The culm's centreline, as angles from vertical integrated into a curve.
 *
 * Same integration as foliageGeometry's `archCurve`, with one difference that
 * is the whole point: the bend is raised to a high power, so it lives in the
 * TOP of the culm instead of being spread evenly along it.
 */
function culmCurve(samples, len, lean, arch) {
  const pts = [];
  let r = 0, y = 0;
  const ds = len / samples;
  for (let j = 0; j <= samples; j++) {
    pts.push({ v: j / samples, r, y, th: lean + arch * Math.pow(j / samples, 2.2) });
    const thm = lean + arch * Math.pow((j + 0.5) / samples, 2.2);
    r += Math.sin(thm) * ds;
    y += Math.cos(thm) * ds;
  }
  return pts;
}

/**
 * One clump of bamboo in a unit frame: base at the origin, about 1 unit tall.
 *
 * @param {object} type  a foliage type (foliageScatterState.js)
 *   fronds        culms in the clump
 *   frondLength   culm height, unit frame
 *   leaflets      internodes per culm (nodes = this + 1)
 *   stemWidth     culm thickness
 *   spread        how far the culms splay out of the clump
 *   arch          how far the crown bows over
 *   bareStalk     share of the culm that carries no branches
 *   leafletAngle  branch angle away from the culm
 *   leafletWidth  leaf size
 *   droop         how much branches and leaves hang
 *   plumesPerStem leaves per spray
 *   plumeSpread   how wide a spray fans, degrees
 * @param {object} ctx  the shared emit helpers from createFoliageTypeGeometry
 */
export function buildBamboo(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;

  const culms = Math.max(1, Math.round((type.fronds ?? 5) * (far ? 0.7 : 1)));
  const height = type.frondLength ?? 1;
  const internodes = Math.max(4, Math.round((type.leaflets ?? 22) * (far ? 0.45 : near ? 1 : 0.7)));
  // Culm radius, in units of the plant's height. A real Bambusa is about
  // 1:110 — 9 cm through at 10 m — and at that ratio it is honestly a bit thin
  // to read: the node rings have nothing to sit on. 0.0062 is a fat, old,
  // lowland culm (11 cm at 9 m), which is what a bamboo looks like in a photo.
  const culmR = 0.0062 * (type.stemWidth ?? 1);
  const clumpR = 0.05 * (type.spread ?? 1);
  const bare = Math.min(0.85, type.bareStalk ?? 0.5);
  const branchAngle = ((type.leafletAngle ?? 48) * Math.PI) / 180;
  const leafScale = type.leafletWidth ?? 1;
  const droop = type.droop ?? 0.35;
  // (`plumesPerStem`, leaves per spray, is now drawn into the card texture;
  // it no longer changes the geometry.)
  const sprayFan = ((type.plumeSpread ?? 26) * Math.PI) / 180;
  const archAmount = type.arch ?? 0.5;

  // Sides on the culm tube. FAR does not use a tube at all (see below).
  const sides = near ? 6 : 5;

  for (let c = 0; c < culms; c++) {
    // Golden angle so the culms never line up, whatever the count.
    const az = c * 2.39996 + rand() * 0.7;
    const cr = rand();
    const dir = [Math.cos(az), 0, Math.sin(az)];
    const side = [-Math.sin(az), 0, Math.cos(az)];
    // Packed base offsets: the clump is congested at the middle and thins out.
    const r0 = clumpR * Math.sqrt((c + 0.45) / culms);
    // Mixed ages. The short ones are young culms that have not run up yet.
    const h = height * (0.66 + cr * 0.44);
    const lean = (0.05 + cr * 0.10) * (type.spread ?? 1);
    // Keep the spread of arches narrow. At (0.5 + cr*0.9) one culm in five
    // bent 55° at the tip and read as a fishing rod rather than a pole with a
    // heavy crown — a bamboo bows, it does not whip.
    const arch = archAmount * (0.55 + cr * 0.5);
    const rad = culmR * (0.82 + cr * 0.36);

    const samples = Math.max(8, internodes);
    const line = culmCurve(samples, h, lean, arch);

    /** Point and frame at `t` (0 base → 1 tip) up this culm. */
    const at = (t) => {
      const jf = Math.min(samples - 1e-4, Math.max(0, t)) * samples;
      const j0 = Math.min(samples - 1, Math.floor(jf)), k = jf - j0;
      const A = line[j0], B = line[j0 + 1];
      const r = A.r + (B.r - A.r) * k;
      const y = A.y + (B.y - A.y) * k;
      const th = A.th + (B.th - A.th) * k;
      return {
        p: [dir[0] * (r0 + r), y, dir[2] * (r0 + r)],
        fwd: norm([Math.sin(th) * dir[0], Math.cos(th), Math.sin(th) * dir[2]]),
      };
    };

    // Radius up the culm: a slow taper, and a real bamboo is slightly fatter
    // at the very base where it leaves the ground.
    const radiusAt = (t) => rad * (1 - 0.34 * t) * (1 + 0.16 * Math.exp(-t * 14));

    const stops = nodeStops(internodes, rand);

    // ── The culm ─────────────────────────────────────────────────────────────
    if (far) {
      // FAR: a cross of two tapering strips, not a tube. Below a few pixels a
      // tube is six vertices spent on a line, and a single strip turned
      // edge-on disappears — the same hairline the fern's rachis has to dodge.
      for (const across of [true, false]) {
        const base = vcount();
        const segs = 5;
        for (let q = 0; q <= segs; q++) {
          const t = q / segs;
          const { p, fwd } = at(t);
          const axis = across ? side : norm(cross(fwd, side));
          const n = norm(cross(fwd, axis));
          const w = radiusAt(t);
          for (const s of [-1, 1]) {
            // `along` 1 = "mid-internode": plain culm, no node bands at FAR.
            push(add(p, axis, s * w), n, s * 0.5 + 0.5, t, [CULM, t, cr, 1]);
          }
        }
        for (let q = 0; q < segs; q++) {
          const i0 = base + q * 2;
          I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
        }
      }
    } else {
      /** One ring of the tube. Returns its first vertex index. */
      const ring = (t, radius, alongVal) => {
        const { p, fwd } = at(t);
        const ax2 = norm(cross(fwd, side));
        const base = vcount();
        for (let s = 0; s < sides; s++) {
          const ph = (s / sides) * Math.PI * 2;
          const cs = Math.cos(ph), sn = Math.sin(ph);
          const n = norm([
            side[0] * cs + ax2[0] * sn,
            side[1] * cs + ax2[1] * sn,
            side[2] * cs + ax2[2] * sn,
          ]);
          push(add(p, n, radius), n, s / sides, t, [CULM, t, cr, alongVal]);
        }
        return base;
      };
      // WINDING, and it matters more than it looks. The ring runs
      // counter-clockwise seen from above (side × dir = up), so the obvious
      // order — lower_s, upper_s, lower_s+1 — has normal up × dir = −side,
      // which points INTO the tube. The material is DoubleSide so it still
      // draws, and then `faceDirection` dutifully flips the shading normal
      // away from the viewer on every visible face and the culm renders
      // BLACK, top to bottom, in full sun. Wind the other way.
      const stitch = (b0, b1) => {
        for (let s = 0; s < sides; s++) {
          const s2 = (s + 1) % sides;
          I.push(b0 + s, b0 + s2, b1 + s, b0 + s2, b1 + s2, b1 + s);
        }
      };

      // ── THE NODE ───────────────────────────────────────────────────────────
      //
      // A real node is three things stacked, and the eye wants all three: a
      // thin DARK line (the sheath scar) at the node, the raised RING itself,
      // and a pale WAXY BLOOM a few centimetres above it. The first pass baked
      // one blurry pale ridge into the colour ramp and it read as "smooth tube"
      // at 8 m.
      //
      // So the ring geometry and the ring SHADING are now split:
      //   • geometry gives the ridge — a plain ring just below, the swollen
      //     ring on the node, a plain ring just above (`eps` apart), so the
      //     swell has an edge instead of a 40 cm cone.
      //   • `along` no longer carries colour. It carries the SIGNED DISTANCE
      //     TO THE NEAREST NODE in half-internodes: 0 on the node, +1 in the
      //     middle of the internode above, −1 in the middle of the one below.
      //     The fragment shader turns that into the scar (|along| tiny) and
      //     the bloom (small positive), as crisp as it likes — vertex colour
      //     could never make a 2 cm line on a 40 cm quad.
      //
      // The sign has to flip somewhere, and it flips at the internode's middle:
      // TWO coincident rings there, one tagged +1 (top of the lower node's
      // reach) and one −1 (bottom of the upper node's). The seam is invisible
      // because the shading is symmetric at ±1 — mid-internode is plain culm
      // either way. The up-culm colour ramp (green at the foot, straw at the
      // crown) now reads `t`, which every culm vertex already carries.
      const eps = 0.004;
      let prev = null;
      const join = (b) => { if (prev !== null) stitch(prev, b); prev = b; };
      for (let k = 0; k < stops.length; k++) {
        const t = stops[k];
        const below = k > 0 ? (t - stops[k - 1]) * 0.5 : 1;   // half-internode under this node
        const above = k < stops.length - 1 ? (stops[k + 1] - t) * 0.5 : 1;
        if (near) {
          const a = Math.max(0, t - eps);
          if (k > 0) join(ring(a, radiusAt(a), -eps / below));
          // A fatter ridge than before: 14% was a suggestion, 22% is a node.
          join(ring(t, radiusAt(t) * 1.22, 0));
          const c2 = Math.min(1, t + eps);
          join(ring(c2, radiusAt(c2), eps / above));
        } else {
          join(ring(t, radiusAt(t) * 1.16, 0));
        }
        if (k < stops.length - 1) {
          const mid = t + above;
          join(ring(mid, radiusAt(mid), 1));
          join(ring(mid, radiusAt(mid), -1));
        }

        // SHEATH COLLARS. A young culm keeps the papery leaf-sheath at its
        // lower nodes for a season: a short straw-coloured flare standing off
        // the ring. About a third of the lower nodes, NEAR only, twelve
        // triangles each — and it is the detail that makes a clump look like
        // it is growing rather than installed. Drawn as part 1 (the straw
        // stem colour), which is what a dried sheath is.
        if (near && k > 0 && t < 0.5 && rand() < 0.36) {
          const { p: p0, fwd: f0 } = at(t);
          const top = Math.min(1, t + 0.032);
          const { p: p1, fwd: f1 } = at(top);
          // Tall and narrow, hugging the culm, with a RAGGED rim: a clean wide
          // funnel read as a lampshade. Each rim vertex gets its own flare.
          const r0 = radiusAt(t) * 1.18;
          const ax0 = norm(cross(f0, side)), ax1 = norm(cross(f1, side));
          const base = vcount();
          for (let s = 0; s < sides; s++) {
            const ph = (s / sides) * Math.PI * 2;
            const cs = Math.cos(ph), sn = Math.sin(ph);
            const n0 = norm([side[0] * cs + ax0[0] * sn, side[1] * cs + ax0[1] * sn, side[2] * cs + ax0[2] * sn]);
            const n1 = norm([side[0] * cs + ax1[0] * sn, side[1] * cs + ax1[1] * sn, side[2] * cs + ax1[2] * sn]);
            const r1 = radiusAt(top) * (1.35 + rand() * 0.5);
            const lift = 0.6 + rand() * 0.4;   // torn rim: some sides shorter
            // The flare leans out, so its normal tips up a little.
            const nf = norm([n0[0], n0[1] + 0.35, n0[2]]);
            push(add(p0, n0, r0), nf, s / sides, t, [BRANCH, t, cr, 0.2]);
            const pr = add(p1, n1, r1);
            push([p0[0] + (pr[0] - p0[0]) * lift, p0[1] + (pr[1] - p0[1]) * lift, p0[2] + (pr[2] - p0[2]) * lift],
              nf, s / sides, top, [BRANCH, t, cr, 0.9]);
          }
          for (let s = 0; s < sides; s++) {
            const s2 = (s + 1) % sides;
            const l0 = base + s * 2, l1 = base + s2 * 2;
            I.push(l0, l1, l0 + 1, l1, l1 + 1, l0 + 1);
          }
        }
      }
      // Close the tip so the culm does not end in an open pipe.
      {
        const { p } = at(1);
        const tipI = vcount();
        push(p, [0, 1, 0], 0.5, 1, [CULM, 1, cr, 1]);
        for (let s = 0; s < sides; s++) I.push(prev + s, prev + ((s + 1) % sides), tipI);
      }
    }

    // ── Branches and their leaf sprays ───────────────────────────────────────
    // Only above `bare`. Real culms carry a branch at EVERY node of the upper
    // half — skipping every other one (the first pass) left a crown you could
    // see the sky through, which is the one thing a bamboo crown never is.
    // Alternating sides node to node (distichous) is what the ±PI flip does.
    const step = near ? 1 : 2;
    for (let k = 0; k < stops.length - 1; k++) {
      const t = stops[k];
      if (t < bare || k % step !== 0) continue;
      const s = (t - bare) / Math.max(1e-3, 1 - bare);
      const { p, fwd } = at(t);

      // Branch length peaks in the middle of the leafy zone and falls off at
      // the crown, which is what gives a bamboo its shouldered outline instead
      // of a cone.
      //
      // The factor is in UNITS OF CULM HEIGHT, and it is worth doing the sum
      // out loud, because getting it wrong by 5× is what the first pass did:
      // on a 9 m culm, 0.11 is a 1 m branch. That is a bamboo branch. Twice
      // that and the plant turns into a banana palm.
      const bl = h * 0.11 * (0.45 + 0.75 * Math.sin(Math.PI * Math.min(1, s * 0.85 + 0.12)));
      // ONE branch system per node, not two. Two thin ones read as wires; one
      // that carries twigs reads as a crown.
      const nb = far ? 1 : near ? 1 : 2;
      for (let b = 0; b < nb; b++) {
        const flip = (k % 4 < 2 ? 1 : -1);
        const ba = az + (flip > 0 ? 0 : Math.PI) + (b - (nb - 1) / 2) * 0.9 + (rand() - 0.5) * 0.5;
        const blen = bl * (b === 0 ? 1 : 0.72) * (0.85 + rand() * 0.3);
        addBranch(ctx, {
          origin: p, culmFwd: fwd, az: ba, len: blen,
          tilt: branchAngle, droop, sprayFan,
          // The coarse levels grow their cards to hold the CROWN'S MASS with
          // fewer of them. This is the whole trick of a plant LOD and it is
          // easy to get backwards: dropping count without growing the
          // survivors turned a 120 m grove into wispy grass, because at that
          // range the crown IS the silhouette and the culms are one pixel.
          cardScale: leafScale * (far ? 1.7 : near ? 1 : 1.25),
          plantT: t, rnd: rand,
          near, far,
        });
      }
    }
  }

  // ── Young shoots ───────────────────────────────────────────────────────────
  // The congested, stubby base is half of what a clump looks like. Two blunt
  // cones cost almost nothing and stop the culms looking like poles someone
  // pushed into the dirt.
  if (!far) {
    const shoots = 2;
    for (let s = 0; s < shoots; s++) {
      const az = rand() * Math.PI * 2;
      const dir = [Math.cos(az), 0, Math.sin(az)];
      const side = [-Math.sin(az), 0, Math.cos(az)];
      const sh = height * (0.06 + rand() * 0.07);
      const sr = culmR * (1.5 + rand() * 0.6);
      const base = [dir[0] * clumpR * 0.75, 0, dir[2] * clumpR * 0.75];
      const tiltV = 0.12 + rand() * 0.12;
      const tip = add(add(base, [0, 1, 0], sh), dir, sh * tiltV);
      const faces = 5;
      const ringBase = vcount();
      for (let f = 0; f < faces; f++) {
        const ph = (f / faces) * Math.PI * 2;
        const ax2 = [dir[0], 0, dir[2]];
        const n = norm([
          side[0] * Math.cos(ph) + ax2[0] * Math.sin(ph),
          0.25,
          side[2] * Math.cos(ph) + ax2[2] * Math.sin(ph),
        ]);
        push(add(base, n, sr), n, f / faces, 0, [CULM, 0, 0.5, -0.04]);
      }
      const tipI = vcount();
      push(tip, [0, 1, 0], 0.5, 1, [CULM, 0.1, 0.5, 0.6]);
      for (let f = 0; f < faces; f++) I.push(ringBase + f, ringBase + ((f + 1) % faces), tipI);
    }
  }

  return finish();
}

/**
 * One branch off a culm, plus the twigs and leaf-spray cards it carries.
 *
 * The branch arcs out and then hangs; the twigs ride its outer half, alternate
 * sides, and hang further; each twig carries one spray, as a pair of crossed
 * cards. NEAR draws the branch as a cross of two strips (a single strip
 * edge-on is a hairline); MID draws one strip; FAR draws none at all and keeps
 * only the cards, because at that range the twig was never more than a
 * suggestion holding the leaves in the right place.
 */
function addBranch(ctx, {
  origin, culmFwd, az, len, tilt, droop, sprayFan, cardScale, plantT, rnd, near, far,
}) {
  const { push, vcount, I } = ctx;
  const dir = [Math.cos(az), 0, Math.sin(az)];
  const side = [-Math.sin(az), 0, Math.cos(az)];

  // The branch's own arch: out at `tilt` from the culm, then drooping.
  const segs = near ? 5 : 3;
  const pts = [];
  {
    let r = 0, y = 0;
    const ds = len / segs;
    for (let j = 0; j <= segs; j++) {
      const th = tilt + droop * 1.6 * Math.pow(j / segs, 1.6);
      pts.push({ v: j / segs, p: add(add(origin, dir, r), [0, 1, 0], y), th });
      const thm = tilt + droop * 1.6 * Math.pow((j + 0.5) / segs, 1.6);
      r += Math.sin(thm) * ds;
      y += Math.cos(thm) * ds;
    }
  }
  const fwdAt = (th) => norm([Math.sin(th) * dir[0], Math.cos(th), Math.sin(th) * dir[2]]);

  if (!far) {
    const w = len * 0.012;
    const strips = near ? [true, false] : [true];
    for (const across of strips) {
      const base = vcount();
      for (let j = 0; j <= segs; j++) {
        const { p, v, th } = pts[j];
        const fwd = fwdAt(th);
        const axis = across ? side : norm(cross(fwd, side));
        const n = norm(cross(fwd, axis));
        const ww = w * (1 - v * 0.55);
        for (const s of [-1, 1]) {
          push(add(p, axis, s * ww), n, s * 0.5 + 0.5, plantT, [BRANCH, plantT, 0.5, v]);
        }
      }
      for (let j = 0; j < segs; j++) {
        const i0 = base + j * 2;
        I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
      }
    }
  }

  // ── Twigs, and the sprays they carry ───────────────────────────────────────
  //
  // THE THING THAT MAKES A CROWN. A branch does not end in one fan of leaves;
  // it carries several short twigs down its outer half, and EACH of those
  // carries a spray. One spray per branch gave a plant you could see the sky
  // through — oats, not bamboo. The twig is the level of hierarchy that fills
  // the crown, and it is cheap: the leaves were always the cost, this only
  // moves where they hang.
  // FAR keeps two twigs, not one. A 9 m plant at 120 m is still sixty pixels
  // tall — it is not a speck, and a level cheap enough to be invisible is not
  // a saving, it is a hole in the grove.
  const twigs = near ? 3 : far ? 1 : 2;
  /** Point and heading part-way along the branch. */
  const along = (f) => {
    const jf = Math.min(segs - 1e-4, f * segs);
    const j0 = Math.min(segs - 1, Math.floor(jf)), kk = jf - j0;
    const a0 = pts[j0], a1 = pts[j0 + 1];
    return {
      p: [
        a0.p[0] + (a1.p[0] - a0.p[0]) * kk,
        a0.p[1] + (a1.p[1] - a0.p[1]) * kk,
        a0.p[2] + (a1.p[2] - a0.p[2]) * kk,
      ],
      fwd: fwdAt(a0.th + (a1.th - a0.th) * kk),
    };
  };

  for (let w = 0; w < twigs; w++) {
    const f = twigs === 1 ? 0.7 : 0.38 + (w / (twigs - 1)) * 0.58;
    const { p: root, fwd } = along(f);
    const r0 = rnd();
    const s0 = w % 2 ? 1 : -1;
    // The twig leaves the branch to one side and immediately starts to hang.
    const fan = sprayFan * (0.7 + r0 * 0.9) * s0;
    const tdir = norm(add(
      add([0, 0, 0], fwd, Math.cos(fan)),
      side, Math.sin(fan) * 1.4,
    ));
    const twigDir = norm([tdir[0], tdir[1] - (0.3 + r0 * 0.35), tdir[2]]);
    const twigLen = len * (0.3 + r0 * 0.2);
    const tside = norm(cross(twigDir, [0, 1, 0.001]));

    // The twig itself, a single hairline strip — NEAR only. It is mostly
    // hidden by its own leaves; what it buys is the line joining them to the
    // branch, without which a spray looks like it is floating.
    if (near) {
      const tw = twigLen * 0.008;
      const n = norm(cross(twigDir, tside));
      const base = vcount();
      for (const [t2, ww] of [[0, 1], [1, 0.4]]) {
        const c = add(root, twigDir, twigLen * t2);
        for (const s of [-1, 1]) {
          push(add(c, tside, s * tw * ww), n, s * 0.5 + 0.5, plantT, [BRANCH, plantT, 0.5, t2]);
        }
      }
      I.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }

    // The spray: one card pair, laid along the twig from its root. The fan in
    // the texture opens along the twig; the card itself bends down toward
    // its top, so the spray hangs the way the leaves used to.
    addSprayCard(ctx, {
      root, dir: twigDir, side: tside,
      height: twigLen * 1.45 * cardScale * (0.85 + r0 * 0.3),
      hang: 0.28 + r0 * 0.2,
      plantT, rnd, near,
    });
  }
}

/**
 * A leaf-spray card: two crossed quads (three rows each, so the card can bend
 * down toward its top), textured with bambooSprayTexture.js's alpha.
 *
 * Crossed, for the same reason the fern's rachis is crossed: one card edge-on
 * is invisible, and a spray that vanishes when you walk round it is worse than
 * a spray that is slightly too thick. FAR keeps one card; at that range the
 * second one never shows.
 */
function addSprayCard(ctx, { root, dir, side, height, hang, plantT, rnd, near }) {
  const { push, vcount, I } = ctx;
  const w = height * 0.5;             // the texture is square: full width = height
  const across1 = side;
  const across2 = norm(cross(dir, side));
  const planes = near ? [across1, across2] : [across1];
  const cardRand = rnd();
  for (const across of planes) {
    const n0 = norm(cross(dir, across));
    const n = n0[1] < 0 ? [-n0[0], -n0[1], -n0[2]] : n0;
    const base = vcount();
    for (const v of [0, 0.5, 1]) {
      // Bends down toward the top: the hang of a spray.
      const c = add(add(root, dir, height * v), [0, -1, 0], height * hang * v * v);
      for (const s of [-1, 1]) {
        push(add(c, across, s * w), n, s * 0.5 + 0.5, v, [CARD, plantT, cardRand, v]);
      }
    }
    for (let q = 0; q < 2; q++) {
      const i0 = base + q * 2;
      I.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
  }
}

