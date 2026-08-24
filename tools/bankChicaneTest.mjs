// THE BANKED CHICANE — one piece where there used to be a flat spot.
//
// Getting from a right-hand banked turn to a left-hand one meant Bank down →
// Bank up: settle the lean to nothing, drive a stretch of LEVEL ROAD, then roll
// it up the other way. Two pieces, twice the length, and a flat spot in the
// middle of what should read as one continuous change of direction.
//
// `bankswap` does it as one motion. The things that decide whether that is real:
//
//   • IT ACTUALLY REMOVES THE FLAT. Measured as how far the car travels on
//     near-level deck, chicane vs the two-piece alternative. This is the point.
//   • THE ENDS STILL SEAM. Same easing, same raise, same level sockets as the
//     transitions it replaces — or every chicane grows a crease at both joins.
//   • NO KINK AT THE CROSSOVER. The naive centreline (raise following |lean|)
//     puts a corner exactly where the piece exists to be smooth. This measures
//     that corner, so the choice not to use it is on the record rather than in
//     a comment.
import * as THREE from "three";

const kit = await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { buildPiece, roadParams, pieceParams, guardrailParams, initialConnector, PIECE_BY_ID } = kit;
const { CATEGORY_PRESETS } = await import(
  new URL("../games/modular-road-v3/modularRoadBuilder.js", import.meta.url).href);

const rp = { ...roadParams }, gp = { ...guardrailParams }, DEF = { ...pieceParams };
let fail = 0;
const ok = (c, label, detail = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!c) fail++;
};
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const R2D = THREE.MathUtils.RAD2DEG;

const build = (id, params) =>
  buildPiece(id, initialConnector(), { ...DEF, ...params }, rp, gp, gp.enabled);
/** Deck lean at a frame, in degrees, signed. */
const leanOf = (f) => R2D * Math.atan2(f.up.x, f.up.y);

/* ---------------------------------------------------------------------- */
console.log("\n1. IT SWAPS THE LEAN, EXACTLY\n");

for (const angle of [12, 22, 38]) {
  for (const dir of [1, -1]) {
    const p = build("bankswap", { bankRampLength: 44, bankAngle: angle, curveDir: dir });
    const f = p.frames;
    const a = leanOf(f[0]), b = leanOf(f[f.length - 1]);
    ok(near(a, dir * angle, 1e-6) && near(b, -dir * angle, 1e-6),
      `${angle}° ${dir > 0 ? "R→L" : "L→R"}: enters at ${(dir * angle)}° and leaves at ${(-dir * angle)}°`,
      `${a.toFixed(4)}° → ${b.toFixed(4)}°`);
    /*
     * It has to cross zero once, and only once — a chicane that wobbled back
     * would be flat twice.
     *
     * COUNT SIGN FLIPS BETWEEN NON-ZERO STATIONS. With an even station count
     * one frame lands exactly on lean = 0, where Math.sign returns 0 and a naive
     * comparison sees TWO changes (+→0, 0→−). That is a property of where the
     * stations happen to fall, not of the piece: it showed up at 12° and 22° and
     * not at 38°, purely because the steeper tile earns an odd station count.
     */
    let crossings = 0, last = 0;
    for (const fr of f) {
      const s = Math.sign(leanOf(fr));
      if (s === 0) continue;
      if (last !== 0 && s !== last) crossings++;
      last = s;
    }
    ok(crossings === 1, `${angle}° ${dir > 0 ? "R→L" : "L→R"}: crosses flat exactly once`,
      `${f.length} stations`);
  }
}

/* ---------------------------------------------------------------------- */
console.log("\n2. THE FLAT SPOT IT EXISTS TO REMOVE\n");

/**
 * How far you travel on deck that is within `tol` degrees of level.
 *
 * The two-piece alternative is Bank down (22°→0) then Bank up (0→22° the other
 * way), and the flat is not just the seam between them — it is the whole tail of
 * one piece and the whole nose of the next, because `smoother` eases the roll
 * rate to zero at the ends. That easing is right for meeting a straight and
 * wrong for meeting another transition.
 */
