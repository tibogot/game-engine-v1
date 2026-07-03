/**
 * CPU height-path operations for V3's flat heightmap (world metres per texel).
 * Ported from v2 TerrainStore polyline stamps — no chunk seams on a unified grid.
 */

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function nearestOnPolyline(wx, wz, pts) {
  let bestDistSq = Infinity;
  let bestY = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const ax = pts[k].x;
    const az = pts[k].z;
    const bx = pts[k + 1].x;
    const bz = pts[k + 1].z;
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = 0;
    if (lenSq > 1e-8) {
      t = ((wx - ax) * dx + (wz - az) * dz) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const px = ax + t * dx;
    const pz = az + t * dz;
    const ex = wx - px;
    const ez = wz - pz;
    const dSq = ex * ex + ez * ez;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestY = pts[k].y * (1 - t) + pts[k + 1].y * t;
    }
  }
  return { distSq: bestDistSq, y: bestY };
}

/**
 * Lower-only carve along a polyline (tunnel mouths, river beds).
 * @param {Float32Array} heightsWorld  heightmapSize², world metres
 * @returns {boolean} true if any texel changed
 */
export function lowerAlongPolyline(heightsWorld, {
  heightmapSize,
  worldSize,
  pts,
  halfW,
  margin,
}) {
  if (!Array.isArray(pts) || pts.length < 2) return false;

  const dataResolution = heightmapSize - 1;
  const step = worldSize / dataResolution;
  const half = worldSize * 0.5;
  const halfWSq = halfW * halfW;
  const marginSq = margin * margin;

  let minWX = Infinity;
  let maxWX = -Infinity;
  let minWZ = Infinity;
  let maxWZ = -Infinity;
  for (const p of pts) {
    if (p.x < minWX) minWX = p.x;
    if (p.x > maxWX) maxWX = p.x;
    if (p.z < minWZ) minWZ = p.z;
    if (p.z > maxWZ) maxWZ = p.z;
  }
  minWX -= margin;
  maxWX += margin;
  minWZ -= margin;
  maxWZ += margin;

  const minIx = Math.max(0, Math.floor((minWX + half) / step));
  const maxIx = Math.min(dataResolution, Math.ceil((maxWX + half) / step));
  const minIz = Math.max(0, Math.floor((minWZ + half) / step));
  const maxIz = Math.min(dataResolution, Math.ceil((maxWZ + half) / step));
  if (minIx > maxIx || minIz > maxIz) return false;

  let changed = false;
  for (let iz = minIz; iz <= maxIz; iz++) {
    const wz = -half + iz * step;
    for (let ix = minIx; ix <= maxIx; ix++) {
      const wx = -half + ix * step;
      const { distSq, y: bestY } = nearestOnPolyline(wx, wz, pts);
      if (distSq > marginSq) continue;

      const idx = iz * heightmapSize + ix;
      const current = heightsWorld[idx];
      let next;
      if (distSq <= halfWSq) {
        next = Math.min(current, bestY);
      } else {
        const bestDist = Math.sqrt(distSq);
        let blend = 1 - (bestDist - halfW) / (margin - halfW);
        blend = blend * blend * (3 - 2 * blend);
        next = Math.min(current, current + (bestY - current) * blend);
      }
      if (next === current) continue;
      heightsWorld[idx] = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * Copy height texels inside an axis-aligned world bbox (for carve undo bases).
 * @returns {{ data: Float32Array, minIx: number, maxIx: number, minIz: number, maxIz: number, heightmapSize: number }}
 */
export function snapshotHeightBox(heightsWorld, {
  heightmapSize,
  worldSize,
  minWX,
  maxWX,
  minWZ,
  maxWZ,
  pad = 0,
}) {
  const dataResolution = heightmapSize - 1;
  const step = worldSize / dataResolution;
  const half = worldSize * 0.5;

  const minIx = Math.max(0, Math.floor((minWX - pad + half) / step));
  const maxIx = Math.min(dataResolution, Math.ceil((maxWX + pad + half) / step));
  const minIz = Math.max(0, Math.floor((minWZ - pad + half) / step));
  const maxIz = Math.min(dataResolution, Math.ceil((maxWZ + pad + half) / step));

  const w = maxIx - minIx + 1;
  const h = maxIz - minIz + 1;
  const data = new Float32Array(w * h);
  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const src = iz * heightmapSize + ix;
      const dst = (iz - minIz) * w + (ix - minIx);
      data[dst] = heightsWorld[src];
    }
  }
  return { data, minIx, maxIx, minIz, maxIz, heightmapSize, width: w };
}

/** Restore a box snapshot produced by snapshotHeightBox. */
export function restoreHeightBox(heightsWorld, snap) {
  const { data, minIx, maxIx, minIz, maxIz, heightmapSize, width: w } = snap;
  for (let iz = minIz; iz <= maxIz; iz++) {
    for (let ix = minIx; ix <= maxIx; ix++) {
      const src = (iz - minIz) * w + (ix - minIx);
      heightsWorld[iz * heightmapSize + ix] = data[src];
    }
  }
}

/**
 * Conform terrain to the Smart Road surface (cut hills AND fill dips) along
 * road-spine footprints. Port of v2 TerrainStore.conformToRoadSurface onto the
 * flat heightmap. The guarantee: within the full-flatten zone the terrain is
 * exactly `getSurfaceH(x,z) + lift − embedDepth` at every texel, so the deck
 * (surface + clearance) clears it by a CONSTANT clearance + embedDepth — no
 * clipping on slopes, tilted junctions, or connector corners.
 *
 * Three phases, because getSurfaceH low-pass-samples the SAME height field we
 * write to: (1) per-texel nearest footprint distance + interpolated lift,
 * (2) compute every target from the untouched field, (3) write blended heights.
 *
 * @param {Float32Array} heightsWorld heightmapSize², world metres (mutated)
 * @param {Array<{pts:{x,z}[], lifts?:number[]}>} footprints road spines; lift =
 *        deck height above terrain baseline (bridges skip the flatten)
 * @param {(x:number,z:number)=>number} getSurfaceH road surface height (metres)
 * @returns {{changed:boolean, rect:null|{minIx:number,maxIx:number,minIz:number,maxIz:number}}}
 */
export function conformToRoadSurface(heightsWorld, {
  heightmapSize,
  worldSize,
  footprints,
  getSurfaceH,
  halfW,
  embedDepth,
  shoulder,
  liftSkip = 1.5,
}) {
  const none = { changed: false, rect: null };
  if (!Array.isArray(footprints) || footprints.length === 0) return none;

  const dataResolution = heightmapSize - 1;
  const step = worldSize / dataResolution;
  const half = worldSize * 0.5;
  // Full-flatten reach: one heightmap texel past the deck edge so no terrain
  // triangle (at any clipmap LOD sampling this field) straddles the deck edge.
  const inner = halfW + 1 + step;
  const outer = Math.max(0.01, shoulder);
  const reach = inner + outer;

  // Union texel window over all footprints.
  let minWX = Infinity, maxWX = -Infinity, minWZ = Infinity, maxWZ = -Infinity;
  for (const fp of footprints) {
    for (const p of fp.pts) {
      if (p.x < minWX) minWX = p.x;
      if (p.x > maxWX) maxWX = p.x;
      if (p.z < minWZ) minWZ = p.z;
      if (p.z > maxWZ) maxWZ = p.z;
    }
  }
  const winMinIx = Math.max(0, Math.floor((minWX - reach + half) / step));
  const winMaxIx = Math.min(dataResolution, Math.ceil((maxWX + reach + half) / step));
  const winMinIz = Math.max(0, Math.floor((minWZ - reach + half) / step));
  const winMaxIz = Math.min(dataResolution, Math.ceil((maxWZ + reach + half) / step));
  if (winMinIx > winMaxIx || winMinIz > winMaxIz) return none;
  const winW = winMaxIx - winMinIx + 1;
  const winH = winMaxIz - winMinIz + 1;

  // Phase 1 — per-texel distance to the nearest footprint segment (+ its
  // interpolated lift). Each footprint only scans its own padded bbox.
  const dist = new Float32Array(winW * winH).fill(Infinity);
  const liftArr = new Float32Array(winW * winH);
  for (const fp of footprints) {
    const pts = fp.pts;
    const lifts = fp.lifts;
    if (!pts || pts.length === 0) continue;
    let fMinX = Infinity, fMaxX = -Infinity, fMinZ = Infinity, fMaxZ = -Infinity;
    for (const p of pts) {
      if (p.x < fMinX) fMinX = p.x;
      if (p.x > fMaxX) fMaxX = p.x;
      if (p.z < fMinZ) fMinZ = p.z;
      if (p.z > fMaxZ) fMaxZ = p.z;
    }
    const ix0 = Math.max(winMinIx, Math.floor((fMinX - reach + half) / step));
    const ix1 = Math.min(winMaxIx, Math.ceil((fMaxX + reach + half) / step));
    const iz0 = Math.max(winMinIz, Math.floor((fMinZ - reach + half) / step));
    const iz1 = Math.min(winMaxIz, Math.ceil((fMaxZ + reach + half) / step));
    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = -half + iz * step;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = -half + ix * step;
        let bestSq = Infinity;
        let bestLift = 0;
        if (pts.length === 1) {
          const ex = wx - pts[0].x, ez = wz - pts[0].z;
          bestSq = ex * ex + ez * ez;
          bestLift = lifts ? lifts[0] : 0;
        } else {
          for (let k = 0; k < pts.length - 1; k++) {
            const ax = pts[k].x, az = pts[k].z;
            const dx = pts[k + 1].x - ax, dz = pts[k + 1].z - az;
            const lenSq = dx * dx + dz * dz;
            let t = 0;
            if (lenSq > 1e-8) t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / lenSq));
            const ex = wx - (ax + dx * t), ez = wz - (az + dz * t);
            const sq = ex * ex + ez * ez;
            if (sq < bestSq) {
              bestSq = sq;
              bestLift = lifts ? lifts[k] + (lifts[k + 1] - lifts[k]) * t : 0;
            }
          }
        }
        const w = (iz - winMinIz) * winW + (ix - winMinIx);
        if (bestSq < dist[w] * dist[w]) {
          dist[w] = Math.sqrt(bestSq);
          liftArr[w] = bestLift;
        }
      }
    }
  }

  // Phase 2 — all targets from the untouched field (getSurfaceH reads it).
  const idxs = [];
  const targets = [];
  const blends = [];
  for (let iz = winMinIz; iz <= winMaxIz; iz++) {
    const wz = -half + iz * step;
    for (let ix = winMinIx; ix <= winMaxIx; ix++) {
      const w = (iz - winMinIz) * winW + (ix - winMinIx);
      const d = dist[w];
      if (d >= reach) continue;
      if (liftArr[w] > liftSkip) continue; // deck is elevated here (bridge/viaduct)
      const wx = -half + ix * step;
      const s = d <= inner ? 0 : smoothstep(0, 1, (d - inner) / outer);
      idxs.push(iz * heightmapSize + ix);
      targets.push(getSurfaceH(wx, wz) + liftArr[w] - embedDepth);
      blends.push(s);
    }
  }
  if (idxs.length === 0) return none;

  // Phase 3 — write, tracking the tight dirty rect.
  let changed = false;
  let rMinIx = Infinity, rMaxIx = -Infinity, rMinIz = Infinity, rMaxIz = -Infinity;
  for (let i = 0; i < idxs.length; i++) {
    const idx = idxs[i];
    const current = heightsWorld[idx];
    const next = targets[i] + (current - targets[i]) * blends[i];
    if (next === current) continue;
    heightsWorld[idx] = next;
    changed = true;
    const ix = idx % heightmapSize;
    const iz = (idx - ix) / heightmapSize;
    if (ix < rMinIx) rMinIx = ix;
    if (ix > rMaxIx) rMaxIx = ix;
    if (iz < rMinIz) rMinIz = iz;
    if (iz > rMaxIz) rMaxIz = iz;
  }
  return changed
    ? { changed, rect: { minIx: rMinIx, maxIx: rMaxIx, minIz: rMinIz, maxIz: rMaxIz } }
    : none;
}

/** Bilinear world height sample from a metres height field. */
export function sampleHeightWorld(heightsWorld, heightmapSize, worldSize, wx, wz) {
  const dataResolution = heightmapSize - 1;
  const half = worldSize * 0.5;
  const u = (wx + half) / worldSize;
  const v = (wz + half) / worldSize;
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;

  const fx = u * dataResolution;
  const fz = v * dataResolution;
  const ix0 = Math.floor(fx);
  const iz0 = Math.floor(fz);
  const ix1 = Math.min(ix0 + 1, dataResolution);
  const iz1 = Math.min(iz0 + 1, dataResolution);
  const tx = fx - ix0;
  const tz = fz - iz0;

  const i00 = iz0 * heightmapSize + ix0;
  const i10 = iz0 * heightmapSize + ix1;
  const i01 = iz1 * heightmapSize + ix0;
  const i11 = iz1 * heightmapSize + ix1;

  const h0 = heightsWorld[i00] * (1 - tx) + heightsWorld[i10] * tx;
  const h1 = heightsWorld[i01] * (1 - tx) + heightsWorld[i11] * tx;
  return h0 * (1 - tz) + h1 * tz;
}

export { smoothstep };
