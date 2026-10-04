/**
 * PLACE THE PLAY BOX on a map cut (tools/algDem.mjs) and say how it plays —
 * LAND ONLY: the sea is not ground, however flat it is.
 *
 *   node tools/algMapBox.mjs --cut <dir>/filfila [--box 480] [--at x,z] [--margin 150] [--out <dir>]
 *
 * Reads <cut>.f32 + <cut>.json (algDem writes both). World metres, north up
 * = -Z, the map centred on 0 (as layout.js).
 *
 * Without --at: slides the box over the map and ranks the places where the
 * sea runs along one or two of its edges, and measures the best. With --at
 * (the box CENTRE): measures that one. Prints, inside the box:
 *   · the land metrics (walkable ≤34°, gentle ≤15°, histogram, 4×4 tiles);
 *   · the biggest CONNECTED walkable patch;
 *   · the CHOKEPOINTS — the necks narrower than --choke m between two open
 *     areas of at least --room ha (cells joined widest-first: the cell that
 *     first joins two big areas is the narrowest point of the best way
 *     between them, so its width is the bottleneck's).
 * Writes <cut>-boxes.png (the map, ranked boxes) and <cut>-box.png (the box,
 * 1 px a metre: blue sea, red past the nav limit, light = gentle, yellow =
 * chokepoints, 50 m grid).
 *
 * THE SEA: low ground joined to the map edge (Terrarium reads the sea as ~0
 * with noise), plus the low specks of "land" out in it (the noise).
 */
import fs from "node:fs";
import path from "node:path";
import { measureRtsMap, printRtsMetrics, NAV_MAX_SLOPE_DEG, GENTLE_DEG } from "./lib/rtsMapMetrics.mjs";
import { encodePngRgb } from "./lib/pngRgb.mjs";
import { coastSeaMask, chamferDistance } from "./lib/coastSea.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!args.cut) throw new Error("usage: --cut <dir>/<name> [--box 480] [--at x,z] [--choke 24] [--room 0.5] [--out <dir>]");
const meta = JSON.parse(fs.readFileSync(`${args.cut}.json`, "utf8"));
const N = meta.size, W = meta.world, cell = W / (N - 1), cellHa = (cell * cell) / 1e4;
const raw = fs.readFileSync(`${args.cut}.f32`);
const h = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)).map((v) => v * meta.top);
const BOX = +(args.box ?? 480);
const CHOKE = +(args.choke ?? 24);      // a neck narrower than this, metres, is a chokepoint
const ROOM = +(args.room ?? 0.5);       // ... if it joins two open areas this big, ha
const MARGIN = +(args.margin ?? 150);   // the box stays this far inside the map (algShapeMap fades the border)
const name = path.basename(args.cut);
const outDir = args.out ?? path.dirname(args.cut);

const X = (j) => -W / 2 + j * cell, Z = (i) => -W / 2 + i * cell;
const J = (x) => Math.round((x + W / 2) / cell), I = (z) => Math.round((z + W / 2) / cell);

// ── The sea ────────────────────────────────────────────────────────────────
const sea = coastSeaMask(h, N, W, meta.seaLevel);
const slope = measureRtsMap(h, N, W, { seaMask: sea }).slope;
const walk = (k) => !sea[k] && slope[k] <= NAV_MAX_SLOPE_DEG;

// ── Rank boxes ─────────────────────────────────────────────────────────────
const B = Math.round(BOX / cell);
const integral = (f) => {
  const s = new Float64Array((N + 1) * (N + 1));
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) s[(i + 1) * (N + 1) + j + 1] = f(i * N + j) + s[i * (N + 1) + j + 1] + s[(i + 1) * (N + 1) + j] - s[i * (N + 1) + j];
  return (i0, j0) => s[(i0 + B) * (N + 1) + j0 + B] - s[i0 * (N + 1) + j0 + B] - s[(i0 + B) * (N + 1) + j0] + s[i0 * (N + 1) + j0];
};
const sLand = integral((k) => 1 - sea[k]), sWalk = integral((k) => +walk(k));
const sGentle = integral((k) => +(!sea[k] && slope[k] <= GENTLE_DEG));
function edges(i0, j0) {
  const f = { N: 0, S: 0, W: 0, E: 0 };
  for (let t = 0; t < B; t++) {
    f.N += sea[i0 * N + j0 + t]; f.S += sea[(i0 + B - 1) * N + j0 + t];
    f.W += sea[(i0 + t) * N + j0]; f.E += sea[(i0 + t) * N + j0 + B - 1];
  }
  for (const k in f) f[k] /= B;
  return f;
}
function boxStats(i0, j0) {
  const land = sLand(i0, j0), e = edges(i0, j0);
  const two = Object.values(e).sort((a, b) => b - a);
  return {
    i0, j0, e, landPct: (100 * land) / (B * B), landHa: land * cellHa,
    walkPct: land ? (100 * sWalk(i0, j0)) / land : 0, gentlePct: land ? (100 * sGentle(i0, j0)) / land : 0,
    seaEdge: two[0] + two[1],   // how much of the two most-sea edges is sea (2 = both all sea)
  };
}

