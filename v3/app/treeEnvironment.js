/**
 * V2 tree stack wired for V3 — paint, trunk/foliage/impostor LOD, height sync.
 */
import * as THREE from "three";
import { TreeStore } from "../../v2/core/foliage/treeStore.js";
import { bakeObjectThumbnails } from "../../v2/tools/objectThumbnails.js";
import { TreeLodRenderer } from "../../v2/render/foliage/treeLodRenderer.js";
import { FoliageLodRenderer } from "../../v2/render/foliage/foliageLodRenderer.js";
import { ImpostorFieldRenderer as ImpostorRenderer } from "../render/trees/impostorFieldRenderer.js";
import { LeafFieldRenderer } from "../render/trees/leafFieldRenderer.js";
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
      // Dev servers answer missing files with index.html + 200 (SPA fallback)
      if (resp.ok && !resp.headers.get("content-type")?.includes("text/html")) return url;
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
  // Wraps a bake so the editor loop does not render mid-bake on the shared
  // renderer (main.js's withRendererSideWork). Optional: headless callers
  // run bakes bare.
  runRendererSideWork = null,
}) {
  const terrainStore = { getWorldHeight };
  const treeStore = new TreeStore(config);
  const treeLodRenderer = new TreeLodRenderer(scene, config);
  const foliageLodRenderer = new FoliageLodRenderer(scene, config);
  const impostorRenderer = new ImpostorRenderer(scene, config);
  // GPU leaf field: atlas merge groups render as ONE indirect draw each —
  // the chunked renderer skips them (per-slot pine/non-atlas stay chunked).
  const leafFieldRenderer = new LeafFieldRenderer(scene, renderer);
  foliageLodRenderer.externalMergeRendering = true;
  // Live Set of slot indices the field draws (merge groups + pines) — the
  // chunked renderer skips their cell meshes entirely.
  foliageLodRenderer.externalSlots = leafFieldRenderer.claimedSlots;
  const syncLeafField = () => {
    leafFieldRenderer.syncGroups(
      foliageLodRenderer.mergeGroups,
      foliageLodRenderer.slotPresets,
      treeStore,
    );
    // Claimed slots may have changed — stale chunked meshes for them must go.
    foliageLodRenderer._invalidateAllChunks();
  };
  const treeSystem = new TreeSystem({
    toolState,
    treeStore,
    terrainStore,
    config,
  });

  // ── Palette thumbnails ──────────────────────────────────────────────────
  // One small render per slot (trunk + leaf cards at the slot's base scale)
  // through the same offscreen baker the props palette uses. Cached as data
  // URLs; the panel re-reads them on _rebuildTreeUi. Bakes are chained so two
  // preset loads in a row never contend for the renderer.
  const _thumbs = new Map();
  let _thumbChain = Promise.resolve();

  function isSlotLoaded(slotIdx) {
    return !!(foliageLodRenderer.slotPresets?.[slotIdx] || treeLodRenderer.slotRender?.[slotIdx]?.lod0);
  }

  function getSlotThumbnail(slotIdx) {
    return _thumbs.get(slotIdx) ?? null;
  }

  async function _bakeSlotThumbnail(slotIdx) {
    const preset = foliageLodRenderer.slotPresets?.[slotIdx] || null;
    const trunkSubmeshes = treeLodRenderer.slotRender?.[slotIdx]?.lod0 || null;
    if (!preset && !trunkSubmeshes) {
      _thumbs.delete(slotIdx);
      return;
    }
    const trunkScale = toolState.treeSlots[slotIdx]?.baseScale ?? 1;
    // Built inside make() so the baker owns the frame; disposed here after,
    // because the baker only pops children — it never disposes (the trunk and
    // leaf MATERIALS are the live scene's and must survive).
    let leafGeoms = [];
    const make = () => {
      const group = new THREE.Group();
      if (trunkSubmeshes) {
        const sMat = new THREE.Matrix4().makeScale(trunkScale, trunkScale, trunkScale);
        for (const sm of trunkSubmeshes) {
          const m = new THREE.Mesh(sm.geometry, sm.material);
          m.matrixAutoUpdate = false;
          m.matrix.copy(sMat);
          if (sm.localMatrix) m.matrix.multiply(sm.localMatrix);
          group.add(m);
        }
      }
      if (preset) {
        const leafMeshes = foliageLodRenderer._buildChunkSlotLod(
          [{ x: 0, y: 0, z: 0, rotY: 0, scale: trunkScale, slotIdx }],
          slotIdx,
          0,
        );
        for (const lm of leafMeshes ?? []) {
          group.add(lm);
          leafGeoms.push(lm.geometry);
        }
      }
      return group;
    };
    const run = () => bakeObjectThumbnails({ renderer, size: 160, items: [{ key: "slot", make }] });
    try {
      const out = await (runRendererSideWork ? runRendererSideWork(run) : run());
      const url = out.get("slot");
      if (url) _thumbs.set(slotIdx, url);
    } finally {
      for (const g of leafGeoms) g.dispose();
      leafGeoms = [];
    }
  }

  /** Queue a thumbnail bake for a slot; the panel refreshes when it lands. */
  function queueThumbnail(slotIdx) {
    _thumbChain = _thumbChain
      .then(() => _bakeSlotThumbnail(slotIdx))
      .catch((e) => console.warn(`[V3] Tree thumbnail bake slot ${slotIdx} failed:`, e))
      .then(() => document.getElementById("tree-panel")?._rebuildTreeUi?.());
  }

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
      // _buildChunkSlotLod returns Mesh[] since cap-splitting; a single tree
      // at origin always fits in one mesh.
      const leafMeshes = foliageLodRenderer._buildChunkSlotLod(
        [{ x: 0, y: 0, z: 0, rotY: 0, scale: trunkScale, slotIdx }],
        slotIdx,
        0,
      );
      leafMesh = leafMeshes?.[0] ?? null;
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

    // Diagnostic bisect kit for tree flashing — toggle each subsystem live:
    //   __treeDebug.impostors(false)   hide the far-field impostor quads
    //   __treeDebug.leaves(false)      hide all leaf tiers
    //   __treeDebug.trunks(false)      hide all trunk meshes
    //   __treeDebug.leafShadows(false) stop LOD0 leaves casting shadows
    window.__treeDebug = {
      impostors(v = false) {
        for (const s of impostorRenderer.slots ?? []) {
          if (s?.mesh) s.mesh.visible = v;
        }
        console.log(`[treeDebug] impostors ${v ? "shown" : "hidden"}`);
      },
      leaves(v = false) {
        foliageLodRenderer.debugHide = !v;
        console.log(`[treeDebug] leaves ${v ? "shown" : "hidden"}`);
      },
      leafField(v = false) {
        for (const [, entry] of leafFieldRenderer.entries) {
          if (entry.mesh) entry.mesh.visible = v;
        }
        console.log(`[treeDebug] GPU leaf field ${v ? "shown" : "hidden"}`);
      },
      trunks(v = false) {
        for (const slot of treeLodRenderer.slotRender ?? []) {
          if (!slot) continue;
          for (const lod of [slot.lod0, slot.lod1]) {
            if (lod) for (const sm of lod) sm.instancedMesh.visible = v;
          }
        }
        console.log(`[treeDebug] trunks ${v ? "shown" : "hidden"}`);
      },
      leafShadows(v = false) {
        foliageLodRenderer.debugNoLeafShadows = !v;
        for (const [, entry] of foliageLodRenderer._chunkMeshes ?? []) {
          for (const [, se] of entry.slots) {
            if (Array.isArray(se.lod0)) for (const m of se.lod0) m.castShadow = v;
          }
        }
        console.log(`[treeDebug] leaf shadows ${v ? "on" : "off"}`);
      },
      /** Freeze all tier changes + builds — warmed meshes only (diagnostic). */
      freeze(v = true) {
        foliageLodRenderer.debugFreeze = !!v;
        console.log(`[treeDebug] foliage builds/tier-changes ${v ? "FROZEN" : "unfrozen"}`);
      },
      /** Load a preset object (or JSON string) into a slot from the console —
       *  same path as the panel's file picker, scriptable. */
      async loadPresetJson(json, slot = 0) {
        const text = typeof json === "string" ? json : JSON.stringify(json);
        await loadTreePreset(slot, new File([text], "console-preset.json", { type: "application/json" }));
      },
      /** Plant random trees for the CURRENT slot presets (spawnTestForest
       *  replaces slot 0 with a synthetic preset; this one doesn't). */
      plantForest(n = 5000, radius = 700, slot = 0) {
        for (let i = 0; i < n; i++) {
          const wx = (Math.random() * 2 - 1) * radius;
          const wz = (Math.random() * 2 - 1) * radius;
          treeStore.addTree(wx, wz, terrainStore.getWorldHeight(wx, wz), Math.random() * Math.PI * 2, 0.8 + Math.random() * 0.5, slot);
        }
        console.log(`[treeDebug] planted ${n} trees (slot ${slot}, radius ${radius}m)`);
      },
      /** Self-serve repro: build a synthetic leaf preset + plant a forest. */
      async spawnTestForest(n = 5000, radius = 700) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 64;
        const c2 = cv.getContext("2d");
        const g = c2.createRadialGradient(32, 32, 4, 32, 32, 30);
        g.addColorStop(0, "rgba(255,255,255,1)");
        g.addColorStop(0.8, "rgba(255,255,255,0.9)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        c2.fillStyle = g;
        c2.fillRect(0, 0, 64, 64);
        const preset = {
          presetName: "__test",
          leafTexture: cv.toDataURL("image/png"),
          clusters: [{
            enabled: true, count: 240, x: 0, y: 4.2, z: 0,
            rx: 2.6, ry: 2.0, rz: 2.6, scale: 1, shell: 0.65, shellThick: 0.35,
            leafSize: 0.9, scaleVar: 0.35, tiltMax: 40,
          }],
          material: {
            billboardLeaves: true, bottomColor: "#2d5a1b", topColor: "#5aaa2a",
            alphaCutoff: 0.4, sssStr: 0.25,
          },
          wind: { windSpeed: 0.9, windStr: 0, windMicro: 0 },
          trunkScale: 1,
          canopyScale: 1,
          lodDistances: { lod1: 60, lod2: 140 },
        };
        await loadTreePreset(0, new File([JSON.stringify(preset)], "__test-preset.json", { type: "application/json" }));
        for (let i = 0; i < n; i++) {
          const wx = (Math.random() * 2 - 1) * radius;
          const wz = (Math.random() * 2 - 1) * radius;
          treeStore.addTree(wx, wz, terrainStore.getWorldHeight(wx, wz), Math.random() * Math.PI * 2, 0.8 + Math.random() * 0.5, 0);
        }
        console.log(`[treeDebug] test forest planted: ${n} trees (slot 0, radius ${radius}m)`);
      },
      /** Dump per-cell LOD/fade state (diagnosing tier-transition bugs). */
      cells() {
        const out = [];
        for (const [key, entry] of foliageLodRenderer._chunkMeshes ?? []) {
          for (const [si, se] of entry.slots) {
            const tierInfo = {};
            for (const lk of ["lod0", "lod1", "lod2"]) {
              const v = se[lk];
              tierInfo[lk] = v === null ? "null" : v === false ? "false"
                : v.map((m) => `${m.visible ? "V" : "h"}${m.count}/${m._fullCount}`).join("+");
            }
            out.push({
              key, si, tier: entry.tier,
              shown: se._shownKey ?? "-", fadeFrom: se._fadeFrom ?? "-",
              fadeT: se._fadeT != null ? +se._fadeT.toFixed(2) : "-",
              ...tierInfo,
            });
          }
        }
        console.table(out);
        return out;
      },
      /** Fly ~10 s while flashing, then call this — prints blink counters. */
      stats() {
        const s = foliageLodRenderer.debugStats();
        console.log(
          `[treeDebug] frame ${s.frame} — blinks:${s.blinks} frustumHides:${s.frustumHides} `
          + `genRebuilds:${s.genRebuilds} tierSwaps:${s.tierSwaps} builds:${s.builds} `
          + `emergency:${s.emergency} orphanHides:${s.orphanHides} FIRSTDRAW-MISSES:${s.firstDrawMisses}`,
        );
        for (const n of s.notes) console.log("  " + n);
        return s;
      },
    };
  }

  function syncTreeHeights() {
    treeStore.syncAllHeights(terrainStore);
  }

  function updateFrame(camera, sunDir, timeSec) {
    treeLodRenderer.update(treeStore, camera, toolState.foliageLod);
    foliageLodRenderer.update(treeStore, camera, toolState.foliageLod);
    impostorRenderer.update(treeStore, camera, toolState.foliageLod);
    leafFieldRenderer.update(treeStore, camera, toolState.foliageLod);
    if (sunDir) {
      impostorRenderer.setSunDir(sunDir.x, sunDir.y, sunDir.z);
      leafFieldRenderer.setSunDir(sunDir.x, sunDir.y, sunDir.z);
    }
    foliageLodRenderer.updateTime(timeSec);
    leafFieldRenderer.updateTime(timeSec);
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
      queueThumbnail(slotIdx);
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
      syncLeafField();
      queueImpostorBake(slotIdx);
      queueThumbnail(slotIdx);
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
    syncLeafField();
    _thumbs.delete(slotIdx);
    document.getElementById("tree-panel")?._rebuildTreeUi?.();
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
    leafFieldRenderer.dispose?.();
  }

  return {
    treeStore,
    treeSystem,
    treeLodRenderer,
    foliageLodRenderer,
    impostorRenderer,
    leafFieldRenderer,
    syncTreeHeights,
    updateFrame,
    importTreeGlb,
    loadTreePreset,
    removeTreeSlot,
    foliageParamChanged,
    setCastShadow,
    queueImpostorBake,
    isSlotLoaded,
    getSlotThumbnail,
    queueThumbnail,
    dispose,
  };
}
