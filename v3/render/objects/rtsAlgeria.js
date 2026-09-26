/**
 * THE ALGERIA GAME'S BUILDABLES — the structures a builder places, both
 * sides (games/alg-rts/TODO.md, economy proposal 2026-09-26). The fixed HQs
 * are their own modules (rtsFrenchPost.js, rtsAlnCamp.js).
 *
 * Kit contract (rtsParts.js): each builder returns ONE merged geometry on the
 * atlas material, origin at the ground centre on y = 0, front at local -Z
 * (the game turns it three-quarters to the player's camera),
 * `userData.footprint` { cx, cz, hx, hz } for its pad and nav, `height` for
 * its health bar. Real metres, scaled by 1.3 at the end. Tested by
 * rtsGroundBandTest + rtsPropsCoplanarTest (every export named build*).
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, buildCorrugatedPanel, buildOilDrum, buildSandbagWall, rng, wirePart } from "./rtsParts.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";

const S = 1.3;

/** Finish a kit piece: AO, scale, footprint, height. */
function finish(parts, { hx, hz, cx = 0, cz = 0, height, ao = {} }) {
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.2, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5, ...ao });
  geo.scale(S, S, S);
  geo.userData.footprint = { cx: cx * S, cz: cz * S, hx: hx * S, hz: hz * S };
  geo.userData.height = height * S;
  return geo;
}

// ── FRENCH ──────────────────────────────────────────────────────────────────

/**
 * SANDBAG WALL — a 5 m run, five courses, with a firing step behind it and a
 * few bags slumped at its foot. The cheap line-builder of every French
 * position (nam's is American: this one is lower and heaped, the way the
 * appelés built them, in hessian gone the colour of the ground).
 */
export function buildFrSandbagWall({ seed = 3, length = 5 } = {}) {
  const R = rng(seed);
  const parts = [];
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  parts.push({ geo: buildSandbagWall({ length, courses: 5, seed, bag, batter: 0.05 }), pos: [0, 0, 0], mat: null });
  // A firing step behind (+Z): two courses, a pace back.
  parts.push({ geo: buildSandbagWall({ length: length - 0.6, courses: 2, seed: seed + 1, bag, batter: 0.03 }), pos: [0, 0, 0.62], mat: null });
  // Bags slumped at the ends, lying loose.
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildSandbagWall({ length: 0.6, courses: 1, seed: seed + 5 + sx, bag }), pos: [sx * (length / 2 + 0.35), 0, -0.15 + R() * 0.2], rot: [0, sx * 0.6, 0], mat: null });
  }
  return finish(parts, { hx: length / 2 + 0.6, hz: 1.0, cz: 0.3, height: 1.2 });
}

/**
 * BARBED WIRE — a 6 m double-apron fence: a line of angle-iron pickets,
 * guy pickets out to each side, strands along the top and down both aprons,
 * and a coil of concertina along the front. Wire itself is sub-pixel at RTS
 * range (rtsObjectProps.js), so the strands are drawn fat (~2.5 cm) and the
 * PICKETS carry the read.
 */
export function buildBarbedWire({ seed = 9, length = 6 } = {}) {
  const R = rng(seed);
  const parts = [];
  const n = Math.round(length / 2);
  const H = 1.2, A = 1.3;                      // picket height, apron reach
  // Round, thin: a box strand shaded like a bar and read as a rod up close.
  const strand = (a, b) => parts.push(wirePart(a, b, 0.013, { tone: 0.4 }));
  for (let k = 0; k <= n; k++) {
    const x = -length / 2 + (k * length) / n;
    const lean = (R() - 0.5) * 0.06;
    parts.push({ geo: buildBox(0.07, H, 0.07), pos: [x, H / 2, 0], rot: [lean, 0, lean], mat: MAT.steel, tone: 0.3 });
    for (const sz of [-1, 1]) {
      parts.push({ geo: buildBox(0.05, 0.4, 0.05), pos: [x + 0.03, 0.2, sz * A], rot: [sz * 0.3, 0, 0], mat: MAT.steel, tone: 0.3 });
      strand([x, H - 0.05, 0], [x + 0.03, 0.35, sz * A]);                 // guy wire down the apron
    }
  }
  // Along the top and along each apron, three strands a side.
  strand([-length / 2, H - 0.05, 0], [length / 2, H - 0.05, 0]);
  for (const sz of [-1, 1]) for (const f of [0.3, 0.6, 0.9]) {
    strand([-length / 2, H - 0.05 - (H - 0.4) * f, sz * A * f], [length / 2, H - 0.05 - (H - 0.4) * f, sz * A * f]);
  }
  // Concertina along the front: ONE continuous coil (a row of separate rings
  // reads as a toy), stretched ~0.3 m a turn, squashed where it sits on the
  // ground, each turn a little out of round.
  const CR = 0.45, pitch = 0.3, turns = Math.round((length - 0.4) / pitch);
  const jit = Array.from({ length: turns + 1 }, () => [(R() - 0.5) * 0.08, (R() - 0.5) * 0.06]);
  const coil = new THREE.Curve();
  coil.getPoint = (t, out = new THREE.Vector3()) => {
    const u = t * turns, k = Math.min(turns - 1, Math.floor(u)), f = u - k;
    const [jr, jz] = jit[k].map((v, i) => v + (jit[k + 1][i] - v) * f);
    const a = u * Math.PI * 2, r = CR + jr;
    const y = CR + Math.cos(a) * r;
    return out.set(-length / 2 + 0.2 + t * (length - 0.4), y > 0.12 ? y : 0.12 + (y - 0.12) * 0.25, -A - 0.5 + jz + Math.sin(a) * r);
  };
  parts.push({ geo: new THREE.TubeGeometry(coil, turns * 14, 0.016, 3, false), pos: [0, 0, 0], mat: MAT.steel, tone: 0.45 });
  return finish(parts, { hx: length / 2 + 0.3, hz: A + 1.0, cz: -0.4, height: H, ao: { strength: 0.2 } });
}

