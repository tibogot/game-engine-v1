/**
 * Headless checks for the modular-road guardrail (games/modular-road-v3/modularRoadRail.js).
 *
 * Two of the failure modes here are SILENT, which is why this exists:
 * mergeGeometries returns null when indexed and non-indexed geometry are mixed
 * (empty rail, no error), and a section whose winding disagrees with its
 * supplied normals shades inside-out rather than disappearing.
 *
 *   node tools/labGuardrailTest.mjs
 */
import * as THREE from "three";
import {
  decimateFrames,
  railParams, railProfile, sweepRail, buildPostTemplate, placePosts, buildRailCollision,
  buildRailGeometry, straightFrames, signedArea,
} from "../games/modular-road-v3/modularRoadRail.js";

const lab = {
  railParams, railProfile, sweepRail, buildPostTemplate, placePosts, buildRailCollision,
  buildRailGeometry, straightFrames, signedArea,
};

const RAIL = { ...railParams, style: 3 };
const RP = { width: 16, thickness: 0.8, railWidth: 0.5, railHeight: 0.22, segLen: 1.6 };

/**
 * buildLabRails now takes a PIECE's own transport frames rather than a length,
 * so the rail follows whatever centreline the kit generated. The curved fixture
 * is the point of that change: a straight sweep can hide sign and winding bugs
 * that only show up once `right` and `tangent` actually rotate along the piece.
 */
const FRAMES = lab.straightFrames(32, RP.segLen);

function curvedFrames(radius, angleDeg, steps = 48) {
  const out = [];
  const total = (angleDeg * Math.PI) / 180;
  for (let i = 0; i <= steps; i++) {
    const a = total * (i / steps);
    const pos = new THREE.Vector3(radius - Math.cos(a) * radius, 0, -Math.sin(a) * radius);
    const tangent = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(tangent, up).normalize();
    out.push({ pos, tangent, up, right });
  }
  return out;
}
const CURVED = curvedFrames(26, 90);

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const note = (msg) => console.log(`     ${msg}`);

/* ── 1. the 2-D section ─────────────────────────────────────────────────── */

/** Even-odd point-in-polygon in the (z, y) plane. */
function inside(pts, y, z) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if ((a.y > y) !== (b.y > y) && z < ((b.z - a.z) * (y - a.y)) / (b.y - a.y) + a.z) c = !c;
  }
  return c;
}

function segmentsCross(a, b, c, d) {
  const cr = (p, q, r) => (q.z - p.z) * (r.y - p.y) - (q.y - p.y) * (r.z - p.z);
  return ((cr(c, d, a) > 0) !== (cr(c, d, b) > 0)) && ((cr(a, b, c) > 0) !== (cr(a, b, d) > 0));
}

console.log("— section —");
const SECTIONS = [
  ["thrie (default)", { ...RAIL, humps: 3, flip: false }],
  ["W-beam", { ...RAIL, humps: 2, flip: false }],
  ["box beam", { ...RAIL, humps: 1, flip: false }],
  ["field-facing", { ...RAIL, humps: 3, flip: true }],
  // deeper than it is tall — the bull-nose radius has to clamp
  ["squat + deep", { ...RAIL, height: 0.3, depth: 0.45, valleyGap: 0.6, plateau: 0.45, bendRadius: 0.12, bendSeg: 8, beadSeg: 20, humps: 3, flip: false }],
  ["no bend, no flat", { ...RAIL, valleyGap: 0.05, plateau: 0, bendRadius: 0, bendSeg: 1, beadSeg: 3, humps: 3, flip: false }],
  ["flat back", { ...RAIL, backAmp: 0, humps: 3, flip: false }],
  // asks for more back relief than the wall thickness allows — must clamp, not
  // let the two faces cross
  ["over-relieved back", { ...RAIL, backAmp: 1.5, humps: 3, flip: false }],
  ["thin wall", { ...RAIL, valleyGap: 0.06, backAmp: 0.5, humps: 3, flip: false }],
];

