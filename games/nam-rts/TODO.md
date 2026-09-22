# nam-rts — the list

Everything asked for or agreed in the build conversation (2026-09-18 → 22),
rebuilt from the full transcript. `[x]` done · `[ ]` open · `[~]` started or
partly done · **you** = your call or your work.

Keep this file current: tick things off here, add new asks here.

---

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
- [~] **Builder-built buildings rebuilt on the new kit** (`rtsBuildables.js`):
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
- [~] **Placed-building system** (`placedObjects.js`, the foundation for the three above): one path
      for decoration AND builder buildings — kit geometry + footprint → flat pad,
      nav collision on the real footprint, cover, grass cleared, selection
      marker. DONE for the camp (pads, nav footprints, cover, one draw per
      material); NEXT: the builder's buildings through it, + selection marker
- [ ] **Builder buildings, my proposal** (you trust me on gameplay): helipad =
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
- [ ] (was) **Requisition points**: map points you CAPTURE (not build) — a big
      antenna mast on each, and the **violet M18 smoke** when the point is taken
      (the violet smoke kind already exists). Note: today's economy is
      harvester nodes + a buildable "Supply Relay"; capture points change that
      design — **DECIDED: replace harvesting with requisition points**
      (harvesting can survive as an optional mode)
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
- [ ] **Vehicles are too low poly** — rebuild them for this game: procedural
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

## Gameplay

- [ ] **Enemy AI** — flanking, retreat, using terrain (biggest gap; you said
      "not now")
- [ ] Suppression / pinning · squads · armour matchups · high-ground bonus ·
      retreat · garrisoning · veterancy · win conditions beyond "destroy HQ"
- [ ] **Napalm aftermath** — `burnedAt` → vegetation/grass density, burnt
      ground, stumps, haze (burned ground = no concealment)
- [ ] Nav from vegetation (bamboo blocks, ferns don't) + river **fords**
- [ ] Pink/violet smoke on **capture points** — the M18 violet kind exists;
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
- [ ] The 10 ms hilltop GPU spot (parked)
- [x] River culling, foliage zoom thinning + no popping, layer budget, lean
      terrain, smoke cap, grass on/off switch in the dev panel

## Debt

- [ ] Prop nav stamps use the bounding box (units stop short of rocks)
- [ ] `cityKitTest` flaky under load
- [ ] Per-layer `auto` paint rules are dead state
- [ ] Passability overlay in the editor (see the nav map while sculpting)
