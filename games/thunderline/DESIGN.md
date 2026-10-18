# Thunderline — design page (draft 1, 2026-10-17)

Thunderline is a new Trackmania-style stunt racer: short hand-built tracks, medals, an author time,
instant restart, ghosts and a builder anyone can use. It is **not** a remake of Apex Rush
(`games/modular-road-v3`). That game is a parts bin: a part comes over only when it still wins on a
fresh look, and it comes with its tests.

Status marks used below:
- **DECIDED** — I'm confident; argued below.
- **PROTO** — the direction is chosen, but a grey-box prototype must confirm it before the real build (§9).
- **LATER** — out of scope for the first playable version.

Timing: alg-rts ships first, then the repo moves to three.js r186, then real code. Before that, only
this page and the small prototypes in §9 (once the user says go).

---

## 1. What the player should feel

1. **Speed you can steer.** Fast enough to be scary, never so fast that the track is a blur you
   react to too late. You read the next piece before you reach it.
2. **Flow, then commitment.** Long runs where the car sings, broken by a few moments where you
   must commit: a brake turn, a jump you have to land straight, a wallride.
3. **"One more go".** A run is 30–60 s. Restart is instant: no menu, no loading, no countdown longer
   than the time it takes to put your fingers back on the keys. The ghost shows exactly where you lost
   time.
4. **Every crash is your fault.** The physics are honest and the same every time: same inputs, same
   result. No random bumps, no camera that hides the road.
5. **Building is drawing a road, not operating a 3D program.** You extend the road from its end like
   laying toy track. You never have to steer a camera to build.

---

## 2. References studied (what to take, what to avoid)

Sources and URLs are in [REFERENCES.md](REFERENCES.md); anything unconfirmed is marked
UNVERIFIED there.

| Reference | What makes it good | What makes it bad | Lesson for Thunderline |
|---|---|---|---|
| **Apex Rush** (Thunderboom Studios, Steam, Early Access since Feb 2026, UE5; **the main inspiration**) | 84% positive (279 reviews). **In-air control is the standout:** "like Trackmania but with in-air control", "tilting mid-air is really fun". Yaw, flip and roll, with the rotation damped when you let go. Quick respawn to the last checkpoint; ghosts with split deltas; Bronze/Silver/Gold/Diamond; Training playlist first; Workshop | **Physics not deterministic**, the main complaint from Trackmania players ("no alternative for Trackmania"); "floaty"; **walls stop the car dead**; drift "soapy"; air roll slow / hold-only; default camera struggles in loops; jumps "borderline impossible" even for Bronze. Builder: free placement with a gizmo and grid snap, a free camera that clips into objects, 90°-only rotation at first, no undo for months, "a little light" | Keep its best idea (3-axis air control, damped on release) and fix its weak points: deterministic physics, walls that let you glance off, a builder that needs no camera, easy Bronze/Silver with the challenge kept for the author medal. |
| **Trackmania 2020 / Nations Forever** | Fixed block grid (32×32 m, 8 m height step); test-drive from the cursor (Enter); the author's own run sets the medals, so every track is proven drivable; checkpoint respawn keeps your speed, double-press = standing respawn, separate restart key; linked checkpoints for alternative routes | Editor called "fiddly", "overwhelming", no tutorial; precise placement needs third-party plugins; shadow-bake step slows the edit loop | Grid + height steps; author validation; medals from the author time; the respawn rules. Keep expert modes out of the beginner's way. |
| **TM medal formula** (from plugin source) | Gold/silver/bronze = author × 1.06 / 1.2 / 1.5, rounded **up** to the next whole second | — | Use it as the default; allow hand-tuned medals only slower than the author time. |
| **Trackmania Turbo** | Beginner / Normal / Advanced editor tiers; random track generator to get started | Beginner editor felt "dumbed down"; full editor hidden behind a gear icon; generated tracks not always playable | One editor, one data format, features revealed in tiers, never two tools. |
| **Hot Wheels Unleashed 1 & 2** | Only the start piece is placed freely; every other piece chains from the open end, and you set its parameters (length, bend, bank, angle) before confirming; auto-close for circuits; validation lap with the biggest car; all official tracks built in the same tool | "Unwieldy", too many button combos, finish line hidden behind a sequence | **Chain from the open end** — it's what removes camera skill. Validate by driving. Build the campaign with the player's tool. |
| **Hot Wheels Unlimited** (mobile, Budge) | Test by dragging a car onto the track; cars explode off the track | (UX of the touch gesture UNVERIFIED) | "Drop the car here to test" is a gesture nobody needs explained. |
| **PolyTrack** (browser, three.js) | Closest to us. Instant restart (T), checkpoint respawn (R), up to 10 ghosts, tracks shared as a short text code, records verified by re-simulating replayed inputs on deterministic physics | Undo took years, copy/paste years more; players begged for basics | Text track codes, input-replay ghosts, deterministic sim. **Undo, copy/paste, eyedropper on day one.** Few effect blocks (its author: boosters only). |
| **Planet Coaster auto-complete** | Finishes a coaster circuit for you | Greys out with no reason when the end is too far off | Any automatic helper shows *why* it can't act and how far off you are. |
| **Excite Truck** | Air pitch with one readable rule: land flat → reward | — | If air control exists, the rule for using it well must be one sentence. |
| **Distance / Trials** | Editor inside the game, teaches itself | Trials Rising: 8000+ items, no tutorial | A short, strong parts list beats a huge one. |
| **Speed-perception research** (Holm 2016; Diels & Parkes) | Wider FOV and a higher camera raise perceived speed; strong motion blur *lowers* it; a render FOV ~1.22× the screen's true FOV cuts the speed under-estimate | — | Speed feel = FOV + camera + scenery near the road + edge-only effects, not motion blur. |
| **Shadow literature** (Microsoft CSM notes, MJP) | Texel-snapped, fixed-size bounds stop shimmer; clumped geometry (a flight sim, a track in the sky) needs few cascades; Trackmania bakes track shadows and draws only the car live | Fitted bounds that change with the FOV shimmer | Static track shadows + one tight live map for the car (§7, PROTO). |

