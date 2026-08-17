// BUILD "APEX PARKOUR" — a point-to-point stunt run, generated head­lessly with
// the real builder and the real ballistic solver, then written out as a track
// file the editor can Load.
//
// Point-to-point on purpose: Apex Rush tracks run start → finish, so nothing
// here tries to close a circuit.
//
// WHY GENERATE IT RATHER THAN CLICK IT. Two jumps and a split/rejoin have to be
// geometrically exact, and the exact numbers come from the same code the editor
// uses — solveGapArc for where the car lands, builder.linkTo for the rejoin. A
// track laid out by eye would be a demo of my patience, not of the tools.
//
// It doubles as an end-to-end test: every section below exercises a different
// part of the builder, and the checks at the bottom fail loudly if any of them
// stopped working.
import * as THREE from "three";
import { writeFileSync, readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
const { ModularRoadBuilder, CATEGORY_PRESETS } = await import(
  pathToFileURL(join(GAME, "modularRoadBuilder.js")).href);
const { solveGapArc } = await import(pathToFileURL(join(GAME, "gapArc.js")).href);

// The car, so the jumps are sized for the thing that will drive them.
const TOP_SPEED = 50;      // TIRE.topSpeed
const DRAG_K = 0.45 / 1400; // AERO.drag / CHASSIS.mass
/** Speed a jump is SIZED for. Deliberately under top speed: a landing you
 *  overshoot is a track you cannot finish, and the platforms below are long
 *  enough to catch the faster case too. */
const REF_SPEED = 34;
/** Height the run starts at. The editor's own build height is 40 m above the
 *  terrain; this leaves headroom for the big drop near the end. */
const START_HEIGHT = 90;
/** How far below its lip the second jump lands — the track's one big drop. */
const FINALE_DROP = 46;

const b = new ModularRoadBuilder({
  scene: new THREE.Scene(),
  material: new THREE.MeshBasicMaterial(),
  railMaterial: new THREE.MeshBasicMaterial(),
  shellMaterial: new THREE.MeshBasicMaterial(),
  decorMaterial: new THREE.MeshBasicMaterial(),
});

const tile = (id) => {
  for (const list of Object.values(CATEGORY_PRESETS)) {
    const t = list.find((x) => x.id === id);
    if (t) return t.preset ?? t;
  }
  throw new Error(`no tile ${id}`);
};
/** Place `n` of a palette tile. */
const put = (id, n = 1) => { b.setActivePreset(tile(id)); for (let i = 0; i < n; i++) b.place(); };
/** Place `n` of a BASE piece at kit defaults. */
const putBase = (id, n = 1) => { b.setActivePiece(id); for (let i = 0; i < n; i++) b.place(); };
/** Place a base piece with explicit params (for the pieces with no tile). */
const putP = (base, params, n = 1) => {
  b.setActivePreset({ base, params });
  for (let i = 0; i < n; i++) b.place();
};
const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);
const say = (s) => console.log(`  ${s}`);

/**
 * Fly the current open end and start a new chain where the car lands.
 * Exactly what the editor's "Snap landing → new chain" does.
 */
function landAfterJump(speed = REF_SPEED, landingDrop = 0) {
  const from = b.currentConnector.clone();
  const near = solveGapArc(from, speed, { gravity: 9.81, dragK: DRAG_K, landingDrop });
  if (!near) throw new Error("the jump never comes down — check the ramp angle");
  // The FAST case too, so the platform can be sized to catch both.
  const far = solveGapArc(from, Math.min(TOP_SPEED, speed + 12),
    { gravity: 9.81, dragK: DRAG_K, landingDrop });
  const v = near.vel;
  const yaw = Math.atan2(-v.x, -v.z);
  b.beginNewChain(near.pos.clone(), yaw, { exact: true });
  const spread = far ? near.pos.distanceTo(far.pos) : 0;
  say(`jump: ${near.dist.toFixed(0)} m at ${speed} m/s, ${spread.toFixed(0)} m more at ` +
    `${Math.min(TOP_SPEED, speed + 12)} — landing at ` +
    `(${near.pos.x.toFixed(0)}, ${near.pos.y.toFixed(0)}, ${near.pos.z.toFixed(0)})`);
  return { near, far, spread };
}

console.log("\nBUILDING APEX PARKOUR\n");

