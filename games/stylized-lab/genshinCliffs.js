// GENSHIN CLIFFS (2026-10-09) — huge cliffs in the shape language of the
// alg-rts SANDSTONE rocks (games/alg-rts/algSandstone.js), which the user
// judged far better than flat slabs: rounded vertical LOBES split by deep
// JOINTS running up the sides, stepped STRATA, an undercut foot, a worn flat
// top. Genshin's big cliffs are that language at 15-40 m: tall grey columns
// between vertical cracks, broad rounded faces, flat grassy tops.
//
// PIECES come from the engine's rock generator (v3/props/proceduralRock.js,
// public) with its sandstone options, at Genshin proportions — joint widths
// in METRES scaled to the piece, so a 20 m wall gets 1 m cracks, not 30 cm
// scratches. A CLIFF is an ASSEMBLY of pieces (side by side, stacked, stepped
// back), merged into one mesh — how Genshin's modular cliffs are built. The
// pieces are generated in worker threads (prewarmRockGeometries).
import * as THREE from "three";
import { mergeGeometries, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { getRockGeometry, prewarmRockGeometries } from "../../v3/props/proceduralRock.js";

// squareness 5-5.5 + a slight egg (wider at the foot): straight, nearly vertical
// faces. At 3.8 the columns bulged in the middle and read as BARRELS.
const SAND = (o) => ({
  egg: -0.04, lump: 0.1, chips: 42, chipMin: 0.02, chipMax: 0.08, chipBias: 1.6, chipJitter: 0.75,
  bigCuts: 4, bigMin: 0.08, bigMax: 0.16, maxChipUp: 0.6, maxChipDown: 0.4,
  topCut: 0.2, baseCut: 0.1, edgeSoft: 0.028,
  undercut: 0.07, undercutHeight: 0.22, strata: 3, strataDepth: 0.035,
  joints: 5, jointDepth: 0.13, jointWidth: 1.0, topRelief: 0.02,
  detail: 110, targetTriangles: 9000, simplifyError: 0.004, shadeWeight: 1,
  ...o,
});

/** The pieces: half-extents in metres, joints sized to the piece. */
export const GENSHIN_PIECES = {
  // Wider and with a bigger top cut than first tried: at 4.6 x 13 the tallest
  // came out a pointed SPIKE, not a column with a flat grassy top.
  column: SAND({ sizeX: 5.4, sizeY: 11, sizeZ: 4.8, squareness: 5.5, egg: 0.05, lump: 0.06, topCut: 0.28, maxChipUp: 0.5, joints: 4, jointWidth: 1.1, jointDepth: 0.18, strata: 2 }),
  wall: SAND({ sizeX: 12, sizeY: 10, sizeZ: 5.5, squareness: 5, egg: 0.05, lump: 0.06, joints: 8, jointWidth: 1.3, jointDepth: 0.18, strata: 4 }),
  mesa: SAND({ sizeX: 11, sizeY: 4.5, sizeZ: 8.5, squareness: 4.2, topCut: 0.26, joints: 6, jointWidth: 1.0, strata: 3, undercut: 0.12, undercutHeight: 0.35 }),
  /** The smooth, few-faceted boulder of the references: soft, a joint or two. */
  boulder: SAND({ sizeX: 2.4, sizeY: 1.8, sizeZ: 2.0, squareness: 2.7, egg: 0.06, chips: 22, chipMax: 0.07, bigCuts: 3, topCut: 0.12, edgeSoft: 0.05, joints: 1, jointWidth: 0.3, jointDepth: 0.08, strata: 0, undercut: 0, topRelief: 0, detail: 70, targetTriangles: 2500 }),
};

/**
 * Assemblies: [piece, seed, x, y, z, yaw (rad), scale] in cliff-local metres,
 * front facing +Z. `y` lifts a piece (stepped-back pieces sit HIGHER, resting
 * on and overlapping the ones below). Pieces OVERLAP generously: a Genshin
 * cliff is one continuous mass, not standing stones (the first assembly had
 * gaps between its columns and read as a stone circle).
 * Rough piece heights at scale 1: column ~21 m, wall ~16 m, mesa ~7 m, boulder ~3 m.
 */
export const GENSHIN_CLIFFS = {
  grandWall: {
    label: "Grand wall — columns against a mass",
    parts: [
      ["wall", 6, 0, 0, -10, 0.03, 1.6],                 // the mass behind
      ["column", 2, -17, 0, -1, 0.15, 1.05], ["column", 4, -6, 0, 0, -0.1, 1.15],
      ["column", 5, 6, 0, -1, 0.12, 1.1], ["column", 7, 17, 0, -2, -0.2, 1.0],
      ["wall", 1, -27, 0, -7, 0.35, 1.0], ["wall", 3, 27, 0, -8, -0.35, 1.05],
    ],
  },
  stepped: {
    label: "Stepped mass — ledges climbing back",
    parts: [
      ["mesa", 11, 0, 0, 4, 0.1, 1.6],                   // the front ledge
      ["wall", 12, -2, 5, -8, -0.1, 1.15],               // rising behind it
      ["mesa", 13, 1, 19, -12, 0.1, 0.85],               // the top shelf (over its support: bigger read as a mushroom cap)
      ["column", 14, 18, 0, -3, 0.4, 0.95], ["column", 15, -19, 0, -2, -0.3, 0.9],
    ],
  },
  pillars: {
    label: "Pillar group — a broken buttress",
    parts: [
      ["mesa", 25, 0, 0, -4, 0, 1.2],                    // the plinth that ties them
      ["column", 21, -6, 2, 0, 0.2, 1.1], ["column", 22, 5, 2, -2, -0.5, 0.95],
      ["column", 23, -1, 4, -9, 1.1, 1.25], ["column", 24, 12, 0, 3, 0.8, 0.7],
    ],
  },
  boulders: {
    label: "Boulders — the smooth few-faceted ones",
    parts: [
      ["boulder", 31, 0, 0, 0, 0.3, 2.2], ["boulder", 32, 6, 0, -2, -0.6, 1.4], ["boulder", 33, -5, 0, 2, 1.2, 1.7],
      ["boulder", 34, 2, 0, 6, 2.0, 0.9], ["boulder", 35, -9, 0, -4, 0.7, 2.8], ["boulder", 36, 10, 0, 4, -1.4, 1.1],
    ],
  },
};


/**
 * Hillside pieces: lighter versions (the hillside places dozens), plus a SLAB —
 * a wide, thin layer that, tilted with the slope, reads as bedding following
 * the hill (the diagonal layers of the Genshin references).
 */
export const HILLSIDE_PIECES = {
  wall: { ...GENSHIN_PIECES.wall, targetTriangles: 3000, detail: 90 },
  column: { ...GENSHIN_PIECES.column, targetTriangles: 2600, detail: 90 },
  mesa: { ...GENSHIN_PIECES.mesa, targetTriangles: 2600, detail: 90 },
  // FACE: the riser dresser, read off the Genshin refs — a broad wall of a few
  // BIG flat facets (bigCuts, few small chips), long vertical cracks, a flat
  // cut top, no strata stripes. Scaled per step to the riser's full height.
  face: SAND({ sizeX: 14, sizeY: 12, sizeZ: 7, squareness: 3.4, egg: 0.03, lump: 0.1, chips: 14, chipMin: 0.05, chipMax: 0.14, bigCuts: 12, bigMin: 0.12, bigMax: 0.3, maxChipUp: 0.3, topCut: 0.14, baseCut: 0.05, edgeSoft: 0.008, undercut: 0, strata: 0, joints: 5, jointWidth: 1.6, jointDepth: 0.14, topRelief: 0.01, detail: 90, targetTriangles: 3500 }),
  slab: SAND({ sizeX: 9, sizeY: 2.6, sizeZ: 7, squareness: 4.4, topCut: 0.24, baseCut: 0.2, joints: 4, jointWidth: 0.9, strata: 1, undercut: 0.1, undercutHeight: 0.4, detail: 90, targetTriangles: 2000 }),
};
const HILLSIDE_SEEDS = [1, 2, 3];
const FACE_SEEDS = [1, 2, 3, 4, 5, 6];   // more variety: a riser chains dozens of faces

/**
 * The riser FACES (2026-10-09, second try): the rock generator's faces came
 * out soft and soapy at 30 m — it pushes a sphere out to chip planes, so it
 * only makes lumps. These come from the plane-SDF mesher (cliffSlabs.js,
 * style "face"): overlapping faceted blocks, diagonal shoulders, one flat cut
 * top — big flat planes with crisp bevelled edges, as in the refs. Built in
 * workers, ~1 s each.
 */
const FACE_CREASE = 0.5;   // radians
export const OUTCROP_OPTS = { style: "outcrop", voxel: 0.35, round: 0.15, warp: 0.5, targetTriangles: 7000 };
export const OUTCROP_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
export const PLATE_OPTS = { style: "plate", voxel: 0.3, round: 0.15, warp: 0.3, targetTriangles: 1500 };
export const PLATE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
export const FACE_OPTS = { style: "face", voxel: 0.4, round: 0.18, warp: 0.6, targetTriangles: 4500 };
const faceCache = new Map();
export async function prewarmSlabFaces(seeds = FACE_SEEDS, opts = FACE_OPTS) {
  const key = (sd) => `${opts.style}:${sd}`;
  const todo = seeds.filter((sd) => !faceCache.has(key(sd)));
  const n = Math.min(todo.length, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1));
  let next = 0;
  // ONE WORKER PER PIECE: in one thread the SDF mesher slows down call after
  // call (measured in Node: 1.5 s, 8 s, 21 s for three pieces; 1.4 s each in
  // fresh processes), so each piece gets a fresh worker.
  const one = (seed) => new Promise((resolve, reject) => {
    const w = new Worker(new URL("./faceWorker.js", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      w.terminate();
      if (e.data.error) { reject(new Error(e.data.error)); return; }
      let g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(e.data.position, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(e.data.normal, 3));
      g.setAttribute("rockShade", new THREE.BufferAttribute(e.data.rockShade, 2));
      g.setIndex(new THREE.BufferAttribute(e.data.index, 1));
      // CREASED normals: the simplified mesh's big triangles average normals
      // across each edge into a soft gradient; split them past ~30° so the
      // facets meet at crisp edges (non-indexed)
      g = toCreasedNormals(g, FACE_CREASE);
      g.userData = e.data.userData;
      g.computeBoundingBox();
      faceCache.set(key(seed), g);
      resolve();
    };
    w.postMessage({ id: seed, opts: { ...opts, seed } });
  });
  await Promise.all(Array.from({ length: n }, async () => { while (next < todo.length) await one(todo[next++]); }));
  return seeds.map((sd) => faceCache.get(key(sd)));
}

const pieceParams = (piece, seed) => ({ ...GENSHIN_PIECES[piece], seed });
const hillParams = (piece, seed) => ({ ...HILLSIDE_PIECES[piece], seed });

/** Generate every piece the assemblies (and the hillside) use, in worker threads. */
export function prewarmGenshinCliffs(names = Object.keys(GENSHIN_CLIFFS), { hillside = true } = {}) {
  const list = [];
  for (const n of names) for (const [piece, seed] of GENSHIN_CLIFFS[n].parts) list.push(pieceParams(piece, seed));
  if (hillside) for (const piece of Object.keys(HILLSIDE_PIECES)) for (const s of piece === "face" ? FACE_SEEDS : HILLSIDE_SEEDS) list.push(hillParams(piece, s));
  return prewarmRockGeometries(list);
}

/**
 * A piece placed by a full transform, carrying ITS OWN SPACE per vertex so the
 * material's photo relief and strata follow the piece however it is tilted:
 *   rockLocal  the vertex in the piece's scaled local frame (metres)
 *   rockQuat   the piece's rotation (the material turns normals with it)
 */
export function placePiece(src, pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = 1) {
  const g = src.clone();
  for (const k of Object.keys(g.attributes)) if (!["position", "normal", "rockShade", "nSmooth"].includes(k)) g.deleteAttribute(k);
  // nSmooth (the smooth normal, in the piece's own frame: the material turns it
  // with rockQuat) — the moss mask reads it; pieces without one use their normal
  if (!g.attributes.nSmooth) g.setAttribute("nSmooth", g.attributes.normal.clone());
  const n = g.attributes.position.count, p = g.attributes.position.array;
  const local = new Float32Array(n * 3), qa = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    local[i * 3] = p[i * 3] * scale; local[i * 3 + 1] = p[i * 3 + 1] * scale; local[i * 3 + 2] = p[i * 3 + 2] * scale;
    qa[i * 4] = quat.x; qa[i * 4 + 1] = quat.y; qa[i * 4 + 2] = quat.z; qa[i * 4 + 3] = quat.w;
  }
  g.setAttribute("rockLocal", new THREE.BufferAttribute(local, 3));
  g.setAttribute("rockQuat", new THREE.BufferAttribute(qa, 4));
  return g.applyMatrix4(new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(scale, scale, scale)));
}

