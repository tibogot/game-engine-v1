// ── Horse lab: Sky Pro as the scenes' sky ────────────────────────────────────
// The engine's Sky Pro (v3/render/skypro/skyproSky.js — Tidewater's sky:
// atmosphere, cumulus, cirrus, an environment map for the world's ambient).
// Wired like the editor's "skypro" mode (v3/app/worldEnvironment.js):
//   • the key light (sun, or the moon at night) takes the sky's colour and
//     intensity (Tidewater units: ~10 at noon), the hemisphere light goes off —
//     the ambient is the sky's environment map alone;
//   • exposure = Sky Pro's (0.55) × its eye adaptation;
//   • the distance fog takes the sky's horizon colour, so far ground melts into it.
// The dome is 4 km; the lab camera sees 500 m — its colour depends only on the
// view direction and it re-centres on the camera, so it is drawn at 1/10 scale.
import * as THREE from "three";
import { createSkyProSky, skyProSunFromTime } from "../render/skypro/skyproSky.js";

export const SKY = { timeOfDay: 15.5, coverage: 0.42, cirrus: 0.5, exposure: 0.55, autoExposure: true };

export function createLabSky({ renderer, camera, scene, sun, hemi }) {
  const sky = createSkyProSky({ renderer, camera, params: { coverage: SKY.coverage, cirrus: SKY.cirrus, exposure: SKY.exposure, autoExposure: SKY.autoExposure } });
  sky.mesh.scale.setScalar(0.1);                            // 400 m: inside camera.far (500)
  scene.add(sky.mesh);
  scene.background = null;
  let ready = false;
  sky.ready.then(() => { ready = true; }).catch((e) => console.warn("[horse-lab] Sky Pro clouds failed to load; the sky draws without them", e));
  const sunDir = new THREE.Vector3(), buf = new THREE.Vector2();

  function update(dt, target) {
    // live settings
    sky.params.coverage = SKY.coverage; sky.params.cirrus = SKY.cirrus;
    sky.params.exposure = SKY.exposure; sky.params.autoExposure = SKY.autoExposure;
    skyProSunFromTime(SKY.timeOfDay, sunDir);
    renderer.getDrawingBufferSize(buf);
    sky.update(dt, { sunDir, drawingBufferSize: buf });
    if (scene.environment !== sky.environment) scene.environment = sky.environment;
    const L = sky.light();
    const kc = L.keyIsMoon ? [L.moonColor.x, L.moonColor.y, L.moonColor.z] : L.sunColor;
    const m = Math.max(kc[0], kc[1], kc[2], 1e-6);
    sun.color.setRGB(kc[0] / m, kc[1] / m, kc[2] / m, THREE.LinearSRGBColorSpace);
    sun.intensity = m;
    // the sun follows the camera target (its shadow box is ±24 m round it)
    sun.position.copy(target).addScaledVector(L.keyDir, 60);
    sun.target.position.copy(target);
    hemi.intensity = 0;
    renderer.toneMappingExposure = SKY.exposure * sky.exposureFactor(dt);
    if (scene.fog) scene.fog.color.setRGB(L.horizon[0], L.horizon[1], L.horizon[2], THREE.LinearSRGBColorSpace);
  }

  function addGui(gui) {
    const f = gui.addFolder("Sky (Sky Pro)");
    f.add(SKY, "timeOfDay", 0, 24, 0.05).name("time of day (h)");
    f.add(SKY, "coverage", 0, 1, 0.01).name("cloud cover");
    f.add(SKY, "cirrus", 0, 1, 0.01).name("cirrus");
    f.add(SKY, "exposure", 0.1, 2, 0.01).name("exposure");
    f.add(SKY, "autoExposure").name("eye adaptation");
    f.close();
    return f;
  }

  return { sky, update, addGui, get ready() { return ready; } };
}
