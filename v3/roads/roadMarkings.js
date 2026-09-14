// Road markings derived from the lane stack.
//
// Nothing here is authored: a boundary's paint follows from the two lane types
// on either side of it (driving|driving → dashed lane line, driving|bike →
// wide solid, carriage|sidewalk → curb, opposing directions → centre line...).
// Change a lane and the paint follows; add a pocket and its solid line appears.
//
// Styles: 'eu' (all white; dashed centre on minor roads, solid on major) and
// 'us' (double-yellow centre, yellow left edge on one-way carriageways).

import { LANE_TYPES } from "./roadCrossSection.js";

const T = (t) => LANE_TYPES[t] || {};

/** Kind of the boundary between an inner lane A and the next present outer lane B (same side). */
export function boundaryKind(a, b) {
  const ta = T(a.type), tb = b ? T(b.type) : null;
  if (!b) return ta.carriage ? "edge" : null;
  if (ta.carriage && tb.roadside) return a.type === "shoulder" ? "paveEdge" : "curb";
  if (ta.roadside) return null;
  if (ta.drive && tb.drive) return a.type === "turn" || b.type === "turn" ? "solid" : a.type === "bus" || b.type === "bus" ? "busLine" : "lane";
  if (ta.drive && b.type === "parking") return "parking";
  if (ta.drive && b.type === "bike") return "bike";
  if (ta.drive && b.type === "shoulder") return "edge";
  if (a.type === "bike" && b.type === "parking") return "solidThin";
  if (a.type === "parking" && b.type === "bike") return "solidThin";
  return null;
}

/** Centre boundary between innermost present lanes on each side (centre strip narrow). */
export function centerKind(aL, aR, centerStrip) {
  if (centerStrip === "none") return null;
  const dl = aL && T(aL.type).drive, dr = aR && T(aR.type).drive;
  if (dl && dr) return "center";
  if (dl || dr) {
    const other = dl ? aR : aL;
    if (other && T(other.type).carriage) return "leftEdge";
    return other ? "curb" : "leftEdge";
  }
  return null;
}

/** Visual style for a kind → { color, width, dash, double, gap } or null (not paint). */
export function markingStyle(kind, style, rank) {
  const us = style === "us";
  const hw = rank >= 5;
  switch (kind) {
    case "lane": return { color: "white", width: hw ? 0.15 : 0.12, dash: hw ? [6, 12] : us ? [3, 9] : [3, 5] };
    case "center":
      if (us) return { color: "yellow", width: 0.12, double: true, gap: 0.12 };
      return rank >= 3 ? { color: "white", width: 0.15 } : { color: "white", width: 0.12, dash: [3, 5] };
    case "leftEdge": return { color: us ? "yellow" : "white", width: hw ? 0.25 : 0.15 };
    case "edge": return { color: "white", width: hw ? 0.25 : 0.15 };
    case "solid": return { color: "white", width: 0.15 };
    case "busLine": return { color: "white", width: 0.3 };
    case "bike": return { color: "white", width: 0.25 };
    case "parking": return { color: "white", width: 0.1, dash: us ? null : [1.5, 1.5] };
    case "solidThin": return { color: "white", width: 0.1 };
    case "medianEdge": return { color: us ? "yellow" : "white", width: 0.15 };
    default: return null;
  }
}

/** Kinds that stop at stop lines / crosswalks at every junction. */
export const INTERRUPTED = new Set(["lane", "center", "solid", "busLine", "parking"]);

/**
 * Kinds that run on to the junction mouth — EXCEPT across a crosswalk, where
 * real roads break them: a bike or edge line never runs through zebra bars.
 * They stop where the interrupted kinds stop, but only at an end with a crossing.
 */
export const CROSSING_INTERRUPTED = new Set(["edge", "leftEdge", "bike", "solidThin", "medianEdge"]);

/**
 * Build marking/curb polylines for one road.
 * smp: alignment samples, lays: layout per sample, markRange: [s0, s1] where
 * interrupted kinds may exist, walkRange: [s0, s1] where crossing-interrupted
 * kinds may exist (defaults to the whole road).
 */
