/**
 * Painted foliage (ferns and friends) — the plants' look and where they grow.
 *
 * Four types, one painted density channel each, exactly like the flowers. A
 * type is a shape (the geometry builder reads it), a colour, and its rules for
 * where it may grow.
 */

export const FOLIAGE_TYPE_COUNT = 8;

/** Shape keys — changing one of these rebuilds that type's meshes. */
export const FOLIAGE_GEOMETRY_KEYS = [
  "kind", "fronds", "frondLength", "leaflets", "leafletWidth", "leafletAngle", "spread", "arch", "droop", "stemWidth", "bareStalk",
  "plumesPerStem", "plumeSpread",
];

/** Height band that means "no limit" (the full slider range). */
export const FOLIAGE_HEIGHT_ANY = { heightMin: -200, heightMax: 900 };

// Shapes are tuned against a game fern pack: wide low rosettes of arching
// fronds, each with 14-20 separate round-tipped leaflets per side.
export const FOLIAGE_PRESETS = {
  fern: {
    kind: "fern",
    fronds: 9, frondLength: 1.05, leaflets: 18, leafletWidth: 1.0, leafletAngle: 65,
    spread: 0.8, arch: 0.75, droop: 0.2, stemWidth: 1, bareStalk: 0.06,
    colorBase: "#4b7431", colorTip: "#7fa848", colorHead: "#7fa848", size: 2.3, translucency: 0.9,
  },
  ladyFern: {
    kind: "fern",
    fronds: 9, frondLength: 1.05, leaflets: 20, leafletWidth: 0.8, leafletAngle: 56,
    spread: 0.68, arch: 0.95, droop: 0.4, stemWidth: 0.8, bareStalk: 0.2,
    colorBase: "#3b6a2e", colorTip: "#78a446", colorHead: "#78a446", size: 2.5, translucency: 1.0,
  },
  bracken: {
    kind: "fern",
    fronds: 6, frondLength: 1.1, leaflets: 14, leafletWidth: 1.25, leafletAngle: 46,
    spread: 0.6, arch: 0.5, droop: 0.2, stemWidth: 1.3, bareStalk: 0.3,
    colorBase: "#4a6a28", colorTip: "#8ea03e", colorHead: "#8ea03e", size: 3.2, translucency: 0.7,
  },
  undergrowth: {
    kind: "fern",
    fronds: 7, frondLength: 0.65, leaflets: 10, leafletWidth: 1.1, leafletAngle: 60,
    spread: 1.15, arch: 0.9, droop: 0.4, stemWidth: 0.7, bareStalk: 0.12,
    colorBase: "#345826", colorTip: "#6a9138", colorHead: "#6a9138", size: 1.3, translucency: 0.9,
  },
  reeds: {
    kind: "blades",
    fronds: 16, frondLength: 1.1, leaflets: 6, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.3, arch: 1.0, droop: 0.2, stemWidth: 1, bareStalk: 0,
    colorBase: "#5c7a34", colorTip: "#a8b95a", colorHead: "#d8cf7e", size: 1.6, translucency: 1.0,
  },
  bush: {
    kind: "bush",
    fronds: 42, frondLength: 1.25, leaflets: 6, leafletWidth: 1.15, leafletAngle: 60,
    spread: 0.6, arch: 0.6, droop: 0.35, stemWidth: 1, bareStalk: 0,
    colorBase: "#34602c", colorTip: "#6f9a3c", colorHead: "#6f9a3c", size: 1.8, translucency: 0.7,
  },
  typha: {
    kind: "typha",
    fronds: 9, frondLength: 1.2, leaflets: 5, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.2, arch: 0.45, droop: 0.15, stemWidth: 1, bareStalk: 0,
    colorBase: "#4f8a33", colorTip: "#93c25a", colorHead: "#7e3f1f", size: 2.0, translucency: 0.8,
  },
  plumeReed: {
    kind: "plume",
    fronds: 9, frondLength: 1.25, leaflets: 6, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.3, arch: 0.85, droop: 0.4, stemWidth: 0.9, bareStalk: 0,
    colorBase: "#5f9a3a", colorTip: "#9ccb5e", colorHead: "#f2e4a8", size: 2.2, translucency: 1.1,
  },
  pampas: {
    kind: "pampas",
    fronds: 9, frondLength: 1.3, leaflets: 5, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.32, arch: 0.8, droop: 0.45, stemWidth: 0.9, bareStalk: 0,
    colorBase: "#5f9a3a", colorTip: "#9ccb5e", colorHead: "#efe3b0", size: 2.4, translucency: 1.1,
  },
  // Pampas with a fan of plumes per stalk, on stiff cane-like stalks.
  susuki: {
    kind: "susuki",
    fronds: 10, frondLength: 1.2, leaflets: 4, leafletWidth: 1.0, leafletAngle: 60,
    spread: 0.3, arch: 0.8, droop: 0.5, stemWidth: 1.8, bareStalk: 0,
    plumesPerStem: 4, plumeSpread: 22,
    colorBase: "#5f9a3a", colorTip: "#9ccb5e", colorHead: "#f6f1e3", size: 2.2, translucency: 1.1,
  },
  // BAMBOO — a clump of culms, not a rosette (bambooGeometry.js). The shared
  // keys are re-read for it: `fronds` is culms, `leaflets` is internodes,
  // `bareStalk` is the clean lower pole, `plumesPerStem` is leaves per spray.
  // `size` 9 makes it the only foliage type measured in storeys rather than
  // hand-spans, which is also why it wants its own scatter field rather than
  // the 192 m / 95 m-fade one the ground plants share.
  bamboo: {
    kind: "bamboo",
    fronds: 5, frondLength: 1.0, leaflets: 22, leafletWidth: 1.0, leafletAngle: 48,
    spread: 1.0, arch: 0.5, droop: 0.35, stemWidth: 1, bareStalk: 0.5,
    plumesPerStem: 7, plumeSpread: 26,
    colorBase: "#3d6b2b", colorTip: "#7fa63f", colorHead: "#9aac57", size: 9, translucency: 1.1,
  },
  // PALM — a coconut palm (palmGeometry.js). Shared keys re-read: `fronds` is
  // the crown, `leaflets` the trunk's leaf-scar rings, `leafletAngle` the
  // V-fold, `bareStalk` the trunk lean, `plumesPerStem` dead fronds,
  // `plumeSpread` frond length as % of trunk. `size` 11 m.
  palm: {
    kind: "palm",
    fronds: 26, frondLength: 1.0, leaflets: 36, leafletWidth: 1.0, leafletAngle: 32,
    spread: 1.0, arch: 0.9, droop: 0.5, stemWidth: 0.7, bareStalk: 0.12,
    plumesPerStem: 3, plumeSpread: 32,
    colorBase: "#2f6a2a", colorTip: "#8fb43c", colorHead: "#7d6b55", size: 17, translucency: 0.9,
  },
  // ARECA — the betel palm, *cau* (arecaGeometry.js). A CLUMP of very slender
  // ringed canes, each with a small feathery crown and a green crownshaft;
  // the opposite silhouette to the coconut, and the palm of village lanes
  // rather than of beaches. `plumesPerStem` is the cane count, `bareStalk` the
  // crownshaft. `size` 12 m.
  areca: {
    kind: "areca",
    fronds: 8, frondLength: 1.0, leaflets: 20, leafletWidth: 1.0, leafletAngle: 26,
    spread: 1.0, arch: 1.15, droop: 0.45, stemWidth: 1, bareStalk: 0.1,
    plumesPerStem: 4, plumeSpread: 17,
    colorBase: "#2d5c27", colorTip: "#77a340", colorHead: "#b2b6a4", size: 12, translucency: 1.0,
  },
  // JUNGLE TREE — the emergent over a rainforest (jungleTreeGeometry.js).
  // Shared keys re-read: `fronds` is branches, `leaflets` plates per branch,
  // `spread` the crown radius as a fraction of height, `bareStalk` the clean
  // bole, `plumesPerStem` buttress roots, `plumeSpread` their reach in % of
  // height. `size` 26 m — 2.4x the palm beside it, which is the point.
  jungleTree: {
    kind: "jungleTree",
    fronds: 9, frondLength: 1.0, leaflets: 3, leafletWidth: 1.0, leafletAngle: 22,
    spread: 0.34, arch: 0.85, droop: 0.35, stemWidth: 1, bareStalk: 0.62,
    plumesPerStem: 5, plumeSpread: 9,
    colorBase: "#27461f", colorTip: "#5c8235", colorHead: "#6b5a49", size: 26, translucency: 0.85,
  },
  // FAN PALM — the palmate palms (fanPalmGeometry.js): the northern *cọ* and
  // the Mekong sugar palm, *thốt nốt*. The reason it exists is that the
  // coconut and the betel palm are the same plant at different proportions —
  // this one has a different LEAF (a pleated disc, not a feather), a crown
  // that is a ball rather than a plume, and a skirt of dead leaves. `spread`
  // opens the crown, `bareStalk` is the long bare petiole, `plumesPerStem`
  // the skirt. `size` 16 m.
  fanPalm: {
    kind: "fanPalm",
    fronds: 30, frondLength: 1.0, leaflets: 16, leafletWidth: 1.0, leafletAngle: 20,
    spread: 1.0, arch: 0.45, droop: 0.55, stemWidth: 1, bareStalk: 0.32,
    plumesPerStem: 6, plumeSpread: 30,
    colorBase: "#33601f", colorTip: "#86a83a", colorHead: "#6f6553", size: 16, translucency: 0.8,
  },
  // CARD FERNS — the fern rosette drawn with the palm's half-frond cards and a
  // lace fern texture (fernCardGeometry.js). Beside the geometry ferns, not
  // instead of them. `leafletAngle` is the fold (small for a fern).
  cardFern: {
    kind: "cardFern",
    fronds: 12, frondLength: 1.0, leaflets: 18, leafletWidth: 1.0, leafletAngle: 12,
    spread: 0.8, arch: 0.8, droop: 0.3, stemWidth: 1, bareStalk: 0.12,
    colorBase: "#3f6d2c", colorTip: "#8cb84a", colorHead: "#8cb84a", size: 2.0, translucency: 1.0,
  },
  // A big jungle fern, tree-fern scale: more fronds, heavier arch, darker.
  giantFern: {
    kind: "cardFern",
    fronds: 16, frondLength: 1.0, leaflets: 18, leafletWidth: 1.15, leafletAngle: 14,
    spread: 0.75, arch: 1.0, droop: 0.35, stemWidth: 1, bareStalk: 0.12,
    colorBase: "#2f5f27", colorTip: "#7aa93f", colorHead: "#7aa93f", size: 3.6, translucency: 0.9,
  },
  // BANANA — pseudostem + torn paddle leaves by age (bananaGeometry.js).
  // `plumeSpread` = leaf length as % of stem, `plumesPerStem` = dead leaves.
  // `size` 5 m, not 3.5, and `plumeSpread` 92% rather than 70: measured off
  // plantation photographs, a mat's bearing stem is 3-4 m and its leaves reach
  // 2-3 m BEYOND it, so the plant stands well over a man with its crown a good
  // way above the stem's top. At 3.5 m with short leaves it was chest height
  // and read as a houseplant. `spread` now also sets how many suckers stand
  // round the bearing stem — a banana is a CLUMP.
  banana: {
    kind: "banana",
    fronds: 11, frondLength: 1.0, leaflets: 6, leafletWidth: 1.0, leafletAngle: 18,
    spread: 1.0, arch: 0.7, droop: 0.4, stemWidth: 1, bareStalk: 0.08,
    plumesPerStem: 2, plumeSpread: 92,
    colorBase: "#2e6b2a", colorTip: "#7fb23a", colorHead: "#6f8a4a", size: 5, translucency: 1.2,
  },
  // TRAVELLER'S PALM — Ravenala, the flat fan (travellersPalmGeometry.js):
  // a pale sheath fan, long bare petioles and banana blades, all in ONE plane
  // on a slender trunk. An ornamental — hamlet, résidence, temple. `bareStalk`
  // is the trunk's share of the height, `plumeSpread` the fan radius as % of
  // it, `spread` how far round the fan opens. `size` 12 m.
  travellersPalm: {
    kind: "travellersPalm",
    fronds: 24, frondLength: 1.0, leaflets: 14, leafletWidth: 1.0, leafletAngle: 16,
    spread: 1.0, arch: 0.7, droop: 0.5, stemWidth: 1, bareStalk: 0.5,
    plumesPerStem: 2, plumeSpread: 52,
    colorBase: "#1b3f22", colorTip: "#8f9c48", colorHead: "#7c7a6c", size: 12, translucency: 0.8,
  },
  // BANYAN — cây đa, the tree at the communal house and the temple gate
  // (banyanGeometry.js): a lumpy dome of leaf-cluster cards twice as wide as
  // the tree is tall, a trunk of fused strands splitting into limbs, aerial
  // roots and pillars. `spread` is the crown radius in plant heights,
  // `bareStalk` the underside's height, `leaflets` the leaf clumps,
  // `plumesPerStem` the roots in tens, `plumeSpread` the % that are pillars.
  // `size` 18 m — a landmark, placed by hand (placedFoliage.js).
  banyan: {
    kind: "banyan",
    // Fixed cards on the dome, not camera-facing billboards (your call
    // 2026-09-25: crowns turning with the camera "look weird" when it moves).
    billboard: false,
    fronds: 7, frondLength: 1.0, leaflets: 60, leafletWidth: 1.0, leafletAngle: 38,
    spread: 1.0, arch: 0.6, droop: 0.3, stemWidth: 1.4, bareStalk: 0.44,
    plumesPerStem: 16, plumeSpread: 12,
    colorBase: "#1d3d1f", colorTip: "#6f9a3a", colorHead: "#5c4a3a", size: 18, translucency: 0.5,
  },
  // PANDANUS — the screw pine, dứa dại (pandanusGeometry.js): a thin leaning
  // trunk on STILT ROOTS, forking into branches that each end in a spiral
  // tuft of long keeled swords. River banks, canal edges. `fronds` = tufts,
  // `leaflets` = leaves a tuft, `plumeSpread` = leaf length % of height,
  // `plumesPerStem` = stilt roots. `size` 7 m. Plain geometry, no card.
  pandanus: {
    kind: "pandanus",
    // 36 leaves at 1.7 width, not 26 at 1: true-width (8 cm) swords read as
    // hair from the RTS camera and the tufts vanished into the grass. The
    // pale olive is the real leaf's; the dark green of the rest sank it too.
    fronds: 4, frondLength: 1.0, leaflets: 36, leafletWidth: 1.7, leafletAngle: 35,
    spread: 0.28, arch: 0.55, droop: 0.5, stemWidth: 1, bareStalk: 0.42,
    plumesPerStem: 6, plumeSpread: 22,
    colorBase: "#3d6a2c", colorTip: "#a3b35a", colorHead: "#7a6e5c", size: 7, translucency: 0.7,
  },
  // SUGAR PALM, TALL — thốt nốt as it stands over a Cambodian paddy or an
  // Angkor causeway: the fan palm's ball of fans on a 24 m column. The same
  // builder as `fanPalm`; the leaves kept to ~3 m (plumeSpread 13% of 24 m),
  // a thinner trunk and a smaller skirt, as a tall old tree has.
  sugarPalm: {
    kind: "fanPalm",
    fronds: 26, frondLength: 1.0, leaflets: 30, leafletWidth: 0.9, leafletAngle: 18,
    spread: 1.0, arch: 0.4, droop: 0.5, stemWidth: 0.75, bareStalk: 0.34,
    plumesPerStem: 4, plumeSpread: 13,
    colorBase: "#2f5a22", colorTip: "#7f9c3a", colorHead: "#5d574d", size: 24, translucency: 0.8,
  },
  // FLAME TREE — phượng vĩ, Delonix regia: a low, very WIDE flat umbrella that
  // flowers flame red over green, in every village and schoolyard. The
  // dipterocarp's umbrella builder at a third of the height, twice the
  // relative spread, a low fork, a flat crown; its colour runs from green
  // leaves under to red flowers on top.
  flameTree: {
    kind: "dipterocarp",
    fronds: 6, frondLength: 1.0, leaflets: 110, leafletWidth: 0.85, leafletAngle: 30,
    spread: 0.72, arch: 0.1, droop: 0.2, stemWidth: 1.5, bareStalk: 0.36,
    plumesPerStem: 0, plumeSpread: 0,
    // #b84a26, not #c9391d: the first read as a cartoon red ball.
    colorBase: "#34552a", colorTip: "#b84a26", colorHead: "#6a6258", size: 11, translucency: 0.6,
  },
  // DIPTEROCARP — the lowland rainforest canopy tree (dipterocarpGeometry.js):
  // a clean pale bole, buttress roots, and an umbrella of cauliflower heads
  // made of the banyan's billboard leaf clusters. 30 m, an emergent.
  dipterocarp: {
    kind: "dipterocarp",
    // 140 clumps at 0.8 size, not 70 at 1: with a few big cards per head the
    // card OUTLINE showed ("reads too low poly", 2026-09-24); many smaller
    // overlapping lumps give the crown its broken edge.
    fronds: 5, frondLength: 1.0, leaflets: 140, leafletWidth: 0.8, leafletAngle: 30,
    spread: 0.36, arch: 0.35, droop: 0.2, stemWidth: 1, bareStalk: 0.56,
    plumesPerStem: 5, plumeSpread: 0,
    colorBase: "#1f3d20", colorTip: "#557a33", colorHead: "#6c685b", size: 30, translucency: 0.5,
  },
  // TARO / elephant ear — knee-high heart leaves on thin petioles, wet ground.
  taro: {
    kind: "taro",
    fronds: 7, frondLength: 1.0, leaflets: 2, leafletWidth: 1.0, leafletAngle: 24,
    spread: 1.0, arch: 0.6, droop: 0.35, stemWidth: 1, bareStalk: 0.05,
    plumesPerStem: 0, plumeSpread: 95,
    colorBase: "#2a5d2c", colorTip: "#6aa43c", colorHead: "#6f8a4a", size: 1.2, translucency: 0.9,
  },
  // NIPA — the mangrove palm: almost no trunk, fronds straight out of the
  // water. The palm builder with a stub trunk and long upright fronds.
  nipaPalm: {
    kind: "palm",
    fronds: 14, frondLength: 0.25, leaflets: 8, leafletWidth: 0.9, leafletAngle: 30,
    spread: 0.55, arch: 0.5, droop: 0.4, stemWidth: 2.2, bareStalk: 0.3,
    plumesPerStem: 2, plumeSpread: 380,
    colorBase: "#2f6a2a", colorTip: "#86ae3a", colorHead: "#5e5340", size: 7, translucency: 0.9,
  },
  // ARECA / betel palm — a pencil trunk and a small crown; village rows.
  arecaPalm: {
    kind: "palm",
    fronds: 9, frondLength: 1.0, leaflets: 60, leafletWidth: 0.85, leafletAngle: 30,
    spread: 0.85, arch: 0.8, droop: 0.45, stemWidth: 0.55, bareStalk: 0.05,
    plumesPerStem: 1, plumeSpread: 22,
    colorBase: "#2f6a2a", colorTip: "#8fb43c", colorHead: "#8d8676", size: 16, translucency: 0.9,
  },
  // SUGAR CANE — the bamboo builder as a crop: short thick canes, leaves low.
  sugarCane: {
    kind: "bamboo",
    fronds: 9, frondLength: 1.0, leaflets: 12, leafletWidth: 1.6, leafletAngle: 40,
    spread: 0.8, arch: 0.2, droop: 0.45, stemWidth: 1.4, bareStalk: 0.25,
    plumesPerStem: 7, plumeSpread: 40,
    colorBase: "#3f7a2e", colorTip: "#9ccb4e", colorHead: "#8a7a4a", size: 3.2, translucency: 1.1,
  },
  // BURNT BAMBOO — what napalm leaves: charred culms, a few dead leaves.
  bambooBurnt: {
    kind: "bamboo",
    fronds: 4, frondLength: 1.0, leaflets: 22, leafletWidth: 0.8, leafletAngle: 48,
    spread: 1.0, arch: 0.35, droop: 0.6, stemWidth: 1, bareStalk: 0.6,
    plumesPerStem: 3, plumeSpread: 26,
    colorBase: "#2a2420", colorTip: "#4a3a28", colorHead: "#332b25", size: 8, translucency: 0.15,
  },
  // DRY BAMBOO — defoliant-yellow, a season dead.
  bambooDry: {
    kind: "bamboo",
    fronds: 5, frondLength: 1.0, leaflets: 22, leafletWidth: 0.9, leafletAngle: 48,
    spread: 1.0, arch: 0.5, droop: 0.5, stemWidth: 1, bareStalk: 0.5,
    plumesPerStem: 5, plumeSpread: 26,
    colorBase: "#8a7a34", colorTip: "#c9b866", colorHead: "#b8a45a", size: 9, translucency: 0.8,
  },
  groundCover: {
    kind: "broadleaf",
    fronds: 16, frondLength: 0.9, leaflets: 4, leafletWidth: 1.3, leafletAngle: 60,
    spread: 0.5, arch: 0.4, droop: 0.25, stemWidth: 0.8, bareStalk: 0,
    colorBase: "#3a6b2a", colorTip: "#7fa945", colorHead: "#7fa945", size: 0.5, translucency: 0.9,
  },
};

