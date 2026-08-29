// WHICH PIECES CAN SIT SIDE BY SIDE?
//
// Lateral snapping places a copy of a piece one deck-width across. For that to
// produce a genuinely WIDER ROAD, two independent things must hold.
//
//  1. THE EDGES MATE. `aLateral` is x / halfWidth, so the left edge is
//     aLateral = -1 and the right is +1, and the question is whether
//         leftEdgeVerts + (W, 0, 0)  ==  rightEdgeVerts   (as point sets)
//     with W the PIECE's own width (2 * halfWidth), not the global road width —
//     `narrow` is 8 m and `platform` is wider, and using one global number
//     failed them for the wrong reason.
//     True for a straight slab: both edges are parallel lines W apart. False
//     for a curve, whose edges are arcs of radius R-hw and R+hw, so a lateral
//     copy opens a wedge that grows along the arc.
//
//  2. THE DECK CONTINUES. Mating edges alone is not enough. A full tube's
//     widest points are its bore equator, which also sits at aLateral = ±1, so
//     two tubes "mate" — by touching along a tangent line, with two separate
//     bores and nothing drivable between them. So the drivable deck (zone 1)
//     must actually reach the lateral edge, facing up.
//
// Zones: 0 side/underside, 1 deck, 2 rail, 3/4 tube inner/outer.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
register("../threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const kit = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { PIECE_CATALOG, buildPiece, roadParams, guardrailParams, pieceParams, initialConnector,
  LATERAL_TILEABLE } = kit;

const key = (x, y, z) => `${x.toFixed(3)}|${y.toFixed(3)}|${z.toFixed(3)}`;

function edgeInfo(geo, sign) {
  const pos = geo.getAttribute("position");
  const lat = geo.getAttribute("aLateral");
  const zone = geo.getAttribute("aZone");
  const nrm = geo.getAttribute("normal");
  if (!pos || !lat) return null;
  const verts = [];
  let deckUp = false;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(lat.getX(i) - sign) > 1e-3) continue;
    verts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
    // Deck reaching the edge, facing up (within ~60 deg of +Y).
    if (zone && nrm && zone.getX(i) === 1 && nrm.getY(i) > 0.5) deckUp = true;
  }
  return { verts, deckUp };
}

const rows = [];
for (const def of PIECE_CATALOG) {
  const pp = { ...pieceParams, ...(def.params ?? {}) };
  let built;
  try {
    built = buildPiece(def.id, initialConnector(), pp, roadParams, guardrailParams, false);
  } catch (e) {
    rows.push({ id: def.id, verdict: "ERR", note: e.message.slice(0, 46) }); continue;
  }
  const geo = built.geometry;
  if (!geo) { rows.push({ id: def.id, verdict: "ERR", note: "no geometry" }); continue; }
  const L = edgeInfo(geo, -1), R = edgeInfo(geo, +1);
  if (!L || !R || !L.verts.length || !R.verts.length) {
    rows.push({ id: def.id, verdict: "NO", note: "no lateral edges (custom plate)" }); continue;
  }

  // The piece's OWN width, straight off its two edges.
  const avg = (a, i) => a.reduce((s, v) => s + v[i], 0) / a.length;
  const W = avg(R.verts, 0) - avg(L.verts, 0);

  const rightSet = new Set(R.verts.map(([x, y, z]) => key(x, y, z)));
  let matched = 0, worst = 0;
  for (const [x, y, z] of L.verts) {
    if (rightSet.has(key(x + W, y, z))) { matched++; continue; }
    let best = Infinity;
    for (const [rx, ry, rz] of R.verts) {
      const d = Math.hypot(rx - (x + W), ry - y, rz - z);
      if (d < best) best = d;
    }
    worst = Math.max(worst, best);
  }
  const mates = matched === L.verts.length;
  const deck = L.deckUp && R.deckUp;
  rows.push({
    id: def.id,
    verdict: mates && deck ? "YES" : mates ? "TOUCHES" : "NO",
    W: W.toFixed(1),
    note: mates
      ? (deck ? `${matched} verts mate, deck continues` : "edges touch but NO drivable deck at the edge")
      : `max gap ${worst.toFixed(2)} m`,
  });
}

// ── VERDICT vs THE SHIPPED LIST ────────────────────────────────────────────
// The kit's LATERAL_TILEABLE decides what the builder will offer a side socket
// on. It is a hand-written list, so it can drift away from the geometry the
// moment a profile changes — this is the check that catches that.
const measured = new Set(rows.filter((r) => r.verdict === "YES").map((r) => r.id));
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) fail++;
};

const missing = [...measured].filter((id) => !LATERAL_TILEABLE.has(id));
const extra = [...LATERAL_TILEABLE].filter((id) => !measured.has(id));
check("every tileable piece is listed in LATERAL_TILEABLE", missing.length === 0,
  missing.length ? `not listed: ${missing.join(", ")}` : `${measured.size} pieces`);
check("nothing listed that does not actually tile", extra.length === 0,
  extra.length ? `listed but does NOT tile: ${extra.join(", ")}` : "");

const touches = rows.filter((r) => r.verdict === "TOUCHES").map((r) => r.id);
check("edges-touch-only pieces stay OUT of the list",
  touches.every((id) => !LATERAL_TILEABLE.has(id)),
  touches.join(", "));

const show = (title, v) => {
  const list = rows.filter((r) => r.verdict === v);
  console.log(`\n${title} (${list.length})`);
  for (const r of list) console.log("  ", r.id.padEnd(19), `w=${String(r.W ?? "?").padStart(5)}`, r.note);
};
show("TILEABLE — a real wider road", "YES");
show("EDGES MEET BUT NOT A WIDER SURFACE — should be blocked", "TOUCHES");
show("NOT TILEABLE", "NO");
show("COULD NOT BUILD", "ERR");
console.log(`\ntotal ${rows.length} pieces`);
console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
