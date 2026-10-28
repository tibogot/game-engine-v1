// Run every test in tools/ and print one summary line each.
//
// Exists so the full suite is ONE allowlisted command instead of a shell `for`
// loop — loops, pipes and $(...) can never be added to a permission allowlist,
// because the harness cannot know what they will expand to.
//
// Discovers *Test.mjs automatically, so a new suite is picked up with no edit
// here. `*.run.mjs` wrappers are included; the instruments in tools/attic/ are
// not — they are diagnostics that print tables rather than pass/fail, and they
// are not in this directory any more.
//
// RUNS IN PARALLEL. Each suite is its own process that reads the game source and
// writes nothing back, and the few that need a patched copy of a module write it
// as `.<name>.<pid>.mjs` — the pid is in the name precisely so concurrent runs
// cannot collide. Sequentially the suite was 125 s; the work is only ~125 core-
// seconds and one suite (gradeFollowTest, ~46 s of vehicle simulation) is a third
// of it, so the wall clock is bounded by that suite rather than by the total.
//
// Output stays in NAME ORDER despite finishing out of order: completed results
// are buffered and flushed in order behind a pointer, so a line still appears as
// soon as everything before it is done, and two runs remain diffable.
import { readdirSync, statSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, basename, resolve, relative } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { cpus } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * SWEEP THE PATCHED COPIES THAT A KILLED RUN LEFT BEHIND.
 *
 * A suite that needs a patched module writes `.<name>.<pid>.mjs` in the repo
 * root, imports it, and deletes it on the very next line. That delete only
 * misses when the process dies in between — a timeout, Ctrl+C, a background run
 * stopped — and each miss leaves one file for good. 79 had piled up in the root
 * before anyone noticed. They are gitignored, so git never complained; they
 * were just clutter in the project folder.
 *
 * Judged by AGE, not by the pid in the name. Checking whether that pid is still
 * running was the first version, and on Windows it kept 5 of the 79: pids are
 * reused, so a long-dead test's number now belonged to some unrelated process.
 * A live suite deletes its copy within about a second of writing it, so
 * anything a minute old is a leftover — and a concurrent run's fresh copy is
 * left alone.
 */
function sweepStaleCopies() {
  const STALE_MS = 60_000;
  let n = 0;
  for (const f of readdirSync(ROOT)) {
    if (!/^\.[\w-]+\.\d+\.mjs$/.test(f)) continue;
    const path = join(ROOT, f);
    try {
      if (Date.now() - statSync(path).mtimeMs < STALE_MS) continue;
      unlinkSync(path);
      n++;
    } catch { /* already gone */ }
  }
  if (n) console.log(`removed ${n} leftover patched cop${n === 1 ? "y" : "ies"} from killed runs\n`);
}
sweepStaleCopies();

/**
 * THE FIVE LONG VEHICLE SIMULATIONS, and the only reason a full run is minutes
 * rather than seconds.
 *
 * Measured serially: gradeFollow 121.5 s, railTunnel 47.8 s, parkPipe 26.8 s,
 * jumpDebug 23.0 s, roadHold 16.1 s — 235 s of a 318 s total, against ~0.6 s
 * each for the other 112 suites. The pool is parallel, so the WALL clock is
 * bounded by the single longest suite: these five set the floor by themselves.
 *
 * Each sweeps a BAND of speeds through a real physics sim, which is both why
 * they are slow and why they are worth keeping — a bowl radius once shipped
 * broken because one speed was sampled instead of a band. So they are SKIPPED,
 * never trimmed: `--fast` drops them for the edit loop, and a full run keeps
 * them for anything touching the vehicle or the collision BVH.
 */
// (jumpDebugTrack.mjs was on this list but never ran: it isn't a *Test.mjs. simStateTest — Thunderline's
// builder lap resumed from mid-track must match a full one, 57 s — joined it on 2026-10-28.)
const SLOW = new Set([
  "gradeFollowTest.mjs",
  "railTunnelTest.mjs",
  "parkPipeTest.mjs",
  "roadHoldTest.mjs",
  "simStateTest.mjs",
]);

/*
 * cityKitTest WAS OUT OF THE FAST LANE (2026-10-07 to 10-12) as "flaky", and it was not: its
 * traffic check failed at the SAME frame on every run, 3.79 m against a 5 m floor. A car finishing
 * a turn merged in front of one already in the lane, because the room check treated the follower
 * as parked (roomAt's `tArrive`, modularRoadCityFurniture.js). Fixed, and back in at 5.5 s. Its LOD
 * timing check is best of six with 10x headroom; if a suite is red, reproduce it alone before
 * calling it flaky.
 */
