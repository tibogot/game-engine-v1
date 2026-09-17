/**
 * EVERY OBJECT LAYER IN THE ENGINE AND ITS GAMES, IN ONE TABLE.
 *
 * three has 32 layers and no allocator, so two systems that each picked a
 * "free" number never find out they share it. That happened: the per-cascade
 * prop shadow lists took layers 1-4 while modular-road-v3 already had its
 * reflection on 1, its pre-mirrored geometry on 2 and its rain colliders on 3.
 * A shadow-list copy of a prop would have rendered into the wet-road mirror,
 * un-mirrored, and stopped rain.
 *
 * Two ways a layer is used, and they matter when picking one:
 *   ENABLE — the object stays on 0 as well and ALSO shows up in a special pass
 *            (reflection content, rain colliders). Harmless to other passes.
 *   SET    — the object lives ONLY on that layer and must never be drawn by the
 *            main camera (pre-mirrored geometry, cloud domes, shadow lists).
 *            Any camera that enables a SET layer draws those objects, so two
 *            systems must never share one.
 *
 * Also note three's ShadowNode: a shadow camera with NO layer above 0 copies
 * the MAIN camera's mask for the pass. Enabling any layer on a cascade camera
 * switches that copy off.
 *
 * Add a layer here, never as a literal in a module. tools/layerRegistryTest.mjs
 * fails on duplicates and on a `layers.set/enable/disable(<number>)` anywhere
 * under v3/ or games/.
 */
export const LAYERS = Object.freeze({
  /** Everything the main camera draws. */
  DEFAULT: 0,

  // modular-road-v3 (the names say what the pass is, not which game)
  /** ENABLE: content of the planar car/road reflection pass. */
  REFLECT: 1,
  /** SET: geometry already mirrored about the deck, drawn by the real camera. */
  PREMIRROR: 2,
  /** ENABLE: surfaces the world rain collides with (top-down depth pass). */
  RAIN_COLLIDER: 3,

  /** SET: per-cascade prop shadow lists, cascade i on SHADOW_CASCADE_BASE + i. */
  SHADOW_CASCADE_BASE: 4,

  /** SET: the engine's day/night cloud deck (dayNightCloudLayer.js). */
  CLOUD_DECK: 18,
  /** SET: modular-road-v3's volumetric cloud dome (modularRoadClouds.js). */
  GAME_CLOUDS: 19,
});

/** How many cascades have a shadow-list layer reserved (4-7). */
export const MAX_SHADOW_CASCADE_LAYERS = 4;

/** The layer cascade `i`'s shadow list lives on. */
export function shadowCascadeLayer(i) {
  if (!(i >= 0 && i < MAX_SHADOW_CASCADE_LAYERS)) {
    throw new RangeError(`shadow cascade ${i} has no reserved layer (max ${MAX_SHADOW_CASCADE_LAYERS})`);
  }
  return LAYERS.SHADOW_CASCADE_BASE + i;
}
