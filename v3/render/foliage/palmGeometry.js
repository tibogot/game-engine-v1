/**
 * PALM — a coconut palm: one leaning trunk, a spherical crown of pinnate
 * fronds arranged by AGE, a skirt of dead ones, coconuts. The Vietnamese
 * beach and river palm.
 *
 * ── WHAT MAKES A PALM READ AS A PALM ─────────────────────────────────────────
 *   1. THE V-FOLD. Every frond's two rows of leaflets hang DOWN from the
 *      rachis at an angle, so one side of the frond catches the sun and the
 *      other shades. Flat fronds radiating from a ball are "the spider" — the
 *      way every bad palm goes wrong. Here each frond is TWO half-cards, each
 *      tilted into the V, textured with half a frond (palmFrondTexture.js),
 *      and shaded with a normal that is only HALF lifted toward up (part 5),
 *      so the two halves actually shade differently.
 *   2. AGE ORDER IN THE CROWN. Fronds emerge upright at the centre, lean out
 *      as they mature, hang below horizontal when old, and die hanging
 *      against the trunk, brown. A crown where every frond has the same tilt
 *      reads as a plastic umbrella. The spiral is by golden angle; the tilt,
 *      arch and length run with the frond's age.
 *   3. THE DEAD SKIRT. Two or three brown fronds hanging under the crown.
 *      Nearly free and it does an absurd amount of work: the difference
 *      between "palm asset" and "a palm that has stood there twenty years".
 *   4. THE TRUNK: slender, uniform (a palm barely tapers), leaning then curving
 *      back up, a swollen bole at the foot, and dense pale leaf-scar rings —
 *      drawn by the bamboo culm's scar/bloom shader (part 3) from the same
 *      signed node distance, at a finer pitch.
 *   5. Coconuts, in a cluster just under the crown.
 *
 * ── PARTS ────────────────────────────────────────────────────────────────────
 *   1  stem   coconuts (the straw stem colour reads as a ripening nut)
 *   3  trunk  colorHead, true-ish normal, scar/bloom rings
 *   5  FROND  half-frond card: leaf colour, translucent, alpha from the frond
 *             texture, normal lifted 50% (not the leaves' 95%) for the V
 *
 * A dead frond is flagged by `rand` ≥ 2 on its vertices — the only spare
 * channel — and the shader turns it brown and opaque.
 *
 * Shared keys, re-read for a palm:
 *   fronds        fronds in the crown
 *   frondLength   trunk height, unit frame
 *   leaflets      leaf-scar rings up the trunk
 *   leafletWidth  frond width scale
 *   leafletAngle  the V-fold, degrees below horizontal
 *   spread        how far the old fronds droop
 *   arch          how far a frond bends over
 *   droop         how much more the leaflets hang toward the frond's tip
 *   stemWidth     trunk thickness
 *   bareStalk     trunk lean
 *   plumesPerStem dead fronds in the skirt
 *   plumeSpread   frond length, as % of trunk height
 */

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const UP = [0, 1, 0];

const STEM = 1, TRUNK = 3, FROND = 5;

/** A curve integrated from an angle-from-vertical function. */
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

