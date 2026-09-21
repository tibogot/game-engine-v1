/**
 * Procedural stylized rocks — "knapped" boulders / rocks / pebbles: a rounded
 * egg covered in shallow flat chips with slightly softened chip edges.
 *
 * Radial construction: every vertex of a dense sphere is pushed out along its
 * direction to where the surface is — the nearer of the egg and every chip
 * plane, combined with a soft min so chip edges round off instead of stair-
 * stepping along the sphere grid. The shape is convex from its centre, which
 * is exactly what these rocks are, so the radial form is exact.
 *
 * Output: INDEXED, smooth-shared vertices, position + normal, base at y=0,
 * sized in metres. Simplified with meshoptimizer when the WASM is loaded.
 */
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { simplifyGeometry, simplifierReady } from "../render/instancing/autoLod.js";

let _simplifierLoaded = false;
simplifierReady.then(() => { _simplifierLoaded = true; });

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_ROCK_PARAMS = {
  seed: 1,
  /** Metres: half-extents of the base egg (x, y = up, z). */
  sizeX: 0.8,
  sizeY: 1.0,
  sizeZ: 0.7,
  /** + = wider at the bottom (egg), − = wider at the top. */
  egg: 0.15,
  /** Low-frequency lumpiness of the base shape, fraction of size. */
  lump: 0.08,
  /** Number of chip planes. */
  chips: 36,
  /** Chip depth range, fraction of the radius at that direction. */
  chipMin: 0.02,
  chipMax: 0.16,
  /** >1 = mostly shallow chips with a few deep ones. */
  chipBias: 1.6,
  /** Direction jitter of chips (0 = regular Fibonacci spacing). */
  chipJitter: 0.35,
  /** Extra big, deep cuts that break the silhouette. */
  bigCuts: 0,
  /** Depth range of the big cuts, fraction of radius. */
  bigMin: 0.15,
  bigMax: 0.3,
  /**
   * Chips aimed FURTHER DOWN than this are skipped, as maxChipUp does above.
   * 1 = no limit, which is every existing preset's behaviour.
   *
   * It exists for FLAT bodies, and the reason is geometric. A chip's plane
   * takes the radius direction as its normal and the radius length as its
   * offset — which for a sphere is the tangent plane and cuts nothing it
   * should not. On a slab the radius direction and the true surface normal
   * diverge hard near the short axis, so a plane placed against the thin top
   * (offset ~0.85 m) stays perpendicular to that radius and slices straight
   * through the wide middle: a 7 m slab came out 3.3 m. Keeping chips near the
   * equator keeps every plane's offset large, and the flat faces a slab wants
   * come from topCut/baseCut anyway.
   */
  maxChipDown: 1,
  /**
   * ONE FLAT VERTICAL FACE, as if the rock had split, 0 = none.
   *
   * Every plane here carves the WHOLE body — the surface is a soft min over
   * half-spaces — so a plane through the middle does not open a cleft, it
   * slices the rock and keeps one side. A split boulder therefore cannot be
   * one mesh; what it can be is one HALF, which is the more useful prop
   * anyway: alone it reads as a rock whose other half weathered away, and two
   * of them at opposing `sliceYaw` set a few metres apart read as a boulder
   * that split. The flat faces match because they are the same cut.
   *
   * Fraction of the radius in that direction, like a chip.
   */
  sliceCut: 0,
  /** Which way the flat face looks, radians. */
  sliceYaw: 0,
  /** Flat base cut depth, fraction of sizeY (0 = round bottom). */
  baseCut: 0.12,
  /** Flat TOP cut depth, fraction of sizeY (0 = none). Cliffs: ~0.3. */
  topCut: 0,
  /** Chips facing more upward than this are skipped (keeps a cut top flat). */
  maxChipUp: 1,
  /** Body profile: 2 = ellipsoid, higher = straighter walls, flatter caps. */
  squareness: 2,
  /** Chip edge softness, fraction of mean size. */
  edgeSoft: 0.012,
  /** Sphere tessellation (IcosahedronGeometry detail). */
  detail: 40,
  /** Triangle target after simplification. */
  targetTriangles: 1500,
  /** Max surface deviation allowed by the simplifier, fraction of mean size. */
  simplifyError: 0.004,
  /** rockShade bake: neighbour blur passes (widens the edge band). */
  shadeBlur: 2,
  /** How strongly the simplifier protects the baked edge band (0 = not at all;
   *  1 costs +36% triangles on a boulder, 2.4× on a pebble). */
  shadeWeight: 0,
};

