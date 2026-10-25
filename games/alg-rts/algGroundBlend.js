// GROUND BLEND — what stands on the ground takes the ground's colour at its foot (2026-10-24, you, on the scanned
// boulders: "they are not blending with the terrain, something looks fake — Unreal, Unity, Godot have something to
// blend with the terrain"). Unreal's runtime-virtual-texture blend, the same idea on our ground cache:
//
//   FOOT    the lowest `fade` metres fade into the ground's own colour under it (the cache: paint, splats, decals),
//           the edge ragged by a noise (a straight line reads as a cut)
//   TINT    the whole piece leans a little toward the local ground's hue, its own brightness kept — the same rock is a
//           touch greener on the camp's grass, ochre on the Aurès
//
// CHEAP: the ground's height and colour are read PER VERTEX (two taps in the vertex stage, a rock's ~800 vertices) and
// interpolated; the fragment adds one noise. No new draw. Off (the material untouched) without a ground cache, or with
// ?gblend=0 (an A/B).
import * as THREE from "three";
import { attribute, float, mix, mx_noise_float, normalWorld, positionGeometry, positionWorld, smoothstep, texture, varying, vec2, vec3, dot, clamp } from "three/tsl";
import { loadTexture } from "../../v3/render/textureLoad.js";
import { hexSample } from "../../v3/render/hexTiling.js";

// THE EARTH'S DETAIL (2026-10-25, you: the mortar pit's, the fortified point's and the MG nest's pit — "a low-res
// texture"): a kit's earth (its berm, its spoil) is a few texels a centimetre of the shared atlas — a smear close up.
// The faces the bake marked earth (tools/blender/bkit.py earth_mask: the `_earth` vertex attribute) get a fine tiling
// soil photo laid over their baked colour: its LUMINANCE only (the bake's colour, light and AO kept), hex-tiled (no
// repeat grid), projected in world space from above and the sides by the surface's slope. One texture for every kit.
const EARTH_PHOTO = "/textures/ground/dry_ground_rocks/dry_ground_rocks_diff_1k.jpg";
let _earthTex = null;
function earthTexture() {
  if (_earthTex) return _earthTex;
  const grey = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);   // (until the photo arrives: no effect)
  // (FILTERED, as the photo will be: a DataTexture's default nearest filtering is bound without a sampler, and the hex
  // tiling's sampling needs one — "unresolved value nodeUniform_sampler", the pits invisible, when the shader was built
  // before the photo arrived)
  grey.magFilter = grey.minFilter = THREE.LinearFilter;
  grey.needsUpdate = true;
  _earthTex = texture(grey);
  loadTexture(EARTH_PHOTO).then((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; _earthTex.value = t; })
    .catch((e) => console.warn("[earth detail]", e?.message ?? e));
  return _earthTex;
}
// (glTF names a custom attribute with an underscore — `_earth`; kept as `earthMask` on its geometry)
export function hasEarth(geo) {
  if (!geo?.getAttribute) return false;
  const a = geo.getAttribute("_earth");
  if (a) { geo.setAttribute("earthMask", a); geo.deleteAttribute("_earth"); }
  return !!geo.getAttribute("earthMask");
}
/**
 * `base` with the soil photo over the earth faces: the PHOTO's colour and grain at the bake's BRIGHTNESS (its light and
 * AO kept, its blotchy low-res colour not — modulating it only kept the smear). Call only for a geometry hasEarth().
 */
