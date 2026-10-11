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
