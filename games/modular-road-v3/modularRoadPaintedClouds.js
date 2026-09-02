/**
 * PAINTED CLOUDS — the cheap tier, for machines that cannot afford the raymarch.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * V2: A SLAB MARCH, NOT A STENCIL ON A PLANE. Why the first version looked wrong.
 *
 * v1 projected the view ray onto ONE plane, thresholded a 2D field there and shaded the
 * result with a fake normal. It read as a painted ceiling, and no amount of shading was
 * ever going to fix that, because three things the eye uses to identify cloud cannot
 * exist on a single plane:
 *
 *   • THICKNESS. A cloud seen from below-and-ahead shows its side. A plane shows its
 *     face, always, everywhere — so the deck reads as wallpaper however good the noise.
 *   • SELF-OCCLUSION. Real masses hide each other and pile up toward the horizon. On a
 *     plane every cloud is exactly as visible as every other, which is why v1's sky
 *     looked like a map of islands rather than weather.
 *   • SOFT EDGES FROM DEPTH. A cloud edge is thin cloud you can see through, not an
 *     alpha ramp. Thresholding a plane gives torn-paper outlines.
 *
 * So this marches a THIN SLAB instead: 12 steps between a base and a top altitude,
 * integrating density with Beer-Lambert exactly as the volumetric deck does. That buys
 * every one of the three above, and it is still nothing like the volumetric's cost —
 * 12 steps against 160, a 2D map against three 3D volumes, no render targets, no
 * temporal pass, no worker bake, and it lives inside the sky dome's own fragment shader
 * so it adds no draw call at all.
 *
 * The shape recipe is the volumetric deck's, ported down a dimension: Perlin-Worley
 * masses, coverage as a THRESHOLD (never a multiplier — see modularRoadClouds.js),
 * per-cell cloud TOPS so neighbours differ in height, and Worley billow erosion whose
 * lookup shifts with altitude so a mass is not merely its own outline extruded.
 *
 * @see modularRoadClouds.js — the expensive tier this stands in for
 * @see modularRoadSky.js    — composites this last, so cloud occludes stars/moon/sun
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, If, Loop, Break, uniform, texture, uv,
  normalize, dot, max, min, mix, smoothstep, pow, exp, abs, saturate,
  screenCoordinate, interleavedGradientNoise,
} from "three/tsl";
import {
  seededRandom, makePeriodicPerlin, perlinFbm, makeWorley, normalizeChannel,
} from "./modularRoadCloudNoise.js";

/** Bake resolution. 256² over a few km is ~15 m per texel — finer than the billow
 *  octave the shader erodes with, and 256 KB of VRAM. */
export const PAINTED_MAP_SIZE = 256;
/** Compile-time ceiling on the march; `steps` cuts the loop short at runtime. */
const MAX_STEPS = 24;

