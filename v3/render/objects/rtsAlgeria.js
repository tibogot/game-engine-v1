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
import { MAT, assemble, bakeContactAO, buildBox, buildSandbagWall, rng, wirePart } from "./rtsParts.js";

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
  parts.push({ geo: new THREE.CylinderGeometry(3.2, 3.9, 0.45, 20).translate(0, 0.225, 0), pos: [0, 0, 0], mat: MAT.earth, tone: 0.55 });
  for (let c = 0; c < 4; c++) {
    const rad = 2.3 - c * 0.05, n = 14;
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
