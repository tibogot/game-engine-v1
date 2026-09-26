/**
 * THE MECHTA — the Aurès hamlet: Chaouia houses of dry-laid limestone rubble
 * under flat roofs of beaten earth, the roof beams' ends sticking out under
 * the eaves, a low timber door, a couple of small openings, some houses a
 * storey higher, the doorways limewashed. Houses lean on each other and on
 * courtyard walls; a domed bread oven (tabouna) in a yard, a round threshing
 * floor at the edge. The civilians' world in the Algeria game.
 *
 * A hamlet is an ARRANGEMENT round a lane, not one house stamped N times
 * (nam-rts's hamlet lesson): every house its own size, height and door side.
 *
 * Kit contract (rtsParts.js): one merged geometry on the atlas material,
 * origin at the ground centre on y = 0, `userData.footprint` for the pad and
 * nav, `userData.houses` for the pieces a game might want (doors, yards).
 * Real metres, scaled by 1.3 at the end.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, rng } from "./rtsParts.js";

const S = 1.3;

/**
 * One house, centred at (x, z), turned by `yaw`, pushing into `parts`.
 * Returns its door point (world, pre-scale) and its outline for yards.
 */
function house(parts, R, { x, z, yaw, w, d, h, storey2 = false, doorFace = -1 }) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Local → world for a part authored in the house's frame.
  const put = (geo, lp, mat, tone, rot = [0, 0, 0]) => {
    const wx = x + lp[0] * c + lp[2] * s, wz = z - lp[0] * s + lp[2] * c;
    parts.push({ geo, pos: [wx, lp[1], wz], rot: [rot[0], rot[1] + yaw, rot[2]], mat, tone });
  };
  // Walls: one rubble block, the top a hair rough (the courses are not level).
  put(buildBox(w, h, d), [0, h / 2, 0], MAT.rubble, 0.62 + R() * 0.2);
  // The lane front: bare stone, mud-plastered, or limewashed — the plaster a
  // skin a few cm proud, ragged at the top where it has washed off.
  const fz0 = doorFace * (d / 2 + 0.02);
  const skin = R();
  if (skin < 0.7) {
    const mat = skin < 0.45 ? MAT.earth : MAT.white;
    const top = h * (0.6 + R() * 0.35);
    put(buildBox(w - 0.1, top, 0.04), [0, top / 2, fz0], mat, mat === MAT.earth ? 0.62 + R() * 0.15 : 0.35 + R() * 0.15);
  }
  // The roof: beaten earth over brush over beams, a low parapet of stone at the
  // edge, a little proud all round; a spout on one side.
  put(buildBox(w + 0.3, 0.26, d + 0.3), [0, h + 0.13, 0], MAT.earth, 0.45 + R() * 0.15);
  put(buildBox(w + 0.32, 0.2, 0.22), [0, h + 0.36, d / 2 + 0.05], MAT.rubble, 0.4);
  put(buildBox(w + 0.32, 0.2, 0.22), [0, h + 0.36, -d / 2 - 0.05], MAT.rubble, 0.4);
  // The end pieces 3 cm lower and 3 cm inside the long ones' ends: flush
  // corners z-fought on every roof.
  put(buildBox(0.22, 0.17, d + 0.1), [w / 2 + 0.02, h + 0.36, 0], MAT.rubble, 0.4);
  put(buildBox(0.22, 0.17, d + 0.1), [-w / 2 - 0.02, h + 0.36, 0], MAT.rubble, 0.4);
  put(buildBox(0.12, 0.12, 0.7), [w / 2 + 0.4, h + 0.1, (R() - 0.5) * d * 0.6], MAT.timber, 0.3, [0, Math.PI / 2, 0.15]);
  // Beam ends under the eaves, along the long walls: the Chaouia house's tell.
  const nb = Math.max(3, Math.round(w / 0.7));
  for (const side of [-1, 1]) {
    for (let k = 0; k < nb; k++) {
      const bx = -w / 2 + 0.3 + (k * (w - 0.6)) / (nb - 1);
      put(buildBox(0.14, 0.14, 0.34), [bx, h - 0.12, side * (d / 2 + 0.14)], MAT.timber, 0.15 + R() * 0.2, [R() * 0.1, 0, R() * 0.1]);
    }
  }
  // A lean-to against one end: rubble half-walls under a roof of brush on poles.
  if (R() < 0.45) {
    const lw = 2.2 + R(), ex = (R() < 0.5 ? -1 : 1) * (w / 2 + lw / 2);
    put(buildBox(lw, 1.2, 0.4), [ex, 0.6, -doorFace * (d / 2 - 0.2)], MAT.rubble, 0.45);
    // 5 cm lower and 3 cm inside the front wall's end: equal tops and ends z-fought.
    put(buildBox(0.4, 1.15, d - 0.46), [ex + Math.sign(ex) * (lw / 2 - 0.23), 0.575, 0.03 * doorFace], MAT.rubble, 0.45);
    for (const pz of [-1, 1]) put(buildBox(0.12, 1.9, 0.12), [ex + Math.sign(ex) * (lw / 2 - 0.2), 0.95, pz * (d / 2 - 0.3)], MAT.timber, 0.3);
    put(buildBox(lw + 0.22, 0.22, d - 0.06), [ex + Math.sign(ex) * 0.04, 1.95, 0], MAT.thatch, 0.3 + R() * 0.2, [0, 0, Math.sign(ex) * -0.12]);
  }
  // Door: low, dark timber, in a limewashed surround; a sill stone.
  const fz = doorFace * (d / 2 + 0.03);
  const dx = (R() - 0.5) * (w - 1.6);
  put(buildBox(1.5, 2.2, 0.04), [dx, 1.1, fz], MAT.white, 0.5 + R() * 0.15);
  put(buildBox(0.9, 1.75, 0.05), [dx, 0.88, fz + doorFace * 0.01], MAT.timber, 0.12 + R() * 0.12);
  put(buildBox(1.2, 0.12, 0.4), [dx, 0.06, fz + doorFace * 0.2], MAT.rubble, 0.55);
  // Small openings high up: dark slots, one on each other face, some missing.
  for (const [ox, oz, ry] of [[w / 2 + 0.01, 0, Math.PI / 2], [-w / 2 - 0.01, 0, Math.PI / 2], [0, -fz, 0]]) {
    if (R() < 0.3) continue;
    put(buildBox(0.4, 0.34, 0.04), [ox === 0 ? (R() - 0.5) * w * 0.5 : ox, h - 0.8, oz === 0 && ox !== 0 ? (R() - 0.5) * d * 0.4 : oz], MAT.steel, 0.02, [0, ry, 0]);
  }
  // A second storey, set back on part of the roof, with its own beams and roof.
  if (storey2) {
    const w2 = w * 0.55, d2 = d * 0.9, h2 = 2.3, ox = (w - w2) / 2 * (R() < 0.5 ? -1 : 1);
    put(buildBox(w2, h2, d2), [ox, h + 0.26 + h2 / 2, 0], MAT.rubble, 0.64 + R() * 0.15);
    put(buildBox(w2 + 0.3, 0.24, d2 + 0.3), [ox, h + 0.26 + h2 + 0.12, 0], MAT.earth, 0.5);
    for (let k = 0; k < 3; k++) put(buildBox(0.14, 0.14, 0.34), [ox - w2 / 2 + 0.35 + k * (w2 - 0.7) / 2, h + 0.26 + h2 - 0.12, doorFace * (d2 / 2 + 0.14)], MAT.timber, 0.2);
    put(buildBox(0.8, 1.5, 0.04), [ox, h + 0.26 + 0.75, doorFace * (d2 / 2 + 0.01)], MAT.timber, 0.15);
  }
  // What lies about: a heap of brush for the oven on the roof, pots by the door.
  if (R() < 0.6) put(buildBox(1.2 + R(), 0.35, 0.8), [(R() - 0.5) * w * 0.4, h + 0.44, (R() - 0.5) * d * 0.4], MAT.thatch, 0.3 + R() * 0.2, [0, R() * 3, 0]);
  if (R() < 0.7) {
    const jar = new THREE.SphereGeometry(0.28, 10, 7);
    jar.scale(1, 1.25, 1);
    put(jar, [dx + 1.0, 0.33, fz + doorFace * 0.4], MAT.laterite, 0.55);
  }
  const doorW = [x + (dx) * c + (fz + doorFace * 1.2) * s, z - dx * s + (fz + doorFace * 1.2) * c];
  return { door: doorW, x, z, yaw, w, d };
}

