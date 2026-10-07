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
import { ConvexGeometry } from "three/addons/geometries/ConvexGeometry.js";
import { MAT, assemble, bakeContactAO, buildBox, buildCorrugatedPanel, buildOilDrum, buildSandbagWall, rng, wirePart } from "./rtsParts.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const S = 1.3;

/** Finish a kit piece: AO, scale, footprint, height. */
export function finish(parts, { hx, hz, cx = 0, cz = 0, height, ao = {} }) {
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
 * SANDBAG WALL, BREACHED — the same 5 m run after a shell or a grenade: a gap
 * blown through the middle, the stubs either side lower and slumped, the burst
 * bags thrown out flat in front and behind. Same footprint as the whole wall
 * (alg-rts swaps one for the other: algDamage.js).
 */
export function buildFrSandbagWallBreached({ seed = 3, length = 5 } = {}) {
  const R = rng(seed + 101);
  const parts = [];
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  const L = length / 2;
  // The stubs: 4 courses on the left, 3 slumped ones on the right.
  parts.push({ geo: buildSandbagWall({ length: 1.7, courses: 4, seed, bag, batter: 0.06 }), pos: [-L + 0.85, 0, 0], mat: null });
  parts.push({ geo: buildSandbagWall({ length: 1.3, courses: 3, seed: seed + 2, bag, batter: 0.08 }), pos: [L - 0.65, 0, 0.04], rot: [0, -0.08, 0.03], mat: null });
  // What is left of the firing step behind.
  parts.push({ geo: buildSandbagWall({ length: 1.4, courses: 1, seed: seed + 1, bag, batter: 0.03 }), pos: [-L + 1.0, 0, 0.62], mat: null });
  // The burst bags: single bags lying flat, thrown both ways out of the gap.
  for (let k = 0; k < 9; k++) {
    const x = (R() - 0.5) * 2.4, z = (R() < 0.6 ? -1 : 1) * (0.3 + R() * 1.1);
    parts.push({ geo: buildSandbagWall({ length: 0.6, courses: 1, seed: seed + 11 + k, bag }), pos: [x, 0, z], rot: [0, R() * 3.1, 0], mat: null });
  }
  return finish(parts, { hx: length / 2 + 0.6, hz: 1.0, cz: 0.3, height: 0.8 });
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
export function faceted(geo, { boxUV = false } = {}) {
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
export function earthBerm(prof, { seed = 1, segs = 44, rJit = 0.35, yJit = 0.12, rFlat = 0 } = {}) {
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
  // The sock itself turns and fills with the wind, so it is the GAME's
  // (userData.windsock, games/alg-rts/algWind.js): its swivel — arm and mouth
  // ring — is a small kit geometry in the swivel's frame, downwind = +X.
  const mouthR = 0.3, tailR = 0.12, sockL = 1.7, arm = 0.35;
  const swivel = assemble([
    { geo: new THREE.CylinderGeometry(0.05, 0.05, 0.14, 8), pos: [0, 0, 0], mat: MAT.steel, tone: 0.25 },
    wirePart([0, 0, 0], [arm, 0, 0], 0.02, { tone: 0.3 }),
    { geo: new THREE.TorusGeometry(mouthR, 0.018, 5, 16).rotateY(Math.PI / 2), pos: [arm, 0, 0], mat: MAT.steel, tone: 0.3 },
  ]);
  bakeContactAO(swivel, { cell: 0.06, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
  swivel.scale(S, S, S);

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

  // Markings: the H on the cement (its top away from the camera).
  const st = [stencilPatch("helipadH", flatSurface([0, slabTop, 0], [0, 1, 0], [-1, 0, 0], 8, "helipadH"), { lift: 0.006 })];
  const geo = finishWithStencils(parts, st, { hx: 9.9, hz: 8.9, cx: 1.6, cz: 0.4, height: mH, ao: { cell: 0.3, strength: 0.35 } });
  geo.userData.deckY = slabTop * S;
  // The windsock: the swivel's pivot on the mast top, the cloth's size.
  geo.userData.windsock = {
    pivot: [wx * S, (mH - 0.12) * S, wz * S], swivel,
    mouth: arm * S, mouthR: mouthR * S, tailR: tailR * S, length: sockL * S,
  };
  geo.userData.parts = { swivel };
  return geo;
}

/**
 * MOTOR POOL — the "parc auto": where the jeeps, GMCs and half-tracks are
 * kept running. An open-fronted shed on a concrete apron — steel columns and
 * trusses, a corrugated roof, a corrugated back wall — with the whitewashed
 * workshop block on its right. Inside: inspection ramps, a chain-hoist
 * gantry over an engine on a stand, the bench; tyres and drums out on the
 * apron, jerrycans by the workshop door. Unlocks the motor pool tier (TODO.md
 * PROPOSAL).
 *
 * THE GARAGE BAY (the right one, x 7/3 → 7) has DOORS and is kept clear:
 * it is where a new vehicle stands before it rolls out. Two corrugated
 * leaves on steel frames, hinged on the columns, their own geometry
 * (userData.gate, as the post's gate) so a game swings them open, outward.
 * The other two bays stay open: the ramps and the hoist are the look.
 *
 * DETAIL 2 (the buildings lab, 2026-10-07 — "the rusted metal reads too much tiling"): the roof
 * is SHEETS, ~0.9 m, lapped, not two 15 m panels. Each maps the texture once up its length (the
 * rust at its foot, where water sits — a 2 m tile put a rust band every 2 m up the slope: the
 * rows of orange arcs) from its own random point across, so no two neighbours match; one in
 * seven is a newer replacement, cleaner (the texture's upper band). The cladding the same. A
 * gutter each side, a downpipe into a drum, a dirty plinth round the workshop, a lamp at its door.
 */
export function buildMotorPool({ seed = 29, detail = 1 } = {}) {
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
    if (detail < 2) {
      parts.push({ geo: buildCorrugatedPanel({ width: X1 - X0 + 0.8 + (sz > 0 ? 0.06 : 0), height: slopeLen, ribs: 96, ribDepth: 0.03, offset: sz > 0 ? 0.02 : 0 }), matrix: m, mat: MAT.metal, tone: 0.5 });
      continue;
    }
    // Sheets 0.92 m wide on a 0.86 m pitch (6 cm laps), alternately proud (never coplanar);
    // alternate ones start 3 cm lower at the eave and end 3 cm higher under the ridge cap, so
    // their end caps never share a plane either.
    const SW = 0.92, PITCH = 0.86, rx0 = X0 - 0.4, rx1 = X1 + 0.4;
    const n = Math.ceil((rx1 - rx0 - SW) / PITCH) + 1;
    for (let k = 0; k < n; k++) {
      const x = Math.min(rx0 + SW / 2 + k * PITCH, rx1 - SW / 2);
      const newer = R() < 0.14, drop = (k % 2) * 0.03, len = slopeLen + drop * 2;   // ends apart at BOTH ends
      const geo = buildCorrugatedPanel({
        width: SW, height: len, ribs: 6, ribDepth: 0.03, offset: (k % 2) * 0.025 + (sz > 0 ? 0.05 : 0),
        // Once up its length; a newer sheet only the texture's cleaner top band.
        uvScale: newer ? [1, 0.7 / len] : [1, 2 / len], uvOffset: [R() * 2, newer ? 0.62 : 0],
      });
      const mk = m.clone().multiply(new THREE.Matrix4().makeTranslation(x, -drop, 0));
      parts.push({ geo, matrix: mk, mat: MAT.metal, tone: newer ? 0.85 + R() * 0.1 : 0.3 + R() * 0.4 });
    }
    // The gutter under the eave, its downpipe at the front-left corner into a drum.
    const gz = sz * (half + 0.1), gy = roofY - 0.16;
    parts.push({ geo: buildBox(rx1 - rx0, 0.12, 0.14), pos: [(rx0 + rx1) / 2, gy, gz], mat: MAT.steel, tone: 0.42 });
    if (sz < 0) {
      parts.push(wirePart([rx0 + 0.25, gy - 0.05, gz], [rx0 + 0.25, F + 0.95, gz], 0.05, { tone: 0.4 }));
      parts.push({ geo: buildOilDrum(), pos: [rx0 + 0.25, F, gz - 0.1], rot: [0, 0.4, 0], mat: MAT.metal, tone: 0.3 });
    }
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
    const h = EH - 0.05 - (k % 2) * 0.04;
    parts.push({ geo: buildCorrugatedPanel({ width: 2.12, height: h, ribs: 12, ribDepth: 0.03, offset: (k % 2) * 0.03, ...(detail >= 2 ? { uvScale: [1, 2 / h], uvOffset: [R() * 2, 0] } : {}) }), pos: [X0 + 1 + k * 2, F + 0.03, Z1 + 0.12], mat: MAT.metal, tone: 0.36 + R() * 0.25 });
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
  if (detail >= 2) {
    // A dirty plinth round its foot (splash, oil, boots), proud of the whitewash.
    parts.push({ geo: buildBox(ww + 0.06, 0.55, wd + 0.06), pos: [wcx, F + 0.27, wcz], mat: MAT.concrete, tone: 0.3 });
    // The lamp over the door: a bracket and an enamel shade.
    parts.push(wirePart([wcx - 1, F + 2.62, wz0 - 0.02], [wcx - 1, F + 2.62, wz0 - 0.5], 0.02, { tone: 0.25 }));
    parts.push({ geo: new THREE.ConeGeometry(0.17, 0.12, 10, 1, false).translate(0, -0.06, 0), pos: [wcx - 1, F + 2.6, wz0 - 0.5], mat: MAT.paint, tone: 0.3 });
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
  // Bay 2: the bench against the back wall behind the gantry, its tool board.
  const bx = 0, bz = Z1 - 0.5;
  parts.push({ geo: buildBox(2.6, 0.08, 0.8), pos: [bx, F + 0.9, bz], mat: MAT.timber, tone: 0.32 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ geo: buildBox(0.08, 0.86, 0.08), pos: [bx + sx * 1.2, F + 0.43, bz + sz * 0.33], mat: MAT.timber, tone: 0.3 });
  parts.push({ geo: buildBox(0.22, 0.18, 0.16), pos: [bx - 0.9, F + 1.03, bz - 0.2], mat: MAT.steel, tone: 0.2 });
  parts.push({ geo: buildBox(0.5, 0.2, 0.25), pos: [bx + 0.6, F + 1.04, bz], mat: MAT.paint, tone: 0.4 });
  parts.push({ geo: buildBox(2.3, 1.0, 0.04), pos: [bx, F + 1.75, Z1 + 0.02], mat: MAT.timber, tone: 0.45 });
  // Out on the apron by the shed's open left end: a stack of tyres, one
  // leant on it, and the drums (the garage bay stays clear).
  for (let k = 0; k < 3; k++) parts.push({ geo: new THREE.TorusGeometry(0.42, 0.14, 6, 14).rotateX(Math.PI / 2), pos: [-8.05, F + 0.14 + k * 0.27, -2.2], rot: [0, R(), 0], mat: MAT.rubber, tone: 0.3 });
  parts.push({ geo: new THREE.TorusGeometry(0.42, 0.14, 6, 14), pos: [-8.1, F + 0.55, -3.3], rot: [0.25, 1.3, 0], mat: MAT.rubber, tone: 0.3 });
  for (let k = 0; k < 4; k++) parts.push({ geo: buildOilDrum(), pos: [-8.2 + (k % 2) * 0.62, F, 3.3 - Math.floor(k / 2) * 0.62], rot: [0, R() * 3, 0], mat: MAT.metal, tone: 0.25 + R() * 0.3 });
  // Jerrycans in a row by the workshop door.
  for (let k = 0; k < 6; k++) parts.push({ geo: buildBox(0.17, 0.46, 0.34), pos: [wcx - 2.1 + k * 0.2, F + 0.23, wz0 - 0.45], rot: [0, (R() - 0.5) * 0.15, 0], mat: MAT.paint, tone: 0.28 + R() * 0.1 });

  // THE GARAGE BAY'S DOORS. A steel lintel across the bay under the tie
  // beam; the leaves hang below it, hinged on the columns' fronts.
  const gX0 = cols[2], gX1 = cols[3], gW = gX1 - gX0;            // column centres
  const doorH = EH - 0.5, hingeZ = Z0 - 0.24;
  parts.push({ geo: buildBox(gW + 0.22, 0.34, 0.16), pos: [(gX0 + gX1) / 2, F + doorH + 0.2, Z0 - 0.2], mat: MAT.steel, tone: 0.3 });   // proud of the columns, under the tie: no shared faces
  // The garage is CLOSED on its other sides (doors on an open bay read as
  // nonsense — you, 2026-09-27): a corrugated partition against the open
  // shed, the same cladding outside the end columns, each from the apron up
  // to the roof — sheets to the tie, a flat gable over the tie. Partition on
  // the garage side of its columns, cladding outside hers: never in a column.
  const gable = new THREE.Shape([
    new THREE.Vector2(Z0, 0), new THREE.Vector2(Z1, 0),
    new THREE.Vector2(Z1, underRoof(Z1) - (F + EH - 0.1)), new THREE.Vector2(0, underRoof(0) - (F + EH - 0.1)),
    new THREE.Vector2(Z0, underRoof(Z0) - (F + EH - 0.1)),
  ]);
  const gableGeo = faceted(new THREE.ExtrudeGeometry(gable, { depth: 0.04, bevelEnabled: false }).rotateY(Math.PI / 2));
  for (const [wx, tone] of [[gX0 + 0.14, 0.4], [gX1 + 0.14, 0.34]]) {
    for (let k = 0; k < 4; k++) {
      const h = EH - 0.1 - (k % 2) * 0.04;
      parts.push({ geo: buildCorrugatedPanel({ width: 2.06, height: h, ribs: 12, ribDepth: 0.03, offset: (k % 2) * 0.03, ...(detail >= 2 ? { uvScale: [1, 2 / h], uvOffset: [R() * 2, 0] } : {}) }), pos: [wx + (k % 2) * 0.03, F + 0.03, Z0 + 1 + k * 2], rot: [0, Math.PI / 2, 0], mat: MAT.metal, tone: tone + R() * 0.2 });
    }
    parts.push({ geo: gableGeo.clone(), pos: [wx + 0.05, F + EH - 0.1, 0], mat: MAT.metal, tone: tone - 0.05 });
  }
  const leafW = (gW - 0.22) / 2 - 0.04;                          // clear of the columns and each other
  const doorLeaves = [-1, 1].map((sx) => {
    const lp = [];
    // Corrugated face outside, a steel frame and brace behind it (inside).
    lp.push({ geo: buildCorrugatedPanel({ width: leafW, height: doorH - 0.08, ribs: 14, ribDepth: 0.03, offset: 0 }), pos: [-sx * leafW / 2, 0.05, -0.02], mat: MAT.metal, tone: 0.42 + R() * 0.1 });
    for (const y of [0.12, doorH / 2, doorH - 0.12]) lp.push({ geo: buildBox(leafW, 0.1, 0.06), pos: [-sx * leafW / 2, y, 0.07], mat: MAT.steel, tone: 0.28 });
    for (const x of [0.06, leafW - 0.06]) lp.push({ geo: buildBox(0.1, doorH - 0.02, 0.07), pos: [-sx * x, doorH / 2, 0.08], mat: MAT.steel, tone: 0.3 });   // offset from the rails' faces
    lp.push({ geo: buildBox(0.08, Math.hypot(leafW, doorH / 2) - 0.1, 0.05), pos: [-sx * leafW / 2, doorH * 0.28, 0.13], rot: [0, 0, sx * Math.atan2(leafW, doorH / 2)], mat: MAT.steel, tone: 0.26 });
    // The handle and the drop bolt, outside.
    lp.push({ geo: buildBox(0.06, 0.4, 0.05), pos: [-sx * (leafW - 0.2), 1.2, -0.09], mat: MAT.steel, tone: 0.15 });
    const g = assemble(lp);
    bakeContactAO(g, { cell: 0.1, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
    g.scale(S, S, S);
    // rotation.y that swings the leaf open, OUT of the shed (−Z).
    return { geo: g, pivot: [(sx < 0 ? gX0 + 0.11 : gX1 - 0.11) * S, F * S, hingeZ * S], openYaw: -sx * (Math.PI / 2) };
  });

  const st = [stencilPatch("frArmeeBlack", flatSurface([wcx, F + 2.95, wz0], [0, 0, -1], [-1, 0, 0], 3.4, "frArmeeBlack"), { lift: 0.01 })];
  const geo = finishWithStencils(parts, st, { hx: 11, hz: 5.9, cx: 2.4, cz: 0.2, height: EH + 1.5, ao: { cell: 0.3 } });
  // The bay a vehicle stands in (x, z of its centre line) and the door line.
  geo.userData.gate = { leaves: doorLeaves, width: (gW - 0.22) * S, x: ((gX0 + gX1) / 2) * S, z: Z0 * S, floorY: F * S };
  geo.userData.parts = { doorLeft: doorLeaves[0].geo, doorRight: doorLeaves[1].geo };
  return geo;
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

// ── ALN ─────────────────────────────────────────────────────────────────────
// The other side's language: low, the colour of the mountain, stone and
// brush, half into the ground. Never a straight wall, never whitewash. (The
// French pieces above are the opposite on purpose: the post is the one white
// thing on the map.)

/**
 * Move every vertex by a jitter keyed on its POSITION, so vertices that
 * share a corner (a polyhedron's, a cone's apex, a lathe's seam) move
 * together and the solid stays closed.
 */
function jitterByPosition(g, amt, seed, { flatTop = null } = {}) {
  const p = g.attributes.position;
  const h = (x, y, z, k) => {
    const s = Math.sin(Math.round(x * 1000) * 12.9898 + Math.round(y * 1000) * 39.346 + Math.round(z * 1000) * 78.233 + k * 17.1 + seed * 3.7) * 43758.5453;
    return s - Math.floor(s) - 0.5;
  };
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    let ny = y * (1 + h(x, y, z, 2) * amt * 2);
    if (flatTop != null) ny = Math.min(ny, flatTop);
    p.setXYZ(i, x * (1 + h(x, y, z, 1) * amt * 2), ny, z * (1 + h(x, y, z, 3) * amt * 2));
  }
  return g;
}

/**
 * A CUT BLOCK, weathered (the Roman ruin, 2026-10-07 — you, with a CoH screenshot: ours were perfect
 * sharp boxes): w × h × d, chamfered (below), shaded faceted, its UVs at the kit's 2 m a tile from
 * a random point so no two blocks show the same patch of the texture.
 */
export function ashlarBlock(seed, w, h, d, { chip = null } = {}) {
  const r = rng(seed);
  // A CHAMFERED box: each corner cut back by its own bevel (three points per corner, the hull of
  // the 24): every edge a narrow worn face, one corner in four BITTEN deep. (Pulling a low-poly
  // box's corners in instead made every block a lozenge.) 44 triangles.
  const b0 = chip ?? Math.min(0.07, Math.min(w, h, d) * 0.16);
  const pts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const b = Math.min(b0 * (0.6 + r() * 0.8) * (r() < 0.25 ? 3 : 1), Math.min(w, h, d) * 0.45);
    const X = sx * w / 2, Y = sy * h / 2, Z = sz * d / 2;
    pts.push(new THREE.Vector3(X - sx * b, Y, Z), new THREE.Vector3(X, Y - sy * b, Z), new THREE.Vector3(X, Y, Z - sz * b));
  }
  let g = new ConvexGeometry(pts);
  g.deleteAttribute("normal"); g.deleteAttribute("uv");
  g = faceted(g, { boxUV: true });
  const uv = g.attributes.uv, ou = r() * 2, ov = r() * 2;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + ou, uv.getY(i) + ov);
  return g;
}

/** A field stone, w × h × d: a jittered icosahedron, faceted, its top a little flattened. */
export function fieldStone(seed, w, h, d, detail = 0) {
  if (detail > 0) return crag(seed, w, h, d);
  const g = jitterByPosition(new THREE.IcosahedronGeometry(0.5, detail), 0.22, seed, { flatTop: 0.36 });
  g.scale(w, h / 0.86, d);
  return faceted(g, { boxUV: true });
}

/**
 * A big limestone rock, w × h × d. A detail-1 icosphere read as a polished
 * low-poly gem (seen in the game); this one is finer, pushed in and out by
 * smooth noise over its DIRECTION (lumps and hollows, not spikes), stepped by
 * the stone's bedding planes, its top cut flat, and shaded faceted — the
 * facets small enough to read as fractured rock. ~320 triangles.
 */
function crag(seed, w, h, d) {
  const r = rng(seed);
  let g = new THREE.IcosahedronGeometry(0.5, 2);
  g.deleteAttribute("normal"); g.deleteAttribute("uv");
  g = mergeVertices(g);
  // Six random waves over the sphere's direction: a smooth 3D "noise".
  const waves = Array.from({ length: 6 }, () => {
    const k = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize().multiplyScalar(2 + r() * 5);
    return { k, ph: r() * 6.28, a: 0.05 + r() * 0.06 };
  });
  const p = g.attributes.position, v = new THREE.Vector3();
  const bed = 0.12 + r() * 0.06, tilt = (r() - 0.5) * 0.3;          // bedding: spacing, dip
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = v.clone().normalize();
    let s = 1;
    for (const q of waves) s += Math.sin(n.dot(q.k) + q.ph) * q.a;
    // Bedding planes: the rock steps in slightly at each bed.
    const yb = (v.y + v.x * tilt) / bed;
    s -= (yb - Math.floor(yb) < 0.25 ? 0.05 : 0);
    v.multiplyScalar(s);
    v.y = Math.min(v.y, 0.4 + v.x * tilt * 0.5);                        // weathered flat top
    p.setXYZ(i, v.x * w, Math.max(-0.3, v.y) * h / 0.9, v.z * d);
  }
  return faceted(g, { boxUV: true });
}

/**
 * DRY STONE along a path ([x, z] points): courses of field stones, each
 * course offset half a stone, the stones overlapping so no daylight shows
 * through, a slight batter. How every wall in the Aurès is built — sangars,
 * terraces, gourbis.
 *
 * `groundAt(x, z)` (optional): the wall stands on that ground, each stone
 * on the ground under it — a garden wall down a slope (rtsAlgVillage.js).
 */
export function dryStone(parts, R, pts, { courses = 4, h = 1.1, depth = 0.55, len = 0.5, batter = 0.05, tone = 0.5, closed = false, groundAt = null } = {}) {
  const ch = h / courses;
  const segs = [];
  let total = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, L, s0: total }); total += L;
  }
  const at = (s) => {
    const seg = segs.find((q) => s <= q.s0 + q.L) ?? segs[segs.length - 1];
    const f = Math.min(1, (s - seg.s0) / seg.L);
    return { x: seg.a[0] + (seg.b[0] - seg.a[0]) * f, z: seg.a[1] + (seg.b[1] - seg.a[1]) * f, yaw: Math.atan2(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]) };
  };
  for (let c = 0; c < courses; c++) {
    let s = c % 2 ? len * 0.5 : 0;
    const inset = c * batter;
    while (s < total - 0.05) {
      const l = len * (0.75 + R() * 0.55);
      const mid = Math.min(total - 0.05, s + l / 2);
      const { x, z, yaw } = at(mid);
      // Inset for the batter: along the path's normal, toward its inside.
      const nx = Math.cos(yaw), nz = -Math.sin(yaw);
      const sh = ch * (1.15 + R() * 0.35);
      parts.push({
        geo: fieldStone(Math.floor(R() * 1e6), l + 0.12, sh, depth * (0.8 + R() * 0.35)),
        pos: [x + nx * inset, (groundAt ? groundAt(x, z) : 0) + c * ch + sh * 0.42 - 0.06, z + nz * inset],
        rot: [(R() - 0.5) * 0.12, yaw + Math.PI / 2 + (R() - 0.5) * 0.25, (R() - 0.5) * 0.12],
        mat: MAT.limestone, tone: tone - 0.12 + R() * 0.24,   // one stone's face: the rubble cell is a WALL (its joints read as black blotches on a stone)
      });
      s += l;
    }
  }
}

/** An arc of points round (cx, cz), from angle a0 to a1. */
export function arcPts(cx, cz, rad, a0, a1, n = 10) {
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = a0 + ((a1 - a0) * k) / n;
    return [cx + Math.cos(a) * rad, cz + Math.sin(a) * rad];
  });
}

