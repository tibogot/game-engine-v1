// ONE HISTORY FOR THE WHOLE TRACK — road pieces AND the object layers
// (props / movers / portals), on the real ModularRoadBuilder.
//
// WHAT WAS BROKEN. The builder owned the only undo stack, so the three object
// managers sat outside history entirely:
//   • Ctrl+Z after deleting an obstacle popped a ROAD PIECE off the stack —
//     an undo that edits something else on the far side of the map is worse
//     than no undo, because you do not notice it;
//   • "Clear track" took the pieces and left every prop hanging in the air.
//
// The fix registers each manager as a history LAYER: capture/restore are the
// manager's own save-file serializers, and the builder's existing commit rules
// (`_sameStructure`, `_asOneEdit`, the cursor-only fold) now cover all four.
//
// The tests below are grouped by the three ways this can go wrong:
//   1. CORRECTNESS — an object edit is one step, and it comes back exactly;
//   2. NO DEAD STEPS — a change callback that changed nothing must not commit,
//      or Ctrl+Z spends presses appearing to do nothing (the bug the cursor
//      fold was written to kill, arriving by a new route);
//   3. PERFORMANCE — a road edit must not serialize or re-import the object
//      layers. `importInstances` disposes and re-`make()`s EVERY instance, so
//      an undo that touched all three layers would rebuild hundreds of props to
//      put back one road piece.
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

/**
 * A stand-in for PropManager / MoverPropManager / PortalManager.
 *
 * It reproduces the only three things about them this mechanism relies on:
 * an array of instances, export/import of plain JSON-ish data, and a single
 * `onChange` fired at the END of every mutation — including the ones that
 * change nothing (a gizmo mouseUp with no drag) and the ones the history
 * itself causes (import fires it too, which is what `_histRestoring` guards).
 */
function attachLayer(b, name) {
  const m = {
    items: [],
    captures: 0,
    restores: 0,
    export() {
      m.captures++;
      return m.items.map((o) => ({ id: o.id, position: [...o.position] }));
    },
    import(v) {
      m.restores++;
      m.items = (v ?? []).map((o) => ({ id: o.id, position: [...o.position] }));
      m.changed(); // the real managers do this, and it must not re-commit
    },
    changed() { b.commitLayerEdit(name); },
    add(id, x) { m.items.push({ id, position: [x, 0, 0] }); m.changed(); },
    move(i, x) { m.items[i].position[0] = x; m.changed(); },
    del(i) { m.items.splice(i, 1); m.changed(); },
    /** Gizmo mouseUp with no drag: reports a change, moved nothing. */
    touch() { m.changed(); },
    clear() { m.items = []; m.changed(); },
    fingerprint() { return m.items.map((o) => `${o.id}@${o.position.join(",")}`).join("|"); },
  };
  b.registerHistoryLayer(name, {
    capture: () => m.export(),
    restore: (v) => m.import(v),
    clear: () => m.clear(),
    count: () => m.items.length,
  });
  return m;
}

function fresh(n = 3, id = "straight") {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  const props = attachLayer(b, "props");
  const movers = attachLayer(b, "movers");
  for (let i = 0; i < n; i++) { b.setActivePiece(id); b.place(); }
  return { b, props, movers };
}

console.log("\n=== AN OBJECT EDIT IS AN UNDO STEP OF ITS OWN ===");
{
  const { b, props } = fresh(3);
  const pieces = b.pieces.length;
  const steps = b._undoStack.length;

  props.add("cone", 10);
  check("adding a prop pushes a step", b._undoStack.length === steps + 1,
    `+${b._undoStack.length - steps}`);

  b.undo();
  check("...and Ctrl+Z removes the PROP", props.items.length === 0);
  check("...and leaves the road alone", b.pieces.length === pieces,
    `${b.pieces.length} pieces — undoing an object edit used to pop a road piece instead`);

  b.redo();
  check("redo puts the prop back", props.items.length === 1 && props.fingerprint() === "cone@10,0,0");
}

console.log("\n=== IT COMES BACK EXACTLY ===");
{
  const { b, props } = fresh(2);
  props.add("cone", 1);
  props.add("gate", 2);
  const before = props.fingerprint();
  props.move(0, 99);
  check("a move is a step", props.fingerprint() !== before);
  b.undo();
  check("undo restores the exact transform", props.fingerprint() === before, props.fingerprint());

  props.del(1);
  check("delete removes it", props.items.length === 1);
  b.undo();
  check("undo brings the deleted prop back, in order", props.fingerprint() === before, props.fingerprint());
}

console.log("\n=== THE STACK IS SHARED, SO IT UNWINDS IN THE ORDER YOU WORKED ===");
{
  const { b, props } = fresh(1);
  b.setActivePiece("straight"); b.place();  // road
  props.add("cone", 5);                      // object
  b.setActivePiece("straight"); b.place();  // road

  const pieces = b.pieces.length;
  b.undo();
  check("1st undo takes the last ROAD piece", b.pieces.length === pieces - 1 && props.items.length === 1);
  b.undo();
  check("2nd undo takes the PROP", props.items.length === 0 && b.pieces.length === pieces - 1);
  b.undo();
  check("3rd undo takes the road piece before it", b.pieces.length === pieces - 2);
  // Two separate stacks would have unwound each layer independently and given
  // back a track that never existed at any point in the session.
}

