# alg-rts — the list

A second RTS on the same engine and in the same style as nam-rts, set in the
Algerian War (1954–1962). Started 2026-09-26. `[x]` done · `[ ]` open · `[~]`
started · **you** = your call or your work.

Keep this file current: tick things off here, add new asks here.

---

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
- [ ] **LATER — sandstorm** (your ask, 2026-09-26): a weather event —
      wall of dust rolling in, haze thickening to a brown-out, wind-driven
      dust sheets, the light going orange and flat; gameplay: sight ranges
      shrink, helicopters grounded. Candidates: the engine's fog + smoke
      flipbooks + a dust-particle layer.

## Open decisions — **you**

- [x] **How the code starts**: (b), a shared RTS core, one system at a time
      (you, 2026-09-26). Camera moved first.
- [x] Playable side: **French** first; choosing the side comes later (you).
- [ ] Working title ("Djebel"?).

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
- [ ] Console: one "Draw with an index count of 0" warning after loading
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
