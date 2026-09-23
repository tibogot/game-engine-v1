/**
 * THE KHMER RUINS — a temple in the jungle, eight hundred years abandoned.
 *
 * Apocalypse Now's compound, and the thing that most makes a map feel like
 * that border country: a tower with faces on it, a gallery whose roof has come
 * down, a nāga balustrade along the causeway, and a strangler fig eating all
 * of it.
 *
 * HOW THIS IS BUILT, AND WHY IT IS NOT BUILT THE OBVIOUS WAY.
 *
 * The first attempt stacked the whole temple out of blocks, one box per stone.
 * It read as Lego, and no amount of chipping the corners fixed it, because the
 * thing that makes this architecture legible is not its blocks — it is its
 * MOULDINGS. Every plinth, string course, cornice and door frame is a carved
 * PROFILE swept round the building, and those profiles are what throw the
 * bands of light and shadow you recognise from a hundred metres away.
 *
 * So the forms here are swept profiles (`mouldedRing`, `mouldedRun`), the
 * carved parts are lathes and shaped solids, and loose stone — fallen blocks,
 * rubble, the gap-toothed top of a broken wall — is where the chipped
 * `stoneBlock` still earns its place. Coursing is a few millimetres of step in
 * the profile rather than a hundred separate boxes.
 *
 * Then the ruin, which is half the subject: blocks out of the top courses, a
 * collapsed gallery roof lying in the passage, a lintel down in the doorway,
 * moss on everything that has not moved, saplings in the cracks, and the fig.
 *
 * Same contract as the rest of the kit: one merged geometry on the atlas
 * material, origin at the ground centre on y = 0, `userData.footprint`.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, rng } from "./rtsParts.js";

/**
 * Temple stone is drawn at the kit's 1.3 like everything man-made, and the
 * BUILDING is scaled further (1.6, as the village houses are): a real prasat
 * is 12 m and reads small from the RTS camera beside a 2.3 m soldier.
 */
const B = 1.6;

/** Sandstone unless told otherwise; moss and laterite are accents, not a mix. */
function stoneOf(r, { moss = 0.09, laterite = 0.05 } = {}) {
  const k = r();
  if (k < moss) return { mat: MAT.moss, tone: 0.34 + r() * 0.3 };
  if (k < moss + laterite) return { mat: MAT.laterite, tone: 0.38 + r() * 0.24 };
  return { mat: MAT.sandstone, tone: 0.4 + r() * 0.26 };
}

