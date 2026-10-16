// CLIFFS FROM SLABS — the Genshin-style cliff (2026-10-09): big FLAT planes,
// stacked and side by side, meeting at crisp-but-softened edges, with a clear
// hierarchy (a few huge planes, a few medium cuts, almost no small noise).
//
// Why not the engine's rock generator (v3/props/proceduralRock.js): it pushes
// a sphere out to the nearest of many chip planes, so everything it makes is
// ONE rounded lump — boulders yes, but never a ledge, a stack or a sheet. Four
// cliff attempts on it failed for that reason. This builds a signed-distance
// field instead:
//
//   slab   a convex block: its 6 box planes + a few random CUT planes, joined
//          by a SMOOTH max (log-sum-exp) — exactly flat away from the edges,
//          rounded over ~`round` metres at them (the soft bevel)
//   cliff  a COMPOSITION of slabs (union = min), placed by a rule: stacked
//          strata, vertical sheets, a block mass, a pillar cluster
//   warp   a gentle low-frequency bend, so no face is a perfect CAD plane
//
// then meshes it with SURFACE NETS (one vertex per surface cell, quads across
// sign changes — no lookup tables), takes normals from the field's gradient
// (smooth, and truly flat on the planes), bakes `rockShade` (x = convexity,
// y = height 0..1) for the material, and simplifies to a triangle budget.
//
// Plain three + the public simplifier: runs in Node for the tests.
import * as THREE from "three";
import { simplifyGeometry } from "../../v3/render/instancing/autoLod.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 3D value noise (Math.imul hashing — without it value noise repeats in bands).
function hash3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise3(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, s);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), ux), l(c(0, 1, 0), c(1, 1, 0), ux), uy),
    l(l(c(0, 0, 1), c(1, 0, 1), ux), l(c(0, 1, 1), c(1, 1, 1), ux), uy), uz) * 2 - 1;
}

/**
 * One slab: an oriented box (centre, half sizes, yaw/tilt) with extra cut
 * planes. Stored as plane normals + offsets in WORLD (cliff-local) space.
 */
function makeSlab(rng, { center, half, yaw = 0, tiltX = 0, tiltZ = 0, cuts = 3, cutDepth = [0.1, 0.35], topFlat = true, cutFront = 0 }) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, yaw, tiltZ));
  const planes = [];
  const add = (nLocal, d) => {
    const n = nLocal.clone().applyQuaternion(q).normalize();
    planes.push({ n, d: d + n.dot(center) });
  };
  add(new THREE.Vector3(1, 0, 0), half.x); add(new THREE.Vector3(-1, 0, 0), half.x);
  add(new THREE.Vector3(0, 1, 0), half.y); add(new THREE.Vector3(0, -1, 0), half.y);
  add(new THREE.Vector3(0, 0, 1), half.z); add(new THREE.Vector3(0, 0, -1), half.z);
  // CUTS: planes through a corner region, so they chop corners and edges into
  // the big secondary facets. Kept off the top when `topFlat` (a walkable ledge).
  for (let i = 0; i < cuts; i++) {
    // `cutFront`: cuts OBLIQUE to the front (35-60° off +Z, any direction
    // around it), so they carve diagonal facets into the FACE seen from the
    // front — a cut near +Z only tilts the whole front into one plane, and a
    // random one mostly lands on hidden backs
    let n;
    if (cutFront) {
      const th = rng() * Math.PI * 2, ph = 0.6 + rng() * 0.45;
      n = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th) * (topFlat ? 0.45 : 1), Math.cos(ph)).normalize();
    } else {
      n = new THREE.Vector3(rng() * 2 - 1, (rng() * 2 - 1) * (topFlat ? 0.45 : 1), rng() * 2 - 1).normalize();
    }
    // Support of the box along n, then pulled in by a fraction of it.
    const support = Math.abs(n.x) * half.x + Math.abs(n.y) * half.y + Math.abs(n.z) * half.z;
    const depth = cutDepth[0] + (cutDepth[1] - cutDepth[0]) * rng();
    add(n, support * (1 - depth));
  }
  return planes;
}