/**
 * A clump of cut brush — juniper, alfa grass, broom: the ALN's camouflage
 * against the spotter planes. Two or three jittered cones leaning apart,
 * grey-green (moss) or dry (thatch).
 */
export function brushClump(R, x, y, z, { h = 1.2, r = 0.45, dry = false } = {}) {
  const out = [];
  const n = 2 + Math.floor(R() * 2);
  for (let k = 0; k < n; k++) {
    const hh = h * (0.7 + R() * 0.45), rr = r * (0.7 + R() * 0.5);
    // A lumpy ball, smooth-shaded (cones read as little pine trees): shared
    // corners welded first so the jitter keeps it closed and the normals soft.
    let g = new THREE.IcosahedronGeometry(1, 1);
    g.deleteAttribute("normal"); g.deleteAttribute("uv");
    g = mergeVertices(g);
    jitterByPosition(g, 0.3, Math.floor(R() * 1e6));
    g.scale(rr, hh / 2, rr).translate(0, hh * 0.4, 0);
    g.computeVertexNormals();
    const p = g.attributes.position, uvs = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uvs[i * 2] = (p.getX(i) + p.getZ(i)) / 2; uvs[i * 2 + 1] = p.getY(i) / 2; }
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    out.push({
      geo: g,
      pos: [x + (R() - 0.5) * r, y - 0.05, z + (R() - 0.5) * r],
      rot: [(R() - 0.5) * 0.5, R() * 3, (R() - 0.5) * 0.5],
      mat: dry || R() < 0.3 ? MAT.thatch : MAT.moss, tone: 0.3 + R() * 0.3,
    });
  }
  // Bare twigs poking out of the leaves: what says CUT brush, not a bush
  // (lumps alone read as sacks in a row).
  for (let k = 0; k < 3; k++) {
    const a = R() * Math.PI * 2, up = 0.4 + R() * 0.6, len = r * (1.3 + R() * 0.8);
    const b = [x + Math.cos(a) * len, y + h * (0.35 + up * 0.55), z + Math.sin(a) * len];
    out.push(wirePart([x, y + h * 0.3, z], b, 0.018, { mat: MAT.timber, tone: 0.2 + R() * 0.15 }));
  }
  return out;
}

