# Turnin' Turbo Dashboard (Tomy, 1983) — a three.js / WebGPU recreation

A page of its own: `games/turnin-turbo/index.html`. It imports only `three` (and `three/tsl`,
`three/addons`); no other file in the repo is changed or imported.

## What the real toy is (from photos, the box back and the manual diagram)

- Red body shaped like a Porsche 911 nose at the back (grey round headlight pods, black
  wrap-around bumper, "TURNIN' TURBO DASHBOARD" sticker strip on top). Dark grey front bezel.
- Instrument cluster: no real LEDs. Holes in a printed panel; coloured flaps slide in behind:
  tacho (yellow blocks, 0–8 x1000 r/min), fuel (pink bars, F–E), turbo (pink bar), speed
  (three green 7-segment digits + MPH), a printed odometer "00009", TRIP (two green digits =
  the SCORE), warning icons (door, seat belt, battery), headlight and P icons.
- Screen: a lit road scene behind a frosted, slightly curved panel: orange dashed lane
  lines, a green grid and green pine trees on the sides, a yellow car ahead, the player's
  red car at the bottom (a sticker on a piece of plastic, moved by the wheel).
- Controls: steering wheel (TOMY hub), ignition key (OFF / ON), COUNTER RESET button,
  four-speed shifter N 1 2 3 4 with an orange TURBO ramp beside it.
- Rules (box back): turn the key, the motor revs; the speedometer shows how fast you go,
  the fuel meter how much gas is left, the mileage indicator (TRIP) your score. Run off the
  road and the mileage meter stops for a few seconds as a penalty (the toy clicks and the
  screen flashes). Higher speed scores faster. 4 "D" batteries.
- Unknown (guessed, tune later): the inside mechanism (film loop / drum), the scroll speed
  per gear, how fast the fuel drains, whether the wheel springs back (we assume a direct
  link: no spring), whether the speed digits jump per gear or roll.

## How the front is matched (2026-10-21)

- Refs in `assets-src/refs/turnin-turbo/` (front.png = the photo everything is measured on).
- The front face is built from pixel outlines on that photo (tools/blender/turninTurbo.py, THE FRONT FACE:
  x = (px − 760) × 0.294 mm, y from 0.304 mm/px — heights checked on the bezel photographed face-on).
- The face leans back 28° (a dashboard): the only tilt for which the camera fitted to the photo also puts the
  wheel and console where the 3/4 photo shows them. The photo was taken ~40° above the table.
- Wheel and console placed by rays from that fitted camera. The cluster artwork is drawn in the photo's pixel
  coordinates (instruments.js createCluster), offset for the camera's parallax.
- Check: `index.html?ref` puts the photo over the view at its aspect (O = photo opacity); view 0 is the photo's
  own camera.

## Steps

1. **Playable grey box** — DONE when: key, wheel, shifter, reset work with the mouse and
   the keyboard; the road scrolls per gear; off-road = flash + 3 s counter stop; fuel runs
   out; all gauges move. Body = rounded boxes in flat colours.
2. **Blender shell** — body, bezel, cluster hood, screen frame, gear console, wheel, key:
   soft moulded plastic (tools/blender/turninTurbo.py → public/models/turnin-turbo/*.glb,
   new files only).
3. **Look** — glossy red / satin black plastic, printed markings, the flaps behind real
   cut-outs (depth), frosted curved screen glass, wood table, room light. User judges.
4. **Sound** — Web Audio: toy motor whine per gear, ignition, shifter clunk, off-road click.
5. Later, maybe: battery sag (dimming bulb, slower motor), exploded view.

## Keys (step 1)

Steer: mouse drag on the wheel, or ← → / Q D (AZERTY) / A D.
Shift: drag the lever, or ↑ ↓ / Z S / W S, or 0–4.
Key: click it or Space. Counter reset: click it or R. Camera: right-drag orbit, wheel zoom, C = views.