/**
 * One assembly as ONE geometry (cliff-local, base at y = 0). `rockShade.y` is
 * re-baked over the WHOLE cliff's height, so the colour gradient runs top to
 * foot across every piece together, not per piece.
 */
export function buildGenshinCliff(name) {
  const def = GENSHIN_CLIFFS[name];
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const geos = def.parts.map(([piece, seed, x, y, z, yaw, s]) =>
    placePiece(getRockGeometry(pieceParams(piece, seed)), new THREE.Vector3(x, y, z), q.setFromAxisAngle(up, yaw).clone(), s));
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  geo.computeBoundingBox();
  const pos = geo.attributes.position.array, sh = geo.attributes.rockShade.array;
  const h = Math.max(1e-6, geo.boundingBox.max.y);
  for (let i = 0; i < pos.length / 3; i++) sh[i * 2 + 1] = pos[i * 3 + 1] / h;
  geo.computeBoundingSphere();
  geo.userData.cliff = { name, pieces: def.parts.length, triangles: geo.index ? geo.index.count / 3 : pos.length / 9, height: +h.toFixed(1) };
  return geo;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const HILLSIDE_DEFAULTS = {
  bands: [22, 31, 41, 52],  // contour heights (m) the outcrop bands follow
  bandJitter: 2.5,          // a band wanders up and down its contour (m)
  minSlope: 22,             // degrees: gentler ground, the band breaks
  steep: 36,                // degrees: past this, walls and columns; below, slabs and mesas
  gap: 0.42,                // share of each band left as grass (noise breaks)
  tilt: 0.7,                // how far a piece leans INTO the hill with the slope
  bury: [0.4, 0.55],        // fraction of the piece's height sunk into the hill
  scale: [0.55, 1.0],
  overlap: 0.55,            // advance along the band, as a fraction of a piece's width
  stack: 0.35,              // chance of a second, smaller piece on top, set back uphill
  edgeOn: 0.12,             // share of slabs turned on edge
  seed: 7,
};

/**
 * HILLSIDE ASSEMBLY — rock that comes OUT OF a slope, as Genshin builds it:
 * not a scatter but OUTCROP BANDS that follow the hill's contour lines, each
 * a chain of overlapping pieces showing one face downhill, their tops leaning
 * into the hill, grass slopes between the bands. Along each band (a contour
 * height, wandering a little):
 *   - the band breaks where the ground eases off, and in noise gaps
 *   - by steepness: walls and columns on the steep, slabs and mesas on the
 *     moderate (bedding that follows the hill)
 *   - each piece's long side runs ALONG the contour, its face (+Z) DOWNHILL,
 *     tilted about that axis into the slope; a small yaw and roll; a few slabs
 *     on edge; sometimes a second piece stacked behind and above
 *   - scaled (biggest mid-band), BURIED into the hill, advancing by about half
 *     a width so neighbours fuse into one face
 * Everything is merged into ONE geometry in world space.
 *
 * @param {object} o
 * @param {(x:number,z:number)=>number} o.height   world ground height
 * @param {(x:number,z:number)=>{x:number,y:number,z:number}} o.normal  ground normal
 * @param {{x0:number,x1:number,z0:number,z1:number}} o.region  bands run along x;
 *   the hill must rise toward -z inside it
 */
export function buildHillside({ height, normal, region, ...opts }) {
  const P = { ...HILLSIDE_DEFAULTS, ...opts };
  const rng = mulberry(P.seed * 7919 + 3);
  const geos = [];
  const deg = 180 / Math.PI;
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3();
  const counts = {};
  const placed = [];
  const noise1 = (t, s) => {
    const i = Math.floor(t), f = t - i, h = (k) => { const v = Math.sin((k + s * 131) * 127.1) * 43758.5453; return v - Math.floor(v); };
    const u = f * f * (3 - 2 * f);
    return h(i) * (1 - u) + h(i + 1) * u;
  };
  // z on the contour `level` at x: bisection from the foot (z1) up the hill (z0).
  const contourZ = (x, level) => {
    let lo = region.z1, hi = region.z0;
    if (height(x, lo) > level || height(x, hi) < level) return null;
    for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (height(x, m) < level) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const put = (piece, x, z, s, opt = {}) => {
    const seed = HILLSIDE_SEEDS[Math.floor(rng() * HILLSIDE_SEEDS.length)];
    const src = getRockGeometry(hillParams(piece, seed));
    if (!src.boundingBox) src.computeBoundingBox();
    const bb = src.boundingBox;
    const n = normal(x, z);
    const slopeRad = Math.acos(Math.min(1, n.y));
    const hl = Math.hypot(n.x, n.z) || 1;
    const yaw = Math.atan2(n.x / hl, n.z / hl);           // local +Z downhill, local X along the contour
    const q = new THREE.Quaternion().setFromAxisAngle(up, yaw + (rng() - 0.5) * 0.35);
    side.set(1, 0, 0).applyQuaternion(q);
    // A positive turn about local X tips +Y toward +Z (downhill), toward the
    // ground normal: the top and the layers come parallel to the slope.
    const lean = slopeRad * P.tilt * (opt.steep ? 0.35 : 1);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(side, lean));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (rng() - 0.5) * 0.2));
    if (piece === "slab" && rng() < P.edgeOn) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2 * 0.8));
    const h = (bb.max.y - bb.min.y) * s;
    const bury = P.bury[0] + (P.bury[1] - P.bury[0]) * rng();
    const pos = new THREE.Vector3(x, height(x, z) - bb.min.y * s - bury * h + (opt.lift ?? 0), z);
    geos.push(placePiece(src, pos, q, s));
    counts[piece] = (counts[piece] ?? 0) + 1;
    placed.push({ piece, x, z, s: +s.toFixed(2) });
    return { width: (bb.max.x - bb.min.x) * s, depth: (bb.max.z - bb.min.z) * s, h, dz: n.z / hl, dx: n.x / hl };
  };
  P.bands.forEach((level0, bi) => {
    let x = region.x0 + rng() * 6;
    while (x < region.x1) {
      const level = level0 + (noise1(x / 35, bi + 1) - 0.5) * 2 * P.bandJitter;
      const z = contourZ(x, level);
      const open = noise1(x / 28, bi + 20) > P.gap;          // grass gaps along the band
      if (z == null || !open) { x += 6; continue; }
      const n = normal(x, z);
      const slope = Math.acos(Math.min(1, n.y)) * deg;
      if (slope < P.minSlope) { x += 6; continue; }
      const steep = slope >= P.steep;
      const piece = steep ? (rng() < 0.7 ? "wall" : "column") : (rng() < 0.65 ? "slab" : "mesa");
      // biggest where the band is steepest
      const k = Math.min(1, (slope - P.minSlope) / 20);
      const s = P.scale[0] + (P.scale[1] - P.scale[0]) * (0.4 * rng() + 0.6 * k);
      const r = put(piece, x, z + (rng() - 0.5) * 2, s, { steep });
      if (rng() < P.stack) {
        // a smaller piece behind and above: the band gets a second step
        const back = r.depth * 0.45;
        put(rng() < 0.5 ? "slab" : "mesa", x + (rng() - 0.5) * r.width * 0.4 - r.dx * back, z - r.dz * back, s * 0.7, { lift: r.h * 0.15 });
      }
      x += r.width * P.overlap * (0.8 + 0.4 * rng());
    }
  });
  if (!geos.length) return null;
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.hillside = { pieces: geos.length, counts, triangles: geo.index.count / 3 };
  geo.userData.placed = placed;
  return geo;
}

