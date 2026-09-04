/**
 * Cloud shadow map — the clouds cast onto the world, instead of onto themselves only.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, given `modularRoadClouds.js` already darkens the ground.
 *
 * The existing ground darkening (`shadowFactor` in the cloud module) is a SCREEN-SPACE
 * trick: for each visible pixel it reconstructs a world position from the depth buffer,
 * walks to the middle of the cloud slab along the sun, and takes ONE density sample. It
 * is cheap and it was the right call for what it does, but it has three limits that are
 * structural rather than tuneable:
 *
 *   1. One sample at mid-slab is not an optical depth. A 600 m tower and a 40 m wisp both
 *      resolve to "whatever the density is at the halfway height", so shadow darkness has
 *      no relation to how much cloud is actually overhead. Real cloud shadows are
 *      bimodal — near-black under a core, barely there under a skirt — and that contrast
 *      is most of what reads as "clouds are real objects with volume".
 *   2. It only exists where the depth buffer does. Nothing off-screen is shadowed, so
 *      anything sampling the world from elsewhere — an environment probe, a reflection,
 *      a shadow-receiving surface behind the camera — sees an unshadowed world.
 *   3. It multiplies the FINAL composited colour, so it darkens the sky showing through a
 *      gap exactly as much as it darkens the road.
 *
 * This map is the other shape of the same idea: march the sun ray properly, once per
 * texel of a world-space footprint, and let any shader ask "how much sun reaches this
 * world point". It costs one small pass (512² by default) regardless of screen resolution
 * or how many things want to read it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE PROJECTION IS THE WHOLE TRICK, AND IT IS EXACT.
 *
 * The cloud deck is a horizontal slab and the sun is directional, so the shadow a point
 * receives depends only on where its sun ray crosses that slab — and every point whose
 * sun ray crosses the same place receives the same shadow. Sliding each point down its
 * own sun ray to the y = 0 plane therefore collapses the whole 3D problem onto a 2D map
 * with NO approximation:
 *
 *     ground hit = p - sunDir * (p.y / sunDir.y)
 *
 * That is why this is a flat top-down texture and not a cascade or a shadow volume, and
 * why a point 300 m up inside the deck reads it as correctly as a point on the road. The
 * only thing the map cannot represent is a second cloud layer at a different altitude
 * (each layer would want its own), which is a limit worth knowing before adding cirrus.
 *
 * TEXEL SNAPPING. The footprint follows the camera, so without snapping the map would
 * resample onto a different grid every frame and every shadow edge in the world would
 * crawl and shimmer — the classic moving-shadow-map artefact, and far more visible here
 * than in a normal shadow map because cloud shadows are enormous and soft. The origin is
 * quantised to whole texels, so the footprint moves in texel jumps and the pattern on the
 * ground stays put.
 *
 * @see modularRoadClouds.js — `field`, the density recipe this marches (one source of truth)
 * @see skyProLab.js — the harness that shows it against a lit ground
 */
import * as THREE from "three/webgpu";
import {
  float, vec2, vec3, vec4, Fn, If, Loop, Break, uniform, uv, texture,
  max, min, exp, saturate, smoothstep,
} from "three/tsl";

/** TSL `Loop` compiles to a fixed trip count; the runtime `steps` uniform cuts it short. */
const MAX_STEPS = 32;

export const CLOUD_SHADOW_DEFAULTS = {
  enabled: true,
  /** Map resolution. 512 over a 4 km footprint is ~8 m per texel — finer than the base
   *  cloud voxel, so the limit is the cloud shape, not the map. */
  resolution: 512,
  /** World size of the footprint, metres. Must comfortably exceed the view distance, or
   *  distant ground walks out of the map and pops to unshadowed. */
  size: 4200,
  /** Steps through the slab. The slab is crossed once, so this is far cheaper than it
   *  looks: 16 steps over a 620 m deck is ~39 m each, and a shadow does not need detail
   *  the map's own texels cannot hold. */
  steps: 16,
  /** Extinction along the sun ray. Matches the cloud light march's `lightAbsorb` by
   *  default so a shadow is as dark as the cloud that casts it looks thick. */
  absorb: 1.7,
  /** How dark a fully-occluded point gets. 1 = physically black under a core, which is
   *  too much once ambient sky light is already in the frame; this is the artistic dial. */
  strength: 0.52,
  /** Extra softening, in texels, applied when the map is READ. Cloud shadows are soft
   *  because the sun is a half-degree disc and the caster is kilometres up; a hard 8 m
   *  texel edge on the road reads as a decal. */
  softness: 2.2,
  /** Tint the shadowed ground drifts toward — what is left when the sun is blocked is
   *  sky light, which is blue. Pure darkening reads as dirt; this reads as shade. */
  skyTint: [0.62, 0.72, 0.92],
  /** Rebuild every N frames. The deck drifts at ~6 m/s, so a 2-frame cadence is
   *  imperceptible and halves the cost. */
  interval: 2,
};

