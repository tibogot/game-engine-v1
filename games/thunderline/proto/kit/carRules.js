// THE RULES ON TOP OF THE OLD CAR, per car, in one place: no engine up a wall, the clean-landing
// judge and its boost, boost pads. One physics tick = step(input). The player, the GHOST (it must
// replay bit for bit, so it runs exactly this), the builder's prediction and the Node tests all step
// through here.
import * as THREE from "three";
import { wallCut } from "./autopilot.js";
import { createLandingJudge } from "./landing.js";

/** Boost pads (user: "boosts make it even faster"): a push along the nose on top of the engine. */
export const BOOST = { accel: 14, time: 2.0 };

/**
 * @param car  the old Vehicle
 * @param boostPads  inverse world matrices of the boost pieces (piece frame: x right, y up, −z along)
 */
export function createCarRules(car, { boostPads = [] } = {}) {
  const judge = createLandingJudge(car);
  const lp = new THREE.Vector3(), fwd = new THREE.Vector3();
  let boostLeft = 0;
  return {
    judge,
    get boostLeft() { return boostLeft; },
    set boostLeft(v) { boostLeft = v; },
    reset() { judge.reset(); boostLeft = 0; },
    /** One fixed tick. Returns the landing event of this tick, or null. */
    step(input, dt) {
      car.tick(wallCut(car, input));
      const landed = judge.tick(dt);
      if (landed) boostLeft = Math.max(boostLeft, landed.boost);
      for (const inv of boostPads) {
        lp.copy(car.body.pos).applyMatrix4(inv);
        if (Math.abs(lp.x) < 8 && lp.y > -1 && lp.y < 3 && lp.z < -4 && lp.z > -28) boostLeft = BOOST.time;
      }
      if (boostLeft > 0 && car.groundedCount > 0) {
        fwd.set(0, 0, 1).applyQuaternion(car.body.quat); // the car's nose is +Z
        car.body.vel.addScaledVector(fwd, BOOST.accel * dt);
      }
      boostLeft = Math.max(0, boostLeft - dt);
      return landed;
    },
  };
}
