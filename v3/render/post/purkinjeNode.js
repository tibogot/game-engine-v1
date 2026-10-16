import * as THREE from "three";
import { Fn, dot, mix, smoothstep, uniform, vec3, vec4 } from "three/tsl";

/**
 * THE PURKINJE SHIFT — what your eyes do to a dark scene, and why night looks blue.
 *
 * The retina has two receptor systems. Cones do colour and daylight, peak sensitivity at
 * about 555 nm (yellow-green). Rods do darkness, cannot tell colour apart at all, and peak
 * at about 507 nm — noticeably further toward blue. As light falls the cones drop out and
 * the rods take over, and two things happen together: colour drains away, and the whole
 * scene shifts blue because what is left is measuring the world with a blue-shifted
 * sensitivity. It is why a red flower goes near-black at dusk while the blue-green leaves
 * beside it stay visible, and it is most of why every night photograph you have ever
 * believed was graded blue.
 *
 * A renderer that skips this gets night wrong in a specific way: the picture is merely
 * DARKER, holding full daylight saturation, which reads as "someone turned the exposure
 * down" rather than as darkness.
 *
 * WHERE IT BELONGS IN THE CHAIN. Before tone mapping, on linear HDR values. The effect is
 * a response to ABSOLUTE luminance — the eye is deciding how dark the world is — and after
 * tone mapping that information has already been compressed away.
 *
 * WHY LOCAL, NOT GLOBAL. The weight comes from each pixel's own photopic luminance, so a
 * headlight, a lit sign or the moon keeps its colour while the dark road around it goes
 * blue-grey. That is what the eye actually does: adaptation is broadly global but the
 * cone/rod crossover is per-intensity, and driving it from one scene-wide number instead
 * paints the bright things blue too, which looks like a filter.
 *
 * `amount` is the global gate on top of that, so a caller can fade the whole effect with
 * the clock and switch it off entirely by day.
 */
export function createPurkinjeUniforms() {
  return {
    /** Master gate. 0 is an exact identity; drive it from night-ness. */
    amount: uniform(0.0),
    /**
     * Linear-HDR luminance at which the eye is FULLY dark-adapted, and the one above which
     * it is fully photopic. Between them the two systems mix. The defaults sit around a
     * moonlit scene in this engine's exposure; raise `hiLum` to make the shift reach
     * further up into the midtones.
     */
    loLum: uniform(0.0015),
    hiLum: uniform(0.1),
    /**
     * The colour of rod vision. Not a stylistic blue: it is where the response sits once
     * the 507 nm peak is doing the work. Kept a little desaturated so it reads as vision
     * rather than as a colour wash.
     */
    tint: uniform(new THREE.Vector3(0.62, 0.86, 1.3)),
  };
}

/**
 * Blend the scotopic (rod) response into a linear-HDR colour by how dark it is.
 * Returns a vec4 node; pass it straight into `renderOutput()`.
 */
export function purkinje(inputNode, p) {
  return Fn(() => {
    const src = inputNode.toVar();
    const rgb = src.rgb.toVar();

    // How photopic this pixel is. Standard luminance — this is the CONE system deciding
    // whether it still has enough light to be in charge.
    const photopic = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    // Descending: 1 where the pixel is below loLum, 0 above hiLum.
    const w = smoothstep(p.hiLum, p.loLum, photopic).mul(p.amount);

    /*
     * The rod response is NOT luminance. Weighting toward blue-green is the whole
     * mechanism — use the photopic weights here and you get a desaturation with no shift,
     * which looks like someone pulled a saturation slider rather than like night.
     */
    const scotopic = dot(rgb, vec3(0.12, 0.55, 0.62));

    rgb.assign(mix(rgb, vec3(scotopic).mul(p.tint), w));
    return vec4(rgb, src.a);
  })();
}
