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
};

/** Watches one car; call tick() after every physics tick. Returns a landing event or null. */
export function createLandingJudge(car) {
  let air = 0;
  const n = { x: 0, y: 0, z: 0 };
  return {
    get air() { return air; },
    reset() { air = 0; },
    tick(dt) {
      if (car.groundedCount === 0) { air += dt; return null; }
      const flew = air;
      air = 0;
      if (flew < LANDING.minAir) return null;
      // the surface the first tyres found (raw contact normal) vs the car's up
      n.x = n.y = n.z = 0;
      for (const t of car.tires) if (t.grounded) { n.x += t._rawNormal.x; n.y += t._rawNormal.y; n.z += t._rawNormal.z; }
      const q = car.body.quat; // car up = (0,1,0) rotated by q
      const ux = 2 * (q.x * q.y - q.w * q.z), uy = 1 - 2 * (q.x * q.x + q.z * q.z), uz = 2 * (q.y * q.z + q.w * q.x);
      const len = Math.hypot(n.x, n.y, n.z) || 1;
      const err = (Math.acos(Math.max(-1, Math.min(1, (ux * n.x + uy * n.y + uz * n.z) / len))) * 180) / Math.PI;
      const grade = err <= LANDING.perfect ? "perfect" : err > LANDING.rough ? "rough" : "ok";
      if (grade === "rough") car.body.vel.multiplyScalar(LANDING.roughKeep);
      return { grade, err, air: flew, boost: grade === "perfect" ? LANDING.boostTime : 0 };
    },
  };
}
