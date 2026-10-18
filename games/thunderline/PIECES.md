# Thunderline — the piece kit, designed from scratch (draft 1, 2026-10-18)

The old kit (`games/modular-road-v3`) is evidence, not a template. This page decides what pieces
an **air-first stunt racer at 216 km/h in the sky** needs, how they're shaped, how they look and
how they're built cheaply. Status marks as in DESIGN.md: **DECIDED**, **PROTO** (a prototype
confirms it), **LATER**.

---

## 1. Evidence

**What the user actually built with the old kit** (11 saved tracks, 290 pieces):
- 31 of 76 piece types were ever used, most of them once.
- Straights: **52%** of all pieces. Then tubes (22), jumps (12), banked tilts (10), flat curves (9),
  banked turns (8), slopes (7), loops (4), quarter-pipes (4). Glass, hole, dual, vault, channel,
  tunnel, rounded ends: one use each or none.
- → a **small, strong kit** beats 160 presets.

**What the old pieces cost** (measured in P1b, triangles per piece):

| Piece | Triangles | Per metre | Draws |
|---|---|---|---|
| Straight 32 m | 3,488 | ~110 | 3 |
| Turn R40 90° | 7,122 | ~110 | 3 |
| Banked turn | 9,260 | ~110 | 3 |
| Loop | **27,608** | — | 3 |
| Tube 26 m | 3,716 | ~140 | 1 |

Most of it is the W-beam guardrail and its posts. A 2 km track ≈ 250k triangles, and in the sky
**the whole track is visible at once** (nothing hides it), so the per-metre cost matters more here
than in a city.

**What every stunt game has** (Trackmania, PolyTrack, Apex Rush, Hot Wheels Unleashed, GTA stunt races;
sources in REFERENCES.md): straights, curves in several radii, slopes, banks (tilts), loops,
wallrides, boost, checkpoint, finish.

**What most of them lack, and players had to patch around:**
- **Transitions.** Trackmania "lacks the ability to transition cleanly from flat to tilted roads";
  the community made corkscrew item sets to fill the gap.
- **Landings.** Apex Rush enlarged landings and replaced a "jump into a bank" after launch because
  it was too hard; Hot Wheels validates with its biggest car to catch "unjumpable ramps".
- **Readability of triggers.** Apex Rush added a visible booster edge and an arrow above a landing.
- **Banked and curved landings** exist almost nowhere, yet that's exactly what the user wants.

---

## 2. One idea: a piece is PATH × SECTION × LEAN — DECIDED

Not 76 hand-written generators. Every piece is three independent choices:

- **Path** — the centreline: straight, turn (radius, angle), slope (rise), crest/dip, helix, loop,
  S-bend, kicker/landing (pitch change). Curvature is **continuous** (eased ends), because at
  60 m/s a sudden change of curvature is a jolt the suspension and road hold feel (old road-hold
  lesson: smooth the normal before differencing).
- **Section** — the cross-section swept along the path: **Road** (deck + slim kerbs), **Wide**
  (landing pad / plate), **Wall** (road that curls up to vertical: wallride), **Half-pipe**,
  **Tube**.
- **Lean** — the bank, as a value at the entry and at the exit, eased in between.

**Every end (socket) carries its pose AND its lean AND its section.** Two ends fit when lean and
section match. Consequences:
- a banked piece connects to any piece that starts at the same lean: no forced Up → Straight → Down
  chains, and the "flat piece on a banked end" step the user hit can't happen silently;
- **transitions come for free**: "bank in" is just a straight whose lean goes 0 → 22°; "into a
  tube" is a piece whose section goes Road → Tube. Every (lean, section) border combination the
  catalogue needs is generated, not hand-modelled — the gap every other game has;
- the palette still shows **tiles** (named, sized, thumbnailed); the model underneath is three
  choices, so a missing combination is a new tile, not a new generator.

Kept from the old code because it was hard-won and right: the bank shape rules (the turn HOLDS the
lean, C2 eases, the deck curls up from the low edge instead of dipping), and the socket maths.

---

## 3. Sizes, from the speed — DECIDED (numbers checked in PROTO)

- **Road width 16 m** (unchanged; the car and its physics are tuned to it, and wide is forgiving
  at 216 km/h). **Module 16 m**: lengths are 16 / 32 / 64 / 128 m, so pieces line up with the
  4/8/16 m snap grid.
- **Turns, named by what they hold** (not by radius):
  - **brake turns** (flat): R32, R64 — you must slow down; that's the drama;
  - **fast turns** (banked): R64 / R128 / R256, lean chosen so they hold ~216 km/h;
  - angles 15° (kink), 45°, 90°; S-bend.
  The tile tooltip says the speed it holds ("holds 210 km/h"), from the same model as the builder.
