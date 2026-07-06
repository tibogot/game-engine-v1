/**
 * Loads a tree preset JSON (exported from tree-unreal-showcase.html),
 * samples foliage clusters, creates TSL material, loads trunk GLB,
 * and returns everything needed for a single slot.
 */
import * as THREE from "three";
import { createFoliageMaterial, setFoliageTexture, applyPresetMaterial, updateFoliageBounds } from "../../render/foliage/foliageMaterial.js";
import { createTrunkMaterial } from "../../render/foliage/trunkMaterial.js";
import { sampleAllClusters, computeFoliageBounds, buildAllFoliageLods } from "./foliageSampler.js";
import { computeLeafTrimPolygon, buildLeafCardGeometry } from "./leafCardTrim.js";
import { buildPineFoliageLods, computePineFoliageBounds } from "./pinePlacement.js";
import { loadTreeGlbFromUrl } from "./glbLoader.js";

/**
 * Pine-editor presets (v2/pine-editor33.html) carry a `pine` param block
 * instead of arborist `clusters`. Returns { foliage, trunk, transform, rect,
 * grid, shape } or null when the preset isn't a pine layout.
 */
function getPineBlock(presetJson) {
  if (presetJson.foliageLayout !== "pine" && !presetJson.pineEditor) return null;
  const src = presetJson.pine || presetJson.params;
  if (!src || !src.foliage || !src.trunk || !src.transform) return null;
  return src;
}

const TRUNK_SEARCH_PATHS = [
  "../models/trunks/",
  "models/trunks/",
];

