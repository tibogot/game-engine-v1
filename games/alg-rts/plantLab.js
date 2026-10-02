// PLANT LAB — the Aurès plants, a bed of each, in a LIGHT scene that loads in
// seconds (you, 2026-10-02: "why build the plant lab on top of the terrain,
// it makes the lab take long to load… a very simple scene and the plants").
//
// What is REAL here, so a plant judged in the lab is the plant in the game:
//   · the plants: the engine's own builders and material (PlacedFoliage →
//     createFoliageTypeGeometry + createFoliageMaterial), FOLIAGE_PRESETS;
//   · the sun and the shadow: the game's numbers (alg-rts, read off the live
//     game 2026-10-02) — intensity 10, colour #fff2dd, its direction, a 2048
//     map over the RTS frustum's ~340 m (a ~17 cm texel: the prickly pear's
//     self-shadow stripes only showed at that), bias 0, normalBias 0.12,
//     PCF radius 2; ACES at exposure 0.55; the RTS camera's 40° lens.
// What is NOT: the sky light is a gradient standing in for the game's baked
// atmosphere, the ground is one photo, no fog, no bloom. Judge the plant
// here; give anything you change one last look in the game.
//
//   beds        one per species, a row west → east; click a name for a close look
//   play zoom   the RTS camera's angle and distance over the row
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PlacedFoliage, FOLIAGE_DOME_CARDS } from "../../v3/render/foliage/placedFoliage.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";

/** At most 16 (PlacedFoliage's type limit). Worst first: the order we work through them. */
const SPECIES = [
  ["pricklyPear", "Prickly pear"], ["thistle", "Thistle"], ["asphodel", "Asphodel"], ["alfa", "Alfa grass"],
  ["agave", "Agave"], ["agaveMast", "Agave in flower"], ["broom", "Broom (genêt)"], ["oleander", "Oleander"],
  ["tamarisk", "Tamarisk (tree)"], ["tamariskShrub", "Tamarisk shrub"], ["typha", "Reed-mace"],
  ["juniperScrub", "Juniper scrub"], ["doumPalm", "Doum palm"],
];
const STEP = 6;   // m between beds
/** The game's sun (alg-rts, Partly cloudy, 15:12). */
const SUN = { dir: new THREE.Vector3(-0.739, 0.65, 0.175).normalize(), intensity: 10, color: 0xfff2dd };