// ── 1. LAUNCH ────────────────────────────────────────────────────────────────
// Start line, then enough road to actually reach jump speed.
console.log("1. launch");
b.setSnap({ enabled: true, step: 8, yawDeg: 15 });
// SEED IT IN THE SKY. Headless there is no terrain, so a chain built from the
// default anchor sits at y = 0 — and the editor builds at ~40 m above ground,
// so a track authored at zero loads half-buried. Starting high also leaves room
// for the second jump to drop properly instead of into the dirt.
b.beginNewChain(new THREE.Vector3(0, START_HEIGHT, 0), 0, { exact: true });
putBase("start");
put("straight_long", 3);
put("turn_smooth_small");          // gentle bend so it does not read as a runway
put("straight_long", 2);

// ── 2. BANKED SWEEPER ────────────────────────────────────────────────────────
// The banked kit: roll in, hold the turn, roll out. `bank_up_*` and
// `bank_down_*` are the transitions — skipping them puts a kink in the deck.
console.log("2. banked sweeper");
put("bank_up_right");
put("bank_short_turn", 2);
put("bank_down_right");
put("straight_long");

// ── 3. CHICANE ───────────────────────────────────────────────────────────────
console.log("3. chicane");
put("turn_s_left");
put("turn_s_right");
put("straight_long");

// ── 4. CLIMB TO THE FIRST LAUNCH ─────────────────────────────────────────────
console.log("4. climb");
put("slope_up_medium", 2);
// NO BROW HERE. "Brow / hill top" is a CREST — it leaves the chain pitched 24°
// NOSE DOWN, because that is what going over a hill does. Used as an "ease back
// to flat" it turned the next ramp's 30° launch into 6°, and the jump flew 24 m
// instead of 99. Slopes already exit LEVEL (kit sockets are level by
// convention), so the climb needs nothing after it.
put("straight_long", 2);

// ── 5. BIG JUMP → PLATFORM ───────────────────────────────────────────────────
// The landing is SOLVED, not guessed, and the platform is sized from the spread
// between the reference speed and 12 m/s faster.
console.log("5. jump 1");
put("ramp_40");
const j1 = landAfterJump(REF_SPEED, 0);
const plat1 = Math.max(44, j1.spread + 30);
putP("platform", { platformLength: plat1, platformWidth: 34 });
// NO LANDING RAMP ON A LEVEL PLATFORM. "Landing ramp" is the mirror of a dive:
// it eases a DOWN-pitched run back to flat, so entered level it pitches the
// chain UP by its own angle — 30° for land_40. Every straight after it then
// climbed 16 m, and the back half of the track wandered 163 m into the sky. The
// platform IS the landing; the car arrives descending and meets flat deck.
put("straight_long", 2);

// ── 6. SPLIT, ALTERNATE ROUTE, MERGE ─────────────────────────────────────────
// The showcase for the junction work: the main line takes one arm, a side route
// leaves the other, and a generated Link closes it back into a merge.
console.log("6. split / rejoin");
putBase("junction_split");
const splitBranch = b.branchConnectors().find((x) => !x.used);
// SIX straights, not two. The alternate route has to leave at the branch's 24°,
// get clear, and come back into a socket further down — with only ~64 m between
// them every shape tried joined at a 2 m radius. Give it room and the same
// shapes join at 30+.
put("straight_long", 6);
putBase("junction_merge");
const mergeBranch = b.branchConnectors().find((x) => !x.used && x.piece.id === "junction_merge");
put("straight_long");
const mainAfterMerge = b.activeChainId;

