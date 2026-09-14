// A prop transform edit — a gizmo drag or an Inspector field — is ONE undo
// step, and a gizmo click that moves nothing adds none (v3/AUDIT.md #89).
// Gizmo drags were not undoable at all before.
import * as THREE from "three";
import { PropStore } from "../v3/tools/propStore.js";
import { PropInstancer } from "../v3/tools/propInstancer.js";
import { PropSystem } from "../v3/tools/propSystem.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

const store = new PropStore();
const instancer = new PropInstancer(new THREE.Scene(), store);
const cube = store.registerPrimitive("Cube");
instancer.onTypeRegistered(cube);
const sys = new PropSystem({ propState: {}, propSlots: [], propBrush: {}, propStore: store, propInstancer: instancer, getWorldHeight: () => 0, worldSize: 1000 });

store.addInstance(cube, 10, 0, 20);
store.addInstance(cube, -5, 0, 0);
instancer.select(0);
const at = () => store.instances[store.indexOfId(instancer.selectedId)];

// A gizmo drag: many proxy moves between one begin and one end.
sys.beginEdit();
for (let i = 1; i <= 30; i++) { instancer.proxyObject.position.x = 10 + i; instancer.syncFromProxy(); }
check("the drag is recorded", sys.endEdit() === true && at().px === 40);
sys.undo();
check("one undo takes the whole drag back", store.instances[store.indexOfId(1)]?.px === 10, `${store.instances[0].px}`);
sys.redo();
check("redo puts it back", store.instances[store.indexOfId(1)]?.px === 40);

// A click on the gizmo that does not drag.
instancer.select(store.indexOfId(1));
sys.beginEdit();
instancer.syncFromProxy();
check("a gizmo click without movement adds no step", sys.endEdit() === false);

// An Inspector field: update the store, one step.
const before = sys._undoStack.length;
sys.beginEdit();
store.updateInstance(store.indexOfId(1), { ry: 45 });
sys.endEdit();
check("an Inspector edit is one step", sys._undoStack.length === before + 1);
sys.undo();
check("…and undoes to the previous rotation", store.instances[store.indexOfId(1)].ry === 0);

// begin twice keeps the first "before" (a nested begin must not drop the drag start).
instancer.select(store.indexOfId(1));
sys.beginEdit();
store.updateInstance(store.indexOfId(1), { px: 99 });
sys.beginEdit();
store.updateInstance(store.indexOfId(1), { px: 100 });
sys.endEdit();
sys.undo();
check("a nested begin keeps the original start", store.instances[store.indexOfId(1)].px === 40);

sys.beginEdit();
check("with nothing selected, nothing is recorded", (instancer.clearSelection(), sys.endEdit()) === false);

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
