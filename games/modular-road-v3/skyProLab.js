/**
 * Sky Pro lab — the sky, the deck, and the two things that make a cloud renderer look
 * like weather instead of like a backdrop.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY A THIRD SKY/CLOUD LAB.
 *
 * `cloud-lab.html` judges the MARCH: free-fly, four viewpoints, GPU cost on screen. It
 * deliberately has no engine, no terrain and no post — and to keep it that way it lights
 * nothing (the ground is `MeshBasicNodeMaterial`, the sky is a hand-written gradient).
 * `sky-lab.html` judges the ATMOSPHERE across the day, with an IBL that explicitly hides
 * the cloud mesh while it bakes.
 *
 * Both are right about their own question and both are blind to the same thing: what the
 * clouds do to everything that is NOT the clouds. Comparing our deck against a reference
 * renderer, that turned out to be most of the gap — the march itself is a peer (half-res
 * temporal reconstruction, cone light march, multi-scatter octaves, powder, adaptive
 * stepping), but ours was being judged against a fake gradient over an unlit plane, and
 * theirs against a lit world that receives the sky.
 *
 * So this lab exists to hold three things in one frame:
 *
 *   1. the physical atmosphere (`modularRoadSkyAtmosphere.js`),
 *   2. the volumetric deck (`modularRoadClouds.js`),
 *   3. a LIT WORLD underneath both — terrain, pillars, metal, wet asphalt —
 *
 * and to A/B the two new couplings between them, because their contribution is invisible
 * until you can switch them off:
 *
 *   • CLOUD SHADOWS (`modularRoadCloudShadowMap.js`) — a proper sun-ray march projected
 *     onto the world, rather than the existing one-sample screen-space darkening.
 *   • CLOUDS IN THE ENVIRONMENT (`modularRoadSkyEnv.js`) — the IBL that lights every
 *     surface knows there is an overcast overhead.
 *
 * Toggle either off (keys `X` and `V`, or the panel) and the frame goes back to looking
 * like a good cloud renderer pasted over a scene. That comparison IS the lab.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * NOT A GAME PATH. Nothing here is wired into `roadGame.js`. The two new modules are
 * written to be liftable, but the decision about what they cost in a frame that also has
 * a car, a track, props and post-FX belongs to a measurement in the game, not here.
 */
import * as THREE from "three/webgpu";
import {
  Fn, vec3, vec4, uv, positionWorld, cameraPosition, output, uniform, texture,
} from "three/tsl";
import { createModularRoadSky, applyTimePreset } from "./modularRoadSky.js";
import { createModularRoadClouds, CLOUD_LAYER } from "./modularRoadClouds.js";
import { createSkyAtmosphere } from "./modularRoadSkyAtmosphere.js";
import { createCloudShadowMap } from "./modularRoadCloudShadowMap.js";
import { createSkyCloudEnv } from "./modularRoadSkyEnv.js";

/**
 * Deck presets. The hero deck is what a reference demo shows — high, thick, viewed from
 * the ground. The apex deck is what this game actually needs: low enough that a sky track
 * at 40 m can be driven INTO it. They look different for a real reason, and a lab that
 * only ever shows one of them will tune the wrong one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY BOTH CARRY LIGHTING OVERRIDES — the first thing this lab found.
 *
 * `CLOUD_DEFAULTS.sunIntensity` is 3.2, and it is right for what it was tuned against:
 * `cloud-lab.html`, whose sky is a hand-written gradient and whose exposure is a fixed
 * 1.0. Put the same deck under the physical atmosphere, where `evaluateSky` drives
 * `toneMappingExposure` (0.92 at golden hour) and the sun colour arrives as a real
 * radiance, and the cloud's lit term lands around 1.7–3.2 BEFORE tone mapping. ACES
 * compresses everything above ~1 into the last sliver of the curve, so a 900 m tower and
 * its own wispy skirt resolve to the same cream — the shading is all still being computed,
 * and all of it is being thrown away by the tone curve.
 *
 * The symptom is the one that started this whole comparison: flat, papery clouds. It is
 * not a missing feature and it is not the march. Measured here by walking the intensity
 * down until form reappeared — at 3.2 the deck is a solid cutout, at 1.7 the billows
 * start to separate. Nothing about the geometry changed.
 *
 * (Where the intensity lands is a SECOND question, and the first answer was wrong — see
 * the ratio note below. Getting under the clip is necessary; getting the sun-to-sky ratio
 * right is what actually produces form.)
 *
 * Left as lab-local overrides rather than a change to CLOUD_DEFAULTS: the game's own
 * exposure path is not this one, so rebalancing the shipped defaults is a decision that
 * belongs to a measurement in the game.
 */