/** Deterministic hash of a POSITION — the same corner always moves the same way. */
function hash3(x, y, z, salt = 0) {
  let n = Math.imul((x * 997) | 0, 374761393) ^ Math.imul((y * 997) | 0, 668265263)
    ^ Math.imul(((z * 997) | 0) + salt * 7919, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** A trivial index, so a flat-shaded build survives mergeGeometries. */
function indexed(geo) {
  if (geo.index) return geo;
  const n = geo.attributes.position.count;
  geo.setIndex(Array.from({ length: n }, (_, i) => i));
  return geo;
}

/**
 * ONE LOOSE STONE: chamfered, irregular, its top dished where the rain sits.
 * For fallen blocks and rubble — the standing work is mouldings now.
 *
 * The displacement is keyed to the vertex POSITION, not to a counter: a box's
 * corner is three separate vertices, one per face, and they have to move
 * together or the block splits open along its seams. UVs in metres ÷ 2, the
 * kit's convention — left at the box's own 0..1 every stone samples the whole
 * texture cell and a wall of them reads as mottled little bricks.
 */
function stoneBlock(w, h, d, seed = 1, { chip = 0.2, wear = 0.055, sag = 0.5 } = {}) {
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const uv = g.attributes.uv;
  const span = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const seen = new Set();
  for (const grp of g.groups) {
    const [ua, vb] = span[grp.materialIndex];
    for (let k = grp.start; k < grp.start + grp.count; k++) {
      const vi = g.index.getX(k);
      if (seen.has(vi)) continue;
      seen.add(vi);
      uv.setXY(vi, (uv.getX(vi) * ua) / 2, (uv.getY(vi) * vb) / 2);
    }
  }
  g.clearGroups();
  const p = g.attributes.position;
  const hx = w / 2, hy = h / 2, hz = d / 2, eps = 1e-5;
  for (let i = 0; i < p.count; i++) {
    const x0 = p.getX(i), y0 = p.getY(i), z0 = p.getZ(i);
    const ex = Math.abs(Math.abs(x0) - hx) < eps;
    const ey = Math.abs(Math.abs(y0) - hy) < eps;
    const ez = Math.abs(Math.abs(z0) - hz) < eps;
    const rank = (ex ? 1 : 0) + (ey ? 1 : 0) + (ez ? 1 : 0);
    const cut = rank === 3 ? chip : rank === 2 ? chip * 0.45 : 0;
    const j = (v, half, on, s) => on
      ? v - Math.sign(v) * (cut * half * (0.55 + hash3(x0, y0, z0, seed + s) * 0.9))
      : v;
    let x = j(x0, hx, ex, 1), y = j(y0, hy, ey, 2), z = j(z0, hz, ez, 3);
    const n = (s) => (hash3(x0, y0, z0, seed + s) - 0.5) * wear;
    x += n(11) * w; y += n(13) * h; z += n(17) * d;
    if (ey && y0 > 0 && rank === 1) y -= sag * wear * h;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

// ── Mouldings ────────────────────────────────────────────────────────────────
/**
 * One triangle, wound so that it FACES a given direction.
 *
 * Every hole this file has had came from guessing a winding: a swept band or a
 * cap whose triangles came out back-to-front is invisible, and an invisible
 * wall is a wall you see the jungle through. Here the normal is computed and
 * the order flipped if it points the wrong way, so it cannot be got wrong.
 */
function face(pos, uvs, a, b, c, ua, ub, uc, want) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const flip = (nx * want[0] + ny * want[1] + nz * want[2]) < 0;
  const [p, q, s] = flip ? [a, c, b] : [a, b, c];
  const [pu, qu, su] = flip ? [ua, uc, ub] : [ua, ub, uc];
  pos.push(...p, ...q, ...s);
  uvs.push(...pu, ...qu, ...su);
}

/**
 * Sweep a PROFILE around a rectangle — the moulded plinth, string course and
 * cornice that every Khmer mass is built up from.
 *
 * `profile` is [[out, y], …] from the bottom up, where `out` is how far that
 * point stands proud of the nominal face. Each pair of profile points makes a
 * band round all four sides; the corners mitre themselves because the ring is
 * the rectangle offset by `out`.
 *
 * CLOSED at both ends. A sweep on its own is a SURFACE — four bands of wall
 * with nothing on top and nothing behind them — and from the RTS camera, which
 * looks down, you see over the top of the band, into the mass, and straight
 * out through its far side, because that side is facing away and is culled.
 * The temple was see-through for exactly this reason. The caps make it a solid.
 *
 * Built FLAT-SHADED (every triangle its own vertices, then a trivial index): a
 * moulding whose normals are averaged round the corners goes soft, and soft is
 * the one thing carved stone is not.
 */
// capBottom defaults OFF: the underside of a mass is never seen — it sits on
// the ground or on the mass below — and capping it puts a face in the same
// plane as that one's top cap.
function mouldedRing(profile, { w, d, edge = 4, capTop = true, capBottom = false } = {}) {
  const pos = [], uvs = [];
  const loop = (out) => {
    const hw = w / 2 + out, hd = d / 2 + out;
    const pts = [];
    // Points along each side, so a long wall's UVs and lighting do not stretch.
    const push = (x0, z0, x1, z1) => {
      for (let i = 0; i < edge; i++) {
        const t = i / edge;
        pts.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
      }
    };
    push(-hw, -hd, hw, -hd);
    push(hw, -hd, hw, hd);
    push(hw, hd, -hw, hd);
    push(-hw, hd, -hw, -hd);
    pts.push([-hw, -hd]);
    return pts;
  };
  let run = 0;
  for (let k = 0; k < profile.length - 1; k++) {
    const [o0, y0] = profile[k], [o1, y1] = profile[k + 1];
    const a = loop(o0), b = loop(o1);
    const rise = Math.hypot(o1 - o0, y1 - y0);
    for (let i = 0; i < a.length - 1; i++) {
      const [ax, az] = a[i], [bx, bz] = a[i + 1];
      const [cx, cz] = b[i], [dx, dz] = b[i + 1];
      const seg = Math.hypot(bx - ax, bz - az);
      const u0 = run / 2, u1 = (run + seg) / 2;
      const v0 = y0 / 2, v1 = (y0 + rise) / 2;
      // Outward: away from the axis, and up the slope of the moulding.
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const want = [mx, (o1 < o0 ? 1 : 0.15) * Math.hypot(mx, mz) * 0.5, mz];
      face(pos, uvs, [ax, y0, az], [bx, y0, bz], [cx, y1, cz], [u0, v0], [u1, v0], [u0, v1], want);
      face(pos, uvs, [bx, y0, bz], [dx, y1, dz], [cx, y1, cz], [u1, v0], [u1, v1], [u0, v1], want);
      if (k === 0) run += seg;
    }
  }
  // The caps that make it a solid rather than a band of wall.
  const cap = (out, y, up) => {
    const ring = loop(out);
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[i + 1];
      face(pos, uvs, [0, y, 0], [ax, y, az], [bx, y, bz],
        [0, 0], [ax / 2, az / 2], [bx / 2, bz / 2], [0, up, 0]);
    }
  };
  if (capTop) cap(profile[profile.length - 1][0], profile[profile.length - 1][1], 1);
  if (capBottom) cap(profile[0][0], profile[0][1], -1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return indexed(g);
}

/** The same sweep along a straight RUN on X, for a wall that is not a ring. */
function mouldedRun(profile, { length, thick, edge = 6 } = {}) {
  const pos = [], uvs = [];
  const line = (out) => {
    const pts = [];
    for (let i = 0; i <= edge; i++) {
      const t = i / edge;
      pts.push([-length / 2 + length * t, thick / 2 + out]);
    }
    return pts;
  };
  for (let k = 0; k < profile.length - 1; k++) {
    const [o0, y0] = profile[k], [o1, y1] = profile[k + 1];
    const a = line(o0), b = line(o1);
    const rise = Math.hypot(o1 - o0, y1 - y0);
    for (let i = 0; i < a.length - 1; i++) {
      for (const s of [1, -1]) {
        const [ax, az] = [a[i][0], a[i][1] * s], [bx, bz] = [a[i + 1][0], a[i + 1][1] * s];
        const [cx, cz] = [b[i][0], b[i][1] * s], [dx, dz] = [b[i + 1][0], b[i + 1][1] * s];
        const u0 = (ax + length / 2) / 2, u1 = (bx + length / 2) / 2;
        const v0 = y0 / 2, v1 = (y0 + rise) / 2;
        const want = [0, o1 < o0 ? 0.6 : 0.1, s];
        face(pos, uvs, [ax, y0, az], [bx, y0, bz], [cx, y1, cz], [u0, v0], [u1, v0], [u0, v1], want);
        face(pos, uvs, [bx, y0, bz], [dx, y1, dz], [cx, y1, cz], [u1, v0], [u1, v1], [u0, v1], want);
      }
    }
    // The END faces, one per profile band: without them you look into the wall
    // from its end and out the far side.
    for (const ex of [-1, 1]) {
      const x = (ex * length) / 2;
      const z0 = thick / 2 + o0, z1 = thick / 2 + o1;
      face(pos, uvs, [x, y0, z0], [x, y0, -z0], [x, y1, z1],
        [z0, y0 / 2], [-z0, y0 / 2], [z1, y1 / 2], [ex, 0, 0]);
      face(pos, uvs, [x, y0, -z0], [x, y1, -z1], [x, y1, z1],
        [-z0, y0 / 2], [-z1, y1 / 2], [z1, y1 / 2], [ex, 0, 0]);
    }
  }
  // And the TOP, across the two faces of the last profile point.
  const top = profile[profile.length - 1];
  const tz = thick / 2 + top[0], ty = top[1];
  const tl = line(top[0]);
  for (let i = 0; i < tl.length - 1; i++) {
    const x0 = tl[i][0], x1 = tl[i + 1][0];
    face(pos, uvs, [x0, ty, tz], [x1, ty, tz], [x0, ty, -tz],
      [x0 / 2, tz], [x1 / 2, tz], [x0 / 2, -tz], [0, 1, 0]);
    face(pos, uvs, [x1, ty, tz], [x1, ty, -tz], [x0, ty, -tz],
      [x1 / 2, tz], [x1 / 2, -tz], [x0 / 2, -tz], [0, 1, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return indexed(g);
}

/**
 * THE PROFILES. Three shapes, and between them they carry the whole building.
 * `base` is the stepped plinth every mass stands on, `courses` the banded wall
 * above it (the steps ARE the coursing, at a millimetre or two — a hundred
 * separate blocks bought nothing but triangles), `cornice` the flared crown
 * that throws the deep shadow line under a tier.
 */
const PLINTH = (h) => [
  [0.00, 0], [0.30, 0.02], [0.30, h * 0.34], [0.20, h * 0.46], [0.22, h * 0.62],
  [0.30, h * 0.74], [0.28, h * 0.88], [0.10, h], [0.10, h * 1.02],
];
const CORNICE = (h) => [
  [0.02, 0], [0.16, h * 0.22], [0.30, h * 0.5], [0.33, h * 0.66],
  [0.24, h * 0.82], [0.06, h * 0.96], [0.0, h],
];
/** A banded wall: a shallow step every `course` metres, and a slight batter. */
function banded(height, { course = 0.62, batter = 0.05, step = 0.035 } = {}) {
  const out = [[0, 0]];
  const rows = Math.max(1, Math.round(height / course));
  const ch = height / rows;
  for (let i = 1; i <= rows; i++) {
    // Every course stands a good centimetre further back than the one below.
    // A wall does batter — and at the two millimetres this drifted by first, two
    // courses' faces land in the same plane and shimmer against each other.
    const back = -batter * i * ch * 0.5;
    out.push([back + step, (i - 0.12) * ch]);
    out.push([back, (i - 0.02) * ch]);
  }
  out.push([-batter * rows * ch * 0.5, height]);
  return out;
}

// ── Carved pieces ────────────────────────────────────────────────────────────
/** A turned colonette — the little baluster-columns that flank every doorway. */
function colonette(h, rad) {
  // Closed at the foot (a lathe is a surface, not a solid) but SUNK below its
  // seat: a cap level with the plinth it stands on is coplanar with it.
  const p = [new THREE.Vector2(0, -0.06)];
  const at = (t, r) => p.push(new THREE.Vector2(r * rad, t * h));
  at(0, 1.05); at(0.04, 1.05); at(0.06, 0.82); at(0.1, 0.9); at(0.14, 0.72);
  at(0.2, 0.78); at(0.26, 0.66); at(0.4, 0.62); at(0.55, 0.66); at(0.62, 0.8);
  at(0.66, 0.68); at(0.72, 0.62); at(0.8, 0.7); at(0.84, 0.9); at(0.88, 0.82);
  at(0.94, 1.02); at(1, 1.02); at(1, 0);
  return new THREE.LatheGeometry(p, 10);
}

/**
 * A CARVED LINTEL: the beam over a doorway, and in this architecture the most
 * worked stone in the building — a band of foliate relief with a figure at its
 * centre and volutes curling off each end. Suggested, not sculpted: at the RTS
 * camera what reads is the stepped band and the bulge in the middle.
 */
function carvedLintel(parts, { x, y, z, rotY, width, depth, seed }) {
  const r = rng(seed);
  const push = (geo, dx, dy, dz, mat = MAT.sandstone, tone = 0.44, rz = 0) => parts.push({
    geo, pos: [x + Math.cos(rotY) * dx, y + dy, z - Math.sin(rotY) * dx],
    rot: [0, rotY, rz], mat, tone,
  });
  push(buildBox(width, 0.34 * B, depth), 0, 0, 0, MAT.sandstone, 0.42);
  push(buildBox(width * 0.98, 0.1 * B, depth * 1.12), 0, -0.2 * B, 0, MAT.sandstone, 0.5);
  push(buildBox(width * 0.98, 0.09 * B, depth * 1.08), 0, 0.2 * B, 0, MAT.sandstone, 0.5);
  // The foliate band: a row of small blocks, each turned its own way.
  const n = Math.round(width / (0.24 * B));
  for (let i = 0; i < n; i++) {
    const t = -width / 2 + (i + 0.5) * (width / n);
    push(buildBox(width / n * 0.7, 0.16 * B, depth * 1.16), t, 0.02 * B, 0,
      MAT.sandstone, 0.32 + r() * 0.2, (r() - 0.5) * 0.12);
  }
  // The deity at the centre, and the volutes at the ends.
  push(new THREE.SphereGeometry(0.17 * B, 10, 8).scale(1, 1.25, 0.6), 0, 0.04 * B, 0, MAT.sandstone, 0.56);
  for (const s of [-1, 1]) {
    push(new THREE.TorusGeometry(0.16 * B, 0.06 * B, 6, 10, Math.PI * 1.4).rotateY(Math.PI / 2),
      s * width * 0.42, 0, 0, MAT.sandstone, 0.5);
  }
}

/**
 * A PEDIMENT: the flame-shaped tympanum over a doorway, stepped up in tiers
 * with a finial at its point. Half of them have lost their tips, which is the
 * silhouette everyone recognises.
 */
function pediment(parts, { x, y, z, rotY, width, seed, broken = false }) {
  const r = rng(seed);
  const tiers = broken ? 2 : 4;
  for (let k = 0; k < tiers; k++) {
    const t = k / 4;
    const w = width * (1 - t * 0.62);
    // Each tier BACK into the wall as well as up: stacked at one depth their
    // front faces are all in the same plane, nested, and they shimmer.
    const back = k * 0.055 * B;
    parts.push({
      geo: buildBox(w, 0.26 * B, (0.22 - k * 0.03) * B),
      pos: [x - Math.sin(rotY) * back, y + k * 0.25 * B, z - Math.cos(rotY) * back],
      rot: [0, rotY, (r() - 0.5) * 0.02], mat: MAT.sandstone, tone: 0.36 + r() * 0.2,
    });
    // The upturned horns at the ends of every tier — the flame of it.
    for (const s of [-1, 1]) {
      parts.push({
        geo: new THREE.ConeGeometry(0.09 * B, 0.3 * B, 5).rotateZ(-s * 0.55),
        pos: [x + Math.cos(rotY) * s * w * 0.5, y + k * 0.24 * B + 0.2 * B, z - Math.sin(rotY) * s * w * 0.5],
        rot: [0, rotY, 0], mat: MAT.sandstone, tone: 0.4 + r() * 0.2,
      });
    }
  }
  if (!broken) {
    parts.push({
      geo: new THREE.ConeGeometry(0.13 * B, 0.52 * B, 6),
      pos: [x, y + tiers * 0.24 * B + 0.2 * B, z], rot: [0, rotY, 0.03],
      mat: MAT.sandstone, tone: 0.44,
    });
  }
}

/**
 * THE FOUR FACES — the one thing anybody remembers about this architecture.
 * Built from spheres and lathes rather than blocks: a face wants to be SMOOTH
 * against all that banded stone, and the contrast is most of why it reads.
 * About 1.4 m across, so from the RTS camera it is a suggestion — which is the
 * right amount of face, and why the spheres are coarse: at the segment counts
 * this started with, four faces cost 6,300 triangles, nearly half the tower,
 * for detail that lands inside twenty pixels.
 */
function bayonFace(parts, { x, y, z, rotY, scale = 1, seed = 1 }) {
  const r = rng(seed);
  const s = scale * B;
  const c = Math.cos(rotY), sn = Math.sin(rotY);
  const at = (geo, dx, dy, dz, tone = 0.46, rot = null) => parts.push({
    geo,
    pos: [x + c * dx + sn * dz, y + dy, z - sn * dx + c * dz],
    rot: rot ?? [0, rotY, 0], mat: MAT.sandstone, tone,
  });
  // The head: a broad block of stone, softened, with the cheeks full.
  at(new THREE.SphereGeometry(0.46 * s, 10, 7).scale(1, 1.18, 0.92), 0, 0, 0, 0.44);
  // Brow ridge and the long eyelids under it, which do the smiling.
  at(new THREE.TorusGeometry(0.3 * s, 0.05 * s, 6, 12, Math.PI).rotateX(0.2), 0, 0.16 * s, 0.3 * s, 0.54);
  for (const sx of [-1, 1]) {
    at(new THREE.SphereGeometry(0.12 * s, 7, 5).scale(1.5, 0.5, 0.5), sx * 0.17 * s, 0.04 * s, 0.38 * s, 0.6);
    at(new THREE.SphereGeometry(0.1 * s, 6, 4).scale(1.4, 0.34, 0.4), sx * 0.17 * s, -0.02 * s, 0.4 * s, 0.24);
    // The ears, which on a Bayon face are enormous and hang to the jaw.
    at(new THREE.SphereGeometry(0.1 * s, 6, 5).scale(0.5, 1.5, 0.7), sx * 0.44 * s, -0.04 * s, 0.06 * s, 0.4);
  }
  // Nose, lips, chin.
  at(new THREE.SphereGeometry(0.1 * s, 7, 5).scale(0.8, 1.7, 1.1), 0, -0.04 * s, 0.4 * s, 0.5);
  at(new THREE.SphereGeometry(0.16 * s, 8, 5).scale(1.25, 0.42, 0.5), 0, -0.24 * s, 0.38 * s, 0.56);
  at(new THREE.SphereGeometry(0.13 * s, 7, 5).scale(1, 0.7, 0.6), 0, -0.4 * s, 0.3 * s, 0.42);
  // The crown: a stepped diadem and the lotus bud on top of it.
  at(new THREE.CylinderGeometry(0.42 * s, 0.46 * s, 0.14 * s, 9), 0, 0.42 * s, 0.02 * s, 0.5);
  at(new THREE.CylinderGeometry(0.3 * s, 0.4 * s, 0.16 * s, 9), 0, 0.54 * s, 0.02 * s, 0.46);
  at(new THREE.SphereGeometry(0.19 * s, 8, 6).scale(1, 1.5, 1), 0, 0.72 * s, 0.02 * s, 0.52);
  // A crack across the cheek, because none of them are whole.
  if (r() < 0.6) {
    at(buildBox(0.5 * s, 0.03 * s, 0.1 * s), 0.1 * s, -0.1 * s, 0.42 * s, 0.14, [0, rotY, 0.5]);
  }
}

// ── The fig ──────────────────────────────────────────────────────────────────
/**
 * A STRANGLER FIG over the stone — the picture everyone has of these ruins.
 * Pale roots pour over the wall top, split, and run down its face to the
 * ground, thickening as they go; a low crown of foliage sits above.
 *
 * Roots are tubes along Catmull-Rom curves rather than tapered cylinders: a
 * root that does not BEND is a pipe, and a pipe on a wall is scaffolding.
 */
export function buildFigRoots({ seed = 3, width = 5, height = 4, roots = 7 } = {}) {
  const r = rng(seed);
  const parts = [];
  for (let k = 0; k < roots; k++) {
    const x0 = (r() - 0.5) * width * 0.9;
    const rad = (0.1 + r() * 0.1) * B;
    const pts = [];
    // Over the top, down the face, then out along the ground.
    pts.push(new THREE.Vector3(x0 + (r() - 0.5) * 0.4, height + 0.3 * B, -0.5 * B - r() * 0.4));
    pts.push(new THREE.Vector3(x0, height + 0.05 * B, 0));
    const n = 3 + Math.floor(r() * 3);
    let x = x0, z = 0.18 * B;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      x += (r() - 0.5) * width * 0.22;
      z += (0.04 + r() * 0.05) * B;
      pts.push(new THREE.Vector3(x, height * (1 - t) * (1 - t * 0.1), z));
    }
    pts.push(new THREE.Vector3(x + (r() - 0.5) * 1.2, 0.06 * B, z + (0.5 + r() * 0.9) * B));
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.TubeGeometry(curve, 14, rad, 6, false);
    // Roots taper: thin over the wall, heavy where they meet the ground.
    const p = tube.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const t = Math.min(1, Math.max(0, 1 - y / (height + 0.4 * B)));
      const cx = curve.getPointAt(Math.min(1, Math.max(0, i / p.count)));
      p.setXYZ(i, cx.x + (p.getX(i) - cx.x) * (0.75 + t * 0.9),
        y, cx.z + (p.getZ(i) - cx.z) * (0.75 + t * 0.9));
    }
    tube.computeVertexNormals();
    parts.push({ geo: tube, mat: r() < 0.25 ? MAT.moss : MAT.timber, tone: 0.62 + r() * 0.3 });
  }
  // A few buttress flares where the roots reach the ground.
  for (let k = 0; k < 3; k++) {
    parts.push({
      geo: new THREE.ConeGeometry((0.3 + r() * 0.2) * B, (0.5 + r() * 0.4) * B, 7, 1, true).scale(1, 1, 0.5),
      pos: [(r() - 0.5) * width, 0.24 * B, (0.6 + r() * 0.8) * B],
      rot: [0.1, r() * 3, (r() - 0.5) * 0.3], mat: MAT.timber, tone: 0.6 + r() * 0.3,
    });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.2, radius: 2, strength: 0.35, groundFade: 0.3, floor: 0.55 });
  geo.userData.footprint = { cx: 0, cz: 0.8 * B, hx: width / 2, hz: 1.6 * B };
  geo.userData.height = height + 0.5 * B;
  return geo;
}

// ── The tower ────────────────────────────────────────────────────────────────
/**
 * A PRASAT, the tower over the sanctuary: a moulded plinth, a banded body with
 * a false door on three sides and the entrance on the fourth, then four or
 * five receding tiers each with its own cornice and corner antefixes, and the
 * faces looking out at the compass points from the top one.
 */
export function buildTempleTower({ seed = 3, tiers = 4, faces = true } = {}) {
  const r = rng(seed);
  const parts = [];
  const base = 3.4 * B, bodyH = 2.9 * B, plinthH = 0.9 * B;
  parts.push({ geo: mouldedRing(PLINTH(plinthH), { w: base + 1.1 * B, d: base + 1.1 * B }), mat: MAT.laterite, tone: 0.4 + r() * 0.16 });
  const y0 = plinthH;
  parts.push({ geo: mouldedRing(banded(bodyH), { w: base, d: base }).translate(0, y0, 0), mat: MAT.sandstone, tone: 0.44 + r() * 0.16 });
  parts.push({ geo: mouldedRing(CORNICE(0.7 * B), { w: base - 0.1, d: base - 0.1 }).translate(0, y0 + bodyH, 0), mat: MAT.sandstone, tone: 0.4 + r() * 0.16 });

  // The doorway on -Z, false doors on the other three faces.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const px = Math.sin(a) * base / 2, pz = Math.cos(a) * base / 2;
    const doorW = 1.0 * B, doorH = 2.0 * B;
    if (i === 2) {
      // The real opening: a dark corbelled passage with its frame and lintel.
      parts.push({ geo: buildBox(doorW, doorH, 0.5 * B), pos: [px, y0 + doorH / 2, pz], rot: [0, a, 0], mat: MAT.steel, tone: 0.02 });
      for (const s of [-1, 1]) {
        parts.push({
          geo: buildBox(0.2 * B, doorH + 0.2 * B, 0.3 * B),
          pos: [px + Math.cos(a) * s * (doorW / 2 + 0.1 * B), y0 + (doorH + 0.2 * B) / 2, pz - Math.sin(a) * s * (doorW / 2 + 0.1 * B)],
          rot: [0, a, 0], mat: MAT.sandstone, tone: 0.46,
        });
        parts.push({
          geo: colonette(doorH * 0.92, 0.12 * B),
          pos: [px + Math.cos(a) * s * (doorW / 2 + 0.26 * B) + Math.sin(a) * 0.16 * B,
            y0, pz - Math.sin(a) * s * (doorW / 2 + 0.26 * B) + Math.cos(a) * 0.16 * B],
          mat: MAT.sandstone, tone: 0.5 + r() * 0.2,
        });
      }
      carvedLintel(parts, { x: px + Math.sin(a) * 0.1, y: y0 + doorH + 0.22 * B, z: pz + Math.cos(a) * 0.1, rotY: a, width: doorW + 0.7 * B, depth: 0.34 * B, seed: seed + 5 });
      pediment(parts, { x: px + Math.sin(a) * 0.12, y: y0 + doorH + 0.55 * B, z: pz + Math.cos(a) * 0.12, rotY: a, width: doorW + 0.9 * B, seed: seed + 9, broken: true });
      continue;
    }
    // A false door: a panel of stepped relief in a frame, with its own lintel.
    parts.push({
      geo: mouldedRun([[0, 0], [0.1, 0.06 * B], [0.13, doorH * 0.5], [0.1, doorH * 0.94], [0, doorH]], { length: doorW, thick: 0.18 * B }),
      pos: [px + Math.sin(a) * 0.05, y0, pz + Math.cos(a) * 0.05], rot: [0, a, 0], mat: MAT.sandstone, tone: 0.42 + r() * 0.14,
    });
    for (let k = 0; k < 5; k++) {
      parts.push({
        geo: buildBox(doorW * 0.74, 0.05 * B, 0.06 * B),
        pos: [px + Math.sin(a) * 0.19 * B, y0 + 0.3 * B + k * 0.34 * B, pz + Math.cos(a) * 0.19 * B],
        rot: [0, a, 0], mat: MAT.sandstone, tone: 0.3 + r() * 0.18,
      });
    }
    carvedLintel(parts, { x: px + Math.sin(a) * 0.14 * B, y: y0 + doorH + 0.18 * B, z: pz + Math.cos(a) * 0.14 * B, rotY: a, width: doorW + 0.5 * B, depth: 0.26 * B, seed: seed + i * 13 });
  }

  // The tiers: each a plinth, a banded body and a cornice, receding.
  let ty = y0 + bodyH + 0.7 * B, tw = base * 0.9;
  for (let k = 0; k < tiers; k++) {
    const th = (0.9 - k * 0.1) * B;
    parts.push({ geo: mouldedRing(banded(th, { course: th * 0.55, step: 0.03 }), { w: tw, d: tw }).translate(0, ty, 0), mat: MAT.sandstone, tone: 0.42 + r() * 0.16 });
    parts.push({ geo: mouldedRing(CORNICE(0.34 * B), { w: tw - 0.06, d: tw - 0.06 }).translate(0, ty + th, 0), mat: MAT.sandstone, tone: 0.38 + r() * 0.16 });
    // Antefixes: the upturned corner horns, small lathes rather than cones.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const p = [new THREE.Vector2(0, 0)];                   // closed at the foot
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        p.push(new THREE.Vector2((0.12 - t * 0.1) * B * (1 + Math.sin(t * 6) * 0.25), t * 0.5 * B));
      }
      p.push(new THREE.Vector2(0, 0.52 * B));                // and at the tip
      parts.push({
        geo: new THREE.LatheGeometry(p, 7),
        pos: [sx * tw / 2, ty + th + 0.3 * B, sz * tw / 2],
        rot: [sz * 0.24, r() * 3, -sx * 0.24],
        mat: r() < 0.16 ? MAT.moss : MAT.sandstone, tone: 0.42 + r() * 0.2,
      });
    }
    // A block or two out of each tier, and the ones that fell at the foot.
    if (r() < 0.8) {
      const a = r() * Math.PI * 2;
      parts.push({
        geo: stoneBlock(0.5 * B, 0.36 * B, 0.44 * B, seed + k * 7, { chip: 0.26 }),
        pos: [Math.sin(a) * (base * 0.7 + r() * 1.4), 0.2 * B + plinthH * (r() < 0.5 ? 1 : 0), Math.cos(a) * (base * 0.7 + r() * 1.4)],
        rot: [(r() - 0.5) * 0.6, r() * 3, (r() - 0.5) * 0.6], mat: MAT.sandstone, tone: 0.4 + r() * 0.2,
      });
    }
    ty += th + 0.34 * B;
    tw *= 0.86;
  }
  // The faces, on the top tier, looking out at the four directions.
  if (faces) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      bayonFace(parts, {
        x: Math.sin(a) * (tw * 0.52), y: ty - 0.5 * B, z: Math.cos(a) * (tw * 0.52),
        rotY: a, scale: tw / (1.5 * B), seed: seed + i * 17,
      });
    }
  }
  // The crown: a lotus finial, its top broken off and CAPPED.
  //
  // A lathe is a surface of revolution, not a solid: a profile that stops
  // short of the axis leaves the thing an open shell, and from the RTS camera
  // — which looks down on exactly this — you see straight into it. The tower
  // had a crater on top of it for that reason. Every lathe here now ends ON
  // the axis (radius 0), which caps it.
  const crown = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    crown.push(new THREE.Vector2(tw * 0.52 * Math.sin((1 - t) * 1.9 + 0.25), t * 1.1 * B));
  }
  const brokenR = crown[crown.length - 1].x;
  crown.push(new THREE.Vector2(brokenR * 0.62, 1.16 * B));   // the broken lip
  crown.push(new THREE.Vector2(0, 1.14 * B));                // and the cap across it
  parts.push({ geo: new THREE.LatheGeometry(crown, 12), pos: [0, ty, 0], rot: [0.04, r() * 3, 0.03], mat: MAT.sandstone, tone: 0.44 });

  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.3, radius: 2, strength: 0.5, groundFade: 0.3, floor: 0.45 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: base / 2 + 0.8 * B, hz: base / 2 + 0.8 * B };
  geo.userData.height = ty + 1.2 * B;
  return geo;
}

