// THE TUBE SECTION (PIECES.md §7c). User 2026-10-18: "make them better, we're missing nice pieces for
// funny tubes"; 2026-10-19: "best looking, smooth", "tubes should be tubes, no flat road", "the entrance
// shape looks cheap — make it a better shape", and an Apex Rush reference (bold shell, crisp white
// rims and seams, dark inside). One cross-section with a CLOSURE c, always CLOSED over the top:
//   c = 1  a round pipe, radius 8 m;
//   c = 0  the MOUTH: a wide oval portal (a "stadium": round sides, flat floor exactly the road's 16 m,
//          flat roof) whose floor continues the road — so a Tube in narrows smoothly from a portal
//          into the pipe, and a Tube out opens back out. No more curl.
// Drawn with the old kit's sweep (smooth-shaded) and the road material in tube mode; WHITE TRIM
// (rims at the ends, four seams along the shell) is a separate mesh on its own material.
import { q5 } from "./kit.js";

export const TUBE = {
  R: 8, // pipe radius (m)
  hw: 12, // the road's half width = the mouth's flat floor (kit.js SECTIONS.road.hw: 24 m since 2026-10-29)
  wall: 1.5, // shell thickness (user: 0.6 "looks too thin")
  N: 72, // points round the bore
  rim: 0.88, // a MOUTH's rim: caps the cut end of the wall (centred in it, a little proud of both faces)
  band: 0.5, // a JOINT's rim: a raised white band on the outside of the shell
  seam: 0.3, // radius of the white seams along the shell
  seams: [0.125, 0.375, 0.625, 0.875], // where round the outline (fractions from the top centre)
};

/**
 * The bore's inner outline at closure c: a closed loop from the TOP CENTRE, down the left, along the
 * floor (+x), up the right and back to the top — by arc length, so the point count never changes.
 * Returns [{x, y, nx, ny}] (n = outward normal), N + 1 points (the last on the first).
 */
export function boreOutline(c, N = TUBE.N) {
  const { R, hw } = TUBE;
  const w = 2 * hw * (1 - c); // the straight runs (floor and roof); 0 = a circle
  const P = 2 * Math.PI * R + 2 * w;
  const out = [];
  for (let k = 0; k <= N; k++) {
    let u = (P * k) / N; // distance round from the top centre
    let p;
    if (u < w / 2) p = { x: -u, y: 2 * R, nx: 0, ny: 1 }; // roof, going left
    else if ((u -= w / 2) < Math.PI * R) { // left half circle, top → bottom
      const a = Math.PI / 2 + u / R;
      p = { x: -w / 2 + Math.cos(a) * R, y: R + Math.sin(a) * R, nx: Math.cos(a), ny: Math.sin(a) };
    } else if ((u -= Math.PI * R) < w) p = { x: -w / 2 + u, y: 0, nx: 0, ny: -1 }; // floor, going right
    else if ((u -= w) < Math.PI * R) { // right half circle, bottom → top
      const a = -Math.PI / 2 + u / R;
      p = { x: w / 2 + Math.cos(a) * R, y: R + Math.sin(a) * R, nx: Math.cos(a), ny: Math.sin(a) };
    } else { u -= Math.PI * R; p = { x: w / 2 - u, y: 2 * R, nx: 0, ny: 1 }; } // roof, back to the centre
    out.push(p);
  }
  return out;
}

/** The sweep's section at closure c: the bore (zone 3), then the shell (zone 4) back round. */
export function tubeSection(c) {
  const { wall } = TUBE;
  const inner = boreOutline(c);
  const pts = inner.map((p) => ({ x: p.x, y: p.y, zone: 3, smooth: true }));
  for (let k = inner.length - 1; k >= 0; k--) {
    const p = inner[k];
    pts.push({ x: p.x + p.nx * wall, y: p.y + p.ny * wall, zone: 4, smooth: true });
  }
  // the loop starts and ends at the top centre: pair those coincident points so the ring shades round
  const n = inner.length;
  pts[0].seam = n - 1; pts[n - 1].seam = 0;
  pts[n].seam = 2 * n - 1; pts[2 * n - 1].seam = n;
  return { pts, hw: TUBE.hw };
}

/**
 * THE HALF-PIPE: an OPEN U — the road's flat floor (16 m) between two rounded walls (radius TUBE.R,
 * tangent to the floor) that rise to height k × R: k = 0 is the plain road, k = 1 two vertical 8 m
 * walls. From the LEFT LIP down, along the floor, up to the RIGHT LIP, by arc length (the point
 * count never changes, so a Half-pipe in can grow its walls along the piece).
 * Returns [{x, y, nx, ny}] (n = outward: away from the channel, into the shell).
 */
