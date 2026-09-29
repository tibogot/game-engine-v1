/**
 * MOVE AN OASIS off a wadi's bank. A v3 lake is a flat water plane over a
 * rectangle: water shows wherever the ground inside it is below the level.
 * Ain el Oued's pool was carved INTO the Oued el Abiod's bank (its centre
 * 15 m from the channel's centreline, its radius 16 m) under a 51 m square,
 * so the dry bed filled with a flat green strip (you, 2026-09-29).
 *
 *   node tools/algOasisMove.mjs --from -120,330 --to -127,341 [--r 16] [--dry]
 *
 * 1. FILL the old basin back to the eroded ground (the map is 0.6 × the
 *    eroded save, fitted here), never inside the wadi's channel.
 * 2. Hand the old oasis paint (slot 3) back to the valley soil (slot 0).
 * 3. CARVE the new pool (algOasis.mjs's lobed basin), and fit the lake's
 *    rectangle TIGHT round the pool's own wet ground; if anything else inside
 *    it would sit under the water, the level drops below it.
 * 4. Update the site in games/alg-rts/layout.js.
 *
 * Then: tools/algOasisLook.mjs (the look), tools/algVegetation.mjs.
 */
import fs from "node:fs";
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { LAYOUT } from "../games/alg-rts/layout.js";

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const FILE = arg("file", "public/levels/alg-aures.v3proj");
const SAVE = arg("eroded", "public/levels/alg-aures.v3proj.bak");
const [FX, FZ] = arg("from").split(",").map(Number), [TX, TZ] = arg("to").split(",").map(Number);
const RAD = +arg("r", 16), DEPTH = 2.8, SEED = +arg("seed", 12);
const dry = args.includes("--dry");

const project = await readProject(FILE);
const man = project.manifest;
const { worldSize: W, heightmapSize: N, maxHeight: TOP } = man.terrain;
const hb = project.blobs.get("heightmap");
const hm = new Float32Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const cell = W / (N - 1);
const toX = (j) => j * cell - W / 2, toZ = (i) => i * cell - W / 2;
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const hash = (x, y) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(SEED, 1442695041); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
const vnoise = (x, y) => {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
};
/** Metres from the nearest wadi's centreline, and that wadi's half width. */
function wadiAt(x, z) {
  let best = { d: Infinity, hw: 6 };
  for (const w of LAYOUT.wadis) {
    const P = w.points;
    for (let i = 0; i < P.length - 1; i++) {
      const [ax, az] = P[i], [bx, bz] = P[i + 1], dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d < best.d) best = { d, hw: (w.width ?? 12) / 2 };
    }
  }
  return best;
}
const channel = (x, z) => { const w = wadiAt(x, z); return w.d < w.hw + 6; };   // bed + its cut banks

const lakes = man.lakes.lakes;
const old = lakes.find((l) => Math.hypot(l.cx - FX, l.cz - FZ) < 2);
if (!old) throw new Error(`no lake at ${FX},${FZ}`);
if (wadiAt(TX, TZ).d < RAD + wadiAt(TX, TZ).hw + 6) console.warn(`warning: the new centre is only ${wadiAt(TX, TZ).d.toFixed(0)} m from a wadi`);

// ── 1. Fill the old basin back to the eroded ground ─────────────────────────
const saveP = await readProject(SAVE);
const sb = saveP.blobs.get("heightmap");
const save = new Float32Array(sb.buffer.slice(sb.byteOffset, sb.byteOffset + sb.length)).map((v) => v * saveP.manifest.terrain.maxHeight);
let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  if (Math.max(Math.abs(toX(j)), Math.abs(toZ(i))) > W / 2 - 200) continue;
  const a = save[i * N + j], b = hm[i * N + j] * TOP;
  sx += a; sy += b; sxx += a * a; sxy += a * b; n++;
}
const S = (n * sxy - sx * sy) / (n * sxx - sx * sx), O = (sy - S * sx) / n;
const FILL_R = old.sizeX / 2 + 6;
let filled = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = toX(j), z = toZ(i), d = Math.hypot(x - FX, z - FZ);
  if (d > FILL_R || channel(x, z)) continue;
  const k = i * N + j, h = hm[k] * TOP, g = S * save[k] + O;
  const w = 1 - smooth((d - (FILL_R - 8)) / 8);
  if (g > h) { hm[k] = (h + (g - h) * w) / TOP; filled++; }
}
lakes.splice(lakes.indexOf(old), 1);

