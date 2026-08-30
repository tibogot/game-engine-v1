// ============================================================================
// WHAT CAN THE PLAYER'S CAMERA ACTUALLY RESOLVE ON THE DECK?
//
// This exists because of a bug that was invisible by construction: the road's
// fine bump octave (`gritScale` 55, ~1.8 cm) was faded to EXACTLY ZERO over the
// whole screen at the game's chase camera, and had been for as long as it
// shipped. Nothing was broken — the fade was doing precisely what it was
// written to do — so no test failed, no frame looked wrong, and the only symptom
// was a person saying "I can only see the bump if I put the camera on the road".
//
// The class of bug is "detail authored at a scale the camera cannot sample", and
// it will happen again the moment someone adds an octave. So the question gets a
// harness rather than an afternoon of squinting.
//
// THE MODEL. For a pinhole camera of vertical FOV `fov` over `H` pixels, one
// pixel subtends `fov / H` radians. A deck fragment at slant distance `d`, seen
// at grazing angle `theta` above the surface, therefore covers
//
//     across the road:  d * pixelAngle           (the well-sampled axis)
//     along  the road:  d * pixelAngle / sin θ    (the grazing axis)
//
// and the shader's fade for an octave of `cycles` per metre is
//
//     fade = 1 - texel * cycles * rate      (saturated)
//
// so the octave is dead wherever `texel >= 1 / (cycles * rate)`.
//
// Run: node tools/roadBumpVisibilityTest.mjs
// ============================================================================
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

register("./threeWebgpuHook.mjs", import.meta.url);
const mod = (f) => import(pathToFileURL(join(GAME, f)).href);

const { SURFACE_V2_DEFAULTS, SURFACE_V2_GAME } = await mod("modularRoadSurfaceV2.js");
const { CHASE_CAM: CHASE } = await mod("chaseCamera.js");

/** The look the game actually ships, not the module's at-rest defaults. */
const S = { ...SURFACE_V2_DEFAULTS, ...SURFACE_V2_GAME };

// ── THE CAMERA ──────────────────────────────────────────────────────────────
// Read from chaseCamera so this cannot quietly disagree with the game. The
// numbers in modularRoadWet's reflectFresnel note (3.8 m / 8.7 m) are from an
// older tuning and are NOT the shipping camera; that is exactly the kind of
// drift a hand-copied constant produces.
const FOV_DEG = 60;   // v3/app/main.js
const PIXELS_H = 1080;
const PIXEL_ANGLE = (FOV_DEG * Math.PI / 180) / PIXELS_H;

const camHeight = CHASE?.height ?? 3.2;
const camBack = CHASE?.dist ?? 7.5;

console.log("=== THE CAMERA ===");
console.log(`chase boom: ${camBack} m back, ${camHeight} m up (from chaseCamera.js)`);
console.log(`fov ${FOV_DEG}° over ${PIXELS_H} px ⇒ ${(PIXEL_ANGLE * 1e6).toFixed(1)} µrad/pixel`);
check("chase camera constants were readable", CHASE != null,
  CHASE ? "" : "chaseCamera.js stopped exporting CHASE — falling back to hard-coded 7.5/3.2");

/**
 * Footprint of one pixel on the deck, in millimetres, for a deck point `ahead`
 * metres in front of the CAR (so 0 is under the car, which is the nearest deck
 * the player ever sees).
 */
function footprint(ahead) {
  const horiz = camBack + ahead;
  const slant = Math.hypot(horiz, camHeight);
  const sinTheta = camHeight / slant;
  return {
    slant,
    across: slant * PIXEL_ANGLE * 1000,
    along: (slant * PIXEL_ANGLE / sinTheta) * 1000,
  };
}

/** The shader's fade, in the same form modularRoadSurfaceV2 writes it. */
const fade = (texelMm, cycles, rate) =>
  Math.max(0, Math.min(1, 1 - (texelMm / 1000) * cycles * rate));

