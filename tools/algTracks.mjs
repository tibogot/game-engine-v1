/**
 * TRACKS — the Aurès map's dirt piste and mule paths, routed over the real
 * ground, painted into it and rutted with decals.
 *
 *   node tools/algTracks.mjs --route        routes -> games/alg-rts/tracks.js
 *   node tools/algTracks.mjs [--dry]        paint + decals from tracks.js
 *   node tools/algTracks.mjs --decals <bake.json>   (first) write the baked
 *                                           decal art to public/textures/decals/alg/
 *
 * ROUTING. A track is not a line between two sites: a truck will not climb
 * 20°, so the piste follows the valley floor and crosses the wadis at their
 * FORDS (tools/algWadi.mjs cut the banks past the nav limit everywhere else);
 * a mule path climbs what a man with a mule climbs, up the gullies. A* on a
 * 2 m grid over the playable box, the cost a function of the grade along the
 * move and the ground's slope, round every placed piece (showroom.js). Later
 * routes ride earlier ones (a discount on cells already tracked), so the
 * branches JOIN the trunk instead of running beside it. The routes are then
 * simplified and written as plain data (tracks.js), which the game reads
 * (patrols, ambushes, mines, convoys) — route once, paint many times.
 *
 * PAINT. Slot 6 (the unused "Snow" slot: same textures bound, no sampler
 * added) becomes "Dirt track": dry_mud_field_001 tinted pale — compacted dust,
 * finer and lighter than the valley soil. The piste ~5 m wide, a mule path
 * ~1.5 m and broken. Idempotent: slot 6 is cleared (its weight given back to
 * the other slots in proportion) before painting. The vegetation tool reads
 * slot 6 and keeps it bare: re-run tools/algVegetation.mjs after this.
 *
 * DECALS. Photographic ruts (decalPhotoArt.js "ruts" on the dust photo) along
 * the piste, foot-worn paths along the mule paths, 10 m segments overlapping
 * by ENDFADE so the ends cross-fade (as nam-valley's).
 */
import fs from "node:fs";
import path from "node:path";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { NAV_MAX_SLOPE_DEG } from "./lib/rtsMapMetrics.mjs";
import { LAYOUT, PLAY } from "../games/alg-rts/layout.js";

const args = process.argv.slice(2);
const FILE = args.includes("--file") ? args[args.indexOf("--file") + 1] : "public/levels/alg-aures.v3proj";
const dry = args.includes("--dry");
const TRACKS_JS = "games/alg-rts/tracks.js";
const DECAL_DIR = "public/textures/decals/alg";
const SLOT = 6;
const TRACK_UV = 160;           // layer repeats over the world: 1024/160 = 6.4 m a tile
const TRACK_TINT = "#eadcc4";
const ENDFADE = 1.5;            // decalPhotoArt ENDFADE_M

// ── decal art (from a browser bake) ─────────────────────────────────────────
if (args.includes("--decals")) {
  const raw = fs.readFileSync(args[args.indexOf("--decals") + 1], "utf8");
  const bake = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  fs.mkdirSync(DECAL_DIR, { recursive: true });
  for (const [key, b] of Object.entries(bake)) {
    for (const [suffix, url] of [["", b.albedo], ["_n", b.normal]]) {
      const m = String(url).match(/^data:image\/(webp|png);base64,(.+)$/);
      if (!m) throw new Error(`${key}: not a webp/png data URL`);
      fs.writeFileSync(path.join(DECAL_DIR, `${key}${suffix}.${m[1]}`), Buffer.from(m[2], "base64"));
    }
    console.log(`wrote ${DECAL_DIR}/${key}(.webp, _n.webp) ${b.size.join(" x ")} m`);
  }
  process.exit(0);
}

const project = await readProject(FILE);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, ((x + W / 2) / W) * (N - 1)));
  const fv = Math.max(0, Math.min(N - 1.001, ((z + W / 2) / W) * (N - 1)));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hm[y0 * N + x0], b = hm[y0 * N + x0 + 1], c = hm[(y0 + 1) * N + x0], d = hm[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const slopeDeg = (x, z) => {
  const e = 1.5;
  const gx = (H(x + e, z) - H(x - e, z)) / (2 * e), gz = (H(x, z + e) - H(x, z - e)) / (2 * e);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
};
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const hash = (x, y, s) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const vnoise = (x, y, s) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};

