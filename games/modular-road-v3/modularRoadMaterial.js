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
    // ASPHALT ALBEDO. The old 0x14161a→0x23262c pair sat at roughly 0.007–0.017
    // in LINEAR light — real asphalt is 0.04 (fresh) to 0.12 (weathered), so the
    // deck was 3–6× darker than the material it was imitating and no amount of
    // exposure or light tuning could recover it. These land at ~0.040 and ~0.098
    // linear, i.e. the actual physical range.
    asphaltDark: uniform(lin(opts.asphaltDark ?? 0x383b40)),
    asphaltLight: uniform(lin(opts.asphaltLight ?? 0x585c62)),
    /** Final multiplier on the deck albedo — the one knob for "too dark / too
     *  bright" without touching the two colours. */
    deckBrightness: uniform(opts.deckBrightness ?? 1.0),
    lineColor: uniform(lin(opts.lineColor ?? 0xf2f2f2)),
    railA: uniform(lin(opts.railA ?? 0xd0342c)),
    railB: uniform(lin(opts.railB ?? 0xf0f0f0)),
    /** 0 = kerbs painted solid railA (the default look); 1 = railA/railB hazard
     *  stripes. Turn pieces will opt into stripes later — keep the machinery. */
    railStriped: uniform(opts.railStriped ?? 0),
    sideColor: uniform(lin(opts.sideColor ?? 0x3a3d42)),
    centerHalf: uniform(opts.centerHalf ?? 0.045), // half-width of centre line (lateral units)
    centerSoft: uniform(opts.centerSoft ?? 0.02),
    centerDash: uniform(opts.centerDash ?? 0.18), // dashes per meter along
    edgePos: uniform(opts.edgePos ?? 0.82), // |lateral| where edge lines sit
    edgeWidth: uniform(opts.edgeWidth ?? 0.05),
    railDash: uniform(opts.railDash ?? 0.5), // paint bands per meter
    /** Contrast of the asphalt tone around its midpoint. NOTE: this used to cap
     *  the dark→light mix (tone × grainScale, so 0.55 meant the deck could never
     *  reach asphaltLight — part of why it read so dark). It is now a symmetric
     *  contrast multiplier, 1.0 = the full authored range. */
    grainScale: uniform(opts.grainScale ?? 1.0),
    /** Cycles per metre of the slow tonal drift (resurfacing patches, bleaching). */
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
    // Centre + edge paint lines. Default OFF — the clean Apex-Rush deck look;
    // the dev panel's "Road lines" toggle flips the uniform live.
    linesOn: uniform(opts.linesOn ?? 0), // 1 = draw centre + edge lines, 0 = plain deck
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
    const along = uv().x; // metres along the path
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
    deckBase = deckBase.mul(u.deckBrightness);

    // Dashed centre line.
    const centerMask = smoothstep(
      u.centerHalf.add(u.centerSoft),
      u.centerHalf,
      abs(lateral),
    );
    const dash = step(0.5, fract(along.mul(u.centerDash)));
    const centerLine = centerMask.mul(dash);

    // Solid edge lines on both sides.
    const edgeMask = smoothstep(
      u.edgeWidth,
      float(0.0),
      abs(abs(lateral).sub(u.edgePos)),
    );

    // Global lines toggle × per-piece plain flag (platforms suppress lines).
    const lineAmt = clamp(centerLine.add(edgeMask), 0.0, 1.0).mul(u.linesOn).mul(float(1).sub(plain));
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
      .sub(wheelPath.mul(u.wheelPolish));
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

/** Apply hex colors / numeric uniforms from a plain params object. */
export function syncRoadUniforms(mat, p) {
  const u = mat._roadUniforms;
  if (!u) return;
  if (p.asphaltDark != null) u.asphaltDark.value.copy(lin(p.asphaltDark));
  if (p.asphaltLight != null) u.asphaltLight.value.copy(lin(p.asphaltLight));
  if (p.lineColor != null) u.lineColor.value.copy(lin(p.lineColor));
  if (p.railA != null) u.railA.value.copy(lin(p.railA));
  if (p.railB != null) u.railB.value.copy(lin(p.railB));
  if (p.sideColor != null) u.sideColor.value.copy(lin(p.sideColor));
  if (p.tubeInner != null) u.tubeInner.value.copy(lin(p.tubeInner));
  if (p.tubeOuter != null) u.tubeOuter.value.copy(lin(p.tubeOuter));
  if (p.neonColor != null) u.neonColor.value.copy(lin(p.neonColor));
  for (const k of ["centerHalf", "centerSoft", "centerDash", "edgePos", "edgeWidth", "railDash", "railStriped", "grainScale", "neonIntensity", "neonSpacing", "neonWidth", "deckBrightness", "macroScale", "aggScale", "deckRough", "roughVary", "wheelPolish", "wheelDarken"]) {
    if (p[k] != null) u[k].value = p[k];
  }
}
