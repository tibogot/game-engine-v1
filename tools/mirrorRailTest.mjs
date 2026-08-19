// The guardrail's reflection, as MIRRORED GEOMETRY.
//
// The bug this exists to prevent has been shipped three times, so it is worth
// stating precisely: on a climbing piece, the reflected rail went DOWN while the
// real rail went UP. Not blurred, not offset — inverted in direction, which no
// amount of fading hides because the eye reads direction before it reads
// sharpness.
//
// Every version that failed shared one assumption: that the road is a plane. A
// mirrored camera flips the world about a single plane fitted under the car, and
// on a slope, a bank or a dip the road has left that plane by metres. So this
// version has no plane in it at all. buildMirroredRailGeometry negates each
// frame's `up`, which reflects every vertex about the deck AT ITS OWN STATION.
//
// What is asserted:
//
//   • vertex-for-vertex, the mirrored rail is the real rail reflected in the
//     local deck — the two are equidistant from the frame's plane, on opposite
//     sides, and identical across the road. That is the whole claim, checked in
//     the only frame where it means anything: the piece's own.
//
//   • on a CLIMBING piece, the mirrored rail climbs too. This is the user-facing
//     symptom, tested directly rather than inferred: a mirror plane would send
//     it downhill, and that is what the plane-based versions did.
//
//   • the same holds on a BANKED piece, where the deck is rolled and "down" for
//     the rail is not world-down at all.
//
//   • it costs the same vertex count as the rail it mirrors, so the reflection
//     pass is one merged mesh and not a second track's worth of geometry.
//
// The kit imports cleanly under node (no DOM, no TSL), so this drives the REAL
// builders rather than a transcription of them.
import * as THREE from "three";

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const { PIECE_BY_ID, pieceParams, computeFrames, applyRoll, roadParams } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { buildRailGeometry, buildMirroredRailGeometry } =
  await import(new URL("../games/modular-road-v3/modularRoadRail.js", import.meta.url).href);

const pp = (extra = {}) => ({ ...pieceParams, ...extra });

/**
 * Frames for a piece id, following buildPiece's own order.
 *
 * The order is the point on a banked piece: the roll is applied AFTER transport,
 * so `up` is the ROLLED up. Skipping applyRoll here would leave the deck level
 * and the bank assertions would pass without testing anything.
 */
function framesFor(id, params) {
  const def = PIECE_BY_ID.get(id);
  if (!def) throw new Error(`no piece "${id}"`);
  const frames = computeFrames(def.points(params), new THREE.Vector3(0, 1, 0));
  if (def.roll) applyRoll(frames, def.roll, params);
  if (def.fixFrames) def.fixFrames(frames, params);
  return frames;
}

function railPair(id, params) {
  const frames = framesFor(id, params);
  return {
    frames,
    real: buildRailGeometry(frames, roadParams),
    mirror: buildMirroredRailGeometry(frames, roadParams),
  };
}

const pos = (g) => g.getAttribute("position");

console.log("— the mirroring itself —");

// A slope: the shape every previous version got backwards.
const slopeId = ["slope", "ramp", "hill", "slopeUp"].find((id) => PIECE_BY_ID.has(id))
  ?? [...PIECE_BY_ID.keys()].find((k) => /slope|ramp|hill/i.test(k));
check("found a climbing piece to test", !!slopeId, slopeId ?? "none in PIECE_BY_ID");

const straight = railPair("straight", pp({ straightLength: 30 }));
check(
  "the mirrored rail exists and matches the real one vertex for vertex",
  !!straight.mirror && pos(straight.mirror).count === pos(straight.real).count,
  `${pos(straight.real).count} vertices`,
);

/**
 * THE CLAIM, checked per vertex, IN ANGLES.
 *
 * For a vertex on frame `f`, the real rail puts it at `f.pos + f.right·lat +
 * f.up·h` and the mirror at the same thing with `−h`. So the vector between the
 * two must point exactly along that frame's `up` — nothing lateral, nothing
 * along the road.
 *
 * Which frame a given vertex came from is an implementation detail of the sweep
 * (and of decimateFrames, which thins them), and every attempt to recover it by
 * nearest-anything is biased: the rail sits 7.6 m to the side, so "nearest
 * station" leans along the road and reports centimetres of error that belong to
 * the search rather than to the mirroring. So this asserts on DIRECTION and
 * calibrates against the piece itself: the separation must line up with one of
 * the frames' ups to within the angle the frames themselves step by. On a piece
 * whose deck rotates at all, no tighter statement is available without
 * reaching into the sweep's internals, and no looser one would have caught
 * either bug this found.
 */
function mirrorErrors({ frames, real, mirror }) {
  const A = pos(real);
  const B = pos(mirror);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const diff = new THREE.Vector3();

  // How fast the deck rotates between adjacent frames — the resolution limit of
  // any frame attribution, and therefore the tolerance.
  let stepDeg = 0;
  for (let i = 1; i < frames.length; i++) {
    stepDeg = Math.max(stepDeg, THREE.MathUtils.radToDeg(frames[i].up.angleTo(frames[i - 1].up)));
  }

  let worstDeg = 0;
  for (let i = 0; i < A.count; i++) {
    a.fromBufferAttribute(A, i);
    b.fromBufferAttribute(B, i);
    diff.subVectors(a, b);
    if (diff.lengthSq() < 1e-10) continue; // a vertex at deck level mirrors to itself
    diff.normalize();
    let bestDeg = Infinity;
    for (const f of frames) {
      const d = THREE.MathUtils.radToDeg(Math.acos(
        Math.min(1, Math.max(-1, diff.dot(f.up))),
      ));
      if (d < bestDeg) bestDeg = d;
    }
    worstDeg = Math.max(worstDeg, bestDeg);
  }
  return { worstDeg, stepDeg };
}

