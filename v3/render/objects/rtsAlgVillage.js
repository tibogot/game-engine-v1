/**
 * THE AURÈS VILLAGE — the Algeria game's civilian places beyond the mechta:
 * the DECHRA (a stone village stepping up a slope), the KOUBBA (a marabout's
 * white domed tomb, on the skyline above its village), the CEMETERY beside
 * it, the village WELL with its troughs, and the ZERIBA (a thorn-brush pen
 * for the flock). Round them, the land they work: walled olive and fig
 * GARDENS, almond TERRACES up the slopes, the round THRESHING FLOOR.
 *
 * TREES AND HEDGES are not geometry here: a piece lists them in
 * `userData.trees` ({ kind, x, z, scale, seed }, kind a foliage preset —
 * olive, fig, almond) and `userData.hedge` ([x, z] prickly pears), in its
 * own frame (scaled), and the game plants them with the painted fields'
 * own plants (placedFoliage.js) — same shading, wind and LODs.
 *
 * NAV: `userData.navRects` (optional, scaled, piece frame) replaces the
 * footprint as what blocks units: [] for ground men walk over (terraces, a
 * threshing floor), the walls alone for a garden (in through its gate).
 *
 * Built from the same parts as the mechta (rtsMechta.js `house`) and the
 * Algeria kit (rtsAlgeria.js: dry stone, field stones, brush), so a dechra
 * and a mechta are one people's houses.
 *
 * GROUND. These stand on slopes, not on pads: a builder takes `groundAt(x, z)`
 * — the ground height in its own frame (real metres, relative to its origin)
 * — and seats each house, grave or bush on it. A house stands on a stone
 * SOCLE that reaches down to the lowest ground under it: the terrace a
 * dechra is built on. Without a callback the ground is flat (the tests).
 *
 * Kit contract (rtsParts.js): one merged geometry on the atlas material,
 * origin at the ground centre, front at local -Z, `userData.footprint`,
 * `height`. Real metres, scaled by 1.3 at the end.
 */
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { MAT, buildBox, rng, wirePart } from "./rtsParts.js";
import { house, oven } from "./rtsMechta.js";
import { brushClump, clayJar, dryStone, earthBerm, fieldStone, finish } from "./rtsAlgeria.js";

const FLAT = () => 0;

/** Highest and lowest ground under a rectangle (centre cx,cz; half w/2, d/2). */
function groundSpan(groundAt, cx, cz, w, d) {
  const g = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    g.push(groundAt(cx + (sx * w) / 2, cz + (sz * d) / 2));
  }
  return { top: Math.max(...g), low: Math.min(...g) };
}

/** Shift every part pushed since index `from` up by `dy`. */
function lift(parts, from, dy) {
  for (let i = from; i < parts.length; i++) if (parts[i].pos) parts[i].pos = [parts[i].pos[0], parts[i].pos[1] + dy, parts[i].pos[2]];
}

/**
 * A wall that follows the ground: bays ~2 m long, each standing on the
 * ground at its middle and reaching below it, so a slope reads as a stepped
 * wall and never shows daylight under it.
 */
function groundWall(parts, R, groundAt, a, b, { h = 1.0, t = 0.4, mat = MAT.rubble, tone = 0.45 } = {}) {
  const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz), yaw = Math.atan2(dx, dz);
  const n = Math.max(1, Math.round(len / 2));
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n, tm = (t0 + t1) / 2;
    const x = a[0] + dx * tm, z = a[1] + dz * tm;
    const g0 = groundAt(a[0] + dx * t0, a[1] + dz * t0), g1 = groundAt(a[0] + dx * t1, a[1] + dz * t1);
    const top = Math.max(g0, g1) + h * (0.9 + R() * 0.2), low = Math.min(g0, g1) - 0.3;
    // Each bay a few cm thicker or thinner: equal faces along a wall z-fight.
    parts.push({ geo: buildBox(t + (k % 2) * 0.03, top - low, len / n + 0.03), pos: [x, (top + low) / 2, z], rot: [0, yaw, 0], mat, tone: tone + R() * 0.12 });
  }
}

// ── DECHRA ──────────────────────────────────────────────────────────────────

/**
 * DECHRA — the Aurès village built up a slope: rows of houses wall to wall,
 * each row a terrace above the last, doors to the lane below, flat roofs of
 * beaten earth that the row above looks out over. A small mosque in the
 * middle with its square whitewashed minaret: the village's one vertical.
 *
 * The rows run along local X; the slope rises along +Z (the game turns the
 * village so it climbs away from the camera).
 */
export function buildDechra({ seed = 1956, rows = 4, width = 34, groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const rowStep = 9;
  const z0 = -((rows - 1) * rowStep) / 2;
  const mosqueRow = Math.floor(rows / 2);
  let mosqueDone = false;
  let nest = null;       // the stork's nest on the minaret: where its bird stands
  const houses = [];
  for (let r = 0; r < rows; r++) {
    const zr = z0 + r * rowStep + (R() - 0.5) * 0.8;
    let x = -width / 2 + R() * 2;
    while (x < width / 2 - 3) {
      // THE MOSQUE: a whitewashed hall and its minaret, once, mid-village.
      if (r === mosqueRow && !mosqueDone && x > -4) {
        mosqueDone = true;
        const w = 8, d = 6.4, h = 3.6, cx = x + w / 2, cz = zr;
        const { top, low } = groundSpan(groundAt, cx, cz, w + 3, d);
        const y = top;
        const sh = y - low + 0.9;
        parts.push({ geo: buildBox(w + 0.36, sh, d + 0.36), pos: [cx, y + 0.33 - sh / 2, cz], mat: MAT.rubble, tone: 0.4 });   // its own height: neighbours' socles are 0.20/0.25
        parts.push({ geo: buildBox(w, h, d), pos: [cx, y + h / 2, cz], mat: MAT.white, tone: 0.62 });
        parts.push({ geo: buildBox(w + 0.3, 0.24, d + 0.3), pos: [cx, y + h + 0.12, cz], mat: MAT.white, tone: 0.55 });
        // The door (green, as the mosque's is) and small arched windows.
        parts.push({ geo: buildBox(1.3, 2.3, 0.06), pos: [cx - 1.2, y + 1.15, cz - d / 2 - 0.03], mat: MAT.paint, tone: 0.55 });
        for (const wx of [1.2, 2.9]) parts.push({ geo: buildBox(0.5, 0.8, 0.05), pos: [cx + wx, y + 2.1, cz - d / 2 - 0.03], mat: MAT.steel, tone: 0.02 });
        // The minaret: a square shaft at the corner, a balcony, a lantern.
        const mx = cx + w / 2 + 1.1, mz = cz + d / 2 - 1.1, MH = 10.5;
        const m = groundSpan(groundAt, mx, mz, 2.4, 2.4);
        const my = m.top, msh = my - m.low + 0.9;
        parts.push({ geo: buildBox(2.6, msh, 2.6), pos: [mx, my + 0.4 - msh / 2, mz], mat: MAT.rubble, tone: 0.4 });
        parts.push({ geo: buildBox(2.2, MH, 2.2), pos: [mx, my + MH / 2, mz], mat: MAT.white, tone: 0.68 });
        parts.push({ geo: buildBox(2.7, 0.25, 2.7), pos: [mx, my + MH + 0.12, mz], mat: MAT.white, tone: 0.58 });
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push({ geo: buildBox(0.4, 0.55, 0.4), pos: [mx + sx * 1.1, my + MH + 0.52, mz + sz * 1.1], mat: MAT.white, tone: 0.6 });
        parts.push({ geo: buildBox(1.2, 1.4, 1.2), pos: [mx, my + MH + 0.95, mz], mat: MAT.white, tone: 0.66 });
        parts.push({ geo: buildBox(1.45, 0.14, 1.45), pos: [mx, my + MH + 1.72, mz], mat: MAT.white, tone: 0.55 });
        parts.push(wirePart([mx, my + MH + 1.79, mz], [mx, my + MH + 2.6, mz], 0.03, { tone: 0.3 }));
        // A STORK'S NEST on the lantern roof, round the finial (they build on
        // minarets all over the Maghreb): a bowl of sticks, sunk a little into
        // the slab (no shared face), more sticks radiating out of its rim. The
        // stork itself is the game's bird (userData.nest → rtsBirds perch).
        const ny = my + MH + 1.76, RN = rng(seed + 77);   // its own stream: the village after it unchanged
        parts.push({ geo: new THREE.CylinderGeometry(0.6, 0.46, 0.22, 10), pos: [mx, ny + 0.11, mz], mat: MAT.timber, tone: 0.16 });
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * Math.PI * 2 + RN() * 0.3, a2 = a + 0.9 + RN() * 0.5;
          const r0 = 0.3 + RN() * 0.15, r1 = 0.62 + RN() * 0.22, y0 = ny + 0.14 + RN() * 0.08;
          parts.push(wirePart([mx + Math.cos(a) * r0, y0, mz + Math.sin(a) * r0], [mx + Math.cos(a2) * r1, y0 + (RN() - 0.3) * 0.12, mz + Math.sin(a2) * r1], 0.022, { mat: MAT.timber, tone: 0.2 + RN() * 0.12 }));
        }
        nest = [mx + 0.22, ny + 0.22, mz];
        for (const [ox, oz] of [[0, -1.12], [-1.12, 0]]) parts.push({ geo: buildBox(ox ? 0.05 : 0.35, 0.9, oz ? 0.05 : 0.35), pos: [mx + ox, my + MH - 1.6, mz + oz], mat: MAT.steel, tone: 0.02 });
        houses.push({ x: cx, z: cz, mosque: true });
        x += w + 3.5;
        continue;
      }
      const w = 4.2 + R() * 3, d = 4.2 + R() * 1.4, h = 2.6 + R() * 0.8;
      const cx = x + w / 2, cz = zr + (R() - 0.5) * 0.6;
      const { top, low } = groundSpan(groundAt, cx, cz, w, d);
      const y = top;
      const n0 = parts.length;
      const hh = house(parts, R, { x: cx, z: cz, yaw: 0, w, d, h, storey2: R() < 0.3, doorFace: -1, leanTo: false });
      lift(parts, n0, y);
      // The socle: from below the lowest ground to 20 cm up the walls, a
      // little wider than the house — the terrace this row is built on.
      // Neighbours alternate 5 cm in height: attached socles overlap, and
      // equal tops z-fought.
      const lip = 0.2 + (houses.length % 2) * 0.05;
      const sh = y - low + 0.7 + lip;
      parts.push({ geo: buildBox(w + 0.36, sh, d + 0.36), pos: [cx, y + lip - sh / 2, cz], mat: MAT.rubble, tone: 0.32 + R() * 0.15 });
      houses.push({ x: cx, z: cz, door: hh.door, w, d, row: r });
      x += w + (R() < 0.2 ? 1.8 + R() : 0.08);
    }
  }
  // Everything below has its OWN random stream: the houses above are the
  // village as approved, and stay put whatever the lanes and yards do.
  const RL = rng(seed + 91);
  const trees = [];
  const coverLines = [];   // the yard walls (the houses' outline covers the rest)
  // THE LANES up through the village, one at each end: a STAIR climbing the
  // real ground, the lane wandering a little — every 1.3 m a riser of
  // stones on edge, and the step behind it PAVED to the next riser (two
  // flagstones side by side, a third across the joint). Risers alone every
  // metre with the ground between read as a ladder (seen in the game).
  const xEnd = Math.max(...houses.map((h) => h.x + (h.mosque ? 6.4 : h.w / 2)));
  for (const lx of [-width / 2 - 2, xEnd + 1.8]) {
    for (let z = z0 - 5.5; z < z0 + (rows - 1) * rowStep + 5; z += 1.3) {
      const x = lx + Math.sin(z * 0.23) * 0.5, g = groundAt(x, z);
      for (const o of [-0.62, 0, 0.62]) {
        parts.push({ geo: fieldStone(Math.floor(RL() * 1e6), 0.62, 0.24, 0.24), pos: [x + o, g + 0.06, z], rot: [(RL() - 0.5) * 0.1, (RL() - 0.5) * 0.15, (RL() - 0.5) * 0.1], mat: MAT.limestone, tone: 0.44 + RL() * 0.14 });
      }
      const zt = z + 0.66, gt = groundAt(x, zt);
      for (const [o, w, dz] of [[-0.42, 0.88, 0], [0.44, 0.84, 0.05], [0.02, 0.6, 0.38]]) {
        parts.push({ geo: fieldStone(Math.floor(RL() * 1e6), w, 0.14, 0.62), pos: [x + o, gt + 0.07 + dz * 0.1, zt + dz - 0.12], rot: [0, (RL() - 0.5) * 0.25, 0], mat: MAT.limestone, tone: 0.5 + RL() * 0.12 });
      }
    }
  }
  // COURTYARDS in front of the lowest row (the side the camera sees): a
  // dry-stone yard wall round the door, open in the middle; in it a tabouna
  // (the clay bread oven), jars, or a fig tree.
  for (const h of houses) {
    if (h.row !== 0 || h.mosque || RL() < 0.35) continue;
    const zf = h.z - h.d / 2 - 0.25, deep = 3.2 + RL() * 1.2, x0 = h.x - h.w / 2 + 0.3, x1 = h.x + h.w / 2 - 0.3;
    const gap = 0.75;
    const yard = [[[h.x - gap, zf - deep], [x0, zf - deep], [x0, zf]], [[h.x + gap, zf - deep], [x1, zf - deep], [x1, zf]]];
    for (const w of yard) {
      dryStone(parts, RL, w, { courses: 3, h: 1.05, depth: 0.45, len: 0.5, groundAt, tone: 0.48 });
      coverLines.push({ pts: w, hard: true });
    }
    const ix = h.x + (RL() < 0.5 ? -1 : 1) * (h.w / 2 - 1.3), iz = zf - deep + 1.2;
    const what = RL();
    if (what < 0.4) trees.push({ kind: "fig", x: ix, z: iz, scale: 0.6 + RL() * 0.2, seed: Math.floor(RL() * 1000) });
    else if (what < 0.75) parts.push({ geo: earthBerm([[0.7, -0.1], [0.62, 0.35], [0.4, 0.62], [0.001, 0.7]], { seed: Math.floor(RL() * 1e6), segs: 12, rJit: 0.05, yJit: 0.03 }), pos: [ix, groundAt(ix, iz), iz], mat: MAT.spoil, tone: 0.55 });
    else for (let k = 0; k < 3; k++) parts.push(clayJar(ix + k * 0.42, groundAt(ix + k * 0.42, iz) - 0.02, iz, 0.8 + RL() * 0.3));
  }
  // The footprint reaches the far lane (the last house of a row can run past
  // width / 2).
  const geo = finish(parts, { hx: Math.max(width / 2 + 4, xEnd + 3), hz: (rows * rowStep) / 2 + 3, cx: 0, cz: 0, height: 14 });
  geo.userData.houses = houses.map((h) => ({ x: h.x * 1.3, z: h.z * 1.3, mosque: !!h.mosque }));
  geo.userData.trees = scaled(trees);
  geo.userData.coverLines = scaledLines(coverLines);
  // The nest's floor, in the piece's frame (scaled): a game stands its stork there.
  geo.userData.nest = nest ? { x: nest[0] * 1.3, y: nest[1] * 1.3, z: nest[2] * 1.3 } : null;
  return geo;
}