/**
 * Bake `rockShade` (vec2) on the dense mesh, read by rockShading.js:
 *   x = edge curvature, +1 convex chip edge … −1 concave crease, 0 flat
 *   y = height within the shape, 0 bottom … 1 top (object space, so it
 *       follows the instance's scale and rotation)
 * Curvature per vertex = mean of n·(pj − pi)/|pj − pi| over its edges: 0 on a
 * flat facet, negative where neighbours fall away (a convex edge). A couple of
 * neighbour blurs widen the band past the one-vertex ring of the soft edge.
 */
function _bakeShade(geo, p) {
  const pos = geo.getAttribute("position").array;
  const nrm = geo.getAttribute("normal").array;
  const idx = geo.getIndex().array;
  const vc = pos.length / 3;
  const sum = new Float32Array(vc), cnt = new Uint16Array(vc);
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
  // raw bend (≈ sin of half the dihedral angle), independent of tessellation
  // for a sharp chip edge; the shader thresholds it, so tuning needs no rebake
  let curv = new Float32Array(vc);
  for (let i = 0; i < vc; i++) {
    const v = cnt[i] ? sum[i] / cnt[i] : 0;
    curv[i] = Math.max(-1, Math.min(1, -v));
  }
  for (let it = 0; it < p.shadeBlur; it++) {
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
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < vc; i++) { const y = pos[i * 3 + 1]; if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
  const shade = new Float32Array(vc * 2);
  const inv = 1 / Math.max(1e-6, yMax - yMin);
  for (let i = 0; i < vc; i++) {
    shade[i * 2] = curv[i];
    shade[i * 2 + 1] = (pos[i * 3 + 1] - yMin) * inv;
  }
  geo.setAttribute("rockShade", new THREE.BufferAttribute(shade, 2));
}

/**
 * @param {Partial<typeof DEFAULT_ROCK_PARAMS>} params
 * @returns {THREE.BufferGeometry}
 */
export function createRockGeometry(params = {}) {
  const p = { ...DEFAULT_ROCK_PARAMS, ...params };
  const t0 = performance.now();
  const rng = mulberry32(p.seed * 9173 + 29);
  const meanSize = (p.sizeX + p.sizeY + p.sizeZ) / 3;

  // low-frequency lumps: a few random cosine lobes over the sphere
  const lobes = [];
  for (let i = 0; i < 5; i++) {
    const v = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();
    lobes.push({ v, amp: (rng() * 2 - 1) * p.lump, sharp: 1 + rng() * 2 });
  }

  // radial distance of the base egg along unit direction (x, y, z)
  const eggR = (x, y, z) => {
    const ey = 1 + p.egg * -y; // wider where y < 0
    const ax = p.sizeX * ey, az = p.sizeZ * ey;
    let r;
    if (p.squareness === 2) {
      r = 1 / Math.sqrt((x / ax) ** 2 + (y / p.sizeY) ** 2 + (z / az) ** 2);
    } else {
      // superellipsoid: straighter walls and flatter caps, still curved
      // everywhere so chips stay local
      const e = p.squareness;
      r = 1 / Math.pow(
        Math.pow(Math.abs(x / ax), e) + Math.pow(Math.abs(y / p.sizeY), e) + Math.pow(Math.abs(z / az), e),
        1 / e,
      );
    }
    let l = 0;
    for (const o of lobes) {
      const c = Math.max(0, o.v.x * x + o.v.y * y + o.v.z * z);
      l += o.amp * Math.pow(c, o.sharp);
    }
    return r * (1 + l);
  };

  // chip planes: evenly spread directions (Fibonacci sphere, random rotation,
  // jitter) so chips cover the whole rock with similar spacing
  const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 6.283, rng() * 6.283, rng() * 6.283));
  const planes = [];
  const n = Math.max(0, Math.floor(p.chips));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const tmp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const rr = Math.sqrt(1 - y * y);
    const th = i * golden;
    tmp.set(Math.cos(th) * rr, y, Math.sin(th) * rr);
    const j = p.chipJitter;
    tmp.x += (rng() - 0.5) * j; tmp.y += (rng() - 0.5) * j; tmp.z += (rng() - 0.5) * j;
    tmp.normalize().applyQuaternion(rot);
    const depth = p.chipMin + (p.chipMax - p.chipMin) * Math.pow(rng(), p.chipBias);
    if (tmp.y > p.maxChipUp || tmp.y < -p.maxChipDown) continue;
    planes.push(tmp.x, tmp.y, tmp.z, eggR(tmp.x, tmp.y, tmp.z) * (1 - depth));
  }
  for (let i = 0; i < p.bigCuts; i++) {
    // mostly on the sides and upper half — the lower half is buried or in shade
    tmp.set(rng() * 2 - 1, rng() * 1.4 - 0.5, rng() * 2 - 1).normalize();
    const depth = p.bigMin + (p.bigMax - p.bigMin) * rng();
    if (tmp.y > p.maxChipUp || tmp.y < -p.maxChipDown) continue;
    planes.push(tmp.x, tmp.y, tmp.z, eggR(tmp.x, tmp.y, tmp.z) * (1 - depth));
  }
  if (p.sliceCut > 0) {
    const sx = Math.cos(p.sliceYaw), sz = Math.sin(p.sliceYaw);
    planes.push(sx, 0, sz, eggR(sx, 0, sz) * (1 - p.sliceCut));
  }
  if (p.baseCut > 0) planes.push(0, -1, 0, p.sizeY * (1 - p.baseCut));
  if (p.topCut > 0) planes.push(0, 1, 0, p.sizeY * (1 - p.topCut));
  const P = new Float64Array(planes);
  const pc = P.length / 4;

  // dense indexed sphere
  let geo = new THREE.IcosahedronGeometry(1, Math.max(4, Math.floor(p.detail)));
  geo.deleteAttribute("normal");
  geo.deleteAttribute("uv");
  geo = mergeVertices(geo);
  const pos = geo.getAttribute("position");

  const k = Math.max(1e-5, p.edgeSoft * meanSize);
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    const re = eggR(x, y, z);
    // soft min of the ray's exit distances (egg + every plane it faces)
    let m = re;
    const ts = [re];
    for (let j = 0, o = 0; j < pc; j++, o += 4) {
      const dn = P[o] * x + P[o + 1] * y + P[o + 2] * z;
      if (dn <= 1e-4) continue;
      const t = P[o + 3] / dn;
      if (t < m + k * 8) { ts.push(t); if (t < m) m = t; }
    }
    let s = 0;
    for (const t of ts) s += Math.exp(-(t - m) / k);
    const r = m - k * Math.log(s);
    pos.setXYZ(i, x * r, y * r, z * r);
  }
  geo.computeVertexNormals();
  _bakeShade(geo, p);
  const denseTris = geo.getIndex().count / 3;

  if (_simplifierLoaded && denseTris > p.targetTriangles) {
    geo.computeBoundingBox();
    const size = new THREE.Vector3();
    geo.boundingBox.getSize(size);
    const extent = Math.max(size.x, size.y, size.z);
    geo = simplifyGeometry(geo, {
      ratio: p.targetTriangles / denseTris,
      error: (p.simplifyError * meanSize) / extent,
      minTriangles: 48,
      // keep the edge band: without a weight the collapse spreads a chip
      // edge's highlight across the whole neighbouring facet
      attributeWeights: { rockShade: p.shadeWeight },
    });
  }
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.rock = {
    denseTriangles: denseTris,
    triangles: geo.getIndex().count / 3,
    simplified: _simplifierLoaded,
    ms: +(performance.now() - t0).toFixed(1),
  };
  return geo;
}