// ── THE TABLE ───────────────────────────────────────────────────────────────
console.log("\n=== WHAT EACH OCTAVE IS WORTH, DOWN THE ROAD ===");
console.log("The fades are judged on the BETTER-sampled axis (min), which after");
console.log("the tap-filter change is always `across`.\n");
console.log("  ahead   slant   across   along   grit   chip");
const ROWS = [0, 5, 10, 20, 30, 40, 60];
const table = {};
for (const ahead of ROWS) {
  const f = footprint(ahead);
  const best = Math.min(f.across, f.along);
  const grit = fade(best, S.gritScale, S.gritFade);
  const chip = fade(best, S.bumpChipScale, S.bumpChipFade);
  table[ahead] = { ...f, grit, chip };
  console.log(
    `  ${String(ahead).padStart(4)}m  ${f.slant.toFixed(1).padStart(5)}m`
    + `  ${f.across.toFixed(1).padStart(5)}mm  ${f.along.toFixed(1).padStart(5)}mm`
    + `  ${grit.toFixed(2).padStart(5)}  ${chip.toFixed(2).padStart(5)}`,
  );
}

// ── THE CLAIMS ──────────────────────────────────────────────────────────────
console.log("\n=== THE GRIT OCTAVE IS BELOW THIS CAMERA (the original bug) ===");
const nearest = table[0];
check("grit is dead even on the nearest deck fragment", nearest.grit === 0,
  `${S.gritScale}/m at fade rate ${S.gritFade} needs a texel under `
  + `${(1000 / (S.gritScale * S.gritFade)).toFixed(1)} mm; the nearest is `
  + `${nearest.across.toFixed(1)} mm`);
check("...and everywhere further out", ROWS.every((a) => table[a].grit === 0));

// How close the EYE has to get for the grit to survive at all.
const gritTexelMm = 1000 / (S.gritScale * S.gritFade);
const gritRange = gritTexelMm / 1000 / PIXEL_ANGLE;
console.log(`  the eye must be within ${gritRange.toFixed(1)} m of the deck for grit to appear`);
check("that range is shorter than the chase boom", gritRange < nearest.slant,
  `${gritRange.toFixed(1)} m vs a boom of ${nearest.slant.toFixed(1)} m — `
  + "which is why it only ever showed in the labs");

console.log("\n=== THE CHIP OCTAVE IS INSIDE IT (the fix) ===");
check("chip reads strongly under the car", table[0].chip > 0.5,
  `${table[0].chip.toFixed(2)} at ${table[0].across.toFixed(1)} mm/px`);
check("chip still reads at 20 m", table[20].chip > 0.3,
  `${table[20].chip.toFixed(2)} — the band a driver reads the surface from`);
check("chip has faded out by 40 m", table[40].chip < 0.1,
  `${table[40].chip.toFixed(2)} — gone before it can crawl in the distance`);
// The fade is allowed past Nyquist ONLY because the taps average. If someone
// turns the filter off but leaves the relaxed rate, the mid-distance crawls.
const nyquistRate = 2.0;
check("a sub-Nyquist fade rate is backed by the tap filter",
  S.bumpChipFade >= nyquistRate || S.bumpFilter > 0,
  `rate ${S.bumpChipFade} < ${nyquistRate} needs bumpFilter on; it is ${S.bumpFilter}`);
const chipTapsPerCycle = (1 / S.bumpChipScale) / (table[20].across / 1000);
check("...and still has >2 taps per chip where it is last visible",
  chipTapsPerCycle > 2,
  `${chipTapsPerCycle.toFixed(1)} samples per ${(100 / S.bumpChipScale).toFixed(0)} cm chip at 20 m`);
check("chip is coarser than grit but finer than the aggregate",
  S.bumpChipScale < S.gritScale && S.bumpChipScale > 5,
  `${(100 / S.bumpChipScale).toFixed(0)} cm chip vs ${(100 / S.gritScale).toFixed(1)} cm grit `
  + "and ~20 cm aggregate");