// ── KOUBBA ──────────────────────────────────────────────────────────────────

/**
 * KOUBBA — the tomb of a marabout, a local saint: a white cube under a white
 * dome on an octagonal drum, a green door, a low whitewashed wall round its
 * court; jars of offerings by the door. Put on a crest, it is the one white
 * thing on the skyline that is NOT French.
 */
export function buildKoubba({ seed = 1957, groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const W = 4.6, HC = 3.4;
  const { top, low } = groundSpan(groundAt, 0, 0, W + 1.2, W + 1.2);
  const y = top + 0.25;
  // A low stone platform down to the ground (whitewash only on the tomb: a
  // white socle read as a heavy block, seen in the game).
  const sh = y - low + 0.6;
  parts.push({ geo: buildBox(W + 0.9, sh, W + 0.9), pos: [0, y - sh / 2, 0], mat: MAT.rubble, tone: 0.45 });
  parts.push({ geo: buildBox(W, HC, W), pos: [0, y + HC / 2, 0], mat: MAT.white, tone: 0.74 });
  parts.push({ geo: buildBox(W + 0.24, 0.2, W + 0.24), pos: [0, y + HC + 0.1, 0], mat: MAT.white, tone: 0.62 });
  // Corner merlons, stepped.
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    parts.push({ geo: buildBox(0.55, 0.55, 0.55), pos: [sx * (W / 2 - 0.2), y + HC + 0.47, sz * (W / 2 - 0.2)], mat: MAT.white, tone: 0.7 });
  }
  // Drum and dome.
  const drumY = y + HC + 0.2;
  parts.push({ geo: new THREE.CylinderGeometry(1.95, 2.0, 0.6, 8), pos: [0, drumY + 0.3, 0], rot: [0, Math.PI / 8, 0], mat: MAT.white, tone: 0.7 });
  parts.push({ geo: new THREE.SphereGeometry(1.92, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), pos: [0, drumY + 0.6, 0], mat: MAT.white, tone: 0.82 });
  // The finial: an iron rod with three balls.
  parts.push(wirePart([0, drumY + 2.45, 0], [0, drumY + 3.3, 0], 0.025, { tone: 0.35 }));
  for (const [k, r] of [[0, 0.1], [1, 0.08], [2, 0.06]]) parts.push({ geo: new THREE.SphereGeometry(r, 8, 6), pos: [0, drumY + 2.6 + k * 0.24, 0], mat: MAT.steel, tone: 0.4 });
  // Door (green), a sill, two small dark windows.
  parts.push({ geo: buildBox(1.05, 1.95, 0.05), pos: [0, y + 0.98, -W / 2 - 0.03], mat: MAT.paint, tone: 0.6 });
  parts.push({ geo: buildBox(1.4, 0.1, 0.5), pos: [0, y + 0.05, -W / 2 - 0.3], mat: MAT.white, tone: 0.55 });
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.05, 0.5, 0.35), pos: [sx * (W / 2 + 0.03), y + 2.3, 0], mat: MAT.steel, tone: 0.02 });
  // Offerings: jars and a pot by the door.
  for (let k = 0; k < 3; k++) parts.push(clayJar(-1.3 + k * 0.4 + (k === 2 ? 1.9 : 0), y - 0.02, -W / 2 - 0.7, 0.7 + R() * 0.3));
  // The court: a low whitewashed wall that follows the ground, open at the front.
  const C = 6.5;
  groundWall(parts, R, groundAt, [-1.3, -C], [-C, -C], { h: 0.85, t: 0.35, mat: MAT.white, tone: 0.5 });
  groundWall(parts, R, groundAt, [-C, -C + 0.2], [-C, C], { h: 0.85, t: 0.32, mat: MAT.white, tone: 0.5 });
  groundWall(parts, R, groundAt, [-C + 0.2, C], [C, C], { h: 0.85, t: 0.35, mat: MAT.white, tone: 0.5 });
  groundWall(parts, R, groundAt, [C, C - 0.2], [C, -C], { h: 0.85, t: 0.32, mat: MAT.white, tone: 0.5 });
  groundWall(parts, R, groundAt, [C - 0.2, -C], [1.3, -C], { h: 0.85, t: 0.35, mat: MAT.white, tone: 0.5 });
  // A juniper grown in the corner of the court.
  parts.push(...brushClump(R, C - 1.6, groundAt(C - 1.6, C - 1.6), C - 1.6, { h: 2.6, r: 0.9 }));
  return finish(parts, { hx: C + 0.6, hz: C + 0.6, height: drumY + 3.3 });
}

// ── CEMETERY ────────────────────────────────────────────────────────────────

/**
 * CEMETERY — the village dead on the slope below the marabout: low mounds of
 * earth, a flat headstone and a smaller footstone to each, a few graves
 * whitewashed. Every grave lies the same way (toward Mecca: `align`, radians
 * in the local frame) whatever the slope does — the one order in a field of
 * stones.
 */
export function buildCemetery({ seed = 1958, rows = 5, cols = 7, align = 0, groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const sx = 1.9, sz = 3.0;
  const ca = Math.cos(align), sa = Math.sin(align);
  const rot = (lx, lz) => [lx * ca + lz * sa, -lx * sa + lz * ca];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    if (R() < 0.18) continue;
    const [x, z] = rot((i - (cols - 1) / 2) * sx + (R() - 0.5) * 0.5, (j - (rows - 1) / 2) * sz + (R() - 0.5) * 0.7);
    const g = groundAt(x, z);
    const white = R() < 0.14;
    // The mound, elongated along the grave.
    // Low: a smooth high mound read as a loaf of bread (seen in the game).
    const mound = earthBerm([[0.55, -0.12], [0.45, 0.07], [0.2, 0.13], [0.001, 0.14]], { seed: i * 31 + j, segs: 12, rJit: 0.08, yJit: 0.03 });
    mound.scale(1, 1, 2.0);
    parts.push({ geo: mound, pos: [x, g, z], rot: [0, align + (R() - 0.5) * 0.08, 0], mat: white ? MAT.white : MAT.spoil, tone: white ? 0.55 : 0.4 + R() * 0.15 });
    // Headstone and footstone: flat slabs set upright, leaning a little.
    // A border of small stones round the mound.
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, [bx, bz] = rot(Math.cos(a) * 0.62, Math.sin(a) * 1.22);
      parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.3, 0.18, 0.24), pos: [x + bx, groundAt(x + bx, z + bz) + 0.05, z + bz], rot: [0, R() * 3, 0], mat: MAT.limestone, tone: 0.45 + R() * 0.2 });
    }
    const hd = rot(0, 1.4), ft = rot(0, -1.35);
    const hh = 0.8 + R() * 0.35;
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.5, hh, 0.14), pos: [x + hd[0], groundAt(x + hd[0], z + hd[1]) + hh * 0.36, z + hd[1]], rot: [(R() - 0.5) * 0.18, align + (R() - 0.5) * 0.2, (R() - 0.5) * 0.12], mat: white ? MAT.white : MAT.limestone, tone: 0.55 + R() * 0.2 });
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.34, hh * 0.55, 0.12), pos: [x + ft[0], groundAt(x + ft[0], z + ft[1]) + hh * 0.22, z + ft[1]], rot: [(R() - 0.5) * 0.2, align + (R() - 0.5) * 0.2, (R() - 0.5) * 0.15], mat: MAT.limestone, tone: 0.5 + R() * 0.2 });
  }
  // A broken dry-stone wall along the downhill side, and a prickly-pear-like
  // clump of brush at a corner.
  const hx = (cols * sx) / 2 + 1.2, hz = (rows * sz) / 2 + 1.2;
  groundWall(parts, R, groundAt, [-hx, -hz], [-hx * 0.2, -hz], { h: 0.7 });
  groundWall(parts, R, groundAt, [hx * 0.35, -hz], [hx, -hz], { h: 0.6 });
  parts.push(...brushClump(R, hx - 0.5, groundAt(hx - 0.5, hz - 0.5), hz - 0.5, { h: 1.8, r: 0.7, dry: true }));
  return finish(parts, { hx: hx + 0.5, hz: hz + 0.5, height: 1.2 });
}

// ── WELL ────────────────────────────────────────────────────────────────────

/**
 * A ROUGH STONE TROUGH at (x, y, z), turned `yaw` (length along local X):
 * the water's edge well inside the rim, so the rim stones show all round.
 */
