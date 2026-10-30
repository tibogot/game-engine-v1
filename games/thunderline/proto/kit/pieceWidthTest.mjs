// node games/thunderline/proto/kit/pieceWidthTest.mjs
// EVERY PIECE JOINS THE ROAD AT THE ROAD'S WIDTH (user, 2026-10-30: "I'm placing the start piece and now the straight
// is larger … this kind of problem should not happen"): the road went 16 → 24 m on 10-29 in kit.js SECTIONS, and the
// pieces with their own numbers — the old game's Start, Finish and flip ramps (16 m road params), the funnel and flare
// (a 16 m end) — stayed behind. Each piece's deck is measured where it begins and where it ends, across its own frame:
// it must be one of the kit's section widths (road 24, wide 48, narrow 12) or a piece that closes (a nose, a wedge's
// point), and a TAPER's narrow end must be the road's.
import { TILES, SECTIONS, ensureTile, integrate } from "./kit.js";
import "./oldTiles.js"; // (registers the old game's pieces: start, finish, flip ramps, bowls)
import { oldLookOf } from "./oldTiles.js";

let fails = 0;
const fail = (m) => { fails++; console.log("FAIL", m); };
const ROAD = 2 * SECTIONS.road.hw, OK = new Set(Object.values(SECTIONS).map((s) => 2 * s.hw));

// the declared numbers: tapers end at a section's width
for (const [id, t] of Object.entries(TILES)) {
  if (!t.taper || t.taper.shape) continue;
  for (const end of ["from", "to"]) if (!OK.has(2 * t.taper[end])) fail(`${id}: taper ${end} ${2 * t.taper[end]} m is no section's width (${[...OK].join(", ")})`);
  if (Math.min(t.taper.from, t.taper.to) * 2 !== ROAD) fail(`${id}: its narrow end ${Math.min(t.taper.from, t.taper.to) * 2} m ≠ the road's ${ROAD} m`);
}

// the old game's pieces, built: the deck's width across (its rings are sparse along a straight stub, so the whole
// deck's extent — these pieces never get wider than their road)
for (const id of ["start_line", "finish_line", "flip_ramp_std", "flip_ramp_s"]) {
  const deck = oldLookOf(ensureTile(id), true).deck;
  deck.computeBoundingBox();
  const w = deck.boundingBox.max.x - deck.boundingBox.min.x;
  if (Math.abs(w - ROAD) > 0.5) fail(`${id}: ${w.toFixed(1)} m wide, the road is ${ROAD} m`);
  else console.log(`${id.padEnd(16)} ${w.toFixed(1)} m`);
}
// …and their EXIT is where their road ends: the Start's nose is half the road, and its path read the old game's 16 m
// while its deck was built at 24 — the exit sat 4 m inside the stub and the next piece overlapped it (2026-10-30)
for (const id of ["start_line", "finish_line"]) {
  const deck = oldLookOf(ensureTile(id), true).deck, exit = integrate(ensureTile(id)).exit.p;
  deck.computeBoundingBox();
  if (Math.abs(exit.z - deck.boundingBox.min.z) > 0.1) fail(`${id}: exit at ${exit.z.toFixed(2)} m, its road ends at ${deck.boundingBox.min.z.toFixed(2)} m`);
}
console.log(fails ? `${fails} FAILED` : `every piece meets the road at ${ROAD} m`);
process.exit(fails ? 1 : 0);
