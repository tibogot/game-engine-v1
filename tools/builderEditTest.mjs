// Delete / replace / insert on the real ModularRoadBuilder (headless: camera and
// domElement omitted so the TransformControls gizmo is skipped; buildPiece works
// without a GPU). Verifies the chain stays connected after each edit.
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { ModularRoadBuilder } = await import(pathToFileURL(join(ROOT,"games/modular-road-v3/modularRoadBuilder.js")).href);

let fail = 0;
const check = (n, c, d="") => { console.log(`${c?"PASS":"FAIL"}  ${n}${d?"  — "+d:""}`); if(!c) fail++; };

const _p = new THREE.Vector3();
const posOf = (m) => _p.setFromMatrixPosition(m).clone();
/** A chain is connected iff each piece's connectorIn == the previous exit. */
function chainConnected(b, chainId) {
  const ps = b.pieces.filter(p => p.chainId === chainId);
  for (let i = 1; i < ps.length; i++) {
    const prevOut = posOf(ps[i-1].connectorOut);
    const curIn = posOf(ps[i].connectorIn);
    if (prevOut.distanceTo(curIn) > 1e-6) return false;
  }
  return true;
}
function fresh() {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  // lay a straight chain of 5
  for (let i = 0; i < 5; i++) { b.setActivePiece("straight"); b.place(); }
  return b;
}

{
  const b = fresh();
  check("baseline: 5 pieces, connected", b.pieces.length === 5 && chainConnected(b, 0));
  const endBefore = posOf(b.pieces[4].connectorOut);
  check("straights advance -Z", endBefore.z < -1, `end z ${endBefore.z.toFixed(1)}`);
}
{
  // DELETE a middle piece → 4 left, still connected, downstream shifted back.
  const b = fresh();
  const endBefore = posOf(b.pieces[4].connectorOut);
  const mid = b.pieces[2];
  check("deletePiece returns true", b.deletePiece(mid));
  check("one fewer piece", b.pieces.length === 4);
  check("chain still connected after mid delete", chainConnected(b, 0));
  const endAfter = posOf(b.pieces[3].connectorOut);
  check("track shortened by one piece", Math.abs(endBefore.z - endAfter.z) > 1,
    `end z ${endBefore.z.toFixed(1)} -> ${endAfter.z.toFixed(1)}`);
}
{
  // REPLACE a middle straight with a curve → same count, still connected,
  // and the exit direction changed (curve turns).
  const b = fresh();
  const p = b.pieces[2];
  const outBefore = posOf(b.pieces[4].connectorOut);
  check("replacePiece returns true", b.replacePiece(p, "curve"));
  check("same piece count", b.pieces.length === 5);
  check("replaced piece has the new id", b.pieces[2].id === "curve");
  check("chain still connected after replace", chainConnected(b, 0));
  const outAfter = posOf(b.pieces[4].connectorOut);
  check("a curve changed the downstream path", outBefore.distanceTo(outAfter) > 1,
    `end moved ${outBefore.distanceTo(outAfter).toFixed(1)} m`);
}
{
  // INSERT a curve before the middle piece → 6 pieces, connected, selected.
  const b = fresh();
  const target = b.pieces[2];
  check("insertPieceBefore returns true", b.insertPieceBefore(target, "curve"));
  check("one more piece", b.pieces.length === 6);
  check("inserted at the right slot", b.pieces[2].id === "curve" && b.pieces[3] === target);
  check("chain connected after insert", chainConnected(b, 0));
  check("insert selects the new piece", b.selectedPiece === b.pieces[2]);
}
{
  // Delete the FIRST piece (anchor-adjacent) — the chain must re-seat on the anchor.
  const b = fresh();
  const anchor = posOf(b.chains[0].anchor);
  b.deletePiece(b.pieces[0]);
  check("chain connected after deleting the first piece", chainConnected(b, 0));
  check("new first piece starts at the anchor",
    posOf(b.pieces[0].connectorIn).distanceTo(anchor) < 1e-6);
}
{
  // Delete the LAST piece behaves like undo (open end moves back).
  const b = fresh();
  b.deletePiece(b.pieces[4]);
  check("deleting the last piece leaves 4", b.pieces.length === 4);
  check("still connected", chainConnected(b, 0));
}
{
  // Selection lifecycle.
  const b = fresh();
  b.selectPiece(b.pieces[1]);
  check("selectPiece sets selection", b.selectedPiece === b.pieces[1]);
  b.deselectPiece();
  check("deselectPiece clears it", b.selectedPiece === null);
  b.selectPiece(b.pieces[3]);
  b.deletePiece(b.pieces[3]);
  check("deleting the selected piece clears selection", b.selectedPiece === null);
}
{
  // Bad inputs must no-op.
  const b = fresh();
  check("replace with unknown id fails", !b.replacePiece(b.pieces[0], "nope"));
  check("delete a stranger fails", !b.deletePiece({}));
  check("insert with unknown id fails", !b.insertPieceBefore(b.pieces[0], "nope"));
  check("still 5 pieces, connected", b.pieces.length === 5 && chainConnected(b, 0));
}