function stoneTrough(R, x, y, z, yaw, { len = 2.4 } = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
  const out = [];
  const stone = (lx, lz, w, h, d, py, tone) => {
    const [px, pz] = at(lx, lz);
    out.push({ geo: fieldStone(Math.floor(R() * 1e6), w, h, d), pos: [px, y + py, pz], rot: [(R() - 0.5) * 0.08, yaw + (R() - 0.5) * 0.06, (R() - 0.5) * 0.08], mat: MAT.limestone, tone });
  };
  stone(0, 0, len, 0.28, 0.72, 0.08, 0.42 + R() * 0.1);                        // the bed
  for (const side of [-1, 1]) stone((R() - 0.5) * 0.1, side * 0.31, len + 0.1, 0.56, 0.22, 0.24, 0.45 + R() * 0.15);
  for (const end of [-1, 1]) stone(end * (len / 2 - 0.05), 0, 0.24, 0.52, 0.72, 0.23, 0.45 + R() * 0.15);
  const [wx, wz] = at(0, 0);
  out.push({ geo: buildBox(len - 0.34, 0.05, 0.36), pos: [wx, y + 0.38, wz], rot: [0, yaw, 0], mat: MAT.steel, tone: 0.05 });
  return out;
}

/**
 * WELL — where the village's women and the flocks come: a round curb of
 * stone, two forked posts and a beam with a pulley, a rope and a leather
 * bucket; long stone troughs for the animals in front; jars waiting.
 */
export function buildVillageWell({ seed = 1959 } = {}) {
  const R = rng(seed);
  const parts = [];
  // The curb: a lathed ring of stone, the dark water inside.
  const curb = new THREE.LatheGeometry([[0.95, -0.05], [0.95, 0.72], [0.9, 0.8], [0.66, 0.8], [0.62, 0.72], [0.62, 0.3]].map(([r, y]) => new THREE.Vector2(r, y)), 16);
  parts.push({ geo: curb, pos: [0, 0, 0], mat: MAT.rubble, tone: 0.5 });
  parts.push({ geo: new THREE.CylinderGeometry(0.63, 0.63, 0.06, 16), pos: [0, 0.34, 0], mat: MAT.steel, tone: 0 });
  // Forked posts, the beam, a pulley, the rope, the bucket at the lip.
  for (const sx of [-1, 1]) {
    parts.push(wirePart([sx * 1.15, -0.1, 0], [sx * 1.05, 2.3, 0], 0.07, { mat: MAT.timber, tone: 0.28 }));
    parts.push(wirePart([sx * 1.05, 2.3, 0], [sx * 1.2, 2.6, 0], 0.04, { mat: MAT.timber, tone: 0.28 }));
    parts.push(wirePart([sx * 1.05, 2.3, 0], [sx * 0.9, 2.6, 0], 0.04, { mat: MAT.timber, tone: 0.28 }));
  }
  parts.push(wirePart([-1.3, 2.46, 0], [1.3, 2.46, 0], 0.06, { mat: MAT.timber, tone: 0.24 }));
  parts.push({ geo: new THREE.TorusGeometry(0.17, 0.04, 5, 12), pos: [0, 2.3, 0], mat: MAT.timber, tone: 0.3 });
  parts.push(wirePart([0.17, 2.3, 0], [0.17, 0.95, 0], 0.012, { mat: MAT.canvas, tone: 0.4 }));
  parts.push({ geo: new THREE.CylinderGeometry(0.2, 0.16, 0.34, 10), pos: [0.17, 0.95, 0], mat: MAT.hessian, tone: 0.3 });
  // Troughs: rough stone, not cut blocks — two long slabs set on edge, a
  // stone at each end, a flat one under, water between. Their own stream:
  // the rest of the well unchanged.
  for (const [x, z, yaw] of [[-1.6, -2.0, 0.1], [1.4, -2.2, -0.15]]) parts.push(...stoneTrough(rng(seed + Math.round(x * 10)), x, 0, z, yaw));
  // Flat stones worn round the curb; jars waiting.
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.7, 0.2, 0.5), pos: [Math.cos(a) * 1.35, 0.03, Math.sin(a) * 1.35], rot: [0, -a, 0], mat: MAT.limestone, tone: 0.55 + R() * 0.15 });
  }
  for (let k = 0; k < 4; k++) parts.push(clayJar(1.9 + (k % 2) * 0.45, -0.02, 0.6 + Math.floor(k / 2) * 0.5, 0.85 + R() * 0.3));
  return finish(parts, { hx: 3.2, hz: 3.2, cz: -0.4, height: 2.8 });
}

// ── ZERIBA ──────────────────────────────────────────────────────────────────

/**
 * ZERIBA — the flock's pen: a ring of cut thorn brush piled chest high, a gap
 * closed at night with more brush, a stone trough and a heap of fodder
 * inside. Stands on whatever ground there is.
 */
export function buildZeriba({ seed = 1960, r = 6.5, groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  // Thorn brush is a TANGLE of dead grey branches, not a row of lumps (the
  // first pass, bushy clumps, read as baskets): per metre of fence a few
  // branches leaning every way, a low dark core of dry brush under them.
  const n = Math.round((2 * Math.PI * r) / 0.55);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    // The gap, toward the front (-Z).
    if (Math.abs(Math.atan2(Math.sin(a + Math.PI / 2), Math.cos(a + Math.PI / 2))) < 0.2) continue;
    const rr = r + (R() - 0.5) * 0.35, x = Math.cos(a) * rr, z = Math.sin(a) * rr, g = groundAt(x, z);
    const tx = -Math.sin(a), tz = Math.cos(a);           // along the fence
    for (let q = 0; q < 4; q++) {
      const along = (R() - 0.5) * 1.6, out = (R() - 0.5) * 0.9, up = 0.5 + R() * 1.0;
      const bx = x + tx * (R() - 0.5) * 0.4, bz = z + tz * (R() - 0.5) * 0.4;
      const ex = bx + tx * along + Math.cos(a) * out, ez = bz + tz * along + Math.sin(a) * out;
      parts.push(wirePart([bx, g - 0.05, bz], [ex, g + up, ez], 0.022 + R() * 0.018, { mat: MAT.timber, tone: 0.55 + R() * 0.3 }));
      // A side twig off each branch.
      const mx = (bx + ex) / 2, mz = (bz + ez) / 2, my = g + up / 2;
      parts.push(wirePart([mx, my, mz], [mx + (R() - 0.5) * 0.8, my + 0.2 + R() * 0.4, mz + (R() - 0.5) * 0.8], 0.012, { mat: MAT.timber, tone: 0.6 + R() * 0.25 }));
    }
    // Branches laid ALONG the fence, piled: they give it body without the
    // woven-lump look (the thatch lumps read as baskets).
    for (const hgt of [0.35, 0.7, 1.05]) {
      const l = 0.9 + R() * 0.6, y1 = g + hgt + (R() - 0.5) * 0.25, y2 = g + hgt + (R() - 0.5) * 0.35;
      parts.push(wirePart([x - tx * l / 2, y1, z - tz * l / 2], [x + tx * l / 2 + Math.cos(a) * (R() - 0.5) * 0.3, y2, z + tz * l / 2 + Math.sin(a) * (R() - 0.5) * 0.3], 0.03, { mat: MAT.timber, tone: 0.5 + R() * 0.3 }));
    }
  }
  parts.push(...brushClump(R, 1.4, groundAt(1.4, -r - 0.9), -r - 0.9, { h: 0.8, r: 0.7, dry: true }));
  // Inside: a trough, a heap of fodder, a few stones.
  const tg = groundAt(-1.5, 1.5);
  parts.push(...stoneTrough(rng(seed + 3), -1.5, tg, 1.5, 0.4, { len: 2.0 }));
  const fg = groundAt(2, 2.2);
  parts.push({ geo: earthBerm([[1.2, -0.15], [0.9, 0.35], [0.4, 0.6], [0.001, 0.65]], { seed, segs: 12, rJit: 0.15, yJit: 0.08 }), pos: [2, fg, 2.2], mat: MAT.thatch, tone: 0.45 });
  return finish(parts, { hx: r + 1.2, hz: r + 1.6, height: 1.8 });
}

// ── THE LAND ROUND THE VILLAGE ──────────────────────────────────────────────

const KIT = 1.3;   // finish() scales the geometry; lists of points follow it
const scaled = (list) => list.map((t) => ({ ...t, x: t.x * KIT, z: t.z * KIT }));
/**
 * `userData.coverLines`: the walls a man can crouch behind, [{ pts: [[x, z]],
 * hard }] in the piece's frame (scaled). With `coverPerimeter: false` they
 * are all the cover the piece gives (the game's cover map: algCover.js).
 */
const scaledLines = (lines) => lines.map((w) => ({ hard: w.hard, pts: w.pts.map(([x, z]) => [x * KIT, z * KIT]) }));

/**
 * GARDEN — a walled plot of olives (or figs): dry-stone walls chest high all
 * round, a gap for the gate at the front (-Z) with two big stones for posts
 * and a bundle of thorn brush to close it, the trees in loose rows inside,
 * the stones cleared off the soil piled in a corner. A prickly-pear hedge
 * along the back and one side, outside the wall (userData.hedge).
 *
 * `kind`: "olive" (a fig or two by the wall), "fig", or "mixed".
 */
export function buildGarden({ seed = 1961, w = 18, d = 13, kind = "olive", groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const hx = w / 2, hz = d / 2, gx = -hx * 0.3, gate = 1.6;
  // One run round from one gatepost to the other: the corners bond.
  const wall = [[gx - gate, -hz], [-hx, -hz], [-hx, hz], [hx, hz], [hx, -hz], [gx + gate, -hz]];
  dryStone(parts, R, wall, { courses: 3, h: 1.1, depth: 0.55, len: 0.55, groundAt, tone: 0.5 });
  for (const sx of [-1, 1]) {
    const x = gx + sx * (gate + 0.1), g = groundAt(x, -hz);
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.55, 1.45, 0.6), pos: [x, g + 0.55, -hz], rot: [0, R() * 0.4, 0], mat: MAT.limestone, tone: 0.5 });
  }
  parts.push(...brushClump(R, gx + gate * 0.6, groundAt(gx + gate * 0.6, -hz + 0.3), -hz + 0.3, { h: 0.9, r: 0.6, dry: true }));
  // The cleared stones, heaped in the back corner.
  const cx = hx - 1.6, cz = hz - 1.6, cg = groundAt(cx, cz);
  for (let k = 0; k < 9; k++) {
    const a = R() * Math.PI * 2, rr = R() * 0.8;
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.45 + R() * 0.3, 0.35 + R() * 0.2, 0.4 + R() * 0.3), pos: [cx + Math.cos(a) * rr, cg + 0.12 + (k > 5 ? 0.25 : 0), cz + Math.sin(a) * rr], rot: [R(), R() * 3, R()], mat: MAT.limestone, tone: 0.4 + R() * 0.2 });
  }
  // The trees, in loose rows (olives ~7 m apart in kit metres: 9 m on the ground).
  const trees = [];
  const sp = kind === "fig" ? 5.5 : 7;
  for (let z = -hz + 2.6; z <= hz - 2.4; z += sp * (0.9 + R() * 0.2)) {
    for (let x = -hx + 2.6 + R() * 0.8; x <= hx - 2.4; x += sp * (0.9 + R() * 0.2)) {
      if (Math.hypot(x - cx, z - cz) < 2.6) continue;                // the stone heap
      const edge = Math.min(hx - Math.abs(x), hz - Math.abs(z)) < 3.2;
      const k = kind === "mixed" ? (R() < 0.45 ? "fig" : "olive") : kind === "olive" && edge && R() < 0.2 ? "fig" : kind;
      trees.push({ kind: k, x: x + (R() - 0.5) * 1.2, z: z + (R() - 0.5) * 1.2, scale: 0.8 + R() * 0.35, seed: Math.floor(R() * 1000) });
    }
  }
  // The hedge: back and left side, a metre outside the wall, with gaps.
  const hedge = [];
  for (let x = -hx - 1; x <= hx + 1; x += 1.6) if (R() > 0.15) hedge.push([x + (R() - 0.5) * 0.5, hz + 1.1 + (R() - 0.5) * 0.4]);
  for (let z = -hz + 1; z < hz; z += 1.6) if (R() > 0.2) hedge.push([-hx - 1.1 + (R() - 0.5) * 0.4, z + (R() - 0.5) * 0.5]);
  const geo = finish(parts, { hx: hx + 0.6, hz: hz + 0.6, height: 1.6 });
  geo.userData.trees = scaled(trees);
  geo.userData.hedge = hedge.map(([x, z]) => [x * KIT, z * KIT]);
  // Cover along the wall, both faces (a man outside it or in the orchard).
  geo.userData.coverLines = scaledLines([{ pts: wall, hard: true }]);
  geo.userData.coverPerimeter = false;
  // The walls block; the gate (1.6 x 2, a nav cell wide at 1.3) stays open.
  // Each rect at least half a 4 m nav cell thick, or it stamps no cell.
  const t = 2 / KIT;
  geo.userData.navRects = [
    { cx: 0, cz: hz, hx: hx + 0.3, hz: t },
    { cx: -hx, cz: 0, hx: t, hz: hz + 0.3 },
    { cx: hx, cz: 0, hx: t, hz: hz + 0.3 },
    { cx: (-hx + gx - gate) / 2, cz: -hz, hx: (gx - gate + hx) / 2, hz: t },
    { cx: (hx + gx + gate) / 2, cz: -hz, hx: (hx - gx - gate) / 2, hz: t },
  ].map((r) => ({ cx: r.cx * KIT, cz: r.cz * KIT, hx: r.hx * KIT, hz: r.hz * KIT }));
  return geo;
}

