// STABLE SHADER TEXT ACROSS LOADS (2026-10-16, measured on the alg-rts coast).
//
// Chrome caches compiled shaders on disk, keyed by their WGSL text. ~40 of the coast's ~395
// shaders came out with DIFFERENT text on every load, so they could never hit that cache and were
// compiled from scratch each time. The cause (three r184, WGSLNodeBuilder.getUniformFromNode): an
// unnamed buffer / storage buffer is named `NodeBuffer_<node.id>` — a GLOBAL counter, which depends
// on the order everything was created in (async loads, workers: it varies run to run).
//
// The fix: the same buffers renamed by their order of first use WITHIN EACH SHADER BUILD — the same
// graph gives the same names, whatever else was created before it. Names stay unique inside a
// module (one counter per builder), which is all WGSL needs.
//
// Installed once on the renderer, before anything compiles (main.js after renderer.init()).
const AUTO = /^NodeBuffer_\d+$/;
let _installed = false;

export function installStableShaderNames(renderer) {
  if (_installed || !renderer?.backend?.createNodeBuilder) return false;
  // the node builder class is not exported by three/webgpu: reach its prototype through an instance
  let probe = null;
  try { probe = renderer.backend.createNodeBuilder({ isMesh: false }, renderer); } catch { return false; }
  const proto = probe && Object.getPrototypeOf(probe);
  if (!proto?.getUniformFromNode || proto.isWGSLNodeBuilder === false) return false;
  const orig = proto.getUniformFromNode;
  proto.getUniformFromNode = function (node, type, shaderStage, name) {
    const u = orig.call(this, node, type, shaderStage, name);
    if (u && typeof u.name === "string" && AUTO.test(u.name)) {
      const map = (this._stableBufferNames ??= new Map());
      let stable = map.get(node);
      if (stable === undefined) { stable = `NodeBuffer_s${map.size}`; map.set(node, stable); }
      u.name = stable;
    }
    return u;
  };
  _installed = true;
  return true;
}
