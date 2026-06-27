/**
 * TextureLibrary — manages 7 paint texture slots for the splat overlay.
 *
 * Each slot holds an albedo image and an ORM (packed) image.
 * All slots are stored in two DataArrayTextures:
 *   albedoArrayTex  — 7 layers of RGBA albedo, SLOT_RES × SLOT_RES
 *   ormArrayTex     — 7 layers of packed ORM:
 *       R = roughness, G = AO, B = normalX_encoded, A = normalY_encoded
 *
 * When no texture is loaded, slots show procedural colour swatches.
 * All per-slot shader parameters are exposed as TSL uniforms.
 */
import * as THREE from "three";
import { uniform } from "three/tsl";

export const NUM_LAYERS = 7;
export const SLOT_RES   = 512; // per-slot texture resolution (fixed for the DataArrayTexture)

// Default swatch colours — distinct enough to identify layers quickly
const DEFAULT_ALBEDO = [
  [180, 130,  80], // dirt / soil
  [ 80, 140,  60], // grass
  [160, 155, 145], // rock / stone
  [220, 205, 170], // sand / gravel
  [100,  80,  60], // dark earth
  [200, 190, 160], // light stone / path
  [ 60, 100,  50], // deep moss
];

function _makeArrayTex(data, colorSpace = THREE.NoColorSpace) {
  const tex = new THREE.DataArrayTexture(data, SLOT_RES, SLOT_RES, NUM_LAYERS);
  tex.format           = THREE.RGBAFormat;
  tex.colorSpace       = colorSpace;
  tex.wrapS            = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter        = THREE.LinearMipmapLinearFilter;
  tex.magFilter        = THREE.LinearFilter;
  tex.generateMipmaps  = true;
  tex.needsUpdate      = true;
  return tex;
}

function _resizeImageToSlotRes(bitmap) {
  const canvas = new OffscreenCanvas(SLOT_RES, SLOT_RES);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, SLOT_RES, SLOT_RES);
  return canvas.getContext("2d").getImageData(0, 0, SLOT_RES, SLOT_RES).data;
}

export class TextureLibrary {
  constructor() {
    // ── CPU-side data arrays (modified in-place, textures re-upload via needsUpdate) ──
    this._albedoData = new Uint8Array(SLOT_RES * SLOT_RES * 4 * NUM_LAYERS);
    this._ormData    = new Uint8Array(SLOT_RES * SLOT_RES * 4 * NUM_LAYERS);

    this._fillDefaultAlbedo();
    this._fillDefaultOrm();

    this.albedoArrayTex = _makeArrayTex(this._albedoData, THREE.SRGBColorSpace);
    this.ormArrayTex    = _makeArrayTex(this._ormData, THREE.LinearSRGBColorSpace);

    // ── Per-slot metadata ──────────────────────────────────────────────────────
    this.slots = Array.from({ length: NUM_LAYERS }, (_, i) => ({
      name:        `Layer ${i + 1}`,
      albedoName:  null,  // loaded filename
      normalName:  null,
      roughName:   null,
      aoName:      null,
      albedoUrl:   null,  // URL for UI preview (object URL or server URL)
      normalUrl:   null,
      roughUrl:    null,
      aoUrl:       null,
      // Auto-paint rules (baked on demand via Generate)
      autoEnabled:   false,
      autoHeightMin: 0,
      autoHeightMax: 500,
      autoSlopeMin:  0,
      autoSlopeMax:  90,
      autoBlend:     15,   // % of range to feather at edges
      autoStrength:  1.0,
    }));

    // ── Per-slot TSL uniforms ──────────────────────────────────────────────────
    // Exposed as a plain-object array — passed directly into createSplatOverlay()
    this.slotUniforms = Array.from({ length: NUM_LAYERS }, () => ({
      uUVScale:   uniform(20.0),
      uNormalStr: uniform(1.0),
      uAOStr:     uniform(0.8),
      uRoughStr:  uniform(1.0),
    }));
  }

  // ── Default fill helpers ───────────────────────────────────────────────────

  _fillDefaultAlbedo() {
    const n = SLOT_RES * SLOT_RES;
    for (let layer = 0; layer < NUM_LAYERS; layer++) {
      const [r, g, b] = DEFAULT_ALBEDO[layer];
      const off = layer * n * 4;
      for (let i = 0; i < n; i++) {
        this._albedoData[off + i*4]   = r;
        this._albedoData[off + i*4+1] = g;
        this._albedoData[off + i*4+2] = b;
        this._albedoData[off + i*4+3] = 255;
      }
    }
  }

