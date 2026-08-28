import * as THREE from "three";
import {
  Fn,
  uniform,
  attribute,
  uv,
  vec3,
  vec4,
  float,
  mix,
  clamp,
  abs,
  fract,
  smoothstep,
  step,
  max,
  min,
  fwidth,
  saturate,
  oneMinus,
  normalView,
  normalWorld,
  positionWorld,
  positionView,
  cameraNear,
  cameraFar,
  perspectiveDepthToViewZ,
  texture,
  length,
  dot,
  sqrt,
  mx_noise_float,
  mx_fractal_noise_float,
  screenUV,
  materialColor,
  materialEmissive,
  shadow,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import {
  WET_DEFAULTS,
  WET_COLORS,
  WET_NUMBERS,
  createWetShading,
  wetClearcoatNormal,
} from "./modularRoadWet.js";

function lin(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

/**
 * The sun's shadow factor as a TSL node, or null.
 *
 * Prefers an explicit `opts.shadowNode`, then the light's existing
 * `shadow.shadowNode` (CSM in the game). If the light has no node yet, one is
 * installed on it so the lighting path reuses it instead of compiling a
 * second sampler that would re-render the map.
 */
function resolveWetShadowNode(opts) {
  if (opts.shadowNode) return opts.shadowNode;
  const light = opts.shadowLight;
  if (!light?.castShadow || !light.shadow) return null;
  if (light.shadow.shadowNode) return light.shadow.shadowNode;
  const node = shadow(light, light.shadow);
  light.shadow.shadowNode = node;
  return node;
}

/**
 * TSL road material for the modular track. Drives appearance from the geometry's
 * `aZone` (0 side, 1 deck, 2 rail) and `aLateral` (-1..1 across the deck), plus
 * uv (x = meters along the path, y = meters across the developed profile).
 *
 * - Deck: asphalt with a dashed centre line and solid edge lines.
 * - Rails: alternating paint bands along the path (hazard look).
 * - Sides/underside: darker concrete.
 *
 * @returns {THREE.MeshStandardNodeMaterial} with `._roadUniforms` for live edits.
 */
export function createRoadMaterial(opts = {}) {
  const u = {
    // ASPHALT ALBEDO. Kept intentionally above real-world asphalt (~0.04–0.12
    // linear) so black tyres stay readable against the deck in-game. These land
    // around ~0.11–0.22 linear — still reads as asphalt, just a mid-grey track
    // rather than a near-black one. Use the panel's dark/light colour pickers
    // to push warmer, cooler, or darker from here.
    asphaltDark: uniform(lin(opts.asphaltDark ?? 0x5c626a)),
    asphaltLight: uniform(lin(opts.asphaltLight ?? 0x8a919a)),
    /** Final multiplier on the deck albedo — the one knob for "too dark / too
     *  bright" without touching the two colours. */
    deckBrightness: uniform(opts.deckBrightness ?? 1.0),
    lineColor: uniform(lin(opts.lineColor ?? 0xf2f2f2)),
    railA: uniform(lin(opts.railA ?? 0xd0342c)),
    railB: uniform(lin(opts.railB ?? 0xf0f0f0)),
    /** 0 = kerbs painted solid railA (the default look); 1 = railA/railB hazard
     *  stripes. Turn pieces will opt into stripes later — keep the machinery. */
    railStriped: uniform(opts.railStriped ?? 0),
    /** Slab edge + underside. Defaults to the KERB colour, so a piece reads as
     *  one painted object from any angle instead of a red-topped grey slab. */
    sideColor: uniform(lin(opts.sideColor ?? 0xd0342c)),
    centerHalf: uniform(opts.centerHalf ?? 0.045), // half-width of centre line (lateral units)
    centerSoft: uniform(opts.centerSoft ?? 0.02),
    centerDash: uniform(opts.centerDash ?? 0.18), // dashes per meter along
    edgePos: uniform(opts.edgePos ?? 0.82), // |lateral| where edge lines sit
    /** Half-width of the SOLID paint, in lateral units (1 = half the deck). */
    edgeWidth: uniform(opts.edgeWidth ?? 0.022),
    /** Feather outside that core. Small — the pixel-size floor takes over at
     *  distance, so this only has to soften the near view. */
    edgeSoft: uniform(opts.edgeSoft ?? 0.004),
    railDash: uniform(opts.railDash ?? 0.5), // paint bands per meter
    /** Contrast of the asphalt tone around its midpoint. NOTE: this used to cap
     *  the dark→light mix (tone × grainScale, so 0.55 meant the deck could never
     *  reach asphaltLight — part of why it read so dark). It is now a symmetric
     *  contrast multiplier, 1.0 = the full authored range. */
    grainScale: uniform(opts.grainScale ?? 1.0),
    /**
     * ANISOTROPY — how many times longer surface features are ALONG the road
     * than across it. This is the single thing that separates "road" from
     * "gravel": asphalt is laid in strips by a paver and then worn, polished and
     * rain-streaked along the direction of travel, so its variation is
     * directional. Sampling `along` and `across` at the same frequency — which
     * is what this material did — is isotropic by construction and reads as
     * marble or shingle no matter how it is tuned.
     *
     * Free to follow corners: uv.x is arc length along the piece's centreline,
     * so the streaks bend with the road without anything else being computed.
     * 1 restores the old isotropic fields.
     */
    streak: uniform(opts.streak ?? 14),
    /** Cycles per metre ACROSS the road of the slow tonal drift (paver strips,
     *  resurfacing patches, bleaching). Along the road it is `streak`× longer. */
    macroScale: uniform(opts.macroScale ?? 0.06),
    /** Cycles per metre of the aggregate speckle. 5 ⇒ ~20 cm chips. */
    aggScale: uniform(opts.aggScale ?? 5.0),
    /**
     * How much of the deck's tone comes from the AGGREGATE rather than from the
     * macro drift. 0.4 was hard-coded as `macro*0.6 + agg*0.4`; this is the same
     * number, made adjustable.
     *
     * It matters more than it looks once the aggregate is something you can
     * actually see. With the built-in surface the two layers are both smooth
     * gradient noise, so the split is a mood knob. With a CELLULAR aggregate
     * (see modularRoadSurfaceV2) it is the balance between "a road with stones
     * in it" and "a grey field with a hint of texture", and 0.4 is well short of
     * what reads correctly close up.
     */
    aggWeight: uniform(opts.aggWeight ?? 0.4),
    /** Base deck roughness before variation. */
    deckRough: uniform(opts.deckRough ?? 0.93),
    /** How much the noise modulates roughness. This is what makes the deck read
     *  as a surface rather than a flat colour — gloss follows visible aggregate. */
    roughVary: uniform(opts.roughVary ?? 0.10),
    /** Roughness REMOVED in the wheel paths. Tyres polish asphalt smooth, and
     *  that gloss strip is the strongest real-world road cue at grazing angles. */
    wheelPolish: uniform(opts.wheelPolish ?? 0.22),
    /** Albedo darkening in the wheel paths (rubber deposit). */
    wheelDarken: uniform(opts.wheelDarken ?? 0.10),
    // ── HISTORICAL DRIFT MARKS ────────────────────────────────────────────
    // Rubber laid down BEFORE the race — track history, not the player's own
    // marks. Those stay a ribbon (modularRoadTireMarks.js): a live mark is an
    // EVENT on an arbitrary path and has to be geometry. This is surface
    // CONDITION, so it belongs in the road itself — no draw calls, no
    // z-fighting, and it conforms to banks, loops and the inside of tubes,
    // which a decal quad cannot. Driven by `aCurve`, so it concentrates in
    // corners on its own instead of being placed by hand.
    driftAmount: uniform(opts.driftAmount ?? 1.4), // 0 = a freshly laid track
    driftWidth: uniform(opts.driftWidth ?? 0.42), // half-width of the band (lateral)
    driftBias: uniform(opts.driftBias ?? 0.35), // how far toward the corner's OUTSIDE
    /** Curvature (1/m) at which marks reach full strength. 0.05 ≈ a 20 m radius. */
    driftCurveRef: uniform(opts.driftCurveRef ?? 0.05),
    /** Roughness removed where rubber sits — it is glossier than asphalt, and
     *  that gloss is what makes it read as rubber rather than as a dark stain. */
    driftGloss: uniform(opts.driftGloss ?? 0.25),
    /** Streaks per lateral unit — 20 puts them roughly a tyre-width apart on a
     *  16 m deck. */
    driftLines: uniform(opts.driftLines ?? 20),
    /** How far the macro field pushes those streaks sideways as they run, so
     *  they wander like driven lines instead of looking machined. */
    driftWander: uniform(opts.driftWander ?? 2.5),
    // Centre + edge paint lines. Default OFF — the clean Apex-Rush deck look;
    // the dev panel's "Road lines" toggle flips the uniform live.
    linesOn: uniform(opts.linesOn ?? 0), // master: 1 = paint lines, 0 = plain deck
    // Which lines the master switch draws. Both default ON, so `linesOn` alone
    // behaves exactly as it always has; drop one to get edges-only (a race
    // circuit) or centre-only (a two-way road) without a second material.
    centerOn: uniform(opts.centerOn ?? 1),
    edgeOn: uniform(opts.edgeOn ?? 1),
    // Optional neon paint: write the same line mask into emissive + bloom MRT.
    // Off by default (day look); night tracks flip `linesBloom` without a rebuild.
    linesBloom: uniform(opts.linesBloom ?? 0),
    linesBloomIntensity: uniform(opts.linesBloomIntensity ?? 3.0),
    // Rideable tubes (aZone 3 = inner wall, 4 = outer shell) — their own look,
    // clearly not asphalt, plus emissive neon rings inside that bloom.
    tubeInner: uniform(lin(opts.tubeInner ?? 0x24303c)), // dark blue-steel interior
    tubeOuter: uniform(lin(opts.tubeOuter ?? 0xd9662a)), // hot-wheels orange shell
    // Was cyan glow rings (0x35e0ff) + bloom. Parked: we may go back to a black
    // stripe that reuses this blue as the emissive. White paint for now.
    // neonColor: uniform(lin(opts.neonColor ?? 0x35e0ff)),
    neonColor: uniform(lin(opts.neonColor ?? 0xffffff)),
    neonIntensity: uniform(opts.neonIntensity ?? 3.0), // >1 so bloom picks it up
    neonSpacing: uniform(opts.neonSpacing ?? 8.0), // meters between rings
    neonWidth: uniform(opts.neonWidth ?? 0.35), // ring width (m)
    // Lacquered panel (aZone 5) — the glass road's deck. A ZONE rather than its
    // own material, which is the whole reason it is cheap: the piece stays one
    // mesh on the shared road material, so it still instances with every other
    // road piece instead of adding a draw call per placement.
    panelColor: uniform(lin(opts.panelColor ?? 0xf4f4f2)), // lacquered white
    panelRough: uniform(opts.panelRough ?? 0.09), // wet-looking, not mirror
    // ── WET ROAD ─────────────────────────────────────────────────────────
    // Declared unconditionally, even when `opts.wet` is off, so that a look
    // file always round-trips the full set and a dry material can be swapped
    // for a wet one without the authored weather being lost. What each of
    // these MEANS is documented on WET_DEFAULTS in modularRoadWet.js; the
    // model itself lives there too. `wetAmount` defaults to 0, so a wet
    // material with no weather applied is identical to a dry one.
    wetAmount: uniform(opts.wetAmount ?? WET_DEFAULTS.wetAmount),
    wetCoatStrength: uniform(opts.wetCoatStrength ?? WET_DEFAULTS.wetCoatStrength),
    wetShadow: uniform(opts.wetShadow ?? WET_DEFAULTS.wetShadow),
    wetDarken: uniform(opts.wetDarken ?? WET_DEFAULTS.wetDarken),
    wetRough: uniform(opts.wetRough ?? WET_DEFAULTS.wetRough),
    wetCoatRough: uniform(opts.wetCoatRough ?? WET_DEFAULTS.wetCoatRough),
    wetTint: uniform(lin(opts.wetTint ?? WET_DEFAULTS.wetTint)),
    puddleAmount: uniform(opts.puddleAmount ?? WET_DEFAULTS.puddleAmount),
    puddleScale: uniform(opts.puddleScale ?? WET_DEFAULTS.puddleScale),
    puddleStreak: uniform(opts.puddleStreak ?? WET_DEFAULTS.puddleStreak),
    puddleThreshold: uniform(opts.puddleThreshold ?? WET_DEFAULTS.puddleThreshold),
    puddleSoft: uniform(opts.puddleSoft ?? WET_DEFAULTS.puddleSoft),
    puddleDarken: uniform(opts.puddleDarken ?? WET_DEFAULTS.puddleDarken),
    puddleCoatRough: uniform(opts.puddleCoatRough ?? WET_DEFAULTS.puddleCoatRough),
    wetDrainStart: uniform(opts.wetDrainStart ?? WET_DEFAULTS.wetDrainStart),
    wetCamber: uniform(opts.wetCamber ?? WET_DEFAULTS.wetCamber),
    wetBank: uniform(opts.wetBank ?? WET_DEFAULTS.wetBank),
    wetCurveRef: uniform(opts.wetCurveRef ?? WET_DEFAULTS.wetCurveRef),
    wetDrainStrength: uniform(opts.wetDrainStrength ?? WET_DEFAULTS.wetDrainStrength),
    wetSlopeMin: uniform(opts.wetSlopeMin ?? WET_DEFAULTS.wetSlopeMin),
    wetSlopeMax: uniform(opts.wetSlopeMax ?? WET_DEFAULTS.wetSlopeMax),
    wetWheelClear: uniform(opts.wetWheelClear ?? WET_DEFAULTS.wetWheelClear),
    rippleAmp: uniform(opts.rippleAmp ?? WET_DEFAULTS.rippleAmp),
    rippleScale: uniform(opts.rippleScale ?? WET_DEFAULTS.rippleScale),
    rippleSpeed: uniform(opts.rippleSpeed ?? WET_DEFAULTS.rippleSpeed),
    rippleStretch: uniform(opts.rippleStretch ?? WET_DEFAULTS.rippleStretch),
    rippleDamp: uniform(opts.rippleDamp ?? WET_DEFAULTS.rippleDamp),
    reflectStrength: uniform(opts.reflectStrength ?? WET_DEFAULTS.reflectStrength),
    reflectFresnel: uniform(opts.reflectFresnel ?? WET_DEFAULTS.reflectFresnel),
    reflectDistort: uniform(opts.reflectDistort ?? WET_DEFAULTS.reflectDistort),
    reflectFade: uniform(opts.reflectFade ?? WET_DEFAULTS.reflectFade),
    reflectPlaneTol: uniform(opts.reflectPlaneTol ?? WET_DEFAULTS.reflectPlaneTol),
    reflectErrTol: uniform(opts.reflectErrTol ?? WET_DEFAULTS.reflectErrTol),
    railReflect: uniform(opts.railReflect ?? WET_DEFAULTS.railReflect),
    railDepthTol: uniform(opts.railDepthTol ?? WET_DEFAULTS.railDepthTol),
    railDepthSoft: uniform(opts.railDepthSoft ?? WET_DEFAULTS.railDepthSoft),
    kerbWet: uniform(opts.kerbWet ?? WET_DEFAULTS.kerbWet),
  };

  /**
   * WET is a build-time choice, not a uniform, and that is on purpose.
   *
   * A water film is a clearcoat — a second specular lobe with its own normal —
   * and three decides whether to compile that lobe at all from whether
   * `clearcoatNode` is set. Driving clearcoat from a uniform that happens to be
   * 0 would keep the lobe, the extra Fresnel and the extra env sample in every
   * dry frame for nothing. Choosing the material class instead means a dry
   * track pays literally zero: same MeshStandardNodeMaterial, same graph as
   * before this existed.
   *
   * The cost of that: turning the weather on is a material rebuild, not a
   * uniform poke. For a road with ONE shared material that is a single
   * `createRoadMaterial` call and a reassign, which is the right trade — rain
   * starting is a rare event and a dry frame is the common one.
   */
  const wetOn = Boolean(opts.wet);

  /**
   * DO THE RIDEABLE-TUBE ZONES (3 = inner bore, 4 = outer shell) NEED SHADING?
   *
   * DEFAULT FALSE, because on the shipping track they are unreachable. Every
   * tube piece carries `def.tubeShader`, and modularRoadBuilder._deckMaterial
   * hands those to createTubeMaterial instead of this material — all 23 of
   * them. Verified exhaustively by building every piece in the kit and reading
   * its aZone attribute: tools/roadZoneUsageAudit.mjs.
   *
   * What that dead branch was costing, on EVERY road fragment of every straight:
   * `tubeRingMask` evaluated TWICE (once in colorNode for the lit ring strip,
   * once in neonNode for the emissive) because the two call sites build separate
   * node graphs, plus two zone mixes in colorNode, two in roughnessNode, and the
   * whole neon emissive path feeding the bloom MRT.
   *
   * `zone 5` (the glass road's lacquered panel) is NOT gated — that one is live,
   * on `glass_road`.
   *
   * The uniforms stay declared unconditionally either way, so a look file still
   * round-trips tubeInner/tubeOuter/neon* and a tube lab can set them.
   *
   * road-piece-lab.html passes `tubeZones: true`: it previews any piece in the
   * kit on this material, tubes included, with no builder to route them.
   */
  const tubeZones = Boolean(opts.tubeZones);

  const mat = wetOn
    ? new THREE.MeshPhysicalNodeMaterial({
        roughness: opts.roughness ?? 0.92,
        metalness: opts.metalness ?? 0.0,
        // Closed prism (deck + sides + underside). FrontSide is enough from
        // any exterior view and cheaper; DoubleSide is the lab/legacy default
        // and what you want only if a caller still needs inner faces (open
        // piece ends). road.html passes FrontSide and has a panel toggle.
        side: opts.side ?? THREE.DoubleSide,
      })
    : new THREE.MeshStandardNodeMaterial({
        roughness: opts.roughness ?? 0.92,
        metalness: opts.metalness ?? 0.0,
        side: opts.side ?? THREE.DoubleSide,
      });

  // ── SHARED ASPHALT SURFACE ────────────────────────────────────────────────
  // Built ONCE here and referenced by both colorNode and roughnessNode below.
  // Because it's the same node instance in both, the graph emits the noise a
  // single time per fragment — computing it inside each Fn separately would
  // double the cost for identical results. Packed into a vec4 so one node
  // carries all four fields.
  //
  // Still zero textures: no sampler slots (v3 is already near the Windows WebGPU
  // 16-sampler cap), no VRAM, no streaming, and it tiles infinitely along a
  // track of any length.
  //
  // ── THE SURFACE IS REPLACEABLE ────────────────────────────────────────────
  // `opts.buildSurface(u)` swaps this field for another one, and the CONTRACT
  // is the vec4 packing below: x = macro tone 0..1, y = aggregate tone 0..1,
  // z = wheel-path mask 0..1, w = the aggregate's own distance fade.
  //
  // It exists so a candidate surface can be A/B'd against this one without
  // forking the six hundred lines underneath — the zone chain, the paint lines,
  // the old rubber, the drainage model and the wet coat all consume that vec4
  // and none of them should have to be copied to try a different asphalt. Every
  // consumer's assumptions live in that contract, so honour it:
  //
  //   .x MUST stay LOW-FREQUENCY. driftField takes its streak wander and its
  //      patchiness from it, and a chip-scale .x makes skid marks jitter per
  //      stone instead of wandering down the road.
  //   .z is the wheel path and is what the wet film's squeegee term is built
  //      from — it is geometry (|aLateral|), not noise, so keep it as-is.
  //   .w must reach 0 wherever .y is undersampled, or the aggregate aliases
  //      into crawling static at distance.
  const surface = opts.buildSurface ? opts.buildSurface(u) : Fn(() => {
    // Stretched along the path, so every field below comes out as streaks that
    // run WITH the road rather than blobs sitting on it.
    // `aAlongOffset` is a per-piece constant that decorrelates the noise from
    // its neighbours — without it every piece of the same length is painted
    // with the identical patch of asphalt. See stampAlongOffset in the kit.
    // It rides HERE and not on uv.x itself, so the paint-line dashes, the kerb
    // bands and the tube rings keep their existing phase relative to each
    // piece's start. Being constant per piece it also drops out of fwidth, so
    // the aggregate's distance fade is unaffected.
    const along = uv().x.add(attribute("aAlongOffset", "float"))
      .div(u.streak); // metres along the path, anisotropic
    const across = uv().y; // metres across the developed profile
    const lateral = attribute("aLateral", "float");

    // MACRO — slow tonal drift: resurfacing patches, sun bleaching, old repairs.
    // Low frequency, so it can never alias and needs no LOD handling.
    const macro = mx_fractal_noise_float(
      vec3(along.mul(u.macroScale), across.mul(u.macroScale), 0.0), 3, 2.0, 0.5, 1.0,
    ).mul(0.5).add(0.5);

    // AGGREGATE — the chip speckle that actually reads as asphalt up close.
    //
    // This is the part the old sin-hash got wrong: a per-pixel hash has no scale
    // at all, so at distance it undersampled into crawling static. Here the
    // speckle is a real spatial frequency, and it's faded out once it drops
    // below the sampling rate. fwidth() gives UV-units-per-pixel directly, which
    // is resolution- AND angle-independent; the max of both axes is what
    // matters because looking down a road is precisely the case where one axis
    // undersamples badly while the other is still fine.
    const texel = max(fwidth(along), fwidth(across));
    const aggFade = saturate(oneMinus(texel.mul(u.aggScale).mul(2.0)));
    const agg = mx_noise_float(
      vec3(along.mul(u.aggScale), across.mul(u.aggScale), 0.0),
    ).mul(0.5).mul(aggFade).add(0.5); // fades toward flat 0.5, not toward black

    // WHEEL PATHS — the two bands where tyres actually run.
    const wheelPath = smoothstep(0.18, 0.42, abs(lateral))
      .mul(oneMinus(smoothstep(0.55, 0.8, abs(lateral))));

    return vec4(macro, agg, wheelPath, aggFade);
  })();

  /**
   * Where old rubber sits, 0..1. Built ONCE like `surface` above and referenced
   * by both colorNode and roughnessNode, so the graph emits it a single time.
   *
   * Costs NO new noise: the breakup reuses the macro and aggregate fields that
   * the deck already computes, and those are anisotropically stretched along
   * the road (see `streak`), which is exactly the shape a skid wants anyway.
   * The whole effect is a handful of ALU on top of what was already there.
   */
  const driftField = Fn(() => {
    const lateral = attribute("aLateral", "float");
    // aCurve is signed: + is a right-hand corner. One clamp gives both how hard
    // the corner is and which way it goes.
    const k = clamp(attribute("aCurve", "float").div(u.driftCurveRef), -1.0, 1.0);
    const corner = abs(k);
    // Cars drift wide, so the band sits toward the corner's OUTSIDE — the
    // opposite side to the way it turns.
    const centre = k.negate().mul(u.driftBias);
    const band = smoothstep(
      u.driftWidth, u.driftWidth.mul(0.35), abs(lateral.sub(centre)),
    );
    // INDIVIDUAL STREAKS, from a ripple across the road rather than from noise.
    //
    // Reusing the deck's own fields for this does not work and it is worth
    // saying why: `macro` runs at ~16 m across a 16 m road, so it is one broad
    // gradient — thresholding it gives a vague dark half, not marks. `agg` is
    // the right size (~0.2 m, about a tyre) but it is deliberately faded out
    // with distance by aggFade to stop it aliasing, so marks built on it would
    // evaporate down the straight. A third noise at the right frequency would
    // cost a full extra evaluation per fragment across most of the screen.
    //
    // A triangle wave in `lateral` costs a handful of ALU instead, and it is
    // closer to the truth anyway: skid marks ARE roughly parallel lines a tyre
    // apart. `macro` then displaces them sideways so they wander down the road
    // instead of looking machined, and modulates them along it so they break
    // into segments rather than running unbroken for the whole piece.
    const wander = surface.x.sub(0.5).mul(u.driftWander);
    const ripple = abs(fract(lateral.mul(u.driftLines).add(wander)).sub(0.5)).mul(2.0);
    const streaks = smoothstep(0.8, 0.25, ripple);
    const patchy = smoothstep(0.34, 0.62, surface.x);
    // Saturated so `driftAmount` can be pushed past 1 for a filthy track
    // without breaking the darkening bound colorNode relies on.
    return saturate(band.mul(corner).mul(streaks).mul(patchy).mul(u.driftAmount));
  })();

  /**
   * Surface WATER, or null when this material was not built wet.
   *
   * Built here, once, from `surface.z` — the wheel-path mask the deck already
   * computes — and then referenced by colorNode, roughnessNode and the three
   * clearcoat nodes below. Same discipline as `surface` and `driftField`: one
   * node instance shared five ways emits one evaluation per fragment.
   */
  const wet = wetOn ? createWetShading(u, surface.z) : null;

  /**
   * HOW FAR THE WATER SURFACE PUSHES A REFLECTION AROUND, in UV. One node,
   * shared by the car's planar mirror and the guardrail's mirrored geometry.
   *
   * UNPACKING MATTERS AND WAS WRONG IN ONE OF THE TWO. `coatNormalPacked` is a
   * normal stored for `normalMap` — `n * 0.5 + 0.5`, so it lives in 0..1 with
   * z ≈ 1 on a near-flat surface. The car's reflection unpacked it correctly;
   * the rail's read `.xz` raw, which is not a zero-mean wobble at all but a
   * near-CONSTANT offset of about (0.5, 1.0) × reflectDistort × coatNormalGain.
   * At the default 0.05 that is up to (0.025, 0.05) of UV — roughly 54 px of
   * vertical shift at 1080p, always the same direction, and growing with how
   * wet the road is. A reflection that sits a fixed distance from the object
   * casting it reads exactly like a mirror that is aimed wrong, which is what
   * made the mirrored-rail approach look broken on slopes.
   *
   * Shared rather than duplicated for the second half of the same bug: the rail
   * called `wetRippleNormal(u)` again instead of reusing this field, and a
   * second call builds a second graph — six trig functions evaluated twice per
   * wet fragment for an identical result.
   */
  const coatWobble = wet
    ? wet.coatNormalPacked.xy.sub(0.5).mul(2.0)
        .mul(u.reflectDistort).mul(wet.coatNormalGain)
    : null;

  /**
   * Paint-line coverage (0..1). Shared by albedo and the optional bloom write —
   * one node instance, one evaluation per fragment when both paths reference it.
   */
  const lineAmt = Fn(() => {
    const lateral = attribute("aLateral", "float");
    const plain = attribute("aPlain", "float"); // 1 on platforms → no lines
    const along = uv().x;
    // Feather floor of about a pixel. Painted lines are hard-edged in reality,
    // but a hard edge in a shader aliases into a dashed crawl at distance — the
    // exact range you spend most of a lap looking at. fwidth(lateral) is
    // lateral-units-per-pixel, so this keeps both lines crisp AND stable at any
    // distance without the author having to pick a blur that works everywhere.
    const lateralAA = fwidth(lateral).mul(0.75);

    // Dashed centre line — solid core out to centerHalf, then feathered.
    const centerMask = smoothstep(
      u.centerHalf.add(max(u.centerSoft, lateralAA)),
      u.centerHalf,
      abs(lateral),
    );
    const dash = step(0.5, fract(along.mul(u.centerDash)));
    const centerLine = centerMask.mul(dash);

    // Solid edge lines on both sides.
    //
    // WAS smoothstep(edgeWidth, 0, d): a pure gradient from full at the centre
    // of the line to nothing at edgeWidth, i.e. NO solid core — the whole line
    // was falloff. That is why it read soft and why widening it only made it
    // blurrier. Same shape as the centre line now: solid to edgeWidth, then a
    // short feather. `edgeWidth` therefore changed meaning from "how far the
    // gradient reaches" to "half-width of the paint", so its default came down
    // to keep the line about the width it looked before.
    const edgeMask = smoothstep(
      u.edgeWidth.add(max(u.edgeSoft, lateralAA)),
      u.edgeWidth,
      abs(abs(lateral).sub(u.edgePos)),
    );

    // Per-line switches, then the global toggle × per-piece plain flag
    // (platforms suppress lines).
    return clamp(
      centerLine.mul(u.centerOn).add(edgeMask.mul(u.edgeOn)), 0.0, 1.0,
    ).mul(u.linesOn).mul(float(1).sub(plain));
  })();

  mat.colorNode = Fn(() => {
    const zone = attribute("aZone", "float");
    const along = uv().x;

    const macro = surface.x;
    const agg = surface.y;
    const wheelPath = surface.z;

    // Weighted toward the macro layer: large-scale variation is what the eye
    // reads as "a road surface", the speckle is the close-up detail on top.
    const tone = macro.mul(oneMinus(u.aggWeight)).add(agg.mul(u.aggWeight));
    // Symmetric contrast about the midpoint, so grainScale can push or pull
    // variation without dragging the average brightness down with it.
    const shaped = saturate(tone.sub(0.5).mul(u.grainScale).add(0.5));
    let deckBase = mix(u.asphaltDark, u.asphaltLight, shaped);
    deckBase = deckBase.mul(oneMinus(wheelPath.mul(u.wheelDarken)));
    // Old rubber. BOUNDED at 0.55 on purpose: the player's live skid ribbon
    // draws on top of this, and two independent darkenings multiply — an
    // unbounded one would turn every re-drift over an old mark into a black
    // hole. Capped, the worst case is dark rubber on dark rubber.
    deckBase = deckBase.mul(oneMinus(driftField.mul(0.55)));
    deckBase = deckBase.mul(u.deckBrightness);

    // WATER, and it goes here — after every dry term, before the paint. Water
    // darkens the road it is lying on, not the lines painted on top of it, and
    // it darkens the old rubber and the wheel-path deposit along with the
    // asphalt because it is sitting over all of them.
    if (wet) deckBase = deckBase.mul(wet.albedoScale).mul(wet.tint);

    const deckCol = mix(deckBase, u.lineColor, lineAmt);

    // Kerbs: solid red by default; hazard stripes only when railStriped is on
    // (reserved for the turn pieces later).
    const railBand = step(0.5, fract(along.mul(u.railDash)));
    let railCol = mix(u.railA, u.railB, railBand.mul(u.railStriped));
    // The kerb gets wet too, at `kerbWet` of the deck's dose — paint is close to
    // non-porous, so it darkens less than open aggregate. Leaving it out (the
    // first version did) removed the WETTEST strip of the road, because the
    // drainage model pools against the kerb by construction: |aLateral| near 1
    // is the bottom of the camber.
    if (wet) {
      const kw = wet.film.mul(u.kerbWet);
      railCol = railCol
        .mul(mix(float(1), u.wetDarken, kw))
        .mul(mix(vec3(1, 1, 1), u.wetTint, kw));
    }

    // Select by zone: 0 side, 1 deck, 2 rail, 3 tube inner, 4 tube outer,
    // 5 lacquered panel. The panel deliberately REPLACES the asphalt rather than
    // tinting it — no aggregate, no wheel paths, no old rubber, because none of
    // that belongs on a painted panel. It is the one zone that wants to look
    // manufactured.
    let col = mix(u.sideColor, deckCol, step(0.5, zone));
    col = mix(col, railCol, step(1.5, zone));
    if (tubeZones) {
      // Tube interior: base colour plus a lit strip where the neon rings sit,
      // so the glow reads as a fixture rather than as bloom haze.
      const tubeInnerCol = mix(u.tubeInner, u.neonColor, tubeRingMask(u, along));
      col = mix(col, tubeInnerCol, step(2.5, zone));
      col = mix(col, u.tubeOuter, step(3.5, zone));
    }
    col = mix(col, u.panelColor, step(4.5, zone));
    return col;
  })();

  // Per-zone roughness sells the material split far more than color alone:
  // matte asphalt, glossy painted kerbs, satin tube shell, dull concrete sides.
  mat.roughnessNode = Fn(() => {
    const zone = attribute("aZone", "float");

    // Same `surface` node as colorNode — referenced, not recomputed.
    const macro = surface.x;
    const agg = surface.y;
    const wheelPath = surface.z;

    // Deck asphalt: vary gloss with the SAME noise that varies colour, so the
    // highlights line up with the visible aggregate instead of floating over a
    // uniform sheen. Then polish the wheel paths — that pair of smoother strips
    // catching the sun is what sells a road at grazing angles, and it costs
    // nothing here because the fields are already computed.
    let deck = u.deckRough
      .add(macro.sub(0.5).mul(u.roughVary))
      .add(agg.sub(0.5).mul(u.roughVary).mul(0.5))
      .sub(wheelPath.mul(u.wheelPolish))
      // Same field as the albedo above, referenced not recomputed. Rubber is
      // glossier than the asphalt around it, and that sheen is most of what
      // sells it as rubber rather than as a dark patch of paint.
      .sub(driftField.mul(u.driftGloss));
    // Water fills the pores, so the SUBSTRATE smooths out some — but only some.
    // The mirror is the coat, not this; see wetRough in modularRoadWet.js.
    if (wet) deck = mix(deck, wet.substrateRough, wet.film);
    deck = clamp(deck, 0.05, 1.0);

    let r = float(0.9); // sides / underside
    r = mix(r, deck, step(0.5, zone)); // deck asphalt
    // Kerb paint, wetted by the same film at `kerbWet` strength.
    const kerbR = wet
      ? mix(float(0.5), wet.substrateRough, wet.film.mul(u.kerbWet))
      : float(0.5);
    r = mix(r, kerbR, step(1.5, zone)); // kerb paint
    if (tubeZones) {
      r = mix(r, float(0.82), step(2.5, zone)); // tube inner
      r = mix(r, float(0.55), step(3.5, zone)); // tube shell paint
    }
    r = mix(r, u.panelRough, step(4.5, zone)); // lacquered panel
    return r;
  })();

  // ── THE WATER FILM ITSELF ─────────────────────────────────────────────────
  // A clearcoat is the correct model and not an approximation: a smooth
  // dielectric layer, with its own normal, lying over a rough one. three's
  // clearcoat lobe also darkens the base by the coat's Fresnel for free, which
  // is a second helping of the albedo drop that sells the whole effect.
  //
  // DECK ONLY (aZone 1). Kerbs and rails get soaked in life too and they are
  // the brightest thing in a wet corner — but their albedo and roughness come
  // from constants above rather than from the deck's terms, so wetting them
  // means giving them their own darkening as well — which `kerbWet` now does
  // for the kerb. The RAILS themselves are still dry; they are a separate
  // material and a separate job.
  if (wet) {
    mat.clearcoatNode = Fn(() => {
      const zone = attribute("aZone", "float");
      // Deck (1) AND kerb (2), the kerb scaled by `kerbWet` so one knob moves
      // its albedo, its roughness and its gloss together.
      const isDeck = step(0.5, zone).mul(oneMinus(step(1.5, zone)));
      const isKerb = step(1.5, zone).mul(oneMinus(step(2.5, zone)));
      return wet.coat.mul(isDeck.add(isKerb.mul(u.kerbWet)));
    })();
    mat.clearcoatRoughnessNode = wet.coatRough;
    mat.clearcoatNormalNode = wetClearcoatNormal(wet);
  }

  /**
   * SHADOW THE WET EXTRAS. Direct sun on the deck is already in the lighting
   * model. What washes a car shadow off a soaked road is everything that is
   * NOT: the clearcoat's environment (PhysicalLightingModel multiplies that
   * by `aoNode`) and the planar/rail reflections, which ride emissive so they
   * never saw a shadow map. `shadowGate` is 1 on a dry pixel and leans toward
   * the sun's shadow factor as the coat comes up — see `wetShadow`.
   *
   * CSM returns vec4; a basic ShadowNode returns float. `.r` is valid on both.
   */
  const wetShadowNode = wet ? resolveWetShadowNode(opts) : null;
  const shadowGate = wetShadowNode
    ? mix(float(1), saturate(wetShadowNode.r), saturate(wet.coat.mul(u.wetShadow)))
    : float(1);
  if (wet && wetShadowNode) mat.aoNode = shadowGate;

  // Neon rings inside tubes — emissive, and routed into the emissive MRT
  // buffer so v3's SELECTIVE bloom picks them up (plain emissive alone does not
  // bloom here; see the note in roadGame.js). BloomMRTNode also keeps this
  // material safe in plain-RT renders (thumbnail bakes).
  // Null when the tube zones are gated off — see `tubeZones`. This is the
  // second of the two tubeRingMask evaluations every road fragment was paying
  // for, and the one that also dragged the whole neon path into the bloom MRT.
  const neonNode = tubeZones
    ? Fn(() => {
        const zone = attribute("aZone", "float");
        const along = uv().x;
        const innerMask = step(2.5, zone).mul(float(1).sub(step(3.5, zone)));
        return u.neonColor.mul(tubeRingMask(u, along)).mul(u.neonIntensity).mul(innerMask);
      })()
    : null;
  // ── PLANAR CAR REFLECTION ─────────────────────────────────────────────────
  // Additive, through emissive, and both of those are deliberate.
  //
  // ADDITIVE because the reflection target is cleared TRANSPARENT and holds the
  // car on nothing: `rgb * a` therefore adds the car and leaves every other
  // pixel of the deck exactly as the clearcoat's environment reflection already
  // had it. There is a small double-count where the car sits — the env term
  // still shows the sky the car is occluding — but that sky is the dim part of
  // the dome at a grazing angle, and the alternative is a full-screen occlusion
  // pass to subtract something nobody can see.
  //
  // EMISSIVE because a reflection is not albedo. Folding it into colorNode
  // would put it through the diffuse lighting term and make the car's
  // reflection brighten and dim with the sun, which is precisely wrong. It is
  // then multiplied by `shadowGate` below: the IMAGE of the car should not
  // Lambert-shade with the road, but it also must not flood the umbra as
  // self-light, which is what an un-gated emissive does to a wet shadow.
  let reflectNode = null;
  if (wet && opts.reflectionTexture) {
    const r = {
      /** biasMatrix · virtualCamera.projection · virtualCamera.viewInverse. */
      reflectMatrix: uniform(new THREE.Matrix4()),
      /** World-space contact point the fade is measured from. */
      reflectCenter: uniform(new THREE.Vector3()),
      /** The mirror plane's normal, for the facing test. */
      reflectNormal: uniform(new THREE.Vector3(0, 1, 0)),
      /** 0 while the pass is skipped (camera under the plane) so the road fades
       *  out instead of projecting a stale frame. */
      reflectOn: uniform(0),
    };

    /**
     * ONE texture node, sampled with `.sample(uv)` rather than `texture(t, uv)`.
     *
     * The reflection is double-buffered (see modularRoadReflection.js — the road
     * cannot sample a target the mirror pass is writing in the same WebGPU sync
     * scope), so the texture the material must read CHANGES IDENTITY every
     * frame. `texture(t, uv)` bakes `t` in at build time; the `.sample()` form
     * keeps `.value` assignable, which is what lets the caller point it at
     * whichever buffer was written last.
     */
    const reflectTex = texture(opts.reflectionTexture);
    mat._reflectTextureNode = reflectTex;

    reflectNode = Fn(() => {
      const clip = r.reflectMatrix.mul(vec4(positionWorld, 1.0));
      const projUv = clip.xy.div(max(clip.w, float(1e-4)));

      // Break it up with the water surface — the same normal the clearcoat
      // uses, so the distortion agrees with the highlight sitting on top of it,
      // and `coatNormalGain` means a flat puddle reflects sharply while damp
      // asphalt smears. Without this the reflection reads as a pasted-on decal.
      const reflUv = projUv.add(coatWobble);

      const col = reflectTex.sample(reflUv);

      // Fresnel. Same shape as the glass pane above: near-nothing looking
      // straight down, near-total at the grazing angle a chase camera lives at.
      const fres = oneMinus(abs(normalView.z)).pow(u.reflectFresnel);

      // Valid only on the plane, and only on surfaces facing along it.
      const toFrag = positionWorld.sub(r.reflectCenter);
      const dist = length(toFrag);
      const near = oneMinus(smoothstep(u.reflectFade.mul(0.45), u.reflectFade, dist));
      // OFF-PLANE FALLOFF — the one that matters on a curve. A planar mirror is
      // exact only on its plane, and the perpendicular distance from it is a
      // direct measure of how wrong this fragment's reflection is. See
      // reflectPlaneTol: a straight deck reads ~0 here and keeps its reflection,
      // a corner leaves the plane fast and loses it before it can smear.
      const offPlane = abs(dot(toFrag, r.reflectNormal));
      const onPlane = oneMinus(smoothstep(
        u.reflectPlaneTol.mul(0.35), u.reflectPlaneTol, offPlane,
      ));
      // ...and sharpened, because a raw dot stays near 1 through a gentle bank
      // and so attenuated nothing exactly where the deck had begun to rotate
      // away from the plane.
      // HOW MANY METRES WRONG IS THE REFLECTION HERE — see reflectErrTol. An
      // angle alone does not answer that: 8 degrees of divergence is nothing on
      // its own and 1.4 m of displacement at 10 m away, which is why a
      // coplanarity threshold let the inverted guardrail through on a crest.
      // Distance and angle only mean something multiplied.
      const cosT = saturate(dot(normalWorld, r.reflectNormal));
      const sinT = sqrt(saturate(oneMinus(cosT.mul(cosT))));
      const err = dist.mul(sinT);
      const facing = oneMinus(smoothstep(
        u.reflectErrTol.mul(0.4), u.reflectErrTol, err,
      ));
      // Deck + kerb, matching the clearcoat gate. A guardrail's reflection lands
      // mostly on the strip nearest it, and that strip IS the kerb — gating this
      // to the deck alone deleted the very reflection the rails were added for.
      const rzone = attribute("aZone", "float");
      const onRoad = step(0.5, rzone).mul(oneMinus(step(1.5, rzone)))
        .add(step(1.5, rzone).mul(oneMinus(step(2.5, rzone))).mul(u.kerbWet));

      // ...and only inside the target. Off the edge there is no data, so it has
      // to go to zero rather than clamp a stretched border pixel down the road.
      const e = reflUv.sub(0.5).abs().mul(2.0);
      const inside = oneMinus(smoothstep(0.86, 1.0, max(e.x, e.y)));

      return col.rgb.mul(col.a)
        .mul(fres).mul(wet.coat).mul(near).mul(onPlane).mul(facing).mul(inside).mul(onRoad)
        .mul(u.reflectStrength).mul(r.reflectOn);
    })();

    mat._reflectUniforms = r;
  }

  // ── THE RAIL'S REFLECTION ──────────────────────────────────────────────────
  //
  // Not a mirrored camera, and not solved analytically either. Both of those
  // shipped and both were wrong in the same way: they assume the road is a
  // plane. A planar mirror is only truthful ON its plane, and an analytic band
  // has to invent the road's shape to solve against. On a bank, a crest or a
  // dip the reflection then travels the wrong way — the rail climbs and its
  // reflection descends, which is not a blur you can tune away but a direction.
  //
  // So the rail is mirrored as GEOMETRY (buildMirroredRailGeometry) about the
  // deck at each of its own stations, and drawn with the REAL camera. That puts
  // the mirrored rail at the screen position where its reflection belongs, for
  // any road shape at all, so here there is no projection to compute: sample at
  // this fragment's own screenUV and the two agree by construction.
  //
  // What it still cannot do is occlusion — this is an image of the mirrored
  // rail with nothing in front of it, so it will show through the car. On a
  // reflection multiplied by Fresnel and the water's roughness that is a much
  // smaller lie than the one it replaces.
  let railNode = null;
  if (wet && opts.mirrorTexture) {
    const mirrorTex = texture(opts.mirrorTexture);
    // Same double-buffering as the planar mirror, so the node has to follow a
    // texture whose identity changes every frame — hence `.sample()`.
    mat._mirrorTextureNode = mirrorTex;

    // DID THE PASS RUN THIS FRAME? Runtime state, so it lives here and not in
    // ROAD_LOOK — a saved track must not be able to pin it. Without it, a
    // stopped pass leaves the road sampling whatever the ping-pong buffer held
    // last, which is a FROZEN reflection rather than no reflection: turning
    // "Rails in mirror" off looked like it did nothing at all.
    const railOn = uniform(0);
    mat._railMirrorOn = railOn;

        /**
         * THE OCCLUSION GATE. Null when no depth texture was supplied, so an older
         * caller still gets exactly the previous behaviour.
         *
         * The pre-mirror pass draws the mirrored content with NOTHING in front of
         * it — only that geometry is on PREMIRROR_LAYER — so at any pixel the
         * road shows whatever mirrored rail or prop happens to be there. Over a
         * crest that is the mirrored rail of the road BEYOND the hill, drawn
         * straight through it.
         *
         * Depth-testing the pass itself cannot fix that: the mirrored rail sits
         * BELOW its own deck, so the deck occludes its own reflection and testing
         * against the real road deletes everything. See the long note in
         * modularRoadReflection.
         *
         * What DOES separate the two is distance. A correct reflection lies a metre
         * or two from the fragment showing it — the rail is about that far above
         * its deck, so its mirror is about that far below. A see-through is tens of
         * metres. So: linearise both depths to metres and fade out on the gap.
         * Same question `reflectErrTol` asks of the planar mirror — how many metres
         * wrong is this fragment — asked of a different failure. Tall props need
         * a looser gate; roadGame raises `railDepthTol` while they are in the pass.
         */
    const mirrorDepthTex = opts.mirrorDepthTexture
      ? texture(opts.mirrorDepthTexture)
      : null;
    mat._mirrorDepthTextureNode = mirrorDepthTex;

    railNode = Fn(() => {
      const zone = attribute("aZone", "float");
      const deckOnly = step(0.5, zone).mul(oneMinus(step(1.5, zone)));

      // The same normal-driven wobble the car's reflection gets — literally the
      // same node now, not a second copy of the expression. Sampling straight is
      // what makes a reflection read as a decal: real water is never flat enough
      // to return a clean image.
      const uvSample = screenUV.add(coatWobble);
      const col = mirrorTex.sample(uvSample);

      let occlude = float(1);
      if (mirrorDepthTex) {
        // Sample the SAME uv the colour came from, or the gate would judge a
        // different pixel than the one being displayed.
        const raw = mirrorDepthTex.sample(uvSample).r;
        // Both to metres in front of the eye. positionView.z is negative going
        // away from the camera, hence the negate.
        const mirrorZ = perspectiveDepthToViewZ(raw, cameraNear, cameraFar).negate();
        const fragZ = positionView.z.negate();
        // A depth of 1 (nothing drawn) linearises to `far`; the gap is then
        // enormous and the fragment is rejected, which is correct — no mirrored
        // rail there means no reflection to show.
        const gap = abs(mirrorZ.sub(fragZ));
        // HOW ABRUPTLY the reflection ends at the crest line.
        //
        // A wide band dissolves the reflection instead of ending it, and a
        // dissolving rail reads as one SINKING INTO the deck rather than one
        // going out of view behind a hill. Some truncation at a crest is
        // correct — a real mirror stops showing the rail once the surface
        // carrying the image has curved away — so the goal is a clean edge, not
        // a gentle one. `railDepthSoft` is the fraction of the tolerance the
        // fade occupies: 0.15 is a crisp edge, 0.5 was the mush.
        const soft = u.railDepthTol.mul(u.railDepthSoft);
        occlude = oneMinus(smoothstep(
          u.railDepthTol.sub(soft), u.railDepthTol, gap,
        ));
      }

      const fres = oneMinus(abs(normalView.z)).pow(u.reflectFresnel);
      return col.rgb.mul(col.a)
        .mul(wet.coat).mul(fres).mul(deckOnly).mul(u.railReflect)
        .mul(occlude).mul(railOn);
    })();
  }

  // Optional paint-line glow for night. Uniform-gated (no material rebuild):
  // same mask as the albedo paint, written into emissive (self-light) AND the
  // selective bloom MRT (the halo). Costs almost nothing on top of lines that
  // are already drawn — bloom's fullscreen pyramid already runs for neon/props.
  const lineGlow = lineAmt.mul(u.lineColor).mul(u.linesBloomIntensity).mul(u.linesBloom);

  let emissive = neonNode ? neonNode.add(lineGlow) : lineGlow;
  if (reflectNode) emissive = emissive.add(reflectNode.mul(shadowGate));
  if (railNode) emissive = emissive.add(railNode.mul(shadowGate));
  mat.emissiveNode = emissive;
  // Neon + optional line glow. Reflections stay out — blooming them hazes every
  // wet frame.
  applyBloomMRT(mat, neonNode ? neonNode.add(lineGlow) : lineGlow);

  mat._roadUniforms = u;
  /**
   * The packed asphalt surface — vec4(macro, aggregate, wheelPath, aggFade).
   *
   * Exposed for the same reason as `_wetField` and `_reflectNode` below: anyone
   * building ON this surface has to reference the SAME node instance rather
   * than a second copy of the expression, or the two quietly diverge and the
   * derived thing stops agreeing with the deck it is supposed to describe.
   *
   * modularRoadSurfaceV2 is the caller. The bump still fades with `.w` so it
   * dies with the albedo speckle; the height itself is re-sampled in UV metres
   * (screen-space dFdx of `.x`/`.y` self-shadows into stripes).
   */
  mat._surfaceNode = surface;
  /** The raw vec2(film, pond) field, or null when dry. Exposed so wet-road-lab
   *  can render the drainage model as false colour without re-deriving the
   *  wheel-path mask it is built from — a second copy of that expression is
   *  exactly the kind of quiet divergence that makes a debug view lie. */
  mat._wetField = wet ? wet.field : null;
  /** The planar-reflection contribution on its own, or null. Same reason as
   *  `_wetField`: a debug view that re-derives the projection can disagree with
   *  the one being debugged, and "is the mirror empty or is it just dim?" is
   *  exactly the question you cannot answer by looking at the lit result. */
  mat._reflectNode = reflectNode;
  return mat;
}

/* ------------------------------------------------------------------------- */
/* Glass                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Shared look for the glass road's pane.
 *
 * REAL TRANSMISSION, and that is a reversal worth writing down, because
 * chassisModel.js sets `cheapGlass` on the car's windows for what look like the
 * same reasons. The car is right and so is this; they are different cases.
 *
 * Transmission makes three render a backdrop pass, which is a per-pixel cost
 * that scales with how much SCREEN the transmissive surface covers. The car's
 * six windows are on screen 100% of the time, every frame of every session — a
 * standing tax. A pane in the road is on screen for the second or two you are
 * over it. Measured in the editor with a pane filling a third of the view:
 * 17.9 ms/frame with transmission, 18.7 ms without, i.e. both pinned at the
 * vsync cap and the difference is noise.
 *
 * And it buys something alpha cannot. Under alpha blending the specular
 * reflection is multiplied by the same opacity as everything else, so a pane
 * clear enough to see through has no reflections left and reads as coloured
 * plastic — which is exactly how the first version of this looked, a turquoise
 * puddle in the road. Transmission keeps the surface response at full strength
 * and puts the see-through in its own term, which is the whole point of it.
 *
 * `ROAD_GLASS.transmission = 0` falls back to the cheap path (see below) if a
 * heavier scene ever changes that arithmetic.
 */
export const ROAD_GLASS = {
  color: 0xeef7f7, // near-neutral; a saturated tint is what made it read plastic
  roughness: 0.02,
  ior: 1.5,
  thickness: 0.25, // how far light travels inside the pane — drives the tint depth
  transmission: 1,
  envIntensity: 1.6,
  // Only used when transmission is 0 — see createRoadGlassMaterial.
  opacity: 0.14, // face-on: almost clear
  edgeOpacity: 0.9, // grazing: nearly a mirror
};

/**
 * The glass road's pane.
 *
 * MeshPhysicalNodeMaterial, not Standard: `ior`, `transmission`, `thickness` and
 * clearcoat are all physical-only, and together they are the difference between
 * glass and a tinted film. Reflections are real — `scene.environment` is a PMREM
 * of the live sky, so every pane on the track tracks the time of day for free.
 *
 * `side: DoubleSide` because you can be under the track looking up, which is
 * half the appeal of a glass floor.
 */
export function createRoadGlassMaterial(opts = {}) {
  const g = { ...ROAD_GLASS, ...opts };
  const transmissive = (g.transmission ?? 0) > 0;
  const mat = new THREE.MeshPhysicalNodeMaterial({
    color: lin(g.color),
    metalness: 0,
    roughness: g.roughness,
    ior: g.ior,
    thickness: g.thickness,
    transmission: g.transmission,
    specularIntensity: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    // A transmissive surface is OPAQUE as far as sorting goes — three composites
    // it against a copy of the backdrop, so it still writes depth and does not
    // join the transparent queue. Mixing the two modes is what produces glass
    // that vanishes behind other glass.
    transparent: !transmissive,
    depthWrite: transmissive,
    side: THREE.DoubleSide,
  });
  mat.envMapIntensity = g.envIntensity;

  const u = { opacity: uniform(g.opacity), edgeOpacity: uniform(g.edgeOpacity) };
  if (!transmissive) {
    // Fallback path: fake the transparency with a Fresnel alpha, from the
    // VIEW-space normal's z — the same idiom the collectibles use
    // (v3/props/collectibles.js), so it is proven against this renderer.
    //
    // The exponent is 5, matching Schlick, and it is not a taste knob: at 4
    // it went 50% opaque at a 40° view angle, where real glass reflects about
    // 4% and is essentially clear. A gentle curve does not read as "less
    // glassy", it reads as plastic.
    mat.opacityNode = Fn(() => {
      const fres = oneMinus(abs(normalView.z)).pow(5);
      return mix(u.opacity, u.edgeOpacity, fres);
    })();
  }
  mat._glassUniforms = u;
  return mat;
}

/** Soft-edged ring band repeating every `neonSpacing` meters along the path. */
function tubeRingMask(u, along) {
  const halfW = u.neonWidth.mul(0.5).div(u.neonSpacing); // width in cycle units
  const cyc = fract(along.div(u.neonSpacing));
  const d = abs(cyc.sub(0.5)); // distance from ring centre (in cycle units)
  return smoothstep(halfW.add(0.02), halfW, d);
}

/**
 * Cheap dedicated shader for rideable tubes.
 *
 * The shared road material still HAS a tube branch (so a look file round-trips
 * the colours), but every pixel of a tube used to evaluate the whole asphalt
 * graph — noise, lines, wet, PBR, MRT mix — then throw it away. Measured in
 * tube-lab.html: that fill, not triangle count or shadows, is what hitching
 * inside a bore costs. This is the lab graph: inner/outer colour, neon rings,
 * standard lighting. FrontSide — inner and outer walls face the right way, and
 * full-tube mouths emit both cap faces — so those pixels do not run twice.
 *
 * Zone 0 (rim caps / hidden seam webs) paints as outer: it is wall thickness,
 * not the bore.
 */
export function createTubeMaterial(opts = {}) {
  const u = {
    tubeInner: uniform(lin(opts.tubeInner ?? 0x24303c)),
    tubeOuter: uniform(lin(opts.tubeOuter ?? 0xd9662a)),
    // neonColor: uniform(lin(opts.neonColor ?? 0x35e0ff)), // cyan glow + bloom
    neonColor: uniform(lin(opts.neonColor ?? 0xffffff)),
    neonIntensity: uniform(opts.neonIntensity ?? 3.0),
    neonSpacing: uniform(opts.neonSpacing ?? 8.0),
    neonWidth: uniform(opts.neonWidth ?? 0.35),
    innerRough: uniform(opts.innerRough ?? 0.82),
    outerRough: uniform(opts.outerRough ?? 0.55),
    metalness: uniform(opts.metalness ?? 0.0),
  };

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.7,
    metalness: 0,
    side: THREE.FrontSide,
  });

  mat.colorNode = Fn(() => {
    const zone = attribute("aZone", "float");
    const along = uv().x;
    const ring = tubeRingMask(u, along);
    const innerCol = mix(u.tubeInner, u.neonColor, ring);
    let col = u.tubeOuter;
    col = mix(col, innerCol, step(2.5, zone));
    col = mix(col, u.tubeOuter, step(3.5, zone));
    return col;
  })();

  mat.roughnessNode = Fn(() => {
    const zone = attribute("aZone", "float");
    let r = u.outerRough;
    r = mix(r, u.innerRough, step(2.5, zone));
    r = mix(r, u.outerRough, step(3.5, zone));
    return r;
  })();

  mat.metalnessNode = u.metalness;

  // Bloom + emissive glow parked — rings are white paint on the inner albedo
  // for now. Restore these (and the cyan neonColor default) for the old fixture.
  // const neonNode = Fn(() => {
  //   const zone = attribute("aZone", "float");
  //   const along = uv().x;
  //   const innerMask = step(2.5, zone).mul(float(1).sub(step(3.5, zone)));
  //   return u.neonColor.mul(tubeRingMask(u, along)).mul(u.neonIntensity).mul(innerMask);
  // })();
  // mat.emissiveNode = neonNode;
  // applyBloomMRT(mat, neonNode);

  mat._tubeUniforms = u;
  return mat;
}

