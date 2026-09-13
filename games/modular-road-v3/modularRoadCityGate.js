// ============================================================================
// CITY GATE — a building the street drives THROUGH.
//
// Everything else in this city stands beside the road or flies over it. A gate
// is the one structure the road goes INTO: a stone civic block thrown across a
// street, two wings on the lots either side, and a vaulted passage thirty metres
// long that the carriageway runs straight through. From the car it is a portal
// you aim at from two blocks away; inside it the sky goes, the engine note
// closes in, and the light comes from lamps under the arch.
//
// ── WHY IT REPLACES TWO LOTS AND DOES NOT BITE INTO TWO TOWERS ───────────────
//
// The obvious build is a skybridge brought down to street level — a block
// between the two towers that already face each other across the street. That
// collides with everything already bolted to those towers' street faces: hero
// adverts at lobby height, AC units and fire escapes laid out from the facade's
// own window grid. Every one of them would have to learn to stop at the gate.
//
// So the gate takes the two facing LOTS instead. Their towers are simply not
// built — the same mechanism the viaduct uses to clear the blocks under its
// curves — and the gate's wings stand where they were. Nothing else in the city
// has to know the gate exists except through the one keep-out predicate every
// placement already asks.
//
// ── WHERE ────────────────────────────────────────────────────────────────────
//
//   MID-BLOCK      never the first or last lot of a block. Those lots carry the
//                  pedestrian crossings in their first metres, and a portal
//                  opening onto a zebra cuts the bars in half — the mistake the
//                  underpass mouth already made once.
//   A RING         out of the glass core and short of the fringe: a limestone
//                  gate reads as the old city the towers grew around, and
//                  among industrial sheds it would read as a folly.
//   CLEAR          of the track corridor, the viaduct's footprint and ramps, and
//                  the underpass trench. Asked at a grid of points over the whole
//                  footprint, not only at the centre.
//   SPREAD         one roll per coarse cell of blocks, placed strictly inside
//                  it, so two gates are never on the same street and a track
//                  edit can remove a gate but never move one.
//
// ── TWO STYLES ───────────────────────────────────────────────────────────────
//
//   CIVIC        the gatehouse: two windowed wings, a taller pavilion with a
//                mansard, one vaulted passage the carriageway runs through.
//   TRIUMPHAL    the Roman arch: no wings and no windows — one great arch over
//                the carriageway and a smaller one over each pavement, engaged
//                columns, an entablature, a tall attic with a bronze plaque. It
//                stands alone on the two lots it takes, which read as its square.
//
// Each site rolls its style from its own dice, like everything else about it.
// Both are built from the same parts and shaded by the same material, so a city
// with both still compiles ONE gate pipeline.
//
// ── ONE DRAW PER GATE, ONE MATERIAL FOR ALL OF THEM ──────────────────────────
//
// Every part — wings, pavilion, voussoir ring, cornices, mansards, lamps — is
// merged into one geometry carrying a per-vertex `aKind`, and ONE material
// shades all of it: ashlar, rusticated base, windows with lit rooms at night,
// the coffered vault, zinc roofs, the lamps. Windows are drawn, not modelled:
// the face they sit on is recovered from the geometry-space normal, so no UV
// set has to be authored and no window can straddle a corner by accident.
//
// ── WHAT THE CAR HITS ────────────────────────────────────────────────────────
//
// A separate collision geometry — the pavilion's extruded arch profile and the
// two wing boxes, a few hundred triangles — in the SOLIDS channel, the same way
// the underpass hands over its vault. Not the drawn mesh: the lamp strips and
// the voussoir ring are 30 cm proud of the walls, and a chassis scraping along
// a pier should meet the pier.
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  Fn, float, vec2, vec3, uniform, attribute, positionLocal, normalLocal,
  abs, floor, fract, smoothstep, mix, step, max, min, clamp, hash, fwidth,
} from "three/tsl";

