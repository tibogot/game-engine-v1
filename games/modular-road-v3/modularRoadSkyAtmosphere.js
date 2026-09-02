/**
 * Physical atmosphere for the modular-road sky — Hillaire 2020, lab-owned.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, given `modularRoadSky.js` already produces a sky.
 *
 * That one is five authored colour looks (night / dawn / dusk / golden / day) blended by
 * solar elevation and camera altitude. It is cheap and fully art-directable, and it will
 * never look physical, because it is not modelling anything: it cannot redden the sun
 * through real optical depth, cannot fill twilight from multiple scattering, and cannot
 * know what the sky looks like from 900 m instead of from the ground. Every one of those
 * is free here.
 *
 * NOTHING IS IMPORTED FROM v3. `v3/render/sky/dayNightSky.js` is an existing Hillaire
 * implementation and was read as a reference for the parameterisation, but this file is
 * standalone so the lab owns its own sky end to end.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE THREE LUTS, AND WHY THE BAKE ORDER IS NOT OPTIONAL.
 *
 *   1. TRANSMITTANCE  T(h, cosSunZenith) — how much light survives from a point at
 *      altitude h to the top of the atmosphere. Depends only on the medium, so it is
 *      baked ONCE and never again unless the atmosphere parameters change.
 *   2. MULTI-SCATTER  Ψms(h, cosSunZenith) — everything scattered two or more times,
 *      with the infinite bounce series closed in one term. NEEDS the transmittance LUT,
 *      so it bakes second. This is what makes twilight glow and keeps midday zenith a
 *      deep blue instead of washing it toward white the way an ad-hoc ambient fill does.
 *   3. SKY-VIEW       L(view direction) — the finished radiance for the current sun, in
 *      an equirect LUT. NEEDS both of the above. Re-baked only when the sun moves.
 *
 * The point of 3 is cost: without it, every sky pixel would march the atmosphere (32
 * samples, each with a transmittance fetch). With it, a sky pixel is ONE texture fetch,
 * and the march happens once into a 192x108 target.
 *
 * The elevation axis of the sky-view LUT is sqrt-warped around the horizon, because that
 * is where all the interesting gradient is — a linear axis spends most of its resolution
 * on empty zenith and bands the sunset.
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, If, Loop, uniform, uv, texture,
  normalize, dot, max, min, mix, clamp, exp, sqrt, pow, abs, sign, acos, atan, cos, sin,
  saturate, smoothstep, screenCoordinate, interleavedGradientNoise,
} from "three/tsl";

/** Metres. Earth-like: 6360 km ground, 100 km of atmosphere. */
export const RG = 6360000.0;
export const RT = 6460000.0;

const PI = Math.PI;

export const ATMOSPHERE_DEFAULTS = {
  /** Rayleigh scattering at sea level, per metre, RGB. Blue scatters ~9x more than red —
   *  this ratio IS why the sky is blue and the low sun is red. */
  rayleigh: [5.802e-6, 13.558e-6, 33.1e-6],
  /** Rayleigh density scale height, metres. */
  rayleighH: 8000,
  /** Mie (aerosol) scattering, per metre. Grey — haze has no colour of its own. */
  mie: 3.996e-6,
  /** Mie absorption. Aerosols absorb as well as scatter; without this, haze glows. */
  mieAbsorption: 4.4e-6,
  /** Mie density scale height, metres. Aerosols hug the ground. */
  mieH: 1200,
  /** Mie phase asymmetry. 0.8 = strongly forward — the bright halo round the sun. */
  mieG: 0.8,
  /** Ozone absorption, per metre, RGB. Small, but it is what keeps twilight BLUE
   *  instead of muddy brown once Rayleigh has stopped reaching the viewer. */
  ozone: [0.650e-6, 1.881e-6, 0.085e-6],
  /** Ozone layer centre and half-width, metres (a tent function). */
  ozoneCentre: 25000,
  ozoneWidth: 15000,

  /** Multiplier on Rayleigh — the "how blue" dial. */
  rayleighScale: 1.0,
  /** Multiplier on Mie — the haze/turbidity dial. Weather drives this. */
  mieScale: 1.0,
  /** Multiplier on ozone. */
  ozoneScale: 1.0,

  /** Sun angular radius, degrees. The real sun is 0.27. */
  sunAngularRadius: 0.27,
  /** Sun radiance multiplier. */
  sunIntensity: 20.0,
  /** Ground albedo — feeds the multi-scatter LUT, so a bright ground lifts the whole sky. */
  groundAlbedo: 0.1,
  /** Extra gain on the sun disc only. The disc is orders of magnitude brighter than the
   *  sky around it, so it wants its own dial rather than riding sunIntensity alone. */
  sunDiscBrightness: 60.0,

  /** Moon irradiance as a fraction of the sun's. The real ratio is ~1/400000, which is far
   *  too dark once tone-mapped; this is the "cinematic night" dial, not a physical one. */
  moonIntensity: 0.0016,
  /** Moonlight colour — cool, because moonlight is sunlight off a grey rock and the eye
   *  reads dim scenes as blue (Purkinje). */
  moonColor: [0.62, 0.72, 1.0],
  /** Airglow: the faint light a MOONLESS night sky still has. Without it a new moon gives a
   *  pure black void, which reads as "the renderer broke" rather than as night. */
  airglow: [0.00035, 0.00060, 0.00110],
  /** Sub-LSB dither amplitude, linear. Roughly 1/255 in display terms — enough to break
   *  8-bit and LUT banding, small enough to be invisible as noise. */
  dither: 0.0025,
  /** Multiplier on aerial-perspective strength. 1 = physically as computed. Games almost
   *  always want MORE than physical at short range, because a 2 km world has to read as a
   *  landscape; this is that exaggeration dial. */
  aerialScale: 1.0,
};

