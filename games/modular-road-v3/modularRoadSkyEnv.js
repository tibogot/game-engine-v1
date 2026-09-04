/**
 * Sky + cloud environment probe — the world lit BY the sky it is standing under.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADDS OVER THE EXISTING SKY-ONLY PROBE.
 *
 * `skyLab.js` already convolves the atmosphere into an IBL, and deliberately hides the
 * cloud mesh while it does it (`const hide = [track, car, grid, clouds.mesh]`). That was
 * the only option available: the volumetric deck is not a mesh that can be rendered from
 * an arbitrary camera — it is a screen-space march that reads the main view's depth
 * buffer, so pointing a cube camera at it produces garbage or nothing.
 *
 * The consequence is that the world is lit by a CLOUDLESS sky no matter what is overhead.
 * Stand under a solid overcast deck and the ground still receives a clean blue-and-sun
 * dome; every surface in the frame quietly disagrees with the sky above it. That mismatch
 * is subtle per-pixel and enormous in aggregate, because it applies to the whole image
 * rather than to one object — it is a large part of why a good cloud renderer can still
 * leave a scene looking like a backdrop with things in front of it.
 *
 * The fix is not to render the deck into the probe, but to march the SAME density field
 * from the probe's own rays. `clouds.field` publishes that recipe precisely so a second
 * consumer cannot drift from the first.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THE MARCH HERE IS ALLOWED TO BE CRUDE.
 *
 * A probe's output is convolved by PMREM into something that is, for the diffuse term,
 * essentially a handful of spherical harmonics. Detail is destroyed by construction. So
 * this pass uses the cheap base-shape density (no erosion octaves), a 3-tap light march,
 * and ~28 steps at 128² per face — and none of that is visible, because nothing survives
 * the convolution except the LOW frequencies, which is exactly what it gets right:
 * overcast reads dim and grey-blue, broken cloud reads bright with a warm sun side, and a
 * clear sky reads as it always did.
 *
 * The faces are baked ONE PER FRAME (six frames per refresh, then a convolve). A probe
 * that rebuilt every frame would cost more than the clouds it is describing, and the
 * quantity it carries — the average colour of the sky — changes on the timescale of
 * weather and time of day, not of frames.
 *
 * @see modularRoadClouds.js — `field`, the density recipe (one source of truth)
 * @see modularRoadSkyAtmosphere.js — `skyRadiance`, the sky this convolves
 */
import * as THREE from "three/webgpu";
import {
  float, vec3, vec4, Fn, If, Loop, Break, uniform, positionWorld,
  normalize, dot, max, min, exp, saturate, pow,
} from "three/tsl";

const MAX_STEPS = 48;
const MAX_LIGHT_STEPS = 3;

export const SKY_ENV_DEFAULTS = {
  enabled: true,
  /** Cube face resolution. This is convolved into an irradiance basis, so it is already
   *  far more than the diffuse term can use; it exists for the low-roughness reflections. */
  resolution: 128,
  /** Include the cloud deck in the probe. Off = the old sky-only behaviour, kept as the
   *  A/B: it is the single clearest demonstration of what environment lighting is doing. */
  clouds: true,
  /** View-ray steps through the slab. */
  steps: 28,
  /** Taps toward the sun per sample. */
  lightSteps: 3,
  /** Metres the light march reaches. */
  lightConeLength: 260,
  /** Extinction along the light ray. */
  lightAbsorb: 1.7,
  /** How far a probe ray travels before it gives up, metres. */
  maxDist: 9000,
  /** Sun energy into the probe's clouds — matched to the view march's `sunIntensity`. */
  sunIntensity: 3.2,
  /** Sky energy into the probe's clouds. */
  ambientIntensity: 0.5,
  /** Multiplier on the final IBL. */
  intensity: 1.0,
  /** Frames between refresh cycles (a cycle is 6 face bakes + 1 convolve). */
  interval: 4,
};

