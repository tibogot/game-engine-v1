// ROCK LAB — shows the rock-lab level (tools/rockLabLevel.mjs) from the angles
// that matter for a stylised off-road game: straight down on the rock pile
// (the reference shot), a low chase view, along the wall, the boulder field,
// and the east end where the mesh cliffs stop and the bare terrain slope goes on.
//
// No gameplay and no physics: a car-sized box sits on the track for scale.
// Everything else is the level, loaded through the engine like any game.
// ?tod=<hour> sets the time of day (Sky Pro).
import * as THREE from "three";
import { startV3App, createLevelLoader } from "../../v3/engine.js";
import { SPOTS } from "./spots.js";

const DEFAULT_LEVEL = "/levels/rock-lab.v3proj";

export async function startRockLab({ container, hud, onStatus = () => {} } = {}) {
  onStatus("Starting engine…");
  const app = await startV3App({
    container,
    // Sky Pro (Tidewater's sky and light); a game gets the old procedural sky
    // unless it asks at boot. Its clouds shade the land.
    skyMode: "skypro",
    cloudShadows: true,
    terrainFeatures: { cursor: false },
    splatFeatures: { solo: false },
    preloadPaintTextures: false,
  });

  const levels = createLevelLoader(app, { defaultUrl: DEFAULT_LEVEL, onStatus });
  const level = await levels.loadBoot();

  applyLight(app);

  const car = makeScaleCar();
  const placeCar = () => {
    const { x, z, yaw } = SPOTS.car;
    car.position.set(x, app.getWorldHeight(x, z), z);
    car.rotation.y = yaw;
  };
  placeCar();
  app.scene.add(car);

  app.controls.enableZoom = true;
  const buttons = {};
  const go = (key) => {
    const v = SPOTS.views[key];
    if (!v) return;
    app.camera.position.set(...v.pos);
    app.controls.target.set(...v.target);
    app.controls.update();
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle("on", k === key);
  };

  if (hud) {
    const title = document.createElement("div");
    title.textContent = `Rock lab · ${level.loaded ? level.name : "no level"}`;
    hud.append(title);
    Object.entries(SPOTS.views).forEach(([key, v], i) => {
      const b = document.createElement("button");
      b.textContent = `${i + 1}  ${v.label}`;
      b.onclick = () => go(key);
      buttons[key] = b;
      hud.append(b);
    });
    const carBtn = document.createElement("button");
    carBtn.textContent = "C  Scale car (4.4 m)";
    carBtn.classList.add("on");
    carBtn.onclick = () => { car.visible = !car.visible; carBtn.classList.toggle("on", car.visible); };
    hud.append(carBtn);
    for (const sw of flickerSwitches(app)) {
      const b = document.createElement("button");
      const paint = () => { b.textContent = `${sw.key}  ${sw.label}: ${sw.get() ? "on" : "off"}`; b.classList.toggle("on", sw.get()); };
      b.onclick = () => { sw.set(!sw.get()); paint(); };
      sw.button = b;
      b.dataset.key = sw.key.toLowerCase();
      paint();
      hud.append(b);
    }
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "Drag to orbit, wheel to zoom. Edit the map: open public/levels/rock-lab.v3proj in the editor.";
    hud.append(note);
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const n = Number(e.key);
      const keys = Object.keys(SPOTS.views);
      if (n >= 1 && n <= keys.length) go(keys[n - 1]);
      if (e.key === "c" || e.key === "C") carBtn.click();
      for (const b of hud.querySelectorAll("button[data-key]")) if (e.key.toLowerCase() === b.dataset.key) b.click();
    });
  }
  go("top");
  return { app, car, go, spots: SPOTS };
}

/**
 * Sky Pro at a low autumn afternoon sun: long shadows across the rock pile.
 * ?tod=<hour> starts at another time. Sky Pro brings its own light and air, so
 * the engine's distance and height fog are off (they would haze twice).
 */
