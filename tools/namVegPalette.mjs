/**
 * THE JUNGLE'S COLOUR — repaint nam-valley's vegetation for a Vietnam RTS.
 *
 * The plants were authored for a stylized, Genshin-ish game, and they look it:
 * every tip colour is a bright lime (#8cb84a, #9ccb4e), the trees' crowns are
 * #5aaa2a over a #c8e070 subsurface, and the grass tip is #00b30c — a pure,
 * fully saturated green that exists in no forest.
 *
 * WHAT A VIETNAM JUNGLE WANTS INSTEAD, and what every number below is doing:
 *
 *   · LESS CHROMA. A wet tropical canopy is grey-green and olive. Saturation
 *     is what makes foliage read as plastic, and it is the single biggest
 *     difference between these two looks.
 *   · LESS YELLOW. The hue moves a few degrees toward blue. Yellow-green is
 *     spring growth in temperate light; this is a hot, damp, dark forest.
 *   · MORE VALUE RANGE, LESS HUE RANGE. The old palette went from a dark green
 *     base to a lime tip — a hue jump. Real depth in a canopy is one hue at
 *     several values: a dark heart, a mid body, a lit edge.
 *   · VARIETY BETWEEN SPECIES, not within one. The plants that are legitimately
 *     pale — reeds, dry grass, bamboo culms, a plume head — stay pale, and
 *     they are what keeps the mass from going flat.
 *
 * Run:  node tools/namVegPalette.mjs [--dry]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const FILE = "public/levels/nam-valley.v3proj";

/** foliagePlants: [colorBase, colorTip, colorHead?] per type, in map order. */
const PLANTS = [
  ["#26412a", "#4e7038", null],            // Card fern — understory, in shade
  ["#223d27", "#466a33", null],            // Bush
  ["#1f4527", "#557c36", "#5b5240"],       // Nipa palm (head = its trunk)
  ["#234a29", "#5d8739", null],            // Banana — the brightest leaf here
  ["#27452a", "#517437", null],            // Ground cover
  ["#445c33", "#7f8f52", "#bdb178"],       // Reeds — legitimately pale, kept so
  ["#2f5a2c", "#6d9440", "#8a7a4a"],       // Sugar cane (head = the culm)
  ["#1d3a22", "#46682f", null],            // Giant fern — the darkest of them
];

/** susuki / tall plants: the same, per type. */
const TALL = [
  ["#3c6330", "#5c8a3e", "#e8e0cc"],       // plume head stays pale straw
  ["#2b4b24", "#4a7034", "#5c7a45"],
  ["#284923", "#4e7632", "#7d6b55"],
];

/** The tree crowns (the palms) and the two grass systems. */
const TREES = { bottomColor: "#24461c", topColor: "#4a7a2e", sssColor: "#9bae5e", rimColor: "#a8c98a" };
// The grass needed WARMTH putting back. Taken to a low-chroma dark green it
// read BLUE: the sky fill on this map is blue and strong (0.6), and the less
// chroma a surface has of its own, the more of the ambient hue it wears. So
// lighter, and biased back toward yellow-green — just nowhere near the #00b30c
// it started at.
const GRASS = { bladeColor: "#2a4520", tipColor: "#6b9440", bssColor: "#4a7840" };
// revo is the ACTIVE grass system on this map (grassState.system), so these
// are the numbers that actually draw — the  block below is the other
// system, kept in step. Judged live against the original (#3d4f1c/#8fb84a):
// desaturated as far as the plants, the blades went COLD and read blue. Three
// steps were cycled live in the game and the BRIGHTEST was chosen (the user
// called it: at this camera the near and middle ground IS blades, not terrain
// tint, so the blade colour is what you see and brightening it is the fix).
const REVO = { baseColor: "#587f2c", tipColor: "#aed861" };

/**
 * Density, judged live at the RTS camera. The  revo preset must NOT be
 * applied wholesale — its fade ends at 34 m where this camera sees ground to
 * 69, which leaves a bald band — but its shorter blade and heavier clumping
 * are good, and re-checked here they do NOT stripe the field as the old note
 * feared. GPU unchanged: 0.56-0.63 ms either way.
 */
const REVO_DENSITY = { bladeHeight: 0.85, clumpStrength: 0.55, clumpScale: 2.6 };

const dry = process.argv.includes("--dry");
const changes = [];
const set = (obj, key, value, where) => {
  if (!obj || obj[key] === undefined) return;
  if (obj[key] === value) return;
  changes.push(`${where}.${key}  ${obj[key]} → ${value}`);
  obj[key] = value;
};

const p = await readProject(FILE);
const m = p.manifest;

// Foliage plants are stored as an object keyed "0".."7".
const plants = m.foliagePlants ?? {};
PLANTS.forEach(([base, tip, head], i) => {
  const t = plants[i] ?? plants[String(i)];
  if (!t) return;
  set(t, "colorBase", base, `plant ${i} ${t.name ?? ""}`);
  set(t, "colorTip", tip, `plant ${i} ${t.name ?? ""}`);
  if (head) set(t, "colorHead", head, `plant ${i} ${t.name ?? ""}`);
});

// Tall plants live under `susuki`, in whichever shape it uses.
const tallTypes = m.susuki?.plants ?? m.susuki?.types ?? {};
TALL.forEach(([base, tip, head], i) => {
  const t = tallTypes[i] ?? tallTypes[String(i)];
  if (!t || typeof t !== "object") return;
  set(t, "colorBase", base, `tall ${i} ${t.name ?? ""}`);
  set(t, "colorTip", tip, `tall ${i} ${t.name ?? ""}`);
  if (head) set(t, "colorHead", head, `tall ${i} ${t.name ?? ""}`);
});

// Trees, and the two grass systems, wherever their colours sit in the section.
const deepSet = (node, patch, where) => {
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(patch)) if (node[k] !== undefined) set(node, k, v, where);
  for (const [k, v] of Object.entries(node)) if (v && typeof v === "object") deepSet(v, patch, `${where}.${k}`);
};
deepSet(m.trees, TREES, "trees");
deepSet(m.grass, GRASS, "grass");
deepSet(m.revoGrass, REVO, "revoGrass");
deepSet(m.revoGrass, REVO_DENSITY, "revoGrass");

console.log(changes.length ? changes.join("\n") : "nothing to change");
if (!dry && changes.length) {
  await writeProject(FILE, p);
  console.log(`\nwrote ${FILE}`);
}
