# Thunderline: audit of the car and the track builder (2026-10-17)

This is a read-only audit of `games/modular-road-v3` (Apex Rush) before it is reorganised into a
clean new game, working name **Thunderline**. The main game is a Trackmania-style stunt campaign
on tracks built with the builder. City and dock drift come later as extra modes.

Tests run, all green:
- Car: roadHold, railTunnel (60 m/s), tubeDensity, chassisCollision, jumpPitch, offMapNaN.
- Builder: builderEdit, builderHistory, detach, pieceTilt, prepend, trackFormat, junction,
  junctionBranch, sprintRun, ghostBound, bankCurl, linkPiece, anchorTilt, loopCoil.

## Speed: why the car can feel slow

- **The car already reaches about 48 m/s (174 km/h).** `TIRE.topSpeed` is 50
  (`v3/play/modularRoadVehicle.js:491`). It acts as a governor: drive is 16 kN × (1 − (v/top)²), and
  drag is only about 1 kN at 48 m/s.

  | topSpeed | settles at |
  |---|---|
  | 50 (today) | 48 m/s (174 km/h) |
  | ≈63 | 60 m/s (215 km/h) |
  | ≈76 | 70 m/s (250 km/h) |

- **The PIECES slow the car down.**
  - Flat curves (radius 26 m) hold about 19.5 m/s.
  - Banked curves (22°) hold about 35 m/s.
  - Jumps and gaps are sized for 40 m/s; the flip ramp is tuned at 26–38 m/s.
  - So on a real track the car spends its time well under its top speed. Bigger and faster pieces
    matter as much as the engine.
- **The sense of speed is a separate job:** camera height and FOV, scenery close to the road, effects.
- **Limits if the car goes faster:**
  - **Collision:** about 0.25 m of travel per substep at 60 m/s. The code documents a ceiling of
    about 70 m/s; rails are verified to 60 m/s.
  - **Tubes (radius 8 m):** the car falls off the wall above about 64 m/s.
  - **Loops:** compression is already 0.40–0.43 m at 55 m/s, against a 0.55 m clamp.
  - **Road hold on slopes:** its 14 g ceiling is close to what a hill's brow needs at 60 m/s (about 13 g).
  - **Jumps:** distance grows with v² (+54% at 60 m/s).
  - **Going above about 65–70 m/s** needs real swept collision, not just more substeps.
- **Numbers that copy topSpeed by hand** and must follow it (better: one shared design speed):
  - `TIRE.steerSpeedRef` 45 (vehicle `:644`)
  - chase camera `fovSpeedRef` 50 (`chaseCamera.js:294`)
  - `FOLLOW_HOLD` / `FOLLOW_CAR` (`modularRoadKit.js:5978, 6014`)
  - gap preview `refSpeed` 40 (`roadGame.js:8048`)
  - `driftScore.refSpeed` 30 (already stale)
  - builder demo `refSpeed` 28 (`modularRoadBuilder.js:4346`)

## Car: confirmed problems

1. **Two physics files.** `v3/play/modularRoadVehicle.js` is the real car. `stuntVehicle.js` is an
   old v2 fork (topSpeed 30, frame-rate dependent) used only by the editor's "stunt" move mode.
   Retire it, or point that mode at the real car.
2. **Pad throttle is on/off.** `Tire.apply` never multiplies by the throttle amount (`:3557-3570`).
3. **Respawn doesn't reset everything.** `respawnAt` (`:4749`) leaves several values set:
   - `_sgMag`, up to 6 g of tube push that decays for about 0.2 s after the respawn;
   - `_holdHeading`;
   - `_roofGuard` and the terrain lid;
   - the steering rack, `_flipRate` and the assist mixes.

   Share one full reset with `teleportTo`.
4. **Steering angle computed twice:** once per tick for the tyres, then again every substep by the
   assists. Minor.
5. **Stale comments:**
   - the sweepMargin doc still says 30 m/s;
   - `:6881` gives the wrong number;
   - `:5980` duplicates `:5979`.
