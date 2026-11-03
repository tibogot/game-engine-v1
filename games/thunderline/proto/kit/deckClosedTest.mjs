// EVERY ROAD DECK IS A CLOSED SOLID, FACING OUT (2026-11-03): the road material is drawn ONE-SIDED (oldLook.js), so a
// hole or a flipped face in a piece would show as a see-through gap in the game. For every piece of the kit, both rail
// settings: its deck + its end lids + its fixed lids (a point's tip), welded at 1 mm, must have no open edge, no edge
// shared by more than two faces, every edge walked once each way (one winding) and a positive volume (faces out).
// Tubes and half-pipes (their own double-sided material: open ends that cover a road's) and the glass road's drawn
// deck (its window cut out: mats.roadOpen, double-sided) are not road-material solids.
//   node games/thunderline/proto/kit/deckClosedTest.mjs
import { TILES } from "./kit.js";
import { buildOldLook } from "./oldLook.js";

function closed(geos) {
  const key = new Map(), P = [], tris = [];
  for (const g of geos) {
    const pos = g.getAttribute("position"), ix = g.index ? g.index.array : null, n = ix ? ix.length : pos.count;
    const id = (i) => {
      const k = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
      let v = key.get(k);
      if (v === undefined) { v = P.length; key.set(k, v); P.push([pos.getX(i), pos.getY(i), pos.getZ(i)]); }
      return v;
    };
    for (let t = 0; t < n; t += 3) {
      const a = id(ix ? ix[t] : t), b = id(ix ? ix[t + 1] : t + 1), c = id(ix ? ix[t + 2] : t + 2);
      if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
    }
  }
  const edges = new Map();
  for (const [a, b, c] of tris) for (const [u, v] of [[a, b], [b, c], [c, a]]) {
    const k = u < v ? `${u}_${v}` : `${v}_${u}`, e = edges.get(k) ?? { n: 0, d: 0 };
    e.n++; e.d += u < v ? 1 : -1; edges.set(k, e);
  }
  let open = 0, nonManifold = 0, flipped = 0;
  for (const e of edges.values()) { if (e.n === 1) open++; else if (e.n > 2) nonManifold++; else if (e.d !== 0) flipped++; }
  let vol = 0;
  for (const [a, b, c] of tris) { const [A, B, C] = [P[a], P[b], P[c]]; vol += (A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6; }
  return { open, nonManifold, flipped, vol };
}

let checked = 0;
const bad = [];
for (const [id, t] of Object.entries(TILES)) {
  if (t.tube || t.halfpipe) continue;
  for (const edges of [true, false]) {
    const look = buildOldLook(t, edges);
    const r = closed([look.deck, ...(look.ends ?? []).map((e) => e.geo).filter(Boolean), look.capsFixed].filter(Boolean));
    checked++;
    if (r.open || r.nonManifold || r.flipped || !(r.vol > 0)) bad.push(`${id} rails=${edges}: open ${r.open}, non-manifold ${r.nonManifold}, flipped ${r.flipped}, volume ${r.vol.toFixed(1)}`);
    if (t.customLook) break; // (the old kit's pieces: rails don't change the deck)
  }
}
if (bad.length) { console.error(`FAIL: ${bad.length} of ${checked} road decks are not closed solids facing out (the road is one-sided):\n  ${bad.join("\n  ")}`); process.exit(1); }
console.log(`OK: all ${checked} road decks (every piece, both rail settings) are closed solids facing out`);
