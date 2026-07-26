// Chassis visual style (procedural box ⇄ Emira GT4 GLB).
//
// Two things this guards.
//
// 1. THE ANCHOR RESTRUCTURE. `chassisMesh` used to BE the body mesh, and every
//    light is parented to it. Swapping styles by toggling `visible` on it would
//    have taken headlights and tail lights down with it (three hides the whole
//    subtree), so it is now a plain Object3D anchor with the body as a child.
//    These tests exist because that failure mode is invisible in the swap itself
//    — the car would look right and simply go dark.
//
// 2. THE RIDE-HEIGHT FIT. CHASSIS_GLB.offsetY drops the model so its own ground
//    plane (y=0 in the file) lands on the physics ground plane. That figure is
//    the SETTLED ride height, which falls out of springStrength, restLength,
//    mass and WHEEL.radius together — change any of them and the body floats or
//    sinks with nothing to catch it. So it is re-measured here rather than
//    trusted.
//
// The GLB itself needs Draco + KTX2 + a GPU, so the model is stubbed; what is
// under test is the Vehicle's swap logic, not the loader.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.chassis.${process.pid}.mjs`);
// Unlike the other vehicle tests this one does NOT stub _buildMeshes — the mesh
// tree is exactly what's under test — so it also has to shim the node materials,
// which live in three/webgpu rather than the plain three entry.
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};")
  .replace(/THREE\.(Mesh\w+?)NodeMaterial/g, "THREE.$1Material"));
const { Vehicle, CHASSIS, HEADLIGHTS, TAILLIGHTS, CHASSIS_GLB_LIGHTS } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const ground = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};

/** A stand-in for the loaded GLB, with the two light groups the real one returns. */
function stubModel() {
  const object = new THREE.Group();
  object.name = "ChassisModelGLB";
  const mk = () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    m.material.emissiveIntensity = 0;
    object.add(m);
    return m;
  };
  return { object, parts: { brakeLights: [mk()], headlampLenses: [mk(), mk()] } };
}
const mkCar = () => {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  return c;
};

console.log("=== STYLE SWAP ===");
{
  const c = mkCar();
  check("defaults to procedural", c.chassisStyle === "procedural");
  check("reports no model before one is handed over", c.hasChassisModel === false);
  check("procedural body is visible", c._chassisProc.visible === true);
  check("asking for glb with NO model falls back instead of blanking the car",
    c.setChassisStyle("glb") === "procedural" && c._chassisProc.visible === true);

  const { object, parts } = stubModel();
  c.setChassisModel(object, parts);
  check("model registers", c.hasChassisModel === true);
  check("handing over a model does NOT switch style by itself",
    c.chassisStyle === "procedural" && object.visible === false);

  check("switching to glb hides the box and shows the model",
    c.setChassisStyle("glb") === "glb" && c._chassisProc.visible === false && object.visible === true);
  check("switching back restores the box",
    c.setChassisStyle("procedural") === "procedural"
    && c._chassisProc.visible === true && object.visible === false);
}

console.log("\n=== THE LIGHTS MUST SURVIVE THE SWAP (the reason for the anchor) ===");
{
  const c = mkCar();
  const { object, parts } = stubModel();
  c.setChassisModel(object, parts);
  c.setChassisStyle("glb");
  check("chassisMesh is an anchor, NOT the body mesh", c.chassisMesh.isMesh !== true);
  check("headlight SpotLights are still parented to the anchor",
    c.headlights.length === 2 && c.headlights.every((l) => l.parent === c.chassisMesh));
  check("the anchor itself is never hidden (it would take the lights with it)",
    c.chassisMesh.visible === true);
  check("procedural tail-light quads are hidden against the model",
    c.taillights.every((m) => m.visible === false));
  check("procedural lamp faces are hidden against the model",
    c.headlamps.every((m) => m.visible === false));
}

console.log("\n=== THE MODEL'S OWN EMISSIVE PARTS GET DRIVEN ===");
{
  const c = mkCar();
  const { object, parts } = stubModel();
  c.setChassisModel(object, parts);
  c.setChassisStyle("glb");
  const brake = parts.brakeLights[0], lens = parts.headlampLenses[0];
  const wasHead = HEADLIGHTS.enabled;

  HEADLIGHTS.enabled = false;
  c.input.handbrake = false; c.input.throttle = 0;
  c._updateTaillights();
  check("tail lights dark when neither braking nor lit", brake.material.emissiveIntensity === 0);
  check("headlamp lenses dark with headlights off", lens.material.emissiveIntensity === 0);

  HEADLIGHTS.enabled = true;
  c._updateTaillights();
  check("headlamp lenses light up with the headlights",
    lens.material.emissiveIntensity === CHASSIS_GLB_LIGHTS.headlampIntensity);
  check("tail lights show the dim running glow",
    brake.material.emissiveIntensity === CHASSIS_GLB_LIGHTS.runningIntensity);

  c.input.handbrake = true;
  c._updateTaillights();
  check("tail lights flare under the handbrake",
    brake.material.emissiveIntensity === CHASSIS_GLB_LIGHTS.brakeIntensity);
  check("brake flare is brighter than the running glow",
    CHASSIS_GLB_LIGHTS.brakeIntensity > CHASSIS_GLB_LIGHTS.runningIntensity);

  const savedT = TAILLIGHTS.enabled;
  TAILLIGHTS.enabled = false;
  c._updateTaillights();
  check("the TAILLIGHTS master switch still governs the model's lights",
    brake.material.emissiveIntensity === 0);
  TAILLIGHTS.enabled = savedT;

  // Procedural style must keep using the procedural quads, untouched by the above.
  c.setChassisStyle("procedural");
  c.input.handbrake = true;
  c._updateTaillights();
  check("procedural style still drives its own quads",
    c.taillights.every((m) => m.visible && m.material.emissiveIntensity === TAILLIGHTS.brakeIntensity));
  HEADLIGHTS.enabled = wasHead;
}

