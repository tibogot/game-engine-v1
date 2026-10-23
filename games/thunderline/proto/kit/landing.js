// CLEAN-LANDING BOOST — the one rule for air control (DESIGN.md §6): "land with your wheels flat on
// the road and you get a boost". Measured (landingTest.mjs): the old car's landing assist forgives
// almost everything — hands-off landed 7–13° off and kept the same speed as a lined-up car, and an
// 89° crooked landing kept 99% at 0.25 s. So physics alone never made air control matter; this does.
// Shared by the drive page, the builder's prediction and the Node tests.
export const LANDING = {
  minAir: 0.8, // s of air before a touchdown counts as a landing
  perfect: 6, // ° between the car's up and the surface it lands on: ≤ this = PERFECT
  rough: 30, // ° above this = ROUGH
  boostTime: 1.0, // s of the boost-pad push for a PERFECT landing
  roughKeep: 0.85, // a ROUGH landing keeps this much of its speed
  // ALL FOUR WHEELS (user, 2026-10-21: "only two wheels front touch the road, you almost fell and it
  // still said perfect"): after the first touch the other wheels have this long to come down; if they
  // don't (the rear hanging off a landing's start edge, a bounce back into the air) it is not PERFECT
  settle: 0.25, // s
};

/** Watches one car; call tick() after every physics tick. Returns a landing event or null — the
 * event comes when all the wheels are down, or LANDING.settle s after the first touch (`partial`). */
export function createLandingJudge(car) {
  let air = 0;
  let pending = null; // { err, air, t }: touched down, waiting for the other wheels
  const n = { x: 0, y: 0, z: 0 };
  const wheels = () => Math.min(4, car.tires.length);
  // A WHEEL IS DOWN when it carries load (its spring compressed), not when its probe first sees the road:
  // the probe reaches ~1.6 m and turns true 58-92 ms before the tyre touches, so the angle was graded
  // in the air and the rough-landing cut applied there (the physics review, 2026-10-23). Same test as
  // the car's own landing assist (Vehicle._isSupported).
  const loaded = () => { let n = 0; for (const t of car.tires) if (t.grounded && t.compression > 0) n++; return n; };
  function finish(p, partial) {
    pending = null;
    let grade = p.err <= LANDING.perfect ? "perfect" : p.err > LANDING.rough ? "rough" : "ok";
    if (partial && grade === "perfect") grade = "ok";
    if (grade === "rough") car.body.vel.multiplyScalar(LANDING.roughKeep);
    return { grade, err: p.err, air: p.air, partial, boost: grade === "perfect" ? LANDING.boostTime : 0 };
  }
  return {
    get air() { return air; },
    reset() { air = 0; pending = null; },
    /** (the builder's incremental test lap: simState.js) */
    getState() { return { air, pending: pending && { ...pending } }; },
    setState(s) { air = s.air; pending = s.pending && { ...s.pending }; },
    tick(dt) {
      const down = loaded();
      if (pending) {
        if (down === 0) { const ev = finish(pending, true); air = dt; return ev; } // bounced off
        pending.t += dt;
        if (down >= wheels()) return finish(pending, false);
        return pending.t >= LANDING.settle ? finish(pending, true) : null;
      }
      if (down === 0) { air += dt; return null; }
      const flew = air;
      air = 0;
      if (flew < LANDING.minAir) return null;
      // the surface the first tyres found (raw contact normal) vs the car's up
      n.x = n.y = n.z = 0;
      for (const t of car.tires) if (t.grounded && t.compression > 0) { n.x += t._rawNormal.x; n.y += t._rawNormal.y; n.z += t._rawNormal.z; }
      const q = car.body.quat; // car up = (0,1,0) rotated by q
      const ux = 2 * (q.x * q.y - q.w * q.z), uy = 1 - 2 * (q.x * q.x + q.z * q.z), uz = 2 * (q.y * q.z + q.w * q.x);
      const len = Math.hypot(n.x, n.y, n.z) || 1;
      const err = (Math.acos(Math.max(-1, Math.min(1, (ux * n.x + uy * n.y + uz * n.z) / len))) * 180) / Math.PI;
      pending = { err, air: flew, t: 0 };
      return down >= wheels() ? finish(pending, false) : null;
    },
  };
}