// ── The gallery ──────────────────────────────────────────────────────────────
/**
 * A run of GALLERY, the covered passage that rings a temple: a moulded plinth,
 * a banded outer wall with a cornice, a colonnade of square pillars inside it,
 * and a corbelled stone roof over the gap — collapsed in stretches, with the
 * roof slabs lying in the passage where they came down.
 */
export function buildTempleGallery({ seed = 7, length = 10, collapse = 0.4 } = {}) {
  const r = rng(seed);
  const parts = [];
  const L = length * B * 0.62, width = 2.1 * B, wallH = 2.3 * B, plinthH = 0.5 * B;
  parts.push({ geo: mouldedRing(PLINTH(plinthH), { w: L + 0.5, d: width + 0.9 }), mat: MAT.laterite, tone: 0.4 + r() * 0.16 });
  const y0 = plinthH;
  // The outer wall, and a cornice on top of the stretches still standing.
  parts.push({
    geo: mouldedRun(banded(wallH, { course: 0.56 }), { length: L, thick: 0.44 * B }),
    pos: [0, y0, -width / 2], mat: MAT.sandstone, tone: 0.44 + r() * 0.14,
  });
  parts.push({
    geo: mouldedRun(CORNICE(0.4 * B), { length: L * 0.7, thick: 0.4 * B }),
    pos: [-L * 0.1, y0 + wallH, -width / 2], mat: MAT.sandstone, tone: 0.4 + r() * 0.14,
  });
  // Gap-toothed top: loose blocks along the crest, and gaps where they are gone.
  const crest = Math.round(L / (0.6 * B));
  for (let i = 0; i < crest; i++) {
    if (r() < 0.45) continue;
    const st = stoneOf(r, { moss: 0.3 });
    parts.push({
      geo: stoneBlock(0.54 * B, 0.3 * B, 0.42 * B, seed + i * 3, { chip: 0.24 }),
      pos: [-L / 2 + (i + 0.5) * (L / crest), y0 + wallH + 0.16 * B, -width / 2 + (r() - 0.5) * 0.1],
      rot: [(r() - 0.5) * 0.06, (r() - 0.5) * 0.2, (r() - 0.5) * 0.06], mat: st.mat, tone: st.tone,
    });
  }
  // The colonnade, one or two of them down.
  const bays = Math.max(2, Math.round(L / (1.6 * B)));
  for (let i = 0; i <= bays; i++) {
    const x = -L / 2 + (i * L) / bays;
    if (r() < collapse * 0.3) {
      const len = wallH * (0.5 + r() * 0.45);
      parts.push({
        geo: stoneBlock(0.4 * B, 0.4 * B, len, seed + i, { chip: 0.16 }),
        pos: [x + (r() - 0.5) * 0.8, y0 + 0.2 * B, width * 0.08],
        rot: [0, r() * 3, 0.04], mat: MAT.sandstone, tone: 0.42 + r() * 0.2,
      });
      continue;
    }
    parts.push({
      geo: mouldedRing(banded(wallH, { course: wallH / 3, step: 0.02 }), { w: 0.42 * B, d: 0.42 * B, edge: 1 }),
      pos: [x, y0, width / 2], rot: [0, (r() - 0.5) * 0.03, 0], mat: MAT.sandstone, tone: 0.44 + r() * 0.16,
    });
    parts.push({
      geo: mouldedRing(CORNICE(0.22 * B), { w: 0.4 * B, d: 0.4 * B, edge: 1 }),
      pos: [x, y0 + wallH, width / 2], mat: MAT.sandstone, tone: 0.4 + r() * 0.16,
    });
  }
  // The corbelled roof over the passage, dropped where it has failed.
  for (let i = 0; i < bays; i++) {
    const x = -L / 2 + (i + 0.5) * (L / bays);
    if (r() < collapse) {
      for (let k = 0; k < 3; k++) {
        const st = stoneOf(r, { moss: 0.24 });
        parts.push({
          geo: stoneBlock(0.85 * B + r() * 0.4, 0.26 * B, 0.75 * B + r() * 0.3, seed + i * 17 + k, { chip: 0.22 }),
          pos: [x + (r() - 0.5) * (L / bays) * 0.7, y0 + 0.14 * B + k * 0.1, (r() - 0.5) * width * 0.7],
          rot: [(r() - 0.5) * 0.55, r() * 3, (r() - 0.5) * 0.55], mat: st.mat, tone: st.tone,
        });
      }
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const t = (k + 1) / 4;
      // Each corbel course a little SHORTER than the one under it, as well as
      // narrower: cut to one length their end faces share a plane.
      parts.push({
        geo: buildBox((L / bays) * (0.98 - k * 0.05), 0.24 * B, width * (1 - t * 0.66) + 0.5),
        pos: [x, y0 + wallH + 0.14 * B + k * 0.27 * B, width * 0.16 * t],
        rot: [0, (r() - 0.5) * 0.01, 0], mat: r() < 0.2 ? MAT.moss : MAT.sandstone, tone: 0.38 + r() * 0.2,
      });
    }
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.26, radius: 2, strength: 0.5, groundFade: 0.3, floor: 0.45 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: L / 2 + 0.3, hz: width / 2 + 0.5 };
  geo.userData.height = y0 + wallH + 1.2 * B;
  return geo;
}

