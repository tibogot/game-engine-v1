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
import { projectAssets, isAssetRef } from "../io/projectAssets.js";
import { uiById } from "../ui/uiRoot.js";

export function createFoliageEnvironment({
  scene,
  config,
  getWorldHeight,
  // Optional (wx, wz) => boolean: true where painting must not place foliage.
  isPlacementBlocked = null,
  toolState,
}) {
  const terrainStore = { getWorldHeight, isPlacementBlocked: isPlacementBlocked ?? undefined };
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

  /**
   * Re-drape instance heights onto the terrain.
   *
   * `region` is an optional { x, z, radius } in world metres — pass it after a
   * PARTIAL terrain edit and only the chunks it covers are touched. That matters
   * far more than the height loop suggests: a full scan also bumps EVERY chunk's
   * generation, and the LOD renderers rebuild every mesh that invalidates.
   * MEASURED at 25k trees, 4 s sculpt stroke: p99 42.7 ms with the full scan vs
   * 18.3 ms with the call removed entirely, while the height loop itself is only
   * 0.8 ms. The cost is the invalidation, not the arithmetic.
   *
   * Omit `region` (project load, terrain resize, whole-map generate) for a full
   * resync.
   */
  function syncFoliageHeights(region = null) {
    if (!region) {
      foliageStore.syncAllHeights(terrainStore);
      return;
    }
    foliageStore.syncHeightsForChunks(
      foliageStore.getChunkKeysInRadius(region.x, region.z, region.radius),
      terrainStore,
    );
  }

  /** True once a slot has a texture — a project one or a session preview. */
  function isSlotLoaded(slotIdx) {
    const slot = toolState.foliageSlots[slotIdx];
    return !!(slot && (slot.textureUrl || slot.texturePreviewName));
  }

  /**
   * Data URL for the palette card: the slot's own texture drawn onto a dark
   * ground so a cut-out leaf reads against it. Cached per texture object, so a
   * panel rebuild is a map lookup rather than a redraw.
   *
   * Nothing to bake here (unlike trees, which render a real model) — the
   * texture IS the picture.
   */
  const _thumbs = new Map();
  function getSlotThumbnail(slotIdx) {
    const tex = billboardRenderer.slotRender?.[slotIdx]?.textureObj;
    const img = tex?.image;
    if (!img) { _thumbs.delete(slotIdx); return null; }
    const hit = _thumbs.get(slotIdx);
    if (hit && hit.src === img) return hit.url;
    try {
      const S = 96;
      const c = document.createElement("canvas");
      c.width = c.height = S;
      const g = c.getContext("2d");
      g.fillStyle = "#1b1b1b";
      g.fillRect(0, 0, S, S);
      g.drawImage(img, 0, 0, S, S);
      const url = c.toDataURL("image/png");
      _thumbs.set(slotIdx, { src: img, url });
      return url;
    } catch (_) {
      // Image not decoded yet, or tainted — the card falls back to initials.
      return null;
    }
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

      const applyTex = async (tex, persist) => {
        delete slot.texturePreviewName;
        if (persist) {
          slot.textureUrl = normalizeFoliageTextureRef(filename);
          console.log(`[V3] Foliage slot ${slotIdx} ← ${slot.textureUrl}`);
        } else {
          // Not in the project's texture folder: keep the file inside the project.
          slot.textureUrl = await projectAssets.addRef(file);
          console.log(`[V3] Foliage slot ${slotIdx} ← ${filename} (kept in the project file)`);
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
        await applyTex(tex, false);
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
        if (slot.textureUrl && !isAssetRef(slot.textureUrl)) {
          slot.textureUrl = normalizeFoliageTextureRef(slot.textureUrl);
        }
        billboardRenderer.rebuildSlot(i, slot);
        // rebuildSlot keeps the previous texture; drop it if this project has none.
        if (!slot.textureUrl) billboardRenderer.setSlotTexture(i, null, slot);
      });
      // Textures kept inside the project load straight from their bytes; the
      // rest go through the texture-folder lookup.
      const folderSlots = toolState.foliageSlots.map((slot, i) => {
        if (!isAssetRef(slot.textureUrl)) return slot;
        const url = projectAssets.resolveUrl(slot.textureUrl);
        if (!url) {
          console.warn(`[V3] Foliage slot ${i}: texture ${slot.textureUrl} is not in this project`);
        } else {
          new THREE.TextureLoader().load(url, (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            billboardRenderer.setSlotTexture(i, tex, slot);
          });
        }
        return { ...slot, textureUrl: null };
      });
      applyFoliageSlotTextures(billboardRenderer, folderSlots).catch(() => {});
    }
    for (const t of d.instances ?? []) {
      foliageStore.addFoliage(t[0], t[1], t[2], t[3], t[4], t[5], t[6] ?? 0, t[7] ?? 0);
    }
    syncFoliageHeights();
    uiById("foliage-panel")?._rebuildFoliageUi?.();
  }

  return {
    isSlotLoaded,
    getSlotThumbnail,
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
