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

## Open decisions — **you**

- [ ] **How the code starts.** (a) Copy nam-rts into games/alg-rts/ and
      strip it: fastest, but every later fix is made twice (28k lines).
      (b) First move the shared parts (sim clock, nav grid, units, selection,
      combat, cover, smoke LOS, fog of war, enemy AI, camera, fire and napalm,
      vehicles) into a shared RTS folder that both games import: slower to
      start, one copy forever. Recommended: (b), done one system at a time.
- [ ] Which side is playable at launch: French, ALN, or both (asymmetric).
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
