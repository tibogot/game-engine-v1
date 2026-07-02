/**
 * Procedural Genshin-style strata cliffs — debug/placeholder kit until real
 * sculpted GLB cliffs exist. Shape language: stacked horizontal rock layers
 * (strata) with per-layer radius jitter, offset drift, occasional overhangs,
 * sharp flat-shaded edges and a near-flat walkable top cap.
 *
 * Output is a plain BufferGeometry (non-indexed, flat normals, cylindrical-ish
 * UVs) registered through the normal prop pipeline, so the whole kit can later
 * be swapped for imported GLBs without touching anything downstream.
 */
import * as THREE from "three";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_CLIFF_PARAMS = {
  seed: 1,
  height: 20,
  radius: 8,
  /** X stretch of the footprint (1 = round, >1 = elongated wall). */
  aspect: 1,
  /** Number of horizontal rock layers. */
  strata: 10,
  /** Top radius as a fraction of base radius (1 = no taper). */
  taper: 0.55,
  /** Per-layer radius random-walk strength. */
  jitter: 0.3,
  /** Chance a layer juts out wider than the one below (overhang). */
  overhangChance: 0.12,
  /** 0 = round footprint, 1 = rounded-square footprint. */
  squareness: 0.35,
  /** Radial segments around the footprint. */
  segments: 26,
  /** Per-layer inward bevel at each stratum top (sharp erosion edge). */
  bevel: 0.965,
  /** Max per-layer XZ centre drift, as a fraction of radius. */
  offsetJitter: 0.06,
};

/**
 * @param {Partial<typeof DEFAULT_CLIFF_PARAMS>} params
 * @returns {THREE.BufferGeometry} base sits at y=0, pivot at footprint centre
 */
