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
};
export const HOTKEY = { patrol: "P", grenade: "G", stop: "H", focus: "F", cutWire: "X", cancelSite: "Del" };

const BASE = "/textures/ui/icons/";
/** An icon element's inline style (a mask in the current colour). */
export const iconStyle = (key) => {
  const url = `${BASE}${ICON[key] ?? key}.svg`;
  return `-webkit-mask-image:url(${url});mask-image:url(${url})`;
};
/** Does the HUD have an icon for this key? */
export const hasIcon = (key) => key in ICON;
