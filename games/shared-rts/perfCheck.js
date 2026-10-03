// app.perfCheck() — the counters shared-rts/PERF_RULES.md is about, measured
// over one second of real frames in the current view, with a ⚠ on any that is
// out of line. Read-only: it wraps three's renderer for that second, then puts
// everything back. Usage, in the console or over MCP:  await __ALG.perfCheck()

/**
 * @param {object} app  startV3App's result
 * @param {{ ms?: number, print?: boolean }} [o]
 */
export async function perfCheck(app, { ms = 1000, print = true } = {}) {
  const R = app.renderer, be = R.backend, B = R._bindings;
  // Shader builds against distinct shaders (rules 3-6).
  const cache = R._nodes.nodeBuilderCache;
  const distinct = new Set();
  for (const s of cache.values()) distinct.add((s.vertexShader || "") + "|" + (s.fragmentShader || s.computeShader || ""));

  // One second of frames: render objects, GPU draws, uniform uploads (rules 7-9).
  let frames = 0, ros = 0, gpuDraws = 0, uploads = 0, bytes = 0, objArrays = 0;
  const objArrayBy = new Map();
  let cur = null;
  const draw = be.draw, ub = be.updateBinding, ufr = B.updateForRender;
  be.draw = function (ro) {
    ros++;
    const off = ro.object.geometry?.indirectOffset;
    gpuDraws += Array.isArray(off) ? off.length : 1;
    return draw.apply(this, arguments);
  };
  B.updateForRender = function (ro) { cur = ro; try { return ufr.call(this, ro); } finally { cur = null; } };
  be.updateBinding = function (b) {
    uploads++;
    bytes += b.buffer?.byteLength ?? 0;
    // A per-object ARRAY re-sent each draw: always a rule-7 miss — except in
    // three's own full-screen passes (bloom blur weights…), not ours to fix,
    // and outside any draw (a compute dispatch: once per dispatch, not per draw).
    if (b.groupNode?.name === "object" && !b.uniforms && cur && !cur.object?.isQuadMesh) {
      objArrays++;
      const k = (cur?.object?.name || cur?.object?.type || "?").replace(/\d+/g, "#");
      objArrayBy.set(k, (objArrayBy.get(k) || 0) + 1);
    }
    return ub.call(this, b);
  };
  try {
    await new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => { frames++; if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve(); };
      requestAnimationFrame(tick);
    });
  } finally {
    be.draw = draw; be.updateBinding = ub; B.updateForRender = ufr;
  }
  const f = Math.max(1, frames);
  const r = {
    frames,
    shaderBuilds: cache.size,
    distinctShaders: distinct.size,
    buildsPerShader: +(cache.size / Math.max(1, distinct.size)).toFixed(2),
    renderObjectsPerFrame: Math.round(ros / f),
    gpuDrawsPerFrame: Math.round(gpuDraws / f),
    uploadsPerFrame: Math.round(uploads / f),
    uploadKBPerFrame: Math.round(bytes / f / 1024),
    uploadsPerRenderObject: +(uploads / Math.max(1, ros)).toFixed(2),
    perObjectArrayUploadsPerFrame: Math.round(objArrays / f),
    perObjectArrayCulprits: [...objArrayBy].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} ${Math.round(n / f)}/frame`),
  };
  const warn = [];
  if (r.buildsPerShader >= 1.6) warn.push(`builds/shader ${r.buildsPerShader} ≥ 1.6 — per-type materials, count > 1 or instanceColor (rules 3-6)`);
  if (r.uploadsPerRenderObject >= 1) warn.push(`uploads/object ${r.uploadsPerRenderObject} ≥ 1 — a per-frame value in a per-object group (rules 7-8)`);
  if (r.perObjectArrayUploadsPerFrame > 0) warn.push(`${r.perObjectArrayUploadsPerFrame} per-object array uploads a frame — uniformArray without a shared group (rule 7): ${r.perObjectArrayCulprits.join(", ")}`);
  r.warnings = warn;
  if (print) {
    console.log("[perfCheck]", r);
    for (const w of warn) console.warn("[perfCheck] ⚠ " + w);
    if (!warn.length) console.log("[perfCheck] ✓ within the rules (shared-rts/PERF_RULES.md)");
  }
  return r;
}