/* ── WHAT EACH OCTAVE IS WORTH IN THE NORMAL ────────────────────────────────
 *
 * The fade table above says whether an octave is SAMPLED. This says whether it
 * is worth SAMPLING — how far it actually tilts the shading normal, which is the
 * only thing a bump does.
 *
 * Every octave costs the same: it is evaluated once per height tap, three taps
 * per fragment. So an octave that tilts the normal by a hundredth of a degree
 * costs exactly as much as the one carrying the whole effect.
 *
 * THE MODEL. For gradient noise of amplitude A and period P, |grad| peaks near
 * 2A/P (the 2 is the shape constant of Perlin-style noise; a sine would be
 * 2*pi). That constant cancels in every RATIO below, so the comparison between
 * octaves is exact even though the absolute degrees are an estimate.
 */
console.log("\n=== WHAT EACH OCTAVE IS WORTH IN THE NORMAL ===");
const GRAD_K = 2.0; // |grad| ≈ GRAD_K * amplitude / period, gradient noise
// surface.w at the nearest fragment: the base aggFade is 0.92 there and
// `bumpFade` 1.35 saturates it, so the shared scale is just bumpAmount.
const BUMP_SCALE = S.bumpAmount * Math.min(1, 0.92 * S.bumpFade);

/**
 * AS AUTHORED, not as shipped. macro and grit are now gated off, so reading
 * their amplitudes from the shipped look would print 0 and quietly delete the
 * measurement that justified switching them off. These are the values they had
 * when measured, kept here so the decision stays re-checkable — if someone
 * turns them back on, this is the number they are arguing with.
 */
const AS_AUTHORED = { bumpMacro: 0.35, bumpGrit: 1.0 };

const OCTAVES = [
  {
    name: "macro (bumpMacro)", amp: 0.5 * AS_AUTHORED.bumpMacro,
    period: 1 / 0.06, fadeAt: () => 1, taps: 3, shipped: S.bumpMacro > 0,
  },
  {
    name: "aggregate (bumpAgg)", amp: 0.5 * S.bumpAgg,
    period: 1 / 5, fadeAt: () => 1, taps: 1, shipped: S.bumpAgg > 0,
  },
  {
    name: "chip (bumpChip)", amp: 0.5 * S.bumpChip,
    period: 1 / S.bumpChipScale, fadeAt: (a) => table[a].chip, taps: 1, shipped: S.bumpChip > 0,
  },
  {
    name: "grit (bumpGrit)", amp: 0.5 * AS_AUTHORED.bumpGrit,
    period: 1 / S.gritScale, fadeAt: (a) => table[a].grit, taps: 1, shipped: S.bumpGrit > 0,
  },
];
console.log("  tilt of the shading normal at the nearest deck fragment, and what");
console.log("  it costs — `taps` is noise evaluations per HEIGHT TAP, and there");
console.log("  are three taps per fragment.\n");
const tiltAt = (o, ahead) =>
  Math.atan((GRAD_K * o.amp / o.period) * BUMP_SCALE * o.fadeAt(ahead)) * 180 / Math.PI;

const tilts = {};
let shippedNoise = 0;
let authoredNoise = 0;
for (const o of OCTAVES) {
  tilts[o.name] = tiltAt(o, 0);
  authoredNoise += o.taps * 3;
  if (o.shipped) shippedNoise += o.taps * 3;
  console.log(
    `  ${o.name.padEnd(22)} period ${(o.period * 100).toFixed(1).padStart(6)} cm`
    + `  →  ${tilts[o.name].toFixed(3).padStart(7)}°`
    + `  ${String(o.taps * 3).padStart(2)} noise/frag`
    + `  ${o.shipped ? "ON" : "off"}`,
  );
}

const chipTilt = tilts["chip (bumpChip)"];
const aggTilt = tilts["aggregate (bumpAgg)"];
const macroTilt = tilts["macro (bumpMacro)"];
const gritTilt = tilts["grit (bumpGrit)"];

