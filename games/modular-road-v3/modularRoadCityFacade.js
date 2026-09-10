// ============================================================================
// CITY FACADE — one material for every building, no per-instance attributes,
// and RELIEF WITHOUT GEOMETRY.
//
// ── WHAT WAS WRONG BEFORE, MEASURED AGAINST three's OWN CITY ─────────────────
//
// three's example (examples/jsm/generators/city/SkyscraperGenerator.js) builds
// every window as GEOMETRY: a frame with a hole, four reveal walls, the glass
// 12–22 cm back; every pier a stepped box projecting 30–60 cm; a spandrel band
// at each floor line; string courses; a two-step cornice; a base arcade
// extruded 1.1 m — and every tower casts shadows on a 4096 map. The depth you
// see in it is real: a pier throws a real shadow onto recessed glass.
//
// The first version of this file PAINTED all of that — a darker ring round a
// window, a lighter stripe for a pier — view-independent, unlit, unshadowed.
// It read as bathroom tiles, because a painted grid is what that is. And its
// values were inverted: dark walls, bright windows. A daytime masonry city is
// the opposite — BRIGHT STONE, DARK HOLES.
//
// ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────────
//
// The geometry stays a box. The facade is an ANALYTIC HEIGHT FIELD the
// fragment shader casts a ray into — closed form, not a marched parallax map,
// because the field is made of rectangles:
//
//     d = 0            pier / mullion fronts, string courses, cornice
//     d = pierDepth    the slot floor: spandrel and the flat window frame
//     d = +reveal      the glass, behind the four reveal walls
//
// From the pixel, the view ray is cast INTO the wall and tested against the
// slot's two pier flanks, the string course above or below, then the four
// reveal walls of the opening, then the pane. Each hit yields a position, a
// material AND A NORMAL (a flank is ±u, a sill is +y), so the scene's own sun
// and sky light the flanks and reveals for real.
//
// The SUN is cast the same way: a step of depth D shadows the surface behind
// it for D·|s_u|/s_d metres on its lee side. So a pier shadows the spandrel
// beside it, a window head shadows the glass below it, a string course
// shadows the wall under it — and those shadows ride `receivedShadowNode`, so
// they cut DIRECT light only and leave the sky fill alone, which is what a
// shadow physically is.
//
// ── THE ONE STRUCTURAL RULE THIS FILE OBEYS ──────────────────────────────────
//
// `material.normalNode` is always built in a SUB-BUILD (NodeMaterial.js:480),
// and NodeBuilder namespaces every var PER SUB-BUILD (`getSubBuildProperty(
// 'variable', … )`). A `.toVar()` written by the colour solve therefore comes
// back in normalNode as a FRESH variable holding only its initialiser — the
// assignments are statements that were already emitted into the colour flow.
// Silently, with no error. So:
//
//   • colour / roughness / emissive / ao share vars freely (one flow), and
//   • normalNode owns its own solve.
//
// To keep that from meaning "trace everything twice", the pipeline is split:
// `buildFrame` and `traceFacade` are PURE BUILDERS (plain functions, no `If`,
// select-chains only) that both slots call, and everything expensive — the
// interior room march, the brick hashing, the sky — happens only in the colour
// pass. The duplicated part is ~40 ALU of ray arithmetic.
//
// ── WHY NO PER-INSTANCE ATTRIBUTES ───────────────────────────────────────────
//
// They would lock the city to one batching backend (see modularRoadCity.js).
// Everything is derived from position instead:
//
//   WHICH BUILDING  the lot cell, floor(worldXZ / lotSize)
//   WHICH FACE      normalWorldGeometry — the PRE-bump normal. Reading
//                   normalWorld inside colorNode pulls normal computation
//                   into it and costs the glass its reflection.
//   WHERE ON A FACE the box's own UV. BoxGeometry gives every face 0..1 across
//                   and up; the face's size IN METRES falls out of the screen
//                   derivatives, d(world)/d(uv). That is what lets the bay grid
//                   put a pier at BOTH ends of every face, on every setback
//                   tier, without the shader ever knowing the footprint.
//
// ── THE LOT TEXTURE ──────────────────────────────────────────────────────────
//
// One float4 per lot cell, read with `textureLoad` (no sampler binding):
//   R base Y · G top Y · B district (0 glass/1 masonry/2 industrial)
//   A building type (0 punched / 1 curtain wall / 2 ribbon)
//
// ── ALIASING ─────────────────────────────────────────────────────────────────
//
// Every repeating pattern measures its own cells-per-pixel and dissolves to
// its mean: the relief switches off below `lodRelief`, the window grid melts
// between `lodSharp` and `lodFlat`, and the mortar uses the pristine-grid
// trick (the drawn joint never goes sub-pixel; its opacity fades to keep
// energy constant). A far tower converges to a flat tinted slab, which is
// what a far tower is.
// ── THE 208 `if`s ARE NOT THE PROBLEM. MEASURED, THEN ABANDONED ─────────────
//
// TSL's `select()` is not a conditional move: it emits a real WGSL `if / else`
// with a temporary either side, and this file generates 208 of them. The nine
// per-lot style picks alone — a choice between two uniforms each — compiled to
// EIGHTEEN nested branches at the top of every fragment. That looks like an
// obvious win, and it is not one.
//
// Converted `buildFrame` to branchless `mix(b, a, f32(cond))`: 208 -> 164
// branches, 4627 -> 4107 lines of generated WGSL. Then measured three ways,
// deck viewpoint, on an RTX 4050:
//
//   reload-interleaved, native res   A 2.260 ms   B 2.271 ms
//   reload-interleaved, 2x pixels    A 4.194      B 4.163
//   BOTH shaders in ONE page load,
//   swapped on the tower meshes      A 2.944      B 2.956   (spread +/-0.03)
//
// No difference at any resolution. The third method is the trustworthy one:
// reloading has an order effect worth ~0.3 ms (every first-of-round load
// reported exactly 2.687 ms whichever build was in it), which is twice the
// effect being looked for. The branches are coherent — every condition here is
// constant over a whole building — so the hardware was already taking one arm
// per warp, and removing them just moved work from the branch unit to the ALU.
//
// The conversion was reverted. If you are looking for tower time, look at what
// EVERY pixel does regardless of tier — the derivatives, the frame solve, the
// stone and glass paint — not at the branches around it.
//
// ============================================================================
import * as THREE from "three";
import {
  Fn, If, float, vec2, vec3, vec4, uniform, select, mix, smoothstep, max, min, abs,
  floor, ceil, round, fract, mod, dot, sin, pow, clamp, ivec2, uint, color, hash, uniformArray,
  positionWorld, positionView, normalWorldGeometry, normalView,
  cameraPosition, cameraNormalMatrix, uv, dFdx, dFdy, fwidth, step, textureLoad,
  normalize, reflect, sign, length, attribute,
} from "three/tsl";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

/** Lot texture edge, in cells. 160 × 34 m = 5.4 km of city per axis. */
export const LOT_TEX_SIZE = 160;

/** District ids written into the lot texture's B channel. */
export const DISTRICT = { glass: 0, masonry: 1, industrial: 2 };

/**
 * Building types, written into the lot texture's A channel. A DISTRICT is a
 * neighbourhood (palette, height); a TYPE is how the wall is built — the bay
 * rhythm and the depth of its relief, which is what you read at 300 m.
 */
export const BUILDING_TYPE = { punched: 0, curtain: 1, ribbon: 2 };
/** Suffix for the per-type material names, so a GPU capture is readable. */
const TYPE_NAME = ["Punched", "Curtain", "Ribbon"];

/**
 * three's NYC masonry palette, verbatim: limestone-dominant (the common tone
 * repeats, so an equal-probability pick still feels real), buff, granite, a
 * little terracotta. One flat pick per lot. This — not the six muddy greys it
 * replaces — is most of why the city stopped looking brown.
 */
/** The gases a real street is actually lit by — see `neonAmount`. */
export const NEON_PALETTE = [
  0xff2ea6, 0x25e0ff, 0xffd9a0, 0xff8a1f, 0x39ff8b, 0xff2d3a,
];

export const PALETTE = [
  0xa8553c, 0x9c4a34,                                 // terracotta / red brick (accent)
  0x8a6a52, 0x7d6450,                                 // brownstone
  0xc4a370, 0xb89a6f, 0xc2b183,                       // buff / tan
  0xc6c0b2, 0xc6c0b2, 0xbdb7a8, 0xd1ccbe, 0xb4afa1,   // limestone — the common default
  0x9a988f, 0x8b8983, 0xa5a39a,                       // granite / concrete
  0xdbd6cb,                                           // pale glazed (accent)
  0x7c868d,                                           // steel / glass (cool accent)
];

/**
 * A param whose NAME says it is a colour must become a THREE.Color uniform. As
 * a float, 0xc6c0b2 is thirteen million, and that once painted every wall in
 * the city blinding white. Exported so tools/cityKitTest.mjs asserts against
 * this exact predicate instead of a copy that can drift.
 */
export const isFacadeColorKey = (k) =>
  /Color$|^lit(Warm|Cool)$|^sky(Zenith|Horizon|Ground)$|^(wallTint|glassTint|dirtyGlassA|dirtyGlassB)$/.test(k);

/**
 * Facade defaults, metres and 0..1 fractions. Every number is a uniform, so
 * the lab drags any of it without a recompile.
 */