/** A clay water jar (gargoulette): the one made thing at a refuge that isn't a weapon. */
export function clayJar(x, y, z, s = 1) {
  const prof = [[0.001, 0], [0.14, 0.01], [0.2, 0.12], [0.21, 0.26], [0.15, 0.4], [0.07, 0.46], [0.08, 0.52], [0.001, 0.52]]
    .map(([r, yy]) => new THREE.Vector2(r * s, yy * s));
  const g = new THREE.LatheGeometry(prof, 10);
  return { geo: g, pos: [x, y, z], mat: MAT.laterite, tone: 0.6 };
}

/** A rifle lying or leaning: stock (timber) and barrel (steel), from `a` (butt) to `b` (muzzle). */
function rifle(parts, a, b) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const m = A.clone().lerp(B, 0.42);
  parts.push(wirePart(a, m.toArray(), 0.035, { mat: MAT.timber, tone: 0.25 }));
  parts.push(wirePart(m.toArray(), b, 0.014, { tone: 0.12 }));
}

/**
 * CAVE ENTRANCE — the ALN's spawn and reinforcement point, only on rough
 * ground (TODO.md PROPOSAL). A rock shelter: the mouth shored with timber,
 * running back into the dark; big limestone blocks round it and a slab over
 * it; brush heaped on top against the planes; a low stone breastwork across
 * half the mouth; sacks, a crate, a water jar in the entrance.
 */
