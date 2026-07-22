/**
 * Advanced Terrain Erosion Filter — TSL port.
 *
 * Unlike globalErosion.js (droplet sim) and streamPowerErosion.js (stream-power
 * law), this is NOT a simulation. It is a closed-form noise function that
 * *looks* eroded: every point is evaluated in isolation from the input height
 * and gradient, so there are no iterations, no ping-pong buffers, and no
 * neighbourhood dependency. A full 1024² bake is a single fragment pass.
 *
 * The core trick: water flows down the negative gradient, so lay alternating
 * gully/ridge stripes ALONG that direction. Phacelle noise ("phase" + "cell")
 * builds those stripes by blending cosine/sine waves from a 4×4 neighbourhood
 * of jittered cells, which makes them curve smoothly instead of tiling. Each
 * octave's gullies modify the gradient, so the next (smaller) octave carves
 * along the slopes the previous one just created — that is what produces
 * branching, dendritic drainage rather than uniform corduroy.
 *
 * Because cos/sin come in pairs, the derivative is analytic: the filter outputs
 * an exact slope delta, so normals are exact and free. The secondary "ridge
 * map" output (-1 in creases, +1 on ridges) is the drainage-network mask, handy
 * for texturing, sediment darkening, and masking scatter off ridgelines.
 *
 * Everything here is plain JS composing TSL nodes (the proceduralGenGpu.js
 * pattern) rather than Fn() wrappers, because the filter has seven pieces of
 * loop-carried state and TSL has no multiple-return. It inlines either way.
 *
 * Ported from Rune Skovbo Johansen's Shadertoy "Advanced Terrain Erosion
 * Filter" (https://www.shadertoy.com/view/wXcfWn), by way of Luke Mitchell's
 * C# translation (github.com/lpmitchell/AdvancedTerrainErosion).
 * Original filter and Phacelle noise copyright (c) 2025 Rune Skovbo Johansen,
 * Mozilla Public License v2.0 — https://mozilla.org/MPL/2.0/.
 */
import {
  float, uniform, vec2, vec3, vec4,
  abs, clamp, cos, dot, exp, floor, fract, length, max, mix, pow, sign, sin, sqrt, step,
} from "three/tsl";

/** Octaves are unrolled at build time; the live count is gated per octave. */
export const MAX_EROSION_OCTAVES = 8;
export const MAX_TERRAIN_OCTAVES = 8;

const EPS = 1e-10;
const TAU = Math.PI * 2;

// Hash constants from the original — irrational so the lattice never repeats.
const HASH_K = [1 / Math.PI, Math.exp(-1)];
const HASH_SEED_SCALE = [0.06711056, 0.00583715];

/**
 * Defaults matching the Shadertoy / Unity port. `rounding` and `onset` are
 * packed vec4s in the original; kept as named fields here so the UI can label
 * them, and packed only at the call site.
 *
 *   rounding : [crease, ridge, inputMult, perOctaveMult]
 *   onset    : [input, octave, ridgeMapInput, ridgeMapOctave]
 */
export const EROSION_FILTER_DEFAULTS = {
  scale: 0.15,
  strength: 0.22,
  gullyWeight: 0.5,
  detail: 1.5,
  roundingCrease: 0.1,
  roundingRidge: 0.0,
  roundingInput: 0.1,
  roundingFalloff: 2.0,
  onsetInput: 1.25,
  onsetOctave: 1.25,
  onsetRidgeInput: 2.8,
  onsetRidgeOctave: 1.5,
  assumedSlope: 0.7,
  assumedSlopeMix: 1.0,
  cellScale: 0.7,
  octaves: 5,
  gain: 0.5,
  lacunarity: 2.0,
  normalization: 0.5,
};

/** Base FBM terrain the filter is layered onto (Shadertoy parity settings). */
export const TERRAIN_NOISE_DEFAULTS = {
  frequency: 3.0,
  amplitude: 0.125,
  octaves: 3,
  gain: 0.1,
  lacunarity: 2.0,
  heightOffset: -0.65,
  heightOffsetMix: 0.0,
};

/**
 * Build the uniform set the filter reads. Shared by the lab and any bake pass
 * so there is exactly one place where a parameter name is spelled.
 * `sync(params)` takes a flat object of the two DEFAULTS above (plus `seed`).
 */
