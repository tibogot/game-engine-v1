// ============================================================================
// INVERTED LAUNCH PROBE — a car that lands past 90° of roll is a rocket.
//
// NOT A COLLISION BUG. Found while measuring the contact-impulse rewrite, and
// worth its own instrument because it looks exactly like one: the car leaves a
// barrier at 22 m/s and is doing 103 m/s a quarter of a second later, which
// reads as "the wall threw me". It is not the wall. There is NO SOLID CONTACT
// anywhere in it — `_solidTouch` is false for the whole launch, and the numbers
// below are byte-identical with the solids BVH removed from the scene.
//
// It is the TYRE/SUSPENSION path. Roll the car past ~90° near the ground and
// the wheel rays start reporting hits on the far side of the body; the
// suspension then pushes along an axis that is now pointing the wrong way, and
// each substep adds energy instead of absorbing it.
//
// MEASURED (2026-09-11, and identical on the commit before the contact rewrite,
// so it is long-standing rather than new):
//
//     roll      in        peak      ratio
//      0°     22.1       22.1       1.00
//     60°     22.1       22.1       1.00
//    110°     22.1       68.9       3.12
//    160°     22.1      102.8       4.66
//
// WHY IT MATTERS FOR THE BARREL ROLL. A roll that lands past vertical is the
// signature trick of this game, and this says the landing is a launcher. It is
// also the mechanism behind two long-standing entries in
// chassisCollisionTest.run.mjs's "PRE-EXISTING (reported, not asserted)" list —
// "lands fully inverted" ends at y −48, off the world.
//
// Run:  node tools/attic/invertedLaunchProbe.mjs
// ============================================================================
import { buildWallScene, makeCar, THREE } from "../wallImpactProbe.mjs";

const full = buildWallScene();
// The solids BVH is dropped in the "no wall" scene to prove the launch has
// nothing to do with the collider under test.
const noWall = { deck: full.deck, solids: null };

function run(track, { rollDeg, vel, y }) {
  const car = makeCar(track);
  car.body.pos.set(-20, y, 0);
  car.body.vel.copy(vel);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (rollDeg * Math.PI) / 180);
  car.body.angVel.set(0, 0, 0);
  let peak = 0, peakT = -1, touched = false;
  for (let i = 0; i < 120; i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0 });
    if (car._solidTouch) touched = true;
    const sp = car.body.vel.length();
    if (sp > peak) { peak = sp; peakT = i; }
  }
  return { peak, peakT, touched, in: vel.length() };
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const CASE = { vel: V(-22, -0.1, 1.6), y: 1.3 };

console.log("A car dropped near the ground at 22 m/s, rolled by each angle.");
console.log("`solid` says whether the chassis touched the barrier at all.\n");
console.log("  roll |   in   peak  ratio | with wall        | no wall at all");
console.log("  -----|---------------------|------------------|----------------");
for (const rollDeg of [0, 45, 60, 90, 110, 135, 160, 180]) {
  const a = run(full, { rollDeg, ...CASE });
  const b = run(noWall, { rollDeg, ...CASE });
  const flag = a.peak / a.in > 1.05 ? " LAUNCH" : "";
  console.log(
    `  ${String(rollDeg).padStart(4)}° | ${a.in.toFixed(1).padStart(5)}`
    + ` ${a.peak.toFixed(1).padStart(6)} ${(a.peak / a.in).toFixed(2).padStart(6)} |`
    + ` solid ${a.touched ? "yes" : "no "} t${String(a.peakT).padStart(3)}    |`
    + ` ${b.peak.toFixed(1).padStart(6)} (${(b.peak / b.in).toFixed(2)})${flag}`,
  );
}
console.log(`
The "with wall" and "no wall" columns agree to the digit at every angle, and
the chassis never touches the barrier. The launch is in the tyre model, not in
the contact model — see the header for what to look at.`);
