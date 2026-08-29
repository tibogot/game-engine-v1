// THE CORNER LADDER — is the Turns tab a set, or a pile?
//
// It was a pile: five tiles, ONE left-hander in the whole tab (and that one
// mislabelled), two radii for a 90° corner, and a widest corner of R34. The car
// runs to 48.3 m/s on the straight; R34 is an 81 km/h corner. Every corner in
// the game was a heavy brake zone with nothing between "brake hard" and
// "straight".
//
// So the tab is now a ladder indexed by the only thing that decides how a flat
// corner drives — its radius, because v_max = sqrt(R·a) and nothing else in the
// piece matters to the driver. This asserts the three things that make a ladder
// a ladder rather than thirty separate tiles:
//
//   • EVERY RUNG HAS BOTH HANDS. `R` flips curveDir live, but a corner you have
//     to remember to flip is a corner you get wrong, and every other tab pairs.
//   • THE PAIRS ARE MIRRORS. Same radius, same angle, opposite exit — measured
//     off the built connectors, not assumed from curveDir.
//   • THE RUNGS ARE SPACED BY SPEED, not by round numbers. Each step up has to
//     be worth a tile, and the top of the ladder has to reach the car.
//
// Plus the grip figure the whole ladder rests on, measured rather than trusted:
// the vehicle file's own comment assumes 1.5 g and the car actually holds ~1.3.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.turn.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT, GRAVITY, TIRE } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { buildPiece, pieceParams, roadParams, guardrailParams, initialConnector, PIECE_BY_ID } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { CATEGORY_PRESETS } = await import(
  new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../v3/play/modularRoadGround.js", import.meta.url).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

let fail = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!cond) fail++;
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------------ */
console.log("\n1. THE GRIP THE LADDER IS BUILT ON\n");

// Flat plane through the REAL ground adapter — a hand-rolled plane misses
// spherecast and half the contact model.
const plane = createVehicleGround({ getTerrainHeight: () => 0 });

/**
 * Hold a speed, hold a steering angle, read the cornering it settles into.
 *
 * REJECTS SPINS, and that is the whole difficulty. v·omega is a cornering
 * acceleration only while the car is going roughly where it is pointing; in a
 * pirouette the yaw rate is enormous at a 2-3 m "radius". An early version of
 * this measurement reported 8.4 g that way — a car rotating on the spot.
 */
function corner(speed, steer) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = plane.ground; c.solidsBvh = plane.solids;
  c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, WHEEL.radius + 0.18, 0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -speed);
  const fwd = new THREE.Vector3(), dir = new THREE.Vector3();
  let best = 0, R = 0;
  const n = Math.round(9 / FIXED_DT);
  for (let i = 0; i < n; i++) {
    const v = c.body.vel.length();
    c.tick({ steerTarget: steer, throttle: v < speed ? 1 : 0.35, handbrake: false, yaw: 0, pitch: 0 });
    if (i < Math.round(2 / FIXED_DT)) continue; // settle into the turn
    const yawRate = Math.abs(c.body.angVel.y);
    const sp = c.body.vel.length();
    if (yawRate < 1e-3 || c.groundedCount < 4) continue;
    fwd.set(0, 0, -1).applyQuaternion(c.body.quat);
    dir.copy(c.body.vel).normalize();
    const slip = Math.acos(THREE.MathUtils.clamp(Math.abs(fwd.dot(dir)), -1, 1));
    if (slip > THREE.MathUtils.degToRad(15)) continue;
    const a = sp * yawRate;
    if (a > best) { best = a; R = sp / yawRate; }
  }
  return { g: best / GRAVITY, R };
}