/** Catmull-Rom through the points, resampled every `step` metres. */
function resample(pts, step = 2) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTE
// ════════════════════════════════════════════════════════════════════════════
if (args.includes("--route")) {
  const { SHOWROOM, ALN_BUILDABLES } = await import("../games/alg-rts/showroom.js");
  const site = (name) => LAYOUT.sites.find((s) => s.name === name);
  const post = LAYOUT.sites.find((s) => s.kind === "french");
  const postPiece = SHOWROOM.find((p) => p.key === "frenchPost");
  // Out of the gate: the post's local -Z (showroom.js fromBase).
  const gate = (lz, lx = 0) => { const c = Math.cos(postPiece.yaw), s = Math.sin(postPiece.yaw); return [post.x + lx * c - lz * s, post.z - lx * s - lz * c]; };

  // Keep-outs: every placed piece, a circle (metres). Sites the route ENDS at
  // are an end ring, not a keep-out.
  const R_OF = { sandbags1: 3.5, sandbags2: 3.5, wire1: 4, wire2: 4, mgNest: 4, searchlight: 4, mirador: 5, frenchPost: 30, helipad: 12, motorPool: 14, mortarPit: 7, sasPost: 11, zeriba1: 9, zeriba2: 9, alnCamp: 30, caveEntrance: 10 };
  const siteR = (key) => ({ mechta: site("Mechta Ouled Ali").r, mechta2: site("Mechta el Oued").r, dechra: site("Dechra Tighanimine").r, koubba: 12, cemetery: 13 })[key];
  const pieces = SHOWROOM.filter((p) => !p.vehicle).map((p) => ({ key: p.key, x: p.x, z: p.z, r: siteR(p.key) ?? R_OF[p.key] ?? 6 }));
  void ALN_BUILDABLES;
  // The post is a BOX (22 x 24 m half-sizes + its wire), in its own frame: a
  // circle round it swallowed its own gate.
  const postK = pieces.find((p) => p.key === "frenchPost");
  postK.box = { yaw: postPiece.yaw, hx: 25, hz: 26 };
  const inside = (p, x, z) => {
    if (!p.box) return Math.hypot(x - p.x, z - p.z) < p.r;
    const c = Math.cos(p.box.yaw), s = Math.sin(p.box.yaw), dx = x - p.x, dz = z - p.z;
    // World -> post-local: lx along (cos, -sin), forward lz along (-sin, -cos).
    const lx = dx * c - dz * s, lz = -dx * s - dz * c;
    return Math.abs(lx) < p.box.hx && Math.abs(lz) < p.box.hz;
  };
  const lakes = man.lakes?.lakes ?? [];

  // The routes. `from`/`to`: a site name, "gate", or [x, z]. kind piste = the
  // vehicle track; mule = a foot path. Order matters: later ones ride earlier.
  const ROUTES = [
    // The trunk: the post to the near hamlet (it passes the oasis), on to the
    // far one over the oued. Branches leave from the trunk ("network").
    { name: "Piste de Ouled Ali", kind: "piste", from: "gate", to: "Mechta Ouled Ali" },
    { name: "Piste de l'oasis", kind: "piste", from: "network", to: "Ain Tighanimine" },
    { name: "Piste de l'Oued", kind: "piste", from: "Mechta Ouled Ali", to: "Mechta el Oued" },
    { name: "Piste de la dechra", kind: "piste", from: "network", to: "Dechra Tighanimine" },
    { name: "Sentier de la koubba", kind: "mule", from: "Dechra Tighanimine", to: "Sidi Ahmed" },
    { name: "Sentier du ravin ouest", kind: "mule", from: "Dechra Tighanimine", to: "Gully mouth west" },
    { name: "Sentier de la katiba ouest", kind: "mule", from: "Gully mouth west", to: "Katiba camp" },
    { name: "Sentier du ravin est", kind: "mule", from: "Mechta Ouled Ali", to: "Gully mouth east" },
    { name: "Sentier de la katiba est", kind: "mule", from: "Gully mouth east", to: "Katiba camp" },
  ];
  const KIND = {
    // grade = rise over run along the move; slope = the ground's own.
    piste: { maxGrade: 0.26, maxSlope: 24, gradeK: 0.09, slopeK: 14, reuse: 0.45 },
    mule: { maxGrade: 0.55, maxSlope: NAV_MAX_SLOPE_DEG - 3, gradeK: 0.22, slopeK: 24, reuse: 0.5 },
  };

  const C = 2;   // grid cell, metres
  const X0 = PLAY.x0 + 4, Z0 = PLAY.z0 + 4;
  const GW = Math.floor((PLAY.x1 - PLAY.x0 - 8) / C), GH = Math.floor((PLAY.z1 - PLAY.z0 - 8) / C);
  const cx = (i) => X0 + (i + 0.5) * C, cz = (j) => Z0 + (j + 0.5) * C;
  const hC = new Float32Array(GW * GH), sC = new Float32Array(GW * GH);
  const wet = new Uint8Array(GW * GH);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const x = cx(i), z = cz(j), k = j * GW + i;
    hC[k] = H(x, z); sC[k] = slopeDeg(x, z);
    wet[k] = lakes.some((l) => Math.hypot(x - l.cx, z - l.cz) < l.sizeX / 2 + 3) ? 1 : 0;
  }
  const used = new Uint8Array(GW * GH);   // 1 piste, 2 mule
  const cellOf = ([x, z]) => [Math.max(0, Math.min(GW - 1, Math.floor((x - X0) / C))), Math.max(0, Math.min(GH - 1, Math.floor((z - Z0) / C)))];

  const endOf = (ref) => {
    if (ref === "gate") return { p: gate(28, -5), r: 0, key: null };
    if (ref === "network") return { p: [0, 0], r: 0, key: null, network: true };
    if (Array.isArray(ref)) return { p: ref, r: 0, key: null };
    const s = site(ref);
    if (!s) throw new Error(`no site "${ref}"`);
    // The site's own piece (a village ends at its rim); a point site: its ring.
    const piece = pieces.find((p) => Math.hypot(p.x - s.x, p.z - s.z) < 1);
    const r = s.kind === "oasis" ? (lakes.find((l) => Math.hypot(l.cx - s.x, l.cz - s.z) < 40)?.sizeX ?? 20) / 2 + 5 : piece ? piece.r + 2 : Math.max(4, s.r * 0.5);
    return { p: [s.x, s.z], r, key: piece?.key ?? null };
  };

  // Binary heap on f.
  let lastBlock = null;
  function astar(from, to, K) {
    const block = new Uint8Array(GW * GH);
    lastBlock = block;
    for (const p of pieces) {
      if (p.key === from.key || p.key === to.key) continue;
      const [i0, j0] = cellOf([p.x - p.r, p.z - p.r]), [i1, j1] = cellOf([p.x + p.r, p.z + p.r]);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (inside(p, cx(i), cz(j))) block[j * GW + i] = 1;
    }
    const inEnd = (k, e) => { const i = k % GW, j = (k / GW) | 0; return Math.hypot(cx(i) - e.p[0], cz(j) - e.p[1]) <= Math.max(e.r, C); };
    const g = new Float32Array(GW * GH).fill(Infinity), came = new Int32Array(GW * GH).fill(-1);
    const heap = [], push = (k, f) => { heap.push([f, k]); let n = heap.length - 1; while (n) { const p = (n - 1) >> 1; if (heap[p][0] <= heap[n][0]) break; [heap[p], heap[n]] = [heap[n], heap[p]]; n = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === n) break; [heap[m], heap[n]] = [heap[n], heap[m]]; n = m; } } return top; };
    const hEst = (k) => Math.hypot(cx(k % GW) - to.p[0], cz((k / GW) | 0) - to.p[1]) - to.r;
    // Start: every free cell in the start ring (a site's rim is many cells).
    // "network": a branch leaves from anywhere on the piste already routed.
    if (from.network) for (let k = 0; k < GW * GH; k++) if (used[k] === 1 && !block[k]) { g[k] = 0; push(k, hEst(k)); }
    const [si, sj] = cellOf(from.p);
    const rr = from.network ? -1 : Math.ceil(Math.max(from.r, C) / C) + 1;
    for (let j = sj - rr; j <= sj + rr; j++) for (let i = si - rr; i <= si + rr; i++) {
      if (i < 0 || j < 0 || i >= GW || j >= GH) continue;
      const k = j * GW + i;
      const d = Math.hypot(cx(i) - from.p[0], cz(j) - from.p[1]);
      if (d > Math.max(from.r, C) + 0.01 || d < from.r - 3 || block[k]) continue;
      g[k] = 0; push(k, hEst(k));
    }
    const DIRS = [];
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
      if ((!di && !dj) || (Math.abs(di) === 2 && Math.abs(dj) === 2) || (Math.abs(di) === 2 && !dj) || (Math.abs(dj) === 2 && !di)) continue;
      DIRS.push([di, dj, Math.hypot(di, dj) * C]);
    }
    while (heap.length) {
      const [, k] = pop();
      if (inEnd(k, to) && hEst(k) <= 0.5) {
        const out = [];
        for (let q = k; q >= 0; q = came[q]) out.push(q);
        return out.reverse();
      }
      const i = k % GW, j = (k / GW) | 0;
      for (const [di, dj, len] of DIRS) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= GW || nj >= GH) continue;
        const n = nj * GW + ni;
        if (block[n] || wet[n] || sC[n] > K.maxSlope) continue;
        // A knight's move crosses a middle cell: it must pass too.
        if (Math.abs(di) === 2 || Math.abs(dj) === 2) {
          const m = (j + Math.round(dj / 2)) * GW + (i + Math.round(di / 2));
          if (block[m] || wet[m] || sC[m] > K.maxSlope) continue;
        }
        const grade = Math.abs(hC[n] - hC[k]) / len;
        if (grade > K.maxGrade) continue;
        const reuse = used[n] ? K.reuse : 1;
        const cost = len * reuse * (1 + (grade / K.gradeK) ** 2 * 0.6 + (sC[n] / K.slopeK) ** 2 * 0.4);
        const ng = g[k] + cost;
        if (ng < g[n]) { g[n] = ng; came[n] = k; push(n, ng + Math.max(0, hEst(n))); }
      }
    }
    return null;
  }

  /**
   * Douglas-Peucker on [x, z] points, GUARDED: a straight run replaces the
   * cells between its ends only if the run itself is a legal move — within
   * the kind's grade and slope, dry, clear of every keep-out. Unguarded, a
   * wide tolerance lays the grid's stairs into lines but also cuts corners
   * down a wadi bank (a 235% grade, measured).
   */
  function simplify(P, tol, ok) {
    if (P.length < 3) return P;
    let idx = 0, dmax = 0;
    const [ax, az] = P[0], [bx, bz] = P[P.length - 1], dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    for (let i = 1; i < P.length - 1; i++) {
      const d = Math.abs((P[i][0] - ax) * dz - (P[i][1] - az) * dx) / L;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax <= tol && ok(P[0], P[P.length - 1])) return [P[0], P[P.length - 1]];
    if (dmax <= tol) idx = P.length >> 1;
    return [...simplify(P.slice(0, idx + 1), tol, ok).slice(0, -1), ...simplify(P.slice(idx), tol, ok)];
  }
  /** Is the straight run a..b a legal move for K (sampled every metre)? */
  const legal = (K, block) => (a, b) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L));
    let prev = H(a[0], a[1]);
    for (let s = 1; s <= n; s++) {
      const x = a[0] + ((b[0] - a[0]) * s) / n, z = a[1] + ((b[1] - a[1]) * s) / n;
      const [i, j] = cellOf([x, z]), k = j * GW + i;
      if (block[k] || wet[k] || slopeDeg(x, z) > K.maxSlope) return false;
      const h = H(x, z);
      if (Math.abs(h - prev) / (L / n) > K.maxGrade * 1.15) return false;
      prev = h;
    }
    return true;
  };

  const out = [];
  for (const R of ROUTES) {
    const K = KIND[R.kind];
    const from = endOf(R.from), to = endOf(R.to);
    const cells = astar(from, to, K);
    if (!cells) { console.error(`NO ROUTE: ${R.name}`); process.exit(1); }
    for (const k of cells) used[k] = Math.max(used[k], R.kind === "piste" ? 1 : 2);
    let pts = cells.map((k) => [cx(k % GW), cz((k / GW) | 0)]);
    // The piste starts AT the gate, not on its ring.
    if (R.from === "gate") pts.unshift(gate(21, -1));
    const ok = legal(K, lastBlock);
    pts = simplify(pts, R.kind === "piste" ? 4 : 3, ok);
    // Jogs: a short leg (< 10 m) turning hard (> 35°) is the grid's, not the
    // ground's — drop the point if the run past it is legal. Ruts laid over
    // one drew a Z.
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 1; i < pts.length - 1; i++) {
        const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
        const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
        const turn = Math.acos(Math.max(-1, Math.min(1, ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2 || 1))));
        if (Math.min(l1, l2) < 10 && turn > (35 * Math.PI) / 180 && ok(a, c)) { pts.splice(i, 1); changed = true; break; }
      }
    }
    pts = pts.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
    // Report the worst grade and slope along the smoothed line.
    const fine = resample(pts, 2);
    let len = 0, worstG = 0, worstS = 0;
    for (let i = 1; i < fine.length; i++) {
      const d = Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]);
      len += d;
      if (d > 0.5) worstG = Math.max(worstG, Math.abs(H(...fine[i]) - H(...fine[i - 1])) / d);
      worstS = Math.max(worstS, slopeDeg(...fine[i]));
    }
    if (len < 6) { console.log(`${R.name.padEnd(28)} already on the network — none`); continue; }
    console.log(`${R.name.padEnd(28)} ${R.kind.padEnd(5)} ${len.toFixed(0).padStart(4)} m  ${pts.length} pts  worst grade ${(worstG * 100).toFixed(0)}%  worst slope ${worstS.toFixed(0)}°`);
    out.push({ name: R.name, kind: R.kind, from: R.from, to: R.to, length: Math.round(len), points: pts });
  }

  const js = `// THE AURÈS MAP'S TRACKS — GENERATED by tools/algTracks.mjs --route; do not
// edit by hand (change the ROUTES there and re-route). World metres, [x, z]
// control points of a Catmull-Rom line (resample to walk it).
//
// kind "piste": the dirt vehicle track (the post, the oasis, the villages);
// "mule": a foot path (the dechra, the gully mouths, up to the katiba). The
// game reads these for patrols, convoys, ambushes and mines; the map tool
// paints and ruts the same lines.
export const TRACKS = ${JSON.stringify(out.map(({ points, ...r }) => ({ ...r, points: "@@" })), null, 2)
    .replace(/"@@"/g, () => "@@")};
`;
  let k = 0;
  const final = js.replace(/@@/g, () => "[\n" + chunk(out[k++].points).join(",\n") + ",\n    ]");
  function chunk(P) {
    const rows = [];
    for (let i = 0; i < P.length; i += 6) rows.push("      " + P.slice(i, i + 6).map((p) => `[${p[0]}, ${p[1]}]`).join(", "));
    return rows;
  }
  if (!dry) { fs.writeFileSync(TRACKS_JS, final); console.log(`wrote ${TRACKS_JS}`); }
  process.exit(0);
}