let chosen;
const ranked = [];
if (args.at) {
  const [x, z] = args.at.split(",").map(Number);
  chosen = boxStats(I(z) - (B >> 1), J(x) - (B >> 1));
} else {
  const all = [];
  const M0 = Math.round(MARGIN / cell);
  for (let i0 = M0; i0 + B <= N - M0; i0 += 8) for (let j0 = M0; j0 + B <= N - M0; j0 += 8) {
    const s = boxStats(i0, j0);
    if (s.landPct >= 60 && s.seaEdge >= 0.4) all.push(s);
  }
  // Most sea along the edges first, then the most gentle land.
  all.sort((a, b) => (Math.round(b.seaEdge * 5) - Math.round(a.seaEdge * 5)) || (b.gentlePct - a.gentlePct));
  for (const s of all) {
    if (ranked.every((r) => Math.hypot(r.i0 - s.i0, r.j0 - s.j0) * cell > 90)) ranked.push(s);
    if (ranked.length === 6) break;
  }
  if (!ranked.length) throw new Error("no box with sea along an edge and ≥60% land — re-cut the map nearer the coast");
  chosen = ranked[0];
}
const box = (s) => ({ x0: Math.round(X(s.j0)), x1: Math.round(X(s.j0 + B - 1)), z0: Math.round(Z(s.i0)), z1: Math.round(Z(s.i0 + B - 1)) });
const fmt = (s) => {
  const b = box(s);
  const se = Object.entries(s.e).filter(([, v]) => v > 0.05).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" ") || "none";
  return `centre (${Math.round((b.x0 + b.x1) / 2)}, ${Math.round((b.z0 + b.z1) / 2)})  land ${s.landPct.toFixed(0)}% (${s.landHa.toFixed(1)} ha)  walkable ${s.walkPct.toFixed(1)}%  gentle ${s.gentlePct.toFixed(1)}%  sea on edges: ${se}`;
};
if (ranked.length) {
  console.log(`\n── ${name}: ${BOX} m boxes with the sea along an edge (best first)`);
  ranked.forEach((s, k) => console.log(`${k + 1}. ${fmt(s)}`));
}

// ── Measure the chosen box ────────────────────────────────────────────────
const { i0, j0 } = chosen;
const sub = new Float32Array(B * B), subSea = new Uint8Array(B * B), subSlope = new Float32Array(B * B);
for (let i = 0; i < B; i++) for (let j = 0; j < B; j++) {
  const k = (i0 + i) * N + j0 + j;
  sub[i * B + j] = h[k]; subSea[i * B + j] = sea[k]; subSlope[i * B + j] = slope[k];
}
const m = measureRtsMap(sub, B, (B - 1) * cell, { seaMask: subSea });
printRtsMetrics(m, `${name}: the box ${JSON.stringify(box(chosen))}  (${fmt(chosen)})`);
const ok = (k) => !subSea[k] && subSlope[k] <= NAV_MAX_SLOPE_DEG;   // the full map's slope: no edge effect at the box border

// Biggest connected WALKABLE patch.
{
  const lab = new Int32Array(B * B), stack = new Int32Array(B * B);
  let best = 0, id = 0;
  for (let s = 0; s < B * B; s++) {
    if (lab[s] || !ok(s)) continue;
    id++; let sp = 0, n = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const c = stack[--sp]; n++;
      const i = (c / B) | 0, j = c - i * B;
      for (const q of [j > 0 ? c - 1 : -1, j < B - 1 ? c + 1 : -1, i > 0 ? c - B : -1, i < B - 1 ? c + B : -1]) {
        if (q >= 0 && !lab[q] && ok(q)) { lab[q] = id; stack[sp++] = q; }
      }
    }
    best = Math.max(best, n);
  }
  console.log(`biggest connected walkable patch ${(best * cellHa).toFixed(1)} ha = ${((100 * best * cellHa) / m.landHa).toFixed(1)}% of the land`);
}

// Clearance: metres to the nearest unwalkable cell or the box edge (chamfer 1 / √2).
const clr = chamferDistance(B, (k) => !ok(k), true);

