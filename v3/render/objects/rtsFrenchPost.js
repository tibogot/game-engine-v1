/**
 * THE FRENCH POST — the playable side's HQ in the Algeria game: a "poste" in
 * the bordj manner, the walled square every valley of the Aurès had one of by
 * 1957. Built to the period photographs (games/alg-rts/TODO.md, references).
 *
 * What makes it read from the RTS camera, in order: the WHITE SQUARE of the
 * walls against the ochre ground (nothing else on the map is white), the
 * crenellated parapet that draws its outline, the two corner towers on the
 * diagonal, and the tricolour. Up close: the dry-stone footing the whitewash
 * sits on, the loopholes, the sandbagged tower roofs with their guns, the
 * gatehouse with the post's name board, the barracks inside, the radio mast.
 *
 * Same contract as the rest of the kit (rtsParts.js): one merged geometry on
 * the atlas material, origin at the ground centre on y = 0, markings in
 * `userData.stencil`, `userData.footprint` for its pad and nav. Built in REAL
 * metres and scaled by 1.3 at the end, like everything man-made in the game.
 * The gate faces -Z.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, buildOilDrum, buildSandbagRing, buildSandbagWall, rng, wirePart } from "./rtsParts.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";

const S = 1.3;

/** Indexed (mergeGeometries needs every input indexed or none). */
function indexed(g) {
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  return g;
}

/**
 * A wall with arched openings down to its foot, as one outline, extruded `t`
 * along +Z. Shape in XY, x centred, y up from 0; UVs in metres / 2.
 */
function archWall(width, height, t, openings) {
  const sh = new THREE.Shape();
  sh.moveTo(-width / 2, 0);
  for (const o of [...openings].sort((a, b) => a.cx - b.cx)) {
    const hw = o.w / 2;
    sh.lineTo(o.cx - hw, 0);
    sh.lineTo(o.cx - hw, o.spring);
    sh.absarc(o.cx, o.spring, hw, Math.PI, 0, true);
    sh.lineTo(o.cx + hw, 0);
  }
  sh.lineTo(width / 2, 0);
  sh.lineTo(width / 2, height);
  sh.lineTo(-width / 2, height);
  sh.lineTo(-width / 2, 0);
  const g = indexed(new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 10 }));
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / 2);
  return g;
}

/**
 * A straight run of wall along +X from x0 to x1, its outer face at z = zOut
 * facing -Z (turned by the caller): rubble footing, whitewash, a parapet with
 * merlons, loopholes, and the wall-walk inside. Pushes into `parts`.
 * `skip`: [x0, x1] ranges with no wall (the gate).
 */
function wallRun(parts, R, { len, H, T, rot, place, skip = [], walkDrop = 0 }) {
  const foot = 1.0;                   // rubble course height
  // Wall-walk surface, inside. `walkDrop`: the side runs sit 3 cm lower, so
  // their walks never share a top face with the front and back runs' at the
  // corners.
  const walkY = H - 1.25 - walkDrop;
  const segs = [];
  let at = -len / 2;
  for (const [a, b] of [...skip].sort((p, q) => p[0] - q[0])) { segs.push([at, a]); at = b; }
  segs.push([at, len / 2]);
  for (const [a, b] of segs) {
    const w = b - a;
    if (w <= 0.05) continue;
    const cx = (a + b) / 2;
    // Rubble footing, a hair proud of the whitewash so the step shows.
    parts.push(place({ geo: buildBox(w, foot, T + 0.08), pos: [cx, foot / 2, 0], mat: MAT.rubble, tone: 0.45 + R() * 0.15 }, rot));
    // Whitewashed wall above it. Its foot sits 2 cm INTO the footing (no shared face).
    parts.push(place({ geo: buildBox(w, H - foot + 0.02, T), pos: [cx, foot - 0.02 + (H - foot + 0.02) / 2, 0], mat: MAT.white, tone: 0.38 + R() * 0.1 }, rot));
    // Wall-walk: a stone banquette along the inside face.
    parts.push(place({ geo: buildBox(w - 0.06, walkY, 1.0), pos: [cx, walkY / 2, T / 2 + 0.5], mat: MAT.rubble, tone: 0.35 }, rot));   // ends 3 cm in: flush with the footing's ends they z-fought
    // Merlons along the top, square, with the cope a shade darker.
    const n = Math.max(1, Math.round(w / 1.25));
    const pitch = w / n;
    for (let k = 0; k < n; k++) {
      const x = a + pitch * (k + 0.5);
      parts.push(place({ geo: buildBox(pitch * 0.58, 0.62, T), pos: [x, H + 0.31, 0], mat: MAT.white, tone: 0.55 + R() * 0.1 }, rot));
      parts.push(place({ geo: buildBox(pitch * 0.58 + 0.06, 0.06, T + 0.06), pos: [x, H + 0.65, 0], mat: MAT.concrete, tone: 0.5 }, rot));
    }
    // Loopholes: dark slits through the wall at firing height, every ~2.5 m.
    const m = Math.max(1, Math.floor(w / 2.5));
    for (let k = 0; k < m; k++) {
      const x = a + (w * (k + 0.5)) / m;
      parts.push(place({ geo: buildBox(0.16, 0.5, T + 0.03), pos: [x, H - 0.75, 0], mat: MAT.steel, tone: 0.0 }, rot));
    }
  }
}