// castShadow: tall plants ground themselves with a shadow; ground cover is
// too low for one to read and is the most numerous, so it does not cast.
/*
 * The eight ground plants, picked for a South-East Asian setting rather than a
 * temperate one — the card ferns, banana, nipa and sugar cane earn their slots;
 * plume reed, pampas and typha read as European riverbank and were using three
 * of the eight for one silhouette between them.
 *
 * NOTE these are not saved per project (projectIO writes `foliageField` with
 * `types` stripped), so this list IS the plant set for every map. Change the
 * ORDER and every painted density channel shifts with it — channel N is type N.
 */
const TYPE_DEFAULTS = [
  { name: "Card fern",   preset: "cardFern",    castShadow: true },
  { name: "Bush",        preset: "bush",        castShadow: true },
  { name: "Nipa palm",   preset: "nipaPalm",    castShadow: true },
  { name: "Banana",      preset: "banana",      castShadow: true },
  { name: "Ground cover", preset: "groundCover", castShadow: false },
  { name: "Reeds",       preset: "reeds",       castShadow: true },
  { name: "Sugar cane",  preset: "sugarCane",   castShadow: true },
  { name: "Giant fern",  preset: "giantFern",   castShadow: true },
];

/**
 * THE TALL-PLANT FIELD (its state and save key are still "susuki", which is
 * what it held when it was built — see grassTerrainData's paint layer).
 *
 * The shapes and material are foliage's; the FIELD is what differs: a 400 m
 * tile at 1.4 m spacing, so a plant on it stays visible to 150-195 m where the
 * ground-foliage field (192 m, 0.75 m) has faded out by 95 m. That near fade
 * is right for a fern underfoot and useless for anything you look ACROSS a
 * map at — bamboo, palms, banana — and hopeless for an RTS camera sitting
 * 18-280 m out. So the tall plants live here.
 *
 * THREE types, one per RGB channel of the paint layer (alpha is the layer's
 * own, not a plant). Slot 0 stays susuki so projects painted before the field
 * went multi-type keep the plant they painted.
 */
