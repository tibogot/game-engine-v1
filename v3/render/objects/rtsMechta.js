/**
 * THE MECHTA — the Aurès hamlet: Chaouia houses of dry-laid limestone rubble
 * under flat roofs of beaten earth, the roof beams' ends sticking out under
 * the eaves, a low timber door, a couple of small openings, some houses a
 * storey higher, the doorways limewashed. Houses lean on each other and on
 * courtyard walls; a domed bread oven (tabouna) in a yard (the threshing floor is
 * its own piece beside the hamlet). The civilians' world in the Algeria game.
 *
 * A hamlet is an ARRANGEMENT round a lane, not one house stamped N times
 * (nam-rts's hamlet lesson): every house its own size, height and door side.
 *
 * Kit contract (rtsParts.js): one merged geometry on the atlas material,
 * origin at the ground centre on y = 0, `userData.footprint` for the pad and
 * nav, `userData.houses` for the pieces a game might want (doors, yards),
 * `userData.navRects` (each house and yard wall: the lane, the gaps and the
 * threshing floor are open ground, 2026-10-06) and `coverLines` (along them).
 * Real metres, scaled by 1.3 at the end.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, rng } from "./rtsParts.js";
import { flatSurface, stencilPatch, stencilsOf } from "./rtsStencils.js";

const S = 1.3;

/**
 * DETAIL 2 (the buildings lab, 2026-10-07, from photos of Ghoufi and the Aurès villages): a dry
 * stone WALL is never a box — it leans in as it rises (the batter), its faces and edges wander,
 * its top is uneven. A box cut into a grid, every vertex pushed by a smooth noise of its OWN
 * position (shared corners move together: no cracks), the top drawn in. UVs in metres / 2 per
 * face, as buildBox's.
 */
