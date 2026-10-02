/**
 * BETOUM — the Atlas pistachio (Pistacia atlantica), the big round shade tree
 * of the Algerian high plains and the Aurès wadi beds: alg-rts's landmark tree.
 *
 * v2 (2026-10-02; you: "the trunk is wrong and has plenty of broken mesh… the
 * foliage could be way better"). v1 drew every limb piece as its own open
 * tube: cracks and kinks at every joint, radius jumps, open black ends, the
 * surface twisting at bends. Rebuilt on what tree generators do (ez-tree,
 * proctree, SpeedTree — research 2026-10-02):
 *
 *   SKELETON  grown once from the tree's OWN seed, so every detail level is
 *             the same tree (v1 re-grew it per level: it changed shape as you
 *             zoomed). A short fat bole splits into 2-3 stems, then limbs,
 *             then two more orders; each branch is a run of points that
 *             wanders (gnarl, more on thin wood) and is pulled up and out by
 *             a force that barely moves thick limbs (∝ 1/r). Radii follow the
 *             PIPE MODEL — a parent's cross-section ≈ its children's.
 *   MESH      ONE continuous tube per branch, rings carried along by
 *             PARALLEL TRANSPORT (no twist, no pinch at bends). A child starts
 *             on its parent's AXIS — its root ring is buried inside the parent,
 *             so no seam or hole ever shows — with a COLLAR (its first rings
 *             flared ×1.45) and a darker fork (baked AO). Tips close to a
 *             point. The bole flares into 5 buttress lobes at the ground.
 *   BARK      part 3.4: the shader draws furrowed bark from uv (u = round the
 *             branch in whole wraps, v = metres along it, carried from parent
 *             to child) — grey-brown, darker in the cracks and low down.
 *   CROWN     an ellipsoid proxy over the branch tips. Leaf-spray clusters
 *             (cards, part 5.35) sit at the tips and along the outer twigs,
 *             only in the crown's outer SHELL (the inside is never seen);
 *             every card's normal is the CROWN's, bent a little toward its own
 *             clump — the whole dome lights as one mass with lumps on it. The
 *             inner shadow (SELF_OCCLUSION) darkens the underside and cracks.
 *
 * Unit frame (height ~1); the preset's `size` (11 m) scales it.
 *   fronds  stems (2-3) · leaflets  clusters (LOD0) · leafletWidth cluster size
 *   spread  crown radius in plant heights · stemWidth  trunk thickness
 */

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const BARK = 3.4;     // foliageSystem: a culm-shaded part with procedural bark
const CARD = 5.35;    // the canopy-tree dome cards (leaf spray texture)

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Grow the skeleton: a list of branches { pts, radii, level, arc0, parent }.
 * Deterministic from `seed`, independent of the detail level.
 */
