// Drift scoring state machine: chains build, bank on straighten, fail on spin
// or wall, and survive a jump mid-drift.
import { createDriftScore, DRIFT_SCORE } from "../games/modular-road-v3/driftScore.js";

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };
const D2R = (d) => d * Math.PI / 180;
const DT = 1 / 60;
/** Hold a state for `secs`. */
const hold = (s, secs, o) => { for (let i = 0; i < secs / DT; i++) s.update(DT, o); };
const sliding = (deg, speed = 30) => ({ slip: D2R(deg), speed, grounded: true, hitSolid: false });
const straight = { slip: 0, speed: 30, grounded: true, hitSolid: false };

{
  const s = createDriftScore();
  hold(s, 2, sliding(35));
  check("a slide accumulates pending points", s.pending > 0, `${s.pending} pts`);
  check("nothing is banked mid-chain", s.total === 0);
  check("it reports as drifting", s.drifting);
}
{
  const s = createDriftScore();
  hold(s, 2, sliding(35));
  const p = s.pending;
  hold(s, DRIFT_SCORE.graceTime + 0.2, straight);
  check("straightening banks the chain", s.total > 0 && s.pending === 0, `banked ${s.total} from ${p}`);
  check("the bank is reported once for a HUD flash", s.consumeBanked() > 0 && s.consumeBanked() === 0);
}
{
  // A brief straighten between corners must NOT break the chain.
  const s = createDriftScore();
  hold(s, 2, sliding(35));
  hold(s, DRIFT_SCORE.graceTime * 0.5, straight);
  hold(s, 2, sliding(35));
  check("a short straighten inside grace keeps the chain alive", s.total === 0 && s.pending > 0,
    `pending ${s.pending}, banked ${s.total}`);
}
{
  // Multiplier grows with held duration.
  const s = createDriftScore();
  hold(s, 1, sliding(35));
  const m1 = s.multiplier;
  hold(s, DRIFT_SCORE.comboStep * 3, sliding(35));
  check("multiplier grows the longer you hold", s.multiplier > m1, `x${m1} -> x${s.multiplier}`);
  check("multiplier is capped", s.multiplier <= DRIFT_SCORE.maxMultiplier);
}
{
  // Spinning out loses the chain.
  const s = createDriftScore();
  hold(s, 3, sliding(35));
  check("has pending before the spin", s.pending > 0);
  s.update(DT, sliding(130)); // past spinAngle
  check("spinning out loses the pending points", s.pending === 0 && s.total === 0);
  check("the failure is reported once", s.consumeFailed() && !s.consumeFailed());
}
{
  // Hitting a wall loses the chain.
  const s = createDriftScore();
  hold(s, 3, sliding(35));
  s.update(DT, { ...sliding(35), hitSolid: true });
  check("hitting a solid loses the chain", s.pending === 0 && s.total === 0);
}
{
  // A jump mid-drift should not break the chain (airborne is held in grace).
  const s = createDriftScore();
  hold(s, 2, sliding(35));
  hold(s, DRIFT_SCORE.graceTime * 0.6, { slip: D2R(35), speed: 30, grounded: false, hitSolid: false });
  hold(s, 1, sliding(35));
  check("a jump mid-chain does not break it", s.total === 0 && s.pending > 0, `pending ${s.pending}`);
}
{
  // Ordinary cornering must not score.
  const s = createDriftScore();
  hold(s, 4, sliding(5));
  check("ordinary cornering slip does not score", s.pending === 0 && s.total === 0);
  const slow = createDriftScore();
  hold(slow, 4, sliding(35, 4));
  check("a slow-speed wiggle does not score", slow.pending === 0 && slow.total === 0);
}
{
  // Faster + wider (to a point) scores more.
  const a = createDriftScore(); hold(a, 2, sliding(35, 20));
  const b = createDriftScore(); hold(b, 2, sliding(35, 45));
  check("faster drifts score more", b.pending > a.pending, `${a.pending} vs ${b.pending}`);
  const c = createDriftScore(); hold(c, 2, sliding(12, 30));
  const d = createDriftScore(); hold(d, 2, sliding(50, 30));
  check("wider angle scores more (up to the sweet spot)", d.pending > c.pending, `${c.pending} vs ${d.pending}`);
  const e = createDriftScore(); hold(e, 2, sliding(100, 30));
  check("past the sweet spot it tapers, not grows", e.pending < d.pending, `50deg ${d.pending} vs 100deg ${e.pending}`);
}
{
  const s = createDriftScore();
  hold(s, 2, sliding(35));
  hold(s, 1, straight);
  s.reset();
  check("reset clears everything", s.total === 0 && s.pending === 0 && !s.drifting);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
