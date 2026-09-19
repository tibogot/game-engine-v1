/**
 * CARD FERN — the geometry fern's rosette, drawn with the palm's half-frond
 * cards and the fern frond texture (fernFrondTexture.js).
 *
 * The existing `fern` kind (foliageGeometry.js) stays as it is; this is a
 * second family beside it. Why it looks better for a tenth of the triangles:
 * a fern frond is flat, lacy and OVERLAPPING — pinnae subdivided into
 * pinnules, sitting on top of each other. Geometry strips cannot overlap
 * without fighting and cannot afford the second level of division, so the
 * geometry fern is a comb up close and a blob at range. A half-card carries
 * the lace in its alpha, the two halves fold like a real frond, and the
 * whole frond sways as one thing. About 9 fronds × 2 halves × 12 triangles.
 *
 * The rosette is the geometry fern's: two short fronds stand up in the
 * middle (the croziers), the rest form an even outer ring leaning out and
 * arching over so their tips droop toward the ground.
 *
 * Shared keys: fronds, frondLength, leafletWidth (frond width), leafletAngle
 * (the fold, degrees — small for a fern), spread (how far the ring leans
 * out), arch, droop (extra hang toward the tip).
 */
import { addFrondCards } from "./palmGeometry.js";

export function buildCardFern(type, ctx) {
  const { near, far, rand, finish } = ctx;
  const fronds = Math.max(3, Math.round((type.fronds ?? 9) * (far ? 0.6 : 1)));
  const len0 = type.frondLength ?? 1;
  const halfW = len0 * 0.2 * (type.leafletWidth ?? 1);
  const vFold = ((type.leafletAngle ?? 12) * Math.PI) / 180;
  const spread = type.spread ?? 0.95;
  const arch = type.arch ?? 1.0;
  const droop = type.droop ?? 0.3;

  const uprightCount = Math.min(2, Math.round(fronds * 0.25));
  for (let f = 0; f < fronds; f++) {
    const upright = f < uprightCount;
    const ring = upright ? uprightCount : fronds - uprightCount;
    const k = upright ? f : f - uprightCount;
    const az = (k / ring) * Math.PI * 2 + (upright ? 0.9 : 0) + (rand() - 0.5) * 0.3;
    const fr = rand();
    addFrondCards(ctx, {
      origin: [0, 0.01, 0],
      az,
      len: len0 * (upright ? 0.62 : 0.88 + fr * 0.18),
      tilt: upright ? 0.22 + fr * 0.18 : spread * (0.6 + fr * 0.45),
      archAmt: arch * (upright ? 0.45 : 0.8 + fr * 0.5),
      halfW: halfW * (upright ? 0.8 : 1),
      vFold, droop, near, far, dead: false,
      // Colour runs along the frond (dark heart → pale tip), like the
      // geometry fern, so `t` follows the row rather than sitting at 1.
      tByRow: true, plantT: 1, rnd: rand,
      // Lit nearly as a canopy: a ground fern is all shade-side halves.
      lift: 0.85,
    });
  }
  return finish();
}