function growSkeleton(type, seed) {
  const R = mulberry(seed);
  const branches = [];
  const stemW = type.stemWidth ?? 1;
  const up = [0, 1, 0];

  /** Walk a branch: `n` steps of `len/n` from p along dir, radius r0 → r1. */
  const walk = (p, dir, len, r0, r1, n, gnarl, upForce, outDir, startDir = null, rFn = null) => {
    const pts = [p], radii = [rFn ? rFn(0) : r0];
    // `startDir`: leave along it and turn toward `dir` over the first half
    // (a fork rises out of its trunk and THEN bends away).
    let d = startDir ?? dir;
    for (let i = 1; i <= n; i++) {
      const t = i / n, r = rFn ? rFn(t) : r0 + (r1 - r0) * t;
      if (rFn && rFn.dirAt) d = norm(lerp3(d, rFn.dirAt(t), 0.6));
      else if (startDir) d = norm(lerp3(d, dir, Math.min(1, 0.45 + t)));
      // Gnarl: thin wood wanders more.
      const g = gnarl * Math.min(2.5, 0.02 / Math.max(r, 0.004));
      d = norm(add(add(d, [(R() - 0.5) * g, (R() - 0.5) * g * 0.5, (R() - 0.5) * g]),
        add(up, outDir ?? [0, 0, 0], 0.6), upForce * Math.min(1, 0.01 / Math.max(r, 0.002))));
      pts.push(add(pts[i - 1], d, len / n));
      radii.push(r);
    }
    return { pts, radii };
  };

  /** Spawn children along a branch, recursively. */
  const children = (b, level, maxLevel) => {
    if (level > maxLevel) return;
    const n = b.pts.length - 1;
    const count = level === 2 ? 4 + Math.floor(R() * 3) : level === 3 ? 3 + Math.floor(R() * 2) : 2 + Math.floor(R() * 2);
    const start = b.childStart ?? (level === 2 ? 0.25 : 0.35);
    for (let k = 0; k < count; k++) {
      // Stratified along the parent, a golden-angle turn each.
      const f = start + (1 - start) * ((k + 0.3 + R() * 0.4) / count);
      const i = Math.min(n - 1, Math.floor(f * n)), ft = f * n - i;
      const at = lerp3(b.pts[i], b.pts[i + 1], ft);
      const pr = b.radii[i] + (b.radii[i + 1] - b.radii[i]) * ft;
      const pdir = norm(sub(b.pts[i + 1], b.pts[i]));
      const az = k * 2.39996 + R() * 0.8;
      const side = norm(cross(pdir, [Math.cos(az), 0.2, Math.sin(az)]));
      const out = norm([Math.cos(az), 0, Math.sin(az)]);
      // Wide-spreading: out more than up, the outer orders drooping a little.
      // The limbs go OUT, nearly level; the finer orders turn up again.
      const ang = level === 2 ? 1.0 + R() * 0.35 : 0.55 + R() * 0.45;
      const dir = norm(add(add(pdir, side, Math.tan(ang)), out, level === 2 ? 1.2 : 0.5));
      // Pipe model: a child ≈ 0.55-0.7 of its parent's radius there.
      const r0 = pr * (0.55 + R() * 0.15);
      // (2026-10-02, you: "an even wider crown": longer, flatter limbs.)
      const len = b.len * (level === 2 ? 1.05 + R() * 0.3 : 0.62 + R() * 0.2) * (1 - f * 0.3);
      const steps = level === 2 ? 7 : level === 3 ? 5 : 4;
      const w = walk(at, dir, len, r0, r0 * 0.25, steps, 0.35, level === 2 ? 0.2 : level === 4 ? 0.6 : 0.75, out);
      const child = { ...w, level, len, parent: b, arc0: b.arcAt(f), collar: true };
      addArc(child);
      branches.push(child);
      children(child, level + 1, maxLevel);
    }
  };
  /** Arc length along a branch: `arcAt(f)` for children, carried from the root. */
  const addArc = (b) => {
    const acc = [b.arc0 ?? 0];
    for (let i = 1; i < b.pts.length; i++) acc.push(acc[i - 1] + Math.hypot(...sub(b.pts[i], b.pts[i - 1])));
    b.arcs = acc;
    b.arcAt = (f) => {
      const x = f * (acc.length - 1), i = Math.min(acc.length - 2, Math.floor(x));
      return acc[i] + (acc[i + 1] - acc[i]) * (x - i);
    };
  };

  // THE TRUNK never ends in a cut: the BOLE carries on as the first stem (one
  // tube from the ground to that stem's tip — no flat top to show), and the
  // other stems leave its side at the fork, rising out of it and then
  // bending away. (Stems on a bole's flat top read as sticks in a stump.)
  const boleR = 0.05 * stemW;
  // A clear trunk under the crown (a short one read as a bush once the crown
  // went wide).
  const boleH = 0.3 + R() * 0.06;
  const stems = Math.max(2, Math.min(3, Math.round(type.fronds ?? 2) + (R() < 0.4 ? 1 : 0)));
  const stemDir = (s) => {
    const az = (s / stems) * Math.PI * 2 + R() * 0.9;
    const out = [Math.cos(az), 0, Math.sin(az)];
    // Leaning well out: the betoum is far wider than tall.
    return { out, dir: norm(add([0, 1, 0], out, Math.tan(0.78 + R() * 0.28))) };
  };
  const s0 = stemDir(0);
  const stemLen = 0.27 + R() * 0.07;
  const total = boleH + stemLen;
  const fk = boleH / total;                         // the fork, as a fraction
  const r0Main = boleR * 0.78;
  const n0 = 11;
  // The bole stands nearly upright to the fork; only then does the stem lean.
  const mainR = (t) => (t < fk ? boleR + (r0Main - boleR) * (t / fk) : r0Main + (r0Main * 0.5 - r0Main) * ((t - fk) / (1 - fk)));
  const boleUp = norm([s0.out[0] * 0.1, 1, s0.out[2] * 0.1]);
  mainR.dirAt = (t) => (t < fk ? boleUp : s0.dir);
  const main = {
    // The root ring sits well BELOW the ground (~0.5 m at 11 m), so the foot
    // grows out of the soil on any slope and its open bottom never shows.
    ...walk([0, -0.045, 0], s0.dir, total, 0, 0, n0, 0.12, 0.3, s0.out, boleUp, mainR),
    level: 1, len: stemLen, arc0: 0, flare: true,
    childStart: fk + (1 - fk) * 0.25,                // no limbs off the bole itself
  };
  addArc(main);
  branches.push(main);
  children(main, 2, 4);
  // The other stems, out of the main trunk at the fork.
  const forkAt = Math.round(fk * n0);
  for (let s = 1; s < stems; s++) {
    const { out, dir } = stemDir(s);
    const at = main.pts[Math.max(1, forkAt - 1)];
    const r0 = r0Main * (0.88 + R() * 0.1);
    const len = stemLen * (0.85 + R() * 0.2);
    const trunkDir = norm(sub(main.pts[forkAt], main.pts[forkAt - 1]));
    const w = walk(at, dir, len, r0, r0 * 0.5, 8, 0.25, 0.35, out, norm(add(trunkDir, out, 0.3)));
    const stem = { ...w, level: 1, len, parent: main, arc0: main.arcs[Math.max(1, forkAt - 1)], collar: true, collarK: 0.15 };
    addArc(stem);
    branches.push(stem);
    children(stem, 2, 4);
  }
  return branches;
}

