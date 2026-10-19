# AURÈS 2 (OUED ABDI) — the plan (2026-10-19)

**The map: AURÈS — OUED ABDI** (id `abdi`, decided 2026-10-19 — section 6).

You: "maybe we should do a better Aurès … the first map, we tried many things … redo without touching the old
one, more readable, new buildings as we make them". The OLD Aurès stays exactly as it is (`?map=aures`, its
level file, its layout, its buildings). The new map is its own: `?map=abdi`. It leaves the menu's map list only
when you say so.

**Status: waiting for your read.** Nothing is built yet. Mark what you change here, I follow this file.

---

## 1. What the new map keeps from the old one (what WORKED)

- **The shape of the fight** — the war's asymmetry: the French hold the valley (the post, the road, open ground
  where armour and helicopters count), the FLN start hidden in the massif and come down the gullies to raid.
- **The CoH size** (now SMALLER: ~500 m, section 6) and the starts on the diagonal; a point every 60-80 m (the old map
  measured 48 % of its ground > 90 m from any objective — the "empty map" you felt; fixed late with extra supply).
- **Wadis with fords** as the valley's chokepoints.
- **The systems**: points, supply, the AI, doctrines, the post's production, the helipad fly-ins, the camera.
  All map-driven (layout.js), so the new map only places them.

## 2. What it does differently (the LESSONS)

| Old Aurès | New Aurès |
|---|---|
| Hard to see units, worst in the north mountains (rocky paint = soldier-sized specks) | **Readable first**: calm ground at the play zoom, big clear landforms; rocky paint only where nobody fights (the skyline) |
| Ground fought for was steep or broken in places | **Walkable and CoH-flat where fighting happens** (your rule); slopes are BETWEEN areas, as edges and ramps, not under them |
| Villages from several passes (kit, V2, photo detail) | **One standard**: the Blender kits — whitewashed for the town and oases, your brown houses for farms and shepherds, a stone variant for the mountain dechra |
| Buildings merged per village | **Each house its own piece** (instanced) — building damage plugs in from day one |
| Dead zones filled late with supply points | Points and supply PLANNED with the layout, measured before anything is built |
| Terrain tuned by many passes | One recipe from the start (tools/algAures2Level.mjs), re-runnable |

## 3. The layout (first sketch — to argue over)

World metres, north up (-Z), the same orientation as the old map so the French look "up" at the massif.

```
 N  ┌───────────────────────────────────────────────┐
    │  MASSIF (scenery, skyline)        cedar ridge  │
    │    ┌───────┐                                   │
    │    │ FLN   │  maquis camp + CAVE    lookout ▲  │
    │    │ start │      ╲ gully W   gully E ╱        │
    │    └───────┘       ╲                 ╱         │
    │  DECHRA (stone)     ╲   KSAR / TOWN  ╱  shepherd│
    │  koubba, cemetery    ╲ (whitewashed) ╱   farm  │
    │ ═══ wadi ═══ford═══════╲═══════════╱═══ford═══ │
    │     farm (brown)   OASIS (white)    hamlet     │
    │                 ─── piste ───                  │
    │           MOTOR POOL    POST    HELIPAD        │
    │                    French start                │
 S  └───────────────────────────────────────────────┘
```

- **French base (south)**: the post, the new motor pool (Blender, done), the new helipad (done), towers / nests.
  The helicopters' map edge is behind it.
- **The valley (middle)**: one WADI across it with 3 fords; the OASIS (whitewashed houses, palms, the well);
  a HAMLET and FARMS of brown houses (the farmers' and shepherds' homes you liked); the piste between them.
