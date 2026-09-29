# alg-rts — the list

A second RTS on the same engine and in the same style as nam-rts, set in the
Algerian War (1954–1962). Started 2026-09-26. `[x]` done · `[ ]` open · `[~]`
started · **you** = your call or your work.

Keep this file current: tick things off here, add new asks here.

---

## YOUR ASKS — 2026-09-29: soldiers from Mixamo

Pipeline: `public/models/soldiers/` (the Mixamo FBX rig + clips, and unrigged
GLB soldiers) → `node tools/packMixamo.mjs` → `soldiers.glb` (one skeleton,
clips once, every soldier skinned to it) → judged in `v3/soldier-lab.html`.
Not wired into either game yet.

- [x] Pack tool + lab. soldier1 (the Mixamo rig) and soldier3 (your GLB, given
      the rig's skeleton by nearest-surface weight transfer: median 0.4 cm off
      the rig's skin, unchanged through every clip — no tearing).
- [ ] **you**: judge soldier1 vs soldier3 in the lab (close + RTS camera,
      "Skin weights" view), then download the full RIFLE clip set (~14–20,
      "In Place", short idles 2–4 s) and drop the other soldiers in.
- [~] **Weapons in their hands.** Built 2026-09-29: procedural MAS 49/56,
      MAT 49, MAS 36 (games/shared-rts/procWeapons.js, 180–280 tris) on a
      WEAPON bone the pack tool adds under the right hand, aimed per clip at the
      left hand (Mixamo's rifle clips hold the rifle at different angles — one
      fixed grip was ~15 cm off; per clip the left hand stays within 1 cm).
      **you**: judge in the lab on the rifle clips, set the grip trim. Then:
      merge the weapon into the crowd mesh (skinned to the weapon bone), and
      if the procedural guns don't convince, you find models online.
- [ ] **Soldiers that fit French Algeria** — the current ones are Vietnam-war
      US soldiers (stand-ins). Find/modify: French appelés (M1947 or
      Satin 300 fatigues, bush hat / beret / M51 helmet, MAS 49/56), paras
      (leopard camo "tenue léopard", casquette Bigeard), ALN moudjahidine
      (mixed khaki, civilian clothes, keffiyeh/chèche). Same body + pose as
      the rig so they get its skeleton for free.
- [ ] Asset cuts before shipping: lower-poly crowd version (~1.5k tris; skin
      cost = verts × soldiers), soldier1's PNG colour map → KTX2, colour maps
      at 512 (judge in the lab).
- [ ] Crowd cost per unit TYPE (games/shared-rts/crowdSkinning.js): one crowd
      per type, each skinning its full 160 capacity once it has anyone. Share
      one crowd between types that use the same mesh, size the dispatch to the
      live count, and share the baked clip table.

## NOTE FROM THE NAM SESSION — 2026-09-28: cloud shadows in games
- [ ] Read this before the next Sky Pro commit. cloudShadowsLite's sampler-free
      4-textureLoad read cost nam 1.2-1.6 ms (0.14 before, same camera, gpuAB);
      about 1 ms of that stayed even at darkness 0. It now has a `sampled` path
      (one linear-filtered read). worldEnvironment picks it for a GAME whose
      BOOT skyMode is not "skypro". The editor and alg-rts `?sky=pro` (boot
      skyMode "skypro") keep your load path and setMap, unchanged. A sampled
      game that switches into Sky Pro later gets a console warning and keeps
      the baked field (its map is NEAREST half-float and can't use the linear
      sampler slot).

## YOUR ASKS — 2026-09-27

- [x] **Searchlight tower** (steel lattice, railed platform, caged ladder,
      generator shed; the lamp its own mesh, `userData.lamp` with a `beam`
      origin, to sweep at night; 2.2k tris) and **SAS post** (2.8k tris).
- [x] **SAS post = the French lever on a HAMLET, not a forward base**
      (decided 2026-09-27 — you weren't sure; history says the SAS were
      civil-military posts IN villages: school, free clinic, the officer
      who ran the douar). Built beside a hamlet; raises French support
      there, reveals ALN buildings nearby; reinforcing there is a small
      extra. Whitewashed house + veranda, "S.A.S." over the school door,
      a medical cross over the clinic's, walled yard, well, water tank,
      cloth tricolour, sandbagged corner, radio mast.
- [x] **Buildings must clear the map's vegetation under them** (seen: the
      oasis palms grow through the SAS post in the showroom). The SAS post
      cleared only its HOUSE (userData.clearRects) — the yard kept the
      oasis's palms and grass. Now its whole walled compound (2026-09-29;
      measured: no foliage density left inside). Still to do when the
      player builds: the build system clears the footprint on placing.
- [x] **The shiny texture = "Valley soil"** (`brown_mud_dry`, the base
      layer under most of the map; your screenshot). Its roughness map sits
      ~0.5 — glossy for dirt — so the Aurès sun laid a silvery satin sheen
      over whole slopes. Now roughStr 0 (a flat 0.88, matte), normalStr 0.5,
      and its tile twice as big (uvScale 128 → 64: ~16 m, was ~8 m, the
      "Y" marks repeated every few metres). Saved in alg-aures.v3proj.
      Lesson: I looked at pebbles and cliffs; it was the GROUND everywhere.
- [ ] Tiling still shows at full zoom-out: the far tile (farBlend, ×5)
      blends albedo only. A proper anti-tiling (stochastic / rotated
      second sample) for the base layer if it still reads as a pattern.
- [x] **Windsock in the wind** (algWind.js): ONE shared wind (direction,
      strength, gusts) drives the flags AND the sock. The sock turns into
      the wind with a lag, fills and lifts with the speed, hangs limp at 0,
      flutters toward the tail; ~450 verts on the CPU. Dev panel → Wind.
      v2 after your look: it JITTERED in gusts — the flutter phase was
      time × speed, so every speed change jumped the phase; now accumulated
      phases on a low-passed speed (measured at full gusts: tail steps
      ~8 mm/frame, step change ≤1.2 mm). Bands were blurry vertex colours
      on 8 rings; now a crisp striped nylon texture (weave, stitched band
      edges), 16 rings.
- [ ] **Replace the "Wadi bed" texture** (you: `dry_river_pebbles` fakes
      stones — big painted cobbles, and it looks wrong). Candidates fetched
      from Poly Haven: `rocky_trail` (fine dry gravel in sand), 
      `rocks_ground_02`. Judge in the game.
- [x] (Done above, algWind.js.) **Windsock that moves with the wind, like the flags** (you). Cheap: one
      small mesh. Better as a VERTEX-animated cone than a cloth sim — it
      swings to the wind direction, fills and droops with wind speed,
      flutters at the tail — and shares ONE wind (direction + strength)
      with the flags, smoke and, later, the sandstorm.
- [ ] **FILL THE MAP** once buildings and vehicles are done (you): see
      "SUGGESTIONS — look & world" below, the first block.

## UNITS & UI — started 2026-09-27 (your go)

Decisions (you): nam's soldiers as STAND-INS (you will replace them);
share only the machinery (selection, orders, nav, sim, combat) in
games/shared-rts; this game's UI is its OWN files from day one (starts as
a copy of nam's layout, redesigned later). Production buildings open:
the post's gate swings, vehicles roll out of the motor pool, helicopters
lift off the pad; the ALN comes out of the cave mouth.

0. [x] **Machinery moved to games/shared-rts** (2026-09-27): navGrid,
       spatialGrid, units, unitRenderer, crowdSkinning, xraySilhouette,
       terrainDrape, teams, thumbnails, healthBar, selectionRingField,
       selection, simClock. units + unitRenderer now take the game's unit
       list (`types`, `typeKeys`, `procedural`); nam keeps thin wrappers that
       pass its own, so nam is unchanged (checked in its page: 34 units, paths,
       selection, HUD, no errors; fast lane green).
1. [x] Nav grid for alg-aures: shared createNavGrid + every showroom
       building's footprint stamped (28; vehicles excluded). **TODO**: the
       dechra is stamped whole — its lanes should be walkable; the post's
       courtyard too (gate open → walk in).
2. [x] Select + move: a section of 12 appelés (algUnitTypes.js, nam's
       soldier as STAND-IN model) musters out of the post's gate; drag-select
       + right-click move tested with real pointer events: 12 selected, all
       moved 50 m and formed up, around the post not through it.