export const FACADE_DEFAULTS = {
  /** Storey height and its per-lot spread. Snapped per tier, so every tier is
   *  a whole number of floors and the cornice lands on a floor line. */
  floorHeight: 3.9,
  floorSpread: 0.6,
  /** Punched-wall bay pitch and spread — 1.9–4.0 m, like the example. Bays are
   *  then stretched to fill each face exactly, pier to pier. */
  bayWidth: 2.9,
  baySpread: 1.0,
  /** Pier width, its spread, and how far it PROJECTS. The projection is the
   *  whole point: the slot behind it is real depth the ray can enter. */
  pierWidth: 0.62,
  pierSpread: 0.24,
  pierDepth: 0.40,
  /** Window set-back behind the frame — the reveal the sun casts into. */
  reveal: 0.18,
  /** Glazed fraction of the floor height; the rest is the spandrel band. */
  windowRatio: 0.62,
  /** Flat dressed-stone frame band around the opening, at the slot floor. */
  frameBorder: 0.10,
  /** String courses: chance a tower has them and the band height. Pitch is
   *  3–8 floors, per lot. The tier-top cornice is the same band, 1.6× taller. */
  courseChance: 0.85,
  courseHeight: 0.7,
  /** The base: a deep colonnade on the ground tier of punched towers. */
  baseRecess: 0.9,
  baseWindow: 0.72,

  /** Lot pitch. MUST match the layout's lotSize. */
  lotSize: 34,
  /** World Y the city stands on when no lot texture has been written. */
  groundY: 0,

  /** Global grade over the palette (a warm/cool dial for the lab). */
  wallTint: 0xffffff,
  /** Curtain-wall mullions and spandrel panels — anodised metal, not stone. */
  mullionColor: 0x6b7076,
  roofColor: 0x3a3a3e,
  sootColor: 0x4a4236,
  /** Soot streaks pooling low on the walls, and the height they fade over. */
  soot: 0.35,
  sootHeight: 210,
  /** Street-level darkening — the canyon a real city sits in. */
  canyonHeight: 26,
  canyonAO: 0.16,

  /** Brick module (metres), joint width, and the bump height of a brick face. */
  brickL: 0.6,
  brickH: 0.3,
  mortar: 0.025,
  brickRelief: 0.008,

  wallRough: 0.85,
  /** Glass: smooth enough for a sky, soft enough not to alias over the room. */
  glassRough: 0.18,
  /** The soda-lime tint the room is seen through, the dirty-glass tones the
   *  grime pulls toward, and how dirty. The 0.64 baseline is the example's:
   *  panes must read as old glass, not open holes. Curtain walls are newer. */
  glassTint: 0xb6c6bf,
  dirtyGlassA: 0x13161a,
  dirtyGlassB: 0x232b31,
  glassGrime: 0.64,
  curtainGrime: 0.18,
  ribbonGrime: 0.34,
  /** The city's own share of the scene environment (see cityLab's AMBIENT). */
  envIntensity: 1.0,

  /** Analytic sky reflection: master scale, head-on reflectance per type
   *  (bare glass is 0.04 and invisible on a skyline; coated curtain wall is a
   *  mirror), reflected-sky gain, and the gradient — overwritten every frame
   *  from the sky module's own look, so it tracks time of day for free. */
  glassReflect: 1.0,
  glassReflectMin: 0.16,
  curtainReflectMin: 0.55,
  skyReflectGain: 0.9,

  /**
   * THE SUN IN THE GLASS.
   *
   * The glass already mirrors the sky, and a sky is a smooth gradient — which
   * mirrors to a smooth gradient, so the skyline read flat. What a real
   * curtain-wall city does is FLASH: one tower face lights up as you move past
   * it, then goes out and the next one takes over. That is the sun's own disc
   * in a mirror, and it is the single strongest "this is a real city" cue at
   * distance.
   *
   * It is a mirror lobe on the REFLECTED view ray, not a light: `pow(R·sun, k)`
   * with a large k. Cheap — a dot and a pow on pixels that are already doing a
   * reflect — and it lands in the EMISSIVE slot, so it goes through the bloom
   * MRT and blooms like a real specular highlight rather than just going white.
   *
   * Note it does not alias the way a tight lobe usually does: the normal is
   * constant across a flat face, so the term varies slowly in screen space and
   * whole faces light at once. That IS the effect — glass towers flash by the
   * face, not by the pixel.
   */
  /**
   * ── STREET-LEVEL NEON ─────────────────────────────────────────────────
   *
   * The Blade Runner read is not the giant billboards — it is shopfront neon
   * on the first two or three floors and a wet ground under it. The billboards
   * are the postcard; the neon is the city.
   *
   * It is PAINT, not geometry: a fascia band and the odd blade sign per bay,
   * keyed off the same per-lot hash everything else here uses. Zero draw calls,
   * and it lands in the emissive slot so it goes through the bloom MRT and
   * actually glows rather than just being a bright colour.
   *
   * Gated on height, because that is the whole point: a branch that skips the
   * work on every pixel above the third floor, which is nearly all of them on
   * a skyline.
   */
  neonAmount: 1.0,
  /**
   * Fraction of BUILDINGS with a lit frontage at all, then of BAYS within one.
   *
   * Two gates, not one, and the building gate is the important one. With only
   * the bay gate every building in the city had some neon on it, and from
   * altitude that read as a glowing grid tracing every block — a lit outline
   * of the street plan rather than a street. Real neon clusters: a parade of
   * lit frontages, then a stretch of dark offices.
   */
  neonBuildings: 0.26,
  neonFraction: 0.5,
  /** Metres above the building base for the fascia band, and its depth. */
  /** ── STREET LEVEL ──
   *  The bottom of a building is not the same thing as the rest of it, and
   *  it is the only part most players ever see up close. `shopfronts` at 0
   *  restores the old facade exactly — the branch simply paints nothing.
   *
   *  `shopUnit` is deliberately NOT the structural bay: a shop is about six
   *  metres wide whatever the windows above are doing, and shops that line
   *  up with the windows above them are the tell of a generated frontage. */
  shopfronts: 1,
  /** A doorway for every frontage that is NOT a parade or a lobby — which is
   *  most of them, and all of them were blank wall from pavement to roof.
   *  One per FACE: the shader does not know which face is the front, and a
   *  door on each is what a real corner block has anyway. */
  doorways: 1,
  doorW: 1.7,
  doorH: 2.6,
  doorFrame: 0.16,
  doorGlow: 0.75,
  /** How many eligible buildings get a parade at all. NOT most of them: a
   *  shopfront on every frontage in the city is wallpaper, not a street. */
  shopBuildings: 0.42,
  /** Above this a frontage belongs to whatever occupies the tower, not to
   *  the street — so shops stay a low-building thing. */
  shopMaxHeight: 52,
  /** A curtain-wall tower gets a LOBBY instead: glazed nearly to the soffit,
   *  no stallriser, no fascia, no awning, and a much wider mullion. */
  lobbySill: 0.20,
  lobbyMull: 2.4,
  shopHeight: 4.3,
  shopUnit: 6.2,
  shopPier: 0.55,
  shopStall: 0.55,
  shopFascia: 0.78,
  shopMull: 1.15,
  shopMullW: 0.09,
  /** Awnings on some of them, striped, hung under the fascia. */
  shopAwning: 0.36,
  shopAwningH: 0.55,
  shopStripe: 0.34,
  /** How many shops are open, and how hard the inside glows at night. */
  shopLitFraction: 0.74,
  shopGlow: 1.35,
  neonHeight: 4.0,
  neonThick: 0.40,
  /** A projecting blade sign above the fascia, on some bays. */
  neonBladeH: 2.6,
  neonBladeFraction: 0.42,
  /** Emissive gain. Bloom does the rest — and did rather too much of it. */
  neonBoost: 1.5,
  /** Neon by day is a tube with the lights on in daylight — visible, not gone. */
  /*
   * ZERO BY DAY, and that is the other half of why it looked wrong.
   *
   * A neon tube in daylight is a dark glass tube, not a bright colour — but
   * this has no unlit representation, so any daytime value paints a flat
   * coloured band with no glow behind it. At 0.16 that was a pink stripe on a
   * sunlit wall. Off by day, and it is a light again rather than paint.
   */
  neonDay: 0.0,

  sunGlint: 1.2,
  /**
   * Lobe tightness, and MEASURED rather than guessed — three guesses in a row
   * were wrong, all of them invisible.
   *
   * Sampling the visible glass faces from a street canyon, the distribution of
   * R.sun is: best face 0.996, p99 0.907, median 0.025. At 900 even the best
   * face in the city got 0.996^900 = 1.7%% of the glint, and A/B frames differed
   * by fewer pixels than two identical frames did — the term was strictly below
   * the animation noise.
   *
   * The deeper reason it has to be this wide: every building here is an
   * axis-aligned box, so the WHOLE CITY has four face orientations. A
   * physically tight lobe is then all-or-nothing — a face is within a couple of
   * degrees of alignment or it contributes exactly nothing, and usually none on
   * screen are. Real glass towers get away with a tight lobe because they have
   * varied plan angles, curved corners and panel bowing to scatter it.
   *
   * 20 is a ~11 degree lobe: broad enough that sun-facing glass takes a warm
   * sheen and individual panes catch it, which is what golden hour in a city
   * actually looks like. The principled upgrade, if this ever wants to SPARKLE
   * rather than glow, is a per-pane normal jitter off the window hash the
   * facade already computes — that scatters the lobe the way real oil-canning
   * does, and would let the exponent go back up.
   */
  sunGlintSharp: 20,
  skyZenith: 0x3f6fb0,
  skyHorizon: 0xc8d6e2,
  skyGround: 0x2a2c30,

  /** ── CURTAIN WALL (type 1) — big panes in a thin dark grid, nearly flush. */
  curtainBay: 3.6,
  curtainMullion: 0.16,
  curtainDepth: 0.07,
  curtainReveal: 0.04,
  curtainWinRatio: 0.84,
  /** ── RIBBON (type 2) — strip windows between deep concrete bands. */
  ribbonBay: 3.0,
  ribbonMullion: 0.10,
  ribbonDepth: 0.05,
  ribbonReveal: 0.22,
  ribbonWinRatio: 0.56,

  /** Interior mapping: 0 = flat glass, 1 = full rooms. Depth in metres. Rooms
   *  span 2–3 bays, picked per floor, so neighbours share an interior. */
  interior: 1.0,
  roomDepth: 4.5,
  /** Fraction of rooms with the curtains drawn. */
  curtains: 0.28,

  /** 0 = day, 1 = night. Drives the lit rooms; it is not a light. */
  nightAmount: 0,
  /** Fraction of rooms lit at night; each tower biases it. */
  litFraction: 0.28,
  litWarm: 0xffd9a0,
  litCool: 0xcfe4ff,
  /** Emissive gain of a lit room — the example's 4. */
  emissiveBoost: 4.0,
  /** How much of that glow shows by DAY (a lit office at noon is faint). */
  dayGlow: 0.02,
  /** Fraction of storeys wholly dark (vacant floors). */
  darkFloors: 0.22,
  /** Window churn: only `churnFraction` of rooms are on a timer AT ALL. People
   *  do not flick their lights every minute; the first version reseeded every
   *  window on one clock and the city twinkled like a screensaver. */
  churnPeriod: 420,
  churnFraction: 0.10,
  /** NIGHT SKYGLOW. A city is never black between its own lights: the light
   *  it throws up bounces off haze and off every other lit surface, and that
   *  is what stops an unlit wall going to pure black the moment the sun does.
   *  A flat ambient add on the albedo, scaled by night — an ambient light in
   *  everything but name, and confined to the city so it cannot wash out the
   *  terrain or the deck. */
  glowColor: 0x2a2f3a,
  glowAmount: 1.0,

  /** Crown lights: a lit band under the roofline of some towers at night. */
  crownFraction: 0.45,
  crownHeight: 1.6,
  crownBoost: 5.0,

  /** Relief master (0 = flat paint) and the analytic sun shadow. */
  relief: 1.0,
  reliefShadow: 1.0,
  /** Screen-space LOD in CELLS PER PIXEL: relief and rooms run below
   *  `lodRelief` (a bay ≥ ~12 px); the window grid dissolves between
   *  `lodSharp` and `lodFlat`. */
  lodRelief: 0.09,
  lodSharp: 0.50,
  lodFlat: 0.12,
};

/**
 * INTEGER HASHES, NOT `fract(sin(...))`.
 *
 * The classic sin-fract hash costs a transcendental per call, and this file
 * calls one for the lot identity, the room assignment, every lit-window state
 * and the churn clock. Counted in the generated WGSL: SIXTY-NINE `sin`s in one
 * fragment shader. three's own `hash()` is PCG — pure integer ops — so the
 * whole set moves to it for free, and gets BETTER: fract(sin()) loses its
 * precision at large arguments, which is exactly the bug that once made the
 * starfield invisible.
 *
 * The inputs are quantised to 1/256 before hashing. Everything hashed here is
 * a lot cell, a floor index or a small derived key, so that is far finer than
 * anything two distinct inputs are separated by. The offset keeps the value
 * non-negative (a negative float `toUint()` is undefined) and the result stays
 * under 2²⁴, so the float→uint conversion is exact.
 */
const qi = (v) => floor(v.mul(256.0)).add(1 << 22);
const ih2 = (a, b) => hash(
  uint(a).mul(uint(73856093)).bitXor(uint(b).mul(uint(19349663))),
);
const ih3 = (a, b, c) => hash(
  uint(a).mul(uint(73856093)).bitXor(uint(b).mul(uint(19349663))).bitXor(uint(c).mul(uint(83492791))),
);
/** 0..1 hash of a vec2 (lot cells, floor indices). */
const hash21 = /*#__PURE__*/ Fn(([p]) => ih2(qi(p.x), qi(p.y)));
/** 0..1 hash of a vec3 — lot cell + floor + room. */
const hash31 = /*#__PURE__*/ Fn(([p]) => ih3(qi(p.x), qi(p.y), qi(p.z)));
/** Integer-keyed hash of an ALREADY-INTEGER 2D cell (brick rows, noise corners). */
const ihash2 = (i) => ih2(i.x.add(1 << 16), i.y.add(1 << 16));
/** Cheap value noise, −0.5..0.5, integer-hashed so it is stable across drivers. */
const vnoise2 = /*#__PURE__*/ Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const w = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = ihash2(i), b = ihash2(i.add(vec2(1.0, 0.0)));
  const c = ihash2(i.add(vec2(0.0, 1.0))), d = ihash2(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y).sub(0.5);
});

/**
 * Surface-gradient bump (Mikkelsen), verbatim from the example. The built-in
 * bumpMap offsets the UV to read its height, so it returns a ZERO gradient for
 * a height keyed off position; this feeds the hardware screen derivatives of
 * the height into the view normal instead.
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

/** Anti-aliased "x is inside [lo, hi]", with a half-width `aa` edge. */
const band = (x, lo, hi, aa) =>
  smoothstep(lo.sub(aa), lo.add(aa), x).mul(smoothstep(hi.add(aa), hi.sub(aa), x));

/**
 * Build the city facade material.
 *
 * @param {object} [opts]
 * @param {object} [opts.params] overrides on FACADE_DEFAULTS
 */
