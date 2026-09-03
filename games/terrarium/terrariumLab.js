/**
 * Terrarium lab — boot, assembly, panel, loop.
 *
 * Standalone on purpose: no v3 engine, no clipmap, no post stack beyond a single bloom.
 * The v3 terrain system is built for kilometres and this world is 90 centimetres across,
 * so almost none of its rendering half applies. What DOES apply — sculpt brushes, splat
 * painting, the props builder, the sparse save format — is authoring, and none of that is
 * needed to answer the question this page exists to answer: does the glass, the light and
 * the substrate hold up at 40 cm from the camera?
 */
import * as THREE from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import {
  pass, mix, vec3, uniform, screenUV, positionWorld, clamp, float, mx_noise_float, smoothstep,
} from "three/tsl";

import { TANK, GLASS_DEFAULTS, createGlassMaterial, buildTank } from "./terrariumGlass.js";
import { DISH, BASK, SUBSTRATE_DEFAULTS, createSubstrate, substrateHeight } from "./terrariumSubstrate.js";
import { WATER_DEFAULTS, createWater } from "./terrariumWater.js";
import { LIGHT_DEFAULTS, createLighting } from "./terrariumLighting.js";
import { DUST_DEFAULTS, createDust } from "./terrariumDust.js";
import { createDecor } from "./terrariumDecor.js";
import { bakeRoomEnvironment } from "./terrariumRoom.js";

// ── panel helpers ────────────────────────────────────────────────────────────────────

