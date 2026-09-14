// Prop foundation (v3/tools/propStore.js + propInstancer.js): stable ids,
// selection that survives swap-removes, growing meshes, exact picking.
import * as THREE from "three";
import { PropStore } from "../v3/tools/propStore.js";
import { PropInstancer } from "../v3/tools/propInstancer.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

const scene = new THREE.Scene();
const store = new PropStore();
const inst = new PropInstancer(scene, store);
const cube = store.registerPrimitive("Cube");
const sphere = store.registerPrimitive("Sphere");
const torus = store.registerPrimitive("Torus");
for (const t of [cube, sphere, torus]) inst.onTypeRegistered(t);
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
const cfg = { lod0Distance: 60, lod1Distance: 150, fadeOutDistance: 2000 };

// ── Stable ids ───────────────────────────────────────────────────────────────
for (let i = 0; i < 10; i++) store.addInstance(sphere, i * 10, 0, 0);
const ids = store.instances.map((p) => p.id);
check("every prop gets a unique id", new Set(ids).size === 10 && ids.every((id) => id > 0));
store.removeInstance(2);
check("ids survive a swap-remove", store.instances[2].id === ids[9] && store.indexOfId(ids[9]) === 2 && store.indexOfId(ids[2]) === -1);
const dup = store.duplicateInstance(0);
check("a duplicate is a NEW prop (new id)", store.instances[dup].id !== ids[0], `${store.instances[dup].id} vs ${ids[0]}`);
const snap = store.snapshot();
store.restoreFromSnapshot(snap);
check("undo snapshots keep ids", store.instances.map((p) => p.id).join() === snap.map((p) => p.id).join());
const saved = store.exportData([]);
check("ids are not written to project files", saved.instances.every((p) => !("id" in p)));

// ── Bug: the gizmo moved a different prop after a brush erase ────────────────
store.clear();
for (let i = 0; i < 10; i++) store.addInstance(sphere, i * 10, 0, 0);
inst.update(cam, cfg);
let lost = 0;
inst.onSelectionLost = () => lost++;
inst.select(2);                                   // prop at x = 20
store.removeInRadius(20, 0, 1);                   // Alt-paint erases that prop
inst.proxyObject.position.z += 5;                 // user drags the (stale) gizmo
inst.syncFromProxy();
check("dragging after the selected prop was erased moves NOTHING", store.instances.every((p) => p.pz === 0),
  store.instances.filter((p) => p.pz !== 0).map((p) => p.px).join(","));
inst.update(cam, cfg);
check("…and the selection is dropped with a callback", !inst.hasSelection && lost === 1);

inst.select(store.indexOfId(store.instances[5].id));
const selId = inst.selectedId;
const selX = store.instances[inst.selectedIdx].px;
store.removeInRadius(store.instances[0].px, 0, 1);   // erase a DIFFERENT prop
inst.update(cam, cfg);
check("erasing another prop keeps the selection on the same prop", inst.selectedId === selId && store.instances[inst.selectedIdx].px === selX);

// Group drag after one member is erased.
store.clear();
for (let i = 0; i < 6; i++) store.addInstance(sphere, i * 10, 0, 0);
inst.update(cam, cfg);
inst.setSelection([1, 3, 5]);
store.removeInRadius(10, 0, 1);                   // erase group member at x = 10
inst.update(cam, cfg);
inst.proxyObject.position.z += 4; inst.syncFromProxy();
const movedX = store.instances.filter((p) => p.pz !== 0).map((p) => p.px).sort((a, b) => a - b);
check("group drag after erasing a member moves only the remaining members", movedX.join() === "30,50", movedX.join());

// ── Bug: 4,096 cap ───────────────────────────────────────────────────────────
store.clear();
for (let i = 0; i < 6000; i++) store.addInstance(cube, (i % 100) * 1.5 - 75, 0, Math.floor(i / 100) * 1.5 - 45, { sx: 0.5, sy: 0.5, sz: 0.5 });
cam.position.set(0, 140, 60); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
inst._lodDirty = true; inst.update(cam, cfg);
const drawn = inst._typeRender[cube].lod0.reduce((s, e) => Math.max(s, e.im.count), 0);
check("6,000 props of one type all draw (meshes grow past 4,096)", drawn === 6000, `${drawn}`);
const im = inst._typeRender[cube].lod0[0].im;
const m = new THREE.Matrix4(); im.getMatrixAt(5999, m);
const p = new THREE.Vector3().setFromMatrixPosition(m);
check("…with correct matrices past the old cap", p.lengthSq() > 0);

// ── Bug: picks hit the bounding box ──────────────────────────────────────────
store.clear();
// The primitive torus is lifted to sit on y=0 (centre at local y=0.52); rotated
// 90° about X that centre lands at z=+0.52×20, so shift it back to the origin.
store.addInstance(torus, 0, 0, -0.52 * 20, { rx: 90, sx: 20, sy: 20, sz: 20 });   // big ring lying flat, centred on 0
store.addInstance(sphere, 0, 0, 0);                                         // 1 m ball in the hole
cam.position.set(0, 60, 0.01); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
inst.update(cam, cfg);
const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(0, 0), cam);
const hit = inst.raycast(ray);
// Sanity: the ball really is inside the ring's bounding box (so a box pick would take the ring).
inst._ensurePickBoxes();
{ const b = inst._pickBoxes; const ringBox = [0, 1].map((ci) => ({ ci, t: store.instances[inst._cacheToStore[ci]].typeIdx })).find((e) => e.t === torus);
  const o = ringBox.ci * 6;
  check("(setup) the ball sits inside the ring's box", b[o] < -1 && b[o + 3] > 1 && b[o + 2] < -1 && b[o + 5] > 1 && b[o + 1] < 0.5 && b[o + 4] > 0.5); }
check("clicking through a ring's hole picks the ball inside it", hit && store.instances[hit.instIdx].typeIdx === sphere,
  hit ? store.types[store.instances[hit.instIdx].typeIdx].name : "nothing");
// Aim at the ring itself (radius 0.4 × 20 = 8 m from the centre).
ray.set(new THREE.Vector3(8, 60, 0), new THREE.Vector3(0, -1, 0));
const hit2 = inst.raycast(ray);
check("clicking the ring picks the ring", hit2 && store.instances[hit2.instIdx].typeIdx === torus);
ray.set(new THREE.Vector3(4.5, 60, 0), new THREE.Vector3(0, -1, 0));   // inside the hole, beside the ball
check("clicking empty space inside the ring's box picks nothing", inst.raycast(ray) === null);

// ── Pick speed at 20k ────────────────────────────────────────────────────────
store.clear();
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let i = 0; i < 20000; i++) store.addInstance(i % 2 ? sphere : cube, (rnd() - 0.5) * 800, 0, (rnd() - 0.5) * 800, { ry: rnd() * 360 });
cam.position.set(0, 120, 450); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
inst.update(cam, cfg);
ray.setFromCamera(new THREE.Vector2(0.05, -0.1), cam);
inst.raycast(ray);                     // builds boxes once
const t0 = performance.now();
for (let i = 0; i < 20; i++) inst.raycast(ray);
const per = (performance.now() - t0) / 20;
check("a pick among 20,000 props stays fast", per < 5, `${per.toFixed(2)} ms`);

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
