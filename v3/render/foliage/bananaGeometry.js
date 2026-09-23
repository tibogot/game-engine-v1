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

  /**
   * BANANA GROWS IN A CLUMP, and that is most of its silhouette.
   *
   * A mat throws suckers, so what you actually see is a tall bearing stem with
   * two or three younger ones of stepped heights around its foot — the
   * plantation photographs are a wall of them, never single plants. The first
   * version built one stem, which reads as a specimen in a pot.
   *
   * Taro has no stem to clump; it stays one rosette.
   */
  const stemN = taro || far ? 1 : Math.max(1, Math.round(1 + (type.spread ?? 1) * 1.6));
  const clumpAz = rand() * Math.PI * 2;

  for (let stem = 0; stem < stemN; stem++) {
    // The bearing stem is full height; the suckers step down hard.
    const hf = stem === 0 ? 1 : 0.34 + rand() * 0.34;
    const H = height * hf;
    const LL = leafLen * hf;
    const sa = clumpAz + (stem / Math.max(1, stemN)) * Math.PI * 2 + (rand() - 0.5) * 0.9;
    const off = stem === 0 ? [0, 0, 0]
      : [Math.cos(sa) * stemR * (5 + rand() * 4), 0, Math.sin(sa) * stemR * (5 + rand() * 4)];

    const az = rand() * Math.PI * 2;
    const dir = [Math.cos(az), 0, Math.sin(az)];
    const side = [-Math.sin(az), 0, Math.cos(az)];
    const at = (t) => {
      const th = lean * t;
      return {
        p: [off[0] + dir[0] * Math.sin(th) * H * t * 0.5, H * t, off[2] + dir[2] * Math.sin(th) * H * t * 0.5],
        fwd: norm([Math.sin(th) * dir[0], Math.cos(th), Math.sin(th) * dir[2]]),
      };
    };
    const radiusAt = (t) => stemR * hf * (1 - (taro ? 0.3 : 0.32) * t) * (1 + 0.3 * Math.exp(-t * 18));

    // A taro has no stem at all — its petioles ARE the bare base of each leaf
    // card. Only the banana gets the pseudostem.
    if (!far && !taro) {
      const ring = (t, radius, alongVal) => {
        const { p, fwd } = at(t);
        const ax2 = norm(cross(fwd, side));
        const base = vcount();
        for (let sd = 0; sd < sides; sd++) {
          const ph = (sd / sides) * Math.PI * 2;
          const cs = Math.cos(ph), sn = Math.sin(ph);
          const n = norm([side[0] * cs + ax2[0] * sn, side[1] * cs + ax2[1] * sn, side[2] * cs + ax2[2] * sn]);
          push(add(p, n, radius), n, sd / sides, t, [STEM, t, 0.1, alongVal]);
        }
        return base;
      };
      const stitch = (b0, b1) => {
        for (let sd = 0; sd < sides; sd++) {
          const s2 = (sd + 1) % sides;
          I.push(b0 + sd, b0 + s2, b1 + sd, b0 + s2, b1 + s2, b1 + sd);
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
      const { p } = at(1);
      const tipI = vcount();
      push(add(p, UP, radiusAt(1) * 0.3), UP, 0.5, 1, [STEM, 1, 0.1, 1]);
      for (let sd = 0; sd < sides; sd++) I.push(prev + sd, prev + ((sd + 1) % sides), tipI);
    } else if (!taro) {
      // FAR: a cross of two strips.
      for (const across of [true, false]) {
        const base = vcount();
        for (let q = 0; q <= 3; q++) {
          const t = q / 3;
          const { p, fwd } = at(t);
          const axis = across ? side : norm(cross(fwd, side));
          const n = norm(cross(fwd, axis));
          for (const sd of [-1, 1]) push(add(p, axis, sd * radiusAt(t)), n, sd * 0.5 + 0.5, t, [STEM, t, 0.1, 1]);
        }
        for (let q = 0; q < 3; q++) {
          const i0 = base + q * 2;
          I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
        }
      }
    }

    // ── Leaves, by age round the top ────────────────────────────────────────
    const top = at(1);
    const crownO = taro ? [off[0], H * 0.04, off[2]] : add(top.p, top.fwd, -H * 0.03);
    const halfW = LL * (taro ? 0.42 : 0.2) * widthScale;
    const leafN = stem === 0 ? leaves : Math.max(3, Math.round(leaves * 0.6));
    for (let i = 0; i < leafN; i++) {
      const age = leafN > 1 ? i / (leafN - 1) : 0.5;
      const la = i * 2.39996 + rand() * 0.4;
      const fr = rand();
      // Banana: spear upright -> spreading -> hanging. Taro: every leaf on a
      // petiole that stands fairly upright and leans out, bending over hard at
      // the top so the heart blade hangs off its tip — no spear.
      //
      // 1.55, not 2.1, for the oldest: in the plantation photographs the
      // crown is a tall spray REACHING UP and arching over, and very little of
      // it hangs below the stem's top. At 2.1 the old leaves lay flat and the
      // plant read as a rosette on a post.
      const tilt = taro
        ? 0.3 + age * 0.55 * crownSpread + (fr - 0.5) * 0.2
        : 0.08 + Math.pow(age, 0.8) * 1.55 * crownSpread + (fr - 0.5) * 0.15;
      addFrondCards(ctx, {
        origin: crownO, az: la,
        len: LL * (taro ? 0.8 + fr * 0.35 : 0.6 + 0.4 * Math.min(1, age * 2.5)) * (0.92 + rand() * 0.16),
        tilt, archAmt: arch * (taro ? 2.0 : 0.45 + age * 1.15),
        halfW: halfW * (taro ? 0.85 + fr * 0.3 : 0.7 + 0.3 * Math.min(1, age * 2)),
        vFold, droop, near, far, dead: false, plantT: taro ? 0.9 : 1, rnd: rand, lift: 0.85,
      });
    }
    const dN = stem === 0 ? deadN : Math.min(1, deadN);
    for (let d = 0; d < dN; d++) {
      addFrondCards(ctx, {
        origin: add(crownO, UP, -H * 0.02), az: rand() * Math.PI * 2,
        // Short and narrow. A dead banana leaf has collapsed along its midrib
        // and hangs as a dried strip against the stem; at full width the
        // shader's brown reads as a cream SHEET stuck to the plant.
        len: LL * 0.55, tilt: 2.45 + rand() * 0.35, archAmt: 0.25, halfW: halfW * 0.42,
        vFold: vFold * 1.5, droop: droop * 0.5, near, far, dead: true, plantT: 0.95, rnd: rand, lift: 0.85,
      });
    }
  }
  return finish();
}
