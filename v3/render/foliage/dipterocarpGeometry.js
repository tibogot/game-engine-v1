/**
 * DIPTEROCARP — *dầu*, *sao*, *chò*: the lowland rainforest tree whose crowns
 * ARE the Vietnamese jungle canopy seen from the air. Built for nam-rts's
 * "frame the fight" jungle (2026-09-24): the map had palms, bamboo and ferns
 * and no canopy at all.
 *
 * WHAT MAKES ONE, in the order they read from an RTS camera:
 *
 *   1. THE CROWN IS AN UMBRELLA OF CAULIFLOWERS. Not one dome (that is the
 *      banyan) but a few big rounded SUB-CROWNS — broccoli heads — held out
 *      on thick limbs at the top of the tree, together far wider than they
 *      are deep, flat-topped, with gaps of shade between them. From above a
 *      canopy is a field of these lumps, each lit on its sun side and dark in
 *      the cracks: that texture, not any one tree, is "jungle" at 150 m.
 *   2. THE BOLE. Straight, pale grey and CLEAN — no branches for the first
 *      half or more of the height — rising out of the understorey like a
 *      column. It is what you see under the canopy edge.
 *   3. BUTTRESSES. Thin plank roots flaring out round the foot.
 *
 * The crown reuses the banyan's machinery (banyanGeometry.js): leaf-spray
 * cards FIXED in the world (one on each head's surface, two tilted off it),
 * every vertex carrying the ROUNDED normal of ITS OWN sub-crown, so every
 * cauliflower shades as a ball. `billboard: true` = the old camera-facing
 * cards.
 *
 * ── PARTS ────────────────────────────────────────────────────────────────────
 *   3     bole, buttresses, limbs — the culm path with no rings
 *   4     fixed leaf cards (the "leafSpray" card; 6.35 = billboards if asked)
 *
 * ── SHARED KEYS, RE-READ ─────────────────────────────────────────────────────
 *   fronds        sub-crowns round the top (one more sits in the middle)
 *   frondLength   plant height, unit frame
 *   leaflets      leaf clumps across the whole crown
 *   leafletWidth  clump size
 *   spread        crown radius, in plant heights
 *   arch          how high the sub-crowns ride: 0 a flat umbrella, 1 a dome
 *   stemWidth     bole thickness
 *   bareStalk     height of the fork (the clean bole), in plant heights
 *   plumesPerStem buttress roots
 *   `size` 30 m (an emergent over a 20-25 m canopy).
 */
