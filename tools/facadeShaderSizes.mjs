// HOW BIG IS THE CITY FACADE, AND WHERE DID THE SIZE GO?
//
// The city's ~29 s first-frame wait is the GPU driver compiling WGSL —
// `city.stats.lastBuildMs` is 69 ms for 2106 buildings, and the whole game is
// 6.46 MB on the wire, so it is neither JS nor the network. That makes the
// generated shader's SIZE the number worth watching, and this prints it.
//
// It answers three questions that kept coming up as guesses:
//
//   • how much of the facade is the analytic relief trace?
//   • how much is the normal pass re-solving what the colour pass already did?
//   • what would a baked facade actually cost, first visit and thereafter?
//
// Lines, not bytes, because whitespace is not what a compiler pays for. Neither
// is exactly proportional to compile time — that is superlinear — so treat a
// ratio here as a floor on the saving, not a promise.
//
//   node tools/facadeShaderSizes.mjs
import { buildWGSL } from "./wgslBuilderStub.mjs";

const { createCityFacadeMaterial } = await import("../games/modular-road-v3/modularRoadCityFacade.js");

// The baked facade is a SPIKE and may not be here. Its absence is not an error.
let createBakedFacadeMaterial = null;
try {
  ({ createBakedFacadeMaterial } = await import("../games/modular-road-v3/modularRoadCityFacadeBaked.js"));
} catch { /* not present */ }

const LF = String.fromCharCode(10);
const lines = (s) => s.split(LF).length;
const row = (name, frag) => {
  console.log(`  ${name.padEnd(24)} ${(frag.length / 1024).toFixed(1).padStart(6)} kB · ${String(lines(frag)).padStart(5)} lines`);
  return lines(frag);
};

const frag = (m, o) => buildWGSL(m, o).fragmentShader || "";

console.log("FRAGMENT STAGE");
const analytic = createCityFacadeMaterial({ typeSplit: false });
const n = row("analytic near (L0/L1)", frag(analytic.material));
const f = row("analytic far  (L2)", frag(analytic.farMaterial));

// ── WHAT THE NORMAL PASS COSTS ───────────────────────────────────────────────
// three always builds `normalNode` in its OWN sub-build, so it cannot share the
// colour pass's flow — see the note at the top of modularRoadCityFacade.js. The
// facade's normal solve therefore re-runs the whole face solve AND the whole ray
// cast just to produce a normal. This is that duplication, priced.
const stripped = createCityFacadeMaterial({ typeSplit: false });
stripped.material.normalNode = null;
const noNorm = row("  ...without normalNode", frag(stripped.material));
console.log(`  → the duplicated normal pass is ${n - noNorm} lines, ${(((n - noNorm) / n) * 100).toFixed(0)}% of the near facade`);

// ── AND WHAT THE TRACE COSTS ─────────────────────────────────────────────────
// The far material differs from the near one by having no ray cast, no interior
// rooms, no per-brick bump and no normalNode. The gap is what the relief costs.
console.log(`  → relief + rooms + normal pass ≈ ${n - f} lines, ${(((n - f) / n) * 100).toFixed(0)}% of the near facade`);

if (!createBakedFacadeMaterial) {
  console.log(`${LF}  (no baked facade module — skipping the bake comparison)`);
  process.exit(0);
}

// ── THE BAKE, BOTH WAYS ──────────────────────────────────────────────────────
let baked = "";
try {
  baked = frag(createBakedFacadeMaterial().material);
} catch (e) {
  console.log(`${LF}BAKED FACADE FAILED TO BUILD: ${e.message}`);
  if (process.env.TRACE) console.log(e.stack);
  process.exit(1);
}
console.log("");
const b = row("baked near", baked);

// A bake pass runs the analytic shader with no lights and no normalNode: it is
// writing albedo, height and a mask into a render target, not lighting
// anything, and the trace already knows its own hit normal so that is just
// another attachment rather than a second solve.
const bakePass = lines(frag(stripped.material, { withLight: false }));

const today = n + f;
const cold = bakePass + b + f;
const warm = b + f;
console.log(`
  baked near is ${((b / n) * 100).toFixed(0)}% of analytic near — ${n - b} lines removed

  THE DRIVER COMPILES
    today                        ${String(today).padStart(5)} lines
    baked, first visit           ${String(cold).padStart(5)} lines   ${((cold / today) * 100).toFixed(0)}%   (bake ${bakePass} + draw ${warm})
    baked, atlas cached          ${String(warm).padStart(5)} lines   ${((warm / today) * 100).toFixed(0)}%

  So the bake is a REPEAT-VISIT win, not a first-visit one: the pass that fills
  the atlas still has to run the analytic shader once. It only pays if the atlas
  is cached — and if the browser's own pipeline cache already survives a reload,
  it may not pay at all. Measure a second load before building for this.`);

const count = (s, re) => (s.match(re) || []).length;
console.log(`
  texture samples   analytic ${count(frag(analytic.material), /textureSample\w*\(/g)}   baked ${count(baked, /textureSample\w*\(/g)}`);