/**
 * @param {object}   opts
 * @param {THREE.WebGPURenderer} opts.renderer
 * @param {object}   opts.field   `clouds.field` — the published density recipe
 * @param {object}  [opts.params]
 */
export function createCloudShadowMap({ renderer, field, params = {} }) {
  const P = { ...CLOUD_SHADOW_DEFAULTS, ...params };

  const rt = new THREE.RenderTarget(P.resolution, P.resolution, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    // CLAMP, not repeat: past the footprint the answer must be "no shadow", and a
    // repeating map would instead tile the sky's cloud pattern out to the horizon.
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
  });
  rt.texture.generateMipmaps = false;

  const shadowTex = texture(rt.texture);

  // ── Uniforms ───────────────────────────────────────────────────────────────────────
  /** Snapped centre of the footprint, world XZ. */
  const uOrigin = uniform(new THREE.Vector2());
  const uSize = uniform(P.size);
  const uInvSize = uniform(1 / P.size);
  const uSteps = uniform(Math.min(P.steps, MAX_STEPS));
  const uAbsorb = uniform(P.absorb);
  const uStrength = uniform(P.strength);
  const uSoftness = uniform(P.softness);
  const uTexel = uniform(1 / P.resolution);
  const uSkyTint = uniform(new THREE.Vector3(...P.skyTint));
  /** Sun direction with its Y floored — see the bake for why. */
  const uSunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.3).normalize());
  /** 0 while the cloud bake is still in flight, so the world is not shadowed by nothing. */
  const uActive = uniform(0);

  const { sampleDensityCheap, uBase, uThickness } = field;

  // ── Bake ───────────────────────────────────────────────────────────────────────────
  const bakeScene = new THREE.Scene();
  const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bakeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  bakeScene.add(bakeQuad);

  const bakeMat = new THREE.MeshBasicNodeMaterial();
  bakeMat.depthTest = false;
  bakeMat.depthWrite = false;
  bakeMat.fog = false;

  bakeMat.colorNode = Fn(() => {
    // Render targets read back Y-flipped versus `uv()` on a bake quad. Getting this wrong
    // mirrors the shadow pattern against the clouds that cast it — which looks plausible
    // in a still and is obviously wrong the moment the wind moves them.
    const buv = vec2(uv().x, uv().y.oneMinus());

    // Texel → world point on the y = 0 plane.
    const g = vec3(
      buv.x.sub(0.5).mul(uSize).add(uOrigin.x),
      float(0.0),
      buv.y.sub(0.5).mul(uSize).add(uOrigin.y),
    );

    // Sun ray from there up through the slab. The Y floor matters: as the sun sets,
    // 1/sunDir.y runs away and the slab crossing becomes a horizontal traverse hundreds
    // of kilometres long, so the march samples nonsense at enormous step sizes. Flooring
    // it holds the geometry sane; the shadow is faded out separately by elevation.
    const sy = max(uSunDir.y, float(0.12));
    const dir = vec3(uSunDir.x, sy, uSunDir.z);

    const t0 = uBase.div(sy);
    const t1 = uBase.add(uThickness).div(sy);
    const stepLen = t1.sub(t0).div(uSteps);

    const tau = float(0.0).toVar();
    Loop(MAX_STEPS, ({ i }) => {
      If(float(i).greaterThanEqual(uSteps), () => Break());
      const t = t0.add(stepLen.mul(float(i).add(0.5)));
      tau.addAssign(sampleDensityCheap(g.add(dir.mul(t))));
    });

    const transmittance = exp(tau.mul(stepLen).mul(uAbsorb).negate());
    return vec4(vec3(transmittance), 1.0);
  })();

  bakeQuad.material = bakeMat;

  // ── Read ───────────────────────────────────────────────────────────────────────────

  /**
   * Sun visibility at a world point, 0 (fully shadowed) → 1 (full sun).
   *
   * @param {*} p world position node
   */
  const transmittanceAt = Fn(([p]) => {
    const sy = max(uSunDir.y, float(0.12));
    // Slide the point down its own sun ray to y = 0 — exact for a horizontal slab.
    const gx = p.x.sub(uSunDir.x.div(sy).mul(p.y));
    const gz = p.z.sub(uSunDir.z.div(sy).mul(p.y));
    // NO FLIP HERE, deliberately — the bake already carries it. Render targets read back
    // Y-flipped versus `uv()` on a bake quad (the same trap `modularRoadSkyAtmosphere.js`
    // documents at `bakeUv`), so the flip belongs on exactly one side. Adding it here as
    // well double-flips: measured from directly above with the wind stopped, the shadow
    // blob sat most of a footprint away from the cloud casting it.
    const q = vec2(
      gx.sub(uOrigin.x).mul(uInvSize).add(0.5),
      gz.sub(uOrigin.y).mul(uInvSize).add(0.5),
    );

    // 5-tap soft read. A single bilinear tap gives the map's own texel grid away on any
    // large flat surface — you can see the 8 m squares. Four diagonal taps at a texel
    // scale cost four samples of a tiny texture and remove it.
    //
    // SAMPLED IN UNIFORM CONTROL FLOW, deliberately. These reads used to sit inside an
    // `If (active)` block, with the whole lookup skipped when the map was off — which is
    // the obvious way to write it and produces a fragment shader that silently returns
    // garbage. `textureSample` picks its mip from screen-space derivatives, and WGSL only
    // defines those in uniform control flow; inside a conditional the result is undefined,
    // and on this driver it came back as a flat zero, i.e. every shaded surface inside the
    // map's footprint went fully shadowed while the map itself was 95% white. Gate the
    // RESULT with a mix, never the sample.
    const r = uTexel.mul(uSoftness);
    const t = shadowTex.sample(q).r
      .add(shadowTex.sample(q.add(vec2(r, r))).r)
      .add(shadowTex.sample(q.add(vec2(r.negate(), r))).r)
      .add(shadowTex.sample(q.add(vec2(r, r.negate()))).r)
      .add(shadowTex.sample(q.add(vec2(r.negate(), r.negate()))).r)
      .mul(1.0 / 5.0);

    // Fade out at the footprint edge, or distant ground steps from shadowed to lit at a
    // hard line across the world.
    const edge = min(
      smoothstep(0.0, 0.06, min(q.x, q.y)),
      smoothstep(0.0, 0.06, min(q.x.oneMinus(), q.y.oneMinus())),
    );
    // Nothing above the deck is shadowed by it, and a point inside the deck is only
    // partly shadowed — the cloud above it is thinner than the whole slab.
    const below = smoothstep(uBase.add(uThickness), uBase, p.y);
    // Grazing sun: the geometry stops being trustworthy (see the Y floor) and real
    // shadows dissolve into the general dimness of dusk anyway.
    const elev = smoothstep(0.04, 0.18, uSunDir.y);

    const mask = edge.mul(below).mul(elev).mul(uActive);
    return saturate(t).mix(float(1.0), mask.oneMinus());
  });

  /**
   * Ready-to-multiply lighting factor: darkens toward sky-blue rather than toward black.
   *
   * Handed to a material's `outputNode`. Attenuating the whole shaded colour (rather than
   * the sun term alone) is a deliberate approximation — the honest version needs the
   * light loop — but it is the right SHAPE, because a surface under cloud really does
   * lose both its key light and a chunk of its sky dome, and it keeps the one thing that
   * matters visually: shaded ground goes cooler, not just darker.
   */
  const shadeFactor = Fn(([p]) => {
    const t = transmittanceAt(p);
    const lit = float(1.0).sub(uStrength.mul(t.oneMinus()));
    return uSkyTint.mix(vec3(1.0), t).mul(lit);
  });

  // ── Drive ──────────────────────────────────────────────────────────────────────────
  let frame = 0;
  const _prevRT = { rt: null };

  /**
   * @param {THREE.Vector3} cameraPos
   * @param {THREE.Vector3} sunDir
   * @param {boolean} ready  cloud volumes baked?
   */
  function update(cameraPos, sunDir, ready = true) {
    uActive.value = P.enabled && ready ? 1 : 0;
    if (!P.enabled || !ready) return;

    uSunDir.value.copy(sunDir).normalize();
    uSize.value = P.size;
    uInvSize.value = 1 / P.size;
    uSteps.value = Math.min(P.steps, MAX_STEPS);
    uAbsorb.value = P.absorb;
    uStrength.value = P.strength;
    uSoftness.value = P.softness;

    // Snap to whole texels so the pattern on the ground does not crawl as the camera
    // moves. Quantising in world units (not in texels-since-origin) keeps the grid
    // absolute, which is what makes it stationary.
    const texelM = P.size / P.resolution;
    uOrigin.value.set(
      Math.round(cameraPos.x / texelM) * texelM,
      Math.round(cameraPos.z / texelM) * texelM,
    );

    if (frame++ % Math.max(1, P.interval) !== 0) return;

    _prevRT.rt = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(bakeScene, bakeCam);
    renderer.setRenderTarget(_prevRT.rt);
  }

  function dispose() {
    rt.dispose();
    bakeMat.dispose();
    bakeQuad.geometry.dispose();
  }

  return {
    params: P,
    /** float node: 1 = full sun, 0 = fully shadowed. */
    transmittanceAt,
    /** vec3 node: multiply a shaded colour by this. */
    shadeFactor,
    update,
    dispose,
    texture: rt.texture,
    uniforms: { uOrigin, uSize, uStrength, uActive },
    _debug: { rt },
  };
}