const CLOUD_LIGHT_UNDER_PHYSICAL_SKY = {
  /*
   * THE RATIO IS THE LOOK, and the first pass here had it backwards.
   *
   * Chasing the clipping above, the obvious move was to pull the sun down and push the
   * sky fill up until nothing blew out — which lands at sun 1.05 / ambient 1.15, i.e. the
   * SKY term larger than the SUN term. That is a flat white cloud by construction: the
   * light march can compute all the self-shadowing it likes and a bigger, direction-free
   * fill light paints straight over it. It is the same mistake as lighting a model with a
   * huge ambient and wondering why it has no form.
   *
   * Cumulus reads as a solid object because it is sun-dominated: a near-white lit crown,
   * a base carrying only sky light, and the whole tonal range in between. That wants the
   * sun several times the fill — 1.8 against 0.62 here.
   *
   * The fill has a FLOOR as well as a ceiling, and it is set from the hardest view rather
   * than the flattering one. At 0.30 the lit side is superb and the shaded side goes
   * NAVY, because the fill's colour is the sky zenith and a small amount of blue is just
   * dark blue — turn the camera around and the clouds are cut-out silhouettes. A real
   * shadow side is grey. 0.62 is the value where both sides hold: still ~3x sun-dominated,
   * still full form on the lit crown, and no navy when you look back toward the sun.
   */
  sunIntensity: 1.8,
  ambientIntensity: 0.62,
  /** Enough to keep deep interiors from going to black; not enough to flatten them. */
  msFloor: 0.18,
  /**
   * LOW ON PURPOSE. The powder term darkens LOW-density regions, which is exactly the
   * crown of a tall cloud — measured at 0.75 against a 680 m deck it turned every sunlit
   * top into a dark speckled cap, the opposite of what the term is for. It earns its keep
   * on dense edges, not on thin ones.
   */
  powder: 0.26,
  phaseG: 0.42,
};