/**
 * FIELD WALL SEGMENT — 2 m of the low dry-stone wall round a field: two
 * courses of stones cleared off the soil, knee-high (0.7 m), along local X.
 * The game INSTANCES it along every field edge (alg-rts algFields.js: a few
 * seeds for variety, one draw each, however long the walls run), each
 * segment seated on the ground under it — a hand-built wall steps down a
 * slope the same way.
 */
export function buildFieldWallSegment({ seed = 1964 } = {}) {
  const R = rng(seed);
  const parts = [];
  dryStone(parts, R, [[-1.05, 0], [1.05, 0]], { courses: 2, h: 0.7, depth: 0.5, len: 0.5, batter: 0.04, tone: 0.5 });
  // A loose stone or two fallen at its foot.
  for (let k = 0; k < 2; k++) parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.32, 0.22, 0.28), pos: [(R() - 0.5) * 1.6, 0.06, (R() < 0.5 ? -1 : 1) * 0.42], rot: [R(), R() * 3, R()], mat: MAT.limestone, tone: 0.45 });
  return finish(parts, { hx: 1.1, hz: 0.45, height: 0.75, ao: { strength: 0.3 } });
}

// ── THE LAND BETWEEN THE VILLAGES ───────────────────────────────────────────

/** A house of rtsMechta seated on the ground: its socle down to the lowest ground under it. */
function seatedHouse(parts, R, groundAt, o) {
  const { top, low } = groundSpan(groundAt, o.x, o.z, o.w + 0.4, o.d + 0.4);
  const n0 = parts.length;
  const hh = house(parts, R, o);
  lift(parts, n0, top);
  const sh = top - low + 0.7 + 0.22;
  parts.push({ geo: buildBox(o.w + 0.36, sh, o.d + 0.36), pos: [o.x, top + 0.22 - sh / 2, o.z], rot: [0, o.yaw, 0], mat: MAT.rubble, tone: 0.32 + R() * 0.12 });
  return { ...hh, top };
}

/**
 * FARMSTEAD — one family's place out in the land (alg-rts algLandmarks.js
 * scatters them between the villages, a place worth holding in the empty
 * middle of the map): the main house and a byre at right angles, a walled
 * yard in front of them with the bread oven, a thorn pen for the goats, a
 * straw heap, a fig and an olive or two, prickly pear along the back.
 * Front (the yard's gate) at -Z.
 */
export function buildFarmstead({ seed = 1970, groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const houses = [];
  // The house along the back, the byre down the left side.
  const w = 7.5 + R() * 2, d = 4.8 + R() * 0.6;
  const h1 = seatedHouse(parts, R, groundAt, { x: 0.6, z: 3.2, yaw: 0, w, d, h: 2.7 + R() * 0.4, storey2: R() < 0.25, doorFace: -1, leanTo: false });
  houses.push({ x: 0.6, z: 3.2 });
  const bw = 5 + R(), bd = 3.8;
  const h2 = seatedHouse(parts, R, groundAt, { x: -w / 2 - bd / 2 - 0.2, z: -1.4, yaw: Math.PI / 2, w: bw, d: bd, h: 2.3, doorFace: -1, leanTo: false });
  houses.push({ x: -w / 2 - bd / 2 - 0.2, z: -1.4 });
  void h1; void h2;
  // The yard wall: from the byre's front corner round to the house's right end, a gate at the front.
  const yx0 = -w / 2 + 0.2, yx1 = w / 2 + 1.2, yz = -5.6, gate = 0.6 + R() * 1.5;
  const wallPts = [[yx0, yz], [gate - 1.3, yz], null, [gate + 1.3, yz], [yx1, yz], [yx1, 3.2 - d / 2 - 0.3]];
  const yardLines = [];
  for (let k = 0; k < wallPts.length - 1; k++) {
    const a = wallPts[k], b = wallPts[k + 1];
    if (!a || !b) continue;
    groundWall(parts, R, groundAt, a, b, { h: 1.3, t: 0.5 });
    yardLines.push({ hard: true, pts: [a, b] });
  }
  // The oven in the yard, a straw heap, two jars.
  const ox = yx1 - 2.2, oz = yz + 2.2, og = groundAt(ox, oz);
  const n0 = parts.length;
  oven(parts, R, ox, oz, Math.PI * 1.2);
  lift(parts, n0, og);
  parts.push({ geo: earthBerm([[1.3, -0.1], [1.1, 0.5], [0.6, 1.0], [0.001, 1.15]], { seed: seed + 3, segs: 14, rJit: 0.12, yJit: 0.08 }), pos: [-2.2, groundAt(-2.2, -3.4), -3.4], mat: MAT.thatch, tone: 0.5 });
  parts.push(clayJar(1.8, groundAt(1.8, 0.2) - 0.02, 0.2, 1));
  parts.push(clayJar(2.4, groundAt(2.4, 0.4) - 0.02, 0.4, 0.85));
  // The thorn pen, out to the right of the yard: a ring of cut thorn.
  const px = yx1 + 6.5, pz = -1.5, pr = 3.6;
  for (let k = 0; k < 16; k++) {
    if (k === 12) continue;                                  // its gap
    const a = (k / 16) * Math.PI * 2, x = px + Math.cos(a) * pr, z = pz + Math.sin(a) * pr;
    parts.push(...brushClump(R, x, groundAt(x, z), z, { h: 0.9, r: 0.45, dry: true }));
  }
  const trees = [
    { kind: "fig", x: yx1 - 1.5, z: yz + 4.8, scale: 0.9 + R() * 0.25, seed: Math.floor(R() * 1000) },
    { kind: "olive", x: -w / 2 - 6, z: 5.5, scale: 0.85 + R() * 0.3, seed: Math.floor(R() * 1000) },
  ];
  if (R() < 0.6) trees.push({ kind: "olive", x: w / 2 + 4.5, z: 7.5, scale: 0.8 + R() * 0.3, seed: Math.floor(R() * 1000) });
  // Prickly pear along the back, behind the house.
  const hedge = [];
  for (let x = -w / 2 - 2; x <= w / 2 + 3; x += 1.2) if (R() > 0.15) hedge.push([x + (R() - 0.5) * 0.4, 3.2 + d / 2 + 2.2 + (R() - 0.5) * 0.4]);
  const geo = finish(parts, { hx: (yx1 + 10.5 - (-w / 2 - bd - 0.5)) / 2, hz: 7.5, cx: (yx1 + 10.5 + (-w / 2 - bd - 0.5)) / 2, cz: 0.6, height: 3.4 });
  geo.userData.houses = scaled(houses);
  geo.userData.trees = scaled(trees);
  geo.userData.hedge = hedge.map(([x, z]) => [x * KIT, z * KIT]);
  // Cover: the yard walls and the houses' walls; the open ground round them none.
  const outline = (cx, cz, hw, hd, yaw) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), p = (lx, lz) => [cx + lx * c + lz * s, cz - lx * s + lz * c];
    return { hard: true, pts: [p(-hw, -hd), p(hw, -hd), p(hw, hd), p(-hw, hd), p(-hw, -hd)] };
  };
  geo.userData.coverLines = scaledLines([...yardLines, outline(0.6, 3.2, w / 2 + 0.2, d / 2 + 0.2, 0), outline(-w / 2 - bd / 2 - 0.2, -1.4, bw / 2 + 0.2, bd / 2 + 0.2, Math.PI / 2)]);
  geo.userData.coverPerimeter = false;
  // The houses block; the yard, its gate and the pen stay open (men walk in).
  const t = 2 / KIT;
  geo.userData.navRects = [
    { cx: 0.6, cz: 3.2, hx: w / 2 + 0.2, hz: d / 2 + 0.2 },
    { cx: -w / 2 - bd / 2 - 0.2, cz: -1.4, hx: bd / 2 + 0.2, hz: bw / 2 + 0.2 },
    { cx: yx1, cz: (yz + 3.2 - d / 2) / 2, hx: t, hz: (3.2 - d / 2 - yz) / 2 },
  ].map((r) => ({ cx: r.cx * KIT, cz: r.cz * KIT, hx: r.hx * KIT, hz: r.hz * KIT }));
  return geo;
}

/**
 * ROMAN RUIN — the Aurès is full of them (Timgad is at its foot): a temple's
 * podium of big cut blocks, a few columns still standing at different
 * heights, drums fallen in the grass in a line, a piece of architrave, blocks
 * scattered. Hard cover among the blocks; walked through.
 */
