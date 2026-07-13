// Building sites — GAME code.
//
// A building must SIT on the terrain, flat and level, wherever the map puts it.
// Terrain the editor made is bumpy and sloped, so three things happen:
//
//   1. EVALUATE  — sample the footprint; measure height spread and max slope.
//   2. SEARCH    — if the spot is too steep/uneven (or in water), spiral outward
//                  for the best nearby site. If none qualifies, REFUSE to build.
//   3. FLATTEN   — level the winning site to its mean height (app.flattenArea),
//                  so the ground itself becomes a plateau. Small bumps vanish;
//                  units drive on and around the building properly, because the
//                  nav grid is rebuilt from the new terrain.
//
// Flattening the real heightmap (rather than floating the model, or hiding the
// gap under a skirt) is what makes this hold up: the building, the units walking
// past it, and the pathfinder all agree on where the ground is.

/** Sample the footprint: centre + concentric rings. */
function sampleSite(app, x, z, radius, rings = 3, spokes = 10) {
  let minY = Infinity, maxY = -Infinity, sum = 0, n = 0;
  let worstSlope = 0;
  let wet = false;

  const consider = (sx, sz) => {
    const y = app.getWorldHeight(sx, sz);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    sum += y; n++;

    const nrm = app.getWorldNormal(sx, sz);
    const slope = Math.acos(Math.min(1, Math.max(-1, nrm.y))) * 180 / Math.PI;
    if (slope > worstSlope) worstSlope = slope;

    if (app.getWaterLevelAt && app.getWaterLevelAt(sx, sz) > y) wet = true;
  };

  consider(x, z);
  for (let r = 1; r <= rings; r++) {
    const rr = (radius * r) / rings;
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2;
      consider(x + Math.cos(a) * rr, z + Math.sin(a) * rr);
    }
  }

  return { minY, maxY, meanY: sum / n, spread: maxY - minY, maxSlope: worstSlope, wet };
}

/**
 * Score a candidate site. Lower is better; Infinity = unbuildable.
 * Rejects water and anything steeper/bumpier than the limits — "too sloppy to
 * place" is a real answer, not something to force.
 */
function scoreSite(site, { maxSlopeDeg, maxSpread }) {
  if (site.wet) return Infinity;
  if (site.maxSlope > maxSlopeDeg) return Infinity;
  if (site.spread > maxSpread) return Infinity;
  // Prefer flat + level ground; both terms normalised so neither dominates.
  return site.spread / maxSpread + site.maxSlope / maxSlopeDeg;
}

/**
 * Find the best buildable site at/near (x,z). Spirals outward until one passes.
 * Returns { x, z, y } (y = the level to flatten to), or null if nowhere works.
 */
export function findBuildSite(app, x, z, radius, {
  maxSlopeDeg = 22,   // steeper than this and the building would cut into a hill
  maxSpread = 6,      // metres of height variation across the footprint
  searchRadius = 90,  // how far we'll wander to find flat ground
  step = 10,
} = {}) {
  let best = null, bestScore = Infinity;

  const tryAt = (sx, sz) => {
    const site = sampleSite(app, sx, sz, radius);
    const s = scoreSite(site, { maxSlopeDeg, maxSpread });
    if (s < bestScore) { bestScore = s; best = { x: sx, z: sz, y: site.meanY }; }
  };

  tryAt(x, z);
  if (bestScore === 0) return best;

  for (let r = step; r <= searchRadius && bestScore === Infinity; r += step) {
    const spokes = Math.max(8, Math.round((2 * Math.PI * r) / step));
    for (let s = 0; s < spokes; s++) {
      const a = (s / spokes) * Math.PI * 2;
      tryAt(x + Math.cos(a) * r, z + Math.sin(a) * r);
    }
  }

  return bestScore === Infinity ? null : best;
}

/**
 * Level the ground under a building. The flattened disc is a little wider than
 * the footprint so the structure isn't perched on the lip of its own plateau,
 * and the falloff blends the plateau into the surrounding hillside.
 */
export async function prepareSite(app, x, z, radius, targetY) {
  if (!app.flattenArea) return;
  await app.flattenArea(x, z, radius * 1.5, targetY, {
    strength: 1,
    falloff: 3,   // fairly hard edge — a building pad, not a soft dent
    passes: 10,
  });
}