const wob = (x, y, z, k) => Math.sin(x * 1.7 + z * 0.9 + k) * 0.6 + Math.sin(y * 2.3 + x * 0.7 - z * 1.3 + k * 2) * 0.4;
function stoneMass(w, h, d, { batter = 0.07, amp = 0.05, topAmp = 0.1, seed = 0 } = {}) {
  const sx = Math.max(2, Math.round(w / 0.8)), sy = Math.max(2, Math.round(h / 0.7)), sz = Math.max(2, Math.round(d / 0.8));
  const g = new THREE.BoxGeometry(w, h, d, sx, sy, sz);
  const uv = g.attributes.uv, span = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const done = new Set();
  for (const grp of g.groups) {
    const [a, b] = span[grp.materialIndex];
    for (let k = grp.start; k < grp.start + grp.count; k++) {
      const vi = g.index.getX(k);
      if (done.has(vi)) continue;
      done.add(vi);
      uv.setXY(vi, (uv.getX(vi) * a) / 2, (uv.getY(vi) * b) / 2);
    }
  }
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = (y + h / 2) / h;                          // 0 at the foot, 1 at the top
    const inset = 1 - batter * f;
    const n = wob(x, y, z, seed), m = wob(z, y, x, seed + 3);
    const top = y > h / 2 - 1e-4 ? wob(x * 0.8, 0, z * 0.8, seed + 7) * topAmp : 0;
    p.setXYZ(i, x * inset + n * amp * f, y + top, z * inset + m * amp * f);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * One house, centred at (x, z), turned by `yaw`, pushing into `parts`.
 * Returns its door point (world, pre-scale) and its outline for yards.
 */
/**
 * WEATHER (the buildings pass, 2026-10-08 — CoH audit 2: "clean boxes"): what years of sun, rain
 * and dust leave on a house, as paint on its walls (rtsStencils: one sheet, alpha-tested, one
 * draw per village). DUST thrown up the foot of every wall; GRIME washed down from the roof's
 * edge in streaks; on a limewashed front, the PLASTER FALLEN off in patches, the stones behind.
 * Carried among the parts (stencilsOf), so a house seated on a slope takes its paint with it.
 * `front`: the door face (+1 / -1 in z), its skin `skinOut` m proud; `skin`: "white" | "earth" | null.
 */
function weather(parts, R, { x, z, yaw, w, d, h, front, skin, skinTop, dx }) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const V = (v) => [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
  const P = (lx, ly, lz) => [x + lx * c + lz * s, ly, z - lx * s + lz * c];
  let k = 0;   // a hair more lift each patch: two never share a plane
  const stamp = (cell, at, n, r, width, lift) => {
    parts.push({ stencil: stencilPatch(cell, flatSurface(at, V(n), V(r), width, cell), { lift: lift + (k++ % 9) * 0.0003 }), pos: [0, 0, 0] });
  };
  // The four faces in the house's frame: normal, right (cross(n, r) = up), length, offset out.
  // The door face stands proud of its skin (4 cm) and the door's surround (6.5 cm).
  const faces = [
    { n: [0, 0, 1], r: [1, 0, 0], len: w, off: d / 2 + (front > 0 ? 0.08 : 0.02), front: front > 0, at: (t, o) => [t, o] },
    { n: [0, 0, -1], r: [-1, 0, 0], len: w, off: d / 2 + (front < 0 ? 0.08 : 0.02), front: front < 0, at: (t, o) => [-t, -o] },
    { n: [1, 0, 0], r: [0, 0, -1], len: d, off: w / 2 + 0.02, front: false, at: (t, o) => [o, -t] },
    { n: [-1, 0, 0], r: [0, 0, 1], len: d, off: w / 2 + 0.02, front: false, at: (t, o) => [-o, t] },
  ];
  for (const f of faces) {
    const at = (t, y) => { const [lx, lz] = f.at(t, f.off); return P(lx, y, lz); };
    // DUST up the foot: bands ≤ 4.4 m, as tall as a fifth of their width.
    const nb = Math.max(1, Math.ceil(f.len / 4.4)), bw = f.len / nb;
    // (On the limewash the whitewash's own cells; on stone and mud plaster, the stone's.)
    const white = f.front && skin === "white";
    for (let i = 0; i < nb; i++) stamp(white ? "wallFootDust" : "stoneFootDust", at(-f.len / 2 + bw * (i + 0.5), bw / 10 - 0.04), f.n, f.r, bw + 0.02, 0.003);
    // GRIME from the roof's edge (the long walls carry the beam ends: just under them).
    if (f.len > 3) {
      const ns = 1 + Math.floor(R() * (f.len > 5 ? 3 : 2));
      for (let i = 0; i < ns; i++) {
        const t = (R() - 0.5) * (f.len - 1.2);
        // A door face's door is kept clear (its door is at the house's dx).
        if (f.front && Math.abs((f.n[2] > 0 ? t : -t) - dx) < 1.2) continue;
        const sw = 0.5 + R() * 0.35, sh = sw / 0.4;
        // The streak starts under the roof: on stone unless the limewash reaches up there.
        const onWhite = white && h - 0.2 - sh * 0.3 < skinTop;
        stamp(onWhite ? (R() < 0.5 ? "rainStreakA" : "rainStreakB") : "stoneStreak", at(t, h - 0.2 - sh / 2), f.n, f.r, sw, 0.005);
      }
    }
    // PLASTER FALLEN off the limewashed front, the stones behind (1-2 patches, clear of the door).
    if (f.front && skin === "white") {
      const np = 1 + (R() < 0.5 ? 1 : 0);
      for (let i = 0; i < np; i++) {
        const t = (R() - 0.5) * (w - 1.4);
        if (Math.abs((f.n[2] > 0 ? t : -t) - dx) < 1.3) continue;
        const pw = 0.8 + R() * 0.6, ph = pw / 1.6;
        stamp(R() < 0.5 ? "plasterFallA" : "plasterFallB", at(t, Math.min(skinTop - ph / 2 - 0.1, 0.5 + R() * (skinTop - 0.9))), f.n, f.r, pw, 0.007);
      }
    }
  }
}

/**
 * ROOF LIFE (the buildings pass, 2026-10-08 — from the RTS camera a village is its ROOFS, and
 * they were bare earth slabs): what a Chaouia family keeps up there, a few of each house's own
 * (its own random stream). Firewood and brush for the oven; a washing line; a rug over the
 * parapet; jars; grain drying on a mat; the hatch down into the house with its
 * ladder; patches of new mud on the old; a ladder up the front. On the roof clear of the upper
 * storey. In the house's frame (`put`), the roof's top at h + 0.26. Merged with the house: 0 draws.
 */
export function roofLife(put, R, { w, d, h, upper, front, dx, top = h + 0.26, rug = true, laundry = true, frontLadder = true, patch = MAT.earth, patchTone = null }) {
  // (`top`, `rug`, `laundry`, `frontLadder`: the ksar's houses — their own roof height, their own
  // laundry, parapets a rug and a lane ladder do not fit.)
  // The free roof: the whole of it, or the part beside the upper storey.
  let x0 = -w / 2 + 0.55, x1 = w / 2 - 0.55;
  if (upper) { if (upper.ox > 0) x1 = upper.ox - upper.w2 / 2 - 0.35; else x0 = upper.ox + upper.w2 / 2 + 0.35; }
  if (x1 - x0 < 1.2) return;
  const z0 = -d / 2 + 0.55, z1 = d / 2 - 0.55;
  const spot = () => [x0 + R() * (x1 - x0), z0 + R() * (z1 - z0)];
  const used = [];
  const free = (x, z, r) => used.every(([ux, uz, ur]) => Math.hypot(ux - x, uz - z) > ur + r) && (used.push([x, z, r]), true);
  const tries = (r, fn) => { for (let k = 0; k < 6; k++) { const [x, z] = spot(); if (free(x, z, r)) return fn(x, z); } };
  // Mud repairs: a slab of newer earth on the old, a few cm proud (never coplanar).
  for (let k = 0, n = Math.floor(R() * 3); k < n; k++) {
    // Kept on its own roof whole (a patch past the edge lay over the next house's, coplanar).
    const pw = Math.min(0.9 + R() * 1.4, x1 - x0), pd = Math.min(0.7 + R() * 1.1, z1 - z0);
    const x = x0 + pw / 2 + R() * Math.max(0, x1 - x0 - pw), z = z0 + pd / 2 + R() * Math.max(0, z1 - z0 - pd);
    // Sunk into the roof (a base a hair above it counted as coplanar). Every flat item's base and
    // top its own height, ≥ 4 mm apart (bases -10/-18/-26 mud, -14 grain, -22 hatch; tops +35/+47/
    // +59 mud, +28 grain, +42 hatch) — two items may overlap on a roof.
    const th = 0.045 + k * 0.012;
    put(buildBox(pw, th + k * 0.008, pd), [x, top - 0.01 - k * 0.008 + (th + k * 0.008) / 2, z], patch, patchTone != null ? patchTone + (R() - 0.5) * 0.12 : 0.62 + R() * 0.2, [0, (R() - 0.5) * 0.3, 0]);
  }
  // Firewood: a loose pile of branches, every one its own way (aligned boxes read as a crate).
  if (R() < 0.55) tries(0.8, (x, z) => {
    const a = R() * 3;
    for (let k = 0; k < 11; k++) {
      const br = new THREE.CylinderGeometry(0.035 + R() * 0.03, 0.05 + R() * 0.03, 1.1 + R() * 0.7, 5);
      put(br, [x + (R() - 0.5) * 0.5, top + 0.05 + R() * 0.2, z + (R() - 0.5) * 0.45], MAT.timber, 0.2 + R() * 0.3, [Math.PI / 2 + (R() - 0.5) * 0.35, a + (R() - 0.5) * 1.4, 0]);
    }
  });
  // Brush for the oven: a loose heap.
  // (A low dome: the straw cell on a box read as a crate.)
  if (R() < 0.45) tries(0.7, (x, z) => {
    const heap = new THREE.SphereGeometry(0.5, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    heap.scale(1.2 + R() * 0.5, 0.55 + R() * 0.2, 0.9 + R() * 0.3);
    put(heap, [x, top - 0.02, z], MAT.thatch, 0.25 + R() * 0.2, [0, R() * 3, 0]);
  });
  // Grain drying on a mat: a straw-coloured patch (red peppers in the clay cell read as tiles).
  if (R() < 0.4) tries(0.8, (x, z) => {
    put(buildBox(1.3 + R() * 0.5, 0.042, 0.9 + R() * 0.4), [x, top - 0.014 + 0.021, z], MAT.thatch, 0.75 + R() * 0.15, [0, R() * 3, 0]);
  });
  // Jars: two or three together.
  if (R() < 0.45) tries(0.6, (x, z) => {
    for (let k = 0, n = 2 + Math.floor(R() * 2); k < n; k++) {
      const jar = new THREE.SphereGeometry(0.2 + R() * 0.06, 9, 6);
      jar.scale(1, 1.3, 1);
      put(jar, [x + (k - 1) * 0.42, top + 0.24, z + (R() - 0.5) * 0.3], MAT.laterite, 0.45 + R() * 0.2);
    }
  });
  // The hatch down into the house, its ladder's top standing out of it.
  if (R() < 0.45) tries(0.6, (x, z) => {
    put(buildBox(0.75, 0.064, 0.75), [x, top - 0.022 + 0.032, z], MAT.steel, 0.03);
    const a = R() * 3;
    for (const sx of [-0.2, 0.2]) put(buildBox(0.07, 1.1, 0.07), [x + Math.cos(a) * sx, top + 0.45, z - Math.sin(a) * sx], MAT.timber, 0.3, [0.25, a, 0]);
  });
  // A washing line on two poles, cloths over it (white, the canvas's beige, a red rug).
  if (R() < 0.35 && laundry) tries(1.2, (x, z) => {
    const len = Math.min(2.6, x1 - x0 - 0.2), a = (R() - 0.5) * 0.4;
    const ex = Math.cos(a) * len / 2, ez = -Math.sin(a) * len / 2;
    for (const sg of [-1, 1]) put(buildBox(0.06, 1.7, 0.06), [x + sg * ex, top + 0.85, z + sg * ez], MAT.timber, 0.3);
    put(buildBox(len, 0.02, 0.02), [x, top + 1.62, z], MAT.timber, 0.2, [0, a, 0]);
    const n = 2 + Math.floor(R() * 2);
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n - 0.5, cw = 0.45 + R() * 0.3, ch = 0.55 + R() * 0.35;
      const mat = [MAT.white, MAT.canvas, MAT.laterite, MAT.hessian][Math.floor(R() * 4)];
      put(buildBox(cw, ch, 0.025), [x + f * 2 * ex, top + 1.6 - ch / 2, z + f * 2 * ez], mat, 0.4 + R() * 0.4, [0, a, 0]);
    }
  });
  // A rug over the parapet on the lane side: the red of a Chaouia weave, hanging down the wall.
  if (R() < 0.3 && rug) {
    const rx = x0 + R() * Math.max(0, x1 - x0 - 1.4) + 0.7, rw = 1.0 + R() * 0.5;
    if (Math.abs(rx - dx) > 1.2) {
      const zf = front * (d / 2 + 0.2);
      put(buildBox(rw, 0.03, 0.42), [rx, h + 0.48, zf], MAT.laterite, 0.6 + R() * 0.3);                          // over the coping
      put(buildBox(rw - 0.04, 0.9, 0.03), [rx, h + 0.03, front * (d / 2 + 0.33)], MAT.laterite, 0.6 + R() * 0.3);     // down the wall (a hair narrower: no shared sides)
    }
  }
  // A ladder up the front, from the lane to the roof.
  if (R() < 0.25 && frontLadder) {
    const lx = dx + (R() < 0.5 ? -1 : 1) * (1.3 + R() * 0.4);
    if (Math.abs(lx) < w / 2 - 0.4) {
      const lz = front * (d / 2 + 0.55), tilt = -front * 0.22;
      for (const sx of [-0.22, 0.22]) put(buildBox(0.07, h + 0.7, 0.07), [lx + sx, (h + 0.7) / 2, lz], MAT.timber, 0.3, [tilt, 0, 0]);
      for (let k = 1; k < 7; k++) {
        const y = k * (h + 0.6) / 7;
        put(buildBox(0.5, 0.05, 0.05), [lx, y, lz + front * Math.sin(-tilt) * (y - (h + 0.7) / 2)], MAT.timber, 0.35);
      }
    }
  }
}

export function house(parts, R, { x, z, yaw, w, d, h, storey2 = false, doorFace = -1, leanTo = true, detail = 1, weathered = true }) {
  const D2 = detail >= 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // Local → world for a part authored in the house's frame.
  const put = (geo, lp, mat, tone, rot = [0, 0, 0]) => {
    const wx = x + lp[0] * c + lp[2] * s, wz = z - lp[0] * s + lp[2] * c;
    parts.push({ geo, pos: [wx, lp[1], wz], rot: [rot[0], rot[1] + yaw, rot[2]], mat, tone });
  };
  // Walls: one rubble block, the top a hair rough (the courses are not level).
  const wallTone = 0.62 + R() * 0.2;
  put(D2 ? stoneMass(w, h, d, { seed: x * 0.37 + z * 0.11 }) : buildBox(w, h, d), [0, h / 2, 0], MAT.rubble, wallTone);
  // The lane front: bare stone, mud-plastered, or limewashed — the plaster a
  // skin a few cm proud, ragged at the top where it has washed off.
  const fz0 = doorFace * (d / 2 + 0.02);
  const skin = R();
  let skinKind = null, skinTop = 0;
  if (skin < 0.7) {
    const mat = skin < 0.45 ? MAT.earth : MAT.white;
    const top = h * (0.6 + R() * 0.35);
    put(buildBox(w - 0.1, top, 0.04), [0, top / 2, fz0], mat, mat === MAT.earth ? 0.62 + R() * 0.15 : 0.35 + R() * 0.15);
    skinKind = mat === MAT.white ? "white" : "earth"; skinTop = top;
  }
  // The roof: beaten earth over brush over beams, a low parapet of stone at the
  // edge, a little proud all round; a spout on one side.
  put(buildBox(w + 0.3, 0.26, d + 0.3), [0, h + 0.13, 0], MAT.earth, 0.45 + R() * 0.15);
  // THE PARAPET, each house its own (the buildings pass, 2026-10-08: one ring on every roof read
  // as a grid of one box): its height, its tone, and on some a stretch fallen from one long side.
  // Its own stream (the village layout is unchanged).
  const RP = rng(Math.floor(x * 53 + z * 29 + w * 11) >>> 0);
  const ph = 0.16 + RP() * 0.22, pTone = 0.32 + RP() * 0.16;
  const gapSide = RP() < 0.35 ? (RP() < 0.5 ? 1 : -1) : 0;
  for (const sz of [1, -1]) {
    const pz = sz * (d / 2 + 0.05);
    if (sz !== gapSide) { put(buildBox(w + 0.32, ph, 0.22), [0, h + 0.26 + ph / 2, pz], MAT.rubble, pTone); continue; }
    // A gap 0.8-1.8 m, somewhere along it, its two ends left ragged (a little lower).
    const gw = 0.8 + RP() * 1.0, gc = (RP() - 0.5) * (w - gw - 1.4);
    const a0 = -(w + 0.32) / 2, a1 = gc - gw / 2, b0 = gc + gw / 2, b1 = (w + 0.32) / 2;
    put(buildBox(a1 - a0, ph, 0.22), [(a0 + a1) / 2, h + 0.26 + ph / 2, pz], MAT.rubble, pTone);
    put(buildBox(b1 - b0, ph - 0.04, 0.22), [(b0 + b1) / 2, h + 0.26 + (ph - 0.04) / 2, pz], MAT.rubble, pTone);
  }
  // The end pieces 3 cm shorter (centred on the long ones: neither top nor base shared) and
  // 3 cm inside the long ones' ends: flush corners z-fought on every roof.
  put(buildBox(0.22, ph - 0.03, d + 0.1), [w / 2 + 0.02, h + 0.26 + ph / 2, 0], MAT.rubble, pTone);
  put(buildBox(0.22, ph - 0.03, d + 0.1), [-w / 2 - 0.02, h + 0.26 + ph / 2, 0], MAT.rubble, pTone);
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
  let lean = null;
  if (leanTo && R() < 0.45) {   // none in an attached row (a dechra): it hit the neighbour
    const lw = 2.2 + R(), ex = (R() < 0.5 ? -1 : 1) * (w / 2 + lw / 2);
    lean = { ex, lw };
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
  if (D2) {
    // The doorway's LINTEL: two rough beams over the door, their ends in the wall, proud of it;
    // the jambs' posts either side. What makes it a door in stone, not a sticker.
    for (const k of [0, 1]) put(buildBox(1.7, 0.12, 0.16), [dx, 2.02 + k * 0.13, fz + doorFace * (0.07 - k * 0.02)], MAT.timber, 0.2 + k * 0.08, [0, 0, (k - 0.5) * 0.03]);
    for (const sx of [-1, 1]) put(buildBox(0.12, 1.85, 0.1), [dx + sx * 0.52, 0.93, fz + doorFace * 0.05], MAT.timber, 0.22);
  }
  // Small openings high up: dark slots, one on each other face, some missing.
  for (const [ox, oz, ry] of [[w / 2 + 0.01, 0, Math.PI / 2], [-w / 2 - 0.01, 0, Math.PI / 2], [0, -fz, 0]]) {
    if (R() < 0.3) continue;
    const px = ox === 0 ? (R() - 0.5) * w * 0.5 : ox, pz = oz === 0 && ox !== 0 ? (R() - 0.5) * d * 0.4 : oz;
    put(buildBox(0.4, 0.34, 0.04), [px, h - 0.8, pz], MAT.steel, 0.02, [0, ry, 0]);
    // Its lintel: a short beam over it, proud of the wall (detail 2).
    if (D2) {
      const out = ox === 0 ? [0, 0, Math.sign(pz) * 0.06] : [Math.sign(ox) * 0.06, 0, 0];
      put(buildBox(0.7, 0.09, 0.14), [px + out[0], h - 0.58, pz + out[2]], MAT.timber, 0.22, [0, ry, 0]);
    }
  }
  // A second storey, set back on part of the roof, with its own beams and roof.
  let upper = null;   // { ox, w2 } — the roof clutter keeps off it
  if (storey2 && D2) {
    // The LOGGIA (Ghoufi, the photos): an upper room open to the front — stone back and ends,
    // the front on wooden posts under a beam, the room's dark inside behind them; its roof.
    const w2 = w * 0.62, d2 = d * 0.85, h2 = 2.2, ox = (w - w2) / 2 * (R() < 0.5 ? -1 : 1), y0 = h + 0.26;
    upper = { ox, w2 };
    const fd = doorFace * (d2 / 2);
    put(stoneMass(w2, h2, 0.45, { batter: 0.04, amp: 0.03, topAmp: 0.04, seed: x + 5 }), [ox, y0 + h2 / 2, -fd + doorFace * 0.22], MAT.rubble, wallTone);
    for (const ex of [-1, 1]) put(stoneMass(0.45, h2, d2, { batter: 0.04, amp: 0.03, topAmp: 0.04, seed: x + ex }), [ox + ex * (w2 / 2 - 0.22), y0 + h2 / 2, 0], MAT.rubble, wallTone);
    put(buildBox(w2 - 0.9, h2 - 0.1, 0.05), [ox, y0 + h2 / 2, -fd + doorFace * 0.47], MAT.steel, 0.03);              // the dark room
    put(buildBox(w2 - 0.9, 0.06, d2 - 0.5), [ox, y0 + 0.03, doorFace * 0.2], MAT.earth, 0.35);                        // its floor
    const np = Math.max(2, Math.round((w2 - 0.9) / 1.2));
    for (let k = 1; k < np; k++) put(buildBox(0.16, h2 - 0.2, 0.16), [ox - (w2 - 0.9) / 2 + (k * (w2 - 0.9)) / np, y0 + (h2 - 0.2) / 2, fd - doorFace * 0.12], MAT.timber, 0.2 + R() * 0.1);
    put(buildBox(w2 - 0.4, 0.18, 0.2), [ox, y0 + h2 - 0.1, fd - doorFace * 0.12], MAT.timber, 0.18);                   // the beam
    put(buildBox(w2 + 0.3, 0.24, d2 + 0.3), [ox, y0 + h2 + 0.12, 0], MAT.earth, 0.5);
    for (let k = 0; k < 4; k++) put(buildBox(0.14, 0.14, 0.34), [ox - w2 / 2 + 0.3 + k * (w2 - 0.6) / 3, y0 + h2 - 0.04, -fd - doorFace * 0.14], MAT.timber, 0.2);
  } else if (storey2) {
    const w2 = w * 0.55, d2 = d * 0.9, h2 = 2.3, ox = (w - w2) / 2 * (R() < 0.5 ? -1 : 1);
    upper = { ox, w2 };
    put(buildBox(w2, h2, d2), [ox, h + 0.26 + h2 / 2, 0], MAT.rubble, 0.64 + R() * 0.15);
    put(buildBox(w2 + 0.3, 0.24, d2 + 0.3), [ox, h + 0.26 + h2 + 0.12, 0], MAT.earth, 0.5);
    for (let k = 0; k < 3; k++) put(buildBox(0.14, 0.14, 0.34), [ox - w2 / 2 + 0.35 + k * (w2 - 0.7) / 2, h + 0.26 + h2 - 0.12, doorFace * (d2 / 2 + 0.14)], MAT.timber, 0.2);
    put(buildBox(0.8, 1.5, 0.04), [ox, h + 0.26 + 0.75, doorFace * (d2 / 2 + 0.01)], MAT.timber, 0.15);
  }
  // What lies about: a heap of brush for the oven on the roof, pots by the door.
  // (The village's own stream keeps the draws the old brush heap took — 5 when it was there —
  // so no house after this one moves: the cover, nav and garrison spots were measured on them.)
  if (R() < 0.6) { for (let k = 0; k < 5; k++) R(); }
  roofLife(put, rng(Math.floor(x * 97 + z * 31 + h * 13) >>> 0), { w, d, h, upper, front: doorFace, dx });
  if (R() < 0.7) {
    const jar = new THREE.SphereGeometry(0.28, 10, 7);
    jar.scale(1, 1.25, 1);
    put(jar, [dx + 1.0, 0.33, fz + doorFace * 0.4], MAT.laterite, 0.55);
  }
  // Its own random stream: the weather never shifts the rest of the village's draws.
  if (weathered) weather(parts, rng(Math.floor(x * 131 + z * 17 + w * 7) >>> 0), { x, z, yaw, w, d, h, front: doorFace, skin: skinKind, skinTop, dx });
  const doorW = [x + (dx) * c + (fz + doorFace * 1.2) * s, z - dx * s + (fz + doorFace * 1.2) * c];
  return { door: doorW, x, z, yaw, w, d, lean };
}

/**
 * What a house blocks and shelters, in its piece's frame (pre-scale): its walls' box turned
 * by its yaw, as an axis-aligned rect (`m` metres proud — a man stands against the wall, not
 * in it: a 2 m nav cell is blocked only when its CENTRE is inside, so a man in the next one
 * can stand ~1.4 m from that centre; 0.9 (1.2 m scaled) keeps him out of the wall — measured),
 * and its lean-to's; `outline` the wall line for the cover map.
 */
/**
 * ONE house on its own (the buildings lab): the hamlet's house with a loggia, at the origin,
 * door to +Z, scaled like the hamlet. `detail` 1 = the game's house, 2 = the lab's.
 */
export function buildMechtaHouse({ seed = 7, detail = 1 } = {}) {
  const R = rng(seed), parts = [];
  house(parts, R, { x: 0, z: 0, yaw: 0, w: 6.4, d: 4.8, h: 2.9, storey2: true, doorFace: 1, leanTo: true, detail });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.25, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5 });
  geo.scale(S, S, S);
  geo.computeBoundingBox();
  geo.userData.stencil = stencilsOf(parts, S);
  return geo;
}

