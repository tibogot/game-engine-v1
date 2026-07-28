/**
 * `.v3proj` — whole-project container (GLB-style layout):
 *
 *   u32 magic "V3PJ" · u32 version · u32 manifestByteLength
 *   manifest JSON (UTF-8)
 *   binary payload (blobs referenced by { offset, length } in the manifest)
 *
 * Manifest:
 *   terrain   { worldSize, heightmapSize, splatSize, maxHeight }
 *             splatSize is absent in files written before it was configurable —
 *             those used splatRes = min(2048, max(256, heightmapSize / 2)).
 *   blobs     { heightmap, splat, snow, grassDensity, susukiDensity }
 *             → { offset, length } into the payload
 *   splatRes / snowRes
 *   trees     { slots: [...slot meta...], instances: [[x,z,y,rotY,scale,slotIdx],…] }
 *   foliage   { slots: [...slot meta...], instances: [[x,z,y,rotY,scale,slotIdx,nx,nz],…] }
 *   props     propStore.exportData()
 *   roads     roadSystem.exportData()
 *   splines   splineSystem.exportData()
 *   lakes     lakeSystem.exportData()
 *   rivers    riverSystem.exportData()      (basic ribbon rivers)
 *   rivers2   river2System.exportData()     (River+ carve — heightmap blob is the
 *                                            UNCARVED base; load re-carves)
 *   spawn     { x, z, yaw }                 player start; null when unplaced
 *
 * Binary blobs stay raw (heightmap Float32, splat/snow Uint8) — no base64 bloat.
 * Unknown/absent sections are simply skipped on load, so the format can grow.
 * That is why `lakes` needed no VERSION bump: older files simply have none.
 */

export const PROJECT_MAGIC = 0x4a503356; // "V3PJ" little-endian
const VERSION      = 1;
const HEADER_BYTES = 12;

export function isProjectFile(buffer) {
  return buffer.byteLength >= HEADER_BYTES
    && new DataView(buffer).getUint32(0, true) === PROJECT_MAGIC;
}

export function encodeProjectFile({
  terrain,
  heightmap,            // Float32Array
  splat, splatRes,      // Uint8Array (both slices combined), texels per side
  snow, snowRes,        // Uint8Array, texels per side
  trees, foliage, props, roads, splines, lakes, rivers, rivers2,
  spawn,                // { x, z, yaw } player start, or null
  grassDensity,         // Uint8Array (RGBA 512²) painted grass coverage
  susukiDensity,        // Uint8Array (RGBA 512²) painted susuki coverage
  susuki,               // susuki appearance params (JSON)
  groundTsl,            // procedural ground params (JSON)
  meadowTsl,            // paintable meadow TSL params (JSON)
}) {
  const blobs = {};
  const parts = [];
  let offset = 0;
  const addBlob = (name, typedArray) => {
    if (!typedArray) return;
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    blobs[name] = { offset, length: bytes.byteLength };
    parts.push(bytes);
    offset += bytes.byteLength;
  };
  addBlob("heightmap", heightmap);
  addBlob("splat", splat);
  addBlob("snow", snow);
  addBlob("grassDensity", grassDensity);
  addBlob("susukiDensity", susukiDensity);

  const manifest = {
    version: VERSION,
    terrain,
    blobs,
    splatRes: splatRes ?? null,
    snowRes:  snowRes ?? null,
    trees:    trees ?? null,
    foliage:  foliage ?? null,
    props:    props ?? null,
    roads:    roads ?? null,
    splines:  splines ?? null,
    lakes:    lakes ?? null,
    rivers:   rivers ?? null,
    rivers2:  rivers2 ?? null,
    spawn:    spawn ?? null,
    susuki:   susuki ?? null,
    groundTsl: groundTsl ?? null,
    meadowTsl: meadowTsl ?? null,
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  const total = HEADER_BYTES + manifestBytes.byteLength + offset;
  const buf   = new ArrayBuffer(total);
  const view  = new DataView(buf);
  view.setUint32(0, PROJECT_MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, manifestBytes.byteLength, true);
  const out = new Uint8Array(buf);
  out.set(manifestBytes, HEADER_BYTES);
  let p = HEADER_BYTES + manifestBytes.byteLength;
  for (const part of parts) { out.set(part, p); p += part.byteLength; }
  return buf;
}

export function decodeProjectFile(buffer) {
  if (!isProjectFile(buffer)) throw new Error("Not a V3 project file (bad magic).");
  const view = new DataView(buffer);
  const version = view.getUint32(4, true);
  if (version > VERSION) {
    throw new Error(`Project file version ${version} is newer than this editor supports (${VERSION}).`);
  }
  const manifestLen = view.getUint32(8, true);
  if (HEADER_BYTES + manifestLen > buffer.byteLength) {
    throw new Error("Corrupt project file (manifest length exceeds file size).");
  }
  const manifest = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, HEADER_BYTES, manifestLen)),
  );
  const payloadStart = HEADER_BYTES + manifestLen;
  const blob = (name) => {
    const b = manifest.blobs?.[name];
    if (!b) return null;
    if (payloadStart + b.offset + b.length > buffer.byteLength) {
      throw new Error(`Corrupt project file (blob "${name}" out of range).`);
    }
    return new Uint8Array(buffer, payloadStart + b.offset, b.length);
  };

  const hmBytes = blob("heightmap");
  return {
    version,
    terrain:   manifest.terrain,
    // Float32Array view needs 4-byte alignment — copy via slice to be safe.
    heightmap: hmBytes ? new Float32Array(hmBytes.slice().buffer) : null,
    splat:     blob("splat"),
    splatRes:  manifest.splatRes,
    snow:      blob("snow"),
    snowRes:   manifest.snowRes,
    trees:     manifest.trees,
    foliage:   manifest.foliage,
    props:     manifest.props,
    roads:     manifest.roads,
    splines:   manifest.splines,
    lakes:     manifest.lakes,
    rivers:    manifest.rivers,
    rivers2:   manifest.rivers2,
    spawn:     manifest.spawn ?? null,
    grassDensity:  blob("grassDensity"),
    susukiDensity: blob("susukiDensity"),
    susuki:    manifest.susuki ?? null,
    groundTsl: manifest.groundTsl ?? null,
    meadowTsl: manifest.meadowTsl ?? null,
  };
}

/** File picker accepting both whole projects and bare heightmaps. */
export function pickProjectFile() {
  return new Promise((resolve) => {
    const input  = document.createElement("input");
    input.type   = "file";
    input.accept = ".v3proj,.v3height,application/octet-stream";
    input.style.display = "none";
    const cleanup = (file) => { resolve(file); input.remove(); };
    input.addEventListener("change", () => cleanup(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => cleanup(null));
    document.body.appendChild(input);
    input.click();
  });
}