/**
 * @param {object} opts
 * @param {THREE.WebGPURenderer} opts.renderer
 * @param {THREE.Scene} opts.scene         the scene whose `.environment` is set
 * @param {object} opts.atmosphere         `createSkyAtmosphere()` handle
 * @param {object} opts.field              `clouds.field`
 * @param {object} [opts.params]
 */
export function createSkyCloudEnv({ renderer, scene, atmosphere, field, params = {} }) {
  const P = { ...SKY_ENV_DEFAULTS, ...params };

  const {
    sampleDensityCheapW, sampleWeather, uBase, uThickness,
  } = field;

  // ── Uniforms ───────────────────────────────────────────────────────────────────────
  /** Where the probe is standing. The cloud field is world-space, so a probe baked at the
   *  origin while the camera is 2 km away describes somebody else's sky. */
  const uProbePos = uniform(new THREE.Vector3());
  const uSunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.3).normalize());
  const uSunColor = uniform(new THREE.Color(0xfff2dc));
  const uSkyAmbient = uniform(new THREE.Color(0x9fc0e8));
  const uSteps = uniform(P.steps);
  const uLightSteps = uniform(P.lightSteps);
  const uLightCone = uniform(P.lightConeLength);
  const uLightAbsorb = uniform(P.lightAbsorb);
  const uMaxDist = uniform(P.maxDist);
  const uSunIntensity = uniform(P.sunIntensity);
  const uAmbIntensity = uniform(P.ambientIntensity);
  /** 0 until the cloud volumes land, so the probe is not darkened by an empty field. */
  const uCloudsOn = uniform(0);

  // ── Probe dome ─────────────────────────────────────────────────────────────────────
  // Its own scene: the main scene cannot be reused because everything in it (ground, car,
  // track) would occlude the probe, and hiding them per face is the bookkeeping this
  // module exists to avoid.
  const probeScene = new THREE.Scene();

  const probeMat = new THREE.MeshBasicNodeMaterial();
  probeMat.side = THREE.BackSide;
  probeMat.depthWrite = false;
  probeMat.depthTest = false;
  probeMat.fog = false;

  /** Cheap sun-side scattering for one sample. Isotropic plus a soft forward bias — a
   *  full dual-lobe phase is wasted on something about to be spherical-harmonic'd. */
  const lightAt = Fn(([p, wm]) => {
    const tau = float(0.0).toVar();
    const unit = uLightCone.div(float(MAX_LIGHT_STEPS));
    Loop(MAX_LIGHT_STEPS, ({ i }) => {
      If(float(i).greaterThanEqual(uLightSteps), () => Break());
      const dist = unit.mul(float(i).add(0.7));
      tau.addAssign(sampleDensityCheapW(p.add(uSunDir.mul(dist)), wm).mul(dist));
    });
    return exp(tau.mul(uLightAbsorb).negate());
  });

  probeMat.colorNode = Fn(() => {
    const dir = normalize(positionWorld);
    const sky = atmosphere.skyRadiance(dir).toVar();

    If(uCloudsOn.greaterThan(0.001), () => {
      const py = uProbePos.y;
      const dy = dir.y;

      // Slab crossing. Guard the near-horizontal case: at |dy| < 1e-3 the crossing is
      // hundreds of kilometres and the march degenerates into 28 samples of the same
      // voxel smeared across the horizon — a bright band that the convolution then bakes
      // into the ambient. Skipping it costs one grazing ring of a 128px face.
      If(dy.abs().greaterThan(0.001), () => {
        const tA = uBase.sub(py).div(dy);
        const tB = uBase.add(uThickness).sub(py).div(dy);
        const t0 = max(min(tA, tB), float(0.0));
        const t1 = min(max(tA, tB), uMaxDist);

        If(t1.greaterThan(t0), () => {
          const stepLen = t1.sub(t0).div(uSteps);
          const trans = float(1.0).toVar();
          const scatter = vec3(0.0).toVar();

          // Forward-scattering bias, flattened: the sun's own disc is handled by the sky
          // term, and a sharp phase peak here would put a hot spot into the irradiance.
          const mu = saturate(dot(dir, uSunDir));
          const phase = float(0.55).add(pow(mu, float(4.0)).mul(0.85));

          Loop(MAX_STEPS, ({ i }) => {
            If(float(i).greaterThanEqual(uSteps), () => Break());
            If(trans.lessThan(0.01), () => Break());

            const p = uProbePos.add(dir.mul(t0.add(stepLen.mul(float(i).add(0.5)))));
            const wm = sampleWeather(p);
            const d = sampleDensityCheapW(p, wm);

            If(d.greaterThan(0.0001), () => {
              const a = float(1.0).sub(exp(d.mul(stepLen).negate()));
              const lum = uSunColor.mul(uSunIntensity).mul(lightAt(p, wm)).mul(phase)
                .add(uSkyAmbient.mul(uAmbIntensity));
              scatter.addAssign(trans.mul(a).mul(lum));
              trans.mulAssign(float(1.0).sub(a));
            });
          });

          sky.assign(scatter.add(sky.mul(trans)));
        });
      });
    });

    return vec4(sky, 1.0);
  })();

  const probeDome = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), probeMat);
  probeDome.frustumCulled = false;
  probeScene.add(probeDome);

  // ── Cube capture + convolution ─────────────────────────────────────────────────────
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cubeRT = new THREE.CubeRenderTarget(P.resolution, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.1, 20000, cubeRT);
  cubeCam.updateMatrixWorld(true);
  let envRT = null;

  /** -1 = idle, 0..5 = the face to bake next. */
  let face = -1;
  let needs = true;
  let frame = 0;

  function bakeFace(i) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(cubeRT, i);
    renderer.render(probeScene, cubeCam.children[i]);
    renderer.setRenderTarget(prev);
  }

  function convolve() {
    try {
      envRT = pmrem.fromCubemap(cubeRT.texture, envRT);
      scene.environment = envRT.texture;
      scene.environmentIntensity = P.intensity;
    } catch (err) {
      console.warn("[SkyEnv] PMREM bake failed; IBL disabled.", err);
    }
  }

  /** Force a refresh — call when the sun, the weather or the deck changes materially. */
  function invalidate() { needs = true; }

  /**
   * @param {THREE.Vector3} probePos   usually the camera position
   * @param {object} look              { sunDir, sunColor, skyAmbient }
   * @param {boolean} cloudsReady
   */
  function update(probePos, look, cloudsReady = true) {
    if (!P.enabled) return;

    uProbePos.value.copy(probePos);
    if (look?.sunDir) uSunDir.value.copy(look.sunDir).normalize();
    if (look?.sunColor) uSunColor.value.set(look.sunColor);
    if (look?.skyAmbient) uSkyAmbient.value.set(look.skyAmbient);
    uCloudsOn.value = P.clouds && cloudsReady ? 1 : 0;
    uSteps.value = Math.min(P.steps, MAX_STEPS);
    uLightSteps.value = Math.min(P.lightSteps, MAX_LIGHT_STEPS);
    uLightCone.value = P.lightConeLength;
    uLightAbsorb.value = P.lightAbsorb;
    uSunIntensity.value = P.sunIntensity;
    uAmbIntensity.value = P.ambientIntensity;
    if (scene.environment) scene.environmentIntensity = P.intensity;

    // A cycle in flight always finishes: convolving three fresh faces and three stale
    // ones puts a seam in the irradiance that survives until the next full cycle.
    if (face >= 0) {
      bakeFace(face);
      face++;
      if (face >= 6) { convolve(); face = -1; needs = false; }
      return;
    }

    frame++;
    if (needs || frame % Math.max(1, P.interval * 6) === 0) face = 0;
  }

  function dispose() {
    probeMat.dispose();
    probeDome.geometry.dispose();
    cubeRT.dispose();
    envRT?.dispose();
    pmrem.dispose();
  }

  return {
    params: P,
    update,
    invalidate,
    dispose,
    get environment() { return envRT?.texture ?? null; },
    _debug: { cubeRT, probeScene, probeMat },
  };
}