- **The town (middle-north)**: a whitewashed KSAR/town on a low knoll — the big contested place, its souk as
  the point; streets that make fights (CoH's town maps).
- **The mountain foot (north-west)**: the DECHRA in stone, its koubba and cemetery; terraces.
- **The massif (north)**: the FLN start — the maquis camp and the CAVE, two GULLIES down to the valley
  (the raiding routes), a lookout on a spur. Above it, the cedar ridge as skyline only.
- **Points**: ~9 objectives + ~10 supply, balanced by distance (not mirrored): one home point each, near points
  each side, the rest in a belt — measured with a plan view tool before building.

## 4. Buildings — the Blender list (each in the BUILDINGS LAB first, beside the old one)

Every piece: LOD near / far (+ shadow on the matching level), one shared atlas per kit, instanced where
repeated, damage states (intact / damaged / ruin) built in.

**Done**: motor pool · helipad (painted H, sim bags, limed stones) · whitewashed house kit (4 types).

**French**
1. The POST, rebuilt (the walls, gate chicane, towers, barracks) — the biggest piece; the old one stays in the lab.
2. Watchtower (mirador), MG nest, sandbag positions, barbed wire — the sapper-built set.

**Villages**
3. Whitewashed kit, more types: a mosque/marabout, a café with terrace, a well house, garden walls.
4. Stone kit for the DECHRA (same modules, stone and earth looks, flat roofs, terraces).
5. Your brown houses — kept as they are for farms and shepherds; maybe a second and third variant.

**FLN**
6. The CAVE mouth and the maquis CAMP (tents, lean-tos, cooking fire, ammo under tarps) — in Blender.
7. Arms cache, refuge, sangar, ambush screen, field hospital — the FLN's buildables.

**Props**: fuel point (drums, jerrycans, pallets), market stalls, carts, a broken truck, wells.

## 5. The order (area by area — you play and judge early)

1. **This plan** — your changes.
1b. **The new building lab** (section 7) — the catalogue every new piece is judged in.
2. **The ground**: the level tool, the layout, the wadi, the pistes; calm paint; a plan image with distances
   measured. You look at it empty, at the play zoom.
3. **The French base** placed (post as it is for now, motor pool, helipad) → you play the first minutes.
4. **The valley**: oasis, hamlet, farms (brown houses), supply points.
5. **The town**: whitewashed, instanced; its point.
6. **The FLN side**: camp + cave (Blender), gullies, dechra.
7. **The new post** (Blender), replacing the old one in THIS map only.
8. **Building damage** on the new map's houses (the states exist).
9. **AI routes**, balance, then the menu card — the old Aurès stays selectable.

## 6. Decided (2026-10-19)

- **A NEW VALLEY: the Oued Abdi** (a real Aurès valley, south of Arris — terraced villages of stone, the river
  green in its bed, the djebel steep on both sides; FLN country from November 1954). A new map, a new name: no
  confusion with the old Tighanimine. Map id `abdi`, name "Aurès — Oued Abdi".
- **The town: an ALGERIAN town** — whitewashed houses packed up a knoll, its mosque and minaret on top, the souk
  square at its foot (the point), narrow lanes, the café, the well. (The colonial village: another map.)
- **Size: closer to CoH 3** — a PLAYABLE box of ~500 m (the old one 610 m); the starts ~400 m apart; denser,
  every place nearer the next. The terrain outside stays as scenery.
- **Night variant: later.**

## 7. The BUILDINGS LAB, rebuilt (planned with the map)

You: "a better-looking building lab, readable, UI/UX friendly … one for the whole game, or one per map?"

**ONE lab for the whole game** — buildings are shared between maps (the motor pool, the helipad, the house kit
serve the Aurès, the coast, El Kantara), so one catalogue with FILTERS beats a lab per map. The OLD lab stays
(`building-lab.html`, every entry as today) — the new one is a new page (`lab.html`), nothing deleted.

- **A catalogue, not a wall of buttons**: a left panel with SEARCH and FILTERS — by side (French / FLN / civil),
  by kind (base, defence, village, FLN camp, props, nature), by map (Aurès, Oued Abdi, coast, El Kantara) and by
  status (in the game / new, waiting for your verdict / old version kept). Each entry a THUMBNAIL card.
- **One piece, its versions side by side**: old / new / states (intact · damaged · ruin) as tabs or a row, the
  camera framing the piece itself.
- **Views**: the RTS camera (the game's zoom, 3/4), close-up, orbit; time of day; fog of war off/on; the
  ground under it (the map's own paint).
- **Facts on screen**: triangles near / far, draws, texture size, LOD distance, a SHADOW-LOD check, the GPU ms
  (when the laptop is cool) — the numbers I paste in chat today, visible to you.
- **Construction and damage players**: the build animation (0-100 %, play), damage states, collapse.
- **A village / layout mode**: drop a set of pieces as on the map (the village test from today, cleaned up).
- The game's own look (tokens, the HUD's fonts) — readable, dark, roomy; keyboard shortcuts (←/→ next piece).

Order: the new lab comes FIRST, before the map's buildings — every Oued Abdi piece is judged in it.
