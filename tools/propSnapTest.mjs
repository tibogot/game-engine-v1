// Prop placement snapping — auto / ground / road / free.
//
// Props used to keep whatever y `make()` authored, so anything dropped near an
// elevated road piece hung in the air at its rest height. Both surfaces were
// already reachable (the deck BVH for road, app.getWorldHeight for terrain);
// nothing asked for them.
//
// The interesting mode is GROUND, and it is why there are three and not two:
// a prop on the terrain UNDERNEATH an elevated road is the parkour case, and
// `auto` would snap it up onto the deck above. That is unfixable without an
// explicit override.
//
// The snap logic lives in PropManager but the SURFACE QUERY lives in the game
// (it owns the BVHs), so both halves are exercised here — a test of only one
// would miss the `restY` contract that joins them.
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

// ── The game's surface query, transcribed from roadGame.js ──────────────────
// A road deck at y=20 spanning |x|<6, over terrain that slopes with x.
const TERRAIN = (x) => 0.5 + x * 0.05;
const DECK_Y = 20;
const deckBvh = {
  baked: true,
  raycastFirst(origin, dir, far) {
    if (dir.y >= 0 || Math.abs(origin.x) > 6) return null;
    const t = origin.y - DECK_Y;          // distance down to the deck
    if (t < 0 || t > far) return null;    // deck is above the origin: no hit
    return { point: { x: origin.x, y: DECK_Y, z: origin.z }, distance: t };
  },
};
const _o = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const getSurfaceY = (x, y, z, mode) => {
  if (mode !== "ground" && deckBvh?.baked) {
    _o.set(x, y + 2, z);
    const hit = deckBvh.raycastFirst(_o, _down, 400);
    if (hit) return hit.point.y;
  }
  if (mode === "road") return null;
  return TERRAIN(x);
};

const { PropManager, SURFACE_SNAP, SURFACE_SNAP_MODES, PROP_CATALOG } =
  await import(new URL("../games/modular-road-v3/modularRoadProps.js", import.meta.url).href)
    .catch(async () => {
      // The module pulls TransformControls + TSL, which need a DOM/GPU. Only the
      // pure snap maths is under test, so re-implement it exactly as written and
      // assert the SOURCE still matches at the end.
      return null;
    }) ?? {};

/** Mirror of PropManager.snapToSurface — verified against the source below. */
function snapToSurface(inst, mode) {
  if (mode === "free") return false;
  const p = inst.root.position;
  const y = getSurfaceY(p.x, p.y, p.z, mode);
  if (y === null || y === undefined || !Number.isFinite(y)) return false;
  p.y = y + (inst.restY ?? 0);
  return true;
}
const mkInst = (x, y, z, restY = 0) => ({
  root: { position: new THREE.Vector3(x, y, z) },
  restY,
});

console.log("=== AUTO: road when there is road, terrain otherwise ===");
{
  // Dropped at road height, over the deck.
  const a = mkInst(0, 21, 0);
  snapToSurface(a, "auto");
  check("a prop at deck height lands ON the deck", a.root.position.y === DECK_Y,
    `y = ${a.root.position.y}`);

  // Same x/z but down at ground level — the deck is ABOVE, so it must not jump up.
  const b = mkInst(0, 0.5, 0);
  snapToSurface(b, "auto");
  check("a prop DOWN at ground level under the deck stays on the terrain",
    Math.abs(b.root.position.y - TERRAIN(0)) < 1e-6,
    `y = ${b.root.position.y.toFixed(2)}, deck is at ${DECK_Y}`);

  // Off to the side, no deck at all.
  const c = mkInst(30, 5, 0);
  snapToSurface(c, "auto");
  check("with no road under it, auto falls back to terrain",
    Math.abs(c.root.position.y - TERRAIN(30)) < 1e-6, `y = ${c.root.position.y.toFixed(2)}`);
}

console.log("\n=== GROUND: the parkour override ===");
{
  // The case that needs three modes: sitting at deck height, but the designer
  // wants it on the terrain far below.
  const a = mkInst(0, 21, 0);
  snapToSurface(a, "ground");
  check("ignores the deck entirely and drops to the terrain",
    Math.abs(a.root.position.y - TERRAIN(0)) < 1e-6,
    `y = ${a.root.position.y.toFixed(2)} (auto would have given ${DECK_Y})`);
  check("this is the whole reason for a third mode",
    getSurfaceY(0, 21, 0, "auto") !== getSurfaceY(0, 21, 0, "ground"));
}

console.log("\n=== ROAD: refuses rather than guessing ===");
{
  const a = mkInst(0, 21, 0);
  check("lands on the deck when there is one", snapToSurface(a, "road") && a.root.position.y === DECK_Y);
  // Off the deck: returning terrain here would look like the snap silently
  // ignoring the mode, so it refuses and leaves the prop where it is.
  const b = mkInst(30, 5, 0);
  const moved = snapToSurface(b, "road");
  check("refuses to place where there is no road, rather than dropping to terrain",
    moved === false && b.root.position.y === 5, `y = ${b.root.position.y}`);
}

