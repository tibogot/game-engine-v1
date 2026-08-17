// SELECTING A SECTION, and editing it as one.
//
// The editor had exactly two granularities: one piece, or a whole chain. "This
// section" — the stretch you want to delete, un-rail, or bank — could not be
// said. A chain is a linear array, so the natural unit is a RANGE between two
// indices, which is one gesture instead of one click per piece.
//
// The interesting part is BANKING. A piece's `tilt` is applied at its entry seam
// and the running connector carries it forward, so tilts ACCUMULATE down a chain:
// writing roll = 15° onto five pieces gives 15, 30, 45, 60, 75 — a corkscrew, not
// a banked section. So a section gets the angle ONCE at its first piece
// (propagation banks the rest for free) and the piece AFTER the run gets the
// inverse, which brings the track back level past it. Roll in, roll out.
import * as THREE from "three";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};
const deg = THREE.MathUtils.radToDeg;
const upOf = (m) => new THREE.Vector3(0, 1, 0)
  .applyMatrix4(new THREE.Matrix4().extractRotation(m)).normalize();
/** Roll of a seam about its own travel, in degrees — signed. */
function rollAt(m) {
  const e = new THREE.Euler().setFromRotationMatrix(m, "YXZ");
  return deg(e.z);
}
function fresh(n = 8) {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  b.setActivePiece("straight");
  for (let i = 0; i < n; i++) b.place();
  return b;
}

console.log("\n=== 1. A RANGE IS ONE GESTURE ===");
{
  const b = fresh();
  b.selectPiece(b.pieces[2]);
  check("a plain click selects one", b.selectionCount === 1, `${b.selectionCount}`);
  b.selectRangeTo(b.pieces[5]);
  check("shift+click takes everything between", b.selectionCount === 4, `${b.selectionCount}`);
  check("...inclusive of both ends",
    b.selectedPieces.includes(b.pieces[2]) && b.selectedPieces.includes(b.pieces[5]));
  check("...and the anchor does not move, so you can re-measure",
    b.selectedPiece === b.pieces[2]);
  b.selectRangeTo(b.pieces[3]);
  check("shift+clicking nearer shrinks the range", b.selectionCount === 2, `${b.selectionCount}`);
  b.selectRangeTo(b.pieces[0]);
  check("...and it works backwards from the anchor too", b.selectionCount === 3,
    `${b.selectionCount} — pieces 0..2`);
}
{
  const b = fresh(4);
  b.setActivePiece("straight");
  b.beginNewChain(new THREE.Vector3(300, 0, 0), 0);
  b.place(); b.place();
  b.selectPiece(b.pieces[1]);                      // chain 0
  const other = b.pieces.find((p) => p.chainId !== b.pieces[1].chainId);
  b.selectRangeTo(other);
  check("a range across two chains falls back to a plain select",
    b.selectionCount === 1 && b.selectedPiece === other,
    `${b.selectionCount} selected — "between" has no meaning across chains`);
}
{
  const b = fresh();
  b.selectPiece(b.pieces[1]);
  b.toggleSelected(b.pieces[4]);
  check("ctrl+click adds a lone piece", b.selectionCount === 2);
  b.toggleSelected(b.pieces[4]);
  check("...and removes it again", b.selectionCount === 1);
  b.toggleSelected(b.pieces[1]);
  check("removing the last one clears the selection", b.selectionCount === 0);
}

console.log("\n=== 2. BULK EDITS ARE ONE UNDO STEP ===");
{
  const b = fresh();
  b.selectPiece(b.pieces[2]);
  b.selectRangeTo(b.pieces[5]);
  const n = b._undoStack.length;
  const killed = b.deleteSelected();
  check("delete took the whole run", killed === 4 && b.pieces.length === 4,
    `${killed} deleted, ${b.pieces.length} left`);
  check("...as ONE undo step", b._undoStack.length === n + 1,
    `+${b._undoStack.length - n} — four steps would mean four Ctrl+Z to get back`);
  b.undo();
  check("...and one undo brings all four back", b.pieces.length === 8, `${b.pieces.length}`);
  check("the selection is cleared after deleting", b.selectionCount === 0);
}
{
  const b = fresh();
  b.selectPiece(b.pieces[1]);
  b.selectRangeTo(b.pieces[4]);
  const n = b._undoStack.length;
  check("edges off across the run", b.setSelectedEdges(false) === 4);
  check("...every piece took it", b.pieces.slice(1, 5).every((p) => p.edges === false));
  check("...and nothing outside did",
    b.pieces[0].edges !== false && b.pieces[5].edges !== false);
  check("...in one step", b._undoStack.length === n + 1);
}
{
  const b = fresh();
  b.selectPiece(b.pieces[1]);
  b.selectRangeTo(b.pieces[3]);
  const n = b._undoStack.length;
  check("replace across the run", b.replaceSelected("curve") === 3);
  check("...every piece is the new type",
    b.pieces.slice(1, 4).every((p) => p.id === "curve"), b.pieces.map((p) => p.id).join());
  check("...in one step", b._undoStack.length === n + 1);
  // The chain must still be seam-tight after swapping three pieces at once.
  const gaps = b.pieces.slice(1).map((p, i) =>
    new THREE.Vector3().setFromMatrixPosition(b.pieces[i].connectorOut)
      .distanceTo(new THREE.Vector3().setFromMatrixPosition(p.connectorIn)));
  check("...and the chain is still connected", Math.max(...gaps) < 1e-6,
    `worst seam ${Math.max(...gaps).toExponential(2)}`);
}