/**
 * CLIFF SKIN — Genshin's land is flat plateaus stepped by near-vertical
 * risers, and the risers ARE the cliffs. This dresses a riser with FACE
 * pieces chained along it: traced on the riser's mid-height contour, each
 * piece faces downhill (+Z), is scaled so it spans the riser's FULL height,
 * its flat top a hair proud of the upper plateau's rim (grass runs right up to
 * it) and its foot sunk below the lower ground, its back buried in the hill,
 * tipped a few degrees forward so the rim overhangs (the refs' cut tops).
 *
 * A line is either
 *   { kind: "line", level, x0, x1, z0, z1 }  the hill rises toward -z (bisects z1 -> z0)
 *   { kind: "ring", level, cx, cz, r }   a butte: height falls outward from (cx, cz)
 *
 * @returns geometry (world space, one merge) or null
 */
export function buildCliffSkin({ height, normal, lines, seed = 11, overlap = 0.42, overhang = 0.06, rimLift = 0.4, bury = 0.35, faces = null, window = 18, yawJitter = 0.7 }) {
  const rng = mulberry(seed * 7919 + 5);
  const geos = [], placed = [];
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3();
  // find where `height` crosses `level` between a (above) and b (below)
  const cross = (ax, az, bx, bz, level) => {
    if (height(ax, az) < level || height(bx, bz) > level) return null;
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 26; k++) { const m = (t0 + t1) / 2; if (height(ax + (bx - ax) * m, az + (bz - az) * m) >= level) t0 = m; else t1 = m; }
    const t = (t0 + t1) / 2;
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t };
  };
  // "lineX": the hill rises toward +x (bisects x1 -> x0, t runs along z)
  const at = (L, t) => L.kind === "ring"
    ? cross(L.cx, L.cz, L.cx + Math.cos(t) * L.r, L.cz + Math.sin(t) * L.r, L.level)
    : L.kind === "lineX" ? cross(L.x1, t, L.x0, t, L.level)
    : cross(t, L.z0, t, L.z1, L.level);
  for (const L of lines) {
    const ring = L.kind === "ring";
    const t0 = ring ? rng() * Math.PI * 2 : L.kind === "lineX" ? L.z0 : L.x0, t1 = ring ? t0 + Math.PI * 2 * 0.97 : L.kind === "lineX" ? L.z1 : L.x1;
    let t = t0;
    while (t < t1) {
      const p = at(L, t);
      if (!p) { t += ring ? 0.1 : 6; continue; }
      const n = normal(p.x, p.z);
      const hl = Math.hypot(n.x, n.z) || 1, dx = n.x / hl, dz = n.z / hl;    // downhill
      // the riser's top (upper rim) and foot, sampled across it
      let top = -Infinity, foot = Infinity;
      for (let k = -window; k <= window; k += 1) { const h = height(p.x + dx * k, p.z + dz * k); if (k < 0) top = Math.max(top, h); else foot = Math.min(foot, h); }
      // the slab faces when given (prewarmSlabFaces), else the rock generator's
      const src = faces?.length ? faces[Math.floor(rng() * faces.length)] : getRockGeometry(hillParams("face", FACE_SEEDS[Math.floor(rng() * FACE_SEEDS.length)]));
      if (!src.boundingBox) src.computeBoundingBox();
      const bb = src.boundingBox, ph = bb.max.y - bb.min.y;
      const span = top - foot;
      const s = Math.max(0.6, ((span + rimLift) / (1 - bury * 0.5)) / ph) * (0.9 + 0.35 * rng());
      // yaw jitter: neighbours meet at angles, so the face breaks into big facets
      const q = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(dx, dz) + (rng() - 0.5) * yawJitter);
      side.set(1, 0, 0).applyQuaternion(q);
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(side, overhang * (0.5 + rng())));
      // set back into the hill so the face stands at the riser, not in front of it
      // The piece's FRONT goes at the riser's measured FOOT (where the ground
      // has come down to within 1.5 m of the lower level), staggered 0-3 m
      // out into the lower ground: the riser is then wholly behind the rock.
      let kFoot = 0;
      while (kFoot < window && height(p.x + dx * kFoot, p.z + dz * kFoot) > foot + 1.5) kFoot += 0.5;
      const fwd = kFoot + rng() * 3 - bb.max.z * s;
      const pos = new THREE.Vector3(p.x + dx * fwd, top + rimLift - bb.max.y * s, p.z + dz * fwd);
      geos.push(placePiece(src, pos, q, s));
      const width = (bb.max.x - bb.min.x) * s;
      placed.push({ x: p.x, z: p.z, s: +s.toFixed(2), span: +span.toFixed(1) });
      const step = width * overlap * (0.8 + 0.4 * rng());
      // on a ring the faces' fronts fan apart outward: step shorter
      t += ring ? (step * 0.7) / Math.max(5, Math.hypot(p.x - L.cx, p.z - L.cz)) : step;
    }
  }
  if (!geos.length) return null;
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.skin = { pieces: geos.length, triangles: (geo.index ? geo.index.count : geo.attributes.position.count) / 3 };
  geo.userData.placed = placed;
  return geo;
}

