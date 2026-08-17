// ONE RIGHT-CLICK, ARBITRATED — front-most wins.
//
// There used to be FOUR right-click selectors on the same canvas. Props, movers
// and portals each listened on pointerDOWN and raycast their own group; the road
// builder listened on pointerUP. Right-click a boost pad sitting on a road and
// both fired: the pad got selected, then the road's ray went straight through it,
// hit the deck underneath and selected that too — and because it ran second, it
// took the gizmo the pad had just claimed. Nothing was wrong with any one picker;
// nobody was deciding between them.
//
// Every system now answers the same question — "what is under this pixel, and how
// far away is it?" — and roadGame keeps the nearest. This checks the two halves
// that have to hold for that to work: the shape of the answer, and that no module
// still selects behind the arbiter's back.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import * as THREE from "three";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, "games/modular-road-v3", p), "utf8");

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};

const SYSTEMS = [
  ["modularRoadProps.js", "props"],
  ["modularRoadMoverProps.js", "movers"],
  ["modularRoadPortals.js", "portals"],
];

console.log("\n=== NOBODY SELECTS BEHIND THE ARBITER'S BACK ===");
{
  for (const [file, name] of SYSTEMS) {
    const src = read(file);
    check(`${name}: no right-click listener of its own`,
      !/button === 2/.test(src),
      "a second listener is how a pad and the road under it both got selected");
    check(`${name}: exposes hitTest`, /\bhitTest\(clientX, clientY\)/.test(src));
    check(`${name}: exposes selectHit`, /\bselectHit\(hit\)/.test(src));
    check(`${name}: the dead picker is gone`, !/_pickAt/.test(src),
      "dead code that looks live is worse than no code");
  }
  const b = read("modularRoadBuilder.js");
  check("the builder exposes pickPieceHit", /\bpickPieceHit\(clientX, clientY\)/.test(b));
}

console.log("\n=== THE ARBITER PICKS THE NEAREST, AND CLEARS THE REST ===");
{
  const game = read("roadGame.js");
  const fn = (game.split("function selectUnderCursor(e) {")[1] ?? "").split("\n  }")[0];
  check("there is exactly one right-click selection path",
    (game.match(/selectUnderCursor\(/g) || []).length === 2, // the call + the definition
    "one call site and one definition, or something is picking twice again");
  check("it asks every system", ["props.hitTest", "movers.hitTest", "portals.hitTest",
    "builder.pickPieceHit"].every((s) => fn.includes(s)),
    "a system that is not asked can never win");
  check("it sorts by distance", /sort\(\(a, b\) => a\.hit\.dist - b\.hit\.dist\)/.test(fn),
    "front-most is the whole rule");
  check("it clears the systems that did not win", /selectHit\?\.\(null\)/.test(fn));
  check("...and the road too", /builder\.deselectPiece\(\)/.test(fn));
  check("it still runs behind the pan test", /if \(moved > 6\) return;/.test(game),
    "right is also the camera pan button — a drag must not select");
}

console.log("\n=== THE ROAD'S OWN HIT TEST STILL WORKS, AND REPORTS DISTANCE ===");
{
  // The one part that can be exercised for real headlessly: the builder needs a
  // camera and a DOM rect, both of which are plain objects.
  const { ModularRoadBuilder } = await import(
    pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  const W = 1280, H = 720;
  const cam = new THREE.PerspectiveCamera(60, W / H, 0.1, 5000);
  b._camera = cam;
  b._domElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };

  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  const target = b.pieces[1];
  const p = new THREE.Vector3().setFromMatrixPosition(target.connectorIn);
  // Look straight down at the middle piece.
  cam.position.set(p.x, p.y + 60, p.z);
  cam.lookAt(p);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const hit = b.pickPieceHit(W / 2, H / 2);
  check("it finds the piece under the centre of the screen", !!hit);
  if (hit) {
    check("...and reports it as the piece, not a mesh",
      b.pieces.includes(hit.hit), `${hit.hit?.id}`);
    check("...with a plausible camera distance",
      hit.dist > 50 && hit.dist < 70, `${hit.dist?.toFixed(1)} m from a 60 m camera`);
    check("...matching what pickPiece returns", b.pickPiece(W / 2, H / 2) === hit.hit);
  }
  // Off the track entirely.
  check("it reports nothing when the pointer is off the track",
    b.pickPieceHit(4, 4) === null);
}

console.log("\n=== A NEARER THING WINS (the actual bug) ===");
{
  // The arbiter is DOM-bound, so this reproduces its rule on the two distances:
  // a pad sitting on a road is nearer the camera than the deck beneath it, so it
  // must win — and previously BOTH were selected.
  const pick = (cands) => cands.filter((c) => c.hit)
    .sort((a, b) => a.hit.dist - b.hit.dist)[0] ?? null;
  const padOnRoad = pick([
    { who: "prop", hit: { dist: 58.2 } },   // pad, sitting proud of the deck
    { who: "road", hit: { dist: 58.9 } },   // the deck under it
  ]);
  check("a pad on a road beats the road", padOnRoad.who === "prop", padOnRoad.who);
  const bareRoad = pick([
    { who: "prop", hit: null },
    { who: "road", hit: { dist: 61.0 } },
  ]);
  check("bare deck beside it still selects the road", bareRoad.who === "road");
  check("empty sky selects nothing", pick([{ who: "prop", hit: null }, { who: "road", hit: null }]) === null);
}

console.log("\n=== ONE KEYMAP ACROSS ROAD AND OBSTACLES ===");
{
  // The keys used to disagree: obstacles toggled world/local on Q, which is the
  // ROAD's yaw nudge — so one key meant two things depending on what happened to
  // be selected. And exact angle steps existed only for road pieces, so a boost
  // pad you wanted at 45° was a matter of dragging the gizmo and squinting.
  for (const [file, name] of SYSTEMS) {
    const src = read(file);
    check(`${name}: world/local is X`, /case "KeyX":/.test(src));
    check(`${name}: Q means nothing here any more`, !/case "KeyQ"/.test(src),
      "Q is the road's yaw nudge — it cannot also toggle axes");
    check(`${name}: can be turned by an exact angle`,
      /rotateSelectedBy\(axis, radians\)/.test(src));
  }
  const game = read("roadGame.js");
  check("the arrows try the obstacle systems before the road",
    /for \(const sys of \[props, movers, portals\]\)[\s\S]{0,600}rotateSelectedBy/.test(game),
    "otherwise a selected pad would silently tilt the road under it");
  check("...using the builder's angle step, not a second one",
    /rotateSelectedBy\?\.\(axis, builder\.angleStep/.test(game),
    "one setting, or a pad and a road piece turn by different amounts");
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