/**
 * THE GROUND-FOLIAGE FIELD.
 *
 * Was 192 m at 256 a side (0.75 m apart) — a walking camera's numbers, and
 * badly wrong for anything you look ACROSS. MEASURED on nam-rts at mid zoom:
 * the camera sits 91 m up and the ground it can see runs from 53 m to 251 m
 * away. A 192 m tile therefore WRAPS inside the view, and the field's own fade
 * (70-95 m) emptied the screen a third of the way up — the band then sweeps
 * across as you pan, which is exactly the "vegetation appears and changes"
 * that gets noticed.
 *
 * Same trade the tall plants already made: grow the tile and the spacing
 * TOGETHER so the slot count barely moves. 384 m at 288 a side is 1.33 m apart
 * — 4x the area for 27% more slots — and at 53 m you cannot resolve 0.75 m
 * spacing anyway, so nothing is lost where it could be seen. `density` carries
 * the apparent thickness from there.
 */
export const FOLIAGE_FIELD = { tileSize: 384, plantsPerSide: 288 };

export const SUSUKI_FIELD = { tileSize: 400, plantsPerSide: 288 };
/**
 * FOUR tall plants, one per RGBA channel of the paint layer. It was three for
 * as long as alpha was spoken for; nothing ever wrote alpha, and the jungle
 * trees needed a channel of their own rather than a whole new field with its
 * own tile, its own save blob and its own distances.
 */
