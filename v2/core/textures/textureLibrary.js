/**
 * Shared TextureLibrary — Unity/Unreal-style asset catalog for terrain shading.
 *
 * A slot bundles one material's maps (albedo + packed ORM+normal) plus per-slot
 * uniforms that the surface materials (auto-cliff + image-tex ground) consume.
 * The same slots drive the cliff texture picker, the ground texture picker, and
 * (later) paint mode's layer palette.
 *
 * Canonical packing — must match `chunkTerrainAutoCliff.js` `createCliffShadingContext`:
 *   - `albedoTex`  : sRGB CanvasTexture, RepeatWrapping
 *   - `ormTex`     : Linear DataTexture RGBA — R=Roughness, G=AO, B=NormalX, A=NormalY
 *
 * Slots are backed by stable texture objects so bound uniforms don't need to
 * re-wire when the user swaps a map; the canvas/data buffer is redrawn in-place.
 */
import * as THREE from "three";
import { uniform } from "three/tsl";

const DEFAULT_TEX_RES = 1024;

function makeAlbedoCanvasTexture(r, g, b, size = DEFAULT_TEX_RES) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Neutral ORM+normal DataTexture.
 * R=Rough (0.8), G=AO (1.0), B=NormalX (0.5 → 0), A=NormalY (0.5 → 0).
 */
function makeNeutralOrmDataTexture(size = DEFAULT_TEX_RES) {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 204;
    data[i + 1] = 255;
    data[i + 2] = 128;
    data[i + 3] = 128;
  }
  const dt = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  dt.wrapS = dt.wrapT = THREE.RepeatWrapping;
  dt.minFilter = THREE.LinearFilter;
  dt.magFilter = THREE.LinearFilter;
  dt.colorSpace = THREE.LinearSRGBColorSpace;
  dt.needsUpdate = true;
  return dt;
}

function drawImageOntoAlbedoCanvas(albedoTex, imgEl) {
  const canvas = albedoTex.image;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
  albedoTex.colorSpace = THREE.SRGBColorSpace;
  albedoTex.needsUpdate = true;
}

function packChannel(ormTex, imgEl, channelIdx) {
  const size = ormTex.image.width;
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = size;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(imgEl, 0, 0, size, size);
  const src = tctx.getImageData(0, 0, size, size).data;
  const dst = ormTex.image.data;
  for (let i = 0, n = dst.length >> 2; i < n; i++) {
    dst[i * 4 + channelIdx] = src[i * 4];
  }
  ormTex.needsUpdate = true;
}

function packNormalBA(ormTex, imgEl) {
  const size = ormTex.image.width;
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = size;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(imgEl, 0, 0, size, size);
  const src = tctx.getImageData(0, 0, size, size).data;
  const dst = ormTex.image.data;
  for (let i = 0, n = dst.length >> 2; i < n; i++) {
    dst[i * 4 + 2] = src[i * 4];
    dst[i * 4 + 3] = src[i * 4 + 1];
  }
  ormTex.needsUpdate = true;
}

/** Load via TextureLoader → get HTMLImageElement back (via `.image`). */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        const img = tex.image;
        tex.dispose();
        resolve(img);
      },
      undefined,
      (err) => reject(err),
    );
  });
}

/** Load via FileReader → HTMLImageElement for user-uploaded files. */
function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Make a fresh slot descriptor with stable textures + uniforms. */
function createSlot({
  id,
  name,
  uvScale = 3.0,
  normalStrength = 1.0,
  aoStrength = 1.0,
  roughStrength = 1.0,
}) {
  return {
    id,
    name,
    paths: { albedo: null, normal: null, ao: null, rough: null },
    uvScale,
    normalStrength,
    aoStrength,
    roughStrength,
    albedoTex: makeAlbedoCanvasTexture(160, 160, 160),
    ormTex: makeNeutralOrmDataTexture(),
    uUVScale: uniform(uvScale),
    uNormalStr: uniform(normalStrength),
    uAOStr: uniform(aoStrength),
    uRoughStr: uniform(roughStrength),
    uHasAlbedo: uniform(0),
    uHasNormal: uniform(0),
    uHasAO: uniform(0),
    uHasRough: uniform(0),
  };
}

