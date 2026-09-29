/**
 * THE FAR MOUNTAINS — the REAL Aurès round the Aurès map, from the same
 * elevation data the map was cut from (tools/algDem.mjs, "aures-tighanimine"),
 * so what rises round the battlefield is the country that really surrounds
 * it (you, 2026-09-29: "we took that terrain from satellite, the mountains
 * round it should be coherent").
 *
 *   node tools/algMountains.mjs --in <map before> --out public/levels/alg-aures.v3proj [--dry]
 *
 * Reads `--in`, writes `--out` (as algShapeMap: re-running starts from the
 * same ground, it never compounds). Keep the map from before as `--in`
 * (public/levels/alg-aures.pre-mountains.v3proj.bak).
 *
 * 1. FIT. The map's own transform (real metres → map metres: ×0.256 for 4 km
 *    in 1024 m, ×0.6 relief, an offset; then eroded) is FITTED, least
 *    squares, on the untouched middle of `--in` against the real ground
 *    sampled exactly as algDem did (zoom 13, 3 × 3 px box blur).
 * 2. THE RING. Between the PLAY box and the edge, the ground rises back to
 *    the real ground under that transform — the border fade (algShapeMap)
 *    had flattened it to 0. Nothing changes inside the PLAY box and its
 *    first 25 m; full 180 m out (the nearest edge is 187 m out). Only ever
 *    RAISES. Our wadis run out through gaps (farMountains.js valleyFactor).
 * 3. THE FAR GRID. The same ground over ±3.9 km of map (~30 km of country),
 *    1024², written INTO the project (blob "farHeight" + manifest.farTerrain)
 *    for the engine's far terrain (v3/terrain/farTerrain.js).
 *
 * PAINT: the raised ground gets algPaint.mjs's rule (soil / pale limestone
 * above the high band / scree / cliff strata by slope), blended in by how
 * much it rose — the wadi beds, tracks and oases keep their paint. The high
 * band is PINNED to the battlefield's (p80/p95 before the mountains).
 *
 * Re-run tools/algVegetation.mjs after (its bands are pinned too).
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { NAV_MAX_SLOPE_DEG } from "./lib/rtsMapMetrics.mjs";
import { sampleSite } from "./lib/terrarium.mjs";
import { PLAY } from "../games/alg-rts/layout.js";
import { FAR, valleyFactor } from "../games/alg-rts/farMountains.js";

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const IN = arg("in"), OUT = arg("out");
const dry = args.includes("--dry");
if (!IN || !OUT) throw new Error("usage: --in <map before> --out <map> [--dry]");
const SITE = { lat: 35.215, lon: 6.300, span: 4 };   // algDem.mjs "aures-tighanimine"
const NEAR = 25, RISE = 155;                        // untouched margin, rise distance (m)
const HIGH0 = 45.058850198984146, HIGH1 = 75.22545754909515;   // algPaint's band, pinned (p80/p95 before)

const project = await readProject(IN);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const cell = W / (N - 1);
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const outside = (x, z) => Math.hypot(Math.max(PLAY.x0 - x, 0, x - PLAY.x1), Math.max(PLAY.z0 - z, 0, z - PLAY.z1));

/** algDem's smoothing: a separable box, radius R, 3 passes. */
function blur(h, n, R) {
  const tmp = new Float32Array(n * n);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let s = 0, c = 0;
      for (let d = -R; d <= R; d++) { const jj = j + d; if (jj >= 0 && jj < n) { s += h[i * n + jj]; c++; } }
      tmp[i * n + j] = s / c;
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let s = 0, c = 0;
      for (let d = -R; d <= R; d++) { const ii = i + d; if (ii >= 0 && ii < n) { s += tmp[ii * n + j]; c++; } }
      h[i * n + j] = s / c;
    }
  }
  return h;
}

