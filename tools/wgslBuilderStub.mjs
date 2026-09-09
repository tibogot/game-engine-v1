// THE HEADLESS WGSL BUILDER — the real WGSLNodeBuilder, no GPU.
//
// Lifted out of tools/cityShaderTest.mjs so that any tool can ask what a
// material actually GENERATES: size, branch shape, whether a derivative
// escaped into a branch. That question comes up whenever the answer to "why is
// the first frame slow" is "the driver is compiling", which for this project it
// keeps being — and the alternative to asking it here is a browser round-trip.
//
// The renderer is a stub: NodeBuilder only reaches for a handful of things on
// it, and none of them need a device.
//
// IMPORT THE HOOK FIRST. `tools/threeWebgpuHook.mjs` has to be registered
// before `three/webgpu` is loaded, and a module graph only loads three once, so
// a caller that imports three before this module gets an unhooked copy.
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const TSL = await import("three/tsl");

/** Re-exported so a caller never loads a SECOND copy of three — every
 *  `instanceof` in the node system would quietly stop matching if it did. */
export { THREE, TSL };

// ── A renderer with just enough surface for the node builder ─────────────────
const stubRenderer = {
  isWebGPURenderer: true,
  coordinateSystem: THREE.WebGPUCoordinateSystem,
  debug: { checkShaderErrors: true },
  // `BasicNodeLibrary` is the real thing the renderer uses, with the light
  // node classes already registered. Only `fromMaterial` is overridden: it maps
  // a PLAIN material to its node equivalent, and ours already IS one, so it
  // maps to itself. Returning null there makes the builder log "not
  // compatible" and emit an EMPTY stage — which still passes a naive
  // did-it-throw check, so getting this right is the difference between the
  // test compiling the facade and compiling nothing.
  library: Object.assign(new THREE.BasicNodeLibrary(), {
    fromMaterial: (m) => (m && m.isNodeMaterial ? m : null),
  }),
  getMRT: () => null,
  getRenderTarget: () => null,
  shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap },
  backend: {
    isWebGPUBackend: true,
    capabilities: { getUniformBufferLimit: () => 65536, isCompatibilityMode: false },
    // WGSLNodeBuilder asks how a texture is sampled to pick the WGSL binding
    // type. Nothing here is multisampled.
    utils: { getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }) },
  },
  nodes: { getForRender: () => null },
  // Renderer.js:246 — the builder asserts this is a real `context()` node.
  contextNode: TSL.context(),
  // Renderer.js:264 — `setupLights` rebuilds the lights node through this.
  lighting: { createNode: (lights = []) => new THREE.LightsNode().setLights(lights) },
  // Queried for float32-filterable / depth-texture support when a shadow map
  // is in play. This build target has the lot.
  hasFeature: () => true,
  // Renderer.js:3491 — ShadowNode asks whether the backend can do hardware
  // depth comparison before it picks a sampler. WebGPU can.
  hasCompatibility: () => true,
  _currentRenderContext: null,
};

// WGSLNodeBuilder is not on three/webgpu's public surface, but the backend that
// owns it is, and its constructor needs no device — only `init()` does. Going
// through the backend keeps everything in ONE copy of three's module graph;
// importing the builder from `three/src/...` instead would load a second copy
// and every `instanceof` in the material would quietly stop matching.
const backendForBuilder = new THREE.WebGPUBackend({});
stubRenderer.backend.createNodeBuilder = (o, r) => backendForBuilder.createNodeBuilder(o, r);

export function buildWGSL(material, { withLight = true, instanced = null } = {}) {
  // An instanced material reads per-instance data through InstanceNode, which
  // only exists when the OBJECT being built is the InstancedMesh itself.
  const geometry = instanced ? instanced.geometry : new THREE.BoxGeometry(1, 1, 1);
  const mesh = instanced || new THREE.Mesh(geometry, material);
  mesh.updateMatrixWorld();

  const scene = new THREE.Scene();
  scene.add(mesh);
  const lights = [];
  if (withLight) {
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.castShadow = true;
    scene.add(sun);
    lights.push(sun);
    const hemi = new THREE.HemisphereLight(0x8899bb, 0x223344, 0.5);
    scene.add(hemi);
    lights.push(hemi);
  }
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.5, 8192);
  camera.updateMatrixWorld();

  const builder = stubRenderer.backend.createNodeBuilder(mesh, stubRenderer);
  builder.scene = scene;
  builder.camera = camera;
  builder.material = material;
  builder.geometry = geometry;
  builder.lightsNode = new THREE.LightsNode().setLights(lights);
  builder.environmentNode = null;
  builder.fogNode = null;
  // ClippingContext is internal; the node system only ever reads
  // `unionPlanes.length` off it, so an empty duck stands in for "no clipping".
  builder.clippingContext = { unionPlanes: [], intersectionPlanes: [] };
  builder.build();
  return builder;
}
