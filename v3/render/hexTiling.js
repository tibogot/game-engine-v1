/**
 * HEX TILING, for a game's own ground — a texture sampled with no repeat grid (the terrain's: Mikkelsen's hex tiling,
 * v3/terrain/splatOverlayTsl.js hexSample). Public so a game's flat grounds (a lab's floor, a set piece's yard) lose
 * their tile the way the terrain does, without reaching into the terrain's internals (2026-10-25: the alg-rts lab's
 * ground, "the terrain texture is tiling … even if it's a lab it will look better").
 *
 *   import { hexSample } from "../../v3/render/hexTiling.js";
 *   material.colorNode = hexSample(texture(map), uv().mul(160), null, { rotate: false }).rgb;
 */
export { hexSample } from "../terrain/splatOverlayTsl.js";
