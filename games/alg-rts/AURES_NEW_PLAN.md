# The new Aurès (`?map=auresNew`)

2026-10-22. You: "keep the old Aurès as legacy … maybe we need a new Aurès because the terrain itself is cool".

- **What it is.** The same ground, sites, wadis, tracks and supply points as the old map (`maps/aures.js`, untouched; the menu's "Les Aurès (ancien)"). What stands on that ground is rebuilt from the new kits, area by area.
- **Where it is.** `maps/auresNew.js`, registered in `layout.js` MAPS. The menu card "Les Aurès — 1956" now opens it.
- **Shared Aurès-only code.** The briefing, post name and tactical map title test `(MAP.base ?? MAP.id) === "aures"`, so they cover both maps.
- **Testing.** Day-to-day testing happens here, on Oued Abdi, on the training map or in the lab. The old map is for regression checks only.

## Done (v1)
- **Old villages removed.** The four merged procedural villages (`mechta`, `mechta2`, `dechra`, `ksar`) are left out through `MAP.skip`.
- **Villages rebuilt.** They are now separate kit houses in the town field (`MAP.town`), 36 houses in all. Each house gets its own levelled pad, and garrisons, damage and collapse work on them.
  - **The two mechtas:** the whitewashed kit, arcs of 6 and 5 houses round each square, one house shelled in each.
  - **The dechra:** two rows of M'zab-kit houses up its slope.
  - **The ksar:** the mosque on the summit with two rings of M'zab houses round it.
- **Layout rules.** Every arc lies on the north side of its square, so every front faces the camera. There are at least 2 m between footprints (checked with a rectangle-overlap test).

## Next, area by area (one at a time; you look after each)
1. Your look at the four villages, then fixes.
2. A stone dechra kit in Blender: the dechra is in the ochre M'zab kit for now.
3. The big stones: the scans from `tools/blender/scanBoulders.py`. Check their colour and that they stay out of the field walls.
4. Village marks: wall paint and flags.
5. The French post: the Blender redesign.
6. The FLN camp: the redesign proposal.
7. The field walls, gardens and terraces round the rebuilt villages.