// The side route: off the split, out, and back in via a generated Link.
//
// THE SHAPE IS SEARCHED, NOT GUESSED, and that is not laziness — running the
// route FURTHER can make the join worse, not better. A branch leaves at 24°, so
// a long straight run overshoots sideways and the target ends up behind the
// route's own tail; the only curve that then fits both poses is a hairpin, and
// linkTo correctly refuses it. Measured on this very track: two straights gave a
// 2 m radius. So try a few plausible shapes and keep the first one that joins at
// a radius a car can actually take.
const SIDE_SHAPES = [
  ["1 straight, turn back", ["straight_long"], true],
  ["1 straight", ["straight_long"], false],
  ["2 straights, turn back", ["straight_long", "straight_long"], true],
  ["straight + turn + straight", ["straight_long"], true, ["straight_long"]],
];
// Try them ALL and keep the widest join, rather than the first that passes: the
// difference between shapes is 15 m of radius against 60, and on a stunt track
// that is the difference between a corner and a wall. The floor is 12 m, which
// is exactly the kit's own sharpest authored turn (turn_sharp_small) — a link
// tighter than any piece you can place by hand is not one to ship.
const MIN_LINK_RADIUS = 12;
let best = null;
for (const [name, before, turnBack, after = []] of SIDE_SHAPES) {
  const mark = b._undoStack.length;
  b._putGhostOnBranch(splitBranch.matrix);
  for (const id of before) put(id);
  if (turnBack) { b.setActivePreset(tile("turn_smooth_small")); b.flip(); b.place(); }
  for (const id of after) put(id);
  const chain = b.activeChainId;
  const target = b.linkTargets().find((t) => t.branch && t.branch.piece.id === "junction_merge");
  const r = target ? b.linkTo(target) : { ok: false, reason: "no merge socket offered" };
  say(`  side route "${name}": ${r.ok ? `gap ${r.gap.toFixed(0)} m, radius ${r.radius.toFixed(0)} m` : r.reason}`);
  if (r.ok && (!best || r.radius > best.link.radius)) best = { name, chain, link: r, mark };
  // Rewind whatever this attempt built; the winner is rebuilt below.
  if (r.ok) b.undo();
  while (b._undoStack.length > mark) b.undo();
}
if (!best || best.link.radius < MIN_LINK_RADIUS) {
  throw new Error(`no side-route shape joined at ${MIN_LINK_RADIUS} m or better` +
    (best ? ` (best was ${best.link.radius.toFixed(0)} m)` : ""));
}
// Rebuild the winner.
const [, wBefore, wTurn, wAfter = []] = SIDE_SHAPES.find((x) => x[0] === best.name);
b._putGhostOnBranch(splitBranch.matrix);
for (const id of wBefore) put(id);
if (wTurn) { b.setActivePreset(tile("turn_smooth_small")); b.flip(); b.place(); }
for (const id of wAfter) put(id);
const sideChain = b.activeChainId;
const link = b.linkTo(
  b.linkTargets().find((t) => t.branch && t.branch.piece.id === "junction_merge"));
if (!link.ok) throw new Error(`rebuilding the winning route failed: ${link.reason}`);
const sideShape = best.name;
say(`rejoin (${sideShape}): closed a ${link.gap.toFixed(0)} m gap, ` +
  `tightest radius ${link.radius.toFixed(0)} m`);

// Back to the main line to carry on.
b.selectChain(mainAfterMerge);
b._syncGizmoToOpenEnd();

// ── 7. TUBE RUN ──────────────────────────────────────────────────────────────
console.log("7. tube");
put("half_tube_str");
put("half_tube_turn");
put("half_tube_str");
put("straight_long");

// ── 8. BANKED HAIRPIN ────────────────────────────────────────────────────────
console.log("8. hairpin");
put("bank_up_left");
put("bank_long_turn", 2);
put("bank_down_left");
put("straight_long", 2);

// ── 9. SECOND JUMP, THIS ONE DROPS ───────────────────────────────────────────
console.log("9. jump 2 (drop)");
put("ramp_20");
const j2 = landAfterJump(REF_SPEED, FINALE_DROP);
const plat2 = Math.max(50, j2.spread + 34);
putP("platform", { platformLength: plat2, platformWidth: 36 });
put("straight_long", 2);

// ── 10. TUNNEL AND FINISH ────────────────────────────────────────────────────
console.log("10. run-out");
put("straight_tunnel");
put("turn_smooth_small");
put("slope_down_gentle", 2);   // keep descending into the finish
put("straight_long", 2);
putBase("finish");

// ── CHECKS ───────────────────────────────────────────────────────────────────
console.log("\nCHECKS\n");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

check(`the track has real length (${b.pieces.length} pieces)`, b.pieces.length >= 45);
check(`it uses many different pieces (${new Set(b.pieces.map((p) => p.id)).size} kinds)`,
  new Set(b.pieces.map((p) => p.id)).size >= 12);
check(`it is point-to-point across ${b.chains.length} chains`, b.chains.length >= 3);

