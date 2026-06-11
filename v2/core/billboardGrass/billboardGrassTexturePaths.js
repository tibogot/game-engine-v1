/**
 * Alpha mask paths for billboard grass under `textures/billboardGrass/`
 * (also probes `textures/foliage/` so existing masks can be reused).
 */
import * as THREE from "three";

export const BILLBOARD_GRASS_TEXTURE_DIR = "textures/billboardGrass/";

/** Default alpha mask until per-slot masks are added. */
export const DEFAULT_BILLBOARD_GRASS_MASK = `${BILLBOARD_GRASS_TEXTURE_DIR}grassmask1.jpg`;

const SEARCH_PATHS = [
  "../textures/billboardGrass/",
  "textures/billboardGrass/",
  "/textures/billboardGrass/",
  "../textures/foliage/",
  "textures/foliage/",
  "/textures/foliage/",
];

export function normalizeBillboardGrassTextureRef(ref) {
  if (!ref || typeof ref !== "string") return null;
  if (ref.startsWith("data:") || ref.startsWith("blob:") || /^https?:\/\//i.test(ref)) {
    return ref;
  }
  const base = ref.split(/[/\\]/).pop();
  if (!base) return null;
  if (ref.includes("textures/foliage/")) return `textures/foliage/${base}`;
  return `${BILLBOARD_GRASS_TEXTURE_DIR}${base}`;
}

export async function resolveBillboardGrassTextureUrl(ref) {
  if (!ref || typeof ref !== "string") return null;
  if (ref.startsWith("data:") || ref.startsWith("blob:") || /^https?:\/\//i.test(ref)) {
    return ref;
  }
  const filename = ref.split(/[/\\]/).pop();
  if (!filename) return null;
  for (const base of SEARCH_PATHS) {
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

export async function probeBillboardGrassTextureFile(filename) {
  if (!filename) return null;
  const base = filename.split(/[/\\]/).pop();
  return resolveBillboardGrassTextureUrl(`${BILLBOARD_GRASS_TEXTURE_DIR}${base}`);
}

export function loadBillboardGrassTextureFromFile(file) {
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

/**
 * @param {import("../../render/billboardGrass/billboardGrassRenderer.js").BillboardGrassRenderer} renderer
 * @param {object[]} slots
 */
export async function applyBillboardGrassSlotTextures(renderer, slots) {
  const loader = new THREE.TextureLoader();
  const loads = [];

  for (let si = 0; si < slots.length; si++) {
    const slot = slots[si];
    const ref = slot.textureUrl;
    if (!ref) continue;

    loads.push(
      (async () => {
        const url = await resolveBillboardGrassTextureUrl(ref);
        if (!url) {
          console.warn(
            `[V2] Billboard grass slot ${si}: mask not found (${ref}). Copy into ${BILLBOARD_GRASS_TEXTURE_DIR} or textures/foliage/`,
          );
          return;
        }
        return new Promise((resolve) => {
          loader.load(
            url,
            (tex) => {
              tex.colorSpace = THREE.SRGBColorSpace;
              renderer.setSlotTexture(si, tex, slot);
              resolve();
            },
            undefined,
            () => {
              console.warn(`[V2] Billboard grass slot ${si}: failed to load ${url}`);
              resolve();
            },
          );
        });
      })(),
    );
  }

  if (loads.length > 0) await Promise.all(loads);
}
