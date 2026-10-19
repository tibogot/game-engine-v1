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
  ruineRomaine: "Roman ruin", colonne: "Roman column", colonnade: "Colonnade", voie: "Roman road", arc: "Trajan's arch",
  pressoir: "Oil press", rocheBanc: "Rock: big shelf", rocheBloc: "Rock: block", rocheDalle: "Rock: low slab", grotte: "FLN cave",
  maisonPierre: "Stone house (HQ)", mechtaPierre: "Mechta (new)", hameau: "Hamlet (new)", dechraNouveau: "Dechra (new)",
  ksarNouveau: "Ksar (new)", postePhoto: "Post (photo detail)", mortier: "Mortar pit", campFln: "FLN camp",
  pointRavit: "Point: munitions", pointCarbu: "Point: fuel",
};
const WORDS = [
  ["(LE JEU)", "(THE GAME)"], ["(KIT DU JEU)", "(GAME KIT)"], ["NOUVEAU STANDARD", "NEW STANDARD"], ["NOUVELLE", "NEW"], ["NOUVEAU", "NEW"],
  ["SACS SIMULÉS", "SIM BAGS"], ["SACS DE SABLE", "SANDBAGS"], ["DÉTAIL PHOTO", "PHOTO DETAIL"], ["DÉTAIL", "DETAIL"], ["variante", "variant"],
  ["ENDOMMAGÉE", "DAMAGED"], ["INTACTE", "INTACT"], ["RUINE", "RUIN"], ["HÉLISURFACE", "HELIPAD"], ["PARC AUTO", "MOTOR POOL"],
  ["NID DE MG", "MG NEST"], ["POINT FORTIFIÉ", "STRONGPOINT"], ["POSTE", "POST"], ["HAMEAU", "HAMLET"], ["VILLAGE BLANCHI", "WHITEWASHED VILLAGE"],
  ["GROTTE", "CAVE"], ["GRÈS", "SANDSTONE"], ["MAISON", "HOUSE"], ["PIERRE", "STONE"], ["MORTIER", "MORTAR"], ["MUNITIONS", "MUNITIONS"],
  ["CARBURANT", "FUEL"], ["ENCLOS", "PEN"], ["FERME", "FARM"], ["SON ENCLOS À DROITE DE LA COUR", "ITS PEN RIGHT OF THE YARD"],
  ["TEMPLE", "TEMPLE"], ["ROCHER", "ROCK"], ["COUR", "COURTYARD"], ["HAUTE", "TALL"], ["BOUTIQUE", "SHOP"],
];
/** A version label in English. */
export const enTag = (s) => WORDS.reduce((a, [f, t]) => a.split(f).join(t), String(s));
