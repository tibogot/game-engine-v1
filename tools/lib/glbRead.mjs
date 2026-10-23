/**
 * A small GLB reader for the tests (no three.js, no textures): the node tree with each mesh's triangles in the
 * file's world space. Reads what our pipeline writes — EXT_meshopt_compression (tools/optimizeGlb.mjs),
 * KHR_mesh_quantization (normalized integer positions, undone by the node transforms), TRS or matrix nodes.
 *
 *   const { nodes } = await readGlb(file);   // [{ name, path: "Root/Child", mesh, positions: Float32Array (world), indices }]
 */
import fs from "node:fs";
import { MeshoptDecoder } from "meshoptimizer";

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export async function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  await MeshoptDecoder.ready;
  const views = (json.bufferViews ?? []).map((v) => {
    const ext = v.extensions?.EXT_meshopt_compression;
    if (ext) {
      const src = bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
      const out = new Uint8Array(ext.count * ext.byteStride);
      MeshoptDecoder.decodeGltfBuffer(out, ext.count, ext.byteStride, src, ext.mode, ext.filter ?? "NONE");
      return { data: out, stride: ext.byteStride };
    }
    if (v.buffer !== 0 || !bin) return null;   // (the fallback buffer of a compressed view: never read)
    return { data: new Uint8Array(bin.buffer, bin.byteOffset + (v.byteOffset ?? 0), v.byteLength), stride: v.byteStride ?? 0 };
  });
  const accessor = (i) => {
    const a = json.accessors[i], n = SIZE[a.type], T = COMP[a.componentType], v = views[a.bufferView];
    const out = new Float64Array(a.count * n);
    if (!v) return out;
    const es = T.BYTES_PER_ELEMENT, stride = v.stride || n * es, base = a.byteOffset ?? 0;
    const dv = new DataView(v.data.buffer, v.data.byteOffset, v.data.byteLength);
    const get = { 5120: "getInt8", 5121: "getUint8", 5122: "getInt16", 5123: "getUint16", 5125: "getUint32", 5126: "getFloat32" }[a.componentType];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
      let x = dv[get](base + k * stride + c * es, true);
      if (a.normalized) x = Math.max(x / NORM[a.componentType], -1);
      out[k * n + c] = x;
    }
    return out;
  };
  const mat = (n) => {
    if (n.matrix) return n.matrix.slice();
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
    return [
      (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
      2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
      2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      tx, ty, tz, 1,
    ];
  };
  const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
  const nodes = [];
  const walk = (ni, parent, path) => {
    const n = json.nodes[ni], M = mul(parent, mat(n)), p = path ? `${path}/${n.name ?? ni}` : (n.name ?? String(ni));
    if (n.mesh != null) {
      const mesh = json.meshes[n.mesh];
      const pos = [], idx = [];
      for (const prim of mesh.primitives) {
        if ((prim.mode ?? 4) !== 4) continue;
        const P = accessor(prim.attributes.POSITION), base = pos.length / 3;
        for (let k = 0; k < P.length; k += 3) {
          const [x, y, z] = [P[k], P[k + 1], P[k + 2]];
          pos.push(M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]);
        }
        const I = prim.indices != null ? accessor(prim.indices) : Array.from({ length: P.length / 3 }, (_, k) => k);
        for (const i of I) idx.push(base + i);
      }
      nodes.push({ name: n.name ?? String(ni), path: p, mesh: mesh.name, positions: Float32Array.from(pos), indices: Uint32Array.from(idx) });
    }
    for (const c of n.children ?? []) walk(c, M, p);
  };
  const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of json.scenes[json.scene ?? 0].nodes) walk(r, I4, "");
  return { nodes, json };
}
