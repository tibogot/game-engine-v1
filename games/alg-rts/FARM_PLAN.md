# The farms of Oued Abdi — new pieces from the Aurès

2026-10-30 (you: "ok lets go", the farms and the sheepfold). Every piece is new and built from references
(see memory: new assets, never remakes). Nothing here is the old farmstead re-textured: the farmstead
(tools/blender/farmstead.py) stays the old Aurès'. Abdi's farms are the mechta kit's stone houses plus two new pieces.

## What the references say

- The Aurès house (taddart) keeps the flock on its ground floor (the *zerdab*, the damp part, with fodder and
  wood); people live above. The mechta kit's `pente` and `etage` houses already carry this.
- On the slopes the shepherds' fold is a ZRIBA: a simple round enclosure of stacked stones or thorny branches,
  rebuilt each year (a sheep-housing manual: agrimaroc.org, ch. 10). It stands against a low shelter of stone and
  wood; the high Aurès villages were built "entirely of dry stone and wood" (Habitat traditionnel dans les Aurès).
- The THRESHING FLOOR: a round of beaten earth (or flags) on open, windy ground, ringed with slabs set on edge. Mules
  were driven round a post in its middle, or hauled a threshing board studded with stones. The straw is heaped beside
  it and the winnowed grain made into a cone. (Mediterranean sources; nothing Aurès-specific was found, so this is
  the shared form.)

## The pieces (tools/blender/mechta.py)

- [x] **`bergerie`, the sheepfold.** A long, low dry-stone SHELTER, its front open on three rough posts and a beam.
      The roof is poles, a brush layer with its fringe hanging at the front, and a skin of packed earth (lumpy, its
      edge slumped) held down with stones, with hay on top. In front is the ZRIBA pen, built stone by stone on a round
      outline, dead thorn branches along its top, and a gateway closed by a woven hurdle. Inside: a stone trough and
      hay. Damaged: the roof's middle fallen in, the pen breached, the hurdle knocked flat. Ruin: the walls' stumps
      and burnt beams.
- [x] **`aire`, the threshing floor.** No floor of its own: the floor is the ground, beaten. A ring of slabs on edge,
      of every size and unevenly sunk, a few missing; the post in the middle; the straw heap; the grain cone; the
      threshing board; a wooden fork; chaff spread round. One state.

## Placed (maps/abdi.js, the town's rows)

- **Ferme Ouled Saïd:** a one-room house and the farmer's loggia house shoulder to shoulder, the yard behind, the
  goats' lean-to at the west end (the piste runs north past their east end), the threshing floor out in front. The
  point is in the front yard.
- **Bergerie:** the sheepfold, the piste ending at its gate; the shepherd's one-room house beside it; its oven.

## What the lab taught (kept in the code's comments)

- A cylinder floor read as a cake. A darker floor read as a dark disc on Abdi's pale ground. Any one colour is wrong
  on some map, so the floor is the terrain.
- A dung heap read as a boulder twice, so there is none.
- Brush cards every 1.25 m read as a hedge in the game: they are now one every ~2.4 m, small, among dead branches.
- One breach shape through two roof layers made their cut walls one face (the coplanar gate). Each layer now gets
  its own hole.
- The wall helper (`stoneWallPath`) showed its flat rubble core at outer corners and through breaches. It now adds a
  stack of stones at each bend and cuts the core at the breach. This applies to the koubba's enclosure and the low
  wall too, on their own random draws, so their stones stay as you saw them.
