/**
 * THE ALN COMMAND POST — the Algerian side's HQ in the Algeria game: a
 * wilaya's "PC" in the mountains, built to the period photographs
 * (moudjahidines' refuges in the Aurès and Kabylie, 1956-60).
 *
 * What makes it read from the RTS camera, in order: NOT a fort. The French
 * post is the one white square on the map; this is the opposite — the colour
 * of the mountain, low, broken up, half into the ground and under brush, with
 * one thing that gives it away: the green-and-white flag. Then: the stone
 * house they took over (rubble walls, earth roof heaped with brushwood), the
 * CAVE in the rock behind it where the arms are, the log-roofed dugout, the
 * ring of stone sangars with their guns, supply sacks under a brush lean-to,
 * the cooking fire.
 *
 * Kit contract (rtsParts.js): one merged geometry on the atlas material,
 * origin at the ground centre on y = 0, `userData.footprint` for the pad and
 * nav, `userData.flagMount` for the game's cloth flag. Real metres, scaled by
 * 1.3 at the end. Its FRONT (the house door, the forecourt) faces local -Z —
 * the player's camera, like every building in the game.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, rng } from "./rtsParts.js";

const S = 1.3;

/**
 * A rock outcrop: a CLUSTER of angular limestone blocks, not one smooth
 * dome (the first version read as a loaf of bread — for a rock the
 * silhouette is the tell). Each block is a low-detail icosphere, flattened,
 * every vertex jittered so the faces stay FLAT and the edges sharp; blocks
 * lean on each other, the biggest at the back. `w/h/d` bound the cluster.
 */