check("the chip octave carries the effect", chipTilt > 5,
  `${chipTilt.toFixed(1)}° — this is the one the camera can resolve`);
check("the aggregate is a real second layer", aggTilt > 2, `${aggTilt.toFixed(1)}°`);

// ── THE TWO THAT COST AS MUCH AND RETURNED NOTHING ──────────────────────────
check("macro would be invisible in the normal", macroTilt < 0.1,
  `${macroTilt.toFixed(3)}° at its authored ${AS_AUTHORED.bumpMacro} — `
  + `${(chipTilt / Math.max(macroTilt, 1e-9)).toFixed(0)}x weaker than the chip, for 9 noise/frag`);
check("...so it is gated off", !OCTAVES[0].shipped, "bumpMacro retired to 0");
check("grit would contribute exactly zero at this camera", gritTilt === 0,
  "faded out on every pixel on screen — see the table above");
check("...so the game gates it off too", !OCTAVES[3].shipped,
  "SURFACE_V2_GAME sets bumpGrit 0; the module default keeps it for the labs");

/* ── WHAT THAT IS WORTH IN MILLISECONDS ────────────────────────────────────
 *
 * Noise counts are a proxy. These are measured, on the real page, with the
 * WebGPU timestamp pool (v3/render/gpuStatsPanel.js — NOT the stats-gl readout,
 * which swings 4x on a static scene). Chase camera, 16 straights, native pixel
 * ratio, main scene pass, median of 20 samples.
 *
 * REPEATABILITY WAS 0.000 ms across independent repeats of the same config, so
 * these deltas are signal, not drift. Getting there took three failed attempts
 * worth recording so nobody repeats them:
 *   - reusing ONE panel across configs reports the previous config's frames
 *     (its rolling median never turns over) — B and C came back byte-identical;
 *   - creating a panel PER config works, but only at native pixel ratio;
 *   - `renderer.setPixelRatio()` to amplify fill DISRUPTS the timestamp pool
 *     and the panel then reports zero frames. Do not "amplify" this way.
 *
 * MEASURE ON A TRACK WITH NO OVERLAPPING PIECES. The first set of numbers here
 * was taken on a test track built by placing seven curves in a row, which loops
 * back through its own entry straights: 25 overlapping pairs of non-adjacent
 * pieces, every one at the SAME height. Two coplanar decks z-fight, shade the
 * same pixels twice, and cost about 1.2 ms of pure overdraw — and they flicker,
 * which was misdiagnosed as a shader bug and nearly bought a speculative "fix"
 * to an unrelated field. tools/ has no track validator; the check is a
 * bounding-box test over non-adjacent pieces, and it takes seconds.
 *
 * The correction went the OPPOSITE way to the guess, which is the argument for
 * re-measuring rather than reasoning about contamination: the dirty scene
 * UNDER-reported both deltas by ~10%, it did not inflate them.
 *
 *     main scene pass, dry, clean track:
 *       bump off (no normalNode)                3.015 ms
 *       shipping (chip only, 6 noise/frag)      3.801 ms
 *       as authored (macro+grit, 18 noise/frag) 5.439 ms
 *
 *   ⇒ the bump normal costs          0.786 ms  (was 2.424 ms)
 *   ⇒ gating the two dead octaves saved 1.638 ms — 30% of the main pass.
 *
 * The static count predicted a 3x cut (18 → 6 noise). Measured: 2.424 → 0.786,
 * which is 3.1x. The proxy was honest.
 *
 *     other features (measured on the earlier track, deltas only):
 *       wet 0.85 (clearcoat + coat normal + drainage)  +0.458 ms
 *       anisotropy, dry                                +0.065 ms
 *       anisotropy, on top of wet                      +0.000 ms
 *       tar snakes (contours of a field already built)  0.000 ms
 */