function flatRun(pieces, tol = 3) {
  let dist = 0;
  for (const { id, params } of pieces) {
    const f = build(id, params).frames;
    for (let i = 1; i < f.length; i++) {
      const lean = 0.5 * (Math.abs(leanOf(f[i])) + Math.abs(leanOf(f[i - 1])));
      if (lean < tol) dist += f[i].pos.distanceTo(f[i - 1].pos);
    }
  }
  return dist;
}

const A = 22, L = 44;
const twoPiece = [
  { id: "bankout", params: { bankRampLength: L, bankAngle: A, curveDir: 1 } },
  { id: "bankin", params: { bankRampLength: L, bankAngle: A, curveDir: -1 } },
];
const onePiece = [{ id: "bankswap", params: { bankRampLength: L, bankAngle: A, curveDir: 1 } }];

for (const tol of [1, 3, 5]) {
  const a = flatRun(twoPiece, tol), b = flatRun(onePiece, tol);
  console.log(`   within ${tol}° of level:   two-piece ${a.toFixed(1).padStart(5)} m` +
    `   chicane ${b.toFixed(1).padStart(5)} m`);
}
ok(flatRun(twoPiece, 3) > 3 * flatRun(onePiece, 3),
  "the chicane spends a fraction of the distance on level deck",
  `${flatRun(twoPiece, 3).toFixed(1)} m → ${flatRun(onePiece, 3).toFixed(1)} m within 3° of level`);
ok(L < 2 * L, "and it is half the length", `${L} m against ${2 * L} m`);

/* ---------------------------------------------------------------------- */
console.log("\n3. NO KINK AT THE CROSSOVER — why the centreline is held flat\n");

/*
 * The naive centreline follows the lean MAGNITUDE, dipping to the connector
 * plane where the deck passes through flat (rule 1 of the bank family: the
 * centreline rises by hw·sin lean). |lean| has a corner at the crossing, and the
 * centreline inherits it. Reconstruct that version here and measure the corner,
 * so the decision not to ship it is a number rather than an opinion.
 */
function worstVerticalBend(ys, L) {
  const n = ys.length - 1;
  let worst = 0;
  for (let i = 1; i < n; i++) {
    const dz = L / n;
    const a = Math.atan2(ys[i] - ys[i - 1], dz);
    const b = Math.atan2(ys[i + 1] - ys[i], dz);
    worst = Math.max(worst, Math.abs(b - a) * R2D);
  }
  return worst;
}
const smoother = (u) => u * u * u * (u * (u * 6 - 15) + 10);
const hw = rp.width / 2;
const bank = THREE.MathUtils.degToRad(A);
const shipped = build("bankswap", { bankRampLength: L, bankAngle: A, curveDir: 1 });
const n = shipped.frames.length - 1;
const naive = [], held = [];
for (let i = 0; i <= n; i++) {
  const f = 1 - 2 * smoother(i / n);
  naive.push(hw * Math.sin(bank * Math.abs(f)));   // raise ∝ |lean|
  held.push(hw * Math.sin(bank));                  // what ships
}
const kink = worstVerticalBend(naive, L);
const flat = worstVerticalBend(held, L);
console.log(`   raise following |lean|:  worst vertical bend ${kink.toFixed(1)}°`);
console.log(`   centreline held flat:    worst vertical bend ${flat.toFixed(3)}°`);
ok(kink > 8, "the naive centreline really does corner at the swap",
  `${kink.toFixed(1)}° — in the one spot the piece exists to smooth`);
ok(flat < 1e-6, "the shipped centreline is dead straight", `${flat.toExponential(1)}°`);

