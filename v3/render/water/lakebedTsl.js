/**
 * v3/render/water/lakebedTsl.js — underwater terrain shading (tint + caustics).
 *
 * The terrain-side half of the revo-realms water look, ported from their
 * Terrain.ts "WATER" block. The water surface itself (lakeMaterial.js) handles
 * absorption and reflections; this module makes the ground UNDER it read as a
 * lakebed: sand colour, a deep-water tint that grows with depth, a warm boost in
 * the shallows, and animated caustics.
 *
 * Differences from the original, both deliberate:
 *
 *  1. "Is this under water" comes from the shared water-surface map
 *     (waterSurfaceMap.js) instead of a hand-painted 512² mask — so it follows
 *     lakes as they are dragged around and rivers as they are re-carved, with no
 *     authoring step.
 *
 *  2. Depths are metres of vertical water (waterY - terrainY), not revo's
 *     positionWorld.y.negate() — their world has one lake at sea level, ours has
 *     water at any altitude.
 *
 * The caustics noise is a procedural Voronoi CRACK web rather than revo's
 * noise-atlas texture — but it is the same pattern: their caustics sample the
 * atlas's `.a` channel, documented as "cracks" (thin bright lines along cell
 * borders), softened by a mip bias. Real caustics ARE a Voronoi-edge net —
 * smooth blob noise here reads as murk, not light (tried first; it doesn't).
 * Two webs at different scales counter-scroll, get summed and cubed (revo's
 * exact shaping — the interference of the two moving nets is the shimmer).
 * Everything but the map lookup lives inside a real branch — dry terrain
 * (almost every fragment) pays one texture sample.
 */

import * as THREE from "three";
import {
  Fn, If, uniform, float, vec2, vec3,
  mix, smoothstep, max, min, floor, fract, dot, sin, length,
  texture, positionWorld, time,
} from "three/tsl";
import { createLakebedState } from "../../app/state/lakebedState.js";

// Same hash family as lakeMaterial.js's Worley (module-private there).
const _hash22 = /*#__PURE__*/ Fn(([p]) => {
  const px = dot(p, vec2(127.1, 311.7));
  const py = dot(p, vec2(269.5, 183.3));
  return fract(sin(vec2(px, py)).mul(43758.5453));
});

const _NEIGHBORS = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0], [0,  0], [1,  0],
  [-1,  1], [0,  1], [1,  1],
];

/**
 * Voronoi crack web — 1 on cell borders, 0 inside cells. Border distance is
 * F2 - F1 (the two nearest feature points); the wide smoothstep stands in for
 * the mip-bias blur revo applies to their cracks texture, and the cube in the
 * caller re-sharpens the summed webs into filaments.
 */
const _crackNoise = /*#__PURE__*/ Fn(([p]) => {
  const ip = floor(p);
  const fp = fract(p);
  const f1 = float(8).toVar();
  const f2 = float(8).toVar();
  for (const [nx, ny] of _NEIGHBORS) {
    const cell = vec2(float(nx), float(ny));
    const d = length(cell.add(_hash22(ip.add(cell))).sub(fp));
    // Branchless two-smallest: new F2 before F1, so the old F1 can demote into it.
    f2.assign(min(f2, max(f1, d)));
    f1.assign(min(f1, d));
  }
  return float(1).sub(smoothstep(float(0), float(0.6), f2.sub(f1)));
});

/**
 * @param {object}        deps
 * @param {THREE.Texture} deps.waterMapTex — waterSurfaceMap texture (R = water surface Y, NO_WATER_Y where dry)
 * @param {number}        deps.worldSize
 * @param {object}        [deps.params] — partial createLakebedState() override
 * @returns {{ apply: (baseColor) => node, syncParams: (s) => void, uniforms: object }}
 */
