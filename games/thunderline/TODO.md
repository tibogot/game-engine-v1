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
      by a script: all 10 steps advanced, "That's the builder", no console errors.
- [x] **WHITE TIER RE-CHECKED** (2026-10-22, after precision landings + "perfect needs 4 wheels"): 1, 2,
      4, 5 fine (perfect landings, laps within 0.2 s of their author times). White 3 FELL in the
      builder's test lap at the bowl (the drive page's autopilot finished it, 41.38 s, perfect): the
      builder's ride line lay ON the deck, the drive page's 0.7 m above it — the autopilot's touchdown
      on the bowl's curved face came out wrong. builder3 ride now = the drive page's (P + U·(pivot ??
      0.7)). White 3: 39.32 s, both landings perfect (author time 42.08 kept).
- [x] **STUNT LESSONS** (user, 2026-10-22): campaign/lessons.json (built in the builder by script, each
      with a real author time), a "Lessons" tab in the menu (first), passed ✓ remembered
      (library.lessons). The drive page shows the lesson's CARD first (paused; Enter / Go, I shows it
      again) and judges the goal at the finish (perfect landings needed + the finish): "Lesson passed ✓
      · Next" or "Not yet" with why. 1 Land flat, 2 Air roll (roll kicker → tilted landing), 3 Upside
      down (half loop + roll), 4 The bowl (spin 180°), 5 Precision (wall · hole + fitted landing), 6
      Pads and loops (boost, jump pad → landing, sky loop). All six PASSED by the drive page's
      autopilot. NOT DONE: a FLIP RAMP lesson — the builder can't make a working jump off the flip
      ramp yet (the test car falls off it, its landing lands on the run-up; needs a hand-made layout and
      a look at the piece). Lesson thumbnails are weak (jumps read flat; lesson 3's shows the lap line).
- [x] **THE DOCK REORGANISED** (user, 2026-10-22, from Apex Rush's palette screenshots): tabs by kind of
      road — Game (start, finish, air ring, boost / jump pads, Boost 32) · Straight (straights, planks,
      platforms, funnel / flare) · Turns · Banked (bank in / out, banked set, wallride, U-turn wall) ·
      Slope (slopes, platform slopes, helixes, rollers, drop) · Ramps (take-offs, then every landing) ·
      Loop (loops, sky loop, half loop, twist, bowl, flip ramps) · Tubes · Obstacles — one home per
      piece (Air / Stunts / Lean / Platforms / Road gone). Our own dock and look (no left rail).
      PICTURES FOLLOW THE RAILS switch (Both / Left / Right / None): keyed per setting, the others drawn
      when first shown (wantThumb queue); not for obstacles, rings, tubes. Tutorial re-pointed (Game,
      Straight, Ramps); replayed: 10/10 steps.
      THE RAMP ⚙ (the adjustable kicker grown, 2026-10-22): Angle 5–95°, Length 12–96 m (the curl
      eased over the whole length: short = sharp, long = gentle), Width Road / Narrow (planks) / Wide
      (platforms) — `adj_kicker_<A>_<L>_<r|n|w>`; old `adj_kicker_<A>` ids load as they were (and
      convert when adjusted). Settings with names shown as names (adjShow). Tested from the hand's
      buttons: road 20°/28 m 170 km/h, 13 m up, back to lip height at 142 m; wide 20°/40 m off a
      platform 172 km/h, 14 m, 147 m; narrow 30°/24 m off a plank 164 km/h, 25 m, 174 m; 95°/44 m a
      quarter pipe 127 km/h, 61 m up, falls back on its run-up (flagged, rightly).
      PLATFORM SHAPES (2026-10-22, Straight tab): Wedge (right-angle triangle 48 × 48), Curved wedge
      (a quarter circle), both with an L version (Hand); Round end (a half circle, 24 m). The taper look
      grew `shape` (oldLook buildTaperLook: each edge its own way, the deck centred between them, rails
      along both). `closed`: no open end after them (openEnds skips them; side by side still works).
      Tested on a platform's end: snapped, nothing snaps after, test lap runs; looked at in the builder.
      TURN WIDTHS (2026-10-22): the Turn ⚙ has Width Road / Narrow / Wide (adj_turn_<R>_<A>_<n|w>[_L];
      road ids unchanged), radius in 4 m steps; a wide corner never tighter than its half width + 4 m
      (the inside edge nearly sharp: Apex Rush's rounded corners). Tested: platform → 90° R28 wide →
      platform, test lap 9.0 s; seen from above. (Faint shading streaks on the deck near a tight
      inside edge — the texture bunching; minor.)
      ONE RED ARC (user, 2026-10-22: "two arcs is very confusing, make it red with a bit of bloom"): only
      the full-speed flight is drawn (the one landings snap to), a flat red line of constant screen
      width (fat line, 5 px; the 0.35 m tube "looks weird being a tube"), opted into the selective bloom
      (applyBloomMRT — unlit lines don't glow otherwise); the panel says the take-off once ("land it on the red arc"); tutorial and
      hints say "red arc". ZOOM: the builder camera now comes to 2 m of its target (was 12 m).
      FROM THE SAME SCREENSHOTS, NOT YET: planks / platforms with a hole to drop through; a cone ("volcano") ramp; side
      wall-ramps; more turn shapes (wide platform corners, rounded corners, varied radii); turn kerb
      posts; camera zones ("Follow" / "Bumper"); a ring tube with boost arrows; ramps in more sizes.
- [x] **EVERY PAGE OPENS SILENT** (user, 2026-10-22): the drive's speaker / M turns sound on for that
      page only (not remembered — it came back on in every later page and test run); the menu's dead
      Sound setting removed (a note under Volume).
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
      4. [ ] PISTON PILLAR, SLIDING BLOCK (race-clock movers, like the Sweeper) — LAST (user, 2026-10-22:
             "one of the last things I will work on, everything else should be solid before")
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
- [x] **PERFORMANCE PASS 2 (2026-10-22, measured on White 3 in the drive page, counts not GPU time):**
      1. GHOST in one draw: its body baked into one float mesh (driveSession mergeGhostBody: interior and the
         ShadowProxy left out; built from accessors — the Lotus GLB is int16-quantised). 18 → 3 draws, 77k →
         44k triangles; looks the same (the hologram). The default car is still the LOTUS (SETTINGS_DEFAULTS).
      2. Paint arrays sized to what the game uses: startV3App terrainLayers (textureLibrary gpuLayers, a view
         of the same buffers; CPU arrays stay 7). Thunderline 3 layers: textures 611 → 568 MB.
      3. DROPPED: freeing the river / lake / water / grass-data textures saves only ~32 MB (most were never
         uploaded) and BREAKS rendering (drawn materials bind them: bind errors) — an engine restructure for
         32 MB, not worth it.
      7. Gates merged per material (gateMesh mergeParts; the header's 6-material box → a box + 2 sign faces):
         start + finish fully in view 30 → 16 draws, 24 → 14 meshes. (From the chase camera at the start the
         count can read HIGHER: the merged pylons are one mesh spanning the road, never culled.)
      CPU clean-ups DONE (same day): engine loops send a parameter only when it moved, the pitch only while
      a loop is heard, and SLEEP when muted (the AudioContext suspends: engine + sfx do no audio work); synth
      voices switched off (roll, wind, squeal) are never built; the live sun-shadow clears IN its render pass
      (no separate clear + submit) and allocates nothing per frame; sparks parse colours on change, the
      flare's fan is a table, no pool walk when nothing flies; tyre marks allocate nothing and upload one
      range per attribute per frame; the HUD writes only changed text (none while the Timer is off); race
      ticks return a shared empty list. Checked: sound on/mute/on (running/suspended/running), clock and
      speed live, sparks + marks + shadow as before, console clean.
      OPEN (need GPU timing): bloom 14 of 23 passes, terrain 626k triangles.
- [x] **NO REPEATING TILES on the grass and the mountains** (user, 2026-10-22: "fix both the repeating
      tiling of the grass and the mountain, the best solution"): worlds.js GROUND_FEATURES + ANTI_TILING —
      hex tiling to 45 m, a ×5 tile 30-110 m, the engine's new FAR TONE (a ×20 read of the same texture
      from 250 m to 1.1 km: v3/TEXTURING_PLAN step 8) and macro tint (70 m + a new 900 m octave). A/B in
      the builder: localStorage thunderline.tiling = "0" (or ?tiling=0 on the drive page) = the old ground.
      [ ] GPU COST to measure at a quiet moment (hex near is the expensive one: +0.5-1.3 ms in the editor).
- [x] **BUILDER DRIVE: no automatic finish, falls land on the ground** (user, 2026-10-22: "a finish only
      if I place the finish piece"; "I should be able to fall on the ground, it shouldn't restart"):
      rig.start({autoFinish: false, fallReset: false}) from the builder — no finish gate and no run-out
      straights without a Finish piece; a fall lands on the terrain and drives on (back only through the
      world or off its edge). Checked: off the end of a 3-piece track at 120 m → on the grass, 4 wheels,
      166 km/h, no restart. The Drive button shows its key (Tab). The CAMPAIGN keeps the automatic finish:
      White 1-5 have no Finish piece (give them one, then drop autoFinish everywhere?).
- [x] **START / FINISH GANTRIES** (user, 2026-10-22: "something we can recognize immediately … a real
      start and real finish look"; no Apex Rush start/finish shot among the refs — its checkpoint pylons
      only): gateMesh.js makeLineGantry, in the builder too (lineGate) and on the drive page. START: two
      leaning graphite pylons with bolt-blue edges, a header "START" both faces, three lamps that do the
      countdown (red one by one on 3-2-1, green at GO), the white line and the car's grid box painted.
      FINISH: taller, "FINISH" between checkered bands, a checkered banner on top, a checkered band on the
      road. Fixed on the way: gate frames were a MIRROR (X = T × U), unseen on the symmetric arches.
      The palette thumbnails show the gantries. FINISH SHORTER ("why is the finish piece so long?"): its
      run-out 72 → 28 m, the car stops FIRMLY after the line (v / 3.5 m: measured 189 km/h → 14.3 m).
      Boost 32 (a straight whose boost paint was never drawn) LEFT THE PALETTE (user's choice): the Boost
      pad does it. Kept in kit.js so old tracks load; White 1 "First Light" still has one (an unseen boost).
- [x] **Tube INSIDE, our own look** (user, 2026-10-22: "the interior tube texture is not nice, the same
      as my old game with those lines"): kit/tubeMaterial.js — graphite panels (4 m × 1/16 round, each
      its own tone), thin bloomed bolt rings every 16 m, a floor band with thin edge lines and V chevrons
      pointing the way, the roof darker; the shell outside Thunderline blue. Tubes and half-pipes
      (tubeLook.js `aRound`: 0 → 1 round the bore, floor 0.5). Trap found: an antialiased line thinner
      than a pixel (far, or grazing) must FADE (w / fwidth), not smear to 0.5 — glowing floor edges at
      the camera's height collapsed onto the horizon as one bright band across the screen.
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
- [x] **RAIL SPARKS, in the game** (user, 2026-10-22): kit/sparks.js, drawn by the drive rig (game,
      builder drive) and the FX lab. The old ones flew away from the rail at their own small speed — under
      the car's body, unseen from the chase camera (25 alive, none on screen). Now: part of the car's speed
      + a fan across the rail's plane (up, over the rail, into the road), streaks stretched by their speed
      AGAINST THE CAMERA, white-hot then orange, a flare at the contact, faded within 5 m of the lens (at
      140 km/h they streamed past it as white bars). One draw (+ the flare), bloomed. SCRAPE SOUND (sfx.js):
      a clang as it starts, a fluttering mid grind + a low rumble while it lasts, no bright highs.
- [x] **TYRE MARKS, in the game**: kit/tyreMarks.js — the old ring buffer + skid mask, but laid across
      the CONTACT NORMAL (the old ones were horizontal: on a bank, wall, loop or tube they stood on edge),
      the slide measured in the wheel's frame, all four wheels, a gap at a respawn, and TOUCHDOWN SCUFFS
      after a jump (harder = darker). Seen: a handbrake spin on asphalt. NOT YET SEEN: scuffs, marks on a
      bank / in a tube.
- [x] **FREEDOM ON THE ARC AND BEHIND A ROAD** (user, 2026-10-23: "why can't I place a piece before the platform";
      "we should be able to place pieces all along the arc"; "the editor should make the user feel as free as
      possible to make any kind of track"):
      1. The BACK of any road takes a piece (not only a Start): its end on the road's first piece; a landing
         hands its jump link to the new piece. Checked: a straight before a platform on an arc → it is the
         landing, the platform hangs off it, the test lap drives it.
      2. FIXED-SLOPE LANDINGS (Landing 20°, banked, landing turn) go where you point on the falling half, their
         slope kept (exit level); within 3° of the perfect spot they click there; the panel says how many
         degrees off and which way to pitch. Checked: 81 m apart at two aims, "falls 7° / 27° steeper".
      3. RAMP TO RAMP: a ramp in hand (kicker, launch…) goes on the RISING half too, along the climbing car;
         its own arc follows. Checked: the test lap takes off at 144 then 143 km/h from the second kicker.
      4. A landing counts the ROAD after it (up to 4 pieces), not only its first piece: no false "misses it".
- [x] **BUILDER PERFORMANCE** (2026-10-23, the editor audit; measured on White 3, my Chrome):
      1. LEAK FIXED: a rebuild disposed nothing — 10 edits +90 geometries, +28.5 MB GPU buffers; now +2 /
         +0.1 MB (releaseRebuilt: road chunks + post instances, gates / rings, obstacles, the stand-in box;
         the helper boxes; the preview's own geometry — tagged ownGeo, never the shared piece cache).
      2. The test lap SLICED BY TIME (12 ms a frame, then a frame), not 240 ticks (120-570 ms frozen).
      3. The SNAP only when its inputs change (mouse, piece in hand, its settings, track version, camera):
         a landing held over an arc re-flew ~49k flight steps a frame. Next-piece chips the same.
      Same measure before → after: 3 s after an edit 26 → 145 frames (worst 592 → 121 ms); holding a
      landing on an arc 16 → 130 frames in 3 s (median 127 → 22 ms, worst 1.2 s → 55 ms). The test lap's
      result arrives later (5.0 → 6.1 s): it no longer freezes the page to get there.
      OPEN from the audit: the rebuild is still WHOLE (all chunks, gates, arcs, checks; save re-writes the
      whole library; reflow can rebuild 9×); the test lap in a Web Worker; road DoubleSide → FrontSide;
      road noise on the deck only; underside / tube density, far LOD for deck + tubes; the live shadow
      redraws whole 256 m chunks; far rail without normals (check); drive page builds all 100 tile looks.
- [x] **PHYSICS REVIEW FIXES** (2026-10-23, from the review of the car; user: "check any physics and
      anything about the car"):
      1. NOSE DOWN on C, not Ctrl (Ctrl+W with the throttle closed the tab); the FREE CAMERA back on F.
      2. NO ENGINE UP A WALL only in BOWLS and QUARTER PIPES (carRules wallCutZones; the autopilot no longer
         cuts on its own): it cut ~a third of every loop and flip ramps. Loop A/B: exit 182 km/h (the old
         rule never got the car back upright in the measure), lap top 170 → 197 km/h; White 3 (bowl_115)
         still clean: 41.41 s, 2 perfect landings.
      3. LANDINGS GRADED ON LOAD (landing.js: a wheel is down when its spring is compressed, as the car's
         own assist): the probe turned true up to 1.6 m / 60-90 ms before the tyre. landingTest: lined up
         1-4° perfect, hands off 6-10° ok, crooked 89° rough.
      4. A RESPAWN IS A FULL RESET (Vehicle.respawnAt, shared engine): heading hold, tube/loop press, roof /
         lid holds, assist mixes, land impact, steer. Ghost still deterministic; full suite green.
      Also: the bloom helper loads in Node again (ghostTest / landingTest crashed since the tube material).
      5. ANALOG PEDALS (TIRE.analogPedals, Thunderline on): drive / brake / reverse follow the trigger (same
         run: full 86, half 60, quarter 31 km/h; keyboard unchanged). The pad's BACK restarts
         (gamepadInput restartPressed).
      KEPT ON PURPOSE (the review flagged them; the car's own notes say why): no pitch levelling on landing
      (the user's old game: "the car gets flat and stabilised, that doesn't make sense"; and landing flat is
      Thunderline's skill), pitch slower to respond than roll (a tap nudges, not a quarter flip).
      OPEN: a drift reward, a player boost (the user's call), untested above 90 m/s (boost pads, long falls).
- [ ] **FIRST-PERSON VIEW** (user, 2026-10-23: "some users prefer this view") — a camera switch (V is taken
      by the free camera's frame; pick a key), the cockpit or a bonnet view.
- [x] **TEST CAR + RESTART KEYS** (user, 2026-10-23: "a key that restarts the drive to the start line and a way
      to spawn the car anywhere … use a ghost car"): Game tab → Test car, laid on a road like an obstacle
      (track.spawn {on, s, lat, yaw, kmh}: follows its piece, gone with it), Q/E turn; drawn as the car's own
      hologram (rig.carHologram: the parked car baked into one mesh, piece frame). Panel: its start speed
      (click: 0/50/100/150/200/250 km/h), Remove. Drive (Tab) starts there at that speed (rig.start fromExact
      + fromKmh); in the drive R = again from it, Delete = the start line standing. Checked: spawns at the car
      (z −72), nose along the road, 149 km/h; R back there at 150; Delete on the line at 0.
- [x] **TYRE SMOKE, in the game** (user, 2026-10-22: "the best looking AAA tyre smoke"): kit/tyreSmoke.js, on
      litSmoke's six-way book + motion-vector frames, one instanced draw (pool 1024). Emitted by each wheel's
      real slip (slide, handbrake, wheelspin / locked brakes; front wheels 0.6×); laid along the wheel's path
      (by time AND every 0.55 m: continuous at 127 km/h, no blobs); thrown with a third of the wheel's
      speed, stopped by drag, then rising + wind (the cloud stays where the drift happened); soft into its
      own road plane per pixel; thinned within 1.2-6 m of the camera; back-lit glow of the thin smoke. The
      FX lab uses it (the old module keeps only the exhaust). Tyre marks softened (the skid mask read at a
      blurrier mip, half contrast: they read as a printed tread). NOT YET: seen at sunset (the back-light),
      GPU cost (overdraw of a dense cloud) at a quiet moment.
- [ ] LANDING DUST + PERFECT RING — PARKED (user: "forget the landing dust for now, we will do it later").
      kit/landingFx.js exists, switched OFF in driveSession. Where it stood: dust puffs still read as flat
      sheets (cut by the road — the card is now pulled toward the camera by its radius; proper fix = a soft
      depth fade), the ring's glow hazed the lens as it swept under the camera (fade it near the camera).
- [ ] Debris on crashes (no camera tricks: the camera stays behind the car).
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
