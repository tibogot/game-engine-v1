// A PLACEMENT BRUSH OWNS THE POINTER — the four editing gizmos must put their
// handles down while one is armed, WITHOUT losing the selection.
//
// The bug this pins: roadGame's LMB place-click is refused whenever a gizmo
// reports isUsingGizmo(), and those report true on HOVER (`gizmo.axis != null`),
// not just on drag. TransformControls' pickers are invisible meshes far fatter
// than the drawn arrows, scaled to a constant screen size, so a selected object
// carried a ~230-300 px hole you could not drop anything into. Worse, add()
// SELECTS what it just placed, so laying a run of props re-armed the trap under
// the cursor on every click.
//
// Headless: the managers are grafted onto their prototypes (Object.create), so
// none of the scene/material/GPU construction runs — only the state machine
// under test. Same trick as tools/riverBranchTest.mjs.
import { registerHeadlessThree } from "./headlessThreeHooks.mjs";
registerHeadlessThree(); // PropManager's import graph reaches WebGPU-only modules
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const G = (f) => pathToFileURL(join(ROOT, "games/modular-road-v3", f)).href;

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

/** TransformControls stand-in. `helper` is STABLE, like the real getHelper(). */
function fakeGizmo() {
  const helper = new THREE.Object3D();
  helper.visible = false;
  return {
    enabled: false, mode: "translate", dragging: false, axis: null,
    object: undefined, helper,
    showX: true, showY: true, showZ: true,
    setMode(m) { this.mode = m; }, setSpace() {}, setSize() {},
    attach(o) { this.object = o; this.helper.visible = true; },  // real attach SHOWS the helper
    detach() { this.object = undefined; this.helper.visible = false; },
    getHelper() { return this.helper; },
    addEventListener() {}, removeEventListener() {},
  };
}
// Stands in for the Box3Helper. It is an Object3D in the real managers, so it
// grows Object3D calls over time — _syncSelBox() now also drives its matrix.
const fakeBox = () => ({ visible: false, setFromObject() {}, updateMatrixWorld() {} });

const { PropManager } = await import(G("modularRoadProps.js"));
const { MoverPropManager } = await import(G("modularRoadMoverProps.js"));
const { PortalManager } = await import(G("modularRoadPortals.js"));
const { ModularRoadBuilder } = await import(G("modularRoadBuilder.js"));

/** Bare instance with only the members suspendGizmo touches. */
function bare(Ctor, extra = {}) {
  const m = Object.create(Ctor.prototype);
  m.gizmo = fakeGizmo();
  m.selBox = fakeBox();
  // MoverPropManager._syncSelBox() unions the visible meshes into this; it was
  // added after this stub was written, so without it _select() throws before a
  // single suspend/resume check gets to run.
  m._selBounds = new THREE.Box3();
  m.selected = null;
  m._gizmoSuspended = false;
  return Object.assign(m, extra);
}

/* ---------------------------------------------------------------- props --- */
{
  const p = bare(PropManager, { enabled: true, instances: [] });
  const inst = { root: new THREE.Object3D() };

  p._select(inst);
  check("props: select arms the gizmo", p.gizmo.enabled === true && p.gizmo.helper.visible === true);
  check("props: isUsingGizmo trips on HOVER (the whole bug)",
    (p.gizmo.axis = "X", p.isUsingGizmo() === true));
  p.gizmo.axis = null;

  p.suspendGizmo(true);
  check("props: suspend disables the gizmo", p.gizmo.enabled === false);
  check("props: suspend hides the handles", p.gizmo.helper.visible === false);
  check("props: suspend KEEPS the selection", p.selected === inst && p.gizmo.object === inst.root);
  check("props: suspend keeps the highlight box", p.selBox.visible === true);
  check("props: suspend clears a latched axis", p.gizmo.axis === null && p.isUsingGizmo() === false);

  // The compounding case: placing a prop selects it, so a run of props used to
  // re-arm the trap on every click. _select must respect the suspend.
  const inst2 = { root: new THREE.Object3D() };
  p._select(inst2);
  check("props: a select DURING a brush stays suspended",
    p.gizmo.enabled === false && p.gizmo.helper.visible === false,
    "add() selects what it just placed");
  check("props: that selection still took", p.selected === inst2);

  p.suspendGizmo(false);
  check("props: resume re-arms the gizmo", p.gizmo.enabled === true && p.gizmo.helper.visible === true);

  p.deselect();
  p.suspendGizmo(true); p.suspendGizmo(false);
  check("props: resume with NOTHING selected leaves it off",
    p.gizmo.enabled === false && p.gizmo.helper.visible === false);
}

