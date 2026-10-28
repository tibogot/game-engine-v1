// THUNDERLINE ASSET LAB (asset-lab.html — user, 2026-10-28: "a lab page that shows the new assets we are making").
// Every asset of the catalogue (assetLabCatalog.js) on the road of the test track, in the drive page's world, light and
// shadows, the car parked behind it for scale. It draws through the GAME's own code — obstacles.js obstacleLook,
// physProps.js's loader and materials — so what it shows is what plays. Per asset: the new model against the old look,
// side by side; as placed in the game or one alone; each level of detail, or chosen by distance as the game will;
// its wireframe; and what it costs (triangles, draws, texture memory).
//   ?asset=<id> · ?tod=<h>
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { startV3App } from "../../../../v3/engine.js";
import { createDriveRig } from "./driveSession.js";
import { applyWorld, TIMES, groundFeatures } from "./worlds.js";
import { loadPhysAssets, physModel, physOldLook, PROP_LOD_FAR } from "./physProps.js";
import { OBSTACLES, obstacleLook } from "./obstacles.js";
import { SECTIONS, ENTRIES, STATUS } from "./assetLabCatalog.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const V = THREE.Vector3;

// ---------- the engine: the drive page's own setup (drive.js) ----------
const app = await startV3App({
  container: $("game"),
  skyMode: "skypro",
  cloudShadows: true,
  light: { envIntensity: 0.45, hemiIntensity: 0.6, dirIntensity: 2.6, exposure: 1.0, shadowNormalBias: 0.12 },
  terrainFeatures: { cursor: false },
  splatFeatures: groundFeatures(),
  terrainLayers: 3,
  preloadPaintTextures: false,
  csm: { cascades: 2 },
});
app.sky?.setMode?.("skypro");
let tod = Number(params.get("tod")) || 15.5;
app.sky?.setTimeOfDay?.(tod);
app.fog?.setHeight?.({ enabled: false });
app.postFx?.setEnabled?.(true);
app.postFx?.setBloomSelective?.(true);
app.postFx?.setBloom?.({ enabled: true, strength: 0.9, threshold: 0.0, radius: 0.5 });
const { camera, renderer, scene } = app;
app.controls.update = () => {};
app.controls.enabled = false;
camera.far = Math.max(camera.far, 9000);
applyWorld(app, "flat");

// the car, parked on the test track's start straight (the drive session's own: its model, light and shadows)
const rig = createDriveRig(app, { ghost: false, sunShadows: true, fx: false });
await rig.start({ help: "" });
rig.setTimeScale(0);
await Promise.all([rig.modelsReady, loadPhysAssets()]);

// ---------- THE STAGE: on the road, 25 m ahead of the car (out of the start gate's shadow) ----------
const car = rig.vehicle;
const carPos = (car.renderPos ?? car.body.pos).clone();
const fwd = new V(0, 0, 1).applyQuaternion(car.body.quat).setY(0).normalize();
// (x = up × forward: a right-handed frame — fwd × up made a MIRRORED stage, the drum's stencil read backwards)
const up = new V(0, 1, 0), right = new V().crossVectors(up, fwd).normalize();
const stagePos = carPos.clone().addScaledVector(fwd, 25);
{
  const ray = new THREE.Raycaster(stagePos.clone().add(new V(0, 6, 0)), new V(0, -1, 0), 0, 20);
  const hit = ray.intersectObject(rig.session.group, true)[0];
  stagePos.y = hit ? hit.point.y : carPos.y - 0.5;
}
const stage = new THREE.Group();
stage.matrixAutoUpdate = false;
stage.matrix.makeBasis(right, up, fwd).setPosition(stagePos);
scene.add(stage);

// ---------- the orbit (the drive session's chase camera is overruled each frame) ----------
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
orbit.maxPolarAngle = Math.PI * 0.49;
const view = { pos: new V(), quat: new THREE.Quaternion() };
// (the wheel's zoom is applied inside its event, between frames: kept here, or the next frame put back the pose it
// had saved before — "why can't I zoom in the lab")
orbit.addEventListener("change", () => { view.pos.copy(camera.position); view.quat.copy(camera.quaternion); });
function frameOn(obj, from = "front") {
  const box = new THREE.Box3().setFromObject(obj), sph = box.getBoundingSphere(new THREE.Sphere());
  const d = Math.max(2.2, sph.radius * 3.2);
  orbit.target.copy(sph.center);
  // from in front of the asset, looking back at it with the car behind it (its scale at a glance)
  const dir = from === "front" ? fwd.clone().multiplyScalar(0.85).addScaledVector(right, 0.45).addScaledVector(up, 0.32) : up.clone().addScaledVector(fwd, 0.2);
  camera.position.copy(sph.center).addScaledVector(dir.normalize(), d);
  camera.lookAt(sph.center);
  orbit.update();
  view.pos.copy(camera.position); view.quat.copy(camera.quaternion);
}