/**
 * A slab packed for speed: planes as a flat array [nx, ny, nz, d, …], plus a
 * bounding sphere — a point farther than `r + margin` from the centre cannot
 * beat a nearer slab, so the min-union skips it (the grid is mostly far away).
 */
function packSlab(planes, center, half) {
  const a = new Float64Array(planes.length * 4);
  planes.forEach((p, i) => { a[i * 4] = p.n.x; a[i * 4 + 1] = p.n.y; a[i * 4 + 2] = p.n.z; a[i * 4 + 3] = p.d; });
  return { a, n: planes.length, cx: center.x, cy: center.y, cz: center.z, r: half.length() };
}

/** Smooth max of plane distances: flat faces, edges rounded over ~k·ln(2) m. No allocation. */
const _d = new Float64Array(64);
function slabSdf(s, x, y, z, k) {
  const a = s.a, n = s.n;
  let m = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = a[i * 4] * x + a[i * 4 + 1] * y + a[i * 4 + 2] * z - a[i * 4 + 3];
    _d[i] = d;
    if (d > m) m = d;
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.exp((_d[i] - m) / k);
  return m + k * Math.log(sum);
}


/**
 * A faceted PRISM for the kit pieces: `sides` planes around Y (radius R
 * along x, Rz along z, each pulled in by up to `jitter`), leaning inward by
 * `taper` (the normal's downward part: the prism narrows as it goes down;
 * negative widens it), between a flat top at `top` and a bottom at `bot`.
 * Returned as a slab def with explicit planes.
 */
function kitPrism(rng, { cx, cz, R, Rz = R, top, bot, sides, taper, jitter = 0.18, chisel = 0 }) {
  const planes = [];
  // CHISEL planes: tilted 20-35° up or down off vertical, cutting the
  // prism's corners into DIAGONAL facets — neighbouring vertical sides differ
  // too little in angle to read as facets on their own
  for (let i = 0; i < chisel; i++) {
    const a = rng() * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    const ny = (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.2);
    const r = (R * Rz) / Math.hypot(Rz * dx, R * dz) * (0.9 + rng() * 0.1);
    const yc = bot + (top - bot) * (0.25 + rng() * 0.65);
    const n = new THREE.Vector3(dx, ny, dz).normalize();
    planes.push({ n, d: n.dot(new THREE.Vector3(cx + dx * r, yc, cz + dz * r)) });
  }
  const a0 = rng() * Math.PI * 2;
  for (let i = 0; i < sides; i++) {
    const a = a0 + (i + (rng() - 0.5) * 0.6) * (Math.PI * 2) / sides;
    const dx = Math.cos(a), dz = Math.sin(a);
    const r = (R * Rz) / Math.hypot(Rz * dx, R * dz) * (1 - jitter * rng());
    const n = new THREE.Vector3(dx, -taper, dz).normalize();
    const P = new THREE.Vector3(cx + dx * r, top, cz + dz * r);
    planes.push({ n, d: n.dot(P) });
  }
  planes.push({ n: new THREE.Vector3(0, 1, 0), d: top });
  planes.push({ n: new THREE.Vector3(0, -1, 0), d: -bot });
  const hr = Math.max(R, Rz) * (1 + Math.max(0, taper) * 0.1), hy = (top - bot) / 2;
  return { planes, center: new THREE.Vector3(cx, (top + bot) / 2, cz), half: new THREE.Vector3(hr, hy, hr) };
}

/**
 * COMPOSITIONS — each returns slab definitions in cliff-local metres, base at
 * y ≈ 0, front facing +Z. `size` scales the whole thing.
 */
