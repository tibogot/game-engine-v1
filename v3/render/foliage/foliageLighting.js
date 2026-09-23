/**
 * WHY LEAVES WERE GOING BLACK — the two knobs that decide it, and the two
 * answers that measured as wrong.
 *
 * The symptom (2026-09-23): whole leaf cards sitting at near-black beside pale
 * ones, flat across the face, a hard edge between them, from any distance.
 *
 * A leaf here is a FLAT card, so ONE normal shades the whole face. Three
 * things could do that, and none of them can be told apart by eye — each
 * predicts a black leaf:
 *
 *   1. the face has turned away from the sun
 *   2. it is inside a cast SHADOW (plants shadow each other densely)
 *   3. it is simply painted very dark (the colour ramp's `colorBase`)
 *
 * MEASURED in the running game, on ONE bush at close range, its green pixels
 * split into the darkest and brightest fifths (nam-valley, midday):
 *
 *                        dark leaves   bright leaves
 *     lit                    49.1          125.2
 *     ambient only           42.7           56.1
 *     sun only               20.7           91.9      ← 4.4x less sun
 *     colour ramp flat       62.8          118.3      ← +28% on the dark ones
 *
 * (2) IS NOT IT, which is worth writing down because a wider sample said it
 * was: casting and receiving switched every way landed within 2% of each other
 * on the plant. The wider sample had been reading ground and grass pixels.
 *
 * (3) is real but secondary — a multiplier on the problem, and the palette's
 * business, not this file's.
 *
 * So it is (1), and the reason is in foliageSystem.js's own note: the leaf's
 * canopy normal-lift RELAXES as the camera climbs, because a full lift makes
 * every leaf take the same light and the field goes flat from overhead. From
 * the RTS camera the base lift and the relax multiplied out to about a QUARTER
 * of a bend — so a card kept its true normal at exactly the camera the black
 * faces were reported from. The relax was deliberate; the black faces are the
 * other end of the same trade.
 *
 * WHAT WAS TRIED AND DROPPED: wrapped diffuse, `(N·L + w)/(1 + w)`, the
 * textbook foliage answer, as a custom lighting model. It works — it lifted
 * the dark fifth from 46.1 to 52.9 at w = 0.6 — but the normal lift is four
 * times stronger on the same bush (46.1 → 72.5) and does not wash the
 * highlights out, so shipping both was paying a custom lighting model (and
 * losing the specular term) for the smaller half of the fix. The numbers are
 * here so nobody re-derives them.
 *
 * The lineup, judged in the game at the RTS camera (dark / bright / contrast):
 *
 *     stock  lift 0.55, relax 0.45      46.1 / 124.7 / 2.70x   the black faces
 *     wrap 0.6 alone                    52.9 / 111.8 / 2.11x
 *     relax 1.0  ← chosen               72.5 / 109.2 / 1.51x
 *     relax 1.0 + lift 0.85             80.8 / 109.4 / 1.35x   too flat
 */
import { uniform } from "three/tsl";

/**
 * How far a leaf's normal bends toward up for a camera down in the field.
 * Not 0.95: the geometry already carries a rounded normal per leaf
 * (foliageGeometry roundLeafNormals), so the shader only softens it.
 */
export const foliageLeafLift = uniform(0.55);

/**
 * How much of that bend survives when the camera looks straight down — the
 * knob that caused the black faces at 0.45 and cures them at 1.
 *
 * 1 means the lift no longer relaxes at all, so the flatness the relax was
 * added to prevent is now a thing to watch for rather than a thing prevented.
 * Judged in the game 2026-09-23 and chosen there: a flatter palm crown is a
 * far smaller price than black leaves scattered over every plant on the map.
 * Kept as a uniform, and the relax kept in the shader, so it can be dialled
 * back without rebuilding the argument.
 */
export const foliageTopdownLift = uniform(1.0);
