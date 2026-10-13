// THE HUD'S ICONS — game-icons.net silhouettes (CC BY 3.0: Lorc, Delapouite,
// Skoll, Quoting — credited in public/textures/ui/icons/CREDITS.md), one SVG
// each in public/textures/ui/icons/, the black square stripped: drawn as a CSS
// MASK, so every icon takes the HUD's colour (brass, dim, red) from CSS.
//
// HOTKEYS: mnemonic, and clear of the camera (WASD / ZQSD by position, Q/E,
// the arrows, C) and of R (turn a building being placed). Matched on the
// PRINTED key (e.key), so they are the same letters on AZERTY.
export const ICON = {
  patrol: "patrol", grenade: "grenade", stop: "stop", focus: "focus", cutWire: "cutWire",
  cancelSite: "cancelSite", tier: "tier",
  sandbags: "sandbags", wire: "wire", mgNest: "mgNest", mortarPit: "mortarPit",
  mirador: "mirador", searchlight: "searchlight", sangar: "sangar", ambushScreen: "ambushScreen",
  // 2026-10-04 (you: "compare with CoH" — every ability has its picture there)
  smoke: "smoke", barrage: "barrage", airStrike: "barrage", flare: "flare", lmg: "lmg", radio: "alertSeen", radioBarrage: "barrage", radioAir: "barrage", aimArc: "mgNest", retreat: "retreat", reinforce: "reinforce", repair: "repair", garrison: "garrison", unload: "unload",
  // 2026-10-08: the transports (algTransports.js) — the badge's truck (drawn here, ours), DÉBARQUER as SORTIR
  transport: "transport", disembark: "unload",
  attackMove: "alertAttack",
  // field works (algFieldWorks.js): existing silhouettes
  forwardPost: "reinforce", aidStation: "repair", fortPoint: "alertFlag",
  // veterancy chevrons (1-3) and the alert feed's pictures
  vet1: "vet1", vet2: "vet2", vet3: "vet3",
  alertAttack: "alertAttack", alertSeen: "alertSeen", alertCut: "alertCut", alertFlag: "alertFlag", alertMine: "alertMine",
  // PLAYING THE FLN (2026-10-13): its sabotage (algFlnTricks.js) and its pieces (algBuild.js), existing silhouettes
  flnMine: "alertMine", flnCut: "alertCut", armsCache: "lmg", refuge: "garrison", infirmary: "repair", mortarBarrage: "barrage",
};
export const HOTKEY = { patrol: "P", grenade: "G", smoke: "B", stop: "H", focus: "F", cutWire: "X", cancelSite: "Del", retreat: "T", reinforce: "Y", lmg: "U", radio: "I", radioBarrage: "M", radioAir: "L", barrage: "M", airStrike: "L", repair: "J", unload: "K", disembark: "K", aimArc: "O", attackMove: "N", flnMine: "X", flnCut: "J", mortarBarrage: "M" };   // (flnMine / flnCut: the FLN's, on the keys only the French use)

const BASE = "/textures/ui/icons/";
/** An icon element's inline style (a mask in the current colour). */
export const iconStyle = (key) => {
  const url = `${BASE}${ICON[key] ?? key}.svg`;
  return `-webkit-mask-image:url(${url});mask-image:url(${url})`;
};
/** Does the HUD have an icon for this key? */
export const hasIcon = (key) => key in ICON;
