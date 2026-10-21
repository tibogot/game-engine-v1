# The French training camp, redone with the new assets — the plan (2026-10-22)

You: *"now we are creating better assets maybe we have to think of the training camps again to make them look
better; they are smaller maps so easier to place fewer things."* `?map=training` (maps/training.js, the level
tools/algTrainingLevel.mjs, the lessons algTutorial.js — 18 steps).

**The rule: fewer things, each one finished.** A few hero pieces, each where its lesson happens, the camera
framed on it when the lesson starts — not a filled map.

## What the map shows today (inventory)

| Where | Now | Its lesson |
|---|---|---|
| The post (0, 118) | the old procedural post, helipad, motor pool (Blender, far only) | 11 the post, 12 tiers, 13 half-track |
| Practice mechta (-40, -12) | the OLD procedural mechta (merged mesh, no damage) | 5 take a village, 5b the houses, 14 the final |
| SAS post (-82, 45), well hamlet (-79, 1), zeriba (-29, 50) | old pieces, no lesson | — (scenery) |
| Farmstead (-58, 64) | old | 7b the shepherd |
| Supply depot (48, 36) | old depot (or the requisition point) | 6 supply |
| Knoll (70, -58) | terrain only | 4 cover / high ground |
| FLN ground (10, -140) | old FLN camp, cave, arms cache (Blender), sangar (Blender since 10-22), ambush screen (Blender), mine marker | 7 attack, 8 assault, 9 grenade |
| Sappers lesson (4b) | builds on open ground | 4b the sappers |

## Proposed changes (in order)

1. **The practice hamlet → the new houses.** 4-5 whitewashed houses (the kit's four types) on the town field
   (MAP.town, as Oued Abdi), so the garrison lesson uses houses that **damage and collapse**; one already damaged
   (shows what a shell does). The old mechta goes on this map only.
2. **A practice range beside the post** (the sappers' lesson 4b and the cover lesson): the new sandbag wall, a
   run of barbed wire, a finished MG nest and a mortar pit with their crews as the demonstration — "this is what you
   will build". A target line of posts.
3. **The supply point → the Blender requisition point** (if not already: check).
4. **The FLN ground (lessons 7-9)**: the Blender sangar with its crew, ambush screen, arms cache, a refuge —
   what the player assaults is the real FLN kit. The old FLN camp house replaced (or kept as the "camp").
5. **Clean-up**: the SAS post, well hamlet and zeriba (no lesson) — fewer, or the new pieces, so the plain
   reads as a camp's ground.
6. **The camera** framed on each lesson's piece when it starts (algTutorial).

Each step: in game, at the RTS camera, your look before the next.
