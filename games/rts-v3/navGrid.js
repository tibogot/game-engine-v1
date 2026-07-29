// Navigation grid + A* pathfinding — GAME code.
//
// Builds a walkability grid over the world from:
//   • terrain slope (steep = blocked),
//   • lakes (inside the bounds quad, below water level),
//   • props & trees (footprint circles).
// Then A* finds a path, string-pulled by line-of-sight into natural diagonals.
// Ground units follow the waypoints; air units ignore it (they fly straight).
//
// All obstacle data comes off the engine handle (app.lakeSystem / propStore /
// treeEnv) — no engine changes. Rivers aren't queried yet (GPU-carved). A "nav
// debug" overlay (red = blocked) can be toggled to verify the grid.
import * as THREE from "three";

export function createNavGrid({
  app,
  maxSlopeDeg = 34,
  maxCellsPerSide = 256,
  minPropRadius = 1.0,     // props smaller than this don't block (grass, flowers…)
  shorelineMargin = 3.5,   // metres of clearance kept between ground units and water
} = {}) {
  const world = app.worldSize ?? 1000;
  const half = world / 2;
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
  const cellToWorld = (cx, cz) => ({ x: -half + (cx + 0.5) * cell, z: -half + (cz + 0.5) * cell });

  // ── Obstacle stamping ───────────────────────────────────────────────────────
  function stampCircle(wx, wz, radius) {
    const r = Math.max(radius, cell * 0.5);
    const min = worldToCell(wx - r, wz - r);
    const max = worldToCell(wx + r, wz + r);
    const r2 = r * r;
    for (let cz = min.cz; cz <= max.cz; cz++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        const c = cellToWorld(cx, cz);
        if ((c.x - wx) ** 2 + (c.z - wz) ** 2 <= r2) blocked[idx(cx, cz)] = 1;
      }
    }
  }

  function stampProps() {
    const ps = app.propStore;
    if (!ps?.instances) return;
    for (const inst of ps.instances) {
      const type = ps.types?.[inst.typeIdx];
      if (!type || type.live) continue; // live props (flags/coins) aren't obstacles
      const box = type.mergedBox;
      if (!box) continue;
      const size = box.getSize(new THREE.Vector3());
      const radius = 0.5 * Math.max(size.x, size.z) * Math.max(inst.sx ?? 1, inst.sz ?? 1);
      if (radius >= minPropRadius) stampCircle(inst.px, inst.pz, radius);
    }
  }

  function stampTrees() {
    const chunks = app.treeEnv?.treeStore?.chunks;
    if (!chunks) return;
    for (const arr of chunks.values()) {
      for (const t of arr) stampCircle(t.x, t.z, 1.2 * (t.scale ?? 1));
    }
  }

  // Clear an oriented rectangle (bridge deck) back to walkable. World→local uses
  // the transpose of three.js's Y-rotation so a long/narrow deck maps correctly.
  function carveOrientedRect(wx, wz, halfX, halfZ, ry) {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    const rad = Math.hypot(halfX, halfZ);
    const min = worldToCell(wx - rad, wz - rad);
    const max = worldToCell(wx + rad, wz + rad);
    for (let cz = min.cz; cz <= max.cz; cz++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        const c = cellToWorld(cx, cz);
        const dx = c.x - wx, dz = c.z - wz;
        const lx = cos * dx - sin * dz;
        const lz = sin * dx + cos * dz;
        if (Math.abs(lx) <= halfX && Math.abs(lz) <= halfZ) blocked[idx(cx, cz)] = 0;
      }
    }
  }

  function structureNavRadius(s) {
    const t = s.type ?? s;
    return t.navRadius ?? (s.radius ?? t.radius ?? 4) + 2;
  }

  /** Stamp a structure footprint on the nav grid; HQ types also carve a door lane. */
  function addStructureObstacle(s) {
    const wx = s.position.x;
    const wz = s.position.z;
    stampCircle(wx, wz, structureNavRadius(s));
    const ap = s.type?.doorApproach;
    if (!ap) return;
    const dx = ap.dirX ?? 0;
    const dz = ap.dirZ ?? -1;
    const len = ap.length ?? 24;
    const hw = ap.halfWidth ?? 7;
    const ry = Math.atan2(dx, dz);
    carveOrientedRect(wx + dx * len * 0.5, wz + dz * len * 0.5, hw, len * 0.5, ry);
  }

  // Bridges (props named "bridge*") punch a walkable corridor through whatever
  // they span — a river, say. Runs AFTER all obstacle stamping so it wins. This
  // is the one place editor-authored geometry maps to a nav *override*: place a
  // bridge model in the editor and it becomes a real crossing automatically.
  function carveBridges() {
    const ps = app.propStore;
    if (!ps?.instances) return;
    for (const inst of ps.instances) {
      const type = ps.types?.[inst.typeIdx];
      if (!type || type.live || !/bridge/i.test(type.name || "")) continue;
      const box = type.mergedBox;
      if (!box) continue;
      const size = box.getSize(new THREE.Vector3());
      const halfX = 0.5 * size.x * (inst.sx ?? 1);
      const halfZ = 0.5 * size.z * (inst.sz ?? 1);
      carveOrientedRect(inst.px, inst.pz, halfX, halfZ, inst.ry ?? 0);
    }
  }

  // Rivers are GPU-carved, but their authoring geometry is a CatmullRom curve
  // through control points with a width — same curve the renderer uses. We
  // sample it and stamp the channel half-width along its length.
  function stampRivers() {
    const rs = app.river2System;
    if (!rs?.segments) return;
    const rp = rs.toolState?.river2 ?? {};
    const halfW = (rp.width ?? 8) * 0.5;
    for (const seg of rs.segments) {
      if (!seg.points || seg.points.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(seg.points, !!rp.closed, "catmullrom", 0.5);
      const steps = Math.max(2, Math.ceil(curve.getLength() / Math.max(1, halfW)));
      for (const p of curve.getSpacedPoints(steps)) stampCircle(p.x, p.z, halfW);
    }
  }

  // ── Build ────────────────────────────────────────────────────────────────────
  function build() {
    const water = new Uint8Array(cols * rows);
    const hc = cell * 0.5;
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        const { x, z } = cellToWorld(cx, cz);
        const n = app.getWorldNormal(x, z);
        let block = n.y < cosMax;

        // Water: sample the cell centre AND its corners so shoreline cells that
        // are only partly submerged still count — otherwise the blocked region
        // shrinks inward and units drive into shallow water.
        if (app.getWaterLevelAt) {
          const wl = app.getWaterLevelAt(x, z);
          if (wl > -Infinity && (
            wl > app.getWorldHeight(x, z) ||
            wl > app.getWorldHeight(x - hc, z - hc) ||
            wl > app.getWorldHeight(x + hc, z - hc) ||
            wl > app.getWorldHeight(x - hc, z + hc) ||
            wl > app.getWorldHeight(x + hc, z + hc)
          )) { block = true; water[idx(cx, cz)] = 1; }
        }
        blocked[idx(cx, cz)] = block ? 1 : 0;
      }
    }

    // Fill the lake interior: any cell you can't reach from the map edge
    // without crossing water is enclosed by water → block it. This solidifies
    // bumpy lakebeds (dry patches inside the lake) so units can't thread through.
    fillEnclosedWater(water);

    // Push the water boundary onto land by the shoreline margin, so a ground
    // unit's body stops at the edge instead of overlapping the water.
    dilate(water, Math.max(1, Math.round(shorelineMargin / cell)));

    stampRivers();
    stampProps();
    stampTrees();
    carveBridges(); // last: bridges override obstacles to make crossings walkable
    if (debugMesh) { app.scene.remove(debugMesh); debugMesh.geometry.dispose(); debugMesh = null; }
  }

  // Flood non-water cells from the map border; any non-water cell left unreached
  // is trapped inside a water body → mark it water/blocked. Fills lake interiors.
  function fillEnclosedWater(water) {
    const reach = new Uint8Array(cols * rows);
    const stack = [];
    const seed = (cx, cz) => { const i = idx(cx, cz); if (!water[i] && !reach[i]) { reach[i] = 1; stack.push(i); } };
    for (let cx = 0; cx < cols; cx++) { seed(cx, 0); seed(cx, rows - 1); }
    for (let cz = 0; cz < rows; cz++) { seed(0, cz); seed(cols - 1, cz); }
    while (stack.length) {
      const i = stack.pop();
      const cx = i % cols, cz = (i - cx) / cols;
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [dx, dz] of nb) {
        const nx = cx + dx, nz = cz + dz;
        if (!inBounds(nx, nz)) continue;
        const ni = idx(nx, nz);
        if (reach[ni] || water[ni]) continue;
        reach[ni] = 1; stack.push(ni);
      }
    }
    for (let i = 0; i < water.length; i++) {
      if (!water[i] && !reach[i]) { water[i] = 1; blocked[i] = 1; }
    }
  }

  // Grow a mask outward by `m` cells (circular), marking those cells blocked.
  function dilate(mask, m) {
    if (m <= 0) return;
    const m2 = m * m;
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!mask[idx(cx, cz)]) continue;
        for (let dz = -m; dz <= m; dz++) {
          for (let dx = -m; dx <= m; dx++) {
            if (dx * dx + dz * dz > m2) continue;
            const nx = cx + dx, nz = cz + dz;
            if (inBounds(nx, nz)) blocked[idx(nx, nz)] = 1;
          }
        }
      }
    }
  }

  function nearestOpen(wx, wz, maxR = 16) {
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

  const NB = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];

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
    const closed = new Uint8Array(cols * rows);
    const open = new MinHeap();
    gScore[startI] = 0;
    open.push(startI, h(start.cx, start.cz));

    while (open.size) {
      const cur = open.pop();
      if (cur === goalI) return reconstruct(came, cur, tx, tz);
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ccx = cur % cols, ccz = (cur - ccx) / cols;
      for (const [dx, dz, cost] of NB) {
        const nx = ccx + dx, nz = ccz + dz;
        if (isBlocked(nx, nz)) continue;
        if (cost > 1 && (isBlocked(ccx + dx, ccz) || isBlocked(ccx, ccz + dz))) continue;
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
    return null;
  }

  function reconstruct(came, endI, tx, tz) {
    const cells = [];
    for (let i = endI; i !== -1; i = came[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((ci) => { const cx = ci % cols; return cellToWorld(cx, (ci - cx) / cols); });
    const pulled = stringPull(pts);
    // Finish exactly on the click ONLY if it's walkable. If you clicked into a
    // lake/obstacle, end on the last reachable cell (the shore) instead of
    // driving straight into the water to reach the raw click point.
    const tc = worldToCell(tx, tz);
    if (!isBlocked(tc.cx, tc.cz)) pulled.push({ x: tx, z: tz });
    return pulled;
  }

  // Sample the segment at half-cell steps; clear only if no cell is blocked.
  function hasLineOfSight(a, b) {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(dist / (cell * 0.5)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const c = worldToCell(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (isBlocked(c.cx, c.cz)) return false;
    }
    return true;
  }

  // Greedy string-pull: from each anchor, reach the farthest point with clear LOS.
  function stringPull(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !hasLineOfSight(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  // ── Debug overlay (red = blocked) ────────────────────────────────────────────
  let debugMesh = null;
  function buildDebug() {
    let count = 0;
    for (let i = 0; i < blocked.length; i++) if (blocked[i]) count++;
    const geo = new THREE.PlaneGeometry(cell * 0.92, cell * 0.92).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.4, depthWrite: false, fog: false });
    debugMesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    let w = 0;
    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        if (!blocked[idx(cx, cz)]) continue;
        const c = cellToWorld(cx, cz);
        // Sit on the water surface over water, else on the ground — so the
        // overlay reads at the level you actually see, not the sunken lakebed.
        let y = app.getWorldHeight(c.x, c.z);
        const wl = app.getWaterLevelAt?.(c.x, c.z) ?? -Infinity;
        if (wl > y) y = wl;
        m.setPosition(c.x, y + 0.4, c.z);
        debugMesh.setMatrixAt(w++, m);
      }
    }
    debugMesh.instanceMatrix.needsUpdate = true;
    debugMesh.renderOrder = 998;
    debugMesh.visible = false;
    app.scene.add(debugMesh);
  }
  function setDebug(on) {
    if (!debugMesh) buildDebug();
    debugMesh.visible = on;
  }
  function toggleDebug() { setDebug(!(debugMesh?.visible)); return !!debugMesh?.visible; }

  build();

  return {
    cell, cols, rows,
    findPath,
    isBlockedAtWorld: (wx, wz) => { const c = worldToCell(wx, wz); return isBlocked(c.cx, c.cz); },
    /**
     * Nearest walkable world point. Returns the point UNCHANGED when it's
     * already open — snapping to the cell centre would collapse several
     * distinct spawn points onto one spot (cells are metres wide).
     */
    nearestOpenWorld: (wx, wz) => {
      const c0 = worldToCell(wx, wz);
      if (!isBlocked(c0.cx, c0.cz)) return { x: wx, z: wz };
      const c = nearestOpen(wx, wz);
      return c ? cellToWorld(c.cx, c.cz) : { x: wx, z: wz };
    },
    rebuild: build,
    /** Block a circle (legacy — prefer addStructureObstacle for buildings). */
    addObstacle: (wx, wz, radius) => { stampCircle(wx, wz, radius); },
    addStructureObstacle,
    /** Straight-line walkability between two world points (waypoint lookahead). */
    hasLOS: (ax, az, bx, bz) => hasLineOfSight({ x: ax, z: az }, { x: bx, z: bz }),
    setDebug,
    toggleDebug,
  };
}

// Binary min-heap keyed by priority; stores grid indices.
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
