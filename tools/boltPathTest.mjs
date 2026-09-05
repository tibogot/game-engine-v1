// The lightning channel's shape, asserted without a GPU.
//
// `makeBoltPath` is pure geometry — it takes two points and an rng and returns
// segments — precisely so the things that make a bolt look like a bolt can be
// checked here rather than judged from a fifth of a second on screen.
//
// WHAT IS WORTH GUARDING:
//   • it stays inside its buffer, whatever the rng does. The mesh allocates
//     `maxSegments` ONCE, so a path that overruns would write past the end.
//   • it is JAGGED AT EVERY SCALE. Midpoint displacement halves the push each
//     generation; drop that and you get a line with a few big kinks, which
//     reads as a crack rather than as lightning.
//   • it actually branches, and branches do not branch again (two levels reads
//     as a bush).
//   • it spans the distance asked for — an unconnected channel is the classic
//     failure of a recursive generator.
//
// Run: node tools/boltPathTest.mjs
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const THREE = await import("three");
const { makeBoltPath, BOLT_DEFAULTS } = await import(
  pathToFileURL(join(GAME, "modularRoadBolt.js")).href
);

function seeded(seed = 4242) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const from = new THREE.Vector3(0, 1400, 0);
const to = new THREE.Vector3(120, 0, -80);

console.log("=== IT CONNECTS THE TWO POINTS ===");
{
  const segs = makeBoltPath(from, to, {}, seeded());
  check("it produced a path", segs.length > 8, `${segs.length} segments`);
  // Walk only the trunk: segments are emitted depth-first, so the first
  // endpoint and the last of the MAIN channel bracket the whole run.
  const startsAtFrom = segs[0].a.distanceTo(from) < 1e-6;
  check("the first segment starts at `from`", startsAtFrom,
    `${segs[0].a.distanceTo(from).toFixed(4)} m off`);
  const reachesTo = segs.some((s) => s.b.distanceTo(to) < 1e-6);
  check("some segment ends exactly at `to`", reachesTo);
  // No gaps in the trunk: every segment's start must be some other segment's
  // end (or the origin). A generator that loses a midpoint leaves a floating
  // spur, which on screen is a bolt in two pieces.
  const ends = new Set(segs.map((s) => `${s.b.x},${s.b.y},${s.b.z}`));
  ends.add(`${from.x},${from.y},${from.z}`);
  const orphans = segs.filter((s) => !ends.has(`${s.a.x},${s.a.y},${s.a.z}`));
  check("no floating segments", orphans.length === 0, `${orphans.length} orphaned`);
}

console.log("\n=== IT NEVER OVERRUNS THE BUFFER ===");
{
  // The mesh sizes its attributes for maxSegments at boot and refills in place,
  // so this is a memory-safety property, not a tuning one. Hammer it with seeds
  // and with settings far past anything the game ships.
  let worst = 0;
  for (let s = 0; s < 200; s++) {
    const segs = makeBoltPath(from, to, {
      generations: 9, branchChance: 0.95, maxSegments: 320,
    }, seeded(s * 7919 + 1));
    worst = Math.max(worst, segs.length);
  }
  check("stays within maxSegments under 200 hostile seeds", worst <= 320,
    `worst ${worst} of 320`);
}

console.log("\n=== IT IS JAGGED AT EVERY SCALE ===");
{
  /*
   * NOT segment LENGTH. Every leaf segment of this generator is the same length
   * to four decimal places, and that is correct rather than a bug: displacing a
   * midpoint PERPENDICULAR to its chord leaves it equidistant from both ends, so
   * each subdivision produces two exactly equal halves, recursively. An earlier
   * version of this test asserted that lengths varied and went red on healthy
   * output — the shape is in the ANGLES, not the lengths.
   *
   * So: how far the channel wanders off the straight line, and whether the turn
   * at each joint varies. A constant turn is a zigzag; lightning is not.
   */
  const segs = makeBoltPath(from, to, { branchChance: 0 }, seeded(11));
  const straight = from.distanceTo(to);
  const axis = to.clone().sub(from).normalize();

  let maxDev = 0;
  for (const s of segs) {
    const v = s.a.clone().sub(from);
    maxDev = Math.max(maxDev, v.clone().sub(axis.clone().multiplyScalar(v.dot(axis))).length());
  }
  check("the channel wanders off the straight line", maxDev > straight * 0.03,
    `${maxDev.toFixed(0)} m across a ${straight.toFixed(0)} m span`);
  check("...but stays a channel, not a scribble", maxDev < straight * 0.5,
    `${(maxDev / straight * 100).toFixed(1)}% of span`);

  const turns = [];
  for (let i = 1; i < segs.length; i++) {
    const d0 = segs[i - 1].b.clone().sub(segs[i - 1].a).normalize();
    const d1 = segs[i].b.clone().sub(segs[i].a).normalize();
    turns.push(Math.acos(Math.max(-1, Math.min(1, d0.dot(d1)))) * 180 / Math.PI);
  }
  const tMax = Math.max(...turns), tMin = Math.min(...turns);
  check("joints turn by varying amounts (self-similar, not a zigzag)",
    tMax > tMin * 3, `turns ${tMin.toFixed(1)}° to ${tMax.toFixed(1)}°`);
}

console.log("\n=== IT BRANCHES, AND BRANCHES DO NOT ===");
{
  const none = makeBoltPath(from, to, { branchChance: 0 }, seeded(5));
  const many = makeBoltPath(from, to, { branchChance: 0.9 }, seeded(5));
  check("branching adds geometry", many.length > none.length,
    `${many.length} vs ${none.length}`);
  // With no branching the trunk is exactly 2^generations segments — the clean
  // signature of a complete binary subdivision with nothing extra spliced in.
  check("an unbranched path is exactly 2^generations",
    none.length === 2 ** BOLT_DEFAULTS.generations,
    `${none.length} vs ${2 ** BOLT_DEFAULTS.generations}`);
}

console.log("\n=== WIDTH TAPERS TO A POINT ===");
{
  const segs = makeBoltPath(from, to, { branchChance: 0 }, seeded(3));
  const first = segs[0];
  const last = segs[segs.length - 1];
  check("it starts thick", first.w0 > last.w1, `${first.w0.toFixed(2)} → ${last.w1.toFixed(2)}`);
  check("the tip is nearly a point", last.w1 < BOLT_DEFAULTS.width * 0.3,
    `${last.w1.toFixed(2)} m`);
  check("no negative widths", segs.every((s) => s.w0 >= 0 && s.w1 >= 0));
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
