// The engine/game boundary (v3/engine.js, v3/AUDIT.md #104).
//
// A game imports the engine through v3/engine.js or a module listed in its
// PUBLIC_ENGINE_MODULES — never an engine internal by path, so the engine can
// change inside without breaking games. And the engine never imports a game:
// the wet-road shading lived in games/modular-road-v3 and v3's asphalt reached
// into it, which is how a game folder becomes impossible to delete or copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) fail++;
};

// The list is read from the file's text: importing engine.js would boot three/webgpu.
const engineSrc = fs.readFileSync(path.join(ROOT, "v3/engine.js"), "utf8");
const listSrc = engineSrc.match(/PUBLIC_ENGINE_MODULES\s*=\s*\[([\s\S]*?)\];/)?.[1] ?? "";
const PUBLIC = new Set([...listSrc.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
check("PUBLIC_ENGINE_MODULES is readable", PUBLIC.size > 0);
for (const p of PUBLIC) check(`public module exists: ${p}`, fs.existsSync(path.join(ROOT, p)));

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(m?js|html)$/.test(e.name)) yield p;
  }
}

// Static `from "x"`, bare `import "x"` and dynamic `import("x")` — only relative specifiers.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\1/g;
function importsOf(file) {
  const out = [];
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(SPEC)) {
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ target: rel(path.resolve(path.dirname(file), m[2].split("?")[0])), line });
  }
  return out;
}

const gameViolations = [];
for (const file of walk(path.join(ROOT, "games"))) {
  for (const { target, line } of importsOf(file)) {
    if (!/^(v3|v2)\//.test(target)) continue;
    if (target === "v3/engine.js" || PUBLIC.has(target)) continue;
    gameViolations.push(`${rel(file)}:${line} → ${target}`);
  }
}
check("games import the engine only through v3/engine.js or a public module",
  gameViolations.length === 0, gameViolations.join("\n      "));

const engineViolations = [];
for (const dir of ["v3", "v2"]) {
  for (const file of walk(path.join(ROOT, dir))) {
    for (const { target, line } of importsOf(file)) {
      if (target.startsWith("games/")) engineViolations.push(`${rel(file)}:${line} → ${target}`);
    }
  }
}
check("the engine never imports from games/", engineViolations.length === 0, engineViolations.join("\n      "));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
