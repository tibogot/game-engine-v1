// Palette thumbnails: baked ONCE, cached in IndexedDB, never on the critical path.
//
// The bake renders ~175 tiles and every one costs a GPU→CPU readback plus a PNG
// encode. It used to run, in full, on every page load — before the first frame.
// Two things fix that, and both have a failure mode that is invisible on screen:
//
//   THE SIGNATURE  too loose and you keep looking at stale tiles after editing a
//                  preset; too tight and the cache never hits and nothing was
//                  gained. It has to cover the items AND the road look, since the
//                  tiles are rendered with the real road materials.
//   THE STATE      the bake now runs WITH the editor's frame loop live, so it
//                  borrows the renderer between frames. Leave the 192px render
//                  target bound across an await and the editor draws into it.
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const src = (f) => readFileSync(join(GAME, f), "utf8");
/** Comments in this module quote the very calls under test ("NOT setViewport()",
 *  "a readback per tile"), so anything counting call sites has to read code only. */
const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const { thumbnailSignature, THUMB_CACHE_VERSION } = await import(
  pathToFileURL(join(GAME, "modularRoadThumbnailCache.js")).href);

const ITEMS = [
  { key: "straight", pieceId: "straight", params: {} },
  { key: "loop_r14", pieceId: "loop", params: { radius: 14, bank: 0 } },
  { key: "cone", make: () => {} },
];
const LOOK = { asphaltDark: 0x2a2d33, deckBrightness: 1.4 };
const base = thumbnailSignature(ITEMS, { size: 192, look: LOOK });

console.log("=== THE SIGNATURE IS STABLE FOR AN UNCHANGED PALETTE ===");
{
  check("same input, same signature",
    thumbnailSignature(ITEMS, { size: 192, look: LOOK }) === base, base);
  // The Blobs are keyed by id inside the record, so a rebuilt-but-identical item
  // list must not force a rebake — this is the whole cache hit.
  const clone = ITEMS.map((it) => ({ ...it, params: it.params ? { ...it.params } : undefined }));
  check("...and for an equal list rebuilt from scratch",
    thumbnailSignature(clone, { size: 192, look: LOOK }) === base);
  check("it carries the manual version, so a bump invalidates everything",
    base.startsWith(`v${THUMB_CACHE_VERSION}.`), `version ${THUMB_CACHE_VERSION}`);
}

console.log("\n=== ...AND CHANGES FOR EVERYTHING THAT CHANGES THE PIXELS ===");
{
  const differs = (label, items, extra = { size: 192, look: LOOK }) =>
    check(label, thumbnailSignature(items, extra) !== base);

  differs("a retuned preset param",
    ITEMS.map((it) => (it.key === "loop_r14" ? { ...it, params: { radius: 20, bank: 0 } } : it)));
  differs("a new piece in the catalog",
    [...ITEMS, { key: "half_pipe", pieceId: "half_pipe", params: {} }]);
  differs("a removed piece", ITEMS.slice(1));
  differs("a piece pointed at a different base",
    ITEMS.map((it) => (it.key === "loop_r14" ? { ...it, pieceId: "loop_spiral" } : it)));
  differs("a different tile size", ITEMS, { size: 128, look: LOOK });
  // Tiles are rendered with the LIVE road material, so a recolour makes every
  // cached PNG a lie. Cheapest possible way to catch that: hash the look.
  differs("a recoloured road", ITEMS, { size: 192, look: { ...LOOK, asphaltDark: 0x808080 } });
  differs("a look number moved", ITEMS, { size: 192, look: { ...LOOK, deckBrightness: 2.2 } });
}

console.log("\n=== WHAT THE SIGNATURE CANNOT SEE NEEDS AN ESCAPE HATCH ===");
{
  // A prop is baked by calling make(); its output is unreachable from here, and
  // so is buildPiece()'s. Editing either changes the tiles with no signature
  // change at all — hence the two manual paths.
  const game = src("roadGame.js");
  const panel = src("devPanel.js");
  check("`?rebake=1` forces the bake path", /URLSearchParams\(location\.search\)[\s\S]{0,40}rebake/.test(game));
  check("...and clears the stored bake first",
    /forceRebake\)\s*await clearThumbnailCache\(\)/.test(game));
  check("the dev panel has a rebake button", panel.includes('id="dv-rebake-thumbs"'));
  check("...wired to the game", /game\.rebakeThumbnails\?\.\(\)/.test(panel));
  check("...which the game actually exposes", /^\s{6}rebakeThumbnails,$/m.test(game));
  check("rebake clears the cache before baking",
    /async function rebakeThumbnails\(\)\s*\{\s*await clearThumbnailCache\(\);\s*await bakeAndCacheThumbnails\(\)/.test(game));
}

