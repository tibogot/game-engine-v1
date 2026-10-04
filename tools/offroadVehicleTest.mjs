// The off-road vehicle (games/offroad/offroadVehicle.js) on analytic grounds:
// does it settle at the ride height the model is drawn at, drive, steer the
// right way, hold on a hill, climb in LOW range, stop, and do the locked
// differentials beat open ones with two wheels hanging (cross-axle)?
//
// Pass/fail: exits 1 on any failure. ~2 s.
import * as THREE from "three";
import { OffroadVehicle, FIXED_DT } from "../games/offroad/offroadVehicle.js";
import { createVehicleGround } from "../v3/play/modularRoadGround.js";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
};

function makeTruck(height, config = {}) {
  const { ground } = createVehicleGround({ getTerrainHeight: height });
  const v = new OffroadVehicle({ ground, getFloorY: height, config });
  return v;
}
const run = (v, seconds, controls = {}) => {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) v.tick(controls);
};
const heading = (v) => { const f = new THREE.Vector3(0, 0, 1).applyQuaternion(v.body.quat); return Math.atan2(f.x, f.z); };
const finite = (v) => [v.body.pos.x, v.body.pos.y, v.body.pos.z, v.body.vel.x, v.body.vel.y, v.body.vel.z].every(Number.isFinite);

// 1. Settle on flat ground: still, all four down, at the drawn ride height.
{
  const v = makeTruck(() => 0);
  v.spawn(0, 0, 0);
  run(v, 4);
  const rideErr = v.body.pos.y - v.cfg.comHeight;
  check("settles", finite(v) && v.body.vel.length() < 0.02 && v.groundedCount === 4 && Math.abs(rideErr) < 0.06,
    `|v| ${v.body.vel.length().toFixed(3)} m/s, ${v.groundedCount} wheels down, ride ${(rideErr * 100).toFixed(1)} cm off the model`);
}

// 2. Drive straight, HIGH range.
{
  const v = makeTruck(() => 0);
  v.spawn(0, 0, 0);
  run(v, 1);
  run(v, 6, { throttle: 1 });
  check("drives", finite(v) && v.speed > 12 && Math.abs(v.body.pos.x) < 0.5,
    `${v.speed.toFixed(1)} m/s after 6 s, drift ${v.body.pos.x.toFixed(2)} m, ${v.body.pos.z.toFixed(1)} m covered`);
}

// 3. Steer LEFT (+steer) turns toward +X (the truck's left).
{
  const v = makeTruck(() => 0);
  v.spawn(0, 0, 0);
  run(v, 1);
  run(v, 3, { throttle: 0.5, steer: 1 });
  const h = heading(v);
  check("steers left", finite(v) && h > 0.4 && v.body.pos.x > 0, `heading ${(h * 57.3).toFixed(0)}°, x ${v.body.pos.x.toFixed(1)} m`);
}

// 4. Hill hold on a 30 % slope, no input.
{
  const v = makeTruck((x, z) => 0.3 * z);
  v.spawn(0, 0, 0);
  run(v, 2);
  const p0 = v.body.pos.clone();
  run(v, 5);
  const moved = v.body.pos.distanceTo(p0);
  check("holds on 30 %", finite(v) && moved < 0.15, `moved ${(moved * 100).toFixed(1)} cm in 5 s`);
}

// 5. Climb 45 % (24°): LOW range must; HIGH range is reported.
for (const low of [true, false]) {
  const v = makeTruck((x, z) => 0.45 * Math.max(0, z - 4), { drivetrain: { lowRange: low } });
  v.spawn(0, 0, 0);
  run(v, 1);
  run(v, 8, { throttle: 1 });
  const climbed = v.body.pos.y - v.cfg.comHeight;
  if (low) check("climbs 45 % in LOW", finite(v) && climbed > 4, `${climbed.toFixed(1)} m up, ${v.speed.toFixed(1)} m/s`);
  else console.log(`info  HIGH range on 45 %: ${climbed.toFixed(1)} m up, ${v.speed.toFixed(1)} m/s`);
}

