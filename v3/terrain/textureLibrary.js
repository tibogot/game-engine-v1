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
import { normalizeProcParams, albedoThumbnailUrl, PROC_RES } from "./proceduralLayer.js";
import { projectAssets, isAssetRef } from "../io/projectAssets.js";

export const NUM_LAYERS = 7;
/**
 * Per-slot texture resolution, fixed for the DataArrayTexture.
 *
 * Every source image is resized to this, so it is the ceiling on how sharp the
 * ground can ever look. It costs VRAM and boot time, NOT frame time — the
 * shader takes the same number of taps whatever the size. Both arrays together,
 * mipmaps included: 512 is about 20 MB, 1024 about 78 MB, 2048 about 314 MB.
 *
 * 1024 because several of the shipped defaults (Rock028, Rock058, the cliff and
 * cobble sets) are 2K source files that were being thrown away at 512.
 *
 * Nothing outside this file reads it, and the project format stores texture
 * REFERENCES rather than pixels, so changing it cannot invalidate a saved
 * project.
 */
export const SLOT_RES   = 1024;
// A procedural bake is copied straight into a slot layer, byte for byte.
if (PROC_RES !== SLOT_RES) throw new Error("proceduralLayer PROC_RES must equal SLOT_RES");

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
  // Terrain is viewed at grazing angles almost everywhere — without anisotropy
  // the mip chain smears ground detail into mush a few meters from the camera.
  tex.anisotropy       = 8;
  tex.needsUpdate      = true;
  return tex;
}

function _resizeImageToSlotRes(bitmap) {
  const canvas = new OffscreenCanvas(SLOT_RES, SLOT_RES);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, SLOT_RES, SLOT_RES);
  return canvas.getContext("2d").getImageData(0, 0, SLOT_RES, SLOT_RES).data;
}

