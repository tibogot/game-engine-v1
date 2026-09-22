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

/**
 * The slope a ground unit refuses to climb, degrees.
 *
 * Exported because the TERRAIN has to agree with it. Ground the pathfinder
 * will not cross must read as rock, or the player sees a green hillside,
 * orders men up it and watches them refuse, with nothing on screen to explain
 * why. namGame feeds this number to app.setSlopeCliffRule so there is exactly
 * one of it — two constants that mean the same thing drift, and this pair
 * would drift silently.
 */
export const NAV_MAX_SLOPE_DEG = 34;

export function createNavGrid({
  app,
  maxSlopeDeg = NAV_MAX_SLOPE_DEG,
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
    // A building that declares its footprint (buildings.js) blocks exactly
    // that rectangle, not a circle round its bounding radius.
    const fp = s.footprint;
    if (fp) stampFootprint({ x: wx + fp.cx, z: wz + fp.cz, hx: fp.hx, hz: fp.hz, ry: fp.ry ?? 0 });
    else stampCircle(wx, wz, structureNavRadius(s));
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
  //
  // The engine's bridges are PROCEDURAL objects, which are live props built per
  // instance, so they have no type-level mergedBox — their footprint comes from
  // the manager instead. Imported bridge models are static and keep theirs.
  const _boxSize = new THREE.Vector3();
  function carveBridges() {
    const ps = app.propStore;
    if (!ps?.instances) return;
    for (let i = 0; i < ps.instances.length; i++) {
      const inst = ps.instances[i];
      const type = ps.types?.[inst.typeIdx];
      if (!type || !/bridge/i.test(type.name || "")) continue;
      const box = type.live ? app.getLivePropLocalBox?.(i) : type.mergedBox;
      if (!box) continue;
      box.getSize(_boxSize);
      const halfX = 0.5 * _boxSize.x * (inst.sx ?? 1);
      const halfZ = 0.5 * _boxSize.z * (inst.sz ?? 1);
      // inst.ry is DEGREES (propStore applies * DEG everywhere it is used);
      // carveOrientedRect works in radians.
      carveOrientedRect(inst.px, inst.pz, halfX, halfZ, (inst.ry ?? 0) * Math.PI / 180);
    }
  }

  // Barriers: lines units cannot cross — wire, fences, a berm's crest. Kept
  // here and re-stamped on every build (a rebuild wipes every stamp), and
  // stamped as overlapping circles every half cell, so a line is a continuous
  // band; with corner-cutting refused in findPath, nothing leaks diagonally.
  const barriers = [];
  // Footprints: placed buildings and props (placedObjects.js) — an oriented
  // rectangle each, blocked, kept across rebuilds like the barriers.
  const footprints = [];
  function stampFootprint(f) {
    const cos = Math.cos(f.ry), sin = Math.sin(f.ry);
    const rad = Math.hypot(f.hx, f.hz);
    const min = worldToCell(f.x - rad, f.z - rad);
    const max = worldToCell(f.x + rad, f.z + rad);
    for (let cz = min.cz; cz <= max.cz; cz++) {
      for (let cx = min.cx; cx <= max.cx; cx++) {
        const c = cellToWorld(cx, cz);
        const dx = c.x - f.x, dz = c.z - f.z;
        const lx = cos * dx - sin * dz, lz = sin * dx + cos * dz;
        if (Math.abs(lx) <= f.hx && Math.abs(lz) <= f.hz) blocked[idx(cx, cz)] = 1;
      }
    }
  }
  function stampBarrier(b) {
    const step = cell * 0.5;
    for (let i = 0; i < b.points.length - 1; i++) {
      const a = b.points[i], c = b.points[i + 1];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      const n = Math.max(1, Math.ceil(len / step));
      for (let k = 0; k <= n; k++) stampCircle(a.x + ((c.x - a.x) * k) / n, a.z + ((c.z - a.z) * k) / n, b.halfWidth);
    }
  }

  // Rivers (River v2). The water test in build() samples cell centres and
  // corners, which a river narrower than a cell can slip between — so the
  // channel is also stamped along its solved centreline, at each station's own
  // width. Stations are a few metres apart, so a circle per station is a
  // continuous band.
  function stampRivers() {
    for (const ch of app.getRiverChannels?.() ?? []) {
      for (let i = 0; i < ch.count; i++) stampCircle(ch.x[i], ch.z[i], ch.width[i] * 0.5);
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

    // Solidify bumpy lakebeds: dry specks inside a water body are not ground
    // anyone can use, so they are blocked rather than left as pathable islets.
    blockDryScraps(water);

    // Push the water boundary onto land by the shoreline margin, so a ground
    // unit's body stops at the edge instead of overlapping the water.
    dilate(water, Math.max(1, Math.round(shorelineMargin / cell)));

    stampRivers();
    stampProps();
    stampTrees();
    for (const b of barriers) stampBarrier(b);
    for (const f of footprints) stampFootprint(f);
    carveBridges(); // last: bridges override obstacles to make crossings walkable
    if (debugMesh) { app.scene.remove(debugMesh); debugMesh.geometry.dispose(); debugMesh = null; }
  }

  /**
   * Dry ground too small to be ground: a bump in a lakebed, a speck of
   * shoreline. Blocked so a path can never be planned onto it.
   *
   * THIS USED TO FLOOD INWARD FROM THE MAP BORDER and block whatever the
   * flood did not reach — which silently assumed the edge of the map is dry
   * land. Give the world an ocean and the assumption inverts: every border
   * cell is water, so the flood plants no seed at all, reaches nothing, and
   * marks the ENTIRE map as enclosed. Measured on nam-valley before this
   * change: 65,536 cells, 65,504 blocked, 32 walkable — no unit could move
   * anywhere, on a map whose terrain only justifies 59% blocked.
   *
   * Labelling the dry cells into connected components asks the question
   * directly and does not care where the water is. On an inland map the
   * answer is unchanged (the main ground is one big component; lake islets
   * are specks). On an island map it is finally right.
   *
   * A LARGE island is deliberately left walkable even though nothing can
   * reach it on foot: it is real ground, and boats and helicopter drops are
   * the point of this game. Blocking it would quietly delete the terrain.
   */
  function blockDryScraps(water) {
    // ~600 m² — a few cells of lakebed, never a landmass worth fighting over.
    const minCells = Math.max(4, Math.ceil(600 / (cell * cell)));
    const seen = new Uint8Array(cols * rows);
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const component = [];

    for (let start = 0; start < seen.length; start++) {
      if (water[start] || seen[start]) continue;
      component.length = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        component.push(i);
        const cx = i % cols, cz = (i - cx) / cols;
        for (const [dx, dz] of nb) {
          const nx = cx + dx, nz = cz + dz;
          if (!inBounds(nx, nz)) continue;
          const ni = idx(nx, nz);
          if (seen[ni] || water[ni]) continue;
          seen[ni] = 1; stack.push(ni);
        }
      }
      if (component.length < minCells) {
        for (const i of component) { water[i] = 1; blocked[i] = 1; }
      }
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

  /**
   * An A* search with its own scratch, which can run to the end at once
   * (findPath) or a slice at a time (the path queue below). A cell's
   * gScore/came are valid only when stamp[i] === gen — a new search bumps gen
   * instead of refilling three 65k arrays — and closed[i] === gen marks it
   * expanded.
   */
  function createSearch() {
    const N = cols * rows;
    const gScore = new Float32Array(N);
    const came = new Int32Array(N);
    const stamp = new Uint32Array(N);
    const closed = new Uint32Array(N);
    const open = new MinHeap(4096);
    let gen = 0, goalI = -1, gx = 0, gz = 0, tx = 0, tz = 0;
    // OCTILE distance — the true free-ground cost on an 8-way grid, tighter
    // than the straight line — with a 0.1% nudge toward the goal to break the
    // wide plateaus of equal cost it makes (octile ALONE was measured slower:
    // the search spread across the ties). Paths stay within 0.1% of shortest.
    const h = (cx, cz) => {
      const dx = Math.abs(cx - gx), dz = Math.abs(cz - gz);
      return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz)) * 1.001;
    };
    const search = {
      /** Cells expanded by the last run(). */
      pops: 0,
      /** Set up a search. Returns {path} when it is already answered (no ground, same cell), else null. */
      begin(sx, sz, x1, z1) {
        const start = nearestOpen(sx, sz);
        const goal = nearestOpen(x1, z1);
        if (!start || !goal) return { path: null };
        const startI = idx(start.cx, start.cz);
        goalI = idx(goal.cx, goal.cz);
        if (startI === goalI) return { path: [{ x: x1, z: z1 }] };
        gx = goal.cx; gz = goal.cz; tx = x1; tz = z1;
        if (++gen === 0xffffffff) { stamp.fill(0); closed.fill(0); gen = 1; }
        open.clear();
        gScore[startI] = 0; came[startI] = -1; stamp[startI] = gen;
        open.push(startI, h(start.cx, start.cz));
        return null;
      },
      /** Expand up to `maxPops` cells: undefined = not finished yet; else the path, or null when there is none. */
      run(maxPops = Infinity) {
        let n = 0;
        while (open.size) {
          if (n >= maxPops) { search.pops = n; return undefined; }
          const cur = open.pop(); n++;
          if (cur === goalI) { search.pops = n; open.clear(); return reconstruct(came, cur, tx, tz); }
          if (closed[cur] === gen) continue;
          closed[cur] = gen;
          const ccx = cur % cols, ccz = (cur - ccx) / cols;
          const gCur = gScore[cur];
          for (let k = 0; k < 8; k++) {
            const nb = NB[k];
            const dx = nb[0], dz = nb[1], cost = nb[2];
            const nx = ccx + dx, nz = ccz + dz;
            if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
            const ni = nz * cols + nx;
            if (blocked[ni] === 1) continue;
            // No corner-cutting: both orthogonal neighbours of a diagonal step open.
            if (cost > 1 && (blocked[ccz * cols + nx] === 1 || blocked[nz * cols + ccx] === 1)) continue;
            if (closed[ni] === gen) continue;
            const tentative = gCur + cost;
            if (stamp[ni] !== gen || tentative < gScore[ni]) {
              stamp[ni] = gen;
              gScore[ni] = tentative;
              came[ni] = cur;
              open.push(ni, tentative + h(nx, nz));
            }
          }
        }
        search.pops = n;
        return null;
      },
    };
    return search;
  }

  const now = createSearch();
  /** A path, found now. The player's orders use this: a click is answered at once. */
  function findPath(sx, sz, tx, tz) {
    const b = now.begin(sx, sz, tx, tz);
    return b ? b.path : now.run();
  }

  // ── The path QUEUE: searches on a budget ─────────────────────────────────────
  // A search across the map into the walled camp expands most of the grid —
  // MEASURED 13–27 ms, one frame, whenever the enemy AI sent a squad at the HQ.
  // Queued searches run `maxPops` cells a sim step instead (a few frames for
  // the longest; nobody sees a squad start a quarter-second later), on their
  // OWN scratch, so findPath can still answer a click mid-search.
  const queue = [];
  let queued = null;     // the search under way
  let slow = null;       // its scratch, made on first use
  /** Ask for a path; `cb(path | null)` is called from pumpPaths. Returns a job with cancel(). */
  function requestPath(sx, sz, tx, tz, cb) {
    const job = { sx, sz, tx, tz, cb, cancelled: false, cancel() { job.cancelled = true; } };
    queue.push(job);
    return job;
  }
  /** Run queued searches for up to `maxPops` expanded cells. Call once a sim step. */
  function pumpPaths(maxPops = 3000) {
    slow ??= createSearch();
    let budget = maxPops;
    while (budget > 0) {
      if (!queued) {
        const job = queue.shift();
        if (!job) return;
        if (job.cancelled) continue;
        const b = slow.begin(job.sx, job.sz, job.tx, job.tz);
        budget -= 16;                        // nearestOpen's own work, roughly
        if (b) { job.cb(b.path); continue; }
        queued = job;
      }
      const r = slow.run(budget);
      budget -= slow.pops;
      if (r === undefined) return;          // budget spent mid-search: next step
      const job = queued;
      queued = null;
      if (!job.cancelled) job.cb(r);
    }
  }

  function reconstruct(came, endI, tx, tz) {
    const cells = [];
    for (let i = endI; i !== -1; i = came[i]) cells.push(i);   // the start's came is -1
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

  // ── Regions ─────────────────────────────────────────────────────────────────
  // Every walkable cell labelled with its connected component (8-connected,
  // no corner-cutting, as findPath walks), so "can I get there at all?" is two
  // lookups instead of a search. A search to somewhere unreachable floods the
  // whole of the start's region before it gives up — MEASURED 31 ms when the
  // enemy AI tested stage spots on a cliff-ringed shelf. Labelled lazily, on
  // the first question after the grid changed.
  const region = new Int32Array(cols * rows);
  let regionsDirty = true;
  function labelRegions() {
    region.fill(0);
    const stack = new Int32Array(cols * rows);
    let label = 0;
    for (let s = 0; s < region.length; s++) {
      if (blocked[s] === 1 || region[s] !== 0) continue;
      label++;
      let top = 0;
      stack[top++] = s; region[s] = label;
      while (top) {
        const cur = stack[--top];
        const ccx = cur % cols, ccz = (cur - ccx) / cols;
        for (let k = 0; k < 8; k++) {
          const nb = NB[k];
          const nx = ccx + nb[0], nz = ccz + nb[1];
          if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
          const ni = nz * cols + nx;
          if (blocked[ni] === 1 || region[ni] !== 0) continue;
          if (nb[2] > 1 && (blocked[ccz * cols + nx] === 1 || blocked[nz * cols + ccx] === 1)) continue;
          region[ni] = label;
          stack[top++] = ni;
        }
      }
    }
    regionsDirty = false;
  }
  /** Can a ground unit at (ax, az) walk to (bx, bz)? Both snapped to open ground first, as findPath does. */
  function sameRegion(ax, az, bx, bz) {
    if (regionsDirty) labelRegions();
    const a = nearestOpen(ax, az), b = nearestOpen(bx, bz);
    if (!a || !b) return false;
    return region[idx(a.cx, a.cz)] === region[idx(b.cx, b.cz)];
  }
  const dirty = (fn) => (...args) => { regionsDirty = true; return fn(...args); };

  build();

  return {
    cell, cols, rows,
    findPath,
    requestPath,
    pumpPaths,
    /** Searches waiting or under way (dev readout). */
    get queuedPaths() { return queue.length + (queued ? 1 : 0); },
    sameRegion,
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
    rebuild: dirty(build),
    /** Block a circle (legacy — prefer addStructureObstacle for buildings). */
    addObstacle: dirty((wx, wz, radius) => { stampCircle(wx, wz, radius); }),
    addStructureObstacle: dirty(addStructureObstacle),
    /**
     * A line units cannot cross (world points {x, z}), kept across rebuilds.
     * `halfWidth` defaults to 3/4 of a cell so the band is solid. Returns a
     * handle for removeBarrier.
     */
    addBarrier: dirty((points, halfWidth = cell * 0.75) => {
      const b = { points: points.map((p) => ({ x: p.x, z: p.z })), halfWidth };
      barriers.push(b);
      stampBarrier(b);
      return b;
    }),
    removeBarrier: (b) => { const i = barriers.indexOf(b); if (i >= 0) barriers.splice(i, 1); },
    /**
     * An oriented rectangle units cannot enter — a placed building's footprint
     * (centre, half extents, yaw), kept across rebuilds. Returns a handle.
     */
    addFootprint: dirty((x, z, hx, hz, ry = 0) => {
      const f = { x, z, hx, hz, ry };
      footprints.push(f);
      stampFootprint(f);
      return f;
    }),
    removeFootprint: (f) => { const i = footprints.indexOf(f); if (i >= 0) footprints.splice(i, 1); },
    /** Straight-line walkability between two world points (waypoint lookahead). */
    hasLOS: (ax, az, bx, bz) => hasLineOfSight({ x: ax, z: az }, { x: bx, z: bz }),
    setDebug,
    toggleDebug,
  };
}

// Binary min-heap keyed by priority; stores grid indices. Typed arrays, grown
// by doubling, reused across searches (clear() only resets the count). The
// comparisons and swap order are the old array heap's exactly, and priorities
// stay 64-bit, so it pops in the same order and every path is the same — it
// was the swap's destructuring (two throwaway arrays per swap) that made a
// search across the river cost 31 ms.
class MinHeap {
  constructor(cap = 1024) { this.items = new Int32Array(cap); this.prio = new Float64Array(cap); this.size = 0; }
  clear() { this.size = 0; }
  push(item, prio) {
    if (this.size === this.items.length) {
      const it = new Int32Array(this.size * 2); it.set(this.items); this.items = it;
      const pr = new Float64Array(this.size * 2); pr.set(this.prio); this.prio = pr;
    }
    const items = this.items, P = this.prio;
    let i = this.size++;
    items[i] = item; P[i] = prio;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (P[p] <= P[i]) break;
      const ti = items[i]; items[i] = items[p]; items[p] = ti;
      const tp = P[i]; P[i] = P[p]; P[p] = tp;
      i = p;
    }
  }
  pop() {
    const items = this.items, P = this.prio;
    const top = items[0];
    const last = --this.size;
    items[0] = items[last]; P[0] = P[last];
    let i = 0;
    const n = this.size;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let s = i;
      if (l < n && P[l] < P[s]) s = l;
      if (r < n && P[r] < P[s]) s = r;
      if (s === i) break;
      const ti = items[i]; items[i] = items[s]; items[s] = ti;
      const tp = P[i]; P[i] = P[s]; P[s] = tp;
      i = s;
    }
    return top;
  }
}