export function createCityFacadeMaterial({ params: overrides = {}, typeSplit = true } = {}) {
  const P = { ...FACADE_DEFAULTS, ...overrides };

  // ── BUILDING TYPE AS A COMPILE-TIME CONSTANT ───────────────────────────────
  //
  // `btype` is a texture read, so punched / curtain / ribbon are RUNTIME values
  // and all three wall systems compile into ONE shader. Every pixel of every
  // building then carries the register pressure of two wall systems it is not,
  // and the driver compiles all three however few of them a given tower uses.
  //
  // But the type is known on the CPU — it is `b.btype`, a plain JS field, and
  // the lot texture is written FROM it — so the city can hand each InstancedMesh
  // a material built with `PIN` set. The helpers below then fold on a JS boolean
  // instead of emitting a `select`, and because the node system only generates
  // code for nodes REACHABLE FROM AN OUTPUT, a folded select does not merely
  // hide its dead branch behind a constant: nothing references that subtree any
  // more, so it is never emitted at all.
  //
  // `typeSplit: false` builds only the old combined material — the A/B, and
  // what the BatchedMesh backend has to use, since it has one material for
  // every building in the city.
  //
  /** `select` that folds when the condition has already been decided in JS. */
  const selT = (c, a, b) => (typeof c === "boolean" ? (c ? a : b) : select(c, a, b));
  /** AND over a mix of JS booleans and nodes. Returns a boolean or a node. */
  const andT = (a, b) => (a === false || b === false ? false
    : a === true ? b : b === true ? a : a.and(b));
  /** OR over a mix of JS booleans and nodes. */
  const orT = (a, b) => (a === true || b === true ? true
    : a === false ? b : b === false ? a : a.or(b));
  /** 1.0 / 0.0 from a flag that may already be decided. */
  const numT = (c) => (typeof c === "boolean" ? float(c ? 1 : 0) : float(c));
  /** NOT over a mix of JS booleans and nodes. */
  const notT = (a) => (typeof a === "boolean" ? !a : a.not());
  /** `.toVar()` that survives a flag having folded away to a JS boolean. */
  const varT = (c) => (typeof c === "boolean" ? c : c.toVar());

  // ── Lot texture ────────────────────────────────────────────────────────────
  const lotData = new Float32Array(LOT_TEX_SIZE * LOT_TEX_SIZE * 4);
  const lotTexture = new THREE.DataTexture(
    lotData, LOT_TEX_SIZE, LOT_TEX_SIZE, THREE.RGBAFormat, THREE.FloatType,
  );
  lotTexture.name = "CityLotHeights";
  lotTexture.magFilter = lotTexture.minFilter = THREE.NearestFilter;
  lotTexture.generateMipmaps = false;
  lotTexture.colorSpace = THREE.NoColorSpace;
  lotTexture.flipY = false;
  const uLotOrigin = uniform(new THREE.Vector2(0, 0));
  const uLotCount = uniform(new THREE.Vector2(1, 1));

  function clearLots(baseY) {
    for (let i = 0; i < LOT_TEX_SIZE * LOT_TEX_SIZE; i++) {
      lotData[i * 4] = baseY;
      lotData[i * 4 + 1] = baseY;   // top == base: "no building on this lot"
      lotData[i * 4 + 2] = 0;
      lotData[i * 4 + 3] = 0;
    }
    lotTexture.needsUpdate = true;
  }
  clearLots(P.groundY);

  // ── Uniforms ───────────────────────────────────────────────────────────────
  const u = {};
  for (const [k, v] of Object.entries(P)) {
    if (typeof v === "number") u[k] = uniform(isFacadeColorKey(k) ? new THREE.Color(v) : v);
  }
  const uTime = uniform(0);
  /** The stone palette as an indexable uniform array — see the pick below. */
  const uPalette = uniformArray(PALETTE.map((hex) => new THREE.Color(hex)));
  /** Direction TO the sun, world space — what the relief shadows are cast from. */
  const uSunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.3));
  /** The sun's own colour, for the glint. Warm white until the sky says else. */
  const uSunCol = uniform(new THREE.Color(1.0, 0.96, 0.88));
  /**
   * Shopfront neon, as an indexable uniform array.
   *
   * Saturated and few: real signage runs to a handful of gas colours, and a
   * continuous hue wheel reads as a rainbow rather than as a street. Magenta,
   * cyan, warm white, amber, green, and a deep red.
   */
  const uNeon = uniformArray(NEON_PALETTE.map((hex) => new THREE.Color(hex)));

  // ══════════════════════════════════════════════════════════════════════════
  // PURE BUILDERS — plain functions, no `If`, select-chains only, so BOTH the
  // colour pass and the normal pass can call them (see the header note about
  // sub-build var namespacing).
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * EVERY DERIVATIVE THIS FILE TAKES, in one place, so both passes can grab
   * them at function top level. Derivatives are illegal inside non-uniform
   * control flow, and `buildFrame` — which consumes these — has to be callable
   * from INSIDE the relief branch in the normal pass.
   * tools/cityShaderTest.mjs fails the build if one escapes into a branch.
   */
  function buildDerivatives() {
    const pdx = dFdx(positionWorld).toVar(), pdy = dFdy(positionWorld).toVar();
    const t = uv().toVar();
    const udx = dFdx(t.x).toVar(), udy = dFdy(t.x).toVar();
    const vdx = dFdx(t.y).toVar(), vdy = dFdy(t.y).toVar();
    /** The example's hand-rolled LOD: the on-screen size of a surface pixel. */
    const texel = abs(pdx).add(abs(pdy)).length().toVar();
    return { pdx, pdy, t, udx, udy, vdx, vdy, texel };
  }

  /** The face's frame, the lot's identity, and its per-lot architectural style. */
  function buildFrame(D, PIN) {
    const nW = normalize(normalWorldGeometry).toVar();
    const isRoof = abs(nW.y).greaterThan(0.5).toVar();
    // Horizontal axis along the face: cross(up, n).
    const uAxis = normalize(vec3(nW.z, 0.0, nW.x.negate()).add(vec3(1e-5, 0.0, 0.0))).toVar();

    // FACE SIZE IN METRES, from the screen derivatives of world position and of
    // the box UV. On a planar face both are linear in screen space, so the
    // ratio d(across)/d(uv.x) is exactly the face width. This is what gives
    // every face — on every setback tier, at any instance Y-scale — a pier at
    // both ends without the shader knowing anything about the footprint.
    const { pdx, pdy, t, udx, udy, vdx, vdy } = D;
    const ufw = abs(udx).add(abs(udy)).max(1e-7).toVar();
    const vfw = abs(vdx).add(abs(vdy)).max(1e-7).toVar();
    const adx = dot(pdx, uAxis).toVar(), ady = dot(pdy, uAxis).toVar();
    /*
     * ── THE FACE WIDTH IS AN ATTRIBUTE, NOT A DERIVATIVE. ────────────────────
     *
     * `aFace.x` is stamped on every vertex by the kit's `box()` with the
     * exact width of the face that vertex belongs to; see the long note there
     * for the artifact this fixes. In short: `W` feeds
     *     count = floor(W.sub(pierW).div(bay0))
     * and a floor() cannot be handed an estimate that wobbles between pixel
     * quads. When the quotient sat on an integer the count flipped, every bay
     * boundary moved, and the wall dithered pier-against-glass up its whole
     * height. An attribute is per-face constant by construction, so the flip
     * is not made less likely — it is impossible.
     *
     * The HEIGHT stays a derivative on purpose: instances carry a per-building
     * Y-scale, so the authored height is not the world height, and the scale
     * is not available here on the BatchedMesh path. `nF` rounds rather than
     * floors and `fh` changes by only 1/nF when it moves, so the same failure
     * is both rarer and far milder there — measured: nudging `floorHeight`
     * does not produce the artifact, nudging `bayWidth` does.
     */
    const W = attribute("aFace", "vec2").x.clamp(0.5, 400.0).toVar();
    const Hf = abs(pdx.y).add(abs(pdy.y)).div(vfw).clamp(0.5, 700.0).toVar();
    // Which way the box UV runs relative to +uAxis / +y, so u0 and v0 always
    // increase along +uAxis and upward and the ray components agree with them.
    const sU = adx.mul(udx).add(ady.mul(udy));
    const sV = pdx.y.mul(vdx).add(pdy.y.mul(vdy));
    const u0 = select(sU.greaterThan(0.0), t.x, float(1.0).sub(t.x)).mul(W).toVar();
    const v0 = select(sV.greaterThan(0.0), t.y, float(1.0).sub(t.y)).mul(Hf).toVar();
    // Metres per pixel along and up the face — the AA and LOD currency.
    const mpxU = ufw.mul(W).toVar();
    const mpxV = vfw.mul(Hf).toVar();

    // WHICH BUILDING.
    const lot = floor(positionWorld.xz.div(u.lotSize)).toVar();
    // SIX per-lot dice from ONE hash. These are constants over a whole
    // building and were six full PCG rounds per PIXEL. `fract(h * k)` with
    // co-prime-ish multipliers decorrelates well enough for what they drive —
    // a bay width, a pier depth, a palette index — and costs a multiply and a
    // fract each instead of a hash.
    const h1 = hash21(lot).toVar();
    const h2 = fract(h1.mul(197.31)).toVar();
    const h3 = fract(h1.mul(419.77)).toVar();
    const h4 = fract(h1.mul(733.19)).toVar();
    const h5 = fract(h1.mul(1279.53)).toVar();
    const h6 = fract(h1.mul(2411.87)).toVar();
    const cell = clamp(lot.sub(uLotOrigin), vec2(0.0), uLotCount.sub(1.0));
    const info = textureLoad(lotTexture, ivec2(cell)).toVar();
    const baseY = info.r;
    const bldgH = max(info.g.sub(info.r), float(1.0)).toVar();
    const district = info.b, btype = info.a;
    const isIndustrial = district.greaterThan(1.5).toVar();
    const isCurtain = PIN === null
      ? btype.greaterThan(0.5).and(btype.lessThan(1.5)).toVar()
      : PIN === BUILDING_TYPE.curtain;
    const isRibbon = PIN === null
      ? btype.greaterThan(1.5).toVar() : PIN === BUILDING_TYPE.ribbon;
    const isPunched = PIN === null
      ? btype.lessThan(0.5).toVar() : PIN === BUILDING_TYPE.punched;
    /** Distinguishes the four faces, so opposite walls do not mirror. */
    const faceKey = nW.x.mul(2.3).add(nW.z.mul(5.1)).toVar();

    const up = positionWorld.y.sub(baseY).toVar();
    const belowTop = bldgH.sub(up).toVar();
    const isGroundTier = up.sub(v0).lessThan(1.0).toVar();

    // ── PER-LOT STYLE ────────────────────────────────────────────────────────
    const spread = (c, s, h) => c.add(h.sub(0.5).mul(2.0).mul(s));
    const bay0 = selT(isCurtain, u.curtainBay, selT(isRibbon, u.ribbonBay,
      spread(u.bayWidth, u.baySpread, h4))).toVar();
    const pierW = selT(isCurtain, u.curtainMullion, selT(isRibbon, u.ribbonMullion,
      spread(u.pierWidth, u.pierSpread, h5))).max(0.02).toVar();
    const pierD = selT(isCurtain, u.curtainDepth, selT(isRibbon, u.ribbonDepth,
      u.pierDepth.mul(float(0.7).add(h3.mul(0.6))))).max(0.005).toVar();
    const reveal = selT(isCurtain, u.curtainReveal, selT(isRibbon, u.ribbonReveal,
      u.reveal.mul(float(0.7).add(h2.mul(0.6))))).max(0.005).toVar();
    const winRatio = selT(isCurtain, u.curtainWinRatio, selT(isRibbon, u.ribbonWinRatio,
      select(isIndustrial, u.windowRatio.mul(0.72), u.windowRatio))).toVar();
    const border = selT(isPunched, u.frameBorder, float(0.015)).toVar();
    const floorH0 = spread(u.floorHeight, u.floorSpread, h1).max(2.6).toVar();
    const courseEvery = selT(andT(isPunched, h3.lessThan(u.courseChance)),
      floor(h2.mul(5.99)).add(3.0), float(0.0)).toVar();
    const courseH = u.courseHeight.mul(float(0.7).add(h6.mul(0.6))).toVar();
    const grime = selT(isCurtain, u.curtainGrime, selT(isRibbon, u.ribbonGrime, u.glassGrime)).toVar();
    const reflectMin = selT(isCurtain, u.curtainReflectMin, u.glassReflectMin).toVar();

    // ── FACE LAYOUT ──────────────────────────────────────────────────────────
    // Bays stretched to fill the face exactly, pier centres at pierW/2 + i·bay,
    // so BOTH ends of every face are solid and a recess never reaches a corner.
    // Floors snapped so the tier is a whole number of them.
    const flat = W.lessThan(pierW.mul(2.0).add(bay0.mul(0.6))).or(Hf.lessThan(2.5)).or(isRoof).toVar();
    const count = max(floor(W.sub(pierW).div(bay0)), 1.0).toVar();
    const bay = W.sub(pierW).div(count).toVar();
    const nF = max(round(Hf.div(floorH0)), 1.0).toVar();
    const fh = Hf.div(nF).toVar();
    const winH = fh.mul(winRatio).toVar();
    const slotL = pierW.mul(0.5).toVar(), slotR = bay.sub(pierW.mul(0.5)).toVar();
    const oL = slotL.add(border).toVar(), oR = max(slotR.sub(border), slotL.add(border).add(0.05)).toVar();
    const oB = fh.sub(winH).mul(0.5).toVar(), oT = fh.add(winH).mul(0.5).toVar();
    const pitch = select(courseEvery.greaterThan(0.5), courseEvery.mul(fh), float(1e5)).toVar();

    // The BASE: on a punched tower's ground tier, two or three floors of deep
    // colonnade — a tall opening, recessed hard, dark inside. It is what stops
    // every tower looking like it was extruded straight out of the pavement,
    // and it is the piece of the example's arcade that actually reads at speed.
    const nBase = select(h4.greaterThan(0.5), float(3.0), float(2.0)).toVar();
    const hasBase = varT(andT(isPunched,
      isGroundTier.and(nF.greaterThan(nBase.add(1.5))).and(flat.not())));
    const baseH = selT(hasBase, nBase.mul(fh), float(0.0)).toVar();

    /** View ray, pixel-outward. Needed by the far paint's sky reflection as
     *  well as the trace, so it lives here rather than in `traceFacade`. */
    const V = normalize(positionWorld.sub(cameraPosition)).toVar();

    /**
     * WORLD-space along-face coordinate, for the brickwork only — the same
     * `x·n.z − z·n.x` projection the example uses. Two reasons it is not `u0`:
     * it costs two multiplies instead of the whole face-size solve, so the
     * NORMAL pass can compute the brick bump without redoing the layout; and
     * being continuous across the whole city, coursing does not restart at
     * every face corner the way face-local metres would.
     */
    const acrossW = positionWorld.x.mul(nW.z).sub(positionWorld.z.mul(nW.x)).toVar();

    const aaU = mpxU.mul(0.7).add(0.002).toVar(), aaV = mpxV.mul(0.7).add(0.002).toVar();
    const cellsPerPx = max(mpxU.div(bay), mpxV.div(fh)).toVar();
    const sharp = smoothstep(u.lodSharp, u.lodFlat, cellsPerPx).toVar();
    const reliefAmt = smoothstep(u.lodRelief, u.lodRelief.mul(0.4), cellsPerPx)
      .mul(u.relief).mul(select(flat, float(0.0), float(1.0))).toVar();

    return {
      nW, uAxis, isRoof, W, Hf, u0, v0, mpxU, mpxV, aaU, aaV, V, acrossW,
      lot, h1, h2, h3, h4, h5, h6, faceKey, up, belowTop, bldgH,
      isIndustrial, isCurtain, isRibbon, isPunched, flat,
      bay, count, nF, fh, winH, slotL, slotR, oL, oR, oB, oT,
      pierW, pierD, reveal, border, pitch, courseH, courseEvery,
      hasBase, baseH, nBase, grime, reflectMin, sharp, reliefAmt, cellsPerPx,
    };
  }

  /**
   * Classify the point (ua, va) ON the face plane — the flat, far-field read.
   * `bi`/`fi` are the bay and floor indices, which the room and the lit-window
   * hashes key off.
   */
  function classify(F, ua, va) {
    const uL = ua.sub(F.slotL);
    const bi = floor(uL.div(F.bay));
    const bu = uL.sub(bi.mul(F.bay)).add(F.slotL);       // 0..bay, pier centred on 0
    const fi = floor(va.div(F.fh));
    const fv = va.sub(fi.mul(F.fh));
    const inSlot = band(bu, F.slotL, F.slotR, F.aaU);
    // The base storey's opening is taller and starts lower.
    const inBase = andT(F.hasBase, va.lessThan(F.baseH));
    const bB = F.fh.mul(0.22), bT = F.baseH.sub(F.fh.mul(0.28));
    const openTall = band(bu, F.oL, F.oR, F.aaU).mul(band(va, bB, bT, F.aaV));
    const openNorm = band(bu, F.oL, F.oR, F.aaU).mul(band(fv, F.oB, F.oT, F.aaV));
    const opening = selT(inBase, openTall, openNorm);
    const frame = band(bu, F.oL.sub(F.border), F.oR.add(F.border), F.aaU)
      .mul(band(fv, F.oB.sub(F.border), F.oT.add(F.border), F.aaV))
      .sub(openNorm).max(0.0).mul(selT(inBase, float(0.0), float(1.0)));
    // String courses: at every `courseEvery` floor line, at the base's head,
    // and the cornice at the tier top (the same band, 1.6× taller).
    const fl = round(va.div(F.fh));
    const isTop = fl.greaterThan(F.nF.sub(0.5));
    const onPitch = F.courseEvery.greaterThan(0.5)
      .and(mod(fl, max(F.courseEvery, 1.0)).lessThan(0.5)).and(fl.greaterThan(0.5));
    const onBase = andT(F.hasBase, abs(fl.sub(F.nBase)).lessThan(0.5));
    const chH = select(isTop, F.courseH.mul(1.6), F.courseH);
    const course = selT(orT(isTop.or(onPitch), onBase), float(1.0), float(0.0))
      .mul(band(va.sub(fl.mul(F.fh)), chH.mul(-0.5), chH.mul(0.5), F.aaV));
    return { bi, bu, fi, fv, inBase, pier: float(1.0).sub(inSlot), opening, frame, course };
  }

  /**
   * THE RAY CAST. Select-chains only, no `If` — so it can be called from both
   * the colour pass and the normal pass without either one owning vars the
   * other needs (see the header).
   *
   * IT MUST BE CALLED INSIDE AN `If (reliefAmt > 0)`, in both passes.
   * Measured, unconditionally: the deck view went 1.5 ms → 6.9 ms, and only
   * 0.8 ms of that was the relief SHADING — the rest was this running on every
   * pixel of every distant tower that can never resolve a pier. Select-chains
   * are branch-free by construction, which is exactly why they have to be put
   * behind a branch by hand.
   *
   * It reads only `F` and uniforms — no derivatives — so it is safe inside a
   * branch. (`bumpNormal` is not, and stays outside.)
   */
  function traceFacade(F) {
    const V = F.V;
    const rd = max(dot(V, F.nW).negate(), 0.04).toVar();
    const ru = dot(V, F.uAxis).toVar(), rv = V.y.toVar();
    const ruS = select(abs(ru).lessThan(1e-4), float(1e-4), ru).toVar();
    const rvS = select(abs(rv).lessThan(1e-4), float(1e-4), rv).toVar();

    const c0 = classify(F, F.u0, F.v0);
    const onFront = c0.pier.greaterThan(0.5).or(c0.course.greaterThan(0.5)).toVar();

    // Depth of this slot: the base colonnade is recessed much harder.
    const slotD = selT(c0.inBase, F.pierD.add(u.baseRecess), F.pierD).toVar();

    // ── Level 1: the slot's own walls — the two pier flanks and the string
    // course above (its underside) or below (its top face).
    const bayL = c0.bi.mul(F.bay).add(F.slotL);
    const buA = F.u0.sub(bayL);                          // 0 at the left flank
    const slotW = F.slotR.sub(F.slotL);
    const t1 = slotD.div(rd).toVar();
    const bu1 = buA.add(ru.mul(t1)), va1 = F.v0.add(rv.mul(t1));
    const tL = buA.negate().div(ruS), tR = slotW.sub(buA).div(ruS);
    const hitL = ru.lessThan(0.0).and(bu1.lessThan(0.0));
    const hitR = ru.greaterThan(0.0).and(bu1.greaterThan(slotW));
    const kUp = ceil(F.v0.div(F.pitch)).max(1.0);
    const vcUp = kUp.mul(F.pitch);
    const topLine = vcUp.greaterThan(F.Hf.sub(F.fh.mul(0.5)));
    const cUpBottom = select(topLine, F.Hf.sub(F.courseH.mul(0.8)), vcUp.sub(F.courseH.mul(0.5)));
    const tcU = cUpBottom.sub(F.v0).div(rvS);
    const hitCU = rv.greaterThan(0.0).and(tcU.greaterThan(0.0)).and(tcU.lessThan(t1));
    // The course below is the last regular one OR the base's head band,
    // whichever is higher.
    const kDn = floor(F.v0.div(F.pitch));
    const cDn1 = kDn.mul(F.pitch);
    const has1 = kDn.greaterThan(0.5);
    const has2 = andT(F.hasBase, F.v0.greaterThan(F.baseH));
    const cDn = selT(andT(has2, has1.not().or(F.baseH.greaterThan(cDn1))), F.baseH, cDn1);
    const tcD = cDn.add(F.courseH.mul(0.5)).sub(F.v0).div(rvS);
    const hitCD = rv.lessThan(0.0).and(orT(has1, has2)).and(tcD.greaterThan(0.0)).and(tcD.lessThan(t1));
    const hitFlank = hitL.or(hitR).toVar();
    const hitCourse = hitCU.or(hitCD).toVar();
    const tFlank = select(hitL, tL, tR);
    const tCourse = select(hitCU, tcU, tcD);
    const isFlank = hitFlank.and(hitCourse.not().or(tFlank.lessThan(tCourse))).toVar();
    const isCourse = hitCourse.and(isFlank.not()).toVar();
    const tSide = select(isFlank, tFlank, tCourse).toVar();

    // ── Level 2: the slot floor — spandrel, flat frame, or the opening.
    const buS = bu1.add(F.slotL);
    const fi1 = floor(va1.div(F.fh));
    const fv1 = va1.sub(fi1.mul(F.fh));
    const inBase1 = andT(F.hasBase, va1.lessThan(F.baseH));
    const bB = F.fh.mul(0.22), bT = F.baseH.sub(F.fh.mul(0.28));
    const inOpenN = buS.greaterThan(F.oL).and(buS.lessThan(F.oR))
      .and(fv1.greaterThan(F.oB)).and(fv1.lessThan(F.oT));
    const inOpenB = buS.greaterThan(F.oL).and(buS.lessThan(F.oR))
      .and(va1.greaterThan(bB)).and(va1.lessThan(bT));
    const inOpen = selT(inBase1, inOpenB, inOpenN)
      .and(onFront.not()).and(hitFlank.or(hitCourse).not()).and(F.flat.not()).toVar();
    const inFrame = varT(andT(
      buS.greaterThan(F.oL.sub(F.border)).and(buS.lessThan(F.oR.add(F.border)))
        .and(fv1.greaterThan(F.oB.sub(F.border))).and(fv1.lessThan(F.oT.add(F.border))),
      notT(inBase1)));
    // The opening's own bounds, so the reveal walls know where they are.
    const wB = selT(inBase1, bB, fi1.mul(F.fh).add(F.oB)).toVar();
    const wT = selT(inBase1, bT, fi1.mul(F.fh).add(F.oT)).toVar();

    // ── Level 3: the reveal — jamb, sill, head — then the pane behind it.
    const rev = selT(inBase1, u.baseRecess.mul(0.35), F.reveal).toVar();
    const t2 = rev.div(rd).toVar();
    const bu2 = buS.add(ru.mul(t2)).toVar();
    const va2 = va1.add(rv.mul(t2)).toVar();
    const jL = ru.lessThan(0.0).and(bu2.lessThan(F.oL));
    const jR = ru.greaterThan(0.0).and(bu2.greaterThan(F.oR));
    const sill = rv.lessThan(0.0).and(va2.lessThan(wB));
    const head = rv.greaterThan(0.0).and(va2.greaterThan(wT));
    const tJ = select(jL, F.oL.sub(buS), F.oR.sub(buS)).div(ruS);
    const tV = select(sill, wB.sub(va1), wT.sub(va1)).div(rvS);
    const hitJ = jL.or(jR), hitV = sill.or(head);
    const isJamb = inOpen.and(hitJ).and(hitV.not().or(tJ.lessThan(tV))).toVar();
    const isVert = inOpen.and(hitV).and(isJamb.not()).toVar();
    const isReveal = isJamb.or(isVert).toVar();
    const isGlass = inOpen.and(isReveal.not()).toVar();
    const revealT = select(isJamb, tJ, tV).toVar();

    // ── Where the ray actually stopped, and facing which way.
    const tHit = select(onFront, float(0.0),
      select(isFlank.or(isCourse), tSide,
        select(isReveal, t1.add(revealT), select(isGlass, t1.add(t2), t1)))).toVar();
    const depth = rd.mul(tHit).toVar();
    const uHit = F.u0.add(ru.mul(tHit)).toVar();
    const vHit = F.v0.add(rv.mul(tHit)).toVar();

    const flankN = F.uAxis.mul(select(hitL, float(1.0), float(-1.0)));
    const courseN = vec3(0.0, select(hitCU, float(-1.0), float(1.0)), 0.0);
    const jambN = F.uAxis.mul(select(jL, float(1.0), float(-1.0)));
    const vertN = vec3(0.0, select(sill, float(1.0), float(-1.0)), 0.0);
    const N = select(isFlank, flankN, select(isCourse, courseN,
      select(isJamb, jambN, select(isVert, vertN, F.nW)))).toVar();
    /** 1 when the hit surface is parallel to the box face (brick bump applies). */
    const front = select(isFlank.or(isCourse).or(isReveal), float(0.0), float(1.0)).toVar();

    return {
      V, ru, rv, rd, c0, onFront, slotD, t1, t2, rev,
      isFlank, isCourse, isReveal, isJamb, isVert, isGlass, inOpen, inFrame, inBase1,
      hitL, hitCU, jL, sill, bi: c0.bi, fi1, fv1, buS, bu2, va1, va2, wB, wT,
      N, front, depth, uHit, vHit, tHit,
    };
  }

  /**
   * The analytic sun shadow. Light travels along −sun; `ld` is its component
   * INTO the wall. A step of depth `dep` shadows what is behind it for
   * dep·|s|/ld metres on its lee side. This is a real cast shadow, not a
   * painted crease: it swings across the facade as the sun moves and vanishes
   * when the sun comes round to face the wall head-on.
   */
  function buildSun(F) {
    const s = normalize(uSunDir).toVar();
    const ld = dot(s, F.nW).toVar();
    const su = dot(s, F.uAxis).negate().toVar();
    const sv = s.y.negate().toVar();
    const ldc = max(ld, 0.05).toVar();
    const on = smoothstep(float(0.02), float(0.14), ld).mul(u.reliefShadow).toVar();
    /** Shadow cast onto a surface `dep` behind the face, at (bu, va). */
    const at = (dep, bu, va) => {
      const w = dep.mul(abs(su)).div(ldc);
      const l = select(su.greaterThan(0.0), smoothstep(w.add(F.aaU), w.sub(F.aaU), bu.sub(F.slotL)), float(0.0));
      const r = select(su.lessThan(0.0), smoothstep(w.add(F.aaU), w.sub(F.aaU), F.slotR.sub(bu)), float(0.0));
      const kUp = ceil(va.div(F.pitch)).max(1.0);
      const vc = kUp.mul(F.pitch);
      const top = vc.greaterThan(F.Hf.sub(F.fh.mul(0.5)));
      const cB = select(top, F.Hf.sub(F.courseH.mul(0.8)), vc.sub(F.courseH.mul(0.5)));
      const hv = dep.mul(abs(sv)).div(ldc);
      const b = select(sv.lessThan(0.0), smoothstep(hv.add(F.aaV), hv.sub(F.aaV), cB.sub(va)), float(0.0));
      return max(l, max(r, b));
    };
    return { s, ld, su, sv, ldc, on, at };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TWO MATERIALS OFF ONE SOLVE.
  //
  // Every LOD tier used to share the full uber-shader, and the distance work
  // was skipped by a per-pixel branch INSIDE it. That is the wrong place for
  // it: a 3300-line shader has high register pressure whether or not the
  // branch is taken, which costs occupancy — the GPU's only way to hide memory
  // latency — on every pixel of every far tower. And the city already sorts
  // its buildings into per-tier InstancedMeshes, so the split is free.
  //
  //   material     — L0/L1, the full thing: ray-cast relief, rooms, bump.
  //   farMaterial  — L2, flat paint only. No trace, no rooms, no normalNode,
  //                  no per-brick hashing. At >850 m none of it resolves.
  //
  // Both are built from the SAME uniform objects, so every slider still drives
  // both and the two can never drift apart.
  // ══════════════════════════════════════════════════════════════════════════
  const makeSurface = (R, far, PIN) => Fn(() => {
    const D = buildDerivatives();
    const F = buildFrame(D, PIN);

    const oCol = vec3(0.5).toVar();
    const oRough = u.wallRough.toVar();
    const oEmis = vec3(0.0).toVar();
    const oShadow = float(1.0).toVar();
    const oAO = float(1.0).toVar();
    R.rough = oRough; R.emissive = oEmis; R.shadow = oShadow; R.ao = oAO;

    // ── STONE ────────────────────────────────────────────────────────────────
    // One palette pick per lot ±6%, the example's per-brick mottle and its
    // warm/cool per-brick shift, a low-frequency tone drift, and soot streaks
    // pooling low. Coursing keys off building-local metres so it lines up with
    // the floors and stays put as the camera moves.
    // ONE INDEXED READ, not seventeen chained mixes.
    //
    // Picking a palette entry with `mix(prev, next, step(i, pick))` walks the
    // WHOLE list on every pixel — seventeen mixes and seventeen steps to end up
    // with one of seventeen constants. A uniform array is a single indexed
    // fetch, and it also makes the palette editable at runtime instead of
    // being baked into the graph.
    const pickIdx = floor(F.h2.mul(PALETTE.length - 0.001));
    let base = uPalette.element(uint(pickIdx));
    base = base.mul(F.h6.mul(0.12).add(0.94)).mul(u.wallTint)
      .mul(select(F.isIndustrial, vec3(0.86, 0.87, 0.88), vec3(1.0)));
    const stoneBase = selT(orT(F.isCurtain, F.isRibbon), u.mullionColor, base).toVar();
    const jointAmt = selT(F.isPunched, float(1.0), float(0.0)).toVar();
    const tone = vnoise2(vec2(F.acrossW.mul(0.03), F.up.mul(0.03))).mul(0.18).toVar();
    const streak = vnoise2(vec2(F.acrossW.mul(1.5), F.up.mul(0.04))).mul(2.0);
    const dirt = smoothstep(float(-0.1), float(0.45), streak)
      .mul(smoothstep(u.sootHeight, float(0.0), F.up)).mul(u.soot).toVar();

    // Are individual BRICKS resolvable at all? A brick is 0.6 × 0.3 m, so past
    // about half a brick per pixel the per-brick tint and the warm/cool shift
    // average out to nothing — but their six integer hashes were still being
    // evaluated on every pixel of every distant tower. This gates them.
    const brickOn = far
      ? jointAmt.lessThan(-1.0).toVar()          // never: a brick is far sub-pixel out here
      : jointAmt.greaterThan(0.5)
        .and(max(F.mpxU.div(u.brickL), F.mpxV.div(u.brickH)).lessThan(0.45)).toVar();

    /** Brick + weathering at a point, in the coursing frame (across, up). */
    const stoneAt = (ua, upH, lighten) => {
      const rowC = upH.div(u.brickH), row = floor(rowC);
      const colC = ua.div(u.brickL).add(mod(row, 2.0).mul(0.5)), col = floor(colC);
      const dU = float(0.5).sub(abs(fract(colC).sub(0.5)));
      const dV = float(0.5).sub(abs(fract(rowC).sub(0.5)));
      const ddU = F.mpxU.div(u.brickL).clamp(1e-6, 0.5), ddV = F.mpxV.div(u.brickH).clamp(1e-6, 0.5);
      const mU = u.mortar.div(u.brickL.mul(2.0)), mV = u.mortar.div(u.brickH.mul(2.0));
      const drawU = max(ddU, mU), drawV = max(ddV, mV);
      // The pristine-grid trick: the drawn joint never falls below the pixel
      // footprint, and its opacity fades to keep energy constant — so mortar
      // stays crisp up close and DISSOLVES far away instead of shimmering.
      const lU = smoothstep(drawU.add(ddU), drawU.sub(ddU), dU).mul(min(mU.div(drawU), 1.0));
      const lV = smoothstep(drawV.add(ddV), drawV.sub(ddV), dV).mul(min(mV.div(drawV), 1.0));
      const joint = max(lU, lV).mul(jointAmt);
      // Per-brick variation, near only. Defaults are the MEANS these hashes
      // converge to, so the far tower is exactly the average of the near one.
      const perBrickVar = float(0.0).toVar();
      const wc = float(0.0).toVar();
      If(brickOn, () => {
        const bk = ihash2(vec2(col.add(F.h1.mul(300.0)), row.add(F.h2.mul(300.0))));
        const bk2 = ihash2(vec2(row.add(F.h3.mul(300.0)), col));
        const mottle = vnoise2(vec2(ua.mul(0.7), upH.mul(0.7))).mul(0.06);
        perBrickVar.assign(mottle.add(bk.sub(0.5).mul(0.14)));
        wc.assign(bk2.sub(0.5).mul(0.14));
      });
      const perBrick = float(1.0).add(tone).add(perBrickVar);
      const tint = mix(stoneBase, vec3(1.0), lighten).mul(perBrick)
        .mul(vec3(float(1.0).add(wc), 1.0, float(1.0).sub(wc)));
      return {
        col: mix(mix(tint, tint.mul(0.6), joint), u.sootColor, dirt),
        rough: u.wallRough.add(joint.mul(0.12)),
      };
    };
    const frameCol = stoneBase.mul(0.55).mul(float(1.0).add(tone)).toVar();   // dressed stone
    const canyon = mix(float(1.0).sub(u.canyonAO), float(1.0),
      smoothstep(float(0.0), u.canyonHeight, F.up)).toVar();

    // ── ROOMS AND LIT WINDOWS ────────────────────────────────────────────────
    // Rooms span 2–3 bays, chosen per floor, so neighbouring panes share one
    // interior. A room's state is a hash that NEVER changes; only
    // `churnFraction` of them are on a slow timer at all.
    const roomOf = (bi, fi) => {
      const rb = select(hash31(vec3(F.lot, fi.mul(0.37).add(F.faceKey))).greaterThan(0.5), float(3.0), float(2.0));
      const ph = floor(hash31(vec3(F.lot.mul(1.9), fi.mul(0.71).add(F.faceKey))).mul(rb));
      const ri = floor(bi.add(ph).div(rb));
      const first = ri.mul(rb).sub(ph);
      const last = min(first.add(rb), F.count);
      return { ri, first, span: max(last.sub(max(first, 0.0)), 1.0) };
    };
    const litOf = (ri, fi) => {
      const key = ri.mul(1.7).add(fi.mul(31.7)).add(F.faceKey);
      const bldgLit = u.litFraction.mul(F.h3.mul(1.1).add(0.45));
      const floorLit = step(u.darkFloors, hash31(vec3(F.lot, fi.mul(0.37).add(F.faceKey.mul(0.3)))));
      const steady = hash31(vec3(F.lot.mul(3.1), key));
      const churner = step(hash31(vec3(F.lot.mul(5.7), key.mul(0.93))), u.churnFraction);
      const phase = hash31(vec3(F.lot.mul(2.3), key.mul(0.61)));
      const epoch = floor(uTime.div(u.churnPeriod.max(1.0)).add(phase));
      const churn = hash31(vec3(F.lot.mul(3.1), key.add(epoch.mul(7.13))));
      const wh = mix(steady, churn, churner);
      const rh = hash31(vec3(F.lot.mul(1.3), key.mul(0.37)));
      const rh2 = hash31(vec3(F.lot.mul(0.7), key.mul(1.91)));
      return {
        lit: step(wh, bldgLit).mul(floorLit), mean: bldgLit, rh, rh2,
        litCol: mix(u.litWarm, u.litCool, step(0.88, hash31(vec3(F.lot.mul(0.9), key.mul(2.3))))),
        curtain: step(float(1.0).sub(u.curtains), rh2),
      };
    };

    // ── GLASS ────────────────────────────────────────────────────────────────
    // The example's model: the room seen through a soda-lime tint, muted
    // toward dirty glass by a grime that never drops below ~0.64 — the panes
    // must read as OLD GLASS, not open holes — with dust streaks down the
    // facade and dirt pooled along each sill. Sky rides on top, analytically:
    // reflect the view about the normal and read the same vertical gradient
    // the sky module is painting the dome with. Cheaper than an env tap, and
    // it stays sharp at distances where a 128 px PMREM cube is mush.
    const dirty = mix(u.dirtyGlassA, u.dirtyGlassB,
      vnoise2(vec2(F.u0.mul(0.3), F.up.mul(0.3))).add(0.5)).toVar();
    const skyAt = (N) => {
      const Rw = reflect(F.V, N);
      const col = mix(
        mix(u.skyGround, u.skyHorizon, smoothstep(float(-0.6), float(-0.05), Rw.y)),
        mix(u.skyHorizon, u.skyZenith, smoothstep(float(-0.15), float(0.45), Rw.y)),
        step(float(-0.02), Rw.y),
      );
      // NOT bare-glass Schlick. F0 = 0.04 is 3% head-on — correct for a window
      // and INVISIBLE on a skyline, because from any normal viewpoint you see
      // facades close to head-on. Measured: at true Schlick the towers looked
      // identical with the term switched off. Architectural glass is COATED,
      // so the curve runs from `reflectMin` head-on to 1 at grazing.
      const cosT = max(dot(N, F.V.negate()), float(0.0));
      const fres = mix(F.reflectMin, float(1.0), pow(float(1.0).sub(cosT), 4.0));

      // THE SUN'S DISC, in the same mirror. `Rw` is already the reflected view
      // ray, so this is one dot and one pow on top of work the pane is doing
      // anyway. Gated on the sun being ABOVE the horizon — below it there is
      // no disc to reflect, and without the gate every pane flashed at
      // midnight from a sun direction that was still pointing somewhere.
      const sd = normalize(uSunDir);
      const up = smoothstep(float(-0.02), float(0.10), sd.y);
      const glint = pow(max(dot(Rw, sd), float(0.0)), u.sunGlintSharp)
        .mul(u.sunGlint).mul(fres).mul(up).mul(float(1.0).sub(u.nightAmount));

      return {
        col: col.mul(u.skyReflectGain),
        amt: clamp(fres.mul(u.glassReflect).mul(float(1.0).sub(u.nightAmount.mul(0.6))), 0.0, 1.0),
        glint: uSunCol.mul(glint),
      };
    };
    const glassOf = (roomCol, roomLit, litCol, paneV, N) => {
      const dust = smoothstep(float(-0.15), float(0.5),
        vnoise2(vec2(F.u0.mul(1.3).add(F.h4.mul(70.0)), F.up.mul(0.06))).mul(2.0)).mul(0.45);
      const pooled = smoothstep(float(0.32), float(0.0), paneV).mul(0.4);
      const g = F.grime.add(dust).add(pooled).clamp(0.0, 0.95);
      const sky = skyAt(N);
      // The glint rides the EMISSIVE, not the albedo: a specular highlight is
      // light leaving the surface, and putting it in the albedo would have the
      // sun's own reflection darkened by the room behind the glass. Dirty
      // glass flashes less, same `g` the room is muted by.
      return {
        col: mix(mix(roomCol.mul(u.glassTint), dirty, g), sky.col, sky.amt),
        glow: roomCol.mul(litCol).mul(roomLit).mul(u.emissiveBoost)
          .mul(float(1.0).sub(g.mul(0.6))).mul(mix(u.dayGlow, float(1.0), u.nightAmount))
          .add(sky.glint.mul(float(1.0).sub(g.mul(0.7)))),
      };
    };

    // ══════════════════════════════════════════════════════════════════════
    // FAR PAINT — the flat read: bright stone with dark holes, converging to
    // the mean as the window grid dissolves.
    //
    // GATED AGAINST THE RELIEF, and that pairing is the single biggest saving
    // in this shader. The two are blended by `reliefAmt`, so at close range
    // the flat half was computed in full and then thrown away by
    // `mix(..., 1.0)`. Measured on one facade filling the screen — the true
    // worst case, no overdraw — the flat half was most of the base cost. Now
    // only the thin ring where 0 < reliefAmt < 1 pays for both.
    // ══════════════════════════════════════════════════════════════════════
    const notFlat = select(F.flat, float(0.0), float(1.0)).toVar();
    const farPaint = () => {
    const c0 = classify(F, F.u0, F.v0);
    const winRaw = c0.opening.mul(float(1.0).sub(c0.pier)).mul(float(1.0).sub(c0.course)).mul(notFlat);
    const coverage = F.oR.sub(F.oL).mul(F.oT.sub(F.oB)).div(F.bay.mul(F.fh)).clamp(0.0, 1.0).mul(notFlat);
    const win0 = mix(coverage, winRaw, F.sharp).toVar();
    const st0 = stoneAt(F.acrossW, F.up, c0.pier.mul(0.12).add(c0.course.mul(0.14)));

    // ── PER-WINDOW STATE, near only ─────────────────────────────────────────
    // `roomOf` + `litOf` are nine sin-hashes, and they exist to answer "is
    // THIS room lit". Once the window grid has dissolved there is no this
    // room — every pane on the tower converges to the same average — so the
    // whole block sits behind the same `sharp` term that dissolved the grid.
    // The defaults below ARE that average, which is why the LOD ring shows no
    // seam. Measured: nine hashes per pixel of every distant tower.
    const litOn = u.litFraction.mul(F.h3.mul(1.1).add(0.45)).toVar();  // the mean
    const roomJit = float(0.5).toVar();
    const litColV = mix(u.litWarm, u.litCool, float(0.12)).toVar();
    const paneV = float(0.5).toVar();
    If(F.sharp.greaterThan(0.002), () => {
      const rm0 = roomOf(c0.bi, c0.fi);
      const lt0 = litOf(rm0.ri, c0.fi);
      litOn.assign(mix(lt0.mean, lt0.lit, F.sharp));
      roomJit.assign(lt0.rh);
      litColV.assign(lt0.litCol);
      paneV.assign(c0.fv.sub(F.oB).div(max(F.winH, 0.1)).clamp(0.0, 1.0));
    });
    // A far pane shows the room's MEAN — a mid grey, lit or not — behind grime.
    const g0 = glassOf(vec3(0.42, 0.40, 0.37).mul(float(0.6).add(roomJit.mul(0.5))),
      litOn, litColV, paneV, F.nW);
    const baseDark = selT(c0.inBase, float(0.35), float(1.0));
    const wallFar = mix(st0.col, frameCol, c0.frame.mul(F.sharp));

    oCol.assign(mix(wallFar, g0.col.mul(baseDark), win0));
    oRough.assign(mix(st0.rough, u.glassRough, win0));
    oEmis.assign(g0.glow.mul(win0).mul(selT(c0.inBase, float(0.0), float(1.0))));
    oAO.assign(mix(float(1.0), float(0.84), win0)
      .mul(mix(float(1.0), float(0.93), float(1.0).sub(c0.pier).mul(F.sharp))).mul(canyon));
    };
    // On the far material the flat paint IS the shader. On the near one it is
    // the other half of a blend, so it is skipped where the relief covers it.
    if (far) farPaint(); else If(F.reliefAmt.lessThan(0.999), farPaint);

    // ══════════════════════════════════════════════════════════════════════
    // NEAR — dress what the ray actually hit. The trace already ran (it is
    // shared with normalNode); this branch only pays for the SHADING.
    // ══════════════════════════════════════════════════════════════════════
    if (!far) If(F.reliefAmt.greaterThan(0.001), () => {
      // THE RAY CAST LIVES HERE, not at the top. See traceFacade's note: run
      // unconditionally it cost 5 ms of a 7 ms frame, almost all of it on
      // distant towers that can never resolve a pier.
      const T = traceFacade(F);
      const S = buildSun(F);

      const nCol = vec3(0.0).toVar();
      const nRough = u.wallRough.toVar();
      const nGlow = vec3(0.0).toVar();
      const nShade = float(0.0).toVar();    // 1 = fully in the relief's own shadow
      const nAO = float(1.0).toVar();

      // Stone everywhere the ray did not reach glass. A flank's coursing runs
      // along its DEPTH, a course's top and underside run along the face.
      const stU = select(T.isFlank, T.depth, F.acrossW.add(T.uHit).sub(F.u0));
      const stV = select(T.isFlank, F.up.add(T.vHit.sub(F.v0)), F.up.add(T.depth.mul(2.0)));
      const st = stoneAt(stU, select(T.onFront, F.up, stV), select(T.onFront, T.c0.pier.mul(0.12), float(0.1)));
      nCol.assign(select(T.inFrame.and(T.onFront.not()), frameCol, st.col));
      nRough.assign(st.rough);
      nAO.assign(mix(float(1.0), float(0.78), T.depth.div(max(T.slotD.add(T.rev), 0.05)).clamp(0.0, 1.0)));
      nShade.assign(select(T.onFront, float(0.0),
        select(T.isFlank, float(0.0),
          select(T.isCourse, select(T.hitCU, smoothstep(float(0.0), float(0.2), S.sv.negate()), float(0.0)),
            S.at(T.depth, T.buS, T.va1)))));

      // Reveals: dressed stone, darkening with how deep into the opening the
      // ray went — which is what makes a window read as a HOLE.
      const revShade = mix(float(1.0), float(0.68), T.depth.sub(T.slotD).div(max(T.rev, 0.02)).clamp(0.0, 1.0));
      nCol.assign(select(T.isReveal, frameCol.mul(revShade), nCol));
      nRough.assign(select(T.isReveal, u.wallRough.mul(0.9), nRough));
      nAO.assign(select(T.isReveal, float(0.66), nAO));

      // ── The pane, and the room behind it.
      If(T.isGlass, () => {
        const rm = roomOf(T.bi, T.fi1);
        const lt = litOf(rm.ri, T.fi1);
        const roomW = max(rm.span.mul(F.bay).sub(F.pierW), 0.5);
        const roomH = max(T.wT.sub(T.wB).add(1.0), 0.8);
        const pu = T.bi.sub(rm.first).mul(F.bay).add(T.bu2).sub(F.slotL);
        const pv = T.va2.sub(T.wB).add(roomH.sub(T.wT.sub(T.wB)).mul(0.5));
        const D = u.roomDepth;
        // Analytic box hit: the nearest far-plane crossing. A near-zero ray
        // component gives ±inf, which min() harmlessly drops.
        const tBack = D.div(T.rd);
        const tS = select(T.ru.greaterThan(0.0), roomW.sub(pu), pu.negate())
          .div(select(abs(T.ru).lessThan(1e-4), float(1e-4), T.ru));
        const tV2 = select(T.rv.greaterThan(0.0), roomH.sub(pv), pv.negate())
          .div(select(abs(T.rv).lessThan(1e-4), float(1e-4), T.rv));
        const tSP = select(tS.greaterThan(0.0), tS, float(1e6));
        const tVP = select(tV2.greaterThan(0.0), tV2, float(1e6));
        const tHit = min(tBack, min(tSP, tVP));
        const q = vec3(
          pu.add(T.ru.mul(tHit)).div(roomW),
          pv.add(T.rv.mul(tHit)).div(roomH),
          T.rd.mul(tHit).div(D),
        );
        const onBack = tHit.equal(tBack);
        const onFloor = tHit.equal(tVP).and(T.rv.lessThan(0.0));
        const onCeil = tHit.equal(tVP).and(T.rv.greaterThan(0.0));

        // The room: muted plaster picked per room with a darker skirting;
        // floorboards with a seam and a centred rug; a lighter ceiling with a
        // round fixture that BURNS when the room is lit; a door and a framed
        // picture on the back wall, and a low sofa in front of it.
        const wallA = mix(color(0x9a8b73), color(0x6f7a82), lt.rh);
        const wallC = mix(wallA, color(0xb9ad97), lt.rh2.mul(0.6));
        const wallCol = mix(wallC, wallC.mul(0.5), smoothstep(float(0.05), float(0.04), q.y));
        const rect = (ax, ay, cx, cy, hw, hh) =>
          smoothstep(hw + 0.006, hw - 0.006, abs(ax.sub(cx))).mul(smoothstep(hh + 0.006, hh - 0.006, abs(ay.sub(cy))));
        const boards = mix(color(0x4a3320), color(0x6a4c30), lt.rh)
          .mul(float(1.0).sub(step(0.94, fract(q.x.mul(6.0))).mul(0.3)));
        const floorCol = mix(boards, mix(color(0x7a3b32), color(0x3a5760), lt.rh2),
          rect(q.x, q.z, 0.5, 0.62, 0.3, 0.26).mul(0.9));
        const lamp = smoothstep(float(0.16), float(0.13), length(vec2(q.x.sub(0.5), q.z.sub(0.5))));
        // The fixture's punch is a NIGHT thing. Left at 4.5 by day it burned a
        // tan disc into every lit office at three in the afternoon — the room
        // is daylit then, and a ceiling lamp against daylight is nearly
        // invisible.
        const lampGain = mix(float(1.0), mix(float(1.4), float(4.5), u.nightAmount), lt.lit);
        const ceilCol = mix(mix(wallC, vec3(1.0), 0.5), lt.litCol.mul(lampGain), lamp);
        const doorX = mix(float(0.22), float(0.78), lt.rh);
        const picX = select(doorX.lessThan(0.5), mix(float(0.68), float(0.82), lt.rh2), mix(float(0.18), float(0.32), lt.rh2));
        let backCol = mix(wallCol, mix(color(0x5a4631), color(0x39383c), step(0.5, lt.rh2)),
          rect(q.x, q.y, doorX, 0.33, 0.085, 0.35));
        backCol = mix(backCol, color(0x141210), rect(q.x, q.y, picX, 0.56, 0.075, 0.085));
        backCol = mix(backCol, mix(color(0x2c3a4a), color(0x7a5a3a), fract(lt.rh.mul(7.3))),
          rect(q.x, q.y, picX, 0.56, 0.055, 0.065));
        const sofa = onBack.and(q.y.lessThan(0.3)).and(abs(q.x.sub(0.5)).lessThan(0.32));
        const sofaCol = mix(color(0x5a4a3a), color(0x42566a), lt.rh)
          .mul(mix(float(0.85), float(1.12), smoothstep(float(0.24), float(0.30), q.y)));
        const shell = select(onBack, select(sofa, sofaCol, backCol),
          select(onCeil, ceilCol, select(onFloor, floorCol, wallCol)));
        // Corner AO, so the box reads with soft shading rather than flat walls.
        const aoE = (a) => smoothstep(float(0.0), float(0.15), a).mul(smoothstep(float(0.0), float(0.15), float(1.0).sub(a)));
        const edge = select(onBack, aoE(q.x).mul(aoE(q.y)),
          select(onFloor.or(onCeil), aoE(q.x).mul(aoE(q.z)), aoE(q.y).mul(aoE(q.z))));
        const raw = shell.mul(mix(float(0.72), float(1.0), edge)).mul(mix(float(1.0), float(0.42), q.z.clamp(0.0, 1.0)));
        // Curtains drawn part-way in from each side, so some windows read open
        // and others half-covered. A drape transmits only a little of the glow.
        const dw = pow(smoothstep(float(0.3), float(1.0), lt.rh), 2.0).mul(0.5);
        const dw2 = pow(smoothstep(float(0.3), float(1.0), lt.rh2), 2.0).mul(0.5);
        const qu = pu.div(roomW);
        const draped = qu.lessThan(dw).or(qu.greaterThan(float(1.0).sub(dw2))).or(lt.curtain.greaterThan(0.5));
        const fabric = mix(color(0xcabfa6), color(0x706a64), lt.rh2)
          .mul(mix(float(0.78), float(1.12), fract(pu.mul(2.5))));
        const roomCol = select(draped, fabric, raw)
          .mul(mix(vec3(1.0), lt.litCol, lt.lit.mul(0.85))).mul(mix(float(1.0), float(1.3), lt.lit));
        const roomLit = lt.lit.mul(select(draped, float(0.2), float(1.0)));
        const seen = mix(vec3(0.16), roomCol, u.interior);

        const g = glassOf(seen, roomLit.mul(u.interior), lt.litCol,
          T.va2.sub(T.wB).div(max(T.wT.sub(T.wB), 0.1)), F.nW);
        nCol.assign(selT(T.inBase1, g.col.mul(0.3), g.col));
        nRough.assign(u.glassRough);
        nGlow.assign(selT(T.inBase1, vec3(0.0), g.glow));
        nAO.assign(0.8);
        // The pier and the window head both shadow the pane.
        const wJ = T.rev.mul(abs(S.su)).div(S.ldc);
        const shJ = select(S.su.greaterThan(0.0), smoothstep(wJ.add(F.aaU), wJ.sub(F.aaU), T.bu2.sub(F.oL)),
          smoothstep(wJ.add(F.aaU), wJ.sub(F.aaU), F.oR.sub(T.bu2)));
        const hH = T.rev.mul(abs(S.sv)).div(S.ldc);
        const shH = select(S.sv.lessThan(0.0), smoothstep(hH.add(F.aaV), hH.sub(F.aaV), T.wT.sub(T.va2)), float(0.0));
        nShade.assign(max(S.at(T.depth, T.bu2, T.va2), max(shJ, shH)));
      });

      // Blend the relief over the flat paint, so the two meet without a seam.
      oCol.assign(mix(oCol, nCol, F.reliefAmt));
      oRough.assign(mix(oRough, nRough, F.reliefAmt));
      oEmis.assign(mix(oEmis, nGlow, F.reliefAmt));
      oAO.assign(mix(oAO, nAO.mul(canyon), F.reliefAmt));
      oShadow.assign(float(1.0).sub(nShade.mul(S.on).mul(F.reliefAmt)));
    });

    // ── Roofs, and the crown lights ──────────────────────────────────────────
    const roofCol = u.roofColor.mul(float(1.0).add(vnoise2(positionWorld.xz.mul(0.5)).mul(0.3)));
    oCol.assign(select(F.isRoof, roofCol, oCol));
    oRough.assign(select(F.isRoof, float(0.95), oRough));
    oShadow.assign(select(F.isRoof, float(1.0), oShadow));
    oAO.assign(select(F.isRoof, float(1.0), oAO));

    const hasCrown = step(F.h3, u.crownFraction).mul(select(F.isIndustrial, float(0.0), float(1.0)));
    const crownBand = smoothstep(u.crownHeight, u.crownHeight.mul(0.25), F.belowTop).mul(step(float(0.0), F.belowTop));
    const hue = fract(F.h1.mul(5.3));
    const crownColor = vec3(
      smoothstep(0.5, 0.2, abs(hue.sub(0.15))).mul(0.6).add(0.4),
      smoothstep(0.45, 0.15, abs(hue.sub(0.5))).mul(0.7).add(0.3),
      smoothstep(0.5, 0.2, abs(hue.sub(0.82))).mul(0.8).add(0.35),
    );
    oEmis.assign(select(F.isRoof, vec3(0.0),
      oEmis.add(crownColor.mul(hasCrown.mul(crownBand).mul(u.nightAmount).mul(u.crownBoost)))));

    // ── STREET LEVEL: THE SHOPFRONT, AND THE NEON OVER IT ──────────────────────────────────────────────────
    //
    // BEHIND A HEIGHT GATE, and that is not a micro-optimisation: on any
    // skyline view almost every pixel is above the third floor, so this is a
    // branch that genuinely skips its own body for most of the frame — the
    // same shape as the relief gate above it, and the reason that one is worth
    // 5 ms.
    const neonTop = u.neonHeight.add(u.neonThick).add(u.neonBladeH).toVar();
    // ONE GATE FOR BOTH. Two branches at nearly the same height would
    // have been two tests bought for one saving.
    const streetTop = max(neonTop, u.shopHeight).add(0.5).toVar();
    If(F.up.lessThan(streetTop).and(F.isRoof.not()).and(F.flat.not()), () => {
      /*
       * ── THE SHOPFRONT ──────────────────────────────────────────────────
       *
       * The storey you drive past was the same stone as the thirtieth. Real
       * streets read as streets because the bottom four metres is glass,
       * stallrisers, awnings and signage on A UNIT OF ITS OWN — a shop is
       * about six metres wide whatever the structural bay above it is doing,
       * and that mismatch between the ground rhythm and the one above it is a
       * large part of what makes a frontage look built rather than extruded.
       *
       * SO THE SHOP UNIT IS NOT THE BAY. Reusing `F.bay` would have been a
       * line cheaper and would have lined every shop up with the windows
       * above it, which is the one thing that gives a generated frontage
       * away.
       *
       * A TOWER GETS A COLONNADE OR A PARADE, NEVER BOTH. `hasBase` already
       * gives punched towers a deep recessed ground tier, and painting shop
       * glazing onto the face of that recess would be two different ideas
       * about the same four metres fighting each other.
       */
      /*
       * WHO GETS ONE, and the honest answer is "not most of them". The first
       * cut put a parade of shops on every building that was not industrial
       * and had no colonnade, which is nearly all of them — and a shopfront
       * on every frontage in the city is wallpaper, not a street. It also put
       * shops on the base of three-hundred-metre glass towers, which is the
       * one place they certainly do not go.
       *
       * Three rules, and each removes a different wrong thing:
       *   • A TOWER GETS A LOBBY. Curtain wall is a tall-building technology;
       *     its ground floor is a tall glazed entrance hall, not six shops.
       *     Same masks, no stallriser, no fascia, no awning, a wider mullion.
       *   • SHOPS ARE A LOW-BUILDING THING. Above `shopMaxHeight` a frontage
       *     belongs to whatever occupies the tower, not to the street.
       *   • AND THEN ONLY SOME OF THEM. `shopBuildings` is what turns a
       *     continuous parade into a street where some frontages are shops
       *     and the rest are plain wall — which is what a real one looks like.
       *
       * The roll is its OWN hash rather than one of h1..h6: `h6` already
       * drives the wall tint, and reusing it would have made every shop
       * frontage the same brightness as its own wall for no reason anyone
       * could ever have explained.
       */
      const shopRoll = hash31(vec3(F.lot, float(7.77))).toVar();
      const notInd = float(1.0).sub(float(F.isIndustrial));
      const notBase = selT(F.hasBase, float(0.0), float(1.0));
      const lobbyOn = u.shopfronts.mul(numT(F.isCurtain)).mul(notInd).mul(notBase).toVar();
      const paradeOn = u.shopfronts
        .mul(notInd).mul(notBase)
        .mul(float(1.0).sub(numT(F.isCurtain)))
        .mul(step(F.bldgH, u.shopMaxHeight))
        .mul(step(shopRoll, u.shopBuildings))
        .toVar();
      const shopOn = max(paradeOn, lobbyOn).toVar();
      const shopH = u.shopHeight;
      const si = floor(F.u0.div(u.shopUnit)).toVar();
      // Metres across THIS shop, so every width below is in metres and the
      // face's own `aaU` is already the right filter width.
      const sx = F.u0.sub(si.mul(u.shopUnit)).toVar();
      const sh = hash31(vec3(F.lot, si.mul(3.1).add(F.faceKey.mul(5.9)))).toVar();
      // A painted frontage colour per shop: saturated, but pulled well off
      // full chroma — a parade of pure hues reads as a toy.
      const shue = fract(sh.mul(17.3));
      const shopCol = mix(vec3(0.30, 0.32, 0.35), vec3(
        smoothstep(0.55, 0.18, abs(shue.sub(0.06))).mul(0.75).add(0.12),
        smoothstep(0.50, 0.16, abs(shue.sub(0.42))).mul(0.62).add(0.10),
        smoothstep(0.55, 0.18, abs(shue.sub(0.74))).mul(0.70).add(0.14),
      ), 0.72).toVar();

      // A lobby is glazed nearly to the soffit and has no sign band; a shop
      // stops under its fascia. `lobbyOn` is 0 or 1, so these are a switch.
      const fasciaLo = mix(shopH.sub(u.shopFascia), shopH.sub(0.12), lobbyOn).toVar();
      const glassLo = mix(u.shopStall, u.lobbySill, lobbyOn).toVar();
      const mullPitch = mix(u.shopMull, u.lobbyMull, lobbyOn).toVar();
      const awnLo = fasciaLo.sub(u.shopAwningH);
      // The pier between shops keeps the building's own stone; everything
      // between two piers is frontage.
      const glazedX = band(sx, u.shopPier, u.shopUnit.sub(u.shopPier.mul(0.35)), F.aaU).toVar();
      const stallY = band(F.up, float(0.0), glassLo, F.aaV);
      const glassY = band(F.up, glassLo, fasciaLo, F.aaV);
      const fasciaY = band(F.up, fasciaLo, shopH, F.aaV);
      // Mullions: the fine vertical rhythm that says "shop window" rather
      // than "hole in a wall".
      const mv = fract(sx.sub(u.shopPier).div(mullPitch));
      const mull = band(mv, float(0.0), u.shopMullW.div(mullPitch), F.aaU.div(mullPitch));

      const glazed = glazedX.mul(glassY).toVar();
      const glass = glazed.mul(float(1.0).sub(mull)).toVar();
      const mullM = glazed.mul(mull).toVar();
      const stallM = glazedX.mul(stallY).toVar();
      const fasciaM = fasciaY.toVar();
      // An awning over some of them, hung under the fascia. Paint, not
      // geometry — at the distance a frontage is actually read, a striped
      // band under the sign IS an awning.
      const awnY = band(F.up, awnLo, fasciaLo, F.aaV);
      const awnM = glazedX.mul(awnY).mul(step(fract(sh.mul(53.1)), u.shopAwning)).mul(paradeOn).toVar();
      const stripe = step(float(0.5), fract(sx.div(u.shopStripe)));
      const awnCol = mix(shopCol.mul(0.85), vec3(0.88, 0.88, 0.85), stripe);

      oCol.assign(mix(oCol, vec3(0.040, 0.045, 0.052), glass.mul(shopOn)));
      oCol.assign(mix(oCol, vec3(0.075, 0.078, 0.082), mullM.mul(shopOn)));
      // The painted parts are the PARADE's alone. A lobby is glass, metal and
      // stone; giving it a coloured fascia was most of what made the towers
      // look wrong.
      oCol.assign(mix(oCol, shopCol.mul(0.42), stallM.mul(paradeOn)));
      oCol.assign(mix(oCol, shopCol, fasciaM.mul(paradeOn)));
      oCol.assign(mix(oCol, awnCol, awnM.mul(paradeOn)));
      oRough.assign(mix(oRough, float(0.14), glass.mul(shopOn)));
      /*
       * AND THE LIGHT INSIDE. A shop window at night is not a dark pane with
       * a sign over it — the interior is lit and it spills onto the pavement,
       * which is most of why a night street looks inhabited. Warm, because
       * shop lighting is; and against the cold sparse room lights above it,
       * that contrast IS the street level.
       *
       * The awning hangs in front of the glass, so it takes the light back
       * out again.
       */
      // A lobby is always lit — that is rather the point of a lobby — while a
      // parade has some shops shut.
      const litShop = max(step(sh, u.shopLitFraction).mul(paradeOn), lobbyOn);
      oEmis.assign(oEmis.add(vec3(1.0, 0.86, 0.66).mul(
        glass.mul(float(1.0).sub(awnM)).mul(litShop).mul(shopOn)
          .mul(u.nightAmount).mul(u.shopGlow))));

      /*
       * ── AND A DOOR FOR EVERYONE ELSE ───────────────────────────────────
       *
       * Only 42% of eligible buildings get a parade, which is the point — but
       * it left the other 58% as blank wall from the pavement to the roof.
       * Real buildings without shops still have a way IN, and at eye level a
       * doorway is the difference between a building and an extrusion.
       *
       * ONE PER FACE, at a hashed position, rather than one per building: the
       * shader has no idea which face is the front — it does not even know
       * the other three exist — so a door on each is both the only thing
       * available and, as it happens, what a real corner block looks like.
       *
       * It costs almost nothing on top of what is already here. This sits
       * inside the same street-level branch as the shopfront, so the pixels
       * that pay for it are the ones already paying, and the two are mutually
       * exclusive by construction: a frontage is a parade, a lobby, or a door.
       */
      const plainOn = u.doorways.mul(notBase)
        .mul(float(1.0).sub(max(paradeOn, lobbyOn))).toVar();
      const dh = hash31(vec3(F.lot, F.faceKey.mul(3.7).add(19.1))).toVar();
      const dU = F.u0.sub(F.W.mul(mix(float(0.24), float(0.76), dh))).toVar();
      const dHalf = u.doorW.mul(0.5);
      const doorM = band(dU, dHalf.negate(), dHalf, F.aaU)
        .mul(band(F.up, float(0.0), u.doorH, F.aaV)).toVar();
      // The surround, and a canopy over it — a door with a lintel reads as an
      // entrance; a dark rectangle on a wall reads as a hole.
      const surM = band(dU, dHalf.add(u.doorFrame).negate(), dHalf.add(u.doorFrame), F.aaU)
        .mul(band(F.up, float(0.0), u.doorH.add(u.doorFrame), F.aaV))
        .sub(doorM).max(0.0).toVar();
      const canM = band(dU, dHalf.add(0.34).negate(), dHalf.add(0.34), F.aaU)
        .mul(band(F.up, u.doorH.add(u.doorFrame), u.doorH.add(u.doorFrame).add(0.17), F.aaV))
        .toVar();
      oCol.assign(mix(oCol, vec3(0.30, 0.31, 0.33), surM.mul(plainOn)));
      oCol.assign(mix(oCol, vec3(0.055, 0.058, 0.065), doorM.mul(plainOn)));
      oCol.assign(mix(oCol, vec3(0.10, 0.10, 0.11), canM.mul(plainOn)));
      // A lamp over the door. Small, warm, and always on — an entrance light
      // is the one light in a city that never goes off.
      oEmis.assign(oEmis.add(vec3(1.0, 0.88, 0.70).mul(
        canM.mul(plainOn).mul(u.nightAmount).mul(u.doorGlow))));

      // One hash per BAY, so a frontage is a shop rather than a whole tower
      // lighting up at once. `faceKey` keeps the four sides different.
      // Does this BUILDING have a lit frontage at all? Industrial never does:
      // a warehouse on the fringe with a neon shopfront is the sort of detail
      // that quietly tells you the city was generated rather than built.
      /*
       * MASONRY ONLY, AND NEVER ON GLASS.
       *
       * Neon belongs on a punched masonry frontage — a shop with a wall around
       * its window. Painted onto a curtain-wall tower it reads as exactly what
       * it is: a coloured shape stuck on a mirror, and at 26% of buildings the
       * downtown core was covered in them. SEEN IN THE GAME: two enormous pink
       * and cyan L's across a glass facade in broad daylight, which is what
       * sent me looking.
       *
       * Industrial never had it. Curtain wall and ribbon slabs now do not
       * either, which leaves it where a real parade of shopfronts would be.
       */
      const lotLit = step(F.h5, u.neonBuildings)
        .mul(numT(F.isPunched))
        .mul(float(1.0).sub(float(F.isIndustrial)));
      const bi = floor(F.u0.div(F.bay)).toVar();
      const h = hash31(vec3(F.lot, bi.mul(1.7).add(F.faceKey.mul(11.3)))).toVar();
      const on = step(h, u.neonFraction).mul(lotLit);
      const ci = floor(fract(h.mul(37.13)).mul(NEON_PALETTE.length - 0.001));
      const col = uNeon.element(uint(ci));

      const lo = u.neonHeight, hi = u.neonHeight.add(u.neonThick);
      // The fascia: a lit band over the shopfront, the length of the bay.
      const fascia = band(F.up, lo, hi, F.aaV);
      // A blade sign standing above it, at one edge of the bay — paint, but at
      // speed a bright vertical bar off a frontage reads as a projecting sign.
      const bu = F.u0.sub(bi.mul(F.bay));
      const blade = band(bu, F.bay.mul(0.08), F.bay.mul(0.08).add(0.5), F.aaU)
        .mul(band(F.up, hi, hi.add(u.neonBladeH), F.aaV))
        .mul(step(fract(h.mul(91.7)), u.neonBladeFraction));

      const lit = fascia.add(blade.mul(1.15)).mul(on)
        .mul(u.neonAmount).mul(u.neonBoost)
        .mul(mix(u.neonDay, float(1.0), u.nightAmount));
      oEmis.assign(oEmis.add(col.mul(lit)));
    });

    // SKYGLOW — the city lighting itself. Multiplied by the surface's own
    // albedo, so it is an ambient light rather than a fog added on top: a
    // pale stone wall picks it up and dark glass barely does.
    oEmis.assign(oEmis.add(oCol.mul(u.glowColor).mul(u.glowAmount).mul(u.nightAmount)));

    return oCol;
  });

  /**
   * normalNode's own solve. It re-runs the pure builders (≈40 ALU) and NOTHING
   * else — no stone colour, no room, no sky. See the header for why it cannot
   * simply read the colour pass's vars.
   */
  const makeNormalSolve = (PIN) => Fn(() => {
    // A MINIMAL frame, not `buildFrame()`. This pass runs on every city pixel,
    // and the full frame solve is a lot texture read, six sin-hashes and the
    // whole per-lot layout — none of which the far path needs. All it needs
    // out here is the brick bump and a LOD gate, so it computes the two
    // world-space quantities the brickwork keys off (`acrossW`, `up`) and
    // nothing else. Measured: this pass was a large share of a 3.2 ms city.
    const D = buildDerivatives();
    const texel = D.texel;
    const nW = normalize(normalWorldGeometry).toVar();
    const isRoof = abs(nW.y).greaterThan(0.5);
    const lot = floor(positionWorld.xz.div(u.lotSize));
    const cell = clamp(lot.sub(uLotOrigin), vec2(0.0), uLotCount.sub(1.0));
    const info = textureLoad(lotTexture, ivec2(cell));
    const up = positionWorld.y.sub(info.r).toVar();
    const isPunched = PIN === null
      ? info.a.lessThan(0.5) : PIN === BUILDING_TYPE.punched;
    const acrossW = positionWorld.x.mul(nW.z).sub(positionWorld.z.mul(nW.x)).toVar();

    // Brick relief for the bump — only on surfaces PARALLEL to the box face,
    // because bumpNormal differentiates a world-space height field in screen
    // space, which is only meaningful on the face plane.
    const rowC = up.div(u.brickH);
    const colC = acrossW.div(u.brickL).add(mod(floor(rowC), 2.0).mul(0.5));
    const dU = float(0.5).sub(abs(fract(colC).sub(0.5)));
    const dV = float(0.5).sub(abs(fract(rowC).sub(0.5)));
    // The example's hand-rolled LOD: the on-screen size of a surface pixel.
    // Cheaper than the face-size solve and enough for both the bevel and the
    // relief gate.
    const bevel = max(texel.mul(1.5), 0.02);
    const face = smoothstep(float(0.0), bevel, dU.mul(u.brickL)).mul(smoothstep(float(0.0), bevel, dV.mul(u.brickH)));
    const isStone = selT(isPunched, float(1.0), float(0.0)).mul(select(isRoof, float(0.0), float(1.0)));
    // A CONSERVATIVE gate: `bayWidth` here stands in for the lot's real bay,
    // which only the full frame knows. Erring wide costs a few pixels of trace
    // and guarantees the normals never switch to flat before the colour does —
    // the reverse would show as a visible seam at the LOD ring.
    const gateAmt = smoothstep(u.lodRelief, u.lodRelief.mul(0.4), texel.div(u.bayWidth.mul(1.6)))
      .mul(u.relief).mul(select(isRoof, float(0.0), float(1.0))).toVar();
    const height = face.mul(u.brickRelief).mul(isStone).mul(gateAmt);

    // THE DERIVATIVES STAY OUT HERE, UNCONDITIONALLY. TSL's `select` does not
    // lower to WGSL's `select()` at this size — it emits a real `if / else` —
    // and a DERIVATIVE INSIDE NON-UNIFORM CONTROL FLOW is undefined behaviour
    // in WGSL: a hard error on some drivers, silently wrong normals on others,
    // and the wrong pixels would be exactly the pier and reveal edges this
    // facade exists for. `bumpNormal` is nothing but dpdx/dpdy of the height
    // field, so it is materialised here and only finished vectors get
    // selected between. tools/cityShaderTest.mjs fails the build if one drifts
    // back inside a branch.
    const bumped = bumpNormal(height).toVar();
    const flatN = normalize(cameraNormalMatrix.mul(nW)).toVar();
    const out = normalize(mix(flatN, bumped, gateAmt)).toVar();

    // The layout solve AND the ray cast both sit behind the gate — neither
    // takes a derivative, so both are safe in a branch, and running them on
    // every distant pixel was most of a 5 ms regression. Off-face hits
    // (flanks, reveals, course soffits) take the hit normal; face-parallel
    // hits keep the bumped one.
    If(gateAmt.greaterThan(0.001), () => {
      const F = buildFrame(D, PIN);
      const T = traceFacade(F);
      const hitN = normalize(cameraNormalMatrix.mul(T.N));
      out.assign(normalize(select(T.front.lessThan(0.5), hitN, out)));
    });
    return out;
  });

  // ── Materials ──────────────────────────────────────────────────────────────
  /**
   * @param {boolean} far  L2 variant: flat paint only, no trace, no rooms,
   *                       no normalNode, no per-brick hashing.
   * @param {number|null} PIN  building type compiled in, or null for the
   *                       combined material that decides it per pixel.
   */
  function buildMaterial(far, PIN) {
    const R = {};
    const m = new THREE.MeshStandardNodeMaterial();
    m.name = (far ? "CityFacadeFar" : "CityFacade")
      + (PIN === null ? "" : TYPE_NAME[PIN]);
    // The city's OWN share of the scene environment, as a plain property so
    // changing it never recompiles — it lets the city sit at a sun-dominant
    // ratio without dragging the terrain and the road down with it.
    m.envMapIntensity = P.envIntensity;

    // colorNode is set up FIRST (NodeMaterial.setup: setupDiffuseColor, then
    // setupVariants, then lighting), so `R.*` is populated by the time these
    // lazy wrappers are built — and they share its flow, so they read the very
    // same variables rather than re-declaring them.
    m.colorNode = makeSurface(R, far, PIN)();
    m.roughnessNode = Fn(() => R.rough)();
    m.metalnessNode = float(0.0);       // all dielectric: stone, glass, metal trim
    m.emissiveNode = Fn(() => R.emissive)();
    m.aoNode = Fn(() => R.ao)();
    if (!far) {
      // A tower past the L1 ring is a few pixels of flat wall; a bumped normal
      // and a per-hit one are the same thing there, and normalNode is the
      // expensive slot because three always builds it in its own sub-build.
      m.normalNode = makeNormalSolve(PIN)();
      // The analytic relief shadows cut DIRECT light only — which is what a
      // shadow is. Folding them into the albedo would darken the sky fill too.
      m.receivedShadowNode = Fn(([shadow]) => shadow.mul(R.shadow));
    }
    return { m, R };
  }

  /**
   * One near/far pair, wired for bloom.
   *
   * vec4, not the vec3 emissive: the MRT attachment is a vec4 struct member
   * and WGSL will not widen an assignment — "cannot assign 'vec3<f32>' to
   * 'vec4<f32>'", an invalid ShaderModule, and a city that silently never
   * draws. Only the GAME hits it; the lab has no MRT target.
   */
  function buildPair(PIN) {
    const { m: near, R: nearR } = buildMaterial(false, PIN);
    const { m: fars, R: farR } = buildMaterial(true, PIN);
    applyBloomMRT(near, Fn(() => vec4(nearR.emissive, 1.0))());
    applyBloomMRT(fars, Fn(() => vec4(farR.emissive, 1.0))());
    return { material: near, farMaterial: fars };
  }

  /*
   * THE COMBINED PAIR IS ALWAYS BUILT, AND THAT IS FREE.
   *
   * Building a material is a JS node graph; the driver only compiles one when
   * something DRAWS with it. So keeping the combined pair around for the
   * BatchedMesh backend — which has a single material for the whole city and
   * therefore cannot use a pinned one — costs nothing at all while the
   * instanced backend is running, and nothing but the JS while it is not.
   */
  const { material, farMaterial } = buildPair(null);
  /** Pinned pairs, indexed by BUILDING_TYPE. Empty when the split is off. */
  const variants = [];
  if (typeSplit) {
    for (const t of [BUILDING_TYPE.punched, BUILDING_TYPE.curtain, BUILDING_TYPE.ribbon]) {
      variants[t] = buildPair(t);
    }
  }
  /** Every material this facade owns, for the settings that are not uniforms. */
  const allMaterials = [material, farMaterial]
    .concat(variants.flatMap((v) => [v.material, v.farMaterial]));

  // ── Live params proxy ──────────────────────────────────────────────────────
  const params = new Proxy(P, {
    set(target, key, value) {
      target[key] = value;
      if (key === "envIntensity") {
        // A plain property, not a uniform — so it has to be set on each one.
        for (const m of allMaterials) m.envMapIntensity = value;
        return true;
      }
      const un = u[key];
      if (un) {
        if (un.value && un.value.isColor) un.value.set(value);
        else un.value = value;
      }
      return true;
    },
  });

  const lotHeights = {
    texture: lotTexture,
    data: lotData,
    size: LOT_TEX_SIZE,
    setOrigin(cellX, cellZ, countX, countZ) {
      uLotOrigin.value.set(cellX, cellZ);
      uLotCount.value.set(
        Math.max(1, Math.min(countX, LOT_TEX_SIZE)),
        Math.max(1, Math.min(countZ, LOT_TEX_SIZE)),
      );
    },
    clear: clearLots,
  };

  return {
    material,
    /** The L2 variant: same uniforms and lot texture, a much cheaper shader. */
    farMaterial,
    /** Every material, for anything that is a property rather than a uniform. */
    allMaterials,
    /** True when there is a pinned pair per building type to pick from. */
    typeSplit: variants.length > 0,
    /**
     * The material for a building of this TYPE at this TIER.
     *
     * Falls back to the combined pair when the split is off, so a caller that
     * does not care — or a BatchedMesh, which cannot care — needs no branch.
     */
    materialFor(btype, far) {
      const v = variants[btype];
      if (!v) return far ? farMaterial : material;
      return far ? v.farMaterial : v.material;
    },
    uniforms: u, params, lotHeights,
    /** Advance the window-churn clock. Seconds. */
    setTime(t) { uTime.value = t; },
    /** Direction TO the sun, world space — the relief shadows follow it. */
    /**
     * Direction TO the sun, and optionally its colour.
     *
     * The colour matters for the glint specifically: a sunset flash off a
     * tower should be orange because the sun is, and reading it from the sky
     * module means there is one set of numbers rather than two that drift.
     */
    setSun(dir, color) {
      if (dir) uSunDir.value.copy(dir);
      if (color) uSunCol.value.copy(color);
    },
    /**
     * The gradient the glass mirrors. Hand it the sky module's own colours and
     * the reflection tracks time of day exactly — sunset glass goes orange
     * because the sky did, with no second set of numbers to keep in step.
     */
    setSkyColors(zenith, horizon, ground) {
      if (zenith) u.skyZenith.value.copy(zenith);
      if (horizon) u.skyHorizon.value.copy(horizon);
      if (ground) u.skyGround.value.copy(ground);
    },
  };
}
