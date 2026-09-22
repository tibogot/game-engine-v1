// What is heavy inside a .v3proj (the V3PJ binary container): every blob and
// every embedded asset, with what it would cost deflated.
//   node tools/attic/v3projWeigh.mjs public/levels/nam-valley.v3proj
import fs from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2] ?? "public/levels/nam-valley.v3proj";
const buf = fs.readFileSync(file);
const mb = (n) => (n / 1e6).toFixed(2).padStart(7) + " MB";
console.log(`${file}: ${mb(buf.length)}`);

const manifestLen = buf.readUInt32LE(8);
const manifest = JSON.parse(buf.subarray(12, 12 + manifestLen).toString("utf8"));
const payload = 12 + manifestLen;
console.log(`manifest JSON: ${mb(manifestLen)}   payload: ${mb(buf.length - payload)}\n`);

const rows = [];
for (const [name, b] of Object.entries(manifest.blobs ?? {})) {
  if (!b) continue;
  const bytes = buf.subarray(payload + b.offset, payload + b.offset + b.length);
  rows.push({ name, len: b.length, gz: zlib.deflateSync(bytes, { level: 9 }).length });
}
for (const a of manifest.assets ?? []) {
  const b = manifest.blobs?.[`asset:${a.hash}`] ?? a.blob ?? null;
  if (!b) continue;
  const bytes = buf.subarray(payload + b.offset, payload + b.offset + b.length);
  rows.push({ name: `asset ${a.name} (${a.type})`, len: b.length, gz: zlib.deflateSync(bytes, { level: 9 }).length });
}
rows.sort((x, y) => y.len - x.len);
let raw = 0, gz = 0;
for (const r of rows) { raw += r.len; gz += r.gz; }
for (const r of rows) console.log(`${mb(r.len)} → ${mb(r.gz)}  ${(100 * r.gz / Math.max(1, r.len)).toFixed(0).padStart(3)}%  ${r.name}`);
console.log(`\n${rows.length} blobs: ${mb(raw)} → ${mb(gz)} deflated`);
console.log(`whole file deflated: ${mb(zlib.deflateSync(buf, { level: 9 }).length)}`);
console.log(`assets listed in manifest: ${(manifest.assets ?? []).length}`);
