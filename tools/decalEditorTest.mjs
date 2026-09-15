// Decals (v3/render/decals + v3/tools/decalEditor.js): placement maths, what a
// click does (place / select / deselect), undo, and the project round trip.
import * as THREE from "three";
import { decalMatrix, decalContains, pickDecal, orientDecal, remapSlotsAfterRemove } from "../v3/render/decals/decalMath.js";
import { createDecalEditor } from "../v3/tools/decalEditor.js";
import { encodeProjectFile, decodeProjectFile } from "../v3/io/projectIO.js";
import { ProjectAssets } from "../v3/io/projectAssets.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ── Maths ──
const flat = { id: 1, px: 10, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1, sx: 4, sy: 2, sz: 6, priority: 0, slot: 0 };
check("a point inside the box is covered", decalContains(flat, V(11.9, 0.9, 2.9)));
check("a point past the width is not", !decalContains(flat, V(12.1, 0, 0)));
check("a point above the projection depth is not", !decalContains(flat, V(10, 1.1, 0)));

const n = V(1, 1, 0).normalize();
const q = orientDecal(n, 0.7);
check("surface orientation points local +Y along the normal", V(0, 1, 0).applyQuaternion(q).distanceTo(n) < 1e-6);
const tilted = { ...flat, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
check("a tilted box covers points along its own axes", decalContains(tilted, V(10, 0, 0).addScaledVector(n, 0.9)) && !decalContains(tilted, V(10, 0, 0).addScaledVector(n, 1.1)));
const m = decalMatrix(tilted);
check("the matrix scales the unit box to the decal size", near(V().setFromMatrixScale(m).y, 2));

const low = { ...flat, id: 2, priority: 0 };
const high = { ...flat, id: 3, priority: 5 };
const newer = { ...flat, id: 4, priority: 0 };
check("pick: higher priority wins where decals overlap", pickDecal([high, low, newer], V(10, 0, 0)) === high);
check("pick: equal priority, the newer one (drawn on top) wins", pickDecal([newer, low], V(10, 0, 0)) === newer);
check("pick: nothing where no box covers", pickDecal([low], V(50, 0, 0)) === null);

const slotted = [{ slot: 0 }, { slot: 1 }, { slot: 2 }, { slot: 3 }];
remapSlotsAfterRemove(slotted, 1);
check("removing a texture: its decals fall back to 0, later ones shift down", slotted.map((d) => d.slot).join() === "0,0,1,2");

// ── Editor clicks (a data-only stand-in for the renderer) ──
let nextId = 1;
const system = {
  decals: [],
  textures: { slots: [{ name: "A" }, { name: "B" }] },
  add(p) {
    const d = { opacity: 1, priority: 0, slot: 0, ...p };
    if (!Number.isInteger(d.id) || this.get(d.id)) d.id = nextId;
    nextId = Math.max(nextId, d.id + 1);
    this.decals.push(d);
    return d;
  },
  get(id) { return this.decals.find((d) => d.id === id) ?? null; },
  remove(id) { const i = this.decals.findIndex((d) => d.id === id); if (i >= 0) this.decals.splice(i, 1); return i >= 0; },
  duplicate(id, o) { const { id: _, ...r } = this.get(id); return this.add({ ...r, px: r.px + o.x, py: r.py + o.y, pz: r.pz + o.z }); },
  pick(p) { return pickDecal(this.decals, p); },
  matrixOf: (d, t) => decalMatrix(d, t),
  markDirty() {},
  snapshot() { return JSON.stringify(this.decals); },
  restore(s) { this.decals.length = 0; for (const d of JSON.parse(s)) this.add(d); },
};
let gizmo = null;
const ed = createDecalEditor({
  system, scene: new THREE.Scene(),
  attachGizmo: (d) => { gizmo = d.id; }, detachGizmo: () => { gizmo = null; },
});
ed.setActive(true);
ed.place.randomRotation = false;
ed.place.size = 3;
const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 20, 20);

const slope = { point: V(0, 5, 0), normal: V(0, 1, 1).normalize() };
check("click on bare ground places a decal", ed.click(slope, camera) === "place" && system.decals.length === 1);
const first = system.decals[0];
check("…selected, with the gizmo on it", ed.selectedId === first.id && gizmo === first.id);
check("…projected into the clicked slope", V(0, 1, 0).applyQuaternion(new THREE.Quaternion(first.qx, first.qy, first.qz, first.qw)).distanceTo(slope.normal) < 1e-6);
check("…at the placement size", first.sx === 3 && first.sz === 3 && first.sy === ed.place.depth);

check("click on empty ground with one selected deselects", ed.click({ point: V(40, 0, 0), normal: V(0, 1, 0) }, camera) === "deselect" && ed.selectedId === null && gizmo === null);
check("click on the painted decal selects it", ed.click({ point: V(0.5, 5, 0), normal: slope.normal }, camera) === "select" && ed.selectedId === first.id);
check("Shift+click places on top of it", ed.click({ point: V(0.5, 5, 0), normal: slope.normal }, camera, { shift: true }) === "place" && system.decals.length === 2);

ed.place.align = "down";
ed.deselect();
ed.click({ point: V(60, 0, 0), normal: V(1, 0, 0) }, camera);
const down = system.get(ed.selectedId);
check("Straight down ignores the surface normal", V(0, 1, 0).applyQuaternion(new THREE.Quaternion(down.qx, down.qy, down.qz, down.qw)).distanceTo(V(0, 1, 0)) < 1e-6);

const count = system.decals.length;
ed.edit({ opacity: 0.25 });
check("a panel edit changes the decal", down.opacity === 0.25);
ed.history.undo();
check("undo reverts the edit", system.get(down.id).opacity === 1);
ed.history.undo();
check("undo removes the last placement", system.decals.length === count - 1);
ed.history.redo();
check("redo brings it back with the same id", system.decals.length === count && !!system.get(down.id));

ed.select(down.id);
const copy = ed.duplicateSelected();
check("duplicate copies the look beside the original", copy && copy.id !== down.id && copy.opacity === system.get(down.id).opacity && Math.hypot(copy.px - down.px, copy.pz - down.pz) > 0.1);
check("…and selects the copy", ed.selectedId === copy.id);
ed.deleteSelected();
check("delete removes the selected decal", !system.get(copy.id) && ed.selectedId === null);

// ── Project file ──
const decals = {
  slots: [{ name: "Crater", albedoUrl: "/textures/crater-decal.png", normalUrl: null }, { name: "Mine", albedoUrl: "asset:" + "a".repeat(40), normalUrl: null }],
  decals: system.decals.map(({ id, ...r }) => r),
};
const out = decodeProjectFile(encodeProjectFile({ terrain: { worldSize: 1024 }, decals }));
check("decals survive the project file", JSON.stringify(out.decals) === JSON.stringify(decals));
check("a project without decals loads none", decodeProjectFile(encodeProjectFile({ terrain: { worldSize: 1024 } })).decals === null);
check("an imported decal texture is written with the project", ProjectAssets.referencedHashes({ decalSlots: decals.slots }).has("a".repeat(40)));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
