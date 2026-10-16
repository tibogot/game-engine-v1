// Put the alg-rts levels' SAVED look on the sky the game draws (2026-10-17).
//
// The game ignores a level's saved look (startV3App projectWorldLook is off) and sets Sky Pro
// itself in algGame.js applyAuresLight: the clock (latitude, day, hour, the coast's sunTurn), the
// exposure, the sun's strength, the night look, and a map's own Sky Pro settings. The editor DOES
// load the saved look, so these files opened under the old "atmosphere" sky at 10:30. This writes
// the game's values into each level's look, so the editor shows the map as the game does. It
// changes nothing in the game. The values mirror AURES_LIGHT + each map's `light` (maps/*.js);
// rerun after changing those.
//
//   node tools/algLevelsSkyPro.mjs          dry run: prints what would change
//   node tools/algLevelsSkyPro.mjs --write  writes the files
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { SKYPRO_DEFAULTS } from "../v3/render/skypro/skyproSky.js";

const WRITE = process.argv.includes("--write");

// algGame.js AURES_LIGHT (the base every map starts from).
const AURES = { latitude: 35.2, dayOfYear: 196, timeOfDay: 16.0, skyProExposure: 0.42, skyProSunScale: 0.55 };
// Each map's `light` over it (maps/*.js); alg-base is the empty base the coast and training
// scripts build from, so it carries the Aurès light and they inherit it.
const LEVELS = {
  "alg-aures": {},
  "alg-base": {},
  "alg-training": {},
  "alg-coast": { sunTurn: 45 },
  "alg-kantara": { timeOfDay: 16.6, skyProExposure: 1.12, skyProSunScale: 0.38, skyPro: { coverage: 0.2, groundAlbedo: "#d2a678" } },
};

for (const [name, own] of Object.entries(LEVELS)) {
  const L = { ...AURES, ...own };
  const file = `public/levels/${name}.v3proj`;
  const proj = await readProject(file);
  const look = (proj.manifest.environment ??= {}).look ??= {};
  const before = { skyMode: look.skyMode, clock: { ...(look.proceduralSky ?? {}) }, skyPro: { ...(look.skyProSky ?? {}) } };

  look.skyMode = "skypro";
  look.proceduralSky = {
    ...(look.proceduralSky ?? {}),
    latitude: L.latitude, dayOfYear: L.dayOfYear, timeOfDay: L.timeOfDay, sunTurn: L.sunTurn ?? 0,
  };
  // As applyAuresLight does it, in its order: night look, Tidewater's moon, the sun's strength,
  // the map's own settings, then the exposure with the night's stops given back on nightEV.
  const sp = { ...(look.skyProSky ?? {}) };
  sp.nightLook = true;
  sp.moonElev = 0;
  sp.sunScale = L.skyProSunScale;
  Object.assign(sp, L.skyPro ?? {});
  const baseExposure = sp.exposure ?? SKYPRO_DEFAULTS.exposure;
  const baseNightEV = sp.nightEV ?? SKYPRO_DEFAULTS.nightEV;
  sp.exposure = L.skyProExposure;
  sp.nightEV = +(baseNightEV + Math.log2(baseExposure / L.skyProExposure)).toFixed(4);
  look.skyProSky = sp;

  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));
  const CK = ["latitude", "dayOfYear", "timeOfDay", "sunTurn"];
  console.log(`${name}:`);
  console.log(`  skyMode  ${before.skyMode} -> ${look.skyMode}`);
  console.log(`  clock    ${JSON.stringify(pick(before.clock, CK))} -> ${JSON.stringify(pick(look.proceduralSky, CK))}`);
  console.log(`  skyPro   ${JSON.stringify(before.skyPro)} -> ${JSON.stringify(sp)}`);
  if (WRITE) await writeProject(file, proj);
}
console.log(WRITE ? "written" : "dry run — add --write to save");
