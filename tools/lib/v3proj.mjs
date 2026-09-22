/**
 * Reading and writing a `.v3proj` container from Node — for the map tools
 * (patching a manifest section, rewriting the heightmap).
 *
 * Version 2 gzips the manifest and every blob that gains by it, so a tool can
 * no longer treat the bytes after the header as JSON. Read through here and a
 * tool sees the same plain manifest and plain blob bytes it always did,
 * whichever version the file on disk is; write through here and it comes back
 * out packed (and as version 2).
 *
 * The engine's own reader is v3/io/projectIO.js — this is the same container,
 * without the meaning of any section.
 */
import fs from "node:fs";

const HEADER = 12;
const MAGIC = "V3PJ";
const GAIN = 0.9;   // keep a compressed blob only when it saves something

const gzip = async (bytes) =>
  Buffer.from(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
const gunzip = async (bytes) =>
  Buffer.from(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

/**
 * `{ version, manifest, blobs }` — blobs is a Map of name → Buffer of the
 * ORIGINAL (inflated) bytes, in payload order.
 */
export async function readProject(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== MAGIC) throw new Error(`${file}: not a .v3proj (bad magic)`);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint32(4, true);
  const manLen = dv.getUint32(8, true);
  const manBytes = buf.subarray(HEADER, HEADER + manLen);
  const manifest = JSON.parse((version >= 2 ? await gunzip(manBytes) : manBytes).toString("utf8"));
  const payload = buf.subarray(HEADER + manLen);
  const blobs = new Map();
  for (const [name, b] of Object.entries(manifest.blobs ?? {})) {
    if (!b) continue;
    const bytes = payload.subarray(b.offset, b.offset + b.length);
    blobs.set(name, b.enc === "gzip" ? await gunzip(bytes) : Buffer.from(bytes));
  }
  return { version, manifest, blobs, fileBytes: buf.length };
}

/**
 * Write `{ manifest, blobs }` back as a version-2 container: the manifest's
 * `blobs` section is rebuilt from the Map (offsets, lengths, encoding), so a
 * caller can hand back a blob of a different size than it read.
 */
export async function writeProject(file, { manifest, blobs }) {
  const parts = [];
  let offset = 0;
  manifest.blobs = {};
  for (const [name, bytes] of blobs) {
    const packed = await gzip(bytes);
    const worth = packed.byteLength < bytes.byteLength * GAIN;
    const out = worth ? packed : bytes;
    manifest.blobs[name] = worth
      ? { offset, length: out.byteLength, enc: "gzip", raw: bytes.byteLength }
      : { offset, length: out.byteLength };
    parts.push(out);
    offset += out.byteLength;
  }
  manifest.version = 2;
  const manBuf = await gzip(Buffer.from(JSON.stringify(manifest), "utf8"));
  const head = Buffer.alloc(HEADER);
  head.write(MAGIC, 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(manBuf.length, 8);
  const out = Buffer.concat([head, manBuf, ...parts]);
  fs.writeFileSync(file, out);
  return out.length;
}
