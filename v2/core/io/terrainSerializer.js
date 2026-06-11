/**
 * Binary terrain project serializer — save/load terrain + splat + trees + settings.
 *
 * File format (.v2terrain):
 *
 *   HEADER (28 bytes v2–v3, 30 bytes v4+):
 *     [0..3]   magic              "V2TR" (4 bytes ASCII)
 *     [4..5]   version            uint16 LE (2)
 *     [6..9]   worldSize          float32 LE
 *     [10..13] chunkSize          float32 LE
 *     [14..15] dataResolution     uint16 LE
 *     [16..17] splatResolution    uint16 LE
 *     [18..19] terrainChunkCount  uint16 LE
 *     [20..21] splatChunkCount    uint16 LE
 *     [22..25] settingsLength     uint32 LE (bytes of JSON UTF-8)
 *     [26..27] treeChunkCount     uint16 LE (version ≥ 2)
 *     [28..29] foliageChunkCount  uint16 LE (version ≥ 4)
 *
 *   SETTINGS, TERRAIN CHUNKS, SPLAT CHUNKS — same as v1
 *
 *   TREE CHUNKS (treeChunkCount entries, version ≥ 2):
 *     Per entry:
 *       cx: int16 LE, cz: int16 LE        (4 bytes)
 *       instanceCount: uint16 LE           (2 bytes)
 *       Per instance (18 bytes):
 *         x: float32 LE, z: float32 LE,
 *         rotY: float32 LE, scale: float32 LE,
 *         slotIdx: uint16 LE
 *
 *   FOLIAGE CHUNKS (foliageChunkCount entries, version ≥ 4):
 *     Per entry:
 *       cx: int16 LE, cz: int16 LE
 *       instanceCount: uint16 LE
 *       Per instance (22 bytes):
 *         x, z, y: float32 LE,
 *         rotY, scale: float32 LE,
 *         slotIdx: uint16 LE
 */

import { parseChunkKey, worldHalf } from "../terrain/chunkMath.js";
import { normalizeFoliageTextureRef } from "../foliage/foliageTexturePaths.js";
import { normalizeBillboardGrassTextureRef } from "../billboardGrass/billboardGrassTexturePaths.js";
import { getChunkCountPerAxis } from "../../app/config.js";

const MAGIC = "V2TR";
const VERSION = 4;
const HEADER_V1 = 26;
const HEADER_V2 = 28;
const HEADER_V4 = 30;
const TREE_INSTANCE_BYTES = 18;
const FOLIAGE_INSTANCE_BYTES = 22;

/**
 * Serialize terrain project to an ArrayBuffer.
 *
 * @param {object} opts
 * @param {import("../terrain/terrainStore.js").TerrainStore} opts.terrainStore
 * @param {import("../paint/splatStore.js").SplatStore} opts.splatStore
 * @param {import("../foliage/treeStore.js").TreeStore} [opts.treeStore]
 * @param {import("../foliage/foliageStore.js").FoliageStore} [opts.foliageStore]
 * @param {object} opts.config
 * @param {object} opts.toolState — serializable subset
 * @returns {ArrayBuffer}
 */