function slider(host, label, min, max, step, value, onInput) {
  const row = document.createElement("div");
  row.className = "sl";
  row.innerHTML =
    `<label><span>${label}</span><b>${(+value).toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0)}</b></label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
  const out = row.querySelector("b");
  const inp = row.querySelector("input");
  inp.addEventListener("input", () => {
    const v = parseFloat(inp.value);
    out.textContent = v.toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 0);
    onInput(v);
  });
  host.appendChild(row);
  return inp;
}

function toggle(host, label, value, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "btns";
  const b = document.createElement("button");
  b.textContent = label;
  if (value) b.classList.add("on");
  b.addEventListener("click", () => {
    const next = !b.classList.contains("on");
    b.classList.toggle("on", next);
    onChange(next);
  });
  wrap.appendChild(b);
  host.appendChild(wrap);
  return b;
}

// ── camera framings ──────────────────────────────────────────────────────────────────
// The five views that actually decide whether this works. Glass is judged at grazing
// angles, water from low and to the side, the lamp from underneath it.

const VIEWS = {
  // Pulled back and raised from the first pass so the lamp fixture is in shot — the
  // light source being visible is half of why the beam and its pool read as light.
  hero: { pos: [0.74, 0.50, 0.90], tgt: [-0.02, 0.19, 0.0] },
  front: { pos: [0.02, 0.17, 0.96], tgt: [0.0, 0.13, 0.0] },
  basking: { pos: [-0.02, 0.22, 0.46], tgt: [BASK.x, 0.11, BASK.z] },
  water: { pos: [0.44, 0.14, 0.40], tgt: [DISH.x, 0.045, DISH.z] },
  top: { pos: [0.06, 0.98, 0.22], tgt: [0.0, 0.05, 0.0] },
};

export async function startTerrariumLab() {
  const boot = document.getElementById("boot");
  const setBoot = (msg) => { if (boot) boot.textContent = msg; };

  if (!navigator.gpu) throw new Error("WebGPU is not available in this browser.");
  setBoot("Requesting adapter…");

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  setBoot("Building scene…");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.01, 40);
  camera.position.set(...VIEWS.hero.pos);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...VIEWS.hero.tgt);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.12;
  controls.maxDistance = 3.0;
  controls.update();

  // ── backdrop ──────────────────────────────────────────────────────────────────────
  // A dark studio gradient rather than the room geometry: the room exists to be
  // reflected, not looked at, and its crude boxes would be obvious as a background.
  const bgTop = uniform(new THREE.Color(0x141a20));
  const bgBot = uniform(new THREE.Color(0x05070a));
  scene.backgroundNode = mix(bgBot, bgTop, smoothstep(0.0, 0.9, screenUV.y));

  // ── the table ─────────────────────────────────────────────────────────────────────
  // Present so the window light has somewhere to cast the tank's shadow. Without a
  // receiving surface the whole enclosure reads as floating in a void.
  const tableMat = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 0.55 });
  // Grain runs along X and is broken up by a second, lower-frequency field. A single
  // high-frequency stripe on one axis reads as corduroy, which is what the first pass
  // looked like — real board grain wanders.
  const wander = mx_noise_float(positionWorld.mul(vec3(2.0, 1.0, 6.0))).mul(0.35);
  const grain = mx_noise_float(positionWorld.mul(vec3(2.5, 1.0, 52.0)).add(wander)).mul(0.5).add(0.5);
  const knot = mx_noise_float(positionWorld.mul(7.0)).mul(0.5).add(0.5);
  tableMat.colorNode = mix(vec3(0.018, 0.012, 0.008), vec3(0.048, 0.031, 0.020), grain.mul(0.65).add(knot.mul(0.35)));
  tableMat.roughnessNode = clamp(float(0.62).add(grain.mul(0.20)), 0.2, 1.0);
  const table = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.05, 1.25), tableMat);
  table.position.y = -0.025;
  table.receiveShadow = true;
  scene.add(table);

  // ── contents ──────────────────────────────────────────────────────────────────────
  const glass = createGlassMaterial(GLASS_DEFAULTS);
  const tank = buildTank(glass.material);
  scene.add(tank.group);

  const substrate = createSubstrate(SUBSTRATE_DEFAULTS);
  scene.add(substrate.mesh);

  const water = createWater(WATER_DEFAULTS);
  scene.add(water.mesh);

  const decor = createDecor();
  scene.add(decor.group);

  const lighting = createLighting(scene, LIGHT_DEFAULTS);

  const dust = createDust(DUST_DEFAULTS);
  scene.add(dust.points);

  // The lamp is the water's "sun" as well as the dust's beam, so both re-aim together.
  const syncLamp = () => {
    dust.syncToLamp(lighting.spot);
    water.syncToLamp(lighting.spot);
  };
  syncLamp();

  // What the water reflects where the SSR ray misses. Indoors that is the room, not a
  // sky, and it has to go dark with the window or the dish keeps a daylit sheen at night.
  const _wz = new THREE.Color(), _wh = new THREE.Color();
  const syncWaterRoom = (day) => {
    _wz.setHex(0x14171c).lerp(new THREE.Color(0x2b3138), day);
    _wh.setHex(0x2a221a).lerp(new THREE.Color(0x544c42), day);
    water.setRoomColors(_wz, _wh);
  };
  syncWaterRoom(LIGHT_DEFAULTS.dayNight);

  // ── environment ───────────────────────────────────────────────────────────────────
  // Rebaked, not animated: when the window goes dark the glass has to reflect a dark
  // window, and no amount of scaling environmentIntensity can produce that. The bake is
  // a few milliseconds, so it is debounced to the moment the slider settles rather than
  // run per drag frame.
  let envRT = null;
  function rebakeEnvironment() {
    const prev = envRT;
    envRT = bakeRoomEnvironment(renderer, lighting.state.dayNight, 1.0);
    scene.environment = envRT.texture;
    if (prev) prev.dispose();
  }
  rebakeEnvironment();
  // Above 1: the baked room is a handful of dim boxes, and the environment is carrying
  // all of the ambient in a scene whose only real lights are one spot and one window.
  scene.environmentIntensity = 2.3;

  let envTimer = 0;
  const scheduleEnvBake = () => {
    clearTimeout(envTimer);
    envTimer = setTimeout(rebakeEnvironment, 180);
  };

  // ── post ──────────────────────────────────────────────────────────────────────────
  // One full-frame bloom, deliberately NOT the selective MRT kind. Selective bloom needs
  // an emissive attachment, and r184 blends only the `output` attachment — so the glass,
  // being a full-screen transparent surface drawn in front of everything, would erase
  // that emissive buffer and kill the effect it was added for.
  // RenderPipeline, not PostProcessing — the latter is a deprecated alias since r183 and
  // warns on construction.
  const post = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  // Gentle and high-threshold: this is here for the bulb filament and the specular on
  // wet soil, not to glow the whole tank. A strong bloom over a hot spot in a dark box
  // swallows the substrate detail the rest of the page exists to show.
  const bloomPass = bloom(scenePass.getTextureNode(), 0.16, 0.70, 0.92);
  post.outputNode = scenePass.getTextureNode().add(bloomPass);
  let useBloom = true;

  // ── panel ─────────────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const envHost = $("ui-env");
  slider(envHost, "Day / night", 0, 1, 0.01, LIGHT_DEFAULTS.dayNight, (v) => {
    lighting.set("dayNight", v);
    syncLamp();
    syncWaterRoom(v);
    // The studio backdrop tracks the hour too, so night is not a dark tank on a grey wall.
    bgTop.value.setHex(0x141a20).lerp(new THREE.Color(0x05070c), 1 - v);
    bgBot.value.setHex(0x05070a).lerp(new THREE.Color(0x020305), 1 - v);
    scheduleEnvBake();
  });
  slider(envHost, "Environment", 0, 5, 0.01, 2.3, (v) => { scene.environmentIntensity = v; });
  slider(envHost, "Window", 0, 8, 0.05, LIGHT_DEFAULTS.windowPower, (v) => lighting.set("windowPower", v));
  slider(envHost, "Room fill", 0, 1.5, 0.01, LIGHT_DEFAULTS.fill, (v) => lighting.set("fill", v));

  const lampHost = $("ui-lamp");
  slider(lampHost, "Lamp intensity (cd)", 0, 15, 0.05, LIGHT_DEFAULTS.lampIntensity, (v) => {
    lighting.set("lampIntensity", v);
  });
  slider(lampHost, "Cone angle", 0.15, 1.1, 0.01, LIGHT_DEFAULTS.lampAngle, (v) => {
    lighting.set("lampAngle", v);
    syncLamp();
  });
  slider(lampHost, "Lamp height", 0.42, 0.85, 0.005, LIGHT_DEFAULTS.lampHeight, (v) => {
    lighting.set("lampHeight", v);
    syncLamp();
  });

  const glassHost = $("ui-glass");
  slider(glassHost, "Reflectivity", 0, 4, 0.02, GLASS_DEFAULTS.envIntensity, (v) => {
    glass.uniforms.env.value = v;
    glass.material.envMapIntensity = v;
  });
  slider(glassHost, "Fresnel", 0, 1.5, 0.01, GLASS_DEFAULTS.fresnel, (v) => { glass.uniforms.fres.value = v; });
  slider(glassHost, "Edge tint", 0, 2, 0.01, GLASS_DEFAULTS.tint, (v) => { glass.uniforms.tint.value = v; });
  slider(glassHost, "Smudge", 0, 2, 0.01, GLASS_DEFAULTS.smudge, (v) => { glass.uniforms.smudge.value = v; });
  slider(glassHost, "Condensation", 0, 1.5, 0.01, GLASS_DEFAULTS.condensation, (v) => {
    glass.uniforms.cond.value = v;
    glass.material.normalScale.set(v, v);
  });
  slider(glassHost, "Base haze", 0, 0.4, 0.005, GLASS_DEFAULTS.baseOpacity, (v) => { glass.uniforms.baseOp.value = v; });
  toggle(glassHost, "Glass visible", true, (on) => { tank.panes.visible = on; });

  const waterHost = $("ui-water");
  slider(waterHost, "Caustics", 0, 3, 0.02, SUBSTRATE_DEFAULTS.caustics, (v) => {
    substrate.uniforms.caustics.value = v;
  });
  // Lake-material knobs, at dish scale. Every one of these is metres or metre-derived,
  // so the ranges are ~1000x smaller than the equivalent sliders in the v3 lake panel.
  slider(waterHost, "Ripple", 0, 0.5, 0.005, WATER_DEFAULTS.normalStrength, (v) => {
    water.syncParams({ normalStrength: v });
  });
  slider(waterHost, "Ripple scale", 4, 60, 0.5, WATER_DEFAULTS.normalTiling, (v) => {
    water.syncParams({ normalTiling: v });
  });
  slider(waterHost, "Ripple speed", 0, 0.05, 0.0005, WATER_DEFAULTS.flowSpeed, (v) => {
    water.syncParams({ flowSpeed: v });
  });
  slider(waterHost, "Refraction", 0, 0.05, 0.0005, WATER_DEFAULTS.refractionStrength, (v) => {
    water.syncParams({ refractionStrength: v });
  });
  slider(waterHost, "Water tint", 0, 140, 1, WATER_DEFAULTS.absorptionScale, (v) => {
    water.syncParams({ absorptionScale: v });
  });
  slider(waterHost, "Glint", 0, 10, 0.05, WATER_DEFAULTS.glintStrength, (v) => {
    water.syncParams({ glintStrength: v });
  });
  slider(waterHost, "Water level", DISH.floor + 0.002, DISH.floor + 0.032, 0.0005, WATER_DEFAULTS.level, (v) => {
    water.setLevel(v);
    substrate.uniforms.waterLevel.value = v;
  });
  slider(waterHost, "Wet soil", 0, 1.5, 0.01, SUBSTRATE_DEFAULTS.dampness, (v) => {
    substrate.uniforms.dampness.value = v;
  });
  toggle(waterHost, "Water SSR", true, (on) => { water.syncParams({ ssrEnabled: on }); });
  toggle(waterHost, "Water visible", true, (on) => { water.mesh.visible = on; });

  const dustHost = $("ui-dust");
  slider(dustHost, "Motes", 0, 3, 0.02, DUST_DEFAULTS.brightness, (v) => { dust.uniforms.brightness.value = v; });
  slider(dustHost, "Drift speed", 0, 4, 0.02, DUST_DEFAULTS.speed, (v) => { dust.uniforms.speed.value = v; });
  slider(dustHost, "Mote size", 0.0005, 0.005, 0.0001, DUST_DEFAULTS.size, (v) => { dust.material.size = v; });
  toggle(dustHost, "Dust visible", true, (on) => { dust.points.visible = on; });

  const renderHost = $("ui-render");
  slider(renderHost, "Exposure", 0.2, 3, 0.01, 1.0, (v) => { renderer.toneMappingExposure = v; });
  slider(renderHost, "Soil grain", 0, 3, 0.02, SUBSTRATE_DEFAULTS.grain, (v) => {
    substrate.material.normalScale.set(v, v);
  });
  toggle(renderHost, "Bloom", true, (on) => { useBloom = on; });
  toggle(renderHost, "Decor visible", true, (on) => { decor.group.visible = on; });
  toggle(renderHost, "Lamp fixture", true, (on) => { lighting.fixture.group.visible = on; });

  // ── views ─────────────────────────────────────────────────────────────────────────
  document.getElementById("views").addEventListener("click", (e) => {
    const key = e.target?.dataset?.view;
    if (!key || !VIEWS[key]) return;
    for (const b of document.querySelectorAll("#views button")) b.classList.remove("on");
    e.target.classList.add("on");
    camera.position.set(...VIEWS[key].pos);
    controls.target.set(...VIEWS[key].tgt);
    controls.update();
  });

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ── loop ──────────────────────────────────────────────────────────────────────────
  const sFps = $("s-fps"), sDraw = $("s-draws"), sTri = $("s-tris");
  let acc = 0, frames = 0, elapsed = 0, last = performance.now();

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    elapsed += dt;

    controls.update();
    // The lake material carries its own clock uniform rather than using TSL's `time`,
    // so it has to be advanced by hand or the surface is frozen.
    water.update(dt, elapsed);

    if (useBloom) post.render();
    else renderer.render(scene, camera);

    acc += dt; frames++;
    if (acc >= 0.5) {
      if (sFps) sFps.textContent = (frames / acc).toFixed(0);
      if (sDraw) sDraw.textContent = String(renderer.info.render.drawCalls);
      if (sTri) sTri.textContent = (renderer.info.render.triangles / 1000).toFixed(1) + "k";
      acc = 0; frames = 0;
    }
  });

  if (boot) boot.style.display = "none";

  const handle = { renderer, scene, camera, controls, tank, glass, substrate, water, lighting, dust, decor, post };
  // Exposed for console poking: tuning a look means reaching into a material mid-frame,
  // and rebuilding the page for every guess is the slow way to find a number.
  globalThis.__terrarium = handle;
  return handle;
}
