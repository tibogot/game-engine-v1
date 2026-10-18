// THE TUBE SECTION (PIECES.md §7c, user 2026-10-18: "make them better, we're missing nice pieces for
// funny tubes"; 2026-10-19: "the best looking tube pieces, best looking entrance and exit, smooth not
// low poly flat faces"). One cross-section with a CLOSURE c: 0 = the flat 16 m road, 1 = a closed
// pipe of radius 8 m; in between the road's sides curl up into a U. A tube piece carries
// `tube: {from, to}` and the closure eases along it (Tube in 0→1, Tube out 1→0, the pipe pieces
// 1→1), so every tube piece meets the road and the other tubes exactly. Drawn with the old kit's
// sweep and its road material in TUBE mode (lit rings inside), in Thunderline's colours.
import { q5 } from "./kit.js";

export const TUBE = {
  R: 8, // bore radius (m)
  hw: 8, // the road's half width (the flat section at c = 0)
  wall: 1.5, // shell thickness (user: 0.6 "looks too thin")
  floor: 12, // the middle run of points at the bottom of the bore (m) — same surface as the walls
  NF: 16, // points across the floor band
  NS: 18, // points up each wall
  NL: 6, // steps round each rounded lip (even: the crest gets a doubled point)
};

/**
 * The section at closure c, as the old sweep wants it (a closed outline of {x, y, zone, smooth}):
 *   inner surface: left lip → left wall → bottom → right wall → right lip, ALL bore (zone 3): a tube is
 *   round inside, no road down its floor (user, 2026-10-19)
 *   right lip: a half round from the inner surface to the shell (rounded, not a cut end)
 *   outer shell back to the left, then the left lip's half round home.
 * Points are spread by ARC LENGTH, so the count never changes (the sweep morphs point by point) and
 * no edge collapses. Every point is SMOOTH (the surfaces are tangent-continuous all the way round,
 * lips included) — the sweep's flat facets were what read as low-poly. The floor/wall boundary is a
 * doubled point so the zone changes on a zero-length edge, not on a grey stripe.
 */
export function tubeSection(c) {
  const { R, hw, wall, floor, NF, NS, NL } = TUBE;
  const theta = Math.PI * c; // each side's arc
  const w = 2 * hw * (1 - c); // the flat floor left
  const half = w / 2 + R * theta; // inner length from the middle to a lip
  // position + outward normal at signed distance u from the middle, along the inner surface
  const at = (u) => {
    const a = Math.abs(u), side = u < 0 ? -1 : 1;
    if (a <= w / 2 || theta === 0) return { x: u, y: 0, nx: 0, ny: -1 };
    const phi = (a - w / 2) / R;
    return { x: side * (w / 2 + Math.sin(phi) * R), y: R - Math.cos(phi) * R, nx: side * Math.sin(phi), ny: -Math.cos(phi) };
  };
  const fb = Math.min(floor / 2, half - 0.05); // the floor band's half width (a flat road can't be narrower)
  const us = [];
  for (let k = 0; k <= NS; k++) us.push({ u: -half + ((half - fb) * k) / NS, zone: 3 }); // left wall, lip → floor edge
  // the bottom: the SAME surface as the walls (user, 2026-10-19: "tubes should be tubes, no flat road")
  for (let k = 0; k <= NF; k++) us.push({ u: -fb + (2 * fb * k) / NF, zone: 3 });
  for (let k = 0; k <= NS; k++) us.push({ u: fb + ((half - fb) * k) / NS, zone: 3 }); // right wall, floor edge → lip
  const inner = us.map(({ u, zone }) => ({ ...at(u), zone }));
  const pts = [];
  for (const p of inner) pts.push({ x: p.x, y: p.y, zone: p.zone, smooth: true });
  // right lip: half round from the inner lip to the shell, bulging past the lip along the surface
  const lip = (p, dir) => {
    // the surface tangent at the lip, pointing out past it (dir +1 right lip, −1 left lip)
    const tx = -p.ny * dir, ty = p.nx * dir;
    const m = { x: p.x + (p.nx * wall) / 2, y: p.y + (p.ny * wall) / 2 }; // the middle of the wall
    // the bore's colour on the inner half of the round, the shell's on the outer half, changing at a
    // DOUBLED point on the crest (a single edge between two zones is painted the slab's side colour —
    // it drew a red line along every lip)
    const r = wall / 2;
    const pt = (a, zone) => ({ x: m.x - Math.cos(a) * p.nx * r + Math.sin(a) * tx * r, y: m.y - Math.cos(a) * p.ny * r + Math.sin(a) * ty * r, zone, smooth: true });
    const out = [];
    for (let k = 1; k < NL; k++) {
      const a = (Math.PI * k) / NL; // 0 = inner face, π = outer face
      if (a < Math.PI / 2) out.push(pt(a, 3));
      else if (a === Math.PI / 2) out.push(pt(a, 3), pt(a, 4));
      else out.push(pt(a, 4));
    }
    return out;
  };
  const right = inner[inner.length - 1], left = inner[0];
  pts.push(...lip(right, 1));
  for (let k = inner.length - 1; k >= 0; k--) {
    const p = inner[k];
    pts.push({ x: p.x + p.nx * wall, y: p.y + p.ny * wall, zone: 4, smooth: true });
  }
  pts.push(...lip(left, -1).reverse());
  // THE SEAM: when the pipe is closed its two lips meet at the top — pair the coincident points so the
  // ring shades round smoothly (the sweep only welds them at stations where they really touch)
  const nIn = inner.length, nLip = NL; // NL−1 points round each lip, plus its doubled crest
  const outerFirst = nIn + nLip, outerLast = outerFirst + nIn - 1;
  pts[0].seam = nIn - 1; pts[nIn - 1].seam = 0;
  pts[outerFirst].seam = outerLast; pts[outerLast].seam = outerFirst;
  return { pts, hw };
}

