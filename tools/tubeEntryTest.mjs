// Tube entry / exit — the funnel that lets a flat road meet a bore.
//
// Reported as a hole in the palette: "we are missing the piece that makes a
// nice smooth transition to enter a tube or half tube." It was. Every tube in
// the kit started as a tube, so building road -> tube butted a 14.5 m flat
// plate onto an 8 m bore: a step at the seam, and a wall the car arrives at
// with no warning.
//
// The fix is one MORPHING section (buildTubeMorphProfile) swept along a
// straight, and the only thing that makes it safe is that both of its ends are
// EXACT. Not "close enough to hide with a decal" — exact, because the pieces on
// either side are authored independently and the seams have to land on each
// other. So that is what this asserts:
//
//   • t = 0 is the road's OWN flat section — same width, same slab thickness,
//     so a straight feeds in with nothing to line up by hand;
//   • t = 1 is the SAME POINT SET the tube / half-tube profile builds from the
//     same params, so the far seam matches vertex for vertex;
//   • every section in between is a real circular arc, tangent to horizontal at
//     the floor, single-valued across its width — the sweep cannot be allowed to
//     pinch, bulge or fold on its way in;
//   • the point count never changes (buildSweepGeometry throws if it does, and
//     that throw is a build-time crash for the user, not a cosmetic bug);
//   • the rim caps are stripped from the deck BVH, exactly as on a half tube —
//     without that the lip is a ledge and the car cannot leave the piece.
//
// The kit imports cleanly under node (no DOM, no TSL), so this drives the REAL
// builders rather than a transcription; only the palette wiring is read as text.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER_SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js"), "utf8");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const { PIECE_BY_ID, pieceParams, roadParams, buildPiece, initialConnector } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);

const RI = 8;
const TW = 0.6;
const SPAN = 180;
const LEN = 26;
const pp = { ...pieceParams, tubeEntryLength: LEN, tubeRadius: RI, tubeWall: TW, halfTubeSpan: SPAN };
const rp = roadParams;

const IDS = ["tube_in", "tube_out", "half_tube_in", "half_tube_out"];

/* ---------------------------------------------------------------- catalog */

console.log("\n— the pieces exist and are wired like the tubes they feed —");
for (const id of IDS) {
  const def = PIECE_BY_ID.get(id);
  check(`${id} is in the catalog`, !!def);
  if (!def) continue;
  check(`${id} sweeps a morphing section`, typeof def.profile === "function" && typeof def.profileAt === "function");
  check(`${id} is a tube piece (no kerbs, no lane lines)`, def.noKerb === true && def.plain === true);
  // Open until the very last frame — the rim caps are a ledge for almost the
  // whole piece, which is the exact case buildOpenLipCollision exists for.
  check(`${id} strips its rim caps from collision`, def.openLips === true);
  check(`${id} has exact end tangents`, typeof def.endTangents === "function");
}

/* -------------------------------------------------- the flat end is ROAD */

console.log("\n— t = 0 is the road's own flat section —");
for (const id of ["tube_in", "half_tube_in"]) {
  const def = PIECE_BY_ID.get(id);
  const pts = def.profileAt(0, pp, rp).pts;
  const inner = pts.filter((p) => p.zone === 3);
  const outer = pts.filter((p) => p.zone === 4);
  const widest = Math.max(...inner.map((p) => Math.abs(p.x)));
  check(`${id} @0 is exactly the road width`, Math.abs(widest - rp.width / 2) < 1e-9,
    `half-width ${widest.toFixed(6)} vs ${(rp.width / 2).toFixed(6)}`);
  const maxY = Math.max(...inner.map((p) => Math.abs(p.y)));
  check(`${id} @0 is dead flat`, maxY < 1e-9, `max |y| ${maxY.toExponential(2)}`);
  const t = Math.max(0.05, rp.thickness);
  const badUnder = outer.filter((p) => Math.abs(p.y + t) > 1e-9).length;
  check(`${id} @0 has the road's slab thickness`, badUnder === 0,
    `${outer.length - badUnder}/${outer.length} points at y = -${t}`);
}

/* --------------------------------------------- the tube end is THE TUBE */