export function buildPalm(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;

  const height = type.frondLength ?? 1;
  const frondN = Math.max(4, Math.round((type.fronds ?? 22) * (far ? 0.45 : near ? 1 : 0.75)));
  const rings = Math.max(6, Math.round((type.leaflets ?? 30) * (near ? 1 : 0.5)));
  // A coconut trunk is about 30 cm through at 10 m — 1:33, and it barely tapers.
  const trunkR = 0.015 * (type.stemWidth ?? 1);
  const widthScale = type.leafletWidth ?? 1;
  const vFold = ((type.leafletAngle ?? 32) * Math.PI) / 180;
  const crownSpread = type.spread ?? 1;
  const arch = type.arch ?? 0.9;
  const droop = type.droop ?? 0.5;
  const lean = type.bareStalk ?? 0.12;
  const deadN = far ? 0 : Math.round(type.plumesPerStem ?? 3);
  const frondLen = height * ((type.plumeSpread ?? 50) / 100);
  // One trunk per plant, so it can afford 8 sides: 6 showed its facets at 8 m.
  const sides = near ? 8 : 5;

  // ── Trunk ─────────────────────────────────────────────────────────────────
  // Leans out of the ground in one direction and curves back toward vertical
  // as it rises — the coconut palm's reach for the light.
  const az = rand() * Math.PI * 2;
  const dir = [Math.cos(az), 0, Math.sin(az)];
  const side = [-Math.sin(az), 0, Math.cos(az)];
  const samples = 24;
  const line = integrate(samples, height, (v) => lean * Math.max(0.15, 1.5 - 1.3 * v));
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
  // Uniform, with a swollen bole at the foot.
  const radiusAt = (t) => trunkR * (1 - 0.12 * t) * (1 + 0.55 * Math.exp(-t * 22));

  const ring = (t, radius, alongVal) => {
    const { p, fwd } = at(t);
    const ax2 = norm(cross(fwd, side));
    const base = vcount();
    for (let s = 0; s < sides; s++) {
      const ph = (s / sides) * Math.PI * 2;
      const cs = Math.cos(ph), sn = Math.sin(ph);
      const n = norm([side[0] * cs + ax2[0] * sn, side[1] * cs + ax2[1] * sn, side[2] * cs + ax2[2] * sn]);
      // rand 0.15: a trunk barely takes the culm's straw ageing.
      push(add(p, n, radius), n, s / sides, t, [TRUNK, t, 0.15, alongVal]);
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

  let prev = null;
  const join = (b) => { if (prev !== null) stitch(prev, b); prev = b; };
  if (far) {
    for (const across of [true, false]) {
      const base = vcount();
      const segs = 4;
      for (let q = 0; q <= segs; q++) {
        const t = q / segs;
        const { p, fwd } = at(t);
        const axis = across ? side : norm(cross(fwd, side));
        const n = norm(cross(fwd, axis));
        for (const s of [-1, 1]) push(add(p, axis, s * radiusAt(t)), n, s * 0.5 + 0.5, t, [TRUNK, t, 0.15, 1]);
      }
      for (let q = 0; q < segs; q++) {
        const i0 = base + q * 2;
        I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
      }
    }
  } else {
    // Leaf-scar rings: evenly spaced (a palm's are), jittered a little. Each
    // scar is a ring on the scar (`along` 0, a touch raised) and a ring at
    // the mid-point between scars (`along` ±1), so the culm shader's scar
    // line and pale bloom draw a ring band at every scar.
    for (let k = 0; k <= rings; k++) {
      const t = Math.min(1, (k + (k > 0 && k < rings ? (rand() - 0.5) * 0.3 : 0)) / rings);
      join(ring(t, radiusAt(t) * (k === 0 ? 1 : 1.05), 0));
      if (k < rings) {
        const mid = (k + 0.5) / rings;
        join(ring(mid, radiusAt(mid), 1));
        if (near) join(ring(mid, radiusAt(mid), -1));
      }
    }
  }
  const top = at(1);

  // ── Crown ─────────────────────────────────────────────────────────────────
  // The crown's frame: fronds leave from a point just above the trunk's tip.
  const crownO = add(top.p, top.fwd, height * 0.01);
  const halfW = frondLen * 0.2 * widthScale;

  for (let i = 0; i < frondN; i++) {
    const age = frondN > 1 ? i / (frondN - 1) : 0.5;         // 0 young … 1 old
    const fa = i * 2.39996 + rand() * 0.3;
    // Young fronds stand up in the middle; old ones lean out and hang below
    // the horizontal. Their arch and length grow with age too.
    // 0.12 rad for the newest frond (a spear, nearly vertical) to ~2.4 rad
    // (140°, hanging well below horizontal) for the oldest. The first pass
    // stopped at 110° and the crown read as an umbrella: nothing above, nothing
    // hanging, every frond on one plane.
    const tilt = 0.12 + Math.pow(age, 0.75) * 2.3 * crownSpread + (rand() - 0.5) * 0.12;
    const archAmt = arch * (0.3 + age * 1.0);
    const len = frondLen * (0.62 + 0.38 * Math.min(1, age * 2.2)) * (0.92 + rand() * 0.16);
    addFrondCards(ctx, {
      origin: crownO, az: fa, len, tilt, archAmt, halfW: halfW * (0.75 + 0.25 * Math.min(1, age * 2)),
      vFold, droop, near, far, dead: false, plantT: 1, rnd: rand,
    });
  }
  // The dead skirt: hanging, brown, a little shorter. Spread EVENLY round the
  // crown from a random start — three random azimuths landed all on one side
  // once, and with a deterministic seed that is every load, not once.
  const deadStart = rand() * Math.PI * 2;
  for (let d = 0; d < deadN; d++) {
    addFrondCards(ctx, {
      origin: add(crownO, UP, -height * 0.01),
      az: deadStart + (d / deadN) * Math.PI * 2 + (rand() - 0.5) * 0.5,
      len: frondLen * 0.78,
      tilt: 2.45 + rand() * 0.35, archAmt: 0.25, halfW: halfW * 0.8,
      vFold: vFold * 1.4, droop: droop * 0.5, near, far, dead: true, plantT: 0.96, rnd: rand,
    });
  }

  // ── Coconuts ──────────────────────────────────────────────────────────────
  if (!far) {
    const nuts = near ? 6 : 4;
    const r = height * 0.011;
    for (let n = 0; n < nuts; n++) {
      const na = rand() * Math.PI * 2;
      const c = add(add(crownO, UP, -height * 0.022 - rand() * height * 0.01),
        [Math.cos(na), 0, Math.sin(na)], trunkR * 1.6 + rand() * r * 1.5);
      const base = vcount();
      const faces = 5;
      for (let f = 0; f < faces; f++) {
        const ph = (f / faces) * Math.PI * 2;
        const nn = [Math.cos(ph), 0, Math.sin(ph)];
        push(add(c, nn, r), nn, f / faces, 0.96, [STEM, 0.96, 0.5, 0.5]);
      }
      const topI = vcount();
      push(add(c, UP, r), UP, 0.5, 0.96, [STEM, 0.96, 0.5, 0.5]);
      const botI = vcount();
      push(add(c, UP, -r * 1.1), [0, -1, 0], 0.5, 0.96, [STEM, 0.96, 0.5, 0.5]);
      for (let f = 0; f < faces; f++) {
        const f2 = (f + 1) % faces;
        I.push(base + f, base + f2, topI, base + f2, base + f, botI);
      }
    }
  }

  return finish();
}

/**
 * One frond: two half-cards along an arching rachis, each hanging down from
 * it into the V, textured with half a frond. NEAR gives the rachis 7 rows so
 * the arch is smooth; FAR gives it 3 and flattens the V, since at that range
 * the fold is one pixel and the second half only doubles the overdraw.
 *
 * Shared with the card fern (fernCardGeometry.js) — any plant whose leaf is
 * "a rachis with two rows of something" is this, with a different texture.
 * `tByRow` makes `t` (the height/colour channel) follow the row instead of
 * sitting at `plantT`, for plants whose colour runs along the frond.
 */
export function addFrondCards(ctx, {
  origin, az, len, tilt, archAmt, halfW, vFold, droop, near, far, dead, plantT, rnd, tByRow = false,
  lift = 0.5,
}) {
  // The part id CARRIES the normal lift: 5 + lift. A palm frond wants 0.5 so
  // its V-fold shades; a ground fern at 0.5 goes black on its shaded halves
  // and wants ~0.85. The shader reads fract(part) for part > 4.5.
  const part = FROND + Math.min(0.99, Math.max(0, lift));
  const { push, vcount, I } = ctx;
  const rows = near ? 7 : far ? 3 : 4;
  const dir = [Math.cos(az), 0, Math.sin(az)];
  const side = [-Math.sin(az), 0, Math.cos(az)];
  // The rachis: stiff near the crown, drooping toward the tip.
  const line = integrate(rows, len, (v) => tilt + archAmt * Math.pow(v, 1.5));
  const fold = far ? 0 : vFold;
  const frondRand = dead ? 2.3 : rnd();

  for (const s of [-1, 1]) {
    const base = vcount();
    for (let j = 0; j <= rows; j++) {
      const L = line[j];
      const p = [origin[0] + dir[0] * L.r, origin[1] + L.y, origin[2] + dir[2] * L.r];
      const fwd = norm([Math.sin(L.th) * dir[0], Math.cos(L.th), Math.sin(L.th) * dir[2]]);
      // The leaflet plane: out to this side, then hung DOWN by the fold —
      // more so toward the tip (`droop`). Gravity, not the frond's frame.
      const f = fold + droop * 0.6 * L.v;
      const d = norm(add(add([0, 0, 0], side, s * Math.cos(f)), UP, -Math.sin(f)));
      const n0 = norm(cross(fwd, d));
      const n = n0[1] < 0 ? [-n0[0], -n0[1], -n0[2]] : n0;
      // A little narrower at the tip; the texture's outline does the rest.
      const w = halfW * (1 - 0.15 * L.v);
      const tv = tByRow ? L.v : plantT;
      push(p, n, 0, L.v, [part, tv, frondRand, L.v]);
      push(add(p, d, w), n, 1, L.v, [part, tv, frondRand, L.v]);
    }
    for (let j = 0; j < rows; j++) {
      const i0 = base + j * 2;
      I.push(i0, i0 + 1, i0 + 2, i0 + 1, i0 + 3, i0 + 2);
    }
  }
}