export function createErosionUniforms(initial = {}) {
  const p = { ...EROSION_FILTER_DEFAULTS, ...TERRAIN_NOISE_DEFAULTS, seed: 1337, ...initial };

  const names = [
    "scale", "strength", "gullyWeight", "detail",
    "roundingCrease", "roundingRidge", "roundingInput", "roundingFalloff",
    "onsetInput", "onsetOctave", "onsetRidgeInput", "onsetRidgeOctave",
    "assumedSlope", "assumedSlopeMix", "cellScale", "octaves", "gain",
    "lacunarity", "normalization", "seed", "heightOffset", "heightOffsetMix",
  ];

  const u = {};
  for (const n of names) u[n] = uniform(float(p[n]));

  // Terrain-noise uniforms get a prefix so `u` can be passed around as one bag.
  u.terrainFrequency = uniform(float(p.frequency));
  u.terrainAmplitude = uniform(float(p.amplitude));
  u.terrainOctaves = uniform(float(p.octaves_terrain ?? TERRAIN_NOISE_DEFAULTS.octaves));
  u.terrainGain = uniform(float(p.gain_terrain ?? TERRAIN_NOISE_DEFAULTS.gain));
  u.terrainLacunarity = uniform(float(p.lacunarity_terrain ?? TERRAIN_NOISE_DEFAULTS.lacunarity));

  u.sync = (params) => {
    for (const n of names) {
      if (params[n] !== undefined) u[n].value = params[n];
    }
    if (params.frequency !== undefined) u.terrainFrequency.value = params.frequency;
    if (params.amplitude !== undefined) u.terrainAmplitude.value = params.amplitude;
    if (params.octaves_terrain !== undefined) u.terrainOctaves.value = params.octaves_terrain;
    if (params.gain_terrain !== undefined) u.terrainGain.value = params.gain_terrain;
    if (params.lacunarity_terrain !== undefined) u.terrainLacunarity.value = params.lacunarity_terrain;
  };

  return u;
}

// ── small shader-style helpers ─────────────────────────────────────────────

const sat = (v) => clamp(v, float(0), float(1));

/** 1-(1-t)² — decelerating ramp, used to fade masks in. */
const easeOut = (t) => {
  const v = float(1).sub(sat(t));
  return float(1).sub(v.mul(v));
};

/** 1-(1-t)^p — easeOut with an adjustable exponent. */
const powInv = (t, p) => float(1).sub(pow(float(1).sub(sat(t)), p));

/**
 * Identity above `smoothing`, quadratic ease below it. Rounds off the bottom of
 * the mask ramp so gullies start gently instead of with a hard crease.
 * Branchless: the original's `if (t >= smoothing)`.
 */
const smoothStart = (t, smoothing) => {
  const s = max(smoothing, float(EPS));
  return mix(float(0.5).mul(t).mul(t).div(s), t.sub(float(0.5).mul(s)), step(s, t));
};

/** Normalize with a zero-length guard (Unity's normalizesafe). */
const normalizeSafe = (v) => v.div(max(length(v), float(EPS)));

/** 2D value hash → [-1,1]². Seed shifts the lattice rather than the coords. */
function hash2(x, seed) {
  const k = vec2(float(HASH_K[0]), float(HASH_K[1]));
  const seedOffset = vec2(seed.mul(float(HASH_SEED_SCALE[0])), seed.mul(float(HASH_SEED_SCALE[1])));
  const xs = x.add(seedOffset).mul(k).add(vec2(float(HASH_K[1]), float(HASH_K[0])));
  const t = fract(xs.x.mul(xs.y).mul(xs.x.add(xs.y)));
  return float(-1).add(float(2).mul(fract(float(16).mul(k).mul(t))));
}

// ── Phacelle noise ─────────────────────────────────────────────────────────

/**
 * Stripe pattern aligned to `normDir`, built by blending cos/sin waves from a
 * 4×4 block of jittered cells. "Phacelle" = phase + cell.
 *
 * Returns vec4(cos, sin, sideDir.x, sideDir.y). The cos/sin pair is normalized
 * back onto the unit circle (partially, per `normalization`), which keeps the
 * wave amplitude constant where neighbouring cells' waves disagree and would
 * otherwise cancel into mush. Multiplying `sin` by `sideDir` gives the exact
 * derivative of `cos`.
 *
 * @param {*} p        evaluation point, already scaled by the octave frequency
 * @param {*} normDir  unit stripe direction (the downhill gradient)
 * @param {*} freq     stripes per cell — keep near 1.0 or the waves distort
 * @param {*} offset   phase offset in cycles
 * @param {*} normalization  0..1, how far to renormalize weak waves
 * @param {*} seed
 */
