import * as THREE from "three";
import {
  Break, Discard, Fn, If, Loop, abs, cameraFar, cameraNear, cameraPosition, dot,
  float, interleavedGradientNoise, length, max, min, mix, normalize, oneMinus,
  perspectiveDepthToViewZ, positionView, positionWorld, pow, saturate,
  screenCoordinate, screenUV, sin, smoothstep, sqrt, uniform, uv, vec2,
  viewportDepthTexture,
} from "three/tsl";

/**
 * Visible headlight beams — the light you can see IN THE AIR, not the pool it
 * makes on the road.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * A `THREE.SpotLight` only ever computes light ARRIVING AT A SURFACE. Nothing
 * is evaluated for the air between the lamp and the road, which is physically
 * correct for a vacuum: you see a beam only because the air has dust, mist or
 * exhaust in it bouncing photons sideways into your eye. Clean air on a dry
 * night genuinely has no visible beam, only the pool on the tarmac.
 *
 * So "make the headlights visible" is really "compute scattering in the air",
 * and this file does that for the ONE case the game cares about: a handful of
 * cones, no scene-wide fog volume.
 *
 * ── WHY A MARCH AND NOT A CONE CARD ──────────────────────────────────────────
 * The cheap classic is an additive cone MESH. It works, it is nearly free, and
 * it falls apart exactly where this game needs it: a free camera orbiting the
 * car looks at the beam from every angle, and a card only ever looks right from
 * the angles it was tuned at. Read from the side it is a plastic party hat.
 *
 * What is done instead is single scattering integrated along the VIEW RAY. The
 * result is derived from the ray, so front, side, three-quarter and behind all
 * come out correct with no special-casing, and it clips properly against scene
 * geometry. The bounding cone below is only a rasterisation hull — a cheap way
 * to run this shader on the pixels the beam could possibly cover — never the
 * beam itself.
 *
 * ── WHY IT IS STILL VISIBLE FROM THE SIDE ────────────────────────────────────
 * Mie scattering is forward-peaked, which is why a beam is dazzling head-on and
 * subtle from the kerb. But "peaked" is not "zero elsewhere" — you can obviously
 * see a car's beams from the pavement in rain. `phaseMix` is that knob: 0 is
 * flat isotropic (visible everywhere, reads fake), 1 is pure Henyey-Greenstein
 * (dramatic head-on, nearly gone from the side). The default sits between, so
 * the beam is brightest into the barrel, clearly present broadside, dimmest from
 * behind, and never actually off.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * No shadowing. A pillar standing in the beam will not cut a dark slot through
 * it, because that needs the spot's shadow map sampled at every step and this
 * marches 32 steps per pixel already. If shadowed beams ever matter, the answer
 * is not to bolt shadows on here — it is a froxel volume, where the cost is
 * fixed regardless of light count and the whole city gets beams at once.
 *
 * ── MRT: CHECKED, AND FINE ───────────────────────────────────────────────────
 * The beam is a TRANSPARENT surface and r184's MRTNode blends only the `output`
 * attachment, which is the mechanism that lets a transparent quad erase the
 * emissive buffer behind it. It does not bite here: the fix is already in place
 * at the SCENE level (postFxPipeline's `_applySceneMRT` carries real coverage in
 * emissive's `.a` and gives that attachment a blend mode), and road.html is on
 * that path. A per-material check cannot see this — the blend state comes from
 * the render context, never from a material's own `mrtNode` — so do not
 * re-diagnose it from this file. `diffuseColor`/`normal` are still overwritten
 * and will matter if SSAO is ever switched on.
 *
 * @see headlight-lab.html — the tuning harness (orbit right around the car)
 */

/** Loop bound. `steps` is a uniform and may be lower; it can never be higher. */
const MAX_STEPS = 48;

/**
 * Scene depth grab, shared by both lamps.
 *
 * Module scope is not a style choice here, it is the single biggest cost lever
 * in the file: every ViewportDepthTextureNode instance runs its own
 * `copyFramebufferToTexture` once per render, and that copy measures ~0.4 ms —
 * more than half the beam's fixed cost, and more than the entire march below 16
 * steps. One instance for two lamps rather than two.
 *
 * modularRoadDriftSmoke.js holds a SECOND one for the same buffer, so a drifting
 * car pays for the copy twice. Merging them is the obvious next win; it is left
 * alone for now because it is a change to a shipped effect for a saving that
 * only appears while smoke is on screen.
 */
const _sceneDepthTex = /*#__PURE__*/ viewportDepthTexture();

