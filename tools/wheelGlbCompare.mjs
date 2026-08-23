// COMPARE TWO WHEEL GLBs BEFORE SWAPPING ONE IN.
//
// games/modular-road-v3/wheelModel.js does not merely draw this file, it
// MEASURES it: `radius` and `width` are read straight off the bounding box and
// feed the tire probe's ray ring and sphere sweep. A wheel that renders fine but
// is 2 cm bigger silently changes how the car sits on the road, so size is
// checked here as carefully as vertex count.
//
// Reads the glTF container directly instead of going through GLTFLoader:
// POSITION accessors carry `min`/`max` by spec even when the primitive is
// Draco-compressed, so the exact bounding box is available with no Draco
// decoder — and KTX2 textures would need a live renderer to transcode, which a
// headless script cannot provide.
//
// Usage: node tools/wheelGlbCompare.mjs <current.glb> <new.glb>
import { readFileSync } from "node:fs";
import { argv } from "node:process";

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(path + ": not a GLB");
  let off = 12;
  let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json, bytes: buf.length };
}

/** Divisor that turns a NORMALIZED integer component back into its float
 *  value, per the glTF spec's accessor component types. */
const QUANT = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/* ---- minimal 4x4 math, column-major to match glTF ---- */
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
};
const fromTRS = (t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) => {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
};
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

function analyse(path) {
  const parsed = readGlb(path);
  const g = parsed.json;
  const parts = [];
  const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const grow = (p) => {
    for (let i = 0; i < 3; i++) {
      bbox.min[i] = Math.min(bbox.min[i], p[i]);
      bbox.max[i] = Math.max(bbox.max[i], p[i]);
    }
  };

  const walk = (idx, parent) => {
    const n = g.nodes[idx];
    const local = n.matrix ? n.matrix : fromTRS(n.translation, n.rotation, n.scale);
    const world = mul(parent, local);
    if (n.mesh !== undefined) {
      const mesh = g.meshes[n.mesh];
      for (const prim of mesh.primitives ?? []) {
        const pa = g.accessors[prim.attributes.POSITION];
        const verts = pa.count;
        const tris = prim.indices !== undefined ? g.accessors[prim.indices].count / 3 : verts / 3;
        // Local AABB corners transformed to world, so a rotated or scaled node
        // is measured where it actually sits — the four wheel nodes carry very
        // different scales (0.374 down to 0.178).
        //
        // DEQUANTIZE FIRST. These files use KHR_mesh_quantization, so POSITION
        // is a NORMALIZED SHORT and `min`/`max` come back as raw integers
        // (+-32767). Feeding those to the node matrix reported a 24 km wheel.
        if (pa.min && pa.max) {
          const d = pa.normalized ? QUANT[pa.componentType] ?? 1 : 1;
          const lo = pa.min.map((v) => Math.max(v / d, -1));
          const hi = pa.max.map((v) => Math.max(v / d, -1));
          for (let i = 0; i < 8; i++) {
            grow(apply(world, [
              i & 1 ? hi[0] : lo[0],
              i & 2 ? hi[1] : lo[1],
              i & 4 ? hi[2] : lo[2],
            ]));
          }
        }
        const mat = prim.material !== undefined ? g.materials[prim.material] : null;
        parts.push({
          node: n.name ?? "node" + idx,
          mesh: mesh.name ?? "",
          material: mat?.name ?? "(none)",
          verts,
          tris,
        });
      }
    }
    for (const c of n.children ?? []) walk(c, world);
  };

  const scene = g.scenes?.[g.scene ?? 0];
  for (const r of scene?.nodes ?? []) walk(r, IDENT);

  const images = (g.images ?? []).map((im, i) => {
    const bv = im.bufferView !== undefined ? g.bufferViews[im.bufferView] : null;
    return {
      name: im.name ?? "image" + i,
      mime: im.mimeType ?? "?",
      kb: bv ? Math.round(bv.byteLength / 1024) : 0,
    };
  });

  return {
    path,
    bytes: parsed.bytes,
    parts,
    verts: parts.reduce((a, p) => a + p.verts, 0),
    tris: Math.round(parts.reduce((a, p) => a + p.tris, 0)),
    materials: (g.materials ?? []).map((m) => m.name ?? "(unnamed)"),
    images,
    imageKb: images.reduce((a, i) => a + i.kb, 0),
    extensions: g.extensionsUsed ?? [],
    bbox,
    size: bbox.max.map((v, i) => v - bbox.min[i]),
    centre: bbox.max.map((v, i) => (v + bbox.min[i]) / 2),
  };
}

