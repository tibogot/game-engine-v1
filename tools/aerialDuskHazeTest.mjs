// The ground haze thins as the sun goes down.
//
// Why this has a test at all: the curve's whole value is that it does NOTHING
// at noon. A regression here would not throw, would not show in a screenshot
// taken at dusk, and would quietly re-grade the stunt track — which is tuned at
// 10:30 and must not move. So the two properties are pinned:
//
//   • exactly 1 above `duskFadeDeg` (identity — noon cannot regress)
//   • monotone and smooth down to the horizon (a knee would read as the haze
//     stepping while the sun moves)
//
// The module needs a renderer, so the curve is lifted out of the source and run
// on its own — it is arithmetic on P and a sun direction, nothing else.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadAerial.js"), "utf8");

/**
 * The real function, lifted from the real file by brace matching — not a copy.
 * `uSunDir` is the module's uniform; here it is a stand-in with the same shape,
 * which is the only thing the body touches besides `P`.
 */
const { fn: groundHazeScale, uSunDir, P } = (() => {
  const at = SRC.indexOf("function groundHazeScale()");
  if (at < 0) throw new Error("groundHazeScale not found — has it been renamed?");
  const from = SRC.indexOf("{", at);
  let depth = 0, end = -1;
  for (let i = from; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  const body = SRC.slice(from + 1, end - 1);
  const sun = { value: { y: 0 } };
  const params = {};
  // eslint-disable-next-line no-new-func
  const fn = new Function("P", "uSunDir", body).bind(null, params, sun);
  return { fn, uSunDir: sun, P: params };
})();

/** The shipped defaults, read out of the same file. */
const DEFAULTS = (() => {
  const at = SRC.indexOf("export const AERIAL_DEFAULTS = {");
  const from = SRC.indexOf("{", at);
  let depth = 0, end = -1;
  for (let i = from; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  // eslint-disable-next-line no-eval
  return eval("(" + SRC.slice(from, end) + ")");
})();

/** Set the stand-in sun to an elevation in degrees. */
const setEl = (deg) => { uSunDir.value.y = Math.sin(deg * Math.PI / 180); };
const at = (deg) => { setEl(deg); return groundHazeScale(); };

console.log("=== THE SHIPPED DEFAULTS ===");
{
  check("the curve ships ON", DEFAULTS.duskGroundHaze < 1,
    `duskGroundHaze ${DEFAULTS.duskGroundHaze}`);
  check("it matches what was measured in the game",
    Math.abs(DEFAULTS.groundHaze * DEFAULTS.duskGroundHaze - 0.0002) < 0.00003,
    `${DEFAULTS.groundHaze} x ${DEFAULTS.duskGroundHaze} = `
    + `${(DEFAULTS.groundHaze * DEFAULTS.duskGroundHaze).toFixed(5)}, measured sweet spot 0.00020`);
  check("the window clears the stunt track's hour", DEFAULTS.duskFadeDeg < 61.7,
    `fade starts at ${DEFAULTS.duskFadeDeg} deg, track sits at 61.7`);
  check("and it is fully applied before the sun is truly low",
    DEFAULTS.duskFullDeg <= 22, `full by ${DEFAULTS.duskFullDeg} deg`);
}

console.log("\n=== NOON CANNOT REGRESS ===");
Object.assign(P, DEFAULTS);
{
  // The stunt track is tuned at 10:30, which is +61.7 deg — measured in the game.
  check("the track's own hour is untouched, exactly", at(61.72) === 1, `scale ${at(61.72)}`);
  check("and so is every elevation above the window",
    at(90) === 1 && at(55) === 1 && at(50.001) === 1);
  check("identity is EXACT, not nearly", Object.is(at(70), 1));
}

console.log("\n=== IT BITES AT THE HOUR IT WAS BUILT FOR ===");
// 17:15 in the game is +24.6 deg — NOT 2 deg. The first version of this curve
// ramped from 25 deg to the horizon and measured 0.999 right here, i.e. it did
// nothing at all at the only hour it existed to fix.
{
  check("17:15 gets most of the effect",
    at(24.6) < 0.5, `+24.6 deg -> ${at(24.6).toFixed(3)}, measured sweet spot 0.36`);
  check("and it is close to what was tuned by eye",
    Math.abs(at(24.6) - DEFAULTS.duskGroundHaze) < 0.08, `${at(24.6).toFixed(3)} vs 0.36`);
}

console.log("\n=== IT THINS, SMOOTHLY, ALL THE WAY DOWN ===");
{
  check("the bottom of the window lands on the dusk fraction",
    Math.abs(at(DEFAULTS.duskFullDeg) - DEFAULTS.duskGroundHaze) < 1e-9,
    `${at(DEFAULTS.duskFullDeg).toFixed(3)}`);
  check("the horizon does too", Math.abs(at(0) - DEFAULTS.duskGroundHaze) < 1e-9);
  let prev = at(55), monotone = true, maxStep = 0;
  for (let d = 55; d >= -5; d -= 0.25) {
    const v = at(d);
    if (v > prev + 1e-12) monotone = false;
    maxStep = Math.max(maxStep, Math.abs(v - prev));
    prev = v;
  }
  check("it only ever thins as the sun drops", monotone);
  check("no knee — a quarter degree never moves it far",
    maxStep < 0.02, `worst step ${maxStep.toFixed(4)} per 0.25 deg`);
}

console.log("\n=== BELOW THE HORIZON IT HOLDS ===");
// Night has its own fill and there is no sunset colour left to over-apply;
// continuing the ramp down would keep thinning the air for no reason.
{
  check("it does not keep falling after sunset",
    Math.abs(at(-10) - at(0)) < 1e-9 && Math.abs(at(-40) - at(0)) < 1e-9,
    `-10 deg ${at(-10).toFixed(3)}, horizon ${at(0).toFixed(3)}`);
}

console.log("\n=== 1.00 IS OFF, AND OFF IS THE OLD BEHAVIOUR ===");
{
  Object.assign(P, DEFAULTS, { duskGroundHaze: 1 });
  check("every elevation returns exactly 1",
    [90, 45, 25, 12, 0, -20].every((d) => at(d) === 1));
  Object.assign(P, DEFAULTS, { duskGroundHaze: undefined });
  check("and a missing value is off too, not NaN",
    [90, 12, 0].every((d) => at(d) === 1));
  Object.assign(P, DEFAULTS, { duskFadeDeg: 20, duskFullDeg: 20 });
  check("a zero-width window is a switch, not a divide by zero",
    Number.isFinite(at(25)) && Number.isFinite(at(15))
    && at(25) === 1 && Math.abs(at(15) - DEFAULTS.duskGroundHaze) < 1e-9,
    `above ${at(25)}, below ${at(15).toFixed(3)}`);
  Object.assign(P, DEFAULTS, { duskFullDeg: 80 });
  check("a window given backwards still behaves",
    [90, 45, 12, 0].every((d) => Number.isFinite(at(d))) && at(90) === 1,
    `at 45 deg: ${at(45).toFixed(3)}`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
