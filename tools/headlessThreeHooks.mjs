// NODE MODULE HOOKS that let the game's render-side modules load under plain node.
//
// The road tests keep needing modules that are 95% plain geometry and data —
// PropManager's save/load, the piece kit, the prop catalog — but that `import`
// something WebGPU-only at the top: `three/tsl`, `three/addons`, the bloom MRT
// helper. Under node `three` is the core build, so those imports throw at module
// evaluation and take the whole test with them.
//
// The existing tests solve it per-file, by reading the source, regexing the bad
// imports out and writing a rewritten copy (see parkPipeTest.mjs). That works
// for a leaf module and stops working the moment the module has DEPENDENCIES
// with the same problem: a rewritten copy still imports the ORIGINAL neighbours
// by their real paths, so the tree pulls the untouched version straight back in.
// modularRoadProps.js reaches five such modules.
//
// A resolve hook fixes it once for the whole graph, no matter how deep. The
// stubs are deliberately inert: nothing here is under test, and a test that
// needs real shader behaviour should not be running under node at all.
//
// Usage, before importing anything from the game:
//     import { registerHeadlessThree } from "./headlessThreeHooks.mjs";
//     registerHeadlessThree();
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import * as REAL_THREE from "three";

/**
 * The TSL stub's named exports are DISCOVERED, not hand-listed.
 *
 * ES modules have no dynamic named exports, so a stub has to name every binding
 * its importers ask for or they fail at link time with "does not provide an
 * export named X" — one name at a time, which is a miserable way to find out
 * that a module three levels down wanted `mix`. Scanning the repo for what is
 * actually imported from "three/tsl" makes the stub complete by construction and
 * keeps it that way as the shaders change.
 *
 * Each export is a chainable no-op: TSL builders are called at module scope to
 * assemble materials, and they chain (`positionWorld.xz.mul(2).add(1)`), so the
 * value has to survive arbitrary property access and calls. Nothing shader-side
 * is under test here — a test that needs real TSL needs a GPU, not node.
 */
const CHAIN = `
const chain = () => new Proxy(function stub() {}, {
  get: (_t, k) => (k === Symbol.toPrimitive || k === "then" || k === Symbol.iterator
    ? undefined : chain()),
  apply: () => chain(),
  construct: () => chain(),
});
`;

/**
 * Every name the repo expects from "three/tsl" / "three/webgpu" that the plain
 * "three" build does not already provide.
 *
 * Two shapes have to be covered, because the codebase uses both:
 *   • named imports  — `import { positionWorld, mix } from "three/tsl"`
 *   • namespace use  — `import * as THREE from "three/webgpu"` then
 *     `class X extends THREE.MRTNode`, which fails with "Class extends value
 *     undefined" rather than a link error, so it cannot be found by reading
 *     import statements alone.
 */
function discoverNodeNames(root, realThree) {
  const named = new Set();
  const members = new Set();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["']three\/(?:tsl|webgpu)["']/g;
  const nsRe = /import\s*\*\s*as\s*([\w$]+)\s*from\s*["']three\/webgpu["']/g;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".js") && !e.name.endsWith(".mjs")) continue;
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(importRe)) {
        for (const part of m[1].split(",")) {
          // "a as b" re-exports the ORIGINAL name; the alias is the importer's.
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) named.add(name);
        }
      }
      for (const m of src.matchAll(nsRe)) {
        for (const u of src.matchAll(new RegExp(`\\b${m[1]}\\.([A-Za-z_$][\\w$]*)`, "g"))) {
          members.add(u[1]);
        }
      }
    }
  };
  for (const sub of ["v2", "v3", "games", "shared"]) walk(join(root, sub));
  // Anything real three already exports must NOT be shadowed by a stub, or
  // `THREE.Vector3` from three/webgpu stops being a Vector3.
  return [...new Set([...named, ...members])].filter((n) => !(n in realThree)).sort();
}

const ADDONS_STUB = `
import * as THREE from "three";
export class TransformControls extends THREE.Object3D {
  constructor() { super(); this.enabled = false; this.visible = false; }
  setMode() {} setSpace() {} setSize() {} attach() { return this; } detach() { return this; }
  getHelper() { return new THREE.Object3D(); } dispose() {}
}
export class OrbitControls extends THREE.EventDispatcher {
  constructor() { super(); this.target = new THREE.Vector3(); this.enabled = true; }
  update() {} dispose() {}
}
`;

