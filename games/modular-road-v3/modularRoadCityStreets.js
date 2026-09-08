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
  normalView, normalWorld, cameraPosition, fwidth, length, normalMap, positionGeometry,
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
  /*
   * LIGHTER AND FINER THAN THE TRACK, on purpose — this is the first place the
   * city deliberately DIVERGES in value from modularRoadMaterial's ROAD_LOOK
   * rather than accidentally drifting from it.
   *
   * The track deck is a racing surface: dark, tight, wet-looking. A city street
   * is old, sun-bleached, salted and patched, and reads several stops lighter
   * and much busier — which is what a reference photo of a real crossing shows.
   * The shading MODEL stays identical; only these numbers move.
   */
  asphaltDark: 0x2b2f34,
  asphaltLight: 0x6a7076,
  deckBrightness: 1.0,
  /** Symmetric contrast about the tone's midpoint. */
  grainScale: 1.0,
  /**
   * ANISOTROPY, and the reason this street used to read as grey plastic.
   *
   * The track deck has carried `streak: 14` since the material was written, and
   * modularRoadMaterial.js says why in as many words: it is "the single thing
   * that separates road from gravel", because asphalt is laid in strips by a
   * paver and then worn, polished and rain-streaked ALONG the direction of
   * travel. Sampling along and across at the same frequency "is isotropic by
   * construction and reads as marble or shingle no matter how it is tuned".
   *
   * This file lifted the track's tone model term for term — the tone values are
   * still identical, checked live — but it sampled `positionWorld.xz` flat, so
   * every field it inherited came out as round blobs. It got the recipe and
   * missed the one term that makes the recipe look like a road.
   *
   * The street knows its own direction already (`layout().inStreetX`, which the
   * wet ripple has always used to stretch itself), so this costs one mix pair.
   * At a junction the along-Z street wins, exactly as `across` already does.
   * 1 restores the old isotropic fields.
   */
  streak: 14,
  /** World-space macro tone: resurfacing patches, bleaching, old repairs.
   *  Cycles per metre ACROSS the street; along it, `streak`× longer. */
  macroScale: 0.06,
  /** Chip aggregate, cycles per metre (5 ⇒ ~20 cm chips), and its weight
   *  against the macro layer. */
  /** 7.5 ⇒ ~13 cm chips: finer and denser than the track's 20 cm, which is
   *  what makes a city street read as busy grit rather than as smooth tarmac. */
  aggScale: 7.5,
  /** More of the tone comes from the chips than on the track (0.4). With the
   *  aggregate finally reaching the albedo at all (see `texelAgg`), this is the
   *  difference between "a road with stones in it" and a grey field. */
  aggWeight: 0.55,

  /* ── CELLULAR CHIPS ───────────────────────────────────────────────────────
   * Ported from modularRoadSurfaceV2's opt-in chip mode, which is `chipsOn: 0`
   * on the track only because it is a candidate in the A/B lab there. In the
   * city it is the default, because it is the one term that gives the asphalt
   * daylight texture — see the note at the call site.
   *
   * A BUILD-TIME gate, like the track's: at 0 the worley is not in the compiled
   * shader at all and the old value-noise aggregate is, rather than a cellular
   * field multiplied away.
   */
  chipsOn: 1,
  /*
   * ── THE CHECKPOINT RING, PAINTED BY THE ROAD ITSELF ─────────────────────
   *
   * `markerOn` is a BUILD-TIME gate, like `chipsOn`: at 0 the term is not in
   * the shader at all, so turning the whole checkpoint feature off costs
   * exactly nothing rather than costing a multiply by zero. At 1 it is about
   * ten ALU on a material that already runs.
   *
   * A ring drawn HERE rather than as geometry is the cheapest marker there
   * is — no mesh, no draw call, no transform — and it is the only one that is
   * safely OPAQUE. The obvious marker is a translucent cylinder, and r184
   * blends only the `output` MRT attachment: a transparent column standing in
   * a city street would erase the emissive buffer behind it and punch a hole
   * in the bloom of every lit window it covered.
   */
  markerOn: 1,
  /** Ring radius and band thickness, metres. */
  markerRadius: 7.0,
  markerBand: 1.1,
  /** Live: where it is, and how strongly it shows. Both driven per frame by
   *  the checkpoint run; `markerAmt` at 0 is no ring anywhere. */
  markerX: 0,
  markerZ: 0,
  markerAmt: 0,
  markerColor: 0x35ff9a,
  /**
   * Cycles per metre ACROSS. 24 ⇒ ~4 cm stones.
   *
   * Finer than modularRoadSurfaceV2's 14, and the difference is the camera, not
   * the asphalt: the track's number was chosen against a chase boom 8.2 m up,
   * while a city street is read from a car window a metre and a half off the
   * ground. At 14 the stones came out as cobbles from there. Real dense-graded
   * asphalt is 8-14 mm; 24 is as fine as this holds against the pixel footprint
   * before the band limit below starts eating it.
   */
  chipScale: 24,
  /** How far each stone's centre wanders inside its cell. 1 = fully irregular,
   *  0 = a lattice, which reads instantly as procedural. */
  chipJitter: 0.9,
  /** Stone edge hardness. Higher = a crisper rim between stone and binder. */
  chipSharp: 0.30,
  /** How far individual stones vary in tone from each other. This is what
   *  stops the field looking like one stone stamped repeatedly. */
  chipVary: 0.30,
  /** How much darker the binder between the stones is than the stones. */
  binderDepth: 0.38,
  /** Mild stretch along the street — a paver does elongate the mix a little,
   *  but nothing like the 14:1 the macro tone uses. */
  chipStretch: 2.0,
  /** Band-limit rate for the chip field, on the across-street footprint. */
  chipFadeRate: 1.0,
  deckRough: 0.93,
  /** How much the tone fields modulate roughness. The track's own note: this is
   *  what makes a deck read as a surface rather than as a flat colour. */
  roughVary: 0.10,
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
  /**
   * The CENTRE line's own colour — yellow, because it divides opposing traffic
   * and almost every road authority marks that differently from the white lane
   * dividers either side of it.
   *
   * Warm and slightly dirty rather than a saturated primary: road yellow is a
   * thermoplastic that greys off within a season, and a pure #ffff00 down the
   * middle of a street reads as a decal. Set it to `paintColor` and every
   * marking goes back to one colour.
   */
  centreColor: 0xe0b53a,
  centreWidth: 0.12,
  laneWidth: 0.10,
  dashPeriod: 7.0,
  crossPitch: 1.2,
  crossWidth: 0.38,
  crossInset: 5.0,
  /** Gap between the crossing and where the lane markings resume, metres.
   *  Real junctions leave the approach clear; markings running into the zebra
   *  is the tell that they were drawn by a grid rather than by a road crew. */
  laneClear: 1.6,
  /** Stop lines on / off, and their shape. `stopOffset` is how far outside the
   *  crossing band the bar sits; `stopWidth` is the bar itself, and 0.35 m is
   *  what a real one measures. */
  stopLines: 1,
  stopOffset: 0.9,
  stopWidth: 0.35,
  /** Lane arrows on the approach. `arrowAt` is where the TIP sits, in metres
   *  from the junction — far enough past the stop line to be read from a car,
   *  not so far it lands mid-block. Head and stem are metres. */
  arrows: 1,
  arrowAt: 9.5,
  arrowHead: 1.6,
  arrowHeadW: 1.15,
  arrowStem: 2.6,
  arrowStemW: 0.32,
  markings: 1.0,
  /** Paint under water: it darkens FAR less than open aggregate (`lineWet`)
   *  but it is the wettest-LOOKING thing on the road (`lineCoat`), and the
   *  film over it is smoother than over chips (`lineCoatRough`). */
  lineWet: 0.35,
  lineCoat: 1.4,
  lineCoatRough: 0.5,

  /* ── WEAR ─────────────────────────────────────────────────────────────────
   * How the markings come off. See the long note at the paint site for what
   * this replaced and why one noise tap could never look right.
   */
  /**
   * Peak wear, on an old stretch, right in a wheel path. 0 = pristine paint.
   *
   * Over 1 on purpose — it multiplies the 0..1 age field before a saturate, so
   * values above 1 CLIP the older stretches to fully worn while leaving the
   * freshly painted ones untouched. That contrast between runs is most of the
   * effect; an early tuning used 0.85, which put every stretch at partial wear
   * and read as a uniform dirty tint rather than as paint in different states.
   */
  wearAmount: 2.0,
  /** How deep the tyres eat into a line's EDGE, as a FRACTION of that line's
   *  own half-width, at full wear. 0.38 ⇒ up to a third of the bar gone at the
   *  worst bite, which is about what the reference photo shows. */
  wearBite: 0.38,
  /** Finger frequency across the line, cycles/m. 22 ⇒ ~4.5 cm bites — fine
   *  chipping rather than a slow wobble along the edge. */
  wearFingerScale: 22,
  /**
   * ISOTROPIC — 1, not the asphalt tone's 14:1 and not the 1.8 this started at.
   *
   * A crossing bar runs ALONG the street, so any stretch in that direction
   * smears the finger field down the bar's own edge and the chipping becomes a
   * slow wobble — which is exactly how the first attempt read next to the
   * reference photo. Paint chips have no grain; the tyre does not care which
   * way the bar points. Leave it at 1.
   */
  wearFingerStretch: 1.0,
  /** Second octave, as a multiple of `wearFingerScale`. The spikes that ride
   *  on the coarse bites and stop the edge looking like a sine wave. */
  wearFingerOctave: 2.7,
  /**
   * The INTERIOR mottle, as a fraction of the edge model's strength.
   *
   * Kept low deliberately. Eroding a bar across its whole area is what the two
   * previous versions of this did and it is what made them look like a stain:
   * a worn crossing bar is solid white in the middle and eaten at the rim. This
   * is only here so the surviving paint is not a flat swatch.
   */
  wearInterior: 0.04,
  /** Fraction of that wear away from the wheel paths. Not zero — weather and
   *  grit take paint everywhere, just far more slowly than tyres do. */
  wearBase: 0.50,
  /** Aggregate height above which the paint has been abraded off. Higher
   *  leaves more paint (only the very proudest chips are bare). */
  wearLevel: 0.45,
  /** Edge softness of that threshold. SMALL on purpose: paint chips, it does
   *  not fade, and a wide edge is what made the old model read as a stain. */
  wearEdge: 0.07,
  /** Cycles per metre ACROSS for the repaint-age field; `streak` stretches it
   *  along, so 0.15 is ~7 m across and ~90 m runs down the street. */
  wearAgeScale: 0.15,
  /** How much of the wear mask comes from the FINER octave rather than the
   *  20 cm aggregate. The coarse field alone put only a handful of blobs on a
   *  38 cm crossing bar, which read as the bar being damaged rather than as
   *  paint being worn; the fine octave is what makes it look abraded. */
  wearFine: 0.65,
  /** Fine octave frequency, as a multiple of `aggScale`. 3.5 ⇒ ~6 cm. */
  wearFineScale: 3.5,
  /**
   * Crossing bite RELATIVE TO THE LANE LINES.
   *
   * Below 1, but not by much, and for a different reason than it was before.
   * The old area-wise model had to be turned right down on crossings because
   * eroding a wide slab across its area looked chewed; with the bite applied to
   * the EDGE that objection is gone — a zebra with fingered edges reads exactly
   * like the real thing. What remains is a genuine preference: lane lines are
   * thin, sit permanently under the tyre track, and are the marking you notice
   * from the car, so they keep the deeper bite.
   */
  crossWear: 0.85,

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
  /** The arm that reaches over the carriageway, and the lantern on its end.
   *  Shapes taken from v2/objects/roadLamp.js so the city lamp and the scenery
   *  prop are recognisably the same fitting. */
  lampArm: 1.9,
  lampPostTop: 0.09,
  lampPostBase: 0.15,
  lampHeadW: 0.80,
  lampHeadH: 0.18,
  lampHeadD: 0.38,
  /**
   * Metres from the camera a post is still DRAWN. The posts had no cull of
   * any kind — all 4262 every frame, most of them a kilometre off and under a
   * pixel — while the furniture beside them culled at 260-650 m. The light
   * POOLS are a shader term and unaffected; this is the geometry only.
   */
  lampDrawRange: 720,
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
  /**
   * Aggregate relief, in metres. WAS 0.003 and that was invisible — see
   * `chipRelief` for the measurement and for why the light, not the surface,
   * is what decides whether any of this shows.
   */
  gritRelief: 0.008,

  /* ── THE MID OCTAVE, and why the street had no relief you could see ────────
   *
   * The street's only relief was the 20 cm aggregate at `gritRelief`, and
   * modularRoadSurfaceV2.js already measured — with tools/roadBumpVisibilityTest
   * .mjs — that this is the WRONG BAND. Its finding, on the track deck and worth
   * repeating here because the geometry is the same: at FOV 60 over 1080 px the
   * chase camera's nearest deck fragment is 8.2 m away and its footprint there
   * is ~8 mm across, so the finest relief the player can resolve is roughly 3 cm
   * near and ~10 cm at middle distance. A 20 cm chip sits ABOVE that band and
   * reads as tonal variation rather than as texture; the 1.8 cm grit sits below
   * it and is correctly faded to zero everywhere on screen.
   *
   * There was simply no relief authored where the camera can see it. This
   * octave fills the gap, same as `bumpChip` does on the track.
   *
   * Cheaper here than on the track: `bumpNormal` is a surface-gradient bump, so
   * the height's screen derivative IS a per-pixel average — the tap-spreading
   * machinery V2 needed (`bumpFilter`) is inherent, and only the fade is ported.
   */
  /**
   * Amplitude in METRES — same units as `gritRelief` and `kerbHeight`.
   *
   * 14 mm, which is FAR more than the ~2 mm a real chip stands proud. That is
   * deliberate and it is worth knowing why, because the honest number looked
   * like nothing:
   *
   * WHETHER RELIEF SHOWS IS DECIDED BY THE LIGHT, NOT BY THE SURFACE. Diffuse
   * shading is N·L, and on a horizontal road under a high sun N·L sits at its
   * maximum — where its derivative with respect to normal tilt is ZERO. Tilting
   * a few degrees there changes the lit result by nothing at all, so no
   * physically-sized relief can read at noon, at any amplitude. Under the car's
   * headlights the same road is lit at ~79° off the normal, which is where that
   * derivative is at its LARGEST, and relief reads strongly.
   *
   * MEASURED by rebuilding the city at night with the headlights on: 2.2 mm was
   * indistinguishable from relief switched off entirely, 50 mm read as gravel,
   * and 14 mm is grain. So this is a value tuned for the one lighting condition
   * that can show it, and it costs nothing in the one that cannot.
   */
  chipRelief: 0.014,
  /**
   * Fade rate for the RELIEF specifically, on the across-street footprint.
   *
   * 2.0 is exactly Nyquist; below it on purpose, because `bumpNormal` takes a
   * screen derivative and so averages over a pixel instead of point-sampling —
   * the octave can run past Nyquist and degrade gently rather than cutting out.
   * 1.5 keeps the relief readable to roughly 40 m at this FOV.
   *
   * Note there is no `chipScale`/`chipStretch` here: the relief uses the SAME
   * ones the albedo chips do, because they are the same stones. Two sets
   * existed briefly and, being identically named, the second silently won —
   * which is why the chip field was running at 16 cycles/m and 3:1 rather than
   * the 14 and 2:1 it was authored for.
   */
  reliefFade: 1.5,
};