/* --------------------------------------------------------------- movers --- */
{
  const m = bare(MoverPropManager, { enabled: true, instances: [] });
  const inst = { root: new THREE.Object3D() };
  m._select(inst);
  m.suspendGizmo(true);
  check("movers: suspend disables + hides", m.gizmo.enabled === false && m.gizmo.helper.visible === false);
  check("movers: selection survives", m.selected === inst);
  check("movers: no longer eats the click", (m.gizmo.axis = null, m.isUsingGizmo() === false));
  m.suspendGizmo(false);
  check("movers: resume re-arms", m.gizmo.enabled === true && m.gizmo.helper.visible === true);
}

/* -------------------------------------------------------------- portals --- */
{
  const q = bare(PortalManager, { buildEnabled: true, doors: [] });
  const door = { root: new THREE.Object3D() };
  q._select(door);
  q.suspendGizmo(true);
  check("portals: suspend disables + hides", q.gizmo.enabled === false && q.gizmo.helper.visible === false);
  check("portals: selection survives", q.selected === door);
  q.suspendGizmo(false);
  check("portals: resume re-arms", q.gizmo.enabled === true && q.gizmo.helper.visible === true);
}

/* -------------------------------------------------------------- builder --- */
{
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(), material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(), shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  b.placementGizmo = fakeGizmo();
  b.freePlaceMode = true;
  b._showPlacementGizmo();
  check("builder: show arms the placement gizmo",
    b.placementGizmo.enabled === true && b.placementGizmo.helper.visible === true);
  b.placementGizmo.axis = "Y";
  check("builder: hover trips isUsingPlacementGizmo", b.isUsingPlacementGizmo() === true);

  b.suspendGizmo(true);
  check("builder: suspend disables + hides",
    b.placementGizmo.enabled === false && b.placementGizmo.helper.visible === false);
  check("builder: suspend clears the latched axis", b.isUsingPlacementGizmo() === false);
  check("builder: the pivot stays attached", b.placementGizmo.object === b.placementPivot);

  // Re-showing while suspended (the build cursor moves under a live prop brush)
  // must not sneak the handles back.
  b._showPlacementGizmo();
  check("builder: a re-show DURING a brush stays suspended",
    b.placementGizmo.enabled === false && b.placementGizmo.helper.visible === false);

  b.suspendGizmo(false);
  check("builder: resume re-arms", b.placementGizmo.enabled === true && b.placementGizmo.helper.visible === true);

  b._hidePlacementGizmo();
  b.suspendGizmo(true); b.suspendGizmo(false);
  check("builder: resume with nothing attached leaves it off",
    b.placementGizmo.enabled === false && b.placementGizmo.helper.visible === false);
}

/* ------------------------------------------ drive-mode leftover helper --- */
{
  // B into play used to re-attach the placement arrows: toggleMode hid them,
  // then deselectPiece handed the gizmo back to the open end, and attach()
  // always shows the helper. Pressing B twice "fixed" it because the second
  // trip had nothing selected so deselectPiece returned early.
  let build = true;
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(), material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(), shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
    isBuildMode: () => build,
  });
  b.placementGizmo = fakeGizmo();
  b.setActivePiece("straight");
  b.place();
  b.selectPiece(b.pieces[0]);
  check("drive leftover: select in build shows the helper",
    b.placementGizmo.helper.visible === true && b.placementGizmo.object != null);

  build = false;
  b.deselectPiece();
  check("drive leftover: deselect in drive HIDES the helper",
    b.placementGizmo.helper.visible === false);
  check("drive leftover: deselect in drive DETACHES",
    b.placementGizmo.object === undefined);
  check("drive leftover: selection is gone",
    b.selectedPiece == null && b.selectionCount === 0);

  b._syncGizmoToOpenEnd();
  check("drive leftover: sync-to-open-end in drive does not re-attach",
    b.placementGizmo.helper.visible === false && b.placementGizmo.object === undefined);
  b._showPlacementGizmo();
  check("drive leftover: show in drive does not re-attach",
    b.placementGizmo.helper.visible === false && b.placementGizmo.object === undefined);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
