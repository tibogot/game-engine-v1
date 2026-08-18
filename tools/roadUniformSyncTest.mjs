/**
 * Guards `syncRoadUniforms` against drift in modularRoadMaterial.js.
 *
 * `createRoadMaterial` declares ~28 uniforms; `syncRoadUniforms` copies them via
 * two hand-maintained lists (colours by name, numbers in NUMERIC_UNIFORMS). A
 * uniform that exists in one and not the other fails SILENTLY — nothing throws,
 * the control just does nothing. That is exactly what happened to `linesOn`:
 * the game pokes `_roadUniforms.linesOn.value` directly so it worked in-game,
 * while the road-piece-lab's "Road lines" toggle went through syncRoadUniforms
 * and was dropped on the floor.
 *
 * This reads the source rather than importing it: the module is TSL/WebGPU and
 * bare `three` resolves to the WebGL build outside vite's alias.
 *
 *   node tools/roadUniformSyncTest.mjs
 */
import fs from "node:fs";

const FILE = "games/modular-road-v3/modularRoadMaterial.js";
const src = fs.readFileSync(new URL(`../${FILE}`, import.meta.url), "utf8");

/**
 * Sources the sync lists may be assembled from. The wet-road model owns its own
 * key lists (modularRoadWet.js) and ROAD_LOOK_* spreads them in, so resolving a
 * `...NAME` means looking there too. Its uniforms are still DECLARED in
 * createRoadMaterial's `u` block, which is what keeps the check below honest.
 */
const SOURCES = {
  [FILE]: src,
  "games/modular-road-v3/modularRoadWet.js": fs.readFileSync(
    new URL("../games/modular-road-v3/modularRoadWet.js", import.meta.url), "utf8",
  ),
};

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

/** Keys of the `const u = { ... }` object literal in createRoadMaterial. */
function declaredUniforms() {
  const start = src.indexOf("export function createRoadMaterial");
  const open = src.indexOf("const u = {", start);
  if (open < 0) throw new Error(`${FILE}: cannot find the uniform block`);
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", open); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const block = src.slice(open, end);
  const keys = new Set();
  // top-level `name: uniform(...)` only — nested braces are inside uniform(...)
  let d = 0;
  for (const line of block.split("\n")) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*uniform\(/.exec(line);
    if (m && d <= 1) keys.add(m[1]);
    for (const ch of line) {
      if (ch === "{") d++;
      else if (ch === "}") d--;
    }
  }
  return keys;
}

/**
 * Contents of an exported `const NAME = [ "a", "b", ...OTHER ]` list, with any
 * spread of another exported list resolved recursively across SOURCES.
 */
function list(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`circular list spread at ${name}`);
  seen.add(name);
  for (const [file, text] of Object.entries(SOURCES)) {
    const m = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
    if (!m) continue;
    const out = new Set([...m[1].matchAll(/"([\w$]+)"/g)].map((x) => x[1]));
    for (const [, spread] of m[1].matchAll(/\.\.\.([A-Z][\w$]*)/g)) {
      for (const k of list(spread, seen)) out.add(k);
    }
    if (out.size === 0) throw new Error(`${file}: ${name} resolved to nothing`);
    return out;
  }
  throw new Error(`cannot find ${name} in ${Object.keys(SOURCES).join(", ")}`);
}

const declared = declaredUniforms();
const colours = list("ROAD_LOOK_COLORS");
const numbers = list("ROAD_LOOK_NUMBERS");

console.log(`     ${declared.size} uniforms declared · ${colours.size} colour · ${numbers.size} numeric`);
check(declared.size > 20, "found the uniform block (sanity)");

