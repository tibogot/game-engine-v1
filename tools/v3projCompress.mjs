/**
 * Rewrite a .v3proj as a version-2 (gzipped) container — same bytes inside,
 * a third of the file.
 *
 * The paint maps are raw pixels and raw pixels compress hugely: MEASURED on
 * nam-valley, splat 33.6 MB → 3.9, foliage paint 8.4 → 2.4, the file 62 → 22.
 * Already-compressed blobs (imported JPEGs and PNGs) are left alone. It works
 * on the CONTAINER — header, manifest, payload — so it needs to know nothing
 * about what a project contains and cannot lose a section it has not heard of.
 *
 *   node tools/v3projCompress.mjs public/levels/nam-valley.v3proj [out.v3proj]
 *
 * Without an output path it rewrites the file in place (after checking the
 * result decodes back to the same bytes).
 */
import fs from "node:fs";

const GAIN = 0.9;          // keep the compressed copy only when it saves something
const HEADER = 12;
const MAGIC = 0x4a503356;  // "V3PJ"

const gzip = async (bytes) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
const gunzip = async (bytes) =>
  new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

const inPath = process.argv[2];
const outPath = process.argv[3] ?? inPath;
if (!inPath) {
  console.error("usage: node tools/v3projCompress.mjs <file.v3proj> [out.v3proj]");
  process.exit(1);
}

const src = fs.readFileSync(inPath);
const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
if (view.getUint32(0, true) !== MAGIC) throw new Error("not a .v3proj (bad magic)");
const version = view.getUint32(4, true);
const manifestLen = view.getUint32(8, true);
const manifestBytes = src.subarray(HEADER, HEADER + manifestLen);
const manifest = JSON.parse(new TextDecoder().decode(
  version >= 2 ? await gunzip(manifestBytes) : manifestBytes,
));
const payload = HEADER + manifestLen;

// Every blob, in payload order, inflated back to its original bytes.
const entries = Object.entries(manifest.blobs ?? {}).filter(([, b]) => b);
const originals = new Map();
for (const [name, b] of entries) {
  const bytes = src.subarray(payload + b.offset, payload + b.offset + b.length);
  originals.set(name, b.enc === "gzip" ? await gunzip(bytes) : Uint8Array.from(bytes));
}

// Repack: gzip what gains by it, rebuild the offsets.
const parts = [];
let offset = 0, kept = 0, packed = 0;
for (const [name] of entries) {
  const bytes = originals.get(name);
  const z = await gzip(bytes);
  const worth = z.byteLength < bytes.byteLength * GAIN;
  const out = worth ? z : bytes;
  manifest.blobs[name] = worth
    ? { offset, length: out.byteLength, enc: "gzip", raw: bytes.byteLength }
    : { offset, length: out.byteLength };
  parts.push(out);
  offset += out.byteLength;
  if (worth) packed++; else kept++;
}
manifest.version = 2;

const newManifest = await gzip(new TextEncoder().encode(JSON.stringify(manifest)));
const total = HEADER + newManifest.byteLength + offset;
const out = new Uint8Array(total);
const dv = new DataView(out.buffer);
dv.setUint32(0, MAGIC, true);
dv.setUint32(4, 2, true);
dv.setUint32(8, newManifest.byteLength, true);
out.set(newManifest, HEADER);
let p = HEADER + newManifest.byteLength;
for (const part of parts) { out.set(part, p); p += part.byteLength; }

// Read it back and check every blob is byte-for-byte what went in.
{
  const rv = new DataView(out.buffer);
  const mLen = rv.getUint32(8, true);
  const m = JSON.parse(new TextDecoder().decode(await gunzip(out.subarray(HEADER, HEADER + mLen))));
  const base = HEADER + mLen;
  for (const [name, b] of Object.entries(m.blobs ?? {})) {
    const bytes = out.subarray(base + b.offset, base + b.offset + b.length);
    const back = b.enc === "gzip" ? await gunzip(bytes) : bytes;
    const want = originals.get(name);
    if (back.byteLength !== want.byteLength) throw new Error(`blob "${name}" changed length`);
    for (let i = 0; i < back.length; i++) if (back[i] !== want[i]) throw new Error(`blob "${name}" changed at byte ${i}`);
  }
  console.log(`verified ${Object.keys(m.blobs ?? {}).length} blobs byte-for-byte`);
}

fs.writeFileSync(outPath, out);
console.log(`${inPath}: ${mb(src.byteLength)} → ${mb(total)}  (${packed} blobs gzipped, ${kept} left raw)`);
console.log(`manifest: ${mb(manifestLen)} → ${mb(newManifest.byteLength)}`);
