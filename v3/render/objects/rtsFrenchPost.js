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
import { MAT, assemble, bakeContactAO, buildBox, buildCorrugatedPanel, buildOilDrum, buildSandbagRing, buildSandbagWall, rng, wirePart } from "./rtsParts.js";
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
function wallRun(parts, R, { len, H, T, rot, place, skip = [], walkDrop = 0, detail = 1 }) {
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
    if (detail >= 2) {
      // THE BORDJ'S PARAPET (the buildings lab, 2026-10-07, from photos of Algerian bordjs — you:
      // "go with 1"): no merlons (the toy-castle cliché) but a plain, heavy parapet with its
      // coping, a row of narrow slits under it, and BUTTRESSES stepping down the outer face.
      parts.push(place({ geo: buildBox(w, 0.72, T), pos: [cx, H + 0.36, 0], mat: MAT.white, tone: 0.52 + R() * 0.06 }, rot));
      parts.push(place({ geo: buildBox(w + 0.02, 0.1, T + 0.12), pos: [cx, H + 0.77, 0], mat: MAT.concrete, tone: 0.5 }, rot));
      const ns = Math.max(1, Math.round(w / 1.6));
      for (let k = 0; k < ns; k++) parts.push(place({ geo: buildBox(0.1, 0.42, T + 0.03), pos: [a + (w * (k + 0.5)) / ns, H + 0.32, 0], mat: MAT.steel, tone: 0.0 }, rot));
      const nb = Math.floor(w / 4.4);
      for (let k = 1; k <= nb; k++) {
        const bx = a + (w * k) / (nb + 1);
        // Two steps: the lower deeper (in the rubble footing's stone), the upper whitewashed.
        parts.push(place({ geo: buildBox(0.7, 1.3, 0.62), pos: [bx, 0.65, -T / 2 - 0.27], mat: MAT.rubble, tone: 0.45 + R() * 0.1 }, rot));
        parts.push(place({ geo: buildBox(0.56, H - 1.0, 0.32), pos: [bx, 1.25 + (H - 1.0) / 2 - 0.05, -T / 2 - 0.13], mat: MAT.white, tone: 0.5 + R() * 0.08 }, rot));
        parts.push(place({ geo: buildBox(0.62, 0.08, 0.4), pos: [bx, H + 0.16, -T / 2 - 0.15], mat: MAT.concrete, tone: 0.48 }, rot));
      }
    } else {
      // Merlons along the top, square, with the cope a shade darker.
      const n = Math.max(1, Math.round(w / 1.25));
      const pitch = w / n;
      for (let k = 0; k < n; k++) {
        const x = a + pitch * (k + 0.5);
        parts.push(place({ geo: buildBox(pitch * 0.58, 0.62, T), pos: [x, H + 0.31, 0], mat: MAT.white, tone: 0.55 + R() * 0.1 }, rot));
        parts.push(place({ geo: buildBox(pitch * 0.58 + 0.06, 0.06, T + 0.06), pos: [x, H + 0.65, 0], mat: MAT.concrete, tone: 0.5 }, rot));
      }
    }
    // Loopholes: dark slits through the wall at firing height, every ~2.5 m.
    const m = Math.max(1, Math.floor(w / 2.5));
    for (let k = 0; k < m; k++) {
      const x = a + (w * (k + 0.5)) / m;
      parts.push(place({ geo: buildBox(0.16, 0.5, T + 0.03), pos: [x, H - 0.75, 0], mat: MAT.steel, tone: 0.0 }, rot));
    }
  }
}

/**
 * THE AA-52 ON ITS TRIPOD (detail 2; you, 2026-10-07: "better looking machine guns on the HQ") —
 * the French army's machine gun from 1952, what a post's towers mounted: a slab-sided receiver,
 * the long bare barrel with its carrying handle and flash hider, the steel butt, the pistol grip,
 * the belt from a box on the left; the tripod's three splayed legs; ammunition boxes at its feet.
 * Real sizes (the gun 1.15 m). Authored along +Z (the muzzle), the tripod's feet on y = 0 at the
 * origin; turned by `yaw` and set at `at`. Pushes into `parts`.
 */
