/**
 * Automatic levels of detail, with meshoptimizer.
 *
 * A prop type only had LOD1 / LOD2 if someone imported hand-made GLBs for
 * them, so every built-in shape and every procedural cliff drew its full
 * triangle count at any distance (a 960-triangle sphere at 500 m). This builds
 * the missing levels from the geometry we already have.
 *
 * Two things this does that the meshoptimizer example does NOT:
 *   - `simplifyWithAttributes`, so NORMALS and UVs steer the collapse. Position
 *     -only simplification tears a seam through a UV shell or flattens a shaded
 *     edge, which is exactly what a distant prop shows.
 *   - the vertex buffer is COMPACTED afterwards. The example rewrites the index
 *     and leaves the vertices, so a "simplified" mesh still costs full memory
 *     and a full vertex shader pass over dead vertices.
 *
 * The simplifier is WebAssembly and loads once; `ready` resolves when it can be
 * used. Simplification is CPU work measured in milliseconds per mesh, so it
 * runs off the render path (see the prop auto-LOD queue in main.js).
 */
import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer";

/** Resolves when the WASM simplifier is usable. */
export const simplifierReady = MeshoptSimplifier.ready;

/** Attribute weights: how much a collapse is allowed to disturb each one. */
const NORMAL_WEIGHT = 0.5;
const UV_WEIGHT = 0.8;

/**
 * A simplified copy of `geometry`, or the original when it is already small
 * enough or cannot be simplified further.
 *
 * @param {THREE.BufferGeometry} geometry  indexed, with position (normal/uv optional)
 * @param {object} [o]
 * @param {number} [o.ratio=0.5]     share of triangles to keep
 * @param {number} [o.error=0.05]    how far the silhouette may move, in units of the mesh size
 * @param {number} [o.minTriangles]  never simplify below this
 * @returns {THREE.BufferGeometry}
 */
export function simplifyGeometry(geometry, { ratio = 0.5, error = 0.05, minTriangles = 24 } = {}) {
  const index = geometry.getIndex();
  const posAttr = geometry.getAttribute("position");
  if (!index || !posAttr) return geometry;

  const triangles = index.count / 3;
  if (triangles <= minTriangles) return geometry;
  const targetIndexCount = Math.max(minTriangles, Math.round(triangles * ratio)) * 3;
  if (targetIndexCount >= index.count) return geometry;

  // Attributes that steer the collapse, packed into one interleaved array.
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const vertexCount = posAttr.count;
  const attrParts = [];
  if (normal) attrParts.push({ attr: normal, size: 3, weight: NORMAL_WEIGHT });
  if (uv) attrParts.push({ attr: uv, size: 2, weight: UV_WEIGHT });
  const attrStride = attrParts.reduce((a, p) => a + p.size, 0);

  const attrs = new Float32Array(vertexCount * Math.max(1, attrStride));
  const weights = [];
  if (attrStride > 0) {
    for (const p of attrParts) for (let k = 0; k < p.size; k++) weights.push(p.weight);
    for (let i = 0; i < vertexCount; i++) {
      let o = i * attrStride;
      for (const p of attrParts) {
        for (let k = 0; k < p.size; k++) attrs[o++] = p.attr.getComponent(i, k);
      }
    }
  }

  const srcIndex = index.array instanceof Uint32Array ? index.array : new Uint32Array(index.array);
  const positions = posAttr.array instanceof Float32Array ? posAttr.array : new Float32Array(posAttr.array);

  const [simplified] = attrStride > 0
    ? MeshoptSimplifier.simplifyWithAttributes(
      srcIndex, positions, 3, attrs, attrStride, weights, null, targetIndexCount, error, ["LockBorder"],
    )
    : MeshoptSimplifier.simplify(srcIndex, positions, 3, targetIndexCount, error, ["LockBorder"]);

  if (!simplified || simplified.length >= index.count) return geometry;

  // ── Compact: keep only the vertices the new index still refers to ──
  const remap = new Int32Array(vertexCount).fill(-1);
  let kept = 0;
  for (let i = 0; i < simplified.length; i++) {
    if (remap[simplified[i]] < 0) remap[simplified[i]] = kept++;
  }
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) {
    const src = geometry.attributes[name];
    const size = src.itemSize;
    const dst = new Float32Array(kept * size);
    for (let i = 0; i < vertexCount; i++) {
      const to = remap[i];
      if (to < 0) continue;
      for (let k = 0; k < size; k++) dst[to * size + k] = src.getComponent(i, k);
    }
    out.setAttribute(name, new THREE.BufferAttribute(dst, size, src.normalized));
  }
  const newIndex = new Uint32Array(simplified.length);
  for (let i = 0; i < simplified.length; i++) newIndex[i] = remap[simplified[i]];
  out.setIndex(new THREE.BufferAttribute(newIndex, 1));
  if (geometry.boundingBox) out.boundingBox = geometry.boundingBox.clone();
  if (geometry.boundingSphere) out.boundingSphere = geometry.boundingSphere.clone();
  return out;
}

/**
 * Simplified copies of a prop type's submesh entries, sharing their materials
 * and local transforms. Returns null when nothing could be simplified, so the
 * caller can skip registering a level that would not save anything.
 *
 * @param {{ geometry: THREE.BufferGeometry, material: any, localMatrix: THREE.Matrix4 }[]} entries
 */
export function simplifyEntries(entries, opts = {}) {
  let savedAny = false;
  const out = entries.map((e) => {
    const geometry = simplifyGeometry(e.geometry, opts);
    if (geometry !== e.geometry) savedAny = true;
    return { ...e, geometry };
  });
  return savedAny ? out : null;
}

/** Triangles in a set of entries — for measuring what a level saved. */
export function countTriangles(entries) {
  let n = 0;
  for (const e of entries ?? []) {
    const idx = e.geometry?.getIndex();
    n += idx ? idx.count / 3 : (e.geometry?.getAttribute("position")?.count ?? 0) / 3;
  }
  return n;
}
