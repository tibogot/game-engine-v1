// WHERE DOES THE CITY PUT TWO SURFACES IN THE SAME PLANE?
//
// Stacked boxes do it for free: a tier's TOP face and the next tier's BOTTOM
// face are both at the setback height, and every parapet ring box rests its
// bottom face on the roof it stands on. Two coplanar faces with nothing to
// separate them is z-fighting — the depth values are equal to the bit, so which
// one wins is down to rasterisation order and it changes as the camera moves.
//
// three.js's own city generator designs this out explicitly, with the note that
// parts are placed "so they never sit coplanar with the walls, spandrels or
// piers and z-fight".
//
// Counts pairs of opposite-facing horizontal faces sharing a plane whose XZ
// footprints overlap. Bounding-box overlap, not exact polygon overlap, so this
// is an over-estimate by design: it is a leak detector, and a false positive
// costs a look while a false negative costs a shipped artifact.
//
//   node tools/cityCoplanarProbe.mjs
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
await import("three/webgpu");
const { buildCityKit } = await import("../games/modular-road-v3/modularRoadCityKit.js");

const kit = buildCityKit({ seed: 20260902 });

/** Horizontal faces of one geometry, as {sign, y, minX, maxX, minZ, maxZ}. */
function horizontalFaces(g) {
  const pos = g.attributes.position, nrm = g.attributes.normal, idx = g.index;
  const count = idx ? idx.count : pos.count;
  const out = [];
  for (let t = 0; t + 2 < count; t += 3) {
    const v = [0, 1, 2].map((k) => (idx ? idx.getX(t + k) : t + k));
    const ny = nrm.getY(v[0]);
    if (Math.abs(ny) < 0.9) continue;
    const xs = v.map((i) => pos.getX(i)), zs = v.map((i) => pos.getZ(i));
    out.push({
      sign: Math.sign(ny),
      y: pos.getY(v[0]),
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minZ: Math.min(...zs), maxZ: Math.max(...zs),
    });
  }
  return out;
}

const overlaps = (a, b) =>
  a.minX < b.maxX - 1e-4 && b.minX < a.maxX - 1e-4 &&
  a.minZ < b.maxZ - 1e-4 && b.minZ < a.maxZ - 1e-4;

let total = 0;
const perArch = [];
for (const a of kit.archetypes) {
  const faces = horizontalFaces(a.lods[0]);
  // Bucket by plane height, then look for a +Y and a -Y face that overlap.
  const planes = new Map();
  for (const f of faces) {
    const key = f.y.toFixed(4);
    if (!planes.has(key)) planes.set(key, []);
    planes.get(key).push(f);
  }
  let n = 0;
  for (const group of planes.values()) {
    const up = group.filter((f) => f.sign > 0);
    const down = group.filter((f) => f.sign < 0);
    for (const u of up) for (const w of down) if (overlaps(u, w)) {
      n++;
      if (process.env.DETAIL && n <= 2) {
        console.log(`    plane y=${u.y.toFixed(2)}  up ${(u.maxX - u.minX).toFixed(2)}x${(u.maxZ - u.minZ).toFixed(2)} @${u.minX.toFixed(2)},${u.minZ.toFixed(2)}` +
          `   down ${(w.maxX - w.minX).toFixed(2)}x${(w.maxZ - w.minZ).toFixed(2)} @${w.minX.toFixed(2)},${w.minZ.toFixed(2)}`);
      }
    }
  }
  total += n;
  perArch.push({ tris: a.lods[0].index ? a.lods[0].index.count / 3 : 0, n });
}

console.log(`COPLANAR OPPOSED HORIZONTAL PAIRS, L0, ${kit.archetypes.length} archetypes`);
perArch.forEach((r, i) => {
  if (r.n) console.log(`  arch ${String(i).padStart(2)}  ${String(r.n).padStart(4)} pairs   (${r.tris} tris)`);
});
console.log(`  ── ${total} pairs total, ${perArch.filter((r) => r.n).length} of ${perArch.length} archetypes affected`);
