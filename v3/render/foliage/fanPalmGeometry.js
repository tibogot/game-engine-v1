/**
 * FAN PALM — the palmate palms: the *cọ* of the northern palm hills and the
 * *thốt nốt*, the Mekong sugar palm that stands over every Cambodian-border
 * paddy and every Apocalypse Now horizon.
 *
 * It is here because the coconut and the betel palm are the SAME PLANT at
 * different proportions — both pinnate, both a plume of feather fronds — and a
 * map whose palms all share a silhouette reads as a map with one palm on it.
 * A fan palm is built differently at every level:
 *
 *                     coconut / areca            fan palm
 *     leaf            a feather, leaflets        a pleated DISC, split into
 *                     down a long rachis         radiating segments
 *     crown           a plume, fronds hanging    a dense BALL of stiff stars
 *     dead leaves     a few brown fronds         a full SKIRT round the trunk
 *     trunk           smooth, ringed, leaning    stout, straight, rough
 *
 * ── WHAT MAKES IT READ ───────────────────────────────────────────────────────
 *   1. THE LEAF IS A STAR ON A STICK. A long bare petiole with a rigid fan on
 *      the end (fanLeafTexture.js). The bare length is most of the leaf and it
 *      is what holds the crown out into a ball instead of a tuft.
 *   2. THE CROWN IS A BALL, NOT A PLUME. Fans point in every direction
 *      including straight up and straight out; nothing hangs the way a coconut
 *      frond hangs. Sorted by age like the coconut's, but the oldest live leaf
 *      only reaches the horizontal.
 *   3. THE SKIRT. Dead fans hang against the trunk in a dense collar under the
 *      crown, brown and closed. On a Livistona it can be metres deep. It is
 *      the cheapest thing on this plant and it does more for the silhouette
 *      than the crown does.
 *   4. A STOUT STRAIGHT TRUNK — 1:20, against a coconut's 1:33 and a betel
 *      palm's 1:75, and no lean to speak of. The sugar palm's trunk is nearly
 *      a column.
 *
 * ── PARTS ────────────────────────────────────────────────────────────────────
 *   1  petiole   the leaf stalk (stem colour)
 *   3  trunk     colorHead, the culm path, with the BOOTS lattice (`along` 2)
 *   5  FAN       the leaf blade: one card, alpha from the fan texture, normal
 *                lifted 50% so a fan seen edge-on shades apart from one facing
 *                the sun. `rand` >= 2 flags the skirt's dead leaves brown.
 *
 * ── SHARED KEYS, RE-READ ─────────────────────────────────────────────────────
 *   fronds        live leaves in the crown
 *   frondLength   trunk height, unit frame
 *   leaflets      rings up the trunk (its barrel curve; the boots are shaded)
 *   leafletWidth  fan size
 *   leafletAngle  how far a fan cups out of its own plane, degrees
 *   spread        how far the crown opens (0 = a closed shuttlecock)
 *   arch          how far the petiole bends over along its length
 *   droop         how far the oldest leaves fall below the horizontal
 *   stemWidth     trunk thickness
 *   bareStalk     the petiole, as a share of the whole leaf
 *   plumesPerStem dead leaves in the skirt
 *   plumeSpread   leaf length, as % of trunk height
 *   `size` 16 m.
 */

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const UP = [0, 1, 0];

const STEM = 1, TRUNK = 3;
/**
 * Part 5 + the normal LIFT in its fraction (foliageSystem's normalNode).
 *
 * 0.8, not the palm's 0.5. A coconut frond is a folded V and wants its two
 * halves to shade apart, so it keeps most of its true normal. A fan is a flat
 * stiff disc pointing every which way round the crown, and at 0.5 the ones
 * facing away from the sun went black — the same failure the whole map was
 * cleaned of last week, reintroduced one plant at a time.
 */
const FAN = 5.8;
const DEAD = 2.3;

