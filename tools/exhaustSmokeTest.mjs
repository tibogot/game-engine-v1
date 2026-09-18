// ENGINE SMOKE — the second source, and the rules that keep it a second source.
//
// The car had exactly one smoke emitter: the rear tyres. Everything the plume
// did was gated on SLIP, so an idling car, a car pulling away and a car at full
// throttle in a straight line all produced nothing at all, and the only way to
// make the car look alive was to make the tyre plume denser — which is most of
// why it read as permanently on fire.
//
// The exhaust is driven by the DRIVE TRAIN instead: a rate that follows the
// throttle and the revs, plus BURSTS on a throttle stab and on a gear change.
// The burst is the part that cannot be faked with a rate, and it is what makes
// the plume read as a series of explosions rather than a fog machine.
//
// What this pins down:
//   - the rate responds to throttle and revs, and idles at a trickle;
//   - a stab and an upshift each release their handful in ONE frame;
//   - a shift pulse survives the frame gap between the HUD and the emitter;
//   - the pipes ride the car's FULL frame, so a rolled car does not exhaust
//     through its own floor;
//   - the gas leaves with the car and is then left behind, rather than being
//     born stationary in the world;
//   - a direct `update()` caller (the lab) still gets no exhaust at all;
//   - the pool cannot overflow and the whole thing stays finite.
import { register } from "node:module";
register("./threeWebgpuHook.mjs", import.meta.url);

const THREE = await import("three");
const {
  ModularRoadDriftSmoke, DEFAULT_DRIFT_SMOKE_SETTINGS, PREV_LOOK_SMOKE,
} = await import("../games/modular-road-v3/modularRoadDriftSmoke.js");

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

const DT = 1 / 60;

/** A smoke system plus a fake chassis, with emissions counted. */
function rig(tweak = {}) {
  const scene = new THREE.Scene();
  const settings = structuredClone(DEFAULT_DRIFT_SMOKE_SETTINGS);
  Object.assign(settings.exhaust, tweak);
  const smoke = new ModularRoadDriftSmoke(scene, settings);
  const body = {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    vel: new THREE.Vector3(),
  };
  let emitted = 0;
  const born = [];
  const real = smoke.emitExhaustAt.bind(smoke);
  smoke.emitExhaustAt = (...a) => {
    emitted++;
    real(...a);
    const p = smoke.exhaustParticles[(smoke.exhaustEmitter.index + smoke.exhaustEmitter.size - 1) % smoke.exhaustEmitter.size];
    born.push({ pos: p.position.clone(), vel: p.velocity.clone() });
    return undefined;
  };
  return {
    smoke, body, settings,
    count: () => emitted,
    reset: () => { emitted = 0; born.length = 0; },
    born,
    /** One frame: push engine state, then emit. */
    frame(throttle, rpm, shifted = false, dt = DT) {
      smoke.setEngine(throttle, rpm, shifted);
      smoke._emitExhaust(body, dt);
    },
    alive: () => smoke.exhaustParticles.reduce((n, p) => n + (p.life > 0 ? 1 : 0), 0),
  };
}

console.log("=== THE RATE FOLLOWS THE ENGINE, NOT THE TYRES ===");
{
  const r = rig();
  const X = r.settings.exhaust;
  // Idle: one second of a closed throttle at idle revs.
  for (let i = 0; i < 60; i++) r.frame(0, 0.15);
  const idle = r.count();
  const wantIdle = X.idleRate * X.pipes;
  check("an idling car makes a trickle", Math.abs(idle - wantIdle) <= 2,
    `${idle} in 1 s, expected ~${wantIdle}`);
  check("...and the trickle is small", idle < 20, `${idle}/s`);

  // Full throttle, held (so no stab fires after the first frame).
  const r2 = rig();
  r2.frame(1, 0.5);           // the stab frame — counted separately below
  r2.reset();
  for (let i = 0; i < 60; i++) r2.frame(1, 0.5);
  const wide = r2.count();
  const wantWide = (X.idleRate + X.loadRate * (0.35 + 0.65 * 0.5)) * X.pipes;
  check("full throttle multiplies it", Math.abs(wide - wantWide) <= 3,
    `${wide} in 1 s, expected ~${Math.round(wantWide)}`);
  check("throttle matters more than idle", wide > idle * 3, `${wide} vs ${idle}`);

  // Revs on their own do nothing with the throttle shut — that is over-run.
  const r3 = rig();
  for (let i = 0; i < 60; i++) r3.frame(0, 1.0);
  check("a closed throttle at redline is still a trickle (the over-run)",
    Math.abs(r3.count() - wantIdle) <= 2, `${r3.count()}/s`);

  // ...but at the limiter WITH throttle it gets the extra.
  const r4 = rig();
  r4.frame(1, 1.0); r4.reset();
  for (let i = 0; i < 60; i++) r4.frame(1, 1.0);
  check("the limiter adds its own", r4.count() > wide, `${r4.count()} vs ${wide}`);
}

