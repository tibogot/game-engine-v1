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
 *   both on their banks    → the LOWER bank (a smooth corner), floored just
 *                            above the water. Plain "lower" let a bank that had
 *                            eased down to a floodplain below the river win, and
 *                            the river spilled onto the corner; plain "higher"
 *                            stood one reach's lip across the edge of the other's
 *                            mouth. Both seen up close in the river lab.
 *
 * This is Unreal Water's "Min at the confluence" rule, generalised: a
 * tributary can never fill its parent's bed, and vice versa.
 *
 * Within one reach the nearest segment still decides, exactly as in v2.
 *
 * OPEN MOUTHS (a waterfall takes a reach's water): as River v2, the reach
 * stops dead at a half-plane through the fall's LIP, honoured by every one of
 * its segments — no half-disc of bank filling the brink the water leaves over.
 */

const CELL = 16;

/** Reused scratch arrays for the smoothed carve (slot → Float32Array). */
const _scratch = [];
function scratch(slot, n) {
  if (!_scratch[slot] || _scratch[slot].length < n) _scratch[slot] = new Float32Array(n);
  return _scratch[slot];
}
const FAR = 1e9;

const smooth01 = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Pack solved reaches into flat arrays in texture units (UV, normalized height).
 * @param {Array<{id:any, solved:object, mouth?:{x:number,z:number}|null, extStart?:boolean, extEnd?:boolean}>} list
 *   `mouth`: the reach's open mouth (a waterfall lip), world metres;
 *   `extStart` / `extEnd`: that end sits on a junction (its surface runs on)
 */
export function packReaches(list, { worldSize, maxHeight }) {
  let n = 0;
  for (const r of list) if (r.solved?.count >= 2) n += r.solved.count;
  const P = {
    u: new Float64Array(n), v: new Float64Array(n), level: new Float64Array(n), halfW: new Float64Array(n),
    depth: new Float64Array(n), bank: new Float64Array(n), reach: new Int32Array(n), last: new Uint8Array(n),
    // Open mouth per point (−1 = none) and the half-plane's normal: the
    // reach's own downstream direction AT the lip, so everything past the lip
    // stops — not just segments upstream of it (v2's (mouth − segment start)
    // normal only worked for a lip beyond the last node).
    mu: new Float64Array(n).fill(-1), mv: new Float64Array(n), mnx: new Float64Array(n), mnz: new Float64Array(n),
    // 1 on a reach's first/last point when that end sits on a JUNCTION: its
    // water surface runs on past the end there (see the ribbon builder), so it
    // may own the pixels just beyond it. Without that, where a river bends at
    // a junction the two square ribbon ends leave a thin wedge nobody draws.
    ext: new Uint8Array(n),
    // STEPS (riverV3Network applyStepPools): arc (m) and each station's crest
    // shape (m) — the bed follows the crest-shifted profile, exactly as the
    // water surface does — plus the plunge-pool scour (normalized height), and
    // where the reach's stations start / how many, for the shifted lookup.
    arc: new Float64Array(n), crA: new Float32Array(n), crB: new Float32Array(n),
    crN: new Float32Array(n), crP: new Float32Array(n), scour: new Float64Array(n), zone: new Uint8Array(n),
    base: new Int32Array(n), cnt: new Int32Array(n), maxShift: 0,
    layout: [],
  };
  let o = 0;
  list.forEach((r, ri) => {
    const s = r.solved;
    if (!s || s.count < 2) return;
    P.layout.push({ id: r.id, offset: o, count: s.count });
    let nx = 0, nz = 0;
    if (r.mouth) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < s.count; i++) {
        const d = (s.x[i] - r.mouth.x) ** 2 + (s.z[i] - r.mouth.z) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      nx = s.tanX[bi]; nz = s.tanZ[bi];
    }
    const base = o;
    for (let i = 0; i < s.count; i++, o++) {
      P.arc[o] = s.arc[i]; P.base[o] = base; P.cnt[o] = s.count;
      if (s.crA) {
        P.crA[o] = s.crA[i]; P.crB[o] = s.crB[i]; P.crN[o] = s.crN[i]; P.crP[o] = s.crP[i];
        P.scour[o] = (s.scour?.[i] ?? 0) / maxHeight;
        P.zone[o] = s.stepZone?.[i] ?? 0;
        P.maxShift = Math.max(P.maxShift, (Math.abs(s.crA[i]) + Math.abs(s.crB[i]) + s.crN[i]) / worldSize);
      }
      if (r.mouth) { P.mnx[o] = nx; P.mnz[o] = nz; }
      if ((i === 0 && r.extStart) || (i === s.count - 1 && r.extEnd)) P.ext[o] = 1;
      P.u[o] = s.x[i] / worldSize + 0.5;
      P.v[o] = s.z[i] / worldSize + 0.5;
      P.level[o] = s.level[i] / maxHeight;
      P.halfW[o] = (s.width[i] * 0.5) / worldSize;
      P.depth[o] = s.depth[i] / maxHeight;
      P.bank[o] = s.bank[i] / worldSize;
      P.reach[o] = ri;
      P.last[o] = i === s.count - 1 ? 1 : 0;
      if (r.mouth) { P.mu[o] = r.mouth.x / worldSize + 0.5; P.mv[o] = r.mouth.z / worldSize + 0.5; }
    }
  });
  return P;
}

