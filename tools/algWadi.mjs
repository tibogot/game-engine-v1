/**
 * WADIS — dry riverbeds carved across an Algeria map's valley, from the
 * layout (games/alg-rts/layout.js `wadis`). The valley was one open plain,
 * 99-100% walkable: nothing to hold, nothing to cross. A wadi is a corridor
 * with STEEP banks — past the 34° nav limit, so units cannot climb them —
 * except at a few FORDS, where the banks ease to a ramp. Those fords are the
 * chokepoints.
 *
 *   node tools/algWadi.mjs [--file public/levels/alg-aures.v3proj] [--dry]
 *
 * The bed runs DOWNHILL all the way (water made it): the ground is sampled
 * along the route, the profile forced monotone, and the bed cut `depth` under
 * it. Only ever CUTS — the ground outside a wadi's banks is untouched. Paint:
 * slot 4 "Wadi bed" (rocky_trail, Poly Haven CC0) on the bed, easing
 * out over the lower banks.
 *
 * Run it on a map that has NOT had these wadis carved (it cuts again each
 * run): keep a copy of the map before, as the other alg tools do.
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { NAV_MAX_SLOPE_DEG } from "./lib/rtsMapMetrics.mjs";
import { LAYOUT } from "../games/alg-rts/layout.js";

const args = process.argv.slice(2);
const FILE = args.includes("--file") ? args[args.indexOf("--file") + 1] : "public/levels/alg-aures.v3proj";
const dry = args.includes("--dry");
const SLOT = 4;
const BANK_DEG = 42;       // a cut bank: steeper than the nav limit
const FORD_DEG = 16;       // a ford's ramp: an easy walk
const FORD_LEN = 14;       // metres of bank eased either side of a ford's centre

const project = await readProject(FILE);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const cell = W / (N - 1);
const H = (x, z) => {
  const fu = Math.max(0, Math.min(N - 1.001, (x + W / 2) / cell)), fv = Math.max(0, Math.min(N - 1.001, (z + W / 2) / cell));
  const x0 = fu | 0, y0 = fv | 0, tx = fu - x0, ty = fv - y0;
  const a = hm[y0 * N + x0], b = hm[y0 * N + x0 + 1], c = hm[(y0 + 1) * N + x0], d = hm[(y0 + 1) * N + x0 + 1];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * TOP;
};
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Catmull-Rom through the route, resampled every `step` metres. */
function resample(pts, step = 2) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const report = [];
const bedMask = new Float32Array(N * N);   // 1 on the bed, easing over the lower banks