// 6. Brake from speed.
{
  const v = makeTruck(() => 0);
  v.spawn(0, 0, 0);
  run(v, 1);
  let n = 0;
  while (v.speed < 15 && n++ < 2400) v.tick({ throttle: 1 });
  const z0 = v.body.pos.z, s0 = v.speed;
  run(v, 4, { throttle: 0, brake: 1 });
  const dist = v.body.pos.z - z0;
  check("brakes", finite(v) && Math.abs(v.speed) < 0.3 && dist < 25, `from ${s0.toFixed(1)} m/s: stopped in ${dist.toFixed(1)} m`);
}

// 7. Cross-axle: pits under the front-left and rear-right wheels, so two
//    diagonal wheels hang. Open diffs lose the drive to the hanging wheels;
//    locked ones keep pushing.
{
  const pits = [[0.81, 1.4], [-0.81, -1.4]];
  const h = (x, z) => (pits.some(([px, pz]) => Math.hypot(x - px, z - pz) < 0.7) ? -1.2 : 0);
  const res = {};
  for (const lock of [false, true]) {
    const v = makeTruck(h, { drivetrain: { diffLock: lock, lowRange: true } });
    v.spawn(0, 0, 0);
    run(v, 2);
    const z0 = v.body.pos.z;
    run(v, 3, { throttle: 0.6 });
    res[lock ? "locked" : "open"] = { d: v.body.pos.z - z0, ok: finite(v), hanging: 4 - v.groundedCount };
  }
  check("locked beats open, cross-axle", res.open.ok && res.locked.ok && res.locked.d > res.open.d + 0.5,
    `open ${res.open.d.toFixed(2)} m, locked ${res.locked.d.toFixed(2)} m`);
}

// 7b. No rollover from full lock at speed on flat ground (the lab rolled it
//     at 28 km/h before the CoM, anti-roll bars and speed-scaled lock).
{
  const v = makeTruck(() => 0);
  v.spawn(0, 0, 0);
  run(v, 1);
  let n = 0;
  while (v.speed < 10 && n++ < 3000) v.tick({ throttle: 1 });
  let minUp = 1;
  const up = new THREE.Vector3();
  for (let i = 0; i < 360; i++) {
    v.tick({ throttle: 1, steer: 1 });
    minUp = Math.min(minUp, up.set(0, 1, 0).applyQuaternion(v.body.quat).y);
  }
  check("no rollover at full lock, 36 km/h", finite(v) && minUp > 0.85, `worst tilt ${(Math.acos(Math.min(1, minUp)) * 57.3).toFixed(0)}°`);
}

// 8. Rocks: a house-sized crag across the path. The truck must be STOPPED by
//    it (bodywork + wheels against the rock BVH), not pass through, and stay sane.
{
  const { RoadBvh } = await import("../v3/play/modularRoadBvh.js");
  const { getRockGeometry, rockKitParams } = await import("../v3/props/proceduralRock.js");
  const { simplifierReady } = await import("../v3/render/instancing/autoLod.js");
  await simplifierReady;
  const geo = getRockGeometry(rockKitParams("Rock: Crag A"));
  const crag = new THREE.Mesh(geo);
  crag.position.set(0, -0.5, 14);
  crag.scale.setScalar(1.2);
  crag.updateMatrixWorld(true);
  const rocks = new RoadBvh();
  rocks.bakeFromMeshes([crag]);
  const h = () => 0;
  const { ground } = createVehicleGround({ getTerrainHeight: h, roadBvh: rocks, roadSolidsBvh: rocks });
  const v = new OffroadVehicle({ ground, solids: rocks, getFloorY: h });
  v.spawn(0, 0, 0);
  run(v, 1);
  run(v, 6, { throttle: 1 });
  const box = new THREE.Box3().setFromObject(crag);
  const front = box.min.z;
  check("stopped by a crag", finite(v) && v.body.pos.z < front && Math.abs(v.speed) < 2,
    `nose at ${(v.body.pos.z + v.cfg.chassis.zFront).toFixed(1)} m, crag face at ${front.toFixed(1)} m, ${v.speed.toFixed(1)} m/s, y ${v.body.pos.y.toFixed(2)}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
