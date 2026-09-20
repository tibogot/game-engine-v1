/**
 * The SIM half of the smoke: what blocks a sight line and what does not.
 *
 * Worth a test on its own because it is the half a player can LOSE A MATCH to.
 * The visual half is judged by looking; this half has to be judged by numbers,
 * and the numbers that matter are the boring ones — a cloud beside the line
 * blocks nothing, a fresh grenade does not blind instantly, a dead one stops
 * blocking, and the answer never depends on frame rate.
 *
 *   node tools/smokeLosTest.mjs
 */
import { SMOKE_KINDS, occlusionAlong, stepSources } from "../games/nam-rts/smokeField.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const src = (o = {}) => ({
  alive: true, x: 0, y: 0, z: 0, kind: "screen", age: 99, life: SMOKE_KINDS.screen.life,
  strength: 1, ...o,
});
/** A column well past its bloom and well before its fade: full strength. */
const mature = (o = {}) => src({ age: SMOKE_KINDS.screen.life * 0.4, ...o });

console.log("geometry");
{
  const s = [mature({ x: 0, z: 0 })];
  // The line runs along +X at z=0, straight through the centre.
  const through = occlusionAlong(s, -50, 0, 50, 0);
  // Same length, offset far enough sideways to miss entirely.
  const beside = occlusionAlong(s, -50, 60, 50, 60);
  // Clipping the rim.
  const grazing = occlusionAlong(s, -50, 11.5, 50, 11.5);
  ok("through the centre blocks", through > 0, `= ${through.toFixed(3)}`);
  ok("well to the side blocks nothing", beside === 0, `= ${beside}`);
  ok("grazing blocks less than through", grazing < through, `${grazing.toFixed(3)} < ${through.toFixed(3)}`);
  ok("grazing still blocks something", grazing > 0);

  // THE FLICKER TEST — the reason this is a Gaussian column and not a hard
  // cylinder. A cylinder's chord has INFINITE slope at the rim, so a unit
  // sidestepping one metre near the edge would jump from seen to hidden.
  // What has to be true is that flipping a DECISION takes real movement, so
  // measure it in the units the decision is made in: metres walked.
  const at = (off) => occlusionAlong(s, -50, off, 50, off);
  let maxSlope = 0;
  for (let off = 0; off <= 30; off += 0.25) maxSlope = Math.max(maxSlope, Math.abs(at(off + 0.25) - at(off)) * 4);
  ok("occlusion is Lipschitz across the rim", maxSlope < 0.15, `max ${maxSlope.toFixed(3)} per metre`);

  // How far sideways from 0.6 to 0.4, i.e. across a 0.5 threshold.
  const firstBelow = (lvl) => { for (let o = 0; o <= 40; o += 0.05) if (at(o) < lvl) return o; return 40; };
  const band = firstBelow(0.4) - firstBelow(0.6);
  ok("crossing the block threshold takes metres, not centimetres", band > 1.5,
    `${band.toFixed(2)} m from 0.6 to 0.4`);
}

console.log("the segment is a segment, not a line");
{
  const s = [mature({ x: 0, z: 0 })];
  // A cloud at the origin, and a sight line entirely to its east. The
  // INFINITE line through those two points passes through the cloud; the
  // segment does not, and must not block.
  const past = occlusionAlong(s, 40, 0, 90, 0);
  ok("a cloud behind the shooter blocks nothing", past === 0, `= ${past}`);
  const zeroLen = occlusionAlong(s, 0, 0, 0, 0);
  ok("a zero-length line is never blocked", zeroLen === 0);
}

