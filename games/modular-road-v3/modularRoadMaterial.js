import * as THREE from "three";
import {
  Fn,
  uniform,
  attribute,
  uv,
  vec3,
  float,
  mix,
  clamp,
  abs,
  fract,
  smoothstep,
  step,
  sin,
  floor,
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
    asphaltDark: uniform(lin(opts.asphaltDark ?? 0x14161a)),
    asphaltLight: uniform(lin(opts.asphaltLight ?? 0x23262c)),
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
    grainScale: uniform(opts.grainScale ?? 0.55),
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

  mat.colorNode = Fn(() => {
    const lateral = attribute("aLateral", "float");
    const zone = attribute("aZone", "float");
    const plain = attribute("aPlain", "float"); // 1 on platforms → no lines
    const along = uv().x;
    const across = uv().y;

    // Asphalt: fine hash grain + a coarse mottle octave (patchy resurfacing
    // look) + subtle wheel-path wear darkening where tires actually run. All
    // cheap ALU — no textures.
    const grain = fract(
      sin(along.mul(12.9898).add(across.mul(78.233))).mul(43758.5453),
    );
    const mottle = sin(along.mul(0.31).add(sin(across.mul(0.43)).mul(2.1)))
      .mul(sin(across.mul(0.23).add(along.mul(0.11))))
      .mul(0.5)
      .add(0.5);
    const tone = grain.mul(0.72).add(mottle.mul(0.28));
    let deckBase = mix(u.asphaltDark, u.asphaltLight, tone.mul(u.grainScale));
    const wheelWear = smoothstep(0.18, 0.42, abs(lateral)).mul(
      float(1).sub(smoothstep(0.55, 0.8, abs(lateral))),
    );
    deckBase = deckBase.mul(float(1).sub(wheelWear.mul(0.14)));

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
    let r = float(0.9); // sides / underside
    r = mix(r, float(0.94), step(0.5, zone)); // deck asphalt
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

/** Galvanised-metal material for the guardrail beams + posts — brighter and
 *  glossier so the W-beam profile actually catches sky/sun highlights. */
export function createGuardrailMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: lin(opts.color ?? 0xaeb6c0),
    roughness: opts.roughness ?? 0.32,
    metalness: opts.metalness ?? 0.92,
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
  for (const k of ["centerHalf", "centerSoft", "centerDash", "edgePos", "edgeWidth", "railDash", "railStriped", "grainScale", "neonIntensity", "neonSpacing", "neonWidth"]) {
    if (p[k] != null) u[k].value = p[k];
  }
}
