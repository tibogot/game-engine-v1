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
import { KIT_BLEND, blendKitParts, whenGroundBlend } from "./algGroundBlend.js";
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
export const MIRADOR_TYPES = ["mirador", "gear"];   // (gear: its searchlight and gun, their own atlas)
// THE BARBED WIRE (tools/blender/barbedWire.py — algSangar.js loadBarbedWire)
export const WIRE_TYPES = ["barbed"];
// THE MG NEST (tools/blender/mgNest.py — algSangar.js loadMgNest): the nest and its AA-52
export const NEST_TYPES = ["mg", "gun"];
// THE MORTAR PIT (tools/blender/mortarPit.py — algSangar.js loadMortarPit): the pit and its 81 mm
export const PIT_TYPES = ["mortar", "m81"];
// THE FORTIFIED POINT (tools/blender/fortPoint.py — algSangar.js loadFortPoint): its banks and stores (the bags the user's sim)
export const FORT_TYPES = ["point"];
// THE SEARCHLIGHT TOWER (tools/blender/searchlightTower.py — algSangar.js loadSearchlight): the tower and its turning head
export const SLTOWER_TYPES = ["sltower", "lamp"];
// THE FIELD POSTS (tools/blender/fieldPosts.py — algSangar.js loadForwardPost / loadAidStation)
export const FIELD_POST_TYPES = ["fwdradio", "aidtent", "aidmark"];
// THE FLN'S FIELD WORKS (tools/blender/flnPosts.py — algSangar.js loadRefuge / loadInfirmary)
export const FLN_POST_TYPES = ["refuge", "infirm"];
// THE SMALL PROPS (tools/blender/smallProps.py — the HUD icons' hand-held kit: iconStudio.js)
// THE RUBBLE (tools/blender/rubble.py — algTownDamage.js, a house collapsing): three heaps and four loose chunks
// THE VILLAGE PROPS (tools/blender/villageProps.py — algVillageLife.js with MAP.villageProps)
export const VPROP_TYPES = ["well", "trough", "jars", "jars2", "jars3", "bench", "oven", "hay", "wood", "hives"];
export const RUBBLE_TYPES = ["wide", "tall", "spill", "chunkslab", "chunkstone", "chunkblock", "chunkbeam"];
export const BORDJ_TYPES = ["post"];
// THE FLN'S MARKS (tools/blender/flnMarks.py — algSangar.js loadLookout / loadMineMarker): the watcher's perch, the mine's cairn
export const MARK_TYPES = ["lookout", "minemark"];
// THE FARMSTEAD (tools/blender/farmstead.py — algSangar.js loadFarmstead): intact / damaged / ruin = burnt
export const FARM_TYPES = ["farm"];
// THE SAS POST (tools/blender/sasPost.py — algSangar.js loadSasPost): the French army's post in a village
export const SAS_TYPES = ["sas"];   // (the French post — tools/blender/postKit.py, algSangar loadFrenchPost)
export const SMALL_PROP_TYPES = ["grenade", "smoke", "flare", "cutters", "mine", "helmet", "kepi", "jerrycan", "ammobox", "detonator", "detector", "radio", "lmg", "bazooka", "flamer", "sniper", "tools", "shell", "shotgun", "mapcase", "spade"];   // (aidmark: the tent's red crosses, a decal piece)
const KITS = { houses: { prefix: "House", types: HOUSE_TYPES }, mzab: { prefix: "Mzab", types: MZAB_TYPES }, fieldwalls: { prefix: "Wall", types: FIELD_WALL_TYPES }, points: { prefix: "Point", types: POINT_TYPES }, sangar: { prefix: "Sangar", types: SANGAR_TYPES }, armscache: { prefix: "Cache", types: CACHE_TYPES }, ambushscreen: { prefix: "Screen", types: SCREEN_TYPES }, mirador: { prefix: "Tower", types: MIRADOR_TYPES }, barbedwire: { prefix: "Wire", types: WIRE_TYPES }, mgnest: { prefix: "Nest", types: NEST_TYPES }, mortarpit: { prefix: "Pit", types: PIT_TYPES }, fortpoint: { prefix: "Fort", types: FORT_TYPES }, sltower: { prefix: "Light", types: SLTOWER_TYPES }, fieldposts: { prefix: "Field", types: FIELD_POST_TYPES }, flnposts: { prefix: "Fln", types: FLN_POST_TYPES }, smallprops: { prefix: "Prop", types: SMALL_PROP_TYPES }, postkit: { prefix: "Bordj", types: BORDJ_TYPES }, rubble: { prefix: "Rubble", types: RUBBLE_TYPES }, vprops: { prefix: "Village", types: VPROP_TYPES }, flnmarks: { prefix: "Mark", types: MARK_TYPES }, farmstead: { prefix: "Farm", types: FARM_TYPES }, saspost: { prefix: "Sas", types: SAS_TYPES } };
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
      // THE STENCILS (2026-10-25, you: "is it not better to use decals for lettering?"): a piece's painted words, flat
      // quads 8 mm off their boards on the kit's stencil sheet (tools/blender/bkit.py stencils) — alpha-tested,
      // drawn with the near level only, no shadow of their own
      const decal = gltf.scene.getObjectByName(`${nm}_Decal`);
      if (decal?.isMesh) {
        const m = decal.material;
        m.transparent = false; m.depthWrite = true; m.alphaTest = 0.5; m.side = THREE.FrontSide;
        if (m.map) m.map.anisotropy = 8;
        decal.castShadow = false; decal.receiveShadow = true;
      }
      _parts[`${ty}:${st}`] = { near, far: far?.isMesh ? far : near, decal: decal?.isMesh ? decal : null };
    }
    // (THE GROUND BLEND as it loads — algGroundBlend KIT_BLEND: before anything can draw it)
    if (KIT_BLEND[kit]) whenGroundBlend((app) => blendKitParts(app, _parts, K.types, KIT_BLEND[kit]));
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
  const near = P.near.clone();
  if (P.decal) { P.near.updateMatrix(); P.decal.updateMatrix(); const d = P.decal.clone(); d.applyMatrix4(P.near.matrix.clone().invert()); near.add(d); }   // (its stencils: the near level's child, the GLB's own placement kept)
  lod.addLevel(near, 0, 0.1);
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
  const sets = new Map();   // "type:state" → { near, far, decal (its stencils, drawn with near) }
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
  const _w = new THREE.Matrix4(), _sc = new THREE.Vector3();
  function rebuild() {
    for (const s of sets.values()) for (const m of [s.near, s.far, s.decal]) if (m) { root.remove(m); m.dispose(); }
    sets.clear();
    const per = new Map();
    for (const it of items) per.set(it.key, (per.get(it.key) ?? 0) + 1);
    for (const [key, n] of per) {
      const P = _parts?.[key];
      if (!P) continue;
      const decal = P.decal ? mesh(P.decal, n) : null;
      if (decal) decal.castShadow = false;
      sets.set(key, { near: mesh(P.near, n), far: mesh(P.far, n), decal });
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
    /** Move a piece (a chunk of rubble flying out of a collapsing house — algTownDamage): its new place, turn
     *  (a quaternion) and scale; drawn there from the next update. */
    move(id, p, q, scale = S) { const it = items[id]; if (!it) return; it.m.compose(p, q, _sc.set(scale, scale, scale)); it.p.copy(p); },
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
        if (near && s.decal) { s.decal.setMatrixAt(c, _w.multiplyMatrices(it.m, s.decal.userData.local)); cnt.set(s.decal, c + 1); }
      }
      for (const s of sets.values()) for (const im of [s.near, s.far, s.decal]) {
        if (!im) continue;
        const n = cnt.get(im) ?? 0;
        if (im.count !== n || n) { im.count = n; im.instanceMatrix.needsUpdate = true; }
      }
    },
    /** Draws this frame (near + far sets with instances) — ×2 with the shadow pass. */
    draws() { let d = 0; for (const s of sets.values()) d += (s.near.count > 0) + (s.far.count > 0) + (s.decal?.count > 0); return d; },
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
