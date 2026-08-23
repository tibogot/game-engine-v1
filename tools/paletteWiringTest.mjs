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
import { fileURLToPath, pathToFileURL } from "node:url";
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
    // ONE preset. `road-preset` (Apex), `road-preset-rushline`,
    // `road-preset-parkour`, `road-demo` and `road-circuit` were deliberately
    // removed: every one of them was authored against OLDER roadParams, so
    // pieces loaded from them are built to a cross-section the kit no longer
    // ships — misleading to debug against. audittest.json is the single
    // reference track. The JSON files themselves stay on disk as TEST FIXTURES
    // (rushline.json alone is read by nine tools).
    "road-save", "road-load", "road-preset-audit",
    "road-drive", "road-snap", "road-rebake",
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
  // WORDS, not characters: the legend is mostly <kbd> markup, so a character
  // budget flags an honest key list as a wall of prose. What we actually care
  // about is that the panel holds LABELS, not paragraphs.
  const panelText = (html.split('id="build-hints"')[1] ?? "").split("</div>")[0]
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ").trim();
  const panelWords = panelText ? panelText.split(/\s+/).length : 0;
  check(`the panel holds a key list, not prose (${panelWords} words)`, panelWords < 90,
    `${panelWords} words — the ~700-word manual belongs behind "?"`);
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

console.log("\n=== EVERY SHORTCUT IS DOCUMENTED ===");
{
  // This is the check that pays for moving the manual out of sight. Docs behind
  // a "?" rot precisely because nobody sees them go stale, so the bindings are
  // read out of the CODE and every one has to appear in the manual.
  const manual = html.split('id="build-help-body"')[1] ?? "";

  // 1. PIECE HOTKEYS — from the REAL catalog, not scraped. A regex over the kit
  //    paired ids with the wrong keys (the id/key pattern spans entries), which
  //    is exactly the sort of wrong-but-confident answer a test should not give.
  const { PIECE_CATALOG } = await import(
    pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
  const pieceKeys = PIECE_CATALOG.filter((p) => p.key).map((p) => ({ id: p.id, key: p.key }));
  check(`the catalog declares piece hotkeys (${pieceKeys.length})`, pieceKeys.length > 10);
  const undocumented = pieceKeys.filter(
    (k) => !new RegExp(`<kbd>${k.key.toUpperCase()}</kbd>`, "i").test(manual));
  check("every piece hotkey appears in the manual", undocumented.length === 0,
    `missing: ${undocumented.map((k) => `${k.key} (${k.id})`).join(", ")}`);
  const dupes = pieceKeys.filter((k, i) => pieceKeys.findIndex((o) => o.key === k.key) !== i);
  check("...and no two pieces share one", dupes.length === 0,
    `duplicated: ${dupes.map((k) => k.key).join(", ")}`);

  // 2. NO PIECE KEY IS DEAD. The outer handler runs before the piece lookup and
  //    RETURNS on what it claims, so anything it takes there is unreachable as a
  //    piece key — the Brow sat on `b` (the build/drive toggle) for a while with
  //    a shortcut that could never fire. Only the region above the drive branch
  //    counts: `keyc` and `keyh` are also matched inside `if (mode === "drive")`,
  //    which cannot shadow a build-mode key.
  const outer = game.slice(
    game.indexOf("if (PREVENT_DEFAULT.has(code))"),
    game.indexOf('if (mode === "drive") {', game.indexOf("if (PREVENT_DEFAULT.has(code))")),
  );
  check("the shadow-check region was found", outer.length > 20 && outer.length < 2000,
    `${outer.length} chars — the handler was restructured, re-anchor this`);
  const eaten = pieceKeys.filter((k) => new RegExp(`code === "key${k.key}"`).test(outer));
  check("no piece hotkey is intercepted before the piece lookup", eaten.length === 0,
    `dead keys: ${eaten.map((k) => `${k.key} (${k.id})`).join(", ")} — the outer ` +
    `handler returns on these, so the piece can never be selected by keyboard`);

  // 3. EVERY EDITOR BINDING in the build-mode handler is documented too.
  const cases = [...game.matchAll(/case "key([a-z])":/g)].map((m) => m[1]);
  const editorUndoc = [...new Set(cases)].filter(
    (c) => !new RegExp(`<kbd>${c.toUpperCase()}</kbd>`, "i").test(manual));
  check(`every editor letter binding is in the manual (${new Set(cases).size} distinct)`,
    editorUndoc.length === 0, `missing: ${editorUndoc.join(", ")}`);

  // 4. ...and the arrows, which are the newest and easiest to forget.
  for (const [name, entity] of [["left", "&larr;"], ["right", "&rarr;"], ["up", "&uarr;"], ["down", "&darr;"]]) {
    check(`arrow ${name} is documented`, manual.includes(entity), `no ${entity} in the manual`);
  }
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
