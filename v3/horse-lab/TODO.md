# Horse lab — what next

The backlog for the horse riding system. Answer "what's next" from this file and
keep it updated the same turn something is agreed, done or dropped.

Order = suggested priority. ★ = my top picks.

## ▶ IN PROGRESS (paused 2026-10-07): the rear, matched to screenshots

- References: `refs/rear1..rear4.png` (the reference game's rear, horse's left
  side) and `refs/rearLeg.png` (the user's crop of "a part of the LEFT LEG going
  inside" — the user's pointer: a thin POINTED piece of skin at the inner
  thigh / stifle, under the belly behind the hind leg (by the hip-strap ring),
  that stretches and pokes BETWEEN the hind legs when the hind legs fold under
  in the rear; visible in the rearcmp hind-leg close-ups. Likely skin weights
  there (flank/sheath vertices pulled by the thigh bone) — check the weights
  of that patch and its neighbours). Compare script:
  ours beside each ref at the same moment, camera in the horse's frame, the
  horse's left side turned to the sun (scratchpad `rearcmp.js`; worth turning
  into `refCompare.js` → `compareRear`).
- Best match so far (not yet the defaults): rearAngle 1.0, rearNeck 0,
  rearArch 0.45, rearHeadFlex 0.7, rearReach 1.8, rearKnee 1.3 — neck upright
  with the poll highest, face near vertical, forelegs folded (forearm ~level,
  cannon hanging) like rear3 / rear4.
- Still different: rear1 — the reference lifts the LEFT foreleg high and the
  head first while the body is barely up (ours: still standing at 0.45 s);
  rear2 — ours rises faster (50° at 0.7 s vs ~35°).
- Then the rider during the rear (the user: horse first, robot after).
- Uncommitted with it: the tail rope (tailSway rewrite + ground), ears up
  while moving (calmEars), rearArch / rearReach / rearKnee tunables + sliders.

## ▶ Legs on steps (foot placement) — 2026-10-08

- DONE: swinging hooves look ahead (stepLook) and commit to landing ON higher
  ground (landShift, held through stance); lift eases in (walking only); front
  probes look ahead so the forehand rises with the front feet; leg bends locked
  to the side plane, knees / stifles fold forward only; the front hoof turns
  with the cannon. Tests: scratchpad climb.js / side.js (ramp side x = 3, 50 cm).
- DONE: hooves lie on slopes (the cannon-turn now only while a hoof is lifted;
  per-hoof slope tilt for a hoof on a different slope than the body).
- DONE (procedural): hills — head lower uphill / higher downhill (hillHead),
  slower up −15 % / down −10 %, rider leans into the hill (RP.hillLean).
  FIXED: every 12° slope counted as a jumpable BANK (auto-jump hopped up hills);
  a bank is now an edge (> stepOver within 25 cm).
- [ ] Real climb / descend STRIDES (shorter, hind legs under downhill) — needs clips or IK stride work.
- [ ] Steps 0.6–0.75 m: a small hop, not a climb.
- [ ] Turning pivots on the front feet + a little sideways slide (RDR2).

## ▶ The pose editor (J) — poseEditor.js

- Step 1 DONE: click a joint (dots: horse orange, rider blue, keyed yellow),
  rotate gizmo, auto-key at the current time; keys are a layer of rotation
  offsets over the animation (eased, fading to none at the clip's ends);
  compact 172 px strip (foldable); timeline rows per keyed joint, drag
  diamonds; ref overlay + fit; 💾 → anims/poses.json, played by the game.
  Clip: the rear (R) only so far.
- [ ] Step 2: IK handles (drag a hoof / hand / foot, the leg follows; hooves
      stay planted when the body is posed), mirror left ↔ right, onion skin,
      copy / paste a pose, more clips (gaits, jump, mount).

## 0. The armoured horse (`?horse=armored`)

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

- The armoured horse is the lab's DEFAULT (2026-10-07); `?horse=lowpoly` or the
  panel switch for the Quaternius one.

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
