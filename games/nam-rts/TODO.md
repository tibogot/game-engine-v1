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
4. **The jungle: big trees + palm variety + Vietnam plants** (areca, sago,
   pandanus, nipa, banana, flame tree) — the look you asked for.
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
- [ ] **KURTZ COUNTRY — the Cambodian temple and its ruins** (your ask). The
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
- [ ] **Grass coverage at zoom-out**: fade uses camera distance → zoom-driven
      tile/fade/width at a constant blade count (proposal). Cheap knobs first:
      Min width (px) ↑, Clumping ↑, Variation ↓, root shade
- [ ] **Foliage brightness** — **you**, taste call (knobs listed in the transcript)
- [ ] Rice paddies (expensive: water over big screen areas)
- [ ] A village as an *arrangement* (paths, well, fences, clearing)
- [ ] Pre-placed craters and wrecks (craterSystem exists)
- [ ] Telegraph poles along roads
- [ ] **Ocean** — off in the RTS; **you** are reworking Ocean v2 in another chat
- [ ] **River** — **you** are finishing/optimising River v2 in another chat;
      then river branches → **water units**, lily pads on the flow field
- [ ] Grass trails under units (`grassPush` exists)
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