// ════════════════════════════════════════════════════════════════════════════
// PAINT + DECALS
// ════════════════════════════════════════════════════════════════════════════
const { TRACKS } = await import("../games/alg-rts/tracks.js");

// ── Paint ───────────────────────────────────────────────────────────────────
const tex = (id) => {
  const f = (m) => ({ name: `${id}_${m}_1k.jpg`, url: `/textures/ground/${id}/${id}_${m}_1k.jpg` });
  return { albedo: f("diff"), normal: f("nor_gl"), rough: f("rough"), ao: f("ao") };
};
man.paintLayers[SLOT] = {
  name: "Dirt track", ...tex("dry_mud_field_001"),
  uvScale: TRACK_UV, normalStr: 1, aoStr: 0.8, roughStr: 1, triplanar: false, tint: TRACK_TINT,
  uvRotation: 0, contourAlign: 0, rockShade: 0, procedural: null, blocksGrass: true, blocksTrees: true,
  auto: { enabled: false, heightMin: 0, heightMax: 500, slopeMin: 0, slopeMax: 90, blend: 15, strength: 1 },
};
const RES = man.splatRes;
const splat = project.blobs.get("splat");
const off = RES * RES * 4;
const ch = (q, c) => (c < 4 ? q + c : off + q + c - 4);