export function earthDetail(base, { strength = 0.9, metres = 1.6 } = {}) {
  const tex = earthTexture(), wp = positionWorld, n = normalWorld.abs();
  const LUM = vec3(0.3, 0.59, 0.11);
  const at = (uv) => hexSample(tex, uv.div(metres), null, { rotate: false }).rgb;
  // (three projections — from above, along x, along z — weighted by the normal: a ring berm faces every way; one
  // diagonal side projection stretched the photo into streaks where the slope looked along it)
  const w = vec3(n.x.pow(4), n.y.pow(4), n.z.pow(4)), ws = w.x.add(w.y).add(w.z).max(1e-4);
  const photo = at(vec2(wp.z, wp.y)).mul(w.x).add(at(vec2(wp.x, wp.z)).mul(w.y)).add(at(vec2(wp.x, wp.y)).mul(w.z)).div(ws);
  // its brightness set to the bake's (the photo's mean — its last mip, one texel — brought to the base's luminance)
  const mean = dot(tex.sample(vec2(0.5, 0.5)).level(float(12)).rgb, LUM).max(0.05);
  // (the bake's brightness at HALF its contrast — a geometric mean with a typical earth's 0.3: its shading kept, the
  // patchwork of its low-res blotches flattened)
  const lb = dot(base, LUM).max(1e-3).mul(0.3).sqrt();
  const earth = photo.mul(lb.div(mean));
  return mix(base, earth, attribute("earthMask", "float").mul(strength));
}

export const GROUND_BLEND = { fade: 0.75, strength: 0.95, tint: 0.3, fadeFrac: 0.7 };   // (seen from the RTS camera a rock is mostly its TOP: the tint carries the blend there, the foot fade the sides — 0.14 tint, 0.38 of the height: "I can't see any difference")
const OFF = typeof location !== "undefined" && new URLSearchParams(location.search).get("gblend") === "0";

/** True when the blend can run (a ground cache and the heightmap). */
export function groundBlendAvailable(app) { return !OFF && !!app?.groundCache?.tone && !!app?.heightTexNode; }

/**
 * `base` (a vec3 colour node, linear) blended with the ground under it. Returns `base` unchanged when unavailable.
 * @param o.fade      metres up from the ground the foot fades over
 * @param o.strength  0..1 how much of the ground's colour at the very foot
 * @param o.tint      0..1 the whole piece's lean toward the ground's hue
 */
// (`bounds` { minY, maxY } — the piece's geometry's own height (2026-10-24, you: "C"): the foot fades over the lowest
// `fadeFrac` OF ITS HEIGHT, so a low flat rock and a tall one take the ground in the same proportion — over a fixed
// 0.75 m a flat rock went green all over, "mossy". Without bounds: `fade` metres.)
export function groundBlend(app, base, { fade = GROUND_BLEND.fade, strength = GROUND_BLEND.strength, tint = GROUND_BLEND.tint, bounds = null, fadeFrac = GROUND_BLEND.fadeFrac } = {}) {
  if (!groundBlendAvailable(app)) return base;
  const W = app.worldSize ?? 1024, TOP = app.maxHeight ?? 250, HALF = W / 2;
  const wp = positionWorld;
  // (per vertex: the ground's height under this vertex, and its colour)
  const groundY = texture(app.heightTexNode, clamp(vec2(wp.x.add(HALF).div(W), wp.z.add(HALF).div(W)), 0, 1)).level(0).r.mul(TOP);
  const above = varying(wp.y.sub(groundY), "vGbAbove");
  const tone = varying(app.groundCache.tone(vec2(wp.x, wp.z)), "vGbTone");
  // the piece's hue toward the ground's, its brightness kept
  const LUM = vec3(0.3, 0.59, 0.11);
  const lb = dot(base, LUM), lt = dot(tone, LUM).max(1e-3);
  let col = mix(base, tone.mul(lb.div(lt)), float(tint));
  // the foot: a ragged fade (noise ±35 % on the height)
  const n = mx_noise_float(wp.mul(1.7)).mul(0.35).add(1);
  const h = bounds ? varying(positionGeometry.y.sub(bounds.minY).div(Math.max(1e-4, bounds.maxY - bounds.minY)), "vGbFrac") : above;
  const k = float(1).sub(smoothstep(0, float(bounds ? fadeFrac : fade).mul(n), h)).mul(strength);
  return mix(col, tone, k);
}

/**
 * A Blender kit's loaded pieces (algHouse loadHouses' parts: "type:state" → { near, far }) on ground-blended materials
 * — their baked atlas × colour, the foot `fade` m into the ground. Call RIGHT AFTER the kit loads, before anything
 * draws them (swapping a drawn instanced mesh's material left three's cached shadow build behind — a render error).
 * Each source material converted once (near and far share it). Returns how many materials.
 */
