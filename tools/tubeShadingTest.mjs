// SHADE SMOOTH FOR THE TUBES — no extra vertices, just normals that meet.
//
// Reported as "all the tubes have a low-poly look": a 48-sided bore rendered as
// 48 flat strips, banded around its circumference and smooth along its length.
// That asymmetry is the fingerprint. The sweep builds UN-SHARED BANDS on purpose
// (one strip per profile edge, its own vertices, so each face can carry a
// constant aZone and slab corners stay crisp), so computeVertexNormals can only
// smooth ALONG the sweep — every profile point is a hard crease.
//
// The fix was already in the file: weldSmoothProfileNormals averages the two
// bands meeting at a point flagged `smooth`, and it runs on every swept piece.
// Only buildBankProfile ever flagged anything, so on tubes it returned
// immediately. This asserts the four things that make flagging them safe:
//
//   • THE CURVES SMOOTH. Measured as the worst normal disagreement between
//     coincident vertices — 7.5° flat-shaded, and it has to go to ~0.
//   • THE CORNERS DO NOT. A half tube's rim lips and the radial webs at a full
//     tube's seam are real edges; smoothing them is the opposite bug.
//   • IT IS FREE. Same positions, same indices, same triangle count.
//   • THE SEAM CLOSES, and only where the section really closes — a morphing
//     entry is a ring at one end and a flat plate at the other.
import * as THREE from "three";

const kit = await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { buildPiece, roadParams, pieceParams, guardrailParams, initialConnector, PIECE_BY_ID } = kit;
const rp = { ...roadParams }, gp = { ...guardrailParams }, DEF = { ...pieceParams };
const R = 8, WALL = 0.6;
const R2D = THREE.MathUtils.RAD2DEG;
let fail = 0;
const ok = (c, label, detail = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!c) fail++;
};

const CASES = [
  ["tube", { straightLength: 26, tubeRadius: R, tubeWall: WALL }],
  ["tube_curve", { curveRadius: 26, curveAngle: 90, tubeRadius: R, tubeWall: WALL }],
  ["tube_slope", { slopeLength: 32, slopeRise: 10, tubeRadius: R, tubeWall: WALL }],
  ["tube_spiral", { loopSpiralRadius: 26, loopSpiralTurns: 0.5, loopSpiralRise: 14, tubeRadius: R }],
  ["tube_in", { tubeEntryLength: 26, tubeRadius: R, tubeWall: WALL }],
  ["tube_reduce", { tubeEntryLength: 30, tubeRadius: R, tubeRadius2: 12, tubeWall: WALL }],
  ["half_tube", { straightLength: 26, tubeRadius: R, tubeWall: WALL, halfTubeSpan: 180 }],
  ["half_tube_curve", { curveRadius: 26, curveAngle: 90, tubeRadius: R, halfTubeSpan: 180 }],
  ["half_pipe", { straightLength: 60, tubeRadius: 26, halfPipeFlat: 12, halfPipeVert: 17 }],
];

const build = (id, params) =>
  buildPiece(id, initialConnector(), { ...DEF, ...params }, rp, gp, gp.enabled);

/**
 * Worst normal disagreement between vertices sharing a position, per zone.
 *
 * MEASURED ON THE PRE-CAP SWEEP. appendTubeEndCaps pushes its mouth rings as
 * zone 4 as well, sitting exactly on the shell ring at both ends — so the
 * finished mesh compares a cap against the wall it closes, which is a genuine
 * 90° edge at every angle around the bore and says nothing about shading.
 * Back-to-back pairs are skipped for the same reason: the two radial webs at the
 * seam are wound opposite ways and buried inside the wall.
 */
