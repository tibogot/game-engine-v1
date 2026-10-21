# Thunderline — what's left (the working list)

Kept here so nothing gets lost between sessions. Design reasons live in DESIGN.md and PIECES.md;
this is just the list. Newest decisions at the top of each section. Last updated 2026-10-19.

## Now
- [ ] **APEX RUSH SCREENSHOTS (user, 2026-10-21, 8 shots): the game is AIR — jumps, falls, landings at
      all angles.** What they show vs us, the order agreed:
      1. [x] RAILS PER SIDE + SIDE-BY-SIDE SNAPPING (shots 5, 6, 8; the user's main point). The dock's
         RAILS switch: Both / Left / Right / None (T cycles); a placed piece keeps `open` (old tracks) +
         `rail: "L"|"R"`; oldLook.js sideProfile / railSides (kerb + rail on that side, the other edge
         flush). A piece held near a placed piece's side snaps FLUSH beside it (same start, offset by both
         half widths; flat-starting, not tubes / half-pipes / landings), linked `sideOf` (not loose,
         carried by reflow), and the rails BETWEEN come off (new piece: outer rail; neighbour: loses its
         joined side). Side pieces: solid + drawn in the drive page, not on the car's line; in the
         builder's test lap too; the line goes on from the road that leaves a piece beside. Mirror / pasted
         mirrored sections swap L/R. Tests: 2 straights side by side (32 m road, rails outer only, flush);
         jump → platform 64 + platform beside it (96 m landing) → funnel from the side one → road: test lap
         13.0 s, no warnings; seen from above in the drive page.
      2. [x] FREE PLACEMENT made fast (shots 1, 5): hold ALT = no snapping (exactly where you point, on
         the build height's grid); CTRL + wheel turns the piece in hand (15°, with Alt 5°); Shift + wheel
         height stays as it was (2 m); H = the height of the placed piece under the mouse; arrows tilt up
         to ±90° (Shift 15° steps, was ±45), 0 / ` levels it. Panel hint while a piece is in hand; KEYS
         list updated. All checked with real key / wheel events. NOT yet: snapping a piece onto ANOTHER
         piece's surface at an angle (stacking), and Alt's browser-menu side effect untested by hand.
      3. [x] THE RAMP FAMILY (shots 1, 4, 5, 6), new RAMPS tab: Launch 45° and 60°, a Quarter pipe
         (curls to 94°: the car goes ~51 m up and falls back into the curve; at 90° it drifted forward
         and came down behind), a Roll kicker (20° lip banked 30° to start the air roll), Plank 32 / 64
         (new `narrow` section, 8 m; rails follow the Rails switch, None = bare plank). Builder test at
         the end of 128 m: 45° 142 km/h, apex 39 m, back to lip height at 152 m; 60° 131 km/h, 50 m,
         112 m; roll kicker 152 km/h, 12 m, 121 m. No warnings. NOT yet: a landing that fits the roll
         kicker's banked flight (step 4), more curl heights.
      4. [x] TILTED LANDINGS for the air roll (shot 1): with the Fitted landing in hand, ← / → (or the
         dock's "Land tilt") lean its catch zone 5–45° (`fitted_landing_<a>_<D>_t<tilt>`, + = right side
         low); it rolls back to flat by its exit, laid lower by hw·sin so the car meets the deck's middle.
         Every landing on an arc notes the roll it asks for ("roll 30° left in the air to land"), from the
         car's MEASURED up at take-off (stored with the launch) to the deck's, each round its own forward
         (pitch drops out). Re-fit keeps the tilt. Tests: roll kicker → flat: "roll 30° left"; → tilted
         30° right: no roll, test lap 13.0 s, perfect; kicker 20° → tilted 30°: "roll 30° right", the
         test car rolls, perfect. In the drive page on autopilot: "Perfect landing 2°". NOTE: a deck
         tilted away from the sun gets only ambient light (afternoon: tilted right reads near-black
         navy) — normals checked, it is the light; the user to judge.
      4b. [x] PRECISION LANDINGS (user, 2026-10-21: "the car after a jump lands at the beginning of the
         track in the air or tube and if not enough speed he falls"; a landing that started long before
         was "too easy, not cool"). Landings snap to the FULL-SPEED (yellow) arc and START where a car at
         0.95 × full speed comes down (NEAR): Fitted / tilted (slope from there until the full-speed car
         is down, +12 m), the landing pieces (slid to their angle on the near arc), level pieces (4 m
         before). Every note says "lands from N km/h (full speed M) — slower falls short"
         (reachScale: the flight must clear the deck's start edge). The miss check asks only the
         full-speed car to land. (0.95, not on the full-speed arc itself: that left 0 margin, 1% slower
         arrived under the start.) Tested: kicker 20° → Fitted / Landing 20° / platform, roll kicker →
         tilted: all "lands from ~95%", test laps perfect; in the drive page, take-off 159 / 156 / 153
         km/h land, 147 / 139 / 130 fall (the builder said 151). RISK (the 2026-10-19 problem): a rough
         landing keeps 85% of the speed, so a rough landing just before a jump now means falling short —
         intended, but watch the White tier.
      5. [x] A WALL WITH A HOLE (shot 2), two obstacles (obstacles.js, Obstacles tab), solid all round the
         hole (the test lap and the game collide with the same boxes): WALL · DOOR across the road
         (26 × 12 m, an 8 × 5.5 m door at road level; snaps on the road like a block, 2 m steps across;
         the autopilot's line goes THROUGH it — avoidObstacles `aimAt`); WALL · HOLE in the air (30 × 26
         m, hole 10 × 8 m) laid upright on a jump's full-speed arc, facing the flight; its note says
         which take-off speeds fly through ("from 142 to 159 km/h"). Glowing frame round the hole,
         orange chevrons over it. Tests: door centred / 4 m right: test laps 6.97 / 7.05 s; hole at a
         kicker's apex + fitted landing: test lap 12.63 s, perfect; drive page: straight at the
         off-centre door hits the wall (132 → 29 km/h); take-off 123 km/h hits under the hole (→ 17
         km/h, falls). NOT yet: the hole wall is not carried when its jump moves (a prop, like the
         others — `from` is stored for that), no Re-fit for it; walls that move / close (later).
         Also fixed: leaving a drive within 1.4 s of a landing left its banner up on the next drive.
         DOOR CENTRED (user, 2026-10-21: "the wall is not centred and it looks bad"): the wall stays square
         across the road (road width + 5 m each side), only the DOOR slides (prop dx, 1 m steps, ±(hw−5));
         obstacles.js shapeOf(kind, prop). Test: door 3 m right, test lap 6.98 s.
- [x] **PERFECT needs ALL FOUR WHEELS** (user, 2026-10-21: "only two wheels front touch the road, you
      almost fell and it still said perfect"): landing.js waits up to 0.25 s after the first touch for the
      other wheels; if they don't come down (the rear hanging off a landing's start edge) or the car
      bounces off, the grade is "ok" at best (no boost), the banner says "not on all four wheels". Drive
      page, fitted landing (lands from 151): take-off 149 km/h → "ok, partial" (err 0°); 150 → perfect.
      NOTE: a rules change — old ghosts replayed through carRules may drift where they landed partially.
      6. Vertical launch pipes and ceilings to drive upside down (shot 3), checkpoint arches
         (shot 7), floating-island scenery (shots 1, 3):
         a. [x] SKY LOOP (Stunts tab): a loop with its two vertical sides OPEN — curl up (R16), 12 m gap
            up, the roof (R16, 180°, stepped 18 m sideways), 12 m gap down, curl back level. No new
            physics (`gap` segments). Sized by measurement: R24 + 30 m gaps (98 m tall) crawled over at
            17 km/h and fell off. NO road hold: a road-held climb past 20° is the chase camera's
            flip-ramp shot (it froze beyond the roof, a wall of red); without it the frames read like the
            Loop R28's (behind / under the car rising, inside under it on the roof, above it falling).
            Drive page: through from 123 km/h at the curl's start at full throttle; lifting off through
            the climb fell at 138. Test lap with 3 straights before it: 16.0 s.
         b. [ ] checkpoint ARCHES' look (shot 7) — need the screenshot again (agents can't see old ones)
         c. [ ] floating-island scenery (shots 1, 3) — the same; a design pass with the user first
         d. [ ] (maybe) a real CEILING run: a flat upside-down straight between two roof curves; needs
            magnets along a curved path (carRules magnetZones are straight-axis, for twists)
- [x] **USER'S FIRST BUILD, 3 FIXES** (2026-10-21): (1) back from a drive the editor camera came back
      ROLLED — the chase camera tilts camera.up and widens the fov; stopDrive restores up (0,1,0) and the
      fov. (2) "I click a piece to move and rotate it but see no gizmo" — only a road's FIRST piece had
      one; now any road piece does (movableKind "road", rootOf): the gizmo moves / turns the WHOLE joined
      road round the piece you picked (its landings, the jump pads' landings too). (3) "after a platform
      landing I cannot snap other pieces to it" — an end only snapped within 60 px of its MIDDLE: a 48 m
      platform's end pointed at its side half was missed; now the distance is to the end's whole edge
      (taper ends use their own width). Tests: platform 128 landed on an arc, a straight aimed 18 m right
      of its end's middle → snaps, not loose; gizmo on a middle piece: +20 m, 15° → all 5 pieces moved,
      still joined; camera up / fov restored after a drive.
- [x] **FREE PLACEMENT, items 1 + 2** (user, 2026-10-22, from "what's missing to place pieces freely"):
      SPLIT (K / "Split here"): a piece in a road starts a road of its own (parent / flightFrom cut, kept
      where it is) — the gizmo then moves that half alone. JOIN: a road's first piece dropped with the
      gizmo within 4 m of an open end, heading its way (20°), joins it; "Join to the end nearby" (an end
      within 30 m) lays it on exactly; its landings and loose obstacles come along; a bank mismatch is
      refused with why. DROP LINE: a floating piece in hand (grid / Alt / arc) has a dashed line down to
      the road under it or the floor, a ring there, and "N m above the road under it · M m from the
      nearest end, K m higher". KEYS list updated. Tests: 4 straights split at the 3rd, moved 20 m (the
      first half stayed), Join button → joined, nothing loose, lap runs; split + 3 m drop → auto-joined;
      readouts "140 m above the floor …", "20 m above the road under it …" (Alt over the road).
      TILT with the gizmo: Turn mode (M) shows all three rings in the piece's own axes, 5° steps — the
      joined road pitches / banks round the picked piece (test: 10° pitch, 4 pieces, still joined).
      SEVERAL PIECES: a selection of pieces from one or more roads (Shift / Ctrl-click) gets the gizmo at
      their middle; their roads move / turn together (carriedMany; test: two roads moved 15 m).
      TIMER SWITCH (user, 2026-10-22: "no timer and countdown all the time when creating and debugging"):
      "Timer: off" in the toolbar (default, remembered): Drive starts at once (no countdown), no clock /
      checkpoint counter, a finish records nothing; on = the real race (driveSession o.noTimer).
      OFF-CENTRE ON A WIDER END (instead of full stacking — the user agreed it is not needed now):
      a piece snapped to an end wider than itself goes where you point along it, in 2 m steps (`off` on
      the piece, applied when it is laid on its parent's exit). Test: platform 64 → a straight 12 m right
      of its end's middle → road on, test lap 8.3 s, nothing loose. Full stacking: parked.
- [x] **THE BUILDER TUTORIAL** (user, 2026-10-22: "so people are not lost, and me neither … show really
      how the builder works"): builderTutorial.js, a coach panel in 10 steps (camera, start, straights,
      a turn, a kicker, a fitted landing on its arc, drive and back, a boost pad, editing a piece, the
      finish); it lights the tab / card / button to use (data-cat / data-base on the dock) and advances by
      itself when the track shows the step done. "Tutorial" in the toolbar (on a NEW track: yours is
      untouched); offered by itself the first time the builder opens on an empty track. Played through
      by a script: all 10 steps advanced, "That's the builder", no console errors. NEXT: the stunt
      lessons (short tracks in the menu, one trick each: land flat, air roll onto a tilted landing, the
      bowl / flip ramp, catch tube, wall hole, sky loop).
- **MORE OBSTACLES** (user, 2026-10-21: "poles, boost decals … many others"; agreed order):
      1. [x] BOOST PAD (Obstacles tab): a decal on ANY piece, 8 × 12 m, the Boost 32 chevrons and push
         (carRules BOOST 2 s; pads are { inv, hx, hz } boxes — obstacles.js boostZones, in the drive page
         and the builder's test lap). It FOLLOWS the deck: decalSnap samples the host piece's surface
         every metre (ringAt + deckFrame, bank and curl included), 4 cm proud, the strip kept in the
         prop; 1 m steps across inside the kerbs; not over a gap. Test: 3 straights → kicker 20 →
         fitted landing: take-off 178 → 257 km/h with a pad on the 2nd straight and one up the kicker,
         lap 12.42 → 10.53 s, the landing flagged "misses it — Re-fit"; seen in the drive page (BOOST
         lights). Trap: the strip was wound face-DOWN — invisible from above, fine in the thumbnail.
      2. [x] POLES (Obstacles tab): POLE (r 0.45, 6 m, hazard bands at eye height, glowing cap, foot
         plate), SLALOM (4 poles 18 m apart, ±3 m across), POLE GATE (2 poles 8 m apart). Solid
         cylinders; slalom / gate slide across only as far as keeps their poles on the road (halfW).
         Autopilot: avoidObstacles takes `footprints` (one per pole, its own offset), the gate is an
         `aimAt` (through its middle); poles get lead 70 m / tail 30 m / clear 2.5 m (with the default
         35 / 15 / 2 the test car clipped a centred pole at 130 km/h, 130 → 36 km/h). Test (5 straights,
         pole / slalom / gate 1.5 m right): drive page on autopilot, no hits, closest 2.3 m (pole),
         2.9–3.4 (slalom), 3.3 (gate); test lap 8.22 s (11.22 with the hit).
      2b. [x] PLACING UX (user, 2026-10-21: "everything easy to place … the track builder is for the user
         also"): an obstacle on a road is ATTACHED to its piece — the prop keeps `on` (piece uid), `s`
         (along), `lat` (across, snapped), `yaw`; roadSnapAt lays it (placing and every rebuild:
         relayProps), so it follows its piece (insert / replace / move a road / re-fit), a pad takes the
         new shape under it, deleting the piece deletes it (undo brings both back). DRAG it to move it
         (any road, snapped as when placing; the camera holds; no gizmo arrows for these); Q/E turn a
         placed one (not pads, doors, gates, air walls); every obstacle in hand says where it sits
         ("Pole · 4 m right · 40 m along the piece"); the hint per kind (no "Q/E turn" where it doesn't).
         Tested with real mouse drags (pole onto the next piece 4 m right, pad 2 m left), insert /
         replace (pad reshaped 0.45 → 0.62 m on Launch 45°) / delete + undo. Old tracks' obstacles
         (no `on`) stay where they are. NOT yet: the slalom's dock picture is tiny (54 m long);
         Wall · hole still not carried with its jump.
      3. [x] JUMP PAD (a decal, agreed over a raised plate): the boost pad's decal (follows the deck,
         attached, dragged), ORANGE, a framed up-arrow; wheels on it → the car's speed along the pad's
         up is RAISED to carRules JUMP.v 8 m/s (never added: no stacking). Test (4 straights, pad mid
         piece 1): drive page at 136 km/h, the car's centre 4.7 m over the road (~3.7 m hop), 1.6 s of
         air, landing perfect; test lap 7.22 s.
         FLIGHT ARCS FROM JUMP PADS: every jump pad on a road is a take-off like a lip — its speed band
         drawn (the road speed scales with the band, the pad's up-kick doesn't), from the test lap's
         MEASURED take-off (stored in the pad's frame) else a guess; landings / rings / walls / tubes
         snap to it (flightFrom = the pad's uid; the road order and "connected" follow it; a track
         ending on a pad's piece runs until the take-off, an open jump). A pad mid-road: the arc ends
         where it comes back down on a road (not its own landing), so no "flight under a road". arcs
         carry `fly(scale)` (reach / hole / catch notes). Test: pad mid-road — arc 4.1 m up, 63 m long,
         no warnings; pad at the end of 2 straights — take-off 147 km/h measured, Fitted landing
         "lands from 137 km/h", test lap 8.75 s perfect, author time; drive page: perfect, 2.1 s air.
      4. [ ] PISTON PILLAR, SLIDING BLOCK (race-clock movers, like the Sweeper)
      later: slow pad, air boost ring, low bar, ramp-block, rotating gate, pendulum, moving ring,
      breakable panel, arrow boards
- [x] **Land on ANY piece** (user, 2026-10-21: "this game is about jumps … large platforms to land"): a
      road piece that isn't a landing (platform, straight, turn…) snaps onto a jump's arc LEVEL at the
      height pointed at, its start 6 m before the slow car touches down, linked to the jump (flightFrom:
      not loose, the test lap flies onto it). Notes: the fast car lands past its end; steep onto flat
      (> 22°: level the car in the air). Tubes / halfpipes excluded (→ catch tube). A platform is in the
      lip's suggestions. The landing CHECK now tests the deck's real footprint (segments, ± 3 m) — the old
      24 m radius counted points in front of a landing as over it: it now flags White 3's fitted landing
      (the slow band passes ~2.5 m under its front edge). NOT re-fitted (user asked; checked first): the
      BUILDER's test lap clips White 3's bowl wall (48.8 s vs the game's ~42 s, known — see Car), so it
      reaches that kicker slow and the band comes up short; a re-fit would size the landing for that slow
      car. Fix the builder test lap's bowl clip instead, then the warning goes.
- [x] **CATCH TUBE** (kit.js `catch_tube_<angle>_<D>`; builder Air + Tubes tabs, lip suggestions): a
      fitted landing's shape built as a tube from the wide portal (closure 0) to the pipe; its mouth aims
      at the FULL-SPEED flight (floor 5 m under it) — a tube in the air is a precision target: the band
      (85–100%) is 20 m+ apart vertically there, no 16 m mouth catches it all. The note gives the take-off
      speeds that get in (flown exactly, 1% steps: e.g. 155–159 km/h); red if the car would hit the roof;
      Re-fit re-aims it. Test: kicker → catch tube → tube → out: test lap 13.5 s, landing PERFECT, mouth
      crossed 0 m off-centre, 5.0 m up. FIXED on the way: the measured take-off was stored as a WORLD
      position — stale after a move or a reused uid (the user saw the tube 32 m beside the road); now in
      the lip's frame. While the take-off is still the guess (57 m/s) the note says so — Re-fit after.
- [x] **FUNNEL 48 → 16 and FLARE 16 → 48** (Platforms tab; kit.js `taper`, oldLook.js buildTaperLook):
      the deck eases (smoothstep) between the wide platform and the road over 64 m, kerbs at its edges;
      each side's rail built from frames shifted to the edge (rails converge, their collision too). Tests:
      kicker → platform 128 on the arc → funnel → road: lap 14.1 s, landing perfect; road → flare →
      platform → funnel → road: 8.2 s; both no warnings. Seen close in the drive page: smooth S, rails and
      kerbs follow, seamless join.
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
- [x] Obstacles (882988ff): Block, Sweeper, the Obstacles tab, movers on the race clock, the autopilot's
      line round them. NEXT: more, designed from the user's Apex Rush screenshots (WAITING for them);
      the autopilot does not time a sweeper's arm.
- [x] Start / Finish pieces with rounded guardrails (1745969a). Circuits (laps) later.
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
- [x] **Engine LOOPS** (user, 2026-10-20: the synth "better, but still synthetic"): engineLoops.js plays 9
      steady loops (1000-8200 RPM), the two nearest crossfaded and pitched; rendered offline by the MIT
      enginesound (github.com/DasEtwas/enginesound, v1.5.0 cli, its example6.esc: a four). Six rendered,
      the user picked GEN 6 — now the default (Settings keeps the synth). public/sounds/thunderline/engines/gen6.
      Fine-tuning: DONE a COASTING set (gen6_off.esc: weak ignition, intake shut, more mechanics; off/rpm_*.wav)
      crossfaded by load. Lift-off POPS (bright noise cracks) tried and turned OFF (user: "very annoying to
      the ears") — if ever: a few soft low "bups", not a crackle.
      NEXT: a shift "dip" + bark, tone sliders in the lab (engineLoops.js LOOP_MIX), re-render if the
      character is wrong. Configs + recipe: assets-src/engines/README.md.
- [x] Ghost wheels sat ~10 cm in the road (pose playback has no probes: full droop) — each pose now
      records the 4 wheels' ground distance; older ghosts rest their wheels at 0.5 m.
- [x] Free camera while driving: F orbits the car (drag, wheel), T slow motion / pause.
- [ ] **Recorded engine pack** — the user is looking (want: on-load AND off-load loops every ~500 RPM
      + idle). Candidates: BOOM Library (cars, the game-audio reference), Effectsense "Loopable Motors",
      Sonniss GDC bundles (free yearly), Pro Sound Effects / A Sound Effect (search "car engine loops
      RPM"). Free CC0 sets found were one sound re-pitched (OpenGameArt) — not better. If one is chosen,
      it replaces only engineWorklet.js; the model stays.
- [x] SOUND LAB (proto/sound-lab.html: click = hear it alone; a 16 s drive demo): free CC0 recordings
      (BigSoundBank, Kenney) against the synth. User's picks 2026-10-20: DRIFT SQUEAL = B, the long screech
      (sfxSamples.js, in the game, braking too); wind + rolling recordings KEPT, not used yet ("not sure");
      rail scrape + landing recordings REJECTED (landings "sound like Mario Bros") and deleted.
- [ ] Still synthesised: tyre roll, wind, landings; NO wall scrape sound. Need better sources for a car
      landing (suspension thud + body) and a rail scrape (car on metal), not generic impacts.
- [ ] Landing sounds (thump by impact speed; a distinct sound for a PERFECT landing), boost, checkpoint,
      finish, UI clicks, countdown.
- [ ] Impacts: sparks on wall scrapes and hard landings, debris on crashes (no camera tricks: the
      camera stays behind the car).
- [ ] **Smoke**: drift / tyre smoke, exhaust, landing dust. THE FX LAB (proto/fx-lab.html, 3ea8c280)
      shows every effect on our car in the game's light via kit/carFx.js (Apex Rush's smoke, exhaust,
      sparks, tyre marks). WAITING for the user's verdict per effect. Seen: at 190 km/h the trail breaks
      into separate blobs; a drift fills the chase view; sparks small in daylight. Then: a Fire Pro
      six-way PUFF as the sprite, A/B in the lab; Fire Pro books for landing dust / boost flame; then
      carFx into the drive page.
- [ ] Boost visuals (exhaust flame, speed lines), tube light rings reacting to speed.

## Car
- [x] Walls glance off (bbcfc5a1, wallTest.mjs): rail mu 0.15, rail hits never crash; at 216 km/h a
      20° clip keeps 93%, 45° 74% upright. Trade-off: the builder's Halfpipe test lap clips the bowl's
      side wall coming down (48.8 s + a landing warning there; the drive page's lap is 41.2 s).
- [ ] The campaign has no regression test: a change to the car or the autopilot broke White's Halfpipe
      test lap for a day unseen (the wheel model set the physics radius). Check every campaign track's
      test lap against its author time in the suite.
- [ ] Analog throttle (the old car reads it as on/off); per-car tune; look split from physics (the
      wheel MODEL sets the physics radius today — carTune.js pins it).
- [ ] "No engine up a wall" into the car itself (today an input cut, autopilot.js wallCut).

## Performance pass (user, 2026-10-20: "be sure the pieces and the scene are as optimized as possible")
BASELINE, drive page, White 1 (1.53 km), counts per frame (draws / k-triangles drawn), by subtraction:
total 106 / 923 · terrain 9 / 628 (the FLAT floor + far rings: 68% of all triangles) · track main pass
27 / 148 · live shadow pass 36 / 117 (it redraws the WHOLE track's instanced posts/rails each frame: an
instanced mesh spanning the track is never culled) · car main 17 / 29, car total 52 (all its meshes are on
the live-shadow layer, not only the ShadowProxy) · ghost 17 / 9 · sky 18 / 11 · post etc. 22.
Track triangles: POSTS = 1023 instances, 119k of the track's 171k (70%); deck + rails 51k.
Physics 0.65 ms per tick median (two ticks a 60 fps frame); a ghost re-simulates (doubles it).
Shadow atlas: 8192² R32F + a same-size depth buffer (~0.5 GB VRAM) for 346 cells; first bake 5-8 s on a
big track (shader compile included), a re-bake 0.7 s.
- [x] Terrain: KEPT (user: worlds will have mountains / islands / ocean; the engine's own note: 132k -> 427k tris cost 0.28 -> 0.33 ms). The sky world will switch it off.
- [x] Posts: chunks with distance detail (real 54 tris / box 12 from 150 m / none from 420 m) — 228f491b
- [x] Track merged into 256 m chunks per material, rails with distance detail (walls from 200 m, none from 700 m) — d104a6ab; the builder draws the same chunks (pieces hidden, still picked)
- [x] Live shadow layer: only the casters (ShadowProxy + tyres) — d104a6ab. White 1: 106 / 923k -> 101 / 768k, live pass 117k -> 11k
- [x] Shadow atlas: fitted to the track, no depth buffer (White 1: ~512 -> 90 MB) — 139af635. Not 16-bit (0.5 m steps: acne); no cross-load cache needed (the bake is 0.1-0.7 s)
- [x] Ghost: replays recorded poses (30/s), not physics — 9c4701af. Pack the saved inputs (~220 KB a 34 s lap)
- [x] Terrain paint: layerBudget 3 (the ground uses slots 0-2)
GPU, a quiet moment (2026-10-20, drive page, White 1 start view, gpuAB means, old/new alternated twice):
BEFORE the pass 8.30 / 8.36 ms -> AFTER 3.97 / 3.80 ms (3.59 a third time). Without the terrain layer budget
the new code is 5.30 ms: the shadow / chunk / caster work ~3 ms, the 3-layer ground shader ~1.7 ms. In-page
toggles at that view: rails + posts at full detail +0.11 ms, the whole car in the shadow map -0.05 (noise 0.3).

## Look & tech
- [x] **Shadow SAW-TOOTH** (user, 2026-10-21, screenshot): rail shadows along the road showed stair
      steps past ~24 m from the car (the baked atlas, 6.5 cm texels; the live map near the car is 2.3 cm).
      Tried, NOT a fix: a wider 3×3 filter (a wave instead of steps; streaks at spread 2.2); 2× resolution
      does not fit one texture (White 1 needs 9728² > 8192). FIXED in sunShadows.js: each atlas cell's
      bake is TURNED to the road's direction there (from the ride line, doubled-angle sum per cell; the
      casters' own points disagreed by ±6° — posts smear sideways from the sun), its centre snapped to one
      texel lattice per angle, the neighbour cell faded in across 0.15 m of each seam, and the atlas taps
      spread ±2.4 texels ALONG the road (curves: a ramp instead of a one-texel jump). Straights: a straight
      edge; curves: smooth. ?shadowAlign=0 = the old bake, ?shadowAlong= the spread.
      THEN the user's chase-view screenshot: the LIVE map near the car stepped too (rail + car shadows,
      2.3 cm texels). Compared: 2048 + tent still stepped; 4096/48 m + tent and 3072/32 m + tent clean →
      LIVE 32 m, 3072², 3×3 tent (~1 cm texels; 36 MB + depth, was 16 + 16).
      THEN still teeth in the user's free-camera close-up. Checked NOT a conflict (force-lit removes every
      shadow; only our node draws them), not the asphalt (plain grey: same), not post-FX. Redone on the CPU
      from the real map: a car edge almost parallel to the texel rows steps once every ~11 texels and a
      filter only smooths steps about its own length (radius 2.5 → 3.4 mm wobble, 6 → 1.6 mm). User chose
      SOFT EDGES: a wide 6×6 tent (36 loads, radius 2.5) on both maps with a RECEIVER-PLANE depth per tap
      (no self-shadow streaks on slopes); and the live box FOLLOWS THE CAMERA DISTANCE (32 m at the chase's
      ~8 m, × (dist/8)², down to 8 m — at 5 m a 12 m box was clean).
      THEN the user, in MY window: "EXACTLY the same saw-tooth". Enlarged 3× his view: the edge had become
      ~1 SCREEN pixel sharp — the teeth were the screen's own pixel steps (a shadow edge is shading; MSAA
      never smooths it; the engine drops FXAA when MSAA is on). FIX: the 36 taps spread with the screen
      footprint (fwidth of the light-space position / texel size, ≥ 1 texel), so the edge is ≥ ~2.5 px
      wide at any zoom. 3× crops: chase rail shadow and close-up car shadow smooth. The stats panel now
      says which shadows drew the frame ("baked + live N m · soft v3" vs "engine cascades (builder)").
      The BUILDER's Play still uses the engine's cascades (soft, untouched).
      THEN the user: dark smears on the far road. The footprint used the pixel's LONG side (looking along
      the road a pixel is a long strip): distant rail shadows spread across the road. FIX: the pixel's
      NARROW width (|a × b| / longest edge, from dFdx / dFdy) and a cap of 2 texels between taps. The near
      map's edges: a 9-tap coarse check, then a 10 × 10 tent ONLY on edge pixels. Checked as WHOLE frames
      (darkening map vs shadows-off), while the autopilot drives, and the user's two views at 1:1.
      Lessons: a syntax error (a reused name) silently left the page on old code — check the console
      before any image; and judge whole frames, not crops. OPEN: GPU cost (atlas 2 × 36 loads
      with the seam blend, live 36, the live map redrawn each frame at 3072²) — measure in a quiet moment;
      tidy the study switches (?liveFilter ?atlasFilter ?shadowAlong ?tentScale) once settled.
- [x] Free camera = the old game's debug orbit camera (modular-road-v3/debugCamera.js): C, drag orbit,
      right-drag pan, wheel / + − zoom, V world/car frame, 1-4 views, 0 recentre, T slow-mo; readout.
- [x] Guardrail posts 7.2 m apart, not 3.6 (user: "too close from each other") — oldLook.js RAIL.
- [ ] Performance check: the tube run showed 37–49 fps in my window — measure GPU ms before adding more.
- [ ] Horizon fix (engine, opt-in): ground to the horizon + haze coloured by Sky Pro. Warn the user
      first (engine edits reload the alg pages).
- [ ] Shadow bake time (~4.7 s), shader warm-up.
- [ ] r186 move (repo-wide, after alg-rts ships).
