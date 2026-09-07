// ============================================================================
// CITY STREETS — the ground the city stands on, built to the SMART ROAD's own
// surface recipe: its asphalt tone model, its sealed-crack tar snakes, and its
// complete wet model. One draw, on the plane that was already being drawn.
//
// ── WHY NOT THE SMART ROAD SYSTEM ITSELF ─────────────────────────────────────
//
// Smart Road sweeps a profile along a spline, stamps per-vertex lateral /
// curvature / zone attributes, and bakes a collision BVH — everything a road
// the car DRIVES ON needs, all of it waste on a road it flies OVER at 40 m. A
// 2.4 km grid of it is hundreds of splines and a draw per piece. What IS worth
// taking from it is the LOOK, and that is what this file does: the shading
// model is lifted term for term from modularRoadMaterial.js / modularRoadWet.js
// and re-keyed to world space and the block grid instead of spline attributes,
// so a wet city street and a wet track look like the same weather.
//
//   asphalt   macro tone (world-space 3-octave fractal) weighted with a chip
//             aggregate that fades out at its own sampling rate; wheel paths
//             in every lane darken and polish; tar snakes are contours of the
//             macro field, feathered to a pixel and segmented along their run
//   wet       FILM darkens the albedo to ~half and smooths it; PONDS stand in
//             the low places (a crowned street sheds to the kerbs); the water is
//             a real CLEARCOAT — a second, smooth GGX lobe with its own ripple
//             normal — and Fresnel does the rest at the chase camera's grazing
//             angle. Paint wets on its own terms: less darkening, MORE gloss.
//
// ── WHAT ELSE THIS FIXED ─────────────────────────────────────────────────────
//
// The plane it replaced was a MeshBasicNodeMaterial — UNLIT — so the towers'
// shadows never landed on the ground at all; the dark shapes on the old ground
// were only the block/street colour split. This is a physical material.
//
// ── THE GRID ─────────────────────────────────────────────────────────────────
//
// Identical to the layout's (modularRoadCity.js): `pitch = (blockLots +
// streetLots) * lotSize`; within a period [0, blockW) is BLOCK — pavement at
// the kerb, the buildings' own yard behind — and [blockW, pitch) is STREET.
// Deriving both from the same numbers is what keeps a kerb from drifting a
// metre into a tower's footprint.
//
// ── COST ─────────────────────────────────────────────────────────────────────
//
// The ground can cover most of the screen. Everything that only resolves close
// — aggregate, tar snakes, cracks, worn paint — sits behind a real WGSL `If`
// on a distance term, as the three.js city example does it; the ripple normal
// and the aggregate carry their own fwidth fades on top so nothing aliases
// into crawling static down a long street. Every derivative is taken at
// function top level (tools/cityShaderTest.mjs fails the build otherwise).
// ============================================================================
import * as THREE from "three";
import {
  Fn, If, float, vec2, vec3, vec4, uniform, mix, smoothstep, max, min, abs, floor, fract,
  mod, step, saturate, oneMinus, pow, cos, uint, hash, positionWorld, positionView,
  normalView, normalWorld, cameraPosition, fwidth, length, normalMap,
  texture, dot, sqrt, uniformArray,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { NEON_PALETTE } from "./modularRoadCityFacade.js";

/**
 * Defaults. The wet block mirrors WET_DEFAULTS in modularRoadWet.js by NAME and
 * by value, so the game can push the same weather to the city streets it pushes
 * to the track, and the two never disagree about what "wet" means.
 */
export const STREET_DEFAULTS = {
  // ── ASPHALT (modularRoadMaterial.js ROAD_LOOK) ────────────────────────────
  asphaltDark: 0x1b1f25,
  asphaltLight: 0x414852,
  deckBrightness: 1.0,
  /** Symmetric contrast about the tone's midpoint. */
  grainScale: 1.0,
  /** World-space macro tone: resurfacing patches, bleaching, old repairs. */
  macroScale: 0.06,
  /** Chip aggregate, cycles per metre (5 ⇒ ~20 cm chips), and its weight
   *  against the macro layer. */
  aggScale: 5.0,
  aggWeight: 0.4,
  deckRough: 0.93,
  /** Wheel-path darkening (deposit) and polish in every lane. */
  wheelDarken: 0.10,
  wheelRough: 0.12,
  /**
   * RESURFACING PATCHES, not tar snakes.
   *
   * The first version drew sealed cracks as CONTOURS of the macro noise field.
   * A contour of smooth noise is a smooth wandering curve, and crack sealant is
   * nothing like that: it is jagged, it follows joints and stress lines, and it
   * does not meander across a lane in a lazy arc. It read as fake because it
   * was, and it cost a three-octave fractal in the NORMAL pass as well, purely
   * to bump a hairline.
   *
   * What a city street has at this scale is PATCHES — rectangles of newer,
   * darker asphalt where the road was dug up and made good, with a seam of
   * sealant round the edge. That is a grid, not a contour: cheap, and right.
   */
  patchAmount: 0.55,
  /** Metres per patch cell. */
  patchScale: 9.0,
  /** Fraction of cells that carry a patch at all. */
  patchChance: 0.22,
  /** How much darker a patch is, and its seam. */
  patchDarken: 0.30,
  patchSeam: 0.45,
  /** Seam half-width, in metres. */
  patchSeamWidth: 0.07,

  // ── PAVEMENT ──────────────────────────────────────────────────────────────
  /** Concrete is a COOL grey; warm tan reads as sand at this scale. */
  walkColor: 0x74767a,
  kerbColor: 0x8d8f92,
  slabSize: 1.6,
  /** A block here is 4 lots = 136 m; paving all of it made every block a
   *  plaza. Pavement is a BAND at the kerb; behind it is the buildings' own
   *  service yard, visible only in the gaps between them. */
  walkWidth: 5.5,
  yardColor: 0x2f3134,
  kerbWidth: 0.35,
  /** A real kerb reveal is ~15 cm; it is a genuine step in the normal. */
  kerbHeight: 0.15,
  /** Kerbs get soaked too, at this fraction of the road's dose — paint and
   *  dense concrete are near non-porous, so they darken less. */
  kerbWet: 0.6,

  // ── PAINT ─────────────────────────────────────────────────────────────────
  paintColor: 0xd0ccc0,
  centreWidth: 0.12,
  laneWidth: 0.10,
  dashPeriod: 7.0,
  crossPitch: 1.2,
  crossWidth: 0.38,
  crossInset: 5.0,
  markings: 1.0,
  /** Paint under water: it darkens FAR less than open aggregate (`lineWet`)
   *  but it is the wettest-LOOKING thing on the road (`lineCoat`), and the
   *  film over it is smoother than over chips (`lineCoatRough`). */
  lineWet: 0.35,
  lineCoat: 1.4,
  lineCoatRough: 0.5,

  // ── WET (modularRoadWet.js WET_DEFAULTS, same names) ──────────────────────
  wetAmount: 0,
  wetCoatStrength: 0.55,
  wetDarken: 0.48,
  wetRough: 0.32,
  wetCoatRough: 0.10,
  wetTint: 0xbccadc,
  puddleAmount: 1,
  puddleScale: 0.2,
  puddleStreak: 3.0,
  puddleThreshold: 0.58,
  puddleSoft: 0.035,
  puddleDarken: 0.42,
  puddleCoatRough: 0.012,
  waterlineDark: 0.55,
  waterlineSharp: 2.5,
  /** Crown drainage: a street sheds to BOTH kerbs. */
  wetDrainStart: 0.3,
  wetCamber: 1.0,
  wetDrainStrength: 0.22,
  wetWheelClear: 0.45,
  rippleAmp: 0.05,
  rippleScale: 1.6,
  rippleStretch: 2.5,
  rippleDamp: 0.9,

  // ── STREET LIGHTS ─────────────────────────────────────────────────────────
  //
  // A night city without street lights is a black hole with windows in it —
  // the wet road had nothing to reflect. Hundreds of real point lights are out
  // of the question, so the lamps live in the GRID: one every `lampPitch`
  // metres along both kerbs of every street, and the street shader computes
  // its distance to the nearest one analytically and adds that lamp's pool.
  // No lights, no shadow maps, a handful of ALU. The heads and poles are one
  // instanced draw (`lampMesh`) so the sources are visible and bloom.
  lampPitch: 26,
  /** Lamp head height and its inset from the kerb onto the pavement. */
  lampHeight: 9.0,
  lampInset: 0.9,
  /** Stagger the two sides by half a pitch — real streets alternate. */
  lampStagger: 0.5,
  lampColor: 0xffc27a,
  /** Pool strength at night, and how far the pool reaches (metres). */
  lampIntensity: 4.6,
  lampRange: 17,
  /** How much MORE a wet surface lights up under a lamp (the film's mirror). */
  lampWetGain: 1.8,
  /** NIGHT SKYGLOW — see the same pair in the facade. Between the lamps a
   *  street is lit by the city, not by nothing. */
  glowColor: 0x2a2f3a,
  glowAmount: 1.0,
  /** 0 by day, 1 at night — the city hands this over with the facade's. */
  nightAmount: 0,

  // ── NEON SPILL ────────────────────────────────────────────────────────────
  //
  // The other half of the shopfront neon (the lit frontages themselves are in
  // modularRoadCityFacade.js). A sign is only half the effect — what makes a
  // street read as Blade Runner is the COLOURED LIGHT ON THE GROUND under it,
  // and this street is now a mirror, so the wash gets paid for twice: once
  // directly, and once in the reflection lying on top of it.
  //
  // Emissive, like the lamp pools and for the same reason: there are no lights
  // here. It is the frontage's irradiance times the road's own albedo, so it
  // shows on paint and on wet asphalt and barely on dry.
  neonSpill: 0.42,
  /** Metres from the kerb the wash reaches into the carriageway. */
  neonSpillWidth: 10.0,
  /** How much brighter the wash is on a wet road — the same trade `lampWetGain`
   *  makes: standing water mirrors the frontage back at you. */
  neonWetGain: 2.2,

  // ── PLANAR REFLECTION (modularRoadWet.js WET_DEFAULTS, same names) ────────
  //
  // The puddles were already here and already correct; what they had to
  // reflect was a smooth gradient sky, which mirrors to nothing at all. That
  // is why wet street read as "lighter patches" rather than as water.
  //
  // This costs NO NEW RENDER PASS. The game already mirrors the car about the
  // plane of its own tyre contacts for the road deck, and when the car is on
  // the street THAT PLANE IS THIS SURFACE — so the street samples the target
  // the road pass already wrote, with the road's own uniforms. When the car is
  // up on the sky track the same fades that keep a banked deck honest
  // (`reflectFade` by distance, `reflectPlaneTol` off the plane) take the
  // street's reflection to zero, which is correct: there is nothing down here
  // to mirror.
  reflectStrength: 1.2,
  /** Near-nothing looking straight down, near-total at a chase camera's angle. */
  reflectFresnel: 2.5,
  /** Mip bias by coat roughness — a flat puddle mirrors sharply, damp asphalt smears. */
  reflectBlur: 3.2,
  /** Vertical smear of the three taps, in UV. */
  reflectStretch: 0.02,
  /** How far the ripple bends the reflected image. */
  reflectDistort: 0.06,
  /** Metres from the contact point at which it has faded out. */
  reflectFade: 26,
  /** Metres off the mirror plane before it is discarded. */
  reflectPlaneTol: 0.7,

  // ── LOD ───────────────────────────────────────────────────────────────────
  detailNear: 25,
  detailFar: 240,
  gritRelief: 0.003,
};

/** Every default that is a colour, for the uniform builder and the tests. */
export const isStreetColorKey = (k) => /Color$|^asphalt(Dark|Light)$|^wetTint$/.test(k);

/**
 * Surface-gradient bump (Mikkelsen) — the same one the facade uses. bumpMap
 * offsets a UV to read its height, so it returns a zero gradient for a height
 * keyed off position; this feeds the screen derivatives of the height into
 * the view normal instead.
 */
function bumpNormal(height) {
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
}

/** Anti-aliased filled band, edge sized to the pixel footprint so thin paint
 *  stays crisp near and dissolves far instead of shimmering. `aa` is passed
 *  in: fwidth must be taken at top level, never inside a branch. */
const lineAA = (coord, half, aa) => smoothstep(half.add(aa), half.sub(aa), abs(coord));
const gridLine = (coord, period, half, aaPeriod) => {
  const g = coord.div(period);
  const d = float(0.5).sub(abs(fract(g).sub(0.5)));
  const hw = half.div(period);
  return smoothstep(hw.add(aaPeriod), hw.sub(aaPeriod), d);
};

/**
 * THE ONLY NOISE IN THIS FILE, and deliberately not MaterialX's.
 *
 * The first version used `mx_noise_float` / `mx_fractal_noise_float`. Those are
 * 3D PERLIN — eight corner gradients, a trilerp and a hash chain each — and
 * counted in the generated WGSL this street was evaluating fifteen Perlin
 * lookups per pixel. The ground plane is FLAT, so the third dimension was pure
 * waste on every one of them, and the two sub-builds (normal, clearcoat
 * normal) were rebuilding whole fields the colour pass had already computed.
 *
 * This is 2D value noise on the same integer PCG hash the facade uses: four
 * hashes and three lerps. For asphalt tone, oil stains and puddles — fields
 * with no directional structure to preserve — it is indistinguishable from
 * Perlin, and several times cheaper.
 */
const ihash2 = (i) => hash(
  uint(i.x.add(1 << 16)).mul(uint(73856093)).bitXor(uint(i.y.add(1 << 16)).mul(uint(19349663))),
);
const vnoise = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const w = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = ihash2(i), b = ihash2(i.add(vec2(1.0, 0.0)));
  const c = ihash2(i.add(vec2(0.0, 1.0))), d = ihash2(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y).sub(0.5);
});
/** Two octaves, for the broader stains and the ponding. */
const vfbm = (p) => vnoise(p).add(vnoise(p.mul(2.17)).mul(0.5));
/** Three, where the macro tone wants a slower roll under the fine detail. */
const vfbm3 = (p) => vfbm(p).add(vnoise(p.mul(4.7)).mul(0.25));
/** Anti-aliased "x inside [lo, hi]" — the patch rectangles below. */
const band = (x, lo, hi, aa) =>
  smoothstep(lo.sub(aa), lo.add(aa), x).mul(smoothstep(hi.add(aa), hi.sub(aa), x));