/**
 * MIRADOR — the watchtower of every French post in Algeria: four timber legs
 * braced in X, a ladder, a cabin of planks on top with a sandbagged parapet
 * inside the rail, a corrugated roof, a searchlight on the rail. Sight range
 * is what it sells: it has to read TALL from the RTS camera.
 */
export function buildMirador({ seed = 13 } = {}) {
  const R = rng(seed);
  const parts = [];
  const L = 2.6, Hd = 6.2, W = 3.0;           // leg spread at the foot, deck height, cabin width
  const top = W / 2 - 0.25;
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const beam = (a, b, w, h, mat = MAT.timber, tone = 0.3) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
    const m = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().normalize()), new THREE.Vector3(1, 1, 1));
    parts.push({ geo: buildBox(w, h, d.length()), matrix: m, mat, tone });
  };
  // Legs, raking in toward the top; concrete feet.
  for (const [sx, sz] of legs) {
    beam([sx * L, 0, sz * L], [sx * top, Hd, sz * top], 0.2, 0.2, MAT.timber, 0.28 + R() * 0.1);
    parts.push({ geo: buildBox(0.55, 0.3, 0.55), pos: [sx * L, 0.15, sz * L], mat: MAT.concrete, tone: 0.45 });
  }
  // X-bracing on each face, two bays.
  const at = (sx, sz, f) => [sx * (L + (top - L) * f), Hd * f, sz * (L + (top - L) * f)];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
    for (const [f0, f1] of [[0.08, 0.5], [0.5, 0.92]]) {
      // Round poles (wirePart): square braces crossing in one face, and the
      // girts meeting at the corners, z-fought.
      parts.push(wirePart(at(ax, az, f0), at(bx, bz, f1), 0.055, { mat: MAT.timber, tone: 0.35 }));
      parts.push(wirePart(at(bx, bz, f0), at(ax, az, f1), 0.055, { mat: MAT.timber, tone: 0.35 }));
    }
    parts.push(wirePart(at(ax, az, 0.5), at(bx, bz, 0.5), 0.065, { mat: MAT.timber, tone: 0.32 }));   // girt
  }
  // Ladder up the back leg pair (+Z), rungs.
  const lz = L * 0.55;
  for (const sx of [-0.25, 0.25]) beam([sx, 0, lz + 0.9], [sx, Hd, top - 0.05], 0.07, 0.07, MAT.timber, 0.4);
  for (let k = 1; k < 18; k++) {
    const f = k / 18;
    parts.push({ geo: buildBox(0.5, 0.04, 0.04), pos: [0, Hd * f, lz + 0.9 + (top - 0.05 - lz - 0.9) * f], mat: MAT.timber, tone: 0.45 });
  }
  // The deck, the cabin: plank walls to waist height, the sandbag parapet
  // inside them, corner posts, the rail.
  parts.push({ geo: buildBox(W + 0.4, 0.2, W + 0.4), pos: [0, Hd + 0.1, 0], mat: MAT.timber, tone: 0.25 });
  for (const [sx, sz] of legs) parts.push({ geo: buildBox(0.14, 2.3, 0.14), pos: [sx * (W / 2), Hd + 1.35, sz * (W / 2)], mat: MAT.timber, tone: 0.3 });
  const wallH = 1.05;
  for (const [nx, nz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    const back = nz === 1;
    parts.push({ geo: buildBox(nx ? 0.06 : W - 0.08, back ? 2.1 : wallH, nz ? 0.06 : W - 0.08), pos: [nx * (W / 2 - 0.02), Hd + 0.2 + (back ? 1.05 : wallH / 2), nz * (W / 2 - 0.02)], mat: MAT.timber, tone: 0.34 + R() * 0.1 });
    if (!back) {
      // Sandbags two courses deep inside the plank wall.
      const bag = { length: 0.5, width: 0.3, height: 0.19, segU: 5, segV: 3 };
      parts.push({ geo: buildSandbagWall({ length: W - 0.5, courses: 4, seed: seed + nx * 3 + nz, bag, batter: 0.02 }), pos: [nx * (W / 2 - 0.3), Hd + 0.2, nz * (W / 2 - 0.3)], rot: [0, nx ? Math.PI / 2 : 0, 0], mat: null });
    }
  }
  // Corrugated roof, pitched to the back, overhanging.
  parts.push({ geo: buildBox(W + 0.9, 0.06, W + 0.9), pos: [0, Hd + 2.55, 0.05], rot: [0.12, 0, 0], mat: MAT.metal, tone: 0.45 });
  parts.push({ geo: buildBox(W + 0.95, 0.12, 0.08), pos: [0, Hd + 2.72, -(W + 0.9) / 2 + 0.05], mat: MAT.timber, tone: 0.2 });
  // Searchlight on the front rail, the MG beside it.
  parts.push({ geo: new THREE.CylinderGeometry(0.28, 0.24, 0.45, 14).rotateX(Math.PI / 2), pos: [0.8, Hd + 1.45, -W / 2 + 0.05], mat: MAT.steel, tone: 0.25 });
  parts.push({ geo: new THREE.CylinderGeometry(0.24, 0.24, 0.03, 14).rotateX(Math.PI / 2), pos: [0.8, Hd + 1.45, -W / 2 - 0.19], mat: MAT.white, tone: 0.7 });
  parts.push({ geo: buildBox(0.12, 0.12, 1.1), pos: [-0.6, Hd + 1.42, -W / 2 - 0.2], mat: MAT.steel, tone: 0.1 });
  return finish(parts, { hx: L + 0.4, hz: L + 1.4, cz: 0.4, height: Hd + 2.8, ao: { cell: 0.25 } });
}