export function buildRomanRuin({ seed = 1980, groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const PW = 11, PD = 7;
  const { top, low } = groundSpan(groundAt, 0, 0, PW, PD);
  // The podium: two courses of blocks, the upper set back, broken at one corner.
  const ph = top - low + 1.0;
  parts.push({ geo: buildBox(PW, ph, PD), pos: [0, top + 0.45 - ph / 2, 0], mat: MAT.sandstone, tone: 0.55 });
  parts.push({ geo: buildBox(PW - 1.2, 0.5, PD - 1.2), pos: [-0.3, top + 0.7, 0.2], mat: MAT.sandstone, tone: 0.62 });
  const deck = top + 0.95;
  // Columns: a row of 5 along the front, most broken.
  const colH = [5.6, 2.1, 0, 4.2, 1.3];
  colH.forEach((hgt, k) => {
    const x = -4 + k * 2;
    if (!hgt) return;
    parts.push({ geo: new THREE.CylinderGeometry(0.42, 0.48, 0.35, 12), pos: [x, deck + 0.17, -2.4], mat: MAT.sandstone, tone: 0.5 });
    parts.push({ geo: new THREE.CylinderGeometry(0.36, 0.4, hgt, 12), pos: [x, deck + 0.34 + hgt / 2, -2.4], rot: [(R() - 0.5) * 0.03, 0, (R() - 0.5) * 0.03], mat: MAT.sandstone, tone: 0.58 + R() * 0.1 });
    if (hgt > 5) parts.push({ geo: buildBox(1.1, 0.42, 1.1), pos: [x, deck + 0.34 + hgt + 0.21, -2.4], mat: MAT.sandstone, tone: 0.55 });
  });
  // The architrave block that fell off the tall one, across the podium edge.
  parts.push({ geo: buildBox(3.2, 0.6, 0.75), pos: [-2.6, deck + 0.3, -0.8], rot: [0, 0.35, 0.06], mat: MAT.sandstone, tone: 0.5 });
  // Fallen drums in a line in front, in the grass (ground level).
  for (let k = 0; k < 4; k++) {
    const x = 1.5 + k * 1.15, z = -6.2 + k * 0.3;
    parts.push({ geo: new THREE.CylinderGeometry(0.38, 0.38, 1.05, 12), pos: [x, groundAt(x, z) + 0.3, z], rot: [0, 0.3 + (R() - 0.5) * 0.3, Math.PI / 2], mat: MAT.sandstone, tone: 0.5 + R() * 0.1 });
  }
  // Scattered blocks.
  for (let k = 0; k < 7; k++) {
    const a = R() * Math.PI * 2, r = 6.5 + R() * 3, x = Math.cos(a) * r, z = Math.sin(a) * r * 0.8;
    const bw = 0.8 + R() * 0.7;
    parts.push({ geo: buildBox(bw, 0.5 + R() * 0.3, 0.6 + R() * 0.4), pos: [x, groundAt(x, z) + 0.15, z], rot: [(R() - 0.5) * 0.3, R() * 3, (R() - 0.5) * 0.3], mat: MAT.sandstone, tone: 0.45 + R() * 0.15 });
  }
  const geo = finish(parts, { hx: 9, hz: 8, height: 6.5 });
  geo.userData.coverLines = scaledLines([{ hard: true, pts: [[-PW / 2, -PD / 2], [PW / 2, -PD / 2], [PW / 2, PD / 2], [-PW / 2, PD / 2], [-PW / 2, -PD / 2]] }]);
  geo.userData.coverPerimeter = false;
  geo.userData.navRects = [{ cx: 0, cz: 0, hx: PW / 2 * KIT, hz: PD / 2 * KIT }];
  return geo;
}

/**
 * BURNT FARM — a colon's farm the ALN burnt early in the war: the long
 * stuccoed house roofless, its walls standing to different heights with the
 * window holes black, charred rafters fallen in, one corner of the tiled roof
 * still up, rubble heaped against it. A ruin to fight in.
 */
export function buildBurntFarm({ seed = 1990, groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const W = 14, D = 7, T = 0.45;
  const { top, low } = groundSpan(groundAt, 0, 0, W + 1, D + 1);
  const sh = top - low + 0.6;
  // Its floor: the socle top, burnt earth and ash (the rubble cell read as bluish stone).
  parts.push({ geo: buildBox(W + 0.6, sh, D + 0.6), pos: [0, top + 0.2 - sh / 2, 0], mat: MAT.spoil, tone: 0.12 });
  const y0 = top + 0.2;
  // The walls in 2 m bays, each its own broken height (fire and shells).
  const side = (ax, az, bx, bz, full) => {
    const len = Math.hypot(bx - ax, bz - az), n = Math.round(len / 2), yaw = Math.atan2(bx - ax, bz - az);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, hgt = full * (R() < 0.25 ? 0.25 + R() * 0.3 : 0.65 + R() * 0.35);
      parts.push({ geo: buildBox(T + (k % 2) * 0.03, hgt, len / n + 0.02), pos: [ax + (bx - ax) * t, y0 + hgt / 2, az + (bz - az) * t], rot: [0, yaw, 0], mat: MAT.stucco, tone: 0.2 + R() * 0.14 });   // smoke-grimed: clean stucco read new
      const nx = Math.cos(yaw), nz = -Math.sin(yaw), cx = ax + (bx - ax) * t, cz = az + (bz - az) * t;
      // A window hole: a black patch high on the outside face.
      if (hgt > full * 0.7 && R() < 0.5) {
        parts.push({ geo: buildBox(0.05, 0.9, 0.8), pos: [cx + nx * (T / 2 + 0.03), y0 + hgt - 0.9, cz + nz * (T / 2 + 0.03)], rot: [0, yaw, 0], mat: MAT.steel, tone: 0.02 });
      }
      // SOOT: the fire blackened the upper part of most bays, inside and out
      // (the stucco's tone barely darkens it — the burnt farm read new).
      if (R() < 0.8) {
        const sh2 = hgt * (0.3 + R() * 0.25), sw = len / n - 0.12;
        for (const sgn of [-1, 1]) {
          parts.push({ geo: buildBox(0.04, sh2, sw), pos: [cx + sgn * nx * (T / 2 + 0.02 + (k % 2) * 0.015), y0 + hgt - sh2 / 2 - 0.02, cz + sgn * nz * (T / 2 + 0.02 + (k % 2) * 0.015)], rot: [0, yaw, 0], mat: MAT.timber, tone: 0.02 + R() * 0.04 });
        }
      }
    }
  };
  side(-W / 2, -D / 2, W / 2, -D / 2, 4.2);
  side(W / 2, -D / 2 + 0.25, W / 2, D / 2 - 0.25, 4.2);
  side(W / 2, D / 2, -W / 2, D / 2, 4.2);
  side(-W / 2, D / 2 - 0.25, -W / 2, -D / 2 + 0.25, 4.2);
  // One corner of the roof still on: tiles on rafters, sagging.
  parts.push({ geo: buildBox(3.6, 0.14, 4.2), pos: [W / 2 - 2, y0 + 4.5, D / 2 - 2.2], rot: [0.32, 0, 0.05], mat: MAT.tile, tone: 0.42 });
  // Charred rafters fallen in, ends up on the walls.
  for (let k = 0; k < 5; k++) {
    const x = -W / 2 + 2 + k * 2.3 + (R() - 0.5);
    parts.push({ geo: buildBox(0.18, 0.18, D - 0.4), pos: [x, y0 + 1.2 + R() * 1.2, (R() - 0.5) * 0.6], rot: [(R() - 0.5) * 0.7, (R() - 0.5) * 0.4, 0], mat: MAT.timber, tone: 0.03 });
  }
  // Rubble inside and against the front.
  for (let k = 0; k < 12; k++) {
    const x = (R() - 0.5) * (W - 1.5), z = (R() - 0.5) * (D - 1.5) + (k > 8 ? -D / 2 - 0.9 : 0);
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.5 + R() * 0.4, 0.3 + R() * 0.25, 0.4 + R() * 0.3), pos: [x, (k > 8 ? groundAt(x, z) : y0) + 0.12, z], rot: [R(), R() * 3, R()], mat: MAT.rubble, tone: 0.3 + R() * 0.2 });
  }
  const geo = finish(parts, { hx: W / 2 + 1.2, hz: D / 2 + 1.6, cz: -0.4, height: 4.6 });
  geo.userData.houses = [{ x: 0, z: 0 }];
  geo.userData.coverLines = scaledLines([{ hard: true, pts: [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2], [-W / 2, -D / 2]] }]);
  geo.userData.coverPerimeter = false;
  // Its walls block; men get in through the broken low bays (a gap each side).
  const t = 2 / KIT;
  geo.userData.navRects = [
    { cx: -W / 4 - 1, cz: -D / 2, hx: W / 4 - 1, hz: t },
    { cx: W / 4 + 1, cz: D / 2, hx: W / 4 - 1, hz: t },
    { cx: W / 2, cz: 0, hx: t, hz: D / 2 },
  ].map((r) => ({ cx: r.cx * KIT, cz: r.cz * KIT, hx: r.hx * KIT, hz: r.hz * KIT }));
  return geo;
}

/**
 * TERRACES — almonds on a slope: dry-stone retaining walls along the
 * contour, each holding the ground up behind it (its height is what the
 * slope gives: a low kerb on the flat, a metre and more on a hillside), a
 * row of trees on each step. The slope rises along +Z (turn the piece so it
 * climbs away from the camera, as the dechra does). The ground itself is
 * not graded: the walls read as the terraces from an RTS camera.
 */
export function buildTerraces({ seed = 1962, w = 22, rows = 4, step = 5, kind = "almond", groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const trees = [];
  const coverLines = [];
  const z0 = -((rows - 1) * step) / 2;
  for (let r = 0; r < rows; r++) {
    // A wall a little bowed and a little shorter or longer each step, the
    // way hand-built terraces follow the hill.
    const z = z0 + r * step + (R() - 0.5) * 0.6, bow = (R() - 0.5) * 1.8;
    const a = -w / 2 + R() * 1.5, b = w / 2 - R() * 1.5;
    // The wall as a line for the cover map (no R(): the stones stay put).
    coverLines.push({ hard: true, pts: Array.from({ length: 7 }, (_, k) => { const x = a + ((b - a) * k) / 6; return [x, z + bow * Math.sin((Math.PI * k) / 6)]; }) });
    let s = a;
    while (s < b) {
      const l = 0.5 + R() * 0.3, x = s + l / 2;
      const zz = z + bow * Math.sin(Math.PI * (x - a) / (b - a));
      // Foot on the downhill ground, top at the uphill ground behind it.
      const foot = groundAt(x, zz - 0.4), top = Math.max(foot + 0.45, groundAt(x, zz + 1.2) + 0.12);
      const n = Math.min(7, Math.ceil((top - foot + 0.12) / 0.3));
      for (let c = 0; c < n; c++) {
        const sh = 0.3 * (1.1 + R() * 0.3);
        parts.push({
          geo: fieldStone(Math.floor(R() * 1e6), l + 0.1, sh, 0.5 * (0.85 + R() * 0.3)),
          pos: [x + (c % 2) * 0.12, foot - 0.12 + c * 0.3 + sh * 0.42, zz + c * 0.04],
          rot: [(R() - 0.5) * 0.1, (R() - 0.5) * 0.2, (R() - 0.5) * 0.1],
          mat: MAT.limestone, tone: 0.38 + R() * 0.24,
        });
      }
      s += l;
    }
    // The step's trees, 5-6 m apart, on the tread above this wall.
    if (r < rows - 1 || R() < 0.5) {
      for (let x = a + 2 + R() * 2; x < b - 1.5; x += 5 + R() * 1.5) {
        trees.push({ kind, x, z: z + step * 0.5 + bow * Math.sin(Math.PI * (x - a) / (b - a)) * 0.6 + (R() - 0.5) * 0.8, scale: 0.8 + R() * 0.35, seed: Math.floor(R() * 1000) });
      }
    }
  }
  const geo = finish(parts, { hx: w / 2 + 0.5, hz: (rows * step) / 2 + 0.5, height: 1.8 });
  geo.userData.trees = scaled(trees);
  geo.userData.navRects = [];    // men climb terraces
  geo.userData.coverLines = scaledLines(coverLines);   // each wall, not the plot's outline
  geo.userData.coverPerimeter = false;
  return geo;
}

/**
 * THRESHING FLOOR (aire à battre) — a round floor of beaten earth paved
 * with flat stones, a ring of stones set on edge round it, on the windy
 * shoulder where the chaff blows off: the mules walk the sheaves round it
 * in summer. A heap of straw at its side, a wooden fork. Stands on a pad.
 */
export function buildThreshingFloor({ seed = 1963, r = 4.5 } = {}) {
  const R = rng(seed);
  const parts = [];
  // The floor: a very flat dome of earth, well clear of the ground band.
  parts.push({ geo: earthBerm([[r + 0.25, -0.14], [r, 0.1], [r * 0.5, 0.13], [0.001, 0.14]], { seed, segs: 28, rJit: 0.03, yJit: 0.005 }), pos: [0, 0, 0], mat: MAT.spoil, tone: 0.5 });
  // Paving: flat stones on a jittered hex grid, smaller than their spacing
  // (they never overlap: no two faces share a plane).
  const pitch = 0.82;
  for (let j = -Math.ceil(r / pitch); j <= Math.ceil(r / pitch); j++) {
    for (let i = -Math.ceil(r / pitch); i <= Math.ceil(r / pitch); i++) {
      const x = (i + (j % 2) * 0.5) * pitch + (R() - 0.5) * 0.08, z = j * pitch * 0.87 + (R() - 0.5) * 0.08;
      if (Math.hypot(x, z) > r - 0.45 || R() < 0.08) continue;
      // Near the pitch, turned only a little: tight paving (0.5 m slabs with
      // earth between read as a biscuit's dots, seen in the game).
      parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.72 + R() * 0.06, 0.1, 0.64 + R() * 0.06), pos: [x, 0.13 + R() * 0.012, z], rot: [0, (j % 2) * 0.5 + (R() - 0.5) * 0.3, 0], mat: MAT.limestone, tone: 0.5 + R() * 0.2 });
    }
  }
  // The kerb: stones on edge round the rim.
  const n = Math.round((2 * Math.PI * r) / 0.52);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + (R() - 0.5) * 0.03, x = Math.cos(a) * (r - 0.12), z = Math.sin(a) * (r - 0.12);
    const h = 0.36 + R() * 0.14;
    parts.push({ geo: fieldStone(Math.floor(R() * 1e6), 0.5, h, 0.2), pos: [x, h * 0.3, z], rot: [(R() - 0.5) * 0.15, -a + Math.PI / 2, (R() - 0.5) * 0.1], mat: MAT.limestone, tone: 0.42 + R() * 0.2 });
  }
  // A heap of straw beside it, and a wooden fork leaning on the heap.
  parts.push({ geo: earthBerm([[1.5, -0.1], [1.1, 0.5], [0.5, 0.85], [0.001, 0.92]], { seed: seed + 1, segs: 14, rJit: 0.18, yJit: 0.1 }), pos: [r + 1.6, 0, 0.8], mat: MAT.thatch, tone: 0.6 });
  // Handle on the ground, tines up in the straw (a fork is left that way).
  const f0 = [r + 0.4, 0.05, 0.4], f1 = [r + 1.3, 1.4, 0.85];
  parts.push(wirePart(f0, f1, 0.03, { mat: MAT.timber, tone: 0.45 }));
  for (const o of [-0.12, 0, 0.12]) parts.push(wirePart(f1, [f1[0] + 0.21 - 0.27 * o, f1[1] + 0.32, f1[2] + 0.11 + 0.53 * o], 0.014, { mat: MAT.timber, tone: 0.45 }));
  const geo = finish(parts, { hx: r + 0.5, hz: r + 0.5, height: 1 });
  geo.userData.navRects = [];    // walked over
  geo.userData.coverPerimeter = false;   // flat: no cover (a kerb 0.4 m high)
  return geo;
}