/** Every default that is a colour, for the uniform builder and the tests. */
export const isStreetColorKey = (k) => /Color$|^asphalt(Dark|Light)$|^wetTint$/.test(k);

/** Uniforms the GAME owns frame to frame — never written from `params`.
 *  See applyParams for what goes wrong if they are. */
const RUNTIME_UNIFORMS = new Set(["wetAmount", "nightAmount", "markerX", "markerZ", "markerAmt"]);

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

/**
 * 2D CELLULAR (Worley) on the same hash — THE CHIP FIELD.
 *
 * Value noise is a cloud: it has no scale you can read, which is exactly why
 * the aggregate above could sit at 5-7 cycles/m (a 20 cm "stone") for so long
 * without anyone being able to point at what was wrong. A cellular field states
 * its scale outright — you can see the individual stones and the binder between
 * them — and that is what makes asphalt read as a surface with stones IN it, in
 * plain daylight, where relief cannot help (see `chipRelief`).
 *
 * 2D, and on this file's own integer hash, for the reason in the note above:
 * `mx_worley_noise_float` is 3D, and the ground plane is flat, so a third of
 * every distance test would be computing a constant. Nine cells, two hashes
 * each for the feature point plus one for its tone.
 *
 * @returns vec2(distance to the nearest feature point, that cell's own 0..1 tone)
 */
