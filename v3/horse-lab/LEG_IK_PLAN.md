# Horse legs on real terrain: the plan (2026-10-22)

You, 2026-10-21, after riding the steppe course: "everywhere the horse legs on any shape was doing some
bad things". Then: "check online for the best IK for legs for the horse … it should look perfect".

## What the films showed (games/steppe-rider, side view, slowed)

- **Up a 15° ramp:** the front legs reach almost horizontally, forward and up into the hill, and the
  hind legs fold under the belly.
- **Down a 15° ramp:** the front legs tuck back under the chest, and the hind legs fling out behind,
  almost horizontal.
- **The cause:** the gait clip's leg swing **tilts with the body**. The whole rig is pitched to the
  slope, so every stride is rotated 15°. A real horse's legs swing relative to gravity: the trunk
  tilts and the shoulders and hips take the difference.
- My earlier numbers (hooves ≤ 5–10 cm off the ground) could not catch this: the hooves touch the
  ground, but the legs get there the wrong way.

## What the research found (sources below)

- **Red Dead Redemption 2** (Rockstar's GDC talk):
  - IK on the body and head on hills "looked wrong", so they authored incline and decline animations.
    The slope picks and blends incline, decline and flat clip sets; foot IK only adjusts the hooves.
  - The path ahead is probed to read upcoming slopes.
- **Shadow of the Colossus (Agro):** 2-bone IK on the last two bones of each leg; one solve both raises
  and angles the whole body.
- **Unreal 5:**
  - Foot Placement: a separate pelvis mode for slopes (front planted feet), pelvis springs, foot locks
    (pivot about the ball or the ankle).
  - Leg IK / IK Rig Limb Solver: chains of 3+ bones on a hinge plane, min rotation angle (no folding
    back), soft reach near full length, knee twist correction.
  - Stride / Slope Warping: stride along the floor normal, FK limits clamp the IK.
- **Final IK GrounderQuadruped (Unity):** two solvers, hind legs at the pelvis and forelegs at the
  withers; root pitch limits (downhill / uphill separately); per-leg max offset; predicting where the
  foot lands.
- **Horse anatomy:**
  - The hind leg's **reciprocal apparatus**: stifle and hock always flex together (a parallelogram).
    Hind legs bent any other way look broken.
  - Hooves stay **flat** through stance, then roll over the toe (breakover: about the last 20 % of
    stance at the walk).
  - The fetlock extends up to about 60° past straight under load.
  - Uphill, the hind legs push more; downhill, the hind legs step under the body.

## The rig was missing bones (found 2026-10-22, your close-up of a "broken" front foot)

- **Our legs:**
  - front: elbow, knee, cannon, then PASTERN + HOOF as ONE bone (`IKFront/BackLeg*`, on the root);
  - hind: hip, stifle, hock, cannon, then the same block.
- **The kink:** to lay the hoof on a slope the code turns that block, and the pastern turns with it.
  Up 15°, the fetlock buckled forward over the hoof.
- **A real horse rig** (Blender Rigify's horse metarig): front shoulder blade → upper arm →
  forearm → **cannon → pastern → hoof**; hind pelvis → thigh → shin → **cannon → pastern → hoof**.
  Dropping the pastern or hoof bone "looks super wrong"
  (https://www.themanequest.com/blog/2021/8/22/8-common-horse-mistakes-i-want-game-developers-to-stop-making,
  https://projects.blender.org/blender/blender-addons/raw/branch/main/rigify/metarigs/Animals/horse.py).
- **Real angles** (dorsal angle, 180° = straight):
  - Standing: cannon upright, pastern 50–55° to the ground, and **hoof in line with the pastern**
    (https://en.wikipedia.org/wiki/Pastern, https://ker.com/equinews/conformation-pasterns-hooves-horses/).
    The fetlock is then ≈ 215°.
  - Fetlock: about 213–222° at mid-stance (walk / trot) and flatter at speed; **always below 180°
    (folded) in the swing**. Range 62° at the walk, 77° at the trot.
  - Coffin joint (pastern → hoof): about 46° of motion only.
  - Front knee (carpus): **straight in stance** (about 15° of play); 76–80° folded in the swing.
  - Hind: the hock is tied to the stifle (reciprocal apparatus); the cannon roughly follows the thigh.
  - Landing flat or heel-first, never toe-first; breakover about 20 % of stance at the walk.
  - Sources: Clayton 2004 / 2007, Back 1996, https://www.tandfonline.com/doi/pdf/10.4081/ijas.2009.s2.718,
    https://madbarn.com/research/three-dimensional-carpal-kinematics-of-trotting-horses/,
    https://americanfarriers.com/articles/461-three-rules-for-breakover
- **Fix:**
  1. **Add a pastern bone and a hoof bone to every leg at load**: re-skin the hoof capsule onto the
     hoof bone, with a soft blend at the coronet.
  2. **Solve bottom-up:**
     1. the hoof flat on the ground (rolling over the toe in breakover);
     2. the pastern in line with the hoof (coffin −30…+20°);
     3. the fetlock from the load (sunk in stance, folded in the swing);
     4. the upper leg to the fetlock (front knee straight in stance, hock with the stifle).

## Progress, 2026-10-22 (waiting for your look)

- **The hoof is its own bone.** `FF`, under the fetlock bone, is never keyed by the clips. The hoof capsule is
  re-skinned onto it in `horseBody.js` (`HOOF_SKIN`: blend over the coronet, 0.5–3 cm above the bone).
  Laying the hoof on a slope now turns **only the hoof**, within ±30° of the pastern (`HP.coffinMax`).
- **The front and hind ends sink and rise separately** (stage 2, `HP.endsApart`).
  - Each end follows its own hooves: it sinks up to `maxDrop` and rises up to 15 cm, by the lower
    of its two hooves.
  - The difference becomes extra pitch round the hips, up to 17°.
  - The cause it fixes: up a slope the whole body sank 7 cm for the hind legs, the forelegs came out
    6 cm too long, and the 2-bone IK folded the **front knee 50°**. A horse's knee is straight
    whenever its hoof is down.
- **Measured, standing mid-way up 15°:**
  - front knee 51° → **11°**, the same as on the flat (8–13°);
  - fetlock 64° → **30°**.
- **Hoof soles, the drawn skin against the ground:**
  - planted hooves stay on the ground;
  - the worst is a swinging hind toe brushing the rising slope ahead (5 cm up 15°), which is stage 6.
- Motion audit 15/15, npm test 211/211.

## Slopes the legs can't take: the horse doesn't go (2026-10-22)

You: "when something will make the horse legs look bad then it means the horse can't pass it".

- **Measured on the steppe ramps** (walk / canter, the drawn hoof soles, the front knee in stance):
  - up to 20° the legs hold a natural shape;
  - from ~25° they can't: soles 10+ cm into the ground, knees folded.
- **Research:**
  - Horses "easily" take steady 20 % (11°) grades, and balance is easier uphill than downhill
    (USFS Equestrian Design Guidebook).
  - Sideways on a slope is the riskiest; riders zigzag across steep hills.
  - RDR2 probes its path's slope, sidesteps to a safer line, lets the horse ignore the rider when its
    safety is at stake, and blends incline / decline clips
    (https://www.gamedeveloper.com/design/rockstar-s-quest-for-the-ultimate-video-game-horse).
- **The slope gate** (`horse.js`: `HP.slopeGate`, `HP.slopeLimits`, `slopeAhead()`; only on terrain
  levels with `world.heightAt`). The ground under the body and ~3 m ahead caps the gait, in degrees
  [uphill, downhill, sideways]:

  | Gait | Uphill | Downhill | Sideways |
  |---|---|---|---|
  | Walk | 22 | 20 | 20 |
  | Trot | 20 | 16 | 18 |
  | Canter | 18 | 12 | 15 |
  | Gallop | 12 | 8 | 8 |

  Past the walk's limits the horse REFUSES: it stops, tosses its head once, and backing up or turning
  stay free.
  - Measured: ramps 5–15° climbed; 20° at a walk; 25°, 30°, both ditches and the ridge refused at the
    foot; the bowl refused where it steepens; the big hill climbed at a canter.
- **Also in this pass:**
  - **Swing sole clearance** (`HP.soleClear`): the whole sole (toe, middle, heel, read from the skin) clears
    the ground under where the hoof goes. Walking up 20°: 11.6 → 4 cm.
  - **The ends follow their PLANTED hooves, the higher one, counting a hoof about to land** (`HP.endsAhead`).
  - **A planted foreleg keeps its knee** (`HP.kneeLock`, `frontStance()`): it turns at the elbow and the
    fetlock takes up the length.
  - **Front knee in stance:**
    - canter up 10–25°: **6°** (flat: 20°);
    - walk up 15°: median 6°, worst 10 % 52° → 34° (the flat walk's own).

## The plan, one stage at a time

Each stage is filmed before and after, and you look before the next one.

1. **Legs relative to gravity.** The body tilts, but each leg's swing is turned back by the body's
   pitch and roll at the shoulder and hip, so strides stay upright. **Done (2026-10-22), waiting
   for your look.**
   - horse.js `HP.legUpright` (step 0 of `applyIK`): each leg's top bone and its hoof target are
     turned back by the slope round the shoulder or hip; the hind cannon and the planted-hoof
     corrections remove only the rest of the tilt.
   - Found while doing it: the hoof's step look-ahead read every slope as a step. On a 15° ramp,
     every frame each hoof was moved 17–38 cm forward and lifted 20–25 cm. It now judges the ground
     ahead against the slope carried on from under the hoof.
   - Also fixed: a held step height put a hoof 47 cm under the wall of the wide ditch.
   - Leg angle, shoulder or hip to hoof, mean in degrees (front / hind):
     - flat: −4 / −3
     - up 15°: was +34 / +26, now **+10 / +2**
     - down 15°: was −2 / −21, now **+11 / −7** (front hooves bracing ahead going down)
   - Hooves into the ground:
     - ramps 5–20°, hills, moguls, bowl: about 1 cm
     - wide ditch: 3.9 cm (was 47)
     - cross slope: 4.3 cm
     - big hill: 7.6 cm
     - steeper than ~25° (ramps 25–30°, the narrow ditch's walls, the ridge): 10–23 cm — stage 5
   - Motion audit 15/15, npm test 211/211.
2. **Front and hind ends separately.**
   - Withers height from the front hooves, hip height from the hind hooves; the pitch is the
     difference (clamped ±25°), spread along the spine. Roll stays small (±8°): the legs take a cross
     slope.
   - The neck and head keep part of their own angle.
   - Each end can drop freely and rise only a little.
3. **Leg IK rebuilt for horse anatomy.**
   - Stance: the cannon is kept as the clip has it (near upright), with a 2-bone solve above it to
     the hock or knee.
   - Swing: the clip's joint-angle ratios are kept while reaching.
   - Hind stifle and hock coupled.
   - Soft reach (≤ 0.98 of the leg's length), hinge limits so nothing ever bends backwards, and the
     clip's own knee plane as the pole.
4. **Hooves.**
   - Flat on the smoothed ground normal through stance, rolling over the toe at the end.
   - Locked in place while planted, so no sliding; the lock fades out on a spring.
   - Hoof tilt is limited to about ±30° pitch and ±12° roll, with the rest taken by the pastern and
     fetlock (≤ 60° past straight).
5. **Uphill and downhill postures** (the RDR2 lesson).
   - Uphill: the head and neck go forward and low, and the hind legs reach further.
   - Downhill: the hind hooves land further under the body, the front legs brace, and the head comes
     up a little.
   - Blended by the smoothed slope; this also gets the horse up 25–30°, which today reads as a wall.
6. **Swing over bumps.** At lift-off, predict where the hoof will land, sample the ground on the way,
   and lift the swing over the highest point (a sin(π·phase) clearance bump).

## Sources

- RDR2 horse (Rockstar, GDC): https://www.gamedeveloper.com/design/rockstar-s-quest-for-the-ultimate-video-game-horse
- Shadow of the Colossus, Agro's IK: https://www.gameanim.com/?p=135
- UE5:
  - Foot Placement pelvis settings: https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/AnimationWarpingRuntime/FFootPlacementPelvisSettings
  - Foot Placement lock types: https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Plugins/AnimationWarpingRuntime/EFootPlacementLockType
  - Leg IK: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/AnimGraphRuntime/FAnimNode_LegIK
  - IK Rig Limb Solver: https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/IKRigLimbSolverSettings
  - Pose warping: https://dev.epicgames.com/documentation/en-us/unreal-engine/pose-warping-in-unreal-engine
- Final IK GrounderQuadruped: http://www.root-motion.com/finalikdox/html/page9.html
- Foot placement recipe (Vulkan glTF IK tutorial): https://docs.vulkan.org/tutorial/latest/Advanced_glTF/Procedural_Animation_IK/04_foot_placement.html
- Two-joint IK, stable bend axis: https://theorangeduck.com/page/simple-two-joint
- Springs, inertialization: https://theorangeduck.com/page/spring-roll-call
- Maya Spring IK (ratio-preserving legs): https://help.autodesk.com/cloudhelp/2016/ENU/Maya/files/GUID-695C3AF4-5DA7-4126-B890-3F4CB4F65E96.htm
- Stay apparatus, reciprocal apparatus: https://en.wikivet.net/Stay_Apparatus_-_Horse_Anatomy
- Stifle and hock in movement: https://americanfarriers.com/articles/13063-the-critical-importance-of-the-horses-stifle-and-hock-in-movement
- Hoof breakover timing: https://pmc.ncbi.nlm.nih.gov/articles/PMC8472780
- Fetlock extension at the walk: https://research-portal.uu.nl/en/publications/are-kinematics-of-the-walk-related-to-the-locomotion-of-a-warmblo/
- Slope locomotion forces: https://hal.inrae.fr/hal-02743076v1
- Rune Skovbo Johansen, semi-procedural locomotion (any legs, slopes), to read: https://runevision.com/thesis/rune_skovbo_johansen_thesis.pdf
