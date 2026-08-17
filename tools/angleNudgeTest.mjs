// TURNING THINGS BY EXACT STEPS.
//
// Yaw had Q/E. Pitch and roll had nothing but a gizmo drag — so banking a landing
// strip to a repeatable angle meant dragging and reading the number back out of
// the dev panel. Arrow keys now step all three axes by `snapYawDeg`, the SAME
// setting the rotate gizmo snaps to (Q/E were hardcoded to 15° and disagreed with
// the gizmo the moment you touched the Angle step slider).
//
// What matters here, in order: the step is exactly one step and repeats without
// drifting; the axes are the SEAM's, not the world's; and the three targets a
// "rotate" can mean are kept apart.
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
function fresh(n = 4) {
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
const upOf = (m) => new THREE.Vector3(0, 1, 0)
  .applyMatrix4(new THREE.Matrix4().extractRotation(m)).normalize();
const fwdOf = (m) => new THREE.Vector3(0, 0, -1)
  .applyMatrix4(new THREE.Matrix4().extractRotation(m)).normalize();

console.log("\n=== 1. ONE PRESS IS ONE STEP, AND IT REPEATS EXACTLY ===");
{
  const b = fresh();
  check("the step follows the Angle step setting, not a hardcoded 15°",
    Math.abs(deg(b.angleStep) - b.snapYawDeg) < 1e-9, `${deg(b.angleStep)} vs ${b.snapYawDeg}`);
  b.setSnap({ yawDeg: 45 });
  check("...so changing it changes the step", Math.abs(deg(b.angleStep) - 45) < 1e-9);
  b.setSnap({ yawDeg: 15 });

  b.selectPiece(b.pieces[1]);
  for (let i = 1; i <= 3; i++) {
    const r = b.nudgeAngle("roll", 1);
    check(`roll press ${i} lands on exactly ${15 * i}°`,
      r.ok && Math.abs(r.roll - 15 * i) < 1e-6, `got ${r.roll?.toFixed(4)}°`);
  }
  // ...and back again, with no accumulated float drift.
  for (let i = 0; i < 3; i++) b.nudgeAngle("roll", -1);
  check("three presses back is exactly zero again",
    Math.abs(b.pieceTiltDeg(b.pieces[1]).roll) < 1e-6,
    `${b.pieceTiltDeg(b.pieces[1]).roll.toExponential(2)}°`);
}

console.log("\n=== 2. PITCH AND ROLL ARE REAL, AND ARE DIFFERENT ===");
{
  const b = fresh();
  const p = b.pieces[1];
  b.selectPiece(p);
  const up0 = upOf(p.connectorIn), fwd0 = fwdOf(p.connectorIn);

  b.nudgeAngle("roll", 1);
  const upRoll = upOf(p.connectorIn), fwdRoll = fwdOf(p.connectorIn);
  check("roll tips the deck sideways", up0.angleTo(upRoll) > 1e-3,
    `up moved ${deg(up0.angleTo(upRoll)).toFixed(2)}°`);
  check("...without changing where it points", fwd0.angleTo(fwdRoll) < 1e-6,
    `travel moved ${deg(fwd0.angleTo(fwdRoll)).toFixed(4)}° — roll is about TRAVEL, ` +
    `so the heading must be untouched`);
  check("...and the readout calls it roll, not pitch",
    Math.abs(b.pieceTiltDeg(p).roll - 15) < 1e-6 && Math.abs(b.pieceTiltDeg(p).pitch) < 1e-6,
    JSON.stringify(b.pieceTiltDeg(p)));

  b.levelPiece(p);
  b.nudgeAngle("pitch", 1);
  const fwdPitch = fwdOf(p.connectorIn);
  check("pitch changes where it points", fwd0.angleTo(fwdPitch) > 1e-3,
    `travel moved ${deg(fwd0.angleTo(fwdPitch)).toFixed(2)}°`);
  check("...vertically", Math.abs(fwdPitch.y) > 0.2, `travel.y = ${fwdPitch.y.toFixed(3)}`);
  console.log(`        (pitch +1 sends the nose ${fwdPitch.y > 0 ? "UP" : "DOWN"}: travel.y = ${fwdPitch.y.toFixed(3)})`);
  check("...and the readout calls it pitch",
    Math.abs(b.pieceTiltDeg(p).pitch - 15) < 1e-6, JSON.stringify(b.pieceTiltDeg(p)));
}

console.log("\n=== 3. THE AXES ARE THE SEAM'S, NOT THE WORLD'S ===");
{
  // The point of composing on the right. Turn a piece 90° in yaw first: a
  // subsequent roll must still roll about ITS OWN travel, not about world Z.
  const b = fresh();
  const p = b.pieces[1];
  b.selectPiece(p);
  b.setSnap({ yawDeg: 90 });
  b.nudgeAngle("yaw", 1);            // now heading 90° away
  b.setSnap({ yawDeg: 15 });
  const fwdBefore = fwdOf(p.connectorIn);
  b.nudgeAngle("roll", 1);
  check("after a 90° yaw, roll still leaves the heading alone",
    fwdBefore.angleTo(fwdOf(p.connectorIn)) < 1e-6,
    `heading moved ${deg(fwdBefore.angleTo(fwdOf(p.connectorIn))).toFixed(3)}° — if this ` +
    `is nonzero the rotation is being applied in world space`);
  check("...and the deck really did bank",
    Math.abs(b.pieceTiltDeg(p).roll - 15) < 1e-6, JSON.stringify(b.pieceTiltDeg(p)));
}

console.log("\n=== 4. IT PROPAGATES DOWN THE CHAIN, AS BANKING MUST ===");
{
  const b = fresh(5);
  const before = b.pieces.map((x) => upOf(x.connectorIn).clone());
  b.selectPiece(b.pieces[1]);
  b.nudgeAngle("roll", 1);
  const moved = b.pieces.filter((x, i) => upOf(x.connectorIn).angleTo(before[i]) > 1e-4).length;
  check("tilting piece 1 banks it and everything after it", moved >= 4,
    `${moved} of 5 pieces changed — this is the banked-landing-strip tool, ` +
    `not a bug; the status line says so`);
  check("...but not the one BEFORE it",
    upOf(b.pieces[0].connectorIn).angleTo(before[0]) < 1e-9);
}

console.log("\n=== 5. THE THREE TARGETS STAY APART ===");
{
  const b = fresh(3);
  // GHOST: yaw only. A kit socket is level by convention, so a pitched ghost
  // would hand the next piece a seam it cannot honour.
  b.deselectPiece();
  b._syncGizmoToOpenEnd();
  check("the ghost accepts yaw", b.nudgeAngle("yaw", 1).ok);
  const pitchTry = b.nudgeAngle("pitch", 1);
  check("...and DECLINES pitch, with a reason", !pitchTry.ok && !!pitchTry.reason,
    JSON.stringify(pitchTry));
  const rollTry = b.nudgeAngle("roll", 1);
  check("...and roll", !rollTry.ok && !!rollTry.reason, JSON.stringify(rollTry));
}
{
  // CHAIN ANCHOR: all three axes, and the whole chain turns rigidly.
  const b = fresh(3);
  b.deselectPiece();
  b.selectChain(0);
  const r = b.nudgeAngle("roll", 1);
  check("a chain anchor accepts roll", r.ok && r.target === "chain", JSON.stringify(r));
  check("...and reports its tilt", Math.abs(r.roll - 15) < 1e-6, `${r.roll?.toFixed(3)}°`);
  const seams = b.pieces.map((x, i) => i === 0 ? 0
    : new THREE.Vector3().setFromMatrixPosition(b.pieces[i - 1].connectorOut)
      .distanceTo(new THREE.Vector3().setFromMatrixPosition(x.connectorIn)));
  check("...and the chain stays connected through it", Math.max(...seams) < 1e-6,
    `worst seam ${Math.max(...seams).toExponential(2)} m`);
}
{
  const b = fresh(3);
  b.selectPiece(b.pieces[0]);
  check("a selected piece wins over the ghost", b.nudgeAngle("roll", 1).target === "piece");
}

console.log("\n=== 6. IT IS ONE UNDO STEP PER PRESS ===");
{
  const b = fresh(3);
  b.selectPiece(b.pieces[1]);
  const n = b._undoStack.length;
  b.nudgeAngle("roll", 1);
  b.nudgeAngle("roll", 1);
  check("two presses are two steps", b._undoStack.length === n + 2,
    `+${b._undoStack.length - n}`);
  b.undo(); b.undo();
  check("...and undo takes the tilt back off",
    Math.abs(b.pieceTiltDeg(b.pieces[1]).roll) < 1e-9,
    `${b.pieceTiltDeg(b.pieces[1]).roll.toFixed(4)}°`);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
