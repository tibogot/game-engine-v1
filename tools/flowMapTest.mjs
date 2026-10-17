/**
 * Headless checks for the wetness flow map (v3/terrain/flowMapCompute.js).
 * Run: node tools/flowMapTest.mjs   (picked up by npm test)
 */
import { computeFlowBytes } from "../v3/terrain/flowMapCompute.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const S = 128;
const octaves = (bytes, x, z) => bytes[z * S + x] / 16;
const run = (fn) => {
  const h = new Float32Array(S * S);
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) h[z * S + x] = fn(x, z);
  return computeFlowBytes(h, S, new Uint8Array(S * S));
};

// A V valley along x = 64, falling gently toward z = 0: the floor drains the slopes.
{
  const b = run((x, z) => Math.abs(x - 64) * 0.5 + z * 0.05);
  const floor = octaves(b, 64, 20), slope = octaves(b, 40, 20), crest = octaves(b, 2, 20);
  ok("valley floor wetter than its slope", floor > slope + 3, `floor ${floor} slope ${slope}`);
  ok("slope wetter than the crest", slope >= crest, `slope ${slope} crest ${crest}`);
  ok("floor gathers downstream", octaves(b, 64, 10) > octaves(b, 64, 100), `${octaves(b, 64, 10)} vs ${octaves(b, 64, 100)}`);
  ok("floor reaches ~log2 of the drained area (> 9 octaves)", octaves(b, 64, 5) > 9, `${octaves(b, 64, 5)}`);
}

// The lines come through at full value: the 3×3 max, not a blur that halved them.
{
  const b = run((x, z) => Math.abs(x - 64) * 0.5 + z * 0.05);
  ok("a texel beside the floor carries the floor's value", Math.abs(octaves(b, 65, 20) - octaves(b, 64, 20)) < 0.2);
}

// Flat ground: no slope, no flow — every texel keeps its own cell (log2 1 = 0).
{
  const b = run(() => 10);
  ok("flat ground stays dry", b.every((v) => v === 0));
}

// A bowl: the pit keeps the water of the whole bowl.
{
  const b = run((x, z) => Math.hypot(x - 64, z - 64));
  const pit = octaves(b, 64, 64), rim = octaves(b, 64, 120);
  ok("a pit gathers its bowl", pit > 10 && pit > rim + 6, `pit ${pit} rim ${rim}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