/**
 * Shape presets. Budgets are LOD0 triangles; auto-LOD builds LOD1/LOD2 from it.
 * `simplifyError` is generous on purpose: the budget decides, not the error.
 */
export const ROCK_PRESETS = {
  boulder: { sizeX: 0.85, sizeY: 1.1, sizeZ: 0.75, egg: 0.18, chips: 55, chipMax: 0.1, chipBias: 2.2, chipJitter: 0.7, bigCuts: 5, edgeSoft: 0.006, targetTriangles: 1200, simplifyError: 0.02, shadeWeight: 1 },
  lump:    { sizeX: 1.1, sizeY: 0.75, sizeZ: 0.9, egg: 0.1, chips: 45, chipMax: 0.12, chipBias: 2.2, chipJitter: 0.7, bigCuts: 4, edgeSoft: 0.006, baseCut: 0.2, targetTriangles: 1000, simplifyError: 0.02, shadeWeight: 1 },
  rock:    { sizeX: 0.55, sizeY: 0.35, sizeZ: 0.45, egg: 0.05, chips: 22, chipMin: 0.04, chipMax: 0.2, chipJitter: 0.7, bigCuts: 2, edgeSoft: 0.008, baseCut: 0.18, detail: 28, targetTriangles: 400, simplifyError: 0.03 },
  pebble:  { sizeX: 0.18, sizeY: 0.1, sizeZ: 0.14, egg: 0, chips: 12, chipMin: 0.06, chipMax: 0.25, chipJitter: 0.7, edgeSoft: 0.01, baseCut: 0.2, detail: 16, targetTriangles: 120, simplifyError: 0.05 },
  /**
   * MEGALITH — the jungle boulder, 6-13 m. Not a scaled-up boulder.
   *
   * Scaling `boulder` up by six does not work, and the reason is written at
   * the top of the cliff presets: a chip cut `d` deep into a body of radius
   * `R` spreads about sqrt(2Rd), so depth expressed as a FRACTION of radius
   * grows its facet with the rock. A boulder's chipMax of 0.1 gives a
   * pleasant 20 cm facet at 2 m and a 1.2 m crater at 12 m — the shape stops
   * reading as stone and starts reading as a low-poly blob.
   *
   * So the chips get shallower (0.018-0.06 instead of 0.02-0.1) and far more
   * numerous, the simplifier's error budget drops below the chip depth, and
   * the triangle budget sits between a boulder's 1,200 and a cliff's 8,000.
   * It keeps the boulder's ROUNDED egg rather than the cliff's flat-topped
   * mesa: this is a rock you walk around, not one you stand on.
   */
  megalith: {
    sizeX: 3.1, sizeY: 2.7, sizeZ: 2.8, egg: 0.14,
    // SILHOUETTE FIRST. The first attempt kept the boulder's lump of 0.07 and
    // came out a smooth faceted EGG — and the giveaway was the outline, not
    // the surface. A low-poly rock with an irregular silhouette reads as stone
    // however broad its facets are; a regular one reads as a gemstone however
    // fine they get. So the low-frequency lumps more than double and the big
    // cuts, which are the only thing that actually bites into the outline, go
    // from five to eight and get deeper.
    lump: 0.17, squareness: 2.1,
    chips: 170, chipMin: 0.01, chipMax: 0.035, chipBias: 1.7, chipJitter: 0.75,
    bigCuts: 8, bigMin: 0.06, bigMax: 0.15, maxChipUp: 0.85,
    baseCut: 0.14, edgeSoft: 0.005,
    // A facet spreads ~sqrt(2Rd), so on a 3 m radius the 0.035 chip above
    // gives ~0.8 m facets: coarse enough to stay cheap, fine enough that the
    // 14 px/m camera sees several across each face.
    // detail 60 is the cliff presets' own figure and it is proven at this
    // scale; 68 was tried and took the tab out generating five of them at once
    // (the raw mesh is ~95k triangles BEFORE the simplifier sees it, and five
    // of those at once is half a million).
    detail: 60, targetTriangles: 4800, simplifyError: 0.006, shadeWeight: 1,
  },
};

