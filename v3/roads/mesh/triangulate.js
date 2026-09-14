// Polygon helpers for the 3D road mesh: tidy rings, offset them, triangulate.
//
// The engine's polygons come straight from construction, so they repeat
// points (a fillet that starts on the arm edge point, a circle whose last
// point is its first) and their winding depends on how they were built. Every
// consumer here goes through `ring()` first, and nothing downstream cares
// about winding: triangles are oriented by their normal when they are emitted.
//
// Plain JS on [x, z] pairs; earcut is the one vendored in three (no three.js
// import, so the mesh builder still runs headless in node).

import earcut from "three/src/extras/lib/earcut.js";
import { polygonArea, pointInPolygon } from "../roadMath.js";

const EPS = 1e-3;

/** Drop repeated points (and a closing duplicate). */
export function dedupe(pts, closed, eps = EPS) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > eps || Math.abs(q[1] - p[1]) > eps) out.push(p);
  }
  if (closed && out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) out.pop();
  }
  return out;
}

/** A closed ring ready to triangulate, or null when it has no area. */
export function ring(pts, minArea = 0.01) {
  const r = dedupe(pts, true);
  if (r.length < 3 || Math.abs(polygonArea(r)) < minArea) return null;
  return r;
}

/** Left normal of a direction, engine convention (+t is left). */
const leftOf = (dx, dz) => [dz, -dx];

function unit(dx, dz) {
  const l = Math.hypot(dx, dz);
  return l > 1e-12 ? [dx / l, dz / l] : [0, 0];
}

/**
 * Per-vertex miter vectors of a polyline, on its LEFT side: `p + m·d` is the
 * point offset a perpendicular distance `d` from both neighbouring segments.
 * Also returns each segment's left normal and whether the vertex is a crease.
 */
export function miters(pts, closed, crease = 0.6) {
  const n = pts.length;
  const segN = [];
  const segCount = closed ? n : n - 1;
  for (let k = 0; k < segCount; k++) {
    const a = pts[k], b = pts[(k + 1) % n];
    const [dx, dz] = unit(b[0] - a[0], b[1] - a[1]);
    segN.push(leftOf(dx, dz));
  }
  const m = new Array(n), creased = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const prev = closed ? segN[(i - 1 + segCount) % segCount] : segN[i - 1];
    const next = closed ? segN[i % segCount] : segN[i];
    if (!prev || !next) { m[i] = (prev || next).slice(); continue; }
    const dot = prev[0] * next[0] + prev[1] * next[1];
    creased[i] = dot < Math.cos(crease);
    const s = 1 / Math.max(0.25, 1 + dot);
    m[i] = [(prev[0] + next[0]) * s, (prev[1] + next[1]) * s];
  }
  return { m, segN, creased };
}

/** Offset a polyline `d` metres to its left (negative = right). */
export function offsetLeft(pts, closed, d) {
  const { m } = miters(pts, closed);
  return pts.map((p, i) => [p[0] + m[i][0] * d, p[1] + m[i][1] * d]);
}

/**
 * Which side of a boundary polyline the polygon's inside is: +1 left, −1 right.
 * Probes a few segment midpoints, so a sliver or a spike cannot flip it.
 */
export function insideSide(chain, poly) {
  let votes = 0;
  const n = chain.length;
  const step = Math.max(1, Math.floor((n - 1) / 5));
  for (let k = 0; k + 1 < n; k += step) {
    const a = chain[k], b = chain[k + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-4) continue;
    const [nx, nz] = leftOf((b[0] - a[0]) / len, (b[1] - a[1]) / len);
    const probe = Math.min(0.05, len * 0.25);
    const mx = (a[0] + b[0]) / 2 + nx * probe, mz = (a[1] + b[1]) / 2 + nz * probe;
    votes += pointInPolygon(mx, mz, poly) ? 1 : -1;
  }
  return votes >= 0 ? 1 : -1;
}

/** Triangles (index triples into the concatenated rings) for an outer ring + holes. */
export function triangulate(outer, holes = []) {
  const flat = [];
  const holeIdx = [];
  for (const p of outer) flat.push(p[0], p[1]);
  for (const h of holes) {
    holeIdx.push(flat.length / 2);
    for (const p of h) flat.push(p[0], p[1]);
  }
  const pts = [...outer, ...holes.flat()];
  return { pts, tris: earcut(flat, holeIdx.length ? holeIdx : null, 2) };
}
