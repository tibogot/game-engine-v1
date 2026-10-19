// THE THUNDERLINE CAR (assets-src/car/thunder_car.glb: our rework of "Saba V12 '95 - Low poly model" by
// DanielZhabotinsky, CC BY — credit it in the game). Loaded into the SAME slots as the Lotus
// (chassisModel.js / wheelModel.js), so the old car's physics drives it unchanged:
//   - the body, turned to the chassis frame's +Z front and dropped so the file's wheel centres
//     (±0.92, 0.374, ±1.40, built on the Lotus hard points) sit on the physics hubs (±0.92, −0.1, ±1.40)
//   - one wheel template (the file's front-left wheel, turned to face +X like the right side)
//   - the lamps the car drives: brake lights (Brakelights, TailBar) and headlamp lenses (Headlights,
//     DRL_L, DRL_R), and the headlamp spot mounts in chassis space
// Unoptimised for now (10.7 MB, ~72k tris): the user drives it first, then it gets LODs / KTX2.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { WHEEL_LOCAL } from "../../../../v3/play/modularRoadVehicle.js";

export const THUNDER_CAR_URL = "/games/thunderline/assets-src/car/thunder_car.glb";
const FILE_WHEEL_Y = 0.374; // the file's wheel centre height (its ground is y = 0)

let cached = null;
/** @returns {Promise<{ chassis: {object, brakeLights, headlampLenses, headlampMounts}, wheel: {object, radius, width} }>} */
export function loadThunderCar(url = THUNDER_CAR_URL) {
  cached ??= new GLTFLoader().loadAsync(url);
  return cached.then((gltf) => build(gltf.scene.clone(true)));
}

function build(root) {
  const hubY = WHEEL_LOCAL[0].pos.y;
  const object = new THREE.Group();
  object.name = "ThunderCarGLB";
  const body = new THREE.Group();
  body.rotation.y = Math.PI; // the file's front is −Z; the chassis frame's front is +Z
  body.position.y = hubY - FILE_WHEEL_Y;
  body.add(root);
  object.add(body);

  // the wheels leave the body: the car spins and steers its own copies of one template
  // the TOP-LEVEL wheel nodes only: a multi-material wheel loads as a group "Wheel_FL" whose meshes are
  // named "Wheel_FL_1"… too — taking those emptied the template (the wheels were invisible)
  const wheels = [];
  root.traverse((o) => { if (/^Wheel_/.test(o.name) && !/^Wheel_/.test(o.parent?.name ?? "")) wheels.push(o); });
  const src = wheels.find((w) => w.name === "Wheel_FL") ?? wheels[0];
  for (const w of wheels) w.removeFromParent();
  const wheelRoot = src.clone(true);
  wheelRoot.position.set(0, 0, 0);
  wheelRoot.rotation.set(0, Math.PI, 0); // the left wheel's face turned outward on the right, like the template the car expects
  const wheel = new THREE.Group();
  wheel.name = "ThunderWheel";
  wheel.add(wheelRoot);
  wheel.updateMatrixWorld(true);
  const wb = new THREE.Box3().setFromObject(wheel), ws = wb.getSize(new THREE.Vector3());
  wheel.traverse((o) => { if (o.isMesh) { o.castShadow = /tyre|tire|rim/i.test(`${o.material?.name} ${o.name}`); o.receiveShadow = false; } });

  // lamps and shadows
  const brakeLights = [], headlampLenses = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = !/glass|windshield|interior/i.test(o.name);
    o.receiveShadow = true;
    if (/^(Brakelights|TailBar)/.test(o.name)) brakeLights.push(o);
    if (/^(Headlights|DRL_)/.test(o.name)) headlampLenses.push(o);
  });
  object.updateMatrixWorld(true);
  // the two headlamp spots: the left and right halves of the Headlights mesh, in chassis space
  const head = headlampLenses.find((m) => /^Headlights/.test(m.name));
  let headlampMounts = null;
  if (head) {
    const b = new THREE.Box3().setFromObject(head);
    const c = b.getCenter(new THREE.Vector3()), hx = (b.max.x - b.min.x) / 4;
    headlampMounts = [new THREE.Vector3(c.x - hx, c.y, b.max.z), new THREE.Vector3(c.x + hx, c.y, b.max.z)];
  }
  return {
    chassis: { object, brakeLights, headlampLenses, headlampMounts },
    wheel: { object: wheel, radius: ws.y / 2, width: ws.x },
  };
}
