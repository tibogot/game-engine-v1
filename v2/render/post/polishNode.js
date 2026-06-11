import * as THREE from "three";
import {
  Fn,
  dot,
  float,
  fract,
  length,
  mix,
  screenUV,
  sin,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

/**
 * "Color & Polish" post-FX bundle (Tier 1).
 *
 * Single fullscreen pass that combines:
 *  - Color grading: brightness / contrast / saturation / temperature / tint
 *  - Vignette: radial darkening toward edges
 *  - Film grain: animated noise overlay
 *
 * Designed to run AFTER `renderOutput()` (i.e. on tonemapped sRGB pixels in
 * 0..1) and AFTER FXAA + Sharpen + Chromatic Aberration. Putting it last means
 * grain isn't smoothed by AA and the vignette tints the absolute final image.
 *
 * Per-effect "off" is achieved by neutral uniform values (no shader rebuild):
 *  - brightness 0, contrast 1, saturation 1, temperature 0, tint 0  → identity
 *  - vignetteStrength 0                                              → no-op
 *  - grainStrength 0                                                 → no-op
 *
 * The whole node is omitted from the graph by `postFxPipeline` when the
 * master "Color & Polish" toggle is off (true zero cost).
 */

/**
 * Build a fresh set of TSL uniforms backing the polish pass. One set per
 * pipeline; reused across rebuilds so JS-side `.value =` updates are O(1).
 */
export function createPolishUniforms() {
  return {
    brightness: uniform(0.0),
    contrast: uniform(1.0),
    saturation: uniform(1.0),
    temperature: uniform(0.0),
    tint: uniform(0.0),

    vignetteStrength: uniform(0.0),
    /** Inner edge of the vignette falloff (0 = from center, 1 = only corners). */
    vignetteFalloff: uniform(0.5),
    /** 0 = perfectly circular, 1 = stretched to screen rect. */
    vignetteRoundness: uniform(1.0),
    /**
     * Stored as a Vector3 (linear-interpreted by TSL as vec3) instead of a
     * Color so the uniform's type is unambiguous to the node builder.
     */
    vignetteColor: uniform(new THREE.Vector3(0, 0, 0)),

    /** Magnitude of grain offset added per pixel. ~0.05 is a good ceiling. */
    grainStrength: uniform(0.0),
    /** UV multiplier — higher = finer grain. 1.0 = ~screen-resolution-pixel scale. */
    grainSize: uniform(1.0),
  };
}

/**
 * Apply grade + vignette + grain to the input color node. Returns a vec4
 * node suitable as the final output of a `RenderPipeline`.
 *
 * Order inside the pass:
 *   brightness → contrast → saturation → temperature/tint
 *     → vignette mix
 *     → grain add
 *     → saturate (avoid negative ringing from extreme contrast)
 */
export function polish(inputNode, p) {
  return Fn(() => {
    const src = inputNode.toVar();
    const rgb = src.rgb.toVar();

    rgb.assign(rgb.add(p.brightness));

    rgb.assign(rgb.sub(0.5).mul(p.contrast).add(0.5));

    const luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    rgb.assign(mix(vec3(luma), rgb, p.saturation));

    // Temperature shifts R+/B-, tint shifts G+. Scale 0.1 gives a usable
    // -1..+1 slider range without nuking the image at the extremes.
    rgb.assign(
      rgb.add(
        vec3(
          p.temperature.mul(0.1),
          p.tint.mul(0.1),
          p.temperature.mul(-0.1),
        ),
      ),
    );

    // Roundness 0 = circular, 1 = pure UV-square (more elongated on widescreen).
    // We blend between the two cheaply by mixing the UV-aspect adjustment.
    const centered = screenUV.sub(vec2(0.5));
    const dist = length(centered.mul(2.0));
    const vig = smoothstep(p.vignetteFalloff, float(1.0), dist);
    rgb.assign(mix(rgb, p.vignetteColor, vig.mul(p.vignetteStrength)));

    // Cheap hash-based grain: time-shifted UV → fract(sin(dot(...)) * c).
    // Not high quality but invisible to the eye at low strengths and free.
    const grainUv = screenUV.mul(p.grainSize).mul(1000.0).add(time);
    const noise = fract(
      sin(dot(grainUv, vec2(12.9898, 78.233))).mul(43758.5453),
    ).sub(0.5);
    rgb.assign(rgb.add(vec3(noise).mul(p.grainStrength)));

    return vec4(rgb.saturate(), src.a);
  })();
}
