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
  fwidth,
  saturate,
  oneMinus,
  mx_noise_float,
  mx_fractal_noise_float,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

function lin(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
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
    // Rideable tubes (aZone 3 = inner wall, 4 = outer shell) — their own look,
    // clearly not asphalt, plus emissive neon rings inside that bloom.
    tubeInner: uniform(lin(opts.tubeInner ?? 0x24303c)), // dark blue-steel interior
    tubeOuter: uniform(lin(opts.tubeOuter ?? 0xd9662a)), // hot-wheels orange shell
    neonColor: uniform(lin(opts.neonColor ?? 0x35e0ff)), // cyan glow rings
    neonIntensity: uniform(opts.neonIntensity ?? 3.0), // >1 so bloom picks it up
    neonSpacing: uniform(opts.neonSpacing ?? 8.0), // meters between rings
    neonWidth: uniform(opts.neonWidth ?? 0.35), // ring width (m)
  };

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: opts.roughness ?? 0.92,
    metalness: opts.metalness ?? 0.0,
    side: THREE.DoubleSide,
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
  const surface = Fn(() => {
    // Stretched along the path, so every field below comes out as streaks that
    // run WITH the road rather than blobs sitting on it.
    const along = uv().x.div(u.streak); // metres along the path, anisotropic
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

  mat.colorNode = Fn(() => {
    const lateral = attribute("aLateral", "float");
    const zone = attribute("aZone", "float");
    const plain = attribute("aPlain", "float"); // 1 on platforms → no lines
    const along = uv().x;

    const macro = surface.x;
    const agg = surface.y;
    const wheelPath = surface.z;

    // Weighted toward the macro layer: large-scale variation is what the eye
    // reads as "a road surface", the speckle is the close-up detail on top.
    const tone = macro.mul(0.6).add(agg.mul(0.4));
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
    const lineAmt = clamp(
      centerLine.mul(u.centerOn).add(edgeMask.mul(u.edgeOn)), 0.0, 1.0,
    ).mul(u.linesOn).mul(float(1).sub(plain));
    const deckCol = mix(deckBase, u.lineColor, lineAmt);

    // Kerbs: solid red by default; hazard stripes only when railStriped is on
    // (reserved for the turn pieces later).
    const railBand = step(0.5, fract(along.mul(u.railDash)));
    const railCol = mix(u.railA, u.railB, railBand.mul(u.railStriped));

    // Tube interior: base color + a lit strip where the neon rings sit so the
    // glow reads as a fixture, not just bloom haze.
    const ringMask = tubeRingMask(u, along);
    const tubeInnerCol = mix(u.tubeInner, u.neonColor, ringMask);

    // Select by zone: 0 side, 1 deck, 2 rail, 3 tube inner, 4 tube outer.
    let col = mix(u.sideColor, deckCol, step(0.5, zone));
    col = mix(col, railCol, step(1.5, zone));
    col = mix(col, tubeInnerCol, step(2.5, zone));
    col = mix(col, u.tubeOuter, step(3.5, zone));
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
    deck = clamp(deck, 0.05, 1.0);

    let r = float(0.9); // sides / underside
    r = mix(r, deck, step(0.5, zone)); // deck asphalt
    r = mix(r, float(0.5), step(1.5, zone)); // kerb paint
    r = mix(r, float(0.82), step(2.5, zone)); // tube inner
    r = mix(r, float(0.55), step(3.5, zone)); // tube shell paint
    return r;
  })();

  // Neon rings inside tubes — emissive, and routed into the emissive MRT
  // buffer so v3's SELECTIVE bloom picks them up (plain emissive alone does not
  // bloom here; see the note in roadGame.js). BloomMRTNode also keeps this
  // material safe in plain-RT renders (thumbnail bakes).
  const neonNode = Fn(() => {
    const zone = attribute("aZone", "float");
    const along = uv().x;
    const innerMask = step(2.5, zone).mul(float(1).sub(step(3.5, zone)));
    return u.neonColor.mul(tubeRingMask(u, along)).mul(u.neonIntensity).mul(innerMask);
  })();
  mat.emissiveNode = neonNode;
  applyBloomMRT(mat, neonNode);

  mat._roadUniforms = u;
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

/** Vertex-colored material for start/finish/checkpoint decor meshes. */
export function createDecorMaterial() {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.04,
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
  "sideColor", "tubeInner", "tubeOuter", "neonColor",
];

/** Uniforms authored as plain numbers (on/off flags included, as 0/1). */
export const ROAD_LOOK_NUMBERS = [
  "centerHalf", "centerSoft", "centerDash", "edgePos", "edgeWidth", "edgeSoft",
  "linesOn", "centerOn", "edgeOn", "railDash", "railStriped", "grainScale", "streak",
  "neonIntensity", "neonSpacing", "neonWidth",
  "deckBrightness", "macroScale", "aggScale", "deckRough", "roughVary",
  "wheelPolish", "wheelDarken",
  "driftAmount", "driftWidth", "driftBias", "driftCurveRef", "driftGloss",
  "driftLines", "driftWander",
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
