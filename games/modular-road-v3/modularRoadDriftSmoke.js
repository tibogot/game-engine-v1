import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  attribute, cameraFar, cameraNear, cameraPosition, Discard, dot, exp, float,
  Fn, length, max, min, mix, normalize, oneMinus, perspectiveDepthToViewZ,
  positionView, positionWorld, pow, saturate, screenUV, smoothstep, sqrt,
  texture, uniform, uv, vec2, vec3, vec4, viewportDepthTexture,
} from "three/tsl";

/**
 * Rear-wheel drift smoke for modular-road test drive.
 *
 * Camera-facing billboards, pooled, one draw call. The SHAPE of each puff is
 * procedural (see `makeSmokeNoiseTexture`) rather than a sprite: there is no
 * smoke .png any more, and deliberately so.
 *
 * ── WHY THE SPRITE WENT AWAY ──────────────────────────────────────────────────
 * The old texture was a 3.6 KB featureless white gaussian. The eye reads "volume"
 * almost entirely from internal contrast at several scales, and a radial gradient
 * has none — so no amount of simulation tuning could make it look like anything
 * but a stack of grey dots. Three things replace it, and together they are most
 * of what separates this from the old look:
 *
 *   1. EROSION, not fading. Each puff's alpha is a threshold against a lumpy
 *      density field, and the threshold RISES over life. So a puff dissolves
 *      from its thin edges inward and breaks into wisps, the way smoke actually
 *      disperses, instead of uniformly dimming like a sprite on a fade curve.
 *      This is the single biggest contributor — more than the texture itself.
 *   2. A per-particle noise frame (random offset + scale, drifting slowly over
 *      life). Every puff therefore has its own silhouette AND churns internally,
 *      where before all 256 were the same circle at different rotations.
 *   3. SOFT DEPTH FADE against the scene depth buffer. Untouched, the quads
 *      intersect the road deck along a razor line, which is the single most
 *      obvious "these are cards" tell in the whole effect.
 *
 * Alongside those: many more, much thinner particles. Volumetric appearance comes
 * from accumulated overlap of near-transparent layers; the old settings had few,
 * thick layers, which is exactly the confetti look.
 */

/**
 * Scene depth grab, shared by every smoke system (there is only ever one, but a
 * ViewportTextureNode issues its own full-res framebuffer copy per render, so it
 * lives at module scope on principle — same reasoning as v3's water).
 */
const _sceneDepthTex = /*#__PURE__*/ viewportDepthTexture();

/**
 * WET SPRAY — the same puff system, wearing a different coat.
 *
 * ON A SOAKED ROAD A TYRE DOES NOT SMOKE, IT SPRAYS, and that is why this is a
 * look SWAP rather than a second particle class running alongside. Rubber smoke
 * needs a dry, hot, sliding tyre; standing water needs neither heat nor slip —
 * the contact patch simply throws the film it displaces. So the two are close to
 * mutually exclusive in reality, and swapping is more truthful than adding.
 *
 * It is also what the emitter can actually express. `opacity` is read once per
 * class in `_stepPool` and the colour ramp is global, so two looks cannot share
 * one pool without per-particle opacity and tint fields. Blending the CLASS
 * settings by wetness gets the effect with no new pool, no new mesh, no extra
 * draw call, and no risk of a heavy spray starving the smoke budget.
 *
 * The differences from smoke are all physical:
 *   - WHITE, not grey. Water scatters; carbon absorbs.
 *   - THINNER and SHORTER-LIVED. A droplet plume is transparent and falls out
 *     of the air in well under a second; smoke hangs.
 *   - THROWN, not risen. Smoke is buoyant and climbs; spray is flung backwards
 *     by the tread and drops, so `rise` goes down and `drag` up.
 *   - SMALLER, and many more of them.
 */
export const DEFAULT_WET_SPRAY_SETTINGS = {
  /**
   * Separate from the smoke's own `enabled`, and it has to be.
   *
   * These are one particle SYSTEM but two EFFECTS, and a switch labelled "drift
   * smoke" silently taking rain spray with it is a trap. Splitting the gate
   * costs nothing — same pool, same mesh, same single draw, all of which exist
   * either way — because the only thing a gate decides here is which particles
   * get emitted. With both off you get exactly what one flag gave you: nothing
   * emitted, nothing drawn, pool reset.
   */
  enabled: true,
  /** Emitted whenever the car is MOVING on a wet road — no drift required.
   *  This is the whole point: spray is a function of speed and water, not slip. */
  /**
   * Many and thin. Split across four contacts by `_emit`, so the total rate is
   * the same whether two wheels are throwing or four.
   *
   * CEILING: this and `lifeMax` together decide how much of the 1024-slot pool
   * the spray occupies — steady state is `2 * emitRate * meanLife`. At 800 and
   * a 0.18–0.42 s life that is ~480 typical and ~670 worst case, which leaves
   * the drift smoke room to co-exist. Push either much higher and the ring
   * buffer starts recycling live particles, which reads as the plume flickering.
   */
  emitRate: 950,
  /** Road speed (m/s) at which spray starts. Well below the smoke threshold —
   *  you kick up water long before you can break traction. */
  entrySpeed: 4,
  /**
   * Very low, because a streak overlaps ITSELF. Successive particles from one
   * wheel land on nearly the same line, so whatever each one contributes gets
   * multiplied by however many are stacked along it — at smoke's 0.12 the four
   * wheels drew four solid white ropes.
   */
  /**
   * Well above smoke's, which is counter-intuitive until you count area.
   *
   * Every time the grain gets finer the plume gets fainter, because what you
   * see is opacity times the area covered — and area falls with the SQUARE of
   * the width. Going from a 0.14 m particle to a 0.06 m one is a bit over a
   * fifth of the cross-section each. So thin lines have to be paid for
   * per-streak, or they simply disappear; both times the grain came down here,
   * the first attempt vanished because this number stayed where it was.
   *
   * The ceiling is that a streak should still be translucent. Push this much
   * past ~0.35 and they stop looking like water and start looking like white
   * scratches drawn on the lens.
   */
  opacity: 0.30,
  lifeMin: 0.18,
  lifeMax: 0.42,
  /**
   * GRAIN. Thin across — with the volume elongated along its travel the radius
   * is only the streak's width, so length comes from the shutter, not from size.
   *
   * And SMALL. This is most of what separates spray from smoke seen from
   * behind, where elongation alone cannot carry the read: at a
   * quarter of a metre across, a particle is a blob however white you make it,
   * and a plume of blobs is cotton wool. Water arrives as a fine mist, and the
   * only way to say that with billboards is a lot of very small ones.
   */
  sizeMin: 0.022,
  sizeMax: 0.06,
  /**
   * Barely grows. Growth is what turns a line back into a smudge — it widens
   * the streak over its life, and a streak that thickens as it ages stops
   * reading as a droplet and starts reading as smoke again. Kept just above 1
   * so the tail of the plume softens rather than staying a hard ribbon.
   */
  sizeGrowth: 1.2,
  // ── THE ROOSTER TAIL ─────────────────────────────────────────────────────
  //
  // The shape you actually recognise from behind a car in the rain is a CONE
  // that climbs out of the wheels and falls away — not a plume hugging the
  // tarmac. This was two ground-level ropes because the launch was barely off
  // the road and nothing pulled it back down, so there was no arc to see.
  //
  // An arc needs both halves: thrown up hard, then dragged down. Smoke wants
  // neither, which is why all three of these have to be blended in per-wetness
  // rather than inherited (see `_puffSettings`).
  /** Upward launch off the tread, m/s. Nothing like smoke's gentle 0.28 lift. */
  rise: 2.4,
  /** Gravity, m/s². NEGATIVE — smoke's `buoyancy` climbs, water falls, and the
   *  fall is what closes the arc into a tail instead of a fountain. Softer than
   *  real gravity because these live under half a second and `damp` is already
   *  taking energy out of them. */
  buoyancy: -3.5,
  /** Droplets do not churn the way smoke does; they are pulled apart by air,
   *  not by their own convection. Well below the smoke value. */
  turbulence: 0.6,
  /**
   * Air drag. Modest, and that is a correction: 2.2 DETACHED the plume.
   *
   * `drag` launches a droplet backwards at a fraction of road speed, and damp
   * is what takes that away again. Strip it fast and the particle simply stops
   * in world space while the car keeps going at 32 m/s — so the whole plume
   * separates and there is nothing behind the wheels at all, which is exactly
   * what it looked like. Keeping most of the launch velocity means the spray
   * travels WITH the car and trails from it.
   */
  damp: 0.9,
  /** Fraction of road speed a droplet leaves with. High, because a tyre throws
   *  water into the car's wake rather than into still air. */
  drag: 0.78,
  spread: 1.0,
  /**
   * How far the particle is drawn out along its direction of travel, as a
   * multiple of its radius. THE SINGLE BIGGEST DIFFERENCE from smoke.
   *
   * A puff of smoke is round because it is slow: it leaves the tyre and then
   * churns in place. Spray leaves at most of the road speed and is gone in half
   * a second, so within one frame each droplet cluster travels many times its
   * own width and the eye sees a STREAK. Round white puffs at 100 km/h read as
   * cotton wool no matter what you do to their colour or opacity.
   *
   * Applied to the VOLUME, not the card — the particle here is a ray-traced
   * sphere, so this makes it a prolate ellipsoid. Stretching only the quad
   * would achieve nothing: the intersection test would still carve a sphere out
   * of the middle of it.
   */
  /**
   * Shutter multiplier — streak length, as a multiple of BASE_SHUTTER.
   *
   * NOT a length in metres and not a stretch factor. Each streak is drawn along
   * however far its droplet moves ACROSS THE FRAME in one shutter, so length is
   * a consequence of the motion rather than a number you dial: parked, spray
   * has no apparent motion and draws dots; at speed the same setting draws
   * lines.
   *
   * This replaced an ellipsoid stretched along the car's heading, which cannot
   * work from a chase camera — that axis points nearly down the view ray and
   * projects onto the screen by only ~0.16, so every streak foreshortened back
   * into a blob however far it was stretched. Apparent motion is largest
   * exactly where the heading projects to nothing, because a droplet receding
   * from the lens still sweeps toward the vanishing point.
   */
  streak: 1.0,
  /**
   * Outward fling, m/s, along the car's lateral axis and away from its centre.
   *
   * The rooster tail behind the car is only half of what you see in the rain.
   * The other half is the SHEET each wheel throws sideways, and from a chase
   * camera the front wheels are the ones doing it in view. Zero here and all
   * four wheels emit into the same narrow band behind the car.
   */
  sideThrow: 3.2,
  /** A streak must not tumble. Spin reads as a rotating sprite the moment a
   *  particle stops being round, which is exactly what a streak is. */
  spinRate: 0,
  /** Water is white and stays white; there is no hot/cool ageing to it. */
  colorHot: 0xdfe6ec,
  colorCool: 0xc8d2dc,
};

