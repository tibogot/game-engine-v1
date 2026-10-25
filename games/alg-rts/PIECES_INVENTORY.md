# EVERYTHING THE GAME PLACES — the inventory (rewritten 2026-10-25)

You: "be careful with some assets not being in the lab … I'm very confused, we need better organization now."

**One row per piece.** It says where the piece appears, what the game actually draws today, and the piece's entry in
the lab (`games/alg-rts/lab.html?p=<entry>`). The **Verdict** column is yours: keep · improve · redo · remove.

**Kept in step by `npm test`:**
- `labCatalog.js PLACED` maps every placement key and every Blender kit type to its lab entry.
- `tools/labCoverageTest.mjs` reads the placement code itself: `showroom.js`, `algLandmarks.js`, `algGame.js`,
  `algBuild.js` and `algHouse.js`.
- A piece placed without a lab entry fails the suite.

**Maps:**
- OA = the old Aurès, NA = the new Aurès (it keeps the old Aurès' landmarks).
- AB = Oued Abdi, CO = the coast, KA = El Kantara, MQ = the maquis, TR = the training camp.
- "build" = the player or the AI builds it.

**"Game draws":**
- **Blender** = a Blender kit, optimized, with LOD and its three states.
- **new** = the newer procedural standard (algMasonry, the sandstone generator…).
- **old kit** = the first procedural kit (rtsAlgeria / rtsAlgVillage), never redone.

## French base and defences

| Piece | Maps | Game draws | Lab entry | Verdict |
|---|---|---|---|---|
| The post (bordj, towers, gate, barracks) | all | Blender (postkit), swapped in over the old kit | posteBlender (new · damaged · destroyed) | **one entry** — the old post, photo and sim-bags entries removed (2026-10-25) |
| Post flag | all | live cloth | — (animated: judged in the game) | |
| Helipad + windsock | all | new procedural, cloth bags; construction | helisurface | |
| Motor pool | all | old kit + the Blender far level attached | parcAutoNeuf (old: parcAuto) | |
| SAS post | OA NA AB MQ | old kit | sasPost | |
| Sandbag wall | build, TR | your simulated wall (+ simulated breach) | sacsDeSable | |
| Barbed wire | build, TR | Blender | barbelesBlender | |
| MG nest | build, TR | Blender | nidBlender | |
| Mortar pit | build, TR | Blender | mortierBlender | |
| Mirador | build | Blender | miradorBlender | |
| Searchlight tower | build | Blender | projBlender | |
| Forward post | build | Blender | posteAvanceBlender | |
| Aid station | build | Blender | secoursBlender | |
| Fortified point | build | Blender | fortBlender | |

## FLN

| Piece | Maps | Game draws | Lab entry | Verdict |
|---|---|---|---|---|
| FLN camp | all | new (sandstone + dry stone) | campFln | |
| Cave entrance | all | new (sandstone) | grotte | |
| Arms cache | all, build | Blender | cacheBlender | |
| Sangar | all, build | Blender | sangarBlender | |
| Ambush screen | all, build | Blender + the game's scrub | ecranBlender | |
| Refuge | OA NA, build | Blender | refugeBlender | |
| Infirmary | build | Blender | infirmBlender | |
| Lookout | OA NA | old kit | lookout | |
| Mine marker | all | old kit | mineMarker | |

## Villages and houses

| Piece | Maps | Game draws | Lab entry | Verdict |
|---|---|---|---|---|
| Hamlet (mechta) | OA AB MQ | new (algMasonry) | hameau (old: mechtaHouse, mechtaPierre) | |
| Dechra | OA AB | new | dechraNouveau | |
| Ksar | OA | new | ksarNouveau | |
| Whitewashed houses (4 types) | NA TR AB | Blender | blanche_maison / cour / haute / boutique, villageBlanc | |
| M'zab houses (6 types) + terrace wall | AB NA | Blender | mzab_*, mzab_mur, villeMzab | |
| Koubba | OA NA AB | old kit | koubba | |
| Cemetery | OA NA | old kit | cemetery | |
| Village well | OA AB MQ | old kit (the Blender well: NA TR) | villageWell, villagePropsBlender | |
| Thorn pen (zeriba) | OA NA AB MQ | old kit fence + the Blender trough and haystack inside (algPenProps) | zeriba | **keep the old fence, better inside** — done 2026-10-25 |
| Thorn ring (Blender) | — | parked | zeribaParked | **parked** — for another asset later (a thorn barricade?) |
| Fishing port | CO | new procedural | port | |
| Stone house (HQ) | — | lab only | maisonPierre | |

## Landmarks and ruins (old Aurès, kept on the new one)

| Piece | Maps | Game draws | Lab entry | Verdict |
|---|---|---|---|---|
| Farmstead (7, seeded) | OA NA TR | old kit; its pen now the zeriba fence + Blender trough and hay | farmstead (3 seeds) | **redo in Blender** (intact · damaged · burnt — the burnt farm becomes its burnt state) |
| Burnt farm | OA NA | old kit | burntFarm | **cheap** — replaced by the new farmstead's burnt state |
| Ruined hut (6) | OA NA | old kit | ruinedHut (3 seeds) | |
| Roman temple, arch, colonnade, column, road, oil press | OA NA | new procedural | ruineRomaine, arc, colonnade, colonne, voie, pressoir | |
| Rubble (collapsing house) | NA AB TR | Blender | rubbleKit | |
| Rubble heap (shelled kit house) | OA | old kit | rubbleHeapOld | |

## Fields, walls and terraces

| Piece | Maps | Game draws | Lab entry | Verdict |
|---|---|---|---|---|
| Walled garden (olive, mixed, fig) | OA | old kit (its trees: plants) | garden | |
| Threshing floor | OA | old kit | threshingFloor | |
| Almond terraces | OA | old kit | terraces | |
| Field walls (old) | OA | old kit | fieldWallOld | |
| Dry-stone field walls a b c | AB NA | Blender | fieldWallsBlender | |
| Field surfaces, plots | OA (shader) · AB NA (decals) | ground | — (judged in the game) | |

## Rocks, stones, plants

| Piece | Maps | Game draws | Lab entry | Verdict |
|---|---|---|---|---|
| Sandstone rocks (mesa, block, low) | all but CO | generator | rocheBanc, rocheBloc, rocheDalle | |
| Rock outcrops / boulders | OA NA TR MQ | scanned (boulders.glb) | — **rock-lab.html: to fold in next** | |
| Loose stones | all but CO | scans + procedural | — (scattered by the terrain) | |
| Plants: 14 species + the steppe | all | the engine's foliage | plant_* , plantSteppe | |

## Props and points

| Piece | Maps | Game draws | Lab entry | Verdict |
|---|---|---|---|---|
| Village props (hay, wood, oven, hives) | OA | old kit | villagePropsOld | |
| Village props kit (well, trough, jars, bench, oven, hay, wood, hives) | NA TR | Blender | villagePropsBlender | |
| Telegraph poles + wires | OA NA MQ | old kit | telegraphPole | |
| Village flagpole | OA NA AB MQ TR | live cloth | — (animated) | |
| Requisition point (fuel, munitions) + its chicane | OA NA AB TR MQ | Blender, simulated bags | pointBlender_fuel, pointBlender_mun (capture marks in « Piece ») | |
| Hand-held props (grenade, radio, LMG…) | HUD | Blender | — (the HUD icons) | |

## Not in the lab, on purpose

- **Units and parked vehicles:** the vehicle lab.
- **Animated cloth** (flags, windsock), **loose stones** and **ground surfaces:** judged in the game.
- **Fallbacks:** the old depots and mast, and the old buildable kits. They are drawn only when a Blender model fails
  to load.

## Next for the organisation

1. **Fold `rock-lab.html` into the lab**, as was done with the plants, so the outcrops and boulders get their entries.
2. **Fold the vehicle and weapon labs in** as panels: Fire is already there.
3. Later, a **shared lab shell** in the engine, with one catalogue per game.