// ── 1. Your eroded save, and the real ground in its units ─────────────────
// The map is exactly 0.6 × the ERODED SAVE (the Tighanimine DEM after your
// Stream Power run, before the relief scale and the border fade: measured
// 0.6019 ×, rms 0.64 m — the wadis and oases since). So the ring takes that
// save back: your own eroded ground, not an imitation of it.
const SAVE = arg("eroded", "public/levels/alg-aures.v3proj.bak");
const saveP = await readProject(SAVE);
const sb = saveP.blobs.get("heightmap");
const save = new Float32Array(sb.buffer.slice(sb.byteOffset, sb.byteOffset + sb.length)).map((v) => v * saveP.manifest.terrain.maxHeight);
const middle = (i, j) => Math.max(Math.abs(j * cell - W / 2), Math.abs(i * cell - W / 2)) <= W / 2 - 200;
function fit(xs, ys) {
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (!middle(i, j)) continue;
    const a = xs[i * N + j], b = ys[i * N + j];
    sx += a; sy += b; sxx += a * a; sxy += a * b; n++;
  }
  const s = (n * sxy - sx * sy) / (n * sxx - sx * sx), o = (sy - s * sx) / n;
  let e = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (middle(i, j)) e += (s * xs[i * N + j] + o - ys[i * N + j]) ** 2;
  return { s, o, rms: Math.sqrt(e / n) };
}
const mapM = hm.map((v) => v * TOP);
const S = fit(save, mapM);
console.log(`map = ${S.s.toFixed(4)} × eroded save ${S.o >= 0 ? "+" : "−"} ${Math.abs(S.o).toFixed(2)} m, rms ${S.rms.toFixed(2)} m`);
const real = blur(await sampleSite(SITE, N, 13), N, 3);
const R = fit(real, save);
console.log(`eroded save = ${R.s.toFixed(4)} × real ${R.o >= 0 ? "+" : "−"} ${Math.abs(R.o).toFixed(1)} m, rms ${R.rms.toFixed(1)} m (the erosion's own changes)`);
const saveToMap = (v) => Math.max(0, S.s * v + S.o);

// ── 2. Raise the ring back to the eroded ground ───────────────────────────
const target = (k, x, z) => Math.min(TOP - 1, saveToMap(save[k]) * valleyFactor(x, z));
const riseOf = new Float32Array(N * N);   // 0..1, how far toward it (paint blend)
let raised = 0, maxH = 0;
for (let i = 0; i < N; i++) {
  const z = i * cell - W / 2;
  for (let j = 0; j < N; j++) {
    const x = j * cell - W / 2, k = i * N + j;
    const r = smooth((outside(x, z) - NEAR) / RISE);
    if (r <= 0) continue;
    const old = hm[k] * TOP, m = target(k, x, z);
    const h = Math.max(old, old + (m - old) * r);
    if (h > old + 0.01) { hm[k] = h / TOP; raised++; riseOf[k] = r * smooth((h - old) / 6); }
    maxH = Math.max(maxH, h);
  }
}

