// A CLONE DOES NOT OWN THE GEOMETRY IT POINTS AT.
//
// Every "load/build once, clone per placement" prop — all of the scenery, the
// shipping container, the tire wall — hands out `template.clone()`, and
// Object3D.clone() copies the node but SHARES the BufferGeometry by reference.
// Four different places then free geometry as if the object they were handed
// owned it:
//
//   roadGame.clearBrush            disarming a brush ghost
//   PropManager._disposeInstance   deleting a prop, or any track load
//   PropInstancer._template        discarding the scaffolding after cloning parts
//   mergeByMaterial                collapsing a tree it was given
//
// Any one of them frees the buffer out from under every other prop of that type
// AND under the next ghost, which clones the same dead geometry:
//
//   TypeError: Failed to execute 'setIndexBuffer' on 'GPURenderPassEncoder':
//   parameter 1 is not of type 'GPUBuffer'
//
// every frame, from whichever object still references it. It is invisible until
// the draw — dispose() releases the GPU buffer but leaves the CPU arrays intact,
// so the geometry still reports a healthy index and position count.
//
// Fixed for scenery first (commit 6fda3b0) and then hit AGAIN on the container,
// because the flag lived in modularRoadScenery.js and the GLB props never got
// it. So this file pins the rule at the level it actually belongs to: any module
// that clones a template marks it, and every disposer honours the mark.
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { markSharedGeometry, isSharedGeometry, mergeByMaterial } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBatching.js")).href);
const { PropInstancer } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js")).href);
const { PropManager } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadProps.js")).href);

/** dispose() fires a "dispose" event on the geometry — the only headless way to
 *  see the thing that, in the browser, is only visible as a null GPUBuffer. */
function watch(root) {
  const freed = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry) o.geometry.addEventListener("dispose", () => freed.push(o.name));
  });
  return freed;
}

/**
 * A stand-in for the GLB props, built the same way they are: a few meshes on one
 * root, merged by material, then marked. Two of the three meshes share a
 * material so mergeByMaterial has something to collapse — that is the path where
 * the instancer's throwaway copy would free the real thing.
 */
function buildTemplate({ mark = true } = {}) {
  const root = new THREE.Group();
  root.name = "FakeContainer";
  const shell = new THREE.MeshStandardNodeMaterial({ color: 0xffffff });
  shell.userData.batchKey = "faketemplate";
  const frame = new THREE.MeshStandardNodeMaterial({ color: 0x535353 });
  frame.userData.batchKey = "faketemplate";
  const add = (name, geo, material, x = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.name = name;
    m.position.x = x;
    root.add(m);
  };
  add("shellA", new THREE.BoxGeometry(6, 2.6, 2.4), shell);
  add("shellB", new THREE.BoxGeometry(6, 2.6, 2.4), shell, 6);
  add("frame", new THREE.BoxGeometry(0.2, 2.6, 2.4), frame, 3);
  // Deliberately left UNMERGED, so a placement still has two meshes on one
  // material for the instancer to collapse. That is the real shape of a scenery
  // template — buildTemplate's own merge is best-effort and a group whose
  // attributes disagree keeps its separate meshes (see mergeByMaterial).
  if (mark) markSharedGeometry(root);
  return root;
}

/** makeContainer / makeTireWall / makeSceneryProp, all three, in one line. */
function makePlacement(template) {
  const g = new THREE.Group();
  g.name = "placement";
  for (const c of template.children) g.add(c.clone());
  return g;
}

console.log("=== THE PREMISE: A CLONE SHARES THE GEOMETRY ===");
{
  const template = buildTemplate();
  const a = makePlacement(template);
  const b = makePlacement(template);
  check("two placements point at the SAME BufferGeometry",
        a.children[0].geometry === template.children[0].geometry &&
        b.children[0].geometry === template.children[0].geometry);
  check("...and it is marked shared", template.children.every((c) => isSharedGeometry(c.geometry)),
        `${template.children.length} meshes`);
  check("a geometry nobody marked is NOT shared",
        !isSharedGeometry(buildTemplate({ mark: false }).children[0].geometry));
}