for (const [name, opts] of SECTIONS) {
  const p = lab.railProfile({ ...opts });
  const pts = p.pts;
  const n = pts.length;
  const bad = [];

  if (pts.some((q) => !Number.isFinite(q.y) || !Number.isFinite(q.z))) bad.push("NaN point");
  if (p.normals.some((q) => !Number.isFinite(q.y) || !Number.isFinite(q.z))) bad.push("NaN normal");
  if (lab.signedArea(pts) <= 0) bad.push("ring is not CCW");

  let crossings = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) crossings++;
    }
  }
  if (crossings) bad.push(`${crossings} self-intersections`);

  // Step off each segment along its own normal: out must leave the solid, in
  // must stay inside it. A centroid test would be useless — a corrugation
  // valley legitimately faces back toward the middle of the section.
  const eps = 2e-4;
  let intoSolid = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b.y - a.y, b.z - a.z) || 1;
    const ny = -(b.z - a.z) / l;
    const nz = (b.y - a.y) / l;
    const my = (a.y + b.y) * 0.5;
    const mz = (a.z + b.z) * 0.5;
    if (inside(pts, my + ny * eps, mz + nz * eps)) intoSolid++;
    else if (!inside(pts, my - ny * eps, mz - nz * eps)) intoSolid++;
  }
  if (intoSolid) bad.push(`${intoSolid}/${n} segment normals point into the solid`);

  for (let i = 0; i < n && !bad.some((s) => s.startsWith("vertex")); i++) {
    for (const k of [(i - 1 + n) % n, i]) {
      const a = pts[k];
      const b = pts[(k + 1) % n];
      const l = Math.hypot(b.y - a.y, b.z - a.z) || 1;
      const dot = p.normals[i].y * (-(b.z - a.z) / l) + p.normals[i].z * ((b.y - a.y) / l);
      if (dot <= 0) bad.push(`vertex normal ${i} disagrees with its segment`);
    }
  }

  const h = Math.max(...pts.map((q) => q.y)) - Math.min(...pts.map((q) => q.y));
  const d = Math.max(...pts.map((q) => q.z)) - Math.min(...pts.map((q) => q.z));
  const wantD = Math.min(opts.depth, opts.height * 0.9);
  if (Math.abs(h - opts.height) > 1e-6) bad.push(`height ${h.toFixed(4)} != ${opts.height}`);
  if (Math.abs(d - wantD) > 1e-6) bad.push(`depth ${d.toFixed(4)} != ${wantD}`);
  if (Math.abs(p.depth - wantD) > 1e-9) bad.push("reported depth disagrees with the ring");

  const wantValleys = Math.max(0, opts.humps - 1);
  if (p.valleys.length !== wantValleys) bad.push(`${p.valleys.length} valleys, want ${wantValleys}`);
  for (const v of p.valleys) {
    if (Math.abs(v.z) > wantD * 0.5 + 1e-9 || Math.abs(v.y) > opts.height * 0.5) {
      bad.push("a bolt valley lies outside the section");
    }
  }

  check(bad.length === 0, `${name.padEnd(17)} pts=${String(n).padStart(3)} valleys=${p.valleys.length} h=${h.toFixed(3)} d=${d.toFixed(3)}`);
  for (const b of bad) note(b);
}

/* ── 2. the swept shell ─────────────────────────────────────────────────── */

console.log("\n— shell —");
const prof = lab.railProfile({ ...RAIL, humps: RAIL.style, flip: RAIL.flipW });
const centerV = RP.railHeight + RAIL.gap + RAIL.height * 0.5;

// Edges are keyed by rounded POSITION, not vertex index: the sweep duplicates
// the seam column and the caps carry their own hard-normal copies of the ring,
// so an index-keyed test would report a shell that is geometrically watertight
// as wide open.
for (const [shape, frames] of [["straight", FRAMES], ["curved", CURVED]]) {
for (const zSign of [1, -1]) {
  const beam = lab.sweepRail(frames, prof, 7.75 * zSign, zSign, centerV);
  const idx = beam.index.array;
  const pos = beam.attributes.position.array;
  const key = (v) => {
    const q = (x) => Math.round(x * 1e5);
    return `${q(pos[v * 3])},${q(pos[v * 3 + 1])},${q(pos[v * 3 + 2])}`;
  };
  const edges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const u = key(idx[t + a]);
      const v = key(idx[t + b]);
      const k = u < v ? `${u}|${v}` : `${v}|${u}`;
      const e = edges.get(k) ?? { fwd: 0, rev: 0 };
      if (u < v) e.fwd++;
      else e.rev++;
      edges.set(k, e);
    }
  }
  let unpaired = 0;
  let inconsistent = 0;
  for (const e of edges.values()) {
    if (e.fwd + e.rev !== 2) unpaired++;
    else if (e.fwd !== 1 || e.rev !== 1) inconsistent++;
  }
  check(unpaired === 0, `${shape} zSign=${zSign} closed shell (${unpaired} unpaired edges)`);
  check(inconsistent === 0, `${shape} zSign=${zSign} consistent winding (${inconsistent} flipped)`);
  beam.dispose();
}
}

