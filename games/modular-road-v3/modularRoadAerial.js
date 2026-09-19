/**
 * AERIAL PERSPECTIVE — the air between you and everything else.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT FOG, EVEN THOUGH IT LOOKS LIKE FOG.
 *
 * Distance fog blends geometry toward ONE colour. Aerial perspective blends it toward
 * THE COLOUR OF THE SKY BEHIND IT, which is a different colour in every direction — warm
 * and bright toward the sun, deep blue away from it, pale at the horizon. That
 * directional variation is the entire effect: it is what tells the eye "this is far"
 * rather than "this is in fog", and it is why a constant-colour fog always reads as
 * weather instead of as distance.
 *
 * The engine's own distance fog has a `matchSky` flag and a sun tint, which is an
 * attempt at the same thing — but it is still a single colour for the whole frame, and
 * it is switched off in this game. With it off there is currently NO attenuation at all,
 * which is why far terrain and far track read as pasted onto the sky rather than sitting
 * in air behind it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE MODEL, and why it is analytic rather than a LUT.
 *
 * Hillaire's aerial-perspective LUT is a 32³ froxel volume re-baked every frame. That is
 * the right answer for a planet-scale renderer with kilometres of visible depth. Here the
 * world is ~2 km across and the whole effect lives in the first few hundred metres, so a
 * froxel volume would be a lot of machinery to reproduce a curve that
 *
 *     scene · T + inscatter · (1 − T),   T = exp(−distance · density)
 *
 * already gives, with the inscatter coloured per-direction from the sky the player is
 * actually looking at. It also keeps this module free of any dependency on the
 * atmosphere's LUT textures, which matters: those are disposed and rebuilt whenever the
 * cloud tier changes, and a node graph holding a reference to a dead texture is exactly
 * the class of bug this project keeps paying for.
 *
 * Extinction is SCALAR while the inscatter is COLOURED. Per-channel extinction would be
 * more correct (blue survives differently), but scalar T is what lets the whole thing ride
 * the premultiplied-over blend the composite already uses — `dst·T + inscatter·(1−T)`
 * falls straight out of `src.rgb + dst·(1 − src.a)` — and the colour of distance is
 * carried by the inscatter term anyway, which is where the eye reads it.
 *
 * @see v3/render/sky/atmosphereSkyDome.js — supplies the zenith/horizon/sun colours this tints with
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec4, Fn, If, uniform, texture, uv,
  normalize, dot, min, mix, pow, exp, abs, saturate, select,
} from "three/tsl";

export const AERIAL_DEFAULTS = {
  enabled: true,
  /**
   * Extinction per metre. 0.00035 puts roughly a third of the haze in at 1 km, which is
   * about right for clear air; raise it for humid or dusty weather.
   */
  density: 0.00035,
  /** Ceiling on the effect, so nothing ever fully dissolves into the sky. */
  maxAmount: 0.88,
  /**
   * Metres of atmospheric scale height. Air thins with altitude, so a sky track at 1 km
   * should see further than a car at ground level — without this the haze would be as
   * thick at altitude as it is in the valley, which reads as soup.
   */
  scaleHeight: 2200,
  /**
   * ── THE GROUND LAYER ──────────────────────────────────────────────────────
   *
   * A SECOND, much shallower haze under the clean air — the aerosol layer a
   * real city sits in. Two components, because one cannot do this job: at a
   * scale height of 2200 m a 400 m tower still sees 95% of the density its own
   * doorstep does, so the whole city hazes by the same amount and reads as one
   * even wash at distance. Nothing separates near from far but perspective.
   *
   * At 160 m the layer is thick in the streets, half gone by the second
   * setback and effectively absent above the towers — which is the picture
   * everyone recognises from the air: roofs and masts standing clear out of
   * murk, with the streets below them lost in it. It is also what gives a
   * skyline DEPTH, because each rank of buildings sinks a little further into
   * it than the one in front.
   *
   * Set `groundHaze` to 0 for the old single-component air.
   */
  groundHaze: 0.00055,
  groundHazeHeight: 160,
  /**
   * ── THE GROUND LAYER THINS AS THE SUN GOES DOWN ───────────────────────────
   *
   * Fraction of `groundHaze` left with the sun on the horizon. 1 disables the
   * curve entirely and restores the old behaviour exactly.
   *
   * WHY. The ground layer is doing its job at noon and you cannot see it,
   * because the light it scatters is white. At dusk the in-scatter target is
   * the horizon colour, which is the most saturated thing in the sky — so the
   * same layer that gave the skyline depth at midday paints every surface
   * within a couple of hundred metres sepia, and the city reads as a filter
   * rather than as evening.
   *
   * MEASURED in the game at 17:15, street level, one term at a time:
   *   groundHaze 0.00055  the whole street brown; colour gone out of the
   *                       traffic, the trees and the crossing
   *   groundHaze 0        neutral, and the SKYLINE LOSES ITS DEPTH
   *   groundHaze 0.00020  near and mid field clean and coloured, far end of
   *                       the street still sinking into warm haze — the depth
   *                       cue kept, the wash gone
   * 0.36 is that 0.00020 as a fraction, which is where this number comes from.
   *
   * The env map was the other suspect and was ruled out by the same method:
   * killing it (0.354 → 0.02) turned the SHADOWS blue and left the buildings
   * exactly as brown, because the cast is distance-dependent and the env is
   * not. Noon is untouched — `duskFadeDeg` is where the curve starts, and
   * above it this is 1.
   */
  duskGroundHaze: 0.36,
  /**
   * The window, in degrees of sun elevation: no change at or above
   * `duskFadeDeg`, fully thinned at or below `duskFullDeg`.
   *
   * A WINDOW AND NOT A SINGLE NUMBER, because the first version ramped from
   * one threshold down to the horizon and was measured doing nothing at the
   * hour it was built for: 17:15 — the shot this was tuned on — is +24.6°, not
   * the 2° that "dusk" suggests, so a fade starting at 25° was still 0.999 of
   * the way to noon there. The wash is already the dominant problem in the
   * twenties and the sun does not reach the horizon until well past the hour
   * anybody wants to drive. So: gone by 20°, absent by 50°, and the stunt
   * track's own +61.7° sits clear above the window with room to spare.
   */
  duskFadeDeg: 50,
  duskFullDeg: 20,
  /** Strength of the forward-scatter lobe: haze looking INTO the sun goes bright and warm. */
  sunGlow: 1.35,
  /** Tightness of that lobe. Higher = a smaller, hotter halo around the sun. */
  sunGlowPow: 7.0,
  /** Metres beyond which the effect is capped (the sky takes over anyway). */
  maxDist: 20000,
};

