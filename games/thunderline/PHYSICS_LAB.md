# Thunderline — the PHYSICS LAB

2026-10-29, user: "a lab with some of the pieces on the ground that I can try … for testing physics … jumps, poles …
fine-tune drifting, air control … like the editor but we start from an empty ground, create basic circuits to debug,
you place some, I can place them manually … most game creators do a lab for this … make it the best."

## What it is

The builder, in a **lab mode** (`builder3.html?lab=physics`, or `physics-lab.html`): the same placing, the same Drive
(Tab), the same three cars (old · stunt · arcade) — but on **flat open ground**, the floor drivable, and with what tuning
needs:

1. **A test ground, ready at the first visit** (yours to change; `Reset lab` rebuilds it):
   acceleration / braking strip · flat pad for drifting and circles · a slalom of poles · a row of ramps (10° → 45°)
   with landings · tilted landings (30° → 75°) · a wall ride · a loop · rollers and crests.
2. **Its own track**, kept apart from your tracks (it never shows in your list).
3. **Telemetry while driving**: speed, lateral g, yaw rate, slip angle, wheels down, air time, the last landing (grade,
   angle, speed kept), take-off guide correction.
4. **Live tuning**: the arcade car's numbers (ARCADE in arcadeCar.js) as sliders that change the car while you drive;
   Copy / Reset; the values you like become the defaults in code.
5. **Zones**: keys to jump to each test area and restart, without driving across the ground.

## The rules that change in the lab

- Build height = the ground (pieces sit on the floor); the floor is drivable ground, not a fall.
- The "under the floor" and "falls to the floor" checks are off.
- The world is "Flat · grid" (the grid reads distance and speed at a glance).

## Steps

1. [x] Lab mode + its own track + the generated test ground (proto/kit/physicsLab.js: start strip, ramps 10–45°,
   loop, rollers / slopes, drift circle of cones, slalom of poles, wall ride — Reset lab rebuilds it).
2. [x] Telemetry overlay (proto/kit/labHud.js).
3. [x] Tuning panel: the arcade car's numbers + the helpers, live, remembered in this browser (Copy / Reset).
4. [x] Zone keys 1–9, 0 while driving (by the key's place: AZERTY's top row and the keypad work unshifted); the Car:
   old · stunt · arcade button (reloads).
5. [x] YOUR DRIVES as red trails in the editor (every builder, not only the lab — driveTrails.js; Apex Rush's editor).
6. [ ] Measured comparisons of the three cars, zone by zone, in this doc.
7. [ ] Wider roads to try with the snappier arcade steering (Apex Rush widened his).
8. [x] More than roads (user, 10-29: "obstacles to debug drift angles … small obstacles on the ground to check the
   wheels react well"): 8 a closed circuit (four 90° turns) · 9 speed bumps (~14 cm, new kit piece `bumps_32`),
   a washboard (~5 cm ripples, `washboard_32`), a hairpin, narrow planks · 0 a 48 m wide drift arena with a cone
   figure-eight · beside the slalom, tyre stacks / barrels / cones / blocks to drive into. A new layout of the lab
   replaces the stored one by itself, unless you Saved changes to it (then Reset lab).
9. [x] No landing banner in the lab (the telemetry's "landing" line says it). Arcade landings land like a car: the
   springs and the bump stop take the hit at each wheel (an impulse at the tyre: rear wheels first → the nose slams
   down onto the front ones), no bounce; not the stunt car's catch (it deleted the fall and gave it back as speed).
10. [x] The loop (user, 10-29: "clearly uncontrollable"). Measured: the car rode the loop on its FRONT wheels, the
   rear 0.65 m off the road — its alignment trailed the road's 1.6 rad/s rotation by ~9° (a catch-up), and the bump
   stop pushed the whole car out by the front wheel's depth. Half the grip: it turned 85° off the road and wedged on
   the rail. Now: the car turns WITH the road (its rotation, from the interpolated track frame) and the alignment
   only corrects the rest; on a road it sits on the road's own up; the bump stop is a stiff spring at each wheel;
   on loops and walls the turn rate is drawn toward the road's direction and its middle (`guide`). Measured: four
   wheels down all the way round, no slide, ≤ 2.5 m off the middle, 204 → 245 km/h; a steer pulse upside down
   crosses the road and the car still exits. Also: the nose follows the arc in the air again (`air.follow` 2, as the
   old car since 10-23), the arcade car's own top speed (318 km/h on the flat, 300 in ~13 s), the car painted yellow.
11. [x] ON THE GROUND (user, 10-29: "ramps I place on the ground, like my old game … collision … debug suspension"):
   the builder's new GROUND tab (obstacles.js GROUND), placeable anywhere —
   - the old game's ramps (modularRoadParkour.js shapes, drive surface and solids split as there): jump ramp
     (6 m, ~23° lip), convex kicker, 20° slope, a 2.6 m side ramp (one side of the car);
   - a rumble kerb (12 cm humps), a 25 cm step;
   - MOVERS on the race clock, any motion now (`mover.pose(t)`, the contact velocity from the pose): pendulum
     across the lane, sliding wall, a low spinning bar (35 cm, the wheels' height).
   Lab zones on Shift + 1 (ground ramps, a jump onto a block), Shift + 2 (suspension: kerbs one side, side ramp,
   step, kerbs left / right), Shift + 3 (movers). Telemetry: each wheel's spring travel, its peak, STOP on the bump
   stop. Checked: all launch / collide (a parked car is shoved by the wall and the pendulum).
