// THE WHITEWASHED HOUSES (2026-10-19, you, after CoH 3's North Africa: "it reads better than the brown ones";
// then "we will need some variants … small assets on top of buildings … optimised very well, with LOD, and LOD
// for the shadows"). tools/blender/house.py builds a KIT of house TYPES — maison (two storeys + annex, outside
// stair), cour (one storey round a walled courtyard), haute (tall, a timber balcony), boutique (a long shop,
// its awning and wares) — each in THREE STATES (intact / damaged / ruin: the groundwork of building damage),
// with its roof's and doorstep's life (prayer rugs, pottery, baskets, hay, laundry, a bread oven …).
//
// OPTIMISED: a type's three states share ONE atlas (baked colour x AO; ETC1S); each state a NEAR and a FAR
// level (~30 % of the triangles, the same atlas). Every house is a THREE.LOD: near within HOUSE_FAR of the
// camera, far beyond — and the far one in the SUN'S SHADOW pass too (the LOD picks its level per camera, and
// the shadow camera stands far off; checked in the lab). Meshes and materials shared between copies.
// (The brown village houses stay — the farmers' and shepherds' homes: algMasonry.)
import * as THREE from "three";
import { getSharedGltfLoader } from "../../v3/render/foliage/glbLoader.js";

const S = 1.3;   // (built in real metres; the game draws its buildings x1.3)
export const HOUSE_TYPES = ["maison", "cour", "haute", "boutique"];
// THE M'ZAB TOWN HOUSES (tools/blender/mzab.py, the same builder): the Oued Abdi's ochre town — a two-storey
// house with its roof gallery, a tall one, a low one behind its yard, a stepped pale-blue one, the souk's arcade
export const MZAB_TYPES = ["dar", "tour", "bas", "terrasse", "souk", "mosquee", "mur"];   // (+ the hilltop mosque and its minaret)
export const HOUSE_STATES = ["intact", "damaged", "ruin"];
// the kits: their file and their objects' prefix (the type names never collide: one table of parts for all)
// THE FIELD WALLS (tools/blender/fieldwall.py): a dry-stone module, three variants (a b c), the same states
export const FIELD_WALL_TYPES = ["a", "b", "c"];
// THE REQUISITION POINTS (tools/blender/supplyPoint.py): the mast and its depot as one piece, fuel or munitions —
// built in GAME metres (add it at scale 1)
export const POINT_TYPES = ["fuel", "mun"];
// THE SANGAR (tools/blender/sangar.py — algSangar.js makes it the sappers' buildable)
export const SANGAR_TYPES = ["sangar"];
// THE ARMS CACHE (tools/blender/armsCache.py — algSangar.js loadArmsCache)
export const CACHE_TYPES = ["arms"];
// THE AMBUSH SCREEN (tools/blender/ambushScreen.py — its stone; its scrub the engine's plants, algSangar.js)
export const SCREEN_TYPES = ["ambush"];
// THE MIRADOR (tools/blender/mirador.py — algSangar.js loadMirador)
export const MIRADOR_TYPES = ["mirador"];
// THE BARBED WIRE (tools/blender/barbedWire.py — algSangar.js loadBarbedWire)
export const WIRE_TYPES = ["barbed"];
const KITS = { houses: { prefix: "House", types: HOUSE_TYPES }, mzab: { prefix: "Mzab", types: MZAB_TYPES }, fieldwalls: { prefix: "Wall", types: FIELD_WALL_TYPES }, points: { prefix: "Point", types: POINT_TYPES }, sangar: { prefix: "Sangar", types: SANGAR_TYPES }, armscache: { prefix: "Cache", types: CACHE_TYPES }, ambushscreen: { prefix: "Screen", types: SCREEN_TYPES }, mirador: { prefix: "Tower", types: MIRADOR_TYPES }, barbedwire: { prefix: "Wire", types: WIRE_TYPES } };
/** World metres from the camera where a house's far level takes over (the RTS camera sits 50-130 m out). */
export const HOUSE_FAR = 60;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const _p = {};
let _parts = null;

/** Load a kit once ("houses": whitewashed, "mzab": the ochre town). Null if missing. */
export function loadHouses(kit = "houses") {
  const K = KITS[kit];
  return (_p[kit] ??= getSharedGltfLoader().loadAsync(`/models/alg/${kit}.glb`).then((gltf) => {
    _parts ??= {};
    for (const ty of K.types) for (const st of HOUSE_STATES) {
      const nm = `${K.prefix}${cap(ty)}_${cap(st)}`;
      const near = gltf.scene.getObjectByName(nm), far = gltf.scene.getObjectByName(`${nm}_Far`);
      if (!near?.isMesh) continue;
      for (const m of [near, far]) {
        if (!m?.isMesh) continue;
        m.castShadow = m.receiveShadow = true;
        if (m.material?.map) m.material.map.anisotropy = 8;
        // (Blender exports double-sided: closed shells and slabs here — every back face would be shaded too)
        if (m.material) m.material.side = THREE.FrontSide;
        // (a kit's colour is its baked atlas: a COLOR_0 it carries is DATA — the sangar's build order — and the
        // loader multiplied it in: the damaged sangar drew red, 2026-10-21)
        if (m.material) m.material.vertexColors = false;
      }
      _parts[`${ty}:${st}`] = { near, far: far?.isMesh ? far : near };
    }
    return _parts;
  }).catch((e) => { console.warn("[houses]", e); return null; }));
}