/**
 * OUTCROPS ON A MOUNTAIN — the Zelda / Genshin way: the land is a natural
 * mountain and the rock comes out of it wherever it is STEEP. Scan the
 * region, steepest ground first; at each spot steeper than `minSlope` put an
 * outcrop (cliffSlabs.js "outcrop": shingled plates over a host): facing
 * downhill (+Z), turned a little, leaned with the slope by `lean` x its
 * angle, sized by how steep it is, sunk `bury` of its height into the hill
 * (its top falls away into the slope behind), spaced so neighbours overlap
 * into one rock band. One merged world-space geometry.
 */
export function buildOutcrops({ height, normal, region, pieces, step = 5, minSlope = 40, fullSlope = 55, scale = [0.6, 1.3], lean = 0.3, bury = 0.3, spacing = 0.85, maxPieces = 28, seed = 5 }) {
  const rng = mulberry(seed * 7919 + 9);
  const deg = 180 / Math.PI, up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3();
  const cands = [];
  for (let z = region.z0; z <= region.z1; z += step) for (let x = region.x0; x <= region.x1; x += step) {
    const px = x + (rng() - 0.5) * step, pz = z + (rng() - 0.5) * step;
    const n = normal(px, pz), slope = Math.acos(Math.min(1, n.y)) * deg;
    if (slope >= minSlope) cands.push({ x: px, z: pz, slope, n });
  }
  cands.sort((a, b) => b.slope - a.slope);
  const placed = [], geos = [];
  for (const c of cands) {
    if (geos.length >= maxPieces) break;
    const src = pieces[Math.floor(rng() * pieces.length)];
    const bb = src.boundingBox;
    const k = Math.min(1, (c.slope - minSlope) / (fullSlope - minSlope));
    const s = scale[0] + (scale[1] - scale[0]) * (0.35 * rng() + 0.65 * k);
    const r = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5 * s;
    if (placed.some((e) => (e.x - c.x) ** 2 + (e.z - c.z) ** 2 < ((e.r + r) * spacing) ** 2)) continue;
    const hl = Math.hypot(c.n.x, c.n.z) || 1, dx = c.n.x / hl, dz = c.n.z / hl;
    const q = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(dx, dz) + (rng() - 0.5) * 0.6);
    side.set(1, 0, 0).applyQuaternion(q);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(side, (c.slope / deg) * lean));
    const h = (bb.max.y - bb.min.y) * s;
    const pos = new THREE.Vector3(c.x, height(c.x, c.z) - bb.min.y * s - bury * h, c.z);
    geos.push(placePiece(src, pos, q, s));
    placed.push({ x: c.x, z: c.z, r, s: +s.toFixed(2), slope: Math.round(c.slope) });
  }
  if (!geos.length) return null;
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.outcrops = { pieces: geos.length, candidates: cands.length, triangles: (geo.index ? geo.index.count : geo.attributes.position.count) / 3 };
  geo.userData.placed = placed;
  return geo;
}