console.log("\n=== A BURST IS ONE FRAME, NOT A FASTER RATE ===");
{
  const r = rig();
  const X = r.settings.exhaust;
  // Settle at a closed throttle so the stab is a genuine step.
  for (let i = 0; i < 10; i++) r.frame(0, 0.15);
  r.reset();
  r.frame(1, 0.5);                       // 0 -> 1 in one 16 ms frame
  const stabFrame = r.count();
  check("a throttle stab releases its handful in ONE frame",
    stabFrame >= X.stabBurst * X.pipes, `${stabFrame} in the stab frame`);
  r.reset();
  r.frame(1, 0.5);                       // held open: no second bark
  check("holding it open does not keep barking",
    r.count() < X.stabBurst * X.pipes, `${r.count()} on the next frame`);

  // An upshift, throttle unchanged.
  r.reset();
  r.frame(1, 0.5, true);
  check("an upshift pops", r.count() >= X.shiftBurst * X.pipes,
    `${r.count()} on the shift frame`);

  // THE LATCH. The game pushes `shifted` from the HUD and emits later in the
  // frame, so a second setEngine with shifted=false must not eat the pulse.
  const r2 = rig();
  for (let i = 0; i < 10; i++) r2.frame(0.5, 0.5);
  r2.reset();
  r2.smoke.setEngine(0.5, 0.5, true);    // the HUD says "shifted"
  r2.smoke.setEngine(0.5, 0.5, false);   // updateFromVehicle re-reads the throttle
  r2.smoke._emitExhaust(r2.body, DT);
  check("a shift pulse survives a later setEngine",
    r2.count() >= r2.settings.exhaust.shiftBurst * r2.settings.exhaust.pipes,
    `${r2.count()}`);
  r2.reset();
  r2.smoke._emitExhaust(r2.body, DT);
  check("...and is consumed, not sticky",
    r2.count() < r2.settings.exhaust.shiftBurst, `${r2.count()}`);

  // A burst is FASTER, which is what makes it a bark rather than more smoke.
  const r3 = rig();
  for (let i = 0; i < 10; i++) r3.frame(0, 0.15);
  r3.reset();
  r3.frame(0.2, 0.3);                    // gentle, no stab
  const slow = r3.born.length ? Math.max(...r3.born.map((b) => b.vel.length())) : 0;
  const r4 = rig();
  for (let i = 0; i < 10; i++) r4.frame(0, 0.15);
  r4.reset();
  r4.frame(1, 0.5);                      // stab
  const fast = Math.max(...r4.born.map((b) => b.vel.length()));
  check("burst particles leave faster than the trickle", fast > slow * 1.5,
    `${fast.toFixed(1)} m/s vs ${slow.toFixed(1)} m/s`);
}