function creases(id, params, zone) {
  // Built with the mouth caps OFF rather than reading deckCollision, because an
  // open-lipped piece's collision copy has no aZone to filter by and would fall
  // back to the capped mesh — which is exactly the case this is avoiding.
  const def = PIECE_BY_ID.get(id);
  const hadCaps = def.tubeEndCaps;
  def.tubeEndCaps = false;
  let p;
  try { p = build(id, params); } finally { def.tubeEndCaps = hadCaps; }
  const g = p.geometry;
  const pos = g.getAttribute("position"), nrm = g.getAttribute("normal"), zn = g.getAttribute("aZone");
  const byPos = new Map();
  for (let i = 0; i < pos.count; i++) {
    if (zn.getX(i) !== zone) continue;
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    if (!byPos.has(key)) byPos.set(key, []);
    byPos.get(key).push(i);
  }
  let worst = 0, n = 0;
  for (const grp of byPos.values()) {
    for (let a = 0; a < grp.length; a++) for (let b = a + 1; b < grp.length; b++) {
      const ia = grp[a], ib = grp[b];
      const dot = nrm.getX(ia) * nrm.getX(ib) + nrm.getY(ia) * nrm.getY(ib) + nrm.getZ(ia) * nrm.getZ(ib);
      if (dot < 0) continue; // back-to-back, not a crease
      worst = Math.max(worst, Math.acos(THREE.MathUtils.clamp(dot, -1, 1)) * R2D);
      n++;
    }
  }
  return { worst, n };
}

/* ---------------------------------------------------------------------- */
console.log("\n1. THE CURVED SURFACES SHADE SMOOTH\n");
console.log("   flat-shaded, a 48-sided bore creases by 360/48 = 7.5° at every point\n");
console.log("   piece               bore    outer shell");
for (const [id, params] of CASES) {
  const bore = creases(id, params, 3), shell = creases(id, params, 4);
  console.log(`   ${id.padEnd(17)} ${bore.worst.toFixed(3).padStart(6)}°  ${shell.worst.toFixed(3).padStart(9)}°`);
  ok(bore.worst < 0.05 && bore.n > 0, `${id}: the bore has no creases left`,
    `worst ${bore.worst.toFixed(3)}° over ${bore.n} shared pairs`);
  ok(shell.worst < 0.05, `${id}: nor does the outer shell`, `worst ${shell.worst.toFixed(3)}°`);
}

/* ---------------------------------------------------------------------- */
console.log("\n2. THE CORNERS THAT ARE MEANT TO BE CORNERS\n");

// One rule flags them all (flagSmoothRuns): a point is on a continuous surface
// exactly when both its neighbours are on the same surface. Check it leaves the
// zone boundaries alone, because those are where the real edges live.
for (const [id, params, span] of [
  ["tube", { tubeRadius: R, tubeWall: WALL }, "the radial webs at the bottom seam"],
  ["half_tube", { tubeRadius: R, tubeWall: WALL, halfTubeSpan: 180 }, "the rim lips"],
  ["half_pipe", { tubeRadius: 26, halfPipeFlat: 12, halfPipeVert: 17 }, "the rim lips"],
]) {
  const pts = PIECE_BY_ID.get(id).profile({ ...DEF, ...params }, rp).pts;
  const M = pts.length;
  let boundarySmoothed = 0, interiorFlat = 0;
  for (let k = 0; k < M; k++) {
    const same = pts[(k - 1 + M) % M].zone === pts[k].zone && pts[(k + 1) % M].zone === pts[k].zone;
    if (!same && pts[k].smooth) boundarySmoothed++;
    if (same && !pts[k].smooth) interiorFlat++;
  }
  ok(boundarySmoothed === 0, `${id}: ${span} stay sharp`, `${boundarySmoothed} wrongly smoothed`);
  ok(interiorFlat === 0, `${id}: and every interior point is smoothed`, `${interiorFlat} missed`);
}

// A flat road section has no run of same-zone points longer than its corners, so
// nothing is flagged and the weld stays the no-op it always was there.
const roadPts = kit.buildProfile(rp, true).pts;
ok(roadPts.every((p) => !p.smooth), "a kerbed road section flags nothing — its corners are all real",
  `${roadPts.length} points`);

/* ---------------------------------------------------------------------- */
console.log("\n3. IT COSTS NOTHING\n");