export const HEADLIGHT_BEAM_DEFAULTS = {
  /* ── cone ──────────────────────────────────────────────────────────────── */
  /** Outer half-angle, rad. Matches HEADLIGHTS.angle in modularRoadVehicle.js. */
  angle: 0.42,
  /** Metres. Matches HEADLIGHTS.distance. */
  range: 80,
  /** 0 = hard-edged cone, 1 = the whole cone is falloff. */
  penumbra: 0.75,

  /* ── media ─────────────────────────────────────────────────────────────── */
  /**
   * How much stuff is in the air, 0..1. THIS is what should be driven by the
   * weather, not `intensity`: a beam that is always visible reads as a fog
   * machine, a beam that appears in rain and in your own tyre smoke reads as
   * light.
   */
  media: 0.55,
  /** Overall brightness of the scattering. Multiplies `media`. */
  intensity: 0.42,
  color: "#fff2d6",

  /* ── scattering ────────────────────────────────────────────────────────── */
  /** Henyey-Greenstein g. >0 forward-peaked, which is what real fog does. */
  anisotropy: 0.55,
  /** 0 = isotropic (flat, fake, visible everywhere), 1 = pure HG. */
  phaseMix: 0.6,

  /* ── falloff along the axis ────────────────────────────────────────────── */
  /**
   * Metres at which the axial falloff has halved. The falloff is
   * 1/(1 + (s/ref)^2) — inverse-square in spirit, but finite at the lamp, which
   * matters because the integral starts AT the lamp.
   */
  falloffRef: 9,
  /** Metres of fade-in from the lamp face, so the tip does not blow out. */
  nearFade: 1.4,
  /** Fraction of `range` at which the tip starts fading out. */
  rangeFade: 0.5,

  /* ── texture ───────────────────────────────────────────────────────────── */
  /** 0 = a smooth cone (reads as geometry), 1 = fully lumpy. */
  noise: 0.4,
  /** Cycles per metre, roughly. Lower = bigger lumps. */
  noiseScale: 0.05,
  /** Metres/s the media drifts. The car drives THROUGH it; it does not follow. */
  noiseSpeed: 0.35,

  /* ── integration ───────────────────────────────────────────────────────── */
  /**
   * Samples along the visible chord. Capped at MAX_STEPS.
   *
   * ── MEASURED IN THE GAME, AND THE MARCH IS NOT THE BILL ───────────────────
   *
   * Both lamps, chase camera, the game's own 0.6 rad cone. Taken by raising the
   * pixel ratio until the frame is off the vsync ceiling and scaling real frame
   * time back by the pixel count — NOT from a counter (see
   * v3/render/gpuStatsPanel.js for why, and the warning at the end of this
   * block for how badly the counter lies about this particular effect):
   *
   *   12 steps  0.94 ms      32 steps  1.59 ms
   *   20 steps  1.23 ms      48 steps  1.99 ms
   *
   * That is a straight line of ~0.029 ms per step on top of a ~0.6 ms FLOOR,
   * and the floor is the interesting half. Stubbing out the depth read alone
   * took 1.31 ms down to 0.89 ms, so roughly 0.4 ms of it is the full-res depth
   * framebuffer COPY that `viewportDepthTexture()` issues — a fixed per-frame
   * cost that no amount of step tuning can reach.
   *
   * TWO CONSEQUENCES:
   *  • The step slider is worth less than it looks. 48 → 12 saves ~1.0 ms;
   *    12 → 6 saves almost nothing. 16 is the default because the lab showed
   *    16 and 32 to be indistinguishable (the entry dither turns step banding
   *    into a static pattern and bloom eats it), so anything above it is paying
   *    for nothing visible.
   *  • THE AVAILABLE WIN IS THE DEPTH GRAB, NOT THE MARCH. Every
   *    ViewportDepthTextureNode instance runs its own `copyFramebufferToTexture`
   *    once per render — modularRoadDriftSmoke.js has a second one — so while
   *    the car is drifting the frame pays for two identical copies. One shared
   *    grab between the two would be worth more than every step below 16.
   *
   * ── WHY THE LAB'S NUMBERS WERE LOWER ─────────────────────────────────────
   * headlight-lab reported 0.67 ms at 20 steps. Two reasons, both real: the lab
   * reads `renderer.info.render.timestamp`, which publishes partial frames, and
   * its cone is 0.42 rad against the game's 0.6, which is most of the screen
   * coverage. Believe these numbers, not those.
   */
  steps: 16,

  /* ── rasterisation hull ────────────────────────────────────────────────── */
  /**
   * The bounding cone is built this much wider than the beam. It only needs to
   * COVER the beam's screen footprint; too tight clips the penumbra, too loose
   * just wastes pixels on fragments that discard immediately.
   */
  hullSpread: 1.25,

  /* ── lamp glare ────────────────────────────────────────────────────────── */
  /**
   * The billboard flare on the lens itself. Worth having separately from bloom:
   * it is the single loudest "the lights are on" cue at any distance, and it
   * costs one additive quad per lamp.
   */
  glare: true,
  glareSize: 1.7,
  glareIntensity: 1.2,
  /** Exponent on the head-on term. Higher = the flare dies faster off-axis. */
  glareFalloff: 3.0,
};