// Join cells widest-first (union-find); a cell that first joins two areas of
// ≥ ROOM ha at a clearance under CHOKE / 2 is a chokepoint.
const order = [];
for (let k = 0; k < B * B; k++) if (clr[k] > 0) order.push(k);
order.sort((a, b) => clr[b] - clr[a]);
const parent = new Int32Array(B * B).fill(-1), area = new Float64Array(B * B);
const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
const chokes = [];
const minRoom = ROOM / cellHa;
for (const k of order) {
  parent[k] = k; area[k] = 1;
  const i = (k / B) | 0, j = k - i * B;
  for (const q of [j > 0 ? k - 1 : -1, j < B - 1 ? k + 1 : -1, i > 0 ? k - B : -1, i < B - 1 ? k + B : -1]) {
    if (q < 0 || parent[q] < 0) continue;
    const a = find(k), b = find(q);
    if (a === b) continue;
    if (area[a] >= minRoom && area[b] >= minRoom && 2 * clr[k] * cell < CHOKE) {
      chokes.push({ k, width: 2 * clr[k] * cell, ha: [area[a] * cellHa, area[b] * cellHa].sort((u, v) => u - v) });
    }
    const [big, small] = area[a] >= area[b] ? [a, b] : [b, a];
    parent[small] = big; area[big] += area[small];
  }
}
console.log(`\nchokepoints (necks under ${CHOKE} m between areas of ≥ ${ROOM} ha; areas = their ground wider than the neck):`);
if (!chokes.length) console.log("  none — every open area reaches every other at least that wide");
for (const c of chokes.sort((a, b) => a.width - b.width)) {
  const i = (c.k / B) | 0, j = c.k - i * B;
  console.log(`  (${Math.round(X(j0 + j))}, ${Math.round(Z(i0 + i))})  ${c.width.toFixed(0)} m wide, joins ${c.ha[0].toFixed(1)} ha to ${c.ha[1].toFixed(1)} ha`);
}

// ── Images ─────────────────────────────────────────────────────────────────
function shade(k, hx, hz) {
  const L = [-0.5, 0.7, -0.5], ln = Math.hypot(...L);
  const dx = (h[k + 1] - h[k]) / cell, dz = (h[k + N] - h[k]) / cell;
  const lit = Math.max(0, (-dx * L[0] + L[1] - dz * L[2]) / (Math.hypot(dx, 1, dz) * ln));
  let v = 60 + 190 * lit;
  if (sea[k]) return [40, 70, 120];
  if (slope[k] > NAV_MAX_SLOPE_DEG) return [v * 0.6 + 100, v * 0.55, v * 0.55];
  if (slope[k] > GENTLE_DEG) v *= 0.78;
  return [v, v, v];
}
const put = (rgb, P, x, y, c) => { if (x >= 0 && y >= 0 && x < P && y < P) { const o = (y * P + x) * 3; rgb[o] = Math.min(255, c[0]); rgb[o + 1] = Math.min(255, c[1]); rgb[o + 2] = Math.min(255, c[2]); } };

{ // The map, the ranked boxes.
  const P = 512, rgb = new Uint8Array(P * P * 3);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const i = Math.min(N - 2, Math.round((y * (N - 1)) / (P - 1))), j = Math.min(N - 2, Math.round((x * (N - 1)) / (P - 1)));
    put(rgb, P, x, y, shade(i * N + j));
  }
  const s2p = (c) => Math.round((c * (P - 1)) / (N - 1));
  const list = ranked.length ? ranked : [chosen];
  list.slice().reverse().forEach((s) => {
    const col = s === chosen ? [255, 220, 40] : [80, 200, 255];
    const a = s2p(s.j0), b = s2p(s.j0 + B - 1), c = s2p(s.i0), d = s2p(s.i0 + B - 1);
    for (let t = a; t <= b; t++) { put(rgb, P, t, c, col); put(rgb, P, t, d, col); }
    for (let t = c; t <= d; t++) { put(rgb, P, a, t, col); put(rgb, P, b, t, col); }
  });
  fs.writeFileSync(path.join(outDir, `${name}-boxes.png`), encodePngRgb(rgb, P, P));
}
{ // The box, 1 px a cell.
  const P = B, rgb = new Uint8Array(P * P * 3);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const i = Math.min(N - 2, i0 + y), j = Math.min(N - 2, j0 + x);
    let c = shade(i * N + j);
    if (Math.abs(X(j)) % 50 < cell || Math.abs(Z(i)) % 50 < cell) c = c.map((v) => v * 0.7 + 50);
    if (Math.abs(X(j)) < cell || Math.abs(Z(i)) < cell) c = [200, 200, 255];   // the world axes
    put(rgb, P, x, y, c);
  }
  for (const ch of chokes) {
    const ci = (ch.k / B) | 0, cj = ch.k - ci * B, r = Math.max(6, ch.width / 2 / cell + 3);
    for (let a = 0; a < 360; a += 1) for (const rr of [r, r + 1]) put(rgb, P, Math.round(cj + rr * Math.cos((a * Math.PI) / 180)), Math.round(ci + rr * Math.sin((a * Math.PI) / 180)), [255, 220, 40]);
  }
  fs.writeFileSync(path.join(outDir, `${name}-box.png`), encodePngRgb(rgb, P, P));
}
console.log(`\nwritten ${name}-boxes.png, ${name}-box.png to ${outDir}`);
