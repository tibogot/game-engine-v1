// ============================================================================
// CITY TREES FROM A TREE-EDITOR PRESET — the real foliage material, one draw.
//
// A LOOK TEST, and deliberately built as an alternative rather than a
// replacement: `modularRoadCityFurniture.js` keeps its procedural tree in full
// and chooses between the two on `FURNITURE.treeSource`. Flip that back to
// "procedural" and nothing here is constructed, loaded or drawn.
//
// ── WHY THIS IS NOT JUST "LOAD THE GLB" ─────────────────────────────────────
//
// tree110 is a BILLBOARD-LEAF preset: 110 leaf cards sampled around a trunk,
// drawn by v2's foliage material, which faces every card at the camera in the
// vertex stage. Baking that to static geometry (the obvious cheap path) would
// freeze all 110 cards facing one way and read as cardboard from the side —
// worse than the procedural tree it is meant to be compared against, which
// would make the test worthless.
//
// It does not need a new renderer either. v2/render/foliage/foliageLodRenderer
// already solved this: in billboard mode the material's position branch is
// built from `aLeafCenter` in WORLD space and never touches the instance
// matrix, so many trees become ONE plain Mesh with an InstancedBufferGeometry
// whose per-leaf attributes are pre-transformed on the CPU. This file builds
// exactly that buffer from the city's own tree placements. Two draws for the
// whole city — a leaf mesh and a trunk mesh — which is what the procedural
// tree already costs.
//
// ── PATHS ───────────────────────────────────────────────────────────────────
//
// `presetLoader` resolves its assets RELATIVE to the page ("../textures/…"),
// which is correct for v2/v3's editors and wrong for road.html — two
// directories deep, so every candidate misses. Everything here is loaded from
// absolute public paths instead, and the atlas override is handed to the loader
// through the hook it already has (`atlas.path`).
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { loadFoliagePreset } from "../../v2/core/foliage/presetLoader.js";
import { loadTreeGlbFromUrl } from "../../v2/core/foliage/glbLoader.js";
import { createTrunkMaterial } from "../../v2/render/foliage/trunkMaterial.js";

export const CITY_TREE_PRESET = {
  /** Preset filename under /tree-presets/. */
  file: "tree110.json",
  /** Extra scale on top of the preset's own trunkScale. */
  scale: 1.0,
  /**
   * Hard cap on trees given leaf cards, nearest the city centre first.
   *
   * The city places ~4.6k trees and this preset carries 110 cards each, so the
   * uncapped buffer is ~500k leaf instances — about 1 M triangles, which is
   * inside what the city already draws, but it is one buffer and it is built on
   * the CPU. The cap exists so the cost is a number you choose rather than one
   * the layout hands you.
   */
  maxTrees: 4800,
  /**
   * Metres at which a TRUNK stops being drawn.
   *
   * The procedural trunk is a 12-triangle box and can afford the furniture's
   * 650 m range. This one is the preset's actual GLB — 2116 triangles, because
   * it is a branching trunk, not a post — so at the city's 4.6k trees drawing
   * them all is 9.7 M triangles and MEASURED 15.4 ms GPU on its own. Cut to
   * 140 m it is a fraction of that, and a trunk further away than that is
   * behind its own canopy anyway.
   */
  trunkRange: 140,
  /**
   * LEAF SHADOWS OFF, and this is the one number that decides whether the
   * preset tree is affordable.
   *
   * The procedural canopy casts, so matching it was the first default — but a
   * canopy is two icospheres and this is 110 alpha-tested cards, so at the
   * city's ~4.6k trees the shadow pass redraws 3.0 M triangles it cannot reject
   * early. MEASURED at 1080p over the city: shadows ON 46-52 fps, shadows OFF a
   * vsync-locked 61. Nothing else about the tree moved the number.
   *
   * The honest cost is that the trees stop laying shadows on the pavement.
   * Turn it back on with `maxTrees` pulled down if you want them near the car.
   */
  castShadow: false,
};

/** One in-flight load per file — the city rebuilds far more often than this
 *  changes, and re-parsing the atlas per rebuild would hitch every time. */
const _cache = new Map();

/**
 * Load the preset once: foliage material + per-leaf tables, and a trunk.
 * @returns {Promise<{json:object, foliage:object, trunkGeo:THREE.BufferGeometry|null, trunkMat:THREE.Material|null}>}
 */
export function loadCityTreePreset(file = CITY_TREE_PRESET.file) {
  if (!_cache.has(file)) _cache.set(file, _load(file).catch((e) => {
    _cache.delete(file);                 // a failed load must not poison the slot
    throw e;
  }));
  return _cache.get(file);
}