export function createProceduralCliffGeometry(params = {}) {
  const p = { ...DEFAULT_CLIFF_PARAMS, ...params };
  const rng = mulberry32(p.seed * 7919 + 17);
  const n = Math.max(2, Math.floor(p.strata));
  const segs = Math.max(8, Math.floor(p.segments));

  // ── Footprint shape: superellipse squareness × low-order harmonics ─────────
  const m = 2 + p.squareness * 8;
  const harmonics = [];
  for (let k = 2; k <= 5; k++) {
    harmonics.push({
      k,
      amp: (p.jitter * 0.5 * rng()) / k,
      phase: rng() * Math.PI * 2,
      drift: (rng() - 0.5) * 0.35, // slight per-layer phase drift so strata don't align
    });
  }

  function shapeAt(theta, layer) {
    const c = Math.abs(Math.cos(theta));
    const s = Math.abs(Math.sin(theta));
    let r = 1 / Math.pow(Math.pow(c, m) + Math.pow(s, m), 1 / m);
    for (const h of harmonics) {
      r *= 1 + h.amp * Math.sin(h.k * theta + h.phase + layer * h.drift);
    }
    return r;
  }

  // ── Per-layer heights, radii, offsets ──────────────────────────────────────
  const layerH = [];
  let hSum = 0;
  for (let i = 0; i < n; i++) {
    const h = 0.6 + rng() * 0.9;
    layerH.push(h);
    hSum += h;
  }
  for (let i = 0; i < n; i++) layerH[i] = (layerH[i] / hSum) * p.height;

  const layerR = [];
  const layerOX = [];
  const layerOZ = [];
  let bulge = 1;
  let ox = 0, oz = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    bulge = THREE.MathUtils.clamp(bulge + (rng() - 0.5) * p.jitter, 0.72, 1.28);
    let r = p.radius * THREE.MathUtils.lerp(1, p.taper, Math.pow(t, 1.15)) * bulge;
    if (i > 0 && rng() < p.overhangChance) {
      r = Math.max(r, layerR[i - 1] * (1.06 + rng() * 0.1));
    }
    layerR.push(r);
    ox = THREE.MathUtils.clamp(ox + (rng() - 0.5) * p.offsetJitter * 2 * p.radius, -p.radius * 0.18, p.radius * 0.18);
    oz = THREE.MathUtils.clamp(oz + (rng() - 0.5) * p.offsetJitter * 2 * p.radius, -p.radius * 0.18, p.radius * 0.18);
    layerOX.push(ox);
    layerOZ.push(oz);
  }

  // ── Build rings ────────────────────────────────────────────────────────────
  // Each layer i has a bottom ring (radius r_i) and a top ring (r_i × bevel);
  // vertical wall between them, then a flat step annulus to layer i+1's ring.
  const positions = [];
  const uvs = [];
  const uvPerim = (Math.PI * 2 * p.radius) / 4;

  function ringPoint(layer, radiusMul, theta, y, out) {
    const rad = layerR[layer] * radiusMul * shapeAt(theta, layer);
    out[0] = layerOX[layer] + Math.cos(theta) * rad * p.aspect;
    out[1] = y;
    out[2] = layerOZ[layer] + Math.sin(theta) * rad;
  }

  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0];

  function pushTri(v0, v1, v2, uv0, uv1, uv2) {
    positions.push(v0[0], v0[1], v0[2], v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
    uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
  }

  function pushQuad(v00, v10, v11, v01, u0, u1, y0, y1) {
    // wall-style UVs: u along perimeter, v along height
    pushTri(v00, v10, v11, [u0, y0], [u1, y0], [u1, y1]);
    pushTri(v00, v11, v01, [u0, y0], [u1, y1], [u0, y1]);
  }

  let y = 0;
  for (let i = 0; i < n; i++) {
    const yBot = y;
    const yTop = y + layerH[i];

    for (let j = 0; j < segs; j++) {
      const t0 = (j / segs) * Math.PI * 2;
      const t1 = ((j + 1) / segs) * Math.PI * 2;
      const u0 = (j / segs) * uvPerim;
      const u1 = ((j + 1) / segs) * uvPerim;

      // vertical wall of this stratum (bottom ring → bevelled top ring)
      ringPoint(i, 1, t0, yBot, a);
      ringPoint(i, 1, t1, yBot, b);
      ringPoint(i, p.bevel, t1, yTop, c);
      ringPoint(i, p.bevel, t0, yTop, d);
      pushQuad(a, b, c, d, u0, u1, yBot / 4, yTop / 4);

      // step annulus to the next stratum (same y, different ring)
      if (i < n - 1) {
        ringPoint(i, p.bevel, t0, yTop, a);
        ringPoint(i, p.bevel, t1, yTop, b);
        ringPoint(i + 1, 1, t1, yTop, c);
        ringPoint(i + 1, 1, t0, yTop, d);
        pushQuad(a, b, c, d, u0, u1, yTop / 4, yTop / 4 + 0.25);
      }
    }
    y = yTop;
  }

  // ── Top cap (near-flat, slight centre lift for silhouette) ────────────────
  const topLayer = n - 1;
  const topY = p.height;
  const capCX = layerOX[topLayer];
  const capCZ = layerOZ[topLayer];
  const capLift = p.height * 0.015;
  for (let j = 0; j < segs; j++) {
    const t0 = (j / segs) * Math.PI * 2;
    const t1 = ((j + 1) / segs) * Math.PI * 2;
    ringPoint(topLayer, p.bevel, t0, topY, a);
    ringPoint(topLayer, p.bevel, t1, topY, b);
    c[0] = capCX; c[1] = topY + capLift; c[2] = capCZ;
    pushTri(a, b, c, [a[0] / 4, a[2] / 4], [b[0] / 4, b[2] / 4], [capCX / 4, capCZ / 4]);
  }

  // ── Bottom cap (closed for watertight sweeps; usually sunk in terrain) ────
  for (let j = 0; j < segs; j++) {
    const t0 = (j / segs) * Math.PI * 2;
    const t1 = ((j + 1) / segs) * Math.PI * 2;
    ringPoint(0, 1, t1, 0, a);
    ringPoint(0, 1, t0, 0, b);
    c[0] = layerOX[0]; c[1] = 0; c[2] = layerOZ[0];
    pushTri(a, b, c, [a[0] / 4, a[2] / 4], [b[0] / 4, b[2] / 4], [c[0] / 4, c[2] / 4]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals(); // non-indexed → flat shading, sharp strata edges
  geo.computeBoundingBox();
  return geo;
}

/** Debug cliff kit — 6 presets, mirroring a future 5-6 GLB workflow. */
export const CLIFF_PRESETS = [
  { name: "Cliff: Crag",  params: { seed: 101, height: 22, radius: 8,  strata: 10, taper: 0.55, jitter: 0.3,  overhangChance: 0.12, squareness: 0.35 } },
  { name: "Cliff: Butte", params: { seed: 202, height: 14, radius: 14, strata: 7,  taper: 0.8,  jitter: 0.22, overhangChance: 0.08, squareness: 0.5 } },
  { name: "Cliff: Spire", params: { seed: 303, height: 30, radius: 5,  strata: 12, taper: 0.35, jitter: 0.35, overhangChance: 0.15, squareness: 0.15 } },
  { name: "Cliff: Wall",  params: { seed: 404, height: 16, radius: 9,  aspect: 2.6, strata: 8, taper: 0.7,  jitter: 0.25, overhangChance: 0.1,  squareness: 0.55 } },
  { name: "Cliff: Ledge", params: { seed: 505, height: 8,  radius: 12, aspect: 1.6, strata: 5, taper: 0.85, jitter: 0.2,  overhangChance: 0.06, squareness: 0.45 } },
  { name: "Cliff: Mesa",  params: { seed: 606, height: 26, radius: 20, strata: 11, taper: 0.6,  jitter: 0.25, overhangChance: 0.1,  squareness: 0.4 } },
];
