// DESPECKLE — kill FIREFLIES in the scene colour before anything reads it
// (alg-rts, 2026-10-04, you: "the flashing purple / blue / orange lights, I can
// still see them").
//
// MEASURED (alg-rts, the post's view, 10 frames read back): 99.99% of the
// frame's pixels sit under 1.8; ~8 a frame are LONE pixels at 3-500 (once
// 9552) with all eight neighbours at 0.3-0.6. They are shading blow-ups — a
// sliver of a triangle at a grazing angle catching the sun's or the sky's
// specular, a thin leaf turned edge-on by the wind — across the whole scene
// (hiding any one group of meshes moved the count by noise only), so no
// single material is the culprit to fix. Coloured because each is ONE light
// term blown up: the low sun's orange, the sky's blue. The bloom used to
// spread them into blobs (the firefly clamp, 2026-10-02, stopped that); on
// their own they still flicker as saturated dots, and the sharpen after
// tone mapping makes them crisper still.
//
// The rule: a pixel brighter than `ratio` × its brightest neighbour AND than
// `floor` is pulled down to that. A real light is never a lone pixel brighter
// than everything round it by 3x at full resolution — and what glows (the
// selective-bloom mask: flashes, fire, flares, lamps) is left alone. `floor`
// keeps the night's stars (single pixels, but far under it).
//
// Cost: 9 taps of the scene colour where it is read (the composite at full
// resolution, the bloom at its own).
import { Fn, float, max, min, mix, step, textureSize, uv, vec2, vec4 } from "three/tsl";

const OFFS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * @param {object} colorTex  the scene pass's colour texture node
 * @param {object} [maskTex] the glow mask (its .r): pixels that glow are not touched
 * @param {{ ratio?: number, floor?: number }} [o]
 */
export function despeckle(colorTex, maskTex = null, { ratio = 3, floor = 2 } = {}) {
  return Fn(() => {
    const st = uv();
    const texel = vec2(1).div(vec2(textureSize(colorTex)));
    const c = colorTex.sample(st);
    const lum = max(c.r, max(c.g, c.b));
    const nMax = float(0).toVar();
    for (const [dx, dy] of OFFS) {
      const n = colorTex.sample(st.add(vec2(dx, dy).mul(texel)));
      nMax.assign(max(nMax, max(n.r, max(n.g, n.b))));
    }
    const cap = max(nMax.mul(ratio), float(floor));
    let k = min(float(1), cap.div(max(lum, 1e-6)));
    if (maskTex) k = mix(k, float(1), step(0.004, maskTex.sample(st).r));
    return vec4(c.rgb.mul(k), c.a);
  })();
}
