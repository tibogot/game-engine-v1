/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *  LENS FLARE 2 — a STOCK OPTICAL flare, analytic, 5 draw calls, bloom-aware.
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * A NEW FILE, deliberately. `lensFlare.js` is shared by the v2 editor and every v3 game, so
 * it is left exactly as it was; a caller opts into this one. Both read the SAME params
 * object, so the panel drives either and `lensFlare.legacy` flips between them live.
 *
 * ── WHAT THIS IS AIMING AT, AND WHY THE FIRST ATTEMPT MISSED ───────────────────────────
 *
 * The first pass at this file reasoned from optics: an N-blade iris throws N diffraction
 * spikes, ghosts are images of the aperture stop, the halo is a coating artefact. All true,
 * and it produced something that still read as a sibling of the original — because the flare
 * people actually mean when they say "movie lens flare" is NOT a physically-derived one. It
 * is the stock-footage / Optical Flares look, and its signature elements are different:
 *
 *   • A DENSE FAN of a hundred fine rays at random lengths, not eight clean spikes. This is
 *     the single biggest tell, and it is the thing the eye reads first.
 *   • A HUGE STRIATED ARC — a ring far bigger than the frame, deep red, built out of fine
 *     radial ticks rather than a smooth band, usually only partly on screen.
 *   • SOLID, OVERLAPPING, WARM polygon ghosts that all take their colour from the source —
 *     not cool hollow rings spaced evenly along a line.
 *   • Small IRIDESCENT DASHES scattered along the axis, each a short streak running through
 *     the spectrum.
 *
 * So the blade count still drives the ghost POLYGON (that part is real, and it is why stock
 * flares use octagons), but the ray fan is authored, not derived. `spikes` blends a
 * blade-locked accent back in for anyone who wants the physical version.
 *
 * ── WHAT IS STILL STRUCTURAL, NOT COSMETIC ─────────────────────────────────────────────
 *
 * 1. IT BLOOMS. The road game runs SELECTIVE bloom: the bloom pass reads only the emissive
 *    MRT attachment. The sky writes the sun disc there; the original flare wrote nothing, so
 *    a glowing sun sat under flat sprites. The compact bright terms (glare core, ray fan,
 *    streak core) go through `bloomMRT`. The wide skirt, veil and arc deliberately do not —
 *    blooming a broad wash is an unthresholded whole-frame bloom through the back door.
 *
 * 2. IT HAS DYNAMIC RANGE. The postfx pipeline runs the whole frame through `renderOutput()`,
 *    so `toneMapped:false` changes nothing there — the flare IS tone mapped. The original
 *    peaked at 1-2 linear, the same neighbourhood as the sky, so the tonemapper flattened it
 *    into one mid-bright wash. This is ~100:1 core-to-skirt, which is what lets the core blow
 *    to white on the shoulder while the skirt keeps its colour.
 *
 * 3. NOTHING IS A BAKED CANVAS TEXTURE (except the dirt). A 256px ramp stretched over a
 *    third of the screen and blended additively is a banding generator, and `pow(1-r,N)`
 *    reaches zero at r=1, which is a ball with a soft edge rather than glare. Analytic shapes
 *    are resolution-independent, cannot band, and chromatic aberration costs a multiply
 *    instead of three texture fetches.
 *
 * ── THE DRAW BUDGET ────────────────────────────────────────────────────────────────────
 *
 * The original was 16 transparent quads, each its own draw with up to three texture fetches
 * per pixel. This is five:
 *
 *   1. `veil`   — fullscreen: veiling glare's long tail + lens dirt.
 *   2. `core`   — a square quad on the sun: glare + ray fan + the tight halo.
 *   3. `streak` — a thin wide strip: the anamorphic smear.
 *   4. `ghosts` — ONE instanced draw for the WHOLE chain, polygons and spectral dashes
 *                 alike, placed in the vertex shader from a handful of uniforms.
 *   5. `arc`    — the big striated ring. A RING geometry, not a quad, so it rasterises only
 *                 the band: a quad would spend three quarters of its fill on the hole.
 *
 * Each is hidden the moment its own intensity goes negligible, and the whole group is hidden
 * when the sun is behind the camera — which, with a chase camera, is most of the time.
 */
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  abs, atan, attribute, cos, exp, float, floor, fract, length, max, min, mix,
  normalize, oneMinus, pow, positionGeometry, smoothstep, sqrt, texture, time,
  uniform, uv, vec2, vec3,
} from "three/tsl";

const TAU = Math.PI * 2;

/**
 * HOW MUCH BIGGER A GHOST QUAD IS THAN THE SHAPE ON IT.
 *
 * A defocused ghost is mostly RIM, and a rim is a gaussian with a tail. Size the quad to
 * where the shape nominally ends (d = 1) and that tail runs off the edge, where it stops
 * dead — and a bright value cut along a straight line is a visible RECTANGLE sitting in the
 * sky. Same class of mistake as a clamped sampler, reached from the other direction, and
 * invisible until you put a soft element against a clean sky. Shapes get a margin and are
 * then windowed to zero inside the quad, so no term can reach a boundary.
 */
const QUAD_MARGIN = 1.5;
/** The core quad's own margin. Smaller, because its terms already die on their own and it
 *  is the one quad big enough for the extra fill to matter. */
const CORE_MARGIN = 1.12;

/* ── Small TSL helpers ─────────────────────────────────────────────────────────────────
 *
 * Plain JS functions that build node graphs, not `Fn`. They inline, which is what we want
 * for a handful of ALU, and it sidesteps the `Fn`-returning-an-object-collapses-to-a-
 * swizzle trap entirely.
 */

/**
 * 1D hash — multiply/fract only, no `sin`.
 *
 * MEASURED: the sin() version cost real milliseconds here. The ray fan calls this FOUR times
 * per pixel across a quad covering most of the screen, and a transcendental is not a free
 * instruction. This is the Hoskins integer-style hash: three multiplies, two fracts, no
 * transcendental, and better distributed than sin() into the bargain — a sin() hash also
 * collapses to a near-constant once its argument reaches the 1e5 range, which is what once
 * made the starfield invisible.
 */
const hash1 = (x) => {
  const a = fract(x.mul(0.1031));
  const b = a.mul(a.add(33.33));
  return fract(b.mul(b.add(b)));
};

/** Band-limited 1D value noise — smooth, so the grain it makes is bands, not fireflies. */
const vnoise = (x) => {
  const i = floor(x);
  const f = fract(x);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(hash1(i), hash1(i.add(1)), u);
};

/** exp(-(x)^2) — a gaussian in whatever units the caller hands over. */
const gauss = (x) => exp(x.mul(x).negate());

/**
 * A cheap full spectrum. Three cosines a third of a cycle apart sweep red → green → blue →
 * red as `t` runs 0..1, which is exactly what an iridescent dash needs and costs three ops.
 */