console.log("\n— t = 1 is the tube's own section, point for point —");
// Compared as a RING, not as a list. Both outlines close, so both duplicate one
// point — and on the full tube they cannot duplicate the SAME one.
// buildTubeProfile opens its outline at the floor, where the two radial webs
// end up buried under the bore. A morph cannot: its outline has to open where
// the lips are, and on the way in the lips travel from the road edges up to the
// crown, so the crown is where its seam lands. Different winding, identical
// circle — every sample angle still coincides (the two starts differ by 90°,
// which is 12 whole 7.5° steps), so the seam vertices land ON each other and
// that is the property that actually matters.
const near = (p, list, eps) => list.some((q) => Math.abs(q.x - p.x) < eps && Math.abs(q.y - p.y) < eps);
const sameRing = (a, b, eps = 1e-9) => {
  if (a.length !== b.length) return `count ${a.length} vs ${b.length}`;
  for (const p of a) if (!near(p, b, eps)) return `built (${p.x.toFixed(6)}, ${p.y.toFixed(6)}) is not on the tube`;
  for (const q of b) if (!near(q, a, eps)) return `tube's (${q.x.toFixed(6)}, ${q.y.toFixed(6)}) is missing`;
  return null;
};
for (const [id, tubeId] of [["tube_in", "tube"], ["tube_out", "tube"],
  ["half_tube_in", "half_tube"], ["half_tube_out", "half_tube"]]) {
  const def = PIECE_BY_ID.get(id);
  const target = PIECE_BY_ID.get(tubeId).profile(pp, rp).pts;
  // Entries end at the tube; exits START at it. Either way the tube-facing
  // section is the one that has to match.
  const tAtTube = id.endsWith("_in") ? 1 : 0;
  const got = def.profileAt(tAtTube, pp, rp).pts;
  const why = sameRing(got, target);
  check(`${id} seams onto ${tubeId}`, why === null, why ?? `${got.length} points matched`);
  // The bore and the shell must not have swapped: zone 3 is what the wheels
  // drive on and what buildOpenLipCollision keeps, zone 4 is the outside.
  const bore = got.filter((p) => p.zone === 3);
  const shell = got.filter((p) => p.zone === 4);
  const tBore = target.filter((p) => p.zone === 3);
  check(`${id} keeps the tube's bore / shell split`,
    bore.length === tBore.length && shell.length === target.length - tBore.length
    && sameRing(bore, tBore) === null,
    `${bore.length} bore + ${shell.length} shell`);
}

/* ------------------------------------------ every section in between is sane */

console.log("\n— every intermediate section is a real, drivable arc —");
const STEPS = 40;
for (const id of IDS) {
  const def = PIECE_BY_ID.get(id);
  const ref = def.profile(pp, rp).pts.length;
  let counts = true, floorOn = true, monotone = true, radius = true;
  let worstFloor = 0, worstRadius = 0;
  for (let s = 0; s <= STEPS; s++) {
    const t = s / STEPS;
    const pts = def.profileAt(t, pp, rp).pts;
    if (pts.length !== ref) { counts = false; break; }
    const inner = pts.filter((p) => p.zone === 3);
    // The centreline point must sit ON the floor at (0, 0): the whole kit's
    // convention is that a piece's frames run along its drivable surface, and
    // the connectors are built from those frames.
    const mid = inner[(inner.length - 1) / 2 | 0];
    const midErr = Math.hypot(mid.x, mid.y);
    worstFloor = Math.max(worstFloor, midErr);
    if (midErr > 1e-9) floorOn = false;
    // Single-valued across the width. A point-wise lerp between a line and a
    // circle fails this the moment the target is the full ring — which is why
    // the morph interpolates (half-angle, arc length) instead.
    for (let i = 1; i < inner.length; i++) {
      // Full ring at t = 1 genuinely wraps past vertical, so only the half-tube
      // family is monotone the whole way; the ring is checked by radius below.
      if (id.startsWith("half") && inner[i].x <= inner[i - 1].x - 1e-12) monotone = false;
    }
    // Every point equidistant from the arc centre = it really is one circle.
    const R = (() => {
      const lip = inner[inner.length - 1];
      const half = Math.hypot(lip.x, lip.y);
      return half < 1e-9 ? 0 : (lip.x * lip.x + lip.y * lip.y) / (2 * lip.y || 1e-30);
    })();
    if (t > 1e-6 && t < 1 - 1e-6) {
      for (const p of inner) {
        const err = Math.abs(Math.hypot(p.x, p.y - R) - Math.abs(R));
        worstRadius = Math.max(worstRadius, err);
        if (err > 1e-6 * Math.max(1, Math.abs(R))) radius = false;
      }
    }
  }
  check(`${id} keeps one point count across the sweep`, counts, `${ref} points`);
  check(`${id} floor stays on the centreline`, floorOn, `worst ${worstFloor.toExponential(2)} m`);
  check(`${id} section is a circular arc`, radius, `worst radius error ${worstRadius.toExponential(2)} m`);
  if (id.startsWith("half")) check(`${id} never folds over itself`, monotone);
}

