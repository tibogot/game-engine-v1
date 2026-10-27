# The dechra — the Aurès stone village as a Blender kit

Started 2026-10-27, after the mechta (MECHTA_PLAN.md, committed 411c34a1). Same rules: **for you to correct before
any modelling**; **(?)** = I am not sure, check it in photos. Search terms: « Menaa village Aurès », « dechra Nara
Aurès », « vieux village Arris », « Tighanimine 1954 », « mosquée Aurès pierre », « djemaa village chaoui ».

## 1. What a dechra is (the checklist)

The mechta is a hamlet — a family's few houses. The **dechra** is the village: 20–40 houses, the mosque, the
meeting place, the granary. In the new Aurès it is **Dechra Tighanimine** (the gorge of the 1 November 1954 ambush).

**The village**
- [ ] **Built up a slope in terraces**: rows of houses one above the other, each row's roofs at the next row's feet;
      dry-stone **retaining walls** hold each terrace.
- [ ] **Narrow lanes with stone steps** climbing between the rows; covered passages here and there **(?)**.
- [ ] **Dense**: houses wall to wall, little open ground — one small square, the **djemaa** (the elders' meeting
      place), with stone benches along a wall.
- [ ] **The mosque**: a plain stone prayer hall with a flat roof, a squat square **minaret** (≈6–9 m) — or none,
      the call from the roof **(?)**. Often the one building with lime on it.
- [ ] **The guelâa** (collective granary) on the crest above the village, a small fortress of cells **(?)** — later.
- [ ] Below: gardens and orchards on the terraces, the oued, the threshing floors (the new Aurès' fields already).

**The houses** — the mechta's, but more of them taller: two-storey **etage** and **pente** common, a few **tower
houses** of three storeys (Menaa) **(?)**, the timber courses on most, lime round some doorways.

## 2. What the game has today

- **The old Aurès** (untouched): the code-built dechra (algMasonry buildDechraV2 over rtsAlgVillage buildDechra):
  rows up the real slope, lane stairs, yards, a mosque, garrisons.
- **The new Aurès**: Dechra Tighanimine is two rings of the **M'zab** plain houses — ochre plaster, wrong for the
  Aurès (`maps/auresNew.js` DECHRA: « the stone dechra kit to come »).

## 3. The kit — reuse the mechta, add what a village has

| Piece | What | States |
|---|---|---|
| mechta `petite`, `etage`, `pente`, `appentis`, `enclos`, `tabouna` | as they are (the mechta kit) | as they are |
| `masjid` | the stone mosque: its hall, a low square minaret, lime on the door and the minaret's top | intact / damaged / ruin |
| `soutien` | a terrace's retaining wall: dry stone, 4 m a module, ~2 m high, a knee-high parapet on top (cover for the row above) | intact / breached / ruin |
| `escalier` | stone steps up a terrace, between two walls (the lanes) | intact / ruin |
| `djemaa` | the square's stone benches along a wall, a plane tree's seat **(?)** | one |
| `tighremt` **(?)** | a three-storey tower house | intact / damaged / ruin |
| `guelaa` **(?)** | the granary on the crest | later |

Same standard as the mechta (tools/blenderKit.mjs: one piece at a time, the three gates, the lab).

## 4. The layout (the map) — and what it gives the fight

- **Three terraces** up the slope at the site, each a row of houses on its retaining wall, **lanes with steps**
  between them; the **djemaa** square at the village point (the flag); the **mosque** at the top, its minaret the
  landmark seen from the post.
- **For the fight**: the upper rows look over the lower ones (garrisons firing down), the retaining walls' parapets
  are hard cover along each terrace, the lanes are the ways in — the village is taken row by row, not crossed.
- **The tools exist**: the town field (houses, garrisons, damage), its props (walls, stairs as nav and cover), the
  hillside house's pad cut into the slope. New: a terrace's pad at its row's height (the retaining wall standing on
  the lower ground, the row on the upper).

## 5. Where it goes

The new Aurès only (`?dechra=1` while you judge it, as the mechta's `?mechta=1`). **The old Aurès is untouched.**

## 6. Questions — with what I suggest

1. **Minaret?** Yes, a squat square one (≈7 m): the village's landmark, and a tall point to fight for.
2. **Lime?** On the mosque (door, minaret top) and round a few doorways only — the village stays stone.
3. **Tower houses (tighremt)?** One or two, for the skyline — after the mosque and the terraces.
4. **The guelâa?** Later, as its own landmark on the crest.
5. **Order**: `soutien` + `escalier` + `masjid` first (the new pieces), then the layout with the mechta houses,
   in the lab and behind `?dechra=1` for your verdict.
