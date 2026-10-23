// LAYERED SANDSTONE PIECES (2026-10-23, you, close up in the rock lab: "you said saw tooth is gone but I can see some
// everywhere … you use some too sharp angles"). The engine's rock generator (v3/props/proceduralRock.js) pushes a SPHERE
// mesh out to the rock's surface: a sharp horizontal ledge crosses its triangles on the slant and comes out a
// saw-tooth, however it is softened. Sandstone is ledges. So these pieces are built the way the rock is: a stack of
// horizontal RINGS — every ledge, every bedding step and the lip lie exactly on a row of the mesh, crisp and never
// toothed — and a top and a foot closed by rings shrinking inward.
//
//   OUTLINE   in plan: a superellipse (round = an oval … square = a block), a few low lobes, and BREAKS — flat
//             vertical fracture faces cut into it (soft-cornered: a column of the mesh runs up each corner)
//   PROFILE   up the wall: the foot eaten back (the undercut), bedding BANDS each set back its own amount with a
//             step as sharp as asked (rows placed on both sides of each step), the RELIEF (lumps, blocks, runnels —
//             below), the LIP rolled round on a quarter circle
//   TOP       rings shrinking to the middle, low swells over them
//
// Its rockShade (edge curvature, height) baked as the engine's rocks', so the game's sandstone material reads it the same.
import * as THREE from "three";
import { bakeRockShade } from "../../v3/props/proceduralRock.js";

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} p  { seed, sx, h, sz (half-length, height, half-depth m), round 0..1, breaks 0..1, undercut 0..0.4,
 *                    strata (bands), sharp 0..1 (their steps), relief { lumps, blocks, runnels } 0..1, joints (cracks) }
 */
