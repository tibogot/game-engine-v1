// TUBES THAT GO SOMEWHERE VERTICALLY, and banked turns that climb.
//
// Every tube piece in the kit used to ride a FLAT centreline (straightPoints or
// curvePoints), so a tube run could not change altitude. The only way to make
// one climb was to rotate a piece — and rotating a piece rotates its EXIT
// PLANE, which drags every piece after it. The fix is pieces whose ends are
// LEVEL, the same trick `slope` and `crest` already use on flat road.
//
// That is exactly what this measures, because it is the one thing a screenshot
// cannot show you:
//
//   • THE EXIT IS LEVEL. A Tube Up must gain its height and still hand the next
//     piece a frame with up = +Y and heading = −Z. If it does not, dropping one
//     mid-chain tilts everything downstream and the piece is useless.
//   • THE HEIGHT IS THE ONE ON THE TILE. slopeRise 10 has to move the connector
//     10 m, and a crest has to come back to 0 — the sweep integrates a tangent,
//     so an easing that does not close leaves a drift nobody notices until a
//     lap does not join.
//   • THE RIM IS NOT A SHELF. Anything with an open lip must hand back a
//     `deckCollision` SMALLER than its mesh (see buildOpenLipCollision). Miss
//     the flag on a new half-tube and the car cannot leave the piece at all —
//     measured at 9.7 m vs 49.7 m of air the last time this went wrong.
//   • THE SEAM MATCHES. A new tube piece sweeps the same annulus as the tubes
//     beside it, so its section must have the SAME point count and the same
//     bore radius, or the far seam does not meet vertex for vertex.
//
// Drives the real builders — the kit imports cleanly under node.
import { readFileSync } from "node:fs";
import * as THREE from "three";

const kit = await import(
  new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href
);
const { buildPiece, roadParams, pieceParams, guardrailParams, PIECE_BY_ID } = kit;

// The tube sections are module-private, so take them off the pieces that are
// already known to sweep them — which is the stronger check anyway: it compares
// against what `tube` / `half_tube` ACTUALLY use, not a re-import of the same
// function.
const buildTubeProfile = PIECE_BY_ID.get("tube").profile;
const buildHalfTubeProfile = PIECE_BY_ID.get("half_tube").profile;

