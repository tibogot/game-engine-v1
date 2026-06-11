/**
 * Canonical paths for billboard foliage textures under project `textures/foliage/`.
 * Saved in .v2terrain as `textures/foliage/<filename>` (not embedded base64).
 */
import * as THREE from "three";

/** Stored in toolState / project JSON */
export const FOLIAGE_TEXTURE_DIR = "textures/foliage/";

/** Resolved from v2/editor.html and repo-root static servers */
const FOLIAGE_TEXTURE_SEARCH_PATHS = [
  "../textures/foliage/",
  "textures/foliage/",
  "/textures/foliage/",
];

/**
 * @param {string} ref
 * @returns {string|null}
 */
export function normalizeFoliageTextureRef(ref) {
  if (!ref || typeof ref !== "string") return null;
  if (ref.startsWith("data:") || ref.startsWith("blob:") || /^https?:\/\//i.test(ref)) {
    return ref;
  }
  const base = ref.split(/[/\\]/).pop();
  if (!base) return null;
  return `${FOLIAGE_TEXTURE_DIR}${base}`;
}

/**
 * URL for THREE.TextureLoader (or null if not found).
 * @param {string} ref — stored ref or legacy data/blob URL
 * @returns {Promise<string|null>}
 */
export async function resolveFoliageTextureUrl(ref) {
  if (!ref || typeof ref !== "string") return null;
  if (ref.startsWith("data:") || ref.startsWith("blob:") || /^https?:\/\//i.test(ref)) {
    return ref;
  }

  const filename = ref.split(/[/\\]/).pop();
  if (!filename) return null;

  for (const base of FOLIAGE_TEXTURE_SEARCH_PATHS) {
    const url = base + filename;
    try {
      const resp = await fetch(url, { method: "HEAD" });
      if (resp.ok) return url;
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

/**
 * @param {string} filename — basename only
 * @returns {Promise<string|null>}
 */
export async function probeFoliageTextureFile(filename) {
  if (!filename) return null;
  const base = filename.split(/[/\\]/).pop();
  return resolveFoliageTextureUrl(`${FOLIAGE_TEXTURE_DIR}${base}`);
}

/**
 * @param {import("../../render/foliage/billboardRenderer.js").BillboardRenderer} billboardRenderer
 * @param {object[]} foliageSlots
 */
export async function applyFoliageSlotTextures(billboardRenderer, foliageSlots) {
  const loader = new THREE.TextureLoader();
  const loads = [];

  for (let si = 0; si < foliageSlots.length; si++) {
    const slot = foliageSlots[si];
    const ref = slot.textureUrl;
    if (!ref) continue;

    loads.push(
      (async () => {
        const url = await resolveFoliageTextureUrl(ref);
        if (!url) {
          console.warn(
            `[V2] Foliage slot ${si}: texture not found (${ref}). Place the file in ${FOLIAGE_TEXTURE_DIR}`,
          );
          return;
        }
        return new Promise((resolve) => {
          loader.load(
            url,
            (tex) => {
              tex.colorSpace = THREE.SRGBColorSpace;
              billboardRenderer.setSlotTexture(si, tex, slot);
              resolve();
            },
            undefined,
            () => {
              console.warn(`[V2] Foliage slot ${si}: failed to load ${url}`);
              resolve();
            },
          );
        });
      })(),
    );
  }

  if (loads.length > 0) await Promise.all(loads);
}

/**
 * Load a user-picked image for in-editor preview (any path on disk).
 * Does not update slot.textureUrl — use only for try-before-copying into FOLIAGE_TEXTURE_DIR.
 * @param {File} file
 * @returns {Promise<THREE.Texture>}
 */
export function loadFoliageTextureFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        URL.revokeObjectURL(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        resolve(tex);
      },
      undefined,
      (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      },
    );
  });
}
