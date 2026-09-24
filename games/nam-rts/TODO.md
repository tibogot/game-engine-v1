# nam-rts — the list

Everything asked for or agreed in the build conversation (2026-09-18 → 22),
rebuilt from the full transcript. `[x]` done · `[ ]` open · `[~]` started or
partly done · **you** = your call or your work.

Keep this file current: tick things off here, add new asks here.

---

## PRIORITY — what to do next, most important first (2026-09-22)

1. ~~**Enemy AI**~~ DONE (first version, infantry only) — see Gameplay. NEXT on
   it: play it and tune (your call); it cannot yet use vehicles, mortars or
   ambushes, and the enemy's soldiers still wear US uniforms
2. ~~**Requisition sites**~~ DONE — 7 sites on real ground (pointSites.js), both
   bridges made crossable
2b. **Enemy buildings BEFORE enemy vehicles** (your call 2026-09-22) — STARTED:
   [x] **French colonial HQ** (`rtsColonial.js`, 8.9k tris): ochre stucco résidence,
   red-tiled hipped roof, arcade + loggia, pediment with the NLF star, NLF banner,
   shell hole in the roof, flaked + bullet-pocked stucco, sandbagged arches,
   palm mats on the back slope; nav footprint = the building (no door lane).
   New atlas surfaces: stucco (14), roof tile (15) — the atlas is now FULL.
   [x] **Tunnel entrances** (`rtsEnemyKit.js`, 4 on nam-valley in jungle,
   `pointSites.TUNNEL_SITES`): the AI recruits at the most forward SAFE tunnel
   and falls back to the nearest one; hard to spot, its bar shows only once
   one of yours is within 35 m; 350 hp.
   [x] **ZPU-4 AA gun** (`rtsEnemyKit.js`: pit + carriage, mount with its
   gunner in a pith helmet, four barrels that turn AND elevate): range 62 (the
   Huey has 44, the M48 48), picks aircraft first and switches to one arriving
   within 0.5 s, x1.8 damage to air (~65/s against a Huey's 80 hp) and x0.6 to
   ground, 350 hp. One stands at the enemy HQ from the start; the AI digs more
   in at held points (20 s, 220 supplies) where your helicopters were SEEN,
   else ~one per three points held, max 5.
   [x] **82 mm mortar** (`rtsEnemyKit.js`: pit, bags, crates, bombs, a kneeling
   gunner and a standing loader — both 2.34 m, the game's own soldier height;
   the tube turns to its aim): the first INDIRECT fire. `projectiles.spawnArc`
   throws a ballistic shell that lands on a POINT (warning ring on the ground
   while it is up, tightening and turning red), `combat.splashAt` blasts
   everything on the ground within 9 m — falling off to the rim, aircraft
   exempt, and COVER DOES NOT SHELTER (it comes from above). The AI digs tubes
   in behind held points (180 supplies, 18 s, max 3) and drops a round every
   7 s on the thickest knot of your men ITS OWN MEN CAN SEE, never on its own.
   MEASURED: six men standing still died in ~19 s; with no spotter alive it
   stops firing. Ready to reuse for the US 81 mm pit, the M109 and the rockets.
   [x] **THE CHEAP NASTY KIT** (`rtsEnemyKit.js` + new `traps.js`, test
   `namTrapsTest`): punji pit, booby trap, spider hole, supply cache. All four
   are CONCEALED — not drawn, not targetable, not on the minimap, not in the
   nav grid — until your men find them, and finding is a ROLL: each rifleman
   within the spotting ring gets his own chance per second, and **vehicles
   notice nothing**. So a squad sweeping a trail usually finds what is on it,
   one man hurrying often does not, and armour with no infantry in front finds
   everything the hard way. Hidden is spelled with flags combat.js already had
   (`passive` + `deploy`), so no targeting code knows traps exist.
   · **punji pit**: infantry only, 30 damage and a 9 s limp at 0.45 speed — it
     takes a man out of the line rather than killing him; re-arms after 8 s and
     never catches the same man twice
   · **booby trap**: a grenade in a ration tin on a wire — 58 damage in an 8 m
     splash, spent in one bang, and x0.12 against armour (new `vehicleMul` on
     combat.splashAt)
   · **spider hole**: opens up at 30 m and shoots at 24, so you always see the
     lid go back before the first round; 130 hp, the man turns with his rifle
   · **supply cache**: pays the Front 0.35/s while it stands (a fifth of a
     point) and pays YOU 150 when it burns — the only way to cut their income
     between points
   FOUND = drawn + a danger ring on the ground + STAMPED INTO NAV, so your men
   walk around it from then on. Knowing where it is IS the counter.
   The commander lays more as the match runs (`layCheapKit`, 35/80/110 out of
   spare change, capped 10/4/3): traps on the side of its points facing your
   HQ, holes beside them, caches in its rear. MEASURED: 5 laid at boot, 11 on
   the map after 280 s.
   NEXT: your look check on all four · the AI digging NEW tunnels (a sapper) ·
   enemy camp dressing round the résidence (well, sheds, cooking fire smoke) ·
   a minesweeper/engineer verb to clear a found trap
3. ~~**Vehicles rebuilt**~~ DONE for the US side — M113, M48, M151, M551, M35,
   UH-1 all procedural. ENEMY armour started:
   [x] **PT-76** (`rtsVehicles.buildPT76`, 5.3k tris): boat hull, folded trim
   vane, cone turret with the white hull number, 76 mm with bore evacuator and
   double-baffle brake, two water jets in the stern, six road wheels, no return
   rollers. 230 hp, range 40, speed 19 — thinner and softer than an M48, faster
   than anything you own. Painted in THEIR khaki: `nativeTeam: "enemy"` in
   unitTypes means no red team wash over it (teams.js).
   The AI buys them at its HQ (300, max 4, once it holds 2 points) and attaches
   one to the squad that needs it most — the one gathering to attack, else the
   one nearest your HQ. The tank takes the spot FACING you while the men take
   the cover; a squad's size still counts men only.
   **It SAVES for them** (`plan()`): recruits and digging wait rather than eat
   the fund — without that it never reached 300 (MEASURED: 5 min, 7 points, 0
   tanks; after: first tank at 2 min, four by 5).
   [x] **Molotova supply truck** (`rtsVehicles.buildMolotova`, 2.9k tris): the
   ZIL-157 — round barrel bonnet, torus mudguards, small cab, canvas tilt over
   hoops with cut branches laid on it for camouflage, spare wheel, jerry cans,
   6x6 on singles. 150 hp, speed 23, UNARMED (range 0). Their logistics made
   into a target: the AI buys one (120) once it holds a point, runs it from the
   HQ to the most forward held point and back, and a completed round trip pays
   **170**. Kill it on the road and the run pays nothing — their income is now
   something you can interdict. `nativeTeam: "enemy"` (no red wash).
   NEXT enemy vehicles: ZPU on a truck, sampans, bicycles
4. **THE JUNGLE — IN PROGRESS 2026-09-23.** Big trees, palm variety, Vietnam
   plants (areca, sago, pandanus, nipa, banana, flame tree).
   **AND, your framing 2026-09-23: the plants we have were authored for a
   GENSHIN-STYLE game.** So this is not only "add plants" — it is judging the
   colour and the look of what is already there against what a Vietnam RTS
   wants: a heavier, damper, less saturated green, more value range between
   canopy and floor, and silhouettes that read from the RTS camera rather than
   from a third-person one. Colour first (it is cheap and it changes every
   screenshot), then the new types.
   [~] **THE BLACK FACES** (your ask 2026-09-23, two screenshots, "we have had
   it since the beginning… it reads like that even from far"). DIAGNOSED, and
   YOUR guess was the right one — it is the NORMALS, not shadows and not
   mainly the terminator. Measured on one bush at close range, its green
   pixels split into darkest and brightest fifths:

       lit 49.1 / 125.2 · ambient only 42.7 / 56.1 · sun only 20.7 / 91.9
       → a dark leaf gets 4.4x less sun than a bright one

   Shadows were ruled OUT: casting and receiving switched every way landed
   within 2% (a wider earlier sample said otherwise — it was reading ground
   and grass, not the plant). The colour ramp is a real but secondary
   multiplier: flattening `colorBase` to `colorTip` lifts the dark fifth 28%.

   THE CAUSE is in foliageSystem.js's own note: the leaf's canopy normal-lift
   RELAXES as the camera climbs (FOLIAGE_TOPDOWN_LIFT), because a full lift
   makes the field go flat from overhead. From the RTS camera the two multiply
   out to ~0.25 of a bend, so a card keeps its true normal and a card turned
   away from the sun goes black. The relax was added on purpose; the black
   faces are the other end of that same trade.

   THE LEVERS, all three now live uniforms (`__V3_DEBUG.foliageWrap`,
   `.foliageLeafLift`, `.foliageTopdownLift`), measured on the bush
   (dark / bright / contrast):

       stock  wrap 0, lift 0.55, topdown 0.45   46.1 / 124.7 / 2.70x
       wrap 0.6 only                            52.9 / 111.8 / 2.11x
       topdown 1.0 (no relax)                   72.5 / 109.2 / 1.51x
       topdown 1.0 + lift 0.85                  80.8 / 109.4 / 1.35x
       wrap 0.4 + lift 0.75 + topdown 0.8       77.9 / 112.1 / 1.44x

   New: `v3/render/foliage/foliageLighting.js` (wrapped diffuse as a custom
   lighting model + the two lift uniforms). WAITING ON YOU: where to sit on
   the trade — lower contrast and no black faces, or keep more per-leaf form.
   A/B/C shots taken at play zoom 2026-09-23; say the word for a live cycle.
   [~] **BIG JUNGLE TREES — IN PROGRESS, stopped mid-iteration 2026-09-23.**
   The headline from the inventory: **the map has NO trees at all.** 8 tree
   slots, all empty, `trees.instances` = 0. Every "tree" on screen is a foliage
   card; the tallest thing on the map was an 11 m palm. The canopy layer does
   not exist, which is why the jungle reads as undergrowth.

   WHERE IT LIVES (decided, built, working): a fourth TALL-PLANT type, not a
   new field and not the v2 tree pipeline (that one needs preset JSONs, which
   are yours to author — see the 2026-07-10 note). The tall-plant field already
   does GPU culling, 3 LODs, fade, wind and shadows for the 9 m bamboo and the
   11 m palm at 330-420 m, which is the optimisation asked for. Done:
   · `TALL_PLANT_COUNT` 3 -> 4; the paint layer's ALPHA channel was free
     (nothing ever wrote it) and the scatter field already reads 4 per page
   · the density mask bake was writing `vec4(rgb, 1)` — a hard 1 in alpha,
     which would have planted a tree on every texel of the map. Now carries it
   · paint + fill channel clamps 2 -> 3, legacy collapse clears alpha too
   · panel: 4th slot, `sizeMax` 34 (the slider stopped at 5 m — it could not
     show the bamboo or the palm either), bark colour, buttress sliders
   · `kind: "jungleTree"`, preset, `canopy` card texture key, lab wiring

   THE TREE ITSELF IS NOT GOOD YET — your words: "your tree looks very ugly",
   and you were right both times. Two failed versions, both for the same
   reason, and the reason is the one the bamboo taught: DO THE SUM IN METRES.
   · v1: 64 long leaves fanned from one point per card — read as a green COMB,
     parallel bars, and 3 plates per branch left a skeleton with tags on it
   · v2: 150 leaves over a disc — read as green SLABS, because each leaf was
     60 cm long on a 6 m card. A wet-tropic broadleaf is 15-25 cm
   · v3 (current): ~700 leaves at 0.045-0.08 of the card. The silhouette is
     now right — clean bole, parasol crown, buttresses read at the foot.

   THE OPEN LEAD, measured right before stopping: the cards still render as
   solid RECTANGLES with hard corners, but the texture is fine — 41.6% opaque
   and all four corners alpha 0. So the alpha is not reaching the material in
   the LAB: the part-4 card texture swap (`spraySlot`, added to
   v3/vegetation-lab.html) is not taking effect, or the plates are drawn
   through another path. Check the lab's `syncFrondTexture` against the
   ENGINE's `_cardMat("canopy")` path, and check it in the GAME too — the game
   builds a separate material per card key and may well already be correct.

   THEN: crown depth (two tiers of branches, not one), per-tree variation, the
   LOD2 card count (the bamboo lesson: a coarse level must GROW its surviving
   cards), and the wind — the field bends a plant by its HEIGHT fraction and
   caps the lean at ~40 deg, which on a 26 m tree would be a catastrophe; it
   has not been looked at yet.

   NOT COMMITTED. Files: `v3/render/foliage/jungleTreeGeometry.js`,
   `canopyClusterTexture.js` (both new), plus the wiring above.
   Live test recipe: `__V3_DEBUG.grassTerrainData.stampSusukiDensity({cx, cz,
   radius: 150, strength: 0.12, falloff: 0.6, worldSize: __NAM.worldSize,
   channel: 3})` — strength IS the density for a 26 m tree; 1.0 gives a
   thicket you cannot walk through. The lab boots on the tree.
   [x] **THE COLOUR PASS** (`tools/namVegPalette.mjs`, written into
   nam-valley.v3proj — **your look check**): every vegetation system on the map
   repainted at once — the 8 foliage plants, the 3 tall plants, all 8 tree
   slots and both grass systems. What was there: every tip a bright lime
   (#8cb84a, #9ccb4e), tree crowns #5aaa2a over a #c8e070 subsurface, and a
   grass tip of **#00b30c — a pure saturated green that exists in no forest**.
   What it is now: less chroma (saturation is what makes foliage read as
   plastic), hue a few degrees off yellow toward blue, and the old dark-green→
   lime HUE jump replaced by one hue at several VALUES, which is what depth in
   a canopy actually is. The plants that are legitimately pale — reeds, dry
   grass, bamboo culms, the plume heads — were left pale, and they are what
   keeps the mass from going flat.
   NEXT in the colour thread if wanted: the terrain's own green (the open
   ground still reads pale and yellow next to the new jungle), and a little
   per-instance hue variation so a stand is not one colour.
   QUEUED BEHIND IT, in this order, all agreed:
   · **finish KURTZ** — the temple stands but is bare: the tribe's village
     built into the ruins, heads on pikes on the approach, totems at the
     boundary, worn bare ground in the courtyard, saplings in the cracks
   · **the crash site** — the shot-down Huey near the temple (see THE ENEMY SIDE)
   · **the enemy side** — their empty base, the formula-sited nests, their own
     bamboo guard tower, the tiger cages (see THE ENEMY SIDE)
   **RE-ASKED 2026-09-22 (evening), along with the VILLAGE and RUINS** — after
   the Molotova and the cheap nasty kit, these three are the next block:
   · [x] **A VILLAGE** — DONE (`v3/render/objects/rtsVillage.js` +
     `games/nam-rts/village.js`, test `namVillageTest`, sited in
     `pointSites.HAMLET_SITES`, `?village=0` boots without it).
     **Ap Bang** stands at (−10, 280) on nam-valley — astride the axis of
     advance 120 m south of the résidence, its lane running north, so an
     attack up the valley goes THROUGH it. 49 pieces, ~2 extra draw calls
     (all merged), nothing blocked, the lane walkable end to end (detour 1.03).
     KIT: big-roofed ground house (a true HIPPED thatch roof — four slopes to a
     short ridge, hip ends steeper than the sides), the stilt house at hamlet
     proportions (lower walls, 2 m eaves), rice granary on rat-guarded legs,
     well, spirit shrine, woven fences, water jars, drying rack with chillies,
     straw rick, cooking hearth, ox cart, PLANTED BAMBOO and BANANA, pig pen,
     washing line. `buildThatchSlope` gained `topWidth` (trapezoid/triangle
     courses = a hip roof) and `tone` (weathered vs new straw).
     THE ARRANGEMENT is the point: a lane with two staggered rows facing it,
     fenced yards with a gate in front of each door, clutter only at doorways,
     the well and shrine on open ground in the middle.
     NEXT on it, if we want more: bare-earth PAINT for the lane and yards (a
     map patch, the biggest remaining win), a banyan at the centre, more house
     variety (a shop, a school), a buffalo pen with an animal, cooking-fire
     smoke (note: smoke blocks line of sight — it would be a gameplay change)
   · **ruins** — a bombed hamlet and a wrecked colonial building to fight over
     (the colonial HQ's parts can be broken up for it). NOW ALSO, your ask
     2026-09-23: **Cambodian/Khmer temple ruins**, Apocalypse Now — see THE
     ENEMY SIDE below, which is where that whole thread lives
   · **another vegetation pass** — the plants above, plus colour variety and
     the readability thinning
5. **See-through for hidden units** — needed before the jungle gets denser
6. **THE HILLTOP GPU SPOT** — must be fixed; parked by your choice for now
   (everything known is written under Performance)
7. **Enemy side looks like an enemy** — enemy HQ (French colonial building),
   VC/NVA units, enemy camp dressing
8. **Audio** — nothing yet; howler is installed
9. **UI pass** from your references · edge scroll under the HUD
10. **Fill the map** — village kit, battle debris, a small lake, paddies
11. **Night / dusk lighting** — floodlights and searchlights earn their place

Everything else below is in its section.

## THE ENEMY SIDE — your asks, 2026-09-23 (next block after ruins/vegetation)

Your words: their base is still empty next to ours, the default turrets are the
old ones, they need their own kind of guard tower — and it should feel like
Vietnam, like Apocalypse Now.

- [x] **The old boxes in the jungle were the TRAINING TARGETS**, not the
      turrets (your screenshot 2026-09-23): five placeholder box-and-slab
      dummies planted north of the camp at every boot since the sandbox days.
      Kept (they are useful for testing craters and combat) but rebuilt as a
      RANGE: `rtsFirebaseProps.buildTrainingTarget` — a battered earth bank with
      two courses of bags on its crest, a full man-shaped plywood silhouette on
      stakes in front of it at the game's own soldier height, bullet holes
      punched through the group, a lane board and spent brass in the dirt.
      848 tris, one instanced draw for the whole line. `?dummies=0` boots
      without them. (The merged-body renderer path went with them — the
      dummies were the only thing left in it.)
- [x] **DONE 2026-09-25 (uncommitted): THE LINE IS SITED BY THE GROUND**
      (enemyLine.js). Ways in = nav paths from our HQ to theirs and to every
      capture point on their half (+ the helicopters' straight line);
      candidates on a 10 m grid scored by how much of those roads they see
      (8-tap terrain LOS) within gun range, + height over them; greedy picks
      with 62 m spacing and DIMINISHING returns on road already covered (the
      first try stacked every gun on the east road). Mix: 3 DShK nests, a
      BAMBOO WATCHTOWER (new structure "tower": 12.7 mm on the lashed tower,
      range 64, vision 100, 280 hp — sited where a pit would be blind), a
      second ZPU on the air line, 3 spider holes beside the roads in cover.
      Siting 16-25 ms (4.2 s first try, before de-duplicating road points).
      Canopy clears 28 m round guns (a tower stood under a crown at 16),
      12 m round spider holes/tunnels (the jungle hides them). ?line=old =
      the five formula nests. Only ONE tower placed on nam-valley (the second
      had no spot left with the spacing) — fine or loosen, your look.
      NOT DONE from the plan: WIRE between the positions.
- [ ] (was) **Replace the default enemy turrets.** Five DShK nests stand in a line
      across the top of the map from boot (structures.js `turretCount`), sited
      by a formula, not by the ground. Replace with a MIXED, sited line: DShK
      nests where they cover open ground, ZPU-4s on the approaches your
      helicopters use, a 12.7 mm on a bamboo tower where they need to see, and
      spider holes and wire between them (the cheap nasty kit is already built).
      Site them the way the requisition points were sited — by path and by what
      they actually overlook, not on a line
- [ ] **Their guard tower**: NOT our steel-and-timber one. A lashed BAMBOO
      tower — four raked poles, a split-bamboo platform, a thatch cap, a ladder
      of lashed rungs, a bell or a length of shell casing hung to beat as an
      alarm. Gives vision like ours (and a man in it, like the spider hole)
- [x] **FIRST PASS DONE (2026-09-24, while you were out — uncommitted,
      YOUR LOOK CHECK)**: v3/render/objects/rtsEnemyCamp.js (new kit:
      lashed bamboo watchtower with thatch cap, ladder and shell-casing gong;
      long house/barracks; cook house with the Hoàng Cầm smoke TRENCH running
      out the back; weapons rack; map table under a tarp; camouflage net;
      supply-bicycle row; propaganda board with the NLF banner + loudspeaker;
      tiger cages, one occupied; foxholes; log-faced trench berms) laid out
      by games/nam-rts/enemyCamp.js round the résidence (front: towers,
      berms, foxholes, board; west: barracks, rack, cages; east: cook house,
      granary under netting, well, jars, map table; behind: bicycles, wash
      line; bamboo/banana clumps), forecourt and the ZPU/spider hole/punji/
      cache kept clear. ?enemycamp=0 = before. THE FLAG is the engine's
      Verlet CLOTH flag like ours (your call), NLF texture, its sim skipped
      while off screen. Trap: IcosahedronGeometry is NON-indexed and breaks
      assemble()'s merge — use SphereGeometry. rtsEnemyCamp.js added to
      PUBLIC_ENGINE_MODULES. OPEN: the map's own dense coconut palms swallow
      the east wing (cook house, granary) — thin them round the camp, or
      keep it hidden "under the trees"? Your call.
- [ ] **Fill their base** (the résidence is bare next to our camp). An NVA/VC
      base camp, not a firebase: cook house with a Dien Bien Phu smokeless
      stove (the trench that hides the smoke), rice store, a bamboo-and-thatch
      barracks under the trees, a weapons rack, an arms-cleaning bench, bicycle
      park (supply bicycles), a map table under a tarp, ammunition in the
      colonial building's arcade, a well, wash line, bomb-crater latrine,
      camouflage netting slung between trees, trench and one-man fighting holes
      round the perimeter, a captured US truck being stripped, propaganda
      board with a loudspeaker, NLF flag on a bamboo pole, buried-jar cache
- [ ] **Bamboo prisoner cages** (your ask): the tiger cages — low bamboo cages
      on the mud, one with a man in it, the POW pit with a grating over it.
      Could be a real objective: reach it and free the prisoners
- [x] **KHMER GUARDIAN LIONS — DROPPED 2026-09-23, you are finding a GLB.**
      A procedural first version exists in the tree but is NOT committed
      (`buildGuardianLion` in rtsTemple.js, `LION_OBJECT` in the objects lab).
      It stands, sits correctly and has the crest and scale bib; it is a lumpy
      mound close up and two rebuilds moved it very little.
      WHY, because it tells us where the line is: a singha is a FIGURATIVE
      SCULPTURE, an organic body with a carved face. Everything this kit does
      well is a repeated simple form whose RULE IS ITS SHAPE — mouldings swept
      round a wall, leaf cards on a stalk, wheels and boxes. Those converge
      fast. A sculpted animal has no such rule, so primitives get to
      "recognisable lump" quickly and then crawl. The palms were not luck.
      A GLB is the right answer for hero sculpture. Say the word if the
      procedural one should be deleted rather than left sitting there. The *singha* that sit in
      pairs at every Khmer stair foot and gate — seated on the haunches, front
      legs straight, a snarling mask of a head, a flame-like mane carved in
      rows, and a plinth of their own. They are what tells the player this is a
      THRESHOLD, and Kurtz's approach is nothing but thresholds. Pair them at
      the causeway head, at the gopura and at the courtyard stair.
      Buildable: the body is a shaped solid like the Bayon heads, the mane a
      ring of carved lobes, and both sit on the sandstone/laterite atlas rows
      that already exist. Judge them the way the palms were judged — reference
      photographs and a six-angle contact sheet.
- [ ] **Reference you gave for the temple pack** (2026-09-23):
      https://sketchfab.com/3d-models/ruin-ancient-temple-khmer-architecture-pack-3082fb3a9937454f89493f1c532b400e
      INSPIRATION ONLY — it is someone else's asset and nothing from it can be
      used. What it is good for is the KIT LIST: which pieces a ruin needs to
      feel complete, and how broken each one should be.
- [ ] **BLOOD** (your ask 2026-09-23), and it is two separate jobs:
      1. **COMBAT BLOOD — units.** A hit sprays, a death leaves a pool, and the
         pool stays for a while and dries. This is the decal system
         (`decals.js`, projected boxes, 1 draw) plus a hook in combat.js where
         damage and death already fire. Cheap and it does a lot: an RTS fight
         with no mark left on the ground reads as bloodless in both senses.
         Watch the cap — pools need a budget and a fade, or a long fight
         carpets the map (the same lesson as fires and smoke).
      2. **KURTZ'S PLACE — blood as DRESSING, not as an event.** Old, dark,
         dried, and in the places that tell you what happens here: down the
         ghat steps, over the altar stone, round the pike feet, handprints on
         the gopura jambs, a stain at the foot of the tower. It is not the
         bright red of a fresh hit — it is near-black brown, and it belongs in
         the STONE texture and in static decals rather than in the combat
         system, so it costs nothing per frame.
- [ ] **WHAT ELSE WOULD MAKE KURTZ'S PLACE** (my suggestions, 2026-09-23, none
      agreed yet — all chosen to read at RTS zoom and to cost almost nothing):
      · **THE CROWD.** The strongest single image in the film is the people
        standing motionless, watching the boat come in. Static figures lining
        the causeway and standing on the ghat steps — the soldier mesh already
        exists; these are passive, unarmed, and they do not move. Nothing else
        on the list would do half as much.
      · **BIRDS OVERHEAD.** The bird system is already built. A permanent slow
        circle of them over the compound, and only there, is free dread.
      · **SMOKE.** Not one column — a dozen thin ones from small fires, so the
        whole place smokes. The smoke system is measured at 0.18 ms a column,
        so keep the count honest.
      · **A SKULL MIDDEN** at the tower foot: one merged pile, not individual
        props. Reads as a mass of pale shapes, which is the right register.
      · **WHITE MARKINGS on the stone** — handprints, ash bars, painted eyes.
        A tribe's marks over eight-hundred-year-old carving is the whole idea
        of the place in one detail, and it is a texture job.
      · **TORCHES / FIRELIGHT at dusk**, tied to the time of day: the compound
        is the only place on the map with light in it at night.
      · **ASH AND SCORCH** on the ground between the fires, so the bare worn
        courtyard is not just dirt.
- [x] **SITING DECIDED (you, 2026-09-23): the temple STAYS at (340, 214)** and
      the river comes to it when you do the river branches. What makes it
      Apocalypse Now is the STAIRS GOING DOWN INTO THE WATER, so those are
      built now and simply go DOWN — a flight built to meet a river that is
      already there has to be rebuilt every time the river moves.
- [x] **`buildStairFlight` — a KIT primitive** (rtsParts.js), your point that a
      stair unlocks other shapes. It is the most reusable form there is: a
      temple landing, a terrace, the steps up to the résidence, a bunker
      entrance, a stilt house, a well. Riser and going set the character (a
      0.32 x 0.66 temple flight and a 0.18 x 0.28 domestic one are
      recognisably different animals), `jitter` and `wear` set how long it has
      stood, `matOf` decides what it is made of. It descends along +Z from its
      top tread at y = 0, because you always know where the doorway is and the
      bottom lands wherever the ground happens to be.
- [~] **THE DRESSING — STARTED, NOT RIGHT YET.** `buildRiverStair` and
      `buildHeadPikes` are in rtsTemple.js and placed in temple.js. What is
      wrong, from looking at it in the game:
      · THE STEPS STILL READ FLAT. A descending stair cannot take a levelling
        `pad` — a pad flattens the ground to ONE height and buries every step,
        which is exactly how the first attempt came out. It is now `pad: false`
        with the bank cut by `app.gradeRamp` from the stair head down a full
        flight — but the cut is not landing on the flight's axis, so the fall
        is beside the steps rather than under them. Check the local -> world
        transform on the ramp ends.
      · THE PIKES READ AS BARE POLES. They are in two tight rows flanking the
        causeway now rather than scattered, which is better, but the skull is
        too small to register at RTS zoom and the pole too clean. Either the
        head grows and the pole shortens, or they are not worth having.
      LEFT after that: the tribe's village built INTO the ruins (thatch
      lean-tos against the stone, cooking fires), the worn bare courtyard,
      saplings and leaf litter, standing stones on the paths in.
- [x] **TEMPLE STONE PASS** (2026-09-23), after you put ours beside a
      reference pack and asked how confident I was of beating it. Compared the
      two directly instead of guessing, and the gap was four things:

      1. **COURSING — the big one, and ours had NONE.** Every surface in the
         reference is cut into courses by dark joint lines; ours was one
         continuous streaky surface. Joints give a wall scale, direction and
         somewhere for shadow to sit, and without them a temple reads as a
         carved lump rather than as something BUILT.
         Fixed for nothing: these textures are drawn in canvas and a box's UVs
         in this kit are METRES / 2, so one atlas cell is exactly 2 m of wall.
         `coursing()` in rtsTextures.js puts 5 courses (40 cm) and 3 blocks
         (67 cm) in a cell — both INTEGERS so it still tiles — in running bond,
         with a per-block tone shift and a lit arris on each block's top edge.
         Applied to sandstone and laterite.
      2. **COLOUR.** Ours rendered cold grey-green under this map's sky fill.
         The sandstone is warmer now, and `stoneOf`'s laterite share went
         0.05 -> 0.2: a Khmer temple is a laterite CORE with a sandstone
         facing, and eight centuries takes most of the facing off. The red in
         the reference is laterite, and now it is in ours.
      3. **MOULDING DEPTH.** The reference's plinths and cornices carry five
         to eight small steps each, every one throwing its own hard shadow
         line. Ours had four shallow ones. PLINTH and CORNICE are rebuilt with
         a projecting torus, a hollow above it and a deep overhang; `banded`'s
         course step went 3.5 cm -> 5.5 cm so it reads at RTS distance. A ring
         of triangles per step on a handful of pieces — cheap in a way that
         texture detail on a 4K map is not.
      4. **SURFACE MICRO-RELIEF — NOT CLOSED, and honestly cannot be with the
         current material.** The reference is a 4K normal + roughness + AO map
         per piece; our object material is flat colour per atlas id with vertex
         tone and baked contact AO. Matching it at close range needs a NORMAL
         MAP path on rtsObjectMaterial. That is a real, scoped engine job and
         it is worth doing if the temple is ever a hero location — but at RTS
         zoom it is the coursing and the value range that read, not the
         micro-relief.

      Worth keeping in mind on budget: that pack is 10-20k triangles PER TOWER
      and 257k for its preview scene. Ours has to run with a full RTS on top,
      so richness has to come from texture, not geometry — which is why 1 and
      2 were the right first moves.
- [~] **KURTZ COUNTRY — the temple** STARTED 2026-09-23
      (`v3/render/objects/rtsTemple.js` + `games/nam-rts/temple.js`, sited in
      `pointSites.TEMPLE_SITES` at (340, 214), `?temple=0` boots without it).
      Tower with four Bayon faces, gate with a real passage, galleries round a
      courtyard, nāga causeway, strangler fig, rubble. 13 pieces, merged into
      the existing placedObjects draws.
      **The lesson**: the first build stacked it out of blocks, one box per
      stone, and read as Lego. What this architecture is legible BY is its
      MOULDINGS — so the forms are now swept profiles (`mouldedRing` /
      `mouldedRun`: plinth, banded wall, cornice), the carved parts are lathes
      and shaped solids (colonettes, lintels, pediments, the faces), and the
      chipped `stoneBlock` is only used for fallen and loose stone. The atlas
      grew a FIFTH ROW for sandstone, laterite and moss (it was full at 16).
      LEFT on it — **your look check first** — then: the tribe's village built
      into the ruins, heads on pikes along the approach, standing stones and
      totems on the paths in, saplings and leaf litter in the courtyard, and
      the ground inside it worn bare
- [ ] **Its dressing** (the rest of your ask). The
      Apocalypse Now compound: a Khmer temple half taken by the jungle — laterite
      blocks, a corbelled doorway, a four-faced Bayon tower, nāga balustrade,
      apsara reliefs, a collapsed gallery, strangler-fig roots over the walls —
      with the tribe's village built INTO it: thatch lean-tos against the stone,
      cooking fires, painted standing stones. And the dressing that makes it
      that place: heads on pikes along the approach, heads on the steps, bodies
      hung in the trees, a hanging man in a doorway, smoke drifting across it,
      hundreds of small fires at dusk. At RTS zoom these read as SILHOUETTES,
      which is the right register — dread, not gore
- [ ] **A CRASH SITE near Kurtz's place** (your ask 2026-09-23 — agreed, after
      the ruins). A wreck in the jungle on the way in, so the approach tells
      the story before the temple does. YES, this is cheap and good: the UH-1
      is already built part by part (`rtsVehicles.buildUH1` — lofted skin,
      boom, blades, skids), so a WRECK is that model taken apart rather than a
      new one — fuselage on its side with the skin split behind the cabin, the
      tail boom snapped off and lying clear, one rotor blade bent over the
      cabin and another thrown 20 m into the trees, the mast bare, doors gone,
      a burnt patch and scorched craters under it, panels and perspex scattered
      on the approach, vines already over the boom. Same for a fixed-wing if
      you want a second: an A-1 Skyraider nose-in with its tail up, or a C-123
      broken-backed in a clearing. Both want the crater/burn ground under them
      (craterSystem + the burnt-ground work) to sell it
- [ ] **My other suggestions for that stretch of map** (say which you want):
      · the **sampan village on the water** — stilt houses over a backwater,
        fish traps, nets on frames, a floating market boat
      · the **Do Lung bridge**: a bridge lit by flares and rebuilt every night,
        wrecks in the water under it, wire and bunkers on the banks
      · **French plantation**: rubber trees in ROWS with a colonial house and
        tapping cups — rows of trees look extraordinary from the RTS camera
      · a **bombed pagoda** with a standing Buddha and a broken bell tower
      · **B-52 crater field** — a straight line of overlapping craters across
        the map, jungle flattened, standing water in them
      · **tiger-striped standing stones and totems** on the paths into Kurtz's
        ground, so the player feels the boundary before they see the temple
      · **a burned-out hamlet** (the ruins job below) on the way to it, so the
        two read as the same story

## Now — the camp (your ask, 2026-09-22)

- [x] **Perimeter** (`campPerimeter.js`, every boot; `?camp=0` for the bare map): earth **berm** raised
      into the terrain (`app.raiseBerm`), chain-link (+5 m), 2+1 concertina
      (+9 m) as a **nav barrier** — the gate is the only way in (verified with the
      pathfinder from S, W and E) — gate with guard booth and raised striped boom,
      guard towers on the south corners, floodlight masts, a power line up the
      road. Wire/fence/lights/power line are the v2 spline objects at 1.3x
- [ ] **Night / dusk lighting pass**: the map is midday, so lamps only glow;
      searchlight beams (fake volumetric cones), light pools on the ground,
      lamps tied to sun elevation — needs a dusk/night time of day to matter
- [ ] **String lights = the HANGING LAMPS in the village** (your ask; you
      reminded me 2026-09-24) — for the village / a club tent (v2 `stringLights.js`
      registered, not placed yet)
- [ ] Berm reads faintly on sand: a bare-earth look (dirt decals along it, or
      a paint layer) would make it pop from above
- [ ] Perimeter authored **in the editor** as splines instead of code (the
      objects already are editor spline types; needs a berm spline + barrier flag)
- [ ] Other camp dressing (suggestions): perimeter bunkers and fighting
      positions on the berm, claymores and trip flares with signs, helipad with
      PSP matting + windsock, generator shed, water trailer, shower tower,
      burn-barrel pit, jerry cans, ammo bunker, white-painted stones along roads
      (the whitewash surface exists)

## Now — time of day + birds (your ask, 2026-09-22)

- [x] **Light section in the dev panel**: time of day, sun, sky light, sky
      fill, reflections, exposure, warmth — live; Keep (this browser), Reset,
      Copy (values to write into the map)
- [ ] Write the look you settle on into nam-valley / namGame.js (send me the
      Copy output)
- [x] **Birds** (`rtsBirds.js`): transit flocks crossing the view (white egrets
      in a V, crows), and flocks **flushed** from the jungle by any explosion or
      crater — mostly white so they read from above. One draw. Dev: BIRDS section

## SEE UNITS THROUGH BUILDINGS & FOLIAGE — your question, 2026-09-25 (TALK FIRST)

- [ ] Options discussed: (1) CoH X-RAY SILHOUETTE — units re-drawn once
      with a flat team-colour + rim shader, depth test GREATER (paints only
      where the unit is hidden), no screen grab; ~10 extra draws (instanced
      types + the crowd), pixels only where hidden; shows through hills too
      (rare at RTS pitch). (2) fade the occluder (buildings/trees see-through
      near units): costly with the instanced foliage, fiddly. (3) a see-through
      hole round the cursor: cheap, not an RTS look. MY PICK: (1), own units
      always, enemies only while spotted (fog of war / concealment intact),
      units only. Optional later: fade canopy crowns over selected units.
      Measure before shipping.
- [x] **BUILT (2026-09-25, uncommitted): xraySilhouette.js.** Every
      instanced unit part gets a twin InstancedMesh (same geometry, SAME
      instance-matrix buffer, a per-instance team flag) and the crowd a twin
      mesh (its compute-skinned positions, the team in the anim record's spare
      lane). Depth test GREATER, depth written LIFT metres nearer along the
      view ray (1.1 soldiers, ~size x 0.4 vehicles) — so a unit's own parts
      never light it up, only real occluders (buildings, trees, tall grass).
      Blue ours, red spotted enemies (hidden enemies are not drawn at all),
      a brighter rim. MEASURED: 198 units, x1.55 res: 25.09 vs 25.00 ms —
      free. ?xray=0 = off; tune live via xraySilhouette.xrayParams.
      YOUR CALL (2026-09-25): buildings and trees only, not grass -> the
      soldiers' lift 1.1 -> 2.5 m (grass hides a man from within a metre or
      two; a wall or a crown is further in front). Free. Trade-off: a man
      pressed against a low wall may not show. The exact alternative (a
      stencil bit written by buildings and trees) is an engine change.

