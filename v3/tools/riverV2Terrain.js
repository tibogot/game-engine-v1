/**
 * v3/tools/riverV2Terrain.js — River v2's terrain shape, on the CPU.
 *
 * The RIVER layer of the height stack (v3/terrain/heightLayers.js): an operator
 * that takes the ground under it and returns the river-shaped ground, touching
 * nothing outside its own footprint. It is the GPU "nearest, then resolve"
 * conform in riverV2System.js, texel for texel — the same path data, the same
 * nearest-segment rule (mouth half-plane included), the same cross-section —
 * so the two can be checked against each other.
 *
 * WHY THE CPU. The GPU resolve rewrote every texel of the heightmap from a
 * private copy of the ground, and everything else that edits heights had to be
 * folded into that copy to survive (markExternalEdit, editBase, coversRect, the
 * debounced rebase) — which is how nam-rts lost its building pads. As a layer
 * the river owns no copy of anything: it reads GROUND, writes its footprint,
 * and whatever sits above it (pads, bridge landings, paddies) is composed on
 * top. Doing it on the CPU keeps the composed heightmap authoritative where the
 * gameplay reads it, with no GPU readback in the loop.
 *
 * Pure maths, no THREE: runs headlessly.
 */

/** "No river found" distance², as the GPU clear writes it. */
const FAR = 1e9;
/** Texels per side of a lookup cell. */
const CELL = 16;

const smooth01 = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Build the river operator from what the GPU conform uploads.
 *
 * @param {object} o
 * @param {Float32Array} o.pathData   riverV2System._pathData: row 0 (u, v,
 *   level, halfWidth), row 1 (depth, bank, mouthU, mouthV); UV and normalized
 *   heights, exactly as the shader reads them
 * @param {number} o.rowStride        floats per row (MAX_PATH_POINTS * 4)
 * @param {Array<null|{offset:number,count:number}>} o.layout  per river
 * @param {number} o.size             heightmap texels per side
 * @param {object} o.u                the conform uniforms, as numbers:
 *   { bedCurve, freeboardN, lipFrac, slopeToUv, flareMax }
 * @returns {null|{rect:{x0:number,z0:number,x1:number,z1:number}, apply:function}}
 *   null when there is no river to shape
 */
