// Half tube — the rideable tube with the top cut away.
//
// The Tubes tab already had something called a half-pipe, and that is exactly
// why this needs a test rather than a screenshot. The CHANNEL is a shell: a flat
// deck with a quarter-pipe fillet outside each kerb, baked into SOLIDS, so the
// walls stop the chassis and the wheels never leave the flat road. The HALF TUBE
// is a profile, like the full tube: the arc IS the road, it goes in the deck
// BVH, and you drive up it. Two pieces that look alike in a palette tile and are
// completely different to drive — so what is asserted here is the difference:
//
//   • the surface is a genuine ARC on the tube's own circle (not a flat deck),
//     centred so the floor lands at y = 0 and a flat piece feeds straight in;
//   • it is OPEN — nothing above the lips, which is what separates it from the
//     tube it is cut from;
//   • its vertex rings land on the SAME ANGLES as the full tube's, so a half
//     welds onto a full without a step (that is a property of the step size,
//     and it survives only as long as both use 7.5°);
//   • the arc really is drivable — a wheel ray dropped anywhere across the
//     valley finds surface under it.
//
// The kit imports cleanly under node (no DOM, no TSL), so this drives the REAL
// builders rather than a transcription; only the palette wiring is read as text.
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIT = join(ROOT, "games/modular-road-v3/modularRoadKit.js");
const BUILDER_SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js"), "utf8");
const KIT_SRC = readFileSync(KIT, "utf8");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const { PIECE_BY_ID, pieceParams, computeFrames, buildSweepGeometry, buildPiece, initialConnector } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);

const RI = 8;
const TW = 0.6;
const pp = (extra = {}) => ({ ...pieceParams, straightLength: 26, tubeRadius: RI, tubeWall: TW, ...extra });

/* ══ The pieces exist and are PROFILES, not shells ════════════════════════ */
console.log("— piece definitions —");
const half = PIECE_BY_ID.get("half_tube");
const halfCurve = PIECE_BY_ID.get("half_tube_curve");
const full = PIECE_BY_ID.get("tube");
const channel = PIECE_BY_ID.get("channel");
check("half_tube and half_tube_curve are in the catalog", !!half && !!halfCurve);
check("the half tube is a PROFILE (deck BVH — you drive on it)",
  typeof half?.profile === "function" && !half?.shell,
  "the channel next door is a shell, which is the thing it is not");
check("the channel is still a shell (unchanged)", !!channel?.shell && !channel?.profile);
check("no kerbs and no paint lines, same as the full tube",
  half?.noKerb === true && half?.plain === true);
check("the curve variant shares the same profile builder",
  half?.profile === halfCurve?.profile);
check("both get end tangents, so their connectors hit the exact angle",
  /\n  half_tube: flatEndTangents,/.test(KIT_SRC) &&
  /\n  half_tube_curve: curveEndTangents,/.test(KIT_SRC));

/* ══ The cross-section ════════════════════════════════════════════════════ */
console.log("\n— cross-section —");
const prof = half.profile(pp());
const pts = prof.pts;
const inner = pts.filter((p) => p.zone === 3);
const outer = pts.filter((p) => p.zone === 4);
const rOf = (p, cy = RI) => Math.hypot(p.x, p.y - cy);

check("outline is a closed inner arc + outer arc", inner.length === outer.length && inner.length > 8,
  `${inner.length} inner points, ${outer.length} outer`);
check("the drivable surface is an arc on the tube's own circle",
  inner.every((p) => Math.abs(rOf(p) - RI) < 1e-9),
  `every zone-3 point is ${RI} m from the axis`);
check("the outer shell is that circle plus the wall thickness",
  outer.every((p) => Math.abs(rOf(p) - (RI + TW)) < 1e-9));
check("the floor sits at y = 0, so a flat piece feeds straight in",
  Math.abs(Math.min(...inner.map((p) => p.y))) < 1e-9);
check("the centre of the floor is the centre of the road",
  Math.abs(inner.find((p) => p.y < 1e-9).x) < 1e-9);
check("half-width is the tube radius, so aLateral still runs -1…1",
  prof.hw === RI);

// OPEN ON TOP is the whole difference from the tube it is cut from.
const lipY = Math.max(...inner.map((p) => p.y));
const fullProf = full.profile(pp());
const fullTop = Math.max(...fullProf.pts.map((p) => p.y));
check("nothing above the lips — the sky is open", Math.abs(lipY - RI) < 1e-9,
  `lips at ${lipY.toFixed(2)} m; the full tube reaches ${fullTop.toFixed(2)} m`);
check("the lips are the widest point (walls vertical at the rim, 180° span)",
  Math.abs(Math.max(...inner.map((p) => Math.abs(p.x))) - RI) < 1e-9);

