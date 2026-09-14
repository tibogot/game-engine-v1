// Horizontal alignment: the plan-view centre line of one road.
//
// Authored the way road engineers author it — a polyline of points of
// intersection (PIs), each with a curve radius R and an optional transition
// spiral length Ls. Every PI becomes spiral → arc → spiral between straight
// tangents, so the line is tangent-continuous BY CONSTRUCTION (a Bézier bend is
// not), and curvature is continuous too when spirals are on.
//
// All three segment kinds are one family: curvature linear in arc length,
// k(u) = k0 + (k1 − k0)·u/len. A line has k0 = k1 = 0, an arc k0 = k1 = ±1/R,
// a spiral ramps between them. Lines and arcs evaluate in closed form; spirals
// integrate with 5-point Gauss–Legendre on ≤ 4 m panels (θ is quadratic in u,
// so that is exact to well under a millimetre).

import { wrapPi, clamp } from "./roadMath.js";

const GL_X = [-0.9061798459386640, -0.5384693101056831, 0, 0.5384693101056831, 0.9061798459386640];
const GL_W = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];

function segTheta(seg, u) {
  return seg.h0 + seg.k0 * u + ((seg.k1 - seg.k0) * u * u) / (2 * seg.len || 1);
}

/** Position on a segment at local arc length u. */
function segPos(seg, u) {
  const { x0, z0, h0, k0, k1, len } = seg;
  if (Math.abs(k1 - k0) < 1e-12) {
    if (Math.abs(k0) < 1e-9) return [x0 + Math.cos(h0) * u, z0 + Math.sin(h0) * u];
    const h = h0 + k0 * u;
    return [x0 + (Math.sin(h) - Math.sin(h0)) / k0, z0 - (Math.cos(h) - Math.cos(h0)) / k0];
  }
  const panels = Math.max(1, Math.ceil(u / 4));
  const w = u / panels;
  let x = x0, z = z0;
  for (let p = 0; p < panels; p++) {
    const a = p * w;
    for (let g = 0; g < 5; g++) {
      const uu = a + (GL_X[g] + 1) * 0.5 * w;
      const th = h0 + k0 * uu + ((k1 - k0) * uu * uu) / (2 * len);
      x += Math.cos(th) * GL_W[g] * 0.5 * w;
      z += Math.sin(th) * GL_W[g] * 0.5 * w;
    }
  }
  return [x, z];
}

/** Local end point of a unit-radius spiral of length lsOverR (curvature 0 → 1). */
function unitSpiralEnd(lsOverR) {
  const seg = { x0: 0, z0: 0, h0: 0, k0: 0, k1: 1, len: lsOverR };
  return segPos(seg, lsOverR);
}

/** Tangent length of a spiral–arc–spiral curve at R = 1 (scales linearly with R). */
function unitTangent(delta, lsOverR) {
  const ad = Math.abs(delta);
  if (lsOverR <= 1e-9) return Math.tan(ad / 2);
  const ts = lsOverR / 2;
  const [xs, ys] = unitSpiralEnd(lsOverR);
  const p = ys - (1 - Math.cos(ts));
  const k = xs - Math.sin(ts);
  return (1 + p) * Math.tan(ad / 2) + k;
}

/**
 * Fit an alignment through vertices.
 * @param {Array<{x:number,z:number,r?:number,ls?:number,virtual?:boolean}>} verts
 *   first and last are the road ends; the rest are PIs.
 * @param {object} o
 *   startDir/endDir — optional forced headings at the ends (travel direction);
 *   defaultRadius, spiralFor(R, |Δ|) → Ls, leadStart/leadEnd — minimum straight
 *   run kept at each end (junction mouths must be straight).
 */
export function fitAlignment(verts, o = {}) {
  const issues = [];
  const defaultRadius = o.defaultRadius ?? 40;
  const V = alignmentVertices(verts, o);
  return fitVertices(V, o, issues, defaultRadius);
}

/**
 * The vertex polyline a fit will actually use: duplicates dropped and forced
 * end headings turned into virtual PIs. Its first and last legs ARE the
 * road's headings at its ends — junction geometry must be built from these,
 * not from the authored points (a virtual PI turns the far end too).
 */