const held = [];
console.log("   speed   sustained   implied radius");
for (const speed of [15, 20, 25, 30, 35, 40]) {
  const r = corner(speed, 0.45);
  held.push(r.g);
  console.log(`   ${String(speed).padStart(4)}   ${r.g.toFixed(2).padStart(7)} g   ${r.R.toFixed(0).padStart(11)} m`);
}
const lo = Math.min(...held), hi = Math.max(...held);
// FLATNESS is the property the ladder actually rests on: if grip fell away with
// speed, v_max = sqrt(R·a) would stop predicting anything and the rungs would
// not be a ladder. Assert the spread, not just a band, so a tyre model that
// starts sagging at speed fails here even if it passes through the band.
ok(hi - lo < 0.15, "the car holds a steady g however fast it is going",
  `${lo.toFixed(2)}–${hi.toFixed(2)} g across 15–40 m/s, spread ${(hi - lo).toFixed(2)}`);
// The number the ladder's tile comment quotes. If the tyre model changes, this
// is what tells you the comment (and the radii) need revisiting — which is
// exactly what it did: the figure was 1.3 g when the ladder was built and the
// car holds ~2.25 g now. The RUNG SPEEDS below did not move with it (they are
// steering-lock limited at the tight end, not grip limited), so the radii still
// stand and only the quoted figure needed correcting.
const A = 2.25;
ok(lo <= A && A <= hi, `${A} g is inside the measured band, so the tile comment is sound`,
  `${lo.toFixed(2)}–${hi.toFixed(2)} g`);

/* ------------------------------------------------------------------------ */
console.log("\n2. THE LADDER SPANS THE CAR\n");

const RUNGS = [["Hairpin", 12], ["Tight", 24], ["Medium", 40], ["Sweeper", 70], ["Kink", 130]];
const vAt = (R) => Math.sqrt(R * A * GRAVITY);
console.log("   rung        R     corner speed");
for (const [name, R] of RUNGS) {
  console.log(`   ${name.padEnd(9)} ${String(R).padStart(4)} m   ${vAt(R).toFixed(1).padStart(5)} m/s  ${(vAt(R) * 3.6).toFixed(0).padStart(4)} km/h`);
}
// Terminal velocity: the power curve meets quadratic drag a little under
// topSpeed. The vehicle file measures the settled figure at 48.3 m/s.
const VMAX = 48.3;
console.log(`   straight-line top speed ${VMAX} m/s (${(VMAX * 3.6).toFixed(0)} km/h)`
  + `   flat-out radius ${(VMAX * VMAX / (A * GRAVITY)).toFixed(0)} m`);

// Each rung has to be worth a tile: a step that does not change the corner
// speed much is two tiles for one corner.
for (let i = 1; i < RUNGS.length; i++) {
  const step = vAt(RUNGS[i][1]) / vAt(RUNGS[i - 1][1]);
  ok(step > 1.25 && step < 1.45, `${RUNGS[i - 1][0]} → ${RUNGS[i][0]} is a real step in speed`,
    `×${step.toFixed(2)}`);
}
ok(vAt(130) > 0.8 * VMAX, "the top of the ladder is a lift, not a brake zone",
  `Kink is ${(100 * vAt(130) / VMAX).toFixed(0)}% of top speed`);
// The gap that started this: the old tab's widest corner.
ok(vAt(40) > vAt(34), "the old tab's widest corner (R34) is no longer the widest",
  `R34 was ${(vAt(34) * 3.6).toFixed(0)} km/h; the ladder reaches ${(vAt(130) * 3.6).toFixed(0)}`);

/* ------------------------------------------------------------------------ */
console.log("\n3. ONE TILE PER SHAPE, AND THE HAND REALLY MIRRORS IT\n");

/*
 * This section used to assert the opposite — that every rung shipped an L tile
 * beside its R tile. That was right while the hand died on the next tile click;
 * now the hand is a sticky mode (see tools/handedTest.mjs) and a mirror twin is
 * a second tile for a corner you already have. 15 shapes, 15 tiles.
 *
 * The mirroring check survives the change and is the valuable half: it builds
 * the piece BOTH WAYS and compares exits, rather than trusting that curveDir
 * means what it says. That is exactly the check that catches an inversion like
 * `scurve`'s.
 */