for (const [name, id, params] of [
  ["straight", "straight", pp({ straightLength: 30 })],
  ...(slopeId ? [["slope", slopeId, pp()]] : []),
]) {
  const pair = railPair(id, params);
  if (!pair.mirror) { check(`${name}: has a mirrored rail`, false); continue; }
  const { worstDeg, stepDeg } = mirrorErrors(pair);
  check(
    `${name}: every pair separates along the LOCAL up, not world-up`,
    worstDeg <= Math.max(0.01, stepDeg + 0.01),
    `worst ${worstDeg.toFixed(3)}° vs a ${stepDeg.toFixed(3)}° frame step`,
  );
}

console.log("\n— the symptom: does the reflection climb with the road? —");

/** Mean world height of a geometry, which is all the symptom is about. */
function meanY(g) {
  const P = pos(g);
  let s = 0;
  for (let i = 0; i < P.count; i++) s += P.getY(i);
  return s / P.count;
}

/**
 * How much a geometry gains in world height from one end of the piece to the
 * other — the symptom, stated as a number.
 *
 * Parameterised by distance ALONG THE CENTRELINE TANGENT, not by distance from
 * the piece origin: a rail sits ~7.6 m to the side, so on a 30 m piece nothing
 * is ever within the first fifth of the origin and the first version of this
 * silently binned zero vertices and reported a rise of 0.00 for a ramp.
 */
function rise(g, frames) {
  const P = g.getAttribute("position");
  const o = frames[0].pos;
  const axis = frames[frames.length - 1].pos.clone().sub(o);
  const span = axis.length();
  if (span < 1e-6) return 0;
  axis.divideScalar(span);
  const v = new THREE.Vector3();
  let loSum = 0, loN = 0, hiSum = 0, hiN = 0;
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i).sub(o);
    const t = v.dot(axis) / span;
    if (t < 0.2) { loSum += v.y + o.y; loN++; }
    else if (t > 0.8) { hiSum += v.y + o.y; hiN++; }
  }
  if (!loN || !hiN) return NaN;
  return hiSum / hiN - loSum / loN;
}

if (slopeId) {
  const s = railPair(slopeId, pp());
  const realRise = rise(s.real, s.frames);
  const mirrorRise = rise(s.mirror, s.frames);
  check(
    "the slope actually climbs (otherwise this test proves nothing)",
    Math.abs(realRise) > 0.5,
    `real rail rises ${realRise.toFixed(2)} m`,
  );
  // THE ONE THAT MATTERS. A mirror plane makes these opposite in sign.
  check(
    "the mirrored rail travels the SAME way as the real one",
    Math.sign(mirrorRise) === Math.sign(realRise),
    `real ${realRise.toFixed(2)} m, mirrored ${mirrorRise.toFixed(2)} m`,
  );
  check(
    "...and by very nearly the same amount",
    Math.abs(Math.abs(mirrorRise) - Math.abs(realRise)) < Math.abs(realRise) * 0.25,
    `|real| ${Math.abs(realRise).toFixed(2)} vs |mirrored| ${Math.abs(mirrorRise).toFixed(2)}`,
  );
  check(
    "the mirrored rail sits BELOW the real one",
    meanY(s.mirror) < meanY(s.real),
    `${meanY(s.mirror).toFixed(2)} m vs ${meanY(s.real).toFixed(2)} m`,
  );
}

console.log("\n— banked: 'down' for the rail is not world-down —");

const bankId = [...PIECE_BY_ID.keys()].find((k) => /bank/i.test(k));
if (!bankId) {
  check("found a banked piece", false, "none in PIECE_BY_ID");
} else {
  const b = railPair(bankId, pp());
  if (!b.mirror) {
    check("banked: has a mirrored rail", false);
  } else {
    const { worstDeg, stepDeg } = mirrorErrors(b);
    check(
      "banked: the separation follows the ROLLED up, not world-up",
      worstDeg <= Math.max(0.01, stepDeg + 0.01),
      `worst ${worstDeg.toFixed(3)}° vs a ${stepDeg.toFixed(3)}° frame step`,
    );
    // On a real bank the two rails sit at different heights, so a world-plane
    // mirror cannot put both images where they belong. Confirm the deck is
    // genuinely rolled, or the assertion above is vacuous.
    const up = b.frames[Math.floor(b.frames.length / 2)].up;
    check(
      "banked: the deck really is rolled (otherwise the above is vacuous)",
      up.y < 0.995,
      `mid-piece up·Y = ${up.y.toFixed(4)}`,
    );
  }
}

console.log("\n— cost —");
{
  const s = railPair("straight", pp({ straightLength: 30 }));
  const v = pos(s.mirror).count;
  check(
    "the mirrored rail is no bigger than the rail it mirrors",
    v === pos(s.real).count,
    `${v} vertices per piece — merged into one mesh for the whole track`,
  );
}

console.log(fail ? `\n${fail} FAILED` : "\nmirrored rail reflection is sound");
process.exit(fail ? 1 : 0);