// ---------- what is shown ----------
const state = { entry: null, version: "both", arrange: "game", lod: "auto", wire: false, spin: false };
let shown = []; // [{ mesh, lods, wire }] — the meshes of the model (their level swapped by distance)
const wireMat = new THREE.MeshBasicNodeMaterial({ color: 0x9dff00, wireframe: true, transparent: true, opacity: 0.55, depthWrite: false });
const LOD_FAR = PROP_LOD_FAR; // m: level 1 from here, level 2 from there — the game's own (physProps.js)

function bodiesOf(entry) {
  const all = OBSTACLES[entry.obstacle]?.phys ?? [];
  return state.arrange === "game" ? all : all.slice(0, 1);
}
function modelGroup(entry, which) {
  const g = new THREE.Group();
  const model = which === "new" ? physModel(entry.kind) : null;
  const old = which === "old" ? physOldLook(entry.kind) : null;
  for (const b of bodiesOf(entry)) {
    const geo = model ? model.lods[0] : old.geometry;
    const m = new THREE.Mesh(geo, model ? model.material : old.material);
    m.castShadow = m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.matrix.copy(b.local);
    const w = new THREE.Mesh(geo, wireMat);
    w.visible = state.wire;
    m.add(w);
    g.add(m);
    if (model) shown.push({ mesh: m, wire: w, lods: model.lods });
  }
  return g;
}
function build() {
  for (const c of [...stage.children]) stage.remove(c);
  shown = [];
  const e = state.entry;
  const hasNew = !!(e.kind && physModel(e.kind));
  let groups = [];
  if (!hasNew) {
    // not made yet: the look the game draws today
    const g = obstacleLook(e.obstacle, {});
    groups = [{ g, at: 0 }];
  } else {
    const hasOld = !!physOldLook(e.kind);
    const want = !hasOld ? ["new"] : state.version === "both" ? ["old", "new"] : [state.version];
    for (const which of want) groups.push({ g: modelGroup(e, which), which });
    if (groups.length === 2) {
      const size = new THREE.Box3().setFromObject(groups[1].g).getSize(new V());
      if (size.x < 4) {
        // the old on the LEFT, the new on the RIGHT as the camera sees them (it looks back at the stage from in front)
        const r = size.x / 2 + 0.6;
        groups[0].at = [-r, 0]; groups[1].at = [r, 0];
      } else {
        // a wide one (a cone row across the road): one behind the other — the old nearer the car, the new in front
        const r = size.z / 2 + 6;
        groups[0].at = [0, -r]; groups[1].at = [0, r];
      }
    }
  }
  for (const { g, at } of groups) { g.position.set(at?.[0] ?? 0, 0, at?.[1] ?? 0); stage.add(g); }
  stage.updateMatrixWorld(true);
  render();
}

// ---------- what it costs ----------
const tris = (g) => Math.round((g.index ? g.index.count : g.attributes.position.count) / 3);
function texBytes(t) {
  if (!t) return 0;
  if (t.userData?.ktx2 && t.mipmaps?.length) return t.mipmaps.reduce((s, m) => s + (m.data?.byteLength ?? 0), 0);
  const im = t.image; return im?.width ? Math.round(im.width * im.height * 4 * 4 / 3) : 0;
}
function costText(e) {
  const model = e.kind && physModel(e.kind);
  const n = bodiesOf(e).length || 1;
  const lines = [];
  if (model) {
    const L = model.lods.map(tris);
    const m = model.material, texs = [...new Set([m.map, m.normalMap, m.roughnessMap, m.aoMap].filter(Boolean))];
    const mb = texs.reduce((s, t) => s + texBytes(t), 0) / 1048576;
    const fmt = texs.every((t) => t.userData?.ktx2) ? "KTX2" : "PNG: npm run textures";
    lines.push(`NEW  triangles  ${L.map((t, i) => `LOD${i} ${t}`).join(" · ")}`);
    lines.push(`     placed     ${n} × ${L[0]} = ${n * L[0]}`);
    lines.push(`     draws      1 per kind (instanced) + shadow`);
    lines.push(`     textures   ${texs.length} · ${mb.toFixed(1)} MB GPU · ${fmt}`);
    const old = e.kind && physOldLook(e.kind);
    if (old) lines.push(`OLD  triangles  ${tris(old.geometry)} · no texture`);
  } else {
    const g = obstacleLook(e.obstacle, {});
    let t = 0, d = 0; g.traverse((o) => { if (o.isMesh) { t += tris(o.geometry) * (o.count ?? 1); d++; } });
    lines.push(`NOW  triangles   ${t} · draws ${d} · the old look (no new model yet)`);
  }
  return lines.join("\n");
}