/** Colour / neon keys shared with ROAD_LOOK so a saved look still drives tubes. */
export const TUBE_LOOK_COLORS = ["tubeInner", "tubeOuter", "neonColor"];
export const TUBE_LOOK_NUMBERS = ["neonIntensity", "neonSpacing", "neonWidth"];

export function syncTubeUniforms(mat, p) {
  const u = mat?._tubeUniforms;
  if (!u || !p) return;
  for (const k of TUBE_LOOK_COLORS) {
    if (p[k] != null) u[k].value.copy(lin(p[k]));
  }
  for (const k of TUBE_LOOK_NUMBERS) {
    if (p[k] != null) u[k].value = typeof p[k] === "boolean" ? (p[k] ? 1 : 0) : p[k];
  }
  if (p.innerRough != null) u.innerRough.value = p.innerRough;
  if (p.outerRough != null) u.outerRough.value = p.outerRough;
  if (p.metalness != null) u.metalness.value = p.metalness;
}

/**
 * Cheap dedicated shader for asphalt decks.
 *
 * The shared road material paints every pixel with fractal noise, aggregate
 * speckle, historical drift rubber, tube/panel branches and bloom MRT — then
 * a flat straight throws almost all of that away. Tubes already left that
 * graph; this is the same idea for a deck: zone colours, optional paint lines,
 * a wheel-path darken, standard lighting. FrontSide by default.
 *
 * NOT wired into the game. asphalt-lab.html is the A/B — tune there, then
 * decide. A look file from that lab is lab-only.
 */
