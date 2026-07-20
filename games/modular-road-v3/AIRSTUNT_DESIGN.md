# Air-Stunt Circuit — design spec

The mode we're building: a **stunt circuit floating in the sky**. The terrain below
is decoration. **Falling off the track ends the run** (respawn at the last safe
point). The goal is to **finish with the best time**, clearing gaps and jumps
without dropping into the void.

Two sub-modes share this: **build-your-own** (what we have) and **pre-made
circuits** (later — same runtime, curated tracks). Other game modes (circuit race
on terrain, drift) reuse the *same* car/ground/physics — the only per-mode
difference is the rules layer below, not the physics.

---

## 1. What already exists (do NOT rebuild)

Grounding the scope — these modules are ported and working, just not all wired:

| Module | Status | Gives us |
|---|---|---|
| `modularRoadLap.js` (`LapTracker`) | built, **not wired** | gates from start/checkpoint/finish pieces, directional plane-crossing, `fallY`, `targetLaps`, best-lap, split times, respawn-to-gate transform |
| `modularRoadGhost.js` (`GhostTrack`) | built, **not wired** | record best-lap pose stream, replay as a ghost car |
| Piece catalog | built | `jump` (ease-in ramp up to `jumpAngle`), `dive`, `loop`/`half`/`spiral`, `quarterpipe` up/down, `twist`, banks, `start`/`checkpoint`/`finish` game-line pieces |
| Builder | built | chains, connector auto-snap, free placement, **instancing**, undo |
| `respawn()` + spawn system | built (this session) | resolved spawn pose, marker, save-with-track |

So the checkpoint/lap/ghost *engine* is done. The rework is **wiring + air-stunt
rules + the gap-authoring UX + a visual pass**, not a rewrite.

---

## 2. The core loop (the rule layer)

Layered on the existing physics, active only in air-stunt mode:

1. **Fall detection.** Each tick, if the car is not grounded on a track surface
   AND has dropped more than `FALL_DROP` below the last safe height → it's a
   fall. (Not a fixed world-Y — the track varies in height, so fall is measured
   relative to where you last had track under you.)
2. **Respawn model — "last safe grounded pose."** Every tick the car is grounded
   on the road BVH, record its pose as the respawn point. On a fall, restore it
   (facing preserved, velocity zeroed). This is the Trackmania feel: fall in a
   gap → back on the takeoff ramp to retry the jump. Far more forgiving than
   "respawn at last checkpoint," which is brutal when gaps are frequent.
3. **Timing checkpoints stay, but for TIME not respawn.** `start`/`checkpoint`/
   `finish` pieces drive `LapTracker` for splits, lap validation (must cross in
   order), and the finish clock. They are NOT the respawn points.
4. **Finish → best time.** On crossing finish with all checkpoints hit,
   `LapTracker` reports the time; if it beats the stored best, `GhostTrack`
   commits and the record is saved (localStorage, keyed by track).

**Decision needed (A):** respawn model — "last safe grounded pose" (recommended,
forgiving) vs "last timing checkpoint" (classic, punishing). Or offer both as a
difficulty toggle.

---

## 3. The gap / jump system — the centerpiece

This is the weakest part today and the heart of the game. A "gap" = the road
stops, void, road continues. Authoring it must be **predictable**, not guesswork.

### 3.1 The pieces
- **Launch** — a chain-ending ramp with a defined exit angle (the existing `jump`
  piece, possibly a family: small/medium/big kicker).
- **Landing** — a chain-starting ramp angled to *receive* a falling car (the
  existing `dive` piece, mirrored — a down-ramp you land onto).
- The **gap** itself is just empty space between them. No piece.

### 3.2 The trajectory preview (the new, essential feature)
While a launch piece is the active chain's open end, draw the **predicted flight
arc** from its exit:

- At the instant the car leaves a ramp it's a **projectile** — gravity dominates,
  tyre forces gone. So a cheap **ballistic parabola** from `(exit position, exit
  velocity)` is accurate enough, and cheap enough to redraw live while dragging.
  We do NOT run the full vehicle sim for the preview.
