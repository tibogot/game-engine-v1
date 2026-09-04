// ============================================================================
// CITY LAB — tuning and measurement harness for modularRoadCity.js.
//
// Standalone: no v3 engine, no terrain, no post-FX, no clouds. A deck stub, the
// city, and THE GAME'S OWN SKY.
//
// That last part is deliberate and it is a reversal. The lab started with a
// cheap analytic gradient so that "every number on screen is the city" — which
// is right for MEASUREMENT and wrong for JUDGEMENT. Under one directional light
// and no environment map the city rendered as black silhouettes, and the
// conclusion "it does not look as good as the three.js example" was really a
// verdict on the lab's lighting: the facade's glass is metalness 0.55, and
// metal with nothing to reflect is black.
//
// So the lab now imports `modularRoadSky.js` + `modularRoadSkyAtmosphere.js`
// with the same parameters roadGame.js boots on, bakes a PMREM of that sky for
// IBL, and applies its aerial perspective. The cheap gradient is still one
// keypress away (F8) and the lighting is identical in both modes, so the
// measurement discipline survives: F8 changes the backdrop's cost, never the
// light the city is being judged under.
//
// ── WHAT THIS LAB IS FOR, SPECIFICALLY ───────────────────────────────────────
//
// The thing that decides whether a procedural city works in THIS game is not a
// screenshot. It is a wall of high-frequency window grids going past a camera
// at 45 m/s, and the failure mode is shimmer, not slowness. So the lab's
// headline feature is not a slider — it is DRIVE-BY (G), which flies the camera
// down the corridor at car speed at deck altitude, on the exact sightline the
// chase camera will have. Judge the facade there, in motion, before judging it
// anywhere else.
//
// The four static viewpoints are the four cases that then have to hold:
//
//   1 STREET   ground level between towers — does the facade survive close up,
//              and does the lobby band stop it reading as a stack of floors
//   2 DECK     on the track at build altitude, towers at mid distance. THE
//              gameplay eye. This is where the LOD0/LOD1 ring lands.
//   3 SKYLINE  far and high — silhouette and aliasing, the backdrop case
//   4 CANYON   between two towers at deck height, worst-case overdraw: tall
//              near geometry filling the screen, which is where fragment cost
//              actually lives
//
// ── MEASURE, DO NOT GUESS ────────────────────────────────────────────────────
//
//   C  city off/on          — the A/B delta is the only honest cost figure
//   B  batched / instanced  — measured 1150 draws vs 34; BatchedMesh is NOT one
//                             draw on WebGPU (no multi-draw in the spec)
//   O  shadows off/on       — cheap here (+0.04 ms) only because just the L0
//                             tier casts; that gate is the instanced backend's
//   F8 game sky / gradient  — what the sky itself costs, lighting held fixed
//   U  aerial perspective   — depth in a cityscape is haze, not geometry
//
// GPU ms comes from timestamp queries the same way the cloud lab gets it:
// `trackTimestamp` is a BACKEND CONSTRUCTION option, so it is passed to the
// WebGPURenderer constructor and never set afterwards.
// ============================================================================
import * as THREE from "three/webgpu";
import {
  Fn, vec3, vec4, uniform, positionWorld, cameraPosition, output,
  normalize, smoothstep, mix, max, dot, pow,
} from "three/tsl";
import { createModularRoadCity, CITY_DEFAULTS } from "./modularRoadCity.js";
import { FACADE_DEFAULTS } from "./modularRoadCityFacade.js";
import { KIT_DEFAULTS } from "./modularRoadCityKit.js";
import { createModularRoadSky, TIME_PRESETS, skyBandName } from "./modularRoadSky.js";
import { createSkyAtmosphere } from "./modularRoadSkyAtmosphere.js";

/** Default build altitude in the game's sky-stunt mode (roadGame.js). */
const DECK_ALT = 40;
/** Roughly the speed the car actually travels at (modularRoadKit FOLLOW_HOLD). */
const CAR_SPEED = 45;

/**
 * `flyStep` builds forward as (sin yaw·cos pitch, sin pitch, cos yaw·cos pitch),
 * so a viewpoint that wants to LOOK AT the city centre from (x, z) needs
 * yaw = atan2(-x, -z). Getting that backwards aims the camera away from the
 * skyline and quietly turns the backdrop test into a shot of empty sky.
 */
const VIEWPOINTS = {
  street:  { pos: [18, 6, 300],           yaw: Math.PI, pitch: 0.22 },
  deck:    { pos: [0, DECK_ALT + 3, 420], yaw: Math.PI, pitch: -0.02 },
  // Outside the built radius (1200 m), below the tallest crowns (~300 m), aimed
  // at the middle — the city as a BACKDROP, which is the aliasing case.
  skyline: { pos: [1500, 200, 1500],      yaw: Math.PI * 1.25, pitch: 0.02 },
  canyon:  { pos: [0, DECK_ALT + 2, 120], yaw: Math.PI, pitch: 0.06 },
};