export function createCheapAsphaltMaterial(opts = {}) {
  const u = {
    asphaltDark: uniform(lin(opts.asphaltDark ?? 0x5c626a)),
    asphaltLight: uniform(lin(opts.asphaltLight ?? 0x8a919a)),
    deckBrightness: uniform(opts.deckBrightness ?? 1.0),
    lineColor: uniform(lin(opts.lineColor ?? 0xf2f2f2)),
    railA: uniform(lin(opts.railA ?? 0xd0342c)),
    railB: uniform(lin(opts.railB ?? 0xf0f0f0)),
    railStriped: uniform(opts.railStriped ?? 0),
    sideColor: uniform(lin(opts.sideColor ?? 0xd0342c)),
    centerHalf: uniform(opts.centerHalf ?? 0.045),
    centerSoft: uniform(opts.centerSoft ?? 0.02),
    centerDash: uniform(opts.centerDash ?? 0.18),
    edgePos: uniform(opts.edgePos ?? 0.82),
    edgeWidth: uniform(opts.edgeWidth ?? 0.022),
    edgeSoft: uniform(opts.edgeSoft ?? 0.004),
    railDash: uniform(opts.railDash ?? 0.5),
    linesOn: uniform(opts.linesOn ?? 0),
    centerOn: uniform(opts.centerOn ?? 1),
    edgeOn: uniform(opts.edgeOn ?? 1),
    wheelDarken: uniform(opts.wheelDarken ?? 0.10),
    deckRough: uniform(opts.deckRough ?? 0.93),
  };

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: opts.roughness ?? 0.92,
    metalness: opts.metalness ?? 0.0,
    side: THREE.FrontSide,
  });

  mat.colorNode = Fn(() => {
    const lateral = attribute("aLateral", "float");
    const zone = attribute("aZone", "float");
    const plain = attribute("aPlain", "float");
    const along = uv().x;

    // Flat mix — no fractal, no aggregate. The two authored greys still give
    // a readable deck; the expensive graph is what this is measuring against.
    const mid = mix(u.asphaltDark, u.asphaltLight, 0.45).mul(u.deckBrightness);
    const wheelPath = smoothstep(0.18, 0.42, abs(lateral))
      .mul(oneMinus(smoothstep(0.55, 0.8, abs(lateral))));
    let deckBase = mid.mul(oneMinus(wheelPath.mul(u.wheelDarken)));

    const lateralAA = fwidth(lateral).mul(0.75);
    const centerMask = smoothstep(
      u.centerHalf.add(max(u.centerSoft, lateralAA)),
      u.centerHalf,
      abs(lateral),
    );
    const dash = step(0.5, fract(along.mul(u.centerDash)));
    const edgeMask = smoothstep(
      u.edgeWidth.add(max(u.edgeSoft, lateralAA)),
      u.edgeWidth,
      abs(abs(lateral).sub(u.edgePos)),
    );
    const lineAmt = clamp(
      centerMask.mul(dash).mul(u.centerOn).add(edgeMask.mul(u.edgeOn)), 0.0, 1.0,
    ).mul(u.linesOn).mul(float(1).sub(plain));
    const deckCol = mix(deckBase, u.lineColor, lineAmt);

    const railBand = step(0.5, fract(along.mul(u.railDash)));
    const railCol = mix(u.railA, u.railB, railBand.mul(u.railStriped));

    let col = mix(u.sideColor, deckCol, step(0.5, zone));
    col = mix(col, railCol, step(1.5, zone));
    return col;
  })();

  mat.roughnessNode = Fn(() => {
    const zone = attribute("aZone", "float");
    let r = float(0.9);
    r = mix(r, u.deckRough, step(0.5, zone));
    r = mix(r, float(0.5), step(1.5, zone));
    return r;
  })();

  mat._cheapAsphaltUniforms = u;
  return mat;
}