export const DEFAULT_DRIFT_SMOKE_SETTINGS = {
  enabled: true,
  emitRate: 150,
  trigger: 0.04,
  /** How the puffs look once the road is wet — see DEFAULT_WET_SPRAY_SETTINGS.
   *  Blended in by `setWetness`, so a dry track is untouched. */
  wetSpray: { ...DEFAULT_WET_SPRAY_SETTINGS },
  /**
   * Per-puff peak alpha. LOW on purpose. Density is meant to come from many
   * overlapping thin layers, not from a few opaque ones — at 0.5 (the old value)
   * you can pick out every individual quad.
   */
  opacity: 0.22,
  sizeMin: 0.42,
  sizeMax: 0.85,
  sizeGrowth: 3.4,
  lifeMin: 0.8,
  lifeMax: 1.9,
  rise: 0.75,
  spread: 0.55,
  drag: 0.12,
  /** Legacy flat tint. Only used if colorHot/colorCool are cleared. */
  color: "",

  // ── WHAT MAKES IT READ AS SMOKE RATHER THAN GREY SPRITES ──────────────────
  /**
   * Tyre smoke is DENSE and dark where it leaves the contact patch, and pales
   * as it expands and thins. A single flat tint is the main reason billboard
   * smoke looks like confetti — the puffs never change, so the eye reads them
   * as a repeating sprite instead of a dispersing volume.
   */
  colorHot: "#4a4a52",   // fresh at the contact patch
  colorCool: "#b4b8c2",  // thinned out and drifting
  /**
   * Per-particle brightness spread, ±fraction. Even with the hot→cool ramp,
   * two puffs of the same age are otherwise the exact same colour, which the
   * eye picks up as a repeat.
   */
  tintJitter: 0.12,
  /**
   * Fraction of life spent fading IN. Without it every particle appears at full
   * opacity, which pops visibly at the emitter — the single most obvious tell.
   */
  fadeIn: 0.15,
  /**
   * Swirl. Real smoke is turbulent; straight-line particles with drag look
   * ballistic. Applied as an ACCELERATION (not a position offset) so it
   * accumulates into curling paths instead of a uniform wobble.
   */
  turbulence: 1.5,
  /** Upward acceleration over life — hot rubber smoke keeps climbing rather
   *  than coasting to a stop under drag. */
  buoyancy: 0.55,
  // ── LIGHTING ──────────────────────────────────────────────────────────────
  /**
   * Master lighting amount, 0..1. 0 leaves the flat unlit tint (what this
   * effect used to be); 1 is the full per-pixel model below.
   *
   * Each pixel gets a normal off an imaginary SPHERE — n = (p.x, p.y, √(1-r²))
   * in the quad's own basis — so a puff shades like a ball of smoke rather than
   * carrying a gradient across a card. That is the difference between "a sprite
   * with a highlight" and something the eye accepts as having a near and a far
   * side.
   */
  sunTint: 1.0,
  /** Floor brightness. Smoke away from the sun is lit by the sky, not black. */
  ambient: 0.5,
  /** Direct sun term. Wrapped (N·L*0.5+0.5), because participating media stays
   *  lit well past the terminator — clamped Lambert makes smoke look solid. */
  sunStrength: 0.9,
  /**
   * Beer-Lambert self-shadowing. Light reaching the visible surface falls off as
   * exp(-density * absorb), so the thick middle of a puff goes dark and the thin
   * edges stay bright. This is what stops a plume reading as uniform white paste.
   */
  absorb: 1.0,
  /**
   * Henyey-Greenstein forward scattering. Puffs between the camera and the sun
   * light up around the rim — the silver-lining effect. Arguably the single
   * strongest "this is a volume" cue there is, and it costs one pow().
   */
  scatter: 1.2,
  /** HG anisotropy, 0..0.95. Higher = tighter, brighter forward lobe. */
  hgG: 0.6,

  // ── SHAPE ─────────────────────────────────────────────────────────────────
  /**
   * Noise tiles across the quad. ~1 means the puff spans roughly one tile, so
   * the lobes are a quarter of the puff across — cauliflower, not static.
   * Higher gets wispier and busier, lower gets blobbier.
   */
  noiseScale: 1.0,
  /** Tiles/second the noise frame slides over a puff's life. This is the
   *  internal churn: 0 freezes each puff's pattern the moment it is born. */
  noiseDrift: 0.12,
  /** Erosion threshold at birth. Above ~0.3 puffs are born already ragged. */
  erodeStart: 0.06,
  /**
   * Erosion threshold at death. Must exceed peak density (~1.27) for a puff to
   * vanish completely on its own; the alpha tail covers it if not.
   */
  erodeEnd: 1.25,
  /** Width of the erosion ramp. Small = crisp torn edges, large = soft haze. */
  erodeSoft: 0.3,
  /**
   * How much of the erosion field is sampled in WORLD space rather than in each
   * quad's own UV, 0..1.
   *
   * THIS IS WHAT MAKES A PLUME READ AS ONE MASS INSTEAD OF 400 BEADS. With
   * quad-space noise alone every puff tears along its own private filaments, so
   * however densely they overlap the eye still separates them. Sampled in world
   * space, neighbouring puffs cut along the SAME filaments and visually fuse.
   * Blended rather than pure, because pure world-space also kills the tumbling —
   * the quad-space half is what still churns per particle.
   */
  worldNoiseMix: 0.55,
  /** Tiles per metre for the world-space field. ~0.6 puts features around 1.5 m,
   *  i.e. bigger than one puff, which is the point. */
  worldNoiseScale: 0.6,
  /**
   * Metres/second the world field drifts. Shared by every particle, so puffs
   * still fuse — but the structure advects instead of being pinned to the world,
   * which otherwise looks like smoke passing behind a dirty window.
   */
  worldNoiseDrift: 0.35,
  /**
   * Metres over which a puff fades out as it approaches whatever is behind it.
   * This is what stops the quads slicing the tarmac along a hard line. 0 off.
   */
  softDepth: 0.9,

  /**
   * ── THE LINGERING BANK ────────────────────────────────────────────────────
   * A second, much slower class of particle sharing the same pool, mesh and
   * shader. Big, near-transparent, barely buoyant, and alive for the best part
   * of ten seconds.
   *
   * The puffs above are a SPRAY: each dies inside two seconds, so however many
   * there are the plume never becomes a mass that outlives the moment. These do
   * the opposite — individually almost invisible (opacity ~0.05), but ~200 are
   * alive at once and overlapping, so they integrate into a bank of smoke that
   * settles over the tarmac and is still there on the next lap. Accumulation
   * comes from the overlap, not from any one particle.
   *
   * Kept on its own slot budget (HAZE_POOL_SIZE) precisely so a ten-second
   * lifetime can never starve the two-second one.
   */
  haze: {
    enabled: true,
    /** Per rear wheel. Few, because each one ends ENORMOUS — see sizeGrowth. */
    emitRate: 8,
    lifeMin: 8,
    lifeMax: 16,
    sizeMin: 2,
    sizeMax: 3.4,
    /**
     * ×3.2 on top of a 3.4 m start — a bank particle dies about 14 m across.
     * Big terminal size is the whole point: a drift cloud is metres of smoke,
     * not a denser spray of car-sized puffs.
     */
    sizeGrowth: 3.2,
    /**
     * Growth exponent. The puffs use 0.5 (√age) because turbulent diffusion
     * widens fast then slows — right for something that exists for a second.
     * A bank has to KEEP growing for its whole life, so it runs closer to
     * linear; with √age it reaches nearly full size in the first two seconds
     * and then just sits there.
     */
    growthPower: 0.85,
    opacity: 0.075,
    /**
     * Fraction of life held at full opacity before fading at all.
     *
     * THIS IS WHAT MAKES IT END BIG. With the puffs' plain (1-age) tail, a
     * particle is at its most transparent exactly when it is at its largest, so
     * the cloud can never visibly grow — every gain in size is cancelled by a
     * loss in opacity. Holding opacity through the first 55% of life lets the
     * mass build while it expands, and only then disperses.
     */
    fadeOutStart: 0.55,
    tailPower: 1,
    /**
     * Erosion held back the same way (2.6 vs the puffs' 1.3): a bank thins out
     * late, it does not start tearing apart while it is still growing.
     */
    erodeStart: 0.18,
    erodeEnd: 1.15,
    erodePower: 2.6,
    /** Rises and billows. An earlier pass pinned this flat to the tarmac, which
     *  read as ground fog — real drift smoke lifts into a column behind the car. */
    rise: 0.35,
    buoyancy: 0.25,
    /** Low damping so it keeps spreading OUTWARD. The cloud has to grow in
     *  extent, not only in per-particle size, or it stays a narrow ribbon
     *  smeared along wherever the car happened to drive. */
    damp: 0.7,
    spread: 2.2,
    drag: 0.05,
    turbulence: 0.35,
    spinRate: 0.35,
    fadeIn: 0.25,
    /** Below 1 = features LARGER than the quad, so a haze particle is a piece of
     *  a big soft shape rather than a scaled-up copy of a puff. */
    noiseScale: 0.55,
    noiseDrift: 0.05,
    /** Its own world-noise frequency, so the bank fuses along metre-scale
     *  filaments while the puffs keep fusing along their own finer ones. */
    worldScaleMul: 0.4,
    /** Leans harder on the VOLUMETRIC sample than the puffs do (×1.6 on the
     *  global mix). The bank is the class you get time to drive past, so it is
     *  the one whose interior has to move with parallax rather than sit on a
     *  plane; a puff is gone before the eye could tell either way. */
    worldMixMul: 1.6,
    tintJitter: 0.1,
    colorHot: "#6e6f78",
    colorCool: "#c2c6d0",
  },
};

/**
 * Pool size. 4× the old 256, which was SATURATED during a real drift (128
 * emits/s across both wheels × 1.9 s life ≈ 243 alive), meaning any lifetime
 * increase silently starved the emitter instead of lasting longer.
 */
const POOL_SIZE = 1024;
/**
 * Separate slot budget for the lingering bank. A haze particle lives 5× longer
 * than a puff, so sharing one pool would let the slow class squat on slots the
 * fast one needs and quietly throttle the plume. Same buffers, same draw call —
 * only the accounting is separate.
 */
const HAZE_POOL_SIZE = 320;
const TOTAL_POOL = POOL_SIZE + HAZE_POOL_SIZE;
const VERTS_PER_PARTICLE = 6;
const FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 3;
const TINT_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 4;
const NOISE_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 4;
const SPHERE_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 4;
const CLASS_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 2;
/**
 * The quad has to circumscribe the SPHERE'S SCREEN PROJECTION, not the sphere.
 * A sphere of radius R at distance d subtends asin(R/d); a quad of half-width R
 * only spans atan(R/d), which is smaller — so an exactly-sized quad clips its
 * own sphere's silhouette, and worse the closer you get.
 *
 * This used to be a flat 1.2× fudge. That is exact at R/d ≈ 0.55 and wrong
 * everywhere else, in both directions:
 *   • far away it is 20% too big, and quad area is pure overdraw — the corners
 *     miss the sphere and discard, but they are rasterised and shaded first;
 *   • close up it is far too small. A grown puff reaches R ≈ 2.3 m and the chase
 *     camera passes within a metre of it, so the SQUARE quad boundary cut
 *     straight through the ROUND silhouette. That is the "I can see flat planes"
 *     artifact, and it was never the shading — it was the quad running out.
 *
 * The exact half-width is R / √(1 − (R/d)²). (The silhouette circle has radius
 * R·√(d²−R²)/d at distance (d²−R²)/d; projecting it back onto the plane
 * through the centre gives R·d/√(d²−R²).) It tends to R at distance — so most
 * puffs on screen now get a SMALLER quad than before, which is free overdraw
 * back — and diverges as the camera reaches the surface, which is what this cap
 * and the proximity fade below are for.
 */
const K_MAX = 0.9;
/**
 * Camera-proximity fade for the puffs, in two terms, whichever is smaller.
 *
 * A billboard is a plane at the particle's CENTRE, so the moment that centre
 * crosses the camera's near plane (0.5 m in this engine) the entire quad is
 * clipped along a straight line. The chase camera trails 7.5 m behind the car
 * and puffs live 0.8–1.9 s, so at speed it flies through the plume continuously
 * — this was firing constantly and nothing handled it.
 *
 * Fading before the clip is what every shipped particle system does, and it is
 * also what keeps K_MAX honest: by the time the exact quad would need to be
 * 2.3× the sphere radius, the particle is already invisible.
 */
const K_FADE_START = 0.6;
/**
 * Base shutter, seconds — the exposure a spray streak represents.
 *
 * A streak's length is the distance its droplet covers ACROSS THE FRAME in this
 * long, so this is the same dial a camera's shutter speed is, and the
 * `wetSpray.streak` setting is a multiplier on it. Around a 25th of a second:
 * long enough that spray at speed draws a clear line, short enough that a slow
 * droplet stays a dot rather than smearing into a scratch.
 */
const BASE_SHUTTER = 1 / 25;
/**
 * Ceiling on a streak's half-length, as a tangent — so `depth * this` is the
 * cap in world units, and it means the same fraction of the frame at every
 * distance. At 0.25 against this camera's ~50° vertical field, a streak can run
 * about half the frame height end to end; past that a droplet is not motion
 * blur any more, it is a scratch on the lens.
 *
 * A backstop, not a look dial. The thing it backstops is the 1/z in the streak
 * axis (see `_stepPool`), which is a projection derivative and therefore
 * unbounded as a particle approaches the plane of the lens.
 */
const STREAK_MAX_SWEEP = 0.25;
/** Near-plane guard, in DEPTH along the view axis — not radial distance. Fully
 *  gone at OUT, back to full strength at IN, both comfortably outside the 0.5 m
 *  near plane. Depth is the measure because that is what the near plane cuts
 *  on; see the guard in `_stepPool`. */
