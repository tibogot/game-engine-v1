// PROPS MUST CAST AND RECEIVE SHADOWS WHEN INSTANCED.
//
// The instancer takes over rendering for EVERY prop id (roadGame.js passes
// `() => true`), so whatever its templates say is what the whole track does.
//
// The trap: every loose-prop path runs enableMeshShadows(root) after def.make()
// — PropManager.add() and duplicateSelected() both do — but PropInstancer built
// its templates from a bare def.make(), which leaves three's defaults of
// cast=false receive=false. So instanced obstacles silently stopped
// participating in shadows, and the visible symptom was the CAR's shadow
// vanishing the moment it drove onto a container: the surface under it was not
// a receiver.
//
// This pins both halves for the drivable obstacles, which are the ones where a
// missing receiver is actually visible.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

/* A DOM STUB, JUST ENOUGH FOR TextureLoader.
 *
 * Some obstacle templates now build a textured material — the hazard platform
 * pulls the diamond-plate maps — and three's ImageLoader reaches straight for
 * `document.createElementNS('…xhtml', 'img')`. In Node that threw and took the
 * whole file down before a single assertion ran, which is why this test showed
 * as failing with no FAIL line to explain it.
 *
 * The image never loads and never needs to: this file asserts castShadow /
 * receiveShadow flags, which are set on the mesh regardless of whether pixels
 * ever arrive. So the stub only has to be constructible and listenable.
 */
if (typeof globalThis.document === "undefined") {
  const makeEl = () => ({
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getContext: () => null,
    set src(_v) { /* never resolves — no load or error event is fired */ },
    get src() { return ""; },
  });
  globalThis.document = {
    createElementNS: () => makeEl(),
    createElement: () => makeEl(),
  };
}

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { PropInstancer } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js")).href);
const { PROP_CATALOG } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadProps.js")).href);

// Built without the constructor: it wants a Scene and a PropManager, and
// _template() touches neither.
function bareInstancer() {
  const it = Object.create(PropInstancer.prototype);
  it.catalog = PROP_CATALOG;
  it._templates = new Map();
  it._m4 = new THREE.Matrix4();
  return it;
}

// Things you can land on, or that stand tall enough to shade something.
const OBSTACLES = ["box", "wall", "roadblock", "ramp", "kickerramp", "jumpkicker",
                   "pole", "cone", "tube"];

// GLB-backed, and there is no fetch here — their make() returns an empty group
// until preloadContainer()/preloadTireWall() resolve, which roadGame awaits
// before it ever constructs the instancer. Covered by the fix regardless:
// enableMeshShadows() runs over whatever the loaded root turns out to contain.
const GLB_BACKED = ["container", "tirewall"];

console.log("=== INSTANCED OBSTACLES ARE SHADOW RECEIVERS ===");
{
  const it = bareInstancer();
  for (const id of OBSTACLES) {
    if (!PROP_CATALOG.some((d) => d.id === id)) { check(`${id} is in the catalog`, false); continue; }
    const parts = it._template(id);
    if (!parts?.length) { check(`${id} builds at least one part`, false); continue; }
    check(`${id} receives shadows`, parts.every((p) => p.receiveShadow),
          `${parts.filter((p) => p.receiveShadow).length}/${parts.length} parts`);
    check(`${id} casts shadows`, parts.every((p) => p.castShadow),
          `${parts.filter((p) => p.castShadow).length}/${parts.length} parts`);
  }
}

console.log("\n=== GLB PROPS ARE EMPTY HEADLESS, SO ONLY THE POLICY IS CHECKED ===");
{
  const it = bareInstancer();
  for (const id of GLB_BACKED) {
    const parts = it._template(id);
    check(`${id} is empty here for the known reason, not a broken template`,
          Array.isArray(parts) && parts.length === 0,
          "make() before its GLB resolves");
  }
}

// The regression this file exists for: the flags used to be read off a bare
// make(), so a template whose parts are ALL non-receivers means enableMeshShadows
// stopped being applied.
console.log("\n=== THE TEMPLATE IS NOT A BARE make() ===");
{
  const it = bareInstancer();
  const def = PROP_CATALOG.find((d) => d.id === "box");
  const raw = def.make();
  let rawReceivers = 0;
  raw.traverse((o) => { if (o.isMesh && o.receiveShadow) rawReceivers++; });
  const parts = it._template("box");
  check("a bare make() is NOT already a receiver (so the fix is load-bearing)",
        rawReceivers === 0, `${rawReceivers} receiving meshes straight out of make()`);
  check("but the template is", parts.every((p) => p.receiveShadow));
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
