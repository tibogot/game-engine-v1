# Sand & Blood — what remains

*Updated 2026-10-17. Maps 2 (the coast) and 3 (El Kantara) are not here; they come after. The
details are in TODO.md.*

---

## Done since the last list (2026-10-13 → 10-17)

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

- **A full match as the FLN** against the French AI, and one as the French. Fair? Fun at
  25–30 min? The prices of the FLN units, tiers and doctrines.
- **The H-21 and the paradrop** (landing time, price, one or two squads; the drop's height and sway).
- **The training,** played as a new player would.
- **Looks:** the villages, the alfa steppe, the rocks from the RTS camera.
- **The new mortar and flamethrower** in a real fight (look and balance).
- **Capture rings:** ours are 22–40 m wide, CoH's about 10–12 m.

---

## 2. Gameplay still missing (biggest first)

1. **Building damage and collapse** — CoH's signature, our biggest gap.
   - Walls go, the garrison is forced out, rubble is left behind.
   - Large: every building goes through the lab, and the village meshes are merged, so each
     house needs its own id first.
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
   - Spotted mines show on the minimap.
   - Wire snags men.
   - A "can't go there" cursor.
   - A smoke barrage from the mortar.
   - The H-21 door gun.
   - The French AI: smoke, the Alouette, repairs, wire-cutting.
   - The FLN: train units at a refuge; retreat to the nearest refuge.
6. ~~Skirmish menu: pick the doctrine before the briefing~~ — **done the CoH 3 way, 2026-10-19:**
   the doctrine is chosen IN the match, on its panel (cards), any time, kept for the battle; the
   points earned before are kept. The briefing has the difficulty only.

---

## 3. Content for launch

- **A short campaign**
  - 3–5 missions with Colonel Delorme.
  - Objectives beyond holding villages: a convoy escort, a night defence, a raid on a cave.
  - Saves between missions.
- **Voices:** French and Darija recordings — blocked until we have recordings or a TTS key
  (in an environment variable only).
- **Music:** none yet.
- **Doctrine card art:** the sheet is ready, waiting for your go.

---

## 4. Polish

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
  - The souk still uses the old kit.
  - Graded tracks and terrace steps.
- **Optional extras**
  - More animals and birds: camels, caravans, storks.
  - Sandstorm weather.
  - An H-34 gunship.

---

## 5. A finished product

- **Release cleanup:** the dev panel still shows unless `?dev=0`; it should only show with `?dev=1`.
- **Options:** graphics presets, resolution, volume sliders, key rebinding (AZERTY).
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

## 6. Steam

- An **Electron build:** a persistent shader cache, saves on disk.
- **Steamworks:** achievements, cloud saves.
- A **licence audit** of every asset (above all the Freesound sounds), and a credits screen.
- The **store page** and a trailer.
- A short **historical note** at the start.

---

## Suggested order

1. You play a full match on each side.
2. Building damage and collapse.
3. FLN-side training.
4. The explosions onto lab books.
5. The campaign.
6. Options, cleanup, boot time.
7. Steam.