const NEAR_FADE_OUT = 0.55;
const NEAR_FADE_IN = 1.2;
/**
 * The bank's equivalent, in units of its OWN radius rather than metres. A bank
 * sphere is up to 14 m across and the camera is inside one for most of a drift,
 * so an absolute fade would delete the bank outright. This only retires a sphere
 * once the camera is WELL inside it (40% of the radius from the centre), which
 * stops the innermost few from flat-greying the screen while every other sphere
 * around the camera keeps rendering.
 */
const BANK_FADE_IN = 1.0;
const BANK_FADE_OUT = 0.4;
const UV_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 2;

const EMIT_RATE = 48;
const LIFE_MIN = 0.65;
const LIFE_MAX = 1.45;
const SIZE_MIN = 0.55;
const SIZE_MAX = 1.05;
const SIZE_GROWTH = 2.6;
const OPACITY = 0.55;
const RISE = 0.75;
const SPREAD = 0.55;
const SPEED_DRAG = 0.12;
const _smokeTint = new THREE.Color();
const _smokeHot = new THREE.Color();
const _smokeCool = new THREE.Color();
/** Scratch for the wet-spray colour cross-fade — see _puffSettings. */
const _wetTmp = new THREE.Color();
/** Sun direction (TOWARD the sun), fed in by the game. Identity = straight up. */
const _smokeSun = new THREE.Vector3(0, 1, 0);
const SMOKE_COLOR_HEX = 0x6a6c76;

/** Billboard corners as two triangles. Hoisted: this used to be rebuilt inside
 *  _writeParticle, i.e. seven array allocations per particle per frame (~1000/frame
 *  at a full pool) for a constant. */
const _CORNERS = [
  [-1, -1], [1, -1], [-1, 1],
  [1, -1], [1, 1], [-1, 1],
];

const ENTRY_SPEED = 8;
const INTENSITY_MIN = 0.04;
/** How much a tyre at its LONGITUDINAL limit smokes, vs a sideways slide. Lower
 *  than the mark's equivalent: a braking tyre scrubs a line but does not throw
 *  the cloud a drift does, and a full-strength puff under every stop reads as a
 *  car permanently on fire. 0 disables it. */
const BRAKE_SMOKE = 0.45;

const DRIFT_ANGLE_MIN = 0.1;
const MARK_Y_OFFSET = 0.045;
/** A "normal daylight" DirectionalLight intensity in this engine. See setSunColor. */
const SUN_REFERENCE_INTENSITY = 2.5;

const _smokeRight = new THREE.Vector3();
const _smokeUp = new THREE.Vector3();
/** Camera world position, refreshed once per frame in `update`. Drives the
 *  exact quad size and the proximity fade. */
const _camPos = new THREE.Vector3();
const _camPrev = new THREE.Vector3();
const _camVel = new THREE.Vector3();
const _smokeFwd = new THREE.Vector3();
/** Particle velocity relative to the camera — scratch for the streak axis. */
const _relVel = new THREE.Vector3();
const _toPart = new THREE.Vector3();
const _smokeCorner = new THREE.Vector3();
const _smokeHalfRight = new THREE.Vector3();
const _smokeHalfUp = new THREE.Vector3();
const _smokeUvs = [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1];

const _velHoriz = new THREE.Vector3();
const _chassisFwd = new THREE.Vector3();
const _rearContact0 = new THREE.Vector3();
const _rearContact1 = new THREE.Vector3();
const _scratchVel = new THREE.Vector3();
const _wheelFwd = new THREE.Vector3();
const _wheelRight = new THREE.Vector3();
const _rearPoints = [_rearContact0, _rearContact1];

/**
 * ── ALL FOUR WHEELS, BUT ONLY IN THE RAIN ────────────────────────────────────
 *
 * Rubber smoke is a rear-wheel event on this car, and dry behaviour is left
 * exactly as it was. Water is not: every tyre in contact displaces the film it
 * rolls through, and from a chase camera the FRONT wheels are the ones you see
 * throwing sheets out sideways past the doors. Emitting from the rears only is
 * most of why the spray reads as a puff of exhaust rather than as a car moving
 * through standing water.
 *
 * `_contactSide` carries which way is outboard for each contact, so a wheel can
 * fling away from the car's centreline instead of straight back — see
 * `sideThrow`. +1 is the car's right.
 */
const _frontContact0 = new THREE.Vector3();
const _frontContact1 = new THREE.Vector3();
const _sprayPoints = [_frontContact0, _frontContact1, _rearContact0, _rearContact1];
const _contactSide = [1, -1, 1, -1];
/** Car right, in world space — the axis `sideThrow` flings along. */
const _sprayRight = new THREE.Vector3(1, 0, 0);

// ─── Procedural puff shape ────────────────────────────────────────────────────

const NOISE_SIZE = 256;
/** Baked once, shared by every instance. ~10 ms, one time, 256 KB on the GPU. */
let _noiseTexture = null;

