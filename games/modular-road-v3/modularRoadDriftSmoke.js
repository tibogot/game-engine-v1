import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  attribute, cameraFar, cameraNear, cameraPosition, Discard, dot, exp, float,
  Fn, length, max, min, mix, normalize, normalWorld, perspectiveDepthToViewZ,
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

export const DEFAULT_DRIFT_SMOKE_SETTINGS = {
  enabled: true,
  emitRate: 150,
  trigger: 0.04,
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
 * own sphere's silhouette, and worse the closer you get. 1.2 covers R/d ≈ 0.55.
 * The extra area costs almost nothing: it misses the sphere and discards.
 */
const QUAD_OVERSIZE = 1.2;
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

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    // Density is needed by BOTH the colour (self-shadowing) and the alpha
    // (erosion), so one node builds the pair and each slot takes its component.
    // Same node object in both, so the graph is emitted once.
    const shaded = this._buildShadedNode().toVar();
    material.colorNode = shaded.xyz;
    material.opacityNode = shaded.w;

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
    this.puffEmitter = { list: this.particles, size: POOL_SIZE, index: 0, accum: [0, 0] };
    this.hazeEmitter = { list: this.hazeParticles, size: HAZE_POOL_SIZE, index: 0, accum: [0, 0] };
    this._worldDriftPhase = 0;
    /** World-noise frequency / mix of the class currently being stepped. */
    this._worldScaleMul = 1;
    this._worldMixMul = 1;
    /** Master visibility. Both meshes also hide themselves when empty, so this
     *  is ANDed in rather than written straight to `mesh.visible`. */
    this._visible = true;
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
   * vertices — and a FrontSide sphere actually covers LESS screen than the
   * 1.2×-oversized quad it replaces.
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

    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      // FrontSide, not Double: a closed sphere would otherwise blend twice per
      // pixel, doubling both the cost and the density.
      side: THREE.FrontSide,
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
  }

  /**
   * Bank shading. Same lighting model as the puffs, but everything geometric
   * comes from the real surface instead of being reconstructed from a quad.
   */
  _buildBankNode() {
    const tint = attribute("iTint", "vec4");
    const thresh = attribute("iThresh", "float");
    const noiseMap = this.noiseMap;
    const softDepth = this.uSoftDepth;
    const erodeSoft = this.uErodeSoft;
    const {
      uSunWorld, uLightAmount, uAmbient, uSunStrength, uAbsorb, uScatter, uHgG,
      uSunColor, uWorldScale, uWorldDrift, uBankScale,
    } = this;

    return Fn(() => {
      const N = normalize(normalWorld).toVar();
      const toCam = cameraPosition.sub(positionWorld);
      const dist = length(toCam).toVar();
      const V = toCam.div(dist).toVar();   // toward the camera
      const rd = V.negate();

      // Triplanar, in WORLD space. Two things fall out of that: it is genuinely
      // 3D so it parallaxes as you move (the whole point of leaving billboards
      // behind), and neighbouring spheres address the same field, so they erode
      // along shared filaments and fuse into one mass instead of reading as a
      // bag of balls.
      const aN = N.abs();
      const bl = aN.div(aN.x.add(aN.y).add(aN.z).add(0.0001));
      const wp = positionWorld.mul(uWorldScale.mul(uBankScale));
      const off = uWorldDrift;
      const sX = texture(noiseMap, wp.yz.add(off)).r;
      const sY = texture(noiseMap, wp.xz.add(off)).r;
      const sZ = texture(noiseMap, wp.xy.add(off)).r;
      const detail = sX.mul(bl.x).add(sY.mul(bl.y)).add(sZ.mul(bl.z));

      // Thickness through the sphere, for free. How square-on the surface faces
      // you IS the chord length: 1 through the middle, 0 at the silhouette. No
      // ray-sphere maths needed once the geometry is really there.
      const facing = saturate(dot(N, V));
      const density = facing.mul(float(0.32).add(detail.mul(0.95))).toVar();

      const alpha = smoothstep(thresh, thresh.add(erodeSoft), density)
        .mul(tint.w)
        .toVar();

      // Soft particles, same as the puffs: without it a sphere resting on the
      // road cuts a hard circle into the tarmac.
      const sceneDist = perspectiveDepthToViewZ(
        _sceneDepthTex.sample(screenUV).r, cameraNear, cameraFar,
      ).negate();
      const fragDist = positionView.z.negate();
      alpha.mulAssign(saturate(sceneDist.sub(fragDist).div(max(softDepth, float(1e-3)))));
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
      const t0 = b.negate().sub(sq);   // entry
      const t1 = b.negate().add(sq);   // exit

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
      e.accum[0] = 0;
      e.accum[1] = 0;
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

    let rearSlip = 0;
    let rearOver = 0;
    let rearIdx = 0;
    let hasRear = false;
    for (const tire of vehicle.tires) {
      if (tire.canSteer) continue;
      const contact = rearIdx === 0 ? _rearContact0 : _rearContact1;
      if (tire.grounded) {
        hasRear = true;
        contact.copy(tire.hitPoint).addScaledVector(tire.hitNormal, MARK_Y_OFFSET);
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
    const emitSmoke =
      hasRear &&
      !inAir &&
      speed > ENTRY_SPEED * 0.55 &&
      (driftIntensity > trigger ||
        (handbrake && speed > ENTRY_SPEED * 0.55));
    const smokeIntensity = Math.max(driftIntensity, handbrake ? 0.45 : 0);

    this.update(
      dt,
      hasRear ? _rearPoints : [],
      emitSmoke,
      smokeIntensity,
      body.vel.x,
      body.vel.z,
      camera,
    );
  }

  update(dt, rearPoints, emit, intensity, velocityX, velocityZ, camera) {
    const s = this.settings;
    if (s.enabled === false) emit = false;
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
      this._emit(this.puffEmitter, s, s.emitRate ?? EMIT_RATE,
        rearPoints, intensity, velocityX, velocityZ, dt);
      if (hazeOn) {
        this._emit(this.hazeEmitter, haze, haze.emitRate ?? 12,
          rearPoints, intensity, velocityX, velocityZ, dt);
      }
    } else {
      this.puffEmitter.accum[0] = 0;
      this.puffEmitter.accum[1] = 0;
      this.hazeEmitter.accum[0] = 0;
      this.hazeEmitter.accum[1] = 0;
    }

    camera.updateMatrixWorld();
    _smokeRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    _smokeUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
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
      }
    }

    const alive = this._stepPool(this.particles, s, dt, false);
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
  _emit(emitter, cfg, rate, rearPoints, intensity, velocityX, velocityZ, dt) {
    const perSecond = rate * THREE.MathUtils.clamp(intensity, 0, 1);
    for (let i = 0; i < rearPoints.length; i++) {
      const point = rearPoints[i];
      if (!point || point.y < -9000) continue;
      emitter.accum[i] += perSecond * dt;
      while (emitter.accum[i] >= 1) {
        this.emitAt(emitter, cfg, point, intensity, velocityX, velocityZ);
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
      const alpha = opacity * rampIn * Math.pow(1 - outT, tailPower);

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

    const t = index * 4;
    this.bankTints[t] = _smokeTint.r;
    this.bankTints[t + 1] = _smokeTint.g;
    this.bankTints[t + 2] = _smokeTint.b;
    this.bankTints[t + 3] = alpha;
    this.bankThresholds[index] = thresh;
  }

  emitAt(emitter, s, point, intensity, velocityX, velocityZ) {
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
    p.velocity.set(
      -dirX * speed * (s.drag ?? SPEED_DRAG) + (Math.random() - 0.5) * 0.45,
      (s.rise ?? RISE) * (0.65 + Math.random() * 0.7),
      -dirZ * speed * (s.drag ?? SPEED_DRAG) + (Math.random() - 0.5) * 0.45,
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
    // The sphere is the particle; the quad only has to cover its projection.
    const radius = size * 0.5;
    const half = radius * QUAD_OVERSIZE;
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
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
      const x = _CORNERS[i][0];
      const y = _CORNERS[i][1];
      const rx = (x * cosR - y * sinR) * half;
      const ry = (x * sinR + y * cosR) * half;
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
