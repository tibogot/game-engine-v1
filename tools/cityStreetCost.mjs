/*
 * WHAT THE CITY STREET SHADER COSTS, counted on the emitted WGSL rather than
 * argued about. Prints the fragment stage's size and its expensive operations.
 *
 * NOTE WHAT THIS CANNOT TELL YOU. Every knob in STREET_DEFAULTS is a UNIFORM,
 * so the generated code is identical whatever they are set to — a marking
 * switched off still has its instructions in the binary, it just does not run
 * them. To find out what a change actually added, run this on both sides of
 * the change (git stash) and diff the numbers.
 */
import { register } from "node:module";
register("../tools/threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const TSL = await import("three/tsl");
const { createCityStreets } = await import("../games/modular-road-v3/modularRoadCityStreets.js");
const { CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

const stub = {
  isWebGPURenderer: true,
  coordinateSystem: THREE.WebGPUCoordinateSystem,
  debug: { checkShaderErrors: true },
  library: Object.assign(new THREE.BasicNodeLibrary(), { fromMaterial: (m) => (m && m.isNodeMaterial ? m : null) }),
  getMRT: () => null, getRenderTarget: () => null,
  shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap },
  backend: { isWebGPUBackend: true,
    capabilities: { getUniformBufferLimit: () => 65536, isCompatibilityMode: false },
    utils: { getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }) } },
  nodes: { getForRender: () => null },
  contextNode: TSL.context(),
  lighting: { createNode: (l = []) => new THREE.LightsNode().setLights(l) },
  hasFeature: () => true, hasCompatibility: () => true, _currentRenderContext: null,
};
const be = new THREE.WebGPUBackend({});
stub.backend.createNodeBuilder = (o, r) => be.createNodeBuilder(o, r);

function measure(params) {
  const s = createCityStreets({ P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0, params });
  const mesh = s.mesh;
  mesh.updateMatrixWorld();
  const scene = new THREE.Scene();
  scene.add(mesh);
  const sun = new THREE.DirectionalLight(0xffffff, 3); sun.castShadow = true;
  scene.add(sun);
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.5, 8192); cam.updateMatrixWorld();
  const b = stub.backend.createNodeBuilder(mesh, stub);
  b.scene = scene; b.camera = cam; b.material = mesh.material;
  b.geometry = mesh.geometry;
  b.lightsNode = new THREE.LightsNode().setLights([sun]);
  b.environmentNode = null; b.fogNode = null;
  b.clippingContext = { unionPlanes: [], intersectionPlanes: [] };
  b.build();
  const frag = b.fragmentShader || "";
  const count = (re) => (frag.match(re) || []).length;
  return {
    kB: +(frag.length / 1024).toFixed(1),
    lines: frag.split("\n").length,
    smoothstep: count(/smoothstep\s*\(/g),
    fwidth: count(/fwidth\s*\(/g),
    textureSample: count(/textureSample/g),
    ifs: count(/\bif\s*\(/g),
  };
}

const r = measure({});
console.log("street fragment stage");
console.log(`  ${r.kB} kB · ${r.lines} lines`);
console.log(`  ${r.smoothstep} smoothstep · ${r.fwidth} fwidth · ${r.textureSample} textureSample · ${r.ifs} if`);
