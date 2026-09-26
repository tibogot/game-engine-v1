/**
 * ATLAS CEDAR — *Cedrus atlantica*, the tree of the Aurès and Djurdjura
 * heights (the Algeria game, 2026-09-26). Where the jungle trees are domes
 * and cauliflowers, a cedar is a stack of LEVEL PLATES.
 *
 * WHAT MAKES ONE, in the order they read from an RTS camera:
 *
 *   1. THE TIERS. Long branches held out LEVEL from the trunk, each ending in
 *      a broad, flat, dense plate of needles; the plates of one tier make a
 *      shelf, and the shelves stack with dark gaps between them. From above a
 *      cedar is a rosette of overlapping shelves, each lit on top.
 *   2. THE TABLE TOP. An old cedar stops growing up and spreads: the upper
 *      tiers are nearly as wide as the lower ones, and the top is flat.
 *   3. THE TRUNK. Massive, dark, often forking into two or three leaders.
 *
 * The plates are the dipterocarp's heads flattened (dipterocarpGeometry.js):
 * fixed cards on each plate's upper surface carrying the PLATE's rounded
 * normal, so every shelf shades as one lit slab with a dark underside.
 *
 * ── PARTS ────────────────────────────────────────────────────────────────────
 *   3     trunk, leaders, branches (woodKit tubes)
 *   5.35  fixed needle cards (the "needle" card)
 *
 * ── SHARED KEYS, RE-READ ─────────────────────────────────────────────────────
 *   fronds        tiers
 *   frondLength   plant height, unit frame
 *   leaflets      needle cards over the whole tree
 *   leafletWidth  card size
 *   leafletAngle  how far the extra cards tilt off the plate
 *   spread        crown radius, in plant heights (lowest tier)
 *   arch          taper: 0 a flat table (old tree), 1 a cone (young tree)
 *   stemWidth     trunk thickness
 *   bareStalk     height of the lowest tier, in plant heights
 *   plumesPerStem branches (plates) per tier
 *   droop         how much the plate ends sag
 */
import { woodKit } from "./banyanGeometry.js";

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const CARD = 5.35;

