// THE FRONT'S DEFENSIVE LINE — sited by the GROUND, not by a formula. GAME
// code, nam-rts only. Your ask (2026-09-23, taken up 2026-09-25): "replace the
// default enemy turrets" — five DShK nests used to stand in a staggered line
// across the top of the map, spaced by arithmetic, blind to the ground.
//
// A defender sites a gun where it COVERS THE WAY IN. So:
//
//   1. THE WAYS IN. Nav paths from our HQ to the enemy HQ and to every capture
//      point on the enemy's half — the roads a player's column will actually
//      take (the same A* the units use). Plus the helicopters' way in: the
//      straight line from our HQ to theirs (aircraft do not follow roads).
//   2. CANDIDATES. Every walkable, gentle spot on the enemy's half, on a grid,
//      not in water, not on a site, not ON the path (you do not dig a nest in
//      the road) and not too close to the HQ (its own ZPU covers that).
//   3. SCORE. How much of the ways in each spot can SEE and REACH: path points
//      within the gun's range with a clear line over the terrain, counted,
//      plus a bonus for standing above them (plunging fire, and it is what a
//      real gunner looks for).
//   4. PICK, greedily, with spacing, a MIX:
//        · DShK nests (turret) on the best spots
//        · bamboo watchtowers (tower: a 12.7 mm on a lashed tower, sees over
//          the jungle) on the best spots that are LOW or in cover, where a pit
//          would see nothing — the tower is what you build where you cannot
//          see
//        · a second ZPU-4 on the helicopters' line, in the open
//        · spider holes right beside the paths, between the nests
//
// Deterministic: a pure function of the map, the HQs and the points.
// MEASURED on nam-valley: the siting 16-25 ms (5 ways in, ~2000 candidates,
// an 8-tap LOS; 4.2 s on the first try, before the road points were
// de-duplicated). Placing is the slow half — each gun levels its pad, a GPU
// round trip — as it was for the formula line.
import { NAV_MAX_SLOPE_DEG } from "./navGrid.js";

export const LINE = {
  /** Candidate grid, metres. */
  grid: 10,
  /** The enemy's half: candidates from this fraction of the half-map north of 0. */
  zFrom: 0.12, zTo: 0.8,
  /** Keep-outs, metres: from the enemy HQ, from a capture point, from the path. */
  hqClear: 45, pointClear: 22, pathMin: 12,
  /** A gun covers path points up to this far (the DShK's range is 60). */
  reach: 58,
  /** Spacing between any two picks, metres. */
  spacing: 62,
  nests: 3, towers: 2, zpus: 1, spiderHoles: 3,
};

const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * @returns {{ nests: {x,z}[], towers: {x,z}[], zpus: {x,z}[], spiderHoles: {x,z}[], paths: number }}
 */