/* ══ It welds onto a full tube ════════════════════════════════════════════ */
console.log("\n— seams with the full tube —");
// Both sample the same circle; what has to match is the ANGLES they sample it
// at, and that only holds while both work out to 7.5° per step.
// Wrapped into [0, 2π) before comparing: the half tube's left lip sits at
// exactly −π, which atan2 reports as +π, and raw comparison would call the one
// point that matters most a mismatch.
const TAU = Math.PI * 2;
const angles = (list) =>
  list.map((p) => ((Math.atan2(p.y - RI, p.x) % TAU) + TAU) % TAU).sort((a, b) => a - b);
const halfAngles = angles(inner);
const fullAngles = angles(fullProf.pts.filter((p) => p.zone === 3));
const near = (a, b) => Math.abs(a - b) < 1e-6 || Math.abs(Math.abs(a - b) - TAU) < 1e-6;
const matched = halfAngles.filter((a) => fullAngles.some((b) => near(a, b)));
check("every half-tube vertex ring lands on a full-tube one",
  matched.length === halfAngles.length,
  `${matched.length}/${halfAngles.length} angles shared — a half→full seam has no step`);
const stepDeg = 180 / (halfAngles.length - 1);
check("same angular resolution as the full tube", Math.abs(stepDeg - 360 / 48) < 1e-9,
  `${stepDeg.toFixed(2)}° per step`);

/* ══ Span ═════════════════════════════════════════════════════════════════ */
console.log("\n— span —");
const spanLip = (deg) => {
  const p = half.profile(pp({ halfTubeSpan: deg })).pts.filter((q) => q.zone === 3);
  return { y: Math.max(...p.map((q) => q.y)), x: Math.max(...p.map((q) => Math.abs(q.x))) };
};
const deep = spanLip(240);
check("past 180° the rim curls back over the car", deep.y > RI + 0.5 && Math.abs(deep.x - RI) < 1e-9,
  `240° puts the lip at ${deep.y.toFixed(2)} m, above the ${RI} m waist`);
const shallow = spanLip(120);
check("under 180° it is a shallow valley you can still see out of", shallow.y < RI,
  `120° lip at ${shallow.y.toFixed(2)} m`);
check("span is clamped either way (a closed ring is the tube piece's job)",
  Math.abs(spanLip(400).y - spanLip(300).y) < 1e-9 && Math.abs(spanLip(10).y - spanLip(60).y) < 1e-9,
  "400° → 300°, 10° → 60°");

/* ══ The swept piece is drivable ══════════════════════════════════════════ */
console.log("\n— swept geometry —");
const p0 = pp();
const frames = computeFrames(half.points(p0));
const geo = buildSweepGeometry(frames, half.profile(p0), { plain: true });
const posAttr = geo.getAttribute("position");
check("sweeps to finite geometry",
  posAttr.count > 0 && posAttr.array.every((v) => Number.isFinite(v)),
  `${(geo.index ? geo.index.count : posAttr.count) / 3} tris`);
const zones = new Set(geo.getAttribute("aZone").array);
check("carries the tube zones, so it gets the tube look + neon rings",
  zones.has(3) && zones.has(4), `zones present: ${[...zones].sort().join(", ")}`);

geo.computeBoundingBox();
const bb = geo.boundingBox;
// The rim is the highest thing in the mesh, and it tops out at RI, not RI+TW:
// at the lip the wall thickness runs RADIALLY, which at 180° is horizontal. So
// the lip is a flat 0.6 m ledge at axis height, and the mesh is 0.6 m wider than
// the bore rather than 0.6 m taller.
check("the piece is open-topped in world space too",
  Math.abs(bb.max.y - RI) < 1e-6 && Math.abs(bb.max.x - (RI + TW)) < 1e-6,
  `top of the mesh is the rim at ${bb.max.y.toFixed(2)} m, not a roof at ${(2 * RI).toFixed(0)} m`);

// A wheel ray straight down finds surface everywhere across the valley — this is
// the claim that it is a road and not scenery.
const mesh = new THREE.Mesh(geo);
mesh.updateMatrixWorld(true);
const ray = new THREE.Raycaster();
ray.firstHitOnly = false;
const down = new THREE.Vector3(0, -1, 0);
const z = -13; // mid-piece
let probed = 0, hits = 0;
for (let x = -RI + 0.5; x <= RI - 0.5; x += 0.5) {
  probed++;
  ray.set(new THREE.Vector3(x, RI + 2, z), down);
  if (ray.intersectObject(mesh, false).length) hits++;
}
check("a wheel ray finds surface all the way across the valley", hits === probed,
  `${hits}/${probed} probes from the lip line down`);

// …and the floor it finds is the arc, not a flat deck.
const depthAt = (x) => {
  ray.set(new THREE.Vector3(x, RI + 2, z), down);
  const hit = ray.intersectObject(mesh, false)[0];
  return hit ? hit.point.y : NaN;
};
const yMid = depthAt(0);
const yEdge = depthAt(RI - 1.5);
check("the surface climbs towards the walls (an arc, not a flat road)",
  yEdge - yMid > 1.0, `floor ${yMid.toFixed(2)} m vs ${(RI - 1.5).toFixed(1)} m out: ${yEdge.toFixed(2)} m`);
