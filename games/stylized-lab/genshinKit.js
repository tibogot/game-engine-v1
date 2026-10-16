// THE GENSHIN KIT (2026-10-09, fifth pass). The user's refs, compared:
//   - Genshin's cliffs are TIERS of big CHUNKY BLOCKS — flat-topped, split by
//     vertical joints and horizontal bedding, chipped and bevelled — each tier
//     set back from the one below with a GRASS LEDGE on top, the whole face
//     leaning back with the hill (the cliff-and-girl shot)
//   - the boulders are chunky chipped lumps with big flat facets
//   - the Fab kits are the same thing: boxy masses broken at three scales
//     (blocks, chips, cracks), reused, scaled, turned
// The user's building-lab SANDSTONE rocks (games/alg-rts/algSandstone.js) are
// exactly that shape language — the engine's chipped-egg generator with its
// sandstone options (squareness, chips, big cuts, joints, strata, undercut);
// the cracks are the material's photo relief (stylizedRockMaterial.js). The
// clean SDF prisms (cliffSlabs.js) read as cones and columns: dropped.
//
//   prewarmKit()                  generate the pieces (worker threads)
//   buildKitShowcase(kit, ...)    the pieces in a row
//   buildTieredCliffs(kit, ...)   tiered cliffs along the mountain's steep ground
import * as THREE from "three";
import { mergeGeometries, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import { getRockGeometry, prewarmRockGeometries } from "../../v3/props/proceduralRock.js";
import { placePiece } from "./genshinCliffs.js";

// The sandstone "mesa" / "block" recipes (algSandstone.js SANDSTONE_SHAPES),
// at Genshin size and a touch squarer/blockier; joints wider (metres) so a
// 20 m block gets real cracks; strata fewer and deeper (the tiers' bedding).
const SAND = (o) => ({
  // (you, 2026-10-09: "a bit too rounded, too smooth") squarer, near-sharp
  // edges, more and bigger flat cuts, less lumpy — plus creased normals below
  egg: -0.04, squareness: 6.5, topCut: 0.26, baseCut: 0.1,
  chips: 60, chipMax: 0.11, bigCuts: 10, bigMax: 0.28, maxChipUp: 0.62, maxChipDown: 0.4, edgeSoft: 0.006, lump: 0.05,
  undercut: 0, undercutHeight: 0.3, strata: 3, strataDepth: 0.05, joints: 11, jointDepth: 0.2, jointWidth: 0.9, topRelief: 0.025,   // many vertical CREVASSES (you: more); shallow bedding (deep strata pinched blocks into hourglasses)
  detail: 100, targetTriangles: 3000, simplifyError: 0.005,
  ...o,
});
export const KIT_TYPES = {
  // the tier block: wide, a storey tall
  block: { seeds: [1, 2, 3, 4], params: SAND({ sizeX: 9, sizeY: 4.5, sizeZ: 6 }) },
  // the long bench: a ledge
  bench: { seeds: [1, 2, 3], params: SAND({ sizeX: 12, sizeY: 3.6, sizeZ: 6.5, strata: 5, joints: 11 }) },
  // a taller block for the steepest drops
  tall: { seeds: [1, 2], params: SAND({ sizeX: 7, sizeY: 7.5, sizeZ: 5.5, squareness: 4.8, strata: 5, joints: 7, jointWidth: 1.3 }) },
  // the chunky boulder (the girl shot): big flat facets, no bedding
  boulder: { seeds: [1, 2, 3, 4, 5], params: SAND({ sizeX: 3.2, sizeY: 2.8, sizeZ: 2.7, egg: 0.08, squareness: 2.6, topCut: 0.16, baseCut: 0.12, chips: 30, chipMax: 0.16, bigCuts: 6, bigMax: 0.28, undercut: 0, strata: 0, joints: 1, jointWidth: 0.25, targetTriangles: 1500 }) },
};
const paramsOf = (type, seed) => ({ ...KIT_TYPES[type].params, seed });

/** @returns {Promise<Record<string, THREE.BufferGeometry[]>>} */
export async function prewarmKit() {
  const all = [];
  for (const [type, t] of Object.entries(KIT_TYPES)) for (const sd of t.seeds) all.push(paramsOf(type, sd));
  await prewarmRockGeometries(all);
  const kit = {};
  for (const [type, t] of Object.entries(KIT_TYPES)) {
    kit[type] = t.seeds.map((sd) => {
      // CREASED normals: the generator's smooth normals round every chip edge
      // in the shading; split past ~35° so the cuts read as crisp facets
      // nSmooth: the generator's smooth normal, kept for the moss mask (the
      // creased one flips per facet along a rim: the saw-tooth)
      const src = getRockGeometry(paramsOf(type, sd)).clone();
      src.setAttribute("nSmooth", src.attributes.normal.clone());
      // 1.0 rad: only the real cuts split; at 0.6 the simplified rim's small
      // zig-zag split too and every tooth lit on its own (the saw-tooth rim)
      const g = toCreasedNormals(src, 1.0);
      src.dispose();
      g.computeBoundingBox();
      return g;
    });
  }
  return kit;
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
const UP = new THREE.Vector3(0, 1, 0);
const yawQ = (a) => new THREE.Quaternion().setFromAxisAngle(UP, a);
function merge(geos, info) {
  if (!geos.length) return null;
  const geo = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.kit = { ...info, pieces: geos.length, triangles: (geo.index ? geo.index.count : geo.attributes.position.count) / 3 };
  return geo;
}

/** The pieces in a row on flat ground (each sunk a little), boulders in front. */
export function buildKitShowcase(kit, { x0, z, height, gap = 5, scale = 1.6 }) {
  const geos = [];
  let x = x0;
  const put = (src, px, pz, s, yaw, sink) => {
    const bb = src.boundingBox;
    geos.push(placePiece(src, new THREE.Vector3(px, height(px, pz) - bb.min.y * s - sink, pz), yawQ(yaw), s));
  };
  for (const type of ["block", "bench", "tall"]) {
    for (const src of kit[type]) {
      const w = (src.boundingBox.max.x - src.boundingBox.min.x) * scale;
      put(src, x + w / 2, z, scale, 0, 0.6);
      x += w + gap;
    }
  }
  let bx = x0;
  for (const src of kit.boulder) { put(src, bx, z + 26, 1.4, 0.7, 0.4); bx += 11; }
  return merge(geos, { what: "showcase" });
}

/**
 * TIERED CLIFFS on the mountain — the Genshin cliff, assembled. Wherever the
 * ground is steep, look along its fall line: from the drop's foot (`lo`) to
 * its top (`hi`), cut it into 1-4 TIERS of ~`tierH` m. For each tier put a
 * block whose flat top sits at that tier's level, at the point on the fall
 * line where the ground reaches that level (so each tier is set back up the
 * slope from the one below, and grass meets its top behind), its front face
 * pushed a little downhill, turned to face down the slope (+- a little),
 * scaled so it reaches below the ground at its front. Neighbouring spots
 * overlap, so the blocks fuse into continuous tiered walls with grass ledges.
 * Boulders and stones scatter below. One merged world-space geometry.
 */
export function buildTieredCliffs(kit, { height, normal, region, minSlope = 45, tierH = 9, overlap = 0.5, maxStacks = 260, boulders = 60, pebbles = 120, seed = 6 }) {
  const rng = mulberry(seed * 7919 + 13);
  const deg = 180 / Math.PI;
  const cands = [];
  for (let z = region.z0; z <= region.z1; z += 5) for (let x = region.x0; x <= region.x1; x += 5) {
    const px = x + (rng() - 0.5) * 5, pz = z + (rng() - 0.5) * 5;
    const n = normal(px, pz), slope = Math.acos(Math.min(1, n.y)) * deg;
    if (slope >= minSlope) cands.push({ x: px, z: pz, slope, n });
  }
  cands.sort((a, b) => b.slope - a.slope);
  const stacks = [], geos = [];
  for (const c of cands) {
    if (stacks.length >= maxStacks) break;
    const hl = Math.hypot(c.n.x, c.n.z) || 1, dx = c.n.x / hl, dz = c.n.z / hl;   // downhill
    // the drop along the fall line: walk down to where it flattens, up to where it flattens
    const at = (t) => height(c.x + dx * t, c.z + dz * t);
    let tLo = 0, tHi = 0;
    // the step ends where the ground eases below 30° (the green slopes are gentler)
    while (tLo < 15 && at(tLo) - at(tLo + 1) > Math.tan(34 / deg)) tLo += 1;
    while (tHi > -15 && at(tHi - 1) - at(tHi) > Math.tan(34 / deg)) tHi -= 1;
    const lo = at(tLo), hi = at(tHi), drop = hi - lo;
    if (drop < 4) continue;
    const type0 = drop > 22 ? "tall" : "block";
    const src0 = kit[type0][0], w0 = (src0.boundingBox.max.x - src0.boundingBox.min.x);
    const width = w0 * 1.6;
    if (stacks.some((e) => Math.hypot(e.x - c.x, e.z - c.z) < (e.w + width) * 0.5 * overlap)) continue;
    const tiers = Math.max(1, Math.min(2, Math.round(drop / tierH)));
    for (let k = 0; k < tiers; k++) {
      const level = lo + (drop * (k + 1)) / tiers;
      // where the ground reaches this level on the fall line (bisection)
      let a = tHi, b = tLo;
      for (let it = 0; it < 18; it++) { const m = (a + b) / 2; if (at(m) > level) a = m; else b = m; }
      const t = (a + b) / 2;
      const type = k === tiers - 1 && rng() < 0.5 ? "bench" : (drop / tiers > 10 ? "tall" : "block");
      const list = kit[type], src = list[Math.floor(rng() * list.length)];
      const bb = src.boundingBox, ph = bb.max.y - bb.min.y, pd = bb.max.z - bb.min.z;
      // tall enough to reach 2.5 m below the ground in front of it
      const tierDrop = drop / tiers;
      const s = Math.max(1.2 + rng() * 0.5, (tierDrop + 3) / ph);
      const front = t + pd * s * (0.15 + rng() * 0.15);
      const px = c.x + dx * front - dx * pd * s * 0.5, pz = c.z + dz * front - dz * pd * s * 0.5;
      const y = level + 0.25 - bb.max.y * s;
      const yaw = Math.atan2(dx, dz) + (rng() - 0.5) * 0.5;
      geos.push(placePiece(src, new THREE.Vector3(px, y, pz), yawQ(yaw), s));
    }
    stacks.push({ x: c.x, z: c.z, w: width, tiers, drop: Math.round(drop), slope: Math.round(c.slope) });
  }
  // boulders below the cliffs and on the slopes, then small stones
  const scatter = (count, sLo, sHi, sink) => {
    for (let i = 0, tries = 0; i < count && tries < count * 30; tries++) {
      const x = region.x0 + rng() * (region.x1 - region.x0), z = region.z0 + rng() * (region.z1 - region.z0);
      const n = normal(x, z), slope = Math.acos(Math.min(1, n.y)) * deg;
      if (slope < 6 || slope > 30) continue;
      const near = stacks.some((e) => Math.hypot(e.x - x, e.z - z) < e.w * 1.6);
      if (!near && rng() < 0.7) continue;   // mostly near the cliffs: fallen from them
      const src = kit.boulder[Math.floor(rng() * kit.boulder.length)];
      const s = sLo + (sHi - sLo) * Math.pow(rng(), 1.6);
      const h = (src.boundingBox.max.y - src.boundingBox.min.y) * s;
      geos.push(placePiece(src, new THREE.Vector3(x, height(x, z) - src.boundingBox.min.y * s - h * sink, z), yawQ(rng() * Math.PI * 2), s));
      i++;
    }
  };
  scatter(boulders, 0.6, 2.4, 0.3);
  scatter(pebbles, 0.12, 0.4, 0.2);
  const geo = merge(geos, { what: "cliffs", stacks: stacks.length });
  if (geo) geo.userData.stacks = stacks;
  return geo;
}
