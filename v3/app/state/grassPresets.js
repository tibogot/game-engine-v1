/**
 * Grass look presets — one grass system, two art directions.
 *
 * The hybrid grass was built to match Ghost of Tsushima: separate blades with
 * real ambient occlusion at the root, per-blade brightness scatter, back-lit
 * translucency, seven segments of curve. A stylised field (Genshin Impact,
 * Breath of the Wild) is the SAME blades with that realism turned down: the
 * blade takes the ground's colour, the shading scatter goes flat, the AO stops
 * darkening the roots, and the blades get simpler and wider.
 *
 * So a preset is only a set of values for the Grass panel. Nothing here is a
 * separate code path, and anything can be tweaked after applying one.
 *
 * Only LOOK keys belong here: never painted density, painted height or a view
 * toggle like lodDebug. Applied through mergeKnownKeys, so a key that this
 * build no longer has is ignored rather than resurrected.
 */

export const GRASS_PRESETS = {
  got: {
    label: "Ghost of Tsushima",
    hint: "Realistic: root AO, per-blade shade, back-lit tips, 7 segments.",
    values: {
      bladeHeight: 1, bladeWidth: 0.15, bladeYSegments: 7, tipTaperStart: 0.5,
      crossed: true, foldBelow: 1.1,
      bendFocus: 0.5, stiffness: 0, maxAngle: 1.4, naturalLean: 0.9,
      windSpeed: 0.2, windStrength: 1.4, windGust: 0.3, windWaveScale: 0.12,
      clumpScale: 1.5, clumpStrength: 0.7, clumpPull: 0,
      bladeColor: "#0e300e", tipColor: "#00b30c",
      aoBase: 0.25, aoPower: 2, farAoMul: 1, shadeVariation: 1,
      colorVariation: false,
      skyBlend: 0.8, cylindrical: 0.3, viewThicken: 0.45,
      bssColor: "#2d7a2d", bssIntensity: 1.2, bssPower: 2,
      frontScatter: 0.3, rimSSS: 0.25,
      terrainTintEnabled: false, terrainTintStrength: 0.5, terrainTintRootBias: 0.35,
      lodMidSegments: 3, lodFarSegments: 2, lodMegaSegments: 2,
      lodFarBladeWidth: 0.45, lodMegaBladeWidth: 0.5,
      farBlades: false,
    },
  },

  genshin: {
    label: "Genshin / Zelda",
    hint: "Stylised: blades take the ground colour, flat shading, wide simple blades.",
    values: {
      // Fewer, wider, flatter blades — the stylised silhouette.
      bladeHeight: 1, bladeWidth: 0.22, bladeYSegments: 3, tipTaperStart: 0.55,
      crossed: true, foldBelow: 1.5,
      bendFocus: 0.55, stiffness: 0.1, maxAngle: 1.2, naturalLean: 0.7,
      // Calmer, more uniform motion: stylised fields sway, they do not thrash.
      windSpeed: 0.18, windStrength: 1.1, windGust: 0.2, windWaveScale: 0.1,
      // Broader, softer clumps with a little bunching.
      clumpScale: 2.2, clumpStrength: 0.5, clumpPull: 0.15,
      // The ground drives the colour (tint at full takeover), so these are
      // only what shows through at the tips.
      bladeColor: "#3f9e3a", tipColor: "#67c94f",
      aoBase: 0.8, aoPower: 1.6, farAoMul: 1, shadeVariation: 0.2,
      colorVariation: false,
      // Lit like the ground under it, and kept camera-facing.
      skyBlend: 1, cylindrical: 0.45, viewThicken: 0.5,
      // Barely any back-lit translucency: the stylised look is flat, not glowy.
      bssColor: "#8ed17a", bssIntensity: 0.45, bssPower: 2,
      frontScatter: 0.15, rimSSS: 0.1,
      terrainTintEnabled: true, terrainTintStrength: 1, terrainTintRootBias: 0.12,
      lodMidSegments: 2, lodFarSegments: 2, lodMegaSegments: 2,
      lodFarBladeWidth: 0.5, lodMegaBladeWidth: 0.55,
      farBlades: false,
    },
  },
};
