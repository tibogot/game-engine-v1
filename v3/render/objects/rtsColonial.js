/**
 * THE FRENCH COLONIAL HQ — the enemy's headquarters: a provincial résidence
 * from the 1920s, two storeys of ochre limewashed stucco under a red-tiled
 * hipped roof, taken over by the Front.
 *
 * What makes it read from the RTS camera, in order: the red HIPPED ROOF (you
 * see the roof first — no American building in the game has one), the ochre
 * walls with white trim, the arcade of the veranda and the loggia over it. The
 * pediment carries the NLF's star; the banner hangs from the loggia.
 *
 * What makes it the enemy's, not a postcard: thirty years of war. A shell has
 * gone through the roof at the front corner (dark hole, broken rafters, tiles
 * down on the veranda), the stucco is flaked and pocked with bullet strikes
 * (the texture), sandbags fill two of the arches, and cut palm mats are laid
 * over the back of the roof against aircraft.
 *
 * Same contract as the rest of the kit: real size x 1.3, one merged geometry
 * on the atlas material (origin at the ground centre, on y = 0), markings in
 * `userData.stencil`, `userData.footprint` for its pad and nav. The FRONT (the
 * arcade, the door) faces -Z.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, buildSandbagWall, rng } from "./rtsParts.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";

const S = 1.3;

/** Indexed (mergeGeometries needs every input indexed or none). */
function indexed(g) {
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  return g;
}

/**
 * A wall with ARCHED openings down to its foot, as one outline (an opening
 * cut to the bottom edge cannot be a hole — earcut refuses a hole that touches
 * the outline). Shape in XY, x centred, y up from 0; extruded `t` along +Z.
 * `openings`: [{ cx, w, spring }] — spring = the height the arch starts at.
 * UVs in metres / 2, like the kit.
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
  const g = indexed(new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 12 }));
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / 2);
  return g;
}

/**
 * A hipped roof over a w x d rectangle, eaves at y = 0, all four slopes at the
 * same pitch (so the ridge runs along the long side, w - d long). UVs: u along
 * the eave, v up the slope, metres / 2 — the tile courses follow the eaves.
 */
function hipRoof(w, d, rise) {
  const hx = w / 2, hz = d / 2, rl = Math.max(0, hx - hz);
  const A = [-hx, 0, -hz], B = [hx, 0, -hz], C = [hx, 0, hz], D = [-hx, 0, hz];
  const R1 = [-rl, rise, 0], R2 = [rl, rise, 0];
  const pos = [], nrm = [], uvs = [], idx = [];
  const v3 = (p) => new THREE.Vector3(...p);
  // One slope: its eave edge e0→e1 and the rest of its outline; `out` points outward.
  const face = (pts, e0, e1, out) => {
    const E0 = v3(e0), e = v3(e1).sub(E0).normalize();
    const n = v3(pts[1]).sub(v3(pts[0])).cross(v3(pts[2]).sub(v3(pts[0]))).normalize();
    if (n.dot(out) < 0) { pts = [...pts].reverse(); n.negate(); }
    const up = new THREE.Vector3().crossVectors(n, e).normalize();
    if (up.y < 0) up.negate();
    const base = pos.length / 3;
    for (const p of pts) {
      const P = v3(p);
      pos.push(P.x, P.y, P.z);
      nrm.push(n.x, n.y, n.z);
      const q = P.clone().sub(E0);
      uvs.push(q.dot(e) / 2, q.dot(up) / 2);
    }
    for (let k = 1; k < pts.length - 1; k++) idx.push(base, base + k, base + k + 1);
  };
  face([A, B, R2, R1], A, B, new THREE.Vector3(0, 1, -1));
  face([C, D, R1, R2], D, C, new THREE.Vector3(0, 1, 1));
  face([B, C, R2], B, C, new THREE.Vector3(1, 1, 0));
  face([D, A, R1], A, D, new THREE.Vector3(-1, 1, 0));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** A box laid from a to b (w x h across it) — ridge caps, hips, rafters. */
function beam(a, b, w, h) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const dir = B.clone().sub(A);
  const len = dir.length();
  const g = buildBox(w, h, len);
  const m = new THREE.Matrix4().compose(
    A.clone().add(B).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize()),
    new THREE.Vector3(1, 1, 1),
  );
  return { geo: g, matrix: m };
}

/**
 * A tall French window on a wall face: the dark opening, the white stucco
 * surround and sill, the green louvred shutters folded back against the wall
 * (one of them sometimes hanging off a hinge, or gone). `o` is the point on
 * the wall's outer face at the foot of the window, `n` the face's outward
 * normal. Boxes are laid in the face's own frame.
 */