export function phacelleNoise(p, normDir, freq, offset, normalization, seed) {
  // Orthogonal to the stripe direction, scaled so the wave advances at `freq`
  // cycles per cell. The stripes run along normDir; the wave varies across it.
  const sideDir = vec2(normDir.y.negate(), normDir.x).mul(freq).mul(float(TAU)).toVar();
  const phase = offset.mul(float(TAU));

  const pInt = floor(p).toVar();
  const pFrac = fract(p).toVar();

  const phaseDir = vec2(0, 0).toVar();
  const weightSum = float(0).toVar();

  // 4×4 rather than 3×3: cells are jittered by up to ±0.5, so a cell outside
  // this block can never be closer than 1.5 units — where the weight is 0.
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 2; j++) {
      const gridOffset = vec2(float(i), float(j));
      const randomOffset = hash2(pInt.add(gridOffset), seed).mul(float(0.5));

      // p relative to this cell's jittered point, without reconstructing it:
      // p - (pInt + gridOffset + randomOffset) == pFrac - gridOffset - randomOffset
      const fromCell = pFrac.sub(gridOffset).sub(randomOffset);

      // Bell weight: 1 at the cell point, ~0 by 1.5 units out. The subtraction
      // drives it to exactly 0 there, killing faint grid-line artefacts.
      const sqrDist = dot(fromCell, fromCell);
      const weight = max(float(0), exp(sqrDist.mul(float(-2))).sub(float(0.01111)));

      weightSum.addAssign(weight);

      // Gradient increasing across the stripes at `freq`·τ per cell.
      const waveInput = dot(fromCell, sideDir).add(phase);
      phaseDir.addAssign(vec2(cos(waveInput), sin(waveInput)).mul(weight));
    }
  }

  const interpolated = phaseDir.div(max(weightSum, float(EPS))).toVar();

  // Treat (cos,sin) as a point on a circle and push it back out to radius 1.
  // Clamping the divisor at (1-normalization) means only sufficiently strong
  // waves get fully normalized — full normalization everywhere amplifies noise
  // at the cancellation points into visible speckle.
  const magnitude = max(float(1).sub(normalization), sqrt(dot(interpolated, interpolated)));

  return vec4(interpolated.div(magnitude), sideDir);
}

// ── the erosion filter ─────────────────────────────────────────────────────

/**
 * Apply the erosion filter at a point.
 *
 * @param {*} p  2D sample position, in the same space the base height was
 *   sampled from. This is the ONLY coupling to the terrain source — feed it
 *   procedural noise coords or heightmap UVs, the filter does not care.
 * @param {*} heightAndSlope  vec3(height, dH/dx, dH/dy) of the *input* terrain.
 *   The gradient is what the whole technique keys off; if it is wrong (or
 *   zero), you get no coherent gullies.
 * @param {*} fadeTarget  -1 in valleys, +1 on peaks. Where the mask says "too
 *   flat to erode", gullies fade toward this instead of toward zero, which is
 *   what keeps peaks pointed and valley floors flat instead of both turning to
 *   mush. Usually derived from altitude.
 * @param {object} u  uniforms (see erosionUniformSpec)
 * @returns {{ delta: *, magnitude: *, ridgeMap: * }}
 *   delta = vec3(heightDelta, slopeDeltaX, slopeDeltaY) — ADD to the input.
 *   magnitude = summed octave strength, for scaling the height offset.
 *   ridgeMap = -1 in creases, +1 on ridges.
 */
