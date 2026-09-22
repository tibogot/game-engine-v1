/**
 * RTS PARTS KIT — the handful of shapes every Vietnam-war structure is made of.
 *
 * The point is NOT to author six buildings. It is to author six PARTS and
 * compose: a sandbag becomes a stack, a wall, a parapet, a bunker; a corrugated
 * panel becomes hut walls, a roof, a shack, a barracks. Six parts cover the
 * whole structure list, tuning the sandbag once improves every emplacement, and
 * the buildings look like they belong to the same world — which authoring each
 * one separately never achieves.
 *
 * Military architecture is the most procedural-friendly subject there is:
 * boxes, repeated panels, stacked bags, timber frames. No sculpting, so no
 * Blender. Organic shapes (soldiers, vehicle bodies) stay GLB.
 *
 * CONTRACT — every builder returns an indexed BufferGeometry carrying exactly
 * position / normal / uv, in metres, +Y up, origin at the footprint centre and
 * sitting ON y=0. That uniformity is not cosmetic: mergeGeometries returns null
 * if two inputs disagree about their attribute set, and it fails SILENTLY, so
 * the kit guarantees the set rather than hoping.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Deterministic per-object jitter: the same seed always builds the same hut. */
export function rng(seed = 1) {
  let s = (seed | 0) || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822519);
    s = (s ^ (s >>> 13)) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Which surface a part is. Carried per-vertex through the merge so a composed
 * object can shade hessian, metal and timber differently while STILL being one
 * mesh and one draw — which is the whole point of merging in the first place.
 * Splitting an emplacement into three meshes to get three looks would triple
 * the draws on the structure that gets placed most.
 */
export const MAT = {
  hessian: 0, metal: 1, timber: 2, earth: 3, thatch: 4, bamboo: 5, woven: 6, paint: 7,
  canvas: 8, camo: 9, concrete: 10, white: 11,
  // Vehicles: tyres were drawn in the rusty corrugated iron (the only metal),
  // and read as rust. Rubber for tyres, clean dark steel for tracks and guns.
  steel: 12, rubber: 13,
  // The enemy's French colonial HQ: ochre limewashed stucco, terracotta tile.
  // The atlas is full at 16.
  stucco: 14, tile: 15,
};