export const CHEAP_ASPHALT_COLORS = [
  "asphaltDark", "asphaltLight", "lineColor", "railA", "railB", "sideColor",
];
export const CHEAP_ASPHALT_NUMBERS = [
  "deckBrightness", "centerHalf", "centerSoft", "centerDash",
  "edgePos", "edgeWidth", "edgeSoft", "railDash", "railStriped",
  "linesOn", "centerOn", "edgeOn", "wheelDarken", "deckRough",
];

export function syncCheapAsphaltUniforms(mat, p) {
  const u = mat?._cheapAsphaltUniforms;
  if (!u || !p) return;
  for (const k of CHEAP_ASPHALT_COLORS) {
    if (p[k] != null) u[k].value.copy(lin(p[k]));
  }
  for (const k of CHEAP_ASPHALT_NUMBERS) {
    if (p[k] != null) u[k].value = typeof p[k] === "boolean" ? (p[k] ? 1 : 0) : p[k];
  }
}

/**
 * Guardrail beams + posts.
 *
 * This was `metalness 0.92` — near-pure metal — and that is why the rails read
 * almost black. A metal has NO diffuse response whatsoever: every photon it
 * shows you is a specular reflection of the environment. At roughness 0.32 that
 * reflection is a narrow lobe, so a vertical rail mirrors the DIM horizon band
 * of the sky rather than the bright dome overhead or the sun, and it never picks
 * up any of the direct sunlight that lights everything around it.
 *
 * Physically correct, visually useless here. Dropping metalness to ~0.5 gives
 * the rail a real diffuse term, so it responds to the sun and sky like the rest
 * of the scene while keeping enough specular to still read as metal.
 */