export function layeredGeometry(p) {
  const R = mulberry32((p.seed | 0) * 9173 + 29);
  const sx = p.sx, sz = p.sz, h = p.h, m = Math.min(sx, sz);
  // columns round the outline: ~18 cm apart (the blocks and runnels need them; ~33 cm blurred them)
  const N = Math.max(64, Math.min(420, Math.round((Math.PI * (sx + sz) * 1.1) / 0.18)));
  // ── the OUTLINE in plan ──
  const e = 2.4 + (1 - p.round) * 3.2;
  const lobes = Array.from({ length: 4 }, () => ({ a: R() * Math.PI * 2, amp: (R() - 0.35) * 0.1, k: 1 + Math.floor(R() * 3) }));
  const breaks = Array.from({ length: Math.round(2 + p.breaks * 9) }, () => ({ a: R() * Math.PI * 2, d: 0.03 + R() * (0.05 + p.breaks * 0.14) }));
  // the joints: vertical cracks up the whole wall (a CLIFF's: deep and wide — they split it into columns, jointDepth m)
  const jd = p.jointDepth ?? 0.14, jw = p.jointDepth ? 0.25 + p.jointDepth * 0.35 : 0.15;
  const joints = Array.from({ length: p.joints ?? 2 }, () => ({ a: R() * Math.PI * 2, w: jw * (0.8 + R() * 0.5), d: 0.06 + R() * jd }));
  const base = (a) => { const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)); return 1 / Math.pow(Math.pow(c / sx, e) + Math.pow(s / sz, e), 1 / e); };
  const plan = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    const a = (j / N) * Math.PI * 2;
    let r = base(a);
    for (const l of lobes) r *= 1 + l.amp * Math.cos(l.k * (a - l.a));
    // a break: a vertical plane at its direction, cut in; the outline the soft min of the egg and the planes
    const k = 0.12 + (1 - p.breaks) * 0.25;
    let s = Math.exp(-r / k);
    for (const b of breaks) {
      const cs = Math.cos(a - b.a);
      if (cs > 0.05) { const t = (base(b.a) * (1 - b.d)) / cs; if (t < r + 4 * k) s += Math.exp(-t / k); }
    }
    r = -k * Math.log(s);
    for (const jt of joints) { const da = Math.atan2(Math.sin(a - jt.a), Math.cos(a - jt.a)) * r; r -= jt.d * Math.exp(-((da / jt.w) ** 2)); }
    plan[j] = Math.max(0.15, r);
  }
  // ── the PROFILE: the rows' heights, with the band steps placed exactly ──
  const lipR = Math.min(h * 0.45, 0.12 + p.round * 0.45);
  const nb = Math.max(0, Math.round(p.strata ?? 0));
  const bandY = Array.from({ length: nb }, (_, b) => (h * (b + 1)) / (nb + 1) + (R() - 0.5) * h * 0.08);
  const bandD = Array.from({ length: nb + 1 }, () => R() * m * (0.03 + p.sharp * 0.05));
  const eps = 0.015 + (1 - p.sharp) * 0.09;                               // half the step's height
  const ys = new Set([0, h]);
  for (let y = 0; y < h; y += 0.12) ys.add(+y.toFixed(4));
  for (let i = 1; i <= 8; i++) ys.add(+(h - lipR + (lipR * i) / 8).toFixed(4));   // the lip's quarter circle
  for (const y of bandY) for (const d of [-eps, -eps / 2, 0, eps / 2, eps]) if (y + d > 0 && y + d < h - lipR) ys.add(+(y + d).toFixed(4));
  const rows = [...ys].sort((a, b) => a - b);
  // THE RELIEF (2026-10-23, you: the squashed ledges read as PANCAKES — "we need to make the wall relief another
  // way"). Three smooth displacements in the rock's own 3D space (never a step: only the band rows are sharp), each its own
  // slider — the usual recipe for natural rock (warped noise for the forms, Voronoi for the blocks, ridged noise for
  // the erosion):
  //   LUMPS    domain-WARPED noise, the same scale every way: bulges and recesses, never flat sheets
  //   BLOCKS   Voronoi: each cell a low pillow, the cells' edges (F2 − F1 small) grooves — the wall in jointed blocks
  //   RUNNELS  RIDGED noise stretched up the wall: vertical erosion channels
  const ns = (R() * 1e6) | 0;
  const h3 = (i, j, k, o = 0) => { let q = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1103515245) ^ (ns + o * 7919); q = Math.imul(q ^ (q >>> 13), 1274126177); return ((q ^ (q >>> 16)) >>> 0) / 4294967296; };
  const vn3 = (x, y, z, o = 0) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz), L = (A, B, t) => A + (B - A) * t;
    return L(L(L(h3(i, j, k, o), h3(i + 1, j, k, o), u), L(h3(i, j + 1, k, o), h3(i + 1, j + 1, k, o), u), v),
             L(L(h3(i, j, k + 1, o), h3(i + 1, j, k + 1, o), u), L(h3(i, j + 1, k + 1, o), h3(i + 1, j + 1, k + 1, o), u), v), w);
  };
  const fbm = (x, y, z, o) => vn3(x, y, z, o) * 0.65 + vn3(x * 2.1, y * 2.1, z * 2.1, o + 1) * 0.35;
  // the cells: jittered points on a lattice (wider than tall: sandstone blocks), F1 and F2 to the nearest two
  const voronoi = (x, y, z) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    let f1 = 9, f2 = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const ci = i + a, cj = j + b, ck = k + c;
      const dx = ci + h3(ci, cj, ck, 11) - x, dy = cj + h3(ci, cj, ck, 12) - y, dz = ck + h3(ci, cj, ck, 13) - z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return [f1, f2];
  };
  const rel = typeof p.relief === "object" ? p.relief : { lumps: (p.relief ?? 0) * 3, blocks: 0, runnels: 0 };
  const S = 1.6 + m * 0.35, B = 1.1 + m * 0.18;                               // the lumps' and the blocks' sizes (m)
  const relief = (x, y, z) => {
    let d = 0;
    if (rel.lumps > 0) {
      const X = x / S, Y = y / S, Z = z / S;
      const wx = fbm(X * 0.7, Y * 0.7, Z * 0.7, 21) - 0.5, wy = fbm(X * 0.7 + 5.2, Y * 0.7, Z * 0.7, 22) - 0.5, wz = fbm(X * 0.7, Y * 0.7 + 9.1, Z * 0.7, 23) - 0.5;
      d += (fbm(X + wx * 1.6, Y + wy * 1.6, Z + wz * 1.6, 24) - 0.5) * 2 * rel.lumps * m * 0.22;
    }
    if (rel.blocks > 0) {
      const [f1, f2] = voronoi(x / (B * 1.4), y / B, z / (B * 1.4));
      const groove = 1 - Math.min(1, (f2 - f1) / 0.22), g = groove * groove * (3 - 2 * groove);
      d += (g * 0.8 + f1 * 0.35) * rel.blocks * m * 0.12;
    }
    if (rel.runnels > 0) {
      const r1 = 1 - Math.abs(2 * vn3(x / 1.3, y / 6, z / 1.3, 31) - 1), r2 = 1 - Math.abs(2 * vn3(x / 0.6, y / 3, z / 0.6, 32) - 1);
      d += (Math.pow(r1, 4) * 0.7 + Math.pow(r2, 4) * 0.3) * rel.runnels * m * 0.1;
    }
    return d;
  };
  const inset = (y, j) => {
    let d = 0;
    if (y > h - lipR) { const q = y - (h - lipR); d += lipR - Math.sqrt(Math.max(0, lipR * lipR - q * q)); }   // the lip
    const uh = h * 0.45;
    if (y < uh) d += (p.undercut ?? 0) * m * 0.35 * (1 - y / uh) ** 2;                                        // the foot
    // the bands: the set-back of the band this row is in, eased across each step's ±eps
    let b = 0; while (b < nb && y > bandY[b] + eps) b++;
    let bd = bandD[b];
    if (b < nb && y > bandY[b] - eps) { const t = (y - (bandY[b] - eps)) / (2 * eps), s = t * t * (3 - 2 * t); bd = bandD[b] + (bandD[b + 1] - bandD[b]) * s; }
    d += bd;
    // the OVERHANG (a cliff's): the top course standing out over the wall below
    if (p.overhang) { const y0 = h * 0.84, y1 = h - lipR; if (y > y0) d -= p.overhang * m * Math.min(1, (y - y0) / Math.max(0.05, (y1 - y0) * 0.35)); }   // (a LEDGE under the top: a hump made the wall a barrel)
    // the relief, at this point of the wall, faded out near the lip and the foot
    const fade = Math.min(1, Math.max(0, (h - lipR - y) / 0.25)) * Math.min(1, y / 0.25), a = (j / N) * Math.PI * 2;
    d += relief(Math.cos(a) * plan[j], y, Math.sin(a) * plan[j]) * fade;
    return d;
  };
  // ── the mesh: rings, then the top's inner rings to a centre, the foot closed the same ──
  const pos = [], idx = [];
  const ring = (y, scale, insetFn) => { const start = pos.length / 3; for (let j = 0; j < N; j++) { const a = (j / N) * Math.PI * 2, r = Math.max(0.05, plan[j] * scale - insetFn(j)); pos.push(Math.cos(a) * r, y, Math.sin(a) * r); } return start; };
  const quads = (r0, r1, flip = false) => { for (let j = 0; j < N; j++) { const a = r0 + j, b = r0 + ((j + 1) % N), c = r1 + j, d = r1 + ((j + 1) % N); if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d); } };
  const wall = rows.map((y) => ring(y, 1, (j) => inset(y, j)));
  for (let i = 0; i + 1 < wall.length; i++) quads(wall[i], wall[i + 1]);
  // the top: inner rings at the lip's top, a little swell, shrinking in
  const swell = Array.from({ length: 3 }, () => ({ a: R() * Math.PI, k: (Math.PI * 2) / (3 + R() * 6), ph: R() * 6.28 }));
  const topY = (x, z) => h + swell.reduce((acc, s) => acc + Math.sin(x * Math.cos(s.a) * s.k + z * Math.sin(s.a) * s.k + s.ph), 0) * 0.025 * m * 0.3;
  let prev = wall[wall.length - 1];
  const lipIn = (j) => inset(h, j);
  for (const sc of [0.85, 0.66, 0.46, 0.26]) {
    const start = pos.length / 3;
    for (let j = 0; j < N; j++) { const a = (j / N) * Math.PI * 2, r = Math.max(0.05, (plan[j] - lipIn(j)) * sc); const x = Math.cos(a) * r, z = Math.sin(a) * r; pos.push(x, topY(x, z), z); }
    quads(prev, start); prev = start;
  }
  const top = pos.length / 3; pos.push(0, topY(0, 0), 0);
  for (let j = 0; j < N; j++) idx.push(prev + j, top, prev + ((j + 1) % N));
  // the foot: one ring in, a centre (never seen — sunk)
  const foot = pos.length / 3; pos.push(0, 0, 0);
  for (let j = 0; j < N; j++) idx.push(wall[0] + j, wall[0] + ((j + 1) % N), foot);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  bakeRockShade(geo, { shadeBlur: 2 });
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  geo.userData.rock = { triangles: idx.length / 3, layered: true };
  return geo;
}

const _cache = new Map();
/** The memo (the composer rebuilds a piece on every change: the same params, the same geometry). Not to be mutated. */
export function layeredCached(p) {
  const key = JSON.stringify(p);
  let g = _cache.get(key);
  if (!g) { g = layeredGeometry(p); _cache.set(key, g); }
  return g;
}