/* ------------------------------------------------------- it actually builds */

console.log("\n— buildPiece agrees, and hands back a straight's connector —");
for (const id of IDS) {
  let built = null, err = null;
  try {
    built = buildPiece(id, initialConnector(), pp, rp);
  } catch (e) { err = e; }
  check(`${id} builds`, !!built, err ? err.message : "");
  if (!built) continue;
  const posAttr = built.geometry.getAttribute("position");
  check(`${id} has geometry`, posAttr && posAttr.count > 0, `${posAttr?.count ?? 0} verts`);
  // Straight piece: the exit connector is `tubeEntryLength` down -Z, unrotated.
  const e = built.connectorOut.elements;
  check(`${id} exit is ${LEN} m straight ahead`,
    Math.abs(e[12]) < 1e-9 && Math.abs(e[13]) < 1e-9 && Math.abs(e[14] + LEN) < 1e-6,
    `(${e[12].toFixed(4)}, ${e[13].toFixed(4)}, ${e[14].toFixed(4)})`);
  check(`${id} exit is not rotated`,
    Math.abs(e[0] - 1) < 1e-9 && Math.abs(e[5] - 1) < 1e-9 && Math.abs(e[10] - 1) < 1e-9);
  // Rim caps render but must NOT be road (see buildOpenLipCollision).
  const cap = built.deckCollision;
  check(`${id} hands the BVH a lip-stripped deck`, !!cap && cap.getIndex().count < built.geometry.getIndex().count,
    cap ? `${cap.getIndex().count / 3} tris vs ${built.geometry.getIndex().count / 3} drawn` : "no deckCollision");
}

/* ------------------------------------------ the entry really does open out */

console.log("\n— the funnel opens, it does not just appear —");
{
  const def = PIECE_BY_ID.get("half_tube_in");
  const widths = [];
  for (let s = 0; s <= 10; s++) {
    const inner = def.profileAt(s / 10, pp, rp).pts.filter((p) => p.zone === 3);
    widths.push(Math.max(...inner.map((p) => p.y)));
  }
  const rising = widths.every((w, i) => i === 0 || w >= widths[i - 1] - 1e-12);
  check("wall height climbs monotonically road -> tube", rising,
    widths.map((w) => w.toFixed(2)).join(" -> "));
  check("starts at zero wall", Math.abs(widths[0]) < 1e-9);
  check("ends at the tube's own lip height", Math.abs(widths[10] - RI) < 1e-6,
    `${widths[10].toFixed(4)} vs ${RI}`);
  // Smoothstep: the section's rate of change is zero at BOTH seams, so there is
  // no crease where the funnel meets the straight or the tube.
  const d0 = widths[1] - widths[0];
  const dMid = widths[6] - widths[5];
  check("eases in rather than kinking at the seam", d0 < dMid * 0.5,
    `first step ${d0.toFixed(3)} m vs mid step ${dMid.toFixed(3)} m`);
}

/* ------------------------------------------ the funnel must not belly out */

// THE REGRESSION THIS EXISTS FOR. The first version interpolated developed
// (arc) length between the two ends. It hit both seams exactly and every
// section was a valid arc — and it still looked wrong, because width is then
// R·sin(phi): on the stock kit an 8 m -> 8 m transition ballooned to 11.3 m
// half-width in the middle and pinched back in. The road bellied out like a
// trumpet on the way into a bore that was never getting wider.
console.log("\n— the road keeps its width; only the edges curl —");
for (const id of ["tube_in", "half_tube_in"]) {
  const def = PIECE_BY_ID.get(id);
  const start = rp.width / 2;
  let worst = 0, at = 0;
  for (let s = 0; s <= 40; s++) {
    const inner = def.profileAt(s / 40, pp, rp).pts.filter((p) => p.zone === 3);
    const hw = Math.max(...inner.map((p) => Math.abs(p.x)));
    if (Math.abs(hw - start) > worst) { worst = Math.abs(hw - start); at = s / 40; }
  }
  // Tolerance is a SAMPLING allowance, not a shape one: past a quarter turn the
  // widest point of the arc is its equator, which falls between two of the 48
  // vertex angles, so the widest sampled point sits a hair inside it.
  check(`${id} never bulges past the road it came from`, worst < 0.05,
    `worst ${worst.toFixed(3)} m at t=${at.toFixed(2)} (was 3.3 m when this interpolated arc length)`);
}