for (const w of LAYOUT.wadis) {
  const path = resample(w.points);
  // Arc length, and the bed profile: the ground along the route, smoothed,
  // forced downhill (a running minimum), cut `depth` under it.
  const s = [0];
  for (let i = 1; i < path.length; i++) s.push(s[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const total = s[s.length - 1];
  const ground = path.map(([x, z]) => H(x, z));
  const sm = ground.map((_, i) => { let a = 0, n = 0; for (let k = -6; k <= 6; k++) { const j = i + k; if (j >= 0 && j < ground.length) { a += ground[j]; n++; } } return a / n; });
  const bed = [];
  let run = Infinity;
  // Never under 0.3 m: past the map's edge the plain is at 0, and a bed
  // below it would open a step at the border.
  for (const g of sm) { run = Math.min(run, g); bed.push(Math.max(0.3, run - w.depth)); }
  const fordS = w.fords.map((f) => f * total);
  const half = w.width / 2;
  const bankRun = (deg) => w.depth * 1.6 / Math.tan((deg * Math.PI) / 180);   // bank width for the tallest cut
  const reach = half + bankRun(FORD_DEG) + 2;

  // Carve: every texel near the route takes its nearest point on it.
  let cut = 0;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of path) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const j0 = Math.max(0, Math.floor((x0 - reach + W / 2) / cell)), j1 = Math.min(N - 1, Math.ceil((x1 + reach + W / 2) / cell));
  const i0 = Math.max(0, Math.floor((z0 - reach + W / 2) / cell)), i1 = Math.min(N - 1, Math.ceil((z1 + reach + W / 2) / cell));
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const x = j * cell - W / 2, z = i * cell - W / 2;
    let best = Infinity, bi = 0;
    for (let k = 0; k < path.length; k += 1) {
      const d = (x - path[k][0]) ** 2 + (z - path[k][1]) ** 2;
      if (d < best) { best = d; bi = k; }
    }
    const d = Math.sqrt(best);
    if (d > reach) continue;
    // A ford eases the bank over FORD_LEN either side of its centre.
    let ford = 0;
    for (const fs of fordS) ford = Math.max(ford, 1 - smooth((Math.abs(s[bi] - fs) - FORD_LEN * 0.5) / FORD_LEN));
    const deg = BANK_DEG + (FORD_DEG - BANK_DEG) * ford;
    const k = i * N + j, h = hm[k] * TOP;
    const bedY = bed[bi];
    const bank = Math.max(0.5, (h - bedY) / Math.tan((deg * Math.PI) / 180));
    // The bed's edge wanders a little, so the wadi is not a machined channel.
    const wob = (Math.sin(s[bi] * 0.09) * 0.5 + Math.sin(s[bi] * 0.23 + 1.3) * 0.35) * 1.4;
    const e = d - (half + wob);
    const target = e <= 0 ? bedY : bedY + (h - bedY) * Math.min(1, e / bank);
    if (target < h - 0.01) {
      hm[k] = target / TOP;
      cut++;
    }
    bedMask[k] = Math.max(bedMask[k], 1 - smooth((e - 0.5 * bank * 0.3) / Math.max(1, bank * 0.5)));
  }
  report.push({ name: w.name, length: total, fall: ground[0] - ground[ground.length - 1], bedTop: bed[0], bedEnd: bed[bed.length - 1], cut });
}
project.blobs.set("heightmap", Buffer.from(hm.buffer));

// ── Paint the bed ───────────────────────────────────────────────────────────
const tex = (id) => {
  const f = (m) => ({ name: `${id}_${m}_1k.jpg`, url: `/textures/ground/${id}/${id}_${m}_1k.jpg` });
  return { albedo: f("diff"), normal: f("nor_gl"), rough: f("rough"), ao: f("ao") };
};
man.paintLayers[SLOT] = {
  // rocky_trail (2026-09-30): fine gravel in sand. dry_river_pebbles was big
  // painted cobbles, "fakes stones" (you). A ~4 m tile.
  name: "Wadi bed", ...tex("rocky_trail"),
  uvScale: 256, normalStr: 1, aoStr: 0.8, roughStr: 1, triplanar: false, tint: "#f4ece0",
  uvRotation: 0, contourAlign: 0, rockShade: 0, procedural: null, blocksGrass: false, blocksTrees: true,
  auto: { enabled: false, heightMin: 0, heightMax: 500, slopeMin: 0, slopeMax: 90, blend: 15, strength: 1 },
};
const RES = man.splatRes;
const splat = project.blobs.get("splat");
const off = RES * RES * 4;
let painted = 0;
for (let pz = 0; pz < RES; pz++) for (let px = 0; px < RES; px++) {
  const j = Math.round(((px + 0.5) / RES) * (N - 1)), i = Math.round(((pz + 0.5) / RES) * (N - 1));
  const w = bedMask[i * N + j];
  if (w <= 0.004) continue;
  const q = (pz * RES + px) * 4, keep = 1 - w;
  for (let c = 0; c < 4; c++) splat[q + c] = Math.round(splat[q + c] * keep);
  for (let c = 0; c < 3; c++) splat[off + q + c] = Math.round(splat[off + q + c] * keep);
  splat[off + q + (SLOT - 4)] = Math.min(255, splat[off + q + (SLOT - 4)] + Math.round(w * 255));
  painted++;
}

for (const r of report) console.log(`${r.name}: ${r.length.toFixed(0)} m, ground falls ${r.fall.toFixed(1)} m, bed ${r.bedTop.toFixed(1)} -> ${r.bedEnd.toFixed(1)} m, ${r.cut} texels cut`);
console.log(`bank ${BANK_DEG} deg (nav limit ${NAV_MAX_SLOPE_DEG}), fords ${FORD_DEG} deg; ${painted} splat texels painted`);
if (!dry) { await writeProject(FILE, project); console.log(`wrote ${FILE}`); }
