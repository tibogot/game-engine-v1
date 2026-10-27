# The HUD against Company of Heroes 3 — what differs, what I'd change

2026-10-27, after the resources and doctrine fix (eb26b875). Compared from your CoH 3 screenshot (a vehicle selected),
`assets-src/refs/coh3/camera-default-1.png` (a building selected) and `point-captured-blue.png`, against ours in
`?map=auresNew` with a squad selected.

**Decided 2026-10-27** (you: "make what you think is the best for UX/UI and that a Company of Heroes player won't
miss"): 1, 2, 4, 5, 6, 7 DONE as written; 3 DONE as the group number over each tab (the shield icon left out: a 62 px
portrait had no room for it beside its state, count and chevrons — the number is what ties a tab to its badge);
9: our portraits kept; 8: grid keys as an OPTION (the letters stay the default, as CoH 2's classic keys) — to do.

Already like CoH 3, nothing to do: the minimap's corner, the score bar at the top, the alerts above the minimap,
the resources on the command card's strip, the folded doctrine button, the capture point's ring and its "+N".

## Worth doing (most to least)

1. [ ] **The unit card says what the unit IS.** CoH 3 puts a yellow **role line** under the name ("Light Vehicle /
   Anti-infantry / Recon"), the **veterancy stars and an XP bar** ("XP 582/800"), and the **upgrades** under the
   portrait. Ours shows the name, health pips and "RIFLES · 5.5 M/S" only — the role and the veterancy are nowhere on
   the card (the stars only show on the squad's tab and its badge). I'd add the role line, the stars with the XP bar,
   and the upgrade icons we already draw on the tabs (FM, bazooka, radio).

2. [ ] **The squad badge over the field shows its state.** CoH 3's badge carries the **control-group number** above
   it, the **veterancy** and small **state icons** beside it (red for suppressed or pinned, a cover shield). Ours has
   the shield, the head count, the health bar and the chevrons — but not the group number, and no state: you see a
   squad is pinned only on its tab at the bottom. I'd add the group number (from Ctrl+1…9) above the shield, and a
   small icon beside it: pinned (red), suppressed (amber), in cover (green / yellow shield).

3. [ ] **The squad cards match the field.** CoH 3's cards at the bottom are the **same shield icons** as the badges
   over the units, with the group number and stars — you find a squad on the field from its card at a glance. Ours
   are portraits (they look good, and say more), but nothing ties a card to its badge. I'd keep the portraits and add
   the unit's shield in a corner and its group number on top.

4. [ ] **The control-group chips** sit above the command card, on the right — where the doctrine button is now.
   I'd check the two never overlap, and move the chips onto the squad cards (item 3: the number on the card) so the
   separate row can go.

5. [ ] **Select-all buttons by the minimap.** CoH 3 has round buttons under its minimap: all infantry, all vehicles
   (and the tactical map). Ours has none (only the keys). I'd add three: all infantry, all vehicles, idle sappers.

6. [ ] **The match clock under the score bar** (CoH 3: "08:09" centred under it). Ours is in the objectives' header,
   top left. A move.

7. [ ] **Alerts on one line.** CoH 3: a round icon and one short line ("Construction Completed!"). Ours carry a
   timestamp and wrap to two lines. I'd drop the timestamp and keep them to one line, the icon on the left.

## To decide (not obviously better)

8. [ ] **The command card's hotkeys.** CoH 3 lays its orders on a **4 × 3 grid** whose keys follow the keyboard
   (QWER / ASDF / ZXCV — on your AZERTY, AZER / QSDF / WXCV by key position), plus a row of **tabs** for the build
   menu (base, infantry, defences, vehicles) when a builder is selected. Ours: 5 columns, a letter per order chosen
   by its name (H stop, F binoculars, G grenade…). The grid is faster once learned and is what CoH players expect;
   the letters are easier to learn. Your call — or both, an option.

9. [ ] **Squad cards as type icons instead of portraits** (CoH 3's choice). I'd keep our portraits — they are our
   look, and item 3 ties them to the field — unless you prefer CoH's.