// ── PICKING (raycast → piece) ──────────────────────────────────────────────
// A real domElement can't exist in node, so inject a rect stub; pickPiece only
// reads _camera and _domElement.
{
  const b = fresh();
  const cam = new THREE.PerspectiveCamera(60, 800/600, 0.1, 2000);
  b._camera = cam;
  b._domElement = { getBoundingClientRect: () => ({ left:0, top:0, width:800, height:600 }) };
  const centre = (p) => new THREE.Vector3()
    .setFromMatrixPosition(p.connectorIn)
    .add(new THREE.Vector3().setFromMatrixPosition(p.connectorOut)).multiplyScalar(0.5);
  let allHit = true;
  for (let i = 0; i < b.pieces.length; i++) {
    const c = centre(b.pieces[i]);
    cam.position.set(c.x, c.y + 30, c.z);
    cam.up.set(0, 0, -1);
    cam.lookAt(c);
    cam.updateMatrixWorld(true);
    if (b.pickPiece(400, 300) !== b.pieces[i]) allHit = false;
  }
  check("pickPiece maps a screen ray to the piece under it", allHit);
  cam.position.set(0, 500, 0); cam.lookAt(0, 600, 0); cam.updateMatrixWorld(true);
  check("pickPiece returns null over empty space", b.pickPiece(400, 300) === null);
}



console.log("\n=== PIECE HOTKEYS KEEP THE PALETTE IN STEP ===");
// buildRoadPaletteUI needs a DOM, so this is a SOURCE-level contract rather than
// a behavioural one — but the bug it guards was pure state desync, and that is
// visible in the wiring.
//
// roadGame.js takes the keyboard in the CAPTURE phase (so the v3 editor's own
// shortcuts cannot reach the game), which leaves the palette's own keydown
// listener dead and makes roadGame responsible for the piece hotkeys. It called
// builder.setActivePiece() directly — but selecting a piece must ALSO clear any
// active prop/preset and switch the visible category, and that state is private
// to the palette. The result was a palette describing the previous selection
// while a different piece was actually being placed.
{
  const { readFileSync } = await import("node:fs");
  const paletteSrc = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js"), "utf8");
  const gameSrc = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");

  check("the palette exposes a single entry point for selecting a piece",
    /return \{[^}]*selectPieceById[^}]*\}/.test(paletteSrc));
  check("…which clears the prop/mover/preset selection",
    /function selectPieceById\([\s\S]{0,400}?activePresetId = null/.test(paletteSrc),
    "or the status line keeps naming the old preset");
  check("…and switches the visible category to the piece's own",
    /function selectPieceById\([\s\S]{0,400}?activeCategory = PIECE_TO_CATEGORY/.test(paletteSrc),
    "or the grid stays on a category the piece is not in");

  // The regression itself: the hotkey path must go through the palette.
  const hotkeyBlock = gameSrc.slice(
    gameSrc.indexOf("const byKey = PIECE_CATALOG.find"),
    gameSrc.indexOf("const byKey = PIECE_CATALOG.find") + 400,
  );
  check("roadGame's piece hotkeys go through it",
    /selectPieceById/.test(hotkeyBlock), hotkeyBlock.split("\n")[3]?.trim());
  check("…and no longer poke builder.setActivePiece behind the palette's back",
    !/setActivePiece/.test(hotkeyBlock),
    "half-selecting is what desynced the UI");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
