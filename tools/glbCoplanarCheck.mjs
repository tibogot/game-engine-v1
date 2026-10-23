/**
 * THE BLENDER MODELS: NO COPLANAR OVERLAPS (z-fighting) — 2026-10-22, you, zoomed on the post: "few z index shader
 * issues, on each corner here, on the clothes hanging … I thought we made a tool to avoid those issues". We had —
 * tools/rtsPropsCoplanarTest.mjs — but it only builds the JS kits; the Blender pieces (public/models/alg/*.glb:
 * the post, the houses, the walls, the bags…) arrive as files it never opened.
 *
 * (A CHECK, not yet in npm test — a "*Test.mjs" joins the lane — until the models pass: the far levels and the cloth
 * sandbags still have leftovers.)
 *
 * Every mesh of every model (each variant on its own — intact / damaged / ruin, near / far: they are never drawn
 * together) through the same check (tools/lib/coplanar.mjs): two triangles in one plane, overlapping.
 *
 *   node tools/glbCoplanarCheck.mjs [--all]     (--all: list every pair's mesh, not just the first)
 */
import fs from "node:fs";
import path from "node:path";
import { readGlb } from "./lib/glbRead.mjs";
import { coplanarOverlaps } from "./lib/coplanar.mjs";

const DIRS = process.argv.slice(2).filter((a) => !a.startsWith("--")).length ? process.argv.slice(2).filter((a) => !a.startsWith("--")) : ["public/models/alg"];
// Known and accepted, each with its reason (keep this list short — fix the model instead).
const ALLOW = {};

const geoOf = (n) => ({
  attributes: { position: { count: n.positions.length / 3, getX: (i) => n.positions[3 * i], getY: (i) => n.positions[3 * i + 1], getZ: (i) => n.positions[3 * i + 2] } },
  index: { count: n.indices.length, getX: (k) => n.indices[k] },
});

let failed = 0, meshes = 0;
for (const dir of DIRS) {
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".glb")).sort()) {
    const { nodes } = await readGlb(path.join(dir, f));
    const bad = [];
    for (const n of nodes) {
      meshes++;
      const r = coplanarOverlaps(geoOf(n));
      if (r.pairs && !ALLOW[`${f}:${n.name}`]) bad.push(`${n.name} ${r.pairs} pairs, e.g. ${JSON.stringify(r.first)}`);
    }
    if (bad.length) { failed++; console.log(`  FAIL ${f}: ${bad.length} of ${nodes.length} meshes`); for (const b of bad.slice(0, process.argv.includes("--all") ? 1e9 : 3)) console.log(`         ${b}`); }
    else console.log(`  ok   ${f}  ${nodes.length} meshes`);
  }
}
console.log(failed ? `\n${failed} models with coplanar overlaps (${meshes} meshes checked)` : `\nall passed (${meshes} meshes)`);
process.exit(failed ? 1 : 0);