/**
 * PLATE SKIN — rock that takes the MOUNTAIN'S OWN SHAPE (2026-10-09, after
 * separate outcrops read as things parked on a smooth cone): big chopped
 * plates (cliffSlabs.js "plate", ~10 x 18 m) laid over the steep ground,
 * overlapping like shingles. Each plate:
 *   - faces along the terrain normal, stood `stand` of the way up toward
 *     vertical (rock faces steeper than the ground: their tops make ledges)
 *   - its long side up the slope, rolled to a regional diagonal GRAIN
 *     (smooth noise, so neighbours share it) +- a little
 *   - stands `protrude` metres proud of the surface, the rest buried
 * Steepest ground first; coverage ramps from `minSlope` (scattered) to
 * `fullSlope` (closed). `rockShade.y` is re-baked from WORLD height so the
 * light-top / blue-foot gradient runs over the whole mountain, not per plate.
 */
export function buildPlateSkin({ height, normal, region, pieces, step = 5, minSlope = 40, fullSlope = 52, scale = [1.0, 1.8], stand = 0.6, protrude = [0.4, 2.5], spacing = 0.55, grainScale = 120, maxPlates = 350, shadeLo = 12, shadeHi = 110, seed = 3 }) {
  const rng = mulberry(seed * 7919 + 21);
  const deg = 180 / Math.PI;
  const smooth01 = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const vn = (x, z) => {   // smooth value noise for the grain field
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    const h = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453; return v - Math.floor(v); };
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    return (h(xi, zi) * (1 - ux) + h(xi + 1, zi) * ux) * (1 - uz) + (h(xi, zi + 1) * (1 - ux) + h(xi + 1, zi + 1) * ux) * uz;
  };
  const cands = [];
  for (let z = region.z0; z <= region.z1; z += step) for (let x = region.x0; x <= region.x1; x += step) {
    const px = x + (rng() - 0.5) * step, pz = z + (rng() - 0.5) * step;
    const n = normal(px, pz), slope = Math.acos(Math.min(1, n.y)) * deg;
    if (slope < minSlope) continue;
    if (rng() > smooth01(minSlope, fullSlope, slope) * 0.9 + 0.1) continue;
    cands.push({ x: px, z: pz, slope, n });
  }
  cands.sort((a, b) => b.slope - a.slope);
  const placed = [], geos = [];
  const F = new THREE.Vector3(), U = new THREE.Vector3(), X = new THREE.Vector3(), H = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  const M = new THREE.Matrix4(), ctr = new THREE.Vector3();
  // spatial hash for the spacing test
  const cell = 12, grid = new Map();
  for (const c of cands) {
    if (geos.length >= maxPlates) break;
    const src = pieces[Math.floor(rng() * pieces.length)];
    const bb = src.boundingBox;
    const k = smooth01(minSlope, fullSlope, c.slope);
    const s = scale[0] + (scale[1] - scale[0]) * (0.4 * rng() + 0.6 * k);
    const r = 0.5 * Math.min(bb.max.x - bb.min.x, bb.max.y - bb.min.y) * s;
    let clash = false;
    const gx = Math.floor(c.x / cell), gz = Math.floor(c.z / cell);
    for (let a = -2; a <= 2 && !clash; a++) for (let b = -2; b <= 2 && !clash; b++) {
      for (const e of grid.get(`${gx + a},${gz + b}`) ?? []) if ((e.x - c.x) ** 2 + (e.z - c.z) ** 2 < ((e.r + r) * spacing) ** 2) { clash = true; break; }
    }
    if (clash) continue;
    // frame: front = terrain normal stood up toward horizontal; up = uphill
    const hl = Math.hypot(c.n.x, c.n.z) || 1;
    H.set(c.n.x / hl, 0, c.n.z / hl);
    F.set(c.n.x, c.n.y, c.n.z).lerp(H, stand).normalize();
    U.copy(UP).addScaledVector(F, -F.dot(UP)).normalize();
    const grain = (vn(c.x / grainScale, c.z / grainScale) - 0.5) * 0.9 + (rng() - 0.5) * 0.2;
    U.applyAxisAngle(F, grain);
    X.crossVectors(U, F).normalize();
    M.makeBasis(X, U, F);
    const q = new THREE.Quaternion().setFromRotationMatrix(M);
    // the plate's front is its local z = max; centre it in x / y
    ctr.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z).multiplyScalar(s).applyQuaternion(q);
    const out = protrude[0] + (protrude[1] - protrude[0]) * rng() * (0.5 + 0.5 * k);
    const pos = new THREE.Vector3(c.x, height(c.x, c.z), c.z).addScaledVector(c.n, out).sub(ctr);
    geos.push(placePiece(src, pos, q, s));
    const e = { x: c.x, z: c.z, r, s: +s.toFixed(2), slope: Math.round(c.slope) };
    placed.push(e);
    const key = `${gx},${gz}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(e);
  }
  if (!geos.length) return null;
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  const pos = geo.attributes.position.array, sh = geo.attributes.rockShade.array;
  for (let i = 0; i < pos.length / 3; i++) sh[i * 2 + 1] = Math.min(1, Math.max(0, (pos[i * 3 + 1] - shadeLo) / (shadeHi - shadeLo)));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.skin = { plates: geos.length, candidates: cands.length, triangles: (geo.index ? geo.index.count : pos.length / 3) / 3 };
  geo.userData.placed = placed;
  return geo;
}
