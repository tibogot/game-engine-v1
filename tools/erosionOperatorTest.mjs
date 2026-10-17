/**
 * Headless checks for the erosion operator's CPU parts (v3/terrain/erosionOperator.js
 * blurInto) and the height stack's `first` operator ordering (heightLayers.js).
 * The GPU bake itself is checked live in the editor.
 * Run: node tools/erosionOperatorTest.mjs   (picked up by npm test)
 */
import { blurInto } from "../v3/terrain/erosionOperator.js";
import { createHeightLayers } from "../v3/terrain/heightLayers.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const S = 64, N = S * S;
const tmp = new Float32Array(N), out = new Float32Array(N);

// A constant stays the constant (edges clamp, no darkening at the border).
{
  const a = new Float32Array(N).fill(0.37);
  blurInto(a, tmp, out, S, 5);
  ok("constant in, constant out", out.every((v) => Math.abs(v - 0.37) < 1e-6));
}

// A ramp stays a ramp in the middle (a box blur is exact on linear data).
{
  const a = new Float32Array(N);
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) a[z * S + x] = x * 0.01;
  blurInto(a, tmp, out, S, 4);
  ok("linear data unchanged away from the edges", Math.abs(out[32 * S + 32] - 0.32) < 1e-5, `${out[32 * S + 32]}`);
}

// A spike spreads and keeps (most of) its mass; the high-pass removes the mean.
{
  const a = new Float32Array(N); a[32 * S + 32] = 1;
  blurInto(a, tmp, out, S, 3);
  let sum = 0; for (const v of out) sum += v;
  ok("a spike keeps its mass", Math.abs(sum - 1) < 1e-4, `${sum}`);
  ok("and spreads", out[32 * S + 32] < 0.1 && out[32 * S + 35] > 0);
  const hp = a.map((v, i) => v - out[i]);
  let m = 0; for (const v of hp) m += v;
  ok("high-pass has ~zero mean", Math.abs(m) < 1e-4);
}

// The stack: a `first` operator runs before the ones already there.
{
  const final = new Float32Array(N);
  const L = createHeightLayers({ final, size: S });
  L.reset(new Float32Array(N).fill(0.5));
  const FULL = { x0: 0, z0: 0, x1: S - 1, z1: S - 1 };
  const order = [];
  // "river" overwrites with 0.2 where it applies; erosion adds 0.1.
  L.setOperator("river", { rect: FULL, apply(o, g, r) { order.push("river"); for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) if (x < 8) o[z * S + x] = 0.2; } });
  L.setOperator("erosion", { rect: FULL, first: true, apply(o, g, r) { order.push("erosion"); for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) o[z * S + x] += 0.1; } });
  order.length = 0;
  L.compose(FULL);
  ok("erosion applied before the river", order[0] === "erosion" && order[1] === "river", order.join(","));
  ok("the river carves the eroded ground (its value wins)", Math.abs(final[10 * S + 2] - 0.2) < 1e-6);
  ok("elsewhere the erosion offset is there", Math.abs(final[10 * S + 20] - 0.6) < 1e-6);
  ok("GROUND is exposed and untouched", Math.abs(L.ground[10 * S + 20] - 0.5) < 1e-6);
  L.setOperator("erosion", null, FULL);
  ok("removing it restores the ground", Math.abs(final[10 * S + 20] - 0.5) < 1e-6);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
