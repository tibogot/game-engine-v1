// Physics props (cones, gates) drawn as instances instead of one tree each.
//
// There are two ways to collapse draw calls and props split cleanly between
// them: STATIC props merge (geometry baked into one shared mesh), SIMULATED
// props instance (one geometry, N matrices). The cone qualified for neither and
// was quietly the most expensive thing on the track — measured in the running
// page at 12.65 draws each in drive mode, against 0.4 for a pole, and cones are
// the one prop you place by the dozen. 60 cones cost 739 draws.
//
// After: 3 draws, and CONSTANT in the number of cones.
//
// The thing that must not break in exchange is the movement — the entire reason
// these could not be merged. So the load-bearing assertion here is that the
// instance matrices track the sim, not that the draw count went down.
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { PropInstancer } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js")).href);
const { materialKey, mergeByMaterial } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBatching.js")).href);

/** A prop shaped like the cone: several meshes over a few shared materials. */
const orange = () => new THREE.MeshStandardNodeMaterial({ color: 0xf4581a });
const white = () => new THREE.MeshStandardNodeMaterial({ color: 0xeef0f2 });
const dark = () => new THREE.MeshStandardNodeMaterial({ color: 0x141417 });
const CATALOG = [{
  id: "cone",
  make: () => {
    const g = new THREE.Group();
    g.name = "Cone";
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 1.2, 12), orange());
    // Two collars built independently — the real cone does this, and it is why
    // material IDENTITY is the wrong merge key.
    const c1 = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.2, 12), white());
    c1.position.y = 0.3;
    const c2 = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.27, 0.14, 12), white());
    c2.position.y = 0.6;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.8), dark());
    base.position.y = -0.6;
    g.add(body, c1, c2, base);
    g.position.y = 0.63; // the real cone lifts its root to the centre of mass
    return g;
  },
}];

const fakeProps = (ids) => ({
  instances: ids.map((id, i) => {
    const root = new THREE.Object3D();
    root.position.set(i * 3, 0.63, -10);
    return { id, root };
  }),
});
const makeInstancer = (props) =>
  new PropInstancer(new THREE.Scene(), props, CATALOG, (id) => id === "cone");

console.log("=== THE TEMPLATE IS MERGED BEFORE IT IS INSTANCED ===");
{
  // Merging first matters as much as instancing: without it a four-mesh cone is
  // four InstancedMeshes instead of the three its materials actually need, and
  // the two collars — separate material OBJECTS that render identically — would
  // never batch together at all.
  const root = CATALOG[0].make();
  const before = (() => { let n = 0; root.traverse((o) => { if (o.isMesh) n++; }); return n; })();
  mergeByMaterial(root);
  let after = 0;
  root.traverse((o) => { if (o.isMesh) after++; });
  check("a 4-mesh cone merges down to its 3 distinct materials",
    before === 4 && after === 3, `${before} -> ${after}`);
  check("the two collars share a batch despite being separate objects",
    materialKey(white()) === materialKey(white()));
  check("...while different materials stay apart",
    materialKey(white()) !== materialKey(dark()));

  // THE GLOWING PROPS. v3's selective bloom puts an `mrtNode` on every material
  // that is meant to glow, which sends it down materialKey's custom-shader
  // fallback to identity — and since each prop's make() builds its own material,
  // that meant twenty glow rings merged into twenty meshes, i.e. not at all.
  // Measured at 80 draws for 20 rings before `batchKey`, 4 after.
  const glow = () => {
    const m = new THREE.MeshStandardNodeMaterial({ color: 0xe8912d, emissive: 0xe8912d });
    m.emissiveIntensity = 6;
    m.mrtNode = {}; // stands in for applyBloomMRT's node
    return m;
  };
  const tagged = () => { const m = glow(); m.userData.batchKey = "propBloom"; return m; };
  check("an mrtNode alone still forces identity — that rule is right",
    materialKey(glow()) !== materialKey(glow()));
  check("...but a declared batchKey lets identical glow props batch",
    materialKey(tagged()) === materialKey(tagged()));
  check("...without flattening genuinely different ones",
    (() => { const a = tagged(); const b = tagged(); b.emissiveIntensity = 2;
      return materialKey(a) !== materialKey(b); })());
  const props = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  check("applyPropBloom declares it, since it applies ONE uniform graph",
    /material\.userData\.batchKey = "propBloom";/.test(props));
}

