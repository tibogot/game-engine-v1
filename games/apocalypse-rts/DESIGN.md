# Apocalypse RTS — design page (rough)

Working name. A new RTS inspired by *Apocalypse Now*. Not built on nam-rts and no
nam assets. alg-rts ships first; until then this page and the unit inventory are
the only work. Everything below will change once we play.

## Core idea

- **The river is the campaign.** Each map is one stop on the way upstream. The boat
  and its crew carry over from map to map. Lose the boat and you lose the campaign.
- **Boats.** One patrol boat as the hero unit, then sampans, junks and supply barges.
  Boats keep to the river network: main channel, side branches, mud banks, bridges.
- **Helicopters.** Hueys bring troops in and take them out, give fire support and
  call in napalm. They are strong but you get them for a limited time.
- **Jungle.** Cover and ambushes. You see only a few metres into the trees, and
  enemy fire from the bank is a constant risk. Paddies and dikes open the ground
  up, and villages sit on the edges.
- **Look.** Readable at a glance: paddies and buffalo, Hueys, palms and nipa palms,
  mangroves, stilt huts, sampans, red dirt roads, haze, coloured smoke.

## Maps (campaign order)

| # | Map | What it's about |
|---|-----|-----------------|
| 1 | Kilgore's beach village | Huey assault on a coastal village, napalm on the treeline, surf |
| 2 | **The delta** | river branches, boats, paddies, hamlets, ambush from the banks — **first map built (vertical slice)** |
| 3 | Supply depot (night) | a lit US depot on the river, flares, a chaotic show |
| 4 | Do Lung bridge (night) | a bridge under constant fire and rebuild, tracers, no clear front |
| 5 | French plantation (fog) | a rubber plantation, the colonial house, fog banks |
| 6 | Kurtz's temple compound | a stone temple up a gorge, Montagnard warriors, bodies, smoke |

**"First:"** in the lists below means the map that needs the item first, **in build
order**. The delta comes first, then the rest in campaign order (Beach, Depot,
Do Lung, Plantation, Temple). That makes the delta lines the asset to-do list for
the vertical slice.

## Units (rough)