const FAST = process.argv.includes("--fast");
const CHANGED = process.argv.includes("--changed");

/*
 * THE CHANGED LANE (`npm test`, 2026-10-28, user: "is it worth it, what are all those tests for?"): two thirds
 * of the suites test the old car game, and a Sand & Blood or an art-only commit waited on all of them. Now a
 * suite runs when what it reaches has CHANGED (uncommitted, against HEAD — plus new files):
 *   - every file in its static / dynamic IMPORT chain (relative paths), and
 *   - every file a file of that chain NAMES in a string ("modularRoadProps.js", "auresNew.json": suites read
 *     game sources and data with readFileSync, not only import them);
 *   - the suites that WALK folders (scan every game, every model, every level) always run: ~8 s together;
 *   - a change to the runner, package.json or the lockfile (three's version) runs everything.
 * `npm run test:fast` is the old whole fast lane; `npm run test:all` everything, long sims included.
 */
const WALKERS = new Set(discoverWalkers());
const RUN_ALL_ON = ["package.json", "package-lock.json", "tools/runAll.mjs"];
const changedFiles = CHANGED ? gitChanged() : [];
const runEverything = changedFiles.map((f) => relative(ROOT, f).replace(/\\/g, "/")).find((f) => RUN_ALL_ON.includes(f)) ?? null;
const changedSet = new Set(changedFiles);
const changedNames = new Set(changedFiles.map((f) => basename(f)));