const spectrum = (t) =>
  vec3(
    cos(t.mul(TAU)).mul(0.5).add(0.5),
    cos(t.sub(0.333).mul(TAU)).mul(0.5).add(0.5),
    cos(t.sub(0.666).mul(TAU)).mul(0.5).add(0.5),
  );

/**
 * ── THE RAY FAN ───────────────────────────────────────────────────────────────────────
 *
 * The element that makes a stock flare look like a stock flare, and the one the physical
 * version cannot produce. Real diffraction from an N-blade iris gives N spikes, evenly
 * spaced and all the same length. What you see in a film flare is a FAN: a hundred-odd fine
 * rays at random angles, each with its own length and brightness, dense near the core and
 * thinning as they reach out.
 *
 * Two layers, because one is a comb and two is a fan: a fine dense layer that fills the
 * angular space, and a coarse layer of longer, brighter rays that gives it structure. Each
 * ray's length, width and brightness come from a hash on its index, so no two are alike and
 * the whole thing is one `floor`/`fract` pair per layer rather than a texture.
 *
 * ── WHY THE RAYS MUST NOT MOVE ─────────────────────────────────────────────────────
 *
 * The first version scrolled a `seed` into the identity hash to make the fan "shimmer".
 * That re-rolls EVERY ray's angle slot, length and width together, nine times a second, so
 * the whole fan teleports to a new configuration instead of twinkling — user-reported, and
 * obviously wrong the moment you watch it rather than reason about it. A lens does not
 * rearrange its own diffraction.
 *
 * So identity (`h` length, `w` width) is hashed from the ray INDEX ALONE and never changes.
 * The only thing time touches is per-ray BRIGHTNESS, smoothly, decorrelated by index —
 * which is what a real starburst does as the air moves in front of the source.
 */
const rayLayer = (r, a, count, sharpBase, lenBias, idOffset, scint) => {
  const x = a.mul(count);
  const id = floor(x).add(idOffset);
  const f = fract(x).sub(0.5).mul(2.0); // −1 … 1 across this ray's slot
  const h = hash1(id.mul(1.7).add(3.1)); // brightness + length — STABLE
  const w = hash1(id.mul(2.3).add(11.7)); // width — STABLE
  /* Angular profile. The rate varies per ray, so some are hairlines and some are wedges — a
   * constant rate is what makes a fan read as a rendered comb.
   *
   * `exp(-k|f|)` rather than `pow(1-|f|, k)`: a general `pow` is exp2+log2, two
   * transcendentals, and this runs twice per pixel over most of the screen. */
  const prof = exp(abs(f).mul(w.mul(30.0).add(sharpBase)).negate());
  /* Radial reach. `h` sets how far this ray gets; it then fades over its own outer two thirds
   * rather than every ray ending together. Normalised so the LONGEST possible ray lands at 1,
   * because the core quad is sized off that and a fan that overran it would be cut off along
   * a circle. */
  const reach = h.mul(lenBias).add(oneMinus(lenBias));
  const fall = oneMinus(smoothstep(reach.mul(0.3), reach, r)).div(r.mul(5.0).add(1.0));
  /* Brightness-only twinkle. Smooth in time, and each ray keeps its own angle, length and
   * width — see above. */
  const flick = mix(float(1.0), vnoise(id.mul(0.7).add(time.mul(1.3))).mul(0.5).add(0.62), scint);
  return prof.mul(fall).mul(h.mul(0.75).add(0.25)).mul(flick);
};

/**
 * LENS DIRT. The only baked texture left in the system.
 *
 * Dirt on the front element is nowhere near the focal plane, so a speck does not render as a
 * speck — it renders as a BOKEH DISC, a soft fill with a brighter rim, sized by the aperture
 * rather than by the dust. Scattering hard one-pixel points is what dust on a SENSOR looks
 * like, and it reads as noise over the image rather than as something the camera is looking
 * through. The other half is not in here at all (see the veil material): the sheet is lit by
 * the SOURCE, so only the smudges near the sun catch light.
 */
function makeDirtTex(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);

  const disc = (x, y, r, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0.0, `rgba(255,255,255,${(a * 0.4).toFixed(3)})`);
    g.addColorStop(0.7, `rgba(255,255,255,${(a * 0.58).toFixed(3)})`);
    g.addColorStop(0.92, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1.0, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  };
  for (let i = 0; i < 44; i++) {
    const r = 5 + Math.pow(Math.random(), 1.6) * 32;
    disc(Math.random() * size, Math.random() * size, r, 0.09 + Math.random() * 0.2);
  }
  for (let i = 0; i < 9; i++) {
    const r = 45 + Math.random() * 110;
    const x = Math.random() * size, y = Math.random() * size;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.022 + Math.random() * 0.04;
    g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  // Lint: wide and soft, never a hairline — a scratch in focus is a sensor artefact.
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const len = 30 + Math.random() * 90;
    const ang = Math.random() * TAU;
    ctx.strokeStyle = `rgba(255,255,255,${(0.028 + Math.random() * 0.055).toFixed(3)})`;
    ctx.lineWidth = 3 + Math.random() * 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + Math.cos(ang + 0.6) * len * 0.5, y + Math.sin(ang + 0.6) * len * 0.5,
      x + Math.cos(ang) * len, y + Math.sin(ang) * len,
    );
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * ── THE GHOST CHAIN ───────────────────────────────────────────────────────────────────
 *
 * Authored against a stock flare rather than derived, which changes three things from the
 * physical version:
 *
 *  • SOLID, AND EACH ONE ITS OWN COLOUR. `hollow` is mostly 0 because filled polygons are
 *    what you actually see; cool hollow rings are the physical answer and not the look.
 *    `mixT` — how much of the coating `tint` survives over the live sun colour — started at
 *    0.2, which made every element very nearly the sun's own colour and turned the chain
 *    into one flat amber smear. It is now 0.45-0.82, so cream / gold / orange / dusky red /
 *    one cool blue all read as distinct, while the sun still pulls the whole set warmer as
 *    it sets.
 *  • CLUSTERED, NOT SPACED. Real chains bunch: a tight knot of two or three overlapping
 *    elements near the sun, one big very faint one they sit on top of, then stragglers. An
 *    evenly spaced chain is the single loudest tell that a flare was generated.
 *  • `kind` 1 IS A SPECTRAL DASH — the little iridescent slivers scattered along the axis.
 *    `ar` is their length (they are long and thin), `phase` where in the spectrum they start.
 *    Four of them, because they read as an accent and stop being one at six.
 *
 * `t` is position along the sun→centre axis; 0.5 is the frame centre and 1 mirrors the source
 * through it. `n` is a small perpendicular nudge, alternating, so the chain weaves instead of
 * being threaded on a wire.
 */
