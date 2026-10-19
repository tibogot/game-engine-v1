// PAINTED GROUND MARKINGS (2026-10-19, alg-rts's helipad — you: "the H mark on the ground … a simple decal,
// maybe the animation is the way it sprays it on the ground"). Lime ribbons laid on a kit's own surface
// (they follow its height function: a decal baked into the ground cache would sit UNDER the pad's raised
// deck), each vertex carrying its place in the painting order (`paintS`, 0..1 over every stroke in turn).
// The material shows what is painted up to `progress` — the front ragged, a wet darker band just behind it,
// the borders brushed — so a construction can paint it on along the stroke. One draw; receives shadows,
// casts none; lifted off the surface and polygon-offset (no z-fight).
import * as THREE from "three";
import { abs, attribute, float, mix, mx_noise_float, smoothstep, uniform, uv, vec3 } from "three/tsl";

/**
 * Ribbons along polylines, in painting order.
 * @param {{pts: [number, number][], w: number}[]} strokes   kit-local x, z; width w (m)
 * @param {{height: (x, z) => number, seed?: number, step?: number}} o   the surface's height + the lift
 * @returns {{geo: THREE.BufferGeometry, path: number[][], length: number}}  path: [x, y, z, s] — where
 *   the painter is at each s (a construction walks a man along it)
 */
export function paintStrokes(strokes, { height, seed = 1, step = 0.2 }) {
  // Resample every stroke to `step`, its points' distance along the whole painting.
  const runs = [];
  let total = 0;
  for (const st of strokes) {
    const pts = [];
    for (let i = 0; i < st.pts.length - 1; i++) {
      const [x0, z0] = st.pts[i], [x1, z1] = st.pts[i + 1], len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.round(len / step));
      for (let k = i ? 1 : 0; k <= n; k++) pts.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
    }
    const d = [total];
    for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    total = d[d.length - 1];
    runs.push({ pts, d, w: st.w });
  }
  const pos = [], nrm = [], uvs = [], ss = [], idx = [], path = [];
  let base = 0;
  for (const { pts, d, w } of runs) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const tl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / tl, nz = (b[0] - a[0]) / tl;
      // (a hand's width wanders a little)
      const wk = (w / 2) * (1 + 0.05 * Math.sin(d[i] * 2.3 + seed) + 0.03 * Math.sin(d[i] * 7.1 - seed));
      const s = d[i] / total, [x, z] = pts[i];
      for (const side of [-1, 1]) {
        const px = x + nx * wk * side, pz = z + nz * wk * side;
        pos.push(px, height(px, pz), pz);
        nrm.push(0, 1, 0);
        uvs.push(d[i], side);
        ss.push(s);
      }
      path.push([x, height(x, z), z, s]);
      if (i < pts.length - 1) { const q = base + i * 2; idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
    }
    base += pts.length * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("paintS", new THREE.Float32BufferAttribute(ss, 1));
  geo.setIndex(idx);
  // Facing UP whichever way a stroke runs.
  const p = geo.attributes.position, A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (let k = 0; k < idx.length; k += 3) {
    A.fromBufferAttribute(p, idx[k]); B.fromBufferAttribute(p, idx[k + 1]); C.fromBufferAttribute(p, idx[k + 2]);
    if (B.sub(A).cross(C.sub(A)).y < 0) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
  }
  geo.setIndex(idx);
  return { geo, path, length: total };
}

/**
 * The paint's material: lime, brushed; shown up to `progress` (a uniform node, 0..1 of the painting —
 * past 1 the wet band is gone too).
 */
export function paintMaterial({ progress, length }) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0, alphaTest: 0.5 });
  m.name = "RtsPaint";
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2;
  const s = attribute("paintS", "float"), along = uv().x, across = abs(uv().y);
  const n1 = mx_noise_float(vec3(along.mul(3.1), uv().y.mul(1.7), float(0.3)));
  const n2 = mx_noise_float(vec3(along.mul(0.7), uv().y.mul(0.5), float(4.1)));
  const n3 = mx_noise_float(vec3(along.mul(9.0), uv().y.mul(4.0), float(7.7)));
  // metres behind the brush (<0: not painted yet), the front ragged by a few cm
  const behind = progress.sub(s).mul(length).add(n1.mul(0.06));
  // the borders brushed (a finer rag than the stroke's wander), and WORN through here and there — the
  // ground showing in the scuffed patches (the lab, close up: clean white read as paper tape)
  const edge = float(1).sub(smoothstep(0.8, 1.0, across.add(n1.mul(0.12)).add(n3.mul(0.06))));
  const worn = smoothstep(-0.5, -0.3, n2.add(n3.mul(0.25)));
  m.opacityNode = edge.mul(worn).mul(smoothstep(-0.02, 0.02, behind));
  // dry lime, thinner here and there (the ground darker under it), a fine grain; wet and darker just
  // behind the brush
  const dry = vec3(0.74, 0.72, 0.66).mul(mix(float(0.72), float(1.0), smoothstep(-0.6, 0.6, n2))).mul(n3.mul(0.12).add(0.95));
  const wet = float(1).sub(smoothstep(0.0, 0.7, behind));
  m.colorNode = mix(dry, dry.mul(vec3(0.68, 0.68, 0.7)), wet.mul(0.85));
  return m;
}

let _shared = null;
/** The painted markings of a kit piece (`userData.paint`), as a mesh — complete unless `paint.progress`
 *  (a uniform node) drives it. Null if none. */
export function paintMesh(paint) {
  if (!paint?.geo) return null;
  const mat = paint.progress ? paintMaterial({ progress: paint.progress, length: paint.length }) : (_shared ??= paintMaterial({ progress: uniform(2), length: 1 }));
  const m = new THREE.Mesh(paint.geo, mat);
  m.name = "Paint";
  m.receiveShadow = true;
  m.castShadow = false;
  return m;
}