const DEFAULT_SLOT_PRESETS = [
  {
    id: "cliff_rock",
    name: "Cliff Rock (Rock028)",
    uvScale: 20.0,
    paths: {
      albedo: "/textures/pbr_materials/Rock028/Rock028_2K-JPG_Color.jpg",
      normal: "/textures/pbr_materials/Rock028/Rock028_2K-JPG_NormalGL.jpg",
      ao: "/textures/pbr_materials/Rock028/Rock028_2K-JPG_AmbientOcclusion.jpg",
      rough: "/textures/pbr_materials/Rock028/Rock028_2K-JPG_Roughness.jpg",
    },
  },
  {
    id: "cobblestone",
    name: "Cobblestone",
    uvScale: 20.0,
    paths: {
      albedo:
        "/textures/pbr_materials/Cobblestone_Irregular_Floor_001_SD/Cobblestone_Irregular_Floor_001_basecolor.png",
      normal:
        "/textures/pbr_materials/Cobblestone_Irregular_Floor_001_SD/Cobblestone_Irregular_Floor_001_normal.png",
      ao: "/textures/pbr_materials/Cobblestone_Irregular_Floor_001_SD/Cobblestone_Irregular_Floor_001_ambientOcclusion.png",
      rough:
        "/textures/pbr_materials/Cobblestone_Irregular_Floor_001_SD/Cobblestone_Irregular_Floor_001_roughness.png",
    },
  },
  {
    id: "grass_005",
    name: "Grass 005",
    uvScale: 80.0,
    normalStrength: 0.1,
    aoStrength: 0.3,
    roughStrength: 0.1,
    paths: {
      albedo: "/textures/pbr_materials/Grass005/Grass005_1K-JPG_Color.jpg",
      normal: "/textures/pbr_materials/Grass005/Grass005_1K-JPG_NormalGL.jpg",
      ao: "/textures/pbr_materials/Grass005/Grass005_1K-JPG_AmbientOcclusion.jpg",
      rough: "/textures/pbr_materials/Grass005/Grass005_1K-JPG_Roughness.jpg",
    },
  },
  {
    id: "aerial_grass_rock",
    name: "Aerial Grass Rock",
    uvScale: 40.0,
    normalStrength: 0.5,
    roughStrength: 0.0,
    paths: {
      albedo:
        "/textures/pbr_materials/aerial-grass-rock/aerial_grass_rock_diff_2k.jpg",
      normal:
        "/textures/pbr_materials/aerial-grass-rock/aerial_grass_rock_nor_gl_2k.jpg",
      rough:
        "/textures/pbr_materials/aerial-grass-rock/aerial_grass_rock_rough_2k.jpg",
    },
  },
  {
    id: "ground_037",
    name: "Ground 037",
    uvScale: 100.0,
    normalStrength: 0.2,
    roughStrength: 0.1,
    aoStrength: 1.0,
    paths: {
      albedo: "/textures/pbr_materials/Ground037/Ground037_1K-JPG_Color.jpg",
      normal: "/textures/pbr_materials/Ground037/Ground037_1K-JPG_NormalGL.jpg",
      ao: "/textures/pbr_materials/Ground037/Ground037_1K-JPG_AmbientOcclusion.jpg",
      rough: "/textures/pbr_materials/Ground037/Ground037_1K-JPG_Roughness.jpg",
    },
  },
  {
    id: "snow_010a",
    name: "Snow 010A",
    uvScale: 3.0,
    paths: {
      albedo: "/textures/pbr_materials/Snow010A/Snow010A_1K-JPG_Color.jpg",
      normal: "/textures/pbr_materials/Snow010A/Snow010A_1K-JPG_NormalGL.jpg",
      ao: "/textures/pbr_materials/Snow010A/Snow010A_1K-JPG_AmbientOcclusion.jpg",
      rough: "/textures/pbr_materials/Snow010A/Snow010A_1K-JPG_Roughness.jpg",
    },
  },
];