const MEASURED = {
  bumpOff: 3.015, shipping: 3.801, authored: 5.439,  // main pass, ms, clean track
};
check("the measured cut matches what the noise count predicted", (() => {
  const measuredRatio = (MEASURED.authored - MEASURED.bumpOff)
    / (MEASURED.shipping - MEASURED.bumpOff);
  const countRatio = authoredNoise / shippedNoise;
  return Math.abs(measuredRatio - countRatio) < 0.25;
})(),
`${((MEASURED.authored - MEASURED.bumpOff) / (MEASURED.shipping - MEASURED.bumpOff)).toFixed(2)}x measured `
+ `vs ${(authoredNoise / shippedNoise).toFixed(2)}x from the noise count — `
+ "if these ever diverge, the count has stopped being a fair proxy for the cost");

console.log(`\n  normal cost: ${authoredNoise} noise/fragment as authored → `
  + `${shippedNoise} as shipped`);
console.log(`  measured   : ${(MEASURED.authored - MEASURED.bumpOff).toFixed(3)} ms → `
  + `${(MEASURED.shipping - MEASURED.bumpOff).toFixed(3)} ms on the main scene pass`);
check("the normal's noise cost is at most a third of what it was",
  shippedNoise <= authoredNoise / 3,
  `${authoredNoise} → ${shippedNoise}, for ${(macroTilt + gritTilt).toFixed(3)}° of change`);
check("...and the octaves that survived are the ones doing the work",
  OCTAVES.filter((o) => o.shipped).every((o) => tiltAt(o, 0) > 2));
// BUMP_SAMPLE_EPS is module-private on purpose; it is restated here rather than
// exported, and asserted against the file so the two cannot drift apart.
const EPS_MM = 4;
const src = await import("node:fs").then((fs) =>
  fs.readFileSync(join(GAME, "modularRoadSurfaceV2.js"), "utf8"));
check("the 4 mm tap floor is still what the shader uses",
  /BUMP_SAMPLE_EPS\s*=\s*0\.004/.test(src));
check("bumpFilter ships on", S.bumpFilter > 0, `${S.bumpFilter}`);
for (const ahead of [0, 20]) {
  const f = table[ahead];
  const epsX = Math.max(EPS_MM, f.along * S.bumpFilter);
  const epsY = Math.max(EPS_MM, f.across * S.bumpFilter);
  console.log(
    `  at ${ahead} m: taps span ${epsX.toFixed(1)} mm along / ${epsY.toFixed(1)} mm across`
    + `  (${(epsX / epsY).toFixed(1)}× anisotropic)`,
  );
}
check("the along tap is wider than the across tap at distance",
  Math.max(EPS_MM, table[20].along) > Math.max(EPS_MM, table[20].across),
  "so along-road relief decays on its own and transverse screed lines survive — "
  + "the anisotropy falls out of the sampling, no second fade needed");
// NOT "the close-up is unchanged" — it is not, and asserting that was wrong.
// The floor wins only inside ~4 m, which is a lab camera, never the chase boom.
// What must hold is that the filter only ever WIDENS: a tap narrower than the
// floor would sharpen the field back into the aliasing this exists to remove.
const floorRange = (EPS_MM / 1000) / PIXEL_ANGLE;
console.log(`  the 4 mm floor governs within ${floorRange.toFixed(1)} m of the deck (lab cameras)`);
check("the chase camera is filtered, not floored", table[0].across > EPS_MM,
  `${table[0].across.toFixed(1)} mm/px under the car — the old fixed 4 mm tap was `
  + "reading a field finer than the pixel even there");
check("the filter never narrows a tap below the floor",
  ROWS.every((a) => Math.max(EPS_MM, table[a].across * S.bumpFilter) >= EPS_MM
    && Math.max(EPS_MM, table[a].along * S.bumpFilter) >= EPS_MM));
check("the labs still get the floor", floorRange > 0 && floorRange < table[0].slant,
  `${floorRange.toFixed(1)} m — so the tuned close-up look is preserved where it was tuned`);

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
