/**
 * RTS BRIDGES — the three crossings of a Vietnam river map, built from the
 * parts kit (rtsParts.js) so they share the rest of the world's surfaces.
 *
 *   • BAILEY (buildBaileyBridge): the US Army engineers' panel bridge, THE
 *     military bridge of the war. Lattice panels bolted end to end make two
 *     through-trusses — DOUBLE-DOUBLE (two panel planes each side, two panels
 *     high: what a 30 m span under tanks took; and one storey beside an 8 m
 *     game deck read as a hand rail), overhead bracing across the top, steel
 *     transoms across under the deck, stringers, a timber chess deck, kerb
 *     ribbons, rakers bracing the trusses, concrete bank seats.
 *   • TRESTLE (buildTrestleBridge): the country road bridge — log pile bents
 *     driven into the riverbed, a cap on each, log stringers, a plank deck with
 *     wheel-track boards, a rail each side. The piles reach the REAL bed: the
 *     caller says how deep the ground is under each point (`depthAt`).
 *   • MONKEY BRIDGE (buildMonkeyBridge): cầu khỉ, the Mekong footbridge —
 *     bamboo poles lashed side by side into a walkway that arches over the
 *     water, resting in the crotch of crossed bamboo X-legs, one handrail.
 *     Infantry only.
 *
 * FRAME (all three): the span runs along local X from -span/2 to +span/2, the
 * width along Z, and the ROAD SURFACE is at y = 0 (the monkey bridge arches
 * above that: deckRise(x)). Everything below the deck is built down to
 * `depthAt(x, z)` — metres of drop from the deck to the ground there, positive
 * down — so the piles, legs and bank seats stand on the actual terrain.
 *
 * One geometry each, merged, per-vertex surface ids: one draw per bridge.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBambooPole, buildBox, buildPost, rng } from "./rtsParts.js";

/** Real size x this — the same factor as the game's units and man-made things. */
const S = 1.3;
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/** A box `w` x `len` x `h`, laid from a to b (its length along a->b). */
function beam(a, b, w, h = w, mat = MAT.timber, tone = 0.4) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const geo = buildBox(w, len, h).translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.normalize());
  return { geo, matrix: new THREE.Matrix4().compose(a, q, ONE), mat, tone };
}
/** An axis-aligned box centred at (x, y, z). */
function box(w, h, d, x, y, z, mat, tone) {
  return { geo: buildBox(w, h, d), pos: [x, y, z], mat, tone };
}
/** A bamboo culm from a to b. */
function culm(a, b, radius, tone, seed) {
  const len = a.distanceTo(b);
  const geo = buildBambooPole({ height: len, radius, internodes: Math.max(2, Math.round(len / 0.6)), taper: 0.08, seg: 5 });
  const q = new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3().subVectors(b, a).normalize());
  // A turn about its own axis, so the nodes of neighbouring poles don't line up.
  q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, seed * 2.4));
  return { geo, matrix: new THREE.Matrix4().compose(a, q, ONE), mat: MAT.bamboo, tone };
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
/** A log lying along X (or Z with `alongZ`), UVs in metres / 2 like buildBox's — a 0..1 cylinder smeared its bark over 38 m. */
function log(len, r, alongZ = false) {
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * Math.PI * r), (uv.getY(i) * len) / 2);
  return alongZ ? g.rotateX(Math.PI / 2) : g.rotateZ(Math.PI / 2);
}

// ── BAILEY ───────────────────────────────────────────────────────────────────

export const BAILEY_PANEL = 3.048 * S;   // a panel is 10 ft long…
export const BAILEY_HEIGHT = 1.45 * S;   // …and 4 ft 9 in high

/**
 * @param {object} o
 * @param {number} o.span  metres, end to end
 * @param {number} [o.width] roadway, kerb to kerb
 * @param {(x:number, z:number) => number} [o.depthAt] drop to the ground
 */