function windowParts(parts, o, n, w, h, R, { door = false } = {}) {
  const N = new THREE.Vector3(...n).normalize();
  const U = new THREE.Vector3(0, 1, 0);
  const Rt = new THREE.Vector3().crossVectors(U, N).normalize();
  const O = new THREE.Vector3(...o);
  // `back`: how far off the wall the piece's back face sits. Every piece its
  // own, or the backs pressed to the wall are coplanar with each other.
  const put = (w_, h_, d_, lx, ly, back, mat, tone, roll = 0) => {
    const m = new THREE.Matrix4().makeBasis(Rt, U, N);
    if (roll) m.multiply(new THREE.Matrix4().makeRotationZ(roll));
    m.setPosition(O.clone().addScaledVector(Rt, lx).addScaledVector(U, ly).addScaledVector(N, back + d_ / 2));
    parts.push({ geo: buildBox(w_, h_, d_), matrix: m, mat, tone });
  };
  // The opening: dark, a hair proud of the wall.
  put(w, h, 0.05, 0, h / 2, 0.004, door ? MAT.timber : MAT.steel, door ? 0.12 : 0.0);
  // Surround: lintel with a keystone, jambs, a sill that throws a shadow.
  put(w + 0.5, 0.26, 0.1, 0, h + 0.13, 0.016, MAT.white, 0.55);
  put(0.34, 0.34, 0.14, 0, h + 0.2, 0.022, MAT.white, 0.62);
  for (const sx of [-1, 1]) put(0.2, h, 0.08, sx * (w / 2 + 0.1), h / 2, 0.012, MAT.white, 0.5);
  if (!door) put(w + 0.44, 0.12, 0.24, 0, -0.02, 0.008, MAT.white, 0.45);
  if (door) return;
  // Shutters, folded back flat against the wall either side.
  for (const sx of [-1, 1]) {
    const r = R();
    if (r < 0.12) continue;                                    // gone
    const hang = r < 0.24 ? sx * 0.22 : 0;                     // off a hinge, askew
    put(w / 2, h * (hang ? 0.94 : 1), 0.05, sx * (w / 2 + 0.2 + w / 4), h / 2 - (hang ? 0.12 : 0), hang ? 0.03 : 0.01, MAT.paint, 0.55 + R() * 0.25, hang);
  }
}

