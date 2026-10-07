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
  smoke: "smoke", barrage: "barrage", airStrike: "barrage", flare: "flare", lmg: "lmg", aimArc: "mgNest", retreat: "retreat", reinforce: "reinforce", repair: "repair", garrison: "garrison", unload: "unload",
  // veterancy chevrons (1-3) and the alert feed's pictures
  vet1: "vet1", vet2: "vet2", vet3: "vet3",
  alertAttack: "alertAttack", alertSeen: "alertSeen", alertCut: "alertCut", alertFlag: "alertFlag", alertMine: "alertMine",
};
export const HOTKEY = { patrol: "P", grenade: "G", smoke: "B", stop: "H", focus: "F", cutWire: "X", cancelSite: "Del", retreat: "T", reinforce: "Y", lmg: "U", barrage: "M", airStrike: "L", repair: "J", unload: "K", aimArc: "O" };

const BASE = "/textures/ui/icons/";
/** An icon element's inline style (a mask in the current colour). */
export const iconStyle = (key) => {
  const url = `${BASE}${ICON[key] ?? key}.svg`;
  return `-webkit-mask-image:url(${url});mask-image:url(${url})`;
};
/** Does the HUD have an icon for this key? */
export const hasIcon = (key) => key in ICON;