3. [x] HUD + command card — Algeria's OWN files in games/alg-rts/ui/
       (hudBar, unitBar, commandCard, minimap), day-one copies of nam's to
       redesign later. Minimap on from the start (the post's radio mast),
       in Aurès colours. Control groups (Ctrl+1–9) moved to shared-rts.
       nam checked after the move: loads, 34 units, HUD, no errors.
       Still nam's in the copies: the command card's structure labels
       (radio/relay/enemy base), the HUD's olive/brass styling.
4. [x] Production: gate opens/closes as units march out (algPost.js).
       The post is a selectable structure (an invisible pick box over its
       footprint, so a click in the open courtyard counts); command card
       "Appelé", 6 s each, queue of 8. The gate leaves (real hinged parts
       of rtsFrenchPost.js now, both z-fight tests) swing open at 80% of a
       man's build, he walks out as a ghost to the rally point, and they
       shut 3.5 s after the last one. Tested: 3 queued → 3 out, 6 s apart.
       Selected, the post gets nam's CORNER BRACKETS round its footprint
       (square buildings brackets, round ones and units rings — you,
       2026-09-27); selectionFrameField.js moved to shared-rts.
4b. [x] Vehicles are units (behaviour = nam's for now, you 2026-09-27):
       the six parked showroom pieces (Willys, GMC, half-track, AMX-13, EBR,
       Alouette) spawn as units where they stood, in French paint. Each
       plays like its nam counterpart (numbers copied, named in
       algUnitTypes.js). Tested: click-select, box-select, right-click move
       (half-track 39 m), unit bar thumbnails, no console errors.
       Fixed on the way, nam too: every vehicle type shared ONE running-gear
       odometer (indexed per instance → jeep #0 and tank #0 wrote one slot);
       now one per type (rtsRunningGearMaterial `channel`).
4c. [x] The MOTOR POOL produces vehicles through its own doors (2026-09-27).
       Its right bay is now the GARAGE BAY: two corrugated leaves on steel
       frames, hinged on the columns, swinging OUT (userData.gate, as the
       post; both z-fight tests), a lintel over them. The bay was cleared:
       bench to bay 2's back wall, tyres and drums out on the apron by the
       left end. Bays 1-2 stay open (the ramps and the hoist are the look).
       The post's code became algProducer.js, one producer for both (and any
       later); what each builds is PRODUCTION in algUnits.js: the post
       appelés (6 s), the motor pool Willys 10 s, GMC 12, half-track 16,
       EBR 20, AMX-13 24 — no costs yet. Tested: selected, 5 buttons, Willys
       + GMC queued → doors open at 80%, both out, doors shut; post still
       fine; console clean.
       Then (you: "doors on a building open to the side look weird"): the
       garage bay is now CLOSED — a corrugated partition against the open
       shed and the same cladding outside the end columns, sheets to the tie
       and a flat gable to the roof. A closed garage with doors, built onto
       the open maintenance shed.
4d. [x] BUILDING PORTRAITS, as nam's (structureThumbnails.js): the post and the
       motor pool baked into the units' thumbnail map ("struct:<typeKey>"),
       built by the showroom's kitView (French paint, markings, doors shut),
       turned so their FRONT meets the portrait camera at 3/4. The post frames
       only its walls (shared baker: optional per-item `frame(box)`), or the
       23 m mast and the wire made it a speck. Every new building gets a line
       in ITEMS.
4e. [x] The HELIPAD produces the Alouette (30 s): it appears on the H, sits
       while its rotor SPOOLS UP (2.2 s, rotorSpin 0→1), rises off the DECK
       (not the ground under it), then flies to a holding point off the pad,
       where the next one takes off (measured: 0-2 s on the deck, 2.5 s +1.4
       m, 4.5 s at hover 35 m away). Shared units.launch(dur, {hold, fromY})
       + the renderer reading rotorSpin; nam's call is unchanged. The
       Alouette parked at the start moves off the pad too. Portrait baked.
4f. [x] THE ALN'S CAVE MOUTH produces moudjahidine (4 s each, team enemy).
       A fighter appears deep in the tunnel, in the dark, and walks out
       through the gap the breastwork leaves; the band gathers 22 m out
       TOWARD THE VALLEY (straight out of the mouth ran them to the plateau's
       edge — the camp is in a corner of the map). The tunnel is the gate.
       No AI yet: Dev panel → ALN → "Send out a band (5)".
       The moudjahid: same stand-in model as the appelé, DYED dun-brown
       (`crowdTint`, one per type — no cost per man); minimap blips of the
       enemy now red (were blue).
       Two shared fixes it needed (nam benefits too):
       · TWO CROWDS DREW ONE BUFFER: a second crowd built from the same
         model had a node graph identical but for its storage buffer; three
         keyed them as ONE program, so the moudjahid mesh drew the appelés'
         first 3 skinned soldiers (on top of them — invisible). Each crowd
         material (and its x-ray) now has its own customProgramCacheKey.
         nam has 6 crowds; checked after: soldiers render, 34 units.
       · AN EMPTY CROWD COSTS NOTHING: the skinning dispatch is sized to
         capacity (160 soldiers) and ran every frame even with no one in it;
         now no upload, no dispatch, no draw at 0 (measured: 61 dispatches/s
         before any fighter, 122 with both crowds live).
   - [ ] Measure one crowd's GPU ms with the tab FOCUSED (the numbers taken
         here were poisoned: an empty queue took 46 ms in a background tab).
   - [x] THE ALN AI (2026-09-28, algAI.js) — hit and run, this game's own.
         A band GATHERS at the cave (4-7, the cave's queue), picks French
         troops out in the OPEN (away from the post first), finds an AMBUSH
         spot 40-65 m from them on its own side (scrub, tall plants, high
         ground), APPROACHES holding fire, WAITS until they come within 32 m
         (or goes in after a minute if they are near), STRIKES 12-22 s,
         breaks off at 40% losses or French armour within 55 m, WITHDRAWS
         holding fire into the cave mouth and goes to ground (they vanish;
         they count toward the next band). First band ~45 s, then every
         80-140 s, max 18 fighters out. Dev → ALN: AI on, a band now, bands
         readout. ?ai=0 = without.
         Measured (headless, 240 s sim): a 6-man band gathered in 27 s,
         lay up 40-65 m from a 4-man patrol, went in after its minute,
         killed the patrol in ~6 s losing one, withdrew; a second band
         was lying in wait, a third gathering.
         Fixed on the way: a man stuck without a route dragged the band's
         CENTRE 100 m back and it never "arrived" — arrival is now 60% of
         the band at the spot; a straggler is re-ordered once, then sent
         home.
   - [ ] **you, look / taste**: the ambush in real time (Dev → ALN → "A band
         now", send a few appelés out toward the cave). Balance: a 4-man
         patrol lasted ~6 s — the numbers are still nam's.
   - [ ] They vanish at the mouth's threshold, not inside it: walk in (a
         ghost walk into the tunnel, as `emerge` backwards).
   - [ ] With no French out in the open they harass the post (ambush spots
         60 m+ from it): mines on the track and hamlets (SAS) instead.
   - [ ] Routes: bands go straight at their spot; hug the gullies and scrub
         (a path cost for exposure) — the approach IS the ambush.
4g. [x] COMBAT (2026-09-27, algCombat.js). nam's fighting machinery moved to
       games/shared-rts (nam keeps re-export shims): combat.js (acquire,
       chase, fire, damage, death; "a man on foot" now reads `type.foot`,
       was nam's "soldier"), projectiles.js (visible rounds by `weapon`:
       rifle, mg, cannon, gunship), tracerField, spriteField, bloom,
       combatFx (muzzle flashes, impacts, blasts), explosionField,
       flameField (burning wrecks), craterSystem (scorch marks). Blasts
       flush the birds; every shot puts up standing storks.
       Tested: 12 appelés vs 5 moudjahidine → all 5 dead in ~200 steps, the
       French scratched; a second band met by the vehicles' guns (fires,
       craters). nam after the move: loads, its soldiers kill 4 test
       enemies, no errors.
   - [x] BUILDINGS AT WAR (2026-09-28, algStructures.js): all ten placed
         buildings are combat structures. French: the post (its two tower
         MGs — rtsFrenchPost `userData.towerGuns` — each fires from the
         tower nearer its target), motor pool, helipad, mirador (MG), MG
         nest (the gun traverses), the 81 mm MORTAR PIT (arcs 25-120 m,
         splash; cover does not help), searchlight. ALN: the cave, the arms
         cache, the sangar (MG, traverses). A hit building shows its bar;
         at 0 it goes up (blast, fire, crater) and stays a WRECK — charred
         (its own darkened material), gun drooped, burning 30-60 s. A
         wrecked producer stops and refuses orders (a dead cave = no bands).
         Yours are selectable (brackets); the ALN's right-click to attack.
         Tested: 6 ALN 34 m from the MG nest → the nest (11 bursts), the
         mortar and the appelés killed them in 10 s; 8 ALN ordered at the
         post → its towers fired 21 bursts (+ the Alouette, the armour),
         the post took 24 damage; the arms cache wrecked (charred, burning).
   - [ ] Portraits for the new structures (mirador, MG nest, mortar,
         searchlight, cache, sangar) in structureThumbnails.js.
   - [ ] A real wreck shape (roof fallen, walls broken) instead of charring.
   - [x] **Line of sight for FIRE** (2026-09-29, algSight.js; shared
         combat.js `blocksSight`, nam passes none): the GROUND (heightmap,
         every 2 m, eye 1.6 m / 2.2 m vehicles → chest) and TALL buildings
         (> 2 m above the ground, baked at load: a BVH per placed piece and a
         vertical ray every 2 m — 29 pieces, 934 cells, 79 ms) stop a shot.
         Low walls, sandbags, terraces stay COVER, not blockers (you shoot
         over them). An auto target out of sight is dropped; an explicit
         attack order MOVES to get a line (measured: round the mechta, a
         line in 7.5 s). Measured: every dechra row blocks, the mechta
         blocks, a garden wall doesn't; ground blocks 12% of 20-60 m lines
         in the valley, 28% round the dechra, 40% in the massif. 2 µs a
         query. `?los=0` to A/B.
   - [ ] **you, play it**: does the massif (40% blocked) feel like the
         ALN's country, or too cluttered to fight in?
   - [x] **SKY PRO is the default** (you, 2026-09-29): algGame.js SKY_PRO
         unless `?sky=atmosphere` (the old sky + its tuned Aurès light, to
         A/B). Boots clean, cloud shadows on.
   - [x] Dev → **Sky** (2026-09-29, devPanel.js): presets (Clear, Partly
         cloudy, Broken, Overcast, Dust: cover + cirrus + haze), time of day,
         cloud cover, cirrus and its height, cloud shadows (Sky Pro's own map:
         engine cloudShadowsLite `mapOn`, the baked field's `enabled` never
         covered it), the clouds FOLLOW the game's one wind (Dev → Wind; drift
         = 4 + 24 × strength m/s) unless you move the drift, haze, sun shafts,
         god rays, exposure, ground light, Copy values. Light keeps only the
         grade under Sky Pro (its sun sliders drive the Atmosphere sky).
   - [ ] **you, look**: pick a preset / values, Copy, and I'll bake them in as
         the game's look (today: Sky Pro's defaults, "Partly cloudy").
   - [ ] Re-judge the Aurès look under Sky Pro (it brings its own sun and
         haze); GPU ms A/B against `?sky=atmosphere` in a focused tab.
   - [x] **FAR TERRAIN** (you, 2026-09-29: "the flat view is only good if
         there is an ocean"; "should be coherent with the satellite terrain";
         "for the editor too"). An ENGINE feature (v3/terrain/farTerrain.js):
         a project can carry a far heightmap (manifest.farTerrain + blob
         "farHeight"), and the TERRAIN ITSELF draws it past the heightmap —
         same shader, layers, blend, lighting, haze: no seam (a separate
         backdrop mesh was tried twice and never matched: "completely wrong
         texture", "bad tiling"). Height blended from the map's own edge over
         250 m and stood up ×2.5 with distance; normal from the far ground;
         paint by a slope/height RULE into chosen slots (splatOverlayTsl);
         two extra clipmap rings (±4 km) only while it's on; the far grid read
         with textureLoad (no sampler: the terrain is at 16). Editor: World →
         Far Terrain (on/off, blend, stand, the rule's slots and bands); saved
         with the project; nam unchanged (none). Cost below noise (free cam
         8.67 vs 8.93 ms off, noise 0.4).
         tools/algMountains.mjs: the ring outside PLAY is YOUR ERODED SAVE again
         (alg-aures.v3proj.bak × 0.6019, rms 0.64 m — the border fade undone,
         the wadis leave through gaps); the far grid is the real DEM round the
         site (30.5 km, the same transform, fitted), NOT eroded (Stream Power on
         the coarse grid made staircases). tools/lib/terrarium.mjs shared with
         algDem.mjs. Vegetation's height bands pinned; outside PLAY thinned.
   - [ ] **you, look**: from the play camera and the free camera; the stand
         (×2.5) and the rule's bands are the taste knobs (World → Far Terrain).
   - [ ] The map grew 7.0 → 11.0 MB (the far grid is 4 MB of Float32): store
         it as 16-bit or at 512² if the size matters.
   - [ ] Far terrain has no vegetation, no cloud-shadow bake difference
         checked, and getWorldHeight() still reads 0 out there (nothing walks
         there; a free camera can dip into it).
   - [x] COVER AND CONCEALMENT (2026-09-28, algCover.js). nam's rule moved
         to games/shared-rts (cover.js + coverOverlay.js; nam keeps shims):
         concealment stops you being SEEN (acquire range), cover stops you
         being HURT (from its side), firing reveals a hidden man for 4 s.
         Per game: `params` and `extra` obstacles; new `concealCeil` (nam 1).
         The Aurès: MEASURED 82.5% of walkable ground has no vegetation,
         scrub 0.5-0.6 → concealment from 0.2, full at 0.65 (the thickest
         scrub: seen at 40% range); 14.2% of the ground conceals. Cover from
         the placed pieces (no rock props on this map): HARD for stone and
         sandbags, none for wire, brush screens, thorn pens, pads. Big
         buildings stamp cover along their WALLS only (tiled over the
         footprint, a man 35 m in front of the gate had cover 0.94 in the
         open). The ALN AI now scores ambush spots with the same rule.
         V = the overlay (green cover, cyan concealment; Dev → Navigation →
         pin). Tested: a band in the scrub vs 4 appelés lost 1, in the open 2.
   - [x] (2026-09-29, shared cover.js terrainCover) Terrain cover: wadi banks, ridge crests, gully floors — the Aurès'
         real cover is the ground itself (no rock props yet either).
   - [ ] Cedars and palms: their trunks as cover in the groves.
   - [x] FOG OF WAR (2026-09-28): nam's vision grid moved to games/shared-rts
         (fogOfWar.js; nam keeps a shim), an entity may carry its own
         `vision`. What the French see: units by type (appelé 42 m,
         Alouette 72 m), buildings by kind (mirador 110 m, searchlight 100,
         post 90, MG nest 55…). Outside it the ALN is not drawn; their
         buildings stay hidden until first seen. The minimap's shroud is
         turned with the map (the canvas transform of the CoH frame). The
         fog banks go BEFORE it in the post chain (algFog rehook), as nam.
         OFF by default while the map is being built, as nam: Dev →
         Navigation → Fog of war, or `?fow=1`.
         Tested: ?fow=1 → the post's ground clear, the rest shrouded, the
         cave hidden; an ALN man out of sight not drawn, one next to the
         appelés drawn (and shot). nam: loads, its fog of war works.
   - [ ] **you**: fog of war ON by default once the map is built?
   - [ ] Line of sight for vision (ridges hide the far side), as for fire.
   - [ ] Sound (nam's recordings are there: rifle, MG, cannon, Huey…).
4h. [x] N shows the NAV GRID (as nam), and Dev → Navigation → "Nav grid (N)".
   - [ ] The post and the motor pool have no health bar yet; the helipad
         (the Alouette lands and takes off) and the other buildings are not
         selectable yet. Set rally by right-click with a building selected.
   - [ ] A vehicle appears INSIDE the open bay (as the man in the
         courtyard): a fade-in, or the doors hiding it, if it reads wrong.
       Minimap turned the CoH way: up = the start camera's forward (VIEW_YAW,
       toward the ALN), our post at the bottom. The world square is diagonal
       to that view, so it reads as a diamond; the view is a trapezoid
       (far edge capped at 2.5x the near one), not a wedge to the horizon.
   - [ ] Next: vehicles as units (motor pool rolls them out through its
         own doors, helipad helicopters), set-rally-point by right-click,
         and the HQ/post card's own labels (still nam's).
   - [ ] Minimap diamond uses 71% of the square — if it reads too small,
         a rotated square map crop (cut the far corners) is the other way.
5. [~] Animals alongside: donkeys — DONE 2026-09-29 (see ALGERIAN DONKEY
       below); on the tracks (walking between villages) still to do;
       chickens (Chicken_001_compressed.glb) in the mechta yards
- [~] **Camel** — being built in v3/sheep-lab.html ("camel-morph", 2026-09-27):
      the pack's DONKEY mesh reshaped into an Arabian camel (hump, S-neck,
      pads), same quad look, plays the donkey's 13 clips. Saharan edge more
      than the Aurès. Not in the game yet.
