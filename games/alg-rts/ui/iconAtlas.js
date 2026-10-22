// THE RENDERED ICONS (2026-10-22 — you: "our assets are really good looking now, a thumbnail of them would look
// cool"): the command card's pictures, RENDERED from the game's own models (iconStudio.js, icon-studio.html → its
// saveAtlas()), one 96 px tile per key in public/textures/ui/icons/rendered.webp, 8 a row. The orders and the abilities
// still without a model: their silhouette as a brass symbol on the same tile. Regenerate both from the studio.
export const KEYS = ["patrol", "grenade", "stop", "focus", "cutWire", "cancelSite", "tier", "sandbags", "wire", "mgNest", "mortarPit",
  "mirador", "searchlight", "sangar", "ambushScreen", "smoke", "barrage", "airStrike", "flare", "lmg", "bazooka", "radio",
  "radioBarrage", "radioAir", "aimArc", "retreat", "reinforce", "repair", "garrison", "unload", "transport", "disembark",
  "attackMove", "holdFire", "reverse", "forwardPost", "aidStation", "fortPoint", "flnMine", "flnWire", "flnDetonate", "flnCut",
  "armsCache", "refuge", "infirmary", "mortarBarrage",
  // the doctrines' abilities (algDoctrines.js) and the resources (ui/resourceHud.js) — 2026-10-22
  "paraDrop", "commando", "airSupply", "eliteParas", "legionCall", "legionEngineers", "mortar120", "espritCorps", "douar", "informers", "saboteurs",
  "jeep", "mortar81", "borderArms", "outsideSection", "advisers", "recon", "t6Pair", "medevac", "gunship", "resMp", "resMun", "resFuel",
  // the squads' weapon badges (ui/armyTabs.js — CoH's upgrade marks on the unit card), no tile
  "badgeLmg", "badgeBazooka", "badgeRadio", "badgeFlamer", "badgeSniper",
  // the veterancy chevrons (brass symbols, no tile) and the alert feed's pictures (ui/battleHud.js)
  "vet1", "vet2", "vet3", "alertMine", "alertCut", "alertAttack", "alertSeen", "alertFlag"];
/**
 * THE COLOUR CODE (2026-10-22, you: "do the full colour coding for the orders" — Company of Heroes' card): each key's
 * CATEGORY, its tile's backdrop baked into the atlas (iconStudio): orders blue-grey, attack orders and call-ins orange,
 * retreat red, abilities dark, construction olive, upgrades brass. The glyphs: cream on a coloured tile, brass on a dark.
 */
export const CATEGORY = {
  stop: "order", focus: "order", patrol: "order", holdFire: "order", reverse: "order", garrison: "order", unload: "order", disembark: "order", transport: "order", cancelSite: "order",
  attackMove: "attack", aimArc: "attack", barrage: "attack", airStrike: "attack", radioBarrage: "attack", radioAir: "attack", mortarBarrage: "attack", flnDetonate: "attack",
  retreat: "retreat",
  paraDrop: "attack", airSupply: "attack", legionCall: "attack", mortar120: "attack", douar: "attack", informers: "attack", jeep: "attack", mortar81: "attack",
  outsideSection: "attack", recon: "attack", t6Pair: "attack", medevac: "attack", gunship: "attack", commando: "attack",
  eliteParas: "upgrade", legionEngineers: "upgrade", espritCorps: "upgrade", saboteurs: "upgrade", borderArms: "upgrade", advisers: "upgrade",
  reinforce: "upgrade", tier: "upgrade",
  resMp: "bare", resMun: "bare", resFuel: "bare",
  badgeLmg: "bare", badgeBazooka: "bare", badgeRadio: "bare", badgeFlamer: "bare", badgeSniper: "bare",
  vet1: "bare", vet2: "bare", vet3: "bare", alertAttack: "attack", alertFlag: "order",
  sandbags: "build", wire: "build", mgNest: "build", mortarPit: "build", mirador: "build", searchlight: "build", forwardPost: "build", aidStation: "build", fortPoint: "build",
  sangar: "build", ambushScreen: "build", armsCache: "build", refuge: "build", infirmary: "build",
};
/** Each category's tile: its glow (centre), its edge, the glyph's two tones. */
export const PALETTE = {
  order: ["#3e5468", "#121a22", "#f4ecd8", "#c9d4dc"], attack: ["#a35a1a", "#2a1407", "#fff0d0", "#f2c27a"],
  retreat: ["#a82a1c", "#2c0806", "#fff0e4", "#f3b8a8"], upgrade: ["#8a6a24", "#251a07", "#fff4d0", "#f1d58a"],
  build: ["#4a5030", "#14160d", "#ffe3a3", "#d9a43c"], ability: ["#3a2e1f", "#0a0806", "#ffe3a3", "#d9a43c"],
};
const COLS = 8, ROWS = Math.ceil(KEYS.length / COLS);
const URL_ = "/textures/ui/icons/rendered.webp";
const AT = new Map(KEYS.map((k, i) => [k, i]));

/** The rendered tile on an element that was styled as a MASK (ui/icons.js iconStyle): the mask and its colour cleared. */
export const renderedOnly = (key) => `${renderedStyle(key)};background-color:transparent;-webkit-mask-image:none;mask-image:none`;

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
