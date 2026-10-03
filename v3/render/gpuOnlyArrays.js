// GPU-ONLY ARRAYS — drop the CPU copy of a buffer only the GPU writes.
//
// A storage attribute three creates from a JS array keeps that array for as
// long as the attribute lives, even when only a compute kernel ever writes the
// buffer (skinned vertices, grass blades, plant instances): the CPU copy is
// zeros, never read, never re-sent. alg-rts held ~260 MB of them (heap
// snapshot + buffer census, 2026-10-03).
//
//   markGpuOnly(attr)            — this attribute's CPU array is never written again
//   releaseGpuOnly(renderer)     — swap the array of every marked attribute whose
//                                  GPU buffer exists for an empty one (count kept)
//
// Call releaseGpuOnly after the boot and now and then (a crowd made empty has
// no buffer until its first soldier). A released attribute that is asked to
// upload again (needsUpdate) logs an error: it was not GPU-only after all.
// NEVER mark a DynamicDrawUsage attribute: three re-sends those every frame.

const marked = new Set();
let freed = 0;

export function markGpuOnly(...attrs) {
  for (const a of attrs) if (a?.isBufferAttribute || a?.isInterleavedBuffer) marked.add(a);
}

export function releaseGpuOnly(renderer) {
  const map = renderer?._attributes;
  if (!map) return 0;
  let bytes = 0;
  for (const a of marked) {
    if (!map.has(a) || map.get(a).version === undefined) continue;   // no GPU buffer yet
    if (a.usage === 35048 /* DynamicDrawUsage */) { marked.delete(a); continue; }
    // DETACH the memory (ArrayBuffer.transfer): three's storage binding keeps
    // its own reference to the array it was made with (StorageBuffer._buffer,
    // never read again for storage — the GPU side reads the attribute's
    // buffer), so swapping a.array alone freed nothing (measured: 830 MB
    // after a full GC either way). Every view of a detached buffer reads as
    // length 0. Only an array that owns its whole buffer.
    const arr = a.array, buf = arr?.buffer;
    if (!buf?.transfer || arr.byteOffset !== 0 || arr.byteLength !== buf.byteLength) { marked.delete(a); continue; }
    bytes += arr.byteLength;
    buf.transfer(0);
    // An upload asked of it from now on would send nothing: say so.
    Object.defineProperty(a, "needsUpdate", {
      configurable: true,
      set(v) { if (v) console.error("[gpuOnly] an upload was asked of a released array:", a.name || a); },
    });
    marked.delete(a);
  }
  freed += bytes;
  return bytes;
}

/** Bytes released so far (dev). */
export const gpuOnlyFreed = () => freed;
