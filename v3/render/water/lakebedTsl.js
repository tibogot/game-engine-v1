/**
 * v3/render/water/lakebedTsl.js — underwater terrain shading (tint + caustics).
 *
 * The terrain-side half of the revo-realms water look, ported from their
 * Terrain.ts "WATER" block. The water surface itself (lakeMaterial.js) handles
 * absorption and reflections; this module makes the ground UNDER it read as a
 * lakebed: sand colour, a deep-water tint that grows with depth, a warm boost in
 * the shallows, and animated caustics.
 *
 * Differences from the original, all deliberate:
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
 *  3. The caustics OUTCLASS the original's scrolled "cracks" texture: they are
 *     the classic iterative-trig water caustic (the widely-copied tileable
 *     Shadertoy pattern). Each iteration warps the domain by trig of the warped
 *     domain, so the filament net MORPHS internally — filaments split, merge and
 *     wander like real refracted sunlight — instead of two static webs sliding
 *     past each other. On top of that, optional chromatic dispersion samples the
 *     pattern three times at a slight spatial offset, giving the red/blue
 *     fringes real caustics have. History of this slot: smooth value noise
 *     (read as murk), then a Voronoi F2−F1 crack web (static filaments, revo
 *     parity) — both retired for this.
 *
 * Everything but the map lookup lives inside a real branch — dry terrain
 * (almost every fragment) pays one texture sample.
 */

import * as THREE from "three";
import {
  Fn, If, uniform, float, vec2, vec3,
  mix, smoothstep, max, abs, pow, sin, cos, length, fract,
  texture, positionWorld, time,
} from "three/tsl";
import { createLakebedState } from "../../app/state/lakebedState.js";

/** Iterations of the domain warp. 4 is the sweet spot; 3 loses filament detail. */
const CAUSTIC_ITER = 4;
const TAU = 6.28318530718;

/**
 * Tileable iterative-trig water caustic, scalar brightness in ~[0, 1.5].
 * `uv` is in pattern tiles (period 1), `t` in seconds. The per-iteration time
 * factor (1 − 3.5/(n+1)) makes the layers counter-rotate, which is what keeps
 * the net alive rather than drifting as one rigid sheet. `sharpness` is the
 * final pow — high values pinch the net into thin bright filaments.
 */
const _caustic = /*#__PURE__*/ Fn(([uv, t, sharpness]) => {
  // mod(uv·TAU, TAU) − 250, verbatim from the original. BOTH parts matter: the
  // mod makes the pattern stationary across the world (it repeats per tile
  // instead of depending on |world position|), and the −250 keeps |p| ≈ 250 so
  // the 1/length(p/…) terms stay normalized — without it the sum explodes near
  // the domain origin (bed blows out white with black holes; seen live).
  const p = fract(uv).mul(TAU).sub(250).toVar();
  const i = p.toVar();
  const c = float(1).toVar();
  const inten = 0.005;

  for (let n = 0; n < CAUSTIC_ITER; n++) {
    const tt = t.mul(1.0 - 3.5 / (n + 1));
    i.assign(p.add(vec2(
      cos(tt.sub(i.x)).add(sin(tt.add(i.y))),
      sin(tt.sub(i.y)).add(cos(tt.add(i.x))),
    )));
    c.addAssign(float(1).div(length(vec2(
      p.x.div(sin(i.x.add(tt)).div(inten)),
      p.y.div(cos(i.y.add(tt)).div(inten)),
    ))));
  }

  c.divAssign(CAUSTIC_ITER);
  c.assign(float(1.17).sub(pow(c, 1.4)));
  return pow(abs(c), sharpness);
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
    enabled:            uniform(p.enabled ? 1 : 0),
    sandColor:          uniform(new THREE.Color(p.sandColor)),
    sandMix:            uniform(p.sandMix),
    deepColor:          uniform(new THREE.Color(p.deepColor)),
    tintDepth:          uniform(p.tintDepth),
    shallowBoost:       uniform(p.shallowBoost),
    shallowDepth:       uniform(p.shallowDepth),
    causticsIntensity:  uniform(p.causticsIntensity),
    causticsColor:      uniform(new THREE.Color(p.causticsColor)),
    causticsScale:      uniform(p.causticsScale),
    causticsSharpness:  uniform(p.causticsSharpness),
    causticsDispersion: uniform(p.causticsDispersion),
    causticsSpeed:      uniform(p.causticsSpeed),
    causticsMaxDepth:   uniform(p.causticsMaxDepth),
    shoreBlend:         uniform(p.shoreBlend),
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
      // Caustics with chromatic dispersion: light of different wavelengths
      // refracts to slightly different spots, so R, G and B sample the pattern
      // at a small spatial stagger. Dispersion 0 still converges (three equal
      // samples) — no separate path needed.
      const t    = time.mul(u.causticsSpeed);
      // Static domain warp at frequencies incommensurate with the tile period.
      // The pattern is exactly tileable (the mod in _caustic), and dozens of
      // tiles are visible across a lake — without this the same motif repeats
      // as an obvious grid. The warp shifts every tile's sampling differently,
      // so the repetition never lines up. No time term: morphing is _caustic's
      // job, and a moving warp would smear its filaments.
      const rUv  = wxz.mul(u.causticsScale);
      const cUv  = rUv.add(vec2(
        sin(rUv.y.mul(0.83).add(rUv.x.mul(0.19))),
        cos(rUv.x.mul(0.71).sub(rUv.y.mul(0.23))),
      ).mul(0.35));
      const dOff = vec2(1, 1).mul(u.causticsDispersion.mul(0.012));
      const sh   = max(u.causticsSharpness, float(1));

      const cr = _caustic(cUv, t, sh);
      const cg = _caustic(cUv.add(dOff), t, sh);
      const cb = _caustic(cUv.add(dOff.mul(2)), t, sh);

      // Light stops reaching the bed with depth (the -1 start keeps a little
      // sparkle right at the waterline — revo's constant).
      const causticsFade = float(1).sub(smoothstep(float(-1), u.causticsMaxDepth, depth));
      const caustics = vec3(cr, cg, cb)
        .mul(u.causticsColor).mul(u.causticsIntensity).mul(causticsFade);

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
    if (s.enabled            != null) u.enabled.value            = s.enabled ? 1 : 0;
    if (s.sandColor          != null) _c(s.sandColor, u.sandColor.value);
    if (s.sandMix            != null) u.sandMix.value            = s.sandMix;
    if (s.deepColor          != null) _c(s.deepColor, u.deepColor.value);
    if (s.tintDepth          != null) u.tintDepth.value          = s.tintDepth;
    if (s.shallowBoost       != null) u.shallowBoost.value       = s.shallowBoost;
    if (s.shallowDepth       != null) u.shallowDepth.value       = s.shallowDepth;
    if (s.causticsIntensity  != null) u.causticsIntensity.value  = s.causticsIntensity;
    if (s.causticsColor      != null) _c(s.causticsColor, u.causticsColor.value);
    if (s.causticsScale      != null) u.causticsScale.value      = s.causticsScale;
    if (s.causticsSharpness  != null) u.causticsSharpness.value  = s.causticsSharpness;
    if (s.causticsDispersion != null) u.causticsDispersion.value = s.causticsDispersion;
    if (s.causticsSpeed      != null) u.causticsSpeed.value      = s.causticsSpeed;
    if (s.causticsMaxDepth   != null) u.causticsMaxDepth.value   = s.causticsMaxDepth;
    if (s.shoreBlend         != null) u.shoreBlend.value         = s.shoreBlend;
  }

  return { apply, syncParams, uniforms: u };
}
