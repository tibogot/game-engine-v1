/**
 * ONE WAY TO CUT A SHAPE OUT OF A CARD (leaves, plumes, straw, fronds).
 *
 * With MSAA on, the cut edge is ALPHA-TO-COVERAGE: the card's alpha decides how
 * many of the pixel's 4 samples it covers, so leaf edges come out smooth
 * instead of stair-stepped, and a canopy speckles and shimmers far less.
 *
 * Not three's own alphaToCoverage + alphaTest: that puts its one-pixel ramp
 * entirely ABOVE the cut-off — smoothstep(t, t + fwidth(a), a) — and at a
 * distance, where a leaf is a pixel or two, it takes most of the leaf away:
 * whole crowns went thin and see-through (fog-lab trees, 2026-10-26). This is
 * Ben Golus's "sharpened" coverage, the ramp CENTRED on the cut-off:
 *   coverage = (a - t) / fwidth(a) + 0.5
 * so a leaf keeps on average what the alpha test kept, edges smooth. Measured
 * there: near leaf edges smooth, mid and far crowns as full as before, less
 * speckle (the user: "alpha to coverage look better").
 *
 * With MSAA off (the Low setting, ?msaa=0) the samples are not there, so it is
 * the plain alpha test; ?a2c=0 forces that too (A/B, or a game that wants it). Shadows are always the hard cut (no MSAA in a shadow
 * map): `maskShadowNode`, without which a card casts its whole square.
 */
import { Fn, Discard, clamp, float, fwidth, max } from "three/tsl";

// (r186: coverage is written as the colour target's ALPHA, so a frame drawn with these cards has
// alpha below 1 at their edges; the post pipeline's final renderOutput treats the frame as opaque —
// postFxPipeline.js opaqueOutput — or r186's premultiply round trip rims every leaf in dark.)

// Whether cut-outs use coverage, for materials that do not say: the app sets it once at boot
// from its renderer (MSAA on, and no ?a2c=0) — materials are built after that.
let coverageDefault = true;
/** @param {boolean} on  `renderer.samples > 1` (main.js, right after the renderer exists) */
export function setAlphaCoverageDefault(on) { coverageDefault = !!on; }

/**
 * @param {THREE.NodeMaterial} material  opaque (transparent false)
 * @param {Node} alpha     the card's shape, 0..1 (e.g. a mask texture's channel)
 * @param {object} [o]
 * @param {number} [o.threshold=0.5]  the cut-off
 * @param {boolean} [o.coverage]  alpha-to-coverage; default: the app's (setAlphaCoverageDefault)
 * @param {boolean} [o.shadow=true]  also set the shadow cut (maskShadowNode). false for a
 *   material that cuts its own shadow (e.g. with a cut-off that must not follow the camera:
 *   in the shadow pass "the camera" is the light's)
 * @returns {THREE.NodeMaterial} the same material
 */
export function applyAlphaCutout(material, alpha, { threshold = 0.5, coverage = coverageDefault, shadow = true } = {}) {
  const t = float(threshold);
  if (coverage) {
    const cov = clamp(alpha.sub(t).div(max(fwidth(alpha), float(1e-4))).add(0.5), 0, 1);
    material.opacityNode = Fn(() => {
      Discard(cov.lessThanEqual(0));
      return cov;
    })();
    material.alphaTest = 0;
    material.alphaToCoverage = true;
  } else {
    material.opacityNode = alpha;
    material.alphaTest = threshold;
    material.alphaToCoverage = false;
  }
  if (shadow) material.maskShadowNode = alpha.greaterThanEqual(t);
  return material;
}