/** A square tower, crenellated, with a sandbagged gun position on its roof. */
function tower(parts, R, { x, z, W, H, seed }) {
  const foot = 1.2;
  parts.push({ geo: buildBox(W + 0.1, foot, W + 0.1), pos: [x, foot / 2, z], mat: MAT.rubble, tone: 0.5 });
  parts.push({ geo: buildBox(W, H - foot + 0.02, W), pos: [x, foot - 0.02 + (H - foot + 0.02) / 2, z], mat: MAT.white, tone: 0.56 });
  // A string course under the parapet: the line that makes it a tower, not a box.
  parts.push({ geo: buildBox(W + 0.24, 0.18, W + 0.24), pos: [x, H - 0.05, z], mat: MAT.concrete, tone: 0.55 });
  // Merlons round the roof edge.
  const n = 4, pitch = W / n;
  for (const [dx, dz, ry] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
    for (let k = 0; k < n; k++) {
      const off = -W / 2 + pitch * (k + 0.5);
      // The side rows (±X) sit 4 cm lower and 3 cm further in than the front
      // and back rows, so the corner merlons never share a face; all start
      // 1 cm above the roof slab (equal bottoms z-fought).
      const side = dx !== 0, mh = side ? 0.66 : 0.7, inset = side ? 0.23 : 0.2;
      const px = x + (dx ? dx * (W / 2 - inset) : off), pz = z + (dz ? dz * (W / 2 - inset) : off);
      parts.push({ geo: buildBox(pitch * 0.55, mh, 0.4), pos: [px, H + (side ? 0.03 : 0.01) + mh / 2, pz], rot: [0, ry, 0], mat: MAT.white, tone: 0.6 + R() * 0.08 });
    }
  }
  // Roof slab, and a ring of sandbags round a gun on it.
  parts.push({ geo: buildBox(W - 0.4, 0.12, W - 0.4), pos: [x, H + 0.06, z], mat: MAT.concrete, tone: 0.35 });
  parts.push({ geo: buildSandbagRing({ radius: W * 0.28, courses: 3, seed, gapDeg: 60 }), pos: [x, H + 0.12, z], mat: null });
  // The gun: a tripod MG, barrel out over the ring toward the outside corner.
  const gx = x + Math.sign(x) * 0.2, gz = z + Math.sign(z) * 0.2;
  const yaw = Math.atan2(Math.sign(x), Math.sign(z));
  parts.push({ geo: buildBox(0.14, 0.14, 1.3), pos: [gx + Math.sin(yaw) * 0.5, H + 1.0, gz + Math.cos(yaw) * 0.5], rot: [0, yaw, 0], mat: MAT.steel, tone: 0.1 });
  parts.push({ geo: buildBox(0.3, 0.26, 0.5), pos: [gx, H + 0.95, gz], rot: [0, yaw, 0], mat: MAT.steel, tone: 0.15 });
  // Loopholes on each face, two storeys.
  for (const [nx, nz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    for (const y of [2.4, H - 1.4]) {
      parts.push({ geo: buildBox(nx ? 0.06 : 0.18, 0.55, nz ? 0.06 : 0.18), pos: [x + nx * (W / 2 + 0.02), y, z + nz * (W / 2 + 0.02)], mat: MAT.steel, tone: 0 });
    }
  }
}

/** A flat-roofed whitewashed block: doors, windows with shutters, a parapet. */
function block(parts, R, { x, z, w, d, h, doorSide = 1, doors = 2, windows = 4 }) {
  const foot = 0.6;
  parts.push({ geo: buildBox(w + 0.08, foot, d + 0.08), pos: [x, foot / 2, z], mat: MAT.rubble, tone: 0.4 });
  parts.push({ geo: buildBox(w, h - foot + 0.02, d), pos: [x, foot - 0.02 + (h - foot + 0.02) / 2, z], mat: MAT.white, tone: 0.5 + R() * 0.1 });
  // Flat roof: a concrete slab, a low parapet, a spout.
  parts.push({ geo: buildBox(w + 0.3, 0.2, d + 0.3), pos: [x, h + 0.1, z], mat: MAT.concrete, tone: 0.42 });
  for (const s of [-1, 1]) {
    parts.push({ geo: buildBox(w + 0.3, 0.4, 0.2), pos: [x, h + 0.4, z + s * (d / 2 + 0.05)], mat: MAT.white, tone: 0.58 });
    parts.push({ geo: buildBox(0.2, 0.37, d + 0.1), pos: [x + s * (w / 2 + 0.02), h + 0.405, z], mat: MAT.white, tone: 0.58 });   // inside the long pieces' ends: flush corners z-fought
  }
  // The face with the doors, toward the courtyard (+/-Z by doorSide).
  const fz = z + doorSide * (d / 2 + 0.01);
  const slots = doors + windows;
  for (let k = 0; k < slots; k++) {
    const sx = x - w / 2 + (w * (k + 0.5)) / slots;
    const isDoor = k % Math.ceil(slots / doors) === Math.floor(Math.ceil(slots / doors) / 2) && doors > 0;
    if (isDoor) {
      parts.push({ geo: buildBox(1.1, 2.2, 0.05), pos: [sx, 1.1, fz], mat: MAT.timber, tone: 0.15 });
      parts.push({ geo: buildBox(1.4, 0.18, 0.1), pos: [sx, 2.32, fz + doorSide * 0.02], mat: MAT.concrete, tone: 0.5 });
    } else {
      parts.push({ geo: buildBox(0.9, 1.1, 0.05), pos: [sx, 1.75, fz], mat: MAT.steel, tone: 0.0 });
      parts.push({ geo: buildBox(1.1, 0.1, 0.16), pos: [sx, 1.17, fz + doorSide * 0.05], mat: MAT.concrete, tone: 0.5 });
      // Shutters folded back, painted (the kit's paint is the army's olive).
      for (const s of [-1, 1]) {
        if (R() < 0.12) continue;
        // Narrow enough that neighbouring windows' shutters never meet.
        parts.push({ geo: buildBox(0.36, 1.1, 0.04), pos: [sx + s * 0.66, 1.75, fz + doorSide * 0.03], mat: MAT.paint, tone: 0.45 + R() * 0.2 });
      }
    }
  }
}

export function buildFrenchPost({ seed = 1957 } = {}) {
  const R = rng(seed);
  const parts = [];
  const L = 22, H = 3.2, T = 0.6, hl = L / 2;
  const gateW = 3.4;

  // Place a part authored along +X at the origin onto one of the four sides.
  const side = (angle, off) => (p) => {
    const m = new THREE.Matrix4().makeRotationY(angle).setPosition(off[0], 0, off[2]);
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...(p.pos ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.rot ?? [0, 0, 0]))),
      new THREE.Vector3(1, 1, 1),
    );
    return { geo: p.geo, mat: p.mat, tone: p.tone, matrix: m.multiply(local) };
  };
  // Front (-Z, gate), back (+Z), left (-X), right (+X). Each run's local +Z
  // points INTO the courtyard, so the wall-walk lands inside.
  const runs = [
    { angle: 0, off: [0, 0, -hl + T / 2], skip: [[-gateW / 2 - 0.5, gateW / 2 + 0.5]] },
    { angle: Math.PI, off: [0, 0, hl - T / 2] },
    // Left run turned +90 deg so its local +Z (the wall-walk side) points
    // INTO the courtyard (+X); right run -90. They were swapped: both side
    // walls had their wall-walk outside.
    { angle: Math.PI / 2, off: [-hl + T / 2, 0, 0], walkDrop: 0.03 },
    { angle: -Math.PI / 2, off: [hl - T / 2, 0, 0], walkDrop: 0.03 },
  ];
  for (const r of runs) {
    const place = side(r.angle, r.off);
    wallRun(parts, R, { len: L - T * 2 + 0.02, H, T, place: (p) => place(p), skip: r.skip, walkDrop: r.walkDrop ?? 0 });
  }
  // Corner piers where the runs meet (the runs stop short of the corners).
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push({ geo: buildBox(T + 0.04, 1.0, T + 0.04), pos: [sx * (hl - T / 2), 0.5, sz * (hl - T / 2)], mat: MAT.rubble, tone: 0.45 });
    parts.push({ geo: buildBox(T, H - 0.98, T), pos: [sx * (hl - T / 2), 0.98 + (H - 0.98) / 2, sz * (hl - T / 2)], mat: MAT.white, tone: 0.52 });
  }

  // ── Two towers on the diagonal: front-left and back-right ──────────────────
  const TW = 5, TH = 6.8;
  tower(parts, R, { x: -hl + TW / 2 - 1.0, z: -hl + TW / 2 - 1.0, W: TW, H: TH, seed: seed + 1 });
  tower(parts, R, { x: hl - TW / 2 + 1.0, z: hl - TW / 2 + 1.0, W: TW, H: TH, seed: seed + 2 });
  // Where each tower's MG is (its breech, a metre over the roof): a game fires
  // the post's guns from there (userData.towerGuns, scaled below).
  const towerGuns = [-1, 1].map((sg) => [sg * (hl - TW / 2 + 1.0), TH + 1.0, sg * (hl - TW / 2 + 1.0)]);

  // ── The gatehouse ──────────────────────────────────────────────────────────
  const gH = 5.4, gW = gateW + 3.2, gD = 1.4;
  const gz = -hl - 0.1;
  parts.push({ geo: archWall(gW, gH, gD, [{ cx: 0, w: gateW, spring: 2.7 }]), pos: [0, 0, gz - 0.4], mat: MAT.white, tone: 0.62 });
  parts.push({ geo: buildBox(gW + 0.1, 1.04, gD + 0.1), pos: [0, 0.52, gz - 0.4 + gD / 2], mat: MAT.rubble, tone: 0.5 });   // 4 cm over the wall footing: equal tops z-fought
  // Stepped top: the bordj's gate is the one tall thing on the front.
  parts.push({ geo: buildBox(gW * 0.62, 0.9, gD - 0.1), pos: [0, gH + 0.45, gz - 0.4 + gD / 2], mat: MAT.white, tone: 0.64 });
  parts.push({ geo: buildBox(gW * 0.3, 0.6, gD - 0.2), pos: [0, gH + 1.2, gz - 0.4 + gD / 2], mat: MAT.white, tone: 0.66 });
  parts.push({ geo: buildBox(gW + 0.3, 0.16, gD + 0.3), pos: [0, gH, gz - 0.4 + gD / 2], mat: MAT.concrete, tone: 0.55 });
  // Pilasters either side of the arch.
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildBox(0.5, gH - 1.08, 0.2), pos: [sx * (gateW / 2 + 0.55), 1.02 + (gH - 1.08) / 2, gz - 0.48], mat: MAT.white, tone: 0.7 });
  }
  // The GATE: two timber leaves, their own geometry (userData.gate), so a game
  // can swing them — open as a section marches out, shut behind it. Hinged at
  // the inner end of the passage; each leaf authored CLOSED, running from its
  // hinge (the origin) toward the centre. Open = turned 90° into the
  // courtyard, lying against the passage wall as the old baked doors did.
  const hingeZ = gz - 0.4 + gD + 0.05;
  const leafW = gateW / 2 - 0.06;
  const gateLeaves = [-1, 1].map((sx) => {
    const lp = [];
    lp.push({ geo: buildBox(leafW, 2.6, 0.1), pos: [-sx * leafW / 2, 1.3, 0], mat: MAT.timber, tone: 0.25 + R() * 0.1 });
    // Battens and a brace on the courtyard side; iron strap hinges outside.
    for (const y of [0.45, 2.15]) lp.push({ geo: buildBox(leafW - 0.1, 0.16, 0.06), pos: [-sx * leafW / 2, y, 0.085], mat: MAT.timber, tone: 0.2 });
    lp.push({ geo: buildBox(0.14, 1.95, 0.05), pos: [-sx * leafW / 2, 1.3, 0.1], rot: [0, 0, sx * 0.7], mat: MAT.timber, tone: 0.22 });   // proud of the battens: equal faces z-fight
    for (const y of [0.6, 2.0]) lp.push({ geo: buildBox(0.5, 0.07, 0.03), pos: [-sx * 0.3, y, -0.07], mat: MAT.steel, tone: 0.2 });
    const g = assemble(lp);
    bakeContactAO(g, { cell: 0.1, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
    g.scale(S, S, S);
    // rotation.y that swings the leaf open, into the courtyard (+Z).
    return { geo: g, pivot: [sx * (gateW / 2) * S, 0, hingeZ * S], openYaw: sx * (Math.PI / 2) };
  });
  // A sandbag chicane in front of the gate, two staggered walls.
  const bag = { length: 0.52, width: 0.3, height: 0.19, segU: 6, segV: 4 };
  parts.push({ geo: buildSandbagWall({ length: 3.6, courses: 5, seed: seed + 7, bag, batter: 0.04 }), pos: [-1.6, 0, gz - 4.2], mat: null });
  parts.push({ geo: buildSandbagWall({ length: 3.6, courses: 5, seed: seed + 8, bag, batter: 0.04 }), pos: [1.6, 0, gz - 6.4], mat: null });

  // ── Inside: the barracks along the back wall, the command post on the left ─
  block(parts, R, { x: 1.5, z: hl - T - 3.4, w: 14, d: 6, h: 3.3, doorSide: -1, doors: 2, windows: 6 });
  block(parts, R, { x: -hl + T + 3.3, z: -0.4, w: 6, d: 8, h: 3.6, doorSide: 1, doors: 1, windows: 2 });   // clear of the barracks (they overlapped by 0.5 m)

  // The radio mast beside the command post: a tapering lattice, guyed.
  {
    const mx = -hl + T + 2.0, mz = 5.8, mH = 14;
    // Round tubes (wirePart): box legs and bars met end-on and z-fought.
    const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const legAt = (lx, lz, y) => { const f = y / mH, h = 0.5 - 0.42 * f; return [mx + lx * h, y, mz + lz * h]; };
    for (const [lx, lz] of legs) parts.push(wirePart(legAt(lx, lz, 0), legAt(lx, lz, mH), 0.045, { tone: 0.3 }));
    for (let k = 1; k < 7; k++) {
      const y = (mH * k) / 7, y0 = (mH * (k - 1)) / 7;
      for (let i = 0; i < 4; i++) {
        const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
        parts.push(wirePart(legAt(ax, az, y), legAt(bx, bz, y), 0.028, { tone: 0.3 }));                   // girt
        parts.push(wirePart(legAt(ax, az, y0), legAt(bx, bz, y), 0.022, { tone: 0.35 }));                 // brace
      }
    }
    parts.push({ geo: buildBox(0.04, 4, 0.04), pos: [mx, mH + 2, mz], mat: MAT.steel, tone: 0.5 });
  }

  // The flagpole's plinth, in the courtyard in line with the gate. The pole
  // and the flag are a GAME's live cloth (userData.flagMount): nam-rts's
  // Verlet flag, not a painted sheet.
  const poleH = 10;
  parts.push({ geo: buildBox(1.6, 0.3, 1.6), pos: [0, 0.15, -2.5], mat: MAT.concrete, tone: 0.55 });

  // Stores in the courtyard: drums, crates by the command post, a water tank.
  for (let k = 0; k < 6; k++) {
    parts.push({ geo: buildOilDrum({}), pos: [4.5 + (k % 3) * 0.65, 0, -6 + Math.floor(k / 3) * 0.65], rot: [0, R() * 3, 0], mat: MAT.paint, tone: 0.3 + R() * 0.3 });
  }
  for (let k = 0; k < 4; k++) {
    parts.push({ geo: buildBox(1.1, 0.6, 0.7), pos: [-4.5 + (k % 2) * 1.2, 0.3 + Math.floor(k / 2) * 0.6, -5.5], rot: [0, (R() - 0.5) * 0.2, 0], mat: MAT.paint, tone: 0.4 + R() * 0.2 });
  }
  parts.push({ geo: new THREE.CylinderGeometry(1.1, 1.1, 1.6, 14), pos: [hl - T - 2.2, 2.5, -hl + T + 2.2], mat: MAT.paint, tone: 0.55 });
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    parts.push({ geo: buildBox(0.12, 1.7, 0.12), pos: [hl - T - 2.2 + sx * 0.8, 0.85, -hl + T + 2.2 + sz * 0.8], mat: MAT.timber, tone: 0.3 });
  }

  // ── Barbed wire outside the walls: pickets and three strands ───────────────
  const wr = hl + 5.5;
  const wireRuns = [
    [[-wr, -wr], [-gateW - 3, -wr]], [[gateW + 3, -wr], [wr, -wr]],
    [[wr, -wr], [wr, wr]], [[wr, wr], [-wr, wr]], [[-wr, wr], [-wr, -wr]],
  ];
  for (const [[x0, z0], [x1, z1]] of wireRuns) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 3));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      parts.push({ geo: buildBox(0.08, 1.3, 0.08), pos: [x0 + (x1 - x0) * t, 0.65, z0 + (z1 - z0) * t], rot: [(R() - 0.5) * 0.08, 0, (R() - 0.5) * 0.08], mat: MAT.steel, tone: 0.35 });
    }
    // Strands as round wire (wirePart): box strands z-fought along their length.
    for (const y of [0.35, 0.75, 1.15]) parts.push(wirePart([x0, y, z0], [x1, y, z1], 0.022));
    // Crossed strands between each pair of pickets: straight wires alone read
    // as a farm fence, the diagonals make it an entanglement.
    for (let k = 0; k < n; k++) {
      const ax = x0 + ((x1 - x0) * k) / n, az = z0 + ((z1 - z0) * k) / n;
      const bx = x0 + ((x1 - x0) * (k + 1)) / n, bz = z0 + ((z1 - z0) * (k + 1)) / n;
      parts.push(wirePart([ax, 0.12, az], [bx, 1.25, bz], 0.02));
      parts.push(wirePart([ax, 1.25, az], [bx, 0.12, bz], 0.02));
    }
  }

  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.4, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5 });

  // ── Markings ───────────────────────────────────────────────────────────────
  const st = [];
  const faceZ = gz - 0.4 - 0.01;
  st.push(stencilPatch("frPosteSign", flatSurface([0, 3.35, faceZ], [0, 0, -1], [-1, 0, 0], 3.4, "frPosteSign"), { lift: 0.01 }));
  st.push(stencilPatch("frTricolore", flatSurface([0, gH + 0.45, faceZ], [0, 0, -1], [-1, 0, 0], 1.25, "frTricolore"), { lift: 0.012 }));
  st.push(stencilPatch("frSasSign", flatSurface([-hl + T + 3.3, 2.7, -0.4 + 4.02], [0, 0, 1], [1, 0, 0], 1.3, "frSasSign"), { lift: 0.01 }));
  // Whitewash fallen off the outer walls and the towers, low down, where damp
  // and knocks take it first: the stone behind shows through.
  {
    const faces = [
      { n: [0, 0, -1], r: [-1, 0, 0], at: (t) => [t, -hl], avoid: (t) => Math.abs(t) < gW / 2 + 0.6 },
      { n: [0, 0, 1], r: [1, 0, 0], at: (t) => [t, hl] },
      { n: [-1, 0, 0], r: [0, 0, 1], at: (t) => [-hl, t] },
      { n: [1, 0, 0], r: [0, 0, -1], at: (t) => [hl, t] },
    ];
    let placed = 0;
    for (let k = 0; k < 90 && placed < 28; k++) {
      const f = faces[Math.floor(R() * 4)];
      const t = (R() - 0.5) * (L - 11);          // clear of the corner towers
      if (f.avoid?.(t)) continue;
      const [x, z] = f.at(t);
      const w = 1.6 + R() * 1.6, y = 1.5 + R() * 1.3;
      const cell = R() < 0.5 ? "plasterFallA" : "plasterFallB";
      const c = [x + f.n[0] * 0.012, y, z + f.n[2] * 0.012];
      st.push(stencilPatch(cell, flatSurface(c, f.n, f.r, w, cell), { lift: 0.004 + placed * 0.0004 }));
      placed++;
    }
    // Two on each tower's outer faces.
    for (const [tx, tz] of [[-hl + TW / 2 - 1.0, -hl + TW / 2 - 1.0], [hl - TW / 2 + 1.0, hl - TW / 2 + 1.0]]) {
      const sx = Math.sign(tx), sz = Math.sign(tz);
      const cell = R() < 0.5 ? "plasterFallA" : "plasterFallB";
      st.push(stencilPatch(cell, flatSurface([tx + sx * (TW / 2 + 0.012), 1.8 + R() * 2.5, tz + (R() - 0.5) * 2.5], [sx, 0, 0], [0, 0, -sx], 1.2 + R() * 0.6, cell), { lift: 0.005 }));
      st.push(stencilPatch(cell, flatSurface([tx + (R() - 0.5) * 2.5, 1.6 + R() * 2.5, tz + sz * (TW / 2 + 0.012)], [0, 0, sz], [sz, 0, 0], 1.1 + R() * 0.6, cell), { lift: 0.005 }));
    }
  }
  const stencil = mergeStencils(st);

  // Everything man-made is real x 1.3 in this game.
  geo.scale(S, S, S);
  stencil?.scale(S, S, S);
  geo.userData.stencil = stencil;
  const half = (wr + 0.5) * S;
  geo.userData.footprint = { cx: 0, cz: -1.5 * S, hx: half, hz: half + 1.5 * S };
  geo.userData.flagMount = { pos: [0, 0.3 * S, -2.5 * S], poleHeight: poleH * S };
  geo.userData.gate = { leaves: gateLeaves, width: gateW * S, z: (gz - 0.4) * S };
  geo.userData.parts = { ...(geo.userData.parts ?? {}), gateLeft: gateLeaves[0].geo, gateRight: gateLeaves[1].geo };
  geo.userData.height = (poleH + 0.3) * S;
  geo.userData.size = { L: L * S, wall: H * S, tower: TH * S };
  geo.userData.towerGuns = towerGuns.map((p) => p.map((v) => v * S));
  return geo;
}
