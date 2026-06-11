/**
 * V2 COPY of the daynight-sky lab module. Source of truth lives at repo-root
 * `daynight-sky.js`; this is a self-contained port for the v2 editor's
 * `skyMode === "procedural"`. Keep behaviour identical to the lab — port fixes
 * here when the lab module changes. Do NOT edit the lab files from v2.
 *
 * Day ↔ night sky dome — a single cheap gradient shader (no raymarch).
 *
 * Replaces SkyMesh's daytime-only Preetham model with one that has BOTH a day
 * and a night term, crossfaded by sun elevation:
 *   - horizon→zenith gradient (separate day + night palettes)
 *   - warm sunset/sunrise band near the horizon
 *   - sun disc + Mie-style glow
 *   - moon disc + soft glow (cool white)
 *   - hash-based twinkling star field that fades in as the sun sets
 *
 * Renders on a big inverted sphere that follows the camera. Costs one gradient
 * pass — as cheap as SkyMesh. The page drives it each frame via `update()`.
 *
 * Self-contained: creates its own mesh + uniforms, touches no other module.
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, If, Loop, Break, uniform,
  positionWorld, cameraPosition,
  normalize, dot, max, min, mix, smoothstep, clamp, step, sqrt,
  pow, sin, cos, floor, fract, length, abs, exp, sub, mul,
} from "three/tsl";

// V2 NOTE: the lab uses 9000, but v2's main camera has `far = 5000`. The dome
// is a plain sphere (no skybox depth-clamp trick), so a radius past the far
// plane gets clip-space culled → invisible. The dome follows the camera every
// frame (centered on it) and is purely direction-based, so radius is cosmetic;
// 4000 keeps it comfortably inside the far plane while still enclosing the scene.
const SKY_RADIUS = 4000;

export function createDayNightSky() {
  // ── Uniforms (driven from PARAMS each frame) ─────────────────────────────
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uMoonDir = uniform(new THREE.Vector3(0, -1, 0));
  const uTime = uniform(0);

  const uZenithDay = uniform(new THREE.Color(0x2a6bd8));
  const uHorizonDay = uniform(new THREE.Color(0xbfe0ff));
  const uZenithNight = uniform(new THREE.Color(0x05080f));
  const uHorizonNight = uniform(new THREE.Color(0x1a2740));
  const uSunsetColor = uniform(new THREE.Color(0xff7a33));
  const uGroundColor = uniform(new THREE.Color(0x4a4a52));

  // ── Atmospheric scattering (Nishita single-scattering) ───────────────────
  // 0 = the analytic gradient above; 1 = a physically-based Rayleigh+Mie
  // raymarch that gives the whole-sky sun glow, true horizon brightening, the
  // belt of Venus and automatic sunset gradients. Drawn additively over the
  // night gradient, so twilight carries itself as the sun drops.
  const uScatterMix = uniform(1);
  const uSunIntensity = uniform(22);   // disc-of-the-sun radiance scale
  const uRayleigh = uniform(1.0);      // βR multiplier (sky blueness)
  const uMie = uniform(1.0);           // βM multiplier (haze / sun aureole)
  const uMieG = uniform(0.76);         // Mie anisotropy (aureole tightness)
  const uAtmoAltitude = uniform(1500); // viewer height in the atmosphere (m)
  const uHr = uniform(7994);           // Rayleigh scale height (m)
  const uHm = uniform(1200);           // Mie scale height (m)
  const uBetaR = uniform(new THREE.Vector3(5.5e-6, 13.0e-6, 22.4e-6));
  const uBetaM = uniform(21e-6);
  // Multiple-scattering approximation (no LUT): bounced light is ~isotropic and
  // less path-extincted, so it fills the long-path horizon (bright glow) and
  // shadowed twilight sky that single-scatter leaves dark. Gated by sun
  // visibility so the night stays dark.
  const uMsAmount = uniform(1.0);   // strength of the multi-scatter fill
  const uMsExtinct = uniform(0.3);  // <1 = bounced light keeps more energy
  const RG = 6360e3, RT = 6420e3;      // planet / atmosphere radii (m)

  const uSunColor = uniform(new THREE.Color(0xfff3d8));
  const uSunCos = uniform(Math.cos(THREE.MathUtils.degToRad(1.2)));
  const uSunGlowPow = uniform(280);
  const uSunGlowStrength = uniform(0.55);
  const uSunDiscBright = uniform(8.0);

  const uMoonColor = uniform(new THREE.Color(0xcdd9ff));
  const uMoonCos = uniform(Math.cos(THREE.MathUtils.degToRad(1.6)));
  const uMoonGlowPow = uniform(900);
  const uMoonGlowStrength = uniform(0.25);
  const uMoonDiscBright = uniform(3.0);
  // Phase/surface (the moon is rendered as a reconstructed sphere in the disc).
  const uMoonRight = uniform(new THREE.Vector3(1, 0, 0));
  const uMoonUp = uniform(new THREE.Vector3(0, 1, 0));
  const uMoonLightDir = uniform(new THREE.Vector3(0, 0, 1)); // phase illumination dir
  const uMoonSinR = uniform(Math.sin(THREE.MathUtils.degToRad(1.6)));
  const uMoonSurface = uniform(0.85);   // maria/crater strength
  const uMoonEarthshine = uniform(0.12); // ashen glow on the dark side
  const uMoonTermSoft = uniform(0.06);  // terminator softness
  const uMoonEdgeSoft = uniform(0.04);  // disc edge anti-alias

  // Module-scratch vectors for the per-frame moon frame.
  const _mRight = new THREE.Vector3();
  const _mUp = new THREE.Vector3();
  const _mL = new THREE.Vector3();
  const _mUpRef = new THREE.Vector3();
  const _mTmp = new THREE.Vector3();

  const uStarDensity = uniform(220);
  const uStarThreshold = uniform(0.92);
  const uStarSize = uniform(0.08);
  const uStarBrightness = uniform(1.0);
  const uStarTwinkle = uniform(3.0);

  // ── Milky Way band ────────────────────────────────────────────────────────
  const uMilkyWayEnabled = uniform(1);
  const uMilkyWayIntensity = uniform(1.0);
  const uMilkyWayWidth = uniform(0.32);     // half-width of the band (|latitude|)
  const uMilkyWayScale = uniform(4.0);      // noise feature scale
  const uMilkyWayColor1 = uniform(new THREE.Color(0x5566a0)); // cool dust
  const uMilkyWayColor2 = uniform(new THREE.Color(0xefe6cf)); // warm star clouds
  const uGalacticPole = uniform(new THREE.Vector3(0.34, 0.5, 0.8).normalize());

  // ── Shooting stars (procedural, stateless) ────────────────────────────────
  const uMeteorEnabled = uniform(1);
  const uMeteorIntensity = uniform(1.0);
  const uMeteorRate = uniform(0.45);   // fraction of epochs that spawn a meteor
  const uMeteorSpeed = uniform(1.0);
  const uMeteorWidth = uniform(0.006); // streak thickness (radians of arc)
  const uMeteorLength = uniform(0.10); // trail length (radians of arc)

  // ── High cirrus deck (2D analytic clouds painted on the dome) ─────────────
  // Cheap fbm clouds projected onto a horizontal plane (so they converge to
  // the horizon like a real high deck). Complements the volumetric cumulus and
  // doubles as a perf fallback when the raymarch is off. Relit by sun/moon.
  const uCloudEnabled = uniform(1);
  const uCloudCoverage = uniform(0.5);   // fraction of sky covered
  const uCloudDensity = uniform(0.85);   // per-cloud opacity
  const uCloudOpacity = uniform(1.0);    // master opacity
  const uCloudScale = uniform(0.7);      // feature scale (bigger = smaller clouds)
  const uCloudStretch = uniform(2.5);    // anisotropy → cirrus streaks
  const uCloudSharpness = uniform(0.22); // coverage edge softness
  const uCloudDetail = uniform(0.8);     // fine-detail octave mix
  const uCloudSunTint = uniform(1.0);    // strength of warm sunset tint
  const uCloudSpeed = uniform(0.01);     // drift speed
  const uCloudWind = uniform(new THREE.Vector2(1, 0.35)); // drift direction
  const uCloudColor = uniform(new THREE.Color(0xffffff));
  const uCloudAerial = uniform(0.8);     // aerial perspective: low cirrus → sky behind it

  const uFogEnabled = uniform(0);
  const uFogColor = uniform(new THREE.Color(0x9fb8c4));
  const uFogDensity = uniform(0.0003);
  // How high up the sky the horizon haze climbs (in `up`, i.e. sin of elevation).
  // Smaller = the haze hugs the waterline, leaving the scattering's bright
  // horizon band visible instead of washing it out.
  const uFogHazeHeight = uniform(0.12);

  // ── Hash + star field ────────────────────────────────────────────────────
  const hash33 = Fn(([p]) => {
    const q = vec3(
      dot(p, vec3(127.1, 311.7, 74.7)),
      dot(p, vec3(269.5, 183.3, 246.1)),
      dot(p, vec3(113.5, 271.9, 124.6)),
    );
    return fract(sin(q).mul(43758.5453123));
  });

  // Varied star field: per-cell hash drives presence, position, SIZE, magnitude
  // and COLOR (cool blue-white → warm), so the field reads natural, not uniform.
  const starField = Fn(([dir]) => {
    const sp = dir.mul(uStarDensity);
    const cell = floor(sp);
    const f = fract(sp).sub(0.5);
    const rnd = hash33(cell);
    // Sparse: only cells whose hash clears the threshold hold a star.
    const present = step(uStarThreshold, rnd.x);
    const off = hash33(cell.add(vec3(1.7, 9.2, 3.3))).sub(0.5).mul(0.7);
    const d = length(f.sub(off));
    const size = uStarSize.mul(mix(float(0.45), float(1.7), rnd.z)); // a few bright, many faint
    const core = smoothstep(size, float(0.0), d);
    const mag = mix(float(0.3), float(1.0), rnd.y.mul(rnd.y));        // skew dim
    const tw = sin(uTime.mul(uStarTwinkle).add(rnd.y.mul(6.2831))).mul(0.35).add(0.65);
    const col = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.66), rnd.z.mul(rnd.z));
    return col.mul(present.mul(core).mul(mag).mul(tw).mul(uStarBrightness));
  });

  // Procedural shooting stars: a few stateless "slots", each cycling on its own
  // period. A lucky epoch spawns a meteor that sweeps a SHORT arc; we light the
  // thin line SEGMENT [tail→head] on the sphere (distance to the chord), bright
  // at the head and fading to the tail. No buffers; gated by night at call site.
  const shootingStars = Fn(([dir]) => {
    const acc = vec3(0.0).toVar();
    Loop(3, ({ i }) => {
      const slot = float(i);
      const period = float(5.0);
      const tt = uTime.mul(uMeteorSpeed).div(period).add(slot.mul(0.41));
      const epoch = floor(tt);
      const p = fract(tt); // 0..1 within this slot's cycle
      const h = hash33(vec3(epoch.add(slot.mul(17.3)), slot.add(3.0), 5.1));
      const lucky = step(uMeteorRate.oneMinus(), h.x);
      // Brief visible burst within the cycle (fade in, fade out).
      const win = smoothstep(float(0.0), float(0.05), p).mul(smoothstep(float(0.30), float(0.12), p)).toVar();
      // Random great circle: upward-biased anchor A + a perpendicular tangent T.
      const A = normalize(vec3(h.x.sub(0.5), h.y.mul(0.6).add(0.4), h.z.sub(0.5))).toVar();
      const h2 = hash33(vec3(epoch.add(11.0), slot.add(5.0), 2.2)).sub(0.5);
      const T = normalize(h2.sub(A.mul(dot(h2, A)))).toVar();
      // Head sweeps the arc over the burst; tail trails behind by uMeteorLength.
      const headAng = p.mul(0.55).toVar();
      const tailAng = headAng.sub(uMeteorLength);
      const headDir = A.mul(cos(headAng)).add(T.mul(sin(headAng))).toVar();
      const tailDir = A.mul(cos(tailAng)).add(T.mul(sin(tailAng))).toVar();
      // Closest point on the chord [tail→head]; chord ≈ arc for short segments.
      const e = headDir.sub(tailDir);
      const u = clamp(dot(dir.sub(tailDir), e).div(dot(e, e).max(float(1e-5))), float(0.0), float(1.0));
      const dist = length(dir.sub(tailDir.add(e.mul(u))));
      const line = smoothstep(uMeteorWidth, float(0.0), dist).mul(u.mul(u)); // taper to tail
      const head = smoothstep(uMeteorWidth.mul(2.5), float(0.0), length(dir.sub(headDir))); // bright tip
      const m = lucky.mul(win).mul(line.add(head));
      acc.addAssign(vec3(0.85, 0.92, 1.0).mul(m));
    });
    return acc.mul(uMeteorIntensity);
  });

  // ── Procedural moon surface (value-noise fbm → maria + craters) ────────────
  const hash13 = Fn(([p]) =>
    fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)),
  );
  const vnoise = Fn(([p]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(f.mul(-2.0).add(3.0));
    const c000 = hash13(i.add(vec3(0, 0, 0)));
    const c100 = hash13(i.add(vec3(1, 0, 0)));
    const c010 = hash13(i.add(vec3(0, 1, 0)));
    const c110 = hash13(i.add(vec3(1, 1, 0)));
    const c001 = hash13(i.add(vec3(0, 0, 1)));
    const c101 = hash13(i.add(vec3(1, 0, 1)));
    const c011 = hash13(i.add(vec3(0, 1, 1)));
    const c111 = hash13(i.add(vec3(1, 1, 1)));
    const x00 = mix(c000, c100, u.x), x10 = mix(c010, c110, u.x);
    const x01 = mix(c001, c101, u.x), x11 = mix(c011, c111, u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
  });
  const fbm3 = Fn(([p]) =>
    vnoise(p)
      .add(vnoise(p.mul(2.03).add(11.5)).mul(0.5))
      .add(vnoise(p.mul(4.01).add(31.7)).mul(0.25))
      .div(1.75),
  );

  // ── Nishita single-scattering atmosphere ─────────────────────────────────
  // Marches the view ray through the atmosphere shell; at each step a short
  // light-march toward the sun gives the optical depth to space, and Rayleigh
  // (molecular, blue) + Mie (aerosol, forward-peaked white) scattering are
  // accumulated with their phase functions. Output is HDR radiance (tone-mapped
  // into the sky RT with the rest of the scene).
  const atmosphere = Fn(([dir, sunDir]) => {
    const orig = vec3(0, float(RG).add(uAtmoAltitude), 0).toVar();
    const b = dot(orig, dir).toVar();
    const ococ = dot(orig, orig);
    // Far intersection with the atmosphere top (origin is always inside).
    const discA = b.mul(b).sub(ococ.sub(float(RT * RT)));
    const tmax = b.negate().add(sqrt(discA.max(0.0))).toVar();
    // Clamp the march to the ground if the planet is hit ahead (bright horizon).
    const discG = b.mul(b).sub(ococ.sub(float(RG * RG)));
    const tg = b.negate().sub(sqrt(discG.max(0.0)));
    If(discG.greaterThan(0.0).and(tg.greaterThan(0.0)), () => {
      tmax.assign(min(tmax, tg));
    });

    const betaR = uBetaR.mul(uRayleigh);
    const betaM = uBetaM.mul(uMie);
    const NS = 16, NL = 8;
    const segLen = tmax.div(float(NS)).toVar();
    const tCur = float(0.0).toVar();
    const sumR = vec3(0.0).toVar();
    const sumM = vec3(0.0).toVar();
    const sumMS = vec3(0.0).toVar(); // isotropic multiple-scatter fill
    const odR = float(0.0).toVar();
    const odM = float(0.0).toVar();

    Loop(NS, () => {
      const sp = orig.add(dir.mul(tCur.add(segLen.mul(0.5))));
      const h = length(sp).sub(float(RG));
      const hr = exp(h.negate().div(uHr)).mul(segLen);
      const hm = exp(h.negate().div(uHm)).mul(segLen);
      odR.addAssign(hr);
      odM.addAssign(hm);

      // Light march toward the sun for the optical depth (extinction to space).
      // No early-out on going underground: clamp the sample altitude at the ground
      // so the march stays continuous; the shadow itself is the smooth analytic
      // terminator below (replaces the old hard lit/shadow flip + Break).
      const bl = dot(sp, sunDir);
      const discL = bl.mul(bl).sub(dot(sp, sp).sub(float(RT * RT)));
      const segL = bl.negate().add(sqrt(discL.max(0.0))).div(float(NL)).toVar();
      const tCurL = float(0.0).toVar();
      const odLR = float(0.0).toVar();
      const odLM = float(0.0).toVar();
      Loop(NL, () => {
        const spl = sp.add(sunDir.mul(tCurL.add(segL.mul(0.5))));
        const hl = length(spl).sub(float(RG)).max(0.0); // clamp at ground
        odLR.addAssign(exp(hl.negate().div(uHr)).mul(segL));
        odLM.addAssign(exp(hl.negate().div(uHm)).mul(segL));
        tCurL.addAssign(segL);
      });

      // Soft analytic ground shadow: `m` is the sun's height above THIS sample's
      // geometric horizon (m = bl + sqrt(|sp|²−RG²)) — >0 lit, <0 shadowed, 0 at
      // the tangent terminator. Continuous & branchless, so single- and
      // multi-scatter fade gradually across twilight instead of snapping per
      // sample (the old hard `valid`/Break did).
      const m = bl.add(sqrt(dot(sp, sp).sub(float(RG * RG)).max(0.0)));
      const litSoft = smoothstep(float(-9000.0), float(9000.0), m).toVar();

      const tau = betaR.mul(odR.add(odLR)).add(betaM.mul(1.1).mul(odM.add(odLM)));
      const att = vec3(exp(tau.x.negate()), exp(tau.y.negate()), exp(tau.z.negate()));
      sumR.addAssign(att.mul(hr).mul(litSoft));
      sumM.addAssign(att.mul(hm).mul(litSoft));
      // Multiple-scatter fill: extinct only by the (reduced) VIEW path — the
      // bounced light is local, so it isn't dimmed by the long path to the sun.
      // (OFF by default now — msAmount=0; kept here for when it's dialed back up.)
      const tauV = betaR.mul(odR).add(betaM.mul(1.1).mul(odM));
      const attMS = vec3(
        exp(tauV.x.mul(uMsExtinct).negate()),
        exp(tauV.y.mul(uMsExtinct).negate()),
        exp(tauV.z.mul(uMsExtinct).negate()),
      );
      sumMS.addAssign(attMS.mul(betaR.mul(hr).add(betaM.mul(hm))).mul(litSoft));
      tCur.addAssign(segLen);
    });

    const mu = dot(dir, sunDir);
    const phaseR = float(3 / (16 * Math.PI)).mul(float(1.0).add(mu.mul(mu)));
    const g = uMieG;
    const g2 = g.mul(g);
    const phaseM = float(3 / (8 * Math.PI))
      .mul(float(1.0).sub(g2).mul(float(1.0).add(mu.mul(mu))))
      .div(float(2.0).add(g2).mul(pow(float(1.0).add(g2).sub(g.mul(mu).mul(2.0)).max(0.0001), 1.5)));

    const single = sumR.mul(betaR).mul(phaseR).add(sumM.mul(betaM).mul(phaseM));
    // Isotropic phase (1/4π) for the bounced fill.
    const multi = sumMS.mul(uMsAmount).mul(float(1 / (4 * Math.PI)));
    return single.add(multi).mul(uSunIntensity);
  });

  // ── High cirrus deck (2D analytic clouds on the dome) ─────────────────────
  // Returns vec4(rgb, alpha). Projects the view ray onto a horizontal plane so
  // clouds converge toward the horizon, samples a stretched fbm for streaky
  // cirrus, then relights by sun (silver lining), sunset (warm tint) and moon.
  const cirrus = Fn(([dir, dayF, twilightF, bgCol]) => {
    const y = dir.y.toVar();
    // Floor yy so the near-horizon uv doesn't explode into noise aliasing
    // (hidden by hMask anyway, but keeps the math finite).
    const yy = max(y, float(0.08));
    const proj = vec2(dir.x, dir.z).div(yy);
    // Anisotropic stretch → streaky cirrus rather than round blobs; drift on wind.
    const wind = uCloudWind.mul(uTime.mul(uCloudSpeed));
    const uv = vec2(proj.x.div(uCloudStretch), proj.y).mul(uCloudScale).add(wind).toVar();

    // Coverage field (slow morph on the 3rd axis) + a finer detail layer.
    const n = fbm3(vec3(uv.x, uv.y, uTime.mul(uCloudSpeed).mul(0.4))).toVar();
    const nHi = fbm3(vec3(uv.x.mul(2.7).add(19.0), uv.y.mul(2.7), 7.0));
    n.assign(mix(n, n.mul(0.55).add(nHi.mul(0.45)), uCloudDetail));

    // Threshold by coverage (higher coverage → lower threshold → more sky).
    const edge = uCloudCoverage.oneMinus();
    const cov = smoothstep(edge, edge.add(uCloudSharpness), n);
    // Fade out at / below the horizon.
    const hMask = smoothstep(float(0.02), float(0.2), y);
    const alpha = cov.mul(uCloudDensity).mul(hMask).mul(uCloudOpacity);

    // ── Lighting ──
    const sunAmt = max(dot(dir, uSunDir), float(0.0));
    const moonAmt = max(dot(dir, uMoonDir), float(0.0));
    // Day: bright base with a silver lining toward the sun.
    const dayBright = mix(float(0.82), float(1.3), pow(sunAmt, float(2.5)));
    const dayCol = uCloudColor.mul(dayBright).toVar();
    // Sunset: clouds catch warm low light near the horizon (pink mackerel sky).
    const warm = clamp(twilightF.mul(mix(float(0.35), float(1.0), sunAmt)).mul(uCloudSunTint), 0.0, 1.0);
    dayCol.assign(mix(dayCol, uSunsetColor.mul(1.15), warm));
    // Night: dim, tinted by the moon.
    const nightBright = mix(float(0.08), float(0.45), pow(moonAmt, float(2.5)));
    const nightCol = uCloudColor.mul(uMoonColor).mul(nightBright);

    const col = mix(nightCol, dayCol, dayF).toVar();
    // Aerial perspective: low (distant) cirrus recedes into the sky BEHIND it,
    // so the deck dissolves toward the horizon instead of holding full contrast.
    const aerial = smoothstep(float(0.5), float(0.05), y).mul(uCloudAerial);
    col.assign(mix(col, bgCol, aerial));
    return vec4(col, alpha);
  });

  // ── Sky color node ───────────────────────────────────────────────────────
  const skyColorNode = Fn(() => {
    const dir = normalize(positionWorld.sub(cameraPosition)).toVar();
    const up = dir.y.toVar();

    const sunEl = uSunDir.y;
    const dayF = smoothstep(-0.15, 0.25, sunEl).toVar();      // 0 night → 1 day
    const nightF = dayF.oneMinus();
    // Twilight band peaks while the sun grazes the horizon.
    const twilightF = smoothstep(-0.3, 0.0, sunEl)
      .mul(smoothstep(0.4, 0.04, sunEl));

    // Vertical gradient (day + night palettes).
    const tGrad = pow(max(up, float(0.0)), float(0.45));
    const analyticDay = mix(uHorizonDay, uZenithDay, tGrad);
    const nightCol = mix(uHorizonNight, uZenithNight, tGrad);

    // ── ANALYTIC sky: crossfade day↔night + warm sunset wash (the old look) ──
    const analyticSky = mix(nightCol, analyticDay, dayF).toVar();
    const sunAmt = max(dot(dir, uSunDir), float(0.0));
    const horizonBand = smoothstep(0.4, 0.0, abs(up));
    const sunset = twilightF.mul(horizonBand)
      .mul(mix(float(0.25), float(1.0), sunAmt));
    analyticSky.assign(mix(analyticSky, uSunsetColor, clamp(sunset.mul(0.8), 0.0, 1.0)));

    // ── PHYSICAL sky: Nishita scattering ADDED over the dark night gradient,
    //    so the blue overpowers it by day and twilight self-fades at night. ──
    const physicalSky = nightCol.add(atmosphere(dir, uSunDir));

    const skyCol = mix(analyticSky, physicalSky, uScatterMix).toVar();

    // Below the horizon. In SCATTER mode the Nishita march already clamps to the
    // planet ground, so it naturally fades from the bright horizon (long grazing
    // path) down to dark (steep, short path) — exactly like SkyMesh. So let it
    // show and only blend the explicit ground color in DEEP down (a floor instead
    // of black). In ANALYTIC mode the gradient is flat below the horizon, so blend
    // the ground in sooner. Either way the bottom follows the sky — no hard grey
    // seam at the waterline (the old code cut to ground over just ~2°).
    const groundDeep = smoothstep(-0.05, -0.6, up); // 0 at horizon → 1 far down
    const groundNear = smoothstep(0.0, -0.15, up); // analytic floor (sooner)
    const groundMix = mix(groundNear, groundDeep, uScatterMix);
    skyCol.assign(
      mix(skyCol, uGroundColor.mul(mix(float(0.12), float(1.0), dayF)), groundMix),
    );

    // Horizon + under-horizon haze (matches scene FogExp2 on terrain).
    const fogHorizon = smoothstep(uFogHazeHeight, float(0.0), up);
    const fogGround = smoothstep(float(0.06), float(-0.2), up);
    const fogMask = max(fogHorizon, fogGround);
    const fogDepth = fogMask.mul(float(SKY_RADIUS));
    const fogFac = sub(
      float(1),
      exp(fogDepth.mul(fogDepth).mul(uFogDensity).mul(uFogDensity).negate()),
    );
    skyCol.assign(mix(skyCol, uFogColor, mul(fogFac, uFogEnabled)));

    // ── Milky Way band (night only). Gated twice so only band pixels at night
    //    ever evaluate the FBM — day and off-band sky pay nothing. ──
    const aboveHorizon = smoothstep(float(-0.02), float(0.12), up);
    If(uMilkyWayEnabled.greaterThan(0.5).and(nightF.greaterThan(0.02)).and(up.greaterThan(-0.02)), () => {
      const lat = abs(dot(dir, uGalacticPole));
      const band = smoothstep(uMilkyWayWidth, float(0.0), lat);
      If(band.greaterThan(0.001), () => {
        const n = fbm3(dir.mul(uMilkyWayScale));
        const cloud = smoothstep(float(0.45), float(0.85), n);   // bright star clouds
        const dust = smoothstep(float(0.22), float(0.46), n);    // dark dust lanes carve in
        const bright = band.mul(mix(float(0.3), float(1.1), cloud)).mul(mix(float(0.35), float(1.0), dust));
        const col = mix(uMilkyWayColor1, uMilkyWayColor2, n);
        skyCol.addAssign(col.mul(bright).mul(uMilkyWayIntensity).mul(nightF).mul(aboveHorizon));
      });
    });

    // Stars (above the horizon, night only).
    skyCol.addAssign(starField(dir).mul(nightF).mul(aboveHorizon));

    // Shooting stars (gated to night so day pays nothing).
    If(uMeteorEnabled.greaterThan(0.5).and(nightF.greaterThan(0.02)), () => {
      skyCol.addAssign(shootingStars(dir).mul(nightF).mul(aboveHorizon));
    });

    // High cirrus deck: sits OVER the sky + stars (occludes them) but UNDER the
    // sun/moon discs below (thin clouds → the disc still shines through). Gated
    // so a disabled deck pays nothing.
    If(uCloudEnabled.greaterThan(0.5), () => {
      const c = cirrus(dir, dayF, twilightF, skyCol);
      skyCol.assign(mix(skyCol, c.xyz, c.w));
    });

    // Sun disc + glow (fades out below the horizon).
    const sunDot = dot(dir, uSunDir);
    const sunUpFade = smoothstep(-0.06, 0.05, uSunDir.y);
    const sunDisc = smoothstep(uSunCos, float(1.0), sunDot).mul(uSunDiscBright);
    const sunGlow = pow(max(sunDot, float(0.0)), uSunGlowPow).mul(uSunGlowStrength);
    skyCol.addAssign(uSunColor.mul(sunDisc.add(sunGlow)).mul(sunUpFade));

    // Moon — reconstructed as a lit sphere inside the disc (phase + surface).
    const moonDot = dot(dir, uMoonDir);
    const moonUpFade = smoothstep(-0.06, 0.05, uMoonDir.y)
      .mul(mix(float(0.25), float(1.0), nightF));

    // Disc-local coords; reconstruct the near-hemisphere normal as a sphere.
    const nuvx = dot(dir, uMoonRight).div(uMoonSinR);
    const nuvy = dot(dir, uMoonUp).div(uMoonSinR);
    const r2 = nuvx.mul(nuvx).add(nuvy.mul(nuvy));
    const inside = r2.lessThan(1.0).and(moonDot.greaterThan(0.0));

    const moonCol = vec3(0.0).toVar();
    If(inside, () => {
      const z = sqrt(max(float(1.0).sub(r2), float(0.0)));
      const N = normalize(
        uMoonRight.mul(nuvx).add(uMoonUp.mul(nuvy)).add(uMoonDir.negate().mul(z)),
      );
      // Phase: lit where the surface faces the phase-light direction.
      const lit = dot(N, uMoonLightDir);
      const litS = smoothstep(uMoonTermSoft.negate(), uMoonTermSoft, lit);
      const limb = pow(z.add(0.06).clamp(0.0, 1.0), float(0.35)); // gentle limb darkening
      // Surface: low-freq maria (dark seas) + higher-freq crater speckle.
      const nLow = fbm3(N.mul(2.4));
      const nHi = fbm3(N.mul(7.0).add(40.0));
      const maria = smoothstep(0.58, 0.40, nLow);
      const craters = smoothstep(0.62, 0.78, nHi);
      const albedoRaw = float(1.0).sub(maria.mul(0.5)).sub(craters.mul(0.22)).max(0.25);
      const albedo = mix(float(1.0), albedoRaw, uMoonSurface);

      const dayCol = uMoonColor.mul(albedo).mul(litS).mul(limb);
      // Earthshine: faint cool fill on the unlit side (the "ashen light").
      const ashen = uMoonColor.mul(vec3(0.55, 0.62, 0.9))
        .mul(litS.oneMinus()).mul(uMoonEarthshine).mul(albedo);
      moonCol.assign(dayCol.add(ashen).mul(uMoonDiscBright));
    });

    const edge = smoothstep(float(1.0), float(1.0).sub(uMoonEdgeSoft), sqrt(r2));
    const moonGlow = pow(max(moonDot, float(0.0)), uMoonGlowPow).mul(uMoonGlowStrength);
    skyCol.addAssign(
      moonCol.mul(edge).add(uMoonColor.mul(moonGlow)).mul(moonUpFade),
    );

    return vec4(max(skyCol, vec3(0.0)), 1.0);
  });

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = skyColorNode();
  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.depthTest = false;
  material.fog = false;

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16), material);
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  mesh.name = "DayNightSkyDome";

  /**
   * @param {object} P    — PARAMS slice (sky.*)
   * @param {object} frame — { time, sunDir, moonDir, camera }
   */
  function update(P, frame) {
    mesh.position.copy(frame.camera.position);

    uTime.value = frame.time;
    uSunDir.value.copy(frame.sunDir);
    uMoonDir.value.copy(frame.moonDir);

    uZenithDay.value.set(P.zenithDay);
    uHorizonDay.value.set(P.horizonDay);
    uZenithNight.value.set(P.zenithNight);
    uHorizonNight.value.set(P.horizonNight);
    uSunsetColor.value.set(P.sunsetColor);
    uGroundColor.value.set(P.groundColor);

    uScatterMix.value = P.scatter ? 1 : 0;
    uSunIntensity.value = P.sunIntensity;
    uRayleigh.value = P.rayleigh;
    uMie.value = P.mie;
    uMieG.value = P.mieG;
    uAtmoAltitude.value = P.atmoAltitude;
    uMsAmount.value = P.msAmount;
    uMsExtinct.value = P.msExtinct;

    uSunColor.value.set(P.sunColor);
    uSunCos.value = Math.cos(THREE.MathUtils.degToRad(P.sunSizeDeg));
    uSunGlowPow.value = P.sunGlowPow;
    uSunGlowStrength.value = P.sunGlowStrength;
    uSunDiscBright.value = P.sunDiscBright;

    uMoonColor.value.set(P.moonColor);
    uMoonCos.value = Math.cos(THREE.MathUtils.degToRad(P.moonSizeDeg));
    uMoonGlowStrength.value = P.moonGlowStrength;
    uMoonDiscBright.value = P.moonDiscBright;

    // Moon phase frame (right/up ⊥ moonDir) + the phase-light direction.
    const md = frame.moonDir;
    _mUpRef.set(0, 1, 0);
    if (Math.abs(md.y) > 0.99) _mUpRef.set(0, 0, 1);
    _mRight.crossVectors(_mUpRef, md).normalize();
    _mUp.crossVectors(md, _mRight).normalize();
    uMoonRight.value.copy(_mRight);
    uMoonUp.value.copy(_mUp);
    const ang = (1 - P.moonPhase) * Math.PI; // 0 = full, π = new
    const orient = THREE.MathUtils.degToRad(P.moonPhaseOrient);
    _mL.copy(md).multiplyScalar(-Math.cos(ang));
    _mTmp.copy(_mRight).multiplyScalar(Math.sin(ang) * Math.cos(orient));
    _mL.add(_mTmp);
    _mTmp.copy(_mUp).multiplyScalar(Math.sin(ang) * Math.sin(orient));
    _mL.add(_mTmp).normalize();
    uMoonLightDir.value.copy(_mL);
    uMoonSinR.value = Math.sin(THREE.MathUtils.degToRad(P.moonSizeDeg));
    uMoonSurface.value = P.moonSurface;
    uMoonEarthshine.value = P.moonEarthshine;
    uMoonTermSoft.value = P.moonTermSoft;

    uStarDensity.value = P.starDensity;
    uStarThreshold.value = P.starThreshold;
    uStarSize.value = P.starSize;
    uStarBrightness.value = P.starBrightness;
    uStarTwinkle.value = P.starTwinkle;

    uMilkyWayEnabled.value = P.milkyWayEnabled ? 1 : 0;
    uMilkyWayIntensity.value = P.milkyWayIntensity;
    uMilkyWayWidth.value = P.milkyWayWidth;
    uMilkyWayScale.value = P.milkyWayScale;
    uMilkyWayColor1.value.set(P.milkyWayColor1);
    uMilkyWayColor2.value.set(P.milkyWayColor2);
    uMeteorEnabled.value = P.meteorEnabled ? 1 : 0;
    uMeteorIntensity.value = P.meteorIntensity;
    uMeteorRate.value = P.meteorRate;
    uMeteorSpeed.value = P.meteorSpeed;
    uMeteorWidth.value = P.meteorWidth;
    uMeteorLength.value = P.meteorLength;

    uCloudEnabled.value = P.cloudEnabled ? 1 : 0;
    uCloudCoverage.value = P.cloudCoverage;
    uCloudDensity.value = P.cloudDensity;
    uCloudOpacity.value = P.cloudOpacity;
    uCloudScale.value = P.cloudScale;
    uCloudStretch.value = P.cloudStretch;
    uCloudSharpness.value = P.cloudSharpness;
    uCloudDetail.value = P.cloudDetail;
    uCloudSunTint.value = P.cloudSunTint;
    uCloudSpeed.value = P.cloudSpeed;
    uCloudWind.value.set(
      Math.cos(THREE.MathUtils.degToRad(P.cloudWindDeg)),
      Math.sin(THREE.MathUtils.degToRad(P.cloudWindDeg)),
    );
    uCloudColor.value.set(P.cloudColor);
    uCloudAerial.value = P.cloudAerial ?? 0.8;

    if (frame.fog) {
      uFogEnabled.value = frame.fog.enabled ? 1 : 0;
      uFogColor.value.copy(frame.fog.color);
      uFogDensity.value = frame.fog.density;
      if (frame.fog.hazeHeight !== undefined) uFogHazeHeight.value = frame.fog.hazeHeight;
    }
  }

  function dispose() {
    mesh.geometry.dispose();
    material.dispose();
  }

  return { mesh, update, dispose };
}

