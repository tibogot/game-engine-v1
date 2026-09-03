/**
 * Guards the colour-space fix: authored hexes are converted sRGB→linear ONCE.
 *
 *   node tools/lookRebaseTest.mjs
 *
 * Up to track v2 every authored colour went through the transfer function TWICE
 * (`new THREE.Color(hex)` already linearises; the helpers called
 * `convertSRGBToLinear()` on top), so colours rendered 5–10× darker and more
 * saturated than their hex implied. The helpers now convert once, the literals
 * were rebased so the render did not move, and migrateV2toV3 does the same to
 * colours inside saved tracks.
 *
 * Three ways that can rot, all checked here:
 *   1. A literal is edited back into the old space, or a NEW colour is added
 *      through a path that converts twice again.
 *   2. The migration's maths drifts from the maths used on the literals — then
 *      every saved track loads at a different brightness from a fresh one.
 *   3. A colour that was ALREADY correct (the gate/checkpoint glows never went
 *      through `lin()`) gets rebased by mistake and goes dark.
 *
 * Expectations are derived from a git BASELINE vs the working tree, never
 * hand-typed: a hand-typed table is how the first version of this test "failed"
 * on five correct values.
 *
 * THE BASELINE IS PINNED, and that pin is what keeps this test alive. It used to
 * read `HEAD`, which works only while the rebase is sitting UNCOMMITTED in the
 * working tree — the moment it was committed, HEAD and the tree became identical,
 * nothing differed, and the "something actually changed" sentinel failed forever.
 * The test was self-expiring: it could never pass again once the work it guards
 * was saved. Pinning to the commit BEFORE the rebase means it keeps comparing the
 * shipped literals against their pre-fix originals for as long as the file lives.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateTrack, TRACK_VERSION } from "../games/modular-road-v3/modularRoadTrackIO.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME = "games/modular-road-v3";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "  " + detail : "")); }
};
const hex = (n) => "0x" + (n >>> 0).toString(16).padStart(6, "0");

/**
 * Rebase one colour THROUGH THE SHIPPING MIGRATION, so this test can never
 * drift from the code it is checking by re-implementing the maths.
 */
function rebase(value) {
  const { data } = migrateTrack({ version: 2, roadLook: { railA: value } }, {});
  return data.roadLook.railA;
}

const HEX_G = /0x[0-9a-fA-F]{6}\b/g;

/**
 * Hexes in CODE only. Prose is full of them — the notes explaining this very
 * fix quote the old values, and a comment elsewhere names a body colour — and
 * counting those breaks the positional pairing for no reason. The `[^:]` guard
 * keeps `https://` from being read as a line comment.
 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const readHexes = (text) =>
  (stripComments(text).match(HEX_G) ?? []).map((h) => parseInt(h, 16));

/**
 * The last commit BEFORE the colour-space fix landed (49f6bcd). Pinned, not
 * `HEAD` — see the header. If history is ever rewritten this SHA must be moved
 * with it; the test says so loudly rather than silently passing.
 */
const BASELINE = "e81eaa4";

/**
 * Colours deliberately changed AFTER the rebase — art choices, not migration
 * failures. Keyed by the BASELINE value they replaced, so the same literal
 * drifting to some third value still fails.
 */
const INTENTIONAL = new Map([
  // Glass-road deck panel: lacquered white -> lacquered yellow.
  [0xf4f4f2, 0xf1c40f],
]);