export function alignmentVertices(verts, o = {}) {
  let V = [];
  for (const v of verts) {
    const q = V[V.length - 1];
    if (q && Math.hypot(v.x - q.x, v.z - q.z) < 0.05) continue;
    V.push({ ...v });
  }
  if (V.length < 2) {
    const p = V[0] || { x: 0, z: 0 };
    V = [p, { x: p.x + 0.1, z: p.z }];
  }

  // Forced end headings become virtual PIs a short lead away from the end.
  if (o.startDir != null) {
    const a = V[0], b = V[1];
    const D = Math.hypot(b.x - a.x, b.z - a.z);
    const lead = clamp(D * 0.38, 0.5, 80);
    const dx = Math.cos(o.startDir), dz = Math.sin(o.startDir);
    const vx = a.x + dx * lead, vz = a.z + dz * lead;
    const legDir = Math.atan2(b.z - a.z, b.x - a.x);
    if (Math.abs(wrapPi(legDir - o.startDir)) > 1e-4) V.splice(1, 0, { x: vx, z: vz, virtual: true });
  }
  if (o.endDir != null) {
    const n = V.length;
    const a = V[n - 2], b = V[n - 1];
    const D = Math.hypot(b.x - a.x, b.z - a.z);
    const lead = clamp(D * 0.38, 0.5, 80);
    const dx = Math.cos(o.endDir), dz = Math.sin(o.endDir);
    const legDir = Math.atan2(b.z - a.z, b.x - a.x);
    if (Math.abs(wrapPi(legDir - o.endDir)) > 1e-4) V.splice(n - 1, 0, { x: b.x - dx * lead, z: b.z - dz * lead, virtual: true });
  }
  return V;
}

function fitVertices(V, o, issues, defaultRadius) {
  const n = V.length;
  const legLen = [], legDir = [];
  for (let i = 0; i < n - 1; i++) {
    legLen.push(Math.hypot(V[i + 1].x - V[i].x, V[i + 1].z - V[i].z));
    legDir.push(Math.atan2(V[i + 1].z - V[i].z, V[i + 1].x - V[i].x));
  }

  const curve = new Array(n).fill(null);
  for (let i = 1; i < n - 1; i++) {
    const delta = wrapPi(legDir[i] - legDir[i - 1]);
    if (Math.abs(delta) < 1e-5) continue;
    if (Math.abs(delta) > Math.PI - 0.035) {
      issues.push({ level: "warn", code: "pi-reversal", msg: "A bend turns back on itself — move the point", x: V[i].x, z: V[i].z });
      continue;
    }
    let R = Math.max(0.5, V[i].r ?? defaultRadius);
    let Ls = V[i].ls ?? (o.spiralFor ? o.spiralFor(R, Math.abs(delta)) : 0);
    Ls = clamp(Ls, 0, R * Math.abs(delta) * 0.999);
    const unitT = unitTangent(delta, Ls / R);
    curve[i] = { i, delta, R, Ls, lsOverR: Ls / R, unitT, T: unitT * R, scale: 1, requestedR: R };
  }

  // Shrink radii (keeping Ls/R) until every leg holds both tangents plus leads.
  const reserve = (legIdx) => (legIdx === 0 ? o.leadStart || 0 : 0) + (legIdx === n - 2 ? o.leadEnd || 0 : 0);
  for (let it = 0; it < 10; it++) {
    let changed = false;
    for (let j = 0; j < n - 1; j++) {
      const ca = curve[j], cb = curve[j + 1];
      const need = (ca ? ca.T : 0) + (cb ? cb.T : 0);
      if (need <= 1e-9) continue;
      const avail = Math.max(0.01, legLen[j] - reserve(j));
      if (need > avail + 1e-9) {
        const f = avail / need;
        for (const c of [ca, cb]) {
          if (!c) continue;
          c.R *= f; c.Ls *= f; c.T *= f;
        }
        changed = true;
      }
    }
    if (!changed) break;
  }

  const segments = [];
  const vertices = [];
  let s = 0;
  let cx = V[0].x, cz = V[0].z, ch = legDir[0];
  const pushSeg = (len, k0, k1, type) => {
    if (len <= 1e-6) return;
    const seg = { type, s0: s, len, x0: cx, z0: cz, h0: ch, k0, k1 };
    segments.push(seg);
    const [x, z] = segPos(seg, len);
    cx = x; cz = z; ch = segTheta(seg, len);
    s += len;
  };

  for (let i = 1; i < n - 1; i++) {
    const c = curve[i];
    if (!c) continue;
    const dx = Math.cos(ch), dz = Math.sin(ch);
    const tsx = V[i].x - Math.cos(legDir[i - 1]) * c.T;
    const tsz = V[i].z - Math.sin(legDir[i - 1]) * c.T;
    const lineLen = Math.max(0, (tsx - cx) * dx + (tsz - cz) * dz);
    pushSeg(lineLen, 0, 0, "line");
    const sTS = s;
    const kk = Math.sign(c.delta) / c.R;
    const arcLen = Math.max(0, c.R * Math.abs(c.delta) - c.Ls);
    pushSeg(c.Ls, 0, kk, "spiral");
    pushSeg(arcLen, kk, kk, "arc");
    pushSeg(c.Ls, kk, 0, "spiral");
    // Snap the heading exactly onto the next tangent (removes float creep).
    ch = legDir[i];
    const clamped = c.R < c.requestedR * 0.995;
    vertices.push({
      index: i, virtual: !!V[i].virtual, x: V[i].x, z: V[i].z,
      R: c.R, Ls: c.Ls, T: c.T, delta: c.delta, clamped, requestedR: c.requestedR,
      sTS, sST: s,
    });
    if (clamped && !V[i].virtual) {
      issues.push({
        level: "info", code: "radius-clamped",
        msg: `Bend radius cut from ${c.requestedR.toFixed(0)} m to ${c.R.toFixed(0)} m to fit between points`,
        x: V[i].x, z: V[i].z,
      });
    }
  }
  {
    const last = V[n - 1];
    const dx = Math.cos(ch), dz = Math.sin(ch);
    const lineLen = Math.max(0, (last.x - cx) * dx + (last.z - cz) * dz);
    pushSeg(lineLen, 0, 0, "line");
  }
  if (!segments.length) {
    segments.push({ type: "line", s0: 0, len: 0.01, x0: V[0].x, z0: V[0].z, h0: legDir[0], k0: 0, k1: 0 });
    s = 0.01;
  }

  return {
    segments,
    length: s,
    vertices,
    startHeading: segments[0].h0,
    endHeading: ch,
    endError: Math.hypot(cx - V[n - 1].x, cz - V[n - 1].z),
    issues,
  };
}

