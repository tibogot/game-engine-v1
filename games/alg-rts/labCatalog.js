// THE NEW LAB'S CATALOGUE (2026-10-19, lab.js): what each piece of the buildings lab IS, for the filters —
// its SIDE, its KIND, the MAPS it serves, its STATUS. The pieces themselves are the old lab's
// (buildingLab.js BUILDINGS: their builders, their before / middle / after, tags and notes) — one catalogue,
// two labs. A key missing here still shows, under "autre".
//
//   status  "jeu"     in the game as it is
//           "verdict" new, waiting for your verdict
//           "ancien"  an old version kept to compare
export const SIDES = { fr: "French", fln: "FLN", civil: "Civilian", nature: "Nature" };
export const KINDS = { base: "Base", defense: "Defence", village: "Village", fln: "FLN camp", ruine: "Ruins", nature: "Rocks", plant: "Plants", field: "Fields", prop: "Props", point: "Points" };
export const MAPS = { aures: "Aurès", abdi: "Oued Abdi", cote: "Coast", kantara: "El Kantara" };
export const STATUS = { jeu: "In the game", verdict: "To judge", ancien: "Old, kept", parked: "Parked (for later)" };

const ALL = ["aures", "abdi", "cote", "kantara"];
// (the plants: buildingLab PLANT_SPECIES — every one as the game grows it, plant-lab.html folded in 2026-10-25)
const PLANT_KEYS = ["pricklyPear", "thistle", "asphodel", "alfa", "agave", "agaveMast", "broom", "oleander", "tamarisk", "betoum", "tamariskTree", "typha", "juniperScrub", "doumPalm"];
export const META = {
  // (2026-10-25: everything the maps place that the lab never showed — tools/labCoverageTest.mjs)
  sasPost: { side: "fr", kind: "base", maps: ["aures", "abdi"], status: "jeu" },
  mineMarker: { side: "fln", kind: "defense", maps: ALL, status: "verdict" },
  lookout: { side: "fln", kind: "defense", maps: ["aures"], status: "verdict" },
  koubba: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
  cemetery: { side: "civil", kind: "village", maps: ["aures"], status: "jeu" },
  villageWell: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
  farmstead: { side: "civil", kind: "village", maps: ["aures"], status: "jeu" },
  burntFarm: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  ruinedHut: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  garden: { side: "civil", kind: "field", maps: ["aures"], status: "jeu" },
  threshingFloor: { side: "civil", kind: "field", maps: ["aures"], status: "jeu" },
  terraces: { side: "civil", kind: "field", maps: ["aures"], status: "jeu" },
  fieldWallOld: { side: "civil", kind: "field", maps: ["aures"], status: "jeu" },
  fieldWallsBlender: { side: "civil", kind: "field", maps: ["aures", "abdi"], status: "jeu" },
  villagePropsOld: { side: "civil", kind: "prop", maps: ["aures"], status: "jeu" },
  villagePropsBlender: { side: "civil", kind: "prop", maps: ["aures"], status: "jeu" },
  telegraphPole: { side: "fr", kind: "prop", maps: ["aures"], status: "jeu" },
  rubbleKit: { side: "civil", kind: "ruine", maps: ["aures", "abdi"], status: "jeu" },
  rubbleHeapOld: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  mzab_mur: { side: "civil", kind: "village", maps: ["abdi"], status: "jeu" },
  scannedBoulders: { side: "nature", kind: "nature", maps: ["aures"], status: "jeu" },
  ...Object.fromEntries(PLANT_KEYS.map((k) => [`plant_${k}`, { side: "nature", kind: "plant", maps: ALL, status: "jeu" }])),
  plantSteppe: { side: "nature", kind: "plant", maps: ["aures", "kantara"], status: "jeu" },
  parcAutoNeuf: { side: "fr", kind: "base", maps: ALL, status: "jeu" },
  helisurface: { side: "fr", kind: "base", maps: ALL, status: "jeu" },
  sacsDeSable: { side: "fr", kind: "defense", maps: ALL, status: "jeu" },
  mechtaPierre: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
  maisonPierre: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
  hameau: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
  dechraNouveau: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
  ksarNouveau: { side: "civil", kind: "village", maps: ["aures"], status: "jeu" },
  blanche_maison: { side: "civil", kind: "village", maps: ["abdi", "cote", "kantara"], status: "verdict" },
  blanche_cour: { side: "civil", kind: "village", maps: ["abdi", "cote", "kantara"], status: "verdict" },
  blanche_haute: { side: "civil", kind: "village", maps: ["abdi", "cote", "kantara"], status: "verdict" },
  blanche_boutique: { side: "civil", kind: "village", maps: ["abdi", "cote", "kantara"], status: "verdict" },
  villageBlanc: { side: "civil", kind: "village", maps: ["abdi"], status: "verdict" },
  ...Object.fromEntries(["dar", "tour", "bas", "terrasse", "souk", "mosquee"].map((ty) => [`mzab_${ty}`, { side: "civil", kind: "village", maps: ["abdi", "kantara"], status: "verdict" }])),
  villeMzab: { side: "civil", kind: "village", maps: ["abdi"], status: "verdict" },
  zeriba: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
  zeribaParked: { side: "civil", kind: "village", maps: [], status: "parked" },
  port: { side: "civil", kind: "village", maps: ["cote"], status: "verdict" },
  grotte: { side: "fln", kind: "fln", maps: ["aures", "abdi"], status: "jeu" },
  campFln: { side: "fln", kind: "fln", maps: ["aures", "abdi"], status: "verdict" },
  ruineRomaine: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  colonne: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  colonnade: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  voie: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  arc: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  pressoir: { side: "civil", kind: "ruine", maps: ["aures"], status: "jeu" },
  rocheBanc: { side: "nature", kind: "nature", maps: ["kantara"], status: "jeu" },
  rocheBloc: { side: "nature", kind: "nature", maps: ["kantara"], status: "jeu" },
  rocheDalle: { side: "nature", kind: "nature", maps: ["kantara"], status: "jeu" },
  // (2026-10-21: the Blender requisition points — in the game — and the Blender sangar)
  // (the old depots: only a fallback in the game since the Blender points — their entries keep the capture panel)
  pointBlender_fuel: { side: "fr", kind: "point", maps: ALL, status: "jeu" },
  pointBlender_mun: { side: "fr", kind: "point", maps: ALL, status: "jeu" },
  sangarBlender: { side: "fln", kind: "defense", maps: ALL, status: "verdict" },
  cacheBlender: { side: "fln", kind: "fln", maps: ALL, status: "verdict" },
  refugeBlender: { side: "fln", kind: "fln", maps: ALL, status: "verdict" },
  infirmBlender: { side: "fln", kind: "fln", maps: ALL, status: "verdict" },
  ecranBlender: { side: "fln", kind: "defense", maps: ALL, status: "verdict" },
  miradorBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  barbelesBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  nidBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  mortierBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  fortBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  projBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  posteBlender: { side: "fr", kind: "base", maps: ALL, status: "verdict" },
  posteAvanceBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  secoursBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
};
export const metaOf = (key) => META[key] ?? { side: "civil", kind: "autre", maps: [], status: "jeu" };