/**
 * @typedef {"albedo" | "normal" | "ao" | "rough"} SlotMapKind
 */

export function createTextureLibrary() {
  /** @type {ReturnType<typeof createSlot>[]} */
  const slots = DEFAULT_SLOT_PRESETS.map((preset) => {
    const slot = createSlot({
      id: preset.id,
      name: preset.name,
      uvScale: preset.uvScale,
      normalStrength: preset.normalStrength ?? 1.0,
      aoStrength: preset.aoStrength ?? 1.0,
      roughStrength: preset.roughStrength ?? 1.0,
    });
    slot.paths = { ...preset.paths };
    return slot;
  });

  const listeners = new Set();
  function emitChange(slotId, kind) {
    for (const fn of listeners) fn({ slotId, kind });
  }

  function getSlot(slotId) {
    return slots.find((s) => s.id === slotId) || null;
  }

  function getSlotByIndex(i) {
    return slots[i] || null;
  }

  function getSlotOptionsForUi() {
    const opts = {};
    for (const s of slots) opts[s.name] = s.id;
    return opts;
  }

  function syncSlotUvUniform(slot) {
    slot.uUVScale.value = slot.uvScale;
  }
  function syncSlotStrengthUniforms(slot) {
    slot.uNormalStr.value = slot.normalStrength;
    slot.uAOStr.value = slot.aoStrength;
    slot.uRoughStr.value = slot.roughStrength;
  }

  function setSlotUvScale(slotId, value) {
    const slot = getSlot(slotId);
    if (!slot) return;
    slot.uvScale = value;
    syncSlotUvUniform(slot);
    emitChange(slotId, "uvScale");
  }

  function setSlotStrength(slotId, kind, value) {
    const slot = getSlot(slotId);
    if (!slot) return;
    if (kind === "normal") slot.normalStrength = value;
    else if (kind === "ao") slot.aoStrength = value;
    else if (kind === "rough") slot.roughStrength = value;
    else return;
    syncSlotStrengthUniforms(slot);
    emitChange(slotId, `strength:${kind}`);
  }

  /** Apply a loaded HTMLImageElement to the slot's stable texture for the given map kind. */
  function applyImageToSlot(slot, kind, imgEl) {
    if (kind === "albedo") {
      drawImageOntoAlbedoCanvas(slot.albedoTex, imgEl);
      slot.uHasAlbedo.value = 1;
    } else if (kind === "normal") {
      packNormalBA(slot.ormTex, imgEl);
      slot.uHasNormal.value = 1;
    } else if (kind === "ao") {
      packChannel(slot.ormTex, imgEl, 1);
      slot.uHasAO.value = 1;
    } else if (kind === "rough") {
      packChannel(slot.ormTex, imgEl, 0);
      slot.uHasRough.value = 1;
    }
  }

  async function replaceMapFromUrl(slotId, kind, url) {
    const slot = getSlot(slotId);
    if (!slot) return;
    const img = await loadImage(url);
    applyImageToSlot(slot, kind, img);
    slot.paths[kind] = url;
    emitChange(slotId, `map:${kind}`);
  }

  async function replaceMapFromFile(slotId, kind, file) {
    const slot = getSlot(slotId);
    if (!slot) return;
    const img = await loadImageFromFile(file);
    applyImageToSlot(slot, kind, img);
    slot.paths[kind] = `upload:${file.name}`;
    emitChange(slotId, `map:${kind}`);
  }

  /** Reset one map to neutral (matches `makeNeutralOrmDataTexture` / default albedo grey). */
  function clearSlotMap(slotId, kind) {
    const slot = getSlot(slotId);
    if (!slot) return;
    if (kind === "albedo") {
      const canvas = slot.albedoTex.image;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgb(160,160,160)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      slot.albedoTex.needsUpdate = true;
      slot.uHasAlbedo.value = 0;
      slot.paths.albedo = null;
    } else if (kind === "normal") {
      const dst = slot.ormTex.image.data;
      for (let i = 0, n = dst.length >> 2; i < n; i++) {
        dst[i * 4 + 2] = 128;
        dst[i * 4 + 3] = 128;
      }
      slot.ormTex.needsUpdate = true;
      slot.uHasNormal.value = 0;
      slot.paths.normal = null;
    } else if (kind === "ao") {
      const dst = slot.ormTex.image.data;
      for (let i = 0, n = dst.length >> 2; i < n; i++) dst[i * 4 + 1] = 255;
      slot.ormTex.needsUpdate = true;
      slot.uHasAO.value = 0;
      slot.paths.ao = null;
    } else if (kind === "rough") {
      const dst = slot.ormTex.image.data;
      for (let i = 0, n = dst.length >> 2; i < n; i++) dst[i * 4] = 204;
      slot.ormTex.needsUpdate = true;
      slot.uHasRough.value = 0;
      slot.paths.rough = null;
    } else return;
    emitChange(slotId, `map:${kind}`);
  }

  async function loadSlotAllMaps(slot) {
    const tasks = [];
    if (slot.paths.albedo) tasks.push(["albedo", slot.paths.albedo]);
    if (slot.paths.normal) tasks.push(["normal", slot.paths.normal]);
    if (slot.paths.ao) tasks.push(["ao", slot.paths.ao]);
    if (slot.paths.rough) tasks.push(["rough", slot.paths.rough]);
    await Promise.all(
      tasks.map(async ([kind, url]) => {
        try {
          const img = await loadImage(url);
          applyImageToSlot(slot, kind, img);
        } catch (err) {
          console.warn(`TextureLibrary: failed to load ${kind} for ${slot.id}`, err);
        }
      }),
    );
    emitChange(slot.id, "loaded");
  }

  /** Load all default slot maps in parallel. */
  async function loadDefaultsAsync() {
    await Promise.all(slots.map((s) => loadSlotAllMaps(s)));
  }

  function addOnChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  let _nextSlotIdx = slots.length + 1;

  function addSlot(name, uvScale = 3.0) {
    const id = `custom_${Date.now()}_${_nextSlotIdx}`;
    const displayName = name || `Texture ${_nextSlotIdx}`;
    _nextSlotIdx++;
    const slot = createSlot({ id, name: displayName, uvScale });
    slots.push(slot);
    syncSlotUvUniform(slot);
    syncSlotStrengthUniforms(slot);
    emitChange(id, "slots");
    return slot;
  }

  function removeSlot(slotId) {
    const idx = slots.findIndex((s) => s.id === slotId);
    if (idx < 0 || slots.length <= 1) return false;
    const slot = slots[idx];
    slot.albedoTex.dispose();
    slot.ormTex.dispose();
    slots.splice(idx, 1);
    emitChange(slotId, "slots");
    return true;
  }

  function renameSlot(slotId, newName) {
    const slot = getSlot(slotId);
    if (!slot) return;
    slot.name = newName;
    emitChange(slotId, "slots");
  }

  function dispose() {
    for (const s of slots) {
      s.albedoTex.dispose();
      s.ormTex.dispose();
    }
    listeners.clear();
  }

  for (const s of slots) {
    syncSlotUvUniform(s);
    syncSlotStrengthUniforms(s);
  }

  return {
    slots,
    getSlot,
    getSlotByIndex,
    getSlotOptionsForUi,
    setSlotUvScale,
    setSlotStrength,
    replaceMapFromUrl,
    replaceMapFromFile,
    clearSlotMap,
    addSlot,
    removeSlot,
    renameSlot,
    loadDefaultsAsync,
    addOnChange,
    dispose,
  };
}