/** A piece from outside the kits (its own near / far meshes — e.g. the simulated sandbag walls, algSandbags.js)
 *  made addable to a house field as `type` in `state`. */
export function registerHouseParts(type, state, near, far = near) {
  _parts ??= {};
  _parts[`${type}:${state}`] = { near, far: far ?? near };
}

/** One house of `type` in `state` — a LOD (near / far), at the game's scale. Null if not loaded. */
export function houseMesh(type = "maison", state = "intact", scale = S) {
  const P = _parts?.[`${type}:${state}`];
  if (!P) return null;
  const g = new THREE.Group();
  g.name = `House:${type}:${state}`;
  g.scale.setScalar(scale);
  const lod = new THREE.LOD();
  lod.name = "HouseLOD";
  lod.addLevel(P.near.clone(), 0, 0.1);
  lod.addLevel(P.far.clone(), HOUSE_FAR, 0.1);   // (THREE.LOD measures plain world distance)
  g.add(lod);
  return g;
}

/**
 * A VILLAGE'S HOUSES, INSTANCED (2026-10-19, you: "optimise it as much as possible"): every house of one type
 * and state shares two InstancedMeshes (near, far), so the draws grow with the KINDS of house on screen, not
 * with the houses (a 40-house map: ≤ 24 + their shadows, against 80). The near / far split is decided by the
 * MAIN camera each frame (`update(camera)`: a house within HOUSE_FAR draws near) and the shadow pass draws the
 * same split — the near houses' shadows from the near geometry (they match up close), the rest from the far.
 * (The instance matrices reach the GPU the same frame: v3/render/instanceMatrixSync.js, the game's default.)
 *   const field = createHouseField(); scene.add(field.root);
 *   const id = field.add("maison", "intact", x, y, z, yaw); field.update(camera) every frame;
 *   field.setState(id, "damaged")   // the damage system's hook
 */
export function createHouseField() {
  const root = new THREE.Group();
  root.name = "HouseField";
  const sets = new Map();   // "type:state" → { near, far, items: [] }
  const items = [];         // { key, m: Matrix4, p: Vector3 }
  let built = false;
  const mesh = (src, n) => {
    const m = new THREE.InstancedMesh(src.geometry, src.material, Math.max(1, n));
    m.count = 0; m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;   // (instances spread over the map: the set is not one sphere)
    // (the GLB's geometry is meshopt-QUANTIZED — 16-bit positions, the node's own scale and offset undo it:
    // that transform goes into every instance, after the house's own — without it the houses drew tiny)
    src.updateMatrix();
    m.userData.local = src.matrix.clone();
    root.add(m);
    return m;
  };
  const _w = new THREE.Matrix4();
  function rebuild() {
    for (const s of sets.values()) { root.remove(s.near, s.far); s.near.dispose(); s.far.dispose(); }
    sets.clear();
    const per = new Map();
    for (const it of items) per.set(it.key, (per.get(it.key) ?? 0) + 1);
    for (const [key, n] of per) {
      const P = _parts?.[key];
      if (!P) continue;
      sets.set(key, { near: mesh(P.near, n), far: mesh(P.far, n) });
    }
    built = true;
  }
  return {
    root,
    /** A house; its id (for setState). */
    add(type, state, x, y, z, yaw = 0, scale = S) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(scale, scale, scale));
      items.push({ key: `${type}:${state}`, m, p: new THREE.Vector3(x, y, z) });
      built = false;
      return items.length - 1;
    },
    setState(id, state) { const it = items[id]; if (!it) return; it.key = `${it.key.split(":")[0]}:${state}`; built = false; },
    /** Per frame, with the MAIN camera: who draws near, who far. */
    update(camera) {
      if (!built) rebuild();
      const cnt = new Map();
      for (const it of items) {
        const s = sets.get(it.key);
        if (!s) continue;
        const near = it.p.distanceTo(camera.position) < HOUSE_FAR;
        const im = near ? s.near : s.far;
        const c = cnt.get(im) ?? 0;
        im.setMatrixAt(c, _w.multiplyMatrices(it.m, im.userData.local));
        cnt.set(im, c + 1);
      }
      for (const s of sets.values()) for (const im of [s.near, s.far]) {
        const n = cnt.get(im) ?? 0;
        if (im.count !== n || n) { im.count = n; im.instanceMatrix.needsUpdate = true; }
      }
    },
    /** Draws this frame (near + far sets with instances) — ×2 with the shadow pass. */
    draws() { let d = 0; for (const s of sets.values()) d += (s.near.count > 0) + (s.far.count > 0); return d; },
    get size() { return items.length; },
  };
}

/** Triangles of each type and state, near / far; the atlases (the lab's console). */
export function houseStats() {
  const t = (m) => (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3;
  const tex = new Set();
  const out = {};
  for (const [k, P] of Object.entries(_parts ?? {})) { out[k] = `${t(P.near)} / ${t(P.far)}`; if (P.near.material?.map) tex.add(P.near.material.map); }
  out.atlases = [...tex].map((x) => x.image?.width ?? 0).join(", ");
  return out;
}