const oldPath = argv[2];
const newPath = argv[3];
const A = analyse(oldPath);
const B = analyse(newPath);

const f = (n, d = 4) => (n >= 0 ? " " : "") + n.toFixed(d);
const pct = (a, b) => (b === 0 ? "n/a" : ((100 * (a / b - 1)).toFixed(0) + "%"));
const row = (label, a, b, extra) =>
  console.log("  " + String(label).padEnd(22) + String(a).padStart(13) + String(b).padStart(15)
    + (extra ? "   " + extra : ""));

console.log("CURRENT : " + A.path);
console.log("NEW     : " + B.path + "\n");
console.log("  " + "".padEnd(22) + "CURRENT".padStart(13) + "NEW".padStart(15));
console.log("  " + "-".repeat(54));
row("file KB", Math.round(A.bytes / 1024), Math.round(B.bytes / 1024), pct(B.bytes, A.bytes));
row("vertices", A.verts, B.verts, pct(B.verts, A.verts));
row("triangles", A.tris, B.tris, pct(B.tris, A.tris));
row("mesh parts (draws)", A.parts.length, B.parts.length);
row("materials", A.materials.length, B.materials.length);
row("texture KB", A.imageKb, B.imageKb);

console.log("\nSIZE (metres) - feeds WHEEL radius/width, i.e. PHYSICS");
const axes = ["x (axle/width)", "y", "z"];
for (let i = 0; i < 3; i++) row(axes[i], f(A.size[i]), f(B.size[i]), "d " + f(B.size[i] - A.size[i]));
const rA = Math.max(A.size[1], A.size[2]) / 2;
const rB = Math.max(B.size[1], B.size[2]) / 2;
row("=> radius", f(rA), f(rB), "d " + f(rB - rA) + "  (" + (100 * (rB / rA - 1)).toFixed(2) + "%)");
row("=> width", f(A.size[0]), f(B.size[0]),
  "d " + f(B.size[0] - A.size[0]) + "  (" + (100 * (B.size[0] / A.size[0] - 1)).toFixed(2) + "%)");

console.log("\nORIGIN - bounding-box centre relative to the file's (0,0,0)");
for (let i = 0; i < 3; i++) {
  row(["x", "y", "z"][i], f(A.centre[i]), f(B.centre[i]), "d " + f(B.centre[i] - A.centre[i]));
}

console.log("\nPARTS (node / material - verts, tris)");
for (const pair of [["CURRENT", A], ["NEW", B]]) {
  console.log("  " + pair[0]);
  for (const p of pair[1].parts) {
    console.log("    " + String(p.node || "-").padEnd(22) + String(p.material || "-").padEnd(24)
      + String(p.verts).padStart(6) + " v " + String(Math.round(p.tris)).padStart(6) + " t");
  }
}

console.log("\nTEXTURES");
for (const pair of [["CURRENT", A], ["NEW", B]]) {
  const S = pair[1];
  console.log("  " + pair[0] + ": " + (S.images.length
    ? S.images.map((i) => i.name + "(" + i.mime.split("/")[1] + ", " + i.kb + "KB)").join(", ")
    : "none"));
}

console.log("\nEXTENSIONS");
console.log("  CURRENT: " + (A.extensions.join(", ") || "none"));
console.log("  NEW    : " + (B.extensions.join(", ") || "none"));

// wheelModel.js chooses shadow casters by NAME. If neither matches it silently
// falls back to the two physically largest parts, which may not be tyre + rim.
console.log("\nSHADOW-CASTER NAME MATCH (wheelModel.js looks for /tyre|tire/ then /wheel|rim/)");
for (const pair of [["CURRENT", A], ["NEW", B]]) {
  const S = pair[1];
  const lab = (p) => p.material + " " + p.node + " " + p.mesh;
  const tyre = S.parts.find((p) => /tyre|tire/i.test(lab(p)));
  const rim = S.parts.find((p) => p !== tyre && /wheel|rim/i.test(lab(p)));
  console.log("  " + pair[0] + ": tyre=" + (tyre ? tyre.node : "NOT FOUND")
    + "   rim=" + (rim ? rim.node : "NOT FOUND")
    + (tyre && rim ? "" : "   <-- falls back to the two largest parts"));
}
