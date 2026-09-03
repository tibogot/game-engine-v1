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
 * @see modularRoadSky.js — supplies the zenith/horizon/sun colours this tints with
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec4, Fn, If, uniform, texture, uv,
  normalize, dot, max, min, mix, pow, exp, abs, saturate,
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

  // Mirrors the same two helpers in modularRoadPaintedClouds — deliberately duplicated
  // rather than shared, so this module has no dependency on the cloud tier that happens
  // to be running (it must work in all three).
  const normDepth = Fn(([d]) => mix(d, d.oneMinus(), uReversed));
  const depthDist = Fn(([d]) => {
    const z = normDepth(d);
    return uCamNear.mul(uCamFar)
      .div(uCamFar.sub(uCamNear).mul(z).sub(uCamFar).min(-1e-6))
      .negate();
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
      const dist = min(depthDist(d).div(dot(dirW, uCamFwd).max(1e-3)), uMaxDist);

      // Air thins with altitude: use the midpoint of the segment, which is the cheapest
      // stand-in for integrating density along it and is exact enough over a few hundred
      // metres of relief.
      const midY = uCamPos.y.add(dirW.y.mul(dist).mul(0.5)).max(0.0);
      const rho = exp(midY.mul(uInvScaleH).negate());

      const amount = exp(dist.mul(uDensity).mul(rho).negate()).oneMinus().mul(uMaxAmount);

      // ── THE COLOUR OF THE DISTANCE ────────────────────────────────────────────
      // The sky in THIS direction, not one fog colour: pale at the horizon, deeper
      // overhead, plus a forward-scatter lobe so haze between you and the sun blazes.
      // That lobe is why a low sun turns distant ground into a wash of gold instead of
      // the same grey it has at noon.
      const up = saturate(dirW.y);
      const base = mix(uHorizon, uZenith, pow(up, float(0.55)));
      const mu = saturate(dot(dirW, uSunDir));
      const glow = pow(mu, uSunGlowPow).mul(uSunGlow);
      const inscatter = base.add(uSunTint.mul(glow));

      // Premultiplied: dst = src.rgb + dst*(1 - src.a) == dst*T + inscatter*(1 - T).
      out.assign(vec4(inscatter.mul(amount), amount));
    });
    return out;
  });

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
  }

  return {
    params: P,
    get enabled() { return !!P.enabled && P.density > 1e-7; },
    setDepthSource,
    setSky,
    composite,
    dispose() {
      material.dispose();
      quad.geometry.dispose();
      _depthPlaceholder.dispose?.();
    },
  };
}