/**
 * MG NEST — a circular sandbag pit half dug in, with the AA-52 (the French
 * army's GPMG) on its tripod over the parapet, ammo boxes, a sandbag roof
 * over the back half on timbers. The gun is its own geometry
 * (`userData.gun`, pivot at its mount) so the game can traverse it.
 */
export function buildMgNest({ seed = 17 } = {}) {
  const R = rng(seed);
  const parts = [];
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  // The ring, four courses, open at the back (+Z), a spoil berm round it.
  parts.push({ geo: earthBerm([[3.9, -0.14], [3.5, 0.3], [3.15, 0.45], [0.001, 0.45]], { seed, rJit: 0.18, yJit: 0.05, rFlat: 3.1 }), mat: MAT.spoil, tone: 0.55 });
  for (let c = 0; c < 4; c++) {
    const rad = 2.3 - c * 0.05, n = Math.round((2 * Math.PI * rad) / 0.5);   // shoulder to shoulder
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (c % 2) * (Math.PI / n);
      if (Math.cos(a - Math.PI / 2) > 0.85) continue;                  // the entrance, +Z
      const b = buildSandbagWall({ length: 0.56, courses: 1, seed: seed + c * 31 + k, bag });
      parts.push({ geo: b, pos: [Math.cos(a) * rad, 0.45 + c * 0.19, Math.sin(a) * rad], rot: [0, -a + Math.PI / 2, 0], mat: null });
    }
  }
  // The half-roof: timbers across the back, sandbags on them.
  for (let k = 0; k < 5; k++) parts.push({ geo: new THREE.CylinderGeometry(0.07, 0.08, 4.4, 6).rotateZ(Math.PI / 2), pos: [0, 1.32, 0.3 + k * 0.38], mat: MAT.timber, tone: 0.3 });
  parts.push({ geo: buildSandbagWall({ length: 3.8, courses: 1, seed: seed + 99, bag }), pos: [0, 1.4, 1.0], mat: null });
  // Ammo boxes and a jerrycan on the floor.
  for (let k = 0; k < 3; k++) parts.push({ geo: buildBox(0.5, 0.28, 0.25), pos: [-1.2 + k * 0.55, 0.59, 0.9 + R() * 0.2], rot: [0, R() * 0.4, 0], mat: MAT.paint, tone: 0.3 });
  const geo = finish(parts, { hx: 4, hz: 4, height: 1.8 });
  // The gun: tripod + receiver + barrel, its pivot on the mount.
  const gun = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + Math.PI / 2;
    gun.push(wirePart([0, -0.05, 0], [Math.cos(a) * 0.55, -0.55, Math.sin(a) * 0.55], 0.025, { tone: 0.2 }));
  }
  gun.push({ geo: buildBox(0.14, 0.16, 0.6), pos: [0, 0, 0.05], mat: MAT.steel, tone: 0.1 });
  gun.push({ geo: buildBox(0.06, 0.06, 0.75), pos: [0, 0.02, -0.6], mat: MAT.steel, tone: 0.08 });
  gun.push({ geo: buildBox(0.16, 0.12, 0.3), pos: [0.12, -0.08, 0.1], mat: MAT.paint, tone: 0.3 });
  const gunGeo = assemble(gun);
  bakeContactAO(gunGeo, { cell: 0.06, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });   // the kit material reads `ao`
  gunGeo.scale(S, S, S);
  geo.userData.gun = { geo: gunGeo, pivot: [0, 1.5 * S, -1.6 * S] };
  geo.userData.parts = { gun: gunGeo };
  return geo;
}

// ── shared by the pieces below ──────────────────────────────────────────────

/** A box beam from point a to point b, `w` × `h` in section (an assemble part). */
function beamPart(a, b, w, h, mat, tone) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
  const m = new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().normalize()), new THREE.Vector3(1, 1, 1));
  return { geo: buildBox(w, h, d.length()), matrix: m, mat, tone };
}

/**
 * Faceted, and indexed: a shape shaded smooth (a 4-sided cylinder, a rock)
 * reads as a blob; mergeGeometries refuses a mix of indexed and not.
 */
function faceted(geo, { boxUV = false } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  if (boxUV) {
    // The kit's 2 m a tile, projected per face along its dominant axis: a
    // lathe's or a cylinder's own UVs stretch one tile round the whole thing.
    const p = g.attributes.position, n = g.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (let t = 0; t < p.count; t += 3) {
      const ax = Math.abs(n.getX(t)), ay = Math.abs(n.getY(t)), az = Math.abs(n.getZ(t));
      for (let k = t; k < t + 3; k++) {
        const [a, b] = ay >= ax && ay >= az ? [p.getX(k), p.getZ(k)] : ax >= az ? [p.getZ(k), p.getY(k)] : [p.getX(k), p.getY(k)];
        uv[k * 2] = a / 2; uv[k * 2 + 1] = b / 2;
      }
    }
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }
  g.setIndex([...Array(g.attributes.position.count).keys()]);
  return g;
}