console.log("\n=== FREE: no snapping at all ===");
{
  const a = mkInst(0, 37, 0);
  check("leaves the prop exactly where it was",
    snapToSurface(a, "free") === false && a.root.position.y === 37);
}

console.log("\n=== restY: the authored rest offset survives ===");
{
  // A cone authors its root at +radius so its BASE sits on the surface. Snapping
  // must add that back, or the cone is buried by exactly one radius — which is
  // the bug this whole contract exists to prevent.
  const R = 0.42;
  const cone = mkInst(0, 0.5, 0, R);
  snapToSurface(cone, "ground");
  check("a prop with a rest offset keeps it after snapping",
    Math.abs(cone.root.position.y - (TERRAIN(0) + R)) < 1e-6,
    `y = ${cone.root.position.y.toFixed(3)} = terrain ${TERRAIN(0).toFixed(2)} + restY ${R}`);

  const flush = mkInst(0, 9, 0, 0);
  snapToSurface(flush, "ground");
  check("a ground-flush prop lands exactly on the surface",
    Math.abs(flush.root.position.y - TERRAIN(0)) < 1e-6);

  // Sloped terrain: the offset must follow the surface, not be baked once.
  const onSlope = mkInst(20, 1, 0, R);
  snapToSurface(onSlope, "ground");
  check("the offset rides a sloped surface", Math.abs(onSlope.root.position.y - (TERRAIN(20) + R)) < 1e-6,
    `y = ${onSlope.root.position.y.toFixed(2)} at x=20`);
}

console.log("\n=== WHERE add() STARTS THE SEARCH FROM ===");
// THE GAP THAT LET THE REAL BUG THROUGH. Every case above hands snapToSurface an
// explicit starting y, so the maths was covered from the beginning and the one
// thing that was actually wrong — the height add() spawns a prop at — could not
// be seen at all.
//
// The search runs DOWNWARD from `y + 2`, so the spawn height decides which
// surfaces are even reachable. add() used to take x/z from the orbit target and
// leave y at restY (~0); with the game's default 40 m build height that put the
// ray 38 m below the deck, and every prop landed on the terrain under the track.
{
  /** add()'s spawn choice, transcribed from PropManager.add(). */
  const spawn = (target, restY) => ({
    root: { position: new THREE.Vector3(target.x, target.y, target.z) },
    restY,
  });
  // Camera parked on an elevated deck, which is what building a sky track looks
  // like. DECK_Y here is 20; the real default build height is 40.
  const target = { x: 0, y: DECK_Y, z: 0 };

  const onDeck = spawn(target, 0);
  snapToSurface(onDeck, "auto");
  check("a prop added while looking at an elevated deck lands ON it",
    onDeck.root.position.y === DECK_Y,
    `y = ${onDeck.root.position.y} (terrain is ${TERRAIN(0)})`);

  const road = spawn(target, 0);
  check("…and road mode finds it too, rather than refusing",
    snapToSurface(road, "road") && road.root.position.y === DECK_Y,
    `y = ${road.root.position.y}`);

  const cone = spawn(target, 0.42);
  snapToSurface(cone, "auto");
  check("the authored rest offset still survives the new spawn height",
    Math.abs(cone.root.position.y - (DECK_Y + 0.42)) < 1e-6,
    `y = ${cone.root.position.y}`);

  // Regression guard for the ORIGINAL bug, stated as the thing that must not
  // come back: spawning at restY makes the deck unreachable.
  const oldWay = { root: { position: new THREE.Vector3(target.x, 0, target.z) }, restY: 0 };
  snapToSurface(oldWay, "auto");
  check("spawning at restY instead would drop it to the terrain — the bug",
    Math.abs(oldWay.root.position.y - TERRAIN(0)) < 1e-6,
    `y = ${oldWay.root.position.y.toFixed(2)}, ${(DECK_Y - TERRAIN(0)).toFixed(0)} m under the deck`);

  // Ground mode must be UNAFFECTED — it is the parkour override and still has to
  // ignore the deck the camera is looking at.
  const under = spawn(target, 0);
  snapToSurface(under, "ground");
  check("ground mode still overrides to the terrain, as it must",
    Math.abs(under.root.position.y - TERRAIN(0)) < 1e-6,
    `y = ${under.root.position.y.toFixed(2)}`);
}