const _blended = new WeakMap();
export function blendKitParts(app, parts, types, opts = {}) {
  if (!groundBlendAvailable(app) || !parts) return 0;
  let n = 0;
  for (const [key, P] of Object.entries(parts)) {
    if (!types.includes(key.split(":")[0])) continue;
    for (const lvl of ["near", "far"]) n += blendMesh(app, P[lvl], opts);
  }
  return n;
}
/** One mesh's (a loaded GLB's) material swapped for its ground-blended copy; 1 when a new one was made. */
export function blendMesh(app, mesh, { fade = 0.3, tint = GROUND_BLEND.tint, strength = GROUND_BLEND.strength } = {}) {
  let n = 0;
  {
    {
      const src = mesh?.material;
      if (!groundBlendAvailable(app) || !src || src.isNodeMaterial && src.userData?.gbBase) return 0;
      let m = _blended.get(src);
      if (!m) {
        m = new THREE.MeshStandardNodeMaterial({ roughness: src.roughness ?? 0.9, metalness: src.metalness ?? 0, side: src.side });
        m.name = `${src.name || "kit"}:gblend`;
        const base = src.map ? texture(src.map).rgb.mul(vec3(src.color.r, src.color.g, src.color.b)) : vec3(src.color.r, src.color.g, src.color.b);
        // (the source's own map and colour kept on it: other builders read them — algSangar's piece materials)
        m.map = src.map ?? null; m.color.copy(src.color);
        if (src.normalMap) m.normalMap = src.normalMap;
        if (src.roughnessMap) m.roughnessMap = src.roughnessMap;
        m.userData.gbBase = base;
        m.colorNode = groundBlend(app, base, { fade, tint, strength });
        if (hasEarth(mesh.geometry)) m.colorNode = earthDetail(m.colorNode);   // (its earth: the soil photo over it)
        _blended.set(src, m);
        n++;
      }
      mesh.material = m;
    }
  }
  return n;
}

// THE GAME'S APP for the loaders (2026-10-24 — every Blender kit blended AS IT LOADS, before anything can draw it:
// algHouse loadHouses, algMotorPool): a kit loaded before the app is known waits in the queue.
let _app = null;
const _queue = [];
export const groundBlendApp = () => _app;
export function setGroundBlendApp(app) { _app = app; for (const f of _queue.splice(0)) f(); }
export function whenGroundBlend(f) { if (_app) f(_app); else _queue.push(() => f(_app)); }
/** Each kit's blend (algHouse KITS keys): how high its foot takes the ground, how much it leans to its hue. None: as built
 *  (the barbed wire: thin strands; the small props: in hands and the HUD). */
export const KIT_BLEND = {
  houses: { fade: 0.9, tint: 0.1, strength: 0.75 }, mzab: { fade: 0.9, tint: 0.1, strength: 0.75 }, postkit: { fade: 0.9, tint: 0.1, strength: 0.75 },
  rubble: { fade: 0.6 }, fieldwalls: { fade: 0.55, tint: 0.35 }, vprops: { fade: 0.4, tint: 0.3 },
  points: { fade: 0.35, tint: 0.25 }, sangar: { fade: 0.5, tint: 0.3 }, mgnest: { fade: 0.45, tint: 0.3 }, mortarpit: { fade: 0.45, tint: 0.3 },
  fortpoint: { fade: 0.4, tint: 0.3 }, armscache: { fade: 0.4, tint: 0.3 }, ambushscreen: { fade: 0.5, tint: 0.3 },
  mirador: { fade: 0.5, tint: 0.2 }, sltower: { fade: 0.5, tint: 0.2 }, fieldposts: { fade: 0.35, tint: 0.25 }, flnposts: { fade: 0.5, tint: 0.3 },
  motorPool: { fade: 0.5, tint: 0.12, strength: 0.8 },
};