// ── 3. The far grid: the real country round the map ───────────────────────
// In map metres by the two fits above (real → save → map). NOT eroded: the
// Stream Power run on this coarser grid (7.6 m cells) left staircase terraces
// and blocky steps, seen from above (you: "really ugly" — dropped).
// Written INTO the project (blob "farHeight" + manifest.farTerrain): the
// engine's terrain draws it past the heightmap (v3/terrain/farTerrain.js), in
// the editor and every game, with the map's own layers — the wadis' gaps baked
// in (the shader reads the grid as it is).
{
  const spanKm = ((2 * FAR.extent) / W) * SITE.span;
  const far = await sampleSite({ ...SITE, span: spanKm }, FAR.n, 12);
  const fcell = (2 * FAR.extent) / (FAR.n - 1);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < FAR.n; i++) for (let j = 0; j < FAR.n; j++) {
    const k = i * FAR.n + j;
    far[k] = saveToMap(Math.max(0, R.s * far[k] + R.o)) * valleyFactor(j * fcell - FAR.extent, i * fcell - FAR.extent);
    lo = Math.min(lo, far[k]); hi = Math.max(hi, far[k]);
  }
  console.log(`far grid: ${FAR.n}² over ±${FAR.extent} m of map (${spanKm.toFixed(1)} km of country), ${lo.toFixed(0)}–${hi.toFixed(0)} map m`);
  project.blobs.set("farHeight", Buffer.from(far.buffer));
  // The rule's slope bands, judged in the game: at 8-16 / 20-30 deg the cliff
  // layer took nearly every far slope and its strata read as stripes; the
  // paint tool's own bands (13-22 / 34-42) lowered a little, since out there
  // a slope comes from vertices 16-32 m apart.
  man.farTerrain = {
    enabled: true, n: FAR.n, extent: FAR.extent,
    stand: 2.5, standStart: 100, standEnd: 1500, blend: 250,
    rule: { flatSlot: 0, highSlot: 1, screeSlot: 2, cliffSlot: 5, screeLo: 12, screeHi: 22, cliffLo: 30, cliffHi: 40, highLo: HIGH0, highHi: HIGH1 },
  };
}
// ── Erode the ring (droplets, optional: --drops N) ─────────────────────────
// Rain on the raised ring: each drop runs downhill, picks up soil where it
// speeds up and drops it where it slows (particle erosion). Masked: nothing
// changes where the ring did not rise (the battlefield), fading out over the
// last 24 m before the edge. Off by default since the ring is REAL ground
// (its own gullies); made for the first, noise-built mountains.
const DROPS = +(arg("drops", 0));
{
  const hmM = new Float32Array(N * N);
  for (let k = 0; k < N * N; k++) hmM[k] = hm[k] * TOP;
  const edgeFade = (i, j) => smooth(Math.min(i, j, N - 1 - i, N - 1 - j) * cell / 24 - 0.1);
  const mask = new Float32Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const k = i * N + j; mask[k] = riseOf[k] > 0 ? smooth(riseOf[k] * 1.5) * edgeFade(i, j) : 0; }
  let s = 777; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const P = { inertia: 0.05, capacity: 4, minSlope: 0.01, deposit: 0.3, erode: 0.3, evaporate: 0.02, gravity: 4, life: 40, radius: 3 };
  // Height and gradient at a real position (grid units), bilinear.
  const hg = (x, y) => {
    const xi = x | 0, yi = y | 0, u = x - xi, v = y - yi, k = yi * N + xi;
    const a = hmM[k], b = hmM[k + 1], c = hmM[k + N], d = hmM[k + N + 1];
    return { h: a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v, gx: (b - a) * (1 - v) + (d - c) * v, gy: (c - a) * (1 - u) + (d - b) * u };
  };
  // Erosion brush (radius 3 texels), weights normalised.
  const brush = [];
  let wsum = 0;
  for (let dy = -P.radius; dy <= P.radius; dy++) for (let dx = -P.radius; dx <= P.radius; dx++) {
    const w = Math.max(0, P.radius - Math.hypot(dx, dy));
    if (w > 0) { brush.push([dx, dy, w]); wsum += w; }
  }
  for (const b of brush) b[2] /= wsum;
  let dropsRun = 0;
  for (let n = 0; n < DROPS * 4 && dropsRun < DROPS; n++) {
    let x = 4 + rnd() * (N - 9), y = 4 + rnd() * (N - 9);
    if (mask[(y | 0) * N + (x | 0)] < 0.2) continue;
    dropsRun++;
    let dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
    for (let t = 0; t < P.life; t++) {
      const xi = x | 0, yi = y | 0, k0 = yi * N + xi;
      const g = hg(x, y);
      dx = dx * P.inertia - g.gx * (1 - P.inertia);
      dy = dy * P.inertia - g.gy * (1 - P.inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      dx /= len; dy /= len;
      const nx = x + dx, ny = y + dy;
      if (nx < 4 || ny < 4 || nx > N - 5 || ny > N - 5 || mask[(ny | 0) * N + (nx | 0)] <= 0) break;
      const dh = hg(nx, ny).h - g.h;
      const cap = Math.max(-dh, P.minSlope) * speed * water * P.capacity;
      const m = mask[k0];
      if (sed > cap || dh > 0) {
        // Deposit (fill the pit if climbing, else a share of the excess).
        const amt = (dh > 0 ? Math.min(dh, sed) : (sed - cap) * P.deposit) * m;
        const u = x - xi, v = y - yi;
        hmM[k0] += amt * (1 - u) * (1 - v); hmM[k0 + 1] += amt * u * (1 - v);
        hmM[k0 + N] += amt * (1 - u) * v; hmM[k0 + N + 1] += amt * u * v;
        sed -= amt;
      } else {
        const amt = Math.min((cap - sed) * P.erode, -dh) * m;
        for (const [bx, by, w] of brush) {
          const kk = (yi + by) * N + (xi + bx);
          const take = Math.min(hmM[kk], amt * w * mask[kk]);
          hmM[kk] -= take; sed += take;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * P.gravity));
      water *= 1 - P.evaporate;
      x = nx; y = ny;
    }
  }
  let moved = 0;
  for (let k = 0; k < N * N; k++) { const h = Math.max(0, Math.min(TOP, hmM[k])); moved = Math.max(moved, Math.abs(h - hm[k] * TOP)); hm[k] = h / TOP; }
  console.log(`erosion: ${dropsRun} drops on the ring, deepest change ${moved.toFixed(1)} m`);
}
project.blobs.set("heightmap", Buffer.from(hm.buffer));