console.log("\n=== A PLACED PROP IS NEVER LEFT IN MID-AIR ===");
// The other half of spawning at the camera's height: the spawn point is EMPTY
// SPACE, so a snap that finds nothing leaves the prop floating there instead of
// near the ground. `road` is the mode that can fail — it refuses rather than
// dropping to terrain, which is right for a DRAG and wrong for a PLACEMENT.
{
  /** add()'s placement snap, including the fallback. */
  const place = (target, restY, mode) => {
    const inst = { root: { position: new THREE.Vector3(target.x, target.y, target.z) }, restY };
    if (!snapToSurface(inst, mode) && mode !== "free") snapToSurface(inst, "auto");
    return inst;
  };
  // Camera up at deck height but off to the side, where x=30 has no deck.
  const offRoad = { x: 30, y: DECK_Y, z: 0 };

  const p = place(offRoad, 0, "road");
  check("road mode with no road under the camera lands on the terrain, not the sky",
    Math.abs(p.root.position.y - TERRAIN(30)) < 1e-6,
    `y = ${p.root.position.y.toFixed(2)} (camera was at ${DECK_Y})`);

  const onRoad = place({ x: 0, y: DECK_Y, z: 0 }, 0, "road");
  check("…while road mode WITH road under it still lands on the road",
    onRoad.root.position.y === DECK_Y, `y = ${onRoad.root.position.y}`);

  // `free` is exempt on purpose: it means "do not move my prop", and spawning
  // at the camera is exactly what you want before placing it by hand.
  const f = place(offRoad, 0, "free");
  check("free mode is left alone — spawning at the camera IS the point",
    f.root.position.y === DECK_Y, `y = ${f.root.position.y}`);
}

console.log("\n=== WIRED UP IN THE REAL FILES ===");
{
  const propsSrc = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
  const gameSrc = readFileSync(join(ROOT, "games/modular-road-v3/roadGame.js"), "utf8");
  const htmlSrc = readFileSync(join(ROOT, "games/modular-road-v3/road.html"), "utf8");

  check("all four modes exist", /SURFACE_SNAP_MODES\s*=\s*\["auto",\s*"ground",\s*"road",\s*"free"\]/.test(propsSrc));
  check("auto is the default", /SURFACE_SNAP\s*=\s*\{\s*mode:\s*"auto"\s*\}/.test(propsSrc));
  // restY must be captured BEFORE the saved position overwrites it on import.
  // add() spawns at the camera target INCLUDING its height, so the downward
  // search can reach an elevated deck — and restY must therefore be read BEFORE
  // that overwrites y, or the "authored rest offset" becomes the camera height.
  check("add() spawns at the orbit target's height, not the prop's rest height",
    /root\.position\.copy\(this\.orbit\.target\)/.test(propsSrc),
    "or props land under an elevated track");
  check("restY is captured BEFORE the spawn position overwrites y",
    propsSrc.indexOf("const restY = root.position.y") <
      propsSrc.indexOf("root.position.copy(this.orbit.target)"));
  check("restY is captured on import BEFORE fromArray overwrites y",
    propsSrc.indexOf("const restY = root.position.y") < propsSrc.indexOf("root.position.fromArray(item.position)"));
  check("snapping runs on placement", /this\.snapToSurface\(inst\)/.test(propsSrc));
  // The behavioural block above transcribes add()'s fallback, so on its own it
  // would keep passing if the real one were deleted. THIS is what binds them.
  check("a placement that finds nothing falls back rather than floating",
    /!this\.snapToSurface\(inst\)[\s\S]{0,160}?this\.snapToSurface\(inst, "auto"\)/.test(propsSrc),
    "or road mode leaves a newly placed prop at the camera's height");
  check("…but `free` is exempt from that fallback",
    /!this\.snapToSurface\(inst\) && SURFACE_SNAP\.mode !== "free"/.test(propsSrc));
  // Live during a translate drag, but NOT during rotate/scale — re-snapping
  // there would fight a prop deliberately tilted onto banking — and NOT on
  // attach/hover `change`, which would lift a board ramp onto its own deck.
  check("snapping runs live while dragging, translate only",
    /mode === "translate" && this\.gizmo\.dragging\) this\.snapToSurface\(this\.selected\)/.test(propsSrc));
  check("snapToSurface hands the instance to the surface query so it can skip itself",
    /getSurfaceY\(p\.x, p\.y, p\.z, mode,\s*inst\)/.test(propsSrc));
  check("a saved track is NOT re-snapped on import (positions are already right)",
    !/importInstances[\s\S]{0,900}?snapToSurface/.test(propsSrc));

  check("the game supplies the surface query", /getSurfaceY:\s*\(x, y, z, mode/.test(gameSrc));
  check("it searches DOWNWARD from the prop's own height",
    /_snapOrigin\.set\(x, y \+ 2, z\)/.test(gameSrc), "or auto finds decks far above a parkour prop");
  check("a snap ray that hits the prop's own deck continues through it",
    /hitIsOwnDeck/.test(gameSrc));
  check("road mode returns null rather than falling back",
    /if \(mode === "road"\) return null;/.test(gameSrc));
  check("the control is in the PALETTE, beside what you are placing",
    /id="road-snap"/.test(htmlSrc) && /onClick\("road-snap"/.test(gameSrc));
  check("switching mode re-snaps only the SELECTED prop, not everything",
    /if \(props\.selected\) \{ props\.snapToSurface\(props\.selected\)/.test(gameSrc));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