export function createGuardrailMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: lin(opts.color ?? 0xc9d2dc),
    roughness: opts.roughness ?? 0.42,
    metalness: opts.metalness ?? 0.5,
    side: THREE.DoubleSide,
  });
}

/** Plain concrete shell material for tunnels (rendered double-sided). */
export function createTunnelMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: lin(opts.color ?? 0x5b6168),
    roughness: opts.roughness ?? 0.92,
    metalness: opts.metalness ?? 0.0,
    side: THREE.DoubleSide,
  });
}

/**
 * Vaulted road-tunnel shell. Vertex colours paint inner (dark) vs outer
 * (lighter) vs lip/rib; a cheap TSL concrete (noise + 8 m joints + crown soot)
 * sits on top. FrontSide because both faces exist as real geometry.
 *
 * Zero textures — same sampler-budget reason as the asphalt. Shared `surface`
 * node so color and roughness don't evaluate the noise twice.
 */
export function createVaultTunnelMaterial() {
  const surface = Fn(() => {
    const along = uv().x;
    const across = uv().y;
    const texel = max(fwidth(along), fwidth(across));
    const aggFade = saturate(oneMinus(texel.mul(6.0)));
    const agg = mx_noise_float(vec3(along.mul(3.2), across.mul(12.0), 0.0))
      .mul(0.5).mul(aggFade);
    const macro = mx_noise_float(vec3(along.mul(0.07), across.mul(1.4), 1.7))
      .mul(0.5).add(0.5);
    const f = fract(along.div(8.0));
    const dJoint = min(f, oneMinus(f)).mul(8.0);
    const joint = oneMinus(smoothstep(0.05, 0.18, dJoint));
    const soot = smoothstep(0.18, 0.92, oneMinus(abs(across.sub(0.5)).mul(2.0)));
    return vec4(macro, agg, joint, soot);
  })();

  const m = new THREE.MeshStandardNodeMaterial({
    roughness: 0.86,
    metalness: 0.03,
    vertexColors: true,
    side: THREE.FrontSide,
  });
  m.colorNode = Fn(() => {
    const s = surface;
    const base = attribute("color", "vec3");
    const tone = mix(float(0.8), float(1.1), s.x).add(s.y.mul(0.18));
    return base.mul(tone).mul(oneMinus(s.w.mul(0.12))).mul(oneMinus(s.z.mul(0.32)));
  })();
  m.roughnessNode = Fn(() => {
    const s = surface;
    return float(0.78).add(s.x.mul(0.12)).add(s.z.mul(0.1));
  })();
  m.userData.batchKey = "vaultShell";
  return m;
}

