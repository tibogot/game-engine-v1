// A PRESS THAT LANDS ON A GIZMO IS NOT NECESSARILY A GRAB.
//
// The build cursor's gizmo is parked on the chain's open end — exactly where the
// next piece goes — and TransformControls' pickers are invisible meshes far
// fatter than the drawn arrows, scaled to a constant screen size (~150 px of
// reach, ~50 px thick at the placement gizmo's size). roadGame used to refuse
// the place-click outright whenever a gizmo reported "in use", and those report
// on HOVER, so the one spot you most wanted to click was a hole. The workaround
// was to zoom in until the handles were small enough to aim around.
//
// The rule now: the press still goes to the gizmo, and on pointerUP, if the
// pointer sat still AND nothing moved, it was a click after all — place. Same
// idiom the right button already uses to tell a pan from a select.
//
// This runs roadGame's ACTUAL handler source rather than a copy of it: the block
// is lifted out of the file and evaluated with fakes for everything it touches,
// so a change to the real logic shows up here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const game = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

/* Lift the LMB block: from the gizmo probe through the end of the pointerup. */
const START = "  const anyGizmoUnderPointer = () =>";
const END = "\n\n  // RIGHT-CLICK selects a placed piece to edit";
const i = game.indexOf(START), j = game.indexOf(END);
if (i < 0 || j < 0) { console.log("FAIL  could not lift the LMB block from roadGame.js"); process.exit(1); }
const LIFTED = game.slice(i, j);

check("the lifted block is the real one",
  LIFTED.includes("lmbHeldByGizmo") && LIFTED.includes("gizmoPoseKey()") && LIFTED.includes("placeAtPointer(e)"));
// The block declares its own `gizmoRoots` (hoisted so an early pointer event
// cannot hit the temporal dead zone). Drop that one line so the harness can
// inject a populated list in its place — asserted, so losing the hoist is loud.
check("gizmoRoots is declared before the handlers, not after them",
  LIFTED.includes("const gizmoRoots = [];"),
  "hoisted on purpose: a click during setup would otherwise throw a ReferenceError");
const SRC = LIFTED.split("  const gizmoRoots = [];").join("");

/** One canvas' worth of listeners. */
function harness({ gizmoHot = false, pose = "A" } = {}) {
  const listeners = {};
  const placed = [];
  const state = { gizmoHot, pose };
  const gizmo = { isUsingGizmo: () => state.gizmoHot };
  const renderer = {
    domElement: {
      addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    },
  };
  // gizmoPoseKey walks these — one root whose object carries the current pose.
  const gizmoRoots = [{
    controls: { object: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } },
  }];
  const setPose = (p) => { gizmoRoots[0].controls.object.position.x = p; };

  const run = new Function(
    "renderer", "mode", "props", "movers", "portals", "builder", "placeAtPointer", "gizmoRoots",
    SRC);
  run(renderer, "build", gizmo, gizmo, gizmo,
      { isUsingPlacementGizmo: () => state.gizmoHot },
      (e) => placed.push({ x: e.clientX, y: e.clientY }), gizmoRoots);

  const fire = (type, x, y, button = 0) =>
    listeners[type].forEach((fn) => fn({ button, clientX: x, clientY: y }));
  return { fire, placed, state, setPose };
}

console.log("\n=== NOTHING UNDER THE POINTER: UNCHANGED, PLACES ON THE PRESS ===");
{
  const h = harness();
  h.fire("pointerdown", 100, 100);
  check("a plain click places immediately", h.placed.length === 1, "no waiting for the release");
  h.fire("pointerup", 100, 100);
  check("...and the release does not place a second one", h.placed.length === 1);
}

console.log("\n=== A CLICK THAT LANDS ON A GIZMO (the bug) ===");
{
  const h = harness({ gizmoHot: true });
  h.fire("pointerdown", 100, 100);
  check("the press itself places nothing", h.placed.length === 0, "the gizmo may still be grabbing it");
  h.fire("pointerup", 100, 100);
  check("the release places, because nothing happened", h.placed.length === 1,
    "this is the whole fix — no zooming in to aim around the handles");
}
{
  const h = harness({ gizmoHot: true });
  h.fire("pointerdown", 100, 100);
  h.fire("pointerup", 103, 102);  // 3.6 px — a shaky click, not a drag
  check("a shaky click still places", h.placed.length === 1, "3.6 px, inside the 6 px slop");
}

console.log("\n=== A REAL DRAG IS LEFT ALONE ===");
{
  const h = harness({ gizmoHot: true });
  h.fire("pointerdown", 100, 100);
  h.fire("pointerup", 140, 100);
  check("dragging the gizmo places nothing", h.placed.length === 0, "40 px");
}
{
  // The case pixels alone cannot catch: 6 px on a far-out camera is metres of
  // chain, and the gizmo moved even though the pointer barely did.
  const h = harness({ gizmoHot: true });
  h.fire("pointerdown", 100, 100);
  h.setPose(12);
  h.fire("pointerup", 102, 100);
  check("a 2 px drag that MOVED something places nothing", h.placed.length === 0,
    "pose changed — pixels alone would have called this a click");
}
{
  // ...and the converse: the pose test alone would let a long snapped drag that
  // happens to end where it started count as a click.
  const h = harness({ gizmoHot: true });
  h.fire("pointerdown", 100, 100);
  h.fire("pointerup", 100, 180);
  check("a long drag that snapped back places nothing", h.placed.length === 0,
    "80 px — the pixel test is what catches this one");
}

console.log("\n=== THE PENDING PRESS DOES NOT LEAK ===");
{
  const h = harness({ gizmoHot: true });
  h.fire("pointerdown", 100, 100);
  h.fire("pointerup", 100, 100);
  h.fire("pointerup", 100, 100);          // a stray second release
  check("one press places exactly once", h.placed.length === 1);
}
{
  const h = harness({ gizmoHot: true });
  h.fire("pointerdown", 100, 100);
  h.fire("pointerup", 100, 100, 2);       // right button up
  check("another button's release does not consume it", h.placed.length === 0);
  h.fire("pointerup", 100, 100, 0);
  check("...the left release still does", h.placed.length === 1);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
