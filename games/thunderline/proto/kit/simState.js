// A SIMULATION'S STATE, SAVED AND PUT BACK (2026-10-24, the incremental test lap — user: "the point of this
// editor is to be very fast"). The builder's test lap keeps the car as it enters each piece; after an edit
// it carries on from the last one before the change instead of driving the whole track again.
//
// The car (v3/play/modularRoadVehicle.js) grows its state as it drives — dozens of fields set outside its
// constructor — so this walks it: numbers, booleans, strings, vectors / quaternions / matrices (copied),
// typed arrays (copied), plain objects, arrays and the car's own class instances (its body, its tyres),
// recursively. NOT state, skipped: scene objects, meshes, materials, geometry, textures, functions, and
// the shared things named in SKIP (collision trees, the floor, the scene, raycasters). Restoring writes
// every value back INTO the same objects, so references held elsewhere stay valid.
//
// The test lap must stay exact (the author time and the medals come from it): simStateTest.mjs drives a
// track, saves mid-way, drives on, restores, drives again, and wants the two endings bit for bit.

const SKIP = new Set([
  "scene", "group", "raycaster", "groundBvh", "solidsBvh", "collidables", "walls", "wallBoxes", "dynamicMovers",
  "deckCarryMovers", "getFloorY", "_bvhRay", "_castGround", "_castSphereSweep", "chassisMesh", "tireGroups",
  "arrowGroup", "arrows", "headlights", "headlightTargets", "headlamps", "taillights", "_wheelInstances",
  "_wheelParts", "_ground", "_solids", "ground", "solids", "bvh", "mesh", "parent", "vehicle", "car",
]);
const SKIPPED = Symbol("skipped");
const MAX_DEPTH = 6;
const isValue = (v) => v.isVector2 || v.isVector3 || v.isVector4 || v.isQuaternion || v.isMatrix3 || v.isMatrix4 || v.isEuler || v.isColor;

function save(v, depth, seen) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === "function" || t === "symbol") return SKIPPED;
  if (t !== "object") return v;
  if (ArrayBuffer.isView(v)) return v.slice();
  if (isValue(v)) return v.clone();
  if (v.isObject3D || v.isMaterial || v.isBufferGeometry || v.isTexture || v.isBufferAttribute) return SKIPPED;
  if (depth > MAX_DEPTH || seen.has(v)) return SKIPPED; // (a cycle, or a shared structure reached twice: not the car's own)
  seen.add(v);
  if (Array.isArray(v)) return { arr: v.map((x) => save(x, depth + 1, seen)) };
  const o = {};
  for (const k of Object.keys(v)) {
    if (SKIP.has(k)) continue;
    const s = save(v[k], depth + 1, seen);
    if (s !== SKIPPED) o[k] = s;
  }
  return { obj: o };
}

function put(target, key, s) {
  const cur = target[key];
  if (s === null || s === undefined || typeof s !== "object") { target[key] = s; return; }
  if (ArrayBuffer.isView(s)) {
    if (cur && ArrayBuffer.isView(cur) && cur.length === s.length) cur.set(s); else target[key] = s.slice();
    return;
  }
  if (isValue(s)) { if (cur?.copy && cur.constructor === s.constructor) cur.copy(s); else target[key] = s.clone(); return; }
  if (s.arr) {
    if (!Array.isArray(cur)) { target[key] = s.arr.map((x) => (x && typeof x === "object" && (x.obj || x.arr) ? undefined : x)); }
    const a = target[key];
    a.length = s.arr.length;
    s.arr.forEach((x, i) => { if (x !== SKIPPED) put(a, i, x); });
    return;
  }
  if (s.obj) {
    if (!cur || typeof cur !== "object") target[key] = {};
    restoreInto(target[key], s);
  }
}
function restoreInto(target, s) {
  for (const [k, v] of Object.entries(s.obj)) put(target, k, v);
}

/** The state of `obj` (a car, …) now. */
export function saveState(obj) { return save(obj, 0, new WeakSet()); }
/** Put a saved state back into the SAME object it came from (or one built the same way). */
export function restoreState(obj, state) { restoreInto(obj, state); }
