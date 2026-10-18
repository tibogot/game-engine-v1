// node games/thunderline/proto/kit/layoutCheck.mjs [jumpSpeeds…]
// Lays out the test track (same code as the pages) and prints its warnings: road overlaps and
// blocked flight corridors. Exit 1 if any — the test track must be clean.
import { TILES, integrate } from "./kit.js";
import { layoutTestTrack, TEST_HANDS } from "./testTrack.js";

const built = {};
for (const [id, t] of Object.entries(TILES)) built[id] = { b: integrate(t) };
const args = process.argv.slice(2);
const search = args.includes("--search");
const jumpSpeeds = args.map(Number).filter((v) => v > 0);
const lay = (hands) => layoutTestTrack({
  built,
  speed: 63 * 0.91,
  jumpSpeeds: jumpSpeeds.length ? jumpSpeeds : [55.8, 48.6, 50.6], // drive.js defaults
  airDrag: 0.45 / 1400,
  hands,
});

if (search) {
  // try every left/right assignment; report the clean ones (fewest left turns first = least change)
  const vars = Object.keys(TEST_HANDS);
  const clean = [];
  for (let m = 0; m < 1 << vars.length; m++) {
    const hands = Object.fromEntries(vars.map((v, i) => [v, m & (1 << i) ? "L" : "R"]));
    const l = lay(hands);
    if (!l.warnings.length) clean.push({ hands, lefts: vars.filter((v) => hands[v] === "L").length, km: l.length / 1000 });
  }
  clean.sort((a, b) => a.lefts - b.lefts);
  console.log(`${clean.length} clean of ${1 << vars.length}`);
  for (const c of clean.slice(0, 5)) console.log(JSON.stringify(c.hands), `${c.lefts} left groups, ${c.km.toFixed(2)} km`);
  process.exit(clean.length ? 0 : 1);
}
const l = lay(TEST_HANDS);
console.log(`${l.placements.length} pieces, ${(l.length / 1000).toFixed(2)} km`);
for (const w of l.warnings) console.log("WARN", w);
console.log(l.warnings.length ? `${l.warnings.length} problem(s)` : "clean");
process.exit(l.warnings.length ? 1 : 0);
