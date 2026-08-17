// PLACING A LANDING AFTER A JUMP — where the grid helps and where it lies.
//
// Grid snapping is right for a point you are AUTHORING (drop a chain somewhere
// tidy, so two separately-built chains can meet) and wrong for a point that was
// DERIVED (this is where the car lands). One global `snapEnabled` used to govern
// both, so three separate things conspired to move a landing pad away from the
// place the car actually comes down:
//
//   1. snapLanding() handed a computed ballistic point to beginNewChain, which
//      rounded it to the 8 m grid and the 15° yaw grid.
//   2. the ghost gizmo rounded its ABSOLUTE position on every drag frame, so one
//      nudge yanked the pad back onto the lattice.
//   3. the gizmo only ever had WORLD axes, and a takeoff points wherever the
//      last corner left it — so "further along the flight line" was two drags.
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
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);
const f = (v) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
function fresh() {
  return new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
}

console.log("\n=== 1. A COMPUTED LANDING POINT IS NOT ROUNDED ===");
{
  const b = fresh();
  // Deliberately off-grid in all three axes and off the 15° yaw grid — which is
  // what a ballistic solve gives you basically always.
  const landing = V(37.4, 40.6, -118.63);
  const yaw = THREE.MathUtils.degToRad(37.2);

  b.beginNewChain(landing.clone(), yaw, { exact: true });
  const anchor = pos(b.chains.find((c) => c.id === b.activeChainId).anchor);
  check("the chain anchor sits exactly on the landing point",
    anchor.distanceTo(landing) < 1e-9,
    `${f(anchor)} vs ${f(landing)} — off by ${anchor.distanceTo(landing).toFixed(3)} m`);
  check("...and keeps the exact heading too",
    Math.abs(b.freeYaw - yaw) < 1e-9,
    `${THREE.MathUtils.radToDeg(b.freeYaw).toFixed(2)}° vs ${THREE.MathUtils.radToDeg(yaw).toFixed(2)}°`);

  // And the first piece placed there starts on it.
  b.setActivePiece("straight");
  b.place();
  check("the piece placed there starts on it as well",
    pos(b.pieces[0].connectorIn).distanceTo(landing) < 1e-9,
    `${f(pos(b.pieces[0].connectorIn))}`);
}
{
  // The default is still the grid — authoring a chain by hand should land tidy.
  const b = fresh();
  b.beginNewChain(V(37.4, 40.6, -118.63), THREE.MathUtils.degToRad(37.2));
  const anchor = pos(b.chains.find((c) => c.id === b.activeChainId).anchor);
  const onGrid = [anchor.x, anchor.y, anchor.z].every((v) => Math.abs(v % b.snapStep) < 1e-9);
  check("without `exact`, a new chain still snaps to the build grid", onGrid, f(anchor));
  console.log(`        (grid moved it ${anchor.distanceTo(V(37.4, 40.6, -118.63)).toFixed(2)} m — ` +
    `right when you are choosing a spot, wrong when physics chose it)`);
}
{
  // The measurement that started this: how far off is a typical jump landing?
  const b = fresh();
  const cases = [V(37.4, 40, -118.6), V(61.2, 33.5, -204.9), V(-13.7, 52.2, 77.1)];
  const errs = cases.map((c) => { const s = b.snapPos(c.clone()); return c.distanceTo(s); });
  check("the old behaviour really did move the pad metres", Math.max(...errs) > 2,
    `worst ${Math.max(...errs).toFixed(2)} m`);
  console.log(`        (grid error on three ordinary landings: ` +
    `${errs.map((e) => e.toFixed(2) + " m").join(", ")})`);
}