export async function startCityLab() {
  const boot = document.getElementById("boot");

  // ── Device ─────────────────────────────────────────────────────────────────
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
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  // Far plane matches the engine's order of magnitude (v3/app/main.js uses
  // WORLD_SIZE * 4 ≈ 8096) so the skyline view is not clipped here and visible
  // in the game.
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 8192);

  // ── SKY: THE GAME'S OWN, NOT A LAB STAND-IN ────────────────────────────────
  //
  // The city was first judged under a cheap analytic gradient with one
  // directional light and NO environment, and it read as black silhouettes.
  // That was never the city's fault: the facade's glass is metalness 0.55 /
  // roughness 0.12, and metal with nothing to reflect is black. It is exactly
  // the finding the guardrail rebuild landed on — the biggest of its four
  // causes was NO ENV. Judging a look under lighting the game will never show
  // is how a lab produces confident, wrong answers.
  //
  // So this runs the same pair the game boots on (roadGame.js `buildGameSky`),
  // with the two parameter traps that file documents:
  //
  //   atmosphereMix: 1  `uAtmoMix` is born at 0, which is the AUTHORED GRADIENT
  //                     fallback — measured saturation 0.17 against the
  //                     physical path's 0.45. Leave it and the "physical" sky
  //                     is a dull blue and the comparison is worthless.
  //   cloudSea: 0       the analytic "sea of clouds below the horizon" is a
  //                     STAND-IN for clouds you do not have. It fires above
  //                     ~480 m and drops a band of grey mottle under a city
  //                     seen from altitude — i.e. over the skyline viewpoint.
  //
  // No cloud deck: the lab measures THE CITY, and clouds are a separate,
  // already-measured ~1 ms. The cheap dome stays one keypress away (F8) as the
  // measurement baseline, and it is only the SKY that swaps — lighting comes
  // from `evaluateSky` in both modes, so F8 changes cost and backdrop, never
  // the light the city is judged under.
  const atmo = createSkyAtmosphere({ renderer });
  const sky = createModularRoadSky({
    atmosphere: atmo,
    params: { timeOfDay: TIME_PRESETS.hero, autoAdvance: false, atmosphereMix: 1, cloudSea: 0 },
  });
  scene.add(sky.mesh);
  const SKY = sky.params;

  // The cheap gradient, kept as the measurement baseline. Hidden by default.
  const uSunDir = uniform(new THREE.Vector3());
  const uZenith = uniform(new THREE.Color(0x2c4f86));
  const uHorizon = uniform(new THREE.Color(0xd9a273));

  const skyMat = new THREE.MeshBasicNodeMaterial();
  skyMat.side = THREE.BackSide;
  skyMat.depthWrite = false;
  skyMat.fog = false;
  skyMat.colorNode = Fn(() => {
    const dir = normalize(positionWorld);
    const t = smoothstep(-0.08, 0.55, dir.y);
    const col = mix(uHorizon, uZenith, t).toVar();
    const mu = max(dot(dir, uSunDir), 0.0);
    col.addAssign(vec3(1.0, 0.86, 0.66).mul(pow(mu, 800.0).mul(12.0)));
    col.addAssign(vec3(1.0, 0.74, 0.5).mul(pow(mu, 10.0).mul(0.4)));
    return vec4(col, 1.0);
  })();
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(6000, 32, 16), skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.visible = false;
  scene.add(skyMesh);
  let gameSkyOn = true;

  const sun = new THREE.DirectionalLight(0xffe6c4, 2.6);
  sun.castShadow = true;
  // A city is an enormous occluder. The shadow camera is deliberately SMALL and
  // camera-following: a cascade sized to the whole skyline would spend all its
  // resolution on towers nowhere near the road, which is the failure this lab
  // is meant to make visible.
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 900;
  const SHADOW_RADIUS = 260;
  sun.shadow.camera.left = -SHADOW_RADIUS;
  sun.shadow.camera.right = SHADOW_RADIUS;
  sun.shadow.camera.top = SHADOW_RADIUS;
  sun.shadow.camera.bottom = -SHADOW_RADIUS;
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0x9dbbe0, 0x3a3630, 0.9);
  scene.add(hemi);

  const _keyDir = new THREE.Vector3();

  /**
   * THE LIGHTING COMES FROM THE SKY, NOT FROM THE LAB.
   *
   * `evaluateSky` already returns `dirIntensity`, `hemiIntensity` and
   * `exposure` across the whole day-night curve, plus the sun and moon colours
   * it painted the dome with. The lab's previous rig was a hand-rolled
   * `clamp((elevation + 3) / 14)` that agreed with none of it — which is how
   * the city ended up being judged at an exposure the game never uses.
   *
   * Everything here is a READ of `look`. Nothing invents a number.
   */
  function applyLook(look) {
    // Night keys off the MOON. `dirIntensity` already folds in `moonIllum` and
    // the night weight, so this is a direction and colour swap, not a second
    // intensity curve laid on top.
    const night = look.nightF > 0.5;
    _keyDir.copy(night ? look.moonDir : look.sunDir);
    // Sun rig follows the camera: the shadow box is 260 m and the city is 2.4 km.
    sun.position.copy(camera.position).addScaledVector(_keyDir, 600);
    sun.target.position.set(camera.position.x, 0, camera.position.z);
    sun.target.updateMatrixWorld();
    sun.color.copy(night ? look.moonColor : look.sunColor);
    sun.intensity = look.dirIntensity;
    hemi.color.copy(look.horizonInside);
    hemi.groundColor.copy(look.nadirInside);
    hemi.intensity = look.hemiIntensity;
    renderer.toneMappingExposure = look.exposure;
    // The city's lit windows follow the same night factor the sky uses, so the
    // windows come on exactly when the sky says it is night.
    if (city) city.facade.nightAmount = look.nightF;
    // Keep the cheap dome showing the same sun, so F8 swaps the BACKDROP only.
    uSunDir.value.copy(look.sunDir);
    uZenith.value.copy(look.zenithInside);
    uHorizon.value.copy(look.horizonInside);
  }

  // ── AERIAL PERSPECTIVE ─────────────────────────────────────────────────────
  //
  // The single biggest look lever a SKYLINE has. Without it a tower 2 km out is
  // the same colour as one 200 m away and the city reads as a flat cutout —
  // depth in a cityscape is haze, not geometry.
  //
  // Applied as the SCENE FOG NODE so every material picks it up with no
  // per-material edit. It also sidesteps the known WebGPU trap that bit the
  // scenery: scene fog UNIFORMS are never refreshed on static geometry that
  // never moves, and a city is the largest possible instance of that. The haze
  // here comes from the sky-view LUT — a TEXTURE, re-baked when the sun moves —
  // so it tracks time of day on geometry that never updates.
  const aerialNode = Fn(() => {
    const toCam = positionWorld.sub(cameraPosition);
    return vec4(
      atmo.applyAerialPerspective(output.rgb, toCam.normalize(), toCam.length()),
      output.a,
    );
  })();
  let aerialOn = true;
  scene.fogNode = aerialNode;

  // ── IBL ────────────────────────────────────────────────────────────────────
  //
  // Glass needs something to reflect. A PMREM of the sky itself, baked ONE CUBE
  // FACE PER FRAME and convolved on the sixth, so a time-of-day change costs
  // seven spread frames instead of one long hitch — and a frozen clock, which
  // is the default, costs nothing at all.
  //
  // The bake renders the scene into a cube target, and `renderer.info` counts
  // `frameCalls` ACROSS every render in a frame (it auto-resets once per frame,
  // not once per render). So a bake frame inflates draw calls and triangles,
  // and the stats readout below deliberately skips those frames rather than
  // reporting a city that looks twice as expensive as it is.
  const pmrem = new THREE.PMREMGenerator(renderer);
  let cubeRT = null, cubeCam = null, envRT = null;
  let envFace = -1, envNeeds = true, lastEnvSnap = "", envBakedThisFrame = false;
  const _skyHome = new THREE.Vector3();

  function ensureEnvRig() {
    if (cubeRT) return;
    cubeRT = new THREE.CubeRenderTarget(128, { type: THREE.HalfFloatType });
    cubeCam = new THREE.CubeCamera(0.1, 20000, cubeRT);
    cubeCam.updateMatrixWorld(true);
  }

  function bakeEnvFace(face) {
    ensureEnvRig();
    // The env is the SKY, not the city. Parking the dome at the origin and
    // hiding the world is what stops a tower two metres from the cube camera
    // becoming the ambient colour of every tower in the city.
    _skyHome.copy(sky.mesh.position);
    sky.mesh.position.set(0, 0, 0);
    sky.setSunDiscScale(0);            // a 1-pixel sun in a 128² face is fireflies
    const hide = [city?.group, deck, skyMesh, hills].filter(Boolean);
    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;

    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(cubeRT, face);
    renderer.render(scene, cubeCam.children[face]);
    renderer.setRenderTarget(prev);

    sky.setSunDiscScale(1);
    sky.mesh.position.copy(_skyHome);
    hide.forEach((o, i) => { o.visible = vis[i]; });
    envBakedThisFrame = true;
  }

  function convolveEnv() {
    try {
      envRT = pmrem.fromCubemap(cubeRT.texture, envRT);
      scene.environment = envRT.texture;
      scene.environmentIntensity = 1.15;
    } catch (err) {
      console.warn("[CityLab] PMREM bake failed; IBL disabled.", err);
    }
  }

  function tickEnvBake(look) {
    const snap = `${SKY.timeOfDay.toFixed(2)}|${look.lookName}`;
    if (snap !== lastEnvSnap) { lastEnvSnap = snap; envNeeds = true; }
    if (envFace >= 0) {
      bakeEnvFace(envFace);
      envFace++;
      if (envFace >= 6) { convolveEnv(); envFace = -1; envNeeds = false; }
      return;
    }
    if (envNeeds) envFace = 0;
  }

  // ── Deck stub ──────────────────────────────────────────────────────────────
  // A straight ribbon down the corridor the city keeps clear of. It is here for
  // SCALE and for the sightline, not for looks — with nothing at deck altitude
  // the DECK and CANYON viewpoints are just numbers.
  const deck = new THREE.Group();
  deck.name = "DeckStub";
  {
    const asphalt = new THREE.MeshStandardNodeMaterial({ color: 0x34343a, roughness: 0.85 });
    const kerb = new THREE.MeshStandardNodeMaterial({
      color: 0xf0e6d6, roughness: 0.5, emissive: 0x221703, emissiveIntensity: 0.3,
    });
    const LEN = 3200;
    const d = new THREE.Mesh(new THREE.BoxGeometry(13, 0.5, LEN), asphalt);
    d.receiveShadow = true;
    const kl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, LEN), kerb);
    kl.position.set(-6.7, 0.4, 0);
    const kr = kl.clone();
    kr.position.x = 6.7;
    deck.add(d, kl, kr);
  }
  scene.add(deck);

  // ── City ───────────────────────────────────────────────────────────────────
  // The corridor the city must keep clear of is the deck's centreline (x = 0),
  // so `avoid` is just the distance to it. In the game this becomes the real
  // track polyline.
  const avoid = (x) => Math.abs(x);

  let city = null;
  let deckAlt = DECK_ALT;

  function makeCity(seed) {
    if (city) { scene.remove(city.group); city.dispose(); }
    city = createModularRoadCity({ seed, avoid });
    scene.add(city.group);
  }
  boot.textContent = "baking city…";
  makeCity(20260902);
  deck.position.y = deckAlt;

  // ── Fake hills (T) ─────────────────────────────────────────────────────────
  // A stand-in for the game's terrain: rolling ground plus one ridge steep
  // enough to trip the slope cull. Same sampler contract as `groundBaseY` in
  // roadGame.js — a plain (x, z) -> metres function.
  const hillHeight = (x, z) =>
    22 * Math.sin(x * 0.0021 + 0.4) * Math.cos(z * 0.0017)
    + 9 * Math.sin((x + z) * 0.0047)
    + 45 * Math.max(0, Math.sin(x * 0.0009 - 1.3)) * Math.max(0, Math.cos(z * 0.0011));
  let hillsOn = false;
  const hills = (() => {
    const g = new THREE.PlaneGeometry(3400, 3400, 170, 170);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, hillHeight(pos.getX(i), pos.getZ(i)));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ color: 0x4a5540, roughness: 0.95 }));
    m.name = "FakeHills";
    m.receiveShadow = true;
    m.visible = false;
    scene.add(m);
    return m;
  })();

  // ── Free-fly camera ────────────────────────────────────────────────────────
  // Declared here, not down with the key handling: applyView() clears `driving`
  // and runs during init, so a `let` further down would put it in the temporal
  // dead zone and throw before the first frame.
  let driving = false;
  let cityOn = true;
  let shadowsOn = false;

  const cam = { yaw: Math.PI, pitch: 0, speed: 55 };
  function applyView(name) {
    const v = VIEWPOINTS[name];
    if (!v) return;
    driving = false;
    camera.position.set(...v.pos);
    if (name === "deck" || name === "canyon") camera.position.y = deckAlt + 3;
    cam.yaw = v.yaw; cam.pitch = v.pitch;
  }
  applyView("deck");

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

  // Movement on e.code (physical key) so WASD works on AZERTY; shortcuts on
  // e.key, which is the printed label.
  const held = new Set();

  addEventListener("keydown", (e) => {
    held.add(e.code);
    const k = e.key.toLowerCase();
    if (k === "1") applyView("street");
    if (k === "2") applyView("deck");
    if (k === "3") applyView("skyline");
    if (k === "4") applyView("canyon");
    if (k === "g") { driving = !driving; if (driving) startDrive(); syncBadges(); }
    if (k === "c") { cityOn = !cityOn; city.setEnabled(cityOn); syncBadges(); }
    if (k === "b") {
      city.setBackend(city.params.backend === "batched" ? "instanced" : "batched");
      city.setShadows(shadowsOn);
      syncBadges();
    }
    if (k === "o") { shadowsOn = !shadowsOn; city.setShadows(shadowsOn); syncBadges(); }
    // F8 is the game's own sky A/B key — same finger, same question.
    if (e.key === "F8") {
      e.preventDefault();
      gameSkyOn = !gameSkyOn;
      sky.mesh.visible = gameSkyOn;
      skyMesh.visible = !gameSkyOn;
      syncBadges();
    }
    // Swapping the fog NODE recompiles every material that reads it, so this is
    // a deliberate, rare A/B and not something to hold down. Worth the stall:
    // aerial perspective is most of what makes a distant skyline read as far
    // away rather than as a sticker.
    if (k === "u") {
      aerialOn = !aerialOn;
      scene.fogNode = aerialOn ? aerialNode : null;
      syncBadges();
    }
    // T: stand the city on FAKE HILLS. This is the game's terrain path — per-lot
    // base from a height sampler, slope cull, lot texture — exercised without
    // the engine, so a tower floating off a slope is found here, not in a
    // .v3proj with a track already built through it.
    if (k === "t") {
      hillsOn = !hillsOn;
      hills.visible = hillsOn;
      city.setGround(!hillsOn);
      city.setHeightSource(hillsOn ? hillHeight : null);
      city.setShadows(shadowsOn);
      syncBadges();
    }
    if (k === "h") {
      const h = document.getElementById("hud");
      h.style.display = h.style.display === "none" ? "" : "none";
    }
  });
  addEventListener("keyup", (e) => held.delete(e.code));
  addEventListener("blur", () => held.clear());

  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  function startDrive() {
    camera.position.set(0, deckAlt + 2.4, 1500);
    cam.yaw = Math.PI; cam.pitch = -0.01;
  }

  function driveStep(dt) {
    // Straight down the corridor at car speed, with a slow lateral weave so the
    // facades are never sampled at a fixed screen velocity — a constant slide
    // hides shimmer that a real chase camera would show.
    camera.position.z -= CAR_SPEED * dt;
    camera.position.x = Math.sin(camera.position.z * 0.0016) * 3.2;
    camera.position.y = deckAlt + 2.4;
    cam.yaw = Math.PI + Math.sin(camera.position.z * 0.0016) * 0.05;
    cam.pitch = -0.01;
    if (camera.position.z < -1500) camera.position.z = 1500;
  }

  function flyStep(dt) {
    _fwd.set(
      Math.sin(cam.yaw) * Math.cos(cam.pitch),
      Math.sin(cam.pitch),
      Math.cos(cam.yaw) * Math.cos(cam.pitch),
    ).normalize();
    _right.crossVectors(_fwd, _up).normalize();
    if (!driving) {
      const boost = held.has("ShiftLeft") || held.has("ShiftRight") ? 6 : 1;
      const v = cam.speed * boost * dt;
      if (held.has("KeyW")) camera.position.addScaledVector(_fwd, v);
      if (held.has("KeyS")) camera.position.addScaledVector(_fwd, -v);
      if (held.has("KeyD")) camera.position.addScaledVector(_right, v);
      if (held.has("KeyA")) camera.position.addScaledVector(_right, -v);
      if (held.has("KeyE")) camera.position.y += v;
      if (held.has("KeyQ")) camera.position.y -= v;
    }
    camera.lookAt(
      camera.position.x + _fwd.x, camera.position.y + _fwd.y, camera.position.z + _fwd.z,
    );
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  // Each spec row is [key, lo, hi, step]. The GROUP decides what a change costs:
  //   live    — writes a uniform or a plain field, no rebuild
  //   layout  — re-runs the lot layout and the backend (debounced)
  //   kit     — re-bakes the archetype geometry too (debounced, the dearest)
  const SPECS = {
    "g-facade": ["live", FACADE_DEFAULTS, [
      ["floorHeight", 2.6, 6, 0.05], ["colWidth", 1.4, 6, 0.05],
      ["winW", 0.2, 0.95, 0.01], ["winH", 0.2, 0.95, 0.01],
      ["lobbyHeight", 0, 18, 0.5],
      ["interior", 0, 1, 0.02], ["roomDepth", 1.5, 9, 0.1], ["curtains", 0, 1, 0.02],
      ["interiorMetal", 0, 0.6, 0.02],
      ["glassRough", 0.02, 0.6, 0.01], ["glassMetal", 0, 1, 0.02],
      ["wallRough", 0.3, 1, 0.02],
      ["pierWidth", 0, 0.3, 0.01], ["pierRelief", 0, 0.5, 0.01], ["spandrel", 0, 0.6, 0.01],
      ["recessAO", 0, 0.6, 0.01], ["baseGrime", 0, 0.8, 0.02],
      ["brickW", 0.2, 1.5, 0.02], ["brickH", 0.1, 0.6, 0.01], ["mortar", 0, 0.3, 0.01], ["brickTint", 0, 0.5, 0.01],
      ["glassJitter", 0, 1, 0.02], ["paneGradient", 0, 1.5, 0.02],
    ]],
    "g-night": ["live", FACADE_DEFAULTS, [
      ["litFraction", 0, 1, 0.01], ["darkFloors", 0, 0.8, 0.01],
      ["emissiveBoost", 0, 8, 0.1], ["churnPeriod", 0, 240, 5],
      ["crownFraction", 0, 1, 0.02], ["crownBoost", 0, 12, 0.2],
    ]],
    "g-aa": ["live", FACADE_DEFAULTS, [
      ["lodSharp", 0.1, 2, 0.02], ["lodFlat", 0.01, 0.5, 0.01],
    ]],
    "g-lod": ["live", CITY_DEFAULTS, [
      ["lod0Dist", 40, 800, 10], ["lod1Dist", 200, 3000, 25],
      ["lodHysteresis", 0, 120, 5], ["lodInterval", 0, 2, 0.05],
      ["lodMoveDist", 0, 60, 1],
    ]],
    "g-layout": ["layout", CITY_DEFAULTS, [
      ["extent", 300, 2500, 50], ["lotSize", 18, 70, 1],
      ["blockLots", 1, 8, 1], ["streetLots", 0, 3, 1],
      ["density", 0.2, 1, 0.02], ["downtownPower", 0.4, 6, 0.1],
      ["heightNoise", 0, 1, 0.02],
      ["scaleYMin", 0.4, 1.5, 0.02], ["scaleYMax", 0.6, 3, 0.02],
      ["avoidRadius", 0, 200, 5],
      ["slopeLimit", 0.5, 30, 0.5], ["sinkBias", 0, 4, 0.1],
      ["districtCore", 0.05, 0.9, 0.01], ["districtMid", 0.2, 1, 0.01], ["districtNoise", 0, 0.6, 0.01],
      ["landmarkRadius", 0, 600, 10],
    ]],
    "g-kit": ["kit", KIT_DEFAULTS, [
      ["archetypes", 2, 40, 1],
      ["minHeight", 8, 120, 2], ["maxHeight", 40, 500, 5],
      ["minFootprint", 8, 40, 1], ["maxFootprint", 12, 60, 1],
      ["setbackChance", 0, 1, 0.02], ["maxSetbacks", 0, 6, 1],
      ["setbackDepth", 0, 0.4, 0.01], ["stringCourseEvery", 0, 30, 1],
    ]],
  };

  const kitOverrides = {};
  const readouts = [];
  let rebuildTimer = 0;

  function fmt(v) {
    if (Math.abs(v) >= 100) return v.toFixed(0);
    if (Math.abs(v) >= 1) return v.toFixed(2).replace(/\.?0+$/, "");
    return v.toPrecision(2);
  }

  // Layout and kit changes cost tens of milliseconds each. Dragging a slider
  // would otherwise stutter the whole page, so they coalesce.
  function scheduleRebuild(kind) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      boot.textContent = "rebuilding…";
      requestAnimationFrame(() => {
        if (kind === "kit") city.rebuildKit(kitOverrides);
        else city.rebuild();
        city.setShadows(shadowsOn);
        city.setEnabled(cityOn);
        boot.textContent = "";
        syncBadges();
      });
    }, 180);
  }

  for (const [groupId, [kind, defaults, list]] of Object.entries(SPECS)) {
    const host = document.getElementById(groupId);
    for (const [key, lo, hi, step] of list) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML =
        `<label>${key.replace(/([A-Z])/g, " $1").toLowerCase()}</label>` +
        `<input type="range" min="${lo}" max="${hi}" step="${step}"><span class="val"></span>`;
      const input = row.querySelector("input");
      const val = row.querySelector(".val");

      const get = () => {
        if (kind === "kit") return kitOverrides[key] ?? defaults[key];
        if (kind === "layout") return city.params[key];
        // Facade params live behind the material's proxy; LOD params on the city.
        return key in city.facade ? city.facade[key] : city.params[key];
      };
      const set = (v) => {
        if (kind === "kit") { kitOverrides[key] = v; return; }
        if (kind === "layout") {
          city.params[key] = v;
          // lotSize is SHARED — the facade hashes the same grid the layout
          // builds on. Letting the two drift smears the per-building tint
          // across neighbours, which looks like a shader bug and is not one.
          if (key === "lotSize") city.facade.lotSize = v;
          return;
        }
        if (key in city.facade) city.facade[key] = v; else city.params[key] = v;
      };

      input.value = get();
      val.textContent = fmt(get());
      input.addEventListener("input", () => {
        set(parseFloat(input.value));
        val.textContent = fmt(parseFloat(input.value));
        if (kind !== "live") scheduleRebuild(kind);
      });
      readouts.push(() => { input.value = get(); val.textContent = fmt(get()); });
      host.appendChild(row);
    }
  }

  // TIME OF DAY is the only sun control, because it is the only one the game
  // has. Elevation and azimuth sliders let you build a lighting setup that no
  // time of day can actually produce, which is a good way to tune a facade for
  // a sun the player will never stand under.
  {
    const host = document.getElementById("g-night");
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>time of day</label>` +
      `<input type="range" min="0" max="24" step="0.05"><span class="val"></span>`;
    const input = row.querySelector("input");
    const val = row.querySelector(".val");
    const clock = (t) => {
      const h = Math.floor(t) % 24, m = Math.round((t - Math.floor(t)) * 60) % 60;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    };
    const sync = () => { input.value = SKY.timeOfDay; val.textContent = clock(SKY.timeOfDay); };
    input.addEventListener("input", () => {
      SKY.timeOfDay = parseFloat(input.value);
      val.textContent = clock(SKY.timeOfDay);
    });
    sync();
    readouts.push(sync);
    host.appendChild(row);

    // The game's own presets, so a look tuned here is a look the game can ask
    // for by name rather than a number somebody has to remember.
    const btns = document.createElement("div");
    btns.className = "btns";
    for (const name of Object.keys(TIME_PRESETS)) {
      const b = document.createElement("button");
      b.textContent = name;
      b.addEventListener("click", () => {
        SKY.timeOfDay = TIME_PRESETS[name];
        sync();
      });
      btns.appendChild(b);
    }
    host.appendChild(btns);
  }

  // Deck altitude — the DECK and CANYON viewpoints are only meaningful at the
  // height the track is actually built at.
  {
    const host = document.getElementById("g-lod");
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>deck altitude</label>` +
      `<input type="range" min="6" max="400" step="2"><span class="val"></span>`;
    const input = row.querySelector("input");
    const val = row.querySelector(".val");
    input.value = deckAlt;
    val.textContent = fmt(deckAlt);
    input.addEventListener("input", () => {
      deckAlt = parseFloat(input.value);
      deck.position.y = deckAlt;
      val.textContent = fmt(deckAlt);
    });
    host.appendChild(row);
  }

  for (const b of document.querySelectorAll("[data-view]")) {
    b.addEventListener("click", () => { applyView(b.dataset.view); syncBadges(); });
  }
  document.getElementById("b-seed").addEventListener("click", () => {
    city.setSeed((Math.random() * 0xffffffff) >>> 0);
    city.setShadows(shadowsOn);
    syncBadges();
  });
  document.getElementById("b-copy").addEventListener("click", async () => {
    const out = { city: {}, facade: {}, kit: { ...kitOverrides } };
    for (const k of Object.keys(CITY_DEFAULTS)) {
      if (city.params[k] !== CITY_DEFAULTS[k]) out.city[k] = city.params[k];
    }
    for (const k of Object.keys(FACADE_DEFAULTS)) {
      if (city.facade[k] !== FACADE_DEFAULTS[k]) out.facade[k] = city.facade[k];
    }
    const text = JSON.stringify(out, null, 2);
    try { await navigator.clipboard.writeText(text); } catch {}
    console.log("[CityLab] changed params:\n" + text);
    const btn = document.getElementById("b-copy");
    btn.textContent = "copied ✓";
    setTimeout(() => { btn.textContent = "Copy params"; }, 1200);
  });

  // ── Badges ─────────────────────────────────────────────────────────────────
  function badge(id, on, onText, offText) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = on ? onText : offText;
    el.className = on ? "good" : "";
  }
  function syncBadges() {
    // NOT labelled "1 draw": on WebGPU a BatchedMesh issues one draw per visible
    // instance, which is the whole reason instanced is the default.
    badge("s-backend", city.params.backend === "instanced", "instanced", "batched");
    badge("s-shadow", shadowsOn, "on", "off");
    badge("s-city", cityOn, "on", "OFF (A/B)");
    badge("s-drive", driving, "DRIVE-BY", "free-fly");
    badge("s-sky", gameSkyOn, "game (physical)", "lab gradient");
    badge("s-aerial", aerialOn, "on", "off");
    badge("s-ground", hillsOn, `hills · ${city.stats.culledSlope} culled`, "flat");
    document.getElementById("s-count").textContent =
      `${city.stats.buildings} in ${city.stats.meshes} mesh${city.stats.meshes === 1 ? "" : "es"}`;
    document.getElementById("s-kit").textContent =
      `${city.stats.kit.count} × ~${city.stats.kit.avgTrisL0}/${city.stats.kit.avgTrisL1}/` +
      `${city.stats.kit.avgTrisL2} tris (${city.stats.kit.bakeMs.toFixed(0)} ms)`;
  }
  syncBadges();

  // ── Resize ─────────────────────────────────────────────────────────────────
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ── Loop ───────────────────────────────────────────────────────────────────
  const sGpu = document.getElementById("s-gpu");
  const sFps = document.getElementById("s-fps");
  const sDraw = document.getElementById("s-draw");
  const sTri = document.getElementById("s-tri");
  const sLod = document.getElementById("s-lod");
  const sLodMs = document.getElementById("s-lodms");
  const sTime = document.getElementById("s-time");
  boot.textContent = "";

  const clockStr = (t) => {
    const h = Math.floor(t) % 24, m = Math.round((t - Math.floor(t)) * 60) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, gpuAcc = 0, gpuN = 0, hudT = 0;
  let lastCleanDraws = 0, lastCleanTris = 0;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (driving) driveStep(dt);
    flyStep(dt);

    // The sky owns the clock, the sun, the exposure and the night factor.
    // `sky.update` also parks its own dome on the camera; the atmosphere
    // re-bakes its LUTs only when the sun or the altitude actually moved, so a
    // frozen time of day costs nothing per frame.
    const look = sky.update({ camera, dt });
    atmo.update(look.sunDir, Math.max(0, camera.position.y), look.moonDir);
    applyLook(look);

    skyMesh.position.copy(camera.position);
    city.update(dt, camera);

    // Before the main render, so a bake frame is identifiable and its inflated
    // counts can be skipped rather than reported as the city's cost.
    envBakedThisFrame = false;
    tickEnvBake(look);

    renderer.render(scene, camera);
    if (hasTimestamps) renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);

    fpsAcc += 1 / Math.max(dt, 1e-4); fpsN++;
    // An env-bake frame carries a second render's cost and counts. Averaging it
    // in would blame the city for the IBL.
    if (!envBakedThisFrame) {
      const g = renderer.info.render.timestamp;
      if (g > 0) { gpuAcc += g; gpuN++; }
      lastCleanDraws = renderer.info.render.drawCalls;
      lastCleanTris = renderer.info.render.triangles;
    }

    hudT += dt;
    if (hudT > 0.25) {
      hudT = 0;
      const fps = fpsAcc / Math.max(fpsN, 1);
      const gpu = gpuAcc / Math.max(gpuN, 1);
      fpsAcc = fpsN = gpuAcc = gpuN = 0;
      sFps.textContent = fps.toFixed(0);
      sFps.className = fps < 50 ? "warn" : "good";
      sGpu.textContent = hasTimestamps ? `${gpu.toFixed(2)} ms` : "n/a";
      sGpu.className = gpu > 8 ? "warn" : gpu > 0 ? "good" : "";
      sDraw.textContent = String(lastCleanDraws);
      sTri.textContent = `${(lastCleanTris / 1000).toFixed(0)}k`;
      sTime.textContent = `${clockStr(SKY.timeOfDay)} · ${look.lookName} · ` +
        `${skyBandName(camera.position.y, SKY)}${envFace >= 0 ? " · IBL…" : ""}`;
      const l = city.stats.lod;
      sLod.textContent = `${l[0]} / ${l[1]} / ${l[2]}`;
      sLodMs.textContent = `${city.stats.lastLodMs.toFixed(2)} ms`;
      sLodMs.className = city.stats.lastLodMs > 2 ? "warn" : "";
    }
  });

  // Exposed for automated inspection / screenshots.
  //
  // `aim` exists because the fly camera owns its orientation: `flyStep` calls
  // `camera.lookAt` from `cam.yaw`/`cam.pitch` every frame, so anything that
  // sets `camera.quaternion` from outside is overwritten before it is drawn.
  // Driving the same two angles is the only way to point this camera without
  // fighting the loop.
  return {
    renderer, scene, camera,
    get city() { return city; },
    get sky() { return sky; },
    /** Place the eye and look at a point. Stops drive-by so it does not walk off. */
    aim(px, py, pz, tx, ty, tz) {
      driving = false;
      camera.position.set(px, py, pz);
      const dx = tx - px, dy = ty - py, dz = tz - pz;
      cam.yaw = Math.atan2(dx, dz);
      cam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    },
    /** Time of day, in hours — the same clock the presets write. */
    setTimeOfDay(t) { SKY.timeOfDay = ((t % 24) + 24) % 24; },
    setHudVisible(on) {
      const h = document.getElementById("hud");
      if (h) h.style.display = on ? "" : "none";
    },
  };
}
