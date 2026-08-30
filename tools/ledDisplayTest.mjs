// LED display — a new scenery prop with live text/image, old boards left alone.
//
// The split: frame and legs instance for every placement; the face instances
// while it is still the default chevron and leaves the batch once authored.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`);
  if (!c) fail++;
};

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { makeSceneryProp, SCENERY_MAP } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadScenery.js")).href);
const {
  applyLedDisplayContent, isLedDisplayUnique, findLedDisplayFace,
} = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadLedDisplay.js")).href);
const { PropInstancer } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js")).href);

console.log("=== uniqueness ===");
check("chevron stays on the shared batch", !isLedDisplayUnique(null));
check("text leaves the face batch", isLedDisplayUnique({ source: "text" }));
check("image leaves the face batch", isLedDisplayUnique({ source: "image" }));

console.log("\n=== unique face does not retint its neighbour ===");
{
  const a = makeSceneryProp("leddisplay");
  const b = makeSceneryProp("leddisplay");
  const fa = findLedDisplayFace(a);
  const fb = findLedDisplayFace(b);
  const shared = fa.material;
  check("default clones share the LED material", fa.material === fb.material);
  applyLedDisplayContent(a, { source: "image" });
  check("authoring A gives it its own face material", fa.material !== shared);
  check("...and B still wears the shared chevron", fb.material === shared);
  applyLedDisplayContent(a, { source: "chevron" });
  check("clearing A restores the shared material", fa.material === shared);
}

console.log("\n=== instancer: frames always, face only while chevron ===");
{
  const def = SCENERY_MAP.get("leddisplay");
  const catalog = [{
    id: "leddisplay",
    ledDisplay: true,
    make: () => makeSceneryProp("leddisplay"),
  }];
  const scene = new THREE.Scene();
  const props = { instances: [] };
  const instancer = new PropInstancer(scene, props, catalog, (id) => id === "leddisplay");
  for (let i = 0; i < 3; i++) {
    const root = catalog[0].make();
    props.instances.push({
      id: "leddisplay", def: catalog[0], root, ledDisplay: null,
    });
  }
  instancer.setEnabled(true);

  const keys = [...instancer._batches.keys()];
  check("chevron boards instance the shared parts", keys.includes("leddisplay"));
  check("...and a separate face batch", keys.includes("leddisplay::ledface"));
  const faceBatch = instancer._batches.get("leddisplay::ledface");
  check("all three chevrons are in the face batch", faceBatch?.insts.length === 3);

  const authored = props.instances[0];
  authored.ledDisplay = { source: "image" };
  applyLedDisplayContent(authored.root, authored.ledDisplay);
  instancer.sync();

  const after = instancer._batches.get("leddisplay::ledface");
  check("the authored board left the face batch", after?.insts.length === 2);
  check("...and the other two stayed", after?.insts.includes(props.instances[1])
    && after?.insts.includes(props.instances[2]));
  const frameBatch = instancer._batches.get("leddisplay");
  check("frames still instance all three", frameBatch?.insts.length === 3);
  check("the authored live face is visible", findLedDisplayFace(authored.root).visible === true);
  check("its live frame is hidden (the instancer draws it)", (() => {
    let hidden = true;
    authored.root.traverse((o) => {
      if (o.isMesh && !o.userData.ledDisplayFace && o.visible) hidden = false;
    });
    return hidden;
  })());
  instancer.dispose();
}

console.log("\n=== old boards stayed out of this ===");
check("LED board has no live-content flag", !SCENERY_MAP.get("ledboard")?.ledDisplay);
check("Ad billboard is still the advert path", !!SCENERY_MAP.get("adboard")?.advert);

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