console.log("\n=== DRAW COUNT IS CONSTANT IN THE NUMBER OF PROPS ===");
{
  const counts = [1, 5, 60];
  const draws = counts.map((n) => {
    const inst = makeInstancer(fakeProps(Array(n).fill("cone")));
    inst.setEnabled(true);
    return inst.drawCount;
  });
  check("one cone and sixty cones cost the same",
    draws.every((d) => d === draws[0]), `${counts.map((c, i) => `${c}:${draws[i]}`).join("  ")}`);
  check("...and that cost is a handful, not per-cone", draws[0] <= 3, `${draws[0]} draws`);
}

console.log("\n=== THE INSTANCES ACTUALLY FOLLOW THE SIM ===");
// The whole point of instancing rather than merging. A frozen field of cones
// looks perfectly correct right up until something hits one.
{
  const props = fakeProps(["cone", "cone", "cone"]);
  const inst = makeInstancer(props);
  inst.setEnabled(true);

  // Knock the middle one into the air and spin it, the way _tickBody would.
  props.instances[1].root.position.set(7, 3.4, -22);
  props.instances[1].root.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1);
  inst.update();

  const im = inst.group.children[0];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  im.getMatrixAt(1, m);
  m.decompose(pos, quat, scl);
  check("a knocked prop's instance matrix carries its new position",
    pos.distanceTo(props.instances[1].root.position) < 1e-4,
    `${pos.toArray().map((v) => v.toFixed(2))}`);
  check("...and its rotation, so it tumbles rather than sliding upright",
    Math.abs(quat.x - props.instances[1].root.quaternion.x) < 1e-4);
  // Its neighbours must not have been dragged along with it.
  im.getMatrixAt(0, m); m.decompose(pos, quat, scl);
  check("...and its neighbours stay exactly where they were",
    pos.distanceTo(props.instances[0].root.position) < 1e-4);

  // Every mesh in the batch has to move together, or a cone's collars get left
  // behind in mid-air.
  let allAgree = true;
  for (const mesh of inst.group.children) {
    mesh.getMatrixAt(1, m); m.decompose(pos, quat, scl);
    if (pos.distanceTo(props.instances[1].root.position) > 1e-4) allAgree = false;
  }
  check("every part of the prop moves as one", allAgree);
}

console.log("\n=== IT SURVIVES THE PROP SET CHANGING ===");
{
  const props = fakeProps(["cone", "cone", "cone", "cone"]);
  const inst = makeInstancer(props);
  inst.setEnabled(true);
  const firstMesh = inst.group.children[0];
  check("starts at four", firstMesh.count === 4, `${firstMesh.count}`);

  // Deleting is the dangerous direction: an index past the end of a batch is a
  // crash or a ghost cone. PropManager owns its own Delete key, so nothing tells
  // the instancer — it has to notice.
  props.instances.pop();
  inst.update();
  check("a delete nobody announced is picked up", inst.group.children[0].count === 3,
    `${inst.group.children[0].count}`);
  check("...without rebuilding the buffers (count only drops)",
    inst.group.children[0] === firstMesh);

  // Growing past the slack is the case that DOES need new buffers.
  for (let i = 0; i < 40; i++) props.instances.push(fakeProps(["cone"]).instances[0]);
  inst.update();
  check("a big add grows the batch", inst.group.children[0].count === 43,
    `${inst.group.children[0].count}`);
  check("...and draw count is still constant", inst.drawCount <= 3, `${inst.drawCount}`);
}

