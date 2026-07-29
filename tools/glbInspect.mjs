// Read a .glb's JSON chunk directly and report what is in it.
//
// No THREE, no Draco decode, no renderer: the glTF JSON already carries node
// hierarchy, materials, texture references and — crucially — accessor min/max,
// which is the real-world bounding box of the mesh whether or not the vertex
// data itself is Draco-compressed. That is enough to answer "how big is this
// model and what does it cost", which is what you need before deciding how to
// scale it and whether its texturing can be varied.
//
//   node tools/glbInspect.mjs public/models/container01_compressed.glb
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const file = process.argv[2];
if (!file) { console.error("usage: node tools/glbInspect.mjs <file.glb>"); process.exit(1); }

const buf = readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) { console.error("not a glb"); process.exit(1); }
const total = buf.readUInt32LE(8);

let off = 12;
let json = null;
let binLength = 0;
while (off < total) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const body = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
  else if (type === 0x004e4942) binLength = len;
  off += 8 + len + ((4 - (len % 4)) % 4);
}
const g = json;

console.log(`=== ${basename(file)} ===`);
console.log(`  file            ${(buf.length / 1024).toFixed(1)} KB  (bin chunk ${(binLength / 1024).toFixed(1)} KB)`);
console.log(`  generator       ${g.asset?.generator ?? "-"}`);
console.log(`  extensions      ${(g.extensionsUsed ?? []).join(", ") || "none"}`);

console.log(`\n  nodes ${g.nodes?.length ?? 0}   meshes ${g.meshes?.length ?? 0}   `
  + `materials ${g.materials?.length ?? 0}   textures ${g.textures?.length ?? 0}   images ${g.images?.length ?? 0}`);

// ── BOUNDS, from POSITION accessor min/max ─────────────────────────────────
// Survives Draco: the compression extension replaces the buffer view, not the
// accessor's declared range.
const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
let tris = 0, verts = 0;
for (const mesh of g.meshes ?? []) {
  for (const prim of mesh.primitives ?? []) {
    const acc = g.accessors?.[prim.attributes?.POSITION];
    if (acc?.min && acc?.max) {
      for (let i = 0; i < 3; i++) {
        box.min[i] = Math.min(box.min[i], acc.min[i]);
        box.max[i] = Math.max(box.max[i], acc.max[i]);
      }
    }
    if (acc?.count) verts += acc.count;
    const idx = g.accessors?.[prim.indices];
    if (idx?.count) tris += idx.count / 3;
    else if (acc?.count) tris += acc.count / 3;
  }
}
const size = box.max.map((v, i) => v - box.min[i]);
console.log(`\n  BOUNDS (model units, before any node scale)`);
console.log(`    x ${box.min[0].toFixed(3)} .. ${box.max[0].toFixed(3)}   width  ${size[0].toFixed(3)}`);
console.log(`    y ${box.min[1].toFixed(3)} .. ${box.max[1].toFixed(3)}   height ${size[1].toFixed(3)}`);
console.log(`    z ${box.min[2].toFixed(3)} .. ${box.max[2].toFixed(3)}   depth  ${size[2].toFixed(3)}`);
console.log(`    ${Math.round(tris)} triangles, ${verts} vertices`);

// ── NODE TRANSFORMS — a node scale multiplies the bounds above ─────────────
console.log(`\n  NODES`);
for (const [i, n] of (g.nodes ?? []).entries()) {
  const bits = [];
  if (n.translation) bits.push(`t[${n.translation.map((v) => v.toFixed(2))}]`);
  if (n.rotation) bits.push(`r[${n.rotation.map((v) => v.toFixed(2))}]`);
  if (n.scale) bits.push(`s[${n.scale.map((v) => v.toFixed(3))}]`);
  if (n.matrix) bits.push("matrix");
  console.log(`    ${i}  ${n.name ?? "(unnamed)"}${n.mesh !== undefined ? `  mesh ${n.mesh}` : ""}`
    + (bits.length ? `  ${bits.join(" ")}` : ""));
}

// ── MATERIALS AND WHAT THEY SAMPLE ─────────────────────────────────────────
console.log(`\n  MATERIALS`);
for (const [i, m] of (g.materials ?? []).entries()) {
  const p = m.pbrMetallicRoughness ?? {};
  const maps = [];
  const nameOf = (t) => {
    if (!t) return null;
    const tex = g.textures?.[t.index];
    const src = tex?.source ?? tex?.extensions?.KHR_texture_basisu?.source;
    const img = g.images?.[src];
    return `${img?.name ?? img?.mimeType ?? "img" + src}${t.texCoord ? ` uv${t.texCoord}` : ""}`;
  };
  if (p.baseColorTexture) maps.push(`baseColor:${nameOf(p.baseColorTexture)}`);
  if (p.metallicRoughnessTexture) maps.push(`metalRough:${nameOf(p.metallicRoughnessTexture)}`);
  if (m.normalTexture) maps.push(`normal:${nameOf(m.normalTexture)}`);
  if (m.emissiveTexture) maps.push(`emissive:${nameOf(m.emissiveTexture)}`);
  if (m.occlusionTexture) maps.push(`ao:${nameOf(m.occlusionTexture)}`);
  console.log(`    ${i}  ${m.name ?? "(unnamed)"}`);
  console.log(`         baseColor ${JSON.stringify(p.baseColorFactor ?? [1, 1, 1, 1])}`
    + `  metal ${p.metallicFactor ?? 1}  rough ${p.roughnessFactor ?? 1}`);
  console.log(`         maps: ${maps.length ? maps.join(", ") : "NONE — untextured, colour comes from the factor"}`);
}

// ── IMAGES ─────────────────────────────────────────────────────────────────
if (g.images?.length) {
  console.log(`\n  IMAGES`);
  for (const [i, im] of g.images.entries()) {
    const bv = g.bufferViews?.[im.bufferView];
    console.log(`    ${i}  ${im.name ?? "(unnamed)"}  ${im.mimeType ?? "?"}`
      + (bv ? `  ${(bv.byteLength / 1024).toFixed(1)} KB` : ""));
  }
}

// ── UVs — the thing that decides whether variation is cheap ────────────────
const uvSets = new Set();
for (const mesh of g.meshes ?? []) {
  for (const prim of mesh.primitives ?? []) {
    for (const k of Object.keys(prim.attributes ?? {})) if (k.startsWith("TEXCOORD")) uvSets.add(k);
  }
}
console.log(`\n  UV SETS: ${[...uvSets].join(", ") || "none"}`);