// ── KSAR ────────────────────────────────────────────────────────────────────

/** Highest and lowest ground under a TURNED rectangle (local half sizes). */
function groundSpanRot(groundAt, cx, cz, yaw, hx, hz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let top = -Infinity, low = Infinity;
  for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const lx = a * hx, lz = b * hz, g = groundAt(cx + lx * c + lz * s, cz - lx * s + lz * c);
    top = Math.max(top, g); low = Math.min(low, g);
  }
  return { top, low };
}

/** Local → world placement for the parts of a building turned `yaw` at (x, y, z). */
function placer(parts, x, y, z, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (geo, lp, mat, tone, rot = [0, 0, 0]) => {
    parts.push({ geo, pos: [x + lp[0] * c + lp[2] * s, y + lp[1], z - lp[0] * s + lp[2] * c], rot: [rot[0], rot[1] + yaw, rot[2]], mat, tone });
  };
}

/** A square prism tapering from `wb` to `wt` over `h`, flat-shaded, kit UVs. */
function taperBox(wb, wt, h) {
  let g = new THREE.CylinderGeometry(wt / Math.SQRT2, wb / Math.SQRT2, h, 4, 1);
  g.rotateY(Math.PI / 4);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (wb + wt), uv.getY(i) * (h / 2));
  g = g.toNonIndexed();
  g.computeVertexNormals();
  return mergeVertices(g);   // indexed again (the kit merges indexed parts); flat normals keep the faces apart
}

/**
 * A parapet round a flat roof whose top is at `top`: the long sides (local
 * ±Z) full width and 4 cm proud, the ends 3 cm lower and 2 cm inside them
 * (flush corners z-fight), and — the M'zab's tell — little pointed horns at
 * the corners.
 */
function parapet(put, R, { ox = 0, oz = 0, w, d, top, mat, tone, ph = 0.5 + R() * 0.3, horns = R() < 0.75 }) {
  const t = 0.24;
  for (const sz of [-1, 1]) put(buildBox(w + 0.08, ph, t), [ox, top + ph / 2, oz + sz * (d / 2 - t / 2 + 0.04)], mat, tone * 0.96);
  for (const sx of [-1, 1]) put(buildBox(t, ph - 0.03, d - 2 * t + 0.1), [ox + sx * (w / 2 - t / 2 + 0.02), top + (ph - 0.03) / 2, oz], mat, tone * 0.96);
  if (!horns) return;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    put(new THREE.ConeGeometry(0.19, 0.6, 4), [ox + sx * (w / 2 - 0.08), top + ph + 0.28, oz + sz * (d / 2 - 0.08)], mat, tone, [0, Math.PI / 4, 0]);
  }
}

/**
 * ONE KSAR HOUSE: a plastered cube whose walls run down to the ground on the
 * slope (so the town stacks, house over house, as the M'zab does), a parapet,
 * small dark square windows, a door on the front (local -Z) at the ground,
 * sometimes a roof room at the back, a palm-frond shade, a spout.
 * `y` is its floor (the highest ground under it), `low` the lowest.
 */
function ksarHouse(parts, R, { x, z, yaw, w, d, h, y, low, frontGround, mat, tone }) {
  const put = placer(parts, x, y, z, yaw);
  const drop = y - low + 0.3;                      // wall below the floor, down the slope
  put(buildBox(w, h + drop, d), [0, (h - drop) / 2, 0], mat, tone);
  parapet(put, R, { w, d, top: h, mat, tone });
  const win = (lx, ly, lz, ry = 0) => {
    const shut = R() < 0.3;
    put(buildBox(shut ? 0.62 : 0.5, shut ? 0.72 : 0.55, 0.05), [lx, ly, lz], shut ? MAT.timber : MAT.steel, shut ? 0.2 + R() * 0.15 : 0.02, [0, ry, 0]);
  };
  // Windows, a row per storey, few and small (the house looks inward).
  const storeys = Math.max(1, Math.round(h / 3.1));
  const fz = -d / 2 - 0.02;
  for (let k = 0; k < storeys; k++) {
    // The ground storey's windows sit above the door's surround (2.25 m).
    const ly = (k * h) / storeys + (k === 0 ? Math.min(2.6, h / storeys - 0.5) : Math.min(2.1, (h / storeys) * 0.66));
    const n = k === 0 ? (R() < 0.4 ? 1 : 0) : 1 + Math.floor(R() * Math.max(1, (w - 1.2) / 1.9));
    for (let i = 0; i < n; i++) win(-w / 2 + 0.8 + ((i + 0.5) * (w - 1.6)) / n + (R() - 0.5) * 0.3, ly, fz);
    if (k > 0 && R() < 0.5) win(w / 2 + 0.02, ly, (R() - 0.5) * (d - 1.6), Math.PI / 2);
    if (k > 0 && R() < 0.35) win(-w / 2 - 0.02, ly, (R() - 0.5) * (d - 1.6), Math.PI / 2);
  }
  // Down the slope the wall is a storey taller: a row of slits in it.
  const fg = frontGround - y;
  if (fg < -2.4) for (let i = 0; i < 1 + Math.floor(R() * 2); i++) win(-w / 2 + 1 + R() * (w - 2), fg + 1.4, fz);
  // The door, at the ground in front: timber in a lighter surround.
  const dx = (R() - 0.5) * (w - 2);
  if (fg > -2.6) {
    put(buildBox(1.3, 2.25, 0.04), [dx, fg + 1.12, fz + 0.008], mat, Math.min(1, tone + 0.15));   // its own plane, not a window's
    put(buildBox(0.92, 1.9, 0.05), [dx, fg + 0.95, fz - 0.02], MAT.timber, 0.12 + R() * 0.15);
  }
  // A room on the roof at the back (the summer room), its own parapet.
  let room = false, shade = false;
  if (w > 4.6 && R() < 0.45) {
    room = true;
    const w2 = w * (0.4 + R() * 0.15), d2 = d * (0.45 + R() * 0.1), h2 = 2.3 + R() * 0.4;
    const ox = (R() - 0.5) * (w - w2 - 0.8), oz = d / 2 - d2 / 2 - 0.35;
    const m2 = R() < 0.7 ? mat : MAT.plasterPale;
    put(buildBox(w2, h2, d2), [ox, h + h2 / 2, oz], m2, tone * (0.9 + R() * 0.2));
    parapet(put, R, { ox, oz, w: w2, d: d2, top: h + h2, mat: m2, tone, ph: 0.35, horns: R() < 0.5 });
    put(buildBox(0.8, 1.7, 0.05), [ox + (R() - 0.5) * (w2 - 1.2), h + 0.85, oz - d2 / 2 - 0.02], MAT.steel, 0.02);
  } else if (R() < 0.35) {
    shade = true;
    // A shade of palm fronds on two poles over the roof's front corner.
    const sx = (R() < 0.5 ? -1 : 1) * (w / 2 - 1.2), sz = -d / 2 + 1.1;
    put(buildBox(1.9, 0.1, 1.5), [sx, h + 1.95, sz], MAT.thatch, 0.3 + R() * 0.2, [0.06, R() * 0.3, 0]);
    for (const px of [-0.8, 0.8]) put(buildBox(0.09, 1.95, 0.09), [sx + px, h + 0.97, sz - 0.6], MAT.timber, 0.3);
  }
  // LAUNDRY (you, 2026-09-30) on any roof without a frond shade — across the
  // open front when there is a roof room, else anywhere — now and then:
  // a line on two poles, cloths pegged along it. Its own random stream (from
  // the house's place), so the town as approved is unchanged.
  const RL = rng(Math.floor(Math.abs(x * 73.1 + z * 19.7)) + 5);
  if (!shade && RL() < 0.55) {
    const lz = (room || RL() < 0.5 ? -d / 4 : d / 4) + (RL() - 0.5) * 0.4, lx = w / 2 - 0.55, top = h + 1.55;
    for (const sx of [-1, 1]) put(buildBox(0.06, 1.55, 0.06), [sx * lx, h + 0.775, lz], MAT.timber, 0.3);
    put(buildBox(2 * lx, 0.02, 0.02), [0, top, lz], MAT.steel, 0.3);
    // Cloths: sheets and a haik (white), rugs in red, terracotta, olive and
    // green (the kit's cells): each its own width, drop and gap, and
    // alternate ones a few cm off the line's plane (no two faces share it).
    const CLOTH = [[MAT.white, 0.62], [MAT.white, 0.5], [MAT.laterite, 0.5], [MAT.tile, 0.55], [MAT.canvas, 0.45], [MAT.hessian, 0.4], [MAT.paint, 0.55], [MAT.laterite, 0.35]];
    let cx = -lx + 0.25 + RL() * 0.2, k = 0;
    while (cx < lx - 0.45) {
      const [cm, ct] = CLOTH[Math.floor(RL() * CLOTH.length)];
      const cw = 0.45 + RL() * 0.6, ch = 0.5 + RL() * 0.6;
      if (cx + cw > lx - 0.2) break;
      put(buildBox(cw, ch, 0.015), [cx + cw / 2, top - 0.01 - ch / 2, lz + (k % 2 ? 0.025 : -0.025)], cm, ct + RL() * 0.2);
      cx += cw + 0.08 + RL() * 0.25;
      k++;
    }
  }
  // A spout through the parapet (the roof drains to the lane).
  if (R() < 0.5) put(buildBox(0.14, 0.12, 0.6), [(R() - 0.5) * (w - 1), h + 0.15, -d / 2 - 0.26], MAT.timber, 0.25);
}

/**
 * AN ARCADE RANGE — the souk's side of the square: a row of round arches on
 * square piers (one extruded face, so the arches are real openings), the
 * gallery behind them dark with shop doors, a storey of small windows over
 * it, a parapet of pointed merlons, a lantern or two on brackets. Local frame:
 * the facade runs along X (`len`), its face at z = 0 looking -Z; the building
 * goes back to z = +depth. `fy` is the floor (the square's), `low` the lowest
 * ground under it.
 */