export function buildAtlasCedar(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;
  const { tube, bez } = woodKit(ctx);

  const H = type.frondLength ?? 1;
  const tiers = Math.max(3, Math.round(type.fronds ?? 7));
  const perTier = Math.max(3, Math.round(type.plumesPerStem ?? 5));
  const Rc = H * (type.spread ?? 0.42);
  const lowY = H * (type.bareStalk ?? 0.2);
  const arch = type.arch ?? 0.25;
  const trunkR = 0.028 * H * (type.stemWidth ?? 1.4);
  const droop = type.droop ?? 0.2;
  const tiltOff = ((type.leafletAngle ?? 22) * Math.PI) / 180;
  const cardTotal = Math.max(24, Math.round((type.leaflets ?? 110) * (far ? 0.45 : near ? 1 : 0.7)));
  const cardsPer = far ? 1 : 2;
  const sides = far ? 5 : near ? 9 : 7;

  // ── 3. THE TRUNK: a thick bole, forking into leaders two-thirds up ──────────
  const forkY = H * (0.42 + rand() * 0.12);
  const lean = [(rand() - 0.5) * 0.05 * H, 0, (rand() - 0.5) * 0.05 * H];
  const boleSteps = far ? 3 : 5;
  const bole = [], radii = [];
  for (let k = 0; k <= boleSteps; k++) {
    const s = k / boleSteps;
    bole.push([lean[0] * s, s * forkY - (k === 0 ? 0.004 * H : 0), lean[2] * s]);
    radii.push(trunkR * (1 - 0.25 * s) * (1 + 0.45 * Math.exp(-s * 10)));
  }
  tube(bole, radii, sides, { t0: 0, t1: 0.5, tone: 0.02 });
  const fork = bole[bole.length - 1];
  const leaders = [];
  const nLead = 2 + (rand() < 0.5 ? 1 : 0);
  for (let l = 0; l < nLead; l++) {
    const a = (l / nLead) * Math.PI * 2 + rand();
    const top = [fork[0] + Math.cos(a) * Rc * 0.18, H * (0.9 + rand() * 0.08), fork[2] + Math.sin(a) * Rc * 0.18];
    const pts = bez(fork, [fork[0] + Math.cos(a) * Rc * 0.1, (forkY + top[1]) / 2, fork[2] + Math.sin(a) * Rc * 0.1], top, far ? 3 : 5);
    tube(pts, pts.map((_, k) => trunkR * 0.62 * (1 - 0.75 * (k / (pts.length - 1)))), far ? 4 : 6, { t0: 0.5, t1: 1, tone: 0.03 });
    leaders.push(pts);
  }

  // ── 1. THE TIERS: level branches, each ending in a plate ────────────────────
  // A tier's height, and its reach: broad all the way up when `arch` is low
  // (the old tree's table), narrowing to a point when it is high.
  const plates = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  let turn = rand() * Math.PI * 2;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = lowY + (H * 0.93 - lowY) * f;
    const reach = Rc * (1 - arch * f * 0.85) * (0.85 + rand() * 0.25);
    const n = t === tiers - 1 ? 3 : perTier;
    for (let b = 0; b < n; b++) {
      turn += golden + (rand() - 0.5) * 0.3;
      // Where on the trunk/leaders the branch leaves from, at this height.
      const src = y < forkY ? [lean[0] * (y / forkY), y, lean[2] * (y / forkY)]
        : (() => { const L = leaders[b % leaders.length]; const k = Math.min(L.length - 1, Math.round(((y - forkY) / (H * 0.95 - forkY)) * (L.length - 1))); return L[k]; })();
      const len = reach * (0.75 + rand() * 0.3);
      const dir = [Math.cos(turn), 0, Math.sin(turn)];
      // The branch runs out nearly level, rising a touch, the plate centre
      // two-thirds of the way along it.
      const end = add(src, dir, len);
      end[1] = y + (rand() - 0.3) * 0.03 * H;
      const mid = add(src, dir, len * 0.5);
      mid[1] = y + 0.02 * H;
      const pts = bez(src, mid, end, far ? 2 : near ? 5 : 3);
      const r0 = trunkR * (0.34 - 0.12 * f);
      tube(pts, pts.map((_, k) => r0 * (1 - 0.8 * (k / (pts.length - 1)))), far ? 3 : 4, { t0: 0.6, t1: 1, tone: 0.04 });
      const pr = len * (0.5 + rand() * 0.18);
      plates.push({ c: add(src, dir, len * 0.62).map((v, i) => (i === 1 ? y + 0.01 * H : v)), r: pr, ry: pr * 0.22, dir, f });
    }
  }

  // ── NEEDLE CARDS over each plate's upper surface ────────────────────────────
  const areaSum = plates.reduce((s, p) => s + p.r * p.r, 0);
  const card0 = Rc * 0.24 * (type.leafletWidth ?? 1) * (far ? 1.3 : near ? 1 : 1.12);
  for (const p of plates) {
    const n = Math.max(far ? 2 : 4, Math.round(cardTotal * (p.r * p.r) / areaSum));
    for (let i = 0; i < n; i++) {
      // Spread over the plate's top, a little denser at its heart.
      const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * p.r * 0.85;
      let c = [p.c[0] + Math.cos(a) * rr, p.c[1] + p.ry * 0.6, p.c[2] + Math.sin(a) * rr];
      // The plate's outer end sags.
      const out = (Math.cos(a) * p.dir[0] + Math.sin(a) * p.dir[2]) * rr / p.r;
      c[1] -= Math.max(0, out) * droop * p.r * 0.35;
      const nrm = norm([(c[0] - p.c[0]) / (p.r * p.r), (c[1] - p.c[1] + p.ry * 0.3) / (p.ry * p.ry), (c[2] - p.c[2]) / (p.r * p.r)]);
      // Each shelf lit on its top and falling dark toward its rim, so the
      // tiers separate into bands from the oblique RTS camera.
      const hFrac = 0.3 + 0.5 * (1 - rr / p.r) ** 1.5 + 0.12 * p.f;
      const rho = card0 * (0.7 + rand() * 0.5);
      // The card's v (its spray's main twig) points OUT along the branch, a
      // little fanned: every spray on a plate combed the same way, which is
      // what makes a plate read as one layered sheet and not as coins.
      const fan = (rand() - 0.5) * 1.1 + (Math.atan2(Math.sin(a), Math.cos(a)) - Math.atan2(p.dir[2], p.dir[0])) * 0.25;
      const cf = Math.cos(fan), sf = Math.sin(fan);
      const outDir = norm([p.dir[0] * cf - p.dir[2] * sf, 0, p.dir[0] * sf + p.dir[2] * cf]);
      // B along the spray, projected onto the plate's surface; T across it.
      const Bp = norm(add(outDir, nrm, -(outDir[0] * nrm[0] + outDir[1] * nrm[1] + outDir[2] * nrm[2])));
      const T = norm(cross(Bp, nrm));
      const B = cross(nrm, T);
      const cardRand = rand();
      for (let k = 0; k < cardsPer + 1; k++) {
        const tilt = k === 0 ? 0 : (k % 2 ? 1 : -1) * tiltOff * (0.6 + rand() * 0.6);
        const ct = Math.cos(tilt), st = Math.sin(tilt);
        const bb = add([B[0] * ct, B[1] * ct, B[2] * ct], nrm, st);
        const o = add(c, nrm, k === 0 ? 0 : rho * 0.08);
        const s = rho * (k === 0 ? 1 : 0.78);
        const base = vcount();
        // The spray card is twice as long as it is wide (256 x 512).
        for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const q = add(add(o, T, du * s * 0.5), bb, dv * s);
          // The PLATE's rounded normal: every card of a shelf shades as one
          // slab — lit top, dark underside.
          const rn = norm([(q[0] - p.c[0]) / (p.r * p.r), (q[1] - p.c[1] + p.ry * 0.3) / (p.ry * p.ry), (q[2] - p.c[2]) / (p.r * p.r)]);
          push(q, rn, (du + 1) / 2, (dv + 1) / 2, [CARD, Math.min(1, hFrac), cardRand, 0.15]);
        }
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    // The shelf's underside: a couple of cards facing down, darker, so a plate
    // seen from low down is not see-through.
    if (!far) {
      for (let i = 0; i < 2; i++) {
        const a = rand() * Math.PI * 2, rr = rand() * p.r * 0.5;
        const c = [p.c[0] + Math.cos(a) * rr, p.c[1] - p.ry * 0.2, p.c[2] + Math.sin(a) * rr];
        const s = card0 * 1.1;
        const base = vcount();
        for (const [du, dv] of [[-1, -1], [-1, 1], [1, 1], [1, -1]]) {
          push([c[0] + du * s, c[1], c[2] + dv * s], [0, -1, 0], (du + 1) / 2, (dv + 1) / 2, [CARD, 0.1, rand(), 0.15]);
        }
        I.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }

  return finish();
}