/** The file as it was before the colour fix. */
function atHead(rel) {
  try {
    return execFileSync("git", ["show", `${BASELINE}:${rel}`], {
      cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// ── 1. Literals: every hex is unchanged, or exactly its rebase. ──────────────
console.log(`rebased literals (${BASELINE} vs working tree)`);

const FILES = [
  `${GAME}/modularRoadMaterial.js`,
  `${GAME}/modularRoadSky.js`,
  `${GAME}/modularRoadTireMarks.js`,
  `${GAME}/modularRoadProps.js`,
  `${GAME}/modularRoadWet.js`,
];

let totalChanged = 0;
for (const rel of FILES) {
  const head = atHead(rel);
  if (head === null) { check(`${rel}: readable at HEAD`, false, "git show failed"); continue; }
  const now = fs.readFileSync(path.join(ROOT, rel), "utf8");

  const before = readHexes(head);
  const after = readHexes(now);

  if (before.length !== after.length) {
    check(
      `${path.basename(rel)}: hex count stable`,
      false,
      `HEAD ${before.length}, now ${after.length} — cannot pair positionally`
    );
    continue;
  }

  const bad = [];
  let changed = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    changed++;
    if (after[i] === rebase(before[i])) continue;          // rebased correctly
    if (INTENTIONAL.get(before[i]) === after[i]) continue; // a deliberate re-colour
    bad.push(`#${i} ${hex(before[i])} -> ${hex(after[i])}, expected ${hex(rebase(before[i]))}`);
  }
  totalChanged += changed;
  check(
    `${path.basename(rel)}: ${changed} changed, all match the migration`,
    bad.length === 0,
    bad.join("; ")
  );
}
check("something actually changed", totalChanged > 0, `${totalChanged}`);

// ── 2. Colours that were already correct must NOT have moved. ────────────────
// These build MeshStandardMaterials directly and never went through `lin()`,
// so they were single-converted all along.
console.log("\nalready-correct colours left alone");
{
  const src = fs.readFileSync(path.join(ROOT, GAME, "modularRoadMaterial.js"), "utf8");
  for (const glow of ["0xc8e8ff", "0x3dff8a", "0xff4ec8", "0xffe14a", "0x0a0c10"]) {
    check(`${glow} (gate / checkpoint glow) still present`, src.includes(glow));
  }
}

// ── 3. Migration behaviour. ──────────────────────────────────────────────────
console.log("\nmigration behaviour");
{
  const { data, steps } = migrateTrack({ version: 2, roadLook: { asphaltDark: 0x5c626a } }, {});
  check(`advances to v${TRACK_VERSION}`, data.version === TRACK_VERSION, `got v${data.version}`);
  check("records the step", steps.length === 1 && steps[0] === "v2→v3", steps.join(","));

  check("black is a fixed point", rebase(0x000000) === 0x000000, hex(rebase(0x000000)));
  check("white is a fixed point", rebase(0xffffff) === 0xffffff, hex(rebase(0xffffff)));
  check("rebase darkens a mid grey", rebase(0x808080) < 0x808080, hex(rebase(0x808080)));

  const { data: nums } = migrateTrack(
    { version: 2, roadLook: { linesOn: 1, deckBrightness: 1.4, streak: 12 } }, {}
  );
  check("linesOn untouched", nums.roadLook.linesOn === 1);
  check("deckBrightness untouched", nums.roadLook.deckBrightness === 1.4);
  check("streak untouched", nums.roadLook.streak === 12);
  check("absent colour stays absent", !("asphaltDark" in nums.roadLook));

  check("no roadLook -> none invented", migrateTrack({ version: 2 }, {}).data.roadLook === undefined);

  const at3 = { version: 3, roadLook: { asphaltDark: 0x1b1f25 } };
  const { data: same, steps: none } = migrateTrack(at3, {});
  check("v3 is a no-op", same.roadLook.asphaltDark === 0x1b1f25 && none.length === 0);
  check("re-running v3 is stable", migrateTrack(same, {}).data.roadLook.asphaltDark === 0x1b1f25);

  // The source of truth for "what a default track should end up at".
  const src = fs.readFileSync(path.join(ROOT, GAME, "modularRoadMaterial.js"), "utf8");
  const defAsphalt = /asphaltDark: uniform\(lin\(opts\.asphaltDark \?\? (0x[0-9a-fA-F]{6})\)\)/.exec(src);
  check("asphaltDark default is readable from source", !!defAsphalt);
  if (defAsphalt) {
    const want = parseInt(defAsphalt[1], 16);
    const got = migrateTrack({ version: 2, roadLook: { asphaltDark: 0x5c626a } }, {}).data.roadLook.asphaltDark;
    check(
      `a v2 track's default asphalt lands on the build default ${hex(want)}`,
      got === want, `got ${hex(got)}`
    );
  }
}

// ── 4. The shipped tracks. ───────────────────────────────────────────────────
console.log("\nshipped tracks");
{
  const src = fs.readFileSync(path.join(ROOT, GAME, "modularRoadMaterial.js"), "utf8");
  const want = parseInt(
    /asphaltDark: uniform\(lin\(opts\.asphaltDark \?\? (0x[0-9a-fA-F]{6})\)\)/.exec(src)[1], 16
  );
  const dir = path.join(ROOT, GAME);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (!raw?.pieces) continue;
    const before = raw?.roadLook?.asphaltDark;
    if (typeof before !== "number") { check(`${f}: no saved asphalt, inherits the default`, true); continue; }
    const got = migrateTrack(raw, {}).data.roadLook.asphaltDark;
    check(`${f}: ${hex(before)} -> ${hex(got)}`, got === want, `expected ${hex(want)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
