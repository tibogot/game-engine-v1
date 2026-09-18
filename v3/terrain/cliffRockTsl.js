import * as THREE from "three";
import { Fn, clamp, float, max, smoothstep, uniform, vec2 } from "three/tsl";
import { MAX_HEIGHT } from "./heightmapTexture.js";
import { ROCK_BASE_COLOR, rockShadeTint, rockShadeUniforms } from "../props/rockShading.js";

/**
 * THE TERRAIN'S CLIFF, SHADED LIKE THE ROCK PROPS.
 *
 * The procedural rock kit has no texture: its look is a recipe baked per
 * vertex (v3/props/rockShading.js) — a cool base rising to a light top, chip
 * edges catching light, undersides darker, soft world mottling. A terrain
 * cliff painted with a tiling rock TEXTURE can never match it: the drawn
 * cracks and blobs are exactly what the rocks do not have, so a boulder
 * standing against a cliff always reads as a different material.
 *
 * So the cliff layer runs the SAME recipe, off terrain data, sharing the same
 * uniforms — tune the rocks and the cliffs follow:
 *
 *   - "how high on the rock" becomes LOCAL RELIEF: how far this point stands
 *     above the ground a few metres around it. The foot of a face sits low
 *     against its surroundings (dark, cool); the shoulder stands well above
 *     them (light). It works the same on a 4 m outcrop and a 60 m wall,
 *     which a world-height gradient would not.
 *   - "chip edge" becomes CONVEXITY: the same four neighbours say whether the
 *     ground bulges out here (a ridge or a nose — bright) or cups in (a gully
 *     — left alone).
 *
 * Cost: eight extra taps of the baked surface texture — the SAME sampler the
 * terrain already reads, so nothing is added to WebGPU's 16-sampler ceiling —
 * plus the shared tint's arithmetic. Generated only for the layers that ask
 * for it (see splatOverlayTsl's rock-shade compile gate).
 */

/** Terrain-side knobs; the look itself comes from rockShadeUniforms. */
export function createCliffRockUniforms() {
  return {
    /** How far out "the surrounding land" is measured (m). */
    uReliefStep: uniform(70),
    /** Height above / below that land which spans dark base → light top (m). */
    uReliefSpan: uniform(55),
    /** The short step the edge light reads curvature over (m). */
    uConvexStep: uniform(9),
    /** Convexity (m, over the short step) where the edge light starts / is full. */
    uConvexLo: uniform(0.15),
    uConvexHi: uniform(1.2),
    /** The stone's own colour — the rock props' default, so both start equal. */
    uBase: uniform(new THREE.Color(ROCK_BASE_COLOR)),
  };
}

/**
 * The colour multiplier for a cliff-shaded terrain layer.
 *
 * @param {object} o
 *   surfaceAt(uvNode)  the baked surface texture (.xyz normal, .w height)
 *   uv                 this pixel's heightmap UV
 *   normalYNode        world normal Y here
 *   worldSize          terrain edge (m)
 *   cu                 createCliffRockUniforms()
 *   u                  rock knobs (shared set by default)
 */
export const cliffRockTint = (o) => {
  const { surfaceAt, uv, normalYNode, worldSize, cu, u = rockShadeUniforms } = o;
  return Fn(() => {
    const h = (u2) => surfaceAt(u2).w.mul(float(MAX_HEIGHT));
    const hC = h(uv);

    // ── Where on the mountain: height against the SURROUNDING LAND ──
    // Measured near (a few metres) every point on a long face looks equally
    // high above its neighbours, so the whole wall came out one flat value.
    // Read far out instead: a valley floor sits below the land around it
    // (dark, cool), a shoulder or a ridge well above it (light) — the rock's
    // base-to-top gradient, at mountain scale.
    const far = cu.uReliefStep.div(float(worldSize));
    const meanFar = h(vec2(uv.x.sub(far), uv.y))
      .add(h(vec2(uv.x.add(far), uv.y)))
      .add(h(vec2(uv.x, uv.y.sub(far))))
      .add(h(vec2(uv.x, uv.y.add(far)))).mul(0.25);
    const h01 = clamp(hC.sub(meanFar).div(max(cu.uReliefSpan, float(0.01))).add(0.5), 0, 1);

    // ── Chip edges: convex over a SHORT step (a nose or a ridge, not a wall) ──
    const near = cu.uConvexStep.div(float(worldSize));
    const meanNear = h(vec2(uv.x.sub(near), uv.y))
      .add(h(vec2(uv.x.add(near), uv.y)))
      .add(h(vec2(uv.x, uv.y.sub(near))))
      .add(h(vec2(uv.x, uv.y.add(near)))).mul(0.25);
    const edge01 = smoothstep(cu.uConvexLo, cu.uConvexHi, hC.sub(meanNear));

    return rockShadeTint({ edge01, h01, normalYNode }, u);
  })();
};
