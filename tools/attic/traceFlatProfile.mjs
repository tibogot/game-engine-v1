/**
 * Flat CPU profile out of a Chrome performance trace (.json or .json.gz).
 *
 * The DevTools trace carries the JS sampling profiler as Profile/ProfileChunk
 * events. This walks every chunk, resolves each sample to its call frame and
 * sums the sample intervals as SELF time per function, then prints the top N
 * and the totals for a few families (three.js, the engine, the game, the
 * browser's own work). It is the one honest answer to "where does the frame
 * go" that toggling systems from the outside cannot give.
 *
 *   node tools/attic/traceFlatProfile.mjs trace.json [topN]
 */
import fs from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
const topN = Number(process.argv[3] ?? 40);
let raw = fs.readFileSync(file);
if (file.endsWith(".gz")) raw = zlib.gunzipSync(raw);
const json = JSON.parse(raw.toString("utf8"));
const events = Array.isArray(json) ? json : json.traceEvents;

// Profiles are keyed by (pid, tid, id); chunks arrive in order.
const profiles = new Map();
for (const e of events) {
  if (e.name !== "Profile" && e.name !== "ProfileChunk") continue;
  const key = `${e.pid}:${e.tid}:${e.id}`;
  let p = profiles.get(key);
  if (!p) { p = { nodes: new Map(), samples: [], deltas: [], tid: e.tid, pid: e.pid }; profiles.set(key, p); }
  const cp = e.args?.data?.cpuProfile;
  if (cp?.nodes) for (const n of cp.nodes) p.nodes.set(n.id, n);
  if (cp?.samples) p.samples.push(...cp.samples);
  if (e.args?.data?.timeDeltas) p.deltas.push(...e.args.data.timeDeltas);
}

const self = new Map();      // fn key -> µs
let totalUs = 0;
for (const p of profiles.values()) {
  const n = Math.min(p.samples.length, p.deltas.length);
  for (let i = 0; i < n; i++) {
    const node = p.nodes.get(p.samples[i]);
    const dt = Math.max(0, p.deltas[i]);
    totalUs += dt;
    if (!node) continue;
    const cf = node.callFrame ?? {};
    const url = (cf.url ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    const key = `${cf.functionName || "(anonymous)"}  ${url}:${cf.lineNumber ?? ""}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
}

const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
const fam = (k) => k.includes("three") ? "three.js" : k.includes("/games/") ? "game" : k.includes("/v3/") ? "engine" : k.includes("(program)") || k.includes("(garbage") || k.includes("(idle)") ? k.split("  ")[0] : "other";
const families = new Map();
for (const [k, v] of rows) families.set(fam(k), (families.get(fam(k)) ?? 0) + v);

console.log(`profiles ${profiles.size}, sampled ${(totalUs / 1000).toFixed(0)} ms\n`);
console.log("by family:");
for (const [k, v] of [...families.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${(v / 1000).toFixed(1).padStart(8)} ms  ${(100 * v / totalUs).toFixed(1).padStart(5)}%`);
}
console.log(`\ntop ${topN} by self time:`);
for (const [k, v] of rows.slice(0, topN)) {
  console.log(`  ${(v / 1000).toFixed(1).padStart(7)} ms  ${(100 * v / totalUs).toFixed(1).padStart(5)}%  ${k}`);
}
