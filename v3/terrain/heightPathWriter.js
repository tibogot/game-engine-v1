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
