# The mechta — Aurès stone hamlet as a Blender kit

Started 2026-10-27 (REMAINING.md "Suggested order" 1). The checklist below is **for you to correct before any
modelling**: strike what is wrong, add what is missing. Marked **(?)** = I am not sure, check it in photos.

Search terms for photos: « maison chaouia Aurès », « dechra Aurès », « Ghoufi balcons », « Menaa village »,
« Tighanimine », « Arris 1956 », « mechta Aurès 1955 », « guelaa Aurès grenier ».

## 1. What an Aurès stone house looks like (the checklist)

**Walls**
- [ ] Rough local stone, not dressed, laid in mud mortar. The stone has the same ochre-grey as the ground, so from
      far off a village reads like a rock outcrop.
- [ ] **Timber courses** in the wall: a flat band of juniper or cedar logs every ~0.7–1 m of height (Ghoufi). **(?)**
      Every house, or only the big ones?
- [ ] In the valleys (Oued Abdi, Menaa, Arris): a **stone base and mud-brick (toub) above**, the brick plastered
      with mud. Up in the mountain: stone all the way up.
- [ ] Walls thick (~0.5 m), slightly battered (leaning in as they rise), corners not sharp.
- [ ] Hardly any whitewash. **(?)** Lime around the door, or a white band, on some houses.

**Roof**
- [ ] Flat terrace: juniper/cedar beams whose **ends stick out** of the wall, then branches/reeds, then packed clay.
- [ ] No parapet, or a very low one. A **wooden or stone spout** throws the rainwater off.
- [ ] The roof is used: drying apricots and figs, grain sacks, jars, firewood, hay (our rooftop hay piles), a ladder
      to reach it, a laundry line.

**Openings**
- [ ] One **low door** (≈1.7–1.8 m) with a timber lintel and a plank door, often ajar.
- [ ] Very few windows: small square holes high up, ventilation slits, small triangular niches.

**Storeys and shape**
- [ ] One storey for a small house. Two or three where the slope allows: the ground floor is for the animals and
      storage, people live upstairs.
- [ ] An **upper room open on a loggia** with wooden posts (Ghoufi), set back on the roof of the room below.
- [ ] **Built into the slope**: the back wall is buried, the front has two storeys, and one house's roof is the
      next one's yard.
- [ ] A **lean-to** of reed or branches on poles at one end, behind low dry-stone walls (a stable or shed).

**The hamlet around them**
- [ ] Houses touching each other in short rows or clusters, narrow lanes, stairs on the slope.
- [ ] **Yards** walled in dry stone (~1.3 m), a **tabouna** (domed clay oven) in some of them.
- [ ] Goat and sheep pen, threshing floor (a flat round of beaten earth), stacked firewood, sheaves.
- [ ] Below the village: gardens and orchards (apricot, fig, palms in the low oueds), irrigation channels.
- [ ] **(?)** A **guelâa** (fortified collective granary) on a spur above some villages: a landmark, worth one piece?
- [ ] **(?)** **Gourbis** (poor huts of stone and branches, thatched) around the hamlet for the poorest families.

## 2. What the game has today (the runtime builder)

`algMasonry.js` `addMechtaHouse` / `buildMechtaV2` (2026-10-11), in the lab as « Mechta » and « Hameau »:
- **Houses:** dry-stone walls, a clay terrace inside a broken parapet, beam ends, a low door, a small window, spouts.
  Some have the loggia upper room, some the reed lean-to. Firewood, sacks, jars and laundry on the roofs.
- **Layout:** the hamlet is two rows along a lane, doors on the lane, walled yards behind, an oven in some.
- **Gameplay data the kit must keep:** each house's door, footprint, nav rects, hard cover lines and garrison.
- **What is missing:** the timber courses, the stone + toub valley house, houses built into the slope, the gourbi,
  the granary, a real damaged and ruin state, LOD, compressed textures, and the sharp-surface material.