/** Sparse neon bars inside the vault tunnel — selective bloom via MRT. */
export function createTunnelGlowMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0xc8e8ff),
    roughness: 0.22,
    metalness: 0.02,
    emissive: new THREE.Color(0xc8e8ff),
    emissiveIntensity: 6.0,
  });
  m.colorNode = materialColor;
  applyBloomMRT(m, materialEmissive);
  m.userData.bloom = true;
  m.userData.batchKey = "tunnelGlow";
  return m;
}

export function createTunnelGlowMaterialForThumb() {
  return new THREE.MeshStandardMaterial({
    color: 0xc8e8ff,
    emissive: 0xc8e8ff,
    emissiveIntensity: 3.2,
    roughness: 0.22,
    metalness: 0.02,
  });
}

/** Vertex-colored material for start/finish/checkpoint decor meshes.
 *  Unlit on purpose: Standard + IBL + ACES turns checker white grey and lifts
 *  the black. These are graphics on the road, not painted asphalt. */
export function createDecorMaterial() {
  return new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
  });
}

/** Matte frame for the start_new extruded gantry. */
export function createStartGateBodyMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x0a0c10),
    roughness: 0.55,
    metalness: 0.35,
  });
  m.colorNode = materialColor;
  m.userData.batchKey = "startGateBody";
  return m;
}

