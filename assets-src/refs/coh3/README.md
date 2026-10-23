# Company of Heroes 3 — reference screenshots

Kept 2026-10-11 to compare against (the user: "keep those images, we will need them later to
compare with a new terrain"). From a YouTube match (Achilles Gaming, "Early game setup"), full-screen
player, so each frame is the whole game view (~1330 × 748, 16:9) with the YouTube controls over the
bottom. The player never moves the camera's tilt or zoom in the match: this is CoH 3's DEFAULT view.
Reference only — never shipped, never copied into the game.

| file | what |
|---|---|
| `point-neutral-dashed.png` | a fuel/munitions point not held: the DASHED white ring |
| `point-captured-blue.png` | the same just captured: SOLID blue ring, glowing centre disc, rising streaks |
| `camera-default-1..4.png` | the default camera over desert ground, a point's dashed ring in view |

## The camera, measured from the rings (rough — pixel reads on compressed video frames)

A capture ring is a circle on flat ground. On screen:

- **tilt** — its height / width ≈ sin(the view's angle down to it). Rings near the screen centre
  (`-3`: 377 × 259 px, `-4`: 379 × 264 px) give **0.69 → ≈ 43–44° down** at the centre.
- **lens** — the ring's NEAR half is taller than its FAR half (`-3`: 139 vs 120 px, ≈ 1.16). That
  asymmetry gives its radius / camera distance ≈ 0.1, and with its width on screen a horizontal
  field of view of **≈ 35–48°**, i.e. **≈ 20–28° vertical**: a LONG, flat lens.
- **distance** — from a soldier's height (~22 px for a 1.8 m man), **≈ 90–110 m** to the ground point
  at the centre; the ring's radius then ≈ **10–12 m**.
- **ground seen** across the centre ≈ 75–80 m.

Ours (algGame.js `createRtsCamera`, 2026-10-11): vertical FOV **40°**, distance **65 m** default
(24–85), tilt **53°** at the default (48° in, 56° out); ground seen across the centre ≈ 84 m.
Our capture rings: 22 m (supply) and 40 m (villages).

## Added 2026-10-13

| file | what |
|---|---|
| `camera-default-5-dunes-ruin.png` | the default camera over big dune hills: pale crests, red-orange hollows, a Roman ruin, a point on the dunes (the user's, for map 3) |

MEASURED (the game area, x 22-78 %, y 8-68 %, HUD out): frame 4 mean RGB (202,156,122), luma median
173, saturation 0.39; frame 5 (194,143,109), 167, 0.45. El Kantara's light is tuned to these
(games/alg-rts/maps/kantara.js `light`).
| `camera-default-6-dune-point.png`, `-7-dune-point-2.png` | a point on small dunes: crisp curved crests, shaded lee, soldiers for scale |
| `camera-default-9-sand-mass-red-ground.png` | a raised sand mass with stepped crests (left) falling to flat red pebbly ground (a fuel point, an acacia, a ruined wall, scrub, a jeep) |
| `camera-default-8-red-ground-ridge.png` | red pebbly ground, a sand ridge crossing it, ruins (their shadows bend over the ridge), scrub |

MEASURED against the soldiers (~1.8 m) and the ring (~22 m): CoH's dunes are SMALL — crests ~2-3 m
high, ~10-25 m apart, a short steep lee (~5 m), a long gentle back. El Kantara's: 2.8 m, 20 m.

## Added 2026-10-23 — the sandstone ROCKS (the user: "make better rocks", for the rock lab)

| file | what |
|---|---|
| `rocks-mesa-shelves.png` | a low mesa: one big flat-topped mass in STEPPED shelves, rounded overhanging lips, a deep crack splitting it, the foot in shadow |
| `rocks-cluster-tanks.png` | rocks as CLUSTERS: a lone rounded slab with a tree, a long ridge of leaning slabs, a cliff of stacked blocks (right) |