export const PAINTED_CLOUD_DEFAULTS = {
  // NO `enabled` FLAG HERE, deliberately. The cloud TIER owns whether this deck exists
  // at all (see roadGame's setCloudTier): out of its tier the module is never
  // constructed, so there is nothing to switch off — no bake, no texture, and no cloud
  // code in the dome's shader. A local enabled flag would be a second, weaker source of
  // truth that reads as if the deck were merely hidden while still costing fetches.

  // ── Shape ────────────────────────────────────────────────────────────────────────
  /** Metres to the BASE of the deck. */
  altitude: 1150,
  /** Metres from base to top. This is the slab the march crosses — it is what gives the
   *  deck thickness, so it is a look control, not just a placement one. */
  thickness: 850,
  /** Metres one wrap of the map covers. Tuned WITH `altitude`: together they set a
   *  cloud's angular size, which is the whole difference between broken cumulus and
   *  smeared overcast. */
  tile: 4300,
  /** Fraction of sky covered. A THRESHOLD, so masses keep solid cores at any setting. */
  coverage: 0.46,
  /** Billow erosion strength — carves mass edges into cauliflower. */
  erode: 0.68,
  /** Extinction per metre at full shaped density. */
  densityMul: 0.055,
  /** Shortest cloud as a fraction of the slab. The spread between this and 1 IS the
   *  towering-vs-flat look: at 1 every cell fills the slab and you get a sheet. */
  topMin: 0.25,
  /** March steps across the slab (≤ MAX_STEPS). */
  steps: 18,

  // ── Lighting ─────────────────────────────────────────────────────────────────────
  /** Extinction along the 2-tap horizontal shadow — mass shadowing mass. */
  absorb: 2.2,
  /** Metres the shadow tap reaches across the deck before the sun-elevation stretch. */
  shadowReach: 900,
  /** Brightness of a cloud BASE relative to its top. The vertical gradient is most of
   *  what reads as volume once the silhouette is right. */
  baseDark: 0.22,
  /** Key-light gain. Droplet albedo is ~0.9 and a sunlit top is far brighter than the
   *  sky beside it; at 1.0 the deck comes out beige because it can never exceed the sun
   *  colour lighting it. */
  sunStrength: 2.1,
  /** Sky ambient reaching the shaded side. 0 = black undersides. */
  ambient: 0.55,
  /** Silver lining on thin cloud when looking toward the sun. */
  silver: 1.1,
  /** How strongly distance dissolves the deck into the sky behind it. */
  aerial: 0.55,
  /** Below this `dir.y` the deck fades out — the slab crossing runs to infinity there. */
  horizonFade: 0.035,

  // ── Ground shadows ───────────────────────────────────────────────────────────────
  /** Max darkening of the world under a cloud. 0 turns the whole pass off — and with it
   *  the custom-cloud render path, so the frame goes back to its plain route. */
  shadowStrength: 0.5,
  /** Edge softness of the shadow threshold, in shaped-density units. */
  shadowSoftness: 0.35,
  /** Metres beyond which shadows fade out, so far terrain does not sparkle. */
  shadowFar: 5000,

  // ── Wind ─────────────────────────────────────────────────────────────────────────
  windDeg: 35,
  /** Metres per second, same units as the volumetric deck so tiers drift alike. */
  windSpeed: 6.0,
};

/**
 * Bake the tileable cloud map. ~120 ms at 256², lazily and only in this tier.
 *
 *   R  coverage   Perlin-Worley mass field — what the coverage threshold cuts
 *   G  cloud top  per-cell height fraction, CORRELATED with coverage
 *   B  billow     Worley FBM — erodes mass edges into cauliflower
 *   A  weather    very low frequency — makes whole regions cloudier or clearer
 *
 * Every channel is percentile-stretched, for the same load-bearing reason the volumetric
 * bake is: raw fbm occupies a narrow mid band, and a threshold against a 0.2-wide range
 * either accepts everything or rejects everything, so the coverage dial does nothing.
 */
export function bakePaintedCloudMap(seed = 4177, size = PAINTED_MAP_SIZE) {
  const rng = seededRandom(seed >>> 0);
  const perlin = makePeriodicPerlin(rng);
  // Worley cell grids. Low frequencies build the masses, high ones erode them.
  const w3 = makeWorley(3, rng), w6 = makeWorley(6, rng);
  const w12 = makeWorley(12, rng), w24 = makeWorley(24, rng);

  const out = new Uint8Array(size * size * 4);
  let i = 0;
  for (let y = 0; y < size; y++) {
    // Divide by size (not size-1) so texel 0 !== texel N-1 and the wrap is seamless.
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      const nx = x / size;

      // PERLIN-WORLEY. Plain Perlin gives smooth amoeba blobs — the "torn paper islands"
      // v1's silhouettes were made of. Inflating it from below by inverted Worley
      // connects it into rounded, lumpy masses, which is what a cumulus outline is.
      const pf = perlinFbm(perlin, nx, ny, 0.13, 3, 5);
      const wf = w3(nx, ny, 0.21) * 0.625 + w6(nx, ny, 0.21) * 0.25 + w12(nx, ny, 0.21) * 0.125;
      const pw = wf + pf * (1 - wf);

      // CLOUD TOP, correlated with coverage — the volumetric deck's lesson: independent
      // top noise puts tall cells on thin mass edges and extrudes narrow chimneys, while
      // real cumulus tower where the mass is fattest.
      const tn = perlinFbm(perlin, nx, ny, 0.41, 2, 3);
      const top = tn * 0.4 + pw * 0.6;

      const billow = w6(nx, ny, 0.66) * 0.5 + w12(nx, ny, 0.66) * 0.35 + w24(nx, ny, 0.66) * 0.15;
      // WEATHER: one wrap across the whole sky, so some regions are busy and others open.
      // Without it every part of the sky is equally cloudy and the deck reads as a texture.
      const weather = perlinFbm(perlin, nx, ny, 0.77, 1, 3);

      out[i++] = pw * 255;
      out[i++] = top * 255;
      out[i++] = billow * 255;
      out[i++] = weather * 255;
    }
  }
  for (let c = 0; c < 4; c++) normalizeChannel(out, 4, c);
  return out;
}