/** Display name for a map reference: the stored asset's filename, or the URL's last segment. */
function _refName(url) {
  return isAssetRef(url) ? (projectAssets.nameOf(url) ?? "imported") : url.split("/").pop();
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

    // Textures with a WHOLE-array upload still pending. A single-layer upload
    // (procedural re-bake) must not replace one of those, or the other layer's
    // new pixels would never reach the GPU. The renderer calls onUpdate once
    // the upload has actually happened.
    // Both start pending: the very first upload creates the GPU texture and
    // must carry every layer.
    this._fullUploadPending = new Set([this.albedoArrayTex, this.ormArrayTex]);
    for (const tex of [this.albedoArrayTex, this.ormArrayTex]) {
      tex.onUpdate = () => this._fullUploadPending.delete(tex);
    }

    // Procedural slots: a factory rather than an instance, so a game that never
    // touches a procedural layer never allocates the bake targets.
    this._procBakerFactory = null;
    this._procBaker = null;
    this._procQueue = Promise.resolve();
    this._procLatest = new Map(); // slot → newest requested params (coalesces slider drags)
    this._procRunning = new Map(); // slot → promise of its bake loop
    this._procGen = new Array(NUM_LAYERS).fill(0); // bumped to cancel a slot's in-flight bake

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
      // What the project SAVES for each map: a server path (/textures/…) or,
      // for a file imported from disk, an "asset:<hash>" kept inside the project.
      albedoRef:   null,
      normalRef:   null,
      roughRef:    null,
      aoRef:       null,
      // null = the slot shows its image maps. Otherwise the params of a
      // procedural texture baked into this slot (see proceduralLayer.js); the
      // image references above are kept so switching back can restore them.
      procedural:    null,
      procThumbUrl:  null,
      // Vegetation blocking: where this layer is painted, grass/susuki thin
      // out and tree/foliage painting places nothing. Off by default, so no
      // existing project changes; the path and shore presets switch them on.
      blocksGrass:   false,
      blocksTrees:   false,
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
      // 1 = project this layer on all three world axes instead of straight
      // down. OFF by default: it triples the taps for that layer everywhere it
      // is used, so it is meant for a rock layer on steep ground, not for
      // everything. See the long note in splatOverlayTsl.js.
      uTriplanar: uniform(0.0),
      // 1 = height blending reads this layer's height from its albedo alpha
      // instead of its luminance. Set only while the slot is procedural (the
      // bake writes a blend height there); image slots stay on luminance.
      uHeightFromAlpha: uniform(0.0),
      // AUDIT 5 — reuse one texture twice. Tint multiplies the layer's albedo
      // (white = unchanged). The UV rotation turns the straight-down projection
      // about world Y; the shader wants its cos/sin, the panel and the save
      // file want degrees, which live on the slot (uvRotation).
      uTint:  uniform(new THREE.Color(1, 1, 1)),
      uUVRot: uniform(new THREE.Vector2(1, 0)),
    }));
    for (const s of this.slots) s.uvRotation = 0;
  }

  // ── GPU upload ─────────────────────────────────────────────────────────────

  /** Re-upload every layer of an array texture (the original behaviour). */
  _uploadAll(tex) {
    tex.clearLayerUpdates();
    this._fullUploadPending.add(tex);
    tex.needsUpdate = true;
  }

  /**
   * Re-upload ONE layer. A procedural re-bake changes a single slot, and
   * re-sending all seven 1024² layers on every slider move is ~28 MB per
   * texture. Falls back to a full upload when one is already pending.
   */
  _uploadLayer(tex, layer) {
    if (!this._fullUploadPending.has(tex)) tex.addLayerUpdate(layer);
    tex.needsUpdate = true;
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
    // Dropping an image onto a procedural slot turns it back into an image slot.
    this._dropProcedural(slotIndex);
    const bm  = await createImageBitmap(file);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const off = slotIndex * SLOT_RES * SLOT_RES * 4;
    this._albedoData.set(px, off);
    this._uploadAll(this.albedoArrayTex);
    const albedoRef = await projectAssets.addRef(file);
    this.slots[slotIndex].albedoName = file.name;
    this.slots[slotIndex].albedoRef  = albedoRef;
    this.slots[slotIndex].albedoUrl  = projectAssets.resolveUrl(albedoRef);
  }

  async loadNormalMap(slotIndex, file) {
    // Dropping an image onto a procedural slot turns it back into an image slot.
    this._dropProcedural(slotIndex);
    const bm  = await createImageBitmap(file);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) {
      this._ormData[off + i*4+2] = px[i*4];     // R → B (normal X)
      this._ormData[off + i*4+3] = px[i*4+1];   // G → A (normal Y)
    }
    this._uploadAll(this.ormArrayTex);
    const normalRef = await projectAssets.addRef(file);
    this.slots[slotIndex].normalName = file.name;
    this.slots[slotIndex].normalRef  = normalRef;
    this.slots[slotIndex].normalUrl  = projectAssets.resolveUrl(normalRef);
  }

  async loadRoughness(slotIndex, file) {
    // Dropping an image onto a procedural slot turns it back into an image slot.
    this._dropProcedural(slotIndex);
    const bm  = await createImageBitmap(file);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4] = px[i*4]; // R → roughness
    this._uploadAll(this.ormArrayTex);
    const roughRef = await projectAssets.addRef(file);
    this.slots[slotIndex].roughName = file.name;
    this.slots[slotIndex].roughRef  = roughRef;
    this.slots[slotIndex].roughUrl  = projectAssets.resolveUrl(roughRef);
  }

  async loadAO(slotIndex, file) {
    // Dropping an image onto a procedural slot turns it back into an image slot.
    this._dropProcedural(slotIndex);
    const bm  = await createImageBitmap(file);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4+1] = px[i*4]; // R → AO
    this._uploadAll(this.ormArrayTex);
    const aoRef = await projectAssets.addRef(file);
    this.slots[slotIndex].aoName = file.name;
    this.slots[slotIndex].aoRef  = aoRef;
    this.slots[slotIndex].aoUrl  = projectAssets.resolveUrl(aoRef);
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
    const real = projectAssets.resolveUrl(url);
    if (!real) throw new Error(`asset not in this project: ${url}`);
    const resp = await fetch(real);
    const blob = await resp.blob();
    return createImageBitmap(blob);
  }

  async loadAlbedoFromUrl(slotIndex, url) {
    const bm  = await this._bitmapFromUrl(url);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const off = slotIndex * SLOT_RES * SLOT_RES * 4;
    this._albedoData.set(px, off);
    this._uploadAll(this.albedoArrayTex);
    this.slots[slotIndex].albedoName = _refName(url);
    this.slots[slotIndex].albedoRef  = url;
    this.slots[slotIndex].albedoUrl  = projectAssets.resolveUrl(url);
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
    this._uploadAll(this.ormArrayTex);
    this.slots[slotIndex].normalName = _refName(url);
    this.slots[slotIndex].normalRef  = url;
    this.slots[slotIndex].normalUrl  = projectAssets.resolveUrl(url);
  }

  async loadRoughnessFromUrl(slotIndex, url) {
    const bm  = await this._bitmapFromUrl(url);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4] = px[i*4];
    this._uploadAll(this.ormArrayTex);
    this.slots[slotIndex].roughName = _refName(url);
    this.slots[slotIndex].roughRef  = url;
    this.slots[slotIndex].roughUrl  = projectAssets.resolveUrl(url);
  }

  async loadAOFromUrl(slotIndex, url) {
    const bm  = await this._bitmapFromUrl(url);
    const px  = _resizeImageToSlotRes(bm);
    bm.close();
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4+1] = px[i*4];
    this._uploadAll(this.ormArrayTex);
    this.slots[slotIndex].aoName = _refName(url);
    this.slots[slotIndex].aoRef  = url;
    this.slots[slotIndex].aoUrl  = projectAssets.resolveUrl(url);
  }

  preloadDefaults() {
    this._defaultsPromise = this._preloadDefaults();
    return this._defaultsPromise;
  }

  async _preloadDefaults() {
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
    this._uploadAll(this.albedoArrayTex);
    this.slots[slotIndex].albedoName = null;
    this.slots[slotIndex].albedoUrl  = null;
    this.slots[slotIndex].albedoRef  = null;
  }

  clearNormal(slotIndex) {
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) {
      this._ormData[off + i*4+2] = 128; // normalX → flat
      this._ormData[off + i*4+3] = 128; // normalY → flat
    }
    this._uploadAll(this.ormArrayTex);
    this.slots[slotIndex].normalName = null;
    this.slots[slotIndex].normalUrl  = null;
    this.slots[slotIndex].normalRef  = null;
  }

  clearRoughness(slotIndex) {
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4] = 204; // 0.8
    this._uploadAll(this.ormArrayTex);
    this.slots[slotIndex].roughName = null;
    this.slots[slotIndex].roughUrl  = null;
    this.slots[slotIndex].roughRef  = null;
  }

  clearAO(slotIndex) {
    const n   = SLOT_RES * SLOT_RES;
    const off = slotIndex * n * 4;
    for (let i = 0; i < n; i++) this._ormData[off + i*4+1] = 255; // 1.0
    this._uploadAll(this.ormArrayTex);
    this.slots[slotIndex].aoName = null;
    this.slots[slotIndex].aoUrl  = null;
    this.slots[slotIndex].aoRef  = null;
  }

  // ── Slot settings ──────────────────────────────────────────────────────────

  setSlotName(i, name) { this.slots[i].name = name; }

  // ── Procedural slots ───────────────────────────────────────────────────────

  /** `() => ProceduralLayerBaker` — called once, the first time a slot bakes. */
  setProceduralBakerFactory(fn) { this._procBakerFactory = fn; }

  /**
   * Make slot i procedural with these params and bake it.
   *
   * COALESCES per slot: while a bake runs, only the newest request is kept, so
   * a slider drag bakes as fast as the GPU allows and never works through a
   * backlog of stale values. Bakes for different slots run one at a time
   * because they share the baker's render targets.
   *
   * The slot is marked procedural immediately, so a save made while the bake
   * is still running records it. Resolves when the newest params are showing.
   */
  requestProcedural(i, params) {
    this.slots[i].procedural = normalizeProcParams(params);
    this._procLatest.set(i, this.slots[i].procedural);
    const running = this._procRunning.get(i);
    if (running) return running;
    const job = (async () => {
      try {
        while (this._procLatest.has(i)) {
          const next = this._procLatest.get(i);
          this._procLatest.delete(i);
          await this._bakeProcedural(i, next);
        }
      } finally {
        this._procRunning.delete(i);
      }
    })();
    this._procRunning.set(i, job);
    return job;
  }

  async _bakeProcedural(i, params) {
    const gen = this._procGen[i];
    const run = this._procQueue.then(() => {
      if (!this._procBaker) {
        if (!this._procBakerFactory) throw new Error("TextureLibrary: no procedural baker factory set");
        this._procBaker = this._procBakerFactory();
      }
      return this._procBaker.bake(params);
    });
    this._procQueue = run.catch(() => {});
    const { albedo, orm } = await run;
    // Switched back to images (or re-imported) while this bake was running.
    if (gen !== this._procGen[i]) return;
    const off = i * SLOT_RES * SLOT_RES * 4;
    this._albedoData.set(albedo, off);
    this._ormData.set(orm, off);
    this._uploadLayer(this.albedoArrayTex, i);
    this._uploadLayer(this.ormArrayTex, i);
    // The bake writes a blend height into albedo alpha; let height blending use it.
    this.slotUniforms[i].uHeightFromAlpha.value = 1;
    this.slots[i].procThumbUrl = albedoThumbnailUrl(albedo);
    this.onProceduralBaked?.(i);
  }

  /** Forget any procedural state for slot i and cancel its in-flight bake. */
  _dropProcedural(i) {
    this._procGen[i]++;
    this._procLatest.delete(i);
    const s = this.slots[i];
    const was = s.procedural !== null;
    s.procedural = null;
    s.procThumbUrl = null;
    this.slotUniforms[i].uHeightFromAlpha.value = 0;
    return was;
  }

  /**
   * Switch slot i back to its image maps: re-fetch the references it kept, or
   * fall back to the neutral swatch where there is nothing to fetch.
   */
  async clearProcedural(i) {
    if (!this._dropProcedural(i)) return;
    const s = this.slots[i];
    const restore = (nameKey, refKey, loadFromUrl, clear) => {
      const name = s[nameKey], url = s[refKey];
      if (!url) { clear(i); return null; }
      return loadFromUrl(i, url)
        .then(() => { s[nameKey] = name ?? s[nameKey]; })
        .catch(() => clear(i));
    };
    await Promise.all([
      restore("albedoName", "albedoRef", (k, u) => this.loadAlbedoFromUrl(k, u),    (k) => this.clearAlbedo(k)),
      restore("normalName", "normalRef", (k, u) => this.loadNormalFromUrl(k, u),    (k) => this.clearNormal(k)),
      restore("roughName",  "roughRef",  (k, u) => this.loadRoughnessFromUrl(k, u), (k) => this.clearRoughness(k)),
      restore("aoName",     "aoRef",     (k, u) => this.loadAOFromUrl(k, u),        (k) => this.clearAO(k)),
    ]);
  }

  /** Per-layer flags for the grass mask and tree/foliage placement (L1..L7). */
  blocksGrassFlags() { return this.slots.map((s) => s.blocksGrass); }
  blocksTreesFlags() { return this.slots.map((s) => s.blocksTrees); }

  setTriplanar(i, on) { this.slotUniforms[i].uTriplanar.value = on ? 1 : 0; }
  setUVScale(i, v)    { this.slotUniforms[i].uUVScale.value   = v; }
  setNormalStr(i, v)  { this.slotUniforms[i].uNormalStr.value = v; }
  setAOStr(i, v)      { this.slotUniforms[i].uAOStr.value     = v; }
  setRoughStr(i, v)   { this.slotUniforms[i].uRoughStr.value  = v; }
  /** Albedo multiplier as "#rrggbb" (sRGB, like a colour input). */
  setTint(i, hex)     { this.slotUniforms[i].uTint.value.set(hex); }
  getTintHex(i)       { return `#${this.slotUniforms[i].uTint.value.getHexString()}`; }
  /** Projection turn in degrees, any value (stored wrapped to 0..360). */
  setUVRotation(i, deg) {
    const d = ((Number(deg) % 360) + 360) % 360;
    this.slots[i].uvRotation = d;
    const r = d * Math.PI / 180;
    this.slotUniforms[i].uUVRot.value.set(Math.cos(r), Math.sin(r));
  }

  // ── Preview colour for a slot (centre pixel of the albedo layer) ───────────
  getPreviewColor(i) {
    const mid = (SLOT_RES * SLOT_RES * 0.5 + SLOT_RES * 0.5) | 0;
    const off = (i * SLOT_RES * SLOT_RES + mid) * 4;
    return [this._albedoData[off], this._albedoData[off+1], this._albedoData[off+2]];
  }

  // ── Project persistence ───────────────────────────────────────────────────
  //
  // Layer setup used to live nowhere: not in the .v3proj, not in localStorage.
  // Every load ran preloadDefaults() over the top, so a renamed layer, a
  // different material, a tiling scale or an auto-paint rule was gone on reload
  // while the PAINTED WEIGHTS survived in the project blob — the ground came
  // back looking wrong with the painting intact, which is a horrible thing to
  // debug.
  //
  // Pixels are deliberately NOT stored. A project already carries a heightmap
  // and splat blob; adding seven 1024² albedo + ORM pairs would add tens of
  // megabytes for data that is sitting in /textures. References are stored the
  // way tree slots store preset filenames.

  /** Slot metadata for encodeProjectFile({ paintLayers }). */
  exportData() {
    const ref = (name, url) => {
      if (!name && !url) return null;
      // A server path, or "asset:<hash>" for a file kept inside the project.
      // A bare object URL can only come from an older code path; it dies with
      // the page, so keep just the name.
      const keep = url && !/^(blob:|data:)/.test(url) ? url : null;
      return { name: name ?? null, url: keep };
    };
    return this.slots.map((s, i) => {
      const u = this.slotUniforms[i];
      return {
        name:      s.name,
        albedo:    ref(s.albedoName, s.albedoRef),
        normal:    ref(s.normalName, s.normalRef),
        rough:     ref(s.roughName,  s.roughRef),
        ao:        ref(s.aoName,     s.aoRef),
        uvScale:   u.uUVScale.value,
        normalStr: u.uNormalStr.value,
        aoStr:     u.uAOStr.value,
        roughStr:  u.uRoughStr.value,
        triplanar: u.uTriplanar.value > 0.5,
        tint:      this.getTintHex(i),
        uvRotation: s.uvRotation,
        // Params only, never pixels: the bake is deterministic, so loading
        // re-generates exactly the same texture.
        procedural: s.procedural ? { ...s.procedural } : null,
        blocksGrass: s.blocksGrass,
        blocksTrees: s.blocksTrees,
        auto: {
          enabled:   s.autoEnabled,
          heightMin: s.autoHeightMin,
          heightMax: s.autoHeightMax,
          slopeMin:  s.autoSlopeMin,
          slopeMax:  s.autoSlopeMax,
          blend:     s.autoBlend,
          strength:  s.autoStrength,
        },
      };
    });
  }

  /**
   * Restore slot metadata and re-fetch the referenced maps.
   *
   * AWAITS preloadDefaults FIRST. Those are async URL loads fired at boot; if a
   * project is opened while they are still in flight they land afterwards and
   * overwrite everything restored here, which looks exactly like the bug this
   * whole method exists to fix.
   */
  async importData(data) {
    if (!Array.isArray(data)) return;
    try { await this._defaultsPromise; } catch (_) { /* defaults are best-effort */ }

    const missing = [];
    const jobs = [];
    const n = Math.min(NUM_LAYERS, data.length);
    for (let i = 0; i < n; i++) {
      const d = data[i];
      if (!d) continue;
      const s = this.slots[i];
      const u = this.slotUniforms[i];
      if (typeof d.name === "string") s.name = d.name;
      // Absent in older files = false, their behaviour before these existed.
      s.blocksGrass = d.blocksGrass === true;
      s.blocksTrees = d.blocksTrees === true;
      if (Number.isFinite(d.uvScale))   u.uUVScale.value   = d.uvScale;
      if (Number.isFinite(d.normalStr)) u.uNormalStr.value = d.normalStr;
      if (Number.isFinite(d.aoStr))     u.uAOStr.value     = d.aoStr;
      if (Number.isFinite(d.roughStr))  u.uRoughStr.value  = d.roughStr;
      if (d.triplanar != null) u.uTriplanar.value = d.triplanar ? 1 : 0;
      // Absent in older files = white / 0, which is what they rendered.
      this.setTint(i, typeof d.tint === "string" && /^#[0-9a-f]{6}$/i.test(d.tint) ? d.tint : "#ffffff");
      this.setUVRotation(i, Number.isFinite(d.uvRotation) ? d.uvRotation : 0);
      const a = d.auto;
      if (a) {
        s.autoEnabled = !!a.enabled;
        if (Number.isFinite(a.heightMin)) s.autoHeightMin = a.heightMin;
        if (Number.isFinite(a.heightMax)) s.autoHeightMax = a.heightMax;
        if (Number.isFinite(a.slopeMin))  s.autoSlopeMin  = a.slopeMin;
        if (Number.isFinite(a.slopeMax))  s.autoSlopeMax  = a.slopeMax;
        if (Number.isFinite(a.blend))     s.autoBlend     = a.blend;
        if (Number.isFinite(a.strength))  s.autoStrength  = a.strength;
      }
      if (d.procedural && typeof d.procedural === "object") {
        // Keep the image references (so switching the slot back to Image can
        // restore them) but do not fetch them: the bake owns the pixels.
        const keepRef = (r, key) => {
          if (r) {
            s[`${key}Name`] = r.name ?? null;
            s[`${key}Ref`] = r.url ?? null;
            s[`${key}Url`] = r.url ? projectAssets.resolveUrl(r.url) : null;
          }
        };
        keepRef(d.albedo, "albedo");
        keepRef(d.normal, "normal");
        keepRef(d.rough,  "rough");
        keepRef(d.ao,     "ao");
        jobs.push(this.requestProcedural(i, d.procedural).catch((err) => {
          console.warn(`[V3] Paint layer ${i + 1}: procedural bake failed`, err);
        }));
        continue;
      }
      // An image slot in the file: a procedural bake still running for this
      // slot from the current session must not land on top of it.
      const wasProcedural = this._dropProcedural(i);
      const fetchMap = (r, load, clear) => {
        if (!r) { if (wasProcedural) clear(i); return; }
        if (r.url) jobs.push(load(i, r.url).catch(() => missing.push(r.name ?? r.url)));
        else if (r.name) missing.push(r.name);
      };
      fetchMap(d.albedo, (k, url) => this.loadAlbedoFromUrl(k, url), (k) => this.clearAlbedo(k));
      fetchMap(d.normal, (k, url) => this.loadNormalFromUrl(k, url),    (k) => this.clearNormal(k));
      fetchMap(d.rough,  (k, url) => this.loadRoughnessFromUrl(k, url), (k) => this.clearRoughness(k));
      fetchMap(d.ao,     (k, url) => this.loadAOFromUrl(k, url),        (k) => this.clearAO(k));
    }
    await Promise.all(jobs);
    if (missing.length) {
      console.warn(
        `[V3] Paint layers: ${missing.length} texture(s) not restored (saved before imported ` +
        `files were kept in the project, or not found on the server): ` +
        missing.join(", "),
      );
    }
  }

  // Returns the array that createSplatOverlay() expects as `layerSlots`
  getLayerUniforms() { return this.slotUniforms; }
}