/** Emissive start gantry stroke — selective bloom via MRT. */
export function createStartGateGlowMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x3dff8a),
    roughness: 0.3,
    metalness: 0.05,
    emissive: new THREE.Color(0x3dff8a),
    emissiveIntensity: 5.5,
  });
  m.colorNode = materialColor;
  applyBloomMRT(m, materialEmissive);
  m.userData.bloom = true;
  m.userData.batchKey = "startGateGlow";
  return m;
}

/** Plain materials for palette thumbnail bakes (no MRT — emissive reads directly). */
export function createStartGateBodyMaterialForThumb() {
  return new THREE.MeshStandardMaterial({
    color: 0x0a0c10,
    roughness: 0.55,
    metalness: 0.35,
  });
}

export function createStartGateGlowMaterialForThumb() {
  return new THREE.MeshStandardMaterial({
    color: 0x3dff8a,
    emissive: 0x3dff8a,
    emissiveIntensity: 3,
    roughness: 0.3,
    metalness: 0.05,
  });
}

/** Emissive finish gantry stroke — pink neon, same bloom path as start. */
export function createFinishGateGlowMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0xff4ec8),
    roughness: 0.3,
    metalness: 0.05,
    emissive: new THREE.Color(0xff4ec8),
    emissiveIntensity: 5.5,
  });
  m.colorNode = materialColor;
  applyBloomMRT(m, materialEmissive);
  m.userData.bloom = true;
  m.userData.batchKey = "finishGateGlow";
  return m;
}