function findSeg(al, s) {
  const segs = al.segments;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].s0 <= s) lo = mid; else hi = mid - 1;
  }
  return segs[lo];
}

/** { x, z, th, k } at station s (clamped to the alignment). */
export function evalAlignment(al, s) {
  s = clamp(s, 0, al.length);
  const seg = findSeg(al, s);
  const u = clamp(s - seg.s0, 0, seg.len);
  const [x, z] = segPos(seg, u);
  return { x, z, th: segTheta(seg, u), k: seg.k0 + ((seg.k1 - seg.k0) * u) / (seg.len || 1) };
}

/**
 * Sample [s0, s1] with segment boundaries kept exactly and extra `breaks`
 * inserted. Curved stretches are sampled finely enough that no step turns
 * more than maxAngle.
 */
export function sampleAlignment(al, s0, s1, o = {}) {
  const maxStep = o.maxStep ?? 8;
  const maxAngle = o.maxAngle ?? 0.035;
  s0 = clamp(s0, 0, al.length);
  s1 = clamp(s1, s0, al.length);
  const stations = [s0];
  for (const seg of al.segments) {
    const a = Math.max(s0, seg.s0), b = Math.min(s1, seg.s0 + seg.len);
    if (b <= a) continue;
    const kmax = Math.max(Math.abs(seg.k0), Math.abs(seg.k1));
    const step = kmax > 1e-9 ? Math.min(maxStep, maxAngle / kmax) : maxStep;
    const cnt = Math.max(1, Math.ceil((b - a) / step));
    for (let i = 1; i <= cnt; i++) stations.push(a + ((b - a) * i) / cnt);
  }
  if (o.breaks) for (const b of o.breaks) if (b > s0 && b < s1) stations.push(b);
  stations.sort((p, q) => p - q);
  const S = [];
  for (const v of stations) if (!S.length || v - S[S.length - 1] > 1e-4) S.push(v);
  if (S.length === 1) S.push(Math.min(al.length, s0 + 1e-3));

  const N = S.length;
  const out = { s: new Float64Array(N), x: new Float64Array(N), z: new Float64Array(N), th: new Float64Array(N), k: new Float64Array(N) };
  for (let i = 0; i < N; i++) {
    const e = evalAlignment(al, S[i]);
    out.s[i] = S[i]; out.x[i] = e.x; out.z[i] = e.z; out.th[i] = e.th; out.k[i] = e.k;
  }
  return out;
}

/** Nearest station to (x, z), refined from a coarse sample. */
export function projectToAlignment(al, x, z, samples) {
  const smp = samples || sampleAlignment(al, 0, al.length, { maxStep: 4 });
  let best = Infinity, bestS = 0;
  for (let i = 1; i < smp.s.length; i++) {
    const ax = smp.x[i - 1], az = smp.z[i - 1], bx = smp.x[i], bz = smp.z[i];
    const abx = bx - ax, abz = bz - az;
    const l2 = abx * abx + abz * abz;
    let t = l2 > 0 ? ((x - ax) * abx + (z - az) * abz) / l2 : 0;
    t = clamp(t, 0, 1);
    const fx = ax + abx * t - x, fz = az + abz * t - z;
    const d2 = fx * fx + fz * fz;
    if (d2 < best) { best = d2; bestS = smp.s[i - 1] + (smp.s[i] - smp.s[i - 1]) * t; }
  }
  const e = evalAlignment(al, bestS);
  const t = (x - e.x) * Math.sin(e.th) - (z - e.z) * Math.cos(e.th);
  return { s: bestS, dist: Math.sqrt(best), t };
}