function aa52OnTripod(parts, at, yaw, R) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const put = (geo, lp, mat, tone, rot = [0, 0, 0]) => parts.push({
    geo, pos: [at[0] + lp[0] * c + lp[2] * s, at[1] + lp[1], at[2] - lp[0] * s + lp[2] * c], rot: [rot[0], rot[1] + yaw, rot[2]], mat, tone,
  });
  const tube = (a, b, r) => {
    const wa = [at[0] + a[0] * c + a[2] * s, at[1] + a[1], at[2] - a[0] * s + a[2] * c];
    const wb = [at[0] + b[0] * c + b[2] * s, at[1] + b[1], at[2] - b[0] * s + b[2] * c];
    parts.push(wirePart(wa, wb, r, { tone: 0.22 }));
  };
  const HY = 0.62;   // the cradle's height over the feet
  // The tripod: the rear leg long and low, the two front legs splayed; the cradle on the head.
  tube([0, HY, 0], [0, 0, -0.6], 0.022);
  for (const sx of [-1, 1]) tube([0, HY, 0], [sx * 0.3, 0, 0.28], 0.02);
  put(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 8), [0, HY - 0.02, 0], MAT.steel, 0.2);
  put(buildBox(0.08, 0.06, 0.22), [0, HY + 0.05, 0.02], MAT.steel, 0.18);
  // The gun, a hair nose-down over the cradle.
  const gy = HY + 0.15, tilt = -0.03;
  put(buildBox(0.075, 0.11, 0.42), [0, gy, 0.02], MAT.steel, 0.08, [tilt, 0, 0]);                 // receiver
  put(buildBox(0.08, 0.03, 0.3), [0, gy + 0.07, 0.04], MAT.steel, 0.12, [tilt, 0, 0]);            // top cover
  put(new THREE.CylinderGeometry(0.017, 0.017, 0.56, 8).rotateX(Math.PI / 2), [0, gy + 0.02, 0.5], MAT.steel, 0.05, [tilt, 0, 0]);   // barrel
  put(new THREE.CylinderGeometry(0.03, 0.022, 0.1, 8).rotateX(Math.PI / 2), [0, gy + 0.025, 0.82], MAT.steel, 0.1, [tilt, 0, 0]);    // flash hider
  put(new THREE.CylinderGeometry(0.026, 0.026, 0.08, 8).rotateX(Math.PI / 2), [0, gy + 0.02, 0.26], MAT.steel, 0.14, [tilt, 0, 0]);   // barrel nut
  put(buildBox(0.018, 0.09, 0.03), [0, gy + 0.075, 0.38], MAT.steel, 0.1);                        // carrying handle, its post
  put(buildBox(0.022, 0.022, 0.16), [0, gy + 0.12, 0.38], MAT.timber, 0.2);                       // and grip
  put(buildBox(0.012, 0.05, 0.012), [0, gy + 0.07, 0.74], MAT.steel, 0.1);                        // front sight
  put(buildBox(0.05, 0.1, 0.34), [0, gy - 0.03, -0.34], MAT.steel, 0.1, [0.14, 0, 0]);            // steel butt
  put(buildBox(0.05, 0.13, 0.05), [0, gy - 0.12, -0.21], MAT.steel, 0.1, [0.3, 0, 0]);            // butt's monopod
  put(buildBox(0.04, 0.12, 0.055), [0, gy - 0.1, -0.1], MAT.timber, 0.22, [-0.35, 0, 0]);         // pistol grip
  // The belt box on the left, the belt rising into the feed.
  put(buildBox(0.12, 0.17, 0.26), [-0.16, gy - 0.12, 0.05], MAT.paint, 0.32);
  put(buildBox(0.03, 0.11, 0.08), [-0.085, gy - 0.02, 0.05], MAT.steel, 0.4, [0, 0, -0.5]);   // the belt (the corrugated cell read rust-orange)
  // Spare boxes and a bag at its feet.
  for (let k = 0; k < 2; k++) put(buildBox(0.26, 0.15, 0.12), [0.34, 0.075, -0.3 + k * 0.16], MAT.paint, 0.3 + R() * 0.1, [0, R() * 0.3, 0]);
}