export function createLakebedShading({ waterMapTex, worldSize, params = {} }) {
  const p = { ...createLakebedState(), ...params };

  const u = {
    enabled:           uniform(p.enabled ? 1 : 0),
    sandColor:         uniform(new THREE.Color(p.sandColor)),
    sandMix:           uniform(p.sandMix),
    deepColor:         uniform(new THREE.Color(p.deepColor)),
    tintDepth:         uniform(p.tintDepth),
    shallowBoost:      uniform(p.shallowBoost),
    shallowDepth:      uniform(p.shallowDepth),
    causticsIntensity: uniform(p.causticsIntensity),
    causticsColor:     uniform(new THREE.Color(p.causticsColor)),
    causticsScale1:    uniform(p.causticsScale1),
    causticsScale2:    uniform(p.causticsScale2),
    causticsSpeed:     uniform(p.causticsSpeed),
    causticsMaxDepth:  uniform(p.causticsMaxDepth),
    shoreBlend:        uniform(p.shoreBlend),
  };

  /**
   * Wrap a terrain colour node: returns the same colour on dry land, the lakebed
   * treatment under water. Call once per material — uniforms are shared, so every
   * caller (each terrain LOD level) stays in sync.
   */
  const apply = (baseColor) => Fn(() => {
    const out = vec3(baseColor).toVar();

    const wxz    = positionWorld.xz;
    const mapUv  = wxz.div(float(worldSize)).add(0.5);
    const waterY = texture(waterMapTex, mapUv).r;
    const depth  = waterY.sub(positionWorld.y);

    // Fades in over shoreBlend metres of water. Overhanging water quads write
    // waterY BELOW the dry terrain around them, so depth < 0 masks them out.
    const mask = smoothstep(float(0), max(u.shoreBlend, float(1e-3)), depth)
      .mul(u.enabled);

    If(mask.greaterThan(0.001), () => {
      // Caustics: two counter-scrolling Voronoi crack webs, summed and cubed.
      // Where the moving nets cross, the sum peaks and the cube turns it into a
      // bright focused filament; everywhere else it falls to dim noise.
      const t  = time.mul(u.causticsSpeed);
      const n1 = _crackNoise(wxz.mul(u.causticsScale1).add(vec2(t, 0)));
      const n2 = _crackNoise(wxz.mul(u.causticsScale2).add(vec2(0, t.negate())));
      const c  = n1.add(n2);
      const c3 = c.mul(c).mul(c);
      // Light stops reaching the bed with depth (revo's -1 start keeps a little
      // sparkle right at the waterline).
      const causticsFade = float(1).sub(smoothstep(float(-1), u.causticsMaxDepth, depth));
      const caustics = u.causticsColor.mul(u.causticsIntensity).mul(c3.mul(causticsFade));

      // Sand bed -> deep tint with depth, warm boost in the shallows.
      const bed        = mix(out, u.sandColor, u.sandMix);
      const deepFactor = smoothstep(float(0), max(u.tintDepth, float(1e-3)), depth);
      const shallow    = vec3(1.0, 0.9, 0.7).mul(0.1).mul(u.shallowBoost)
        .mul(smoothstep(float(0), max(u.shallowDepth, float(1e-3)), depth));

      const bedColor = mix(bed, u.deepColor, deepFactor).add(shallow).add(caustics);
      out.assign(mix(out, bedColor, mask));
    });

    return out;
  })();

  const _c = (hex, target) => target.set(hex);

  /** Push a lakebed state object (createLakebedState shape) into the uniforms. */
  function syncParams(s) {
    if (!s) return;
    if (s.enabled           != null) u.enabled.value           = s.enabled ? 1 : 0;
    if (s.sandColor         != null) _c(s.sandColor, u.sandColor.value);
    if (s.sandMix           != null) u.sandMix.value           = s.sandMix;
    if (s.deepColor         != null) _c(s.deepColor, u.deepColor.value);
    if (s.tintDepth         != null) u.tintDepth.value         = s.tintDepth;
    if (s.shallowBoost      != null) u.shallowBoost.value      = s.shallowBoost;
    if (s.shallowDepth      != null) u.shallowDepth.value      = s.shallowDepth;
    if (s.causticsIntensity != null) u.causticsIntensity.value = s.causticsIntensity;
    if (s.causticsColor     != null) _c(s.causticsColor, u.causticsColor.value);
    if (s.causticsScale1    != null) u.causticsScale1.value    = s.causticsScale1;
    if (s.causticsScale2    != null) u.causticsScale2.value    = s.causticsScale2;
    if (s.causticsSpeed     != null) u.causticsSpeed.value     = s.causticsSpeed;
    if (s.causticsMaxDepth  != null) u.causticsMaxDepth.value  = s.causticsMaxDepth;
    if (s.shoreBlend        != null) u.shoreBlend.value        = s.shoreBlend;
  }

  return { apply, syncParams, uniforms: u };
}
