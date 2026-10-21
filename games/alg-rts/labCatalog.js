// THE NEW LAB'S CATALOGUE (2026-10-19, lab.js): what each piece of the buildings lab IS, for the filters —
// its SIDE, its KIND, the MAPS it serves, its STATUS. The pieces themselves are the old lab's
// (buildingLab.js BUILDINGS: their builders, their before / middle / after, tags and notes) — one catalogue,
// two labs. A key missing here still shows, under "autre".
//
//   status  "jeu"     in the game as it is
//           "verdict" new, waiting for your verdict
//           "ancien"  an old version kept to compare
export const SIDES = { fr: "French", fln: "FLN", civil: "Civilian", nature: "Nature" };
export const KINDS = { base: "Base", defense: "Defence", village: "Village", fln: "FLN camp", ruine: "Ruins", nature: "Rocks", point: "Points" };
export const MAPS = { aures: "Aurès", abdi: "Oued Abdi", cote: "Coast", kantara: "El Kantara" };
export const STATUS = { jeu: "In the game", verdict: "To judge", ancien: "Old, kept" };

const ALL = ["aures", "abdi", "cote", "kantara"];
export const META = {
  poste: { side: "fr", kind: "base", maps: ALL, status: "jeu" },
  postePhoto: { side: "fr", kind: "base", maps: ["aures"], status: "verdict" },
  sacsPoste: { side: "fr", kind: "base", maps: ALL, status: "jeu" },
  parcAuto: { side: "fr", kind: "base", maps: ["aures"], status: "jeu" },
  parcAutoNeuf: { side: "fr", kind: "base", maps: ["abdi", "cote", "kantara"], status: "verdict" },
  helisurface: { side: "fr", kind: "base", maps: ALL, status: "jeu" },
  sacsNidMg: { side: "fr", kind: "defense", maps: ALL, status: "jeu" },
  sacsPointFort: { side: "fr", kind: "defense", maps: ALL, status: "jeu" },
  sacsDeSable: { side: "fr", kind: "defense", maps: ALL, status: "jeu" },
  mortier: { side: "fr", kind: "defense", maps: ALL, status: "jeu" },
  pointRavit: { side: "fr", kind: "point", maps: ALL, status: "jeu" },
  pointCarbu: { side: "fr", kind: "point", maps: ALL, status: "jeu" },
  mechtaHouse: { side: "civil", kind: "village", maps: ["aures"], status: "ancien" },
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
  enclosFerme: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
  zeriba: { side: "civil", kind: "village", maps: ["aures", "abdi"], status: "jeu" },
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
  pointRavit: { side: "fr", kind: "point", maps: ALL, status: "ancien" },
  pointCarbu: { side: "fr", kind: "point", maps: ALL, status: "ancien" },
  pointBlender_fuel: { side: "fr", kind: "point", maps: ALL, status: "jeu" },
  pointBlender_mun: { side: "fr", kind: "point", maps: ALL, status: "jeu" },
  sangarBlender: { side: "fln", kind: "defense", maps: ALL, status: "verdict" },
  sangarEtats: { side: "fln", kind: "defense", maps: ALL, status: "verdict" },
  cacheBlender: { side: "fln", kind: "fln", maps: ALL, status: "verdict" },
  refugeBlender: { side: "fln", kind: "fln", maps: ALL, status: "verdict" },
  infirmBlender: { side: "fln", kind: "fln", maps: ALL, status: "verdict" },
  cacheEtats: { side: "fln", kind: "fln", maps: ALL, status: "verdict" },
  ecranBlender: { side: "fln", kind: "defense", maps: ALL, status: "verdict" },
  ecranEtats: { side: "fln", kind: "defense", maps: ALL, status: "verdict" },
  miradorBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  miradorEtats: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  barbelesBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  sacsConstruction: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  nidBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  mortierBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  fortBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  projBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  posteAvanceBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  secoursBlender: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
  barbelesEtats: { side: "fr", kind: "defense", maps: ALL, status: "verdict" },
};
export const metaOf = (key) => META[key] ?? { side: "civil", kind: "autre", maps: [], status: "jeu" };

// ENGLISH (2026-10-19, you: "the main language of labs is English"): the pieces' names, and their version
// labels translated word by word (the old lab's data is French and stays so).
export const NAMES = {
  enclosFerme: "Farm thorn pen (new)", zeriba: "Zeriba (new)", sacsDeSable: "Sandbag wall (new)", port: "Fishing port (new)",
  sacsNidMg: "MG nest (sim bags)", sacsPointFort: "Strongpoint (sim bags)", sacsPoste: "Post (sim bags)",
  mechtaHouse: "Mechta house", poste: "French post", parcAuto: "Motor pool", parcAutoNeuf: "Motor pool (new, Blender)",
  blanche_maison: "Whitewashed house: two storeys", blanche_cour: "Whitewashed house: courtyard", blanche_haute: "Whitewashed house: tall",
  blanche_boutique: "Whitewashed house: shop", villageBlanc: "Whitewashed village", helisurface: "Helipad",
  mzab_dar: "M'zab house: roof gallery", mzab_tour: "M'zab house: tall", mzab_bas: "M'zab house: low, yard", mzab_terrasse: "M'zab house: stepped, pale blue",
  mzab_souk: "M'zab souk: arcade row", mzab_mosquee: "M'zab mosque and minaret", villeMzab: "M'zab town (souk square)",
  ruineRomaine: "Roman ruin", colonne: "Roman column", colonnade: "Colonnade", voie: "Roman road", arc: "Trajan's arch",
  pressoir: "Oil press", rocheBanc: "Rock: big shelf", rocheBloc: "Rock: block", rocheDalle: "Rock: low slab", grotte: "FLN cave",
  maisonPierre: "Stone house (HQ)", mechtaPierre: "Mechta (new)", hameau: "Hamlet (new)", dechraNouveau: "Dechra (new)",
  ksarNouveau: "Ksar (new)", postePhoto: "Post (photo detail)", mortier: "Mortar pit", campFln: "FLN camp",
  pointRavit: "Point: munitions (old depot) + capture marks", pointCarbu: "Point: fuel (old depot) + capture marks",
  pointBlender_fuel: "Requisition point: fuel (Blender)", pointBlender_mun: "Requisition point: munitions (Blender)",
  sangarBlender: "Sangar (Blender) + construction", sangarEtats: "Sangar (Blender): states",
  cacheBlender: "Arms cache (Blender) + construction", cacheEtats: "Arms cache (Blender): states",
  ecranBlender: "Ambush screen (Blender) + construction", ecranEtats: "Ambush screen (Blender): states",
  miradorBlender: "Mirador (Blender) + construction", miradorEtats: "Mirador (Blender): states",
  sacsConstruction: "Sandbag pieces: construction (wall, MG nest, mortar pit)",
  nidBlender: "MG nest (Blender) + construction",
  mortierBlender: "Mortar pit (Blender) + construction", fortBlender: "Fortified point (Blender) + construction", projBlender: "Searchlight tower (Blender) + construction", posteAvanceBlender: "Forward post (Blender) + construction", refugeBlender: "FLN refuge (Blender) + construction", infirmBlender: "FLN infirmary (Blender) + construction", secoursBlender: "Aid station (Blender) + construction",
  barbelesBlender: "Barbed wire (Blender) + construction", barbelesEtats: "Barbed wire (Blender): states",
};
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
