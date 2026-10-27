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
import { SURFACE_OFF, hasSurfaces, surfaceMaterial, surfaceTextures } from "./algSurfaces.js";
import { haystackField } from "./algHaystack.js";

const S = 1.3;   // (built in real metres; the game draws its buildings x1.3)
export const HOUSE_TYPES = ["maison", "cour", "haute", "boutique"];
// THE M'ZAB TOWN HOUSES (tools/blender/mzab.py, the same builder): the Oued Abdi's ochre town — a two-storey
// house with its roof gallery, a tall one, a low one behind its yard, a stepped pale-blue one, the souk's arcade
export const MZAB_TYPES = ["dar", "tour", "bas", "terrasse", "souk", "mosquee", "mur"];   // (+ the hilltop mosque and its minaret)
export const HOUSE_STATES = ["intact", "damaged", "ruin"];
// THE MECHTA (tools/blender/mechta.py, the same builder — 2026-10-27, MECHTA_PLAN.md): the Aurès stone hamlet's houses for
// the NEW maps (the old Aurès keeps its runtime hamlet, algMasonry) — one room with its ladder, two rooms with the loggia room,
// the hillside house (its outside stair); the hamlet's smaller pieces: the lean-to, the walled yard, the oven
// (+ the DECHRA's pieces, 2026-10-27 — DECHRA_PLAN.md: its mosque, a terrace's retaining wall, the lanes' steps, the djemaa)
export const MECHTA_TYPES = ["petite", "etage", "pente", "appentis", "enclos", "tabouna", "masjid", "soutien", "escalier", "djemaa"];
/** The mechta's SMALLER PIECES (a town's `props`: no garrison, no sight box): their walls, local real metres x0 x1 z0 z1
 *  (tools/blender/mechta.py — change both together) — the nav grid's blocks and HARD cover (algGame). The yard's gap
 *  in its right wall (z -0.7 … 0.7) left open: its thorn branches are a door for men. */
export const MECHTA_PROPS = {
  appentis: [[-1.8, 1.8, -1.5, 1.6]],
  enclos: [[-4.0, 4.0, 2.5, 3.0], [-4.0, -3.47, -3.0, 2.55], [3.47, 4.0, -3.0, -0.7], [3.47, 4.0, 0.7, 2.55]],
  tabouna: [[-0.75, 0.75, -1.1, 0.75]],
  soutien: [[-2.0, 2.0, -0.3, 0.65]],
  escalier: [[-1.2, -0.78, -2.4, 1.0], [0.78, 1.2, -2.4, 1.0]],   // (the steps between: the way up)
  djemaa: [[-3.0, 3.0, 0.9, 1.4], [-3.0, -2.47, -1.5, 0.95]],
};
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
export const VPROP_TYPES = ["well", "trough", "jars", "jars2", "jars3", "bench", "oven", "wood", "hives"];   // (the hay: algHaystack, 2026-10-26)
export const RUBBLE_TYPES = ["wide", "tall", "spill", "chunkslab", "chunkstone", "chunkblock", "chunkbeam"];
export const BORDJ_TYPES = ["post"];
// THE FLN'S MARKS (tools/blender/flnMarks.py — algSangar.js loadLookout / loadMineMarker): the watcher's perch, the mine's cairn
export const MARK_TYPES = ["lookout", "minemark"];
// THE FARMSTEAD (tools/blender/farmstead.py — algSangar.js loadFarmstead): intact / damaged / ruin = burnt
export const FARM_TYPES = ["farm"];
// THE SAS POST (tools/blender/sasPost.py — algSangar.js loadSasPost): the French army's post in a village
export const SAS_TYPES = ["sas"];   // (the French post — tools/blender/postKit.py, algSangar loadFrenchPost)
export const SMALL_PROP_TYPES = ["grenade", "smoke", "flare", "cutters", "mine", "helmet", "kepi", "jerrycan", "ammobox", "detonator", "detector", "radio", "lmg", "bazooka", "flamer", "sniper", "tools", "shell", "shotgun", "mapcase", "spade"];   // (aidmark: the tent's red crosses, a decal piece)
const KITS = { houses: { prefix: "House", types: HOUSE_TYPES }, mzab: { prefix: "Mzab", types: MZAB_TYPES }, mechta: { prefix: "Mechta", types: MECHTA_TYPES }, fieldwalls: { prefix: "Wall", types: FIELD_WALL_TYPES }, points: { prefix: "Point", types: POINT_TYPES }, sangar: { prefix: "Sangar", types: SANGAR_TYPES }, armscache: { prefix: "Cache", types: CACHE_TYPES }, ambushscreen: { prefix: "Screen", types: SCREEN_TYPES }, mirador: { prefix: "Tower", types: MIRADOR_TYPES }, barbedwire: { prefix: "Wire", types: WIRE_TYPES }, mgnest: { prefix: "Nest", types: NEST_TYPES }, mortarpit: { prefix: "Pit", types: PIT_TYPES }, fortpoint: { prefix: "Fort", types: FORT_TYPES }, sltower: { prefix: "Light", types: SLTOWER_TYPES }, fieldposts: { prefix: "Field", types: FIELD_POST_TYPES }, flnposts: { prefix: "Fln", types: FLN_POST_TYPES }, smallprops: { prefix: "Prop", types: SMALL_PROP_TYPES }, postkit: { prefix: "Bordj", types: BORDJ_TYPES }, rubble: { prefix: "Rubble", types: RUBBLE_TYPES }, vprops: { prefix: "Village", types: VPROP_TYPES }, flnmarks: { prefix: "Mark", types: MARK_TYPES }, farmstead: { prefix: "Farm", types: FARM_TYPES }, saspost: { prefix: "Sas", types: SAS_TYPES } };
/** World metres from the camera where a house's far level takes over (the RTS camera sits 50-130 m out). */
export const HOUSE_FAR = 60;
// THE KITS WITH SURFACES (2026-10-26 — the houses sharp, as the post): each its photo swaps ({ stone: "drystone" }: the
// Aurès' flat stones). A kit missing here, or built before its surfaces were written, draws its bake alone.
const SURFACE_KITS = { houses: { stone: "drystone" }, mzab: { stone: "drystone", plaster: "mudRender" }, mechta: { stone: "drystone", plaster: "mudRender" } };   // (their bakes' own stone photo; the M'zab's render smoother; the mechta's clay terrace the mud render)
const _surf = new Map();
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const _p = {};
let _parts = null;