// ── The gate ─────────────────────────────────────────────────────────────────
/**
 * A GOPURA — the gate tower you pass through to enter, and the piece that
 * makes an approach an approach: a moulded mass either side of a real doorway
 * with colonettes, a carved lintel and a pediment over it, and the stump of
 * the tower that stood above, its blocks down in the grass.
 */
export function buildTempleGopura({ seed = 11 } = {}) {
  const r = rng(seed);
  const parts = [];
  const W = 5.6 * B, D = 1.9 * B, H = 3.1 * B, door = 1.3 * B, plinthH = 0.55 * B, doorH = 2.3 * B;
  parts.push({ geo: mouldedRing(PLINTH(plinthH), { w: W + 0.7, d: D + 0.9 }), mat: MAT.laterite, tone: 0.4 + r() * 0.16 });
  const y0 = plinthH;
  for (const sx of [-1, 1]) {
    const w = (W - door) / 2;
    parts.push({
      geo: mouldedRing(banded(H, { course: 0.6 }), { w, d: D }).translate(sx * (door / 2 + w / 2), y0, 0),
      mat: MAT.sandstone, tone: 0.44 + r() * 0.14,
    });
    parts.push({
      geo: mouldedRing(CORNICE(0.46 * B), { w: w - 0.05, d: D - 0.05 }).translate(sx * (door / 2 + w / 2), y0 + H, 0),
      mat: MAT.sandstone, tone: 0.4 + r() * 0.14,
    });
    // The stump of the tier above, and its blocks in the grass outside.
    if (sx > 0 || r() < 0.5) {
      parts.push({
        geo: mouldedRing(banded(0.7 * B, { course: 0.35 }), { w: w * 0.7, d: D * 0.8 })
          .translate(sx * (door / 2 + w / 2), y0 + H + 0.46 * B, 0),
        mat: MAT.sandstone, tone: 0.42 + r() * 0.14,
      });
    }
    for (let k = 0; k < 4; k++) {
      const st = stoneOf(r, { moss: 0.28 });
      parts.push({
        geo: stoneBlock((0.5 + r() * 0.4) * B, 0.32 * B, (0.45 + r() * 0.3) * B, seed + k * 19 + sx, { chip: 0.24 }),
        pos: [sx * (door / 2 + w * (0.25 + r() * 0.8)), 0.18 * B + k * 0.05, -D / 2 - (0.7 + r() * 1.2) * B],
        rot: [(r() - 0.5) * 0.45, r() * 3, (r() - 0.5) * 0.45], mat: st.mat, tone: st.tone,
      });
    }
  }
  // The passage itself: dark, with a corbelled head and a fallen lintel in it.
  parts.push({ geo: buildBox(door, doorH, D + 0.2), pos: [0, y0 + doorH / 2, 0], mat: MAT.steel, tone: 0.02 });
  for (const sz of [-1, 1]) {
    for (const s of [-1, 1]) {
      parts.push({
        geo: buildBox(0.22 * B, doorH + 0.22 * B, 0.26 * B),
        pos: [s * (door / 2 + 0.11 * B), y0 + (doorH + 0.22 * B) / 2, sz * (D / 2 - 0.1 * B)],
        mat: MAT.sandstone, tone: 0.46 + r() * 0.12,
      });
      parts.push({
        geo: colonette(doorH * 0.9, 0.13 * B),
        pos: [s * (door / 2 + 0.28 * B), y0, sz * (D / 2 + 0.08 * B)],
        mat: MAT.sandstone, tone: 0.5 + r() * 0.2,
      });
    }
    carvedLintel(parts, { x: 0, y: y0 + doorH + 0.24 * B, z: sz * (D / 2 + 0.06 * B), rotY: sz > 0 ? 0 : Math.PI, width: door + 0.8 * B, depth: 0.3 * B, seed: seed + 3 + sz });
    pediment(parts, { x: 0, y: y0 + doorH + 0.58 * B, z: sz * (D / 2 + 0.04 * B), rotY: sz > 0 ? 0 : Math.PI, width: door + 1.0 * B, seed: seed + 7 + sz, broken: sz < 0 });
  }
  // A lintel down in the doorway, propped on its own rubble.
  parts.push({
    geo: stoneBlock(door * 1.3, 0.3 * B, 0.36 * B, seed + 31, { chip: 0.16 }),
    pos: [0.1 * B, y0 + 0.26 * B, -D / 2 - 0.5 * B], rot: [0.1, 0.12, -0.22],
    mat: MAT.sandstone, tone: 0.42,
  });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.26, radius: 2, strength: 0.5, groundFade: 0.3, floor: 0.45 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: W / 2 + 0.3, hz: D / 2 + 0.5 };
  geo.userData.height = y0 + H + 1.4 * B;
  return geo;
}

