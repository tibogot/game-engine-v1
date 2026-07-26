// Run every test in tools/ and print one summary line each.
//
// Exists so the full suite is ONE allowlisted command instead of a shell `for`
// loop — loops, pipes and $(...) can never be added to a permission allowlist,
// because the harness cannot know what they will expand to.
//
// Discovers *Test.mjs automatically, so a new suite is picked up with no edit
// here. `*.run.mjs` wrappers are included; plain `*Repro.mjs` instruments are
// not — they are diagnostics that print tables rather than pass/fail.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(HERE)
  .filter((f) => /Test(\.run)?\.mjs$/.test(f))
  .sort();

let failed = 0;
const rows = [];
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(HERE, f)], { encoding: "utf8" });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  if (!ok) failed++;
  rows.push({ f, ok, ms, out: r.stdout ?? "", err: r.stderr ?? "" });
  console.log(`${ok ? "green" : "FAIL "}  ${f.replace(/\.mjs$/, "").padEnd(26)} ${String(ms).padStart(5)}ms`);
}

// Only failures get their output dumped — a green run stays one screen.
for (const r of rows) {
  if (r.ok) continue;
  console.log(`\n──────── ${r.f} ────────`);
  const lines = r.out.split("\n").filter((l) => /^FAIL/.test(l));
  console.log(lines.length ? lines.join("\n") : r.out.trim().split("\n").slice(-25).join("\n"));
  if (r.err.trim()) console.log(r.err.trim().split("\n").slice(0, 12).join("\n"));
}

console.log(`\n${files.length - failed}/${files.length} suites green`);
process.exit(failed ? 1 : 0);