export function buildCaveEntrance({ seed = 1956 } = {}) {
  const R = rng(seed);
  const parts = [];
  const MW = 3.0, MH = 2.4, TD = 2.6;          // mouth width, height, tunnel depth
  // The rock: flanks, the lintel slab, the mass behind.
  const rock = (w, h, d, x, y, z, ry = 0, tone = 0.45) => parts.push({ geo: fieldStone(Math.floor(R() * 1e6), w, h, d, 1), pos: [x, y, z], rot: [(R() - 0.5) * 0.12, ry, (R() - 0.5) * 0.12], mat: MAT.limestone, tone });
  rock(4.2, 3.6, 4.4, -(MW / 2 + 1.9), 1.5, 1.0, 0.3);
  rock(2.6, 2.2, 2.8, -(MW / 2 + 3.9), 0.8, -0.2, 1.2, 0.5);
  rock(3.8, 3.2, 4.2, MW / 2 + 1.8, 1.35, 1.2, -0.4, 0.4);
  rock(2.2, 1.6, 2.4, MW / 2 + 3.7, 0.55, 0.1, 0.8, 0.5);
  rock(6.2, 1.5, 3.6, 0.1, MH + 0.75, 1.3, 0.05, 0.42);                 // the lintel slab
  rock(10, 5.2, 5.5, 0, 2.3, TD + 3.1, 0, 0.45);                       // the hill behind
  // The tunnel: rubble cheeks and roof, the dark at its end.
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.7, MH, TD), pos: [sx * (MW / 2 + 0.3), MH / 2, TD / 2 + 0.05], mat: MAT.rubble, tone: 0.3 });
  parts.push({ geo: buildBox(MW + 1.3, 0.5, TD), pos: [0, MH + 0.24, TD / 2 + 0.05], mat: MAT.rubble, tone: 0.25 });
  parts.push({ geo: buildBox(MW + 0.2, MH + 0.1, 0.1), pos: [0, MH / 2, TD - 0.02], mat: MAT.steel, tone: 0 });
  // Timber shoring: three sets of posts and caps, into the dark.
  for (let k = 0; k < 3; k++) {
    const z = 0.05 + k * 0.95, w = MW - 0.25 - k * 0.1;
    for (const sx of [-1, 1]) parts.push({ geo: new THREE.CylinderGeometry(0.1, 0.12, MH - 0.05, 7), pos: [sx * w / 2, (MH - 0.05) / 2, z], rot: [0, R(), (R() - 0.5) * 0.05], mat: MAT.timber, tone: 0.2 + k * 0.04 });
    parts.push({ geo: new THREE.CylinderGeometry(0.12, 0.12, w + 0.5, 7), pos: [0, MH - 0.12 - k * 0.02, z], rot: [0, 0, Math.PI / 2 + (R() - 0.5) * 0.04], mat: MAT.timber, tone: 0.18 });
  }
  // A breastwork across half the mouth, the way in on the right.
  dryStone(parts, R, arcPts(-0.9, -0.3, 1.6, Math.PI * 0.55, Math.PI * 1.2, 5), { courses: 3, h: 0.8, depth: 0.5, tone: 0.45 });
  // In the entrance: sacks, a crate, the jar; a bedroll.
  for (let k = 0; k < 3; k++) parts.push({ geo: buildBox(0.66, 0.42 + k * 0.03, 0.46), pos: [0.75 + k * 0.1, 0.2 + k * 0.4, 1.7 - k * 0.05], rot: [0, (R() - 0.5) * 0.4, 0], mat: MAT.hessian, tone: 0.4 + R() * 0.2 });
  parts.push({ geo: buildBox(0.8, 0.4, 0.5), pos: [-0.8, 0.18, 1.9], rot: [0, 0.2, 0], mat: MAT.timber, tone: 0.3 });
  parts.push(clayJar(1.2, -0.02, 0.4));
  parts.push({ geo: new THREE.CylinderGeometry(0.16, 0.16, 1.1, 8), pos: [-0.4, 0.14, 0.9], rot: [0, 0.4, Math.PI / 2], mat: MAT.canvas, tone: 0.35 });
  // Brush on the lintel and the flanks, a juniper standing by the mouth.
  for (const [x, y, z, h] of [[-1.5, MH + 1.3, 1.2, 1.1], [0.8, MH + 1.35, 1.0, 1.2], [2.3, MH + 1.1, 1.8, 0.9], [-3.6, 3.1, 1.5, 1.0], [3.3, 2.7, 1.6, 1.0], [-0.6, MH + 1.2, 2.2, 0.9]]) {
    parts.push(...brushClump(R, x, y, z, { h, r: 0.55 }));
  }
  parts.push(...brushClump(R, 2.3, 0, -1.2, { h: 2.2, r: 0.7 }));
  return finish(parts, { hx: 7.2, hz: 5.6, cz: 1.8, height: 5.2, ao: { cell: 0.3, strength: 0.55 } });
}

/**
 * ARMS CACHE — a matmora: the Aurès's underground grain pit, stone-lined,
 * a flat stone for a lid; the ALN hid its smuggled weapons in them. The lid
 * slid aside, crates brought up, rifles stacked in a tripod; beside it the
 * gourbi — a dry-stone hut roofed with poles, brush and earth — where the
 * guard sleeps. Unlocks MG, mortar and bazooka teams (TODO.md PROPOSAL).
 */
export function buildArmsCache({ seed = 1957 } = {}) {
  const R = rng(seed);
  const parts = [];
  // The gourbi, back left: a ring of dry stone, the door toward the camera.
  const gx = -1.6, gz = 1.2, gw = 3.2, gd = 2.6;
  const x0 = gx - gw / 2, x1 = gx + gw / 2, z0 = gz - gd / 2, z1 = gz + gd / 2;
  dryStone(parts, R, [[gx + 0.45, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0], [gx - 0.45, z0]], { courses: 5, h: 1.6, depth: 0.55, len: 0.48, batter: 0.02, tone: 0.5 });
  // Its roof: poles across, brush on them, earth over the middle.
  for (let k = 0; k < 7; k++) parts.push({ geo: new THREE.CylinderGeometry(0.06, 0.07, gd + 0.7, 6), pos: [x0 + 0.1 + k * (gw - 0.2) / 6, 1.62, gz], rot: [Math.PI / 2, 0, (R() - 0.5) * 0.06], mat: MAT.timber, tone: 0.25 + R() * 0.1 });
  parts.push({ geo: faceted(jitterByPosition(new THREE.CylinderGeometry(1.5, 1.9, 0.35, 8, 1).scale(1.05, 1, 0.85), 0.12, seed), { boxUV: true }), pos: [gx, 1.85, gz], mat: MAT.spoil, tone: 0.45 });
  for (const [x, z] of [[-1.2, -0.8], [0.9, 0.6], [-0.3, 1.1], [1.2, -0.7]]) parts.push(...brushClump(R, gx + x, 1.9, gz + z, { h: 0.6, r: 0.6, dry: true }));
  parts.push({ geo: buildBox(0.8, 1.3, 0.1), pos: [gx, 0.62, z0 + 0.18], mat: MAT.steel, tone: 0.02 });   // the dark doorway
  // The matmora, front right: a ring of stones round the dark, its lid aside.
  const mx = 1.9, mz = -0.9;
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * Math.PI * 2;
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.42, 0.24, 0.3), pos: [mx + Math.cos(a) * 0.62, 0.08, mz + Math.sin(a) * 0.62], rot: [0, -a + Math.PI / 2, 0], mat: MAT.limestone, tone: 0.5 });
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.58, 0.58, 0.1, 14), pos: [mx, 0.04, mz], mat: MAT.steel, tone: 0 });
  parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 1.35, 0.18, 1.2), pos: [mx + 1.05, 0.14, mz - 0.5], rot: [0.08, 0.5, 0.05], mat: MAT.limestone, tone: 0.45 });
  // Crates up from the pit, one open; sacks.
  for (let k = 0; k < 3; k++) parts.push({ geo: buildBox(0.9, 0.36 + k * 0.03, 0.5), pos: [mx - 0.2 + (k === 2 ? 0.1 : 0), 0.17 + k * 0.015 + (k === 2 ? 0.35 : 0), mz + 1.0 + (k === 1 ? 0.55 : 0)], rot: [0, 0.3 + (R() - 0.5) * 0.2, 0], mat: MAT.timber, tone: 0.3 + R() * 0.15 });
  for (let k = 0; k < 2; k++) parts.push({ geo: buildBox(0.66, 0.4 + k * 0.03, 0.46), pos: [mx + 1.1, 0.19, mz + 1.1 + k * 0.5], rot: [0, R(), 0], mat: MAT.hessian, tone: 0.45 });
  // Three rifles stacked in a tripod, muzzles together.
  const top = [mx - 1.1, 1.3, mz - 0.4];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    rifle(parts, [top[0] + Math.cos(a) * 0.45, 0.02, top[2] + Math.sin(a) * 0.45], [top[0] + Math.cos(a) * 0.04, top[1], top[2] + Math.sin(a) * 0.04]);
  }
  parts.push(clayJar(x1 + 0.35, -0.02, z1 - 0.2, 0.9));
  // A juniper grown over the back wall.
  parts.push(...brushClump(R, x0 - 0.3, 0, z1 + 0.3, { h: 2.4, r: 0.8 }));
  return finish(parts, { hx: 4.0, hz: 3.0, cx: 0.2, cz: 0.3, height: 2.4, ao: { cell: 0.2 } });
}

/**
 * SANGAR — a dry-stone C on a hillside, a gun over its lip: the ALN's
 * firing position. Open at the back; brush laid along the top so it is one
 * more heap of stones from the air. The gun (a captured FM 24/29) is its own
 * geometry (`userData.gun`) to traverse.
 */
