// THE CAR VIEW: the new car (public/models/thunderline/thunder_car.glb) parked next to the Lotus in the game's own
// world — Sky Pro, the drive page's light, the flat world — so the user judges it as it will look in the
// game before it replaces the Lotus (user, 2026-10-19). Not part of the game.
import * as THREE from "three";
import { getSharedGltfLoader, initGlbLoaderRenderer } from "../../../v3/render/foliage/glbLoader.js";
import { startV3App } from "../../../v3/engine.js";
import { Vehicle } from "../../../v3/play/modularRoadVehicle.js";
import { createVehicleGround } from "../../../v3/play/modularRoadGround.js";
import { loadChassisModel, CHASSIS_GLB_URL, chassisGlbMounts } from "../../modular-road-v3/chassisModel.js";
import { loadWheelModel } from "../../modular-road-v3/wheelModel.js";
import { applyWorld } from "./kit/worlds.js";
import { THUNDER_CAR_URL } from "./kit/thunderCar.js";

const $ = (id) => document.getElementById(id);
const app = await startV3App({
  container: $("game"),
  skyMode: "skypro",
  cloudShadows: true,
  light: { envIntensity: 0.45, hemiIntensity: 0.6, dirIntensity: 2.6, exposure: 1.0, shadowNormalBias: 0.12 },
  terrainFeatures: { cursor: false },
  splatFeatures: { solo: false },
  preloadPaintTextures: false,
  csm: { cascades: 2 },
});
app.sky?.setMode?.("skypro");
app.sky?.setTimeOfDay?.(15.5);
app.fog?.setHeight?.({ enabled: false });
app.postFx?.setEnabled?.(true);
app.postFx?.setBloomSelective?.(true);
app.postFx?.setBloom?.({ enabled: true, strength: 0.9, threshold: 0.0, radius: 0.5 });
applyWorld(app, "flat");
const { scene, camera, controls, renderer } = app;

// ---------- the Lotus: the game's own car object, parked (as the drive rig does) ----------
const LOTUS_X = 2.6, NEW_X = -2.6;
const lotus = new Vehicle({ scene, showArrows: false });
const ground = createVehicleGround({ getTerrainHeight: (x, z) => app.getWorldHeight(x, z) });
lotus.setBvh(ground.ground, ground.solids);
lotus.getFloorY = (x, z) => app.getWorldHeight(x, z);
lotus.setSolidCapsules([]);
lotus.setSpawn(new THREE.Vector3(LOTUS_X, 0.6, 0), new THREE.Quaternion());
lotus.setEnabled(true); // a disabled Vehicle hides itself: enabled, held by the handbrake every frame
lotus.respawn();
try {
  const m = await loadChassisModel(renderer, CHASSIS_GLB_URL);
  lotus.setHeadlampMounts(chassisGlbMounts(m.headlampMountsLocal));
  lotus.setChassisModel(m.object, { brakeLights: m.brakeLights, headlampLenses: m.headlampLenses });
  lotus.setChassisStyle("glb");
  const w = await loadWheelModel(renderer);
  lotus.setWheelModel(w.object, { radius: w.radius, thickness: w.width });
  lotus.setWheelStyle("glb");
} catch (e) { console.warn("[carview] Lotus not loaded", e); }


// ---------- the new car: the exported glTF as it is (Blender +Y forward → three −Z: turned to face +Z like the Lotus) ----------
initGlbLoaderRenderer(renderer); // the shared loader: KTX2 textures + meshopt geometry (v3/TEXTURE_COMPRESSION.md)
const gltf = await getSharedGltfLoader().loadAsync(THUNDER_CAR_URL);
const car = gltf.scene;
car.rotation.y = Math.PI;
car.position.set(NEW_X, 0, 0);
// as the game: only the ShadowProxy hull casts, and it is never drawn in the view
car.traverse((o) => { if (o.isMesh) { const proxy = /^ShadowProxy/.test(o.name) || /^ShadowProxy/.test(o.parent?.name ?? ""); o.castShadow = proxy; o.receiveShadow = !proxy; if (proxy) o.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }); } });
scene.add(car);
const wheels = [];
car.traverse((o) => { if (/^Wheel_/.test(o.name)) wheels.push(o); });
console.info("[carview] new car", { meshes: (() => { let n = 0; car.traverse((o) => o.isMesh && n++); return n; })(), wheels: wheels.map((w) => w.name) });

// ---------- views ----------
controls.target.set(0, 0.7, 0);
const VIEWS = {
  front34: [6.5, 1.8, 7.5], side: [0, 1.2, 10], rear34: [-6.5, 2.0, -7.5], chase: [-2.6, 2.0, -7.5],
};
let spin = false;
function view(k) {
  spin = k === "spin";
  if (spin) return;
  const v = VIEWS[k];
  camera.position.set(...v);
  controls.target.set(0, 0.7, 0);
  controls.update();
}
view("front34");
for (const b of document.querySelectorAll("[data-v]")) b.onclick = () => view(b.dataset.v);
for (const b of document.querySelectorAll("[data-t]")) b.onclick = () => app.sky?.setTimeOfDay?.(Number(b.dataset.t));
let a = 0.8;
app.addPreUpdateHook(function carviewFrame(dt) {
  lotus.tick({ throttle: 0, steerTarget: 0, rollTarget: 0, yaw: 0, pitch: 0, handbrake: true, analog: false });
  lotus.syncVisuals(dt, 0);
  if (spin) {
    a += dt * 0.35;
    camera.position.set(Math.sin(a) * 9, 2.0, Math.cos(a) * 9);
    controls.target.set(0, 0.7, 0);
    camera.lookAt(controls.target);
  }
});
$("boot").classList.add("gone");
window.__carview = { app, car, lotus, view };
