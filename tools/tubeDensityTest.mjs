// TUBE TESSELLATION — cheaper, and the roof still drives.
//
// The rideable tubes sweep a 98-point annulus at the station density chosen for
// an 8-point road section. 1.5°/station exists for KERBS (a narrow ridge that
// catches the light on every crease); tubes have no kerbs and pay that density
// across twelve times the section.
//
// THE OBVIOUS CUT IS THE WRONG ONE. Half a tube's triangles are its outer shell
// and "nobody looks at the outside of a tube" — except you can land on top of
// one and drive along it, which the kit says out loud. Decimating the profile
// would coarsen that roof ACROSS the car's width: 24 segments is a 6.8 cm step,
// against 1.71 cm today. Relaxing the SWEEP instead leaves every cross-section
// exactly as round as it was and only opens the spacing along the direction of
// travel — the direction a wheelbase smooths out, and the direction that was
// eight times finer than it needed to be.
//
// So this measures the three things that decide whether that reasoning holds:
//
//   • THE EXITS DO NOT MOVE. Density must be a rendering decision, not a
//     geometric one, or every saved track shifts when the kit is retuned.
//   • THE ROOF STILL DRIVES. The car is put ON TOP of a tube and driven along
//     it, before and after, and the ride is compared. This is the check the
//     whole choice rests on.
//   • THE BORE STILL DRIVES. Same, inside.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.tubedens.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const kit = await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { buildPiece, pieceParams, roadParams, guardrailParams, initialConnector, PIECE_BY_ID, PIECE_CATALOG } = kit;
const { RoadBvh } = await import(new URL("../v3/play/modularRoadBvh.js", import.meta.url).href);
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

const rp = { ...roadParams }, gp = { ...guardrailParams }, DEF = { ...pieceParams };
const R = 8, WALL = 0.6;
const ROOF = 2 * R + WALL; // outside of the bore, straight up from the floor
let fail = 0;
const ok = (c, label, detail = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!c) fail++;
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const tri = (g) => (g?.index ? g.index.count : (g?.getAttribute("position")?.count ?? 0)) / 3;

/**
 * Build one piece at an explicit density.
 *
 * Sets it on the DEF, because that is where it lives — buildPiece injects
 * `def.stepRelax` over anything in pp on purpose, so that density can never
 * land in a save file and freeze. Passing it in pp (the first thing I tried)
 * silently measures the shipped value twice and reports a 0% saving.
 */
function at(id, params, relax) {
  const def = PIECE_BY_ID.get(id);
  const had = def.stepRelax;
  def.stepRelax = relax;
  try {
    return buildPiece(id, initialConnector(), { ...DEF, ...params }, rp, gp, gp.enabled);
  } finally { def.stepRelax = had; }
}

/* ---------------------------------------------------------------------- */
console.log("\n1. THE SAVING\n");

const SHIPPED = PIECE_BY_ID.get("tube_curve").stepRelax;
console.log(`   the tube family ships stepRelax ${SHIPPED}\n`);
console.log("   piece                relax 1    shipped    saved");
const CASES = [
  ["tube_curve", { curveRadius: 26, curveAngle: 90, tubeRadius: R, tubeWall: WALL }],
  ["tube_spiral", { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, tubeRadius: R }],
  ["tube_crest", { slopeLength: 36, slopeRise: 8, tubeRadius: R }],
  ["tube_slope", { slopeLength: 32, slopeRise: 10, tubeRadius: R }],
  ["half_tube_curve", { curveRadius: 26, curveAngle: 90, tubeRadius: R, halfTubeSpan: 180 }],
];
let base = 0, now = 0;
for (const [id, params] of CASES) {
  const a = tri(at(id, params, 1).geometry), b = tri(at(id, params, SHIPPED).geometry);
  base += a; now += b;
  console.log(`   ${id.padEnd(18)} ${String(a).padStart(7)}   ${String(b).padStart(8)}   ${(100 - 100 * b / a).toFixed(0).padStart(4)}%`);
}
/*
 * 0.75, NOT THE 0.55 THIS SHIPPED WITH — and the threshold moved because the
 * BASELINE got cheaper, not because the shipped tubes did.
 *
 * This measures what `stepRelax` buys ON TOP OF the default density, so it is
 * only ever as impressive as the default is wasteful. When it was written the
 * default was a flat 1.5°/station with no radius term, which over-tessellated a
 * 26 m arc by roughly a factor of two all on its own — so relax 2.5 looked like
 * it was halving the family when half of that was really the cap's own slack.
 *
 * `stepsFor` now budgets chord error directly, so relax 1 is already close to
 * right and there is correspondingly less left for relax 2.5 to take: measured,
 * 73,388 → 43,748 tris at relax 1, while the SHIPPED column moved on exactly one
 * of the five pieces (tube_crest, 9,204 → 7,048 — a gentle vertical arc the old
 * angle cap was over-stepping). tube_curve, tube_spiral, tube_slope and
 * half_tube_curve are bit-identical to what they were.
 *
 * So this still asserts the thing worth asserting — the family's opt-out earns
 * its keep — against a baseline that no longer flatters it.
 */
