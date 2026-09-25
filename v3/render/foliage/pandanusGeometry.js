/**
 * PANDANUS — the screw pine (*dứa dại*): the spiky one on every Mekong bank,
 * canal edge and coastal dune from the delta to the Cambodian border. Built
 * for nam-rts (2026-09-25, your ask: "those exotic trees with spiky shapes").
 *
 * WHAT MAKES ONE, in the order they read from an RTS camera:
 *
 *   1. TUFTS OF SWORDS ON FORKED BRANCHES. Not a palm's single crown: the
 *      trunk forks, and forks again, and every branch ends in a SPIRAL tuft of
 *      long, narrow, keeled leaves — the young ones standing up, the old ones
 *      arching out and hanging. From above it is a handful of spiky stars.
 *   2. STILT ROOTS. Thick prop roots leave the trunk a metre or two up and
 *      stand on the ground round it like a tripod — nothing else in the
 *      jungle stands like that, and from the side it is the whole plant.
 *   3. A THIN, RINGED, LEANING TRUNK under the lot.
 *
 * Plain geometry, no card and no alpha test: every leaf is a V-folded strip,
 * so it stays sharp and early-depth-rejected like the ferns.
 *
 * ── PARTS ────────────────────────────────────────────────────────────────────
 *   0  leaf blades (flutter, see-through light), `t` 0 at the leaf's base
 *   3  trunk, branches, stilt roots (the culm path, colorHead)
 *
 * ── SHARED KEYS, RE-READ ─────────────────────────────────────────────────────
 *   fronds        leaf tufts (branch tips)
 *   frondLength   plant height, unit frame
 *   leaflets      leaves in a tuft
 *   leafletWidth  leaf width
 *   leafletAngle  how far the young leaves stand off the branch, degrees
 *   spread        how far the branches reach out, in plant heights
 *   arch          how far a leaf arches over along its length
 *   droop         how far the oldest leaves hang below the horizontal
 *   stemWidth     trunk thickness
 *   bareStalk     height of the first fork, in plant heights
 *   plumesPerStem stilt roots
 *   plumeSpread   leaf length, as % of plant height
 *   `size` 7 m.
 */
import { woodKit } from "./banyanGeometry.js";

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

const LEAF = 0;