// ENGLISH (2026-10-19, you: "the main language of labs is English"): the pieces' names, and their version
// labels translated word by word (the old lab's data is French and stays so).
// WHAT THE GAME PLACES → ITS LAB ENTRY (2026-10-25, you: "be careful with some assets not being in the lab … we need
// better organization"). Every placement key of the maps (showroom.js, algLandmarks.js, algGame.js — trailing digits
// and the villages' suffixes dropped: gardenOA1 → garden), every buildable (algBuild BUILDS) and every Blender kit type
// (algHouse *_TYPES, as "kit:<type>"): its lab entry, or { none: why it has none }. tools/labCoverageTest.mjs (npm
// test) fails when the game places something this table does not know — a new piece gets its lab entry first.
// SYSTEMS: placed by their own modules, no key to read — listed by hand (PIECES_INVENTORY.md).
const UNIT = { none: "a unit (the vehicle lab)" };
export const PLACED = {
  // the base (showroom.js)
  frenchPost: "posteBlender", helipad: "helisurface", motorPool: "parcAutoNeuf", sasPost: "sasPost",
  mirador: "miradorBlender", mgNest: "nidBlender", searchlight: "projBlender", mortarPit: "mortierBlender", sandbags: "sacsDeSable", wire: "barbelesBlender",
  ebr: UNIT, amx: UNIT,   /* (amx13: its digits dropped) */ halftrack: UNIT, gmc: UNIT, willys: UNIT, alouette: UNIT,
  // the FLN
  alnCamp: "campFln", caveEntrance: "grotte", armsCache: "cacheBlender", sangar: "sangarBlender", ambushScreen: "ecranBlender", mineMarker: "mineMarker",
  lookout: "lookout", refuge: "refugeBlender",
  // the villages
  mechta: "hameau", dechra: "dechraNouveau", ksar: "ksarNouveau", koubba: "koubba", cemetery: "cemetery", wellDechra: "villageWell", wellHamlet: "villageWell",
  zeriba: "zeriba", garden: "garden", thresh: "threshingFloor", terraces: "terraces", terracesOpen: "terraces",
  // the landmarks (algLandmarks.js, algGame.js MAP.farmsteads)
  mechtaFarm: "farmstead", mechtaFarmMap: "farmstead", burntFarm: "burntFarm", ruinedHut: "ruinedHut",
  romanRuin: "ruineRomaine", romanArch: "arc", romanColonnade: "colonnade", romanColumn: "colonne", romanPress: "pressoir", romanRoad: "voie",
  // the buildables (algBuild.js BUILDS — the ones not placed above)
  forwardPost: "posteAvanceBlender", aidStation: "secoursBlender", fortPoint: "fortBlender", infirmary: "infirmBlender",
  // the Blender kits (algHouse.js)
  ...Object.fromEntries(["maison", "cour", "haute", "boutique"].map((t) => [`kit:${t}`, `blanche_${t}`])),
  ...Object.fromEntries(["dar", "tour", "bas", "terrasse", "souk", "mosquee", "mur"].map((t) => [`kit:${t}`, `mzab_${t}`])),
  "kit:a": "fieldWallsBlender", "kit:b": "fieldWallsBlender", "kit:c": "fieldWallsBlender",
  "kit:fuel": "pointBlender_fuel", "kit:mun": "pointBlender_mun", "kit:sangar": "sangarBlender", "kit:arms": "cacheBlender", "kit:ambush": "ecranBlender",
  "kit:mirador": "miradorBlender", "kit:gear": "miradorBlender", "kit:barbed": "barbelesBlender", "kit:mg": "nidBlender", "kit:gun": "nidBlender",
  "kit:mortar": "mortierBlender", "kit:m81": "mortierBlender", "kit:point": "fortBlender", "kit:sltower": "projBlender", "kit:lamp": "projBlender",
  "kit:fwdradio": "posteAvanceBlender", "kit:aidtent": "secoursBlender", "kit:aidmark": "secoursBlender", "kit:refuge": "refugeBlender", "kit:infirm": "infirmBlender",
  "kit:post": "posteBlender", "kit:lookout": "lookout", "kit:minemark": "mineMarker",
  ...Object.fromEntries(["well", "trough", "jars", "jars2", "jars3", "bench", "oven", "hay", "wood", "hives"].map((t) => [`kit:${t}`, "villagePropsBlender"])),
  ...Object.fromEntries(["wide", "tall", "spill", "chunkslab", "chunkstone", "chunkblock", "chunkbeam"].map((t) => [`kit:${t}`, "rubbleKit"])),
  ...Object.fromEntries(["grenade", "smoke", "flare", "cutters", "mine", "helmet", "kepi", "jerrycan", "ammobox", "detonator", "detector", "radio", "lmg", "bazooka", "flamer", "sniper", "tools", "shell", "shotgun", "mapcase", "spade"]
    .map((t) => [`kit:${t}`, { none: "hand-held: the HUD icons (iconStudio.js)" }])),
};
export const SYSTEMS = {
  "village props (old, aures)": "villagePropsOld", "telegraph poles": "telegraphPole", "old field walls": "fieldWallOld", "port (coast)": "port",
  "sandstone rocks": "rocheBanc", "rubble heap (old house hit)": "rubbleHeapOld", "plants (foliage presets)": "plantSteppe",
  "rock outcrops / scanned boulders": "scannedBoulders",   // (the sandstone formations' editor stays its own tool page: rock-lab.html)
  "loose stones (algStones)": { none: "scattered by the terrain: judged in the game" },
  "flags, windsock (live cloth)": { none: "animated props: judged in the game" },
  "field surfaces (old aures)": { none: "shader-draped ground: judged in the game" },
  "simulated sandbag walls of the pieces": { none: "inside their pieces' entries" },
  "fallback depot / mast / old buildable kits": { none: "drawn only when a Blender model fails to load" },
};