- **Slopes:** rise 4 / 8 / 16 m; crest and dip (convex crests preferred: a concave one hides what
  comes next — SuperTuxKart's rule).
- **Kickers:** 5° / 10° / 20° / 35° launch angles, and a mega 45°. At 60 m/s a 10° kicker throws
  ~125 m; a 20° one ~235 m. The arc in the builder shows it.

---

## 4. The catalogue v1 (~32 tiles) — DECIDED list, PROTO for shapes

| Family | Tiles | Why | vs old kit |
|---|---|---|---|
| **Road** | Straight 16/32/64/128 | the workhorse (52% of use) | kept, longer sizes |
| | Wide plate 32×32, 64×48 | landing pads, freestyle areas | old "platform", cleaner |
| **Turns** | Brake turn R32/R64 × 45/90; Fast turn R64/R128/R256 × 45/90; S-bend; Kink 15° | the two kinds of corner | fewer, named by speed |
| **Lean** | Bank in / Bank out (0 ↔ 22° and 0 ↔ 38°), on 32 or 64 m | generated transitions | replaces Up/Down pairs |
| **Slopes** | Up / Down 4/8/16 m; Crest; Dip | | kept, fewer |
| **Air** | Kicker 5/10/20/35°, Mega 45°; Drop-off lip | launches | kept, angles sized to 60 m/s |
| | **Landing** 5/10/20/35° (matches the kicker set) | landings meet the arc | kept |
| | **Banked landing** (land at 0° → roll into 22°) | land straight into a bank | **NEW** |
| | **Landing turn** (land into a 45° fast turn) | "landing on a curved road" | **NEW** |
| | **Catch pad** (wide, slightly downhill, target marks) | forgiving big-air landing | **NEW** |
| | **Funnel** (wide → road) | gathers a messy landing back onto the road | **NEW** |
| **Walls** | Wallride in / Wall / Wallride out; Quarter-pipe | stunt staple, and catches | kept, generated |
| **Loops** | Loop (offset), Corkscrew (a 360° roll along a straight) | the classic + a barrel roll | loop kept; corkscrew **NEW** |
| **Tubes** | Tube in / out / straight / turn | 2nd most used | kept, fewer |
| **Specials** | Boost pad, Launch pad (vertical kick), Checkpoint (a flag on ANY piece, gate sized to its section), Start, Finish, Arrow sign | | checkpoint as a flag is **NEW** |

**Dropped:** glass road, hole road, dual boards (parkour precision pieces — not our genre), vault
and lit tunnels and channels (sky game, no ground), hazard platform, rounded ends, half-tube
variants (folded into the Half-pipe section), tube reducers, the many radius/angle presets.

**LATER:** junction split/merge (single-path tracks first), movers/elevator, bounce pad, reactor-
style anti-gravity, the 70° flip ramp (it needed six builds to get right — worth it only once the
core plays well), signs beyond the arrow.

---

## 5. The look — DECIDED direction, PROTO for the details

Rules from the research (Kinetica, SuperTuxKart, motorsport graphics), turned into our kit:
- **Brightness contrast, not hue.** Dark deck, bright edges. Thin lines blur to grey at speed —
  edge marks are bold.
- **The road surface (first target, from the user's Apex Rush screenshot):** dark asphalt with fine
  streaks along the road, a white edge line, a slim low kerb instead of a guardrail. Our colours, not
  red/white.
- **The kerb gives the speed rhythm:** alternating blocks every 4 m (a shader pattern, no extra
  geometry) — the old posts' job, for free.
- **Everything that DOES something is painted the same way:** kicker lips in signal orange, boost and
  launch pads glowing bolt-blue with a visible edge where they trigger, landings with a target mark,
  brake turns with chevrons. You read the track from 300 m away.
- **The underside matters:** in an air game you see the track from below while falling. A simple
  structural pattern on the slab's underside, lighter than the deck, so floor and ceiling never
  look alike (Kinetica's rule).
- **Floor, walls and ceiling are distinct** in loops, tubes and wallrides (different tone per face),
  so you always know which way is up.

---

## 5a. CORRECTION (user, 2026-10-18): the old look is the floor

My v0 look (`roadLook.js`: shader-painted barrier, plain asphalt, 6–9 triangles per metre) looked
much worse than the old game, and the user said so plainly: a new game that looks like a bad
version of the old one makes no sense. **Decision:** the new paths (PATH × SECTION × LEAN, lean on
every end, the new air pieces) are drawn with the OLD game's road sweep, kerbs, W-beam guardrail,
instanced posts and materials (`proto/kit/oldLook.js`), and the look is improved from there, never
traded for triangle counts. The ≤30 triangles-per-metre budget in §6 is withdrawn: the old density
(~87–110 per metre) ran at ~1.3 ms GPU in the old game; we optimise only if a measurement asks for it.
The lab with the old look: 3.2 km = ~280k triangles in **25 draw calls** (instanced per tile kind).
Still missing vs the old game: its Sky Pro sky and environment lighting (the lab has plain lights).

## 5b. Edges: guarded or open — DECIDED (user, 2026-10-18)

Every piece is placed **guarded** (a solid barrier ~1.1 m high on the outer edge of the kerb) or
**open** (kerb only). The builder's dock has the toggle, like the old game's "Edges on/off". Open is
a **difficulty tool**: a mistake on an open piece means you fall (checkpoint respawn), so authors put
open edges where the risk is the point (kicker run-ups, landings, catch pads, narrow lines) and guard
the fast turns, loops and wallrides. Validation by driving (DESIGN.md §5) keeps it fair.

- **Built into the section, not a separate mesh:** 4 extra profile edges. Guarded 9.2 triangles per
  metre, open 6.2 (old W-beam rail + posts: ~110 total).
- **Look:** white panel, a bolt-blue band, dark post marks every 4 m painted by the shader (the speed
  rhythm the old posts gave), light top. Kerb blocks stay on both kinds.
- **Ends and sockets:** edges don't need to match between neighbours (guarded can run into open).
  To do for the real build: an end cap where a barrier stops, and collision for the barrier face.
- Possible later: guarded on ONE side only (an open outside edge on a fast turn).

## 6. How pieces are built (performance) — DECIDED targets, PROTO to measure

- ~~Budget: ≤ 30 triangles per metre~~ — WITHDRAWN, see §5a. Look first; measure before cutting.
- **Geometry is shared:** two pieces with the same tile and parameters have the same local
  geometry. One geometry per tile, drawn **instanced** (PolyTrack shares mirrored models the same
  way). Draw calls ≈ number of different tiles on screen (~20–30), memory ≈ the catalogue, not the
  track.
- **Level of detail:** 2–3 sweep densities by distance; far pieces lose the kerb detail.
- **One road material** for all road sections; the surface type (asphalt, boost, landing mark) is a
  per-vertex or per-instance value, not another material (old lesson: the 16-sampler limit).
- **Collision** is a separate, simpler sweep (deck + kerb + walls), never the visual mesh.
- **Static track shadows** (DESIGN.md §7, P4): the track never moves.
- **A piece never changes once shipped:** tiles have a version; a new shape is a new version; a
  golden geometry hash per version guards it in tests.

---

## 7. P5 results (2026-10-18)

Built: `proto/kit/kit.js` (the PATH × SECTION × LEAN engine), `roadLook.js` (look v0, one node
material, no textures), `lab.html` (all tiles, a 3.2 km chained test track with flights placed on the
60 m/s arc, a ride at 216 km/h). `node games/thunderline/proto/kit/kitTest.mjs`: every tile's last
ring is its exit, lean in/out as declared, frames orthonormal, angles exact, budget held.

| | Old kit | New kit |
|---|---|---|
| Triangles per metre (average over the tiles) | ~110 | **6.2** |
| Loop | 27,608 | **2,816** |
| 3.2 km test track | ~350k (est.) | **13,216** |
| Draw calls for the whole track | 3 per piece | **14** (one per tile kind) |
| Build every tile | — | 13–25 ms |

Learned while building it:
- **Kicker and landing are the same path** (pitch up by θ); the landing is longer and gentler and
  is met tipped down on the arc, so its exit comes out level. One shape, two jobs.
- **A wallride is just lean** (0 → 80° through a turn), not a separate section. Fewer generators.
- **Marks must switch hard:** a blended mark value between "landing" (2) and "none" (0) passed
  through "lip" (1) and painted orange stripes. Fixed with a double ring at every mark edge.
- **The underside reads almost black** from below under sky light only: the lighter colour and ribs
  need the real lighting (P4) or a lift in the shader.
- Not checked yet: whether the car actually drives these shapes well (the eased-curvature loop, the
  80° wallride, landing angles) — that's P3 with the real car.

## 7b. Fitted landings (finding from P3 at design speed, 2026-10-18)

Range grows with v², so a landing placed for one speed fails for any other: at ~200 km/h a ±4%
take-off speed spread moves the touchdown by ~15 m, a 7% band by ~28 m on a 180 m jump. Seen twice
on the test track (one landing short, one long). And each kicker's take-off speed depends on what is
before it (174 km/h after a brake turn vs 202 on a long run-up), so one global speed is wrong too.
**Decision:** a landing is FITTED to the arc band of ITS kicker: the builder predicts the take-off
speed at that kicker (§ speed prediction), takes a band around it (slow..fast), and generates a
landing ramp that starts where the slowest arc comes down and is long enough for the fastest, its
slope following the arcs (each arc meets it at a shallow angle). Big jumps get long landings, small
hops short ones. The author's validation run checks it for real.

## 8. What's next

**P5 — piece lab** (grey-to-first-look, no car yet): the PATH × SECTION × LEAN sweep with the road
look v0, and 8 representative tiles (straight, fast turn, bank in, kicker 20°, banked landing,
landing turn, wallride, loop).
- Measure: triangles per metre, draw calls for a 2 km test track, build time per piece.
- Check: every end lands exactly where the next piece starts (the P1 test pattern), and the lean
  and section match rules.
- The user judges the look.

Then **P3 — the real car on these pieces** (speed, camera, turn assist, landings), which tells us
whether the sizes in §3 feel right.