/* ── 2b. the end caps ───────────────────────────────────────────────────── */
//
// A centroid fan shipped here first and it is WRONG: the section is strongly
// non-convex (corrugated front, relieved back, two bull-noses), so it is not
// star-shaped about its centroid and the fan throws triangles straight across
// the valleys — on screen, a bulging knot of crossing facets at the rail's end.
// Total triangle area is the invariant that catches it: a correct triangulation
// sums to exactly the polygon's area, while an overlapping fan sums to more.
console.log("\n— end caps —");
for (const [name, humps] of [["thrie", 3], ["W-beam", 2], ["box", 1]]) {
  const p = lab.railProfile({ ...RAIL, humps, flip: false });
  const tris = THREE.ShapeUtils.triangulateShape(
    p.pts.map((q) => new THREE.Vector2(q.z, q.y)), [],
  );
  const polyArea = Math.abs(lab.signedArea(p.pts));
  let triArea = 0;
  let degenerate = 0;
  for (const [a, b, c] of tris) {
    const A = p.pts[a];
    const B = p.pts[b];
    const C = p.pts[c];
    const cross = (B.z - A.z) * (C.y - A.y) - (B.y - A.y) * (C.z - A.z);
    triArea += Math.abs(cross) * 0.5;
    if (Math.abs(cross) < 1e-12) degenerate++;
  }
  check(
    tris.length === p.pts.length - 2,
    `${name}: ${tris.length} triangles for ${p.pts.length} points (want n−2)`,
  );
  check(
    Math.abs(triArea - polyArea) < polyArea * 1e-3,
    `${name}: triangles cover the section exactly ` +
    `(${triArea.toFixed(5)} vs ${polyArea.toFixed(5)} m²)`,
  );
  check(degenerate === 0, `${name}: no zero-area triangles (${degenerate})`);
}

/* ── 3. post hardware ───────────────────────────────────────────────────── */

console.log("\n— posts —");
const tpl = lab.buildPostTemplate(prof, RAIL, RP.railHeight, centerV);
check(tpl != null, "post template merges (indexed + non-indexed mix)");
const box = new THREE.Box3().setFromBufferAttribute(tpl.attributes.position);
note(
  `template x[${box.min.x.toFixed(3)}, ${box.max.x.toFixed(3)}] ` +
  `y[${box.min.y.toFixed(3)}, ${box.max.y.toFixed(3)}]`,
);
const beamTop = centerV + prof.height * 0.5;
check(box.min.x > -prof.depth * 0.5, "nothing pokes out through the traffic face");
check(box.max.x > prof.backZ, "hardware reaches past the beam onto the field side");
check(box.min.y >= RP.railHeight - 1e-6, "nothing dips below the kerb top");
check(
  Math.abs(box.max.y - (beamTop + RAIL.postRise)) < 1e-3,
  `post top = beam top + rise (${box.max.y.toFixed(3)} vs ${(beamTop + RAIL.postRise).toFixed(3)})`,
);

// The post has to STAND on the kerb. There is no ground beside a floating road
// piece, so anything past the kerb's outer edge is visibly in mid-air — which is
// exactly what shipped first: 78% of the base plate hung off. Checked across
// kerb widths because railWidth is saved into every track file, so old saves
// bring their own narrow kerb back and the clamp is what has to catch it.
console.log("\n— posts stand on the kerb —");
for (const railWidth of [0.35, 0.5, 0.75, 1.2]) {
  const hw = RP.width / 2;
  const rw = Math.min(Math.max(0, railWidth), hw * 0.45);
  const kerbHalf = rw * 0.5;
  const tpl2 = lab.buildPostTemplate(prof, RAIL, RP.railHeight, centerV, kerbHalf);
  // Only what actually TOUCHES DOWN. The blockout and the bolts live up at beam
  // height (~1.2 m) and are supposed to overhang — measuring the whole
  // template's width flags them and hides the real question.
  const pos = tpl2.attributes.position;
  const footTop = RP.railHeight + 0.15;
  let worst = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) <= footTop) worst = Math.max(worst, Math.abs(pos.getX(i)));
  }
  check(
    worst <= kerbHalf + 1e-6,
    `kerb ${railWidth.toFixed(2)} m: footprint reaches ${worst.toFixed(3)} m ` +
    `of ${kerbHalf.toFixed(3)} m available`,
  );
  tpl2.dispose();
}