let failures = 0;
const ok = (cond, label, detail = "") => {
  if (cond) console.log(`  PASS  ${label}${detail ? `  ${detail}` : ""}`);
  else { console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`); failures++; }
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;

const rp = { ...roadParams };
const gp = { ...guardrailParams };
const DEF = { ...pieceParams };
const I = new THREE.Matrix4();

/** Build one piece off the origin with a tile's params layered on the defaults. */
const build = (id, params = {}, opts = {}) =>
  buildPiece(id, I.clone(), { ...DEF, ...params }, rp, gp, gp.enabled, opts);

/** Decompose a connector into position + the axes it hands the next piece. */
function readConnector(m) {
  const pos = new THREE.Vector3().setFromMatrixPosition(m);
  const e = m.elements;
  return {
    pos,
    right: new THREE.Vector3(e[0], e[1], e[2]).normalize(),
    up: new THREE.Vector3(e[4], e[5], e[6]).normalize(),
    // Column 2 is +Z; travel is −Z, matching socketMatrix / the −Z convention.
    fwd: new THREE.Vector3(-e[8], -e[9], -e[10]).normalize(),
  };
}

const hasNaN = (geo) => {
  const a = geo?.getAttribute?.("position");
  if (!a) return true;
  for (let i = 0; i < a.count * a.itemSize; i++) if (!Number.isFinite(a.array[i])) return true;
  return false;
};
const triCount = (geo) => (geo?.index ? geo.index.count : (geo?.getAttribute("position")?.count ?? 0)) / 3;

/* ----------------------------------------------------------------------- */
console.log("\n1. Every new piece builds, and builds something\n");

const NEW_PIECES = [
  ["tube_slope", { slopeLength: 32, slopeRise: 10 }],
  ["half_tube_slope", { slopeLength: 32, slopeRise: 10 }],
  ["tube_crest", { slopeLength: 36, slopeRise: 8 }],
  ["half_tube_crest", { slopeLength: 36, slopeRise: 8 }],
  ["tube_spiral", { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, curveDir: 1 }],
  ["half_tube_spiral", { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, curveDir: 1 }],
  ["half_pipe_slope", { slopeLength: 90, slopeRise: -16, tubeRadius: 26, halfPipeFlat: 12, halfPipeVert: 17 }],
  ["banked_climb", { curveRadius: 58, curveAngle: 90, bankAngle: 22, bankRise: 14, curveDir: 1 }],
];

for (const [id, params] of NEW_PIECES) {
  const def = PIECE_BY_ID.get(id);
  ok(!!def, `${id} is in the catalog`);
  if (!def) continue;
  const piece = build(id, params);
  const tris = triCount(piece.geometry);
  ok(tris > 32 && !hasNaN(piece.geometry), `${id} sweeps a real deck`, `${tris.toFixed(0)} tris`);
}

/* ----------------------------------------------------------------------- */
console.log("\n2. LEVEL EXITS — the whole reason these pieces exist\n");

// A level-ended piece hands the next one an upright frame pointing dead ahead,
// whatever it did to the height in between. Anything else drags the chain.
const LEVEL = [
  ["tube_slope", { slopeLength: 32, slopeRise: 10 }, 10],
  ["tube_slope", { slopeLength: 32, slopeRise: -10 }, -10],
  ["half_tube_slope", { slopeLength: 32, slopeRise: 10 }, 10],
  ["half_tube_slope", { slopeLength: 32, slopeRise: -10 }, -10],
  ["tube_crest", { slopeLength: 36, slopeRise: 8 }, 0],
  ["tube_crest", { slopeLength: 36, slopeRise: -8 }, 0],
  ["half_tube_crest", { slopeLength: 36, slopeRise: 8 }, 0],
  ["half_pipe_slope", { slopeLength: 90, slopeRise: -16, tubeRadius: 26, halfPipeFlat: 12, halfPipeVert: 17 }, -16],
];

for (const [id, params, rise] of LEVEL) {
  const c = readConnector(build(id, params).connectorOut);
  ok(near(c.up.y, 1, 1e-6), `${id} rise ${rise}: exit is UPRIGHT`, `up.y=${c.up.y.toFixed(9)}`);
  ok(near(c.fwd.y, 0, 1e-6) && near(c.fwd.z, -1, 1e-6),
    `${id} rise ${rise}: exit heads dead ahead`, `fwd=(${c.fwd.x.toFixed(6)}, ${c.fwd.y.toFixed(6)}, ${c.fwd.z.toFixed(6)})`);
  ok(near(c.pos.y, rise, 1e-6), `${id} rise ${rise}: exit is at the labelled height`, `y=${c.pos.y.toFixed(6)}`);
  ok(near(c.pos.x, 0, 1e-6), `${id} rise ${rise}: no lateral drift`, `x=${c.pos.x.toExponential(2)}`);
}

/* ----------------------------------------------------------------------- */
console.log("\n3. A slope piece does not disturb what follows it\n");

// The complaint that started this: rotating a tube to climb moved the whole
// chain. Build tube → tube_up → tube and check the third piece sits exactly
// `rise` above where the first one left off, still upright, still heading −Z.
{
  const a = build("tube", { straightLength: 26 });
  const b = buildPiece("tube_slope", a.connectorOut.clone(),
    { ...DEF, slopeLength: 32, slopeRise: 10 }, rp, gp, gp.enabled);
  const c = buildPiece("tube", b.connectorOut.clone(),
    { ...DEF, straightLength: 26 }, rp, gp, gp.enabled);

  const p0 = readConnector(a.connectorOut);
  const p2 = readConnector(c.connectorOut);
  ok(near(p2.up.y, 1, 1e-6), "tube → up → tube: third piece still upright", `up.y=${p2.up.y.toFixed(9)}`);
  ok(near(p2.fwd.z, -1, 1e-6), "tube → up → tube: heading unchanged", `fwd.z=${p2.fwd.z.toFixed(9)}`);
  ok(near(p2.pos.y - p0.pos.y, 10, 1e-6), "tube → up → tube: gained exactly the rise",
    `Δy=${(p2.pos.y - p0.pos.y).toFixed(6)}`);
  ok(near(p2.pos.z - p0.pos.z, -(32 + 26), 1e-6), "tube → up → tube: forward run is the two lengths",
    `Δz=${(p2.pos.z - p0.pos.z).toFixed(6)}`);
}

/* ----------------------------------------------------------------------- */
console.log("\n4. HELIXES stack — this is where `spiralPoints` fails and why\n");

// THE BUG THAT PICKED THE CENTRELINE. `spiralPoints` climbs at a constant rate,
// so its ENTRY tangent is pitched up; placing it on a level connector rotates
// the whole helix to bring that tangent down, tipping the helix axis off
// vertical. Measured on the shipped Slopes → Helix tile, three stacked:
//
//     after 1   y = 9.77   up = (-0.52, 0.81, -0.29)   36° of roll
//     after 2   y = 0.75   <- climbed, then came back DOWN
//     after 3   y = 9.13
//
// This asserts the tube helixes do NOT behave that way. `spiral` itself is left
// alone (fixing it would move the geometry of every saved track with one), so
// the check below is also a live regression guard on that decision.
{
  const P = { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, curveDir: 1 };
  const seen = [];
  let conn = I.clone();
  for (let i = 0; i < 3; i++) {
    conn = buildPiece("tube_spiral", conn.clone(), { ...DEF, ...P }, rp, gp, gp.enabled).connectorOut;
    seen.push(readConnector(conn));
  }
  ok(near(seen[0].pos.y, 14, 1e-6), "one helix climbs exactly its rise", `y=${seen[0].pos.y.toFixed(6)}`);
  ok(near(seen[1].pos.y, 28, 1e-6), "two stack to double it", `y=${seen[1].pos.y.toFixed(6)}`);
  ok(near(seen[2].pos.y, 42, 1e-6), "three stack to triple it", `y=${seen[2].pos.y.toFixed(6)}`);
  for (let i = 0; i < 3; i++) {
    ok(near(seen[i].up.y, 1, 1e-6), `after ${i + 1}: no roll has accumulated`, `up.y=${seen[i].up.y.toFixed(9)}`);
    ok(near(seen[i].fwd.y, 0, 1e-6), `after ${i + 1}: exit heading is horizontal`, `fwd.y=${seen[i].fwd.y.toExponential(2)}`);
  }
  // Half a turn each, so a PAIR comes back to the entry heading — which is what
  // makes two of them one turn of a corkscrew rather than a staircase.
  ok(near(seen[1].fwd.z, -1, 1e-6), "two half-turns return to the entry heading", `fwd.z=${seen[1].fwd.z.toFixed(9)}`);
  ok(Math.abs(seen[0].pos.x) > 40, "the helix actually wraps (2R across)", `x=${seen[0].pos.x.toFixed(2)}`);
}

/* ----------------------------------------------------------------------- */
console.log("\n5. BANKED CLIMB — gains height, keeps the bank family's level socket\n");

for (const [dir, rise] of [[1, 14], [-1, 14], [1, -14], [-1, -14]]) {
  const P = { curveRadius: 58, curveAngle: 90, bankAngle: 22, bankRise: rise, curveDir: dir };
  const climb = readConnector(build("banked_climb", P).connectorOut);
  const flat = readConnector(build("banked", P).connectorOut);
  const tag = `dir ${dir > 0 ? "R" : "L"} rise ${rise}`;

  // LEVEL SOCKETS are the bank family's contract: the connector never carries
  // the roll, so the piece sits upright as authored wherever it is dropped.
  ok(near(climb.up.y, 1, 1e-9), `${tag}: connector carries no roll`, `up.y=${climb.up.y.toFixed(9)}`);
  ok(near(climb.fwd.y, 0, 1e-9), `${tag}: exit heading is horizontal`, `fwd.y=${climb.fwd.y.toExponential(2)}`);
  ok(near(climb.pos.y - flat.pos.y, rise, 1e-9), `${tag}: exit lifted by exactly bankRise`,
    `Δy=${(climb.pos.y - flat.pos.y).toFixed(9)}`);
  // In plan it must be the SAME corner as the held-bank turn it replaces.
  ok(near(climb.pos.x, flat.pos.x, 1e-9) && near(climb.pos.z, flat.pos.z, 1e-9),
    `${tag}: same corner in plan as the flat banked turn`);
  ok(near(climb.fwd.dot(flat.fwd), 1, 1e-9), `${tag}: same heading change as the flat banked turn`);
}

// bankRise 0 has to reproduce the held-bank turn exactly, or there is no way to
// dial the climb back out of a piece already placed in a track.
{
  const P = { curveRadius: 58, curveAngle: 90, bankAngle: 22, curveDir: 1 };
  const zero = build("banked_climb", { ...P, bankRise: 0 });
  const flat = build("banked", P);
  const a = zero.geometry.getAttribute("position");
  const b = flat.geometry.getAttribute("position");
  let worst = 0;
  if (a.count === b.count) {
    for (let i = 0; i < a.count * 3; i++) worst = Math.max(worst, Math.abs(a.array[i] - b.array[i]));
  }
  ok(a.count === b.count && worst < 1e-6, "bankRise 0 reproduces the flat banked turn exactly",
    `${a.count} vs ${b.count} verts, worst Δ=${worst.toExponential(2)}`);
}

/* ----------------------------------------------------------------------- */
console.log("\n6. OPEN LIPS — the rim caps must not be a shelf\n");

// buildOpenLipCollision strips the closing bands, so the collision mesh is
// strictly smaller than the rendered one. A full tube's mouths are CAPPED on
// the mesh instead, so there the collision copy is the smaller of the two too.
const LIPPED = [
  ["half_tube_slope", { slopeLength: 32, slopeRise: 10 }],
  ["half_tube_crest", { slopeLength: 36, slopeRise: 8 }],
  ["half_tube_spiral", { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, curveDir: 1 }],
  ["half_pipe_slope", { slopeLength: 90, slopeRise: -16, tubeRadius: 26, halfPipeFlat: 12, halfPipeVert: 17 }],
];
for (const [id, params] of LIPPED) {
  const piece = build(id, params);
  const mesh = triCount(piece.geometry);
  const coll = piece.deckCollision ? triCount(piece.deckCollision) : mesh;
  ok(!!piece.deckCollision && coll < mesh, `${id}: rim caps are stripped from the BVH`,
    `${coll.toFixed(0)} coll tris vs ${mesh.toFixed(0)} mesh tris`);
}
for (const [id, params] of [["tube_slope", { slopeLength: 32, slopeRise: 10 }],
                            ["tube_crest", { slopeLength: 36, slopeRise: 8 }],
                            ["tube_spiral", { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, curveDir: 1 }]]) {
  const piece = build(id, params);
  ok(!!piece.deckCollision && triCount(piece.deckCollision) < triCount(piece.geometry),
    `${id}: mouth caps render but are not road`,
    `${triCount(piece.deckCollision).toFixed(0)} vs ${triCount(piece.geometry).toFixed(0)}`);
}

/* ----------------------------------------------------------------------- */
console.log("\n7. SEAMS — a new tube sweeps the same bore as the tubes beside it\n");

{
  const P = { tubeRadius: 8, tubeWall: 0.6 };
  const full = buildTubeProfile({ ...DEF, ...P }, rp);
  const half = buildHalfTubeProfile({ ...DEF, ...P, halfTubeSpan: 180 }, rp);
  for (const id of ["tube_slope", "tube_crest", "tube_spiral"]) {
    const sec = PIECE_BY_ID.get(id).profile({ ...DEF, ...P }, rp);
    ok(sec.pts.length === full.pts.length, `${id} uses the full-tube section`,
      `${sec.pts.length} pts`);
  }
  for (const id of ["half_tube_slope", "half_tube_crest", "half_tube_spiral"]) {
    const sec = PIECE_BY_ID.get(id).profile({ ...DEF, ...P, halfTubeSpan: 180 }, rp);
    ok(sec.pts.length === half.pts.length, `${id} uses the half-tube section`,
      `${sec.pts.length} pts`);
  }
  // Change the radius and the new pieces have to follow, or a tile that edits
  // tubeRadius desyncs the run.
  const wide = PIECE_BY_ID.get("tube_slope").profile({ ...DEF, tubeRadius: 12, tubeWall: 0.6 }, rp);
  const wideRef = buildTubeProfile({ ...DEF, tubeRadius: 12, tubeWall: 0.6 }, rp);
  let worst = 0;
  for (let i = 0; i < wide.pts.length; i++) {
    worst = Math.max(worst,
      Math.abs(wide.pts[i].x - wideRef.pts[i].x),
      Math.abs(wide.pts[i].y - wideRef.pts[i].y));
  }
  ok(worst < 1e-9, "tube_slope tracks tubeRadius", `worst Δ=${worst.toExponential(2)}`);
}

/* ----------------------------------------------------------------------- */
console.log("\n8. S-BENDS sidestep without turning\n");

// The whole value of the piece is that the heading it hands on is the heading it
// was given — two 45° corners would offset you too, and rotate everything after.
for (const [id, extra] of [["tube_scurve", {}], ["half_tube_scurve", { halfTubeSpan: 180 }]]) {
  for (const dir of [1, -1]) {
    const P = { curveRadius: 26, curveAngle: 40, curveDir: dir, tubeRadius: 8, tubeWall: 0.6, ...extra };
    const c = readConnector(build(id, P).connectorOut);
    const tag = `${id} ${dir > 0 ? "R" : "L"}`;
    ok(near(c.fwd.z, -1, 1e-6) && near(c.fwd.x, 0, 1e-6), `${tag}: exits on the entry heading`,
      `fwd=(${c.fwd.x.toExponential(2)}, ${c.fwd.y.toExponential(2)}, ${c.fwd.z.toFixed(9)})`);
    ok(near(c.up.y, 1, 1e-6), `${tag}: exits upright`, `up.y=${c.up.y.toFixed(9)}`);
    ok(near(c.pos.y, 0, 1e-6), `${tag}: stays at its altitude`, `y=${c.pos.y.toExponential(2)}`);

    // IT HAS TO SIDESTEP, and to the same side the plain `scurve` does for the
    // same curveDir — these tube pieces are that centreline with a tube section
    // on it, so any disagreement means they were wired differently.
    //
    // NOT an absolute direction check, because `scurve` disagrees with the rest
    // of the kit and that is a pre-existing bug, not this piece's to fix.
    // MEASURED at R20 / 38° / curveDir +1: `curve` and `banked` exit at x =
    // +4.24 (right, since travel is −Z and up is +Y, so right is +X) while
    // `scurve` exits at x = −8.48 — the mirror. So the shipped Turns tiles
    // "S Right" (curveDir +1) and "S Left" (curveDir −1) are each other's.
    // Fixing sCurvePoints would mirror the two scurve pieces in
    // apex-parkour.json and everything downstream of them, so it is left alone
    // and reported instead.
    const plain = readConnector(build("scurve", { curveRadius: 26, curveAngle: 40, curveDir: dir }).connectorOut);
    ok(Math.abs(c.pos.x) > 5, `${tag}: actually sidesteps`, `x=${c.pos.x.toFixed(2)}`);
    ok(Math.sign(c.pos.x) === Math.sign(plain.pos.x), `${tag}: same side as the plain S-curve`,
      `tube ${c.pos.x.toFixed(2)} vs scurve ${plain.pos.x.toFixed(2)}`);
  }
}

/* ----------------------------------------------------------------------- */
console.log("\n9. CANNONS leave at the angle on the tile\n");

for (const [id, extra] of [["tube_launch", {}], ["half_tube_launch", { halfTubeSpan: 180 }]]) {
  for (const ang of [12, 18, 30]) {
    const P = { tubeEntryLength: 26, jumpAngle: ang, tubeRadius: 8, tubeWall: 0.6, ...extra };
    const c = readConnector(build(id, P).connectorOut);
    const got = THREE.MathUtils.radToDeg(Math.asin(c.fwd.y));
    ok(near(got, ang, 1e-4), `${id} @ ${ang}°: exit pitch is exact`, `${got.toFixed(6)}°`);
    ok(c.pos.y > 0, `${id} @ ${ang}°: the mouth is above the bore`, `y=${c.pos.y.toFixed(2)}`);
  }
  /*
   * The bore end must still be a bore — this is a tube EXIT that happens to
   * climb, so its t = 1 section is the tube's, exactly as on tube_out.
   *
   * COMPARE THE SECTION, NOT THE VERTEX COUNT. This used to compare total
   * vertices, which conflates the cross-section with how many stations the piece
   * happens to sweep — and those two decoupled the moment `stepRelax` arrived:
   * `tubeEntryPoints` and `tubeLaunchPoints` size their run differently, so the
   * launch came out one station longer and a test about SEAMS started failing
   * over tessellation. The seam only cares that both sweep the same outline.
   */
  const outId = id.replace("launch", "out");
  const params = { ...DEF, tubeEntryLength: 26, tubeRadius: 8, tubeWall: 0.6, ...extra };
  const flatSec = PIECE_BY_ID.get(outId).profile(params, rp);
  const liftSec = PIECE_BY_ID.get(id).profile(params, rp);
  let worst = 0;
  const same = flatSec.pts.length === liftSec.pts.length;
  if (same) {
    for (let i = 0; i < flatSec.pts.length; i++) {
      worst = Math.max(worst,
        Math.abs(flatSec.pts[i].x - liftSec.pts[i].x),
        Math.abs(flatSec.pts[i].y - liftSec.pts[i].y));
    }
  }
  ok(same && worst < 1e-12, `${id}: sweeps the same bore section as the flat exit`,
    `${liftSec.pts.length} pts, worst Δ=${worst.toExponential(2)} m`);
}

/* ----------------------------------------------------------------------- */
console.log("\n10. REDUCERS — exact at BOTH ends, which is the only safe kind\n");

// A second size family only works if you can get between the sizes without a
// step. So each end has to be LITERALLY the point set the neighbouring tube
// sweeps — not close, equal, because the two pieces are authored independently.
for (const [id, ref, extra] of [
  ["tube_reduce", "tube", {}],
  ["half_tube_reduce", "half_tube", { halfTubeSpan: 180 }],
]) {
  const def = PIECE_BY_ID.get(id);
  const refProfile = PIECE_BY_ID.get(ref).profile;
  const P = { tubeRadius: 8, tubeRadius2: 12, tubeWall: 0.6, ...extra };

  for (const [t, radius, end] of [[0, 8, "near"], [1, 12, "far"]]) {
    const got = def.profileAt(t, { ...DEF, ...P }, rp);
    const want = refProfile({ ...DEF, ...P, tubeRadius: radius }, rp);
    let worst = 0;
    const same = got.pts.length === want.pts.length;
    if (same) {
      for (let i = 0; i < got.pts.length; i++) {
        worst = Math.max(worst, Math.abs(got.pts[i].x - want.pts[i].x), Math.abs(got.pts[i].y - want.pts[i].y));
      }
    }
    ok(same && worst < 1e-12, `${id}: ${end} end IS the R${radius} tube's own section`,
      `${got.pts.length} pts, worst Δ=${worst.toExponential(2)} m`);
  }

  // buildSweepGeometry throws if the point count moves mid-sweep, and that throw
  // is a build-time crash for the user rather than a cosmetic bug.
  const counts = new Set();
  for (let i = 0; i <= 16; i++) counts.add(def.profileAt(i / 16, { ...DEF, ...P }, rp).pts.length);
  ok(counts.size === 1, `${id}: point count is constant along the taper`, `${[...counts].join(", ")}`);

  // The floor stays on the connector plane the whole way, or the car drops into
  // the seam. Every section's lowest inner point must be y = 0.
  let worstFloor = 0;
  for (let i = 0; i <= 16; i++) {
    const pts = def.profileAt(i / 16, { ...DEF, ...P }, rp).pts.filter((p) => p.zone === 3);
    worstFloor = Math.max(worstFloor, Math.abs(Math.min(...pts.map((p) => p.y))));
  }
  ok(worstFloor < 1e-9, `${id}: the floor never leaves y = 0`, `worst ${worstFloor.toExponential(2)} m`);

  // And it must taper the right way round.
  const near0 = def.profileAt(0, { ...DEF, ...P }, rp).hw;
  const near1 = def.profileAt(1, { ...DEF, ...P }, rp).hw;
  ok(near(near0, 8, 1e-9) && near(near1, 12, 1e-9), `${id}: tapers tubeRadius → tubeRadius2`,
    `${near0} → ${near1}`);
}