export function buildBaileyBridge({ span, width = 8, depthAt = () => 1, seed = 7, storeys = 2 } = {}) {
  const R = rng(seed);
  const parts = [];
  const L = span, hl = L / 2, W = width;
  const bays = Math.max(2, Math.round(L / BAILEY_PANEL)), bay = L / bays;
  const yb = -0.36, yt = yb + BAILEY_HEIGHT * storeys; // bottom / top chord centres
  const zIn = W / 2 + 0.28, zOut = zIn + 0.34;        // double-single: two panel planes a side
  const OD = MAT.paint;

  for (const s of [-1, 1]) {
    for (const zp of [zIn, zOut]) {
      const z = s * zp, tone = 0.32 + R() * 0.12;
      // Chords, end to end (the panels' chords butt into one line).
      // Members about twice their true section: at 1:1 a Bailey's lattice read
      // from the RTS camera as a timber hand rail.
      for (let st = 0; st < storeys; st++) {
        const y0 = yb + st * BAILEY_HEIGHT, y1 = y0 + BAILEY_HEIGHT;
        parts.push(box(L, 0.24, 0.2, 0, y0, z, OD, tone));
        if (st === storeys - 1) parts.push(box(L, 0.24, 0.2, 0, y1, z, OD, tone));
        for (let k = 0; k < bays; k++) {
          const x0 = -hl + k * bay, xm = x0 + bay / 2, x1 = x0 + bay;
          // The panel: end posts, a centre post, and the two diagonals down to
          // the bottom centre — the lattice that says "Bailey" from the air.
          parts.push(box(0.22, BAILEY_HEIGHT, 0.2, x0 + 0.11, (y0 + y1) / 2, z, OD, tone));
          parts.push(box(0.16, BAILEY_HEIGHT, 0.16, xm, (y0 + y1) / 2, z, OD, tone));
          parts.push(beam(V(x0 + 0.18, y1 - 0.1, z), V(xm, y0 + 0.1, z), 0.16, 0.16, OD, tone));
          parts.push(beam(V(x1 - 0.18, y1 - 0.1, z), V(xm, y0 + 0.1, z), 0.16, 0.16, OD, tone));
        }
        parts.push(box(0.22, BAILEY_HEIGHT, 0.2, hl - 0.11, (y0 + y1) / 2, z, OD, tone));
      }
    }
    // Tie plates across each side's pair of panels, every bay, at the top chord.
    for (let k = 0; k <= bays; k++) {
      const x = -hl + k * bay + (k === bays ? -0.1 : k === 0 ? 0.1 : 0);
      for (let st = 1; st <= storeys; st++) {
        parts.push(box(0.1, 0.06, zOut - zIn + 0.14, x, yb + st * BAILEY_HEIGHT + 0.14, s * (zIn + zOut) / 2, MAT.steel, 0.35));
      }
    }
  }
  // Overhead bracing (the through-truss's roof of beams): a cross beam every
  // other joint, and X-braces between them.
  let prevX = null;
  for (let k = 0; k <= bays; k += 2) {
    const x = Math.max(-hl + 0.2, Math.min(hl - 0.2, -hl + k * bay));
    parts.push(box(0.2, 0.24, 2 * zOut + 0.2, x, yt + 0.02, 0, MAT.steel, 0.32));
    if (prevX != null) {
      parts.push(beam(V(prevX, yt + 0.02, -zIn), V(x, yt + 0.02, zIn), 0.1, 0.1, MAT.steel, 0.3));
      parts.push(beam(V(prevX, yt + 0.06, zIn), V(x, yt + 0.06, -zIn), 0.1, 0.1, MAT.steel, 0.3));
    }
    prevX = x;
  }
  // Transoms: steel beams across under the deck, two to a bay, out past the
  // trusses; rakers from their ends up to the inner panel's top.
  for (let k = 0; k <= bays * 2; k++) {
    const x = Math.max(-hl + 0.15, Math.min(hl - 0.15, -hl + k * bay / 2));
    parts.push(box(0.2, 0.3, 2 * zOut + 0.5, x, yb - 0.05, 0, MAT.steel, 0.3 + R() * 0.1));
    if (k % 2 === 0) {
      for (const s of [-1, 1]) {
        parts.push(beam(V(x, yb, s * (zOut + 0.22)), V(x, yb + BAILEY_HEIGHT - 0.25, s * (zIn - 0.02)), 0.1, 0.1, OD, 0.35));
      }
    }
  }
  // Stringers along, then the chess (deck planks) across them, kerb ribbons.
  for (let i = 0; i < 6; i++) {
    const z = -W / 2 + 0.5 + (i * (W - 1)) / 5;
    parts.push(box(L, 0.16, 0.14, 0, -0.16, z, MAT.steel, 0.3));
  }
  const chess = Math.round(L / (0.26 * S));
  for (let i = 0; i < chess; i++) {
    const w = L / chess;
    parts.push(box(w * 0.94, 0.08, W + 0.2, -hl + (i + 0.5) * w, -0.04, (R() - 0.5) * 0.1, MAT.timber, 0.3 + R() * 0.35));
  }
  for (const s of [-1, 1]) parts.push(box(L, 0.2, 0.22, 0, 0.1, s * (W / 2 - 0.05), MAT.timber, 0.28));
  // Bank seats: a concrete sill under each end, down to the ground.
  for (const s of [-1, 1]) {
    const x = s * (hl - 0.6);
    const d = Math.max(0.5, Math.max(depthAt(x, -W / 2), depthAt(x, 0), depthAt(x, W / 2)) + 0.4);
    parts.push(box(1.4, d, 2 * zOut + 0.9, x, yb - 0.2 - d / 2, 0, MAT.concrete, 0.45));
  }
  const geo = assemble(parts);
  for (const p of parts) p.geo.dispose();
  bakeContactAO(geo, { cell: 0.3, radius: 2, strength: 0.35, groundFade: 0, floor: 0.55 });
  return geo;
}

