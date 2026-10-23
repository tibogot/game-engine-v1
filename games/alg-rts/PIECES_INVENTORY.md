# EVERYTHING WE PLACE ON A MAP — the inventory (2026-10-20)

You: "now when we build new buildings we can already make a damage or in-construction version … the lab should show
everything, even the requisition point … the fields look cheap in the old Aurès — since we are working on the new
Aurès it's time to check everything we place, one by one."

Every kind of thing the game places (not units), what it is today, and my verdict. **Mark your priority in the last
column** (1 = first); I redo the pieces in that order, each one judged in the lab beside its old version.

## The standard for a redone piece

- Built in **Blender** (or the sandstone / photo generators where they already shine), **optimised**: LOD near /
  far, one atlas per kit, instanced when repeated, KTX2.
- Born with **all its states**: intact → damaged → ruin (the damage system plugs into them later), and for what
  sappers or the FLN build, its **construction stages** (the helipad's algConstruction.js, for all).
- In the **lab**, all its states side by side, beside the old version.
- The **old Aurès keeps its pieces** (untouched); the new ones go to Oued Abdi first, the other maps on request.

Verdicts: **KEEP** (good as it is) · **IMPROVE** (its own code, better look) · **REDO** (Blender, the new standard) ·
**STATES** (good, needs its damage / construction states) · **LAB** (only missing from the lab).

## French base

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| The post (bordj, towers, gate, barracks, mast) | procedural kit (rtsFrenchPost), Blender cloth-sim bags | **REDO** — the biggest piece; already planned (AURES2_PLAN: the new post, this map only) | |
| Post flag, gate palms | cloth sim, plants | KEEP | |
| Motor pool | old procedural in the game; the Blender one **lab only** (the code says so) | **STATES** + put the Blender one in the game (its far LOD) | |
| Helipad | new procedural + cloth bags, windsock; construction anim in the lab only | **STATES** — its construction anim into the game | |
| Vehicle park (parked vehicles) | the units' models | KEEP | |

## French buildables (sappers)

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| Sandbag wall | Blender cloth-sim bags; a breached state | **STATES** (construction stages) | |
| Barbed wire | procedural | **REDO** + **LAB** (not in the lab) | |
| MG nest | kit + Blender bags | **STATES** | |
| Mortar pit | photo materials + Blender bags | **STATES** | |
| Mirador (watchtower) | procedural | **REDO** + **LAB** — very visible | |
| Searchlight tower | procedural | **REDO** + **LAB** | |
| Forward post (radio shelter) | nam's kit | **REDO** + **LAB** | |
| Aid station (tent) | nam's kit | **REDO** + **LAB** | |
| Fortified point | kit + Blender bags | **STATES** | |
| SAS post (beside a hamlet) | procedural | **REDO** + **LAB** | |

## FLN

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| Maquis camp | V2 (sandstone generator + kit) | **STATES** (it's good) | |
| Cave | V2 sandstone | KEEP (+ states) | |
| Arms cache | procedural | **REDO** + **LAB** | |
| Refuge (casemate) | procedural | **REDO** + **LAB** | |
| Infirmary (brush shade) | procedural | **REDO** + **LAB** | |
| Lookout (crests) | procedural | **REDO** + **LAB** | |
| Sangar | procedural | **REDO** + **LAB** — the FLN's sandbags: very visible | |
| Ambush screen | procedural | **REDO** + **LAB** | |
| Mine marker / laid mine (pole + rag) | plain meshes | **IMPROVE** + **LAB** | |

## Villages and towns

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| Mechta (your brown houses) | V2 photo stone; burns, rubble heaps, no collapse | **STATES** (kept as you liked them; their states = the damage) | |
| Dechra (stone, up a slope) | V2 photo stone | **REDO** — the plan's STONE KIT in Blender (Oued Abdi's dechra) | |
| Ksar el Hamra (old Aurès town) | V2 | KEEP (old Aurès) — Oued Abdi has the M'zab town | |
| M'zab town (houses, souk, mosque) | Blender, 3 states | KEEP — wall patchwork / roof clutter later | |
| M'zab terrace wall | Blender, 3 states | **LAB** | |
| Whitewashed houses | Blender, 3 states | KEEP (the oasis) | |
| Koubba (saint's tomb) | procedural | **REDO** + **LAB** | |
| Cemetery | procedural | **IMPROVE** + **LAB** | |
| Village well | procedural | **REDO** + **LAB** — at every village | |
| Zeriba (thorn pen) | kit in the game; Blender ones **lab only** | Put the Blender ones in the game | |
| Farmstead (house, yard, pen, olive) | procedural | **REDO** | |

## Ruins and landmarks (old Aurès)

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| Roman ruins (temple, columns, colonnade, road, arch, oil press) | procedural, in the lab | KEEP (old Aurès) | |
| Burnt farm, ruined huts | procedural | **IMPROVE** + **LAB** | |

## FIELDS AND FARMING — "the cheap look"

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| Field plots (ploughed, stubble, barley, orchards) | shader-draped flat quads | **REDO** — real soil (furrows, clods: paint + photo decals), real crops (instanced barley, wheat, stubble), the orchards' trees kept | |
| Field walls (dry stone) | procedural segments | **REDO** — Blender dry-stone modules, with breach states (cover) | |
| Prickly-pear hedges | plants | **IMPROVE** — real cactus models (concealment) | |
| Walled gardens (olive, fig) | procedural | **REDO** with the new walls | |
| Almond terraces | procedural | **REDO** — stone terrace walls (the M'zab "mur" idea, rural) | |
| Threshing floors | procedural | **IMPROVE** | |

## Village life

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| Haystacks, woodpiles, bread ovens (tabouna), beehives | procedural, instanced | **REDO** as one Blender PROPS kit (+ jars, carts, crates, drums, a market stall — today they only exist inside bigger pieces) | |

### THE PROPS PASS — 2026-10-23 (you: "everything in the game should be coherent … if we make a better oil drum the
### others shouldn't look cheap … and the best optimisation possible")

Inventory (a code sweep + game crops, fog off, ~38-70 m). Most small props are ALREADY Blender, baked inside their
building's atlas (houses, M'zab, points, motor pool, post, field / FLN posts, fort point, cache, mortar pit, MG nest,
sangar, searchlight tower). What is still below the bar:

| Prop | Today | Plan |
|---|---|---|
| **Oil drums** (motor pool, fuel points, searchlight tower, post shed, helipad) | Blender, but plain cylinders, each script its own | ONE shared Blender drum (rolled ribs, chimes, bung caps, dents, rust/paint) in a shared props module the building scripts call → those kits rebuilt; same for **jerrycan**, **wooden crate**, **steel ammo box** |
| Haystacks, woodpiles, tabouna, beehives (algVillageLife, 4 kinds, ~45 placed) | procedural, instanced + static batch | Blender village-props GLB (near / far, one atlas), drawn the same instanced way — the haystacks read as woven baskets today |
| Village well + stone troughs + jars (3 wells), zeriba trough, farmstead oven + jars | procedural, merged into their piece | the same village-props kit |
| Helipad fuel corner and radio corner | procedural (rtsAlgeria) | the shared drum / jerrycan / crate |
| FLN cave camp + cave entrance clutter (sacks, crates, pot, bedrolls, lean-to) | procedural | the props kit (FLN half) |
| Mine marker (pole, rag, cairn); laid mines one Mesh each | procedural, not instanced | small; with the props kit, instanced |
| Telegraph poles | procedural, instanced | KEEP (fine at RTS zoom) |
| `smallprops.glb` (21 weapons / kit items, Blender) | only the HUD icons | KEEP — usable as ground clutter later (dropped weapons) |

Order: (1) the shared drum, then jerrycan / crate / ammo box — you judge the drum first, in the game; rebuild the
kits that use them; (2) the village-props kit (haystack, woodpile, tabouna, beehives, well, troughs, jars); (3) the
helipad corners, the FLN camp. Every prop: a near and a far level passing tools/glbLodShadingCheck.mjs, a few
hundred triangles, one shared atlas, instanced where repeated.

## Points

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| Capture flag (village points) | live cloth flag on a pole | **IMPROVE** + **LAB** — its base (a cairn, a stone plinth) | |
| Supply mast | guyed steel mast, instanced | KEEP | |
| Fuel depot, ammo dump | procedural, instanced, in the lab | **REDO** in Blender (very visible: every supply point) | |
| Point rings | shader decals | KEEP | |

## Nature, lines, the rest

| Piece | Today | Verdict | Prio |
|---|---|---|---|
| Telegraph poles + wires | procedural, instanced; felled state | **IMPROVE** + **LAB** | |
| Limestone outcrops (old Aurès) | faceted procedural | KEEP (old Aurès; the sandstone replaces them elsewhere) | |
| Sandstone rocks | generator, in the lab | KEEP | |
| Scattered stones | generator | KEEP | |
| Lone trees, agaves, broom… | plants | KEEP (plant lab) | |
| Rubble heap (shelled house) | procedural | **REDO** with the damage system | |
| Wrecks, dropped weapons | charred vehicles, instanced | KEEP | |
| Ground decals, splats, tracks | baked | KEEP (the decals passes) | |

## What I'd do first (my suggestion — your marks decide)

1. **The fields** (plots, walls, hedges): the cheapest look today, and big on screen.
2. **The FLN's and the French's small buildables** (sangar, mirador, wire, ambush screen, cache): seen in every
   fight, and they need construction stages anyway.
3. **The supply depots** and the **well**: at every point and every village.
4. **The props kit** (village life + jars, carts, crates, stalls).
5. **The dechra's stone kit**, the **koubba**, the **farmstead**.
6. **The new post** (the biggest single piece).
7. Everything missing from the lab gets its entry as it is redone (or before, to judge the old one).