// ── Paint the raised ground (algPaint.mjs's rule) ──────────────────────────
const RES = man.splatRes;
const splat = project.blobs.get("splat");
const off = RES * RES * 4;
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, (x + W / 2) / cell)), fv = Math.max(0, Math.min(N - 1.001, (z + W / 2) / cell));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hm[y0 * N + x0], b = hm[y0 * N + x0 + 1], c = hm[(y0 + 1) * N + x0], d = hm[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const hash = (x, y) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(3, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};
const sm = (e0, e1, v) => smooth((v - e0) / (e1 - e0));
let painted = 0;
const share = [0, 0, 0, 0];
for (let pz = 0; pz < RES; pz++) {
  for (let px = 0; px < RES; px++) {
    const j = Math.round(((px + 0.5) / RES) * (N - 1)), i = Math.round(((pz + 0.5) / RES) * (N - 1));
    const b = riseOf[i * N + j];
    if (b <= 0.01) continue;
    const x = ((px + 0.5) / RES) * W - W / 2, z = ((pz + 0.5) / RES) * W - W / 2, e = 1.5;
    const gx = (H(x + e, z) - H(x - e, z)) / (2 * e), gz = (H(x, z + e) - H(x, z - e)) / (2 * e);
    const slope = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI, h = H(x, z);
    const n = (vnoise(x / 40, z / 40) * 0.65 + vnoise(x / 12 + 9, z / 12 + 5) * 0.35) * 2 - 1;
    const cliff = sm(NAV_MAX_SLOPE_DEG, NAV_MAX_SLOPE_DEG + 8, slope + n * 3);
    const scree = sm(13, 22, slope + n * 5) * (1 - cliff);
    const rest = 1 - cliff - scree;
    const ridge = sm(HIGH0, HIGH1, h + n * 8) * rest;
    const soil = rest - ridge;
    // slots 0 soil, 1 ridge, 2 scree, 5 cliff; the rest fade out by b.
    const want = [soil, ridge, scree, 0, 0, cliff, 0];
    const q = (pz * RES + px) * 4;
    for (let c = 0; c < 7; c++) {
      const idx = c < 4 ? q + c : off + q + c - 4;
      splat[idx] = Math.round(splat[idx] * (1 - b) + want[c] * 255 * b);
    }
    share[0] += soil * b; share[1] += ridge * b; share[2] += scree * b; share[3] += cliff * b;
    painted++;
  }
}

const tot = share.reduce((a, v) => a + v, 0) || 1;
console.log(`${raised} heightmap texels raised (${((100 * raised) / (N * N)).toFixed(1)}%), highest ${maxH.toFixed(0)} m; ${painted} splat texels repainted: soil ${((100 * share[0]) / tot).toFixed(0)}% limestone ${((100 * share[1]) / tot).toFixed(0)}% scree ${((100 * share[2]) / tot).toFixed(0)}% cliff ${((100 * share[3]) / tot).toFixed(0)}%`);
// The edge: the ring must BE the real ground there (the backdrop blends from it).
let worst = 0;
for (let t = 0; t < N; t += 8) {
  for (const [i, j] of [[0, t], [N - 1, t], [t, 0], [t, N - 1]]) {
    const x = j * cell - W / 2, z = i * cell - W / 2;
    worst = Math.max(worst, Math.abs(hm[i * N + j] * TOP - target(i * N + j, x, z)));
  }
}
console.log(`edge vs the eroded ground: worst ${worst.toFixed(2)} m`);
if (!dry) { await writeProject(OUT, project); console.log(`wrote ${OUT}`); }