export function buildFanPalm(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;

  const H = type.frondLength ?? 1;
  const leafN = Math.max(6, Math.round((type.fronds ?? 22) * (far ? 0.42 : near ? 1 : 0.72)));
  const rings = Math.max(4, Math.round((type.leaflets ?? 16) * (near ? 1 : 0.5)));
  // 1:20 — a column. The sugar palm is the stoutest trunk on the map.
  const trunkR = 0.025 * H * (type.stemWidth ?? 1);
  const fanScale = type.leafletWidth ?? 1;
  const cup = ((type.leafletAngle ?? 26) * Math.PI) / 180;
  const openness = type.spread ?? 1;
  const arch = type.arch ?? 0.55;
  const droop = type.droop ?? 0.4;
  const bare = type.bareStalk ?? 0.45;
  const skirtN = far ? 0 : Math.round(type.plumesPerStem ?? 9);
  const leafLen = H * ((type.plumeSpread ?? 26) / 100);
  const sides = near ? 8 : 5;

  // ── Trunk ─────────────────────────────────────────────────────────────────
  // Straight. A fan palm does not lean; the trunk carries a heavy crown
  // straight up and anything else reads as a coconut.
  const az = rand() * Math.PI * 2;
  const side = [-Math.sin(az), 0, Math.cos(az)];
  const dir = [Math.cos(az), 0, Math.sin(az)];
  const tilt = 0.02 + rand() * 0.025;
  const at = (t) => {
    const r = Math.sin(tilt) * H * t;
    return {
      p: [dir[0] * r, Math.cos(tilt) * H * t, dir[2] * r],
      fwd: norm([Math.sin(tilt) * dir[0], Math.cos(tilt), Math.sin(tilt) * dir[2]]),
    };
  };
  // A sugar palm's trunk swells in the middle and narrows again at the crown —
  // a subtle barrel, and one of the things that separates it from a post.
  const radiusAt = (t) => trunkR * (1 + 0.16 * Math.sin(t * Math.PI) - 0.2 * t) * (1 + 0.6 * Math.exp(-t * 16));
  // Low: the culm shader ages a trunk toward straw with `rand`, and a sugar
  // palm is grey-brown, not red.
  const barkTone = 0.05 + rand() * 0.22;

  // THE BOOTS (your photograph of the sugar-palm stand): the old leaf bases
  // stay on the trunk, split, and stack into a criss-cross lattice. The
  // lattice is the culm shader's, switched on by `along` 2 (outside the ±1
  // the rings use); here the geometry gives each ring a SEAM vertex so the
  // lattice closes round the trunk, and a jagged radius so the broken ends of
  // the boots break the outline — a booted trunk is never a clean cylinder.
  const BOOTS = 2;
  const tubeSides = far ? 4 : sides;
  const jag = far ? 0 : near ? 0.2 : 0.14;
  const ring = (t, radius, alongVal) => {
    const { p, fwd } = at(t);
    const ax2 = norm(cross(fwd, side));
    const base = vcount();
    // Jagged per vertex, but the seam vertex repeats the first so it closes.
    // Its own hash, NOT `rand`: drawing from the plant's sequence here would
    // reshuffle every leaf of the crown that was tuned after it.
    const jr = Array.from({ length: tubeSides }, (_, s) => {
      const h = Math.sin(s * 12.9898 + t * 78.233 + barkTone * 311.7) * 43758.5453;
      return 1 + jag * (h - Math.floor(h) - 0.35);
    });
    for (let s = 0; s <= tubeSides; s++) {
      const ph = (s / tubeSides) * Math.PI * 2;
      const cs = Math.cos(ph), sn = Math.sin(ph);
      const n = norm([side[0] * cs + ax2[0] * sn, side[1] * cs + ax2[1] * sn, side[2] * cs + ax2[2] * sn]);
      push(add(p, n, radius * jr[s % tubeSides]), n, s / tubeSides, t, [TRUNK, t, barkTone, alongVal]);
    }
    return base;
  };
  // Outward winding — see ref: an inside-out tube renders black.
  const stitch = (b0, b1) => {
    for (let s = 0; s < tubeSides; s++) {
      I.push(b0 + s, b0 + s + 1, b1 + s, b0 + s + 1, b1 + s + 1, b1 + s);
    }
  };
  let prev = null;
  const join = (b) => { if (prev !== null) stitch(prev, b); prev = b; };

  if (far) {
    // A closed 4-sided tube, not a crossed pair of quads. The crossed pair had
    // to be part 2 (part 3 flips its normal on a double-sided quad's back face
    // and went BLACK), and part 2 is alpha-tested against the card texture —
    // the traveller's palm lost its far trunk that way entirely. A closed tube
    // shows no back face, so it stays part 3 and gets the boots' average
    // colour. Fatter than the real radius: four sides lose a third of it.
    for (const t of [0, 0.5, 1]) join(ring(t, radiusAt(t) * 1.45, BOOTS));
  } else {
    // Rings only for the barrel's curve now; the boots carry the surface.
    for (let k = 0; k <= rings; k++) {
      const t = k / rings;
      join(ring(t, radiusAt(t), BOOTS));
      if (near && k < rings) join(ring((k + 0.5) / rings, radiusAt((k + 0.5) / rings), BOOTS));
    }
  }

  const top = at(1);

  /**
   * ONE LEAF: a bare petiole, then the fan.
   *
   * The fan is TWO cards meeting along the petiole's line and folded toward
   * each other by `cup`, so the leaf is a shallow dish rather than a sheet of
   * paper — a real fan leaf is pleated and never flat, and a single quad
   * catches the light as a mirror the moment the sun crosses it. The texture
   * is drawn as a whole leaf, so each card takes half of it: u 0-0.5 and
   * 0.5-1.
   */
  const leaf = (origin, azm, lift, len, size, dead, rnd) => {
    const d = [Math.cos(azm), 0, Math.sin(azm)];
    const sd = [-Math.sin(azm), 0, Math.cos(azm)];
    // The petiole's direction, and where the blade starts.
    const stalkLen = len * bare;
    const outAt = (f) => {
      // Straight out of the crown, bending over along its length.
      const a = lift - arch * f * f;
      return { c: Math.cos(a), s: Math.sin(a) };
    };
    const e0 = outAt(0), e1 = outAt(1);
    const hinge = add(add(origin, d, e0.c * stalkLen), UP, e0.s * stalkLen);
    const blade = norm([d[0] * e1.c, e1.s, d[2] * e1.c]);

    // The petiole: a flat strip, two triangles, wide enough to see at play
    // distance and no wider. It is in shade under the fan for most of its
    // length, so nothing is gained by making it a tube.
    if (!far) {
      const w = size * 0.016;
      const b0 = vcount();
      for (const f of [0, 1]) {
        const e = outAt(f);
        const p = add(add(origin, d, e.c * stalkLen * f), UP, e.s * stalkLen * f);
        for (const s of [-1, 1]) push(add(p, sd, s * w), UP, s * 0.5 + 0.5, 0.9, [STEM, 0.9, rnd, f]);
      }
      I.push(b0, b0 + 1, b0 + 2, b0 + 1, b0 + 3, b0 + 2);
    }

    // The blade. `across` is the fan's width axis; the two halves fold toward
    // each other about the blade's own direction.
    const acrossAxis = norm(cross(blade, UP));
    for (const half of [-1, 1]) {
      const ct = Math.cos(cup), st = Math.sin(cup);
      // Fold this half up out of the leaf's plane.
      const upAxis = norm(cross(acrossAxis, blade));
      const across = norm(add(add([0, 0, 0], acrossAxis, half * ct), upAxis, st));
      const n0 = norm(cross(blade, across));
      const n = n0[1] < 0 ? [-n0[0], -n0[1], -n0[2]] : n0;
      const base = vcount();
      // A DISC, centred on the blade — not a half-disc hanging off the
      // petiole. The leaf reaches `size` in every direction from its own
      // centre, which sits about a radius out along the blade, so the card is
      // SQUARE and the texture's circular leaf maps onto it one to one.
      // Getting this wrong (a 2:1 card, the hub at the bottom edge) is what
      // made the crown a pinwheel of slabs.
      const mid = add(hinge, blade, size * 0.86);
      const upAx = norm(cross(across, blade));
      for (const vv of [0, 1]) {
        for (const uu of [0, 1]) {
          const p = add(add(mid, blade, (vv * 2 - 1) * size * 0.9),
            across, uu * size);
          push(p, n, 0.5 + half * uu * 0.5, vv, [FAN, 0.94, dead ? DEAD : rnd, vv]);
        }
      }
      I.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  };

  // ── The crown: a ball ─────────────────────────────────────────────────────
  const crownO = add(top.p, top.fwd, H * 0.006);
  for (let i = 0; i < leafN; i++) {
    const age = leafN > 1 ? i / (leafN - 1) : 0.5;      // 0 youngest … 1 oldest
    const a = i * 2.39996 + rand() * 0.4;
    // Straight up in the middle of the crown, out to the horizontal at the
    // oldest — and, unlike the coconut, NOT below it. A fan palm's live leaves
    // are stiff; the ones that fall are dead, and they go in the skirt.
    // Up through out to BELOW the horizontal for the oldest. In the
    // photographs the lowest live leaves hang well under level; a crown that
    // stops at the horizontal reads as a shuttlecock.
    const lift = 1.5 - Math.pow(age, 0.85) * (1.5 + 0.75 * droop) * openness + (rand() - 0.5) * 0.18;
    // The coarse levels GROW their surviving leaves as they drop their count
    // — the bamboo lesson. Without it a distant grove thins into wisps.
    const lodGrow = far ? 1.5 : near ? 1 : 1.18;
    leaf(crownO, a, lift, leafLen * (0.82 + 0.18 * Math.min(1, age * 2)),
      leafLen * 0.62 * fanScale * lodGrow * (0.85 + rand() * 0.3), false, rand());
  }

  // ── The skirt ─────────────────────────────────────────────────────────────
  // Dead leaves hanging closed against the trunk. Cheap, and it is most of
  // what makes the plant recognisable from far away.
  const skirtStart = rand() * Math.PI * 2;
  for (let i = 0; i < skirtN; i++) {
    const a = skirtStart + (i / skirtN) * Math.PI * 2 + (rand() - 0.5) * 0.4;
    leaf(add(crownO, UP, -H * 0.012 - rand() * H * 0.02), a,
      -1.05 - rand() * 0.45,                       // hanging, well below level
      leafLen * (0.6 + rand() * 0.22),
      leafLen * 0.46 * fanScale, true, rand());
  }

  return finish();
}