// ── 2. The old oasis paint back to the valley soil ──────────────────────────
const RES = man.splatRes, splat = project.blobs.get("splat"), off = RES * RES * 4;
let unpainted = 0;
for (let pz = 0; pz < RES; pz++) for (let px = 0; px < RES; px++) {
  const x = ((px + 0.5) / RES) * W - W / 2, z = ((pz + 0.5) / RES) * W - W / 2;
  if (Math.hypot(x - FX, z - FZ) > old.sizeX * 1.4) continue;
  const q = (pz * RES + px) * 4;
  if (!splat[q + 3]) continue;
  splat[q] = Math.min(255, splat[q] + splat[q + 3]); splat[q + 3] = 0; unpainted++;
}

// ── 3. Carve the new pool (algOasis.mjs's lobed basin) ──────────────────────
const lobes = [{ x: TX, z: TZ, r: RAD }];
for (let k = 0; k < 3; k++) {
  const a = hash(k, 3) * Math.PI * 2, d = RAD * (0.55 + hash(k, 5) * 0.35);
  lobes.push({ x: TX + Math.cos(a) * d, z: TZ + Math.sin(a) * d, r: RAD * (0.45 + hash(k, 7) * 0.3) });
}
const inPool = (x, z) => {
  const warp = (vnoise(x / 9, z / 9) - 0.5) * 0.5;
  let best = 0;
  for (const L of lobes) best = Math.max(best, 1 - Math.hypot(x - L.x, z - L.z) / (L.r * (1 + warp)));
  return best;
};
let gs = 0, gn = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (Math.hypot(toX(j) - TX, toZ(i) - TZ) < RAD * 1.5) { gs += hm[i * N + j] * TOP; gn++; }
const ground = gs / gn, floor = ground - DEPTH;
let cut = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = toX(j), z = toZ(i);
  if (Math.hypot(x - TX, z - TZ) > RAD * 2.2 || channel(x, z)) continue;
  const p = inPool(x, z), target = floor + (ground - floor) * (1 - smooth(p / 0.55));
  const k = i * N + j, h = hm[k] * TOP, w = smooth((p + 0.35) / 0.35);
  const nh = h + (Math.min(h, target) - h) * w;
  if (nh < h - 0.01) cut++;
  hm[k] = nh / TOP;
}
project.blobs.set("heightmap", Buffer.from(hm.buffer));

// ── The lake: tight round the pool; nothing else under its level ───────────
let level = floor + DEPTH * 0.55;
let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = toX(j), z = toZ(i);
  if (Math.hypot(x - TX, z - TZ) > RAD * 2.2 || inPool(x, z) <= 0) continue;
  if (hm[i * N + j] * TOP < level) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
}
x0 -= 2; x1 += 2; z0 -= 2; z1 += 2;
let stray = Infinity;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const x = toX(j), z = toZ(i);
  if (x < x0 || x > x1 || z < z0 || z > z1 || inPool(x, z) > 0) continue;
  stray = Math.min(stray, hm[i * N + j] * TOP);
}
if (stray < level + 0.2) level = stray - 0.2;
const lake = { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, sizeX: x1 - x0, sizeZ: z1 - z0, level };
lakes.push(lake);

// ── 4. The site in layout.js ────────────────────────────────────────────────
const site = LAYOUT.sites.find((s) => s.kind === "oasis" && Math.hypot(s.x - FX, s.z - FZ) < 3);
if (site && !dry) {
  const f = "games/alg-rts/layout.js";
  const src = fs.readFileSync(f, "utf8");
  const re = new RegExp(`(name: "${site.name}", x: )${site.x}(, z: )${site.z}`);
  if (!re.test(src)) throw new Error(`layout.js: site ${site.name} not found as written`);
  fs.writeFileSync(f, src.replace(re, `$1${TX}$2${TZ}`));
}

console.log(`fit: map = ${S.toFixed(4)} × eroded save ${O >= 0 ? "+" : "−"} ${Math.abs(O).toFixed(2)}; old basin filled (${filled} texels), ${unpainted} paint texels back to soil`);
console.log(`new pool at (${TX}, ${TZ}) r ${RAD}: ground ${ground.toFixed(2)}, floor ${floor.toFixed(2)}, ${cut} texels cut; lake ${lake.sizeX.toFixed(0)} × ${lake.sizeZ.toFixed(0)} m at level ${level.toFixed(2)}${stray < Infinity ? ` (lowest other ground in it ${stray.toFixed(2)})` : ""}; site ${site?.name ?? "—"} moved`);
if (!dry) { await writeProject(FILE, project); console.log(`wrote ${FILE}`); }
