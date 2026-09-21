/**
 * The noise under the procedural decals.
 *
 * The generators themselves need a canvas and so cannot run here, but their
 * MASK is this noise, and a mask built on broken noise fails in a way that is
 * easy to miss and miserable to debug: it does not throw, it just produces a
 * decal that is solid or empty rather than dirt.
 *
 * The specific failure this guards is documented and has bitten this repo
 * before — a value-noise hash written with `*` instead of `Math.imul` loses
 * the low bits of the product to float precision and comes out ONE-SIDED. It
 * still looks like numbers in 0..1; it simply never crosses the middle, so
 * every threshold built on it is all-on or all-off.
 *
 *   node tools/decalArtTest.mjs
 */
import { makeValueNoise, fbm } from "../v3/render/decals/decalArt.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

console.log("value noise");
{
  const n = makeValueNoise(7);
  const vals = [];
  for (let y = 0; y < 90; y++) for (let x = 0; x < 90; x++) vals.push(n(x * 0.37, y * 0.37));

  const lo = Math.min(...vals), hi = Math.max(...vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  ok("stays in range", lo >= 0 && hi <= 1, `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`);

  // THE ONE THAT MATTERS.
  const below = vals.filter((v) => v < 0.5).length / vals.length;
  ok("crosses the middle in both directions", below > 0.25 && below < 0.75,
    `${(below * 100).toFixed(0)}% below 0.5`);
  ok("mean sits near the middle", Math.abs(mean - 0.5) < 0.09, `mean ${mean.toFixed(3)}`);
  ok("uses the whole range", hi - lo > 0.75, `spread ${(hi - lo).toFixed(3)}`);

  // Smooth: neighbouring samples must not jump, or the mask is white noise and
  // every decal comes out as static.
  let maxStep = 0;
  for (let i = 0; i < 400; i++) {
    const x = i * 0.013, y = 3.7;
    maxStep = Math.max(maxStep, Math.abs(n(x + 0.01, y) - n(x, y)));
  }
  ok("is smooth, not static", maxStep < 0.12, `max step ${maxStep.toFixed(4)} per 0.01 cell`);

  // Deterministic, so a stored data URL and a regeneration agree.
  const m = makeValueNoise(7);
  ok("same seed, same field", [0.3, 1.7, 9.1].every((v) => n(v, v * 1.3) === m(v, v * 1.3)));
  const other = makeValueNoise(8);
  ok("different seed, different field", [0.3, 1.7, 9.1].some((v) => n(v, v) !== other(v, v)));
}

console.log("fbm");
{
  const n = makeValueNoise(3);
  const vals = [];
  for (let y = 0; y < 70; y++) for (let x = 0; x < 70; x++) vals.push(fbm(n, x * 0.11, y * 0.11, 4));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const below = vals.filter((v) => v < 0.5).length / vals.length;
  ok("stays in range", lo >= 0 && hi <= 1, `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
  ok("crosses the middle", below > 0.25 && below < 0.75, `${(below * 100).toFixed(0)}% below 0.5`);
  // Octaves narrow the distribution; it must still have enough range to break
  // a mask, or the decals come out as smooth gradients again.
  ok("keeps usable contrast", hi - lo > 0.35, `spread ${(hi - lo).toFixed(3)}`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