/**
 * @param {object} o
 * @param {object} o.packed  packReaches output
 * @param {number} o.size    heightmap texels per side
 * @param {object} o.u       { bedCurve, freeboardN, lipFrac, slopeToUv, flareMax,
 *   overhangUV?, levee0?, levee1? } — the last three (UV) switch on the natural
 *   levee under the water surface's overhang; absent = River v2's section
 * @returns {null|{rect, apply, maxReach}}
 */
export function buildRiverV3TerrainOp({ packed: P, size, u: uIn }) {
  // No levee constants → no levee (hold = 1 everywhere): River v2's section.
  const u = uIn.levee1 > 0 ? uIn : { ...uIn, overhangUV: -2, levee0: 0, levee1: 1 };
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
  // Where the carve itself is evaluated (the covered cells)…
  const carveRect = {
    x0: cx0 * CELL, z0: cz0 * CELL,
    x1: Math.min(size - 1, cx1 * CELL + CELL - 1), z1: Math.min(size - 1, cz1 * CELL + CELL - 1),
  };
  // …and what it can change: grown by the SMOOTHING width, since the softened
  // edge spills that far (u.smooth, texels; 0 = the exact section).
  const B = Math.max(0, Math.min(4, Math.round(u.smooth ?? 0)));
  const rect = {
    x0: Math.max(0, carveRect.x0 - B), z0: Math.max(0, carveRect.z0 - B),
    x1: Math.min(size - 1, carveRect.x1 + B), z1: Math.min(size - 1, carveRect.z1 + B),
  };
  const maxReach2 = margin * margin / (size * size);

  // The cross-section of segment k at parameter t, distance `dist` (UV), over
  // ground `natural`. Returns NaN where it has eased back to natural ground.
  let secIn = false, secLevel = 0;
  // Level / depth+scour at the crest-shifted arc of a stepped stretch (side =
  // signed distance across, UV). Elsewhere: the segment's own, as River v2.
  let shLevel = 0, shDepth = 0;
  function shifted(k, t, side, halfW) {
    const lerp = (a) => a[k] + (a[k + 1] - a[k]) * t;
    if (!P.zone[k] && !P.zone[k + 1]) {
      shLevel = lerp(P.level); shDepth = lerp(P.depth) + lerp(P.scour);
      return;
    }
    const a = side / Math.max(halfW, 1e-9);
    const ac = a < -1 ? -1 : a > 1 ? 1 : a, d = (ac - lerp(P.crP)) / 0.22;
    const te = Math.min(1, Math.max(0, (Math.abs(ac) - 0.6) / 0.4));   // crestShift's taper
    const sh = (lerp(P.crA) * ac + lerp(P.crB) * (1 - ac * ac) + lerp(P.crN) * Math.exp(-d * d)) * (1 - te * te * (3 - 2 * te));
    const b0 = P.base[k], b1 = b0 + P.cnt[k] - 1;
    const s = Math.min(P.arc[b1], Math.max(P.arc[b0], lerp(P.arc) + sh));
    let lo = b0, hi = b1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.arc[m] > s) hi = m; else lo = m; }
    const f = (s - P.arc[lo]) / Math.max(P.arc[hi] - P.arc[lo], 1e-9);
    shLevel = P.level[lo] + (P.level[hi] - P.level[lo]) * f;
    shDepth = P.depth[lo] + (P.depth[hi] - P.depth[lo]) * f + P.scour[lo] + (P.scour[hi] - P.scour[lo]) * f;
  }
  function section(natural, k, t, dist, side = 0) {
    const lerp = (a) => a[k] + (a[k + 1] - a[k]) * t;
    const halfW = lerp(P.halfW);
    shifted(k, t, side, halfW);
    const level = shLevel;
    secLevel = level;
    if (dist <= halfW) {
      secIn = true;
      const depth = shDepth;
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
    const h = lip + (natural - lip) * smooth01(u.lipFrac, 1, ub);
    // NATURAL LEVEE: under the water surface's overhang (and a little past it)
    // the bank never drops below half a freeboard above the water. A floodplain
    // at the river's own level otherwise sat a few cm above the surface, the
    // waves lifted the water over it, and it showed as a sheet of water cut off
    // by the ribbon's straight edge (seen beside a tributary in the river lab).
    // Further out it eases back to the natural ground.
    const beyond = dist - halfW;
    const hold = smooth01(u.overhangUV + u.levee0, u.overhangUV + u.levee1, beyond);
    const floor = level + u.freeboardN * 0.5;
    return h < floor ? h + (floor - h) * (1 - hold) : h;
  }

  // The best segment of each of the K nearest REACHES. A confluence is three
  // reaches meeting (two tributaries and the trunk), so two is not enough:
  // keeping only the two tributaries let both their banks stand up inside the
  // trunk's channel (measured +0.44 m in the test before this was 4).
  const K = 4;
  const bd = new Float64Array(K), bk = new Int32Array(K), bt = new Float64Array(K), br = new Int32Array(K);
  const bs = new Float64Array(K);   // signed distance across (UV), + = the ribbon's +across side

  // OWNERSHIP (op.owner, set by the caller): per texel, 1 + the index of the
  // reach whose segment is nearest, 0 where no river reaches. A reach's water
  // surface draws only where it owns the pixel, so at a junction the surfaces
  // meet on one seam instead of overlapping (overlap drew the water twice,
  // darker, with the tributary's square end poking into the trunk).
  /**
   * SMOOTHED CARVE (u.smooth > 0). The exact section has creases sharper than
   * the terrain grid can shade: the flat-bottomed bed meets the water at ~65°
   * right where the bank starts out flat, and the lip and the step risers are
   * kinks — on 1 m texels they render as faceted "low poly" banks (the user,
   * 2026-10-17). So the river carves into a scratch copy, takes the DIFFERENCE
   * it makes to the natural ground, blurs that over ±B texels (two box passes
   * ≈ a tent) and adds it back. Creases become curves; the ground outside the
   * river and the eroded detail inside it are untouched.
   */
  function apply(out, ground, r) {
    const owner = op.owner ?? null;
    if (owner) {
      for (let z = Math.max(0, r.z0); z <= Math.min(size - 1, r.z1); z++) {
        owner.fill(0, z * size + Math.max(0, r.x0), z * size + Math.min(size - 1, r.x1) + 1);
      }
    }
    if (!B) { carve(out, out, r, owner); return; }
    // The core (what this call writes) and a margin of B texels round it,
    // whose carve the blur needs. The margin is outside the composed rect, so
    // its incoming height is not known: GROUND stands in (only the bank flare
    // and ease read it, and only for those few texels).
    const c = { x0: Math.max(rect.x0, r.x0), z0: Math.max(rect.z0, r.z0), x1: Math.min(rect.x1, r.x1), z1: Math.min(rect.z1, r.z1) };
    if (c.x1 < c.x0 || c.z1 < c.z0) return;
    const R = { x0: Math.max(0, c.x0 - B), z0: Math.max(0, c.z0 - B), x1: Math.min(size - 1, c.x1 + B), z1: Math.min(size - 1, c.z1 + B) };
    const W = R.x1 - R.x0 + 1, H = R.z1 - R.z0 + 1;
    const nat = scratch(0, size * size), shaped = scratch(1, size * size), floor = scratch(4, size * size);
    for (let z = R.z0; z <= R.z1; z++) for (let x = R.x0; x <= R.x1; x++) {
      const i = z * size + x;
      const inCore = x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
      nat[i] = shaped[i] = inCore ? out[i] : ground[i];
      floor[i] = -FAR;
    }
    carve(shaped, nat, R, owner, floor);
    // Delta, blurred: two separable box passes of radius 1 → a 5-texel tent
    // per pass pair; repeated B/… times for wider smoothing.
    const d = scratch(2, W * H), t = scratch(3, W * H);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      const i = (R.z0 + z) * size + R.x0 + x;
      d[z * W + x] = shaped[i] - nat[i];
    }
    const box = (src, dst, horiz) => {
      for (let a = 0; a < (horiz ? H : W); a++) {
        for (let b = 0; b < (horiz ? W : H); b++) {
          let s = 0, n = 0;
          for (let k = -1; k <= 1; k++) {
            const bb = b + k;
            if (bb < 0 || bb >= (horiz ? W : H)) continue;
            s += horiz ? src[a * W + bb] : src[bb * W + a]; n++;
          }
          if (horiz) dst[a * W + b] = s / n; else dst[b * W + a] = s / n;
        }
      }
    };
    for (let pass = 0; pass < B; pass++) { box(d, t, true); box(t, d, false); }
    // …but a bank never blurs down below the water beside it. Across a step
    // the blur pulled the bank just above the drop toward the lower pool, and
    // the upper pool's water stood over it in thin blades at every crest end
    // (seen on nam-valley, 2026-10-17; worse with tilted crests).
    for (let z = c.z0; z <= c.z1; z++) for (let x = c.x0; x <= c.x1; x++) {
      const i = z * size + x;
      out[i] = Math.max(out[i] + d[(z - R.z0) * W + (x - R.x0)], floor[i]);
    }
  }

  /** The exact carve into `dst` inside `r`, reading the natural height from `nat`. */
  function carve(dst, nat, r, owner, floor = null) {
    const out = dst;
    const rx0 = Math.max(r.x0, carveRect.x0), rz0 = Math.max(r.z0, carveRect.z0);
    const rx1 = Math.min(r.x1, carveRect.x1), rz1 = Math.min(r.z1, carveRect.z1);
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
          // Past an open mouth this reach stops dead (see the header).
          const mu = P.mu[k];
          if (mu >= 0 && (uu - mu) * P.mnx[k] + (v - P.mv[k]) * P.mnz[k] > 0) continue;
          const rk = P.reach[k];
          // Already have this reach? Keep its nearer segment.
          let slot = -1;
          for (let q = 0; q < nb; q++) if (br[q] === rk) { slot = q; break; }
          if (slot >= 0) {
            if (d >= bd[slot]) continue;
            for (let q = slot; q < nb - 1; q++) { bd[q] = bd[q + 1]; bk[q] = bk[q + 1]; bt[q] = bt[q + 1]; br[q] = br[q + 1]; bs[q] = bs[q + 1]; }
            nb--;
          } else if (!many && nb) {
            continue;                  // single-reach cell: only ever one entry
          }
          if (nb === K && d >= bd[K - 1]) continue;
          let at = Math.min(nb, K - 1);
          while (at > 0 && bd[at - 1] > d) {
            bd[at] = bd[at - 1]; bk[at] = bk[at - 1]; bt[at] = bt[at - 1]; br[at] = br[at - 1]; bs[at] = bs[at - 1]; at--;
          }
          bd[at] = d; bk[at] = k; bt[at] = t; br[at] = rk;
          bs[at] = (abx * dz - abz * dx) >= 0 ? Math.sqrt(d) : -Math.sqrt(d);
          if (nb < K) nb++;
        }
        if (!nb) continue;
        // Natural = the height handed in (GROUND plus any operator before this
        // one, e.g. the erosion filter), so operators chain: from bare GROUND
        // the bank stepped back to un-eroded ground at the footprint edge.
        const i = tz * size + tx, natural = nat[i];
        // Combine: inside any channel → the lowest bed (smooth min, which also
        // digs the confluence scour); otherwise the lowest bank.
        // The OWNER follows the water, not the distance: inside a channel, the
        // reach with the lowest bed (the same one that shapes it); on the banks,
        // the nearest. Owning by distance gave the tributary a wedge of the
        // trunk's channel that its own, narrower surface could not cover —
        // holes in the water at the confluence (seen in the river lab).
        // A reach can only own pixels its SURFACE covers — along its length, not
        // past its first or last station (its ribbon ends square there). Lowest
        // bed among those wins. "Lowest bed" alone handed a deeper downstream
        // reach the pixels just above its start, where it has no surface: a
        // stepped hole in the water above the junction (seen in the river lab).
        let bed = Infinity, bedDepth = 0, bank = NaN, own = bk[0], ownBed = Infinity;
        let bankHi = NaN, bankLevel = 0, nBanks = 0;
        for (let q = 0; q < nb; q++) {
          const kq = bk[q];
          const hq = section(natural, kq, bt[q], Math.sqrt(bd[q]), bs[q]);
          if (secIn) {
            const firstSeg = kq === 0 || P.last[kq - 1] === 1, lastSeg = P.last[kq + 1] === 1;
            // Past an end the surface only exists if that end runs on (a
            // junction end); in-channel there means within half a width of
            // the end, which the run-on covers.
            const covered = !(firstSeg && bt[q] <= 0 && !P.ext[kq]) && !(lastSeg && bt[q] >= 1 && !P.ext[kq + 1]);
            if (covered && hq < ownBed) { ownBed = hq; own = kq; }
            if (bed === Infinity) { bed = hq; bedDepth = P.depth[bk[q]]; continue; }
            const kk = 0.3 * Math.min(bedDepth, P.depth[bk[q]]);
            const hh = Math.max(kk - Math.abs(bed - hq), 0) / Math.max(kk, 1e-12);
            bed = Math.min(bed, hq) - hh * hh * kk * 0.25;
            bedDepth = Math.min(bedDepth, P.depth[bk[q]]);
          } else if (!Number.isNaN(hq)) {
            if (Number.isNaN(bank)) { bank = hq; bankHi = hq; bankLevel = secLevel; nBanks = 1; }
            // The floor is set against the HIGHER water: a tributary still runs
            // down to the junction, so beside its last metres its surface stands
            // above the trunk's, and a floor at the trunk's level let it show
            // over the corner (measured: corner 0.13 m over the junction level,
            // the tributary 0.2-0.3 m).
            else { bank = Math.min(bank, hq); bankHi = Math.max(bankHi, hq); bankLevel = Math.max(bankLevel, secLevel); nBanks++; }
          }
        }
        // Two banks meeting (the corner between channels): the LOWER one, for
        // a smooth corner — "higher" stood the trunk's lip up across the edge
        // of the tributary's mouth (rectangles of dry bank, seen up close) —
        // but never below the water, or a bank that has already eased down to a
        // floodplain lower than the river lets the river spill onto the corner
        // (the square notch seen first). One bank: exactly River v2's section.
        if (nBanks > 1) bank = Math.max(bank, Math.min(bankHi, bankLevel + u.freeboardN * 0.25));
        if (owner) owner[i] = P.reach[own] + 1;
        if (bed !== Infinity) out[i] = bed;
        else if (!Number.isNaN(bank)) {
          out[i] = bank;
          if (floor) floor[i] = Math.min(bank, bankLevel + u.freeboardN * 0.5);
        }
      }
    }
  }

  const op = { rect, apply, maxReach, owner: null };
  return op;
}

