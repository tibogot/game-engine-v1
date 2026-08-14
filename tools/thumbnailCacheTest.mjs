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

console.log("\n=== THE RUNNING EDITOR KEEPS THE RENDERER ===");
{
  const bake = src("modularRoadThumbnails.js");
  const body = bake.slice(bake.indexOf("for (const item of items)"));
  const iBind = body.indexOf("renderer.setRenderTarget(rt)");
  const iRestore = body.indexOf("renderer.setRenderTarget(prevTarget)");
  const iRead = body.indexOf("readRenderTargetPixelsAsync");
  check("the thumbnail target is bound per tile", iBind > 0);
  check("...and released BEFORE the first await", iRestore > iBind && iRestore < iRead,
    "an await yields a frame; a bound 192px RT would swallow it");
  check("the clear colour is restored with it",
    body.indexOf("renderer.setClearColor(prevClear, prevClearAlpha)") < iRead);
  check("the real clear colour is saved, not assumed black",
    /renderer\.getClearColor\(prevClear\)/.test(body));
  check("nothing is left bound after the loop instead",
    !/finally\s*\{[^}]*setRenderTarget/.test(bake));
}

console.log("\n=== TILES TRAVEL AS BLOBS, NOT DATA-URLS ===");
{
  const bake = src("modularRoadThumbnails.js");
  const builder = src("modularRoadBuilder.js");
  // ~175 PNGs is a few MB; base64 in localStorage would be ~33% bigger again and
  // over its quota, and toDataURL encodes synchronously on the main thread.
  check("the baker returns Blobs", /canvas\.toBlob\(resolve, "image\/png"\)/.test(bake));
  check("...and nothing still encodes through toDataURL", !/canvas\.toDataURL\(/.test(bake));
  check("object URLs are minted for the palette", /export function blobsToUrls/.test(bake));
  check("...and the previous set is revoked on a rebake",
    /URL\.revokeObjectURL\(url\)/.test(bake));
  check("the palette can adopt a set after it was built",
    /function setThumbnails\(next\)/.test(builder));
  check("...and is exported", /return \{[^}]*setThumbnails[^}]*\};/.test(builder));
  // renderPieces() clears activePropId/activeMoverId — calling it two seconds in
  // would silently disarm a prop brush the user is holding.
  const setFn = builder.slice(builder.indexOf("function setThumbnails(next)"));
  check("...without re-rendering the grid under a live brush",
    !setFn.slice(0, setFn.indexOf("\n  }")).includes("renderPieces()"));
}

console.log(fail ? `\n${fail} FAILED` : "\nall green");
process.exit(fail ? 1 : 0);
