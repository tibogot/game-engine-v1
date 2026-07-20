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
    railA: uniform(lin(opts.railA ?? 0xd33a3a)),
    railB: uniform(lin(opts.railB ?? 0xf0f0f0)),
    sideColor: uniform(lin(opts.sideColor ?? 0x3a3d42)),
    centerHalf: uniform(opts.centerHalf ?? 0.045), // half-width of centre line (lateral units)
    centerSoft: uniform(opts.centerSoft ?? 0.02),
    centerDash: uniform(opts.centerDash ?? 0.18), // dashes per meter along
    edgePos: uniform(opts.edgePos ?? 0.82), // |lateral| where edge lines sit
    edgeWidth: uniform(opts.edgeWidth ?? 0.05),
    railDash: uniform(opts.railDash ?? 0.5), // paint bands per meter
    grainScale: uniform(opts.grainScale ?? 0.55),
  };

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: opts.roughness ?? 0.92,
    metalness: opts.metalness ?? 0.0,
    side: THREE.DoubleSide,
  });

  mat.colorNode = Fn(() => {
    const lateral = attribute("aLateral", "float");
    const zone = attribute("aZone", "float");
    const along = uv().x;
    const across = uv().y;

    // Subtle asphalt grain from a cheap value-noise-ish hash on along/across.
    const grain = fract(
      sin(along.mul(12.9898).add(across.mul(78.233))).mul(43758.5453),
    );
    const deckBase = mix(u.asphaltDark, u.asphaltLight, grain.mul(u.grainScale));

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

    const lineAmt = clamp(centerLine.add(edgeMask), 0.0, 1.0);
    const deckCol = mix(deckBase, u.lineColor, lineAmt);

    // Rail hazard bands.
    const railBand = step(0.5, fract(along.mul(u.railDash)));
    const railCol = mix(u.railA, u.railB, railBand);

    // Select by zone: 0 -> side, 1 -> deck, 2 -> rail.
    let col = mix(u.sideColor, deckCol, step(0.5, zone));
    col = mix(col, railCol, step(1.5, zone));
    return col;
  })();

  mat._roadUniforms = u;
  return mat;
}

/** Simple galvanised-metal material for the guardrail beams + posts. */
export function createGuardrailMaterial(opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: lin(opts.color ?? 0x9aa0a8),
    roughness: opts.roughness ?? 0.45,
    metalness: opts.metalness ?? 0.85,
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
  for (const k of ["centerHalf", "centerSoft", "centerDash", "edgePos", "edgeWidth", "railDash", "grainScale"]) {
    if (p[k] != null) u[k].value = p[k];
  }
}
