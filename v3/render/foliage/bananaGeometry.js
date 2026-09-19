/**
 * BANANA and TARO — big broad leaves as half-card pairs on a stem, the leaf
 * builder shared with the palm (addFrondCards) and a broad-leaf texture
 * (broadleafTextures.js).
 *
 * BANANA (Musa): a fat green PSEUDOSTEM — not wood, rolled leaf sheaths — 2-4 m,
 * with 8-12 paddle leaves 1.5-2.5 m long unrolling from its top in a spiral:
 * the newest a rolled spear standing straight up, the mature ones spreading,
 * the old ones hanging below horizontal, one or two dead and brown. The leaf
 * V-folds slightly along its midrib and the halves hang more toward the tip.
 * What makes it read is the TEARS (in the texture) and the age spread in the
 * crown; a banana with untorn leaves all at one angle is a plastic one.
 *
 * TARO (Colocasia): the same plant shape at knee height with no real stem —
 * thin petioles rising from the ground, each carrying one big heart-shaped
 * leaf that hangs from the petiole's tip. Paddy edges, ditches, anywhere wet.
 *
 * Parts: 3 stem (the culm/trunk path: pseudostem bands from `along`),
 *        5 + lift leaf cards (0.85 — a broad leaf is lit like a canopy; at
 *        0.7 its shade-side half went black, the fern's lesson again).
 *
 * Shared keys: fronds = leaves, frondLength = stem height, leaflets = sheath
 * bands, leafletWidth = leaf width, leafletAngle = fold, spread = how far the
 * old leaves droop, arch, droop, stemWidth, bareStalk = stem lean,
 * plumesPerStem = dead leaves, plumeSpread = leaf length % of stem.
 */
import { addFrondCards } from "./palmGeometry.js";

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const UP = [0, 1, 0];
const STEM = 3;

