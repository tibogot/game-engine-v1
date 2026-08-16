// OPEN-END MARKERS, and the PIECE SIZE READOUT.
//
// Two halves of "you can see what the editor is about to do".
//
// 1. MARKERS. Junction branches always had a floating arrow; chain ends never
//    did, so the only way to learn where you could build was to wave the cursor
//    around and watch the ghost twitch. That got worse once pointing at an end
//    started moving the piece (aimAtCursor) — the piece jumped whenever the
//    pointer strayed near something invisible, which reads as a glitch.
//    Now every open end draws an arrow, coloured by kind, with the one you are
//    aimed at picked out in white.
//
// 2. SIZE. The palette tiles are PRESETS over one shared `pieceParams`: "Short"
//    and "Long" are the same `straight` piece with `straightLength` 14 or 32,
//    Object.assign'd into that shared object and never put back. The editor
//    boots at 22, no tile offers 22, and a Banked preset also writes
//    `straightLength: 32` — so clicking an unrelated tile silently resizes your
//    next straight. This is the cheap half of the fix: show the number.
import * as THREE from "three";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOD = pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href;
const { ModularRoadBuilder, CATEGORY_PRESETS } = await import(MOD);
// `pieceParams` is ONE module-level object shared by every builder in the
// process — which is the very thing section 4 is about, and it makes these tests
// order-dependent unless each block starts from the shipped defaults.
const { pieceParams } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const DEFAULT_PARAMS = { ...pieceParams };
const resetParams = () => Object.assign(pieceParams, DEFAULT_PARAMS);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${!c && d ? "\n        " + d : ""}`);
  if (!c) fail++;
};

function fresh() {
  return new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
}
const markers = (b) => b.branchMarkers.children.filter((m) => m.visible !== false);
const kindOf = (b, m) => {
  for (const [k, mat] of Object.entries(b.endMarkerMats)) if (m.material === mat) return k;
  return "?";
};
const tally = (b) => {
  const t = { branch: 0, tail: 0, head: 0, aimed: 0 };
  for (const m of markers(b)) t[kindOf(b, m)]++;
  return t;
};
/** Where a marker's arrow points (its socket -Z), in world space. */
const arrowDir = (m) => new THREE.Vector3(0, 0, -1)
  .applyMatrix4(new THREE.Matrix4().extractRotation(m.matrix)).normalize();

console.log("\n=== 1. EVERY OPEN END GETS AN ARROW ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  check("an empty track draws nothing but its one anchor",
    b._openConnectors().length === 1, `${b._openConnectors().length}`);
  for (let i = 0; i < 4; i++) b.place();
  const t = tally(b);
  check("a plain chain shows a tail AND a head", t.tail + t.aimed >= 1 && t.head >= 1,
    JSON.stringify(t));
  check("...and that is exactly one marker per open end",
    markers(b).length === b._openConnectors().length,
    `${markers(b).length} markers for ${b._openConnectors().length} ends`);
}
{
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_cross"); b.place();
  const t = tally(b);
  check("a crossroads adds two branch arrows", t.branch === 2, JSON.stringify(t));
  check("markers still match the open-end count",
    markers(b).length === b._openConnectors().length,
    `${markers(b).length} vs ${b._openConnectors().length}`);
  // Building on a branch consumes it — its arrow must go.
  b.snapGhostToNearestBranch();
  b.setActivePiece("straight"); b.place();
  check("building on a branch removes that arrow", tally(b).branch === 1,
    JSON.stringify(tally(b)));
}

console.log("\n=== 2. EXACTLY ONE ARROW IS 'AIMED', AND IT FOLLOWS THE GHOST ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  for (let i = 0; i < 4; i++) b.place();
  check("aiming at the tail lights exactly one arrow", tally(b).aimed === 1,
    JSON.stringify(tally(b)));

  b.toggleBuildEnd();                     // -> head
  check("still exactly one after switching ends", tally(b).aimed === 1,
    JSON.stringify(tally(b)));
  const lit = markers(b).find((m) => kindOf(b, m) === "aimed");
  const headPos = new THREE.Vector3().setFromMatrixPosition(b._chainHead(b.activeChainId));
  check("...and it is the one on the HEAD",
    new THREE.Vector3().setFromMatrixPosition(lit.matrix).distanceTo(headPos) < 1e-6);

  // Free-placed: the ghost is on no end at all, so nothing should be lit.
  b._gizmoTarget = "ghost"; b.ghostDetached = true; b._ghostPos.set(400, 0, 400);
  b._refreshBranchMarkers();
  check("free-placing lights nothing", tally(b).aimed === 0, JSON.stringify(tally(b)));
}
{
  const b = fresh();
  b.setActivePiece("straight"); b.place();
  b.setActivePiece("junction_t"); b.place();
  b.snapGhostToNearestBranch();
  check("parking on a branch lights that branch", tally(b).aimed === 1,
    JSON.stringify(tally(b)));
}

console.log("\n=== 3. A HEAD ARROW POINTS THE WAY A PIECE WOULD GROW ===");
{
  // A head faces INTO its chain. Drawn unturned, the arrow would point back down
  // the road you already built — the exact opposite of what prepending does.
  const b = fresh();
  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  const headM = markers(b).find((m) => kindOf(b, m) === "head");
  check("the head has its own coloured arrow", !!headM);
  const tailM = markers(b).find((m) => kindOf(b, m) === "tail" || kindOf(b, m) === "aimed");
  const hd = arrowDir(headM), td = arrowDir(tailM);
  check("it points OPPOSITE the tail arrow", hd.dot(td) < -0.99,
    `head ${hd.toArray().map(n=>n.toFixed(2))} vs tail ${td.toArray().map(n=>n.toFixed(2))} ` +
    `(dot ${hd.dot(td).toFixed(3)}) — the two ends of a straight run must point apart`);
  // And it agrees with where a prepended piece actually lands.
  b.toggleBuildEnd();
  const entry = new THREE.Vector3().setFromMatrixPosition(b._placementConnector());
  const head = new THREE.Vector3().setFromMatrixPosition(b._chainHead(b.activeChainId));
  check("...and matches the direction the prepended piece really goes",
    entry.clone().sub(head).normalize().dot(hd) > 0.99,
    `arrow ${hd.toArray().map(n=>n.toFixed(2))}, piece goes ` +
    `${entry.clone().sub(head).normalize().toArray().map(n=>n.toFixed(2))}`);
}

console.log("\n=== 4. THE SIZE READOUT ===");
{
  resetParams();
  const b = fresh();
  b.setActivePiece("straight");
  check("the piece the editor BOOTS on measures 22 m",
    Math.abs(b.activePieceMetrics.span - 22) < 0.01,
    `${b.activePieceMetrics.span.toFixed(2)} m`);

  const straights = CATEGORY_PRESETS.straight ?? [];
  const pick = (id) => { const p = straights.find((q) => q.id === id); return p?.preset ?? p; };
  check("setup: the Short and Long tiles exist", !!pick("straight_short") && !!pick("straight_long"));

  b.setActivePreset(pick("straight_long"));
  check("clicking Long changes the readout", Math.abs(b.activePieceMetrics.span - 32) < 0.01,
    `${b.activePieceMetrics.span.toFixed(2)} m, wanted 32`);
  b.setActivePreset(pick("straight_short"));
  check("clicking Short changes it again", Math.abs(b.activePieceMetrics.span - 14) < 0.01,
    `${b.activePieceMetrics.span.toFixed(2)} m, wanted 14`);

  // THE POINT. No tile whose base is `straight` offers the 22 m the editor
  // starts on — Short is 14, Long is 32 — so once you touch either, the length
  // your first pieces were built at is not on the menu any more.
  const straightTiles = straights.filter((p) => (p.preset ?? p).base === "straight");
  check("no Straight tile restores the 22 m the editor boots on",
    !straightTiles.some((p) => (p.preset ?? p).params?.straightLength === 22),
    `one does: ${straightTiles.map((p) => p.id + "=" + (p.preset ?? p).params?.straightLength).join(", ")}`);
  console.log(`        (Straight tiles offer: ${straightTiles
    .map((p) => `${p.label} ${(p.preset ?? p).params?.straightLength}m`).join(", ")} — default is 22)`);
}
{
  // AN UNRELATED TILE MOVES IT, which is the surprising part. Sixteen presets
  // across three categories write `straightLength`, and most of them are not
  // straights at all — a Banked tile, a Tube, a half-pipe (which sets 110 m).
  resetParams();
  const writers = [];
  for (const [cat, list] of Object.entries(CATEGORY_PRESETS)) {
    for (const p of list) {
      const pr = p.preset ?? p;
      if (pr.params && "straightLength" in pr.params && pr.base !== "straight") {
        writers.push({ cat, label: p.label ?? p.id, preset: pr, len: pr.params.straightLength });
      }
    }
  }
  console.log(`        (${writers.length} NON-straight tiles rewrite straightLength: ` +
    `${writers.slice(0, 4).map((w) => `${w.label} ${w.len}m`).join(", ")}, …)`);
  check("setup: at least one non-straight tile writes straightLength", writers.length > 0);

  const b = fresh();
  b.setActivePiece("straight");
  const before = b.activePieceMetrics.span;
  const w = writers.find((x) => x.len !== 22) ?? writers[0];
  b.setActivePreset(w.preset);
  b.setActivePiece("straight");             // back to a plain straight
  const after = b.activePieceMetrics.span;
  check(`clicking "${w.label}" (${w.cat}) silently resizes your next straight`,
    Math.abs(after - before) > 0.5,
    `${before.toFixed(1)} -> ${after.toFixed(1)} m. If these ever match, the shared ` +
    `pieceParams problem has been fixed and this check can go.`);
  console.log(`        (straight was ${before.toFixed(0)} m, is ${after.toFixed(0)} m ` +
    `after clicking "${w.label}" — the readout is what makes that visible)`);
}
{
  resetParams();
  const b = fresh();
  b.setActivePiece("slope");
  const m = b.activePieceMetrics;
  check("a slope reports a height change as well as a span", Math.abs(m.rise) >= 0.5,
    `span ${m.span.toFixed(1)} m, rise ${m.rise.toFixed(1)} m`);
  b.setActivePiece("straight");
  check("a flat piece reports no meaningful rise",
    Math.abs(b.activePieceMetrics.rise) < 0.5, `${b.activePieceMetrics.rise.toFixed(2)}`);
}

console.log("\n=== 5. MARKERS ARE NOT AN EDIT ===");
{
  const b = fresh();
  b.setActivePiece("straight");
  for (let i = 0; i < 3; i++) b.place();
  const undo0 = b._undoStack.length;
  for (let i = 0; i < 20; i++) { b.toggleBuildEnd(); b._refreshBranchMarkers(); }
  check("toggling ends and redrawing markers adds no undo steps",
    b._undoStack.length === undo0, `${b._undoStack.length - undo0} added`);
  check("...and does not leak marker meshes",
    markers(b).length === b._openConnectors().length,
    `${markers(b).length} markers for ${b._openConnectors().length} ends`);
}

console.log(fail ? `\n${fail} FAILURE(S)\n` : "\nall green\n");
process.exit(fail ? 1 : 0);