export const TALL_PLANT_COUNT = 4;

export function createSusukiPlantState() {
  return {
    density: 1,
    clumping: 0,
    clumpSize: 8,
    sizeVar: 0.18,
    colorVar: 0.05,
    grassLift: 0,
    slopeMinY: 0.55,
    // Stiff canes: the whole plant sways less than a fern.
    windMul: 1,
    flex: 0.3,
    flutter: 0.4,
    interactRadius: 2.2,
    interactStrength: 1.2,
    translucencyMul: 1.1,
    glowLight: 0.06,
    receiveShadows: true,
    castShadows: true,
    shadowDistance: 45,
    // Pushed out for the TALL plants. These were 25/70, tuned when the field
    // held one 2 m susuki. A 9 m bamboo at 70 m is still 60 px tall and its
    // LOD2 is mostly culm — so it dropped to bare pale stalks while it still
    // filled a good part of the screen, and a grove read as yellow spikes
    // instead of green crowns. LOD distance has to follow plant HEIGHT.
    // The four distances below are DERIVED from what the camera can see
    // (main.js viewGroundBand) unless this is false. Metres fitted by hand
    // are fitted to one zoom, and go stale the moment the camera changes —
    // these four have been wrong twice already for exactly that reason.
    autoDistances: true,
    lodDistance: 60,
    lodDistance2: 140,
    fadeStart: 150,
    fadeEnd: 195,
    // Slot 0 is susuki and must stay susuki: a project painted before this
    // field went multi-type has its coverage in channel 0.
    types: [
      { name: "Susuki", preset: "susuki" },
      { name: "Bamboo", preset: "bamboo" },
      { name: "Palm",   preset: "palm" },
      { name: "Jungle tree", preset: "jungleTree" },
    ].map((t) => ({
      name: t.name, preset: t.preset, castShadow: true,
      ...structuredClone(FOLIAGE_PRESETS[t.preset]),
      ...FOLIAGE_HEIGHT_ANY,
      onLayer: -1,
      nearRiver: 0,
    })),
  };
}