## SELECTION & GROUPS — your asks, 2026-09-25

- [x] **Right-click move DESELECTS the units** (your report) — you re-tested
      on 2026-09-25 and it works; the trace caught no deselect. If it comes
      back, the note below says how to catch it. NOT reproduced:
      a scripted right-click keeps the selection and the units move, and the
      only code that deselects is selection.js's own clear() — a plain LEFT
      click on empty ground or a new box drag. A trace is installed in the
      open game page (window.__deselectLog, every deselect + its call stack):
      reproduce it once and the log names the cause.
- [x] **Control groups** (controlGroups.js, uncommitted): Ctrl+1..9 make,
      Shift+1..9 add, 1..9 recall, twice fast = centre the camera; by
      PHYSICAL key (e.code), so the AZERTY row works; chips (number · count)
      above the command panel, click = recall. Dead units drop out.
      CHECK: Chrome may keep Ctrl+1..9 for switching tabs even with
      preventDefault — if Ctrl+1 changes tab, say so and it moves to another
      modifier.
- [x] **Select all of a type**: double-click a unit or Ctrl+click it = every
      unit of that type ON SCREEN (Shift adds). (Double-clicking its tile in
      the unit bar already took every one on the map.)

## UI (your ask, 2026-09-22) — **you** are gathering references (YouTube)