export function serializeProject({ terrainStore, splatStore, treeStore, foliageStore, config, toolState }) {
  const settingsJson = JSON.stringify(extractSerializableSettings(toolState));
  const settingsBytes = new TextEncoder().encode(settingsJson);

  const dataRes = config.world.dataResolution;
  const perAxis = dataRes + 1;
  const heightsPerChunk = perAxis * perAxis;
  const heightsBytesPerChunk = heightsPerChunk * 4;

  const splatRes = config.paint.splatResolution;
  const splatBytesPerBuf = splatRes * splatRes * 4;
  const splatBytesPerChunk = splatBytesPerBuf * 2;

  const terrainEntries = [...terrainStore.chunkDataMap.entries()];
  const splatEntries = [...splatStore.chunks.entries()];
  const treeEntries = treeStore ? [...treeStore.chunks.entries()].filter(([, t]) => t.length > 0) : [];
  const foliageEntries = foliageStore
    ? [...foliageStore.chunks.entries()].filter(([, f]) => f.length > 0)
    : [];

  let treeTotalBytes = 0;
  for (const [, trees] of treeEntries) {
    treeTotalBytes += 4 + 2 + trees.length * TREE_INSTANCE_BYTES;
  }

  let foliageTotalBytes = 0;
  for (const [, items] of foliageEntries) {
    foliageTotalBytes += 4 + 2 + items.length * FOLIAGE_INSTANCE_BYTES;
  }

  const totalSize =
    HEADER_V4 +
    settingsBytes.byteLength +
    terrainEntries.length * (4 + heightsBytesPerChunk) +
    splatEntries.length * (4 + splatBytesPerChunk) +
    treeTotalBytes +
    foliageTotalBytes;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let offset = 0;

  // Header (28 bytes — version 2)
  for (let i = 0; i < 4; i++) view.setUint8(offset++, MAGIC.charCodeAt(i));
  view.setUint16(offset, VERSION, true); offset += 2;
  view.setFloat32(offset, config.world.size, true); offset += 4;
  view.setFloat32(offset, config.world.chunkSize, true); offset += 4;
  view.setUint16(offset, dataRes, true); offset += 2;
  view.setUint16(offset, splatRes, true); offset += 2;
  view.setUint16(offset, terrainEntries.length, true); offset += 2;
  view.setUint16(offset, splatEntries.length, true); offset += 2;
  view.setUint32(offset, settingsBytes.byteLength, true); offset += 4;
  view.setUint16(offset, treeEntries.length, true); offset += 2;
  view.setUint16(offset, foliageEntries.length, true); offset += 2;

  // Settings JSON
  u8.set(settingsBytes, offset);
  offset += settingsBytes.byteLength;

  // Terrain chunks
  for (const [key, heights] of terrainEntries) {
    const { cx, cz } = parseChunkKey(key);
    view.setInt16(offset, cx, true); offset += 2;
    view.setInt16(offset, cz, true); offset += 2;
    u8.set(new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength), offset);
    offset += heightsBytesPerChunk;
  }

  // Splat chunks (v3: dual splatmaps — data0 + data1 per chunk)
  for (const [key, entry] of splatEntries) {
    const { cx, cz } = parseChunkKey(key);
    view.setInt16(offset, cx, true); offset += 2;
    view.setInt16(offset, cz, true); offset += 2;
    u8.set(entry.data0, offset);
    offset += splatBytesPerBuf;
    u8.set(entry.data1, offset);
    offset += splatBytesPerBuf;
  }

  // Tree chunks
  for (const [key, trees] of treeEntries) {
    const { cx, cz } = parseChunkKey(key);
    view.setInt16(offset, cx, true); offset += 2;
    view.setInt16(offset, cz, true); offset += 2;
    view.setUint16(offset, trees.length, true); offset += 2;
    for (const t of trees) {
      view.setFloat32(offset, t.x, true); offset += 4;
      view.setFloat32(offset, t.z, true); offset += 4;
      view.setFloat32(offset, t.rotY, true); offset += 4;
      view.setFloat32(offset, t.scale, true); offset += 4;
      view.setUint16(offset, t.slotIdx, true); offset += 2;
    }
  }

  // Billboard foliage chunks (version 4)
  for (const [key, items] of foliageEntries) {
    const { cx, cz } = parseChunkKey(key);
    view.setInt16(offset, cx, true); offset += 2;
    view.setInt16(offset, cz, true); offset += 2;
    view.setUint16(offset, items.length, true); offset += 2;
    for (const f of items) {
      view.setFloat32(offset, f.x, true); offset += 4;
      view.setFloat32(offset, f.z, true); offset += 4;
      view.setFloat32(offset, f.y ?? 0, true); offset += 4;
      view.setFloat32(offset, f.rotY, true); offset += 4;
      view.setFloat32(offset, f.scale, true); offset += 4;
      view.setUint16(offset, f.slotIdx, true); offset += 2;
    }
  }

  return buffer;
}

/**
 * Deserialize a .v2terrain ArrayBuffer back into terrain + splat + settings.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{ settings: object, terrainChunks: Map<string, Float32Array>, splatChunks: Map<string, Uint8Array>, worldSize: number, chunkSize: number, dataResolution: number, splatResolution: number }}
 */