- [~] **STRIPED HYENA** (you, 2026-09-28; "hyena-morph" in v3/sheep-lab.html):
      built from the pack's HUSKY (same rig as the donkey: paws, dog head,
      carnivore gait) through the same morph builder. Round 2 after photos of
      Hyaena hyaena (you: "stripes don't look right at all, doesn't look like
      a hyena"): head carried LOW (neck bent 30 deg), sloping back (hind legs
      0.7, spine pitched 14.5 deg, all four paws on the ground in the walk),
      smaller narrow head with a longer muzzle, big ears, mane along neck and
      back, bushy hanging tail, warm buff coat, 10 thin leaning stripes
      PLANE-SLICED into the mesh (clean bands, still closed), banded lower
      legs, dark muzzle, black throat. 0 open edges, 0 flips. Not in the game.
   - [ ] **you, look** at it in the lab (face, ears, stripes, mane).
   - [ ] Where it lives in the game (night scavenger near the mechtas?
         flees soldiers like the herds).
- [~] **ALGERIAN DONKEY** ("donkey-morph" in the lab, 2026-09-28): the pack's
      donkey untouched in shape and clips, recoloured as a North African
      village donkey — ash grey-brown, pale muzzle / eye rings / belly, dark
      mane, ear tips and tail tuft, a dark DORSAL STRIPE and SHOULDER CROSS
      plane-sliced into the mesh (clean bands). Presets: Aurès grey, Brown,
      Pale dun (DONKEY_PRESETS).
   - [x] LOAD (PDK.load "panniers", default): a kilim blanket (deep red,
         ochre / black end borders, cream lower border, a rope over it) as a
         shell over the back — sliced edges, closed rim — and two woven
         baskets (straw bands, rim, load inside) LEANING on the flanks
         (measured body width top → bottom). Part of the donkey's mesh (one
         draw), skinned to the back: rides through every clip. 0 open edges.
   - [x] IN THE GAME (2026-09-29, algHerds.js): 3-4 tied just outside each
         village's walls and 2 at each spring — 13 donkeys, ~1/3 loaded
         (you: "only few of them carry"); two crowd draws (bare / loaded).
         Working animals: they graze on a 3 m rope and never bolt from
         soldiers (shared herd: new `bolt` / `roam` options, defaults keep
         nam, sheep and goats unchanged).
   - [ ] **you, look** in the game; then more loads (jars, firewood, sacks),
         the other coats (Brown / Pale dun) as extra templates, donkeys
         walking the tracks between villages, a lab toggle for load / preset.
- [x] **GOAT: gap on top of the head while EATING** (you, 2026-09-29) — FIXED
      268553d: the poll was skinned to the ear bone; now Head + a smoothed
      head/neck seam (Eating 371 → ~0 see-through px, Gallop 342 → 28).
- [x] **GOAT: a thin see-through slit low on the body while walking** (you,
      2026-09-28) — SOLVED in the sheep lab (you, 2026-09-29: "we spent many
      times on it"). This entry was stale; do not reopen the goat.
- [ ] **LATER — dressed animals: camels AND donkeys carrying things** (you,
      2026-09-27; your reference: a caravan camel with a striped saddle
      blanket, a wooden saddle, woven baskets and jars hung on the flanks,
      a bridle with tassels and a lead rope). Rigid pieces on the back /
      neck bones, one draw per animal; variants: caravan, pack, ridden.
- [x] **SHEEP AND GOAT FLOCKS** (2026-09-27, algHerds.js): mixed flocks
      (~12 sheep + ~6 goats, lambs and kids among them) on 5 pastures —
      both mechtas, the dechra's slope, both springs; outside the walls, the
      water and 90 m from the post and the katiba; goats take steeper ground.
      They graze, wander and BOLT from soldiers (the shared herd, as nam's
      deer). The animals are the pack's donkey reshaped
      (v3/props/animalMorph.js — the SAME builder the lab uses, so tuning in
      v3/sheep-lab.html is what the game gets). 59 sheep + 28 goats, one GPU
      crowd draw per kind; builds in ~4.5 s at boot. `?herds=0` = without.
   - [ ] **you, look** at them in the game (colours under the Aurès sun: the
         sheep is a Hamra-like white fleece with a red-brown face).
   - [ ] Boot cost ~4.5 s: cache the built templates (or build them in a
         worker) if load time matters.
   - [ ] A shepherd with each flock (a man or a boy walking with it), dogs.
   - [ ] The flock keeps together when it bolts (now each animal runs its
         own way, like deer).
- [x] **BIRDS** (2026-09-27, algBirds.js). nam's bird system moved to
      games/shared-rts: rtsBirds.js (flocks, stands, flushes, circling,
      one draw + one for the shadows) and birdKit.js (the shape pieces);
      each game passes its own species. nam's wrapper keeps nam identical
      (its bird geometry fingerprint unchanged; 21 birds live after).
      Sand & Blood's: WHITE STORKS (white, black flight feathers, the neck
      held out, red bill and legs) crossing in loose Vs and landing in the
      open fields and at the oasis (382 open spots found — this map is
      open); CROWS; GRIFFON VULTURES (2.6 m, tawny, six fingers, gliding
      9/10) circling for good 42-52 m up (the camera is 9-110 m: at 80-100
      they were above it, never seen) over the katiba, the Kef and
      the cedar spring; a STORK'S NEST on the dechra's minaret (a twig bowl
      round the finial, part of the dechra: no extra draw) with the pair on
      it, one standing, one brooding. Birds lift off for men on foot, jeeps,
      helicopters (the shared threat test now reads `type.foot`).
   - [ ] **you, look**: storks crossing (Dev: `__ALG.algBirds.spawnTransit("stork")`),
         the minaret nest, the vultures over the katiba.
   - [ ] Sparrow flocks bursting out of the gardens and palms (a small
         species; flushed by shots once combat exists — `birds.flush`).
   - [ ] At close zoom a flock can fly at the camera's height and a bird
         pass the lens (cruise 20-32 m): cap the cruise under the camera.
   - [ ] Storks on the koubba and the SAS post roof too, and a mate that
         circles the nest now and then.

## FILLING THE MAP — foliage first, then villages (started 2026-09-27)

Order: foliage → villages → animals & birds → ground detail.

- [x] **Date palms as GROVES** (you: "different trunk shapes, some curved").
      palmGeometry.js grew `trunks` (a clump from one root, clumpStems):
      a tall upright/leaning trunk, others curving out of the ground and
      rising, sweeping over, S-bent; often a young offshoot with its crown
      on the ground. `fruit: "dates"` hangs bunches instead of coconuts.
      New preset `dateGrove` (3 trunks); the oasis slot uses it
      (tools/algVegetation.mjs). Single palms (nam) unchanged — same code
      path and random stream when `trunks` is unset.
      First pass curved too hard from one point: a grove read as a vase of
      spider legs; now gentler and spread apart.
- [x] **Palm leaves greener** (you: grey-green, flat): date palms now
      #2c4c22 → #6f9a3c, deeper V-fold (38 → 50°), more sun through.
      **you**: judge the green — close up it may now be a touch lime.
- [x] **Oasis reeds** in desert colours (olive, straw tips, dark brown
      heads) — overridden in algVegetation.mjs only; nam's typha unchanged.
- [x] **No tree inside a building**: the showroom clears the painted
      plants under every piece (`app.clearVegetation`, tiled over its
      footprint or its own `userData.clearRects`). The SAS post clears only
      the house + veranda, so its garden palm stays. The build system must
      do the same when it places.
- [x] **Fog** (you: nam's fogs here?): the FOG BANKS (raymarched volume
      mist at places) moved to games/shared-rts/fogBanks.js + its panel;
      nam keeps its own siting and is unchanged (checked in its page). Here
      (algFog.js): 8 banks — both oases, three stretches of each wadi — and
      WEATHER presets that set time, banks, ground fog and far haze at once:
      Clear afternoon · Dawn mist (07:30, white in the hollows) · Dust haze
      (ochre). Dev → Weather & fog, Dev → Fog banks. +0.4 ms GPU with banks.
- [ ] Weather next: the SANDSTORM as a fourth preset (dust wall rolling in
      on the shared wind); fog banks drift WITH the shared wind.
