// Does the city facade actually COMPILE?
//
// tools/cityKitTest.mjs builds the node graph and checks the four slots are
// wired. That is not the same thing: a graph can be perfectly well-formed and
// still generate WGSL that Dawn rejects, and this exact file has shipped that
// bug twice —
//
//   • `applyBloomMRT(material, vec3)` → "cannot assign 'vec3<f32>' to
//     'vec4<f32>'" → invalid ShaderModule → the city silently never drew, and
//     the error text only appeared on the CDP Log domain.
//   • a `.toVar()` first used inside an `If` got declared in the branch's
//     scope, so the emissive slot read a name that did not exist there.
//
// Both cost a browser round-trip to find. This runs the real WGSLNodeBuilder
// over the real material, headless, and fails on either a thrown error or
// suspicious generated code — so the class of bug is caught by `npm test`.
//
// The renderer is a stub: NodeBuilder only reaches for a handful of things on
// it, and none of them need a GPU.
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const TSL = await import("three/tsl");
const { createCityFacadeMaterial } = await import("../games/modular-road-v3/modularRoadCityFacade.js");
const { createCityStreets } = await import("../games/modular-road-v3/modularRoadCityStreets.js");
const { createCityFurniture } = await import("../games/modular-road-v3/modularRoadCityFurniture.js");
const { CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

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

function buildWGSL(material, { withLight = true, instanced = null } = {}) {
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

console.log("── FACADE SHADER ──");
let builder = null;
let buildError = null;
try {
  builder = buildWGSL(createCityFacadeMaterial().material);
} catch (e) {
  buildError = e;
}
check("the facade generates WGSL without throwing", buildError === null, buildError ? `${buildError.message}` : "");
if (buildError && process.env.CITY_SHADER_TRACE) console.log(buildError.stack);

if (builder) {
  const frag = builder.fragmentShader || "";
  const vert = builder.vertexShader || "";
  console.log(`       ${(vert.length / 1024).toFixed(1)} kB vertex · ${(frag.length / 1024).toFixed(1)} kB fragment`);
  if (process.env.CITY_SHADER_DUMP) {
    const fs = await import("node:fs");
    fs.writeFileSync(process.env.CITY_SHADER_DUMP, frag);
  }

  check("a fragment stage was emitted", frag.length > 2000);
  // `undefined` reaching the generated source is the signature of an Fn that
  // returned a plain object, or a slot wired to a JS value instead of a node.
  check("no 'undefined' leaked into the generated WGSL",
    !/\bundefined\b/.test(frag) && !/\bundefined\b/.test(vert),
    (frag.match(/.{0,60}undefined.{0,60}/) || [""])[0]);
  check("no NaN literals in the generated WGSL", !/\bNaN\b/.test(frag));

  // Split into WGSL functions. Both checks below are only meaningful PER
  // FUNCTION: three's own GGX helpers each declare a `nodeVar0`, which is
  // perfectly legal, and a naive whole-file scan calls that a redeclaration.
  const fragLines = frag.split(String.fromCharCode(10));
  const fns = [];
  {
    let cur = { name: "<module>", lines: [] };
    for (const ln of fragLines) {
      const m = /^fn\s+([A-Za-z_]\w*)/.exec(ln);
      if (m) { fns.push(cur); cur = { name: m[1], lines: [] }; }
      cur.lines.push(ln);
    }
    fns.push(cur);
  }
  const mainFn = fns.find((f) => /^main/.test(f.name)) || fns[fns.length - 1];
  console.log(`       ${fns.length - 1} functions · ${mainFn.lines.length} lines in ${mainFn.name}()`);

  // A generated var declared twice IN ONE FUNCTION is what a `.toVar()` shared
  // across two sub-builds produces, and WGSL rejects it outright.
  let genDupes = [];
  for (const f of fns) {
    const seen = new Set(), dup = new Set();
    for (const ln of f.lines) {
      const m = /^\s*(?:let|var)\s+(nodeVar\d+)\s*[:=]/.exec(ln);
      if (!m) continue;
      if (seen.has(m[1])) dup.add(`${f.name}:${m[1]}`);
      seen.add(m[1]);
    }
    genDupes = genDupes.concat([...dup]);
  }
  check("no generated variable is declared twice in one function", genDupes.length === 0, genDupes.slice(0, 4).join(","));

  // The four things this material must actually do.
  check("the fragment stage reads the lot texture", /textureLoad/.test(frag));
  check("the relief branch survived into the shader", /\bif\s*\(/.test(frag));
  check("screen derivatives are present (the face-size trick)", /dpdx|dpdy/i.test(frag));
  check("the emissive MRT member is a vec4", !/emissive\s*:\s*vec3/.test(frag));

  // DERIVATIVES IN NON-UNIFORM CONTROL FLOW are undefined behaviour in WGSL
  // and a hard error on some drivers. Every dpdx/dpdy this facade takes is
  // meant to sit at the top level of its function — inside a `{ }` that opened
  // for an `if`/`for`/`while` is the bug. Counting ALL braces would flag the
  // function body itself, so only control-flow blocks are tracked.
  let badDeriv = [];
  for (const f of fns) {
    let ctrl = 0;
    for (const ln of f.lines) {
      if (/\bdpdx\b|\bdpdy\b|\bfwidth\b/i.test(ln) && ctrl > 0) badDeriv.push(`${f.name}: ${ln.trim().slice(0, 60)}`);
      const opens = (ln.match(/\{/g) || []).length;
      const closes = (ln.match(/\}/g) || []).length;
      const isCtrl = /\b(if|else|for|while|loop|switch|case)\b/.test(ln);
      if (ctrl > 0 || isCtrl) ctrl += opens - closes;
      if (ctrl < 0) ctrl = 0;
    }
  }
  check("no derivative is taken inside a branch", badDeriv.length === 0, badDeriv.slice(0, 2).join(" | "));

  // A runaway uber-shader is a real risk here: the normal pass re-runs the
  // pure builders, so anything moved into them costs twice. This is a
  // tripwire, not a target — if it fires, look at what grew before raising it.
  check("the main function stays within budget", mainFn.lines.length < 4200, `${mainFn.lines.length} lines`);
}

// The same material with NO lights must still build: `receivedShadowNode` is
// only consulted when a shadow-casting light exists, and an unlit build is what
// thumbnail bakes and env probes do.
let unlitErr = null;
try {
  buildWGSL(createCityFacadeMaterial().material, { withLight: false });
} catch (e) {
  unlitErr = e;
}
check("it also builds with no lights in the scene (bakes, probes)", unlitErr === null, unlitErr ? unlitErr.message : "");

// The L2 variant must be MEANINGFULLY cheaper, or the split is just two
// pipelines for nothing. It is compared by generated line count, which is a
// crude proxy for instruction count but a very reliable regression tripwire:
// if someone later reads a trace result on the far path, this fires.
{
  const far = createCityFacadeMaterial();
  let fb = null;
  try { fb = buildWGSL(far.farMaterial); } catch (e) { check("the L2 facade compiles", false, e.message); }
  if (fb && builder) {
    const nearLines = (builder.fragmentShader || "").split(String.fromCharCode(10)).length;
    const farLines = (fb.fragmentShader || "").split(String.fromCharCode(10)).length;
    const ratio = farLines / nearLines;
    check("the L2 facade is far cheaper than the L0/L1 one", ratio < 0.6,
      `${farLines} vs ${nearLines} lines (${(ratio * 100).toFixed(0)}%)`);
    check("the L2 facade does no ray-cast reveal work", !/reveal|jamb/i.test(fb.fragmentShader || "") || farLines < nearLines * 0.6);
  }
}

// ── The street material gets the same treatment ──────────────────────────────
// It is one draw over a plane 6 km across, so a derivative smuggled into a
// branch, or a dead `undefined`, would be just as expensive to find in a
// browser as it was in the facade.
console.log("\n── STREET SHADER ──");
{
  let sBuilder = null, sErr = null;
  try {
    const streets = createCityStreets({ P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0 });
    sBuilder = buildWGSL(streets.material);
  } catch (e) { sErr = e; }
  check("the streets generate WGSL without throwing", sErr === null, sErr ? sErr.message : "");
  if (sErr && process.env.CITY_SHADER_TRACE) console.log(sErr.stack);

  if (sBuilder) {
    const f = sBuilder.fragmentShader || "";
    console.log(`       ${(f.length / 1024).toFixed(1)} kB fragment`);
    check("no 'undefined' leaked into the street WGSL", !/\bundefined\b/.test(f));
    check("the near-detail branch survived", /\bif\s*\(/.test(f));
    check("street paint is anti-aliased by a derivative", /dpdx|dpdy|fwidth/i.test(f));
    // The streets are LIT — an unlit material cannot receive the city's
    // shadows, which is the bug this material replaced.
    check("the street material takes scene lighting", /Light|shadow/i.test(f));

    const sfns = [];
    {
      let cur = { name: "<module>", lines: [] };
      for (const ln of f.split(String.fromCharCode(10))) {
        const m = /^fn\s+([A-Za-z_]\w*)/.exec(ln);
        if (m) { sfns.push(cur); cur = { name: m[1], lines: [] }; }
        cur.lines.push(ln);
      }
      sfns.push(cur);
    }
    const bad = [];
    for (const fn of sfns) {
      let ctrl = 0;
      for (const ln of fn.lines) {
        if (/\bdpdx\b|\bdpdy\b|\bfwidth\b/i.test(ln) && ctrl > 0) bad.push(`${fn.name}: ${ln.trim().slice(0, 60)}`);
        const o = (ln.match(/\{/g) || []).length, c = (ln.match(/\}/g) || []).length;
        if (ctrl > 0 || /\b(if|else|for|while|loop|switch|case)\b/.test(ln)) ctrl += o - c;
        if (ctrl < 0) ctrl = 0;
      }
    }
    check("no street derivative is taken inside a branch", bad.length === 0, bad.slice(0, 2).join(" | "));
  }
}

// ── The street's PLANAR REFLECTION variant ───────────────────────────────────
// Only built when a reflection target is handed in, so the plain build above
// never compiles a line of it. Three taps, a matrix projection and a ripple
// distortion, all inside the one flow that also owns the derivatives — exactly
// the shape of thing that compiles in Node and is rejected by Dawn.
console.log(String.fromCharCode(10) + "── STREET REFLECTION ──");
{
  const target = new THREE.RenderTarget(64, 64, { type: THREE.HalfFloatType });
  let rBuilder = null, rErr = null;
  try {
    const streets = createCityStreets({
      P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0,
      reflectionTexture: target.texture,
    });
    check("a reflective street reports canReflect", streets.canReflect === true);
    check("setReflection exists and tolerates a null frame",
      (() => { try { streets.setReflection(null, null, null, null, false); return true; } catch { return false; } })());
    rBuilder = buildWGSL(streets.material);
  } catch (e) { rErr = e; }
  check("the reflective street generates WGSL without throwing", rErr === null, rErr ? rErr.message : "");
  if (rErr && process.env.CITY_SHADER_TRACE) console.log(rErr.stack);

  if (rBuilder) {
    const f = rBuilder.fragmentShader || "";
    if (process.env.CITY_REFLECT_DUMP) {
      const fs = await import("node:fs");
      fs.writeFileSync(process.env.CITY_REFLECT_DUMP, f);
    }
    check("no 'undefined' leaked into the reflective street WGSL", !/\bundefined\b/.test(f));
    // Three taps of the mirror, not one — the vertical smear that keeps a
    // half-resolution reflection from reading as a hard-edged decal. They are
    // BIASED samples specifically: `.blur()` sets a mip bias so the mirror is
    // as rough as the water it lands in, and a plain `textureSample` here
    // would mean that blur had been optimised away.
    const taps = (f.match(/textureSampleBias\(/g) || []).length;
    check("the mirror is sampled three times, mip-biased", taps === 3, `${taps} biased samples`);
    const bad2 = [];
    let cur = { name: "<module>", lines: [] };
    const rfns = [];
    for (const ln of f.split(String.fromCharCode(10))) {
      const m = /^fn\s+([A-Za-z_]\w*)/.exec(ln);
      if (m) { rfns.push(cur); cur = { name: m[1], lines: [] }; }
      cur.lines.push(ln);
    }
    rfns.push(cur);
    for (const fn of rfns) {
      let ctrl = 0;
      for (const ln of fn.lines) {
        if (/\bdpdx\b|\bdpdy\b|\bfwidth\b/i.test(ln) && ctrl > 0) bad2.push(`${fn.name}: ${ln.trim().slice(0, 60)}`);
        const o = (ln.match(/\{/g) || []).length, c = (ln.match(/\}/g) || []).length;
        if (ctrl > 0 || /\b(if|else|for|while|loop|switch|case)\b/.test(ln)) ctrl += o - c;
        if (ctrl < 0) ctrl = 0;
      }
    }
    check("no reflection derivative is taken inside a branch", bad2.length === 0, bad2.slice(0, 2).join(" | "));
  }
  target.dispose();
}

// ── Street furniture: five materials, each carrying a lamp/skyglow emissive ──
// These read `varyingProperty('vInstanceColor')`, which only EXISTS when the
// mesh has an instanceColor — reading it otherwise is the kind of thing that
// compiles here and renders black in the browser.
console.log("\n── FURNITURE SHADERS ──");
{
  const streets = createCityStreets({ P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0 });
  const furn = createCityFurniture({
    P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0,
    lamp: { pool: streets.lampPoolFree, color: streets.lampColor },
    // PROCEDURAL TREES EXPLICITLY. These checks are about the procedural
    // furniture's instance-tint contract, and the preset tree path builds no
    // procedural trunk/canopy at all — so leaving this to the default would
    // make the assertion below track a look setting rather than the shaders it
    // is meant to guard. The preset path fetches a JSON, an atlas and a GLB and
    // is not exercised headlessly.
    params: { treeSource: "procedural" },
  });
  const mats = [];
  furn.group.traverse((o) => { if (o.isInstancedMesh) mats.push([o.name, o.material, o]); });
  // Six original kinds, the four street-clutter ones (which share ONE material
  // between them — see the clutter section of cityKitTest), the road signs, and
  // the overhead direction gantries.
  check("every furniture kind has a material", mats.length === 12, mats.map(([n]) => n).join(","));

  let bad = null;
  for (const [name, mat, mesh] of mats) {
    try {
      const b = buildWGSL(mat, { instanced: mesh });
      const f = b.fragmentShader || "";
      if (/\bundefined\b/.test(f)) { bad = `${name}: 'undefined' in the source`; break; }
      if (!/\bif\s*\(|Light|shadow/i.test(f)) { bad = `${name}: no lighting`; break; }
    } catch (e) { bad = `${name}: ${e.message}`; break; }
  }
  check("every furniture material generates WGSL", bad === null, bad || `${mats.length} materials`);

  // A material that reads vInstanceColor MUST be on a mesh that writes it.
  // The signals are NOT on this list any more: they carry their lens tints in
  // vertex colours and their cycle position in `aPhase`, because instanceColor
  // is multiplied into colorNode whether you want it or not — which is how the
  // old lens colour ended up tinting the body instead of lighting the lens.
  let mismatched = [];
  for (const [name, , mesh] of mats) {
    const needs = /Cars|Canopies|Traffic$/.test(name);
    if (needs && !mesh.instanceColor) mismatched.push(name);
  }
  check("every material reading the instance tint is on a mesh that writes one", mismatched.length === 0, mismatched.join(","));

  // The signals' own contract: one float per mast saying where in the cycle it
  // sits. Without it every light in the city shows the same colour at once.
  {
    const sig = mats.find(([n]) => /TrafficLights/.test(n));
    const attr = sig?.[2]?.geometry?.getAttribute?.("aPhase");
    check("traffic signals carry a per-instance cycle phase", !!attr && attr.count === sig[2].count,
      attr ? `${attr.count} phases for ${sig[2].count} masts` : "aPhase missing");
    // Opposed approaches: a junction's two axes must never be green together.
    const vals = attr ? [...new Set(Array.from(attr.array).map((v) => +(v % 1).toFixed(3)))] : [];
    const opposed = vals.some((v) => vals.some((w) => Math.abs(((w - v) % 1 + 1) % 1 - 0.5) < 1e-3));
    check("cross streets are half a cycle apart", opposed, `${vals.length} distinct phases`);
  }

  furn.dispose();
  streets.dispose();
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