// ── TRESTLE ──────────────────────────────────────────────────────────────────

export function buildTrestleBridge({ span, width = 8, depthAt = () => 2, seed = 11 } = {}) {
  const R = rng(seed);
  const parts = [];
  const L = span, hl = L / 2, W = width;
  const bays = Math.max(2, Math.round(L / 4.8)), bay = L / bays;
  const capY = -0.62;                                  // under the stringers
  const pileZ = [-W * 0.42, -W * 0.16, W * 0.16, W * 0.42];
  for (let k = 0; k <= bays; k++) {
    const x = -hl + k * bay + (k === 0 ? 0.5 : k === bays ? -0.5 : 0);
    const end = k === 0 || k === bays;
    // The cap across the bent.
    parts.push(box(0.42, 0.36, W + 0.9, x, capY, 0, MAT.timber, 0.25 + R() * 0.1));
    let deep = 0;
    for (const z of pileZ) {
      const d = Math.max(0.6, depthAt(x, z) + 0.9);    // driven into the bed
      deep = Math.max(deep, d);
      const lean = end ? 0 : Math.sign(z) * (Math.abs(z) > W * 0.3 ? 0.08 : 0);
      const foot = V(x + (R() - 0.5) * 0.12, capY - d, z + lean * d);
      parts.push({ geo: buildPost({ round: true, height: foot.distanceTo(V(x, capY - 0.18, z)), width: 0.42, taper: 0.1 }),
        matrix: new THREE.Matrix4().compose(foot, new THREE.Quaternion().setFromUnitVectors(UP, V(x, capY - 0.18, z).sub(foot).normalize()), ONE),
        mat: MAT.timber, tone: 0.18 + R() * 0.12 });
    }
    // X-bracing on the tall bents, planks nailed across the upstream face.
    if (!end && deep > 2.2) {
      const zo = W * 0.42, lo = capY - deep + 0.9, hi = capY - 0.25, f = x - 0.26;
      parts.push(beam(V(f, hi, -zo), V(f, lo, zo), 0.06, 0.24, MAT.timber, 0.3));
      parts.push(beam(V(f - 0.07, hi, zo), V(f - 0.07, lo, -zo), 0.06, 0.24, MAT.timber, 0.34));
    }
    // An end bent is a crib: logs stacked behind it, holding the bank.
    if (end) {
      const s = k === 0 ? -1 : 1;
      const d = Math.max(0.6, depthAt(x, 0) + 0.5);
      for (let c = 0; c < Math.ceil(d / 0.4); c++) {
        parts.push({ geo: log(W + 1.1, 0.2, true), pos: [x + s * 0.5, capY - 0.3 - c * 0.4, 0], mat: MAT.timber, tone: 0.2 + R() * 0.15 });
      }
    }
  }
  // Log stringers, bent to bent.
  for (let i = 0; i < 5; i++) {
    const z = -W / 2 + 0.6 + (i * (W - 1.2)) / 4;
    parts.push({ geo: log(L, 0.2), pos: [0, -0.28, z], mat: MAT.timber, tone: 0.24 + R() * 0.08 });
  }
  // The deck: planks across, uneven ends and gaps, then two tracks of boards
  // along where the wheels run.
  let x = -hl;
  while (x < hl - 0.05) {
    const w = Math.min(hl - x, 0.26 + R() * 0.08);
    const len = W + 0.3 + (R() - 0.5) * 0.4;
    parts.push(box(w - 0.03, 0.08, len, x + w / 2, -0.04, (R() - 0.5) * 0.2, MAT.timber, 0.3 + R() * 0.4));
    x += w;
  }
  for (const zt of [-1.3, 1.3]) for (const dz of [-0.28, 0, 0.28]) {
    parts.push(box(L - 0.4, 0.05, 0.26, 0, 0.025, zt * S * 0.9 + dz, MAT.timber, 0.4 + R() * 0.2));
  }
  // Wheel guards and a rail: posts over every bent.
  for (const s of [-1, 1]) {
    parts.push(box(L, 0.24, 0.26, 0, 0.12, s * (W / 2 - 0.1), MAT.timber, 0.26));
    for (let k = 0; k <= bays; k++) {
      const px = Math.max(-hl + 0.2, Math.min(hl - 0.2, -hl + k * bay));
      parts.push(box(0.16, 1.1, 0.16, px, 0.55, s * (W / 2 + 0.1), MAT.timber, 0.3));
    }
    parts.push(box(L - 0.2, 0.12, 0.14, 0, 1.05, s * (W / 2 + 0.1), MAT.timber, 0.34));
  }
  const geo = assemble(parts);
  for (const p of parts) p.geo.dispose();
  bakeContactAO(geo, { cell: 0.3, radius: 2, strength: 0.4, groundFade: 0, floor: 0.5 });
  return geo;
}