- Exit velocity = `referenceSpeed × exitDirection` (the ramp's forward+up). The
  reference speed is a builder setting (e.g. "entry speed 25 m/s"), so you design
  the gap for a target pace.
- Draw: the arc as a fading line, plus a **predicted landing marker** where it
  descends back through the launch height (and a second marker at a chosen
  landing height if the landing is lower/higher).
- **Landing snap:** a "place landing here" action drops a landing piece at the
  predicted point, oriented tangent to the arc (so the car meets the down-ramp
  flush). You then fine-tune.

This turns gap-building from "place a ramp, guess, test-drive, adjust, repeat"
into "see the arc, drop the landing on it." It's THE feature that makes an
air-stunt builder good.

**Decision needed (B):** one reference speed for the whole track, or per-launch
speed (lets you design a slow technical gap and a fast big-air gap on the same
track)? Recommend per-launch with a track default.

### 3.3 Checkpoints on gaps
Optionally auto-drop a timing checkpoint at each landing, so a missed big jump
costs a split. Off by default (respawn is "last safe pose"); on for tracks that
want jump-by-jump timing pressure.

---

## 4. Piece set for air-stunt

Keep the instancing discipline (canonical types → GPU instancing; variety via
discrete presets, NOT freeform per-placement geometry — that's what keeps draw
calls flat regardless of track length).

**Keep / re-skin:** straight, curve, banked curve, s-curve, slope, crest,
loop/half/spiral, quarter-pipe, twist.

**Elevate to first-class (already exist, need presets + preview):** launch/kicker
(small/med/big), landing/dive.

**Add (air-specific):**
- **Narrow / wide** deck variants (difficulty).
- **Edge-lip** on/off — a raised rail so you read the track edge at speed against
  a sky background (readability, not collision).
- **Booster strip** — a straight that adds speed (pairs with the reference-speed
  gap design).
- **Half-pipe transfer / wall-ride** (stretch).

**Tunnels as an instanced variant, not bespoke geometry** — a shell flag on
straight/curve so tunnels still instance. (Today tunnels are swept per-placement;
that breaks instancing on tunnel-heavy tracks.)

---

## 5. Visual direction

The track must read as a clean object floating in sky:
- **Readable edges** — kerb lip + a bright edge line, since there's no ground
  behind the track for contrast, only sky.
- **Surface** — subtle directional texture so speed reads; centre line for lane
  sense through loops.
- **Underside matters** — you see the track's belly on loops and from below after
  a jump. It can't be an open/ugly backface. Give pieces a closed underside (a
  simple ribbed or panelled bottom).
- **Supports (optional, per-piece toggle):** thin pylons dropping toward the
  terrain/cloud deck, or none (pure Trackmania float). Instanced.
- **Sky/decoration:** push terrain down + haze it; a cloud deck near track height
  so the void reads as sky, not a bottomless black.

**Decision needed (C):** supports (pylons to the ground) vs pure float? Affects
the whole look. Recommend pure float + optional pylons per piece.

---

## 6. Perf guardrails (non-negotiable)

- **Instancing stays.** New pieces are canonical types + preset params. No
  per-placement unique geometry (the tunnel fix above serves this).
- **Trajectory preview is ballistic**, not a physics sim — a few dozen line
  points, rebuilt only while the launch end moves.
- **Collision:** static track BVH baked on edit; movers in the dynamic BVH (done
  this session). Gaps add nothing — empty space is free.
- **Fall/respawn tracking** is a few vector writes per tick, negligible.
- Target: idle draw calls stay flat as track length grows (instancing); frame
  cost dominated by the car + bloom, not the track.

---

## 7. Suggested phases

1. **Wire the rules** — `LapTracker` + `GhostTrack` into the drive loop;
   air-stunt fall detection + "last safe pose" respawn; race HUD (clock, splits,
   best, checkpoint counter). *Mostly wiring existing modules.*
2. **Gap authoring** — trajectory preview + landing snap + launch/landing presets.
   *The new, high-value work.*
3. **Piece visual pass** — edges, undersides, tunnel-as-instanced-variant,
   edge-lip/booster/narrow-wide, optional pylons.
4. **Sky/decoration** — terrain push-down + haze + cloud deck at track height.
5. **Pre-made circuits** — author a few `.json` tracks on top of the above.

Phase 1 makes it a *game* (win/lose/time). Phase 2 makes it *this* game (air
stunts). 3–4 make it look the part. I'd do 1 → 2 in that order; 3–4 can interleave.

---

## 8. Decisions (LOCKED)

- **A. Respawn model:** ✅ last-safe-grounded-pose. Fall in a gap → back on the
  takeoff ramp. Timing checkpoints (`LapTracker`) are for splits/laps only.
- **B. Reference speed:** per-launch with a track default (Phase 2).
- **C. Track look:** ✅ **pure float** — no pylons. Terrain pushed down + hazed +
  cloud deck near track height (Phase 4).
- **D. Order:** ✅ **Phase 1 first** — wire the rules so it's a game with a clock
  and respawn, then Phase 2 gap authoring.

### Phase 1 implementation notes
- Fall = `car.y < lastSafeY - FALL_DROP` (relative to the track, not a world
  plane). `lastSafe{Pose,Y}` updates every tick the car is grounded — on a high
  track that means "on the road," so terrain far below never needs disabling;
  fall-respawn fires long before the car reaches it. Absolute `FALL_Y` stays as a
  backstop.
- Timing runs inside the fixed-tick loop (deterministic splits), FX/HUD once per
  frame. Ghost records `lap.currentTime`; replays via `sampleAt`.
- Records persist in localStorage keyed by `LapTracker.courseSignature()`.
