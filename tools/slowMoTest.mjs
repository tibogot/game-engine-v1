// SLOW MOTION — hold T (or the pad's X) and the WORLD slows, eased in and out.
//
// Two halves, like the pause:
//   1. the easing core (modularRoadSlowMo.js), exercised for real: it reaches
//      the slow rate and comes back, never overshoots, eases on REAL time, holds
//      still on dt 0, and comes out slower than it goes in;
//   2. the wiring in roadGame.js, pinned against the source: the rate feeds the
//      same world clock the pause uses — so traffic, smoke, rain and clouds slow
//      with the car instead of racing past it — written once per frame before
//      anything reads it, with no dead-zone read from the early hooks.
//
// Run: node tools/slowMoTest.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
const PAD = readFileSync(join(ROOT, "games/modular-road-v3/gamepadInput.js"), "utf8");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const { createSlowMo, SLOWMO_DEFAULTS } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadSlowMo.js")).href);

console.log("\n═══ SLOW MOTION ═══\n");

console.log("=== THE EASE ===");
{
  const S = SLOWMO_DEFAULTS;
  const sm = createSlowMo();
  check("starts at realtime", sm.rate === 1 && sm.amount === 0);

  // Hold for one second of real 60 Hz frames.
  let prev = 1, monotone = true, overshoot = false, tIn = null;
  for (let f = 1; f <= 60; f++) {
    const r = sm.update(1 / 60, true);
    if (r > prev + 1e-12) monotone = false;
    if (r < S.scale - 1e-9) overshoot = true;
    if (tIn === null && Math.abs(r - S.scale) < 0.02) tIn = f / 60;
    prev = r;
  }
  check("holding reaches the slow rate", Math.abs(sm.rate - S.scale) < 1e-6, `rate ${sm.rate.toFixed(4)}`);
  check("...decelerating the whole way, never jumping back", monotone);
  check("...without undershooting the floor", !overshoot);
  check("...in a few tenths of a second, not a snap and not a crawl",
    tIn !== null && tIn > 0.1 && tIn < 0.6, `within 0.02 of ${S.scale} after ${tIn?.toFixed(3)} s`);

  // Release.
  let tOut = null;
  prev = sm.rate;
  let monoOut = true;
  // Two real seconds: the ease snaps to exactly 0 once within 1e-3 of it.
  for (let f = 1; f <= 120; f++) {
    const r = sm.update(1 / 60, false);
    if (r < prev - 1e-12) monoOut = false;
    if (tOut === null && Math.abs(r - 1) < 0.02) tOut = f / 60;
    prev = r;
  }
  check("releasing returns to realtime exactly", sm.rate === 1 && sm.amount === 0);
  check("...accelerating the whole way", monoOut);
  check("coming out is slower than going in, so a landing is not slammed",
    tOut !== null && tOut > tIn, `in ${tIn?.toFixed(3)} s, out ${tOut?.toFixed(3)} s`);

  // Frame-rate independence: the same real time at two frame rates ends in
  // the same place — the ease is exponential in real time, not per frame.
  const at = (hz, secs) => { const s = createSlowMo(); for (let i = 0; i < Math.round(hz * secs); i++) s.update(1 / hz, true); return s.rate; };
  // 30 and 120 Hz so 0.1 s is a whole number of frames at both — at 144 Hz it
  // is 14.4, and the test measured the rounding instead of the ease.
  const a30 = at(30, 0.1), a120 = at(120, 0.1);
  check("the same 0.1 s eases the same at 30 Hz and 120 Hz", Math.abs(a30 - a120) < 1e-9,
    `${a30.toFixed(6)} vs ${a120.toFixed(6)}`);

  const frozen = createSlowMo();
  frozen.update(1 / 60, true);
  const before = frozen.amount;
  frozen.update(0, false);
  check("dt 0 (the pause) holds the ease exactly where it is", frozen.amount === before);
}

console.log("\n=== THE WIRING ===");
{
  check("the world clock is a RATE, and the pause is still its zero",
    /const worldDt = \(dt\) => \(paused \? 0 : dt \* worldRate\);/.test(SRC));
  const rateDecl = SRC.indexOf("let worldRate = 1;");
  const firstHook = SRC.indexOf("app.addPreRenderHook?.(updateClouds);");
  check("the rate is declared above the first hook that reads it", rateDecl >= 0 && rateDecl < firstHook);
  check("...and the hooks never read timeScale directly (declared far below them)",
    !/const worldDt = [^\n]*timeScale/.test(SRC));

  const rateSet = SRC.indexOf("worldRate = slowMo.update(");
  const simAccum = SRC.indexOf("simAccum += worldDt(dt);");
  check("the rate is written once per frame from the ease and timeScale",
    /worldRate = slowMo\.update\(paused \? 0 : dt, slowHeld\) \* timeScale;/.test(SRC));
  check("...BEFORE the car's ticks read it this frame", rateSet >= 0 && simAccum > rateSet);
  check("the car's ticks run on the world clock, so the car slows with the world", simAccum >= 0);
  check("held by T or the pad's X, and never while paused",
    /const slowHeld = !paused && \(!!keys\.keyt \|\| padSlowMoHeld\);/.test(SRC));
  check("the pad reports X as held, not as an edge", /slowMo: down\(2\) === 1/.test(PAD));
  check("leaving drive mode drops straight back to full speed",
    /slowMo\.reset\(\);\s*worldRate = timeScale;/.test(SRC));
  check("the badge's opacity is the eased amount", /slowMoBadge\?\.set\(slowMo\.amount\);/.test(SRC));
  /*
   * DECLARED ABOVE EVERY PLACE THAT CAN CALL toggleMode. toggleMode resets the
   * ease, and it runs during BOOT — the first cut declared the ease beside the
   * game loop, below those calls, and the game failed to start with "Cannot
   * access 'slowMo' before initialization". A function declaration is hoisted;
   * the `const` it reads is not.
   */
  const ease = SRC.indexOf("const slowMo = createSlowMo();");
  const NL = String.fromCharCode(10);
  const lineAt = (i) => SRC.slice(SRC.lastIndexOf(NL, i) + 1, SRC.indexOf(NL, i)).trim();
  const calls = [...SRC.matchAll(/\btoggleMode\(\)/g)].map((m) => m.index)
    // Real calls only: not the declaration, and not a mention in a comment.
    .filter((i) => !/^(\*|\/\/)/.test(lineAt(i)) && !lineAt(i).includes("function toggleMode"));
  check("the ease is declared above every call to toggleMode", ease >= 0 && calls.length > 0 && calls.every((i) => i > ease),
    `declared at ${ease}, first call at ${Math.min(...calls)}`);
  check("both handles expose the live rate", (SRC.match(/getWorldRate: \(\) => \(paused \? 0 : worldRate\),/g) || []).length === 2);
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