export const CLIFF_STYLES = {
  /** Horizontal-ish thick layers, each stepped back and smaller: ledges. */
  strata(rng, s) {
    const out = [];
    let y = 0, w = 22 * s, d = 12 * s, zBack = 0;
    const n = 4 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const h = (3.2 + rng() * 2.4) * s;
      const xo = (rng() - 0.5) * 3 * s;
      out.push({ center: new THREE.Vector3(xo, y + h / 2, zBack - d / 2), half: new THREE.Vector3(w / 2, h / 2, d / 2), yaw: (rng() - 0.5) * 0.25, tiltX: (rng() - 0.5) * 0.06, tiltZ: (rng() - 0.5) * 0.08, cuts: 3 });
      y += h * 0.92;
      w *= 0.78 + rng() * 0.12;
      zBack -= (1.2 + rng() * 2.2) * s;   // each layer steps back: a ledge in front
    }
    return out;
  },
  /** Tall vertical sheets side by side, each its own height and angle — a cliff face. */
  sheets(rng, s) {
    const out = [];
    let x = -14 * s;
    while (x < 14 * s) {
      const w = (3 + rng() * 4.5) * s, h = (14 + rng() * 10) * s, d = (6 + rng() * 5) * s;
      out.push({ center: new THREE.Vector3(x + w / 2, h / 2 - 1, (rng() - 0.5) * 2.5 * s - d / 2), half: new THREE.Vector3(w / 2, h / 2, d / 2), yaw: (rng() - 0.5) * 0.35, tiltX: -0.04 - rng() * 0.08, cuts: 2 + Math.floor(rng() * 2), topFlat: false, cutDepth: [0.06, 0.22] });
      x += w * (0.75 + rng() * 0.2);
    }
    return out;
  },
  /** One massive block with a lower front step and big cuts. */
  block(rng, s) {
    const W = 18 * s, H = 13 * s, D = 13 * s;
    return [
      { center: new THREE.Vector3(0, H / 2, -D / 2), half: new THREE.Vector3(W / 2, H / 2, D / 2), yaw: (rng() - 0.5) * 0.2, cuts: 5, cutDepth: [0.12, 0.3] },
      { center: new THREE.Vector3(-W * 0.18, H * 0.22, 1.5 * s), half: new THREE.Vector3(W * 0.32, H * 0.22, 3 * s), yaw: 0.25 + (rng() - 0.5) * 0.2, cuts: 3 },
      { center: new THREE.Vector3(W * 0.33, H * 0.62, -D * 0.35), half: new THREE.Vector3(W * 0.22, H * 0.25, D * 0.4), yaw: -0.2, tiltZ: 0.06, cuts: 3 },
    ];
  },
  /** A cluster of columns of different heights — a broken buttress. */
  pillars(rng, s) {
    const out = [];
    const n = 5 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, r = rng() * 5 * s;
      const w = (2.8 + rng() * 2.4) * s, h = (8 + rng() * 14) * s;
      out.push({ center: new THREE.Vector3(Math.cos(a) * r, h / 2 - 1, Math.sin(a) * r - 4 * s), half: new THREE.Vector3(w / 2, h / 2, w / 2 * (0.8 + rng() * 0.4)), yaw: rng() * Math.PI, tiltX: (rng() - 0.5) * 0.08, tiltZ: (rng() - 0.5) * 0.08, cuts: 3 });
    }
    return out;
  },
  /**
   * FACE — the riser dresser, read off the Genshin refs (2026-10-09): a wall
   * of tall FACETED blocks (each a box chopped by 6 deep cuts at all angles,
   * so it is a polyhedron, not a box), side by side and overlapping, each its
   * own yaw and forward lean, staggered in and out; one or two big DIAGONAL
   * shoulder blocks across them; and ONE flat cut across the top (`top`), so
   * the rim is level for the plateau's grass to meet. Front faces +Z.
   */
  face(rng, s) {
    const W = 28 * s, H = 24 * s;
    const out = [];
    let x = -W / 2 - 2 * s;
    while (x < W / 2) {
      const w = (7 + rng() * 7) * s, h = H * (0.95 + rng() * 0.3), d = (8 + rng() * 6) * s;
      out.push({
        center: new THREE.Vector3(x + w / 2, h / 2 - 2 * s, (rng() - 0.5) * 4 * s - d / 2),
        half: new THREE.Vector3(w / 2, h / 2, d / 2),
        yaw: (rng() - 0.5) * 0.8, tiltX: -0.03 + rng() * 0.12, tiltZ: (rng() - 0.5) * 0.2,
        // few DEEP cuts, aimed at the front: big facets on the visible face
        // (many shallow ones chamfer corners round)
        cuts: 4, cutDepth: [0.2, 0.45], topFlat: false, cutFront: 1.2,
      });
      x += w * (0.6 + rng() * 0.25);
    }
    const nShoulder = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < nShoulder; i++) {
      const w = (9 + rng() * 6) * s, h = (6 + rng() * 5) * s, d = (6 + rng() * 4) * s;
      out.push({
        center: new THREE.Vector3((rng() - 0.5) * W * 0.6, H * (0.25 + rng() * 0.45), 1.5 * s - d / 2),
        half: new THREE.Vector3(w / 2, h / 2, d / 2),
        yaw: (rng() - 0.5) * 0.6, tiltX: rng() * 0.15, tiltZ: (rng() < 0.5 ? -1 : 1) * (0.35 + rng() * 0.3),
        cuts: 3, cutDepth: [0.25, 0.5], topFlat: false, cutFront: 1,
      });
    }
    out.top = H - (1 + rng() * 1.5) * s;
    return out;
  },
  /**
   * OUTCROP — the Genshin rock, read off the spire ref (2026-10-09, fourth
   * try): the formation IS a stack of big PLATES — slabs 10-25 m long, a few
   * metres thick — all LEANING one way (a shared diagonal grain), side by side
   * and each a step in front of / below the last like a tilted deck of cards,
   * so the face is a dozen large facets with stepped edges between them. (Small
   * plates glued on a box read as tiles on a block — tried, rejected.) A hidden
   * block behind fills the gaps. Front faces +Z (downhill); the backs sink
   * into the hill; the base goes below y = 0 (buried).
   */
  outcrop(rng, s) {
    const W = 26 * s, H = 22 * s, D = 12 * s;
    const out = [];
    const dir = rng() < 0.5 ? -1 : 1;
    const grain = dir * (0.3 + rng() * 0.3);                        // the lean the plates share
    // hidden back fill
    out.push({ center: new THREE.Vector3(0, H * 0.3, -D * 0.75), half: new THREE.Vector3(W * 0.45, H * 0.45, D * 0.5), yaw: 0, tiltX: -0.3, tiltZ: grain * 0.4, cuts: 3, cutDepth: [0.15, 0.3], topFlat: false });
    const n = 6 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n - 0.5 + (rng() - 0.5) * 0.08;          // across the face
      const long = (0.45 + rng() * 0.45) * H, wide = (0.1 + rng() * 0.08) * W + 2 * s, thick = (1.2 + rng() * 1.6) * s;
      // the middle plates stand tallest; each steps forward/back a little
      const mid = 1 - Math.abs(u) * 1.3;
      out.push({
        center: new THREE.Vector3(u * W, long * 0.45 * (0.6 + 0.6 * mid) - 2 * s, -thick - rng() * 2.5 * s),
        half: new THREE.Vector3(wide / 2, long / 2, thick + D * 0.25),
        yaw: (rng() - 0.5) * 0.3,
        tiltX: -0.12 - rng() * 0.22,
        tiltZ: grain + (rng() - 0.5) * 0.15,
        cuts: 2, cutDepth: [0.3, 0.55], topFlat: false, cutFront: 1,
      });
    }
    // two or three plates lying with the slope over the top: the formation's crown
    const caps = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < caps; i++) {
      out.push({
        center: new THREE.Vector3((rng() - 0.5) * W * 0.6, H * (0.45 + rng() * 0.2), -D * (0.35 + rng() * 0.3)),
        half: new THREE.Vector3((4 + rng() * 4) * s, (1.2 + rng()) * s, (5 + rng() * 3) * s),
        yaw: (rng() - 0.5) * 0.4, tiltX: -(0.35 + rng() * 0.3), tiltZ: grain * 0.6,
        cuts: 2, cutDepth: [0.3, 0.5], topFlat: false,
      });
    }
    return out;
  },
  /**
   * PLATE — one facet of the terrain-hugging rock skin (genshinCliffs.js
   * buildPlateSkin): a chopped slab, front +Z, its long side along Y; a
   * second smaller chunk sometimes stacked on it for a stepped edge.
   */
  plate(rng, s) {
    const a = (5 + rng() * 3) * s, b = (6 + rng() * 4) * s, t = 3.5 * s;
    const out = [{ center: new THREE.Vector3(0, 0, -t), half: new THREE.Vector3(a, b, t), yaw: 0, tiltX: 0, tiltZ: 0, cuts: 3, cutDepth: [0.25, 0.5], topFlat: false, cutFront: 1 }];
    if (rng() < 0.6) {
      out.push({ center: new THREE.Vector3((rng() - 0.5) * a, (rng() - 0.5) * b, -t * 0.6 + 0.8 * s), half: new THREE.Vector3(a * 0.5, b * 0.45, t * 0.6), yaw: (rng() - 0.5) * 0.3, tiltX: (rng() - 0.5) * 0.3, tiltZ: (rng() - 0.5) * 0.4, cuts: 2, cutDepth: [0.25, 0.45], topFlat: false, cutFront: 1 });
    }
    return out;
  },
  // ── THE KIT (2026-10-09, from the user's Fab-pack refs) ───────────────────
  // A Genshin-style world is built from a FEW strong pieces, reused, scaled,
  // rotated: cliff chunks with a FLAT grassy top and a slightly overhanging
  // rim, sides of long mostly-VERTICAL facets that TAPER downward (column,
  // inverted cone, wide ledge), and faceted boulders / pillars with grass
  // caps. Each piece is a union of faceted PRISMS (kitPrism: N side planes
  // leaning inward with depth, a shared flat top) plus a thin LIP prism at
  // the top a little wider than the body. Origin: base at y = 0 after
  // meshing; the flat top is the piece's max y.
  // Tall bodies (the bottom is buried in use); FEW big sides (7-9) with deep
  // radius jitter + CHISEL planes, so the facets differ in angle and catch
  // the light differently (many near-parallel sides read smooth); almost no
  // downward taper (more reads as hanging teeth); no separate rim (a wider
  // rim prism read as a table top) — the light rim is the material's edge.
  kitColumn(rng, s) {
    const R = 6 * s, top = 16 * s, bot = -12 * s, out = [];
    out.push(kitPrism(rng, { cx: 0, cz: 0, R, top, bot, sides: 8, taper: 0.03, jitter: 0.22, chisel: 4 }));
    const n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, d = R * (0.55 + rng() * 0.2);
      out.push(kitPrism(rng, { cx: Math.cos(a) * d, cz: Math.sin(a) * d, R: R * (0.45 + rng() * 0.2), top: top - (0.3 + rng() * 3) * s, bot, sides: 7, taper: 0.04, jitter: 0.22, chisel: 2 }));
    }
    return out;
  },
  kitCone(rng, s) {
    const R = 8 * s, top = 14 * s, bot = -14 * s, out = [];
    out.push(kitPrism(rng, { cx: 0, cz: 0, R, Rz: R * 0.85, top, bot, sides: 8, taper: 0.3, jitter: 0.22, chisel: 4 }));
    out.push(kitPrism(rng, { cx: R * (rng() - 0.5) * 0.7, cz: R * (rng() - 0.5) * 0.5, R: R * 0.55, top: top - 0.5 * s, bot: bot - 2 * s, sides: 7, taper: 0.38, jitter: 0.22, chisel: 2 }));
    return out;
  },
  kitLedge(rng, s) {
    const R = 6 * s, top = 7 * s, bot = -12 * s, out = [];
    const n = 3 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * R * 1.05 + (rng() - 0.5) * R * 0.3;
      out.push(kitPrism(rng, { cx: x, cz: (rng() - 0.5) * R * 0.5, R: R * (0.75 + rng() * 0.3), top: top - rng() * 1.5 * s, bot, sides: 8, taper: 0.05 + rng() * 0.05, jitter: 0.22, chisel: 3 }));
    }
    return out;
  },
  kitBoulder(rng, s) {
    // faceted all round (random plane normals), cut flat on top for a grass cap
    const R = 2.6 * s, planes = [];
    const n = 14;
    for (let i = 0; i < n; i++) {
      const y = rng() * 1.6 - 0.8, a = rng() * Math.PI * 2, h = Math.sqrt(1 - y * y);
      const nv = new THREE.Vector3(Math.cos(a) * h, y * 0.7, Math.sin(a) * h).normalize();
      planes.push({ n: nv, d: R * (0.82 + rng() * 0.18) });
    }
    planes.push({ n: new THREE.Vector3(0, 1, 0), d: R * (0.45 + rng() * 0.25) });
    return [{ planes, center: new THREE.Vector3(0, 0, 0), half: new THREE.Vector3(R, R, R) }];
  },
};