/**
 * Thrown-up earth: a lathe of `prof` ([r, y] from the outside in) with its
 * radius and height wobbling round the ring, so a berm is a heap and not a
 * turned pot. Points inside `rFlat` (a floor) are left flat.
 */
function earthBerm(prof, { seed = 1, segs = 44, rJit = 0.35, yJit = 0.12, rFlat = 0 } = {}) {
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), segs);
  const p = g.attributes.position;
  const ph = [seed * 1.7, seed * 2.9, seed * 4.3, seed * 5.1];
  // Slow lobes (where the spoil was thrown) plus quick lumps (shovelfuls).
  const wob = (a, o) => 0.4 * Math.sin(2 * a + ph[0] + o) + 0.3 * Math.sin(5 * a + ph[1] + o)
    + 0.2 * Math.sin(11 * a + ph[2] + o) + 0.1 * Math.sin(19 * a + ph[3] + o);
  // Per-vertex jitter keyed on POSITION, so the lathe's doubled seam
  // vertices (angle 0 and 2π) move together and the ring stays closed.
  const jit = (x, z, k) => {
    const h = Math.sin(Math.round(x * 100) * 12.9898 + Math.round(z * 100) * 78.233 + k * 37.7 + seed) * 43758.5453;
    return h - Math.floor(h) - 0.5;
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = Math.hypot(x, z);
    if (r <= rFlat + 1e-3) continue;
    const a = Math.atan2(z, x);
    const nr = r + wob(a, 0) * rJit + (y > 0.05 ? jit(x, z, 1) * rJit * 0.5 : 0);   // the buried foot only follows the lobes
    const ny = y > 0.05 ? y + wob(a, 1.3) * yJit + jit(x, z, 2) * yJit * 0.6 : y;
    p.setXYZ(i, (x / r) * nr, ny, (z / r) * nr);
  }
  // SMOOTH shading (faceted, the heap read as a cut gem). UVs in metres:
  // round the ring a whole number of 2 m tiles (the seam must not show),
  // up the profile by its length.
  const uv = g.attributes.uv;
  const rMax = Math.max(...prof.map(([r]) => r));
  const tilesU = Math.max(1, Math.round((2 * Math.PI * rMax) / 2));
  let len = 0;
  for (let k = 1; k < prof.length; k++) len += Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * tilesU, uv.getY(i) * (len / 2));
  g.computeVertexNormals();
  return g;
}

/** A whitewashed field stone — the French post's marker for every edge. */
function whiteStone(R, x, y, z, size = 0.2) {
  const g = faceted(new THREE.IcosahedronGeometry(size, 0));
  return { geo: g, pos: [x, y, z], rot: [R() * 0.5, R() * 3, R() * 0.5], scale: [1.2 + R() * 0.5, 0.7 + R() * 0.2, 1 + R() * 0.4], mat: MAT.white, tone: 0.72 + R() * 0.12 };
}

/** Finish, plus the markings scaled with the piece. */
function finishWithStencils(parts, st, opts) {
  const geo = finish(parts, opts);
  const sg = mergeStencils(st);
  if (sg) { sg.scale(S, S, S); geo.userData.stencil = sg; }
  return geo;
}

/**
 * HELIPAD — the landing ground of a French post (the ALAT's Alouettes and
 * H-34s), not nam's American firebase pad: no steel matting, no revetments.
 * A graded platform of rammed earth, a cement square in its middle with the
 * H painted on, the edge picked out in whitewashed stones the way every
 * French post marked its paths, a windsock, and the fuel point — 200-litre
 * drums behind a low bag wall.
 *
 * userData.deckY: the height a helicopter stands at (scaled).
 */