export function buildSangar({ seed = 1958 } = {}) {
  const R = rng(seed);
  const parts = [];
  const rad = 1.8;
  dryStone(parts, R, arcPts(0, 0, rad, Math.PI * 0.72, Math.PI * 2.28, 12), { courses: 4, h: 1.05, depth: 0.6, batter: 0.06, tone: 0.5 });
  for (const a of [Math.PI * 0.95, Math.PI * 1.3, Math.PI * 1.72, Math.PI * 2.05]) parts.push(...brushClump(R, Math.cos(a) * rad, 0.95, Math.sin(a) * rad, { h: 0.55, r: 0.4, dry: R() < 0.5 }));
  // Stones fallen outside; an ammo box and the jar inside.
  for (let k = 0; k < 4; k++) {
    const a = Math.PI * (0.9 + R() * 1.2);
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.45, 0.26, 0.35), pos: [Math.cos(a) * (rad + 0.7 + R() * 0.4), 0.06, Math.sin(a) * (rad + 0.7 + R() * 0.4)], rot: [0, R() * 3, 0], mat: MAT.limestone, tone: 0.5 });
  }
  parts.push({ geo: buildBox(0.5, 0.26, 0.28), pos: [0.6, 0.11, 0.4], rot: [0, 0.4, 0], mat: MAT.paint, tone: 0.25 });
  parts.push(clayJar(-0.7, -0.02, 0.7, 0.85));
  const geo = finish(parts, { hx: 2.8, hz: 2.8, height: 1.3 });
  // The gun: receiver, barrel with its flash hider, the top magazine, bipod, butt.
  const gun = [];
  gun.push({ geo: buildBox(0.1, 0.13, 0.5), pos: [0, 0, 0.1], mat: MAT.steel, tone: 0.12 });
  gun.push(wirePart([0, 0.02, -0.15], [0, 0.02, -0.85], 0.017, { tone: 0.08 }));
  gun.push({ geo: new THREE.CylinderGeometry(0.03, 0.03, 0.08, 7).rotateX(Math.PI / 2), pos: [0, 0.02, -0.87], mat: MAT.steel, tone: 0.1 });
  gun.push({ geo: buildBox(0.05, 0.2, 0.09), pos: [0, 0.15, 0.02], rot: [-0.25, 0, 0], mat: MAT.steel, tone: 0.18 });
  gun.push({ geo: buildBox(0.07, 0.12, 0.38), pos: [0, -0.03, 0.52], rot: [0.12, 0, 0], mat: MAT.timber, tone: 0.3 });
  for (const sx of [-1, 1]) gun.push(wirePart([0, 0, -0.55], [sx * 0.2, -0.28, -0.72], 0.012, { tone: 0.15 }));
  const gunGeo = assemble(gun);
  bakeContactAO(gunGeo, { cell: 0.06, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
  gunGeo.scale(S, S, S);
  geo.userData.gun = { geo: gunGeo, pivot: [0, 1.28 * S, -(rad - 0.45) * S] };
  geo.userData.parts = { gun: gunGeo };
  return geo;
}

/**
 * AMBUSH SCREEN — cut scrub stood up in a low stone footing between two
 * rocks, along a slope above a track: the ALN's katiba waits behind it,
 * hidden until it fires (TODO.md PROPOSAL). 7 m long, gaps to fire through.
 */
export function buildAmbushScreen({ seed = 1959, length = 7 } = {}) {
  const R = rng(seed);
  const parts = [];
  const L = length / 2;
  const pts = Array.from({ length: 8 }, (_, k) => [-L + (k * length) / 7, Math.sin(k * 0.9 + seed) * 0.25]);
  dryStone(parts, R, pts, { courses: 2, h: 0.5, depth: 0.5, len: 0.45, batter: 0.03, tone: 0.45 });
  // The screen: clumps stood in the footing, a firing gap every ~2 m.
  // Dense and mostly green: a hedge of cut scrub, not a row of lumps.
  for (let s = -L + 0.3; s < L - 0.2; s += 0.4 + R() * 0.15) {
    if (Math.abs(((s + L) % 2.1) - 1.05) < 0.22) continue;
    parts.push(...brushClump(R, s, 0.35, Math.sin(((s + L) / length) * 7 * 0.9 + seed) * 0.25 + (R() - 0.5) * 0.15, { h: 1.0 + R() * 0.45, r: 0.55, dry: R() < 0.12 }));
  }
  // The rocks it runs between.
  for (const [x, w, h] of [[-L - 1.0, 2.2, 1.7], [L + 0.9, 1.8, 1.3]]) parts.push({ geo: fieldStone(Math.floor(R() * 1e6), w, h, w * 0.9, 1), pos: [x, h * 0.36, 0.1], rot: [0, R() * 3, 0], mat: MAT.limestone, tone: 0.45 });
  // Behind it: a flattened place in the brush, a water skin, spent cases' box.
  parts.push({ geo: buildBox(0.4, 0.22, 0.26), pos: [0.8, 0.1, 0.9], rot: [0, 0.5, 0], mat: MAT.paint, tone: 0.25 });
  parts.push(clayJar(-1.6, -0.02, 0.8, 0.8));
  return finish(parts, { hx: L + 2.2, hz: 1.6, cz: 0.3, height: 1.8 });
}

/**
 * MINE MARKER — where the ALN laid a mine: a low mound of turned earth and
 * the three-stone cairn the fighters marked their own mines with. The owner
 * sees it; the French must find it (nam's per-man roll, TODO.md).
 */
export function buildMineMarker({ seed = 1960 } = {}) {
  const R = rng(seed);
  const parts = [];
  parts.push({ geo: earthBerm([[0.75, -0.1], [0.58, 0.08], [0.32, 0.14], [0.001, 0.15]], { seed, segs: 14, rJit: 0.08, yJit: 0.02 }), mat: MAT.spoil, tone: 0.45 });
  const cx = 0.75, cz = 0.35;
  // The cairn: three stones stacked knee-high, big enough to see from the
  // camera (the first, ankle-high, vanished at play zoom).
  parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.5, 0.3, 0.42), pos: [cx, 0.1, cz], rot: [0, R() * 3, 0], mat: MAT.limestone, tone: 0.55 });
  parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.4, 0.26, 0.34), pos: [cx + 0.03, 0.33, cz + 0.02], rot: [0.1, R() * 3, 0.05], mat: MAT.limestone, tone: 0.5 });
  parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.28, 0.22, 0.24), pos: [cx - 0.02, 0.52, cz], rot: [0.2, R() * 3, 0.1], mat: MAT.limestone, tone: 0.6 });
  return finish(parts, { hx: 1.2, hz: 0.9, cx: 0.35, cz: 0.15, height: 0.7 });
}

/**
 * REFUGE (casemate) — the ALN's hidden shelter dug into a hillside: a low
 * mound of earth and brush, its mouth framed by two dry-stone cheeks and a
 * timber lintel, a dark opening, a few stones and a water jar by it. From
 * the air, one more scrubby hummock. The bands go to ground here (alg-rts
 * algAI.js). Front (the mouth) at -Z.
 */
export function buildRefuge({ seed = 1997 } = {}) {
  const R = rng(seed);
  const parts = [];
  // The mound: earth, the brush laid over it.
  parts.push({ geo: earthBerm([[3.2, -0.15], [2.7, 0.7], [1.8, 1.35], [0.001, 1.6]], { seed, segs: 18, rJit: 0.25, yJit: 0.12 }), pos: [0, 0, 0.6], mat: MAT.spoil, tone: 0.38 });
  for (let k = 0; k < 7; k++) {
    const a = R() * Math.PI * 2, r = 0.6 + R() * 1.6;
    parts.push(...brushClump(R, Math.cos(a) * r, 1.35 - r * 0.35, 0.6 + Math.sin(a) * r, { h: 0.7, r: 0.5, dry: R() < 0.4 }));
  }
  // The mouth: stone cheeks, a lintel, the dark opening.
  dryStone(parts, R, [[-1.0, -1.9], [-0.95, -0.9]], { courses: 3, h: 1.0, depth: 0.45, len: 0.45, tone: 0.45 });
  dryStone(parts, R, [[1.0, -1.9], [0.95, -0.9]], { courses: 3, h: 1.0, depth: 0.45, len: 0.45, tone: 0.45 });
  parts.push({ geo: buildBox(2.4, 0.18, 0.22), pos: [0, 1.08, -1.75], rot: [0, 0, 0.03], mat: MAT.timber, tone: 0.2 });
  parts.push({ geo: buildBox(1.5, 0.95, 0.06), pos: [0, 0.5, -1.25], mat: MAT.steel, tone: 0.0 });
  parts.push(clayJar(1.45, -0.02, -2.2, 0.9));
  for (let k = 0; k < 3; k++) parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.4, 0.26, 0.34), pos: [-1.6 + R() * 0.4, 0.08, -2.3 + R() * 0.5], rot: [R(), R() * 3, R()], mat: MAT.limestone, tone: 0.45 });
  return finish(parts, { hx: 3.4, hz: 3.4, cz: 0.2, height: 1.8, ao: { strength: 0.35 } });
}

/**
 * LOOKOUT (guetteur's post) — a ring of piled stones on a crest, waist-high,
 * a brush shade on two poles over it, a water skin: where an ALN watcher sits
 * all day and signals the bands when the French move (alg-rts algAI.js: the
 * AI only knows what its men and lookouts see).
 */
