# Aïn Abdi, the oasis — new pieces from the oases

2026-10-30 (you: "ok lets continue", after the farms). Every piece is new and built from references (see memory: new
assets, never remakes). The houses are the whitewashed kit's (AURES2_PLAN: "whitewashed for the town and oases"); the
oasis's own pieces are new, in the mechta kit (tools/blender/mechta.py).

## What an oasis spring is (references)

- The water comes up at a SPRING (aïn) and is held in a pool walled in stone, often under a head wall where it
  emerges. It leaves through a DISTRIBUTOR: the *kesria*, a comb-shaped stone. Each notch's width sets a garden's
  share, and each notch feeds a SEGUIA, a small channel running to the gardens. Distributing the water is the oasis's
  law (the foggara and seguia system of the Algerian oases: Touat, Gourara, the Ziban).
- The gardens under the palms are fenced with DJERID: dried palm fronds stuck upright close together on a low wall
  of puddled earth (*tabia*), lashed to rails. The grove is three storeys: palms, fruit trees, crops.

## The pieces

- [x] **`ain`, the spring.**
  - The water comes from a dark, wet niche in a rubble head wall, framed by a whitewashed round-headed arch, with a
    stone spout.
  - The pool is irregular, walled stone by stone, with steps down into it and reeds in its corners.
  - The KESRIA stands in its front opening, notched three times, and three SEGUIAS fan out from it, kerbed with stones
    and pointed toward the gardens.
  - Flagstones lie where the women draw water.
  - Damaged: the head wall and the pool's wall are breached. Ruin: the head wall's stump, the pool wall half down, the
    water gone to mud.
- [x] **`djerid`, a garden fence.** A 4 m module laid end to end: a low eroded mud wall, and the fronds close as a
  screen, each with its own height and lean and its leaflets at the tip. It is SOFT cover (`MECHTA_SOFT`: fronds stop
  nothing) but still blocks movement. Damaged: a gap, with fronds broken and leaning out. Ruin: the fronds on the
  ground.

## Placed (maps/abdi.js; villageKit `garden()`)

- **The houses:** two short rows between the piste and the oued, fronts to the piste and about 9 m from it. The point
  is on the piste between them.
- **The spring:** south of the piste, its seguias running south down the lane between two GARDENS (5 × 3 modules
  each, a gate on the north). The grove's painted palms stand in and around them.
- **Plants:** the game now clears the painted vegetation off every town piece's footprint (algGame). Before, a palm
  could grow through a roof at the grove's edge.

## What the lab taught

- The first spring, plastered boxes round a flat rectangle of water, read cheap. It was redone in stone with the
  kesria.
- The seguias' water strips sat proud of their kerbs and read as planks. The water now sits low between bigger kerbs.
- The jars baked blotched at that size, so the spring has none.
- Bare ribs 7 cm apart read as rebar. The fronds are now 4–5 cm apart with their tips. The mud wall baked pale as a
  plank and is darker now.
- The fence costs 3.3k triangles a module, about 100k for the two gardens up close, all instanced. Its far level keeps
  nearly everything: decimating its thin rods folded them.