const GHOST_DEFS = [
  // The knot near the source: small, bright, overlapping, sitting on one big faint disc.
  // Each element has its OWN hue. `mixT` is how much of that coating survives over the live
  // sun colour — it was 0.2 in the first pass, which made every ghost very nearly the sun's
  // colour, so the whole chain came out one flat amber. A real chain varies: cream, gold,
  // orange, a dusky red, and usually one cool element for contrast.
  { t: 0.10, size: 0.030, tint: "#fff0cf", mixT: 0.55, w: 0.55, n: 0.004, round: 0.02, hollow: 0.00, soft: 0.05, ar: 1.00, kind: 0, phase: 0 },
  { t: 0.22, size: 0.052, tint: "#ffb63f", mixT: 0.70, w: 0.90, n: -0.010, round: 0.02, hollow: 0.00, soft: 0.06, ar: 1.00, kind: 0, phase: 0 },
  // The big faint red-orange one the knot sits on top of.
  { t: 0.27, size: 0.118, tint: "#ff5a1e", mixT: 0.82, w: 0.42, n: 0.016, round: 0.04, hollow: 0.00, soft: 0.11, ar: 1.02, kind: 0, phase: 0 },
  { t: 0.36, size: 0.060, tint: "#ffcf55", mixT: 0.66, w: 1.00, n: -0.006, round: 0.02, hollow: 0.00, soft: 0.06, ar: 1.00, kind: 0, phase: 0 },
  { t: 0.45, size: 0.044, tint: "#ffe3b4", mixT: 0.45, w: 0.62, n: 0.009, round: 0.02, hollow: 0.00, soft: 0.05, ar: 1.00, kind: 0, phase: 0 },
  { t: 0.55, size: 0.053, tint: "#ff9330", mixT: 0.72, w: 0.72, n: -0.012, round: 0.03, hollow: 0.00, soft: 0.06, ar: 1.00, kind: 0, phase: 0 },
  // Stragglers past the centre: bigger, softer, and the far ones start to hollow out.
  { t: 0.72, size: 0.086, tint: "#ffbe62", mixT: 0.55, w: 0.30, n: 0.020, round: 0.10, hollow: 0.30, soft: 0.09, ar: 1.06, kind: 0, phase: 0 },
  { t: 0.95, size: 0.150, tint: "#c8623a", mixT: 0.60, w: 0.17, n: -0.024, round: 0.35, hollow: 0.55, soft: 0.16, ar: 1.10, kind: 0, phase: 0 },
  // One cool element. Every stock chain has one, and it is what stops the warm ones reading
  // as a single tinted group.
  { t: 1.25, size: 0.058, tint: "#7fb2e8", mixT: 0.62, w: 0.24, n: 0.015, round: 0.02, hollow: 0.00, soft: 0.06, ar: 1.00, kind: 0, phase: 0 },
  { t: 1.52, size: 0.200, tint: "#ff7a38", mixT: 0.70, w: 0.10, n: -0.030, round: 0.55, hollow: 0.62, soft: 0.22, ar: 1.18, kind: 0, phase: 0 },
  // Spectral dashes — the ONLY elements that are meant to run through the spectrum.
  // `ar` is length, `size` thickness.
  { t: 0.40, size: 0.020, tint: "#ffffff", mixT: 0.0, w: 0.90, n: 0.055, round: 0, hollow: 0, soft: 0, ar: 4.5, kind: 1, phase: 0.00 },
  { t: 0.63, size: 0.016, tint: "#ffffff", mixT: 0.0, w: 0.75, n: -0.048, round: 0, hollow: 0, soft: 0, ar: 5.5, kind: 1, phase: 0.35 },
  { t: 1.06, size: 0.024, tint: "#ffffff", mixT: 0.0, w: 0.65, n: 0.070, round: 0, hollow: 0, soft: 0, ar: 4.0, kind: 1, phase: 0.62 },
  { t: 1.42, size: 0.018, tint: "#ffffff", mixT: 0.0, w: 0.52, n: -0.062, round: 0, hollow: 0, soft: 0, ar: 5.0, kind: 1, phase: 0.18 },
];

/** Defaults for every key this system understands. Absent keys fall back here, so a panel
 *  that only knows the original's subset still drives this unchanged. */
const FLARE_DEFAULTS = {
  enabled: true,
  intensity: 1.0,
  /* Source-image terms — these scale with the sun's angular size (see setSourceScale). */
  halationSize: 0.45,
  halationColor: "#ffd9a8",
  /** Overall strength of the ray fan. */
  starburst: 1.0,
  /** How far the fan reaches, in screen half-heights. */
  starburstSize: 1.0,
  /** Rays in the fine layer. The coarse layer is a fixed fraction of it. */
  rayCount: 110,
  /** Blend a blade-locked diffraction accent back over the fan. 0 = pure stock fan. */
  spikes: 0.18,
  streakLength: 1.0,
  streakOpacity: 0.65,
  streakColor: "#ffc98a",
  /* Lens-image terms — properties of the glass, independent of how big the sun is. */
  haloOpacity: 0.10,
  haloSize: 0.42,
  ghostOpacity: 0.7,
  ghostSpacing: 1.0,
  ghostCatsEye: 0.45,
  dirtOpacity: 0.25,
  /** The big striated ring. */
  arcOpacity: 0.55,
  arcSize: 1.15,
  arcColor: "#ff2a10",
  /** Where along the chain axis the arc sits. 0.5 is the exact frame centre. */
  arcT: 0.46,
  /** Strength of the iridescent dashes. */
  spectral: 0.8,
  /** Aperture blade count — the ghost polygon, and the blade accent on the fan. */
  blades: 8,
  /** Iris rotation, radians. Rotates ghosts and the blade accent together. */
  irisAngle: 0.0,
  /** Veiling glare: the long low-contrast wash that lifts the blacks. */
  veil: 0.35,
  /** How far the veil quad reaches, in screen half-heights. This is the flare's biggest
   *  single fill cost — it is area, measured — so it is a knob, not a constant. */
  veilSize: 1.0,
  /** Chromatic aberration on the ghosts, as a fraction of radius. */
  chroma: 0.016,
  /** How much the fan, streak and arc shimmer over time. 0 freezes them. */
  scintillation: 0.7,
  /** Multiplier on what reaches the emissive/bloom buffer. 0 = no bloom contribution. */
  bloom: 1.0,
  /** How far the live sun colour overrides the authored `halationColor`. */
  sourceColorMix: 0.8,
  /** true = hand over to the ORIGINAL v2/effects/lensFlare.js. */
  legacy: false,
};

const pv = (p, k) => {
  const v = p[k];
  return v === undefined || v === null ? FLARE_DEFAULTS[k] : v;
};

/**
 * @param {object} opts
 * @param {THREE.Scene}  opts.scene
 * @param {THREE.Camera} opts.camera
 * @param {() => THREE.Vector3} opts.getSunDir — world-space unit sun direction.
 * @param {() => object} opts.getParams — the live params object (mutated by the panel).
 * @param {(mat: any, emissiveNode: any) => any} [opts.bloomMRT] — `applyBloomMRT`, injected
 *   rather than imported so this file stays in v2 and never reaches up into v3. Omit it and
 *   the flare simply does not contribute to selective bloom.
 */
