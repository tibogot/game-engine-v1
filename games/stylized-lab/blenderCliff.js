// THE BLENDER CLIFF — one hero cliff piece made in Blender
// (tools/blender/genshinCliff.py: blocks split by joints and bedding, chisel
// cuts, a high-poly crack pass baked to a normal map and a painted colour
// map), shown in the engine's own light on the stylized lab's meadow, with
// the level's Revo grass on its flat tops (cliffTopGrass.js).
// ?tod=<hour> sets the time of day; ?model=<name> another export in
// /models/stylized-lab/ (default genshin_cliff_A).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { startV3App, createLevelLoader } from "../../v3/engine.js";
import { createCliffTopGrass } from "./cliffTopGrass.js";

const LEVEL = "/levels/stylized-lab.v3proj";
const SPOT = { x: -60, z: 60 };   // flat meadow, west of the path

export async function startBlenderCliff({ container, hud, onStatus = () => {} } = {}) {
  onStatus("Starting engine…");
  const app = await startV3App({
    container, skyMode: "skypro", cloudShadows: true,
    terrainFeatures: { cursor: false }, splatFeatures: { solo: false }, preloadPaintTextures: false,
  });
  await createLevelLoader(app, { defaultUrl: LEVEL, onStatus }).loadBoot();
  const params = new URLSearchParams(location.search);
  app.sky?.setMode?.("skypro");
  app.sky?.set?.({ latitude: 40, dayOfYear: 170 });
  app.sky?.setTimeOfDay?.(params.has("tod") ? Number(params.get("tod")) : 14.5);
  app.fog?.setHeight?.({ enabled: false });
  app.fog?.setDistance?.({ enabled: false });

  onStatus("Loading the Blender cliff…");
  const name = params.get("model") ?? "genshin_cliff_A";
  const gltf = await new GLTFLoader().loadAsync(`/models/stylized-lab/${name}.glb`);
  const cliff = gltf.scene;
  cliff.name = "BlenderCliff";
  // on the LOWEST ground under its footprint: its base runs 3 m below 0 in the model
  const box = new THREE.Box3().setFromObject(cliff);
  let lo = Infinity;
  for (const fx of [0, 0.5, 1]) for (const fz of [0, 0.5, 1]) {
    lo = Math.min(lo, app.getWorldHeight(SPOT.x + box.min.x + (box.max.x - box.min.x) * fx, SPOT.z + box.min.z + (box.max.z - box.min.z) * fz));
  }
  cliff.position.set(SPOT.x, lo, SPOT.z);
  cliff.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = true;
    if (o.material) { o.material.roughness = 0.9; o.material.metalness = 0; }
  });
  app.scene.add(cliff);
  cliff.updateMatrixWorld(true);
  const meshes = [];
  cliff.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const tris = meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
  console.log(`[blender-cliff] ${name}: ${meshes.length} mesh(es), ${tris} tris, ${box.getSize(new THREE.Vector3()).toArray().map((v) => v.toFixed(1)).join(" x ")} m`);

  const topGrass = params.get("topgrass") === "0" ? null : await createCliffTopGrass(app, meshes);

  const g = (dx, dz) => app.getWorldHeight(SPOT.x + dx, SPOT.z + dz);
  const views = [
    { label: "Front", pos: [SPOT.x, g(0, 42) + 7, SPOT.z + 42], target: [SPOT.x, lo + 7, SPOT.z] },
    { label: "Three-quarter", pos: [SPOT.x - 30, g(-30, 30) + 10, SPOT.z + 30], target: [SPOT.x, lo + 6, SPOT.z] },
    { label: "Close — the blocks", pos: [SPOT.x + 9, g(9, 14) + 3, SPOT.z + 14], target: [SPOT.x + 2, lo + 6, SPOT.z] },
    { label: "From above — the grass ledges", pos: [SPOT.x + 4, lo + 30, SPOT.z + 22], target: [SPOT.x, lo + 12, SPOT.z - 4] },
  ];
  const buttons = [];
  const go = (i) => {
    const v = views[i];
    app.camera.position.set(...v.pos);
    app.controls.target.set(...v.target);
    app.controls.update();
    buttons.forEach((b, k) => b.classList.toggle("on", k === i));
  };
  if (hud) {
    const title = document.createElement("div");
    title.textContent = "Blender cliff · Genshin-style";
    hud.append(title);
    views.forEach((v, i) => {
      const b = document.createElement("button");
      b.textContent = `${i + 1}  ${v.label}`;
      b.onclick = () => go(i);
      buttons.push(b);
      hud.append(b);
    });
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = `${Math.round(tris / 1000)}k tris · drag to orbit, wheel to zoom · ?tod=H`;
    hud.append(note);
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const n = Number(e.key);
      if (n >= 1 && n <= views.length) go(n - 1);
    });
  }
  go(0);
  return { app, cliff, go, topGrass };
}