const cellular = /*#__PURE__*/ Fn(([p, jitter]) => {
  const ip = floor(p).toVar();
  const fp = p.sub(ip).toVar();
  const best = float(8.0).toVar();
  const tone = float(0.5).toVar();
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const off = vec2(ox, oy);
      const cell = ip.add(off);
      // Two hashes for the feature point, jittered off the cell centre.
      const jx = ihash2(cell);
      const jy = ihash2(cell.add(vec2(37.0, 17.0)));
      const pt = off.add(vec2(jx, jy).sub(0.5).mul(jitter).add(0.5));
      const dv = pt.sub(fp);
      const d2 = dv.dot(dv);
      // Carry the winning cell's tone alongside the distance — one stone being
      // paler than its neighbour is most of what reads as aggregate.
      tone.assign(mix(tone, ihash2(cell.add(vec2(-11.0, 53.0))), step(d2, best)));
      best.assign(min(best, d2));
    }
  }
  return vec2(sqrt(best), tone);
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
  /**
   * World XZ, stretched along whichever way this street runs — the asphalt
   * fields' sampling coordinate. See `streak`.
   *
   * Same axis convention as rippleSlope below (`inStreetX` = 1 means a street
   * running along Z, so ALONG is z), so the tone and the water can never
   * disagree about which way the street points.
   *
   * The fwidth-based fades that guard these fields are left as they are: they
   * are taken from `max(pxX, pxZ)`, and the ACROSS axis — the one that keeps
   * the full frequency — is unchanged, so the existing term still bounds the
   * finer of the two directions. Dividing the along axis only ever makes the
   * field coarser, so the guard stays conservative rather than becoming wrong.
   */
  function streakedXZ(L, stretch = u.streak) {
    const along = mix(positionWorld.x, positionWorld.z, L.inStreetX);
    const acrossW = mix(positionWorld.z, positionWorld.x, L.inStreetX);
    return vec2(along.div(stretch), acrossW);
  }

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
    /*
     * BAND-LIMITED ON THE ACROSS-STREET FOOTPRINT — see the same fix in the
     * normal pass. `max(pxX, pxZ)` picks the along-VIEW axis on a surface seen
     * at a grazing angle, and that is already past 0.1 m a few metres out, so
     * `aggFade` collapsed and `agg` sat at a constant 0.5 over most of the
     * visible street. The aggregate this file believes it is drawing was
     * therefore absent from the albedo, from `roughVary`, and from the paint
     * wear that keys off it.
     *
     * Correct as well as necessary, and MORE correct since `streak`: the field
     * is now 14x lower frequency along the street than across it, so the across
     * axis is unambiguously the one that has to be band-limited. At 5 cycles/m
     * that fades in around 100 m, where a pixel spans half a chip.
     */
    const texelAgg = mix(pxZ, pxX, L.inStreetX).mul(u.aggScale).toVar();
    // The chip field's own band limit — it runs at `chipScale`, not `aggScale`.
    const chipAggFade = saturate(oneMinus(
      mix(pxZ, pxX, L.inStreetX).mul(u.chipScale).mul(2.0).mul(u.chipFadeRate),
    )).toVar();
    const dist = length(positionWorld.sub(cameraPosition)).toVar();
    const detail = smoothstep(u.detailFar, u.detailNear, dist).toVar();

    // ── ASPHALT TONE: the track's macro + aggregate ─────────────────────────
    // 2D, on the XZ plane: the ground is flat, so a 3D field spends a whole
    // dimension producing a constant.
    const sxz = streakedXZ(L).toVar();                    // street-aligned, see `streak`
    const macro = vfbm3(sxz.mul(u.macroScale)).add(0.5).toVar();
    const aggFade = saturate(oneMinus(texelAgg.mul(2.0))).toVar();
    const agg = float(0.5).toVar();
    const patch = float(0.0).toVar();
    const seam = float(0.0).toVar();
    // PAINT WEAR — see the WEAR block in STREET_DEFAULTS. Both default to
    // "intact paint" so that beyond the detail range the markings stay solid,
    // which is what the single blob-noise they replace also did.
    const wearTops = float(0.0).toVar();
    const wearAge = float(0.5).toVar();
    If(detail.greaterThan(0.001), () => {
      if (S.chipsOn) {
        /*
         * CELLULAR CHIPS — the daylight texture.
         *
         * This is the term that makes the street read like a photograph of a
         * road at noon, and it is albedo, not relief: individual stones, each a
         * slightly different tone, with darker binder between them. The smooth
         * value-noise aggregate it replaces could not do it at any amplitude,
         * because a cloud has no stones in it.
         *
         * `chipScale` 14 ⇒ ~7 cm. Real dense-graded asphalt is 8-14 mm, but a
         * procedural cannot hold that against the pixel footprint at any useful
         * distance — 14 is the same compromise modularRoadSurfaceV2 arrived at.
         */
        const cxz = streakedXZ(L, u.chipStretch);
        const cell = cellular(cxz.mul(u.chipScale), u.chipJitter).toVar();
        const edge = mix(float(0.85), float(0.28), u.chipSharp);
        const stone = oneMinus(smoothstep(edge.mul(0.35), edge, cell.x)).mul(chipAggFade).toVar();
        const vary = cell.y.sub(0.5).mul(u.chipVary);
        agg.assign(saturate(
          float(0.5).add(stone.sub(0.5).mul(u.binderDepth)).add(vary.mul(stone)),
        ));
      } else {
        agg.assign(vnoise(sxz.mul(u.aggScale)).mul(aggFade).add(0.5));
      }
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
      // Which chips are PROUD. Paint is sprayed onto the aggregate, so the
      // tyres take it off the tops first and it survives in the hollows — the
      // reason worn road paint is speckled at chip scale rather than faded.
      // TWO OCTAVES, not one. The 20 cm aggregate alone gave a mask whose
      // features were the size of the chips, which on a 38 cm crossing bar is
      // only a handful of blobs per bar — coarse enough to read as damage to
      // the BAR rather than as worn paint. The finer octave (`wearFineScale`x,
      // so ~6 cm) puts grain inside each of those, which is what makes it look
      // abraded instead of chewed.
      const fine = vnoise(sxz.mul(u.aggScale.mul(u.wearFineScale))).add(0.5);
      const maskField = mix(agg, fine, u.wearFine);
      wearTops.assign(smoothstep(u.wearLevel.sub(u.wearEdge), u.wearLevel.add(u.wearEdge), maskField));
      // How long since this stretch was repainted. Streaked, so it reads as
      // runs of newer and older paint down the street, not as blobs.
      wearAge.assign(vnoise(sxz.mul(u.wearAgeScale)).add(0.5));
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

    /*
     * ── PAINT WEAR: THE EDGE IS THE MODEL ────────────────────────────────────
     *
     * Look at a worn crossing and the bars are still SOLID WHITE in the middle.
     * What has gone is the perimeter: tyres bite in from the edge and leave a
     * ragged, fingered boundary a few centimetres deep, while the interior sits
     * there almost untouched. That shape is the whole read, and it is why the
     * previous two attempts here both looked wrong — they multiplied a mask
     * into the paint's ALPHA, which erodes a bar uniformly across its area and
     * gives a bar that has gone patchy and grey all over. No amount of tuning a
     * area-wise mask produces an eaten edge, because it is the wrong operator.
     *
     * So the erosion is applied to the line's WIDTH instead. `lineAA` and
     * `gridLine` both threshold a distance against a half-width, so subtracting
     * a per-fragment noise from that width moves the boundary inward by that
     * many metres — and because the noise varies along the edge, the boundary
     * comes out fingered exactly like the reference. It only ever eats INWARD:
     * paint does not grow, so the field is clamped at zero.
     *
     * The old interior speckle stays, but demoted to a garnish — a hint of
     * mottling inside the bar, an order of magnitude below what it was.
     *
     * Fields reused, no new concepts: `wheelPath` (where the tyres run),
     * `wearAge` (how long since this stretch was repainted), and one high
     * frequency tap for the fingers.
     */
    const scrub = mix(u.wearBase, float(1.0), L.wheelPath)
      .mul(saturate(wearAge.mul(u.wearAmount))).toVar();
    // Fingers, not smears: a MILD stretch, unlike the 14:1 the asphalt tone
    // uses. At 14 cycles/m across, the bites are ~7 cm — the scale a tyre
    // actually chips paint at, and the scale the reference shows.
    /*
     * TWO OCTAVES, and ISOTROPIC — see `wearFingerStretch` for why the stretch
     * had to go. One smooth octave gives a slow wobble down the edge; real
     * chipping has fine spikes riding on that, and the second octave at
     * `wearFingerOctave`x is what supplies them.
     */
    const _fxz = streakedXZ(L, u.wearFingerStretch);
    const finger = saturate(
      vnoise(_fxz.mul(u.wearFingerScale))
        .add(vnoise(_fxz.mul(u.wearFingerScale.mul(u.wearFingerOctave))).mul(0.5))
        .add(0.5),
    );
    // A FRACTION of each line's own width, not a fixed number of metres. The
    // first version bit a flat 4.5 cm, which is a quarter of a 12 cm lane line
    // but only 5% of a 38 cm crossing bar — so the lines frayed and the zebra
    // came out pristine. As a fraction, one number means the same visible
    // damage on both.
    const biteLane = finger.mul(scrub).mul(u.wearBite).toVar();
    const biteCross = biteLane.mul(u.crossWear).toVar();

    // ── PAINT, wetted on its own terms ──────────────────────────────────────
    const aaC = pxU.mul(0.75).add(0.002);
    const half = uStreetW.mul(0.5);
    const dashZ = step(fract(positionWorld.z.div(u.dashPeriod)), float(0.5));
    const dashX = step(fract(positionWorld.x.div(u.dashPeriod)), float(0.5));
    // Every width below is the authored width MINUS the bite, floored at zero
    // so a fully eaten stretch closes up rather than inverting.
    const centreW = u.centreWidth.mul(oneMinus(biteLane)).max(0.0).toVar();
    const laneW = u.laneWidth.mul(oneMinus(biteLane)).max(0.0).toVar();
    const crossW = u.crossWidth.mul(oneMinus(biteCross)).max(0.0).toVar();
    const centreV = lineAA(L.su.sub(half), centreW, aaC);
    const dividerV = max(lineAA(L.su.sub(uStreetW.mul(0.25)), laneW, aaC),
      lineAA(L.su.sub(uStreetW.mul(0.75)), laneW, aaC)).mul(dashZ);
    const onV = L.inStreetX.mul(oneMinus(L.inStreetZ));
    const onH = L.inStreetZ.mul(oneMinus(L.inStreetX));
    /*
     * HOW FAR IT IS TO THE NEXT JUNCTION, along whichever street this is.
     *
     * The block runs 0..blockW along a street's own axis with a junction at
     * each end, so the distance to the nearer one is min(f, blockW - f) on that
     * axis. Everything a junction needs to know about — where lane markings
     * have to stop, where the stop line goes — keys off this one value.
     */
    const endAlong = min(mix(L.fx, L.fz, L.inStreetX),
      uBlockW.sub(mix(L.fx, L.fz, L.inStreetX))).toVar();
    /*
     * LANE MARKINGS STOP SHORT OF THE CROSSING.
     *
     * They used to run the full length of the block and straight through the
     * zebra, which is wrong everywhere in the world: a centre line ends at the
     * stop line and the crossing is a clear field of bars. It was invisible
     * while every marking was the same off-white and became obvious the moment
     * the centre line went yellow — a yellow stripe crossing the walking bars.
     */
    const laneGate = smoothstep(u.crossInset.add(u.laneClear),
      u.crossInset.add(u.laneClear).add(0.35), endAlong);
    const laneV = max(centreV, dividerV).mul(onV).mul(laneGate);
    const centreH = lineAA(L.sv.sub(half), centreW, aaC);
    const dividerH = max(lineAA(L.sv.sub(uStreetW.mul(0.25)), laneW, aaC),
      lineAA(L.sv.sub(uStreetW.mul(0.75)), laneW, aaC)).mul(dashX);
    const laneH = max(centreH, dividerH).mul(onH).mul(laneGate);
    /*
     * THE CENTRE LINE, KEPT SEPARATE so it can be YELLOW.
     *
     * It is the one marking that means something different from the rest: a
     * centre line divides OPPOSING traffic, which is why most of the world
     * paints it in a different colour from the lane dividers beside it. Setting
     * `centreColor` equal to `paintColor` restores the single-colour look, so
     * this costs one mix and no decision.
     *
     * The mask is taken BEFORE wear and the other common multipliers: they
     * apply equally to every marking, so they cancel out of a ratio that only
     * decides WHICH COLOUR a covered pixel is. Where nothing is painted the
     * colour is not read at all.
     */
    const centreMask = max(centreV.mul(onV), centreH.mul(onH)).mul(laneGate);
    /*
     * THE STOP LINE — a solid bar across the approach, just outside the zebra.
     *
     * HALF THE CARRIAGEWAY, not the full width, and which half depends on which
     * end of the block it is: only the traffic APPROACHING a junction stops at
     * it, and the two directions stop at opposite ends. A bar spanning the whole
     * road would say both directions stop on the same line, which is the one
     * thing a stop line never means. The staggered pair is also the shape a
     * driver recognises without being told which way is which.
     */
    const atLowEnd = step(mix(L.fx, L.fz, L.inStreetX), uBlockW.mul(0.5));
    const rightHalf = step(float(0.0), L.lateral);
    const stopSide = mix(rightHalf, oneMinus(rightHalf), atLowEnd);
    const aaEnd = fwidth(endAlong).mul(0.75).add(0.002);
    const stopBar = lineAA(endAlong.sub(u.crossInset.add(u.stopOffset)), u.stopWidth.mul(0.5), aaEnd)
      .mul(L.onRoad).mul(stopSide).mul(u.stopLines);
    /*
     * LANE ARROWS — analytic, no texture.
     *
     * An arrow is a triangle on a rectangle, and both are exact in closed form:
     * the head's half-width is just a linear ramp along its own length, so the
     * whole glyph is two band tests and a compare. That is worth doing HERE
     * rather than sampling an atlas, because it costs no sampler, no texture
     * memory and no mip chain, and it is resolution-independent — the tip stays
     * sharp at any distance instead of going soft at the first mip.
     *
     * It does NOT generalise. A turn or U-turn glyph is a curve, and curves
     * analytically are far more ALU than they are worth on a shader that
     * already covers most of the screen — that is where a small marking atlas
     * earns its place, and where I would put one.
     *
     * Rides the same approach half as the stop line: an arrow tells you what
     * YOUR lane does, so it belongs only on the side approaching this junction.
     */
    const laneCell = uStreetW.mul(0.25);
    const laneMid = floor(L.across.div(laneCell)).add(0.5).mul(laneCell);
    const offLane = abs(L.across.sub(laneMid));
    // 0 at the tip, growing back down the arrow away from the junction.
    const at = endAlong.sub(u.arrowAt);
    const headHalf = u.arrowHeadW.mul(0.5).mul(saturate(at.div(u.arrowHead)));
    const arrowHead = band(at, float(0.0), u.arrowHead, aaEnd)
      .mul(smoothstep(headHalf.add(pxU), headHalf.sub(pxU), offLane));
    const arrowStem = band(at, u.arrowHead, u.arrowHead.add(u.arrowStem), aaEnd)
      .mul(smoothstep(u.arrowStemW.mul(0.5).add(pxU), u.arrowStemW.mul(0.5).sub(pxU), offLane));
    const arrow = max(arrowHead, arrowStem).mul(L.onRoad).mul(stopSide).mul(u.arrows);
    const aaCross = pxU.div(u.crossPitch).add(0.001);
    const nearEndZ = max(step(L.fz, u.crossInset), step(uBlockW.sub(u.crossInset), L.fz));
    const nearEndX = max(step(L.fx, u.crossInset), step(uBlockW.sub(u.crossInset), L.fx));
    const crossV = gridLine(L.su, u.crossPitch, crossW, aaCross).mul(L.inStreetX).mul(oneMinus(L.inStreetZ)).mul(nearEndZ);
    const crossH = gridLine(L.sv, u.crossPitch, crossW, aaCross).mul(L.inStreetZ).mul(oneMinus(L.inStreetX)).mul(nearEndX);
    // The garnish: a light interior mottle so the surviving paint is not a flat
    // swatch. `wearInterior` is what keeps it from becoming the old model again.
    const worn = saturate(oneMinus(wearTops.mul(scrub).mul(u.wearInterior)));
    const paint = max(max(max(laneV, laneH), max(crossV, crossH)), max(stopBar, arrow))
      .mul(worn).mul(detail).mul(u.markings).mul(oneMinus(L.junction)).toVar();
    const lw = film.mul(u.lineWet);
    // Yellow down the middle, white for everything else. Wet darkens and tints
    // both the same way — the water does not care what colour the paint is.
    const paintBase = mix(u.paintColor, u.centreColor, centreMask);
    const lineCol = paintBase.mul(mix(float(1), u.wetDarken, lw)).mul(mix(vec3(1, 1, 1), u.wetTint, lw));
    surface = mix(surface, lineCol, paint);

    // ── What the other slots read ───────────────────────────────────────────
    // Fresh asphalt and its sealant seam are both glossier than the weathered
    // surface around them. Computed HERE rather than at the end because the
    // reflection below reads `coat` and `coatRough` — how wet and how smooth
    // is exactly what decides how much of a mirror this fragment is.
    /*
     * GLOSS FOLLOWS THE VISIBLE AGGREGATE — modularRoadMaterial.js's roughVary,
     * which its own comment calls "what makes the deck read as a surface rather
     * than a flat colour". The street inherited the tone fields that drive it
     * but never fed them to the roughness slot, so every chip and every patch of
     * old surfacing had exactly the same specular response and the asphalt read
     * as one moulded sheet. Same weighting as the track: the macro drift at full
     * strength, the aggregate at half.
     */
    const roughN = macro.sub(0.5).mul(u.roughVary)
      .add(agg.sub(0.5).mul(u.roughVary).mul(0.5));
    const dryRough = mix(float(0.92), u.deckRough.add(roughN).sub(L.wheelPath.mul(u.wheelRough)).sub(paint.mul(0.2)), L.onRoad)
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

    /*
     * THE CHECKPOINT RING. One distance, two smoothsteps, added to the
     * emissive so it blooms and needs no transparency. Anti-aliased by the
     * band's own derivative rather than by a fixed width, or it strobes at
     * a grazing angle — the same reason every other line on this street is.
     */
    if (S.markerOn) {
      const d = length(positionWorld.xz.sub(vec2(u.markerX, u.markerZ)));
      const ring = smoothstep(u.markerBand, float(0.0), abs(d.sub(u.markerRadius)));
      // A soft fill inside it, so the target reads as a PLACE and not as a
      // hoop you might be looking at edge-on.
      const fill = smoothstep(u.markerRadius, u.markerRadius.mul(0.45), d).mul(0.22);
      R.lampEmissive = R.lampEmissive.add(
        u.markerColor.mul(ring.add(fill)).mul(u.markerAmt).mul(L.onRoad),
      );
    }

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
    /*
     * ALSO ON THE ACROSS-STREET FOOTPRINT — see chipFade below for the full
     * reasoning and the measurement. This one is a FIX, not a port: the
     * aggregate relief was gated by `max(pxX, pxZ)`, which at a grazing view
     * angle is the along-view axis and is already past 0.1 m a few metres out,
     * so `aggFade` sat at zero and the 20 cm relief this file believed it was
     * drawing never reached the shading anywhere the player looks. Raising
     * `gritRelief` 27-fold to 8 cm changed nothing on screen, which is what
     * proved it was a gate rather than a weighting.
     */
    const aggFade = saturate(oneMinus(mix(pxZ, pxX, L.inStreetX).mul(u.aggScale).mul(2.0))).toVar();
    // THIS IS A SUB-BUILD: it cannot read the colour pass's variables, so
    // everything it wants it must recompute — which is exactly why it should
    // want as little as possible. It used to rebuild the whole three-octave
    // macro fractal purely to find the tar snakes for the bump, and throw all
    // of it away except a hairline. With the snakes gone the relief is the
    // aggregate, the mid-band chip and the kerb step: TWO cheap noise taps.
    /*
     * FADED ON THE ACROSS-STREET FOOTPRINT, not on `max(pxX, pxZ)`.
     *
     * MEASURED: the first version used the max, copying the aggregate's fade,
     * and the octave was invisible — not subtle, absent. Raising the amplitude
     * eleven-fold to 25 mm changed nothing, which is what said it was a gate and
     * not a weighting. The ground is seen at a GRAZING angle, so the world
     * footprint along the view direction is enormous a few metres out (a pixel
     * spans centimetres across the street and tens of centimetres down it), and
     * the max picks that axis — so the fade sat at zero over almost the whole
     * visible street.
     *
     * The across-street axis is the well-sampled one, and it is the one carrying
     * the variation anyway (see `chipStretch`). This is the same conclusion
     * modularRoadSurfaceV2 reaches from the other direction: it spreads its two
     * taps independently so the along-road slope decays on its own, and lets the
     * fade run past Nyquist. `bumpNormal` gets that averaging for free — its
     * derivative IS the per-pixel difference — so the along axis needs no gate.
     */
    const acrossPx = mix(pxZ, pxX, L.inStreetX).toVar();
    const chipFade = saturate(oneMinus(acrossPx.mul(u.chipScale).mul(u.reliefFade))).toVar();
    const g = float(0.0).toVar();
    const chip = float(0.0).toVar();
    // Streaked like the colour pass's aggregate, or the relief would run across
    // the tone it is supposed to be the relief OF. See `streak`.
    const sxz = streakedXZ(L).toVar();
    // The relief takes the same milder stretch the albedo chips do — see
    // `chipStretch`. They are the same stones.
    const cxz = streakedXZ(L, u.chipStretch).toVar();
    If(detail.greaterThan(0.001), () => {
      g.assign(vnoise(sxz.mul(u.aggScale)).mul(aggFade));
      if (S.chipsOn) {
        /*
         * THE STONES ARE THE BUMPS. Sampling a smooth value noise at roughly
         * the chip frequency put relief NEAR the stones but not ON them — the
         * shading said "bumpy" while the albedo said "stones", and the two
         * disagreed about where every individual stone was. Same cellular field
         * as the colour pass, so a stone that looks paler is also the one
         * standing proud.
         */
        const cell = cellular(cxz.mul(u.chipScale), u.chipJitter);
        const edge = mix(float(0.85), float(0.28), u.chipSharp);
        chip.assign(oneMinus(smoothstep(edge.mul(0.35), edge, cell.x)).sub(0.5).mul(chipFade));
      } else {
        chip.assign(vnoise(cxz.mul(u.chipScale)).mul(chipFade));
      }
    });
    const height = g.mul(u.gritRelief).add(chip.mul(u.chipRelief))
      .mul(detail).mul(L.onRoad).add(kerbHeightAt(L));
    return bumpNormal(height);
  })();

  // ── LAMP POSTS ─────────────────────────────────────────────────────────────
  // The same grid the shader uses, walked once on the CPU: a post at every
  // station on both kerbs of every street inside the extent. A pole (a thin
  // box) and a head (a flatter box) merged into one 24-triangle geometry, one
  // InstancedMesh, one draw; the head is emissive into the bloom MRT so the
  // sources read as sources at night.
  /*
   * THE LAMP, shaped like v2/objects/roadLamp.js — a tapered post, an arm that
   * reaches out over the carriageway, and a sodium box on the end of it.
   *
   * What this replaces was two boxes with the "head" sitting 32 cm off the post,
   * which from the road read as a post with a lump on it rather than as a street
   * light: the whole silhouette of a street lamp is the ARM, and it was not
   * there. Built here rather than imported from the scenery prop because that
   * one returns a Mesh with its own two materials, and two materials is two
   * draws for 4262 lamps; this stays one geometry, one material, one draw.
   *
   * 24 -> 56 triangles, so ~240k for the whole city. The lamps were never the
   * cost and this does not make them one.
   *
   * The placement already yaws each lamp so local +X points at the road, which
   * is what makes an arm possible at all — see lampMatrices below.
   */
  const lampGeo = (() => {
    const H = S.lampHeight, armLen = S.lampArm;
    const pole = new THREE.CylinderGeometry(S.lampPostTop, S.lampPostBase, H, 8);
    pole.translate(0, H / 2, 0);
    const arm = new THREE.BoxGeometry(armLen, 0.12, 0.12);
    arm.translate(armLen / 2, H, 0);
    const head = new THREE.BoxGeometry(S.lampHeadW, S.lampHeadH, S.lampHeadD);
    // Slung UNDER the arm, which is both correct and what lets the shader find
    // it: the emitter is the only thing out at the arm's end and below it.
    head.translate(armLen, H - 0.14, 0);
    const g = new THREE.BufferGeometry();
    const merged = [pole, arm, head];
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
  /*
   * Only the HEAD glows, and it is found in GEOMETRY space rather than by world
   * height. Height alone used to be enough when the lamp was a post with a box
   * on top; with an arm there are now three things up there and two of them are
   * structure. `positionGeometry` is the raw attribute and survives instancing
   * (the same trick the parked cars use to find their own headlights), so the
   * test is "out at the end of the arm, and below it" — which is exactly and
   * only the lantern.
   */
  const headGlow = Fn(() => {
    const gx = positionGeometry.x, gy = positionGeometry.y;
    const outboard = step(S.lampArm * 0.55, gx);
    const underArm = smoothstep(S.lampHeight - 0.05, S.lampHeight - 0.12, gy);
    return u.lampColor.mul(outboard.mul(underArm)).mul(u.nightAmount).mul(u.lampIntensity.mul(2.2));
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
  /** Post positions, flat, for the cull below — the matrices stay the source. */
  const lampXZ = new Float32Array(lampMatrices.length * 2);
  lampMatrices.forEach((m, i) => { lampXZ[i * 2] = m.elements[12]; lampXZ[i * 2 + 1] = m.elements[14]; });
  /**
   * Range + frustum cull for the posts, on the city's LOD tick. Same shape as
   * the furniture's: partition near-and-in-view to the front, cut `count`.
   * The posts cast no shadow, so the frustum applies to all of them.
   */
  function applyLampLod(view) {
    const cam = view.pos;
    const r2 = S.lampDrawRange * S.lampDrawRange;
    const y = P.groundY + S.lampHeight * 0.5;
    let n = 0;
    for (let i = 0; i < lampMatrices.length; i++) {
      const x = lampXZ[i * 2], z = lampXZ[i * 2 + 1];
      const dx = x - cam.x, dz = z - cam.z;
      if (dx * dx + dz * dz >= r2) continue;
      if (!view.inView(x, y, z, S.lampHeight * 0.55)) continue;
      lampMesh.setMatrixAt(n++, lampMatrices[i]);
    }
    lampMesh.count = n;
    lampMesh.instanceMatrix.needsUpdate = true;
    lampMesh.visible = n > 0;
  }
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
    applyLampLod,
    /** The lamp field for free-standing objects (see lampPoolFree). A node
     *  builder — call it inside the consumer's own material. */
    lampPoolFree,
    /** The lamp colour uniform, so a consumer tints by the same light. */
    lampColor: u.lampColor,
    /** Night, shared so a consumer fades with the same clock. */
    nightUniform: u.nightAmount,
    lampCount: lampMatrices.length,
    /**
     * Push edited `params` into the live uniforms. NO REBUILD.
     *
     * Every numeric default became a uniform at build (see the loop that
     * creates `u`), so almost the whole look is tunable at a uniform write —
     * which is what makes a panel worth having here. A rebuild of this street
     * is ~7 s; a slider that cost that would never be dragged twice.
     *
     * TWO EXCLUSIONS, and both would be bugs rather than surprises:
     *
     *   wetAmount / nightAmount are RUNTIME state, not authored look. The game
     *   drives them from the weather and the clock through setWet/setNight,
     *   which write the uniform and deliberately leave `params` alone. Pushing
     *   params over them would snap a soaked city dry on the next slider drag.
     *
     *   `chipsOn` is a BUILD-TIME gate — a JS branch that decides whether the
     *   cellular field is in the compiled shader at all. Writing its uniform
     *   changes nothing; it needs the material rebuilt, and the caller is told
     *   so by the return value rather than left wondering.
     *
     * @param {object} [patch] merged into `params` first, if given
     * @returns {boolean} true when something changed that NEEDS a rebuild
     */
    applyParams(patch) {
      const before = S.chipsOn;
      if (patch) Object.assign(S, patch);
      for (const [k, v] of Object.entries(S)) {
        if (typeof v !== "number" || RUNTIME_UNIFORMS.has(k)) continue;
        const un = u[k];
        if (!un) continue;
        if (isStreetColorKey(k)) un.value.set(v);
        else un.value = v;
      }
      return S.chipsOn !== before;
    },
    /** Same weather the track gets: 0 dry … 1 soaked. */
    setWet(amount) { u.wetAmount.value = Math.max(0, Math.min(1, amount || 0)); },
    /** 0 day … 1 night — the lamp pools and heads come on with it. */
    setNight(n) { u.nightAmount.value = Math.max(0, Math.min(1, n || 0)); },
    /**
     * The checkpoint ring: where it is and how strongly it shows.
     *
     * Its own setter rather than a trip through `applyParams`, and for a
     * reason: the marker uniforms are in RUNTIME_UNIFORMS, which applyParams
     * deliberately SKIPS so the dev panel cannot clobber a value something
     * else drives per frame. That is the right rule and this is the exception
     * to it, so it gets a door of its own instead of a hole in the rule.
     *
     * Costs three uniform writes and is a no-op on the shader when `markerOn`
     * is 0 — the term is not compiled in at all.
     */
    setMarker(x, z, amount) {
      u.markerX.value = x;
      u.markerZ.value = z;
      u.markerAmt.value = Math.max(0, Math.min(1, amount || 0));
    },
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