/**
 * @param {object} opts
 * @param {THREE.Camera} opts.camera
 * @param {object} [opts.params] merged onto AERIAL_DEFAULTS
 */
export function createAerialPerspective({ camera, params = {} } = {}) {
  const P = params;
  for (const k of Object.keys(AERIAL_DEFAULTS)) {
    if (P[k] === undefined) P[k] = AERIAL_DEFAULTS[k];
  }

  const uDensity = uniform(P.density);
  const uMaxAmount = uniform(P.maxAmount);
  const uInvScaleH = uniform(1 / P.scaleHeight);
  const uGroundHaze = uniform(P.groundHaze);
  const uInvGroundH = uniform(1 / P.groundHazeHeight);
  const uSunGlow = uniform(P.sunGlow);
  const uSunGlowPow = uniform(P.sunGlowPow);
  const uMaxDist = uniform(P.maxDist);

  const uSunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.3).normalize());
  const uZenith = uniform(new THREE.Color(0x3f78c8));
  const uHorizon = uniform(new THREE.Color(0xc9dcef));
  /** The sun's own transmitted colour — the same one lighting the world and the clouds. */
  const uSunTint = uniform(new THREE.Color(0xfff2dc));

  const uInvViewProj = uniform(new THREE.Matrix4());
  const uCamPos = uniform(new THREE.Vector3());
  const uCamFwd = uniform(new THREE.Vector3(0, 0, -1));
  const uCamNear = uniform(0.5);
  const uCamFar = uniform(8192);
  /** 1 for a reversed depth buffer; every depth compare has to agree with it. */
  const uReversed = uniform(0);

  // Swapped by setDepthSource; size is irrelevant because only `.value` is ever replaced.
  const _depthPlaceholder = new THREE.DepthTexture(1, 1);
  const depthTex = texture(_depthPlaceholder);

  // Mirrors the same two helpers in paintedCloudDeck — deliberately duplicated
  // rather than shared, so this module has no dependency on the cloud tier that happens
  // to be running (it must work in all three).
  const normDepth = Fn(([d]) => mix(d, d.oneMinus(), uReversed));
  const depthDist = Fn(([d]) => {
    const z = normDepth(d);
    return uCamNear.mul(uCamFar)
      .div(uCamFar.sub(uCamNear).mul(z).sub(uCamFar).min(-1e-6))
      .negate();
  });

  /**
   * The haze for a ray `dirW` that travels `dist` metres before hitting something,
   * premultiplied: vec4(inscatter · amount, amount). The ONE definition of the
   * effect — the fullscreen composite below uses it, and so does `hazeBehind`, which
   * transparent effects use to cancel the composite over their own pixels.
   */
  const hazeFor = Fn(([dirW, distIn]) => {
      const dist = min(distIn, uMaxDist);

      // Air thins with altitude: use the midpoint of the segment, which is the cheapest
      // stand-in for integrating density along it and is exact enough over a few hundred
      // metres of relief.
      const midY = uCamPos.y.add(dirW.y.mul(dist).mul(0.5)).max(0.0);
      const rho = exp(midY.mul(uInvScaleH).negate());
      // The shallow layer, same midpoint stand-in. It is a cruder approximation
      // here than for the clean air — a 160 m scale height varies a lot over a
      // ray that climbs 300 m — but this is a look, not a radiometric budget,
      // and the error is a smooth one that reads as the layer being slightly
      // soft-edged, which it is.
      const rhoG = exp(midY.mul(uInvGroundH).negate());

      const sigma = uDensity.mul(rho).add(uGroundHaze.mul(rhoG));
      const amount = exp(dist.mul(sigma).negate()).oneMinus().mul(uMaxAmount);

      // ── THE COLOUR OF THE DISTANCE ────────────────────────────────────────────
      // The sky in THIS direction, not one fog colour: pale at the horizon, deeper
      // overhead, plus a forward-scatter lobe so haze between you and the sun blazes.
      // That lobe is why a low sun turns distant ground into a wash of gold instead of
      // the same grey it has at noon.
      const up = saturate(dirW.y);
      const base = mix(uHorizon, uZenith, pow(up, float(0.55)));
      const mu = saturate(dot(dirW, uSunDir));

      /*
       * THE LOBE HAS TO DIE WITH THE SUN, and until this gate existed it did not.
       *
       * `mu` is a dot against the sun's direction and nothing more, so it does
       * not care whether the sun is actually up. At 22:30 the sun sits ~19°
       * BELOW the horizon, and looking down at the terrain along its azimuth
       * still gives a strongly positive dot — so the lobe fired at full power
       * and painted a large pale wash across the ground. `uSunTint` made it
       * worse: it is a CHROMATICITY, normalised so its brightest channel is 1,
       * so it carries hue and never dimness and is exactly as bright at midnight
       * as at noon.
       *
       * The result was a sun-glare pool on the night terrain, sitting opposite
       * the moon — because a full moon is opposite the sun — and leaving the
       * GROUND brighter than the SKY, which is backwards.
       *
       * The window is civil twilight, the same one the sky dome's key light
       * already blends moonlight over: full at the horizon, gone by 6° under it.
       * Cutting it AT the horizon instead would throw away the best thing this
       * lobe does — the low sun that turns distant ground to gold.
       */
      const dusk = saturate(uSunDir.y.mul(1 / 0.1045).add(1));
      const glow = pow(mu, uSunGlowPow).mul(uSunGlow).mul(dusk);
      const inscatter = base.add(uSunTint.mul(glow));

      // Premultiplied: dst = src.rgb + dst*(1 - src.a) == dst*T + inscatter*(1 - T).
      return vec4(inscatter.mul(amount), amount);
  });

  const aerialColor = Fn(() => {
    // Render-target sampling is Y-flipped versus the canvas under WebGPU.
    const fuv = vec2(uv().x, uv().y.oneMinus());
    const out = vec4(0.0).toVar();

    const d = depthTex.sample(fuv).r;
    const skyDepth = uReversed.oneMinus();
    // Sky pixels hold the cleared far-plane depth and ALREADY are the sky — hazing them
    // toward themselves would only wash the horizon out. The sky dome writes no depth,
    // so this test is exactly "is there something solid here".
    If(abs(d.sub(skyDepth)).greaterThan(0.0001), () => {
      const ndc = vec4(fuv.x.mul(2.0).sub(1.0), fuv.y.mul(2.0).sub(1.0), 0.5, 1.0);
      const wpH = uInvViewProj.mul(ndc);
      const dirW = normalize(wpH.xyz.div(wpH.w).sub(uCamPos));
      // depthDist is along the view AXIS; divide by cos to get distance along the RAY,
      // or the corners of the screen would be under-hazed relative to the centre.
      out.assign(hazeFor(dirW, depthDist(d).div(dot(dirW, uCamFwd).max(1e-3))));
    });
    return out;
  });

  /**
   * ── TRANSPARENT EFFECTS AND THE COMPOSITE ORDER ──────────────────────────────
   *
   * The engine draws the WHOLE scene — transparent effects included — and only then
   * runs this composite, hazing each pixel by the depth buffer. Smoke writes no depth,
   * so a puff over the tarmac was hazed as if it were as far away as the tarmac
   * behind it, and a puff over the sky (cleared depth) was not hazed at all: a hard
   * light/dark seam through the plume exactly at the horizon line.
   *
   * `hazeBehind` lets such an effect CANCEL that over its own pixels. Given the raw
   * scene depth behind the fragment, the view ray and the ray distance to that depth,
   * it returns the haze the composite is about to apply there, or zero when it will
   * not run. An effect that outputs (colour − inscatter) / T instead of colour ends
   * up, after `dst·T + inscatter`, exactly as if it had been drawn on top of the
   * hazed scene — and that holds through any number of stacked layers. Its own
   * distance is metres, so its own haze is negligible and is not added.
   *
   * `uLive` gates it on the composite having ACTUALLY run recently (see syncLive):
   * with post-FX off, or the air disabled, nothing is hazed and nothing may be
   * cancelled.
   */
  const uLive = uniform(0);
  const hazeBehind = (rd, rayDist, rawDepth) => {
    const notSky = abs(rawDepth.sub(uReversed.oneMinus())).greaterThan(0.0001);
    return hazeFor(rd, rayDist).mul(uLive).mul(select(notSky, float(1), float(0)));
  };
  let _lastComposite = -1e9;

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = aerialColor();
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.toneMapped = false;
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);

  let _depthBound = false;
  const _vp = new THREE.Matrix4();
  const _fwd = new THREE.Vector3();

  const active = () => !!P.enabled && P.density > 1e-7 && _depthBound;

  function setDepthSource(tex) {
    _depthBound = !!tex;
    if (tex) depthTex.value = tex;
  }

  /**
   * How much of the ground layer survives at the sun's current elevation.
   *
   * Exported so a harness can check the curve without a renderer, and so the
   * two facts it has to satisfy are testable rather than asserted: it is
   * EXACTLY 1 above `duskFadeDeg` (noon cannot regress through here), and it is
   * smooth — a hard knee would show as the haze stepping while the sun moves.
   *
   * Below the horizon it holds at the dusk value rather than continuing down:
   * night has its own fill, and there is no sunset colour left to over-apply.
   */
  function groundHazeScale() {
    const k = P.duskGroundHaze ?? 1;
    if (!(k < 1)) return 1;
    const hi = P.duskFadeDeg ?? 50;
    const lo = Math.min(P.duskFullDeg ?? 20, hi);
    const el = Math.asin(Math.max(-1, Math.min(1, uSunDir.value.y))) * (180 / Math.PI);
    const span = hi - lo;
    // A zero-width window is a hard switch at `hi`, not a divide by zero.
    const t = span <= 1e-6
      ? (el >= hi ? 0 : 1)
      : Math.max(0, Math.min(1, (hi - el) / span));
    const s = t * t * (3 - 2 * t);                        // smoothstep, no visible knee
    return 1 + (k - 1) * s;
  }

  /** Push the sky's current look. Cheap — call it whenever the sun or the look moves. */
  function setSky({ sunDir, zenith, horizon, sunTint } = {}) {
    if (sunDir) uSunDir.value.copy(sunDir).normalize();
    if (zenith) uZenith.value.copy(zenith);
    if (horizon) uHorizon.value.copy(horizon);
    if (sunTint) uSunTint.value.copy(sunTint);
  }

  /** One fullscreen pass, after the solids pass and before the clouds go over the top. */
  function composite(renderer, targetRT) {
    if (!active() || !camera) return;
    uDensity.value = P.density;
    uMaxAmount.value = P.maxAmount;
    uInvScaleH.value = 1 / Math.max(1, P.scaleHeight);
    uGroundHaze.value = P.groundHaze * groundHazeScale();
    uInvGroundH.value = 1 / Math.max(1, P.groundHazeHeight);
    uSunGlow.value = P.sunGlow;
    uSunGlowPow.value = P.sunGlowPow;
    uMaxDist.value = P.maxDist;
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
    renderer.render(scene, cam);
    renderer.autoClear = prevAuto;
    _lastComposite = performance.now();
  }

  /**
   * Call once per frame BEFORE rendering. Effects render ahead of the composite in the
   * same frame, so "is the air live" has to come from the previous one; a quarter
   * second of slack covers a dropped frame without leaving the cancel on after the
   * air has been switched off.
   */
  function syncLive() {
    uLive.value = active() && performance.now() - _lastComposite < 250 ? 1 : 0;
  }

  return {
    params: P,
    get enabled() { return !!P.enabled && P.density > 1e-7; },
    setDepthSource,
    setSky,
    composite,
    syncLive,
    hazeBehind,
    /** The dusk curve, for a harness and for reading it live while driving. */
    groundHazeScale,
    /** Debug: is the transparent-FX cancel live this frame, and when did the composite last run. */
    get live() { return uLive.value; },
    get lastComposite() { return _lastComposite; },
    dispose() {
      material.dispose();
      quad.geometry.dispose();
      _depthPlaceholder.dispose?.();
    },
  };
}