- [x] **Small radii only** (2 px), field-equipment look (`hudBar.js` tokens)
- [x] **Wave pill** → dev panel (Enemy Waves); banner + win/lose stay on screen
- [x] **Supplies** → the HUD bar's status strip
- [x] **HUD in two corner blocks** (`hudBar.js`, Company of Heroes style — the
      full-width bar was too much): minimap bottom-left; bottom-right block =
      supplies strip on top, selection (one unit or building: portrait/monogram
      + health; several: tiles by type) + command card
- [x] Locked minimap: a NO RADIO static screen in its own slot
- [x] **Thumbnails for everything selectable** (`structureThumbnails.js`): the HQ, every
      building, the enemy nest — a real rendered portrait in the selection
      panel like the vehicles have, not the stencilled monogram
- [ ] **Your references** from other RTS games → next pass on the HUD's look
- [ ] Edge scroll: the corner blocks cover the bottom edge under them (the
      camera only scrolls over the canvas) — middle of the edge still scrolls
- [x] **Loading screen**: `nam-cover.webp` full screen (100svh, object-fit: cover), the
      `namlogowebp.webp` logo over the lit sky, a real progress bar (level download in bytes via the level loader's
      new `onProgress`; other stages scaled by this machine's timings from the
      previous boot), rotating gameplay tips
- [ ] Sharper cover art: nam-cover.webp is 1536×1024 and is upscaled to fill
      a 1080p+ screen; ~2560×1707 (same 3:2) would be crisp on 1440p
- [ ] rts-chibs has a better UI — ideas only, don't copy

## Ambient life — suggestions (not agreed yet)

- [ ] **Cloud shadows** sweeping the map (engine has `cloudShadowMap`) — reads
      beautifully from top-down, near-free
- [ ] **Distant Hueys** crossing the map like the transit birds, with rotor
      shadows — "the war is elsewhere", very Apocalypse Now
