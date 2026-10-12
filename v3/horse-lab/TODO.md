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

## ▶ The jump matched to Muybridge — 2026-10-09

- User: "the jump looks off compared to a horse jump, especially the back legs".
  Reference: Muybridge, Animal Locomotion plate 638 ("Daisy" over a hurdle,
  Wikimedia Commons, public domain; frames read on a grid). Measured ours the
  same way (scratchpad jumpmeasure.js / jumpfilm.js): hind hooves were 12–32°
  IN FRONT of the hip all flight (real: 26–38° BEHIND), hocks folded 84–95° early
  (real: ~160° trailing), hind feet landed WITH the forefeet (bucking look), the
  descent dived ~23° too far nose-down.
- DONE (uncommitted): JUMP_HIND keys in horse.js (hip→hoof line, reach, cannon
  angle; u = hind lift-off … forefeet land) placed by the hind IK once each hoof
  has LEFT the ground; fold over the fence tied to where the hoof is vs the rail
  (+ never lower than rail + 10 cm); hand-off to the clip: over the spot first,
  then down; descent kept near level (jumpPitchFix, done as the forefeet land)
  with the lifted forelegs keeping the clip's reach down. HP.jumpHind / jumpPitch
  (0 = the clip's). Course clearance ≥ the clip's at every fence (1.2 m: 14 cm,
  1.4 m: 12 cm); motion audit 15/15 both horses.
- DONE: take-off gather — the clip squatted the hips to 0.77 of the hind leg (Daisy
  0.92 → 0.83); the body is held up (HP.jumpGather 0.9, limited to what the planted
  hind legs can still reach: they are near straight), planted hooves stay on the
  ground (the "never under" fix now counts the raise). Body pitch at lift-off
  measured equal to Daisy's (+20°): the rearing look is the raised neck.
- DONE: the tail is carried out level behind from the gather to the landing
  (HP.jumpTailLift, the rear's tail-lift reused) — it hung limp.
- DONE: both hind feet plant together at take-off (HP.jumpPlant 0.42 m: the right
  hind's landing spot moved forward through its last swing, held while planted,
  handed to the flight pose as it leaves): −30/−31° at the plant (Daisy ~−25°).
  (Kept through the flight it popped 20 cm at the jump's end — the audit caught it.)
- DONE: landing — one foreleg straight reaching for the ground, the other held
  folded (knee ~96°) and unfolding just before its own touch-down (HP.jumpForeSplit).
  TRIED and dropped: planting the forefeet apart (scissor): the clip's landing
  SKATES ~3 m/s forward, so a held hoof folded the knee 58° under weight. A real
  scissor needs the horse to slow on landing (root motion) — next step if wanted.
- Neck: Daisy keeps her head fairly high over this hurdle (no deep bascule) —
  ours matches the reference; a show-jumper bascule is a separate choice.
- [ ] Muybridge's other plates (636, 641, 644: Pandora, other heights) to check
  higher fences.

## ▶ Walk + gallop vs Muybridge — 2026-10-09 (measured, not fixed yet)

Refs: plate 574 (Hansel walking, free), plate 626 (Annie G. galloping) — Commons.
Ours measured with scratchpad gaitfilm.js + gaitstats.js (footfalls, duty, angles).
- WALK: footfall order right (lateral 4-beat) but uneven: LH→LF 0.15, LF→RH 0.37,
  RH→RF 0.19, RF→LH 0.29 (real ~0.25 each); duty 0.52–0.56 (real ~0.6–0.65):
  2 feet down 85 %, 3 feet 15 % (real ~half/half); stride 1.15 m in 0.9 s (real
  ~1.6–1.8 m, ~1.1 s); head nod 4 cm (real ~8–12 cm).
- GALLOP: transverse 4-beat, left lead, 26 % suspension — correct. But 0.45 s
  strides (racing rhythm) at 5.65 m/s = 2.5 m strides (real at that speed ~3+ m,
  ~0.55 s: legs too busy); body rocks 15° nose up/down and bobs 23 cm (real ~±5°,
  ~10–15 cm: a rocking horse); head carried high, neck upright (real: neck
  stretched forward-low); forelegs reach to +35° (Annie G ~+45–50°).

- GALLOP DONE (uncommitted): body rock eased toward its running mean
  (HP.gallopCalm 0.55, hooves kept by IK: pitch range 15.5° → 9.5°, hip bob
  23 → 17 cm); neck stretched forward-down (HP.gallopNeck 0.32 rad); slower legs
  (HP.gallopRate 0.85: stride 0.45 → 0.52 s, 2.5 → 2.9 m) with planted hooves
  LOCKED until they lift (released over 0.12 s; back to rate 1 when a jump is
  queued). Gait blends now wait up to one whole stride (a slow canter timed out
  into a 180° canter→walk blend). Audit 15/15 both horses; course clearance ≥ before.
- [ ] Gallop forelegs reach only +36° (Annie G. ~+45–50°).
- WALK (uncommitted): head nod through each fore stance (HP.walkNod 0.12: 4 → 7 cm).
  TRIED and dropped: (a) re-timing the legs' keys for even beats — the body's bob
  is timed to the original footfalls, shifted legs hovered / dragged (hind stance
  52 → 36 %); (b) slower walk legs with locked hooves — the forelegs cannot sweep
  further back, fore stance 56 → 31 %. Both need a re-keyed walk clip.
- TRANSITIONS (uncommitted): into a jump the leg pace went 1.11 → 1.35 (queued) →
  1.7 (run-up) → 0.67 (air) in single frames; now the run-up eases from the
  gallop's pace up (same run-up time: the planner counts on it) and the air pace
  eases in over 0.1 s of clip (same air time). Scratchpad approach.js logs it.
- GEAR CHANGES measured (scratchpad gears.js, uneven frames): pose gap of each
  crossfade — Idle→Walk 200°, Walk→Canter 99°, Canter→Gallop 15°, Gallop→Canter 0°,
  Canter→Walk 84°, Walk→Idle 117°. The walk ones are the visible snaps (start, stop,
  walk↔canter): the clips have no pose in common there; needs transition strides
  (a first step from standing, a canter depart, a last step into the halt).
  (My hoof "pop" metric is not usable at a gallop: a hoof swinging at 11 m/s.)
- START / STOP (uncommitted): planted hooves are held where they stand for 0.9 s
  after Idle↔Walk (HP.startLock) and released as the walk lifts them; a held hoof
  that falls 12 cm behind STEPS to catch up (held 1 m the body sank, nose dived);
  standing with holds left, each hoof steps (lifts 7 cm) into place one at a time
  (eased along the ground it skated). No holds in rears / jumps / turns on the spot.
  Planted slides (scratchpad startstop.js): start 206 → 25 cm, stop 162 → 78 cm, stand 0.
- DONE: the stop's last step holds planted hooves (stop slides 83 → 54 cm; the
  rest is toe roll-off my rough metric counts).
- DONE: walk ↔ canter — the speed ran ahead of the gait (walk legs skated at
  3 m/s for ~0.6 s waiting for the hand-over). Now (HP.departFirst): the walk speeds
  up only to what it can step (1.86 m/s), departs into the canter, THEN gathers
  speed; down, the canter slows to its slowest step, hands to the walk at ~2.3 m/s
  (canter min 0.5×, walk max 1.8×), and the walk never flips back up while slowing.
- DONE: walk ↔ canter blend 0.38 s with planted hooves held through it (slides
  in the change 25 → 13 cm). Measured the footfalls inside the clips (scratchpad
  clipfeet.js): the canter = the gallop clip slowed; beats RH 0.44 → LH 0.66 →
  RF 0.81 → LF 0 (left lead). A footfall-matched pairing (the same hind landing)
  is a 310° pose gap; the chosen one (walk 0.5 → canter 0.01: left fore planted /
  landing) is 83° and already footfall-consistent. A real departure stride would
  need its own keyed transition. Landing → gallop: 8° hand-over (fine).
- DONE (user: "the stopping is a bit weird"): filmed stops from a walk and a gallop.
  The walk stopped dead (5 m/s², 0.3 s, mid-stride) then finished its step
  standing; the halt waited a whole stride ×1.8 (marched on the spot up to 2 s).
  Now: a walk halts at 1.7 m/s² (~0.8 s, HP.walkHalt); the stand blend (0.5 s,
  hooves held) starts when stopped if the stride is at an acceptable moment
  (≤170°, ~¾ of it, HP.haltMaxDeg), else within ~0.3 s; the feet square up by a
  step. From a gallop the canter hands to the walk after ~0.35 s at its slowest
  (was 0.75 s: it coasted). Tried and dropped: holding a slow last step until the
  stride's one best moment (110°) — up to 2 s of crawling.
- DONE: EVEN WALK (HP.walkEven): each hoof follows the walk clip's own ground path
  (recorded once, walkPaths(): 64 a stride, ground frame + hind cannon direction),
  sampled ahead by its leg's shift (walkEvenShift LF 0, RF .073, LH .115, RH .125),
  placed by IK in the ground frame. Beats LF 0 → RH .22 → RF .48 → LH .72 (clip:
  0 / .37 / .57 / .87); 3 feet down 9 → 22 % of the stride. Only in a real walk
  (walk gear, 0.6 s steady); before a canter departure it returns to the clip's
  timing inside the walk (kept through the blend, a swinging hoof's 40 cm shift
  popped). Shifted hooves never below the ground.
- DONE: CANTER DEPARTURE (HP.canterDepart): the canter starts on its first beat (the
  trailing right hind landing, clip 0.44) as the walk lands that same hind (walk
  0.70–0.79); each leg stays on its WALK path (walkPaths('Walk'), lift blended too)
  until its own canter beat (departBeat: RH 0, LH .22, RF .375, LF .56), joining over
  0.12 s; planted hooves held 0.7 s. The body blends in 0.18 s — logged as a
  body-only pose gap (66°; the legs' 312° clip gap is never shown, they are on IK).
  Slides in the change 13 → 27 cm (the horse speeds up meanwhile). A held hoof that
  starts lifting is released, never "caught up" (it got 1.2 m away, snapped 44 cm).
- DONE: turning on the spot = on the haunches (HP.spinPivot: pivots 0.8 × half
  the body behind the middle, only with no forward input); planted hooves held,
  a hoof left 12 cm behind steps (7 cm lift, only when it starts from the ground).
  150° turn (scratchpad spin.js): hoof slides 0.8–1.5 m → 10–30 cm, steps per leg
  2–3 → 4–5. A turn starting no longer lets go of held hooves (they slid 7 cm a
  frame walking off while turning) — they stay until the walk lifts them.

## ▶ The tail (horse.js tailSway) — 2026-10-09

- User: "too stiff, not only in the jump — smoother, more realistic". Measured: the
  whole tail swung like a stick hinged at the croup every gallop stride (tip
  −0.67 → +0.11 m about the dock), heavy fixed damping (6 %/step) killed any follow-through.
- DONE (uncommitted): dock (first point) carried by the clip, the HAIR keeps only
  8 % of that pull (HP.tailHair); air drag ∝ speed² (HP.tailAir 0.5: streams ~25°
  below level at a gallop, hangs at a walk); light linear damping (0.009) so it
  settles stopping; soft bending stiffness (HP.tailSmooth) — waves, no hooks; hair
  bends 1.5× the dock; collides with the buttocks + hind legs (it hung through them
  and swung under the belly stopping); the jump lift firms the dock, not the hair.
- [ ] The tail still LOOKS like a dark rope (14 cards seen edge-on from the side):
  fuller, fanning hair cards (more spread low down, lighter tips, a little lateral
  sway per card) would read softer.
- [ ] Jump: over the top the lifted dock + falling hair still arcs a little (Muybridge: level).

## ▶ Y BOT as the rider (?rider=ybot, ybot.js) — 2026-10-11

- Mixamo's Y Bot (refs/Y Bot.fbx, else the mesh in refs/Shooting Arrow.fbx — this machine
  only) as a second rider; the robot stays the default (GUI "rider (reloads)").
  Its bones RENAMED to the robot's (UE) names → rider / mount / stirrups / reins / hat /
  editors work unchanged. The robot's clips (sit, idle, walk, jog) retargeted onto it
  (retarget.js both ways: a UE-named source via ref.ue; pelvis from the REST, so the sitting
  clip sits). Bow base baked per rider (anims/bow-shot-mocap-ybot.json).
- Fixed on the way: the FBX gives each mesh its own partial skeleton (→ one skeleton of
  every bone) and repeats each bone as a childless same-named copy (→ removed; restOf
  keeps the first) — the shins / arms were 108–162° off until then; fingertip bones
  aimed by their own segment (the robot's leaf ends bent every tip ~90° back).
- Measured: Y Bot idle / walk / sit = the robot's within 0° per bone; full draw on Y Bot:
  draw elbow 2.3 cm under the line, bow elbow 173°, abduction 96°, level, neck 76°,
  anchor 7.2 cm; gold 10–60 m; fetch checks clean.
- The bow (both riders): the clip's fingers sit BEHIND our string while nocking (it starts
  drawing) → the string follows them; only the sideways gap closed, half per hand; the
  aim correction follows the clip's own raise; around-the-shoulder blend. Bow elbow
  while nocking vs Mixamo: Y Bot 7–22° vs 4–23°; robot 22–39° (its broad shoulders).
- RELEASE "hand inside the head" (user): it was already inside at FULL DRAW — the arrow ran
  5.3° off the aim (the knuckles' 7° in the aim frame, wrong once the bow sits as the clip
  holds it), the string hand 7.5 cm into the head. Now the arrow line: 1.9° off, the string
  at the cheek (7.5 cm out), knuckles 12.6–13.3 cm (head ±8); the release moves out and away.
  (bow5's targets: the crosshair ray hits the leaning butt face ~14 cm above the boss —
  the "high" offsets are that, not the bow.)
- Y Bot "shoulders back, chest out" (user): the robot's COLLARBONES point 37° back in its own
  rest (Y Bot's 12°); copied by direction onto Y Bot (−0.54 / −0.70 forward share). Collarbones
  now carry their MOVE from each one's own rest ("rest" kind in retarget.js): Y Bot idle
  −0.10 / −0.30, its own Mixamo stance −0.24 / −0.07. Bow bases re-baked for both riders.
- HEADGEAR (Rider ▸ headgear: hat / helmet / none, kept in this browser): helmet.js — a
  great helm fitted to each rider's head (oval, 1.8 cm off it), keeled face plate, a real
  eye slit under the upper plate's lip, domed crown plate, brass cross + brow strip,
  breathing holes in a cross, rolled rim, hammered steel (shine varies). The bow anchors
  against its cheek (anchor out to its side + 1.2 cm). "Too big / not realistic" (user):
  v1 was round from the head's longest axis (14 cm out every way).
- The head (helmet worn, else the head inside it) is an OBSTACLE for the fetching hand and
  the arrow (keepOffHead: a power-4 rounded box round the shell, pushed out from its middle;
  the push eased in): the wrist went 58–90 % into a helmet over the crown, the arrow 70 %.
  Now 0 frames inside on both riders; a few hand-jerk flags at 1.22–1.25 (the whip, ~Mixamo's).
- Y BOT RIDING PASS (2026-10-12), measured against the robot (riderCheck + ridefilm in the
  saddle frame): it sat 6–8 cm INTO the saddle — its pelvis bone sits ~9 cm higher in its body;
  the pelvis is placed by the bone. rider.seatAdj = seatDepth(Y Bot) − seatDepth(robot), from
  each one's SITTING pose (rider.js seatDepth; riding + mount seat). Stirrups 0.56 → 0.52
  (knee 60 → 70°, the robot's). Its own riding settings: anims/riding-ybot.json (the K editor
  saves per rider), gallop seatUp 0.09 / lean 0.75 (knees 56°, seat 3 cm up, torso 34°).
  Now: seated gaits seat −0.8…+1.1 cm (robot −0.7…+0.9), knees 70–71° (70–74°); checks: the
  same flags as the robot, mount slightly better (no leg inside the horse any more).
- TODO: the user's look at Y Bot riding / mounting (by eye, near side) (seat, strap, mount keys retune);
  the release lowering bow elbow (~30° more than the clip for 0.3 s).

## ▶ Mixamo → robot RETARGET (retarget.js) — 2026-10-11

- Any Mixamo FBX baked onto the robot (Quaternius UAL, UE bone names; 52 bones mapped:
  spine, collarbones, arms, hands + 3 finger joints, legs, feet). Rests matched per
  bone by a body frame (to the child; body side / forward / across the palm); Mixamo's
  rotation from its rest carried over; its start facing taken out; pelvis offset ×hip
  height. Measured: every bone within 0–1° of Mixamo's in the body frame.
- The BOW plays it as its BASE (BP.mocap, anims/bow-shot-mocap.json, editor "bake
  Mixamo body"): fetch = clip time, draw 1.95→2.8 by the draw, its hold while held,
  release 3.85→4.8; phase changes crossfade 0.15 s. Corrections on top only:
  string hand → our quiver (grab, from the robot's own pose at the grab); the BOW HAND
  brings the string to the clip's string fingers (the robot's broad chest put it 13 cm
  out of reach); the bow held as the clip holds it (learnt at its nock, 1.6 s);
  the hand keeps the clip's world orientation (a roll number flipped 69°); at full draw
  (by the bow's raise) the archer's form: shoulders levelled, chest open 14°, collarbones
  to the idle's, the hook grip, head on the arrow.
- Measured: fetch checks clean; jumps ≤ 4.6 cm (in the release); full draw: shoulders
  0 cm, neck 76°, head 0°, bow elbow 173°, abduction 92°, anchor 6.8 cm, draw elbow 5.8 cm
  over the line (ref 0–5); accuracy gold at 10–60 m.
- NEXT: the editor still edits the old keyed channels — make it key OFFSETS over the
  clip; more clips (Standing Aim Walk → walking while aiming).

## ▶ Shadows — 2026-10-11 (user: "the robot has so bad shadows… self shadow low quality")

- Was: ONE 2048 sun map over a ±24 m box = 2.3 cm a texel + normalBias 3 cm → the
  hat, quiver, arrows and arms cast nothing on the body. Now CSMShadowNode (v3's
  csmSplits.nearAnchoredSplits): 3 cascades to 90 m, the first ending 6 m from the
  camera (~5 mm texels), bias / normalBias per cascade (SH in horse-lab.html;
  ?csm=0 = the old map). Close up: hat on the neck, arm + arrow shafts on the back.
- Cost (debug Chrome, ?gpu=1): GPU ~equal (0.8–1.05 vs 1.1–1.2 ms, noise); draws
  ×2 (229 → 436 riding, 532 on foot). TODO: the user's MSI measurement.
- The hat's dark triangles are its flatShading (hat.js, low-poly look), not shadow.

## ▶ The bow on foot (bow.js) — 2026-10-09

- 2026-10-10: FETCH TIMELINE EDITOR (U, bowEditor.js) — the arrow fetch as keyed
  channels in the right shoulder's frame (bow.js FETCH_CHANNELS): hand (gizmo),
  elbow direction (gizmo), forearm roll, fingers 0 open · 1 pinch · 2 hook, wrist
  (to the nocks / along the arrow), head turn + tip; "…Low" channels = the start
  from rest (bow down) vs after a shot. Monotone cubic between keys (no overshoot).
  Same IK + limits as the game underneath. Phase bands draggable (keys stretch),
  notes per frame, per-frame checks (red ticks), "rebuild from code" samples the
  coded fetch and thins it (26 hand keys). Save → anims/bow-fetch.json, loaded at
  start; BP.keyed toggles keys / code. A frame is replayed from t=0 at 1/60 s
  (the elbow + roll are rate-limited, a pose depends on its path).
  Keyed vs coded in game (fetch3.js): 9 vs 12 minor flags, hand 2.14 vs 2.02 m/s.
  Also: from the follow-through the elbow + roll now carry on (no reset).
  - "from rest" now starts as the game does (the aim's lead-in: frame 0 at aimW 0.6).
  - READY BOW (nocking) re-posed: BP.readyRoll 1.0 — the lower limb out toward the
    target + ground, top back toward the right shoulder (the archery nocking pose);
    before it crossed the right thigh and swept through the left leg on the way up.
  - BRING (1.85–2.7, user: "the shoulder goes inside the hip at 2.27"): the elbow
    key steered forward-down swung the elbow in across the chest (13 cm inside the
    shoulder, upper arm 4.7 cm from the torso). Now it stays out at the side and drops
    to the nock's; the carried arrow leans out from the body (it grazed the flank).
  - Films of the skinned robot must go through real frames (await rAF): a render in
    a tight loop shows the mesh one frame late (WebGPU skinning updates per frame).
  - 2026-10-11: MIXAMO "Shooting Arrow" (refs/, not in git) is now the reference:
    mixamoRef.js loads it; the editor's "from Mixamo" turns its pinch point, elbow,
    forearm roll, torso turn / lean and bow-hand rise into keys (right shoulder frame,
    ×arm length 0.97) on ITS timing; "show Mixamo" puts its figure beside the robot,
    synced. Saved → anims/bow-fetch.json (the game plays it).
    Cycle matched: fetch 1.95 s (reach .83 · grab .1 · pull .17 · bring .33 · nock .52),
    draw 0.8, release → arms lower 0.8 → next fetch FROM REST (BP.repeatFromHold off).
    New: channels bowReady / turn / lean; quiver re-placed (BP.quiverNocks: nocks just
    behind the neck, where Mixamo grabs); keyed grab pull onto our quiver; the carried
    arrow TRAILS along the hand's path (hanging, it went through the head); soft reach
    limit; forearm roll up to 800°/s (Mixamo ~1000); ready bow at the left hip
    (readyIn −0.1, readyDown/readyFwd 0.36). Checks: "jerks" vs Mixamo's own hand ×1.5,
    the torso as an elliptic cylinder. Left: 2 small flags (0.05 start ease, 0.73).
    Full draw unchanged (abduction 101°, elbow 173°, anchor 6.7 cm).
  - JUMPS in the game's cycle (user: "a jump of position at the last frame", outside
    the editor) — measured frame to frame over two shots (scratchpad jumps.js), all fixed:
    fetch → string 13–20 cm (the keys hand over to the nock pose across the nock; the
    torso's lean straightens over 0.55 s); the bow flashing to "ready" for one frame at
    each fetch (keys read after the phase change); the bow rising in the aim's lead-in;
    the elbow at part IK weight (it now fades with the hand); the lowering (Mixamo's
    path in front of the chest — fading the weight flipped the folded arm, 32 cm); the
    bow elbow snapping straight mid-draw (its wrist eases into full reach); the reach /
    wrist limits handing over across the nock. Left: the release's own 3.3 cm snap.
  NEXT: the user marks frames with notes → I change the keys. Later: the draw /
  release on the same timeline.

- 2026-10-10: QUIVER hollow fixed (single-sided tube: the inner wall was not drawn,
  the ground showed through the mouth) — an inner wall facing in + a floor.
- FULL DRAW measured vs a 2025 Frontiers review (elite archers) + coaching steps
  (scratchpad archmeasure.js): bow elbow 120 → 173° (the reach ignored the hand's
  own ~17 cm), bow-arm abduction 73 → 99° (ref 90–100), anchor 17 → 6.7 cm below
  the eye (jaw), draw elbow on the arrow line (0.3 cm), shoulders in line with the
  arrow (chestOpen 0: 0°), force line 4°. Arrow 0.76 → 0.84 m (draw is now 0.77).
- After the grab (user: "the forearm does a bad movement", "the neck turns way too
  much"): the hand swung out to the side then dragged the arrow across the belly
  (the ready bow was far left and low) — now the ready bow is in front of the middle
  (BP.readyIn) and the hand brings the arrow down in front of the right shoulder;
  nocking, the draw elbow hangs DOWN (poleNock), rising behind as the bow comes up
  (it stuck out forward: a chicken wing). Neck: the head turned from the CHEST's
  forward put it 17° past the arrow (93° neck twist); now from the head's own facing
  (0° off the arrow), a slightly open chest (BP.chestOpen 0.25) → 76° twist (human
  ~70–80); while fetching / nocking it looks at the hands (BP.lookReady, lookDown).
- FOLLOW-THROUGH held 0.9 s (bow arm up, hand back by the neck; it dropped to the
  hip at 0.45 s), then the next fetch starts from there (it snapped to the hanging
  clip pose: fetchStart was read before the IK).

- DONE (first pass, uncommitted): procedural archery over the idle / walk clips —
  side-on stance, waist bends with the aim, bow arm IK + fist on the grip, draw
  hand hooks the string to a cheek anchor; a recurve whose limbs bend so the
  string keeps its length; arrows (shaft, cresting, 3 vanes, leaf head) fly with
  gravity + drag and stick (targets follow, ground, fences); back quiver with
  reach / pull / nock; release snap, string ring, follow-through. Archery range
  on the parkour field (butts 10–60 m with ring scores + the lance lane's jar,
  straw man, sandbag, crates). Debug: predicted arc, flight trails, hit notes.
  Measured: crosshair → gold at 10–45 m (6–9 cm), red at 60 m; all 5 physics
  targets hit. Cost: +29 draws with the bow on; aiming ~1.1 ms CPU (~2 ms while
  drawing: the bow mesh rebuilds).
- REDONE (user: "not anatomy, not possible"): the quiver fetch. Measured before: wrist
  bent 159°, elbow locked / snapping, hand path through the body, nocking at full
  arm's length (string 0.9 m from the right shoulder: arm locked, wrist 77°). Now:
  keyed path in the chest frame (rise → beside the ear → nocks → pull along the
  quiver, arrow pivoting on the lip → out beside the right shoulder, arrow hanging
  clear → across the chest → string); elbow up-out reaching back; wrists limited
  to the forearm (draw hand 0–34°, bow hand ≤ 30°, the bow follows the fist);
  reach capped (no locked elbow). Nocking with the bow LOW ("ready"), then the bow
  rises onto the target while drawing (push–pull). Test: scratchpad fetch2.js.
- REDONE AGAIN (user: "fingers completely wrong", "smoother, slower, realistic every
  frame"): measured frame by frame (scratchpad fetch3.js: elbow, wrist, forearm roll,
  hand speed/accel, arrow vs hand/head/chest; fetch5.js big frames; hand1.js hand
  close-ups). Found: pinch gap 14 cm (thumb never met the index), hook palm turned
  away from the face (forearm at full pronation), elbow pole along the arm (flips
  52°/frame, misses 32 cm), 3 IK passes (15 cm misses), palm asked outside the
  forearm's roll range, arrow never freed (pull shorter than the arrow). Now: pinch
  searched on this hand (thumb opposition 1 rad); forearm ROLL keyed directly
  (BP.tauGrab −35, BP.tauHook −70; range −165…−15, ≤300°/s); elbow continuous
  (≤3°/frame toward its side); 8 IK passes; over-the-shoulder reach (elbow up in
  front, fingers down to the nocks); minimum-jerk curves, 3.15 s; quiver 0.48 m
  (arrows stand 30 cm out). Result: hand ≤2.3 m/s, misses 0–0.2 cm, roll −100…−43,
  elbow 43–134°, wrist ≤34°, 14 minor flags.
- [ ] Walk while aiming (no strafe clips: slow walk facing the aim? lower-body turn?).
- [ ] The hand passes through the cowboy hat's brim reaching the quiver.
- [ ] Second and later arrows: the fetch starts from the release pose (not tested frame by frame yet).
- [ ] Draw cost: bow normals analytic instead of computeVertexNormals.
- [ ] Stuck arrows: 3 draws each (up to 24) — merge or instance.
- [ ] Horse archery (the same pose on the saddle).
- [ ] The user to judge the look (anchor height, stance, camera) against the reference.

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
- DONE: stepping DOWN lands past the edge, eased (no 38 cm snap, no hoof on the
  corner); a lifted hoof is never asked past 95 % of the leg (no locked-straight
  leg at a 70 cm step). 0.6–0.75 m steps CLIMB cleanly — a hop would need a
  walk/canter jump clip; left for now.
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