console.log("\n=== PHYSICS IS UNTOUCHED BY THE VISUAL SWAP ===");
{
  const run = (style) => {
    const c = mkCar();
    const { object, parts } = stubModel();
    c.setChassisModel(object, parts);
    c.setChassisStyle(style);
    c.body.pos.set(0, 0.6, 0); c.body.vel.set(0, 0, -12);
    for (let i = 0; i < 400; i++) c.tick({ steerTarget: 0.6, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    return c.body.pos.clone();
  };
  const a = run("procedural"), b = run("glb");
  check("identical trajectory in both styles — the body is cosmetic only",
    a.distanceTo(b) < 1e-9, `divergence ${a.distanceTo(b).toExponential(1)} m`);
}

console.log("\n=== COLLISION-BOX RESIZE ONLY TOUCHES THE PROCEDURAL BODY ===");
{
  const c = mkCar();
  const { object, parts } = stubModel();
  c.setChassisModel(object, parts);
  c.setChassisStyle("glb");
  const savedW = CHASSIS.width;
  CHASSIS.width = 2.4;
  c.applyChassisDims?.();
  check("the GLB is NOT rescaled by a collision-box edit",
    object.scale.x === 1 && object.scale.y === 1 && object.scale.z === 1);
  CHASSIS.width = savedW;
  c.applyChassisDims?.();
}

console.log("\n=== RIDE-HEIGHT FIT (CHASSIS_GLB.offsetY) ===");
{
  const src = readFileSync(join(ROOT, "games/modular-road-v3/chassisModel.js"), "utf8");
  const offsetY = Number(/offsetY:\s*(-?[\d.]+)/.exec(src)?.[1]);
  const scale = Number(/scale:\s*([\d.]+)/.exec(src)?.[1]);

  const c = mkCar();
  c.body.pos.set(0, 1.2, 0); c.body.quat.identity();
  for (let i = 0; i < 600; i++) c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  const settled = c.body.pos.y;

  console.log(`  settled ride height ${settled.toFixed(4)} m  →  needs offsetY ${(-settled).toFixed(4)}`);
  console.log(`  chassisModel.js declares offsetY ${offsetY}, scale ${scale}`);
  check("offsetY matches the measured settled ride height (model would float/sink otherwise)",
    Math.abs(offsetY + settled) < 0.01, `off by ${Math.abs(offsetY + settled).toFixed(4)} m`);
  check("scale is 1.0 — the model is authored at real-world size", scale === 1);
}

console.log("\n=== DEV-PANEL FIT SLIDERS ===");
// A range that does not contain its own default is a silent bug: the input
// clamps on init, the first paint moves the model, and nothing reports it.
{
  const model = readFileSync(join(ROOT, "games/modular-road-v3/chassisModel.js"), "utf8");
  const panel = readFileSync(join(ROOT, "games/modular-road-v3/devPanel.js"), "utf8");
  const defOf = (k) => Number(new RegExp(`${k}:\\s*(-?[\\d.]+)`).exec(model)?.[1]);
  const rangeOf = (id) => {
    const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(panel)?.[0] ?? "";
    return {
      min: Number(/min="(-?[\d.]+)"/.exec(tag)?.[1]),
      max: Number(/max="(-?[\d.]+)"/.exec(tag)?.[1]),
      step: Number(/step="([\d.]+)"/.exec(tag)?.[1]),
    };
  };
  const pairs = [
    ["dv-ch-scale", "scale"], ["dv-ch-x", "offsetX"],
    ["dv-ch-y", "offsetY"], ["dv-ch-z", "offsetZ"],
  ];
  for (const [id, key] of pairs) {
    const d = defOf(key), r = rangeOf(id);
    check(`${id} range contains its default (${key} = ${d})`,
      Number.isFinite(d) && Number.isFinite(r.min) && d >= r.min && d <= r.max,
      `${r.min} .. ${r.max}`);
  }
  check("every fit slider is wired in the panel",
    pairs.every(([id, key]) => new RegExp(`slider\\("${id}",\\s*chFit,\\s*"${key}"`).test(panel)));
  check("CHASSIS_GLB_DEFAULTS is captured for the reset button",
    /CHASSIS_GLB_DEFAULTS\s*=\s*\{\s*\.\.\.CHASSIS_GLB\s*\}/.test(model));
  check("offsetX default is 0 — the file is laterally symmetric", defOf("offsetX") === 0);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