export function buildColonialHQ({ seed = 1927 } = {}) {
  const R = rng(seed);
  const parts = [];
  const W = 16 * S, D = 10.5 * S, hx = W / 2, hz = D / 2;
  const plinthH = 0.6 * S, H1 = 4.1 * S, H2 = 3.7 * S;
  const f1 = plinthH, f2 = f1 + H1, wallTop = f2 + H2;
  const V = 2.5 * S, zc = -hz + V;          // veranda depth; the core's front wall
  const T = 0.45 * S;                        // wall thickness
  // Five bays across the arcade's OWN width (between the end walls): spaced on
  // the full width, the end arches ran 7 cm past the wall's outline.
  const bays = 5, inner = W - 2 * T, bay = inner / bays;
  const cxOf = (i) => -inner / 2 + bay * (i + 0.5);

  // ── Plinth and steps ──────────────────────────────────────────────────────
  parts.push({ geo: buildBox(W + 1.2, plinthH, D + 1.2), pos: [0, plinthH / 2, 0], mat: MAT.concrete, tone: 0.42 });
  for (let k = 0; k < 2; k++) {
    // Each step's back runs a different depth into the plinth (a shared back
    // face is a coplanar pair, hidden or not).
    const h = plinthH * (k + 1) / 3, dd = 0.4 * S * (2 - k) + 0.05 + k * 0.04;
    parts.push({ geo: buildBox(4.6 * S - k * 0.3, h, dd), pos: [0, h / 2, -hz - 0.6 - (0.4 * S * (2 - k)) + dd / 2], mat: MAT.concrete, tone: 0.38 + k * 0.05 });
  }

  // ── The core: the house behind the veranda ────────────────────────────────
  // Its top stops just under the cornice's underside, its foot just under the
  // plinth's top, each at a depth nothing else shares.
  parts.push({ geo: buildBox(W, wallTop - f1 + 0.06, hz - zc), pos: [0, f1 - 0.08 + (wallTop - f1 + 0.06) / 2, (zc + hz) / 2], mat: MAT.stucco, tone: 0.5 });

  // ── Ground-floor arcade (front) and its two end walls ─────────────────────
  // The front arcade fits BETWEEN the end walls (W - 2T): run the full width
  // and its ends lie in the end walls' outer faces. The storeys meet at the
  // floor band (f2) without overlapping.
  const gArch = { w: 2.9, spring: 2.5 * S };           // piers: ~0.5 m at the ends, ~1 m between
  parts.push({ geo: archWall(W - 2 * T, H1 + 0.05, T, Array.from({ length: bays }, (_, i) => ({ cx: cxOf(i), ...gArch }))), pos: [0, f1 - 0.05, -hz], mat: MAT.stucco, tone: 0.55 });
  for (const sx of [-1, 1]) {
    parts.push({ geo: archWall(V, H1 + 0.05, T, [{ cx: 0, w: 1.9 * S, spring: 2.4 * S }]), pos: [sx * hx, f1 - 0.05, (-hz + zc) / 2], rot: [0, -sx * Math.PI / 2, 0], mat: MAT.stucco, tone: 0.52 });
  }

  // ── Upper loggia: arches over a balustrade ────────────────────────────────
  const uArch = { w: 2.5, spring: 2.3 * S };
  parts.push({ geo: archWall(W - 2 * T, H2, T, Array.from({ length: bays }, (_, i) => ({ cx: cxOf(i), ...uArch }))), pos: [0, f2, -hz], mat: MAT.stucco, tone: 0.58 });
  for (const sx of [-1, 1]) {
    parts.push({ geo: archWall(V, H2, T, [{ cx: 0, w: 1.6 * S, spring: 2.2 * S }]), pos: [sx * hx, f2, (-hz + zc) / 2], rot: [0, -sx * Math.PI / 2, 0], mat: MAT.stucco, tone: 0.55 });
  }
  const bandH = 0.42;
  const parapetH = 1.0 * S;
  for (let i = 0; i < bays; i++) {
    parts.push({ geo: buildBox(uArch.w - 0.04, parapetH, T * 0.7), pos: [cxOf(i), f2 + bandH / 2 - 0.02 + parapetH / 2, -hz + T / 2], mat: MAT.stucco, tone: 0.6 });
    parts.push({ geo: buildBox(uArch.w + 0.06, 0.12, T * 0.95), pos: [cxOf(i), f2 + bandH / 2 - 0.02 + parapetH + 0.06, -hz + T / 2], mat: MAT.white, tone: 0.5 });
  }

  // ── Trim: the floor band between storeys, the cornice, corner pilasters ──
  parts.push({ geo: buildBox(W + 0.3, bandH, D + 0.3), pos: [0, f2, 0], mat: MAT.white, tone: 0.5 });
  parts.push({ geo: buildBox(W + 0.7, 0.5, D + 0.7), pos: [0, wallTop + 0.2, 0], mat: MAT.white, tone: 0.55 });
  parts.push({ geo: buildBox(W + 1.1, 0.18, D + 1.1), pos: [0, wallTop + 0.54, 0], mat: MAT.white, tone: 0.42 });
  const eaveY = wallTop + 0.63;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    // Foot 2 cm into the plinth, top 5 cm under the cornice: depths nothing else uses.
    const ph_ = wallTop - f1 - 0.03;
    parts.push({ geo: buildBox(0.9, ph_, 0.9), pos: [sx * (hx - 0.35), f1 - 0.02 + ph_ / 2, sz * (hz - 0.35)], mat: MAT.white, tone: 0.48 });
  }

  // ── Windows and the door ──────────────────────────────────────────────────
  // The veranda's back wall (the core's front), both floors.
  for (let i = 0; i < bays; i++) {
    if (i === 2) windowParts(parts, [0, f1, zc], [0, 0, -1], 2.0 * S * 0.8, 3.2, R, { door: true });
    else windowParts(parts, [cxOf(i), f1 + 0.1, zc], [0, 0, -1], 1.4, 2.9, R);
    windowParts(parts, [cxOf(i), f2 + bandH / 2 + 0.1, zc], [0, 0, -1], 1.4, 2.7, R);
  }
  // The back.
  for (let i = 0; i < bays; i++) {
    windowParts(parts, [cxOf(i), f1 + 0.9, hz], [0, 0, 1], 1.3, 2.4, R);
    windowParts(parts, [cxOf(i), f2 + bandH / 2 + 0.7, hz], [0, 0, 1], 1.3, 2.4, R);
  }
  // The ends: three windows a floor along the core.
  for (const sx of [-1, 1]) for (let k = 0; k < 3; k++) {
    const z = zc + ((hz - zc) * (k + 0.5)) / 3;
    windowParts(parts, [sx * hx, f1 + 0.9, z], [sx, 0, 0], 1.3, 2.4, R);
    windowParts(parts, [sx * hx, f2 + bandH / 2 + 0.7, z], [sx, 0, 0], 1.3, 2.4, R);
  }

  // ── The roof ──────────────────────────────────────────────────────────────
  const ov = 0.9;
  const rw = W + 2 * ov, rd = D + 2 * ov;
  const pitch = (28 * Math.PI) / 180;
  const rise = (rd / 2) * Math.tan(pitch);
  parts.push({ geo: hipRoof(rw, rd, rise), pos: [0, eaveY, 0], mat: MAT.tile, tone: 0.5 });
  // Fascia round the eaves: the roof's edge thickness, seen from the camera's angle.
  parts.push({ geo: buildBox(rw + 0.08, 0.22, 0.08), pos: [0, eaveY - 0.1, -rd / 2], mat: MAT.timber, tone: 0.2 });
  parts.push({ geo: buildBox(rw + 0.08, 0.22, 0.08), pos: [0, eaveY - 0.1, rd / 2], mat: MAT.timber, tone: 0.2 });
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.08, 0.22, rd), pos: [sx * rw / 2, eaveY - 0.1, 0], mat: MAT.timber, tone: 0.2 });
  // A soffit under the overhang, so the eaves are not see-through from below.
  parts.push({ geo: buildBox(rw, 0.06, rd), pos: [0, eaveY - 0.2, 0], mat: MAT.white, tone: 0.3 });
  // Ridge and hip caps: rounded ridge tiles, a little darker.
  const rl = Math.max(0, rw / 2 - rd / 2);
  const ridgeY = eaveY + rise;
  const capW = 0.38, capH = 0.22;
  parts.push({ ...beam([-rl, ridgeY + 0.06, 0], [rl, ridgeY + 0.06, 0], capW, capH), mat: MAT.tile, tone: 0.3 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push({ ...beam([sx * rw / 2, eaveY + 0.06, sz * rd / 2], [sx * rl, ridgeY + 0.06, 0], capW, capH), mat: MAT.tile, tone: 0.3 });
  }
  /** Height of the roof surface at (x, z), and its slope, for things laid on it. */
  const roofY = (x, z) => eaveY + rise * Math.min((rd / 2 - Math.abs(z)) / (rd / 2), (rw / 2 - Math.abs(x)) / (rd / 2));

  // Chimneys through the back slope.
  for (const sx of [-1, 1]) {
    const x = sx * hx * 0.55, z = 1.9 * S;
    const top = ridgeY + 0.9;
    const base = roofY(x, z) - 0.3;
    parts.push({ geo: buildBox(1.1, top - base, 1.1), pos: [x, base + (top - base) / 2, z], mat: MAT.stucco, tone: 0.45 });
    parts.push({ geo: buildBox(1.4, 0.2, 1.4), pos: [x, top + 0.1, z], mat: MAT.white, tone: 0.4 });
    parts.push({ geo: buildBox(0.7, 0.3, 0.7), pos: [x, top + 0.35, z], mat: MAT.metal, tone: 0.1 });
  }

  // ── The pediment over the centre bay, with the Front's star on it ─────────
  // pz: in front of the upper cornice's face (at -hz - 0.55), not in it.
  const pw = 7.2 * S * 0.8, ph = 2.5 * S * 0.8, pz = -hz - 0.62, pT = 0.6;
  {
    const tri = new THREE.Shape([new THREE.Vector2(-pw / 2, 0), new THREE.Vector2(pw / 2, 0), new THREE.Vector2(0, ph)]);
    const g = indexed(new THREE.ExtrudeGeometry(tri, { depth: pT, bevelEnabled: false }));
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / 2);
    parts.push({ geo: g, pos: [0, eaveY - 0.12, pz], mat: MAT.stucco, tone: 0.6 });
    // Raking cornices and the base.
    const lift = 0.12;
    for (const sx of [-1, 1]) {
      parts.push({ ...beam([sx * (pw / 2 + 0.25), eaveY - 0.12 + lift, pz - 0.12], [0, eaveY - 0.12 + ph + lift + 0.18, pz - 0.12], 0.3, 0.3), mat: MAT.white, tone: 0.55 });
    }
    parts.push({ geo: buildBox(pw + 0.5, 0.26, pT + 0.3), pos: [0, eaveY - 0.12, pz + pT / 2], mat: MAT.white, tone: 0.5 });
  }

  // ── What the war has done to it ───────────────────────────────────────────
  // The shell hole: a dark gap in the front slope at the right, the rafters
  // broken across it, loose tiles round the rim and fallen on the veranda.
  {
    const x = hx * 0.55, z = -hz * 0.3;
    const y = roofY(x, z);
    const a = Math.atan(rise / (rd / 2));
    parts.push({ geo: buildBox(3.0, 0.06, 2.3), pos: [x, y + 0.04, z], rot: [-a, 0, 0], mat: MAT.steel, tone: 0.0 });
    for (let k = 0; k < 3; k++) {
      const rx = x - 0.9 + k * 0.9 + (R() - 0.5) * 0.2;
      parts.push({ geo: buildBox(0.16, 0.16, 2.4 - k * 0.5), pos: [rx, y + 0.12 + k * 0.03, z - 0.15 + k * 0.1], rot: [-a + (R() - 0.5) * 0.4, (R() - 0.5) * 0.3, (R() - 0.5) * 0.3], mat: MAT.timber, tone: 0.1 });
    }
    for (let k = 0; k < 7; k++) {
      const ang = (k / 7) * Math.PI * 2;
      const tx = x + Math.cos(ang) * 1.7, tz = z + Math.sin(ang) * 1.3;
      parts.push({ geo: buildBox(0.5, 0.08, 0.35), pos: [tx, roofY(tx, tz) + 0.1, tz], rot: [-a + (R() - 0.5) * 0.6, R() * 3, (R() - 0.5) * 0.6], mat: MAT.tile, tone: 0.4 + R() * 0.2 });
    }
    // Fallen tiles and plaster on the veranda floor below it.
    for (let k = 0; k < 9; k++) {
      parts.push({ geo: buildBox(0.4 + R() * 0.3, 0.07, 0.3), pos: [x - 1.5 + R() * 3, f1 + 0.04, -hz + 0.7 + R() * (V - 1.2)], rot: [(R() - 0.5) * 0.3, R() * 3, (R() - 0.5) * 0.3], mat: k % 3 ? MAT.tile : MAT.stucco, tone: 0.3 + R() * 0.3 });
    }
  }
  // Cut palm mats over the back slope, against aircraft.
  {
    const a = Math.atan(rise / (rd / 2));
    for (let k = 0; k < 6; k++) {
      const x = -hx * 0.75 + R() * hx * 1.3, z = 1.2 + R() * (rd / 2 - 2.6);
      // Each a little higher than the last: overlapping mats at one height are coplanar.
      parts.push({ geo: buildBox(2.6 + R(), 0.08, 1.5 + R() * 0.5), pos: [x, roofY(x, z) + 0.08 + k * 0.03, z], rot: [a, (R() - 0.5) * 0.5, 0], mat: MAT.thatch, tone: 0.3 + R() * 0.4 });
    }
  }
  // Sandbags filling the two end arches of the arcade: firing positions.
  const bag = { length: 0.52 * S, width: 0.30 * S, height: 0.19 * S, segU: 6, segV: 4 };
  for (const i of [0, bays - 1]) {
    parts.push({ geo: buildSandbagWall({ length: gArch.w + 0.4, courses: 5, seed: seed + i, bag, batter: 0.04 }), pos: [cxOf(i), f1, -hz - 0.42], mat: null });
  }
  // And two fighting positions flanking the steps, on the ground.
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildSandbagWall({ length: 3.2 * S, courses: 4, seed: seed + 20 + sx, bag, batter: 0.05 }), pos: [sx * 4.8 * S, 0, -hz - 3.2 * S], rot: [0, sx * 0.25, 0], mat: null });
  }

  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.32, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5 });

  // ── Markings ──────────────────────────────────────────────────────────────
  const st = [];
  // The Front's banner, hung from the centre bay of the loggia over the arch below.
  st.push(stencilPatch("nlfBanner", flatSurface([0, f2 - 0.1, -hz - 0.24], [0, 0, -1], [-1, 0, 0], 3.3 * S, "nlfBanner"), { lift: 0.004 }));
  // The star on the pediment, where the République's oculus was.
  st.push(stencilPatch("nlfStar", flatSurface([0, eaveY - 0.12 + ph * 0.45, pz], [0, 0, -1], [-1, 0, 0], 1.45 * S, "nlfStar"), { lift: 0.01 }));
  geo.userData.stencil = mergeStencils(st);

  geo.userData.footprint = { cx: 0, cz: -0.6, hx: hx + 0.9, hz: hz + 1.6 };
  geo.userData.height = ridgeY + 1.3;
  geo.userData.size = { W, D, eaveY, ridgeY, wallTop };
  return geo;
}
