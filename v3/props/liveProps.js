// Re-export v2's production-quality live prop factories directly.
// v2/core/props/flagFactory.js  → real Verlet cloth simulation flag
// v2/core/props/collectibleFactory.js → glow-material coin/heart/key with shared geometry
export { createFlagProp as createFlag } from "../../v2/core/props/flagFactory.js";
export {
  createCoinProp  as createCoin,
  createHeartProp as createHeart,
  createKeyProp   as createKey,
  registerGlbCollectibleKind,
  COLLECTIBLE_KINDS,
} from "../../v2/core/props/collectibleFactory.js";
