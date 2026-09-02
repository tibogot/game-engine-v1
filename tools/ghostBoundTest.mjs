/**
 * A ghost recording must be BOUNDED.
 *
 *   node tools/ghostBoundTest.mjs
 *
 * `record()` runs while the run clock runs, and that clock only stops on a
 * finish or a respawn. Cross START, then just drive around, and the old code
 * recorded for as long as you kept driving: plain JS arrays growing ~3.8 KB/s
 * with no ceiling. This pins the cap AND the rule that an overflowed take is
 * discarded rather than committed half-length (a truncated ghost replays a car
 * that stops dead mid-track, which is worse than no ghost).
 */
import { GhostTrack } from "../games/modular-road-v3/modularRoadGhost.js";

let fail = 0;
const check = (ok, name, detail = "") => {
  if (ok) console.log("ok   " + name);
  else { fail++; console.log("FAIL " + name + (detail ? "  — " + detail : "")); }
};

const P = { x: 1, y: 2, z: 3 };
const Q = { x: 0, y: 0, z: 0, w: 1 };

// Drive "for ever" at 60 Hz: 20 minutes against a 5 minute cap.
{
  const g = new GhostTrack({ sampleHz: 60, maxSeconds: 300 });
  g.beginLap();
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 60 * 20; i++) g.record(i * dt, P, Q);

  check(g._recT.length <= g.maxSamples, "recording stops at the cap",
    `${g._recT.length} samples vs cap ${g.maxSamples}`);
  check(g._recT.length === g.maxSamples, "…and it fills the cap exactly",
    String(g._recT.length));
  check(g._recP.length === g._recT.length * 3, "position array stays in step");
  check(g._recQ.length === g._recT.length * 4, "quaternion array stays in step");
  check(g.commit() === false, "an overflowed take is refused, not truncated");
  check(g.hasGhost === false, "…and no ghost is left behind");
}

// A normal lap is unaffected.
{
  const g = new GhostTrack({ sampleHz: 60, maxSeconds: 300 });
  g.beginLap();
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 90; i++) g.record(i * dt, P, Q);   // a 90 s lap
  const n = g._recT.length;
  // NOT asserted as ~5400. Feeding exact 1/60 steps, `lapT - last >= dtSample`
  // fails on alternate frames because the float difference lands a hair under
  // dtSample, so the effective rate is about half the nominal one. That is
  // pre-existing and harmless — playback interpolates between samples — but it
  // is why this checks a sane band rather than a rate.
  check(n > 100 && n < g.maxSamples, `a 90 s lap records well under the cap (${n})`);
  check(g.commit() === true, "a normal lap still commits");
  check(g.hasGhost, "…and produces a ghost");
  check(Math.abs(g.duration - 90) < 0.5, "duration is the lap length",
    String(g.duration?.toFixed?.(2)));
}

// The overflow flag must not leak into the next lap.
{
  const g = new GhostTrack({ sampleHz: 60, maxSeconds: 1 });   // 60 samples
  g.beginLap();
  for (let i = 0; i < 500; i++) g.record(i / 60, P, Q);
  check(g.commit() === false, "short cap: overflow refused");
  g.beginLap();
  for (let i = 0; i < 30; i++) g.record(i / 60, P, Q);
  check(g.commit() === true, "a fresh lap after an overflow records normally");
}

console.log(fail ? `\n${fail} check(s) failed` : "\nghost recording is bounded");
process.exit(fail ? 1 : 0);