async function _load(file) {
  const resp = await fetch(`/tree-presets/${file}`);
  if (!resp.ok) throw new Error(`[CityTreePreset] /tree-presets/${file} → ${resp.status}`);
  const json = await resp.json();

  // See PATHS. `atlas.path` is the loader's own override hook; the non-atlas
  // branch takes the leaf texture straight off the preset, so make that
  // absolute too rather than relying on which branch a preset happens to use.
  if (json.atlas?.enabled) json.atlas.path = "/textures/leaves/leaf_atlas.png";
  else if (json.leafTexture) json.leafTexture = `/${String(json.leafTexture).replace(/^\/+/, "")}`;

  const foliage = await loadFoliagePreset(json);

  let trunkGeo = null;
  let trunkMat = null;
  if (json.trunkFile) {
    const { submeshes } = await loadTreeGlbFromUrl(`/models/trunks/${json.trunkFile}`);
    trunkGeo = _mergeTrunk(submeshes);
    // `useGlb` keeps the file's own bark; otherwise the preset's two-colour
    // ramp, built over the trunk's ACTUAL height so the gradient lands where
    // the editor showed it.
    if (trunkGeo && json.trunkMaterial && !json.trunkMaterial.useGlb) {
      trunkGeo.computeBoundingBox();
      const bb = trunkGeo.boundingBox;
      trunkMat = createTrunkMaterial({
        botColor: json.trunkMaterial.botColor,
        topColor: json.trunkMaterial.topColor,
        roughness: json.trunkMaterial.roughness,
        yMin: bb ? bb.min.y : 0,
        yMax: bb ? bb.max.y : (json.trunkMaterial.gradHeight ?? 6),
      }).material;
    } else if (submeshes?.[0]) {
      trunkMat = submeshes[0].material;
    }
  }
  return { json, foliage, trunkGeo, trunkMat };
}

/**
 * Merge the trunk's submeshes into one geometry at the preset's trunk scale.
 *
 * Normalised to a common layout FIRST — position/normal/uv, non-indexed —
 * because mergeGeometries returns null on any attribute or index mismatch and
 * says nothing about it, which shows up much later as a tree with no trunk.
 */
/**
 * Rebuild position/normal/uv as PLAIN FLOAT32, reading through the accessors.
 *
 * This is not tidying, it is the bug. The trunk GLB is Draco-compressed and its
 * position attribute comes back as a NORMALISED integer array — so the stored
 * values are ±1 and `getX()` scales them back to metres on read. Calling
 * `applyMatrix4` on that writes the transformed metres straight back through
 * `setXYZ`, which re-normalises and CLAMPS them into ±1 again: a 2.736x scale
 * and a 2.7 m lift both vanish, silently, and the trunk becomes a 2 m blob
 * centred on the origin — half under the pavement and entirely hidden inside
 * the canopy. The symptom is "I can see the foliage but not the trunks".
 *
 * `getX/getY/getZ` denormalise on the way out, so copying through them lands
 * real metres in a Float32Array that any later matrix can safely modify.
 * Normalising the layout also keeps mergeGeometries happy, which returns null
 * rather than complaining when attribute sets disagree.
 */