ok(now < base * 0.75, "the tube family's stepRelax still earns its keep",
  `${base} → ${now} tris, ${(100 - 100 * now / base).toFixed(0)}% off`);

/* ---------------------------------------------------------------------- */
console.log("\n2. DENSITY IS NOT GEOMETRY — the exits do not move\n");

// If this fails, retuning the kit silently moves every tube in every saved
// track, which is the difference between a rendering knob and a breaking change.
for (const [id, params] of CASES) {
  const a = at(id, params, 1).connectorOut.elements;
  const b = at(id, params, SHIPPED).connectorOut.elements;
  let worst = 0;
  for (let i = 0; i < 16; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  ok(worst < 1e-9, `${id}: exit identical at both densities`, `worst Δ=${worst.toExponential(2)}`);
}

/* ---------------------------------------------------------------------- */
console.log("\n3. THE ROOF STILL DRIVES — the check this all rests on\n");

/**
 * Put the car ON TOP of a straight tube and drive the length of it.
 *
 * A tube roof is a cylinder, so the car balances on a ridge — it will slide off
 * eventually whatever the mesh does. What matters is whether the coarser sweep
 * makes it WORSE: more jolts, earlier loss of contact, a rougher ride.
 */
function driveRoof(relax, { length = 120, speed = 30, secs = 4 } = {}) {
  const built = at("tube", { straightLength: length, tubeRadius: R, tubeWall: WALL }, relax);
  const m = new THREE.Mesh(built.deckCollision ?? built.geometry);
  m.applyMatrix4(built.world); m.updateMatrixWorld(true);
  const bvh = new RoadBvh(); bvh.bakeFromMeshes([m]);
  const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
  g.setRoadBvh(bvh.baked ? bvh : null);

  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = g.ground; c.solidsBvh = g.solids; c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, ROOF + WHEEL.radius + 0.10, -6);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -speed);

  let jolts = 0, ran = 0, lastVy = 0, worstJolt = 0, contact = 0;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle: 0.5, handbrake: false, yaw: 0, pitch: 0 });
    if (c.body.pos.z < -length || c.body.pos.y < ROOF - 4) break;
    ran++;
    if (c.groundedCount > 0) contact++;
    // A JOLT is a step change in vertical velocity while on the surface — which
    // is exactly what driving over a facet edge produces.
    const dv = Math.abs(c.body.vel.y - lastVy);
    if (c.groundedCount >= 3 && dv > 0.35) { jolts++; worstJolt = Math.max(worstJolt, dv); }
    lastVy = c.body.vel.y;
  }
  return { jolts, worstJolt, ran, held: ran ? contact / ran : 0, z: -c.body.pos.z };
}

console.log("   relax   ticks   contact   jolts   worst jolt   ran to");
const roof = new Map();
for (const relax of [1, SHIPPED, 4]) {
  const r = driveRoof(relax);
  roof.set(relax, r);
  console.log(`   ${String(relax).padStart(5)}   ${String(r.ran).padStart(5)}   ${(100 * r.held).toFixed(0).padStart(6)}%`
    + `   ${String(r.jolts).padStart(5)}   ${r.worstJolt.toFixed(2).padStart(10)}   ${r.z.toFixed(0).padStart(6)} m`);
}
const a = roof.get(1), b = roof.get(SHIPPED);
ok(b.held >= a.held - 0.02, "the shipped density holds the roof as well as the fine one",
  `${(100 * a.held).toFixed(0)}% → ${(100 * b.held).toFixed(0)}%`);
ok(b.jolts <= a.jolts + 2, "and is no bumpier", `${a.jolts} → ${b.jolts} jolts`);
ok(b.z >= a.z - 4, "and carries the car as far along the roof",
  `${a.z.toFixed(0)} m → ${b.z.toFixed(0)} m`);