// Reducers are straight and level — they are plumbing, not a shape.
for (const id of ["tube_reduce", "half_tube_reduce"]) {
  const c = readConnector(build(id, { tubeEntryLength: 30, tubeRadius: 12, tubeRadius2: 8, tubeWall: 0.6 }).connectorOut);
  ok(near(c.pos.y, 0, 1e-9) && near(c.pos.x, 0, 1e-9) && near(c.fwd.z, -1, 1e-9),
    `${id}: exit is straight ahead and level`);
  ok(near(c.pos.z, -30, 1e-9), `${id}: exit is at tubeEntryLength`, `z=${c.pos.z.toFixed(6)}`);
}

/* ----------------------------------------------------------------------- */
console.log("\n11. THE ANGLE LADDER is complete, and each rung agrees with itself\n");

// A bank section is Up → (Straight | Turn)* → Down, and every piece in it has to
// carry the SAME bankAngle: the held-bank pieces share one raised/rolled section
// and that section is a function of the angle, so a mismatched rung is a step in
// the deck. Assert each angle actually has all four, and that the transitions
// land exactly on the height the held pieces sit at.
{
  const { CATEGORY_PRESETS } = await import(
    new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url).href
  );
  const byAngle = new Map();
  for (const tile of CATEGORY_PRESETS.banked) {
    const a = tile.params.bankAngle;
    if (a == null) continue; // wall rides use wallAngle
    if (!byAngle.has(a)) byAngle.set(a, new Set());
    byAngle.get(a).add(tile.base);
  }
  for (const [angle, bases] of [...byAngle].sort((x, y) => x[0] - y[0])) {
    const complete = ["bankin", "bankout", "banktilt", "banked"].every((b) => bases.has(b));
    // 35° is the one-off "Road Tilted" straight and is not meant to be a rung.
    if (angle === 35) { console.log(`  note  ${angle}° is the Road Tilted one-off, not a rung`); continue; }
    ok(complete, `${angle}° has a complete set (up / straight / turn / down)`, [...bases].join(", "));
  }

  // THE SEAM IS IN THE GEOMETRY, NOT THE CONNECTOR, and that distinction is the
  // bank family's whole design. Sockets are LEVEL — position and heading only,
  // never the roll or the raise — so a held-bank piece dropped on a flat
  // connector sits upright exactly as authored. Both pieces' connectors are
  // therefore at y = 0 by construction and checking them proves nothing. What
  // has to line up is the DECK: bank-in's centreline has to arrive at the same
  // height the held piece's sits at, which is bankRaise = (width/2)·sin(angle).
  for (const angle of [12, 22, 38]) {
    const up = build("bankin", { bankRampLength: 40, bankAngle: angle, curveDir: 1 });
    const hold = build("banktilt", { straightLength: 32, bankAngle: angle, curveDir: 1 });
    const down = build("bankout", { bankRampLength: 40, bankAngle: angle, curveDir: 1 });
    const want = (rp.width / 2) * Math.sin(THREE.MathUtils.degToRad(angle));
    const upEnd = up.frames[up.frames.length - 1].pos.y;
    ok(near(upEnd, want, 1e-9), `${angle}°: bank-in's deck arrives at the held raise`,
      `${upEnd.toFixed(6)} vs ${want.toFixed(6)} m`);
    ok(near(hold.frames[0].pos.y, want, 1e-9), `${angle}°: the held piece sits at that raise`,
      `${hold.frames[0].pos.y.toFixed(6)} m`);
    ok(near(down.frames[0].pos.y, want, 1e-9), `${angle}°: bank-out leaves from that raise`,
      `${down.frames[0].pos.y.toFixed(6)} m`);
    ok(near(down.frames[down.frames.length - 1].pos.y, 0, 1e-9), `${angle}°: bank-out settles back to the plane`);
    // And the connectors stay level whatever the angle — that is what lets these
    // be dropped anywhere without rolling the chain.
    for (const [n, p] of [["bank-in", up], ["held", hold], ["bank-out", down]]) {
      const c = readConnector(p.connectorOut);
      ok(near(c.up.y, 1, 1e-9) && near(c.pos.y, 0, 1e-9), `${angle}°: ${n} hands on a level connector`);
    }
  }
}