/** Strip anything merge would choke on, and guarantee the attribute set. */
function normalise(geo, matId = MAT.hessian, tone = 0.5) {
  for (const name of Object.keys(geo.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  if (!geo.attributes.uv) {
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  // Always present, always the same size — mergeGeometries returns null on an
  // attribute mismatch and does it SILENTLY, so this is guaranteed not hoped.
  const ids = new Float32Array(n);
  ids.fill(matId);
  geo.setAttribute("matId", new THREE.BufferAttribute(ids, 1));
  // Per-PART tone, not per-object: a wall of identical sheets is the other half
  // of why untextured procedural work looks fake. Replaced panels, older bags
  // and newer timber all read differently.
  const tones = new Float32Array(n);
  tones.fill(tone);
  geo.setAttribute("tone", new THREE.BufferAttribute(tones, 1));
  return geo;
}

/**
 * Merge a list of { geo, pos?, rot?, scale? } placements into one geometry.
 * Everything in the kit composes through here, so there is one place that
 * applies transforms and one place that can fail loudly.
 */
export function assemble(parts) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const out = [];
  for (const p of parts) {
    if (!p?.geo) continue;
    // A part already carrying ids (a sub-assembly) keeps them; a raw one is
    // stamped with whatever the caller says it is made of.
    const inherit = p.mat == null && p.geo.attributes.matId;
    const g = inherit ? p.geo.clone()
                      : normalise(p.geo.clone(), p.mat ?? MAT.hessian, p.tone ?? 0.5);
    if (p.matrix) {
      // An explicit basis, for anything whose orientation is easier to state as
      // three axes than as an Euler triple — a roof sheet on a slope, say.
      g.applyMatrix4(p.matrix);
    } else {
      const pos = p.pos ?? [0, 0, 0];
      const rot = p.rot ?? [0, 0, 0];
      const scl = p.scale ?? [1, 1, 1];
      e.set(rot[0], rot[1], rot[2]);
      q.setFromEuler(e);
      m.compose(
        new THREE.Vector3(pos[0], pos[1], pos[2]), q,
        new THREE.Vector3(scl[0], scl[1], scl[2]),
      );
      g.applyMatrix4(m);
    }
    out.push(g);
  }
  if (!out.length) return new THREE.BufferGeometry();
  const merged = mergeGeometries(out, false);
  for (const g of out) g.dispose();
  if (!merged) throw new Error("rtsParts.assemble: mergeGeometries returned null (attribute mismatch)");
  return merged;
}

export function triCount(geo) {
  if (!geo) return 0;
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}

/**
 * Contact ambient occlusion, baked into a per-vertex `ao` attribute.
 *
 * This is the single biggest thing separating "procedural asset" from
 * "untextured greybox". A stack of sandbags with no darkening where the bags
 * touch merges into one beige mass; a hut with no shade under its roof reads as
 * a flat cut-out. Texture alone does not fix either — the eye is looking for
 * contact.
 *
 * Method: drop every vertex into a coarse occupancy grid, then darken each
 * vertex by how much of its neighbourhood is filled. Not a ray-traced bake, but
 * it finds exactly what matters here — crevices between stacked parts, the
 * inside of an enclosure, the underside of an overhang — for a few ms at build
 * time and nothing at all per frame.
 */
export function bakeContactAO(geo, { cell = 0.22, radius = 2, strength = 0.55, groundFade = 0.35, floor = 0.42 } = {}) {
  const pos = geo.attributes.position;
  const n = pos.count;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const nx = Math.max(1, Math.ceil((bb.max.x - bb.min.x) / cell) + 1);
  const ny = Math.max(1, Math.ceil((bb.max.y - bb.min.y) / cell) + 1);
  const nz = Math.max(1, Math.ceil((bb.max.z - bb.min.z) / cell) + 1);
  const grid = new Uint8Array(nx * ny * nz);
  const at = (x, y, z) => (z * ny + y) * nx + x;
  const cellOf = (i) => [
    Math.min(nx - 1, Math.max(0, Math.floor((pos.getX(i) - bb.min.x) / cell))),
    Math.min(ny - 1, Math.max(0, Math.floor((pos.getY(i) - bb.min.y) / cell))),
    Math.min(nz - 1, Math.max(0, Math.floor((pos.getZ(i) - bb.min.z) / cell))),
  ];
  for (let i = 0; i < n; i++) { const [x, y, z] = cellOf(i); grid[at(x, y, z)] = 1; }

  // Normalising by the neighbourhood volume keeps `strength` meaning the same
  // thing whatever radius is passed.
  let maxCount = 0;
  for (let dz = -radius; dz <= radius; dz++)
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const d = Math.hypot(dx, dy, dz);
        if (d > radius || d < 0.5) continue;
        maxCount += 1 / (1 + d);
      }

  const ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const [cx, cy, cz] = cellOf(i);
    let occ = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      const z = cz + dz; if (z < 0 || z >= nz) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const y = cy + dy; if (y < 0 || y >= ny) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const x = cx + dx; if (x < 0 || x >= nx) continue;
          const d = Math.hypot(dx, dy, dz);
          if (d > radius || d < 0.5) continue;
          if (grid[at(x, y, z)]) occ += 1 / (1 + d);
        }
      }
    }
    let v = 1 - strength * (occ / maxCount);
    // Everything darkens where it meets the ground: shadow, damp, splashed dirt.
    const h = pos.getY(i) - bb.min.y;
    v *= 1 - groundFade * Math.max(0, 1 - h / 0.55);
    // FLOOR, and it has to be well above zero. A wall panel is thin, so its
    // outer and inner faces share vertices — occlusion from the ENCLOSED inside
    // lands on the outside too. Letting that reach black turned the shaded wall
    // of the hut into a silhouette. AO here is contact shading, not lighting.
    ao[i] = Math.max(floor, Math.min(1, v));
  }
  geo.setAttribute("ao", new THREE.BufferAttribute(ao, 1));
  return geo;
}

// ── 1. SANDBAG ───────────────────────────────────────────────────────────────

export const SANDBAG_DEFAULTS = {
  length: 0.52, width: 0.30, height: 0.19,
  segU: 8, segV: 5,   // 2*segU*(segV-1) tris — 8x5 is 64, cheap enough to stack
  round: 3.1,         // p-norm exponent: 2 = ellipsoid, higher = squarer bag
  sag: 0.42,          // how much the underside flattens where it rests
  slump: 0.22,        // waist bulge, so a bag reads as FILLED rather than moulded
};

