// ============================================================================
// SPATIAL GRID — "who is near here" without asking everyone.
//
// Avoidance, separation and target acquisition each asked EVERY unit about
// EVERY other unit, every tick: O(n²). MEASURED with the stress benchmark, 300
// idle soldiers cost 8.8 ms of game CPU per frame — units.update 4.6 ms and
// combat.update 2.4 ms — and 3x the soldiers cost 9x the time. The same loops
// were in rts-v3; they hid there because the CPU ran under the GPU's 16.7 ms.
//
// A uniform grid of square cells, rebuilt from scratch whenever asked, by
// COUNTING SORT into flat typed arrays: count per cell, prefix-sum, place. No
// Map, no per-cell arrays, no allocation once the scratch has grown.
// Rebuilding every tick is the right trade for things that all move:
// incremental updates would cost more bookkeeping than this whole pass.
//
// The grid spans only the BOUNDING BOX of what was filed, not the map: its
// cost is O(items + cells) and a whole-map grid of 4 m cells is 65,536 cells
// to clear and prefix-sum on every rebuild, however few units there are —
// MEASURED at 20% of units.update for 300 idle soldiers with 8 m whole-map
// cells. Bounded by the army's spread, twenty units cost twenty units' worth.
// If the spread would need more than MAX_DIM cells a side, the cells grow
// instead, which keeps every answer correct and only widens the superset.
//
// A query returns every item in the cells the circle's bounding square
// touches — a SUPERSET. Callers keep their own exact distance test, which is
// what lets them switch to it without changing a single decision.
// ============================================================================

const MAX_DIM = 256;

/**
 * @param {object} o
 * @param {number} o.cellSize  metres; ~ the common query radius (a floor, see MAX_DIM)
 */
export function createSpatialGrid({ cellSize = 4 } = {}) {
  const start = new Int32Array(MAX_DIM * MAX_DIM + 1);   // cell c's items: [start[c], start[c+1])
  const cursor = new Int32Array(MAX_DIM * MAX_DIM);      // counts, then the placement cursor
  let cellOf = new Int32Array(256);                      // per accepted item, its cell
  const scratch = [];                                    // accepted items, in list order
  const items = [];                                      // accepted items, sorted by cell
  let n = 0;
  let maxRadius = 0;
  let minX = 0, minZ = 0, cs = cellSize, dimX = 1, dimZ = 1;

  const cx = (x) => { const c = Math.floor((x - minX) / cs); return c < 0 ? 0 : c >= dimX ? dimX - 1 : c; };
  const cz = (z) => { const c = Math.floor((z - minZ) / cs); return c < 0 ? 0 : c >= dimZ ? dimZ - 1 : c; };

  /**
   * Re-sort `list` into the grid. `accept(item, index)` decides membership and
   * may stamp the item (e.g. with its list index); items need `.position`.
   */
  function rebuild(list, accept) {
    n = 0;
    maxRadius = 0;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!accept(it, i)) continue;
      scratch[n++] = it;
      const p = it.position;
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z;
      if (p.z > z1) z1 = p.z;
      const r = it.radius ?? 0;
      if (r > maxRadius) maxRadius = r;
    }
    scratch.length = n;
    if (n === 0) { items.length = 0; dimX = dimZ = 1; start[0] = start[1] = 0; return; }

    minX = x0; minZ = z0;
    cs = Math.max(cellSize, (x1 - x0) / (MAX_DIM - 1), (z1 - z0) / (MAX_DIM - 1));
    dimX = Math.floor((x1 - x0) / cs) + 1;
    dimZ = Math.floor((z1 - z0) / cs) + 1;
    const cells = dimX * dimZ;

    if (cellOf.length < n) cellOf = new Int32Array(Math.max(n, cellOf.length * 2));
    cursor.fill(0, 0, cells);
    for (let k = 0; k < n; k++) {
      const p = scratch[k].position;
      const c = cz(p.z) * dimX + cx(p.x);
      cellOf[k] = c;
      cursor[c]++;
    }
    start[0] = 0;
    for (let c = 0; c < cells; c++) {
      start[c + 1] = start[c] + cursor[c];
      cursor[c] = start[c];
    }
    for (let k = 0; k < n; k++) items[cursor[cellOf[k]]++] = scratch[k];
    items.length = n;   // drop stale references so a despawned unit can be collected
  }

  /**
   * Every item in the cells covering the circle (x, z, r) — a superset; the
   * caller does the exact test. Fills and returns `out` (reused).
   */
  function query(x, z, r, out) {
    out.length = 0;
    if (n === 0) return out;
    // Entirely outside what was filed: nothing to find (clamping would
    // otherwise pull in the nearest edge cells for nothing).
    if (x + r < minX || z + r < minZ || x - r > minX + dimX * cs || z - r > minZ + dimZ * cs) return out;
    const xa = cx(x - r), xb = cx(x + r), za = cz(z - r), zb = cz(z + r);
    for (let gz = za; gz <= zb; gz++) {
      const row = gz * dimX;
      for (let gx = xa; gx <= xb; gx++) {
        const c = row + gx;
        for (let k = start[c], e = start[c + 1]; k < e; k++) out.push(items[k]);
      }
    }
    return out;
  }

  return {
    rebuild,
    query,
    /** Largest `.radius` among the items of the last rebuild. */
    get maxRadius() { return maxRadius; },
    get count() { return n; },
  };
}