console.log("\n=== A CHANGE THAT CHANGED NOTHING IS NOT A STEP ===");
{
  const { b, props } = fresh(2);
  props.add("cone", 3);
  const steps = b._undoStack.length;
  props.touch();
  props.touch();
  props.touch();
  check("clicking a gizmo without dragging pushes nothing",
    b._undoStack.length === steps,
    `+${b._undoStack.length - steps} — otherwise Ctrl+Z sits there doing nothing three times`);

  // And the real thing still commits right after the no-ops.
  props.move(0, 7);
  check("...but a real move right after still commits", b._undoStack.length === steps + 1);
}

console.log("\n=== CLEAR TRACK CLEARS THE TRACK ===");
{
  const { b, props, movers } = fresh(4);
  props.add("cone", 1);
  props.add("cone", 2);
  movers.add("platform", 3);

  const counts = b.trackCounts();
  check("trackCounts sees both halves", counts.pieces === 4 && counts.objects === 3,
    `${counts.pieces} pieces, ${counts.objects} objects`);

  const steps = b._undoStack.length;
  const removed = b.clearAll();
  check("clear empties the road", b.pieces.length === 0);
  check("...AND the objects", props.items.length === 0 && movers.items.length === 0,
    "they used to be left hanging in the air over a road that no longer exists");
  check("...and reports what it removed", removed.pieces === 4 && removed.objects === 3);
  check("it is ONE undo step, not one per layer",
    b._undoStack.length === steps + 1, `+${b._undoStack.length - steps}`);

  b.undo();
  check("one Ctrl+Z brings the whole track back — road",
    b.pieces.length === 4, `${b.pieces.length}`);
  check("...and objects", props.items.length === 2 && movers.items.length === 1,
    `${props.items.length} props, ${movers.items.length} movers`);
}

console.log("\n=== A ROAD EDIT DOES NOT TOUCH THE OBJECT LAYERS (why this is affordable) ===");
{
  const { b, props, movers } = fresh(2);
  props.add("cone", 1);
  movers.add("platform", 2);

  const c0 = props.captures + movers.captures;
  for (let i = 0; i < 20; i++) { b.setActivePiece("straight"); b.place(); }
  check("20 road placements re-serialize the object layers ZERO times",
    props.captures + movers.captures === c0,
    `+${props.captures + movers.captures - c0} — an unchanged layer rides in the snapshot by reference`);

  const r0 = props.restores + movers.restores;
  for (let i = 0; i < 10; i++) b.undo();
  check("...and 10 undos of road edits re-import them ZERO times",
    props.restores + movers.restores === r0,
    `+${props.restores + movers.restores - r0} — importInstances re-make()s every instance, so this is the expensive one`);
  check("the objects are still there and untouched",
    props.fingerprint() === "cone@1,0,0" && movers.fingerprint() === "platform@2,0,0");
}

console.log("\n=== AN OBJECT-ONLY STEP DOES NOT REBUILD THE ROAD ===");
{
  const { b, props } = fresh(6);
  props.add("cone", 1);
  props.move(0, 9);

  let rebuilds = 0;
  const realRebuild = b.rebuildAll.bind(b);
  b.rebuildAll = (o) => { rebuilds++; return realRebuild(o); };

  b.undo(); // object-only
  check("undoing a prop move calls rebuildAll ZERO times", rebuilds === 0,
    `${rebuilds} — rebuildAll ends in a full notify, and the listener's half of `
    + "that re-merges every mirrored guardrail (280k verts on rushline)");
  check("...and the prop still came back", props.fingerprint() === "cone@1,0,0");

  b.setActivePiece("straight"); b.place();
  rebuilds = 0;
  b.undo(); // road step — must still rebuild
  check("undoing a ROAD edit still rebuilds", rebuilds === 1, `${rebuilds}`);
}

console.log("\n=== ONE LAYER MOVING DOES NOT RE-IMPORT THE OTHERS ===");
{
  const { b, props, movers } = fresh(1);
  props.add("cone", 1);
  movers.add("platform", 2);
  props.move(0, 5);

  const mr = movers.restores;
  b.undo();
  check("undoing a prop move leaves the movers alone", movers.restores === mr,
    `+${movers.restores - mr}`);
  check("...and the prop is back", props.fingerprint() === "cone@1,0,0");
}