export function buildLookout({ seed = 1998 } = {}) {
  const R = rng(seed);
  const parts = [];
  dryStone(parts, R, arcPts(0, 0, 1.25, Math.PI * 0.62, Math.PI * 2.38, 10), { courses: 2, h: 0.75, depth: 0.5, len: 0.45, tone: 0.48 });
  for (const sx of [-1, 1]) parts.push({ geo: new THREE.CylinderGeometry(0.04, 0.05, 1.9, 5).translate(0, 0.95, 0), pos: [sx * 0.95, 0, 0.75], rot: [0.05, 0, sx * 0.05], mat: MAT.timber, tone: 0.25 });
  parts.push({ geo: buildBox(2.3, 0.12, 1.4), pos: [0, 1.88, 0.35], rot: [-0.22, 0, 0], mat: MAT.thatch, tone: 0.35 });
  parts.push(...brushClump(R, 0.4, 1.9, 0.6, { h: 0.45, r: 0.5, dry: true }));
  parts.push(clayJar(-0.5, -0.02, 0.4, 0.8));
  return finish(parts, { hx: 1.7, hz: 1.7, height: 2.1, ao: { strength: 0.3 } });
}

// ── THE LAND AT WAR ─────────────────────────────────────────────────────────

/**
 * RUBBLE HEAP — what a shell leaves against a village house (alg-rts
 * algDamage.js): broken stone and lumps of plaster from the wall, a charred
 * roof beam sticking out, all in a low heap ~2.6 m across. One merged piece;
 * the game instances it, so a shelled village costs one draw however many
 * houses are hit.
 */
export function buildRubbleHeap({ seed = 1961 } = {}) {
  const R = rng(seed);
  const parts = [];
  // The core: a low spoil mound the stones sit in (nothing floats).
  parts.push({ geo: earthBerm([[1.25, -0.1], [0.95, 0.16], [0.5, 0.36], [0.001, 0.42]], { seed, segs: 16, rJit: 0.12, yJit: 0.05 }), mat: MAT.spoil, tone: 0.35 });
  for (let k = 0; k < 9; k++) {
    const a = R() * Math.PI * 2, r = R() * 0.9, w = 0.3 + R() * 0.35;
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), w, w * 0.6, w * 0.8), pos: [Math.cos(a) * r, 0.42 - r * 0.32, Math.sin(a) * r], rot: [R() * 0.6, R() * 3, R() * 0.6], mat: MAT.limestone, tone: 0.3 + R() * 0.2 });
  }
  // Plaster lumps from the wall face.
  for (let k = 0; k < 4; k++) {
    const a = R() * Math.PI * 2, r = 0.3 + R() * 0.7;
    parts.push({ geo: buildBox(0.35 + R() * 0.25, 0.12, 0.25 + R() * 0.2), pos: [Math.cos(a) * r, 0.4 - r * 0.28, Math.sin(a) * r], rot: [(R() - 0.5) * 0.7, R() * 3, (R() - 0.5) * 0.7], mat: MAT.plaster, tone: 0.3 });
  }
  // The roof beam, burnt black, its end in the air.
  parts.push({ geo: buildBox(0.14, 0.14, 2.2), pos: [0.2, 0.55, 0.1], rot: [0.32, 0.7, 0.05], mat: MAT.timber, tone: 0.05 });
  return finish(parts, { hx: 1.3, hz: 1.3, height: 0.8, ao: { strength: 0.35 } });
}

/**
 * FUEL DEPOT — a supply point's fuel (alg-rts, 2026-10-04: the points read on
 * the ground, CoH's depots): drums standing in a block, two on their sides on
 * timber chocks, a row of jerrycans, a knee-high sandbag wall on two sides.
 * The flag is the game's (its own cloth, algPointFlags.js).
 */
export function buildFuelDepot({ seed = 2201 } = {}) {
  const R = rng(seed);
  const parts = [];
  for (let k = 0; k < 6; k++) {
    parts.push({ geo: buildOilDrum(), pos: [-0.9 + (k % 3) * 0.64 + (R() - 0.5) * 0.05, 0, -0.35 + Math.floor(k / 3) * 0.64 + (R() - 0.5) * 0.05], rot: [0, R() * 3, 0], mat: MAT.metal, tone: 0.2 + R() * 0.3 });
  }
  // Two on their sides, on chocks.
  for (const z of [0.95, 1.45]) {
    parts.push({ geo: buildBox(0.12, 0.12, 0.45), pos: [-0.45, 0.06, z], mat: MAT.timber, tone: 0.35 });
    parts.push({ geo: buildBox(0.12, 0.12, 0.45), pos: [0.35, 0.06, z], mat: MAT.timber, tone: 0.35 });
  }
  parts.push({ geo: buildOilDrum(), pos: [-0.5, 0.42, 1.2], rot: [0, 0, Math.PI / 2], mat: MAT.metal, tone: 0.3 + R() * 0.2 });
  // Jerrycans in a row.
  for (let k = 0; k < 5; k++) parts.push({ geo: buildBox(0.17, 0.46, 0.34), pos: [1.25, 0.23, -0.6 + k * 0.38], rot: [0, (R() - 0.5) * 0.15, 0], mat: MAT.paint, tone: 0.28 + R() * 0.1 });
  // A low sandbag wall on two sides.
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  parts.push({ geo: buildSandbagWall({ length: 3.2, courses: 2, seed: seed + 7, bag }), pos: [0, 0, -1.05], mat: null });
  parts.push({ geo: buildSandbagWall({ length: 2.6, courses: 2, seed: seed + 9, bag }), pos: [-1.65, 0, 0.3], rot: [0, Math.PI / 2, 0], mat: null });
  const geo = finish(parts, { hx: 1.9, hz: 1.9, height: 1.0 });
  return geo;
}

/**
 * AMMUNITION DUMP — a supply point's munitions: green-painted crates stacked
 * on a timber pallet, a few loose ones, a knee-high sandbag wall on two sides.
 */
export function buildAmmoDump({ seed = 2202 } = {}) {
  const R = rng(seed);
  const parts = [];
  parts.push({ geo: buildBox(2.2, 0.12, 1.3), pos: [0, 0.06, 0], mat: MAT.timber, tone: 0.38 });
  for (let layer = 0; layer < 3; layer++) {
    const n = 4 - layer;
    for (let k = 0; k < n; k++) {
      const w = 0.5, h = 0.3, d = 0.32;
      parts.push({ geo: buildBox(w, h, d), pos: [-0.75 + k * 0.52 + layer * 0.26 + (R() - 0.5) * 0.03, 0.12 + h / 2 + layer * (h + 0.01), -0.3 + (R() - 0.5) * 0.04], rot: [0, (R() - 0.5) * 0.06, 0], mat: MAT.paint, tone: 0.22 + R() * 0.1 });
      parts.push({ geo: buildBox(w, h, d), pos: [-0.75 + k * 0.52 + layer * 0.26 + (R() - 0.5) * 0.03, 0.12 + h / 2 + layer * (h + 0.01), 0.1 + (R() - 0.5) * 0.04], rot: [0, (R() - 0.5) * 0.06, 0], mat: MAT.paint, tone: 0.22 + R() * 0.1 });
    }
  }
  // Loose crates by the pallet, one open lid leaning on it.
  // (spaced and each its own height: two equal tops touching flickered — the coplanar test)
  for (let k = 0; k < 3; k++) { const h = 0.28 + k * 0.03; parts.push({ geo: buildBox(0.5, h, 0.32), pos: [1.5 + (k % 2) * 0.1, h / 2, -0.6 + k * 0.62], rot: [0, 0.3 + R() * 0.6, 0], mat: MAT.paint, tone: 0.24 + R() * 0.08 }); }
  parts.push({ geo: buildBox(0.5, 0.03, 0.32), pos: [1.95, 0.25, 0.6], rot: [0, 0.4, 1.0], mat: MAT.timber, tone: 0.4 });
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  parts.push({ geo: buildSandbagWall({ length: 3.2, courses: 2, seed: seed + 7, bag }), pos: [0, 0, -1.05], mat: null });
  parts.push({ geo: buildSandbagWall({ length: 2.4, courses: 2, seed: seed + 9, bag }), pos: [-1.65, 0, 0.2], rot: [0, Math.PI / 2, 0], mat: null });
  return finish(parts, { hx: 2.2, hz: 1.6, height: 1.1 });
}

/**
 * ROCK OUTCROP — a cluster of limestone crags breaking out of a hillside,
 * 1-3 m high, the biggest leaning on the others: hard cover on open slopes
 * (alg-rts algLandmarks.js instances a few seeds of it across the map). The
 * crags reach 0.4 m below y = 0 so a sloping hillside never shows under them.
 */
export function buildRockOutcrop({ seed = 2000 } = {}) {
  const R = rng(seed);
  const parts = [];
  const n = 3 + Math.floor(R() * 3);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + R() * 0.8, r = k === 0 ? 0 : 1.1 + R() * 1.2;
    const w = (k === 0 ? 2.6 : 1.3 + R() * 1.1), h = (k === 0 ? 2.4 : 0.9 + R() * 1.2);
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), w, h, w * (0.7 + R() * 0.3), 1), pos: [Math.cos(a) * r, h * 0.32 - 0.4, Math.sin(a) * r], rot: [(R() - 0.5) * 0.3, R() * 3, (R() - 0.5) * 0.3], mat: MAT.limestone, tone: 0.42 + R() * 0.16 });
  }
  return finish(parts, { hx: 2.6, hz: 2.6, height: 2.6, ao: { strength: 0.3 } });
}

/**
 * TELEGRAPH POLE — the PTT line along the pistes: a tarred pole, a crossarm
 * with four white insulators, a brace. Instanced along the tracks by the game
 * (alg-rts algPoles.js); `userData.wires` gives the four insulator tops
 * (scaled, local) the wires hang from.
 */