function arcadeRange(parts, R, { x, z, yaw, len, fy, low, mat = MAT.plaster, tone = 0.6, depth = 5.4 }) {
  const put = placer(parts, x, fy, z, yaw);
  const HA = 3.8, HT = 7.0, GAL = 3.0, T = 0.6;
  const drop = fy - low + 0.3;
  // Plinth + gallery floor (a step up from the square), the rear block, the storey over the gallery.
  put(buildBox(len + 0.1, drop, GAL + 0.1), [0, 0.18 - drop / 2, GAL / 2], MAT.rubble, 0.5);
  put(buildBox(len - 0.1, 0.2, GAL - 0.1), [0, 0.1, GAL / 2 + 0.02], MAT.earth, 0.3);
  put(buildBox(len, HT + drop, depth - GAL), [0, (HT - drop) / 2, GAL + (depth - GAL) / 2], mat, tone * 0.92);
  // The gallery's back wall in deep shade (the kit's dark cell): lit, the
  // arches read as shallow niches; the arcade's depth IS its shadow.
  put(buildBox(len - 0.2, HA - 0.05, 0.02), [0, 0.2 + (HA - 0.05) / 2, GAL - 0.012], MAT.steel, 0.12);
  // 3 cm proud of the arch face (a string course): flush, their planes met over 20 cm.
  put(buildBox(len + 0.04, HT - HA, GAL + 0.06), [0, HA + (HT - HA) / 2, GAL / 2 - 0.03], mat, tone);
  // THE ARCADE: piers and arches as one face with notches, extruded.
  const bays = Math.max(2, Math.round((len - 0.7) / 2.9));
  const pier = 0.7, ow = (len - pier * (bays + 1)) / bays, spring = 2.3;
  const sh = new THREE.Shape();
  sh.moveTo(0, 0);
  let px = 0;
  for (let b = 0; b < bays; b++) {
    px += pier;
    sh.lineTo(px, 0); sh.lineTo(px, spring);
    sh.absarc(px + ow / 2, spring, ow / 2, Math.PI, 0, true);
    sh.lineTo(px + ow, 0);
    px += ow;
  }
  sh.lineTo(len, 0); sh.lineTo(len, HA); sh.lineTo(0, HA); sh.lineTo(0, 0);
  const face = new THREE.ExtrudeGeometry(sh, { depth: T, bevelEnabled: false, curveSegments: 10 });
  const fuv = face.attributes.uv;
  for (let i = 0; i < fuv.count; i++) fuv.setXY(i, fuv.getX(i) * 0.5, fuv.getY(i) * 0.5);
  face.translate(-len / 2, 0.2, -0.03);
  put(mergeVertices(face), [0, 0, 0], mat, tone);   // indexed, as every kit part
  // In the gallery's shade: a shop door in each bay (dark, or timber shutters).
  px = -len / 2;
  for (let b = 0; b < bays; b++) {
    px += pier;
    const open = R() < 0.4;
    put(buildBox(Math.min(1.6, ow - 0.4), 2.2, 0.05), [px + ow / 2, 0.2 + 1.1, GAL - 0.05], open ? MAT.steel : MAT.timber, open ? 0.02 : 0.15 + R() * 0.2);
    px += ow;
  }
  // The storey over it: small windows, one per bay or so.
  px = -len / 2;
  for (let b = 0; b < bays; b++) {
    px += pier;
    if (R() < 0.8) put(buildBox(0.55, 0.62, 0.05), [px + ow / 2 + (R() - 0.5) * 0.4, HA + 1.5, -0.075], R() < 0.4 ? MAT.timber : MAT.steel, 0.05);
    px += ow;
  }
  // Parapet: a plain band with pointed merlons along the front.
  parapet(put, R, { oz: depth / 2 - 0.015, w: len, d: depth + 0.03, top: HT, mat, tone, ph: 0.45, horns: false });
  for (let m = -len / 2 + 0.5; m < len / 2 - 0.3; m += 0.95) put(new THREE.ConeGeometry(0.2, 0.5, 4), [m, HT + 0.45 + 0.23, -0.05], mat, tone, [0, Math.PI / 4, 0]);
  // Lanterns on iron brackets between the arches (as in the photo).
  for (const b of [1, bays - 2]) {
    if (b < 1 || b > bays - 1) continue;
    const lx = -len / 2 + pier / 2 + b * (pier + ow);
    put(buildBox(0.05, 0.05, 0.5), [lx, HA - 0.25, -0.28], MAT.steel, 0.2);
    put(buildBox(0.26, 0.4, 0.26), [lx, HA - 0.52, -0.5], MAT.white, 0.8);
  }
}

/**
 * KSAR — a fortified town of the Saharan fringe, the M'zab way: plastered
 * cubes in ochre and cream stacked up a knoll, house over house, wall to wall
 * with only lanes between them; at the summit the mosque and its tapering
 * minaret, the town's one vertical; at the foot, facing the camera (-Z), the
 * SOUK: a paved square with arcades on three sides; a palm grove below the
 * walls.
 *
 * The knoll's summit is the origin. The town fills an irregular outline that
 * spills down toward the souk, houses packed wall to wall facing down the
 * slope, winding alleys out from the mosque (a stair to the souk, two gates),
 * closed by a wall. `groundAt` as the other villages.
 */
