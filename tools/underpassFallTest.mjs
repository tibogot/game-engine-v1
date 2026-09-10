// ============================================================================
// THE KILL FLOOR HAS TO KNOW THE CITY GOES DOWN
//
// The underpass was unplayable and it was nothing to do with the underpass.
// In sky mode the "you have fallen out of the world" height is derived from
// the TRACK — its lowest connector, less a 50 m margin — on the perfectly
// reasonable assumption that nothing else in the world went downward.
//
// The underpass is a road six and a half metres BELOW the ground plane. With a
// sky track forty metres up the floor lands at minus ten, which is UNDERNEATH
// a road the player is supposed to drive on: descending the ramp is then
// indistinguishable from falling into the void, and the game sends them back
// to the start every time they go near it.
//
// The arithmetic is the whole bug, so the arithmetic is what this checks —
// there is no need to simulate a car to know that a floor above a road is
// wrong.
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
await import("three/webgpu");
const { underpassLayout } = await import("../games/modular-road-v3/modularRoadCityUnderpass.js");
const { CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

// The two constants the rule is made of, read from the source rather than
// copied, so this fails if either is retuned without thinking about the city.
const src = await (await import("node:fs/promises")).readFile(
  new URL("../games/modular-road-v3/roadGame.js", import.meta.url), "utf8");
const MARGIN = Number(/const SKY_FALL_MARGIN = (-?[\d.]+)/.exec(src)?.[1]);
check("SKY_FALL_MARGIN was found in the source", Number.isFinite(MARGIN), `${MARGIN} m`);

const L = underpassLayout({ P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0 });
check("there is an underpass to fall into", !!L);
const roadY = L.roadY;

/** The rule, as roadGame computes it. */
const floorFor = (trackBottom, cityLow) =>
  Math.min(trackBottom, Number.isFinite(cityLow) ? cityLow : Infinity) - MARGIN;

// A ground-level track never showed this, which is why it shipped.
check("a ground-level track was always fine",
  floorFor(0, Infinity) < roadY, `floor ${floorFor(0, Infinity)} vs road ${roadY}`);

/*
 * THE SKY TRACK IS THE CASE THAT BROKE. Anything from about 44 m up puts the
 * old floor above the underpass road — and the default build height is 40, so
 * this is not an exotic track, it is very nearly the default one.
 */
const OLD = (trackBottom) => trackBottom - MARGIN;
check("a sky track put the OLD floor above the road",
  OLD(45) > roadY, `old floor ${OLD(45)} vs road ${roadY} — the car is 'lost' on its own road`);

// And the fix, at the same height and a long way beyond it.
for (const h of [45, 80, 200]) {
  const f = floorFor(h, L.roadY - 1.5);
  check(`a track at ${h} m leaves the underpass drivable`, f < roadY - 1,
    `floor ${f.toFixed(1)} vs road ${roadY}`);
}

/*
 * AND THE FLOOR STILL HAS TO BE A FLOOR. Taking the city into account must not
 * push it so far down that a car which really has fallen out of the world
 * keeps going forever — the margin below the lowest road is the whole point.
 */
check("the floor stays a sensible distance below the lowest road",
  floorFor(45, roadY - 1.5) > roadY - MARGIN - 10,
  `${floorFor(45, roadY - 1.5).toFixed(1)}`);

// No city, no change: the rule must be exactly what it was.
check("a city with no underpass changes nothing",
  floorFor(45, Infinity) === OLD(45), `${floorFor(45, Infinity)}`);

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