export const GATE_DEFAULTS = {
  /** Off and nothing is planned, built or kept clear. */
  gates: true,
  /**
   * The city is divided into coarse cells of this many BLOCKS a side, and each
   * cell rolls for one gate on its own dice. Not a global "pick the best N":
   * that is order-dependent, so a track edit clearing one lot could move a
   * gate across the city and take two more towers with it. A cell only ever
   * considers the blocks strictly inside it, so two gates in neighbouring
   * cells are at least two blocks apart.
   */
  cellBlocks: 4,
  /**
   * Chance a coarse cell gets its gate. MEASURED over eight seeds at the
   * default city: 0.5 gave 0-3 gates (mean 1.6, one city with none), 0.75
   * gives 1-4 (mean 2.4), 1.0 gives 1-4 (mean 2.8). Vetoes do most of the
   * thinning, so this mostly decides whether a city can come out with none.
   */
  cellChance: 0.75,
  /** Where they may stand, as fractions of `extent` from the centre. */
  ringMin: 0.22,
  ringMax: 0.70,
  /**
   * WHICH STYLE, decided by where the site stands: a triumphal arch inside
   * `triumphalWithin` (fraction of extent) — the monument by the old centre —
   * and the civic gatehouse beyond it, where a city's old walls would have been.
   * Local and stable like everything else about a site.
   *
   * Tried first and dropped: a 50/50 roll per site (the default city rolled two
   * triumphal arches and no gatehouse), and a checkerboard of coarse cells (two
   * diagonal neighbours share a colour, and the default city came out all
   * civic). Any rule that ignores meaning can collide; one that follows it
   * reads as a city.
   *
   * `triumphalShare` forces a style: 0 = all civic, 1 = all triumphal, anything
   * else lets the ring decide.
   */
  triumphalWithin: 0.34,
  triumphalShare: 0.5,

  /** TRIUMPHAL ARCH. The great arch spans kerb to kerb; each side arch spans the
   *  pavement band beyond a pier. Heights from the street. */
  tSpring: 8.5,
  tRise: 13.0,
  tMidPier: 2.6,
  tSideWidth: 4.4,
  tSideSpring: 4.2,
  tOuterPier: 5.0,
  tDepth: 15.0,
  tEntablature: 25.5,
  tAtticTop: 38.5,

  /** Pavement kept either side of the carriageway, INSIDE the arch. The span is
   *  the street plus this twice, so the pier never stands at the kerb. */
  archPavement: 4.0,
  /** Height of the pier before the arch starts to curve, and the arch's rise
   *  above that. Crown = springing + rise. */
  springing: 5.0,
  rise: 13.5,
  /** Solid pier either side of the arch, before the wings start. */
  pierWidth: 6.0,
  /** Wings stop this far short of the far side of their lot. */
  wingBackSetback: 3.0,
  /** Depth of the wings along the street, and how far the pavilion projects
   *  forward of them at each end. */
  wingDepth: 29,
  pavilionProject: 1.0,
  /** Eaves height of the wings, and of the taller central pavilion. */
  wingHeight: 23,
  pavilionHeight: 31,
  /** Mansard roofs: how tall, and how far each slope steps in. */
  wingRoof: 4.2,
  pavilionRoof: 6.0,
  roofInset: 2.6,

  /** Storeys and bays the windows are laid out on. */
  baseStorey: 6.0,
  floorHeight: 4.0,
  bayWidth: 3.4,

  /** Warm limestone, the trim a shade lighter, zinc roofs. */
  colorStone: 0xc8bba2,
  colorTrim: 0xd9cdb5,
  colorRoof: 0x40474e,
  /** Share of windows lit after dark. */
  litShare: 0.34,
  /** Lamps under the arch — lit by day too, as a real passage is. */
  lampDay: 0.9,
  lampNight: 3.2,
};

/**
 * Per-vertex surface kind. The shader blends these by `step`, never by `If`.
 *
 *   wall    stone WITH windows (the civic gatehouse)
 *   trim    smooth dressed stone: cornices, plinths, columns, voussoirs
 *   roof    zinc
 *   lamp    emissive
 *   plain   stone with NO windows — the triumphal arch, and any pier face
 *   vault   the coffered underside of an arch
 *   panel   bronze plaque
 */
export const GATE_KIND = { wall: 0, trim: 1, roof: 2, lamp: 3, plain: 4, vault: 5, panel: 6 };

/** Every dimension the geometry, the collision and the footprint agree on. */
export function gateDims(P, params = {}) {
  const G = { ...GATE_DEFAULTS, ...params };
  const kerbHalf = Math.max(P.streetLots, 1) * P.lotSize * 0.5;
  const a = kerbHalf + G.archPavement;          // arch half-span
  const Pw = a + G.pierWidth;                   // pavilion half-width
  const W = kerbHalf + P.lotSize - G.wingBackSetback; // wing outer face
  const D = G.wingDepth * 0.5;                  // wing half-depth
  const Dp = D + G.pavilionProject;             // pavilion half-depth
  const s = G.springing, b = G.rise;
  return {
    G, kerbHalf, a, Pw, W, D, Dp, s, b,
    crown: s + b,
    H: G.wingHeight, H2: G.pavilionHeight,
    top: G.pavilionHeight + G.pavilionRoof,
  };
}

/**
 * The triumphal arch's dimensions. `a` / `crown` are the GREAT arch's, so the
 * test and the planner can ask the same questions of either style.
 */
export function triumphalDims(P, params = {}) {
  const G = { ...GATE_DEFAULTS, ...params };
  const kerbHalf = Math.max(P.streetLots, 1) * P.lotSize * 0.5;
  const a = kerbHalf;                                  // great arch: kerb to kerb
  const sideIn = a + G.tMidPier;
  const sideOut = sideIn + G.tSideWidth;
  const W = sideOut + G.tOuterPier;
  const D = G.tDepth * 0.5;
  const sideA = G.tSideWidth * 0.5;
  const top = G.tAtticTop + 1.1;
  return {
    G, style: "triumphal", kerbHalf, a, s: G.tSpring, b: G.tRise, crown: G.tSpring + G.tRise,
    sideIn, sideOut, sideA, sideCx: (sideIn + sideOut) * 0.5, sideS: G.tSideSpring,
    W, D,
    /** Footprint half-depth: the columns and cornice stand proud of the faces. */
    Dp: D + 1.0,
    entablature: G.tEntablature, atticBase: G.tEntablature + 3.7, atticTop: G.tAtticTop, top,
  };
}

/** Dimensions for a style name. */
export function dimsFor(style, P, params = {}) {
  return style === "triumphal" ? triumphalDims(P, params) : gateDims(P, params);
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Tag a geometry with a constant kind, drop everything but position+normal,
 *  and make it non-indexed so every part merges with every other. */
function tagged(geo, kind) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal") g.deleteAttribute(name);
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  const n = g.getAttribute("position").count;
  g.setAttribute("aKind", new THREE.Float32BufferAttribute(new Float32Array(n).fill(kind), 1));
  // Ambient occlusion baked per vertex: 1 everywhere except inside an arch
  // opening, where `tagOpenings` darkens toward the middle of the passage.
  g.setAttribute("aAO", new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1));
  return g;
}

/**
 * Re-tag the triangles of an extruded arched mass that face INTO an opening.
 *
 * ExtrudeGeometry makes the outer walls, the pier faces and the intrados in one
 * pass, so they arrive with one kind. A triangle whose normal is not along Z
 * and whose centroid lies inside an opening's span, under its crown, is either
 * the vault (above the springing) or a pier face (below it). Both get a baked
 * occlusion that darkens toward the middle of the passage — done here, per
 * vertex, so it is right for every opening of every style without the shader
 * knowing any of their sizes.
 *
 * @param {{cx:number, a:number, s:number, b:number}[]} openings
 */
