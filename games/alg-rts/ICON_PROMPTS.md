# The HUD's icons — prompts for an image generator (2026-10-20)

The command card's (bottom right) ability and build icons, to replace the game-icons.net silhouettes
(`public/textures/ui/icons/*.svg`). One image per icon, PNG with transparency, 1024 × 1024. Masters go in
`assets-src/ui/icons/<name>.png` (the names below = the game's keys); a packer then trims, centres and packs them
into one 1024 atlas of 128 px cells (WebP) + its index.

Kept as SVG (tiny flat symbols, sharper as vectors): `vet1-3` and the alert feed's `alertAttack`, `alertSeen`,
`alertCut`, `alertFlag`, `alertMine`.

## ONE PROMPT (ChatGPT) — paste as is, change only the Subject

> Match the style of the attached icon exactly: same painted rendering, palette, lighting and framing. Game UI
> ability icon for a real-time strategy game set in the Algerian War (1956–1960), painted in the style of
> Company of Heroes 3 ability icons. One single subject, centred, filling about 80 % of a square frame, three-quarter
> view from slightly above. Hand-painted digital illustration, crisp edges, strong readable silhouette, high value
> contrast, soft light from the top left, a thin warm rim light on the subject's edges so it stands out on a dark
> background. Muted earthy palette (olive drab, khaki, sand, rust, warm grey, weathered
> metal) with at most one restrained accent colour. Period-accurate 1950s equipment. No text, no letters, no numbers,
> no flags, no insignia, no border, no frame, no scenery, no ground shadow. Transparent background. Must stay
> readable at 48 pixels. Square 1024×1024. Subject: <the subject line from the list>.

The STYLE REFERENCE is `assets-src/ui/icons/grenade.png` (2026-10-20, the first one made — kept): attach it to every
request. (The rim light added after it: olive on the dark HUD lost contrast at 48 px.)

## MIDJOURNEY

> painted game ability icon, Company of Heroes 3 style, Algerian War 1950s, <the subject line>, single centred
> subject, three-quarter view, crisp silhouette, high contrast, muted olive khaki sand palette, soft top-left light,
> plain flat dark grey background --ar 1:1 --style raw --no text, letters, border, frame, flag, scenery

After the first good one: add `--sref <its image URL>` to every other. No transparency in Midjourney: the packer
removes the flat background. (Commercial use needs a paid plan.)

## How to run it

1. Paste the STYLE block, then ONE subject line. One icon per request.
2. Do the first four (grenade, sandbags, radio, mirador). Pick the best one as the STYLE REFERENCE.
3. For every other icon, attach that reference and add: *"Match the style, palette, lighting and framing of the
   attached icon exactly."*
4. Judge each at its real size (about 50 px) before keeping it. Too much detail turns to mush at that size.
5. Save as `<name>.png` (the name in the list).

## STYLE (paste first, every time)

> Game UI ability icon for a real-time strategy game set in the Algerian War, 1956–1960, in the painted style of
> Company of Heroes 3 ability icons. A single subject, centred, filling about 80 % of a square frame, seen at a
> three-quarter angle from slightly above. Hand-painted digital illustration with crisp edges and a strong, readable
> silhouette, high value contrast, soft key light from the top left. Muted earthy palette (olive drab, khaki, sand,
> rust, warm grey, weathered metal) with at most one restrained accent colour. Period-accurate 1950s French army or
> Algerian FLN equipment. No text, no letters, no numbers, no flags, no insignia, no border, no frame, no scenery,
> no ground shadow. Transparent background. It must stay readable at 48 pixels. Square, 1024 × 1024.

Then: **"Subject: …"**

## ORDERS (11)

| name | Subject |
|---|---|
| attackMove | a 1950s bolt-action rifle pointing forward and to the right, a bold forward-pointing chevron arrow painted behind it |
| stop | a soldier's raised open hand in a worn leather glove, palm out, the halt gesture |
| patrol | a pair of dusty army boots on a curved dirt path that loops back on itself |
| retreat | a single soldier in a 1950s French helmet sprinting away to the left, back half-turned, rifle in one hand |
| focus | a rifle scope's crosshair reticle, seen through the round lens, over a blurred target |
| garrison | a small flat-roofed North African earth house, a rifle barrel poking out of its small window |
| unload | a dark doorway of an earth house, a soldier stepping out of it toward the viewer |
| aimArc | a machine gun on a low tripod, a wide fan-shaped arc of light spreading in front of its muzzle |
| transport | a 1950s French army truck with a canvas-covered back, three-quarter front view |
| capture | a short wooden flagpole being driven into dusty ground, its plain cloth pennant unfurling (no symbol on it) |
| holdFire | a fighter crouched hidden in dry scrub, rifle held low, one finger raised to his lips |

## SQUAD ABILITIES (12)

| name | Subject |
|---|---|
| grenade | a 1950s French defensive hand grenade (F1 type), its pin and lever, slightly tilted |
| smoke | a smoke grenade canister on the ground releasing a thick plume of white-grey smoke |
| flare | a flare pistol firing upward, a bright white magnesium flare trailing sparks |
| cutWire | a pair of heavy wire cutters snapping a strand of barbed wire, a small spark at the cut |
| lmg | a 1950s French light machine gun (FM 24/29) on its bipod, magazine on top |
| bazooka | a 1950s anti-tank rocket-launcher tube on a soldier's shoulder rest, its rocket loaded in the back |
| flamethrower | the nozzle of a portable flamethrower spitting a jet of orange flame |
| sniper | a long scoped rifle lying on a folded cloth, the scope catching the light |
| reinforce | a stack of three olive army helmets, a fourth being set on top |
| repair | an adjustable spanner and a hammer crossed over a dented metal plate |
| radio | a 1950s backpack field radio with its tall whip antenna and a telephone-style handset |
| sweepMines | a mine detector, its round search head held low over sand, a buried mine faintly outlined below |

## RADIO AND SUPPORT (6)

| name | Subject |
|---|---|
| radioBarrage | a line of three artillery shell bursts erupting from the ground, dirt and smoke |
| radioAir | a 1950s single-engine propeller ground-attack plane diving steeply, three-quarter view |
| mortarBarrage | a mortar tube on its baseplate firing, a shell leaving the muzzle with a puff of smoke |
| paradrop | a tandem-rotor 1950s transport helicopter (H-21 "flying banana") in flight |
| napalm | a tumbling finned napalm canister above a wall of orange fire |
| tier | a French army officer's kepi with gold braid on its peak |

## FRENCH CONSTRUCTION (14)

| name | Subject |
|---|---|
| sandbags | a curved low wall of stacked sandbags |
| wire | a coil of barbed wire strung between two wooden posts |
| mgNest | a machine gun poking out over a ring of sandbags |
| mortarPit | a mortar in a round dug pit ringed with sandbags |
| mirador | a tall wooden watchtower on stilts with a small roofed lookout |
| searchlight | a large military searchlight on a stand, its bright beam cutting forward |
| forwardPost | a small canvas army tent with a radio antenna beside it |
| aidStation | a canvas stretcher with a folded blanket and a medical satchel on it |
| fortPoint | a low fortified position of dry-stone walls topped with sandbags |
| helipad | a round dirt landing pad, its edge ringed with whitewashed stones |
| motorPool | a corrugated-iron vehicle shed on steel posts, a jeep's nose in the open bay |
| barracks | a long whitewashed barrack hut with a flat roof and small windows |
| supplyDepot | stacked wooden ammunition crates and fuel drums under a tarp |
| cancelSite | a shovel and a pickaxe with a bold red diagonal slash across them |

## FLN (10)

| name | Subject |
|---|---|
| ambushScreen | a screen of cut brush and branches woven between wooden stakes |
| sangar | a low curved breastwork of piled dry stones |
| flnMine | an anti-personnel mine half-buried in sand, its pressure plate visible |
| flnWire | a tripwire stretched low between two stakes, a grenade tied to one of them |
| flnDetonate | a wooden plunger detonator box, its two wires trailing away |
| flnCut | a wooden telephone pole, its wires snapped and dangling with a small spark |
| armsCache | a wooden crate of rifles half-hidden under a sacking cloth and stones |
| refuge | a rough mountain shelter of piled stones roofed with branches |
| infirmary | a lantern and a roll of bandages at the mouth of a dark cave |
| recruit | a village man's hooded burnous cloak and an old hunting rifle leaning against a stone wall |

## RESOURCES (3) — the top bar

| name | Subject |
|---|---|
| resManpower | three olive army helmets side by side |
| resMunitions | an open wooden ammunition box full of brass cartridges |
| resFuel | a dented olive-drab jerrycan |

**Total: 56 icons.** Some are for features that don't exist yet (napalm, barracks, supplyDepot, recruit,
sweepMines, holdFire, capture): they're cheap to make now in the same style, and they wait in the atlas.
