// Every English part, merged (one file per area of the game, so the parts never collide).
import battle from "./battle.js";
import menu from "./menu.js";
import units from "./units.js";
import hud from "./hud.js";
import systems from "./systems.js";

export default { ...battle, ...menu, ...units, ...hud, ...systems };
