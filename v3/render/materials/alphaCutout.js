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
 * the plain alpha test. Shadows are always the hard cut (no MSAA in a shadow
 * map): `maskShadowNode`, without which a card casts its whole square.
 */
import { Fn, Discard, clamp, float, fwidth, max } from "three/tsl";

/**
 * @param {THREE.NodeMaterial} material  opaque (transparent false)
 * @param {Node} alpha     the card's shape, 0..1 (e.g. a mask texture's channel)
 * @param {object} [o]
 * @param {number} [o.threshold=0.5]  the cut-off
 * @param {boolean} [o.coverage=true] alpha-to-coverage — pass `renderer.samples > 1`
 * @returns {THREE.NodeMaterial} the same material
 */
export function applyAlphaCutout(material, alpha, { threshold = 0.5, coverage = true } = {}) {
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
  material.maskShadowNode = alpha.greaterThanEqual(t);
  return material;
}