- [ ] Light panel's time slider doesn't follow a weather change.
- [x] **Shape variants** (engine, 2026-09-27): ScatterField `variants` —
      each plant picks a variant by its own hash, each variant its own mesh
      grown from another seed. `startV3App({ tallPlantVariants: 3 })`; this
      game asks for 3 (`?variants=1` to A/B). Default 1 = unchanged (nam,
      editor). MEASURED over the oasis: 1.08 ms → 1.10 ms.
- [x] **Single date palms**: `trunksByVariant: [3, 2, 1]` — the date-grove
      slot's variants are a clump of 3, a pair and a lone palm leaning hard.
- [x] **Oleander** on the wadi banks (the cane-clump builder + new
      `flowers`: pink clusters at the cane tops, kept on the far level).
      First pass read as pink flowers on sticks; now denser, darker, smaller
      flowers. **you**: judge the size/density at play zoom.
- [x] **Tamarisk** behind the oleander and round the oases (grey-green).
- [x] **Prickly pear** hedges round the hamlets — a new builder
      (buildOpuntia: tiers of flat oval pads from pad rims).
- [x] **Dev → Fog = nam's** (you): Model (Analytic / Valley band / Monsoon)
      with each model's own rows, Height fog, Color, Dist. fog, Dist.
      density; Post-FX section as nam's. Weather presets and Fog banks stay.
- [x] **Wind on the ground plants** (you: reeds and oleander were frozen):
      the engine ships foliage wind OFF ("judged at rest"); the map now turns
      it on (algVegetation.mjs), and the game's one wind (algWind.js) now
      drives the grass/plant wind too (new `app.setWind`). Flags, windsock and
      plants agree.
- [x] **PERF PASS 2026-09-27** (you: "optimize until 5 iterations < 5%"):
      report in the session; bench = games/alg-rts/perfBench.js (7 views,
      frame time at 2x). 368.1 → 342.2 ms summed (−7.0%), CPU 28.5 → 23.6 ms
      (−17%). Kept: bloom OFF (it drew nothing — nothing emissive yet;
      re-enable with the first tracer), fog-bank pass unhooked while the banks
      are off, unused terrain features compiled out (riverSand, grassFar,
      flowerTint), stats-gl overlay off in the game (was ~20% of the main
      thread; Dev → Performance to show it), clipmap drawn nearest-first.
      Tried, no gain, reverted/kept off: biplanar cliff (engine opt-in, off),
      plant shadows off, far-tile fade. FOUND: the terrain paint shader is
      ~70% of every view (hiding it → vsync); all 6 layers are painted. The
      real next step is structural (index-blended splat, TODO below).
- [ ] **Terrain: index-blended splat** — store the top-3 layer ids + weights
      per texel so the shader does 3 layer taps whatever the count (see memory
      proj_v3_terrain_only_static_taps). The one lever left that is big.
- [x] ~~Heading-dependent cost~~ — a MEASURING error (vsync-quantised rAF,
      a second tab open, the GPU timer). Measured properly (30 renders back
      to back, one tab): the spike was the ATLAS CEDARS, 10–14 ms at the
      massif; terrain a steady 3–4 ms everywhere.
- [x] **Cedar fix: depth pre-pass for cut-out leaf cards** (engine,
      FoliageScatterSystem `depthPrepass`, `startV3App({ foliageDepthPrepass })`,
      default off; this game on, `?prepass=0` to A/B). Cause: the cut-out
      (discard) turned off early depth, so every hidden card was fully lit.
      Now an unlit depth pass, then colour depth-EQUAL. MEASURED 1919x888,
      scene only: cedar massif 20.7 → 6.6 ms; base 6.6→6.3, oasis 7.4→6.3,
      hills 7.8→6.5, wadi/aln 5.7→5.0, zoom-out 7.2→6.3. Image identical
      (0.001% px, frozen plants). Offer it to nam (palms, jungle).
- [ ] Re-measure the earlier perf-pass changes with the correct method.
- [x] **Tracks** (2026-09-29, tools/algTracks.mjs → games/alg-rts/tracks.js):
      the PISTE out of the post's gate (beside the sandbag chicane), past the
      oasis to Mechta Ouled Ali, over the Oued Tighanimine at a ford to
      Mechta el Oued, and west along the valley floor to the dechra (~600 m);
      MULE PATHS dechra → koubba, dechra → west gully mouth → katiba, Ouled
      Ali → east gully mouth → katiba (~800 m). ROUTED by A* over the real
      ground (a truck holds ≤ ~12% on the flat, fords at the fords; a mule
      climbs), round every placed piece, branches riding the trunk; a guarded
      simplify (a straight run only where it is itself a legal move — the
      unguarded one cut down a wadi bank at 235%). PAINT: slot 6 (was the
      unused Snow, same textures bound → no sampler added) = "Dirt track",
      dry_mud_field_001 tinted pale; DECALS: 104 photographic ruts / foot-worn
      paths baked on the same dust photo (decalPhotoArt `photo`/`tileM`
      overrides), laid along each 10 m chord, none on tight bends, uneven
      strength and gaps (full-strength ruts read as rails). Vegetation keeps
      slot 6 bare (algVegetation.mjs). Minimap draws them (piste pale, mule
      paths dashed). The ALN's ROAD AMBUSH: French on a track → the band lies
      up 15-45 m off THAT track (measured 19/20 and 15/20 spots in the band).
      Plan: `node tools/algPlanView.mjs --layout games/alg-rts/layout.js --view play`.
   - [ ] **you, look**: the piste's colour (a smooth tan band — paler?),
         the ruts' strength, the mule paths (faint by design).
   - [ ] Telegraph poles along the piste (a kit piece; the post's radio
         mast is the only wire today).
   - [x] (2026-09-29, algPatrols.js + algMines.js; the sapper still open) Patrol order ALONG a track; convoys (GMC) on the piste; ALN mines
         on it (the sapper); donkeys on the mule paths.
   - [ ] Tracks are paint + decals only: no grading. A cut bench where the
         piste crosses a slope, if vehicles look wrong on the tilt.
- [x] **Village dressing** (2026-09-29, rtsAlgVillage.js, placed in
      showroom.js GARDENS): walled GARDENS (dry stone chest high, a gate with
      two post stones and a thorn bundle, cleared stones heaped in a corner,
      olives in loose rows / figs / mixed, a prickly-pear hedge outside the
      back and one side) ×5; almond TERRACES (dry-stone retaining walls along
      the contour, as high as the slope makes them, a row of trees per step,
      turned to climb straight uphill) ×4 — three round the dechra, one
      above Mechta el Oued; THRESHING FLOORS (a paved earth dome, a kerb of
      stones on edge, a straw heap and a fork) ×3; the wells' troughs ROUGH
      stone now (and the zeriba's); the dechra's two end lanes are STAIRS
      (risers + paving, the first try read as a ladder) and some lower-row
      houses have walled COURTYARDS (a tabouna, jars, or a fig). Spots
      MEASURED (clear of pieces, tracks, wadi beds, oases; relief / slope).
      Trees are PLANTED, not painted: a piece lists `userData.trees` / `hedge`
      and the game puts them down with placedFoliage.js (new presets olive,
      fig, almond; 60 trees, 87 prickly pears). NAV: `userData.navRects` —
      terraces and floors walkable, a garden's walls block and its gate lets
      men in. Both z-fight tests pass; 197/197 suites green.
   - [ ] **you, look**: olives (second pass: smaller, airier, trunk showing),
         figs, almonds; the threshing floor's paving (second pass: bigger
         slabs); the straw heap (reads a bit like a beehive hut?).
   - [ ] Terraces are walls on the untouched slope: grade each tread flat
         (a terrain edit) if they read wrong close up.
   - [x] **Cover from walls and ground** (2026-09-29): pieces list their
         walls (`userData.coverLines`, algCover.js) — gardens, terraces, the
         dechra's yards: HARD cover along the wall, not over the plot; the
         threshing floor none (was a false outline). TERRAIN cover (shared
         cover.js `terrainCover`, alg 0.5, nam off): the ground toward the
         shooter rising into the line of fire, sampled to 10 m — a man in a
         wadi bed 0.5 from the plain, 0 from a man on the bank above him, 0
         along the wadi (measured). Random 50 m shots over the play box:
         31% find cover (12% walls/buildings, the rest the massif's banks
         and gullies). The overlay (V) and the ALN's spot scoring see banks.
         Command card: the HARD / LIGHT COVER and CONCEALED chips.
   - [x] **Tracks at war** (2026-09-29): PATROUILLE (algPatrols.js, a
         command-card button): the nearest track in file (vehicles the
         piste), to the end and back, fights and resumes, any order ends it —
         measured 4 men within 4 m of the line, 2-5 m apart. CONVOI: a GMC
         on patrol through a French-held village delivers +30 (flash on the
         supply strip). MINES (algMines.js): the ALN's "mine" mission (~30%
         of bands) lays one on the piste far from the French (measured on the
         dechra piste, 284 m out); a vehicle over it sets it off (a GMC dies,
         a half-track limps); infantry spot it (a red stake) and clear it in
         5 s — measured spotted in 2 s, cleared by 8 s, nobody hurt.
   - [ ] **you, play it**: patrol + convoy + a mine; is 30 a delivery and
         30% of bands mining the right pace?
   - [x] **Flocks on the move + donkey trains** (2026-09-29, algHerds.js,
         shared wildHerd.js "anchor"): each flock has a MOVING HOME that
         walks a loop round its village on a sheep-legal foot path (the
         pasture, other grazing, down to the well — 4 of 5 flocks drink;
         Ain el Oued has no well in reach), resting 1-2 min at each; the
         animals keep their places round it (goats in front), catch up in
         bursts, trot when far, follow the home's breadcrumbs round houses,
         sidestep what's in the way, regroup after a bolt. Measured over 8
         minutes: median 6-7 m from their place, worst 32 m, none lost (the
         first version lost whole flocks 100 m back — five separate causes,
         each measured). A DONKEY TRAIN on each ravine mule path: a loaded
         donkey on the lead, a bare one 3.4 m behind, up to the gully mouth
         and back, resting at the ends. nam's wild herds unchanged (checked).
   - [ ] **you, look**: the flock's pace (0.45 m/s home, rests 1-2 min),
         goats leading; the trains (the west one walks under the cedars at
         the koubba, hard to see).
   - [ ] A shepherd with each flock (a civilian stand-in until yours);
         scatter at gunfire / blasts, not only soldiers close; a goat on a
         mine; bells.
   - [ ] A mine's minimap mark once spotted; the sapper (clears faster,
         finds from further); the ALN laying mines on the mule paths too.
   - [ ] Attack orders don't end a patrol (it resumes after the kill) —
         right for CoH, say if not.
   - [ ] GPU cost of the dressing: A/B said −0.07 ms, but the frame read
         0.58 ms total (this view is normally 5-7) — re-measure in a focused tab.
