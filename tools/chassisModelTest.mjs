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
const TMP2 = TMP;
const {
  Vehicle, CHASSIS, HEADLIGHTS, TAILLIGHTS, CHASSIS_GLB_LIGHTS, TIRE, WHEEL, WHEEL_LOCAL,
  WHEEL_LAYOUT, BODYLEAN,
} = await import(pathToFileURL(TMP).href);
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
  /**
   * The rear HOUSING, which the real loader distinguishes by the presence of a
   * `_tailIntensity` uniform — its emissive is position-masked to the rear of a
   * mesh whose material also covers the front lenses, so it cannot be driven by
   * the material-wide emissiveIntensity the strip uses.
   *
   * The stub carried only ONE rear mesh, which is why it could not see the
   * two-element split at all. A plain `{ value }` object stands in for the TSL
   * uniform: the vehicle only ever writes `.value`.
   */
  const mkHousing = () => {
    const m = mk();
    m.material._tailIntensity = { value: 0 };
    return m;
  };
  return {
    object,
    parts: { brakeLights: [mkHousing(), mk()], headlampLenses: [mk(), mk()] },
  };
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
  /* TWO ELEMENTS, TWO JOBS — this assertion changed with the tail housing.
   *
   * It used to read `brakeLights[0]` and expect the running glow, which was
   * right while a single mesh did both functions. It no longer is: the HOUSING
   * carries the tail lamp and the STRIP is the stop lamp, so the strip is dark
   * at running and only appears under braking. That is the point — braking now
   * changes the lit AREA, which is what you recognise in a mirror, rather than
   * only its brightness.
   *
   * The housing is the element carrying `_tailIntensity` (its emissive is
   * position-masked to the rear, so it cannot use the material-wide intensity
   * the strip does); identify by that rather than by array order. */
  const housing = parts.brakeLights.find((m) => m.material._tailIntensity);
  const strip = parts.brakeLights.find((m) => !m.material._tailIntensity);
  check("the two rear elements are distinguishable", !!housing && !!strip,
    "the housing carries a _tailIntensity uniform; the strip does not");
  if (housing) {
    check("the HOUSING shows the running glow (it is the tail lamp)",
      housing.material._tailIntensity.value === CHASSIS_GLB_LIGHTS.runningIntensity);
  }
  if (strip && CHASSIS_GLB_LIGHTS.stripIsStopLamp) {
    check("the STRIP stays dark at running (it is the stop lamp)",
      strip.material.emissiveIntensity === 0,
      `${strip.material.emissiveIntensity} — braking must change the lit AREA, not just brightness`);
  }

  c.input.handbrake = true;
  c._updateTaillights();
  if (housing) {
    check("the housing flares under the handbrake",
      housing.material._tailIntensity.value === CHASSIS_GLB_LIGHTS.brakeIntensity);
  }
  if (strip) {
    check("...and the strip lights up with it",
      strip.material.emissiveIntensity === CHASSIS_GLB_LIGHTS.brakeIntensity);
  }
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

  // THE OLD ASSERTION HERE ENFORCED A BUG. It required offsetY == −settled,
  // i.e. the model's own ground plane sitting exactly on the physics ground —
  // and treated that coincidence as proof the body fitted the wheels. It is not:
  // the arches are cut for the wheel the body was modelled around, not for
  // WHEEL.radius. Measured in the running page, that "correct" fit had the tyres
  // 1.9 cm (front) and 2.6 cm (rear) INSIDE the bodywork while parked.
  //
  // What actually has to hold is CLEARANCE, and it has to survive the car
  // moving. The arch geometry needs the GLB (Draco + KTX2 + a GPU) so it cannot
  // be raycast here; it is pinned as a measured constant instead, and the
  // dynamic half — which is pure maths on constants this file already has — is
  // recomputed every run so a lean or suspension retune moves the requirement.
  const GROUND_ALIGNED_OFFSET_Y = -0.595; // fit at which clearance was measured
  const MEASURED_CLEAR_AT_THAT_FIT = { front: -0.019, rear: -0.026 };
  const lift = offsetY - GROUND_ALIGNED_OFFSET_Y; // clearance is linear in this
  const clearF = MEASURED_CLEAR_AT_THAT_FIT.front + lift;
  const clearR = MEASURED_CLEAR_AT_THAT_FIT.rear + lift;

  // Worst-case dynamic closure at an arch: the wheel rising on its bump stop,
  // plus whatever body lean is left after archCompensate.
  const suspRise = 0.137 - TIRE.minSuspExt;
  const leanDrop = (1 - BODYLEAN.archCompensate) * (
    WHEEL_LAYOUT.halfTrack * Math.sin(BODYLEAN.maxRoll)
    + Math.abs(WHEEL_LOCAL[0].pos.z) * Math.sin(BODYLEAN.maxPitch)
  );
  const needed = suspRise + leanDrop;

  console.log(`  settled ride height ${settled.toFixed(4)} m`);
  console.log(`  chassisModel.js declares offsetY ${offsetY}, scale ${scale}`);
  console.log(`  static arch clearance: front ${(clearF * 100).toFixed(1)} cm, rear ${(clearR * 100).toFixed(1)} cm`);
  console.log(`  worst dynamic closure: ${(needed * 100).toFixed(1)} cm`
    + ` (susp ${(suspRise * 100).toFixed(1)} + lean ${(leanDrop * 100).toFixed(1)})`);

  check("the tyres are not inside the bodywork at rest",
    clearF > 0 && clearR > 0,
    `front ${(clearF * 100).toFixed(1)} cm, rear ${(clearR * 100).toFixed(1)} cm`);
  check("…and the arch still clears the tyre at full bump + full lean",
    clearF >= needed && clearR >= needed,
    `have ${(Math.min(clearF, clearR) * 100).toFixed(1)} cm, need ${(needed * 100).toFixed(1)} cm`);
  check("the body is not lifted further than it needs to be (car would stand tall)",
    Math.min(clearF, clearR) < needed + 0.04,
    `${(Math.min(clearF, clearR) * 100).toFixed(1)} cm vs ${(needed * 100).toFixed(1)} cm needed`);
  check("scale is 1.0 — the model is authored at real-world size", scale === 1);
}