/**
 * How each size class behaves in the world, for thousands of instances:
 *  lodScale          — multiplies the global LOD/fade distances (a pebble is
 *                      not worth drawing at 500 m like a building)
 *  maxShadowCascade  — last CSM cascade this class casts into
 *  collide           — "solid" real triangles, "box" proxy, "none"
 */
export const ROCK_CLASSES = {
  boulder: { lodScale: 1,    maxShadowCascade: Infinity, collide: "solid" },
  lump:    { lodScale: 1,    maxShadowCascade: Infinity, collide: "solid" },
  rock:    { lodScale: 0.5,  maxShadowCascade: 1,        collide: "box" },
  pebble:  { lodScale: 0.2,  maxShadowCascade: 0,        collide: "none" },
  // A landmark: worth drawing, and worth a shadow, from anywhere on the map.
  megalith: { lodScale: 2.2, maxShadowCascade: Infinity, collide: "solid" },
};

/**
 * The kit: a small pool of shapes per class. Each entry is one prop type
 * (~6 draws when on screen); instances vary it by rotation and scale.
 */
export const ROCK_KIT = [
  ...[1, 2, 3, 4].map((seed, i) => ({ name: `Rock: Boulder ${"ABCD"[i]}`, cls: "boulder", seed })),
  ...[1, 2, 3].map((seed, i) => ({ name: `Rock: Lump ${"ABC"[i]}`, cls: "lump", seed })),
  ...[1, 2, 3].map((seed, i) => ({ name: `Rock: Stone ${"ABC"[i]}`, cls: "rock", seed })),
  ...[1, 2].map((seed, i) => ({ name: `Rock: Pebble ${"AB"[i]}`, cls: "pebble", seed })),
  // Landmarks. Each carries its own proportions rather than relying on an
  // instance scale, because a megalith stretched on one axis reads as a
  // stretched TEXTURE — the facets go with it.
  { name: "Rock: Megalith A", cls: "megalith", seed: 11 },
  { name: "Rock: Megalith B", cls: "megalith", seed: 12, sizeX: 4.2, sizeY: 3.1, sizeZ: 3.6 },
  { name: "Rock: Megalith C", cls: "megalith", seed: 13, sizeX: 2.6, sizeY: 3.6, sizeZ: 2.4, egg: 0.2 },
  // Karst towers: taller than wide, undercut (negative egg), the shape that
  // says "limestone" and the one people picture when they picture Vietnam.
  { name: "Rock: Karst A", cls: "megalith", seed: 21, sizeX: 2.9, sizeY: 5.4, sizeZ: 2.6, egg: -0.16, squareness: 2.1 },
  { name: "Rock: Karst B", cls: "megalith", seed: 22, sizeX: 3.8, sizeY: 6.6, sizeZ: 3.2, egg: -0.22, squareness: 2.2 },
  // SLABS. Wide and low, which is the shape that reads best from directly
  // above — you are looking at the roof, and a slab is almost all roof. The
  // flat top also gives infantry something that looks like it should be stood
  // on, which is worth more than another round boulder.
  { name: "Rock: Slab A", cls: "megalith", seed: 31, sizeX: 3.5, sizeY: 0.85, sizeZ: 2.5, egg: 0.02, squareness: 2.7, topCut: 0.22, baseCut: 0.3, bigCuts: 5, maxChipUp: 0.3, maxChipDown: 0.3 },
  { name: "Rock: Slab B", cls: "megalith", seed: 32, sizeX: 4.6, sizeY: 1.15, sizeZ: 3.0, egg: 0.02, squareness: 2.9, topCut: 0.26, baseCut: 0.3, bigCuts: 6, maxChipUp: 0.3, maxChipDown: 0.3 },
  // SPLIT halves, cut on opposing faces so a pair set a few metres apart reads
  // as one boulder that came apart. Either works alone.
  { name: "Rock: Split A", cls: "megalith", seed: 41, sizeX: 2.9, sizeY: 3.1, sizeZ: 2.7, sliceCut: 0.42, sliceYaw: 0 },
  { name: "Rock: Split B", cls: "megalith", seed: 41, sizeX: 2.9, sizeY: 3.1, sizeZ: 2.7, sliceCut: 0.42, sliceYaw: Math.PI },
];

