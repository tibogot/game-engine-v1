// v3/render/gpuAbHarness.js is the only sanctioned way to A/B GPU cost in this
// engine — see its header for the four ways a hand-rolled one lies. The GPU
// part cannot run in node, but the part that decides what the numbers MEAN can,
// and that is the part that was getting it wrong.
import { gpuAB } from "../v3/render/gpuAbHarness.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

/** A fake renderer: each case has a true cost, reported through a quantised,
 *  drifting timer — the two things that broke the ad-hoc measurements. */
function fakeSample(costOf, { quantum = 0.065536, driftPerCall = 0.05 } = {}) {
  let calls = 0;
  let current = null;
  const set = (name) => { current = name; };
  const sample = async (frames = 90) => {
    const drift = driftPerCall * calls++;          // the machine warming up
    const truth = costOf(current) + drift;
    const frameTotals = [];
    for (let i = 0; i < frames; i++) {
      // quantised, with a little jitter either side of the true value
      const jitter = (i % 3) - 1;
      frameTotals.push(Math.round((truth + jitter * quantum * 0.4) / quantum) * quantum);
    }
    return { frameTotals };
  };
  return { set, sample };
}

// ── The real difference survives the quantised timer and the drift ──────────
{
  const COST = { all: 10.0, noGrass: 8.6 };        // a true 1.4 ms difference
  const f = fakeSample((n) => COST[n]);
  const res = await gpuAB({
    sample: f.sample, rounds: 4, frames: 90, settleMs: 0,
    cases: { all: () => f.set("all"), noGrass: () => f.set("noGrass") },
  });
  // Drift is shared by both sides, so it cancels in the delta.
  const err = Math.abs(res.deltas.noGrass - (COST.noGrass - COST.all));
  check("a 1.4 ms difference is recovered through quantisation + drift", err < 0.2,
        `delta ${res.deltas.noGrass}, error ${err.toFixed(3)} ms`);
  check("the baseline is the first case", res.baseline === "all");
  check("rounds are reported so a reader can see the spread", res.all.rounds.length === 4);
}

// ── A change that is really free reads as free, not as drift ────────────────
{
  const f = fakeSample(() => 7.5);                 // identical true cost
  const res = await gpuAB({
    sample: f.sample, rounds: 4, frames: 60, settleMs: 0,
    cases: { a: () => f.set("a"), b: () => f.set("b") },
  });
  check("no real difference reads under the noise floor",
        Math.abs(res.deltas.b) <= res.noise + 0.06, `delta ${res.deltas.b}, noise ${res.noise}`);
}

// ── Cases are INTERLEAVED, not run one after the other ──────────────────────
{
  const order = [];
  const f = fakeSample(() => 5);
  await gpuAB({
    sample: f.sample, rounds: 3, frames: 10, settleMs: 0,
    cases: { a: () => order.push("a"), b: () => order.push("b"), c: () => order.push("c") },
  });
  check("every round walks every case", order.join("") === "abcabcabc", order.join(""));
}

// ── reset runs once, at the end ─────────────────────────────────────────────
{
  let resets = 0, lastCaseBeforeReset = null;
  const f = fakeSample(() => 5);
  await gpuAB({
    sample: f.sample, rounds: 2, frames: 10, settleMs: 0,
    cases: { a: () => { lastCaseBeforeReset = "a"; }, b: () => { lastCaseBeforeReset = "b"; } },
    reset: () => { resets++; check("reset runs after the last case", lastCaseBeforeReset === "b"); },
  });
  check("reset runs exactly once", resets === 1, String(resets));
}

// ── A dead tab is an error, not a NaN ───────────────────────────────────────
{
  let threw = "";
  try {
    await gpuAB({ sample: async () => ({ frameTotals: [] }), settleMs: 0, rounds: 1, cases: { a: () => {} } });
  } catch (e) { threw = String(e.message); }
  check("an empty timing window throws instead of averaging to NaN", /foreground/i.test(threw), threw);
}

// ── It refuses to be used without a sampler ─────────────────────────────────
{
  let threw = "";
  try { await gpuAB({ cases: { a: () => {} } }); } catch (e) { threw = String(e.message); }
  check("a missing sampler is refused", /sample/i.test(threw), threw);
}

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