export function erosionFilter(p, heightAndSlope, fadeTargetIn, u) {
  const rounding = vec4(u.roundingCrease, u.roundingRidge, u.roundingInput, u.roundingFalloff);
  const onset = vec4(u.onsetInput, u.onsetOctave, u.onsetRidgeInput, u.onsetRidgeOctave);

  const inputHeightAndSlope = heightAndSlope.toVar();

  // Loop-carried state. Each is mix()ed against the octave gate below so that
  // disabled octaves are exact no-ops.
  const hs = heightAndSlope.toVar();
  const fadeTarget = clamp(fadeTargetIn, float(-1), float(1)).toVar();
  const magnitude = float(0).toVar();
  const strength = u.strength.mul(u.scale).toVar();
  const freq = float(1).div(u.scale.mul(u.cellScale)).toVar();
  const roundingMult = float(1).toVar();

  const slopeLength = max(length(heightAndSlope.yz), float(EPS)).toVar();

  // The mask gates erosion on steepness: flat ground stays flat. It compounds
  // across octaves (each octave's own slope narrows it further), which is what
  // confines fine gullies to the walls the coarse ones carved.
  const roundingForInput = mix(rounding.y, rounding.x, sat(fadeTarget.add(float(0.5)))).mul(rounding.z);
  const combiMask = easeOut(smoothStart(slopeLength.mul(onset.x), roundingForInput.mul(onset.x))).toVar();

  const ridgeMapCombiMask = easeOut(slopeLength.mul(onset.z)).toVar();
  const ridgeMapFadeTarget = fadeTarget.toVar();

  // Gully directions can follow the true slope or a fixed assumed steepness.
  // Blending toward an assumed slope keeps gullies coherent across near-flat
  // ground where the real gradient direction is numerically meaningless.
  const gullySlope = mix(
    heightAndSlope.yz,
    heightAndSlope.yz.div(slopeLength).mul(u.assumedSlope),
    u.assumedSlopeMix,
  ).toVar();

  for (let i = 0; i < MAX_EROSION_OCTAVES; i++) {
    const gate = step(float(i + 0.5), u.octaves);

    const phacelle = phacelleNoise(
      p.mul(freq), normalizeSafe(gullySlope), u.cellScale, float(0.25), u.normalization, u.seed,
    ).toVar();

    // Chain rule for the p·freq scaling, negated because slope points downhill.
    const dWave = phacelle.zw.mul(freq.negate()).toVar();

    // |sin| — 1 on the steep flanks of the stripe, 0 at crest and trough.
    const sloping = abs(phacelle.y);

    // Feed this octave's slope forward so the next one carves along the walls
    // it just made. Normalized (sign, not value) so gullies branch at clean
    // angles instead of curling along their parent.
    const nextGullySlope = gullySlope.add(sign(phacelle.y).mul(dWave).mul(strength).mul(u.gullyWeight));

    // Height offset in x, its derivative in yz.
    const gullies = vec3(phacelle.x, phacelle.y.mul(dWave));

    const fadedGullies = mix(
      vec3(fadeTarget, float(0), float(0)),
      gullies.mul(u.gullyWeight),
      combiMask,
    ).toVar();

    const nextHs = hs.add(fadedGullies.mul(strength));
    const nextMagnitude = magnitude.add(strength);

    // Next octave fades toward THIS octave's ridges/creases rather than the
    // original altitude — so small gullies don't cut through big crests.
    const nextFadeTarget = fadedGullies.x;

    const roundingForOctave = mix(rounding.y, rounding.x, sat(phacelle.x.add(float(0.5)))).mul(roundingMult);
    const newMask = easeOut(smoothStart(sloping.mul(onset.y), roundingForOctave.mul(onset.y)));
    const nextCombiMask = powInv(combiMask, u.detail).mul(newMask);

    const nextRidgeFade = mix(ridgeMapFadeTarget, gullies.x, ridgeMapCombiMask);
    const nextRidgeMask = ridgeMapCombiMask.mul(easeOut(sloping.mul(onset.w)));

    hs.assign(mix(hs, nextHs, gate));
    magnitude.assign(mix(magnitude, nextMagnitude, gate));
    fadeTarget.assign(mix(fadeTarget, nextFadeTarget, gate));
    combiMask.assign(mix(combiMask, nextCombiMask, gate));
    gullySlope.assign(mix(gullySlope, nextGullySlope, gate));
    ridgeMapFadeTarget.assign(mix(ridgeMapFadeTarget, nextRidgeFade, gate));
    ridgeMapCombiMask.assign(mix(ridgeMapCombiMask, nextRidgeMask, gate));

    strength.mulAssign(u.gain);
    freq.mulAssign(u.lacunarity);
    roundingMult.mulAssign(rounding.w);
  }

  return {
    delta: hs.sub(inputHeightAndSlope),
    magnitude,
    ridgeMap: ridgeMapFadeTarget.mul(float(1).sub(ridgeMapCombiMask)),
  };
}

// ── base terrain (analytic-derivative gradient noise) ──────────────────────

/**
 * Gradient noise returning vec3(value, dV/dx, dV/dy).
 * From iq's https://www.shadertoy.com/view/XdXBRH — the analytic derivatives
 * are the point: the filter needs an exact gradient, and finite differences of
 * a procedural field cost as many samples as they save.
 */
