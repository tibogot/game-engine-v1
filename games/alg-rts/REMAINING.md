# Sand & Blood — what remains

*2026-10-13. Every open box in TODO.md, checked against the code and git: about 75 old ones were
already done and are left out. Maps 2 (the coast) and 3 (El Kantara) are not here; they come
after. The details and line numbers are in TODO.md.*

---

## 1. Waiting on you: play and judge

- **Balance**
  - A full match on Normal, as France and as the FLN. Is it fair? Is it fun at 25–30 min?
  - Doctrine prices and cooldowns; the economy numbers.
- **The new air units**
  - The H-21: landing time (3.4 s down, 2.8 s up), price, two squads or one.
  - A paradrop: the 24 m height, the canopy colour, the sway.
- **The training**: play it as a new player would.
- **Looks**
  - The village look: photo detail vs the kit's colours.
  - The alfa steppe.
  - The sandstone rocks seen from the RTS camera.
- **Effects in motion**: fire, smoke, explosions.
- **Capture rings**: ours are 22–40 m wide, CoH's about 10–12 m.

---

## 2. Gameplay still missing (biggest first)

1. **Building damage and collapse** — CoH's signature, our biggest gap.
   - Walls go, the garrison is forced out, rubble is left behind.
   - Large: the village meshes are merged, so each house needs its own id first.
2. **The French AI** never uses:
   - sappers, mortars, flares, its doctrines, or the H-21.
3. **The FLN side's own toolkit**
   - More structures to build (a field hospital, …).
   - A mortar team, a recoilless-rifle team, a tripod machine gun against helicopters, mules.
   - FLN doctrines, and a counter to the French air strike.
4. **FLN-side training** on its own maquis map (after #3).
5. **Destruction extras**
   - Real craters in the ground that men can use as cover.
   - Vehicles blown apart, and wrecks a tank can push.
   - Trees that fall.
6. **Smaller rules**
   - Low walls and brush slow infantry.
   - Spotted mines show on the minimap.
   - Wire snags men.
   - A "can't go there" cursor.
   - A smoke barrage from the mortar.
   - The H-21 door gun.
7. **Skirmish menu**: let the player pick the doctrine (map, side and difficulty already work).

---

## 3. Content for launch

- **A short campaign**
  - 3–5 missions with Colonel Delorme.
  - Objectives beyond holding villages: a convoy escort, a night defence, a raid on a cave.
  - Saves between missions.
- **Voices**: French and Darija recordings — blocked until we have recordings or a TTS key
  (in an environment variable only).
- **Music**: none yet.

---

## 4. Polish

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

- **Release cleanup**: the dev panel still shows unless `?dev=0`; it should only show with `?dev=1`.
- **Options**: graphics presets, resolution, volume sliders, key rebinding (AZERTY).
- **Performance**
  - Ground foliage costs 2.1–2.8 ms.
  - The shadow pass.
  - About 115 duplicate shader builds.
  - Herd templates take 2.6 s at boot.
  - Boot takes 44 s in all: a shader cache, preloading, a real loading screen.
  - Test on a weaker GPU.
- **Arabic**, with the right-to-left interface (can come during Early Access).

---

## 6. Steam

- An **Electron build**: a persistent shader cache, saves on disk.
- **Steamworks**: achievements, cloud saves.
- A **licence audit** of every asset (above all the Freesound sounds), and a credits screen.
- The **store page** and a trailer.
- A short **historical note** at the start.

---

## Suggested order

1. You play a full match, the H-21 and a paradrop.
2. The FLN toolkit (you, 2026-10-13: before the collapse, which means going through every building
   in the lab): A1 the FLN made playable (build buttons, squads, its tricks as buttons — DONE 2026-10-13) → A2 its new
   units (mortar, recoilless rifle, tripod HMG, mules) → A3 a base (field hospital, a second
   producer, tiers) → A4 FLN doctrines.
3. The French AI: sappers that build, mortar and flares, grenades and smoke, transports and the
   H-21, doctrines.
4. Building damage and collapse.
5. The campaign.
6. Options, cleanup, boot time.
7. Steam.
