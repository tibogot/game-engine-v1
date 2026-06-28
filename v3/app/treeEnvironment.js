/**
 * V2 tree stack wired for V3 — paint, trunk/foliage/impostor LOD, height sync.
 */
import { TreeStore } from "../../v2/core/foliage/treeStore.js";
import { TreeLodRenderer } from "../../v2/render/foliage/treeLodRenderer.js";
import { FoliageLodRenderer } from "../../v2/render/foliage/foliageLodRenderer.js";
import { ImpostorRenderer } from "../../v2/render/foliage/impostorRenderer.js";
import { TreeSystem } from "../../v2/tools/foliage/treeSystem.js";
import {
  loadTreeGlbFromFile,
  openGlbPicker,
} from "../../v2/core/foliage/glbLoader.js";
import { loadFullPresetFromFile } from "../../v2/core/foliage/presetLoader.js";
import { bakeSlotImpostor, IMPOSTOR_BAKE } from "../../v2/render/foliage/impostorBake.js";

const MODELS_SEARCH_PATHS = ["../models/", "models/"];

async function probeModelsForFile(filename) {
  if (!filename) return null;
  for (const base of MODELS_SEARCH_PATHS) {
    const url = base + filename;
    try {
      const resp = await fetch(url, { method: "HEAD" });
      if (resp.ok) return url;
    } catch (_) { /* try next */ }
  }
  return null;
}