/**
 * One filled sandbag: a p-norm superellipsoid, flattened underneath where it
 * sits and bulged at the waist. Higher `round` squares off the ends, which is
 * what separates a sandbag from a pebble.
 */
export function buildSandbag(opts = {}) {
  const o = { ...SANDBAG_DEFAULTS, ...opts };
  const { segU, segV } = o;
  const pos = [], uvs = [], idx = [];
  const p = 2 / Math.max(2, o.round);
  const sgnPow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

  for (let j = 0; j < segV; j++) {
    const v = j / (segV - 1);
    const phi = (v - 0.5) * Math.PI;          // -pi/2 .. pi/2
    const ny = sgnPow(Math.sin(phi), p);
    const r = sgnPow(Math.cos(phi), p);
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const th = u * Math.PI * 2;
      const nx = sgnPow(Math.cos(th), p) * r;
      const nz = sgnPow(Math.sin(th), p) * r;
      // Waist bulge: widest at the middle, so the bag looks full.
      const bulge = 1 + o.slump * Math.cos(phi) * Math.cos(phi);
      let y = ny * o.height * 0.5;
      // Underside flattens against whatever it rests on.
      if (ny < 0) y *= 1 - o.sag;
      pos.push(nx * o.length * 0.5 * bulge, y + o.height * 0.5, nz * o.width * 0.5 * bulge);
      uvs.push(u, v);
    }
  }
  const row = segU + 1;
  for (let j = 0; j < segV - 1; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A course of bags laid end to end along +X, each nudged so the row reads as
 * hand-stacked. `stagger` offsets alternate courses by half a bag, which is how
 * a real sandbag wall is bonded and the main thing that stops it looking tiled.
 */
export function buildSandbagCourse({ length = 4, course = 0, seed = 1, bag = {}, jitter = 1 } = {}) {
  const b = { ...SANDBAG_DEFAULTS, ...bag };
  const r = rng(seed * 131 + course * 17 + 7);
  const step = b.length * 0.94;                       // slight overlap, no gaps
  const n = Math.max(1, Math.round(length / step));
  const stagger = (course % 2) * step * 0.5;
  const geo = buildSandbag(b);
  const parts = [];
  for (let i = 0; i < n; i++) {
    const x = -length / 2 + i * step + step * 0.5 + stagger;
    parts.push({
      geo,
      pos: [x + (r() - 0.5) * 0.03 * jitter,
            course * b.height * 0.9 + (r() - 0.5) * 0.012 * jitter,
            (r() - 0.5) * 0.045 * jitter],
      rot: [(r() - 0.5) * 0.10 * jitter, (r() - 0.5) * 0.16 * jitter, (r() - 0.5) * 0.07 * jitter],
      scale: [1 + (r() - 0.5) * 0.09 * jitter, 1, 1 + (r() - 0.5) * 0.09 * jitter],
    });
  }
  const out = assemble(parts);
  geo.dispose();
  return out;
}

/** A straight sandbag wall: `courses` bonded rows, tapering in if `batter`. */
export function buildSandbagWall({ length = 4, courses = 3, seed = 1, bag = {}, batter = 0.035, jitter = 1 } = {}) {
  const parts = [];
  for (let c = 0; c < courses; c++) {
    const g = buildSandbagCourse({ length: length - c * batter * 2, course: c, seed, bag, jitter });
    parts.push({ geo: g });
  }
  const out = assemble(parts);
  for (const p of parts) p.geo.dispose();
  return out;
}

/**
 * A circular parapet — the emplacement ring. `gapDeg` leaves an entrance, which
 * matters for readability from above: a closed ring reads as a tyre.
 */
export function buildSandbagRing({
  radius = 3.4, courses = 3, seed = 1, bag = {}, gapDeg = 52, batter = 0.05, jitter = 1,
} = {}) {
  const b = { ...SANDBAG_DEFAULTS, ...bag };
  const parts = [];
  const geo = buildSandbag(b);
  const gap = (gapDeg * Math.PI) / 180;
  for (let c = 0; c < courses; c++) {
    const rad = radius - c * batter;
    const step = b.length * 0.94;
    const n = Math.max(6, Math.round((2 * Math.PI * rad) / step));
    const r = rng(seed * 977 + c * 31 + 3);
    const half = gap / 2;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (c % 2) * (Math.PI / n);
      // Leave the entrance open, facing -Z.
      const d = Math.abs(Math.atan2(Math.sin(a + Math.PI / 2), Math.cos(a + Math.PI / 2)));
      if (d < half) continue;
      parts.push({
        geo,
        pos: [Math.cos(a) * rad, c * b.height * 0.9 + (r() - 0.5) * 0.012 * jitter, Math.sin(a) * rad],
        rot: [(r() - 0.5) * 0.09 * jitter, -a + (r() - 0.5) * 0.14 * jitter, (r() - 0.5) * 0.06 * jitter],
        scale: [1 + (r() - 0.5) * 0.08 * jitter, 1, 1 + (r() - 0.5) * 0.08 * jitter],
      });
    }
  }
  const out = assemble(parts);
  geo.dispose();
  return out;
}

