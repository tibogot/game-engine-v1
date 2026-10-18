# Thunderline — what's left (the working list)

Kept here so nothing gets lost between sessions. Design reasons live in DESIGN.md and PIECES.md;
this is just the list. Newest decisions at the top of each section. Last updated 2026-10-19.

## Now
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
- [ ] First campaign tier (White, 5 tracks), saved as FILES in the repo, playable from the menu.
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