export function buildHelipad({ seed = 23 } = {}) {
  const R = rng(seed);
  const parts = [];
  const D = 7.5;                                   // deck half-side: 15 m, an H-34's rotor with room
  const bedTop = 0.2, slabTop = 0.26;
  // The graded bed: a square frustum, its batter showing all round.
  const bed = new THREE.CylinderGeometry(D * Math.SQRT2, (D + 0.42) * Math.SQRT2, bedTop + 0.06, 4, 1)
    .rotateY(Math.PI / 4).translate(0, (bedTop - 0.06) / 2, 0);
  parts.push({ geo: faceted(bed, { boxUV: true }), mat: MAT.spoil, tone: 0.6 });
  // The cement square, its foot in the bed.
  parts.push({ geo: buildBox(9, 0.14, 9), pos: [0, slabTop - 0.07, 0], mat: MAT.concrete, tone: 0.58 });
  // Whitewashed stones along the deck's edge, sunk to half their height.
  const pitch = 1.25, n = Math.round((2 * D - 0.7) / pitch);
  for (let k = 0; k <= n; k++) {
    const u = -D + 0.35 + (k * (2 * D - 0.7)) / n;
    for (const [x, z] of [[u, -D + 0.35], [u, D - 0.35], [-D + 0.35, u], [D - 0.35, u]]) {
      if (k === 0 || k === n) { if (x !== u) continue; }                   // corners once
      parts.push(whiteStone(R, x, bedTop + 0.03, z, 0.19));
    }
  }

  // Windsock off the back-right corner: a white mast, guyed, on a footing.
  const wx = D + 1.3, wz = D + 0.4, mH = 5.5;
  parts.push({ geo: buildBox(0.55, 0.26, 0.55), pos: [wx, 0.07, wz], mat: MAT.concrete, tone: 0.5 });
  parts.push(wirePart([wx, 0.1, wz], [wx, mH, wz], 0.055, { mat: MAT.white, tone: 0.62 }));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.4, gx = wx + Math.cos(a) * 2.2, gz = wz + Math.sin(a) * 2.2;
    parts.push(wirePart([wx, mH - 1.1, wz], [gx, 0.1, gz], 0.009, { tone: 0.4 }));
    parts.push({ geo: buildBox(0.07, 0.3, 0.07), pos: [gx, 0.08, gz], rot: [0.25, a, 0], mat: MAT.steel, tone: 0.3 });
  }
  const mouthR = 0.3, tailR = 0.12, sockL = 1.7, droop = 0.35, yaw = 2.3;   // blowing out of the desert, to the west
  const dir = new THREE.Vector3(Math.cos(droop) * Math.cos(yaw), -Math.sin(droop), Math.cos(droop) * Math.sin(yaw));
  const mouth = new THREE.Vector3(wx, mH - 0.12, wz).addScaledVector(dir, 0.35);
  parts.push({ geo: new THREE.TorusGeometry(mouthR, 0.018, 5, 16).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)), pos: [mouth.x, mouth.y, mouth.z], mat: MAT.steel, tone: 0.3 });
  parts.push(wirePart([wx, mH - 0.12, wz], [mouth.x, mouth.y, mouth.z], 0.02, { tone: 0.3 }));

  // The fuel point, off the right side: drums in two rows behind an L of
  // bags, two more on chocks, a hand pump on one.
  const fx = D + 2.4, fz = 1.6;
  for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) {
    parts.push({ geo: buildOilDrum(), pos: [fx - 0.3 + r * 0.64 + (R() - 0.5) * 0.05, 0, fz - 1 + k * 0.64 + (R() - 0.5) * 0.05], rot: [0, R() * 3, 0], mat: MAT.metal, tone: 0.2 + R() * 0.35 });
  }
  for (let k = 0; k < 2; k++) {
    parts.push({ geo: buildBox(0.14, 0.14, 1.1), pos: [fx - 0.3 + k * 0.7, 0.07, fz + 2.1], mat: MAT.timber, tone: 0.35 });
  }
  for (let k = 0; k < 2; k++) {
    parts.push({ geo: buildOilDrum(), pos: [fx - 0.74, 0.44, fz + 1.95 + k * 0.64 - 0.3], rot: [0, 0, Math.PI / 2], mat: MAT.metal, tone: 0.3 + R() * 0.3 });
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.06, 0.4, 8), pos: [fx - 0.3, 1.08, fz - 1], mat: MAT.steel, tone: 0.2 });
  parts.push(wirePart([fx - 0.3, 1.25, fz - 1], [fx - 0.05, 1.45, fz - 1.1], 0.015, { tone: 0.2 }));
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  parts.push({ geo: buildSandbagWall({ length: 3.2, courses: 3, seed: seed + 3, bag }), pos: [fx + 0.1, 0, fz - 1.75], mat: null });
  parts.push({ geo: buildSandbagWall({ length: 3.4, courses: 3, seed: seed + 4, bag }), pos: [fx + 1.15, 0, fz + 0.1], rot: [0, Math.PI / 2, 0], mat: null });

  // Markings: the H on the cement (its top away from the camera), the sock.
  const st = [stencilPatch("helipadH", flatSurface([0, slabTop, 0], [0, 1, 0], [-1, 0, 0], 8, "helipadH"), { lift: 0.006 })];
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const upv = new THREE.Vector3().crossVectors(side, dir).normalize();
  for (const inward of [false, true]) {
    st.push(stencilPatch("sockBands", (s, t) => {
      const a = s * Math.PI * 2;
      const r = (mouthR + (tailR - mouthR) * t) * (inward ? 0.97 : 1);
      const c = mouth.clone().addScaledVector(dir, t * sockL).addScaledVector(upv, -0.12 * t * t);
      const nrm = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(upv, Math.sin(a));
      return { p: c.clone().addScaledVector(nrm, r), n: inward ? nrm.negate() : nrm };
    }, { segS: 12, segT: 6, lift: 0 }));
  }
  const geo = finishWithStencils(parts, st, { hx: 9.9, hz: 8.9, cx: 1.6, cz: 0.4, height: mH, ao: { cell: 0.3, strength: 0.35 } });
  geo.userData.deckY = slabTop * S;
  return geo;
}

/**
 * MOTOR POOL — the "parc auto": where the jeeps, GMCs and half-tracks are
 * kept running. An open-fronted shed on a concrete apron — steel columns and
 * trusses, a corrugated roof, a corrugated back wall — with the whitewashed
 * workshop block on its right. Inside: inspection ramps, a chain-hoist
 * gantry over an engine on a stand, the bench, tyres, drums; jerrycans by
 * the workshop door. Unlocks the motor pool tier (TODO.md PROPOSAL).
 */
