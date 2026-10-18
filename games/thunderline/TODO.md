# Thunderline — what's left (the working list)

Kept here so nothing gets lost between sessions. Design reasons live in DESIGN.md and PIECES.md;
this is just the list. Newest decisions at the top of each section. Last updated 2026-10-19.

## Now
- [ ] **Tube entrance / exit shape** — the user finds the curl "cheap" ("I don't like the way it does
      the entrance shape at all"). WAITING for the user's Apex Rush tube screenshots; redesign from them.
- [x] Tube wall thicker: 0.6 → 1.5 m (user: "looks too thin").
- [ ] **Wall riding in tubes** — the car's grip holds it near the floor even in the R32 tube turn at
      215 km/h (13–22°). Decision pending: less sideways grip on tube surfaces only (recommended), or not.
- [ ] Rest of the tube family: corkscrew, loop tube, skylight (pop out the top), trapdoor (drop
      through the floor), half-pipe channel, helix (PIECES.md §7c).

## Game
- [ ] First campaign tier (White, 5 tracks), saved as FILES in the repo, playable from the menu.
- [ ] Campaign tiers Green → Black.
- [ ] One always-loaded page (no reload between menu / builder / drive).
- [ ] Garage + more cars (a generic car body before any release: the Lotus is dev-only, trademark).
- [ ] City mode, Drift mode (DESIGN.md: the four modes) — later.

## Feel: sound, impacts, smoke (user, 2026-10-19: "sounds, impacts, smoke…")
- [ ] **Engine sound** — RPM + load from the car, layered recorded loops (on/off throttle at several
      RPMs) cross-faded and pitched, intake/whine, lift-off pops; needs CC0 engine recordings.
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