export async function loadFoliagePreset(presetJson) {
  const matOpts = presetJson.material || {};
  const pineBlock = getPineBlock(presetJson);
  // Pass billboard intent through both as createFoliageMaterial opts (so the
  // shader is constructed with the right initial uniform values) and into the
  // sampler (so instance matrices match what the billboard shader path expects).
  // Pine cards are oriented whorls — billboarding them would collapse the
  // silhouette, so pine always renders via the matrix (non-billboard) path.
  const billboard = pineBlock ? false : !!matOpts.billboardLeaves;

  // Shared leaf-mask atlas: when enabled, the tree samples ONE cell of a single
  // atlas image shared by every tree, instead of a standalone leafTexture. The
  // preset carries the grid config + cell but NOT the atlas image path, so we use
  // a convention (textures/leaves/leaf_atlas.png), overridable via atlas.path.
  const atlas = presetJson.atlas;
  let useAtlas = !!(atlas && atlas.enabled);
  const _size = (atlas && atlas.size) || 1024;
  const _cellPx = (atlas && atlas.cellPx) || 256;
  const _gutter = (atlas && atlas.gutter) || 12;
  let atlasGrid = useAtlas
    ? [
        atlas.cols || 4,
        _cellPx / _size,
        _gutter / _size,
        (_cellPx - 2 * _gutter) / _size,
      ]
    : undefined;
  let atlasCell = useAtlas ? (atlas.cell ?? 0) : 0;

  // Pine leaf atlas (gutterless N×N grid in the preset's own texture): the
  // editor picks a random cell per card, but the shared material samples ONE
  // uniform cell per slot — cell 0 until per-instance variants are supported.
  const _pineMat = pineBlock ? (presetJson.params?.material || {}) : {};
  const pineAtlas = !!pineBlock && _pineMat.textureMode === "atlas";
  if (pineAtlas) {
    const cols = Math.max(1, Math.round(_pineMat.atlasCols ?? 2));
    useAtlas = true;
    atlasGrid = [cols, 1 / cols, 0, 1 / cols];
    atlasCell = 0;
  }

  const foliageMat = createFoliageMaterial({
    ...matOpts,
    billboard,
    billboardYawOnly: matOpts.billboardYawOnly,
    useAtlas,
    atlasGrid,
    atlasCell,
  });
  applyPresetMaterial(foliageMat, presetJson);

  const _leafTexPath =
    useAtlas && !pineAtlas
      ? atlas.path || "textures/leaves/leaf_atlas.png"
      : presetJson.leafTexture;
  if (_leafTexPath) {
    const texPath = _leafTexPath;
    // Pine presets may embed the leaf texture as a data URL — load it as-is.
    const candidates = texPath.startsWith("data:")
      ? [texPath]
      : [`../${texPath}`, texPath];
    let tex = null;
    for (const path of candidates) {
      try {
        tex = await new Promise((resolve, reject) => {
          new THREE.TextureLoader().load(path, resolve, undefined, () =>
            reject(new Error(`Texture not found: ${path}`))
          );
        });
        break;
      } catch (_) { /* try next */ }
    }
    if (tex) {
      setFoliageTexture(foliageMat, tex);
      // The atlas always stores the mask in RED (arborist forces this). Its
      // transparent gutters fool setFoliageTexture's auto-detect into picking
      // alpha — which is opaque inside each cell → solid quads. Force red.
      // (Pine atlases are normal RGBA sheets — keep the auto-detected channel.)
      if (useAtlas && !pineAtlas) foliageMat.uniforms.maskInAlpha.value = 0;
    } else {
      console.warn(`[Foliage] Could not load leaf texture "${texPath}" — foliage will render without texture`);
    }
  }

  // ── Pine layout: whorl card placement instead of cluster sampling ─────────
  if (pineBlock) {
    // applyPresetMaterial may have re-applied the preset's billboardLeaves
    // flag — pine lods are always oriented matrices, so keep the shader in
    // the non-billboard branch no matter what the material block says.
    foliageMat.uniforms.billboard.value = 0;
    if (pineBlock.foliage?.enabled === false) {
      return {
        material: foliageMat.material,
        leafMapNode: foliageMat.leafMapNode,
        uniforms: foliageMat.uniforms,
        lods: [null, null, null],
        bounds: null,
        billboard: false,
      };
    }
    const tScale = presetJson.trunkScale ?? 1;
    const invS = tScale > 0.001 ? 1 / tScale : 1;
    const lods = buildPineFoliageLods(pineBlock, {
      trunkScale: tScale,
      rect: pineBlock.rect,
      grid: pineBlock.grid,
      shape: pineBlock.shape,
    });
    const bounds = computePineFoliageBounds(
      pineBlock,
      pineBlock.rect ?? { width: 2, height: 0.95 },
      invS,
    );
    if (bounds) {
      updateFoliageBounds(foliageMat, bounds.yMin, bounds.yMax, bounds.canopyCenter, bounds.aoRadius);
    }
    return {
      material: foliageMat.material,
      leafMapNode: foliageMat.leafMapNode,
      uniforms: foliageMat.uniforms,
      lods,
      bounds,
      billboard: false,
    };
  }

  // Trimmed leaf cards: fit an octagon to the mask so cards rasterize far
  // fewer alpha-discarded pixels. Atlas presets trim against their own cell.
  let cardGeometry = null;
  {
    const img = foliageMat.leafMapNode.value?.image;
    if (img) {
      let cellRect = null;
      if (useAtlas) {
        const cols = atlasGrid[0];
        const cellStep = atlasGrid[1];
        const gutterFrac = atlasGrid[2];
        const innerFrac = atlasGrid[3];
        const cell = atlas.cell ?? 0;
        const col = cell % cols;
        const row = Math.floor(cell / cols);
        const ox = col * cellStep + gutterFrac;             // uv space (v up)
        const oy = (cols - 1 - row) * cellStep + gutterFrac;
        // canvas space (y down):
        cellRect = { x: ox, y: 1 - oy - innerFrac, w: innerFrac, h: innerFrac };
      }
      const poly = computeLeafTrimPolygon(img, {
        maskInAlpha: foliageMat.uniforms.maskInAlpha.value > 0.5,
        cellRect,
      });
      if (poly) cardGeometry = buildLeafCardGeometry(poly);
    }
  }

  const clusters = presetJson.clusters || [];
  const tScale = presetJson.trunkScale ?? 1;
  const canopyScale = presetJson.canopyScale ?? 1;
  const { allPos, allRands } = sampleAllClusters(clusters, tScale, canopyScale);

  if (allPos.length === 0) {
    return {
      material: foliageMat.material,
      leafMapNode: foliageMat.leafMapNode,
      uniforms: foliageMat.uniforms,
      lods: [null, null, null],
      bounds: null,
    };
  }

  const bounds = computeFoliageBounds(allPos);
  updateFoliageBounds(foliageMat, bounds.yMin, bounds.yMax, bounds.canopyCenter, bounds.aoRadius);

  const lods = buildAllFoliageLods(allPos, allRands, { billboard, cardGeometry });
  cardGeometry?.dispose(); // LODs cloned it; the template is no longer needed

  return {
    material: foliageMat.material,
    leafMapNode: foliageMat.leafMapNode,
    uniforms: foliageMat.uniforms,
    lods,
    bounds,
    billboard,
  };
}