/** Integer hash → [0,1). Math.imul keeps the multiplies in 32-bit. */
function ihash(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/**
 * Value noise on a lattice that WRAPS at `period`. Tileability is not a nicety
 * here: puffs sample the texture at arbitrary offsets with RepeatWrapping, so a
 * non-tiling texture would put a visible seam through random puffs.
 */
function pvnoise(x, y, period, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period;
  const y0 = ((iy % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const n00 = ihash(x0, y0, seed);
  const n10 = ihash(x1, y0, seed);
  const n01 = ihash(x0, y1, seed);
  const n11 = ihash(x1, y1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/**
 * Billowy turbulence — sum of |2n-1|, inverted. The absolute value creases the
 * noise at every zero crossing, which is what gives smoke and cumulus their
 * cauliflower lobes; plain FBM is far too smooth and reads as fog.
 */
function billow(u, v, basePeriod, octaves, seed) {
  let amp = 1;
  let norm = 0;
  let sum = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * Math.abs(pvnoise(u * p, v * p, p, seed + o * 101) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return 1 - sum / norm;
}

/** Plain tileable FBM, used only for the fine edge fray. */
function fbm(u, v, basePeriod, octaves, seed) {
  let amp = 1;
  let norm = 0;
  let sum = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * pvnoise(u * p, v * p, p, seed + o * 71);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/**
 * R = coarse billow (the lobes), G = fine detail (the fray at the eroded edge).
 * Both are normalised across the whole image rather than by their theoretical
 * range: turbulence never reaches its bounds, so an analytic remap would waste
 * most of the 8 bits and the erosion thresholds would all bunch up.
 */
function makeSmokeNoiseTexture() {
  if (_noiseTexture) return _noiseTexture;
  const n = NOISE_SIZE;
  const coarse = new Float32Array(n * n);
  const fine = new Float32Array(n * n);
  let cMin = Infinity, cMax = -Infinity, fMin = Infinity, fMax = -Infinity;
  for (let y = 0; y < n; y++) {
    const v = y / n;
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const i = y * n + x;
      const c = billow(u, v, 4, 4, 1337);
      const f = fbm(u, v, 12, 3, 8501);
      coarse[i] = c;
      fine[i] = f;
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
      if (f < fMin) fMin = f;
      if (f > fMax) fMax = f;
    }
  }
  const cScale = 255 / Math.max(cMax - cMin, 1e-6);
  const fScale = 255 / Math.max(fMax - fMin, 1e-6);
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = (coarse[i] - cMin) * cScale;
    data[i * 4 + 1] = (fine[i] - fMin) * fScale;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // Data, not colour: an sRGB decode here would crush the low end of the
  // density field and shift every erosion threshold.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  _noiseTexture = tex;
  return tex;
}

export class ModularRoadDriftSmoke {
  /**
   * @param {THREE.Scene} scene
   * @param {typeof DEFAULT_DRIFT_SMOKE_SETTINGS} [settings]
   */
  constructor(scene, settings = DEFAULT_DRIFT_SMOKE_SETTINGS) {
    this.settings = settings;

    const positions = new Float32Array(TOTAL_POOL * FLOATS_PER_PARTICLE);
    const tints = new Float32Array(TOTAL_POOL * TINT_FLOATS_PER_PARTICLE);
    const noise = new Float32Array(TOTAL_POOL * NOISE_FLOATS_PER_PARTICLE);
    const spheres = new Float32Array(TOTAL_POOL * SPHERE_FLOATS_PER_PARTICLE);
    const classes = new Float32Array(TOTAL_POOL * CLASS_FLOATS_PER_PARTICLE);
    const uvs = new Float32Array(TOTAL_POOL * UV_FLOATS_PER_PARTICLE);
    for (let i = 0; i < TOTAL_POOL; i++) {
      uvs.set(_smokeUvs, i * UV_FLOATS_PER_PARTICLE);
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr);
    // Named `aTint`, not `color`: a node material treats a `color` attribute as
    // the built-in vertex-colour slot, and this one is driven entirely by hand.
    const tintAttr = new THREE.BufferAttribute(tints, 4);
    tintAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aTint", tintAttr);
    const noiseAttr = new THREE.BufferAttribute(noise, 4);
    noiseAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aNoise", noiseAttr);
    const sphereAttr = new THREE.BufferAttribute(spheres, 4);
    sphereAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aSphere", sphereAttr);
    const classAttr = new THREE.BufferAttribute(classes, 2);
    classAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aClass", classAttr);
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setDrawRange(0, 0);

    this.noiseMap = makeSmokeNoiseTexture();
    this.uSoftDepth = uniform(settings.softDepth ?? 0.9);
    this.uErodeSoft = uniform(Math.max(0.01, settings.erodeSoft ?? 0.3));
    /** World-space direction TOWARD the sun. Dotted per pixel against the real
     *  sphere normal, and against the view ray for the scattering phase. */
    this.uSunWorld = uniform(new THREE.Vector3(0, 1, 0));
    this.uLightAmount = uniform(settings.sunTint ?? 1);
    this.uAmbient = uniform(settings.ambient ?? 0.5);
    this.uSunStrength = uniform(settings.sunStrength ?? 0.9);
    this.uAbsorb = uniform(settings.absorb ?? 1);
    this.uScatter = uniform(settings.scatter ?? 1.2);
    this.uHgG = uniform(settings.hgG ?? 0.6);
    this.uSunColor = uniform(new THREE.Color(1, 1, 1));
    this.uWorldMix = uniform(settings.worldNoiseMix ?? 0.55);
    this.uWorldScale = uniform(settings.worldNoiseScale ?? 0.6);
    /** Shared slow advection of the world field. Accumulated, not derived from a
     *  clock, so changing the drift speed never jumps the pattern. */
    this.uWorldDrift = uniform(new THREE.Vector2(0, 0));
    /** The bank's own world-noise frequency, so it fuses at metre scale. */
    this.uBankScale = uniform(settings.haze?.worldScaleMul ?? 0.4);

    /** True while the spray (streak) shading path is the mesh's material. */
    this._streakOn = false;
    /** Shutter, seconds. How much of a droplet's travel one streak represents —
     *  the same dial a camera's exposure time is. Scaled by `streak`. */
    this._shutter = 0;
    /** Apparent (screen-plane) velocity of the particle being written, in m/s.
     *  Set in `_stepPool`, consumed by `_writeParticle`. */
    this._streakX = 0;
    this._streakY = 0;

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      // The shader already does EXACT per-pixel occlusion — the chord is clipped
      // by scene depth, so anything behind solid geometry comes out with zero
      // thickness and discards. The depth TEST on top of that is pure downside:
      // it accepts or rejects the WHOLE quad on the depth of its centre plane,
      // so a puff whose centre is behind a guardrail vanishes even when its near
      // half is plainly in front of it. That is the popping at wall edges.
      depthTest: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    // Density is needed by BOTH the colour (self-shadowing) and the alpha
    // (erosion), so one node builds the pair and each slot takes its component.
    // Same node object in both, so the graph is emitted once.
    const shaded = this._buildShadedNode().toVar();
    material.colorNode = shaded.xyz;
    material.opacityNode = shaded.w;

    /**
     * The SPRAY material — a second, much cheaper shader over the same
     * geometry, swapped in by `setWetness`.
     *
     * Built here rather than on demand so both pipelines are compiled before
     * anyone drives: switching a material that is already warm is free, whereas
     * rebuilding a node graph the first time the road turns wet would stall the
     * frame mid-corner.
     *
     * Why a second material at all: the volumetric solver above can only make
     * soft round volumes, because that is what it is — a ray-traced sphere with
     * billow noise, Beer-Lambert absorption and a scattering lobe. Water thrown
     * off a tyre is thin, fast and linear; there is no setting of a smoke
     * solver that produces a thin line. See `_buildStreakNode`.
     */
    const sprayMaterial = new MeshBasicNodeMaterial({
      transparent: true, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide, fog: false,
    });
    const streak = this._buildStreakNode().toVar();
    sprayMaterial.colorNode = streak.xyz;
    sprayMaterial.opacityNode = streak.w;
    this.sprayMaterial = sprayMaterial;

    this._buildBankMesh(scene);

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.positions = positions;
    this.tints = tints;
    this.noise = noise;
    this.spheres = spheres;
    this.classes = classes;
    this.geometry = geometry;
    this.material = material;
    const makePool = (n) => Array.from({ length: n }, () => ({
      life: 0,
      maxLife: 1,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      size: 1,
      rotation: 0,
      spin: 0,
      turbPhase: 0,
      turbFreq: 3,
      noiseU: 0,
      noiseV: 0,
      noiseDu: 0,
      noiseDv: 0,
      noiseScale: 1,
      tintMul: 1,
    }));
    this.particles = makePool(POOL_SIZE);
    this.hazeParticles = makePool(HAZE_POOL_SIZE);
    /**
     * One emitter per class. Each owns its own round-robin cursor and its own
     * fractional-emission accumulator (one per rear wheel), which is exactly
     * what keeps the two budgets from interfering.
     */
    // Four accumulators: the puff emitter runs from all four contacts once the
    // road is wet (see `_sprayPoints`). The bank stays on the rear pair and
    // simply never touches slots 2 and 3.
    this.puffEmitter = { list: this.particles, size: POOL_SIZE, index: 0, accum: [0, 0, 0, 0] };
    this.hazeEmitter = { list: this.hazeParticles, size: HAZE_POOL_SIZE, index: 0, accum: [0, 0, 0, 0] };
    this._worldDriftPhase = 0;
    /** World-noise frequency / mix of the class currently being stepped. */
    this._worldScaleMul = 1;
    this._worldMixMul = 1;
    /** Camera→centre distance of the particle currently being written. Set by
     *  `_stepPool` for the same reason `_smokeTint` is — it is already in hand
     *  up there, and `_writeParticle` needs it to size the quad exactly. */
    this._camDist = 1;
    /** The same particle's DEPTH along the view axis. Not interchangeable with
     *  `_camDist` — see the near-plane guard in `_stepPool`. Bounds the streak
     *  to a sane sweep of the frame. */
    this._camDepth = 1;
    /** Master visibility. Both meshes also hide themselves when empty, so this
     *  is ANDed in rather than written straight to `mesh.visible`. */
    this._visible = true;
  }

  /**
   * How wet the road is, 0..1. Drives the smoke→spray swap; see
   * DEFAULT_WET_SPRAY_SETTINGS for why it is a swap and not a second class.
   */
  /** Drift smoke on its own. Spray is unaffected — see `wetSpray.enabled`. */
  setSmokeEnabled(on) {
    this.settings.enabled = !!on;
    this._syncEnabled();
  }

  /** Wet spray on its own. Drift smoke is unaffected. */
  setSprayEnabled(on) {
    if (this.settings.wetSpray) this.settings.wetSpray.enabled = !!on;
    this._syncEnabled();
  }

  /**
   * Show or hide the meshes and free the pool according to whether ANY source
   * can still emit. Wetness is part of that: with smoke switched off on a dry
   * road nothing can produce a particle, so there is no reason to keep drawing.
   */
  _syncEnabled() {
    const smokeOn = this.settings.enabled !== false;
    const sprayOn = this.settings.wetSpray?.enabled !== false && (this._wetness ?? 0) > 0;
    const anyOn = smokeOn || sprayOn;
    this.setVisible(anyOn);
    if (!anyOn) this.reset();
  }

  setWetness(w) {
    this._wetness = Math.max(0, Math.min(1, w || 0));
    // Swap the shading path. Both materials were compiled at construction, so
    // this is a pointer assignment and not a pipeline build.
    //
    // A hard switch rather than a blend, because one mesh can only carry one
    // material — the settings still dissolve across the threshold, but the
    // SHADER cannot. Placed at 0.5 so each look owns the half of the range it
    // is right for; in practice a road is wet or it is not, and drift smoke on
    // a soaking road is not a case worth splitting a draw call over.
    const wantStreak = this._wetness >= 0.5;
    if (wantStreak !== this._streakOn) {
      this._streakOn = wantStreak;
      if (this.mesh) this.mesh.material = wantStreak ? this.sprayMaterial : this.material;
    }
    // Wetness decides whether the spray source can emit at all, so the
    // visibility gate has to be re-evaluated when it changes.
    this._syncEnabled();
  }

  /**
   * The puff settings to emit and step with, given the weather.
   *
   * Returns the dry settings OBJECT ITSELF when dry — same reference, so a dry
   * track is byte-identical to before this existed and pays nothing, not even
   * an allocation per frame.
   *
   * Numbers are interpolated rather than switched so the transition is a
   * dissolve as the rain comes in; colours cross over on the same ramp.
   */
  _puffSettings() {
    const s = this.settings;
    const w = this._wetness ?? 0;
    const spray = s.wetSpray;
    if (w <= 0 || !spray) return s;
    const lerp = (a, b) => a + (b - a) * w;
    const num = (k, dflt) => lerp(s[k] ?? dflt, spray[k] ?? s[k] ?? dflt);
    // Cached and mutated rather than rebuilt: this runs every frame, and the
    // pool reads it once per step.
    const out = this._wetPuff ?? (this._wetPuff = {});
    Object.assign(out, s);
    out.emitRate = num("emitRate", 150);
    out.opacity = num("opacity", 0.22);
    out.lifeMin = num("lifeMin", 0.65);
    out.lifeMax = num("lifeMax", 1.45);
    out.sizeMin = num("sizeMin", 0.42);
    out.sizeMax = num("sizeMax", 0.85);
    out.sizeGrowth = num("sizeGrowth", 3.4);
    out.rise = num("rise", 0.75);
    out.drag = num("drag", 0.35);
    out.spread = num("spread", 0.35);
    // The rooster tail's three terms. `_stepPool` reads all of them off the
    // BLENDED object, so leaving any one out means `Object.assign` hands it the
    // dry smoke value and the setting quietly does nothing — the exact way
    // `sideThrow` was dead. Buoyancy in particular flips sign here: smoke
    // climbs, water falls.
    out.buoyancy = num("buoyancy", 0.55);
    out.turbulence = num("turbulence", 1.5);
    out.damp = num("damp", 0.85);
    // Spin has to come DOWN to zero as the spray comes in: a stretched particle
    // that tumbles reads as a rotating sprite, which is the one tell all of this
    // is trying to lose. `num` cannot express it — `Object.assign` above copies
    // the dry value and the wet default of 0 would look like "not set".
    out.spinRate = num("spinRate", 0.35);
    // Not a blend of two values but of one against ABSENCE: dry smoke has no
    // `sideThrow` at all, so `num` would read `undefined` and fall through to
    // the spray value at full strength from the first wet frame. Wired here
    // because `emitAt` reads the BLENDED object, not `settings.wetSpray` — miss
    // this and the setting exists, is documented, and does nothing.
    out.sideThrow = (spray.sideThrow ?? 0) * w;
    // Colour crosses over on the same ramp. `_wetHot/_wetCool` are scratch so
    // this allocates nothing per frame either.
    const hot = this._wetHot ?? (this._wetHot = new THREE.Color());
    const cool = this._wetCool ?? (this._wetCool = new THREE.Color());
    hot.set(s.colorHot ?? s.color ?? SMOKE_COLOR_HEX).lerp(_wetTmp.set(spray.colorHot), w);
    cool.set(s.colorCool ?? s.color ?? SMOKE_COLOR_HEX).lerp(_wetTmp.set(spray.colorCool), w);
    out.colorHot = hot;
    out.colorCool = cool;
    return out;
  }

  /** Show/hide the whole effect — both the puff quads and the bank spheres. */
  setVisible(on) {
    this._visible = !!on;
    if (!on) {
      this.mesh.visible = false;
      if (this.bankMesh) this.bankMesh.visible = false;
    }
  }

  /**
   * The lingering bank, as REAL GEOMETRY: one instanced icosphere per particle.
   *
   * The sharp puffs stay billboards — they exist for a second and nobody can
   * tell. The bank cannot get away with it: it is metres across and lives long
   * enough that you drive around it, and a card has no silhouette of its own and
   * no honest depth. Spheres cost nothing here (320 tris × ~200 = 64k, noise
   * next to the track's 500k) because the price of smoke is overdraw, not
   * vertices — and a sphere covers less screen than the oversized quad it
   * replaces.
   *
   * Deliberately no `positionNode`: the lumpy silhouette comes entirely from the
   * alpha erosion carving the sphere, which is how claude-zelda's smoke does it
   * too. That also sidesteps the known "custom positionNode breaks InstancedMesh"
   * trap, since placement stays on `instanceMatrix`.
   */
  _buildBankMesh(scene) {
    // detail 2 = 320 tris. Enough that the silhouette never reads as faceted
    // once erosion has chewed it, and the erosion is what you actually see.
    const geo = new THREE.IcosahedronGeometry(1, 2);
    geo.deleteAttribute("uv"); // triplanar samples world space; mesh UVs unused

    const tints = new Float32Array(HAZE_POOL_SIZE * 4);
    const thresholds = new Float32Array(HAZE_POOL_SIZE);
    const tintAttr = new THREE.InstancedBufferAttribute(tints, 4);
    tintAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iTint", tintAttr);
    const threshAttr = new THREE.InstancedBufferAttribute(thresholds, 1);
    threshAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iThresh", threshAttr);
    // The sphere the shell stands for: centre.xyz + radius. The mesh is only a
    // bounding surface now — thickness, the density sample and the lighting
    // normal all come from intersecting the view ray with THIS, exactly as the
    // puffs do. See `_buildBankNode`.
    const spheres = new Float32Array(HAZE_POOL_SIZE * 4);
    const sphereAttr = new THREE.InstancedBufferAttribute(spheres, 4);
    sphereAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iSphere", sphereAttr);

    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      // BackSide — the FAR hemisphere. See `_buildBankNode` for the whole
      // argument; the short version is that FrontSide made the sphere delete
      // itself the moment the camera got inside it, which is most of a drift.
      side: THREE.BackSide,
      // Required by BackSide, and correct on its own merits. The shader does
      // EXACT per-pixel occlusion (the chord is clipped by scene depth, so
      // anything behind solid geometry comes out with zero thickness and
      // discards). The depth test on top of that only decides the whole
      // triangle on its own depth — and the far hemisphere of a sphere resting
      // on the road is BELOW the tarmac, so it would be rejected wholesale.
      depthTest: false,
      fog: false,
    });
    const shaded = this._buildBankNode().toVar();
    mat.colorNode = shaded.xyz;
    mat.opacityNode = shaded.w;

    const mesh = new THREE.InstancedMesh(geo, mat, HAZE_POOL_SIZE);
    mesh.frustumCulled = false;
    mesh.count = 0;
    // Behind the sharp puffs. Nothing here is depth-sorted, so draw order is the
    // only say we get over how the two transparent layers composite.
    mesh.renderOrder = 21;
    mesh.visible = false;
    scene.add(mesh);

    this.bankMesh = mesh;
    this.bankTints = tints;
    this.bankThresholds = thresholds;
    this.bankSpheres = spheres;
  }

  /**
   * Bank shading. Same lighting model as the puffs, and now the same ANALYTIC
   * ray-sphere geometry — the mesh alone could not survive the camera being
   * inside it.
   *
   * ── WHY THIS IS BackSide ───────────────────────────────────────────
   * It was FrontSide, on the sound reasoning that a closed sphere would
   * otherwise blend twice per pixel. But front-facing means the NEAR hemisphere,
   * and the chase camera is inside these spheres for most of a drift (they reach
   * 14 m across; the boom is 7.5 m). Once the camera crosses the surface every
   * triangle is back-facing and the sphere DISAPPEARS — the bank was deleting
   * itself exactly when it should have been filling the frame. On the way in,
   * the 0.5 m near plane sliced the near cap off first, and a sphere cut by the
   * near plane is a flat disc across the screen.
   *
   * The far hemisphere projects to exactly the same silhouette disc from
   * outside, and wraps the camera from inside, so BackSide covers both cases
   * with no double blend and nothing left for the near plane to cut.
   *
   * The surface is then only a bounding shell: thickness, the density sample and
   * the lighting normal all come from intersecting the view ray with `iSphere`,
   * the way the puffs already do. That also buys the road intersection properly
   * — the chord is clipped by scene depth, so a bank sphere sitting on the
   * tarmac is half-buried like a ball instead of softly faded against it.
   */
  _buildBankNode() {
    const tint = attribute("iTint", "vec4");
    const thresh = attribute("iThresh", "float");
    /** The VOLUME this shell stands for: xyz = centre in world space, w = radius. */
    const sphere = attribute("iSphere", "vec4");
    const noiseMap = this.noiseMap;
    const softDepth = this.uSoftDepth;
    const erodeSoft = this.uErodeSoft;
    const {
      uSunWorld, uLightAmount, uAmbient, uSunStrength, uAbsorb, uScatter, uHgG,
      uSunColor, uWorldScale, uWorldDrift, uBankScale,
    } = this;

    return Fn(() => {
      const camToFrag = positionWorld.sub(cameraPosition);
      const dist = length(camToFrag).toVar();
      const rd = camToFrag.div(dist).toVar();   // unit ray, camera → fragment
      const centre = sphere.xyz;
      const radius = sphere.w;

      const oc = cameraPosition.sub(centre);
      const b = dot(oc, rd);
      const cTerm = dot(oc, oc).sub(radius.mul(radius));
      const h = b.mul(b).sub(cTerm);
      // Only reachable through numerical slop at the silhouette — we are shading
      // the sphere's own surface, so the ray hits by construction.
      Discard(h.lessThan(0));
      const sq = sqrt(max(h, float(0)));
      const t0 = b.negate().sub(sq);   // entry — NEGATIVE when the camera is inside
      const t1 = b.negate().add(sq);   // exit

      // How far the scene is ALONG THIS RAY. positionView.z is measured down the
      // view axis, so it needs the 1/cos rescale before it can be compared
      // against ray parameters.
      const sceneViewZ = perspectiveDepthToViewZ(
        _sceneDepthTex.sample(screenUV).r, cameraNear, cameraFar,
      ).negate();
      const fragViewZ = positionView.z.negate();
      const sceneT = sceneViewZ.mul(dist).div(max(fragViewZ, float(1e-4)));

      // The VISIBLE chord: clipped at the near side by the camera and at the far
      // side by solid geometry. `tEnter` collapses to 0 whenever the camera is
      // inside, which is also what makes that case safe on its own — the chord
      // shrinks toward zero in the direction of the surface you are standing
      // next to, so the fragments the near plane could still cut are the ones
      // that were already going to be transparent.
      const tEnter = max(t0, float(0)).toVar();
      const tExit = min(t1, sceneT).toVar();
      const chord = max(tExit.sub(tEnter), float(0));
      const thick = saturate(chord.div(radius.mul(2)));

      // Lighting normal at the point the ray ENTERS the smoke, i.e. the lit
      // side. Real world-space normal, so it dots straight against the sun.
      const N = normalize(cameraPosition.add(rd.mul(tEnter)).sub(centre)).toVar();

      // Triplanar, in WORLD space — 3D, so it parallaxes as you move, and shared
      // between neighbours, so they erode along the same filaments and fuse into
      // one mass instead of reading as a bag of balls.
      //
      // Sampled at the chord MIDPOINT rather than on the shell. That point is a
      // function of the view ray, which is the parallax cue; and it stays
      // well-defined from inside, where the entry point collapses onto the
      // camera and would paint the whole sphere one flat colour.
      const mid = cameraPosition.add(rd.mul(tEnter.add(tExit).mul(0.5))).toVar();
      const aN = N.abs();
      const bl = aN.div(aN.x.add(aN.y).add(aN.z).add(0.0001));
      const wp = mid.mul(uWorldScale.mul(uBankScale));
      const off = uWorldDrift;
      const sX = texture(noiseMap, wp.yz.add(off)).r;
      const sY = texture(noiseMap, wp.xz.add(off)).r;
      const sZ = texture(noiseMap, wp.xy.add(off)).r;
      const detail = sX.mul(bl.x).add(sY.mul(bl.y)).add(sZ.mul(bl.z));

      const density = thick.mul(float(0.32).add(detail.mul(0.95))).toVar();

      const alpha = smoothstep(thresh, thresh.add(erodeSoft), density)
        .mul(tint.w)
        .toVar();

      // The chord clip above already handles the intersection properly; this
      // only feathers the last few centimetres, where depth-buffer quantisation
      // can still show a seam.
      alpha.mulAssign(saturate(sceneT.sub(t0).div(max(softDepth, float(1e-3)))));
      Discard(alpha.lessThan(0.003));

      const ndl = dot(N, uSunWorld);
      const wrapped = saturate(ndl.mul(0.5).add(0.5));
      const transmit = exp(density.mul(uAbsorb).negate());

      const c = dot(uSunWorld, rd);
      const gg = uHgG.mul(uHgG);
      const denom = pow(
        max(float(1e-4), float(1).add(gg).sub(uHgG.mul(2).mul(c))),
        float(1.5),
      );
      const phase = float(1).sub(gg).div(denom).div(12.566);

      const lit = uSunColor
        .mul(uSunStrength.mul(wrapped).add(uScatter.mul(phase)))
        .mul(transmit)
        .add(uAmbient);
      return vec4(tint.xyz.mul(mix(vec3(1), lit, uLightAmount)), alpha);
    })();
  }

  /**
   * The whole per-pixel model, returning vec4(litColour, alpha).
   *
   * Density is computed once and used twice: it erodes the alpha, and it drives
   * the Beer-Lambert self-shadow on the colour. Those two sharing a value is the
   * reason a puff's dark core lines up with its thick part instead of looking
   * like an unrelated painted-on gradient.
   */
  /**
   * SPRAY: a thin motion-blur streak, shaded in the card's own UV.
   *
   * The card is already built along the particle's apparent motion and sized by
   * how far it travels in a shutter (see `_writeParticle`), so all this has to
   * do is draw a soft lozenge inside it. A unit-disc falloff in UV is exactly
   * that: on a long thin quad it becomes a long thin line with round ends, and
   * on a nearly-square one it becomes a dot — which is correct, because a drop
   * that is not moving across the frame is not a streak.
   *
   * WHAT IT DELIBERATELY DOES NOT DO, versus the smoke path:
   *   • no ray-sphere intersection — there is no volume here, only a mark;
   *   • no noise texture taps (two of them) — a droplet streak has no internal
   *     billow structure to sample, and faking one is what made spray read as
   *     smoke in the first place;
   *   • no Henyey-Greenstein lobe and no Beer-Lambert self-shadow — a streak is
   *     optically thin by definition, so there is nothing for light to be
   *     absorbed by.
   *
   * The one thing it keeps is the scene-depth fade, because streaks live at
   * road level and would otherwise cut into the tarmac along a hard straight
   * edge. That is one texture tap against the smoke path's four.
   */
  _buildStreakNode() {
    const st = uv();
    const tint = attribute("aTint", "vec4");
    /** Reused from the smoke path: .w is the erosion threshold, which here
     *  simply eats the streak away over its life. */
    const nParams = attribute("aNoise", "vec4");
    const softDepth = this.uSoftDepth;
    const { uSunColor, uAmbient, uSunStrength, uLightAmount } = this;

    return Fn(() => {
      // Unit disc in card space. The card's own aspect does the elongation, so
      // this single expression covers dot and line alike.
      const p = st.sub(0.5).mul(2.0);
      const d = length(p);

      // Soft edge, and softer along the length than across it: a real streak
      // fades out at its ends rather than stopping.
      const core = saturate(oneMinus(d));
      // Squared, so the falloff is round rather than conical — a linear ramp
      // reads as a hard-edged diamond once the card gets long.
      const shape = core.mul(core);

      // Age erodes it. `aNoise.w` climbs over life on the CPU, so subtracting it
      // thins the streak away instead of just dimming it, which is what keeps
      // the tail of the plume from looking like it fades as one solid mass.
      const alpha = saturate(shape.sub(nParams.w.mul(0.35))).mul(tint.w).toVar();

      // Depth fade — the only tap in this shader.
      const sceneViewZ = perspectiveDepthToViewZ(
        _sceneDepthTex.sample(screenUV).r, cameraNear, cameraFar,
      ).negate();
      const fragViewZ = positionView.z.negate();
      alpha.mulAssign(saturate(sceneViewZ.sub(fragViewZ).div(max(softDepth, float(1e-3)))));

      Discard(alpha.lessThan(0.003));

      // Flat lighting. Water spray is bright because it scatters a lot, not
      // because it is shaped — there is no normal here worth lighting.
      const lit = uSunColor.mul(uSunStrength).add(uAmbient);
      return vec4(tint.xyz.mul(mix(vec3(1), lit, uLightAmount)), alpha);
    })();
  }

  _buildShadedNode() {
    const st = uv();
    const tint = attribute("aTint", "vec4");
    /** xy = noise frame offset, z = noise tiles per quad, w = erosion threshold. */
    const nParams = attribute("aNoise", "vec4");
    /** The VOLUME this quad stands in for: xyz = centre in world space, w = radius. */
    const sphere = attribute("aSphere", "vec4");
    /** Per-class: x = world-noise mix, y = world-noise frequency multiplier. */
    const cls = attribute("aClass", "vec2");
    const softDepth = this.uSoftDepth;
    const erodeSoft = this.uErodeSoft;
    const noiseMap = this.noiseMap;
    const {
      uSunWorld, uLightAmount, uAmbient, uSunStrength, uAbsorb, uScatter, uHgG,
      uSunColor, uWorldMix, uWorldScale, uWorldDrift,
    } = this;

    return Fn(() => {
      // ── The quad is scaffolding; the particle is a SPHERE ───────────────────
      //
      // Everything below intersects the view ray with that sphere instead of
      // shading the card. This is what stops big, long-lived puffs reading as
      // paper: a card has no parallax (its detail is painted on a plane that
      // keeps turning to face you), it meets the ground along a straight cut,
      // and its "thickness" is a 2D mask. A sphere has real extent in depth, so
      // driving past one shifts what you see through it.
      const camToFrag = positionWorld.sub(cameraPosition);
      const dist = length(camToFrag).toVar();
      const rd = camToFrag.div(dist).toVar();       // unit ray, camera → fragment
      const centre = sphere.xyz;
      const radius = sphere.w;

      const oc = cameraPosition.sub(centre);
      const b = dot(oc, rd);
      const cTerm = dot(oc, oc).sub(radius.mul(radius));
      const h = b.mul(b).sub(cTerm);
      // Corners of the quad miss the sphere entirely. Killing them here is also
      // the cheapest overdraw win available — it is ~21% of every quad.
      Discard(h.lessThan(0));
      const sq = sqrt(max(h, float(0)));
      const t0 = b.negate().sub(sq).toVar();   // entry
      const t1 = b.negate().add(sq).toVar();   // exit

      // How far the scene is ALONG THIS RAY. positionView.z is measured down the
      // view axis, so it has to be rescaled by dist/viewZ (= 1/cos) to compare
      // against ray parameters.
      const sceneViewZ = perspectiveDepthToViewZ(
        _sceneDepthTex.sample(screenUV).r, cameraNear, cameraFar,
      ).negate();
      const fragViewZ = positionView.z.negate();
      const sceneT = sceneViewZ.mul(dist).div(max(fragViewZ, float(1e-4)));

      // Thickness of the VISIBLE chord: clipped at the near side by the camera
      // (so you can fly through a puff) and at the far side by whatever solid
      // geometry is behind it. Clipping here rather than fading the whole quad
      // is why a bank resting on the road looks half-buried like a ball instead
      // of sliced off like a sheet.
      const tEnter = max(t0, float(0)).toVar();
      const tExit = min(t1, sceneT);
      const chord = max(tExit.sub(tEnter), float(0));
      const thick = saturate(chord.div(radius.mul(2)));

      // Coarse lobes carry the shape; a little fine detail keeps the torn edge
      // from looking like a smooth contour line of the coarse field.
      const nQuad = texture(noiseMap, st.mul(nParams.z).add(nParams.xy));
      const detailQuad = mix(nQuad.r, nQuad.g, 0.35);

      // THE PARALLAX. Sample the field at a point INSIDE the volume — the
      // sphere's chord midpoint — rather than on the quad's surface. That point
      // is a function of the view ray, so moving the camera slides it through
      // the noise and the puff's interior shifts against its silhouette, which
      // is the cue the eye reads as depth. Sampled on the quad it would just be
      // a picture that turns to face you.
      const mid = cameraPosition.add(rd.mul(b.negate()));
      const wuv = vec2(
        mid.x.add(mid.y.mul(0.37)),
        mid.z.add(mid.y.mul(0.61)),
      ).mul(uWorldScale.mul(cls.y)).add(uWorldDrift);
      const nWorld = texture(noiseMap, wuv);
      const detailWorld = mix(nWorld.r, nWorld.g, 0.35);

      // Per-class mix: the big slow bank leans harder on the volumetric sample,
      // because it is the one you actually get time to walk around.
      const detail = mix(detailQuad, detailWorld, saturate(uWorldMix.mul(cls.x)));
      const density = thick.mul(float(0.32).add(detail.mul(0.95))).toVar();

      // ── Alpha: erosion, then a gentle extra feather ─────────────────────────
      // The threshold rises over life (CPU side), so the puff erodes away from
      // its thin edges inward instead of dimming uniformly.
      const thresh = nParams.w;
      const alpha = smoothstep(thresh, thresh.add(erodeSoft), density)
        .mul(tint.w)
        .toVar();

      // The chord clip above already handles intersection properly; this only
      // feathers the last few centimetres, where depth-buffer quantisation can
      // still show a seam.
      alpha.mulAssign(saturate(sceneT.sub(t0).div(max(softDepth, float(1e-3)))));

      Discard(alpha.lessThan(0.003));

      // ── Colour: true sphere normal + wrapped diffuse + HG forward lobe ──────
      // The normal at the point where the ray enters the sphere. Being a real
      // world-space normal, it can be dotted straight against the world sun —
      // no quad basis, no per-particle projection.
      const nrm = normalize(cameraPosition.add(rd.mul(tEnter)).sub(centre));
      const ndl = dot(nrm, uSunWorld);

      // Wrapped diffuse. Smoke is translucent, so it stays lit around the
      // terminator; a clamped N·L gives it a hard, solid-looking edge.
      const wrapped = saturate(ndl.mul(0.5).add(0.5));

      // Beer-Lambert: how much light survives to the visible surface. Thin
      // edges ≈ 1, thick cores → 0, which is what darkens the middle of a plume.
      const transmit = exp(density.mul(uAbsorb).negate());

      // Henyey-Greenstein, now per pixel. cosθ is between the light's direction
      // of travel and the direction out toward the camera; with rd pointing
      // camera → fragment that is exactly dot(sun, rd), peaking when you look
      // through the smoke toward the sun.
      const c = dot(uSunWorld, rd);
      const gg = uHgG.mul(uHgG);
      const denom = pow(
        max(float(1e-4), float(1).add(gg).sub(uHgG.mul(2).mul(c))),
        float(1.5),
      );
      // The 1/4π keeps the forward lobe near 1 instead of ~10, so `scatter`
      // reads as a sensible 0..2 dial rather than needing three decimal places.
      const phase = float(1).sub(gg).div(denom).div(12.566);

      const lit = uSunColor
        .mul(uSunStrength.mul(wrapped).add(uScatter.mul(phase)))
        .mul(transmit)
        .add(uAmbient);
      const rgb = tint.xyz.mul(mix(vec3(1), lit, uLightAmount));

      return vec4(rgb, alpha);
    })();
  }

  reset() {
    for (const e of [this.puffEmitter, this.hazeEmitter]) {
      for (const p of e.list) p.life = 0;
      e.accum.fill(0);
    }
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    if (this.bankMesh) {
      this.bankMesh.count = 0;
      this.bankMesh.visible = false;
    }
  }

  /**
   * @param {import("./modularRoadVehicle.js").Vehicle} vehicle
   * @param {THREE.Camera} camera
   * @param {number} dt
   * @param {Record<string, boolean>} [keys]
   */
  updateFromVehicle(vehicle, camera, dt, keys = {}) {
    if (!vehicle?.enabled) {
      this.update(dt, _rearPoints, false, 0, 0, 0, camera);
      return;
    }

    const body = vehicle.body;
    _velHoriz.copy(body.vel);
    _velHoriz.y = 0;
    const speed = _velHoriz.length();

    _chassisFwd.set(0, 0, 1).applyQuaternion(body.quat);
    _chassisFwd.y = 0;
    if (_chassisFwd.lengthSq() > 1e-8) _chassisFwd.normalize();

    let driftAngle = 0;
    if (speed > 0.5 && _chassisFwd.lengthSq() > 1e-8) {
      driftAngle = Math.acos(
        THREE.MathUtils.clamp(_velHoriz.dot(_chassisFwd) / speed, -1, 1),
      );
    }

    const driftAmount = THREE.MathUtils.clamp(
      (driftAngle - DRIFT_ANGLE_MIN) / 0.5,
      0,
      1,
    );
    const handbrake = !!keys.Space || !!vehicle.input?.handbrake;
    const handbrakeAmount = handbrake
      ? THREE.MathUtils.smoothstep(speed, ENTRY_SPEED, ENTRY_SPEED * 2.2)
      : 0;

    // Car right, in world. Needed before the tyre loop because it decides which
    // way each contact is outboard, and reused per tyre below.
    _sprayRight.set(1, 0, 0).applyQuaternion(body.quat);

    let rearSlip = 0;
    let rearOver = 0;
    let rearIdx = 0;
    let frontIdx = 0;
    let hasRear = false;
    for (const tire of vehicle.tires) {
      if (tire.canSteer) {
        // Fronts contribute no smoke and no slip measurement — they exist here
        // purely as spray emitters, and only while the road is wet.
        const slot = frontIdx === 0 ? _frontContact0 : _frontContact1;
        if (tire.grounded && frontIdx < 2) {
          slot.copy(tire.hitPoint).addScaledVector(tire.hitNormal, MARK_Y_OFFSET);
          _contactSide[frontIdx] = Math.sign(
            _scratchVel.subVectors(tire.worldPos, body.pos).dot(_sprayRight),
          ) || 1;
        } else if (frontIdx < 2) {
          slot.set(0, -9999, 0);
        }
        frontIdx++;
        continue;
      }
      const contact = rearIdx === 0 ? _rearContact0 : _rearContact1;
      if (tire.grounded) {
        hasRear = true;
        contact.copy(tire.hitPoint).addScaledVector(tire.hitNormal, MARK_Y_OFFSET);
        _contactSide[2 + rearIdx] = Math.sign(
          _scratchVel.subVectors(tire.worldPos, body.pos).dot(_sprayRight),
        ) || 1;
        body.getVelocityAtPoint(tire.worldPos, _scratchVel);
        _wheelFwd.set(0, 0, 1).applyQuaternion(body.quat);
        _wheelRight.set(1, 0, 0).applyQuaternion(body.quat);
        const vLat = Math.abs(_scratchVel.dot(_wheelRight));
        const vLong = Math.abs(_scratchVel.dot(_wheelFwd));
        rearSlip = Math.max(rearSlip, vLat / Math.max(vLong, 3.5));
        rearOver = Math.max(rearOver, tire.overDemand ?? 0);
      } else if (rearIdx === 0) {
        _rearContact0.set(0, -9999, 0);
      } else {
        _rearContact1.set(0, -9999, 0);
      }
      rearIdx++;
    }

    const slipAmount = THREE.MathUtils.clamp(rearSlip * 0.85, 0, 1);
    // Hard braking smokes too — see the matching note in modularRoadTireMarks.js.
    // Every other term here measures LATERAL slip, so a straight-line stop showed
    // nothing at all. `tire.overDemand` is the same measurement in the other axis:
    // how far past its grip the tyre's longitudinal demand went.
    const brakeAmount = BRAKE_SMOKE > 0
      ? THREE.MathUtils.clamp(rearOver * BRAKE_SMOKE, 0, 1)
        * THREE.MathUtils.smoothstep(speed, ENTRY_SPEED, ENTRY_SPEED * 2)
      : 0;
    const driftIntensity = Math.max(driftAmount, handbrakeAmount, slipAmount, brakeAmount);
    const inAir = vehicle.groundedCount === 0;
    const s = this.settings;
    const trigger = s.trigger ?? INTENSITY_MIN;
    // The two sources gate independently — see `wetSpray.enabled`.
    const smokeOn = s.enabled !== false;
    const sprayOn = s.wetSpray?.enabled !== false;
    let emitSmoke =
      smokeOn &&
      hasRear &&
      !inAir &&
      speed > ENTRY_SPEED * 0.55 &&
      (driftIntensity > trigger ||
        (handbrake && speed > ENTRY_SPEED * 0.55));
    let smokeIntensity = smokeOn ? Math.max(driftIntensity, handbrake ? 0.45 : 0) : 0;

    // ── SPRAY NEEDS NO SLIP ───────────────────────────────────────────────
    //
    // Every term above measures how hard the tyre is sliding, because that is
    // what makes rubber smoke. Water does not care: a tyre rolling straight
    // through standing water throws just as much of it, and at a much lower
    // speed than it takes to break traction. So on a wet road the gate becomes
    // "moving and on the ground", and the intensity comes from speed rather
    // than from slip — with the drift terms still able to raise it, since
    // sliding does throw more water than rolling.
    const wet = this._wetness ?? 0;
    if (sprayOn && wet > 0 && hasRear && !inAir) {
      const entry = this.settings.wetSpray?.entrySpeed ?? 4;
      const rolling = THREE.MathUtils.smoothstep(speed, entry, entry * 3.5);
      if (rolling > 0) {
        emitSmoke = true;
        smokeIntensity = Math.max(smokeIntensity, rolling * wet);
      }
    }

    // ── THE SHUTTER ───────────────────────────────────────────────────────
    //
    // Streak length is now a consequence, not a setting: each one is however
    // far its droplet travels ACROSS THE FRAME in this much time. Nothing here
    // needs a speed term any more — a parked car's spray has no apparent motion
    // and draws dots, and a fast one draws lines, from the same number. That
    // fell out of orienting by apparent motion instead of by the car's heading,
    // and it is the reason this replaced the ellipsoid rather than tuning it.
    this._shutter = (s.wetSpray?.streak ?? 1) * BASE_SHUTTER * wet;

    // Four contacts in the rain, the rear pair when dry — see `_sprayPoints`.
    const points = wet > 0 ? _sprayPoints : (hasRear ? _rearPoints : []);
    this.update(
      dt,
      points,
      emitSmoke,
      smokeIntensity,
      body.vel.x,
      body.vel.z,
      camera,
    );
  }

  update(dt, points, emit, intensity, velocityX, velocityZ, camera) {
    // THE PUFF CLASS, WEATHERED. Identical object when dry (see _puffSettings),
    // so nothing about a dry track changes. `this.settings` is still read below
    // for the shader-wide uniforms, which are shared by both looks.
    const puff = this._puffSettings();
    const s = this.settings;
    // Backstop only. Which SOURCE may emit is decided in `updateFromVehicle`,
    // where the distinction between "sliding on dry tarmac" and "rolling
    // through water" actually exists; this just catches a direct caller when
    // nothing at all is switched on.
    if (s.enabled === false && s.wetSpray?.enabled === false) emit = false;
    this.uSoftDepth.value = Math.max(1e-3, s.softDepth ?? 0.9);
    this.uErodeSoft.value = Math.max(0.01, s.erodeSoft ?? 0.3);
    this.uLightAmount.value = s.sunTint ?? 1;
    this.uAmbient.value = s.ambient ?? 0.5;
    this.uSunStrength.value = s.sunStrength ?? 0.9;
    this.uAbsorb.value = s.absorb ?? 1;
    this.uScatter.value = s.scatter ?? 1.2;
    // Clamped below 1: HG's denominator collapses to 0 at g=1, c=1.
    this.uHgG.value = THREE.MathUtils.clamp(s.hgG ?? 0.6, 0, 0.95);
    this.uBankScale.value = s.haze?.worldScaleMul ?? 0.4;

    this.uWorldMix.value = THREE.MathUtils.clamp(s.worldNoiseMix ?? 0.55, 0, 1);
    this.uWorldScale.value = s.worldNoiseScale ?? 0.6;
    // Accumulated rather than derived from a clock: moving the drift slider then
    // never teleports the pattern, it just changes how fast it goes from here.
    this._worldDriftPhase += dt * (s.worldNoiseDrift ?? 0.35);
    this.uWorldDrift.value.set(this._worldDriftPhase * 0.31, this._worldDriftPhase * 0.19);

    const haze = s.haze;
    const hazeOn = !!haze && haze.enabled !== false;

    if (emit) {
      this._emit(this.puffEmitter, puff, puff.emitRate ?? EMIT_RATE,
        points, intensity, velocityX, velocityZ, dt);
      if (hazeOn) {
        // The bank stays on the REAR pair whatever the weather. It is one slow
        // mass settling behind the car, not something each wheel throws, and
        // giving it four sources would just halve each one (see `_emit`).
        this._emit(this.hazeEmitter, haze, haze.emitRate ?? 12,
          _rearPoints, intensity, velocityX, velocityZ, dt);
      }
    } else {
      this.puffEmitter.accum[0] = 0;
      this.puffEmitter.accum[1] = 0;
      this.hazeEmitter.accum[0] = 0;
      this.hazeEmitter.accum[1] = 0;
    }

    camera.updateMatrixWorld();
    // Both classes need this before they step: it sizes each billboard exactly
    // and drives the proximity fade that keeps the near plane away from them.
    _camPrev.copy(_camPos);
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    _smokeRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    _smokeUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    // Forward, and the camera's own velocity. Streaks are motion blur, and
    // motion blur is relative to the observer — a chase camera travels with the
    // car, so a droplet that looks fast against the road is nearly stationary
    // against the lens. Differencing the position is enough and needs nothing
    // from the caller.
    _smokeFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    if (dt > 1e-5 && _camPrev.lengthSq() > 0) {
      _camVel.subVectors(_camPos, _camPrev).divideScalar(dt);
    } else {
      _camVel.set(0, 0, 0);
    }
    // Lighting is now done against real world-space sphere normals, so the sun
    // goes to the GPU as-is — no projection into any billboard basis.
    this.uSunWorld.value.copy(_smokeSun);

    // The two classes now live on two meshes — instanced spheres for the bank,
    // billboard quads for the puffs — so they keep independent counts. Draw
    // order is settled by renderOrder (21 vs 22), not by buffer position.
    const bankAlive = hazeOn ? this._stepPool(this.hazeParticles, haze, dt, true) : 0;
    if (this.bankMesh) {
      this.bankMesh.count = bankAlive;
      this.bankMesh.visible = bankAlive > 0 && this._visible;
      if (bankAlive > 0) {
        this.bankMesh.instanceMatrix.needsUpdate = true;
        this.bankMesh.geometry.attributes.iTint.needsUpdate = true;
        this.bankMesh.geometry.attributes.iThresh.needsUpdate = true;
        this.bankMesh.geometry.attributes.iSphere.needsUpdate = true;
      }
    }

    const alive = this._stepPool(this.particles, puff, dt, false);
    const vertCount = alive * VERTS_PER_PARTICLE;
    this.geometry.setDrawRange(0, vertCount);
    this.mesh.visible = vertCount > 0 && this._visible;
    if (vertCount > 0) {
      const posAttr = this.geometry.attributes.position;
      posAttr.addUpdateRange(0, alive * FLOATS_PER_PARTICLE);
      posAttr.needsUpdate = true;
      const tintAttr = this.geometry.attributes.aTint;
      tintAttr.addUpdateRange(0, alive * TINT_FLOATS_PER_PARTICLE);
      tintAttr.needsUpdate = true;
      const noiseAttr = this.geometry.attributes.aNoise;
      noiseAttr.addUpdateRange(0, alive * NOISE_FLOATS_PER_PARTICLE);
      noiseAttr.needsUpdate = true;
      const sphereAttr = this.geometry.attributes.aSphere;
      sphereAttr.addUpdateRange(0, alive * SPHERE_FLOATS_PER_PARTICLE);
      sphereAttr.needsUpdate = true;
      const classAttr = this.geometry.attributes.aClass;
      classAttr.addUpdateRange(0, alive * CLASS_FLOATS_PER_PARTICLE);
      classAttr.needsUpdate = true;
    }
  }

  /**
   * Spawn one class's share for this frame, at both rear contact points.
   * @param {{list: object[], size: number, index: number, accum: number[]}} emitter
   * @param {object} cfg — the settings block for this class (root, or `haze`)
   */
  _emit(emitter, cfg, rate, points, intensity, velocityX, velocityZ, dt) {
    // Split across however many contacts are emitting, so going from two wheels
    // to four throws water from all of them rather than doubling the plume and
    // eating the pool. Density is the settings' business, not the wheel count's.
    const perSecond = rate * THREE.MathUtils.clamp(intensity, 0, 1)
      * (2 / Math.max(points.length, 1));
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (!point || point.y < -9000) continue;
      emitter.accum[i] += perSecond * dt;
      while (emitter.accum[i] >= 1) {
        this.emitAt(emitter, cfg, point, intensity, velocityX, velocityZ, _contactSide[i]);
        emitter.accum[i] -= 1;
      }
    }
  }

  /**
   * Advance one class and write its live particles into the shared buffers,
   * starting at vertex slot `alive`. Returns the new count.
   *
   * Both classes run the identical model — only the numbers differ — which is
   * the whole reason the lingering bank costs no extra draw call and no extra
   * shader: it is the same particle, dialled slow, big and faint.
   */
  _stepPool(list, cfg, dt, isBank) {
    const erodeStart = cfg.erodeStart ?? 0.06;
    const erodeEnd = cfg.erodeEnd ?? 1.25;
    const noiseDrift = cfg.noiseDrift ?? 0.12;
    const turb = cfg.turbulence ?? 0;
    const buoyancy = cfg.buoyancy ?? 0;
    const damp = cfg.damp ?? 0.85;
    const growth = cfg.sizeGrowth ?? SIZE_GROWTH;
    const growthPower = cfg.growthPower ?? 0.5;
    const erodePower = cfg.erodePower ?? 1.3;
    const fadeOutStart = cfg.fadeOutStart ?? 0;
    const tailPower = cfg.tailPower ?? 0.6;
    const fadeIn = cfg.fadeIn ?? 0;
    const opacity = cfg.opacity ?? OPACITY;
    this._worldScaleMul = cfg.worldScaleMul ?? 1;
    this._worldMixMul = cfg.worldMixMul ?? 1;
    // Hex parsing hoisted out of the per-particle loop: this used to re-parse
    // both colour strings for every one of ~600 particles, every frame.
    const hasRamp = !!(cfg.colorHot && cfg.colorCool);
    if (hasRamp) {
      _smokeHot.set(cfg.colorHot);
      _smokeCool.set(cfg.colorCool);
    } else {
      _smokeHot.setHex(SMOKE_COLOR_HEX);
      if (cfg.color) _smokeHot.set(cfg.color);
      _smokeCool.copy(_smokeHot);
    }

    let alive = 0;
    for (const p of list) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;

      const age = 1 - p.life / p.maxLife;

      // Turbulence as ACCELERATION so it integrates into a curling path. Each
      // particle carries its own phase/frequency, otherwise the whole plume
      // swirls in lockstep and reads as a single wobbling sheet.
      if (turb > 0) {
        const t = (p.maxLife - p.life) * p.turbFreq + p.turbPhase;
        p.velocity.x += Math.sin(t) * turb * dt;
        p.velocity.z += Math.cos(t * 1.37) * turb * dt;
        p.velocity.y += Math.sin(t * 0.73) * turb * 0.35 * dt;
      }
      p.velocity.y += buoyancy * dt;

      p.velocity.multiplyScalar(Math.max(0, 1 - dt * damp));
      p.position.addScaledVector(p.velocity, dt);
      p.rotation += p.spin * dt;

      // Turbulent diffusion widens fast then slows, so puff growth goes as √age
      // (growthPower 0.5) — a linear ramp makes them look like inflating
      // balloons. The bank overrides it towards linear so it keeps expanding
      // for its whole life instead of reaching full size in two seconds.
      const size = p.size * (1 + Math.pow(age, growthPower) * growth);
      const radius = size * 0.5;

      // ── CAMERA PROXIMITY ──────────────────────────────────────────
      // Distance to the particle's centre, which decides two things: how big the
      // billboard has to be to circumscribe its sphere (K_MAX), and whether the
      // particle is close enough that it has to be retired before the near plane
      // cuts it. Everything near-camera used to be unhandled, and the chase rig
      // flies through the plume continuously at speed.
      const camDist = _camPos.distanceTo(p.position);
      // DEPTH, signed, along the view axis — negative behind the lens. This is
      // what the near plane actually cuts on, and it is not the same thing as
      // `camDist`: a droplet level with the lens but 2 m to one side is 2 m away
      // and yet completely past the near plane. Measuring the guard radially let
      // those through at full opacity, which is what the streak path then turned
      // into screen-crossing beams (see the depth term in the axis block below).
      _toPart.subVectors(p.position, _camPos);
      const camDepth = _toPart.dot(_smokeFwd);
      let fade;
      if (isBank) {
        // Relative to the sphere's OWN radius — see BANK_FADE_*. An absolute
        // fade would delete the bank, because the camera lives inside it.
        fade = THREE.MathUtils.clamp(
          (camDist - radius * BANK_FADE_OUT) /
            Math.max(radius * (BANK_FADE_IN - BANK_FADE_OUT), 1e-4),
          0,
          1,
        );
      } else {
        // Two terms, whichever is smaller. The first retires a puff before its
        // quad would have to blow up past K_MAX — that one is RADIAL, because
        // the quad's size is set by how far the sphere is, in any direction.
        // The second is the near-plane guard, and it is on the DEPTH, because
        // the billboard's plane sits at the centre and the near plane slices it
        // at a fixed depth however far off-axis that centre has drifted.
        const k = radius / Math.max(camDist, 1e-4);
        fade = Math.min(
          THREE.MathUtils.clamp((K_MAX - k) / (K_MAX - K_FADE_START), 0, 1),
          THREE.MathUtils.clamp(
            (camDepth - NEAR_FADE_OUT) / (NEAR_FADE_IN - NEAR_FADE_OUT),
            0,
            1,
          ),
        );
      }
      // Fully faded costs nothing at all: no buffer write, no quad, no overdraw.
      // The particle stays alive and comes back as the camera pulls away.
      if (fade <= 0) continue;
      this._camDist = camDist;
      this._camDepth = camDepth;

      // ── THE STREAK AXIS: APPARENT MOTION, NOT WORLD MOTION ────────────────
      //
      // A streak is motion blur, so it runs along where the particle GOES ON
      // SCREEN over one shutter. That is not the direction it travels in the
      // world, and the difference is the whole problem: from a chase camera the
      // spray's world velocity points almost straight down the view axis, which
      // projects to nothing — measured at 0.16 — so orienting by it produced
      // foreshortened blobs no matter how far they were stretched.
      //
      // Screen velocity is the derivative of the projection. With the particle
      // at camera-plane offsets X, Y and depth z, the projection is (X/z, Y/z),
      // so differentiating gives
      //
      //     sx = V·right - X * (V·fwd) / z
      //     sy = V·up    - Y * (V·fwd) / z
      //
      // The second term is the one that matters here: it is pure perspective —
      // a droplet receding straight away from the lens still sweeps across the
      // frame toward the vanishing point, and it does so FASTER the further it
      // sits from the view axis. That is exactly the motion the eye reads as
      // spray, and it is non-zero precisely where the world-space axis dies.
      //
      // V is relative to the CAMERA, which is travelling with the car.
      //
      // NOTE the 1/z. This expression is a PROJECTION derivative, so it only
      // means anything IN FRONT of the lens, and it diverges as z → 0. That is
      // not a rounding concern, it was the whole failure mode: `z` used to be
      // `max(depth, 0.05)`, so a droplet level with the lens or behind it —
      // which the radial near-fade happily drew at full opacity — got its
      // perspective term multiplied by up to 20, giving a streak a couple of
      // HUNDRED times its own radius, aimed radially away from the view axis.
      // A plume of those is a set of beams converging on the vanishing point,
      // which is the cross that appeared over the car in the wet.
      //
      // The depth-based near fade above is the fix: it takes those particles to
      // zero before they get here, so `z` is now a genuine depth of at least
      // NEAR_FADE_OUT and the 1/z has nothing left to blow up on.
      if (!isBank) {
        _relVel.copy(p.velocity).sub(_camVel);
        const z = Math.max(camDepth, NEAR_FADE_OUT);
        const vf = _relVel.dot(_smokeFwd) / z;
        this._streakX = _relVel.dot(_smokeRight) - _toPart.dot(_smokeRight) * vf;
        this._streakY = _relVel.dot(_smokeUp) - _toPart.dot(_smokeUp) * vf;
      } else {
        this._streakX = 0;
        this._streakY = 0;
      }

      // Fade IN over the first slice of life, then hold, then fade OUT.
      //
      // `fadeOutStart` is what lets a class END BIG. Fading from birth means a
      // particle is at its most transparent exactly when it is at its largest,
      // so every gain in size is cancelled by a loss in opacity and the mass can
      // never visibly grow. Holding first lets it build, then disperse.
      const rampIn = fadeIn > 0 ? Math.min(1, age / fadeIn) : 1;
      const outT = fadeOutStart > 0
        ? Math.max(0, (age - fadeOutStart) / (1 - fadeOutStart))
        : age;
      const alpha = opacity * rampIn * Math.pow(1 - outT, tailPower) * fade;

      // Dense/dark fresh → pale/thin as it disperses.
      _smokeTint.copy(_smokeHot).lerp(_smokeCool, Math.sqrt(age));
      _smokeTint.multiplyScalar(p.tintMul);

      // Erosion eats in from the thin edges, slowly at first: age^1.3 keeps the
      // puff coherent while it is still being thrown off the tyre, then opens it
      // up as it drifts. A linear ramp starts shredding it immediately.
      const elapsed = p.maxLife - p.life;
      const thresh = erodeStart + (erodeEnd - erodeStart) * Math.pow(age, erodePower);

      if (isBank) {
        this._writeBankInstance(alive++, p.position, size, alpha, thresh);
      } else {
        this._writeParticle(
          alive++, p.position, size, p.rotation, alpha, thresh,
          p.noiseU + p.noiseDu * elapsed * noiseDrift,
          p.noiseV + p.noiseDv * elapsed * noiseDrift,
          p.noiseScale,
        );
      }
    }
    return alive;
  }

  /**
   * One instanced sphere: a uniform-scale translation matrix written straight
   * into `instanceMatrix.array`, plus its colour and erosion threshold.
   *
   * Composing through Object3D/Matrix4 would allocate and do a full TRS compose
   * per particle per frame for a matrix that is only ever scale + translate.
   */
  _writeBankInstance(index, center, size, alpha, thresh) {
    const r = size * 0.5;
    const m = this.bankMesh.instanceMatrix.array;
    const o = index * 16;
    m[o] = r;     m[o + 1] = 0;  m[o + 2] = 0;   m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = r;  m[o + 6] = 0;   m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0;  m[o + 10] = r;  m[o + 11] = 0;
    m[o + 12] = center.x; m[o + 13] = center.y; m[o + 14] = center.z; m[o + 15] = 1;

    const s = index * 4;
    this.bankSpheres[s] = center.x;
    this.bankSpheres[s + 1] = center.y;
    this.bankSpheres[s + 2] = center.z;
    this.bankSpheres[s + 3] = r;

    const t = index * 4;
    this.bankTints[t] = _smokeTint.r;
    this.bankTints[t + 1] = _smokeTint.g;
    this.bankTints[t + 2] = _smokeTint.b;
    this.bankTints[t + 3] = alpha;
    this.bankThresholds[index] = thresh;
  }

  emitAt(emitter, s, point, intensity, velocityX, velocityZ, side = 0) {
    const p = emitter.list[emitter.index];
    emitter.index = (emitter.index + 1) % emitter.size;

    const speed = Math.hypot(velocityX, velocityZ);
    const dirX = speed > 1e-4 ? velocityX / speed : 0;
    const dirZ = speed > 1e-4 ? velocityZ / speed : 0;
    const sideJitter = (Math.random() - 0.5) * (s.spread ?? SPREAD);
    p.position.set(
      point.x - dirX * (0.12 + Math.random() * 0.25) + sideJitter * dirZ,
      point.y + 0.02 + Math.random() * 0.1,
      point.z - dirZ * (0.12 + Math.random() * 0.25) - sideJitter * dirX,
    );
    // Outboard fling, along the car's lateral axis, away from its centreline.
    // Linear rather than squared: squaring concentrates nearly every droplet at
    // the wheel and leaves the sheet as narrow as it was without it, which is
    // what the four solid ropes looked like on the first pass.
    const throwOut = (s.sideThrow ?? 0) * side;
    const lateral = throwOut !== 0 ? throwOut * Math.random() : 0;
    p.velocity.set(
      -dirX * speed * (s.drag ?? SPEED_DRAG) + (Math.random() - 0.5) * 0.45
        + lateral * _sprayRight.x,
      (s.rise ?? RISE) * (0.65 + Math.random() * 0.7),
      -dirZ * speed * (s.drag ?? SPEED_DRAG) + (Math.random() - 0.5) * 0.45
        + lateral * _sprayRight.z,
    );

    const lifeMin = Math.max(0.05, s.lifeMin ?? LIFE_MIN);
    const lifeMax = Math.max(lifeMin, s.lifeMax ?? LIFE_MAX);
    p.maxLife = THREE.MathUtils.lerp(lifeMin, lifeMax, Math.random());
    p.life = p.maxLife;

    const sizeMin = Math.max(0.01, s.sizeMin ?? SIZE_MIN);
    const sizeMax = Math.max(sizeMin, s.sizeMax ?? SIZE_MAX);
    p.size =
      THREE.MathUtils.lerp(sizeMin, sizeMax, Math.random()) *
      THREE.MathUtils.lerp(0.75, 1.25, THREE.MathUtils.clamp(intensity, 0, 1));
    p.rotation = Math.random() * Math.PI * 2;
    // Slow for the bank: a large, faint mass that tumbles at puff speed reads as
    // a spinning sprite, which is exactly the tell all of this is trying to lose.
    p.spin = (Math.random() - 0.5) * (s.spinRate ?? 1.7);
    // Per-particle swirl. Without an independent phase AND frequency the whole
    // plume oscillates together, which reads as one wobbling sheet rather than
    // turbulence.
    p.turbPhase = Math.random() * Math.PI * 2;
    p.turbFreq = 2.2 + Math.random() * 3.4;

    // A random window into the tiling noise: this is what gives every puff its
    // own silhouette. The drift direction then churns that window over life.
    p.noiseU = Math.random() * 8;
    p.noiseV = Math.random() * 8;
    const driftAngle = Math.random() * Math.PI * 2;
    p.noiseDu = Math.cos(driftAngle);
    p.noiseDv = Math.sin(driftAngle);
    p.noiseScale = (s.noiseScale ?? 1) * (0.78 + Math.random() * 0.55);
    const jitter = s.tintJitter ?? 0;
    p.tintMul = 1 + (Math.random() - 0.5) * 2 * jitter;
  }

  /** Sun direction, pointing TOWARD the sun. Drives the per-pixel shading. */
  setSunDirection(v) {
    if (v && v.lengthSq() > 1e-8) _smokeSun.copy(v).normalize();
  }

  /**
   * Sun colour and intensity, so smoke picks up the time of day — warm and dim
   * at dusk rather than always lit by a white noon sun.
   *
   * Intensity is normalised against a reference rather than used raw: the scene
   * sun runs at physical-ish values (~2.5), and multiplying by that directly
   * would blow every puff to white and make `sunStrength` unusable as a dial.
   * What matters here is the RATIO to a normal day, so dusk dims the smoke.
   *
   * @param {THREE.Color} color
   * @param {number} [intensity]
   */
  setSunColor(color, intensity = SUN_REFERENCE_INTENSITY) {
    if (!color) return;
    const k = THREE.MathUtils.clamp(intensity / SUN_REFERENCE_INTENSITY, 0, 1.5);
    this.uSunColor.value.copy(color).multiplyScalar(k);
  }

  /** `_smokeTint` is set by the caller (age ramp) before this runs. */
  _writeParticle(index, center, size, rotation, alpha, thresh, nu, nv, nScale) {
    // The sphere is the particle; the quad only has to cover its projection —
    // EXACTLY, which is R / √(1 − (R/d)²). See K_MAX for the derivation and for
    // why the old flat 1.2× was both wasteful far away and short up close. The
    // cap is what stops it diverging as the camera reaches the surface; by then
    // the proximity fade in `_stepPool` has already taken the alpha to zero.
    const radius = size * 0.5;
    const k = Math.min(radius / Math.max(this._camDist, 1e-4), K_MAX);
    const half = radius / Math.sqrt(1 - k * k);

    // ── THE CARD IS THE STREAK ────────────────────────────────────────────
    //
    // In streak mode the quad is not scaffolding for a volume any more — it IS
    // the drawn shape, a thin lozenge shaded in its own UV. So it is built
    // directly: along the particle's apparent motion (see `_streakX/_streakY`),
    // as long as that motion carries it in one shutter, and `half` wide.
    //
    // Nothing is inscribed in anything, which is what makes this immune to the
    // failure the ellipsoid had — there is no volume that can outgrow its card
    // and turn into a visible rectangle.
    let cosR = Math.cos(rotation);
    let sinR = Math.sin(rotation);
    let halfLong = half;
    if (this._streakOn) {
      const sx = this._streakX;
      const sy = this._streakY;
      const sLen = Math.hypot(sx, sy);
      if (sLen > 1e-4) {
        cosR = sx / sLen;
        sinR = sy / sLen;
        // Distance travelled on screen in one shutter, converted to world units
        // at this particle's depth — `_streakX/Y` are already camera-plane rates
        // in metres per second, so the shutter alone does the conversion.
        // Floored at `half` so a nearly-stationary droplet stays a dot rather
        // than collapsing to a sliver.
        halfLong = Math.max(half, half + sLen * this._shutter * 0.5);
        // And CEILINGED as a sweep of the frame, not as a length in metres.
        // Motion blur that runs much past a quarter of the frame stops reading
        // as blur and starts reading as a line drawn on the lens, and the
        // ceiling has to scale with depth to mean the same thing near and far —
        // hence depth × a tangent rather than a constant. This is a backstop:
        // with the near-plane fade honest, ordinary spray never reaches it.
        // Never below `half`, so the cap can only shorten a streak, never
        // pinch a big close particle into a sliver narrower than it is wide.
        halfLong = Math.max(half, Math.min(halfLong, this._camDepth * STREAK_MAX_SWEEP));
      }
    }
    const posOffset = index * FLOATS_PER_PARTICLE;
    const tintOffset = index * TINT_FLOATS_PER_PARTICLE;
    const noiseOffset = index * NOISE_FLOATS_PER_PARTICLE;
    const sphereOffset = index * SPHERE_FLOATS_PER_PARTICLE;
    const classOffset = index * CLASS_FLOATS_PER_PARTICLE;
    const worldMul = this._worldScaleMul;
    const worldMix = this._worldMixMul;

    for (let i = 0; i < VERTS_PER_PARTICLE; i++) {
      const so = sphereOffset + i * 4;
      this.spheres[so] = center.x;
      this.spheres[so + 1] = center.y;
      this.spheres[so + 2] = center.z;
      this.spheres[so + 3] = radius;
      const co = classOffset + i * 2;
      this.classes[co] = worldMix;
      this.classes[co + 1] = worldMul;
    }

    for (let i = 0; i < VERTS_PER_PARTICLE; i++) {
      // Anisotropic FIRST, then rotate: scaling after the rotation would stretch
      // the card along the screen axes instead of along the streak.
      const lx = _CORNERS[i][0] * halfLong;
      const ly = _CORNERS[i][1] * half;
      const rx = lx * cosR - ly * sinR;
      const ry = lx * sinR + ly * cosR;
      _smokeHalfRight.copy(_smokeRight).multiplyScalar(rx);
      _smokeHalfUp.copy(_smokeUp).multiplyScalar(ry);
      _smokeCorner.copy(center).add(_smokeHalfRight).add(_smokeHalfUp);

      const po = posOffset + i * 3;
      this.positions[po] = _smokeCorner.x;
      this.positions[po + 1] = _smokeCorner.y;
      this.positions[po + 2] = _smokeCorner.z;

      const to = tintOffset + i * 4;
      this.tints[to] = _smokeTint.r;
      this.tints[to + 1] = _smokeTint.g;
      this.tints[to + 2] = _smokeTint.b;
      this.tints[to + 3] = alpha;

      const no = noiseOffset + i * 4;
      this.noise[no] = nu;
      this.noise[no + 1] = nv;
      this.noise[no + 2] = nScale;
      this.noise[no + 3] = thresh;
    }
  }
}
