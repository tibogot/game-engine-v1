# Horse lab — what next

The backlog for the horse riding system. Answer "what's next" from this file and
keep it updated the same turn something is agreed, done or dropped.

Order = suggested priority. ★ = my top picks.

## 0. The armoured horse (`?horse=armored`)

- [ ] ★ **Decide whether the armoured horse becomes the default** (the panel's
      "horse (reloads)" switch picks it today).
- [ ] **Get-on for the taller horse**: the mount was keyed on the 1.75 m horse;
      on the 2.02 m one the pushing foot floats ~0.30 m.
- [ ] **Rider foot angles** at the gallop and in the jump (checkRiding flags).
- [ ] **Canter graze at fence 5b** (−0.01 m on the course ride).
- [ ] **The model's licence**: check it before it ships in a game.
- [ ] **Tail feel**: you judge the gallop wiggle (sliders "tail: …" in
      "Body on the ground").
- [ ] Re-run the yard jumpCheck with the new gears (it was cut short).

## 1. Fix what we know is rough (small, existing systems)

- [ ] **Bounce (2 fences 3.5 m apart)**: clears, but the hooves graze the second
      rail and the legs snap going from landing straight into the next run-up
      (~390° blend). Needs a proper landing→take-off pose, or a rule that a
      bounce must be at least ~5 m.
- [ ] **Ground pole (0.25 m)**: stepped over, but the hooves pass through it.
      Lift the hoof over it with the hoof IK.
- [ ] **Get-on**: the push-off jolt (~0.95 s), the left ankle twisting in the
      iron (~58°), small knee jolts.
- [ ] **Idle rider**: the foot-angle flag (32°) from checkRiding.
- [ ] **Hoof slide in the walk**: the audit measures 4.8 cm/frame at 1.75 m.

## 2. Herding gameplay (the farm we just built)

- [ ] ★ **You ride it and tune it.** Flight zone, bunching, speeds: the sliders
      are in "Herd (farm)". Your feel decides the defaults.
- [ ] **Real stockmanship**: a blind spot behind the sheep, and the "point of
      balance" at the shoulder (press behind it and they go forward, ahead of it
      and they turn back). This is what makes driving a herd feel like a skill.
- [ ] **A leader and followers**: a few bold sheep lead, the rest follow;
      lambs stick to their mothers.
- [ ] **Gate jams**: sheep crowd and push at the gate, one squeezes through and
      the rest follow.
- [ ] **A herding challenge**: "pen all 24", with a timer and best time.
      Sheep that break away and have to be gathered again.
- [ ] **The horse and the sheep touch**: today the sheep are pushed out of the
      horse's body. The horse should slow or step around a sheep it walks into.
- [ ] **A sheepdog** (later): an AI dog that works the herd from the other side.

## 3. Horse feel

- [ ] **Camera**: a little more FOV at the gallop, a small shake on landing,
      look-ahead in turns.
- [ ] **Stamina**: the gallop tires the horse, it slows and blows; rest
      recovers.
- [ ] **Turning**: tighter turns at the walk, wider at the gallop, sliding a
      little on hard turns at speed.
- [ ] **Spooking**: a horse galloped into a wall or a sudden sheep rush shies,
      rears, or sidesteps.
- [ ] **The rider in the jump**: a stronger 2-point seat over big fences and a
      sit-back on landing (the jump pose exists; it doesn't follow the arc height).
- [ ] **Falls**: a crash at speed throws the rider off (ragdoll-lite: a
      tumble clip + get up).

## 4. Feedback (sound and effects)

- [ ] **Sounds**: hooves per gait and surface, breathing at the gallop, the
      jump effort and landing, sheep bleats (louder when pressed), saddle creak.
- [ ] **Dust** behind the hooves at speed, puffs on landing.
- [ ] **Hoofprints** (decals) on soft ground.

## 5. Out of the lab into real worlds

- [ ] ★ **The horse on real terrain**: today the ground is meshes it raycasts.
      In a v3 world the ground is the heightmap: read height and slope from
      the terrain (a heightmap source next to the raycasts).
- [ ] **A reusable horse module**: horse + rider + tack + controls as one
      engine piece any game or the editor can spawn (like crowdSkinning now).
- [ ] **Slopes, water, mud**: the horse slows uphill, splashes and slows in
      water, slides a little in mud.
- [ ] **Vegetation**: grass bends under the hooves, the horse brushes through
      bushes.

## 6. Bigger features (later)

- [ ] Mount from the right side too.
- [ ] Call / whistle the horse when on foot; lead it by the rope.
- [ ] Several horses: AI riders, a herd of loose horses (the crowd skinning
      can draw them in one draw).
- [ ] Horse speed beyond 1.3×: real horses are ~2× faster still. Going there
      needs a longer stride (stretch the clips or hoof-IK stride), not just faster
      legs.
- [ ] Gamepad controls.
- [ ] Day/night riding with Sky Pro (a lantern at night).

## Tooling

- [ ] Run jumpCheck (rideCourse) and a herd test as part of the test lanes
      (browser-driven, like the CDP tools), so a change that breaks jumping or
      herding fails a suite instead of being found by riding.

## Done (recent)

- Horse switch at the top of the panel: low-poly / armoured (reloads, keeps
  the level; same as `?horse=armored`).
- Gears walk → canter → gallop: the trot made from the walk read wrong (no
  suspension, no bounce); `?trot=1` brings it back. A real trot needs a trot
  clip and a posting rider.
- Tail moves at a gait: the stride's jolt and a wave dock → tip, on top of the
  turn/stop spring.
- Armoured horse rigged on the Quaternius skeleton, with a hair-card tail
  (round dock bend, weights blended along the tail).

- Sliding refusal: brakes early (v²/2a) for anything it won't jump, slides
  (~0.8 s from a gallop, gallop slowing under it, body sitting back), stops
  ~1 m short, holds while pushed on, then rears (gallop) or tosses its head
  (canter); zero one-frame stops on parkour, farm and yard.

- Reliable jumps: flight fitted at take-off, parkour course, autopilot check.
- Farm + herd, Sky Pro, 1.3× speed, perf pass (draws 101→30 / 124→29 / ~102→37,
  farm gallop CPU 16 → 1.9 ms), crowd skinning moved into the engine.