- [ ] Doum: fix its far LOD (flat green mats) and paint it back.
- [x] **Villages** (v3/render/objects/rtsAlgVillage.js, 2026-09-27):
      DECHRA (4 terraced rows of Chaouia houses — the mechta's own `house()`
      — each on a stone socle down to the real ground; a whitewashed mosque
      with a square minaret mid-village; a stone lane up the side), KOUBBA
      (white cube, octagonal drum, dome, iron finial, green door, jars;
      a whitewashed court wall that steps with the ground), CEMETERY (low
      mounds with stone borders, upright head- and footstones, all graves
      turned toward Mecca — qibla ~108° from the Aurès), WELL (curb, forked
      posts, pulley, bucket, troughs, jars), ZERIBA (a tangle of grey thorn
      branches, the gap, trough, fodder). All pass both z-fight tests.
      Builders take `groundAt(x, z)`: the showroom's new `ground` mode seats
      each house/grave/branch on the real slope, no pad, no tilt.
      SITES MEASURED: dechra (-224, 136) on a 17° slope rising straight away
      from the player's camera; koubba on the crest 28 m above (-273, 86);
      cemetery beside it; pens clear of every piece and off the wadi bed.
      First siting was wrong: I had the camera direction reversed (the slope
      faced away from the player).
- [ ] **you, look**: the dechra, the koubba and its cemetery (Dev →
      Showroom → Go to). Taste: house density, the minaret's height.
