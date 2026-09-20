// games/nam-rts/simClock.js decides how many fixed sim steps a frame buys.
// The interesting cases are all about a frame that runs LONG, because that is
// where a naive accumulator walks the game into a freeze it cannot leave.
import { createSimClock } from "../games/nam-rts/simClock.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

const run = (clock, dts) => {
  let steps = 0;
  for (const dt of dts) steps += clock.advance(dt, () => {});
  return steps;
};

// ── The ordinary case: 60 Hz display, 60 Hz sim, one step per frame ─────────
{
  const c = createSimClock();
  const steps = run(c, Array(600).fill(1 / 60));
  check("600 frames at 1/60 run 600 steps", steps === 600, String(steps));
  check("simTime tracks wall time", Math.abs(c.simTime - 10) < 1e-6, c.simTime.toFixed(4));
  check("nothing was dropped", c.droppedFrames === 0);
}

// ── A faster display does NOT run the sim faster ────────────────────────────
{
  const c = createSimClock();
  // 144 Hz for one second.
  const steps = run(c, Array(144).fill(1 / 144));
  check("144 frames of 1/144 run ~60 steps, not 144", steps >= 59 && steps <= 60, String(steps));
}

// ── A slower display does not run it slower either ──────────────────────────
{
  const c = createSimClock();
  const steps = run(c, Array(30).fill(1 / 30));   // 30 Hz for one second
  check("30 frames of 1/30 run ~60 steps", steps >= 59 && steps <= 60, String(steps));
}

// ── The spiral: a long frame must not be able to owe unbounded work ─────────
{
  const c = createSimClock({ maxSteps: 5 });
  const steps = c.advance(10, () => {});   // a 10-second hitch
  check("a 10 s hitch runs at most maxSteps", steps === 5, String(steps));
  check("the hitch is counted", c.droppedFrames === 1, String(c.droppedFrames));
  // And the very next ordinary frame is ordinary again — the debt was dropped,
  // not carried. Carrying it is the spiral.
  const next = c.advance(1 / 60, () => {});
  check("the frame after a hitch owes nothing extra", next === 1, String(next));
}

// ── maxFrame clamps before the accumulator, so debt cannot build up ─────────
{
  const c = createSimClock({ maxSteps: 100, maxFrame: 0.25 });
  const steps = c.advance(5, () => {});   // five seconds handed over at once
  check("maxFrame caps a huge dt at 0.25 s of sim", steps === 15, String(steps));
}

// ── Junk dt is ignored rather than poisoning the accumulator ────────────────
{
  const c = createSimClock();
  for (const bad of [NaN, -1, undefined, Infinity]) c.advance(bad, () => {});
  check("NaN / negative / undefined dt run no steps", c.simTime === 0, String(c.simTime));
  // Infinity is finite-checked, so it must not have become the accumulator.
  check("a bad dt leaves the clock usable", c.advance(1 / 60, () => {}) === 1);
}

// ── The step callback always receives the FIXED dt, never the frame's ───────
{
  const c = createSimClock({ hz: 60 });
  const seen = new Set();
  c.advance(0.05, (d) => seen.add(d));   // 3 steps out of one 50 ms frame
  check("every step gets exactly 1/60", seen.size === 1 && Math.abs([...seen][0] - 1 / 60) < 1e-12,
        [...seen].join(","));
}

// ── reset() drops buffered time, for a load or a mode switch ────────────────
{
  const c = createSimClock();
  c.advance(0.016, () => {});
  c.reset();
  check("reset clears the accumulator", c.advance(1 / 120, () => {}) === 0);
}

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