/* ---------------------------------------------------------------------- */
console.log("\n4. AND THE BORE STILL DRIVES\n");

function driveBore(relax, { speed = 34, secs = 4 } = {}) {
  let conn = initialConnector();
  const meshes = [];
  for (const [id, params] of [
    ["tube", { straightLength: 40, tubeRadius: R, tubeWall: WALL }],
    ["tube_curve", { curveRadius: 26, curveAngle: 90, curveDir: 1, tubeRadius: R, tubeWall: WALL }],
    ["tube", { straightLength: 40, tubeRadius: R, tubeWall: WALL }],
  ]) {
    const d = PIECE_BY_ID.get(id); const had = d.stepRelax; d.stepRelax = relax;
    const built = buildPiece(id, conn.clone(), { ...DEF, ...params }, rp, gp, gp.enabled);
    d.stepRelax = had;
    const m = new THREE.Mesh(built.deckCollision ?? built.geometry);
    m.applyMatrix4(built.world); m.updateMatrixWorld(true);
    meshes.push(m); conn = built.connectorOut;
  }
  const bvh = new RoadBvh(); bvh.bakeFromMeshes(meshes);
  const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
  g.setRoadBvh(bvh.baked ? bvh : null);

  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = g.ground; c.solidsBvh = g.solids; c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, WHEEL.radius + 0.12, -4);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -speed);

  let jolts = 0, contact = 0, ran = 0, lastVy = 0;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0.12, throttle: 0.7, handbrake: false, yaw: 0, pitch: 0 });
    if (c.body.pos.y < -6) break;
    ran++;
    if (c.groundedCount > 0) contact++;
    const dv = Math.abs(c.body.vel.y - lastVy);
    if (c.groundedCount >= 3 && dv > 0.35) jolts++;
    lastVy = c.body.vel.y;
  }
  return { jolts, held: ran ? contact / ran : 0, dist: c.body.pos.length() };
}

console.log("   relax   contact   jolts   travelled");
const bore = new Map();
for (const relax of [1, 1.5, 2, SHIPPED, 3.5, 5]) {
  const r = driveBore(relax);
  bore.set(relax, r);
  console.log(`   ${String(relax).padStart(5)}   ${(100 * r.held).toFixed(0).padStart(6)}%   ${String(r.jolts).padStart(5)}   ${r.dist.toFixed(0).padStart(9)} m`);
}
/*
 * THE JOLT COUNT IS NOISY, AND THE SWEEP IS WHY THIS IS NOT A +2 THRESHOLD.
 *
 * Inside a bore under steering the car rides up the wall and oscillates, so most
 * of what the counter sees is the car's own dynamics rather than facet edges.
 * MEASURED across densities: 36, 40, 42, 39, 41, 54 for relax 1 / 1.5 / 2 / 2.5
 * / 3.5 / 5. Flat and non-monotonic up to 3.5 — relax 2 scores WORSE than 2.5 —
 * and then a clear step at 5.
 *
 * So the shipped 2.5 sits in the noise band with headroom, and the second
 * assertion is the one that gives the first any weight: it shows the metric can
 * still SEE degradation. Without it, "no degradation at 2.5" might only mean the
 * measurement is blind.
 */
// MEASURE THE BAND, DO NOT HARD-CODE IT. This used to compare the shipped
// density against `fine * 1.25`, which quietly assumed the absolute jolt counts
// stay put. They do not: they track the CAR, not the mesh. Reverting gripRear
// 1.5 -> 1.0 moved them from 36/40/42/39/41/54 to 22/23/29/29/22/40, and a
// multiplicative band on a smaller base is far tighter in absolute terms — so
// the check failed over a car change that has nothing to do with tessellation.
//
// The densities from 1 to 3.5 are all meant to be equivalent, so the spread
// ACROSS them is the noise floor, measured fresh each run. The shipped value
// has to sit inside the spread of the others (excluding itself, or the test
// would be vacuous), and relax 5 has to sit clearly outside it.
const fine = bore.get(1), shipped = bore.get(SHIPPED);
ok(shipped.held >= fine.held - 0.02, "the bore holds the car as well",
  `${(100 * fine.held).toFixed(0)}% → ${(100 * shipped.held).toFixed(0)}%`);

