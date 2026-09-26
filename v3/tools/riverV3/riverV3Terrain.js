/**
 * v3/tools/riverV3/riverV3Terrain.js — River v3's terrain: the RIVER operator
 * of the height stack (v3/terrain/heightLayers.js) for a river NETWORK.
 *
 * Same cross-section as River v2 (riverV2Terrain.js — bed, lip, flaring bank,
 * cut AND fill), same pruned lookup grid. What is new is the JUNCTION rule.
 *
 * River v2 let the single nearest segment decide every texel. At a confluence
 * that is wrong: a texel in the trunk's channel that happens to be nearer the
 * tributary's last segment took the tributary's shallower bed, and the
 * tributary's LIP stood up inside the trunk. v3 keeps the best segment of the
 * two nearest REACHES and combines their sections:
 *
 *   inside either channel  → the LOWER bed (a smooth min, so the union of two
 *                            channels is one clean channel — and the smooth
 *                            min dips a little below both where they meet,
 *                            which is the scour hole real confluences have)
 *   both on their banks    → the LOWER bank, so two lips never make a ridge
 *                            across the mouth
 *
 * This is Unreal Water's "Min at the confluence" rule, generalised: a
 * tributary can never fill its parent's bed, and vice versa.
 *
 * Within one reach the nearest segment still decides, exactly as in v2.
 */

const CELL = 16;
const FAR = 1e9;

const smooth01 = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Pack solved reaches into flat arrays in texture units (UV, normalized height).
 * @param {Array<{id:any, solved:object}>} list
 */
export function packReaches(list, { worldSize, maxHeight }) {
  let n = 0;
  for (const r of list) if (r.solved?.count >= 2) n += r.solved.count;
  const P = {
    u: new Float64Array(n), v: new Float64Array(n), level: new Float64Array(n), halfW: new Float64Array(n),
    depth: new Float64Array(n), bank: new Float64Array(n), reach: new Int32Array(n), last: new Uint8Array(n),
    layout: [],
  };
  let o = 0;
  list.forEach((r, ri) => {
    const s = r.solved;
    if (!s || s.count < 2) return;
    P.layout.push({ id: r.id, offset: o, count: s.count });
    for (let i = 0; i < s.count; i++, o++) {
      P.u[o] = s.x[i] / worldSize + 0.5;
      P.v[o] = s.z[i] / worldSize + 0.5;
      P.level[o] = s.level[i] / maxHeight;
      P.halfW[o] = (s.width[i] * 0.5) / worldSize;
      P.depth[o] = s.depth[i] / maxHeight;
      P.bank[o] = s.bank[i] / worldSize;
      P.reach[o] = ri;
      P.last[o] = i === s.count - 1 ? 1 : 0;
    }
  });
  return P;
}

/**
 * @param {object} o
 * @param {object} o.packed  packReaches output
 * @param {number} o.size    heightmap texels per side
 * @param {object} o.u       { bedCurve, freeboardN, lipFrac, slopeToUv, flareMax }
 * @returns {null|{rect, apply, maxReach}}
 */