export function buildRiverTerrainOp({ pathData, rowStride, layout, size, u }) {
  const P = pathData, R1 = rowStride;
  const segs = [];               // path index of each segment's first point
  let maxReach = 0;              // UV
  for (const e of layout) {
    if (!e || e.count < 2) continue;
    for (let k = e.offset; k < e.offset + e.count - 1; k++) {
      segs.push(k);
      for (const j of [k, k + 1]) {
        const reach = P[j * 4 + 3] + P[R1 + j * 4 + 1] * u.flareMax;
        if (reach > maxReach) maxReach = reach;
      }
    }
  }
  if (!segs.length) return null;

  const cellsX = Math.ceil(size / CELL);
  const nCells = cellsX * cellsX;
  const segBox = (k, m) => {
    const ax = P[k * 4] * size, az = P[k * 4 + 1] * size;
    const bx = P[(k + 1) * 4] * size, bz = P[(k + 1) * 4 + 1] * size;
    const sx0 = Math.max(0, Math.floor(Math.min(ax, bx) - m));
    const sz0 = Math.max(0, Math.floor(Math.min(az, bz) - m));
    const sx1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + m));
    const sz1 = Math.min(size - 1, Math.ceil(Math.max(az, bz) + m));
    return sx1 < sx0 || sz1 < sz0 ? null
      : { cx0: Math.floor(sx0 / CELL), cz0: Math.floor(sz0 / CELL), cx1: Math.floor(sx1 / CELL), cz1: Math.floor(sz1 / CELL) };
  };

  // 1. Which cells can the river change at all? Only those within some
  //    segment's OWN reach: a texel beyond every segment's reach comes out as
  //    natural ground whichever segment is nearest to it.
  const covered = new Uint8Array(nCells);
  let cx0 = cellsX, cz0 = cellsX, cx1 = -1, cz1 = -1;
  for (const k of segs) {
    const reach = Math.max(
      P[k * 4 + 3] + P[R1 + k * 4 + 1] * u.flareMax,
      P[(k + 1) * 4 + 3] + P[R1 + (k + 1) * 4 + 1] * u.flareMax,
    );
    const b = segBox(k, reach * size + 2);
    if (!b) continue;
    cx0 = Math.min(cx0, b.cx0); cz0 = Math.min(cz0, b.cz0);
    cx1 = Math.max(cx1, b.cx1); cz1 = Math.max(cz1, b.cz1);
    for (let cz = b.cz0; cz <= b.cz1; cz++) covered.fill(1, cz * cellsX + b.cx0, cz * cellsX + b.cx1 + 1);
  }
  if (cx1 < 0) return null;

  // 2. In those cells, EVERY segment within the GLOBAL max reach. Not its own
  //    reach: a texel within reach of segment A may still be nearer to a narrow
  //    segment B whose own reach does not cover it — the GPU then picks B,
  //    whose section is natural ground there, and so must we.
  const margin = maxReach * size + 2;         // texels
  const cells = new Array(nCells);
  for (const k of segs) {
    const b = segBox(k, margin);
    if (!b) continue;
    for (let cz = b.cz0; cz <= b.cz1; cz++) {
      for (let cx = b.cx0; cx <= b.cx1; cx++) {
        const c = cz * cellsX + cx;
        if (covered[c]) (cells[c] ??= []).push(k);
      }
    }
  }
  // The footprint the op can change: the covered cells. Outside it, identity.
  const rect = {
    x0: cx0 * CELL, z0: cz0 * CELL,
    x1: Math.min(size - 1, cx1 * CELL + CELL - 1), z1: Math.min(size - 1, cz1 * CELL + CELL - 1),
  };
  const x0 = rect.x0, z0 = rect.z0, x1 = rect.x1, z1 = rect.z1;

  // 3. Sort each cell's segments by their distance from the cell centre minus
  //    the cell's half diagonal: a LOWER BOUND on how close the segment can be
  //    to any texel in the cell. The texel loop stops at the first segment whose
  //    bound is already worse than its best — the rest of the list is further
  //    still. (Unsorted and unculled, a drag step on nam-valley took 55 ms.)
  const halfDiag = (CELL * Math.SQRT2 * 0.5) / size;
  const bounds = new Array(nCells);
  for (let c = 0; c < nCells; c++) {
    const list = cells[c];
    if (!list) continue;
    const cu = ((c % cellsX) * CELL + CELL * 0.5) / size;
    const cv = (Math.floor(c / cellsX) * CELL + CELL * 0.5) / size;
    const n = list.length;
    const lb = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const k = list[j];
      const ax = P[k * 4], az = P[k * 4 + 1];
      const abx = P[(k + 1) * 4] - ax, abz = P[(k + 1) * 4 + 1] - az;
      const len2 = Math.max(abx * abx + abz * abz, 1e-12);
      let t = ((cu - ax) * abx + (cv - az) * abz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.max(0, Math.hypot(cu - (ax + abx * t), cv - (az + abz * t)) - halfDiag);
      lb[j] = d * d;
    }
    const order = Uint32Array.from({ length: n }, (_, j) => j).sort((a, b) => lb[a] - lb[b]);
    const ks = new Int32Array(n), bs = new Float64Array(n);
    for (let j = 0; j < n; j++) { ks[j] = list[order[j]]; bs[j] = lb[order[j]]; }
    cells[c] = ks;
    bounds[c] = bs;
  }

  /**
   * Shape `out` inside `r` (∩ the footprint) from `ground`. Texels no river
   * reaches are left as they are — the caller has already put ground there.
   * @param {Float32Array} out     composed heights, normalized
   * @param {Float32Array} ground  the GROUND layer, normalized
   * @param {{x0:number,z0:number,x1:number,z1:number}} r inclusive texel rect
   */
  function apply(out, ground, r) {
    const rx0 = Math.max(r.x0, x0), rz0 = Math.max(r.z0, z0);
    const rx1 = Math.min(r.x1, x1), rz1 = Math.min(r.z1, z1);
    const inv = 1 / size;
    for (let tz = rz0; tz <= rz1; tz++) {
      const v = (tz + 0.5) * inv;
      const rowCell = Math.floor(tz / CELL) * cellsX;
      for (let tx = rx0; tx <= rx1; tx++) {
        const ci = rowCell + Math.floor(tx / CELL);
        const list = cells[ci];
        if (!list) continue;
        const lb2 = bounds[ci];
        const uu = (tx + 0.5) * inv;

        // ── nearest segment (riverV2System nearestSearch) ──────────────────
        let bestD2 = FAR, bestK = -1, bestT = 0;
        for (let n = 0; n < list.length; n++) {
          // Sorted by lower bound: nothing further down can beat the best.
          if (lb2[n] > bestD2) break;
          const k = list[n];
          const ax = P[k * 4], az = P[k * 4 + 1];
          const abx = P[(k + 1) * 4] - ax, abz = P[(k + 1) * 4 + 1] - az;
          const len2 = Math.max(abx * abx + abz * abz, 1e-12);
          let t = ((uu - ax) * abx + (v - az) * abz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = uu - (ax + abx * t), dz = v - (az + abz * t);
          const d2 = dx * dx + dz * dz;
          if (!(d2 < bestD2)) continue;
          // Past an open mouth (a waterfall lip) the river stops dead.
          const mu = P[R1 + k * 4 + 2];
          if (mu >= 0) {
            const mv = P[R1 + k * 4 + 3];
            if ((uu - mu) * (mu - ax) + (v - mv) * (mv - az) > 0) continue;
          }
          bestD2 = d2; bestK = k; bestT = t;
        }
        if (bestK < 0) continue;

        // ── cross-section (riverV2System resolve) ──────────────────────────
        const i = tz * size + tx;
        const natural = ground[i];
        const a = bestK * 4, b = a + 4, t = bestT;
        const level = P[a + 2] + (P[b + 2] - P[a + 2]) * t;
        const halfW = P[a + 3] + (P[b + 3] - P[a + 3]) * t;
        const depth = P[R1 + a] + (P[R1 + b] - P[R1 + a]) * t;
        const bank = P[R1 + a + 1] + (P[R1 + b + 1] - P[R1 + a + 1]) * t;
        const dist = Math.sqrt(bestD2);

        let h;
        if (dist <= halfW) {
          const uc = Math.min(1, Math.max(0, dist / Math.max(halfW, 1e-6)));
          const u2 = uc * uc, u4 = u2 * u2;
          const flat = 1 - u4 * u4;
          const para = 1 - u2;
          h = level - depth * (flat + (para - flat) * u.bedCurve);
        } else {
          const rim = level + u.freeboardN;
          const need = Math.abs(natural - rim) * u.slopeToUv;
          const flare = Math.min(bank * u.flareMax, Math.max(bank, need));
          const ub = Math.min(1, Math.max(0, (dist - halfW) / Math.max(flare, 1e-6)));
          if (ub >= 1) continue;               // eased all the way back: natural
          const aRise = smooth01(0, u.lipFrac, ub);
          const bEase = smooth01(u.lipFrac, 1, ub);
          const lip = level + (rim - level) * aRise;
          h = lip + (natural - lip) * bEase;
        }
        out[i] = h;
      }
    }
  }

  return { rect, apply, maxReach, margin };
}