/*
 * THE TWO JOLT ASSERTIONS THAT USED TO LIVE HERE ARE GONE, DELIBERATELY, AND
 * THIS IS A WEAKENED TEST — read this before trusting the section above.
 *
 * They were a pair: "the shipped density is inside the noise band" only meant
 * anything because "the measurement can still see a bad density" proved the
 * counter was not simply blind. The second one is what broke, and it broke for
 * a reason that is not a regression.
 *
 * Under the old flat 1.5° cap, `stepRelax` divided the station count outright,
 * so relax 5 produced genuinely broken geometry — 12 stations across a 90° arc
 * — and the counter saw it: 40 jolts against a 29 band, a clear cliff. Under
 * the sagitta rule `stepRelax` scales a CHORD-ERROR BUDGET instead, and the
 * count falls off as 1/sqrt(relax) rather than 1/relax. Measured on this rig,
 * relax 5 now yields 3,912 verts where it used to yield roughly half that, and
 * the drive reads 23 jolts / 95% contact — indistinguishable from fine. Pushing
 * the sweep out to relax 7/10/14/20 does not restore a cliff either (30/40/36/25
 * jolts, contact never below 95%): the count is dominated by the car's own
 * oscillation up the bore wall, which this file's own comment above says out
 * loud, and there is no longer a density in a sane range where facet edges rise
 * above it.
 *
 * That is a real property of the new rule — it bounds the error `stepRelax` can
 * introduce, so the knob can no longer be turned into a broken tube — but it
 * leaves the jolt counter with nothing to discriminate. Keeping the first
 * assertion without its control would be asserting "no degradation" on a
 * measurement that has been shown unable to detect degradation, which is worse
 * than asserting nothing.
 *
 * WHAT IS STILL COVERED: section 2 pins the exits (density must not move
 * geometry), section 3 drives the roof, and the contact check above is
 * unchanged. WHAT IS NOT: nothing here now fails if a future change makes the
 * shipped bore subtly bumpier. Replacing this wants a direct chord-error
 * measurement against `roadParams.stepSagitta` — closed-form off the station
 * count, not sampled off the mesh — rather than another drive-based proxy.
 */

/* ---------------------------------------------------------------------- */
console.log("\n5. THE ROAD PIECES ARE UNTOUCHED\n");

// Only the tube family opts in. A kerbed road at relax 2.5 is the facet problem
// MAX_STEP_ANGLE was set to avoid.
for (const id of ["curve", "slope", "banked", "crest", "loop"]) {
  ok(!PIECE_BY_ID.get(id).stepRelax, `${id} keeps the default density`);
}
const road = buildPiece("curve", initialConnector(),
  { ...DEF, curveRadius: 26, curveAngle: 90 }, rp, gp, gp.enabled);
ok(tri(road.geometry) > 0, "a road curve still builds", `${tri(road.geometry)} tris`);

/* ---------------------------------------------------------------------- */
console.log("\n6. AND NEITHER ARE THE MORPHING PIECES\n");

/*
 * THE ONE THIS GOT WRONG. Every argument above for the stations being surplus
 * assumes the CROSS-SECTION IS THE SAME AT ALL OF THEM — then a station only
 * approximates the centreline, and a 26 m arc barely needs them.
 *
 * A piece with `profileAt` is the opposite kind of thing: its section is rebuilt
 * at every station, rolling a flat plate up into a bore, so the stations ARE the
 * shape. Relaxing those took the tube entry from 17 stations to 7 and it went
 * visibly blocky — reported as "the tube entry looks very cheap, not smooth at
 * all". They were in the opt-in list because it was hand-written; it is filtered
 * by `profileAt` now, so the next morphing tube piece cannot be added back in.
 */
const morphing = PIECE_CATALOG.filter((d) => d.profileAt);
ok(morphing.length > 0, "there are morphing pieces to protect",
  morphing.map((d) => d.id).join(", "));
for (const def of morphing) {
  ok(!def.stepRelax, `${def.id} keeps every station — its section changes at each one`);
}
// And the saving is still real on the pieces that legitimately take it.
const relaxed = PIECE_CATALOG.filter((d) => d.stepRelax);
ok(relaxed.length > 0 && relaxed.every((d) => !d.profileAt),
  "the relaxed set is exactly the constant-section tubes", `${relaxed.length} pieces`);
const entryStations = PIECE_BY_ID.get("tube_in").points({ ...DEF }).length - 1;
ok(entryStations >= 16, "a 26 m tube entry still samples its morph finely",
  `${entryStations} stations`);

console.log(fail === 0 ? "\nALL PASS\n" : `\n${fail} FAILURE(S)\n`);
process.exit(fail === 0 ? 0 : 1);
