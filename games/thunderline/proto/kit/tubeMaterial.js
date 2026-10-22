// THUNDERLINE'S TUBE INSIDE (user, 2026-10-22: "the interior tube texture is not nice, the same as my old
// game with those lines — we could make it way better"). The old road material's tube mode painted bright
// rings every 8 m whose bloom flooded the whole bore pale cyan. This one is a PIPE, not a road:
//   - graphite PANELS: grooves every 4 m along and 16 round, each panel a touch lighter or darker;
//   - LIGHT RINGS: thin, bolt blue, every 16 m — they flash past at speed (the bloom picks them up);
//   - a FLOOR BAND (where "down" is, spinning round the walls) with bolt chevrons pointing the way;
//   - the roof darker (light falls in from the mouths);
//   - the SHELL outside: the deep Thunderline blue, satin.
// Zones (tubeLook.js tubeSection): 3 the bore (inside), 4 the shell, 0 rim caps (wall thickness = shell).
// `aRound` (tubeLook.js addRound): 0 → 1 round the inside from the profile's start, the floor at 0.5.
// uv.x: metres along the piece. One material for tubes and half-pipes (their floor is 0.5 too).
import * as THREE from "three";
import { attribute, uv, vec2, float, color, mix, abs, min, fract, floor, sin, dot, step, smoothstep, fwidth, oneMinus } from "three/tsl";
import { applyBloomMRT } from "../../../../v3/render/bloomMRT.js";

export const TUBE_LOOK = {
  panel: 0x1b2230, groove: 0x0a0d14, floor: 0x283244, shell: 0x1f56c9, light: 0x3fd2ff,
  ringEvery: 16, // m between light rings
  ringGlow: 0.9, chevronGlow: 0.35,
};

export function createTubeMaterial() {
  const L = TUBE_LOOK;
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0.15 });
  const zone = attribute("aZone", "float");
  const round = attribute("aRound", "float");
  const along = uv().x;
  const inside = step(2.5, zone).mul(oneMinus(step(3.5, zone)));
  // antialiased band: 1 inside [c - w, c + w] along x. Thinner than a pixel (seen far or at a grazing
  // angle, where fwidth explodes) it fades by w / aa instead of turning into a 0.5 smear — that smear,
  // along the walls at the camera's height, drew bright bands across the bore.
  const band = (x, c, w) => {
    const d = abs(x.sub(c)), aa = fwidth(x).mul(0.75);
    return oneMinus(smoothstep(w.sub(aa), w.add(aa), d)).mul(min(float(1), w.div(aa)));
  };

  // ---- panels: 4 m along × 1/16 round, grooves between, each panel its own tone ----
  const pu = along.div(4), pv = round.mul(16);
  const groove = band(fract(pu), float(0), float(0.012)).add(band(fract(pu), float(1), float(0.012)))
    .add(band(fract(pv), float(0), float(0.03))).add(band(fract(pv), float(1), float(0.03))).min(1);
  const cell = vec2(floor(pu), floor(pv));
  const tone = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453)).mul(0.14).add(0.93);
  let inner = mix(color(L.panel).mul(tone), color(L.groove), groove.mul(0.85));

  // ---- the floor band (|round − 0.5| < 0.1: about the road's width) and its edge lines ----
  // The edges are PAINT, not light: lines along the walls at the camera's height collapse onto the
  // horizon in a straight tube, and glowing they smeared into one bright band across the screen.
  const fromFloor = abs(round.sub(0.5));
  const floorBand = step(fromFloor, float(0.1));
  inner = mix(inner, color(L.floor).mul(tone), floorBand.mul(oneMinus(groove.mul(0.6))));
  const floorEdges = band(fromFloor, float(0.1), float(0.0012)); // ~7 cm a side in a 9 m tube
  // chevrons pointing the way, every 8 m, in the middle of the band
  // (round units are ~2πR m: a ±0.05 band is ~±3 m in a 9 m tube; the V's arms lean back 1.5 m per m)
  const chevron = band(fract(along.div(8).add(fromFloor.mul(14))), float(0.5), float(0.03)).mul(step(fromFloor, float(0.05)));

  // ---- lights: thin rings every ringEvery m ----
  const ring = band(fract(along.div(L.ringEvery)), float(0.5), float(0.12 / L.ringEvery));

  // ---- the roof darker: light falls in from the mouths, not from above ----
  const fromRoof = min(round, oneMinus(round)); // 0 at the top centre, 0.5 at the floor
  inner = inner.mul(smoothstep(0, 0.3, fromRoof).mul(0.45).add(0.55));
  inner = mix(inner, color(L.light).mul(0.45), floorEdges.mul(0.5));
  inner = mix(inner, color(L.light), ring);
  inner = mix(inner, color(L.light).mul(0.6), chevron);

  m.colorNode = mix(color(L.shell), inner, inside);  m.roughnessNode = mix(float(0.45), float(0.7).sub(groove.mul(0.15)), inside);
  const glow = color(L.light).mul(ring.mul(L.ringGlow).add(chevron.mul(L.chevronGlow))).mul(inside);
  m.emissiveNode = glow;
  applyBloomMRT(m, glow); // the page's SELECTIVE bloom reads the MRT, not plain emissive
  return m;
}