// ---------- the panel ----------
function chip(status) { const s = STATUS[status]; return `<span class="chip" style="--c:${s.color}">${s.label}</span>`; }
function renderList() {
  $("list").innerHTML = SECTIONS.map((s) => `<h2>${s.label}</h2>` +
    ENTRIES.filter((e) => e.section === s.id).map((e) => `<button class="entry${e === state.entry ? " on" : ""}" data-id="${e.id}"><span>${e.label}</span>${chip(e.status)}</button>`).join("")).join("");
  for (const b of $("list").querySelectorAll(".entry")) b.onclick = () => { b.blur(); pick(b.dataset.id); };
}
function btns(el, items, isOn, onPick, disabled = false) {
  el.innerHTML = "";
  for (const [k, label] of items) {
    const b = document.createElement("button");
    b.textContent = label;
    b.classList.toggle("on", isOn(k));
    b.disabled = disabled;
    b.onclick = () => { b.blur(); onPick(k); render(); };
    el.appendChild(b);
  }
}
function render() {
  const e = state.entry;
  const hasNew = !!(e.kind && physModel(e.kind));
  $("title").textContent = e.label;
  $("status").innerHTML = chip(e.status);
  $("about").textContent = e.about ?? "";
  $("script").textContent = e.script ? `Made by ${e.script} · node tools/thunderObstacles.mjs ${e.id}` : "";
  const hasOld = !!(e.kind && physOldLook(e.kind));   // (none left once the model replaced it for good)
  btns($("version"), [["both", "Old | New"], ["new", "New"], ["old", "Old"]], (k) => (hasOld ? k === state.version : k === "new"), (k) => { state.version = k; build(); }, !hasNew || !hasOld);
  btns($("arrange"), [["game", "As in the game"], ["single", "One"]], (k) => k === state.arrange, (k) => { state.arrange = k; build(); frameOn(stage); }, !hasNew);
  btns($("lod"), [["auto", "By distance"], [0, "LOD 0"], [1, "LOD 1"], [2, "LOD 2"]], (k) => k === state.lod, (k) => { state.lod = k; }, !hasNew);
  btns($("toggles"), [["wire", "Wireframe"], ["spin", "Turn round"]], (k) => state[k], (k) => { state[k] = !state[k]; for (const s of shown) s.wire.visible = state.wire; orbit.autoRotate = state.spin; });
  btns($("tods"), TIMES.map(([h, n]) => [h, n]), (k) => k === tod, (k) => { tod = k; app.sky?.setTimeOfDay?.(tod); rig.rebakeSunShadows(); });
  btns($("views"), [["front", "Frame"], ["top", "From above"]], () => false, (k) => frameOn(stage, k));
  $("cost").textContent = costText(e);
  renderList();
}
function pick(id) {
  state.entry = ENTRIES.find((e) => e.id === id) ?? ENTRIES[0];
  try { localStorage.setItem("thunderline.assetLab.entry", state.entry.id); } catch {}
  history.replaceState(null, "", `${location.pathname}?asset=${state.entry.id}`);
  build();
  frameOn(stage);
}

// ---------- every frame: after the drive session's (its chase camera moved the camera: ours again) ----------
let last = performance.now(), n = 0;
app.addPreUpdateHook(function assetLabFrame() {
  const now = performance.now(), dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  camera.position.copy(view.pos); camera.quaternion.copy(view.quat); camera.up.set(0, 1, 0);
  if (camera.fov !== 50) { camera.fov = 50; camera.updateProjectionMatrix(); }
  orbit.update(dt);
  view.pos.copy(camera.position); view.quat.copy(camera.quaternion);
  // the level of detail: chosen, or by the camera's distance to each piece
  const _p = new V();
  for (const s of shown) {
    let i = state.lod;
    if (i === "auto") { const d = camera.position.distanceTo(s.mesh.getWorldPosition(_p)); i = d > LOD_FAR[1] ? 2 : d > LOD_FAR[0] ? 1 : 0; }
    const g = s.lods[Math.min(i, s.lods.length - 1)];
    if (s.mesh.geometry !== g) { s.mesh.geometry = g; s.wire.geometry = g; }
  }
  if (++n % 15 === 0 && shown.length) {
    const d = camera.position.distanceTo(orbit.target);
    const lv = shown.map((s) => s.lods.indexOf(s.mesh.geometry));
    $("live").textContent = `camera ${d.toFixed(1)} m · showing LOD ${[...new Set(lv)].join(", ")}`;
  } else if (!shown.length) $("live").textContent = "";
});

const first = params.get("asset") ?? (() => { try { return localStorage.getItem("thunderline.assetLab.entry"); } catch { return null; } })();
pick(ENTRIES.some((e) => e.id === first) ? first : ENTRIES[0].id);
$("boot").classList.add("gone");
setTimeout(() => $("boot").remove(), 600);
window.__assetLab = { app, rig, stage, state, pick, frameOn, build };