/* ----------------------------------------------------------------------- */
console.log("\n12. WALL RIDES come back down\n");

// A wall ride ramps up, HOLDS, and ramps back — self-contained, so it chains off
// a flat straight. If the roll does not close, every piece after it is rolled.
for (const [len, ang, ramp] of [[70, 70, 0.38], [34, 70, 0.38], [70, 88, 0.42]]) {
  for (const dir of [1, -1]) {
    const c = readConnector(build("wallride",
      { wallRideLength: len, wallAngle: ang, wallRamp: ramp, curveDir: dir }).connectorOut);
    const tag = `${len} m @ ${ang}° ${dir > 0 ? "R" : "L"}`;
    ok(near(c.up.y, 1, 1e-6), `${tag}: the roll closes back to level`, `up.y=${c.up.y.toFixed(9)}`);
    ok(near(c.pos.z, -len, 1e-6) && near(c.pos.x, 0, 1e-6) && near(c.pos.y, 0, 1e-6),
      `${tag}: exit is straight ahead at the piece's length`);
  }
}
// 88° must still lean INTO the road — at exactly 90 the deck normal has no
// horizontal component and nothing holds the car on.
{
  const p = build("wallride", { wallRideLength: 70, wallAngle: 88, wallRamp: 0.42, curveDir: 1 });
  const mid = p.frames[Math.floor(p.frames.length / 2)];
  const lean = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(mid.up.y, -1, 1)));
  ok(near(lean, 88, 0.5) && mid.up.y > 0.01, "88° wall still has a deck normal to hold the car",
    `lean ${lean.toFixed(2)}°, up.y=${mid.up.y.toFixed(4)}`);
}

