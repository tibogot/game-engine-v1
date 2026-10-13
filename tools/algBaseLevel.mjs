/**
 * THE BASE LEVEL every new alg-rts map starts from (2026-10-13): the Aurès' LOOK — its sky, light,
 * grass and plant settings, the plant slot catalogue, its paint slots — and NOTHING ELSE: a flat
 * plain at 20 m, no trees, props, decals, lakes, roads, sea or far terrain (tools/lib/algLevelBase.mjs
 * says what "empty" is). A map tool builds FROM this file every time, not from another map.
 *
 *   node tools/algBaseLevel.mjs            rebuild public/levels/alg-base.v3proj from the Aurès
 */
import { readProject, writeProject } from "./lib/v3proj.mjs";
import { blankManifest, blankBlobs, BASE_LEVEL } from "./lib/algLevelBase.mjs";

const src = await readProject("public/levels/alg-aures.v3proj");
const man = blankManifest(src.manifest);
const bytes = await writeProject(BASE_LEVEL, { manifest: man, blobs: blankBlobs(man) });
console.log(`${BASE_LEVEL}: ${(bytes / 1e6).toFixed(2)} MB — the Aurès' look, nothing in it`);