const missing = [...declared].filter((k) => !colours.has(k) && !numbers.has(k));
check(missing.length === 0, `every declared uniform is syncable${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);

const stale = [...colours, ...numbers].filter((k) => !declared.has(k));
check(stale.length === 0, `no sync entry names a uniform that no longer exists${stale.length ? ` — stale: ${stale.join(", ")}` : ""}`);

const both = [...numbers].filter((k) => colours.has(k));
check(both.length === 0, `no uniform synced as both colour and number${both.length ? ` — ${both.join(", ")}` : ""}`);

/* The same trap one level down: modularRoadWet.js documents its knobs on
 * WET_DEFAULTS and lists them in WET_COLORS/WET_NUMBERS. A key in the defaults
 * but not the lists never reaches a uniform; a key in the lists but not the
 * defaults reaches one with `undefined` and the uniform quietly keeps whatever
 * the material's own fallback was. */
const wetKeys = new Set([...list("WET_COLORS"), ...list("WET_NUMBERS")]);
const wetDefaults = (() => {
  const text = SOURCES["games/modular-road-v3/modularRoadWet.js"];
  const open = text.indexOf("export const WET_DEFAULTS = {");
  const close = text.indexOf("\n};", open);
  if (open < 0 || close < 0) throw new Error("cannot find WET_DEFAULTS");
  return new Set(
    [...text.slice(open, close).matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((x) => x[1]),
  );
})();
const wetUnlisted = [...wetDefaults].filter((k) => !wetKeys.has(k));
const wetUndefaulted = [...wetKeys].filter((k) => !wetDefaults.has(k));
check(
  wetUnlisted.length === 0,
  `every WET_DEFAULTS key is listed${wetUnlisted.length ? ` — missing: ${wetUnlisted.join(", ")}` : ""}`,
);
check(
  wetUndefaulted.length === 0,
  `every listed wet key has a default${wetUndefaulted.length ? ` — missing: ${wetUndefaulted.join(", ")}` : ""}`,
);

// The specific regression: the lab passes plain booleans for the on/off flags,
// and assigning `false` to a float uniform does not read as 0.
check(numbers.has("linesOn"), "linesOn is synced (the road-lines toggle)");
check(
  /typeof p\[k\] === "boolean"/.test(src),
  "boolean flags are coerced to 0/1 rather than assigned raw",
);

/* ── the lab → game path ──────────────────────────────────────────────────
 * A look leaves the lab as JSON and comes back through syncRoadUniforms, so
 * readRoadLook must be the EXACT inverse or every save→load cycle shifts the
 * colours. `lin()` runs convertSRGBToLinear on a Color the constructor has
 * already moved into the working space, so undoing only one of those steps
 * looks correct and drifts.
 */
console.log("\n— look round-trip —");
const { Color, ColorManagement } = await import("three");

const toLinear = (hex) => new Color(hex).convertSRGBToLinear();          // lin()
const scratch = new Color();
const toHex = (c) => scratch.copy(c).convertLinearToSRGB().getHex();     // readRoadLook()

check(
  /convertLinearToSRGB\(\)\.getHex\(\)/.test(src),
  "readRoadLook inverts both the transfer function and the constructor",
);

for (const managed of [true, false]) {
  ColorManagement.enabled = managed;
  let worst = 0;
  let worstHex = 0;
  for (const hex of [0x000000, 0xffffff, 0x5c626a, 0xd0342c, 0x8a919a, 0x35e0ff, 0x010203]) {
    let v = hex;
    for (let cycle = 0; cycle < 8; cycle++) v = toHex(toLinear(v)); // 8 save/load cycles
    const drift = Math.max(
      Math.abs(((v >> 16) & 255) - ((hex >> 16) & 255)),
      Math.abs(((v >> 8) & 255) - ((hex >> 8) & 255)),
      Math.abs((v & 255) - (hex & 255)),
    );
    if (drift > worst) { worst = drift; worstHex = hex; }
  }
  check(
    worst <= 1,
    `ColorManagement ${managed ? "on " : "off"}: 8 round-trips drift ≤1/255 ` +
    `(worst ${worst} on #${worstHex.toString(16).padStart(6, "0")})`,
  );
}

console.log(failed ? `\n${failed} check(s) failed` : "\nroad look pipeline is complete");
process.exit(failed ? 1 : 0);
