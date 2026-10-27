# The FLN camp and its cave — in Blender, for the new maps

Started 2026-10-27, after the stone villages (MECHTA_PLAN.md, DECHRA_PLAN.md). Same rules: **for you to correct
before any modelling**; **(?)** = I am not sure. Search terms: « camp ALN Aurès 1956 », « katiba maquis photo »,
« refuge ALN casemate », « grotte maquis Aurès », « Djebel Chélia maquis ».

## 1. What a katiba's camp looked like (the checklist)

- [ ] **Hidden, not built**: in a ravine, under a cliff or in the cedars and junipers — out of sight of the
      French spotter planes (the Piper, the Alouette). Little stands in the open; the camp reads as rock and scrub.
- [ ] **The refuges (casemates)**: half-buried rooms, a dry-stone front wall, a roof of beams under earth and
      brush, a low door — invisible from the air. The katiba slept, stored and hid in them.
- [ ] **The command post**: often a requisitioned stone house or a mechta on the slope (our mechta houses), its
      roof brushed over **(?)**, a radio's antenna wire.
- [ ] **The cave**: a natural cave in the cliff — a dry-stone breastwork across the mouth, timber shoring, brush
      over it; arms, food and the wounded inside. The FLN's heart on our map (its destruction wins the battle).
- [ ] **Small things**: a fire hidden under an overhang (no smoke by day), cooking pots, jerrycans, water skins,
      mules tethered, the infirmary (we have it), the arms cache (we have it), sentries on the rocks (the lookout:
      we have it).
- [ ] **The flag (?)**: the green-and-white flag with the red crescent — shown at the camp in the game (it is the
      capture point's mount), though a real camp would rarely fly it.

## 2. What the game has today

- **The camp** (algAlnCamp buildCampV2, the old and the new Aurès alike): a stone house (the PC), a dugout, a reed
  store, dry-stone sangars, the forecourt walls, the fire ring, the flag's cairn, the sandstone rock behind.
  **62.8k triangles near and 61.2k far — no real level of detail**, 9 draws. Readable, but plain: nothing says
  « hidden maquis », nothing is camouflaged.
- **The cave** (algCave): the sandstone generator's rocks (the CoH 3 rocks — judged good) round the mouth, the old
  kit's shoring and breastwork. One draw.
- **Already in Blender, reusable**: the arms cache, the FLN refuge and infirmary, the lookout, the mine marker, the
  sangar, the mechta houses.

## 3. The kit (proposed — Blender, through tools/blenderKit.mjs)

| Piece | What | States |
|---|---|---|
| `casemate` | the refuge: half-buried, dry-stone front, beams + earth + brush roof, low door | intact / damaged / ruin |
| `pc` | the command post: a mechta house with brush on its roof, the antenna wire, jerrycans | intact / damaged / ruin |
| `grotte` | the cave's MOUTH: breastwork, shoring, brush, its dark inside — set into the sandstone rocks the game already makes | intact / damaged / ruin (blown in) |
| `foyer` | the hidden fire: a stone ring under a brush shade, pots, a kettle | one |
| `bivouac` **(?)** | sleeping places under a rock: blankets, packs, rifles stacked | one |
| `mulets` **(?)** | the mules' rope line, their packs (the animals: the game's) | one |

Same standard (LOD that really drops, compressed textures, the three gates, the lab). The brush (camouflage) by the
card technique — the haystack's straw cards, as REMAINING.md 6 asks for the thorn fence and brush piles.

## 4. The cave stays the game's objective

The cave is a **structure** (the FLN's producer and the battle's goal): its health, its garrison of the wounded, its
fall. The Blender `grotte` gives it states that follow its health (algTownDamage's way): breastwork breached when
damaged, the mouth blown in when destroyed. Its rocks: the sandstone generator's, as now.

## 5. Where it goes

The new Aurès and the new maps (a map flag, as the villages); **the old Aurès keeps its camp and cave as they are**.

## 6. Questions — with what I suggest

1. **Hidden or showy?** Hidden: the camp under brush, half in the ground — the French have to find it. (Gameplay:
   it already sits in the fog until scouted.)
2. **The flag?** Keep it (the capture point needs its mount) — on a short pole at the cave's mouth, not a tall mast.
3. **The PC**: a mechta house with brush (reuse) rather than a new building.
4. **Order**: `casemate` + `grotte` first (the camp's look and the objective), then `pc`, `foyer`; the bivouac and
   the mules later.