export const NAMES = {
  zeriba: "Zeriba", zeribaParked: "Thorn ring (Blender, parked)", sacsDeSable: "Sandbag wall", port: "Fishing port",
    parcAutoNeuf: "Motor pool",
  blanche_maison: "Whitewashed house: two storeys", blanche_cour: "Whitewashed house: courtyard", blanche_haute: "Whitewashed house: tall",
  blanche_boutique: "Whitewashed house: shop", villageBlanc: "Whitewashed village", helisurface: "Helipad",
  mzab_dar: "M'zab house: roof gallery", mzab_mur: "M'zab terrace wall", mzab_tour: "M'zab house: tall", mzab_bas: "M'zab house: low, yard", mzab_terrasse: "M'zab house: stepped, pale blue",
  mzab_souk: "M'zab souk: arcade row", mzab_mosquee: "M'zab mosque and minaret", villeMzab: "M'zab town (souk square)",
  ruineRomaine: "Roman ruin", colonne: "Roman column", colonnade: "Colonnade", voie: "Roman road", arc: "Trajan's arch",
  pressoir: "Oil press", rocheBanc: "Rock: big shelf", rocheBloc: "Rock: block", rocheDalle: "Rock: low slab", grotte: "FLN cave",
  maisonPierre: "Stone house (HQ)", mechtaPierre: "Mechta house", hameau: "Hamlet", dechraNouveau: "Dechra",
  ksarNouveau: "Ksar", campFln: "FLN camp",
    pointBlender_fuel: "Requisition point: fuel", pointBlender_mun: "Requisition point: munitions",
  sangarBlender: "Sangar",   cacheBlender: "Arms cache",   ecranBlender: "Ambush screen",   miradorBlender: "Mirador",   nidBlender: "MG nest",
  mortierBlender: "Mortar pit", fortBlender: "Fortified point", projBlender: "Searchlight tower", posteBlender: "French post", posteAvanceBlender: "Forward post", refugeBlender: "FLN refuge", infirmBlender: "FLN infirmary", secoursBlender: "Aid station",
  barbelesBlender: "Barbed wire", };