export function buildRoadMarkings(rr, smp, lays, style, markRange, walkRange = null) {
  const lines = [];
  const curbs = [];
  const N = smp.s.length;
  const rank = rr.type.rank;
  const nx = (i) => Math.sin(smp.th[i]), nz = (i) => -Math.cos(smp.th[i]);
  const P = (i, t) => [smp.x[i] + nx(i) * t, smp.z[i] + nz(i) * t];

  // A boundary track = function(i) → { kind, t } | null. Emits runs of equal kind.
  const emit = (fn) => {
    let run = null;
    const flush = () => {
      if (run && run.pts.length >= 2) {
        if (run.kind === "curb" || run.kind === "paveEdge") curbs.push({ kind: run.kind, pts: run.pts });
        else {
          const st = markingStyle(run.kind, style, rank);
          if (st) {
            if (st.double) {
              const off = st.width / 2 + st.gap / 2;
              lines.push({ kind: "line", pts: run.tPts.map(([i, t]) => P(i, t + off)), width: st.width, color: st.color, dash: st.dash || null });
              lines.push({ kind: "line", pts: run.tPts.map(([i, t]) => P(i, t - off)), width: st.width, color: st.color, dash: st.dash || null });
            } else {
              lines.push({ kind: "line", pts: run.pts, width: st.width, color: st.color, dash: st.dash || null, mark: run.kind });
            }
          }
        }
      }
      run = null;
    };
    for (let i = 0; i < N; i++) {
      let r = fn(i);
      if (r && INTERRUPTED.has(r.kind) && (smp.s[i] < markRange[0] - 1e-6 || smp.s[i] > markRange[1] + 1e-6)) r = null;
      if (r && walkRange && CROSSING_INTERRUPTED.has(r.kind) && (smp.s[i] < walkRange[0] - 1e-6 || smp.s[i] > walkRange[1] + 1e-6)) r = null;
      if (!r) { flush(); continue; }
      if (run && run.kind !== r.kind) {
        // Close the old run on this sample so the two runs meet without a gap.
        run.pts.push(P(i, r.t)); run.tPts.push([i, r.t]);
        flush();
      }
      if (!run) run = { kind: r.kind, pts: [], tPts: [] };
      run.pts.push(P(i, r.t));
      run.tPts.push([i, r.t]);
    }
    flush();
  };

  for (const side of ["left", "right"]) {
    const m = rr.stack.sides[side].length;
    for (let b = 0; b < m; b++) {
      emit((i) => {
        const L = lays[i][side];
        const a = L[b];
        if (!a.present) return null;
        let next = null;
        for (let k = b + 1; k < m; k++) if (L[k].present) { next = L[k]; break; }
        const kind = boundaryKind(a, next);
        return kind ? { kind, t: a.tOut } : null;
      });
    }
  }

  // Centre.
  const firstPresent = (arr) => arr.find((l) => l.present) || null;
  const cKind = rr.stack.center.kind;
  emit((i) => {
    const lay = lays[i];
    if (lay.cw >= 0.3) return null;
    const aL = firstPresent(lay.left), aR = firstPresent(lay.right);
    const kind = centerKind(aL, aR, cKind);
    if (!kind) return null;
    const tl = aL ? aL.tIn : lay.cw / 2, tr = aR ? aR.tIn : -lay.cw / 2;
    return { kind, t: (tl + tr) / 2 };
  });
  for (const side of ["left", "right"]) {
    emit((i) => {
      const lay = lays[i];
      if (lay.cw < 0.3) return null;
      const a = firstPresent(lay[side]);
      const t = a ? a.tIn : (side === "left" ? lay.cw / 2 : -lay.cw / 2);
      if (cKind === "raised") return { kind: "curb", t };
      if (cKind === "barrier") return { kind: "edge", t };
      return { kind: "medianEdge", t };
    });
  }

  // Parking bays: short ticks across parking lanes.
  for (const side of ["left", "right"]) {
    const lanes = rr.stack.sides[side];
    lanes.forEach((lane, b) => {
      if (lane.type !== "parking") return;
      const stall = 6.0;
      let next = Math.ceil((markRange[0] + 2) / stall) * stall;
      for (let i = 1; i < N; i++) {
        while (next <= smp.s[i] && next < markRange[1] - 4) {
          const f = (next - smp.s[i - 1]) / Math.max(1e-6, smp.s[i] - smp.s[i - 1]);
          const l0 = lays[i - 1][side][b], l1 = lays[i][side][b];
          const w = l0.w + (l1.w - l0.w) * f;
          if (w > 1.5) {
            const x = smp.x[i - 1] + (smp.x[i] - smp.x[i - 1]) * f;
            const z = smp.z[i - 1] + (smp.z[i] - smp.z[i - 1]) * f;
            const th = smp.th[i - 1] + (smp.th[i] - smp.th[i - 1]) * f;
            const tIn = l0.tIn + (l1.tIn - l0.tIn) * f, tOut = l0.tOut + (l1.tOut - l0.tOut) * f;
            const sx = Math.sin(th), sz = -Math.cos(th);
            lines.push({ kind: "line", pts: [[x + sx * tIn, z + sz * tIn], [x + sx * tOut, z + sz * tOut]], width: 0.1, color: "white", dash: null });
          }
          next += stall;
        }
      }
    });
  }
  return { lines, curbs };
}