/**
 * Cliffs are the SAME generator: a lump, wider at the top (negative egg),
 * straighter walls, chipped, with a flat walkable top cut. Being proven —
 * the strata presets stay until then.
 */
// Facet size follows chip DEPTH (a cut d deep on a body of radius R spreads
// ~sqrt(2Rd)), so cliff-scale facets of 2-5 m need many SHALLOW chips, few
// big cuts, and a simplifier error budget below the chip depth.
const CLIFF_BASE = {
  egg: -0.3, lump: 0.06, squareness: 2.4,
  chips: 160, chipMin: 0.02, chipMax: 0.06, chipBias: 1.3, chipJitter: 0.7,
  bigCuts: 4, bigMin: 0.06, bigMax: 0.12, maxChipUp: 0.7,
  topCut: 0.3, baseCut: 0.15, edgeSoft: 0.006,
  detail: 60, targetTriangles: 8000, simplifyError: 0.006, shadeWeight: 1,
};
export const ROCK_CLIFF_PRESETS = [
  { name: "Cliff: Chip Pillar", generator: "rock", params: { ...CLIFF_BASE, seed: 1, sizeX: 9, sizeY: 21, sizeZ: 8, egg: -0.25, topCut: 0.28 } },
  { name: "Cliff: Chip Slab",   generator: "rock", params: { ...CLIFF_BASE, seed: 2, sizeX: 18, sizeY: 12, sizeZ: 10, topCut: 0.35 } },
  { name: "Cliff: Chip Mesa",   generator: "rock", params: { ...CLIFF_BASE, seed: 3, sizeX: 16, sizeY: 10, sizeZ: 14, egg: -0.2, topCut: 0.4 } },
  { name: "Cliff: Chip Block",  generator: "rock", params: { ...CLIFF_BASE, seed: 5, sizeX: 18, sizeY: 12, sizeZ: 10, topCut: 0.35, squareness: 3 } },
];

