// THE RENDERED ICONS (2026-10-22 — you: "our assets are really good looking now, a thumbnail of them would look
// cool"): the command card's pictures, RENDERED from the game's own models (iconStudio.js, icon-studio.html → its
// saveAtlas()), one 96 px tile per key in public/textures/ui/icons/rendered.webp, 8 a row. The orders and the abilities
// still without a model: their silhouette as a brass symbol on the same tile. Regenerate both from the studio.
const KEYS = ["patrol", "grenade", "stop", "focus", "cutWire", "cancelSite", "tier", "sandbags", "wire", "mgNest", "mortarPit",
  "mirador", "searchlight", "sangar", "ambushScreen", "smoke", "barrage", "airStrike", "flare", "lmg", "bazooka", "radio",
  "radioBarrage", "radioAir", "aimArc", "retreat", "reinforce", "repair", "garrison", "unload", "transport", "disembark",
  "attackMove", "holdFire", "reverse", "forwardPost", "aidStation", "fortPoint", "flnMine", "flnWire", "flnDetonate", "flnCut",
  "armsCache", "refuge", "infirmary", "mortarBarrage"];
const COLS = 8, ROWS = Math.ceil(KEYS.length / COLS);
const URL_ = "/textures/ui/icons/rendered.webp";
const AT = new Map(KEYS.map((k, i) => [k, i]));

/** Has `key` a rendered tile? */
export const hasRendered = (key) => AT.has(key);
/** The tile's inline style (a CSS sprite: the atlas scaled to the element, its cell shown). */
export function renderedStyle(key) {
  const i = AT.get(key);
  if (i == null) return "";
  const c = i % COLS, r = Math.floor(i / COLS);
  return `background-image:url(${URL_});background-size:${COLS * 100}% ${ROWS * 100}%;`
    + `background-position:${(c / (COLS - 1)) * 100}% ${(r / (ROWS - 1)) * 100}%`;
}
