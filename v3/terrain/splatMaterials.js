/**
 * SPLAT MATERIALS — the texture library ground splats are cut from.
 *
 * A splat (groundCache.js) is a patch of ONE material laid on the ground: its
 * colour, its normal, and its HEIGHT, which decides where the patch's edge
 * breaks (the tops of its stones survive further out than the dirt between
 * them). The library is two texture arrays, so the bake binds two textures
 * whatever the number of materials:
 *
 *   albedo  rgb = colour (sRGB), a = height
 *   surface rg  = normal x, y (OpenGL convention, ×0.5+0.5), b = roughness
 *
 * On disk each material is TWO 512² WebPs (tools/fetchSplatMaterials.mjs):
 *   <slug>_c.webp  colour
 *   <slug>_s.webp  r, g = normal x, y · b = height (the set's displacement)
 * Roughness is a constant: dry ground under this light is uniformly matte,
 * and a third file per material bought nothing on screen.
 *
 * Built on the CPU once (canvas → array), never per frame.
 */
import * as THREE from "three";
import { markGpuOnly } from "../render/gpuOnlyArrays.js";

/** Texels per material side. A splat tiles its material every 2-5 m: 512 is ~0.5-1 cm a texel. */
export const SPLAT_MAT_SIZE = 512;
const ROUGH = 235;

export const splatMaterialFromSlug = (slug) => ({
  name: slug,
  colour: `/textures/splats/${slug}/${slug}_c.webp`,
  surface: `/textures/splats/${slug}/${slug}_s.webp`,
});

/**
 * FETCHED EARLY, DECODED OFF THE MAIN THREAD (alg-rts' boot A/B, 2026-10-08): the photos were
 * asked for only when the library was built, then waited behind the rest of a game's boot (alg's
 * splats 0.7 → 1.8 s). A game calls prefetchSplatMaterials(materials) at the top of its boot; the
 * library then finds them loaded. createImageBitmap: the same pixels as an <img> (checked byte for
 * byte), decoded on a worker thread.
 */
const _images = new Map();   // url → Promise<ImageBitmap>
function loadImage(url) {
  let p = _images.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`splat material image failed: ${url} (${r.status})`);
      return r.blob();
    }).then((b) => createImageBitmap(b));
    _images.set(url, p);
  }
  return p;
}

/** Start fetching and decoding a library's photos now (see loadImage). */
export function prefetchSplatMaterials(materials) {
  for (const m of materials) for (const url of [m.colour, m.surface]) if (url) loadImage(url).catch(() => {});
}

function makeArray(data, layers, srgb) {
  const S = SPLAT_MAT_SIZE;
  const t = new THREE.DataArrayTexture(data, S, S, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  // Static once uploaded: a game's releaseGpuOnly drops the CPU pixels
  // (2 × 17 MB in alg-rts, held by this module's closures too).
  markGpuOnly(t);
  return t;
}

/**
 * Load a library of { name, colour, surface } (URLs). Resolves to
 * { albedo, surface, names, means, index(name), count }. A file that fails
 * leaves a neutral layer (grey, flat, mid height) and a console warning — one
 * missing file must not cost the whole ground.
 */
export async function loadSplatMaterials(materials) {
  const S = SPLAT_MAT_SIZE, L = Math.max(1, materials.length);
  const albedo = new Uint8Array(S * S * 4 * L);
  const surface = new Uint8Array(S * S * 4 * L);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const get = (url) => (url ? loadImage(url).catch((e) => { console.warn("[splat materials]", e.message); return null; }) : null);
  await Promise.all(materials.map(async (m, i) => {
    const [ci, si] = await Promise.all([get(m.colour), get(m.surface)]);
    // The shared canvas is only touched here, with no await in between, so
    // two materials never interleave on it.
    const px = (img) => {
      if (!img) return null;
      ctx.clearRect(0, 0, S, S);
      ctx.drawImage(img, 0, 0, S, S);
      return ctx.getImageData(0, 0, S, S).data;
    };
    const c = px(ci), s = px(si);
    const o = i * S * S * 4;
    for (let p = 0; p < S * S * 4; p += 4) {
      albedo[o + p] = c ? c[p] : 128; albedo[o + p + 1] = c ? c[p + 1] : 128; albedo[o + p + 2] = c ? c[p + 2] : 128;
      albedo[o + p + 3] = s ? s[p + 2] : 128;
      surface[o + p] = s ? s[p] : 128; surface[o + p + 1] = s ? s[p + 1] : 128;
      surface[o + p + 2] = ROUGH; surface[o + p + 3] = 255;
    }
  }));
  for (const m of materials) { _images.delete(m.colour); _images.delete(m.surface); }   // (in the arrays now)
  const names = materials.map((m) => m.name);
  // Each material's MEAN colour, linear — what the ground cache divides by to
  // sit a photo on ground of another tone (groundCache setSplats `match`).
  const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lut = Array.from({ length: 256 }, (_, i) => toLin(i));
  const means = materials.map((_, i) => {
    const o = i * S * S * 4;
    let r = 0, g = 0, b = 0, n = 0;
    for (let p = 0; p < S * S; p += 7) { const q = o + p * 4; r += lut[albedo[q]]; g += lut[albedo[q + 1]]; b += lut[albedo[q + 2]]; n++; }
    return [r / n, g / n, b / n];
  });
  return {
    albedo: makeArray(albedo, L, true),
    surface: makeArray(surface, L, false),
    names,
    means,
    index(name) { const i = names.indexOf(name); return i < 0 ? 0 : i; },
    count: materials.length,
  };
}