export function createLensFlare2({ scene, camera, getSunDir, getParams, bloomMRT = null }) {
  const dirtTex = makeDirtTex(512);

  const group = new THREE.Group();
  group.renderOrder = 9999;
  group.frustumCulled = false;
  scene.add(group);

  /* ── Shared uniforms ─────────────────────────────────────────────────────────────── */

  /** The source's colour, LINEAR. Fed live from the sky so the whole flare follows the
   *  atmosphere into sunset; `setSourceColor` is how, and it falls back to the authored
   *  `halationColor` when nobody calls it. */
  const uSunCol = uniform(new THREE.Color(1, 0.72, 0.38));
  const uScint = uniform(1.0);
  const uBlades = uniform(8.0);
  const uIris = uniform(0.0);

  const baseMat = () => ({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    /* A no-op in the postfx path (renderOutput tone maps the whole frame either way), kept
     * so a caller rendering WITHOUT post gets the same un-tonemapped additive behaviour the
     * original had. */
    toneMapped: false,
  });

  /* ══ 1. VEIL — fullscreen: the long glare tail plus lens dirt ════════════════════════
   *
   * The half of a flare nobody draws and everybody feels. Shooting into the sun does not just
   * add sparkles, it WASHES the frame: blacks lift, contrast drops, the image goes milky
   * toward the light. That is veiling glare — the long ~1/r² tail of the same scatter whose
   * core is the halation. It lives on its own fullscreen quad rather than on the core one
   * because a tail that reaches the frame edge needs a fullscreen quad and a core that needs
   * to be sharp wants a tight one; splitting them means neither compromises, and there is no
   * seam because the tail is already at a few thousandths where the core quad ends.
   */
  const uVeilInt = uniform(0.0);
  const uDirtInt = uniform(0.0);
  const uSunUv = uniform(new THREE.Vector2(0.5, 0.5));
  /** Half-extent of this quad in screen units: (veilHalf/halfW, veilHalf/halfH). Turns the
   *  quad's own local coords into frame uv, which is how the dirt stays pinned to the LENS
   *  while the quad rides the sun. */
  const uVeilToScreen = uniform(new THREE.Vector2(1, 1));
  /** Quad-local → the units the tail constants were authored in. See below. */
  const uVeilScale = uniform(0.5);
  const veilMat = new MeshBasicNodeMaterial(baseMat());
  {
    const q = uv().sub(0.5).mul(2.0);
    const qr = length(q);
    /*
     * WHY THIS IS NOT A FULLSCREEN QUAD ANY MORE.
     *
     * MEASURED, and the measurement overturned the obvious answer twice. This pass was the
     * most expensive thing in the flare — more than the hundred-ray fan — and it is not the
     * blend, not the MRT and not the per-pixel maths: a tiny quad with this exact shader is
     * free, a big one is not. It is FILL, and it scales with area at roughly 0.35 ms per
     * screenful.
     *
     * A fullscreen quad was therefore paying for the whole frame to carry a tail that is
     * already below anything you can see past about one screen half-height — the glare
     * function is down to ~0.005 out there, against a sky. So the quad now rides the sun and
     * is sized to where the veil is actually visible (`veilSize`), which is a bit over half
     * the fill for a wash nobody can tell apart.
     *
     * The dirt does not lose anything by moving with it: its glow pool is `exp(-5.5 r²)`,
     * which is dead well inside the same radius. It keeps sampling in FRAME space
     * (uVeilToScreen), so the specks stay pinned to the lens rather than sliding with the sun.
     */
    const d = q.mul(uVeilScale);
    const r2 = d.dot(d);
    /*
     * One evaluation, not three. The first version ran the whole falloff separately for red,
     * green and blue — six divides and three sqrts — and modulated it with an `atan` plus a
     * noise tap, per pixel. All of that was an exact way to compute something the eye reads
     * as "warm in the middle, cool at the edge".
     */
    const qq = r2.mul(3.1).add(1.0);
    const t = float(0.58).div(r2.mul(26.0).add(1.0)).add(float(0.42).div(qq.mul(sqrt(qq))));
    /* 0 at the source, →1 far out. One divide, and it carries the whole colour shift. */
    const spread = r2.mul(4.0).div(r2.mul(4.0).add(1.0));
    /* Lobing without an atan: (nx + i·ny)² gives cos2θ/sin2θ and squaring again gives cos4θ,
     * which is all the low-order asymmetry needed to stop the wash reading as a drawn radial
     * gradient. A handful of multiplies against a transcendental. */
    const n = normalize(d.add(1e-6));
    const c2 = n.x.mul(n.x).sub(n.y.mul(n.y));
    const s2 = n.x.mul(n.y).mul(2.0);
    const c4 = c2.mul(c2).sub(s2.mul(s2));
    const lobes = c2.mul(0.09).add(c4.mul(0.06)).add(0.88);
    const veilRGB = vec3(t, t.mul(mix(float(1.0), float(0.72), spread)), t.mul(mix(float(1.0), float(0.46), spread)))
      .mul(lobes).mul(uVeilInt);

    /* Dirt is lit BY the source: the specks near the sun catch it and the rest of the sheet
     * stays almost clean. A uniformly lit sheet is a screen overlay, not a lens. */
    const dirtUv = uSunUv.add(q.mul(uVeilToScreen).mul(0.5));
    const pool = exp(r2.mul(-5.5)).mul(0.92).add(0.08);
    const dirt = texture(dirtTex, dirtUv).a.mul(uDirtInt).mul(pool);

    /* No hard circle at the quad edge — same discipline as every other element here. */
    const win = oneMinus(smoothstep(0.85, 1.0, qr));
    veilMat.colorNode = veilRGB.add(dirt).mul(uSunCol).mul(win);
    veilMat.opacityNode = float(1.0);
    veilMat.fog = false;
  }
  const veil = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), veilMat);
  veil.renderOrder = 9995;
  veil.frustumCulled = false;
  group.add(veil);

  /* ══ 2. CORE — glare + ray fan + the tight halo, all on the sun ══════════════════════
   *
   * Three elements sharing a centre, so they cost one draw instead of three and can never
   * drift apart. Each gets its own radius uniform in quad units, which is what lets the quad
   * stay tight around whichever element is largest instead of being sized for the worst case.
   */
  const uCoreInt = uniform(0.0);
  const uGlareR = uniform(0.4);
  const uStarR = uniform(0.7);
  const uHaloR = uniform(0.42);
  const uStarInt = uniform(1.0);
  const uHaloInt = uniform(0.1);
  const uRayCount = uniform(110.0);
  const uSpikeMix = uniform(0.18);
  const uBloomMul = uniform(1.0);
  const coreMat = new MeshBasicNodeMaterial(baseMat());
  {
    const p = uv().sub(0.5).mul(2.0);
    const r = length(p);
    /* Nothing reaches the quad edge. Analytic shapes cannot produce a clamped sampler's hard
     * rim, but a tail cut off mid-value still shows as a faint disc, and this is one
     * smoothstep. */
    const win = oneMinus(smoothstep(0.92, 1.0, r));

    /* — Halation. Three lobes over three decades, which is the shape the eye reads as "that
     *   is very bright" rather than "that is a white circle". The hot term is what the
     *   tonemapper's shoulder turns to pure white; the skirt keeps its colour while that
     *   happens, and that contrast IS the effect. */
    const rg = r.div(uGlareR);
    const rg2 = rg.mul(rg);
    const hot = exp(rg2.mul(-90.0)).mul(11.0);
    const inner = exp(rg2.mul(-9.0)).mul(1.9);
    /* Chromatic: the skirt is evaluated wider for red than for blue, so the glare goes warm
     * at its edge on its own rather than being tinted warm by hand. */
    const skirt = (k) => float(1.0).div(rg2.mul(4.2 * k).add(1.0));
    const skirtRGB = vec3(skirt(0.78), skirt(1.0), skirt(1.32)).mul(0.34);

    /* — The ray fan. See rayLayer: the rays are FIXED and only their brightness twinkles. */
    const rs = r.div(uStarR);
    const ang = atan(p.y, p.x);
    const a01 = ang.div(TAU).add(0.5);
    const fine = rayLayer(rs, a01, uRayCount, float(9.0), float(0.84), float(0.0), uScint);
    const coarse = rayLayer(rs, a01, uRayCount.mul(0.26), float(5.0), float(0.55), float(31.0), uScint);
    /* A blade-locked accent over the fan — the physically-derived spikes, mixed back in at
     * `spikes` so the two looks are a slider apart rather than a rewrite apart. */
    const bl = exp(oneMinus(abs(cos(ang.add(uIris).mul(uBlades.mul(0.5))))).mul(-55.0))
      .div(rs.mul(4.0).add(1.0))
      .mul(oneMinus(smoothstep(0.25, 1.0, rs)));
    const fan = fine.add(coarse.mul(1.5)).add(bl.mul(uSpikeMix.mul(3.0))).mul(uStarInt).mul(2.6);
    /* Dispersion along the rays: the tips run cool. Cheap, and it is the difference between
     * light and a drawn line. */
    const fanCol = mix(uSunCol, uSunCol.mul(vec3(0.72, 0.86, 1.30)), smoothstep(0.08, 0.7, rs));

    /* — The tight halo. A coating artefact: one soft ring, FRINGED not dispersed. The
     *   original's halo split into a rainbow because its chromatic spread was as wide as the
     *   ring band itself, so red and blue landed on separate circles. Here the band is an
     *   analytic gaussian and the spread is a third of its width, which is a fringe. The big
     *   striated arc below is the element that carries the ring reading; this one is an
     *   accent and defaults low. */
    const band = (k) => gauss(r.mul(k).sub(uHaloR).div(0.055));
    const halo = vec3(band(1.035), band(1.0), band(0.968)).mul(uHaloInt);

    const rgb = uSunCol.mul(hot.add(inner))
      .add(uSunCol.mul(skirtRGB))
      .add(fanCol.mul(fan))
      .add(halo.mul(uSunCol))
      .mul(win)
      .mul(uCoreInt);

    coreMat.colorNode = rgb;
    coreMat.opacityNode = float(1.0);
    coreMat.fog = false;
    /* WHAT BLOOMS: the compact, genuinely bright terms only — the glare core and the fan. The
     * skirt and halo cover a lot of screen, and blooming them reproduces an unthresholded
     * whole-frame bloom from the back, which is the mistake the sky avoids by keeping its
     * broad low-sun wash out of the emissive buffer. */
    if (bloomMRT) {
      bloomMRT(coreMat, uSunCol.mul(hot.add(inner)).add(fanCol.mul(fan)).mul(win).mul(uCoreInt).mul(uBloomMul));
    }
  }
  const core = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), coreMat);
  core.renderOrder = 9998;
  core.frustumCulled = false;
  group.add(core);

  /* ══ 3. STREAK — the anamorphic smear ═══════════════════════════════════════════════
   *
   * A razor-thin bright core inside a much wider, much softer skirt — two gaussians nearly
   * two orders of magnitude apart in width. A single gaussian is a smear. Banded along its
   * length, because coatings interfere and a streak is never uniform, and the bands drift.
   */
  const uStreakInt = uniform(0.0);
  const uStreakCol = uniform(new THREE.Color(1, 0.79, 0.54));
  const streakMat = new MeshBasicNodeMaterial(baseMat());
  {
    const q = uv().sub(0.5).mul(2.0);
    const y2 = q.y.mul(q.y);
    const hot = exp(y2.mul(-900.0)).mul(3.6);
    const skirt = exp(y2.mul(-45.0)).mul(0.42);
    const ax = abs(q.x);
    const lenF = pow(max(oneMinus(ax), float(0.0)), 1.7);
    const bands = mix(
      float(1.0),
      vnoise(ax.mul(34.0).add(time.mul(0.45))).mul(0.42).add(0.58),
      uScint,
    );
    /* Dispersion along the streak: warm at the source, cold at the tips. */
    const col = mix(uStreakCol, uStreakCol.mul(vec3(0.55, 0.75, 1.45)), smoothstep(0.05, 0.9, ax));
    const a = hot.add(skirt).mul(lenF).mul(bands);
    streakMat.colorNode = col.mul(a).mul(uStreakInt);
    streakMat.opacityNode = float(1.0);
    streakMat.fog = false;
    if (bloomMRT) {
      bloomMRT(streakMat, col.mul(hot.mul(lenF).mul(bands)).mul(uStreakInt).mul(uBloomMul));
    }
  }
  const streak = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), streakMat);
  streak.renderOrder = 9998;
  streak.frustumCulled = false;
  group.add(streak);

  /* ══ 4. GHOSTS — one instanced draw for the whole chain ══════════════════════════════
   *
   * The original spent a draw call per ghost and placed each one on the CPU every frame.
   * Everything a ghost needs that changes is a handful of uniforms; everything that does not
   * is per-instance data uploaded once. So placement belongs in the vertex shader and the
   * chain costs one draw however long it grows — polygons and spectral dashes together.
   */
  const N = GHOST_DEFS.length;
  const gA = new Float32Array(N * 4); // t, size, nudge, weight
  const gB = new Float32Array(N * 4); // tint rgb (linear), tintMix
  const gC = new Float32Array(N * 4); // roundness, hollow, aspect, softness
  const gD = new Float32Array(N * 4); // kind, spectral phase, –, –
  {
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const d = GHOST_DEFS[i];
      gA[i * 4 + 0] = d.t; gA[i * 4 + 1] = d.size; gA[i * 4 + 2] = d.n; gA[i * 4 + 3] = d.w;
      c.set(d.tint).convertSRGBToLinear();
      gB[i * 4 + 0] = c.r; gB[i * 4 + 1] = c.g; gB[i * 4 + 2] = c.b; gB[i * 4 + 3] = d.mixT;
      gC[i * 4 + 0] = d.round; gC[i * 4 + 1] = d.hollow; gC[i * 4 + 2] = d.ar; gC[i * 4 + 3] = d.soft;
      gD[i * 4 + 0] = d.kind; gD[i * 4 + 1] = d.phase;
    }
  }
  const basePlane = new THREE.PlaneGeometry(1, 1);
  const ghostGeo = new THREE.InstancedBufferGeometry();
  ghostGeo.index = basePlane.index;
  ghostGeo.setAttribute("position", basePlane.attributes.position);
  ghostGeo.setAttribute("uv", basePlane.attributes.uv);
  ghostGeo.setAttribute("gA", new THREE.InstancedBufferAttribute(gA, 4));
  ghostGeo.setAttribute("gB", new THREE.InstancedBufferAttribute(gB, 4));
  ghostGeo.setAttribute("gC", new THREE.InstancedBufferAttribute(gC, 4));
  ghostGeo.setAttribute("gD", new THREE.InstancedBufferAttribute(gD, 4));
  ghostGeo.instanceCount = N;
  /* Placed entirely in the vertex shader, so the geometry's own bounds are meaningless.
   * Culling is off; this stops three deriving a bounding sphere from a unit plane. */
  ghostGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const uSunW = uniform(new THREE.Vector2(0, 0));
  const uAxis = uniform(new THREE.Vector2(1, 0));
  const uHalfH = uniform(1.0);
  const uSpacing = uniform(1.0);
  const uCatsEye = uniform(0.45);
  const uGhostInt = uniform(0.0);
  const uChroma = uniform(0.05);
  const uSpectral = uniform(0.8);

  const ghostMat = new MeshBasicNodeMaterial(baseMat());
  {
    const aA = attribute("gA", "vec4");
    const aB = attribute("gB", "vec4");
    const aC = attribute("gC", "vec4");
    const aD = attribute("gD", "vec4");

    /* — Placement. The chain runs sun → centre → mirrored, with a small perpendicular weave.
     *   `uAxis` is normalised on the CPU, where the sun-dead-centre degenerate case can be
     *   handled once instead of guarded per vertex. */
    const t = aA.x.mul(uSpacing);
    const perp = vec2(uAxis.y.negate(), uAxis.x);
    const centre = uSunW.mul(oneMinus(t.mul(2.0))).add(perp.mul(aA.z.mul(uHalfH)));
    /* CAT'S EYE. The aperture is a circle seen straight on, but the barrel in front clips the
     * oblique bundle, so an element far from the frame centre is an ellipse with its long
     * axis pointing back at that centre. Stretch along the chain axis by how far off-centre
     * this element landed, then rotate the quad onto the axis. */
    const gr = length(centre).div(uHalfH);
    const stretch = float(1.0).add(uCatsEye.mul(min(gr, float(1.6))));
    const s = aA.y.mul(uHalfH).mul(2.0 * QUAD_MARGIN);
    const cx = positionGeometry.x.mul(s).mul(aC.z).mul(stretch);
    const cy = positionGeometry.y.mul(s);
    ghostMat.positionNode = vec3(
      centre.x.add(cx.mul(uAxis.x).sub(cy.mul(uAxis.y))),
      centre.y.add(cx.mul(uAxis.y).add(cy.mul(uAxis.x))),
      float(-1.0),
    );

    const p = uv().sub(0.5).mul(2.0);
    const rr = length(p);
    /* Nothing reaches the quad edge — see QUAD_MARGIN. */
    const win = oneMinus(smoothstep(0.86, 1.0, rr));

    /* — kind 0: the aperture polygon. A regular N-gon in closed form: fold the angle into one
     *   blade sector and the boundary becomes r·cos(θ') = apothem. Normalised so d = 1 on the
     *   edge, which means the same code draws any blade count, and mixing `d` toward plain
     *   `length(p)` walks it continuously to a circle as the element defocuses. */
    const seg = float(TAU).div(uBlades);
    const a0 = atan(p.y, p.x).add(uIris);
    const a1 = a0.sub(seg.mul(floor(a0.div(seg).add(0.5))));
    const dPoly = rr.mul(cos(a1)).div(cos(seg.mul(0.5)));
    const d = mix(dPoly, rr, aC.x).mul(QUAD_MARGIN);

    /* Stock ghosts are FILLED, not rings — the fill carries them and the rim is an accent.
     * `hollow` walks to the defocused donut for the far elements only. */
    const soft = aC.w;
    const shape = (k) => {
      const dd = d.mul(k);
      const fill = oneMinus(smoothstep(float(1.0).sub(soft), float(1.0).add(soft), dd)).mul(0.85);
      const rim = gauss(dd.sub(0.9).div(soft.mul(0.45).add(0.055)));
      return mix(fill.add(rim.mul(0.5)), rim.mul(1.3), aC.y);
    };
    /*
     * CHROMATIC ABERRATION — A FRINGE, NOT A PRISM. Measured, because it was neither obvious
     * nor small: at the old `chroma` of 0.055 the displacement between channels was about
     * 40% of the edge's own transition width, so the three channels SEPARATED instead of
     * overlapping. The ghost edge swept red → green → pure blue, and the blue rim came out
     * at 1.22 against an interior of 0.85 — a saturated rainbow ring BRIGHTER than the ghost
     * it belonged to. User-visible, and exactly the mistake the original flare's halo made.
     *
     * THE RULE: the channel displacement must be a small fraction of the feature it fringes.
     * Measured strongly-coloured-rim brightness as a fraction of the ghost's own peak:
     *
     *     chroma      0.055    0.030    0.018    0.012
     *     solid        100%      90%      59%      32%
     *     soft big      96%      55%      20%       6%
     *
     * Hence a default an order of magnitude smaller, and scaled by `soft`: a crisp edge needs
     * a proportionally smaller displacement than a diffuse one to read the same way.
     */
    const ca = uChroma.mul(soft.mul(2.8).add(0.55));
    const polyRGB = vec3(shape(float(1.0).add(ca)), shape(float(1.0)), shape(float(1.0).sub(ca)))
      .mul(mix(uSunCol, aB.xyz, aB.w));

    /* — kind 1: the spectral dash. A thin gaussian sliver whose colour runs through the
     *   spectrum along its length. Small, and there are only four, because they read as an
     *   accent and stop being one the moment there are six. */
    const dashY = gauss(p.y.mul(2.4));
    const dashX = oneMinus(smoothstep(0.15, 1.0, abs(p.x)));
    const dashT = p.x.mul(0.5).add(0.5).add(aD.y);
    const dashRGB = spectrum(dashT).mul(dashY.mul(dashX).mul(uSpectral).mul(1.6));

    ghostMat.colorNode = mix(polyRGB, dashRGB, aD.x).mul(win).mul(aA.w).mul(uGhostInt);
    ghostMat.opacityNode = float(1.0);
    ghostMat.fog = false;
    /* Deliberately NOT bloomed. Ghosts are dim by construction and smearing them turns the
     * chain back into the row of equal beads the weights exist to avoid. */
  }
  const ghosts = new THREE.Mesh(ghostGeo, ghostMat);
  ghosts.renderOrder = 9997;
  ghosts.frustumCulled = false;
  group.add(ghosts);

  /* ══ 5. ARC — the big striated ring ═════════════════════════════════════════════════
   *
   * The element that, more than anything else, says "stock lens flare": a ring far larger
   * than the frame, deep red, built out of hundreds of fine radial ticks rather than a smooth
   * band, and usually only partly on screen. A smooth ring reads as a drawn circle; the
   * striations are what make it read as an optical artefact.
   *
   * It is a RING geometry, not a quad. At this size a quad would spend three quarters of its
   * fill rasterising the hole in the middle — the band is the only part that ever has a
   * non-zero value, so that is the only part worth rasterising. The inner and outer radii are
   * set so the band's gaussian is already dead at both, which is the same edge discipline as
   * QUAD_MARGIN by another route.
   */
  const uArcInt = uniform(0.0);
  const uArcCol = uniform(new THREE.Color(1, 0.1, 0.04));
  const arcMat = new MeshBasicNodeMaterial(baseMat());
  {
    /* RingGeometry's uv maps the OUTER radius onto the unit square, so this is the same `p` /
     * `r` convention as every quad above and r runs 0.66 … 1. */
    const p = uv().sub(0.5).mul(2.0);
    const r = length(p);
    const ang = atan(p.y, p.x);
    /* Chromatic: red sits a touch outside green sits a touch outside blue, so the band fringes
     * rather than dispersing into a prism. */
    const band = (k) => gauss(r.mul(k).sub(0.86).div(0.055));
    /* The striations. HARD-EDGED, from the hash of the tick index — no interpolation, which
     * is both cheaper (one hash instead of the two a smooth noise needs) and more correct:
     * these are ticks, and a smoothed tick is a smudge. Squared so most are dim and a few
     * are bright. A slow scroll keeps them alive. */
    const tk = hash1(floor(ang.mul(190.0).add(time.mul(mix(float(0.0), float(0.6), uScint)))));
    const ticks = tk.mul(tk);
    /* …and a coarse envelope, so the arc fades in and out around its circumference instead of
     * being a complete, even circle — a complete circle is the giveaway. One cosine; a noise
     * tap here was two more hashes for a shape this smooth. */
    const env = cos(ang.mul(3.0).add(1.7)).mul(0.36).add(0.64);
    const shape = vec3(band(1.03), band(1.0).mul(0.42), band(0.965).mul(0.2))
      .mul(ticks.mul(0.85).add(0.15))
      .mul(env);
    arcMat.colorNode = shape.mul(uArcCol).mul(uArcInt);
    arcMat.opacityNode = float(1.0);
    arcMat.fog = false;
    /* Not bloomed: it is broad, and a bloomed ring is a bloomed disc. */
  }
  const arcGeo = new THREE.RingGeometry(0.66, 1.0, 192, 1);
  const arc = new THREE.Mesh(arcGeo, arcMat);
  arc.renderOrder = 9996;
  arc.frustumCulled = false;
  group.add(arc);

  /* ── Live state ──────────────────────────────────────────────────────────────────── */

  /**
   * How big the SOURCE is, relative to the size this flare was authored against.
   *
   * A flare is not one thing. Halation, the ray fan and the streak's thickness are the SOURCE
   * smeared, so they scale with the sun's angular size. Ghosts are images of the APERTURE
   * STOP, and the halo and the arc are coating properties — they are the same size whatever
   * the sun does, and so is the streak's LENGTH. Treating them alike is what makes a flare
   * feel stuck to the screen rather than attached to the light.
   */
  let sourceScale = 1;
  /** 0 = source fully blocked, 1 = clear line of sight. Supplied by whoever owns the
   *  occluders, because only they can answer cheaply. See setOcclusion. */
  let occlusion = 1;
  /** Set by setSourceColor; null means "use the authored halationColor". */
  let sourceColor = null;

  const sunLocal = new THREE.Vector3();
  const camQuatInv = new THREE.Quaternion();
  const _col = new THREE.Color();
  const allQuads = [veil, core, streak, ghosts, arc];
  const stats = { draws: 0 };

  function update() {
    const p = getParams();
    if (!p || !pv(p, "enabled")) {
      group.visible = false;
      stats.draws = 0;
      return;
    }
    group.position.copy(camera.position);
    group.quaternion.copy(camera.quaternion);

    const sunDir = getSunDir();
    camQuatInv.copy(camera.quaternion).invert();
    sunLocal.copy(sunDir).applyQuaternion(camQuatInv);

    /* Behind the camera: nothing to draw and no uniform worth updating. This is the common
     * case with a chase camera, and it is where the whole effect costs zero. */
    if (sunLocal.z >= -0.001) {
      group.visible = false;
      stats.draws = 0;
      return;
    }

    const horizonVis = THREE.MathUtils.smoothstep(sunDir.y, -0.02, 0.18);
    const master = pv(p, "intensity") * horizonVis * occlusion;
    if (master < 0.001) {
      group.visible = false;
      stats.draws = 0;
      return;
    }
    group.visible = true;

    const invZ = 1 / -sunLocal.z;
    const fovRad = (camera.fov * Math.PI) / 180;
    const halfH = Math.tan(fovRad * 0.5);
    const halfW = halfH * camera.aspect;
    const ndcX = (sunLocal.x * invZ) / halfW;
    const ndcY = (sunLocal.y * invZ) / halfH;
    const radius = Math.hypot(ndcX, ndcY);

    /*
     * WHERE EACH FAMILY IS AT ITS STRONGEST — and the one the original had backwards.
     *
     * Halation and the fan are images of the SOURCE, so they are at full strength whenever
     * the source is in frame and fade once it leaves.
     *
     * The GHOST CHAIN is the opposite, and the original treated it the same way. A ghost is
     * the source mirrored through the frame centre: with the sun dead centre the whole chain
     * collapses onto the sun and there is nothing to see, and with the sun near a corner the
     * chain sweeps right across the image. The old falloff made the ghosts brightest exactly
     * where they were invisible and dimmest exactly where they were the show.
     */
    const coreVis = 1 - THREE.MathUtils.smoothstep(radius, 1.15, 2.8);
    const veilVis = 1 - THREE.MathUtils.smoothstep(radius, 1.0, 3.2);
    const chainVis =
      (0.30 + 0.70 * THREE.MathUtils.smoothstep(radius, 0.12, 0.85)) *
      (1 - THREE.MathUtils.smoothstep(radius, 1.3, 3.0));

    /* — Colour. The live sun colour is already LINEAR (the sky builds it that way), so it is
     *   copied straight in; the authored halationColor is sRGB and is converted. Getting this
     *   wrong in either direction is a 5-10x brightness error that stays self-consistent and
     *   therefore hides. */
    const mixSrc = sourceColor ? THREE.MathUtils.clamp(pv(p, "sourceColorMix"), 0, 1) : 0;
    _col.set(pv(p, "halationColor")).convertSRGBToLinear();
    if (mixSrc > 0) _col.lerp(sourceColor, mixSrc);
    uSunCol.value.copy(_col);
    uStreakCol.value.set(pv(p, "streakColor")).convertSRGBToLinear();
    uArcCol.value.set(pv(p, "arcColor")).convertSRGBToLinear();

    const blades = Math.max(3, Math.round(pv(p, "blades")));
    uBlades.value = blades;
    uIris.value = pv(p, "irisAngle");
    uScint.value = THREE.MathUtils.clamp(pv(p, "scintillation"), 0, 1);
    uChroma.value = pv(p, "chroma");
    uBloomMul.value = pv(p, "bloom");
    uRayCount.value = Math.max(6, pv(p, "rayCount"));
    uSpikeMix.value = pv(p, "spikes");
    uSpectral.value = pv(p, "spectral");

    const sunWX = ndcX * halfW;
    const sunWY = ndcY * halfH;
    const Z = -1.0;

    /* — Veil + dirt. Rides the sun and is sized to where the wash can actually be seen; see
     *   the material for why this is no longer a fullscreen quad. */
    const veilInt = master * veilVis * pv(p, "veil");
    const dirtInt = master * veilVis * pv(p, "dirtOpacity") * 0.9;
    const veilHalf = halfH * pv(p, "veilSize");
    veil.position.set(sunWX, sunWY, Z);
    veil.scale.set(veilHalf * 2, veilHalf * 2, 1);
    uVeilInt.value = veilInt;
    uDirtInt.value = dirtInt;
    uSunUv.value.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5);
    /* The tail constants were authored against "1 = one frame height"; quad-local runs
     * -1..1 over veilSize half-heights, so this is the conversion between the two. */
    uVeilScale.value = pv(p, "veilSize") * 0.5;
    uVeilToScreen.value.set(veilHalf / halfW, veilHalf / halfH);

    /* — Core. The quad is sized to whichever of its elements reaches furthest, with a margin
     *   for the window, and each element then gets its radius in quad units. That keeps the
     *   fill tight: sizing for the worst case would cost a screenful for a fan that happens
     *   to be short. */
    const glareR = pv(p, "halationSize") * 1.2 * sourceScale;
    const starR = pv(p, "starburstSize") * sourceScale;
    const haloR = pv(p, "haloSize");
    const extent = Math.max(glareR, starR, haloR * 1.15) * CORE_MARGIN;
    const coreHalf = halfH * extent;
    core.position.set(sunWX, sunWY, Z);
    core.scale.set(coreHalf * 2, coreHalf * 2, 1);
    uGlareR.value = glareR / extent;
    uStarR.value = starR / extent;
    uHaloR.value = haloR / extent;
    uStarInt.value = pv(p, "starburst");
    uHaloInt.value = pv(p, "haloOpacity");
    uCoreInt.value = master * coreVis;

    /* — Streak. Length is the lens; thickness follows the source. */
    streak.position.set(sunWX, sunWY, Z);
    streak.scale.set(pv(p, "streakLength") * halfW * 4.0, halfH * 0.13 * sourceScale, 1);
    uStreakInt.value = master * coreVis * pv(p, "streakOpacity");

    /* — Ghosts. Everything the chain needs, as uniforms. */
    const axLen = Math.hypot(sunWX, sunWY);
    if (axLen > 1e-5) uAxis.value.set(sunWX / axLen, sunWY / axLen);
    // else keep the last axis: with the sun dead centre the chain sits on top of it anyway,
    // and holding the axis avoids a spin as it crosses the exact centre.
    uSunW.value.set(sunWX, sunWY);
    uHalfH.value = halfH;
    uSpacing.value = pv(p, "ghostSpacing");
    uCatsEye.value = pv(p, "ghostCatsEye");
    uGhostInt.value = master * chainVis * pv(p, "ghostOpacity");

    /* — Arc. It rides the chain axis like a ghost (arcT 0.5 is the exact frame centre), so it
     *   drifts as the sun swings rather than being pinned to the middle of the screen. */
    const arcT = pv(p, "arcT");
    const arcHalf = halfH * pv(p, "arcSize");
    arc.position.set(sunWX * (1 - arcT * 2), sunWY * (1 - arcT * 2), Z);
    arc.scale.set(arcHalf, arcHalf, 1);
    uArcInt.value = master * chainVis * pv(p, "arcOpacity");

    /*
     * DO NOT DRAW WHAT CANNOT BE SEEN. Each of these is alpha-blended with depthTest off and
     * one is fullscreen, so a family at zero strength still costs a screenful of blending.
     * With occlusion driving the whole thing to zero behind a cloud that would be paid most
     * of the time the sun is up.
     */
    veil.visible = veilInt + dirtInt > 0.002;
    core.visible = uCoreInt.value > 0.002;
    streak.visible = uStreakInt.value > 0.002;
    ghosts.visible = uGhostInt.value > 0.002;
    arc.visible = uArcInt.value > 0.002;
    stats.draws = 0;
    for (const m of allQuads) if (m.visible) stats.draws++;
  }

  /** How much of the source reaches the lens, 0..1. */
  function setOcclusion(v) {
    occlusion = Math.max(0, Math.min(1, v));
  }

  /** Source diameter relative to the authoring reference (1 = the reference). */
  function setSourceScale(v) {
    sourceScale = Math.max(0.05, Number.isFinite(v) ? v : 1);
  }

  /**
   * The source's LINEAR colour, live. The sky already computes what the sun looks like
   * through the current air mass; feeding it here is what makes the flare go deep orange at
   * sunset instead of staying the one warm constant it was authored with. Pass null to fall
   * back to the authored `halationColor`.
   */
  function setSourceColor(c) {
    if (!c) { sourceColor = null; return; }
    sourceColor = (sourceColor ?? new THREE.Color()).copy(c);
  }

  function dispose() {
    scene.remove(group);
    dirtTex.dispose();
    basePlane.dispose();
    for (const m of allQuads) {
      m.geometry.dispose();
      m.material.dispose();
    }
  }

  return { group, update, dispose, setOcclusion, setSourceScale, setSourceColor, stats, GHOST_DEFS, FLARE_DEFAULTS };
}
