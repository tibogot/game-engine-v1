// THE PALETTE IS WIRED BY HAND, BY ID — so a rename in the markup is a button
// that silently stops working, with no error anywhere.
//
// buildRoadPaletteUI() (modularRoadBuilder.js) and roadGame.js both do
// `document.getElementById("road-…")?.addEventListener(…)`. Every one of those
// lookups is optional-chained, which is right — the same code drives the lab
// page, which has fewer buttons — and it means a typo or a dropped element fails
// completely silently. This test is the thing that notices.
//
// It is a text check on purpose: the palette needs a DOM and a WebGPU device to
// run for real, and neither is available here. Reading both sides and comparing
// the id sets catches the failure that actually happens.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, "games/modular-road-v3", p), "utf8");
const html = read("road.html");
const game = read("roadGame.js");
const builder = read("modularRoadBuilder.js");

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};

/** Every id road.html defines. */
const declared = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));

/**
 * Every id the JS reaches for. Both spellings: the direct getElementById, and
 * roadGame's `onClick("id", …)` helper.
 */
function wiredIn(src, label) {
  const ids = new Set();
  for (const m of src.matchAll(/getElementById\("([\w-]+)"\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/onClick\("([\w-]+)"/g)) ids.add(m[1]);
  for (const m of src.matchAll(/loadPresetTrack\("([\w-]+)"/g)) ids.add(m[1]);
  return { ids, label };
}

// Ids that live on OTHER pages this code also drives, or are injected at
// runtime — not road.html's job to declare.
const ELSEWHERE = new Set([
  "hint",       // the lab page's status strip (modular-road.html)
]);

console.log("\n=== EVERY WIRED ID EXISTS IN THE MARKUP ===");
for (const { ids, label } of [wiredIn(game, "roadGame.js"), wiredIn(builder, "modularRoadBuilder.js")]) {
  const missing = [...ids].filter((id) => !declared.has(id) && !ELSEWHERE.has(id));
  check(`${label}: all ${ids.size} wired ids are in road.html`, missing.length === 0,
    `missing from road.html: ${missing.join(", ")}`);
}

console.log("\n=== THE BUTTONS THE TOOLBAR REGROUPING TOUCHED ===");
{
  // Named explicitly, because these are the ones that moved between groups and
  // an accidental drop would look like "that button just does nothing now".
  const mustExist = [
    "road-place", "road-other-end", "road-link", "road-branch", "road-flip",
    "road-new-chain", "road-prev-chain", "road-next-chain", "road-undo",
    "road-save", "road-load", "road-preset", "road-preset-rushline",
    "road-demo", "road-circuit", "road-drive", "road-snap", "road-rebake",
    "road-clear", "road-status", "build-mode-toggle", "edges-toggle",
    "category-list", "piece-grid", "category-title", "palette-collapse-tab",
  ];
  const gone = mustExist.filter((id) => !declared.has(id));
  check(`all ${mustExist.length} palette controls still exist`, gone.length === 0,
    `gone: ${gone.join(", ")}`);
  // ...and exactly once each. A duplicate id means getElementById silently picks
  // the first, which is how you get a button that looks wired and is not.
  const dupes = mustExist.filter(
    (id) => (html.match(new RegExp(`id="${id}"`, "g")) || []).length > 1);
  check("...and none of them is declared twice", dupes.length === 0, `duplicated: ${dupes.join(", ")}`);
}

console.log("\n=== THE MANUAL OVERLAY ===");
{
  for (const id of ["build-help", "build-help-close", "build-help-body", "road-help", "road-help-link"]) {
    check(`#${id} exists`, declared.has(id));
  }
  check("the overlay starts hidden", /<div id="build-help" hidden>/.test(html),
    "otherwise it covers the editor on boot");
  check("it is OUTSIDE #palette", html.indexOf('id="build-help"') > html.indexOf('id="palette-collapse-tab"'),
    "nested inside the palette it would inherit the panel's width and clipping");
  check("the scoped CSS variables reach it",
    /#palette, #inspector, #build-help \{/.test(read("palette.css")),
    "palette.css scopes its variables; without #build-help in that list every " +
    "var() in the overlay resolves to nothing");
  check("the prose really moved (the panel is not still a wall of text)",
    (html.split('id="build-hints"')[1] ?? "").split("</div>")[0].length < 1200,
    "#build-hints should now hold the key legend, not paragraphs");
  check("...and landed in the manual", html.split('id="build-help-body"')[1]?.includes("Junctions"),
    "the junction section should be in the overlay now");
}

console.log("\n=== THE KEY LEGEND MATCHES THE REAL SHORTCUTS ===");
{
  // The legend is a promise about what the keys do; this checks the promise
  // against the handler, so a rebind cannot quietly leave the panel lying.
  const legend = (html.split('id="key-legend"')[1] ?? "").split("</div>")[0];
  const pairs = [["O", "keyo"], ["J", "keyj"], ["K", "keyk"], ["N", "keyn"], ["R", "keyr"], ["W", "keyw"]];
  for (const [label, code] of pairs) {
    const inLegend = new RegExp(`<kbd>${label}</kbd>`).test(legend);
    const inCode = new RegExp(`case "${code}":`).test(game);
    check(`legend "${label}" is a real binding`, inLegend && inCode,
      `legend:${inLegend} handler(case "${code}"):${inCode}`);
  }
  check('"B" (drive) is handled', /code === "keyb"/.test(game));
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
