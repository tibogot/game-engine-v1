// THE WHITEWASHED HOUSE, PILOT (2026-10-19, you, after CoH 3's North Africa: "it reads better than the brown
// ones we have … would you be able to make as fine a house?"). tools/blender/house.py builds it as the real
// thing (rubble stone under a lime render, the blue band at its foot, crenellated parapets, joists through
// the wall, shutters, an outside stair, a stair hut) in THREE STATES from one description — intact, damaged
// (breached, the stone showing, pocked, rubble), ruin (the upper storey broken off, the floors fallen in) —
// each one object, one baked atlas (colour x AO), one draw → public/models/alg/house1.glb (then
// tools/optimizeGlb.mjs: KTX2, meshopt). The groundwork of building damage: the game swaps the state.
// In the BUILDINGS LAB first (« Maison blanchie »), beside the village house the game builds today.
import * as THREE from "three";
import { getSharedGltfLoader } from "../../v3/render/foliage/glbLoader.js";

const S = 1.3;   // (built in real metres; the game draws its buildings x1.3)
export const HOUSE_STATES = ["intact", "damaged", "ruin"];
let _p = null, _meshes = null;

/** Load the GLB once. Null if missing. */
export function loadHouse(file = "house1") {
  return (_p ??= getSharedGltfLoader().loadAsync(`/models/alg/${file}.glb`).then((gltf) => {
    _meshes = {};
    for (const st of HOUSE_STATES) {
      const m = gltf.scene.getObjectByName(`House_${st[0].toUpperCase()}${st.slice(1)}`);
      if (!m?.isMesh) continue;
      m.castShadow = m.receiveShadow = true;
      if (m.material?.map) m.material.map.anisotropy = 8;
      // (Blender exports double-sided: closed shells and slabs here, every back face would be shaded too)
      if (m.material) m.material.side = THREE.FrontSide;
      _meshes[st] = m;
    }
    return _meshes;
  }).catch((e) => { console.warn("[house]", e); return null; }));
}

/** One house in `state` (meshes and materials shared), at the game's scale. Null if not loaded. */
export function houseMesh(state = "intact") {
  const src = _meshes?.[state];
  if (!src) return null;
  const g = new THREE.Group();
  g.name = `House:${state}`;
  g.scale.setScalar(S);
  g.add(src.clone());
  return g;
}

/** Its triangles and texture size (the lab's console). */
export function houseStats() {
  return Object.fromEntries(Object.entries(_meshes ?? {}).map(([k, m]) => [k, { tris: (m.geometry.index?.count ?? 0) / 3, tex: m.material?.map?.image?.width ?? 0 }]));
}