/* =========================================================================== *
 * SHADER PIECES — exported so anything else in the beam can reuse them.
 * The lab's rain uses `coneAttenuation` to light its drops, which is what makes
 * the beam visible through the particles inside it rather than only as haze.
 * =========================================================================== */

/**
 * How strongly the lamp illuminates a world-space point: the cone profile, the
 * axial falloff and the two end fades, with no scattering term. Returns 0..1.
 *
 * @param {Node<vec3>} p     world position
 * @param {object}     lamp  a lamp record from `createHeadlightBeams().lamps`
 * @param {object}     u     the shared uniform bag
 */
export function coneAttenuation(p, lamp, u) {
  const v = p.sub(lamp.uApex).toVar();
  const r = max(length(v), float(1e-4)).toVar();
  /** Distance along the beam axis. NEGATIVE behind the lamp, which kills it. */
  const s = dot(v, lamp.uAxis).toVar();
  const cosT = s.div(r);

  const cone = smoothstep(u.cosOuter, u.cosInner, cosT);
  const q = s.div(u.fallRef);
  const fall = float(1).div(float(1).add(q.mul(q)));
  const nearIn = smoothstep(float(0), u.nearFade, s);
  const farOut = oneMinus(smoothstep(u.rangeFadeAt, u.range, s));

  return cone.mul(fall).mul(nearIn).mul(farOut);
}

/**
 * Henyey-Greenstein, NORMALISED so isotropic == 1. That normalisation is the
 * whole reason `intensity` does not need retuning every time `anisotropy` moves,
 * and it makes `phaseMix` a straight lerp between "flat" and "peaked".
 */
export function scatterPhase(cosTheta, u) {
  const gg = u.g.mul(u.g);
  const denom = pow(max(float(1e-4), gg.add(1).sub(u.g.mul(2).mul(cosTheta))), 1.5);
  return mix(float(1), oneMinus(gg).div(denom), u.phaseMix);
}

/**
 * Lumpiness of the media, mean 1 whatever `noise` is set to.
 *
 * Three sines, not a texture and not `triNoise3D`: this is evaluated 32 times
 * per pixel per lamp, so a 3-octave noise here is not a detail, it is the
 * frame budget. It is enough to stop the cone reading as a smooth solid, which
 * is the only job it has.
 *
 * Sampled in WORLD space, deliberately. The haze belongs to the world, so the
 * car drives through it and the lumps stream past — sampling in lamp space
 * would weld the texture to the car and it would look painted on.
 */
function mediaLumps(p, u) {
  const q = p.mul(u.noiseScale).toVar();
  const t = u.time;
  const a = sin(q.x.add(t.mul(0.7)))
    .mul(sin(q.z.mul(1.31).sub(t.mul(0.53))))
    .mul(sin(q.y.mul(1.77).add(t.mul(0.91))));
  const b = sin(q.x.mul(2.7).sub(t.mul(1.1))).mul(sin(q.z.mul(3.1).add(t.mul(0.9))));
  const f = a.mul(0.6).add(b.mul(0.4)).mul(0.5).add(0.5); // 0..1, mean ~0.5
  return mix(float(1), f.mul(2), u.noise);
}

/* =========================================================================== *
 * SYSTEM
 * =========================================================================== */

/**
 * @param {object}   [opts]
 * @param {object}   [opts.params]   overrides for HEADLIGHT_BEAM_DEFAULTS
 * @param {Function} [opts.decorate] `(material, kind, colorNode) => void`, called
 *   once per material at attach time with kind `"beam"` or `"glare"`. This is how
 *   the game opts the glare into v3's SELECTIVE bloom without this file having to
 *   know v3's post stack exists — the lab passes nothing and renders with a plain
 *   full-frame bloom instead.
 */