console.log("\n=== A LOAD IS NOT AN EDIT ===");
{
  const { b, props } = fresh(3);
  props.add("cone", 1);
  // What importTrack does: pieces, then the layers, then re-seed the baseline.
  b.importTrackPieces(b.exportTrackPieces());
  props.import([{ id: "barrel", position: [8, 0, 0] }]);
  b.resetHistory();
  check("the stack is empty after a load", b._undoStack.length === 0);
  check("...and undo across it does nothing", b.undo() === false);

  // The trap this catches: resetHistory used to run INSIDE importTrackPieces,
  // i.e. before the props were imported, so the baseline held the new road and
  // the OLD props — and the first object edit after a load committed a step
  // whose undo dragged the previous track's props back onto the map.
  props.add("cone", 4);
  b.undo();
  check("the first object edit after a load undoes to the LOADED objects",
    props.fingerprint() === "barrel@8,0,0", props.fingerprint());
}

// ── THE REAL WIRING ─────────────────────────────────────────────────────────
// Everything above runs against a stand-in layer, which proves the MECHANISM
// and nothing about whether roadGame actually plugged the three real managers
// into it. These read the sources, because the managers need a DOM and a
// TransformControls to construct and cannot be built headless.
const src = (p) => readFileSync(join(ROOT, p), "utf8");
const game = src("games/modular-road-v3/roadGame.js");
const builderSrc = src("games/modular-road-v3/modularRoadBuilder.js");
const io = src("games/modular-road-v3/modularRoadTrackIO.js");

console.log("\n=== ALL THREE OBJECT MANAGERS ARE ACTUALLY REGISTERED ===");
{
  const registered = [...game.matchAll(/registerHistoryLayer\("([^"]+)"/g)].map((m) => m[1]);
  for (const name of ["props", "movers", "portals"]) {
    check(`${name} is a history layer`, registered.includes(name),
      "otherwise it is silently outside undo again, which is the whole bug");
  }

  // A commit for a layer nobody registered is a no-op, and a silent one.
  const committed = [...game.matchAll(/commitLayerEdit\("([^"]+)"/g)].map((m) => m[1]);
  for (const name of committed) {
    check(`commitLayerEdit("${name}") names a registered layer`, registered.includes(name));
  }
  for (const name of registered) {
    check(`${name} has a commit point`, committed.includes(name),
      "registered but never committed = its edits never reach the stack");
  }
}

console.log("\n=== EVERY LAYER CALLBACK NAMES A METHOD THAT EXISTS ===");
{
  // capture/restore/clear/count are the manager's own methods, referenced by
  // name from roadGame — so a rename in a manager fails HERE rather than as a
  // TypeError the first time somebody presses Ctrl+Z.
  const MODULE = {
    props: "games/modular-road-v3/modularRoadProps.js",
    movers: "games/modular-road-v3/modularRoadMoverProps.js",
    portals: "games/modular-road-v3/modularRoadPortals.js",
  };
  const blocks = [...game.matchAll(/registerHistoryLayer\("([^"]+)", \{([\s\S]*?)\n  \}\);/g)];
  check("all three registration blocks parsed", blocks.length === 3, `${blocks.length}`);
  for (const [, name, body] of blocks) {
    for (const key of ["capture", "restore", "clear", "count"]) {
      check(`${name}.${key} is supplied`, new RegExp(`${key}:`).test(body));
    }
    const mod = src(MODULE[name]);
    // The method/field each callback reaches for, e.g. `props.exportInstances()`.
    for (const [, member] of body.matchAll(new RegExp(`${name}\\.(\\w+)`, "g"))) {
      const exists = new RegExp(`^\\s*${member}\\s*[({=]`, "m").test(mod)
        || new RegExp(`this\\.${member}\\s*=`).test(mod);
      check(`${name}.${member} exists on the manager`, exists, MODULE[name]);
    }
  }
}

console.log("\n=== THE BUTTON AND THE LOAD PATH USE THE NEW ENTRY POINTS ===");
{
  const clearBtn = builderSrc.slice(builderSrc.indexOf('getElementById("road-clear")'));
  const handler = clearBtn.slice(0, clearBtn.indexOf("\n  });"));
  check("Clear track calls clearAll(), not the road-only clear()",
    /builder\.clearAll\(\)/.test(handler) && !/builder\.clear\(\)/.test(handler),
    "builder.clear() takes the pieces and leaves the props floating");
  check("...and it says what it is about to delete", /trackCounts\(\)/.test(handler));

  // `clear()` must STAY road-only — importTrackPieces/loadDemo/dispose lean on it.
  const clearFn = builderSrc.slice(builderSrc.indexOf("\n  clear() {"));
  check("clear() itself stays road-only",
    !/_histLayers/.test(clearFn.slice(0, clearFn.indexOf("\n  }"))),
    "a load calls clear() before importing the props — wiping them there is a race");

  const iPieces = io.indexOf("importTrackPieces");
  const iPortals = io.indexOf("portals.importLayout");
  const iReset = io.indexOf("resetHistory");
  check("importTrack re-seeds the history AFTER the object layers land",
    iReset > iPortals && iPortals > iPieces,
    "importTrackPieces resets it too early — the baseline would hold the new road and the OLD props");
}

console.log(fail ? `\n${fail} FAILED` : "\nall green");
process.exit(fail ? 1 : 0);
