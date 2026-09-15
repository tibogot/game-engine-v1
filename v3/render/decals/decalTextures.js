/**
 * Decal texture slots, packed into texture ARRAYS.
 *
 * Every decal type (a crack, a crater, a puddle, a logo…) is one layer of the
 * same array, so the decal shader binds a fixed two textures however many
 * types a level uses: colour+alpha, and normal. A per-decal index picks the
 * layer. The arrays are rebuilt (on the CPU, from the source images drawn into
 * a canvas at LAYER_SIZE) only when a slot is added, removed or re-imaged —
 * never per frame.
 *
 * Slot shape: { name, albedoUrl, normalUrl|null }. URLs may be /public paths or
 * blob/data URLs of imported files (the project stores those as assets).
 */
import * as THREE from "three";

/** Per-layer resolution. 512² × RGBA × layers: 1 MB per slot per array (+ mips). */
export const DECAL_LAYER_SIZE = 512;

export const DEFAULT_DECAL_SLOTS = [
  { name: "Crater", albedoUrl: "/textures/crater-decal.png", normalUrl: null },
  { name: "Cracks", albedoUrl: "/textures/crackroad.jpg", normalUrl: null },
];

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Decal image failed to load: ${url}`));
    img.src = url;
  });
}

/**
 * A JPEG has no alpha, so a decal made from one would paint a hard square. For
 * those, alpha comes from how far each pixel is from the image's border colour
 * — cracks on a light background keep the cracks and drop the background.
 */
function alphaFromContent(data, size) {
  const n = size * size;
  let br = 0, bg = 0, bb = 0, count = 0;
  for (let i = 0; i < size; i++) {
    for (const j of [i, (size - 1) * size + i, i * size, i * size + size - 1]) {
      br += data[j * 4]; bg += data[j * 4 + 1]; bb += data[j * 4 + 2]; count++;
    }
  }
  br /= count; bg /= count; bb /= count;
  for (let p = 0; p < n; p++) {
    const d = Math.hypot(data[p * 4] - br, data[p * 4 + 1] - bg, data[p * 4 + 2] - bb) / 441;
    data[p * 4 + 3] = Math.min(255, Math.max(0, (d - 0.08) * 4 * 255));
  }
}

export class DecalTextures {
  /** @param {{ resolveUrl?: (ref:string) => string|null }} [o] saved reference → loadable URL */
  constructor({ resolveUrl } = {}) {
    this.resolveUrl = resolveUrl ?? ((ref) => ref);
    this.slots = [];
    this._gen = 0;
    const S = DECAL_LAYER_SIZE;
    // Start with one transparent layer so the shader always has a valid binding.
    this.albedo = this._makeArray(new Uint8Array(S * S * 4), 1, false);
    this.normal = this._makeArray(this._flatNormals(1), 1, true);
    this.version = 0;
  }

  _flatNormals(layers) {
    const S = DECAL_LAYER_SIZE;
    const d = new Uint8Array(S * S * 4 * layers);
    for (let i = 0; i < d.length; i += 4) { d[i] = 128; d[i + 1] = 128; d[i + 2] = 255; d[i + 3] = 255; }
    return d;
  }

  _makeArray(data, layers, isNormal) {
    const S = DECAL_LAYER_SIZE;
    const t = new THREE.DataArrayTexture(data, S, S, layers);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.colorSpace = isNormal ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  }

  /**
   * Replace every slot and rebuild both arrays. Resolves when the images are in.
   * The texture NODES in the decal material keep pointing at `this.albedo` /
   * `this.normal`; on rebuild their `.value` is swapped (see DecalSystem).
   */
  async setSlots(slots) {
    this.slots = slots.map((s) => ({ name: s.name, albedoUrl: s.albedoUrl, normalUrl: s.normalUrl ?? null }));
    return this._build(++this._gen);
  }

  async _build(gen) {
    const S = DECAL_LAYER_SIZE;
    const layers = Math.max(1, this.slots.length);
    const albedo = new Uint8Array(S * S * 4 * layers);
    const normal = this._flatNormals(layers);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      try {
        const img = await loadImage(this.resolveUrl(slot.albedoUrl));
        ctx.clearRect(0, 0, S, S);
        ctx.drawImage(img, 0, 0, S, S);
        const px = ctx.getImageData(0, 0, S, S).data;
        // An image with no transparency at all (a JPEG, an opaque PNG) gets its
        // alpha from its content instead of painting a solid square.
        if (!_anyAlpha(px)) alphaFromContent(px, S);
        albedo.set(px, i * S * S * 4);
      } catch (err) {
        console.warn("[V3 Decals]", err.message);
      }
      if (slot.normalUrl) {
        try {
          const img = await loadImage(this.resolveUrl(slot.normalUrl));
          ctx.clearRect(0, 0, S, S);
          ctx.drawImage(img, 0, 0, S, S);
          normal.set(ctx.getImageData(0, 0, S, S).data, i * S * S * 4);
        } catch (err) {
          console.warn("[V3 Decals]", err.message);
        }
      }
    }
    // A newer setSlots started while this one loaded images: it wins.
    if (gen !== this._gen) return this;
    const oldA = this.albedo, oldN = this.normal;
    this.albedo = this._makeArray(albedo, layers, false);
    this.normal = this._makeArray(normal, layers, true);
    oldA.dispose(); oldN.dispose();
    this.version++;
    return this;
  }
}

function _anyAlpha(px) {
  for (let i = 3; i < px.length; i += 4 * 97) if (px[i] < 250) return true;
  return false;
}
