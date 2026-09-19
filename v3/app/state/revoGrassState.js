/**
 * Revo grass — the settings for the SECOND grass system.
 *
 * The hybrid rings and this are not two looks of one system, which is what the
 * Grass panel's Preset dropdown is for (state/grassPresets.js). They are two
 * engines: the hybrid grass draws separate lit blades in concentric LOD rings,
 * and this draws one camera-following tile of small camera-facing blades,
 * every one of them the same shape, leaning on density rather than on detail.
 * Ghost of Tsushima against a fluffy stylised meadow — which one a world wants
 * depends on the game, so the system is a choice, not a preset.
 *
 * Named after alezen9/revo-realms (MIT), whose vegetation this follows: the
 * jittered grid in a wrapping tile, the stochastic thinning with distance, the
 * packed noise atlas driving the wind, and the base-to-tip colour ramp.
 */

/** Grid side presets. count = side², over `tileSize` metres. */
export const REVO_GRASS_QUALITY = {
  balanced: { bladesPerSide: 384, label: "Balanced (147k)" },
  high:     { bladesPerSide: 512, label: "High (262k)" },
  ultra:    { bladesPerSide: 768, label: "Ultra (590k)" },
};

export const REVO_GRASS_DEFAULTS = {
  preset: "openWorld",    // which camera style was last applied (see below)
  quality: "high",
  // 90 m of tile at 512² is ~32 blades per square metre. The original's 130 m
  // is only 15, which for a system whose whole argument is density reads as a
  // thin lawn — and half of those blades stand beyond where the field has
  // thinned out anyway. Reach is what the hybrid rings are for.
  tileSize: 90,           // metres the tile covers, centred on the player
  segments: 4,            // rows of the blade strip (vertex count = 2n+1)
  bladeHeight: 1.1,
  bladeWidth: 0.07,
  bladeMinScale: 0.75,
  bladeMaxScale: 1.9,
  clumpStrength: 0.35,    // 0 = every blade its own size, 1 = tight patches
  clumpScale: 2.0,        // metres per clump cell
  density: 1,             // multiplies the painted density

  // Stochastic thinning: full density inside fadeStart, `fadeKeep` of it by
  // fadeEnd. Distance is where this system spends its blades, so this is the
  // cost dial as much as the look one.
  fadeStart: 16,
  fadeEnd: 44,
  fadeKeep: 0.15,

  // How fast the gust pattern travels over the field, not how fast a blade
  // moves: ~3 m/s here, a breeze you can watch cross the meadow.
  windSpeed: 0.6,
  windStrength: 0.4,
  // Gust is a RAMP from the calm strength to a full gale, so 1 means the field
  // is permanently at its hardest blow — which is what the original shipped
  // and it reads as a storm, not as weather. A third of the way up is a
  // breeze you can watch.
  windIntensity: 0.4,
  windAngle: 0,
  windScale: 1.75,        // metres per noise wave (bigger = broader gusts)

  baseColor: "#3d4f1c",
  tipColor: "#8fb84a",
  colorMix: 0.55,         // how far up the blade the tip colour reaches
  colorVariation: 2.75,   // per-blade brightness scatter
  windColor: 0.6,         // how much a gust lightens the blades it moves
  brightness: 1,

  aoScale: 0.5,           // root darkening near the camera
  aoRadius: 25,
  baseWindShade: 0.75,
  baseShadeHeight: 1,
  bend: 1.2,              // how far the blade leans under wind and push
  lean: 0.3,              // the resting lean each blade keeps with no wind at all

  // Blade width never falls below this many pixels: past that distance the
  // blade grows in world space instead. A sub-pixel triangle does not fade,
  // it crawls, and a field of them shimmers even standing still.
  minPixels: 1.4,

  pushBend: 1,            // how hard the push field lays blades over
  crushMin: 0.35,         // shortest a fully crushed blade gets, as a fraction

  // 0 = the blade keeps its own up (right for a camera standing in the
  // field), 1 = it rolls over to show its face to the camera, which is what
  // an RTS camera looking DOWN the blade needs. Driven by the camera's
  // elevation over each blade, so a ground camera is left alone whatever this
  // says — there is no separate RTS mode to switch.
  faceCamera: 0,
  receiveShadow: true,
};

/**
 * Two camera styles, as sets of the values above — the same idea as the
 * hybrid grass's art-direction presets (app/state/grassPresets.js). Nothing
 * here is a code path, and every control stays editable after applying one.
 */
export const REVO_GRASS_PRESETS = {
  openWorld: {
    label: "Open world (camera in the grass)",
    hint: "Upright blades, reach and silhouette. What you are looking at is the field's horizon.",
    values: {
      faceCamera: 0, bladeHeight: 1.1, bladeWidth: 0.07, lean: 0.3,
      tileSize: 90, fadeStart: 16, fadeEnd: 44, fadeKeep: 0.15,
      clumpStrength: 0.35, clumpScale: 2, minPixels: 1.4,
    },
  },
  rts: {
    label: "Top-down (RTS camera)",
    hint: "Blades roll to show their faces, wider and shorter, spent close in: from up there you read the field, not the blades.",
    values: {
      // Face fully: from an RTS camera an upright blade is an edge.
      faceCamera: 1,
      // A blade seen from above reads as its AREA, so it wants width, and its
      // height is what you cannot see — lower it and the field stops looking
      // like a lawn made of spikes.
      bladeHeight: 0.8, bladeWidth: 0.11, lean: 0.35,
      // You see less distance from up there, so the blades are spent closer in
      // and the near field gets denser for the same cost.
      tileSize: 60, fadeStart: 14, fadeEnd: 34, fadeKeep: 0.2,
      // Clumps are most of the texture of a field seen from above.
      clumpStrength: 0.55, clumpScale: 2.6, minPixels: 1.4,
    },
  },
};

/** Changing one of these rebuilds the mesh and the buffers, not just uniforms. */
export const REVO_GRASS_GEOMETRY_KEYS = [
  "quality", "tileSize", "segments", "bladeHeight", "bladeWidth",
];

export function createRevoGrassState() {
  return { ...REVO_GRASS_DEFAULTS };
}

/** Panel values → the numbers the system builds from. */
export function revoGrassConfig(rp) {
  const bladesPerSide = REVO_GRASS_QUALITY[rp.quality]?.bladesPerSide
    ?? REVO_GRASS_QUALITY.high.bladesPerSide;
  const tileSize = Math.max(20, rp.tileSize ?? REVO_GRASS_DEFAULTS.tileSize);
  const segments = Math.max(1, Math.min(8, Math.floor(rp.segments ?? 4)));
  const bladeHeight = rp.bladeHeight ?? REVO_GRASS_DEFAULTS.bladeHeight;
  const bladeWidth = rp.bladeWidth ?? REVO_GRASS_DEFAULTS.bladeWidth;
  return {
    bladesPerSide,
    count: bladesPerSide * bladesPerSide,
    tileSize,
    tileHalfSize: tileSize * 0.5,
    spacing: tileSize / bladesPerSide,
    segments,
    bladeHeight,
    bladeWidth,
    workgroupSize: 64,
  };
}
