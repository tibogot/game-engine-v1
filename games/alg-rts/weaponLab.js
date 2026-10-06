// WEAPON LAB — the soldiers' procedural weapons (procWeapons.js, top row) against the Quaternius
// "Ultimate Guns Pack" (assets-src/soldiers/Ultimate Guns Pack-glb, bottom rows), each laid along
// +X at its REAL length (the pack's models are ~1/20 scale), with its triangle count. You,
// 2026-10-07: "check the gun pack — is it better than the procedural, for soldiers and buildings?"
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { WEAPONS, weaponMaterial } from "../shared-rts/procWeapons.js";

const PACK = "/assets-src/soldiers/Ultimate Guns Pack-glb/";
// The pack's long guns, at a plausible real length (m); the hand guns left out.
const PACK_GUNS = {
  "Assault Rifle.glb": 0.9, "Assault Rifle-fpLucho45C.glb": 0.9, "Assault Rifle-Bgvuu4CUMV.glb": 0.9,
  "Submachine Gun.glb": 0.72, "Submachine Gun-nsP3JukU73.glb": 0.72,
  "Sniper Rifle.glb": 1.1, "Sniper Rifle-ASOMZIErq3.glb": 1.1, "Sniper Rifle-TKaBjAEofL.glb": 1.1, "Sniper Rifle-i65hEldsw6.glb": 1.1,
  "Shotgun.glb": 1.0, "Shotgun-ZmPTnh7njL.glb": 1.0, "Shotgun Short Stock.glb": 0.9, "Bullpup.glb": 0.8,
};
const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

export async function startWeaponLab(container) {
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.7;
  container.appendChild(renderer.domElement);
  await renderer.init();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8a8070);
  scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x5a4a38, 2.2));
  const sun = new THREE.DirectionalLight(0xfff2dd, 3.5);
  sun.position.set(-3, 6, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  camera.position.set(2.6, 3.4, 6.2);
  controls.target.set(2.6, 0, 0.6);
  controls.update();

  const labels = [];
  const label = (text, x, z) => {
    const d = document.createElement("div");
    d.textContent = text;
    Object.assign(d.style, { position: "fixed", font: "11px system-ui", color: "#f3ead6", background: "rgba(20,16,12,.75)", padding: "1px 5px", borderRadius: "3px", pointerEvents: "none", transform: "translate(-50%, 0)" });
    document.body.appendChild(d);
    labels.push({ d, p: new THREE.Vector3(x, 0, z + 0.14) });
  };
  // Lay a gun along +X with its length `len`, centred at (x, z).
  const lay = (obj, len, x, z) => {
    const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3());
    const long = Math.max(size.x, size.y, size.z);
    const k = len / long;
    obj.scale.multiplyScalar(k);
    if (size.z === long) obj.rotation.y = Math.PI / 2;
    else if (size.y === long) obj.rotation.z = Math.PI / 2;
    obj.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(obj), c = b2.getCenter(new THREE.Vector3());
    obj.position.set(x - c.x, -c.y, z - c.z);
    scene.add(obj);
  };

  // Top row: ours.
  let i = 0;
  const wm = weaponMaterial();
  for (const [k, w] of Object.entries(WEAPONS)) {
    const g = w.build();
    const m = new THREE.Mesh(g, wm);
    g.computeBoundingBox();
    lay(m, g.boundingBox.getSize(new THREE.Vector3()).z, (i % 6) * 1.3, -0.5);
    label(`${w.label} — ${tris(g)} tris`, (i % 6) * 1.3, -0.5);
    i++;
  }
  // Below: the pack.
  const loader = new GLTFLoader();
  i = 0;
  for (const [f, len] of Object.entries(PACK_GUNS)) {
    const gltf = await loader.loadAsync(PACK + encodeURIComponent(f));
    let n = 0;
    gltf.scene.traverse((o) => { if (o.isMesh) n += tris(o.geometry); });
    const x = (i % 5) * 1.3, z = 0.6 + Math.floor(i / 5) * 0.75;
    lay(gltf.scene, len, x, z);
    label(`${f.replace(".glb", "")} — ${n} tris`, x, z);
    i++;
  }
  const v = new THREE.Vector3();
  renderer.setAnimationLoop(() => {
    controls.update();
    for (const l of labels) {
      v.copy(l.p).project(camera);
      l.d.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
      l.d.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
    }
    renderer.render(scene, camera);
  });
  return { renderer, scene, camera, controls };
}