export function houseNav(h, m = 0.9) {
  const c = Math.abs(Math.cos(h.yaw)), s = Math.abs(Math.sin(h.yaw));
  const box = (x, z, w, d) => ({ cx: x, cz: z, hx: c * w / 2 + s * d / 2 + m, hz: s * w / 2 + c * d / 2 + m });
  const rects = [box(h.x, h.z, h.w + 0.3, h.d + 0.3)];
  if (h.lean) rects.push(box(h.x + h.lean.ex * Math.cos(h.yaw), h.z - h.lean.ex * Math.sin(h.yaw), h.lean.lw, h.d));
  const r = rects[0], o = { x0: r.cx - r.hx + m, x1: r.cx + r.hx - m, z0: r.cz - r.hz + m, z1: r.cz + r.hz - m };
  return { rects, outline: [[o.x0, o.z0], [o.x1, o.z0], [o.x1, o.z1], [o.x0, o.z1], [o.x0, o.z0]] };
}
/** A wall from a to b (pre-scale, along X or Z) as a nav rect `t` thick each side (≥ a 2 m nav cell). */
export const wallRect = (a, b, t = 1.2 / S) => ({ cx: (a[0] + b[0]) / 2, cz: (a[1] + b[1]) / 2, hx: Math.abs(b[0] - a[0]) / 2 + t, hz: Math.abs(b[1] - a[1]) / 2 + t });
const scaleRect = (r) => ({ ...r, cx: r.cx * S, cz: r.cz * S, hx: r.hx * S, hz: r.hz * S });