function _toFloatGeometry(src) {
  const g = new THREE.BufferGeometry();
  const p = src.getAttribute("position");
  const n = src.getAttribute("normal");
  const uv = src.getAttribute("uv");
  const count = p.count;
  const pa = new Float32Array(count * 3);
  const na = new Float32Array(count * 3);
  const ua = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    pa[i * 3] = p.getX(i); pa[i * 3 + 1] = p.getY(i); pa[i * 3 + 2] = p.getZ(i);
    if (n) { na[i * 3] = n.getX(i); na[i * 3 + 1] = n.getY(i); na[i * 3 + 2] = n.getZ(i); }
    if (uv) { ua[i * 2] = uv.getX(i); ua[i * 2 + 1] = uv.getY(i); }
  }
  g.setAttribute("position", new THREE.BufferAttribute(pa, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(na, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(ua, 2));
  if (!n) g.computeVertexNormals();
  return g;
}

/**
 * Merge the trunk's submeshes into one geometry in RAW TRUNK-LOCAL space.
 *
 * Deliberately NOT scaled by the preset's `trunkScale`. That number is not a
 * property of the trunk mesh, it is the tree's placement scale: `sampleAllClusters`
 * DIVIDES every leaf position by it to store the canopy in raw trunk-local
 * space, and the editor then places the whole tree at `scale: trunkScale`
 * (v2/app/main.js). Scaling the geometry here instead put the trunk 1.55x
 * larger than its own canopy — a trunk poking out the top of the leaves, which
 * is what "the foliage is not at the right Y" looks like. It belongs in the
 * per-tree scale, where it applies to trunk and leaves together.
 */
function _mergeTrunk(submeshes) {
  if (!submeshes?.length) return null;
  const parts = [];
  for (const sm of submeshes) {
    const src = sm.geometry;
    if (!src?.getAttribute("position")) continue;
    const g = _toFloatGeometry(src.index ? src.toNonIndexed() : src);
    // THE NODE TRANSFORM, which the loader hands over separately rather than
    // baking (v2/app/main.js does `mesh.applyMatrix4(sm.localMatrix)`). Here it
    // is a 2.736 scale and a 2.7 m lift, so dropping it leaves the trunk a
    // knee-high stub buried under its own canopy. Applied only AFTER the
    // rebuild above — see _toFloatGeometry for why that order is load-bearing.
    if (sm.localMatrix) g.applyMatrix4(sm.localMatrix);
    parts.push(g);
  }
  if (!parts.length) return null;
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
  if (parts.length > 1) parts.forEach((p) => p.dispose());
  if (!merged) throw new Error("[CityTreePreset] trunk merge returned null");
  return merged;
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _leaf = new THREE.Vector3();
const _canopy = new THREE.Vector3();

/**
 * Build the city's preset trees from its own placement list.
 *
 * @param {object} bundle       from loadCityTreePreset()
 * @param {Array}  trees        the furniture's tree placements ({ m, x, z, scale })
 * @param {object} [opts]
 * @returns {{leafMesh:THREE.Mesh|null, trunkMesh:THREE.InstancedMesh|null, stats:object, dispose:Function}}
 */
export function buildPresetCityTrees(bundle, trees, opts = {}) {
  const P = { ...CITY_TREE_PRESET, ...opts };
  const lod = bundle.foliage?.lods?.[0];
  if (!lod || !trees?.length) return { leafMesh: null, trunkMesh: null, stats: { trees: 0, leaves: 0 }, dispose() {} };

  const leavesPerTree = lod.count;
  const base = lod.geometry;
  const centerSrc = base.getAttribute("aLeafCenter").array;   // trunk-LOCAL centres
  const randSrc = base.getAttribute("aRand").array;
  const scaleSrc = base.getAttribute("aLeafScale").array;     // itemSize 1 in the preset
  const bounds = bundle.foliage.bounds;
  const yMin = bounds?.yMin ?? 0;
  const yRange = Math.max((bounds?.yMax ?? 8) - yMin, 1e-3);
  const canopyLocal = bounds?.canopyCenter ?? null;

  // Nearest the city centre first, so a cap keeps the trees you can actually
  // see rather than an arbitrary slice of the layout order.
  const picked = trees.length > P.maxTrees
    ? [...trees].sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z)).slice(0, P.maxTrees)
    : trees;

  const nTrees = picked.length;
  const total = nTrees * leavesPerTree;
  const randData = new Float32Array(total * 2);
  const centerData = new Float32Array(total * 3);
  const treeCenterData = new Float32Array(total * 3);
  const scaleData = new Float32Array(total * 2);   // (leaf size, canopy height fraction)

  const trunkMatrices = bundle.trunkGeo ? new Float32Array(nTrees * 16) : null;
  const _m = new THREE.Matrix4();

  let idx = 0;
  for (let t = 0; t < nTrees; t++) {
    const e = picked[t];
    e.m.decompose(_pos, _quat, _scl);
    // `instanced()` in modularRoadCityFurniture BAKES e.scale into e.m the
    // first time it runs, and flags it. On the preset path that never runs, so
    // the matrix is still unscaled and the scale is only on the entry — read
    // whichever is actually live rather than assuming either.
    // `trunkScale` is the TREE's placement scale, not the trunk mesh's — see
    // _mergeTrunk. Folding it in here is what keeps the canopy on the trunk.
    const s = (e.scaled ? _scl.x : (e.scale ?? 1)) * P.scale * (bundle.json?.trunkScale ?? 1);
    _m.compose(_pos, _quat, _scl.set(s, s, s));
    if (trunkMatrices) _m.toArray(trunkMatrices, t * 16);

    // The tree's world canopy centre — one value shared by all its leaves. The
    // material takes the leaf's outward direction from it, so it must follow
    // the tree rather than sit at a slot-wide constant.
    if (canopyLocal) _canopy.copy(canopyLocal).applyMatrix4(_m);
    else _canopy.copy(_pos);

    for (let li = 0; li < leavesPerTree; li++, idx++) {
      _leaf.set(centerSrc[li * 3], centerSrc[li * 3 + 1], centerSrc[li * 3 + 2]).applyMatrix4(_m);
      centerData[idx * 3] = _leaf.x;
      centerData[idx * 3 + 1] = _leaf.y;
      centerData[idx * 3 + 2] = _leaf.z;
      treeCenterData[idx * 3] = _canopy.x;
      treeCenterData[idx * 3 + 1] = _canopy.y;
      treeCenterData[idx * 3 + 2] = _canopy.z;
      randData[idx * 2] = randSrc[li * 2];
      randData[idx * 2 + 1] = randSrc[li * 2 + 1];
      scaleData[idx * 2] = scaleSrc[li] * s;
      // Height fraction is measured in TRUNK-LOCAL space, so it stays correct
      // whatever the tree's scale or ground height — it drives the canopy's
      // vertical colour ramp and its AO.
      const ly = centerSrc[li * 3 + 1];
      scaleData[idx * 2 + 1] = Math.min(1, Math.max(0, (ly - yMin) / yRange));
    }
  }

  // MATRIX-LESS BILLBOARDS: the card attributes are SHARED with the preset
  // geometry (no copy), and the four per-leaf attributes carry world space.
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(base.index);
  geo.setAttribute("position", base.getAttribute("position"));
  geo.setAttribute("normal", base.getAttribute("normal"));
  geo.setAttribute("uv", base.getAttribute("uv"));
  geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(randData, 2));
  geo.setAttribute("aLeafCenter", new THREE.InstancedBufferAttribute(centerData, 3));
  geo.setAttribute("aTreeCenter", new THREE.InstancedBufferAttribute(treeCenterData, 3));
  geo.setAttribute("aLeafScale", new THREE.InstancedBufferAttribute(scaleData, 2));
  geo.instanceCount = total;

  const leafMesh = new THREE.Mesh(geo, bundle.foliage.material);
  leafMesh.name = "CityTreeLeavesPreset";
  // The positions are already world space, so the mesh must contribute no
  // transform of its own — and no bounds either, or it culls itself.
  leafMesh.frustumCulled = false;
  leafMesh.castShadow = !!P.castShadow;
  leafMesh.receiveShadow = false;

  let trunkMesh = null;
  if (bundle.trunkGeo && trunkMatrices) {
    trunkMesh = new THREE.InstancedMesh(bundle.trunkGeo, bundle.trunkMat, nTrees);
    trunkMesh.name = "CityTreeTrunksPreset";
    trunkMesh.frustumCulled = false;
    trunkMesh.castShadow = false;      // same call the procedural trunk makes
    trunkMesh.receiveShadow = true;
    trunkMesh.instanceMatrix.array.set(trunkMatrices);
    trunkMesh.instanceMatrix.needsUpdate = true;
    // Filled by the first applyLod on the city's LOD timer. Starting at the
    // full count would draw all 4.6k trunks for the frames before it runs,
    // which is the 15 ms this cull exists to avoid.
    trunkMesh.count = 0;
  }

  /*
   * TRUNK DISTANCE CULL, kept here rather than handed to the furniture's own
   * `applyLod`. That one is written for the procedural kinds and would be wrong
   * twice over on these: it re-writes each matrix from `e.m`, which on this
   * path has never had the tree's scale baked into it, and it copies `e.color`
   * — the canopy tint — onto whatever mesh it is driving. Both would show up as
   * shrunken green trunks. This walks the composed matrices instead.
   */
  const trunkXZ = trunkMatrices ? new Float32Array(nTrees * 2) : null;
  if (trunkXZ) for (let t = 0; t < nTrees; t++) {
    trunkXZ[t * 2] = trunkMatrices[t * 16 + 12];
    trunkXZ[t * 2 + 1] = trunkMatrices[t * 16 + 14];
  }
  const _order = trunkXZ ? new Uint32Array(nTrees).map((_, i) => i) : null;
  function applyLod(view) {
    if (!trunkMesh || !trunkXZ) return;
    const cam = view.pos;
    const r2 = P.trunkRange * P.trunkRange;
    const dst = trunkMesh.instanceMatrix.array;
    let n = 0;
    for (let i = 0; i < nTrees; i++) {
      const t = _order[i];
      const dx = trunkXZ[t * 2] - cam.x, dz = trunkXZ[t * 2 + 1] - cam.z;
      if (dx * dx + dz * dz >= r2) continue;
      // Partition near-first so the kept set is a prefix, exactly as the
      // furniture's own cull does — the draw is then just a count.
      _order[i] = _order[n]; _order[n] = t;
      for (let k = 0; k < 16; k++) dst[n * 16 + k] = trunkMatrices[t * 16 + k];
      n++;
    }
    trunkMesh.count = n;
    trunkMesh.instanceMatrix.needsUpdate = true;
  }

  return {
    leafMesh,
    trunkMesh,
    applyLod,
    stats: { trees: nTrees, leaves: total, leavesPerTree },
    dispose() {
      geo.dispose();
      trunkMesh?.dispose();
      // The preset's own material/geometry are CACHED and shared — a rebuild
      // reuses them, so disposing them here would break the next build.
    },
  };
}