export function deserializeProject(buffer) {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  let offset = 0;

  // Magic check
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (magic !== MAGIC) throw new Error(`Invalid file: expected magic "${MAGIC}", got "${magic}"`);
  offset = 4;

  const version = view.getUint16(offset, true); offset += 2;
  if (version > VERSION) {
    console.warn(`File version ${version} is newer than supported ${VERSION}; loading may fail.`);
  }

  const worldSize = view.getFloat32(offset, true); offset += 4;
  const chunkSize = view.getFloat32(offset, true); offset += 4;
  const dataResolution = view.getUint16(offset, true); offset += 2;
  const splatResolution = view.getUint16(offset, true); offset += 2;
  const terrainChunkCount = view.getUint16(offset, true); offset += 2;
  const splatChunkCount = view.getUint16(offset, true); offset += 2;
  const settingsLength = view.getUint32(offset, true); offset += 4;
  const treeChunkCount = version >= 2 ? view.getUint16(offset, true) : 0;
  if (version >= 2) offset += 2;
  const foliageChunkCount = version >= 4 ? view.getUint16(offset, true) : 0;
  if (version >= 4) offset += 2;

  // Settings JSON
  const settingsJson = new TextDecoder().decode(u8.slice(offset, offset + settingsLength));
  const settings = JSON.parse(settingsJson);
  offset += settingsLength;

  // Terrain chunks
  const perAxis = dataResolution + 1;
  const heightsPerChunk = perAxis * perAxis;
  const heightsBytesPerChunk = heightsPerChunk * 4;
  const terrainChunks = new Map();
  for (let i = 0; i < terrainChunkCount; i++) {
    const cx = view.getInt16(offset, true); offset += 2;
    const cz = view.getInt16(offset, true); offset += 2;
    const heights = new Float32Array(heightsPerChunk);
    heights.set(new Float32Array(buffer.slice(offset, offset + heightsBytesPerChunk)));
    offset += heightsBytesPerChunk;
    terrainChunks.set(`${cx},${cz}`, heights);
  }

  // Splat chunks — v3 saves dual buffers (data0 + data1); v2 saves single buffer (= data0)
  const splatBytesPerBuf = splatResolution * splatResolution * 4;
  const splatChunks = new Map();
  for (let i = 0; i < splatChunkCount; i++) {
    const cx = view.getInt16(offset, true); offset += 2;
    const cz = view.getInt16(offset, true); offset += 2;
    const d0 = new Uint8Array(splatBytesPerBuf);
    d0.set(u8.slice(offset, offset + splatBytesPerBuf));
    offset += splatBytesPerBuf;
    let d1;
    if (version >= 3) {
      d1 = new Uint8Array(splatBytesPerBuf);
      d1.set(u8.slice(offset, offset + splatBytesPerBuf));
      offset += splatBytesPerBuf;
    } else {
      d1 = new Uint8Array(splatBytesPerBuf);
    }
    splatChunks.set(`${cx},${cz}`, { d0, d1 });
  }

  // Tree chunks (version ≥ 2)
  const treeChunks = new Map();
  for (let i = 0; i < treeChunkCount; i++) {
    const cx = view.getInt16(offset, true); offset += 2;
    const cz = view.getInt16(offset, true); offset += 2;
    const instanceCount = view.getUint16(offset, true); offset += 2;
    const trees = [];
    for (let j = 0; j < instanceCount; j++) {
      const x = view.getFloat32(offset, true); offset += 4;
      const z = view.getFloat32(offset, true); offset += 4;
      const rotY = view.getFloat32(offset, true); offset += 4;
      const scale = view.getFloat32(offset, true); offset += 4;
      const slotIdx = view.getUint16(offset, true); offset += 2;
      trees.push({ x, z, y: 0, rotY, scale, slotIdx });
    }
    treeChunks.set(`${cx},${cz}`, trees);
  }

  // Billboard foliage chunks (version ≥ 4)
  const foliageChunks = new Map();
  for (let i = 0; i < foliageChunkCount; i++) {
    const cx = view.getInt16(offset, true); offset += 2;
    const cz = view.getInt16(offset, true); offset += 2;
    const instanceCount = view.getUint16(offset, true); offset += 2;
    const items = [];
    for (let j = 0; j < instanceCount; j++) {
      const x = view.getFloat32(offset, true); offset += 4;
      const z = view.getFloat32(offset, true); offset += 4;
      const y = view.getFloat32(offset, true); offset += 4;
      const rotY = view.getFloat32(offset, true); offset += 4;
      const scale = view.getFloat32(offset, true); offset += 4;
      const slotIdx = view.getUint16(offset, true); offset += 2;
      items.push({ x, z, y, rotY, scale, slotIdx });
    }
    foliageChunks.set(`${cx},${cz}`, items);
  }

  return {
    settings,
    terrainChunks,
    splatChunks,
    treeChunks,
    foliageChunks,
    worldSize,
    chunkSize,
    dataResolution,
    splatResolution,
  };
}