---

## 3. Speed — DECIDED (number confirmed in PROTO P3)

- **Boosts go BEYOND the design speed (user, 2026-10-18: "we will add some boost at some places in
  the track that make it even faster").** So the car must stay solid (collision, landings, loops,
  tubes) at BOOST speed, not just at 216 km/h. That is the real speed requirement of P3.
- **Design speed 60 m/s (216 km/h) on a fast straight, boosts up to 70 m/s.** One constant,
  `DESIGN_SPEED`, drives every number the old game copied by hand: steering reduction, camera FOV
  reference, gap and landing previews, piece "held speed" labels.
- **Why not faster:** the old car's collision is verified to 60 m/s and has a documented ceiling at
  about 70 m/s (0.29 m travel per substep vs a 0.08 m skin). Above that is swept-collision work: a
  rewrite of the contact code with no gameplay gain on day one. Perceived speed comes mostly from
  camera and scenery (§2), not from the number on the speedometer.
- **Why not slower:** the old game sat at 48 m/s top but spent most of its time far below that,
  because its pieces slowed it (flat curves held ~19.5 m/s, banks ~35). The fix is the **pieces**, not
  the engine.
- **Corner maths at 60 m/s** (decides the piece set in §4):
  - flat turn, tyres alone (1.5 g): radius ≈ 245 m. With the old 4 g turn assist: ≈ 92 m.
  - banked 22°: ≈ 76 m. Banked ≥ 34°: no speed limit for this tyre (μ·tanθ ≥ 1).
  - So there are **two kinds of corner**: *brake turns* (flat, tight, you must slow down — drama) and
    *fast turns* (banked, you keep your speed — flow). The track author chooses which moment is which.
- Raising the speed also needs re-measuring: tubes (the car leaves an 8 m tube wall above ~64 m/s),
  loop compression (0.43 of a 0.55 m clamp at 55 m/s), road-hold ceiling (14 g vs ~13 g on a brow
  at 60 m/s). Those are tests to rerun, not reasons to stay slow.

---

## 4. Pieces and placement — REVISED 2026-10-18 (PROTO P1b)

**What changed, and why.** Draft 1 put every piece end on a level grid node facing one of 4
directions, chained from one open end. I built that as a grey-box prototype (`proto/builder.html`),
and the user's verdict rejected it for this game:
- **This is an air game:** lots of jumps, lots of time in the air, falling, **landing on a curved
  or banked road**. A level-only, 90°-only chain cannot build that: a landing road floats where the
  flight path ends, at whatever height, heading and tilt the flight needs.
- **The old builder's palette was better:** category rail, real 3D thumbnails, well organised.
- **Apex Rush's builder** (the reference) places a ghost of the piece and snaps it to a world grid
  OR a local grid. It looks modern, more than Trackmania.