console.log("\n=== 3. BANKING A SECTION — NOT A CORKSCREW ===");
{
  const b = fresh();
  const run = [2, 3, 4, 5];
  b.selectPiece(b.pieces[run[0]]);
  b.selectRangeTo(b.pieces[run.at(-1)]);
  const r = b.nudgeAngle("roll", 1);              // one 15° step
  check("the arrows route a multi-selection to the section version",
    r.ok && r.target === "section", JSON.stringify(r));
  check("...and say how many, and that it levels after",
    r.count === 4 && r.levelledAfter === true, JSON.stringify(r));

  // THE POINT: a CONSTANT bank across the run, not 15/30/45/60.
  const rolls = run.map((i) => rollAt(b.pieces[i].connectorIn));
  check("every piece in the section sits at the SAME bank",
    Math.max(...rolls) - Math.min(...rolls) < 1e-6,
    `rolls: ${rolls.map((v) => v.toFixed(1) + "°").join(", ")} — spread means it compounded`);
  check("...and that bank is one step, 15°",
    Math.abs(rolls[0] - 15) < 1e-6, `${rolls[0].toFixed(3)}°`);
  console.log(`        (section rolls: ${rolls.map((v) => v.toFixed(1) + "°").join(", ")})`);

  // ...and the track past the section is level again.
  check("the track AFTER the section is back to level",
    Math.abs(rollAt(b.pieces[6].connectorIn)) < 1e-6,
    `${rollAt(b.pieces[6].connectorIn).toFixed(3)}° — the whole remaining chain ` +
    `would stay tipped over without the counter-tilt`);
  check("...and so is the piece after that", Math.abs(rollAt(b.pieces[7].connectorIn)) < 1e-6);
  check("the track BEFORE it never moved",
    Math.abs(rollAt(b.pieces[0].connectorIn)) < 1e-6
    && Math.abs(rollAt(b.pieces[1].connectorIn)) < 1e-6);
}
{
  // Repeated presses compose, like the single-piece nudge.
  const b = fresh();
  b.selectPiece(b.pieces[2]);
  b.selectRangeTo(b.pieces[4]);
  b.nudgeAngle("roll", 1);
  b.nudgeAngle("roll", 1);
  check("two presses bank the section 30°",
    Math.abs(rollAt(b.pieces[3].connectorIn) - 30) < 1e-6,
    `${rollAt(b.pieces[3].connectorIn).toFixed(3)}°`);
  check("...and it is still level after", Math.abs(rollAt(b.pieces[6].connectorIn)) < 1e-6);
  b.nudgeAngle("roll", -1); b.nudgeAngle("roll", -1);
  check("pressing back returns the section to flat",
    Math.abs(rollAt(b.pieces[3].connectorIn)) < 1e-6);
}
{
  // A section that ends the chain has nothing after it to level — say so rather
  // than pretend.
  const b = fresh(4);
  b.selectPiece(b.pieces[2]);
  b.selectRangeTo(b.pieces[3]);
  const r = b.nudgeAngle("roll", 1);
  check("a section at the end of a chain reports nothing to level after",
    r.ok && r.levelledAfter === false, JSON.stringify(r));
  check("...but still banks", Math.abs(rollAt(b.pieces[3].connectorIn) - 15) < 1e-6);
}
{
  const b = fresh();
  b.selectPiece(b.pieces[1]);
  b.selectRangeTo(b.pieces[4]);
  b.nudgeAngle("roll", 1);
  const n = b._undoStack.length;
  check("level clears the whole selection's tilt", b.levelSelected() === 4);
  check("...in one step", b._undoStack.length === n + 1);
  check("...and the section really is flat again",
    Math.abs(rollAt(b.pieces[2].connectorIn)) < 1e-6,
    `${rollAt(b.pieces[2].connectorIn).toFixed(3)}°`);
}

console.log("\n=== 4. SINGLE-SELECT IS UNCHANGED ===");
{
  // A selection of one has to behave exactly as it did, or every existing habit
  // and every existing test is wrong.
  const b = fresh();
  b.selectPiece(b.pieces[2]);
  check("one piece selected reads as one", b.selectionCount === 1);
  const r = b.nudgeAngle("roll", 1);
  check("...and the arrows tilt THAT piece, not a section",
    r.target === "piece", JSON.stringify(r));
  check("...which still propagates downstream (banked-landing-strip tool)",
    Math.abs(rollAt(b.pieces[5].connectorIn) - 15) < 1e-6,
    `${rollAt(b.pieces[5].connectorIn).toFixed(3)}°`);
  b.levelPiece(b.pieces[2]);
  b.selectPiece(b.pieces[3]);
  check("delete of a single selection still works",
    b.deleteSelected() === 1 && b.pieces.length === 7);
}

console.log("\n=== 5. THE HIGHLIGHT TRACKS THE SELECTION ===");
{
  const b = fresh();
  const lit = () => b._selGroup.children.filter((m) => m.visible).length;
  b.selectPiece(b.pieces[2]);
  check("one selected lights one", lit() === 1, `${lit()}`);
  b.selectRangeTo(b.pieces[6]);
  check("five selected lights five", lit() === 5, `${lit()}`);
  const anchors = b._selGroup.children.filter((m) => m.material === b._selMatAnchor).length;
  check("...with exactly one marked as the anchor", anchors === 1, `${anchors}`);
  b.deselectPiece();
  check("deselecting lights none", lit() === 0, `${lit()}`);
  check("...and does not leak meshes", b._selGroup.children.length === 0);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