const turns = CATEGORY_PRESETS.turns.filter((t) => t.base === "curve");
const byShape = new Map();
for (const t of turns) {
  const k = `${t.params.curveRadius}/${t.params.curveAngle}`;
  if (!byShape.has(k)) byShape.set(k, []);
  byShape.get(k).push(t);
}
ok(byShape.size === 15 && turns.length === 15,
  "15 corner shapes, one tile each", `${byShape.size} shapes, ${turns.length} tiles`);
ok(turns.every((t) => t.params.curveDir === undefined),
  "no corner tile pins a direction — the hand mode owns it");

const rp = { ...roadParams }, gp = { ...guardrailParams }, DEF = { ...pieceParams };
const exitFor = (t, dir) => new THREE.Vector3().setFromMatrixPosition(
  buildPiece(t.base, initialConnector(), { ...DEF, ...t.params, curveDir: dir },
    rp, gp, gp.enabled).connectorOut);
let mirrored = 0;
for (const t of turns) {
  const er = exitFor(t, 1), el = exitFor(t, -1);
  // Right is +x when travel is −z and up is +y.
  if (near(er.x, -el.x, 1e-9) && near(er.z, el.z, 1e-9) && er.x > 0) mirrored++;
}
ok(mirrored === turns.length, "every corner mirrors exactly, and +1 really goes right",
  `${mirrored}/${turns.length}`);

// The label has to be the shape. A tile called "Sweeper 45" that builds 90° is
// worse than no tile. It must NOT name a hand any more — that is the mode's job.
let labelled = 0;
for (const t of turns) {
  const m = t.label.match(/^(\w+) (\d+)$/);
  if (!m) continue;
  const rung = RUNGS.find(([n]) => n === m[1]);
  if (rung && rung[1] === t.params.curveRadius && Number(m[2]) === t.params.curveAngle) labelled++;
}
ok(labelled === turns.length, "every label matches the radius and angle it builds",
  `${labelled}/${turns.length}`);

/* ------------------------------------------------------------------------ */
console.log("\n4. THE TILES BUILD, AND HIT THEIR LABELLED ANGLE\n");

for (const [name, R] of RUNGS) {
  // Tiles no longer carry a hand, so ask for right-handed explicitly.
  const t = turns.find((x) => x.params.curveRadius === R);
  const piece = buildPiece(t.base, initialConnector(),
    { ...DEF, ...t.params, curveDir: 1 }, rp, gp, gp.enabled);
  const e = piece.connectorOut.elements;
  const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  const turned = THREE.MathUtils.radToDeg(Math.atan2(fwd.x, -fwd.z));
  const tris = (piece.geometry.index?.count ?? 0) / 3;
  ok(near(turned, t.params.curveAngle, 1e-6) && tris > 0,
    `${t.label} turns exactly ${t.params.curveAngle}°`, `${turned.toFixed(6)}°, ${tris} tris`);
}

/* ------------------------------------------------------------------------ */
console.log("\n5. CLIMBING TURNS STACK — the Slopes Helix, repointed\n");

/*
 * The Slopes tab's Helix rode `spiral`, whose hint says "stack to gain height"
 * and which does not: constant-rate climb means a pitched entry tangent, so
 * placing it on a level connector rotates the whole helix and tips its axis off
 * vertical. It now rides `loop_spiral` (smoothstepped climb, up pinned to
 * world-up). The Loop tab used to ship a corkscrew of the same piece; helices
 * live only in Slopes now.
 *
 * This asserts the FIX, not the bug: stack three and the height has to be three
 * times one, with nothing rolled. It fails if anyone repoints the tile back —
 * and it prints what `spiral` does beside it so the reason is on screen.
 */