/** Load a kit once ("houses": whitewashed, "mzab": the ochre town). Null if missing. */
export function loadHouses(kit = "houses") {
  const K = KITS[kit];
  // (THE SURFACES — a kit that writes them, its photo detail over the bake: algSurfaces; loaded beside it)
  return (_p[kit] ??= Promise.all([getSharedGltfLoader().loadAsync(`/models/alg/${kit}.glb`),
    SURFACE_KITS[kit] && !SURFACE_OFF ? surfaceTextures().catch(() => null) : null]).then(([gltf, ST]) => {
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
        // (NO EARTH DETAIL on a surfaced kit — the bake marks "earth…" faces, and the M'zab's renders are named so: its
        // walls took the soil photo; and the earth detail over this instanced material drew NOTHING, every house gone
        // from the game, 2026-10-26 — the surfaces carry the close-up detail)
        if (SURFACE_KITS[kit]) for (const k of ["_earth", "earthMask"]) if (m.geometry.attributes[k]) m.geometry.deleteAttribute(k);   // (the GLB's `_earth`: algGroundBlend hasEarth renames it)
        // (…and its geometry in REAL METRES: the surfaces tile in the geometry's space, and a meshopt-quantised GLB's is
        // its 16-bit units — the photos tiled at the wrong scale, a dotted grid over the M'zab's towers. The node's
        // transform baked in, the node reset: what the house field reads as `local` is identity.)
        if (SURFACE_KITS[kit] && !m.userData.metres) dequantise(m);
        // (one surface material a source material: the near and far share it, as they shared their atlas)
        if (ST && m.material && hasSurfaces(m.geometry)) {
          const src = m.material;
          m.material = _surf.get(src) ?? _surf.set(src, surfaceMaterial(src, ST, m.geometry.attributes.color.itemSize === 3 ? "vec3" : "vec4", SURFACE_KITS[kit])).get(src);
        }
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
      // ITS HAY PILES (house.py: the rooftop hay's spots, empties <piece>_Hay<i> — 2026-10-26): the straw-card piles of
      // algHaystack, placed with the house (its frame: the kit's real metres)
      const hay = [];
      for (let i = 0, e; (e = gltf.scene.getObjectByName(`${nm}_Hay${i}`)); i++) { e.updateMatrix(); hay.push(e.matrix.clone()); }
      _parts[`${ty}:${st}`] = { near, far: far?.isMesh ? far : near, decal: decal?.isMesh ? decal : null, hay };
    }
    // (THE GROUND BLEND as it loads — algGroundBlend KIT_BLEND: before anything can draw it)
    if (KIT_BLEND[kit]) whenGroundBlend((app) => blendKitParts(app, _parts, K.types, KIT_BLEND[kit]));
    return _parts;
  }).catch((e) => { console.warn("[houses]", e); return null; }));
}

