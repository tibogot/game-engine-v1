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
import { float, mix, mx_noise_float, positionGeometry, positionWorld, smoothstep, texture, varying, vec2, vec3, dot, clamp } from "three/tsl";

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
export function blendKitParts(app, parts, types, { fade = 0.3, tint = GROUND_BLEND.tint, strength = GROUND_BLEND.strength } = {}) {
  if (!groundBlendAvailable(app) || !parts) return 0;
  let n = 0;
  for (const [key, P] of Object.entries(parts)) {
    if (!types.includes(key.split(":")[0])) continue;
    for (const lvl of ["near", "far"]) {
      const mesh = P[lvl], src = mesh?.material;
      if (!src || src.isNodeMaterial && src.userData?.gbBase) continue;
      let m = _blended.get(src);
      if (!m) {
        m = new THREE.MeshStandardNodeMaterial({ roughness: src.roughness ?? 0.9, metalness: src.metalness ?? 0, side: src.side });
        m.name = `${src.name || "kit"}:gblend`;
        const base = src.map ? texture(src.map).rgb.mul(vec3(src.color.r, src.color.g, src.color.b)) : vec3(src.color.r, src.color.g, src.color.b);
        if (src.normalMap) m.normalMap = src.normalMap;
        if (src.roughnessMap) m.roughnessMap = src.roughnessMap;
        m.userData.gbBase = base;
        m.colorNode = groundBlend(app, base, { fade, tint, strength });
        _blended.set(src, m);
        n++;
      }
      mesh.material = m;
    }
  }
  return n;
}