export function noised(p, seed) {
  const i = floor(p).toVar();
  const f = fract(p).toVar();

  // Quintic smoothstep and its derivative.
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(float(6)).sub(float(15))).add(float(10))).toVar();
  const du = float(30).mul(f).mul(f).mul(f.mul(f.sub(float(2))).add(float(1))).toVar();

  const ga = hash2(i.add(vec2(0, 0)), seed).toVar();
  const gb = hash2(i.add(vec2(1, 0)), seed).toVar();
  const gc = hash2(i.add(vec2(0, 1)), seed).toVar();
  const gd = hash2(i.add(vec2(1, 1)), seed).toVar();

  const va = dot(ga, f.sub(vec2(0, 0))).toVar();
  const vb = dot(gb, f.sub(vec2(1, 0))).toVar();
  const vc = dot(gc, f.sub(vec2(0, 1))).toVar();
  const vd = dot(gd, f.sub(vec2(1, 1))).toVar();

  const abcd = va.sub(vb).sub(vc).add(vd).toVar();

  const value = va
    .add(u.x.mul(vb.sub(va)))
    .add(u.y.mul(vc.sub(va)))
    .add(u.x.mul(u.y).mul(abcd));

  const grad = ga
    .add(u.x.mul(gb.sub(ga)))
    .add(u.y.mul(gc.sub(ga)))
    .add(u.x.mul(u.y).mul(ga.sub(gb).sub(gc).add(gd)))
    .add(du.mul(vec2(u.y, u.x).mul(abcd).add(vec2(vb, vc)).sub(va)));

  return vec3(value, grad);
}

/** FBM of `noised`, returning vec3(height, dH/dx, dH/dy) in roughly [-1,1]. */
export function fractalNoise(p, u) {
  const n = vec3(0, 0, 0).toVar();
  const nf = u.terrainFrequency.toVar();
  const na = float(1).toVar();

  for (let i = 0; i < MAX_TERRAIN_OCTAVES; i++) {
    const gate = step(float(i + 0.5), u.terrainOctaves);
    const octave = noised(p.mul(nf), u.seed);
    n.x.addAssign(octave.x.mul(na).mul(gate));
    // Derivatives pick up the frequency factor from the chain rule.
    n.yz.addAssign(octave.yz.mul(na.mul(nf)).mul(gate));

    na.mulAssign(u.terrainGain);
    nf.mulAssign(u.terrainLacunarity);
  }

  return n;
}

/**
 * Full pipeline: base FBM terrain → erosion filter → final height.
 * This is the Shadertoy's `Sample()`, and the reference for what the filter
 * should look like before it is pointed at a real heightmap.
 *
 * @returns {{ height: *, slope: *, ridgeMap: * }} height in [0,1]-ish,
 *   slope = the eroded gradient (for analytic normals), ridgeMap in [-1,1].
 */
export function erodedTerrain(p, u) {
  const n = fractalNoise(p, u).mul(u.terrainAmplitude).toVar();

  // Altitude-driven fade target, normalized against most of the height range.
  // Overshoot past ±1 is fine and gets clamped inside the filter.
  const fadeTarget = clamp(n.x.div(u.terrainAmplitude.mul(float(0.6))), float(-1), float(1));

  // Base terrain to [0,1]; only the height shifts, the derivatives just halve.
  const base = n.mul(float(0.5)).add(vec3(float(0.5), float(0), float(0))).toVar();

  const ero = erosionFilter(p, base, fadeTarget, u);

  // Optional bulk shift proportional to how much erosion was applied — lets
  // the filter lower overall mass (material removed) rather than only adding.
  const offset = mix(u.heightOffset, fadeTarget.negate(), u.heightOffsetMix).mul(ero.magnitude);

  return {
    height: base.x.add(ero.delta.x).add(offset),
    slope: base.yz.add(ero.delta.yz),
    ridgeMap: ero.ridgeMap,
  };
}

/**
 * Sample height + gradient from an existing heightmap by central differences —
 * the entry point for running the filter over v3's sculpted terrain instead of
 * procedural noise.
 *
 * `texelSize` is 1/resolution in UV; `worldPerUv` converts the UV-space
 * derivative into the same units the height is in, so the gradient the filter
 * receives is a true slope and not a resolution-dependent number.
 */
export function heightAndSlopeFromTexture(heightTex, uvCoord, texelSize, worldPerUv) {
  const l = heightTex.sample(uvCoord.sub(vec2(texelSize, float(0)))).r;
  const r = heightTex.sample(uvCoord.add(vec2(texelSize, float(0)))).r;
  const d = heightTex.sample(uvCoord.sub(vec2(float(0), texelSize))).r;
  const uP = heightTex.sample(uvCoord.add(vec2(float(0), texelSize))).r;
  const c = heightTex.sample(uvCoord).r;

  const inv = float(1).div(float(2).mul(texelSize).mul(worldPerUv));
  return vec3(c, r.sub(l).mul(inv), uP.sub(d).mul(inv));
}
