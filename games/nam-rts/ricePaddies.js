// RICE TERRACES — a hillside by the hamlet cut into steps. GAME code.
// Your ask (2026-09-25): "we need rice fields… place it where you think it
// would be the best". The first version (flat colour on a 0.5 m grid over
// barely-stepped gentle ground) read as Minecraft up close; this one is built
// the way the photos are.
//
// WHAT THE PHOTOS SHOW (Mu Cang Chai, Sa Pa, Maruyama Senmaida):
//   • a HILLSIDE, not a plain: the steps are real — a grassed BANK a metre or
//     more tall between two terraces, the flat above it held by a rounded DIKE
//     along its lip;
//   • every edge a smooth CURVE along the contour of the hill;
//   • the flats in different states: a sheet of water mirroring the sky,
//     young rice in rows with the water between them, dense green, ripe gold,
//     bare mud;
//   • the banks a darker green than the fields, a light crest along each lip.
//
// HOW.
//   • Site: the best open, dry, walkable HILLSIDE (slope 5-17°) within a
//     couple of hundred metres of the hamlet.
//   • Shape: one continuous function of the smoothed natural height gives the
//     terrace a point is on, its bank, its dike and its paddy — the same
//     function on the CPU (the mesh's heights, the heightmap, `contains`) and
//     in the shader (colour, normal), so the look is worked out PER PIXEL and
//     every edge is a smooth curve at any zoom, not a stair of grid cells.
//   • Ground: the terrain is OPENED over the block (app.setGameHoles) and one
//     mesh is the ground there — a clipmap far ring is metres coarse and cannot
//     hold a 1.5 m bank. The HEIGHTMAP gets the same terraces with banks twice
//     as wide, so the men and the pathfinder see walkable steps (< 34°); the
//     two differ by a few tens of cm only on a bank.
//   • Cost: one draw, no texture, no screen copy (water is a faked sky mirror
//     plus the environment, opaque). The terrain loses its early depth test
//     while a hole exists — measured, see TODO.md.
import * as THREE from "three";
import { createRiceCrop, CROP_KEEP_MIN, CROP_RADIUS, cropKeep } from "./riceCrop.js";
import { createPaddyReflections } from "./paddyReflections.js";
import {
  Fn, attribute, cameraPosition, clamp, cos, dot, float, floor, fract, fwidth, length, max, min, mix, normalize,
  positionWorld, pow, reflect, sin, smoothstep, step, texture, time, transformNormalToView, vec2, vec3,
} from "three/tsl";

export const PADDY_PARAMS = {
  step: 1.1,           // m of height between two terraces
  bank: 1.1,           // m of ground the VISIBLE bank takes (a steep grassed wall)
  navBank: 3.4,        // m the heightmap's bank takes (walkable)
  lip: 0.18,           // m the dike crest stands over the water
  lipWidth: 0.6,       // m of ground the dike takes on the flat
  radiusAlong: 64,     // the block: an irregular ellipse, long along the contours
  radiusAcross: 46,
  grid: 0.5,           // mesh spacing, m
};

/** sRGB hex → linear rgb (the shader works in linear; hex picked by eye is sRGB). */
const lin = (hex) => { const c = new THREE.Color(hex); return vec3(c.r, c.g, c.b); };
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const sst = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
/** Integer-seed hash, the SAME in JS and in the shader (no sin: f32 sin of a big argument drifts). */
const hashJs = (p) => { let q = p * 0.1031; q -= Math.floor(q); q *= q + 33.33; q *= q + q; return q - Math.floor(q); };
const hashTsl = (p) => { const q0 = fract(p.mul(0.1031)); const q1 = q0.mul(q0.add(33.33)); return fract(q1.mul(q1.add(q1))); };

/**
 * The best hillside for the terraces: { x, z, share, up, good } or null.
 *
 * FACING THE CAMERA (your note of 2026-09-25): the RTS camera never turns,
 * and terraces seen from their uphill side are a staircase of flats falling
 * away — the banks, the part that says "terraces", face away. So the hill
 * must RISE along the camera's view (`facing`, on the ground): then every
 * bank faces the player and the steps climb up the screen. Anywhere on the
 * map, a little in favour of ground near `near` (the player's base: the
 * first thing seen). `keepOff(x, z)` = ground a game keeps clear (a track).
 */
