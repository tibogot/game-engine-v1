// Lightning timing: the flicker, the falloff, and the light/sound pairing.
//
// WHY THIS IS TESTABLE AT ALL. modularRoadLightning.js renders nothing and holds
// no GPU state — it is a clock that emits one number — precisely so the timing
// can be asserted here instead of being judged by watching a storm for a minute
// and hoping. The rng is injectable for the same reason.
//
// WHAT IS WORTH GUARDING. Not the look; the STRUCTURE that makes it read as
// lightning rather than as a light switch:
//   • a strike is several strokes, not one ramp
//   • the flash decays fast and reaches zero
//   • distance sets brightness and thunder delay from the SAME roll, so a dim
//     flash always has a long wait — break that pairing and a storm stops
//     having a geography
//
// Run: node tools/lightningTimingTest.mjs
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const { createLightning } = await import(
  pathToFileURL(join(GAME, "modularRoadLightning.js")).href
);

/** Deterministic rng so a red here is a real change, not an unlucky roll. */
function seeded(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Run the clock at a fixed step, collecting the flash each frame. */
function run(l, seconds, dt = 1 / 60) {
  const out = [];
  for (let t = 0; t < seconds; t += dt) out.push(l.update(dt));
  return out;
}

console.log("=== OFF MEANS OFF ===");
{
  const l = createLightning({ amount: 0 }, seeded());
  const trace = run(l, 60);
  check("no flash at amount 0", Math.max(...trace) === 0);
  check("no thunder queued", l.pendingThunder === 0);
  check("nextIn is Infinity", l.nextIn === Infinity);
}

console.log("\n=== A STRIKE IS A FLICKER, NOT A RAMP ===");
{
  const l = createLightning({ amount: 1 }, seeded(7));
  l.strike(300);
  const trace = run(l, 1.2);
  check("it lights up", Math.max(...trace) > 0.2, `peak ${Math.max(...trace).toFixed(3)}`);

  // Count local maxima above a floor: a single decay has ONE, a multi-stroke
  // strike has one per stroke. This is the property that separates lightning
  // from somebody switching a lamp.
  // Start at 0, NOT 1. The leader stroke's maximum is the very first sample —
  // it is created and read in the same frame — so a loop starting at 1 skips
  // the brightest peak of the strike and reports every strike as a single
  // stroke. That false red is what this comment is preventing a repeat of.
  let peaks = 0;
  for (let i = 0; i < trace.length - 1; i++) {
    const prev = i === 0 ? -1 : trace[i - 1];
    if (trace[i] > 0.02 && trace[i] >= prev && trace[i] > trace[i + 1]) peaks++;
  }
  check("more than one stroke in a strike", peaks >= 2, `${peaks} peaks`);
  check("it goes fully dark again", trace[trace.length - 1] === 0);
}

console.log("\n=== THE FLASH IS BOUNDED ===");
{
  // Strokes SUM, so a leader plus two returns can overshoot without the clamp.
  const l = createLightning({ amount: 1, strength: 4, distance: [10, 20] }, seeded(3));
  l.strike(10);
  const trace = run(l, 1);
  check("never exceeds 1 even when overdriven", Math.max(...trace) <= 1,
    `peak ${Math.max(...trace).toFixed(3)}`);
}

console.log("\n=== DISTANCE PAIRS LIGHT WITH SOUND ===");
{
  // A gap of a million seconds so the clock fires NOTHING on its own. Without it
  // the measurement loop below runs for up to 30 s of virtual time with a storm at
  // full rate, auto-strikes queue their own thunder, and `takeThunder` hands back
  // whichever clap arrives first — which is not the one under test. That is how
  // this read 9.68 s for a 3800 m strike whose sound cannot arrive before 11.08.
  const solo = { amount: 1, gapAtFull: [1e6, 1e6], gapAtLow: [1e6, 1e6] };
  const near = createLightning(solo, seeded(11));
  const far = createLightning(solo, seeded(11));
  const n = near.strike(300);
  const f = far.strike(3800);
  check("the near strike is brighter", n.peak > f.peak,
    `${n.peak.toFixed(2)} vs ${f.peak.toFixed(2)}`);

  // Thunder arrives at d / 343 s. Step until it lands and compare.
  const arriveAt = (l, d) => {
    const dt = 1 / 60;
    for (let t = 0; t < 30; t += dt) {
      l.update(dt);
      if (l.takeThunder()) return t;
    }
    return Infinity;
  };
  const tn = arriveAt(near, 300);
  const tf = arriveAt(far, 3800);
  check("near thunder arrives sooner", tn < tf, `${tn.toFixed(2)}s vs ${tf.toFixed(2)}s`);
  check("near delay matches 300/343", Math.abs(tn - 300 / 343) < 0.1, `${tn.toFixed(2)}s`);
  check("far delay matches 3800/343", Math.abs(tf - 3800 / 343) < 0.2, `${tf.toFixed(2)}s`);
}

console.log("\n=== THE STORM RATE FOLLOWS `amount` ===");
{
  const count = (amount, seed) => {
    const l = createLightning({ amount }, seeded(seed));
    let n = 0;
    let prev = 0;
    const dt = 1 / 60;
    for (let t = 0; t < 600; t += dt) {
      const v = l.update(dt);
      // A new strike shows up as a jump from dark.
      if (prev === 0 && v > 0) n++;
      prev = v;
    }
    return n;
  };
  // Averaged over seeds: one roll can be unlucky, the trend cannot.
  let full = 0, low = 0;
  for (const s of [1, 2, 3, 4, 5]) { full += count(1, s); low += count(0.15, s); }
  check("a full storm strikes far more often than a distant one", full > low * 2,
    `${full} vs ${low} strikes over 5x10 min`);
  check("a distant storm still strikes at all", low > 0, `${low}`);
}

console.log("\n=== TURNING IT OFF CLEARS WHAT WAS IN FLIGHT ===");
{
  const l = createLightning({ amount: 1 }, seeded(9));
  l.strike(3800);           // ~11 s of thunder still travelling
  check("thunder is queued", l.pendingThunder === 1);
  l.setAmount(0);
  l.update(1 / 60);
  check("no thunder left hanging after the storm ends", l.pendingThunder === 0,
    "otherwise a clap arrives over a clear sky");
  check("flash is zero", l.flash === 0);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