console.log("\n=== BUILD MODE GETS ITS REAL OBJECTS BACK ===");
// The editor's picking, gizmo and deletion all walk props.instances and act on
// the real roots. Instancing must hide them, never replace them.
{
  const props = fakeProps(["cone", "cone"]);
  const inst = makeInstancer(props);
  inst.setEnabled(true);
  check("loose roots are hidden while instanced",
    props.instances.every((p) => p.root.visible === false));
  check("...but still present, so the gizmo has something to grab",
    props.instances.length === 2 && props.instances.every((p) => p.root.isObject3D));
  inst.setEnabled(false);
  check("switching back to build restores them",
    props.instances.every((p) => p.root.visible === true));
  check("...and the instanced group goes away", inst.group.visible === false);
}

console.log("\n=== NEWLY PLACED PROPS ARE TAKEN OVER TOO ===");
// The bug this catches drew everything TWICE and read as the optimisation doing
// nothing: setEnabled hid the roots that existed when it ran, and props placed
// afterwards stayed visible while also getting an instance. Measured at the
// time: 200 poles at 1152 draws, slightly worse than no instancing at all.
{
  const props = fakeProps(["cone"]);
  const inst = makeInstancer(props);
  inst.setEnabled(true);
  check("the prop present at switch-on is hidden", props.instances[0].root.visible === false);
  props.instances.push(fakeProps(["cone"]).instances[0]);
  inst.sync();
  check("...and so is one placed afterwards",
    props.instances.every((p) => p.root.visible === false));
  check("...with both drawn from the same batch", inst.group.children[0].count === 2);
}

console.log("\n=== WIRED INTO THE GAME ===");
{
  const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  // EVERY prop, not just the simulated ones. Merging only ever paid off in drive
  // mode — merged geometry cannot move, and every edit re-bakes the lot — which
  // left the editor scaling linearly at 648 draws for 100 poles.
  // The gate was `() => true`; ad boards are now held back because each
  // placement wears its own poster map and instancing would pin every copy to
  // one image. Match the PREDICATE rather than the old literal, so the check
  // still catches a slide back to "simulated props only" (the 648-draw editor)
  // without failing every time a documented exception is added.
  const ctor = game.split("\n").find((l) => l.includes("new PropInstancer(")) ?? "";
  check("the instancer is constructed at all", ctor.length > 0);
  check("every prop type is instanced, not just the simulated ones",
    !/sim|physic|dynamic|movable/i.test(ctor), ctor.trim().slice(0, 120));
  check("...and the only props held back are the per-poster ad boards",
    ["adboard", "adtotem", "adprism"].every((id) => ctor.includes(id))
    || /\(\) => true/.test(ctor));
  check("...in BOTH modes, not on the drive-mode switch",
    /propInstancer\.setEnabled\(true\);/.test(game)
    && !/propInstancer\.setEnabled\(on\)/.test(game));
  check("the static-prop merge it replaced is gone, so nothing double-hides",
    !/buildMergedProps/.test(game));
  // Once per FRAME and OUTSIDE the mode branch: build mode moves props through
  // the gizmo, and per substep would repeat the same GPU upload.
  const shared = game.slice(game.indexOf("portals.updateVisuals(dt);"));
  check("matrices upload once per frame, in both modes",
    /propInstancer\.update\(\);/.test(shared.slice(0, 800)));
  check("the prop set changes are pushed through",
    (game.match(/propInstancer\.sync\(\)/g) ?? []).length >= 3);
  // Live-tuned looks are written to the loose roots, which are not what is drawn.
  check("live glow tuning rebuilds the templates it would otherwise miss",
    /props\.onGlowChange = \(ids\) => propInstancer\.refreshTemplates\(ids\)/.test(game));
  const propsSrc = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  check("...and applyGlowParams actually raises it",
    /this\.onGlowChange\?\.\(\["glowbox", "glowring"\]\)/.test(propsSrc));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
