# Sand & Blood — what remains

*Updated 2026-10-13, after the FLN toolkit and the French AI. Maps 2 (the coast) and 3 (El Kantara)
are not here; they come after. The details are in TODO.md.*

---

## Done since the last list (2026-10-13)

- **Heliborne:** the H-21 (lands to pick up and drop squads), the Noratlas paradrop (the paras
  doctrine's call-in).
- **The FLN is playable** (`?side=fln`): build buttons, squads at the cave (retreat, reinforce),
  mines and the line cut as buttons.
- **The FLN's heavy weapons:** a 60 mm mortar team, a 57 mm recoilless rifle, a tripod 12.7 mm
  against aircraft, a pack mule (a moving supply point).
- **An FLN base:** its own three tiers at the cave, a field hospital, refuges as a second base.
- **FLN doctrines:** Wilaya and Army of the borders.
- **The French AI uses its toolkit:** sappers build (mortar pit, mirador, MG nests), the barrage,
  flares at night, grenades, squads carried by half-track / GMC / H-21, and a doctrine of its own.

---

## 1. Waiting on you: play and judge

- **A full match as the FLN** against the new French AI, and one as the French. Fair? Fun at
  25–30 min? Prices of the new FLN units, tiers and doctrines.
- **The new air units:** the H-21 (landing time, price, one or two squads); a paradrop (the 24 m
  height, the canopy colour, the sway).
- **The training:** play it as a new player would.
- **Looks:** the village look (photo detail vs the kit's colours), the alfa steppe, the sandstone
  rocks from the RTS camera.
- **Effects in motion:** fire, smoke, explosions.
- **Capture rings:** ours are 22–40 m wide, CoH's about 10–12 m.

---

## 2. Gameplay still missing (biggest first)

1. **Building damage and collapse** — CoH's signature, our biggest gap.
   - Walls go, the garrison is forced out, rubble is left behind.
   - Large: every building goes through the lab, and the village meshes are merged, so each
     house needs its own id first.
2. **FLN-side training** on its own maquis map.
3. **The FLN AI** doesn't use the new units yet (mortar, recoilless, 12.7, mule).
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
6. **Skirmish menu:** let the player pick the doctrine before the briefing (map, side and
   difficulty already work).

---

## 3. Content for launch

- **A short campaign**
  - 3–5 missions with Colonel Delorme.
  - Objectives beyond holding villages: a convoy escort, a night defence, a raid on a cave.
  - Saves between missions.
- **Voices:** French and Darija recordings — blocked until we have recordings or a TTS key
  (in an environment variable only).
- **Music:** none yet.

---

## 4. Polish

- **New units' looks**
  - The captured jeep: washed bright red and crewed by French conscripts — it wants its own look.
  - The recoilless tube carried on the shoulder (its own clip).
  - A real 12.7 mm DShK model (drawn as the FM 24/29 now).
  - Portraits for the new FLN teams and the mule; a health bar over the mule.
- **Effects**
  - Directional bullet hits, dust from hit buildings, muzzle blasts, ricochets.
  - Embers and soot over wrecks.
- **Units**
  - More death and hit clips; a firing clip for vehicle gunners.
  - Portraits for the mirador, the MG nest and the other small buildings.
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
- **Performance**
  - Ground foliage costs 2.1–2.8 ms.
  - The shadow pass.
  - About 115 duplicate shader builds.
  - Herd templates take 2.6 s at boot.
  - Boot takes 44 s in all: a shader cache, preloading, a real loading screen.
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
3. The FLN AI using its new units; FLN-side training.
4. The campaign.
5. Options, cleanup, boot time.
6. Steam.