/** A sky to light by: zenith blue, a pale bright horizon, warm desert bounce below (linear, HDR). */
function gradientSky() {
  const W = 64, H = 32, d = new Float32Array(W * H * 4);
  const zen = [0.18, 0.36, 0.75], hor = [0.95, 0.98, 1.0], gnd = [0.32, 0.24, 0.16];
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H;                 // 1 top → 0 bottom
    const el = v * 2 - 1;                        // −1 nadir → 1 zenith
    const c = el > 0 ? hor.map((h, i) => h + (zen[i] - h) * Math.pow(el, 0.55)) : gnd;
    for (let x = 0; x < W; x++) d.set([...c.map((k) => k * 1.6), 1], (y * W + x) * 4);
  }
  const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat, THREE.FloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export async function startPlantLab(container) {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  const sky = gradientSky();
  scene.environment = sky;
  scene.background = sky;

  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 2000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  // The sun, with the game's shadow: the same texel, bias and filter.
  const sun = new THREE.DirectionalLight(SUN.color, SUN.intensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 161, bottom: -161, near: 1, far: 600 });
  sun.shadow.bias = 0;
  sun.shadow.normalBias = 0.12;
  sun.shadow.radius = 2;
  sun.position.copy(SUN.dir).multiplyScalar(300);
  scene.add(sun, sun.target);

  // The ground: a dry soil photo (Poly Haven, CC0) at ~4 m a tile.
  const loader = new THREE.TextureLoader();
  const tex = (f, srgb) => {
    const t = loader.load(`/textures/ground/dry_mud_field_001/dry_mud_field_001_${f}_1k.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(40, 40);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 160).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ map: tex("diff", true), normalMap: tex("nor_gl"), roughness: 1, color: 0xd8c6a8 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // The beds: three of each at different sizes and headings — a species
  // judged by one plant is judged by its seed.
  const pf = new PlacedFoliage({ scene, lodDistances: [60, 140], shadowLods: 3 });
  pf.setSunDir(SUN.dir);
  const x0 = -((SPECIES.length - 1) * STEP) / 2;
  const beds = SPECIES.filter(([k]) => FOLIAGE_PRESETS[k]).map(([key, name], i) => {
    const x = x0 + i * STEP;
    pf.setType(key, structuredClone(FOLIAGE_PRESETS[key]));
    for (const [dx, dz, s, seed] of [[0, 0, 1, 0.13], [-1.4, 1.6, 0.8, 0.47], [1.5, 1.3, 0.65, 0.81]]) {
      pf.add(key, x + dx, -0.05, dz, { rotY: seed * 9, scale: s, seed });
      // As in the game (algLandmarks): a mast grows out of an agave.
      if (key === "agaveMast" && pf.types.has("agave")) pf.add("agave", x + dx - 0.2, -0.08, dz, { rotY: seed * 5, scale: 0.9 * s + 0.2, seed: (seed + 0.3) % 1 });
    }
    return { key, name, x, z: 0, size: FOLIAGE_PRESETS[key].size ?? 1 };
  });

  // A 1.75 m man for scale.
  {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0x8a7a5a, roughness: 0.9 });
    const man = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.3, 4, 10), m);
    man.position.set(x0 - STEP, 0.87, 0);
    man.castShadow = true;
    scene.add(man);
  }

  /** Close up on a bed, from the camera side (−z… the sun's side, lit). */
  function look(bed) {
    const r = Math.max(2.4, bed.size * 1.7);
    controls.target.set(bed.x, bed.size * 0.4, 0.6);
    camera.position.set(bed.x + r * 0.5, r * 0.7, 0.6 + r * 1.2);
    controls.update();
  }
  /** The RTS camera: its 40° lens, pitched ~42° at play zoom, ~77 m out. */
  function play(dist = 77, pitchDeg = 42) {
    const p = (pitchDeg * Math.PI) / 180;
    controls.target.set(0, 0, 0);
    camera.position.set(0, Math.sin(p) * dist, Math.cos(p) * dist);
    controls.update();
  }

  const el = document.createElement("div");
  el.innerHTML = `<style>
    #plab { position: fixed; left: 12px; top: 12px; z-index: 50; width: 230px; padding: 12px 14px 14px;
      background: rgba(22,17,12,.92); color: #e8dcc4; font: 12px "Segoe UI", system-ui, sans-serif;
      border: 1px solid #4a3a28; border-radius: 6px; }
    #plab h1 { margin: 0 0 8px; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; }
    #plab h2 { margin: 12px 0 6px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: #b8a27e; }
    #plab .g { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
    #plab button { padding: 5px 6px; font: inherit; color: #e8dcc4; background: #2c2218; border: 1px solid #4a3a28;
      border-radius: 4px; cursor: pointer; text-align: left; }
    #plab button:hover { background: #3a2c1f; }
    #plab p { margin: 8px 0 0; color: #9c8b70; line-height: 1.4; }
  </style>
  <div id="plab"><h1>Plant Lab</h1>
    <h2>Canopy tree fix (B)</h2><div class="g"><button data-ab="before">◀ Before</button><button data-ab="after">After ▶</button></div>
    <p id="plab-ab">After: rounded light kept + inner shadow. Applies to the tamarisk tree here and nam-rts's dipterocarps.</p>
    <h2>Views</h2><div class="g"><button data-play="77">Play zoom</button><button data-play="30">Zoomed in</button></div>
    <h2>Beds</h2><div class="g">${beds.map((b, i) => `<button data-bed="${i}">${b.name}</button>`).join("")}</div>
    <p>The game's sun, shadow and exposure; a stand-in sky. Drag to orbit, wheel to zoom.</p></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.ab) ab(b.dataset.ab);
    if (b.dataset.bed) look(beds[+b.dataset.bed]);
    if (b.dataset.play) play(+b.dataset.play, +b.dataset.play > 50 ? 42 : 36);
  });

  // BEFORE / AFTER for the canopy-tree fix (the shared dipterocarp builder):
  // the shader's no-flip switch, and the type rebuilt with or without its
  // baked inner shadow.
  let showing = "after";
  function ab(which) {
    showing = which;
    FOLIAGE_DOME_CARDS.value = which === "after" ? 1 : 0;
    for (const key of ["tamarisk"]) {
      if (pf.types.has(key)) pf.setType(key, { ...structuredClone(FOLIAGE_PRESETS[key]), selfOcclusion: which === "after" });
    }
    for (const btn of el.querySelectorAll("[data-ab]")) btn.style.background = btn.dataset.ab === which ? "#6b4a24" : "";
  }
  addEventListener("keydown", (e) => { if (e.key === "b" || e.key === "B") ab(showing === "after" ? "before" : "after"); });
  ab("after");

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  look(beds[0]);
  renderer.setAnimationLoop(() => {
    controls.update();
    pf.update(camera);
    renderer.render(scene, camera);
  });
  return { renderer, scene, camera, controls, pf, beds, look, play, ab, bed: (key) => look(beds.find((b) => b.key === key)) };
}