import { woodKit, BILLBOARD } from "./banyanGeometry.js";

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// A fixed leaf card, 5 + its normal lift (0.35, the billboards' own): part
// 4 would lift the rounded normal 55% to up and flatten the ball back out.
const CARD = 5.35;
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function buildDipterocarp(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;
  const { tube, bez } = woodKit(ctx);

  const H = type.frondLength ?? 1;
  const Rc = H * (type.spread ?? 0.36);                   // whole crown's radius
  const forkY = H * (type.bareStalk ?? 0.56);             // top of the clean bole
  const boleR = 0.02 * H * (type.stemWidth ?? 1);
  const arch = type.arch ?? 0.35;
  const subN = Math.max(3, Math.round(type.fronds ?? 5));
  const clumpTotal = Math.max(20, Math.round((type.leaflets ?? 70) * (far ? 0.45 : near ? 1 : 0.7)));
  const cardsPer = far ? 1 : 2;
  // Camera-facing cards only when the type asks (`billboard: true`).
  const billboard = type.billboard === true;
  const tiltOff = ((type.leafletAngle ?? 30) * Math.PI) / 180;
  const sides = far ? 5 : near ? 9 : 7;

  // ── 2. THE BOLE: straight, a slight lean, tapering to the fork ────────────
  const lean = [(rand() - 0.5) * 0.03 * H, 0, (rand() - 0.5) * 0.03 * H];
  const boleSteps = far ? 3 : 6;
  const bole = [], boleRadii = [];
  for (let k = 0; k <= boleSteps; k++) {
    const s = k / boleSteps;
    bole.push([lean[0] * s, s * forkY - (k === 0 ? 0.004 * H : 0), lean[2] * s]);
    // A flare at the foot, where the buttresses leave it.
    boleRadii.push(boleR * (1 - 0.3 * s) * (1 + 0.5 * Math.exp(-s * 14)));
  }
  tube(bole, boleRadii, sides, { t0: 0, t1: 0.55, tone: 0.03 });
  const fork = bole[bole.length - 1];

  // ── 3. BUTTRESSES: thin plank roots flaring round the foot ────────────────
  // Each is a run of tubes stacked up its height, so it reads as a plank and
  // not as a round root: a tall thin wedge from high on the bole to a foot
  // well out on the ground.
  if (!far) {
    const bN = Math.max(3, Math.round(type.plumesPerStem ?? 5));
    for (let b = 0; b < bN; b++) {
      const a = (b / bN) * Math.PI * 2 + (rand() - 0.5) * 0.5;
      const reach = boleR * (3 + rand() * 2.2);
      const top = 0.05 * H * (0.8 + rand() * 0.5);
      const layers = near ? 3 : 2;
      for (let l = 0; l < layers; l++) {
        const f = l / layers;                             // 0 at the ground
        const y0 = top * (0.12 + 0.8 * f);
        const out = [Math.cos(a) * reach * (1 - f * 0.55), -0.004 * H, Math.sin(a) * reach * (1 - f * 0.55)];
        const inner = [Math.cos(a) * boleR * 0.8, y0, Math.sin(a) * boleR * 0.8];
        const mid = [Math.cos(a) * reach * 0.45, y0 * 0.35, Math.sin(a) * reach * 0.45];
        const pts = bez(inner, mid, out, near ? 4 : 3);
        tube(pts, pts.map((_, k) => boleR * 0.22 * (1 - 0.6 * (k / (pts.length - 1)))), 3, { t0: 0.02, t1: 0, tone: 0.05 });
      }
    }
  }

  // ── 1. THE CROWN: sub-crowns on limbs ─────────────────────────────────────
  // Sub-crown centres: one over the fork, the rest round it on a ring,
  // riding higher toward the middle when `arch` is up (a dome) and level when
  // it is down (an umbrella).
  const heads = [];
  const topY = H * 0.86;
  heads.push({ c: [fork[0], topY + arch * 0.04 * H, fork[2]], r: Rc * 0.46 });
  for (let i = 0; i < subN; i++) {
    const a = (i / subN) * Math.PI * 2 + (rand() - 0.5) * 0.7;
    const ring = Rc * (0.5 + rand() * 0.22);
    const y = topY - (0.04 + (1 - arch) * 0.02 + rand() * 0.05) * H;
    heads.push({ c: [fork[0] + Math.cos(a) * ring, y, fork[2] + Math.sin(a) * ring], r: Rc * (0.4 + rand() * 0.14), a });
  }

  // LIMBS: thick, rising steeply out of the fork, then leaning out to their
  // head — a dipterocarp's crown is held UP on a few big arms.
  for (const h of heads) {
    const end = [h.c[0], h.c[1] - h.r * 0.35, h.c[2]];
    const ctrl = [lerp3(fork, end, 0.25)[0], forkY + (end[1] - forkY) * 0.75, lerp3(fork, end, 0.25)[2]];
    const pts = bez(fork, ctrl, end, far ? 3 : near ? 7 : 5);
    const r0 = boleR * 0.62;
    tube(pts, pts.map((_, k) => r0 * (1 - 0.7 * (k / (pts.length - 1)))), far ? 4 : near ? 6 : 5, { t0: 0.55, t1: 1, tone: 0.05 });
    // A couple of side branches up into the head, which show through the
    // cracks between clumps as dark lines.
    if (!far) {
      for (let b = 0; b < (near ? 3 : 2); b++) {
        const ba = rand() * Math.PI * 2;
        const tip = add(h.c, [Math.cos(ba) * h.r * 0.7, h.r * 0.1, Math.sin(ba) * h.r * 0.7]);
        const from = pts[Math.max(1, pts.length - 2)];
        const bp = bez(from, lerp3(from, tip, 0.5), tip, 3);
        tube(bp, bp.map((_, k) => r0 * 0.3 * (1 - 0.7 * (k / (bp.length - 1)))), 3, { t0: 0.85, t1: 1, tone: 0.07 });
      }
    }
  }

  // CLUMPS: billboards over each head's upper surface (a flattened ball),
  // shared out by the head's area. Each carries its OWN head's outward normal,
  // so each cauliflower shades as a ball — sun side lit, far side dark, dark
  // cracks between heads — which is what a canopy looks like from above.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const areaSum = heads.reduce((s, h) => s + h.r * h.r, 0);
  const clumpR0 = Rc * 0.3 * (type.leafletWidth ?? 1) * (far ? 1.3 : near ? 1 : 1.12);
  for (const h of heads) {
    const n = Math.max(far ? 4 : 7, Math.round(clumpTotal * (h.r * h.r) / areaSum));
    const ry = h.r * 0.6;                                 // a flattened ball
    for (let i = 0; i <= n; i++) {
      // A cap point first (the top of the head is what the camera sees), then
      // a spiral over the upper two-thirds.
      const u = i === 0 ? 0 : (i - 0.5) / n;
      const th = i === 0 ? 0.08 : Math.acos(1 - 1.35 * Math.pow(u, 0.9));
      const ph = i * golden + (rand() - 0.5) * 0.4;
      const lump = 1 + (rand() - 0.5) * 0.12;
      const s0 = Math.sin(th), c0 = Math.cos(th);
      const c = [h.c[0] + h.r * s0 * Math.cos(ph) * lump, h.c[1] + ry * c0 * lump, h.c[2] + h.r * s0 * Math.sin(ph) * lump];
      const nrm = norm([(c[0] - h.c[0]) / (h.r * h.r), (c[1] - h.c[1]) / (ry * ry), (c[2] - h.c[2]) / (h.r * h.r)]);
      // Colour ramp: the underside of each head darker, its top lit.
      const hFrac = 0.35 + 0.65 * Math.max(0, Math.min(1, 0.5 + 0.5 * c0));
      const rho = clumpR0 * (0.75 + rand() * 0.5) * (th > Math.PI * 0.5 ? 0.7 : 1);
      if (!billboard) {
        // FIXED CARDS (the default, your call 2026-09-25: billboards turning
        // with the camera "look weird" when it moves). One card lying on the
        // head's surface and the rest tilted off it either way, fixed in the
        // world — the leaf-spray card has sky between its leaves, so crossed
        // cards read as a leafy volume, not as sheets.
        const ref = Math.abs(nrm[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
        const t0 = norm(cross(ref, nrm)), b0 = cross(nrm, t0);
        const rot = rand() * Math.PI * 2;
        const T = add([t0[0] * Math.cos(rot), t0[1] * Math.cos(rot), t0[2] * Math.cos(rot)], b0, Math.sin(rot));
        const B = cross(nrm, T);
        const cardRand = rand();
        for (let k = 0; k < cardsPer + 1; k++) {
          const tilt = k === 0 ? 0 : (k % 2 ? 1 : -1) * tiltOff * (0.7 + rand() * 0.6);
          const ct = Math.cos(tilt), st = Math.sin(tilt);
          const bb = add([B[0] * ct, B[1] * ct, B[2] * ct], nrm, st);
          const o = add(c, nrm, k === 0 ? 0 : rho * 0.12);
          const s = rho * (k === 0 ? 1 : 0.8);
          const base = vcount();
          for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const p = add(add(o, T, du * s), bb, dv * s);
            // ROUNDED NORMAL (your call, 2026-09-25 — the standard tree trick):
            // not the card's own plane but the HEAD's shape at this vertex,
            // outward from its centre (the flattened ball's gradient). Every
            // card of a head, whatever its tilt, then shades as one ball.
            const rn = norm([(p[0] - h.c[0]) / (h.r * h.r), (p[1] - h.c[1]) / (ry * ry), (p[2] - h.c[2]) / (h.r * h.r)]);
            push(p, rn, (du + 1) / 2, (dv + 1) / 2, [CARD, hFrac, cardRand, 0.15]);
          }
          I.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
        continue;
      }
      for (let k = 0; k < cardsPer; k++) {
        const o = add(c, nrm, (k - 0.5) * rho * 0.3);
        const s = rho * (k === 0 ? 1 : 0.8);
        const roll = 0.5 + (rand() - 0.5) * 0.16;
        const base = vcount();
        for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) push(o, nrm, cu, cv, [BILLBOARD, hFrac, roll, s]);
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }

  return finish();
}
