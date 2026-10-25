# Sand & Blood — what remains

*Updated 2026-10-20. Maps 2 (the coast) and 3 (El Kantara) are not here; they come after. The
details are in TODO.md; the new map's plan in AURES2_PLAN.md.*

---

## NEXT SESSION (written 2026-10-25, when you left)

**Your look first (lab: `/games/alg-rts/lab.html` — Tab browses, N = next to judge):**
1. The new pieces, « To judge »: **SAS post** (+ « SAS post: old vs new »), **farmstead** (+ « Farmstead: old vs new »;
   its BURNT tab = the map's burnt farm), **FLN lookout**, **mine marker**.
2. The fixes to confirm (their old « Improve » verdicts can then go): the tents' folds (French post, forward post,
   aid station), the pits' earth (mortar pit, fortified point, MG nest), the sangar's FM on its lip.
3. Once judged: remove the two « old vs new » entries.

**Work, in the order I'd suggest:**
4. **The motor pool**: finish it, then its **damaged / destroyed** states (D).
5. **The rest of the lab pass**: ~57 buildings, 15 plants, 4 rocks not judged — your verdicts feed the next redo list.
6. **Optimisation**: trim the near triangles of the smoothed tents (×2) and the SAS post's tile roof (25k → 35k).
7. **The helipad**: rework completely (its floating sandbags) — you said later.
8. **The training camp** (the player's first map): the FLN ground (lessons 7-9), cover on the knoll, camera framing
   per lesson, a less lawn-like grass.
9. **Old-kit z-fighting** left in houses (112 pairs), M'zab (58), motor pool (50) — fixes inside their build scripts.

**Notes:**
- Method from now on (img2threejs' good idea): for each new piece, a reference image, a detail checklist, and a
  side-by-side sheet before showing it to you.
- Uncommitted on purpose: the ambientCG textures and tools/fetchAmbientCG.mjs (to try on paths and wadis later).

---

## Done 2026-10-21 — the buildables redone in Blender (CoH standard)

Every buildable on both sides now has a Blender model: intact / damaged / ruin, a build order the site
shows piece by piece, far levels, compressed textures, a lab entry. The sandbags are your cloth-simulated
ones throughout.
- **French:** sandbag wall, MG nest (with its AA-52), mortar pit (its 81), barbed wire, mirador (its
  searchlight and gun redone), fortified point, searchlight tower (its head turns), forward post (a
  French radio post — the old one was the Vietnam kit's US shelter), aid station (army ridge tent; the
  red crosses as sharp mesh decals).
- **FLN:** sangar, arms cache, ambush screen, refuge (a hummock with the engine's scrub on it),
  infirmary (patchwork tarp).
- **Cloth simulation** for canvas (tools/blender/clothKit.py): tarps, blankets, collapsed tents — baked
  once in Blender, no cost in the game but triangles.

## Assets still to do (the Blender pass) — 2026-10-21

1. **Still the old look in the game:**
   - French: the **French post** itself (the base) and the **SAS post**.
   - FLN: the **lookout** (guetteur's post), the **maquis camp**, the **cave mouth**, the mine
     marker cairn.
   - Villages: the **stone dechra kit**, the **koubba**, **wells**, the farms and sheepfold, the oasis
     props; the field walls want their LOD and lab entries; the old mechta houses (kept, "ancien").
   - The old Aurès' Roman ruins (procedural, in the game as they are).
2. **For the new pieces:**
   - ~~The damaged / ruin states unused~~ — **done 2026-10-22**: below half health a piece breaks to its damaged
     model (dust), destroyed it stays as its ruin, repaired past 80 % it stands whole (algSangar setPieceState).
   - The **construction animation the CoH way** — you were gathering CoH references.
   - Their **GPU cost**, measured in a quiet moment (the laptop cool, nothing else running).
   - Your verdict in the lab on each ("To judge"): the lab's status → "In the game" once you've seen it.
   - **The infirmary's cloth roof reads FLAT** (you, 2026-10-21): it wants the detail the sandbags have —
     real cloth relief (seams, sewn patch edges, sagging folds, weave in the normal map, wear and dirt
     where it rests on the beams). Next session.
3. **Icons:** ~~the doctrine panel, the resource bar, the FLN abilities on French kit, the squads' weapon badges, the chevrons and alerts~~ — **done 2026-10-22**: every HUD picture now comes from the rendered atlas (82 tiles). Possible later: Legion / para props for the French abilities still sharing the kepi and helmet (képi blanc, green and red berets, a crate under a parachute).
4. **Housekeeping:** the unused scanned stones in assets-src/scans (delete or keep — your call).

## Done since the last list (2026-10-17 → 10-20)

- **A new map, Aurès — Oued Abdi** (`?map=abdi`; the old Aurès untouched): a CoH 3-sized valley
  (~500 m box), the djebel terraced and eroded, sandstone outcrops, calm pale ground, its own light,
  no wind in its plants (the flags keep theirs).
- **Ground marks at CoH quality:** ruts, tank tracks, foot paths, packed earth, charred ground, shell
  craters, trampled points — matched to the ground's own colour, crisp at play zoom. **Dev → Decals**
  tunes every kind live.
- **The M'zab town** on its knoll: a Blender kit (five houses, the souk's arcades, the mosque and its
  minaret, the terrace wall — each intact / damaged / ruin, LODs, one draw per kind), the hill
  stepped in ring terraces, the souk square at its foot, three lanes up to the mosque. The houses
  block movement, give hard cover, block sight (combat and the fog of war) and take garrisons.
- **The French base pieces:** the motor pool (Blender), the new helipad (painted H, simulated
  sandbags), the whitewashed house kit (four types).
- **Units:** the flamethrower squad of 4, the FLN FM team of 2, the carry walk, a radio call when a
  vehicle is captured, readable units on the pale ground; aircraft fly in from the map edge, the
  paras come by H-21.
- **The new lab** (`lab.html`): one catalogue for every building, filters, English.
- **The HUD icons, started:** 56 painted icons planned (ICON_PROMPTS.md), the first three made.

## Done 2026-10-13 → 10-17

- **Mortars, CoH-style.** A French 81 mm team and an FLN 60 mm team of three: the tube and plate
  carried, set up piece by piece, a spotter with binoculars, no small arms, a kneeling rest. The
  mortar pit's crew works the piece and follows it as it turns. The pit is the defence (160 m), the
  team the attack (110 m).
- **The French AI uses mortar teams:** it buys one at ~3½ min and a second at 10, places them behind
  its hottest fight and barrages what its men see. Pits and AI teams fire only on what their side
  sees (the pit used to shell FLN men no Frenchman could see).
- **Mortar balance:** wider scatter, lighter rounds — a man every ~20 s on a squad standing in the
  open (a squad was wiped in under 50 s).
- **Mortar look, from the fire-bake lab:** the launch (a burst at the mouth, a grey column drifting
  downwind), the impact (a blink of fire, earth spikes, a low ring of dust along the ground) and a
  smoke trail with a hot head behind the bomb. Shared `bookShots.js` plays any one-shot lab book.
- **The FLN bazooka upgrade** (an M20, smuggled, needs an arms cache).
- **The flamethrower's ground fire:** its own baked book (burning fuel puddles) and burn marks left
  on the ground.
- **Helipad construction**, the grenade's arc trail.
- **12 new soldier animations:** a flinch when hit, a death thrown back away from a blast, a death
  falling forward while running, the paratroopers' hard landing, sappers hauling a crate to their
  site, the FLN planting a mine by hand, villagers ducking before they run, the wounded limp.
- **Sandbags:** the white blotches on their tops are gone.

---

## 1. Waiting on you: play and judge

- **Oued Abdi's town:** its look at the play zoom (colours, density, the terrace walls), the lanes,
  a fight in the houses.
- **The decals:** tune them with Dev → Decals if any kind reads wrong.
- **The helipad's construction animation** (committed 10-12, never judged).
- **A quiet moment, the laptop cool:** to measure the GPU cost of the motor pool, the helipad and
  the town.
- **A full match as the FLN** against the French AI, and one as the French. Fair? Fun at
  25–30 min? The prices of the FLN units, tiers and doctrines.
- **The H-21 and the paradrop** (landing time, price, one or two squads; the drop's height and sway).
- **The training,** played as a new player would.
- **Looks:** the villages, the alfa steppe, the rocks from the RTS camera.
- **The new mortar and flamethrower** in a real fight (look and balance).
- **Capture rings:** ours are 22–40 m wide, CoH's about 10–12 m.

---

## 2. Oued Abdi — to make it playable (the map in progress)

1. **The other places' buildings:** the oasis (whitewashed kit), the hamlet, the farms and the
   sheepfold (the brown houses), the DECHRA in stone (a stone kit, still to make in Blender), the
   koubba.
2. **Capture points and supply** live: the game told the new site kinds (town, oasis, farm, pass,
   lookout); the souk the big point.
3. **The AI on:** the FLN down its two gullies, its cells in the villages and the town's houses; the
   French AI's routes over the fords.
4. **Your first full match on it**, then the fixes from it.
5. **The FLN side in Blender:** the maquis camp and the cave mouth.
6. **The new French post** in Blender (replaces the old one on this map only).
7. **The town's finish** (after the playtest, where the fighting really is): its edge toward the
   valley (gardens, palms, low walls), the sand ridges at the lanes' edges, patchier render on the
   walls, more roof clutter.
8. **Its menu card** — the old Aurès stays in the list. A night variant later.

## 3. Gameplay still missing (biggest first)

0. ~~**BUG: a grenade thrown BEHIND the squad**~~ — **fixed 2026-10-22**: the throw's direction is the man's held facing (a move's faceAngle turned him back); the same for wire cutting and repairs.
0. **From 2026-10-22 (your questions, CoH compared):**
   - **A held village shows who it backs** (left for later): FLN-held, hand-painted "FLN" and the green-and-white flag
     on two or three walls and a small flag on a roof; French-held, a tricolour on the house by the square. Needs
     wall-decal textures, and separate houses (the new kit: Oued Abdi, the training hamlet; the Aurès' merged mechtas
     once redone). Done already: the capture burst at the flagpole, the sectors coloured on the minimap.
   - ~~**Bodies thrown by blasts**~~ — **done 2026-10-22** (e5fc0a28): thrown on an arc away from it, the RED MIST in
     its dust, near misses KNOCKED DOWN then GET UP. Owed: your look at a knockdown up close (it was in the dust).
   - ~~**Dropped weapons the CoH way**~~ — **done 2026-10-22**: FM, bazooka, flamethrower drop; a right-click picks one up (the AI's men by passing); mortars and the recoilless RE-CREWED by any squad. Left: the FLN's 12.7 (algMgTeam reads its gunner's unit type).
   - ~~**The training:** doctrine, mortar, mines, smoke and hold fire, the camp's drill~~ — **done 2026-10-22**. Left: the
     radio barrage, the MG nest and wire, veterancy (one line each).

1. ~~**Building damage and collapse**~~ — **done 2026-10-22 for the new house kit** (algTownDamage: damage, collapse, the
   garrison out). Left: the OLD merged villages (the Aurès' mechtas) — each house needs its own id first.
   - Walls go, the garrison is forced out, rubble is left behind.
   - The new kits are ready for it: every house (whitewashed, M'zab) has its intact / damaged /
     ruin states and the town is one instanced field with a per-house state — the swap is the next
     step there. The old villages' meshes are merged: each house needs its own id first.
2. ~~The FLN AI doesn't use its new units~~ — **done 2026-10-18**: it buys and uses the 60 mm
   mortar, the 12.7, the recoilless, the mule and bazookas, has its own doctrine and builds
   infirmaries. Its balance against the French AI is being re-measured.
3. **FLN-side training** on its own maquis map.
4. **Destruction extras**
   - Real craters in the ground that men can use as cover.
   - Vehicles blown apart, and wrecks a tank can push.
   - Trees that fall.
5. **Smaller rules**
   - Low walls and brush slow infantry.
   - ~~Spotted mines show on the minimap~~ — **done 2026-10-20** (the FLN sees its own).
   - Wire snags men.
   - ~~A "can't go there" cursor~~ — **done 2026-10-22**.
   - A smoke barrage from the mortar.
   - The H-21 door gun.
   - The French AI: smoke, the Alouette, repairs, wire-cutting.
   - The FLN: train units at a refuge; retreat to the nearest refuge.
6. **From the CoH 3 comparison (2026-10-20), biggest first:**
   - ~~**Vehicle critical hits**~~ — **done 2026-10-22** (algCriticals.js): engine, immobilised, gun, crew stunned, by what hits and
     where (side and rear more); sappers mend them. Left: the AIs reacting (repairs, the FLN aiming for flanks).
   - ~~**Shift-queued orders**~~ — **done 2026-10-22** (shared orderQueue.js): moves and attacks, the waypoints shown.
   - ~~**Tactical pause**~~ — **done 2026-10-22** (ui/gameMenu.js): Ctrl+Space, Pause or the ⏸ button; orders given during it.
   - **The big loose stones** (you, 2026-10-22: "eggs, not AAA"): the 0.6-1 m lumps and boulders → the Poly Haven scans; the small ones kept.
   - **Breach** — rush a garrisoned house to take it (at a risk), CoH 3's.
   - ~~**Attack ground**~~ — **done 2026-10-22** (algAttackGround.js, ⇧G): guns pin the men hidden there, mortars fire on it.
   - **Height** — a bonus firing from above (CoH 3's vertical play): the town's hill, the djebel.
   - **Towing** guns with a vehicle (the mortar, the 12.7, the 57).
   - Done 2026-10-20: **hold fire** (⇧H, both sides) and **reverse** (vehicles back up to a spot close
     behind them; ⇧R forces it).
7. ~~Skirmish menu: pick the doctrine before the briefing~~ — **done the CoH 3 way, 2026-10-19:**
   the doctrine is chosen IN the match, on its panel (cards), any time, kept for the battle; the
   points earned before are kept. The briefing has the difficulty only.

---

## 4. Content for launch

- **The HUD icons:** 56 painted icons (ICON_PROMPTS.md, ChatGPT; the grenade is the style
  reference). Made: grenade, sandbags, radio (to redo: reads as a backpack at 48 px). Next: the
  mirador, then the rest; a packer into one atlas; the command card in colour (greyed when
  unavailable, a cooldown sweep).

- **A short campaign**
  - 3–5 missions with Colonel Delorme.
  - Objectives beyond holding villages: a convoy escort, a night defence, a raid on a cave.
  - Saves between missions.
- **Voices:** French and Darija recordings — blocked until we have recordings or a TTS key
  (in an environment variable only).
- **Music:** none yet.
- **Doctrine card art:** the sheet is ready, waiting for your go.

---

## 5. Polish

- **Effects**
  - The other explosions onto fire-bake-lab books, as the mortar: the tank shell, vehicle deaths,
    the grenade.
  - Directional bullet hits, dust from hit buildings, embers and soot over wrecks.
- **Animations**
  - Still to download from Mixamo: Running Scared (fleeing civilians), Surrender, a flinch from
    behind, Hammering.
  - Downloaded, not used yet: Pointing (an officer giving orders from cover — needs a squad rule),
    Pick Fruit (village life), the kneeling grenade throw (needs its own timing).
  - A firing clip for vehicle gunners.
- **New units' looks**
  - The captured jeep: washed bright red and crewed by French conscripts — it wants its own look.
  - The recoilless tube carried on the shoulder (its own clip).
  - A real 12.7 mm DShK model (drawn as the FM 24/29 now).
  - Portraits for the new FLN teams, the mule, the mirador, the MG nest and the other small
    buildings; a health bar over the mule.
  - See-through silhouettes that darken where they overlap.
- **World**
  - The old Aurès' souk still uses the old kit (Oued Abdi has the M'zab one).
  - Graded tracks and terrace steps.
- **Optional extras**
  - More animals and birds: camels, caravans, storks.
  - Sandstorm weather.
  - An H-34 gunship.

---

## 6. A finished product

- **Release cleanup:** the dev panel still shows unless `?dev=0`; it should only show with `?dev=1`.
- **Options:** graphics presets, resolution, volume sliders, key rebinding (AZERTY).
- **Saving a game** (the campaign needs it) and **replays** (to check what the code has).
- **Performance** (PERF_AUDIT.md)
  - Boot: cut from 44 s to ~22 s on 2026-10-04, not re-measured since (the game has grown a lot).
    Re-measure, then a shader cache, preloading, a real loading screen.
  - Ground foliage costs 2.1–2.8 ms.
  - The shadow pass.
  - About 115 duplicate shader builds.
  - Herd templates take 2.6 s at boot.
  - A ~390 ms frame seen once as a squad spawned (not measured yet).
  - Test on a weaker GPU.
- **Arabic**, with the right-to-left interface (can come during Early Access).

---

## 7. Steam

- An **Electron build:** a persistent shader cache, saves on disk.
- **Steamworks:** achievements, cloud saves.
- A **licence audit** of every asset (above all the Freesound sounds), and a credits screen.
- The **store page** and a trailer.
- A short **historical note** at the start.

---

## Suggested order

1. Oued Abdi playable: its places, points and AI (section 2) — then you play it.
2. You play a full match on each side.
3. Building damage and collapse (the new kits first: their states exist).
4. The HUD icons, as you make them.
5. FLN-side training.
6. The explosions onto lab books.
7. The campaign.
8. Options, cleanup, boot time.
9. Steam.
