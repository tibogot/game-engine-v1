// THE RULES ON TOP OF THE OLD CAR, per car, in one place: no engine up a wall, the clean-landing
// judge and its boost, boost pads. One physics tick = step(input). The player, the GHOST (it must
// replay bit for bit, so it runs exactly this), the builder's prediction and the Node tests all step
// through here.
import * as THREE from "three";
import { wallCut } from "./autopilot.js";
import { createLandingJudge } from "./landing.js";

/** Boost pads (user: "boosts make it even faster"): a push along the nose on top of the engine. */
export const BOOST = { accel: 14, time: 2.0 };
/** Jump pads: the car's speed along the pad's up is raised to this (m/s) — 8: ~3.3 m up, ~1.6 s of air. */
export const JUMP = { v: 8 };
/** The twist pieces' magnet (m/s² into the road surface): one g, so the car holds at any roll. */
export const MAGNET = 9.81;
const GRAVITY_ACC = 9.81; // the old car's world gravity (modularRoadVehicle GRAVITY)
/**
 * WALL-CUT ZONES: the pieces the "no engine up a wall" rule is FOR — bowls and quarter pipes, where full
 * throttle drove the car up the wall and launched it 50-100 m higher than its arrival speed (bowlTest).
 * (Applied everywhere, it cut the engine for about a third of every LOOP and up flip ramps — the physics
 * review, 2026-10-23.) A box round each such piece's own rings, 12 m of margin.
 */
export const WALLCUT_TILE = /^(bowl_|quarter_pipe)/;
export function wallCutZones(placements, built) {
  return placements.filter((p) => WALLCUT_TILE.test(p.id) && built[p.id]?.b).map((p) => {
    const box = new THREE.Box3();
    for (const r of built[p.id].b.rings) box.expandByPoint(r.p);
    return { inv: p.M.clone().invert(), box: box.expandByScalar(12) };
  });
}
/** Magnet zones for a list of placements ({id, M}) — the pieces whose tile carries `magnet`. */
export function magnetZones(placements, TILES, integrate) {
  return placements.filter((p) => TILES[p.id]?.magnet).map((p) => ({ inv: p.M.clone().invert(), L: integrate(TILES[p.id]).L }));
}

/**
 * @param car  the old Vehicle
 * @param boostPads  inverse world matrices of the boost pieces (piece frame: x right, y up, −z along), or
 *   BOOST PADS (obstacles.js boostZones): { inv, hx, hz } — a box round the pad's own frame
 */
export function createCarRules(car, { boostPads = [], magnets = [], cutZones = null } = {}) {
  const judge = createLandingJudge(car);
  const lp = new THREE.Vector3(), fwd = new THREE.Vector3(), nrm = new THREE.Vector3();
  let boostLeft = 0;
  return {
    judge,
    get boostLeft() { return boostLeft; },
    set boostLeft(v) { boostLeft = v; },
    reset() { judge.reset(); boostLeft = 0; },
    /** (the builder's incremental test lap: simState.js) */
    getState() { return { judge: judge.getState(), boostLeft }; },
    setState(s) { judge.setState(s.judge); boostLeft = s.boostLeft; },
    /** One fixed tick. Returns the landing event of this tick, or null. */
    step(input, dt) {
      // the wall cut only inside a bowl / quarter pipe (cutZones; null = everywhere, the old rule — wallTest)
      let cut = cutZones === null;
      if (!cut && cutZones.length && input.throttle > 0 && car.groundedCount > 0) {
        for (const z of cutZones) { lp.copy(car.body.pos).applyMatrix4(z.inv); if (z.box.containsPoint(lp)) { cut = true; break; } }
      }
      car.tick(cut ? wallCut(car, input) : input);
      const landed = judge.tick(dt);
      if (landed) boostLeft = Math.max(boostLeft, landed.boost);
      for (const pad of boostPads) {
        if (pad.isMatrix4) {
          lp.copy(car.body.pos).applyMatrix4(pad);
          if (Math.abs(lp.x) < 8 && lp.y > -1 && lp.y < 3 && lp.z < -4 && lp.z > -28) boostLeft = BOOST.time;
        } else {
          lp.copy(car.body.pos).applyMatrix4(pad.inv);
          if (!(Math.abs(lp.x) < pad.hx && Math.abs(lp.z) < pad.hz && lp.y > -1 && lp.y < 3)) continue;
          if (!pad.jump) { boostLeft = BOOST.time; continue; }
          // a JUMP PAD: wheels on it, up to JUMP.v along its up (raised, not added: no stacking)
          const vu = car.body.vel.dot(pad.up);
          if (car.groundedCount > 0 && vu < JUMP.v) car.body.vel.addScaledVector(pad.up, JUMP.v - vu);
        }
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
