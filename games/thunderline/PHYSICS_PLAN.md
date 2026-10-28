# Thunderline — a new stunt car (physics, air, controls)

2026-10-28, after driving the tilted landings: "very hard to land on the rotated pieces … in Apex Rush it's part of
the game … the Apex Rush car is more stable … any time we want a good landing we have to be well centred before the
jump … your autopilot is missing a lot of things compared to a real human … maybe we have to rethink the physics and
air and controls."

## What we know (measured, not guessed)

- **The landing spot is fixed at the lip.** The car has no sideways control in the air, so 1° of heading error at
  take-off = ~3 m off at the landing; 2° falls off a 16 m road one time in three, 3° two times in three; 8 % too slow
  falls too (proj_thunderline_human_jump_tolerance, 10-23).
- **Air steering was tried and rejected** (10-23, 4 m/s² sideways): "completely unnatural and wrong". The fix must
  not be an invisible hand moving the car in flight.
- **The car is the old game's** `v3/play/modularRoadVehicle.js`: 7,888 lines of a realistic-leaning car plus years
  of rescues (road hold, stabiliser, landing assist, wall rules). Thunderline adds ~330 lines (carRules, landing,
  carTune). It forgives a crooked landing on flat road, but a touch on an edge or a steep surface is a crash.
- **The autopilot is superhuman**: analog, perfect line, perfect air attitude. It proves a track is possible, not
  that it is playable.
- **Tilted landings work to 75°** (gravity presses the car on by cos(tilt)); vertical ones can't be landed on.

## What Thunderline uses of the car (the interface a new one must give)

body.pos / vel / quat, groundedCount, tires (grounded, compression, contact normal: the landing judge, tyre marks,
sparks), tick(input) at a fixed step, setSpawn / respawn / respawnAt, setBvh (deck + solids), setDynamicMovers,
setSolidCapsules, renderPos / renderQuat (interpolated), scraping / scrapeSpeed, stuckTime, speedKmh, enabled; the
visuals: setChassisModel / setWheelModel / styles, headlamps, group, syncVisuals. Used by driveSession, carRules,
landing, simState (the builder's resumable lap), autopilot, carFx, sparks, tyreMarks, builder3.

## The idea: an ARCADE STUNT car, honest in the air, generous at the edges of the air

| | Old car | New car |
|---|---|---|
| Road | realistic grip, keyboard = full lock, twitchy at 200 km/h | speed-sensitive steering, smooth keyboard ramp, yaw stability: holds its line hands-off |
| Take-off | the car leaves wherever its velocity points | **the ramp guides the car**: on a lip, the velocity's heading is drawn onto the ramp's own direction (a groove you feel on the ramp, not in the air) — a slightly crooked approach still flies straight |
| Air | torque-based; spins carry on; the car tumbles | **rate-based**: roll / pitch / yaw at set speeds while held, stop when released, hold attitude hands-off — no tumbling |
| Landing | a rigid-body touchdown: bounces, edges catch, steep = crash | **the landing catches the car**: touching a surface roughly lined up (≤ ~35°), the speed into the surface is cancelled (no bounce), the speed along it is kept, the car settles flat on it in ~0.15 s; PERFECT / OK / ROUGH still graded (boost) |
| Loops, walls, tubes | road hold + magnets (works) | a magnet onto any stunt surface while driving on it (same rule as now, one place) |
| Testing | superhuman autopilot | + a **human driver** bot: keyboard (on/off) inputs, ~150 ms reaction, ±2° heading noise, imperfect air roll — the builder reports how forgiving a jump is for a person |

Nothing moves the car sideways in flight. The help is on the ramp (before) and on the landing (after).

## Step 1 started (2026-10-28/29): the STUNT car

`proto/kit/stuntCar.js` — `StuntCar extends Vehicle` (the old car untouched; its collisions, loops, tubes, walls,
model and lights inherited). Two changes so far: the TAKE-OFF GUIDE (≤ 8°, onto the ride's direction, as the wheels
leave a ramp climbing ≥ 3 m/s) and the LANDING CATCH (≤ 35° from the surface: no bounce, speed kept, settled flat
in 0.15 s). Air controls: the old car's are already rate-based — kept. Steering: the old car already narrows with
speed — kept until measured. Switch: the builder's **Car: old | new** button (settings.physics; reloads the page);
the drive, the ghost and the builder's test lap all use the chosen car.

Measured on "Tilted landing test" (kicker → 75° tilted landing → finish), the car's heading knocked off by N° on the
kicker, the autopilot flying the rest:

| crooked | old car | stunt car (guide turned back) |
|---|---|---|
| 0° | finishes | finishes |
| ±2° | falls | finishes (1.5°) |
| ±4° | falls | finishes (3.3°) |
| ±6° | falls | finishes (5°) |

Next: the user drives both and judges; then the catch on tilted / wall landings for a human, the human-driver bot.

## How we build it (side by side, never a blind swap)

1. **The car on its own** — `games/thunderline/proto/kit/stuntCar.js`: same interface, the same model and wheels,
   raycast wheels on the same road BVH. Flat road, kickers, landings (fitted, tilted), rails. A switch on the drive
   page and the builder (old | new). **You drive both on the Tyre test, the Tilted landing test and a campaign
   track and decide.**
2. **Stunts**: loops, walls, tubes, bowls, twists, flip ramps, props and scraping.
3. **Everything else on it**: the builder's prediction and autopilot, the ghost (bit-exact replay), the tests, plus the
   human-driver bot and its tolerance numbers in the builder.
4. **Make it the default** only if you prefer it; the old car stays selectable.

Risks: loops / tubes / walls took the old car many fixes; the ghost needs exact determinism; it is a few days of work
before step 1 can be judged, and "never worse than the old game" applies to how it drives.