console.log("\n=== WHEEL DROOP (TIRE.maxDroop) ===");
// Airborne there is no ground hit, so the visual suspension eases to the full
// PROBE length and the wheels hang far below the body. maxDroop clamps that, and
// it is squeezed between two limits that are easy to cross without noticing:
//   too LOW  → the wheels are pulled up into the bodywork while simply parked
//   too HIGH → it stops clamping and the droop bug is back
{
  const c = mkCar();
  c.body.pos.set(0, 1.2, 0); c.body.quat.identity();
  for (let i = 0; i < 600; i++) c.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  // Ground sits at chassis-local -settled; a planted wheel centre is radius above it.
  const staticDroop = WHEEL_LOCAL[0].pos.y - (-c.body.pos.y + WHEEL.radius);
  const airborneDroop = TIRE.rayLength - WHEEL.radius; // what it would be, unclamped

  console.log(`  parked droop      ${staticDroop.toFixed(3)} m`);
  console.log(`  unclamped airborne ${airborneDroop.toFixed(3)} m   → clamped to ${TIRE.maxDroop}`);
  console.log(`  visible travel on a jump ${(TIRE.maxDroop - staticDroop).toFixed(3)} m`);

  check("maxDroop actually clamps (below the unclamped airborne value)",
    TIRE.maxDroop < airborneDroop, `${TIRE.maxDroop} < ${airborneDroop.toFixed(3)}`);
  check("maxDroop clears the parked droop — parked wheels must not be pulled up",
    TIRE.maxDroop > staticDroop, `${TIRE.maxDroop} > ${staticDroop.toFixed(3)}`);
  check("leaves visible suspension travel (a rigid car reads as broken too)",
    TIRE.maxDroop - staticDroop > 0.03, `${(TIRE.maxDroop - staticDroop).toFixed(3)} m`);
  check("travel stays in the plausible range for a race car (< 0.15 m)",
    TIRE.maxDroop - staticDroop < 0.15);
}

