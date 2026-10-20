# THE FLN TRAINING — the plan (2026-10-20)

Agreed 2026-10-12 (TODO.md 4b): the common lessons + the FLN's own, on its OWN maquis map, a convoy ambush
as the final. **Status: waiting for your read.** Mark what you change here; I follow this file.

The French training (`algTutorial.js`, `?map=training`) stays EXACTLY as it is.

---

## 1. What the FLN player has today (inventory, 2026-10-20)

- **One producer: the CAVE.** It trains:
  - the faoudj (4 men, 150);
  - the FM 24/29 team (2, 110);
  - the sniper (90);
  - the pack mule (80);
  - the 60 mm mortar (170);
  - the 12.7 (150);
  - the 57 mm recoilless (160).
- **One currency, supplies:** 240 to start, plus:
  - 15/min base;
  - villages pay 40 / 60 / 80 a minute, with no link to the base needed;
  - +6/min per supply point;
  - +15/min per arms cache.
- **Tiers:**
  - T1 Katiba;
  - T2 Heavy weapons (120, needs 1 village);
  - T3 Border army (180, needs 2 villages).
- **Builds (the faoudj):**
  - sangar (hard cover);
  - ambush screen (conceals, no cover);
  - arms cache (income + bazooka);
  - refuge (reinforce forward);
  - infirmary (heals).

  The mule is a moving reinforce and heal point.
- **Tricks:**
  - mine (X);
  - command-detonated mine (I), then FIRE (L);
  - cut the telegraph line (J): the French lose air strikes and manpower.

  Booby-trapped houses happen by themselves.
- **Concealment:** scrub and screens hide you; firing gives you away for 4 s.
- **Retreat (T)** goes to the cave. **Reinforce (Y)** at the cave, a refuge or a mule.

**Gaps:**
- no HOLD FIRE for the player;
- no tripwires;
- the French training is French-only in ~20 places;
- the reinforce button checks the French purse (a bug).

## 2. The map — LE MAQUIS (`?map=maquis`, new)

Small and readable like the French camp (~330 m), but the FLN's country: a **djebel valley**.

- **North:** the CAVE in a rock face, the maquis camp in front of it (tents, a cooking fire).
- **A mule track** winds down from the camp through **scrub** (the concealment lessons) and past a
  **rocky knoll** (the ambush spot).
- **A small mechta** in the valley (the village = supplies).
- **The road** across the valley's south, **telegraph poles** along it: the convoys come along it.
- **A French post** far off in the south, out of the box (only seen; never attacked here).

Built by its own level tool (as `algTrainingLevel.mjs`); the Oued Abdi recipe (calm ground, sandstone, our
decals) at the training's scale.

## 3. The lessons

Each one: a panel at the top (what to do, its keys); it moves on once DONE. The French's enemies are the
lessons' own (no French AI).

| # | Lesson | What you do | Done when |
|---|---|---|---|
| 1 | The camera | ZQSD / WASD, A / E, the wheel | moved, turned, zoomed |
| 2 | Select, move | click a faoudj, right-click to the marker by the camp | men on it |
| 3 | **Hide** | lead the faoudj into the scrub; V shows concealment (cyan). A French patrol walks past | the patrol passes without seeing you |
| 4 | **Hold fire** (NEW) | H holds fire. Wait until the patrol is close | hold fire on, the patrol within 30 m |
| 5 | **The ambush** | release fire. Firing gives you away for 4 s | the patrol down |
| 6 | **Hit and run** | a half-track comes: run (T) to the cave, then reinforce (Y) | squad back at the cave, full |
| 7 | **The village** | take the mechta: it pays you supplies, no link needed | the mechta held, supplies coming in |
| 8 | **The cave** | train a faoudj, then the FM team | both out |
| 9 | **Build** | a faoudj builds a SANGAR on the knoll, then an AMBUSH SCREEN in front of it | both standing |
| 10 | **The arms cache** | build a cache in the scrub: +15/min, and it opens the BAZOOKA (U) | a faoudj with a bazooka |
| 11 | **Forward** | build a REFUGE near the road; or bring the MULE: reinforce there, far from the cave | a squad reinforced at the refuge or mule |
| 12 | **Sabotage** | cut the TELEGRAPH line (J): no French air support while it's down | a pole down |
| 13 | **The mine** | plant a mine (X) on the road; a French jeep drives onto it | the jeep destroyed |
| 14 | **The command mine** | plant one with its wire (I), wait, FIRE (L) when the truck is on it | the truck destroyed |
| 15 | **Armour** | a half-track: don't fight it with rifles; the bazooka from cover, or go to ground | the half-track destroyed, or the faoudj safe in the scrub |
| 16 | **FINAL: the convoy** | two trucks and an escorting half-track come down the road. Set the ambush: mines, the knoll, the screen, hold fire, then everything at once | the convoy destroyed (or stopped), your men alive |

## 4. What has to be built for it

1. **HOLD FIRE for the player** (any side; the FLN's ambushes need it most): a button and a key (H is STOP today
   → a free key, e.g. **B**? to decide), a "holding fire" mark over the squad; units still return fire if fired
   upon (CoH).
2. **`algTutorialFln.js`**, the FLN's lessons, sharing the French one's helpers (the panel, markers,
   target spawns): the French file stays as it is.
3. **The maquis map:** `maps/maquis.js` + `tools/algMaquisLevel.mjs` → `public/levels/alg-maquis.v3proj`: the
   human is the FLN there, no French AI, no French start army (it spawns today whatever the side).
4. **Scripted French:** a foot patrol on a path, a jeep, a truck, a half-track, the convoy — driving the road
   and reacting when hit (the shared units' orders, no AI).
5. **The menu:** Training → French camp / FLN maquis.
6. **The bug:** the reinforce button reads the French purse for an FLN player.
7. **All text FR + EN** (t()).

Order: the map → hold fire → the lessons 1-8 → you play them → 9-16 → the final.

## 5. Decided (2026-10-20, you: "make the best you think, always think Company of Heroes and nice play")

- **13 lessons, not 16** (CoH's pace: one idea a step, fighting early):
  1. the camera + select / move;
  2. hide;
  3. hold fire → the ambush (one lesson: hold, wait, open up);
  4. hit and run;
  5. the village;
  6. the cave;
  7. build;
  8. the arms cache;
  9. forward (refuge / mule);
  10. sabotage (cut the line + the mine under the jeep);
  11. the command mine;
  12. armour;
  13. the convoy.
- **HOLD FIRE for both sides** (CoH 3: every unit has it): a toggle on every infantry / team card, a mark over the
  squad, return fire if fired upon. Key **Shift+H** (every single letter is taken; H is Stop — hold fire is a
  stronger stop).
- **No tripwires:** mine, command mine and the line are three clear tools.
- **The final:** win = the convoy destroyed (two trucks + the half-track). THREE STARS at the end (CoH): the
  convoy · no squad lost · no French vehicle escaped.