/**
 * Per-reach snapshot of what the op depends on, keyed by reach id, so a drag
 * on one reach never marks another dirty (v2 compared by path offset, and one
 * reach gaining a station shifted every later one).
 */
/** Floats per station in a snapshot: u, v, level, halfW, depth, bank, mouth
 *  u/v, crest shape (one hash of the four) and scour. */
const F = 10;

export function snapshotReaches(packed, maxReach, paramsKey) {
  const byId = new Map();
  for (const e of packed.layout) {
    const d = new Float64Array(e.count * F);
    for (let i = 0; i < e.count; i++) {
      const j = e.offset + i;
      d.set([packed.u[j], packed.v[j], packed.level[j], packed.halfW[j], packed.depth[j], packed.bank[j], packed.mu[j], packed.mv[j],
        packed.crA[j] + 3.1 * packed.crB[j] + 7.3 * packed.crN[j] + 11.7 * packed.crP[j], packed.scour[j]], i * F);
    }
    byId.set(e.id, d);
  }
  // A crest-shifted texel reads stations up to maxShift along the reach.
  return { byId, maxReach, paramsKey, pad: packed.maxShift ?? 0 };
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
    const x = d[i * F] * size, z = d[i * F + 1] * size;
    if (!r) r = { x0: x, z0: z, x1: x, z1: z };
    else { r.x0 = Math.min(r.x0, x); r.z0 = Math.min(r.z0, z); r.x1 = Math.max(r.x1, x); r.z1 = Math.max(r.z1, z); }
  };
  const all = (d) => { for (let i = 0; i < d.length / F; i++) grow(d, i); };
  for (const [id, a] of prev.byId) {
    const b = next.byId.get(id);
    if (!b) { all(a); continue; }
    if (a.length !== b.length) { all(a); all(b); continue; }
    const cnt = a.length / F;
    for (let i = 0; i < cnt; i++) {
      let same = true;
      for (let f = 0; f < F; f++) if (a[i * F + f] !== b[i * F + f]) { same = false; break; }
      if (same) continue;
      for (const q of [i - 1, i, i + 1]) if (q >= 0 && q < cnt) { grow(a, q); grow(b, q); }
    }
  }
  for (const [id, b] of next.byId) if (!prev.byId.has(id)) all(b);
  if (!r) return false;
  // + 4 texels: the smoothed carve (u.smooth ≤ 4) spills that far.
  const m = (next.maxReach + Math.max(prev.pad ?? 0, next.pad ?? 0)) * size + 6;
  return {
    x0: Math.max(0, Math.floor(r.x0 - m)), z0: Math.max(0, Math.floor(r.z0 - m)),
    x1: Math.min(size - 1, Math.ceil(r.x1 + m)), z1: Math.min(size - 1, Math.ceil(r.z1 + m)),
  };
}
