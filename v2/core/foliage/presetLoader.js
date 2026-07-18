/**
 * Loads a tree preset JSON (exported from tree-unreal-showcase.html),
 * samples foliage clusters, creates TSL material, loads trunk GLB,
 * and returns everything needed for a single slot.
 */
import * as THREE from "three";
import { createFoliageMaterial, setFoliageTexture, applyPresetMaterial, updateFoliageBounds } from "../../render/foliage/foliageMaterial.js";
import { createTrunkMaterial, createPineBarkMaterial } from "../../render/foliage/trunkMaterial.js";
import { sampleAllClusters, computeFoliageBounds, buildAllFoliageLods } from "./foliageSampler.js";
import { computeLeafTrimPolygon, buildLeafCardGeometry } from "./leafCardTrim.js";
import { buildPineFoliageLods, computePineFoliageBounds, buildPineTrunkGeometry } from "./pinePlacement.js";
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
  const useAtlas = !!(atlas && atlas.enabled);
  const _size = (atlas && atlas.size) || 1024;
  const _cellPx = (atlas && atlas.cellPx) || 256;
  const _gutter = (atlas && atlas.gutter) || 12;
  const atlasGrid = useAtlas
    ? [
        atlas.cols || 4,
        _cellPx / _size,
        _gutter / _size,
        (_cellPx - 2 * _gutter) / _size,
      ]
    : undefined;
  const atlasCell = useAtlas ? (atlas.cell ?? 0) : 0;

  // Pine leaf atlas: a gutterless cols×rows grid inside the preset's own leaf
  // texture, with a cell picked per card (see foliageMaterial's pine branch).
  // Independent of the shared arborist atlas above — a preset uses one or the
  // other, never both.
  const _pineMat = pineBlock ? (presetJson.params?.material || {}) : {};
  const pineAtlas = !!pineBlock && _pineMat.textureMode === "atlas";

  const foliageMat = createFoliageMaterial({
    ...matOpts,
    billboard,
    billboardYawOnly: matOpts.billboardYawOnly,
    useAtlas,
    atlasGrid,
    atlasCell,
    pineAtlas,
    pineAtlasCols: pineAtlas ? Math.max(1, Math.round(_pineMat.atlasCols ?? 2)) : 2,
    pineAtlasRows: pineAtlas ? Math.max(1, Math.round(_pineMat.atlasRows ?? 2)) : 2,
  });
  applyPresetMaterial(foliageMat, presetJson);

  const _leafTexPath = useAtlas
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
      // The shared atlas always stores the mask in RED (arborist forces this).
      // Its transparent gutters fool setFoliageTexture's auto-detect into
      // picking alpha — which is opaque inside each cell → solid quads. Force
      // red. (Pine sheets are normal RGBA — keep the auto-detected channel.)
      if (useAtlas) foliageMat.uniforms.maskInAlpha.value = 0;
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

    // Fill trim: fit the octagon to the pine mask so cards rasterize far
    // fewer alpha-discarded pixels. With the per-card atlas the polygon must
    // cover EVERY cell a card might draw, so the cells are composited
    // (lighten ≈ per-pixel max) into one union mask first.
    let trimPolygon = null;
    {
      const img = foliageMat.leafMapNode.value?.image;
      if (img) {
        let trimSrc = img;
        if (pineAtlas) {
          try {
            const cols = Math.max(1, Math.round(_pineMat.atlasCols ?? 2));
            const rows = Math.max(1, Math.round(_pineMat.atlasRows ?? 2));
            const S = 64;
            const cv = document.createElement("canvas");
            cv.width = cv.height = S;
            const ctx = cv.getContext("2d");
            ctx.globalCompositeOperation = "lighten";
            const iw = img.width ?? img.naturalWidth;
            const ih = img.height ?? img.naturalHeight;
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                ctx.drawImage(
                  img,
                  (c / cols) * iw, (r / rows) * ih, iw / cols, ih / rows,
                  0, 0, S, S,
                );
              }
            }
            trimSrc = cv;
          } catch (_) { /* tainted canvas etc. — trim against the full sheet */ }
        }
        trimPolygon = computeLeafTrimPolygon(trimSrc, {
          maskInAlpha: foliageMat.uniforms.maskInAlpha.value > 0.5,
        });
      }
    }

    const lods = buildPineFoliageLods(pineBlock, {
      trunkScale: tScale,
      rect: pineBlock.rect,
      grid: pineBlock.grid,
      shape: pineBlock.shape,
      trimPolygon,
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

  // Atlas cell rect in CANVAS space (fractions, y from the top) — used for the
  // per-cell card trim below and carried on the preset so merge groups can
  // composite member cells into a union trim.
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

  // Trimmed leaf cards: fit an octagon to the mask so cards rasterize far
  // fewer alpha-discarded pixels. Atlas presets trim against their own cell.
  let cardGeometry = null;
  {
    const img = foliageMat.leafMapNode.value?.image;
    if (img) {
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
    // Slot-merge metadata: billboard slots sampling the SAME shared atlas can
    // render as one mesh per cell (FoliageMergeGroups). Key = atlas path.
    mergeKey: useAtlas && billboard ? _leafTexPath : null,
    atlasGridArr: useAtlas ? atlasGrid : null,
    atlasCell: useAtlas ? (atlas.cell ?? 0) : 0,
    atlasCellRect: cellRect,
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

const _identity = new THREE.Matrix4();

/**
 * Build a pine trunk straight from the preset's `pine.trunk` params — the same
 * geometry the editor shows — so a pine preset needs no baked trunk GLB. LOD1
 * halves the radial segment count (silhouette curve is kept: the spine segments
 * are what make a bent trunk read as bent). Both tiers share one bark material,
 * which keeps them instancing-friendly and their bark identical across LODs.
 *
 * Returns { lod0, lod1 } submesh arrays in the shape glbLoader emits, or nulls
 * when the preset hides its trunk (ferns / bushes / ground plants).
 */
function buildPineTrunkSubmeshes(pineBlock) {
  const trunk = pineBlock.trunk;
  if (!trunk || trunk.visible === false) return { lod0: null, lod1: null };

  const { material } = createPineBarkMaterial(trunk);
  const submesh = (geometry) => [{
    geometry,
    material,
    localMatrix: _identity.clone(),
  }];

  const radialSegs = Math.max(6, Math.round(trunk.radialSegs ?? 20));
  return {
    lod0: submesh(buildPineTrunkGeometry(trunk)),
    lod1: submesh(
      buildPineTrunkGeometry({ ...trunk, radialSegs: Math.max(6, Math.round(radialSegs / 2)) }),
    ),
  };
}

/**
 * Resolve a preset's trunk tiers: baked GLB when `trunkFile` names one,
 * otherwise procedural geometry from a pine preset's own trunk params.
 */
async function resolveTrunkSubmeshes(json) {
  if (!json.trunkFile) {
    const pineBlock = getPineBlock(json);
    if (pineBlock) {
      const { lod0, lod1 } = buildPineTrunkSubmeshes(pineBlock);
      return [lod0, lod1];
    }
  }
  const [lod0, lod1] = await Promise.all([
    loadTrunkGlb(json.trunkFile),
    json.trunkLod1File ? loadTrunkGlb(json.trunkLod1File) : Promise.resolve(null),
  ]);
  if (json.trunkMaterial && !json.trunkMaterial.useGlb) {
    applyProceduralTrunk(json.trunkMaterial, lod0, lod1);
  }
  return [lod0, lod1];
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

  const [foliagePreset, [trunkSubmeshes, trunkLod1Submeshes]] = await Promise.all([
    loadFoliagePreset(json),
    resolveTrunkSubmeshes(json),
  ]);

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

        const [foliagePreset, [trunkSubmeshes, trunkLod1Submeshes]] = await Promise.all([
          loadFoliagePreset(json),
          resolveTrunkSubmeshes(json),
        ]);

        resolve({ foliagePreset, trunkSubmeshes, trunkLod1Submeshes, json });
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