/** A dry-stone yard wall from a to b (world x/z), ~1.5 m, uneven. */
function yardWall(parts, R, a, b, hgt = 1.5) {
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  const n = Math.max(1, Math.round(len / 2.2));
  for (let k = 0; k < n; k++) {
    const t = (k + 0.5) / n, h = hgt * (0.85 + R() * 0.25);
    // Each 2 m bay its own height: the top of a dry wall wanders.
    parts.push({ geo: buildBox(0.55, h, len / n + 0.02), pos: [a[0] + dx * t, h / 2, a[1] + dz * t], rot: [0, yaw, 0], mat: MAT.rubble, tone: 0.4 + R() * 0.2 });
  }
}

/** The tabouna: a domed clay oven, a dark mouth, a flat stone in front. */
function oven(parts, R, x, z, yaw) {
  const dome = new THREE.SphereGeometry(0.75, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  parts.push({ geo: dome, pos: [x, 0, z], rot: [0, yaw, 0], mat: MAT.earth, tone: 0.62 });
  parts.push({ geo: buildBox(0.36, 0.32, 0.1), pos: [x + Math.sin(yaw) * 0.72, 0.2, z + Math.cos(yaw) * 0.72], rot: [0, yaw, 0], mat: MAT.steel, tone: 0 });
  parts.push({ geo: buildBox(0.7, 0.08, 0.5), pos: [x + Math.sin(yaw) * 1.05, 0.04, z + Math.cos(yaw) * 1.05], rot: [0, yaw, 0], mat: MAT.rubble, tone: 0.6 });
}

/**
 * A hamlet of `count` houses along a lane (the lane runs along +Z through the
 * origin, doors facing it), yards behind some, an oven, a threshing floor.
 */
export function buildMechta({ seed = 1954, count = 10 } = {}) {
  const R = rng(seed);
  const parts = [];
  const houses = [];
  // Houses both sides of the lane in ATTACHED rows (a dechra is built wall to
  // wall; an alley now and then), each its own size and height.
  let zL = -count * 3.2, zR = -count * 3.2 + 2.5;
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const w = 4.5 + R() * 3.5, d = 3.8 + R() * 1.8, h = 2.5 + R() * 0.9;
    const zc = side < 0 ? zL + w / 2 : zR + w / 2;
    const xc = side * (2.6 + d / 2 + R() * 0.5);
    // Long side along the lane: the house is turned 90 degrees.
    const hh = house(parts, R, { x: xc, z: zc, yaw: side * Math.PI / 2 + (R() - 0.5) * 0.06, w, d, h, storey2: R() < 0.35, doorFace: -1 });
    houses.push(hh);
    const gap = R() < 0.25 ? 1.8 + R() : 0.05;
    if (side < 0) zL += w + gap; else zR += w + gap;
    // A yard behind every other house.
    if (R() < 0.6) {
      const back = side * (3.2 + d + 1.2), far = side * (3.2 + d + 1.2 + 5 + R() * 3);
      yardWall(parts, R, [back, zc - w / 2], [far, zc - w / 2]);
      yardWall(parts, R, [far, zc - w / 2], [far, zc + w / 2]);
      yardWall(parts, R, [far, zc + w / 2], [back, zc + w / 2]);
      if (R() < 0.5) oven(parts, R, (back + far) / 2, zc + (R() - 0.5) * 2, R() * 6);
    }
  }
  // The threshing floor: a round of beaten earth ringed with stones, at the
  // lane's end.
  const tz = Math.max(zL, zR) + 6;
  parts.push({ geo: new THREE.CylinderGeometry(4.5, 4.6, 0.12, 28), pos: [0, 0.06, tz], mat: MAT.earth, tone: 0.95 });
  for (let k = 0; k < 22; k++) {
    const a = (k / 22) * Math.PI * 2;
    parts.push({ geo: buildBox(0.5, 0.25, 0.35), pos: [Math.cos(a) * 4.7, 0.12, tz + Math.sin(a) * 4.7], rot: [0, -a, 0], mat: MAT.rubble, tone: 0.5 + R() * 0.2 });
  }

  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.35, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5 });
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.scale(S, S, S);
  geo.computeBoundingBox();
  geo.userData.footprint = {
    cx: ((bb.min.x + bb.max.x) / 2) * S, cz: ((bb.min.z + bb.max.z) / 2) * S,
    hx: ((bb.max.x - bb.min.x) / 2) * S, hz: ((bb.max.z - bb.min.z) / 2) * S,
  };
  geo.userData.houses = houses.map((h) => ({ door: [h.door[0] * S, h.door[1] * S], x: h.x * S, z: h.z * S }));
  geo.userData.height = 6 * S;
  return geo;
}