/**
 * Where can two river operators disagree? A texel's height depends only on the
 * segments within the op's max reach of it (anything further can neither be
 * its nearest segment nor reach it), so when two ops share their layout and
 * max reach, the answer is the changed segments — old AND new positions —
 * grown by that reach. Dragging one node therefore recomposes the ground
 * around that node, not along the whole river.
 *
 * @param {object|null} prev  { data: Float32Array (rows 0 and 1, packed),
 *   layout, maxReach } from a previous `snapshotRiverPath`
 * @param {object} next       the same, for the op about to be installed
 * @returns {null|false|{x0:number,z0:number,x1:number,z1:number}}
 *   null = cannot tell, recompose everything; false = nothing changed
 */
export function riverDirtyRect(prev, next, size) {
  if (!prev || prev.maxReach !== next.maxReach) return null;
  const a = prev.layout, b = next.layout;
  if (a.length !== b.length) return null;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] !== !b[i]) return null;
    if (a[i] && (a[i].offset !== b[i].offset || a[i].count !== b[i].count)) return null;
  }
  const n = prev.data.length / 8;                  // points; 8 floats each
  const changed = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    for (let f = 0; f < 8; f++) {
      if (prev.data[j * 8 + f] !== next.data[j * 8 + f]) { changed[j] = 1; break; }
    }
  }
  const m = next.maxReach * size + 2;
  let r = null;
  const grow = (d, j) => {
    const x = d[j * 8] * size, z = d[j * 8 + 1] * size;
    if (!r) r = { x0: x, z0: z, x1: x, z1: z };
    else { r.x0 = Math.min(r.x0, x); r.z0 = Math.min(r.z0, z); r.x1 = Math.max(r.x1, x); r.z1 = Math.max(r.z1, z); }
  };
  for (const e of b) {
    if (!e) continue;
    for (let j = e.offset; j < e.offset + e.count; j++) {
      if (!changed[j]) continue;
      // A changed point moves both segments that share it.
      for (const q of [j - 1, j, j + 1]) {
        if (q < e.offset || q >= e.offset + e.count) continue;
        grow(prev.data, q);
        grow(next.data, q);
      }
    }
  }
  if (!r) return false;
  return {
    x0: Math.max(0, Math.floor(r.x0 - m)), z0: Math.max(0, Math.floor(r.z0 - m)),
    x1: Math.min(size - 1, Math.ceil(r.x1 + m)), z1: Math.min(size - 1, Math.ceil(r.z1 + m)),
  };
}

/**
 * The part of the path data an op depends on, packed per point as
 * (row0.xyzw, row1.xyzw) — what `riverDirtyRect` compares.
 */
export function snapshotRiverPath({ pathData, rowStride, layout }, maxReach) {
  let n = 0;
  for (const e of layout) if (e) n = Math.max(n, e.offset + e.count);
  const data = new Float32Array(n * 8);
  for (let j = 0; j < n; j++) {
    for (let f = 0; f < 4; f++) {
      data[j * 8 + f] = pathData[j * 4 + f];
      data[j * 8 + 4 + f] = pathData[rowStride + j * 4 + f];
    }
  }
  return { data, layout: layout.map((e) => (e ? { offset: e.offset, count: e.count } : null)), maxReach };
}