// Seams: every consecutive pair inside a chain must touch, EXCEPT where a piece
// is deliberately detached (the jump landings are their own chains, so they do
// not even appear here).
let worstSeam = 0, worstAt = "";
for (const c of b.chains) {
  const ps = b.pieces.filter((p) => p.chainId === c.id);
  for (let i = 1; i < ps.length; i++) {
    if (ps[i].detached) continue;
    const d = pos(ps[i - 1].connectorOut).distanceTo(pos(ps[i].connectorIn));
    if (d > worstSeam) { worstSeam = d; worstAt = `chain ${c.id} piece ${i} (${ps[i].id})`; }
  }
}
check("every seam inside every chain is tight", worstSeam < 1e-6,
  `worst ${worstSeam.toExponential(2)} m at ${worstAt}`);

// The rejoin really landed on the merge socket.
const sideEnd = pos(b.pieces.filter((p) => p.chainId === sideChain).at(-1).connectorOut);
check("the alternate route ends exactly on the merge",
  sideEnd.distanceTo(mergeBranch.pos) < 1e-6,
  `off by ${sideEnd.distanceTo(mergeBranch.pos).toExponential(2)} m`);
check("...so no junction arrow is left dangling", b.openBranchCount === 0,
  `${b.openBranchCount} still open`);

// A start and a finish, which is what makes it a course rather than a shape.
check("it has a start line", b.pieces.some((p) => p.id === "start"));
check("it has a finish line", b.pieces.some((p) => p.id === "finish"));

// The jumps: the landing chain must begin where the solver said, and the
// platform must be long enough for the fast case as well.
// A jump is safe when the PLATFORM covers the speed band, not when the band is
// narrow — a fast lap should overshoot onto more deck, not into the void.
for (const [n, j, plat] of [["1", j1, plat1], ["2", j2, plat2]]) {
  check(`jump ${n}: the platform catches ${REF_SPEED}–${Math.min(TOP_SPEED, REF_SPEED + 12)} m/s`,
    plat >= j.spread + 20,
    `${plat.toFixed(0)} m of platform for ${j.spread.toFixed(0)} m of spread`);
}

// Height range — a stunt track that never leaves the ground is not one.
const ys = b.pieces.flatMap((p) => [pos(p.connectorIn).y, pos(p.connectorOut).y]);
const drop = Math.max(...ys) - Math.min(...ys);
check(`it uses height (${drop.toFixed(0)} m from lowest to highest)`, drop > 25);
// ...and does not RUN AWAY with it. A piece that leaves the chain pitched turns
// every straight after it into a climb: land_40 on a level platform pitched the
// run up 30°, and 16 m per straight took the back half 163 m into the sky before
// anyone noticed. A flat piece must stay flat.
const climbers = b.pieces.filter((p) =>
  (p.id === "straight" || p.id === "platform")
  && Math.abs(pos(p.connectorOut).y - pos(p.connectorIn).y) > 0.5);
check("no straight or platform is secretly climbing", climbers.length === 0,
  `${climbers.length} of them are — something upstream left the chain pitched`);
check(`the height range is deliberate (${drop.toFixed(0)} m)`, drop < 140,
  "more than this and a piece is leaking pitch into everything after it");
check(`nothing sinks underground (lowest point ${Math.min(...ys).toFixed(0)} m)`,
  Math.min(...ys) > 15,
  "the editor floats its tracks ~40 m up; a track authored at zero loads buried");

// ── WRITE IT OUT ─────────────────────────────────────────────────────────────
// Same envelope as the shipped tracks, so "Load track" takes it unchanged. The
// non-piece settings are copied from rushline rather than invented: they are the
// look and the road width this kit was tuned at.
const base = JSON.parse(readFileSync(join(GAME, "rushline.json"), "utf8"));
const out = {
  ...base,
  savedAt: new Date().toISOString(),
  pieces: b.exportTrackPieces(),
  props: [],
  movers: [],
  portals: [],
  spawn: null,
};
const dest = join(GAME, "apex-parkour.json");
writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`\nwrote ${dest.replace(ROOT + "\\", "")} — ${out.pieces.length} pieces\n`);

console.log(fail ? `${fail} FAILURE(S)\n` : "all green\n");
process.exit(fail ? 1 : 0);