/** Closure along a tube piece at s ∈ [0, L]: eased from `from` to `to`. */
export function closureAt(tile, s, L) {
  const { from = 1, to = 1 } = tile.tube;
  return from + (to - from) * q5(Math.min(1, Math.max(0, s / L)));
}

/**
 * Deck (the whole tube: bore, floor, shell, lips) + the steel COLLARS for a tube piece. `frames` are
 * the sweep frames ({pos, tangent, up, right}) at distances `sAt` along the piece.
 * Collars: a thick steel band round the pipe where it is closed at the piece's START (every joint
 * between closed pieces gets exactly one, and a Tube out's mouth), and at its END when the end is a
 * mouth (roof drop, cannon). They hide the seams and make the entrance read as a portal.
 */
export function buildTubeLook(tile, frames, sAt, L, { buildSweepGeometry, NO_CHECKER, THREE }) {
  const ref = tubeSection(1);
  const deck = buildSweepGeometry(frames, ref, { profileAt: (_t, i) => tubeSection(closureAt(tile, sAt[i], L)) });
  const n = deck.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
  deck.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));

  const collars = [];
  const collarAt = (f) => {
    const g = new THREE.TorusGeometry(TUBE.R + TUBE.wall + 0.15, 0.5, 14, 64);
    // torus in its XY plane: X = right, Y = up, Z = along the pipe; centred on the bore
    const m = new THREE.Matrix4().makeBasis(f.right, f.up, f.tangent).setPosition(f.pos.clone().addScaledVector(f.up, TUBE.R));
    g.applyMatrix4(m);
    collars.push(g);
  };
  const closedStart = closureAt(tile, 0, L) > 0.99, closedEnd = closureAt(tile, L, L) > 0.99;
  if (closedStart) collarAt(frames[0]);
  if (closedEnd && (tile.drop || tile.marks?.some((m) => m.kind === "lip"))) collarAt(frames[frames.length - 1]);
  let rail = null;
  if (collars.length) {
    rail = collars.length === 1 ? collars[0] : mergeTwo(collars, THREE);
  }
  return { deck, rail, railCollision: null, posts: null };
}

function mergeTwo(geos, THREE) {
  // tiny merge (same attributes, indexed) — keeps this file free of the addons import for Node tests
  const pos = [], nrm = [], uv = [], idx = [];
  let base = 0;
  for (const g of geos) {
    const p = g.getAttribute("position"), nn = g.getAttribute("normal"), u = g.getAttribute("uv");
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nrm.push(nn.getX(i), nn.getY(i), nn.getZ(i)); uv.push(u.getX(i), u.getY(i)); }
    const ix = g.getIndex();
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    base += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}