/** Download a Blob as a file via invisible anchor click. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

/** Max edge length for heightmap PNG (memory + `getImageData` limits). */
const HEIGHTMAP_EXPORT_MAX_DIM = 4096;

/**
 * Square PNG of world XZ heightfield. Each pixel is opaque grayscale
 * (normalized min→0, max→255 world Y inside this export). Matches
 * `BrushMask.loadFromFile` (luminance × alpha); use R=G=B, A=255.
 *
 * @param {import("../terrain/terrainStore.js").TerrainStore} terrainStore
 * @param {object} config
 * @returns {Promise<Blob>}
 */
export async function rasterizeWorldHeightmapPngBlob(terrainStore, config) {
  const half = worldHalf(config);
  const worldSize = config.world.size;
  const chunkCount = getChunkCountPerAxis(config);
  const res = config.world.dataResolution;
  let dim = chunkCount * res;
  if (dim > HEIGHTMAP_EXPORT_MAX_DIM) dim = HEIGHTMAP_EXPORT_MAX_DIM;

  const buf = new Float32Array(dim * dim);
  let minH = Infinity;
  let maxH = -Infinity;
  const invDim = 1 / dim;

  for (let j = 0; j < dim; j++) {
    const wz = half - (j + 0.5) * invDim * worldSize;
    for (let i = 0; i < dim; i++) {
      const wx = -half + (i + 0.5) * invDim * worldSize;
      const h = terrainStore.getChunkHeightfieldHeight(wx, wz);
      const idx = j * dim + i;
      buf[idx] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  const range = maxH > minH ? maxH - minH : 1;
  const imageData = new ImageData(dim, dim);
  const u8 = imageData.data;
  for (let k = 0, p = 0; k < buf.length; k++, p += 4) {
    const t = (buf[k] - minH) / range;
    const c = Math.round(Math.min(255, Math.max(0, t * 255)));
    u8[p] = c;
    u8[p + 1] = c;
    u8[p + 2] = c;
    u8[p + 3] = 255;
  }

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(dim, dim)
      : Object.assign(document.createElement("canvas"), { width: dim, height: dim });
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable for heightmap export");
  ctx.putImageData(imageData, 0, 0);

  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/png" });
  }
  const htmlCanvas = /** @type {HTMLCanvasElement} */ (canvas);
  return new Promise((resolve, reject) => {
    htmlCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png");
  });
}

/**
 * Rasterize full-world height to PNG and trigger download.
 *
 * @param {import("../terrain/terrainStore.js").TerrainStore} terrainStore
 * @param {object} config
 */
export async function downloadWorldHeightmapPng(terrainStore, config) {
  const blob = await rasterizeWorldHeightmapPngBlob(terrainStore, config);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadBlob(blob, `heightmap-${ts}.png`);
}

/** Open a file picker and resolve with the chosen File (or null on cancel). */
export function openFilePicker(accept = ".v2terrain") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Extract the JSON-safe subset of toolState we want to persist.
 * Excludes transient UI state, keeps paint config, surface, light, etc.
 */
function extractSerializableSettings(toolState) {
  return {
    terrainSurface: toolState.terrainSurface,
    textureSlots: { ...toolState.textureSlots },
    paint: {
      activeLayer: toolState.paint.activeLayer,
      layerSlotIds: [...toolState.paint.layerSlotIds],
      noiseMask: toolState.paint.noiseMask,
      noiseScale: toolState.paint.noiseScale,
      noiseOctaves: toolState.paint.noiseOctaves,
      noiseEdgeOnly: toolState.paint.noiseEdgeOnly,
      heightBlend: toolState.paint.heightBlend,
      heightContrast: toolState.paint.heightContrast,
    },
    autoCliffEnabled: toolState.autoCliffEnabled,
    autoCliff: { ...toolState.autoCliff },
    light: { ...toolState.light },
    skyMode: toolState.skyMode,
    skyExposureByMode: { ...toolState.skyExposureByMode },
    physicalSky: { ...toolState.physicalSky },
    proceduralSky: { ...toolState.proceduralSky },
    volumetricCloudDayNight: { ...toolState.volumetricCloudDayNight },
    cloudShadows: { ...toolState.cloudShadows },
    cloudGodRays: { ...toolState.cloudGodRays },
    cloudBloom: { ...toolState.cloudBloom },
    lensFlare: { ...toolState.lensFlare },
    postFx: {
      enabled: toolState.postFx.enabled,
      bloom: { ...toolState.postFx.bloom },
      fxaa: { ...toolState.postFx.fxaa },
      ssao: { ...toolState.postFx.ssao },
      polish: { ...toolState.postFx.polish },
      sharpen: { ...toolState.postFx.sharpen },
      chromaticAberration: { ...toolState.postFx.chromaticAberration },
      dof: { ...toolState.postFx.dof },
    },
    csm: { ...toolState.csm },
    fog: {
      height: { ...toolState.fog.height },
      distance: { ...toolState.fog.distance },
    },
    interior: {
      ...toolState.interior,
      manualBoxes: (toolState.interior.manualBoxes ?? []).map((b) => ({ ...b })),
    },
    volumetricCloud: { ...toolState.volumetricCloud },
    volumetricCloudOptimized: { ...toolState.volumetricCloudOptimized },
    volumetricCloudV3: { ...toolState.volumetricCloudV3 },
    borderMountains: { ...toolState.borderMountains },
    playSpawn: { ...toolState.playSpawn },
    playCamera: { ...toolState.playCamera },
    audio: {
      muteAll: toolState.audio.muteAll,
      pauseWhenHidden: toolState.audio.pauseWhenHidden,
      buses: Object.fromEntries(
        Object.entries(toolState.audio.buses).map(([k, v]) => [k, { ...v }]),
      ),
    },
    groundTsl: JSON.parse(JSON.stringify(toolState.groundTsl)),
    meadowTsl: JSON.parse(JSON.stringify(toolState.meadowTsl)),
    tslGroundUi: { ...toolState.tslGroundUi },
    treePaint: { ...toolState.treePaint },
    treeLod: { ...toolState.treeLod },
    foliagePaint: { ...toolState.foliagePaint },
    foliageLod: { ...toolState.foliageLod },
    billboardFoliageLod: { ...toolState.billboardFoliageLod },
    billboardGrassPaint: { ...toolState.billboardGrassPaint },
    billboardGrassLod: { ...toolState.billboardGrassLod },
    billboardGrassSlots: toolState.billboardGrassSlots.map((s) => {
      const out = { ...s };
      delete out.texturePreviewName;
      if (out.textureUrl?.startsWith("data:") || out.textureUrl?.startsWith("blob:")) {
        out.textureUrl = null;
      } else if (out.textureUrl) {
        out.textureUrl = normalizeBillboardGrassTextureRef(out.textureUrl);
      }
      return out;
    }),
    billboardGrassChunks: toolState._billboardGrassExportData?.() ?? null,
    foliageSlots: toolState.foliageSlots.map((s) => {
      const out = { ...s };
      delete out.texturePreviewName;
      if (out.textureUrl?.startsWith("data:") || out.textureUrl?.startsWith("blob:")) {
        out.textureUrl = null;
      } else if (out.textureUrl) {
        out.textureUrl = normalizeFoliageTextureRef(out.textureUrl);
      }
      return out;
    }),
    treeSlots: toolState.treeSlots.map((s) => ({ ...s, foliage: { ...s.foliage } })),
    grass: { ...toolState.grass },
    revoGrass: { ...toolState.revoGrass },
    revoGrassMask: toolState._revoGrassMaskExportData?.() ?? null,
    snow: { ...toolState.snow },
    snowMask: toolState._snowMaskExportData?.() ?? null,
    cliffPaintMask: toolState._cliffPaintMaskExportData?.() ?? null,
    cliffs: { ...toolState.cliffs },
    cliffInstances: toolState._cliffExportData?.() ?? null,
    props: { ...toolState.props },
    propSlots: toolState.propSlots.map((s) => ({
      name: s.name,
      ...(s.builtin ? { builtin: true } : {}),
      ...(s.live ? { live: true, factoryId: s.factoryId } : {}),
      ...(s.glbFile ? { glbFile: s.glbFile } : {}),
      ...(s.materialId ? { materialId: s.materialId } : {}),
      ...(s.triplanar ? { triplanar: true } : {}),
    })),
    propMaterialOverrides: toolState.propMaterialOverrides ?? null,
    propInstances: toolState._propExportData?.() ?? null,
    road: { ...toolState.road },
    roads: toolState._roadExportData?.() ?? null,
    fullRoad: { ...toolState.fullRoad },
    smartRoad: { ...toolState.smartRoad },
    fullRoadNetwork: toolState._fullRoadExportData?.() ?? null,
    smartRoadNetwork: toolState._smartRoadExportData?.() ?? null,
    river: { ...toolState.river },
    rivers: toolState._riverExportData?.() ?? null,
    spline: { ...toolState.spline },
    splinePath: toolState._splineExportData?.() ?? null,
    splineRoad: toolState.splineRoad ? { ...toolState.splineRoad } : null,
    water: { ...toolState.water },
    waterBodies: toolState._waterExportData?.() ?? null,
    worldOcean: { ...toolState.worldOcean },
    waterfall: { ...toolState.waterfall },
    waterfallItems: toolState._waterfallExportData?.() ?? null,
    actors: {
      ...toolState.actors,
      npcDefaults: { ...toolState.actors.npcDefaults },
      enemyDefaults: { ...toolState.actors.enemyDefaults },
      dialogue: { ...toolState.actors.dialogue },
    },
    actorSpawns: toolState._actorExportData?.() ?? null,
    decal: { ...toolState.decal },
    decals: toolState._decalExportData?.() ?? null,
    barrier: { ...toolState.barrier },
    barrierChunks: toolState._barrierExportData?.() ?? null,
    hole: { ...toolState.hole },
    holeChunks: toolState._holeExportData?.() ?? null,
    cave: { ...toolState.cave },
    caves: toolState._caveExportData?.() ?? null,
    ambientFx: { ...toolState.ambientFx },
    ambientFxEmitters: toolState._ambientFxExportData?.() ?? null,
    leafFxEmitters: toolState._leafFxExportData?.() ?? null,
    fleur: { ...toolState.fleur, colorA: { ...toolState.fleur.colorA }, colorB: { ...toolState.fleur.colorB } },
    fleurPositions: toolState._fleurExportData?.() ?? null,
    fleurInteraction: {
      interactRadius: toolState.fleur.interactRadius,
      interactStrength: toolState.fleur.interactStrength,
      interactGain: toolState.fleur.interactGain,
      windAmp: toolState.fleur.windAmp,
      windSpeed: toolState.fleur.windSpeed,
    },
  };
}

/**
 * Apply loaded settings back onto a live toolState (shallow merge per section).
 */
export function applySettings(toolState, settings) {
  if (!settings) return;
  if (settings.terrainSurface) toolState.terrainSurface = settings.terrainSurface;
  if (settings.textureSlots) Object.assign(toolState.textureSlots, settings.textureSlots);
  if (settings.paint) {
    if (settings.paint.activeLayer != null) toolState.paint.activeLayer = settings.paint.activeLayer;
    if (settings.paint.layerSlotIds) toolState.paint.layerSlotIds = settings.paint.layerSlotIds;
    if (settings.paint.noiseMask != null) toolState.paint.noiseMask = settings.paint.noiseMask;
    if (settings.paint.noiseScale != null) toolState.paint.noiseScale = settings.paint.noiseScale;
    if (settings.paint.noiseOctaves != null) toolState.paint.noiseOctaves = settings.paint.noiseOctaves;
    if (settings.paint.noiseEdgeOnly != null) toolState.paint.noiseEdgeOnly = settings.paint.noiseEdgeOnly;
    if (settings.paint.heightBlend != null) toolState.paint.heightBlend = settings.paint.heightBlend;
    if (settings.paint.heightContrast != null) toolState.paint.heightContrast = settings.paint.heightContrast;
  }
  if (settings.autoCliffEnabled != null) toolState.autoCliffEnabled = settings.autoCliffEnabled;
  if (settings.autoCliff) Object.assign(toolState.autoCliff, settings.autoCliff);
  if (settings.light) Object.assign(toolState.light, settings.light);
  if (settings.skyMode) toolState.skyMode = settings.skyMode;
  if (settings.skyExposureByMode) {
    Object.assign(toolState.skyExposureByMode, settings.skyExposureByMode);
  } else if (settings.light?.exposure != null && settings.skyMode) {
    toolState.skyExposureByMode[settings.skyMode] = settings.light.exposure;
  }
  if (settings.physicalSky) Object.assign(toolState.physicalSky, settings.physicalSky);
  if (settings.proceduralSky) Object.assign(toolState.proceduralSky, settings.proceduralSky);
  if (settings.volumetricCloudDayNight) Object.assign(toolState.volumetricCloudDayNight, settings.volumetricCloudDayNight);
  if (settings.cloudShadows) Object.assign(toolState.cloudShadows, settings.cloudShadows);
  if (settings.cloudGodRays) Object.assign(toolState.cloudGodRays, settings.cloudGodRays);
  if (settings.cloudBloom) Object.assign(toolState.cloudBloom, settings.cloudBloom);
  if (settings.lensFlare) Object.assign(toolState.lensFlare, settings.lensFlare);
  if (settings.postFx) {
    if (settings.postFx.enabled != null) {
      toolState.postFx.enabled = settings.postFx.enabled;
    }
    if (settings.postFx.bloom) {
      Object.assign(toolState.postFx.bloom, settings.postFx.bloom);
    }
    if (settings.postFx.fxaa) {
      Object.assign(toolState.postFx.fxaa, settings.postFx.fxaa);
    }
    if (settings.postFx.ssao) {
      Object.assign(toolState.postFx.ssao, settings.postFx.ssao);
    }
    if (settings.postFx.polish) {
      Object.assign(toolState.postFx.polish, settings.postFx.polish);
    }
    if (settings.postFx.sharpen) {
      Object.assign(toolState.postFx.sharpen, settings.postFx.sharpen);
    }
    if (settings.postFx.chromaticAberration) {
      Object.assign(
        toolState.postFx.chromaticAberration,
        settings.postFx.chromaticAberration,
      );
    }
    if (settings.postFx.dof) {
      Object.assign(toolState.postFx.dof, settings.postFx.dof);
    }
  }
  if (settings.csm) Object.assign(toolState.csm, settings.csm);
  if (settings.fog) {
    if (settings.fog.height) Object.assign(toolState.fog.height, settings.fog.height);
    if (settings.fog.distance) Object.assign(toolState.fog.distance, settings.fog.distance);
  }
  if (settings.interior) {
    const boxes = settings.interior.manualBoxes;
    Object.assign(toolState.interior, settings.interior);
    toolState.interior.manualBoxes = Array.isArray(boxes)
      ? boxes.map((b) => ({ ...b }))
      : [];
  }
  if (settings.volumetricCloud) {
    Object.assign(toolState.volumetricCloud, settings.volumetricCloud);
  }
  if (settings.volumetricCloudOptimized) {
    Object.assign(toolState.volumetricCloudOptimized, settings.volumetricCloudOptimized);
  }
  if (settings.volumetricCloudV3) {
    Object.assign(toolState.volumetricCloudV3, settings.volumetricCloudV3);
  }
  if (settings.borderMountains) Object.assign(toolState.borderMountains, settings.borderMountains);
  if (settings.playSpawn) Object.assign(toolState.playSpawn, settings.playSpawn);
  if (settings.playCamera) Object.assign(toolState.playCamera, settings.playCamera);
  if (settings.audio) {
    if (settings.audio.muteAll != null) toolState.audio.muteAll = settings.audio.muteAll;
    if (settings.audio.pauseWhenHidden != null) {
      toolState.audio.pauseWhenHidden = settings.audio.pauseWhenHidden;
    }
    if (settings.audio.buses) {
      for (const k of Object.keys(settings.audio.buses)) {
        if (toolState.audio.buses[k]) {
          Object.assign(toolState.audio.buses[k], settings.audio.buses[k]);
        }
      }
    }
  }
  if (settings.groundTsl) Object.assign(toolState.groundTsl, JSON.parse(JSON.stringify(settings.groundTsl)));
  if (settings.meadowTsl) Object.assign(toolState.meadowTsl, JSON.parse(JSON.stringify(settings.meadowTsl)));
  if (settings.tslGroundUi) Object.assign(toolState.tslGroundUi, settings.tslGroundUi);
  if (settings.treePaint) Object.assign(toolState.treePaint, settings.treePaint);
  if (settings.treeLod) Object.assign(toolState.treeLod, settings.treeLod);
  if (settings.billboardGrassPaint) Object.assign(toolState.billboardGrassPaint, settings.billboardGrassPaint);
  if (settings.billboardGrassLod) Object.assign(toolState.billboardGrassLod, settings.billboardGrassLod);
  if (settings.billboardGrassSlots) {
    for (let i = 0; i < settings.billboardGrassSlots.length && i < toolState.billboardGrassSlots.length; i++) {
      Object.assign(toolState.billboardGrassSlots[i], settings.billboardGrassSlots[i]);
    }
  }
  if (settings.foliagePaint) Object.assign(toolState.foliagePaint, settings.foliagePaint);
  if (settings.foliageLod) Object.assign(toolState.foliageLod, settings.foliageLod);
  if (settings.billboardFoliageLod) {
    Object.assign(toolState.billboardFoliageLod, settings.billboardFoliageLod);
  } else if (settings.foliageLod) {
    const src = settings.foliageLod;
    if (src.lod0Distance != null) toolState.billboardFoliageLod.lod0Distance = src.lod0Distance;
    if (src.lod1Distance != null) toolState.billboardFoliageLod.lod1Distance = src.lod1Distance;
    if (src.fadeOutDistance != null) toolState.billboardFoliageLod.fadeOutDistance = src.fadeOutDistance;
  }
  if (settings.foliageSlots) {
    for (let i = 0; i < settings.foliageSlots.length && i < toolState.foliageSlots.length; i++) {
      Object.assign(toolState.foliageSlots[i], settings.foliageSlots[i]);
      const n = toolState.foliageSlots[i].name;
      if (typeof n === "string" && /^Foliage \d+$/.test(n)) {
        toolState.foliageSlots[i].name = `Slot ${i + 1}`;
      }
    }
  }
  if (settings.treeSlots) {
    for (let i = 0; i < settings.treeSlots.length && i < toolState.treeSlots.length; i++) {
      Object.assign(toolState.treeSlots[i], settings.treeSlots[i]);
    }
  }
  if (settings.grass) Object.assign(toolState.grass, settings.grass);
  if (settings.revoGrass) Object.assign(toolState.revoGrass, settings.revoGrass);
  if (settings.snow) Object.assign(toolState.snow, settings.snow);
  if (settings.cliffs) Object.assign(toolState.cliffs, settings.cliffs);
  if (settings.props) Object.assign(toolState.props, settings.props);
  if (settings.propMaterialOverrides) toolState.propMaterialOverrides = settings.propMaterialOverrides;
  if (settings.road) Object.assign(toolState.road, settings.road);
  if (settings.fullRoad) Object.assign(toolState.fullRoad, settings.fullRoad);
  if (settings.smartRoad) Object.assign(toolState.smartRoad, settings.smartRoad);
  if (settings.river) Object.assign(toolState.river, settings.river);
  if (settings.spline) Object.assign(toolState.spline, settings.spline);
  if (settings.splineRoad) Object.assign(toolState.splineRoad, settings.splineRoad);
  if (settings.water) Object.assign(toolState.water, settings.water);
  if (settings.worldOcean) Object.assign(toolState.worldOcean, settings.worldOcean);
  if (settings.waterfall) Object.assign(toolState.waterfall, settings.waterfall);
  if (settings.actors) {
    Object.assign(toolState.actors, settings.actors);
    if (settings.actors.npcDefaults) Object.assign(toolState.actors.npcDefaults, settings.actors.npcDefaults);
    if (settings.actors.enemyDefaults) Object.assign(toolState.actors.enemyDefaults, settings.actors.enemyDefaults);
    if (settings.actors.dialogue) Object.assign(toolState.actors.dialogue, settings.actors.dialogue);
  }
  if (settings.decal) Object.assign(toolState.decal, settings.decal);
  if (settings.barrier) Object.assign(toolState.barrier, settings.barrier);
  if (settings.hole) Object.assign(toolState.hole, settings.hole);
  if (settings.ambientFx) Object.assign(toolState.ambientFx, settings.ambientFx);
  if (settings.fleur) {
    const src = settings.fleur;
    const dst = toolState.fleur;
    for (const k of Object.keys(src)) {
      if (k === "colorA" || k === "colorB") {
        if (src[k]) Object.assign(dst[k], src[k]);
      } else if (k in dst) {
        dst[k] = src[k];
      }
    }
  }
}