US:
- Rifle squad (M16, one M60, one M79) — First: Delta
- Boat crew (the patrol boat's four men, the hero squad) — First: Delta
- Patrol boat (PBR-like: twin .50 at the bow, M60 at the stern) — First: Delta
- Huey transport (slick) — First: Delta (evac / reinforcements)
- Huey gunship (rockets, door guns) — First: Beach
- Air cavalry squad (lands from a Huey) — First: Beach
- Napalm strike (called in, not built) — First: Beach
- Radio operator / forward observer — First: Delta
- Engineer squad (bridge repair, sandbags) — First: Do Lung
- Mortar team — First: Depot
- Medic — First: Delta

Viet Cong / NVA:
- VC guerrilla squad (black pyjamas, SKS / AK, ambush) — First: Delta
- VC sampan (armed, or a supply runner) — First: Delta
- VC RPG team — First: Delta
- VC machine gun team (RPD / DShK on the bank) — First: Delta
- VC sapper (mines, booby traps, swims) — First: Do Lung
- NVA regular squad (pith helmet, AK) — First: Do Lung
- NVA mortar team — First: Do Lung
- Sniper in the trees — First: Do Lung

Others:
- Civilians (farmers, boat people, the market) — First: Delta
- French planters / their militia — First: Plantation
- Montagnard warriors (Kurtz's men) — First: Temple

## Buildings and props (rough)

- Stilt hut (nipa thatch, bamboo floor over water) — First: Delta
- Hamlet house on the ground (thatch, mud walls) — First: Delta
- Fishing pier / bamboo jetty — First: Delta
- Fish traps, nets on poles — First: Delta
- Paddy dikes and small water gates — First: Delta
- Bamboo footbridge — First: Delta
- VC bunker / spider hole / tunnel entrance — First: Delta
- Small pagoda / shrine — First: Delta
- Sandbag post and wire (US) — First: Depot
- Supply depot (tents, crates, fuel drums, floodlights, show stage) — First: Depot
- Helipad (PSP plates, coloured smoke marker) — First: Beach
- Beach village houses and church — First: Beach
- Do Lung bridge (long steel bridge, lights, bunkers on both ends) — First: Do Lung
- Colonial plantation house (veranda, shutters) — First: Plantation
- Rubber tapping cups and sheds — First: Plantation
- Khmer-style stone temple, steps, heads, gates — First: Temple
- Hung bodies, totems, cages — First: Temple
- Wrecks: Huey, boat, truck — First: Delta (one wreck), the rest later

## Nature (rough)

- River network (main channel + branches, muddy brown water) — First: Delta
- Rice paddies (flat flooded fields, terraces in the hills later) — First: Delta
- Water buffalo (from the Bull, via the animal builder) — First: Delta
- Coconut palm — First: Delta
- Nipa palm (on the water's edge) — First: Delta
- Mangrove (stilt roots in the water) — First: Delta
- Banana — First: Delta
- Bamboo clumps — First: Delta
- Elephant grass / reeds along the banks — First: Delta
- Water hyacinth / lilies floating — First: Delta
- Red dirt roads and dike paths — First: Delta
- Low haze, river mist — First: Delta
- Coloured smoke (purple, yellow, green markers) — First: Delta
- Chickens, ducks — First: Delta
- Jungle trees (dipterocarp, banyan, fan palm, ferns) — First: Do Lung
- Beach sand and surf — First: Beach
- Rubber trees in rows — First: Plantation
- Fog banks in rows of trees — First: Plantation
- Gorge cliffs, waterfall — First: Temple

## Asset rules

- Generators are shared. Each game has **one settings file** for its values.
- **A thin review lab per game** that uses the game's own light and sky.
- An asset **moves to shared when a second game needs it**. Never copy-paste it.

## Order after the design phase

1. The delta terrain in the editor (vertical slice).
2. A river-fight test: the alg units and one simple boat.
3. Assets, in the order the delta needs them (the "First: Delta" lines above).
4. The main menu last, from the shared new-game template.

---

## Unit inventory (2026-10-17)

How alg-rts makes units: `tools/packMixamo.mjs` packs `assets-src/soldiers/`
(one Mixamo rig FBX + animation FBX + unrigged GLB bodies) into
`public/models/soldiers/soldiers.glb`. Each faction is a **look** in
`games/shared-rts/soldierLooks.js`: uniform recoloured by hue, helmet on or off,
headgear and kit hung on bones. Weapons are procedural, in
`games/shared-rts/procWeapons.js`.

### Bodies (models / skins)

| Body | File | In the alg pack? | Notes |
|------|------|------------------|-------|
| soldier1 | `assets-src/soldiers/originalsoldier_compressed.glb` (material "Light") | yes, also the rig's texture | US-style fatigues, netted helmet, light skin (`soldier textures/Image_3.png`) |
| aln1 | `aln1_compressed.glb` ("Heavy") | yes | used for the ALN |
| aln2 | `aln2_compressed.glb` ("Scout") | yes | used for the ALN |
| soldier3 | `soldier3_compressed.glb` ("Light_2", goggles on the helmet) | **no**, skipped on purpose, kept for the Vietnam game | not packed anywhere yet |

**The Black soldier and the other extra looks are not in the repo.** Nothing in
the project or in Downloads / Desktop / Documents matches one by name.
Found outside the repo:
- `Downloads/ww2_us_army_ranger.glb`: 41 MB Sketchfab model, unrigged, 36 parts,
  WW2 kit. Not a Vietnam soldier, and a different build, so the pack's fit test
  would probably refuse it.
- `Downloads/appele_mixamo.fbx` (2026-10-15): probably an alg upload to Mixamo.

→ **Needed from you:** the files of the extra skins (Black soldier, others).
Where do they come from (which pack or site)? If they are the same pack as
soldier1/aln1/aln2/soldier3 (same body, same pose), they drop straight into the
pack. Stopgap: darker skin is already a look parameter (`ALN_SKIN` multiplier),
but it only tints the skin. The face doesn't change.

### Animations

The alg pack has 48 clips on one 37-bone Mixamo skeleton: idle, aim, walk, run,
crouch walk / strafe / idle / fire, prone idle / crawl / fire, kneel↔stand↔prone
transitions, reload, grenade ×2, hit, 8 deaths (forward, backward, blown,
kneeling ×2, prone, running), injured walk, cower, carry walk, dig, plant,
pick fruit, point, drive, sit, sit talk, para landing ×2, the 6 mortar clips,
unarmed idle / walk / run (civilians).

In Downloads, not in the pack: `Standing Aim Walk Forward/Back/Left/Right.fbx`,
`Shooting Arrow.fbx` (Montagnard bow?).

Missing for Vietnam:
- wading in water / swimming (sappers, river crossings)
- getting into and out of a boat; firing seated or kneeling on a deck (sit exists)
- jumping out of a hovering Huey; door gunner firing from the doorway
- carrying a wounded man / fireman's carry
- firing an M60 from the hip; firing a launcher from the shoulder (RPG / M79)
- `rifle_sprint` has a name in the pack tool but no clip
- civilians: squatting, carrying on a shoulder pole, rowing a sampan, planting rice
  (`plant` may do)

### Weapons

Have (procWeapons): MAS 49/56, MAT 49, MAS 36, FM 24/29, Mauser 98k, Lee-Enfield,
LF50 flamethrower, M18 57 mm recoilless, M20 bazooka. The last two were US-made and
were used early in the war, so they fit the VC too. Tools: shovel, mortar
bomb, binoculars, crate. Also `assets-src/soldiers/Ultimate Guns Pack-glb/`
(generic rifles, SMGs, pistols, shotguns, tripod, bipod, unused).

Missing: M16, M60, M79, M1911, M2 .50 (twin on the boat), AK-47 / Type 56, SKS,
RPD, RPG-2/B40 and RPG-7, DShK (alg has one, check), PPSh / K-50, bow
(Montagnard), crossbow.

### Headgear and kit

Have: the netted US helmet (in the texture, the `us` look), bush hat (close to a
boonie), beret, scarf, packs, radio, belts, binoculars, sunglasses, cigarette,
mustache. Asian conical hat model `public/models/asian_conical_hat_compressed.glb`.

Missing looks: US Vietnam (OG-107, boonie, flak vest), VC (black pyjamas, conical
hat or bare head, checked krama scarf), NVA (khaki-green, pith helmet), boat crew
(bare arms, headbands, no helmet), Montagnard (loincloth, bare chest, paint),
French planter (white suit, hat). Missing kit: flak vest, M60 ammo belts across
the chest, Ho Chi Minh sandals, life vest.

### Vehicles and animals

- `v3/render/objects/rtsVehicles.js` (nam-era, sits in the engine): UH-1 Huey, Huey
  wreck, M113, M48, M151, M551, PT-76, M35, Molotova. `public/models/heli5.glb`
  also exists. **No boats at all.** Do these count as "old nam assets"? Your call.
- Animals: `public/models/Bull_compressed.glb` and the animal builder
  (`v3/props/animalMorph.js`, donkey → sheep / goat / camel), so a buffalo is a new
  morph. Chicken model, alg hens.

### Nature generators already in the engine

Palm, nipa palm (preset), pandanus (stilt roots, a start for mangrove), banana,
bamboo, fern cards, banyan, dipterocarp, areca, fan palm, traveller's palm,
jungle tree; river network v2, rice terraces, napalm, fog banks, smoke columns.
Missing: a true mangrove, rubber trees in rows, floating water plants,
elephant grass.