/**
 * Sun transmittance on the CPU — the same integral the transmittance LUT bakes, for the
 * one ray other systems keep needing: "what colour is direct sunlight at altitude h right
 * now". The cloud deck uses it as its light colour, which is what makes cloud lighting
 * track the day for free: warm white at noon, gold at 10°, ember red at 2°, black once
 * the sun is truly down — with no authored ramp to disagree with the sky.
 *
 * Deliberately NOT a readback of the GPU LUT: one 40-step integral on a colour that
 * changes only when the clock does is nanoseconds, while a texture readback is an async
 * GPU sync point. Mirrors rayleighAt/mieAt/ozoneAt above — keep them in step.
 *
 * @param {number} cosZenith  sun direction dot up (sin of elevation)
 * @param {number} heightM    altitude above ground, metres
 * @param {object} [P]        atmosphere params (ATMOSPHERE_DEFAULTS shape)
 * @param {number[]} [out]    length-3 RGB transmittance, 0..1
 */
export function sunTransmittanceCPU(cosZenith, heightM, P = ATMOSPHERE_DEFAULTS, out = [0, 0, 0]) {
  const r0 = RG + Math.max(1, heightM);
  const mu = cosZenith;
  // Ray-sphere: does the sun ray from r0 hit the ground before the atmosphere top?
  const discG = r0 * r0 * (mu * mu - 1) + RG * RG;
  if (mu < 0 && discG >= 0) { out[0] = out[1] = out[2] = 0; return out; }
  const dTop = -r0 * mu + Math.sqrt(r0 * r0 * (mu * mu - 1) + RT * RT);
  const step = dTop / TRANS_STEPS;
  let tr = 0, tg = 0, tb = 0;
  for (let i = 0; i < TRANS_STEPS; i++) {
    const t = (i + 0.5) * step;
    const r = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * mu);
    const h = r - RG;
    const ray = Math.exp(-h / P.rayleighH) * P.rayleighScale;
    const mie = Math.exp(-h / P.mieH) * (P.mie + P.mieAbsorption) * P.mieScale;
    const oz = Math.max(0, 1 - Math.abs(h - P.ozoneCentre) / P.ozoneWidth) * P.ozoneScale;
    tr += (P.rayleigh[0] * ray + mie + P.ozone[0] * oz) * step;
    tg += (P.rayleigh[1] * ray + mie + P.ozone[1] * oz) * step;
    tb += (P.rayleigh[2] * ray + mie + P.ozone[2] * oz) * step;
  }
  out[0] = Math.exp(-tr);
  out[1] = Math.exp(-tg);
  out[2] = Math.exp(-tb);
  return out;
}

/** March step counts. Only ever run inside a LUT bake, never per sky pixel. */
const TRANS_STEPS = 40;
const MS_SQRT_SAMPLES = 8;   // 8x8 = 64 directions on the sphere
const MS_STEPS = 20;
const SKYVIEW_STEPS = 32;

const TLUT_W = 256, TLUT_H = 64;
const MSLUT = 32;
const SKY_W = 192, SKY_H = 108;

/**
 * @param {object} opts
 * @param {THREE.WebGPURenderer} opts.renderer
 * @param {object} [opts.params] merged onto ATMOSPHERE_DEFAULTS
 */
