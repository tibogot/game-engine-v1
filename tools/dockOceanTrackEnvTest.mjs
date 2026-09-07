/**
 * tools/dockOceanTrackEnvTest.mjs
 *
 * The drift dock and the ocean save their settings in the track file's sparse
 * `environment` block. This guards the round trip, and specifically the trap
 * that broke it the first time.
 *
 * ── THE TRAP ────────────────────────────────────────────────────────────────
 * The apron's shape first rode as `dockPads`, the params array itself. It saved
 * as NOTHING, every time, for two compounding reasons:
 *
 *   1. `sparse()` opens with `a === b`, and `TRACK_ENV_DEFAULTS` is built once at
 *      boot from `readTrackEnv({})` — which assigned `dockParams.pads` BY
 *      REFERENCE. The "default" and the live value were therefore the same array
 *      object, so the diff was empty however much the dock had changed.
 *   2. Editing a pad from the panel mutates it in place, and `Object.freeze` is
 *      shallow — so the frozen snapshot's nested array changed too. Even a deep
 *      compare would have called them equal.
 *
 * The format's own comment states the rule this violated: keys are FLAT because
 * `sparse()` diffs shallowly. The fix was to spell the pad out as scalars.
 *
 * This test reproduces the boot-snapshot pattern faithfully — including taking
 * the snapshot BEFORE the edit and mutating the live pad in place afterwards —
 * because a test that built its defaults some tidier way would have passed
 * against the broken code.
 */

