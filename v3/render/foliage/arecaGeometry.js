/**
 * ARECA — the betel palm, *cau*, the one planted down every village lane in
 * Vietnam. A clump of very slender ringed canes with a small feathery crown
 * on each, and nothing else on the trunk at all.
 *
 * It exists beside the coconut palm because it is the OPPOSITE silhouette, and
 * a map with one kind of palm on it reads as a map with one tree on it:
 *
 *                     coconut                areca
 *     trunk           one, thick, leaning    several, thin, upright
 *     slenderness     1:33                   1:75 — a pole
 *     crown           big, hanging, heavy    small, held high, feathery
 *     where           beaches, riverbanks    villages, gardens, lanes
 *
 * ── WHAT MAKES IT READ AS AN ARECA ───────────────────────────────────────────
 *   1. THE CANE IS A POLE. Straight, barely tapering, and thin enough that at
 *      any distance it is the RINGS and not the trunk that you see. Lean it or
 *      thicken it and it turns back into a coconut palm.
 *   2. THE RINGS ARE CLOSE. A betel palm carries its old leaf scars at every
 *      20-odd centimetres, up the whole cane. They are drawn by the bamboo
 *      culm's scar/bloom shader (part 3) from signed node distance, which is
 *      the same machinery the coconut's scars use, at a finer pitch.
 *   3. THE CROWNSHAFT. A smooth bright-GREEN sleeve where the fronds wrap the
 *      cane, a metre or so below the crown. It is the single feature that
 *      separates an areca from a stick with leaves on, and it is nearly free:
 *      the sleeve takes part 1, the stalk colour, so it reads green against
 *      the grey cane.
 *   4. A CLUMP, NOT A TREE. Canes of different ages from one root — one tall,
 *      the rest stepping down. `plumesPerStem` is the cane count.
 *   5. THE NUTS. A cluster of orange betel nuts under the crownshaft, on the
 *      tallest cane only. Half a dozen five-sided lumps, and they are what a
 *      player actually recognises.
 *
 * ── SHARED KEYS, RE-READ ─────────────────────────────────────────────────────
 *   fronds        fronds in each crown
 *   frondLength   cane height, unit frame
 *   leaflets      leaf-scar rings up a cane
 *   leafletWidth  frond width
 *   leafletAngle  the V-fold, degrees
 *   spread        how far the clump splays from the root
 *   arch          how far a frond bends over
 *   droop         how much the leaflets hang toward the tip
 *   stemWidth     cane thickness
 *   bareStalk     the crownshaft, as a share of cane height
 *   plumesPerStem canes in the clump
 *   plumeSpread   frond length, as % of cane height
 *   `size` 12 m for the tallest cane.
 */
import { addFrondCards } from "./palmGeometry.js";

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const UP = [0, 1, 0];

const STEM = 1, CANE = 3;
/**
 * A nut is part 0 — a LEAF — flagged dead. The shader only honours the dead
 * flag (`rand` >= 1.5) on leaf parts, where it swaps in a brown-orange; on a
 * stem it is ignored, and the first pass drew the betel nuts as dark green
 * lumps because of it. The palm's coconuts are stems on purpose (straw reads
 * as a ripening coconut); a betel nut is orange, and this is the only orange
 * the material has.
 */
const NUT = 0, DEAD = 2.4;