console.log("\n=== THE PIPES RIDE THE CAR, INCLUDING ITS ROLL ===");
{
  const X = structuredClone(DEFAULT_DRIFT_SMOKE_SETTINGS).exhaust;
  // Level: the tips sit behind and below the origin, split either side.
  const r = rig();
  r.frame(1, 0.5);
  const xs = r.born.map((b) => b.pos.x);
  check("twin pipes straddle the centreline",
    Math.min(...xs) < -X.pipeSide * 0.5 && Math.max(...xs) > X.pipeSide * 0.5,
    `x from ${Math.min(...xs).toFixed(2)} to ${Math.max(...xs).toFixed(2)}`);
  check("they sit behind the car", r.born.every((b) => b.pos.z < -X.pipeBack * 0.8),
    `z ~${r.born[0].pos.z.toFixed(2)}`);
  check("and below the body origin", r.born.every((b) => b.pos.y < 0));

  // Rolled onto its side (wall-ride, loop): the offsets must rotate with it, so
  // what was "down" is now sideways. A ground-plane frame gets this wrong.
  const r2 = rig();
  r2.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  r2.frame(1, 0.5);
  const spanX = Math.max(...r2.born.map((b) => b.pos.x)) - Math.min(...r2.born.map((b) => b.pos.x));
  const spanY = Math.max(...r2.born.map((b) => b.pos.y)) - Math.min(...r2.born.map((b) => b.pos.y));
  check("rolled 90°, the twin split is now VERTICAL", spanY > spanX,
    `spanY ${spanY.toFixed(2)} vs spanX ${spanX.toFixed(2)}`);
  check("...and the 'down' offset has gone sideways",
    Math.abs(r2.born[0].pos.x) > X.pipeUp * 0.5);

  // Upside down: the jet must still point out of the back of the car.
  const r3 = rig();
  r3.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  r3.frame(1, 0.5);
  check("turned around, the pipes point the other way",
    r3.born.every((b) => b.pos.z > 0), `z ~${r3.born[0].pos.z.toFixed(2)}`);
}

console.log("\n=== THE GAS LEAVES WITH THE CAR ===");
{
  // At 30 m/s the exhaust still travels FORWARDS in world space — just slower
  // than the car, which is what leaves it behind instead of the car driving out
  // of a stationary wall of smoke.
  const r = rig();
  r.body.vel.set(0, 0, 30);
  for (let i = 0; i < 10; i++) r.frame(0.3, 0.4);
  r.reset();
  for (let i = 0; i < 20; i++) r.frame(0.3, 0.4);
  const vz = r.born.map((b) => b.vel.z);
  check("a part-throttle cruise still emits", vz.length > 0, `${vz.length} in 20 frames`);
  check("it goes forwards in world space", vz.every((v) => v > 0),
    `vz ~${vz[0].toFixed(1)}`);
  check("...but slower than the car, so the car pulls away",
    vz.every((v) => v < 30), `vz ~${vz[0].toFixed(1)} vs 30`);

  // Parked, the jet is the only thing moving it, and it goes BACKWARDS.
  const r2 = rig();
  for (let i = 0; i < 10; i++) r2.frame(0.5, 0.3);
  r2.reset();
  for (let i = 0; i < 20; i++) r2.frame(0.5, 0.3);
  check("parked, the jet points out of the back",
    r2.born.every((b) => b.vel.z < 0), `vz ~${r2.born[0].vel.z.toFixed(1)}`);

  // `follow` is the dial that says so.
  const r3 = rig({ follow: 0 });
  r3.body.vel.set(0, 0, 30);
  for (let i = 0; i < 10; i++) r3.frame(0.3, 0.4);
  r3.reset();
  for (let i = 0; i < 20; i++) r3.frame(0.3, 0.4);
  check("follow 0 births it stationary in the world",
    r3.born.every((b) => b.vel.z < 0), `vz ~${r3.born[0].vel.z.toFixed(1)}`);
}