// ── The causeway ─────────────────────────────────────────────────────────────
/**
 * A NĀGA BALUSTRADE: the seven-headed serpent whose body is the handrail along
 * the causeway into the temple, rearing into its hood at the end. It is the
 * piece that tells anyone at a glance which way in is.
 */
export function buildNagaBalustrade({ seed = 17, length = 8, heads = 5 } = {}) {
  const r = rng(seed);
  const parts = [];
  const L = length * B * 0.62, rail = 0.62 * B;
  // The low wall it runs along, moulded and broken in one place.
  parts.push({
    geo: mouldedRun([[0, 0], [0.08, 0.06 * B], [0.08, rail * 0.6], [0.14, rail * 0.72], [0.1, rail * 0.9], [0, rail]], { length: L, thick: 0.34 * B }),
    mat: MAT.sandstone, tone: 0.44 + r() * 0.14,
  });
  // The serpent's body: a scaled tube running the length of it.
  const body = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-L / 2, rail + 0.12 * B, 0),
    new THREE.Vector3(-L * 0.2, rail + 0.16 * B, 0.02),
    new THREE.Vector3(L * 0.2, rail + 0.14 * B, -0.02),
    new THREE.Vector3(L / 2 - 0.4 * B, rail + 0.3 * B, 0),
    new THREE.Vector3(L / 2, rail + 0.9 * B, 0.1 * B),
  ]);
  parts.push({ geo: new THREE.TubeGeometry(body, 22, 0.15 * B, 7, false), mat: MAT.sandstone, tone: 0.46 + r() * 0.16 });
  // Scales: rings down the body.
  for (let i = 0; i < 12; i++) {
    const t = i / 12;
    const p = body.getPointAt(t);
    parts.push({
      geo: new THREE.TorusGeometry(0.17 * B, 0.035 * B, 4, 8).rotateY(Math.PI / 2),
      pos: [p.x, p.y, p.z], rot: [0, 0, 0.1], mat: MAT.sandstone, tone: 0.38 + r() * 0.2,
    });
  }
  // The hood: a fan of heads rearing at the end of the run.
  const hx = L / 2, hy = rail + 1.05 * B;
  for (let k = 0; k < heads; k++) {
    const a = (k - (heads - 1) / 2) * 0.34;
    parts.push({
      geo: new THREE.SphereGeometry(0.17 * B, 9, 7).scale(0.6, 1.5, 0.9),
      pos: [hx + Math.sin(a) * 0.1 * B, hy + 0.3 * B, Math.sin(a) * 0.55 * B],
      rot: [0.3, 0, -a * 0.5], mat: MAT.sandstone, tone: 0.48 + r() * 0.16,
    });
    parts.push({
      geo: new THREE.ConeGeometry(0.1 * B, 0.44 * B, 6),
      pos: [hx + Math.sin(a) * 0.14 * B, hy + 0.72 * B, Math.sin(a) * 0.72 * B],
      rot: [0.24, 0, -a * 0.7], mat: MAT.sandstone, tone: 0.44 + r() * 0.16,
    });
  }
  // And a length of the rail lying broken beside it.
  parts.push({
    geo: stoneBlock(1.3 * B, 0.28 * B, 0.36 * B, seed + 5, { chip: 0.22 }),
    pos: [-L * 0.1, 0.16 * B, -0.9 * B], rot: [0.05, 0.4, 0.08], mat: MAT.sandstone, tone: 0.4 + r() * 0.2,
  });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.2, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: L / 2 + 0.3, hz: 0.6 * B };
  geo.userData.height = rail + 1.8 * B;
  return geo;
}

