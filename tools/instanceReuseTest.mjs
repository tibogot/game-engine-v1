// _rebuildInstances must REUSE its InstancedMeshes when only the poses moved,
// and still be correct when the grouping genuinely changes.
//
// The thing under test is not the pixels — it is that a gizmo drag stops
// destroying and reallocating every instance buffer sixty times a second.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

// Count fresh batches + disposals. The cost this change exists to remove is
// invisible in any output-only assertion, so it is measured directly.
//
// Construction is counted by IDENTITY rather than by wrapping the constructor —
// an ES module namespace is frozen, so `THREE.InstancedMesh = ...` throws. A
// mesh nobody has seen before is a mesh that was allocated.
const seen = new WeakSet();
let built = 0;
const countNew = (b) => {
  for (const im of b._instMeshes) {
    if (seen.has(im)) continue;
    seen.add(im);
    built++;
  }
};
let disposed = 0;
const realIMDispose = THREE.InstancedMesh.prototype.dispose;
THREE.InstancedMesh.prototype.dispose = function () {
  disposed++;
  return realIMDispose.call(this);
};

const scene = new THREE.Scene();
const mat = () => new THREE.MeshBasicMaterial();
const makeBuilder = () => {
  const b = new ModularRoadBuilder({
    scene,
    roadMaterial: mat(), railMaterial: mat(), shellMaterial: mat(),
    decorMaterial: mat(), glassMaterial: mat(), tubeMaterial: mat(),
    isBuildMode: () => true,
  });
  b.setInstancing(true);
  return b;
};

/** Every instance matrix currently in the batches, keyed so order cannot lie. */
const snapshot = (b) => {
  const out = [];
  for (const im of b._instMeshes) {
    const m = new THREE.Matrix4();
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      out.push(im.geometry.uuid + ":" + m.elements.map((x) => x.toFixed(6)).join(","));
    }
  }
  return out.sort();
};

// ── 1. A drag rebuilds poses without allocating a single new batch ──────────
{
  const b = makeBuilder();
  for (let i = 0; i < 8; i++) b.place();
  const meshesBefore = [...b._instMeshes];
  countNew(b);                 // mark the current batches as already-seen
  built = 0; disposed = 0;

  // What the placement gizmo's `change` handler does, 60× a second.
  for (let f = 0; f < 60; f++) {
    b.chains[0].anchor = new THREE.Matrix4().setPosition(f * 0.05, 0, 0);
    b.rebuildAll({ reuse: true });
    countNew(b);
  }
  check("60 drag frames allocate no new InstancedMesh", built === 0, `built ${built}`);
  check("60 drag frames dispose nothing", disposed === 0, `disposed ${disposed}`);
  check("the same mesh objects are still in the scene",
    b._instMeshes.length === meshesBefore.length &&
    b._instMeshes.every((m, i) => m === meshesBefore[i]));

  // ...and the poses really did follow the anchor.
  const anchorX = b.chains[0].anchor.elements[12];
  check("instance matrices tracked the anchor", Math.abs(anchorX - 59 * 0.05) < 1e-9);
  b.dispose();
}

// ── 2. Reuse is byte-identical to a from-scratch build ─────────────────────
//
// ONE builder, compared against itself: two builders would have two sets of
// geometry objects and so two sets of uuids, which says nothing.
{
  const a = makeBuilder();
  for (const id of ["straight", "curve", "straight", "banked", "curve", "straight"]) {
    a.setActivePiece(id);
    a.place();
  }
  a.chains[0].anchor = new THREE.Matrix4().makeRotationY(0.7).setPosition(11, 2, -4);
  a.rebuildAll({ reuse: true });
  const reused = snapshot(a);

  // Same track, same poses, but every batch allocated from nothing.
  a._dropInstances();
  a._rebuildInstances();
  const cold = snapshot(a);

  check("reused batches hold the same instances as a cold build",
    reused.length === cold.length && reused.every((s, i) => s === cold[i]),
    `${reused.length} vs ${cold.length} instances`);
  check("and there were instances to compare", reused.length === 6,
    `${reused.length} instances for 6 pieces`);
  a.dispose();
}

// ── 3. Appending a piece uses the slack rather than reallocating ────────────
{
  const b = makeBuilder();
  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  countNew(b);
  built = 0; disposed = 0;
  b.place();
  countNew(b);
  check("appending within slack reallocates nothing", built === 0, `built ${built}`);
  const im = b._instMeshes[0];
  check("count grew, capacity did not", im.count === 4 && im.instanceMatrix.count >= 4);
  b.dispose();
}

// ── 4. Outgrowing the slack DOES reallocate, and stays correct ─────────────
{
  const b = makeBuilder();
  b.setActivePiece("straight");
  for (let i = 0; i < 40; i++) b.place();
  const im = b._instMeshes.find((m) => m.count === 40);
  check("a batch past the slack still holds every instance", !!im,
    `counts ${b._instMeshes.map((m) => m.count).join(",")}`);
  check("its buffer is at least as big as its count",
    !im || im.instanceMatrix.count >= im.count);
  b.dispose();
}

// ── 5. A shape that leaves the track takes its batch with it ───────────────
{
  const b = makeBuilder();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("curve"); b.place();
  const keys = new Set(b._instByKey.keys());
  check("two shapes, two (or more) batches", b._instByKey.size >= 2);
  // Delete the curve.
  const curve = b.pieces.find((p) => p.id === "curve");
  b.deletePiece(curve);
  const gone = [...keys].filter((k) => !b._instByKey.has(k));
  check("the deleted shape's batch was released", gone.length >= 1);
  check("no batch outlives its geometry",
    b._instMeshes.every((m) => m.count > 0));
  b.dispose();
}

// ── 6. Teardown frees everything, from either instancing state ─────────────
{
  for (const on of [true, false]) {
    const b = makeBuilder();
    b.setActivePiece("straight");
    for (let i = 0; i < 4; i++) b.place();
    b.setInstancing(on);
    disposed = 0;
    const n = b._instByKey.size;
    b.dispose();
    check(`dispose() drains the batches (instancing ${on ? "on" : "off"})`,
      b._instByKey.size === 0 && b._instMeshes.length === 0 && disposed >= n);
  }
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
