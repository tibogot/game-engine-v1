/**
 * THE LENS FLARE TUNED FOR THIS SKY'S SUN.
 *
 * The flare's own defaults are the EDITOR's — intensity 3, halation 3, ghosts 2 — which
 * blow the whole frame to white next to a physically-scattered sun. This is the look that
 * was tuned against it: present when the sun swings into frame, never fighting the scene
 * for attention.
 *
 * ENGINE-OWNED since 2026-09-18. It was a constant inside `roadGame.js`, which meant the
 * v3 editor's Atmosphere sky mode — the same sky, the same sun — inherited the blown-out
 * editor defaults instead. Applied OVER the live flare params, so anything not named here
 * keeps whatever the flare shipped with.
 *
 * @see v3/render/sky/atmosphereSkyDome.js — `sunSizeDeg`, which the flare's size follows
 */
export const SKY_LENS_FLARE_LOOK = {
  // On by default — the effect is the point wherever this sky is used. Turn it off
  // from the panel, or per-machine if it is not to taste.
  enabled: true,
  intensity: 1.15,
  halationSize: 0.42,
  halationColor: "#ffd9a8",
  streakLength: 1.0,
  streakOpacity: 0.6,
  streakColor: "#ffc98a",
  ghostOpacity: 0.62,
  ghostSpacing: 1.0,
  dirtOpacity: 0.22,
  /*
   * ── THE STOCK-FLARE BLOCK (lensFlare2 only) ────────────────────────────────────
   *
   * The first version of this file was tuned from optics and it still read as a
   * sibling of the original flare. What a film flare actually is, is the stock
   * optical look, and these are the knobs that carry it:
   *
   *   • `rayCount` — a DENSE FAN of fine rays at random lengths, which is what the
   *     eye reads first. `spikes` blends the physically-derived blade diffraction
   *     back over it; at 0 it is the pure stock fan.
   *   • `arc*` — the huge deep-red striated ring, usually only partly on screen.
   *   • `spectral` — the little iridescent dashes along the chain.
   *
   * Toned DOWN from the reference on purpose: a stock flare is authored over black,
   * and the same values over a bright daylit sky are a white-out. Judge these in
   * road.html, never in a lab.
   */
  starburst: 0.8,
  starburstSize: 0.95,
  rayCount: 110,
  spikes: 0.16,
  haloOpacity: 0.08,
  haloSize: 0.42,
  arcOpacity: 0.45,
  arcSize: 1.15,
  arcColor: "#ff2a10",
  arcT: 0.46,
  spectral: 0.7,
  blades: 8,
  irisAngle: 0.13,
  /* Veiling glare — the low-contrast wash that lifts the blacks. MEASURED: the veil quad
   * and the arc are the flare's only real costs and both are pure FILL, so `veilSize` and
   * `arcSize` are the two dials that actually buy milliseconds back. */
  veil: 0.32,
  veilSize: 1.0,
  chroma: 0.016,
  scintillation: 0.35,
  bloom: 0.85,
  /* Take most of the colour from the sky's live sun rather than the constant above,
   * so the flare goes deep orange at sunset instead of staying noon-warm all day. */
  sourceColorMix: 0.85,
  /** true = run the ORIGINAL v2/effects/lensFlare.js instead. Dev-panel A/B. */
  legacy: false,
};