export function buildTelegraphPole({ seed = 1962 } = {}) {
  const R = rng(seed);
  const parts = [];
  const H = 7, armY = 6.55;
  parts.push({ geo: new THREE.CylinderGeometry(0.085, 0.12, H, 7).translate(0, H / 2, 0), rot: [0, R() * 3, 0], mat: MAT.timber, tone: 0.18 });
  parts.push({ geo: buildBox(1.5, 0.1, 0.1), pos: [0, armY, 0.13], mat: MAT.timber, tone: 0.25 });
  // The brace: pole to arm, one side.
  parts.push(wirePart([0, armY - 0.65, 0.1], [0.45, armY - 0.05, 0.13], 0.025, { mat: MAT.steel, tone: 0.3 }));
  const ins = [-0.62, -0.22, 0.22, 0.62];
  for (const x of ins) {
    parts.push({ geo: new THREE.CylinderGeometry(0.035, 0.05, 0.14, 6).translate(0, 0.07, 0), pos: [x, armY + 0.05, 0.13], mat: MAT.white, tone: 0.8 });
  }
  const geo = finish(parts, { hx: 0.8, hz: 0.3, height: H, ao: { strength: 0.15 } });
  geo.userData.wires = ins.map((x) => [x * S, (armY + 0.2) * S, 0.13 * S]);
  return geo;
}

// ── FRENCH, continued ───────────────────────────────────────────────────────

/**
 * SEARCHLIGHT TOWER — steel, not the mirador's timber: four angle-iron legs
 * braced in three bays, a grated platform with its rail, a caged ladder, and
 * on top the 60 cm searchlight that sweeps the wire at night. The generator
 * shed at its foot, the cable run up a leg. The lamp is its own geometry
 * (`userData.lamp`, pivot at its yoke) so the game can sweep it; its beam
 * leaves along the lamp's local -Z.
 */
