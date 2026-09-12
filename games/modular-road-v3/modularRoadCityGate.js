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

/** Per-vertex surface kind. The shader branches on these by `step`, not `If`. */
export const GATE_KIND = { wall: 0, trim: 1, roof: 2, lamp: 3 };

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
    depth: Dp * 2, bevelEnabled: false, curveSegments: segments, steps: 1,
  });
  g.translate(0, 0, -Dp);
  return g;
}

/** The raised ring of voussoirs round the arch on one face, plus the pilaster
 *  strips down each pier. `zFace` is the face it stands on, `dir` ±1 outward. */
function voussoirRing(d, zFace, dir, kind) {
  const { a, s, b } = d;
  const t = 1.5, proud = 0.32;
  const shape = new THREE.Shape();
  shape.moveTo(-(a + t), s);
  shape.absellipse(0, s, a + t, b + t, Math.PI, 0, true);
  shape.lineTo(a, s);
  shape.absellipse(0, s, a, b, 0, Math.PI, false);
  shape.closePath();
  const ring = new THREE.ExtrudeGeometry(shape, {
    depth: proud, bevelEnabled: false, curveSegments: 32, steps: 1,
  });
  // Extruded along +Z from 0; stand it on the face, proud of it outward.
  ring.translate(0, 0, dir > 0 ? zFace : zFace - proud);
  const parts = [tagged(ring, kind)];
  const zc = zFace + dir * proud * 0.5;
  for (const side of [-1, 1]) {
    parts.push(box(t, s, proud, side * (a + t / 2), 0, zc, kind));
  }
  // The keystone, taller than the ring and further proud, at the crown.
  parts.push(box(2.4, 3.0, proud + 0.3, 0, s + b - 0.6, zFace + dir * (proud + 0.3) * 0.5, kind));
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
  parts.push(tagged(pavilionGeometry(d), K.wall));
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
  parts.push(...voussoirRing(d, Dp, 1, K.trim));
  parts.push(...voussoirRing(d, -Dp, -1, K.trim));

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
  const isTrim = step(0.5, kind).mul(float(1).sub(step(1.5, kind)));
  const isRoof = step(1.5, kind).mul(float(1).sub(step(2.5, kind)));
  const isLamp = step(2.5, kind);
  const isWall = float(1).sub(step(0.5, kind));

  const p = positionLocal;
  const n = normalLocal;

  /** Which way the face points, and the horizontal coordinate ALONG it. */
  const facesX = step(abs(n.z), abs(n.x));                 // 1 on ±X walls
  const vertical = float(1).sub(step(0.5, abs(n.y)));
  const u = mix(p.x, p.z, facesX);
  const v = p.y;

  /*
   * INSIDE THE PASSAGE: the intrados and the two pier faces. Not a kind of its
   * own because ExtrudeGeometry makes it in the same pass as the outer walls —
   * recovered instead from where it is: inside the span, under the crown, and
   * not one of the two arched end faces.
   */
  const inSpan = step(abs(p.x), float(a + 0.02));
  const underCrown = step(v, float(s + b + 0.02));
  const notEndFace = float(1).sub(step(0.5, abs(n.z)));
  const inPassage = isWall.mul(inSpan).mul(underCrown).mul(notEndFace);

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
  const windowsHere = isWall.mul(vertical).mul(float(1).sub(inPassage))
    .mul(storeysOk).mul(archClear).mul(cornerClear);
  const glass = windowsHere.mul(inWinU).mul(inWinV);
  const surround = windowsHere.mul(inFrameU).mul(inFrameV).mul(float(1).sub(inWinU.mul(inWinV)));

  // A lit room: warm, varied, a fixed share of windows, gated by night.
  const winId = hash(bay.mul(17.0).add(fl.mul(193.0)).add(floor(p.z.mul(0.1)).mul(29.0))
    .add(floor(p.x.mul(0.1)).mul(53.0)).add(n.x.mul(7.0)).add(n.z.mul(11.0)));
  const lit = step(winId, uLit);
  const glassDay = mix(vec3(0.035, 0.045, 0.055), vec3(0.11, 0.13, 0.15), dv.sub(winLo).div(2.3));
  const room = mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.86, 0.62), hash(winId.mul(97.0)));

  // ── The passage ──────────────────────────────────────────────────────────
  // Coffers: ribs every 3 m along the street, and every 12° round the arch.
  // Across the vault, parameterised by x: coarse near the springing where the
  // surface is steep, which is where the eye expects the coffers to foreshorten.
  const around = p.x.div(a);
  const ribZ = fract(p.z.div(3.0).add(0.5));
  const ribA = fract(around.mul(4.5).add(0.5));
  const ribMask = max(
    float(1).sub(smoothstep(0.06, 0.06 + 0.02, min(ribZ, float(1).sub(ribZ)))),
    float(1).sub(smoothstep(0.05, 0.05 + 0.02, min(ribA, float(1).sub(ribA)))),
  );
  const onVault = step(float(s + 0.05), v);
  const coffer = mix(cStone.mul(0.62), cTrim.mul(0.95), ribMask.mul(onVault));
  // Darker toward the middle of the passage, where daylight does not reach.
  const depthDark = mix(float(0.45), float(1.0), smoothstep(float(0), float(Dp), abs(p.z)));
  const passage = mix(stone.mul(0.8), coffer, onVault).mul(depthDark);

  // ── Trim and roof ────────────────────────────────────────────────────────
  const trimJoint = fract(u.div(1.4));
  const trim = cTrim.mul(float(1).sub(float(1).sub(smoothstep(0.0, 0.02, min(trimJoint, float(1).sub(trimJoint))))
    .mul(0.2).mul(vertical)));
  const seam = fract(u.div(0.62));
  const roof = cRoof.mul(float(1).sub(float(1).sub(smoothstep(0.0, 0.03, min(seam, float(1).sub(seam)))).mul(0.35)));

  // ── Compose ──────────────────────────────────────────────────────────────
  let wall = mix(stone, passage, inPassage);
  wall = mix(wall, cTrim.mul(0.92), surround);
  wall = mix(wall, glassDay, glass);
  const base = wall.mul(isWall).add(trim.mul(isTrim)).add(roof.mul(isRoof))
    .add(vec3(1.0, 0.86, 0.6).mul(isLamp));
  mat.colorNode = base;
  mat.roughnessNode = float(0.86)
    .sub(glass.mul(0.72))
    .sub(isRoof.mul(0.4))
    .sub(isTrim.mul(0.1))
    .sub(isLamp.mul(0.5));
  mat.metalnessNode = isRoof.mul(0.35);
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

      const r = Math.hypot(x - P.centerX, z - P.centerZ);
      if (r < extent * G.ringMin || r > extent * G.ringMax) continue;
      if (Number.isFinite(P.bounds)
        && (Math.abs(x) + d.W > P.bounds - P.boundsMargin || Math.abs(z) + d.W > P.bounds - P.boundsMargin)) continue;
      if (isPlaza && (isPlaza(aCx, aCz) || isPlaza(bCx, bCz))) continue;
      const site = { x, z, alongZ };
      if (!footprintClear(site, d, (wx, wz) => (keepOut && keepOut(wx, wz)) || (under && under(wx, wz)))) continue;

      const ka = `${aCx},${aCz}`, kb = `${bCx},${bCz}`;
      reserved.add(ka);
      reserved.add(kb);
      gates.push({
        x, z, y: P.groundY,
        /** The street runs along this world axis; the span crosses the other. */
        axis: alongZ ? "z" : "x",
        yaw: alongZ ? 0 : Math.PI / 2,
        cells: [ka, kb],
        halfSpan: d.W, halfDepth: d.Dp, archHalf: d.a, crown: P.groundY + d.crown,
        top: P.groundY + d.top,
      });
    }
  }
  return { gates, reserved, dims: d };
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
 * Meshes, material and collision for a plan. One geometry is shared by every
 * gate (they are identical in gate space), so N gates are N draws of ONE
 * geometry and ONE material — a single pipeline however many there are.
 */
export function createCityGates({ plan, uNight = uniform(0), castShadows = true } = {}) {
  if (!plan?.gates?.length) return null;
  const d = plan.dims;
  const { geometry, collision } = buildGateGeometry(d);
  const { material, uniforms } = makeGateMaterial(d, { uNight });
  const group = new THREE.Group();
  group.name = "CityGates";

  const meshes = [];
  const colliders = [];
  for (const g of plan.gates) {
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
      tris: tris(geometry),
      collisionTris: tris(collision),
    },
    dispose() {
      geometry.dispose();
      collision.dispose();
      material.dispose();
    },
  };
}