  _fillDefaultOrm() {
    // Neutral: roughness 0.8, full AO, flat normal
    for (let i = 0; i < this._ormData.length; i += 4) {
      this._ormData[i]   = 204; // roughness  (204/255 ≈ 0.8)
      this._ormData[i+1] = 255; // AO         (1.0)
      this._ormData[i+2] = 128; // normalX    (0.5 → 0 in [-1,1])
      this._ormData[i+3] = 128; // normalY    (0.5 → 0 in [-1,1])
    }
  }

  // ── Texture loading ────────────────────────────────────────────────────────

  async loadAlbedo(slotIndex, file) {
    const bm  = await createImageBitmap(file);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const off = slotIndex * SLOT_RES * SLOT_RES * 4;
    this._albedoData.set(px, off);
    this.albedoArrayTex.needsUpdate = true;
    this.slots[slotIndex].albedoName = file.name;
    this.slots[slotIndex].albedoUrl  = URL.createObjectURL(file);
  }

  async loadNormalMap(slotIndex, file) {
    const bm  = await createImageBitmap(file);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) {
      this._ormData[off + i*4+2] = px[i*4];     // R → B (normal X)
      this._ormData[off + i*4+3] = px[i*4+1];   // G → A (normal Y)
    }
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].normalName = file.name;
    this.slots[slotIndex].normalUrl  = URL.createObjectURL(file);
  }

  async loadRoughness(slotIndex, file) {
    const bm  = await createImageBitmap(file);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4] = px[i*4]; // R → roughness
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].roughName = file.name;
    this.slots[slotIndex].roughUrl  = URL.createObjectURL(file);
  }

  async loadAO(slotIndex, file) {
    const bm  = await createImageBitmap(file);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4+1] = px[i*4]; // R → AO
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].aoName = file.name;
    this.slots[slotIndex].aoUrl  = URL.createObjectURL(file);
  }

  // Load albedo from drag-dropped image, auto-detect map type by filename keyword
  async loadFileAutoDetect(slotIndex, file) {
    const name = file.name.toLowerCase();
    if (name.includes("normal") || name.includes("nrm") || name.includes("nor")) {
      await this.loadNormalMap(slotIndex, file);
    } else if (name.includes("rough") || name.includes("roughness")) {
      await this.loadRoughness(slotIndex, file);
    } else if (name.includes("ao") || name.includes("ambient") || name.includes("occlusion")) {
      await this.loadAO(slotIndex, file);
    } else {
      await this.loadAlbedo(slotIndex, file);
    }
  }

  // ── URL-based loading (for preloading defaults from the server) ─────────────

  async _bitmapFromUrl(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return createImageBitmap(blob);
  }

  async loadAlbedoFromUrl(slotIndex, url) {
    const bm  = await this._bitmapFromUrl(url);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const off = slotIndex * SLOT_RES * SLOT_RES * 4;
    this._albedoData.set(px, off);
    this.albedoArrayTex.needsUpdate = true;
    this.slots[slotIndex].albedoName = url.split("/").pop();
    this.slots[slotIndex].albedoUrl  = url;
  }

  async loadNormalFromUrl(slotIndex, url) {
    const bm  = await this._bitmapFromUrl(url);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) {
      this._ormData[off + i*4+2] = px[i*4];
      this._ormData[off + i*4+3] = px[i*4+1];
    }
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].normalName = url.split("/").pop();
    this.slots[slotIndex].normalUrl  = url;
  }

  async loadRoughnessFromUrl(slotIndex, url) {
    const bm  = await this._bitmapFromUrl(url);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4] = px[i*4];
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].roughName = url.split("/").pop();
    this.slots[slotIndex].roughUrl  = url;
  }

  async loadAOFromUrl(slotIndex, url) {
    const bm  = await this._bitmapFromUrl(url);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4+1] = px[i*4];
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].aoName = url.split("/").pop();
    this.slots[slotIndex].aoUrl  = url;
  }

  async preloadDefaults() {
    const B = "/textures/pbr_materials";
    const sets = [
      { name: "Grass",       d: "Grass005",                       col: "Grass005_1K-JPG_Color.jpg",                          nor: "Grass005_1K-JPG_NormalGL.jpg",           rough: "Grass005_1K-JPG_Roughness.jpg",                         ao: "Grass005_1K-JPG_AmbientOcclusion.jpg" },
      { name: "Ground",      d: "Ground037",                      col: "Ground037_1K-JPG_Color.jpg",                         nor: "Ground037_1K-JPG_NormalGL.jpg",          rough: "Ground037_1K-JPG_Roughness.jpg",                        ao: "Ground037_1K-JPG_AmbientOcclusion.jpg" },
      { name: "Rock",        d: "Rock028",                        col: "Rock028_2K-JPG_Color.jpg",                           nor: "Rock028_2K-JPG_NormalGL.jpg",            rough: "Rock028_2K-JPG_Roughness.jpg",                          ao: "Rock028_2K-JPG_AmbientOcclusion.jpg" },
      { name: "Rock Alt",    d: "Rock058",                        col: "Rock058_2K-JPG_Color.jpg",                           nor: "Rock058_2K-JPG_NormalGL.jpg",            rough: "Rock058_2K-JPG_Roughness.jpg",                          ao: "Rock058_2K-JPG_AmbientOcclusion.jpg" },
      { name: "Cobble",      d: "Cobblestone_Irregular_Floor_001_SD", col: "Cobblestone_Irregular_Floor_001_basecolor.png",  nor: "Cobblestone_Irregular_Floor_001_normal.png", rough: "Cobblestone_Irregular_Floor_001_roughness.png",       ao: "Cobblestone_Irregular_Floor_001_ambientOcclusion.png" },
      { name: "Cliff Rock",  d: "cliff_rocks_07_2k",              col: "cliff_rocks_07_basecolor_2k.png",                    nor: "cliff_rocks_07_normal_gl_2k.png",        rough: "cliff_rocks_07_roughness_2k.png",                       ao: "cliff_rocks_07_ambientocclusion_2k.png" },
      { name: "Snow",        d: "Snow010A",                       col: "Snow010A_1K-JPG_Color.jpg",                          nor: "Snow010A_1K-JPG_NormalGL.jpg",           rough: "Snow010A_1K-JPG_Roughness.jpg",                         ao: "Snow010A_1K-JPG_AmbientOcclusion.jpg" },
    ];

    await Promise.all(sets.map((s, i) => {
      this.slots[i].name = s.name;
      const p = `${B}/${s.d}`;
      return Promise.all([
        this.loadAlbedoFromUrl(i, `${p}/${s.col}`),
        this.loadNormalFromUrl(i, `${p}/${s.nor}`),
        this.loadRoughnessFromUrl(i, `${p}/${s.rough}`),
        this.loadAOFromUrl(i, `${p}/${s.ao}`),
      ]);
    }));
  }

  // ── Clear individual maps back to neutral ─────────────────────────────────

  clearAlbedo(slotIndex) {
    const [r, g, b] = DEFAULT_ALBEDO[slotIndex] ?? [160, 160, 160];
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) {
      this._albedoData[off + i*4]   = r;
      this._albedoData[off + i*4+1] = g;
      this._albedoData[off + i*4+2] = b;
      this._albedoData[off + i*4+3] = 255;
    }
    this.albedoArrayTex.needsUpdate = true;
    this.slots[slotIndex].albedoName = null;
    this.slots[slotIndex].albedoUrl  = null;
  }

  clearNormal(slotIndex) {
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) {
      this._ormData[off + i*4+2] = 128; // normalX → flat
      this._ormData[off + i*4+3] = 128; // normalY → flat
    }
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].normalName = null;
    this.slots[slotIndex].normalUrl  = null;
  }

  clearRoughness(slotIndex) {
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4] = 204; // 0.8
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].roughName = null;
    this.slots[slotIndex].roughUrl  = null;
  }

  clearAO(slotIndex) {
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4+1] = 255; // 1.0
    this.ormArrayTex.needsUpdate = true;
    this.slots[slotIndex].aoName = null;
    this.slots[slotIndex].aoUrl  = null;
  }

  // ── Slot settings ──────────────────────────────────────────────────────────

  setSlotName(i, name) { this.slots[i].name = name; }

  setUVScale(i, v)    { this.slotUniforms[i].uUVScale.value   = v; }
  setNormalStr(i, v)  { this.slotUniforms[i].uNormalStr.value = v; }
  setAOStr(i, v)      { this.slotUniforms[i].uAOStr.value     = v; }
  setRoughStr(i, v)   { this.slotUniforms[i].uRoughStr.value  = v; }

  // ── Preview colour for a slot (centre pixel of the albedo layer) ───────────
  getPreviewColor(i) {
    const mid = (SLOT_RES * SLOT_RES * 0.5 + SLOT_RES * 0.5) | 0;
    const off = (i * SLOT_RES * SLOT_RES + mid) * 4;
    return [this._albedoData[off], this._albedoData[off+1], this._albedoData[off+2]];
  }

  // Returns the array that createSplatOverlay() expects as `layerSlots`
  getLayerUniforms() { return this.slotUniforms; }
}