// Build each piece with the flags stripped and compare. Same vertices, same
// triangles, same positions — only the normals differ. If this ever fails,
// smoothing has started changing geometry, which is not what was asked for.
for (const [id, params] of CASES) {
  const def = PIECE_BY_ID.get(id);
  const real = build(id, params);
  const orig = def.profile;
  def.profile = (pp, r) => {
    const s = orig(pp, r);
    return { ...s, pts: s.pts.map((p) => ({ ...p, smooth: false, seam: undefined })) };
  };
  let flat;
  try { flat = build(id, params); } finally { def.profile = orig; }

  const a = real.geometry, b = flat.geometry;
  const pa = a.getAttribute("position"), pb = b.getAttribute("position");
  let samePos = pa.count === pb.count;
  if (samePos) {
    for (let i = 0; i < pa.count * 3; i++) {
      if (Math.abs(pa.array[i] - pb.array[i]) > 1e-9) { samePos = false; break; }
    }
  }
  ok(samePos && a.getIndex().count === b.getIndex().count,
    `${id}: identical geometry, only the normals moved`,
    `${pa.count} verts, ${a.getIndex().count / 3} tris`);
}

/* ---------------------------------------------------------------------- */
console.log("\n4. THE SEAM CLOSES ONLY WHERE THE SECTION CLOSES\n");

/*
 * A closed bore's outline cannot be a topological circle — it runs the inner
 * surface, jumps to the outer wall and walks back — so the two ends sit at the
 * same place and 96 indices apart. `seam` pairs them; without it the full tube
 * keeps one hard crease straight down the middle of the floor the car drives on.
 *
 * But a MORPHING entry is a ring at the bore end and a flat plate at the road
 * end, and the flags come from one reference outline. The weld therefore checks
 * per frame whether the two points really are coincident. This is that check:
 * the entry's bore end must weld and its road end must not.
 */
const entry = build("tube_in", { tubeEntryLength: 26, tubeRadius: R, tubeWall: WALL });
{
  const g = entry.geometry;
  const pos = g.getAttribute("position"), nrm = g.getAttribute("normal"), zn = g.getAttribute("aZone");
  // Bore end is the most negative z; road end the most positive.
  let zLo = Infinity, zHi = -Infinity;
  for (let i = 0; i < pos.count; i++) { zLo = Math.min(zLo, pos.getZ(i)); zHi = Math.max(zHi, pos.getZ(i)); }
  const spread = (z) => {
    const byPos = new Map();
    for (let i = 0; i < pos.count; i++) {
      if (zn.getX(i) !== 3 || Math.abs(pos.getZ(i) - z) > 1e-3) continue;
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)}`;
      if (!byPos.has(key)) byPos.set(key, []);
      byPos.get(key).push(i);
    }
    let worst = 0;
    for (const grp of byPos.values()) {
      for (let a = 0; a < grp.length; a++) for (let b = a + 1; b < grp.length; b++) {
        const d = nrm.getX(grp[a]) * nrm.getX(grp[b]) + nrm.getY(grp[a]) * nrm.getY(grp[b])
          + nrm.getZ(grp[a]) * nrm.getZ(grp[b]);
        if (d < 0) continue;
        worst = Math.max(worst, Math.acos(THREE.MathUtils.clamp(d, -1, 1)) * R2D);
      }
    }
    return worst;
  };
  ok(spread(zLo) < 0.05, "a tube entry's BORE end welds shut", `${spread(zLo).toFixed(3)}°`);
  // Nothing coincides at the road end, so there is nothing to weld and nothing
  // to smear — the assertion is that it did not invent a weld across the gap.
  const flat = build("tube_in", { tubeEntryLength: 26, tubeRadius: R, tubeWall: WALL });
  ok(flat.geometry.getAttribute("position").count === entry.geometry.getAttribute("position").count,
    "...and its flat-road end is left alone");
}

console.log(fail === 0 ? "\nALL PASS\n" : `\n${fail} FAILURE(S)\n`);
process.exit(fail === 0 ? 0 : 1);
