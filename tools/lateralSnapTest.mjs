// LATERAL SNAP — does a piece placed on a side socket actually mate?
//
// tools/lateralSnapProbe.mjs answers "which pieces COULD tile" from one piece's
// own geometry. This is the other half: that the socket the BUILDER hands out
// puts a real second piece exactly against the first, in world space, with no
// seam and no overlap.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const kit = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { ModularRoadBuilder } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
const { buildPiece, roadParams, guardrailParams, pieceParams, initialConnector,
  isLaterallyTileable } = kit;

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) fail++;
};

const build = (id, conn) => {
  const def = kit.PIECE_BY_ID.get(id);
  return buildPiece(id, conn, { ...pieceParams, ...(def.params ?? {}) },
    roadParams, guardrailParams, false);
};

/** Lateral-edge vertices of a built piece, in WORLD space. */
function worldEdge(built, sign) {
  const geo = built.geometry;
  const pos = geo.getAttribute("position");
  const lat = geo.getAttribute("aLateral");
  const out = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(lat.getX(i) - sign) > 1e-3) continue;
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(built.world);
    out.push([v.x, v.y, v.z]);
  }
  return out;
}
const key = ([x, y, z]) => `${x.toFixed(3)}|${y.toFixed(3)}|${z.toFixed(3)}`;

// ── 1. THE GEOMETRY CLAIM ──────────────────────────────────────────────────
// A second `straight` placed one width across must have its LEFT edge exactly
// on the first's RIGHT edge.
{
  const A = build("straight", initialConnector());
  const d = A.hw * 2;
  const socket = initialConnector().multiply(new THREE.Matrix4().makeTranslation(d, 0, 0));
  const B = build("straight", socket);

  const right = worldEdge(A, +1).map(key).sort();
  const left = worldEdge(B, -1).map(key).sort();
  check("straight + straight: the seam is exact",
    right.length > 0 && right.length === left.length && right.every((k, i) => k === left[i]),
    `${right.length} verts on each side of the seam, hw=${A.hw}`);
}

// ── 2. MIXED WIDTHS ────────────────────────────────────────────────────────
// `narrow` (hw 4) beside `straight` (hw 8) must sit at the SUM of the two half
// widths. Using twice either one would leave a seam or an overlap.
{
  const A = build("straight", initialConnector());
  const N = build("narrow", initialConnector());
  const d = A.hw + N.hw;
  const socket = initialConnector().multiply(new THREE.Matrix4().makeTranslation(d, 0, 0));
  const B = build("narrow", socket);

  const right = worldEdge(A, +1).map(key).sort();
  const left = worldEdge(B, -1).map(key).sort();
  check("straight + narrow: half-widths sum, no seam",
    right.length > 0 && right.length === left.length && right.every((k, i) => k === left[i]),
    `straight hw=${A.hw}, narrow hw=${N.hw}, offset=${d}`);

  // And the WRONG rule really would fail, so the test above is not vacuous.
  const bad = initialConnector().multiply(new THREE.Matrix4().makeTranslation(A.hw * 2, 0, 0));
  const Bad = build("narrow", bad);
  const badLeft = worldEdge(Bad, -1).map(key).sort();
  check("...and 2*hw would NOT have worked (test is not vacuous)",
    !(badLeft.length === right.length && right.every((k, i) => k === badLeft[i])),
    `2*straight.hw = ${A.hw * 2} vs correct ${d}`);
}

// ── 3. THE BUILDER'S SOCKET MATHS ──────────────────────────────────────────
// Grafted onto the prototype — no scene, no renderer.
{
  const b = Object.create(ModularRoadBuilder.prototype);
  const A = build("straight", initialConnector());
  const piece = { uid: 1, id: "straight", hw: A.hw, connectorIn: initialConnector() };
  b.pieces = [piece];
  b._ghostHw = A.hw;

  const socks = b.lateralSockets(piece);
  check("two side sockets per tileable piece", socks.length === 2,
    socks.map((s) => s.side).join(" + "));

  const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);
  const L = pos(socks.find((s) => s.side === "left").matrix);
  const R = pos(socks.find((s) => s.side === "right").matrix);
  check("sockets sit one full width either side",
    Math.abs(R.x - A.hw * 2) < 1e-9 && Math.abs(L.x + A.hw * 2) < 1e-9,
    `left x=${L.x}, right x=${R.x}, width=${A.hw * 2}`);
  check("sockets keep the piece's heading (a neighbour is PARALLEL)",
    Math.abs(L.z) < 1e-9 && Math.abs(R.z) < 1e-9 && Math.abs(L.y) < 1e-9,
    "no drift along or above the travel direction");

  // A curve must be refused outright.
  const curve = { uid: 2, id: "curve", hw: 8, connectorIn: initialConnector() };
  check("a curve is refused a side socket", b.lateralSockets(curve).length === 0,
    "its two edges are arcs of different radius");
  check("isLaterallyTileable agrees", !isLaterallyTileable("curve") && isLaterallyTileable("jump"));
}

// ── 4. THE RAMP CASE THE FEATURE IS FOR ────────────────────────────────────
for (const id of ["jump", "dive", "crest", "quarterpipe", "slope", "landing"]) {
  const A = build(id, initialConnector());
  const socket = initialConnector().multiply(
    new THREE.Matrix4().makeTranslation(A.hw * 2, 0, 0));
  const B = build(id, socket);
  const right = worldEdge(A, +1).map(key).sort();
  const left = worldEdge(B, -1).map(key).sort();
  check(`mega-ramp: ${id} + ${id} mates`,
    right.length > 0 && right.length === left.length && right.every((k, i) => k === left[i]),
    `${right.length} seam verts`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