/** Tangent-space slope → normal, packed 0..1 for `normalMap`. */
const packSlope = (slope) => vec3(slope.x.negate(), slope.y.negate(), 1.0).normalize().mul(0.5).add(0.5);

/**
 * Build the streets + pavement ground plane.
 *
 * @param {object} opts
 * @param {object} opts.P            the city params (grid + extent + centre)
 * @param {number} opts.originCellX  global lot cell the grid is phased from
 * @param {number} opts.originCellZ
 * @param {object} [opts.params]     overrides on STREET_DEFAULTS
 * @param {THREE.Texture} [opts.reflectionTexture] the car-reflection target.
 *   Its identity CHANGES every frame (the pass is double-buffered), so the
 *   material keeps a `.sample()`-form node the caller re-points — see
 *   `setReflection`. Null builds the street with no reflection code at all.
 */
export function createCityStreets({
  P, originCellX, originCellZ, params: overrides = {}, reflectionTexture = null,
}) {
  const S = { ...STREET_DEFAULTS, ...overrides };

  const pitch = (P.blockLots + P.streetLots) * P.lotSize;
  const blockW = P.blockLots * P.lotSize;
  const streetW = Math.max(P.streetLots * P.lotSize, 1);

  const uPitch = uniform(pitch);
  const uBlockW = uniform(blockW);
  const uStreetW = uniform(streetW);
  const uOrigin = uniform(new THREE.Vector2(originCellX * P.lotSize, originCellZ * P.lotSize));
  const uGroundY = uniform(P.groundY);

  const u = {};
  for (const [k, v] of Object.entries(S)) {
    if (typeof v === "number") u[k] = uniform(isStreetColorKey(k) ? new THREE.Color(v) : v);
  }

  /**
   * The mirror's own state — not authored, so not in STREET_DEFAULTS: a saved
   * track must not be able to pin where the car happened to be standing.
   */
  const rf = {
    /** biasMatrix · virtualCamera.projection · virtualCamera.viewInverse. */
    reflectMatrix: uniform(new THREE.Matrix4()),
    /** World-space contact point the distance fade is measured from. */
    reflectCenter: uniform(new THREE.Vector3()),
    /** The mirror plane's normal. */
    reflectNormal: uniform(new THREE.Vector3(0, 1, 0)),
    /** 0 whenever the pass did not run, so the street fades out rather than
     *  projecting a frozen frame — the mistake that made "reflection off" look
     *  like it did nothing on the road. */
    reflectOn: uniform(0),
  };

  /**
   * ONE texture node, in `.sample()` form rather than `texture(t, uv)`.
   *
   * The reflection target is double-buffered — the street cannot sample a
   * texture the mirror pass is writing in the same WebGPU sync scope — so the
   * texture this material must read CHANGES IDENTITY every frame.
   * `texture(t, uv)` bakes `t` in at build time; this form keeps `.value`
   * assignable, which is what lets `setReflection` follow the ping-pong.
   */
  const reflectTex = reflectionTexture ? texture(reflectionTexture) : null;

  /** The same gases the facades are lit by, so a frontage and its pool agree. */
  const uNeonPal = uniformArray(NEON_PALETTE.map((hex) => new THREE.Color(hex)));

  // ── Pure builders. No `If`, no derivatives — safe to call from every slot,
  // including normalNode's sub-build, which cannot read another slot's vars.

  /** Where we are on the block grid. */
  function layout() {
    const local = positionWorld.xz.sub(uOrigin);
    const fx = mod(local.x, uPitch).toVar();
    const fz = mod(local.y, uPitch).toVar();
    const inStreetX = step(uBlockW, fx).toVar();   // a street running along Z
    const inStreetZ = step(uBlockW, fz).toVar();   // a street running along X
    const su = fx.sub(uBlockW).toVar();            // across the along-Z street, 0..streetW
    const sv = fz.sub(uBlockW).toVar();
    const onRoad = max(inStreetX, inStreetZ).toVar();
    const junction = inStreetX.mul(inStreetZ).toVar();
    const dx = abs(fx.sub(uBlockW.mul(0.5)));
    const dz = abs(fz.sub(uBlockW.mul(0.5)));
    const intoBlock = uBlockW.mul(0.5).sub(max(dx, dz)).toVar();
    // The across-street coordinate, whichever way this street runs; at a
    // junction the along-Z street wins (either is fine, it is symmetric).
    const across = mix(sv, su, inStreetX).toVar();
    // Lateral in the track's convention: −1..1 across the carriageway.
    const lateral = across.div(uStreetW).mul(2.0).sub(1.0).toVar();
    // The four wheel paths: two lanes each side, tyres ~0.8 m off each lane
    // centre. Built as a triangle wave so it is one expression for all four.
    const laneU = fract(abs(lateral).mul(2.0));               // 0..1 across each lane
    const wheelPath = smoothstep(0.12, 0.28, abs(laneU.sub(0.5)))
      .mul(oneMinus(smoothstep(0.36, 0.48, abs(laneU.sub(0.5))))).mul(onRoad).toVar();
    return { fx, fz, inStreetX, inStreetZ, su, sv, onRoad, junction, intoBlock, across, lateral, wheelPath };
  }

  /** The kerb: rises over `kerbWidth` at the block edge, stays up on the walk. */
  const kerbHeightAt = (L) => smoothstep(float(0.0), u.kerbWidth, L.intoBlock).mul(u.kerbHeight);

  /**
   * THE WET FIELD — modularRoadWet.js `createWetField`, re-keyed. Returns
   * (film, pond). Crown drainage stands in for the track's camber/bank pair: a
   * city street sheds to both kerbs, so the pool term is |lateral|.
   */
  /**
   * The FILM channel alone — everything the wet model knows that does NOT need
   * the ponding fractal. Split out because the clearcoat's normal is a
   * sub-build: it cannot read the colour pass's variables, so it was rebuilding
   * the entire wet field, a second two-octave fractal per pixel, to recover two
   * scalars.
   */
  function wetFilmOnly(L) {
    const flat = smoothstep(0.45, 0.86, normalWorld.y);
    const clear = oneMinus(L.wheelPath.mul(u.wetWheelClear));
    const dose = mix(
      mix(float(0.0), u.kerbWet, smoothstep(u.walkWidth, u.walkWidth.mul(0.75), L.intoBlock)),
      float(1.0), L.onRoad,
    );
    return saturate(u.wetAmount.mul(flat).mul(clear).mul(dose));
  }

  function wetField(L) {
    const flat = smoothstep(0.45, 0.86, normalWorld.y);
    const pool = smoothstep(u.wetDrainStart, 1.0, abs(L.lateral).mul(u.wetCamber));
    const clear = oneMinus(L.wheelPath.mul(u.wetWheelClear));
    // Kerbs at `kerbWet`, the yard behind the pavement not at all (it drains).
    const dose = mix(mix(float(0.0), u.kerbWet, smoothstep(u.walkWidth, u.walkWidth.mul(0.75), L.intoBlock)), float(1.0), L.onRoad);
    const base = u.wetAmount.mul(flat).mul(clear).mul(dose);
    const film = saturate(base);
    // Ponding: world-space, elongated along the street's axis so puddles run
    // with the road the way water actually pools. 2 octaves, as the track.
    const pw = positionWorld.xz.mul(u.puddleScale);
    const along = mix(pw.x, pw.y, L.inStreetX);
    const acrossP = mix(pw.y, pw.x, L.inStreetX);
    const blob = vfbm(vec2(acrossP, along.div(u.puddleStreak))).add(0.5);
    const thr = u.puddleThreshold.sub(pool.mul(u.wetDrainStrength));
    const pond = smoothstep(thr, thr.add(u.puddleSoft), blob).mul(u.puddleAmount).mul(base);
    return { film, pond: saturate(pond) };
  }

  /**
   * LIGHT FROM THE NEAREST STREET LAMP, analytically. Lamps sit on the
   * pavement `lampInset` in from each kerb, every `lampPitch` metres along
   * the street, the two sides staggered. For this pixel: which street axis it
   * is on, the nearest lamp station along that axis on each side, the 3D
   * distance to each head, and an inverse-square pool with a smooth cut-off
   * at `lampRange`. Two lamps, ~30 ALU, no light objects. Returns 0..∞
   * irradiance (before colour).
   */
  function lampPool(L, opts = {}) {
    const alongZ = L.inStreetX;                         // 1: street runs along Z
    const along = mix(positionWorld.x, positionWorld.z, alongZ);
    const acrossM = L.across;                           // 0..streetW across the carriageway
    // How far BELOW the head this surface is. The road is at y=0 so it is the
    // full lamp height; a car roof or a tree crown is nearer the lamp and has
    // to be lit harder, or the street glows and everything standing on it
    // stays black — which is exactly what the first night looked like.
    const h = opts.free
      ? u.lampHeight.sub(positionWorld.y.sub(uGroundY)).max(0.6)
      : u.lampHeight;
    const pool = (station, sideAcross) => {
      const da = along.sub(station);
      const dx = acrossM.sub(sideAcross);
      const d2 = da.mul(da).add(dx.mul(dx)).add(h.mul(h));
      const cosT = h.div(d2.sqrt());                    // Lambert on a flat road
      const cut = smoothstep(u.lampRange, u.lampRange.mul(0.45), d2.sqrt());
      return cosT.mul(cut).div(d2).mul(u.lampHeight.mul(u.lampHeight));   // normalised so the value under the head is ~1
    };
    const st = along.div(u.lampPitch);
    const stA = floor(st.add(0.5)).mul(u.lampPitch);                      // side A: on-pitch
    const stB = floor(st.add(0.5).sub(u.lampStagger)).add(u.lampStagger).mul(u.lampPitch);   // side B: staggered
    const sideA = u.lampInset.negate();                 // just past the near kerb
    const sideB = uStreetW.add(u.lampInset);
    const both = pool(stA, sideA).add(pool(stB, sideB));
    // On the ground the pool only exists on the carriageway and the pavement.
    // For free-standing objects there is no such mask — a tree crown is above
    // the pavement whatever the shader thinks of the pixel under it.
    return opts.free ? both : both.mul(L.onRoad.max(smoothstep(u.walkWidth, u.walkWidth.mul(0.75), L.intoBlock)));
  }

  /**
   * The lamp field as seen by anything STANDING on the street — cars, trees,
   * railings. Same stations, same falloff, same uniforms as the road's pools,
   * so a car is lit by the lamp whose pool it is parked in and the two can
   * never disagree. Handed to modularRoadCityFurniture through the city.
   */
  function lampPoolFree() {
    return lampPool(layout(), { free: true }).mul(u.lampIntensity).mul(u.nightAmount);
  }

  /**
   * The water surface's slope — modularRoadWet.js `wetBreakupSlope`. Three
   * directional cosines (their derivative is free), stretched along the
   * street, faded before they can beat against the pixel grid. `fadeIn` is the
   * fwidth term, taken by the caller at top level.
   */
  function rippleSlope(L, fadeIn) {
    const along = mix(positionWorld.x, positionWorld.z, L.inStreetX);
    const acrossW = mix(positionWorld.z, positionWorld.x, L.inStreetX);
    const a = along.div(u.rippleStretch).mul(u.rippleScale);
    const b = acrossW.mul(u.rippleScale);
    const WAVES = [[1.0, 0.35, 1.0, 1.0], [-0.6, 1.0, 1.73, 0.55], [0.25, -1.0, 2.91, 0.3]];
    let dha = float(0), dhb = float(0);
    for (const [dx, dy, f, amp] of WAVES) {
      const c = cos(a.mul(dx * f).add(b.mul(dy * f))).mul(amp * f);
      dha = dha.add(c.mul(dx));
      dhb = dhb.add(c.mul(dy));
    }
    const g = u.rippleAmp.mul(fadeIn);
    return vec2(dha.mul(g), dhb.mul(g));
  }

  // Shared with roughness / clearcoat slots — all one flow (normalNode and
  // clearcoatNormalNode are sub-builds and recompute what they need).
  const R = {};

  const colorNode = Fn(() => {
    const L = layout();
    // ── Every derivative, at top level ──────────────────────────────────────
    const pxU = fwidth(L.across).toVar();                 // metres per pixel across the street
    const pxX = fwidth(positionWorld.x).toVar(), pxZ = fwidth(positionWorld.z).toVar();
    const texelAgg = max(pxX, pxZ).mul(u.aggScale).toVar();
    const dist = length(positionWorld.sub(cameraPosition)).toVar();
    const detail = smoothstep(u.detailFar, u.detailNear, dist).toVar();

    // ── ASPHALT TONE: the track's macro + aggregate ─────────────────────────
    // 2D, on the XZ plane: the ground is flat, so a 3D field spends a whole
    // dimension producing a constant.
    const macro = vfbm3(positionWorld.xz.mul(u.macroScale)).add(0.5).toVar();
    const aggFade = saturate(oneMinus(texelAgg.mul(2.0))).toVar();
    const agg = float(0.5).toVar();
    const patch = float(0.0).toVar();
    const seam = float(0.0).toVar();
    const worn = float(1.0).toVar();
    If(detail.greaterThan(0.001), () => {
      agg.assign(vnoise(positionWorld.xz.mul(u.aggScale)).mul(aggFade).add(0.5));
      // RESURFACING PATCHES — a jittered cell grid of rectangles, each with a
      // seam of sealant round it. See the note on `patchAmount`.
      const pc = positionWorld.xz.div(u.patchScale);
      const pcell = floor(pc), fpc = fract(pc);
      const on = step(ihash2(pcell), u.patchChance);
      // A per-cell inset, so no two patches are the same size or aligned.
      const ix = ihash2(pcell.add(vec2(31.0, 17.0))).mul(0.18).add(0.08);
      const iz = ihash2(pcell.add(vec2(-13.0, 41.0))).mul(0.18).add(0.08);
      const aaP = max(pxX, pxZ).div(u.patchScale).add(1e-4);
      const inside = band(fpc.x, ix, float(1.0).sub(ix), aaP)
        .mul(band(fpc.y, iz, float(1.0).sub(iz), aaP));
      const sw = u.patchSeamWidth.div(u.patchScale);
      const outer = band(fpc.x, ix.sub(sw), float(1.0).sub(ix).add(sw), aaP)
        .mul(band(fpc.y, iz.sub(sw), float(1.0).sub(iz).add(sw), aaP));
      patch.assign(inside.mul(on).mul(u.patchAmount).mul(L.onRoad).mul(detail));
      seam.assign(outer.sub(inside).max(0.0).mul(on).mul(u.patchAmount).mul(L.onRoad).mul(detail));
      worn.assign(smoothstep(float(-0.25), float(0.2),
        vnoise(positionWorld.xz.mul(0.7))).mul(0.55).add(0.35));
    });
    const tone = macro.mul(oneMinus(u.aggWeight)).add(agg.mul(u.aggWeight));
    const shaped = saturate(tone.sub(0.5).mul(u.grainScale).add(0.5));
    let deck = mix(u.asphaltDark, u.asphaltLight, shaped);
    deck = deck.mul(oneMinus(L.wheelPath.mul(u.wheelDarken)));
    // A patch is FRESHER asphalt — darker and less bleached — and its seam is
    // sealant, darker still. Both replace the surface rather than shade it.
    deck = deck.mul(oneMinus(patch.mul(u.patchDarken))).mul(oneMinus(seam.mul(u.patchSeam)));
    deck = deck.mul(u.deckBrightness);

    // ── PAVEMENT ────────────────────────────────────────────────────────────
    const aaSlab = max(pxX, pxZ).div(u.slabSize);
    const joint = max(gridLine(positionWorld.x, u.slabSize, float(0.02), aaSlab),
      gridLine(positionWorld.z, u.slabSize, float(0.02), aaSlab)).mul(detail);
    const walkTone = macro.sub(0.5).mul(0.14);
    const walk = u.walkColor.mul(float(1.0).add(walkTone).sub(joint.mul(0.16)));
    const onWalk = smoothstep(u.walkWidth, u.walkWidth.mul(0.75), L.intoBlock);
    const yard = u.yardColor.mul(float(1.0).add(walkTone.mul(1.6)));
    const onKerb = smoothstep(u.kerbWidth.mul(1.35), u.kerbWidth.mul(0.5), L.intoBlock).mul(step(float(0.0), L.intoBlock));
    const walkCol = mix(mix(yard, walk, onWalk), u.kerbColor, onKerb);

    // ── THE WET MODEL (modularRoadWet.js createWetShading) ──────────────────
    const W = wetField(L);
    const film = W.film.toVar(), pond = W.pond.toVar();
    const coat = saturate(max(film.mul(u.wetCoatStrength), pond)).toVar();
    const waterline = pow(saturate(pond.mul(oneMinus(pond)).mul(4.0)), u.waterlineSharp);
    const albedoScale = mix(float(1), u.wetDarken, film).mul(mix(float(1), u.puddleDarken, pond))
      .mul(oneMinus(waterline.mul(u.waterlineDark)));
    const tint = mix(vec3(1, 1, 1), u.wetTint, film);
    // Water darkens what it lies on: road, kerb, walk — before the paint.
    let surface = mix(walkCol, deck, L.onRoad).mul(albedoScale).mul(tint);

    // ── PAINT, wetted on its own terms ──────────────────────────────────────
    const aaC = pxU.mul(0.75).add(0.002);
    const half = uStreetW.mul(0.5);
    const dashZ = step(fract(positionWorld.z.div(u.dashPeriod)), float(0.5));
    const dashX = step(fract(positionWorld.x.div(u.dashPeriod)), float(0.5));
    const centreV = lineAA(L.su.sub(half), u.centreWidth, aaC);
    const dividerV = max(lineAA(L.su.sub(uStreetW.mul(0.25)), u.laneWidth, aaC),
      lineAA(L.su.sub(uStreetW.mul(0.75)), u.laneWidth, aaC)).mul(dashZ);
    const laneV = max(centreV, dividerV).mul(L.inStreetX).mul(oneMinus(L.inStreetZ));
    const centreH = lineAA(L.sv.sub(half), u.centreWidth, aaC);
    const dividerH = max(lineAA(L.sv.sub(uStreetW.mul(0.25)), u.laneWidth, aaC),
      lineAA(L.sv.sub(uStreetW.mul(0.75)), u.laneWidth, aaC)).mul(dashX);
    const laneH = max(centreH, dividerH).mul(L.inStreetZ).mul(oneMinus(L.inStreetX));
    const aaCross = pxU.div(u.crossPitch).add(0.001);
    const nearEndZ = max(step(L.fz, u.crossInset), step(uBlockW.sub(u.crossInset), L.fz));
    const nearEndX = max(step(L.fx, u.crossInset), step(uBlockW.sub(u.crossInset), L.fx));
    const crossV = gridLine(L.su, u.crossPitch, u.crossWidth, aaCross).mul(L.inStreetX).mul(oneMinus(L.inStreetZ)).mul(nearEndZ);
    const crossH = gridLine(L.sv, u.crossPitch, u.crossWidth, aaCross).mul(L.inStreetZ).mul(oneMinus(L.inStreetX)).mul(nearEndX);
    const paint = max(max(laneV, laneH), max(crossV, crossH)).mul(detail).mul(worn).mul(u.markings)
      .mul(oneMinus(L.junction)).toVar();
    const lw = film.mul(u.lineWet);
    const lineCol = u.paintColor.mul(mix(float(1), u.wetDarken, lw)).mul(mix(vec3(1, 1, 1), u.wetTint, lw));
    surface = mix(surface, lineCol, paint);

    // ── What the other slots read ───────────────────────────────────────────
    // Fresh asphalt and its sealant seam are both glossier than the weathered
    // surface around them. Computed HERE rather than at the end because the
    // reflection below reads `coat` and `coatRough` — how wet and how smooth
    // is exactly what decides how much of a mirror this fragment is.
    const dryRough = mix(float(0.92), u.deckRough.sub(L.wheelPath.mul(u.wheelRough)).sub(paint.mul(0.2)), L.onRoad)
      .sub(patch.mul(0.10)).sub(seam.mul(0.22));
    R.rough = mix(dryRough, u.wetRough, film);
    R.coat = saturate(coat.mul(mix(float(1), u.lineCoat, paint))).toVar();
    R.coatRough = mix(mix(u.wetCoatRough, u.puddleCoatRough, pond), u.wetCoatRough.mul(u.lineCoatRough), paint).toVar();

    // ── STREET LIGHT POOLS, as emissive on the ground ───────────────────────
    // Emissive rather than a light because there are no lights: the pool is
    // the lamp's irradiance times the surface's own albedo, so a white line
    // shines and wet asphalt (albedo halved) does not — then the film's
    // mirror puts some of it back (`lampWetGain`), which is why a rain-slick
    // street glows under its lamps and a dry one only brightens.
    const lamp = lampPool(L).mul(u.lampIntensity).mul(u.nightAmount).toVar();
    // The Smart Road's asphalt is authored DARK (~0.03 linear — see the note on
    // asphaltDark), so albedo × lamp is nothing on the road and everything on
    // the paint: 20:1. Real sodium light on asphalt reads clearly, because
    // eyes and cameras compress it. Compress the pool's albedo the same way:
    // asphalt lands near 0.2, paint near 0.6, a 3:1 that looks like a street.
    const poolAlbedo = mix(surface, vec3(0.5), 0.35);
    R.lampEmissive = poolAlbedo.mul(lamp).mul(float(1.0).add(film.mul(u.lampWetGain))).mul(u.lampColor)
      .add(surface.mul(u.glowColor).mul(u.glowAmount).mul(u.nightAmount));

    // ── THE NEON WASH ───────────────────────────────────────────────────────
    // Strongest at the kerb and dying into the carriageway, coloured per BLOCK
    // so one frontage is magenta and the next is cyan rather than the whole
    // city sharing a tint. `intoBlock` is 0 at the block edge and negative out
    // in the road, so the falloff is measured on how far into the road we are.
    const blockCell = floor(positionWorld.xz.sub(uOrigin).div(uPitch)).toVar();
    const nh = ihash2(blockCell).toVar();
    const nIdx = floor(fract(nh.mul(53.7)).mul(NEON_PALETTE.length - 0.001));
    const neonCol = uNeonPal.element(uint(nIdx));
    // BOTH SIDES of the kerb. Written as max(-intoBlock, 0) this was zero
    // everywhere INSIDE the block, so the wash sat at full strength across the
    // whole block interior — a filled rectangle of colour per block, which from
    // altitude read as a glowing outline of every block in the city rather than
    // as light on a road. The light comes FROM the frontage: it peaks at the
    // building line and dies in both directions.
    const fromKerb = abs(L.intoBlock);
    const wash = oneMinus(smoothstep(float(0.0), u.neonSpillWidth, fromKerb))
      // Not at the junctions: there is no frontage on the corner of a crossing,
      // and without this the wash pooled in the middle of every intersection.
      .mul(oneMinus(L.junction))
      .mul(step(float(0.35), nh));           // only blocks that HAVE a frontage lit
    R.lampEmissive = R.lampEmissive.add(
      poolAlbedo.mul(neonCol).mul(wash).mul(u.neonSpill).mul(u.nightAmount)
        .mul(float(1.0).add(film.mul(u.neonWetGain))),
    );

    // ── THE CAR, MIRRORED IN THE WET STREET ─────────────────────────────────
    // EMISSIVE, like the road's: the image of a car must not Lambert-shade
    // with the asphalt it lands on, or it would brighten and dim with the sun,
    // which is precisely backwards for a reflection.
    if (reflectTex) {
      const clip = rf.reflectMatrix.mul(vec4(positionWorld, 1.0));
      const projUv = clip.xy.div(max(clip.w, float(1e-4)));

      // Break it up with the water's own surface — the SAME ripple the
      // clearcoat normal uses, so the reflection and the highlight sitting on
      // top of it agree. Without this it reads as a decal pasted on the road.
      const rFade = saturate(oneMinus(max(pxX, pxZ).mul(u.rippleScale).mul(5.82)));
      const reflUv = projUv.add(rippleSlope(L, rFade).mul(u.reflectDistort));

      // Three taps smeared vertically, and blurred to match the surface.
      // `.blur()` is a mip BIAS, so the hardware's own derivative LOD still
      // runs underneath: a rough film gets a rough mirror for free, which is
      // both correct and the right antialiasing for a thin bright source.
      const dy = R.coatRough.mul(u.reflectStretch);
      const tex = reflectTex.blur(saturate(R.coatRough.mul(u.reflectBlur)));
      const col = tex.sample(reflUv.add(vec2(0, dy.negate())))
        .add(tex.sample(reflUv).mul(2.0))
        .add(tex.sample(reflUv.add(vec2(0, dy)))).mul(0.25);

      // Near-nothing looking straight down, near-total at the grazing angle a
      // chase camera lives at.
      const fres = oneMinus(abs(normalView.z)).pow(u.reflectFresnel);
      // Valid only near the contact point and only ON the plane. When the car
      // is up on the sky track both of these are already zero, which is how
      // the street knows it has nothing to mirror.
      const toFrag = positionWorld.sub(rf.reflectCenter);
      const d = length(toFrag);
      const near = oneMinus(smoothstep(u.reflectFade.mul(0.45), u.reflectFade, d));
      const offPlane = abs(dot(toFrag, rf.reflectNormal));
      const onPlane = oneMinus(smoothstep(
        u.reflectPlaneTol.mul(0.35), u.reflectPlaneTol, offPlane,
      ));
      // ...and only inside the target. Off its edge there is no data, so it has
      // to go to zero rather than smear a stretched border pixel down the road.
      const e = reflUv.sub(0.5).abs().mul(2.0);
      const inside = oneMinus(smoothstep(0.86, 1.0, max(e.x, e.y)));
      // Kerbs and pavement take it at the same reduced dose the film does.
      const zone = mix(u.kerbWet, float(1.0), L.onRoad);

      R.lampEmissive = R.lampEmissive.add(col.rgb.mul(col.a)
        .mul(fres).mul(R.coat).mul(near).mul(onPlane).mul(inside).mul(zone)
        .mul(u.reflectStrength).mul(rf.reflectOn));
    }

    R.pond = pond;
    return surface;
  });

  const material = new THREE.MeshPhysicalNodeMaterial();
  material.name = "CityStreets";
  material.colorNode = colorNode();
  material.roughnessNode = Fn(() => R.rough)();
  material.metalnessNode = float(0.0);
  // THE WATER FILM: a clearcoat is the correct model, not an approximation — a
  // smooth dielectric lobe with its own normal over a rough substrate. three's
  // coat also darkens the base by the coat's Fresnel for free, a second
  // helping of the albedo drop that sells the whole effect.
  material.emissiveNode = Fn(() => R.lampEmissive)();
  material.clearcoatNode = Fn(() => R.coat)();
  material.clearcoatRoughnessNode = Fn(() => R.coatRough)();
  // Sub-builds: they cannot read the colour pass's vars, so each recomputes
  // the cheap field it needs.
  material.clearcoatNormalNode = Fn(() => {
    // Another sub-build, and it was rebuilding the ENTIRE wet field — a second
    // two-octave fractal per pixel — to recover two scalars. The full field
    // exists so the ALBEDO can tell a film from standing water; the ripple only
    // needs "how wet, roughly" for its gain and "is this deep" for its damping,
    // and the film channel answers both without the ponding fractal.
    const L = layout();
    const film = wetFilmOnly(L).toVar();
    const coat = saturate(film.mul(u.wetCoatStrength));
    const along = mix(positionWorld.x, positionWorld.z, L.inStreetX);
    const texel = max(fwidth(along), fwidth(mix(positionWorld.z, positionWorld.x, L.inStreetX))).toVar();
    const fade = saturate(oneMinus(texel.mul(u.rippleScale).mul(2.91 * 2.0)));
    // Standing water drowns the asphalt break-up — that contrast is what makes
    // a puddle read as a puddle rather than as more textured road.
    const slope = rippleSlope(L, fade).mul(oneMinus(film.mul(u.rippleDamp).mul(0.6)));
    return normalMap(packSlope(slope), vec2(coat, coat));
  })();
  material.normalNode = Fn(() => {
    const L = layout();
    const dist = length(positionWorld.sub(cameraPosition));
    const detail = smoothstep(u.detailFar, u.detailNear, dist).toVar();
    // `.toVar()` is what pins these at top level: an un-materialised node is
    // emitted at its FIRST USE, which is inside the branch below — a derivative
    // in non-uniform control flow. The test caught exactly that.
    const pxX = fwidth(positionWorld.x).toVar(), pxZ = fwidth(positionWorld.z).toVar();
    const aggFade = saturate(oneMinus(max(pxX, pxZ).mul(u.aggScale).mul(2.0))).toVar();
    // THIS IS A SUB-BUILD: it cannot read the colour pass's variables, so
    // everything it wants it must recompute — which is exactly why it should
    // want as little as possible. It used to rebuild the whole three-octave
    // macro fractal purely to find the tar snakes for the bump, and throw all
    // of it away except a hairline. With the snakes gone the only relief left
    // is the aggregate and the kerb step: ONE cheap value-noise tap.
    const g = float(0.0).toVar();
    If(detail.greaterThan(0.001), () => {
      g.assign(vnoise(positionWorld.xz.mul(u.aggScale)).mul(aggFade));
    });
    const height = g.mul(u.gritRelief).mul(detail).mul(L.onRoad).add(kerbHeightAt(L));
    return bumpNormal(height);
  })();

  // ── LAMP POSTS ─────────────────────────────────────────────────────────────
  // The same grid the shader uses, walked once on the CPU: a post at every
  // station on both kerbs of every street inside the extent. A pole (a thin
  // box) and a head (a flatter box) merged into one 24-triangle geometry, one
  // InstancedMesh, one draw; the head is emissive into the bloom MRT so the
  // sources read as sources at night.
  const lampGeo = (() => {
    const pole = new THREE.BoxGeometry(0.22, S.lampHeight, 0.22);
    pole.translate(0, S.lampHeight / 2, 0);
    const head = new THREE.BoxGeometry(0.9, 0.22, 0.42);
    head.translate(0.32, S.lampHeight, 0);
    const g = new THREE.BufferGeometry();
    const merged = [pole, head];
    let pos = [], nrm = [], uvs = [], idx = [], base = 0;
    for (const m of merged) {
      const p = m.getAttribute("position"), n = m.getAttribute("normal"), t = m.getAttribute("uv");
      for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nrm.push(n.getX(i), n.getY(i), n.getZ(i)); uvs.push(t.getX(i), t.getY(i)); }
      const ix = m.getIndex();
      for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
      base += p.count;
      m.dispose();
    }
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    // Head faces are the ones at the top; the material lights them by height.
    g.computeBoundingSphere();
    return g;
  })();
  const lampMat = new THREE.MeshStandardNodeMaterial();
  lampMat.name = "CityLamps";
  lampMat.metalness = 0.6;
  lampMat.roughness = 0.5;
  lampMat.colorNode = vec3(0.16, 0.17, 0.18);
  // Only the underside of the head glows — the emitter — and only at night.
  const headGlow = Fn(() => {
    const y = positionWorld.y.sub(uGroundY);
    const isHead = smoothstep(S.lampHeight - 0.3, S.lampHeight - 0.05, y);
    return u.lampColor.mul(isHead).mul(u.nightAmount).mul(u.lampIntensity.mul(2.2));
  })();
  lampMat.emissiveNode = headGlow;
  applyBloomMRT(lampMat, vec4(headGlow, 1.0));

  const lampMatrices = [];
  {
    const half = P.extent;
    const per = pitch, bw = blockW, sw = streetW;
    const ox = originCellX * P.lotSize, oz = originCellZ * P.lotSize;
    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _pv = new THREE.Vector3(), _sv = new THREE.Vector3(1, 1, 1);
    const yaw = (deg) => _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg);
    const kMin = Math.floor((-half - ox) / per) - 1, kMax = Math.ceil((half - ox) / per) + 1;
    for (let kx = kMin; kx <= kMax; kx++) {
      for (let kz = kMin; kz <= kMax; kz++) {
        // Street running along Z, between block columns kx and kx+1.
        const sx0 = ox + kx * per + bw;          // street's −x kerb
        for (let side = 0; side < 2; side++) {
          const x = side === 0 ? sx0 - S.lampInset : sx0 + sw + S.lampInset;
          const stagger = side === 0 ? 0 : S.lampStagger * S.lampPitch;
          const z0 = oz + kz * per, z1 = z0 + bw;
          for (let z = Math.ceil((z0 - stagger) / S.lampPitch) * S.lampPitch + stagger; z < z1; z += S.lampPitch) {
            if (Math.abs(x - P.centerX) > half || Math.abs(z - P.centerZ) > half) continue;
            _pv.set(x, P.groundY, z);
            _m.compose(_pv, yaw(side === 0 ? 0 : Math.PI), _sv);
            lampMatrices.push(_m.clone());
          }
        }
        // Street running along X, between block rows kz and kz+1.
        const sz0 = oz + kz * per + bw;
        for (let side = 0; side < 2; side++) {
          const z = side === 0 ? sz0 - S.lampInset : sz0 + sw + S.lampInset;
          const stagger = side === 0 ? 0 : S.lampStagger * S.lampPitch;
          const x0 = ox + kx * per, x1 = x0 + bw;
          for (let x = Math.ceil((x0 - stagger) / S.lampPitch) * S.lampPitch + stagger; x < x1; x += S.lampPitch) {
            if (Math.abs(x - P.centerX) > half || Math.abs(z - P.centerZ) > half) continue;
            _pv.set(x, P.groundY, z);
            _m.compose(_pv, yaw(side === 0 ? Math.PI / 2 : -Math.PI / 2), _sv);
            lampMatrices.push(_m.clone());
          }
        }
      }
    }
  }
  const lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, Math.max(lampMatrices.length, 1));
  lampMesh.name = "CityLamps";
  lampMesh.count = lampMatrices.length;
  lampMatrices.forEach((m, i) => lampMesh.setMatrixAt(i, m));
  lampMesh.instanceMatrix.needsUpdate = true;
  lampMesh.frustumCulled = false;
  lampMesh.castShadow = false;
  lampMesh.receiveShadow = false;

  const geometry = new THREE.PlaneGeometry(P.extent * 2.6, P.extent * 2.6);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(P.centerX, P.groundY, P.centerZ);
  mesh.name = "CityStreets";
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  const params = new Proxy(S, {
    set(t, k, v) {
      t[k] = v;
      const un = u[k];
      if (un) { if (un.value && un.value.isColor) un.value.set(v); else un.value = v; }
      return true;
    },
  });

  return {
    mesh, material, params, uniforms: u,
    /** The lamp posts: one InstancedMesh, one draw. Add next to `mesh`. */
    lampMesh,
    /** Where the posts actually are — the obstacle table builds its capsules
     *  from these, so the thing you hit is the thing you can see. */
    lampMatrices,
    /** The lamp field for free-standing objects (see lampPoolFree). A node
     *  builder — call it inside the consumer's own material. */
    lampPoolFree,
    /** The lamp colour uniform, so a consumer tints by the same light. */
    lampColor: u.lampColor,
    /** Night, shared so a consumer fades with the same clock. */
    nightUniform: u.nightAmount,
    lampCount: lampMatrices.length,
    /** Same weather the track gets: 0 dry … 1 soaked. */
    setWet(amount) { u.wetAmount.value = Math.max(0, Math.min(1, amount || 0)); },
    /** 0 day … 1 night — the lamp pools and heads come on with it. */
    setNight(n) { u.nightAmount.value = Math.max(0, Math.min(1, n || 0)); },
    setOrigin(cellX, cellZ) { uOrigin.value.set(cellX * P.lotSize, cellZ * P.lotSize); },

    /** Whether this street was built able to reflect at all. */
    get canReflect() { return reflectTex !== null; },
    /**
     * Point the street at this frame's mirror. Hand it exactly what the road
     * deck gets — the same target, matrix, contact point and normal — because
     * when the car is ON the street they describe the same plane.
     *
     * `tex` must be the buffer the pass just WROTE (the ping-pong swaps every
     * frame); `on` false leaves the reflection off rather than showing a
     * frozen one.
     */
    setReflection(tex, matrix, center, normal, on = true) {
      if (!reflectTex) return;
      if (tex) reflectTex.value = tex;
      if (matrix) rf.reflectMatrix.value.copy(matrix);
      if (center) rf.reflectCenter.value.copy(center);
      if (normal) rf.reflectNormal.value.copy(normal);
      rf.reflectOn.value = on && tex ? 1 : 0;
    },
    dispose() { geometry.dispose(); material.dispose(); lampGeo.dispose(); lampMat.dispose(); lampMesh.dispose(); },
  };
}