/** Geometry for a kit entry by name, or null. */
export function createRockKitGeometry(name) {
  const params = rockKitParams(name);
  return params ? getRockGeometry(params) : null;
}

/** Generator params of a kit entry by name, or null. */
export function rockKitParams(name) {
  const entry = ROCK_KIT.find((k) => k.name === name);
  if (!entry) return null;
  // Per-entry overrides ride on top of the class, so one class can carry a
  // family of proportions without a preset each.
  const { name: _n, cls: _c, ...overrides } = entry;
  return { ...ROCK_PRESETS[entry.cls], ...overrides };
}

/**
 * Memoised createRockGeometry: the panel thumbnails and the prop type share
 * one generation (a cliff is ~0.7 s). Only SIMPLIFIED results are kept — one
 * made before the meshoptimizer WASM loaded is dense and must not stick.
 * The geometry is shared, so callers must not dispose or mutate it.
 */
const _geometryCache = new Map();
export function getRockGeometry(params) {
  const key = JSON.stringify(params);
  const hit = _geometryCache.get(key);
  if (hit) return hit;
  const geo = createRockGeometry(params);
  if (geo.userData.rock.simplified || geo.userData.rock.denseTriangles <= (params.targetTriangles ?? 0)) {
    _geometryCache.set(key, geo);
  }
  return geo;
}