console.log("time");
{
  const fresh = [src({ age: 0.0 })];
  const young = [src({ age: 1.0 })];
  const grown = [mature()];
  const dying = [src({ age: SMOKE_KINDS.screen.life * 0.95 })];
  const A = (s) => occlusionAlong(s, -50, 0, 50, 0);
  ok("a grenade does not blind on the instant", A(fresh) === 0, `= ${A(fresh)}`);
  ok("it blooms", A(young) > 0 && A(young) < A(grown),
    `${A(young).toFixed(3)} < ${A(grown).toFixed(3)}`);
  ok("and thins as it dies", A(dying) < A(grown), `${A(dying).toFixed(3)} < ${A(grown).toFixed(3)}`);

  // A DEAD column must not block. stepSources is what kills it.
  const s = [src({ age: SMOKE_KINDS.screen.life - 0.1 })];
  stepSources(s, 0.5);
  ok("a column past its life is dead", s[0].alive === false);
  ok("and a dead column blocks nothing", occlusionAlong(s, -50, 0, 50, 0) === 0);
}

console.log("presets");
{
  const A = (kind) => occlusionAlong(
    [src({ kind, age: (SMOKE_KINDS[kind].life) * 0.4, life: SMOKE_KINDS[kind].life })],
    -50, 0, 50, 0,
  );
  // The capture marker must NEVER blind — a signal that blinds is a trap.
  ok("violet marker blocks nothing, at any age", [0, 1, 5, 10, 13].every(
    (age) => occlusionAlong([src({ kind: "violet", age, life: SMOKE_KINDS.violet.life })], -50, 0, 50, 0) === 0));
  ok("screen blocks more than wreck smoke", A("screen") > A("wreck"),
    `${A("screen").toFixed(3)} > ${A("wreck").toFixed(3)}`);
  ok("napalm pall blocks", A("napalm") > 0, `= ${A("napalm").toFixed(3)}`);
}

console.log("accumulation");
{
  const one = occlusionAlong([mature({ x: 0, z: 0 })], -60, 0, 60, 0);
  const three = occlusionAlong(
    [mature({ x: -20 }), mature({ x: 0 }), mature({ x: 20 })], -60, 0, 60, 0);
  ok("more clouds block more", three > one, `${three.toFixed(3)} > ${one.toFixed(3)}`);
  // Many clouds must saturate at 1 rather than running away — callers compare
  // against a 0..1 threshold and a value of 4 would break any blend built on it.
  const many = occlusionAlong(Array.from({ length: 24 }, (_, i) => mature({ x: i * 4 - 46 })), -60, 0, 60, 0);
  ok("never exceeds 1", many <= 1 && many >= 0.99, `= ${many}`);
}

console.log("determinism");
{
  // THE POINT OF THE WHOLE SPLIT: the answer depends only on the fixed-step
  // age, so a 30 Hz machine and a 144 Hz machine must agree exactly. Drive one
  // column to the same sim time in three different step sizes.
  const run = (hz) => {
    const s = [src({ age: 0, life: SMOKE_KINDS.screen.life })];
    const dt = 1 / hz;
    for (let i = 0; i < hz * 6; i++) stepSources(s, dt);
    return { age: s[0].age, occ: occlusionAlong(s, -50, 0, 50, 0) };
  };
  const a = run(60), b = run(30), c = run(120);
  ok("6 s of sim is 6 s at any step size", near(a.age, 6, 1e-9) && near(b.age, 6, 1e-9) && near(c.age, 6, 1e-9),
    `${a.age} / ${b.age} / ${c.age}`);
  ok("and the occlusion agrees", near(a.occ, b.occ, 1e-9) && near(a.occ, c.occ, 1e-9),
    `${a.occ.toFixed(9)}`);
}

console.log("cost");
{
  // 24 columns is the cap, and a unit asks once per target per sim step.
  const s = Array.from({ length: 24 }, (_, i) => mature({ x: (i % 6) * 30 - 75, z: Math.floor(i / 6) * 30 - 45 }));
  const N = 200000;
  const t0 = performance.now();
  let sink = 0;
  for (let i = 0; i < N; i++) sink += occlusionAlong(s, (i % 200) - 100, -100, 100, (i % 200) - 100);
  const ms = performance.now() - t0;
  ok("200k full-cap queries stay cheap", ms < 400,
    `${ms.toFixed(0)} ms for ${N} = ${(ms * 1000 / N).toFixed(2)} us each (sink ${sink.toFixed(0)})`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