/* ----------------------------------------------------------------------- */
console.log("\n13. THE PALETTE IS ONE NAMESPACE, and it is easy to forget\n");

/*
 * A PRESET MAY NOT BE NAMED AFTER A PIECE. roadGame builds the thumbnail bake
 * list as `{key: p.id}` for every piece in PIECE_CATALOG AND `{key: pr.id}` for
 * every preset — one flat list, one key each. So a preset that borrows a piece's
 * id silently pushes two items with the same key into the bake, the sprite map,
 * and the cache signature.
 *
 * CAUGHT THIS WAY: the tube cannon's tile was called `tube_launch`, exactly like
 * the piece it is built on. Nothing failed loudly; it just quietly meant two
 * different tiles were sharing one sprite.
 */
{
  const { CATEGORY_PRESETS } = await import(
    new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url).href
  );
  const { PIECE_CATALOG } = kit;
  const pieceIds = new Set(PIECE_CATALOG.map((p) => p.id));
  const tileIds = new Map();
  const clashes = [];
  const dupes = [];
  let tiles = 0;
  for (const [cat, list] of Object.entries(CATEGORY_PRESETS)) {
    for (const t of list) {
      tiles++;
      if (pieceIds.has(t.id)) clashes.push(`${cat}/${t.id}`);
      if (tileIds.has(t.id)) dupes.push(`${t.id} (${tileIds.get(t.id)} + ${cat})`);
      else tileIds.set(t.id, cat);
      // A tile must resolve to a real piece, or it is a button that throws.
      if (!PIECE_BY_ID.has(t.base)) clashes.push(`${cat}/${t.id} → unknown base ${t.base}`);
    }
  }
  ok(clashes.length === 0, "no preset is named after a piece", clashes.join(", ") || `${tiles} tiles`);
  ok(dupes.length === 0, "no two presets share an id", dupes.join(", ") || `${tileIds.size} unique ids`);

  const bases = new Set(Object.values(CATEGORY_PRESETS).flat().map((t) => t.base));
  const missing = [...bases].filter((id) => !PIECE_BY_ID.has(id));
  ok(missing.length === 0, "every tile's base exists in the kit", missing.join(", ") || `${bases.size} bases used`);

  // PIECE_TO_CATEGORY is module-private, so this one is read as text — the same
  // way paletteWiringTest does it. A piece missing from that map lands in no tab
  // at all, which is invisible while presets cover the tab it should be in.
  const SRC = readFileSync(
    new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url), "utf8",
  );
  const unfiled = [...bases].filter((id) => !new RegExp(`\\b${id}: "`).test(SRC));
  ok(unfiled.length === 0, "every tile's base is filed under a category",
    unfiled.join(", ") || `${bases.size} bases filed`);
}

/* ----------------------------------------------------------------------- */
console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