export function buildRiverV3TerrainOp({ packed: P, size, u }) {
  const n = P.u.length;
  const segs = [];
  let maxReach = 0;
  const reachAt = (j) => P.halfW[j] + P.bank[j] * u.flareMax;
  for (let k = 0; k < n; k++) {
    if (P.last[k]) continue;
    segs.push(k);
    maxReach = Math.max(maxReach, reachAt(k), reachAt(k + 1));
  }
  if (!segs.length) return null;

  const cellsX = Math.ceil(size / CELL), nCells = cellsX * cellsX;
  const segBox = (k, m) => {
    const ax = P.u[k] * size, az = P.v[k] * size, bx = P.u[k + 1] * size, bz = P.v[k + 1] * size;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - m)), z0 = Math.max(0, Math.floor(Math.min(az, bz) - m));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + m)), z1 = Math.min(size - 1, Math.ceil(Math.max(az, bz) + m));
    return x1 < x0 || z1 < z0 ? null
      : { cx0: Math.floor(x0 / CELL), cz0: Math.floor(z0 / CELL), cx1: Math.floor(x1 / CELL), cz1: Math.floor(z1 / CELL) };
  };

  // Cells any segment's OWN reach touches: everything else is natural ground.
  const covered = new Uint8Array(nCells);
  let cx0 = cellsX, cz0 = cellsX, cx1 = -1, cz1 = -1;
  for (const k of segs) {
    const b = segBox(k, Math.max(reachAt(k), reachAt(k + 1)) * size + 2);
    if (!b) continue;
    cx0 = Math.min(cx0, b.cx0); cz0 = Math.min(cz0, b.cz0); cx1 = Math.max(cx1, b.cx1); cz1 = Math.max(cz1, b.cz1);
    for (let cz = b.cz0; cz <= b.cz1; cz++) covered.fill(1, cz * cellsX + b.cx0, cz * cellsX + b.cx1 + 1);
  }
  if (cx1 < 0) return null;
  // In covered cells, every segment within the global max reach — enough for
  // the true nearest segment of every reach that can affect the cell.
  const margin = maxReach * size + 2;
  const cells = new Array(nCells);
  for (const k of segs) {
    const b = segBox(k, margin);
    if (!b) continue;
    for (let cz = b.cz0; cz <= b.cz1; cz++) for (let cx = b.cx0; cx <= b.cx1; cx++) {
      const c = cz * cellsX + cx;
      if (covered[c]) (cells[c] ??= []).push(k);
    }
  }
  // Sort by a lower bound on distance to any texel of the cell; flag cells that
  // see more than one reach (only those need the two-reach search).
  const halfDiag = (CELL * Math.SQRT2 * 0.5) / size;
  const bounds = new Array(nCells), multi = new Uint8Array(nCells);
  for (let c = 0; c < nCells; c++) {
    const list = cells[c];
    if (!list) continue;
    const cu = ((c % cellsX) * CELL + CELL * 0.5) / size, cv = (Math.floor(c / cellsX) * CELL + CELL * 0.5) / size;
    const len = list.length, lb = new Float64Array(len);
    let r0 = P.reach[list[0]];
    for (let j = 0; j < len; j++) {
      const k = list[j];
      if (P.reach[k] !== r0) multi[c] = 1;
      const ax = P.u[k], az = P.v[k], abx = P.u[k + 1] - ax, abz = P.v[k + 1] - az;
      let t = ((cu - ax) * abx + (cv - az) * abz) / Math.max(abx * abx + abz * abz, 1e-12);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.max(0, Math.hypot(cu - ax - abx * t, cv - az - abz * t) - halfDiag);
      lb[j] = d * d;
    }
    const order = Uint32Array.from({ length: len }, (_, j) => j).sort((a, b) => lb[a] - lb[b]);
    const ks = new Int32Array(len), bs = new Float64Array(len);
    for (let j = 0; j < len; j++) { ks[j] = list[order[j]]; bs[j] = lb[order[j]]; }
    cells[c] = ks; bounds[c] = bs;
  }
  const rect = {
    x0: cx0 * CELL, z0: cz0 * CELL,
    x1: Math.min(size - 1, cx1 * CELL + CELL - 1), z1: Math.min(size - 1, cz1 * CELL + CELL - 1),
  };
  const maxReach2 = margin * margin / (size * size);

  // The cross-section of segment k at parameter t, distance `dist` (UV), over
  // ground `natural`. Returns NaN where it has eased back to natural ground.
  let secIn = false;
  function section(natural, k, t, dist) {
    const lerp = (a) => a[k] + (a[k + 1] - a[k]) * t;
    const level = lerp(P.level), halfW = lerp(P.halfW);
    if (dist <= halfW) {
      secIn = true;
      const depth = lerp(P.depth);
      const uc = Math.min(1, dist / Math.max(halfW, 1e-9)), u2 = uc * uc, u4 = u2 * u2;
      const flat = 1 - u4 * u4, para = 1 - u2;
      return level - depth * (flat + (para - flat) * u.bedCurve);
    }
    secIn = false;
    const bank = lerp(P.bank);
    const rim = level + u.freeboardN;
    const flare = Math.min(bank * u.flareMax, Math.max(bank, Math.abs(natural - rim) * u.slopeToUv));
    const ub = Math.min(1, (dist - halfW) / Math.max(flare, 1e-9));
    if (ub >= 1) return NaN;
    const lip = level + (rim - level) * smooth01(0, u.lipFrac, ub);
    return lip + (natural - lip) * smooth01(u.lipFrac, 1, ub);
  }

  // The best segment of each of the K nearest REACHES. A confluence is three
  // reaches meeting (two tributaries and the trunk), so two is not enough:
  // keeping only the two tributaries let both their banks stand up inside the
  // trunk's channel (measured +0.44 m in the test before this was 4).
  const K = 4;
  const bd = new Float64Array(K), bk = new Int32Array(K), bt = new Float64Array(K), br = new Int32Array(K);

  function apply(out, ground, r) {
    const rx0 = Math.max(r.x0, rect.x0), rz0 = Math.max(r.z0, rect.z0);
    const rx1 = Math.min(r.x1, rect.x1), rz1 = Math.min(r.z1, rect.z1);
    const inv = 1 / size;
    for (let tz = rz0; tz <= rz1; tz++) {
      const v = (tz + 0.5) * inv;
      const rowCell = Math.floor(tz / CELL) * cellsX;
      for (let tx = rx0; tx <= rx1; tx++) {
        const ci = rowCell + Math.floor(tx / CELL);
        const list = cells[ci];
        if (!list) continue;
        const lb2 = bounds[ci], many = multi[ci] === 1;
        const uu = (tx + 0.5) * inv;
        let nb = 0;                    // reaches found so far, sorted by distance
        for (let j = 0; j < list.length; j++) {
          const b = lb2[j];
          // Nothing further down the sorted list can beat the best of one
          // reach; with several reaches, stop once it cannot beat the K-th
          // either, or is beyond any reach's influence.
          if (nb && b > bd[0] && (!many || (nb === K && b > bd[K - 1]) || b > maxReach2)) break;
          const k = list[j];
          const ax = P.u[k], az = P.v[k], abx = P.u[k + 1] - ax, abz = P.v[k + 1] - az;
          let t = ((uu - ax) * abx + (v - az) * abz) / Math.max(abx * abx + abz * abz, 1e-12);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = uu - ax - abx * t, dz = v - az - abz * t, d = dx * dx + dz * dz;
          const rk = P.reach[k];
          // Already have this reach? Keep its nearer segment.
          let slot = -1;
          for (let q = 0; q < nb; q++) if (br[q] === rk) { slot = q; break; }
          if (slot >= 0) {
            if (d >= bd[slot]) continue;
            for (let q = slot; q < nb - 1; q++) { bd[q] = bd[q + 1]; bk[q] = bk[q + 1]; bt[q] = bt[q + 1]; br[q] = br[q + 1]; }
            nb--;
          } else if (!many && nb) {
            continue;                  // single-reach cell: only ever one entry
          }
          if (nb === K && d >= bd[K - 1]) continue;
          let at = Math.min(nb, K - 1);
          while (at > 0 && bd[at - 1] > d) {
            bd[at] = bd[at - 1]; bk[at] = bk[at - 1]; bt[at] = bt[at - 1]; br[at] = br[at - 1]; at--;
          }
          bd[at] = d; bk[at] = k; bt[at] = t; br[at] = rk;
          if (nb < K) nb++;
        }
        if (!nb) continue;
        const i = tz * size + tx, natural = ground[i];
        // Combine: inside any channel → the lowest bed (smooth min, which also
        // digs the confluence scour); otherwise the lowest bank.
        let bed = Infinity, bedDepth = 0, bank = NaN;
        for (let q = 0; q < nb; q++) {
          const hq = section(natural, bk[q], bt[q], Math.sqrt(bd[q]));
          if (secIn) {
            if (bed === Infinity) { bed = hq; bedDepth = P.depth[bk[q]]; continue; }
            const kk = 0.3 * Math.min(bedDepth, P.depth[bk[q]]);
            const hh = Math.max(kk - Math.abs(bed - hq), 0) / Math.max(kk, 1e-12);
            bed = Math.min(bed, hq) - hh * hh * kk * 0.25;
            bedDepth = Math.min(bedDepth, P.depth[bk[q]]);
          } else if (!Number.isNaN(hq)) {
            bank = Number.isNaN(bank) ? hq : Math.min(bank, hq);
          }
        }
        if (bed !== Infinity) out[i] = bed;
        else if (!Number.isNaN(bank)) out[i] = bank;
      }
    }
  }

  return { rect, apply, maxReach };
}

