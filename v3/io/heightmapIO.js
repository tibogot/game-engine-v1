/** Binary `.v3height` — lossless normalized heights (stored_value × maxHeight = world Y). */

const MAGIC   = 0x4d483356; // "V3HM" little-endian
const VERSION = 1;
const HEADER_BYTES = 24;

export function encodeHeightmapFile(heights, meta) {
  const { width, height, worldSize, maxHeight } = meta;
  const buf = new ArrayBuffer(HEADER_BYTES + heights.byteLength);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setFloat32(16, worldSize, true);
  view.setFloat32(20, maxHeight, true);
  new Float32Array(buf, HEADER_BYTES).set(heights);
  return buf;
}

export function decodeHeightmapFile(buffer) {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error("File is too small to be a V3 heightmap.");
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error("Not a V3 heightmap file (bad magic).");
  }
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`Unsupported heightmap version: ${version}`);
  }
  const width     = view.getUint32(8, true);
  const height    = view.getUint32(12, true);
  const worldSize = view.getFloat32(16, true);
  const maxHeight = view.getFloat32(20, true);
  const count     = width * height;
  const bytes     = count * 4;
  if (HEADER_BYTES + bytes !== buffer.byteLength) {
    throw new Error("Heightmap payload size does not match header dimensions.");
  }
  const heights = new Float32Array(count);
  heights.set(new Float32Array(buffer, HEADER_BYTES, count));
  return { heights, width, height, worldSize, maxHeight };
}

export function downloadBuffer(buffer, filename) {
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

export function pickHeightmapFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".v3height,application/octet-stream";
    input.style.display = "none";

    const cleanup = (file) => { resolve(file); input.remove(); };

    input.addEventListener("change", () => cleanup(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => cleanup(null));

    document.body.appendChild(input);
    input.click();
  });
}