export function createSkyAtmosphere({ renderer, params = {} }) {
  const P = { ...ATMOSPHERE_DEFAULTS, ...params };

  // ── Uniforms ───────────────────────────────────────────────────────────────────────
  const uRayleigh = uniform(new THREE.Vector3(...P.rayleigh));
  const uRayleighH = uniform(P.rayleighH);
  const uMie = uniform(P.mie);
  const uMieAbs = uniform(P.mieAbsorption);
  const uMieH = uniform(P.mieH);
  const uMieG = uniform(P.mieG);
  const uOzone = uniform(new THREE.Vector3(...P.ozone));
  const uOzoneC = uniform(P.ozoneCentre);
  const uOzoneW = uniform(P.ozoneWidth);
  const uRayScale = uniform(P.rayleighScale);
  const uMieScale = uniform(P.mieScale);
  const uOzScale = uniform(P.ozoneScale);
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uSunIntensity = uniform(P.sunIntensity);
  const uGroundAlbedo = uniform(P.groundAlbedo);
  /** Camera altitude above sea level, metres. This is what makes the sky change when you
   *  climb — a gradient sky cannot do it at all. */
  const uViewHeight = uniform(0);
  const uSunDiscBrightness = uniform(P.sunDiscBrightness);
  const uMoonDir = uniform(new THREE.Vector3(0, 1, 0));
  const uMoonIntensity = uniform(P.moonIntensity);
  const uMoonColor = uniform(new THREE.Vector3(...P.moonColor));
  const uAirglow = uniform(new THREE.Vector3(...P.airglow));
  const uDither = uniform(P.dither);
  const uAerialScale = uniform(P.aerialScale);

  // ── Medium ─────────────────────────────────────────────────────────────────────────

  /** Scattering + extinction at a height above the ground. */
  const rayleighAt = Fn(([h]) =>
    uRayleigh.mul(uRayScale).mul(exp(h.div(uRayleighH).negate())),
  );
  const mieAt = Fn(([h]) => uMie.mul(uMieScale).mul(exp(h.div(uMieH).negate())));
  const mieAbsAt = Fn(([h]) => uMieAbs.mul(uMieScale).mul(exp(h.div(uMieH).negate())));
  /** Ozone is a tent, not an exponential — it lives in a band, not near the ground. */
  const ozoneAt = Fn(([h]) =>
    uOzone.mul(uOzScale).mul(abs(h.sub(uOzoneC)).div(uOzoneW).oneMinus().max(0.0)),
  );
  /** Total extinction (out-scatter + absorption) at height h. */
  const extinctionAt = Fn(([h]) =>
    rayleighAt(h).add(vec3(mieAt(h).add(mieAbsAt(h)))).add(ozoneAt(h)),
  );

  /**
   * Distance from a point to the atmosphere top along a ray, or to the ground if it hits.
   * `r` is distance from planet centre, `mu` is cos(angle between ray and up).
   */
  const rayTopDistance = Fn(([r, mu]) => {
    const disc = r.mul(r).mul(mu.mul(mu).sub(1.0)).add(RT * RT);
    return disc.max(0.0).sqrt().sub(r.mul(mu)).max(0.0);
  });
  const rayGroundDistance = Fn(([r, mu]) => {
    const disc = r.mul(r).mul(mu.mul(mu).sub(1.0)).add(RG * RG);
    // Negative discriminant, or looking up, means no ground hit.
    return disc.max(0.0).sqrt().negate().sub(r.mul(mu));
  });
  /** True when the ray from (r, mu) intersects the planet. */
  const hitsGround = Fn(([r, mu]) =>
    mu.lessThan(0.0).and(r.mul(r).mul(mu.mul(mu).sub(1.0)).add(RG * RG).greaterThan(0.0)),
  );

  // ── Phase functions ────────────────────────────────────────────────────────────────
  const phaseRayleigh = Fn(([c]) => c.mul(c).add(1.0).mul(3.0 / (16.0 * PI)));
  /** Cornette-Shanks: the standard Mie approximation, and what puts the bright forward
   *  halo around the sun without a full Mie evaluation. */
  const phaseMie = Fn(([c]) => {
    const g = uMieG;
    const g2 = g.mul(g);
    const num = g2.oneMinus().mul(c.mul(c).add(1.0)).mul(3.0);
    const den = g2.mul(2.0).add(2.0).mul(
      pow(g2.add(1.0).sub(g.mul(c).mul(2.0)).max(1e-4), 1.5),
    ).mul(8.0 * PI);
    return num.div(den);
  });

  // ── Render-target plumbing ─────────────────────────────────────────────────────────
  const makeRT = (w, h) => {
    const rt = new THREE.RenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    rt.texture.generateMipmaps = false;
    return rt;
  };
  const transRT = makeRT(TLUT_W, TLUT_H);
  const msRT = makeRT(MSLUT, MSLUT);
  const skyRT = makeRT(SKY_W, SKY_H);

  const transTex = texture(transRT.texture);
  const msTex = texture(msRT.texture);
  const skyTex = texture(skyRT.texture);

  /**
   * UV for a LUT bake.
   *
   * `uv()` on a fullscreen quad is Y-FLIPPED relative to the way `sample()` later reads
   * the render target back. Bake with raw `uv()` and every LUT ends up mirrored on its
   * vertical axis — which silently inverts the meaning of each one: the transmittance LUT
   * returns the horizon value for a zenith ray, and the sky-view LUT puts the sky where
   * the sampler looks for ground. The symptom is a completely black sky from LUTs that
   * read back full of perfectly good numbers.
   */
  const bakeUv = Fn(() => vec2(uv().x, uv().y.oneMinus()));

  const bakeScene = new THREE.Scene();
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  bakeScene.add(bakeQuad);

  // ── 1. Transmittance LUT ───────────────────────────────────────────────────────────
  // u = altitude fraction, v = cos(zenith). Upward hemisphere only: a downward ray that
  // reaches the ground has no transmittance to the sun anyway, and the callers gate it.

  const sampleTransmittance = Fn(([h, mu]) => {
    const u = saturate(h.div(RT - RG));
    const v = saturate(mu);
    return transTex.sample(vec2(u, v)).rgb;
  });

  const transmittanceColor = Fn(() => {
    const buv = bakeUv();
    const h = buv.x.mul(RT - RG);
    const mu = buv.y;                      // cos(zenith), 0..1
    const r = float(RG).add(h);
    const tMax = rayTopDistance(r, mu);
    const sum = vec3(0.0).toVar();
    const dt = tMax.div(TRANS_STEPS);
    Loop(TRANS_STEPS, ({ i }) => {
      const t = dt.mul(float(i).add(0.5));
      // Height of the sample: law of cosines from the planet centre.
      const rr = sqrt(t.mul(t).add(r.mul(r)).add(t.mul(r).mul(mu).mul(2.0)).max(0.0));
      sum.addAssign(extinctionAt(rr.sub(RG).max(0.0)).mul(dt));
    });
    return vec4(exp(sum.negate()), 1.0);
  });

  // ── 2. Multiple-scattering LUT ─────────────────────────────────────────────────────
  // Ψms: light that has bounced two or more times, per unit scattering coefficient.
  // Hillaire closes the infinite series analytically as L2 / (1 - f_ms), which is what
  // makes this one small texture stand in for every higher scattering order.

  const sampleMs = Fn(([h, muSun]) => {
    const u = saturate(muSun.mul(0.5).add(0.5));
    const v = saturate(h.div(RT - RG));
    return msTex.sample(vec2(u, v)).rgb;
  });

  const msColor = Fn(() => {
    const buv = bakeUv();
    const muSun = buv.x.mul(2.0).sub(1.0);
    const h = buv.y.mul(RT - RG);
    const r = float(RG).add(h);
    const sunDir = vec3(sqrt(muSun.mul(muSun).oneMinus().max(0.0)), muSun, 0.0);

    // L2: second-order scattering gathered over the sphere.
    // fms: the fraction that would scatter again, which closes the series.
    const lum = vec3(0.0).toVar();
    const fms = vec3(0.0).toVar();
    const invSamples = 1.0 / (MS_SQRT_SAMPLES * MS_SQRT_SAMPLES);

    Loop(MS_SQRT_SAMPLES, ({ i }) => {
      Loop(MS_SQRT_SAMPLES, ({ i: j }) => {   // nested Loops still yield `i`; alias it
        // Uniform-ish sphere sampling from the 2D index.
        const a = float(i).add(0.5).div(MS_SQRT_SAMPLES);
        const b = float(j).add(0.5).div(MS_SQRT_SAMPLES);
        const cosT = a.mul(2.0).sub(1.0);
        const sinT = sqrt(cosT.mul(cosT).oneMinus().max(0.0));
        const phi = b.mul(2.0 * PI);
        const dir = vec3(sinT.mul(cos(phi)), cosT, sinT.mul(sin(phi)));

        const ground = hitsGround(r, dir.y);
        const tMax = ground.select(rayGroundDistance(r, dir.y), rayTopDistance(r, dir.y));
        const dt = tMax.div(MS_STEPS);

        const throughput = vec3(1.0).toVar();
        const l2 = vec3(0.0).toVar();
        const fSum = vec3(0.0).toVar();

        Loop(MS_STEPS, ({ i: k }) => {
          const t = dt.mul(float(k).add(0.5));
          const rr = sqrt(
            t.mul(t).add(r.mul(r)).add(t.mul(r).mul(dir.y).mul(2.0)).max(0.0),
          );
          const hh = rr.sub(RG).max(0.0);
          const sR = rayleighAt(hh);
          const sM = vec3(mieAt(hh));
          const scatter = sR.add(sM);
          const ext = extinctionAt(hh);
          const stepT = exp(ext.mul(dt).negate());

          // Sun visibility at this sample, and its transmittance to space.
          const muS = dot(vec3(0.0, 1.0, 0.0), sunDir); // sun zenith at the LUT's frame
          const shadow = hitsGround(rr, muS).select(float(0.0), float(1.0));
          const sunT = sampleTransmittance(hh, muS).mul(shadow);

          // Isotropic phase (1/4pi): multiple scattering has lost all directionality.
          const inScatter = scatter.mul(1.0 / (4.0 * PI)).mul(sunT);
          l2.addAssign(throughput.mul(inScatter).mul(dt));
          // Energy that will scatter AGAIN — the closure term.
          fSum.addAssign(throughput.mul(scatter).mul(1.0 / (4.0 * PI)).mul(dt));
          throughput.mulAssign(stepT);
        });

        // Ground bounce: a bright surface lifts the whole sky, so it belongs here.
        If(ground, () => {
          const muS = sunDir.y;
          const gT = sampleTransmittance(float(0.0), muS);
          l2.addAssign(
            throughput.mul(gT).mul(uGroundAlbedo).mul(muS.max(0.0)).mul(1.0 / PI),
          );
        });

        lum.addAssign(l2.mul(invSamples));
        fms.addAssign(fSum.mul(invSamples));
      });
    });

    // Closed infinite series: L2 * 1/(1 - fms).
    const psi = lum.div(vec3(1.0).sub(fms).max(vec3(1e-3)));
    return vec4(psi, 1.0);
  });

  // ── 3. Sky-view LUT ────────────────────────────────────────────────────────────────
  // Equirect over the current sun. Elevation is sqrt-warped about the horizon so the
  // resolution goes where the gradient is; a linear axis bands the sunset badly.

  /** View direction → sky-view LUT uv. */
  const skyViewUv = Fn(([dir, r]) => {
    // Angle from zenith down to the horizon at this altitude.
    const cosHorizon = sqrt(r.mul(r).sub(RG * RG).max(0.0)).div(r);
    const horizonAngle = acos(clamp(cosHorizon, -1.0, 1.0));
    const viewAngle = acos(clamp(dir.y, -1.0, 1.0));
    // Signed offset from the horizon, sqrt-warped.
    const d = viewAngle.sub(horizonAngle);
    const half = float(PI * 0.5);
    const warped = sign(d).mul(sqrt(abs(d).div(half).max(0.0)));
    const v = saturate(warped.mul(0.5).add(0.5));

    // Azimuth relative to the sun, so the LUT stays valid as the sun rotates in yaw.
    const sunAz = atan(uSunDir.z, uSunDir.x);
    const viewAz = atan(dir.z, dir.x);
    const rel = viewAz.sub(sunAz);
    const u = saturate(rel.div(2.0 * PI).add(0.5).fract());
    return vec2(u, v);
  });

  /** Inverse of skyViewUv, for the bake. */
  const skyViewDir = Fn(([uvIn, r]) => {
    const cosHorizon = sqrt(r.mul(r).sub(RG * RG).max(0.0)).div(r);
    const horizonAngle = acos(clamp(cosHorizon, -1.0, 1.0));
    const half = float(PI * 0.5);
    const warped = uvIn.y.mul(2.0).sub(1.0);
    const d = sign(warped).mul(warped.mul(warped)).mul(half);
    const viewAngle = horizonAngle.add(d);
    const cosV = cos(viewAngle);
    const sinV = sin(viewAngle);
    const sunAz = atan(uSunDir.z, uSunDir.x);
    const az = uvIn.x.sub(0.5).mul(2.0 * PI).add(sunAz);
    return vec3(sinV.mul(cos(az)), cosV, sinV.mul(sin(az)));
  });

  const skyViewColor = Fn(() => {
    const r = float(RG).add(uViewHeight);
    const dir = skyViewDir(bakeUv(), r);
    const muSun = uSunDir.y;
    const cosTheta = dot(dir, uSunDir);

    const ground = hitsGround(r, dir.y);
    const tMax = ground.select(rayGroundDistance(r, dir.y), rayTopDistance(r, dir.y));
    const dt = tMax.div(SKYVIEW_STEPS);

    const throughput = vec3(1.0).toVar();
    const acc = vec3(0.0).toVar();
    const pR = phaseRayleigh(cosTheta);
    const pM = phaseMie(cosTheta);
    const cosThetaMoon = dot(dir, uMoonDir);

    Loop(SKYVIEW_STEPS, ({ i }) => {
      const t = dt.mul(float(i).add(0.5));
      const rr = sqrt(t.mul(t).add(r.mul(r)).add(t.mul(r).mul(dir.y).mul(2.0)).max(0.0));
      const hh = rr.sub(RG).max(0.0);
      const sR = rayleighAt(hh);
      const sM = vec3(mieAt(hh));
      const ext = extinctionAt(hh);
      const stepT = exp(ext.mul(dt).negate());

      // Sun zenith cosine AT THIS SAMPLE, not at the viewer — that difference is what
      // makes the terminator and the long red path correct rather than approximate.
      const up = dir.mul(t).add(vec3(0.0, r, 0.0)).div(rr.max(1.0));
      const muS = dot(up, uSunDir);
      const shadow = hitsGround(rr, muS).select(float(0.0), float(1.0));
      const sunT = sampleTransmittance(hh, muS).mul(shadow);

      // Single scattering, phase-weighted per species.
      const single = sR.mul(pR).add(sM.mul(pM)).mul(sunT);
      // Every higher order, from the LUT. Isotropic, so no phase term.
      const multi = sR.add(sM).mul(sampleMs(hh, muS));

      // MOONLIGHT — the same scattering maths with a second, much dimmer light. This is
      // why a moonlit night sky is BLUE rather than grey: it is sunlight off a rock,
      // Rayleigh-scattered by the same air. Doing it here rather than tinting the result
      // means the moon lights the sky from its own direction, so the sky brightens on the
      // moon's side and the terminator behaves.
      const moonT = hitsGround(rr, dot(up, uMoonDir)).select(float(0.0), float(1.0))
        .mul(sampleTransmittance(hh, dot(up, uMoonDir)).x);
      const moonPhase = phaseRayleigh(cosThetaMoon);
      const moonLit = sR.mul(moonPhase).add(sM.mul(phaseMie(cosThetaMoon)))
        .mul(moonT).mul(uMoonColor).mul(uMoonIntensity);

      acc.addAssign(throughput.mul(single.add(multi).add(moonLit)).mul(dt));
      throughput.mulAssign(stepT);
    });

    // GROUND TERM. Without it every below-horizon direction integrates only the short,
    // nearly-unscattered path down to the surface and comes out almost black — which
    // shows in game as a hard dark band under the horizon wherever the scene's own ground
    // does not reach far enough to cover the dome. Lambertian ground, lit through the
    // atmosphere and attenuated by the path we just marched, is both the physical answer
    // and the one that makes the band disappear.
    If(ground, () => {
      const hitPos = vec3(0.0, r, 0.0).add(dir.mul(tMax));
      const up = normalize(hitPos);
      const muS = dot(up, uSunDir);
      const sunT = sampleTransmittance(float(0.0), muS.max(0.0));
      const lambert = uGroundAlbedo.mul(muS.max(0.0)).mul(1.0 / PI);
      acc.addAssign(throughput.mul(sunT).mul(lambert));
    });

    // Airglow floor: brighter toward the horizon, where the line of sight passes through
    // far more of the emitting layer. Added after the sun scaling so it is an absolute
    // floor rather than something that scales away with the sun.
    const horizonBoost = float(1.0).add(saturate(dir.y.abs().oneMinus()).mul(1.6));
    return vec4(acc.mul(uSunIntensity).add(uAirglow.mul(horizonBoost)), 1.0);
  });

  // ── Materials ──────────────────────────────────────────────────────────────────────
  const mkMat = (node) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = node();
    m.depthTest = false;
    m.depthWrite = false;
    m.fog = false;
    m.toneMapped = false;
    return m;
  };
  const transMat = mkMat(transmittanceColor);
  const msMat = mkMat(msColor);
  const skyMat = mkMat(skyViewColor);

  // ── Public sampling ────────────────────────────────────────────────────────────────

  /**
   * Sky radiance for a world-space view direction. ONE texture fetch — the whole point
   * of the sky-view LUT.
   */
  const skyRadiance = Fn(([dir]) => {
    const r = float(RG).add(uViewHeight);
    const c = skyTex.sample(skyViewUv(normalize(dir), r)).rgb;

    // DITHER. A sky is the worst case for banding: an enormous, almost perfectly smooth
    // gradient, reconstructed from a 192x108 LUT and then quantised to 8 bits on the way
    // out. Both stages band, and the eye is far more sensitive to a straight contour on a
    // flat gradient than to noise of the same amplitude. Sub-LSB triangular dither breaks
    // the contours into noise below the threshold of vision. The reference WebGPU
    // implementation calls this out as required, not optional, for LUT-based skies.
    //
    // Triangular (two noise samples differenced) rather than uniform: it has no DC bias, so
    // it cannot shift the colour, only its quantisation.
    const n1 = interleavedGradientNoise(screenCoordinate.xy);
    const n2 = interleavedGradientNoise(screenCoordinate.xy.add(vec2(11.0, 7.0)));
    const tri = n1.sub(n2).mul(uDither);
    return c.add(tri);
  });

  /** Transmittance from the viewer to space toward `dir` — use it to tint the sun disc. */
  const sunDiscTransmittance = Fn(([dir]) =>
    sampleTransmittance(uViewHeight, normalize(dir).y),
  );

  /**
   * The sun disc, analytic.
   *
   * Deliberately NOT in the sky-view LUT: at 192x108 the disc is a fraction of a texel and
   * would come out as a smeared blob with a hard bilinear edge. Computed per pixel it stays
   * a crisp disc at any resolution, for a dot product and a smoothstep.
   *
   * Tinted by the transmittance along its own ray, which is what reddens and dims it near
   * the horizon — the same physics that reddens the sky, so the two always agree instead of
   * being two separately-authored colours that drift apart.
   */
  const sunDisc = Fn(([dir]) => {
    const d = normalize(dir);
    const cosT = dot(d, uSunDir);
    const cosR = float(Math.cos((P.sunAngularRadius * Math.PI) / 180));
    // Soften by roughly a tenth of the radius so the rim is not aliased.
    const edge = cosR.oneMinus().mul(0.12);
    const disc = smoothstep(cosR.sub(edge), cosR.add(edge.mul(0.25)), cosT);
    // Limb darkening: the sun is dimmer at its rim than its centre.
    const rNorm = saturate(cosT.oneMinus().div(cosR.oneMinus().max(1e-8)));
    const limb = sqrt(rNorm.mul(rNorm).oneMinus().max(0.0)).mul(0.6).add(0.4);
    // Below the horizon the disc must not shine through the planet.
    const above = smoothstep(float(-0.02), float(0.0), d.y);
    return sunDiscTransmittance(d)
      .mul(disc.mul(limb).mul(above).mul(uSunIntensity).mul(uSunDiscBrightness));
  });

  /** Sky plus sun — what a dome material normally wants. */
  const skyWithSun = Fn(([dir]) => skyRadiance(dir).add(sunDisc(dir)));

  /**
   * AERIAL PERSPECTIVE — the haze between the camera and a piece of scene geometry.
   *
   * This is the thing that makes distant ground read as distant instead of as flat paint,
   * and it is the single biggest realism win for a camera that spends its time NEAR THE
   * GROUND looking along the world.
   *
   * Deliberately ANALYTIC rather than Hillaire's froxel LUT. The froxel volume exists to
   * handle large altitude ranges and tens of kilometres, where the air density along the
   * view ray changes a lot. This world is ~2 km across and the camera is near the ground,
   * so density barely varies along any sightline — a single-altitude closed form is within
   * noise of the volume, costs no 3D texture, no extra bake, and no per-frame revalidation.
   * If the view distance ever grows to mountain scale, THAT is when the froxel LUT earns
   * its keep.
   *
   * The in-scatter colour is the SKY RADIANCE IN THE SAME DIRECTION. That is not a
   * shortcut, it is the point: haze is the sky seen through a shorter column, so taking its
   * colour from the sky LUT means the haze matches the sky automatically — warm toward a
   * setting sun, blue at noon, dim blue under moonlight — with nothing to keep in sync.
   *
   * @returns vec4( inScatteredColour.rgb, transmittance )
   */
  const aerialPerspective = Fn(([dir, dist]) => {
    const d = normalize(dir);
    const h = uViewHeight;
    // Grey extinction: colour comes from the in-scatter term, and a per-channel extinction
    // here would double-count the wavelength dependence already in the sky LUT.
    const ext = extinctionAt(h);
    const t = exp(ext.mul(dist.mul(uAerialScale)).negate());
    const inScatter = skyRadiance(d).mul(vec3(1.0).sub(t));
    // One transmittance for the geometry to be attenuated by; use the green channel as the
    // luminance-weighted representative so the surface dims neutrally.
    return vec4(inScatter, t.y);
  });

  /** Apply aerial perspective to an already-shaded scene colour. */
  const applyAerialPerspective = Fn(([sceneColor, dir, dist]) => {
    const ap = aerialPerspective(dir, dist);
    return sceneColor.mul(ap.w).add(ap.xyz);
  });

  // ── Bake orchestration ─────────────────────────────────────────────────────────────
  // Order matters: MS reads transmittance, sky-view reads both.
  let _needStatic = true;   // transmittance + multi-scatter
  let _needSky = true;      // sky-view (sun moved / altitude changed)
  let _lastSunKey = "";
  let _lastHeight = -1;

  function renderTo(rt, material) {
    const prevTarget = renderer.getRenderTarget();
    bakeQuad.material = material;
    renderer.setRenderTarget(rt);
    renderer.render(bakeScene, bakeCam);
    renderer.setRenderTarget(prevTarget);
  }

  /** Re-bake whatever is stale. Cheap when nothing changed. */
  function bake() {
    if (_needStatic) {
      renderTo(transRT, transMat);
      renderTo(msRT, msMat);
      _needStatic = false;
      _needSky = true;
    }
    if (_needSky) {
      renderTo(skyRT, skyMat);
      _needSky = false;
    }
  }

  /**
   * @param {THREE.Vector3} sunDir  normalised, world space
   * @param {number} viewHeight     camera altitude above sea level, metres
   */
  function update(sunDir, viewHeight = 0, moonDir = null) {
    uSunDir.value.copy(sunDir).normalize();
    if (moonDir) {
      // The moon moves the sky, so it belongs in the re-bake key alongside the sun.
      const md = uMoonDir.value;
      if (Math.abs(md.x - moonDir.x) + Math.abs(md.y - moonDir.y) + Math.abs(md.z - moonDir.z) > 1e-3) {
        md.copy(moonDir).normalize();
        _needSky = true;
      }
    }
    // Only re-bake the sky-view LUT when the sun or the altitude actually moved enough
    // to matter — a bake per frame would throw away the reason the LUT exists.
    const key = `${sunDir.x.toFixed(4)},${sunDir.y.toFixed(4)},${sunDir.z.toFixed(4)}`;
    if (key !== _lastSunKey) { _lastSunKey = key; _needSky = true; }
    if (Math.abs(viewHeight - _lastHeight) > 15) {
      _lastHeight = viewHeight;
      uViewHeight.value = viewHeight;
      _needSky = true;
    }
    bake();
  }

  /** Push params from the object back into uniforms and force a full re-bake. */
  function syncParams() {
    uRayleigh.value.set(...P.rayleigh);
    uRayleighH.value = P.rayleighH;
    uMie.value = P.mie;
    uMieAbs.value = P.mieAbsorption;
    uMieH.value = P.mieH;
    uMieG.value = P.mieG;
    uOzone.value.set(...P.ozone);
    uOzoneC.value = P.ozoneCentre;
    uOzoneW.value = P.ozoneWidth;
    uRayScale.value = P.rayleighScale;
    uMieScale.value = P.mieScale;
    uOzScale.value = P.ozoneScale;
    uSunIntensity.value = P.sunIntensity;
    uGroundAlbedo.value = P.groundAlbedo;
    uSunDiscBrightness.value = P.sunDiscBrightness;
    uMoonIntensity.value = P.moonIntensity;
    uMoonColor.value.set(...P.moonColor);
    uAirglow.value.set(...P.airglow);
    uDither.value = P.dither;
    uAerialScale.value = P.aerialScale;
    _needStatic = true;
  }

  function dispose() {
    transRT.dispose(); msRT.dispose(); skyRT.dispose();
    transMat.dispose(); msMat.dispose(); skyMat.dispose();
    bakeQuad.geometry.dispose();
  }

  return {
    params: P,
    skyRadiance,
    skyWithSun,
    sunDisc,
    aerialPerspective,
    applyAerialPerspective,
    sunDiscTransmittance,
    update,
    syncParams,
    bake,
    dispose,
    uniforms: { uSunDir, uMoonDir, uViewHeight, uSunIntensity, uMoonIntensity },
    _debug: { transRT, msRT, skyRT },
  };
}