- [ ] Water buffalo in the paddies, chickens/pigs in the village (once those exist)
- [ ] Thin cooking-fire smoke over villages (smoke system, tiny budget)
- [ ] Horizon artillery flashes / smoke columns off-map; tracers at night
- [ ] Monsoon rain showers passing over (world rain exists in modular-road)
- [ ] Fireflies at dusk/night (editor Ambient FX mode has them — check they
      read at RTS distance first; butterflies/pollen won't)

## Your asks, 2026-09-22 (evening)

- [x] **Selected buildings show it** (`selectionFrameField.js`): corner
      brackets on square buildings (HQ on its pad, radio station), rings on
      round ones (helipad, turrets, supply relay); enemy buildings in red
- [x] **Base decoration placed from the start** (`campLayout.js`) — the kit pieces we
      built stand in the camp at every boot; signs + tank traps moved out to the gate
- [x] **Builder-built buildings rebuilt on the new kit** (`rtsBuildables.js`):
      DONE helipad (PSP matting with punched holes, painted H, revetments,
      windsock, corner lamps), M60 gun pit (the gun turns, tracers leave its
      muzzle), radio post (the kit station + star + U.S. ARMY); pads, nav and
      selection brackets from their real footprints. M60 drawn x2.4 so it
      reads from the RTS camera. Enemy turrets → **DShK nest** (log-lined pit,
      earth mound, leaf mats, the finned DShK with its ring sight), jungle
      cleared off the pit; `turretKit.js` deleted. Cover re-bakes when a
      building finishes (~4 ms, once). **Buildings with a job** (DONE):
      Guard Tower (vision 110 m), Aid Station (heals infantry 4 hp/s within
      18 m), Sandbag Wall (full-strength cover down its length, faces away
      from the HQ), Bunker (HARD cover, 80% vs 55% — new hard-cover grid in
      cover.js). Build menu four across with tooltips. LEFT: supply relay →
      requisition points (step 3); cover is still 4 m cells, so a wall covers
      both its sides a few metres out. Was: what the builder
      raises (helipad, turret, radio, supply relay…) still looks like the old
      game — radio station = the old GLB; others procedural, at our standard;
      some kit pieces become buildable
- [ ] Then **fill the jungle** (village, debris, paddies… — Map & look below)
- [x] **Placed-building system** (`placedObjects.js`, the foundation for the three above): one path
      for decoration AND builder buildings — kit geometry + footprint → flat pad,
      nav collision on the real footprint, cover, grass cleared, selection
      marker. DONE for the camp (pads, nav footprints, cover, one draw per
      material); NEXT: the builder's buildings through it, + selection marker
- [x] **Builder buildings, my proposal** (you trust me on gameplay): helipad =
      PSP matting + painted H + windsock + sandbag revetments · turret = sandbagged
      M60 gun pit (or the guard tower) · radio = the old GLB · supply relay =
      supply dump (crates, drums, tarp). New ones only if they have a JOB:
      guard tower (sees further), medic tent (heals nearby), sandbag wall (cover
      you build), bunker (hard cover)

## Your asks, 2026-09-22 (night)

- [~] **US Army star in a circle** — DONE on the Quonset HQ (both flanks,
      painted over the ribs), the GP tents' roofs, the radio post's roof;
      LEFT: billboards. Was: as a marking on buildings and billboards
      (the stencil sheet already has the `star` cell — place it). Other
      markings worth having: unit patches (1st Cav horse-head shield, 25th
      Tropic Lightning, 173rd), hazard stripes on barriers/generators, "DANGER
      HIGH VOLTAGE" on the generator, vehicle/tent numbers ("HQ-7", "A-12"),
      "NO SMOKING WITHIN 50 FT" on fuel dumps, sandbagged "LZ" letters on a pad
- [ ] **A small lake** somewhere on nam-valley: sculpt a hollow + the lake mode's
      water at the right height (your lake mode; I can also do it from code)
- [x] **Requisition points** (`requisition.js`, `requisitionRenderer.js`, test `namRequisitionTest`): DONE —
      7 relay masts (26 m lattice towers, guys, hut, flagpole); INFANTRY in the
      16 m zone capture in 12 s (faster with more men, capped at 4), contested =
      frozen, held until pulled back to neutral; +96 supplies/min per point;
      the flag CLIMBS the pole (US / NLF), violet M18 on your capture; zone ring
      in the owner's colour; minimap diamonds with a capture arc; HUD strip
      "2/7 points +192/min". Harvesting off (`?econ=harvest` brings it back).
      NEXT: choose the SITES (they reuse the old node fan: A sits behind the HQ
      on the terrace, G on the beach at the map edge) — author them in the
      editor or pick hills/crossroads; the enemy AI does not go for points yet
- [x] (was) **Requisition points**: map points you CAPTURE (not build) — a big
      antenna mast on each, and the **violet M18 smoke** when the point is taken
      (the violet smoke kind already exists). Note: today's economy is
      harvester nodes + a buildable "Supply Relay"; capture points change that
      design — **DECIDED: replace harvesting with requisition points**
      (harvesting can survive as an optional mode)
- [ ] **Real cloth flags on the requisition masts** (your ask 2026-09-22): the HQ's
      Verlet flag (baseFlag.js, 130 particles) on every mast instead of the stiff
      instanced cloth — climbs the pole with the capture, US / NLF image by owner,
      sim skipped off-screen. Cheap: ~0.02 ms CPU for 7, one small draw each, culled
- [ ] **Supply drops (later)**: a plane (C-130 / C-123 Provider) flies over and
      drops crates on parachutes to your units — resupply as an event or an
      ability, like the real war

## Your asks, 2026-09-22 (late) — trees, palms, vehicles

- [ ] **Big trees — the jungle has none but the palms.** A canopy layer: tall
      emergent trees (dipterocarp: straight pale trunk, buttress roots, a crown
      high above everything), banyan / strangler fig (aerial roots, huge wide
      crown), rubber trees in plantation ROWS (a French plantation is a great
      map feature), bamboo clumps already exist. Built in the **vegetation lab**
      · 2026-09-24: the BANYAN is done (placed landmarks, see below). Still
        open: a big tree IN THE JUNGLE itself (dipterocarp emergents, rubber
        rows). The jungle-tree slot is still the bad one.
- [x] **The coconut palm re-proportioned** (2026-09-23, your catch: "is my palm
      tree not a tall tree?"). It was **11 m** — 4.7 soldiers high, where a real
      coconut palm is 20-30 m and reads as about 14. It was a sapling standing
      next to a 26 m tree. Now **17 m**, raised WITH its proportions rather than
      by scaling: a coconut trunk stays ~35 cm thick however tall it grows
      (stemWidth 1 -> 0.7) and its fronds stay 5-6 m (plumeSpread 50% -> 32%),
      so scaling the plant would have given it a metre-thick trunk and
      nine-metre fronds. Bamboo is still short at 9 m (real giant bamboo is
      20-30); **your call** whether it goes up too.
      NOTE: the MAP carries its own copy (susuki.plants), so nam-valley still
      has the 11 m palm until a tools script writes the new numbers in.
- [~] **ARECA / betel palm** (`arecaGeometry.js`, new kind `areca`): a clump of
      4 very slender ringed canes (1:75), green crownshafts, small feathery
      crowns, orange betel nuts. Built and it works — but YOUR VERDICT was that
      it reads too much like the coconut, and you are right: both are PINNATE
      palms, same feather leaf, same crown, different proportions. Kept in the
      tree but not counted as the new palm. **Your call: keep it as a village
      plant or drop it.**
- [x] **FAN PALM — the actually different palm** (`fanPalmGeometry.js` +
      `fanLeafTexture.js`, kind `fanPalm`), DONE 2026-09-23 after a proper
      orbit-and-LOD pass. Palmate, not pinnate: the leaf is a pleated disc of
      radiating forked segments, so at distance it reads as a hard spiked star
      where a coconut reads as a soft plume. One generator covers the northern
      *co* (Livistona) and the Mekong *thot not* (Borassus sugar palm).
      **984 / 328 / 64 triangles**; a 140-tree grove is 8 draw calls.

      WORKED FROM PHOTOGRAPHS, not from memory — that was the difference.
      Wikimedia Commons: Borassus flabellifer (Asian Palmyra), Livistona
      chinensis, Livistona decipiens. Three things the photos corrected:
      · THE LEAF IS NEARLY A FULL CIRCLE, ~300 degrees — a disc with a notch
        where the petiole enters. It had been drawn as a 157-degree HALF-disc,
        which is a hand fan, and no arrangement of geometry could make a crown
        out of it.
      · THE SEGMENTS DROOP AND FORK. The spiky outline is the plant's
        signature; a clean rim is a dinner plate.
      · THE CROWN IS A DENSE BALL and the lowest live leaves hang BELOW the
        horizontal. Stopping at level reads as a shuttlecock.

      THE METHOD, worth keeping: a CONTACT SHEET. `window.__sheet(preset)` in
      the lab renders six camera angles — eye level, the other side, RTS pitch,
      high, straight down, inside the crown — into one image, and a second
      sheet does LOD0/1/2 and the grove at three ranges. Every defect below was
      found by looking at that sheet and none of them were visible from the one
      angle the lab boots at.

      THREE REAL BUGS IT CAUGHT:
      · the lab bound card textures at BOOT only, so a preset switch left the
        previous plant's texture on the new plant's cards — I spent a pass
        judging a fan palm wearing a coconut frond. `rebuildGeometry` now
        rebinds.
      · the fan part was at normal-lift 0.5 (the coconut's value, right for a
        folded V) and the leaves facing away from the sun went black. 0.8 now.
      · **the coarse trunk was BLACK, and the cause is latent in the palm and
        the areca too**: part 3 shades with its normal multiplied by
        `faceDirection`, so on a DOUBLE-SIDED quad the back face flips — and a
        crossed pair always shows one back face. Not the width, not the
        colour: the winding. The far trunk now uses part 2, which carries the
        same `colorHead` but turns its normal toward the viewer instead of
        flipping it. **TODO: fix the same thing in palmGeometry and
        arecaGeometry's far levels.**
      LEFT on it: the trunk could carry the diamond leaf-base pattern a real
      Borassus has, and a second colour for the dry-season look.
- [x] **BUSH + GROUND COVER rebuilt on leaf CARDS** (2026-09-23,
      `lanceLeafTexture.js` new, `buildLeafy` rewritten). These two were the
      worst-looking plants on the map — the triage lineup made it obvious — and
      both for one reason: **their leaves were geometry**. Each leaf was a
      three-segment polygon strip whose outline WAS the leaf's outline, so
      every leaf was an angular slab of five triangles with no taper, no curve
      and no point. They read as painted cardboard beside the ferns, and they
      cover more screen than anything else on the map.
      Now each leaf is ONE CARD with the shape in its alpha: **90 triangles a
      bush against 210**, a real silhouette, and two leaf variants (whole and
      torn) in one texture so a clump is not fifty copies of one leaf.
      AND THE ARCHITECTURE NOW DIFFERS: a bush is a GINGER CLUMP — upright
      canes with leaves alternating up two ranks, arching over — while ground
      cover stays a low rosette. Giving both the same rosette is why the jungle
      floor read as one plant at two sizes.
      Drawn from Alpinia photographs (Wikimedia Commons). Three sums that were
      wrong and are worth remembering:
      · the blade was 2.3:1 where a lance leaf is ~4.5:1 — the bush read as a
        cabbage for exactly the reason everything else here has been wrong
      · the "nibbled margin" ran at frequency 37 sampled over 42 steps, so it
        ALIASED into big scallops: the outline looked chewed, not nibbled
      · the card's aspect has to match the half-texture it samples (256x512, so
        half as wide as long) or the leaf is stretched on the card
      NEXT in your order: **banana** (same cardboard problem at a larger size).
      Then re-shoot the whole-map lineup to confirm the floor really changed.
- [x] **BANANA rebuilt as a CLUMP** (2026-09-23). Unlike the bush, its
      architecture and its texture were already right — the problem was that it
      was one plant at half scale. Corrected against PLANTATION photographs
      (Wikimedia Commons), which is the lesson of this one:
      **SEARCH FOR THE HABIT, NOT THE SPECIES.** Searching "banana" or
      "Alpinia" returns macro shots of flowers and fruit, because that is what
      botanical collections are full of, and you cannot see a silhouette in a
      close-up. "plantation", "habit", "grove", "field" return whole plants.
      Two passes were wasted on fruit close-ups before this was obvious.
      What the whole-plant shots corrected:
      · A BANANA IS A MAT. A tall bearing stem with two or three suckers of
        stepped heights round its foot — a plantation is a wall of them. One
        stem reads as a specimen in a pot. `spread` now sets the sucker count.
      · SIZE 3.5 m -> 5, leaf length 70% -> 92% of the stem. The bearing stem
        is 3-4 m and the leaves reach 2-3 m BEYOND it, so the crown stands well
        above a man. At 3.5 m it was chest height — a houseplant.
      · THE CROWN REACHES UP. Oldest leaf tilt 2.1 rad -> 1.55: in the photos
        very little hangs below the stem's top. At 2.1 the old leaves lay flat
        and it read as a rosette on a post.
      · THE LEAVES ARE SHREDDED. Tears 14 -> 26; in the open the wind cuts a
        banana leaf to the midrib within weeks, and an untorn one reads as
        plastic at any distance.
      1,589 / 563 / 96 triangles for the whole clump.
      ONE THING I NEARLY "FIXED" THAT WAS RIGHT: the pseudostem renders
      brown-tan and I was about to make it green. The plantation photographs
      show it IS brown — dried sheaths — over the lower half. Checked before
      changing it.
## TREES AND VEGETATION — what is still open (rolled up 2026-09-23)

Everything below is also filed in its own place; this is the short list so it
is not lost while Kurtz is being built.

- [ ] **YOUR ASKS 2026-09-24 (after the FX work)**:
      1. Some trees look WAY TOO BRIGHT, others too DULL — the species don't
         sit together. Match them (one light/colour budget across every
         vegetation system).
      2. "I'm sure we can do a better jungle now" — the jungle as a whole.
      3. The ENEMY SIDE looks empty compared with ours (see THE ENEMY SIDE
         below: "Fill their base" is still open).
      · DONE (uncommitted), 1 + your "the colours are flat" call:
        - THE FAN PALM was the bright one: tall slot 0 used to be the susuki
          (repainted by tools/namVegPalette.mjs); the fan palm replaced it
          with its PRESET's lime (#33601f/#86a83a) and nothing repainted it.
          Measured in the game against the coconut palm: 0.186 vs 0.130 mean
          luminance -> #2f5921/#72943a (~0.132). In the palette tool now.
        - FLAT: every leaf card was drawn WHITE, so a leaf was one colour and
          the only gradient was plant base -> top. Now the leaf textures carry
          a per-leaf SHADE (the banyan's `shade: true` path, multiplied into
          the colour): fan = PLEATS (each segment a lit and a shaded half,
          dark hub); banana (+ traveller's palm) = pale rib, lit by the rib
          rolling darker to the edge, veins, torn strips each a tone;
          coconut/nipa/areca frond, fern and bamboo/sugar-cane spray =
          each leaflet darker at the rachis, lit along its body, its own
          tone; lance (bush, ground cover) = creased down the rib, one half
          lit. Cost: none (texture only; GPU 1.10 ms as before).
        - SUGAR CANE was the pale lime clumps all over the valley floor
          (found by tinting types magenta): shaded spray + tip #6d9440 ->
          #5e8339.
        - Tried and NOT kept: lowering the top-down normal lift (0.7/0.5 gave
          depth but not the fix; the flat CARD was the cause), turning the
          sky light off the leaves (no change).
        MEASUREMENT TRAP (for next time): a lineup A/B that hides the plants
        also hides their SHADOWS on the grass, which get counted as plant;
        turning shadows off instead removes the plant's self-shadowing.
        **YOUR LOOK CHECK**: the fan palms, bananas and sugar cane at your
        zoom. NEXT: the jungle as a whole (2), the enemy side (3).
        COMMITTED 35f4f54.
      · (2) THE JUNGLE — survey 2026-09-24: the map has NO canopy. Every
        "tree" is a palm or bamboo; the ground is meadow, ferns and rock
        slopes (savanna, not jungle). YOUR CALL: **"Frame the fight"** —
        dense canopy on slopes, ridges and edges units cannot walk anyway,
        thick bands between areas, single trees and groves on the playable
        ground, fighting ground kept open. (Not: canopy everywhere with a
        see-through fade near units — the alternative, not chosen.)
        DONE (uncommitted):
        [x] THE CANOPY TREE — v3/render/foliage/dipterocarpGeometry.js, kind
            + preset `dipterocarp` (30 m): clean pale bole, plank buttresses,
            an UMBRELLA OF CAULIFLOWERS (a middle head + 5 round it on thick
            limbs), each head billboard leaf clusters (the banyan texture)
            carrying ITS OWN head's rounded normal, so each shades as a ball
            and the canopy reads as lumps with dark cracks. The banyan's tube
            code is now a shared `woodKit`. In the map's 4th tall-plant slot
            (tools/namJungle.mjs), bark #6c685b.
        [x] PLACEMENT — games/nam-rts/jungleCanopy.js, painted at boot into
            the alpha channel through a new engine call
            `app.paintTallPlantChannel(ch, fn)`: dense on slopes >34° (the
            nav limit) + 4 m spill, the map edge (wobbled), groves from
            low-frequency noise; cleared round the camp (75 m), enemy HQ (60),
            points (30), enemy positions (16), hamlets (55), temple (70),
            feathered 18 m; dirt roads kept clear by the engine's paint mask.
            First try spilled 12 m and put the open centre under canopy (a
            crown overhangs ~10 m). ?canopy=0 = the old map. 125 ms at boot.
        [x] MEASURED (x1.55 resolution, rAF frame time, hidden by layers):
            canopy ON is FASTER — play zoom 29.0 vs 36.3 ms, max zoom-out
            31.7 vs 34.2. The crowns hide the expensive ground foliage and
            terrain under them (the banyan showed the same).
        TRAPS FOUND ON THE WAY: `sampleTallPlantDensity` reads RGB only (it
        predates the 4th slot) — so concealment ignores the canopy, and any
        coverage stat from it counts palms, not trees. Hiding the tree meshes
        with `.visible` STAYS hidden (the field never re-shows them): use
        `layers.set(31)` for A/Bs — the first A/B measured nothing.
        [ ] **YOUR CALL**: should standing under canopy CONCEAL units (make
            cover.js read the tree channel)? Gameplay change — ask first.
        [ ] the undergrowth under the canopy (ferns/bananas thicker there).
        [ ] the long pale trunks at the screen edge (perspective) — judge.
        [x] YOUR SCREENSHOT (2026-09-24): hard horizontal shadow STRIPES on
            the crowns + "reads too low poly". (1) The banyan's bug again:
            the scatter FIELD never passed `viewPos`, so in the shadow pass
            the billboards turned to the SUN and cut across their
            camera-facing twins — fixed in foliageSystem (viewPos =
            the field's uCamPos). (2) A few big cards per head showed the
            card outline: 140 clumps at 0.8 size instead of 70 at 1. Rounded
            normals WERE on (each card carries its head's outward normal,
            lifted 35% to up) — the stripes were hiding them.
            Fallback if the billboards still read wrong: fixed cards lying
            on each head (the banyan's `billboard: false` path).
        [x] YOUR ASK (2026-09-24): "more palm trees in the jungle" + the
            traveller's palm "only in the village". THE FRINGE
            (jungleCanopy.js): coconut and fan palms painted along the
            canopy's sunlit margin (9-28 m out from the slope forest, past
            the map-edge forest, round grove rims), in separate patches,
            ADDED on top of the map's own palm paint (new engine option
            `paintTallPlantChannel(..., { blend: "max" })`); 61 traveller's
            palms scattered on the same fringe (PlacedFoliage, 20 m apart).
            Trap: the band alone put palms UNDER overlapping crowns — the
            fringe now also requires no forest within 10 m (a crown's
            overhang). Fan palm darkened again (#2a5020/#5c8034): seen from
            straight above its fans face the noon sun full on and still read
            lime. Boot: 393 ms for the whole jungle.
        NEXT (your order, 2026-09-24): [x] the undergrowth under the canopy,
            then [ ] the enemy base.
        [x] THE UNDERGROWTH (done while you were out, uncommitted):
            jungleCanopy.js paintUndergrowth — giant fern, card fern and bush
            painted in drifts (two-octave noise) under the canopy, wild banana
            on the sunlit fringe, ADDED on top of the map's paint through a
            new engine call `app.paintFoliageChannel(ch, fn, { blend })`. The
            field's own slope rule still thins it past ~44°, so the steepest
            rock keeps saying "unwalkable". The cracks between crowns now
            show fern, not bare slope.
            SPEED TRAP: evaluated per paint texel (1 m for the ground paint)
            the jungle took 2.9 s of the boot — the fringe's under-canopy
            test is 7 forest samples. The rule is now BAKED once onto a 2 m
            grid (canopyField) and every painter reads the grid: the whole
            jungle (canopy, palms, undergrowth, 67 traveller's palms) is
            484 ms.
            MEASURED (x1.55 res): play zoom 26.9 ms (29.0 before the
            undergrowth), max zoom-out 30.9 (31.7) — no cost.

## FOG — your asks, 2026-09-24 (TALK FIRST, do not code yet)

**DO NOT TOUCH THE EXISTING FOG** (the monsoon height fog + distance fog we
tuned). Anything below is ADDED next to it.

- [ ] **Fog at a PLACE** — local fog banks: a valley bottom at dawn, mist
      over the river, a swamp, the paddies. The fog lab's GroundFog
      (v3/fog/groundFogTsl.js) is already a LOCAL volume (a box over the
      ground with its own density field), so a bank is one of those placed on
      the map: position, size, height, density, colour. Authored per map
      (editor, like lakes) or placed by the game.
- [ ] **The fog lab's interactive dense fog in the game** (v3/fog-lab.html:
      the gist port — one density texture, analytic wind/push/swirl,
      semi-Lagrangian advection, raymarched slab, obstacles carve holes).
      What it would give an RTS: units wading through a bank and leaving a
      wake, a Huey's ROTOR WASH blowing a clearing, a shell blast punching a
      hole that heals. Open questions: (1) SCALE — the lab sims 30 m at 256²;
      an RTS view is 150-400 m, so banks of ~60-120 m each at lower res, only
      where authored, not a global sim; (2) COST — the raymarch is per pixel
      covered x 32 steps, and this game is pixel-bound (terrain), so it must
      be measured at play zoom before it ships; (3) moving obstacles (units)
      need the obstacle LOOP back (the lab bakes static ones into a mask) —
      fine for tens of units near a bank, not hundreds; (4) GAMEPLAY — should
      a bank block line of sight like smoke? It could feed the same
      deterministic occlusionBetween the smoke columns use (the sim stays
      decoration, the bank's footprint decides).
        **YOUR LOOK CHECK**: the jungle at your zoom; ?canopy=0 for before.

- [ ] **The jungle tree is committed but NOT good.** Waiting on your reference
      picture. The roots read as cardboard fins and the crown is a blob.
- [x] **BANYAN — the big tree** (your ask 2026-09-24). BUILT
      (`banyanGeometry.js`, `banyanLeafTexture.js`, kind + preset `banyan`,
      18 m tall, ~40 m across; 7080 / 2564 / 480 tris, most of it wood).
      Planted on the OUTSKIRTS, not inside anything (your rule, 2026-09-24:
      it is so big it hides whatever it stands over; keep it clear of
      villages and camps). One is past the hamlet's lane end, beside the road
      (`HAMLET_OUTSKIRTS`), and one is off the temple's west gallery
      (`TEMPLE_OUTSKIRTS`). Neither is in the plans, which are the places
      themselves. Its 3 m trunk blocks nav.
      **RULE for any future banyan**: crown ~40 m across, so the trunk stands
      ≥ ~25 m from anything the player needs to see, and off roads.
      · CROWN: ~60 BIG camera-facing leaf-cluster cards on a lumpy
        half-ellipsoid, NO solid core (your calls: the arborist page's
        billboards, fewer + bigger cards, no green blob). The cards carry
        the dome's ROUNDED normal (outward, then rounded again from the
        crown's centre) and are lifted only 35% to up, so the crown shades as
        a ball. The texture keeps a per-leaf SHADE in its RGB
        (alphaCoverageMips `shade`), lit from the card's top: top-lit
        sub-lumps read as cauliflower; a radial dark heart read as lettuce.
      · BILLBOARDS are a new shared card part (6 + lift) in the foliage
        shader, with `billboard: false` on the type as the A/B switch. Two
        lessons in the code: the cards are pushed toward the camera by 70% of
        their size, and they face the PLAYER's camera in the shadow pass too
        (`viewPos`). Without that they turned to the sun there, crossed their
        own camera-facing twins, and striped the crown with straight cuts.
      · TRUNK: fused strands with long low root spurs splitting into 7 limbs,
        wrapped in CORDS (aerial roots grown down the trunk); hanging roots
        and ground-reaching pillars under the crown.
      · MEASURED: no cost. Hiding it made the frame 0.08 ms SLOWER, since
        its crown covers ground and plants that are otherwise drawn.
      **YOUR LOOK CHECK**: the crown from the RTS camera, the bark colour
      (#5c4a3a), and whether the vegetation lab matters to you. Its copy of
      the shader has no billboards, so the banyan's cards collapse there; judge
      it in the game.
      MAYBE LATER: a sparse banyan jungle field (needs a tall-plant slot).
- [x] **Raise the bamboo** (your call 2026-09-24): 9 -> 16 m, written into
      the map by `tools/namPlantScale.mjs` WITH its proportions. The culms
      stay ~15 cm (stemWidth 0.75), the sprays grow (leafletWidth 0.9;
      0.65 kept them the same size in metres and the stand went to grey
      sticks at RTS range), and there are 26 internodes. 34 cost +0.57 M
      scene triangles for rings nobody can see.
      **YOUR LOOK CHECK**: the stand at normal zoom; it is still a little
      see-through at the far detail level.
- [x] **The faceDirection winding bug — FIXED in the coconut palm and the
      areca** (2026-09-24). Same fault as the fan palm's black coarse trunk:
      part 3 shades with its normal multiplied by `faceDirection`, so on a
      DOUBLE-SIDED quad the back face flips, and a crossed pair always shows
      one. Both far trunks are part 2 now (same `colorHead`, shaded like a soft
      body with its normal turned toward the viewer) and a little wider, since
      a crossed pair only shows its full width square on.
- [x] **Bamboo is 9 m** (DONE 2026-09-24: 16 m, see above) where real giant bamboo is 20-30, the same error the
      palm had. Your call, as the palm was.
- [ ] **Re-shoot the whole-map lineup** (`window.__sheet` in the lab) now that
      the bush, ground cover and banana have changed, to see what the jungle
      floor actually became.
- [x] Fan palm: the diamond leaf-base boot pattern on the trunk — done
      2026-09-24 (d0f3970, see the entry above).
- [ ] Fan palm: a dry-season colour.
- [ ] **Coconut palm + areca far trunks** are still crossed part-2 quads,
      alpha-tested against the frond texture. The traveller's palm LOST its
      far trunk that way, because the mip blurred a thin solid strip into
      transparency. Check them at range and move them to the closed-tube
      trunk if they thin out.
- [ ] Areca: keep as a village plant or drop it — your call.
- [ ] Colour variety across the foliage (flame tree, a few flowering trees).
- [ ] Readability thinning where plants hide units and combat.
- [x] **Plant sizes written into nam-valley.v3proj** (2026-09-24,
      `tools/namPlantScale.mjs`): palm 11 -> 17 m with its proportions
      (stemWidth 1 -> 0.7, fronds 50% -> 32% of trunk, 36 scar rings), banana
      3.5 -> 5 m with leaves at 92% of the stem and 11 of them.
      THE RULE THIS IS A REMINDER OF: the presets in foliageScatterState.js are
      only DEFAULTS FOR A NEW PLANT. A saved project carries its own copy of
      every number, so nothing tuned in the engine is visible in the game until
      a tool writes it into the map. Everything done to the palm and the banana
      on 2026-09-23 was invisible for a day because of this.
- [x] **SUSUKI IS OFF THE MAP, FAN PALMS ARE ON IT** (your call 2026-09-24,
      `tools/namFanPalms.mjs`). Susuki is *Miscanthus sinensis*, the silver
      plume grass of Japanese autumn hillsides — it was here only because it
      was the first plant the tall-plant field ever held, and it does not read
      Vietnam. Dropping it freed the slot the fan palm needed.
      TWO THINGS HAD TO CHANGE TOGETHER, which is why it is one script: the
      SPECIES in slot 0 (the map carries its own copy of every number) and the
      PAINT in channel 0. Susuki had been painted as a grass would be; left
      alone, every one of those texels would have become a 16 m tree. The
      channel is cleared and repainted for a big tree: open lowland floor only,
      0.12 coverage, gathered into stands by a broad noise octave with the
      lower half of the range rejected so there is open ground between them.
      As it happens susuki was never painted here at all (0.0%), so nothing was
      lost. Fan palms now cover 4.7% of the map.
      **YOUR LOOK CHECK**: the first stand reads dense — closer to a plantation
      than to scattered palms. `TARGET` in the script is the knob.

- [x] **TRAVELLER'S PALM / Ravenala** — your reference photos, 2026-09-23 (two
      of the three you sent are this plant). THE flat-fan silhouette, and
      nothing on the map has anything like it:
      · long BARE petioles, all in ONE PLANE, radiating from a stacked base —
        a peacock's tail, not a crown. From the side it is a huge flat fan; end
        on it nearly disappears. That plane is the whole plant.
      · each petiole ends in a torn BANANA paddle, wind-split along its veins
      · the base is a fat stack of overlapping leaf bases, pale green
      · 8-12 m, ornamental — planted at houses, temples and town gardens in
        Vietnam rather than growing wild in the jungle, so it belongs at the
        hamlet, the resid ence and the temple approach, not scattered in the
        canopy. It is the right plant to make a PLACE look planted.
      Cheap to build: the existing banana blade texture on long straight
      petioles, all at one azimuth. Probably the best look-per-triangle on the
      whole list.
      **BUILT 2026-09-24** (`travellersPalmGeometry.js`, kind + preset
      `travellersPalm`, 12 m, 1331 / 435 / 197 tris). Checked against your
      photo in the vegetation lab. Three fixes came out of that comparison:
      · the SHEATH is a narrow V (about ±35°) with the petioles opening out
        from its top edge. My first build made it a half-disc, which read as
        a paper fan.
      · the blades lie IN the fan's plane (a custom card builder: the palm's
        `addFrondCards` lays blades out horizontally), and they are dark.
      · black blades: the shader flips any leaf normal that faces away from the
        camera, so a normal lying in the fan's plane flipped at random.
        Blade normals are now mostly UP. Fine from the RTS camera; at
        eye level in the lab one half of the fan still goes dark. That is
        the shader's flip rule and not the plant, so it doesn't matter in the game.
      · the far trunk is a closed 4-sided tube, not crossed strips: part 2
        is alpha-tested, and the mip blurred the trunk away.
      **ON THE MAP 2026-09-24 as PLANTED plants** (your pick of option (a)):
      three at the hamlet (a pair framing the square behind the well, one in
      a back yard) and a pair flanking the temple gate. Plans list them like
      any piece (`travellersPalm` in hamletPlan / templePlan; the village test
      checks their trunks for collisions too). Plans call `app.plant(...)`
      rather than importing the renderer, so they stay plain data.
      · ENGINE: `v3/render/foliage/placedFoliage.js` — plants at exact
        points, same geometry and the SAME material as the painted fields.
        The material moved out of FoliageScatterSystem into
        `createFoliageMaterial({ src, u, headTex })`; `src` says where a plant
        is (the field's compute buffers, or two per-instance vec4s here).
        One instanced draw per type × LOD, LOD chosen on the CPU. Any foliage
        kind can be planted this way; add it to PLANTED in
        games/nam-rts/placedPlants.js.
      · Fans face the DEFAULT camera (+Z), not the site's rotation: the hamlet
        is turned so its lane runs north–south, and facing the lane put every
        fan edge-on to the player — a pole. Q/E rotation will still show them
        edge-on at 90°, which is what the real tree does.
      · Colours darkened for the game's light (#1b3f22 / #8f9c48): the lab
        colours read pastel in the game.
      · MEASURED: +0.06 ms GPU at hamlet zoom (1.34 vs 1.28 ms, ±0.12 noise).
      **YOUR LOOK CHECK**: fan size against the houses (12 m; the hamlet ones
      are 0.85–1.05×), the pale DEAD leaves hanging under each fan
      (`plumesPerStem`, 2 now), and more of them — the résidence, a yard or two.
- [x] **Fan palm trunk: the diamond boot pattern** — your third photo shows it
      clearly. A fan palm keeps its old leaf BASES on the trunk in a
      criss-cross diamond lattice for years before they shed. Currently the
      trunk is smooth with plain rings. It is the detail that makes the trunk
      read as a palm rather than a post, and it is a texture job, not geometry.
      **DONE 2026-09-24**: a lattice in the culm shader, switched on by
      `along` 2 (outside the rings' ±1), 6 boots round × 20 up. Each boot is a
      SCALE, not a cell: pale weathered face below, a dark hollow above where
      the next boot overlaps. The first try, with flat cells, read as a woven
      basket. Rings got a seam vertex so the lattice closes, and a jagged
      radius so boot ends break the outline. The lattice fades to its average
      colour by `fwidth`, so it doesn't shimmer at RTS range. The far trunk is now a
      closed 4-sided tube, the same fix as the traveller's palm. Judged in the
      game: the vegetation lab keeps its own copy of the shader and does not
      show it.
- [ ] **Palm variety for free**: the palm is procedural, so every instance can
      differ at no draw cost — trunk curve/lean, height, crown size, frond
      count/droop, dead hanging fronds. Per-instance params, not new types
- [ ] **New palm-like types** (your photos): **areca palm** (clumps of thin
      ringed canes, feathery arching fronds), **sago / cycad** (short fat trunk,
      stiff dark rosette), **spike-leaf** yucca/dracaena/pandanus look (stiff
      sword leaves in a ball on a trunk; pandanus has stilt roots — riverbanks),
      nipa palm (no trunk, fronds straight out of the mud — river/delta edges),
      banana (big torn paddle leaves, around villages)
- [ ] **Colour variety** in the foliage (reds, yellows, flowering trees —
      flame tree / poinciana orange, a few)
- [ ] **Readability pass after**: thin the small foliage where it hides units
      and combat (ties in with see-through, below)
- [~] **Vehicles rebuilt** — FIRST DONE: **M113 ACAV** (`rtsVehicles.js`, 5.1k tris, 2 draws for
      every one on the map): sloped hull + trim vane, 5 road wheels, sprocket,
      idler, a track of shoes, ACAV shields round the .50 cal and both M60s,
      stowage, stars + bumper code; replaces the BTR as the HQ's APC.
      FINISHED (your go 2026-09-22): the ACAV cupola TURNS to its target; the
      wheels turn and the track shoes roll in the vertex shader from each
      vehicle's odometer (one draw, no CPU per wheel; gear attributes
      interleaved — WebGPU's 8-buffer limit); 4.4k tris. Canvas texture's
      weave was at the pixel limit and crawled like z-fighting — fixed.
      **M48A3 Patton** DONE (replaces the Battle Tank): cast hull + egg turret,
      90 mm with bore evacuator + T brake, xenon searchlight, cupola .50,
      fenders + stowage boxes, basket, 6 road wheels + return rollers, rear
      sprocket; turret turns, tracks roll; 6.9k tris.
      **M151A1 MUTT jeep** DONE (replaces the rts-v3 jeep, a closed modern
      box): open tub, slotted grille, hood star, windshield folded under
      canvas, wire-cutter bar, M60 on a pedestal with its gunner (they turn
      together to the target), driver, camo-covered helmets, spare wheel,
      jerry can, whip; wheels roll; 2.8k tris.
      **UH-1H Huey** DONE (replaces heli5.glb): cabin with glazed nose, doors
      slid open with a door gunner + M60 each side, engine hump + exhaust,
      two-blade rotor + stabiliser bar (spins), boom with elevator, fin, tail
      rotor (spins), skids, U.S. ARMY + stars. REBUILT at your word ("too low
      poly"): a LOFTED skin (14 superellipse stations, Catmull-Rom) nose to
      tail; glazing, frames, doorway, slid door and markings laid ON the skin;
      airfoil blades with droop, grips, stabiliser bar; tube skids; flight-
      helmeted door gunners; tail number. ~14k tris (instanced). NEXT on it: a faint
      rotor-blur disc (the blades strobe at speed), Dustoff medevac variant.
      **M551 Sheridan** DONE (replaces the Light Tank GLB): flat aluminium
      hull, rolled flotation screen, LOFTED low turret, short fat 152 mm,
      searchlight, smoke dischargers, ACAV-shielded .50, bustle rack, 5 road
      wheels + rear sprocket; 7.3k tris.
      **M35A2 deuce-and-a-half** DONE (replaces the builder's truck GLB, as
      the engineer truck): lofted hood, flat fenders, brush-guarded lamps,
      winch, open cab with canvas top + driver, stack exhaust, spare wheel,
      slat bed with canvas bows, engineer cargo (timbers, sandbags,
      concertina, pickets, jerry cans), 6x6 with rear duals; wheels roll; 6.7k tris.
      **The US roster in the HQ is now all procedural** — no rts-v3 GLB left
      on a player vehicle. LEFT: delete the unused rts-v3 GLBs from the nam
      build; dust behind tracks.
      ROSTER still to build (Vietnam only): US — M35 gun truck variant,
      AH-1 Cobra, M132 Zippo, PBR boat · enemy — PT-76, Type 59/T-54, ZPU AA,
      Molotova truck, sampans, supply bicycles. Was: **Vehicles are too low poly** — rebuild them for this game: procedural
      on the parts kit (like the buildings) or your Blender work; LODs; the
      silhouette readable from the RTS camera (M113, M151 jeep, M35 truck,
      M48 tank, Huey); instanced so 100 cost a handful of draws

## Props → a real part of the game

- [ ] Props into the **editor as placeable types**, each with: a declared
      footprint → flattened pad, **collision** (nav stamp from the real footprint,
      not the bounding box), **cover** bake, grass cleared under it, markings
- [ ] **See-through**: silhouettes for your hidden units (and spotted enemies
      only — concealment must still work), canopy dither around selected units /
      cursor, roof fade. Discussed, not built
- [ ] Camouflaged HQ-style buildings (the camo surface exists)
- [ ] **Enemy HQ** — still the old box. French colonial building taken over was
      liked
- [ ] **Village kit, built in the lab** as a modular kit, looking really good —
      incl. a small hut with a **big banana-leaf roof**; bamboo stilt house,
      granary, fences, jars, baskets, shrine, well, footbridge, sampan, fish
      traps, market stalls
- [ ] Battle debris: burnt jeep / truck / tank / Huey hulks, burnt hut, shell
      casings (hero pieces may be **your** Blender work)
- [ ] Nature/road extras: fallen logs, stumps, termite mounds
- [ ] More sign faces (propaganda boards, shop signs, tin ads, arrows)
- [ ] Kit bug: `rtsParts.buildSheetRoof` stands its sheets on edge (only the lab
      uses it)
- [x] Quonset HQ with opening doors · US flag · guard tower · billboards (2/4
      posts) + sign sheet · MINES sign · gun pit, fuel dump, crate stack · GP tent
      + **medic tent** · Conex + yard · ISO container · radio station (kit) ·
      stencil markings (U.S. ARMY, red cross, codes) · camo surface · old
      container repainted · tank traps · z-fighting sweep + test
- [x] Buildings flatten a pad to their own footprint (race with River v2 fixed)

## Map & look

- [x] **Birds** — transit + flushed by explosions (see Now)
- [x] **Grass coverage** — DONE 2026-09-23, and the old proposal turned out to
      be aimed at the wrong thing. Marking the blades magenta showed the FAR
      HAND-OFF already covers zoom-out: past the blade fade the terrain is
      painted with the blades' own average colour, so there is no bald ring and
      no zoom-driven tile/fade/width is needed. What WAS missing was paint.
      MEASURED in the running game: density covered 60.3% of the map at mean
      0.43, and 27% of the whole map was gentle, walkable, dry ground with no
      grass at all — of which **54.5% was the Jungle floor layer** (the gap),
      31.9% beach sand and 10.1% dirt road (both correctly bare).
      `tools/namGrassPaint.mjs` paints the jungle/lowland floor only, with two
      octaves of noise so it reads as undergrowth and not a lawn: coverage
      **61% → 79%**. It needs no slope logic (the grass system rejects steep
      ground at runtime) and no knowledge of the camp/hamlet/temple (they clear
      their own ground at boot).
      COST, measured with `__V3_DEBUG.gpuAB`, the whole grass system on vs off:
      **0.67 vs 0.60 ms** at play zoom, **0.81 vs 0.76** zoomed out. The extra
      coverage is free; grass is not what this frame is spent on.
      LEFT: nothing — grass trails are wired too, see below.
- [ ] **Foliage brightness** — **you**, taste call (knobs listed in the transcript)
- [ ] Rice paddies (expensive: water over big screen areas)
- [ ] A village as an *arrangement* (paths, well, fences, clearing)
- [ ] Pre-placed craters and wrecks (craterSystem exists)
- [ ] Telegraph poles along roads
- [ ] **Ocean** — off in the RTS; **you** are reworking Ocean v2 in another chat
- [ ] **River** — **you** are finishing/optimising River v2 in another chat;
      then river branches → **water units**, lily pads on the flow field
- [x] **Grass trails under units** — DONE 2026-09-23. `games/nam-rts/grassTrails.js`
      stamps every ground unit into the engine's push field (`app.stampGrassPush`),
      which nothing in this game was using, so the grass stood up through a tank's
      tracks. Four guards keep it cheap: only units within 34 m of the camera
      focus (the field only covers ~32 m), ground units only, at most 16 stamps a
      frame nearest-first, and the field's own skip for a still crowd whose stamps
      have stopped changing. Dev panel → GRASS → **Unit trails** turns it off.
      COST, 30 men walking at RTS zoom, `__V3_DEBUG.gpuAB` with the settle long
      enough for the recovery tail to end: **0.73 → 0.76 ms GPU (+0.03)**, noise
      0.02; CPU **1.3 µs a frame** (500-call bursts). Verified the A/B could see
      it at all: the frame's timestamped pass count goes 17 → 18 when it stamps.
      OPEN, taste: at RTS zoom the bend is subtle — say the word and the footprint
      (1.1 m) and strength (0.85) become panel sliders.
- [x] **GROUND TEXTURE SCALE + new Poly Haven sets** — DONE 2026-09-24, **your
      verdict in the game: "the 7m look way better"** (fog off, grass off, same
      frame A/B vs the old 34 m). Note for later: 34 m shows MORE visible
      features (the photo magnified — metre-wide clumps); do not "restore
      detail" by stretching again. Open: road at 15 m had nicer gravel
      (`--tile 4=15`); beach set not yet looked at over the coast. (your ask 2026-09-24, after
      the "why does CoH look more detailed than mine" comparison). Two findings,
      both measured off the saved map, not guessed:
      1. **`uUVScale` is repeats across the WORLD, so tile metres = worldSize /
         uvScale.** nam-valley is 1024 m, and the ground layers sat at uvScale
         28–42 = **one texture tile every 24–37 metres**. The Poly Haven sets in
         those slots (forrest_ground_01, red_laterite_soil_stones,
         dry_mud_field_001, red_dirt_mud_01) are close-range photos of ~1–2 m of
         ground, so every pebble was rendered 15–35× oversized. That is the
         "big soft wash instead of detail" look — NOT a resolution problem
         (1024 texels / 34 m is already 3 cm a texel) and NOT the layer count.
         Cliff Rock was the outlier at uvScale 110 (9.3 m) and reads better.
      2. **Slot textures are resampled to SLOT_RES = 1024**, so fetching 2K/4K
         from Poly Haven is wasted bytes — 1K jpg is exactly right.
      Changing UV scale is **free** (a multiply on the UV, zero taps).
      TOOL: `tools/namGroundTextures.mjs` — downloads Poly Haven 1K sets into
      `public/textures/ground/<slug>/` (via api.polyhaven.com/files) and patches
      nam-valley's paintLayers in place: texture refs + uvScale together. Server
      paths, not base64, so the sets leave the .v3proj instead of bloating it.
      Finer tiling can expose repetition — macro is already on (0.35 @ 80 m);
      the hex-tiling line below is the real fix if it bites.
- [x] **PHOTOGRAPHIC DECALS + decals glued to the live ground** (your ask
      2026-09-24: "check the decals, make better ones", toward CoH).
      TWO problems, found in the game with fog off:
      1. **Most decals at the base NEVER DREW.** Toggling all 510 off gave an
         identical frame. The camp levels its ground at boot (flattenRect /
         flattenArea / berms / ramps, and every building placed mid-match),
         AFTER the decals were placed — a rut at y 18.4 over ground now at
         12.0 floats outside its box and paints nothing. 136 of them missed.
         FIX (engine, decalSystem.js): with `groundHeight`, each box is shifted
         in the VERTEX stage onto the live ground under its centre, the shift
         passed to the fragment stage. Follows any later edit; `py` untouched.
      2. **The art was synthetic.** The shader REPLACES colour + normal, so a
         smooth tinted patch deleted the photo ground and pasted a sticker,
         with no normal map to catch light. NEW `decalPhotoArt.js`: every
         decal cut from a Poly Haven photo sampled IN METRES (same scale as
         the ground), with a height field in metres -> real normals: 5 cm
         ruts with berms + tread, grousers at the true 16 cm pitch, clods,
         wet mud, puddles. `tools/namPhotoDecals.mjs` writes them to
         public/textures/decals/nam/ and re-lays the map: 25 m strips ->
         10 m chaining segments (the square art had been stretched 4x),
         mud/puddles squared, variants (ruts x3, tracks x2, mud x2).
         510 -> 1085 decals, 10 -> 14 slots, level 10.7 -> 9.6 MB.
      Tuned by eye: mud roughness 0.4 (0.3 glinted white like snow, 0.55
      vanished); puddles/mud from the ROAD's red soil (grey mud photo made
      blue-grey rings); water light ochre (dark read as tar holes); aprons
      laterite, not grey gravel (pale foreign patches).
      OPEN, **your look**: the mud's sun-side glint.
      **RUTS THINNED (your call, same day):** a straight 10 m decal cannot
      follow a curving path (median strip bend 30°, p75 45°) and ruts along
      every metre read as a stencil. `tools/namThinRuts.mjs` keeps a short
      10-20 m patch only on STRAIGHT stretches (bend < 8°), >= 70 m apart:
      843 segments -> 24 in 16 patches. Curve-following ruts would need a
      spline strip mesh — not worth it (agreed).
- [x] **APRONS UNDER EVERY BUILDING** — DONE 2026-09-24.
      `games/nam-rts/buildingAprons.js` wraps `app.flattenRect`, the one call
      every pad goes through (HQ, masts, gate, placed objects, player builds
      mid-match), and lays a laterite apron turned with the footprint, 2.2 m
      past it; big footprints tiled with <= 16 m boxes so the grain does not
      stretch; grass/ferns cleared from the apron's solid core only (the zone
      round a mast keeps its grass). 133 at boot. Engine: `app.decals`
      exposes the decal system to games. The 11 old grid aprons are gone.
      Verified mid-match: flattenRect at a new spot -> apron + cleared pad.
      [x] **Swept-earth yards for the village** (same day): flattenRect takes
      `ground: "laterite" | "swept" | "none"`, placedObjects passes an
      item's `ground` through, village.js asks for "swept". New
      `sweptYard` art (decalPhotoArt): the Lowland floor's own photo, grain
      flattened (nW 0.12), a dusty step lighter, broom arcs 22 cm apart as
      3-6 mm relief that only a raking sun picks out. 34 yards at Ap Bang;
      the slot is added at runtime (the map does not carry it).
      Your "do what looks best" (same day): yards toned from chalky beige
      to warm tan (mul 1.18/sat 0.9 -> 1.1/1.0 — still a step lighter than
      the field), and the TEMPLE swept too (12 yards; laterite under a
      pagoda read US-military).
      **REVERTED after the checkpoint (your call):** camp aprons and temple
      yards removed — side by side with the build before, the camp was
      barer (the apron clearing stripped the ferns) and the pads merged into
      one flat red patch; jungle up to the walls is what looks real, and
      ruins should be overgrown. ONLY the hamlet's swept yards stay (34).
      flattenRect now stamps nothing unless the call asks for a `ground`.
- [ ] **CHECKPOINT FINDINGS 2026-09-24** (fair A/B: worktree at a29c4eb vs
      HEAD, settings aligned, fog off, ONE tab — two tabs rigged the first
      perf numbers):
      · ground tiles: at play zoom the old 34 m read MORE detailed than 7 m;
        the first A/B that chose 7 m ran with stochastic tiling on + 85 %
        render scale (stale MCP-profile localStorage). **Re-decide** — the
        real answer is two-scale texturing, see the terrain plan.
      · decals: +~0.6 ms native (36.2 vs 33.9 ms at 3840x1778; decals hidden
        32.7) — measured WITH the camp aprons, mostly their big boxes; re-
        measure now they are gone.
      · old blue-grey puddles read as water better than the new red ones at
        play zoom.
- [~] **TERRAIN: TOP-K LAYERS + NEAR/FAR** (the CoH / Unreal answer to "every
      layer costs everywhere", 2026-09-24). splatOverlayTsl, compile-time,
      DEFAULT OFF (classic path unchanged): `SPLAT_FEATURES.topK` computes
      every layer's final weight first, picks the K strongest per pixel and
      samples only those (per-pixel array slice, no branches); triplanar /
      rock-shaded layers stay static. `farBlend` adds each chosen layer's
      albedo at a tile uFarRatio (5x) bigger, faded in uFarStart->uFarEnd
      (35->90 m) — ends the 7 m vs 34 m argument. A/B by URL on any page:
      `?topk=3`, `?topk=3&far=1`, `?topk=0`.
      MEASURED (3840x1778, one tab, in front, same view): classic 35.5 ms
      (p90 50), top-3 33.7-34.0 (p90 33.5), top-3+far 34.9-35.1. LOOK: with
      far on, the road reads clods and pebbles at play zoom where classic is
      flat red; no top-3 seams seen at the clearing.
      **GAME DEFAULT since 2026-09-24** (your call; `?topk=0` = classic). NEXT: a
      separate FAR texture per layer (aerial sets like rocky_terrain_02) as
      extra array slices (no new sampler bindings — the terrain sits at 16).
- [~] **LOAD TIME** (your ask 2026-09-24: every change means a reload, so
      it taxes all the work). MEASURED clean loads (tab in front; one load's
      own stage times recovered from the smoothed store as 2·new − old):
      **46.2 s -> 23.8 s** (warm dev server; the first load after editing a
      module is ~12 s slower — Vite re-transforming, not the game).
      Two fixes, both in the engine:
      1. **Heightmap readbacks only when they can return anything.** One
         GPU->CPU readback is ~115 ms whatever it reads; flattenRect stamped
         on the GPU then read back (230-370 ms a pad, ~100 pads at boot).
         Now flattenRect writes the CPU mirror (0.2 ms), raiseBerm too, and
         ONE upload per frame flushes every CPU edit (flushCpuHeightEdits);
         ensureCpuHeightmapFromGpu skips when nothing on the GPU is dirty.
         Verified: pad flat to 1 mm, smooth rim, raised pad visible on the
         rendered terrain (the GPU got it).
      2. **No shoreline bake while the ocean is OFF.** nam-valley keeps ocean
         mode "v2" with the ocean disabled, and every height sync rebaked the
         v2 shoreline field (~150 ms) — ~11 s of boot for water nobody sees.
         worldEnvironment now skips it while disabled, bakes on enable.
      Round 2 (23.8 -> 21.6 s): frame loop throttled to 4/s behind the
      loading screen (app.setFrameThrottle), no editor default palette
      (preloadPaintTextures: false), portrait readbacks in parallel.
      Round 3 (21.6 -> 21.0 s): portraits PNG-encoded off-thread (blob URLs,
      was 1.8 s), crater alpha in the shader (was a ~0.9 s pixel loop), the
      19-surface RTS atlas built in a WORKER (rtsAtlasWorker.js, same
      generator — was 2.6 s; rtsAtlasReady() before portraits). Unit visuals
      4.8 -> 3.3 s. Portraits, camp textures and a stamped crater checked.
      Round 4 (21.0 -> 19.4 s): loading-screen frame loop 1/s not 4/s (the
      trace put ~2.8 s of per-frame render work in the boot; nothing in the
      boot waits on an engine frame), and slot maps read through ONE
      CPU-backed canvas (willReadFrequently) — no GPU readback per map
      (v3proj stage 8.2 -> 6.7 s). Material compiling now lands on whichever
      stage the 1/s frame hits, so judge the TOTAL, not a stage.
      SHADER BUILDS, diagnosed: 426 node builds at boot, only 124 distinct
      shaders — three r184 puts every InstancedMesh's uuid in its cache key,
      so instanced meshes sharing a material each rebuild it (+ shadow).
      Worst: procedural ROCKS, 60 types x (main+shadow) = 120 builds of one
      shader; foliage chunks 22x2; RTS parts 15x2. ~2 s recoverable at most,
      by drawing rock types as ONE BatchedMesh (engine props renderer) —
      not done, your call. Unit types not yet spawned build on first spawn.
      LEFT, from the main-thread trace: **three's node-material building
      ~3 s of first-time material builds** (the rest of the ~9 s was
      per-frame work, now mostly gone), procedural rocks ~1.25 s (memoised per
      session only — cache across reloads?), and (TSL graphs -> shaders on the CPU, all through the boot) and
      the **v3proj stage 8.2 s** (ground-texture resize through a canvas
      ~1.35 s, decal slots ~0.6 s, rocks ~1.2 s, the rest spread out).
- [ ] **CPU 36 ms spike after a few minutes of a match** — seen 2026-09-24 in
      the overlay (27 FPS, CPU 36 ms; 7-10 ms at boot) with the enemy AI
      running. **IN PROGRESS 2026-09-24** (your pick: first, and "be sure
      everything is as optimized as possible"). Method: fastForward(300), then
      spawn 40 soldiers + 4 tanks at the enemy centroid, camera on the fight,
      Chrome trace parsed with scratchpad parseTrace.mjs (self time per
      function; the slowest frames). FINDINGS SO FAR:
      · FIXED (uncommitted): ONE alpha-tested shadow caster makes EVERY shadow
        draw rebuild its material cache key every frame. three copies each
        caster's alphaTest onto the one shared shadow material, and flipping
        0 <-> >0 bumps its version. 112 rebuilds/frame, ~1 ms CPU. The culprits
        were the RtsStencil instanced parts and the camp's chain-link weave.
        `mayCastShadow()` in rtsStencils.js; applied in unitRenderer,
        structuresRenderer, buildingRenderer and campPerimeter. Measured: 112
        -> 0.6 rebuilds/frame; main-thread mean per frame 7.3 -> 4.7 ms.
      · NOT the sim/AI growing: after fastForward(300) the tick is 0.9 ms.
        The game's tick in a fight is 1.5 ms; the rest of the ~9 ms is
        rendering.
      · GPU UPLOADS: 2 MB and 1558 writeBuffer calls PER FRAME. (a) ~600 KB is
        three's per-object 3 KB uniform groups, re-sent for every drawn object
        (structural: fewer objects or merging is the lever). (b) ~700 KB is
        16 KB instance-matrix buffers: unitRenderer parts reserve 256 slots
        and ship all of them every frame, for 62 live units across 32 meshes.
        TODO: size capacity per type, or upload only live instances.
      · HITCHES (20-45 ms, some 140-240 ms): GC (482 ms in 13 s, 24 ms major
        collections: find the per-frame allocations) and PIPELINES BUILT
        MID-FIGHT (26 of them, mostly small MeshBasic render-target draws —
        likely portraits or icons for newly spawned units): warm them at boot.
      · GPU timestamp queries (the stats overlay) cost ~2.5% CPU: make sure
        they are off in a shipped build.
      · FIXED (uncommitted): PIPELINE WARM-UP (pipelineWarmup.js). Before the
        loading screen goes, every drawable the GAME added after the level
        loaded (the engine's hidden ocean, waterfalls and gizmos are left
        alone) is switched on for two frames, which builds its pipelines.
        Measured: pipelines built mid-fight went from 26 to 1, and the fight's
        frames over 25 ms from ~20 (up to 987 ms) to 2 (34, 32 ms). Cost: 71
        drawables, +0.46 s of loading.
      · Session 2 checks (2026-09-24), all CLEAN after the two fixes:
        - 150 s of real-time fighting, snapshot every 15 s: 60 fps, tick
          ~1 ms, scene size constant. NOTHING ACCUMULATES.
        - PATHFINDING is cheap: in the open, 345 searches in 20 s = 9 ms
          total; attacking the walled camp, every frame under 5 ms (the enemy
          AI queues its searches). A camp assault's worst frame: 19 ms.
        - HEAP 718 MB, but 531 MB of it is typed-array data (CPU copies of
          textures, terrain, geometry) and 94 MB dev-server source text. The
          collector does not walk array data, so this is a MEMORY item for
          shipping, not a hitch.
        - GC: ~33-47 MB/s of short-lived garbage (mostly three.js's own
          per-frame work). Minor collections are cheap (<3 ms, ~2/s); FULL
          collections are the remaining hitch: 19-24 ms every 5-13 s.
        - The flag's cloth update allocated a vector every frame: hoisted.
      · The SUSTAINED 27 FPS was NOT reproduced after the fixes. If it comes
        back: note what was on screen, and remember the MSI laptop's GPU
        throttling (memory) can look like this too.
      · LEFT, measured and small: 1500 writeBuffer calls/frame (three's
        per-object uniforms; the lever is fewer draw calls); unit separation
        ~1 ms in an 80-man crowd (one tank widens every soldier's reach); the
        stats overlay's GPU timers (~0.1-0.2 ms, always on).
- [ ] **Projectiles like Company of Heroes** (your ask 2026-09-24, after the
      CPU spike): tracers, shell arcs, impacts that read like CoH.
- [ ] **Smoke and fire, more realistic** (your ask 2026-09-24, with the
      projectiles). The nam versions are done DIFFERENTLY from your old RTS,
      and the old RTS is NOT touched. Plan, pending your go:
      · SMOKE = your modular-road FLIPBOOK (wispy 8x8 atlas) ON the existing
        puff field. Keep the analytic columns that block sight, and the puffs'
        3D arrangement. Only each puff's pixels change: lit by the RTS sun,
        with soft ground contact. (smokeField.js's "why not a flipbook" note
        argued against a few BIG cards, not against textured puffs.)
      · NAPALM: a fireball flipbook for the first second, then fire, then
        the smoke atlas tinted to thick oily black.
      · FIRE: a flipbook ONLY if it comes from a real fire sim — FOUND: the
        Unity Labs free VFX pack you took the smoke from is CC0 (commercial
        OK, not Unity-only):
        https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks
        Picks: SmallFlame01-temperature + Flame02-temperature (fires; the
        temperature maps get a colour ramp in the shader, which gives
        per-fire intensity and fixes "napalm cores clip to white"),
        FireBall01/02 (napalm), Explosion01-light / -nofire (shell impacts),
        Explosion01 (vehicle deaths), WispySmoke02/03b (smoke). Budget: an
        8x8 1024² atlas is ~4-5 MB of GPU memory; load only what is used.
        DOWNLOADED + converted to PNG (scratchpad/vfx, not in the repo yet):
        explosions 5x5 1024² RGBA; fireballs 8x8 1024² RGB (additive);
        Flame02-temperature 16x4 2048x1024 grey; SmallFlame01 16x4 2048x1024
        RGBA. The fire temperature maps other than Flame02 are EXR-only (no
        EXR reader here without installing packages), so SmallFlame01's heat
        comes from its coloured TGA's brightness.
      · STEP 1 DONE (uncommitted): SMOKE ON THE FLIPBOOK. smokeField.js
        samples wispy02 per puff: a looping frame from each puff's own start,
        crossfaded, alpha x2.2, and the baked grey on the game's light.
        Columns, sight, budget and the single draw call are unchanged.
        `smoke.setLook()` + a dev-panel button (SMOKE -> "Look: …") for the
        A/B. First look from the RTS camera: the wreck's black plume gains real
        streaky structure where the procedural one was a faint haze. GPU for
        the whole frame is unchanged (~1.6-2 ms). **YOUR LOOK CHECK**: flipbook vs
        procedural; alpha x2.2 and 02 vs 03b are the knobs.
      · STEP 2 DONE (uncommitted): NAPALM FIREBALLS. New fireballField.js:
        instanced camera-facing cards playing FireBall01 (8x8, now in
        public/textures/fx/) ONCE over ~1.6 s, growing and climbing, lifted
        toward the camera so they never slice the ground, additive, with
        45% written to the bloom buffer. Each napalm splash gets one big ball
        and two smaller ones a beat later along the run. First try at 3.2x
        with full bloom blew out to white discs; 1.0x + 0.45 bloom keeps the
        flame shape. The whole strike now reads fireball -> burning ground ->
        oily black pall (the flipbook smoke). GPU ~4.1 ms for the frame during a
        strike, almost all of it smoke. **YOUR LOOK CHECK**: dev panel ->
        NAPALM RUN; `__NAM.fireballs.params.uIntensity / uBloom` are the knobs.
        NEXT: the burning ground is still the procedural fire blobs -> step 3.
      · STEP 3 DONE (uncommitted): FIRE ON THE FLIPBOOK. New flameField.js,
        the same interface as fireSystem (addFire/update/clear/activeCount),
        which stays behind `?fire=procedural` for the A/B. Each fire is 2-7
        vertical flame cards (turned to the camera about the vertical axis
        only) looping Flame02-temperature (16x4, public/textures/fx/). The
        shader colours the TEMPERATURE: dark red -> orange -> yellow -> white,
        with a HEAT per fire (0.75 for a rifleman's wreck to ~1 for an HQ,
        napalm 1.05 via addFire's new `{ heat }`). Card data is written only
        when a fire starts or ends; the fades run on the GPU clock.
        Two fixes from the first look: (1) far too white at heat 0.85-1.35 x
        1.6 intensity -> heat lowered, intensity 1.1, bloom 0.3; (2) a hard
        bright line at each card's base (the atlas's hottest texels ARE the
        bottom of the cell), floating once lifted toward the camera -> no
        lift, sunk a fifth of its height, bottom quarter faded (an eighth
        still showed on steep banks). **YOUR LOOK CHECK**: wreck and napalm
        fires at your zoom; `__NAM.fire.params.uIntensity / uBloom`.
      · STEP 4 DONE (uncommitted): EXPLOSIONS. New explosionField.js, two
        flipbooks played once per burst (public/textures/fx/*.webp, the 1024²
        PNGs re-encoded: 735 -> 255 KB): BLAST = Explosion01 (fireball ->
        black smoke with embers -> grey wisps) for shells, vehicles and
        buildings; DUST = Explosion01-nofire tinted tan for a SOLDIER's death
        (a man used to die in the same orange fireball as a tank).
        combatFx.explosion(x, y, z, { size, dust }) sizes it: soldier 2.6 m
        dust, vehicle radius x 2.4 (min 8), structure 15, HQ 26, mortar/trap
        splash radius x 1.1 (min 6); duration 1.9 s + size x 0.07. The old
        additive sprite stays as a short flash under the blast, for the bloom.
        ALPHA-blended (smoke must darken); only the fire (red >> blue) goes to
        the emissive/bloom buffer. First-try traps: (1) the baked smoke is
        ~0.2 grey, a black mushroom once decoded -> smoke x2.6 (dust x2.2 +
        a tan floor), fire untouched; (2) mirroring the card by its vertices
        flipped its winding and front-face culling DROPPED every other blast
        -> mirrored in the UV instead. COST: ten 15 m blasts at once, close
        zoom, +0.40 ms GPU (gpuAB, noise 0.03); one draw per book.
        NOT DONE: bullet/rocket IMPACTS are still the old spark sprite — they
        belong to the CoH projectiles step (dirt kicks on misses, sparks on
        armour). `__NAM.fx.books.blast.params.uShade / uBloom` to tune.
      · FIRE FIX (your screenshot, 2026-09-24: "clipping, plenty of small
        flames separately, ugly"). Three causes: (1) the Flame02 atlas is
        16x**5**, not 16x4 — sliced as 4 rows every frame was a strip cut
        through a flame: the flat tops and bottoms. File renamed
        flame02_temperature_16x5.png, aspect 0.625. (2) 2-7 cards scattered
        over the radius read as a crowd of little flames -> ONE BLAZE: a main
        card (radius x 2.1 tall) + 1-2 shorter tongues overlapping it.
        (3) the white-hot base met sloped ground in a hard line -> a
        SOFT-PARTICLE depth fade (1.6 m, the engine's shared sceneDepthGrab,
        no extra copy) + the bottom fifth of the card fades. Intensity 1.1 ->
        0.95. `__NAM.fire.params.uSoft` tunes the fade.
      · STEP 5 DONE (uncommitted): COMPANY OF HEROES SHOTS. The glowing orange
        rocket every gun fired (the old RTS's look) is gone. Each armed type
        has a `weapon` (unitTypes.js / structures.js) and projectiles.js
        WEAPONS says how its rounds look: rifle = one tracer; mg (jeep, M113,
        DShK, ZPU) = a 3-round BURST, the first carries the shot's damage,
        the others spray 1-4 m round the target and kick up tan dirt;
        cannon (M48, Sheridan, PT-76) = a heavy shell streak from the barrel
        end, flash + grey gun smoke, a small blast on the hit; gunship
        (Huey) = door-gun bursts and every 4th shot a real rocket (carries
        that shot's damage; dark body, motor flare, GREY smoke trail).
        TRACER COLOUR BY SIDE: US red, the Front green (Soviet-supplied) —
        who is shooting whom at a glance. tracerField.js: one draw, GPU
        places the streak from (A, t0) -> (B, t1); one row written per round,
        one merged buffer upload per frame. Visual speed 150-200 m/s (a real
        round would cross the screen in a frame). Damage per second is
        UNCHANGED: bursts are decoration, damage lands on arrival (~0.2 s).
        A bullet hitting a MAN shows no flare any more (you read it from the
        man); metal/stone still sparks; napalm/splash keep the old flare.
        GPU ~1.2 ms in a 25-unit fight. **YOUR LOOK CHECK**: tracer width /
        brightness (`__NAM.projectiles.tracers.params.uIntensity`, 2.2),
        dirt kick size, the black shell-hit cloud (maybe the -light book).
        COMMITTED 746c950. Then RECOIL (uncommitted): projectiles.js counts a
        tank's gun shots (`gunShots`); unitRenderer.js throws the turret 0.45 m
        back along the gun and rocks the hull nose-up 2°, easing home over
        0.5 s — visual only. (Turrets already tracked their target.) The
        shell and its grey gun smoke now leave the BARREL TIP (1.1 radii, the
        puff started 1.6 m low): they hung ~4 m short of it.
        NEXT candidates: 
        misses that hit cover (sandbags spark), infantry suppression pinned
        by MG fire (a CoH mechanic, gameplay — ask first).
- [ ] Texture repetition (hex tiling discussed; stochastic rejected — it swam)
- [ ] Napalm flame cores clip to white — per-fire intensity (taste)
- [ ] Octahedral impostors for the RTS camera — asked, never answered properly
- [x] New map, nav fix, flatter playable ground, terracing, bridges, beach
      (contour bands), rocks (palette, weathering, slabs, split boulders,
      megaliths, re-grounded), decal pass, monsoon fog, midday light + sky fill,
      unit/prop scale 1.3, revo grass, tall-plant field, foliage LOD from the RTS
      view, no grass on cliffs, labs on custom UI, fog of war off by default

## Economy + Company of Heroes ideas (your question 2026-09-22 — not agreed yet)

- [x] **Base income** DONE (requisition.js baseIncome 1.0/s while the HQ stands; HUD shows it). Was: so you are never stuck (HQ trickle ~+60/min; points on
      top). TODAY: start 400, only points pay (+96/min each), the M48 costs 420
      — you cannot build it until you hold ground
- [ ] **Two resources**: Supplies (men, buildings) and **Fuel** (vehicles) —
      most points give supplies, a few special ones (fuel depot, truck park)
      give fuel, so armour depends on ground you fight for
- [ ] **Supply lines**: a point only pays if connected through your points to
      the HQ; cut the chain and everything behind goes dead
- [ ] **Upkeep**: a bigger army lowers income (stops snowballing)
- [ ] **Victory points** as the main win condition (ticket bleed), not "destroy the HQ"
- [ ] **Squads** of 4–6 men (shared job, reinforce near the HQ / a point)
- [ ] **Suppression / pinning** from MGs (makes the pits and nests matter)
- [ ] **Retreat** button (keep veterans alive)
- [ ] **Directional armour** (tanks weak at the sides and rear; turrets already turn)
- [ ] **Weapon teams with firing arcs** (MG team, mortar)
- [ ] **Veterancy** · **garrisoning** bunkers and huts · engineers laying
      mines/wire/sandbags/tank traps · call-ins and **doctrines** (airmobile vs
      armour; artillery, air strikes, napalm) · **craters as cover**

## Gameplay

- [x] **Enemy AI** (`enemyAI.js`, test `namEnemyAITest`, dev panel ENEMY AI:
      on/off, difficulty, live squad list + log; `?ai=0` boots without it): the
      enemy HQ stands from the start and the match is on (destroy it to win).
      Squads of 5 recruited from its own purse (points it holds + HQ trickle);
      take neutral points, relieve threatened ones, attack yours only with
      enough men for what they can SEE (no cheating — sightings remembered
      60 s), GATHER out of sight at one reachable stage and go in together,
      pull back to the stage when they meet more than expected, retreat home
      holding fire when worn down, refit; hold points from the best
      concealment/cover spots; leash on chasers; the HQ is the last objective
      once it holds half the map. Deterministic (seeded). MEASURED 15 min of
      battle: 0.015 ms a step, p99.9 0.7 ms (path searches go through a
      budgeted QUEUE — navGrid.requestPath/pumpPaths)
- [ ] Enemy AI, next: use vehicles/mortars when they exist, ambush from
      concealment on your approach routes, flank (stage on the side you are
      not facing), booby traps; difficulty tuning after you play it
- [x] **Bridges crossable again** (`bridgeLandings.js`, engine `app.gradeRamp`):
      both decks had stopped meeting their banks (11 m wall / 40° banks) — the
      river cut the map in two. Graded ramps, written into River v2's base too
- [x] **Pathfinding 5–10x faster** (navGrid: typed heap — the old swap made two
      arrays per swap — reused scratch, octile heuristic): 31 → 3 ms across the
      river; a group order shares ONE search per cluster (selection.js)
- [ ] Long path searches into the walled camp are still 5–15 ms for YOUR
      orders (one per group now); hierarchical/cached paths if it shows
- [~] **Rocket / indirect-fire artillery** (your ask 2026-09-22): the ARC and the
      SPLASH now exist (projectiles.spawnArc + combat.splashAt + the warning
      ring), carrying the enemy's 82 mm mortar. Left: the US side (81 mm pit,
      M109), the 107 mm Type 63 and 122 mm Grad, and a real launch signature.
      Was:
      rockets that ARC high and fall far, out of line of sight. Enemy: the
      107 mm Type 63 (12 tubes on a light towed carriage) and 122 mm Grad
      rockets fired into firebases — firing gives the launch site away. US:
      the M109 self-propelled howitzer, and 81 mm mortar pits/teams in the camp.
      Needs: a ballistic arc projectile, a landing marker/warning, splash damage
- [ ] **Fire from the gun** (your ask 2026-09-22): every unit's tracers and
      muzzle flashes leave its real muzzle — the tank's cannon tip, the M113's
      .50 cal, the Huey's door guns — turned with its turret. The procedural
      vehicles can carry a `muzzle` point in their turret frame (the buildings'
      gun pits and nests already do, structuresRenderer.muzzleOf)
- [ ] Suppression / pinning · squads · armour matchups · high-ground bonus ·
      retreat · garrisoning · veterancy · win conditions beyond "destroy HQ"
- [ ] **Napalm aftermath** — `burnedAt` → vegetation/grass density, burnt
      ground, stumps, haze (burned ground = no concealment)
- [ ] Nav from vegetation (bamboo blocks, ferns don't) + river **fords**
- [x] Pink/violet smoke on **capture points** — the M18 violet kind exists;
      capture points to trigger it
- [ ] Two factions in `unitTypes` · Vietnam units (Huey, M113, PBR) — **you**
      build the units
- [ ] Waves stay an optional mode only
- [x] Fixed 60 Hz sim · smoke that blocks sight · fire · napalm · abilities ·
      cover (directional) & concealment · spatial grid (300 units linear) ·
      stress price list

## Presentation

- [ ] **Audio** (`howler` installed, unused — you said "not now")
- [ ] Better **UI**
- [ ] Better **FX** pass (still rts-v3's look; never touch games/rts-v3)
- [ ] **Smoke look** fine-tune — **you**, later
- [ ] Unit responses · minimap pings / attack alerts

## Performance

- [x] **THE PERF PASS WHILE YOU WERE OUT (2026-09-24, uncommitted)**. Method:
      x1.55 resolution (vsync cannot clamp), rAF frame time, each system
      hidden with `layers.set(31)`, ON/OFF alternated. Play zoom over our side
      (-60,-230), frame 29.0 ms before. What each system costs there:
        river 2.84 (NOT ON SCREEN) · ground foliage 2.28 · terrain 1.69 ·
        sky 1.19 (not on screen) · grass 1.12 · canopy -1.9 (it HIDES work) ·
        placed plants / objects / decals / smoke / craters / underwater ~0.
      FIXED:
      · **SKY** drawn FIRST with the depth test off (engine: renderOrder -2)
        -> every pixel paid the sky shader, and the RTS camera almost never
        sees sky. nam-rts now draws the dome AFTER the opaque world (9, before
        the water grab at 10) with the depth test ON — 0.86 ms back, the
        horizon identical (A/B screenshots). namGame.js, at boot.
      · **RIVER CULLING** (engine, v3/tools/riverV2System.js): 50 m chunks
        tested by SPHERE drew the river with 0 of its vertices on screen;
        now 13 m chunks tested by BOX. Where it truly leaves the view it no
        longer draws.
      · **MY OWN REGRESSION**: the flames' soft fade read the scene-depth
        grab, so any fire on screen bought the water's two full-screen
        copies. Now it fades by height above the terrain (one heightmap tap):
        six fires on screen +0.25 ms.
      COMMITTED 59aeab0. Then (your go, 2026-09-24) THE COPIES, uncommitted:
      · **GRAB-FREE RIVER** (riverV2Material `grabFree`, riverV2System
        `setGrabFree`, app.setRiverGrabFree): depth from the heightmap, no
        refraction/SSR/wake taps, and the per-channel absorption kept EXACT in
        two draws of the river (a MULTIPLY pass dst·K, an ADD pass +rest) —
        one alpha blend (first try) turned the teal river flat grey-brown.
        Fog on the add pass only. Looks the same as before from the RTS
        camera (A/B screenshots). River partly on screen: 3.86 -> 0.03 ms;
        river filling the view: 0.95 ms.
      · **GRAB-FREE DECALS** (decalSystem `setGrabFree`): the ground on the
        view ray solved against the heightmap in 4 fixed-point steps (a
        16-tap march, first try, cost as much as the copy), its depth
        written so units on a decal still hide it. Camp: 1.91 -> 0.81 ms.
      · `?water=grab` brings the old river and decals back.
      RESULT (x1.55 res): play zoom 29.0 -> **22.1 ms**, max zoom-out 31.7 ->
      25.6, camp 22.9. The hilltop mystery's "empty scene 4.5 ms sky
      background" was the sky dome drawn first with depth test off — fixed.
      LEFT, and a LOOK trade-off, so YOUR CALL: open ground (the enemy base,
      27.9 ms) is terrain 8.7 + grass 5.9 there. `?topk=2` saves ~1.3 ms there
      (2 splat layers a pixel, not 3), `?far=0` ~0.8 (no near/far tiling);
      ~0.1 each at play zoom. Grass density in open meadows is the other lever.
      · **BRIDGES** (your report 2026-09-24: units went THROUGH the bridge):
        units took the terrain height, which under a bridge is the riverbed.
        bridgeDecks.js MEASURES each deck at boot (rays down its centre line,
        one a metre, against the bridge's own meshes — the decks are arched)
        and app.getStandHeight gives units the deck inside its rectangle
        (units.js groundAt); they stand upright there (unitRenderer), not
        tilted to the bank below. Checked: a jeep mid-span at 24.6 m over a
        riverbed at 18.4. Engine: app.getLivePropObject(i).
        STILL DRAPED ON THE RIVERBED (GPU heightmap): selection rings and
        craters under a unit on a deck — cosmetic, not done.
      · STRESS PRICE LIST re-run (full zoom-out): combat FX all in the noise
        (fires 50 ~1.3 ms native, explosions 20/s ~1.6, gunfire 120/s ~1.2,
        rockets 20/s ~0.7); the baseline itself drifted 4 ms at 2x res during
        the run (the laptop throttles) — nothing new to chase.
      (DONE ABOVE, grab-free — the note it answered:) drawing ANY water, even
      one river vertex at the screen edge, costs **2.7 ms at x1.55 res** (3.9
      with more river) — the two full-screen framebuffer copies every water
      shader shares (lakeMaterial sceneColorGrab / sceneDepthGrab), not the
      water pixels. On nam-valley the river is in view from much of the map.
      Option: the river's DEPTH from the heightmap (water Y - terrain Y, one
      tap, like the flames now) instead of the depth grab, and its see-through
      as alpha blending instead of the colour grab — at RTS zoom the
      refraction wobble is invisible. That removes both copies for the river.
      Touches the shared water shaders, so: ask first.
- [ ] RTS camera render budget: sky dome (~0.5 ms, FIXED above), lens flare, underwater, far
      plane — off in RTS mode, back with C; measure each first
- [ ] Staggered target acquisition — **your** call (changes reaction timing)
- [ ] Terrain index blending (top-4 layers/texel), ~1 ms — engine, new chat
- [ ] **THE HILLTOP GPU SPOT — must be fixed** (your call 2026-09-22: important,
      but parked after a long session on it). WHAT IS KNOWN, so nobody starts
      over: at (120, −40) the GPU takes **10.6 ms** where the bridge and the
      grass flats take **0.8** at the same camera height; seen again at
      requisition Points B/C (8.7–9.5 ms before anything was added there).
      · ~2/3 is PER-PIXEL: at 1/4 the pixels 10.9 → 4.1 ms
      · an EMPTY scene there still costs 4.5 ms (1.5 at the bridge): the sky
        BACKGROUND (full-screen atmosphere, not the DayNightSkyDome mesh) is
        view-direction dependent — looking out from high ground shows it
      · scene content ~6 ms on top: terrain 2.15 ms is the only object clearly
        above the noise; shadow RECEIVING ~0.8 (at the noise floor)
      · ruled out: fog of war, bamboo, ground foliage, sky dome mesh, CSM
        casting, depth prepass, draw order, post-FX, triplanar
      NEXT STEP when we come back: per-PASS averaging in the timing panel
      (single-frame per-pass numbers swung 2x and misled three times), then
      attribute the sky background and the terrain cost at that view
- [x] River culling, foliage zoom thinning + no popping, layer budget, lean
      terrain, smoke cap, grass on/off switch in the dev panel

## Debt

- [ ] Prop nav stamps use the bounding box (units stop short of rocks)
- [ ] `cityKitTest` flaky under load
- [ ] Per-layer `auto` paint rules are dead state
- [ ] Passability overlay in the editor (see the nav map while sculpting)

## Shipping — RTS alone on Vercel (own domain) and Steam (your question 2026-09-22)

What the game loads is listed in [ASSETS.md](ASSETS.md) (~100 MB of the 715 MB `public/`).
- [ ] Pass `preloadPaintTextures: false`: boot downloads 47 MB of ground textures the map then replaces
- [ ] Shrink cliff_rocks_07 (12 MB normal PNG) and check `.v3proj` gets gzipped
- [ ] RTS-only Vite config + RTS-only public folder → second Vercel project + domain
- [ ] "Needs WebGPU" screen instead of a black canvas
- [ ] Later: Electron wrapper → Steamworks (steamworks.js), saves to files, Steam page early for wishlists
- [ ] Confirm ASSETS.md once with a DevTools Network capture