// Clear slot 6: its weight back to the others, in proportion.
let cleared = 0;
for (let q = 0; q < RES * RES * 4; q += 4) {
  const w6 = splat[ch(q, SLOT)];
  if (!w6) continue;
  let rest = 0;
  for (let c = 0; c < 7; c++) if (c !== SLOT) rest += splat[ch(q, c)];
  splat[ch(q, SLOT)] = 0;
  if (rest > 0) for (let c = 0; c < 7; c++) if (c !== SLOT) splat[ch(q, c)] = Math.min(255, Math.round(splat[ch(q, c)] * (rest + w6) / rest));
  else splat[ch(q, 0)] = w6;
  cleared++;
}

// Distance to each kind's lines, per texel (only near them).
const texel = W / RES;
const PROFILE = {
  // hw: half width to full weight; fade: metres out to zero; peak: max weight.
  piste: { hw: 2.2, fade: 1.6, peak: 0.95, wobble: 0.5, breakup: 0 },
  mule: { hw: 0.55, fade: 0.8, peak: 0.8, wobble: 0.25, breakup: 0.5 },
};
const weight = new Float32Array(RES * RES);
const lines = [];
for (const t of TRACKS) {
  const P = PROFILE[t.kind];
  const fine = resample(t.points, 1);
  lines.push({ t, fine });
  const reach = P.hw + P.wobble + P.fade + 0.5;
  for (let i = 0; i < fine.length - 1; i++) {
    const [ax, az] = fine[i], [bx, bz] = fine[i + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-6;
    const px0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach + W / 2) / texel)), px1 = Math.min(RES - 1, Math.ceil((Math.max(ax, bx) + reach + W / 2) / texel));
    const pz0 = Math.max(0, Math.floor((Math.min(az, bz) - reach + W / 2) / texel)), pz1 = Math.min(RES - 1, Math.ceil((Math.max(az, bz) + reach + W / 2) / texel));
    for (let pz = pz0; pz <= pz1; pz++) for (let px = px0; px <= px1; px++) {
      const x = (px + 0.5) * texel - W / 2, z = (pz + 0.5) * texel - W / 2;
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      const d = Math.hypot(x - ax - dx * u, z - az - dz * u);
      if (d > reach) continue;
      // The edge wanders (noise), and a mule path breaks up into bare patches.
      const hw = P.hw + (vnoise(x / 3, z / 3, 41) - 0.5) * 2 * P.wobble;
      let w = (1 - smooth((d - hw) / P.fade)) * P.peak;
      if (P.breakup) w *= 1 - P.breakup * smooth((vnoise(x / 4, z / 4, 43) - 0.45) / 0.25);
      w *= 0.85 + 0.15 * vnoise(x / 1.5, z / 1.5, 47);
      const k = pz * RES + px;
      if (w > weight[k]) weight[k] = w;
    }
  }
}
let painted = 0;
for (let k = 0; k < RES * RES; k++) {
  const w = weight[k];
  if (w <= 0.004) continue;
  const q = k * 4, keep = 1 - w;
  // Not on a wadi bed: the piste fords it, the gravel stays gravel.
  if (splat[ch(q, 4)] > 150) continue;
  for (let c = 0; c < 7; c++) if (c !== SLOT) splat[ch(q, c)] = Math.round(splat[ch(q, c)] * keep);
  splat[ch(q, SLOT)] = Math.min(255, Math.round(w * 255));
  painted++;
}