console.log("\n=== THE BAKE IS OFF THE STARTUP PATH ===");
{
  const game = src("roadGame.js");
  const iCache = game.indexOf("loadThumbnailCache(thumbSig)");
  const iPalette = game.indexOf("buildRoadPaletteUI(builder");
  const iReady = game.indexOf('onStatus("ready")');
  const iKick = game.indexOf("{ bakeAndCacheThumbnails(); }"); // the rAF kick, not the rebake call
  check("the cache is read before the palette is built", iCache > 0 && iCache < iPalette,
    "a hit has to paint on the FIRST render, not swap in later");
  check("the cold bake is kicked off only after the editor is up and running",
    iKick > iReady && iReady > 0);
  check("...and is NOT awaited by startup",
    !/await bakeAndCacheThumbnails\(\);\s*$/m.test(game.slice(iReady)));
  check("a cold cache is what triggers it", /if \(!thumbsWereCached\)/.test(game));
  check("...one frame late, so the first frame is presented first",
    /requestAnimationFrame\(\(\) => requestAnimationFrame\(/.test(game.slice(iReady)));
  // Two bakes at once would fight over the renderer and double-write the store.
  check("a second bake cannot start while one is running", /if \(thumbBakeRunning\) return;/.test(game));
}

console.log("\n=== BATCHED: ONE READBACK PER PAGE, ONE ENCODE PER SHEET ===");
{
  // Both costs are PER CALL, not per pixel. Measured 2026-08-14 on 174 tiles:
  // readback ~20 ms each, PNG encode ~57 ms each (a 182x bigger sheet: 84 ms),
  // total 6.8 s for the one-target-per-tile shape this replaced.
  const bake = code("modularRoadThumbnails.js");
  const run = bake.slice(bake.indexOf("const drawRun ="), bake.indexOf("const finishSheet ="));
  check("tiles are drawn into cells of one big target",
    /rt\.viewport\.set\(x, y, cell, cell\)/.test(run) && /rt\.scissor\.set\(x, y, cell, cell\)/.test(run));
  // A bound target takes its rect from renderTarget.viewport, NOT setViewport().
  check("...via the target's own viewport, which is what a bound RT reads",
    !/renderer\.setViewport\(/.test(bake));
  // WebGPU's viewport origin is top-left and three passes the rect through
  // unflipped; measuring y up from the bottom mirrors the grid and silently
  // hands tiles each other's pictures.
  check("row 0 is the TOP row, matching the top-first readback",
    /const y = row \* cell;/.test(run) && !/atlas - \(row \+ 1\)/.test(run));
  check("the page is cleared once, then loaded", /if \(first === 0\)[\s\S]{0,120}renderer\.clear\(\)/.test(run));
  check("...so later tiles cannot wipe their neighbours", /renderer\.autoClear = false;/.test(run));
  check("exactly one readback per page",
    (bake.match(/readRenderTargetPixelsAsync/g) || []).length === 1);
  check("...outside the draw run", bake.indexOf("readRenderTargetPixelsAsync") > bake.indexOf("const sliceAtlas ="));
  check("pages are capped under the max texture size", /MAX_ATLAS = 4096/.test(bake));
  // A resolve covers the WHOLE attachment, so an MSAA atlas would resolve
  // 3840² once per tile — measured 17-24 s, worse than what it replaced.
  check("the atlas is NOT multisampled", !/samples:/.test(bake));
  check("...it supersamples and box-filters down instead", /const SS = 2;/.test(bake));
  check("one PNG encode per sheet, not per tile",
    (bake.match(/toBlob\(/g) || []).length === 1
    && bake.indexOf("toBlob(") > bake.indexOf("const finishSheet ="));
}

console.log("\n=== THE RUNNING EDITOR KEEPS THE RENDERER ===");
{
  const bake = code("modularRoadThumbnails.js");
  const run = bake.slice(bake.indexOf("const drawRun ="), bake.indexOf("const finishSheet ="));
  // The bake runs in the background with the frame loop live. Every borrowed
  // piece of renderer state has to be back before anything yields, or the
  // editor draws into the atlas.
  check("the draw run never awaits", !/\bawait\b/.test(run),
    "an await here yields a frame with the atlas still bound");
  for (const [what, saved, restored] of [
    ["render target", "renderer.getRenderTarget()", "renderer.setRenderTarget(prevTarget)"],
    ["clear colour", "renderer.getClearColor(prevClear)", "renderer.setClearColor(prevClear, prevAlpha)"],
    ["autoClear", "renderer.autoClear;", "renderer.autoClear = prevAutoClear;"],
    ["scissor test", "renderer.getScissorTest()", "renderer.setScissorTest(prevScissorTest)"],
  ]) {
    check(`${what} is saved and handed back`, run.includes(saved) && run.includes(restored));
  }
  check("the editor gets a frame between runs", /await nextFrame\(\)/.test(bake));
  check("...and the run length is what bounds the freeze", /runLength = 8/.test(bake));
  // Filtering 175 tiles back to back blocks just as hard as drawing them does.
  check("the slice yields too", /if \(written % SLICE_RUN === 0\) await nextFrame\(\);/.test(bake));
  check("nothing is left bound after the loop instead",
    !/finally\s*\{[^}]*setRenderTarget/.test(bake));
}

console.log("\n=== THE PALETTE PAINTS FROM THE SHEET ===");
{
  const bake = src("modularRoadThumbnails.js");
  const builder = src("modularRoadBuilder.js");
  const css = src("palette.css");
  check("nothing encodes through toDataURL", !/canvas\.toDataURL\(/.test(bake));
  check("sprites are handed out, not one image per tile",
    /export function createThumbnailSprites/.test(bake));
  check("...and the previous sheet's URLs are revoked on a rebake",
    /previous\?\.revoke\(\)/.test(bake) && /URL\.revokeObjectURL\(url\)/.test(bake));
  // Percentage background-position is a ratio, not an offset: the divisor is
  // the number of GAPS, and a single-column sheet has none.
  check("cell offsets use the gap-count form", /\(cols - 1\)/.test(bake) && /\(rows - 1\)/.test(bake));
  check("...and a 1-wide sheet does not divide by zero",
    /cols > 1 \?/.test(bake) && /rows > 1 \?/.test(bake));
  check("the tile element is styled square", /\.tile-sprite\s*\{[^}]*aspect-ratio: 1;/.test(css),
    "a sprite cell is square; the preview box is not");
  check("the palette falls back for unbaked keys",
    /if \(sprite\) \{[\s\S]{0,80}\} else \{[\s\S]{0,120}placeholderSvg\(\)/.test(builder));
  check("the palette can adopt a set after it was built",
    /function setThumbnails\(next\)/.test(builder));
  check("...and is exported", /return \{[^}]*setThumbnails[^}]*\};/.test(builder));
  // renderPieces() clears activePropId/activeMoverId — calling it two seconds in
  // would silently disarm a prop brush the user is holding.
  const setFn = builder.slice(builder.indexOf("function setThumbnails(next)"));
  check("...without re-rendering the grid under a live brush",
    !setFn.slice(0, setFn.indexOf("\n  }")).includes("renderPieces()"));
}

console.log("\n=== ONE PLACEHOLDER, NOT 130 HAND-DRAWN SILHOUETTES ===");
{
  // Measured 2026-08-14 by walking all 13 category tabs in the running editor:
  // 135 distinct tiles displayed, 135 with a baked sprite, ZERO falling back.
  // The drawings were only ever on screen during a cold bake, and every new
  // piece needed one more of them.
  const builder = code("modularRoadBuilder.js");
  check("there is exactly one SVG left in the palette",
    (builder.match(/<svg/g) || []).length === 1);
  check("...and it is the bake-failed placeholder", /function placeholderSvg\(\)/.test(builder));
  check("presets carry no artwork", !/\bpreview:\s*`/.test(builder),
    "a preset's tile is a render of what its params actually build");
  check("...and nothing still reads pr.preview", !/pr\.preview/.test(builder));
  // THE FAILED-BAKE FALLBACK IS STILL A CAPTION, it is just no longer on every
  // tile. The grid went to three columns and the names moved to #selected-piece,
  // because at 167 tiles a band of 8px text over the bottom fifth of every
  // thumbnail costs more than it tells you. What has NOT changed is why the
  // caption existed: if the bake fails every tile is the same grey plate, and
  // without a name they are 167 buttons nobody can tell apart. So the label is
  // now conditional on there being no sprite — and all three parts of that have
  // to hold together, which is what these check.
  check("the tile caption still exists", /piece-tile-name/.test(builder));
  check("...and is applied exactly when the bake did not produce a sprite",
    /if \(!sprite\) btn\.classList\.add\("unbaked"\)/.test(builder),
    "renderPieces must mark tiles that fell back to the placeholder");
  check("...and is dropped when a bake lands later",
    /classList\.remove\("unbaked"\)/.test(builder),
    "setThumbnails patches the live DOM, so it has to clear the flag too");
  const css = src("palette.css");
  const html = src("road.html");
  check("...and the CSS only shows it on those tiles",
    /\.piece-tile\.unbaked \.piece-tile-name\s*\{\s*display: block/.test(css)
    && /\.piece-tile-name\s*\{\s*display: none/.test(css));
  check("the name the tiles gave up has somewhere to live",
    /id="selected-piece-name"/.test(html) && /getElementById\("selected-piece-name"\)/.test(builder));
  // OUTSIDE the scrolling body, or it sits a screen and a half below the tile
  // you just clicked. Checked as ordering plus the flex property that pins it —
  // a text test cannot prove nesting, and the real check is that you can see it.
  check("...pinned after everything the grid scrolls",
    html.indexOf('id="selected-piece"') > html.indexOf('id="build-hints"')
    && /#selected-piece \{[^}]*flex-shrink: 0/.test(css),
    "#selected-piece must be a sibling of #palette-body, not a child");
  // The hover text was `item.label` literally. It goes through tileTitle() now,
  // which adds the speed the car can still follow a VERTICAL piece at — the one
  // property of a slope or crest that a thumbnail cannot show and that decides
  // whether the piece is road or a launch ramp. So the check is unchanged in
  // intent and only moved: the title is still built from the label, and a piece
  // with no convex vertical curve still gets the bare name.
  check("every tile names itself on hover whatever its state",
    /btn\.title = tileTitle\(item\)/.test(builder));
  const titleFn = builder.slice(builder.indexOf("function tileTitle(item)"));
  const titleBody = titleFn.slice(0, titleFn.indexOf("\n  }"));
  check("...with the name always the start of it",
    /return item\.label;/.test(titleBody) && /`\$\{item\.label\} — /.test(titleBody),
    "tileTitle must fall back to the bare label, and prefix it when it has a speed to add");

  // A CATEGORY BUTTON IS A PIECE TILE, and its icon is a baked thumbnail of the
  // first tile in that category — so it fails the same way, and a rail of 14
  // identical grey placeholder plates with no captions is unusable in exactly
  // the same way. Same flag, same fallback, same hover name.
  check("the rail honours the same bake-failed fallback",
    /closest\("\.cat-btn"\)\?\.classList\.toggle\("unbaked", !sprite\)/.test(builder),
    "fillCategoryIcon runs on the first render AND on setThumbnails, so one call site covers both");
  check("...gated by CSS the same way the tiles are",
    /\.cat-btn\.unbaked:not\(\.active\) \.cat-btn-label\s*\{\s*display: block/.test(css)
    && /\.cat-btn-label\s*\{\s*display: none/.test(css));
  check("...and names itself on hover", /btn\.title = cat\.label/.test(builder));
  // The one place the rail SHOULD differ from the grid: there is only ever one
  // selected category, its name is a heading rather than a caption, and without
  // it the rail is fourteen anonymous thumbnails. Centred, not a bottom band —
  // a band at the bottom reads as "this tile is called Tubes", which is exactly
  // what the piece tiles stopped doing.
  // `[^{]*` before the brace so a GROUPED selector still matches. Hover and
  // selected were merged into one rule (`.cat-btn.active .cat-btn-label,
  // .cat-btn:hover .cat-btn-label { … }`) because a separate white bottom band
  // used to flash during the hover dwell — the styling stayed correct and only
  // this assertion broke, because it demanded `{` immediately after `.active`.
  check("the SELECTED category names itself across its thumbnail",
    /\.cat-btn\.active \.cat-btn-label[^{]*\{[^}]*inset: 0/.test(css)
    && /\.cat-btn\.active \.cat-btn-label[^{]*\{[^}]*justify-content: center/.test(css));
  check("...and an unselected one still does not",
    /\.cat-btn\.unbaked:not\(\.active\) \.cat-btn-label/.test(css),
    "the bake-failed caption must not fight the selected label for the same box");
  // Hover-to-open, with a dwell: Edges/Hand sit above the list, so a mouse path
  // from the grid to those chips crosses every category. Instant switch would
  // rebuild the grid on every flyover and drop a live brush (until browsing
  // stopped clearing one). Click stays for touch.
  check("the rail opens a category on hover, not only click",
    /function setActiveCategory/.test(builder)
    && /function armCatHover/.test(builder)
    && /CAT_HOVER_MS/.test(builder));
  // THE RAIL SCROLLS (13 buttons at ~100px), so a wheel over it drags buttons
  // under a stationary cursor and each one fires a genuine pointerenter. Arm
  // the dwell from those and scrolling silently changes category.
  check("...armed by pointer MOVEMENT, so scrolling the rail cannot switch tabs",
    /addEventListener\("pointermove"/.test(builder) && !/pointerenter/.test(builder),
    "the rail overflows; an enter-armed dwell opens whatever the wheel parks under the mouse");
  check("...and a finger tap on a hybrid laptop goes through the click, not the dwell",
    /pointerType === "touch"/.test(builder),
    "(hover: hover) and (pointer: fine) is TRUE on a touchscreen laptop with a mouse");
  check("...and browsing a tab does not disarm a live brush",
    !/pieceTiles\.clear\(\);\s*activePropId = null;\s*activeMoverId = null;\s*activePortalId = null/.test(builder),
    "renderPieces used to null the brush; hover-select would then cancel a cone by sweeping the rail");
  // The strip carries BOTH halves: SELECTED · <category> · <piece>.
  check("the strip names the category as well as the piece",
    /id="selected-piece-cat"/.test(html)
    && /getElementById\("selected-piece-cat"\)/.test(builder)
    && /#selected-piece-cat \{/.test(css));
  // Derived from the SELECTION, never from the visible tab — browse away without
  // clicking and the tab and the selection disagree.
  check("...resolved from the selection, not the tab being browsed",
    /function activeCategoryLabel\(\)/.test(builder)
    && !/activeCategoryLabel[\s\S]{0,400}?\bid = activeCategory\b/.test(builder),
    "activeCategoryLabel must not read activeCategory");
  // Same box, same selection language. These drifted apart once already: the
  // rail was a transparent full-width ROW with a 76px icon and a 3px left bar,
  // beside a grid of bordered tiles that select with brackets.
  check("the rail and the grid share one selection treatment",
    /\.cat-btn\.active::before,\s*\n?\s*\.cat-btn\.active::after/.test(css)
    && /\.cat-btn\.active \{[^}]*border-color: var\(--tm-yellow\)/.test(css));
  check("...and one size, derived from the rail width",
    /--rail-width:/.test(css) && /width: var\(--rail-width\)/.test(css)
    && /\.cat-btn \{[^}]*width: calc\(var\(--rail-width\) - 12px\)/.test(css),
    "the 92px thumbnail is the rail width minus its padding");
  // One resolver for "what is selected", or the strip and the status line drift.
  check("the strip and the status line read the same source",
    (builder.match(/activeLabel\(\)/g) || []).length >= 3,
    "definition + #selected-piece + both status branches");
  check("both fallback paths go through the placeholder",
    (builder.match(/placeholderSvg\(\)/g) || []).length === 3, "tiles + category icons + the definition");
}

console.log("\n=== THE CACHE STORES A WHOLE BAKE OR NOTHING ===");
{
  const cache = code("modularRoadThumbnailCache.js");
  check("the stored shape is validated on the way in AND out",
    /isBake\(rec\?\.bake\)/.test(cache) && /if \(!isBake\(bake\)\) return false;/.test(cache));
  check("...so a half-written record reads as a miss, not an empty palette",
    /return isBake\(rec\?\.bake\) \? rec\.bake : null;/.test(cache));
  check("the sheet Blobs have to have survived the round trip",
    /s\?\.blob instanceof Blob/.test(cache));
  check("...and so does the index", /b\.cells instanceof Map && b\.cells\.size > 0/.test(cache));
  check("the version covers the stored shape, not just the pixels",
    THUMB_CACHE_VERSION >= 2, `at v${THUMB_CACHE_VERSION} (v1 was one Blob per tile)`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall green");
process.exit(fail ? 1 : 0);