export function createFinishGateGlowMaterialForThumb() {
  return new THREE.MeshStandardMaterial({
    color: 0xff4ec8,
    emissive: 0xff4ec8,
    emissiveIntensity: 3,
    roughness: 0.3,
    metalness: 0.05,
  });
}

/** Emissive checkpoint stripe — yellow neon, same bloom path as the gantries. */
export function createCheckpointGlowMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0xffe14a),
    roughness: 0.3,
    metalness: 0.05,
    emissive: new THREE.Color(0xffe14a),
    emissiveIntensity: 6.5,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  m.colorNode = materialColor;
  applyBloomMRT(m, materialEmissive);
  m.userData.bloom = true;
  m.userData.batchKey = "checkpointGlow";
  return m;
}

export function createCheckpointGlowMaterialForThumb() {
  return new THREE.MeshStandardMaterial({
    color: 0xffe14a,
    emissive: 0xffe14a,
    emissiveIntensity: 4,
    roughness: 0.3,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
}

/* ------------------------------------------------------------------------- */
/* THE LOOK — the authored half of this material, as plain JSON                */
/*                                                                            */
/* Two lists, and every uniform above must be in exactly one of them. That is  */
/* what makes the look portable: road-piece-lab.html tunes a plain object,     */
/* writes it to a file, and the game applies it to a live material. Anything   */
/* missing from these lists is invisible to that whole path — it silently      */
/* stops being tunable, which is exactly what happened to `linesOn`.           */
/* tools/roadUniformSyncTest.mjs asserts the lists stay complete.              */
/* ------------------------------------------------------------------------- */

/** File format written by the lab's "Export look" and accepted by the game. */
export const ROAD_LOOK_FORMAT = "modular-road-look";
export const ROAD_LOOK_VERSION = 1;

/** Uniforms authored as sRGB hex numbers. */
export const ROAD_LOOK_COLORS = [
  "asphaltDark", "asphaltLight", "lineColor", "railA", "railB",
  "sideColor", "tubeInner", "tubeOuter", "neonColor", "panelColor",
  ...WET_COLORS,
];

/** Uniforms authored as plain numbers (on/off flags included, as 0/1). */
export const ROAD_LOOK_NUMBERS = [
  "centerHalf", "centerSoft", "centerDash", "edgePos", "edgeWidth", "edgeSoft",
  "linesOn", "centerOn", "edgeOn", "linesBloom", "linesBloomIntensity",
  "railDash", "railStriped", "grainScale", "streak",
  "neonIntensity", "neonSpacing", "neonWidth",
  "deckBrightness", "macroScale", "aggScale", "aggWeight", "deckRough", "roughVary",
  "wheelPolish", "wheelDarken",
  "driftAmount", "driftWidth", "driftBias", "driftCurveRef", "driftGloss",
  "driftLines", "driftWander",
  "panelRough",
  ...WET_NUMBERS,
];

export const ROAD_LOOK_KEYS = [...ROAD_LOOK_COLORS, ...ROAD_LOOK_NUMBERS];

const _readColor = new THREE.Color();

/**
 * Apply hex colors / numeric uniforms from a plain params object.
 *
 * Partial objects are fine and expected — the lab does not expose the tube and
 * neon uniforms, so a look it exports simply leaves those alone.
 *
 * Booleans are coerced because the flags read as on/off at the call site while
 * the uniform is a float, and assigning `false` to it does not mean "off", it
 * corrupts the value.
 */
export function syncRoadUniforms(mat, p) {
  const u = mat?._roadUniforms;
  if (!u || !p) return;
  for (const k of ROAD_LOOK_COLORS) {
    if (p[k] != null) u[k].value.copy(lin(p[k]));
  }
  for (const k of ROAD_LOOK_NUMBERS) {
    if (p[k] != null) u[k].value = typeof p[k] === "boolean" ? (p[k] ? 1 : 0) : p[k];
  }
}

/**
 * Read the current look back out as a plain, JSON-safe object.
 *
 * The exact inverse of syncRoadUniforms, which matters more than it looks:
 * `lin()` runs the sRGB→linear transfer function on a Color that three has
 * ALREADY moved into the working colour space, so a hand-rolled "convert back"
 * that only undoes one of those steps would darken every colour a little on
 * each save→load cycle. `convertLinearToSRGB()` undoes `convertSRGBToLinear()`
 * and `getHex()` undoes the constructor, so the pair round-trips whatever
 * ColorManagement is set to.
 */
export function readRoadLook(mat) {
  const u = mat?._roadUniforms;
  if (!u) return null;
  const out = {};
  for (const k of ROAD_LOOK_COLORS) {
    out[k] = _readColor.copy(u[k].value).convertLinearToSRGB().getHex();
  }
  for (const k of ROAD_LOOK_NUMBERS) out[k] = u[k].value;
  return out;
}