// Posts must sit ON the polyline the beam was swept along.
//
// They did not: the beam swept decimated frames (chords that cut the corner)
// while posts were placed on the piece's true arc, so on a curve they drifted
// apart — and asymmetrically, because the chord always moves toward the centre
// of curvature while posts sit outboard. Measured on an R14 150° hairpin before
// the fix: 4.4 cm on the inner rail, 1.3 cm on the outer. One side visibly
// detached from its rail, the other looked fine.
console.log("\n— posts meet the beam —");
{
  const arc = curvedFrames(14, 150, 101); // the hairpin that showed it
  const swept = decimateFrames(arc, railParams.frameStep, railParams.frameAngle);
  // A POINT-SIZED template, so the placed geometry's centre IS the anchor.
  // The real post is a poor probe: it stands ~0.22 m outboard and rotates with
  // its frame, so its bounding-box centre wanders by more than the defect.
  const probe = new THREE.BoxGeometry(0.004, 0.004, 0.004);

  /** Furthest any post anchor strays from the polyline the beam was swept on. */
  const strayFrom = (postFrames, side) => {
    const baseLat = side * 7.625;
    const out = [];
    lab.placePosts(postFrames, probe, baseLat, side, RAIL.postSpacing, out);
    const chord = swept.map((f) => f.pos.clone().addScaledVector(f.right, baseLat));
    let worst = 0;
    for (const g of out) {
      g.computeBoundingBox();
      const c = g.boundingBox.getCenter(new THREE.Vector3());
      let best = Infinity;
      for (let i = 0; i < chord.length - 1; i++) {
        const a = chord[i];
        const ab = chord[i + 1].clone().sub(a);
        const t = Math.max(0, Math.min(1, c.clone().sub(a).dot(ab) / ab.lengthSq()));
        best = Math.min(best, c.distanceTo(a.clone().addScaledVector(ab, t)));
      }
      worst = Math.max(worst, best);
      g.dispose();
    }
    return worst;
  };

  let worstBug = 0;
  for (const [name, side] of [["inner", -1], ["outer", 1]]) {
    const now = strayFrom(swept, side);
    worstBug = Math.max(worstBug, strayFrom(arc, side)); // posts on the true arc
    check(now < 0.001, `${name} rail: anchors sit on the beam (${(now * 1000).toFixed(2)} mm)`);
  }
  // Proves the check above has teeth. Asymmetric by nature — the chord always
  // cuts toward the centre of curvature — so it is the worse side that matters.
  check(
    worstBug > 0.01,
    `the old placement still fails it (worst side ${(worstBug * 1000).toFixed(1)} mm)`,
  );
  probe.dispose();
}

for (const [len, spacing] of [[32, 2.8], [32, 6], [12, 2.8]]) {
  const out = [];
  lab.placePosts(lab.straightFrames(len, RP.segLen), tpl, 7.75, 1, spacing, out);
  const want = Math.max(2, Math.round(len / spacing) + 1);
  check(out.length === want, `${len} m @ ${spacing} m spacing → ${out.length} posts (want ${want})`);
  for (const g of out) g.dispose();
}

