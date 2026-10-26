// Builds public/levels/fog-lab.v3proj — the fog lab's own terrain: rolling hills round a winding
// valley, a higher rim so the fog has somewhere to pool, and tree groves on the slopes.
// Starts from the near-empty alg-base level (its Sky Pro look, tree slots, ground) and replaces
// the heightmap and the trees; alg-base itself is only read. Open the result in the editor to
// paint or sculpt it further.
//
//   node v3/fog-lab/makeFogLabLevel.mjs

import { readProject, writeProject } from "../../tools/lib/v3proj.mjs";

const SRC = new URL("../../public/levels/alg-base.v3proj", import.meta.url);
const OUT = new URL("../../public/levels/fog-lab.v3proj", import.meta.url);

const { manifest, blobs } = await readProject(SRC);
const { worldSize: S, heightmapSize: N } = manifest.terrain;
const MAX_H = 200;
manifest.terrain.maxHeight = MAX_H;

// ---- noise
function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t) => t * t * (3 - 2 * t);
function value2(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = smooth(x - ix), ty = smooth(y - iy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
function fbm(x, y, oct, seed) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += value2(x * f, y * f, seed + i) * a; n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- the valley: a meandering centre line across the map (x as a function of z)
const valleyX = (z) => 90 * Math.sin(z / 170) + 45 * Math.sin(z / 61 + 1.3);

// heights in metres
function heightAt(x, z) {
  const d = Math.abs(x - valleyX(z));
  const hills = fbm(x / 210 + 10, z / 210 + 3, 5, 11);      // 0..1, broad
  const bumps = fbm(x / 55 + 5, z / 55 + 9, 4, 41);          // 0..1, small
  const floor = 14 + 6 * fbm(x / 120, z / 120, 3, 71);       // the valley floor
  const sides = ss(25, 230, d);                              // 0 in the valley .. 1 on the hills
  let h = floor + sides * (40 + 85 * hills) + (bumps - 0.5) * 14 * (0.4 + sides);
  // side valleys: two shallow troughs running into the main one
  for (const [cz, ang] of [[-180, 0.6], [200, -0.5]]) {
    const ux = Math.cos(ang), uz = Math.sin(ang);
    const px = x - valleyX(cz), pz = z - cz;
    const along = px * ux + pz * uz, across = Math.abs(-px * uz + pz * ux);
    if (along > 0) h -= 38 * (1 - ss(20, 90, across)) * ss(0, 60, along) * sides;
  }
  // the rim: higher ground at the map's edge closes the view in
  const r = Math.max(Math.abs(x), Math.abs(z)) / (S * 0.5);
  h += 45 * ss(0.72, 1.0, r) * (0.6 + 0.4 * hills);
  return Math.min(MAX_H - 1, Math.max(1, h));
}

const hm = new Float32Array(N * N);
const cell = S / N;
for (let j = 0; j < N; j++) {
  const z = -S / 2 + (j + 0.5) * cell;
  for (let i = 0; i < N; i++) {
    const x = -S / 2 + (i + 0.5) * cell;
    hm[j * N + i] = heightAt(x, z) / MAX_H;
  }
}
blobs.set("heightmap", Buffer.from(hm.buffer));
// no ground paint: the terrain shows the grid; the soil layer stays defined (the lab can fill it)
blobs.set("splat", Buffer.alloc(blobs.get("splat").length));

// ---- trees: groves, thick on the slopes, sparse on the valley floor and the steep rim
let seed = 20261024;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const slope = (x, z) => {
  const e = 2;
  const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return Math.hypot(dx, dz);
};
const instances = [];
const half = S * 0.46;
for (let g = 0; g < 160; g++) {
  const cx = (rnd() * 2 - 1) * half, cz = (rnd() * 2 - 1) * half;
  const d = Math.abs(cx - valleyX(cz));
  const keep = d < 30 ? 0.25 : 1;
  if (rnd() > keep) continue;
  const r = 10 + rnd() * 32, count = 6 + Math.floor(rnd() * 34);
  for (let k = 0; k < count; k++) {
    const a = rnd() * Math.PI * 2, dist = Math.sqrt(rnd()) * r;
    const x = cx + Math.cos(a) * dist, z = cz + Math.sin(a) * dist;
    if (Math.abs(x) > S * 0.49 || Math.abs(z) > S * 0.49 || slope(x, z) > 0.7) continue;
    instances.push([+x.toFixed(2), +z.toFixed(2), +heightAt(x, z).toFixed(2), +(rnd() * Math.PI * 2).toFixed(3), +(0.8 + rnd() * 0.6).toFixed(2), 0]);
  }
}
// a few lone trees between the groves
for (let k = 0; k < 400; k++) {
  const x = (rnd() * 2 - 1) * half, z = (rnd() * 2 - 1) * half;
  if (slope(x, z) > 0.6) continue;
  instances.push([+x.toFixed(2), +z.toFixed(2), +heightAt(x, z).toFixed(2), +(rnd() * Math.PI * 2).toFixed(3), +(0.8 + rnd() * 0.6).toFixed(2), 0]);
}
// slot 0 = the broadleaf preset the city game uses (loaded from public/tree-presets/ on open)
const slots = manifest.trees.slots.map((s, i) => (i === 0 ? { ...s, presetFile: "tree110.json", presetRef: null } : s));
manifest.trees = { ...manifest.trees, slots, instances };

await writeProject(OUT, { manifest, blobs });
let lo = Infinity, hi = -Infinity;
for (const v of hm) { lo = Math.min(lo, v * MAX_H); hi = Math.max(hi, v * MAX_H); }
console.log(`fog-lab.v3proj: ${S} m, heights ${lo.toFixed(1)}–${hi.toFixed(1)} m, ${instances.length} trees`);