export function halfpipeOutline(k, N = TUBE.N) {
  const { R, hw } = TUBE;
  const phi = Math.acos(1 - Math.min(1, Math.max(0, k))); // the wall's arc (0 = no wall, π/2 = vertical)
  const arc = R * phi, P = 2 * arc + 2 * hw;
  const out = [];
  for (let i = 0; i <= N; i++) {
    let u = (P * i) / N;
    let p;
    if (u < arc) { // the left wall, lip → floor
      const a = phi - u / R;
      p = { x: -hw - Math.sin(a) * R, y: R - Math.cos(a) * R, nx: -Math.sin(a), ny: -Math.cos(a) };
    } else if ((u -= arc) < 2 * hw) p = { x: -hw + u, y: 0, nx: 0, ny: -1 }; // the floor
    else { // the right wall, floor → lip
      const a = Math.min(phi, (u - 2 * hw) / R);
      p = { x: hw + Math.sin(a) * R, y: R - Math.cos(a) * R, nx: Math.sin(a), ny: -Math.cos(a) };
    }
    out.push(p);
  }
  return out;
}

/** The half-pipe's sweep section: the channel (zone 3), then the shell (zone 4) back under it; the
 *  two lip faces close the loop (mixed zones: plain sides). */
export function halfpipeSection(k) {
  const inner = halfpipeOutline(k);
  const pts = inner.map((p) => ({ x: p.x, y: p.y, zone: 3, smooth: true }));
  for (let i = inner.length - 1; i >= 0; i--) {
    const p = inner[i];
    pts.push({ x: p.x + p.nx * TUBE.wall, y: p.y + p.ny * TUBE.wall, zone: 4, smooth: true });
  }
  return { pts, hw: TUBE.hw };
}

/** Wall height (0..1) along a half-pipe piece at s ∈ [0, L]: eased from `from` to `to`. */
export function wallAt(tile, s, L) {
  const { from = 1, to = 1 } = tile.halfpipe;
  return from + (to - from) * q5(Math.min(1, Math.max(0, s / L)));
}

/** Deck (channel + shell) and TRIM (a white rim along each lip) for a half-pipe piece. */
/**
 * `aRound` on a bore / half-pipe deck: where a point is ROUND the inside, 0 → 1 from the profile's start
 * (a tube: its top centre; a half-pipe: its left rim) — so the floor is 0.5 in both. The tube material
 * (tubeMaterial.js) lays its floor band, side strips and darker roof by it. Per ring (one `along` value),
 * the inner profile's length is the largest `across` of its zone-3 points.
 */
function addRound(deck, THREE) {
  const uv = deck.getAttribute("uv"), zone = deck.getAttribute("aZone"), n = uv.count;
  const span = new Map();
  const key = (i) => Math.round(uv.getX(i) * 1000);
  for (let i = 0; i < n; i++) if (Math.abs(zone.getX(i) - 3) < 0.5) span.set(key(i), Math.max(span.get(key(i)) ?? 0, uv.getY(i)));
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) { const P = span.get(key(i)); r[i] = P ? Math.min(1, Math.max(0, uv.getY(i) / P)) : 0.5; }
  deck.setAttribute("aRound", new THREE.Float32BufferAttribute(r, 1));
}

export function buildHalfpipeLook(tile, frames, sAt, L, { buildSweepGeometry, NO_CHECKER, THREE }) {
  const deck = buildSweepGeometry(frames, halfpipeSection(1), { profileAt: (_t, i) => halfpipeSection(wallAt(tile, sAt[i], L)) });
  const n = deck.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
  deck.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));
  addRound(deck, THREE);
  const place = (f, x, y) => f.pos.clone().addScaledVector(f.right, x).addScaledVector(f.up, y);
  // the lips: centred on the wall's cut edge, so the rim caps it
  const lip = (side) => frames.map((f, i) => {
    const o = halfpipeOutline(wallAt(tile, sAt[i], L));
    const p = side < 0 ? o[0] : o[o.length - 1];
    return place(f, p.x + p.nx * TUBE.wall / 2, p.y + p.ny * TUBE.wall / 2);
  });
  const rail = mergeGeos([sweepRound(THREE, lip(-1), TUBE.rim * 0.9, false, 10), sweepRound(THREE, lip(1), TUBE.rim * 0.9, false, 10)], THREE);
  return { deck, rail, railCollision: null, posts: null, trim: true };
}