function tagOpenings(g, openings, halfDepth) {
  const pos = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  const kind = g.getAttribute("aKind");
  const ao = g.getAttribute("aAO");
  for (let i = 0; i < pos.count; i += 3) {
    if (Math.abs(nrm.getZ(i)) > 0.5) continue;               // an arched end face
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const hit = openings.find((o) => Math.abs(cx - o.cx) <= o.a + 0.03 && cy <= o.s + o.b + 0.03 && cy > 0.01);
    if (!hit) continue;
    const k = cy > hit.s + 0.02 ? GATE_KIND.vault : GATE_KIND.plain;
    for (let j = 0; j < 3; j++) {
      kind.setX(i + j, k);
      const t = Math.min(1, Math.abs(pos.getZ(i + j)) / halfDepth);
      ao.setX(i + j, 0.45 + 0.55 * t * t * (3 - 2 * t));
    }
  }
  return g;
}

function box(w, h, d, x, y, z, kind) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return tagged(g, kind);
}

/**
 * A mansard: rectangle [x0,x1]×[z0,z1] at `y`, stepping in by `inset` to a flat
 * top `h` above. Flat-shaded — a roof slope is a plane, and a smoothed normal
 * across its hip would light the corner as a curve.
 */
function mansard(x0, x1, z0, z1, y, h, inset, kind) {
  const X0 = x0 + inset, X1 = x1 - inset, Z0 = z0 + inset, Z1 = z1 - inset, Y = y + h;
  const p = [];
  const quad = (a, b, c, d) => { p.push(...a, ...b, ...c, ...a, ...c, ...d); };
  // Winding: counter-clockwise seen from outside.
  quad([x0, y, z1], [x1, y, z1], [X1, Y, Z1], [X0, Y, Z1]); // +Z
  quad([x1, y, z0], [x0, y, z0], [X0, Y, Z0], [X1, Y, Z0]); // -Z
  quad([x1, y, z1], [x1, y, z0], [X1, Y, Z0], [X1, Y, Z1]); // +X
  quad([x0, y, z0], [x0, y, z1], [X0, Y, Z1], [X0, Y, Z0]); // -X
  quad([X0, Y, Z1], [X1, Y, Z1], [X1, Y, Z0], [X0, Y, Z0]); // top
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return tagged(g, kind);
}

/**
 * The pavilion: a block with the arch cut up through it from the ground.
 *
 * One outline, not a rectangle with a hole — the arch opens onto the ground, so
 * the notch runs in from the bottom edge. ExtrudeGeometry then produces the two
 * arched end faces, the intrados, the pier faces and the roof from that one
 * outline, with every normal already pointing out of the solid.
 */
function pavilionGeometry(d, segments = 32) {
  const { a, Pw, Dp, s, b, H2 } = d;
  const shape = new THREE.Shape();
  shape.moveTo(-Pw, 0);
  shape.lineTo(-a, 0);
  shape.lineTo(-a, s);
  shape.absellipse(0, s, a, b, Math.PI, 0, true);
  shape.lineTo(a, 0);
  shape.lineTo(Pw, 0);
  shape.lineTo(Pw, H2);
  shape.lineTo(-Pw, H2);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Dp * 2, bevelEnabled: false, curveSegments: segments, steps: 6,
  });
  g.translate(0, 0, -Dp);
  return g;
}

/**
 * The raised ring of voussoirs round an arch on one face, the pilaster strips
 * down its piers, and a keystone. `zFace` is the face it stands on, `dir` ±1
 * outward; `o` is the opening ({cx, a, s, b}); `t` the ring's width.
 */
function voussoirRing(o, zFace, dir, kind, { t = 1.5, proud = 0.32, keystone = true, pilasters = true } = {}) {
  const { cx, a, s, b } = o;
  const shape = new THREE.Shape();
  shape.moveTo(cx - (a + t), s);
  shape.absellipse(cx, s, a + t, b + t, Math.PI, 0, true);
  shape.lineTo(cx + a, s);
  shape.absellipse(cx, s, a, b, 0, Math.PI, false);
  shape.closePath();
  const ring = new THREE.ExtrudeGeometry(shape, {
    depth: proud, bevelEnabled: false, curveSegments: 32, steps: 1,
  });
  // Extruded along +Z from 0; stand it on the face, proud of it outward.
  ring.translate(0, 0, dir > 0 ? zFace : zFace - proud);
  const parts = [tagged(ring, kind)];
  const zc = zFace + dir * proud * 0.5;
  if (pilasters) {
    for (const side of [-1, 1]) parts.push(box(t, s, proud, cx + side * (a + t / 2), 0, zc, kind));
  }
  if (keystone) {
    const kw = Math.min(2.4, a * 0.5), kh = Math.min(3.0, b * 0.6);
    parts.push(box(kw, kh, proud + 0.3, cx, s + b - kh * 0.2, zFace + dir * (proud + 0.3) * 0.5, kind));
  }
  return parts;
}

/**
 * Build one gate's drawn geometry and its collision stand-in, in GATE SPACE:
 * X across the street, Z along it, Y up from the street, origin on the street
 * centre line. Placement is one rotation about Y and a translation.
 */