## 3. The kit (proposed — Blender, `tools/blender/mechta.py`, house.py's buildKit)

| Piece | What | States |
|---|---|---|
| `MechtaS` | one room, one storey, ~5 × 4 m | intact / damaged / ruin |
| `MechtaM` | two rooms, the loggia upper room on part of the roof | intact / damaged / ruin |
| `MechtaValley` | stone base + toub upper storey, timber courses (Oued Abdi) | intact / damaged / ruin |
| `MechtaSlope` | built into the slope: buried back, two storeys at the front (Ghoufi) | intact / damaged / ruin |
| `LeanTo` | reed roof on poles, low dry walls — snaps to a house end | intact / ruin |
| `YardWall` | dry-stone runs: straight 4 m, corner, gate gap (drystone.py) | intact / broken |
| `Tabouna` | the domed oven | one |
| `Gourbi` **(?)** | the poor hut, thatch (the card technique, as the haystack) | intact / burnt |
| `Guelaa` **(?)** | the granary landmark | intact / damaged |

- **Damaged:** a hole in a wall, half the roof fallen in with its beams hanging, the door gone, soot above the openings.
- **Ruin:** wall stumps 0.5–1.5 m, a rubble mound inside, charred beams. On the new maps it takes the place of the
  old « ruined hut » (REMAINING.md 8); the old Aurès keeps its own.
- **Technical (the same standard as the houses and the M'zab):**
  - `buildKit(..., surfaces=True)`: drystone's build order, the stone, wood and plaster classes, and the photo
    detail in algSurfaces;
  - near and far LODs, ETC1S, the coplanar and LOD-shading gates;
  - `_Hay` spots on the roofs; the ground blend at the foot.
- **Game data:** each piece carries its door, footprint, firing openings (garrison) and cover, as the whitewashed
  houses do (algHouse) — the maps place them in their `town.houses` lists.
- **Scale:** modelled in real metres, ×1.3 in the game (as every kit).

## 4. Where it goes — the NEW maps only; the old Aurès stays as it is

Checked 2026-10-27:
- **The old Aurès** (bare `alg.html`, `maps/aures.js`) draws its two hamlets with the runtime builder
  (showroom.js `buildMechtaV2`). **Nothing here touches it:** the kit adds NEW pieces; `buildMechtaV2`,
  `addMechtaHouse` and the old « ruined hut » stay exactly as they are.
- **The new Aurès** (`?map=auresNew`) already skips the old hamlets (`skip: ["mechta", "mechta2", …]`). Its
  Mechta Ouled Ali and Mechta el Oued are stand-ins today: the whitewashed kit houses (`MECHTA_OA`, `MECHTA_EO`), and
  the dechra the M'zab plain houses (« the stone dechra kit to come »). The mechta kit replaces those lists.
- **Later, if you want:** Oued Abdi's and the maquis' hamlets (runtime builder today) → the kit, one map at a time,
  each with your go.

## 5. Questions for you — with what I suggest

1. **Valley or mountain look?** Both, one per map. The mountain house (all stone, timber courses) first, for the
   new Aurès, which is mountain country. The valley house (stone + toub) later, for Oued Abdi.
2. **Timber courses?** Yes, but on about half the houses (the bigger ones). They are the Aurès' strongest signature,
   and on every house they would read as a pattern.
3. **Parapet?** A low, uneven lip (20–30 cm) of stone and clay, not the tall broken one. From the RTS camera it shows
   the roof's edge without making a box.
4. **Gourbi and guelâa?** Later. The gourbi goes with the thatch and thorn-fence card work (REMAINING.md 6), and the
   guelâa is a landmark for one map once the houses are judged.
5. **Order:** `MechtaS` + `MechtaM`, all three states, in the lab next to today's « Mechta » for your verdict. Then
   `MechtaSlope`, the lean-to, yard walls and oven. Then they go into the new Aurès' two hamlets, and you play it.