function applyLight(app) {
  const params = new URLSearchParams(location.search);
  app.sky?.setMode?.("skypro");
  app.sky?.set?.({ latitude: 50, dayOfYear: 280 });
  const tod = Number(params.get("tod"));
  app.sky?.setTimeOfDay?.(params.has("tod") && Number.isFinite(tod) ? tod : 16.3);
  app.fog?.setHeight?.({ enabled: false });
  app.fog?.setDistance?.({ enabled: false });
  // The rock kit's stone is near white; the reference's is a cool mid grey.
  // One shared palette: rocks, crags and the terrain's cliff layer together.
  app.setRockPalette?.({ tint: "#aab3c2" });
}

/**
 * A/B switches for "the cliffs flicker when the camera moves" — the three
 * suspects, each a live toggle so it can be judged while moving:
 *   S  sun shadows (cascades re-fit to the camera every frame: their texels
 *      crawl over big lit faces as it moves)
 *   E  Sky Pro auto exposure (re-meters the frame: bright cliffs entering or
 *      leaving the view brighten / darken everything)
 *   B  the cliffs' ground-contact band (cliffTerrainBlend: the foot of each
 *      cliff fades to the ground colour over a dithered height band)
 */
function flickerSwitches(app) {
  const cliffMats = () => {
    const mats = new Set();
    app.scene.traverse((o) => {
      for (const m of [].concat(o.material ?? [])) if (m?.userData?.cliffBlend) mats.add(m);
    });
    return [...mats];
  };
  let bandOn = true;
  const saved = new Map();
  let lodOn = true;
  const lodSaved = new Map();
  return [
    {
      // OFF = every rock at full detail (no detail-level swaps at all).
      key: "L", label: "Rock LOD",
      get: () => lodOn,
      set: (on) => {
        lodOn = on;
        for (const t of app.propStore?.types ?? []) {
          if (!lodSaved.has(t)) lodSaved.set(t, t.lodScale);
          t.lodScale = on ? lodSaved.get(t) : 100;
        }
        // Re-read on the next camera move anyway; this applies it at once.
        const inst = window.__V3_DEBUG?.propInstancer;
        if (inst) inst._lodDirty = true;
      },
    },
    {
      key: "S", label: "Sun shadows",
      get: () => app.shadows?.state?.enabled !== false,
      set: (on) => app.shadows?.setEnabled?.(on),
    },
    {
      // The terrain's own heightmap shadow (mountains shading the valley).
      key: "T", label: "Terrain shadows",
      get: () => app.shadows?.state?.terrainShadows !== false,
      set: (on) => app.shadows?.set?.({ terrainShadows: on }),
    },
    {
      key: "E", label: "Auto exposure",
      get: () => app.sky?.skyPro?.autoExposure !== false,
      set: (on) => { if (app.sky?.skyPro) app.sky.skyPro.autoExposure = on; },
    },
    {
      key: "B", label: "Cliff contact band",
      get: () => bandOn,
      set: (on) => {
        bandOn = on;
        for (const m of cliffMats()) {
          const u = m.userData.cliffBlend;
          if (!saved.has(m)) saved.set(m, { band: u.uContactBand.value, noise: u.uBandNoise.value });
          const s = saved.get(m);
          u.uContactBand.value = on ? s.band : 0.0001;
          u.uBandNoise.value = on ? s.noise : 0;
        }
      },
    },
  ];
}

/**
 * A boxy 4x4 the size of a Defender (4.4 x 1.8 m, 2 m tall): orange body, white
 * roof, dark wheels. Only there so the rocks can be judged against a vehicle.
 */
function makeScaleCar() {
  const g = new THREE.Group();
  g.name = "ScaleCar";
  const body = new THREE.MeshStandardMaterial({ color: 0xd2552e, roughness: 0.6 });
  const roof = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(1.8, 0.9, 4.4), body, 0, 0.95, 0);
  add(new THREE.BoxGeometry(1.7, 0.75, 2.9), body, 0, 1.75, -0.5);
  add(new THREE.BoxGeometry(1.74, 0.08, 2.95), roof, 0, 2.14, -0.5);
  const wheel = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 16).rotateZ(Math.PI / 2);
  for (const [x, z] of [[-0.85, 1.4], [0.85, 1.4], [-0.85, -1.4], [0.85, -1.4]]) add(wheel, dark, x, 0.4, z);
  return g;
}
