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
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { cpus } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

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
const SLOW = new Set([
  "gradeFollowTest.mjs",
  "railTunnelTest.mjs",
  "parkPipeTest.mjs",
  "jumpDebugTrack.mjs",
  "roadHoldTest.mjs",
]);

const FAST = process.argv.includes("--fast");

// Only `*Test.mjs` / `*.run.mjs` are discovered, and that is what keeps the
// GENERATORS out: buildParkourTrack.mjs rewrites apex-parkour.json and
// replaySeed.mjs writes a seed file. Neither is a test and neither matches, so
// the one way to run them by accident is a blanket `for f in tools/*.mjs` shell
// loop. Use this runner instead of a loop.
const files = readdirSync(HERE)
  .filter((f) => /Test(\.run)?\.mjs$/.test(f))
  .filter((f) => !(FAST && SLOW.has(f)))
  .sort();

if (FAST) {
  console.log(`fast lane: skipping ${SLOW.size} long vehicle sims`);
  console.log("run without --fast before committing, or after any vehicle / BVH change\n");
}

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
    console.log(`${r.ok ? "green" : "FAIL "}  ${r.f.replace(/\.mjs$/, "").padEnd(26)} `
      + `${String(r.ms).padStart(5)}ms`);
    printed++;
  }
}

function runOne(i) {
  const f = files[i];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, f)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      results[i] = { f, ok: false, ms: Date.now() - t0, out, err: String(e) };
      failed++; flush(); resolve();
    });
    child.on("close", (code) => {
      const ok = code === 0;
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
  console.log(`\n──────── ${r.f} ────────`);
  const lines = r.out.split("\n").filter((l) => /^FAIL/.test(l));
  console.log(lines.length ? lines.join("\n") : r.out.trim().split("\n").slice(-25).join("\n"));
  if (r.err.trim()) console.log(r.err.trim().split("\n").slice(0, 12).join("\n"));
}

console.log(`\n${files.length - failed}/${files.length} suites green${FAST ? ` (fast lane, ${SLOW.size} long sims skipped)` : ``}`);
process.exit(failed ? 1 : 0);