/** A GLB mesh's geometry as plain floats in its PARENT's space (its node transform baked in), the node reset. */
function dequantise(m) {
  const src = m.geometry, g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(src.attributes)) {
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);   // (getComponent denormalises a normalized attribute)
    g.setAttribute(k, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array), 1));
  m.updateMatrix();
  g.applyMatrix4(m.matrix);
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.name = src.name;
  m.geometry = g;
  m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1); m.updateMatrix();
  m.userData.metres = true;
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
  for (const h of P.hay ?? []) haystackField().addMatrix(g, h.clone(), null, "pile");   // (its hay piles: algHaystack's field)
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
 * NO REBUILD ON A STATE CHANGE (2026-10-27): a shell on a depot (setState → "damaged") disposed EVERY mesh of
 * the field and made them again — three drops a disposed mesh's shader builds, so the new ones compiled
 * mid-fight: measured on the supply points, 4 builds, 3 pipelines, an 83–97 ms frame. Now every state of every
 * type the field holds has its meshes from the start (empty: an empty InstancedMesh is skipped before drawing,
 * render/emptyDrawSkip.js — and the boot's warm-up builds them), each sized for ALL that type's items, and a
 * rebuild keeps every set it can: a state change only moves instances between meshes.
 */
/** A house's hay piles into the haystack field (world: the house's matrix × each spot); their ids. */
function hayFor(m, key) {
  const P = _parts?.[key];
  return (P?.hay ?? []).map((h) => haystackField().addMatrix(null, new THREE.Matrix4().multiplyMatrices(m, h), null, "pile"));
}

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
    // capacity per "type:state" = every item of that TYPE (any state may hold them all) — see NO REBUILD
    const perType = new Map();
    for (const it of items) { const t = it.key.split(":")[0]; perType.set(t, (perType.get(t) ?? 0) + 1); }
    const need = new Map();
    for (const it of items) need.set(it.key, perType.get(it.key.split(":")[0]));
    for (const k of Object.keys(_parts ?? {})) { const n = perType.get(k.split(":")[0]); if (n) need.set(k, n); }
    for (const [key, s] of sets) {
      if (need.has(key) && s.cap >= need.get(key)) continue;
      for (const m of [s.near, s.far, s.decal]) if (m) { root.remove(m); m.dispose(); }
      sets.delete(key);
    }
    for (const [key, n] of need) {
      if (sets.has(key)) continue;
      const P = _parts?.[key];
      if (!P) continue;
      const decal = P.decal ? mesh(P.decal, n) : null;
      if (decal) decal.castShadow = false;
      sets.set(key, { near: mesh(P.near, n), far: mesh(P.far, n), decal, cap: n });
    }
    built = true;
  }
  return {
    root,
    /** A house; its id (for setState). */
    add(type, state, x, y, z, yaw = 0, scale = S) {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(scale, scale, scale));
      items.push({ key: `${type}:${state}`, m, p: new THREE.Vector3(x, y, z), hay: hayFor(m, `${type}:${state}`) });
      built = false;
      return items.length - 1;
    },
    setState(id, state) {
      const it = items[id]; if (!it) return;
      it.key = `${it.key.split(":")[0]}:${state}`; built = false;
      for (const h of it.hay) haystackField().remove(h);   // (its roof's hay: the state's own — a ruin's none)
      it.hay = hayFor(it.m, it.key);
    },
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
