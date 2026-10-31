# The coast's port in Blender — new pieces at Company of Heroes 3 level

2026-10-30 (you: "make the port assets for the other map; as always think AAA Company of Heroes assets, not cheap
assets, of course as optimized as possible"). The coast map's port (`?map=coast`) is algPort.js today: boxes with a
photo projected on them, flat window holes, a flat grey mole. Every piece will be NEW in Blender, from the references
(assets-src/refs/coast/: Stora, Collo, Philippeville's harbour entrance; the FAO's 1961 report on Algerian fishing). It
is not the procedural one re-textured (see memory: new assets, never remakes). One kit, tools/blender/port.py
(port.glb), built with `node tools/blenderKit.mjs port`.

## What the references show

- **Shore-road houses:** two or three storeys of the French colonial kind, lime-washed white, cream, ochre or pale blue,
  the wash worn grey at the foot and streaked under the sills. Low CANAL-TILE roofs (round clay tiles in channels, a
  ridge of tiles), the tiles' round ends at the eaves. Tall windows with louvred SHUTTERS, some open and some closed,
  painted green, blue or brown, faded. A dressed-stone plinth, a moulded cornice under the eaves, a balcony on iron
  brackets over the door. Shops and a café on the ground floor with a canvas awning.
- **The magasin (warehouse):** long and low, dressed stone, a tile roof, big plank doors (Philippeville's harbour entrance,
  1887).
- **The mole:** dressed blocks on a rock apron (tumbled boulders), a parapet on its sea side, iron bollards, steps
  down to the water, and a small white LIGHTHOUSE on its head with a green lantern.
- **The boats:** LAMPARO boats, open and double-ended, about 6–8 m, white with a coloured sheer band, a short mast, the
  big lamp on a pole at the stern; nets heaped in them; some pulled up on the beach on their bilge.
- **The quay's life:** fish boxes, barrels, coils of rope, nets drying on poles, the fish market's striped awning.

## The pieces, in order (each judged in the lab, then placed)

1. [x] **Row houses** (`quai` two storeys and its balcony, `cafe` with the café below, `etroite` a narrow three-storey house — done 2026-10-30, in the lab; placing them on the coast comes with the magasin and the mole): real wall
   thickness, deep window reveals, shutters, sills, plinth, cornice, balconies, chimneys. The roof's canal tiles are
   MODELLED as channels of round tiles, and the far level's roof is a flat skin baked from them. States: intact,
   damaged (shell holes, shutters torn), ruin (the roof fallen in, the upper floor gone).
2. [x] **The magasin** (`magasin`, done 2026-10-31): long and low, its gable to the sea, ochre-washed rubble with dressed-stone quoins, four round-arched doorways on the quay (plank doors, one open on the dark inside), the loading step, barred windows high on the back, the canal-tile roof; its states.
3. [x] **The mole** (done 2026-10-31, the first pieces through tools/lod from the start): `mole`, a 10 m length laid end to end — flagstone deck, dressed blocks modelled course by course over a mortar core (wet and weedy at the waterline), the parapet and its coping, cast-iron bollards and rings, the rock apron; `phare`, its head — the lighthouse on a block-built plinth, corbels under the gallery, the iron rail, the green lantern and copper dome, the steps to the water. ~4.9k and ~7.3k triangles near.
4. [x] **The lamparo boat** (`barque` blue band, `barque2` green — done 2026-10-31): a double-ended hull LOFTED from stations (white topsides, the coloured sheer band, red antifouling below the waterline), varnished inside, floorboards and thwarts, the stem and stern posts, a short mast, the lamp on its arm in a galvanised reflector, oars, the net heaped; damaged holed and dismasted, ruin burnt to its bilge. ~5.5k triangles near, 2.6k far. Beached = the same model tilted on its bilge when placed.
5. [x] **The quay's props** (done 2026-10-31, one state each): `etal` the fish stall (stone counter, striped awning, boxes of sardines, the balance, a basket and a cask); `caisses` the cargo (crates from props.py, casks in iron hoops, painted drums, a coil of rope); `filets` nets drying (a diamond-mesh net gathered over a line, its corks, the mending bench).
6. [x] **The church** (`eglise`, done 2026-10-31, from the Jemmapes postcard): the tower with quoins and string courses, its arched door and window, the clock, the belfry's louvred twin lancets, the octagonal slate spire and its cross; the nave and its two aisles under canal-tile roofs (lean-tos), arched windows; hollow once hit — damaged: holes, the spire's tip shot away; ruin: roofless, broken, rubble and charred trusses. ~53k triangles (three-sided roof tiles).

7. [x] **On the coast** (2026-10-31, maps/coast.js portTown): the pieces are the TOWN field's rows (algGame: levelled pads, near / far, garrisons — the church takes 8 —, damage and collapse, cover, sight; the church's tower its own sight column). The quay front (magasin, a lane, café, narrow house, balcony house) facing the sea and the camera; a second row behind a street, the church on its square between its houses (one damaged); the mole's five lengths and the lighthouse out from the water's edge (z -108: the beach dry to -110, the bay ~3 m deep at the tip); four boats moored on its harbour side, three pulled up on the sand, heeled; cargo, the fish stall, nets. The procedural port (algPort.js) is off the map, kept for the lab. **The sea kept out of the moored hulls**: a depth-only cap at the gunwale (algHouse afloatCaps, RENDER_ORDER.SEA_CAP) — their floorboards are under the waterline and the swell drew inside.
8. [x] **The quay** (2026-10-31): `pave`, a 10 m length — worn flagstones, the dressed-stone coping, the quay wall of dry blocks (`quayDry`: off the shared slots, where a block's top flattened to a line) down into the sand, two bollards, a ring — and `lampadaire`, the cast-iron quay lamp. Five lengths under the front row at its level (algGame terraced site "port"), the sand under them CARVED below the deck (`carve`: lowered, never raised); the front row's fronts in one line on it; the cargo, the stall and three lamps on the deck, the nets on the sand below. ~3k and 312 triangles near.
9. [x] **The mole from the quay, the church's square** (2026-11-01, you: "do what you think would look the best"): the mole re-laid square to the quay's sea face (before the lane between the magasin and the café), seven lengths and the lighthouse, its deck LEVEL with the quay's (`dy`: its waterline then 0.46 m under the sea); the boats moored past where the sand ends. `place`, a 7.5 m square of the quay's flagstones in a dressed kerb: two before the church on a pad at its level, the ground under the paving carved after the pad (carved alone the paving stood up as a slab: the ground falls away before the church). ~3.8k triangles near.
   Open: the street between the rows is bare ground; the surf lines run under the mole (the sea draws them from the terrain's depth).

## Optimised (as every kit)

One atlas per type, its near and far levels, three states. The far level is used in the sun's shadow too. Instanced
where repeated: the houses are the town field's (garrisons, damage, collapse), the boats one instanced draw. The tiles'
relief is near only.