console.log("\n=== mergeByMaterial DOES NOT FREE WHAT IT WAS LENT ===");
{
  // The instancer merges a throwaway copy of the prop. Before the fix this
  // disposed the sources, which for a template-backed prop is the one geometry
  // every placement on the track draws with.
  const template = buildTemplate();
  const freed = watch(template);
  const copy = makePlacement(template);
  const removed = mergeByMaterial(copy);
  check("the copy still merges (the guard is not just disabling the merge)",
        removed > 0, `${removed} meshes removed`);
  check("no template geometry was disposed", freed.length === 0, freed.join(", ") || "none");

  // And the same call on geometry it really does own still frees it, or the
  // merge would leak a buffer per placement.
  const owned = buildTemplate({ mark: false });
  const ownedFreed = watch(owned);
  mergeByMaterial(makePlacement(owned));
  check("...but an UNMARKED source is still disposed as before",
        ownedFreed.length > 0, `${ownedFreed.length} freed`);
}

console.log("\n=== PropInstancer._template LEAVES THE TEMPLATE ALIVE ===");
{
  // Built without the constructor: it wants a Scene and a PropManager, and
  // _template() touches neither (same trick as propShadowTest).
  const template = buildTemplate();
  const freed = watch(template);
  const it = Object.create(PropInstancer.prototype);
  it.catalog = [{ id: "faketemplate", make: () => makePlacement(template) }];
  it._templates = new Map();
  it._m4 = new THREE.Matrix4();
  const parts = it._template("faketemplate");
  check("the instancer still gets parts to draw", parts.length > 0, `${parts.length} parts`);
  check("its own copies are NOT the template's geometry",
        parts.every((p) => !template.children.some((c) => c.geometry === p.geometry)));
  check("placing a prop does not free the template", freed.length === 0,
        freed.join(", ") || "none");
}

console.log("\n=== DELETING ONE PLACEMENT DOES NOT KILL THE OTHERS ===");
{
  const template = buildTemplate();
  const freed = watch(template);
  const pm = Object.create(PropManager.prototype);
  pm.group = new THREE.Group();
  const doomed = makePlacement(template);
  pm.group.add(doomed);
  pm._disposeInstance({ root: doomed });
  check("deleting a prop leaves the shared geometry alive", freed.length === 0,
        freed.join(", ") || "none");
  check("...and the survivors still have their buffers",
        makePlacement(template).children.every((c) => c.geometry.attributes.position.count > 0));
}

console.log("\n=== EVERY MODULE THAT CLONES A TEMPLATE MARKS IT ===");
{
  // Source-level, because the container and the tire wall are GLB-backed and
  // there is no fetch here — their templates only exist in the browser. This is
  // exactly the check that would have caught the container regression: the
  // clone-per-placement line and the mark have to travel together.
  for (const file of ["modularRoadScenery.js", "modularRoadContainer.js", "modularRoadTireWall.js"]) {
    const src = readFileSync(join(ROOT, "games/modular-road-v3", file), "utf8");
    const clones = /for \(const c of _template\.children\) g\.add\(c\.clone\(\)\)|t\.clone\(\)/.test(src);
    check(`${file} hands out clones of a cached template`, clones);
    check(`${file} marks that template shared`, /markSharedGeometry\(/.test(src));
  }
  // And the three disposers that are handed a PROP ROOT honour it. Scoped to
  // exactly those lines — every one of these files also disposes geometry it
  // genuinely owns (the instancer's own merged part copies, roadGame's mirror
  // rails and debug groups), and guarding those would be wrong.
  const PROP_ROOT_DISPOSERS = {
    "modularRoadProps.js": 1,       // PropManager._disposeInstance
    "modularRoadPropInstancer.js": 1, // _template scaffolding teardown
    // clearBrush, the spawn-brush swap in applyGhostCarTemplate, and the spawn
    // marker's own rebuild — all three are handed a tree they did not build.
    "roadGame.js": 3,
  };
  for (const [file, expected] of Object.entries(PROP_ROOT_DISPOSERS)) {
    const src = readFileSync(join(ROOT, "games/modular-road-v3", file), "utf8");
    // A line that frees geometry off a traversed mesh — i.e. off an object that
    // came out of def.make() and may not own what it points at.
    const sites = src.split(/\r?\n/)
      .filter((l) => /o\.geometry\??\.dispose\??\.?\(\)/.test(l))
      .map((l) => l.trim());
    check(`${file} has the prop-root disposer this rule is about`,
          sites.length === expected, `${sites.length} site(s)`);
    check(`${file} guards it`, sites.length > 0 && sites.every((l) => /isSharedGeometry/.test(l)),
          sites.join(" | "));
  }
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
