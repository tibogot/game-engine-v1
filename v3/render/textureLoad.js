// ONE WAY TO LOAD AN IMAGE TEXTURE (2026-10-19) — compressed when it can be.
//
// tools/compressTextures.mjs writes a KTX2 copy of public/ images into public/ktx2/ and lists them in
// public/ktx2/manifest.json. loadTexture(url) looks the image up there: listed → the KTX2 (UASTC,
// transcoded to BC7 on desktop GPUs: 1 byte/pixel instead of 4, mipmaps included, no decode on the main
// thread); not listed, no manifest, or ?ktx2=0 in the page URL → the image itself, as before. So a caller
// can switch to it with nothing generated yet, and A/B the look with ?ktx2=0.
//
// The KTX2 copy is stored FLIPPED, so with the flipY = false every compressed texture has, it samples
// exactly like the image does with TextureLoader's flipY = true: UVs never change (compressTexturesTest).
//
// The KTX2 decoder is bundled in public/basis/ (copied from three's examples/jsm/libs/basis — recopy it
// on a three upgrade; textureLoadTest checks they match), so a shipped game never needs the network.
// One KTX2Loader for the whole page: glbLoader.js uses this one too (three warns about several).
//
// Not for textures the code READS on the CPU (getImageData, terrain slots, brush stamps): a compressed
// texture has no pixels to read. Use the image there.
import * as THREE from "three";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

const BASE = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) || "/";
const ktx2Off = typeof location !== "undefined" && new URLSearchParams(location.search).get("ktx2") === "0";

let _ktx2 = null;
let _detected = false;          // detectSupport(renderer) done: the GPU's formats are known
let _manifest = null;            // Promise<Record<string, entry>>
const _image = new THREE.TextureLoader();

/** The page's single KTX2Loader, with the bundled decoder. Pass the renderer once (before the first load). */
export function getKTX2Loader(renderer) {
  if (!_ktx2) {
    _ktx2 = new KTX2Loader();
    _ktx2.setTranscoderPath(`${BASE}basis/`);
  }
  if (renderer && !_detected) {
    _ktx2.detectSupport(renderer);
    _detected = true;
  }
  return _ktx2;
}

/** Call once with the renderer; until then loadTexture uses the plain images. */
export function initTextureLoader(renderer) { getKTX2Loader(renderer); }

function manifest() {
  _manifest ??= fetch(`${BASE}ktx2/manifest.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => m?.textures ?? {})
    .catch(() => ({}));
  return _manifest;
}

/** "/textures/a.png", "textures/a.png", "../../textures/a.png" (resolved against the page) → "textures/a.png". */
export function manifestKey(url) {
  let p;
  try { p = new URL(url, typeof document !== "undefined" ? document.baseURI : "http://x/").pathname; }
  catch { p = String(url); }
  p = decodeURIComponent(p);
  return p.startsWith(BASE) ? p.slice(BASE.length) : p.replace(/^\//, "");
}

/**
 * Load an image texture, the compressed copy when there is one.
 * @param {string} url  the IMAGE's url, as before
 * @param {{ colorSpace?: string }} [o]  default: sRGB for colour maps, linear for data maps — the
 *   compressor's classification by file name (the image fallback uses the same rule)
 * @returns {Promise<THREE.Texture>}  `.userData.ktx2` is true when the compressed copy was used
 */
export async function loadTexture(url, o = {}) {
  const key = manifestKey(url);
  const entry = !ktx2Off && _detected ? (await manifest())[key] : null;
  if (entry) {
    try {
      const tex = await _ktx2.loadAsync(`${BASE}${entry.file}`);
      tex.colorSpace = o.colorSpace ?? (entry.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace);
      tex.userData.ktx2 = true;
      tex.name ||= key;
      return tex;
    } catch (err) {
      console.warn(`[textureLoad] KTX2 failed for ${key}, using the image:`, err?.message ?? err);
    }
  }
  const tex = await _image.loadAsync(url);
  tex.colorSpace = o.colorSpace ?? (isLinearName(key) ? THREE.NoColorSpace : THREE.SRGBColorSpace);
  tex.userData.ktx2 = false;
  tex.name ||= key;
  return tex;
}

// Same rule as tools/compressTextures.mjs LINEAR (kept in step by textureLoadTest).
export const LINEAR_NAME = /(normal|_nor(_gl|_dx)?\b|_n\.|nrm|rough|_ao\b|ambientocclusion|occlusion|\borm\b|_arm\b|height|disp|metal|mask|noise|_spec|gloss|flow|depth|opacity|alpha\b)/i;
export const isLinearName = (key) => LINEAR_NAME.test(key.split("/").pop());