export const CLIFF_DEFAULTS = {
  style: "strata",
  seed: 1,
  size: 1,
  round: 0.28,          // bevel softness (m)
  warp: 0.45,           // amplitude of the gentle bend (m)
  warpScale: 0.06,      // 1/m
  voxel: 0.3,           // meshing resolution (m)
  targetTriangles: 6000,
  simplifyError: 0.004,
};

/**
 * @param {Partial<typeof CLIFF_DEFAULTS>} opts
 * @returns {THREE.BufferGeometry} indexed; position, normal, rockShade (vec2); base at y = 0
 */
export function createSlabCliff(opts = {}) {
  const P = { ...CLIFF_DEFAULTS, ...opts };
  const t0 = performance.now();
  const rng = mulberry32(P.seed * 7919 + 17);
  const defs = (CLIFF_STYLES[P.style] ?? CLIFF_STYLES.strata)(rng, P.size);
  const slabs = defs.map((d) => packSlab(d.planes ?? makeSlab(rng, d), d.center, d.half));
  const k = P.round / Math.LN2;
  const top = Number.isFinite(defs.top) ? defs.top : null;
  const ws = P.warpScale, wa = P.warp, seed = P.seed;
  const sdf = (x, y, z) => {
    // the gentle bend: displace the sample point by smooth noise
    const px = x + wa * vnoise3(x * ws, y * ws, z * ws, seed + 11);
    const py = y + wa * 0.5 * vnoise3(x * ws, y * ws, z * ws, seed + 12);
    const pz = z + wa * vnoise3(x * ws, y * ws, z * ws, seed + 13);
    let m = Infinity;
    for (const s of slabs) {
      // A slab's field is never less than (distance to its centre − its radius):
      // if even that bound cannot beat the current min, skip the plane loop.
      const bound = Math.hypot(px - s.cx, py - s.cy, pz - s.cz) - s.r - P.round;
      if (bound >= m) continue;
      const v = slabSdf(s, px, py, pz, k);
      if (v < m) m = v;
    }
    if (top !== null) {
      // the flat cut top: smooth max with the plane y = top (same bevel)
      const t = py - top, hi = Math.max(m, t);
      m = hi + k * Math.log(Math.exp((m - hi) / k) + Math.exp((t - hi) / k));
    }
    return m;
  };

  // Bounds: every slab's corners, padded.
  const box = new THREE.Box3();
  for (const d of defs) {
    const r = d.half.length();
    box.expandByPoint(d.center.clone().addScalar(r));
    box.expandByPoint(d.center.clone().addScalar(-r));
  }
  box.expandByScalar(wa + P.round + 2 * P.voxel);
  if (top !== null) box.max.y = Math.min(box.max.y, top + wa + P.round + 2 * P.voxel);
  const h = P.voxel;
  const nx = Math.ceil((box.max.x - box.min.x) / h) + 1;
  const ny = Math.ceil((box.max.y - box.min.y) / h) + 1;
  const nz = Math.ceil((box.max.z - box.min.z) / h) + 1;
  const ox = box.min.x, oy = box.min.y, oz = box.min.z;
  const val = new Float32Array(nx * ny * nz);
  const id = (i, j, kk) => (kk * ny + j) * nx + i;
  // NARROW BAND. Only the sign matters away from the surface, and the field
  // changes at most ~LIP metres per metre (a distance field, bent a little by
  // the warp). So: a grid 4x coarser first; a coarse cell whose corners are all
  // farther from zero than LIP x its diagonal cannot hold the surface, and its
  // fine points take the corner's value (right sign) instead of the full field.
  const CS = 4, LIP = 1 + 2 * wa * ws * 4;
  const cx = Math.ceil((nx - 1) / CS) + 1, cy = Math.ceil((ny - 1) / CS) + 1, cz = Math.ceil((nz - 1) / CS) + 1;
  const coarse = new Float32Array(cx * cy * cz);
  const kid = (i, j, kk) => (kk * cy + j) * cx + i;
  for (let kk = 0; kk < cz; kk++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    coarse[kid(i, j, kk)] = sdf(ox + i * CS * h, oy + j * CS * h, oz + kk * CS * h);
  }
  const far = LIP * CS * h * Math.sqrt(3);
  let exact = 0;
  for (let ck = 0; ck < cz - 1; ck++) for (let cj = 0; cj < cy - 1; cj++) for (let ci = 0; ci < cx - 1; ci++) {
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < 8; c++) {
      const v = coarse[kid(ci + (c & 1), cj + ((c >> 1) & 1), ck + ((c >> 2) & 1))];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const empty = lo > far || hi < -far;
    const fill = empty ? (lo > far ? lo : hi) : 0;
    for (let kk = ck * CS; kk <= Math.min(nz - 1, ck * CS + CS); kk++) for (let j = cj * CS; j <= Math.min(ny - 1, cj * CS + CS); j++) for (let i = ci * CS; i <= Math.min(nx - 1, ci * CS + CS); i++) {
      const g = id(i, j, kk);
      if (empty) { if (val[g] === 0) val[g] = fill; continue; }
      if (val[g] !== 0 && Math.abs(val[g]) < far) continue;     // shared face, already exact
      val[g] = sdf(ox + i * h, oy + j * h, oz + kk * h) || 1e-6;
      exact++;
    }
  }

  // ── SURFACE NETS: a vertex per cell the surface crosses ──
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i, j, kk) => (kk * (ny - 1) + j) * (nx - 1) + i;
  const pos = [];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let kk = 0; kk < nz - 1; kk++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const v = val[id(i + (c & 1), j + ((c >> 1) & 1), kk + ((c >> 2) & 1))];
      cv[c] = v;
      if (v < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of EDGES) {
      const va = cv[a], vb = cv[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      const ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1;
      const bx = b & 1, by = (b >> 1) & 1, bz = (b >> 2) & 1;
      sx += ax + (bx - ax) * t; sy += ay + (by - ay) * t; sz += az + (bz - az) * t;
      n++;
    }
    cellVert[cid(i, j, kk)] = pos.length / 3;
    pos.push(ox + (i + sx / n) * h, oy + (j + sy / n) * h, oz + (kk + sz / n) * h);
  }
  // Quads across every grid edge with a sign change (the 4 cells around it).
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
  };
  for (let kk = 1; kk < nz - 1; kk++) for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = val[id(i, j, kk)] < 0, b = val[id(i + 1, j, kk)] < 0;
    if (a === b) continue;
    quad(cellVert[cid(i, j - 1, kk - 1)], cellVert[cid(i, j, kk - 1)], cellVert[cid(i, j, kk)], cellVert[cid(i, j - 1, kk)], !a);
  }
  for (let kk = 1; kk < nz - 1; kk++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = val[id(i, j, kk)] < 0, b = val[id(i, j + 1, kk)] < 0;
    if (a === b) continue;
    quad(cellVert[cid(i - 1, j, kk - 1)], cellVert[cid(i - 1, j, kk)], cellVert[cid(i, j, kk)], cellVert[cid(i, j, kk - 1)], !a);
  }
  for (let kk = 0; kk < nz - 1; kk++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = val[id(i, j, kk)] < 0, b = val[id(i, j, kk + 1)] < 0;
    if (a === b) continue;
    quad(cellVert[cid(i - 1, j - 1, kk)], cellVert[cid(i, j - 1, kk)], cellVert[cid(i, j, kk)], cellVert[cid(i - 1, j, kk)], !a);
  }

  let geo = new THREE.BufferGeometry();
  const posArr = new Float32Array(pos);
  geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  geo.setIndex(idx);
  // Normals from the field's gradient: smooth, and exactly flat on the planes.
  const vc = posArr.length / 3, nrm = new Float32Array(vc * 3), e = h * 0.5;
  for (let v = 0; v < vc; v++) {
    const x = posArr[v * 3], y = posArr[v * 3 + 1], z = posArr[v * 3 + 2];
    const gx = sdf(x + e, y, z) - sdf(x - e, y, z);
    const gy = sdf(x, y + e, z) - sdf(x, y - e, z);
    const gz = sdf(x, y, z + e) - sdf(x, y, z - e);
    const l = Math.hypot(gx, gy, gz) || 1;
    nrm[v * 3] = gx / l; nrm[v * 3 + 1] = gy / l; nrm[v * 3 + 2] = gz / l;
  }
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  // Wind every triangle to its gradient normal (surface nets' quad order can
  // come out either way at grid boundaries).
  const ix = geo.index.array, A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3();
  for (let t = 0; t < ix.length; t += 3) {
    A.fromArray(posArr, ix[t] * 3); B.fromArray(posArr, ix[t + 1] * 3); C.fromArray(posArr, ix[t + 2] * 3);
    N.subVectors(B, A).cross(C.sub(A));
    const gn = nrm[ix[t] * 3] * N.x + nrm[ix[t] * 3 + 1] * N.y + nrm[ix[t] * 3 + 2] * N.z;
    if (gn < 0) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
  }

  bakeShade(geo);
  const dense = geo.index.count / 3;
  if (dense > P.targetTriangles) {
    geo.computeBoundingBox();
    const ext = geo.boundingBox.getSize(new THREE.Vector3()).length();
    geo = simplifyGeometry(geo, { ratio: P.targetTriangles / dense, error: P.simplifyError * 20 / Math.max(1, ext), minTriangles: 64, attributeWeights: { rockShade: 1 } });
  }
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.cliff = { style: P.style, seed: P.seed, slabs: slabs.length, grid: [nx, ny, nz], dense, triangles: geo.index.count / 3, ms: Math.round(performance.now() - t0) };
  return geo;
}