export function siteEnemyLine(app, { navGrid, playerHQ, enemyHQ, points = [], params = LINE }) {
  const half = (app.worldSize ?? 1024) / 2;
  const H = (x, z) => app.getWorldHeight(x, z);
  const cosMax = Math.cos((NAV_MAX_SLOPE_DEG * 0.7 * Math.PI) / 180);   // gentler than walkable: a gun needs a pad
  const wet = (x, z) => { const wl = app.getWaterLevelAt?.(x, z); return wl != null && wl > H(x, z) - 0.3; };

  // 1. The ways in — resampled every 6 m, only the enemy's half.
  const targets = [enemyHQ, ...points.filter((p) => p.z > 0)];
  const pathPts = [];
  let paths = 0;
  for (const t of targets) {
    const p = navGrid.findPath(playerHQ.x, playerHQ.z, t.x, t.z);
    if (!p?.length) continue;
    paths++;
    let prev = { x: playerHQ.x, z: playerHQ.z };
    for (const q of p) {
      const L = Math.hypot(q.x - prev.x, q.z - prev.z);
      const n = Math.max(1, Math.ceil(L / 6));
      for (let k = 1; k <= n; k++) {
        const x = prev.x + ((q.x - prev.x) * k) / n, z = prev.z + ((q.z - prev.z) * k) / n;
        if (z > 0) pathPts.push({ x, z, y: H(x, z) + 1.5 });
      }
      prev = q;
    }
  }
  // Air line: our HQ to theirs, straight.
  const airLine = { ax: playerHQ.x, az: playerHQ.z, bx: enemyHQ.x, bz: enemyHQ.z };
  const distToAir = (x, z) => {
    const dx = airLine.bx - airLine.ax, dz = airLine.bz - airLine.az;
    const t = Math.max(0, Math.min(1, ((x - airLine.ax) * dx + (z - airLine.az) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - (airLine.ax + dx * t), z - (airLine.az + dz * t));
  };
  if (!pathPts.length) return { nests: [], towers: [], zpus: [], spiderHoles: [], paths };

  // The routes share roads: one point per 8 m cell, so a busy road is not
  // counted five times (and five times the work).
  {
    const seen = new Set();
    for (let i = pathPts.length - 1; i >= 0; i--) {
      const k = Math.round(pathPts[i].x / 8) + "," + Math.round(pathPts[i].z / 8);
      if (seen.has(k)) pathPts.splice(i, 1); else seen.add(k);
    }
  }

  /** Terrain line of sight from a gun at (x, y0, z) to a point: 8 taps. */
  const los = (x, y0, z, p) => {
    for (let k = 1; k < 8; k++) {
      const f = k / 8;
      const sx = x + (p.x - x) * f, sz = z + (p.z - z) * f;
      if (H(sx, sz) > y0 + (p.y - y0) * f + 0.3) return false;
    }
    return true;
  };

  // 2. Candidates, and what each can see (indices into pathPts, with weights).
  const cands = [];
  const g = params.grid;
  const reach2 = params.reach * params.reach;
  for (let z = half * params.zFrom; z < half * params.zTo; z += g) {
    for (let x = -half + 40; x < half - 40; x += g) {
      if (navGrid.isBlockedAtWorld(x, z) || wet(x, z)) continue;
      if (app.getWorldNormal(x, z).y < cosMax) continue;
      if (Math.hypot(x - enemyHQ.x, z - enemyHQ.z) < params.hqClear) continue;
      if (points.some((p) => Math.hypot(x - p.x, z - p.z) < params.pointClear)) continue;
      let dPath = Infinity;
      const inReach = [];
      for (let i = 0; i < pathPts.length; i++) {
        const dx = pathPts[i].x - x, dz = pathPts[i].z - z, d2 = dx * dx + dz * dz;
        if (d2 < dPath) dPath = d2;
        if (d2 <= reach2) inReach.push(i);
      }
      dPath = Math.sqrt(dPath);
      if (dPath < params.pathMin || !inReach.length) continue;
      const y = H(x, z);
      const pit = [], tower = [];
      let above = 0;
      for (const i of inReach) {
        const p = pathPts[i];
        const w = 1 - 0.5 * (Math.hypot(p.x - x, p.z - z) / params.reach);   // nearer counts more
        if (los(x, y + 1.4, z, p)) { pit.push([i, w]); above += Math.max(0, Math.min(6, y - (p.y - 1.5))) * w; }
        else if (los(x, y + 9, z, p)) tower.push([i, w]);   // only a tower sees it
      }
      const cover = app.sampleFoliageDensity?.(x, z) ?? 0;
      cands.push({ x, z, y, dPath, pit, tower, above, cover,
        air: smooth(80, 20, distToAir(x, z)) * (1 - cover) });
    }
  }

  // 3 + 4. Pick greedily, with spacing, and with DIMINISHING returns on road
  // already covered: a stretch one gun watches counts for a third to the
  // next, so the guns spread over the ways in instead of stacking on one.
  const covered = new Float32Array(pathPts.length);
  const value = (list) => { let v = 0; for (const [i, w] of list) v += w * Math.pow(0.33, covered[i]); return v; };
  const scoreOf = {
    pit: (c) => value(c.pit) + c.above * 0.1,
    // A tower earns its place where a pit would be blind.
    tower: (c) => value(c.tower) + value(c.pit) * 0.4,
    air: (c) => c.air,
    cover: (c) => (c.dPath < 26 && c.cover > 0.15 ? c.cover + value(c.pit) * 0.05 : 0),
  };
  const picked = [];
  const free = (c, gap) => picked.every((p) => Math.hypot(p.x - c.x, p.z - c.z) >= gap);
  const take = (key, n, filter = () => true, gap = params.spacing) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      let best = null, bestS = 0;
      for (const c of cands) {
        if (!filter(c) || !free(c, gap)) continue;
        const sc = scoreOf[key](c);
        if (sc > bestS) { bestS = sc; best = c; }
      }
      if (!best) break;
      out.push({ x: best.x, z: best.z }); picked.push(best);
      for (const [i] of best.pit) covered[i] += 1;
      if (key === "tower") for (const [i] of best.tower) covered[i] += 1;
    }
    return out;
  };
  const nests = take("pit", params.nests);
  const towers = take("tower", params.towers);
  const zpus = take("air", params.zpus, (c) => c.z > half * 0.3);
  // Spider holes: right beside the ways in, in cover, between the guns.
  const spiderHoles = take("cover", params.spiderHoles, () => true, params.spacing * 0.6);
  return { nests, towers, zpus, spiderHoles, paths };
}