export function buildGateGeometry(d) {
  const { G, a, Pw, W, D, Dp, s, b, H, H2 } = d;
  const K = GATE_KIND;
  const parts = [];

  // ── Mass ──────────────────────────────────────────────────────────────────
  parts.push(tagOpenings(tagged(pavilionGeometry(d), K.wall), [{ cx: 0, a, s, b }], Dp));
  for (const side of [-1, 1]) {
    const x0 = side > 0 ? Pw : -W, x1 = side > 0 ? W : -Pw;
    parts.push(box(x1 - x0, H, D * 2, (x0 + x1) / 2, 0, 0, K.wall));
    // Plinth: a proud band along the wing's foot on the three faces you see.
    parts.push(box(x1 - x0 + 0.5, 0.9, D * 2 + 0.5, (x0 + x1) / 2, 0, 0, K.trim));
    // Wing cornice, then the mansard on top of it.
    parts.push(box(x1 - x0 + 1.4, 0.9, D * 2 + 1.4, (x0 + x1) / 2, H - 0.9, 0, K.trim));
    parts.push(mansard(x0, x1, -D, D, H, G.wingRoof, G.roofInset, K.roof));
    // String course at the top of the rusticated base.
    parts.push(box(x1 - x0 + 0.3, 0.45, D * 2 + 0.3, (x0 + x1) / 2, G.baseStorey - 0.45, 0, K.trim));
  }
  // Pavilion cornice and string course: split round the arch, so neither band
  // runs across the opening.
  parts.push(box(Pw * 2 + 1.6, 1.1, Dp * 2 + 1.6, 0, H2 - 1.1, 0, K.trim));
  parts.push(mansard(-Pw, Pw, -Dp, Dp, H2, G.pavilionRoof, G.roofInset + 0.4, K.roof));
  for (const side of [-1, 1]) {
    const x0 = side > 0 ? a : -Pw, x1 = side > 0 ? Pw : -a;
    parts.push(box(x1 - x0 + 0.3, 0.45, Dp * 2 + 0.3, (x0 + x1) / 2, G.baseStorey - 0.45, 0, K.trim));
  }

  // ── The portal ────────────────────────────────────────────────────────────
  parts.push(...voussoirRing({ cx: 0, a, s, b }, Dp, 1, K.trim));
  parts.push(...voussoirRing({ cx: 0, a, s, b }, -Dp, -1, K.trim));

  // ── Lamps under the arch ─────────────────────────────────────────────────
  // A continuous strip along each pier just under the springing, and pendants
  // down the crown. Emissive geometry, not lights: a light added to the scene
  // changes the light SET, which recompiles every shader in the world.
  for (const side of [-1, 1]) {
    parts.push(box(0.16, 0.22, Dp * 2 - 2.0, side * (a - 0.08), s - 0.7, 0, K.lamp));
  }
  for (let z = -Dp + 4; z <= Dp - 4 + 1e-6; z += 4) {
    parts.push(box(0.7, 0.18, 1.3, 0, s + b - 0.85, z, K.lamp));
  }

  const geometry = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!geometry) throw new Error("[CityGate] merge returned null");
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // ── Collision: the mass only ─────────────────────────────────────────────
  const colParts = [pavilionGeometry(d)];
  for (const side of [-1, 1]) {
    const x0 = side > 0 ? Pw : -W, x1 = side > 0 ? W : -Pw;
    const g = new THREE.BoxGeometry(x1 - x0, H, D * 2);
    g.translate((x0 + x1) / 2, H / 2, 0);
    colParts.push(g);
  }
  const collision = mergeGeometries(colParts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== "position") n.deleteAttribute(name);
    return n;
  }), false);
  for (const g of colParts) g.dispose();
  if (!collision) throw new Error("[CityGate] collision merge returned null");
  return { geometry, collision };
}

/**
 * The Roman triumphal arch, in gate space (X across, Z along, Y up).
 *
 * ONE extruded outline with three notches — the great arch over the
 * carriageway and a side arch over each pavement — up to the top of the
 * entablature; the attic is a box on top. Then the order applied to both faces:
 * plinths under the piers, engaged columns with bases and capitals, the
 * entablature and its cornice, voussoir rings, relief panels over the side
 * arches, and a bronze plaque framed in the attic.
 */