/**
 * `rockShade` (vec2) — the same contract as the engine's rock kit:
 *   x  convexity: + on a convex edge (catches light), − in a crease, 0 flat
 *   y  height in the piece, 0 bottom … 1 top
 * Convexity per vertex = mean of n·(neighbour − v)/|…| over its edges,
 * negated, then two neighbour blurs to widen the band past one ring.
 */
function bakeShade(geo) {
  const pos = geo.attributes.position.array, nrm = geo.attributes.normal.array, idx = geo.index.array;
  const vc = pos.length / 3, sum = new Float32Array(vc), cnt = new Uint16Array(vc);
  const edge = (a, b) => {
    const dx = pos[b * 3] - pos[a * 3], dy = pos[b * 3 + 1] - pos[a * 3 + 1], dz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const l = Math.hypot(dx, dy, dz) || 1;
    sum[a] += (nrm[a * 3] * dx + nrm[a * 3 + 1] * dy + nrm[a * 3 + 2] * dz) / l;
    cnt[a]++;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    edge(a, b); edge(b, a); edge(b, c); edge(c, b); edge(c, a); edge(a, c);
  }
  let curv = new Float32Array(vc);
  for (let i = 0; i < vc; i++) curv[i] = cnt[i] ? Math.max(-1, Math.min(1, -sum[i] / cnt[i])) : 0;
  for (let it = 0; it < 2; it++) {
    const acc = new Float32Array(vc), n = new Uint16Array(vc);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      acc[a] += curv[b] + curv[c]; n[a] += 2;
      acc[b] += curv[a] + curv[c]; n[b] += 2;
      acc[c] += curv[a] + curv[b]; n[c] += 2;
    }
    const next = new Float32Array(vc);
    for (let i = 0; i < vc; i++) next[i] = n[i] ? (curv[i] + acc[i] / n[i]) * 0.5 : curv[i];
    curv = next;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < vc; i++) { const y = pos[i * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
  const shade = new Float32Array(vc * 2), inv = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < vc; i++) { shade[i * 2] = curv[i]; shade[i * 2 + 1] = (pos[i * 3 + 1] - lo) * inv; }
  geo.setAttribute("rockShade", new THREE.BufferAttribute(shade, 2));
}