// Replace the trunk submeshes' GLB materials with the procedural bark material
// authored in arborist (preset.trunkMaterial), when useGlb is false. One shared
// material per slot (instancing-friendly); gradient bounds = union of all the
// trunk geometries' local Y so LOD0 + LOD1 stay consistent.
function applyProceduralTrunk(trunkMat, ...submeshArrays) {
  const all = [];
  for (const arr of submeshArrays) if (arr) for (const sm of arr) all.push(sm);
  if (all.length === 0) return;
  let yMin = Infinity, yMax = -Infinity;
  for (const sm of all) {
    const g = sm.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    if (g.boundingBox) {
      yMin = Math.min(yMin, g.boundingBox.min.y);
      yMax = Math.max(yMax, g.boundingBox.max.y);
    }
  }
  if (!isFinite(yMin) || yMax <= yMin) { yMin = 0; yMax = 6; }
  const { material } = createTrunkMaterial({
    botColor: trunkMat.botColor,
    topColor: trunkMat.topColor,
    roughness: trunkMat.roughness,
    yMin,
    yMax,
  });
  for (const sm of all) sm.material = material;
}

async function loadTrunkGlb(filename) {
  if (!filename) return null;
  for (const base of TRUNK_SEARCH_PATHS) {
    try {
      const result = await loadTreeGlbFromUrl(base + filename);
      return result.submeshes;
    } catch (_) { /* try next */ }
  }
  console.warn(`[Preset] Could not find trunk GLB "${filename}" in search paths`);
  return null;
}

const PRESET_SEARCH_PATHS = [
  "../tree-presets/",
  "tree-presets/",
];

/**
 * Load a preset by filename (used during project restore).
 * Searches standard preset directories for the JSON file.
 */
export async function loadFullPresetFromUrl(filename) {
  let json = null;
  for (const base of PRESET_SEARCH_PATHS) {
    try {
      const resp = await fetch(base + filename);
      if (!resp.ok) continue;
      json = await resp.json();
      break;
    } catch (_) { /* try next */ }
  }
  if (!json) throw new Error(`Preset "${filename}" not found in search paths`);

  const [foliagePreset, trunkSubmeshes, trunkLod1Submeshes] = await Promise.all([
    loadFoliagePreset(json),
    loadTrunkGlb(json.trunkFile),
    json.trunkLod1File ? loadTrunkGlb(json.trunkLod1File) : Promise.resolve(null),
  ]);

  if (json.trunkMaterial && !json.trunkMaterial.useGlb) {
    applyProceduralTrunk(json.trunkMaterial, trunkSubmeshes, trunkLod1Submeshes);
  }

  return { foliagePreset, trunkSubmeshes, trunkLod1Submeshes, json };
}

/**
 * Full one-click preset load: parses JSON, loads trunk GLB + leaf texture,
 * samples foliage clusters. Returns { foliagePreset, trunkSubmeshes, trunkLod1Submeshes, json }.
 */
export function loadFullPresetFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const json = JSON.parse(ev.target.result);

        const [foliagePreset, trunkSubmeshes, trunkLod1Submeshes] = await Promise.all([
          loadFoliagePreset(json),
          loadTrunkGlb(json.trunkFile),
          json.trunkLod1File ? loadTrunkGlb(json.trunkLod1File) : Promise.resolve(null),
        ]);

        if (json.trunkMaterial && !json.trunkMaterial.useGlb) {
          applyProceduralTrunk(json.trunkMaterial, trunkSubmeshes, trunkLod1Submeshes);
        }

        resolve({ foliagePreset, trunkSubmeshes, trunkLod1Submeshes, json });
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
