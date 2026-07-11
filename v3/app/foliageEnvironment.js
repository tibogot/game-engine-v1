/**
 * V2 billboard foliage stack wired for V3 — cross-plane cards (ferns, flowers,
 * reeds…) painted with a scatter brush. Grass and trees have their own modes;
 * this is the middle tier between them.
 */
import * as THREE from "three";
import { FoliageStore } from "../../v2/core/foliage/foliageStore.js";
import { BillboardRenderer } from "../../v2/render/foliage/billboardRenderer.js";
import { FoliagePaintSystem } from "../../v2/tools/foliage/foliagePaintSystem.js";
import {
  FOLIAGE_TEXTURE_DIR,
  normalizeFoliageTextureRef,
  probeFoliageTextureFile,
  applyFoliageSlotTextures,
  loadFoliageTextureFromFile,
} from "../../v2/core/foliage/foliageTexturePaths.js";

export function createFoliageEnvironment({
  scene,
  config,
  getWorldHeight,
  toolState,
}) {
  const terrainStore = { getWorldHeight };
  const foliageStore = new FoliageStore(config);
  const billboardRenderer = new BillboardRenderer(scene, config);
  const paintSystem = new FoliagePaintSystem({
    toolState,
    foliageStore,
    terrainStore,
    config,
  });

  for (let i = 0; i < toolState.foliageSlots.length; i++) {
    billboardRenderer.rebuildSlot(i, toolState.foliageSlots[i]);
  }
  applyFoliageSlotTextures(billboardRenderer, toolState.foliageSlots).catch(() => {});

  function syncFoliageHeights() {
    foliageStore.syncAllHeights(terrainStore);
  }

  function updateFrame(camera, sunDir, timeSec) {
    billboardRenderer.update(
      foliageStore,
      camera,
      toolState.billboardFoliageLod,
      toolState.foliageSlots,
    );
    if (sunDir) billboardRenderer.updateSunDirection(sunDir);
    billboardRenderer.updateTime(timeSec);
  }

  async function loadFoliageTexture(slotIdx, preselectedFile = null) {
    const handleFile = async (file) => {
      if (!file) return;
      const filename = file.name.split(/[/\\]/).pop();
      const slot = toolState.foliageSlots[slotIdx];
      const projectUrl = await probeFoliageTextureFile(filename);

      const applyTex = (tex, persist) => {
        if (persist) {
          delete slot.texturePreviewName;
          slot.textureUrl = normalizeFoliageTextureRef(filename);
          console.log(`[V3] Foliage slot ${slotIdx} ← ${slot.textureUrl}`);
        } else {
          slot.texturePreviewName = filename;
          console.log(
            `[V3] Foliage slot ${slotIdx} preview: ${filename} (copy to ${FOLIAGE_TEXTURE_DIR} to keep after save)`,
          );
        }
        billboardRenderer.setSlotTexture(slotIdx, tex, slot);
        document
          .getElementById("foliage-panel")
          ?._updateFoliageTextureLabel?.(slotIdx);
      };

      if (projectUrl) {
        new THREE.TextureLoader().load(projectUrl, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          applyTex(tex, true);
        });
        return;
      }

      try {
        const tex = await loadFoliageTextureFromFile(file);
        applyTex(tex, false);
      } catch (err) {
        console.warn(`[V3] Foliage slot ${slotIdx}: could not load ${filename}`, err);
      }
    };

    if (preselectedFile) {
      await handleFile(preselectedFile);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      await handleFile(input.files?.[0]);
    };
    input.click();
  }

  function slotStructureChanged(slotIdx) {
    billboardRenderer.rebuildSlot(slotIdx, toolState.foliageSlots[slotIdx]);
  }

  function slotMaterialChanged(slotIdx) {
    const slot = toolState.foliageSlots[slotIdx];
    const sr = billboardRenderer.slotRender[slotIdx];
    if (sr?.textureObj) {
      billboardRenderer.setSlotTexture(slotIdx, sr.textureObj, slot);
    } else {
      billboardRenderer.updateSlotUniforms(slotIdx, slot);
    }
  }

  /** Compact instances like the tree section: [x,z,y,rotY,scale,slotIdx,nx,nz]. */
  function exportData() {
    const instances = [];
    for (const arr of foliageStore.chunks.values()) {
      for (const f of arr) {
        instances.push([f.x, f.z, f.y, f.rotY, f.scale, f.slotIdx, f.nx ?? 0, f.nz ?? 0]);
      }
    }
    // texturePreviewName is a session-only preview; never persist it.
    const slots = toolState.foliageSlots.map((s) => {
      const { texturePreviewName: _preview, ...meta } = s;
      return meta;
    });
    return { slots, instances };
  }

  function importData(d) {
    foliageStore.clear();
    if (!d) {
      // Project with no foliage must clear leftovers from the previous scene.
      return;
    }
    if (Array.isArray(d.slots)) {
      d.slots.forEach((meta, i) => {
        if (!meta || !toolState.foliageSlots[i]) return;
        const slot = toolState.foliageSlots[i];
        delete slot.texturePreviewName;
        Object.assign(slot, meta);
        if (slot.textureUrl) slot.textureUrl = normalizeFoliageTextureRef(slot.textureUrl);
        billboardRenderer.rebuildSlot(i, slot);
        // rebuildSlot keeps the previous texture; drop it if this project has none.
        if (!slot.textureUrl) billboardRenderer.setSlotTexture(i, null, slot);
      });
      applyFoliageSlotTextures(billboardRenderer, toolState.foliageSlots).catch(() => {});
    }
    for (const t of d.instances ?? []) {
      foliageStore.addFoliage(t[0], t[1], t[2], t[3], t[4], t[5], t[6] ?? 0, t[7] ?? 0);
    }
    syncFoliageHeights();
    document.getElementById("foliage-panel")?._rebuildFoliageUi?.();
  }

  return {
    foliageStore,
    billboardRenderer,
    paintSystem,
    syncFoliageHeights,
    updateFrame,
    loadFoliageTexture,
    slotStructureChanged,
    slotMaterialChanged,
    exportData,
    importData,
  };
}