export const SKY_DEFAULTS = {
  zenithDay: "#2a6bd8",
  horizonDay: "#bfe0ff",
  zenithNight: "#05080f",
  horizonNight: "#1a2740",
  sunsetColor: "#ff7a33",
  groundColor: "#4a4a52",

  // Atmospheric scattering (Nishita). scatter:true = physical sky.
  scatter: true,
  sunIntensity: 22,
  rayleigh: 1.0,
  mie: 1.0,
  mieG: 0.76,
  atmoAltitude: 1500,
  msAmount: 1.0,    // multiple-scattering fill strength (bright horizon glow)
  msExtinct: 0.3,   // <1 = bounced light keeps more energy

  sunColor: "#fff3d8",
  sunSizeDeg: 1.2,
  sunGlowPow: 280,
  sunGlowStrength: 0.55,
  sunDiscBright: 8.0,

  moonColor: "#cdd9ff",
  moonSizeDeg: 1.6,
  moonGlowStrength: 0.25,
  moonDiscBright: 3.0,
  moonPhase: 0.85,       // 1 = full, 0.5 = quarter, 0 = new
  moonPhaseOrient: 30,   // which way the crescent points (deg)
  moonSurface: 0.85,     // maria / crater strength
  moonEarthshine: 0.12,  // ashen glow on the dark side
  moonTermSoft: 0.06,    // terminator softness

  starDensity: 220,
  starThreshold: 0.92,
  starSize: 0.08,
  starBrightness: 1.0,
  starTwinkle: 3.0,

  milkyWayEnabled: true,
  milkyWayIntensity: 1.0,
  milkyWayWidth: 0.32,
  milkyWayScale: 4.0,
  milkyWayColor1: "#5566a0",
  milkyWayColor2: "#efe6cf",

  meteorEnabled: false,
  meteorIntensity: 1.0,
  meteorRate: 0.45,
  meteorSpeed: 1.0,
  meteorWidth: 0.006,
  meteorLength: 0.10,

  // High cirrus deck (2D analytic clouds painted on the sky dome). Complements
  // the volumetric cumulus and stands in as a cheap fallback when it's off.
  cloudEnabled: true,
  cloudCoverage: 0.5,
  cloudDensity: 0.85,
  cloudOpacity: 1.0,
  cloudScale: 0.7,
  cloudStretch: 2.5,
  cloudSharpness: 0.22,
  cloudDetail: 0.8,
  cloudSunTint: 1.0,
  cloudSpeed: 0.01,
  cloudWindDeg: 20,
  cloudColor: "#ffffff",
  cloudAerial: 0.8,
};