console.log("\n=== GATES ===");
{
  // Disabled: nothing, and no phantom bark when it comes back. The stab is a
  // RATE of opening, so the previous throttle has to keep being tracked while
  // the source is off or re-enabling fires off a stale value.
  const r = rig({ enabled: false });
  for (let i = 0; i < 30; i++) r.frame(1, 0.8);
  check("disabled emits nothing", r.count() === 0, `${r.count()}`);
  r.settings.exhaust.enabled = true;
  r.reset();
  r.frame(1, 0.8);
  check("re-enabling at a held throttle does not fire a phantom burst",
    r.count() < r.settings.exhaust.stabBurst * r.settings.exhaust.pipes,
    `${r.count()} on the first frame back`);

  // The lab calls update() directly and never touches setEngine — it must stay
  // exactly as it was before the exhaust existed.
  const scene = new THREE.Scene();
  const smoke = new ModularRoadDriftSmoke(scene, structuredClone(DEFAULT_DRIFT_SMOKE_SETTINGS));
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 2, 8);
  for (let i = 0; i < 30; i++) {
    smoke.update(DT, [new THREE.Vector3(0, 0, 0)], true, 1, 0, 0, cam);
  }
  check("a bare update() emits no exhaust",
    smoke.exhaustParticles.every((p) => p.life <= 0));
  check("...and never shows its mesh", smoke.exhaustMesh.visible === false);

  // Tyre smoke off must not take the engine's with it — same rule the wet
  // spray already had.
  const r2 = rig();
  r2.smoke.setSmokeEnabled(false);
  for (let i = 0; i < 30; i++) r2.frame(1, 0.8);
  check("switching drift smoke off leaves the engine running", r2.count() > 0,
    `${r2.count()}`);
  check("...and the system stays visible for it", r2.smoke._visible === true);

  // The engine's own switch.
  const r3 = rig();
  r3.smoke.setExhaustEnabled(false);
  for (let i = 0; i < 30; i++) r3.frame(1, 0.8);
  check("the engine's own switch stops it", r3.count() === 0, `${r3.count()}`);
}

console.log("\n=== THE POOL HOLDS, AND STAYS FINITE ===");
{
  const r = rig();
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 2, 8);
  let peak = 0;
  // Ten seconds of the worst case: full throttle at the limiter, stabbing the
  // throttle twice a second, shifting once a second.
  for (let i = 0; i < 600; i++) {
    const th = (i % 30) < 15 ? 1 : 0;
    r.frame(th, 1.0, i % 60 === 0);
    r.smoke.update(DT, [], false, 0, 0, 0, cam);
    peak = Math.max(peak, r.alive());
  }
  check("the pool is never exhausted", peak < r.smoke.exhaustParticles.length,
    `peak ${peak} of ${r.smoke.exhaustParticles.length}`);
  check("...with real headroom", peak < r.smoke.exhaustParticles.length * 0.85,
    `peak ${peak}`);
  const bad = r.smoke.exhaustParticles.find((p) =>
    !Number.isFinite(p.position.x + p.position.y + p.position.z
      + p.velocity.x + p.velocity.y + p.velocity.z + p.size + p.life));
  check("no NaN reaches a particle", !bad);
  check("the draw range never exceeds the pool",
    r.smoke.exhaustGeometry.drawRange.count <= r.smoke.exhaustParticles.length * 6);
}

console.log("\n=== ONE DRAW, NO SECOND PIPELINE IN THE PROCEDURAL LOOK ===");
{
  // The procedural look points the engine's mesh at the puffs' own material, so
  // the second source costs a draw call and nothing else. (The flipbook look
  // swaps in its own, because a different atlas is a different node graph.)
  const scene = new THREE.Scene();
  const smoke = new ModularRoadDriftSmoke(scene, structuredClone(DEFAULT_DRIFT_SMOKE_SETTINGS));
  check("the engine's mesh shares the puffs' material",
    smoke.exhaustMesh.material === smoke.material);
  check("it has its own pool, so it cannot starve the tyre plume",
    smoke.exhaustParticles !== smoke.particles);
  check("and its own buffers, so it cannot overwrite them",
    smoke.exhaustGeometry !== smoke.geometry);
}

console.log("\n=== THE A/B BACK TO THE OLD LOOK IS COMPLETE ===");
{
  // The previous-look preset exists so the change can be judged in the game
  // rather than argued about — which means it has to put back every part of it.
  check("it restores the old trigger", PREV_LOOK_SMOKE.trigger === 0.04);
  check("it restores the old bank life", PREV_LOOK_SMOKE.haze?.lifeMax === 9);
  check("it switches the engine off, because it did not exist",
    PREV_LOOK_SMOKE.exhaust?.enabled === false);
  const cur = DEFAULT_DRIFT_SMOKE_SETTINGS;
  check("the shipped trigger is well above a cornering slip angle",
    cur.trigger > 0.1, `trigger ${cur.trigger} ≈ ${(0.1 + cur.trigger * 0.5) * 57.3 | 0}°`);
  check("the shipped bank no longer outlives the drift by 9 s",
    cur.haze.lifeMax <= 7, `${cur.haze.lifeMax} s`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall green");
process.exit(fail ? 1 : 0);