export function buildTriumphalGeometry(d) {
  const { a, s, b, sideCx, sideA, sideS, W, D, entablature, atticBase, atticTop } = d;
  const K = GATE_KIND;
  const parts = [];
  const openings = [
    { cx: 0, a, s, b },
    { cx: -sideCx, a: sideA, s: sideS, b: sideA },
    { cx: sideCx, a: sideA, s: sideS, b: sideA },
  ];

  const massShape = (segments) => {
    const sh = new THREE.Shape();
    sh.moveTo(-W, 0);
    // Left side arch, great arch, right side arch — each a notch from the ground.
    for (const o of [openings[1], openings[0], openings[2]]) {
      sh.lineTo(o.cx - o.a, 0);
      sh.lineTo(o.cx - o.a, o.s);
      sh.absellipse(o.cx, o.s, o.a, o.b, Math.PI, 0, true);
      sh.lineTo(o.cx + o.a, 0);
    }
    sh.lineTo(W, 0);
    sh.lineTo(W, atticBase);
    sh.lineTo(-W, atticBase);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: D * 2, bevelEnabled: false, curveSegments: segments, steps: 6 });
    g.translate(0, 0, -D);
    return g;
  };

  // ── Mass ──────────────────────────────────────────────────────────────────
  parts.push(tagOpenings(tagged(massShape(32), K.plain), openings, D));
  parts.push(box(W * 2 - 1.2, atticTop - atticBase, D * 2 - 1.2, 0, atticBase, 0, K.plain));

  // ── Plinths, under each pier ──────────────────────────────────────────────
  const piers = [[-W, -(sideCx + sideA)], [-(sideCx - sideA), -a], [a, sideCx - sideA], [sideCx + sideA, W]];
  const plinthH = 2.2;
  for (const [x0, x1] of piers) {
    parts.push(box(x1 - x0 + 0.4, plinthH, D * 2 + 0.8, (x0 + x1) / 2, 0, 0, K.trim));
  }

  // ── The order: engaged columns on both faces ─────────────────────────────
  const colR = 0.85, colBase = plinthH, colTop = entablature;
  const colXs = [];
  for (const [x0, x1] of piers) colXs.push((x0 + x1) / 2);
  for (const zf of [D, -D]) {
    for (const x of colXs) {
      const shaft = new THREE.CylinderGeometry(colR * 0.92, colR, colTop - colBase - 1.8, 16, 1, false);
      shaft.translate(x, colBase + 0.8 + (colTop - colBase - 1.8) / 2, zf);
      parts.push(tagged(shaft, K.trim));
      parts.push(box(colR * 2.6, 0.8, colR * 2.6, x, colBase, zf, K.trim));          // base
      parts.push(box(colR * 2.9, 1.0, colR * 2.9, x, colTop - 1.0, zf, K.trim));     // capital
    }
  }

  // ── Entablature, cornice, attic cornice ──────────────────────────────────
  parts.push(box(W * 2 + 0.6, 2.5, D * 2 + 1.0, 0, entablature, 0, K.trim));
  parts.push(box(W * 2 + 1.8, 1.2, D * 2 + 2.0, 0, entablature + 2.5, 0, K.trim));
  parts.push(box(W * 2 - 0.2, 1.1, D * 2 + 0.2, 0, atticTop, 0, K.trim));

  // ── Voussoirs, relief panels, the plaque ─────────────────────────────────
  for (const [zf, dir] of [[D, 1], [-D, -1]]) {
    parts.push(...voussoirRing(openings[0], zf, dir, K.trim, { t: 1.6, keystone: true, pilasters: false }));
    for (const o of [openings[1], openings[2]]) {
      parts.push(...voussoirRing(o, zf, dir, K.trim, { t: 0.7, proud: 0.22, keystone: true, pilasters: false }));
      // A relief panel above each side arch.
      parts.push(box(o.a * 2 + 0.6, 4.2, 0.2, o.cx, o.s + o.b + 3.2, zf + dir * 0.1, K.trim));
    }
    const plaqueW = Math.min(W * 1.1, a * 1.9), plaqueH = (atticTop - atticBase) * 0.55;
    const plaqueY = atticBase + (atticTop - atticBase - plaqueH) / 2;
    const face = zf + dir * (-0.6);
    parts.push(box(plaqueW + 1.2, plaqueH + 1.2, 0.3, 0, plaqueY - 0.6, face + dir * 0.15, K.trim));
    parts.push(box(plaqueW, plaqueH, 0.25, 0, plaqueY, face + dir * 0.38, K.panel));
  }

  // ── Lamps: under the great arch, and one in each side passage ────────────
  for (const side of [-1, 1]) {
    parts.push(box(0.16, 0.22, D * 2 - 2.0, side * (a - 0.08), s - 1.2, 0, K.lamp));
    parts.push(box(0.5, 0.15, D * 2 - 3.0, side * sideCx, sideS + sideA - 0.25, 0, K.lamp));
  }

  const geometry = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!geometry) throw new Error("[CityGate] triumphal merge returned null");
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Collision: the mass and the attic. The columns stand 0.85 m proud of the
  // faces a car can only meet head-on, where the pier behind them stops it.
  const colParts = [massShape(20)];
  const attic = new THREE.BoxGeometry(W * 2 - 1.2, atticTop - atticBase, D * 2 - 1.2);
  attic.translate(0, atticBase + (atticTop - atticBase) / 2, 0);
  colParts.push(attic);
  const collision = mergeGeometries(colParts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) if (name !== "position") n.deleteAttribute(name);
    return n;
  }), false);
  for (const g of colParts) g.dispose();
  if (!collision) throw new Error("[CityGate] triumphal collision merge returned null");
  return { geometry, collision };
}

// ── Material ────────────────────────────────────────────────────────────────

/**
 * ONE material for every part of every gate.
 *
 * No `If` anywhere: every surface is computed and the kinds are blended with
 * `step` masks. A branch saves nothing on a shader this small, and every
 * derivative below then sits at function top level, which is the rule the city
 * shader test enforces after a `.toVar()` first used inside an `If` once shipped
 * a city that never drew.
 */
