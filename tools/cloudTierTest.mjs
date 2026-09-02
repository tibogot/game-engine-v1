/**
 * The cloud TIER is a machine setting; whether a track wants clouds is track
 * data. Those must never be the same variable.
 *
 *   node tools/cloudTierTest.mjs
 *
 * They were. `clouds.enabled` answered both questions, so loading a track wrote
 * its `cloudsOn` straight onto the volumetric deck (turning the pass, the worker
 * bake and the shader compile back on for someone who had chosen `painted` or
 * `off`), and saving read the deck back (baking this machine's tier into the
 * track file). Both directions broke the rule the tier comment states outright.
 *
 * roadGame.js cannot be imported headlessly — it wants WebGPU, a canvas and a
 * .v3proj — so this checks the source the way tools/devPanelTest.mjs and
 * tools/roadUniformSyncTest.mjs do.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = "games/modular-road-v3/roadGame.js";
const src = fs.readFileSync(path.join(ROOT, FILE), "utf8");

let failed = 0;
const check = (ok, name, detail = "") => {
  if (ok) console.log("ok   " + name);
  else { failed++; console.log("FAIL " + name + (detail ? "  — " + detail : "")); }
};

/** A function body, from its `function name(` to the next top-level `  function `. */
function body(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const next = src.indexOf("\n  function ", start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

/** Strip comments so prose about the old behaviour cannot satisfy a check. */
const code = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const codeSrc = code(src);

console.log("— one gate —");
{
  const calls = [...codeSrc.matchAll(/clouds\.setEnabled\(/g)];
  check(
    calls.length === 1,
    "clouds.setEnabled is called in exactly one place",
    `${calls.length} call sites — every path must go through syncClouds()`
  );
  const sync = body("syncClouds");
  check(!!sync, "syncClouds() exists");
  check(
    !!sync && /clouds\.setEnabled\(\s*cloudsWanted\s*&&\s*cloudTier === "volumetric"\s*\)/.test(code(sync)),
    "the deck runs only when the track wants clouds AND the tier can afford them"
  );
}

console.log("\n— the wish is not the deck —");
{
  check(
    /into\.cloudsOn = cloudsWanted;/.test(codeSrc),
    "readTrackEnv saves the track's wish"
  );
  check(
    !/into\.cloudsOn = clouds\.enabled/.test(codeSrc),
    "readTrackEnv does NOT save this machine's deck state",
    "that is the tier leaking into track data"
  );
  check(
    !/getClouds: \(\) => clouds\.enabled/.test(codeSrc),
    "no accessor reports the deck as if it were the track's wish"
  );
  const applied = /cloudsWanted = !!trackEnv\.cloudsOn;\s*syncClouds\(\);/.test(codeSrc);
  check(applied, "applyTrackEnv sets the wish and re-syncs, rather than forcing the deck on");
}

console.log("\n— a tier switch releases what it replaces —");
{
  const t = body("setCloudTier");
  check(!!t, "setCloudTier() exists");
  const c = code(t ?? "");
  check(/scene\.remove\(gameSky\.mesh\)/.test(c),
    "the old dome is unparented (dispose() frees geometry/material but does not remove it)");
  check(/gameAtmo\?\.dispose\(\)/.test(c),
    "the atmosphere is disposed (3 render targets + 3 materials per switch)");
  check(/gamePainted\.dispose\(\)/.test(c) && /gamePainted = null/.test(c),
    "leaving the painted tier releases the painted deck",
    "a stale one is handed back to the next dome, compiling its fetches into a shader off-tier");
  check(/syncClouds\(\)/.test(c) && !/clouds\.setEnabled\(tier === "volumetric"\)/.test(c),
    "switching tier honours the track's wish instead of forcing clouds on");
}

console.log(failed ? `\n${failed} check(s) failed` : "\ncloud tier and track wish are separate");
process.exit(failed ? 1 : 0);
