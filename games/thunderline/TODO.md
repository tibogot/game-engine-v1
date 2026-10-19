# Thunderline — what's left (the working list)

Kept here so nothing gets lost between sessions. Design reasons live in DESIGN.md and PIECES.md;
this is just the list. Newest decisions at the top of each section. Last updated 2026-10-19.

## Now
- [ ] **THE NEW CAR — PAUSED** (user, 2026-10-19: "make a pause on the car", the game first). Done, not
      committed: optimised LOD0 + LOD1 + ShadowProxy in public/models/thunderline/ (KTX2 + meshopt):
      measured 17 draws (was 69), 2 casters (was 57), 29.6k tris, 11 materials, 6.5 Mpx; the ghost uses
      LOD1. OPEN: the tyres read TAN in the drive page (dark in carview). Ruled out: the KTX2 copy (raw PNG
      the same), the metal/rough map, the inside-out tyre (fixed anyway: thunderCar.js turnOutward). A
      black tint does darken it, so it is the albedo × light. Next guess: compare the Lotus tire's
      texture level and the drive page's light; screenshot only after a few seconds (the first frames are
      stale). Also: calipers that steer; the user checks the look; commit.
- [ ] Credit in the game (CC BY): "Saba V12 '95 - Low poly model" by DanielZhabotinsky.
- [ ] Next pieces on small maps (Green tier): gap jump, half-pipe, rollers, HELIX up / down (banked
      20°, R 56, ±20 m over itself; the real car holds 136 km/h round it) and slope up — done; skylight
      tube next. (The PIECES.md §7d turn set was already built: sweeps, S-bend, snake, hairpin.)
- [x] Editor: insert after / replace a selected piece (buttons in the panel, I / P; the road after it
      follows, landings and rings hung off a lip are carried with it; lean clashes refused with the
      reason) and a height cue under the piece in hand (a line to the floor + "↑ 120 m").
- [ ] Editor: after an edit makes a lip faster or slower, offer to re-fit its fitted landing (today the
      check warns "a fast car flies past it").
- [ ] Circuits: needs LAPS in the race first (timing, ghost, medals), then an auto-close connector that
      says why it can't connect (Planet Coaster's lesson, DESIGN.md). Every track is A → B today.
- [ ] **Tube entrance / exit shape** — the user finds the curl "cheap" ("I don't like the way it does
      the entrance shape at all"). WAITING for the user's Apex Rush tube screenshots; redesign from them.
- [x] Tube wall thicker: 0.6 → 1.5 m (user: "looks too thin").
- [x] Tubes are ROUND inside, no flat road (user, 2026-10-19).
- [x] **Loops inside the pipe** (user: "that's the funny thing of tubes") work with today's grip —
      measured (trackRun --spiral): a held gentle steer rides the car up the wall, over the roof and
      round, 2½ loops in one long pipe, ~30–40 km/h lost per loop; too slow and it drops off the roof.
      So NO grip change in the car (the shared engine file stays untouched).
- [ ] Rest of the tube family: corkscrew, loop tube, skylight (pop out the top), trapdoor (drop
      through the floor), half-pipe channel, helix (PIECES.md §7c).

## Game
- [x] **First campaign tier (White, 5 tracks)** — campaign/white.json, built in the REAL builder (each
      track's recipe placed piece by piece, landings on the real car's arcs) and validated by its test
      lap: First Light 32.5 s (jumps), Drop Zone 32.1 (drops, banked turn), Halfpipe 42.7 (the bowl),
      Pipeline 30.2 (tubes), Ring Line 36.1 (air rings, loop). Menu → Stunt tracks → Campaign plays
      them (drive.html?campaign=white-1), bests kept apart from the library, finish screen "Next" (N).
      THE USER PLAYS AND JUDGES THEM. Seen while building: a fitted landing after a boost was 188 m of
      20° slope (the band is wide at speed) — every jump loses 40 m of height; the track's end is a
      cliff (the car drives off after the finish).
- [ ] Campaign tiers Green → Black.
- [ ] One always-loaded page (no reload between menu / builder / drive).
- [ ] Garage + more cars (a generic car body before any release: the Lotus is dev-only, trademark).
- [ ] City mode, Drift mode (DESIGN.md: the four modes) — later.

## Feel: sound, impacts, smoke (user, 2026-10-19: "sounds, impacts, smoke…")
- [x] **Engine sound, synthesised** (user, 2026-10-19: "start with the synthesised engine"):
      engineModel.js (6-speed gearbox from the car's real speed: shifts with a throttle cut, launch
      wheelspin, free revving in the air and on the line, limiter, lift-off pops) + engineWorklet.js
      (each firing kicks exhaust resonators; V8 / inline-6 / V10) + engineSound.js; proto/engine-lab.html
      to listen; Settings: sound, volume, engine; M mutes. THE USER JUDGES THE SOUND.
- [ ] **Recorded engine pack** — the user is looking (want: on-load AND off-load loops every ~500 RPM
      + idle). Candidates: BOOM Library (cars, the game-audio reference), Effectsense "Loopable Motors",
      Sonniss GDC bundles (free yearly), Pro Sound Effects / A Sound Effect (search "car engine loops
      RPM"). Free CC0 sets found were one sound re-pitched (OpenGameArt) — not better. If one is chosen,
      it replaces only engineWorklet.js; the model stays.
- [ ] Tyre sounds (roll, skid, drift squeal by slip), wind by speed, wall scrape.
- [ ] Landing sounds (thump by impact speed; a distinct sound for a PERFECT landing), boost, checkpoint,
      finish, UI clicks, countdown.
- [ ] Impacts: sparks on wall scrapes and hard landings, debris on crashes (no camera tricks: the
      camera stays behind the car).
- [ ] **Smoke**: drift / tyre smoke, exhaust, landing dust. Try Fire Pro baked six-way books
      (v3/fire-bake-lab.html) against the old game's drift smoke (modularRoadDriftSmoke.js); keep the
      better, measured in GPU ms.
- [ ] Boost visuals (exhaust flame, speed lines), tube light rings reacting to speed.

## Car
- [ ] Walls stop the car dead (Apex Rush's biggest complaint) → glance off.
- [ ] Analog throttle (the old car reads it as on/off); per-car tune; look split from physics (the
      wheel MODEL sets the physics radius today — carTune.js pins it).
- [ ] "No engine up a wall" into the car itself (today an input cut, autopilot.js wallCut).

## Look & tech
- [ ] Performance check: the tube run showed 37–49 fps in my window — measure GPU ms before adding more.
- [ ] Horizon fix (engine, opt-in): ground to the horizon + haze coloured by Sky Pro. Warn the user
      first (engine edits reload the alg pages).
- [ ] Shadow bake time (~4.7 s), shader warm-up.
- [ ] r186 move (repo-wide, after alg-rts ships).