export function buildKsar({ seed = 1830, groundAt = FLAT } = {}) {
  const R = rng(seed);
  const parts = [];
  const houses = [];
  const trees = [];
  // Whitewash rare: in the shade of the lanes it turned blue-grey (seen in the game).
  const matPick = () => { const r = R(); return r < 0.6 ? MAT.plaster : r < 0.9 ? MAT.plasterPale : r < 0.93 ? MAT.white : MAT.earth; };
  const toneOf = (m) => (m === MAT.white ? 0.28 + R() * 0.2 : m === MAT.earth ? 0.55 + R() * 0.2 : 0.35 + R() * 0.45);

  // ── The souk at the foot (-Z): square, arcades, steps ─────────────────────
  const SQ = { x0: -11, x1: 11, z0: -39.2, z1: -27 };
  let fy = -Infinity, flow = Infinity;
  for (let x = -16; x <= 16; x += 2) for (let z = -39; z <= -21.5; z += 2) { const g = groundAt(x, z); fy = Math.max(fy, g); flow = Math.min(flow, g); }
  arcadeRange(parts, R, { x: 0, z: SQ.z1, yaw: 0, len: 31, fy, low: flow, tone: 0.62 });
  for (const sx of [-1, 1]) {
    arcadeRange(parts, R, { x: sx * 11, z: -33.2, yaw: -sx * Math.PI / 2, len: 11.6, fy, low: flow, mat: sx < 0 ? MAT.plasterPale : MAT.plaster, tone: 0.5 + R() * 0.2, depth: 4.6 });
  }
  // The square: a terrace of beaten earth on a stone retaining wall.
  const sw = SQ.x1 - SQ.x0, sd = SQ.z1 - SQ.z0, scz = (SQ.z0 + SQ.z1) / 2;
  // Its top 7 cm up inside the slab: at the floor, its rim lay in the ground band.
  parts.push({ geo: buildBox(sw + 0.06, fy - flow + 0.37, sd + 0.06), pos: [0, fy + 0.07 - (fy - flow + 0.37) / 2, scz], mat: MAT.rubble, tone: 0.5 });
  parts.push({ geo: buildBox(sw - 0.2, 0.12, sd - 0.2), pos: [0, fy + 0.06, scz], mat: MAT.earth, tone: 0.85 });
  // Steps down from the square's front to the ground.
  const gFront = groundAt(0, SQ.z0 - 1);
  for (let k = 1; fy - k * 0.3 > gFront - 0.05 && k < 20; k++) {
    const top = fy - k * 0.3, hgt = top - gFront + 0.4;
    parts.push({ geo: buildBox(4 + (k % 2) * 0.06, hgt, 0.46), pos: [0, top - hgt / 2, SQ.z0 - 0.2 - k * 0.42], mat: MAT.limestone, tone: 0.5 + R() * 0.1 });
  }
  // A fountain (a stone basin) in the square.
  parts.push({ geo: new THREE.CylinderGeometry(1.3, 1.4, 0.6, 16), pos: [-2.5, fy + 0.3, -34], mat: MAT.limestone, tone: 0.55 });
  parts.push({ geo: new THREE.CylinderGeometry(1.05, 1.05, 0.05, 16), pos: [-2.5, fy + 0.58, -34], mat: MAT.steel, tone: 0.1 });

  // ── The mosque at the summit, the minaret on its front corner ─────────────
  {
    const w = 11, d = 8.5, h = 4.4, cx = 0, cz = 1.2;
    const { top, low } = groundSpanRot(groundAt, cx, cz, 0, w / 2, d / 2);
    const put = placer(parts, cx, top, cz, 0);
    const drop = top - low + 0.3;
    put(buildBox(w, h + drop, d), [0, (h - drop) / 2, 0], MAT.plasterPale, 0.62);
    parapet(put, R, { w, d, top: h, mat: MAT.plasterPale, tone: 0.6, ph: 0.4, horns: false });
    for (let m = -w / 2 + 0.45; m < w / 2 - 0.3; m += 0.9) put(new THREE.ConeGeometry(0.19, 0.5, 4), [m, h + 0.4 + 0.23, -d / 2 + 0.1], MAT.plasterPale, 0.6, [0, Math.PI / 4, 0]);
    // A row of small arched windows (dark) and the door.
    for (let k = 0; k < 7; k++) put(buildBox(0.42, 0.75, 0.05), [-w / 2 + 1.1 + k * 1.25, h - 1.2, -d / 2 - 0.02], MAT.steel, 0.02);
    put(buildBox(1.4, 2.3, 0.05), [-2.8, 1.15, -d / 2 - 0.02], MAT.paint, 0.5);
    // THE MINARET: a tapering square shaft (the M'zab's obelisk), slits up
    // each face, a band, and four finger pinnacles at the corners.
    // 19 m (25 scaled): at 15 the two-storey houses up the knoll reached its
    // shoulders, and it has to own the skyline as in the photo.
    const MH = 19, WB = 3.8, WT = 2.1, mx = w / 2 - 1.4, mz = -d / 2 + 1.4;
    const m = groundSpanRot(groundAt, cx + mx, cz + mz, 0, WB / 2, WB / 2);
    const my = m.top - top, mdrop = m.top - m.low + 0.3;
    put(buildBox(WB + 0.1, mdrop, WB + 0.1), [mx, my - mdrop / 2 + 0.05, mz], MAT.plaster, 0.5);
    put(taperBox(WB, WT, MH), [mx, my + MH / 2, mz], MAT.plaster, 0.55);
    const alpha = Math.atan((WB - WT) / 2 / MH);
    for (const yy of [4.5, 7.8, 11.1, 14.4, 17]) {
      const hw = (WB + ((WT - WB) * yy) / MH) / 2 + 0.02;
      put(buildBox(0.28, 0.7, 0.06), [mx, my + yy, mz - hw], MAT.steel, 0.02, [alpha, 0, 0]);
      // Side faces: thin in X, leaned about Z to the taper (Euler XYZ: a Z
      // turn of a Z-thin slab would only spin it in its own plane).
      put(buildBox(0.06, 0.7, 0.28), [mx - hw, my + yy, mz], MAT.steel, 0.02, [0, 0, -alpha]);
      put(buildBox(0.06, 0.7, 0.28), [mx + hw, my + yy, mz], MAT.steel, 0.02, [0, 0, alpha]);
    }
    put(buildBox(WT + 0.3, 0.3, WT + 0.3), [mx, my + MH + 0.15, mz], MAT.plaster, 0.5);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      put(taperBox(0.4, 0.12, 1.6), [mx + sx * (WT / 2 - 0.05), my + MH + 0.3 + 0.8, mz + sz * (WT / 2 - 0.05)], MAT.plaster, 0.55);
    }
    houses.push({ x: cx, z: cz, mosque: true });
  }

  // ── THE OUTLINE: not a circle (you, 2026-09-29: a perfect circle of rings
  // read wrong). A M'zab ksar follows its rock: here it spills down toward
  // the souk (-Z) and wobbles with three low harmonics. ─────────────────────
  const h1 = R() * 6.28, h2 = R() * 6.28, h3 = R() * 6.28;
  const edge = (phi) => {
    // WIDE along the hillside (29 m either side), short behind the mosque
    // (15 m), deep down toward the souk (26 m), with lobes: a town spread
    // across its slope, the photo's panorama. A teardrop pointing at the
    // camera, walled all round, still read as a round fort from above.
    const s = Math.sin(phi), c = Math.cos(phi), b = c > 0 ? 15 : 26;
    const ell = 1 / Math.sqrt((s / 29) ** 2 + (c / b) ** 2);
    const e = ell + 3.4 * Math.sin(3 * phi + h2) + 1.6 * Math.sin(5 * phi + h3) + 1.0 * Math.sin(2 * phi + h1);
    // Down to the souk's back wall whatever the wobble does there.
    return Math.max(11, Math.abs(Math.atan2(Math.sin(phi - Math.PI), Math.cos(phi - Math.PI))) < 0.7 ? Math.max(e, 23) : e);
  };
  const inTown = (x, z, m = 0) => Math.hypot(x, z) < edge(Math.atan2(x, z)) - m;
  const inSouk = (x, z) => z < -19.5 && Math.abs(x) < 18.5;
  const inMosque = (x, z) => Math.abs(x) < 7.4 && z > -6.4 && z < 7;

  // ── THE ALLEYS: narrow and winding, from the mosque out — the stair down to
  // the souk, two more out through gates in the wall. Points 1 m apart. ─────
  const alleys = [];
  const alley = (a, b, sway, ph) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    const dx = (b[0] - a[0]) / n, dz = (b[1] - a[1]) / n, L = Math.hypot(dx, dz);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const s = Math.sin(i * 0.34 + ph) * sway * Math.sin((Math.PI * i) / n);   // ends on the line
      pts.push([a[0] + dx * i - (dz / L) * s, a[1] + dz * i + (dx / L) * s]);
    }
    alleys.push(pts);
    return pts;
  };
  const stair = alley([0, -21.5], [-2.6, -6.6], 1.2, R() * 6);
  const gates = [];   // where the two alleys leave the town
  for (const phi of [Math.PI * (0.3 + R() * 0.1), -Math.PI * (0.42 + R() * 0.1)]) {
    const e = edge(phi) + 1.3;
    alley([Math.sin(phi) * 8.5, Math.cos(phi) * 8.5], [Math.sin(phi) * e, Math.cos(phi) * e], 1.5, R() * 6);
    gates.push([Math.sin(phi) * e, Math.cos(phi) * e]);
  }
  const alleyDist = (x, z) => { let b = Infinity; for (const A of alleys) for (const [px, pz] of A) b = Math.min(b, (px - x) ** 2 + (pz - z) ** 2); return Math.sqrt(b); };

  // ── THE HOUSES: packed at random into the outline, wall to wall, each
  // facing down the slope (a slow swirl, so neighbours are near-parallel but
  // no two rows line up); taller toward the mosque. ────────────────────────
  const placed = [];
  const probe = (x, z, yaw, w, d) => {
    const c = Math.cos(yaw), s = Math.sin(yaw), out = [[x, z]];
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const lx = (a * w) / 2, lz = (b * d) / 2;
      out.push([x + lx * c + lz * s, z - lx * s + lz * c]);
    }
    return out;
  };
  // Two houses may run into each other by up to 0.5 m a side (attached
  // houses share their walls): an oriented-rectangle test on shrunk rects.
  // As circles round each house the town jammed at ~20 houses.
  const clash = (a, b) => {
    const ax = [[Math.cos(a.yaw), -Math.sin(a.yaw)], [Math.sin(a.yaw), Math.cos(a.yaw)]];
    const bx = [[Math.cos(b.yaw), -Math.sin(b.yaw)], [Math.sin(b.yaw), Math.cos(b.yaw)]];
    const ha = [a.w / 2 - 0.5, a.d / 2 - 0.5], hb = [b.w / 2 - 0.5, b.d / 2 - 0.5];
    const dx = b.x - a.x, dz = b.z - a.z;
    for (const n of [...ax, ...bx]) {
      const ra = ha[0] * Math.abs(ax[0][0] * n[0] + ax[0][1] * n[1]) + ha[1] * Math.abs(ax[1][0] * n[0] + ax[1][1] * n[1]);
      const rb = hb[0] * Math.abs(bx[0][0] * n[0] + bx[0][1] * n[1]) + hb[1] * Math.abs(bx[1][0] * n[0] + bx[1][1] * n[1]);
      if (Math.abs(dx * n[0] + dz * n[1]) > ra + rb) return false;
    }
    return true;
  };
  // Candidates drawn INSIDE the outline (drawn in a disc, 60% fell outside
  // and the loop gave up at ~20 houses); stop after 3000 misses in a row.
  // A second pass of small cubes fills the gaps the big ones left.
  for (let pass = 0, fails = 0; pass < 2; pass++, fails = 0) for (; fails < 3000;) {
    const ph = R() * Math.PI * 2, rr = Math.sqrt(R()) * (edge(ph) - 2);
    const x = rr * Math.sin(ph), z = rr * Math.cos(ph);
    const w = pass ? 2.8 + R() * 1.2 : 3.4 + R() * 3, d = pass ? 3.1 + R() * 0.9 : 3.8 + R() * 1.4;
    const yaw = Math.atan2(x, z) + Math.PI + 0.3 * Math.sin(x * 0.13 + z * 0.09 + h1) + (R() - 0.5) * 0.1;
    const pts = probe(x, z, yaw, w, d);
    const cand = { x, z, yaw, w, d };
    const ok = pts.every(([px, pz]) => inTown(px, pz, 0.4) && !inSouk(px, pz) && !inMosque(px, pz) && alleyDist(px, pz) > 1.15)
      && !placed.some((q) => clash(q, cand));
    if (!ok) { fails++; continue; }
    fails = 0;
    placed.push(cand);
  }
  for (const p of placed) {
    const { x, z, yaw, w, d } = p;
    const { top, low } = groundSpanRot(groundAt, x, z, yaw, w / 2, d / 2);
    const fg = groundAt(x - Math.sin(yaw) * (d / 2 + 0.8), z - Math.cos(yaw) * (d / 2 + 0.8));
    const rn = Math.hypot(x, z) / edge(Math.atan2(x, z));
    const h = (R() < 0.8 - 0.5 * rn ? 6.1 : 3.2) + R() * 0.7;
    const mat = matPick();
    const n0 = parts.length;
    ksarHouse(parts, R, { x, z, yaw, w, d, h, y: top, low: Math.min(low, fg), frontGround: fg, mat, tone: toneOf(mat) });
    p.range = [n0, parts.length];
    houses.push({ x, z });
  }
  // ATTACHED HOUSES OVERLAP by up to a metre, so a flat face of one (roof,
  // parapet top, roof room, spout) can land on a neighbour's at the same
  // height and z-fight. Compare every overlapping pair's horizontal faces;
  // where two are within 6 mm, lift the second house 2.3 cm. Repeat.
  const levels = (p) => {
    const out = [];
    for (let i = p.range[0]; i < p.range[1]; i++) {
      const q = parts[i];
      if (!q.pos || (q.rot && (Math.abs(q.rot[0]) > 1e-3 || Math.abs(q.rot[2]) > 1e-3))) continue;
      if (!q.geo.boundingBox) q.geo.computeBoundingBox();
      out.push(q.pos[1] + q.geo.boundingBox.max.y, q.pos[1] + q.geo.boundingBox.min.y);
    }
    return out;
  };
  const near = (a, b) => clash({ ...a, w: a.w + 2, d: a.d + 2 }, { ...b, w: b.w + 2, d: b.d + 2 });
  for (let pass = 0; pass < 6; pass++) {
    let moved = 0;
    for (let j = 0; j < placed.length; j++) {
      const B = placed[j], lb = levels(B);
      for (let i = 0; i < j; i++) {
        const A = placed[i];
        if (!near(A, B)) continue;
        const la = levels(A);
        if (la.some((ya) => lb.some((yb) => Math.abs(ya - yb) < 0.006))) {
          for (let k = B.range[0]; k < B.range[1]; k++) if (parts[k].pos) parts[k].pos = [parts[k].pos[0], parts[k].pos[1] + 0.023, parts[k].pos[2]];
          moved++;
          break;
        }
      }
    }
    if (!moved) break;
  }

  // NO RING WALL: the outer houses' backs are the town's edge (a wall all
  // round made it a round fort from above, 2026-09-29).

  // ── The stair from the souk up to the mosque, along its alley ─────────────
  for (let i = 0; i < stair.length; i++) {
    const [x, z] = stair[i], g = groundAt(x, z);
    const nx = stair[Math.min(i + 1, stair.length - 1)], px = stair[Math.max(i - 1, 0)];
    const yaw = Math.atan2(nx[0] - px[0], nx[1] - px[1]);
    // Every other slab 3 cm higher and wider: on level ground their tops met.
    parts.push({ geo: buildBox(2.0 + (i % 2) * 0.05, 0.8, 1.1), pos: [x, g - 0.2 + (i % 2) * 0.03, z], rot: [0, yaw, 0], mat: MAT.limestone, tone: 0.45 + R() * 0.12 });
  }

  // ── THE PALM GROVE: outside the wall, below the town (the palmeraie), never
  // in the souk or on its steps — palms stood in the square, their crowns
  // over the arcades' roofs (you, 2026-09-29). A crown is ~4 m across.
  for (let k = 0; k < 600 && trees.length < 16; k++) {
    const phi = Math.PI * (0.5 + R()), rr = edge(phi) + 6 + R() * 14;
    const x = Math.sin(phi) * rr, z = Math.cos(phi) * rr;
    if (Math.abs(x) < 21.5 && z > -49) continue;                             // the souk and its steps
    if (Math.abs(x) < 5 && z < -38) continue;                                // the way up to the steps
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 4.5)) continue;
    trees.push({ kind: "datePalm", x, z, scale: 0.8 + R() * 0.3, seed: Math.floor(R() * 1000) });
  }

  let E = 0;
  for (let k = 0; k < 72; k++) E = Math.max(E, edge((k / 72) * Math.PI * 2) + 2.2);
  const zMin = -46;
  const geo = finish(parts, { hx: E, hz: (E - zMin) / 2, cz: (E + zMin) / 2, height: 26, ao: { cell: 0.3 } });
  geo.userData.houses = houses.map((h) => ({ x: h.x * KIT, z: h.z * KIT, mosque: !!h.mosque }));
  geo.userData.trees = scaled(trees);
  // The town is one mass (alleys too narrow to hold a line in), blocked as
  // 6 m strips across its outline; the souk's square and steps are open
  // ground: men gather there.
  const K = (r) => ({ cx: r.cx * KIT, cz: r.cz * KIT, hx: r.hx * KIT, hz: r.hz * KIT });
  const nav = [];
  for (let zc = -18; zc < E; zc += 6) {
    let hx = 0, cx0 = Infinity, cx1 = -Infinity;
    for (let x = -E; x <= E; x += 1) if ([zc - 2.5, zc, zc + 2.5].some((z) => inTown(x, z, -1.3))) { cx0 = Math.min(cx0, x); cx1 = Math.max(cx1, x); }
    if (cx1 > cx0) { hx = (cx1 - cx0) / 2; nav.push(K({ cx: (cx0 + cx1) / 2, cz: zc, hx, hz: 3 })); }
  }
  nav.push(K({ cx: 0, cz: -24.3, hx: 15.8, hz: 2.9 }), K({ cx: -13.4, cz: -33.2, hx: 2.5, hz: 6 }), K({ cx: 13.4, cz: -33.2, hx: 2.5, hz: 6 }));
  geo.userData.navRects = nav;
  return geo;
}