const BLOOM_STUB = `
export const applyBloomMRT = () => {};
export class BloomMRTNode {}
export default applyBloomMRT;
`;

// Each stub is resolved straight to a data: URL carrying its own source, so
// only a `resolve` hook is needed — node loads data: URLs as modules natively.
// (A custom URL scheme plus a `load` hook is the more obvious shape and does not
// work: node validates the resolved URL, and anything it cannot parse as a real
// URL is rejected before `load` ever runs.)
const dataUrl = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

const hooks = (tslUrl) => `
const TSL = ${JSON.stringify(tslUrl)};
const ADDONS = ${JSON.stringify(dataUrl(ADDONS_STUB))};
const BLOOM = ${JSON.stringify(dataUrl(BLOOM_STUB))};
let root = null;
export async function initialize(data) { root = data.root; }
export async function resolve(specifier, context, nextResolve) {
  // "three" ITSELF is intercepted, because vite.config.js aliases /^three$/ to
  // "three/webgpu" for the real build. So an "import * as THREE from three" in
  // game code means the WebGPU build, and half the codebase relies on that —
  // v2/objects/shared/ledMatrix.js extends THREE.MRTNode, which under plain
  // node fails as "Class extends value undefined" with nothing to say that
  // three/webgpu was ever involved. Without this the hooks would reproduce a
  // DIFFERENT module graph from the one that ships.
  if (specifier === "three" || specifier === "three/tsl" || specifier === "three/webgpu") {
    return { url: TSL, shortCircuit: true };
  }
  // ONLY the controls. The rest of three/addons is plain maths that node loads
  // perfectly well — BufferGeometryUtils in particular, which the batching
  // module needs for real (stubbing it turned mergeGeometries into a no-op and
  // the module failed to link). Controls are the ones that touch the DOM.
  if (specifier.startsWith("three/addons/controls/")) {
    return { url: ADDONS, shortCircuit: true };
  }
  if (/bloomMRT\\.js$/.test(specifier)) {
    return { url: BLOOM, shortCircuit: true };
  }
  // A data: URL has no hierarchical base, so node cannot resolve a BARE
  // specifier from inside one — the addons stub's own \`import "three"\` fails
  // with ERR_UNSUPPORTED_RESOLVE_REQUEST. Re-anchor those to the project root,
  // which is where node_modules lives.
  if (context.parentURL && context.parentURL.startsWith("data:")) {
    return nextResolve(specifier, { ...context, parentURL: root });
  }
  return nextResolve(specifier, context);
}
`;

let registered = false;

/**
 * Install the hooks. Idempotent — node would happily register the same hooks
 * twice and run them twice.
 *
 * "three/webgpu" is stubbed alongside "three/tsl" and the stub re-exports the
 * real core build, so a module doing `import * as THREE from "three/webgpu"`
 * still gets Vector3 and friends — it only loses the node-material half, which
 * needs a GPU anyway. Explicit local exports shadow the `export *`, so the TSL
 * names win where the two overlap.
 */
export function registerHeadlessThree() {
  if (registered) return;
  registered = true;
  // The repo root is one level up from tools/, and is what bare specifiers
  // ("three") coming out of a stub have to resolve against.
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const root = pathToFileURL(join(rootDir, "/")).href;
  const names = discoverNodeNames(rootDir, REAL_THREE);
  // The stub re-exports real three by its RESOLVED ABSOLUTE URL, not by the bare
  // name — the hook now intercepts "three", so a bare re-export inside the stub
  // would resolve straight back to the stub and deadlock the graph.
  const realThreeUrl = import.meta.resolve("three");
  const tslSrc = `export * from ${JSON.stringify(realThreeUrl)};\n${CHAIN}\n${
    names.map((n) => `export const ${n} = chain();`).join("\n")}\n`;
  register(`data:text/javascript,${encodeURIComponent(hooks(dataUrl(tslSrc)))}`, {
    parentURL: import.meta.url,
    data: { root },
  });
}
