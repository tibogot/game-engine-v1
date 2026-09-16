/**
 * Grass colour shared between the blades and the ground that replaces them.
 *
 * Far away a grass field is no longer blades, it is a colour on the terrain
 * (Ghost of Tsushima's "single texture on the terrain" past the last LOD). For
 * that hand-over to have no seam, the terrain must paint exactly what the
 * blades average to, and the blades must converge to that same colour before
 * they end. Both sides build it from these functions, so they cannot drift.
 *
 * Pure node builders (no Fn, no If): safe to call from any material or stage.
 */
import { clamp, dot, float, max, mix, pow, smoothstep, vec3 } from "three/tsl";

const LUM = vec3(0.299, 0.587, 0.114);

/**
 * Terrain tint on a blade colour — the tint step of the blade colour stack.
 * Luminance-matched at low strength (no dark-on-dark crush); past 0.6 the
 * target hands over to the true ground colour so 1.0 is a full takeover.
 * Root-biased so tips keep some blade identity.
 *
 * @param variedCol blade colour before tint
 * @param tintRgb   ground colour under the blade
 * @param hasMode   1 when a tint source is active, else 0
 * @param hPct      height along the blade, 0 root .. 1 tip
 */
export function grassTintBlend(variedCol, tintRgb, hasMode, hPct, strength, rootBias) {
  const rootW = mix(float(1), float(1).sub(hPct), rootBias);
  const tintAmt = clamp(strength.mul(rootW).mul(hasMode), float(0), float(1));
  const lumB = max(dot(variedCol, LUM), float(0.02));
  const lumT = max(dot(tintRgb, LUM), float(0.1));
  const tintMatched = clamp(tintRgb.mul(lumB.div(lumT)), float(0), float(2.5));
  const trueGround = smoothstep(float(0.6), float(1.0), strength);
  const tintMixed = mix(tintMatched, tintRgb, mix(float(0.45), float(1.0), trueGround));
  return mix(variedCol, tintMixed, tintAmt);
}

/** Mean of the per-blade brightness random (mix(0.75, 1, hash)). */
const MEAN_BLADE_SHADE = 0.875;

/**
 * What a field of far-ring blades averages to: the blade colour stack
 * (gradient, tint, AO, brightness random) averaged over the blade's height.
 * Where a far ring covers the ground completely (a grazing view) every part of
 * the blade shows, roots included — sampling only the upper half made the
 * field colour brighter than the blades it replaces, and the last stretch of
 * blades read as a dark ring before it.
 *
 * @param ground ground colour at this point (the tint source)
 * @param p { bladeCol, tipCol, aoBase, aoPower, farAoMul, tintOn, tintStrength, tintRootBias }
 */
export function grassFieldAlbedo(ground, p) {
  const at = (h) => {
    const hh = float(h);
    const base = mix(p.bladeCol, p.tipCol, hh);
    const tinted = grassTintBlend(base, ground, p.tintOn, hh, p.tintStrength, p.tintRootBias);
    const ao = mix(p.aoBase.mul(p.farAoMul), float(1), pow(hh, p.aoPower));
    return tinted.mul(ao);
  };
  // Midpoint rule over [0, 1] in four slices.
  return at(0.125).add(at(0.375)).add(at(0.625)).add(at(0.875)).mul(0.25 * MEAN_BLADE_SHADE);
}