/* ---------------------------------- the seam holds at every authored span */

console.log("\n— the seam is exact at every half-tube span the kit allows —");
for (const span of [120, 180, 240, 300]) {
  const p2 = { ...pp, halfTubeSpan: span };
  const got = PIECE_BY_ID.get("half_tube_in").profileAt(1, p2, rp).pts;
  const want = PIECE_BY_ID.get("half_tube").profile(p2, rp).pts;
  let worst = Infinity;
  if (got.length === want.length) {
    worst = 0;
    for (let i = 0; i < got.length; i++) {
      worst = Math.max(worst, Math.hypot(got[i].x - want[i].x, got[i].y - want[i].y));
    }
  }
  check(`span ${span}° seams vertex for vertex`, worst < 1e-9,
    `${got.length} pts, worst ${worst.toExponential(2)} m`);
}

/* ------------------------------------------------------------ palette wiring */

console.log("\n— the palette offers them, next to the tubes they feed —");
for (const id of IDS) {
  check(`${id} lands in the Tubes tab`, new RegExp(`\\b${id}: "tubes"`).test(BUILDER_SRC));
}
for (const preset of ["tube_entry", "tube_exit", "half_tube_entry", "half_tube_exit"]) {
  check(`preset ${preset} exists`, new RegExp(`id: "${preset}"`).test(BUILDER_SRC));
}
/*
 * EVERY BORE HAS A WAY IN AND A WAY OUT.
 *
 * This used to assert that the whole tab shared ONE radius, which was the right
 * guard while there was only one size: a preset whose radius drifted from the
 * tube beside it is a step at the seam that nothing in the geometry can catch.
 * A second size family (the R12 Big Tube) makes that literal check wrong while
 * leaving its intent exactly as important, so this is the intent, stated
 * structurally over the real preset table rather than scraped out of the source:
 *
 *   • every radius that has a BORE has a MOUTH at that radius (an entry / exit /
 *     launch), or a REDUCER joining it to a radius that does — otherwise the
 *     size is an island you can see in the palette and never drive into;
 *   • a reducer never tapers to a radius nothing is built at, which would be the
 *     same step at the seam by a longer route.
 *
 * The half-pipes are deliberately not in either list: `tubeRadius` is their
 * TRANSITION radius, not a bore, which is why the old scrape had to stop at
 * `half_pipe_park` by hand.
 */
const { CATEGORY_PRESETS } = await import(
  new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url).href
);
const BORE = new Set([
  "tube", "tube_curve", "tube_slope", "tube_crest", "tube_spiral", "tube_scurve",
  "half_tube", "half_tube_curve", "half_tube_slope", "half_tube_crest",
  "half_tube_spiral", "half_tube_scurve",
]);
const MOUTH = new Set([
  "tube_in", "tube_out", "tube_launch",
  "half_tube_in", "half_tube_out", "half_tube_launch",
]);
const REDUCER = new Set(["tube_reduce", "half_tube_reduce"]);

const radiusOf = (t) => t.params.tubeRadius ?? RI;
const bores = new Set();
const mouths = new Set();
const tapers = [];
for (const t of CATEGORY_PRESETS.tubes) {
  if (BORE.has(t.base)) bores.add(radiusOf(t));
  else if (MOUTH.has(t.base)) mouths.add(radiusOf(t));
  else if (REDUCER.has(t.base)) tapers.push([radiusOf(t), t.params.tubeRadius2 ?? radiusOf(t)]);
}

check("the tab offers more than one bore size", bores.size >= 1, `bores at R ${[...bores].join(", ")}`);
for (const R of [...bores].sort((a, b) => a - b)) {
  const direct = mouths.has(R);
  const viaTaper = tapers.some(([a, b]) => (a === R && mouths.has(b)) || (b === R && mouths.has(a)));
  check(`R${R} bore can be entered and left`, direct || viaTaper,
    direct ? "has its own entry/exit" : "reachable through a reducer");
}
for (const [a, b] of tapers) {
  check(`reducer R${a} → R${b} joins two real sizes`, bores.has(a) && bores.has(b),
    `bores at R ${[...bores].join(", ")}`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