6. **Suspected:** the anti-crossing clamp (`:6867-6890`) removes only the body's straight-line
   velocity, not its spin, so a fast-flipping car's corner could cross a deck.
7. **Suspected:** at higher speed, more of the cornering comes from the 4 g turn assist, so the car
   may feel more on rails.

How the car is built:
- **Timestep:** fixed 1/120 s ticks, each with 2 substeps (1/240 s), interpolated for display.
- **Tyres and contact:** brush tyre model; force-based deck contact; impulses for walls and rails.
- **Air control:** rate-based.
- **Tuning:** one shared tune for every car, in module-wide objects. Make it a per-car tune object.

## Track builder: confirmed problems

1. **A code change can reshape saved tracks.** On load, only each chain's first position and the
   pieces' tilts are kept; every later position is rebuilt from the CURRENT shape defaults
   (`importTrackPieces` `modularRoadBuilder.js:4245`, `rebuildAll :3967`).
   - Today's tracks rebuild to within 0–6 cm.
   - With a default curve radius of 39 instead of 26, they move 18–26 m, and jump landings no longer
     line up.
   - **Fix:** freeze campaign tracks. Store every shape parameter, or check the rebuilt positions
     against the saved ones when loading. Make faster pieces new tiles; never change a default.
2. **Checkpoint order follows build order, not driving order** (`modularRoadRun.js:82-103`). A
   checkpoint added later on an earlier chain makes the course impossible to finish.
3. **Records are keyed by gate positions rounded to 1 m** (`modularRoadRun.js:169`). Edits between
   gates keep a stale best time and ghost. Use a track id plus a content hash.
4. **Sprint timer and ghost ARE wired into play** (`RunTracker`, `modularRoadRun.js`; best and
   ghost in localStorage). `modularRoadLap.js` is dead code, and AIRSTUNT_DESIGN.md §1 ("not wired")
   is out of date.
5. **No respawn at the last checkpoint;** only "last safe pose" or a full restart.

What the builder has:
- 76 piece types and about 174 palette tiles;
- snapping by position, an 8 m grid, junction branches;
- snapshot undo;
- save format v4 with a migration chain.

## Missing for a Trackmania-style campaign

- **Track check:** a "validate" pass (start → every checkpoint → finish is drivable) that records the AUTHOR time.
- **Medals:** bronze, silver, gold and author.
- **Track info:** id, author, medal times, content hash, thumbnail.
- **Track list:** a list or campaign manifest (presets are buttons hard-coded in `roadGame.js:7592-7639`).
- **Records:** saved per track id.
- **Checkpoint respawn** and an instant restart key.

## What a clean game can reuse

- **Importable as is:**
  - `modularRoadKit.js`
  - `modularRoadBuilder.js` (its palette UI is DOM code, `:6168`)
  - `modularRoadTrackIO.js`
  - `modularRoadRun.js`
  - `modularRoadGhost.js`
  - the vehicle
- **Tangled in `roadGame.js` (10.5k lines):**
  - the collision bake (`:4923-5030`);
  - the sim step loop (`:9944-9969`): movers, the car, props, portals, run, ghost, safe pose;
  - records, respawn rules, preset loading.

  → Make a small "race runtime" module that owns all of this.
- **The vehicle file also draws the car** (meshes, lights, bloom). Split it into the physics core
  and the car's look.
- **The dev panel is not needed:** its 48 sliders are never saved.

## Recommended order

1. Choose the design speed (e.g. 60 m/s) and make one number drive all the copies listed above.
2. Freeze track geometry and add track info (id, hash, medals, author time) to the save format.
3. Write the race runtime module: sim step, collision bake, run, records, respawn, checkpoint
   respawn, instant restart.
4. Fixes: analog throttle, full reset on respawn, checkpoints in driving order.
5. Raise the speed: topSpeed ≈ 63 → rerun the tube, loop, road-hold and jump tests; 3 substeps
   (measure the cost); new faster tiles for curves and jumps.
6. Split the vehicle file (physics core / view / per-car tune); retire `stuntVehicle.js`.
