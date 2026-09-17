// Target strength (v3/terrain/splatMap.js): the most weight a paint stroke may
// give its layer. Opacity only slows a stroke down — scrub long enough and any
// opacity reaches 100%. A target caps it, and never lowers paint that is
// already stronger.
import { SplatMap, SPLAT_RES } from "../v3/terrain/splatMap.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

// The texel under world (0, 0), and the weight of layer 1 / layer 2 there.
const centre = (SPLAT_RES / 2) * SPLAT_RES + SPLAT_RES / 2;
const w1 = (sm) => sm.data0[centre * 4] / 255;       // layer 1 = slice 0, R
const w2 = (sm) => sm.data0[centre * 4 + 1] / 255;   // layer 2 = slice 0, G
const stamp = (sm, activeLayer, strength, target) =>
  sm.applySplatStroke({ cx: 0, cz: 0, radius: 20, strength, falloff: 0, activeLayer, target });

// ── No target: the old behaviour, scrubbing reaches full weight ──
{
  const sm = new SplatMap();
  for (let i = 0; i < 60; i++) stamp(sm, 1, 0.1);
  check("without a target, a weak brush still creeps to full weight", w1(sm) > 0.98, w1(sm).toFixed(3));
}

// ── Target 0.3: scrubbing stops at 30% ──
{
  const sm = new SplatMap();
  for (let i = 0; i < 200; i++) stamp(sm, 1, 0.5, 0.3);
  const v = w1(sm);
  check("with target 0.3, scrubbing settles at 30%", Math.abs(v - 0.3) <= 1 / 255 + 1e-6, v.toFixed(3));
  const r = sm.data0[centre * 4], g = sm.data0[centre * 4 + 1], b = sm.data0[centre * 4 + 2], a = sm.data0[centre * 4 + 3];
  check("...and never overshoots it on any stamp", r <= Math.round(0.3 * 255) + 1, `R=${r}`);
  void g; void b; void a;
}

// ── Strength 1 with a target jumps straight to the target, not past it ──
{
  const sm = new SplatMap();
  stamp(sm, 1, 1, 0.3);
  check("a full-strength stamp lands exactly on the target", Math.abs(w1(sm) - 0.3) <= 1 / 255 + 1e-6, w1(sm).toFixed(3));
}

// ── A low target never lowers stronger paint ──
{
  const sm = new SplatMap();
  stamp(sm, 1, 1);                 // layer 1 at 100%
  const before = sm.data0.slice();
  for (let i = 0; i < 20; i++) stamp(sm, 1, 1, 0.3);
  check("painting the SAME layer with a lower target leaves it at 100%", w1(sm) > 0.99, w1(sm).toFixed(3));
  let same = true;
  for (let i = 0; i < before.length; i++) if (before[i] !== sm.data0[i]) { same = false; break; }
  check("...and changes no texel at all", same);
}

// ── Other layers make room exactly as before, just less of it ──
{
  const sm = new SplatMap();
  stamp(sm, 2, 1);                 // layer 2 at 100%
  for (let i = 0; i < 200; i++) stamp(sm, 1, 0.5, 0.3);
  const sum = w1(sm) + w2(sm);
  check("layer 1 capped at 30% over layer 2", Math.abs(w1(sm) - 0.3) <= 2 / 255, w1(sm).toFixed(3));
  check("layer 2 keeps the other 70%", Math.abs(w2(sm) - 0.7) <= 2 / 255, w2(sm).toFixed(3));
  check("weights still sum to 1", Math.abs(sum - 1) <= 2 / 255, sum.toFixed(3));
}

// ── Out-of-range targets are clamped, not trusted ──
{
  const sm = new SplatMap();
  for (let i = 0; i < 60; i++) stamp(sm, 1, 0.5, 5);
  check("a target above 1 behaves as 1", w1(sm) > 0.98, w1(sm).toFixed(3));
  const sm2 = new SplatMap();
  const rect = stamp(sm2, 1, 1, -1);
  check("a target below 0 paints nothing", w1(sm2) === 0 && rect === null, `w=${w1(sm2)} rect=${JSON.stringify(rect)}`);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
