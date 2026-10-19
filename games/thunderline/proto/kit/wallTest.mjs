// node games/thunderline/proto/kit/wallTest.mjs [--json]
// WHAT A RAIL HIT COSTS in Thunderline: the real car (carTune, carRules) on a straight of our road with
// its real guardrail, driven at the rail at an angle and a speed, throttle held. Until the hit it holds
// its heading; from the hit on it steers back to the road like a player (the autopilot's steering).
// Per hit: the speed kept 1 s after the touch, the lowest speed in that second, how far the heading
// turned, whether the crash state armed, the worst roll. Apex Rush's biggest complaint was "walls stop
// the car dead" (TODO.md); a glancing clip should keep most of its speed, only a head-on should not.
import * as THREE from "three";
import { pathToFileURL } from "node:url";
import { layout, Vehicle, FIXED_DT, SOLID, CRASH } from "./trackRun.mjs";
import { createAutopilot } from "./autopilot.js";
import { createCarRules } from "./carRules.js";

const STRAIGHT = Array(8).fill("straight_64");
let LAY = null;

export function hit({ angleDeg, speed, side = 1 }) {
  LAY ??= layout(STRAIGHT);
  const { ground, ride } = LAY;
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.SUBSTEPS = 3;
  car.setBvh(ground.ground, ground.solids);
  car.getFloorY = () => NaN;
  car.setSolidCapsules([]);
  const r0 = ride[2];
  const R = new THREE.Vector3().crossVectors(r0.T, r0.U).normalize(); // the road's right
  const a = (angleDeg * Math.PI) / 180;
  const dir = r0.T.clone().multiplyScalar(Math.cos(a)).addScaledVector(R, side * Math.sin(a)).normalize();
  car.setSpawn(r0.P.clone().addScaledVector(r0.U, 0.6), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dir.x, dir.z)));
  car.enabled = true;
  car.respawn();
  car.body.vel.copy(dir).multiplyScalar(speed);
  const pilot = createAutopilot(ride);
  const rules = createCarRules(car, {});
  let touchT = null, vTouch = 0, vMin = Infinity, v1 = null, crash = false, roll = 0, wallTime = 0;
  const up = new THREE.Vector3();
  const head0 = Math.atan2(r0.T.x, r0.T.z);
  let headOut = 0;
  for (let tick = 0; tick < 120 * 6; tick++) {
    const t = tick * FIXED_DT;
    const auto = pilot.input(car);
    // hands off the wheel until the hit and after it (the rail alone), or a player steering back (--steer)
    const inp = touchT == null || !globalThis.__WALL_STEER ? { ...auto, steerTarget: 0, throttle: 1 } : { ...auto, throttle: 1 };
    const vBefore = car.body.vel.length();
    rules.step(inp, FIXED_DT);
    if (car.scraping || car.hitSolid) {
      if (touchT == null) { touchT = t; vTouch = vBefore; }
      wallTime += FIXED_DT;
    }
    if (touchT != null) {
      const v = car.body.vel.length();
      if (globalThis.__WALL_TRACE && tick % 6 === 0) console.log(`  t+${(t - touchT).toFixed(2)} v ${(v * 3.6).toFixed(0)} g ${car.groundedCount} steer ${inp.steerTarget.toFixed(2)} wall ${car.scraping ? 1 : 0} slipAng ${((Math.atan2(car.body.vel.clone().applyQuaternion(car.body.quat.clone().invert()).x, car.body.vel.clone().applyQuaternion(car.body.quat.clone().invert()).z) * 180) / Math.PI).toFixed(0)}°`);
      vMin = Math.min(vMin, v);
      crash ||= car._crashYield > 0;
      up.set(0, 1, 0).applyQuaternion(car.body.quat);
      roll = Math.max(roll, (Math.acos(THREE.MathUtils.clamp(up.y, -1, 1)) * 180) / Math.PI);
      if (t - touchT >= 1 && v1 == null) {
        v1 = v;
        const h = Math.atan2(car.body.vel.x, car.body.vel.z) - head0;
        headOut = (Math.atan2(Math.sin(h), Math.cos(h)) * 180) / Math.PI;
        break;
      }
    }
  }
  if (touchT == null) return { angleDeg, speed, touched: false };
  return { angleDeg, speed, touched: true, vTouch, v1, keep: v1 / vTouch, low: vMin / vTouch, crash, roll, headOut, wallTime };
}

export const ANGLES = [5, 10, 20, 30, 45, 60, 90];
export const SPEEDS = [30, 45, 60]; // 108, 162, 216 km/h

export function matrix() {
  const rows = [];
  for (const speed of SPEEDS) for (const angleDeg of ANGLES) rows.push(hit({ angleDeg, speed }));
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // try values: --mu=<rail friction> --crash=<closing m/s that counts as a crash> --spin=<rotational share>
  for (const [flag, obj, key] of [["--mu=", SOLID, "mu"], ["--crash=", CRASH, "wallSpeed"], ["--spin=", SOLID, "spin"]]) {
    const a = process.argv.find((x) => x.startsWith(flag));
    if (a) obj[key] = Number(a.slice(flag.length));
  }
  globalThis.__WALL_STEER = process.argv.includes("--steer");
  console.log(`rail mu ${SOLID.mu} · crash at ${CRASH.wallSpeed} m/s · spin ${SOLID.spin} · after the hit: ${globalThis.__WALL_STEER ? "steering back" : "hands off"}`);
  const rows = matrix();
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 1));
  else {
    console.log(" km/h  angle |  touch → 1 s later  kept   lowest | heading out  roll  crash  on wall");
    for (const r of rows) {
      if (!r.touched) { console.log(` ${String(Math.round(r.speed * 3.6)).padStart(4)}  ${String(r.angleDeg).padStart(4)}° | no touch`); continue; }
      const k = (x) => String(Math.round(x * 3.6)).padStart(4);
      console.log(` ${k(r.speed)}  ${String(r.angleDeg).padStart(4)}° | ${k(r.vTouch)} → ${k(r.v1)} km/h  ${String(Math.round(r.keep * 100)).padStart(3)}%   ${String(Math.round(r.low * 100)).padStart(3)}%  | ${r.headOut.toFixed(0).padStart(5)}°   ${r.roll.toFixed(0).padStart(4)}°  ${r.crash ? "CRASH" : "  -  "}  ${r.wallTime.toFixed(2)} s`);
    }
  }
}