// ── Rubble ───────────────────────────────────────────────────────────────────
/**
 * A HEAP of fallen stone: the blocks of a wall that came down together, still
 * roughly in their courses because dry masonry falls as slabs, with a carved
 * lintel across the top and the jungle floor already over the lower ones.
 */
export function buildTempleRubble({ seed = 13, blocks = 12 } = {}) {
  const r = rng(seed);
  const parts = [];
  for (let k = 0; k < blocks; k++) {
    const t = k / blocks;
    const a = r() * Math.PI * 2, rad = (0.2 + r() * 1.5) * B * (1 - t * 0.4);
    const st = stoneOf(r, { moss: 0.18 + t * 0.14, laterite: 0.1 });
    const w = (0.45 + r() * 0.45) * B, h = (0.24 + r() * 0.16) * B, d = (0.4 + r() * 0.4) * B;
    parts.push({
      geo: stoneBlock(w, h, d, seed + k * 29, { chip: 0.26, wear: 0.08 }),
      pos: [Math.sin(a) * rad, h / 2 + t * 0.5 * B * r(), Math.cos(a) * rad],
      rot: [(r() - 0.5) * 0.5, r() * 3, (r() - 0.5) * 0.5], mat: st.mat, tone: st.tone,
    });
  }
  carvedLintel(parts, {
    x: (r() - 0.5) * 0.6, y: 0.72 * B, z: (r() - 0.5) * 0.6,
    rotY: r() * 3, width: 2.0 * B, depth: 0.36 * B, seed: seed + 3,
  });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.22, radius: 2, strength: 0.45, groundFade: 0.35, floor: 0.45 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 2 * B, hz: 2 * B };
  geo.userData.height = 1.2 * B;
  return geo;
}