export function buildPandanus(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;
  const { tube, bez } = woodKit(ctx);

  const H = type.frondLength ?? 1;
  const forkY = H * (type.bareStalk ?? 0.42);
  const reach = H * (type.spread ?? 0.28);
  const trunkR = 0.018 * H * (type.stemWidth ?? 1);
  const tufts = Math.max(2, Math.round(type.fronds ?? 4));
  const leavesPer = Math.max(8, Math.round((type.leaflets ?? 26) * (far ? 0.4 : near ? 1 : 0.65)));
  const leafLen = H * ((type.plumeSpread ?? 20) / 100);
  const leafW = 0.012 * H * (type.leafletWidth ?? 1);
  const standOff = ((type.leafletAngle ?? 35) * Math.PI) / 180;
  const arch = type.arch ?? 0.55;
  const droop = type.droop ?? 0.5;
  const segs = far ? 2 : near ? 5 : 3;
  const sides = far ? 4 : near ? 7 : 5;

  // ── 3. THE TRUNK: thin, ringed, a lean, up to the first fork ──────────────
  const lean = [(rand() - 0.5) * 0.16 * H, 0, (rand() - 0.5) * 0.16 * H];
  const trunk = bez([0, -0.01 * H, 0], [lean[0] * 0.3, forkY * 0.5, lean[2] * 0.3], [lean[0], forkY, lean[2]], far ? 3 : 6);
  tube(trunk, trunk.map((_, k) => trunkR * (1 - 0.25 * (k / (trunk.length - 1)))), sides, { t0: 0, t1: 0.5, tone: 0.05 });
  const fork = trunk[trunk.length - 1];

  // ── 2. STILT ROOTS: from a metre or two up, out and down onto the ground ───
  if (!far) {
    const roots = Math.max(3, Math.round(type.plumesPerStem ?? 6));
    for (let r = 0; r < roots; r++) {
      const a = (r / roots) * Math.PI * 2 + rand() * 0.6;
      const k = 0.08 + rand() * 0.14;                        // how high on the trunk it leaves
      const from = [lean[0] * k * 2.2, H * k, lean[2] * k * 2.2];
      const out = H * (0.07 + rand() * 0.06);
      const foot = [from[0] + Math.cos(a) * out, -0.01 * H, from[2] + Math.sin(a) * out];
      const mid = [from[0] + Math.cos(a) * out * 0.35, from[1] * 0.55, from[2] + Math.sin(a) * out * 0.35];
      const path = bez(from, mid, foot, near ? 4 : 2);
      tube(path, path.map((_, j) => trunkR * (0.5 - 0.15 * (j / (path.length - 1)))), far ? 3 : 5, { t0: 0, t1: 0.1, tone: 0.12 });
    }
  }

  // ── 1. BRANCHES, each ending in a spiral tuft of swords ────────────────────
  for (let b = 0; b < tufts; b++) {
    const a = (b / tufts) * Math.PI * 2 + rand() * 0.9;
    const out = reach * (0.55 + rand() * 0.45);
    const up = H - forkY - leafLen * 0.25;
    const tip = [fork[0] + Math.cos(a) * out, forkY + up * (0.55 + rand() * 0.45), fork[2] + Math.sin(a) * out];
    // Out first, then turning up: a candelabra, not a fan of straight sticks.
    const knee = [fork[0] + Math.cos(a) * out * 0.75, forkY + up * 0.2, fork[2] + Math.sin(a) * out * 0.75];
    const branch = bez(fork, knee, tip, far ? 3 : 5);
    tube(branch, branch.map((_, k) => trunkR * (0.72 - 0.3 * (k / (branch.length - 1)))), sides, { t0: 0.5, t1: 0.8, tone: 0.05 });
    const axis = norm([tip[0] - knee[0], tip[1] - knee[1], tip[2] - knee[2]]);

    // The tuft: leaves on a tight SPIRAL (the "screw"), youngest in the
    // middle standing up, oldest outside hanging.
    for (let l = 0; l < leavesPer; l++) {
      const age = l / (leavesPer - 1);                      // 0 young → 1 old
      const phi = l * 2.39996 + rand() * 0.2;               // golden-angle spiral
      const around = [Math.cos(phi), 0, Math.sin(phi)];
      // How far off the branch axis it leaves: young leaves close to it,
      // old ones out past the horizontal.
      const off = standOff * 0.4 + age * (Math.PI / 2 + droop * 0.6 - standOff * 0.4);
      const dir0 = norm(add(scale(axis, Math.cos(off)), around, Math.sin(off)));
      const len = leafLen * (0.75 + 0.35 * (1 - Math.abs(age - 0.55)) ) * (0.9 + rand() * 0.2);
      const width = leafW * (0.85 + rand() * 0.3);
      const lr = rand();
      // Down the leaf: it arches over and its tip hangs, more for the old ones.
      let p = add(tip, dir0, width * 0.5);
      let d = dir0;
      const rows = [];
      for (let s = 0; s <= segs; s++) {
        const v = s / segs;
        rows.push({ p, d, v });
        const bend = (arch * 0.9 + age * droop * 0.8) / segs;
        d = norm(add(d, [0, -1, 0], bend));
        p = add(p, d, len / segs);
      }
      // A V-folded strip: edge, keel (a touch lower), edge — narrowing to a point.
      const base = vcount();
      for (const { p: q, d: dd, v } of rows) {
        const w = width * (v < 0.1 ? 0.6 + v * 4 : 1 - Math.pow((v - 0.1) / 0.9, 1.4)) ;
        const sd = norm(cross(dd, [0, 1, 0]));
        const nUp = norm(cross(sd, dd));
        const n = nUp[1] < 0 ? scale(nUp, -1) : nUp;
        const keel = add(q, n, -w * 0.35);
        const a4 = [LEAF, v, lr, v];
        push(add(q, sd, -w), n, 0, v, a4);
        push(keel, n, 0.5, v, a4);
        push(add(q, sd, w), n, 1, v, a4);
      }
      for (let s = 0; s < segs; s++) {
        const r0 = base + s * 3, r1 = r0 + 3;
        I.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1, r0 + 1, r1 + 1, r0 + 2, r0 + 2, r1 + 1, r1 + 2);
      }
    }
  }
  return finish();
}