So the grid is a **snapping aid, not a law**. The rules now:

- **Pieces have full 3D ends** (position, heading, pitch, bank), as in the old kit. A track is
  **many road sections floating in the sky**, joined by flights, not one ribbon.
- **Placement is a ghost under the cursor that snaps.** Priority, nearest first:
  1. **an open road end** near the cursor (screen distance): the ghost attaches exactly and inherits
     the end's pitch and bank. This is the old builder's aim-to-end, which worked;
  2. **a flight path**: every ramp lip shows its predicted flight arc. Bring the ghost near it and it
     snaps ONTO the arc, aligned with the arc's direction, so whatever piece you hold (a straight, a
     curve, a banked turn) becomes a landing the car actually meets. This is the old "snap landing",
     made a first-class tool. It is how you "land on a curved road" without any 3D skill;
  3. **the local grid** of a reference piece (the selected one), so you can build at an angle and
     still line things up (Apex Rush's "advanced grid");
  4. **the world grid** (steps 1/2/4/8 m, yaw in 15° steps).
- **Every end knows its lean** (added 2026-10-18 after the user hit it). The kit's banked pieces keep
  level sockets (the old Apex rule), so a flat piece attached to a banked end showed a step and
  nothing said why. Now the ghost turns red with the reason, and **smart next-piece chips** float at
  the open end: at a leaning end, the way back to flat ("Down") plus the pieces that keep the lean;
  at a ramp lip, the landings (which go on the arc); otherwise the pieces used last.
- **Free adjustment of the ghost:** rotate (15° steps, or 5° with a modifier), pitch and bank
  (5° steps), height. The ghost shows its snap (end / arc / local / world) by colour.
- **Pieces: a new kit, designed from scratch — see [PIECES.md](PIECES.md)** (user, 2026-10-18: "it's
  a new game… how we would have done it from scratch: the look, optimisation, shapes, some not
  needed, some missing"). P1b uses the old kit only to test placement.
- **A piece never changes once shipped.** The save stores, per piece: tile id + version, full params,
  and its **exact world pose**. Links between pieces are kept (so moving a section moves what's
  attached), but positions are never re-derived from today's defaults.

## 5. The builder — REVISED 2026-10-18 (PROTO P1b)

- **Thunderline's own UI, NOT the old palette's look** (user, 2026-10-18: the old left-rail palette
  "looks too much like a rip-off of Hazardous' Apex Rush"). What stays from the old one is what the
  user valued: real baked thumbnails and clear organisation by family. What's new:
  - a **bottom dock**: family tabs across the top, large piece cards below (horizontal);
  - **next-piece chips** floating at the open end (see §4), the fastest way to build;
  - the look: deep navy panels, an electric "bolt" blue accent and signal orange, condensed
    uppercase type (Barlow Condensed), angled "speed cut" corners, a lightning mark. No yellow,
    no italic black headers, no left rail.
- **Edges toggle in the dock: guarded / open** per piece (PIECES.md §5b). Open = harder (you can
  fall), and the piece card shows which one you'll place.
- **Ghost placement** as in §4. Click / Enter places, and the same tile stays in hand for the next
  one (stamping). Esc / right-click puts it down.
- **Camera:** after each placement the camera glides to keep the new open end in view (chaining needs
  no camera work). Orbit around the point under the cursor, wheel zooms to the cursor, F frames the
  ghost or selection. The camera never goes inside geometry (an Apex Rush complaint).
- **Select / edit:** click a piece to select it; Delete removes it (a chain closes up, as the user
  liked); grab moves a section; undo/redo from day one; copy/paste and mirror next.
- **Test from here** (one key, the real car): P3.
- **Validate** (start → all checkpoints → finish in one run) records the author time and medals.
- Draft 1's timeline strip is dropped: a track is no longer one line.

---

### Road look — first target (user, 2026-10-18, from an Apex Rush screenshot)

"Something similar for now", detailed look-dev later: dark asphalt with fine streaks running
ALONG the road (direction and speed cue), a thin white edge line, a slim, low coloured kerb strip on
the edge instead of a heavy guardrail. Bonus: a light edge is far cheaper than the old W-beam rail
(the rail and its posts were most of the old kit's ~110 triangles per metre). The colours become
Thunderline's own (not Apex Rush's red/white), worked out with the piece kit (PIECES.md).

---

## 6. Driving — DECIDED: reuse the old car's physics core, re-tuned and cleaned

The old car is the best part of the parts bin: months of measured fixes, ~30 regression tests
(guardrails at 60 m/s from 166 directions, never under the road, never launched, loops and tubes,
landings, roof contact). Nothing I could write fresh would beat it before the r186 move. So:

- **Copy cleanly into the new game:** the rigid body with the fixed 120 Hz tick and interpolation,
  the in-plane brush tyre with the contact-normal damper, the deck (force) / solid (projection)
  contact split, road hold v2, concave surface grip, rate-based air control, landing assist. **With
  their tests.**
- **Change while copying:**
  - one per-car tune object (more cars + a garage later) instead of module-wide globals;
  - physics and the car's look in separate files;
  - analog throttle (the pad triggers are on/off today);
  - one full reset shared by respawn and teleport (several states leak through respawn today);
  - the anti-crossing clamp also limits spin, not just velocity;
  - `jumpDebugTrack.mjs` renamed so the test runner actually runs it (it never has).
- **Turn assist (4 g): PROTO P3.** At 60 m/s it would do most of the cornering, and the car may feel
  on rails. I want flat turns to need braking; P3 measures the assist at 4 g / 2.5 g / off on the
  brake-turn and fast-turn pieces.
- **Determinism: PROTO P5.** Input-replay ghosts and verified author times need the same inputs to
  give the same run. Same machine and browser is likely; across browsers (`Math.sin` etc.) is not
  guaranteed.

### Controls — DECIDED

| | Keyboard | Pad |
|---|---|---|
| Steer | A/D or ←/→ | left stick |
| Throttle / brake | W/S or ↑/↓ | RT / LT (analog) |
| Drift (handbrake) | Space | A |
| Air pitch | Shift (nose up) / Ctrl (nose down) | left stick Y |
| Air roll | steer keys while airborne | left stick X |
| Air spin (yaw) | Q / E (AZERTY: by `e.key`) | LB / RB |
| Respawn at last checkpoint | Backspace (again = standing respawn) | Y |
| Restart | Delete or R | Back |

**Full 3-axis air control stays: pitch, roll and spin.** I first planned to drop spin. Apex Rush's
reviews changed that: its in-air control is the single most praised thing in the game. The old car
already has the model Apex Rush had to patch in later: rate-based (hold = rotate at a set rate),
damped the moment you let go. The rule for using it well is one sentence: **"land with your wheels
flat on the road and you get a boost"** (Excite Truck's rule). The physics do NOT reward it alone —
measured (proto/kit/landingTest.mjs): the old car's landing assist forgives nearly everything; hands
off landed 7–13° off at the same speed as a lined-up car, and an 89° crooked landing kept 99% at
0.25 s. So, after ≥ 0.8 s of air (proto/kit/landing.js): ≤ 6° = PERFECT, 1 s of the boost-pad push
(~+50 km/h); 6–30° = nothing; > 30° = ROUGH, −15% speed. Hands-off never earns it (7–13°), lining up
does (2–3°): ~2 s a lap on the test track. The grade flashes under the timer. Rates stay modest (the old
"too brutal" verdict lowered pitch to 3.0 rad/s), and roll must not feel slow (an Apex Rush
complaint).

**Walls: you glance off, you don't stop dead** (an Apex Rush complaint, and the old car's known
"kerb strike kills all speed" gap: the wheels mount the kerb before the body reaches the rail). A
shallow hit keeps most of the speed; a head-on hit is a crash. P3 tests it.

### Camera — DECIDED design, PROTO P3 for the numbers

- Keep the old chase camera's design: the boom follows the road, the view stays level, smooth spring
  motion, and in loops "only the car rotates, not the camera" (the user's verdict after driving it).
- Add speed feel the way the research says: FOV widens with speed (one curve from `DESIGN_SPEED`),
  camera slightly higher at speed, wind sound and edge-only streaks. **No full-screen motion blur.**
- Two cameras: chase (default) and a low/close one. P3 sets the numbers by playing.

---

## 7. Sky, backdrops, shadows

- **Backdrops — DECIDED:** sky only, flat ground, editor terrain LATER. The game never asks the
  terrain anything: there is a fall plane below the track for respawn, nothing else.
  **Update (user, 2026-10-18):** terrain WILL come (as decoration), so until it exists the game
  shows the **engine's default floor** under the track (no level loaded), not an empty void. The
  track floats above it; the car never drives on it; a fall resets well before the ground.
- **Sun shadows — DECIDED and built (P4, 2026-10-18), replacing the engine's cascades for this game.**
  The user saw sharpness end ~10 m from the camera. Measured cause: 2 cascades, near split 10 m;
  past it ONE 2048² map covers 10–150 m (~350–500 m box) = 4–6 texels/m, then PCF radius 4 smeared
  that over ±1 m; the FOV widening at speed was never refitted; nothing past 150 m. The track is
  static and the sun fixed per track, so (`proto/kit/sunShadows.js`):
  - **static atlas, baked once:** the sun's ortho view in 16 m cells, only the cells the track
    touches (632 for the 3.2 km test track), 8192² R32F, **15.5 texels/m at ANY distance**;
  - **live map every frame:** 48 × 48 m around the CAR (not the camera), texel-snapped, fixed size
    (no shimmer, FOV-independent), 2048² = **43 texels/m**; the car + the track around it;
  - **receiver:** live map inside the box, atlas outside, 3 m blend; 4 bilinear-compare taps
    (16 texel loads), all `textureLoad` = **no sampler bindings** at all;
  - **engine hook (opt-in, no change for other games):** `app.shadows.setSunShadowNode(node)` in
    v3/app/worldEnvironment.js + main.js. Gotcha found: three r184 caches the sun's shadow term on its
    light node across material rebuilds; switching needs one rebuilt frame with castShadow off.
  - Measured: live map 0.4 ms CPU per frame; driving 16.7 ms/frame median (60 fps); draw calls
    104 → 64 (cascades gone); GPU about the same on the overlay (~4.1–4.4 ms) — a proper interleaved
    A/B is still to do. Flipped-v bugs found and fixed by isolating live / atlas with a debug switch.
  - **To fix next:** the atlas bake takes ~4.6 s at load (632 full-scene renders) → render only the
    track, bigger cells or several cells per pass; check the live box edge while driving; ghosts.
- **Road shadows — FIXED in P3:** the deck casts from its back faces only (`shadowSide = BackSide`).
  At the default front-face casting, under Sky Pro's lower sun, the road shadowed ITSELF into a dark
  band across the near cascade even at normal bias 0.12. Back-face casting removes the band and keeps
  decks shadowing what's below them. The old game's light block (env 0.45, hemi 0.6, sun 2.6,
  exposure 1.0, normal bias 0.12) is also used.
- **Sky — DECIDED:** Sky Pro, one fixed sun per track (part of the track file), so the light is
  the same every run.
- **Shadows — PROTO P4.** The old setup (2 cascades, near split 10 m) puts the car right on the
  cascade split (car ~7.8 m from the camera), and the cascades are not refitted when the FOV widens.
  Two candidates:
  - **A. Static track shadows + live car shadow** (Trackmania's way): the track never moves, so its
    shadows are rendered once per track (or per piece) into a static map; the car (and any mover)
    gets one small, tight, texel-snapped map that follows it. Expected: crisp car shadow, no
    shimmer at any speed, near-zero cost per frame. Risk: resolution of the static map on long tracks.
  - **B. Three cascades** (0–20 / 20–60 / 60–200 m), fitted at the maximum FOV, PCF radius 2.
    Estimated +0.26 ms. Simple; known three.js path.
  - I expect **A** to win. P4 measures both in GPU ms on the MSI and the user judges the look while
    driving.

---

## 8. Campaign, runs, records, ghosts

- **Campaign — DECIDED:** tiers like Trackmania (White → Green → Blue → Red → Black), 5 tracks per
  tier to start (25 total over time). Track length 30–60 s.
- **Medals — DECIDED:** author time from the validation run; gold/silver/bronze = author × 1.06 / 1.2
  / 1.5 rounded up to the next second. Hand-tuned medals allowed, only slower than the author time.
- **Checkpoints — DECIDED:** all must be taken, **in any order** (Trackmania's rule). This removes
  the old "build order ≠ driving order" bug at its root. Missed checkpoints are shown on the HUD
  (players wrote a plugin for this in TM). Linked checkpoint groups (alternative routes) LATER.
- **Respawn — DECIDED:** Backspace = back to the last checkpoint at the speed you had there; press
  again = standing respawn (this fixes the "carried speed replays a bad line" softlock); Delete/R =
  instant restart from the start. The stuck detector from Apex Rush is kept as a safety net.
- **Ghosts — DECIDED (P5 measured):** a ghost is the run's **inputs** on the fixed tick (~28 KB per
  80 s lap, bit-exact in the same environment) plus a **pose keyframe every second** (Node vs Chrome
  drift from 1e-14 to ~1 cm over a lap, so playback snaps to keyframes). Records are
  keyed by track id + content hash, never by gate positions.
- **Track file — DECIDED:** id, version, author, sun, medals, author time, content hash, and the
  piece list as **tile id + version + full parameters + exact world pose** (no sparse "same as
  default"), plus the links between pieces. Shared as a short compressed text code (PolyTrack). Loading rebuilds the geometry and
  checks it against the hash.

---

## 9. Prototypes to run before the real build (grey box, no art)

Each one is small, throwaway, and answers one question.

**P3 (first pass), built 2026-10-18:** `games/thunderline/proto/kit/drive.html`: the old car
(physics imported untouched, Lotus dev model), Sky Pro, the old chase camera and input, on the new
pieces drawn with the old look; collision baked like the old game (deck BVH + rail-collision proxies,
road hold on banked pieces only). A test autopilot (P, or `?auto`) drives the 3.2 km test track.
Measured: **a full lap in 87 s with no falls**: banked fast turns flat out (154–173 km/h), the
loop, the 80° wallride, the brake turn (~93 km/h), and all three jumps landed on 4 wheels (landing
turn 155, banked landing 158, catch pad 153 km/h). 61 fps, ~3.3 ms CPU, ~3 ms GPU. Found:
- **Landings must be placed for a speed BAND.** The car arrived at a kicker 4% slower than planned and
  came down ~11 m short (range ∝ v²). Placing the landing for 93% of the nominal speed fixed it.
  → The builder's arc shows a band (slowest..fastest expected), the landing starts at the slowest.
- **The old car never reaches its 48 m/s top speed on these run-ups** (164–172 km/h). The design speed
  (60 m/s) needs the speed raise from the audit — the next P3 step.
- **Startup stall:** ~3 fps for the first seconds while shaders compile. Port the old game's warm-up.
- **Respawn:** "last safe spot" can be a kicker lip (respawning there at 0 km/h falls again); the
  real rule is the checkpoint respawn that keeps your speed (§8).
- To check: a darker diagonal band across a deck (cloud shadow or a shadow-cascade edge?).

**B2 — prediction + fitted landings (2026-10-18), in `proto/kit/builder3.js`.**
- **The builder drives your track with the REAL car** after every edit (a fresh car, the autopilot,
  in 240-tick slices so the page stays responsive; deterministic physics, ~0.45 ms per tick). It
  reports the lap time, top speed, **every lip's take-off speed**, and where the car falls or stops
  (orange box). A track ending on a lip runs until the take-off is measured ("open jump").
- **The arc band comes from the real take-off speed** (band = 93–100% of it), not a global guess.
- **Fitted landing** (Air → "Fitted landing"): held near a band, the builder generates a landing
  for THAT jump — a 20° down-slope starting where the slow arc falls at 20°, long enough for the
  fast arc to land on it too (+12 m), then a curve to level. Its size is in its id
  (`fitted_landing_20_<D>`, `kit.js ensureTile`), so any page rebuilds it from a saved track.
- Verified in my own headless Chrome: kicker → take-off measured 203 km/h → fitted landing 116 m →
  rest of the track; the real car laps it (25.4 s, top 212, no fall); the drive page loads it.
- To improve: the straight 20° slope is long (116 m) because the fast arc has to come down to it;
  a ski-jump profile that STEEPENS along the band would be shorter. And the prediction drives the
  autopilot's line — a human can be slower or faster; the band covers 7% below it.

**B1 — the builder on the new pieces (2026-10-18), `proto/builder3.html` + `proto/kit/builder3.js`.**
P1b's snapping ghost, dock and next-piece chips, now on the NEW pieces (kit paths, old look):
- ends carry their lean (the lean rule warns: a leaning piece on a flat end, or the reverse);
- **flight arcs are a SPEED BAND** (slow 93% .. fast 100% of the lip speed, `[ ]` to change),
  computed with the car's drag; a landing snaps to the SLOW arc and slides to its own angle;
- a landing placed on an arc remembers its lip (`flightFrom`): the lip is no longer an open end,
  and the corridor check skips the flight's own landing (that was a false alarm);
- **live checks:** road overlapping road (red boxes) and flights passing under a road, in the status;
- Edges (guarded / open, `T`), Hand (L / R), thumbnails baked from the real pieces (sRGB target —
  a linear one read dark);
- **Drive ▶** saves to `localStorage["thunderline.track.v1"]` and opens `drive.html?track=local`.
- Verified: an 11-piece, 1 km track built by script (straights, bank in, fast turn, bank out,
  kicker, left banked landing on the arc band, left fast turn…) — the real car drove it: take-off
  203 km/h, landed on the banked landing at 193, reached the end. A deliberate crossing straight
  was flagged at once.
- Next (B2): per-end speed PREDICTION (so the band comes from the track, not a global number) and
  FITTED landings generated from the band (PIECES.md §7b).

**P5 — ghosts / determinism (2026-10-18), `proto/kit/ghostTest.mjs`.** The real car (top 63, 3
substeps, boost pads) runs the test track in Node under the autopilot, recording every tick's input;
a fresh car then replays ONLY the inputs:
- **Same environment: bit-exact.** All 9,516 ticks of a 79.3 s lap matched, max difference 0. A ghost
  can be just the inputs: ~28 KB per lap (steer, throttle, flags per tick).
- **Node vs Chrome: identical for the first 5 s (599 ticks), then a 2.5e-14 difference appears
  between ticks 600 and 1199** — one rounding step in one math function, which differs between the two
  V8 versions — and grows (a car is chaotic) to ~1.4 cm by the end of the lap. Same lap, same ticks.
- **Decided:** ghosts = inputs + a pose keyframe every second (playback snaps to them, so a ghost
  never drifts visibly, a few KB more). Online record checking (LATER) needs cross-engine bit
  exactness: find the math function that differs and use our own pure-JS version (PolyTrack gets the
  same guarantee from WebAssembly).
- Rule found on the way: **inputs must be stored exactly as the physics used them** (quantise before
  the physics, never after).
- Bug found on the way: **picking the car's LOOK changes its physics.** `setWheelStyle` writes the
  module-wide `WHEEL.radius`, which the tyre probes use. In the build each car's tune owns its wheel
  radius; a cosmetic swap must never touch physics (ghosts and records must stay comparable).
- Test track: the user saw it overlap itself (all turns were right-handed). Pieces now have mirrors
  (`…_L`); `layoutCheck.mjs --search` tried all 256 left/right assignments, 128 are clean (no road
  overlap, clear flight corridors); the track uses an alternating one. The road-overlap check is
  part of the layout now — the builder needs the same.

**P3 step 2 — design speed + boosts (2026-10-18).** The drive page sets, at load and on this page
only (the old car's code is untouched): `TIRE.topSpeed` 63 (terminal ≈ 60 m/s), `steerSpeedRef` and
the camera's `fovSpeedRef` from it, **3 physics substeps** (per-car field). Boost pads: touching one
pushes along the nose (14 m/s², 2 s) on top of the engine. Measured with the autopilot:
- **Full lap, no falls, 80.2 s** (was 87 at the old speed). Take-offs 203 / 175 / 181 km/h, landings
  186 / 163 / 166. **Boost 205 → 265 km/h, top 279 km/h (77.5 m/s)** into the loop — loop held.
- **Substeps, clean A/B** (same start, 600 ticks, alternated): 2 → 0.32–0.33 ms/tick, 3 → 0.45–0.51
  ms/tick (+~0.3 ms per frame), identical driving on the straight. At 279 km/h, 3 substeps = 0.22 m
  per substep (inside the 0.25 m the old collision was verified for); 2 would be 0.32. **Decided: 3.**
- **Flights must use the car's air model:** gravity + its drag (AERO.drag·v²/mass; downforce is off
  in the air). A gravity-only arc overshot by ~5% (~9 m).
- **Each kicker has its own take-off speed** (175 km/h after a brake turn vs 202 on a long run-up):
  landings are fitted per kicker, from the predicted speed there (PIECES.md §7b).
- **Flight corridors must be checked for clearance.** The self-crossing test track put an overpass
  ~5 m above the first kicker's lip: the car hit its underside (a one-tick vy +18 → −7 m/s). Later
  the 48 m wide catch pad overhung the end of flight 1. The layout now names the blocking piece.
- **Walls still stop the car dead:** at the higher speed the autopilot ran wide out of a brake turn
  into the rail and stopped (nose in, tipped on the kerb). That's the old "kerb strike kills all
  speed" gap and Apex Rush's top wall complaint → a real car item for the build (glance off).
- Still open: the shadow bake (4.6–4.8 s = ~7.6 ms fixed cost per render call → batch or bake
  progressively), the shader warm-up, the camera feel at speed (the user's verdict).

**P1b, built 2026-10-18:** `games/thunderline/proto/builder2.html`. The old kit's 163 tiles, the
old palette (same markup, `palette.css` as it is, thumbnails baked with the real materials), and a
ghost that snaps to open ends → flight arcs → local grid → world grid. On an arc, a landing tile
slides to the point where the fall angle equals its own, so its exit comes out level (checked: after
`land_40` the following banked section stays level at 14.4 m). Not in it yet: grab/move a section,
copy/paste, mirror, test drive.

**P1 + P2 (first version), built 2026-10-17, rejected 2026-10-18 (see §4), kept only as a record:** `games/thunderline/proto/builder.html` (pure grey box,
no engine, `pieces.js` + `builder.js`; `node games/thunderline/proto/piecesTest.mjs` checks that every
piece, at every size, height and heading, ends exactly on its grid node: 4716 checks). It has the
4 families (Road with bend/height, Fast turn, Jump fitted to the arrival speed, Loop), checkpoint and
boost flags, the automatic camera, the timeline coloured by predicted speed, overlap warnings, undo,
a track code (~160 characters for 10 pieces) and a preview ride at the predicted speed. Not in it
yet: the top-down map variant, copy/paste, mirror, wallrides.

| # | Question | How it's tested | Measured |
|---|---|---|---|
| ~~P1/P2~~ | ~~Level grid, chained from one end, timeline~~ | Built (grey box), **rejected** 2026-10-18: can't build air sections or landings on curved roads; old palette is better | — |
| P1b | Ghost placement with snapping (open ends, flight arcs, local grid, world grid) + the old palette, on the real kit pieces | Build an air-heavy section: ramp → flight → landing on a banked curve → drop to a lower road | time to build it, how often the camera had to be moved, user's verdict |
| P3 | Speed and camera feel: 50 / 60 / 70 m/s; turn assist 4 g / 2.5 g / off; FOV curve | The real car on a grey-box test strip with brake turns, fast turns, a jump | lap times, physics ms per tick (3 substeps?), user's verdict while driving |
| P4 | Shadows: static track + live car map vs 3 cascades | Same strip under Sky Pro | GPU ms (not fps), shimmer at 60 m/s, user judges the look |
| P5 | Determinism: does replaying inputs give the same finish time? | Record 20 runs, replay in Node and Chrome | bit-exact or not; where it diverges |

---

## 10. Parts bin: what comes over from Apex Rush

| Part | Verdict | Why |
|---|---|---|
| Car physics core + its tests | **Keep**, copied cleanly (§6 changes) | months of measured fixes; nothing fresh beats it soon |
| Chase camera design + `chaseFramingTest` | **Keep**, re-tuned | the user signed off its loop behaviour after driving it |
| Socket maths (`exit = entry · L`) | **Keep** | exact (5.7e-14 drift); the grid sits on top of it |
| Bank rules (transitions on straights, turns hold the lean, level sockets, C2 eases, curled deck) | **Keep** | three iterations to get the user's approval |
| Snapshot undo | **Keep** | ~1 ms per step, well tested |
| Run gates (plane crossing) | **Keep** the crossing test; **replace** ordering and record keys | build-order checkpoints and 1 m-rounded keys were bugs |
| Track format v4 | **Replace** | positions rebuilt from current defaults; sparse params |
| 76 generators / 160 presets + the palette UI (rail, baked thumbnails) | **Keep** (revised 2026-10-18), frozen as tiles; add faster tiles for 60 m/s | the user likes them; measured and tested |
| Free gizmo, detach/pin, whole-chain tilt | **Drop**, replaced by the snapping ghost (§4) | the source of most editing pain |
| Aim-to-open-end, snap landing (`gapArc.js`) | **Keep**, made central | they're exactly what an air game needs |
| Pose-only ghosts | **Replace** with input replay (+ display pose) | a pose ghost can't prove a time |
| `stuntVehicle.js`, `modularRoadLap.js`, the 48-slider dev panel | **Drop** | stale fork, dead code, never saved |
| Junction plates | **LATER** | single-path tracks first; code kept in the bin |
| City, dock drift, props, traffic | **LATER** | other modes, same car |
| Lotus model | **Dev only** | trademark; a generic body before any release |

---

## 11. Open questions I'll decide after the prototypes

- World-grid step and rotation steps, and how strong each snap is (P1b).
- Turn assist strength and the final design speed (P3).
- Shadow method (P4).
- Whether ghosts can be input-only or must keep the pose track (P5).
- The name: a trademark check for "Thunderline" before any public release.