/**
 * Per-reach snapshot of what the op depends on, keyed by reach id, so a drag
 * on one reach never marks another dirty (v2 compared by path offset, and one
 * reach gaining a station shifted every later one).
 */
export function snapshotReaches(packed, maxReach, paramsKey) {
  const byId = new Map();
  for (const e of packed.layout) {
    const d = new Float64Array(e.count * 6);
    for (let i = 0; i < e.count; i++) {
      const j = e.offset + i;
      d.set([packed.u[j], packed.v[j], packed.level[j], packed.halfW[j], packed.depth[j], packed.bank[j]], i * 6);
    }
    byId.set(e.id, d);
  }
  return { byId, maxReach, paramsKey };
}

/**
 * Where two network ops can differ: every changed station (old and new
 * position, and its neighbours) grown by the max reach. null = everywhere,
 * false = nowhere.
 */
export function networkDirtyRect(prev, next, size) {
  if (!prev || !next || prev.maxReach !== next.maxReach || prev.paramsKey !== next.paramsKey) return null;
  let r = null;
  const grow = (d, i) => {
    const x = d[i * 6] * size, z = d[i * 6 + 1] * size;
    if (!r) r = { x0: x, z0: z, x1: x, z1: z };
    else { r.x0 = Math.min(r.x0, x); r.z0 = Math.min(r.z0, z); r.x1 = Math.max(r.x1, x); r.z1 = Math.max(r.z1, z); }
  };
  const all = (d) => { for (let i = 0; i < d.length / 6; i++) grow(d, i); };
  for (const [id, a] of prev.byId) {
    const b = next.byId.get(id);
    if (!b) { all(a); continue; }
    if (a.length !== b.length) { all(a); all(b); continue; }
    const cnt = a.length / 6;
    for (let i = 0; i < cnt; i++) {
      let same = true;
      for (let f = 0; f < 6; f++) if (a[i * 6 + f] !== b[i * 6 + f]) { same = false; break; }
      if (same) continue;
      for (const q of [i - 1, i, i + 1]) if (q >= 0 && q < cnt) { grow(a, q); grow(b, q); }
    }
  }
  for (const [id, b] of next.byId) if (!prev.byId.has(id)) all(b);
  if (!r) return false;
  const m = next.maxReach * size + 2;
  return {
    x0: Math.max(0, Math.floor(r.x0 - m)), z0: Math.max(0, Math.floor(r.z0 - m)),
    x1: Math.min(size - 1, Math.ceil(r.x1 + m)), z1: Math.min(size - 1, Math.ceil(r.z1 + m)),
  };
}