// ── MONKEY BRIDGE (cầu khỉ) ──────────────────────────────────────────────────

/** How high the walkway arches over its ends at x (for boats under it). */
export function monkeyDeckRise(x, span, rise = 0.6) {
  const t = (2 * x) / span;
  return rise * Math.max(0, 1 - t * t);
}

export function buildMonkeyBridge({ span, width = 1.6, rise = 0.6, depthAt = () => 1.5, seed = 19 } = {}) {
  const R = rng(seed);
  const parts = [];
  const L = span, hl = L / 2, W = width;
  const y = (x) => monkeyDeckRise(x, L, rise);
  const n = Math.max(2, Math.round(L / (2.8 * S)));
  const xs = [];
  for (let k = 0; k <= n; k++) xs.push(-hl + 0.4 + (k * (L - 0.8)) / n);
  const r = 0.055 * S;
  // X-legs at every station: two culms crossing just under the walkway.
  const spread = W / 2 + 0.55;
  for (const x of xs) {
    const d = Math.max(0.8, depthAt(x, 0) + 0.7);
    const cy = y(x) - 0.14;
    for (const s of [-1, 1]) {
      const foot = V(x + (R() - 0.5) * 0.15, cy - d, -s * spread);
      const dir = V(x, cy, 0).sub(foot);
      const top = V(x, cy, 0).add(dir.clone().setLength(1.25 * S));
      parts.push(culm(foot, top, r * 1.25, 0.35 + R() * 0.2, R()));
    }
  }
  // The walkway: poles side by side, one straight run per bay (lashed at the
  // legs, so the arch is a polygon of straight culms — as it is).
  const poles = Math.max(3, Math.round(W / (3 * r)));
  for (let i = 0; i < poles; i++) {
    const z = -W / 2 + r + (i * (W - 2 * r)) / (poles - 1);
    for (let k = 0; k < xs.length - 1; k++) {
      const a = V(xs[k] - 0.18, y(xs[k]) - r, z), b = V(xs[k + 1] + 0.18, y(xs[k + 1]) - r, z);
      parts.push(culm(a, b, r, 0.45 + R() * 0.25, R()));
    }
  }
  // Crossbars under the walkway at each leg, and one handrail, on the legs' tops.
  for (const x of xs) {
    parts.push(culm(V(x, y(x) - 2.2 * r, -spread * 0.9), V(x, y(x) - 2.2 * r, spread * 0.9), r * 0.9, 0.4, R()));
  }
  const railZ = spread * 0.62, railY = 0.95 * S;
  for (let k = 0; k < xs.length - 1; k++) {
    parts.push(culm(V(xs[k] - 0.1, y(xs[k]) + railY, railZ), V(xs[k + 1] + 0.1, y(xs[k + 1]) + railY, railZ), r * 0.8, 0.55, R()));
  }
  const geo = assemble(parts);
  for (const p of parts) p.geo.dispose();
  bakeContactAO(geo, { cell: 0.2, radius: 2, strength: 0.3, groundFade: 0, floor: 0.6 });
  return geo;
}
