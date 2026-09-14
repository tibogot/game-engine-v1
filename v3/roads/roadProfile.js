// Vertical profile: elevation along a road, designed separately from the plan
// view (civil engineering does it this way too — horizontal and vertical
// alignment are two independent problems).
//
// Modes:
//   terrain — follow the ground, but grade-limited to the road type's maximum
//             and smoothed, so a hill road is sane with zero authoring;
//   linear  — straight grade between the two node elevations;
//   design  — vertical PIs { u (0..1 along the road), y, L (curve length) } with
//             parabolic vertical curves, the textbook crest/sag form.
// Road ends always sit at their node's elevation, so junctions stay level.
//
// The result is a sampled table (≤ 4 m apart) — everything downstream
// interpolates it.

import { clamp } from "./roadMath.js";

const STEP = 4;

export function buildProfile(road, L, ends, groundAt, maxGrade) {
  const mode = road.profile?.mode || "terrain";
  const N = Math.max(2, Math.ceil(L / STEP) + 1);
  const s = new Float64Array(N);
  const y = new Float64Array(N);
  const g = new Float64Array(N);
  const ground = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    s[i] = (L * i) / (N - 1);
    ground[i] = groundAt(s[i]);
  }
  const ya = ends.ya, yb = ends.yb;
  const issues = [];

  if (mode === "linear") {
    for (let i = 0; i < N; i++) y[i] = ya + ((yb - ya) * s[i]) / Math.max(L, 1e-6);
  } else if (mode === "design") {
    const vpis = [{ s: 0, y: ya, L: 0 }];
    for (const v of (road.profile?.vpis || []).slice().sort((p, q) => p.u - q.u)) {
      vpis.push({ s: clamp(v.u, 0.001, 0.999) * L, y: v.y, L: Math.max(0, v.L ?? 40) });
    }
    vpis.push({ s: L, y: yb, L: 0 });
    // Clamp curve lengths so neighbouring curves never overlap.
    for (let i = 1; i < vpis.length - 1; i++) {
      const room = Math.min(vpis[i].s - vpis[i - 1].s, vpis[i + 1].s - vpis[i].s);
      vpis[i].L = Math.min(vpis[i].L, room);
    }
    for (let i = 0; i < N; i++) y[i] = designElevation(vpis, s[i]);
  } else {
    const gmax = maxGrade * 0.92;
    for (let i = 0; i < N; i++) y[i] = ground[i];
    y[0] = ya; y[N - 1] = yb;
    const ds = L / (N - 1);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i < N - 1; i++) y[i] = clamp(y[i], y[i - 1] - gmax * ds, y[i - 1] + gmax * ds);
      for (let i = N - 2; i > 0; i--) y[i] = clamp(y[i], y[i + 1] - gmax * ds, y[i + 1] + gmax * ds);
      // Smooth (≈ vertical curves), ends pinned.
      const tmp = Float64Array.from(y);
      for (let i = 1; i < N - 1; i++) tmp[i] = (y[i - 1] + 2 * y[i] + y[i + 1]) / 4;
      for (let i = 1; i < N - 1; i++) y[i] = tmp[i];
    }
  }

  let maxG = 0, maxGs = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1);
    g[i] = (y[b] - y[a]) / Math.max(1e-6, s[b] - s[a]);
    if (Math.abs(g[i]) > Math.abs(maxG)) { maxG = g[i]; maxGs = s[i]; }
  }
  if (Math.abs(maxG) > maxGrade + 0.005) {
    issues.push({
      level: "warn", code: "grade",
      msg: `Grade ${(Math.abs(maxG) * 100).toFixed(1)} % exceeds ${(maxGrade * 100).toFixed(0)} % for this road type`,
      s: maxGs,
    });
  }
  return { mode, s, y, g, ground, maxGrade: maxG, issues };
}

function designElevation(vpis, x) {
  // Tangent grades between VPIs, then parabolas around each interior VPI.
  let i = 0;
  while (i < vpis.length - 2 && x > vpis[i + 1].s) i++;
  const grade = (k) => (vpis[k + 1].y - vpis[k].y) / Math.max(1e-6, vpis[k + 1].s - vpis[k].s);
  let yv = vpis[i].y + grade(i) * (x - vpis[i].s);
  for (let k = 1; k < vpis.length - 1; k++) {
    const v = vpis[k];
    const half = v.L / 2;
    if (half <= 0 || x < v.s - half || x > v.s + half) continue;
    const g1 = grade(k - 1), g2 = grade(k);
    const bvc = v.s - half;
    const yb = v.y - g1 * half;
    const dx = x - bvc;
    return yb + g1 * dx + ((g2 - g1) / (2 * v.L)) * dx * dx;
  }
  return yv;
}

/** Linear interpolation of a profile table. */
export function profileAt(prof, st) {
  const s = prof.s, N = s.length;
  if (st <= s[0]) return { y: prof.y[0], g: prof.g[0], ground: prof.ground[0] };
  if (st >= s[N - 1]) return { y: prof.y[N - 1], g: prof.g[N - 1], ground: prof.ground[N - 1] };
  const f = (st / s[N - 1]) * (N - 1);
  const i = Math.min(N - 2, Math.floor(f));
  const t = f - i;
  return {
    y: prof.y[i] + (prof.y[i + 1] - prof.y[i]) * t,
    g: prof.g[i] + (prof.g[i + 1] - prof.g[i]) * t,
    ground: prof.ground[i] + (prof.ground[i + 1] - prof.ground[i]) * t,
  };
}

/**
 * Design checks for a horizontal curve.
 * Minimum radius from e + f = V² / (127 R); superelevation distributed
 * proportionally (e = eMax · Rmin / R, capped).
 */
export function curveDesign(speedKmh, R, urban) {
  const eMax = urban ? 0.04 : 0.08;
  const f = Math.max(0.1, 0.22 - speedKmh / 1000);
  const Rmin = (speedKmh * speedKmh) / (127 * (eMax + f));
  const e = R > 1e-6 ? Math.min(eMax, (eMax * Rmin) / R) : eMax;
  return { Rmin, e, eMax };
}

/** Default transition-spiral length (Barnett/Short formula, C = 0.6 m/s³). */
export function defaultSpiral(speedKmh, R) {
  if (R <= 0) return 0;
  return clamp((0.0214 * speedKmh ** 3) / (R * 0.6), 15, 140);
}