console.log("\n=== 2. THE GHOST SNAPS THE DRAG, NOT THE ABSOLUTE POSE ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  b.place();
  // Park the ghost on an off-grid spot, as a landing pad always is.
  const parked = V(37.4, 40.6, -118.63);
  b._gizmoTarget = "ghost";
  b.ghostDetached = true;
  b._ghostPos.copy(parked);
  b._dragStartPos.copy(parked);

  // A tiny drag — smaller than half a grid step, so it should round to nothing.
  b._snapDeltaProbe = V(1.0, 0, 0);
  const d = V(1.0, 0, 0);
  b._snapDelta(d);
  const after = parked.clone().add(d);
  check("a sub-step nudge leaves the pad exactly where it was",
    after.distanceTo(parked) < 1e-9,
    `moved ${after.distanceTo(parked).toFixed(3)} m — absolute rounding would have ` +
    `teleported it to the nearest cell instead`);

  // A full step moves exactly one step, and only on the axis you dragged.
  const d2 = V(9.0, 0, 0);
  b._snapDelta(d2);
  const after2 = parked.clone().add(d2);
  check("a one-step drag moves exactly one step", Math.abs(d2.x - 8) < 1e-9, f(d2));
  check("...on that axis only", Math.abs(after2.y - parked.y) < 1e-9
    && Math.abs(after2.z - parked.z) < 1e-9, f(after2));
  check("...and the pad stays off-grid, as it must",
    Math.abs(after2.z % b.snapStep) > 1e-6, `z ${after2.z}`);
}
{
  // The gizmo's own absolute rounding must be OFF for the ghost, or it rounds
  // before our delta maths ever sees the position.
  const b = fresh();
  const g = { setMode() {}, setSpace() {}, addEventListener() {}, getHelper: () => ({}),
    translationSnap: null, rotationSnap: null };
  b.placementGizmo = g;
  for (const [target, wantAbsolute] of [["chain", true], ["ghost", false], ["piece", false]]) {
    b._gizmoTarget = target;
    b._applyGizmoSnap();
    check(`${target}: absolute translationSnap ${wantAbsolute ? "on" : "OFF"}`,
      (g.translationSnap !== null) === wantAbsolute, `got ${g.translationSnap}`);
  }
}

console.log("\n=== 3. LOCAL AXES ===");
{
  const b = fresh();
  const spaces = [];
  b.placementGizmo = { setSpace: (s) => spaces.push(s) };
  check("world is the default", b.gizmoSpace === "world", b.gizmoSpace);
  check("toggling gives local", b.togglePlacementGizmoSpace() === "local");
  check("...and it reaches TransformControls", spaces.at(-1) === "local", spaces.join(","));
  check("toggling again returns to world", b.togglePlacementGizmoSpace() === "world");
}
{
  // In LOCAL space the delta must keep its direction — rounding each world
  // component separately would knock a local-axis drag off the very axis the
  // handle exists to hold.
  const b = fresh();
  b.placementGizmo = { setSpace() {} };
  b.setPlacementGizmoSpace("local");
  // A drag along a 37° heading, 9 m of it.
  const dirv = V(Math.sin(0.65), 0, -Math.cos(0.65)).normalize();
  const d = dirv.clone().multiplyScalar(9);
  b._snapDelta(d);
  check("local snapping rounds the DISTANCE to a step",
    Math.abs(d.length() - 8) < 1e-9, `${d.length().toFixed(4)} m`);
  check("...and keeps the direction exactly",
    d.clone().normalize().dot(dirv) > 1 - 1e-9,
    `dot ${d.clone().normalize().dot(dirv).toFixed(9)} — per-axis rounding would ` +
    `have bent the move off the axis`);

  b.setPlacementGizmoSpace("world");
  const dw = V(9, 0, 3);
  b._snapDelta(dw);
  check("world snapping still rounds per axis",
    Math.abs(dw.x - 8) < 1e-9 && Math.abs(dw.z - 0) < 1e-9, f(dw));
}

console.log("\n=== 4. NOTHING ELSE MOVED ===");
{
  // The demo track seeds its landing chain through the same `exact` path now.
  const b = fresh();
  b.loadDemo();
  check("the demo track still builds", b.pieces.length > 10, `${b.pieces.length} pieces`);
  check("...across more than one chain (the jump seeds a second)", b.chains.length > 1,
    `${b.chains.length} chains`);
  const b2 = fresh();
  b2.loadBigCircuit();
  check("the big circuit still builds", b2.pieces.length > 10, `${b2.pieces.length} pieces`);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