export function createHeadlightBeams(opts = {}) {
  const params = { ...HEADLIGHT_BEAM_DEFAULTS, ...(opts.params || {}) };
  const decorate = typeof opts.decorate === "function" ? opts.decorate : null;

  /** Shared by every lamp — only the apex and axis are per-lamp. */
  const u = {
    cosOuter: uniform(0),
    cosInner: uniform(0),
    range: uniform(0),
    rangeFadeAt: uniform(0),
    nearFade: uniform(0),
    fallRef: uniform(0),
    color: uniform(new THREE.Color(0xffffff)),
    intensity: uniform(0),
    media: uniform(0),
    g: uniform(0),
    phaseMix: uniform(0),
    noise: uniform(0),
    noiseScale: uniform(0),
    time: uniform(0),
    steps: uniform(32),
  };

  const lamps = [];
  let hullGeo = buildHull(params);
  let time = 0;

  /* ── geometry ──────────────────────────────────────────────────────────── */

  /**
   * A closed cone with its APEX AT THE LOCAL ORIGIN and its axis along +Z, so a
   * lamp mount can be an ordinary Object3D that has been `lookAt`-ed at the aim
   * point and the beam just works as its child.
   *
   * ConeGeometry builds along +Y with the apex at +h/2, so it needs both moves.
   * The cap is kept (`openEnded: false`) because we shade BACK faces: without
   * the base disc there are no back faces at all when you look up the beam from
   * in front of the car, and the beam silently vanishes from the one angle it
   * matters most at.
   */
  function buildHull(p) {
    const half = Math.min(p.angle * p.hullSpread, 1.45);
    const h = p.range * 1.02;
    const g = new THREE.ConeGeometry(h * Math.tan(half), h, 28, 1, false);
    g.translate(0, -h / 2, 0);
    g.rotateX(-Math.PI / 2);
    return g;
  }

  /* ── the beam shader ───────────────────────────────────────────────────── */

  function buildBeamNode(lamp) {
    return Fn(() => {
      const camToFrag = positionWorld.sub(cameraPosition);
      const fragDist = max(length(camToFrag), float(1e-4)).toVar();
      const rd = camToFrag.div(fragDist).toVar(); // unit ray, camera → fragment

      /**
       * How far the scene is ALONG THIS RAY. positionView.z is measured down the
       * view axis, so it needs the 1/cos rescale before it can be compared with
       * ray parameters — and dist/viewZ is exactly that factor, constant along
       * the ray, so the current fragment's own ratio is the right one to use.
       */
      const sceneViewZ = perspectiveDepthToViewZ(
        _sceneDepthTex.sample(screenUV).r, cameraNear, cameraFar,
      ).negate();
      const fragViewZ = max(positionView.z.negate(), float(1e-4));
      const sceneT = sceneViewZ.mul(fragDist).div(fragViewZ).toVar();

      const co = cameraPosition.sub(lamp.uApex).toVar();
      const cv = dot(co, lamp.uAxis).toVar(); // camera's axial coordinate
      const dv = dot(rd, lamp.uAxis).toVar(); // rate of change of it along the ray

      /**
       * THE VISIBLE CHORD.
       *
       * `tFar` starts at the fragment itself, which is free and exactly right:
       * we are shading the hull's BACK face, so the geometry has already told us
       * where the beam stops being possible. `sceneT` then clips it against
       * solid geometry — that clip is what makes the beam terminate on a wall
       * instead of shining through it, and it is why this material needs no
       * hardware depth test at all.
       */
      const tNear = float(0).toVar();
      const tFar = min(fragDist, sceneT).toVar();

      // Axial slab, 0 <= s <= range.
      If(abs(dv).greaterThan(float(1e-4)), () => {
        const ta = cv.negate().div(dv);
        const tb = u.range.sub(cv).div(dv);
        tNear.assign(max(tNear, min(ta, tb)));
        tFar.assign(min(tFar, max(ta, tb)));
      }).Else(() => {
        // Ray runs broadside to the axis: it is inside the slab everywhere, or
        // nowhere. `min(cv, range - cv) < 0` is "outside" without a boolean op.
        If(min(cv, u.range.sub(cv)).lessThan(float(0)), () => {
          tFar.assign(float(-1));
        });
      });

      /**
       * Cone quadric, used ONLY TO TIGHTEN the interval — never to decide what
       * is lit (the per-sample angle test does that, and gives us the penumbra
       * for free). Being conservative here can only cost steps, never
       * correctness, which is why the awkward `a >= 0` case is simply skipped:
       * that is the ray pointing within the half-angle of the axis, where the
       * slab bound is already tight.
       */
      const k = u.cosOuter.mul(u.cosOuter);
      const a = dv.mul(dv).sub(k);
      If(a.lessThan(float(-1e-6)), () => {
        const b = cv.mul(dv).sub(k.mul(dot(co, rd))).mul(2);
        const c = cv.mul(cv).sub(k.mul(dot(co, co)));
        const disc = b.mul(b).sub(a.mul(c).mul(4));
        If(disc.greaterThan(float(0)), () => {
          const sq = sqrt(disc);
          const inv = float(0.5).div(a); // negative: this flips the root order
          const r0 = b.negate().add(sq).mul(inv);
          const r1 = b.negate().sub(sq).mul(inv);
          tNear.assign(max(tNear, min(r0, r1)));
          tFar.assign(min(tFar, max(r0, r1)));
        }).Else(() => {
          tFar.assign(float(-1));
        });
      });

      const span = tFar.sub(tNear).toVar();
      Discard(span.lessThanEqual(float(0)));

      const dt = span.div(u.steps).toVar();

      /**
       * Fixed spatial dither, NOT re-seeded per frame. 32 steps over an 80 m
       * chord is a 2.5 m sample spacing and it bands visibly; jittering the
       * entry breaks the bands into a static screen-space pattern that bloom
       * then smears away. Re-seeding it per frame would turn that static
       * pattern into a crawl, which is far more noticeable than the banding.
       */
      const jitter = interleavedGradientNoise(screenCoordinate.xy).toVar();

      const accum = float(0).toVar();
      Loop(MAX_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(u.steps), () => Break());

        const p = cameraPosition.add(rd.mul(tNear.add(dt.mul(float(i).add(jitter))))).toVar();
        const att = coneAttenuation(p, lamp, u);

        // Scattering angle: light travels lamp → p, then p → eye. `rd` points
        // camera → fragment, so the direction back to the eye is -rd.
        const cosTheta = dot(normalize(p.sub(lamp.uApex)), rd.negate());

        accum.addAssign(att.mul(scatterPhase(cosTheta, u)).mul(mediaLumps(p, u)));
      });

      /**
       * `dt` turns the sum into an integral; dividing by `fallRef` makes that
       * integral dimensionless, so `intensity` means the same thing whatever
       * the range and falloff are set to.
       */
      accum.mulAssign(dt.div(u.fallRef));

      return u.color.mul(u.intensity.mul(u.media).mul(saturate(accum)));
    })();
  }

  /* ── the lens glare ────────────────────────────────────────────────────── */

  /**
   * A soft core plus a horizontal streak — the shape a reflector housing
   * actually throws, and the thing that reads as "headlight" in a still frame
   * even before the beam does.
   *
   * The head-on falloff is applied on the CPU (`uGlare`) rather than in the
   * shader. A Sprite's world matrix carries no rotation, so the beam axis is
   * not available to it, and the alternative — a per-lamp direction uniform
   * plumbed into a shared material — is more machinery than one dot product a
   * frame deserves.
   */
  function buildGlareMaterial(uGlare) {
    const mat = new THREE.SpriteNodeMaterial();
    const flare = Fn(() => {
      const d = uv().sub(vec2(0.5)).toVar();
      const rad = length(d).mul(2);
      const core = pow(saturate(oneMinus(rad)), float(3.5));
      const halo = pow(saturate(oneMinus(rad)), float(0.9)).mul(0.18);
      const streak = saturate(oneMinus(abs(d.y).mul(26)))
        .mul(saturate(oneMinus(abs(d.x).mul(2.05))))
        .mul(0.55);
      return u.color.mul(core.add(halo).add(streak)).mul(uGlare);
    })();
    mat.colorNode = flare;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.AdditiveBlending;
    mat.fog = false;
    decorate?.(mat, "glare", flare);
    return mat;
  }

  /* ── API ───────────────────────────────────────────────────────────────── */

  /**
   * Hang a beam on a mount. The mount is an ordinary Object3D whose +Z points
   * down the beam — in the game that is the existing headlamp mount, aimed at
   * the same target the SpotLight uses.
   */
  function attach(mount) {
    const lamp = {
      mount,
      uApex: uniform(new THREE.Vector3()),
      uAxis: uniform(new THREE.Vector3(0, 0, 1)),
      uGlare: uniform(0),
      mesh: null,
      glare: null,
    };

    const mat = new THREE.MeshBasicNodeMaterial();
    const scattered = buildBeamNode(lamp);
    mat.colorNode = scattered;
    mat.transparent = true;
    mat.depthWrite = false;
    /**
     * No hardware depth test: the chord is already clipped against `sceneT`, so
     * occlusion is handled analytically and correctly for every fragment. Left
     * on, the hull's back face would be depth-culled by the road it points at
     * and the beam would disappear exactly where it should be brightest.
     */
    mat.depthTest = false;
    /** Back faces, so the hull covers the beam's footprint from inside it too. */
    mat.side = THREE.BackSide;
    mat.blending = THREE.AdditiveBlending;
    mat.fog = false;
    decorate?.(mat, "beam", scattered);

    lamp.mesh = new THREE.Mesh(hullGeo, mat);
    lamp.mesh.frustumCulled = true;
    lamp.mesh.renderOrder = 8;
    mount.add(lamp.mesh);

    lamp.glare = new THREE.Sprite(buildGlareMaterial(lamp.uGlare));
    lamp.glare.scale.setScalar(params.glareSize);
    lamp.glare.renderOrder = 9;
    lamp.glare.visible = params.glare;
    mount.add(lamp.glare);

    lamps.push(lamp);
    return lamp;
  }

  function applyParams() {
    const inner = params.angle * (1 - Math.min(0.98, params.penumbra));
    u.cosOuter.value = Math.cos(params.angle);
    u.cosInner.value = Math.cos(inner);
    u.range.value = params.range;
    u.rangeFadeAt.value = params.range * params.rangeFade;
    u.nearFade.value = Math.max(0.01, params.nearFade);
    u.fallRef.value = Math.max(0.1, params.falloffRef);
    u.color.value.set(params.color);
    u.intensity.value = params.intensity;
    u.media.value = params.media;
    u.g.value = THREE.MathUtils.clamp(params.anisotropy, -0.95, 0.95);
    u.phaseMix.value = params.phaseMix;
    u.noise.value = params.noise;
    u.noiseScale.value = params.noiseScale;
    u.steps.value = Math.min(MAX_STEPS, Math.max(4, Math.round(params.steps)));

    for (const l of lamps) {
      l.glare.scale.setScalar(params.glareSize);
      l.glare.visible = params.glare;
    }
  }

  /** Rebuild the rasterisation hull. Only `angle`, `range` and `hullSpread`. */
  function rebuildHull() {
    const next = buildHull(params);
    for (const l of lamps) l.mesh.geometry = next;
    hullGeo.dispose();
    hullGeo = next;
  }

  const _toCam = new THREE.Vector3();

  function update(dt, camera) {
    time += dt * params.noiseSpeed;
    u.time.value = time;

    for (const l of lamps) {
      l.mount.updateWorldMatrix(true, false);
      l.uApex.value.setFromMatrixPosition(l.mount.matrixWorld);
      l.uAxis.value.set(0, 0, 1).transformDirection(l.mount.matrixWorld);

      /**
       * Half-lambert on the head-on term rather than a raw clamp: a real lens is
       * still bright from three-quarters on and dark only from directly behind,
       * where the housing is in the way. A raw `max(0, facing)` snaps to nothing
       * the instant you pass 90°, which reads as the flare being switched off.
       */
      _toCam.copy(camera.position).sub(l.uApex.value).normalize();
      const facing = _toCam.dot(l.uAxis.value) * 0.5 + 0.5;
      const amt = Math.pow(facing, params.glareFalloff) * params.glareIntensity;
      l.uGlare.value = amt;
      l.glare.scale.setScalar(params.glareSize * (0.6 + 0.4 * Math.min(1, amt)));
    }
  }

  /**
   * The scattering only. The glare is a SEPARATE layer (`params.glare`) and
   * stays where it was: on a chase camera the lens flare is most of the read and
   * the beam is nearly invisible, so the two have to be switchable apart —
   * which is also how they will want to be tiered in the game.
   */
  function setEnabled(on) {
    for (const l of lamps) l.mesh.visible = on;
  }

  function dispose() {
    for (const l of lamps) {
      l.mesh.removeFromParent();
      l.mesh.material.dispose();
      l.glare.removeFromParent();
      l.glare.material.dispose();
    }
    lamps.length = 0;
    hullGeo.dispose();
  }

  applyParams();

  return {
    params, uniforms: u, lamps,
    attach, applyParams, rebuildHull, update, setEnabled, dispose,
    get maxSteps() { return MAX_STEPS; },
  };
}
