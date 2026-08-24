// THE HAND IS A MODE — and the list of pieces it applies to is derived, not typed.
//
// The palette used to ship an L tile beside every R tile: 94 of 195 tiles were
// one half of a mirror pair. That was not laziness, it was the only thing that
// worked — `flip()` wrote `activeParams.curveDir`, and `setActivePreset` replaces
// activeParams wholesale, so the flip died on your very next tile click. "Press
// R once, build a run of left-handers" was impossible.
//
// Now the hand sticks and the palette ships one tile per shape (195 -> 148).
// Three things have to hold for that to be safe, and all three are the kind that
// fail silently:
//
//   • THE HAND STICKS ACROSS TILE CLICKS. That is the entire premise.
//   • AN EXPLICIT curveDir STILL WINS, or every track-building script starts
//     producing a different track depending on which way the editor was pointing.
//   • THE HANDED LIST IS COMPLETE. `isHandedPiece` drives the chip's grey-out,
//     the strip's suffix and the status line. A piece missing from it looks
//     unflippable; a piece wrongly in it shows a control that does nothing.
import * as THREE from "three";

const kit = await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { buildPiece, roadParams, pieceParams, guardrailParams, PIECE_CATALOG, isHandedPiece } = kit;
const { CATEGORY_PRESETS, ModularRoadBuilder } = await import(
  new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url).href);

const rp = { ...roadParams }, gp = { ...guardrailParams }, DEF = { ...pieceParams };
const I = new THREE.Matrix4();
let fail = 0;
const ok = (c, label, detail = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!c) fail++;
};

/* ---------------------------------------------------------------------- */
console.log("\n1. THE HANDED LIST MATCHES WHAT THE PIECES ACTUALLY DO\n");

/**
 * Build each piece both ways and see whether anything moves — deck, branches or
 * exit connector. All three matter: a Y fork's PLATE is symmetric, so its deck
 * is byte-identical either way and only its BRANCHES swap sides. Reading the
 * piece functions by eye would have called it unhanded.
 */
function measureHanded(id) {
  const a = buildPiece(id, I.clone(), { ...DEF, curveDir: 1 }, rp, gp, gp.enabled);
  const b = buildPiece(id, I.clone(), { ...DEF, curveDir: -1 }, rp, gp, gp.enabled);
  const pa = a.geometry.getAttribute("position"), pb = b.geometry.getAttribute("position");
  if (pa.count !== pb.count) return "deck";
  for (let i = 0; i < pa.count * 3; i++) if (Math.abs(pa.array[i] - pb.array[i]) > 1e-9) return "deck";
  const bx = (p) => p.branchesOut.map((x) => x.matrix.elements.join(",")).join("|");
  if (bx(a) !== bx(b)) return "branches";
  if (a.connectorOut.elements.join(",") !== b.connectorOut.elements.join(",")) return "exit";
  return null;
}

const wrong = [];
let handedCount = 0;
for (const def of PIECE_CATALOG) {
  const why = measureHanded(def.id);
  if (why) handedCount++;
  if (!!why !== isHandedPiece(def.id)) {
    wrong.push(`${def.id} — measured ${why ?? "unhanded"}, listed ${isHandedPiece(def.id)}`);
  }
}
ok(wrong.length === 0, "every piece's listed hand matches its measured hand",
  wrong.join("; ") || `${handedCount} handed, ${PIECE_CATALOG.length - handedCount} not`);
ok(isHandedPiece("junction_y"), "junction_y counts as handed (branches only, symmetric plate)");
ok(!isHandedPiece("straight"), "a straight does not");

/* ---------------------------------------------------------------------- */
console.log("\n2. NO TILE CARRIES A HAND ANY MORE\n");

const tiles = Object.values(CATEGORY_PRESETS).flat();
const withDir = tiles.filter((t) => t.params.curveDir !== undefined);
ok(withDir.length === 0, "no palette tile sets curveDir — the mode owns it",
  withDir.map((t) => t.id).join(", ") || `${tiles.length} tiles checked`);

// And none of them still NAMES a direction, which would be a label describing
// something the tile no longer decides.
const named = tiles.filter((t) => isHandedPiece(t.base)
  && /\b(R|L|Right|Left|right|left)\b|\((R|L)\)/.test(t.label));
ok(named.length === 0, "no handed tile names a direction in its label",
  named.map((t) => t.label).join(", ") || "checked every handed tile");