const WORDS = [
  ["(LE JEU)", "(THE GAME)"], ["(KIT DU JEU)", "(GAME KIT)"], ["NOUVEAU STANDARD", "NEW STANDARD"], ["NOUVELLE", "NEW"], ["NOUVEAU", "NEW"],
  ["SACS SIMULÉS", "SIM BAGS"], ["SACS DE SABLE", "SANDBAGS"], ["DÉTAIL PHOTO", "PHOTO DETAIL"], ["DÉTAIL", "DETAIL"], ["variante", "variant"],
  ["ENDOMMAGÉE", "DAMAGED"], ["INTACTE", "INTACT"], ["RUINE", "RUIN"], ["HÉLISURFACE", "HELIPAD"], ["PARC AUTO", "MOTOR POOL"],
  ["NID DE MG", "MG NEST"], ["POINT FORTIFIÉ", "STRONGPOINT"], ["POSTE", "POST"], ["HAMEAU", "HAMLET"], ["VILLAGE BLANCHI", "WHITEWASHED VILLAGE"], ["VILLE DU M'ZAB", "M'ZAB TOWN"],
  ["GROTTE", "CAVE"], ["GRÈS", "SANDSTONE"], ["MAISON", "HOUSE"], ["PIERRE", "STONE"], ["MORTIER", "MORTAR"], ["MUNITIONS", "MUNITIONS"],
  ["CARBURANT", "FUEL"], ["ENCLOS", "PEN"], ["FERME", "FARM"], ["SON ENCLOS À DROITE DE LA COUR", "ITS PEN RIGHT OF THE YARD"],
  ["TEMPLE", "TEMPLE"], ["ROCHER", "ROCK"], ["COUR", "COURTYARD"], ["HAUTE", "TALL"], ["BOUTIQUE", "SHOP"],
];
/** A version label in English. */
export const enTag = (s) => WORDS.reduce((a, [f, t]) => a.split(f).join(t), String(s));
