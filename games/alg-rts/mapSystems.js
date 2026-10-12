// WHAT EACH MAP SHOWS (2026-10-12, the cleanup — you: "the training map is built like the game
// map minus different things"). Every map LISTS the systems it wants (maps/*.js `systems`); one it
// does not list stays OFF — a new map starts bare instead of inheriting the Aurès' farmsteads,
// fields and herds and having to switch them off one by one (the training's old OFF list).
//
// algGame.js writes the ones off into the address as `key=0`, so every module that reads its
// switch sees it; the address still wins (?herds=1 brings herds back to a map without them).
//
//   landmarks  the Aurès' farmsteads, ruins, outcrops, lone trees (algLandmarks; a map's own
//              rocks and trees are its `scenery`, maps/training.js)
//   fields     the villages' fields, walls and hedges (algFields)
//   herds      the flocks (algHerds)                    hens      the hens (algHens)
//   life       haystacks, firewood, ovens, beehives by the villages (algVillageLife)
//   poles      the telegraph line (algPoles)
//   ai         the FLN's AI (algAI; the training's lessons bring their own enemies)
//   fow        the fog of war
//   birds      the birds                                civ       the villagers (algCivilians)
//   splats     the ground splats (algSplats)            stones    the scattered stones (algStones)
//   macro      the ground's macro photo (algMacroGround)

/** Every per-map switch. The first eight in the order the training wrote them (its address unchanged). */
export const SYSTEM_KEYS = [
  "landmarks", "fields", "herds", "hens", "life", "poles", "ai", "fow",
  "birds", "splats", "macro", "stones", "civ",
];

/** The switches a map does NOT list as on, in SYSTEM_KEYS' order. */
export function systemsOff(map) {
  const s = map?.systems ?? {};
  return SYSTEM_KEYS.filter((k) => s[k] !== true);
}