/** Closure along a tube piece at s ∈ [0, L]: eased from `from` to `to`. */
export function closureAt(tile, s, L) {
  const { from = 1, to = 1 } = tile.tube;
  return from + (to - from) * q5(Math.min(1, Math.max(0, s / L)));
}

/** A small round tube swept along `path` ([Vector3], open or closed) — rims and seams. */
function sweepRound(THREE, path, r, closed, segs = 10) {
  const pos = [], nrm = [], idx = [];
  const n = path.length;
  const T = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), ref = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    T.subVectors(b, a).normalize();
    ref.set(0, 1, 0);
    if (Math.abs(T.dot(ref)) > 0.9) ref.set(1, 0, 0);
    A.crossVectors(T, ref).normalize(); B.crossVectors(T, A).normalize();
    for (let j = 0; j < segs; j++) {
      const t = (j / segs) * Math.PI * 2, cx = Math.cos(t), cy = Math.sin(t);
      const nx = A.x * cx + B.x * cy, ny = A.y * cx + B.y * cy, nz = A.z * cx + B.z * cy;
      pos.push(path[i].x + nx * r, path[i].y + ny * r, path[i].z + nz * r);
      nrm.push(nx, ny, nz);
    }
  }
  const rows = closed ? n : n - 1;
  for (let i = 0; i < rows; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < segs; j++) {
      const j2 = (j + 1) % segs;
      const a = i * segs + j, b = i * segs + j2, c = i2 * segs + j, d = i2 * segs + j2;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Deck (bore + shell) and TRIM (white rims + seams) for a tube piece. `frames` are the sweep frames
 * ({pos, tangent, up, right}) at distances `sAt` along the piece.
 * Rims: one at the piece's START (every joint gets exactly one — the next piece draws its own), and
 * one at its END when the end is a mouth (Tube out, roof drop, cannon).
 */
export function buildTubeLook(tile, frames, sAt, L, { buildSweepGeometry, NO_CHECKER, THREE }) {
  const deck = buildSweepGeometry(frames, tubeSection(1), { profileAt: (_t, i) => tubeSection(closureAt(tile, sAt[i], L)) });
  const n = deck.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
  deck.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));
  addRound(deck, THREE);

  // section point (x, y) at frame f → world (the deck frame: right, up)
  const place = (f, x, y) => f.pos.clone().addScaledVector(f.right, x).addScaledVector(f.up, y);
  const parts = [];
  const rimAt = (i, isMouth) => {
    const f = frames[i], c = closureAt(tile, sAt[i], L);
    // a mouth's rim sits on the end face, centred in the wall (it hides the wall's cut end); a joint's
    // sits ON the shell (centred in the wall it was swallowed whole)
    const off = isMouth ? TUBE.wall / 2 : TUBE.wall + 0.08;
    const loop = boreOutline(c, 96).slice(0, -1).map((p) => place(f, p.x + p.nx * off, p.y + p.ny * off));
    parts.push(sweepRound(THREE, loop, isMouth ? TUBE.rim : TUBE.band, true, 12));
  };
  rimAt(0, tile.tube.from === 0); // a Tube in starts at its mouth
  const mouth = tile.tube.to === 0 || tile.drop || tile.marks?.some((m) => m.kind === "lip");
  if (mouth) rimAt(frames.length - 1, true);
  // seams along the shell, at fixed places round the outline (they follow the mouth's oval too)
  for (const frac of TUBE.seams) {
    const path = frames.map((f, i) => {
      const o = boreOutline(closureAt(tile, sAt[i], L));
      const p = o[Math.round(frac * (o.length - 1))];
      return place(f, p.x + p.nx * (TUBE.wall + 0.05), p.y + p.ny * (TUBE.wall + 0.05));
    });
    parts.push(sweepRound(THREE, path, TUBE.seam, false, 6));
  }
  return { deck, rail: mergeGeos(parts, THREE), railCollision: null, posts: null, trim: true };
}

function mergeGeos(geos, THREE) {
  // tiny merge (position + normal, indexed) — keeps this file free of the addons import for Node tests
  const pos = [], nrm = [], idx = [];
  let base = 0;
  for (const g of geos) {
    const p = g.getAttribute("position"), nn = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nrm.push(nn.getX(i), nn.getY(i), nn.getZ(i)); }
    const ix = g.getIndex();
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  out.setIndex(idx);
  return out;
}