console.log("\n=== DRAW-CALL BUDGET (classification vs the real GLB) ===");
// The loader can't run here (Draco + KTX2 + a GPU), but its CLASSIFICATION is
// just regexes over node/material names — and that is exactly the part that
// silently rots when a model is re-exported with different node names. So the
// GLB's JSON chunk is parsed directly and the loader's OWN regexes (pulled from
// its source, not copied) are run against it.
{
  const src = readFileSync(join(ROOT, "games/modular-road-v3/chassisModel.js"), "utf8");
  const reOf = (name) => {
    const m = new RegExp(`const ${name} = (/[^\\n]*?/[gimsuy]*);`).exec(src);
    return m ? new RegExp(m[1].slice(1, m[1].lastIndexOf("/")), m[1].slice(m[1].lastIndexOf("/") + 1)) : null;
  };
  const RE = {
    interior: reOf("RE_INTERIOR"), lens: reOf("RE_HEADLIGHT_LENS"),
    emissive: reOf("RE_EMISSIVE"), glass: reOf("RE_GLASS"), sil: reOf("RE_SILHOUETTE"),
  };
  check("all five classification regexes found in the loader source",
    Object.values(RE).every(Boolean));

  const buf = readFileSync(join(ROOT, "public/models/chassis_compressed.glb"));
  const gltf = JSON.parse(buf.toString("utf8", 20, 20 + buf.readUInt32LE(12)));
  const meshes = gltf.nodes.filter((n) => n.mesh != null).map((n) => ({
    name: n.name,
    mat: gltf.materials[gltf.meshes[n.mesh].primitives[0].material]?.name ?? "",
  }));
  const tag = (m) => `${m.name} ${m.mat}`;

  const interior = meshes.filter((m) => RE.interior.test(m.name));
  const lenses = meshes.filter((m) => !RE.interior.test(m.name) && RE.lens.test(m.name));
  const emissive = meshes.filter((m) => !RE.interior.test(m.name) && !RE.lens.test(m.name) && RE.emissive.test(tag(m)));
  const glass = meshes.filter((m) => !RE.interior.test(m.name) && !RE.lens.test(m.name)
    && !RE.emissive.test(tag(m)) && RE.glass.test(tag(m)));
  const casters = meshes.filter((m) => RE.sil.test(tag(m)));

  console.log(`  file has ${meshes.length} meshes: ${interior.length} cabin, ${glass.length} glass, `
    + `${lenses.length} lens, ${emissive.length} emissive, ${casters.length} silhouette`);

  check("cabin regex catches exactly the 6 interior meshes", interior.length === 6,
    interior.map((m) => m.name.replace(/^emira_gt4(_int)?LOD_A_/, "").slice(0, 18)).join(", "));
  check("no EXTERIOR mesh is misread as cabin (would delete visible bodywork)",
    !interior.some((m) => /^emira_gt4LOD_A_(BODY|GLASS|HEADLIGHT|BRAKES)/.test(m.name)));
  check("both headlight lenses are found", lenses.length === 2);
  check("the tail-light mesh is found", emissive.length === 1);
  check("four windows left to merge", glass.length === 4);
  check("exactly 2 shadow casters — the outer body and the aero", casters.length === 2,
    casters.map((m) => m.mat).join(", "));

  // 4 windows → 1 draw, 2 lenses → 1 draw.
  const drawn = meshes.length - interior.length - (glass.length - 1) - (lenses.length - 1);
  const before = meshes.length + 2 * 3;
  const after = drawn + casters.length * 3;
  console.log(`  draws/frame at 3 cascades:  ${before} → ${after}   (procedural box = 4)`);
  check("the optimisation actually removes draw calls", after < before, `${before} → ${after}`);
  check("drawn meshes account for every kept part", drawn === 8, `${drawn}`);
  check("ghost bake is a dedicated export — spawn must not clone the live GLB",
    /export function bakeGhostCarGeometry/.test(src));
  check("ghost bake keys off the silhouette regex (body+aero only)",
    /bakeGhostCarGeometry[\s\S]*RE_SILHOUETTE\.test/.test(src));
}

console.log("\n=== MERGE SAFETY (KHR_mesh_quantization) ===");
// This shipped broken and spammed the console every frame:
//   "Vertex buffer arrayStride (6) is not a multiple of 4 ... renderPipeline_mm_windows"
// The GLB stores POSITION as NORMALIZED INT16, so 3 components is a 6-byte
// stride and WebGPU rejects it. The unmerged meshes are fine — three pads them
// on upload — but a geometry we hand-build to mergeGeometries gets no such help.
//
// The same fix covers a second, quieter bug: applying the node matrix BEFORE
// dequantizing writes world-space metres into an int16 normalised to [-1,1].
{
  const { mergeGeometries } = await import("three/addons/utils/BufferGeometryUtils.js");
  const src = readFileSync(join(ROOT, "games/modular-road-v3/chassisModel.js"), "utf8");
  check("loader dequantizes before baking the node matrix (order matters)",
    src.indexOf("dequantizeGeometry(g)") < src.indexOf("g.applyMatrix4"),
    "dequantizeGeometry must come first");

  const quantized = () => {
    const g = new THREE.BufferGeometry();
    const q = (v) => Math.round(v * 32767);
    const a = new THREE.BufferAttribute(
      new Int16Array([q(-0.5), 0, 0, q(0.5), 0, 0, 0, q(0.5), 0]), 3,
    );
    a.normalized = true;
    g.setAttribute("position", a);
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    return g;
  };
  const dequantize = (g) => {
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name];
      if (a.array instanceof Float32Array && !a.normalized) continue;
      const out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) {
        for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
      }
      g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
    }
  };
  const stride = (a) => a.itemSize * a.array.BYTES_PER_ELEMENT;

  check("raw quantized POSITION really does have an illegal stride",
    stride(quantized().attributes.position) % 4 === 2, "6 bytes — the reported error");

  const geos = [0, 1, 2, 3].map((i) => {
    const g = quantized();
    dequantize(g);
    g.applyMatrix4(new THREE.Matrix4().makeTranslation(i, 0, 2.07));
    return g;
  });
  const merged = mergeGeometries(geos, false);
  check("dequantized geometries merge without returning null", !!merged);
  check("merged vertex count is the sum of the inputs", merged?.attributes.position.count === 12);
  check("EVERY merged attribute has a WebGPU-legal stride (multiple of 4)",
    !!merged && Object.values(merged.attributes).every((a) => stride(a) % 4 === 0),
    merged ? Object.entries(merged.attributes).map(([k, a]) => `${k}:${stride(a)}`).join(" ") : "");
  check("the node transform survives dequantization intact",
    !!merged && Math.abs(merged.attributes.position.getZ(0) - 2.07) < 1e-3,
    `z0 = ${merged?.attributes.position.getZ(0).toFixed(3)}`);
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
