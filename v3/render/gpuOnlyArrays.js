// GPU-ONLY ARRAYS — drop the CPU copy of a buffer only the GPU writes.
//
// A storage attribute three creates from a JS array keeps that array for as
// long as the attribute lives, even when only a compute kernel ever writes the
// buffer (skinned vertices, grass blades, plant instances): the CPU copy is
// zeros, never read, never re-sent. alg-rts held ~260 MB of them (heap
// snapshot + buffer census, 2026-10-03).
//
//   markGpuOnly(attr | dataTex)  — its CPU array is never written or read again
//   releaseGpuOnly(renderer)     — DETACH the memory (ArrayBuffer.transfer) of
//                                  every marked item the GPU has (count kept)
//
// Data textures too (pixels made on the CPU, uploaded once): released once
// three's uploaded version is the texture's current one.
//
// Call releaseGpuOnly after the boot and now and then (a crowd made empty has
// no buffer until its first soldier). A released attribute that is asked to
// upload again (needsUpdate) logs an error: it was not GPU-only after all.
// NEVER mark a DynamicDrawUsage attribute: three re-sends those every frame.

const marked = new Set();
let freed = 0;

export function markGpuOnly(...items) {
  for (const a of items) if (a?.isBufferAttribute || a?.isInterleavedBuffer || a?.isDataTexture || a?.isDataArrayTexture || a?.isData3DTexture) marked.add(a);
}

/** Detach the memory behind a typed array that owns its whole buffer. Bytes freed, 0 if it cannot. */
function detach(arr) {
  const buf = arr?.buffer;
  if (!buf?.transfer || buf.detached || arr.byteOffset !== 0 || arr.byteLength !== buf.byteLength) return 0;
  const n = arr.byteLength;
  buf.transfer(0);
  return n;
}

// A DATA TEXTURE (CPU pixels three uploads once): its pixels once the GPU has
// the current version. The texture's source keeps the array, so detach it.
function releaseTexture(renderer, t) {
  const tex = renderer._textures;
  if (!tex?.has(t) || tex.get(t).version !== t.version) return -1;   // not uploaded yet
  let bytes = detach(t.image?.data);
  for (const m of t.mipmaps ?? []) bytes += detach(m.data);
  Object.defineProperty(t, "needsUpdate", {
    configurable: true,
    set(v) { if (v) console.error("[gpuOnly] an upload was asked of a released texture:", t.name || t); },
  });
  return bytes;
}

export function releaseGpuOnly(renderer) {
  const map = renderer?._attributes;
  if (!map) return 0;
  let bytes = 0;
  for (const a of marked) {
    if (a.isTexture) {
      const b = releaseTexture(renderer, a);
      if (b >= 0) { bytes += b; marked.delete(a); }
      continue;
    }
    if (!map.has(a) || map.get(a).version === undefined) continue;   // no GPU buffer yet
    if (a.usage === 35048 /* DynamicDrawUsage */) { marked.delete(a); continue; }
    // DETACH the memory (ArrayBuffer.transfer): three's storage binding keeps
    // its own reference to the array it was made with (StorageBuffer._buffer,
    // never read again for storage — the GPU side reads the attribute's
    // buffer), so swapping a.array alone freed nothing (measured: 830 MB
    // after a full GC either way). Every view of a detached buffer reads as
    // length 0. Only an array that owns its whole buffer.
    const n = detach(a.array);
    marked.delete(a);
    if (!n) continue;
    bytes += n;
    // An upload asked of it from now on would send nothing: say so.
    Object.defineProperty(a, "needsUpdate", {
      configurable: true,
      set(v) { if (v) console.error("[gpuOnly] an upload was asked of a released array:", a.name || a); },
    });
  }
  freed += bytes;
  return bytes;
}

/** Bytes released so far (dev). */
export const gpuOnlyFreed = () => freed;