export function buildBanana(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;
  const taro = type.kind === "taro";

  const height = type.frondLength ?? 1;
  const leaves = Math.max(3, Math.round((type.fronds ?? 10) * (far ? 0.6 : near ? 1 : 0.8)));
  const bands = Math.max(2, Math.round((type.leaflets ?? 6) * (near ? 1 : 0.5)));
  const stemR = (taro ? 0.012 : 0.05) * (type.stemWidth ?? 1);
  const widthScale = type.leafletWidth ?? 1;
  const vFold = ((type.leafletAngle ?? 18) * Math.PI) / 180;
  const crownSpread = type.spread ?? 1;
  const arch = type.arch ?? 0.7;
  const droop = type.droop ?? 0.4;
  const lean = type.bareStalk ?? 0.08;
  const deadN = far ? 0 : Math.round(type.plumesPerStem ?? 2);
  const leafLen = height * ((type.plumeSpread ?? 70) / 100);
  const sides = near ? 7 : 5;

  // ── Stem ──────────────────────────────────────────────────────────────────
  // A banana's pseudostem leans a little and tapers toward the top; a taro's
  // "stem" is only a short crown the petioles rise from.
  const az = rand() * Math.PI * 2;
  const dir = [Math.cos(az), 0, Math.sin(az)];
  const side = [-Math.sin(az), 0, Math.cos(az)];
  const at = (t) => {
    const th = lean * t;
    return {
      p: [dir[0] * Math.sin(th) * height * t * 0.5, height * t, dir[2] * Math.sin(th) * height * t * 0.5],
      fwd: norm([Math.sin(th) * dir[0], Math.cos(th), Math.sin(th) * dir[2]]),
    };
  };
  const radiusAt = (t) => stemR * (1 - (taro ? 0.3 : 0.32) * t) * (1 + 0.3 * Math.exp(-t * 18));

  // A taro has no stem at all — its petioles ARE the bare base of each leaf
  // card. Only the banana gets the pseudostem.
  if (!far && !taro) {
    const ring = (t, radius, alongVal) => {
      const { p, fwd } = at(t);
      const ax2 = norm(cross(fwd, side));
      const base = vcount();
      for (let s = 0; s < sides; s++) {
        const ph = (s / sides) * Math.PI * 2;
        const cs = Math.cos(ph), sn = Math.sin(ph);
        const n = norm([side[0] * cs + ax2[0] * sn, side[1] * cs + ax2[1] * sn, side[2] * cs + ax2[2] * sn]);
        push(add(p, n, radius), n, s / sides, t, [STEM, t, 0.1, alongVal]);
      }
      return base;
    };
    const stitch = (b0, b1) => {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        I.push(b0 + s, b0 + s2, b1 + s, b0 + s2, b1 + s2, b1 + s);
      }
    };
    let prev = null;
    const join = (b) => { if (prev !== null) stitch(prev, b); prev = b; };
    // Sheath bands: faint, from the culm shader's scar/bloom at `along` 0.
    for (let k = 0; k <= bands; k++) {
      const t = k / bands;
      join(ring(t, radiusAt(t), 0));
      if (k < bands) {
        const mid = (k + 0.5) / bands;
        join(ring(mid, radiusAt(mid), 1));
        if (near) join(ring(mid, radiusAt(mid), -1));
      }
    }
    // Close the top.
    const { p } = at(1);
    const tipI = vcount();
    push(add(p, UP, radiusAt(1) * 0.3), UP, 0.5, 1, [STEM, 1, 0.1, 1]);
    for (let s = 0; s < sides; s++) I.push(prev + s, prev + ((s + 1) % sides), tipI);
  } else if (!taro) {
    // FAR: a cross of two strips.
    for (const across of [true, false]) {
      const base = vcount();
      for (let q = 0; q <= 3; q++) {
        const t = q / 3;
        const { p, fwd } = at(t);
        const axis = across ? side : norm(cross(fwd, side));
        const n = norm(cross(fwd, axis));
        for (const s of [-1, 1]) push(add(p, axis, s * radiusAt(t)), n, s * 0.5 + 0.5, t, [STEM, t, 0.1, 1]);
      }
      for (let q = 0; q < 3; q++) {
        const i0 = base + q * 2;
        I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
      }
    }
  }

  // ── Leaves, by age round the top ──────────────────────────────────────────
  const top = at(1);
  const crownO = taro ? [0, height * 0.04, 0] : add(top.p, top.fwd, -height * 0.03);
  const halfW = leafLen * (taro ? 0.42 : 0.2) * widthScale;
  for (let i = 0; i < leaves; i++) {
    const age = leaves > 1 ? i / (leaves - 1) : 0.5;
    const la = i * 2.39996 + rand() * 0.4;
    const fr = rand();
    // Banana: spear upright → spreading → hanging. Taro: every leaf on a
    // petiole that stands fairly upright and leans out, bending over hard at
    // the top so the heart blade hangs off its tip — no spear.
    const tilt = taro
      ? 0.3 + age * 0.55 * crownSpread + (fr - 0.5) * 0.2
      : 0.1 + Math.pow(age, 0.8) * 2.1 * crownSpread + (fr - 0.5) * 0.15;
    addFrondCards(ctx, {
      origin: crownO, az: la,
      len: leafLen * (taro ? 0.8 + fr * 0.35 : 0.6 + 0.4 * Math.min(1, age * 2.5)) * (0.92 + rand() * 0.16),
      tilt, archAmt: arch * (taro ? 2.0 : 0.3 + age * 1.0),
      halfW: halfW * (taro ? 0.85 + fr * 0.3 : 0.7 + 0.3 * Math.min(1, age * 2)),
      vFold, droop, near, far, dead: false, plantT: taro ? 0.9 : 1, rnd: rand, lift: 0.85,
    });
  }
  for (let d = 0; d < deadN; d++) {
    addFrondCards(ctx, {
      origin: add(crownO, UP, -height * 0.02), az: rand() * Math.PI * 2,
      len: leafLen * 0.8, tilt: 2.3 + rand() * 0.4, archAmt: 0.3, halfW: halfW * 0.8,
      vFold: vFold * 1.5, droop: droop * 0.5, near, far, dead: true, plantT: 0.95, rnd: rand, lift: 0.85,
    });
  }
  return finish();
}