// ── 2. CORRUGATED PANEL ──────────────────────────────────────────────────────

export const CORRUGATED_DEFAULTS = {
  width: 2.0, height: 1.8, thickness: 0.02,
  ribs: 9, ribDepth: 0.035,
  // Shifts the whole profile along its normal. Lapped sheets MUST NOT be
  // coplanar: two overlapping panels at the same depth z-fight, which is
  // exactly the flicker a wall of them shows. A real roof laps one sheet OVER
  // the next anyway, so this is both the fix and the correct construction.
  offset: 0,
};

/**
 * A sheet of corrugated iron, built by EXTRUDING a closed profile rather than
 * offsetting a plane. A single-sided sheet would need DoubleSide, and an
 * inside-out winding there does not vanish — faceDirection flips the normal and
 * the panel renders BLACK. A closed solid cannot have that problem.
 */
export function buildCorrugatedPanel(opts = {}) {
  const o = { ...CORRUGATED_DEFAULTS, ...opts };
  const n = Math.max(8, o.ribs * 3);              // samples across the width
  const front = [], back = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = (t - 0.5) * o.width;
    const z = Math.sin(t * Math.PI * 2 * o.ribs) * o.ribDepth;
    front.push([x, z + o.thickness * 0.5 + o.offset]);
    back.push([x, z - o.thickness * 0.5 + o.offset]);
  }
  const loop = [...front, ...back.reverse()];      // closed cross-section
  const pos = [], uvs = [], idx = [];
  const m = loop.length;
  for (let s = 0; s < 2; s++) {
    const y = s * o.height;
    for (let i = 0; i < m; i++) {
      pos.push(loop[i][0], y, loop[i][1]);
      // v must run UP the sheet: rust bleeds down it (see rtsTextures.js).
      uvs.push((loop[i][0] + o.width * 0.5) / 2, (y / 2));
    }
  }
  for (let i = 0; i < m; i++) {
    const a = i, b = (i + 1) % m, c = a + m, d = b + m;
    idx.push(a, c, b, b, c, d);
  }
  // Caps: a STRIP between the front and back rows at each end. (A fan from one
  // vertex over this wavy, non-convex loop folds back over itself, and the
  // overlapping coplanar triangles z-fight — the sheet edges shimmered.)
  // Loop order is front 0..n then back n..0, so front i is i and back i is m-1-i.
  for (let s = 0; s < 2; s++) {
    const off = s * m;
    for (let i = 0; i < n; i++) {
      const f0 = off + i, f1 = off + i + 1, b0 = off + m - 1 - i, b1 = off + m - 2 - i;
      if (s === 0) idx.push(f0, b0, f1, f1, b0, b1);
      else idx.push(f0, f1, b0, f1, b1, b0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Trapezoidal corrugation — the profile of a shipping container's walls
 * (flat crest, sloped web, flat trough), as against the round sine of sheet
 * roofing. Same construction as buildCorrugatedPanel: a closed extruded
 * profile standing in XY, ribs vertical, outer face +Z, strip-capped ends.
 * UVs in metres / 2, v up the panel.
 */
// Profile corners per pitch: trough, rise, crest, fall (fraction of a pitch, ±1).
const TRAP_PROFILE = [[0, -1], [0.3, -1], [0.45, 1], [0.8, 1], [0.95, -1], [1, -1]];

/**
 * The outer face of a buildTrapezoidPanel at the panel's own x: its z (outward)
 * there, and the x of every profile corner — so something laid ON the sheet
 * (a painted stencil) can follow it exactly instead of cutting the corners.
 */
export function trapezoidProfile({ width = 2, thickness = 0.02, pitch = 0.28, depth = 0.036, offset = 0 } = {}) {
  const ribs = Math.max(1, Math.round(width / pitch));
  const p = width / ribs;
  const zAt = (x) => {
    const u = Math.min(ribs - 1e-9, Math.max(0, (x + width / 2) / p));
    const k = Math.floor(u), f = u - k;
    for (let i = 0; i < TRAP_PROFILE.length - 1; i++) {
      const [f0, s0] = TRAP_PROFILE[i], [f1, s1] = TRAP_PROFILE[i + 1];
      if (f <= f1) return (s0 + ((s1 - s0) * (f - f0)) / (f1 - f0)) * depth / 2 + thickness / 2 + offset;
    }
    return -depth / 2 + thickness / 2 + offset;
  };
  const corners = [];
  for (let k = 0; k < ribs; k++) for (const [f] of TRAP_PROFILE) corners.push(-width / 2 + (k + f) * p);
  return { zAt, corners };
}

export function buildTrapezoidPanel({ width = 2, height = 2, thickness = 0.02, pitch = 0.28, depth = 0.036, offset = 0 } = {}) {
  const ribs = Math.max(1, Math.round(width / pitch));
  const p = width / ribs;
  const prof = TRAP_PROFILE.slice(0, -1);
  const front = [], back = [];
  for (let k = 0; k < ribs; k++) {
    for (const [t, s] of prof) front.push([-width / 2 + (k + t) * p, s * depth / 2]);
  }
  front.push([width / 2, -depth / 2]);
  for (const [x, z] of front) back.push([x, z - thickness]);
  for (const q of front) q[1] += thickness / 2 + offset;
  for (const q of back) q[1] += thickness / 2 + offset;
  const loop = [...front, ...back.reverse()];
  const m = loop.length, n = front.length - 1;
  const pos = [], uvs = [], idx = [];
  for (let s = 0; s < 2; s++) {
    const y = s * height;
    for (let i = 0; i < m; i++) {
      pos.push(loop[i][0], y, loop[i][1]);
      uvs.push((loop[i][0] + width / 2) / 2, y / 2);
    }
  }
  for (let i = 0; i < m; i++) {
    const a = i, b = (i + 1) % m, c = a + m, d = b + m;
    idx.push(a, c, b, b, c, d);
  }
  for (let s = 0; s < 2; s++) {
    const off = s * m;
    for (let i = 0; i < n; i++) {
      const f0 = off + i, f1 = off + i + 1, b0 = off + m - 1 - i, b1 = off + m - 2 - i;
      if (s === 0) idx.push(f0, b0, f1, f1, b0, b1);
      else idx.push(f0, f1, b0, f1, b1, b0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  // Flat-shaded look for the webs: split nothing, but the crest/trough flats
  // are wide enough that smooth normals across the corners read as folded steel.
  g.computeVertexNormals();
  return g;
}

/**
 * A box whose UVs are in METRES / 2 on every face, like the panels — so a
 * patterned surface (camo, paint wear) keeps one scale across a whole object
 * instead of stretching over each face as BoxGeometry's 0..1 UVs do. v runs up
 * the side faces.
 */
export function buildBox(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  // Face groups: +x, -x, +y, -y, +z, -z — each face's (u, v) spans (a, b) metres.
  const span = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
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
  g.clearGroups();
  return g;
}

// ── 3. TIMBER POST ───────────────────────────────────────────────────────────

export const POST_DEFAULTS = { height: 2.2, width: 0.14, depth: 0.14, taper: 0.06, round: false };

/** A squared timber (or a round pole) standing on y=0, slightly tapered. */
export function buildPost(opts = {}) {
  const o = { ...POST_DEFAULTS, ...opts };
  const g = o.round
    ? new THREE.CylinderGeometry(o.width * 0.5 * (1 - o.taper), o.width * 0.5, o.height, 7, 1)
    : new THREE.BoxGeometry(o.width, o.height, o.depth);
  if (!o.round && o.taper > 0) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) > 0) { p.setX(i, p.getX(i) * (1 - o.taper)); p.setZ(i, p.getZ(i) * (1 - o.taper)); }
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
  }
  g.translate(0, o.height * 0.5, 0);
  return g;
}

// ── 4. SHEET ROOF ────────────────────────────────────────────────────────────

export const ROOF_DEFAULTS = { span: 3.2, depth: 2.6, pitch: 0.28, overhang: 0.28, ribs: 11, ribDepth: 0.03 };

/** A pitched corrugated roof: two sloped sheets and a ridge cap. */
export function buildSheetRoof(opts = {}) {
  const o = { ...ROOF_DEFAULTS, ...opts };
  const half = o.span * 0.5 + o.overhang;
  const rise = half * o.pitch;
  const slope = Math.hypot(half, rise);
  const sheet = buildCorrugatedPanel({
    width: o.depth + o.overhang * 2, height: slope, thickness: 0.022,
    ribs: o.ribs, ribDepth: o.ribDepth,
  });
  const ang = Math.atan2(rise, half);
  const parts = [
    // Each sheet is built standing up, so it is laid down then pitched.
    { geo: sheet, rot: [Math.PI / 2 - ang, Math.PI / 2, 0], pos: [-half / 2, rise / 2, 0] },
    { geo: sheet, rot: [Math.PI / 2 + ang, Math.PI / 2, 0], pos: [half / 2, rise / 2, 0] },
    { geo: new THREE.BoxGeometry(0.16, 0.08, o.depth + o.overhang * 2), pos: [0, rise + 0.03, 0] },
  ];
  const out = assemble(parts);
  sheet.dispose();
  parts[2].geo.dispose();
  return out;
}

// ── 5. LADDER ────────────────────────────────────────────────────────────────

export const LADDER_DEFAULTS = { height: 3.0, width: 0.52, rail: 0.06, rungs: 8, rung: 0.045 };

export function buildLadder(opts = {}) {
  const o = { ...LADDER_DEFAULTS, ...opts };
  const rail = new THREE.BoxGeometry(o.rail, o.height, o.rail);
  const rung = new THREE.BoxGeometry(o.width, o.rung, o.rung);
  const parts = [
    { geo: rail, pos: [-o.width * 0.5, o.height * 0.5, 0] },
    { geo: rail, pos: [o.width * 0.5, o.height * 0.5, 0] },
  ];
  for (let i = 0; i < o.rungs; i++) {
    const y = ((i + 0.6) / o.rungs) * o.height;
    parts.push({ geo: rung, pos: [0, y, 0] });
  }
  const out = assemble(parts);
  rail.dispose(); rung.dispose();
  return out;
}

// ── 6. OIL DRUM ──────────────────────────────────────────────────────────────

export const DRUM_DEFAULTS = { radius: 0.29, height: 0.88, seg: 10, hoops: 2, hoop: 0.016 };

export function buildOilDrum(opts = {}) {
  const o = { ...DRUM_DEFAULTS, ...opts };
  const body = new THREE.CylinderGeometry(o.radius, o.radius, o.height, o.seg, 1, false);
  body.translate(0, o.height * 0.5, 0);
  const parts = [{ geo: body }];
  for (let i = 0; i < o.hoops; i++) {
    const y = o.height * ((i + 1) / (o.hoops + 1));
    const hoop = new THREE.CylinderGeometry(o.radius + o.hoop, o.radius + o.hoop, o.height * 0.07, o.seg, 1, true);
    parts.push({ geo: hoop, pos: [0, y, 0] });
  }
  const out = assemble(parts);
  for (const p of parts) p.geo.dispose();
  return out;
}

// ── 7. BAMBOO POLE ───────────────────────────────────────────────────────────

export const BAMBOO_POLE_DEFAULTS = {
  height: 2.6, radius: 0.055, seg: 7,
  internodes: 6, nodeBulge: 1.18, taper: 0.12,
};

/**
 * A structural culm. The NODES are the whole tell — a smooth cylinder reads as
 * dowel or pipe, and the swollen ring every 30-40 cm is what says bamboo at a
 * glance. Built as a lathe so each node costs one extra ring, not a separate
 * mesh.
 */
export function buildBambooPole(opts = {}) {
  const o = { ...BAMBOO_POLE_DEFAULTS, ...opts };
  const rings = [];
  const n = Math.max(1, o.internodes);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const base = o.radius * (1 - o.taper * t);
    // Three rings per node — plain just below, swollen at it, plain just above —
    // so the bulge is a crisp collar rather than a slow bend.
    if (i > 0) rings.push([t - 0.012, base * 1.02]);
    rings.push([t, base * (i === 0 || i === n ? 1 : o.nodeBulge)]);
    if (i < n) rings.push([t + 0.012, base * 1.02]);
  }
  const pos = [], uvs = [], idx = [];
  for (let r = 0; r < rings.length; r++) {
    const [t, rad] = rings[r];
    for (let s = 0; s <= o.seg; s++) {
      const a = (s / o.seg) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, t * o.height, Math.sin(a) * rad);
      uvs.push(s / o.seg, t * o.height * 0.5);
    }
  }
  const row = o.seg + 1;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let s = 0; s < o.seg; s++) {
      const a = r * row + s, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ── 8. THATCH ────────────────────────────────────────────────────────────────

export const THATCH_DEFAULTS = {
  width: 4, slope: 3, courses: 8,
  overlap: 1.7, thickness: 0.09, ragged: 0.16, seg: 18, seed: 1,
};

/**
 * One slope of a thatched roof, as overlapping COURSES of bundles.
 *
 * A thatch roof is not a surface with a thatch picture on it — the read comes
 * from layers you can see the edges of and from a lower edge that is ragged
 * rather than cut. Each course is a strip whose bottom edge steps per bundle,
 * so the silhouette breaks up; courses lap upward so the eye sees depth.
 *
 * Built in the XY plane with y=0 at the EAVE and +y up the slope, ready to be
 * placed with an explicit basis.
 */
export function buildThatchSlope(opts = {}) {
  const o = { ...THATCH_DEFAULTS, ...opts };
  const r = rng(o.seed);
  const parts = [];
  const rise = o.slope / o.courses;
  for (let c = 0; c < o.courses; c++) {
    const y0 = c * rise;
    const y1 = y0 + rise * o.overlap;
    const pos = [], uvs = [], idx = [];
    const seg = Math.max(4, o.seg);
    // A course has THICKNESS, not one surface. A single-sided roof is
    // see-through from the far side — you look straight past the slope facing
    // away from you and out at the sky. It also gives the eave a real edge,
    // which is the best part of a thatched roof: a cut, hanging fringe.
    const th = o.thickness;
    // Each course sits slightly PROUDER than the one below. Without this the
    // upper edges all share a depth and the laps z-fight.
    const lift = c * th * 0.16;
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const x = (u - 0.5) * o.width;
      // Ragged: every bundle hangs a little differently.
      const droop = (r() - 0.5) * 2 * o.ragged * rise;
      const z0 = th * (0.35 + 0.65 * r());
      const yb = y0 + droop;
      // 0 upper-outer, 1 lower-outer, 2 upper-inner, 3 lower-inner
      const zt = th * 0.25 + lift;
      pos.push(x, y1, zt, x, yb, z0 + lift, x, y1, zt - th, x, yb, z0 + lift - th);
      const uu = u * o.width * 0.5;
      uvs.push(uu, y1 * 0.5, uu, yb * 0.5, uu, y1 * 0.5, uu, yb * 0.5);
    }
    for (let i = 0; i < seg; i++) {
      const A = i * 4, B = A + 4;                       // this column, next column
      const o0 = A, o1 = A + 1, i0 = A + 2, i1 = A + 3;
      const p0 = B, p1 = B + 1, q0 = B + 2, q1 = B + 3;
      idx.push(o1, p1, o0, o0, p1, p0);                 // outer face, up-slope normal
      idx.push(i0, q1, i1, i0, q0, q1);                 // inner face, reversed
      idx.push(o1, i1, p1, p1, i1, q1);                 // the hanging eave edge
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push({ geo: g, mat: MAT.thatch, tone: 0.3 + r() * 0.6 });
  }
  const out = assemble(parts);
  for (const p of parts) p.geo.dispose();
  return out;
}

export const PARTS = {
  sandbag: { build: buildSandbag, defaults: SANDBAG_DEFAULTS, label: "Sandbag" },
  corrugated: { build: buildCorrugatedPanel, defaults: CORRUGATED_DEFAULTS, label: "Corrugated panel" },
  post: { build: buildPost, defaults: POST_DEFAULTS, label: "Timber post" },
  roof: { build: buildSheetRoof, defaults: ROOF_DEFAULTS, label: "Sheet roof" },
  ladder: { build: buildLadder, defaults: LADDER_DEFAULTS, label: "Ladder" },
  drum: { build: buildOilDrum, defaults: DRUM_DEFAULTS, label: "Oil drum" },
  bamboo: { build: buildBambooPole, defaults: BAMBOO_POLE_DEFAULTS, label: "Bamboo pole", mat: MAT.bamboo },
  thatch: { build: buildThatchSlope, defaults: THATCH_DEFAULTS, label: "Thatch slope", mat: MAT.thatch },
};