function gitChanged() {
  // --files=a,b: these instead of git's (to see what a change would run: with --list, nothing runs)
  const given = process.argv.find((a) => a.startsWith("--files="));
  if (given) return given.slice(8).split(",").filter(Boolean).map((f) => resolve(ROOT, f));
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
  return [...new Set([...git("diff", "--name-only", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")])].map((f) => resolve(ROOT, f));
}
function discoverWalkers() {
  return readdirSync(HERE).filter((f) => /Test(\.run)?\.mjs$/.test(f) && /\breaddirSync\b|\bglobSync\b/.test(readFileSync(join(HERE, f), "utf8")));
}
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'`]([^"'`]+)["'`]/g;
const NAMED_RE = /["'`/]([\w.-]+\.(?:m?js|json|glb|gltf|png|v3proj|bin|txt))["'`]/g;
const reach = new Map(); // file → { files: Set (its import chain, itself included), names: Set (file names it mentions) }
function reachOf(file) {
  if (reach.has(file)) return reach.get(file);
  const r = { files: new Set([file]), names: new Set() };
  reach.set(file, r); // (set first: import cycles)
  let src = "";
  try { src = readFileSync(file, "utf8"); } catch { return r; }
  for (const m of src.matchAll(NAMED_RE)) r.names.add(m[1]);
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith(".") && !spec.startsWith("/")) continue; // a package (three…): package-lock covers it
    const dep = spec.startsWith("/") ? join(ROOT, spec) : resolve(dirname(file), spec);
    if (!/\.m?js$/.test(dep) || !existsSync(dep)) continue;
    const d = reachOf(dep);
    for (const f of d.files) r.files.add(f);
    for (const n of d.names) r.names.add(n);
  }
  return r;
}
function affected(suite) {
  if (runEverything || WALKERS.has(basename(suite))) return true;
  const r = reachOf(suite);
  for (const f of changedSet) if (r.files.has(f)) return true;
  for (const n of changedNames) if (r.names.has(n)) return true;
  return false;
}

// Only `*Test.mjs` / `*.run.mjs` are discovered, and that is what keeps the
// GENERATORS out: buildParkourTrack.mjs rewrites apex-parkour.json and
// replaySeed.mjs writes a seed file. Neither is a test and neither matches, so
// the one way to run them by accident is a blanket `for f in tools/*.mjs` shell
// loop. Use this runner instead of a loop.
//
// THUNDERLINE'S OWN SUITES live beside its code (2026-10-28: they were never in npm test — every "218/218"
// on a Thunderline commit ran none of them, and kitTest had been red since the Quarter pipe was added).
// Its calibration INSTRUMENTS are named *Test too but print tables and never fail: left out. (piecesTest,
// one level up, tests the first prototype builder's pieces.js — not the game.)
const TEST_DIRS = [HERE, join(ROOT, "games/thunderline/proto/kit")];
const INSTRUMENTS = new Set(["bowlTest.mjs", "wallTest.mjs", "landingTest.mjs"]);
const discovered = TEST_DIRS.flatMap((dir) => readdirSync(dir)
  .filter((f) => /Test(\.run)?\.mjs$/.test(f) && !INSTRUMENTS.has(f))
  // a suite that has a `.run.mjs` wrapper is that wrapper's helper library, not a suite of its own
  // (chassisCollisionTest.mjs was counted, and passed, checking nothing)
  .filter((f) => !(f.endsWith("Test.mjs") && existsSync(join(dir, f.replace(/\.mjs$/, ".run.mjs")))))
  .map((f) => join(dir, f)));
const files = discovered
  .filter((p) => !(FAST && SLOW.has(basename(p))))
  .filter((p) => !CHANGED || affected(p))
  .sort((a, b) => basename(a).localeCompare(basename(b)));
const skippedSlow = FAST ? discovered.filter((p) => SLOW.has(basename(p))).length : 0;

if (FAST) {
  console.log(`fast lane: skipping ${skippedSlow} long sims`);
  console.log("run without --fast (npm run test:all) after any vehicle / BVH change\n");
}
if (CHANGED) {
  console.log(`changed lane: ${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"} → ${files.length} of ${discovered.length - skippedSlow} suites affected` +
    (runEverything ? ` (a change to ${runEverything}: everything)` : "") + "\n");
  if (!files.length) { console.log("nothing to test for these changes"); process.exit(0); }
}
if (process.argv.includes("--list")) { for (const f of files) console.log(`  ${relative(ROOT, f)}`); process.exit(0); }

// Each worker is a node process that loads three and bakes BVHs, so this is
// bounded by MEMORY, not by cores. 8 is ~1.5 GB of peak and already past the
// point where it stops mattering: nothing can finish sooner than the slowest
// single suite. `RUNALL_JOBS=1` restores the old sequential behaviour.
const JOBS = Math.max(1, Number(process.env.RUNALL_JOBS)
  || Math.min(8, Math.max(2, (cpus().length || 4) - 1)));

const results = new Array(files.length);
let started = 0;
let printed = 0;
let failed = 0;

/** Flush every finished result whose predecessors are also finished. */
function flush() {
  while (printed < files.length && results[printed]) {
    const r = results[printed];
    console.log(`${r.ok ? "green" : "FAIL "}  ${basename(r.f).replace(/\.mjs$/, "").padEnd(26)} `
      + `${String(r.ms).padStart(5)}ms`);
    printed++;
  }
}

function runOne(i) {
  const f = files[i];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [f], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      results[i] = { f, ok: false, ms: Date.now() - t0, out, err: String(e) };
      failed++; flush(); resolve();
    });
    child.on("close", (code) => {
      // A SUITE THAT SKIPS PART OF ITSELF IS NOT GREEN (2026-10-28: rampDeckProxyTest printed "SKIP could not
      // load PropManager headless" and exited 0 for six weeks — half of it checked nothing)
      const skipped = /^\s*SKIP\b/m.test(out);
      const ok = code === 0 && !skipped;
      if (skipped && code === 0) out += "\nFAIL  the suite SKIPPED part of itself (the SKIP line above): fix its setup";
      if (!ok) failed++;
      results[i] = { f, ok, ms: Date.now() - t0, out, err };
      flush();
      resolve();
    });
  });
}

/** One worker pulls the next index until the list is exhausted. */
async function worker() {
  for (;;) {
    const i = started++;
    if (i >= files.length) return;
    await runOne(i);
  }
}

await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, worker));
flush();

// Only failures get their output dumped — a green run stays one screen.
for (const r of results) {
  if (!r || r.ok) continue;
  console.log(`\n──────── ${relative(ROOT, r.f)} ────────`);
  const lines = r.out.split("\n").filter((l) => /^\s*(FAIL|SKIP)/.test(l));
  console.log(lines.length ? lines.join("\n") : r.out.trim().split("\n").slice(-25).join("\n"));
  if (r.err.trim()) console.log(r.err.trim().split("\n").slice(0, 12).join("\n"));
}

console.log(`\n${files.length - failed}/${files.length} suites green${CHANGED ? " (changed lane: the suites these changes reach)" : ""}${FAST ? ` (fast lane, ${skippedSlow} long sims skipped)` : ``}`);
process.exit(failed ? 1 : 0);