// ── Decals ──────────────────────────────────────────────────────────────────
// Art from the bake (--decals), one slot per variant; picked per decal by a
// hash of its position (the same spot always gets the same variant).
const ART = {
  piste: { kind: "ruts", size: [3.2, 10], opacity: 0.7, roughness: 0.9 },
  mule: { kind: "footPath", size: [2.4, 10], opacity: 0.7, roughness: 0.95 },
};
const files = fs.existsSync(DECAL_DIR) ? fs.readdirSync(DECAL_DIR) : [];
const D = man.decals ?? { slots: [], decals: [] };
// Our slots are named "alg <kind> <n>"; anything else in the map is kept.
const keepSlots = D.slots.map((s, i) => [s, i]).filter(([s]) => !s.name.startsWith("alg track "));
const slotMap = new Map(keepSlots.map(([, i], n) => [i, n]));
const slots = keepSlots.map(([s]) => s);
const decals = D.decals.filter((d) => slotMap.has(d.slot)).map((d) => ({ ...d, slot: slotMap.get(d.slot) }));
const variants = {};
for (const [kind, A] of Object.entries(ART)) {
  variants[kind] = [];
  for (const f of files.filter((f) => f.startsWith(`${A.kind}_`) && !f.includes("_n.")).sort()) {
    const key = f.replace(/\.(webp|png)$/, "");
    const nor = files.find((g) => g.startsWith(`${key}_n.`));
    variants[kind].push(slots.length);
    slots.push({ name: `alg track ${key}`, albedoUrl: `/textures/decals/alg/${f}`, normalUrl: nor ? `/textures/decals/alg/${nor}` : null });
  }
}
const vhash = (x, z) => {
  let h = Math.imul(Math.round(x * 10), 73856093) ^ Math.imul(Math.round(z * 10), 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h >>> 0) / 4294967296;
};
let laid = 0;
for (const { t, fine } of lines) {
  const A = ART[t.kind], V = variants[t.kind];
  if (!V.length) continue;
  const [Wd, L] = A.size, step = L - ENDFADE;
  // Arc length along the fine line.
  const s = [0];
  for (let i = 1; i < fine.length; i++) s.push(s[i - 1] + Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]));
  const at = (d) => {
    let i = 1;
    while (i < s.length - 1 && s[i] < d) i++;
    const u = (d - s[i - 1]) / Math.max(1e-6, s[i] - s[i - 1]);
    return [fine[i - 1][0] + (fine[i][0] - fine[i - 1][0]) * u, fine[i - 1][1] + (fine[i][1] - fine[i - 1][1]) * u];
  };
  const total = s[s.length - 1];
  for (let d = L / 2; d < total - L / 2 + step * 0.5; d += step) {
    const dc = Math.min(d, total - L / 2);
    // Along the CHORD of its own 10 m, not the tangent at its centre; and
    // none on a bend tighter than the strip can follow (the curve strays
    // > 0.5 m off the chord): there the paint alone carries the track.
    const a = at(Math.max(0, dc - L / 2)), b = at(Math.min(total, dc + L / 2));
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const mid = at(dc);
    if (Math.hypot(mid[0] - c[0], mid[1] - c[1]) > 0.5) continue;
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
    // Wear is uneven: each segment its own strength; a few left out (their
    // ends fade, so the ruts come and go instead of running like rails).
    const r = vhash(c[0] + 0.37, c[1] - 0.11);
    if (r < 0.18) continue;
    // Where the paint was skipped (a wadi bed), no ruts either.
    const k = Math.floor((c[1] + W / 2) / texel) * RES + Math.floor((c[0] + W / 2) / texel);
    if (splat[ch(k * 4, 4)] > 150) continue;
    decals.push({
      px: c[0], py: H(c[0], c[1]), pz: c[1],
      qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2),
      slot: V[Math.floor(vhash(c[0], c[1]) * V.length) % V.length],
      sx: Wd, sy: 5, sz: L,
      opacity: A.opacity * (0.6 + 0.4 * r), tint: TRACK_TINT, roughness: A.roughness, normalStrength: 1,
      angleFade: 55, edgeFade: 0.16, priority: 1,
    });
    laid++;
  }
}
man.decals = { ...D, slots, decals };

for (const t of TRACKS) console.log(`${t.name.padEnd(28)} ${t.kind.padEnd(5)} ${String(t.length).padStart(4)} m`);
console.log(`slot ${SLOT} "Dirt track": ${cleared} texels cleared, ${painted} painted; decals ${laid} laid (${slots.length} slots, ${decals.length} in the map)`);
if (!Object.values(variants).some((v) => v.length)) console.log(`(no decal art in ${DECAL_DIR} yet: bake it, then --decals <bake.json>)`);
if (!dry) { await writeProject(FILE, project); console.log(`wrote ${FILE}`); }