export function sitePaddies(app, {
  near, facing = { x: 0, z: 1 }, keepOff = null, structures = null, pieces = [], field = null, params = PADDY_PARAMS,
} = {}) {
  if (!near) return null;
  const P = params;
  const ground = (x, z) => app.getWorldHeight(x, z);
  const built = (structures?.list ?? []).filter((s) => s.alive).map((s) => s.position);
  // Everything placedObjects stood on a pad (the hamlet's houses, granaries,
  // fences): 6 m clear of each footprint.
  const pads = pieces.map((q) => ({ x: q.fp.px, z: q.fp.pz, r: Math.hypot(q.fp.hx, q.fp.hz) + 6 }));
  const fl = Math.hypot(facing.x, facing.z) || 1, fx = facing.x / fl, fz = facing.z / fl;
  const gradAt = (x, z) => [(ground(x + 5, z) - ground(x - 5, z)) / 10, (ground(x, z + 5) - ground(x, z - 5)) / 10];
  const good = (x, z) => {
    const y = ground(x, z);
    const [gx, gz] = gradAt(x, z);
    if (Math.hypot(gx, gz) > 0.34) return false;
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > y - 0.5) return false;
    if (field && field.open(x, z) * field.forest(x, z) > 0.3) return false;
    if (app.navGrid?.isBlockedAtWorld?.(x, z)) return false;
    if (keepOff && (keepOff(x, z) || keepOff(x + 5, z) || keepOff(x - 5, z) || keepOff(x, z + 5) || keepOff(x, z - 5))) return false;
    if (built.some((p) => Math.abs(p.x - x) < 30 && Math.abs(p.z - z) < 30 && Math.hypot(p.x - x, p.z - z) < 30)) return false;
    if (pads.some((p) => Math.abs(p.x - x) < p.r && Math.abs(p.z - z) < p.r && Math.hypot(p.x - x, p.z - z) < p.r)) return false;
    return true;
  };
  let best = null;
  const W = app.worldSize ?? 1024;
  const R = Math.max(P.radiusAlong, P.radiusAcross);
  for (let cz = -W / 2 + R + 16; cz <= W / 2 - R - 16; cz += 24) {
    for (let cx = -W / 2 + R + 16; cx <= W / 2 - R - 16; cx += 24) {
      // A terrace needs a SLOPE — gentle ground gives flats too wide to read
      // as steps, steep ground nothing but banks — rising along `facing`.
      let ok = 0, up = 0, n = 0;
      for (let x = -R; x <= R; x += 10) for (let z = -R; z <= R; z += 10) {
        if (x * x + z * z > R * R) continue;
        n++;
        if (!good(cx + x, cz + z)) continue;
        ok++;
        const [gx, gz] = gradAt(cx + x, cz + z), sl = Math.hypot(gx, gz);
        if (sl > 0.08 && sl < 0.3 && (gx * fx + gz * fz) / sl > 0.5) up++;
      }
      const score = ok / n + 1.2 * (up / n) - Math.hypot(cx - near.x, cz - near.z) * 0.0005;
      if (!best || score > best.score) best = { x: cx, z: cz, score, share: ok / n, up: up / n };
    }
  }
  return best && best.share > 0.5 && best.up > 0.35 ? { ...best, good } : null;
}

/**
 * Cut the terraces and lay the fields. Returns the handle
 * ({ surface, contains(x, z), inBlock(x, z) }) or null.
 */