export function buildSearchlightTower({ seed = 37 } = {}) {
  const R = rng(seed);
  const parts = [];
  const B = 1.7, T = 0.75, H = 9;                // leg spread at the foot, at the top; platform height
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const at = (sx, sz, f) => [sx * (B + (T - B) * f), H * f, sz * (B + (T - B) * f)];
  for (const [sx, sz] of legs) {
    parts.push({ geo: buildBox(0.5, 0.3, 0.5), pos: [sx * B, 0.1, sz * B], mat: MAT.concrete, tone: 0.5 });
    parts.push(wirePart([sx * B, 0.2, sz * B], at(sx, sz, 1.0), 0.07, { tone: 0.32 }));
  }
  const bays = [0.03, 0.36, 0.68, 1.0];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
    for (let b = 0; b < 3; b++) {
      parts.push(wirePart(at(ax, az, bays[b]), at(bx, bz, bays[b + 1]), 0.028, { tone: 0.35 }));
      if (b) parts.push(wirePart(at(ax, az, bays[b]), at(bx, bz, bays[b]), 0.034, { tone: 0.33 }));
    }
  }
  // The platform: grating on bearers, the rail with a mid-rail and kick plate.
  const P = T + 0.55;
  parts.push({ geo: buildBox(2 * P, 0.08, 2 * P), pos: [0, H + 0.04, 0], mat: MAT.steel, tone: 0.3 });
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.1, 0.14, 2 * P + 0.2), pos: [sx * T, H - 0.07, 0], mat: MAT.steel, tone: 0.25 });
  const rail = [[-P, -P], [P, -P], [P, P], [-P, P]];
  for (const [x, z] of rail) parts.push(wirePart([x, H + 0.08, z], [x, H + 1.1, z], 0.025, { tone: 0.35 }));
  for (let i = 0; i < 4; i++) {
    const [ax, az] = rail[i], [bx, bz] = rail[(i + 1) % 4];
    if (i === 2) continue;                                   // the back: the ladder comes up here
    parts.push(wirePart([ax, H + 1.08, az], [bx, H + 1.08, bz], 0.022, { tone: 0.35 }));
    parts.push(wirePart([ax, H + 0.6, az], [bx, H + 0.6, bz], 0.016, { tone: 0.35 }));
  }
  // The ladder up the back (+Z), its safety cage from 2.5 m.
  const lz = T + 0.6;
  for (const sx of [-0.22, 0.22]) parts.push(wirePart([sx, 0, lz + 0.35], [sx, H + 1.0, lz - 0.05], 0.022, { tone: 0.3 }));
  for (let k = 1; k < 30; k++) {
    const f = k / 30;
    parts.push(wirePart([-0.22, H * f, lz + 0.35 - 0.4 * f], [0.22, H * f, lz + 0.35 - 0.4 * f], 0.012, { tone: 0.35 }));
  }
  for (let k = 0; k < 8; k++) {
    const y = 2.5 + k * 0.9, z = lz + 0.35 - 0.4 * (y / H);
    parts.push({ geo: new THREE.TorusGeometry(0.38, 0.014, 4, 10, Math.PI), pos: [0, y, z], rot: [Math.PI / 2, 0, 0], mat: MAT.steel, tone: 0.35 });
  }
  // The generator shed at the foot, its exhaust, the cable up the right-front leg.
  const gx = B + 1.8, gz = -0.6;
  parts.push({ geo: buildBox(1.9, 1.5, 1.3), pos: [gx, 0.73, gz], mat: MAT.metal, tone: 0.45 });
  parts.push({ geo: buildBox(2.2, 0.08, 1.6), pos: [gx, 1.53, gz], rot: [0.1, 0, 0], mat: MAT.metal, tone: 0.35 });
  parts.push({ geo: buildBox(0.8, 1.2, 0.05), pos: [gx - 0.3, 0.62, gz - 0.68], mat: MAT.paint, tone: 0.35 });
  parts.push(wirePart([gx + 0.6, 1.4, gz + 0.3], [gx + 0.6, 2.6, gz + 0.3], 0.045, { tone: 0.12 }));
  parts.push({ geo: new THREE.ConeGeometry(0.1, 0.12, 8), pos: [gx + 0.6, 2.66, gz + 0.3], mat: MAT.steel, tone: 0.15 });
  parts.push(wirePart([gx - 0.95, 0.5, gz + 0.2], [B + 0.08, 0.5, -B + 0.1], 0.02, { mat: MAT.rubber, tone: 0.3 }));
  parts.push(wirePart([B + 0.08, 0.5, -B + 0.1], [T + 0.08, H - 0.1, -T + 0.1], 0.02, { mat: MAT.rubber, tone: 0.3 }));
  for (let k = 0; k < 3; k++) parts.push({ geo: buildOilDrum(), pos: [gx + 0.3 + k * 0.62, 0, gz + 1.3], rot: [0, R() * 3, 0], mat: MAT.metal, tone: 0.3 + R() * 0.25 });
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  parts.push({ geo: buildSandbagWall({ length: 2.6, courses: 3, seed: seed + 1, bag }), pos: [gx, 0, gz - 1.25], mat: null });
  const geo = finish(parts, { hx: 3.6, hz: 2.6, cx: 1.1, cz: 0.2, height: H + 2, ao: { cell: 0.25, strength: 0.4 } });

  // The lamp: yoke on a turntable, the drum, lens, rear cap, cooling rings.
  const lamp = [];
  lamp.push({ geo: new THREE.CylinderGeometry(0.22, 0.26, 0.12, 12), pos: [0, 0.06, 0], mat: MAT.steel, tone: 0.2 });
  for (const sx of [-1, 1]) lamp.push({ geo: buildBox(0.06, 0.55, 0.12), pos: [sx * 0.41, 0.38, 0], mat: MAT.steel, tone: 0.2 });
  lamp.push({ geo: buildBox(0.84, 0.07, 0.14), pos: [0, 0.135, 0], mat: MAT.steel, tone: 0.22 });
  lamp.push({ geo: new THREE.CylinderGeometry(0.34, 0.34, 0.62, 16).rotateX(Math.PI / 2), pos: [0, 0.6, 0], mat: MAT.paint, tone: 0.4 });
  lamp.push({ geo: new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16).rotateX(Math.PI / 2), pos: [0, 0.6, -0.32], mat: MAT.white, tone: 0.95 });
  lamp.push({ geo: new THREE.CylinderGeometry(0.37, 0.37, 0.04, 16, 1, true).rotateX(Math.PI / 2), pos: [0, 0.6, -0.3], mat: MAT.steel, tone: 0.15 });
  lamp.push({ geo: new THREE.CylinderGeometry(0.2, 0.33, 0.16, 16).rotateX(-Math.PI / 2), pos: [0, 0.6, 0.39], mat: MAT.paint, tone: 0.35 });
  for (let k = 0; k < 3; k++) lamp.push({ geo: new THREE.TorusGeometry(0.35, 0.012, 4, 16), pos: [0, 0.6, -0.12 + k * 0.14], mat: MAT.steel, tone: 0.2 });
  const lampGeo = assemble(lamp);
  bakeContactAO(lampGeo, { cell: 0.06, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
  lampGeo.scale(S, S, S);
  geo.userData.lamp = { geo: lampGeo, pivot: [0, (H + 0.08) * S, -0.35 * S], beam: [0, 0.6 * S, -0.35 * S] };
  geo.userData.parts = { lamp: lampGeo };
  return geo;
}

/**
 * SAS POST — a Section Administrative Spécialisée: the French army's
 * civil-military post IN a village — a school, a free clinic, the officer
 * who ran the douar, a few harkis on guard. Not a forward base: the French
 * side's lever on a hamlet's support (TODO.md PROPOSAL). A whitewashed
 * building with a tiled roof and a veranda, "S.A.S." over the school door
 * and a medical cross over the clinic's; a walled yard with its gate, a
 * well, a water tank on its stand, the flagpole (`userData.flagMount`), a
 * sandbagged corner, the radio mast. Front (the gate) at local -Z.
 */
export function buildSasPost({ seed = 41 } = {}) {
  const R = rng(seed);
  const parts = [];
  const WX = 11, WZ = 8, WT = 0.35, WH = 1.6;    // yard half-sizes, wall thickness, height
  // The yard wall: front and back full width, the sides between (lower and
  // thinner, so no face of one is flush with a face of the other).
  const wall = (x0, x1, z, h, t) => parts.push({ geo: buildBox(x1 - x0, h, t), pos: [(x0 + x1) / 2, h / 2 - 0.05, z], mat: MAT.white, tone: 0.55 + R() * 0.08 });
  const G = 1.75;                                              // half the gate
  wall(-WX - WT / 2, -G, -WZ, WH, WT);
  wall(G, WX + WT / 2, -WZ, WH, WT);
  wall(-WX - WT / 2, WX + WT / 2, WZ, WH, WT);
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(WT - 0.02, WH - 0.04, 2 * WZ - WT - 0.02), pos: [sx * WX, (WH - 0.04) / 2 - 0.05, 0], mat: MAT.white, tone: 0.56 });
  // Gate pillars with caps, a timber gate standing open.
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildBox(0.6, 2.3, 0.6), pos: [sx * (G + 0.2), 1.1, -WZ], mat: MAT.white, tone: 0.62 });
    parts.push({ geo: buildBox(0.74, 0.12, 0.74), pos: [sx * (G + 0.2), 2.29, -WZ], mat: MAT.concrete, tone: 0.55 });
  }
  parts.push({ geo: buildBox(1.6, 1.5, 0.07).translate(0.8, 0, 0), pos: [-G + 0.1, 0.85, -WZ + 0.35], rot: [0, -1.25, 0], mat: MAT.timber, tone: 0.35 });

  // The building: 12 × 6, walls 3.6, a tiled gable roof.
  const BZ = 2.2, BD = 6, BW = 12, BH = 3.6;
  parts.push({ geo: buildBox(BW, BH + 0.05, BD), pos: [0, (BH + 0.05) / 2 - 0.05, BZ], mat: MAT.white, tone: 0.62 });
  const rise = 1.35, half = BD / 2 + 0.45, slope = Math.hypot(half, rise), pitch = Math.atan2(rise, half);
  for (const sz of [-1, 1]) {
    parts.push({ geo: buildBox(BW + 0.7 + (sz > 0 ? 0.04 : 0), 0.14, slope), pos: [0, BH + rise / 2 - 0.02, BZ + sz * half / 2], rot: [sz * pitch, 0, 0], mat: MAT.tile, tone: 0.5 });
  }
  parts.push({ geo: buildBox(BW + 0.8, 0.14, 0.3), pos: [0, BH + rise + 0.06, BZ], mat: MAT.tile, tone: 0.4 });
  const gable = new THREE.Shape([new THREE.Vector2(-BD / 2, 0), new THREE.Vector2(BD / 2, 0), new THREE.Vector2(0, rise - 0.05)]);
  for (const sx of [-1, 1]) {
    const g = faceted(new THREE.ExtrudeGeometry(gable, { depth: 0.3, bevelEnabled: false }).rotateY(Math.PI / 2), { boxUV: true });
    parts.push({ geo: g, pos: [sx * (BW / 2 - 0.02) - (sx > 0 ? 0.3 : 0), BH - 0.02, BZ], mat: MAT.white, tone: 0.6 });
  }
  // The veranda along the front: its floor, four columns, a tiled lean-to roof.
  const VZ = BZ - BD / 2 - 1.3;
  parts.push({ geo: buildBox(BW + 0.6, 0.28, 2.7), pos: [0, 0.09, VZ + 0.05], mat: MAT.concrete, tone: 0.55 });
  for (const x of [-5.9, -2, 2, 5.9]) parts.push({ geo: buildBox(0.32, 2.85, 0.32), pos: [x, 0.23 + 1.425, VZ - 1.05], mat: MAT.white, tone: 0.66 });
  parts.push({ geo: buildBox(BW + 0.9, 0.12, 3.0), pos: [0, 3.12, VZ + 0.15], rot: [-0.12, 0, 0], mat: MAT.tile, tone: 0.45 });
  // Doors (school left, clinic right), windows with open shutters.
  const fz = BZ - BD / 2 - 0.04;
  for (const x of [-3, 3]) parts.push({ geo: buildBox(1.15, 2.2, 0.08), pos: [x, 0.23 + 1.1, fz], mat: MAT.timber, tone: 0.3 });
  for (const x of [-5, -0.95, 0.95, 5]) {
    parts.push({ geo: buildBox(0.85, 1.15, 0.06), pos: [x, 1.9, fz + 0.01], mat: MAT.steel, tone: 0.05 });
    for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.42, 1.17, 0.04).translate(sx * 0.21, 0, 0), pos: [x + sx * 0.45, 1.9, fz - 0.04], rot: [0, sx * -1.95, 0], mat: MAT.timber, tone: 0.5 });
  }
  // The yard: the well, the water tank on its stand, the flag's plinth,
  // a sandbagged corner, benches.
  const wx = -6.5, wz = -4.5;
  const well = new THREE.LatheGeometry([[0.72, -0.05], [0.72, 0.8], [0.56, 0.8], [0.56, 0.45]].map(([r, y]) => new THREE.Vector2(r, y)), 14);
  parts.push({ geo: well, pos: [wx, 0, wz], mat: MAT.white, tone: 0.6 });
  parts.push({ geo: new THREE.CylinderGeometry(0.57, 0.57, 0.06, 14), pos: [wx, 0.47, wz], mat: MAT.steel, tone: 0 });
  for (const sx of [-1, 1]) parts.push(wirePart([wx + sx * 0.66, 0.78, wz], [wx + sx * 0.6, 2.0, wz], 0.05, { mat: MAT.timber, tone: 0.3 }));
  parts.push(wirePart([wx - 0.7, 1.95, wz], [wx + 0.7, 1.95, wz], 0.045, { mat: MAT.timber, tone: 0.28 }));
  parts.push(wirePart([wx, 1.93, wz], [wx, 1.3, wz], 0.006, { tone: 0.3 }));
  parts.push({ geo: new THREE.CylinderGeometry(0.13, 0.1, 0.22, 8), pos: [wx, 1.2, wz], mat: MAT.metal, tone: 0.3 });
  const tx = 8.3, tz = 5.3, tH = 4.1;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push(wirePart([tx + sx * 0.85, 0, tz + sz * 0.85], [tx + sx * 0.7, tH, tz + sz * 0.7], 0.05, { tone: 0.3 }));
  parts.push({ geo: buildBox(1.9, 0.1, 1.9), pos: [tx, tH + 0.03, tz], mat: MAT.steel, tone: 0.3 });
  parts.push({ geo: new THREE.CylinderGeometry(1.05, 1.05, 1.55, 16), pos: [tx, tH + 0.84, tz], mat: MAT.metal, tone: 0.45 });
  parts.push({ geo: new THREE.ConeGeometry(1.1, 0.3, 16), pos: [tx, tH + 1.76, tz], mat: MAT.metal, tone: 0.35 });
  parts.push({ geo: buildBox(0.8, 0.5, 0.8), pos: [0, 0.2, -4.2], mat: MAT.white, tone: 0.6 });
  const bag = { length: 0.55, width: 0.32, height: 0.2, segU: 6, segV: 4 };
  parts.push({ geo: buildSandbagWall({ length: 3.2, courses: 5, seed: seed + 1, bag }), pos: [WX - 2.3, 0, -WZ + 1.3], mat: null });
  parts.push({ geo: buildSandbagWall({ length: 2.6, courses: 5, seed: seed + 2, bag }), pos: [WX - 3.85, 0, -WZ + 2.55], rot: [0, Math.PI / 2, 0], mat: null });
  for (const x of [-4.2, 4.2]) parts.push({ geo: buildBox(1.8, 0.1, 0.4), pos: [x, 0.66, VZ + 0.4], mat: MAT.timber, tone: 0.4 }, { geo: buildBox(1.6, 0.4, 0.3), pos: [x, 0.43, VZ + 0.4], mat: MAT.timber, tone: 0.3 });
  // The radio mast off the roof, guyed.
  const mx = 4.5, mz = BZ + 1.8, mBase = BH + 0.5;
  parts.push(wirePart([mx, mBase, mz], [mx, mBase + 7, mz], 0.04, { tone: 0.35 }));
  for (const [dx, dz] of [[-2.5, 1], [2.2, 0.8], [0.3, -2.4]]) parts.push(wirePart([mx, mBase + 5.5, mz], [mx + dx, BH + 0.4, mz + dz], 0.006, { tone: 0.4 }));

  // Markings: the S.A.S. board over the school, the cross over the clinic,
  // a little tricolour board over the gate.
  const st = [
    stencilPatch("frSasSign", flatSurface([-3, 2.95, fz - 0.005], [0, 0, -1], [-1, 0, 0], 1.7, "frSasSign"), { lift: 0.01 }),
    stencilPatch("medicCross", flatSurface([3, 2.9, fz - 0.005], [0, 0, -1], [-1, 0, 0], 0.55, "medicCross"), { lift: 0.01 }),
  ];
  const geo = finishWithStencils(parts, st, { hx: WX + 0.6, hz: WZ + 0.6, height: BH + rise + 2 });
  // Vegetation clears under the WHOLE walled compound (its footprint): with
  // only the house cleared, the oasis's wild palms and grass grew inside
  // the yard walls (you, 2026-09-29 — no plant inside a building).
  geo.userData.flagMount = { pos: [0, 0.45 * S, -4.2 * S], poleHeight: 8 * S };
  return geo;
}