/*
 * THE PAIRS ARE GONE — asserted as the invariant, not as a tile count.
 *
 * This was `tiles.length === 148`, which broke the moment the chicane added
 * three. A magic total tells you the palette CHANGED; it does not tell you the
 * thing worth protecting, which is that no two tiles differ only by a hand.
 */
const pairKey = (t) => `${t.base}|` + JSON.stringify(
  Object.fromEntries(Object.entries(t.params).filter(([k]) => k !== "curveDir").sort()));
const seen = new Map();
const twins = [];
for (const t of tiles) {
  const k = pairKey(t);
  if (seen.has(k)) twins.push(`${seen.get(k)} + ${t.id}`);
  else seen.set(k, t.id);
}
ok(twins.length === 0, "no two tiles differ only by a hand",
  twins.join(", ") || `${tiles.length} tiles, ${seen.size} distinct shapes`);
const perTab = Object.entries(CATEGORY_PRESETS).map(([c, t]) => `${c} ${t.length}`).join("  ");
console.log(`   ${perTab}`);

/* ---------------------------------------------------------------------- */
console.log("\n3. THE HAND STICKS — the whole premise\n");

// A headless builder: ModularRoadBuilder's constructor wants a scene and does
// THREE work, so drive the two methods that matter on a bare prototype instance.
// (Same Object.create trick the river-mode tests use.)
const b = Object.create(ModularRoadBuilder.prototype);
b.hand = 1;
b.activePieceId = "curve";
b.activeParams = { ...DEF };
b._ensureGizmoOnGhost = () => {};
b.refreshGhost = () => {};
b._notify = () => {};

const turn = CATEGORY_PRESETS.turns.find((t) => t.base === "curve");
const straight = CATEGORY_PRESETS.straight.find((t) => t.base === "straight");

b.setActivePreset(turn);
ok(b.activeParams.curveDir === 1, "a fresh pick takes the current hand (R)");

b.flip();
ok(b.hand === -1 && b.activeParams.curveDir === -1, "R flips the mode and the selection");

// THE BUG THIS EXISTS FOR: before, this next line put you back to right-handed.
b.setActivePreset(turn);
ok(b.activeParams.curveDir === -1, "...and the flip SURVIVES the next tile click",
  "this is what an L tile beside every R tile was working around");
b.setActivePreset(straight);
b.setActivePreset(turn);
ok(b.activeParams.curveDir === -1, "...and a detour through an unhanded tile");
b.setActivePiece("banked");
ok(b.activeParams.curveDir === -1, "...and a raw piece pick (hotkey)");

b.setHand(1);
ok(b.hand === 1 && b.activeParams.curveDir === 1, "setHand puts it back without counting flips");

/* ---------------------------------------------------------------------- */
console.log("\n4. AN EXPLICIT curveDir STILL WINS\n");

// loadBigCircuit / loadPresetTrack / tools/buildParkourTrack all name the
// direction they want. A demo track that builds itself differently depending on
// which way the editor happened to be pointing is not a demo track.
b.setHand(-1);
b.setActivePreset({ base: "curve", params: { curveRadius: 24, curveAngle: 90, curveDir: 1 } });
ok(b.activeParams.curveDir === 1, "a preset that names its direction is obeyed, hand or no hand");
ok(b.hand === -1, "...and it does not quietly change the mode for what comes next");

/* ---------------------------------------------------------------------- */
console.log("\n5. THE CHIP IS HONEST ABOUT DOING NOTHING\n");

b.activePieceId = "curve";
ok(b.activePieceHanded, "the chip is live on a curve");
b.activePieceId = "straight";
ok(!b.activePieceHanded, "and inert on a straight");
b.activePieceId = "tube_slope";
ok(!b.activePieceHanded, "and on a tube slope");
b.activePieceId = "junction_y";
ok(b.activePieceHanded, "and live on a Y fork, whose hand is only in its branches");

const src = (await import("node:fs")).readFileSync(
  new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url), "utf8");
ok(!/const curveIds = new Set/.test(src),
  "the status line's hand-typed curve list is gone",
  "it had drifted — no tube, no bank ramp, no wallride, no loop");

console.log(fail === 0 ? "\nALL PASS\n" : `\n${fail} FAILURE(S)\n`);
process.exit(fail === 0 ? 0 : 1);
