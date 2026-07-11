// Navigation grid + A* pathfinding — GAME code.
//
// Builds a walkability grid over the world from terrain slope (steep = blocked),
// then A* finds a path of world-space waypoints between two points. Ground units
// follow the waypoints; air units ignore it (they fly straight).
//
// Milestone scope: slope-based only. Water and prop footprints are TODO — they
// need engine queries (isWater / queryProps) that aren't exposed yet.
import * as THREE from "three";

export function createNavGrid({ app, maxSlopeDeg = 34, maxCellsPerSide = 256 } = {}) {
  const world = app.worldSize ?? 1000;
  const half = world / 2;
  // Adaptive cell size so a huge world doesn't explode the grid.
  const cell = Math.max(4, world / maxCellsPerSide);
  const cols = Math.max(1, Math.ceil(world / cell));
  const rows = cols;
  const blocked = new Uint8Array(cols * rows);
  const cosMax = Math.cos((maxSlopeDeg * Math.PI) / 180);

  const idx = (cx, cz) => cz * cols + cx;
  const inBounds = (cx, cz) => cx >= 0 && cz >= 0 && cx < cols && cz < rows;
  const isBlocked = (cx, cz) => !inBounds(cx, cz) || blocked[idx(cx, cz)] === 1;

  const worldToCell = (wx, wz) => ({
    cx: THREE.MathUtils.clamp(Math.floor((wx + half) / cell), 0, cols - 1),
    cz: THREE.MathUtils.clamp(Math.floor((wz + half) / cell), 0, rows - 1),
  });
  const cellToWorld = (cx, cz) => ({
    x: -half + (cx + 0.5) * cell,
    z: -half + (cz + 0.5) * cell,
  });

  // ── Build walkability from terrain slope ────────────────────────────────────
  function build() {
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        const { x, z } = cellToWorld(cx, cz);
        const n = app.getWorldNormal(x, z); // shared vector — read .y now
        blocked[idx(cx, cz)] = n.y < cosMax ? 1 : 0;
      }
    }
  }
  build();

  /** Nearest walkable cell to a world point (spiral out), or null. */
  function nearestOpen(wx, wz, maxR = 12) {
    const { cx, cz } = worldToCell(wx, wz);
    if (!isBlocked(cx, cz)) return { cx, cz };
    for (let r = 1; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!isBlocked(cx + dx, cz + dz)) return { cx: cx + dx, cz: cz + dz };
        }
      }
    }
    return null;
  }

  // 8-connected neighbours; diagonals blocked if they'd clip a corner.
  const NB = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];

  /** A* between two world points. Returns [{x,z}, …] waypoints, or null. */
  function findPath(sx, sz, tx, tz) {
    const start = nearestOpen(sx, sz);
    const goal = nearestOpen(tx, tz);
    if (!start || !goal) return null;
    const startI = idx(start.cx, start.cz);
    const goalI = idx(goal.cx, goal.cz);
    if (startI === goalI) return [{ x: tx, z: tz }];

    const h = (cx, cz) => Math.hypot(cx - goal.cx, cz - goal.cz);
    const gScore = new Float32Array(cols * rows).fill(Infinity);
    const came = new Int32Array(cols * rows).fill(-1);
    const open = new MinHeap();
    gScore[startI] = 0;
    open.push(startI, h(start.cx, start.cz));
    const closed = new Uint8Array(cols * rows);

    while (open.size) {
      const cur = open.pop();
      if (cur === goalI) return reconstruct(came, cur, tx, tz);
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ccx = cur % cols, ccz = (cur - ccx) / cols;

      for (const [dx, dz, cost] of NB) {
        const nx = ccx + dx, nz = ccz + dz;
        if (isBlocked(nx, nz)) continue;
        if (cost > 1 && (isBlocked(ccx + dx, ccz) || isBlocked(ccx, ccz + dz))) continue; // no corner-cutting
        const ni = idx(nx, nz);
        if (closed[ni]) continue;
        const tentative = gScore[cur] + cost;
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative;
          came[ni] = cur;
          open.push(ni, tentative + h(nx, nz));
        }
      }
    }
    return null; // no route
  }

  function reconstruct(came, endI, tx, tz) {
    const cells = [];
    let i = endI;
    while (i !== -1) { cells.push(i); i = came[i]; }
    cells.reverse();
    // Cell centres → world; drop collinear points so units don't micro-step.
    const pts = cells.map((ci) => { const cx = ci % cols; return cellToWorld(cx, (ci - cx) / cols); });
    const simplified = simplify(pts);
    simplified.push({ x: tx, z: tz }); // finish exactly on the click
    return simplified;
  }

  function simplify(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const bcx = c.x - b.x, bcz = c.z - b.z;
      // Keep the point only if the direction changes (cross product ≠ 0).
      if (Math.abs(abx * bcz - abz * bcx) > 1e-3) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  return {
    cell, cols, rows,
    findPath,
    isBlockedAtWorld: (wx, wz) => { const c = worldToCell(wx, wz); return isBlocked(c.cx, c.cz); },
    rebuild: build,
  };
}

// Tiny binary min-heap keyed by priority; stores grid indices.
class MinHeap {
  constructor() { this.items = []; this.prio = []; }
  get size() { return this.items.length; }
  push(item, prio) {
    this.items.push(item); this.prio.push(prio);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p] <= this.prio[i]) break;
      this._swap(i, p); i = p;
    }
  }
  pop() {
    const top = this.items[0];
    const last = this.items.length - 1;
    this._swap(0, last);
    this.items.pop(); this.prio.pop();
    let i = 0;
    const n = this.items.length;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let s = i;
      if (l < n && this.prio[l] < this.prio[s]) s = l;
      if (r < n && this.prio[r] < this.prio[s]) s = r;
      if (s === i) break;
      this._swap(i, s); i = s;
    }
    return top;
  }
  _swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}
