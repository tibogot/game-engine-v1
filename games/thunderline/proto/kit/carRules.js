// THE RULES ON TOP OF THE OLD CAR, per car, in one place: no engine up a wall, the clean-landing
// judge and its boost, boost pads. One physics tick = step(input). The player, the GHOST (it must
// replay bit for bit, so it runs exactly this), the builder's prediction and the Node tests all step
// through here.
import * as THREE from "three";
import { wallCut } from "./autopilot.js";
import { createLandingJudge } from "./landing.js";

/** Boost pads (user: "boosts make it even faster"): a push along the nose on top of the engine. */
export const BOOST = { accel: 14, time: 2.0 };
/** The twist pieces' magnet (m/s² into the road surface): one g, so the car holds at any roll. */
export const MAGNET = 9.81;
const GRAVITY_ACC = 9.81; // the old car's world gravity (modularRoadVehicle GRAVITY)
/** Magnet zones for a list of placements ({id, M}) — the pieces whose tile carries `magnet`. */
export function magnetZones(placements, TILES, integrate) {
  return placements.filter((p) => TILES[p.id]?.magnet).map((p) => ({ inv: p.M.clone().invert(), L: integrate(TILES[p.id]).L }));
}

/**
 * @param car  the old Vehicle
 * @param boostPads  inverse world matrices of the boost pieces (piece frame: x right, y up, −z along)
 */
export function createCarRules(car, { boostPads = [], magnets = [] } = {}) {
  const judge = createLandingJudge(car);
  const lp = new THREE.Vector3(), fwd = new THREE.Vector3(), nrm = new THREE.Vector3();
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
      // MAGNET (twist pieces): with the wheels on the road inside a magnet zone, a pull of 1 g into the
      // surface, so the car holds sideways and upside down. Measured (trackRun, 2026-10-19): with no
      // magnet the car slid 9 m across the rolled deck and off the open edge (at 90° only downforce
      // presses the tyres); replacing gravity by the pull made it hop (0.6 s of air) — pull only.
      if (magnets.length && car.groundedCount > 0) {
        let inZone = false;
        for (const m of magnets) {
          lp.copy(car.body.pos).applyMatrix4(m.inv); // piece frame: −z along the road
          if (lp.z < 0 && lp.z > -m.L && Math.hypot(lp.x, lp.y - 0.9) < 12) { inZone = true; break; }
        }
        if (inZone) {
          nrm.set(0, 0, 0);
          for (const t of car.tires) if (t.grounded) nrm.add(t._rawNormal);
          if (nrm.lengthSq() > 1e-6) {
            if (globalThis.__MAG_MODE === "replace") car.body.vel.y += GRAVITY_ACC * dt; // (tried: cancel world gravity — it hopped)
            car.body.vel.addScaledVector(nrm.normalize(), -MAGNET * dt); // pull into the surface
          }
        }
      }
      boostLeft = Math.max(0, boostLeft - dt);
      return landed;
    },
  };
}