export function makeGateMaterial(d, { uNight = uniform(0) } = {}) {
  const { G, a, Pw, D, Dp, s, b, H, H2 } = d;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 });
  mat.name = "CityGate";

  const cStone = uniform(new THREE.Color(G.colorStone));
  const cTrim = uniform(new THREE.Color(G.colorTrim));
  const cRoof = uniform(new THREE.Color(G.colorRoof));
  const uLit = uniform(G.litShare);
  const uLampDay = uniform(G.lampDay);
  const uLampNight = uniform(G.lampNight);

  const kind = attribute("aKind", "float");
  const ao = attribute("aAO", "float");
  /** 1 where `kind` is exactly k. */
  const is = (k) => step(float(k - 0.5), kind).mul(float(1).sub(step(float(k + 0.5), kind)));
  const isWall = is(GATE_KIND.wall);
  const isTrim = is(GATE_KIND.trim);
  const isRoof = is(GATE_KIND.roof);
  const isLamp = is(GATE_KIND.lamp);
  const isPlain = is(GATE_KIND.plain);
  const isVault = is(GATE_KIND.vault);
  const isPanel = is(GATE_KIND.panel);
  /** Every stone surface, windowed or not. */
  const isStone = isWall.add(isPlain);

  const p = positionLocal;
  const n = normalLocal;

  /** Which way the face points, and the horizontal coordinate ALONG it. */
  const facesX = step(abs(n.z), abs(n.x));                 // 1 on ±X walls
  const vertical = float(1).sub(step(0.5, abs(n.y)));
  const u = mix(p.x, p.z, facesX);
  const v = p.y;

  /*
   * INSIDE A PASSAGE is decided at BUILD time now (`tagOpenings`): the vault is
   * its own kind and a pier face is plain stone, both with baked occlusion. The
   * first version recovered it here from the civic arch's own size, which only
   * ever worked for the one arch whose numbers the shader was compiled with.
   */

  // ── Ashlar ───────────────────────────────────────────────────────────────
  const fw = (x) => max(fwidth(x), float(1e-4));
  const rustic = step(v, float(G.baseStorey));
  const courseH = mix(float(0.62), float(1.15), rustic);
  const blockL = mix(float(1.55), float(2.3), rustic);
  const row = floor(v.div(courseH));
  const stagger = fract(row.mul(0.5)).mul(2.0);            // 0 or 1
  const bu = u.div(blockL).add(stagger.mul(0.5));
  const col = floor(bu);
  const fu = fract(bu), fv = fract(v.div(courseH));
  const jointW = mix(float(0.022), float(0.06), rustic);
  const jU = jointW.div(blockL), jV = jointW.div(courseH);
  const jointMask = max(
    float(1).sub(smoothstep(jU, jU.add(fw(bu)), min(fu, float(1).sub(fu)))),
    float(1).sub(smoothstep(jV, jV.add(fw(v.div(courseH))), min(fv, float(1).sub(fv)))),
  );
  const blockTint = hash(col.mul(131.0).add(row.mul(71.0)).add(floor(p.z.add(p.x).mul(0.01)).mul(17.0)))
    .sub(0.5).mul(0.12);
  // Grime: heavier at the foot, and streaking down below every cornice.
  const foot = float(1).sub(smoothstep(0.0, 3.2, v)).mul(0.22);
  const streak = hash(floor(u.mul(1.7)).add(311.0)).mul(0.10)
    .mul(smoothstep(float(G.baseStorey), float(H), v).oneMinus().mul(0.5).add(0.5));
  const stone = cStone.mul(float(1).add(blockTint))
    .mul(float(1).sub(jointMask.mul(mix(float(0.28), float(0.48), rustic))))
    .mul(float(1).sub(foot).sub(streak.mul(vertical)));

  // ── Windows ──────────────────────────────────────────────────────────────
  // Bays centred on the face grid, storeys up from the rusticated base.
  const bay = floor(u.div(G.bayWidth).add(0.5));
  const du = u.sub(bay.mul(G.bayWidth));
  const fl = floor(v.sub(G.baseStorey).div(G.floorHeight));
  const dv = v.sub(G.baseStorey).sub(fl.mul(G.floorHeight));
  const winHalfW = float(0.78), winLo = float(0.95), winHi = float(3.25);
  const frame = float(0.18);
  const inWinU = step(abs(du), winHalfW);
  const inWinV = step(winLo, dv).mul(step(dv, winHi));
  const inFrameU = step(abs(du), winHalfW.add(frame));
  const inFrameV = step(winLo.sub(frame), dv).mul(step(dv, winHi.add(frame)));
  // Which storeys exist on this face: the pavilion runs higher than the wings.
  const onPavilion = max(
    step(abs(p.x), float(Pw - 0.05)),
    step(abs(p.x), float(Pw + 0.05)).mul(step(float(H + 0.05), v)),
  );
  const topLimit = mix(float(H), float(H2), onPavilion).sub(2.0);
  const storeysOk = step(float(G.baseStorey), v).mul(step(v, topLimit));
  // Keep windows off the arch: an ellipse round the voussoir ring on the end
  // faces, plus the piers below the springing.
  const ex = p.x.div(a + 3.6), ey = v.sub(s).div(b + 3.2);
  const nearArch = step(ex.mul(ex).add(ey.mul(ey)), float(1))
    .add(step(abs(p.x), float(a + 3.6)).mul(step(v, float(s))));
  const endFace = step(0.5, abs(n.z));
  const archClear = float(1).sub(clamp(nearArch.mul(endFace), 0, 1));
  // And off the corners and the pavilion/wing junction.
  const edgeX = min(abs(abs(p.x).sub(Pw)), abs(abs(p.x).sub(d.W)));
  const edgeZ = min(abs(abs(p.z).sub(D)), abs(abs(p.z).sub(Dp)));
  const cornerClear = mix(step(1.3, edgeX), step(1.3, edgeZ), facesX);
  const windowsHere = isWall.mul(vertical)
    .mul(storeysOk).mul(archClear).mul(cornerClear);
  const glass = windowsHere.mul(inWinU).mul(inWinV);
  const surround = windowsHere.mul(inFrameU).mul(inFrameV).mul(float(1).sub(inWinU.mul(inWinV)));

  // A lit room: warm, varied, a fixed share of windows, gated by night.
  const winId = hash(bay.mul(17.0).add(fl.mul(193.0)).add(floor(p.z.mul(0.1)).mul(29.0))
    .add(floor(p.x.mul(0.1)).mul(53.0)).add(n.x.mul(7.0)).add(n.z.mul(11.0)));
  const lit = step(winId, uLit);
  const glassDay = mix(vec3(0.035, 0.045, 0.055), vec3(0.11, 0.13, 0.15), dv.sub(winLo).div(2.3));
  const room = mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.86, 0.62), hash(winId.mul(97.0)));

  // ── The vault ────────────────────────────────────────────────────────────
  // Coffers: ribs every 3 m along the passage and every 2.2 m across it, from
  // gate-space position, so any arch of any size is coffered the same.
  const ribZ = fract(p.z.div(3.0).add(0.5));
  const ribX = fract(p.x.div(2.2).add(0.5));
  const ribMask = max(
    float(1).sub(smoothstep(0.06, 0.06 + 0.02, min(ribZ, float(1).sub(ribZ)))),
    float(1).sub(smoothstep(0.08, 0.08 + 0.03, min(ribX, float(1).sub(ribX)))),
  );
  const coffer = mix(cStone.mul(0.62), cTrim.mul(0.95), ribMask);

  // Bronze: patinated, darker in its recesses — a plaque, not a painted board.
  const bronze = mix(vec3(0.16, 0.24, 0.20), vec3(0.28, 0.36, 0.30),
    hash(floor(p.x.mul(1.3)).add(floor(v.mul(2.1)).mul(19.0))).mul(0.6));

  // ── Trim and roof ────────────────────────────────────────────────────────
  const trimJoint = fract(u.div(1.4));
  const trim = cTrim.mul(float(1).sub(float(1).sub(smoothstep(0.0, 0.02, min(trimJoint, float(1).sub(trimJoint))))
    .mul(0.2).mul(vertical)));
  const seam = fract(u.div(0.62));
  const roof = cRoof.mul(float(1).sub(float(1).sub(smoothstep(0.0, 0.03, min(seam, float(1).sub(seam)))).mul(0.35)));

  // ── Compose ──────────────────────────────────────────────────────────────
  let wall = mix(stone, cTrim.mul(0.92), surround);
  wall = mix(wall, glassDay, glass);
  const base = wall.mul(isStone)
    .add(coffer.mul(isVault))
    .add(trim.mul(isTrim))
    .add(roof.mul(isRoof))
    .add(bronze.mul(isPanel))
    .mul(ao)
    .add(vec3(1.0, 0.86, 0.6).mul(isLamp));
  mat.colorNode = base;
  mat.roughnessNode = float(0.86)
    .sub(glass.mul(0.72))
    .sub(isRoof.mul(0.4))
    .sub(isTrim.mul(0.1))
    .sub(isLamp.mul(0.5))
    .sub(isPanel.mul(0.35));
  mat.metalnessNode = isRoof.mul(0.35).add(isPanel.mul(0.55));
  const lampGlow = mix(uLampDay, uLampNight, uNight);
  mat.emissiveNode = vec3(1.0, 0.84, 0.58).mul(isLamp).mul(lampGlow)
    // 0.7, not the 1.6 it started at: MEASURED in the game at dusk, 1.6 blew
    // every lit window out to a white block, which reads as a floodlight rather
    // than as a room.
    .add(room.mul(glass).mul(lit).mul(uNight).mul(0.7));

  return { material: mat, uniforms: { cStone, cTrim, cRoof, uLit, uLampDay, uLampNight } };
}

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Decide where the gates go, BEFORE any lot is built.
 *
 * Each coarse cell of `cellBlocks` blocks rolls once: whether it has a gate,
 * which block strictly inside it, which of that block's two outgoing streets,
 * and which mid-block lot along it. The site is then vetoed — never re-rolled
 * elsewhere — by what is static: the ring, the city's edge, a plaza on either
 * wing, the viaduct and the underpass. Nothing here reads which lots were
 * built, so nothing about a lot can move a gate. The track corridor is the one
 * veto that changes at runtime, and it is applied separately, by
 * `gateMeetsCorridor`, and only ever removes.
 *
 * @param {(i:number, j:number, k:number) => number} o.rand  a keyed [0,1) draw
 * @param {(cx:number, cz:number) => boolean} [o.isPlaza]
 * @returns {{gates: object[], reserved: Set<string>, dims: object}|null}
 */
