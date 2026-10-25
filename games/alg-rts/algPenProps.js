// THE PENS' INSIDE (2026-10-25, you, on the zeriba: "keep the old zeriba fences but make some better assets inside
// because they really look cheap"): a pen built by the kit (rtsAlgVillage buildZeriba, the farmstead's pen) leaves
// SPOTS (geo.userData.pens: { kind: "trough" | "hay", x, y, z, yaw }) where its crude stone trough and fodder berm
// stood; here they get the Blender village props kit's trough and haystack (tools/blender/villageProps.py — optimised,
// LOD, the ground blend), children of the piece so they move and turn with it. A pen drawn before the kit has loaded
// waits for it.
import { houseMesh, loadHouses } from "./algHouse.js";

const VP = 1.3;   // (the props kit in real metres, the game's ×1.3 — algVillageLife)
const TYPE = { trough: "trough", hay: "hay", oven: "oven", wood: "wood", jars: "jars", bench: "bench", hives: "hives" };   // (the vprops kit's types — the farmstead's yard too)
let ready = false;
const waiting = [];

/** Load the props kit for the pens (the game's boot, the lab's prepare); resolves when the waiting pens are dressed. */
export function loadPenProps() {
  return loadHouses("vprops").then((parts) => {
    ready = !!parts;
    for (const f of waiting.splice(0)) f();
    return ready;
  });
}

/** A kit piece's pens dressed: its trough and hay on their spots (now, or once the kit has loaded). */
export function dressPens(mesh, pens) {
  if (!pens?.length) return;
  const go = () => {
    for (const p of pens) {
      const h = houseMesh(TYPE[p.kind], "intact", VP);
      if (!h) continue;
      h.position.set(p.x, p.y, p.z);
      h.rotation.y = p.yaw ?? 0;
      if (p.scale) h.scale.multiplyScalar(p.scale);   // (a spot's own size: a pen's fodder heap is not a farm's stack)
      h.userData.penProp = true;
      mesh.add(h);
    }
  };
  if (ready) go(); else waiting.push(go);
}