/* ── 3b. the collision proxy ────────────────────────────────────────────── */
//
// The car must hit the rail it can SEE. These were two independent parameter
// sets before (proxy beam 0.1 m deep against the visible 0.26), so the chassis
// stopped 8 cm short of the barrier and sank into it. The proxy is now derived
// from the same profile, and this is what holds that.
console.log("\n— collision proxy —");
{
  const RPW = { ...RP, railWidth: 0.75 };
  const vis = lab.buildRailGeometry(FRAMES, RPW, railParams);
  const col = buildRailCollision(FRAMES, RPW, railParams);
  check(col != null, "proxy builds");

  const cb = new THREE.Box3().setFromBufferAttribute(col.attributes.position);
  const vt = Math.round(vis.index.count / 3);
  const ct = Math.round(col.index.count / 3);
  note(`${ct} tris vs ${vt} visible (${(vt / ct).toFixed(1)}× lighter), was 696`);

  // The face the car meets is the INNERMOST surface of the right-hand rail, so
  // it has to be measured per side — a bounding box over both rails reports the
  // outboard posts and says nothing about where the car stops.
  const innerFace = (geo) => {
    const p = geo.attributes.position;
    let m = Infinity;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      if (x > 0) m = Math.min(m, x); // right-hand rail only
    }
    return m;
  };
  check(
    Math.abs(innerFace(vis) - innerFace(col)) < 0.002,
    `traffic face aligned (visible ${innerFace(vis).toFixed(3)} vs proxy ${innerFace(col).toFixed(3)})`,
  );

  // Against the BEAM top, not the visible rail's highest point: posts stand
  // `postRise` proud of the beam, and 6 cm nubs every 3.6 m are pure snag risk
  // in a collision mesh for nothing a driver would ever feel.
  const beamTop = RPW.railHeight + railParams.gap + railParams.height;
  check(
    Math.abs(cb.max.y - beamTop) < 0.002,
    `capped at the beam top (proxy ${cb.max.y.toFixed(3)} vs beam ${beamTop.toFixed(3)})`,
  );
  check(
    cb.min.y >= RPW.railHeight - 1e-6,
    `nothing below the kerb top (${cb.min.y.toFixed(3)} ≥ ${RPW.railHeight})`,
  );
  check(ct < vt / 10, `at least 10× cheaper than the visible rail (${(vt / ct).toFixed(1)}×)`);

  // Slab, not a sheet: thick enough that a 50 m/s substep cannot step through.
  let rMin = Infinity, rMax = -Infinity;
  {
    const p = col.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      if (x > 0) { rMin = Math.min(rMin, x); rMax = Math.max(rMax, x); }
    }
  }
  check(rMax - rMin >= 0.37, `slab thickness ${(rMax - rMin).toFixed(3)} m (≥ 0.38)`);

  // No floor: a horizontal triangle at the kerb is what closest-point uses to
  // throw the car up once a sample is overlapping. The section is an open U.
  const pos = col.attributes.position;
  const idx = col.index;
  let floorTris = 0;
  let flatOnTop = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const ys = [0, 1, 2].map((k) => pos.getY(idx.getX(i + k)));
    if (ys.every((y) => y < RPW.railHeight + 1e-4)) floorTris++;
    if (ys.every((y) => y > cb.max.y - 1e-4)) flatOnTop++;
  }
  check(floorTris === 0, `no floor at the kerb (${floorTris} level triangles)`);
  check(flatOnTop === 0, `no flat plateau at the ridge (${flatOnTop} level triangles)`);

  vis.dispose();
  col.dispose();
}

/* ── 4. every toggle still builds ───────────────────────────────────────── */

console.log("\n— variants —");
const whole = lab.buildRailGeometry(FRAMES, RP, RAIL);
check(whole != null, "default rail builds");
if (whole) {
  note(`${whole.attributes.position.count} verts / ${Math.round(whole.index.count / 3)} tris`);
  const nrm = whole.attributes.normal.array;
  let badN = 0;
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]);
    if (!Number.isFinite(l) || Math.abs(l - 1) > 0.02) badN++;
  }
  check(badN === 0, `all normals unit length (${badN} bad)`);
  whole.dispose();
}

for (const style of [1, 2, 3]) {
  for (const flipW of [false, true]) {
    for (const mirrorSides of [false, true]) {
      const g = lab.buildRailGeometry(FRAMES, RP, { ...RAIL, style, flipW, mirrorSides });
      check(g != null && g.index.count > 0, `style=${style} flip=${flipW} mirror=${mirrorSides}`);
      g?.dispose();
    }
  }
}
for (const key of ["posts", "bolts", "basePlate"]) {
  const g = lab.buildRailGeometry(FRAMES, RP, { ...RAIL, [key]: false });
  check(g != null && g.index.count > 0, `${key} off`);
  g?.dispose();
}

// On a curve the rail must actually BEND — a sweep that quietly ignored the
// frames' rotation would still build, still be watertight, and still be wrong.
const curved = lab.buildRailGeometry(CURVED, RP, RAIL);
check(curved != null, "curved rail builds");
if (curved) {
  const b = new THREE.Box3().setFromBufferAttribute(curved.attributes.position);
  const size = b.getSize(new THREE.Vector3());
  note(`curved bounds ${size.x.toFixed(1)} × ${size.z.toFixed(1)} m`);
  // A 90° arc of R=26 spans ~26 m each way; a straight sweep would be ~16 m
  // wide (deck width) by 32 m long.
  check(size.x > 24 && size.z > 24, "rail follows the arc in both axes");
  check(
    Math.abs(size.x - size.z) < 6,
    `arc is roughly square in plan (${size.x.toFixed(1)} vs ${size.z.toFixed(1)})`,
  );
  curved.dispose();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall guardrail checks pass");
process.exit(failed ? 1 : 0);
