/** Binary `.v3splat` — raw RGBA8 splatmap, two slices (L1-L4, L5-L7+meadow). */

const MAGIC        = 0x50533356; // "V3SP" little-endian
const VERSION      = 1;
const HEADER_BYTES = 16;

/**
 * @param {Uint8Array} combined  — SplatMap._combined (both slices concatenated)
 * @param {{ resolution: number }} meta
 */
export function encodeSplatmapFile(combined, { resolution }) {
  const buf  = new ArrayBuffer(HEADER_BYTES + combined.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC,      true);
  view.setUint32(4, VERSION,    true);
  view.setUint32(8, resolution, true);
  view.setUint32(12, 0,         true); // reserved
  new Uint8Array(buf, HEADER_BYTES).set(combined);
  return buf;
}

/** @returns {{ data: Uint8Array, resolution: number }} */
export function decodeSplatmapFile(buffer) {
  if (buffer.byteLength < HEADER_BYTES)
    throw new Error("File too small to be a V3 splatmap.");
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC)
    throw new Error("Not a V3 splatmap file (bad magic).");
  const version    = view.getUint32(4, true);
  if (version !== VERSION)
    throw new Error(`Unsupported splatmap version: ${version}`);
  const resolution = view.getUint32(8, true);
  const expected   = resolution * resolution * 4 * 2;
  if (HEADER_BYTES + expected !== buffer.byteLength)
    throw new Error("Splatmap payload size does not match header resolution.");
  const data = new Uint8Array(buffer, HEADER_BYTES, expected);
  return { data, resolution };
}

export function pickSplatmapFile() {
  return new Promise((resolve) => {
    const input    = document.createElement("input");
    input.type     = "file";
    input.accept   = ".v3splat,application/octet-stream";
    input.style.display = "none";
    const cleanup  = (file) => { resolve(file); input.remove(); };
    input.addEventListener("change", () => cleanup(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => cleanup(null));
    document.body.appendChild(input);
    input.click();
  });
}