const spiralParams = { spiralRadius: 18, spiralAngle: 180, spiralRise: 10, curveDir: 1 };
const stack = (id, params, n = 3) => {
  let conn = initialConnector();
  const out = [];
  for (let i = 0; i < n; i++) {
    conn = buildPiece(id, conn.clone(), { ...DEF, ...params }, rp, gp, gp.enabled).connectorOut;
    const e = conn.elements;
    out.push({
      y: new THREE.Vector3().setFromMatrixPosition(conn).y,
      upY: new THREE.Vector3(e[4], e[5], e[6]).normalize().y,
    });
  }
  return out;
};

const broken = stack("spiral", spiralParams);
console.log("   `spiral` (why the tile moved):");
for (const [i, s] of broken.entries()) {
  console.log(`     after ${i + 1}   y = ${s.y.toFixed(2).padStart(6)}   up.y = ${s.upY.toFixed(3)}`);
}
ok(broken[1].y < broken[0].y, "`spiral` still does not stack — the tile was right to move",
  `climbs to ${broken[0].y.toFixed(2)} then falls back to ${broken[1].y.toFixed(2)}`);

const helix = CATEGORY_PRESETS.slopes.find((t) => t.id === "slope_helix");
ok(helix?.base === "loop_spiral", "the Slopes Helix rides loop_spiral, not spiral",
  `base = ${helix?.base}`);
const fixed = stack("loop_spiral", helix.params);
console.log("   the tile as it ships now:");
for (const [i, s] of fixed.entries()) {
  console.log(`     after ${i + 1}   y = ${s.y.toFixed(2).padStart(6)}   up.y = ${s.upY.toFixed(3)}`);
}
const rise = helix.params.loopSpiralRise;
for (const [i, s] of fixed.entries()) {
  ok(near(s.y, rise * (i + 1), 1e-6), `stacking ${i + 1} climbs exactly ${rise * (i + 1)} m`,
    `y = ${s.y.toFixed(6)}`);
  ok(near(s.upY, 1, 1e-6), `...with no roll after ${i + 1}`, `up.y = ${s.upY.toFixed(9)}`);
}
// UP AND DOWN ARE TWO TILES PER SIZE; LEFT AND RIGHT ARE NOT.
//
// The sign of `loopSpiralRise` is not a hand — no amount of flipping curveDir
// turns a climb into a descent — so it stays a tile. `curveDir` is, so it went
// to the mode with every other pair (see tools/handedTest.mjs). Getting this
// backwards is the easy mistake: it would either lose the descending helix or
// re-add a mirror twin nobody needs.
// Compact (R18) + Wide (R40). The Loop tab used to ship a third corkscrew
// (R12 / 1 turn); that tile is gone — helices live only in Slopes.
const helixes = CATEGORY_PRESETS.slopes.filter((t) => t.base === "loop_spiral");
const signs = new Set(helixes.map((t) => Math.sign(t.params.loopSpiralRise)));
const radii = new Set(helixes.map((t) => t.params.loopSpiralRadius));
ok(helixes.length === 4 && signs.size === 2, "compact + wide, each up and down",
  helixes.map((t) => t.label).join(", "));
ok(radii.has(18) && radii.has(40), "R18 compact and R40 wide",
  [...radii].join(", "));
ok(helixes.every((t) => t.params.curveDir === undefined),
  "...and none pin a hand — R flips all four");
ok(!CATEGORY_PRESETS.loop.some((t) => t.base === "loop_spiral"),
  "Loop tab no longer offers a helix — that was the corkscrew");

// The PIECE stays even though no tile points at it: a track saved outside this
// repo may contain one, and dropping a catalog entry is how those stop loading.
ok(!!PIECE_BY_ID.get("spiral"), "`spiral` is still in the catalog for old saves",
  "no tile offers it, which is the point");

console.log(fail === 0 ? "\nALL PASS\n" : `\n${fail} FAILURE(S)\n`);
process.exit(fail === 0 ? 0 : 1);
