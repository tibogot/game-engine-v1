/**
 * THE OASIS GRASS = nam-rts's grass (you, 2026-09-29: "the one I use in rts
 * nam is far better"). Copies nam-valley's grass system choice ("revo") and
 * its revo look (manifest.revoGrass) into alg-aures. The painted density
 * (tools/algOasisLook.mjs, only the damp ring round the pools) is untouched.
 *
 *   node tools/algGrassFromNam.mjs [--file public/levels/alg-aures.v3proj]
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";

const args = process.argv.slice(2);
const FILE = args.includes("--file") ? args[args.indexOf("--file") + 1] : "public/levels/alg-aures.v3proj";
const nam = (await readProject("public/levels/nam-valley.v3proj")).manifest;
const project = await readProject(FILE);
const man = project.manifest;

man.grass = { ...man.grass, ...nam.grass };
man.revoGrass = nam.revoGrass ? structuredClone(nam.revoGrass) : null;
console.log(`grass system ${man.grass.system}; revoGrass ${man.revoGrass ? Object.keys(man.revoGrass).length + " params" : "none (engine defaults)"}`);
await writeProject(FILE, project);
console.log(`wrote ${FILE}`);
