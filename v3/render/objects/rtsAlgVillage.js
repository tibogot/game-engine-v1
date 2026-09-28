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
import { MAT, buildBox, rng, wirePart } from "./rtsParts.js";
import { house } from "./rtsMechta.js";
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
    dryStone(parts, RL, [[h.x - gap, zf - deep], [x0, zf - deep], [x0, zf]], { courses: 3, h: 1.05, depth: 0.45, len: 0.5, groundAt, tone: 0.48 });
    dryStone(parts, RL, [[h.x + gap, zf - deep], [x1, zf - deep], [x1, zf]], { courses: 3, h: 1.05, depth: 0.45, len: 0.5, groundAt, tone: 0.48 });
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
  dryStone(parts, R, [[gx - gate, -hz], [-hx, -hz], [-hx, hz], [hx, hz], [hx, -hz], [gx + gate, -hz]], { courses: 3, h: 1.1, depth: 0.55, len: 0.55, groundAt, tone: 0.5 });
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
  const z0 = -((rows - 1) * step) / 2;
  for (let r = 0; r < rows; r++) {
    // A wall a little bowed and a little shorter or longer each step, the
    // way hand-built terraces follow the hill.
    const z = z0 + r * step + (R() - 0.5) * 0.6, bow = (R() - 0.5) * 1.8;
    const a = -w / 2 + R() * 1.5, b = w / 2 - R() * 1.5;
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
  return geo;
}