export function createTreeEnvironment({
  scene,
  renderer,
  config,
  getWorldHeight,
  toolState,
}) {
  const terrainStore = { getWorldHeight };
  const treeStore = new TreeStore(config);
  const treeLodRenderer = new TreeLodRenderer(scene, config);
  const foliageLodRenderer = new FoliageLodRenderer(scene, config);
  const impostorRenderer = new ImpostorRenderer(scene, config);
  const treeSystem = new TreeSystem({
    toolState,
    treeStore,
    terrainStore,
    config,
  });

  const _impostorBakeQueue = [];
  let _impostorBakeRunning = false;

  async function _bakeImpostorForSlot(slotIdx, optsOverride = {}) {
    const preset = foliageLodRenderer.slotPresets?.[slotIdx] || null;
    const trunkSubmeshes = treeLodRenderer.slotRender?.[slotIdx]?.lod0 || null;
    if (!preset && !trunkSubmeshes) return false;
    const opts = { ...IMPOSTOR_BAKE, ...optsOverride };
    const trunkScale = toolState.treeSlots[slotIdx]?.baseScale ?? 1;
    let leafMesh = null;
    let foliageUniforms = null;
    if (preset) {
      leafMesh = foliageLodRenderer._buildChunkSlotLod(
        [{ x: 0, y: 0, z: 0, rotY: 0, scale: trunkScale, slotIdx }],
        slotIdx,
        0,
      );
      foliageUniforms = preset.uniforms;
    }
    const result = await bakeSlotImpostor(renderer, {
      trunkSubmeshes,
      leafMesh,
      foliageUniforms,
      trunkScale,
    }, opts);
    if (leafMesh) leafMesh.geometry.dispose();
    impostorRenderer.setSlot(slotIdx, result, trunkScale, opts);
    return true;
  }

  async function _processImpostorBakeQueue() {
    if (_impostorBakeRunning) return;
    _impostorBakeRunning = true;
    try {
      while (_impostorBakeQueue.length) {
        const slotIdx = _impostorBakeQueue.shift();
        try {
          const ok = await _bakeImpostorForSlot(slotIdx);
          if (ok) console.log(`[V3] Impostor auto-baked LOD3 for slot ${slotIdx}`);
        } catch (e) {
          console.warn(`[V3] Impostor auto-bake slot ${slotIdx} failed:`, e);
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
    } finally {
      _impostorBakeRunning = false;
    }
  }

  function queueImpostorBake(slotIdx) {
    if (!_impostorBakeQueue.includes(slotIdx)) _impostorBakeQueue.push(slotIdx);
    _processImpostorBakeQueue();
  }

  if (typeof window !== "undefined") {
    window.__bakeImpostor = async (i = 0, opts = {}) => {
      const ok = await _bakeImpostorForSlot(i, opts);
      if (!ok) console.warn(`[V3] Impostor slot ${i}: load a tree preset or GLB first`);
    };
  }

  function syncTreeHeights() {
    treeStore.syncAllHeights(terrainStore);
  }

  function updateFrame(camera, sunDir, timeSec) {
    treeLodRenderer.update(treeStore, camera, toolState.foliageLod);
    foliageLodRenderer.update(treeStore, camera, toolState.foliageLod);
    impostorRenderer.update(treeStore, camera, toolState.foliageLod);
    if (sunDir) impostorRenderer.setSunDir(sunDir.x, sunDir.y, sunDir.z);
    foliageLodRenderer.updateTime(timeSec);
  }

  function foliageParamChanged(slotIdx) {
    const preset = foliageLodRenderer.slotPresets[slotIdx];
    if (!preset) return;
    const f = toolState.treeSlots[slotIdx].foliage;
    const u = preset.uniforms;
    u.bottomColor.value.set(f.bottomColor);
    u.topColor.value.set(f.topColor);
    u.colorVar.value = f.colorVar;
    u.treeColorVar.value = f.treeColorVar;
    u.alphaCutoff.value = f.alphaCutoff;
    u.normalBias.value = f.normalBias;
    u.leafWarp.value = f.leafWarp;
    u.aoStr.value = f.aoStr;
    u.sssStr.value = f.sssStr;
    u.sssPow.value = f.sssPow;
    u.sssColor.value.set(f.sssColor);
    u.rimStr.value = f.rimStr;
    u.rimPow.value = f.rimPow;
    u.rimColor.value.set(f.rimColor);
    u.windSpeed.value = f.windSpeed;
    u.windStr.value = f.windStr;
    u.windMicro.value = f.windMicro;
  }

  async function importTreeGlb(slotIdx, lod, preselectedFile = null) {
    const file = preselectedFile ?? (await openGlbPicker());
    if (!file) return;
    const { submeshes, name } = await loadTreeGlbFromFile(file);
    treeLodRenderer.setSlotModel(slotIdx, lod, submeshes, toolState.treeLod.castShadow);
    if (lod === 0) {
      toolState.treeSlots[slotIdx].name = name;
      queueImpostorBake(slotIdx);
    }
    const matchedUrl = await probeModelsForFile(file.name);
    if (matchedUrl) {
      const slot = toolState.treeSlots[slotIdx];
      if (!slot.glbFile) slot.glbFile = {};
      slot.glbFile[lod === 0 ? "lod0" : "lod1"] = file.name;
      console.log(`[V3] Tree slot ${slotIdx} LOD${lod}: ${submeshes.length} submesh(es) from ${file.name}`);
    } else {
      console.warn(`[V3] Tree slot ${slotIdx} LOD${lod}: loaded ${file.name} — put copy in /models for save/restore`);
    }
    document.getElementById("tree-panel")?._rebuildTreeUi?.();
  }

  async function loadTreePreset(slotIdx, preselectedFile = null) {
    const handleFile = async (file) => {
      if (!file) return;
      const { foliagePreset, trunkSubmeshes, trunkLod1Submeshes, json } =
        await loadFullPresetFromFile(file);
      if (trunkSubmeshes) {
        treeLodRenderer.setSlotModel(slotIdx, 0, trunkSubmeshes, toolState.treeLod.castShadow);
      }
      if (trunkLod1Submeshes) {
        treeLodRenderer.setSlotModel(slotIdx, 1, trunkLod1Submeshes, toolState.treeLod.castShadow);
      }
      foliageLodRenderer.setSlotPreset(slotIdx, foliagePreset);
      queueImpostorBake(slotIdx);
      toolState.treeSlots[slotIdx].presetFile = file.name;
      toolState.treeSlots[slotIdx].name = json.presetName || file.name.replace(/\.json$/, "");
      if (json.trunkScale != null) toolState.treeSlots[slotIdx].baseScale = json.trunkScale;
      const f = toolState.treeSlots[slotIdx].foliage;
      const m = json.material || {};
      const w = json.wind || {};
      if (m.bottomColor) f.bottomColor = m.bottomColor;
      if (m.topColor) f.topColor = m.topColor;
      if (m.colorVar != null) f.colorVar = m.colorVar;
      if (m.treeColorVar != null) f.treeColorVar = m.treeColorVar;
      if (m.alphaCutoff != null) f.alphaCutoff = m.alphaCutoff;
      if (m.normalBias != null) f.normalBias = m.normalBias;
      if (m.leafWarp != null) f.leafWarp = m.leafWarp;
      if (m.aoStr != null) f.aoStr = m.aoStr;
      if (m.sssStr != null) f.sssStr = m.sssStr;
      if (m.sssPow != null) f.sssPow = m.sssPow;
      if (m.sssColor) f.sssColor = m.sssColor;
      if (m.rimStr != null) f.rimStr = m.rimStr;
      if (m.rimPow != null) f.rimPow = m.rimPow;
      if (m.rimColor) f.rimColor = m.rimColor;
      if (w.windSpeed != null) f.windSpeed = w.windSpeed;
      if (w.windStr != null) f.windStr = w.windStr;
      if (w.windMicro != null) f.windMicro = w.windMicro;
      document.getElementById("tree-panel")?._rebuildTreeUi?.();
      console.log(`[V3] Tree preset "${json.presetName}" → slot ${slotIdx}`);
    };
    if (preselectedFile) return handleFile(preselectedFile);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      if (input.files?.[0]) await handleFile(input.files[0]);
    };
    input.click();
  }

  function removeTreeSlot(slotIdx) {
    treeLodRenderer.disposeSlot(slotIdx);
    foliageLodRenderer.clearSlot(slotIdx);
    console.log(`[V3] Tree slot ${slotIdx} models removed`);
  }

  function setCastShadow(enabled) {
    for (let i = 0; i < toolState.treeSlots.length; i++) {
      treeLodRenderer.setCastShadow(i, enabled);
    }
  }

  function dispose() {
    treeLodRenderer.dispose();
    foliageLodRenderer.dispose?.();
    impostorRenderer.dispose?.();
  }

  return {
    treeStore,
    treeSystem,
    treeLodRenderer,
    foliageLodRenderer,
    impostorRenderer,
    syncTreeHeights,
    updateFrame,
    importTreeGlb,
    loadTreePreset,
    removeTreeSlot,
    foliageParamChanged,
    setCastShadow,
    queueImpostorBake,
    dispose,
  };
}