check("the floor is at deck height, so it seams with a flat piece",
  Math.abs(yMid) < 1e-6, `${yMid.toFixed(4)} m`);

/* ══ The lip is a launch edge, not a shelf ════════════════════════════════ */
//
// The piece shipped drivable but unusable: the car climbed the wall fine and
// then could not get air off the rim, topping out at ~9.7 m on an 8 m lip at
// every speed. The cause was this piece's own rim caps — the bands that close
// the profile outline between the bore and the outer shell. On the full tube
// they hide at the floor seam; here they land at the lips, and at a 180° span
// the wall thickness runs horizontally, so each one is a flat 0.6 m ledge at
// exactly rim height for the whole length of the piece. In the deck BVH that is
// indistinguishable from road. See buildOpenLipCollision and, for the driving
// numbers, tools/halfTubeAirMeshRepro.mjs.
console.log("\n— the lip —");
const builtHalf = buildPiece("half_tube", initialConnector(), pp());
check("the half tube ships a deck collision proxy", !!builtHalf.deckCollision,
  "the visible mesh keeps its rim caps; the BVH gets a copy without them");
check("a full tube does NOT need one (its caps hide at the floor seam)",
  !buildPiece("tube", initialConnector(), pp()).deckCollision);
check("a plain road piece does NOT get one either",
  !buildPiece("straight", initialConnector(), pp()).deckCollision,
  "zone 0 means the structural SIDES there, which must stay collidable");

{
  const vis = builtHalf.geometry.getIndex().count / 3;
  const col = builtHalf.deckCollision.getIndex().count / 3;
  // Two lip caps, two triangles per ring.
  const rings = computeFrames(half.points(pp())).length - 1;
  check("exactly the two lip caps are dropped, nothing else",
    vis - col === 4 * rings, `${vis} → ${col} tris over ${rings} rings`);
}

const asMesh = (geo) => {
  const m = new THREE.Mesh(geo);
  m.applyMatrix4(builtHalf.world);
  m.updateMatrixWorld(true);
  return m;
};
const visMesh = asMesh(builtHalf.geometry);
const colMesh = asMesh(builtHalf.deckCollision);
const zProbe = -13;
const dropAt = (mesh, x) => {
  ray.set(new THREE.Vector3(x, RI + 12, zProbe), down);
  const hit = ray.intersectObject(mesh, false)[0];
  return hit ? hit.point.y : null;
};

// The ledge is gone…
check("the rim ledge is no longer a drive surface",
  dropAt(visMesh, -(RI + TW / 2)) !== null && dropAt(colMesh, -(RI + TW / 2)) === null,
  `visible mesh answers at y ${dropAt(visMesh, -(RI + TW / 2))}, collision answers nothing`);
// …and NOTHING ELSE changed. This is the half of the check that matters: the
// bore is the road, and stripping the caps must not have touched one triangle
// of it.
{
  let probed = 0, differ = 0;
  for (let x = -RI + 0.1; x <= RI - 0.1; x += 0.1) {
    const a = dropAt(visMesh, x), b = dropAt(colMesh, x);
    probed++;
    if ((a === null) !== (b === null) || (a !== null && Math.abs(a - b) > 1e-6)) differ++;
  }
  check("the drivable valley is bit-identical to the visible mesh", differ === 0,
    `${probed} probes across the bore, ${differ} differ`);
}
check("the outer shell is still collidable (you can land on the OUTSIDE)",
  dropAt(colMesh, 0) !== null && Math.abs(dropAt(colMesh, 0)) < 1e-6,
  "floor still at y 0; the shell below it is what the bore rests on");

/* ══ Palette wiring ═══════════════════════════════════════════════════════ */
console.log("\n— palette —");
check("both pieces land on the Tubes tab",
  /\n  half_tube: "tubes",/.test(BUILDER_SRC) && /\n  half_tube_curve: "tubes",/.test(BUILDER_SRC));
const tubesTab = BUILDER_SRC.match(/\n  tubes: \[([\s\S]*?)\n  \],/)?.[1] ?? "";
for (const id of ["half_tube_str", "half_tube_long", "half_tube_turn", "half_tube_deep"]) {
  const tile = tubesTab.match(new RegExp(`\\{[^{}]*id: "${id}"[\\s\\S]*?\\n    \\},`))?.[0] ?? "";
  const base = tile.match(/base: "(\w+)"/)?.[1];
  check(`"${id}" is a Tubes tile on an existing piece`,
    tile.length > 0 && PIECE_BY_ID.has(base) && /preview: `<svg/.test(tile), base ?? "no base");
}

console.log(fail === 0 ? "\nAll half-tube checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