/** A dry-stone yard wall from a to b (world x/z), ~1.5 m, uneven. */
export function yardWall(parts, R, a, b, hgt = 1.5) {
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
export function oven(parts, R, x, z, yaw) {
  const dome = new THREE.SphereGeometry(0.75, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  parts.push({ geo: dome, pos: [x, 0, z], rot: [0, yaw, 0], mat: MAT.earth, tone: 0.62 });
  parts.push({ geo: buildBox(0.36, 0.32, 0.1), pos: [x + Math.sin(yaw) * 0.72, 0.2, z + Math.cos(yaw) * 0.72], rot: [0, yaw, 0], mat: MAT.steel, tone: 0 });
  parts.push({ geo: buildBox(0.7, 0.08, 0.5), pos: [x + Math.sin(yaw) * 1.05, 0.04, z + Math.cos(yaw) * 1.05], rot: [0, yaw, 0], mat: MAT.rubble, tone: 0.6 });
}

/**
 * A hamlet of `count` houses along a lane (the lane runs along +Z through the
 * origin, doors facing it), yards behind some, an oven.
 */
export function buildMechta({ seed = 1954, count = 10 } = {}) {
  const R = rng(seed);
  const parts = [];
  const houses = [];
  const yards = [];   // the yard walls' runs [a, b] (pre-scale)
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
      yards.push([[back, zc - w / 2], [far, zc - w / 2]], [[far, zc - w / 2], [far, zc + w / 2]], [[far, zc + w / 2], [back, zc + w / 2]]);
      if (R() < 0.5) oven(parts, R, (back + far) / 2, zc + (R() - 0.5) * 2, R() * 6);
    }
  }
  // (The threshing floor that stood at the lane's end is gone, 2026-10-07: a flat 28-sided disc
  // whose baked contact AO spread into a blurry dark smudge at play zoom — CoH audit 2 item 4.
  // Each alg-rts hamlet has the paved one beside it: rtsAlgVillage buildThreshingFloor.)

  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.35, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5 });
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.scale(S, S, S);
  geo.userData.stencil = stencilsOf(parts, S);   // the houses' weather (house())
  geo.computeBoundingBox();
  geo.userData.footprint = {
    cx: ((bb.min.x + bb.max.x) / 2) * S, cz: ((bb.min.z + bb.max.z) / 2) * S,
    hx: ((bb.max.x - bb.min.x) / 2) * S, hz: ((bb.max.z - bb.min.z) / 2) * S,
  };
  // (w / d / yaw: the walls' box, for a game's garrisons — alg-rts algGarrison.js)
  geo.userData.houses = houses.map((h) => ({ door: [h.door[0] * S, h.door[1] * S], x: h.x * S, z: h.z * S, w: h.w * S, d: h.d * S, yaw: h.yaw }));
  // WHAT BLOCKS (a player, 2026-10-06: "let me go inside the villages" — the whole hamlet was
  // one blocked block): each house and its lean-to, each yard wall; the lane, the gaps between
  // houses and the threshing floor are open. COVER along every house wall and yard wall.
  const navs = houses.map((h) => houseNav(h));
  geo.userData.navRects = [...navs.flatMap((n) => n.rects), ...yards.map(([a, b]) => wallRect(a, b))].map(scaleRect);
  geo.userData.coverLines = [...navs.map((n) => n.outline), ...yards].map((pts) => ({ hard: true, pts: pts.map(([x, z]) => [x * S, z * S]) }));
  geo.userData.coverPerimeter = false;
  geo.userData.height = 6 * S;
  return geo;
}