const DECKS = {
  /**
   * PARTLY CLOUDY — aimed at the reference renderer's preset of that name, and the one
   * worth starting from, because it is the case our own presets were furthest from.
   *
   * Four things separate this from the deck the lab shipped with, and none of them is a
   * capability:
   *
   *   • ALTITUDE vs THICKNESS. The old hero deck was 900 m thick starting at 900 m — as
   *     tall as it was high, so from the ground every mass subtended an enormous angle and
   *     the sky was one connected ceiling. A cumulus layer is held HIGH and is shallower
   *     than it is wide (600 m at 1500 m), which is what lets a dozen separate clouds fit
   *     in the frame and shrink toward the horizon. That perspective convergence is most
   *     of what reads as scale. Thinner than this (420 was tried) buys separation at the
   *     cost of vertical development — the clouds go to pancakes.
   *   • COVERAGE. 0.36, not 0.5+. `coverage` is a threshold on the weather field, so this
   *     is honestly ~a third of the sky — discrete clouds with real blue between them.
   *   • DENSITY. Raised to 0.26 even though there is less cloud: a shallow layer has to be
   *     optically thick to read as white rather than as haze.
   *   • CUMULUS PROFILE. `typeBias` 0.80 — the cumulus height curve holds full density to
   *     0.8 of a cell's own height before eroding, which is what gives a flat base and a
   *     billowing crown instead of a lens.
   *   • MIDDAY SUN. The lab defaulted to golden hour, which tints every cloud warm cream.
   *     Fair-weather cumulus is neutral white with a grey base; that wants a high sun.
   *
   * `maxDist` goes to 14 km because the deck is now high enough that the interesting
   * clouds are far away — at the old 6 km the layer ended in mid-air short of the horizon.
   */
  partly: {
    base: 1500, thickness: 600, coverage: 0.36, densityMul: 0.26,
    cloudTopMin: 0.22, edgeTaper: 0.45, typeBias: 0.80, maxDist: 14000,
    /*
     * EDGE DETAIL, restored at range. `detailRange` fades the erosion octaves out with
     * distance because the march cannot resolve 14 m features at a 28 m step — correct,
     * and the reason it defaults to 1700 m. But the interesting clouds in this preset are
     * 3–5 km away, so at 1700 every one of them was a smooth blob: the cauliflower edge
     * that makes cumulus read as cumulus was being prefiltered away before it was ever
     * seen. `slabSamples` buys a ~23 m step here, which is enough to carry the detail out
     * to 5 km without the speckle coming back (checked — it does not).
     */
    detailRange: 5000, erode: 0.46, nearRange: 900, slabSamples: 26,
    // The deck's own aerial term is calibrated for a 2 km world ("past this the aerial
    // term has faded the clouds into haze anyway" — CLOUD_DEFAULTS.maxDist). At 0.00035
    // a cloud 4 km out keeps only exp(-1.4) = 25% of itself, which is why every distant
    // cumulus here was a ghost. Over a 14 km view that dial has to come down by ~4x.
    aerialDensity: 0.00008,
    lightConeLength: 200, lightAbsorb: 1.7,
    ...CLOUD_LIGHT_UNDER_PHYSICAL_SKY,
  },
  hero: {
    base: 900, thickness: 900, coverage: 0.5, densityMul: 0.15, cloudTopMin: 0.16,
    maxDist: 9000,
    // A 90 m light march (the default) cannot tell a 900 m tower from a 90 m wisp — it
    // runs out of cloud long before it runs out of thickness, so every mass reports the
    // same optical depth toward the sun. Scale the cone with the deck.
    lightConeLength: 420, lightAbsorb: 2.0,
    ...CLOUD_LIGHT_UNDER_PHYSICAL_SKY,
  },
  apex: {
    base: 260, thickness: 620, coverage: 0.90, densityMul: 0.16, cloudTopMin: 0.18,
    maxDist: 6000,
    lightConeLength: 160, lightAbsorb: 1.7,
    ...CLOUD_LIGHT_UNDER_PHYSICAL_SKY,
  },
  /**
   * SKY PRO — the reference renderer's own deck geometry and march numbers, on the
   * `solid` model (see the SOLID block in modularRoadClouds.js). Only meaningful when the
   * lab was booted with that model (`?model=solid`, the default): the Nubis shader
   * ignores every `solid*` key, and the solid shader ignores the Nubis shape keys.
   *
   * A 2.8 km-thick shell starting at 1.4 km is what makes towers possible: the top field
   * spans the whole shell, so a cell can be 200 m or 2 km tall. `maxDist` is the march
   * horizon, not a fade — the aerial term is what actually dissolves the far deck.
   */
  skypro: {
    model: "solid",
    base: 1400, thickness: 2800, maxDist: 40000, steps: 128,
    /*
     * TUNED 2026-09-05 against a screenshot of the reference at "Partly Cloudy 49%":
     *  - coverage 0.28, not the reference class default of 0.5: in this model the top
     *    field is `weather + bump·coverage + coverage - 1`, and the Worley bump averages
     *    ~0.75, so 0.5 put cloud under 85% of the sky (an overcast sheet). 0.28 is
     *    discrete masses with blue between, which is what the demo shows.
     *  - erosion 2.0/2.5 at 0.35x scale, not 1/1 at 0.5x: the channel weights are small
     *    (0.113/0.04/0.02) and at 1.0 the silhouettes were smooth blobs; this is where
     *    the cauliflower comes from.
     *  - light step 30 m, not the class default 400: at 400 the FIRST segment alone is
     *    optical depth 19 and the sun never reaches a lit surface — the whole deck went
     *    grey. The reference's shipped quality presets use 25.
     */
    solidDensity: 0.048, solidCoverage: 0.28, solidWeatherBias: 0.0,
    solidWeatherScale: 40000, solidBaseScale: 8000, solidErosionMul: 0.35,
    solidBaseStrength: 1.0, solidErodeBase: 2.0, solidErodePeak: 2.5,
    solidEdgeSoft: 0.05, solidEdgeFalloff: 1.0,
    solidStep: 50, solidConeAngle: 0.003, solidMaxOD: 0.5,
    solidLightStep: 30, solidLightSpread: 0.05, solidFullLightAlpha: 0.3,
    solidAlbedo: 0.9, solidPhaseFwd: 0.8, solidPhaseBack: 0.2, solidGroundBounce: 0.12,
    // 1.0 darkened every soft edge into a grey cap; the term earns its keep at 0.5.
    powder: 0.5,
    aerialDensity: 0.00002,
    /*
     * AN IRRADIANCE, NOT THE NUBIS DECK'S 1.8. This model's phases carry the 1/4pi and its
     * ambient is the sky radiance itself, so the sun has to be the physical ratio above the
     * sky: ~880 W/m2 of direct sun against ~40 W/m2/sr of sky is ~22x, and with the lab's
     * zenith around 0.4 that is ~9-10. At 1.8 the deck came out sky-blue and thin because
     * the fill outweighed the key.
     */
    sunIntensity: 16, ambientIntensity: 0.45,
  },
};

/** Which density model the deck was BUILT with — a construction-time choice. */
const MODEL = new URLSearchParams(location.search).get("model") === "nubis" ? "nubis" : "solid";

const VIEWPOINTS = {
  ground:  { pos: [0, 6, 300],    yaw: Math.PI, pitch: 0.16 },
  hills:   { pos: [-620, 120, 700], yaw: 2.42,  pitch: -0.04 },
  inside:  { pos: [0, 1200, 40],  yaw: Math.PI, pitch: 0.02 },
  above:   { pos: [0, 2100, 700], yaw: Math.PI, pitch: -0.34 },
};

/** Rolling ground — value-noise FBM. Terrain is not the point, but a FLAT plane is: a
 *  cloud shadow crossing a hillside is legible in a way that one crossing a billiard
 *  table is not, and a horizon with relief tells you whether aerial perspective works. */