export function planCityGates({
  P, rand, isPlaza = null, keepOut = null, under = null,
  originCellX = 0, originCellZ = 0, extent = P.extent, params = {},
}) {
  const d = gateDims(P, params);
  const dt = triumphalDims(P, params);
  const { G } = d;
  if (!G.gates || !rand) return null;

  const L = P.lotSize;
  const pitch = P.blockLots + P.streetLots;
  const N = Math.max(3, Math.round(G.cellBlocks));
  const blocksHalf = Math.ceil(extent / (pitch * L)) + 1;
  const cMin = Math.floor(-blocksHalf / N) - 1, cMax = Math.ceil(blocksHalf / N) + 1;

  const gates = [];
  const reserved = new Set();
  for (let gi = cMin; gi <= cMax; gi++) {
    for (let gj = cMin; gj <= cMax; gj++) {
      // Distinct purpose keys from everything else blockRand serves (31 is the
      // plaza), shifted into a range no real block index reaches.
      const I = gi * 7919 + 100003, J = gj * 7927 + 200003;
      if (rand(I, J, 401) >= G.cellChance) continue;
      // A block strictly inside the cell: indices 1 .. N-2.
      const bx = gi * N + 1 + Math.floor(rand(I, J, 402) * (N - 2));
      const bz = gj * N + 1 + Math.floor(rand(I, J, 403) * (N - 2));
      const alongZ = rand(I, J, 404) < 0.5;
      const lot = 1 + Math.floor(rand(I, J, 405) * Math.max(1, P.blockLots - 2));

      // Wing A: the last lot of block (bx, bz) on the span axis. Wing B: the
      // first lot of the next block across the street.
      const aCx = originCellX + bx * pitch + (alongZ ? P.blockLots - 1 : lot);
      const aCz = originCellZ + bz * pitch + (alongZ ? lot : P.blockLots - 1);
      const bCx = alongZ ? aCx + P.streetLots + 1 : aCx;
      const bCz = alongZ ? aCz : aCz + P.streetLots + 1;
      const x = alongZ ? (aCx + 1 + P.streetLots / 2) * L : (aCx + 0.5) * L;
      const z = alongZ ? (aCz + 0.5) * L : (aCz + 1 + P.streetLots / 2) * L;

      // The style is rolled with the site, before any veto — so a veto never
      // turns one style into the other, it only removes the gate.
      const style = G.triumphalShare <= 0 ? "civic"
        : G.triumphalShare >= 1 ? "triumphal"
          : Math.hypot(x - P.centerX, z - P.centerZ) < extent * G.triumphalWithin ? "triumphal" : "civic";
      const sd = style === "triumphal" ? dt : d;

      const r = Math.hypot(x - P.centerX, z - P.centerZ);
      if (r < extent * G.ringMin || r > extent * G.ringMax) continue;
      if (Number.isFinite(P.bounds)
        && (Math.abs(x) + sd.W > P.bounds - P.boundsMargin || Math.abs(z) + sd.W > P.bounds - P.boundsMargin)) continue;
      if (isPlaza && (isPlaza(aCx, aCz) || isPlaza(bCx, bCz))) continue;
      const site = { x, z, alongZ };
      if (!footprintClear(site, sd, (wx, wz) => (keepOut && keepOut(wx, wz)) || (under && under(wx, wz)))) continue;

      const ka = `${aCx},${aCz}`, kb = `${bCx},${bCz}`;
      reserved.add(ka);
      reserved.add(kb);
      gates.push({
        x, z, y: P.groundY,
        /** The street runs along this world axis; the span crosses the other. */
        axis: alongZ ? "z" : "x",
        yaw: alongZ ? 0 : Math.PI / 2,
        cells: [ka, kb],
        style,
        halfSpan: sd.W, halfDepth: sd.Dp, archHalf: sd.a, crown: P.groundY + sd.crown,
        top: P.groundY + sd.top,
      });
    }
  }
  return { gates, reserved, dims: d, dimsTriumphal: dt };
}

