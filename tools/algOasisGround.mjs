/**
 * THE OASIS GROUND (alg-aures.v3proj paint layer 3, "Oasis grove") — you,
 * 2026-10-02: by the oasis village "a green and brown texture that looks the
 * same but tinted… it's tiling and looks bad from this RTS view, compared to
 * the other textures around". It was Poly Haven's forrest_ground_01: a ~2 m
 * close-up of a European forest floor (twigs, leaves) stretched to 7.3 m and
 * repeated dozens of times across the screen — its bright twigs printed the
 * repeat in streaks.
 *
 * Now Poly Haven's rocky_terrain_02 (CC0): an AERIAL photo of 90 m of grassy
 * ground with stones — the same photo the ground cache bakes as far grass —
 * at a scale where one copy spans most of a village. Files in
 * public/textures/ground/rocky_terrain_02/ (1k, like every other layer: the
 * terrain's layer array is one size).
 *
 *   node tools/algOasisGround.mjs [--uv 16] [--tint #ece6cf]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const FILE = "public/levels/alg-aures.v3proj";
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const UV = Number(arg("uv", 16));        // repeats across the 1024 m map: 16 → a 64 m tile
const TINT = arg("tint", "#ece6cf");

const p = await readProject(FILE);
const L = p.manifest.paintLayers[3];
if (L?.name !== "Oasis grove") throw new Error(`layer 3 is "${L?.name}", not the Oasis grove`);
const tex = (s) => ({ name: `rocky_terrain_02_${s}_1k.jpg`, url: `/textures/ground/rocky_terrain_02/rocky_terrain_02_${s}_1k.jpg` });
Object.assign(L, { albedo: tex("diff"), normal: tex("nor_gl"), rough: tex("rough"), ao: tex("ao"), uvScale: UV, tint: TINT });
await writeProject(FILE, p);
console.log(`Oasis grove → rocky_terrain_02, uvScale ${UV} (${(1024 / UV).toFixed(0)} m tile), tint ${TINT}`);