/**
 * @param {object}  [opts]
 * @param {number}  [opts.seed]
 * @param {object}  [opts.params] merged onto PAINTED_CLOUD_DEFAULTS
 */
export function createPaintedClouds({ seed = 4177, params = {}, camera = null } = {}) {
  /*
   * THE CALLER'S OBJECT IS KEPT, not copied — filled in with any defaults it is
   * missing. Identity matters because the deck is destroyed and rebuilt whenever the
   * quality tier changes, and a dev-panel slider bound to a copy would go dead the
   * first time you switched tiers and back (the same trap the road material's captured
   * uniform bag fell into). Hand in an object and it stays the live one.
   */
  const P = params;
  for (const k of Object.keys(PAINTED_CLOUD_DEFAULTS)) {
    if (P[k] === undefined) P[k] = PAINTED_CLOUD_DEFAULTS[k];
  }

  const map = new THREE.DataTexture(
    bakePaintedCloudMap(seed), PAINTED_MAP_SIZE, PAINTED_MAP_SIZE, THREE.RGBAFormat,
  );
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  // MIPMAPS ARE THE HORIZON ANTI-ALIASING. The slab crossing runs to tens of kilometres
  // at grazing angles, so texel density there goes to infinity; without mips that band
  // is a shimmering moiré that no amount of fading hides.
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  const mapTex = texture(map);

  const uAltitude = uniform(P.altitude);
  const uThickness = uniform(P.thickness);
  const uTile = uniform(P.tile);
  const uCoverage = uniform(P.coverage);
  const uErode = uniform(P.erode);
  const uDensityMul = uniform(P.densityMul);
  const uTopMin = uniform(P.topMin);
  const uSteps = uniform(P.steps);
  const uAbsorb = uniform(P.absorb);
  const uShadowReach = uniform(P.shadowReach);
  const uBaseDark = uniform(P.baseDark);
  const uSunStrength = uniform(P.sunStrength);
  const uAmbient = uniform(P.ambient);
  const uSilver = uniform(P.silver);
  const uAerial = uniform(P.aerial);
  const uHorizonFade = uniform(P.horizonFade);
  const uWind = uniform(new THREE.Vector2());
  /** Camera XZ in map units, so the deck is anchored to the WORLD and drifts past you
   *  as you drive instead of being glued to the camera. */
  const uCamXZ = uniform(new THREE.Vector2());

  /**
   * remap(v, lo..1 → 0..1) with a GUARDED denominator.
   *
   * Not TSL's `remapClamp`: the coverage step is `remap(field, 1 - coverage, 1)`, so the
   * divisor IS the coverage and in clear sky it is zero. 0/0 is NaN, NaN survives the
   * clamp, and the sky goes black wherever there is no cloud. The volumetric deck lost a
   * day to exactly this.
   */
  const remapUnit = Fn(([v, lo]) => saturate(v.sub(lo).div(float(1.0).sub(lo).max(1e-4))));

  /**
   * Shade the deck for one view ray.
   *
   * @param dir      normalised view direction
   * @param bgCol    sky colour already computed BEHIND the deck (for the aerial fade)
   * @param sunDir   normalised sun direction
   * @param keyCol   light colour (sun, or moon at night — the caller decides)
   * @param ambCol   sky ambient colour reaching the shaded side
   * @returns vec4(rgb, alpha) — straight alpha, to be mix()'d over the sky
   */
  const shade = Fn(([dir, bgCol, sunDir, keyCol, ambCol]) => {
    const out = vec4(0.0).toVar();

    const y = dir.y;
    // Rays at or below the horizon never reach a deck that is above the camera, and the
    // slab crossing diverges there. Fade rather than cut: the last degrees are
    // unresolvable however many mips we have.
    const hMask = smoothstep(uHorizonFade, uHorizonFade.add(0.10), y);

    If(hMask.greaterThan(0.001), () => {
      const yy = max(y, uHorizonFade.mul(0.5));
      const tBase = uAltitude.div(yy);
      const tTop = uAltitude.add(uThickness).div(yy);
      const dt = tTop.sub(tBase).div(uSteps.max(1.0)).toVar();

      // ── One horizontal shadow, at the slab mid-plane ────────────────────────────
      // Mass-to-mass shadowing. Two taps toward the sun, stretched by 1/sin(elevation)
      // because a low sun throws long shadows — CLAMPED to a quarter wrap, or at dusk
      // the taps land more than a full texture wrap away, sample effectively at random,
      // and every cloud in the sky shades identically (that bug shipped once already).
      const tMid = uAltitude.add(uThickness.mul(0.5)).div(yy);
      const uvMid = uCamXZ.add(vec2(dir.x, dir.z).mul(tMid).div(uTile)).add(uWind);
      const sunXZ = normalize(vec3(sunDir.x, 1e-5, sunDir.z)).xz;
      const reach = min(uShadowReach.div(max(sunDir.y, 0.15)).div(uTile), float(0.25));
      const sTau = mapTex.sample(uvMid.add(sunXZ.mul(reach.mul(0.45)))).r.mul(0.55)
        .add(mapTex.sample(uvMid.add(sunXZ.mul(reach))).r.mul(0.45));
      const sunShadow = exp(sTau.mul(uAbsorb).negate()).toVar();

      // Silver lining: thin cloud between you and the sun blazes. Gated on geometry —
      // applied unconditionally it just greys the deck (the volumetric powder term paid
      // for that lesson).
      const mu = saturate(dot(dir, sunDir));
      const rim = pow(mu, float(8.0)).mul(uSilver);

      // Dither the entry by up to one step, or the slab bands into shells — the same
      // failure the volumetric march has, and the same fix.
      const jit = interleavedGradientNoise(screenCoordinate.xy);
      const t = tBase.add(dt.mul(jit)).toVar();
      const transmittance = float(1.0).toVar();
      const scattered = vec3(0.0).toVar();

      Loop(MAX_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(uSteps), () => Break());
        If(transmittance.lessThan(0.01), () => Break());

        const h = y.mul(t).sub(uAltitude).div(uThickness); // 0 at base, 1 at top
        const uv = uCamXZ.add(vec2(dir.x, dir.z).mul(t).div(uTile)).add(uWind);
        const m = mapTex.sample(uv);

        // Per-cell top: local height runs 0..1 inside THIS cell's own cloud, so a
        // neighbour can be shallow while this one towers. Without it every cell spans
        // the same band and the deck can only read as a sheet.
        const top = mix(uTopMin, float(1.0), m.g);
        const hL = h.div(top.max(0.05));
        // Rounded profile: flat-ish base, domed top.
        // A CUMULUS BASE IS SHARP AND FLAT — it is the condensation level, a
        // thermodynamic boundary, not a fade. Ramping it over 22% of the cloud's height
        // (as this did) rounds every mass into a lozenge and is a large part of why the
        // deck read as fog. The top stays domed, which is the shape convection gives it.
        const prof = smoothstep(0.0, 0.06, hL).mul(smoothstep(1.0, 0.55, hL));

        // Weather makes whole regions cloudier — this is what stops the sky reading as
        // one uniform texture repeated to the horizon.
        const covLocal = saturate(uCoverage.mul(mix(float(0.55), float(1.45), m.a)));
        const shaped = remapUnit(m.r.mul(prof), covLocal.oneMinus()).toVar();

        If(shaped.greaterThan(0.002), () => {
          // BILLOW EROSION, and the lookup SHIFTS WITH HEIGHT. Sampling it at the same
          // uv for every step would carve the identical bite at every altitude, i.e. the
          // mass would be its own outline extruded — the exact tell v1 had. Offsetting
          // by height makes the erosion twist as it rises, which is what reads as a
          // three-dimensional billow.
          // TWO OCTAVES, because one is a lumpy edge and two is cauliflower. The finer
          // one carries most of the crispness the eye reads as "cloud" rather than
          // "smoke"; both shift with height so the mass is not its own outline extruded.
          const dUv = uv.mul(3.1).add(vec2(h.mul(0.35), h.mul(-0.27)));
          const fUv = uv.mul(9.7).add(vec2(h.mul(-0.8), h.mul(0.6)));
          const billow = mapTex.sample(dUv).b.mul(0.62).add(mapTex.sample(fUv).b.mul(0.38));
          const bite = billow.mul(uErode).mul(mix(float(0.6), float(1.25), saturate(hL)));
          const dens = remapUnit(shaped, bite).mul(uDensityMul).toVar();

          If(dens.greaterThan(1e-5), () => {
            // Vertical light gradient: tops catch the sun, bases sit in their own shadow.
            // Cheap, and with the silhouette now correct it does most of the volume read.
            const vert = mix(uBaseDark, float(1.0), saturate(hL));
            const lit = keyCol.mul(uSunStrength).mul(sunShadow.mul(vert).add(rim.mul(vert)));
            const amb = ambCol.mul(uAmbient).mul(mix(float(0.55), float(1.0), saturate(hL)));
            const lum = lit.add(amb);

            const stepT = exp(dens.mul(dt).negate());
            scattered.addAssign(transmittance.mul(lum).mul(stepT.oneMinus()));
            transmittance.mulAssign(stepT);
          });
        });
        t.addAssign(dt);
      });

      const alpha = transmittance.oneMinus().mul(hMask).toVar();
      // Premultiplied during integration, so divide back out to straight alpha for the
      // caller's mix(). Guarded, or a fully clear pixel divides by zero.
      const col = scattered.div(alpha.max(1e-4)).toVar();

      // Aerial perspective: distant deck recedes into the sky BEHIND it, so it dissolves
      // toward the horizon instead of holding full contrast to the edge.
      const aerial = smoothstep(float(0.42), float(0.02), y).mul(uAerial);
      col.assign(mix(col, bgCol, aerial));

      out.assign(vec4(col, alpha));
    });
    return out;
  });

  // ── GROUND SHADOWS ────────────────────────────────────────────────────────────
  //
  // The deck darkening the world beneath it, which is most of what makes clouds feel
  // PRESENT while driving rather than painted on a backdrop.
  //
  // The volumetric tier gets this from its own composite pass. The painted deck has no
  // pass at all — it lives inside the sky dome's fragment shader — so it borrows the
  // engine's custom-cloud hook instead: `worldEnvironment` hands any registered cloud
  // system the scene depth and lets it draw once after the solids pass. We use that slot
  // for a single fullscreen quad that MULTIPLIES the frame by the shadow and nothing
  // else; the clouds themselves are already in the sky.
  //
  // It is cheaper here than in the volumetric tier: the shadow caster is one 2D texture
  // fetch, not a density march.
  const uShadowStrength = uniform(P.shadowStrength);
  const uShadowSoft = uniform(P.shadowSoftness);
  const uShadowFar = uniform(P.shadowFar);
  const uSunDirG = uniform(new THREE.Vector3(0.4, 0.8, 0.3).normalize());
  const uInvViewProj = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  const uCamFwd = uniform(new THREE.Vector3(0, 0, -1));
  const uCamNear = uniform(0.5);
  const uCamFar = uniform(8192);
  /** 1 for a reversed depth buffer. Every depth compare has to agree with it. */
  const uReversed = uniform(0);

  // Placeholder until setDepthSource binds the pipeline's real depth — only ever
  // swapped by `.value`, so its size is irrelevant.
  const _depthPlaceholder = new THREE.DepthTexture(1, 1);
  const depthTex = texture(_depthPlaceholder);

  const normDepth = Fn(([d]) => mix(d, d.oneMinus(), uReversed));
  /** Depth to view-space distance. Denominator floored: at the far plane it is zero. */
  const depthDist = Fn(([d]) => {
    const z = normDepth(d);
    return uCamNear.mul(uCamFar)
      .div(uCamFar.sub(uCamNear).mul(z).sub(uCamFar).min(-1e-6))
      .negate();
  });

  const shadowColor = Fn(() => {
    // Render-target sampling is Y-flipped versus the canvas under WebGPU.
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const sh = float(1.0).toVar();

    const d = depthTex.sample(fuv).r;
    const skyDepth = uReversed.oneMinus();
    // Sky pixels hold the cleared far-plane depth. Gate on real geometry, or the shadow
    // would darken the very sky that casts it — and the sky dome writes no depth, so
    // this test is exactly "is there something solid here".
    If(abs(d.sub(skyDepth)).greaterThan(0.0001), () => {
      const ndc = vec4(fuv.x.mul(2.0).sub(1.0), fuv.y.mul(2.0).sub(1.0), 0.5, 1.0);
      const wpH = uInvViewProj.mul(ndc);
      const dirW = normalize(wpH.xyz.div(wpH.w).sub(uCamPos));
      const dist = depthDist(d).div(dot(dirW, uCamFwd).max(1e-3));
      const wp = uCamPos.add(dirW.mul(dist));

      // Walk up the sun ray to the deck. SAME altitude convention as the sky march
      // (relative to the camera) or the shadows drift away from the clouds casting
      // them. Slightly below mid-slab: the denser lower half throws the shadow.
      const deckY = uCamPos.y.add(uAltitude).add(uThickness.mul(0.35));
      const tS = deckY.sub(wp.y).div(max(uSunDirG.y, 0.08));
      const sxz = vec2(wp.x, wp.z).add(vec2(uSunDirG.x, uSunDirG.z).mul(tS));
      const uvS = sxz.div(uTile).add(uWind);

      // ONE fetch. The mass silhouette is what casts a shadow; billow detail is finer
      // than a soft shadow edge would preserve anyway.
      const m = mapTex.sample(uvS);
      const covLocal = saturate(uCoverage.mul(mix(float(0.55), float(1.45), m.a)));
      const cov = smoothstep(float(0.0), uShadowSoft, remapUnit(m.r, covLocal.oneMinus()));

      // Above the deck you cannot be shadowed by it — matters on a sky track.
      const below = saturate(deckY.sub(wp.y).div(uThickness.max(1.0)));
      const nearM = smoothstep(uShadowFar, uShadowFar.mul(0.55), dist);
      // Die with the sun, like the volumetric deck's shadows: no noon-strength dapples
      // stamped on the ground at dusk.
      const sunUp = smoothstep(float(0.02), float(0.16), uSunDirG.y);
      sh.assign(float(1.0).sub(cov.mul(uShadowStrength).mul(below).mul(nearM).mul(sunUp)));
    });
    return vec4(sh, sh, sh, 1.0);
  });

  const shadowMat = new THREE.MeshBasicNodeMaterial();
  shadowMat.colorNode = shadowColor();
  shadowMat.depthTest = false;
  shadowMat.depthWrite = false;
  shadowMat.fog = false;
  shadowMat.toneMapped = false;
  shadowMat.transparent = true;
  // MULTIPLY: dst = src*0 + dst*src.rgb. Alpha is left alone.
  shadowMat.blending = THREE.CustomBlending;
  shadowMat.blendSrc = THREE.ZeroFactor;
  shadowMat.blendDst = THREE.SrcColorFactor;
  shadowMat.blendSrcAlpha = THREE.ZeroFactor;
  shadowMat.blendDstAlpha = THREE.OneFactor;

  const shadowScene = new THREE.Scene();
  const shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const shadowQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), shadowMat);
  shadowScene.add(shadowQuad);

  let _depthBound = false;
  const _vp = new THREE.Matrix4();
  const _fwd = new THREE.Vector3();

  const shadowsOn = () => P.shadowStrength > 0.001;

  /** Bind the pipeline's scene depth. Null = the owns-the-frame path, which we sit out. */
  function setDepthSource(tex) {
    _depthBound = !!tex;
    if (tex) depthTex.value = tex;
  }

  function prepareFrame() { return shadowsOn() && _depthBound; }

  /**
   * The one fullscreen pass, run by PostFxPipeline right after the solids pass.
   * Multiplies the linear HDR buffer by the cloud shadow; adds no colour of its own.
   */
  function compositeOntoLinearHDR(renderer, targetRT) {
    if (!shadowsOn() || !_depthBound || !camera) return;
    uShadowStrength.value = P.shadowStrength;
    uShadowSoft.value = P.shadowSoftness;
    uShadowFar.value = P.shadowFar;
    uCamNear.value = camera.near;
    uCamFar.value = camera.far;
    uReversed.value = camera.reversedDepth ? 1 : 0;
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uInvViewProj.value.copy(_vp).invert();
    uCamPos.value.copy(camera.position);
    camera.getWorldDirection(_fwd);
    uCamFwd.value.copy(_fwd);

    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(targetRT);
    renderer.render(shadowScene, shadowCam);
    renderer.autoClear = prevAuto;
  }

  /**
   * The no-post-FX path. Returning false hands the frame back to the normal renderer:
   * without the pipeline there is no scene depth to read and no HDR target to multiply,
   * so the painted deck simply goes without ground shadows there rather than
   * manufacturing a depth buffer of its own — which is the expense this tier exists to
   * avoid. The clouds themselves are unaffected; they live in the sky shader.
   */
  function renderFrame() { return false; }

  const _windAccum = new THREE.Vector2();

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3} [camPos] world camera position — anchors the deck
   */
  function update(dt, camPos, sunDir) {
    const rad = THREE.MathUtils.degToRad(P.windDeg);
    // Metres, converted to map units on read, so the wind dial means the same thing here
    // as it does on the volumetric deck.
    _windAccum.x += Math.cos(rad) * P.windSpeed * dt;
    _windAccum.y += Math.sin(rad) * P.windSpeed * dt;
    uWind.value.set(_windAccum.x / P.tile, _windAccum.y / P.tile);
    if (camPos) uCamXZ.value.set(camPos.x / P.tile, camPos.z / P.tile);
    if (sunDir) uSunDirG.value.copy(sunDir).normalize();

    uAltitude.value = P.altitude;
    uThickness.value = P.thickness;
    uTile.value = P.tile;
    uCoverage.value = P.coverage;
    uErode.value = P.erode;
    uDensityMul.value = P.densityMul;
    uTopMin.value = P.topMin;
    uSteps.value = Math.min(P.steps, MAX_STEPS);
    uAbsorb.value = P.absorb;
    uShadowReach.value = P.shadowReach;
    uBaseDark.value = P.baseDark;
    uSunStrength.value = P.sunStrength;
    uAmbient.value = P.ambient;
    uSilver.value = P.silver;
    uAerial.value = P.aerial;
    uHorizonFade.value = P.horizonFade;
  }

  return {
    params: P,
    map,
    shade,
    update,
    // Custom-cloud contract (see worldEnvironment.setCustomCloudSystem). Registered only
    // while the painted tier is live, and only to cast ground shadows — the deck itself
    // is drawn by the sky dome, not here.
    get enabled() { return shadowsOn(); },
    setDepthSource,
    prepareFrame,
    compositeOntoLinearHDR,
    renderFrame,
    dispose() {
      map.dispose();
      shadowMat.dispose();
      shadowQuad.geometry.dispose();
      _depthPlaceholder.dispose?.();
    },
  };
}
