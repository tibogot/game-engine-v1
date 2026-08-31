// ============================================================================
// Lint the modules whose function bodies are DEFERRED INTO SHADER COMPILATION.
//
// See tools/shaderLint.config.mjs for why this exists. Short version: TSL `Fn`
// bodies do not run until a real device builds the shader, so a plain
// ReferenceError inside one is invisible to every headless test — it surfaces
// as a black material on screen and nothing else. `no-undef` reads the body
// without running it, which is the only cheap way to see inside.
//
// SCOPE. The list below is the set of files that build TSL graphs, not the
// whole game. Adding a shader module? Add it here — a file that is not listed
// is not checked, and the failure it can ship is a black screen.
//
// Run: node tools/shaderLint.mjs [--all]
//   --all  also lint the rest of games/modular-road-v3, as a wider sweep
// ============================================================================
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Modules that build TSL node graphs — bodies a normal test cannot reach. */
const SHADER_MODULES = [
  "games/modular-road-v3/modularRoadMaterial.js",
  "games/modular-road-v3/modularRoadSurfaceV2.js",
  "games/modular-road-v3/modularRoadWet.js",
  "games/modular-road-v3/modularRoadRail.js",
  "games/modular-road-v3/modularRoadReflection.js",
  "games/modular-road-v3/modularRoadDriftSmoke.js",
  "games/modular-road-v3/modularRoadTireMarks.js",
  "games/modular-road-v3/modularRoadSky.js",
  "games/modular-road-v3/modularRoadClouds.js",
  // Builds TSL graphs too, as of the tail-light housing mask — see
  // makeTailHousingMaterial. Added here per the rule in the header: a shader
  // module that is not listed is not checked, and what it can ship is a black
  // material.
  "games/modular-road-v3/chassisModel.js",
  "games/modular-road-v3/modularRoadRainLens.js",
  "games/modular-road-v3/rainLab.js",
];

const wide = process.argv.includes("--all");
const targets = wide
  ? [join(ROOT, "games/modular-road-v3")]
  : SHADER_MODULES.map((f) => join(ROOT, f));

const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: join(ROOT, "tools/shaderLint.config.mjs"),
  errorOnUnmatchedPattern: false,
});

const results = await eslint.lintFiles(targets);

let errors = 0;
let warnings = 0;
for (const r of results) {
  if (!r.messages.length) continue;
  const rel = relative(ROOT, r.filePath).replace(/\\/g, "/");
  for (const m of r.messages) {
    const kind = m.severity === 2 ? "ERROR" : "warn ";
    if (m.severity === 2) errors++; else warnings++;
    console.log(`${kind}  ${rel}:${m.line}:${m.column}  ${m.message}  (${m.ruleId ?? "?"})`);
  }
}

console.log(
  `\n${results.length} shader module(s) linted · ${errors} error(s) · ${warnings} warning(s)`,
);
if (errors) {
  console.log(
    "\nAn undefined name in a TSL Fn body is a ReferenceError at SHADER BUILD time.\n"
    + "It will not fail any headless test — it renders the material black.",
  );
}
process.exit(errors ? 1 : 0);