export function buildAreca(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;

  const H = type.frondLength ?? 1;
  const caneN = far ? 1 : Math.max(1, Math.round(type.plumesPerStem ?? 4));
  const frondN = Math.max(3, Math.round((type.fronds ?? 8) * (far ? 0.5 : near ? 1 : 0.75)));
  const ringsFull = Math.max(5, Math.round((type.leaflets ?? 20) * (near ? 1 : 0.45)));
  // 1:75. A betel palm is 12 m tall and 12 cm through — the most slender
  // trunk on the map by a factor of two, and that IS the plant.
  const caneR = 0.0066 * H * (type.stemWidth ?? 1);
  const widthScale = type.leafletWidth ?? 1;
  const vFold = ((type.leafletAngle ?? 26) * Math.PI) / 180;
  const splay = type.spread ?? 1;
  const arch = type.arch ?? 1.15;
  const droop = type.droop ?? 0.45;
  const shaft = type.bareStalk ?? 0.1;
  const frondLen = H * ((type.plumeSpread ?? 17) / 100);
  const sides = near ? 6 : 5;

  // The clump: the tallest cane at the root, the rest stepping down in age and
  // leaning out a little further the shorter they are — young canes grow away
  // from the shade of the old one.
  const clumpAz = rand() * Math.PI * 2;

  for (let c = 0; c < caneN; c++) {
    const age = caneN === 1 ? 1 : 1 - (c / caneN) * 0.62 - rand() * 0.08;
    const CH = H * age;
    const az = clumpAz + (c / Math.max(1, caneN)) * Math.PI * 2 + (rand() - 0.5) * 0.7;
    const outDir = [Math.cos(az), 0, Math.sin(az)];
    const side = [-Math.sin(az), 0, Math.cos(az)];
    // Root offset, and a lean that grows with how far out the cane stands.
    // A short cane carries proportionally fewer scars, and the rings are most
    // of this plant's triangles — 4 canes at full ring count came to 6,900,
    // three times the coconut palm's.
    const rings = Math.max(5, Math.round(ringsFull * (0.55 + 0.45 * age)));
    const rootR = c === 0 ? 0 : caneR * (3 + (c - 1) * 2.2) * splay;
    const root = [outDir[0] * rootR, 0, outDir[2] * rootR];
    const tilt = c === 0 ? 0.015 : (0.05 + rand() * 0.06) * splay;

    // A cane is straight: one lean angle, no curve. This is the whole point of
    // the plant and it is the first thing to get wrong.
    const at = (t) => {
      const r = Math.sin(tilt) * CH * t;
      return {
        p: [root[0] + outDir[0] * r, Math.cos(tilt) * CH * t, root[2] + outDir[2] * r],
        fwd: norm([Math.sin(tilt) * outDir[0], Math.cos(tilt), Math.sin(tilt) * outDir[2]]),
      };
    };
    // Barely tapers, with the slightest swell at the foot.
    const radiusAt = (t) => caneR * age * (1 - 0.16 * t) * (1 + 0.5 * Math.exp(-t * 26));

    const ring = (t, radius, alongVal, part) => {
      const { p, fwd } = at(t);
      const ax2 = norm(cross(fwd, side));
      const base = vcount();
      for (let s = 0; s < sides; s++) {
        const ph = (s / sides) * Math.PI * 2;
        const cs = Math.cos(ph), sn = Math.sin(ph);
        const n = norm([side[0] * cs + ax2[0] * sn, side[1] * cs + ax2[1] * sn, side[2] * cs + ax2[2] * sn]);
        push(add(p, n, radius), n, s / sides, t, [part, t, 0.1, alongVal]);
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

    const shaftTop = 1;
    const shaftBase = 1 - shaft;

    if (far) {
      // Two crossed quads: at this range a cane is a pixel wide and all that
      // matters is that something vertical holds the crown up.
      for (const across of [true, false]) {
        const base = vcount();
        const segs = 2;
        for (let q = 0; q <= segs; q++) {
          const t = q / segs;
          const { p, fwd } = at(t);
          const axis = across ? side : norm(cross(fwd, side));
          const n = norm(cross(fwd, axis));
          for (const s of [-1, 1]) push(add(p, axis, s * radiusAt(t) * 1.6), n, s * 0.5 + 0.5, t, [CANE, t, 0.1, 1]);
        }
        for (let q = 0; q < segs; q++) {
          const i0 = base + q * 2;
          I.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
        }
      }
    } else {
      // The ringed cane, up to the crownshaft. A ring ON the scar (`along` 0)
      // and one BETWEEN scars (±1) lets the culm shader draw its dark scar
      // line and pale band at every one.
      let prev = null;
      const join = (b) => { if (prev !== null) stitch(prev, b); prev = b; };
      for (let k = 0; k <= rings; k++) {
        const t = (k / rings) * shaftBase;
        join(ring(t, radiusAt(t) * (k === 0 ? 1 : 1.04), 0, CANE));
        if (k < rings) {
          const mid = ((k + 0.5) / rings) * shaftBase;
          join(ring(mid, radiusAt(mid), 1, CANE));
          if (near) join(ring(mid, radiusAt(mid), -1, CANE));
        }
      }
      // The crownshaft: the same tube carried on as part 1 (the stalk colour),
      // slightly fatter, smooth. Green against the grey cane.
      prev = null;
      const steps = near ? 4 : 2;
      for (let k = 0; k <= steps; k++) {
        const t = shaftBase + (shaftTop - shaftBase) * (k / steps);
        join(ring(t, radiusAt(t) * (1.18 - 0.22 * (k / steps)), 0.5, STEM));
      }
    }

    // ── The crown ───────────────────────────────────────────────────────────
    const top = at(1);
    const crownO = add(top.p, top.fwd, CH * 0.004);
    const halfW = frondLen * age * 0.19 * widthScale;

    for (let i = 0; i < frondN; i++) {
      const a = frondN > 1 ? i / (frondN - 1) : 0.5;          // 0 young … 1 old
      const fa = i * 2.39996 + rand() * 0.35;
      // A small crown: the newest frond stands almost straight up, the oldest
      // reaches out to about the horizontal and no further. An areca does not
      // carry the heavy hanging skirt a coconut does — its fronds are light,
      // and dropping them below the horizontal is what made the first pass
      // read as a small coconut palm.
      const angle = 0.2 + Math.pow(a, 0.85) * 1.45 + (rand() - 0.5) * 0.14;
      addFrondCards(ctx, {
        origin: crownO,
        az: fa,
        len: frondLen * age * (0.78 + 0.22 * Math.min(1, a * 2)) * (0.93 + rand() * 0.14),
        tilt: angle,
        // Strongly arched: the frond leaves the crown stiff and the last third
        // falls away, which is what makes it read as feathery rather than as a
        // spoke.
        archAmt: arch * (0.55 + a * 0.75),
        halfW: halfW * (0.8 + 0.2 * Math.min(1, a * 2)),
        vFold, droop, near, far, dead: false, plantT: 1, rnd: rand,
      });
    }

    // ── Betel nuts ──────────────────────────────────────────────────────────
    // On the tallest cane only, tucked under the crownshaft. Cheap, and they
    // are what a player actually recognises the plant by.
    if (near && c === 0) {
      const nuts = 7;
      const r = CH * 0.0075;
      const hang = add(at(shaftBase).p, UP, -CH * 0.01);
      for (let n = 0; n < nuts; n++) {
        const na = rand() * Math.PI * 2;
        const cpt = add(add(hang, [Math.cos(na), 0, Math.sin(na)], caneR * 1.4 + rand() * r * 2),
          UP, -rand() * CH * 0.018);
        const base = vcount();
        const faces = 5;
        for (let f = 0; f < faces; f++) {
          const ph = (f / faces) * Math.PI * 2;
          const nn = [Math.cos(ph), 0, Math.sin(ph)];
          // `rand` ≥ 2 is the shader's "dead/brown" flag — the same channel the
          // palm's dead fronds use, and a ripe betel nut is exactly that orange.
          push(add(cpt, nn, r), nn, f / faces, 0.97, [NUT, 0.97, DEAD, 0.5]);
        }
        const topI = vcount();
        push(add(cpt, UP, r), UP, 0.5, 0.97, [NUT, 0.97, DEAD, 0.5]);
        const botI = vcount();
        push(add(cpt, UP, -r * 1.15), [0, -1, 0], 0.5, 0.97, [NUT, 0.97, DEAD, 0.5]);
        for (let f = 0; f < faces; f++) {
          const f2 = (f + 1) % faces;
          I.push(base + f, base + f2, topI, base + f2, base + f, botI);
        }
      }
    }
  }

  return finish();
}
