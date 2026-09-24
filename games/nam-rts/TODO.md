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
- [ ] **Replace the default enemy turrets.** Five DShK nests stand in a line
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
- [ ] **String lights** — for the village / a club tent (v2 `stringLights.js`
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

- [ ] **The jungle tree is committed but NOT good.** Waiting on your reference
      picture. The roots read as cardboard fins and the crown is a blob.
- [x] **The faceDirection winding bug — FIXED in the coconut palm and the
      areca** (2026-09-24). Same fault as the fan palm's black coarse trunk:
      part 3 shades with its normal multiplied by `faceDirection`, so on a
      DOUBLE-SIDED quad the back face flips, and a crossed pair always shows
      one. Both far trunks are part 2 now (same `colorHead`, shaded like a soft
      body with its normal turned toward the viewer) and a little wider, since
      a crossed pair only shows its full width square on.
- [ ] **Bamboo is 9 m** where real giant bamboo is 20-30, the same error the
      palm had. Your call, as the palm was.
- [ ] **Re-shoot the whole-map lineup** (`window.__sheet` in the lab) now that
      the bush, ground cover and banana have changed, to see what the jungle
      floor actually became.
- [ ] Fan palm: the diamond leaf-base boot pattern on the trunk, and a
      dry-season colour.
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

- [ ] **TRAVELLER'S PALM / Ravenala** — your reference photos, 2026-09-23 (two
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
- [ ] **Fan palm trunk: the diamond boot pattern** — your third photo shows it
      clearly. A fan palm keeps its old leaf BASES on the trunk in a
      criss-cross diamond lattice for years before they shed. Currently the
      trunk is smooth with plain rings. It is the detail that makes the trunk
      read as a palm rather than a post, and it is a texture job, not geometry.
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
- [ ] **LOAD TIME** (your ask 2026-09-24: every change means a reload, so
      it taxes all the work). Boot stages recorded in localStorage sum to
      ~100 s (Placing structures 20.9, v3proj 18.7, camp 17.7, unit visuals
      16.9, village 6.8, resource nodes 6.7, crater decals 5.3) — rough, from
      the MCP profile, re-measure in a focused tab. Suspect #1: every pad's
      `flattenRect` awaits a full GPU->CPU heightmap readback (dozens at
      boot) — batch the pads, read back once.
- [ ] **CPU 36 ms spike after a few minutes of a match** — seen 2026-09-24 in
      the overlay (27 FPS, CPU 36 ms; 7-10 ms at boot) with the enemy AI
      running. Not investigated.
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

- [ ] RTS camera render budget: sky dome (~0.5 ms), lens flare, underwater, far
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