function buildTerrain() {
  const SIZE = 9000;
  const SEG = 220;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const hash = (x, z) => {
    const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const value = (x, z) => {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = smooth(x - xi), zf = smooth(z - zi);
    return (
      hash(xi, zi) * (1 - xf) * (1 - zf) +
      hash(xi + 1, zi) * xf * (1 - zf) +
      hash(xi, zi + 1) * (1 - xf) * zf +
      hash(xi + 1, zi + 1) * xf * zf
    );
  };
  const fbm = (x, z) => {
    let a = 1, f = 1, s = 0, n = 0;
    for (let o = 0; o < 5; o++) { s += a * value(x * f, z * f); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  };

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    // A bowl that rises toward the horizon, so the camera sits in a valley and the
    // distant relief catches the light instead of the frame ending in a flat line.
    const r = Math.hypot(x, z) / (SIZE * 0.5);
    const ridge = fbm(x / 900, z / 900);
    const fine = fbm(x / 180, z / 180) - 0.5;
    pos.setY(i, ridge * 220 * (0.25 + r * 1.5) + fine * 22 - 40);
  }
  geo.computeVertexNormals();
  return geo;
}

export async function startSkyProLab() {
  const boot = document.getElementById("boot");
  const setBoot = (t) => { if (boot) boot.textContent = t; };

  // ── Device ─────────────────────────────────────────────────────────────────────────
  if (!navigator.gpu) throw new Error("WebGPU not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter({ featureLevel: "compatibility" });
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] });
  const hasTimestamps = device.features.has("timestamp-query");

  const renderer = new THREE.WebGPURenderer({
    antialias: true, device, trackTimestamp: hasTimestamps,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.5, 20000);

  // ── Sky ────────────────────────────────────────────────────────────────────────────
  const atmo = createSkyAtmosphere({ renderer });
  const sky = createModularRoadSky({ atmosphere: atmo });
  sky.setAtmosphereMix(1);
  scene.add(sky.mesh);
  const SP = sky.params;
  // The real deck owns the sky above the horizon; the analytic cloud sea would draw a
  // second, disagreeing layer when seen from above.
  SP.cloudSea = 0;
  applyTimePreset(SP, "day");

  // AERIAL PERSPECTIVE as the scene fog node, so every material picks it up without
  // per-material edits. The haze colour comes from the sky-view LUT (a texture, re-baked
  // when the sun moves) rather than a uniform — which sidesteps three-WebGPU's habit of
  // never refreshing fog uniforms on geometry that does not move.
  scene.fogNode = Fn(() => {
    const toCam = positionWorld.sub(cameraPosition);
    return vec4(
      atmo.applyAerialPerspective(output.rgb, toCam.normalize(), toCam.length()),
      output.a,
    );
  })();

  // ── Clouds ─────────────────────────────────────────────────────────────────────────
  const clouds = createModularRoadClouds({
    renderer, scene, camera, seed: 137,
    params: { enabled: true, ...(MODEL === "solid" ? DECKS.skypro : DECKS.partly), model: MODEL },
  });
  scene.add(clouds.mesh);

  const sBake = document.getElementById("s-bake");
  clouds.ready.then((r) => {
    if (!sBake) return;
    sBake.textContent = r.error ? "FAILED (console)" : `${Math.round(r.ms)} ms`;
    sBake.className = r.error ? "warn" : "good";
  });

  // ── The two couplings ──────────────────────────────────────────────────────────────
  const cloudShadow = createCloudShadowMap({ renderer, field: clouds.field });
  const skyEnv = createSkyCloudEnv({ renderer, scene, atmosphere: atmo, field: clouds.field });

  // ── Lights ─────────────────────────────────────────────────────────────────────────
  const hemi = new THREE.HemisphereLight(0x8eb0d0, 0x7ea8c4, 0.45);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.8);
  sun.position.set(200, 400, 180);
  scene.add(sun);
  scene.add(sun.target);

  // ── World ──────────────────────────────────────────────────────────────────────────
  /**
   * Cloud shadow goes on the ALBEDO, not on the final output.
   *
   * `outputNode` looks like the natural hook and is the wrong one here: three applies the
   * scene fog (our aerial perspective) BEFORE `output` is assigned, so multiplying there
   * would darken the haze in front of a surface as well as the surface — a shadowed
   * hillside two kilometres away would pull its own atmosphere dark with it, which reads
   * as a hole in the air. Modulating albedo happens before lighting and before the haze,
   * costs nothing extra, and attenuates the sun and sky terms together, which is what a
   * cloud overhead actually does.
   *
   * The one thing it does not attenuate is the specular/environment reflection — a wet
   * road under a cloud still mirrors the sky at full strength. That is arguably correct
   * (the cloud IS what it is reflecting) and is left alone deliberately.
   */
  function shaded(material, colorHex) {
    const base = uniform(new THREE.Color(colorHex));
    material.colorNode = Fn(() => base.mul(cloudShadow.shadeFactor(positionWorld)))();
    material.userData.baseColor = base;
    return material;
  }

  const terrainMat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.94, metalness: 0.0, envMapIntensity: 1.0,
  });
  shaded(terrainMat, 0x55603f);
  const terrain = new THREE.Mesh(buildTerrain(), terrainMat);
  terrain.receiveShadow = false;
  scene.add(terrain);

  // Verticals. Cloud shadows on a horizontal plane read as texture; the moment one climbs
  // a wall you can see it is a shadow and not a stain.
  const pillarMat = shaded(
    new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0.05 }), 0xb8b2a4,
  );
  const pillars = new THREE.Group();
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + 0.4;
    const r = 260 + ((i * 97) % 700);
    const h = 60 + ((i * 53) % 180);
    const m = new THREE.Mesh(new THREE.BoxGeometry(26, h, 26), pillarMat);
    m.position.set(Math.cos(a) * r, h * 0.5 - 30, Math.sin(a) * r);
    pillars.add(m);
  }
  scene.add(pillars);

  // Metal + wet: the two surfaces that show the ENVIRONMENT probe rather than the shadow.
  // A chrome sphere under a cloudless probe reflects blue no matter what is overhead —
  // which is exactly the tell the sky-only IBL leaves behind.
  const chrome = new THREE.Mesh(
    new THREE.SphereGeometry(30, 48, 32),
    new THREE.MeshStandardNodeMaterial({
      color: 0xc8cdd4, roughness: 0.08, metalness: 1.0, envMapIntensity: 1.6,
    }),
  );
  chrome.position.set(120, 20, 120);
  scene.add(chrome);

  const wetMat = new THREE.MeshPhysicalNodeMaterial({
    color: 0x2b2f35, roughness: 0.16, metalness: 0.02,
    clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.5,
  });
  const wet = new THREE.Mesh(new THREE.BoxGeometry(70, 1.2, 900), wetMat);
  wet.position.set(-90, -28, 0);
  scene.add(wet);

  // ── Shadow-map inspector ───────────────────────────────────────────────────────────
  // Rendered after the frame with autoClear off. Worth the twenty lines: when the shadows
  // look wrong, the only question that matters is whether the MAP is wrong or the LOOKUP
  // is, and there is no way to tell that from the ground.
  const inspectScene = new THREE.Scene();
  const inspectCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const inspectMat = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  inspectMat.fog = false;
  inspectMat.colorNode = vec4(vec3(texture(cloudShadow.texture).sample(uv()).r), 1.0);
  const inspectQuad = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.44), inspectMat);
  inspectQuad.position.set(0.74, -0.72, 0);
  inspectScene.add(inspectQuad);
  let showInspector = false;

  // ── Free-fly camera ────────────────────────────────────────────────────────────────
  const cam = { yaw: Math.PI, pitch: 0.16, speed: 90 };
  function applyView(name) {
    const v = VIEWPOINTS[name];
    if (!v) return;
    camera.position.set(...v.pos);
    cam.yaw = v.yaw; cam.pitch = v.pitch;
  }
  applyView("ground");

  let dragging = false, lastX = 0, lastY = 0;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    dragging = false;
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {}
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    cam.yaw -= (e.clientX - lastX) * 0.0035;
    cam.pitch = THREE.MathUtils.clamp(cam.pitch - (e.clientY - lastY) * 0.0035, -1.5, 1.5);
    lastX = e.clientX; lastY = e.clientY;
  });

  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);
  function flyStep(dt) {
    _fwd.set(
      Math.sin(cam.yaw) * Math.cos(cam.pitch),
      Math.sin(cam.pitch),
      Math.cos(cam.yaw) * Math.cos(cam.pitch),
    ).normalize();
    _right.crossVectors(_fwd, _up).normalize();
    const boost = held.has("ShiftLeft") || held.has("ShiftRight") ? 6 : 1;
    const v = cam.speed * boost * dt;
    if (held.has("KeyW")) camera.position.addScaledVector(_fwd, v);
    if (held.has("KeyS")) camera.position.addScaledVector(_fwd, -v);
    if (held.has("KeyD")) camera.position.addScaledVector(_right, v);
    if (held.has("KeyA")) camera.position.addScaledVector(_right, -v);
    if (held.has("KeyE")) camera.position.y += v;
    if (held.has("KeyQ")) camera.position.y -= v;
    camera.lookAt(
      camera.position.x + _fwd.x, camera.position.y + _fwd.y, camera.position.z + _fwd.z,
    );
  }

  // ── Panel ──────────────────────────────────────────────────────────────────────────
  const CP = clouds.params;
  const SHP = cloudShadow.params;
  const EP = skyEnv.params;
  const extra = { deck: "hero" };

  const SPECS = {
    "g-deck": [
      [CP, "base", 60, 2000, 10], [CP, "thickness", 100, 1600, 10],
      [CP, "coverage", 0, 1.4, 0.01], [CP, "coverageBias", -0.4, 0.4, 0.01],
      [CP, "densityMul", 0.02, 0.4, 0.005], [CP, "erode", 0, 0.9, 0.01],
      [CP, "typeBias", 0, 1, 0.01], [CP, "cloudTopMin", 0.05, 1, 0.01],
      [CP, "edgeTaper", 0, 1, 0.01],
      [CP, "windDeg", 0, 360, 1], [CP, "windSpeed", 0, 40, 0.5],
    ],
    "g-solid": [
      [CP, "solidCoverage", 0, 1.2, 0.01], [CP, "solidWeatherBias", -0.5, 0.5, 0.01],
      [CP, "solidDensity", 0.005, 0.2, 0.001], [CP, "solidWeatherScale", 5000, 80000, 500],
      [CP, "solidBaseScale", 1000, 20000, 100], [CP, "solidErosionMul", 0.1, 1, 0.01],
      [CP, "solidBaseStrength", 0, 2, 0.02], [CP, "solidErodeBase", 0, 3, 0.02],
      [CP, "solidErodePeak", 0, 3, 0.02], [CP, "solidEdgeSoft", 0.005, 0.3, 0.005],
      [CP, "solidEdgeFalloff", 0.2, 3, 0.02], [CP, "solidStep", 20, 400, 5],
      [CP, "solidConeAngle", 0, 0.01, 0.0002], [CP, "solidMaxOD", 0.05, 3, 0.05],
      [CP, "solidLightStep", 25, 1200, 5], [CP, "solidLightSpread", 0, 0.3, 0.005],
      [CP, "solidFullLightAlpha", 0, 1, 0.01], [CP, "solidAlbedo", 0.5, 1, 0.005],
      [CP, "solidPhaseFwd", 0, 0.95, 0.01], [CP, "solidPhaseBack", 0, 0.9, 0.01],
      [CP, "solidGroundBounce", 0, 1, 0.01],
    ],
    "g-light": [
      [CP, "sunIntensity", 0, 8, 0.05], [CP, "ambientIntensity", 0, 3, 0.02],
      [CP, "phaseG", 0, 0.95, 0.01], [CP, "phaseW", 0, 1, 0.01],
      [CP, "powder", 0, 1, 0.01], [CP, "lightAbsorb", 0.1, 4, 0.05],
      [CP, "msAmount", 0, 1.5, 0.01], [CP, "msFloor", 0, 0.8, 0.01],
      [CP, "rayStrength", 0, 2, 0.02], [CP, "shadowStrength", 0, 1, 0.02],
    ],
    "g-shadow": [
      [SHP, "strength", 0, 1, 0.02], [SHP, "absorb", 0.2, 5, 0.05],
      [SHP, "softness", 0, 6, 0.1], [SHP, "size", 1500, 9000, 100],
      [SHP, "steps", 4, 32, 1], [SHP, "interval", 1, 8, 1],
    ],
    "g-env": [
      [EP, "intensity", 0, 3, 0.05], [EP, "steps", 8, 48, 1],
      [EP, "sunIntensity", 0, 8, 0.05], [EP, "ambientIntensity", 0, 3, 0.02],
      [EP, "interval", 1, 12, 1],
    ],
    "g-time": [
      [SP, "timeOfDay", 0, 24, 0.05], [SP, "latitude", -60, 70, 1],
      [SP, "milkyWay", 0, 2, 0.05], [SP, "sunDiscBright", 0, 30, 0.5],
    ],
  };

  const readouts = [];
  const fmt = (v) => {
    if (Math.abs(v) >= 100) return v.toFixed(0);
    if (Math.abs(v) >= 1) return v.toFixed(2).replace(/\.?0+$/, "");
    return Number(v.toPrecision(2)).toString();
  };

  for (const [groupId, list] of Object.entries(SPECS)) {
    const host = document.getElementById(groupId);
    if (!host) continue;
    for (const [bag, key, lo, hi, step] of list) {
      const row = document.createElement("div");
      row.className = "row";
      const label = key.replace(/([A-Z])/g, " $1").toLowerCase();
      row.innerHTML =
        `<label>${label}</label><input type="range" min="${lo}" max="${hi}" step="${step}">` +
        `<span class="val"></span>`;
      const input = row.querySelector("input");
      const valEl = row.querySelector(".val");
      const sync = () => { input.value = bag[key]; valEl.textContent = fmt(bag[key]); };
      input.addEventListener("input", () => {
        bag[key] = parseFloat(input.value);
        valEl.textContent = fmt(bag[key]);
        // The probe describes a sky that just changed; without this it keeps lighting the
        // world from the old one until its next scheduled cycle.
        if (bag === EP || bag === CP || bag === SP) skyEnv.invalidate();
      });
      sync();
      readouts.push(sync);
      host.appendChild(row);
    }
  }

  // ── Toggles ────────────────────────────────────────────────────────────────────────
  function bindToggle(id, get, set, labels) {
    const b = document.getElementById(id);
    if (!b) return () => {};
    const paint = () => {
      b.textContent = get() ? labels[1] : labels[0];
      b.classList.toggle("on", !!get());
    };
    b.addEventListener("click", () => { set(!get()); paint(); });
    paint();
    return paint;
  }

  const paintEnvClouds = bindToggle(
    "b-envclouds",
    () => EP.clouds,
    (v) => { EP.clouds = v; skyEnv.invalidate(); },
    ["Env: sky only", "Env: sky + clouds"],
  );
  const paintShadows = bindToggle(
    "b-shadows",
    () => SHP.enabled,
    (v) => { SHP.enabled = v; },
    ["Cloud shadows: off", "Cloud shadows: on"],
  );
  const paintClouds = bindToggle(
    "b-clouds",
    () => clouds.enabled,
    (v) => clouds.setEnabled(v),
    ["Clouds: off", "Clouds: on"],
  );

  function setDeck(name) {
    const d = DECKS[name];
    if (!d) return;
    extra.deck = name;
    Object.assign(CP, d);
    skyEnv.invalidate();
    for (const r of readouts) r();
    for (const b of document.querySelectorAll("[data-deck]")) {
      b.classList.toggle("on", b.dataset.deck === name);
    }
  }
  for (const b of document.querySelectorAll("[data-deck]")) {
    b.addEventListener("click", () => setDeck(b.dataset.deck));
  }
  setDeck(MODEL === "solid" ? "skypro" : "partly");
  {
    const b = document.getElementById("b-model");
    if (b) {
      b.textContent = MODEL === "solid" ? "Model: solid (reload → nubis)" : "Model: nubis (reload → solid)";
      b.addEventListener("click", () => {
        const u = new URL(location.href);
        u.searchParams.set("model", MODEL === "solid" ? "nubis" : "solid");
        location.href = u.toString();
      });
    }
  }

  function setTime(name) {
    applyTimePreset(SP, name);
    skyEnv.invalidate();
    for (const r of readouts) r();
    for (const b of document.querySelectorAll("[data-time]")) {
      b.classList.toggle("on", b.dataset.time === name);
    }
  }
  for (const b of document.querySelectorAll("[data-time]")) {
    b.addEventListener("click", () => setTime(b.dataset.time));
  }

  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => applyView(b.dataset.view));
  }

  document.getElementById("b-copy")?.addEventListener("click", () => {
    const payload = {
      deck: extra.deck,
      model: MODEL,
      clouds: { ...CP },
      cloudShadow: { ...SHP },
      skyEnv: { ...EP },
      sky: { timeOfDay: SP.timeOfDay, latitude: SP.latitude, dayOfYear: SP.dayOfYear },
    };
    navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
    const b = document.getElementById("b-copy");
    const t = b.textContent; b.textContent = "copied"; setTimeout(() => { b.textContent = t; }, 900);
  });

  // ── Keys ───────────────────────────────────────────────────────────────────────────
  // Movement on e.code (physical key, so WASD survives AZERTY); commands on e.key, which
  // is the printed label.
  const held = new Set();
  addEventListener("keydown", (e) => {
    held.add(e.code);
    const k = e.key.toLowerCase();
    if (k === "1") applyView("ground");
    if (k === "2") applyView("hills");
    if (k === "3") applyView("inside");
    if (k === "4") applyView("above");
    if (k === "5") setTime("dawn");
    if (k === "6") setTime("day");
    if (k === "7") setTime("hero");
    if (k === "8") setTime("dusk");
    if (k === "9") setTime("night");
    if (k === "c") { clouds.setEnabled(!clouds.enabled); paintClouds(); }
    if (k === "x") { SHP.enabled = !SHP.enabled; paintShadows(); }
    if (k === "v") { EP.clouds = !EP.clouds; skyEnv.invalidate(); paintEnvClouds(); }
    if (k === "b") showInspector = !showInspector;
    if (k === "h") {
      const el = document.getElementById("hud");
      el.style.display = el.style.display === "none" ? "" : "none";
    }
  });
  addEventListener("keyup", (e) => held.delete(e.code));
  addEventListener("blur", () => held.clear());

  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  // ── Frame ──────────────────────────────────────────────────────────────────────────
  const _lightAnchor = new THREE.Vector3();
  const _cloudSun = new THREE.Color();
  const _cloudZenith = new THREE.Color();
  const _cloudHorizon = new THREE.Color();
  const _envAmbient = new THREE.Color();
  const _cloudFrame = {
    sunDir: new THREE.Vector3(),
    sunColor: _cloudSun,
    skyZenith: _cloudZenith,
    skyHorizon: _cloudHorizon,
    hazeColor: _cloudHorizon,
  };
  const _envLook = { sunDir: new THREE.Vector3(), sunColor: _cloudSun, skyAmbient: _envAmbient };

  function syncLights(look) {
    const sunUp = look.sunDir.y > 0.02;
    _lightAnchor.copy(sunUp ? look.sunDir : look.moonDir);
    sun.position.copy(camera.position).addScaledVector(_lightAnchor, 800);
    sun.target.position.copy(camera.position);
    sun.target.updateMatrixWorld();
    sun.color.copy(sunUp ? look.sunColor : look.moonColor).convertLinearToSRGB();
    sun.intensity = look.dirIntensity;
    hemi.color.copy(look.zenithBelow).convertLinearToSRGB();
    hemi.groundColor.copy(look.nadirBelow).convertLinearToSRGB();
    hemi.intensity = look.hemiIntensity;
    renderer.toneMappingExposure = look.exposure;
  }

  const sGpu = document.getElementById("s-gpu");
  const sFps = document.getElementById("s-fps");
  const sAlt = document.getElementById("s-alt");
  const sIn = document.getElementById("s-in");
  const sSun = document.getElementById("s-sun");
  const sMood = document.getElementById("s-mood");
  setBoot("");

  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, gpuAcc = 0, gpuN = 0, hudT = 0;
  let paused = false;

  renderer.setAnimationLoop(() => {
    if (paused) return;
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    flyStep(dt);

    const look = sky.update({ camera, dt });
    // The atmosphere needs the sun AND the camera altitude — the altitude is half the
    // point, since the sky genuinely changes as you climb toward and through the deck.
    atmo.update(look.sunDir, Math.max(0, camera.position.y), look.moonDir);
    syncLights(look);

    _cloudFrame.sunDir.copy(look.sunDir);
    _cloudSun.copy(look.sunColor).convertLinearToSRGB();
    _cloudZenith.copy(look.zenithBelow).convertLinearToSRGB();
    _cloudHorizon.copy(look.horizonBelow).convertLinearToSRGB();
    clouds.update(dt, _cloudFrame);

    // Both couplings bake into their own targets and restore the previous one, so they
    // must run BEFORE the cloud pipeline takes the frame over.
    // The shadow map bakes BEFORE the frame: the world materials read it during the main
    // pass, so it has to be current. One fullscreen quad into its own 2D target, previous
    // target restored — the cloud pipeline never notices.
    cloudShadow.update(camera.position, look.sunDir, clouds.isReady && clouds.enabled);

    if (!clouds.renderFrame()) {
      camera.layers.disable(CLOUD_LAYER);
      renderer.render(scene, camera);
    }

    /*
     * THE PROBE BAKES AFTER THE FRAME, and that ordering is not cosmetic.
     *
     * Running it before `renderFrame()` — the obvious place, next to the shadow map —
     * visibly corrupted the CLOUDS: hard rectangular seams across every mass, black
     * speckle inside them, and an alpha that never accumulated. Bisected by toggling each
     * coupling: the shadow map is innocent, the probe is not, and it stays guilty with
     * `params.clouds = false`, i.e. when its shader touches none of the cloud field. So it
     * is not shared TSL nodes — it is the cube render and the PMREM convolution running
     * inside `renderFrame()`'s window, where the cloud module is mid-way through its own
     * render-target ping-pong and temporal history swap.
     *
     * A probe describes the average colour of the sky. It is allowed to be one frame late,
     * and the IBL it feeds is already six frames of latency deep. So it goes here, where
     * the frame is finished and there is no pipeline in flight to disturb.
     */
    _envLook.sunDir.copy(look.sunDir);
    _envAmbient.copy(look.zenithBelow).convertLinearToSRGB();
    skyEnv.update(camera.position, _envLook, clouds.isReady && clouds.enabled);

    if (showInspector) {
      renderer.autoClear = false;
      renderer.render(inspectScene, inspectCam);
      renderer.autoClear = true;
    }

    if (hasTimestamps) renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);

    fpsAcc += 1 / Math.max(dt, 1e-4); fpsN++;
    const g = renderer.info.render.timestamp;
    if (g > 0) { gpuAcc += g; gpuN++; }

    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      const fps = fpsAcc / Math.max(fpsN, 1);
      const gpu = gpuAcc / Math.max(gpuN, 1);
      fpsAcc = fpsN = gpuAcc = gpuN = 0;
      if (sFps) sFps.textContent = fps.toFixed(0);
      if (sGpu) {
        sGpu.textContent = hasTimestamps ? `${gpu.toFixed(2)} ms` : "n/a";
        sGpu.className = gpu > 10 ? "warn" : gpu > 0 ? "good" : "";
      }
      if (sAlt) sAlt.textContent = `${camera.position.y.toFixed(0)} m`;
      if (sIn) {
        const inDeck = clouds.enabled
          && camera.position.y > CP.base && camera.position.y < CP.base + CP.thickness;
        sIn.textContent = !clouds.enabled ? "off" : inDeck ? "inside" : "no";
        sIn.className = inDeck ? "good" : "";
      }
      if (sSun) sSun.textContent = `${look.sunElevation.toFixed(0)}°`;
      if (sMood) sMood.textContent = look.lookName;
      if (SP.autoAdvance) for (const r of readouts) r();
    }
  });

  window.__skyProLab = {
    THREE, renderer, scene, camera, cam, sky, atmo, clouds, cloudShadow, skyEnv,
    applyView, setDeck, setTime, VIEWPOINTS, DECKS,
    setPaused: (v) => { paused = !!v; },
    lookAlong: (x, y, z) => {
      cam.yaw = Math.atan2(x, z);
      cam.pitch = Math.atan2(y, Math.hypot(x, z));
    },
  };
  return window.__skyProLab;
}