export function buildMotorPool({ seed = 29 } = {}) {
  const R = rng(seed);
  const parts = [];
  const X0 = -7, X1 = 7, Z0 = -4, Z1 = 4, EH = 4.4;   // the shed: 14 × 8 m, eaves 4.4
  const F = 0.15;                                        // apron top
  parts.push({ geo: buildBox(22, 0.22, 11.5), pos: [2.4, F - 0.11, 0.2], mat: MAT.concrete, tone: 0.48 });
  const cols = [X0, -7 / 3, 7 / 3, X1];
  // Columns on base plates.
  for (const x of cols) for (const z of [Z0, Z1]) {
    parts.push({ geo: buildBox(0.44, 0.06, 0.44), pos: [x, F + 0.01, z], mat: MAT.steel, tone: 0.3 });
    parts.push({ geo: buildBox(0.22, EH - 0.02, 0.22), pos: [x, F + 0.02 + (EH - 0.02) / 2, z], mat: MAT.steel, tone: 0.34 });
  }
  // The roof, ridge along the shed (built with its ridge along Z, so turned).
  const roofY = F + EH + 0.06, half = 4.4, rise = half * 0.28;
  // Two sheets, each laid by an explicit basis: its width along the shed,
  // its height up the slope from the eave to the ridge. (rtsParts'
  // buildSheetRoof, turned a quarter, stood its sheets on end.)
  const slopeLen = Math.hypot(half, rise) + 0.06;
  for (const sz of [-1, 1]) {
    const up = new THREE.Vector3(0, rise, -sz * half).normalize();
    const ax = new THREE.Vector3(1, 0, 0), nz = new THREE.Vector3().crossVectors(ax, up);
    const m = new THREE.Matrix4().makeBasis(ax, up, nz).setPosition(0, roofY, sz * half);
    parts.push({ geo: buildCorrugatedPanel({ width: X1 - X0 + 0.8 + (sz > 0 ? 0.06 : 0), height: slopeLen, ribs: 96, ribDepth: 0.03, offset: sz > 0 ? 0.02 : 0 }), matrix: m, mat: MAT.metal, tone: 0.5 });
  }
  parts.push({ geo: buildBox(X1 - X0 + 0.9, 0.1, 0.34), pos: [0, roofY + rise + 0.07, 0], mat: MAT.metal, tone: 0.35 });
  const underRoof = (z) => roofY + rise * (1 - Math.abs(z) / half) - 0.1;
  // A truss on every column line: tie, rafters, king post, struts.
  for (const x of cols) {
    parts.push(beamPart([x, F + EH, Z0 - 0.15], [x, F + EH, Z1 + 0.15], 0.14, 0.18, MAT.steel, 0.3));
    for (const sz of [-1, 1]) {
      parts.push(wirePart([x, F + EH + 0.05, sz * 4.1], [x, underRoof(0.05), 0], 0.06, { tone: 0.3 }));
      parts.push(wirePart([x, F + EH + 0.05, 0], [x, underRoof(2) - 0.03, sz * 2], 0.035, { tone: 0.32 }));
      parts.push(wirePart([x, F + EH + 0.05, sz * 2], [x, underRoof(2) - 0.03, sz * 2], 0.035, { tone: 0.32 }));
    }
    parts.push(wirePart([x, F + EH + 0.05, 0], [x, underRoof(0) - 0.02, 0], 0.045, { tone: 0.3 }));
  }
  // Purlins under the sheets, the length of the shed.
  for (const z of [-3.2, -1.6, 1.6, 3.2]) parts.push(beamPart([X0 - 0.3, underRoof(z) + 0.02, z], [X1 + 0.3, underRoof(z) + 0.02, z], 0.08, 0.1, MAT.steel, 0.35));
  // The back wall: corrugated sheets, lapped (offset alternately: never coplanar).
  for (let k = 0; k < 7; k++) {
    parts.push({ geo: buildCorrugatedPanel({ width: 2.12, height: EH - 0.05 - (k % 2) * 0.04, ribs: 12, ribDepth: 0.03, offset: (k % 2) * 0.03 }), pos: [X0 + 1 + k * 2, F + 0.03, Z1 + 0.12], mat: MAT.metal, tone: 0.36 + R() * 0.25 });
  }
  // A tarpaulin hung down the left end against the wind.
  parts.push({ geo: buildBox(0.04, 2.6, 5.2), pos: [X0 - 0.16, F + EH - 1.3, 1.2], rot: [0.02, 0, 0.03], mat: MAT.canvas, tone: 0.45 });

  // The workshop: whitewashed block, flat slab roof with a parapet.
  const wx0 = 8.2, wx1 = 13, wz0 = -2.5, wz1 = 4.2, wH = 3.45;
  const wcx = (wx0 + wx1) / 2, wcz = (wz0 + wz1) / 2, ww = wx1 - wx0, wd = wz1 - wz0;
  parts.push({ geo: buildBox(ww, wH + 0.02, wd), pos: [wcx, F - 0.02 + (wH + 0.02) / 2, wcz], mat: MAT.white, tone: 0.6 });
  parts.push({ geo: buildBox(ww + 0.34, 0.18, wd + 0.34), pos: [wcx, F + wH + 0.04, wcz], mat: MAT.concrete, tone: 0.55 });
  for (const [dx, dz, lx, lz] of [[0, -1, ww + 0.4, 0.14], [0, 1, ww + 0.4, 0.14], [-1, 0, 0.14, wd + 0.12], [1, 0, 0.14, wd + 0.12]]) {
    parts.push({ geo: buildBox(lx, 0.3, lz), pos: [wcx + dx * (ww / 2 + 0.13), F + wH + 0.23, wcz + dz * (wd / 2 + 0.13)], mat: MAT.white, tone: 0.55 });
  }
  // Door, window with open shutters, a sill — on the face the camera sees.
  const fz = wz0 - 0.04;
  parts.push({ geo: buildBox(1.15, 2.15, 0.08), pos: [wcx - 1, F + 0.02 + 1.075, fz], mat: MAT.timber, tone: 0.3 });
  parts.push({ geo: buildBox(1.25, 0.9, 0.06), pos: [wcx + 1.1, F + 1.75, wz0 - 0.03], mat: MAT.steel, tone: 0.05 });
  parts.push({ geo: buildBox(1.45, 0.08, 0.22), pos: [wcx + 1.1, F + 1.26, wz0 - 0.1], mat: MAT.concrete, tone: 0.6 });
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildBox(0.62, 0.92, 0.04).translate(sx * 0.31, 0, 0), pos: [wcx + 1.1 + sx * 0.64, F + 1.75, wz0 - 0.08], rot: [0, sx * -1.9, 0], mat: MAT.paint, tone: 0.55 });
  }

  // Inside, bay 1: the inspection ramps (two concrete tracks).
  const ramp = new THREE.Shape([new THREE.Vector2(-2.8, 0), new THREE.Vector2(2.8, 0), new THREE.Vector2(1.7, 0.75), new THREE.Vector2(-1.7, 0.75)]);
  const rampGeo = faceted(new THREE.ExtrudeGeometry(ramp, { depth: 0.55, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(0.275, 0, 0));
  for (const x of [-4.65 - 0.75, -4.65 + 0.75]) parts.push({ geo: rampGeo.clone(), pos: [x, F - 0.02, -0.2], mat: MAT.concrete, tone: 0.42 });
  // Bay 2: the gantry — two A-frames and a beam, the chain hoist, an engine on its stand.
  const gx = 0, gH = 3.7;
  for (const z of [-2.3, 2.3]) {
    for (const sx of [-1, 1]) parts.push(wirePart([gx + sx * 1.1, F, z], [gx, F + gH, z], 0.06, { tone: 0.25 }));
    parts.push(wirePart([gx - 0.55, F + gH / 2, z], [gx + 0.55, F + gH / 2, z], 0.035, { tone: 0.25 }));
  }
  parts.push(beamPart([gx, F + gH + 0.1, -2.55], [gx, F + gH + 0.1, 2.55], 0.14, 0.2, MAT.steel, 0.2));
  parts.push({ geo: buildBox(0.24, 0.3, 0.2), pos: [gx, F + gH - 0.15, 0.4], mat: MAT.steel, tone: 0.15 });
  parts.push(wirePart([gx, F + gH - 0.3, 0.4], [gx, F + 1.55, 0.4], 0.012, { tone: 0.3 }));
  parts.push({ geo: new THREE.TorusGeometry(0.07, 0.015, 4, 8), pos: [gx, F + 1.48, 0.4], mat: MAT.steel, tone: 0.3 });
  parts.push({ geo: buildBox(0.75, 0.55, 0.95), pos: [gx, F + 0.95, 0.4], rot: [0, 0.2, 0], mat: MAT.steel, tone: 0.22 });
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push(wirePart([gx + sx * 0.3, F, 0.4 + sz * 0.38], [gx + sx * 0.22, F + 0.68, 0.4 + sz * 0.3], 0.03, { tone: 0.3 }));
  // Bay 3: the bench against the back wall, its tool board; tyres, drums.
  const bx = 4.6, bz = Z1 - 0.5;
  parts.push({ geo: buildBox(2.6, 0.08, 0.8), pos: [bx, F + 0.9, bz], mat: MAT.timber, tone: 0.32 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ geo: buildBox(0.08, 0.86, 0.08), pos: [bx + sx * 1.2, F + 0.43, bz + sz * 0.33], mat: MAT.timber, tone: 0.3 });
  parts.push({ geo: buildBox(0.22, 0.18, 0.16), pos: [bx - 0.9, F + 1.03, bz - 0.2], mat: MAT.steel, tone: 0.2 });
  parts.push({ geo: buildBox(0.5, 0.2, 0.25), pos: [bx + 0.6, F + 1.04, bz], mat: MAT.paint, tone: 0.4 });
  parts.push({ geo: buildBox(2.3, 1.0, 0.04), pos: [bx, F + 1.75, Z1 + 0.02], mat: MAT.timber, tone: 0.45 });
  for (let k = 0; k < 3; k++) parts.push({ geo: new THREE.TorusGeometry(0.42, 0.14, 6, 14).rotateX(Math.PI / 2), pos: [6.2, F + 0.14 + k * 0.27, -2.6], rot: [0, R(), 0], mat: MAT.rubber, tone: 0.3 });
  parts.push({ geo: new THREE.TorusGeometry(0.42, 0.14, 6, 14), pos: [6.3, F + 0.55, -1.5], rot: [0.25, 1.3, 0], mat: MAT.rubber, tone: 0.3 });
  for (let k = 0; k < 4; k++) parts.push({ geo: buildOilDrum(), pos: [6.25 - (k % 2) * 0.62, F, 3.1 - Math.floor(k / 2) * 0.62], rot: [0, R() * 3, 0], mat: MAT.metal, tone: 0.25 + R() * 0.3 });
  // Jerrycans in a row by the workshop door.
  for (let k = 0; k < 6; k++) parts.push({ geo: buildBox(0.17, 0.46, 0.34), pos: [wcx - 2.1 + k * 0.2, F + 0.23, wz0 - 0.45], rot: [0, (R() - 0.5) * 0.15, 0], mat: MAT.paint, tone: 0.28 + R() * 0.1 });

  const st = [stencilPatch("frArmeeBlack", flatSurface([wcx, F + 2.95, wz0], [0, 0, -1], [-1, 0, 0], 3.4, "frArmeeBlack"), { lift: 0.01 })];
  return finishWithStencils(parts, st, { hx: 11, hz: 5.9, cx: 2.4, cz: 0.2, height: EH + 1.5, ao: { cell: 0.3 } });
}

/**
 * MORTAR PIT — an 81 mm Brandt in a round pit: the spoil thrown up into a
 * berm, a bag parapet on its crest, open at the back; the ammunition in the
 * back of the pit; two aiming stakes out front, red and white. The tube is
 * its own geometry (`userData.gun`, pivot on the baseplate) so it can lay
 * onto a bearing.
 */
export function buildMortarPit({ seed = 31 } = {}) {
  const R = rng(seed);
  const parts = [];
  const floorY = 0.1;
  // The pit and its berm, one lathe: floor, inner wall, crest, outer slope.
  const prof = [[4.15, -0.14], [3.6, 0.36], [3.0, 0.64], [2.45, 0.6], [2.3, 0.34], [2.1, floorY], [0.001, floorY]];
  parts.push({ geo: earthBerm(prof, { seed, rFlat: 2.1 }), mat: MAT.spoil, tone: 0.5 });
  // The parapet: two courses on the crest, open at the back (+Z).
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  for (let c = 0; c < 2; c++) {
    const rad = 2.72 - c * 0.04, n = Math.round((2 * Math.PI * rad) / 0.5);   // shoulder to shoulder
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + (c % 2) * (Math.PI / n);
      if (Math.cos(a - Math.PI / 2) > 0.9) continue;
      parts.push({ geo: buildSandbagWall({ length: 0.56, courses: 1, seed: seed + c * 31 + k, bag }), pos: [Math.cos(a) * rad, 0.58 + c * 0.19, Math.sin(a) * rad], rot: [0, -a + Math.PI / 2, 0], mat: null });
    }
  }
  // Ammunition at the back of the pit: crates, one open with its rounds in
  // their black cardboard tubes; tubes stacked beside.
  for (let k = 0; k < 3; k++) parts.push({ geo: buildBox(0.7, 0.26, 0.4), pos: [-0.9 + (k % 2) * 0.05, floorY - 0.02 + 0.13 + Math.floor(k / 2) * 0.26, 1.35 + (k === 1 ? 0.45 : 0)], rot: [0, (R() - 0.5) * 0.2, 0], mat: MAT.timber, tone: 0.3 + R() * 0.15 });
  parts.push({ geo: buildBox(0.7, 0.2, 0.4), pos: [0.2, floorY - 0.02 + 0.1, 1.6], rot: [0, 0.15, 0], mat: MAT.timber, tone: 0.4 });
  for (let r = 0, k = 0; r < 3; r++) for (let i = 0; i < 3 - r; i++, k++) {
    parts.push({ geo: new THREE.CylinderGeometry(0.06, 0.06, 0.55, 8).rotateX(Math.PI / 2), pos: [0.95 + i * 0.125 + r * 0.062, floorY + 0.06 + r * 0.105, 1.2], mat: MAT.steel, tone: 0.1 });
  }
  // The aiming stakes: red and white bands (paint over the timber).
  for (const [x, z] of [[0.4, -4.75], [0.35, -5.35]]) {
    for (let b = 0; b < 4; b++) parts.push(wirePart([x, -0.1 + b * 0.45, z], [x, -0.1 + (b + 1) * 0.45, z], 0.028, { mat: b % 2 ? MAT.white : MAT.tile, tone: 0.6 }));
  }
  const geo = finish(parts, { hx: 4.4, hz: 5.7, cz: -0.9, height: 1.2 });

  // The mortar: baseplate, tube at 55°, bipod with its elevating gear, sight.
  const gun = [];
  gun.push({ geo: new THREE.CylinderGeometry(0.3, 0.34, 0.06, 10), pos: [0, 0.03, 0], mat: MAT.steel, tone: 0.2 });
  const tilt = -35 * (Math.PI / 180), tubeL = 1.28;
  gun.push({ geo: new THREE.CylinderGeometry(0.045, 0.05, tubeL, 10).translate(0, tubeL / 2, 0).rotateX(tilt), pos: [0, 0.05, 0], mat: MAT.steel, tone: 0.12 });
  const along = (t) => [0, 0.05 + Math.cos(tilt) * t, Math.sin(tilt) * t];
  const head = along(0.78);
  for (const sx of [-1, 1]) gun.push(wirePart(head, [sx * 0.34, 0.01, head[2] - 0.38], 0.02, { tone: 0.15 }));
  gun.push(wirePart([-0.2, 0.3, head[2] - 0.2], [0.2, 0.3, head[2] - 0.2], 0.008, { tone: 0.3 }));
  gun.push({ geo: buildBox(0.14, 0.22, 0.12), pos: [head[0], head[1] - 0.08, head[2]], mat: MAT.steel, tone: 0.2 });
  gun.push(wirePart([0, head[1] - 0.18, head[2]], [0, 0.26, head[2] - 0.22], 0.018, { tone: 0.2 }));
  gun.push({ geo: buildBox(0.06, 0.12, 0.14), pos: [0.13, head[1] + 0.02, head[2]], mat: MAT.paint, tone: 0.35 });
  const gunGeo = assemble(gun);
  bakeContactAO(gunGeo, { cell: 0.06, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
  gunGeo.scale(S, S, S);
  geo.userData.gun = { geo: gunGeo, pivot: [0, (floorY - 0.02) * S, 0.1 * S] };
  geo.userData.parts = { gun: gunGeo };
  return geo;
}