/** A square tower, crenellated, with a sandbagged gun position on its roof. */
function tower(parts, R, { x, z, W, H, seed, detail = 1 }) {
  const foot = 1.2;
  if (detail >= 2) {
    // The TALUS: the tower stands on a sloped stone skirt (a 4-sided frustum turned square).
    const tal = new THREE.CylinderGeometry((W / 2) * Math.SQRT2 + 0.02, (W / 2 + 0.55) * Math.SQRT2, 1.8, 4, 1).rotateY(Math.PI / 4);
    const uv = tal.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * W * 2, uv.getY(i) * 0.9);
    parts.push({ geo: indexed(tal), pos: [x, 0.9, z], mat: MAT.rubble, tone: 0.5 });
  } else parts.push({ geo: buildBox(W + 0.1, foot, W + 0.1), pos: [x, foot / 2, z], mat: MAT.rubble, tone: 0.5 });
  parts.push({ geo: buildBox(W, H - foot + 0.02, W), pos: [x, foot - 0.02 + (H - foot + 0.02) / 2, z], mat: MAT.white, tone: 0.56 });
  // A string course under the parapet: the line that makes it a tower, not a box.
  parts.push({ geo: buildBox(W + 0.24, 0.18, W + 0.24), pos: [x, H - 0.05, z], mat: MAT.concrete, tone: 0.55 });
  // Merlons round the roof edge (detail 2: a solid parapet, corbelled out, slits in it).
  const n = 4, pitch = W / n;
  if (detail >= 2) {
    const PW = W + 0.4, ph = 0.72;   // the merlons' height: the tower's MG (towerGuns, ~1 m up) must show over it
    parts.push({ geo: buildBox(W + 0.5, 0.22, W + 0.5), pos: [x, H + 0.06, z], mat: MAT.concrete, tone: 0.5 });   // the corbel band
    for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const side = dx !== 0, len = side ? PW - 0.66 : PW;   // the side pieces between the long ones (no shared faces)
      const px = x + dx * (PW / 2 - 0.16), pz = z + dz * (PW / 2 - 0.16);
      parts.push({ geo: buildBox(side ? 0.32 : len, ph, side ? len : 0.32), pos: [px, H + 0.17 + ph / 2, pz], mat: MAT.white, tone: 0.6 });
      parts.push({ geo: buildBox(side ? 0.42 : len + 0.08, 0.08, side ? len + 0.02 : 0.42), pos: [px, H + 0.17 + ph + 0.04 + (side ? 0.01 : 0), pz], mat: MAT.concrete, tone: 0.5 });
      for (const o of [-1.2, 0, 1.2]) parts.push({ geo: buildBox(side ? 0.34 : 0.1, 0.3, side ? 0.1 : 0.34), pos: [px + (side ? 0 : o), H + 0.52, pz + (side ? o : 0)], mat: MAT.steel, tone: 0 });
    }
  } else for (const [dx, dz, ry] of [[0, -1, 0], [0, 1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
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
  if (detail >= 2) {
    // The AA-52 on its tripod, on a sandbag step (the ring is 3 courses: the gun must clear it).
    // (A slab of hessian read as a box: three short rows of real bags, two courses.)
    for (let k = -1; k <= 1; k++) {
      const ox = Math.cos(yaw) * k * 0.3, oz = -Math.sin(yaw) * k * 0.3;
      parts.push({ geo: buildSandbagWall({ length: 1.2, courses: 2, seed: seed * 7 + k + 3, bag: { length: 0.5, width: 0.3, height: 0.18, segU: 5, segV: 3 } }), pos: [gx + ox, H + 0.12, gz + oz], rot: [0, yaw + Math.PI / 2, 0], mat: null });
    }
    aa52OnTripod(parts, [gx, H + 0.48, gz], yaw, R);
  } else {
    parts.push({ geo: buildBox(0.14, 0.14, 1.3), pos: [gx + Math.sin(yaw) * 0.5, H + 1.0, gz + Math.cos(yaw) * 0.5], rot: [0, yaw, 0], mat: MAT.steel, tone: 0.1 });
    parts.push({ geo: buildBox(0.3, 0.26, 0.5), pos: [gx, H + 0.95, gz], rot: [0, yaw, 0], mat: MAT.steel, tone: 0.15 });
  }
  // Loopholes on each face, two storeys.
  for (const [nx, nz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    for (const y of [2.4, H - 1.4]) {
      parts.push({ geo: buildBox(nx ? 0.06 : 0.18, 0.55, nz ? 0.06 : 0.18), pos: [x + nx * (W / 2 + 0.02), y, z + nz * (W / 2 + 0.02)], mat: MAT.steel, tone: 0 });
    }
  }
}

/** A flat-roofed whitewashed block: doors, windows with shutters, a parapet. */
function block(parts, R, { x, z, w, d, h, doorSide = 1, doors = 2, windows = 4, detail = 1, roof = "barracks" }) {
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
  if (detail < 2) return;
  // ── THE ROOF IN USE (detail 2): the flat grey slabs were the biggest dead areas seen from the
  // RTS camera. A water tank on its stand, a stovepipe, a sandbagged look-out, kit drying, and a
  // ladder up from the yard.
  const ry = h + 0.2;
  const ex = x + (w / 2 - 1.4) * (R() < 0.5 ? -1 : 1);
  // The water tank (a drum on its side would be the jerrican age; this is the post's own).
  parts.push({ geo: new THREE.CylinderGeometry(0.6, 0.6, 1.1, 14), pos: [ex, ry + 1.15, z - d / 4], mat: MAT.metal, tone: 0.35 });
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push({ geo: buildBox(0.08, 0.6, 0.08), pos: [ex + a * 0.42, ry + 0.3, z - d / 4 + b * 0.42], mat: MAT.steel, tone: 0.3 });
  // Stovepipes, each with its cap.
  for (const k of [-1, 1]) {
    const px = x + k * w * 0.22, pz = z + d * 0.18;
    parts.push({ geo: new THREE.CylinderGeometry(0.08, 0.08, 1.3, 8), pos: [px, ry + 0.65, pz], mat: MAT.steel, tone: 0.2 });
    parts.push({ geo: new THREE.ConeGeometry(0.2, 0.16, 8), pos: [px, ry + 1.38, pz], mat: MAT.steel, tone: 0.18 });
  }
  if (roof === "barracks") {
    // A look-out on the barracks: a sandbag horseshoe at the outer corner, a tarp over it.
    const lx = x - w / 2 + 1.6, lz = z - doorSide * (d / 2 - 1.4);
    parts.push({ geo: buildSandbagRing({ radius: 1.2, courses: 3, seed: Math.round(x * 13) + 5, gapDeg: 90 }), pos: [lx, ry, lz], rot: [0, doorSide > 0 ? 0 : Math.PI, 0], mat: null });
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push({ geo: buildBox(0.07, 1.6, 0.07), pos: [lx + a * 0.9, ry + 0.8, lz + b * 0.9], mat: MAT.timber, tone: 0.3 });
    parts.push({ geo: buildBox(2.1, 0.04, 2.1), pos: [lx, ry + 1.62, lz], rot: [0.08, 0, 0.05], mat: MAT.canvas, tone: 0.42 });
    // A washing line: two poles, the line, the shirts and a blanket on it.
    const wx0 = x + 0.5, wx1 = x + w / 2 - 2.6, wz = z + d / 2 - 1.0;
    for (const px of [wx0, wx1]) parts.push({ geo: buildBox(0.06, 1.7, 0.06), pos: [px, ry + 0.85, wz], mat: MAT.timber, tone: 0.3 });
    parts.push(wirePart([wx0, ry + 1.6, wz], [wx1, ry + 1.6, wz], 0.01, { mat: MAT.hessian, tone: 0.5 }));
    for (let k = 0; k < 5; k++) {
      const t = (k + 0.7) / 6, kind = R();
      parts.push({ geo: buildBox(kind < 0.3 ? 1.1 : 0.5, kind < 0.3 ? 0.9 : 0.6, 0.02), pos: [wx0 + (wx1 - wx0) * t, ry + 1.6 - (kind < 0.3 ? 0.45 : 0.3), wz], rot: [0, (R() - 0.5) * 0.2, 0], mat: kind < 0.3 ? MAT.canvas : kind < 0.65 ? MAT.white : MAT.paint, tone: 0.4 + R() * 0.2 });
    }
  } else {
    // The command post: the radio's antenna base and a crate of batteries.
    parts.push({ geo: buildBox(0.8, 0.5, 0.6), pos: [x + w / 4, ry + 0.25, z + d / 4], mat: MAT.paint, tone: 0.35 });
    parts.push({ geo: buildBox(0.6, 0.4, 0.5), pos: [x - w / 4, ry + 0.2, z - d / 3], mat: MAT.timber, tone: 0.4 });
  }
  // The LADDER up from the yard, against the door face.
  const lx2 = x + w / 2 - 0.7, lz2 = z + doorSide * (d / 2 + 0.25);
  for (const s of [-1, 1]) parts.push({ geo: buildBox(0.06, h + 0.9, 0.06), pos: [lx2 + s * 0.26, (h + 0.9) / 2, lz2], rot: [-doorSide * 0.12, 0, 0], mat: MAT.timber, tone: 0.32 });
  for (let k = 1; k < 9; k++) parts.push({ geo: buildBox(0.52, 0.045, 0.045), pos: [lx2, (k * (h + 0.6)) / 9, lz2 + doorSide * 0.12 * (0.5 - k / 9) * 0.9], mat: MAT.timber, tone: 0.3 });
}

export function buildFrenchPost({ seed = 1957, detail = 1 } = {}) {
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
    wallRun(parts, R, { len: L - T * 2 + 0.02, H, T, place: (p) => place(p), skip: r.skip, walkDrop: r.walkDrop ?? 0, detail });
  }
  // Corner piers where the runs meet (the runs stop short of the corners).
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push({ geo: buildBox(T + 0.04, 1.0, T + 0.04), pos: [sx * (hl - T / 2), 0.5, sz * (hl - T / 2)], mat: MAT.rubble, tone: 0.45 });
    parts.push({ geo: buildBox(T, H - 0.98, T), pos: [sx * (hl - T / 2), 0.98 + (H - 0.98) / 2, sz * (hl - T / 2)], mat: MAT.white, tone: 0.52 });
  }

  // ── Two towers on the diagonal: front-left and back-right ──────────────────
  const TW = 5, TH = 6.8;
  tower(parts, R, { x: -hl + TW / 2 - 1.0, z: -hl + TW / 2 - 1.0, W: TW, H: TH, seed: seed + 1, detail });
  tower(parts, R, { x: hl - TW / 2 + 1.0, z: hl - TW / 2 + 1.0, W: TW, H: TH, seed: seed + 2, detail });
  // Where each tower's MG is (its breech, a metre over the roof): a game fires
  // the post's guns from there (userData.towerGuns, scaled below).
  // (Detail 2: the AA-52's MUZZLE — the gun 0.2 m off the centre toward the outside corner, its
  // flash hider 0.86 m out along the diagonal, 1.27 m over the roof.)
  const towerGuns = [-1, 1].map((sg) => detail >= 2
    ? [sg * (hl - TW / 2 + 1.0 + 0.2 + 0.86 * Math.SQRT1_2), TH + 1.27, sg * (hl - TW / 2 + 1.0 + 0.2 + 0.86 * Math.SQRT1_2)]
    : [sg * (hl - TW / 2 + 1.0), TH + 1.0, sg * (hl - TW / 2 + 1.0)]);

  // ── The gatehouse ──────────────────────────────────────────────────────────
  const gH = 5.4, gW = gateW + 3.2, gD = 1.4;
  const gz = -hl - 0.1;
  parts.push({ geo: archWall(gW, gH, gD, [{ cx: 0, w: gateW, spring: 2.7 }]), pos: [0, 0, gz - 0.4], mat: MAT.white, tone: 0.62 });
  // The rubble footing either side of the ARCH only (4 cm over the wall
  // footing: equal tops z-fought). One block across the whole gatehouse ran
  // a knee-high wall through the gateway, and the men marched through it
  // (you, 2026-09-30). In the passage, a worn threshold slab, 8 cm up.
  const sideW = (gW + 0.1 - gateW) / 2 - 0.03;   // 3 cm back from the arch's jambs (flush, they z-fought)
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(sideW, 1.04, gD + 0.1), pos: [sx * (gateW / 2 + 0.03 + sideW / 2), 0.52, gz - 0.4 + gD / 2], mat: MAT.rubble, tone: 0.5 });
  parts.push({ geo: buildBox(gateW - 0.04, 0.08, gD + 0.06), pos: [0, 0.04 + 0.02, gz - 0.4 + gD / 2], mat: MAT.limestone, tone: 0.45 });
  if (detail >= 2) {
    // The gate's PARAPET, plain and heavy like the walls', with slits; a BRETÈCHE over the arch —
    // the box the gate is defended from, corbelled out, its floor open to drop through.
    parts.push({ geo: buildBox(gW, 0.9, gD - 0.1), pos: [0, gH + 0.45, gz - 0.4 + gD / 2], mat: MAT.white, tone: 0.64 });
    parts.push({ geo: buildBox(gW + 0.04, 0.1, gD + 0.02), pos: [0, gH + 0.95, gz - 0.4 + gD / 2], mat: MAT.concrete, tone: 0.5 });
    for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.1, 0.42, 0.04), pos: [sx * (gW / 2 - 0.6), gH + 0.45, gz - 0.4 + 0.02], mat: MAT.steel, tone: 0 });
    const bz = gz - 0.4 - 0.32;
    parts.push({ geo: buildBox(1.8, 1.0, 0.6), pos: [0, gH - 0.15, bz], mat: MAT.white, tone: 0.6 });
    for (const sx of [-1, 0, 1]) parts.push({ geo: buildBox(0.16, 0.3, 0.5), pos: [sx * 0.75, gH - 0.8, bz + 0.04], mat: MAT.concrete, tone: 0.5 });   // the corbels
    parts.push({ geo: buildBox(0.12, 0.38, 0.04), pos: [0, gH - 0.1, bz - 0.31], mat: MAT.steel, tone: 0 });
  } else {
    // Stepped top: the bordj's gate is the one tall thing on the front.
    parts.push({ geo: buildBox(gW * 0.62, 0.9, gD - 0.1), pos: [0, gH + 0.45, gz - 0.4 + gD / 2], mat: MAT.white, tone: 0.64 });
    parts.push({ geo: buildBox(gW * 0.3, 0.6, gD - 0.2), pos: [0, gH + 1.2, gz - 0.4 + gD / 2], mat: MAT.white, tone: 0.66 });
  }
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
  block(parts, R, { x: 1.5, z: hl - T - 3.4, w: 14, d: 6, h: 3.3, doorSide: -1, doors: 2, windows: 6, detail, roof: "barracks" });
  block(parts, R, { x: -hl + T + 3.3, z: -0.4, w: 6, d: 8, h: 3.6, doorSide: 1, doors: 1, windows: 2, detail, roof: "command" });   // clear of the barracks (they overlapped by 0.5 m)

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

  if (detail >= 2) {
    // ── THE YARD'S LIFE (detail 2; the period photographs: a post is full of things) ──
    // The PARADE GROUND: whitewashed stones in a square round the flag.
    for (let k = 0; k < 28; k++) {
      const t = (k % 7) / 7, e = Math.floor(k / 7), half = 2.6;
      const [x, z] = [[-half + t * 2 * half, -half], [half, -half + t * 2 * half], [half - t * 2 * half, half], [-half, half - t * 2 * half]][e];
      parts.push({ geo: buildBox(0.3, 0.16, 0.22), pos: [x, 0.08, -2.5 + z], rot: [0, R() * 0.6, 0], mat: MAT.white, tone: 0.65 + R() * 0.1 });
    }
    // The VEHICLE SHED against the right wall: posts, a lean-to of corrugated sheet falling to
    // the yard, drums and a spare tyre under it.
    {
      const x0 = hl - T - 0.1, x1 = hl - T - 3.6, z0 = -4.6, z1 = 2.6, yHi = 3.0, yLo = 2.3;
      for (const z of [z0 + 0.1, (z0 + z1) / 2, z1 - 0.1]) parts.push({ geo: buildBox(0.14, yLo, 0.14), pos: [x1 + 0.1, yLo / 2, z], mat: MAT.timber, tone: 0.3 });
      parts.push({ geo: buildBox(0.16, 0.16, z1 - z0), pos: [x1 + 0.1, yLo + 0.08, (z0 + z1) / 2], mat: MAT.timber, tone: 0.28 });
      const run = x0 - x1, ang = Math.atan2(yHi - yLo, run), slope = Math.hypot(run, yHi - yLo) + 0.3;
      const sheet = buildCorrugatedPanel({ width: z1 - z0 + 0.3, height: slope, thickness: 0.022, ribs: 14, ribDepth: 0.03 });
      // The panel stands in XY (width x, length y, ribs in z): width along the wall (Z), its
      // length rising from the yard to the wall (+X), its face up.
      const c = Math.cos(ang), sn = Math.sin(ang);
      sheet.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(c, sn, 0), new THREE.Vector3(-sn, c, 0)));
      // (The panel runs 0 → length from its origin: start it at the low eave, over the posts.)
      parts.push({ geo: sheet, pos: [x1 - 0.15 * c, yLo + 0.16 - 0.15 * sn, (z0 + z1) / 2], mat: MAT.metal, tone: 0.45 });
      for (let k = 0; k < 4; k++) parts.push({ geo: buildOilDrum({}), pos: [hl - T - 0.6, 0, z0 + 0.6 + k * 0.62], rot: [0, R() * 3, 0], mat: MAT.paint, tone: 0.3 + R() * 0.3 });
      parts.push({ geo: new THREE.TorusGeometry(0.36, 0.13, 8, 16), pos: [hl - T - 1.6, 0.13, z1 - 1.2], rot: [Math.PI / 2, 0, 0], mat: MAT.rubber, tone: 0.4 });
    }
    // A SQUAD TENT beside it: canvas walls, a pyramid roof, the door flap rolled.
    {
      const tx = 3.2, tz = -0.6, tw = 3.6, th = 1.1;
      parts.push({ geo: buildBox(tw, th, tw), pos: [tx, th / 2, tz], mat: MAT.canvas, tone: 0.45 });
      const roof = new THREE.CylinderGeometry(0.08, (tw / 2) * Math.SQRT2 + 0.2, 1.7, 4, 1).rotateY(Math.PI / 4);
      const uv = roof.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i) * 1.2);
      parts.push({ geo: indexed(roof), pos: [tx, th + 0.85, tz], mat: MAT.canvas, tone: 0.5 });
      parts.push({ geo: buildBox(1.0, 0.95, 0.04), pos: [tx, 0.48, tz - tw / 2 - 0.03], mat: MAT.steel, tone: 0.05 });   // the open door
      parts.push({ geo: new THREE.CylinderGeometry(0.1, 0.1, 1.0, 8).rotateZ(Math.PI / 2), pos: [tx, 1.0, tz - tw / 2 - 0.08], mat: MAT.canvas, tone: 0.35 });
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push(wirePart([tx + sx * tw / 2, th, tz + sz * tw / 2], [tx + sx * (tw / 2 + 0.9), 0, tz + sz * (tw / 2 + 0.9)], 0.012, { mat: MAT.hessian, tone: 0.4 }));
    }
    // The MORTAR PIT: a ring of sandbags, the tube on its baseplate pointing out, bombs boxed.
    {
      const mx = -2.6, mz = 1.4;
      parts.push({ geo: buildSandbagRing({ radius: 1.5, courses: 3, seed: seed + 11, gapDeg: 70 }), pos: [mx, 0, mz], mat: null });
      parts.push({ geo: buildBox(0.5, 0.06, 0.5), pos: [mx, 0.03, mz], mat: MAT.steel, tone: 0.2 });
      parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 1.2, 8), pos: [mx, 0.6, mz + 0.2], rot: [0.75, 0, 0], mat: MAT.steel, tone: 0.15 });
      for (const sx of [-1, 1]) parts.push(wirePart([mx, 0.75, mz + 0.35], [mx + sx * 0.32, 0, mz + 0.65], 0.02, { tone: 0.3 }));
      for (let k = 0; k < 3; k++) parts.push({ geo: buildBox(0.5, 0.18, 0.3), pos: [mx + 0.6, 0.09 + k * 0.18, mz - 0.5], rot: [0, R() * 0.3, 0], mat: MAT.paint, tone: 0.3 + R() * 0.1 });
    }
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
    if (detail >= 2) {
      // WEATHER (detail 2): dust thrown up the foot of every outer wall, over the footing, and
      // grime washed down from the coping in streaks. The faces' local frame as above.
      for (const f of faces) {
        for (let t = -L / 2 + 2.8; t < L / 2 - 2.4; t += 4.3) {
          if (f.avoid?.(t)) continue;
          const [x, z] = f.at(t);
          st.push(stencilPatch("wallFootDust", flatSurface([x + f.n[0] * 0.014, 1.32, z + f.n[2] * 0.014], f.n, f.r, 4.6, "wallFootDust"), { lift: 0.003 }));
        }
        for (let k = 0; k < 6; k++) {
          const t = (R() - 0.5) * (L - 12);
          if (f.avoid?.(t)) continue;
          const [x, z] = f.at(t), cell = R() < 0.5 ? "rainStreakA" : "rainStreakB";
          st.push(stencilPatch(cell, flatSurface([x + f.n[0] * 0.016, H - 0.55, z + f.n[2] * 0.016], f.n, f.r, 0.55 + R() * 0.3, cell), { lift: 0.0035 }));
        }
      }
    }
    if (detail >= 2) {
      // The TOWERS: grime under the corbel on their outer faces, dust above the talus.
      for (const [tx, tz] of [[-hl + TW / 2 - 1.0, -hl + TW / 2 - 1.0], [hl - TW / 2 + 1.0, hl - TW / 2 + 1.0]]) {
        const sx = Math.sign(tx), sz = Math.sign(tz);
        for (const [n, r, c] of [[[sx, 0, 0], [0, 0, -sx], (o) => [tx + sx * (TW / 2 + 0.016), tz + o]], [[0, 0, sz], [sz, 0, 0], (o) => [tx + o, tz + sz * (TW / 2 + 0.016)]]]) {
          for (const o of [-1.4, 0.3, 1.6]) {
            const [px, pz] = c(o + (R() - 0.5) * 0.6), cell = R() < 0.5 ? "rainStreakA" : "rainStreakB";
            st.push(stencilPatch(cell, flatSurface([px, TH - 0.75, pz], n, r, 0.6 + R() * 0.3, cell), { lift: 0.0035 }));
          }
          const [qx, qz] = c(0);
          st.push(stencilPatch("wallFootDust", flatSurface([qx, 2.15, qz], n, r, TW - 0.1, "wallFootDust"), { lift: 0.003 }));
        }
      }
      // The BLOCKS in the yard: dust up their feet on every face.
      for (const b of [{ x: 1.5, z: hl - T - 3.4, w: 14, d: 6 }, { x: -hl + T + 3.3, z: -0.4, w: 6, d: 8 }]) {
        const faces2 = [
          { n: [0, 0, -1], r: [-1, 0, 0], len: b.w, at: (t) => [b.x + t, b.z - b.d / 2 - 0.014] },
          { n: [0, 0, 1], r: [1, 0, 0], len: b.w, at: (t) => [b.x + t, b.z + b.d / 2 + 0.014] },
          { n: [-1, 0, 0], r: [0, 0, 1], len: b.d, at: (t) => [b.x - b.w / 2 - 0.014, b.z + t] },
          { n: [1, 0, 0], r: [0, 0, -1], len: b.d, at: (t) => [b.x + b.w / 2 + 0.014, b.z + t] },
        ];
        for (const f of faces2) {
          const n2 = Math.max(1, Math.round(f.len / 3.4)), wd = f.len / n2;
          for (let k = 0; k < n2; k++) {
            const [px, pz] = f.at(-f.len / 2 + wd * (k + 0.5));
            st.push(stencilPatch("wallFootDust", flatSurface([px, 0.95, pz], f.n, f.r, wd + 0.04, "wallFootDust"), { lift: 0.003 + k * 0.0002 }));
          }
        }
      }
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