- [x] (2026-09-29) Well troughs are plain blocks — make them rough stone.
- [x] (2026-09-29) Dechra: stepped lanes, a few courtyards. [ ] Laundry still open.
- [x] **The kit atlas stayed GREY — caught and fixed** (2026-09-27). Seen
      again live: the whole atlas canvas was still the placeholder, yet the
      worker's promise had resolved with no error, so the worker handed back a
      BLANK bitmap (its canvas under the boot's GPU load, most likely).
      rtsAtlas() now checks the pixels that landed (one read of a 4x6
      downscale, a pixel per cell) and, if blank, builds the atlas on the
      main thread instead. Fixes nam too (same atlas).

## SUGGESTIONS — look & world (not gameplay) — ranked, 2026-09-27

**1. Fill the map (the biggest visual gap: it is bare ground now)**
- Palms, several trunk SHAPES (you): straight, leaning, CURVED (the trunk
  bending up out of a lean, as date palms do by water), clumps of 2-4 from
  one root, young ones with the old frond skirt still on. Date palms in the
  oases and wadi floors, Canary palms planted at the post and the SAS post,
  doum palms as scrub on dry slopes (the doum's far LOD is still owed).
- Atlas cedar on the heights (the Aurès's signature: the Belezma and
  Chélia cedar forests), Aleppo pine and holm oak lower down.
- Oleander along every wadi — pink in flower, the most recognisable line
  in a dry Algerian valley. Tamarisk in the wadi beds.
- Prickly pear hedges round the villages and gardens; fig and olive trees
  in walled gardens; almond on terraces.
- Alfa (esparto) grass steppe on the open slopes; juniper and lentisk scrub.
- Villages: more mechtas and a DECHRA (a stone village climbing a ridge,
  flat roofs stepping down), terraced gardens, a KOUBBA (a marabout's white
  domed tomb) on a hilltop — the one white thing that isn't French — a
  cemetery of upright stones, threshing floors, a well with a trough,
  zeribas (thorn-brush animal pens).
- Animals: goat and sheep herds with a shepherd (they move, graze, flee
  shooting), donkeys and mules (packed), dogs at the villages, a few camels
  on the plain edge.
- Birds: storks nesting on the koubba and the SAS roof, kites and vultures
  circling high (their shadows cross the ground), ravens on the cliffs, a
  flock of sparrows flushing from the gardens. nam's bird system carries
  over.

**2. The ground itself**
- The shiny rock layer (above).
- Tracks: the French piste between the post and the hamlets (dust, ruts,
  telegraph poles along it), footpaths up to the ALN's side.
- Dry-stone terrace walls on the gardened slopes.
- Decals: wheel ruts, animal tracks, spent-case scatter and scorch at
  positions, dark stains under drums.

**3. Air and light**
- One shared WIND for flags, windsock, smoke, dust (above).
- Dust devils crossing the plain now and then; heat shimmer over the far
  ground at midday; dust kicked up behind every moving vehicle.
- Smoke from the mechtas' cooking fires in the morning and evening.
- Cloud shadows crossing the ground (the engine has them, opt-in).
- The sandstorm (already on the list).
- Night: stars, searchlight beams sweeping from the post, the villages'
  lamp-lit doorways, flares.

**4. Sound (ambience, not gameplay)**
- Wind over the ridges, cicadas in the heat, goat bells, dogs in the
  villages, the searchlight generator's hum at the post.

**5. Finish**
- The black band under the horizon at very high orbit (on the list).
- A far LOD for every placed asset, and the impostor for the doum.

## Decisions so far

- Same style as nam-rts for now (may change later). Same engine, same editor.
- **Terrain first.** The first map is Aurès country (red rock, cedar, dry
  riverbeds): it's the region most unlike Vietnam, and where the war began on
  1 Nov 1954. Kabylie comes second.
- Maps are cut from **real elevation**, then eroded and painted in the editor.
- Same world size and scale as nam-valley (1024 m map, MAX_HEIGHT 250,
  RTS_SCALE 1.3 for units and man-made things, nature real), so the camera,
  vegetation distances and unit sizes carry over unchanged.
- Treat the history seriously: no atrocity as a game mechanic, civilians are
  people rather than resources, show consequences through the story.

## Session 2026-09-26 (you away): what was done

- [x] **Shared camera**: games/nam-rts/namCamera.js → games/shared-rts/rtsCamera.js
      (git mv, unchanged). nam imports it from there; verified nam boots and
      the camera works. First piece of the shared RTS core.
- [x] **The game page**: games/alg-rts/alg.html + algGame.js (vite input
      `algRts`). Boots in ~4.5 s: nam's settings (fitted shadow, lean terrain,
      top-3 + far tiling, terrain drawn last), the Aurès map, the shared camera.
      No gameplay. `?light=flat` `?fog=0` `?showroom=0`.
- [x] **Light and sky**: Atmosphere sky (`skyMode: "atmosphere"` must be asked
      for at boot, or setWorldLight does nothing), real latitude 35.2°, mid-July
      15:12. Measured: mean luma 57-76 → 118-140, near-black 9-21% → 0-3%.
      Dust haze matched to the horizon.
- [x] **The plain outside the map**: new engine call `app.setGroundBase({
      baseColor, lineColor, ao })` (runtime, not saved). Matched by eye to the
      textured soil: #a39480.
- [x] **Atlas cell 19 = dry-stone rubble** (`MAT.rubble`, the LAST free cell):
      ragged limestone blocks, deep earth joints, chinking. For the post, the
      mechtas, terraces.
- [x] **Stencil sheet 1024 → 1024×2048**: the old half untouched; the new half
      holds France: tricolour, cockade, "POSTE DE TIGHANIMINE" board, vehicle
      plate, ARMÉE DE TERRE ×2, unit code, helicopter serial, S.A.S. board,
      and two fallen-plaster patches (drawn with the rubble surface).
- [x] **French post (HQ)** `v3/render/objects/rtsFrenchPost.js`: bordj-style
      walled square (28.6 m ×1.3), rubble footing, whitewash, merlons,
      loopholes, wall-walk, two towers with sandbagged MGs, arched gatehouse
      with the name board and a painted tricolour, barracks, command post,
      radio mast, flag, stores, water tank, sandbag chicane, double-apron
      wire. 13.7k tris, one draw + markings.
- [x] **Panhard EBR** `v3/render/objects/rtsVehiclesFr.js`: symmetric boat
      hull, 4 tyred + 4 steel wheels (roll with the odometer), FL-11 turret
      with the long 75 mm, stowage, both drivers' stations; plate, turret
      tricolour, roof cockade.
- [x] **French paint**: `rtsObjectMaterialTinted(FR_PAINT_TINT)` tints only the
      painted surface — US olive drab went lime in the Aurès light.
- [x] **Showroom** games/alg-rts/showroom.js: new assets placed on the map
      under the real light (post at 40,150; vehicles by the gate; hamlet at
      150,60; plants on the massif and round the post). Temporary.
- [x] **Willys MB jeep** and **GMC CCKW 353** (rtsVehiclesFr.js): jeep with
      folded windscreen, .30 on its pedestal, driver + gunner, plates; GMC
      with banjo wings, closed cab, duals, canvas tilt on its bows.
- [x] Rolling gear tinted too: `rtsRunningGearMaterial(paintTint)` (the US
      default is unchanged).
- [x] **The mechta** (v3/render/objects/rtsMechta.js): 10 Chaouia houses in
      attached rows along a lane, rubble walls, earth roofs with parapets,
      beam ends under the eaves, limewash/mud skins, some second storeys,
      lean-tos, yards with dry-stone walls, a tabouna oven, jars, a threshing
      floor. 4.4k tris, one draw.
- [x] **Aurès vegetation** (FOLIAGE_PRESETS): `atlasCedar` (new builder
      cedarGeometry.js: forked trunk, tiers of level plates; new card
      cedarNeedleTexture.js: sprays of needle rosettes combed out along the
      branch), `holmOak`, `juniperScrub` (the dipterocarp builder, domed /
      shrub-sized), `alfa` (blades). Hand-placed via PlacedFoliage for now;
      the map's paint slots are untouched.
      Rejected on the way: round clump cards on the cedar (read as green
      coins), the bush builder for scrub (90 tris, invisible at 1.6 m), the
      first holm oak (a bright savanna tree on a pole).
- [x] Verified after all engine changes: nam-rts boots, clean console, its
      stencils (Quonset star) intact; alg page clean console; boundary test
      and fast lane 196/196 green.

- [x] You looked (2026-09-26): "look nice, continue".
- [x] **Cedars tiered**: 5 tiers, flat cards (8°), each shelf lit on top and
      dark to its rim. From the side: the Atlas cedar's stacked shelves.
- [x] **Holm oak / scrub**: new `crownDepth` key on the dipterocarp builder
      (default 0.6 = unchanged); oak 1.25 = round crown down to head height
      (was an acacia on a pole), scrub 1.1 and twice the foliage.
- [x] **Alouette II** (rtsVehiclesFr.js `buildAlouette`): glass bubble with its
      frame, bare Artouste turbine, open triangular lattice boom with the
      drive shaft, fin + stabiliser, 3-blade main and tail rotors (spinning in
      the showroom, the Huey's rotor contract), skids, stretcher panniers.
      `blade` added to VEHICLE_KIT.
- [x] **AMX-13** `buildAMX13`: low hull, engine louvres + driver front, 5 road
      wheels, front sprocket, rear idler, return rollers (shared `trackSide`
      helper), FL-10 turret set back with the long 75 mm and its bustle;
      turret contract as the M113 (turret geo + pivot + muzzle).
- [x] **M3 half-track** `buildHalfTrack`: roller, armoured bonnet, wheels +
      rear track unit, open armoured box, .50 on its ring, crew, mine racks.
- [x] Checked: clean console, boundary test + fast lane green.

- [x] **C key** = RTS camera ⇄ free orbit on this page (was only bound in
      nam's dev panel), matched on `e.key` for AZERTY.
- [x] **Alouette II rebuilt from ALAT photos** (your "looks really bad"): a
      lofted teardrop cabin, solid lower nose + see-through glass (own
      material, crew visible), frame bows and hoops, the box centre body,
      the uncowled Artouste with its big exhaust on top, an N-truss lattice
      boom, hoop tail skid, long low skids with arched cross tubes, dark
      ALAT olive, white serial + cockade + ARMÉE DE TERRE.
- [x] **Palms**: `datePalm` (oasis), `canaryPalm` (avenue/post gate),
      `doumPalm` (dwarf fan palm on the slopes). First date palm was a spiky
      pompom on a pole: now 46 long arching fronds. Doum was trees on sticks:
      now low fan clumps.
- [x] **Oasis** (tools/algOasis.mjs): a lobed basin carved in the valley floor
      at (132, 128), a lake 1.5 m under the rim, grove ground (grass_ground,
      Poly Haven) feathered round it; date-palm clumps, reed-mace at the
      edge. Water tuned for a small pool: depthDistance 20 → 3.5 m (at 20 the
      shallow pool read as SAND), a silt bed, faint caustics. Map backed up
      before the carve (scratchpad alg-aures.pre-oasis.v3proj).
- [x] Budget at play zoom with everything placed: 77-97 draws, ~680k tris,
      CPU ~2 ms (nam-valley: ~176 draws). Clean console; tests green.

Asset follow-ups:
- [ ] **STONES that match the stony ground** (you, 2026-09-29, after the
      oasis): loose rocks and stone scatter on the map whose colour and grain
      are the ground textures' own (gravelly_sand scree, rock_boulder_cracked
      limestone, the valley soil's pebbles), so they sit IN the ground instead
      of on it — placed where those layers are painted (scree slopes, ridges,
      wadi banks). The kit's fieldStone is limestone-grey and reads foreign.
      Also: a broken gravel SHOULDER along the pistes (the stones a wheel
      pushes aside) — as stones, not paint (algTracks only owns slot 6).
- [x] **Animals at unit scale** (you, 2026-09-29: "most of them are barely
      visible"): sheep, goats and donkeys 1.3x like the men (algHerds.js
      `S = RTS_SCALE`), and every length with them — walk/run speeds (the
      clip stride), flock spread, roam, the goats' lead, tied donkeys' gap,
      the train's spacing, the flock's pace. Seen: a donkey's back at a
      soldier's chest; the flocks read at play zoom. shared wildHerd.js and
      nam-rts untouched. Next if still hard to see: contrast (fleece/coat).
- [x] **KSAR EL HAMRA** (you, 2026-09-29, a photo of Ghardaïa): a M'zab-
      style plastered town up the one clear knoll in the play box (-10,-120),
      ALN-leaning, the 4th village (50/min; held from its SOUK, layout.js
      sitePoint — the town itself blocks the nav). rtsAlgVillage.js
      buildKsar: 56 houses in rings, walls running down the slope (the
      stacking), parapets with horns, roof rooms, palm shades; the mosque and
      a 25 m tapering minaret on top; an arcaded souk (extruded arches, dark
      galleries, merlons, lanterns), square, fountain, 3 palms, stair lane.
      Two new atlas plasters (MAT.plaster 22 ochre, plasterPale 23 cream —
      THE ATLAS IS NOW FULL). The souk stands on a `pad` (new showroom option
      for ground pieces). 12.7k tris, builds in ~160 ms; coplanar + ground-
      band tests pass (flat and knoll).
- [x] **Ksar, second pass** (you, 2026-09-29: "a perfect circle looks
      weird", palms inside the gate, the white circles not aligned):
      real M'zab ksour follow their rock, dense and labyrinthine — the town
      is now an irregular outline wide along the hillside (29 m each side,
      15 behind the mosque, 26 down to the souk, lobed), 64 houses packed
      at random wall to wall (oriented-rect test, a second pass of small
      cubes), each facing down the slope; winding alleys (the stair to the
      souk, two more out); no ring wall (it made a round fort). Overlapping
      neighbours whose flat faces met are lifted 2.3 cm (checked pair by
      pair). Palms in a grove OUTSIDE, never in the souk or over a roof.
      CAPTURE RINGS: centred on each village's placed footprint (the
      mechtas' sat off to one side), and shown only while men are selected
      or someone stands in one (CoH), not always.
- [ ] Ksar, next: YOU LOOK (colours, minaret height, density); a piste to
      it (algTracks ROUTES + --route); a stork on the minaret; donkeys and
      people in the souk; the square's facing (the right wing hides part of
      it from the play camera — turn, or open that wing).
- [ ] **What next — environment / buildings / vehicles** (proposed
      2026-09-29, your pick): stones matching the ground (above); a road
      network that reads (pistes to every village, a French tarmac road with
      milestones and a bridge); palm groves + seguias round the oases;
      the French side's colonial buildings (a farm/"ferme coloniale", a
      school, a gendarmerie in stucco and tile — rtsColonial.js is Indochina's);
      villages that LIVE (people at wells, laundry, smoke from ovens); damage
      states (burnt, collapsed houses after shelling); more vehicles (Dodge
      6x6, Jeep with recoilless, Piper Cub, H-21 "banane"); weather
      (sandstorm, night with the searchlight); sound for the ksar (muezzin, souk).
- [x] **The pistes looked flat and ruled** (you, 2026-09-29):
      1. The Dirt track is slot 6, and alg compiled `layerBudget: 6` (slots
         0-5): the tracks drew the flat base colour, NO texture at all. Now 7
         (`?layers=6` to A/B). MEASURED +0.11 ms GPU (1.235 → 1.348, one
         round each, same view).
      2. The straight band was the rut DECALS' halo on the exact centreline:
         opacity 0.7 → 0.45, each 10 m segment ±0.4 m sideways.
      3. The paint edge: two octaves of wobble (9 m, 2.2 m) and a fade
         thresholded by a 1.1 m noise, so stone bites in and dust spills out.
      4. Valley soil normal 0.5 → 1.0 (you: "bump normals a bit"); the
         pebbles now catch the sun. Set in the map only (it came from the
         editor, no tool owns it).
- [x] **A better-looking OASIS** (you, 2026-09-29): the ground round the
      water read as neither desert nor garden. tools/algOasisLook.mjs, per
      lake: slot 3 is now "Oasis grove" (forrest_ground_01, tint #f2f5e6)
      painted out to poolR×1.4+10 m with a noisy edge (never over wadi beds
      or tracks); grass only in the damp ring 2.5 m → grove edge, and it is
      nam-rts's grass ("far better", you): tools/algGrassFromNam.mjs copies
      nam-valley's system (revo) and its look; 24 + 17
      photo MUD decals (new `soil` source, textures/decals/alg/mud_*) along
      the waterline; the date grove denser
      and sized from the real pool radius (algVegetation `_poolR`).
      **Ain el Oued sat on the Oued el Abiod's bank** and its 51 m lake
      square flooded the dry bed: tools/algOasisMove.mjs refilled the old
      basin to the eroded ground, moved it to (-136, 352), lake fitted tight
      to the pool (31×35 m, level 3.92), 0 wadi texels wet.
      Order: algOasisMove → algOasisLook → algVegetation.
- [ ] Oasis extras: small walled palm gardens (the garden kit) and seguias;
      the grove's edge is still quite round from above — you, look.
- [ ] Oasis: a second one, and paint the lake params per map in the editor
      (all lakes in a map share one water setting).
- [ ] Put the plants into the map's paint (4 tall slots: cedar, oak, scrub,
      alfa) once the look is agreed.
- [ ] Post walls could use more weathering (grime under the merlons).
- [ ] Next assets: H-34 "Pirate" gunship helicopter, a French helipad,
      buildables (mirador watchtower, MG post) in the post's style, SAS post,
      olive grove + prickly pear for Kabylie, the ALN's side (cave mouths,
      a mountain hideout).
- [x] Soldiers: **you** make them (2026-09-26), as in nam-rts.
- [x] **Cloth flag** (your ask): the post's painted flag and pole removed;
      the post now reports `userData.flagMount` and the game plants the
      engine's Verlet cloth flag there (games/alg-rts/algFlag.js, the same
      createFlag as nam's baseFlag), with a drawn tricolour texture.
- [x] **Vegetation moved INTO the map** (step 2, 2026-09-26):
      tools/algVegetation.mjs writes the species into the map's plant slots
      and the density into its paint (derived from height, slope, the oasis,
      clear of the post / vehicle park / hamlet). Tall: cedar, holm oak, date
      palm, juniper scrub. Ground: alfa, reed-mace. The showroom only places
      the two Canary palms at the gate now. Verified in the editor: slots and
      paint load from the file.
      First pass was a forest (GPU counter ~12 ms in a close view): densities
      cut to Aurès sparseness (~6 ms same view). Map backed up first
      (scratchpad alg-aures.pre-veg.v3proj).
- [ ] Doum palm: out of the painted field — the fan-palm builder's far LOD
      draws it as flat green mats. Fix the far LOD (or a card) and repaint.
- [ ] The stats overlay's triangle count reads ~2 billion since the tall
      field went in (a counter artefact of indirect draws? unverified; the
      frame holds 60 fps).
- [x] **Step 3, the layout** (2026-09-26) — games/alg-rts/layout.js, plan
      image games/alg-rts/layout-plan.png (`node tools/algPlanView.mjs
      --layout games/alg-rts/layout.js --out ...`): French at the post (valley,
      south-centre); ALN camp high in the NW massif (-350, -315); objectives:
      2 hamlets, 2 oases, 2 gully mouths (the ALN's ways down), cedar spring,
      ridge watch. Sites moved to the flattest ground nearby (relief ≤ 8.5 m).
- [x] **Wadis** (tools/algWadi.mjs, from the layout): Oued Tighanimine 600 m
      north of the hamlet, Oued el Abiod 634 m in the south-west; beds forced
      downhill, 42° banks (past the 34° nav limit), 3 fords each at 16° —
      the valley's chokepoints. Bed painted slot 4 (dry_river_pebbles).
- [x] **Second oasis** "Ain el Oued" (-120, 330) r16, in the southern wadi's
      bed (a guelta). Second hamlet placed. Vegetation re-run: clearings now
      from the layout, nothing on the wadi beds, palms at both oases.
      Map backed up before the carve (scratchpad alg-aures.pre-wadi.v3proj).
- [x] **Starts on the long diagonal** (your question, 2026-09-26: "shouldn't
      they be opposite?"): French post moved to the SE ridge bench (305, 345),
      25 m up, gate facing NW; ALN stays in the NW massif; ~930 m apart (was
      ~600 m with the post near the centre). Objectives rebalanced by
      distance: 4 lean ALN (cedar spring, both gully mouths, new Kef lookout),
      4 lean French (both oases, both hamlets), 1 middle (new Col de l'Ouest).
      The post's vehicle park / helipad / gate palms now follow the post
      (showroom.js BASE_PARK, post-local). The camera starts on the base
      facing the enemy: new `rtsCamera.setYaw` (shared camera; nam unchanged).
- [x] **Facing rule** (your correction, twice): buildings turn their fronts
      toward the player's camera at THREE-QUARTERS — ~25-45° off, never
      square-on, never away (Company of Heroes). layout.js: `VIEW_YAW` + a
      per-site `turn`, `siteYaw(site)`. The post's park moved to its flanks.
- [x] **ALN command post** (v3/render/objects/rtsAlnCamp.js, 3.3k tris, one
      draw): the stone house they took over (rubble, earth roof heaped with
      brushwood), a cave in angular limestone blocks behind it (timber
      lintel, sacks), a log-roofed dugout, three stone sangars with guns, a
      stores lean-to, cooking fire, radio aerial; the FLN flag as live cloth
      (algFlag.js drawFlnDataUrl). Placed at the layout's ALN site; HQs 930 m
      apart.
      Rejected on the way: the first rock was one smooth dome (a loaf of
      bread) — now a cluster of flat-faced blocks.
- [x] **Z-fighting in the committed assets fixed** (post, mechta, ALN camp,
      all French vehicles): both kit tests now cover this game
      (rtsPropsCoplanarTest, rtsGroundBandTest). New tool:
      `node tools/rtsCoplanarWhy.mjs <module> <builder>` names the PART
      pairs behind an overlap (rtsParts ASSEMBLE_TRACE). Wire/masts/braces
      use `wirePart` (round, per-strand twist — same-roll boxes coplanar).
- [x] **Buildables, first four** (v3/render/objects/rtsAlgeria.js):
      sandbag wall (5 courses + firing step), barbed wire (double apron +
      ONE continuous concertina coil — separate rings read as a toy), mirador
      (9 m, braced legs, plank cabin, searchlight, MG), MG nest (berm, bag
      ring, half-roof; gun its own mesh on a pivot to traverse). Shown in
      the showroom round the post.
- [x] **Floating pieces fixed** (you saw them): every pad's rim reshaped
      the ground under the pieces seated before it (bags 1.1 m up, the
      post's wire 0.3 m). Now all pads first, then seat; pads get +1.5 m
      margin; bags, wire and vehicles lie ON the slope (plane fit, lowest
      corner decides), no pad. Measured: nothing floats > 7 cm.
      **Build-system rule:** a pad + rim must not reach another pad.
- [x] Vehicles on bumpy ground sank a wheel (the tilt was the terrain normal
      at the centre). shared-rts unitRenderer: the ground under the four
      wheels (wheelbase from the unit radius), the body fitted to them and
      lifted until no wheel is under ground. MEASURED at 1702 spots, a
      4.6 m vehicle: worst sink 4.39 m → 0, mean 0.24 m → 0 (2026-09-29;
      nam's vehicles too — same machinery).
- [x] **Dev panel** (your ask): games/alg-rts/devPanel.js on a SHARED shell
      (games/shared-rts/devPanelShell.js — frame, folding sections, row
      helpers; nam's panel untouched). Sections: Camera, Light (live, Copy →
      AURES_LIGHT), Haze & bloom, Showroom (go to / hide), Performance
      (render scale, GPU pass timings). `?dev=0` hides it.
- [x] **Grey-then-textured at load fixed** (you saw it): the kit atlas is
      painted in a worker; the game now starts it first and holds the
      loading screen until it lands (algGame.js, rtsAtlasReady).
- [x] **Helipad, motor pool, mortar pit** (rtsAlgeria.js, 2026-09-27):
      helipad = graded bed, cement square + painted H, whitewashed stone
      border, windsock, fuel drums behind bags; the Alouette stands on it
      (showroom `on`). Motor pool = open steel-truss shed, corrugated roof +
      back wall, whitewashed workshop ("ARMÉE DE TERRE"), inspection ramps,
      chain-hoist gantry over an engine, bench, tyres, drums, jerrycans.
      Mortar pit = 81 mm Brandt (own mesh, traverses) in a lumpy spoil berm,
      bag parapet, ammo, red/white aiming stakes. 3.4k / 8.8k / 3k tris.
- [x] **Atlas row six: `MAT.spoil`** — dry ochre earth with pebbles, for
      berms, pits and graded ground (the kit's earth is dark Vietnamese mud:
      it read as a brown square on the Aurès). Cells 21-23 free. Berms are
      now irregular smooth heaps (earthBerm), not turned pots; the MG nest's
      too, and both bag rings closed (they had gaps).
- [x] **ALN buildables** (rtsAlgeria.js, 2026-09-27), the other side's
      language — low, stone and brush, never white: cave entrance (rock
      shelter, shored mouth into the dark, brush over it; 3.5k tris), arms
      cache (a matmora grain pit, lid aside, crates, rifle tripod, the
      guard's gourbi; 4.2k), sangar (dry-stone C, brush on the lip, FM 24/29
      on its own pivot; 2.6k), ambush screen (cut scrub in a stone footing
      between rocks; 3.3k), mine marker (turned earth + a three-stone cairn).
      Shared helpers: dryStone (courses of field stones along a path),
      crag (big rocks: noise + bedding, faceted), brushClump (lumps + bare
      twigs). Shown round the ALN camp on its gentle flanks (MEASURED: the
      camp is a hilltop, its front too steep).
- [x] **Atlas cell 21: `MAT.limestone`** — one stone's face, warm buff-grey.
      The rubble cell is a wall (its joints went black on single stones) and
      the Khmer sandstone read olive. The ALN camp's rocks moved to it too.
- [ ] **you, taste**: the brush — green lumps + dry bundles + twigs — and
      the stone colour. Judge them at play zoom.
- [ ] **Next buildables**: searchlight tower, SAS post (still **you**:
      forward base or not?).
- [ ] Very high orbit views show a black band under the horizon (the env
      bake's black lower hemisphere, ref_v3_env_bake_black_floor); not seen at
      play zoom.
- [ ] **you**: a second French outpost (SAS post) north of Oued
      Tighanimine, as a forward base?
- [ ] **LATER — sandstorm** (your ask, 2026-09-26): a weather event —
      wall of dust rolling in, haze thickening to a brown-out, wind-driven
      dust sheets, the light going orange and flat; gameplay: sight ranges
      shrink, helicopters grounded. Candidates: the engine's fog + smoke
      flipbooks + a dust-particle layer.

## MAP SCALE — a Company of Heroes-sized battle (your call, 2026-09-28)

- [x] The terrain was fine; the BATTLE was too big: the starts ~930 m apart
      on the diagonal, units at 11 m/s (a sprinter), 82.5% of the ground
      bare. Now:
      · the starts moved IN along the same diagonal, ~470 m apart
        (layout.js), sites MEASURED: the post on the valley floor 95 m from
        the oasis (1.2 m relief over its pad), the katiba high in the broken
        ground (51 m up); the line turned 7°, buildings still 3/4 on;
      · a PLAYABLE AREA, 610 m (layout.js PLAY): the camera (shared
        rtsCamera.setBounds), the paths (four blocked strips in the nav
        grid) and the minimap (it frames the box) stay in it; the terrain
        outside is scenery — the Kef, the Col, the far corners;
      · CoH speeds: appelé 5.5 m/s, moudjahid 6, Willys 12, EBR 13,
        half-track 10, GMC 9, AMX-13 8.5, Alouette 24;
      · the vegetation re-baked (tools/algVegetation.mjs) so nothing grows
        on the new sites; every piece round both starts checked: pads
        level, dry, no trees.
      Measured: a band from the cave to an ambush on a patrol 120 m out of
      the post in ~52 s (was ~72 s at a sprint over twice the ground).
- [ ] Mark the out-of-bounds ground (CoH darkens it) — now it only stops
      the camera and the men.
- [ ] A move order outside the box: go to the nearest point inside (now the
      man holds, the path having no route).
- [ ] Fill the box densely (scrub along the wadis, terraces and orchards
      round the villages); thin the vegetation OUTSIDE it (frame time).
- [x] (2026-09-29, `--view play`, tracks drawn) tools/algPlanView.mjs: redraw the plan image with the new layout.

## ECONOMY — first cut in (2026-09-28, algEconomy.js), per the proposal below

- [x] Two purses: the French **Ravitaillement** (start 400) and the ALN's
      (start 240). Income: the French 40/min from Algiers + each village
      they hold (mechta 25, dechra 40); the ALN 15/min + each village it
      holds + 15/min per standing ARMS CACHE (burn them, the katiba starves).
- [x] The VILLAGES (both mechtas, the dechra) are the points: an influence
      meter −1…+1 that MEN ON FOOT within 40 m push their way (up to 3
      count; both there, the stronger pushes), drifting to neutral when
      nobody is there; held past ±0.6, lost back through 0. Tested: 4
      appelés at Mechta Ouled Ali — 0.30 at 5 s, held at 10 s, income
      40 → 65/min.
- [x] Every unit COSTS, charged when queued, refused if the purse can't pay
      (appelé 60, Willys 90, GMC 110, half-track 160, EBR 220, AMX-13 260,
      Alouette 320; moudjahid 40 from the ALN purse — the AI's bands are
      only as big as it can pay for, refunded if under 3).
- [x] Shown: the supply strip (Ravitaillement · +/min · villages n/3 · ALN
      n), prices on the production buttons (greyed when short), a ring
      round each village in its holder's colour, the minimap's diamonds.
- [x] **THE GÉNIE SAPPER + BUILDING PLACEMENT** (2026-09-29, algBuild.js):
      the post trains SAPEURS (80); a sapper's card offers sandbags 20,
      wire 15, MG nest 90, mortar 130, mirador 110, searchlight 60. The
      ghost is the piece itself, green/red (why: out of the play box, water,
      blocked, too steep > 18°, no supplies — algBuild.why); R turns it 45°,
      Shift-click keeps placing, right-click/Esc cancels. Placing pays,
      levels a pad (pits, towers) or lays the piece ON the slope (bags,
      wire), blocks the nav, clears the plants, lays a foundation; sappers
      at the site raise it (two 1.4x as fast). Done: a structure like the
      rest (algStructures.addBuilt: fights, sees, picked; live lists now),
      cover re-baked (bags: hard). The post STARTS BARE (?defences=1 = the
      old pre-placed set). Tested: nest + bags placed, paid 110, both up in
      ~15 s, the nest in the structures, cover 1.0 behind the bags.
- [x] **The storks in the fields WALK** (2026-09-29, shared bird kit — see
      nam's TODO): legs stride, head bobs, feet don't skate; ~0 GPU.
- [x] **THE PROJECTEUR WORKS AS A SEARCHLIGHT** (you, 2026-09-29;
      algSearchlight.js): every searchlight tower (pre-placed or a sapper's)
      sweeps ±63° in front, and when the beam passes near an ALN man
      within 75 m it LOCKS on and follows him; whoever stands in its 6 m
      pool is SPOTTED (cover.reveal: scrub hides nobody) and the pool sees
      through the fog of war. No real light: an additive cone (soft edges)
      + an additive disc on the slope; faint by day, full at dusk. The drum
      tips and turns to its aim. Tested: locked 6.5 s after a man appeared
      in front, pool 0 m off him, revealed the whole time. GPU: on 2.036 /
      off 2.040 ms (noise).
- [ ] **DUSK/NIGHT IS BLACK**: setTimeOfDay 19.3 (sun 0.05 up) renders the
      whole world black (not the searchlight — measured without it). The
      night item needs real dusk/night light (moon, ambient) before the
      searchlight can be judged at night — you, look then.
      DECIDED (2026-09-29): night lives in SKY PRO (you are building it in
      another session: moon light, ambient/exposure floor, twilight). When it
      lands: read its night amount (0-1) in algSearchlight.js instead of the
      sun's height, then lit windows / lanterns / mirador lamp off the same
      value.
- [ ] **DETAILS THAT COST ~NOTHING** (you asked for more like the projecteur,
      2026-09-29 — only if they stay near free: no dynamic lights with
      shadows, shared particle/decal fields, instanced):
      · Sappers at work: a dust puff and a spade/hammer swing while a site
        rises; a small tricolour on a finished mirador.
      · Barbed wire that MATTERS: the ALN must cut it (a few seconds, a
        sapper-like action) or go round; it snags a man for a moment.
      · Dust trails behind vehicles on the pistes (one shared particle
        field), tyre-track decals fading behind them.
      · Oven smoke from a few village houses, laundry on a ksar roof,
        a donkey tied at the souk (the herds already have donkeys).
      · Night: lit windows (emissive, no lights) in the post, villages and
        the ksar; a lantern at the souk arcades; the mirador lamp.
      · Built pieces WEAR: sandbags slump and burst when shot (swap to a
        damaged variant), a burnt MG nest keeps its wreck (as structures).
      · Spent brass / a scorch decal at an MG nest after long firing.
      · Ambience: cicadas by day, the muezzin from the ksar at set hours,
        dogs barking in villages when soldiers come near.
- [ ] Génie, next: a construction bar over the site; cancel/refund; the
      AI's sappers?; ALN builds (sangar, ambush screen) the same way; the
      mirador into the line-of-sight bake; pads read as a pale mound on a
      slope (the flatten rim) — you, look.
- [ ] Not yet from the proposal: tiers (motor pool → helipad → armour), the SAS post raising support,
      the arms cache UNLOCKING MG / mortar / bazooka teams (it pays income
      for now), militia (moussebilines) recruited in ALN villages, the
      ALN purse named "Soutien" on screen.
- [x] The ALN FIGHTS FOR THE VILLAGES (2026-09-28, algAI.js): about half
      its bands (when one is worth it) do POLITICAL WORK — into a village
      the ALN does not hold (French-held first, then neutral; near, few
      French round it), holding fire, which swings it their way; French
      within 35 m → strike, then melt back to the cave. Tested (headless):
      a band of 5 took the dechra (held at 73 s, ALN income 30 → 70/min);
      6 appelés sent, the band struck when they arrived, withdrew with all
      5 and went to ground; the dechra stays theirs until the French work
      it back through 0.
- [ ] The ALN leaving a few men as a village cell (moussebilines), and
      the French answer: cordon-and-search (a mission, not just walking in).
- [ ] Balance: all numbers are first guesses.

## PROPOSAL — economy and base-building (2026-09-26, waiting for **you**)

Shared core (nam's, moved to games/shared-rts): capture points held by
INFANTRY pay income every second; a builder unit places structures; the
HQ pays a small trickle. On top, the two sides play differently:

**French — "Ravitaillement" (supplies), one currency.**
- Income: held points + HQ trickle; the valley points (hamlets, oases)
  lean French.
- Builder: the Génie sapper. Tiers unlock by building:
  1. Post (start): infantry (appelés, then paras/légion)
  2. Motor pool: jeep, GMC, half-track, EBR
  3. Helipad: Alouette II (medevac, recon), H-34 (troops, gunship)
  4. Armour (after both): AMX-13
- Defences: sandbag wall, barbed wire, mirador watchtower (sight),
  MG nest, mortar pit, searchlight (night).
- **SAS post**: a forward base on a hamlet: reinforce there, sight
  radius, raises French support in that hamlet.

**ALN — "Soutien" (support), one currency, earned differently.**
- Income: held points (the mountain ones lean ALN) + hamlet SUPPORT:
  each hamlet has a support meter; the side with more presence there
  gets its income. Abstract, never atrocity mechanics.
- No heavy vehicles, no air. Instead:
  - **Hidden**: ALN buildings are invisible to the French until a French
    unit comes close (nam's tunnel rule, 35 m).
  - **Cave entrance**: spawn and reinforce point, only in rough ground.
  - **Arms cache**: stores smuggled weapons: unlocks MG / mortar / bazooka
    teams.
  - **Sangar**: stone MG position.
  - **Mines / booby traps**: nam's trap kit (a per-man roll to find).
  - **Ambush position**: brush screen; units inside are hidden until they
    fire.
  - Hamlet **recruits** militia (moussebilines) where support is high.
- Build rule: ALN may build only on rough or high ground (near cover), the
  French anywhere they can level a pad.

**Assets this needs** (buildable, kit style, 3/4 facing):
French: sandbag wall, barbed wire, mirador, MG nest, mortar pit, helipad,
motor pool (hangar), searchlight tower, SAS post.
ALN: cave entrance, arms cache, sangar (from the camp), ambush screen,
mine / trap markers.

## Open decisions — **you**

- [x] **How the code starts**: (b), a shared RTS core, one system at a time
      (you, 2026-09-26). Camera moved first.
- [x] Playable side: **French** first; choosing the side comes later (you).
- [x] Title: **SAND & BLOOD** (your cover art, 2026-09-27): launcher card
      beside NAM, loading screen on the art (alg.html, as nam.html).

## Terrain — the first map

Tool: `node tools/algDem.mjs --site <name> --out <dir>` (or `--site all`,
or `--lat --lon --span`). It writes a 16-bit heightmap PNG (editor: Sculpt →
Heightmap File), a raw `.f32` (the .v3proj `heightmap` blob as-is) and a
shaded preview (red = steeper than the 34° nav limit, green = the biggest
connected ≤15° patch), and prints the three RTS metrics.

Candidates measured 2026-09-26 (real slopes, `--vscale 1`, smooth 3):

| site | real span | game relief | walkable | biggest gentle patch |
|---|---|---|---|---|
| aures-arris | 4 km | 4–127 m | 99.8% | 71.6 ha of 105 |
| **aures-tighanimine** | 4 km | 4–207 m | 99.3% | 44.4 ha |
| aures-oued-abdi | 5 km | 4–166 m | 97.4% | 20.1 ha |
| aures-ghoufi | 3 km | 4–110 m | 96.8% | 62.8 ha |
| kabylie-irathen | 4 km | 4–181 m | 92.9% | **1.9 ha**: all ridges; a hard map later, not the first |

What this showed:
- The source data is ~30 m SRTM and carries fine horizontal striping. The tool
  samples it bicubic (bilinear left a crease every ~4 texels) and blurs 3 px.
- **At real slopes the Aurès is almost all walkable at game scale.** The data
  smooths the real cliffs, so "mountain war" legibility (cliffs as walls,
  ramps as doors) has to be ADDED: terracing (tools/terraceTerrain.mjs) and
  rock bands at 34°, not taken from the data.
- Ghoufi has a dead-straight diagonal wall at bottom-left that looks like a
  data artifact. Check before using it.

Steps:
- [x] DEM → heightmap tool, 5 candidate sites measured
- [ ] **you**: pick the site (recommended: Tighanimine: NW massif, a wide
      diagonal valley, a SE ridge, 207 m relief)
- [ ] **you (2026-09-26): the RTS doesn't need big mountains.** Flatten
      with `--vscale` (e.g. Tighanimine at 0.6 ≈ 125 m relief), or take
      Arris (127 m at real slopes). Keep the drama at the map edges.
- [x] Tighanimine heightmap generated at real slopes (`--vscale 1`):
      games/alg-rts/terrain/aures-tighanimine.png. The user's fluvial erosion
      (Sculpt → Stream Power) flattens a lot, so it does the flattening, not
      `--vscale`.
- [x] New project in the editor (1024 m / 1024 / max 250), PNG imported,
      fluvial erosion (iters 160, strength 20, uplift 0, smooth 5), saved as
      **public/levels/alg-aures.v3proj** (3.7 MB, verified read-back)
- [x] Re-measured. Fluvial CARVES, it does not flatten: relief stayed
      4.5–206 m; walkable 99.3 → 88.3%; gentle 49.4 → 36.1%; biggest
      connected gentle patch 44.5 → 30.6 ha. Weakest tile 65% (SW).
- [x] Relief ×0.6 and the border faded to the plain (your "you choose",
      2026-09-26). Outside the heightmap the engine draws flat ground at
      0 m, so the edge was a wall. Far mountains would need terrain beyond
      the heightmap (engine work, and the terrain shader is at its sampler
      limit), so the border fades to exactly 0 over 170 m, edge wobbled by
      noise. Tool: `node tools/algShapeMap.mjs --in
      public/levels/alg-aures.v3proj.bak --out public/levels/alg-aures.v3proj
      --scale 0.6 --band 170 --warp 50`. The .bak is the untouched eroded save;
      re-run with other numbers from it.
      Result: 0–96 m, walkable 93.4%, gentle 62.8%, biggest connected gentle
      patch **61.3 ha** (nam-valley 49), NW massif tiles 67/78%.
- [x] (2026-09-29: the foliage picker's thumbnail bake — an all-card plant
      left an empty FIRST material group; and the editor's favicon 404.)
      Console: one "Draw with an index count of 0" warning after loading
      the map in the editor. Some empty mesh is being drawn; find which.
- [ ] Later, maybe: far mountains beyond the map (a backdrop ring) if the
      flat plain round the map reads wrong from the game camera.
- [ ] Wadis (dry riverbeds) as River v2 carves with no water: the walkable
      corridors
- [ ] Cliffs and ramps: terracing on chosen slopes, so impassable ground is
      readable
- [x] Surface layers, first pass (2026-09-26), `node tools/algPaint.mjs
      --file public/levels/alg-aures.v3proj` writes the slots + splat:
      slot 0 Valley soil `brown_mud_dry` · slot 2 Scree `gravelly_sand`
      (13–22° up) · slot 5 Cliff strata `cliff_side`, triplanar, from 34°
      (= nav limit) · slot 1 Limestone ridge `rock_boulder_cracked` (land
      height p80→p95 = 45→75 m). Coverage 66 / 25 / 4 / 5%. Poly Haven CC0,
      1k, in public/textures/ground/. Judged with ?topk=3&far=1 (what the game
      compiles) at a ~150 m play camera.
      Rejected at play distance: `dry_ground_rocks` (dark patches repeat as
      diagonal bands every 8 m), `sandy_gravel_02` (flat, still bands),
      `aerial_ground_rock` (white spots in a grid).
- [ ] The plain OUTSIDE the map renders white; should be soil-coloured so
      the edge doesn't show.
- [ ] Tints / colour pass once the light is set (judge in the game).
- [ ] Unused slots 3, 4, 6 still load the editor's default palette (12 images
      decoded for nothing); clear them.
- [ ] Sky and light: harsh sun, pale sky, dust haze (a preset, and the fog
      band in METRES belongs to the map)
- [ ] Save to public/levels/ and verify it round-trips

## Vegetation — the one genuinely new asset job

- [ ] Atlas cedar (Aurès heights)
- [ ] Holm oak / Aleppo pine
- [ ] Lentisk and juniper scrub
- [ ] Alfa grass (esparto) tufts
- [ ] Olive groves (Kabylie), prickly pear (villages)

## Later — gameplay ideas already discussed

- Open ground, long sightlines: height-based line of sight and dead ground
  matter more than foliage concealment
- French: helicopters (H-21, H-34, Alouette II), paratroopers, cordon and
  sweep, T-6 ground attack, napalm (historically used), jeep, GMC, M3
  half-track, AMX-13, Panhard EBR
- ALN: katibas, ambushes, mines, caves as hidden bases (terrain holes and
  tunnels), night movement, arms smuggled across the borders
- Mechta and dechra villages (stone, flat or tiled roofs, along the ridge)
- Set pieces: the Morice Line (electrified border fence), winter in Kabylie
  (snow system), Casbah of Algiers (1957) as an expansion
- Reading: Horne, *A Savage War of Peace*; Courrière (4 volumes); the film
  *The Battle of Algiers* (1966)