function outcrop(R, w, h, d, seed) {
  const r = rng(seed);
  const blocks = [];
  const n = 6;
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    const bw = w * (0.45 - 0.2 * f) * (0.8 + r() * 0.4);
    const bh = h * (0.95 - 0.45 * f) * (0.75 + r() * 0.3);
    const bd = d * (0.5 - 0.15 * f) * (0.8 + r() * 0.4);
    const g = new THREE.IcosahedronGeometry(1, 1);   // already non-indexed
    const p = g.attributes.position;
    // Jitter per UNIQUE corner (non-indexed: same corner, same jitter), so
    // faces stay closed.
    const jit = new Map();
    const key = (x, y, z) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const kk = key(x, y, z);
      if (!jit.has(kk)) jit.set(kk, [0.75 + r() * 0.5, 0.75 + r() * 0.5, 0.75 + r() * 0.5]);
      const [jx, jy, jz] = jit.get(kk);
      // Flat top: clip the upper cap into a tilted table.
      const yy = Math.min(y * jy, 0.55 + x * 0.12);
      p.setXYZ(i, x * jx * bw, Math.max(-0.25, yy) * bh, z * jz * bd);
    }
    g.computeVertexNormals();
    const uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) + p.getZ(i)) / 2, p.getY(i) / 2);
    g.setIndex([...Array(p.count).keys()]);
    // Place: spread along X, the big ones behind, a lean on each.
    const ox = (f - 0.5) * w * 1.1 + (r() - 0.5) * w * 0.15;
    const oz = (1 - f) * d * 0.25 - d * 0.1 + (r() - 0.5) * d * 0.2;
    g.rotateY(r() * Math.PI).rotateZ((r() - 0.5) * 0.25).rotateX((r() - 0.5) * 0.2);
    g.translate(ox, 0, oz);
    blocks.push(g);
  }
  // Merge the blocks (same attribute set) into one geometry.
  const pos = [], nrm = [], uvs = [];
  for (const g of blocks) {
    pos.push(...g.attributes.position.array); nrm.push(...g.attributes.normal.array); uvs.push(...g.attributes.uv.array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex([...Array(pos.length / 3).keys()]);
  return out;
}

/** A dry-stone sangar: a C of stacked stone round a firing position. */
function sangar(parts, R, { x, z, rad = 1.9, h = 1.05, face }) {
  const n = 14;
  for (let k = 0; k < n; k++) {
    const a = face + Math.PI * 0.35 + (k / (n - 1)) * Math.PI * 1.3;       // open at the back
    const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
    const hh = h * (0.85 + R() * 0.3);
    parts.push({ geo: buildBox(0.95, hh, 0.6), pos: [px, hh / 2, pz], rot: [0, -a, 0], mat: MAT.rubble, tone: 0.5 + R() * 0.2 });
  }
  // The gun on its bipod, over the lip toward `face`.
  const gx = x + Math.cos(face) * (rad - 0.4), gz = z + Math.sin(face) * (rad - 0.4);
  parts.push({ geo: buildBox(0.12, 0.12, 1.25), pos: [gx, h + 0.1, gz], rot: [0, Math.PI / 2 - face, 0], mat: MAT.steel, tone: 0.1 });
  parts.push({ geo: buildBox(0.22, 0.2, 0.5), pos: [gx - Math.cos(face) * 0.5, h + 0.08, gz - Math.sin(face) * 0.5], rot: [0, Math.PI / 2 - face, 0], mat: MAT.steel, tone: 0.15 });
}

export function buildAlnCamp({ seed = 1954 } = {}) {
  const R = rng(seed);
  const parts = [];

  // ── The rock the camp is set against, and the cave in it ─────────────────
  // A long outcrop behind the camp (+Z, away from the camera), two lesser
  // ones at its flanks: the mountain the camp hides in.
  parts.push({ geo: outcrop(R, 14, 10.5, 7, seed), pos: [0, -0.3, 13.5], mat: MAT.sandstone, tone: 0.45 });
  parts.push({ geo: outcrop(R, 6, 4.5, 5, seed + 1), pos: [-15, -0.3, 8], mat: MAT.sandstone, tone: 0.4 });
  parts.push({ geo: outcrop(R, 5, 3.2, 4, seed + 2), pos: [15, -0.3, 10], mat: MAT.sandstone, tone: 0.5 });
  // The cave mouth: a dark arch in the big rock's face, a timber lintel, a
  // stone step, sacks and a crate just inside.
  {
    const arch = new THREE.Shape();
    arch.moveTo(-1.7, 0); arch.lineTo(1.7, 0); arch.lineTo(1.7, 1.6);
    arch.absarc(0, 1.6, 1.7, 0, Math.PI, false); arch.lineTo(-1.7, 0);
    const g = new THREE.ShapeGeometry(arch, 12);
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    parts.push({ geo: g, pos: [5, 0, 7.1], rot: [0, Math.PI, 0], mat: MAT.steel, tone: 0.0 });
    parts.push({ geo: buildBox(4.2, 0.35, 0.4), pos: [5, 3.2, 7.0], rot: [0, 0, 0.05], mat: MAT.timber, tone: 0.2 });
    for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.35, 3.2, 0.35), pos: [5 + sx * 1.85, 1.6, 7.0], mat: MAT.timber, tone: 0.25 });
    parts.push({ geo: buildBox(3.6, 0.3, 1.0), pos: [5, 0.15, 6.4], mat: MAT.rubble, tone: 0.55 });
    for (let k = 0; k < 4; k++) parts.push({ geo: buildBox(0.7, 0.45 + k * 0.04, 0.5), pos: [4 + k * 0.6, 0.55 + k * 0.035, 6.7], rot: [0, R() * 0.4, 0], mat: MAT.hessian, tone: 0.4 + R() * 0.2 });
  }

  // ── The stone house they took over: the PC ───────────────────────────────
  const HX = -5, HZ = 1.5, HW = 9, HD = 6, HH = 2.9;
  parts.push({ geo: buildBox(HW, HH, HD), pos: [HX, HH / 2, HZ], mat: MAT.rubble, tone: 0.55 });
  // Earth roof, a stone parapet, beam ends, and brushwood heaped over it all
  // against the spotter planes.
  parts.push({ geo: buildBox(HW + 0.3, 0.26, HD + 0.3), pos: [HX, HH + 0.13, HZ], mat: MAT.earth, tone: 0.5 });
  for (let k = 0; k < 7; k++) parts.push({ geo: buildBox(0.14, 0.14, 0.36), pos: [HX - HW / 2 + 0.6 + k * (HW - 1.2) / 6, HH - 0.12, HZ - HD / 2 - 0.14], mat: MAT.timber, tone: 0.2 });
  for (let k = 0; k < 9; k++) {
    parts.push({ geo: buildBox(1.8 + R() * 1.4, 0.35 + R() * 0.3, 1.2 + R() * 0.8), pos: [HX + (R() - 0.5) * (HW - 1.5), HH + 0.4 + R() * 0.15, HZ + (R() - 0.5) * (HD - 1.2)], rot: [(R() - 0.5) * 0.2, R() * 3, (R() - 0.5) * 0.2], mat: MAT.thatch, tone: 0.25 + R() * 0.25 });
  }
  // Front (-Z): the door in a limewashed frame, two small windows, a
  // forecourt walled in dry stone with a gap.
  const fz = HZ - HD / 2 - 0.02;
  parts.push({ geo: buildBox(1.4, 2.2, 0.04), pos: [HX, 1.1, fz], mat: MAT.white, tone: 0.35 });
  parts.push({ geo: buildBox(0.9, 1.8, 0.05), pos: [HX, 0.9, fz - 0.01], mat: MAT.timber, tone: 0.12 });
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.5, 0.4, 0.05), pos: [HX + sx * 2.6, 1.9, fz - 0.01], mat: MAT.steel, tone: 0.02 });
  for (const [a, b] of [[[-11, -6.5], [-7, -6.5]], [[-3, -6.5], [1, -6.5]], [[-11, -6.5], [-11, -1.5]], [[1, -6.5], [1, -1.5]]]) {
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
    parts.push({ geo: buildBox(0.5, 1.0 + R() * 0.2, len + 0.3), pos: [(a[0] + b[0]) / 2, 0.52, (a[1] + b[1]) / 2], rot: [0, Math.atan2(dx, dz), 0], mat: MAT.rubble, tone: 0.45 + R() * 0.15 });
  }
  // A whip aerial off the roof, the wire strung to a pole: the wilaya's radio.
  parts.push({ geo: new THREE.CylinderGeometry(0.03, 0.05, 6, 6), pos: [HX + 3.5, HH + 3.2, HZ + 2], mat: MAT.timber, tone: 0.3 });
  parts.push({ geo: new THREE.CylinderGeometry(0.01, 0.01, 9, 4), pos: [HX + 7.6, HH + 3.2, HZ + 2], rot: [0, 0, Math.PI / 2 - 0.12], mat: MAT.steel, tone: 0.3 });

  // ── The dugout: half into the ground, roofed with logs and earth ─────────
  {
    const DX = 8, DZ = -1, DW = 6, DD = 4;
    // Low stone walls above the pit, the log roof over them, earth on top.
    for (const sz of [-1, 1]) parts.push({ geo: buildBox(DW, 0.8, 0.5), pos: [DX, 0.4, DZ + sz * DD / 2], mat: MAT.rubble, tone: 0.5 });
    parts.push({ geo: buildBox(0.5, 0.76, DD - 0.06), pos: [DX + DW / 2, 0.38, DZ], mat: MAT.rubble, tone: 0.5 });   // lower and inside the long walls: flush corners z-fought
    for (let k = 0; k < 9; k++) {
      parts.push({ geo: new THREE.CylinderGeometry(0.14, 0.16, DD + 1.2, 7), pos: [DX - DW / 2 + 0.4 + k * (DW - 0.8) / 8, 0.95, DZ], rot: [Math.PI / 2, 0, 0], mat: MAT.timber, tone: 0.2 + R() * 0.2 });
    }
    parts.push({ geo: buildBox(DW - 0.3, 0.25, DD + 0.6), pos: [DX, 1.2, DZ], mat: MAT.earth, tone: 0.55 });
    for (let k = 0; k < 3; k++) parts.push({ geo: buildBox(1.6, 0.3, 1.3), pos: [DX - 2 + k * 2, 1.45, DZ + (R() - 0.5)], rot: [0, R() * 3, 0], mat: MAT.thatch, tone: 0.3 });
    // Its entrance, at the west end: a dark gap and a step down.
    parts.push({ geo: buildBox(0.06, 0.75, 1.2), pos: [DX - DW / 2 - 0.02, 0.4, DZ], mat: MAT.steel, tone: 0.0 });
  }

  // ── Stores under a brush lean-to: sacks of flour, ammunition boxes ───────
  {
    const LX = -15, LZ = -3;
    for (const [px, pz] of [[-2, -1.4], [2, -1.4], [-2, 1.4], [2, 1.4]]) parts.push({ geo: new THREE.CylinderGeometry(0.07, 0.09, 2.1, 6), pos: [LX + px, 1.05, LZ + pz], mat: MAT.timber, tone: 0.3 });
    parts.push({ geo: buildBox(4.8, 0.25, 3.4), pos: [LX, 2.15, LZ], rot: [0.1, 0, 0], mat: MAT.thatch, tone: 0.35 });
    for (let k = 0; k < 8; k++) parts.push({ geo: buildBox(0.75, 0.42, 0.5), pos: [LX - 1.5 + (k % 4) * 0.85, 0.22 + Math.floor(k / 4) * 0.42, LZ + 0.6], rot: [0, (R() - 0.5) * 0.3, 0], mat: MAT.hessian, tone: 0.45 + R() * 0.2 });
    for (let k = 0; k < 3; k++) parts.push({ geo: buildBox(0.9, 0.35, 0.45), pos: [LX - 1 + k * 1.0, 0.18, LZ - 0.9], rot: [0, (R() - 0.5) * 0.2, 0], mat: MAT.paint, tone: 0.3 });
  }

  // ── The cooking fire in the forecourt: a ring of stones, the pot ──────────
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    parts.push({ geo: buildBox(0.3, 0.2, 0.22), pos: [-3 + Math.cos(a) * 0.55, 0.1, -4 + Math.sin(a) * 0.55], rot: [0, -a, 0], mat: MAT.rubble, tone: 0.4 });
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.28, 0.22, 0.32, 10), pos: [-3, 0.3, -4], mat: MAT.steel, tone: 0.1 });

  // ── Sangars round the camp, the guns facing out (downhill = the camera) ──
  sangar(parts, R, { x: -17, z: -11, face: -Math.PI / 2 - 0.5 });
  sangar(parts, R, { x: 4, z: -12, face: -Math.PI / 2 });
  sangar(parts, R, { x: 19, z: -6, face: -Math.PI / 2 + 0.6 });

  // ── The flagpole's foot, in the forecourt: a heap of stones ──────────────
  const poleH = 7;
  for (let k = 0; k < 6; k++) parts.push({ geo: buildBox(0.5, 0.35 + k * 0.03, 0.4), pos: [-9 + (R() - 0.5) * 0.6, 0.18 + k * 0.015 + (k > 3 ? 0.3 : 0), -3.5 + (R() - 0.5) * 0.6], rot: [0, R() * 3, 0], mat: MAT.rubble, tone: 0.5 });

  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.4, radius: 2, strength: 0.5, groundFade: 0.3, floor: 0.45 });
  geo.scale(S, S, S);
  geo.userData.flagMount = { pos: [-9 * S, 0.5 * S, -3.5 * S], poleHeight: poleH * S };
  geo.userData.footprint = { cx: 0, cz: 0, hx: 22 * S, hz: 20 * S };
  geo.userData.height = 8 * S;
  return geo;
}