// And the deck EDGES stay smooth, which is what the held centreline buys: no
// absolute value anywhere, so both edges are hw·sin(θ) of a smooth θ.
const f = shipped.frames;
let worstEdge = 0;
for (let i = 1; i < f.length - 1; i++) {
  const e = (fr) => fr.pos.y + hw * Math.sin(THREE.MathUtils.degToRad(leanOf(fr)));
  const dz = L / n;
  const a = Math.atan2(e(f[i]) - e(f[i - 1]), dz);
  const b = Math.atan2(e(f[i + 1]) - e(f[i]), dz);
  worstEdge = Math.max(worstEdge, Math.abs(b - a) * R2D);
}
ok(worstEdge < 2.5, "and the deck edges trade places without a crease",
  `worst edge bend ${worstEdge.toFixed(2)}° over ${n} stations`);

/* ---------------------------------------------------------------------- */
console.log("\n4. IT SEAMS WITH WHAT IT JOINS\n");

const raise = hw * Math.sin(bank);
const swap = build("bankswap", { bankRampLength: L, bankAngle: A, curveDir: 1 });
const hold = build("banktilt", { straightLength: 32, bankAngle: A, curveDir: 1 });
const inn = build("bankin", { bankRampLength: L, bankAngle: A, curveDir: 1 });

ok(near(swap.frames[0].pos.y, raise, 1e-9)
  && near(swap.frames[swap.frames.length - 1].pos.y, raise, 1e-9),
  "the chicane's deck sits at the same raise as a held bank at both ends",
  `${swap.frames[0].pos.y.toFixed(6)} m`);
ok(near(hold.frames[0].pos.y, raise, 1e-9), "...which is where the held piece sits");
ok(near(inn.frames[inn.frames.length - 1].pos.y, raise, 1e-9), "...and where a bank-in arrives");
// Same lean at the seam, so a bank-in R feeds it and it feeds a held bank L.
ok(near(leanOf(swap.frames[0]), leanOf(hold.frames[0]), 1e-6),
  "and enters at exactly the lean the held piece holds",
  `${leanOf(swap.frames[0]).toFixed(4)}°`);

// LEVEL SOCKETS, like every other piece in the family.
const e = swap.connectorOut.elements;
const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
const pos = new THREE.Vector3().setFromMatrixPosition(swap.connectorOut);
ok(near(up.y, 1, 1e-9), "its connector carries no roll", `up.y=${up.y.toFixed(9)}`);
ok(near(pos.y, 0, 1e-9) && near(pos.x, 0, 1e-9) && near(pos.z, -L, 1e-9),
  "and sits on the plane at the piece's length");

// The roll RATE has to ease to zero at the ends or the joins crease. Same
// `smoother` as bank in/out, just running twice as far.
const d0 = Math.abs(leanOf(f[1]) - leanOf(f[0]));
const dMid = Math.abs(leanOf(f[Math.floor(n / 2) + 1]) - leanOf(f[Math.floor(n / 2)]));
ok(d0 < dMid * 0.1, "the roll rate eases to nothing at both joins",
  `${d0.toFixed(3)}°/station at the end vs ${dMid.toFixed(3)}° at the crossover`);

/* ---------------------------------------------------------------------- */
console.log("\n5. WIRED INTO THE PALETTE\n");

const tiles = CATEGORY_PRESETS.banked.filter((t) => t.base === "bankswap");
ok(tiles.length === 3, "three chicanes, one per rung of the bank ladder",
  tiles.map((t) => t.label).join(", "));
ok(tiles.every((t) => t.params.curveDir === undefined),
  "none pins a hand — R decides which way it starts");
ok(kit.isHandedPiece("bankswap"), "and it is registered as handed");
for (const t of tiles) {
  const p = build(t.base, t.params);
  ok((p.geometry.index?.count ?? 0) / 3 > 0, `${t.label} builds`,
    `${(p.geometry.index.count / 3)} tris, ${p.frames.length} stations`);
}

console.log(fail === 0 ? "\nALL PASS\n" : `\n${fail} FAILURE(S)\n`);
process.exit(fail === 0 ? 0 : 1);
