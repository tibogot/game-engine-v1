// PAUSE — one world clock, and nothing that advances the world may ignore it.
//
// `timeScale = 0` stopped the car's fixed ticks and nothing else. Traffic,
// clouds, weather, lightning, birds, the ocean, rain, smoke and flags all tick
// on the engine's frame dt through their own hooks, and would have kept going
// around a frozen car. The pause is `worldDt(dt)`: 0 while paused, handed to
// every one of them.
//
// MEASURED in the game when it landed (city on, drive mode, car at 18 m/s):
// the car's position and speed identical over 180 paused frames; the city's
// saloon traffic mesh identical over 120 paused frames, moving before and after;
// blur auto-paused with its reason shown; Esc resumed, P paused; the menu's
// Restart put the car back at the spawn unpaused; Back to builder switched mode;
// pause refused in build mode.
//
// This suite cannot run the game, so it pins the two things that would silently
// undo that:
//   1. a world-advancing call quietly going back to raw `dt` (the easy
//      regression — the next system added copies a neighbour that predates the
//      pause), checked against the source;
//   2. the gamepad's Start edge, checked for real against a stubbed
//      navigator.getGamepads.
//
// Run: node tools/pauseTest.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

console.log("\n═══ PAUSE ═══\n");

console.log("=== THE WORLD CLOCK EXISTS, AND IS DECLARED BEFORE ITS FIRST READER ===");
{
  const decl = SRC.indexOf("const worldDt = (dt) => (paused ? 0 : dt);");
  const firstHook = SRC.indexOf("app.addPreRenderHook?.(updateClouds);");
  check("worldDt is 0 while paused", decl >= 0);
  // The hooks are registered long before the game loop's own declarations; a
  // `let` read in its dead zone throws on the first engine frame.
  check("...declared above the first pre-render hook that reads it", decl >= 0 && firstHook > decl);
}

console.log("\n=== EVERY SYSTEM THAT ADVANCES THE WORLD ASKS IT ===");
{
  const mustUseWorldDt = [
    ["clouds", /clouds\.update\(worldDt\(dt\)/],
    ["weather", /weather\.update\(worldDt\(dt\)\)/],
    ["the game sky's clock", /gameSky\.update\(\{\s*camera,\s*dt:\s*worldDt\(dt\)\s*\}\)/],
    ["lightning", /lightning\.update\(worldDt\(dt\)\)/],
    ["the city (traffic, steam, windows)", /city\.update\(worldDt\(dt\),\s*camera\)/],
    ["knocked street furniture", /updateKnockables\?\.\(worldDt\(dt\)/],
    ["the checkpoint rush clock", /checkpoints\.run\.update\(worldDt\(dt\)/],
    ["birds", /_birdT \+= worldDt\(dt\)/],
    ["the ocean", /ocean\.update\(worldDt\(dt\),\s*_oceanClock/],
    ["the car's visual wheels and lean", /vehicle\.syncVisuals\(worldDt\(dt\)/],
    ["flags", /flags\.update\(worldDt\(dt\)\)/],
    ["the fall check", /checkFall\(worldDt\(dt\)\)/],
    ["the race HUD", /updateRaceHud\(worldDt\(dt\)\)/],
    ["portal visuals", /portals\.updateVisuals\(worldDt\(dt\)\)/],
    ["the chase camera", /chase\.update\(worldDt\(dt\)\)/],
    ["drift smoke", /driftSmoke\.updateFromVehicle\(vehicle,\s*camera,\s*worldDt\(dt\)/],
    ["sparks", /sparks\.updateFromVehicle\(vehicle,\s*camera,\s*worldDt\(dt\)/],
  ];
  for (const [name, re] of mustUseWorldDt) check(`${name} runs on world time`, re.test(SRC));

  // And none of them has a raw-dt twin left behind.
  const rawLeft = [
    /clouds\.update\(dt,/, /weather\.update\(dt\)/, /lightning\.update\(dt\)/, /city\.update\(dt,\s*camera\)/,
    /_birdT \+= dt;/, /driftSmoke\.updateFromVehicle\(vehicle,\s*camera,\s*dt,/,
  ].filter((re) => re.test(SRC));
  check("no world system still reads raw dt", rawLeft.length === 0, rawLeft.map(String).join(" "));

  check("the ocean no longer runs on the wall clock",
    !/ocean\.update\([^)]*performance\.now\(\)/.test(SRC));
  check("the car's fixed ticks accumulate nothing while paused",
    /simAccum \+= dt \* \(paused \? 0 : timeScale\)/.test(SRC));
  check("rain stops updating (and stays visible) while paused", /if \(rainRunning && !paused\)/.test(SRC));
}

console.log("\n=== WHAT PAUSES, AND WHEN ===");
{
  check("drive mode only — setPaused refuses anywhere else", /on = !!on && mode === "drive";/.test(SRC));
  check("leaving drive mode always resumes", /async function toggleMode\(\) \{\s*if \(paused\) setPaused\(false\);/.test(SRC));
  check("losing focus pauses a run", /addEventListener\("blur", \(\) => \{ releaseAllKeys\(\); pauseOnFocusLoss\(\); \}\)/.test(SRC)
    && /if \(document\.hidden\) \{ releaseAllKeys\(\); pauseOnFocusLoss\(\); \}/.test(SRC));
  check("...but never the city warm-up, which drives on purpose", /!warming\) setPaused\(true, "focus"\)/.test(SRC));
  check("held keys are released on pause, or the car drives off on resume",
    /if \(paused\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*releaseAllKeys\(\);/.test(SRC));
  check("Esc or P toggles it, matched on e.key for P (AZERTY)",
    /if \(code === "escape" \|\| k === "p"\)/.test(SRC));
  check("while paused the menu owns the keyboard", /if \(paused\) \{\s*if \(pauseMenu\?\.handleKey\(code\)\)/.test(SRC));
  check("the audio context is held suspended under the menu",
    /if \(paused && audioSystem\.Howler\?\.ctx\?\.state === "running"\) audioSystem\.Howler\.ctx\.suspend\(\);/.test(SRC));
  check("both handles expose it", (SRC.match(/isPaused: \(\) => paused,/g) || []).length === 2);
}

console.log("\n=== THE PAD'S START BUTTON, FOR REAL ===");
{
  let buttons = new Array(17).fill(0);
  // Node 21+ ships a read-only `navigator` getter, so it is redefined, not assigned.
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    getGamepads: () => [{
      connected: true, mapping: "standard", id: "stub pad",
      axes: [0, 0, 0, 0],
      buttons: buttons.map((v) => ({ pressed: v > 0.5, value: v })),
    }],
  } });
  const { createGamepadInput } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/gamepadInput.js")).href);
  const pad = createGamepadInput();
  const press = (i, on) => { buttons[i] = on ? 1 : 0; };
  check("no pause with nothing pressed", pad.read().pausePressed === false);
  press(9, true);
  check("Start going down reports a pause", pad.read().pausePressed === true);
  check("...once — holding it does not toggle every frame", pad.read().pausePressed === false);
  press(9, false);
  pad.read();
  press(9, true);
  check("a second press reports again", pad.read().pausePressed === true);
  press(9, false);
  press(3, true);
  const r = pad.read();
  check("Y is still respawn, not pause", r.respawnPressed === true && r.pausePressed === false);
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