import { sparse, resolve } from "../games/modular-road-v3/modularRoadTrackIO.js";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ""}`);
  }
};

// ── The live params, shaped exactly as roadGame holds them ──────────────────
const dockParams = {
  worldSize: 1100, topY: 0, freeboard: 9, depth: 40, edgeWidth: 2.5,
  tileMetres: 7, deckBrightness: 1.9,
  pads: [{ x: 0, z: 0, sizeX: 380, sizeZ: 300, radius: 46, rotDeg: 0, rise: 0 }],
};
const oceanParams = {
  surfHz: 0.14, surfLength: 62, surfReach: 46, windSpeed: 14, windAngleDeg: 38,
  fftSwellAmp: 1.15, ssrEnabled: false, foamCutoff: 0.6, edgeIntensity: 0.9,
  seaLevel: -5,
};
let dockWanted = false;
let oceanWanted = false;
let terrainOn = true;

const DOCK_ENV_MAP = {
  dockWorldSize: "worldSize", dockTopY: "topY", dockFreeboard: "freeboard",
  dockDepth: "depth", dockEdgeWidth: "edgeWidth", dockTileMetres: "tileMetres",
  dockBrightness: "deckBrightness",
};
const OCEAN_ENV_MAP = {
  oceanSurfHz: "surfHz", oceanSurfLength: "surfLength", oceanSurfReach: "surfReach",
  oceanWindSpeed: "windSpeed", oceanWindAngle: "windAngleDeg",
  oceanSwellAmp: "fftSwellAmp", oceanSsr: "ssrEnabled",
  oceanFoamCutoff: "foamCutoff", oceanEdgeFoam: "edgeIntensity",
  oceanSeaLevel: "seaLevel",
};
const PAD_ENV_MAP = {
  dockPadSizeX: "sizeX", dockPadSizeZ: "sizeZ", dockPadRadius: "radius",
  dockPadX: "x", dockPadZ: "z", dockPadRot: "rotDeg",
};

function readTrackEnv(into = {}) {
  into.skyMode = !terrainOn;
  into.dockOn = dockWanted;
  into.oceanOn = oceanWanted;
  for (const [k, p] of Object.entries(DOCK_ENV_MAP)) into[k] = dockParams[p];
  for (const [k, p] of Object.entries(OCEAN_ENV_MAP)) into[k] = oceanParams[p];
  const pad0 = dockParams.pads?.[0];
  for (const [k, p] of Object.entries(PAD_ENV_MAP)) into[k] = pad0?.[p] ?? 0;
  return into;
}

function applyTrackEnv(env) {
  terrainOn = !env.skyMode;
  for (const [k, p] of Object.entries(DOCK_ENV_MAP)) {
    if (env[k] !== undefined) dockParams[p] = env[k];
  }
  if (dockParams.pads?.[0]) {
    const pad0 = { ...dockParams.pads[0] };
    for (const [k, p] of Object.entries(PAD_ENV_MAP)) {
      if (env[k] !== undefined) pad0[p] = env[k];
    }
    dockParams.pads = [pad0, ...dockParams.pads.slice(1)];
  }
  for (const [k, p] of Object.entries(OCEAN_ENV_MAP)) {
    if (env[k] !== undefined) oceanParams[p] = env[k];
  }
  dockWanted = !!env.dockOn;
  oceanWanted = !!env.oceanOn;
}

console.log("dock + ocean track environment round trip\n");

// Boot snapshot, exactly as roadGame takes it — by reference, before any edit.
const TRACK_ENV_DEFAULTS = Object.freeze(readTrackEnv({}));

// ── The edit: switch a drift level on and reshape the apron ─────────────────
terrainOn = false;
dockWanted = true;
oceanWanted = true;
dockParams.freeboard = 13.5;
dockParams.deckBrightness = 2.4;
oceanParams.surfReach = 14;
oceanParams.seaLevel = -8;
// IN PLACE, the way the panel's live proxy writes it. This is what used to
// poison the frozen snapshot.
dockParams.pads[0].sizeX = 300;
dockParams.pads[0].radius = 62;
dockParams.pads[0].rotDeg = 15;

const live = readTrackEnv({});
const saved = sparse(live, TRACK_ENV_DEFAULTS);

check("the snapshot did not follow the live edit",
  TRACK_ENV_DEFAULTS.dockPadSizeX === 380,
  `snapshot says ${TRACK_ENV_DEFAULTS.dockPadSizeX}, should still be 380`);

for (const [key, want] of [
  ["dockPadSizeX", 300], ["dockPadRadius", 62], ["dockPadRot", 15],
  ["dockFreeboard", 13.5], ["dockBrightness", 2.4],
  ["oceanSurfReach", 14], ["oceanSeaLevel", -8],
  ["dockOn", true], ["oceanOn", true], ["skyMode", true],
]) {
  check(`saved carries ${key}`, saved[key] === want,
    `got ${JSON.stringify(saved[key])}, want ${JSON.stringify(want)}`);
}

check("untouched keys stay out of the file",
  saved.dockPadSizeZ === undefined && saved.oceanWindSpeed === undefined,
  "sparse should omit anything equal to the baseline");

// ── The load, onto a fresh boot ─────────────────────────────────────────────
dockParams.freeboard = 9;
dockParams.deckBrightness = 1.9;
dockParams.pads = [{ x: 0, z: 0, sizeX: 380, sizeZ: 300, radius: 46, rotDeg: 0, rise: 0 }];
oceanParams.surfReach = 46;
oceanParams.seaLevel = -5;
dockWanted = false;
oceanWanted = false;
terrainOn = true;

const restoredEnv = resolve(TRACK_ENV_DEFAULTS, JSON.parse(JSON.stringify(saved)));
applyTrackEnv(restoredEnv);

check("apron length restored", dockParams.pads[0].sizeX === 300, `got ${dockParams.pads[0].sizeX}`);
check("corner radius restored", dockParams.pads[0].radius === 62, `got ${dockParams.pads[0].radius}`);
check("rotation restored", dockParams.pads[0].rotDeg === 15, `got ${dockParams.pads[0].rotDeg}`);
check("freeboard restored", dockParams.freeboard === 13.5, `got ${dockParams.freeboard}`);
check("deck brightness restored", dockParams.deckBrightness === 2.4, `got ${dockParams.deckBrightness}`);
check("surf zone restored", oceanParams.surfReach === 14, `got ${oceanParams.surfReach}`);
check("sea level restored", oceanParams.seaLevel === -8, `got ${oceanParams.seaLevel}`);
check("dock switched on", dockWanted === true);
check("ocean switched on", oceanWanted === true);
check("terrain still off", terrainOn === false);
check("`rise` survived the rebuild", dockParams.pads[0].rise === 0,
  "keys outside PAD_ENV_MAP must be carried, not dropped");

// ── A track that touched none of it must inherit, not pin ───────────────────
const untouched = sparse(readTrackEnv({}), TRACK_ENV_DEFAULTS);
const onlyEdited = Object.keys(untouched).every((k) => k in TRACK_ENV_DEFAULTS);
check("an unedited block writes only real overrides", onlyEdited);

console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