export function buildBetoum(type, ctx) {
  const { near, far, rand, push, vcount, I, finish } = ctx;
  // ONE skeleton for every detail level: the first rand() is the same at
  // every level (nothing has consumed the generator yet).
  const seed = Math.floor(rand() * 2 ** 31);
  const skel = growSkeleton(type, seed);
  const R = mulberry(seed ^ 0x5bd1e995);               // the crown's own stream
  const size = type.size ?? 11;

  // ── THE WOOD ────────────────────────────────────────────────────────────
  // Per level: sides round, every `stride`-th ring kept, the finest orders
  // dropped far away.
  const maxLevel = far ? 2 : near ? 4 : 3;
  const sidesOf = (lvl) => Math.max(near ? 5 : 3, (far ? 5 : near ? 14 : 8) - lvl * (near ? 2 : 1));
  const stride = far ? 3 : near ? 1 : 2;
  const BARK_TILE = 0.7;                                  // metres a bark tile spans round

  const tube = (b) => {
    const sides = sidesOf(b.level);
    const idx = [];
    for (let i = 0; i < b.pts.length; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== b.pts.length - 1) idx.push(b.pts.length - 1);
    const pts = idx.map((i) => b.pts[i]), radii = idx.map((i) => b.radii[i]), arcs = idx.map((i) => b.arcs[i]);
    const n = pts.length;
    // Whole wraps of the bark tile round the branch, from its root radius.
    const wraps = Math.max(1, Math.round((2 * Math.PI * radii[0] * size) / BARK_TILE));
    // Parallel transport: the ring's frame carried along, never re-seeded.
    let T = norm(sub(pts[1], pts[0]));
    let N = norm(cross(T, Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    let prev = -1;
    for (let j = 0; j < n; j++) {
      if (j > 0) {
        const T2 = norm(sub(pts[Math.min(n - 1, j + 1)], pts[j - 1]));
        N = norm(sub(N, [T2[0] * dot(N, T2), T2[1] * dot(N, T2), T2[2] * dot(N, T2)]));
        T = T2;
      }
      const B = cross(T, N);
      const t = j / (n - 1);
      // The collar: a child's first rings flare where it leaves its parent.
      const collar = b.collar ? 1 + (b.collarK ?? 0.45) * Math.max(0, 1 - j / 1.6) : 1;
      // The fork's shadow: darker where the child is buried in its parent.
      const fork = b.collar ? 0.7 + 0.3 * Math.min(1, j / 2) : 1;
      // The tip closes to a point on the outermost order.
      const r = (j === n - 1 && b.level >= maxLevel ? 0.0005 : radii[j]) * collar;
      const base = vcount();
      for (let s = 0; s <= sides; s++) {
        const th = (s / sides) * Math.PI * 2;
        let rr = r;
        // Root flare + 5 buttress lobes at the bole's foot.
        if (b.flare) {
          // (2026-10-02, you: "the bottom looks wrong, not on the ground"):
          // the lobes only where the ring is round enough to draw them (with
          // 5 sides they made a star skirt), and a gentler flare.
          const h = pts[j][1];
          const k = Math.exp(-Math.max(0, h) / 0.045);
          const lobes = sides >= 9 ? 0.3 * Math.pow(Math.abs(Math.sin(th * 2.5 + 0.7)), 2) : 0;
          rr *= 1 + k * (0.4 + lobes);
        }
        const nrm = add([N[0] * Math.cos(th), N[1] * Math.cos(th), N[2] * Math.cos(th)], B, Math.sin(th));
        const ny = [nrm[0] * fork, nrm[1] * fork, nrm[2] * fork];
        push(add(pts[j], nrm, rr), ny, (s / sides) * wraps, arcs[j] * size, [BARK, Math.min(1, pts[j][1]), 0.3 + b.level * 0.1, -1]);
      }
      if (prev >= 0) {
        for (let s = 0; s < sides; s++) I.push(prev + s, prev + s + 1, base + s, prev + s + 1, base + s + 1, base + s);
      }
      prev = base;
    }
    // A cut end that is not a closed tip: a fan cap.
    if (b.level < maxLevel) {
      const last = pts[n - 1], fwd = norm(sub(last, pts[n - 2]));
      const tip = vcount();
      push(add(last, fwd, radii[n - 1] * 0.4), fwd, 0.5, arcs[n - 1] * size, [BARK, Math.min(1, last[1]), 0.5, -1]);
      for (let s = 0; s < sides; s++) I.push(prev + s, prev + s + 1, tip);
    }
  };
  for (const b of skel) if (b.level <= maxLevel) tube(b);

  // ── THE CROWN ───────────────────────────────────────────────────────────
  // Its proxy: an ellipsoid round the outermost wood.
  const twigs = skel.filter((b) => b.level >= 3);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of twigs) for (const p of b.pts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
  const cc = [(lo[0] + hi[0]) / 2, lo[1] + (hi[1] - lo[1]) * 0.42, (lo[2] + hi[2]) / 2];
  const ex = Math.max(0.1, (hi[0] - lo[0]) / 2 + 0.08), ez = Math.max(0.1, (hi[2] - lo[2]) / 2 + 0.08);
  const ey = Math.max(0.08, (hi[1] - lo[1]) * 0.62 + 0.06);
  const shellOf = (p) => Math.hypot((p[0] - cc[0]) / ex, (p[1] - cc[1]) / ey, (p[2] - cc[2]) / ez);
  const crownN = (p) => norm([(p[0] - cc[0]) / (ex * ex), (p[1] - cc[1]) / (ey * ey), (p[2] - cc[2]) / (ez * ez)]);

  // Cluster anchors: along the outer twigs (both last orders), kept only in
  // the crown's outer shell.
  const anchors = [];
  for (const b of twigs) {
    for (let i = 1; i < b.pts.length; i++) {
      const p = b.pts[i];
      if (shellOf(p) < 0.55) continue;
      anchors.push({ p, d: norm(sub(p, b.pts[i - 1])) });
    }
  }
  const want = Math.max(24, Math.round((type.leaflets ?? 260) * (far ? 0.18 : near ? 1 : 0.45)));
  const keep = Math.min(1, want / Math.max(1, anchors.length));
  const cardsPer = far ? 1 : 2;
  const sizeK = (type.leafletWidth ?? 1) * (far ? 2.1 : near ? 1 : 1.45);
  const tilt = 0.6;
  for (const a of anchors) {
    if (R() > keep) continue;
    const s = 0.09 * sizeK * (0.75 + R() * 0.55);
    // Pushed a little out along the crown, off the twig.
    const cn = crownN(a.p);
    const c = add(a.p, cn, s * 0.35);
    const hFrac = Math.max(0.2, Math.min(1, 0.55 + 0.45 * cn[1]));
    const cardRand = R();
    // The card's plane: roughly facing out of the crown, rolled along its twig.
    const ref = Math.abs(cn[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    const t0 = norm(cross(ref, cn)), b0 = cross(cn, t0);
    const rot = Math.atan2(dot(a.d, b0), dot(a.d, t0)) + (R() - 0.5) * 0.8;
    const T = add([t0[0] * Math.cos(rot), t0[1] * Math.cos(rot), t0[2] * Math.cos(rot)], b0, Math.sin(rot));
    const Bv = cross(cn, T);
    // Which of the atlas's four twigs (betoum_clusters.png, 2x2).
    const cell = Math.floor(R() * 4), cu = (cell % 2) * 0.5, cv = Math.floor(cell / 2) * 0.5;
    for (let k = 0; k < cardsPer; k++) {
      const tl = k === 0 ? (R() - 0.5) * 0.4 : (R() < 0.5 ? 1 : -1) * tilt * (0.7 + R() * 0.6);
      const bb = add([Bv[0] * Math.cos(tl), Bv[1] * Math.cos(tl), Bv[2] * Math.cos(tl)], cn, Math.sin(tl));
      const sk = k === 0 ? 1 : 0.85;
      let cardN = norm(cross(T, bb));
      if (dot(cardN, cn) < 0) cardN = [-cardN[0], -cardN[1], -cardN[2]];
      const base = vcount();
      // The twig's base (the texture's bottom centre) sits on the anchor,
      // the card running out along the twig (T).
      const c2 = add(c, T, s * sk * 0.85);
      for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = add(add(c2, T, du * s * sk), bb, dv * s * sk);
        // The CROWN's normal at this corner, bent 25% toward the card's own
        // facing — one lit dome, with lumps.
        const n = norm(add(crownN(p), cardN, 0.25));
        // u across the twig, v along it (0 at the base), in this card's cell.
        push(p, n, cu + (dv + 1) / 4, cv + (du + 1) / 4, [CARD, hFrac, cardRand, 0.15]);
      }
      I.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return finish();
}