export function createFoliageScatterState() {
  return {
    // ── The field ──
    density: 0.25,
    clumping: 0.75,
    clumpSize: 8,
    sizeVar: 0.3,
    colorVar: 0.06,
    grassLift: 0.4,
    slopeMinY: 0.6,
    // ── Wind & push (multiplies the shared grass wind). Off by default: the
    // shape is judged at rest; wind is switched on once it is right. ──
    windMul: 0,
    flex: 0.6,
    flutter: 0,
    // Wide enough that plants PART around someone walking through: at 1.4 m
    // the ring was barely wider than the character, so nothing seemed to react.
    interactRadius: 2.2,
    interactStrength: 1.0,
    // ── Light ──
    translucencyMul: 1,
    glowLight: 0.02,
    receiveShadows: true,
    // Plants cast into the near shadow cascades only, drawn with their
    // cheapest shape, within this distance of the camera (per-type switch on
    // each plant).
    castShadows: true,
    shadowDistance: 35,
    // ── Distance: every leaflet up close, a cut sheet, then a plain blade ──
    // Derived from what the camera can see unless autoDistances is false; see
    // the note on the other state. These four are what got it wrong before:
    // LOD steps at 18 m and 45 m on a camera whose nearest visible ground was
    // 53 m meant no plant ever drew at full detail.
    autoDistances: true,
    lodDistance: 18,
    lodDistance2: 45,
    fadeStart: 70,
    fadeEnd: 95,
    types: TYPE_DEFAULTS.map((t) => ({
      ...t,
      ...structuredClone(FOLIAGE_PRESETS[t.preset]),
      // Where a plant MAY grow is off by default: painting it somewhere is you
      // saying it grows there. The rules below are an opt-in filter, for
      // scattering a plant over a whole world rather than by hand.
      ...FOLIAGE_HEIGHT_ANY,
      onLayer: -1,
      nearRiver: 0,
    })),
  };
}