export async function buildRicePaddies(app, site, params = PADDY_PARAMS) {
  if (!site || !app.remapHeights || !app.setGameHoles) return null;
  const P = params;
  const H = P.step, L = P.lip;
  const R = Math.max(P.radiusAlong, P.radiusAcross) * 1.3 + 8;
  const x0 = site.x - R, x1 = site.x + R, z0 = site.z - R, z1 = site.z + R;

  // ── Natural ground (before any cut), smoothed, its gradient, and the mask ──
  const G = 1;
  const nx = Math.round((x1 - x0) / G) + 1, nz = Math.round((z1 - z0) / G) + 1;
  const nat = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) nat[j * nx + i] = app.getWorldHeight(x0 + i * G, z0 + j * G);
  const boxBlur = (src, r, passes) => {
    let a = src;
    for (let p = 0; p < passes; p++) {
      const b = new Float32Array(a.length), c = new Float32Array(a.length);
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        let s = 0, k = 0;
        for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < nx) { s += a[j * nx + ii]; k++; } }
        b[j * nx + i] = s / k;
      }
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        let s = 0, k = 0;
        for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < nz) { s += b[jj * nx + i]; k++; } }
        c[j * nx + i] = s / k;
      }
      a = c;
    }
    return a;
  };
  // Broad curves along the hill, not every bump of it.
  const hs = boxBlur(nat, 7, 3);
  const gxg = new Float32Array(nx * nz), gzg = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const il = Math.max(0, i - 1), ir = Math.min(nx - 1, i + 1), jl = Math.max(0, j - 1), jr = Math.min(nz - 1, j + 1);
    gxg[j * nx + i] = (hs[j * nx + ir] - hs[j * nx + il]) / ((ir - il) * G);
    gzg[j * nx + i] = (hs[jr * nx + i] - hs[jl * nx + i]) / ((jr - jl) * G);
  }
  const sample = (a, x, z) => {
    const fx = Math.max(0, Math.min(nx - 1.001, (x - x0) / G)), fz = Math.max(0, Math.min(nz - 1.001, (z - z0) / G));
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * nx + i;
    return (a[k] * (1 - u) + a[k + 1] * u) * (1 - v) + (a[k + nx] * (1 - u) + a[k + nx + 1] * u) * v;
  };

  // The contours' mean direction over the block: the ellipse lies along it and
  // the cross-dikes are measured along it.
  let mgx = 0, mgz = 0;
  for (let k = 0; k < gxg.length; k++) { mgx += gxg[k]; mgz += gzg[k]; }
  const ml = Math.hypot(mgx, mgz) || 1;
  const along = { x: -mgz / ml, z: mgx / ml };
  const ph1 = hashJs(site.x * 3.1 + 7) * 6.28, ph2 = hashJs(site.z * 2.3 + 3) * 6.28;
  const mk0 = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * G, z = z0 + j * G, dx = x - site.x, dz = z - site.z;
    const a = (dx * along.x + dz * along.z) / P.radiusAlong, c = (dx * -along.z + dz * along.x) / P.radiusAcross;
    const th = Math.atan2(c, a);
    const rim = 1 + 0.16 * Math.sin(3 * th + ph1) + 0.08 * Math.sin(5 * th + ph2);
    mk0[j * nx + i] = Math.hypot(a, c) < rim && site.good(x, z) ? 1 : 0;
  }
  // Closed, then softened: a few bad metres inside the block (a steep spot, a
  // bush) must not punch a dip in the terraces where the old ground shows.
  const mkc = boxBlur(mk0, 4, 2);
  for (let k = 0; k < mkc.length; k++) mkc[k] = mkc[k] > 0.42 ? 1 : 0;
  const mkb = boxBlur(mkc, 3, 2);
  const mask = (x, z) => smooth(0.3, 0.8, sample(mkb, x, z));

  /**
   * THE TERRACE AT (x, z). s = h / step: its integer part counts terraces up
   * the hill. The bank between two terraces is centred where the VISIBLE bank
   * is, `bank` metres wide (so the nav version, wider, straddles the same
   * line); the dike crest is at the top of the bank, falling to the flat over
   * `lipWidth`. All widths are in metres of ground, turned into s-units by the
   * terrace's own width T (the distance between two contours).
   */
  const terrace = (x, z, bankM) => {
    const h = sample(hs, x, z), gx = sample(gxg, x, z), gz = sample(gzg, x, z);
    const gm = Math.max(Math.hypot(gx, gz), 0.02);
    const T = H / gm;
    const cap = Math.min(1, 0.4 / (P.bank / T / 2 + P.lipWidth / T));
    const wbV = (P.bank / T) * cap, wl = (P.lipWidth / T) * cap;
    const wb = Math.min((bankM / T) * cap, 0.9 - 2 * wl);
    const s = h / H, c = s + wbV / 2, n = Math.floor(c + 0.5), d = c - n;
    const r = sst(d / wb + 0.5);
    // The crest of THIS profile's bank (the nav bank is wider than the drawn one).
    const lipS = d >= wb / 2 ? 1 - sst((d - wb / 2) / wl) : r;
    const lvl = d >= 0 ? n : n - 1;
    // Metres onto the flat from its nearest edge (negative on a bank or dike).
    const eT = (d < 0 ? -wbV / 2 - d : d - wbV / 2 - wl) * T;
    // The cross-dikes: every 22-35 m along the terrace, each terrace its own.
    // They WANDER (the photos): the along-coordinate bent by the across one,
    // differently on every terrace.
    const u = x * along.x + z * along.z, v = x * -along.z + z * along.x;
    const uw = u + 6 * Math.sin(v * 0.06 + lvl * 1.7) + 2.5 * Math.sin(v * 0.17 + lvl * 0.6);
    const seg = 22 + 13 * hashJs(lvl * 7 + 1);
    const su = (uw + 40 * hashJs(lvl * 7 + 2)) / seg;
    const du = Math.min(su - Math.floor(su), Math.ceil(su) - su) * seg;
    const cross = L * (1 - sst(du / (P.lipWidth * 0.5))) * sst(eT / 0.4);
    const y = H * (n - 1 + r) + L * lipS + cross;
    // For planting: the paddy's state (the shader's hash, same seed), and
    // metres across the flat from its downhill dike — the rows run along it.
    const st = hashJs(lvl * 131 + Math.floor(su) * 17 + 5);
    const across = ((d < 0 ? d + 1 : d) - wbV / 2) * T;
    return { y, lvl, eT: Math.min(eT, du - P.lipWidth * 0.5), h, gx, gz, gm, u, v, uw, st, across };
  };

  // ── 1. The heightmap: walkable terraces (units, pathfinding, placement) ────
  await app.remapHeights(x0, z0, x1, z1, (x, z, y) => {
    const m = mask(x, z);
    if (m <= 0) return null;
    const t = terrace(x, z, P.navBank);
    return y + (t.y - y) * m;
  });

  // ── 2. The ground mesh, where the block is ────────────────────────────────
  const S = P.grid;
  const nxv = Math.round((x1 - x0) / S) + 1, nzv = Math.round((z1 - z0) / S) + 1;
  const vid = new Int32Array(nxv * nzv).fill(-1);
  const pos = [], ter = [], grd = [], idx = [];
  for (let j = 0; j < nzv; j++) for (let i = 0; i < nxv; i++) {
    const x = x0 + i * S, z = z0 + j * S;
    const m = mask(x, z);
    if (m < 0.15) continue;
    const t = terrace(x, z, P.bank);
    const y0 = sample(nat, x, z);
    vid[j * nxv + i] = pos.length / 3;
    pos.push(x, y0 + (t.y - y0) * m + 0.03, z);
    ter.push(t.h / H, t.u, m, t.v);
    grd.push(t.gx, t.gz);
  }
  for (let j = 0; j < nzv - 1; j++) for (let i = 0; i < nxv - 1; i++) {
    const a0 = vid[j * nxv + i], a1 = vid[j * nxv + i + 1], b0 = vid[(j + 1) * nxv + i], b1 = vid[(j + 1) * nxv + i + 1];
    if (a0 < 0 || a1 < 0 || b0 < 0 || b1 < 0) continue;
    idx.push(a0, b0, a1, a1, b0, b1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("aTer", new THREE.Float32BufferAttribute(ter, 4));
  geo.setAttribute("aG", new THREE.Float32BufferAttribute(grd, 2));
  // Lighting uses the shader's own normal; this one is only a fallback.
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  mat.name = "RiceTerraces";
  buildShading(mat, P);
  const surface = new THREE.Mesh(geo, mat);
  surface.name = "RiceTerraces";
  surface.receiveShadow = true;
  surface.castShadow = false;
  app.scene.add(surface);

  // ── 3. The rice plants: hills in rows along each terrace ─────────────────
  // A jittered 0.27 m grid, each point snapped across onto its row (0.3 m
  // apart, the shader's rows) and kept once per 0.24 m along it.
  const plants = [], seen = new Set();
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const PS = 0.27;
  for (let z = z0; z <= z1; z += PS) for (let x = x0; x <= x1; x += PS) {
    const px = x + (rnd() - 0.5) * PS * 0.7, pz = z + (rnd() - 0.5) * PS * 0.7;
    if (mask(px, pz) < 0.9) continue;
    const t = terrace(px, pz, P.bank);
    if (t.eT < 0.2) continue;
    const kind = t.st <= 0.3 ? -1 : t.st <= 0.68 ? 0 : t.st <= 0.94 ? 1 : 2;
    if (kind < 0) continue;
    const row = Math.round(t.across / 0.3);
    const k = row * 0.3 - t.across;
    const qx = px + (t.gx / t.gm) * k, qz = pz + (t.gz / t.gm) * k;
    const id = `${t.lvl},${row},${Math.round(t.uw / 0.24)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const t2 = terrace(qx, qz, P.bank);
    if (t2.eT < 0.15) continue;
    const m2 = mask(qx, qz), y0 = sample(nat, qx, qz);
    plants.push({ x: qx, y: y0 + (t2.y - y0) * m2 + 0.03, z: qz, kind, rnd: rnd() });
  }
  // Grass on the banks, the dikes and the block's grassed rim: the same clumps,
  // short and shaggy (riceCrop kind 3), a little sparser than the rice.
  const GS = 0.36;
  for (let z = z0; z <= z1; z += GS) for (let x = x0; x <= x1; x += GS) {
    const px = x + (rnd() - 0.5) * GS * 0.9, pz = z + (rnd() - 0.5) * GS * 0.9;
    const m = mask(px, pz);
    if (m < 0.34) continue;
    const t = terrace(px, pz, P.bank);
    if (m > 0.85 && t.eT > -0.12) continue;          // a field, or its wet margin
    const y0 = sample(nat, px, pz);
    // Its random in the UPPER range: the distance thinning (keep rnd < keep)
    // takes the grass first — from the RTS camera's height the bank's own
    // texture carries it, and the rice keeps the budget.
    plants.push({ x: px, y: y0 + (t.y - y0) * m + 0.02, z: pz, kind: 3, rnd: 0.4 + 0.6 * rnd() });
  }
  const crop = createRiceCrop(app, plants);

  // The water's height, where there is water (flooded, and between young
  // rice), for the screen-space reflections: 0.5 m texels.
  const LC = 0.5;
  const lnx = Math.ceil((x1 - x0) / LC), lnz = Math.ceil((z1 - z0) / LC);
  const levels = new Float32Array(lnx * lnz).fill(-1e4);
  const groundY = new Float32Array(lnx * lnz).fill(-1e4);
  for (let j = 0; j < lnz; j++) for (let i = 0; i < lnx; i++) {
    const x = x0 + (i + 0.5) * LC, z = z0 + (j + 0.5) * LC;
    const m = mask(x, z);
    if (m < 0.5) continue;
    const t = terrace(x, z, P.bank);
    { const y0 = sample(nat, x, z); groundY[j * lnx + i] = y0 + (t.y - y0) * m + 0.03; }
    if (m < 0.85) continue;
    if (t.eT < 0.02 || t.st > 0.68) continue;
    const y0 = sample(nat, x, z);
    levels[j * lnx + i] = y0 + (t.y - y0) * m + 0.03;
  }
  // Spread each level 2 texels (1 m) past its water: the reflection's gate is
  // then the per-pixel HEIGHT test (the bank rises out of the water), not
  // this grid — whose cells made a sawtooth along every curved edge.
  for (let pass = 0; pass < 2; pass++) {
    const src = levels.slice();
    for (let j = 0; j < lnz; j++) for (let i = 0; i < lnx; i++) {
      if (src[j * lnx + i] > -1e3) continue;
      // The neighbour's level nearest this cell's own ground: at a bank's
      // foot that is the water below it, not the terrace above (taking the
      // higher one notched the reflection all along every bank).
      let best = -1e4, bestD = Infinity;
      const gy = groundY[j * lnx + i];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= lnx || jj >= lnz) continue;
        const v = src[jj * lnx + ii];
        if (v < -1e3) continue;
        const dd = Math.abs(v - gy);
        if (dd < bestD) { bestD = dd; best = v; }
      }
      levels[j * lnx + i] = best;
    }
  }
  const reflections = createPaddyReflections(app, { data: levels, nx: lnx, nz: lnz, x0, z0, cell: LC });

  // ── 4. Open the terrain under the mesh; keep the wild plants off it ────────
  // The opening sits INSIDE the mesh's own edge (the mesh cuts itself at
  // mask 0.3, per pixel — see buildShading): the two overlap in a band, so
  // no crack can open between them.
  app.setGameHoles(x0, z0, x1, z1, (x, z) => smooth(0.36, 0.5, mask(x, z)));
  for (let z = z0; z <= z1; z += 4) for (let x = x0; x <= x1; x += 4) {
    if (mask(x, z) > 0.55) app.clearVegetation?.(x, z, 3.2, { grass: 3.2, edge: 0.5 });
  }
  // The map's ground decals (mud, craters, debris) are flat photos of dry
  // ground: on a sheet of water they read as holes in it.
  for (const dcl of [...(app.decals?.decals ?? [])]) {
    if (mask(dcl.px, dcl.pz) > 0.1) app.decals.remove(dcl.id);
  }
  // THE RIM, HIDDEN (your ask): the terraces were a clean oval cut into the
  // meadow. A ring of banana, bush and fern — and a few coconut palms — just
  // outside the edge, in drifts, so the terraces look carved out of the
  // jungle. On the ground paint (foliage channels 3 banana, 1 bush, 7 giant
  // fern, 0 card fern; tall channel 2 coconut), "max" over the map's own.
  const drift = (x, z, s) => 0.5 + 0.25 * Math.sin(x * 0.11 + s) * Math.sin(z * 0.13 - s * 1.7)
    + 0.25 * Math.sin(x * 0.047 - z * 0.061 + s * 2.3);
  const ring = (x, z) => {
    if (x < x0 || x > x1 || z < z0 || z > z1) return 0;
    const m = mask(x, z);
    return m <= 0.005 || m > 0.42 ? 0 : smooth(0.005, 0.08, m) * (1 - smooth(0.3, 0.42, m));
  };
  if (app.paintFoliageChannel) {
    for (const [ch, v, s] of [[3, 0.75, 1.3], [1, 0.8, 4.1], [7, 0.6, 7.7], [0, 0.5, 2.9]]) {
      app.paintFoliageChannel(ch, (x, z) => {
        const r = ring(x, z);
        return r && r * v * smooth(0.35, 0.65, drift(x, z, s));
      }, { blend: "max" });
    }
  }
  app.paintTallPlantChannel?.(2, (x, z) => {
    const r = ring(x, z);
    return r && r * 0.35 * smooth(0.55, 0.8, drift(x, z, 5.5));
  }, { blend: "max" });

  // Plants put down by hand before the cut (traveller's palms out in the wild).
  app.placedFoliage?.removeWhere?.((p) => mask(p.x, p.z) > 0.15);

  return {
    site,
    surface, crop, reflections,
    triangles: idx.length / 3,
    /** On a field (not a bank or dike) of the terraces? */
    contains(x, z) { return mask(x, z) > 0.8 && terrace(x, z, P.bank).eT > 0; },
    /** The water's height where (x, z) is well inside a FLOODED paddy (`margin` m from its edges), else null. */
    waterAt(x, z, margin = 1.5) {
      if (mask(x, z) < 0.9) return null;
      const t = terrace(x, z, P.bank);
      if (t.st > 0.3 || t.eT < margin) return null;
      const y0 = sample(nat, x, z);
      return y0 + (t.y - y0) * mask(x, z) + 0.03;
    },
    /** On the grassed bank or rim (for an animal grazing), else null: the ground height. */
    grassAt(x, z) {
      const m = mask(x, z);
      if (m < 0.3 || m > 0.8) return null;
      const t = terrace(x, z, P.bank);
      const y0 = sample(nat, x, z);
      return y0 + (t.y - y0) * m + 0.03;
    },
    /** Inside the terraced block at all. */
    inBlock(x, z) { return x >= x0 && x <= x1 && z >= z0 && z <= z1 && mask(x, z) > 0.15; },
  };
}

/**
 * THE LOOK, per pixel, from the interpolated terrace coordinate: which
 * terrace, bank or dike, which paddy and its state, the rows of young rice,
 * the water's sky mirror — and the normal of the steps, so the banks light
 * as the curved slopes they are.
 */
function buildShading(mat, P) {
  const H = P.step, L = P.lip;
  const ter = attribute("aTer", "vec4"), g = attribute("aG", "vec2");
  const s = ter.x, u = ter.y, m = ter.z, v = ter.w;
  const wp = positionWorld;

  // The terrace coordinate — the JS terrace() above, line for line.
  const gm = max(length(g), 0.02);
  const T = float(H).div(gm);
  const cap = min(1, float(0.4).div(float(P.bank).div(T).mul(0.5).add(float(P.lipWidth).div(T))));
  const wb = float(P.bank).div(T).mul(cap), wl = float(P.lipWidth).div(T).mul(cap);
  const c = s.add(wb.mul(0.5));
  const n = floor(c.add(0.5));
  const d = c.sub(n);
  const xb = clamp(d.div(wb).add(0.5), 0, 1);
  const past = step(wb.mul(0.5), d);
  const q = clamp(d.sub(wb.mul(0.5)).div(wl), 0, 1);
  const lvl = n.sub(float(1).sub(step(0, d)));
  const eEdge = mix(wb.mul(-0.5).sub(d), d.sub(wb.mul(0.5)).sub(wl), step(0, d)).mul(T);
  const seg = hashTsl(lvl.mul(7).add(1)).mul(13).add(22);
  const uw = u.add(sin(v.mul(0.06).add(lvl.mul(1.7))).mul(6)).add(sin(v.mul(0.17).add(lvl.mul(0.6))).mul(2.5));
  const su = uw.add(hashTsl(lvl.mul(7).add(2)).mul(40)).div(seg);
  const fu = fract(su);
  const du = min(fu, float(1).sub(fu)).mul(seg);
  const eT = min(eEdge, du.sub(P.lipWidth * 0.5));           // metres onto the flat
  const aa = max(fwidth(eT), 0.03);
  const flat = smoothstep(aa.negate(), aa, eT).mul(smoothstep(0.75, 0.9, m));
  // Across the flat, metres from its outer (downhill) dike: the rows run along it.
  const across = mix(d.add(1), d, step(0, d)).sub(wb.mul(0.5)).mul(T);

  // The paddy and its state.
  const pid = floor(su);
  const st = hashTsl(lvl.mul(131).add(pid.mul(17)).add(5));
  // FEW states (your note: not the whole patchwork): water and green rice,
  // a little gold.
  const isWater = step(st, 0.3);                              // 30% flooded
  const isYoung = step(0.3, st).mul(step(st, 0.68));          // 38% young rice in water
  const isDense = step(0.68, st).mul(step(st, 0.94));         // 26% growing, green
  const isRipe = step(0.94, st);                              //  6% ripe gold
  const isMud = float(0);
  const tone = hashTsl(lvl.mul(53).add(pid.mul(29)).add(9)).mul(0.08).add(0.96);

  // PHOTO MATERIAL (Poly Haven / ambientCG scans already in the project), in
  // world space: grass and moss on the banks, wet mud under the water, the
  // grass's leaf texture laid ALONG the rice rows for the crop. Two scales
  // and a slow blend, so no tile repeats in a grid.
  const TX = paddyTextures();
  const wxz = vec2(wp.x, wp.z);
  const n1 = sin(wp.x.mul(0.37).add(wp.z.mul(0.21))).mul(sin(wp.z.mul(0.31).sub(wp.x.mul(0.13))));
  const n2 = sin(wp.x.mul(0.11).sub(wp.z.mul(0.17))).mul(sin(wp.z.mul(0.09).add(wp.x.mul(0.05))));
  const grassA = texture(TX.grass, wxz.div(2.6)).rgb;
  const grassB = texture(TX.grass, vec2(wp.z, wp.x.negate()).div(5.1).add(vec2(0.37, 0.11))).rgb;
  const bankAlb = mix(grassA, grassB, smoothstep(-0.5, 0.5, n1.add(n2))).mul(vec3(0.78, 0.8, 0.62));
  const mudAlb = texture(TX.mud, wxz.div(2.3)).rgb;

  // Rows: the crop's own coordinates — along the terrace and across it.
  const ruv = vec2(uw.div(1.1), across.div(0.42));
  const leafTex = texture(TX.grass, ruv).rgb;
  const leafLum = dot(leafTex, vec3(0.299, 0.587, 0.114)).div(0.16);   // ~1 on average
  const far = smoothstep(0.12, 0.35, fwidth(across).div(0.3));
  const rowW = cos(across.div(0.3).mul(6.2832)).mul(0.5).add(0.5);
  const hillW = cos(uw.div(0.24).mul(6.2832)).mul(0.5).add(0.5);
  const leaf = mix(rowW.mul(hillW.mul(0.4).add(0.6)).mul(leafLum.mul(0.5).add(0.5)), float(0.55), far);

  // WATER. A MIRROR of the real sky: metalness by a (pushed) Fresnel, so the
  // environment — the sky and its clouds — is what the water shows, stronger
  // the flatter you look; murky water over mud where it lets you see in; the
  // bank above mirrored along the inner edge; a dark wet line at the earth.
  // (Metal, not emissive: the game's bloom takes everything emissive.)
  const t = time;
  const wn = texture(TX.waterN, wxz.div(3.3).add(vec2(t.mul(0.021), t.mul(0.013)))).xy
    .add(texture(TX.waterN, wxz.div(1.9).mul(vec2(-1, 1)).add(vec2(t.mul(-0.016), t.mul(0.024)))).xy).sub(1);
  const Nw = normalize(vec3(wn.x.mul(0.2), 1, wn.y.mul(0.2)));
  const V = normalize(cameraPosition.sub(wp));
  const fres = pow(float(1).sub(clamp(dot(Nw, V), 0, 1)), 2).mul(0.4).add(0.55);
  const murk = mudAlb.mul(vec3(0.3, 0.33, 0.3));
  const inner = step(d, 0);
  const bankNear = inner.mul(float(1).sub(smoothstep(0.05, 0.6, eT))).mul(0.25);
  // A wet margin where the water meets a bank: the mesh's 0.5 m triangles
  // start the bank's rise in a zigzag the per-pixel edge cannot follow, and
  // painted as water those raised facets showed up as light dashes in the
  // reflection. Wet grass is what the margin is anyway.
  const shoreLine = float(1).sub(smoothstep(0.05, 0.35, eT)).mul(0.8).mul(step(d, 0));
  const mirror = fres.mul(float(1).sub(bankNear)).mul(float(1).sub(shoreLine));
  // Cloud patches in the mirrored sky: a slow swing of its tint.
  const skyTint = mix(vec3(0.46, 0.6, 0.73), vec3(0.72, 0.78, 0.82), smoothstep(-0.6, 0.8, n1.add(n2)));
  const waterOpen = mix(murk, skyTint, mirror);
  const waterBank = mix(waterOpen, lin("#2f4424"), bankNear);
  const waterCol = mix(waterBank, bankAlb.mul(0.68), shoreLine);

  // RICE. Young: bright rows, the water showing between them. Dense: a
  // closed green canopy. Ripe: gold heads over the leaves. Mud: wet, with
  // standing puddles in the ruts.
  const young = lin("#6f9e2e"), dense = lin("#4d7a22"), ripe = lin("#b8973f"), ripeDark = lin("#7d6128");
  const youngCover = smoothstep(0.25, 0.5, leaf);
  const youngCol = mix(mix(waterCol, young.mul(0.35), 0.35), young.mul(leafLum.mul(0.35).add(0.7)), youngCover);
  const denseCol = mix(dense.mul(0.55), dense.mul(leafLum.mul(0.4).add(0.75)), smoothstep(0.05, 0.35, leaf));
  const ripeCol = mix(ripeDark, ripe, clamp(leafLum.mul(0.55).add(rowW.mul(0.3)), 0, 1));
  const mudCol = mudAlb.mul(0.6);
  // Where the plants stand (round the camera) the field is only their BED —
  // water between young hills, shade under the grown crop; past their reach
  // the shader IS the crop. The same radius the plants shrink over.
  // Far off the plants thin out (riceCrop's cropKeep) and the shader paints
  // the canopy between them by the same share.
  const camD = cameraPosition.sub(wp).length();
  const nearK = smoothstep(CROP_RADIUS, CROP_RADIUS.sub(10), camD)
    .mul(cropKeep(camD).sub(CROP_KEEP_MIN).div(1 - CROP_KEEP_MIN));
  const youngF = mix(youngCol, mix(waterCol.mul(0.55), young.mul(0.25), 0.35), nearK);
  const denseF = mix(denseCol, dense.mul(0.35), nearK);
  const ripeF = mix(ripeCol, ripeDark.mul(0.5), nearK);
  const fieldCol = waterCol.mul(isWater).add(youngF.mul(isYoung)).add(denseF.mul(isDense))
    .add(ripeF.mul(isRipe)).add(mudCol.mul(isMud)).mul(tone);

  // BANKS AND DIKES: the grass, in the shade at the foot of a bank, lit on
  // the crest, trodden paler along the top of each dike.
  const onBank = float(1).sub(past).mul(step(d.negate(), wb.mul(0.5)));
  const crest = past.mul(float(1).sub(q)).add(onBank.mul(smoothstep(0.75, 1, xb)));
  const foot = onBank.mul(float(1).sub(smoothstep(0, 0.55, xb)));
  const bankCol = bankAlb.mul(float(1).sub(foot.mul(0.25))).mul(crest.mul(0.08).add(1));
  mat.colorNode = mix(bankCol, fieldCol, flat);
  // The block's outline, cut per pixel along the smooth mask contour (a grid
  // of quads gave a stepped edge; sinking it under the terrain left cracks).
  mat.maskNode = m.greaterThan(0.3);

  const waterShare = isWater.add(isYoung.mul(float(1).sub(youngCover)).mul(0.45)).add(isMud.mul(0.25));
  mat.roughnessNode = mix(float(0.92), mix(float(0.85), float(0.03), waterShare), flat);
  mat.metalnessNode = mirror.mul(waterShare).mul(flat);

  // THE NORMAL: the slope of the steps along the hill's gradient (the same
  // profile as the mesh), the grass's own normal map on the banks, the
  // leaves' on the crop, the ripples on the water.
  mat.normalNode = Fn(() => {
    const ramp = xb.mul(float(1).sub(xb)).mul(6).div(wb).mul(float(1).sub(past));
    const fall = q.mul(float(1).sub(q)).mul(6).div(wl).mul(past).negate();
    const dyds = ramp.mul(H).add(ramp.add(fall).mul(L));
    const gy = mix(g, g.div(H).mul(dyds), m);
    const gn = texture(TX.grassN, wxz.div(2.6)).xy.mul(2).sub(1);
    const ln = texture(TX.grassN, ruv).xy.mul(2).sub(1);
    const bankK = float(1).sub(flat).mul(0.6);
    const cropK = flat.mul(float(1).sub(waterShare)).mul(0.35);
    const waterK = flat.mul(waterShare);
    const nx = gy.x.negate().add(gn.x.mul(bankK)).add(ln.x.mul(cropK)).add(wn.x.mul(0.2).mul(waterK));
    const nz = gy.y.negate().add(gn.y.mul(bankK)).add(ln.y.mul(cropK)).add(wn.y.mul(0.2).mul(waterK));
    return transformNormalToView(normalize(vec3(nx, 1, nz)));
  })();
}

/** The photo textures, loaded once and shared. */
let _paddyTex = null;
function paddyTextures() {
  if (_paddyTex) return _paddyTex;
  const load = (url, srgb) => {
    const tx = new THREE.TextureLoader().load(url);
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    tx.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tx.anisotropy = 8;
    return tx;
  };
  _paddyTex = {
    grass: load("/textures/pbr_materials/Grass005/Grass005_1K-JPG_Color.jpg", true),
    grassN: load("/textures/pbr_materials/Grass005/Grass005_1K-JPG_NormalGL.jpg", false),
    moss: load("/textures/pbr_materials/Ground037/Ground037_1K-JPG_Color.jpg", true),
    mud: load("/textures/ground/dry_mud_field_001/dry_mud_field_001_diff_1k.jpg", true),
    waterN: load("/textures/waterNormal.webp", false),
  };
  return _paddyTex;
}