/** True when `blocked` refuses any of a 7×5 grid over the gate's footprint. */
function footprintClear(site, d, blocked) {
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 4; j++) {
      const gx = -d.W + (2 * d.W * i) / 6;
      const gz = -d.Dp + (2 * d.Dp * j) / 4;
      const wx = site.alongZ ? site.x + gx : site.x + gz;
      const wz = site.alongZ ? site.z + gz : site.z + gx;
      if (blocked(wx, wz)) return false;
    }
  }
  return true;
}

/**
 * Does the track corridor come within `radius` of this gate, anywhere over its
 * footprint, at the gate's own height? The runtime veto — see planCityGates.
 */
export function gateMeetsCorridor(gate, avoid, radius) {
  const d = { W: gate.halfSpan, Dp: gate.halfDepth };
  return !footprintClear({ x: gate.x, z: gate.z, alongZ: gate.axis === "z" }, d,
    (wx, wz) => avoid(wx, wz, gate.top) < radius);
}

/**
 * True inside any gate's footprint, grown by `margin` — the predicate every
 * placement (lamps, trees, signals, clutter) already takes as `keepOut`.
 */
export function gateFootprint(plan, margin = 1.5) {
  if (!plan?.gates?.length) return null;
  const boxes = plan.gates.map((g) => {
    const hx = (g.axis === "z" ? g.halfSpan : g.halfDepth) + margin;
    const hz = (g.axis === "z" ? g.halfDepth : g.halfSpan) + margin;
    return [g.x - hx, g.x + hx, g.z - hz, g.z + hz];
  });
  return (x, z) => {
    for (const bx of boxes) if (x >= bx[0] && x <= bx[1] && z >= bx[2] && z <= bx[3]) return true;
    return false;
  };
}

// ── Build ───────────────────────────────────────────────────────────────────

/**
 * Meshes, material and collision for a plan. One geometry per STYLE is shared by
 * every gate of that style (they are identical in gate space), and every gate of
 * either style shares ONE material — a single pipeline however many there are.
 */
export function createCityGates({ plan, uNight = uniform(0), castShadows = true } = {}) {
  if (!plan?.gates?.length) return null;
  const d = plan.dims;
  const built = new Map();
  const partsFor = (style) => {
    if (!built.has(style)) {
      built.set(style, style === "triumphal"
        ? buildTriumphalGeometry(plan.dimsTriumphal)
        : buildGateGeometry(d));
    }
    return built.get(style);
  };
  // The civic dims drive the window layout; a triumphal arch has no windowed
  // surface, so it never reads them.
  const { material, uniforms } = makeGateMaterial(d, { uNight });
  const group = new THREE.Group();
  group.name = "CityGates";

  const meshes = [];
  const colliders = [];
  for (const g of plan.gates) {
    const { geometry, collision } = partsFor(g.style ?? "civic");
    const m = new THREE.Mesh(geometry, material);
    m.name = "CityGate";
    m.position.set(g.x, g.y, g.z);
    m.rotation.y = g.yaw;
    m.castShadow = castShadows;
    m.receiveShadow = true;
    m.updateMatrixWorld(true);
    group.add(m);
    meshes.push(m);

    // Invisible, out of the scene graph, its matrix set by hand — the same
    // stand-in shape the underpass hands over for its vault.
    const c = new THREE.Mesh(collision, material);
    c.name = "CityGateCollision";
    c.visible = false;
    c.position.copy(m.position);
    c.rotation.copy(m.rotation);
    c.updateMatrixWorld(true);
    colliders.push(c);
  }

  const tris = (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  return {
    group,
    meshes,
    uniforms,
    plan,
    collisionMeshes() { return { deck: [], solids: colliders.slice() }; },
    stats: {
      gates: plan.gates.length,
      draws: meshes.length,
      styles: Object.fromEntries([...built].map(([k, v]) => [k, { tris: tris(v.geometry), collisionTris: tris(v.collision) }])),
    },
    dispose() {
      for (const v of built.values()) { v.geometry.dispose(); v.collision.dispose(); }
      material.dispose();
    },
  };
}
