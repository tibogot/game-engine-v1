// Live (animated) props that still need one THREE.Group per instance.
// v2/core/props/flagFactory.js → real Verlet cloth simulation flag
//
// Collectibles are NOT here: coin/heart/key/GLB collectibles are GPU-instanced by
// props/collectibles.js + props/collectibleField.js, one draw call per kind.
export { createFlagProp as createFlag } from "../../v2/core/props/flagFactory.js";
